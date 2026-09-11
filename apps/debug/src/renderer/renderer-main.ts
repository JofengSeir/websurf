/**
 * WebSurf — 主线程渲染器（阶段 1：主线程解析/物理接管，LERP 删除、渲染直读）
 * 主线程 PhysWorld 每 rAF tick 推进（真实物理模拟 + 碰撞），state() 直读渲染——
 * 相机同步 → LOD/PVS 剔除 → 雾/碰撞箱可视化/准星射线 → Draw Call。
 * 场景数据由主线程（app.ts handleLoadBsp）解析后本地传入（GLB + 碰撞体/PVS/出生点/传送点 JSON），
 * 本类承担 GLTFLoader 建场景及 LOD/PVS/雾/碰撞箱/准星/lightmap 等子管理器。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
// mosaic 画质切换：主线程懒初始化同一 wasm 模块（与 worker 实例互不影响）
import { ensureMainWasm, mosaic_decode } from '../main-wasm.js';
// 主线程唯一物理线：PhysWorld 与 BspProcessor 同模块（main-wasm 已 initSync）
import { PhysWorld } from '../../pkg/websurf_wasm.js';
import type { RuntimeConfig } from '../config.js';
import type { PlaneInfo, SceneDataMessage } from '../worker/worker-types.js';
import type { SharedState } from '../../../../src/ts-shared/auth/shared-state.js';
import { AuthorityCalibrator } from '../../../../src/ts-shared/phys/authority-calibrator.js';
import type { Brush } from '../physics/physics/Collision/Collision.types.js';
import { PvsManager } from '../../../../src/ts-shared/world/pvs-manager.js';
import type { TeleportTrigger } from '../world/teleport-manager.js';
import { TeleportManager } from '../world/teleport-manager.js';
import { adaptBrushes } from '../world/collider-adapter.js';
import { CameraController } from './camera-controller.js';
import { ColliderDebug } from './collider-debug.js';
import { LightManager } from './light-manager.js';
import { LodManager } from './lod-manager.js';
import { PathRecorder } from './path-recorder.js';
import type { DistStats } from './path-recorder.js';
import type { InputReplayInitialState, InputReplayHull } from '../input/input-recorder.js';
import { buildDebugPredictionParams } from '../physics/prediction-params.js';
import { PlaneInspector } from './plane-inspector.js';
import { applyLightmapToMeshes, loadLightmapAtlas } from './lightmap-shader.js';

/**
 * 渲染采样传输契约（实现 = `src/ts-shared/auth/shared-state.ts` 的 ShmState/MsgState，
 * 两者同签名；本文件直接调 `this.shared.*`，由 typecheck 保证契约一致）：
 * ```ts
 * writeRenderSample(tMs, x, y, z, i0): void;  // 与 path-recorder.addRender 同拍同源
 * resetRenderSample(): void;                  // 失效世代 +1（Worker 丢弃缓存）
 * readPublishedTau(): number;                 // 最近一次权威发布所用的渲染时钟 τ（ms；0=未发布）
 * ```
 * ⚠️ `writeRenderSample` **不接受 epoch 参数**（缺陷修复 · epoch 竞态）：世代槽由
 * shared-state 自持，写入时就地读——调用方传旧世代的写法曾把
 * `bumpSampleEpoch()` 自增过的槽"改回过去"，使 Worker 继续在旧世界样本对上插值
 * （详见 shared-state.ts 同名方法注释）。
 * R1：写侧只有 5 个 f64 载荷 store + 一对 seqlock 原子戳（既有 i64 槽），
 * **无分配对象、无同步等待**（不阻塞渲染帧）；读侧（readPublishedTau）只在记录中调用。
 */

/** 视场角（度）。 */
const FOV = 73.6;
/** 准星射线检测限流（每 N 帧一次）。 */
const PLANE_INSPECT_INTERVAL = 6;
/** 近裁剪面下限（HU）：贴墙时近平面动态收缩到最近几何距离的 80%（不低于此值），
 * 防近平面裁剪穿墙；相机位置不动，只改投影矩阵。 */
const CAMERA_NEAR_MIN = 0.05;
/** 近平面收缩探测距离（HU）默认值：相机距墙最小距离 = 碰撞箱半宽（默认 16，
 * 蹲下/半宽缩放后更近），射线必须能覆盖该距离才能探测到面前的墙——探测距离
 * 过小则射线够不到墙面，贴墙时 near 保持默认大值，墙被近平面裁剪 → 透视看到
 * 地图外面。
 * 现行方案：默认 100，updateNearPlane 用 **4 个水平正交方向**（±forward /
 * ±right）射线取最近命中 minD → near = minD × NEAR_RATIO_DEFAULT(0.3) 收缩，
 * 空旷恢复默认 near。每 2 帧轮询一次（nearCheckToggle），noclip 下跳过。
 *
 * 运行时可调：面板「显示设置 → 近平面探测距离/收缩系数」实时生效
 * （setNearParams）。
 */
const NEAR_PROBE_DIST_DEFAULT = 100;
/** near 收缩系数默认值：near = 最近几何距离 × 此值。 */
const NEAR_RATIO_DEFAULT = 0.3;

/** 剔除统计回调（主线程直接更新 UI）。 */
export interface CullStatsLike {
  visible: number;
  total: number;
  cullDist: number;
  pvs: {
    cluster: number;
    visibleClusters: number;
    totalClusters: number;
    pvsHidden: number;
    near: number;
    far: number;
  };
}

/** 主线程渲染物理事件（Rust take_event 消费：计时挑战检查点/死亡）。 */
export interface RenderPhysEvent {
  kind: string;
  /** teleport 目标名。 */
  targetname?: string;
  /** teleport 目标位置（Y-up）。 */
  origin?: number[];
  /** teleport 目标 yaw（度）。 */
  yaw?: number;
}

// ── 空间分块合并参数（optimizeScene：GLB 挂载后渲染减负）──────────
// 为什么需要：surf_666 的 GLB 实测 **117 glTF mesh / 34409 primitive / 377385 顶点 /
// 319 材质（136MB）**，而 GLTFLoader 对**每个 primitive 生成一个 THREE.Mesh** →
// 场景约 3.4 万个 Mesh 对象（debug 页面实测 35254）。未合并时每帧要：
//   ① renderer.render 对 3.5 万对象做视锥剔除 + 逐 mesh draw call；
//   ② LodManager.update 线性扫 items（3.5 万项，含逐项 PVS isVisible 检查）；
//   ③ updateNearPlane 对整棵 BSP 场景 traverse + 逐 mesh 包围球测试（每 2 帧）。
// 三者都随 Mesh 数线性增长 → 帧耗时逼近/超过 vsync 间隔 → 掉帧与卡顿。
// 实测（headless Edge + 真实 GPU，surf_666）：合并后帧间隔 mean 3.12ms（~320 FPS）、
// 400 帧内 0 次 >33ms；未合并路径见 scripts/optimize-scene-verify.mjs 与提交历史。
// 分块合并把 3.4 万对象 → 数百~数千块（块内按材质子合并，draw call = 材质数而非
// mesh 数）。
// 移植来源：game/src/renderer/renderer-main.ts::optimizeScene（该实现又移植自
// test/dual-mode-harness/src/worker-b.ts optimizeScene，已验证 34409 mesh → 数百块）。
// debug 此前直接 `scene.add(gltf.scene)`（本文件 loadScene），**没有任何合并/批处理**，
// 这是 debug 流畅度低于 game 的主因。
/** 目标 cell 数（cell 大小 = 世界包围盒对角线 / cbrt(目标块数)，自适应微调区间 [300,800]）。 */
const OPT_TARGET_CELLS = 512;
/** 分块合并总开关。false = 复现未合并的原始渲染路径（仅用于 A/B 基准测量）。 */
const OPTIMIZE_SCENE_ENABLED = true;
/** 非空 cell 数目标下限/上限（自适应微调）。 */
const OPT_MIN_CELLS = 300;
const OPT_MAX_CELLS = 800;
/** cell 大小钳制（world units；surf_666 世界 ~16320 → cell ≈ 512~1024 数量级）。 */
const OPT_CELL_MIN = 128;
const OPT_CELL_MAX = 4096;
/**
 * 视锥外保留圈（frustum culling 包围球膨胀系数）：three.js 每帧按 geometry.boundingSphere
 * 判定剔除——半径 ×FRUSTUM_PAD 后，视锥外约 (FRUSTUM_PAD-1)×半径 的块仍渲染（疯狂晃动/快速
 * 转动时，新进入视锥的几何上一帧已预渲染 → 边缘不空白）。
 */
