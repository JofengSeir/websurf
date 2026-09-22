/**
 * `apps/game` 主线程渲染器：物理、相机、场景与光照都在本线程，Worker 只跑权威物理。
 *
 * 职责（按调用顺序）：
 * - `init`：建 `THREE.WebGLRenderer` / `THREE.Scene` / `THREE.PerspectiveCamera`，并把光照参数
 *   初值写进 `apps/game/src/renderer/lightmap-shader.ts` 的共享 uniform；
 * - `loadScene`：GLB → 场景（摘除 punctual 光源 → 施加 lightmap atlas → 空间分块合并 →
 *   受光材质终扫 → 预编译 program）→ 相机 near/far → PVS/LOD 注册 → 画质 manifest；
 * - `buildPredictionWorld`：用 `apps/game/pkg/websurf_wasm.js` 的 `PhysWorld` 建主线程物理世界；
 * - `tick`：每 rAF 一次 —— 输入写共享槽 → 消费权威帧 → 推进主线程物理 → 写渲染采样 →
 *   相机取物理状态 → LOD/PVS 剔除 → `renderer.render()`。
 *
 * 关键不变量：
 * - 场景根（`userData.isBspModel`）由 `loadScene` 挂载、`disposeScene` 摘除；相机位姿只由 `tick`
 *   从 `PhysWorld.state()` 写入（y = `posY + eyeHeight`）；
 * - punctual 光源必须在挂进 `this.scene` **之前**摘除；施加 lightmap 必须早于空间分块合并
 *   （lightmap 按原 mesh 的材质与 UV 通道施加，合并会重建几何与材质数组）；
 * - 渲染采样与渲染状态读取同拍同源；采样流的失效世代由
 *   `src/ts-shared/auth/shared-state.ts` 的 `resetRenderSample` 独占维护，调用方不传世代。
 *
 * 消息与数据流：
 * - 上游：`apps/game/src/app.ts` 调 `init` / `loadScene` / `buildPredictionWorld` / `feedInput` /
 *   `start` 等，并注册 `onSceneLoaded` 与 `onSyncRenderState` 两个回调；
 * - 下行：`tick` 经 `shared.addInput` 把输入交给 Worker 权威帧；`onSyncRenderState` 由
 *   `apps/game/src/app.ts` 转成 `sync-render-state` 消息；权威碰撞事件 `phys-event` 由该文件转成
 *   `applyCollisionCorrection`；
 * - 与共享层的边界：本文件只按同签名调用 `ShmState` / `MsgState` 的 `addInput` /
 *   `readAuthoritative` / `writeRenderSample` / `resetRenderSample`（两者由
 *   `src/ts-shared/auth/shared-state.ts` 的 `createMainSharedState` 选择）；写出的渲染采样又被
 *   `apps/game/src/worker/main.ts` 读走，用于在渲染时钟上取点后发布权威位置。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PhysWorld, mosaic_decode, initSync } from '../../pkg/websurf_wasm.js';
import type { RuntimeConfig } from '../config.js';
import type { SceneDataMessage } from '../worker/worker-types.js';
import type { ShmState, MsgState } from '../../../../src/ts-shared/auth/shared-state.js';
import { AuthorityCalibrator } from '../../../../src/ts-shared/phys/authority-calibrator.js';
import { PvsManager } from '../../../../src/ts-shared/world/pvs-manager.js';
import { base64ToBytes } from '../../../../src/ts-shared/wasm/loader.js';
import { EYE_STAND } from '../../../../src/ts-shared/phys/constants.js';
import { loadLightmapAtlas, applyLightmapToMeshes, fullbrightUnlitLitMaterials, setExposure, setLightGamma, setAmbientScale, setPropVertexRelax, getVertexLightingRelaxStats, getPropVertexRelax, setPropVertexFlatten, getPropVertexFlatten, VERTEX_LIGHTING_ATTR, setLightingMode as setLightingModeInShader, getLightingMode, type LightingMode } from './lightmap-shader.js';

/** 透视相机 FOV 初值（度）：`init` 优先取 `config.hud.fov`，缺省用它；面板滑块量程 60..110。 */
const FOV_DEFAULT = 73.6;
const DEG2RAD = Math.PI / 180;

/**
 * 渲染采样传输契约（两个实现见 `src/ts-shared/auth/shared-state.ts` 的 `ShmState` 与 `MsgState`，
 * 签名一致；本文件只按契约调用，由 typecheck 保证）：
 * ```ts
 * writeRenderSample(tMs, x, y, z, i0): void; // 本帧渲染时刻 + 渲染位置 + 采样序号
 * resetRenderSample(): void;                 // 失效世代 +1 并清样本槽（Worker 丢弃缓存）
 * ```
 * 载荷 = 4 个 f64（`tMs` / x / y / z）+ 采样序号与失效世代两个 i64 槽；写侧不加锁、不等对端，
 * 用 seqlock 序号把一个写入周期包成「偶数 → 奇数 → 偶数」。
 * 世代槽**不由本文件传入**：`resetRenderSample` 自增它、`writeRenderSample` 就地读它。
 */

// ── 空间分块合并参数（GLB 挂载后一次性执行；见 optimizeScene）──────────
// GLTFLoader 按 GLB 的 primitive 逐个建 THREE.Mesh，图元多的地图因此会产生数万个 Mesh 对象：
// 每帧都要遍历它们做剔除，可见的还要逐个 draw call。分块合并把这批 Mesh 收敛成数百个空间块
// （块内先按材质实例分组，再合并成「每块一个 Mesh + 一份材质数组」），几何与材质实例不变；
// 合并失败的分支逐块回退为保留独立几何。
/** cell 大小自适应的目标块数：初值 = 世界包围盒对角线 / cbrt(本值)，随后按非空 cell 数微调。 */
const OPT_TARGET_CELLS = 512;
/** 自适应接受的「非空 cell 数」区间；落进区间即停止调整（最多 6 轮）。 */
const OPT_MIN_CELLS = 300;
const OPT_MAX_CELLS = 800;
/** cell 边长钳制区间（世界单位）：初值与每轮微调都被夹在区间内。 */
const OPT_CELL_MIN = 128;
const OPT_CELL_MAX = 4096;
/**
 * 视锥外保留圈的半径膨胀系数（分块结束时乘到每块的包围球半径上）。
 * three 的视锥剔除按 geometry.boundingSphere 判定，膨胀后视锥外一圈的块仍参与渲染 ⇒
 * 快速转动时新进入视野的块上一帧已在画，边缘不闪空。只影响剔除判定，不改几何与材质。
 */
const FRUSTUM_PAD = 1.6;

/** 分块收集项：mesh + 它的世界包围盒中心（分桶键用）。 */
interface OptMeshInfo {
  mesh: THREE.Mesh;
  cx: number;
  cy: number;
  cz: number;
}

/** cell 键：世界坐标三分量各除以 cellSize 后向下取整，拼成字符串（一次性分桶）。 */
function optCellKey(x: number, y: number, z: number, cellSize: number): string {
  return Math.floor(x / cellSize) + '|' + Math.floor(y / cellSize) + '|' + Math.floor(z / cellSize);
}

/** 统计给定 cellSize 下的非空 cell 数（cell 大小自适应循环用）。 */
function optCountCells(infos: OptMeshInfo[], cellSize: number): number {
  const keys = new Set<string>();
  for (const it of infos) keys.add(optCellKey(it.cx, it.cy, it.cz, cellSize));
  return keys.size;
}

/** LOD 档位（写进 mesh.userData.lodLevel）：近距可见 / 超出剔除距离 / PVS 判定不可见。 */
const LOD_NEAR = 0;
const LOD_FAR = 2;
const LOD_PVS_HIDDEN = -1;
/**
 * PVS 剔除总开关：false 时 `tick` 既不调 `PvsManager.update`，也不按 cluster 隐藏块，块可见性
 * 只由距离档（`cullDistance`）决定；`loadScene` 仍会建 `pvsManager` 并给每块分配 `clusterIds`。
 * 置 true 后启用：`update` 每帧刷新当前 cluster，`isVisible` 判定块的 cluster 是否可见；相机不在
 * 任何 cluster（`currentClusterId < 0`）时 `tick` 跳过 PVS 只按距离判定，防可见集为空导致误剔。
 */
const ENABLE_PVS = false;

/** 主线程渲染器（职责与数据流见文件头）；实例由 `apps/game/src/app.ts` 创建并驱动。 */
export class RendererMain {
  /** three 渲染器（`init` 建）：`resize` 与每帧绘制用它。 */
  private renderer: THREE.WebGLRenderer | null = null;
  /** 场景（`init` 建）：BSP 根由 `loadScene` 挂上、`disposeScene` 摘掉。 */
  private scene: THREE.Scene | null = null;
  /** 透视相机（`init` 建）：位姿由 `tick` 写、FOV 由 `setFov` 写。 */
  private camera: THREE.PerspectiveCamera | null = null;
  /** PVS 查询器（`loadScene` 用 `data.pvsJson` 建；`ENABLE_PVS` 为真时 `tick` 用它剔除）。 */
  private pvsManager: PvsManager | null = null;
  /** 运行时配置（`init` 注入）：光照初值、纹理画质、FOV、剔除距离都从它取。 */
  private config!: RuntimeConfig;

  /** rAF 句柄（`start` 写入、`stop` 取消）；0 = 当前没有在途回调。 */
  private rafId = 0;
  /** rAF 循环开关（`tick` 用它判断是否续帧）。 */
  private running = false;

  // ── 主线程唯一物理线 ───────────────────────────────────────
  /** 主线程物理实例（`buildPredictionWorld` 建、`disposeScene` 置空）：世界、碰撞、传送、
   *  死亡判定都在它内部，`tick` 每帧推进一次。 */
  private predPhys: PhysWorld | null = null;
  /** 主线程物理是否就绪（`tick` 的物理分支由它把关）。 */
  private predReady = false;
  /** 按住 C 读点时的冻结目标（非空即冻结中：`tick` 每帧把物理写回该位姿并把速度清零）。 */
  private holdPoint: {
    x: number; y: number; z: number;
    yaw: number; pitch: number;
    onGround: boolean;
  } | null = null;
  /** 待喂输入（`feedInput` 累加、`tick` 消费后把 dx/dy 清零）：dx/dy 为鼠标等效角度增量。 */
  private pendingDx = 0;
  private pendingDy = 0;
  /** 键位掩码（覆盖写：每次 `feedInput` 都替换，`tick` 消费后**不清**——按住状态要延续）。 */
  private pendingKeys = 0;
  /** 权威帧校准器（`src/ts-shared/phys/authority-calibrator.ts` 的 `AuthorityCalibrator`）：
   *  本类只做转发，并把读权威帧、取/写主线程物理、清待喂输入、`onSyncRenderState` 注入给它。 */
  private readonly calibrator: AuthorityCalibrator;
  /** 上一物理帧的 rAF 时间戳（ms）；0 = 本帧是首个物理帧（dt 取 1/64）。 */
  private lastTickMs = 0;

