/**
 * WebSurf debug 工程的主线程渲染器 `RendererMain`：一帧内做的事固定为
 * 「推进本地物理 → 相机同步 → LOD/可见性剔除 → 雾与可视化（碰撞箱、触发器、准星射线）
 * → draw call」。
 *
 * 物理线：本类自持 `PhysWorld`（`apps/debug/pkg/websurf_wasm.js`，由
 * `apps/debug/src/main-wasm.ts` 的 `ensureMainWasm` 完成 `initSync`），渲染循环每帧推进它，
 * 相机位姿直接取自它的 `state()`——主线程不保留插值副本。
 *
 * 场景数据来源：`loadScene` 收 `apps/debug/src/worker/worker-types.ts` 的 `SceneDataMessage`，
 * 由 `apps/debug/src/app.ts` 的 `handleLoadBsp` 经 `buildWorldBundle`
 * （`src/ts-shared/phys/world-builder.ts`）在主线程解析后传入。
 *
 * **渲染装配与每帧绘制全部委托共享 `RenderSession`**（`src/renderer-shared/scene/render-session.ts`）：
 * renderer/scene/camera、GLB 装配、分块合并、天空层、环境/雾、可见性、近平面、贴图画质、探针
 * 都只在共享层存在一份；本类只保留 debug 特有线（物理、相机输入、灯光、可视网格、路径/准星、
 * 按需渲染）与数据源。碰撞体交 `adaptBrushes`、传送触发器交 `TeleportManager`。
 *
 * debug 侧子管理器：`CameraController`（视角输入）、`LightManager`（灯光/阴影/雾）、
 * `ColliderDebug`（碰撞体与触发器可视化）、`PathRecorder`（物理轨迹取样）、
 * `PlaneInspector`（准星射线）；权威帧对齐交 `AuthorityCalibrator`
 * （`src/ts-shared/phys/authority-calibrator.ts`）。
 * 渲染采样写入共享内存的口径见本文件内紧随共享内存导入的那段说明。
 */

import { writeRenderPrefs } from '../../../../src/renderer-shared/config/render-prefs.js';
import { installPoseEntry, cameraPoseOf, yawPitchRadOf } from '../../../../src/renderer-shared/camera/pose-entry.js';
import * as THREE from 'three';
// mosaic 画质切换：主线程懒初始化同一 wasm 模块（与 worker 实例互不影响）
import { ensureMainWasm, mosaic_decode } from '../main-wasm.js';
// 主线程唯一物理线：PhysWorld 与 BspProcessor 同模块（main-wasm 已 initSync）
import { PhysWorld } from '../../pkg/websurf_wasm.js';
import type { RuntimeConfig } from '../config.js';
import type { PlaneInfo, SceneDataMessage } from '../worker/worker-types.js';
import type { SharedState } from '../../../../src/ts-shared/auth/shared-state.js';
import { AuthorityCalibrator } from '../../../../src/ts-shared/phys/authority-calibrator.js';
import type { Brush } from '../physics/physics/Collision/Collision.types.js';
import type { TeleportTrigger } from '../world/teleport-manager.js';
import { TeleportManager } from '../world/teleport-manager.js';
import { adaptBrushes } from '../world/collider-adapter.js';
import { EntitySystem, type EntitySystemStats } from '../../../../src/ts-shared/entity/entity-system.js';
import { attachEntitySystem } from '../../../../src/ts-shared/entity/attach.js';
import { playerStateFromRaw, type RawPlayerState } from '../../../../src/ts-shared/entity/host.js';
import type { EntityEvent } from '../../../../src/ts-shared/entity/types.js';
import { CameraController } from './camera-controller.js';
import { ColliderDebug } from './collider-debug.js';
import type { PhyBevelPiece } from './collider-debug.js';
import { LightManager } from '../../../../src/renderer-shared/environment/light-manager.js';
import { PathRecorder } from './path-recorder.js';
import type { DistStats } from './path-recorder.js';
import { FlightPathRecorder } from './flight-path.js';
import type { FlightFileMeta, FlightLoadResult, FlightPathStatus } from './flight-path.js';
import type { InputReplayInitialState, InputReplayHull } from '../input/input-recorder.js';
import { buildDebugPredictionParams } from '../physics/prediction-params.js';
import { PlaneInspector } from './plane-inspector.js';
import type { LightingMode } from '../../../../src/renderer-shared/shader/lightmap-shader.js';
import { RenderSession } from '../../../../src/renderer-shared/scene/render-session.js';
import { ParticleSystems, collectParticleEntities } from '../../../../src/renderer-shared/scene/particles.js';

/**
 * 渲染采样传输（主线程 → Worker）：本文件把「本地物理每帧的脚底位置 + 该帧渲染时钟」
 * 写进共享内存，Worker 再把权威发布位置投影到这条采样轨迹上。
 *
 * 只用三个方法，实现在 `src/ts-shared/auth/shared-state.ts` 的 `ShmState`（SAB 通道）
 * 与 `MsgState`（消息回退通道）；`createMainSharedState` 择一返回，两者同签名，故本类
 * 只按 `SharedState` 类型持有：
 * - `writeRenderSample(tMs, x, y, z, i0)`：写入时**不接受 epoch 参数**——世代槽由
 *   `shared-state` 独占并就地读取。`i0` 是本次采样在 `PathRecorder` 渲染节点索引空间里的
 *   下标，由 `renderSampleIndex` 自增提供。
 * - `resetRenderSample()`：采样失效世代 +1；Worker 侧在服务请求前用 `readRenderEpoch`
 *   复检，不一致即丢弃旧世代缓存。
 * - `readPublishedTau()`：最近一次权威发布所依据的渲染时钟 τ（毫秒）；返回 0 时调用点
 *   回落墙钟 `now`。
 */

/** 准星射线检测间距（帧）：`planeInspectCounter` 计满该值才调一次 `inspectPlane` 并清零。 */
const PLANE_INSPECT_INTERVAL = 6;

/** HUD 剔除统计（`emitCullStats` 组装，交给 app.ts 注册的 `onCullStats`）。
 * `visible/total/cullDist` 与 `pvs.near/far/pvsHidden` 取自共享 `RenderSession.stats()`——判定
 * 本体在共享 `VisibilityController`（距离优先、档 `culling.pvs` 为真时再看 PVS），`near` =
 * 可见块数、`far` = 距离剔除块数、`pvsHidden` = PVS 剔除块数。
 * `pvs.cluster/visibleClusters/totalClusters` 取自共享会话持有的 `PvsManager`；无 PVS 时
 * `cluster` 恒 -1、`visibleClusters` 恒 0。块数为 0 时整个回调不下发。 */
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
  /** 共享渲染代码版本（`RENDER_REV`），HUD 直接显示，用来识别「还在跑旧包」。 */
  rev: string;
  /** 可见块「凭什么被画」的分项计数：`pvs` = PVS 判可见、`distance` = 只有距离档。 */
  reasons: { pvs: number; distance: number };
}

