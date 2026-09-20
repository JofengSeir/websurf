/**
 * 主线程渲染器（最小化版）— 客户端预测渲染。
 *
 * 架构（2026-08-07 v4.1）：
 * - 主线程持 wasm `PhysWorld` 预测实例：每 rAF 调 `tick(dt, keys, dx, dy)`
 *   做**真实物理模拟**（移动语义 + 碰撞），渲染预测结果（输入零延迟）
 * - Worker-A 权威物理每帧写全状态到 SAB → 主线程 `set_state` 修正预测基线
 *   （标准客户端预测：本地模拟即时响应，权威定期纠偏）
 * - respawn/teleport 位置突变：player-respawn 事件 → set_state 归零
 * - 无 lightmap/雾/碰撞可视化/准星射线。
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

/** FOV 默认值（73.6；面板 hud.fov 可调，60-110）。 */
const FOV_DEFAULT = 73.6;
const DEG2RAD = Math.PI / 180;

/**
 * 渲染采样传输契约（实现 = `src/ts-shared/auth/shared-state.ts` 的 ShmState/MsgState，
 * 两者同签名；本文件直接调 `this.shared.*`，由 typecheck 保证契约一致）：
 * ```ts
 * writeRenderSample(tMs, x, y, z, i0, epoch): void; // 与渲染帧同拍同源
 * resetRenderSample(): void;                         // 失效世代 +1（Worker 丢弃缓存）
 * readPublishedTau(): number;                        // 最近一次权威发布所用的渲染时钟 τ（ms；0=未发布）
 * ```
 * R1：写侧只有 5 个 f64 载荷 store + 一对 seqlock 原子戳（既有 i64 槽），
 * **无分配对象、无同步等待**（不阻塞渲染帧）。
 */

// ── 空间分块合并参数（optimizeScene：GLB 挂载后渲染减负）──────────
// surf_666 GLB：117 meshes / 34409 primitives / 377385 顶点——GLTFLoader 每个 primitive
// 生成一个 THREE.Mesh → 场景 ~3.4 万 Mesh 对象：每帧 three.js 遍历 3.4 万对象做剔除 +
// 可见 mesh 逐个 draw call → 渲染耗时接近 vsync 帧间隔（120Hz=8.3ms）→ 合成器错过取帧 →
// 视觉帧率减半。分块合并把 3.4 万对象 → ~300~800 空间块（块内按材质子合并，draw call =
// 材质数而非 mesh 数）→ 渲染耗时 < 5ms。逻辑移植自 test/dual-mode-harness/src/worker-b.ts optimizeScene
// （已验证 34409 mesh → 300~800 块），主线程差异见方法注释。
/** 目标 cell 数（cell 大小 = 世界包围盒对角线 / cbrt(目标块数)，自适应微调区间 [300,800]）。 */
const OPT_TARGET_CELLS = 512;
/** 非空 cell 数目标下限/上限（自适应微调）。 */
const OPT_MIN_CELLS = 300;
const OPT_MAX_CELLS = 800;
/** cell 大小钳制（world units；surf_666 世界 ~16320 → cell ≈ 512~1024 数量级）。 */
const OPT_CELL_MIN = 128;
const OPT_CELL_MAX = 4096;
/**
 * 视锥外保留圈（frustum culling 包围球膨胀系数）：three.js 每帧按 geometry.boundingSphere
 * 判定剔除——半径 ×FRUSTUM_PAD 后，视锥外约 (FRUSTUM_PAD-1)×半径 的块仍渲染（疯狂晃动/快速
 * 转动时，新进入视锥的几何上一帧已预渲染 → 边缘不空白；块包围球大者膨胀量自然大，覆盖一帧
 * 相机移动量）。同 test worker-b FRUSTUM_PAD。
 */
const FRUSTUM_PAD = 1.6;

/** 分块收集的 mesh + 世界包围盒中心（分块键用；同 worker-b OptMeshInfo）。 */
interface OptMeshInfo {
  mesh: THREE.Mesh;
  cx: number;
  cy: number;
  cz: number;
}

/** cell 键：世界坐标 / cellSize 取整（字符串键；一次性分桶，无性能要求）。 */
function optCellKey(x: number, y: number, z: number, cellSize: number): string {
  return Math.floor(x / cellSize) + '|' + Math.floor(y / cellSize) + '|' + Math.floor(z / cellSize);
}

/** 非空 cell 计数（cell 大小自适应循环用）。 */
function optCountCells(infos: OptMeshInfo[], cellSize: number): number {
  const keys = new Set<string>();
  for (const it of infos) keys.add(optCellKey(it.cx, it.cy, it.cz, cellSize));
  return keys.size;
}

/** LOD 级别。 */
const LOD_NEAR = 0;
const LOD_FAR = 2;
const LOD_PVS_HIDDEN = -1;
/**
 * PVS 剔除开关：**当前禁用**（实证 surf_666 PVS 数据不可用：8269 cluster 平均可见率
 * 仅 1.6%（中位 1.3%、最大 5.1%）、spawn 点 cluster=-1——开放 surf 图 BSP leaf/PVS
 * 划分失效，可见集几乎为空 → 相邻区域被错误全剔（"必须穿过连接处才能看到"）+ 晃动
 * 穿越 cluster 边界时边缘消失）。分块合并后渲染量已由视锥剔除（FRUSTUM_PAD 膨胀）+ 
 * 距离 LOD（cullDistance）控制，PVS 为负收益。PVS 数据修复后可置 true 恢复。
 */
const ENABLE_PVS = false;

export class RendererMain {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private pvsManager: PvsManager | null = null;
  /** 运行时配置（init 时注入；纹理画质等渲染侧配置读取）。 */
  private config!: RuntimeConfig;

  private rafId = 0;
  private running = false;

  // ── 主线程唯一物理线 ───────────────────────────────────────
  /** 主线程 PhysWorld 实例（唯一物理：完整世界+碰撞+输入；每帧 tick 推进并渲染）。 */
  private predPhys: PhysWorld | null = null;
  /** 主线程物理就绪（world-json 构建完成）。 */
  private predReady = false;
  /** 按住 C 读点冻结目标（非空 = 冻结中：每帧强制 set_state 位置/朝向、速度 0）。 */
  private holdPoint: {
    x: number; y: number; z: number;
    yaw: number; pitch: number;
    onGround: boolean;
  } | null = null;
  /** 待喂给物理实例的输入（app 事件回调累积）。 */
  private pendingDx = 0;
  private pendingDy = 0;
  private pendingKeys = 0;
  /** 权威校准（公共化：correctFromAuthority 三条件 OR + 250ms 冷却 + syncInFlight
   * 回滚、calibrateVelocity 外推、applyCollisionCorrection、resetTo 收敛到
   * ts-shared AuthorityCalibrator）。 */
  private readonly calibrator: AuthorityCalibrator;
  /** 渲染帧推进（dt 上限防异常）。 */
  private lastTickMs = 0;

