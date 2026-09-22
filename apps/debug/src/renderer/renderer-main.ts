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
 * （`src/ts-shared/phys/world-builder.ts`）在主线程解析后传入。GLB 交 `GLTFLoader`，
 * 碰撞体交 `adaptBrushes`、可见集交 `PvsManager`、传送触发器交 `TeleportManager`、
 * 光照图图集交 `loadLightmapAtlas`（`apps/debug/src/renderer/lightmap-shader.ts`）。
 *
 * 子管理器全部由本类持有：`CameraController`（视角输入）、`LightManager`（灯光/阴影/雾）、
 * `LodManager`（分块与剔除距离）、`ColliderDebug`（碰撞体与触发器可视化）、
 * `PathRecorder`（物理轨迹取样）、`PlaneInspector`（准星射线）；权威帧对齐交
 * `AuthorityCalibrator`（`src/ts-shared/phys/authority-calibrator.ts`）。
 * 渲染采样写入共享内存的口径见本文件内紧随共享内存导入的那段说明。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries, deinterleaveGeometry } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
import { applyLightmapToMeshes, loadLightmapAtlas, setLightingMode as setLightingModeInShader, getLightingMode, type LightingMode } from './lightmap-shader.js';

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

/** 相机垂直视场角（度）：`init` 建 `THREE.PerspectiveCamera` 时传入，另在 `optimizeScene`
 * 的可见块估算里用于算半角余弦；运行期不改。 */
const FOV = 73.6;
/** 准星射线检测间距（帧）：`planeInspectCounter` 计满该值才调一次 `inspectPlane` 并清零。 */
const PLANE_INSPECT_INTERVAL = 6;
/** 相机 `near` 下限（HU）：`loadScene` 给 `defaultNear` 兜底，`updateNearPlane` 给收缩
 * 结果兜底——只改投影矩阵，相机位置不动。 */
const CAMERA_NEAR_MIN = 0.05;
/** 近平面探测距离默认值（HU）：包围球粗筛半径用 `probe × 2 + 球半径`，射线 `far` 直接用
 * `probe`；命中距离记入 `minD`。
 * 运行期由面板经 `setNearParams` 改写（只接受 > 0），下一帧探测即生效。 */
const NEAR_PROBE_DIST_DEFAULT = 100;
/** near 收缩系数默认值：`near` = 4 方向最近命中距离 × 该值，再与 `CAMERA_NEAR_MIN` 取大；
 * 无命中（`minD` 非有限）时恢复 `defaultNear`。
 * 运行期由面板经 `setNearParams` 改写（只接受区间 (0, 1]）。 */
const NEAR_RATIO_DEFAULT = 0.3;

/** HUD 剔除统计（`emitCullStats` 组装，交给 app.ts 注册的 `onCullStats`）。
 * `visible/total/cullDist` 与 `pvs.near/far/pvsHidden` 取自 `LodManager.getStats`——
 * 该管理器只按「块中心到相机距离 > cullDistance」判可见，`near` = 可见块数、
 * `far` = 隐藏块数、`pvsHidden` 恒 0。
 * `pvs.cluster/visibleClusters/totalClusters` 取自 `PvsManager.getStats`：本文件只构造
 * `PvsManager`、把它的 `getClusterAt` 交给 `LodManager.assignClusterIds` 用、并读
 * `getStats`/`currentClusterId`，**从不调 `update`**，故 `cluster` 恒 -1、`visibleClusters`
 * 恒 0。`lodManager.itemCount <= 0` 时整个回调不下发。 */
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