  // ── 渲染采样传输（Worker 按渲染时钟 τ 在本折线上取点后发布权威位置）──────
  // 契约见文件头（writeRenderSample / resetRenderSample）。
  /** 渲染采样序号（每写一次 +1；Worker 用它标注样本身份）。
   *  仅在 resetSampleStream()（失效世代 +1，索引空间重启）时归零。 */
  private renderSampleIndex = 0;
  /**
   * 渲染器侧的失效世代计数器：只在 `bumpSampleEpoch` 内自增，**本文件没有其它读取点**
   * （真正生效的是 `src/ts-shared/auth/shared-state.ts` 的 `resetRenderSample`，它自增共享槽
   * 里的世代，`writeRenderSample` 也不接收世代参数）。
   */
  private sampleEpoch = 0;
  /** mesh → { 世界包围盒中心, 半径, clusterIds }（距离剔除与 PVS 判定用）。 */
  private lodItems: Array<{ mesh: THREE.Mesh; center: THREE.Vector3; radius: number; clusterIds: number[] }> = [];
  /** 当前剔除距离（世界单位）：`loadScene` 按 `config.hud.renderDistance` 或自动值设定，
   *  `setRenderDistance` 可实时改；`tick` 用它把更远的块置 `visible = false`。 */
  private cullDistance = 12800;
  /** 自动剔除距离 = 场景包围盒对角线 × 0.5（下限 1000）；`renderDistance <= 0` 时用它。 */
  private autoCullDistance = 12800;

  /**
   * 待跑一次的注入生效性统计（`applyLightmap` 施加成功时置位、`tick` 在首帧
   * `renderer.render()` 之后消费一次）。
   *
   * 延后的原因：材质上的注入标记由 `apps/game/src/renderer/lightmap-shader.ts` 的
   * `injectLightmapShader` 在 `onBeforeCompile` 里回填，而 `loadScene` 期间 three 还没编译材质，
   * 那时统计只会得到全 0。
   */
  private pendingInjectReport = false;
  /** 注入生效性统计是否已跑（幂等保护，跨地图由 `disposeScene` 复位）。 */
  private injectReported = false;

  // ── 纹理画质切换（mosaic）──────────────────────────────────
  /** 画质 manifest（纹理名小写 → mosaic 字节码）；为空时整条画质切换链路短路。 */
  private mosaicManifest: Record<string, string> | null = null;
  /** 换成 mosaic 之前的原始贴图图像（键 = 纹理对象）；切回 `original` 时用它还原。 */
  private readonly origTextureImages = new Map<THREE.Texture, unknown>();

  // ── 近平面贴墙自适应（防贴墙时 near 裁掉墙面、透视看到地图外）─────────
  /** 探测距离默认值（HU）：`updateNearPlane` 的射线长度上限与包围球粗筛半径都由它推出。 */
  private static readonly NEAR_PROBE_DIST_DEFAULT = 100;
  /** near 允许的最小值（收缩与默认值都不得低于它）。 */
  private static readonly CAMERA_NEAR_MIN = 0.05;
  /** near 收缩系数默认值：命中几何时 near = 命中距离 × 本值。 */
  private static readonly NEAR_RATIO_DEFAULT = 0.3;
  /** 探测距离（HU，`setNearParams` 可改；面板「近平面探测距离」量程 16..128）。 */
  private nearProbeDist = RendererMain.NEAR_PROBE_DIST_DEFAULT;
  /** near 收缩系数（`setNearParams` 可改，只接受 (0, 1]；面板量程 0.1..1）。 */
  private nearRatio = RendererMain.NEAR_RATIO_DEFAULT;
  /** 场景默认 near（`loadScene` 取 maxDim/1000，下限 CAMERA_NEAR_MIN）；探测无命中时恢复它。 */
  private defaultNear = 0.1;
  /** 每 2 帧探测一次的开关（`tick` 里翻转）。 */
  private nearCheckToggle = false;
  /** 复用的探测对象（避免每帧分配）：射线起点、粗筛用包围球、相机前/右方向、raycaster。 */
  private readonly _nearOrigin = new THREE.Vector3();
  private readonly _nearSphere = new THREE.Sphere();
  private readonly _nearDirF = new THREE.Vector3();
  private readonly _nearDirR = new THREE.Vector3();
  private readonly _nearRaycaster = new THREE.Raycaster();


  /** 共享状态通道（SAB 实现或消息回退实现）；校准器从它读权威帧，`tick` 向它写输入与渲染采样。 */
  constructor(private readonly shared: ShmState | MsgState) {
    this.calibrator = new AuthorityCalibrator({
      readAuth: () => this.shared.readAuthoritative(),
      getPhys: () => this.predPhys,
      clearPendingInput: () => {
        this.pendingDx = 0;
        this.pendingDy = 0;
        this.pendingKeys = 0;
      },
      onSyncRenderState: (s, teleport) => this.onSyncRenderState?.(s, teleport),
    });
  }

  /** 场景装载完成回调（`loadScene` 用场景包围盒最小 Y 调用一次）；`apps/game/src/app.ts` 注册它
   *  并转成 `setDeathY`。 */
  onSceneLoaded: ((deathThresholdY: number) => void) | null = null;

  /** 失效世代 +1（本地计数器）并调 `shared.resetRenderSample()` 让 Worker 丢弃既有采样配对。 */
  private bumpSampleEpoch(): void {
    this.sampleEpoch++;
    this.shared.resetRenderSample();
  }

  /** 采样索引空间重启：序号归零 + 失效世代 +1（两者必须同时做，否则新序号会与旧代同号项混淆）。 */
  private resetSampleStream(): void {
    this.renderSampleIndex = 0;
    this.bumpSampleEpoch();
  }

  /**
   * 渲染主线 → 权威同步回调（校准器在传送豁免期、常规反向重锚、yaw 分叉兜底三条路径上携带
   * 渲染帧完整状态调用它）。`apps/game/src/app.ts` 注册后据此给 Worker 发 `sync-render-state`。
   *
   * @param teleport true = 真位置突变（Worker 允许丢弃未消费输入增量）；
   *   false = 常规反向重锚（Worker 保留输入增量）。
   */
  onSyncRenderState: ((s: {
    posX: number; posY: number; posZ: number;
    yaw: number; pitch: number;
    velX: number; velY: number; velZ: number;
    onGround: boolean;
    eyeHeight: number;
  }, teleport: boolean) => void) | null = null;

