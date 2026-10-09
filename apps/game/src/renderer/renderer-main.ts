/**
 * `apps/game` 主线程渲染器：物理、相机、场景与光照都在本线程，Worker 只跑权威物理。
 *
 * 职责（按调用顺序）：
 * - `init`：建 `THREE.WebGLRenderer` / `THREE.Scene` / `THREE.PerspectiveCamera`，并把光照参数
 *   初值写进 `src/renderer-shared/shader/lightmap-shader.ts` 的共享 uniform；
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
import { setFogMaxDensity } from '../../../../src/renderer-shared/shader/lightmap-shader.js';
import { PhysWorld, mosaic_decode, initSync } from '../../pkg/websurf_wasm.js';
import type { RuntimeConfig } from '../config.js';
import type { SceneDataMessage } from '../worker/worker-types.js';
import type { ShmState, MsgState } from '../../../../src/ts-shared/auth/shared-state.js';
import { AuthorityCalibrator } from '../../../../src/ts-shared/phys/authority-calibrator.js';
import { PvsManager } from '../../../../src/ts-shared/world/pvs-manager.js';
import { base64ToBytes } from '../../../../src/ts-shared/wasm/loader.js';
import { EYE_STAND } from '../../../../src/ts-shared/phys/constants.js';
import { mergeIntoChunks, padBoundingSpheres, optimizeScene } from '../../../../src/renderer-shared/scene/scene-optimizer.js';
import { reportInjectStatsOnce } from '../../../../src/renderer-shared/scene/inject-stats.js';
import { buildMapScene, applyLightmap } from '../../../../src/renderer-shared/scene/scene-builder.js';
import { createSkyCamera, extractSkyArea, SKY_LAYER, syncSkyCamera, type SkyCameraParams } from '../../../../src/renderer-shared/environment/miniature-sky.js';
import { disposeObject } from '../../../../src/renderer-shared/scene/dispose.js';
import { applyTextureQuality } from '../../../../src/renderer-shared/scene/texture-quality.js';
import { NearPlaneController } from '../../../../src/renderer-shared/camera/near-plane.js';
import { applyWorldTransitionShaders, collectWorldTransitionTextures } from '../../../../src/renderer-shared/shader/world-transition.js'; import { fullbrightUnlitLitMaterials, setReflectionEnvMap, setExposure, setLightGamma, setAmbientScale, setPropVertexRelax, setPropVertexFlatten, setLightingMode as setLightingModeInShader, getLightingMode, type LightingMode } from '../../../../src/renderer-shared/shader/lightmap-shader.js'; import { createRenderer, precompileScene } from '../../../../src/renderer-shared/render/create-renderer.js'; import { installPoseEntry, cameraPoseOf, feetFromCameraPose } from '../../../../src/renderer-shared/camera/pose-entry.js'; import { applySceneCamera, shrinkNearPlane } from '../../../../src/renderer-shared/camera/scene-camera.js';

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
  /** 3D 天空盒（`miniature-sky.ts`，与 debug 同款）：第二相机 + 只挂第 `SKY_LAYER` 层的天空区组。 */
  private skyCamera: THREE.PerspectiveCamera | null = null;
  private skyGroup: THREE.Group | null = null;
  private skyParams: SkyCameraParams | null = null;
  /** 天空遍专用雾（`sky_camera` 自己的雾参数，start/end 乘 1/scale）。 */
  private skyFog: THREE.Fog | null = null;
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
   * 延后的原因：材质上的注入标记由 `src/renderer-shared/shader/lightmap-shader.ts` 的
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
  // 近平面贴墙自适应：字段与逻辑在 ./near-plane.ts 的 NearPlaneController（tick 每 2 帧调 update）。
  private readonly nearPlane = new NearPlaneController();
  /** 每 2 帧探测一次的开关（tick 里翻转）。 */
  private nearCheckToggle = false;



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
    setExposure(config.lighting?.exposure ?? 2.0);
 // 光照项 gamma（shadow-lift）：缺省 0.5；接受窗口是 (0, 8]
    setLightGamma(config.lighting?.lightGamma ?? 1.0);
    // prop（模型）烘焙光照亮度：ambient cube 路径的独立档位，不动 world lightmap
    setAmbientScale(config.lighting?.ambientScale ?? 1);
    // 第 1 级逐顶点光照的几何重建档位：平滑遍数（0 = 原样使用烘焙值）与方差压缩上限
    setPropVertexRelax(config.lighting?.propVertexRelax ?? 1);
    setPropVertexFlatten(config.lighting?.propVertexFlatten ?? 0);
    this.renderer = createRenderer({ canvas, width, height, dpr });

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

    // 1. GLB → 子场景（新建 + isBspModel 标记 + 清根 rotation + 包围盒 + 摘 punctual 灯，
    //    顺序约束详见 scene-builder.buildMapScene 的文档）：两处都必须对，缺一个就是整批几何不渲染——
    //    (1) 摘灯必须在挂进主场景之前（rAF 已在跑，先挂再摘会让中间帧带灯编译材质，uniform 超限
    //        ⇒ 该批 mesh 一个像素都不画）；(2) 必须 removeFromParent 真摘，visible=false 仍会被
    //        traverse 且程序失效。
    const { gltf, scene, bbox, maxDim } = await buildMapScene(data.glb); await collectWorldTransitionTextures(gltf, scene);


    this.scene.add(scene); // 挂进主场景：此时 punctual 光源已摘除

    // 1.2 离线烘焙静态光照（lightmap atlas）：**必须**在 optimizeScene 之前施加。
    //     理由：lightmap 按原 mesh 的材质与 UV 通道施加并改写材质，而分块合并会重建几何与材质
    //     数组；放到合并之后施加就找不到原来的材质映射。返回值落账 pendingInjectReport
    //     （首帧后由 tick 统一统计注入生效性）。
    this.pendingInjectReport = await applyLightmap(scene, gltf);
    // 1.1 3D 天空盒（起源做法，与 debug 同款）：把天空区图元摘出主世界，交第二相机单独渲染。
    //     判据 =「图元采样点落在 `sky_camera` 所在 cluster」。
    //     位置与 debug 同序：**必须晚于 applyLightmap**（否则微缩区图元已不在遍历范围内 ⇒ 拿不到
    //     lightmap 与逐顶点烘焙，只剩贴图原色），且必须早于分块合并（合并成空间块后跨区大块无法再拆）。
    this.pvsManager = new PvsManager(data.pvsJson);
    const skyCluster = data.skyCamera
      ? this.pvsManager.getClusterAt({ x: data.skyCamera.origin[0], y: data.skyCamera.origin[1], z: data.skyCamera.origin[2] })
      : -1;
    this.skyGroup = data.skyCamera && skyCluster >= 0 ? extractSkyArea(scene, (m) => this.meshInCluster(m, skyCluster)) : null;
    this.skyParams = this.skyGroup && data.skyCamera ? data.skyCamera : null;

    // 1.3 装配顺序的其余约束：摘灯 → 施加 lightmap → 分块合并 → 受光材质终扫（合并会重建材质
    //     数组，所以终扫必须晚于合并、早于首次编译）。

    // 1.5 空间分块合并（GLB 挂载后、PVS/LOD 注册前）：数万 mesh → 数百空间块。
    //     必须在下方 traverse（lodItems 收集 + clusterIds 分配）之前执行——那次 traverse 收集的是
    //     合并之后的块 mesh。
    // 天空区也要合并：天空组没有主世界那棵原 GLB 子树，合并后必须自己 clear 并重贴天空层。
    // 不合并时 1000+ 个逐面小块就是 1000+ 次天空遍 draw call。与 debug 同构。
    if (this.skyGroup) {
      const skyMerged = mergeIntoChunks(this.skyGroup);
      this.skyGroup.clear();
      for (const m of skyMerged.chunks) this.skyGroup.add(m);
      for (const m of skyMerged.keptMeshes) this.skyGroup.add(m);
      padBoundingSpheres(this.skyGroup);
      this.skyGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.layers.set(SKY_LAYER);
      });
      console.info(`[skybox] 天空区合并：${skyMerged.infos.length + skyMerged.keptMeshes.length} mesh → ${skyMerged.chunkCount} 块`);
    }

    optimizeScene(scene, gltf.scene, this.camera, this.config?.hud?.fov ?? FOV_DEFAULT);

    // 1.55 装配后终扫：把仍带受光材质的 mesh（GLTFLoader 给 prop/派生网格的
    //      `MeshStandardMaterial`）收敛到 fullbright。本工程不加任何灯 ⇒ 受光材质只剩
    //      emissive=[0,0,0]，恒渲染纯黑。必须在 optimizeScene 之后（合并会重建 mesh/材质数组）、
    //      首次编译之前。
    const converged = fullbrightUnlitLitMaterials(this.scene); applyWorldTransitionShaders(this.scene);
    // 天空区图元已摘出主场景，同两道装配要在天空组上再跑一次（全亮收敛 + WorldTransition 雪盖）
    if (this.skyGroup) { fullbrightUnlitLitMaterials(this.skyGroup); applyWorldTransitionShaders(this.skyGroup); }
    if (converged > 0) {
      console.info(
        `[lightmap] 装配后终扫：${converged} 个 mesh 仍为受光材质 ⇒ 收敛为 fullbright 贴图原色` +
          '（本工程不加灯，受光材质恒黑；unlit 图元不吃 ambient cube）',
      );
    }

    // 1.6 预编译着色器程序：把「首次可见才编译」的卡顿挪到加载期。
    //     背景：`tick` 把主线程物理的 dt 夹在 0.1s 以内（上限见该方法的 dt 计算）⇒ 超过 100ms 的
    //     主线程卡顿会让物理表现为慢动作。失败不致命（three 仍按需编译），故只告警。
    if (this.renderer && this.scene && this.camera) precompileScene(this.renderer, this.scene, this.camera);

    // 2. 相机 near/far（near 自适应：默认 maxDim/1000，贴墙由 NearPlaneController.update 收缩）
    applySceneCamera(this.camera, this.nearPlane, maxDim, this.config.hud.fov);

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
    if (data.skyboxTexture) { this.scene.background = data.skyboxTexture; setReflectionEnvMap(data.skyboxTexture); } this.onSceneLoaded?.(bbox.min.y);

    // 5b. 挂天空层 + 地图雾。天空层必须在 LOD/PVS 注册**之后**：天空图元只在第 1 层、由第二相机
    //     渲染，不能被主相机的 LOD/PVS 剔除（注册时它们还没进场景，故不会被收进 lodItems）。
    this.skyCamera = createSkyCamera();
    if (this.skyGroup) {
      this.scene.add(this.skyGroup);
      console.info(`[skybox] 3D 天空盒：天空区 ${this.skyGroup.children.length} 个图元挂第 ${SKY_LAYER} 层，由第二相机渲染`);
    } else {
      console.info('[skybox] 无可用 3D 天空盒（无 sky_camera 或天空区不可分离）⇒ 不加天空层');
    }
    // 地图线性雾（`env_fog_controller`）：与 debug 的 `lightManager.setFog` 同值
    this.scene.fog = data.fogParams ? new THREE.Fog(data.fogParams.color, data.fogParams.start, data.fogParams.end) : null;
    setFogMaxDensity(data.fogParams?.maxDensity ?? 1);

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
   * 不重载地图；manifest 或场景缺失时整体空跑。算法本体在共享核
   * `src/renderer-shared/scene/texture-quality.ts`（2026-10-04 合并 debug 同源副本而来）；
   * game 侧包装保持合并前形态：无诊断日志、无 `needsRender` 置位（逐帧渲染）、
   * 不传 `ensureWasm`（wasm 未就绪时解码失败走告警并保留原贴图）。
   */
  async applyTextureQuality(quality: 'original' | 'mini'): Promise<void> {
    if (!this.mosaicManifest || !this.scene) return;
    await applyTextureQuality(this.scene, this.mosaicManifest, quality, this.origTextureImages, {
      decode: mosaic_decode,
    });
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
          disposeObject(child);
          this.scene.remove(child);
        }
      }
    }
    // three.js 渲染列表缓存按旧场景几何缓存条目，换图后清掉（2026-10-04 自 debug 对齐）
    if (this.scene?.background instanceof THREE.Texture) { this.scene.background.dispose(); this.scene.background = new THREE.Color(0x222222); } this.renderer?.renderLists?.dispose();
    this.pvsManager = null;
    // 天空层与天空相机随地图一起释放；雾也摘掉（换图不继承上一张图的雾）
    if (this.scene) {
      for (let i = this.scene.children.length - 1; i >= 0; i--) {
        const child = this.scene.children[i];
        if (child.userData?.isMiniatureSky) { disposeObject(child); this.scene.remove(child); }
      }
      this.scene.fog = null;
    }
    this.skyGroup = null; this.skyParams = null; this.skyCamera = null; this.skyFog = null;
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
   * 一帧的 draw call。有 3D 天空盒时按起源的两遍法（`CSkyboxView::DrawInternal`，与 debug 同款）：
   * ① 天空相机（位姿见 `syncSkyCamera`）把 2D 天空盒背景 + 天空层图元画进后台缓冲；
   * ② 清深度后主相机画主世界——这一遍**必须摘掉背景**，否则 three 的背景 pass 会把第 ① 遍盖掉。
   * 无 3D 天空盒时退回单遍。
   */
  private renderFrame(): void {
    const renderer = this.renderer;
    const camera = this.camera;
    const scene = this.scene;
    if (!renderer || !camera || !scene) return;
    const skyCamera = this.skyCamera;
    if (!skyCamera || !this.skyGroup || !this.skyParams) {
      renderer.autoClear = true;
      renderer.render(scene, camera);
      return;
    }
    syncSkyCamera(skyCamera, camera, this.skyParams);
    const background = scene.background;
    const mapFog = scene.fog;
    // 天空遍的雾走 `sky_camera` 自己的参数，start/end 乘 1/scale（引擎 `Enable3dSkyboxFog`）；
    // `fogenable` 为假时引擎直接 `FogMode(NONE)`，天空区一点雾都不吃。
    const skyFogParams = this.skyParams.fog;
    if (skyFogParams?.enable) {
      if (!this.skyFog) this.skyFog = new THREE.Fog(0xffffff, 0, 1);
      this.skyFog.color.setHex(skyFogParams.color);
      this.skyFog.near = skyFogParams.start / this.skyParams.scale;
      this.skyFog.far = skyFogParams.end / this.skyParams.scale;
      scene.fog = this.skyFog;
    } else {
      scene.fog = null;
    }
    renderer.autoClear = false;
    renderer.clear();
    renderer.render(scene, skyCamera);
    scene.fog = mapFog;
    renderer.clearDepth();
    scene.background = null;
    renderer.render(scene, camera);
    scene.background = background;
  }

  /** 判某个 mesh 是否落在指定 BSP cluster（与 debug 同一采样口径：包围盒中心 + 6 个 ±r 轴点）。 */
  private meshInCluster(mesh: THREE.Mesh, cluster: number): boolean {
    const pvs = this.pvsManager;
    if (!pvs) return false;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    if (!box) return false;
    const center = box.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
    if (pvs.getClusterAt(center) === cluster) return true;
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(1, Math.max(size.x, size.y, size.z) * 0.25);
    for (const axis of ['x', 'y', 'z'] as const) {
      for (const sign of [1, -1]) {
        const probe = center.clone();
        probe[axis] += sign * r;
        if (pvs.getClusterAt(probe) === cluster) return true;
      }
    }
    return false;
  }

  /** 面板实时调整探测距离与收缩系数：转发 NearPlaneController.setParams（判据见该文件）。 */
  setNearParams(probeDist?: number, ratio?: number): void {
    this.nearPlane.setParams(probeDist, ratio);
  }


  /** 设置视野角 FOV（度）：写相机并立刻更新投影矩阵；相机未建时忽略。 */
  setFov(fov: number): void {
    if (!this.camera) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 全局曝光（显示侧亮度倍率）：转发给 `src/renderer-shared/shader/lightmap-shader.ts` 的
   * `setExposure` —— 改的是共享 uniform，立即生效、不重编译材质。该函数只接受有限正数，
   * 其余值（含 0 与负数）被忽略。
   */
  setExposure(value: number): void {
    setExposure(value);
  }

  /**
   * 光照项 gamma（shadow-lift）：转发给 `src/renderer-shared/shader/lightmap-shader.ts` 的
 * `setLightGamma`。接受窗口是 (0, 8]（2026-10-08 起），窗口外的值被忽略（`apps/game/src/config.ts` 的
   * `lighting.lightGamma` 默认 2.2 即落在窗口外，`init` 的那次写入不改变共享 uniform）。
   */
  setLightGamma(value: number): void {
    setLightGamma(value);
  }

  /**
   * prop（模型）烘焙光照亮度倍率（ambient cube 路径专用）：转发给
   * `src/renderer-shared/shader/lightmap-shader.ts` 的 `setAmbientScale`；接受有限非负数。
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

  /** 绑定后的 rAF 回调（`start` 与 `tick` 都把它交给 rAF，避免每次 bind 产生新函数）。 */
  private readonly boundTick = this.tick.bind(this);

  /**
   * 每个 rAF 一次：先推进主线程物理并同步相机，再做剔除与绘制。
   * - 物理分支（`predReady` 且 `predPhys` 非空）：dt = 与上一物理帧的间隔（首个物理帧取 1/64，
   *   上限 0.1s）→ `shared.addInput` 把输入交给 Worker 权威帧 → `correctFromAuthority` →
   *   `calibrateVelocity` → `predPhys.tick` → 把 dx/dy 清零（键位保留为按住状态）→ 冻结分支
   *   （`holdPoint` 非空时每帧写回该位姿且速度 0）→ 读 `state()` → 写渲染采样 →
   *   相机 rotation/position → 每 2 帧调一次 NearPlaneController.update；
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
        shrinkNearPlane(this.nearPlane, this.camera, this.scene, st.posX, st.posY + st.eyeHeight, st.posZ);
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
    this.renderFrame();

    // 3b. 首帧之后跑一次注入生效性统计（此刻材质已编译、onBeforeCompile 的回填已到位）
    if (this.pendingInjectReport && !this.injectReported) {
      this.injectReported = true;
      this.pendingInjectReport = false;
      reportInjectStatsOnce(this.scene);
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


  /**
   * 切换光照模式（面板「预烘焙 / 纯纹理」）：只改共享 uniform，立即生效。
   *
   * 机制（见 `src/renderer-shared/shader/lightmap-shader.ts` 的 `setLightingMode`）：全场景注入材质共用
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

  /** 读当前光照模式（诊断用；转发给 `src/renderer-shared/shader/lightmap-shader.ts` 的 `getLightingMode`）。 */
  getLightingMode(): LightingMode {
    return getLightingMode();
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
    (globalThis as unknown as { __vbspFrameProbe?: unknown }).__vbspFrameProbe = probe; installPoseEntry({ applyPose: (p) => { self.setHoldPoint({ x: p.pos[0], y: feetFromCameraPose(p)[1], z: p.pos[2], yaw: p.yawDeg, pitch: p.pitchDeg, onGround: true }); }, readPose: () => cameraPoseOf(self.camera), releasePose: () => { self.holdPoint = null; } }, 'game');
  }
}