// ── 空间分块合并参数（optimizeScene：GLB 挂载后执行一次）──────────
// 动机：GLTFLoader 对 GLB 的每个 primitive 建一个 THREE.Mesh，未合并时每帧三处开销都随
// Mesh 数线性增长——renderer.render 的视锥剔除与逐 mesh draw call、LodManager.update 的
// 逐项距离判定、updateNearPlane 的整树 traverse + 包围球测试。合并把对象压成「块」：
// 单 mesh cell 直接复用原 mesh，多 mesh cell 在块内按材质实例分组后合并，一块的 draw
// call 数 = 该块的材质数。
// 载体：在 BSP 根内替换内容（移除 gltf.scene，块 mesh 直接挂 BSP 根，userData.isBspModel 保留）。
/** 目标 cell 数：cell 边长初值 = 世界包围盒对角线 / cbrt(该值)。 */
const OPT_TARGET_CELLS = 512;
/** 分块合并总开关：false 时 `loadScene` 不调 `optimizeScene`，保留 GLTFLoader 原始场景图。 */
const OPTIMIZE_SCENE_ENABLED = true;
/** 非空 cell 数目标区间：自适应循环最多 6 轮，落进区间即停。 */
const OPT_MIN_CELLS = 300;
const OPT_MAX_CELLS = 800;
/** cell 边长钳制（世界单位）：初值与每轮缩放结果都夹在该区间内。 */
const OPT_CELL_MIN = 128;
const OPT_CELL_MAX = 4096;
/**
 * 视锥外保留圈：`optimizeScene` 末尾把每个块的 `geometry.boundingSphere.radius` 乘上该
 * 系数。three.js 每帧按包围球判剔除，膨胀后视锥外一圈几何仍参与渲染。
 */
const FRUSTUM_PAD = 1.6;

/** 分块收集项：mesh 与它的世界包围盒中心（后者用于算 cell 键）。 */
interface OptMeshInfo {
  mesh: THREE.Mesh;
  cx: number;
  cy: number;
  cz: number;
}

/** cell 键：世界坐标按 cellSize 向下取整后拼串（一次性分桶，不做性能优化）。 */
function optCellKey(x: number, y: number, z: number, cellSize: number): string {
  return Math.floor(x / cellSize) + '|' + Math.floor(y / cellSize) + '|' + Math.floor(z / cellSize);
}

/**
 * 合并前归一：让同组 geometry 的属性布局一致，否则 `mergeGeometries` 直接失败返回 null。
 *
 * 两步：
 * 1. 索引不一致（组内既有带 index 又有不带）时，把带 index 的转成非索引几何；
 *    全带或全不带则原样保留。
 * 2. 若组内出现多于一种 `BufferAttribute.gpuType`（值为 undefined 时按 0 计），
 *    逐份 clone 后重建属性：先把交错属性解交错（`deinterleaveGeometry`），再按
 *    `count × itemSize` 显式拷成 `Float32Array`，保留 `normalized` 标志；拷贝长度与
 *    `count × itemSize` 不等时打印错误并继续。
 *
 * 交错属性必须解交错的原因：`InterleavedBufferAttribute.array` 是整段 stride 缓冲
 * （长度 = count × stride），而 `itemSize` 只是逻辑分量数，直接按 `itemSize` 重建会得到
 * 非整数顶点数——three.js 逐顶点读到 undefined，包围盒/包围球变 NaN，`LodManager` 的
 * cullDistance 随之为 NaN，最终一个块都不渲染。
 */