  // ── 渲染采样传输（Worker 权威发布位置 = 渲染轨迹上的一个采样点）──────
  // 契约见文件头（writeRenderSample / resetRenderSample / readPublishedTau）。
  /** 渲染采样序号（单调递增；与渲染帧同拍同源，供 Worker 标注"第几个采样点"）。
   *  仅在 resetSampleStream()（失效世代 +1，索引空间重启）时归零。 */
  private renderSampleIndex = 0;
  /**
   * 采样流**失效世代**（渲染器侧本地计数器）：resetTo（respawn/传送/检查点回退）/
   * loadSavepoint / 换图（buildPredictionWorld、disposeScene）/ noclip 切换时 +1，
   * 并同时调用 `shared.resetRenderSample()` 让 Worker 丢弃旧代缓存（缓存里的渲染采样
   * 对新位置毫无意义，继续投影会把权威位置钉在旧轨迹上）。
   *
   * ⚠️ **不再随 `writeRenderSample` 过线**（缺陷修复 · epoch 竞态）：权威世代槽由
   * `shared-state.ts` 独占并自持，写入时就地读槽内值。此前渲染器把这份缓存当参数传
   * 过去，任何在途/延迟的写入都会把 `resetRenderSample()` 刚自增的世代**写回旧值**，
   * Worker 便继续在旧世界样本对上插值（详见 shared-state.ts 同名方法注释）。
   */
  private sampleEpoch = 0;
  /** mesh → { center, radius, clusterIds }（LOD/PVS 用；clusterIds 空间采样分配）。 */
  private lodItems: Array<{ mesh: THREE.Mesh; center: THREE.Vector3; radius: number; clusterIds: number[] }> = [];
  /** 剔除距离（场景加载后校准；0 配置 = 用 autoCullDistance）。 */
  private cullDistance = 12800;
  /** 自动剔除距离 = 地图包围盒对角线 × 0.5（`renderDistance: 0` 时生效）。 */
  private autoCullDistance = 12800;

  /**
   * 待执行的注入生效性统计（首帧渲染后跑一次）。
   *
   * 为什么延后：`applyLightmap` 在建场景时调用，此时 three **尚未编译材质** ⇒
   * `onBeforeCompile` 未触发 ⇒ 统计必然得 0 ⇒ 误报"没有任何一个注入生效"。
   * 必须在第一帧 `renderer.render()` 之后统计（材质已编译、记录已回填）。
   */
  private pendingInjectReport = false;
  /** 注入生效性统计是否已跑（幂等保护）。 */
  private injectReported = false;

  // ── 纹理画质切换（mosaic）──────────────────────────────────
  /** 画质 manifest：{ 纹理名(小写 basetexture): mosaic 字节码 }。 */
  private mosaicManifest: Record<string, string> | null = null;
  /** 原始贴图图像缓存（切换回 original 时恢复）。 */
  private readonly origTextureImages = new Map<THREE.Texture, unknown>();

  // ── 近平面贴墙自适应（防贴墙透视；同步自主项目 renderer-main）─────────
  /** 近平面收缩探测距离默认（HU）：相机距墙最小距离 = 碰撞箱半宽 16，射线必须
   * 能覆盖该距离才能探测到面前的墙——原固定 near=maxDim/1000（大地图 50+）
   * 贴墙时墙被近平面裁剪 → 透视看到地图外面。
   * 48 = 3×最小贴墙距离：配合 4 个水平探测方向（前/后/左/右），贴墙角度下
   * 最近方向与墙面夹角足够小时斜距 ≤ 16/sinθ，垂直墙主要角度可探测。 */
  private static readonly NEAR_PROBE_DIST_DEFAULT = 100;
  private static readonly CAMERA_NEAR_MIN = 0.05;
  /** near 收缩系数默认：near = 最近几何距离 × 此值。 */
  private static readonly NEAR_RATIO_DEFAULT = 0.3;
  /** 探测距离（HU）；↑ 更斜掠射也能命中，粗筛候选略增。面板可实时调。 */
  private nearProbeDist = RendererMain.NEAR_PROBE_DIST_DEFAULT;
  /** near 收缩系数；↓ 更保守更不易裁墙。面板可实时调。 */
  private nearRatio = RendererMain.NEAR_RATIO_DEFAULT;
  private defaultNear = 0.1;
  private nearCheckToggle = false;
  private readonly _nearOrigin = new THREE.Vector3();
  private readonly _nearSphere = new THREE.Sphere();
  private readonly _nearDirF = new THREE.Vector3();
  private readonly _nearDirR = new THREE.Vector3();
  private readonly _nearRaycaster = new THREE.Raycaster();


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

  onSceneLoaded: ((deathThresholdY: number) => void) | null = null;

  /** 失效世代 +1 + 通知 Worker 丢弃缓存（两者必须成对，见 sampleEpoch 注释）。 */
  private bumpSampleEpoch(): void {
    this.sampleEpoch++;
    this.shared.resetRenderSample();
  }

  /** 采样索引空间重启（序号归零**必须**配失效世代 +1，否则新 i0 会与旧代同号项混淆）。 */
  private resetSampleStream(): void {
    this.renderSampleIndex = 0;
    this.bumpSampleEpoch();
  }

  /**
   * 渲染主线 → 权威同步回调（兜底/常规重锚触发时携带渲染主线帧完整状态；app.ts
   * 注册后发 `sync-render-state` 消息给 Worker 权威物理）。
   *
   * @param teleport true = 真位置突变（Worker 清未消费输入增量）；
   *   false = 常规反向重锚（缺陷修复 A，Worker **保留**输入增量）。
   */
  onSyncRenderState: ((s: {
    posX: number; posY: number; posZ: number;
    yaw: number; pitch: number;
    velX: number; velY: number; velZ: number;
    onGround: boolean;
    eyeHeight: number;
  }, teleport: boolean) => void) | null = null;