const FRUSTUM_PAD = 1.6;

/** 分块收集的 mesh + 世界包围盒中心（分块键用）。 */
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

/** 主线程渲染器。 */
export class RendererMain {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private cameraController: CameraController | null = null;
  private pvsManager: PvsManager | null = null;
  private teleportManager: { getTriggers(): readonly TeleportTrigger[] } | null = null;
  /** 实体碰撞体列表（碰撞箱可视化，solids + ladders 合并）。 */
  private colliders: Brush[] = [];
  /** solids 列表（准星射线检测区分 brushType）。 */
  private solids: Brush[] = [];
  /** ladders 列表（准星射线检测区分 brushType）。 */
  private ladders: Brush[] = [];
  /** 传送触发器列表（准星射线检测 trigger）。 */
  private triggers: TeleportTrigger[] = [];
  /** BSP 模型场景组（准星射线检测 mesh）。 */
  private bspModelScene: THREE.Object3D | null = null;

  private readonly lightManager = new LightManager();
  /** 物理路径记录器（渲染物理线 + tick 物理线；脚底中心点）。 */
  private readonly pathRecorder = new PathRecorder();
  private readonly lodManager = new LodManager();
  private readonly colliderDebug = new ColliderDebug();
  private readonly planeInspector = new PlaneInspector();

  private planeInfoEnabled = false;
  private planeInspectCounter = 0;
  private lastPlaneInfo: PlaneInfo | null = null;

  // ── 近平面贴墙自适应（面板可实时调节）────────────────────
  /** 探测距离（HU）；↑ 更斜掠射也能命中，粗筛候选略增。 */
  private nearProbeDist = NEAR_PROBE_DIST_DEFAULT;
  /** near 收缩系数：near = 最近几何距离 × 此值；↓ 更保守更不易裁墙。 */
  private nearRatio = NEAR_RATIO_DEFAULT;

  private config: RuntimeConfig = null as unknown as RuntimeConfig;
  private needsRender = true;
  private rafId = 0;
  private running = false;

  // ── 主线程唯一物理线（阶段 1：LERP 删除、渲染直读 state()）──
  /** 主线程 PhysWorld 实例（唯一物理渲染线：世界+碰撞+输入；每帧 tick 推进）。 */
  private predPhys: PhysWorld | null = null;
  /** 主线程物理就绪（buildPredictionWorld 完成）。 */
  private predReady = false;
  /** 待喂给物理实例的输入（app 事件回调累积）。 */
  private pendingDx = 0;
  private pendingDy = 0;
  private pendingKeys = 0;
  /** noclip 模式（Rust set_noclip，tick 走 noclip_step 无碰撞纯移动）。 */
  private noclipActive = false;
  /** 渲染帧推进（dt 上限防异常）。 */
  private lastTickMs = 0;

  // ── 输入回放模式（debug 专属确定性复现工具；见 input/input-recorder.ts）──────
  /**
   * 回放期帧步长覆盖（秒）。设置后**本帧**用它替代墙钟 dt，下一刻自动清空。
   *
   * 为什么必须覆盖：录制端帧步长序列是录制的一部分（同一份输入 + 不同帧步长 =
   * 不同轨迹）。回放时用墙钟 dt 会让轨迹从第二帧起分叉，`input-replay-verify`
   * 测到的位置差会到数百 HU；回放用**录制帧间隔**才能复现轨迹。
   */
  replayDtS: number | null = null;
  /** 回放模式：跳过权威帧校准（见 tick 内注释）。 */
  private replayMode = false;
  /**
   * **单步闸门**（诊断用，见 `setManualSteps`）：gated 时每帧最多推进 `stepQuota` 个
   * 物理步；配额耗尽则跳过物理推进。给无头验证一个"帧步进可控"的环境——排除
   * "两轮比较之间物理多走了一帧"这类时序假象。
   */
  private stepGated = false;
  private stepQuota = 0;
  /** 死亡阈值 Y（loadScene 回调记录；buildPredictionWorld 时应用）。 */
  private deathY: number | null = null;

  // ── 权威帧校准（阶段 2，公共化：AuthorityCalibrator 收敛到 ts-shared）──
  /** 权威校准（correctFromAuthority 三条件 OR + 250ms 冷却 + syncInFlight 回滚、
   * calibrateVelocity 外推、applyCollisionCorrection <60 微调、resetTo 归零）。 */
  private readonly calibrator: AuthorityCalibrator;

  // ── 渲染采样传输（Worker 权威发布位置 = 渲染轨迹上的一个采样点）──────
  // 契约见文件头（writeRenderSample / resetRenderSample / readPublishedTau）。
  /**
   * 渲染采样序号（**单调递增**；与 `PathRecorder` 的 render 节点索引空间同拍同源
   * ——`addRender` 恒落点，两者在同一帧同一处 +1，故 `i0` = 该节点在记录器里的下标）。
   * 仅在 `clearPath()`（记录器索引空间重启）时归零；跨失效代不归零（代由 `shared`
   * 世代槽表达，Worker 按代丢弃缓存；序号保持单调可避免与旧代残留项撞号）。
   */
  private renderSampleIndex = 0;
  /**
   * 采样流**失效世代**（**渲染器侧本地镜像，只用于诊断/日志**）：
   * resetTo（respawn/传送/检查点回退）/ 换图（buildPredictionWorld、disposeScene）/
   * noclip 切换时 +1，并同时调用 `shared.resetRenderSample()` 让 Worker 丢弃旧代缓存
   * （缓存里的渲染采样对新位置毫无意义，继续投影会把权威位置钉在旧轨迹上）。
   *
   * ⚠️ **不再随 `writeRenderSample` 过线**（缺陷修复 · epoch 竞态）：权威世代槽由
   * `shared-state.ts` 独占并自持，`writeRenderSample` 写入时就地读槽内值。此前渲染器
   * 把自己这份缓存当参数传过去，任何在途/延迟的写入都会把 `resetRenderSample()` 刚
   * 自增的世代**写回旧值**，Worker 便继续在旧世界样本对上插值。本字段保留只作
   * 渲染器侧**计数器**（不参与跨线程协议，见 init() 的跨线程通道日志）。
   */
  private sampleEpoch = 0;

  /** 失效世代 +1 + 通知 Worker 丢弃缓存（两者必须成对，见 sampleEpoch 注释）。 */
  private bumpSampleEpoch(): void {
    this.sampleEpoch++;
    this.shared.resetRenderSample();
  }

  // ── 近平面自适应（防穿墙：不移动相机，动态收缩 near）────────
  private readonly _nearRaycaster = new THREE.Raycaster();
  private readonly _nearOrigin = new THREE.Vector3();
  private readonly _nearDirF = new THREE.Vector3();
  private readonly _nearDirR = new THREE.Vector3();
  private readonly _nearSphere = new THREE.Sphere();
  private nearCheckToggle = false;
  /** 场景默认 near（maxDim/1000 下限 NEAR_MIN）。 */
  private defaultNear = CAMERA_NEAR_MIN;

  /** 剔除统计回调（主线程更新 UI）。 */
  onCullStats: ((stats: CullStatsLike) => void) | null = null;
  /** 场景加载完成回调（携带死亡阈值 Y 下限，主线程回传 Worker）。 */
  onSceneLoaded: ((deathThresholdY: number) => void) | null = null;

  /**
   * 渲染主线 → 权威同步回调（兜底/重锚触发时携带渲染主线帧完整状态；app.ts
   * 注册后发 `sync-render-state` 消息给 Worker 权威物理）。
   *
   * @param teleport true = 传送/重生/换图类**真正的位置突变**（Worker 侧清未消费
   *   输入增量）；false = 常规反向重锚（缺陷修复 A，Worker 侧保留输入增量——
   *   否则每次例行对齐都丢一次鼠标增量 = 可见瞄准顿挫）。
   */
  onSyncRenderState: ((s: {
    posX: number; posY: number; posZ: number;
    yaw: number; pitch: number;
    velX: number; velY: number; velZ: number;
    onGround: boolean;
    eyeHeight: number;
  }, teleport: boolean) => void) | null = null;