/** 渲染物理事件（`PhysWorld.take_event` 逐条取出、一次性消费；取到 null 即结束本轮）。
 * app.ts 的 `onRenderPhysEvent` 按 `kind` 分派：`teleport` 交给计时挑战记检查点/终点，
 * `death` 触发死亡统计并把玩家撤回检查点。 */
export interface RenderPhysEvent {
  kind: string;
  /** teleport 事件的实体目标名。 */
  targetname?: string;
  /** teleport 事件的目标位置（Y-up 三元组）。 */
  origin?: number[];
  /** teleport 事件的目标 yaw（度）。 */
  yaw?: number;
}

// ── 空间分块合并（optimizeScene：GLB 挂载后执行一次；算法与参数在渲染共享核 ──
// 动机：GLTFLoader 对 GLB 的每个 primitive 建一个 THREE.Mesh，未合并时每帧三处开销都随
// Mesh 数线性增长——renderer.render 的视锥剔除与逐 mesh draw call、可见性控制器的
// 逐项距离判定（`visibility-controller.ts`）、近平面自适应的整树 traverse + 包围球测试。合并把对象压成「块」，一块的
// draw call 数 = 该块的材质数。载体见 `optimizeScene` 薄委托；合并前的归一由共享核的默认钩子承担
// （`scene-optimizer.ts` 的 `normalizeMergeGroup`，T-460 WP4 起三端同一份）。


/** 分块合并总开关：false 时 `loadScene` 不调 `optimizeScene`，保留 GLTFLoader 原始场景图。 */
const OPTIMIZE_SCENE_ENABLED = true;


/** 主线程渲染器：持有 WebGL 渲染器、场景、相机与全部子管理器。相机不再本地插值——
 * 每个渲染帧由 `tick` 用 `predPhys.state()` 直接摆放。 */
export class RendererMain {
  /** 三端唯一渲染会话（`init` 建）：renderer/scene/camera 与所有共享渲染步骤都在里面。 */
  private session: RenderSession | null = null;
  /** 会话字段的本地别名（物理/可视化/探针既有读点；只读，不另建实例）。 */
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private cameraController: CameraController | null = null; /** 位姿冻结（共享位姿入口写入；每帧相机同步消费，见 `tick`）。 */ poseHold: { x: number; y: number; z: number; yawRad: number; pitchRad: number } | null = null;
  private teleportManager: { getTriggers(): readonly TeleportTrigger[] } | null = null;
  /** 实体碰撞体列表 = `solids` + `ladders`（`ColliderDebug` 的碰撞箱可视化数据源）。 */
  private colliders: Brush[] = [];
  /** 固体 brush（`PlaneInspector.cast` 用它区分命中物的 brushType）。 */
  private solids: Brush[] = [];
  /** 梯子 brush（同上，命中物分类用）。 */
  private ladders: Brush[] = [];
  /** 传送触发器（`TeleportManager.getTriggers` 的快照；可视化与准星射线共用）。 */
  private triggers: TeleportTrigger[] = [];
  /** BSP 模型场景根（共享会话合并后的根；`inspectPlane` / 可视网格从它开始遍历）。 */
  private bspModelScene: THREE.Object3D | null = null;

  /** 灯光与光照参数（`init` 里 `applyLights`；lighting 段 patch 时 `syncFromConfig`）。 */
  private readonly lightManager = new LightManager();
  /** 物理轨迹记录器：渲染物理线每物理步一点、tick 物理线每条新权威帧一点，采样点均为脚底中心。 */
  private readonly pathRecorder = new PathRecorder();
  /**
   * 飞行轨迹（相机位姿）录制/复播：noclip 自由飞一遍再原样重放，用于复现「说不清坐标」的场景。
   * 与 `pathRecorder` 的区别见 `flight-path.ts` 文件头：这个是相机、那个是物理节点。
   */
  private readonly flightPath = new FlightPathRecorder();
  /** 当前地图名（导出轨迹时写进 meta，换图后一眼能看出轨迹属于哪张图）。 */
  private flightMapName = '';
  /**
   * 复播状态；`null` = 没在复播。复播不驱动物理，只把样本位姿写进 `poseHold`（与
   * `__vbspPose.setPose()` 同一条路），因此 noclip 穿过几何也能重放，且可反复 seek 截图。
   */
  private flightPlayback: {
    /** 已播放到的轨迹时间（毫秒）。 */
    tMs: number;
    /** 播放速率（1 = 原速）。 */
    speed: number;
    /** 播到末尾是否回绕。 */
    loop: boolean;
    /** 暂停时只重摆位姿、不推进时钟。 */
    paused: boolean;
    /** 上一帧墙钟（毫秒）：每帧用它算增量，暂停/seek 后重设以丢弃间隙。 */
    lastWallMs: number;
    /** 复播前用户原本的位姿冻结（结束时还原，避免把 `__vbspPose.setPose` 的钉点弄丢）。 */
    holdBackup: { x: number; y: number; z: number; yawRad: number; pitchRad: number } | null;
  } | null = null;
  /** 碰撞体/触发器/三角面可视化；`hasDebugWork` 为假时 `tick` 跳过它的 `update`。 */
  private readonly colliderDebug = new ColliderDebug();
  /** 准星射线检测器：从相机前方发射，与 mesh/碰撞体/触发器求交，结果经 `getPlaneInfo` 给 HUD。 */
  private readonly planeInspector = new PlaneInspector();

  private planeInfoEnabled = false;
  private planeInspectCounter = 0;
  private lastPlaneInfo: PlaneInfo | null = null;

  /** 运行期配置（`init` 赋值；`applyConfigPatch` 就地改写其子段）。 */
  private config: RuntimeConfig = null as unknown as RuntimeConfig;
  /** 强制渲染标记：`tick` 渲染一次后清零，场景变化处置真。 */
  private needsRender = true;
  /** rAF 句柄（`start` 登记，`stop` 取消）。 */
  private rafId = 0;
  /** 渲染循环开关：`stop` 置假后 `tick` 直接返回。 */
  private running = false;

  // ── Source 实体运行期 ────────────────────────────────────────
  /** 由 `entityIoJson` 装配的通用 I/O / trigger / logic 系统；`tick` 与物理同帧推进。 */
  private entitySystem: EntitySystem | null = null;
  /** PCF 粒子系统的 three.js 最小实现（`src/renderer-shared/scene/particles.ts`）；无粒子实体时为 null。 */
  private particleSystems: ParticleSystems | null = null;
  /** 粒子推进用的上一帧墙钟（与物理步长独立，物理停走时粒子仍动）。 */
  private particleLastMs = 0;