  init(canvas: HTMLCanvasElement, width: number, height: number, dpr: number, config: RuntimeConfig): void {
    this.config = config;
    // 光照模式（面板「预烘焙 / 纯纹理」）：**运行期性能旋钮**，只是共享 uniform 的初值。
    // 两种模式加载路径完全一致（同一批注入材质 + 同一张 atlas）⇒ 这里早设只是让首帧就是所选模式。
    setLightingModeInShader(config.lighting?.mode ?? 'baked');
    // 曝光（显示侧亮度）：默认 1.0 = 忠于 BSP 烘焙数据；config 值来自面板持久化。
    setExposure(config.lighting?.exposure ?? 1);
    // 光照项 gamma（shadow-lift）：0.85 = 对齐外部参照实现的 γ2.2 域乘算口径。
    setLightGamma(config.lighting?.lightGamma ?? 0.5);
    // 模型（prop）烘焙光照亮度：ambient cube 路径的独立档位（不动 world lightmap）
    setAmbientScale(config.lighting?.ambientScale ?? 1.5);
    // 第 1 级逐顶点光照的**重建平滑**次数（0 = 原样烘焙值；见 config 里的推导与实测）
    setPropVertexRelax(config.lighting?.propVertexRelax ?? 1);
    setPropVertexFlatten(config.lighting?.propVertexFlatten ?? 0.85);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      this.config?.hud?.fov ?? FOV_DEFAULT,
      width / Math.max(height, 1),
      0.1,
      100000,
    );
    this.camera.position.set(0, 100, 0);

    // 前烘焙时代的固定三点光（替代原 LightManager 的遗产）已按外部参照实现口径**停用**
    // （gamma-parity 计划 §3.1b）：它们只影响无 lightmap 的 Standard 图元（平涂提亮，
    // 亮度语义错误）；无 lightmap 面的外部参照实现口径是 fullbright 贴图原色
    // （white texture 兜底），由 applyLightmapToMeshes 的 fullbright 统一路径承担。
    // 需要临时恢复对比时置 true（勿以开启态入库）。
    // 实验记录（2026-09-19）：临时置 true 出帧对比——surf_666 spawn 均值 19.425 vs
    // 关闭态 19.424（直方图逐桶一致）⇒ **加灯零效果**已实测证实（材质全为 MeshBasic）。
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

  /** 加载 Worker 传来的场景（GLB + spawn + pvs）。 */
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
    //     数据面：GLB 携带全部 light/light_spot/light_environment（surf_666=2118 盏、
    //     surf_null=3067 盏）。渲染面：**不施加**（§3.3 唯一取舍）——烘焙 lightmap 已含这些
    //     实体的贡献（VRAD），运行时再打就是重复计光；外部参照实现参照口径也是纯烘焙乘算。
    //
    //     ⚠️ 两处都必须对，缺一个就是**整批几何不渲染**（2026-09-20 真实出帧铁证）：
    //       (1) **位置**：必须在 `this.scene.add(scene)` **之前**做完。rAF 渲染循环此刻已在跑，
    //           若先挂进场景再中和，中间那一帧就会带着 2000+ 盏灯去编译材质 ⇒ 控制台刷屏
    //           `FRAGMENT shader uniforms count exceeds MAX_FRAGMENT_UNIFORM_VECTORS(1024)`
    //           + 数百条 `drawArrays: no valid shader program in use`（实测 +149.29s 一波）。
    //       (2) **手段**：`removeFromParent()` 真正摘掉。只置 `visible = false` 虽也能让 three
    //           跳过灯光收集（`three.module.js:29584`：`if ( object.visible === false ) return;`），
    //           但 2000+ 个节点仍留在场景树里被反复 traverse，且任何一处未来把它置回 true
    //           就会立刻炸掉全部受光材质的 program。摘掉才把这个不变量变成**结构性**的。
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

    this.scene.add(scene);

    // 1.2 离线烘焙静态光照（lightmap atlas，阶段 3）：**必须**在 optimizeScene 之前施加。
    //     理由与 apps/debug/src/renderer/renderer-main.ts:514-515 一致：lightmap 按原 mesh 的
    //     材质/UV 施加，分块合并时材质实例被去重保留、映射关系不丢；放到合并之后就丢了。
    await this.applyLightmap(scene, gltf);

    // 1.3 （原「中和 punctual 光源」块已上移为 §1.1 —— 必须在挂进 this.scene **之前**做完，
    //      否则 rAF 会带着 2000+ 盏灯编译一帧材质，program 超限后该批 mesh 不再渲染。）

    // 1.5 空间分块合并（GLB 挂载后、PVS/LOD 注册前）：3.4 万 mesh → ~300~800 空间块。
    //    必须在下方 traverse（lodItems 收集 + clusterIds 分配 = lodManager.setup/
    //    assignClusterIds 的主线程等价物）之前执行——setup 收集分块后的块 mesh。
    this.optimizeScene(scene, gltf.scene);

    // 1.55 装配后终扫：把仍带**受光材质**的 mesh（GLTFLoader 给 prop/派生网格的
    //      `MeshStandardMaterial`）收敛到 fullbright。本工程刻意不加任何灯（§3.3 唯一取舍）
    //      ⇒ 受光材质只剩 emissive=[0,0,0]，恒渲染纯黑（实测 surf_666 有 122 个图元：
    //      47 个 `extras.unlit=true` 的自发光霓虹 prop + 75 个水系/线框/派生网格）。
    //      必须在 optimizeScene 之后（合并会重建 mesh/材质数组），compile 之前（避免白编译受光程序）。
    const converged = fullbrightUnlitLitMaterials(this.scene);
    if (converged > 0) {
      console.info(
        `[lightmap] 装配后终扫：${converged} 个 mesh 仍为受光材质 ⇒ 收敛为 fullbright 贴图原色` +
          '（本工程不加灯，受光材质恒黑；unlit 图元不吃 ambient cube）',
      );
    }

    // 1.6 预编译着色器程序：把「首次可见才编译」的卡顿挪到加载期。
    //     背景：主线程 tick 的 dt 被 clamp 到 0.1s（`tick()` :832）⇒ 任何 >100ms 的
    //     主线程卡顿都会让主线程预测物理表现为「慢动作」（传送点首次进入新区域最明显）。
    //     失败不致命（three 仍会按需编译），故 try/catch + 计时日志。
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
      // clusterIds：空间采样分配（与主项目 lodManager.assignClusterIds 同法；
      // 不依赖 GLB extras.faceIndex——WASM 导出未写入该字段，原 getFaceCluster 恒 -1）
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

    // 4. 视距剔除距离：自动值 = 对角线 × 0.5；config.hud.renderDistance > 0 时覆盖
    //    （面板「渲染距离」滑块；0 = 自动，保持改造前行为）
    this.autoCullDistance = Math.max(maxDim * 0.5, 1000);
    const cfgRenderDistance = this.config?.hud?.renderDistance ?? 0;
    this.cullDistance = cfgRenderDistance > 0 ? cfgRenderDistance : this.autoCullDistance;