function normalizeMergeGroup(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry[] {
  const hasIdx = geoms.some((g) => g.index !== null);
  const allIdx = geoms.every((g) => g.index !== null);
  let out = hasIdx && !allIdx ? geoms.map((g) => (g.index ? g.toNonIndexed() : g)) : geoms;
  const gpuTypes = new Set<number>();
  for (const g of out) {
    for (const name of Object.keys(g.attributes)) {
      const a = g.attributes[name] as THREE.BufferAttribute;
      gpuTypes.add((a as unknown as { gpuType?: number }).gpuType ?? 0);
    }
  }
  if (gpuTypes.size > 1) {
    out = out.map((g) => {
      const g2 = g.clone();
      // 交错属性先摊平成普通属性：其 array 是整段 stride 缓冲，直接重建会切出非整数顶点数
      if (Object.values(g2.attributes).some((a) => (a as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute)) {
        deinterleaveGeometry(g2);
      }
      for (const name of Object.keys(g2.attributes)) {
        const a = g2.attributes[name] as THREE.BufferAttribute;
        // 长度固定为 count × itemSize 的新缓冲，逐元素拷贝原数据
        const src = a.array as ArrayLike<number>;
        const arr = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < arr.length; i++) arr[i] = src[i] as number;
        // 长度自洽检查：分配式与比较式同为 count × itemSize，不等时打印属性名与三个长度
        if (arr.length !== a.count * a.itemSize) {
          console.error(
            `[optimizeScene] 属性 ${name} 长度不自洽：array=${arr.length} count=${a.count} itemSize=${a.itemSize}`,
          );
        }
        g2.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
      }
      g2.dispose();
      return g2;
    });
  }
  return out;
}

/** 非空 cell 计数：把所有收集项换算成 cell 键后取集合大小（cell 边长自适应循环的判据）。 */
function optCountCells(infos: OptMeshInfo[], cellSize: number): number {
  const keys = new Set<string>();
  for (const it of infos) keys.add(optCellKey(it.cx, it.cy, it.cz, cellSize));
  return keys.size;
}

/** 主线程渲染器：持有 WebGL 渲染器、场景、相机与全部子管理器。相机不再本地插值——
 * 每个渲染帧由 `tick` 用 `predPhys.state()` 直接摆放。 */
export class RendererMain {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private cameraController: CameraController | null = null;
  private pvsManager: PvsManager | null = null;
  private teleportManager: { getTriggers(): readonly TeleportTrigger[] } | null = null;
  /** 实体碰撞体列表 = `solids` + `ladders`（`ColliderDebug` 的碰撞箱可视化数据源）。 */
  private colliders: Brush[] = [];
  /** 固体 brush（`PlaneInspector.cast` 用它区分命中物的 brushType）。 */
  private solids: Brush[] = [];
  /** 梯子 brush（同上，命中物分类用）。 */
  private ladders: Brush[] = [];
  /** 传送触发器（`TeleportManager.getTriggers` 的快照；可视化与准星射线共用）。 */
  private triggers: TeleportTrigger[] = [];
  /** BSP 模型场景根（`loadScene` 挂到 `scene` 下；`optimizeScene`、`updateNearPlane`、
   * `inspectPlane`、`applyTextureQuality` 都从它开始遍历）。 */
  private bspModelScene: THREE.Object3D | null = null;

  /** 灯光与光照参数（`init` 里 `applyLights`；lighting 段 patch 时 `syncFromConfig`）。 */
  private readonly lightManager = new LightManager();
  /** 物理轨迹记录器：渲染物理线每物理步一点、tick 物理线每条新权威帧一点，采样点均为脚底中心。 */
  private readonly pathRecorder = new PathRecorder();
  /** 分块可见性管理器：`setup` 收集块、`assignClusterIds` 借 PVS 定位 cluster、`update` 按相机距离判可见。 */
  private readonly lodManager = new LodManager();
  /** 碰撞体/触发器/三角面/chamfer 可视化；`hasDebugWork` 为假时 `tick` 跳过它的 `update`。 */
  private readonly colliderDebug = new ColliderDebug();
  /** 准星射线检测器：从相机前方发射，与 mesh/碰撞体/触发器求交，结果经 `getPlaneInfo` 给 HUD。 */
  private readonly planeInspector = new PlaneInspector();

  private planeInfoEnabled = false;
  private planeInspectCounter = 0;
  private lastPlaneInfo: PlaneInfo | null = null;

  // ── 近平面贴墙自适应（面板可实时调节）────────────────────
  /** 当前探测距离（HU）：初值 `NEAR_PROBE_DIST_DEFAULT`，由 `setNearParams` 改写。 */
  private nearProbeDist = NEAR_PROBE_DIST_DEFAULT;
  /** 当前 near 收缩系数：初值 `NEAR_RATIO_DEFAULT`，由 `setNearParams` 改写。 */
  private nearRatio = NEAR_RATIO_DEFAULT;

  /** 运行期配置（`init` 赋值；`applyConfigPatch` 就地改写其子段）。 */
  private config: RuntimeConfig = null as unknown as RuntimeConfig;
  /** 强制渲染标记：`tick` 渲染一次后清零，场景变化处置真。 */
  private needsRender = true;
  /** rAF 句柄（`start` 登记，`stop` 取消）。 */
  private rafId = 0;
  /** 渲染循环开关：`stop` 置假后 `tick` 直接返回。 */
  private running = false;

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

  // ── 近平面自适应（不移动相机，只改投影矩阵的 near）────────
  /** 复用的射线/向量/球对象（`updateNearPlane` 每轮重用，避免逐帧分配）。 */
  private readonly _nearRaycaster = new THREE.Raycaster();
  private readonly _nearOrigin = new THREE.Vector3();
  private readonly _nearDirF = new THREE.Vector3();
  private readonly _nearDirR = new THREE.Vector3();
  private readonly _nearSphere = new THREE.Sphere();
  /** 探测节拍：每个物理帧翻转一次，只在为真（隔帧）时执行一次近平面探测。 */
  private nearCheckToggle = false;
  /** 场景默认 near = max(世界最大边长 / 1000, `CAMERA_NEAR_MIN`)，`loadScene` 计算；
   * 探测无命中时 `updateNearPlane` 把 near 恢复成它。 */
  private defaultNear = CAMERA_NEAR_MIN;

  /** 剔除统计回调（app.ts 注册为 HUD 刷新；`emitCullStats` 最多每 100ms 触发一次）。 */
  onCullStats: ((stats: CullStatsLike) => void) | null = null;
  /** 场景加载完成回调：`loadScene` 末尾传出场景包围盒最小 Y（死亡阈值的下界）。 */
  onSceneLoaded: ((deathThresholdY: number) => void) | null = null;

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

  // ── 纹理画质切换（mosaic）──────────────────────────────────
  /** 画质 manifest（`loadScene` 从 `SceneDataMessage.mosaicManifest` 解析）：
   * 键为小写纹理名、值为 mosaic 字节码；null 表示该地图没有可切换数据。 */
  private mosaicManifest: Record<string, string> | null = null;
  /** 原图缓存：切到 mini 前存下 `map.image`，切回 original 时写回并强制重建 GPU 纹理。 */
  private readonly origTextureImages = new Map<THREE.Texture, unknown>();

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
    // 光照模式（面板「预烘焙 / 纯纹理」）：模块级开关，交由 lightmap-shader 的
    // applyLightmapToMeshes 分流；在加载地图前设定，使该图的所有材质从一开始就按同一模式注入。
    setLightingModeInShader(config.lighting?.mode ?? 'baked');
    // 跨线程通道形态与本地采样世代计数（诊断用；世代不参与协议，见 sampleEpoch）
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
    // 物理路径可视化挂在根场景而不是 bspModelScene 下：后者每次换图重建，而路径要跨图保留；
    // 该 group 自身 frustumCulled=false，不受剔除影响
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
   * 卸载当前地图的渲染资源与本地状态（`loadScene` 开头、app.ts 的换图入口都会调用）。
   *
   * three.js 的 `scene.remove()` 只摘除场景图，geometry/material/纹理仍留在 GPU 侧，反复
   * 加载会持续占用显存与 JS 堆。本方法递归 dispose 每个 `userData.isBspModel` 子树，释放
   * three.js 的渲染列表缓存，再清空本地引用、子管理器状态、渲染物理线与权威校准状态。
   * `LightManager` 的灯光不在此列——它按 config 替换式更新。
   */
  disposeScene(): void {
    // 1. BSP 模型子树：递归释放 geometry/material/纹理
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

    // 2. three.js 渲染列表缓存
    this.renderer?.renderLists?.dispose();

    // 3. 子管理器与本地引用清零
    this.lodManager.dispose();
    this.pvsManager = null;
    this.teleportManager = null;
    this.colliders = [];
    this.solids = [];
    this.ladders = [];
    this.triggers = [];
    // 碰撞可视化清空（group 与 scene 引用保留，新地图直接复用）
    this.colliderDebug.clearAll();

    // 4. 渲染物理线状态清零（待喂输入一并清掉）
    this.predPhys = null;
    this.predReady = false;
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
    this.noclipActive = false;
    this.lastTickMs = 0;
    this.deathY = null;
    // 权威校准状态清零（旧图的权威帧不得注入新图）
    this.calibrator.clear();
    // 换图使采样流不连续 → 采样失效世代 +1
    this.bumpSampleEpoch();
    this.needsRender = true;
  }

  /** 递归释放子树里每个 mesh 的 geometry、材质及其引用的贴图。 */
  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if (!mat) continue;
        // 释放材质引用的各张贴图（列表覆盖 map/lightMap/emissive 等常用槽位；重复 dispose 幂等）
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

  /**
   * 切换光照模式（面板「预烘焙 / 纯纹理」）：转交 `lightmap-shader` 的 `setLightingMode`，
   * 由它改写全场景材质共享的 bakedMix uniform，立即生效——不重建场景、不重编译材质、
   * 不打断输入与物理。模式与当前一致时直接返回。
   */
  setLightingMode(mode: LightingMode): void {
    if (getLightingMode() === mode) return;
    setLightingModeInShader(mode);
    console.info(`[lighting] 光照模式 → ${mode}（运行期 uniform 切换，未重建场景）`);
  }

  /** 当前光照模式（面板回填与日志用；读的是 lightmap-shader 的模块级值）。 */
  getLightingMode(): LightingMode {
    return getLightingMode();
  }

  /** 加载一副地图：GLB → lightmap atlas → 空间分块合并 → 包围盒与 near/far → LOD/PVS/
   * 传送触发器/贴图 manifest/碰撞体，返回 `LodManager.setup` 给出的对角线信息。 */
  async loadScene(data: SceneDataMessage): Promise<{ diagonal: number; defaultCull: number; maxCull: number } | null> {
    if (!this.scene || !this.camera) return null;
    this.disposeScene();

    const gltf = await this.loadGlb(data.glb);
    const scene = new THREE.Scene();
    gltf.scene.userData.isBspModel = true;
    this.resetRootRotations(gltf);
    scene.add(gltf.scene);
    this.collectMetadata(scene);

    // lightmap：atlas 由 GLB extras 的 textureIndex 解出，**与光照模式无关地一律加载并应用**
    // （两种模式的差别只在片元里的共享 uniform 分支，见 lightmap-shader 的 setLightingMode）。
    const atlasTexture = await loadLightmapAtlas(gltf.parser, gltf);
    if (atlasTexture) {
      applyLightmapToMeshes(scene, atlasTexture);
    }
    // 空间分块合并：必须在下面的 updateMatrixWorld / boundingBox 以及 LOD·PVS 注册
    //（lodManager.setup 与 assignClusterIds）之前执行——块几何已烘焙到世界空间，包围盒与
    // 相机 near/far 要按块重算，LOD 项与 clusterId 也要注册到分块后的 mesh。
    // 放在 lightmap 之后：lightmap 按原 mesh 的材质/UV 施加，材质实例在合并中按实例去重保留。
    if (OPTIMIZE_SCENE_ENABLED) this.optimizeScene(scene, gltf.scene);
    scene.updateMatrixWorld(true);
    const boundingBox = new THREE.Box3().setFromObject(scene);
    const size = boundingBox.getSize(new THREE.Vector3());

    // 摘除旧的 BSP 模型子树引用（资源已由开头的 disposeScene 释放，这里只防场景里叠加两份）
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

    // LOD 与 PVS：setup 收集块并按对角线定剔除距离，随后用 PVS 给每个块分配 clusterId
    const diagInfo = this.lodManager.setup(scene, this.config);
    this.pvsManager = new PvsManager(data.pvsJson);
    this.lodManager.assignClusterIds(this.pvsManager);

    // 传送触发器：进碰撞可视化，同时作为准星射线的 trigger 命中面
    this.teleportManager = new TeleportManager(data.teleportJson);
    this.triggers = [...this.teleportManager.getTriggers()];
    this.colliderDebug.setTriggers(this.triggers);
    if (data.triJson) {
      this.colliderDebug.setTriMeshes(JSON.parse(data.triJson));
    }

    // 纹理画质 manifest 就位后，按配置里的当前画质立即应用一次
    this.mosaicManifest = data.mosaicManifest
      ? (JSON.parse(data.mosaicManifest) as Record<string, string>)
      : null;
    void this.applyTextureQuality(this.config.texture.quality);

    // 实体碰撞体：solids 与 ladders 分别留档（可视化用合并列表，准星射线用分类列表）
    const adaptResult = adaptBrushes(data.brushJson);
    this.colliders = [...adaptResult.solids, ...adaptResult.ladders];
    this.solids = adaptResult.solids;
    this.ladders = adaptResult.ladders;

    // 本文件不设 scene.fog：near/far 只按上面的场景尺寸静态设定，不随相机位置变化。

    // 剔除距离以 LOD 管理器的校准结果为准（面板滑块只改这个值）
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
      cc.setYawPitch(st.yaw * DEG2RAD, st.pitch * DEG2RAD, false);
      cc.update();
      // 相机放在眼睛高度（脚底 + eyeHeight），不做任何位置修正
      const camY = st.posY + st.eyeHeight;
      cc.setPosition(st.posX, camY, st.posZ);

      // 近平面自适应：隔帧执行一次；noclip 下位置不受碰撞约束，跳过探测
      this.nearCheckToggle = !this.nearCheckToggle;
      if (this.nearCheckToggle && !this.noclipActive && this.bspModelScene) {
        this.updateNearPlane(st.posX, camY, st.posZ);
      }
    } else if (this.stepGated) {
      // 闸门跳过物理的帧也要推进墙钟基准，否则闸门恢复时会拿到一个异常大的 dt
      this.lastTickMs = now;
    }

    const camPos = this.camera.position;

    // ② 视距剔除：块中心到相机的距离超过 cullDistance 即隐藏；返回真表示可见性有变化
    if (this.lodManager.itemCount > 0) {
      if (this.lodManager.update(camPos, this.config)) {
        this.needsRender = true;
      }
    }

    // ③ 碰撞体/触发器/三角面/chamfer 可视化
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

    // ⑤ 渲染：物理就绪后每帧都渲染；needsRender 只用于物理未就绪时的强制刷新
    const shouldRender = this.predReady || this.needsRender;
    if (shouldRender) {
      this.renderer.render(this.scene, this.camera);
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

  /**
   * 近平面自适应：先用包围球粗筛出 `probe × 2 + 球半径` 内的 mesh，再从相机沿 4 个水平
   * 正交方向（相机局部 ±forward / ±right）各投一条长度 `probe` 的射线，取最近命中距离 minD。
   * 有命中 → near = max(minD × nearRatio, CAMERA_NEAR_MIN)；无命中 → 恢复 defaultNear。
   * 与当前 near 相差超过 0.001 才写入并更新投影矩阵；相机位置始终不动。
   */
  private updateNearPlane(px: number, py: number, pz: number): void {
    const camera = this.camera;
    const scene = this.bspModelScene;
    if (!camera || !scene) return;
    this._nearOrigin.set(px, py, pz);
    const probe = this.nearProbeDist;

    // 1. 粗筛：包围球（缺则先算）平移到世界空间，球心到相机的距离小于 probe × 2 + 半径才入选
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

    // 2. 4 个相机局部水平方向各投一条射线（far = probe），取最近命中距离
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

    // 3. 写 near：命中则收缩并夹下限，未命中恢复默认；差值超过 0.001 才更新投影矩阵
    const target =
      isFinite(minD)
        ? Math.max(minD * this.nearRatio, CAMERA_NEAR_MIN)
        : this.defaultNear;
    if (Math.abs(camera.near - target) > 0.001) {
      camera.near = target;
      camera.updateProjectionMatrix();
    }
  }

  /** 面板实时调整近平面参数：`probeDist` 只接受 > 0，`ratio` 只接受区间 (0, 1]；两者都可缺省。 */
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

  /** 最近一次准星检测结果（准星开关关闭时被清为 null）。 */
  getPlaneInfo(): PlaneInfo | null {
    return this.lastPlaneInfo;
  }

  /** 调整渲染器与相机的输出尺寸（aspect = width / max(height, 1)，与 near/far 无关）。 */
  resize(width: number, height: number): void {
    if (!this.renderer || !this.camera) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  /** 设置视距剔除距离：交给 `LodManager.setCullDistance` 夹到 [0, maxCull]，再把结果写回 config。 */
  setCullDistance(dist: number): void {
    this.lodManager.setCullDistance(dist);
    this.config.lod.cullDistance = this.lodManager.cullDistance;
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

  /** 整组路径折线的显隐。 */
  setPathVisible(visible: boolean): void {
    this.pathRecorder.setVisible(visible);
    this.needsRender = true;
  }

  /** 单独显隐渲染物理线（两条线对比时可只留 tick 线）。 */
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
   *   用它，离线验收口径在 `apps/debug/scripts/path-acceptance.mjs`。
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

  /** 路径折线组当前是否可见。 */
  isPathVisible(): boolean {
    return this.pathRecorder.visible;
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
          map.dispose(); // 低清 512 与原始图幅不同 ⇒ 强制重建 GPU 纹理
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
      for (const [mat, geomsRaw] of byMat) {
        const geoms = normalizeMergeGroup(geomsRaw);
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
        const final = mergeGeometries(normalizeMergeGroup(mergedGeoms), true);
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