  // ── 主线程物理线（渲染直读 state()，无插值副本）──
  /** 渲染物理实例：`buildPredictionWorld` 里构造并 `build_world`，`disposeScene` 置空。 */
  private predPhys: PhysWorld | null = null;
  /** 物理就绪标记：`buildPredictionWorld` 置真；`tick` 据此决定是否推进物理、是否渲染。 */
  private predReady = false;
  /** 累计鼠标增量（`feedInput` 累加，每个物理步后清零）。 */
  private pendingDx = 0;
  private pendingDy = 0;
  /** 待喂按键掩码（`feedInput` 直接覆盖）。 */
  private pendingKeys = 0;
  /** noclip 标记（`setPredictionNoclip` 写入并透传 Rust `set_noclip`）：为真时 `tick` 跳过近平面探测。 */
  private noclipActive = false;
  /** 上一物理步的墙钟毫秒（0 表示本帧用 1/64 秒兜底）。 */
  private lastTickMs = 0;

  // ── 输入回放模式（debug 专属确定性复现工具；见 input/input-recorder.ts）──────
  /**
   * 回放期本帧的物理步长（秒）：由 app.ts 每帧写入，`tick` 消费后立刻置回 null。
   *
   * 非 null 时用它替代墙钟 dt——录制端的帧步长序列是录制内容的一部分（同一份输入配不同
   * 步长即不同轨迹），用墙钟 dt 会让轨迹从第二帧起分叉。
   */
  replayDtS: number | null = null;
  /** 回放模式：为真时 `tick` 跳过 `correctFromAuthority` 与 `calibrateVelocity` 两条
   * 权威 → 渲染方向的实时耦合（输入照写共享内存，渲染/相机/路径记录不变）。 */
  private replayMode = false;
  /**
   * 单步闸门（诊断用，见 `setManualSteps`）：为真时 `tick` 每帧最多推进 `stepQuota` 个
   * 物理步，配额耗尽即跳过物理推进（渲染与统计照常），用于把物理步进次数与 rAF 次数解耦。
   */
  private stepGated = false;
  private stepQuota = 0;
  /** 死亡 Y 阈值：`loadScene` 末尾经 `onSceneLoaded` 回调上报，`setDeathY` 记录并透传物理实例。 */
  private deathY: number | null = null;

  // ── 权威帧校准（实现收敛到 src/ts-shared/phys/authority-calibrator.ts）──
  /** 权威帧校准器：`correctFromAuthority` / `calibrateVelocity` / `applyCollisionCorrection` /
   * `resetTo` 四个入口都转发给它；构造时注入「读权威帧」「取物理实例」「清待喂输入」
   * 「回同步渲染状态」四条回调。 */
  private readonly calibrator: AuthorityCalibrator;

  // ── 渲染采样传输（Worker 把权威发布位置投影到这条采样轨迹上）──────
  // 三个方法的语义见文件头说明。
  /**
   * 渲染采样序号：与 `PathRecorder` 的渲染节点索引空间同拍同源——同一帧内 `addRender`
   * 落点后紧跟 `writeRenderSample`，故 `i0` 就是该节点在记录器里的下标。只有 `clearPath()`
   * 把它归零；跨失效世代不归零（世代由共享内存的世代槽表达，序号保持单调即可与旧世代
   * 残留项区分）。
   */
  private renderSampleIndex = 0;
  /**
   * 采样失效世代（渲染器侧本地计数，用于 `init` 的跨线程通道日志与诊断）。
   *
   * `buildPredictionWorld`、`disposeScene`、`clearPath`、`resetTo`、`respawn`、
   * `teleportToSpawn`、`teleportToPos`、`setPredictionNoclip` 都经 `bumpSampleEpoch`
   * 让它 +1——这些位置突变点使采样流不再连续。该值不参与跨线程协议：世代槽归
   * `shared-state` 独占（见文件头）。
   */
  private sampleEpoch = 0;

  /** 采样流失效：本地计数 +1，并调 `shared.resetRenderSample()` 让 Worker 丢弃旧世代缓存（两者成对使用）。 */
  private bumpSampleEpoch(): void {
    this.sampleEpoch++;
    this.shared.resetRenderSample();
  }

  /** 剔除统计回调（app.ts 注册为 HUD 刷新；`emitCullStats` 最多每 100ms 触发一次）。 */
  onCullStats: ((stats: CullStatsLike) => void) | null = null;
  /** 场景加载完成回调：`loadScene` 末尾传出场景包围盒最小 Y（死亡阈值的下界）。 */
  onSceneLoaded: ((deathThresholdY: number) => void) | null = null;
  /** 实体系统观测回调：I/O 输入、宿主副作用请求都会送到这里（缺省丢弃）。 */
  onEntityEvent: ((event: EntityEvent) => void) | null = null;

  /**
   * 渲染物理线 → 权威侧的反向同步回调（由 `AuthorityCalibrator` 在兜底重锚/首次起点对齐时
   * 触发）。app.ts 收到后 postMessage `sync-render-state` 给 Worker。
   *
   * @param s 渲染物理线该帧的完整状态（位置/朝向/速度/是否着地/眼高）。
   * @param teleport true = 位置突变类同步（Worker 侧清掉未消费的输入增量）；
   *   false = 常规反向重锚（Worker 侧保留输入增量）。
   */
  onSyncRenderState: ((s: {
    posX: number; posY: number; posZ: number;
    yaw: number; pitch: number;
    velX: number; velY: number; velZ: number;
    onGround: boolean;
    eyeHeight: number;
  }, teleport: boolean) => void) | null = null;

  /** 渲染物理事件回调（`consumePhysEvents` 逐条转发；app.ts 注册为计时挑战状态机）。 */
  onPhysEvent: ((ev: RenderPhysEvent) => void) | null = null;