    // 5. 回传死亡阈值（场景最低 Y - 1000）
    this.onSceneLoaded?.(bbox.min.y);

    // 6. 纹理画质 manifest + 按当前画质应用（mosaic 切换数据源）
    this.mosaicManifest = data.mosaicManifest
      ? (JSON.parse(data.mosaicManifest) as Record<string, string>)
      : null;
    void this.applyTextureQuality(this.config.texture.quality);
  }

  // ── 纹理画质切换（原始 / mosaic 压缩低清）────────────────────

  /**
   * 按画质档位替换场景全部贴图：mini = mosaic 字节码还原低清 PNG；
   * original = 恢复缓存的原图。即时生效（替换 texture.image），无需重载地图。
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
          map.dispose(); // 尺寸可能变化（512 低清 → 原始），强制重建 GPU 纹理
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

  /** 单个贴图：mosaic 字节码 → 低清 PNG → ImageBitmap 替换 image。
   * 替换前必须 dispose()：three.js r152+ 对同一 texture 的 image 替换走增量
   * glTexSubImage2D——新 image 尺寸与原 GPU 纹理不符会 GL_INVALID_VALUE 越界、
   * 上传失败（纹理保持旧内容）。dispose 后重建 GPU 纹理（按新尺寸分配）。 */
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

  start(): void {
    if (this.running) return;
    this.running = true;
    this.rafId = requestAnimationFrame(this.boundTick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

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
    // 换图：注入生效性统计需对新场景重跑（否则第二张图不再报告注入状态）
    this.pendingInjectReport = false;
    this.injectReported = false;
    // 权威帧校准状态清零（防跨地图残留权威帧注入新地图）
    this.calibrator.clear();
    // 换图：渲染采样流不连续 → 索引空间重启（代数 +1，Worker 丢弃旧图缓存）
    this.resetSampleStream();
  }

  /**
   * 近平面自适应（同步自主项目）：检测相机 4 方向（相机局部系，4 水平正交）
   * NEAR_PROBE_DIST 内最近的 mesh，动态设置 camera.near。
   * - 贴墙 → near = max(最近距离 × 0.8, CAMERA_NEAR_MIN)，墙面不被裁剪
   * - 空旷 → 恢复场景默认
   * 性能：包围球粗筛候选后做 6 方向 raycaster，每 2 帧一次。
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

  /** 实时调整近平面自适应参数（面板调用；下一帧探测即生效）。 */
  setNearParams(probeDist?: number, ratio?: number): void {
    if (probeDist !== undefined && probeDist > 0) {
      this.nearProbeDist = probeDist;
    }
    if (ratio !== undefined && ratio > 0 && ratio <= 1) {
      this.nearRatio = ratio;
    }
  }

  /** 设置视野角 FOV（度，面板调用；相机透视矩阵即时更新）。 */
  setFov(fov: number): void {
    if (!this.camera) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 设置全局曝光（显示侧亮度倍率，面板调用；world lightmap 与 prop ambient 共用）。
   * 共享 uniform ⇒ 立即生效，不触发材质重编译。1.0 = 忠于 BSP 数据。
   */
  setExposure(value: number): void {
    setExposure(value);
  }

  /**
   * 设置光照项 gamma（shadow-lift）。1.0 = 不修正；0.85 = 对齐外部参照实现 γ2.2 口径。
   * 与曝光不同：只抬暗部，亮部不受影响 ⇒ 不会削顶。共享 uniform ⇒ 立即生效。
   */
  setLightGamma(value: number): void {
    setLightGamma(value);
  }

  /**
   * 设置模型（prop）烘焙光照亮度倍率（ambient cube 路径专用）。
   * 1.0 = 忠于数据；0 = 模型全黑；>1 提亮模型。共享 uniform ⇒ 立即生效。
   */
  setAmbientScale(value: number): void {
    setAmbientScale(value);
  }

  // ── 主线程唯一物理线 ───────────────────────────────────────

  /** 主线程初始化 wasm（PhysWorld 模块）。dist 内嵌模式传 wasmB64（file:// 无法 fetch）。
   * 注意：用 initSync({module})——async init() 解构 {module_or_path}，传 {module} 会
   * 解构出 undefined 走 new URL(import.meta.url) 路径（dist 下 import.meta.url 被
   * define 为 about:blank → "Failed to construct 'URL'"，dev 下多余一次 fetch）。 */
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

  /** world-json 到达：主线程构建 PhysWorld（唯一物理：世界+碰撞+输入+渲染）。 */
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
    // 新世界：渲染采样流不连续 → 索引空间重启（代数 +1，Worker 丢弃旧世界缓存）
    this.resetSampleStream();
  }

  /** 物理实例输入（app 事件回调喂入；唯一输入通道）。 */
  feedInput(dx: number, dy: number, keysMask: number): void {
    this.pendingDx += dx;
    this.pendingDy += dy;
    this.pendingKeys = keysMask;
  }

  /** 清空待喂输入（Pointer Lock 退锁/重锁时调用，防残留输入污染）。 */
  clearPendingInput(): void {
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
  }

  /** 重生（面板/按键；主线程物理直接 respawn，不经 Worker）。 */
  respawn(): void {
    this.predPhys?.respawn();
    // 位置突变：失效代数 +1（Worker 丢弃旧位置缓存）
    this.bumpSampleEpoch();
  }

  /** 传送至指定出生点索引（面板 spawn 下拉）。 */
  teleportToSpawn(idx: number): void {
    this.predPhys?.teleport_to_spawn(idx);
    this.bumpSampleEpoch();
  }

  /** 设置出生点列表（[[x,y,z,yaw], ...]，spawn 下拉切换用）。 */
  setSpawnPoints(list: Array<[number, number, number, number]>): void {
    try {
      this.predPhys?.set_spawn_points(JSON.stringify(list));
    } catch (err) {
      console.error('[renderer] set_spawn_points 失败:', err);
    }
  }

  /** 设置死亡 Y 阈值（loadScene 后由 onSceneLoaded 回调传入）。 */
  setDeathY(y: number): void {
    this.predPhys?.set_death_y(y);
  }

  /** 当前物理速度（速度面板 8Hz 采样）。 */
  getCurrentVel(): { x: number; y: number; z: number } {
    if (!this.predPhys) return { x: 0, y: 0, z: 0 };
    const st = this.predPhys.state() as { velX: number; velY: number; velZ: number };
    return { x: st.velX, y: st.velY, z: st.velZ };
  }

  /** 存点用：完整物理状态（位置/朝向/速度/着地；X 键存点采样）。 */
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

  /** 读点：恢复存点全状态（C 键/面板）。主线程 set_state 即时生效 + 同步权威
   * （复用 sync-render-state 链路：权威 set_state 到存点并清双端输入增量）。 */
  loadSavepoint(sp: {
    x: number; y: number; z: number;
    yaw: number; pitch: number;
    vx: number; vy: number; vz: number;
    onGround: boolean;
  }): void {
    this.predPhys?.set_state(sp.x, sp.y, sp.z, sp.yaw, sp.pitch, sp.vx, sp.vy, sp.vz, sp.onGround);
    // 位置突变：渲染采样流不连续 → 失效代数 +1（Worker 丢弃旧位置缓存）
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
      true, // 存点 load = 真位置突变：清双端未消费输入增量（旧增量对新位置无意义）
    );
  }

  /**
   * 按住 C 读点：冻结在存点（每帧 tick 强制 set_state——位置/朝向=存点、速度=0）。
   * "按住定在点的那一刻不要给速度"：空中存点悬停、地面存点站定，物理/权威
   * 被持续覆盖；松开（releaseHoldPoint）才恢复存点速度。
   */
  setHoldPoint(sp: {
    x: number; y: number; z: number;
    yaw: number; pitch: number;
    onGround: boolean;
  }): void {
    this.holdPoint = sp;
  }

  /** 松开 C：解除冻结并恢复存点速度（loadSavepoint 全量恢复 + 同步权威）。 */
  releaseHoldPoint(sp: {
    x: number; y: number; z: number;
    yaw: number; pitch: number;
    vx: number; vy: number; vz: number;
    onGround: boolean;
  }): void {
    this.holdPoint = null;
    this.loadSavepoint(sp);
  }

  /**
   * 权威帧到达（A2）处理 / 速度外推校准 / 碰撞事件微调 / 位置突变归零。
   * 公共化：实现收敛到 ts-shared AuthorityCalibrator（correctFromAuthority
   * 三条件 OR + 250ms 冷却 + syncInFlight 回滚、calibrateVelocity 外推、
   * applyCollisionCorrection <60 微调、resetTo 归零）。
   */
  private correctFromAuthority(): void {
    this.calibrator.correctFromAuthority();
  }

  /** 逐帧速度校准（权威速度外推反馈；实现见 ts-shared AuthorityCalibrator）。 */
  private calibrateVelocity(now: number): void {
    this.calibrator.calibrateVelocity(now);
  }

  /** 位置突变归零（显式重置允许覆盖：respawn/teleport/noclip 切换）。 */
  resetTo(pos: number[], yawDeg: number): void {
    this.calibrator.resetTo(pos, yawDeg);
    // 位置突变：渲染采样流不连续 → 失效代数 +1（Worker 丢弃旧位置缓存）
    this.bumpSampleEpoch();
  }

  /**
   * 权威碰撞事件 → 位置微调 + 角度同步（权威仅在碰撞判断时可影响渲染角度；
   * 实现见 ts-shared AuthorityCalibrator）。
   */
  applyCollisionCorrection(kind: 'land' | 'blocked', pos: number[], yawDeg: number, pitchDeg: number, vel?: number[]): void {
    this.calibrator.applyCollisionCorrection(kind, pos, yawDeg, pitchDeg, vel);
  }

  /** 面板参数实时同步到主线程物理实例（与 set_params 同字段）。 */
  setPredictionParams(params: Record<string, unknown>): void {
    try {
      this.predPhys?.set_params(JSON.stringify(params));
    } catch (err) {
      console.error('[renderer] set_params 失败:', err);
    }
  }

  /**
   * noclip 模式同步到主线程物理。
   * Rust tick 在 noclip 下走 noclip_step（无碰撞纯移动 + Q/E 转向），
   * 物理实例内部切换，无需额外渲染分支。
   */
  setPredictionNoclip(active: boolean): void {
    try {
      this.predPhys?.set_noclip(active);
    } catch (err) {
      console.error('[renderer] set_noclip 失败:', err);
    }
    // 模式切换 = 轨迹不连续（无碰撞纯移动会瞬间脱离渲染折线）→ 失效代数 +1
    this.bumpSampleEpoch();
    this.clearPendingInput();
  }

  /** 面板体型实时同步到主线程物理实例。 */
  setPredictionHull(halfWidth: number, standHeight: number, duckHeight: number): void {
    this.predPhys?.set_hull(halfWidth, standHeight, duckHeight);
  }

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

  private readonly boundTick = this.tick.bind(this);

  private tick(now: number): void {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.boundTick);
    if (!this.renderer || !this.scene || !this.camera) return;

    // 1. 主线程渲染物理线 + Worker 权威帧校准（v7）：
    //    写输入 SAB（Worker 权威模拟同输入）→ 读权威帧 → 外推校准 → tick → 渲染
    if (this.predReady && this.predPhys) {
      const dt = this.lastTickMs === 0 ? 1 / 64 : Math.min((now - this.lastTickMs) / 1000, 0.1);
      this.lastTickMs = now;
      // 输入 → SAB 输入槽（Worker 权威帧模拟消费；与主线程同输入）
      this.shared.addInput(this.pendingDx, this.pendingDy, this.pendingKeys);
      // 权威帧到达 → 记录（只读）；首次 set_state 起点；>200 异常兜底
      this.correctFromAuthority();
      // 权威速度外推校准（考虑中途地图碰撞后的正确速度；位置不覆盖）
      this.calibrateVelocity(now);
      // 完整物理推进：physics = 碰撞/传送/死亡/reset；noclip = noclip_step（无碰撞）
      this.predPhys.tick(dt, this.pendingKeys, this.pendingDx, this.pendingDy);
      this.pendingDx = 0;
      this.pendingDy = 0;
      // 按住 C 读点冻结：每帧强制 set_state（位置/朝向=存点、速度=0、着地=存点值）
      // ——"按住定在点的那一刻不要给速度"，悬停直到松开（空中存点悬空、地面存点站定）
      if (this.holdPoint) {
        const h = this.holdPoint;
        this.predPhys.set_state(h.x, h.y, h.z, h.yaw, h.pitch, 0, 0, 0, h.onGround);
      }
      // 渲染 = 主线程物理状态（连续无屏闪）
      const st = this.predPhys.state() as {
        posX: number; posY: number; posZ: number;
        yaw: number; pitch: number;
        eyeHeight: number;
      };
      // 渲染采样传输（R1：写侧 4 个 f64 载荷 store + seqlock 戳，无同步等待）：
      // 权威发布位置 = 本渲染轨迹上的一个采样点（Worker 按渲染时钟 τ 取点后发布）。
      // 与渲染状态读取同拍同源，i0 单调递增（见 renderSampleIndex 注释）。
      // ⚠️ 不传 epoch（缺陷修复 · epoch 竞态）：世代由 shared-state 独占并就地读，
      // 传调用方缓存值会把 `bumpSampleEpoch()` 的自增写回旧值（详见 shared-state.ts）。
      this.shared.writeRenderSample(now, st.posX, st.posY, st.posZ, this.renderSampleIndex++);
      // Rust 输出角度为度 → 弧度
      this.camera.rotation.set(st.pitch * DEG2RAD, st.yaw * DEG2RAD, 0, 'YXZ');
      this.camera.position.set(st.posX, st.posY + st.eyeHeight, st.posZ);

      // 近平面贴墙自适应（每 2 帧）：贴墙收缩 near 防近平面裁剪透视
      this.nearCheckToggle = !this.nearCheckToggle;
      if (this.nearCheckToggle) {
        this.updateNearPlane(st.posX, st.posY + st.eyeHeight, st.posZ);
      }
    }

    const camPos = this.camera.position;

    // 2. LOD/PVS 剔除
    if (this.lodItems.length > 0) {
      const pvs = this.pvsManager;
      if (ENABLE_PVS && pvs) pvs.update(camPos);
      // PVS 安全保护（主项目同法）：相机不在任何 cluster（出生在固体/地图外）时
      // 可见集为空，有 cluster 的 mesh 会被错误全剔 → 跳过 PVS，仅按距离 LOD
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

    // 3. 渲染（快照就绪后无条件渲染，帧率跟随 rAF）
    this.renderer.render(this.scene, this.camera);

    // 3b. 首帧后跑一次注入生效性统计（此刻材质已编译、onBeforeCompile 已回填）。
    if (this.pendingInjectReport && !this.injectReported) {
      this.injectReported = true;
      this.pendingInjectReport = false;
      this.reportInjectStatsOnce();
    }
  }

  /**
   * 注入生效性统计（**必须在首帧渲染之后**调用一次）。
   *
   * 判据口径按 `stage` 分类，不再把"跳过注入"误判成"注入失效"：
   * - `auto`/`channel0`/`channel1`：注入应**生效**（`__vbspLightmapInjected === true`）
   *   ⇒ 全部失效才算失败（`console.error` + 置全局失败标记，供出帧脚本非零退出）；
   * - `broken`：**预期失败**（故意用失配字面量）⇒ 单列，不打 error、不置失败标记；
   * - `native`：**预期跳过**（走 three 原生 lightmap）⇒ 单列，不打 error；
   * - `off`：压根未施加材质（`applyLightmapToMeshes` 提前 return）⇒ 不进入本统计。
   *
   * 为什么按 stage 分类：原先只按 `applied` 真假二分，`native` 的 `applied` 为
   * `null`/`undefined` ⇒ 落入"失效"分支 ⇒ 负控帧被打上"注入全失效"的**假 error**。
   */
  private reportInjectStatsOnce(): void {
    if (!this.scene) return;
    const stage = (globalThis as { __vbspLightmapStage?: unknown }).__vbspLightmapStage;
    // 原样保留已知 stage 名（含 `channel0`/`channel1` 对照档与 `noinject` 可比负控）
    // ——四态/对照矩阵的全部意义就在于**逐帧可归因**，把 channel 档记成 `auto`
    // 会让日志与帧标签不一致（实测踩过）。
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

    // prop ambient cube 命中统计（P1 验收口径：hit/miss 按 mesh 调用计，
    // nodes = 独立 cube 引用去重 = 带 cube 的 prop node 数）
    const amb = (globalThis as { __vbspAmbientStats?: { hit: number; miss: number; nodes: Set<unknown> } })
      .__vbspAmbientStats;
    if (amb) {
      console.info(
        `[ambient-cube] 命中=${amb.hit} 未命中=${amb.miss} 节点=${amb.nodes.size}`,
      );
      // P2 验收口径：遍历材质统计 __vbspAmbientInject.applied
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

    // 第 1 级 prop 光照（逐顶点预烘焙 `sp_<idx>.vhv` → `_VBSP_VLIGHT`）的接线校验。
    // 判据：走第 1 级的 mesh 数（>0 才说明导出侧真的接上了）+ 注入是否生效 + 有无失败。
    // ⚠️ 「带属性但未注入」必须**再分两类**（2026-09-20 穷尽审计的结论）：
    //    ① `extras.unlit` 的自发光 VMT（`blue_neon` / `glow_*` / `neon666_*` …）⇒ 按 Source
    //       `UnlitGeneric` 语义**本来就不吃光照**，带属性而不用是**正确**的；
    //    ② 其余 ⇒ 真漏网，必须修。
    //    实测 surf_666：带属性 395 个 mesh、顶点数**逐个与 POSITION 相等**（零错位），
    //    其中 356 已注入 + 39 全为①（② = 0）。只报一个合计数会被误读成缺陷。
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
      // alpha 状态覆盖审计（铁丝网/格栅/玻璃这类材质的关键状态：
      // 替换材质若丢掉 alphaTest/side，$alphatest 的孔洞会变成实心板、单面材质会少一半）
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
      // 负控：预期注入失效 ⇒ 只做记录，不打 error（否则负控帧日志被污染）。
      console.warn(
        `[lightmap] stage=broken（负控）：注入预期失效 —— 预期失败材质=${expectedFail}、生效=${injectOk}。`,
      );
      return;
    }
    if (stageName === 'native') {
      // native：按设计跳过自定义注入（走 three 原生 lightmap）⇒ 非失败。
      return;
    }
    if (stageName === 'noinject') {
      // 可比负控：材质照换、**仅不注入** ⇒ 本来就不会有 `__vbspLightmapInject` 记录，
      // `injectOk=injectBad=0` 属**预期**，不得报"注入全失效"（否则负控帧被打上假 error）。
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

  resize(width: number, height: number): void {
    if (!this.renderer || !this.camera) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  /**
   * 渲染距离（LOD 剔除距离，世界单位）。
   * `> 0` = 显式距离；`<= 0` = 恢复自动值（地图对角线的一半）。
   * 生效点：`tick()` 的 LOD 遍历——`dist > cullDistance` 的块置 `visible = false`，不产生 draw call。
   */
  setRenderDistance(dist: number): void {
    this.cullDistance = dist > 0 ? dist : this.autoCullDistance;
  }

  // ── GLB 加载 ───────────────────────────────────────────────

  private readonly gltfLoader = new GLTFLoader();

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
   * 阶段 3：施加离线烘焙静态光照（lightmap atlas）。
   *
   * GLB 契约：`asset.extras.lightmap.textureIndex` 指向图集纹理（副本 wasm-core 的
   * `bsp_to_gltf_core/lightmap.rs` 写出），图元带 `TEXCOORD_1` 与 `extras.hasLightmap`。
   * 失败只告警、不阻断场景加载（与既有容错风格一致）；无 atlas 时给出明确日志而不是静默。
   */
  private async applyLightmap(scene: THREE.Scene, gltf: GLTF): Promise<void> {
    try {
      // ⚠️ atlas **两种模式都加载**（2026-09-21）：模式只是片元里的共享 uniform 分支
      // （`vbspBakedMix`），所以纯纹理模式下 atlas 也必须在场——否则面板切回预烘焙又要重建场景。
      const atlas = await loadLightmapAtlas(gltf.parser, gltf);
      if (!atlas) {
        console.info('[lightmap] GLB 未携带 atlas（asset.extras.lightmap 缺失），跳过静态光照');
        return;
      }
      const applied = applyLightmapToMeshes(scene, atlas);
      const image = atlas?.image as { width?: number; height?: number } | undefined;
      // ⚠️ **此处不做注入生效性统计**：本方法由 `loadScene` 在建场景时调用，此时 three
      // **尚未编译任何材质** ⇒ `onBeforeCompile` 还没被调用 ⇒ `__vbspLightmapInject`
      // 全是 `undefined`。此前在这里统计 ⇒ `注入生效材质=0` 恒成立 ⇒ 误报「没有任何一个
      // 注入生效」（实测四态各打 2 次假 error，连 `native`/`broken` 负控帧都被污染）。
      // ⇒ 统计移到**首帧渲染之后**（材质已编译、`onBeforeCompile` 已回填）：见 tick 中的
      //   `reportInjectStatsOnce()`。诊断口径与 `__vbspFrameProbe.lightmapState()` 一致。
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
   * 切换光照模式（面板「预烘焙 / 纯纹理」）——**运行期性能旋钮**：只改共享 uniform，立即生效。
   *
   * 2026-09-21 改定：旧实现是「按新模式重建场景」（`loadScene(lastSceneData)`）——那会把面板切换变成
   * 一次 1.4~2.5 s 的冻结，并且重建期间输入/物理被一起打断（用户症状：热切换后转不动视角、也走不动）。
   * 现在的机制在 `lightmap-shader.setLightingMode`：全场景材质共享一个 `vbspBakedMix` uniform，
   * 三条烘焙路径（world lightmap / 逐顶点 vhv / ambient cube）都按它分支 ⇒
   * **零重编译、零重建、零输入中断**，也不改变分块/材质分组（两种模式 draw 数完全一致）。
   *
   * @param mode `baked` = 预烘焙（吃 atlas + vhv/ambient cube）；`texture` = 纯纹理（只上漫反射贴图）。
   */
  setLightingMode(mode: LightingMode): void {
    if (getLightingMode() === mode) return;
    setLightingModeInShader(mode);
    console.info(`[lighting] 光照模式 → ${mode}（运行期 uniform 切换，未重建场景）`);
  }

  /** 当前光照模式（面板回填/诊断用）。 */
  getLightingMode(): LightingMode {
    return getLightingMode();
  }

  private resetRootRotations(gltf: GLTF): void {
    for (const child of gltf.scene.children) {
      if (child.rotation.x !== 0 || child.rotation.y !== 0 || child.rotation.z !== 0) {
        child.rotation.set(0, 0, 0);
        child.updateMatrixWorld();
      }
    }
    gltf.scene.updateMatrixWorld(true);
  }

  // ── 空间分块合并（optimizeScene：GLB 挂载后执行一次）─────────────
  // 渲染减负核心：3.4 万 Mesh（每帧遍历/剔除开销）→ ~300~800 空间块。
  // 移植自 test/dual-mode-harness/src/worker-b.ts optimizeScene（已验证：34409 mesh → 300~800 块）。
  // 与 test 的差异（Worker → 主线程）：
  // - 载体：test 重建 modelRoot 组替换；本实现直接在 BSP 根（bspRoot，userData.isBspModel
  //   保留不变）内替换内容——移除 gltf.scene、块 mesh 直接挂 BSP 根；
  // - 时序：loadScene 中场景挂载（this.scene.add）之后、PVS/LOD 注册 traverse 之前执行——
  //   下方 traverse 收集分块后的 mesh（lodItems + clusterIds 对块生效）；
  // - 统计：前向视锥估算用 this.camera（非 Worker 模块级 camera）。
  // 流程：① scene.updateMatrixWorld(true) → traverse 收集 Mesh（世界包围盒中心）
  // ② cell 自适应（世界对角 / cbrt(目标块数)，微调落 [300,800]）
  // ③ 顶点 applyMatrix4(matrixWorld) 烘焙世界空间（clone 后变换，勿动原 geometry）
  // ④ 单 mesh cell 保留原 mesh（变换清零重挂）；多 mesh cell 块内按材质（实例恒等）子
  //    合并 → mergeGeometries(useGroups=true) 最终合并（groups 保留材质索引）；多材质/
  //    无材质 mesh 防御性烘焙保留；失败保持场景原状（计算先行、后替换）
  // ⑤ console.log 统计：原 mesh 数 → 块数、平均顶点、draw call 估算、前向视锥可见块
  private optimizeScene(bspRoot: THREE.Scene, gltfScene: THREE.Object3D): void {
    // ① 收集：matrixWorld 更新后作为世界变换基准；多材质 mesh（GLB primitive 恒单材质，
    //    防御性路径）与无材质 mesh 单独烘焙保留，不参与分块
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
        // 多材质/无材质：烘焙到世界空间后整体保留（不参与分块合并）
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

    // ①b 合并失败**不丢几何**（判据，非推断）：
    //     `mergeGeometries()` 在属性集不一致时返回 null（实测本图控制台有若干条
    //     `mergeGeometries() failed`），但本函数每一处失败分支都回退为「保留各自独立几何」
    //     （④ 内三处 `if (!mg)` / `if (!final)`），不存在"合并失败 ⇒ 丢弃"的路径。
    //     运行期实测（CDP 走真实加载链路 + **索引感知**三角形计数）：合并后场景三角形
    //     实例总数 = 148048 = GLB 逐节点实例展开总数（prop 40431 + world 107617）⇒ 零丢失。
    //     ⚠️ 计数必须用 `index.count/3`：GLB 几何是**索引化**的，用 `position.count/3`
    //     会把顶点数当三角形数、虚高约 14%（本批量测先踩过这个坑）。

    // ② cell 大小自适应：cell = 世界包围盒对角线 / cbrt(目标块数)，再按非空 cell 数微调
    //    （非空 cell 偏少 → 缩小 cell，偏多 → 放大 cell，收敛到 300~800）
    const diag = Math.max(worldBox.getSize(new THREE.Vector3()).length(), 1);
    let cellSize = Math.min(Math.max(diag / Math.cbrt(OPT_TARGET_CELLS), OPT_CELL_MIN), OPT_CELL_MAX);
    for (let i = 0; i < 6; i++) {
      const n = optCountCells(infos, cellSize);
      if (n >= OPT_MIN_CELLS && n <= OPT_MAX_CELLS) break;
      const scale = Math.min(Math.max(Math.cbrt(n / OPT_TARGET_CELLS), 0.55), 1.8);
      cellSize = Math.min(Math.max(cellSize * scale, OPT_CELL_MIN), OPT_CELL_MAX);
    }

    // ③ 分桶：每 mesh 世界包围盒中心归 cell（横跨多 cell 归中心所在 cell）
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

    // ④ 合并 + 替换：单 mesh cell 保留原 mesh（烘焙世界变换、移除原父变换）；
    //    多 mesh cell 块内按材质子合并 → 最终 mergeGeometries(useGroups=true)（groups 保留
    //    材质索引：材质去重收集 + 块内索引重映射）→ 每块一个 THREE.Mesh(mergedGeom, materials)
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

      // 多 mesh cell：块内按材质（实例恒等）分组 → 同材质子合并 → 每材质一个几何
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
            merged = geoms; // 属性不一致（防御）：保留单独几何，材质索引各自映射
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

    // ④b 替换：移除原 GLB 子树（旧 mesh 几何已逐个 dispose），块 mesh 直接挂 BSP 根
    //    （bspRoot.userData.isBspModel 保留——disposeScene/updateNearPlane 依赖）；add()
    //    自动使块 mesh 脱离原父节点
    const totalMeshes = infos.length;
    for (const m of chunks) bspRoot.add(m);
    for (const m of keptMeshes) bspRoot.add(m);
    bspRoot.remove(gltfScene);

    // ④c 视锥外保一圈：块 geometry.boundingSphere 半径 ×FRUSTUM_PAD。
    //    必须强制 computeBoundingSphere（非 null 检查）：烘焙路径是 geometry.clone() +
    //    applyMatrix4(matrixWorld)——克隆残留 GLB 局部空间的旧球（非 null 会被跳过）→
    //    剔除按错误位置判定 → 眼前块被误剔不渲染。顶点已烘焙世界空间 → 重算球正确。
    //    只影响剔除判定，不改变几何/包围盒；LOD/PVS（userData 数据）不受影响。
    for (const child of bspRoot.children) {
      const g = (child as THREE.Mesh).geometry;
      if (!g) continue;
      g.computeBoundingSphere();
      (g.boundingSphere as THREE.Sphere).radius *= FRUSTUM_PAD;
    }

    // ⑤ 统计 + 前向视锥可见块估算（仅诊断：块包围盒中心与相机方向点积粗估，FOV 73.6°）
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

  // ── 出帧探针（验证仪器；out-of-band，不参与渲染逻辑）──────────────────
  /**
   * 安装 `globalThis.__vbspFrameProbe`：给自动化出帧脚本（scripts/lightmap-frame-capture.mjs）
   * 提供**确定性相机位姿**与**lightmap 运行时状态**读取口。
   *
   * 为什么需要它：缺陷判据是「同一相机位姿下的出帧截图」。主线程把相机钉在物理状态上
   * （tick 里每帧 `camera.position/rotation = predPhys.state()`），若只靠 spawn 默认朝向，
   * 视野里大量是天空/远景，地图表面占比不可控 → before/after 亮度差被稀释、也不可复现。
   * 本探针用 `setHoldPoint` 把物理状态**冻结**在指定位姿（既有机制：每帧 set_state 覆盖），
   * 于是相机被确定性地锁住，且该路径本身就在生产代码里（"按住 C 读点"）。
   *
   * 生产路径零影响：只有自动化脚本显式调用 `applyPose` 才会冻结；正常游玩不会触发。
   */
  installFrameProbe(): void {
    const self = this;
    const probe = {
      get ready(): boolean {
        return self.predReady && self.scene !== null && self.camera !== null;
      },
      /** 当前相机的世界位姿（截图可复现性的直接证据）。 */
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
      /** lightmap 施加结果的运行时快照（材质级，不是日志推断）。 */
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
          // 与 applyLightmapToMeshes 同口径：primitive extras 落在 **geometry.userData**
          // （GLTFLoader `assignExtrasToUserData( geometry, primitiveDef )`），geometry 优先。
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
            // 注入标记：injectLightmapShader 在 onBeforeCompile 上留下的可辨识痕迹
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
       * P3 取证：直读前 3 个 ambient 注入材质的 cube 值（mesh/parent userData）与注入记录。
       * 「0.75 vs 1.0 不敏感」问题的定位仪器：确认材质手里的 cube 到底是什么值。
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
       * 应用确定性位姿并冻结物理（见本方法上方说明）。
       * `surface`：出生点 + 俯视 -35°（视野以地图地表为主，lightmap 是否参与直接可见）；
       * `spawn`  ：出生点原始朝向（对照口径）。
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

        // 先回出生点（拿权威 spawn 坐标），再把 pitch 压到 -35°（俯视地表）。
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
        // setHoldPoint 是既有生产机制（按住 C 读点）：tick 每帧 set_state 覆盖，
        // 位置/朝向被钉死、速度归零 → 相机确定性锁在该位姿。
        self.setHoldPoint(freeze);
        await new Promise((r) => setTimeout(r, 600));
        return { ok: true, preset, pose: probe.cameraPose() };
      },
      /** 解除冻结（脚本收尾用；不解除也不影响截图，浏览器随后被关掉）。 */
      release(): void {
        self.holdPoint = null;
      },

      /**
       * 「假亮」判别器：把所有 lightMap 纹理的 image 换成**常量图**（同色铺满）。
       *
       * 用途：若画面亮度随之**变得均匀**（方差塌缩）⇒ 之前的明暗来自 lightmap 采样
       * （真光照）；若画面**几乎不变** ⇒ 明暗来自贴图/几何，lightmap 未真正参与。
       * 这是纯验证手段，不参与生产逻辑。
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
              buf[i * 4 + 3] = 128; // α=128 ⇒ exp = 128*255/255-128 = 0 ⇒ 倍数 2^0 = 1
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