  /** 渲染物理事件回调（Rust take_event 消费：计时挑战检查点/死亡统计）。 */
  onPhysEvent: ((ev: RenderPhysEvent) => void) | null = null;

  // ── 纹理画质切换（mosaic）──────────────────────────────────
  /** 画质 manifest：{ 纹理名(小写 basetexture): mosaic 字节码 }。 */
  private mosaicManifest: Record<string, string> | null = null;
  /** 原始贴图图像缓存（切换回 original 时恢复）。 */
  private readonly origTextureImages = new Map<THREE.Texture, unknown>();

  constructor(
    private readonly shared: SharedState,
  ) {
    // config 在 init() 中赋值
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

  // ── 生命周期 ───────────────────────────────────────────────

  /** 初始化渲染器/场景/相机与子管理器。 */
  init(canvas: HTMLCanvasElement, width: number, height: number, dpr: number, config: RuntimeConfig): void {
    this.config = config;
    // 阶段 1：SharedState 注入保留（后续阶段接 SAB 权威帧通道）；本阶段渲染直读本地物理，不再读其输出
    console.log(`[renderer] 跨线程通道: ${this.shared.isShared ? 'SAB' : 'MsgState'}（阶段 1 渲染直读本地物理）`);
    console.log(`[renderer] 渲染采样失效世代计数（本地诊断，非协议值）: ${this.sampleEpoch}`);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();
    // 物理路径可视化（不挂 bspModelScene 下：它只随场景加载重建，路径要跨换图保留，
    // 且 frustumCulled=false 不受剔除影响）
    this.scene.add(this.pathRecorder.group);

    const aspect = width / Math.max(height, 1);
    this.camera = new THREE.PerspectiveCamera(FOV, aspect, 0.1, 100000);
    this.camera.position.set(2000, 2000, 2000);

    this.cameraController = new CameraController(this.camera, config.input);

    this.lightManager.applyLights(this.scene, config);
    this.colliderDebug.init(this.scene);
    this.colliderDebug.setDebugFlags(
      config.debug.showSolids,
      config.debug.showTriggers,
      config.debug.triggerViewDistance,
      config.debug.brushViewDistance,
    );
    this.colliderDebug.setTriDebugFlags(
      config.debug.showPhy,
      config.debug.showVis,
      config.debug.phyViewDistance,
      config.debug.visViewDistance,
    );
    this.colliderDebug.setChamferDebugFlags(
      config.debug.showChamfers,
      config.debug.chamferViewDistance,
    );
    this.planeInfoEnabled = config.debug.showPlaneInfo;

    this.needsRender = true;
  }

  /**
   * 卸载当前地图的全部渲染资源（触发文件输入/加载新地图时调用）。
   *
   * three.js 的 `scene.remove()` 只摘除场景图，geometry/material/纹理等
   * GPU 侧资源不会自动释放——多次加载地图会累积显存与 JS 堆，导致
   * 帧率逐步下降。本方法递归 dispose 全部 BSP 模型资源，并清空
   * LOD/PVS/碰撞可视化/插值缓存等子管理器状态。
   *
   * 保留：灯光、雾（由 LightManager/FogManager 独立管理，替换式更新）。
   */
  disposeScene(): void {
    // 1. BSP 模型：递归释放 geometry/material/纹理（GPU 真正释放）
    if (this.scene) {
      for (let i = this.scene.children.length - 1; i >= 0; i--) {
        const child = this.scene.children[i];
        if (child.userData?.isBspModel) {
          this.disposeObject(child);
          this.scene.remove(child);
        }
      }
    }
    this.bspModelScene = null;

    // 2. three.js 渲染列表（GPU 侧 draw-call 缓存）
    this.renderer?.renderLists?.dispose();

    // 3. 子管理器状态清零
    this.lodManager.dispose();
    this.pvsManager = null;
    this.teleportManager = null;
    this.colliders = [];
    this.solids = [];
    this.ladders = [];
    this.triggers = [];
    // 碰撞可视化清空（保留 group/scene 引用，新地图 rebuild 直接复用）
    this.colliderDebug.clearAll();

    // 4. 主线程物理渲染线状态清零（防跨地图残留输入）
    this.predPhys = null;
    this.predReady = false;
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
    this.noclipActive = false;
    this.lastTickMs = 0;
    this.deathY = null;
    // 权威帧校准状态清零（防跨地图残留权威帧注入新地图）
    this.calibrator.clear();
    // 换图：渲染采样流不连续 → 失效代数 +1（Worker 丢弃旧图缓存）
    this.bumpSampleEpoch();
    this.needsRender = true;
  }

  /** 递归释放 Object3D 子树的 geometry/material/纹理（GPU 侧真正释放）。 */
  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if (!mat) continue;
        // 释放材质引用的纹理（map/lightMap/emissive 等；重复 dispose 幂等安全）
        for (const key of [
          'map',
          'lightMap',
          'emissiveMap',
          'normalMap',
          'roughnessMap',
          'metalnessMap',
          'aoMap',
          'alphaMap',
          'bumpMap',
          'specularMap',
          'envMap',
        ]) {
          const tex = (mat as unknown as Record<string, unknown>)[key] as
            | THREE.Texture
            | undefined;
          if (tex?.isTexture) tex.dispose();
        }
        mat.dispose();
      }
    });
  }

  /** 加载场景数据（GLB + PVS + 碰撞体 + 传送点 + lightmap + 雾；主线程本地数据）。 */
  async loadScene(data: SceneDataMessage): Promise<{ diagonal: number; defaultCull: number; maxCull: number } | null> {
    if (!this.scene || !this.camera) return null;
    this.disposeScene();

    const gltf = await this.loadGlb(data.glb);
    const scene = new THREE.Scene();
    gltf.scene.userData.isBspModel = true;
    this.resetRootRotations(gltf);
    scene.add(gltf.scene);
    this.collectMetadata(scene);

    // lightmap（存在时应用；主线程 GLB 解析期生成）
    const atlasTexture = await loadLightmapAtlas(gltf.parser, gltf);
    if (atlasTexture) {
      applyLightmapToMeshes(scene, atlasTexture);
    }
    // 空间分块合并：3.4 万 mesh → 数百~数千块（渲染减负核心）。
    // 必须在本行之后的 updateMatrixWorld/boundingBox 与 LOD·PVS 注册
    //（lodManager.setup + assignClusterIds 的 traverse）**之前**执行——
    // ① 块几何已烘焙世界空间，包围盒/相机 near·far 需按块重算；
    // ② LOD items 与 PVS clusterId 应注册到分块后的 mesh（数量级相差 ~100×）。
    // 放在 lightmap 之后：lightmap 按原 mesh 的材质/UV 施加，材质实例在合并中
    // 去重保留，映射关系不丢。
    if (OPTIMIZE_SCENE_ENABLED) this.optimizeScene(scene, gltf.scene);
    scene.updateMatrixWorld(true);
    const boundingBox = new THREE.Box3().setFromObject(scene);
    const size = boundingBox.getSize(new THREE.Vector3());

    // 移除旧 BSP 模型子树（disposeScene 已处理旧资源，此处摘除引用防叠加）
    for (let i = this.scene.children.length - 1; i >= 0; i--) {
      const child = this.scene.children[i];
      if (child.userData?.isBspModel) {
        this.scene.remove(child);
      }
    }
    scene.userData.isBspModel = true;
    this.bspModelScene = scene;
    this.scene.add(scene);

    const maxDim = Math.max(size.x, size.y, size.z);
    this.defaultNear = Math.max(maxDim / 1000, CAMERA_NEAR_MIN);
    this.camera.near = this.defaultNear;
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();

    // LOD/PVS 注册（主线程本地数据源）
    const diagInfo = this.lodManager.setup(scene, this.config);
    this.pvsManager = new PvsManager(data.pvsJson);
    this.lodManager.assignClusterIds(this.pvsManager);

    // 传送触发器（本地解析；碰撞箱可视化 + 准星射线）
    this.teleportManager = new TeleportManager(data.teleportJson);
    this.triggers = [...this.teleportManager.getTriggers()];
    this.colliderDebug.setTriggers(this.triggers);
    if (data.triJson) {
      this.colliderDebug.setTriMeshes(JSON.parse(data.triJson));
    }

    // 纹理画质 manifest + 按当前画质应用（mosaic 切换数据源）
    this.mosaicManifest = data.mosaicManifest
      ? (JSON.parse(data.mosaicManifest) as Record<string, string>)
      : null;
    void this.applyTextureQuality(this.config.texture.quality);

    // 实体碰撞体（碰撞箱可视化 + 准星射线；主线程本地 adaptBrushes）
    const adaptResult = adaptBrushes(data.brushJson);
    this.colliders = [...adaptResult.solids, ...adaptResult.ladders];
    this.solids = adaptResult.solids;
    this.ladders = adaptResult.ladders;

    // 雾：已移除（照搬 game——game 无雾）。原实现按场景包围球设 scene.fog 并按相机
    // 距离动态调 near/far；A/B 实测本图出生视角下与关闭无差异，且 game 无此机制，故对齐移除。

    // 剔除距离校准（场景加载后）
    this.config.lod.cullDistance = this.lodManager.cullDistance;

    this.needsRender = true;
    this.onSceneLoaded?.(boundingBox.min.y);
    this.emitCullStats();
    return {
      diagonal: diagInfo.diagonal,
      defaultCull: diagInfo.defaultCull,
      maxCull: diagInfo.maxCull,
    };
  }

  /** 启动 rAF 渲染循环。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.rafId = requestAnimationFrame(this.boundTick);
  }

  /** 停止渲染循环。 */
  stop(): void {
    this.running = false;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  // ── 渲染循环（阶段 1：主线程物理渲染线）──────────────────────

  private readonly boundTick = this.tick.bind(this);

  private tick(now: number): void {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.boundTick);
    if (!this.renderer || !this.scene || !this.camera || !this.cameraController) return;

    // 1. 主线程渲染物理线 + Worker 权威帧校准（阶段 2，game 同序）：
    //    写输入 SAB（Worker 权威模拟同输入）→ 读权威帧 → 外推校准 → tick → 渲染
    // 回放模式：**只认录制 dt，绝不回落墙钟 dt**。没有待消费的录制 dt = 本显示帧不是
    // 录制帧（回放端还没喂下一帧）→ 整帧跳过物理推进（渲染/统计照常）。
    // 不这样做，物理步长就是 rAF 墙钟值：320fps 下 3ms 的抖动经 surf 接触面敏感度
    // 放大，实测两条独立回放第 67 帧就分叉、最大差 3968 HU。
    // 回放期**优先**用录制步长（replayPending）；没有待消费步长时回落墙钟 dt。
    // **绝不能**在缺步长时整帧跳过物理：`setReplayMode(true)` 也被"只关权威耦合"的
    // 录制路径使用（`recordScript(..., true)`），那时没有任何回放在驱动，跳过会让物理
    // 彻底停摆——而录制点在物理步上，于是录到 0 帧（实测对照实验 A：export 为空 →
    // load 0 帧 → play 返回 false）。跳过是"回放确定性"的手段，不能拿录制功能做代价。
    const replayPending = this.replayMode ? this.replayDtS : null;
    if (this.predReady && this.predPhys && (!this.stepGated || this.stepQuota > 0)) {
      // 单步闸门（诊断；见 setManualSteps）：gated 且配额耗尽 → 本帧跳过物理推进
      // （渲染/统计照常）。连续模式下 stepGated=false，恒真。
      if (this.stepGated) this.stepQuota--;
      // 回放模式：dt 用录制帧间隔（见 replayDtS）。墙钟 dt 下同一份输入也复现不出轨迹。
      const dt = replayPending !== null
        ? replayPending
        : (this.lastTickMs === 0 ? 1 / 64 : Math.min((now - this.lastTickMs) / 1000, 0.1));
      // 一次性消费：每帧必须由回放端重新提供，否则会静默沿用上一帧步长
      this.replayDtS = null;
      this.lastTickMs = now;
      // 输入 → SAB 输入槽（Worker 权威帧模拟消费；与主线程同输入）
      this.shared.addInput(this.pendingDx, this.pendingDy, this.pendingKeys);
      // 权威帧到达 → 记录（只读）；首次 set_state 起点；大偏差异常兜底
      if (!this.replayMode) this.correctFromAuthority();
      // 权威速度外推校准（考虑中途地图碰撞后的正确速度；位置不覆盖）
      if (!this.replayMode) this.calibrateVelocity(now);
      // 路径记录 —— tick 物理线：Worker 权威帧，**只在 V_A 变化（真来了新帧）落点**，
      // 即「按 tick 的计算节点采样」，不做定时轮询。
      // 时间戳 = **渲染时钟 τ**（`readPublishedTau()`：本帧发布所依据的渲染采样时刻）：
      // 权威的**发布位置**就是渲染轨迹上的一个采样点，用 τ 记时，"同时刻比较"才是
      // 同一点（面板偏差梳 ≈0）。旧实现用轮询时刻 `now`——那会把几何上重合的两点
      // 读成切向滞后（几十 HU，等于把 τ→now 的帧龄当成物理分歧）。
      // 注意此刻意**不用** `auth.frame.timeMs`：Worker 与主线程 performance.now 基准
      // 不同（实测固定偏移 ≈127ms）且被整数毫秒量化。
      // τ=0（该帧未做投影，如旧构建/缓存刚失效）→ 回落 `now`（= 旧行为）。
      if (this.pathRecorder.isRecording) {
        const auth = this.shared.readAuthoritative();
        if (auth) {
          const tau = this.shared.readPublishedTau();
          // residual（权威 post-tick 位置 vs 发布位置）只在 Worker 侧可得，共享层未暴露
          // 取用口 → 传 undefined（见交付报告 FILES/局限说明）。
          this.pathRecorder.addTick(
            auth.va,
            tau > 0 ? tau : now,
            auth.frame.pos.x,
            auth.frame.pos.y,
            auth.frame.pos.z,
            undefined,
          );
        }
      }
      // 完整物理推进：physics = 碰撞/传送/死亡/reset；noclip = noclip_step（无碰撞）
      this.predPhys.tick(dt, this.pendingKeys, this.pendingDx, this.pendingDy);
      this.pendingDx = 0;
      this.pendingDy = 0;
      // 物理事件消费（计时挑战：teleport 检查点 / death 回退，回调 app.ts）
      this.consumePhysEvents();
      // 渲染 = 主线程物理状态（Rust 输出角度为度 → 弧度）
      const st = this.predPhys.state() as {
        posX: number; posY: number; posZ: number;
        yaw: number; pitch: number;
        eyeHeight: number;
      };
      // 路径记录 —— 渲染物理线：主线程 predPhys 每个 rAF 物理步一个节点
      //（posY 即脚底：同函数下方 camY = posY + eyeHeight 可证）。
      this.pathRecorder.addRender(now, st.posX, st.posY, st.posZ);
      // 同一拍、同一三元组写入渲染采样传输（Worker 权威发布位置的投影基准）：
      // 与 `addRender` 的下标一一对应（i0 = 刚落点的 render 节点下标）。
      // 不传 epoch：世代由 shared-state 就地读（防把 bumpSampleEpoch 的 +1 写回旧值）
      this.shared.writeRenderSample(now, st.posX, st.posY, st.posZ, this.renderSampleIndex++);
      const cc = this.cameraController;
      cc.setYawPitch(st.yaw * DEG2RAD, st.pitch * DEG2RAD, false);
      cc.update();
      // 相机位置 = 眼睛（origin + eyeHeight），不做位置修正——防穿墙靠近平面自适应
      const camY = st.posY + st.eyeHeight;
      cc.setPosition(st.posX, camY, st.posZ);

      // 近平面自适应（每 2 帧）：贴墙收缩 near 防近平面裁剪透视；
      // noclip 位置不受碰撞约束，跳过探测
      this.nearCheckToggle = !this.nearCheckToggle;
      if (this.nearCheckToggle && !this.noclipActive && this.bspModelScene) {
        this.updateNearPlane(st.posX, camY, st.posZ);
      }
    } else if (this.stepGated) {
      // 闸门跳过物理的帧也要推进墙钟基准，否则闸门恢复时会拿到一个异常大的 dt
      this.lastTickMs = now;
    }

    const camPos = this.camera.position;

    // 2. 视距剔除（照搬 game：lodItems 中心距离 > cullDistance → 隐藏；无 PVS、无迟滞）
    if (this.lodManager.itemCount > 0) {
      if (this.lodManager.update(camPos, this.config)) {
        this.needsRender = true;
      }
    }

    // 4. 碰撞箱可视化
    if (this.colliderDebug.hasDebugWork) {
      if (this.colliderDebug.update(camPos, this.colliders, this.config)) {
        this.needsRender = true;
      }
    }

    // 5. 准星射线检测（限流）
    if (this.planeInfoEnabled) {
      this.planeInspectCounter++;
      if (this.planeInspectCounter >= PLANE_INSPECT_INTERVAL) {
        this.planeInspectCounter = 0;
        this.inspectPlane();
      }
    } else if (this.lastPlaneInfo !== null) {
      this.lastPlaneInfo = null;
    }

    // 6. 渲染：物理就绪后每帧无条件渲染（帧率跟随 rAF，不降频/限流）。
    //    needsRender 仅用于强制刷新（加载场景、LOD 变化等）。
    const shouldRender = this.predReady || this.needsRender;
    if (shouldRender) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }

    // 7. 周期剔除统计（主线程本地计算）
    if (now - this.lastStatsAt > 100) {
      this.lastStatsAt = now;
      this.emitCullStats();
    }
  }

  private lastStatsAt = 0;

  /** 准星射线检测（从相机正前方发射，与 mesh/碰撞体/触发器求交）。 */
  private inspectPlane(): void {
    if (!this.camera || !this.bspModelScene) return;
    this._fwdDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.lastPlaneInfo = this.planeInspector.cast(
      this.camera.position,
      this._fwdDir,
      this.bspModelScene,
      this.solids,
      this.ladders,
      this.triggers,
    );
  }

  /**
   * 近平面自适应：检测相机 4 方向（相机局部系，4 水平正交）NEAR_PROBE_DIST 内最近的 mesh，动态设置 camera.near。
   * - 贴墙 → near = max(最近距离 × 0.8, CAMERA_NEAR_MIN)，墙面不被裁剪（相机不动，仅改投影）
   * - 空旷 → 恢复场景默认
   * 性能：包围球粗筛候选后做 4 方向 raycaster，每 2 帧一次。
   */
  private updateNearPlane(px: number, py: number, pz: number): void {
    const camera = this.camera;
    const scene = this.bspModelScene;
    if (!camera || !scene) return;
    this._nearOrigin.set(px, py, pz);
    const probe = this.nearProbeDist;

    // 1. 包围球粗筛
    const candidates: THREE.Mesh[] = [];
    scene.traverse((obj) => {
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
        ? Math.max(minD * this.nearRatio, CAMERA_NEAR_MIN)
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
    this.needsRender = true;
  }

  // ── 外部接口 ───────────────────────────────────────────────

  /** 最近一次准星检测结果（HUD 读取）。 */
  getPlaneInfo(): PlaneInfo | null {
    return this.lastPlaneInfo;
  }

  /** 调整渲染器与相机尺寸。 */
  resize(width: number, height: number): void {
    if (!this.renderer || !this.camera) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  /** 设置视距剔除距离。 */
  setCullDistance(dist: number): void {
    this.lodManager.setCullDistance(dist);
    this.config.lod.cullDistance = this.lodManager.cullDistance;
    this.needsRender = true;
  }

  // ── 物理路径记录（控制面板）──────────────────────────────────
  // 两条线：渲染物理（主线程 predPhys，每 rAF 物理步）/ tick 物理（Worker 权威帧，每新帧）。
  // 记录节点 = 脚底中心点（PhysWorld 原点 x/y/z）。

  /** 开始记录。 */
  startPathRecording(): void {
    this.pathRecorder.start();
    this.needsRender = true;
  }

  /** 停止记录（已记录的点保留）。 */
  stopPathRecording(): void {
    this.pathRecorder.stop();
  }

  /** 是否正在记录。 */
  isPathRecording(): boolean {
    return this.pathRecorder.isRecording;
  }

  /** 清空已记录的路径（不影响记录状态）。 */
  clearPath(): void {
    this.pathRecorder.clear();
    // 记录器 render 节点索引空间重启 → 采样序号同步归零（i0 与节点下标一一对应）；
    // 序号归零必须配一个失效代数 +1，否则新 i0 会与 Worker 缓存里的旧代同号项混淆。
    this.renderSampleIndex = 0;
    this.bumpSampleEpoch();
    this.needsRender = true;
  }

  /** 显示/隐藏路径折线（整组）。 */
  setPathVisible(visible: boolean): void {
    this.pathRecorder.setVisible(visible);
    this.needsRender = true;
  }

  /** 单独显示/隐藏渲染物理线（对比时关掉它，tick 线的粗折角才看得清）。 */
  setPathRenderVisible(visible: boolean): void {
    this.pathRecorder.setRenderVisible(visible);
    this.needsRender = true;
  }

  /** 单独显示/隐藏 tick 物理线（含节点标记）。 */
  setPathTickVisible(visible: boolean): void {
    this.pathRecorder.setTickVisible(visible);
    this.needsRender = true;
  }

  /** 单独显示/隐藏偏差梳（每个 tick 节点 → 渲染线同时刻位置的连线）。 */
  setPathDeviVisible(visible: boolean): void {
    this.pathRecorder.setDeviVisible(visible);
    this.needsRender = true;
  }

  /** 单独显示/隐藏 tick 节点方点（方点密集时会连成"方链"，关掉只看线）。 */
  setPathDotsVisible(visible: boolean): void {
    this.pathRecorder.setDotsVisible(visible);
    this.needsRender = true;
  }

  /** 折线形状自检：段数 / 轴对齐数 / 折角>45° 数 / 绘制长度 / 节点直线长度 / 比值。 */
  getPathShapeStats(): {
    total: number;
    axis: number;
    hard45: number;
    drawnLen: number;
    directLen: number;
    lenRatio: number;
  } {
    return this.pathRecorder.shapeStats();
  }

  /**
   * 路径距离统计（HU）——三组量分开，勿混用：
   * - `perp`：**垂距**（tick 点到渲染折线的最短距离）= 验收口径；面板「垂距 p95」
   *   （HUD 为 ±250ms 近似窗；**权威判定 = debug/scripts/path-acceptance.mjs**）
   * - `mean/max/green/yellow/red`：**偏差梳**（时间对齐：tick 点 vs 同时刻渲染位置）
   * - `residual`：**残差**（权威 post-tick 位置 vs 发布位置；主线程拿不到时 n=0）
   */
  getPathDeviStats(): {
    n: number;
    mean: number;
    max: number;
    green: number;
    yellow: number;
    red: number;
    perp: DistStats;
    residual: DistStats;
  } {
    return this.pathRecorder.deviStats();
  }

  /** 路径折线是否可见。 */
  isPathVisible(): boolean {
    return this.pathRecorder.visible;
  }

  /** 已记录点数（两条线各自）。 */
  getPathCounts(): { render: number; tick: number } {
    return this.pathRecorder.counts();
  }

  /** 导出 JSON（含两条线的时间序列；meta 可带地图名/模式等会话标签）。 */
  exportPathJson(meta?: Record<string, unknown>): string {
    return this.pathRecorder.toJson(meta);
  }

  /** 导出 CSV（line,t_ms,x_hu,y_hu,z_hu）。 */
  exportPathCsv(): string {
    return this.pathRecorder.toCsv();
  }

  /** 应用配置 patch（config 消息同步：lighting/debug 段在主线程生效）。 */
  applyConfigPatch(section: keyof RuntimeConfig, patch: Record<string, unknown>): void {
    const target = this.config[section];
    if (!target || typeof target !== 'object') return;
    Object.assign(target, patch);
    if (section === 'lighting') {
      this.lightManager.syncFromConfig(this.config);
      this.needsRender = true;
    } else if (section === 'debug') {
      this.colliderDebug.setDebugFlags(
        this.config.debug.showSolids,
        this.config.debug.showTriggers,
        this.config.debug.triggerViewDistance,
        this.config.debug.brushViewDistance,
      );
      this.colliderDebug.setTriDebugFlags(
        this.config.debug.showPhy,
        this.config.debug.showVis,
        this.config.debug.phyViewDistance,
        this.config.debug.visViewDistance,
      );
      this.colliderDebug.setChamferDebugFlags(
        this.config.debug.showChamfers,
        this.config.debug.chamferViewDistance,
      );
      this.planeInfoEnabled = this.config.debug.showPlaneInfo;
      this.needsRender = true;
    } else if (section === 'input' && this.cameraController) {
      this.cameraController.applyInputConfig(this.config.input);
    } else if (section === 'lod') {
      this.needsRender = true;
    } else if (section === 'texture') {
      void this.applyTextureQuality(this.config.texture.quality);
    }
  }

  // ── 纹理画质切换（原始 / mosaic 压缩低清）────────────────────

  /**
   * 按画质档位替换场景全部贴图：mini = mosaic 字节码还原低清 PNG；
   * original = 恢复缓存的原图。即时生效（替换 texture.image），无需重载地图。
   */
  async applyTextureQuality(quality: 'original' | 'mini'): Promise<void> {
    const manifest = this.mosaicManifest;
    console.log(
      `[renderer] 画质切换 → ${quality}，manifest ${manifest ? Object.keys(manifest).length : 0} 条，bspModelScene=${!!this.bspModelScene}`,
    );
    if (!manifest || !this.bspModelScene) return;
    const maps = new Set<THREE.Texture>();
    this.bspModelScene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      const list = Array.isArray(mat) ? mat : [mat];
      for (const m of list) {
        const map = (m as unknown as { map?: THREE.Texture | null }).map;
        if (map) maps.add(map);
      }
    });
    console.log(`[renderer] 场景贴图 ${maps.size} 个`);
    const jobs: Promise<void>[] = [];
    let matched = 0;
    const noMatch: string[] = [];
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
      if (!code) {
        noMatch.push(map.name ?? '(无名)');
        continue;
      }
      matched++;
      if (!this.origTextureImages.has(map)) this.origTextureImages.set(map, map.image);
      jobs.push(this.replaceMapWithMosaic(map, code));
    }
    console.log(`[renderer] mini 匹配 ${matched}/${maps.size}；未匹配:`, noMatch.slice(0, 12));
    await Promise.all(jobs);
    this.needsRender = true;
  }

  /** 单个贴图：mosaic 字节码 → 低清 PNG → ImageBitmap 替换 image。
   * 替换前必须 dispose()：three.js r152+ 对同一 texture 的 image 替换走增量
   * glTexSubImage2D（allocateMemory 仅首次为 true）——新 image 尺寸与原 GPU
   * 纹理不符会 GL_INVALID_VALUE 越界、上传失败（纹理保持旧内容 = "没生效"）。
   * dispose 后下次渲染重建 GPU 纹理（按新尺寸 texStorage2D）。 */
  private async replaceMapWithMosaic(map: THREE.Texture, code: string): Promise<void> {
    try {
      await ensureMainWasm();
      const png = mosaic_decode(code, 8);
      const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
      map.dispose();
      map.image = bitmap;
      map.needsUpdate = true;
    } catch (e) {
      console.warn('[renderer] mosaic 贴图替换失败:', e);
    }
  }

  // ── 缺失材质纹理回退 ───────────────────────────────────────
  // 已在 GLB 导出期完成（export_glb_with_pakfile_models_with_defaults）：
  // Rust 侧对缺失材质直接嵌入默认纹理包的低清纹理，渲染端零后期处理。

  // ── 主线程唯一物理线（app.ts 接线入口）────────────────────

  /** 主线程构建 PhysWorld（唯一物理：世界+碰撞+输入+渲染）。 */
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
    if (this.deathY !== null) {
      phys.set_death_y(this.deathY);
    }
    this.predPhys = phys;
    this.predReady = true;
    this.noclipActive = false;
    this.lastTickMs = 0;
    // 权威帧校准状态清零（首帧权威帧将作为新起点）
    this.calibrator.clear();
    // 新世界：渲染采样流不连续 → 失效代数 +1（Worker 丢弃旧世界缓存）
    this.bumpSampleEpoch();
    this.clearPendingInput();
  }

  /**
   * 相机立即对齐当前物理状态（相机位置 = 眼睛 = origin + eyeHeight）。
   *
   * 用途：回放 arm 写回起点状态后调用——否则首帧相机仍停在上一处位置，一帧后
   * `tick()` 才纠正，回放第一帧的读数会带残留（诊断口径会误判）。
   */
  syncCameraToCurrentState(): void {
    const st = this.predPhys?.state() as
      | { posX: number; posY: number; posZ: number; yaw: number; pitch: number; eyeHeight: number }
      | undefined;
    if (!st || !this.cameraController) return;
    this.cameraController.setYawPitch(st.yaw * DEG2RAD, st.pitch * DEG2RAD, true);
    this.cameraController.update();
    this.cameraController.setPosition(st.posX, st.posY + st.eyeHeight, st.posZ);
    this.needsRender = true;
  }

  /** 物理实例输入（app 事件回调喂入；唯一输入通道）。 */
  feedInput(dx: number, dy: number, keysMask: number): void {
    this.pendingDx += dx;
    this.pendingDy += dy;
    this.pendingKeys = keysMask;
  }

  // ── 输入回放模式（debug 专属；见 input/input-recorder.ts）──────────────────

  /**
   * 开/关回放模式。
   *
   * 关掉的两件事都是**权威 → 渲染**方向的实时耦合，它们按**墙钟**帧率给渲染物理
   * 注入速度（`calibrateVelocity` 权威速度外推、`correctFromAuthority` 兜底）：
   * 回放时若继续生效，同一份输入在"回放端跑多快"不同的两次运行里会被注入不同的
   * 速度 → 轨迹不可复现（实测位置差可达数百 HU）。
   *
   * **不动**的：`shared.addInput`（SAB 输入槽照写——权威 Worker 仍收到与录制时
   * 相同的输入流，只是这条线的输出在回放期不参与渲染物理），以及渲染/相机/路径
   * 记录等一切其它逻辑。因此 **live 路径零改动**（replayMode 默认 false）。
   */
  setReplayMode(on: boolean): void {
    this.replayMode = on;
    this.replayDtS = null;
    this.clearPendingInput();
  }

  /** 当前是否回放模式（`__wsInput.counts()` 用）。 */
  isReplayMode(): boolean {
    return this.replayMode;
  }

  /**
   * 单步闸门（**诊断/确定性验证专用**）：`setManualSteps(n>0)` 打开闸门——渲染主循环
   * 每帧最多推进 1 个物理步、共 n 次，之后跳过物理推进直到再次调用；
   * `setManualSteps(0)` 关闭闸门，恢复逐帧连续推进（正常游玩路径）。
   *
   * 用途：无头验证要把"物理步进次数"与"rAF 次数"解耦，否则两轮比较会混入 ±1 步的
   * 相位差（实测：同种子同输入的两轮，第 1 帧就出现 1e-2 HU 级差异——那正是
   * "这一帧物理走没走"的假象，而非物理不确定）。
   */
  setManualSteps(n: number): void {
    if (n <= 0) {
      this.stepGated = false;
      this.stepQuota = 0;
      return;
    }
    this.stepGated = true;
    this.stepQuota = Math.floor(n);
  }

  /** 清空待喂输入（Pointer Lock 退锁/重锁时调用，防残留输入污染）。 */
  clearPendingInput(): void {
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
  }

  /**
   * 直接把玩家全状态写进渲染物理（**输入回放起点对齐专用**；debug 专属）。
   *
   * 与 `resetTo` 的分工：`resetTo` 只负责"位置突变"的记账（权威校准状态归零 +
   * 渲染采样失效世代 +1），本方法负责把 pos/yaw/pitch/**vel/onGround** 写进 Rust
   * 物理实例。`teleportToPos` 做不到后者——传送会把速度清零，而回放起点可能是
   * 空中高速状态（清了速度就复现不出那一步）。
   */
  setPredictionState(
    posX: number, posY: number, posZ: number,
    yawDeg: number, pitchDeg: number,
    velX: number, velY: number, velZ: number,
    onGround: boolean,
  ): void {
    try {
      this.predPhys?.set_state(posX, posY, posZ, yawDeg, pitchDeg, velX, velY, velZ, onGround);
    } catch (err) {
      console.error('[renderer] set_state（回放起点对齐）失败:', err);
    }
    // 相机立即跟上（否则回放首帧会从上一处位置插值过来，首帧位置读数失真）
    this.cameraController?.setYawPitch(yawDeg * DEG2RAD, pitchDeg * DEG2RAD, true);
    this.needsRender = true;
  }

  /**
   * **全量状态快照**（Rust 种子面 v2，`state_full_json(false)`）——输入回放起点
   * 对齐的**唯一正确做法**（debug 专属）。
   *
   * 为什么不能用 9 参 `set_state` 代替：它只写 origin/velocity/yaw/pitch/on_ground，
   * 其余承重字段（`ground_normal`（nopre 钳制）/`contact_ticks`（传送 B 路径门）/
   * `ducked`+`duck_frac`/`ground_ticks_since_landing`/`surfing`/`blocked_ticks`/
   * teleport cooldown 与 trigger inside 位）**保持调用方实例的当前值**。实测后果：
   * 同一份录制在**同一个页面**连放两遍（两次 arm 之间换图重建世界），首帧速度就
   * 差 1.6e-2 HU/s（≈1e-5 相对），480 帧后位置差 12.9 HU——即"输入逐帧相同，
   * 轨迹却不可复现"。用种子面写回后该差值按定义恒为 0（f64 位级往返）。
   *
   * 事件槽**不导出**（`false`）：事件不可播种（不可跨边界消费）。
   * @returns 种子 JSON；物理未就绪或 wasm 未导出该方法时返回 null（回放退化为部分对齐）
   */
  captureFullPhysState(): string | null {
    const phys = this.predPhys as unknown as { state_full_json?: (includeEvent: boolean) => string } | null;
    if (!phys?.state_full_json) return null;
    try {
      return phys.state_full_json(false);
    } catch (err) {
      console.error('[renderer] state_full_json（回放起点快照）失败:', err);
      return null;
    }
  }

  /**
   * 用全量种子 JSON 写回渲染物理（`set_state_ex`）。校验为**严格**的（schema 版本 /
   * triggers 数量 / on_ladder 越界 / 非有限值），失败即 Err——此时调用方应回退到
   * `setPredictionState`（部分对齐）。
   * @returns 是否写入成功
   */
  restoreFullPhysState(json: string): boolean {
    const phys = this.predPhys as unknown as { set_state_ex?: (json: string) => void } | null;
    if (!phys?.set_state_ex) return false;
    try {
      phys.set_state_ex(json);
      return true;
    } catch (err) {
      console.warn('[renderer] set_state_ex（回放起点写回）失败，回退部分对齐:', err);
      return false;
    }
  }

  /** 物理参数（主线程实例直接 set_params；面板参数阶段 4 迁主线程）。 */
  setPredictionParams(params: Record<string, unknown>): void {
    try {
      this.predPhys?.set_params(JSON.stringify(params));
    } catch (err) {
      console.error('[renderer] set_params 失败:', err);
    }
  }

  /** 碰撞箱体型（立即生效）。 */
  setPredictionHull(halfWidth: number, standHeight: number, duckHeight: number): void {
    this.predPhys?.set_hull(halfWidth, standHeight, duckHeight);
  }

  /** noclip 模式（Rust set_noclip：tick 走 noclip_step 无碰撞纯移动）。 */
  setPredictionNoclip(active: boolean): void {
    this.noclipActive = active;
    try {
      this.predPhys?.set_noclip(active);
    } catch (err) {
      console.error('[renderer] set_noclip 失败:', err);
    }
    // 模式切换 = 轨迹不连续（无碰撞纯移动会瞬间脱离渲染折线）→ 失效代数 +1
    this.bumpSampleEpoch();
    this.clearPendingInput();
  }

  /** 重生（主线程物理直接 respawn；与 Worker 双端同步）。 */
  respawn(): void {
    this.predPhys?.respawn();
    // 位置突变（app.ts 随后还会 resetTo，重复 +1 无害——Worker 只是再丢一次缓存）
    this.bumpSampleEpoch();
  }

  /** 传送至指定出生点索引（spawn 下拉；与 Worker 双端同步）。 */
  teleportToSpawn(idx: number): void {
    this.predPhys?.teleport_to_spawn(idx);
    this.bumpSampleEpoch();
  }

  /** 传送到任意坐标（自定义传送点；yaw 缺省 = 保持当前朝向）。 */
  teleportToPos(pos: number[], yawDeg?: number): void {
    const phys = this.predPhys;
    if (!phys) return;
    const cur = phys.state() as { yaw: number };
    phys.teleport_to(pos[0], pos[1], pos[2], yawDeg ?? cur.yaw);
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
    this.deathY = y;
    this.predPhys?.set_death_y(y);
  }

  /** 当前物理速度（HUD/计时挑战采样用）。 */
  getCurrentVel(): { x: number; y: number; z: number } {
    if (!this.predPhys) return { x: 0, y: 0, z: 0 };
    const st = this.predPhys.state() as { velX: number; velY: number; velZ: number };
    return { x: st.velX, y: st.velY, z: st.velZ };
  }

  // ── 权威帧校准四件套（阶段 2，公共化：实现收敛到 ts-shared AuthorityCalibrator）──

  /**
   * 权威帧到达（A2）处理 —— **只读权威，绝不反写**。
   *
   * Worker 是权威帧计算器（加载地图碰撞、独立固定步长模拟）；本方法仅记录
   * 权威帧（速度供外推校准、位置/角度供异常兜底）。
   *
   * **兜底方向（用户定调）**：渲染主线（144Hz 预测物理）精度高于权威
   * （64Hz + 消息延迟），大偏差时**以渲染主线为准反向同步权威**——
   * 同步内容 = 渲染主线帧那一刻的完整状态，同步瞬间清空主线程与权威侧
   * 未消费的鼠标/按键增量（onSyncRenderState 回调 → Worker；权威侧 resetInput）。
   * - 首次权威帧（或重载后）：仍以权威全状态作为渲染物理起点（无渲染历史）
   * - 触发条件（三条件 OR）：
   *   - 位置差 > 500 → **强制**同步（绝对异常，不看朝向）
   *   - 位置差 > 300 **且** 水平朝向一致（yaw 最小角差 ≤ 3° + 转动方向相同）→ 同步
   *   - 位置差 ≤ 300 但视角偏差 > 45° → 同步（位置接近但视角大幅分叉）
   * - 同步在途（syncInFlight）期间不重复触发，直到权威追平（dist < 300）
   */
  private correctFromAuthority(): void {
    this.calibrator.correctFromAuthority();
  }

  /** 逐帧速度校准（权威速度外推反馈；实现见 ts-shared AuthorityCalibrator）。 */
  private calibrateVelocity(now: number): void {
    this.calibrator.calibrateVelocity(now);
  }

  /**
   * 位置突变归零（显式重置允许覆盖：respawn/teleport/noclip 切换/检查点回退）。
   * 清空权威校准状态，防止旧权威帧把突变位置拉回。
   */
  resetTo(pos: number[], yawDeg: number, pitchDeg = 0): void {
    this.calibrator.resetTo(pos, yawDeg, pitchDeg);
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

  /** 消费 Rust 物理事件（每帧 tick 后）：teleport/death → onPhysEvent 回调
   * （app.ts 计时挑战状态机：检查点记录 / 死亡统计 + 检查点回退）。 */
  private consumePhysEvents(): void {
    if (!this.predPhys) return;
    for (;;) {
      const ev = this.predPhys.take_event() as RenderPhysEvent | null;
      if (!ev) break;
      this.onPhysEvent?.(ev);
    }
  }

  /** 当前物理全状态（自定义传送点保存位置 / HUD 采样用）。 */
  getCurrentState(): {
    pos: { x: number; y: number; z: number };
    yaw: number;
    pitch: number;
    vel: { x: number; y: number; z: number };
    onGround: boolean;
  } {
    if (!this.predPhys) return { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, vel: { x: 0, y: 0, z: 0 }, onGround: false };
    const st = this.predPhys.state() as {
      posX: number; posY: number; posZ: number;
      yaw: number; pitch: number;
      velX: number; velY: number; velZ: number;
      onGround: boolean;
    };
    return {
      pos: { x: st.posX, y: st.posY, z: st.posZ },
      yaw: st.yaw,
      pitch: st.pitch,
      vel: { x: st.velX, y: st.velY, z: st.velZ },
      onGround: st.onGround,
    };
  }

  /** 当前 PVS cluster（HUD cluster 显示用；无 PVS = -1）。 */
  getPvsCluster(): number {
    return this.pvsManager?.currentClusterId ?? -1;
  }

  /**
   * 输入回放起点快照（debug 专属；见 input/input-recorder.ts）。
   *
   * 返回"要让回放逐帧复现必须原样写回渲染物理"的那一组量：
   * 玩家全状态（pos/yaw/pitch/vel/onGround）+ 碰撞箱 + 物理参数（`config.physics`
   * 的 snake_case 子集，含 `autobhop`）。
   *
   * 物理参数取 `config.physics` 而非 Rust `get_params()`：Rust 侧没有全量读取口，
   * 而 config 就是喂给 `setPredictionParams` 的同一份来源（`buildPredictionParams`），
   * 因此它**就是**当前渲染物理与权威 Worker 共用的那份参数。
   */
  captureReplayState(): {
    state: InputReplayInitialState | null;
    hull: InputReplayHull;
    physics: Record<string, unknown>;
    seed: string | null;
  } {
    const st = this.predPhys?.state() as
      | {
          posX: number; posY: number; posZ: number;
          yaw: number; pitch: number;
          velX: number; velY: number; velZ: number;
          onGround: boolean;
        }
      | undefined;
    const rp = this.config?.player ?? ({} as RuntimeConfig['player']);
    return {
      state: st
        ? {
            pos: { x: st.posX, y: st.posY, z: st.posZ },
            yaw: st.yaw,
            pitch: st.pitch,
            vel: { x: st.velX, y: st.velY, z: st.velZ },
            onGround: st.onGround,
          }
        : null,
      hull: { halfWidth: rp.radius, standHeight: rp.standHeight, duckHeight: rp.duckHeight },
      physics: this.config ? buildDebugPredictionParams(this.config) : {},
      seed: this.captureFullPhysState(),
    };
  }

  // ── GLB 加载（SceneBuilder 主线程版）──────────────────────

  private readonly gltfLoader = new GLTFLoader();

  private async loadGlb(glbBytes: ArrayBuffer): Promise<GLTF> {
    const buffer = new Uint8Array(glbBytes.byteLength);
    buffer.set(new Uint8Array(glbBytes));
    const blob = new Blob([buffer], { type: 'model/gltf-binary' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      return await this.gltfLoader.loadAsync(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  /** 重置 GLB 根节点旋转，统一坐标系（与 Worker 侧碰撞体一致）。 */
  private resetRootRotations(gltf: GLTF): void {
    for (const child of gltf.scene.children) {
      const r = child.rotation;
      if (r.x !== 0 || r.y !== 0 || r.z !== 0) {
        console.log(
          `[renderer-main] 重置根节点 "${child.name || '(unnamed)'}" 旋转: ` +
            `(${r.x.toFixed(3)}, ${r.y.toFixed(3)}, ${r.z.toFixed(3)}) → (0, 0, 0)`,
        );
        child.rotation.set(0, 0, 0);
        child.updateMatrixWorld();
      }
    }
    gltf.scene.updateMatrixWorld(true);
  }

  /** 遍历 mesh 存储 userData 元数据（材质/纹理分类，供调试/剔除）。 */
  private collectMetadata(scene: THREE.Scene): void {
    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[];
      const firstMat = Array.isArray(mat) ? mat[0] : mat;
      if (!firstMat) return;
      const materialName = (firstMat.name ?? '').toLowerCase();
      const basicMat = firstMat as THREE.MeshBasicMaterial;
      const map = (basicMat as unknown as { map?: THREE.Texture | null }).map;
      const textureName = map?.name ? map.name.toLowerCase() : '';
      const combined = `${materialName} ${textureName}`;
      mesh.userData.vbsp = {
        isTools: combined.includes('tools/') || combined.includes('tools\\'),
        isNodraw: combined.includes('nodraw'),
        hasTexture: !!map,
        isWater: combined.includes('water'),
        isTrans: !!firstMat.transparent,
        isLightEmissive:
          combined.includes('light') ||
          combined.includes('emit') ||
          combined.includes('glow') ||
          combined.includes('sky'),
        textureName: map?.name ?? '',
        materialName: firstMat.name ?? '',
      };
    });
  }

  /** 回传剔除统计（主线程本地 LOD/PVS 数据）。 */
  private emitCullStats(): void {
    if (!this.onCullStats) return;
    if (this.lodManager.itemCount <= 0) return;
    const lodStats = this.lodManager.getStats();
    const pvsStats = this.pvsManager?.getStats();
    this.onCullStats({
      visible: lodStats.visible,
      total: lodStats.total,
      cullDist: lodStats.cullDistance,
      pvs: {
        cluster: pvsStats?.currentCluster ?? -1,
        visibleClusters: pvsStats?.visibleCount ?? 0,
        totalClusters: pvsStats?.totalClusters ?? 0,
        pvsHidden: lodStats.pvsHidden,
        near: lodStats.near,
        far: lodStats.far,
      },
    });
  }

  // ── 空间分块合并（optimizeScene：GLB 挂载后执行一次）─────────────
  // 渲染减负核心：3.4 万 Mesh（每帧遍历/剔除/draw call 开销）→ 数百~数千空间块。
  // 移植自 game/src/renderer/renderer-main.ts::optimizeScene（其又源自 harness worker-b）。
  // 载体与 game 一致：直接在 BSP 根（bspRoot，userData.isBspModel 保留不变）内替换内容——
  // 移除 gltf.scene、块 mesh 直接挂 BSP 根。
  // 时序：loadScene 中 scene.add(gltf.scene) + lightmap 之后、updateMatrixWorld / boundingBox /
  // LOD·PVS 注册（lodManager.setup + assignClusterIds）之前——下方遍历收集分块后的 mesh。
  // 流程：① scene.updateMatrixWorld(true) → traverse 收集 Mesh（世界包围盒中心）
  // ② cell 自适应（世界对角 / cbrt(目标块数)，微调落 [300,800] 非空 cell）
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

    // ② cell 大小自适应：cell = 世界包围盒对角线 / cbrt(目标块数)，再按非空 cell 数微调
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

    // ④ 合并 + 替换
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
    const totalMeshes = infos.length;
    for (const m of chunks) bspRoot.add(m);
    for (const m of keptMeshes) bspRoot.add(m);
    bspRoot.remove(gltfScene);

    // ④c 视锥外保一圈：块 geometry.boundingSphere 半径 ×FRUSTUM_PAD。
    //    必须强制 computeBoundingSphere（非 null 检查）：烘焙路径是 geometry.clone() +
    //    applyMatrix4(matrixWorld)——克隆残留 GLB 局部空间的旧球（非 null 会被跳过）→
    //    剔除按错误位置判定 → 眼前块被误剔不渲染。
    for (const child of bspRoot.children) {
      const g = (child as THREE.Mesh).geometry;
      if (!g) continue;
      g.computeBoundingSphere();
      (g.boundingSphere as THREE.Sphere).radius *= FRUSTUM_PAD;
    }

    // ⑤ 统计 + 前向视锥可见块估算（仅诊断；debug FOV 固定 73.6）
    const chunkBox = new THREE.Box3();
    const chunkCenter = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    let visibleEst = -1;
    const camera = this.camera;
    if (camera) {
      camera.updateMatrixWorld(true);
      const camDir = new THREE.Vector3();
      camera.getWorldDirection(camDir);
      const cosHalfFov = Math.cos(((FOV / 2) * Math.PI) / 180);
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

  // 复用向量
  private readonly _fwdDir = new THREE.Vector3();
}

const DEG2RAD = Math.PI / 180;