  constructor(
    private readonly shared: SharedState,
  ) {
    // config 由 init() 赋值
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

  /** 初始化渲染器、场景、相机与子管理器：设定光照模式，建 `WebGLRenderer`/`Scene`/
   * `PerspectiveCamera`（视场角 `FOV`，near/far 在 `loadScene` 中按场景尺寸重算）、
   * `CameraController`，装灯光与碰撞可视化，并把 config 里的四组调试开关灌下去。 */
  init(canvas: HTMLCanvasElement, width: number, height: number, dpr: number, config: RuntimeConfig): void {
    this.config = config;
    // 跨线程通道形态与本地采样世代计数（诊断用；世代不参与协议，见 sampleEpoch）
    console.log(`[renderer] 跨线程通道: ${this.shared.isShared ? 'SAB' : 'MsgState'}（阶段 1 渲染直读本地物理）`);
    console.log(`[renderer] 渲染采样失效世代计数（本地诊断，非协议值）: ${this.sampleEpoch}`);

    this.session = new RenderSession({
      canvas,
      width,
      height,
      dpr,
      app: 'debug',
      backgroundColor: config.lighting?.bgColor ?? 0x222222,
      // debug 的画质切换要等主线程 wasm 就绪（`ensureMainWasm`）
      mosaic: { decode: mosaic_decode, ensureWasm: ensureMainWasm },
      viewportSource: 'layout-canvas',
    });
    this.renderer = this.session.renderer;
    this.scene = this.session.scene;
    this.camera = this.session.camera;
    this.camera.position.set(2000, 2000, 2000);

    // 物理路径可视化挂在根场景而不是 bspModelScene 下：后者每次换图重建，而路径要跨图保留；
    // 该 group 自身 frustumCulled=false，不受剔除影响
    this.scene.add(this.pathRecorder.group);

    this.cameraController = new CameraController(this.camera, config.input); installPoseEntry({ applyPose: (p) => { const [yawRad, pitchRad] = yawPitchRadOf(p); this.poseHold = { x: p.pos[0], y: p.pos[1], z: p.pos[2], yawRad, pitchRad }; }, readPose: () => cameraPoseOf(this.camera), releasePose: () => { this.poseHold = null; } }, 'debug'); (globalThis as unknown as { __vbspTextureQuality?: (q: 'original' | 'mini') => Promise<void> }).__vbspTextureQuality = (q) => this.applyTextureQuality(q);
    // 飞行轨迹入口（自动化脚本用）：录一条 noclip 飞行、导出、之后再 load + seek 复播截图。
    // 面板按同样的方法接（`apps/debug/src/app.ts` 的「飞行轨迹」区）。
    (globalThis as unknown as { __vbspFlight?: unknown }).__vbspFlight = {
      start: (): void => this.startFlightRecording(),
      stop: (): void => this.stopFlightRecording(),
      clear: (): void => this.clearFlightPath(),
      status: (): FlightPathStatus & { playback: ReturnType<RendererMain['getFlightPlayback']> } => ({
        ...this.flightPath.status(),
        playback: this.getFlightPlayback(),
      }),
      export: (meta?: FlightFileMeta): string => this.exportFlightJson(meta),
      load: (text: string): FlightLoadResult => this.loadFlightJson(text),
      play: (opts?: { speed?: number; loop?: boolean }): boolean => this.playFlight(opts),
      pause: (): void => this.pauseFlight(),
      resume: (): void => this.resumeFlight(),
      seek: (tMs: number): void => this.seekFlight(tMs),
      stopPlay: (): void => this.stopFlightPlayback(),
      map: (name?: string): string => (name === undefined ? this.flightMapName : this.setFlightMapName(name)),
    };

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
    this.colliderDebug.setBevelVisible(config.debug.showBevel);
    this.colliderDebug.setPhyBevelVisible(config.debug.showPhyBevel);
    this.planeInfoEnabled = config.debug.showPlaneInfo;

    this.needsRender = true;
  }

  /**
   * 卸载当前地图的渲染资源与本地状态（`loadScene` 开头、app.ts 的换图入口都会调用）。
   *
   * three.js 的 `scene.remove()` 只摘除场景图，geometry/material/纹理仍留在 GPU 侧，反复
   * 加载会持续占用显存与 JS 堆。本方法递归 dispose 每个 `userData.isBspModel` 子树，释放
   * three.js 的渲染列表缓存，再清空本地引用、子管理器状态、渲染物理线与权威校准状态。
   * `LightManager` 的灯光不在此列——它按 config 替换式更新。
   */
  disposeScene(): void {
    this.entitySystem?.dispose();
    this.entitySystem = null;
    this.particleSystems?.dispose();
    this.particleSystems = null;
    this.particleLastMs = 0;
    // 渲染资源（根/天空/环境/渲染列表/PVS/可见性）全部由共享会话释放
    this.session?.disposeScene();
    this.bspModelScene = null;

    // 子管理器与本地引用清零
    this.teleportManager = null;
    this.colliders = [];
    this.solids = [];
    this.ladders = [];
    this.triggers = [];
    // 碰撞可视化清空（group 与 scene 引用保留，新地图直接复用）
    this.colliderDebug.clearAll();

    // 渲染物理线状态清零（待喂输入一并清掉）
    this.predPhys = null;
    this.predReady = false;
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
    this.noclipActive = false;
    this.lastTickMs = 0;
    this.deathY = null;
    // 换图时停掉飞行复播（轨迹本身保留：同一张图重载后还能直接 seek）
    this.stopFlightPlayback();
    // 权威校准状态清零（旧图的权威帧不得注入新图）
    this.calibrator.clear();
    // 换图使采样流不连续 → 采样失效世代 +1
    this.bumpSampleEpoch();
    this.needsRender = true;
  }

  /**
   * 切换光照模式（面板「预烘焙 / 纯纹理」）：转交 `lightmap-shader` 的 `setLightingMode`，
   * 由它改写全场景材质共享的 bakedMix uniform，立即生效——不重建场景、不重编译材质、
   * 不打断输入与物理。模式与当前一致时直接返回。
   */
  setLightingMode(mode: LightingMode): void {
    this.session?.setLightingMode(mode);
  }

  /** 当前光照模式（面板回填与日志用；读共享会话）。 */
  getLightingMode(): LightingMode {
    return this.session?.getLightingMode() ?? 'baked';
  }

  /**
   * 调试面板「vhv 线性（去伽马）」：转交共享会话，改全场景材质共享的 uniform，
   * 下一次绘制即生效（不重建场景、不重编译材质）。
   */
  setVhvLinear(on: boolean): void {
    this.session?.setVhvLinear(on);
  }

  /** 当前 vhv 伽马处理（面板回填用）。 */
  getVhvLinear(): boolean {
    return this.session?.getVhvLinear() ?? false;
  }

  /** 加载一副地图：GLB → lightmap atlas → 空间分块合并 → 包围盒与 near/far → 可见性/PVS/
   *  传送触发器/贴图 manifest/碰撞体，返回共享会话校准出的对角线与剔除距离
   *  （`diagonal` / `defaultCull` / `maxCull`）。 */
  async loadScene(data: SceneDataMessage): Promise<{ diagonal: number; defaultCull: number; maxCull: number } | null> {
    if (!this.session) return null;

    const result = await this.session.loadScene({
      glb: data.glb,
      pvsJson: data.pvsJson,
      skyCamera: data.skyCamera ?? null,
      fogParams: data.fogParams ?? null,
      skyboxTexture: data.skyboxTexture ?? null,
      mosaicManifest: data.mosaicManifest
        ? (JSON.parse(data.mosaicManifest) as Record<string, string>)
        : null,
      quality: this.config.texture.quality,
      // debug 的 A/B 开关：半透明单独分块（默认开）
      translucentSplit: (globalThis as { __vbspTransChunking?: unknown }).__vbspTransChunking !== false,
      merge: OPTIMIZE_SCENE_ENABLED,
      onRootReady: (root) => this.collectMetadata(root),
    });

    this.bspModelScene = result.root;

    // 传送触发器：进碰撞可视化，同时作为准星射线的 trigger 命中面
    this.teleportManager = new TeleportManager(data.teleportJson);
    this.triggers = [...this.teleportManager.getTriggers()];
    this.colliderDebug.setTriggers(this.triggers);
    if (data.triJson) {
      this.colliderDebug.setTriMeshes(JSON.parse(data.triJson));
    }
    if (data.phyBevelsJson) {
      this.colliderDebug.setPhyBevels(JSON.parse(data.phyBevelsJson) as PhyBevelPiece[]);
    }

    // 实体碰撞体：solids 与 ladders 分别留档（可视化用合并列表，准星射线用分类列表）
    const adaptResult = adaptBrushes(data.brushJson);
    this.colliders = [...adaptResult.solids, ...adaptResult.ladders];
    this.solids = adaptResult.solids;
    this.ladders = adaptResult.ladders;

    // 剔除距离以共享会话的校准结果为准（面板滑块只改这个值）
    this.config.lod.cullDistance = result.defaultCull;

    this.needsRender = true;
    this.onSceneLoaded?.(result.bbox.min.y);
    this.setupEntitySystem(data.entityIoJson);
    this.setupParticleSystems(data.entityIoJson);
    this.emitCullStats();
    return {
      diagonal: result.diagonal,
      defaultCull: result.defaultCull,
      maxCull: result.maxCull,
    };
  }

  /**
   * 装配通用 Source 实体运行期（观测模式，副作用只上报不施加，理由见 `attach.ts`）。
   * debug 端把事件接到 `onEntityEvent`，面板可据此显示 I/O 链与未处理输入。
   */
  private setupEntitySystem(entityIoJson?: string): void {
    this.entitySystem?.dispose();
    this.entitySystem = attachEntitySystem({
      entityIoJson,
      getPlayerState: () => playerStateFromRaw(
        (this.predPhys?.state() as RawPlayerState | undefined) ?? { posX: 0, posY: 0, posZ: 0 },
      ),
      onEvent: (event) => this.onEntityEvent?.(event),
    });
  }

  /**
   * 装配 PCF 粒子（最小 three.js 实现，见 `src/renderer-shared/scene/particles.ts`）：
   * 只处理 `info_particle_system` 实体里有可视化配置的效果；没有可渲染效果时不建组、不挂场景（零开销）。
   */
  private setupParticleSystems(entityIoJson?: string): void {
    this.particleSystems?.dispose();
    this.particleSystems = null;
    this.particleLastMs = 0;
    if (!this.scene) return;
    const entities = collectParticleEntities(entityIoJson);
    if (entities.length === 0) return;
    const systems = new ParticleSystems(entities);
    if (systems.root.children.length === 0) {
      systems.dispose();
      return;
    }
    this.particleSystems = systems;
    this.scene.add(systems.root);
    (globalThis as Record<string, unknown>)['__vbspParticles'] = systems;
  }

  /** 实体运行期统计（实体浏览器 / 诊断面板）；未装配返回 null。 */
  entityStats(): EntitySystemStats | null {
    return this.entitySystem?.stats() ?? null;
  }

  /** 启动渲染循环（幂等：已在运行时直接返回）。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.rafId = requestAnimationFrame(this.boundTick);
  }

  /** 停止渲染循环并取消已登记的 rAF。 */
  stop(): void {
    this.running = false;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  // ── 渲染循环 ───────────────────────────────────────────────

  /** 绑定一次的 tick 引用（rAF 每帧登记同一函数对象）。 */
  private readonly boundTick = this.tick.bind(this);

  /** 一个渲染帧的全部工作，顺序固定：① 物理段——输入写共享内存 → 权威帧校准 → 推进本地
   * 物理 → 消费物理事件 → 写渲染采样 → 摆放相机 → 隔帧近平面探测；② 视距剔除；③ 碰撞可视化
   * 更新；④ 限流的准星射线；⑤ 渲染；⑥ 每 100ms 一次的剔除统计。物理段只在 `predReady` 为真
   * 且单步闸门有余量时执行，其余各步每帧都跑。 */
  private tick(now: number): void {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.boundTick);
    if (!this.renderer || !this.scene || !this.camera || !this.cameraController) return;

    // ⓪ 飞行轨迹复播：先按墙钟推进样本、写进 `poseHold`，下面的物理段再把它摆到相机上。
    //    放在物理段之前是必须的——相机摆放只读 `poseHold`，放在后面就会晚一帧。
    this.advanceFlightPlayback(now);

    // ①-1 输入写共享内存（Worker 权威模拟消费同一份输入）→ 权威帧校准 → 推进本地物理。
    // 回放步长只有 replayMode 为真时才会取到（`replayPending`）；取不到就回落墙钟 dt——
    // 两条路都要推进物理，`setReplayMode(true)` 同时被只关权威耦合的录制路径使用，
    // 缺步长就跳过物理会让录制点（挂在物理步上）一帧都收不到。
    const replayPending = this.replayMode ? this.replayDtS : null;
    if (this.predReady && this.predPhys && (!this.stepGated || this.stepQuota > 0)) {
      // 单步闸门：打开时每帧最多推进一个物理步（配额见 setManualSteps），配额耗尽即跳过本帧物理。
      if (this.stepGated) this.stepQuota--;
      // 步长：有录制步长就用它，否则用墙钟间隔（首帧 lastTickMs 为 0 时取 1/64 秒），上限 0.1 秒。
      const dt = replayPending !== null
        ? replayPending
        : (this.lastTickMs === 0 ? 1 / 64 : Math.min((now - this.lastTickMs) / 1000, 0.1));
      // 录制步长是一次性载荷：用掉即清，等待回放端下一帧再提供
      this.replayDtS = null;
      this.lastTickMs = now;
      // 本帧输入 → 共享内存输入槽（Worker 权威模拟消费同一份输入）
      this.shared.addInput(this.pendingDx, this.pendingDy, this.pendingKeys);
      // 权威帧校准：记录新到的权威帧，必要时反向同步或把本地状态重新锚定
      if (!this.replayMode) this.correctFromAuthority();
      // 权威速度外推校准（只改速度，不覆盖位置）
      if (!this.replayMode) this.calibrateVelocity(now);
      // 路径记录 —— tick 物理线：只在权威帧真的更新（`va` 变化）时落点，不做定时轮询。
      // 时间戳用渲染时钟 τ = `readPublishedTau()`（本次发布所依据的渲染采样时刻）：权威发布
      // 位置本身就是渲染轨迹上的一个采样点，只有按 τ 对齐比较，重合的两点才读成同一个点。
      // 不用 `auth.frame.timeMs`：Worker 与主线程的时钟基准不同。τ 为 0 时回落墙钟 `now`。
      if (this.pathRecorder.isRecording) {
        const auth = this.shared.readAuthoritative();
        if (auth) {
          const tau = this.shared.readPublishedTau();
          // 权威 post-tick 位置与发布位置之差（residual）只在 Worker 侧算得出，共享内存未暴露
          // 该读数，故这里固定传 undefined，记录器侧该组统计的样本数保持 0。
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
      // 推进本地物理：keys/dx/dy 传完后立即清零增量（按键掩码由下一次 feedInput 覆盖）
      this.predPhys.tick(dt, this.pendingKeys, this.pendingDx, this.pendingDy);
      this.pendingDx = 0;
      this.pendingDy = 0;
      // 事件消费：把 Rust 侧这一帧产生的 teleport/death 事件交给回调（app.ts 的计时挑战状态机）
      this.consumePhysEvents();
      // 取物理状态摆放相机（Rust 输出的角度是度，这里换成弧度）
      const st = this.predPhys.state() as {
        posX: number; posY: number; posZ: number;
        yaw: number; pitch: number;
        eyeHeight: number;
      };
      // 路径记录 —— 渲染物理线：每个 rAF 物理步一个节点，采样点是脚底（下面的相机 Y 还要再加 eyeHeight）
      this.pathRecorder.addRender(now, st.posX, st.posY, st.posZ);
      // 同一帧、同一三元组写入渲染采样传输（Worker 把权威发布位置投影到这条轨迹上）；
      // `i0` 即刚落点的渲染节点下标，故与 addRender 一一对应。
      // 不传世代：世代槽由 shared-state 在写入时就地读取。
      this.shared.writeRenderSample(now, st.posX, st.posY, st.posZ, this.renderSampleIndex++);
      const cc = this.cameraController;
      const hold = this.poseHold; cc.setYawPitch(hold ? hold.yawRad : st.yaw * DEG2RAD, hold ? hold.pitchRad : st.pitch * DEG2RAD, false);
      cc.update();
      // 相机放在眼睛高度（脚底 + eyeHeight），不做任何位置修正
      const camY = hold ? hold.y : st.posY + st.eyeHeight;
      cc.setPosition(hold ? hold.x : st.posX, camY, hold ? hold.z : st.posZ);

      // Source 实体运行期：与物理同帧推进（touch 用本帧 state，0 延迟输出当帧消费）。
      this.entitySystem?.frame(dt);
    } else if (this.stepGated) {
      // 闸门跳过物理的帧也要推进墙钟基准，否则闸门恢复时会拿到一个异常大的 dt
      this.lastTickMs = now;
    }

    // ⓪-2 飞行轨迹录制：记**相机**位姿（不是脚底），所以放在相机摆放之后、渲染之前；
    //      复播中也照记（可以把一条轨迹的某一段再录成新轨迹）。
    if (this.flightPath.isRecording) {
      const pose = cameraPoseOf(this.camera);
      if (pose) this.flightPath.add(now, pose.pos[0], pose.pos[1], pose.pos[2], pose.yawDeg, pose.pitchDeg);
    }

    const camPos = this.camera.position;

    // ② 可见性：共享会话判定（距离优先 → PVS）；有变化时按需渲染补一帧
    const vis = this.session?.updateVisibility();
    if (vis?.changed) this.needsRender = true;

    // ③ 碰撞体/触发器/三角面可视化
    if (this.colliderDebug.hasDebugWork) {
      if (this.colliderDebug.update(camPos, this.colliders, this.config)) {
        this.needsRender = true;
      }
    }

    // ④ 准星射线：计数器满 PLANE_INSPECT_INTERVAL 才检测一次；开关关闭时清掉上次结果
    if (this.planeInfoEnabled) {
      this.planeInspectCounter++;
      if (this.planeInspectCounter >= PLANE_INSPECT_INTERVAL) {
        this.planeInspectCounter = 0;
        this.inspectPlane();
      }
    } else if (this.lastPlaneInfo !== null) {
      this.lastPlaneInfo = null;
    }

    // ④-2 PCF 粒子：按墙钟推进（物理停走时仍动），纹理滚动/辉光呼吸在 `update` 内。
    if (this.particleSystems) {
      const pdt = this.particleLastMs === 0 ? 1 / 64 : Math.min((now - this.particleLastMs) / 1000, 0.1);
      this.particleLastMs = now;
      this.particleSystems.update(pdt, this.camera);
      this.needsRender = true;
    } else {
      this.particleLastMs = 0;
    }

    // ⑤ 渲染：物理就绪后每帧都渲染；needsRender 只用于物理未就绪时的强制刷新。
    // 近平面在 noclip 下跳过（位置不受碰撞约束）。
    const shouldRender = this.predReady || this.needsRender;
    if (shouldRender) {
      this.session?.frame({
        updateVisibility: false,
        updateNearPlane: !this.noclipActive && !!this.bspModelScene,
      });
      this.needsRender = false;
    }

    // ⑥ 剔除统计：至少间隔 100ms 才下发一次
    if (now - this.lastStatsAt > 100) {
      this.lastStatsAt = now;
      this.emitCullStats();
    }
  }

  /** 上次下发剔除统计的墙钟毫秒。 */
  private lastStatsAt = 0;

  /** 准星射线检测：从相机位置沿相机前方发射，与 BSP mesh、碰撞体与触发器求交，
   * 结果存 `lastPlaneInfo` 供 HUD 读取。 */
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

  /** 面板实时调整近平面参数：转发共享控制器（判据见 `src/renderer-shared/camera/near-plane.ts`）；
   * debug 的按需渲染标记照旧置位。 */
  setNearParams(probeDist?: number, ratio?: number): void {
    this.session?.setNearParams(probeDist, ratio);
    this.needsRender = true;
  }

  /** PVS 区域着色开关（debug 面板）：转发共享 RenderSession；返回是否真的开启。 */
  setPvsRegionOverlay(on: boolean): boolean {
    const applied = this.session?.setPvsRegionOverlay(on) ?? false;
    this.needsRender = true;
    return applied;
  }

  // ── 外部接口 ───────────────────────────────────────────────

  /** 最近一次准星检测结果（准星开关关闭时被清为 null）。 */
  getPlaneInfo(): PlaneInfo | null {
    return this.lastPlaneInfo;
  }

  /** 调整渲染器与相机的输出尺寸（aspect = width / max(height, 1)，与 near/far 无关）。 */
  resize(width: number, height: number): void {
    this.session?.resize(width, height);
    this.needsRender = true;
  }

  /** 面板用：即时改相机 FOV。 */
  setFov(fov: number): void {
    this.session?.setFov(fov);
    this.needsRender = true;
  }

  /** 设置视距剔除距离：夹到 [0, maxCull] 后交给共享会话，并写共享档 `culling.distance`。 */
  setCullDistance(dist: number): void {
    if (!this.session) return;
    const clamped = Math.max(0, Math.min(dist, this.session.stats().maxCull));
    const applied = this.session.setCullDistance(clamped);
    writeRenderPrefs({ culling: { distance: clamped } });
    this.config.lod.cullDistance = applied;
    this.needsRender = true;
  }

  // ── 物理路径记录（面板控制）──────────────────────────────────
  // 两条线各自独立：渲染物理线（本地 predPhys，每个 rAF 物理步一点）、tick 物理线（Worker 权威帧，
  // 每条新帧一点）；采样点都是脚底中心（PhysWorld 的 x/y/z 原点）。

  /** 让记录器开始收点（之后每个物理步与每条权威帧都会各落一点）。 */
  startPathRecording(): void {
    this.pathRecorder.start();
    this.needsRender = true;
  }

  /** 停止收点，已落的点保留在记录器里。 */
  stopPathRecording(): void {
    this.pathRecorder.stop();
  }

  /** 记录器当前是否在收点。 */
  isPathRecording(): boolean {
    return this.pathRecorder.isRecording;
  }

  /** 清空已落的点与序号空间，但不改变当前的记录状态。 */
  clearPath(): void {
    this.pathRecorder.clear();
    // 记录器的渲染节点索引空间重启，采样序号随之归零；同时让采样失效世代 +1，
    // 避免新序号与 Worker 缓存里的旧世代同号项混淆。
    this.renderSampleIndex = 0;
    this.bumpSampleEpoch();
    this.needsRender = true;
  }

  /** 单独显隐渲染物理线（两条线对比时可只留 tick 线）。
   *
   * 2026-09-26：原 `setPathVisible`（整组显隐）随其唯一调用方 `#pathVisibleChk` 一并删除
   * ——该 id 在页面不存在，且四个分量开关（`setPathRenderVisible` / `setPathTickVisible` /
   * `setPathDotsVisible` / `setPathDeviVisible`）已覆盖其语义。 */
  setPathRenderVisible(visible: boolean): void {
    this.pathRecorder.setRenderVisible(visible);
    this.needsRender = true;
  }

  /** 单独显隐 tick 物理线（其节点方点标记随该线一起显隐）。 */
  setPathTickVisible(visible: boolean): void {
    this.pathRecorder.setTickVisible(visible);
    this.needsRender = true;
  }

  /** 单独显隐偏差梳：每条连线从 tick 节点指向渲染线在同一时刻的位置。 */
  setPathDeviVisible(visible: boolean): void {
    this.pathRecorder.setDeviVisible(visible);
    this.needsRender = true;
  }

  /** 单独显隐 tick 节点的方点标记（只关心折线走向时可关掉）。 */
  setPathDotsVisible(visible: boolean): void {
    this.pathRecorder.setDotsVisible(visible);
    this.needsRender = true;
  }

  /** 折线形状统计：段数、轴对齐段数、折角超过 45° 的段数、绘制长度、节点间直线长度与两者比值。 */
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
   * 路径距离统计（HU）：三组量口径不同，不可混用。
   * - `perp`：垂距——tick 点到渲染折线的最短距离，只扫 ±250ms 时间窗内的线段；面板 p95 读数
   *   用它（面板近似窗，非全量最近搜索口径）。
   * - `mean/max/green/yellow/red`：偏差梳——tick 点与其同时刻渲染位置的直线距离。
   * - `residual`：残差——权威 post-tick 位置与发布位置的距离；本类的调用点拿不到该读数，
   *   故这组统计的样本数恒为 0。
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

  /** 两条线各自已落的点数。 */
  getPathCounts(): { render: number; tick: number } {
    return this.pathRecorder.counts();
  }

  /** 导出路径 JSON（两条线的时间序列；`meta` 原样并入导出对象，供会话标签用）。 */
  exportPathJson(meta?: Record<string, unknown>): string {
    return this.pathRecorder.toJson(meta);
  }

  /** 导出 CSV，列为 line,t_ms,x_hu,y_hu,z_hu。 */
  exportPathCsv(): string {
    return this.pathRecorder.toCsv();
  }

  // ── 飞行轨迹录制 / 复播（面板「飞行轨迹」与 `__vbspFlight` 共用）──────────
  // 与上面的物理路径记录是两件事：这里采的是**相机**位姿，复播直接把相机钉到样本上，
  // 不推进物理、不吃输入，所以 noclip 穿过几何、反复 seek 到同一时刻，画面都一致。

  /** 开始录制飞行轨迹（清空旧轨迹；复播中调用会先停掉复播，避免把复播位姿录进去）。 */
  startFlightRecording(): void {
    this.stopFlightPlayback();
    this.flightPath.start(performance.now());
    this.needsRender = true;
  }

  /** 停止录制：已落的点保留，可继续导出 / 复播。 */
  stopFlightRecording(): void {
    this.flightPath.stop();
  }

  /** 是否正在录制飞行轨迹。 */
  isFlightRecording(): boolean {
    return this.flightPath.isRecording;
  }

  /** 清空飞行轨迹（不改录制状态；复播中调用会先停掉复播）。 */
  clearFlightPath(): void {
    this.stopFlightPlayback();
    this.flightPath.clear();
    this.needsRender = true;
  }

  /** 记录当前地图名（导出轨迹时写进 meta；`loadScene` 成功后由 app.ts 调用）。 */
  setFlightMapName(name: string): string {
    this.flightMapName = name;
    return this.flightMapName;
  }

  /** 轨迹状态：点数、时长、是否在录（复播状态另见 `getFlightPlayback()`）。 */
  getFlightStatus(): FlightPathStatus {
    return this.flightPath.status();
  }

  /** 导出轨迹 JSON：`meta.map` 缺省填当前地图名。 */
  exportFlightJson(meta: FlightFileMeta = {}): string {
    return this.flightPath.toJson({ map: this.flightMapName, ...meta });
  }

  /** 载入轨迹 JSON（替换当前轨迹，不开始录制）；格式错时抛错，由 UI/脚本显示。 */
  loadFlightJson(text: string): FlightLoadResult {
    const result = this.flightPath.loadJson(text);
    this.needsRender = true;
    return result;
  }

  /**
   * 从头复播（需要已载入轨迹）。`speed` 夹到 [0.05, 16]，`loop` 为真时播到末尾回绕。
   * 复播期间输入被清零（否则物理会把角色推走），相机完全由轨迹决定。
   */
  playFlight(opts: { speed?: number; loop?: boolean } = {}): boolean {
    if (this.flightPath.count === 0) return false;
    this.flightPlayback = {
      tMs: 0,
      speed: Math.max(0.05, Math.min(opts.speed ?? 1, 16)),
      loop: opts.loop === true,
      paused: false,
      lastWallMs: performance.now(),
      holdBackup: this.poseHold,
    };
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
    this.needsRender = true;
    return true;
  }

  /** 暂停复播：停住时钟，但仍每帧把当前样本摆到相机上。 */
  pauseFlight(): void {
    if (this.flightPlayback) this.flightPlayback.paused = true;
  }

  /** 继续复播（丢弃暂停期间的时间间隙）。 */
  resumeFlight(): void {
    const pb = this.flightPlayback;
    if (!pb) return;
    pb.paused = false;
    pb.lastWallMs = performance.now();
  }

  /**
   * 定位到轨迹 `tMs` 并不再自动前进（复播中调用则改为暂停在该时刻）。
   * 截图脚本用它：`load` → `seek(t)` → 等两帧 → 截图。
   */
  seekFlight(tMs: number): void {
    const duration = this.flightPath.durationMs;
    const t = Math.max(0, Math.min(Number.isFinite(tMs) ? tMs : 0, duration));
    const now = performance.now();
    const pb = this.flightPlayback;
    if (pb) {
      pb.tMs = t;
      pb.paused = true;
      pb.lastWallMs = now;
    } else {
      this.flightPlayback = {
        tMs: t,
        speed: 1,
        loop: false,
        paused: true,
        lastWallMs: now,
        holdBackup: this.poseHold,
      };
    }
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
    this.needsRender = true;
  }

  /** 结束复播并把位姿冻结还原成复播前的状态（相机随即回到物理/用户钉点）。 */
  stopFlightPlayback(): void {
    const pb = this.flightPlayback;
    if (!pb) return;
    this.flightPlayback = null;
    this.poseHold = pb.holdBackup;
    this.needsRender = true;
  }

  /** 是否处于复播（含暂停）。 */
  isFlightPlaying(): boolean {
    return this.flightPlayback !== null;
  }

  /** 运行期改复播速率（面板下拉即时生效，不必重播）。 */
  setFlightSpeed(speed: number): void {
    const pb = this.flightPlayback;
    if (!pb || !Number.isFinite(speed)) return;
    pb.speed = Math.max(0.05, Math.min(speed, 16));
  }

  /** 运行期改循环开关（播到末尾时才用得上）。 */
  setFlightLoop(loop: boolean): void {
    if (this.flightPlayback) this.flightPlayback.loop = loop;
  }

  /** 复播进度快照（面板状态行/脚本用）；未复播返回 null。 */
  getFlightPlayback(): { tMs: number; durationMs: number; speed: number; loop: boolean; paused: boolean } | null {
    const pb = this.flightPlayback;
    if (!pb) return null;
    return { tMs: pb.tMs, durationMs: this.flightPath.durationMs, speed: pb.speed, loop: pb.loop, paused: pb.paused };
  }

  /**
   * 每帧推进复播：按墙钟前进 `tMs`，取插值样本写进 `poseHold`。
   * 播到末尾时 `loop` 回绕，否则停在末尾（保持画面，不弹回玩家位置）。
   */
  private advanceFlightPlayback(nowMs: number): void {
    const pb = this.flightPlayback;
    if (!pb) return;
    const duration = this.flightPath.durationMs;
    if (!pb.paused) {
      pb.tMs += Math.max(0, nowMs - pb.lastWallMs) * pb.speed;
      pb.lastWallMs = nowMs;
      if (pb.tMs >= duration) {
        if (pb.loop && duration > 0) pb.tMs = pb.tMs % duration;
        else {
          pb.tMs = duration;
          pb.paused = true;
        }
      }
    }
    // 复播期不让输入影响物理：相机由轨迹决定，但角色乱跑会把实体/触发器带偏
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
    const sample = this.flightPath.sampleAt(pb.tMs);
    if (!sample) {
      this.stopFlightPlayback();
      return;
    }
    this.poseHold = {
      x: sample.x,
      y: sample.y,
      z: sample.z,
      yawRad: sample.yaw * DEG2RAD,
      pitchRad: sample.pitch * DEG2RAD,
    };
    this.needsRender = true;
  }

  /** 应用配置 patch：先按 `section` 把字段并进 `config[section]`，再做该段的联动——
   * `lighting` 同步灯光、`debug` 重灌三组可视化开关与准星开关、`input` 交给相机控制器、
   * `texture` 触发一次画质应用、`lod` 只需重渲一帧。段不存在或不是对象时直接返回。 */
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
      this.colliderDebug.setBevelVisible(this.config.debug.showBevel);
      this.colliderDebug.setPhyBevelVisible(this.config.debug.showPhyBevel);
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
   * 算法本体在共享核 `src/renderer-shared/scene/texture-quality.ts`（2026-10-04 与 game
   * 的同源副本合并而来）；debug 侧包装保留诊断日志（消息与合并前一致）、
   * `ensureMainWasm` 钩子与 `needsRender` 置位（按需渲染）。
   */
  async applyTextureQuality(quality: 'original' | 'mini'): Promise<void> {
    console.log(`[renderer] 画质切换 → ${quality}，bspModelScene=${!!this.bspModelScene}`);
    const stats = await this.session?.applyTextureQuality(quality);
    if (!stats) return;
    console.log(`[renderer] 场景贴图 ${stats.mapCount} 个`);
    console.log(
      `[renderer] mini 匹配 ${stats.matched}/${stats.mapCount}；未匹配:`,
      stats.noMatch.slice(0, 12),
    );
    this.needsRender = true;
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
   * 物理实例。`teleportToPos` 做不到后者——传送会把速度清零，而回放起点为空中高速状态时
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
   * @returns 种子 JSON；物理未就绪时返回 null（回放退化为部分对齐）
   */
  captureFullPhysState(): string | null {
    const phys = this.predPhys;
    if (!phys) return null;
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
    const phys = this.predPhys;
    if (!phys) return false;
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
    return this.session?.pvsManager?.currentClusterId ?? -1;
  }

  /**
   * 当前**相机**位姿（HUD 朝向显示 / 复现截图用）。
   *
   * 注意：`getCurrentState()` 给的是**脚底**与物理 yaw/pitch，而相机受 `poseHold`、眼高、
   * 视角回摆影响，两者可能不一致。要复现一张截图必须用相机位姿——HUD 里没有朝向时，
   * 只靠脚底坐标根本没法复刻视角（这是我反复复现失败的原因）。
   */
  getCameraPose(): { pos: [number, number, number]; yawDeg: number; pitchDeg: number } | null {
    const pose = cameraPoseOf(this.camera);
    if (!pose) return null;
    return { pos: pose.pos, yawDeg: pose.yawDeg, pitchDeg: pose.pitchDeg };
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

  // ── GLB 加载：2026-10-04 起走共享 buildMapScene（src/renderer-shared/scene/scene-builder.ts），
  //    私有 loadGlb / resetRootRotations 副本随装配链对齐一并删除。

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

  /** 回传剔除统计（共享会话的可见性 + PVS 数据）。 */
  private emitCullStats(): void {
    if (!this.onCullStats || !this.session) return;
    const lodStats = this.session.stats();
    if (lodStats.total <= 0) return;
    const pvsStats = this.session.pvsStats();
    this.onCullStats({
      visible: lodStats.visible,
      total: lodStats.total,
      cullDist: lodStats.cullDistance,
      rev: lodStats.rev,
      reasons: lodStats.reasons,
      pvs: {
        cluster: pvsStats.currentCluster,
        visibleClusters: pvsStats.visibleCount,
        totalClusters: pvsStats.totalClusters,
        pvsHidden: lodStats.pvsHidden,
        near: lodStats.near,
        far: lodStats.far,
      },
    });
  }

  // 复用向量
  private readonly _fwdDir = new THREE.Vector3();
}

const DEG2RAD = Math.PI / 180;