  /** 建 renderer/scene/camera 并把光照参数初值写进共享 uniform；必须在 `loadScene` 之前调用。 */
  init(canvas: HTMLCanvasElement, width: number, height: number, dpr: number, config: RuntimeConfig): void {
    this.config = config;
    // 光照模式（面板「预烘焙 / 纯纹理」）：只是共享 uniform 的初值——两种模式都加载同一批注入
    // 材质与同一张 atlas，这里写初值只是让首帧就是所选模式（运行期切换见 setLightingMode）。
    setLightingModeInShader(config.lighting?.mode ?? 'baked');
    // 显示侧亮度倍率（接受窗口见本文的 setExposure 包装器）
    setExposure(config.lighting?.exposure ?? 1);
    // 光照项 gamma（shadow-lift）：缺省 0.5；接受窗口是 (0, 1]
    setLightGamma(config.lighting?.lightGamma ?? 0.5);
    // prop（模型）烘焙光照亮度：ambient cube 路径的独立档位，不动 world lightmap
    setAmbientScale(config.lighting?.ambientScale ?? 1.5);
    // 第 1 级逐顶点光照的几何重建档位：平滑遍数（0 = 原样使用烘焙值）与方差压缩上限
    setPropVertexRelax(config.lighting?.propVertexRelax ?? 1);
    setPropVertexFlatten(config.lighting?.propVertexFlatten ?? 0.85);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(dpr, 2)); // dpr 上限 2：高 DPI 下不再翻倍像素量
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      this.config?.hud?.fov ?? FOV_DEFAULT,
      width / Math.max(height, 1),
      0.1, // 初始 near：loadScene 会按场景尺寸改写
      100000, // 初始 far：loadScene 会改成 maxDim × 100
    );
    this.camera.position.set(0, 100, 0); // 初始位姿；之后每帧由 tick 从物理状态覆盖

    // 三点光停用（常量恒 false，scene.add 分支不执行）：本工程不加任何灯，无 lightmap 的图元由
    // applyLightmapToMeshes 的 fullbright 路径兜底。需要临时对照时把常量置 true。
    const LEGACY_THREE_POINT_LIGHTS = false;
    if (LEGACY_THREE_POINT_LIGHTS) {
      this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
      this.scene.add(new THREE.HemisphereLight(0xb0c4de, 0x404030, 0.4));
      const dir = new THREE.DirectionalLight(0xfff4e0, 0.5);
      dir.position.set(100, 200, 100);
      this.scene.add(dir);
    }

    // 背景
    this.scene.background = new THREE.Color(0x222222);
  }

  /**
   * 装载一张地图到渲染场景：GLB → 场景（摘灯 → lightmap → 分块合并 → 受光材质终扫 → 预编译）
   * → 相机 near/far → PVS/LOD 注册 → 剔除距离 → `onSceneLoaded` → 画质 manifest 与当前档位。
   * 入口先 `disposeScene`（换图释放上一张图）。`data` 由 `apps/game/src/app.ts` 用
   * `buildWorldBundle` 的产物装配，本工程内没有其它发送方。
   */
  async loadScene(data: SceneDataMessage): Promise<void> {
    if (!this.scene || !this.camera) return;
    this.disposeScene();

    // 1. GLB → Scene
    const gltf = await this.loadGlb(data.glb);
    const scene = new THREE.Scene();
    scene.userData.isBspModel = true;
    this.resetRootRotations(gltf);
    scene.add(gltf.scene);
    scene.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(scene);
    const size = bbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    // 1.1 中和 GLTFLoader 解析出的 KHR_lights_punctual 光源（**必须在挂进 this.scene 之前**）。
    //     渲染面不施加这些灯：烘焙 lightmap 已含这些实体的贡献，运行时再打就是重复计光。
    //
    //     两处都必须对，缺一个就是整批几何不渲染：
    //       (1) 位置：必须在 `this.scene.add(scene)` 之前做完。rAF 渲染循环此刻已在跑，若先挂进
    //           场景再中和，中间那一帧就会带着这批灯去编译材质，超出片元 uniform 上限后该批 mesh
    //           一个像素都不画（本方法内的 console.info 文案记录了该后果）。
    //       (2) 手段：用 `removeFromParent()` 真正摘掉，而不是只置 `visible = false`——后者仍留在
    //           场景树里被反复 traverse（本方法后面的 `traverse` 与 `optimizeScene` 都会遍历到），
    //           且任何一处把 visible 置回 true 就会让受光材质的程序失效。
    const lightsToRemove: THREE.Object3D[] = [];
    scene.traverse((obj) => {
      if ((obj as THREE.Light).isLight) lightsToRemove.push(obj);
    });
    for (const l of lightsToRemove) l.removeFromParent();
    if (lightsToRemove.length > 0) {
      console.info(
        `[lights] GLB 携带 punctual 光源 ${lightsToRemove.length} 盏 → **已从场景树摘除**（不是仅 visible=false）。` +
          '烘焙 lightmap 已含其贡献（VRAD），运行时再打会重复计光；' +
          '且 2000+ 盏会把受光材质的 uniform 推到 1024 上限 ⇒ program 无效 ⇒ 该批 mesh 一个像素都不画。',
      );
    }

    this.scene.add(scene); // 挂进主场景：此时 punctual 光源已摘除

    // 1.2 离线烘焙静态光照（lightmap atlas）：**必须**在 optimizeScene 之前施加。
    //     理由：lightmap 按原 mesh 的材质与 UV 通道施加并改写材质，而分块合并会重建几何与材质
    //     数组；放到合并之后施加就找不到原来的材质映射。
    await this.applyLightmap(scene, gltf);

    // 1.3 装配顺序的其余约束：摘灯 → 施加 lightmap → 分块合并 → 受光材质终扫（合并会重建材质
    //     数组，所以终扫必须晚于合并、早于首次编译）。

    // 1.5 空间分块合并（GLB 挂载后、PVS/LOD 注册前）：数万 mesh → 数百空间块。
    //     必须在下方 traverse（lodItems 收集 + clusterIds 分配）之前执行——那次 traverse 收集的是
    //     合并之后的块 mesh。
    this.optimizeScene(scene, gltf.scene);

    // 1.55 装配后终扫：把仍带受光材质的 mesh（GLTFLoader 给 prop/派生网格的
    //      `MeshStandardMaterial`）收敛到 fullbright。本工程不加任何灯 ⇒ 受光材质只剩
    //      emissive=[0,0,0]，恒渲染纯黑。必须在 optimizeScene 之后（合并会重建 mesh/材质数组）、
    //      首次编译之前。
    const converged = fullbrightUnlitLitMaterials(this.scene);
    if (converged > 0) {
      console.info(
        `[lightmap] 装配后终扫：${converged} 个 mesh 仍为受光材质 ⇒ 收敛为 fullbright 贴图原色` +
          '（本工程不加灯，受光材质恒黑；unlit 图元不吃 ambient cube）',
      );
    }

    // 1.6 预编译着色器程序：把「首次可见才编译」的卡顿挪到加载期。
    //     背景：`tick` 把主线程物理的 dt 夹在 0.1s 以内（上限见该方法的 dt 计算）⇒ 超过 100ms 的
    //     主线程卡顿会让物理表现为慢动作。失败不致命（three 仍按需编译），故只告警。
    try {
      const renderer = this.renderer;
      if (renderer) {
        const compileT0 = performance.now();
        renderer.compile(this.scene, this.camera);
        console.info(`[render] 着色器程序预编译耗时 ${(performance.now() - compileT0).toFixed(0)}ms`);
      }
    } catch (err) {
      console.warn('[render] 预编译着色器失败（不影响按需编译）:', err);
    }

    // 2. 相机 near/far（near 自适应：默认 maxDim/1000，贴墙由 updateNearPlane 收缩）
    this.defaultNear = Math.max(maxDim / 1000, RendererMain.CAMERA_NEAR_MIN);
    this.camera.near = this.defaultNear;
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();

    // 3. PVS + LOD 注册
    this.pvsManager = new PvsManager(data.pvsJson);
    this.lodItems.length = 0;
    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      const geom = mesh.geometry as THREE.BufferGeometry;
      if (!geom.boundingSphere) geom.computeBoundingSphere();
      const bs = geom.boundingSphere!;
      mesh.userData.lodLevel = LOD_NEAR;
      // clusterIds：空间采样分配——包围球中心与 6 个 ±r 轴上点各查一次 PvsManager.getClusterAt；
      // 不走逐 face 映射（`src/ts-shared/world/pvs-manager.ts` 的 `getFaceCluster` 在本仓零调用点，
      // 见该文件的成员说明）。
      const center = bs.center.clone().applyMatrix4(mesh.matrixWorld);
      const set = new Set<number>();
      const r = Math.max(bs.radius, 1);
      const samples: Array<[number, number, number]> = [
        [center.x, center.y, center.z],
        [center.x + r, center.y, center.z],
        [center.x - r, center.y, center.z],
        [center.x, center.y + r, center.z],
        [center.x, center.y - r, center.z],
        [center.x, center.y, center.z + r],
        [center.x, center.y, center.z - r],
      ];
      for (const [x, y, z] of samples) {
        const cl = this.pvsManager!.getClusterAt({ x, y, z });
        if (cl >= 0) set.add(cl);
      }
      this.lodItems.push({
        mesh,
        center,
        radius: bs.radius,
        clusterIds: [...set],
      });
    });

    // 4. 视距剔除距离：自动值 = 场景包围盒对角线 × 0.5（下限 1000）；config.hud.renderDistance > 0
    //    时覆盖它（面板「渲染距离」滑块；0 = 自动）
    this.autoCullDistance = Math.max(maxDim * 0.5, 1000);
    const cfgRenderDistance = this.config?.hud?.renderDistance ?? 0;
    this.cullDistance = cfgRenderDistance > 0 ? cfgRenderDistance : this.autoCullDistance;


    // 5. 回传场景包围盒最小 Y（`onSceneLoaded` 的调用方把它当死亡阈值转给 setDeathY）
    this.onSceneLoaded?.(bbox.min.y);

    // 6. 纹理画质 manifest + 按当前画质应用（mosaic 切换数据源）
    this.mosaicManifest = data.mosaicManifest
      ? (JSON.parse(data.mosaicManifest) as Record<string, string>)
      : null;
    void this.applyTextureQuality(this.config.texture.quality);
  }

  // ── 纹理画质切换（原始 / mosaic 压缩低清）────────────────────

  /**
   * 按画质档位替换场景全部贴图：`mini` = 查 manifest 里的 mosaic 字节码还原低清图；
   * `original` = 还原 `origTextureImages` 缓存的原始 image。即时生效（只换 texture.image），
   * 不重载地图；manifest 或场景缺失时整体空跑。
   */
  async applyTextureQuality(quality: 'original' | 'mini'): Promise<void> {
    const manifest = this.mosaicManifest;
    if (!manifest || !this.scene) return;
    const maps = new Set<THREE.Texture>();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      const list = Array.isArray(mat) ? mat : [mat];
      for (const m of list) {
        const map = (m as unknown as { map?: THREE.Texture | null }).map;
        if (map) maps.add(map);
      }
    });
    const jobs: Promise<void>[] = [];
    for (const map of maps) {
      if (quality === 'original') {
        const orig = this.origTextureImages.get(map);
        if (orig !== undefined) {
          map.dispose(); // 新旧尺寸不同，先释放让 three 按新尺寸重建 GPU 纹理
          map.image = orig;
          map.needsUpdate = true;
          this.origTextureImages.delete(map);
        }
        continue;
      }
      const code = manifest[(map.name ?? '').toLowerCase()];
      if (!code) continue;
      if (!this.origTextureImages.has(map)) this.origTextureImages.set(map, map.image);
      jobs.push(this.replaceMapWithMosaic(map, code));
    }
    await Promise.all(jobs);
  }

  /** 单个贴图：mosaic 字节码 → PNG 字节 → ImageBitmap 后替换 image。
   * 替换前必须 dispose()：同一 texture 换 image 时 three 走增量上传，新旧尺寸不符会失败
   * （纹理保持旧内容）；dispose 后按新尺寸重建 GPU 纹理。失败只告警，保留原贴图。 */
  private async replaceMapWithMosaic(map: THREE.Texture, code: string): Promise<void> {
    try {
      const png = mosaic_decode(code, 8);
      const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
      map.dispose();
      map.image = bitmap;
      map.needsUpdate = true;
    } catch (e) {
      console.warn('[renderer] mosaic 贴图替换失败:', e);
    }
  }

  /** 启动 rAF 循环（重复调用无副作用：已在跑时直接返回）。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.rafId = requestAnimationFrame(this.boundTick);
  }

  /** 停止 rAF 循环并注销句柄（在途回调由 `tick` 开头的 `running` 判定自行退出）。 */
  stop(): void {
    this.running = false;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** 释放当前地图：摘除并释放 BSP 场景根（`userData.isBspModel` 的子树）、清 PVS/LOD 与主线程
   *  物理、丢弃待喂输入、复位注入统计开关与校准器、重启渲染采样流。
   *  不销毁 renderer/scene/camera 本身——换图后由 `loadScene` 继续复用。 */
  disposeScene(): void {
    if (this.scene) {
      for (let i = this.scene.children.length - 1; i >= 0; i--) {
        const child = this.scene.children[i];
        if (child.userData?.isBspModel) {
          this.disposeObject(child);
          this.scene.remove(child);
        }
      }
    }
    this.pvsManager = null;
    this.lodItems.length = 0;
    this.predPhys = null;
    this.predReady = false;
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
    // 换图：注入生效性统计要对新场景重跑（否则第二张图不再报告注入状态）
    this.pendingInjectReport = false;
    this.injectReported = false;
    // 权威帧校准状态清零（防上一张图的权威帧注入新地图）
    this.calibrator.clear();
    // 换图后渲染采样流不连续 → 索引空间重启（世代 +1，Worker 丢弃旧图缓存）
    this.resetSampleStream();
  }

  /**
   * 近平面自适应：以 (px, py, pz) 为射线起点，沿相机局部系的前/后/左/右四个水平方向在
   * `nearProbeDist` 内探测最近的 BSP mesh；命中则把 `camera.near` 收到
   * max(命中距离 × nearRatio, CAMERA_NEAR_MIN)，无命中恢复 `defaultNear`。
   * 粗筛：包围球中心到起点的距离 < 探测距离 × 2 + 球半径 的 mesh 才进入射线检测。
   * 只写 `camera.near`（变化超过 0.001 才更新投影矩阵）；由 `tick` 每 2 帧调用一次。
   */
  private updateNearPlane(px: number, py: number, pz: number): void {
    const camera = this.camera;
    if (!camera || !this.scene) return;
    const probe = this.nearProbeDist;
    this._nearOrigin.set(px, py, pz);

    // 1. 包围球粗筛（BSP 模型子树）
    const candidates: THREE.Mesh[] = [];
    for (const root of this.scene.children) {
      if (!root.userData?.isBspModel) continue;
      root.traverse((obj) => {
        if (!(obj as THREE.Mesh).isMesh) return;
        const mesh = obj as THREE.Mesh;
        const geom = mesh.geometry as THREE.BufferGeometry | null;
        if (!geom) return;
        if (!geom.boundingSphere) geom.computeBoundingSphere();
        const bs = geom.boundingSphere;
        if (!bs) return;
        this._nearSphere.copy(bs).applyMatrix4(mesh.matrixWorld);
        if (this._nearSphere.center.distanceTo(this._nearOrigin) < probe * 2 + this._nearSphere.radius) {
          candidates.push(mesh);
        }
      });
    }

    // 2. 相机局部基向量 + 4 方向（4 水平正交）探测最近几何
    let minD = Infinity;
    if (candidates.length > 0) {
      const q = camera.quaternion;
      this._nearDirF.set(0, 0, -1).applyQuaternion(q);
      const right = this._nearDirR.set(1, 0, 0).applyQuaternion(q);
      const dirs = [
        this._nearDirF,
        this._nearDirF.clone().negate(),
        right.clone(),
        right.clone().negate(),
      ];
      for (const dir of dirs) {
        this._nearRaycaster.set(this._nearOrigin, dir);
        this._nearRaycaster.near = 0;
        this._nearRaycaster.far = probe;
        const hits = this._nearRaycaster.intersectObjects(candidates, false);
        if (hits.length > 0 && hits[0].distance < minD) {
          minD = hits[0].distance;
        }
      }
    }

    // 3. 设定 near（贴墙收缩，空旷恢复默认）
    const target =
      isFinite(minD)
        ? Math.max(minD * this.nearRatio, RendererMain.CAMERA_NEAR_MIN)
        : this.defaultNear;
    if (Math.abs(camera.near - target) > 0.001) {
      camera.near = target;
      camera.updateProjectionMatrix();
    }
  }

  /** 面板实时调整探测距离与收缩系数：两项都只在传入正数时写，ratio 还需 ≤ 1；下一帧探测生效。 */
  setNearParams(probeDist?: number, ratio?: number): void {
    if (probeDist !== undefined && probeDist > 0) {
      this.nearProbeDist = probeDist;
    }
    if (ratio !== undefined && ratio > 0 && ratio <= 1) {
      this.nearRatio = ratio;
    }
  }

  /** 设置视野角 FOV（度）：写相机并立刻更新投影矩阵；相机未建时忽略。 */
  setFov(fov: number): void {
    if (!this.camera) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 全局曝光（显示侧亮度倍率）：转发给 `apps/game/src/renderer/lightmap-shader.ts` 的
   * `setExposure` —— 改的是共享 uniform，立即生效、不重编译材质。该函数只接受有限正数，
   * 其余值（含 0 与负数）被忽略。
   */
  setExposure(value: number): void {
    setExposure(value);
  }

  /**
   * 光照项 gamma（shadow-lift）：转发给 `apps/game/src/renderer/lightmap-shader.ts` 的
   * `setLightGamma`。接受窗口是 (0, 1]，窗口外的值被忽略（`apps/game/src/config.ts` 的
   * `lighting.lightGamma` 默认 2.2 即落在窗口外，`init` 的那次写入不改变共享 uniform）。
   */
  setLightGamma(value: number): void {
    setLightGamma(value);
  }

  /**
   * prop（模型）烘焙光照亮度倍率（ambient cube 路径专用）：转发给
   * `apps/game/src/renderer/lightmap-shader.ts` 的 `setAmbientScale`；接受有限非负数。
   */
  setAmbientScale(value: number): void {
    setAmbientScale(value);
  }

  // ── 主线程唯一物理线 ───────────────────────────────────────

  /** 初始化 wasm 模块（`PhysWorld` 与 `mosaic_decode` 同模块，全工程只初始化一次）。
   *  dist 内嵌模式传 wasmB64（file:// 下取不到 wasm）。
   * 用 initSync({ module })：生成胶水的 async init(module_or_path) 会解构 `{ module_or_path }`，
   * 传 `{ module }` 会解构出 undefined 并回落到 `new URL('websurf_wasm_bg.wasm', import.meta.url)`
   * （dist 下 import.meta.url 被 define 成 about:blank ⇒ 构造 URL 抛错；dev 下多一次 fetch）。 */
  async initPrediction(wasmUrl: string, wasmB64?: string): Promise<void> {
    if (wasmB64) {
      const bytes = base64ToBytes(wasmB64);
      initSync({ module: bytes.buffer as ArrayBuffer });
      return;
    }
    const resp = await fetch(wasmUrl);
    const buf = await resp.arrayBuffer();
    initSync({ module: buf });
  }

  /** 建主线程物理世界（唯一物理线：世界 + 碰撞 + 输入 + 传送），并复位校准器与渲染采样流。 */
  buildPredictionWorld(world: {
    brushJson: string;
    triJson: string;
    teleportJson: string;
    spawn: { x: number; y: number; z: number; yawDeg: number };
  }): void {
    const phys = new PhysWorld();
    phys.build_world(
      world.brushJson,
      world.triJson,
      world.teleportJson,
      world.spawn.x,
      world.spawn.y,
      world.spawn.z,
      world.spawn.yawDeg,
    );
    this.predPhys = phys;
    this.predReady = true;
    // 权威帧校准状态清零（首帧权威帧将作为新起点）
    this.calibrator.clear();
    // 新世界：渲染采样流不连续 → 索引空间重启（世代 +1，Worker 丢弃旧世界缓存）
    this.resetSampleStream();
  }

  /** 物理实例输入（app 事件回调喂入；dx/dy 为角度增量、keysMask 为键位掩码）：dx/dy 累加、
   *  键位覆盖写。 */
  feedInput(dx: number, dy: number, keysMask: number): void {
    this.pendingDx += dx;
    this.pendingDy += dy;
    this.pendingKeys = keysMask;
  }

  /** 清空待喂输入（退锁/重锁、读点、noclip 切换与校准器兜底同步时调用，防残留增量污染新状态）。 */
  clearPendingInput(): void {
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
  }

  /** 重生：直接让主线程物理调 `respawn`（不经 Worker），随后重启渲染采样流。 */
  respawn(): void {
    this.predPhys?.respawn();
    // 位置突变 → 采样流不连续：世代 +1（Worker 丢弃旧位置缓存）
    this.bumpSampleEpoch();
  }

  /** 传送至指定出生点索引（面板 spawn 下拉；索引空间由 `setSpawnPoints` 设入）。 */
  teleportToSpawn(idx: number): void {
    this.predPhys?.teleport_to_spawn(idx);
    this.bumpSampleEpoch();
  }

  /** 设置物理实例的出生点列表（`[[x, y, z, yaw], ...]`，序列化成 JSON 传入）；失败只打日志。 */
  setSpawnPoints(list: Array<[number, number, number, number]>): void {
    try {
      this.predPhys?.set_spawn_points(JSON.stringify(list));
    } catch (err) {
      console.error('[renderer] set_spawn_points 失败:', err);
    }
  }

  /** 设置掉落死亡 Y 阈值（`loadScene` 之后由 `onSceneLoaded` 的调用方转交）。 */
  setDeathY(y: number): void {
    this.predPhys?.set_death_y(y);
  }

  /** 读当前物理速度（面板速度显示按 8Hz 采样）；物理未建时返回零向量。 */
  getCurrentVel(): { x: number; y: number; z: number } {
    if (!this.predPhys) return { x: 0, y: 0, z: 0 };
    const st = this.predPhys.state() as { velX: number; velY: number; velZ: number };
    return { x: st.velX, y: st.velY, z: st.velZ };
  }

  /** 读完整物理状态（位置/朝向/速度/着地），X 键存点采样用；物理未建时返回全零。 */
  getFullState(): {
    x: number; y: number; z: number;
    yaw: number; pitch: number;
    vx: number; vy: number; vz: number;
    onGround: boolean;
  } {
    const empty = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, onGround: false };
    if (!this.predPhys) return empty;
    const st = this.predPhys.state() as {
      posX: number; posY: number; posZ: number;
      yaw: number; pitch: number;
      velX: number; velY: number; velZ: number;
      onGround: boolean;
    };
    return {
      x: st.posX, y: st.posY, z: st.posZ,
      yaw: st.yaw, pitch: st.pitch,
      vx: st.velX, vy: st.velY, vz: st.velZ,
      onGround: st.onGround,
    };
  }

  /** 读点：把存点全状态写进主线程物理，随后按传送口径处理——重启渲染采样流、清待喂输入，并以
   * `teleport = true` 调 `onSyncRenderState`（`apps/game/src/app.ts` 据此发 `sync-render-state`，
   * 让 Worker 也把权威状态置到存点并丢弃未消费输入增量）。
   * `eyeHeight` 取当前姿态值（存点不含蹲伏态），物理未建时回落 `EYE_STAND`。 */
  loadSavepoint(sp: {
    x: number; y: number; z: number;
    yaw: number; pitch: number;
    vx: number; vy: number; vz: number;
    onGround: boolean;
  }): void {
    this.predPhys?.set_state(sp.x, sp.y, sp.z, sp.yaw, sp.pitch, sp.vx, sp.vy, sp.vz, sp.onGround);
    // 位置突变 → 采样流不连续：世代 +1（Worker 丢弃旧位置缓存）
    this.bumpSampleEpoch();
    this.clearPendingInput();
    // 权威同步（复用 sync-render-state）：eyeHeight 取当前姿态值（存点不含蹲伏态）
    const cur = this.predPhys?.state() as
      | { eyeHeight: number }
      | undefined;
    this.onSyncRenderState?.(
      {
        posX: sp.x, posY: sp.y, posZ: sp.z,
        yaw: sp.yaw, pitch: sp.pitch,
        velX: sp.vx, velY: sp.vy, velZ: sp.vz,
        onGround: sp.onGround,
        eyeHeight: cur?.eyeHeight ?? EYE_STAND,
      },
      true, // 存点 load = 真位置突变：允许 Worker 丢弃未消费输入增量
    );
  }

  /**
   * 按住 C 读点：登记冻结目标；此后 `tick` 每帧把物理写回该位姿并把速度归零（空中悬停、地面站定）。
   * 只写本类字段，不立即改物理；解除见 `releaseHoldPoint`。
   */
  setHoldPoint(sp: {
    x: number; y: number; z: number;
    yaw: number; pitch: number;
    onGround: boolean;
  }): void {
    this.holdPoint = sp;
  }

  /** 松开 C：清冻结目标，并按存点全量恢复（含速度与权威同步，见 `loadSavepoint`）。 */
  releaseHoldPoint(sp: {
    x: number; y: number; z: number;
    yaw: number; pitch: number;
    vx: number; vy: number; vz: number;
    onGround: boolean;
  }): void {
    this.holdPoint = null;
    this.loadSavepoint(sp);
  }

  /** 每帧消费一次权威帧（实现见 `src/ts-shared/phys/authority-calibrator.ts` 的
   *  `AuthorityCalibrator`）：豁免期同步、首帧取起点、常规反向重锚、yaw 分叉兜底。 */
  private correctFromAuthority(): void {
    this.calibrator.correctFromAuthority();
  }

  /** 用权威帧的速度与加速度把渲染物理速度外推到当前时刻；帧龄按读到该帧的时刻算（`now` 取同一
   *  rAF 时间戳）。实现见 `src/ts-shared/phys/authority-calibrator.ts` 的 `calibrateVelocity`。 */
  private calibrateVelocity(now: number): void {
    this.calibrator.calibrateVelocity(now);
  }

  /** 显式位置突变：把物理写到指定位置/角度（速度清零、置着地）、清待喂输入、复位校准状态、
   *  开权威豁免窗口，并重启渲染采样流。
   *  本工程内没有调用点（respawn / 传送 / 读点各走自己的路径，见 app.ts 的对应接线）。 */
  resetTo(pos: number[], yawDeg: number): void {
    this.calibrator.resetTo(pos, yawDeg);
    // 位置突变 → 采样流不连续：世代 +1（Worker 丢弃旧位置缓存）
    this.bumpSampleEpoch();
  }

  /**
   * 权威碰撞事件入口（`apps/game/src/app.ts` 收到 `phys-event` 后调用）：只有 `land` 且渲染自身
   * 已着地时才写物理——把 `onGround` 置真、速度取事件携带的权威速度（缺省回落渲染自身速度），
   * 位置与角度写回刚读到的当前值（故零变化）。`blocked` 与三个位置/角度入参不生效，细节见
   * `src/ts-shared/phys/authority-calibrator.ts` 的 `applyCollisionCorrection`。
   */
  applyCollisionCorrection(kind: 'land' | 'blocked', pos: number[], yawDeg: number, pitchDeg: number, vel?: number[]): void {
    this.calibrator.applyCollisionCorrection(kind, pos, yawDeg, pitchDeg, vel);
  }

  /** 面板参数实时同步到主线程物理实例（JSON 走 `set_params`）；失败只打日志。 */
  setPredictionParams(params: Record<string, unknown>): void {
    try {
      this.predPhys?.set_params(JSON.stringify(params));
    } catch (err) {
      console.error('[renderer] set_params 失败:', err);
    }
  }

  /**
   * noclip 开关同步到主线程物理（`set_noclip`，物理内部切换到无碰撞移动），随后重启渲染采样流
   * 并清待喂输入（轨迹不连续）。渲染侧无额外分支——`tick` 照常读物理状态。
   */
  setPredictionNoclip(active: boolean): void {
    try {
      this.predPhys?.set_noclip(active);
    } catch (err) {
      console.error('[renderer] set_noclip 失败:', err);
    }
    // 模式切换后轨迹不连续 → 世代 +1
    this.bumpSampleEpoch();
    this.clearPendingInput();
  }

  /** 面板体型（碰撞箱半宽 / 站立高 / 蹲下高）实时同步到主线程物理实例。 */
  setPredictionHull(halfWidth: number, standHeight: number, duckHeight: number): void {
    this.predPhys?.set_hull(halfWidth, standHeight, duckHeight);
  }

  /** 释放子树：逐个 mesh 释放几何、材质上的 `map` 贴图与材质本身（`disposeScene` 用）。 */
  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if (!mat) continue;
        const tex = (mat as unknown as Record<string, unknown>).map as THREE.Texture | undefined;
        if (tex?.isTexture) tex.dispose();
        mat.dispose();
      }
    });
  }

  /** 绑定后的 rAF 回调（`start` 与 `tick` 都把它交给 rAF，避免每次 bind 产生新函数）。 */
  private readonly boundTick = this.tick.bind(this);

  /**
   * 每个 rAF 一次：先推进主线程物理并同步相机，再做剔除与绘制。
   * - 物理分支（`predReady` 且 `predPhys` 非空）：dt = 与上一物理帧的间隔（首个物理帧取 1/64，
   *   上限 0.1s）→ `shared.addInput` 把输入交给 Worker 权威帧 → `correctFromAuthority` →
   *   `calibrateVelocity` → `predPhys.tick` → 把 dx/dy 清零（键位保留为按住状态）→ 冻结分支
   *   （`holdPoint` 非空时每帧写回该位姿且速度 0）→ 读 `state()` → 写渲染采样 →
   *   相机 rotation/position → 每 2 帧跑一次 `updateNearPlane`；
   * - 剔除分支：按 `cullDistance`（`ENABLE_PVS` 为真时再叠加 PVS 可见性）改 `mesh.visible`；
   * - 绘制：`renderer.render()`；若 `pendingInjectReport` 置位则在其后跑一次注入统计。
   * 副作用：写共享槽（输入与渲染采样）、改主线程物理状态、改相机与 mesh 可见性。
   */
  private tick(now: number): void {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.boundTick);
    if (!this.renderer || !this.scene || !this.camera) return;

    // 1. 主线程物理线：把输入交给 Worker 权威帧 → 消费权威帧 → 推进本地物理 → 取状态渲染
    if (this.predReady && this.predPhys) {
      const dt = this.lastTickMs === 0 ? 1 / 64 : Math.min((now - this.lastTickMs) / 1000, 0.1);
      this.lastTickMs = now;
      // 输入 → 共享槽（Worker 权威帧与主线程消费同一份输入）
      this.shared.addInput(this.pendingDx, this.pendingDy, this.pendingKeys);
      // 消费权威帧（只读共享槽；首帧取起点、常规反向重锚、yaw 分叉兜底都在校准器内）
      this.correctFromAuthority();
      // 权威速度外推校准（位置不由权威覆盖）
      this.calibrateVelocity(now);
      // 推进物理：碰撞/传送/死亡判定都在物理内部（noclip 时走无碰撞分支）
      this.predPhys.tick(dt, this.pendingKeys, this.pendingDx, this.pendingDy);
      this.pendingDx = 0;
      this.pendingDy = 0;
      // 冻结分支：把物理写回存点位姿（位置/朝向 = 存点，速度 = 0，着地 = 存点值），悬停到解除
      if (this.holdPoint) {
        const h = this.holdPoint;
        this.predPhys.set_state(h.x, h.y, h.z, h.yaw, h.pitch, 0, 0, 0, h.onGround);
      }
      // 渲染 = 主线程物理状态（相机直接跟随，不另做平滑）
      const st = this.predPhys.state() as {
        posX: number; posY: number; posZ: number;
        yaw: number; pitch: number;
        eyeHeight: number;
      };
      // 渲染采样：与渲染状态读取同拍同源，i0 每帧 +1（序号语义见 renderSampleIndex）。
      // 不传世代：世代槽由 shared-state 的 resetRenderSample 独占并就地读，传调用方缓存值会把
      // bumpSampleEpoch 刚做的自增写回旧值。
      this.shared.writeRenderSample(now, st.posX, st.posY, st.posZ, this.renderSampleIndex++);
      // Rust 输出角度为度 → 弧度
      this.camera.rotation.set(st.pitch * DEG2RAD, st.yaw * DEG2RAD, 0, 'YXZ');
      this.camera.position.set(st.posX, st.posY + st.eyeHeight, st.posZ);

      // 近平面贴墙自适应（每 2 帧一次）：贴墙收缩 near，防近平面把墙面裁掉
      this.nearCheckToggle = !this.nearCheckToggle;
      if (this.nearCheckToggle) {
        this.updateNearPlane(st.posX, st.posY + st.eyeHeight, st.posZ);
      }
    }

    const camPos = this.camera.position;

    // 2. LOD/PVS 剔除：超距与（PVS 启用且相机 cluster 有效时）不可见的块置 visible = false
    if (this.lodItems.length > 0) {
      const pvs = this.pvsManager;
      if (ENABLE_PVS && pvs) pvs.update(camPos);
      // 相机不在任何 cluster（出生在固体里/地图外）时可见集为空，会把有 cluster 的块错误全剔
      // → 这种情况跳过 PVS，只按距离判定
      const pvsActive = ENABLE_PVS && pvs !== null && pvs.enabled;
      const pvsClusterValid = pvs !== null && pvs.currentClusterId >= 0;
      for (const item of this.lodItems) {
        const dist = item.center.distanceTo(camPos);
        let level = LOD_NEAR;
        if (dist > this.cullDistance) {
          level = LOD_FAR;
        } else if (
          pvsActive &&
          pvsClusterValid &&
          item.clusterIds.length > 0 &&
          !item.clusterIds.some((c) => pvs!.isVisible(c))
        ) {
          level = LOD_PVS_HIDDEN;
        }
        if (item.mesh.userData.lodLevel !== level) {
          item.mesh.userData.lodLevel = level;
          item.mesh.visible = level === LOD_NEAR;
        }
      }
    }

    // 3. 绘制（帧率跟随 rAF，不做节流）
    this.renderer.render(this.scene, this.camera);

    // 3b. 首帧之后跑一次注入生效性统计（此刻材质已编译、onBeforeCompile 的回填已到位）
    if (this.pendingInjectReport && !this.injectReported) {
      this.injectReported = true;
      this.pendingInjectReport = false;
      this.reportInjectStatsOnce();
    }
  }

  /**
   * 注入生效性统计（由 `tick` 在首帧 `renderer.render()` 之后调用一次）。
   *
   * 统计口径：遍历场景材质上的 `__vbspLightmapInject` 记录，按 `skipped` / `expectedFail` /
   * `applied` 分别计数，其余算失效并留最多 3 条样本。阶段名读 `globalThis.__vbspLightmapStage`：
   * 命中 `KNOWN_STAGES` 就原样使用，否则一律按 `auto`。
   * 阶段分支：`broken` 与 `noinject` 只告警，`native` 直接返回（走 three 原生 lightmap）；其余阶段
   * 「有失效材质但一条注入都没生效」时置 `globalThis.__vbspLightmapInjectFailed` 并打 error
   * （出帧脚本据此非零退出），只是部分失效则告警。
   * 同一趟还会打印 ambient cube 与第 1 级逐顶点光照的接线统计，以及材质的 alpha 状态审计。
   */
  private reportInjectStatsOnce(): void {
    if (!this.scene) return;
    const stage = (globalThis as { __vbspLightmapStage?: unknown }).__vbspLightmapStage;
    // 已知阶段名原样保留（`channel0` / `channel1` 是注入通道对照档、`noinject` 是可比负控）：
    // 把对照档记成 `auto` 会让日志与出帧标签对不上
    const KNOWN_STAGES = ['broken', 'native', 'off', 'channel0', 'channel1', 'noinject'];
    const stageName = typeof stage === 'string' && KNOWN_STAGES.includes(stage) ? stage : 'auto';

    let injectOk = 0;
    let injectBad = 0;
    let skipped = 0;
    let expectedFail = 0;
    const samples: unknown[] = [];
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat) continue;
        const rec = (
          mat as unknown as {
            __vbspLightmapInject?: { applied?: boolean | null; skipped?: boolean; expectedFail?: boolean };
            __vbspLightmapInjected?: boolean;
          }
        ).__vbspLightmapInject;
        if (!rec) continue;
        if (rec.skipped) skipped++;
        else if (rec.expectedFail) expectedFail++;
        else if (rec.applied) injectOk++;
        else {
          injectBad++;
          if (samples.length < 3) samples.push(rec);
        }
      }
    });

    console.info(
      `[lightmap] 注入生效性（首帧后统计，stage=${stageName}）：` +
        `注入生效材质=${injectOk}，注入失效材质=${injectBad}，` +
        `跳过=${skipped}，预期失败=${expectedFail}`,
    );

    // prop ambient cube 命中统计（hit/miss 按 mesh 调用计；nodes = 去重后的 cube 引用数）
    const amb = (globalThis as { __vbspAmbientStats?: { hit: number; miss: number; nodes: Set<unknown> } })
      .__vbspAmbientStats;
    if (amb) {
      console.info(
        `[ambient-cube] 命中=${amb.hit} 未命中=${amb.miss} 节点=${amb.nodes.size}`,
      );
      // 材质级统计：遍历材质读 `__vbspAmbientInject.applied`
      let ambOk = 0;
      let ambBad = 0;
      this.scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (!m.isMesh) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          const rec = (mat as unknown as { __vbspAmbientInject?: { applied?: boolean } })
            .__vbspAmbientInject;
          if (!rec) continue;
          if (rec.applied) ambOk++;
          else ambBad++;
        }
      });
      console.info(`[ambient-cube] applied=${ambOk} 失败=${ambBad}`);
    }

    // 第 1 级 prop 光照（逐顶点预烘焙 → `_VBSP_VLIGHT` 几何属性）的接线校验：走这一级的材质数、
    // 注入是否生效、有没有失败。带属性却没注入记录的分两类：材质标了 `userData.unlit === true`
    // 的自发光 VMT 本就不吃光照（正确），其余算真漏网并打 error。
    {
      let vlOk = 0;
      let vlBad = 0;
      let vlUnlit = 0;
      let vlMissed = 0;
      this.scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (!m.isMesh) return;
        const g = m.geometry as THREE.BufferGeometry | undefined;
        const hasAttr = !!g?.getAttribute?.(VERTEX_LIGHTING_ATTR);
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          const rec = (mat as unknown as { __vbspVertexLightingInject?: { applied?: boolean } })
            .__vbspVertexLightingInject;
          if (!rec) {
            if (!hasAttr) continue;
            const unlit = (mat?.userData as { unlit?: unknown } | undefined)?.unlit === true;
            if (unlit) vlUnlit++;
            else vlMissed++;
            continue;
          }
          if (rec.applied) vlOk++;
          else vlBad++;
        }
      });
      if (vlOk + vlBad + vlUnlit + vlMissed > 0) {
        const rs = getVertexLightingRelaxStats();
        console.info(
          `[vertex-lighting] 第 1 级（逐顶点预烘焙）注入：生效材质=${vlOk}，失败=${vlBad}，` +
            `自发光 unlit（按 VMT 语义不吃光照，正确）=${vlUnlit}，**真漏网**=${vlMissed}`,
        );
        console.info(
          `[vertex-lighting] 几何重建（${getPropVertexRelax() === 0 ? '**关闭**：原样使用烘焙值' : `平滑档 ${getPropVertexRelax()}`}）：` +
            `mesh=${rs.meshes}，接缝焊接组=${rs.welded}，空间不一致顶点=${rs.medianFixed}，松弛遍数=${rs.relaxed}，` +
            `方差压缩 mesh=${rs.flattened}（**跳过 ${rs.flattenSkipped}**：面内本来就一致 ⇒ 保留原样烘焙值，flatten=${getPropVertexFlatten()}），` +
            `平均偏移=${(rs.meanAbsDelta * 100).toFixed(1)}%（单顶点最大 ${(rs.maxAbsDelta * 100).toFixed(1)}%，` +
            `样本顶点=${rs.samples}）`,
        );
      }
      if (vlMissed > 0) {
        console.error(
          `[vertex-lighting] 有 ${vlMissed} 个带 _VBSP_VLIGHT 的非 unlit mesh 没走到第 1 级材质 ⇒ 缺陷`,
        );
      }
      // alpha 状态审计（铁丝网/格栅/玻璃这类材质的关键状态：替换材质若丢掉 alphaTest/side，
      // $alphatest 的孔洞会变成实心板、单面材质会少一半）
      let aCut = 0;
      let aBlend = 0;
      let aDouble = 0;
      this.scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (!m.isMesh) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          if (!mat) continue;
          if ((mat as THREE.Material & { alphaTest?: number }).alphaTest &&
            (mat as THREE.Material & { alphaTest?: number }).alphaTest! > 0) aCut++;
          if (mat.transparent) aBlend++;
          if ((mat as THREE.Material & { side?: number }).side === THREE.DoubleSide) aDouble++;
        }
      });
      console.info(
        `[alpha] 场景材质 alpha 状态：alphaTest>0 判 =${aCut}，transparent=${aBlend}，双面=${aDouble}` +
          `（GLB 侧：MASK=8 / BLEND=11 / 无贴图=18；裁切/混合若在此丢失即为铁丝网、格栅、玻璃整片不透的根因）`,
      );
    }

    if (stageName === 'broken') {
      // broken：预期注入失效，只告警不打 error（免得出帧负控帧被污染）
      console.warn(
        `[lightmap] stage=broken（负控）：注入预期失效 —— 预期失败材质=${expectedFail}、生效=${injectOk}。`,
      );
      return;
    }
    if (stageName === 'native') {
      // native：按设计走 three 原生 lightmap 采样，不计失败
      return;
    }
    if (stageName === 'noinject') {
      // noinject：材质照换、只是不注入 ⇒ 本来就没有 `__vbspLightmapInject` 记录，
      // injectOk = injectBad = 0 属预期，不得报"注入全失效"
      console.warn(
        '[lightmap] stage=noinject（可比负控）：材质替换保留、仅停用 shader 注入 ⇒ ' +
          '无注入记录属预期；画面预期退回无烘焙光照，且场景构成与 auto 相同（可比）。',
      );
      return;
    }
    if (injectOk === 0 && injectBad > 0) {
      const message =
        '[lightmap] 施加了材质但**没有任何一个注入生效** —— fragment 里找不到可替换的 ' +
        'lightmap 块（three 版本漂移？）。地图将只剩贴图、无烘焙光照。样本：' +
        JSON.stringify(samples);
      (globalThis as { __vbspLightmapInjectFailed?: boolean }).__vbspLightmapInjectFailed = true;
      console.error(message);
    } else if (injectBad > 0) {
      console.warn(
        `[lightmap] 有 ${injectBad} 个材质注入失效（成功 ${injectOk} 个）。样本：` +
          JSON.stringify(samples),
      );
    }
  }

  /** 画布尺寸变化：同步 renderer 尺寸与相机宽高比（高度为 0 时按 1 处理）。 */
  resize(width: number, height: number): void {
    if (!this.renderer || !this.camera) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  /**
   * 设置剔除距离（世界单位，面板「渲染距离」滑块）。
   * `> 0` = 用该值；`<= 0` = 恢复自动值（场景包围盒对角线的一半，下限 1000）。
   * 生效点：`tick` 的剔除遍历——距离超过它的块置 `visible = false`，不产生 draw call。
   */
  setRenderDistance(dist: number): void {
    this.cullDistance = dist > 0 ? dist : this.autoCullDistance;
  }

  // ── GLB 加载 ───────────────────────────────────────────────

  /** 复用的 GLTFLoader（`loadGlb` 每次 `loadAsync`）。 */
  private readonly gltfLoader = new GLTFLoader();

  /** GLB 字节 → GLTF：先把字节拷进新的 `Uint8Array` 再交给 Blob URL，`finally` 里注销该 URL。 */
  private async loadGlb(glbBytes: ArrayBuffer): Promise<GLTF> {
    const buffer = new Uint8Array(glbBytes.byteLength);
    buffer.set(new Uint8Array(glbBytes));
    const blob = new Blob([buffer], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    try {
      return await this.gltfLoader.loadAsync(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * 施加离线烘焙静态光照（lightmap atlas）。
   *
   * 契约：图集纹理由 `src/wasm-core/bsp_to_gltf_core/lightmap.rs` 写进 GLB，位置由
   * `apps/game/src/renderer/lightmap-shader.ts` 的 `loadLightmapAtlas` 解析（`asset.extras.lightmap`
   * 或 `scene.userData.extras.lightmap` 的 `textureIndex`）；图元侧带 `TEXCOORD_1` 与
   * `extras.hasLightmap`（落在 geometry.userData）。
   * 没有图集时只打日志返回；施加数与 atlas 尺寸打日志；施加成功时置 `pendingInjectReport`，
   * 把生效性统计留给首帧之后的 `tick`。异常只告警，不阻断场景加载。
   */
  private async applyLightmap(scene: THREE.Scene, gltf: GLTF): Promise<void> {
    try {
      // atlas 在两种光照模式下都要加载：模式只是片元里的共享 uniform 分支（`vbspBakedMix`），
      // 纯纹理模式下若不带 atlas，面板切回预烘焙就得重建场景
      const atlas = await loadLightmapAtlas(gltf.parser, gltf);
      if (!atlas) {
        console.info('[lightmap] GLB 未携带 atlas（asset.extras.lightmap 缺失），跳过静态光照');
        return;
      }
      const applied = applyLightmapToMeshes(scene, atlas);
      const image = atlas?.image as { width?: number; height?: number } | undefined;
      // 这里不做注入生效性统计：本方法在建场景时调用，three 还没编译材质，onBeforeCompile 尚未
      // 回填注入记录 ⇒ 统计只会得到全 0。统计放到首帧渲染之后，见 tick 里的 reportInjectStatsOnce，
      // 口径与 __vbspFrameProbe.lightmapState() 一致。
      console.info(
        `[lightmap] 光照模式=${getLightingMode()}，atlas ${image?.width ?? 0}×${image?.height ?? 0}，施加 mesh=${applied}`,
      );
      if (applied === 0) {
        console.warn('[lightmap] atlas 存在但未施加到任何 mesh（无 TEXCOORD_1 或 hasLightmap 全为 false）');
      }
      // 首帧后统一统计（幂等；由 tick 调用）
      this.pendingInjectReport = applied > 0;
    } catch (err) {
      console.error('[lightmap] 施加离线烘焙光照失败:', err);
    }
  }

  /**
   * 切换光照模式（面板「预烘焙 / 纯纹理」）：只改共享 uniform，立即生效。
   *
   * 机制（见 `apps/game/src/renderer/lightmap-shader.ts` 的 `setLightingMode`）：全场景注入材质共用
   * 同一个 `vbspBakedMix` uniform，world lightmap / 逐顶点光照 / ambient cube 三条烘焙路径都按它
   * 分支 ⇒ 不重建场景、不重编译材质、不打断输入与物理，分块与材质分组也不变。
   *
   * @param mode `baked` = 预烘焙（吃 atlas + 逐顶点 + ambient cube）；`texture` = 纯纹理（只上漫反射贴图）。
   */
  setLightingMode(mode: LightingMode): void {
    if (getLightingMode() === mode) return;
    setLightingModeInShader(mode);
    console.info(`[lighting] 光照模式 → ${mode}（运行期 uniform 切换，未重建场景）`);
  }

  /** 读当前光照模式（诊断用；转发给 `apps/game/src/renderer/lightmap-shader.ts` 的 `getLightingMode`）。 */
  getLightingMode(): LightingMode {
    return getLightingMode();
  }

  /** 清零 GLB 根子节点的 rotation（有非零分量才写并立即刷新该子树的矩阵），最后整体更新 matrixWorld。
   *  在包围盒与分块计算之前调用，保证后面的世界变换基准一致。 */
  private resetRootRotations(gltf: GLTF): void {
    for (const child of gltf.scene.children) {
      if (child.rotation.x !== 0 || child.rotation.y !== 0 || child.rotation.z !== 0) {
        child.rotation.set(0, 0, 0);
        child.updateMatrixWorld();
      }
    }
    gltf.scene.updateMatrixWorld(true);
  }

  // ── 空间分块合并（loadScene 里挂载完 GLB 后执行一次）─────────────
  // 目的：把 GLTFLoader 逐 primitive 生成的数万个 Mesh 收敛成数百个空间块，降低每帧遍历与 draw call
  // 数量。载体是 BSP 场景根（`userData.isBspModel` 保持不变）：块 mesh 直接挂到它下面，原 GLB 子树移除。
  // 流程：
  // ① 更新世界矩阵 → traverse 收集单材质 Mesh（记下世界包围盒中心）；多材质 Mesh 烘焙到世界空间后
  //    整体保留、无材质 Mesh 原样跳过，两者都不参与分块；
  // ② cell 边长自适应：世界包围盒对角线 / cbrt(OPT_TARGET_CELLS)，再按非空 cell 数微调（最多 6 轮）；
  // ③ 按世界包围盒中心把 Mesh 分桶到 cell；
  // ④ 逐 cell 合并：单 Mesh 的 cell 保留原 Mesh（几何烘焙到世界空间、变换清零）；多 Mesh 的 cell
  //    先按材质实例分组子合并，再 mergeGeometries(useGroups = true) 合成一个 Mesh + 材质数组；
  //    合并失败的分支回退为保留各自独立几何；
  // ⑤ 替换场景内容，并给每块重算包围球后乘 FRUSTUM_PAD；
  // ⑥ 打印统计与「前向视锥可见块」估算（用 this.camera 与当前 FOV 粗估，仅诊断）。
  private optimizeScene(bspRoot: THREE.Scene, gltfScene: THREE.Object3D): void {
    // ① 收集：先刷新 matrixWorld 作为世界变换基准。多材质 mesh（GLB primitive 恒单材质，此处是
    //    防御路径）烘焙到世界空间后保留；无材质 mesh 原样跳过。两者都不参与分块
    bspRoot.updateMatrixWorld(true);
    const infos: OptMeshInfo[] = [];
    const keptMeshes: THREE.Mesh[] = [];
    const worldBox = new THREE.Box3();
    const box = new THREE.Box3();
    const center = new THREE.Vector3();
    bspRoot.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (!m.isMesh) return;
      if (!m.geometry || !m.geometry.attributes.position) return;
      if (Array.isArray(m.material) || !m.material) {
        // 多材质：烘焙到世界空间后整体保留（不参与分块合并）
        if (Array.isArray(m.material)) {
          const baked = m.geometry.clone();
          baked.applyMatrix4(m.matrixWorld);
          m.geometry.dispose();
          m.geometry = baked;
          m.position.set(0, 0, 0);
          m.rotation.set(0, 0, 0);
          m.scale.set(1, 1, 1);
          m.updateMatrix();
          keptMeshes.push(m);
        }
        return;
      }
      const g = m.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      if (!g.boundingBox) return;
      box.copy(g.boundingBox).applyMatrix4(m.matrixWorld);
      worldBox.union(box);
      box.getCenter(center);
      infos.push({ mesh: m, cx: center.x, cy: center.y, cz: center.z });
    });
    if (infos.length === 0) return;

    // ①b 合并失败不丢几何：`mergeGeometries` 在属性集不一致时返回 null，而本函数每一处失败分支
    //     都回退成「保留各自独立几何」，不存在"合并失败就丢弃"的路径。

    // ② cell 边长自适应：初值取世界包围盒对角线 / cbrt(目标块数)，随后按非空 cell 数缩放（收敛到
    //    OPT_MIN_CELLS..OPT_MAX_CELLS）
    const diag = Math.max(worldBox.getSize(new THREE.Vector3()).length(), 1);
    let cellSize = Math.min(Math.max(diag / Math.cbrt(OPT_TARGET_CELLS), OPT_CELL_MIN), OPT_CELL_MAX);
    for (let i = 0; i < 6; i++) {
      const n = optCountCells(infos, cellSize);
      if (n >= OPT_MIN_CELLS && n <= OPT_MAX_CELLS) break;
      const scale = Math.min(Math.max(Math.cbrt(n / OPT_TARGET_CELLS), 0.55), 1.8);
      cellSize = Math.min(Math.max(cellSize * scale, OPT_CELL_MIN), OPT_CELL_MAX);
    }

    // ③ 分桶：按每个 mesh 的世界包围盒中心归 cell（横跨多 cell 的归中心所在 cell）
    const cells = new Map<string, OptMeshInfo[]>();
    for (const it of infos) {
      const key = optCellKey(it.cx, it.cy, it.cz, cellSize);
      let arr = cells.get(key);
      if (!arr) {
        arr = [];
        cells.set(key, arr);
      }
      arr.push(it);
    }

    // ④ 合并 + 替换：单 mesh 的 cell 保留原 mesh（几何烘焙到世界空间、变换清零）；多 mesh 的 cell
    //    先按材质实例子合并，再 mergeGeometries(useGroups = true) 合成一个 Mesh + 材质数组
    //    （groups 与材质数组下标一一对应）
    const chunks: THREE.Mesh[] = [];
    let chunkCount = 0;
    let drawCallEst = 0;
    let vertsTotal = 0;
    for (const arr of cells.values()) {
      if (arr.length === 1) {
        const m = arr[0].mesh;
        const baked = m.geometry.clone();
        baked.applyMatrix4(m.matrixWorld);
        m.geometry.dispose();
        m.geometry = baked;
        m.position.set(0, 0, 0);
        m.rotation.set(0, 0, 0);
        m.scale.set(1, 1, 1);
        m.updateMatrix();
        chunks.push(m);
        chunkCount++;
        drawCallEst++;
        vertsTotal += baked.attributes.position.count;
        continue;
      }

      // 多 mesh cell：按材质实例分组，组内合并成一个几何（每组对应一个材质槽）
      const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
      for (const it of arr) {
        const m = it.mesh;
        const mat = m.material as THREE.Material;
        const baked = m.geometry.clone();
        baked.applyMatrix4(m.matrixWorld);
        let list = byMat.get(mat);
        if (!list) {
          list = [];
          byMat.set(mat, list);
        }
        list.push(baked);
      }
      const mergedGeoms: THREE.BufferGeometry[] = [];
      const mats: THREE.Material[] = [];
      for (const [mat, geoms] of byMat) {
        let merged: THREE.BufferGeometry[];
        if (geoms.length === 1) {
          merged = geoms;
        } else {
          const mg = mergeGeometries(geoms, false);
          if (mg) {
            for (const g of geoms) g.dispose();
            merged = [mg];
          } else {
            merged = geoms; // 属性不一致（防御分支）：保留各自独立几何
          }
        }
        for (const g of merged) {
          mergedGeoms.push(g);
          mats.push(mat);
        }
      }
      if (mergedGeoms.length === 0) {
        for (const it of arr) it.mesh.geometry.dispose();
        continue;
      }
      let chunk: THREE.Mesh;
      if (mergedGeoms.length === 1) {
        chunk = new THREE.Mesh(mergedGeoms[0], mats[0]);
        drawCallEst++;
      } else {
        const final = mergeGeometries(mergedGeoms, true);
        if (final) {
          for (const g of mergedGeoms) if (g !== final) g.dispose();
          chunk = new THREE.Mesh(final, mats);
          drawCallEst += final.groups.length;
        } else {
          // 最终合并失败（极端防御）：每个材质单独一块
          chunk = new THREE.Mesh(mergedGeoms[0], mats[0]);
          for (let i = 1; i < mergedGeoms.length; i++) {
            chunks.push(new THREE.Mesh(mergedGeoms[i], mats[i]));
            chunkCount++;
            drawCallEst++;
          }
        }
      }
      for (const it of arr) it.mesh.geometry.dispose();
      chunkCount++;
      for (const g of mergedGeoms) vertsTotal += g.attributes.position.count;
      chunks.push(chunk);
    }

    // ④b 替换：块 mesh 与保留 mesh 直接挂到 BSP 根（`add` 会自动让它们脱离原父节点），随后移除原
    //     GLB 子树（旧几何已在上面逐个 dispose）。`bspRoot.userData.isBspModel` 保持不变——
    //     disposeScene 与 updateNearPlane 都依赖它
    const totalMeshes = infos.length;
    for (const m of chunks) bspRoot.add(m);
    for (const m of keptMeshes) bspRoot.add(m);
    bspRoot.remove(gltfScene);

    // ④c 视锥外保留一圈：给每块的包围球半径乘 FRUSTUM_PAD。必须无条件重算包围球（不能只判 null）：
    //    烘焙路径是 geometry.clone() + applyMatrix4(matrixWorld)，克隆会带上 GLB 局部空间的旧球
    //    （非 null，不重算就会被当成有效值）⇒ 剔除按错误位置判定、眼前的块被误剔。顶点已烘焙到世界
    //    空间，重算才是对的。只影响剔除判定，不改几何与包围盒
    for (const child of bspRoot.children) {
      const g = (child as THREE.Mesh).geometry;
      if (!g) continue;
      g.computeBoundingSphere();
      (g.boundingSphere as THREE.Sphere).radius *= FRUSTUM_PAD;
    }

    // ⑤ 统计 + 前向视锥可见块估算（块中心与相机方向的点积粗估，FOV 取 config.hud.fov）
    const chunkBox = new THREE.Box3();
    const chunkCenter = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    let visibleEst = -1;
    const camera = this.camera;
    if (camera) {
      camera.updateMatrixWorld(true);
      const camDir = new THREE.Vector3();
      camera.getWorldDirection(camDir);
      const cosHalfFov = Math.cos(((this.config?.hud?.fov ?? FOV_DEFAULT) / 2) * DEG2RAD);
      visibleEst = 0;
      for (const child of bspRoot.children) {
        const mesh = child as THREE.Mesh;
        chunkBox.setFromObject(mesh);
        if (chunkBox.isEmpty()) continue;
        chunkBox.getCenter(chunkCenter);
        toCam.subVectors(chunkCenter, camera.position);
        const dist = toCam.length();
        if (dist < camera.far && toCam.dot(camDir) / dist > cosHalfFov) visibleEst++;
      }
    }
    console.log(
      `[optimizeScene] 分块合并: ${totalMeshes} mesh → ${chunkCount} 块` +
        `（cellSize=${cellSize.toFixed(1)}、非空 cell=${cells.size}）| ` +
        `平均顶点/块 ${(vertsTotal / Math.max(chunkCount, 1)).toFixed(0)}（总顶点 ${vertsTotal}）| ` +
        `draw call 估算 ${drawCallEst} | ` +
        `前向视锥可见块估算 ${visibleEst >= 0 ? `${visibleEst}/${chunkCount}` : 'N/A（camera 未就绪）'}`,
    );
  }

  // ── 出帧探针（验证仪器；只往 globalThis 挂一个对象，不参与渲染逻辑）──────────────────
  /**
   * 安装 `globalThis.__vbspFrameProbe`：给外部自动化脚本提供「确定性相机位姿」与「lightmap 运行时
   * 状态」的读取口。
   *
   * 用途：A/B 出帧对比要求同一相机位姿可复现。相机在 `tick` 里被钉在主线程物理状态上，只靠 spawn
   * 默认朝向时视野里大量是天空与远景，地图表面占比不可控。本探针用 `setHoldPoint`（生产路径里的
   * 「按住 C 读点」机制：`tick` 每帧把物理写回该位姿）把相机确定性地锁住。
   *
   * 生产路径零影响：只有显式调用 `applyPose` 才会冻结；正常游玩不触发。
   */
  installFrameProbe(): void {
    const self = this;
    const probe = {
      /** 物理、场景与相机是否都已就绪（脚本据此判断探针可用时机）。 */
      get ready(): boolean {
        return self.predReady && self.scene !== null && self.camera !== null;
      },
      /** 当前相机的世界位姿（截图可复现性的直接证据；角度已从弧度换回度）。 */
      cameraPose(): {
        pos: [number, number, number];
        yawDeg: number;
        pitchDeg: number;
        fov: number;
        near: number;
        far: number;
      } | null {
        const cam = self.camera;
        if (!cam) return null;
        return {
          pos: [cam.position.x, cam.position.y, cam.position.z],
          yawDeg: +(cam.rotation.y / DEG2RAD).toFixed(4),
          pitchDeg: +(cam.rotation.x / DEG2RAD).toFixed(4),
          fov: cam.fov,
          near: cam.near,
          far: cam.far,
        };
      },
      /** lightmap 施加结果的运行时快照（材质级统计，不做日志推断）。 */
      lightmapState(): {
        meshes: number;
        withLightMapSlot: number;
        withUv2: number;
        uv1Only: number;
        uv2Only: number;
        bothUv: number;
        neitherUv: number;
        hasLightmapTrue: number;
        hasLightmapFalse: number;
        hasLightmapMissing: number;
        atlasName: string | null;
        atlasSize: [number, number] | null;
        lightMapChannels: number[];
        injectedMaterials: number;
        atlasSizeUniformBound: number;
      } | null {
        if (!self.scene) return null;
        let meshes = 0;
        let withLightMapSlot = 0;
        let withUv2 = 0;
        let injectedMaterials = 0;
        let atlasSizeUniformBound = 0;
        let atlasName: string | null = null;
        let atlasSize: [number, number] | null = null;
        let lightMapChannels: number[] = [];
        let uv1Only = 0;
        let uv2Only = 0;
        let bothUv = 0;
        let neitherUv = 0;
        let hasLightmapFalse = 0;
        let hasLightmapTrue = 0;
        let hasLightmapMissing = 0;
        self.scene.traverse((obj) => {
          const m = obj as THREE.Mesh;
          if (!m.isMesh) return;
          meshes++;
          const g1 = !!m.geometry?.getAttribute('uv1');
          const g2 = !!m.geometry?.getAttribute('uv2');
          if (g2) withUv2++;
          if (g1 && g2) bothUv++;
          else if (g1) uv1Only++;
          else if (g2) uv2Only++;
          else neitherUv++;
          // 与 applyLightmapToMeshes 同口径：primitive 的 extras 落在 geometry.userData
          // （GLTFLoader 的 assignExtrasToUserData 写进 geometry），故 geometry 优先于 mesh
          const hlGeom = (m.geometry?.userData as { hasLightmap?: unknown } | undefined)?.hasLightmap;
          const hlMesh = (m.userData as { hasLightmap?: unknown }).hasLightmap;
          const hl = hlGeom !== undefined ? hlGeom : hlMesh;
          if (hl === false) hasLightmapFalse++;
          else if (hl === true) hasLightmapTrue++;
          else hasLightmapMissing++;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats) {
            if (!mat) continue;
            const lm = (mat as unknown as { lightMap?: THREE.Texture | null }).lightMap;
            if (!lm) continue;
            withLightMapSlot++;
            const ch = (lm as unknown as { channel?: number }).channel;
            if (typeof ch === 'number' && !lightMapChannels.includes(ch)) lightMapChannels.push(ch);
            if (!atlasName) {
              atlasName = lm.name ?? null;
              const img = lm.image as { width?: number; height?: number } | undefined;
              if (img?.width && img?.height) atlasSize = [img.width, img.height];
            }
            // 注入标记：injectLightmapShader 在 onBeforeCompile 里留下的痕迹
            if ((mat as unknown as { __vbspLightmapInjected?: boolean }).__vbspLightmapInjected) {
              injectedMaterials++;
            }
            if (
              (mat as unknown as { __vbspLightmapUniformBound?: boolean }).__vbspLightmapUniformBound
            ) {
              atlasSizeUniformBound++;
            }
          }
        });
        return {
          meshes,
          withLightMapSlot,
          withUv2,
          uv1Only,
          uv2Only,
          bothUv,
          neitherUv,
          hasLightmapTrue,
          hasLightmapFalse,
          hasLightmapMissing,
          atlasName,
          atlasSize,
          lightMapChannels,
          injectedMaterials,
          atlasSizeUniformBound,
        };
      },
      /**
       * 直读前 3 个 ambient 注入材质的 cube 值（mesh 或父节点 userData）与注入记录。
       * 「cube 取值是否真的影响画面」这类定位用的仪器。
       */
      ambientProbe(): unknown {
        if (!self.scene) return { count: 0, samples: [], note: 'no scene' };
        const found: unknown[] = [];
        const seen = new Set<THREE.Material>();
        self.scene.traverse((obj) => {
          const m = obj as THREE.Mesh;
          if (!m.isMesh || found.length >= 3) return;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats) {
            if (seen.has(mat)) continue;
            const inject = (
              mat as unknown as { __vbspAmbientInject?: unknown }
            ).__vbspAmbientInject;
            if (!inject) continue;
            seen.add(mat);
            const own = (m.userData as { ambientCube?: number[] }).ambientCube ?? [];
            const parent = (m.parent?.userData as { ambientCube?: number[] }).ambientCube ?? [];
            const cube = own.length ? own : parent;
            found.push({
              cubeHead: cube.slice(0, 6).map((v) => +(+v).toFixed(6)),
              ownLen: own.length,
              parentLen: parent.length,
              inject,
            });
            break;
          }
        });
        return { count: found.length, samples: found };
      },
      /**
       * 应用确定性位姿并冻结物理（冻结机制见本方法上方说明）。
       * `spawn`：回出生点并保持出生朝向；
       * `surface`：回出生点后把 pitch 压到 -35°（俯视地表，能直接看出 lightmap 是否参与画面），
       * 再用 `setHoldPoint` 冻结；其余取值返回失败原因。
       */
      async applyPose(
        preset: string,
      ): Promise<{ ok: boolean; why?: string; preset?: string; pose?: unknown }> {
        if (!self.predPhys || !self.scene) return { ok: false, why: '场景/物理未就绪' };
        if (preset === 'spawn') {
          self.holdPoint = null;
          self.predPhys.respawn();
          await new Promise((r) => setTimeout(r, 400));
          return { ok: true, preset, pose: probe.cameraPose() };
        }
        if (preset !== 'surface') return { ok: false, why: `未知位姿预设：${preset}` };

        // 先回出生点，再把 pitch 压到 -35°（俯视地表）
        self.holdPoint = null;
        self.predPhys.respawn();
        await new Promise((r) => setTimeout(r, 400));
        const st = self.predPhys.state() as {
          posX: number; posY: number; posZ: number;
          yaw: number; eyeHeight: number;
        };
        const PITCH_DEG = -35;
        const freeze = {
          x: st.posX,
          y: st.posY,
          z: st.posZ,
          yaw: st.yaw,
          pitch: PITCH_DEG,
          onGround: true,
        };
        // setHoldPoint 是生产路径里的机制（按住 C 读点）：tick 每帧覆盖位姿并把速度归零 ⇒
        // 相机被确定性地锁在该位姿
        self.setHoldPoint(freeze);
        await new Promise((r) => setTimeout(r, 600));
        return { ok: true, preset, pose: probe.cameraPose() };
      },
      /** 解除冻结（脚本收尾用）。 */
      release(): void {
        self.holdPoint = null;
      },

      /**
       * 「假亮」判别器：把所有 lightMap 纹理的 image 换成同色常量图。
       *
       * 用途：若画面亮度随之变得均匀（方差塌缩）⇒ 明暗来自 lightmap 采样；若画面几乎不变 ⇒ 明暗来自
       * 贴图与几何，lightmap 未真正参与。纯验证手段，不参与生产逻辑。
       */
      replaceAtlasWithConstant(r: number, g: number, b: number): { replaced: number } {
        if (!self.scene) return { replaced: 0 };
        let replaced = 0;
        const seen = new Set<THREE.Texture>();
        self.scene.traverse((obj) => {
          const m = obj as THREE.Mesh;
          if (!m.isMesh) return;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats) {
            if (!mat) continue;
            const lm = (mat as unknown as { lightMap?: THREE.Texture | null }).lightMap;
            if (!lm || seen.has(lm)) continue;
            seen.add(lm);
            const w = (lm.image as { width?: number } | undefined)?.width ?? 4;
            const h = (lm.image as { height?: number } | undefined)?.height ?? 4;
            const buf = new Uint8Array(w * h * 4);
            for (let i = 0; i < w * h; i++) {
              buf[i * 4] = r;
              buf[i * 4 + 1] = g;
              buf[i * 4 + 2] = b;
              buf[i * 4 + 3] = 128; // α=128：解码端 exp = 128*255/255−128 = 0 ⇒ 亮度倍数 2^0 = 1
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              const img = ctx.createImageData(w, h);
              img.data.set(buf);
              ctx.putImageData(img, 0, 0);
            }
            lm.dispose();
            lm.image = canvas;
            lm.needsUpdate = true;
            replaced++;
          }
        });
        return { replaced };
      },
    };
    (globalThis as unknown as { __vbspFrameProbe?: unknown }).__vbspFrameProbe = probe;
  }
}
