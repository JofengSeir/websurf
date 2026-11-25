/**
 * Worker 消息协议的类型声明：主线程与权威 Worker 之间的 `type` 字面量与载荷形状。
 *
 * 本文件只有类型、没有实现：分支实现在 `src/ts-shared/auth/worker-dispatch.ts` 的
 * `createWorkerDispatch`，装配点是 `apps/game/src/worker/main.ts` 的 `self.onmessage`。
 *
 * 与共享层的关系（2026-11-18）：两端同形、且由共享分派器消费的消息统一声明在
 * `src/ts-shared/auth/worker-protocol-types.ts`；本文件只 `import type` + `re-export`
 * 保留既有导出名，不再重复声明。留在本文件的是 **game 端独有** 消息（BSP 元数据、HUD 统计、
 * 世界加载诊断）与 **Worker → 主线程 / 主线程本地结构**（`ReadyMessage`、
 * `SceneDataMessage`、`KeyState` 等）。
 *
 * 两个联合类型按方向划分：`WorkerMessage`（主线程 → Worker，全部来自共享类型面）与
 * `MainMessage`（Worker → 主线程）。两者只作类型用途——分发器按 `type` 字符串分派，
 * 不做运行时校验。
 *
 * 协议版本：任一消息的 `type` 字面量或字段语义增删改 ⇒ 同步把
 * `src/ts-shared/auth/worker-protocol.ts` 的 `WORKER_PROTOCOL` +1（旧 `web/worker.js`
 * 无握手会静默忽略新消息；2026-11-17 名字门控失效事故）。
 */

import type {
  AddVelocityMessage,
  ConfigMessage,
  InitMessage,
  InputMessage,
  RespawnMessage,
  SetDeathThresholdMessage,
  SetHoldMessage,
  SetJumpHeightMessage,
  SetModeMessage,
  SetPlayerNameMessage,
  SetPushVelocityMessage,
  SetSpeedCapMessage,
  SetSpawnPointsMessage,
  SyncRenderStateMessage,
  TeleportMessage,
  TeleportToPosMessage,
  WasmInitMessage,
  WorldBinMessage,
  WorldJsonMessage,
} from '../../../../src/ts-shared/auth/worker-protocol-types.js';

/** 两端同形的协议消息：共享层是唯一权威，此处原样 re-export 既有导出名。 */
export type {
  AddVelocityMessage,
  ConfigMessage,
  InitMessage,
  InputMessage,
  RespawnMessage,
  SetDeathThresholdMessage,
  SetHoldMessage,
  SetJumpHeightMessage,
  SetModeMessage,
  SetPlayerNameMessage,
  SetPushVelocityMessage,
  SetSpeedCapMessage,
  SetSpawnPointsMessage,
  SyncRenderStateMessage,
  TeleportMessage,
  TeleportToPosMessage,
  WasmInitMessage,
  WorldBinMessage,
  WorldJsonMessage,
};

// ── 主线程 → Worker：全部消息已收敛到共享类型面 ──────────────

/** 主线程 → Worker 的联合类型：19 条全部来自
 *  `src/ts-shared/auth/worker-protocol-types.ts` 的 `WorkerInboundMessage`，
 *  分派器 `createWorkerDispatch` 逐个 `type` 有对应分支。 */
export type WorkerMessage =
  | WasmInitMessage | InitMessage
  | ConfigMessage | RespawnMessage
  | TeleportMessage | SetDeathThresholdMessage
  | WorldJsonMessage | WorldBinMessage | InputMessage
  | SyncRenderStateMessage | SetSpawnPointsMessage
  | TeleportToPosMessage | SetModeMessage
  | SetHoldMessage
  | SetPlayerNameMessage | AddVelocityMessage
  | SetPushVelocityMessage | SetSpeedCapMessage
  | SetJumpHeightMessage;

// ── Worker → 主线程（game 端独有）────────────────────────────

/** `load-bsp`：**本工程内无发送方、也无对应分发分支**，已从联合里移除（地图装载在主线程完成，
 *  经 `apps/game/src/app.ts` 的 `buildWorldBundle` 后以 `world-json` 消息交给 Worker）。 */
export interface LoadBspMessage {
  type: 'load-bsp';
  name: string;
  data: ArrayBuffer;
}

/** `ready`：Worker 在 wasm 初始化完成后回一条，携带 `WORKER_PROTOCOL` 版本号。
 *
 *  主线程据此检测「跑的是旧 web/worker.js」——`build:app` 不重建 worker 时，新增的 worker 侧
 *  消息会被旧 worker 静默忽略，必须显式报错（2026-11-17 名字门控失效事故）。
 *  版本号只在消息语义增删改时 +1。 */
export interface ReadyMessage {
  type: 'ready';
  protocol: number;
}

/** `bsp-metadata`：**本工程内无发送方、无接收点**（BSP 元数据随 `SceneDataMessage.metadata`
 *  在主线程内传递）。 */
export interface BspMetadataMessage {
  type: 'bsp-metadata';
  metadata: {
    map_name: string;
    num_faces: number;
    num_vertices: number;
    num_brushes: number;
    num_models: number;
  };
}

/** 场景数据载荷：由 `apps/game/src/app.ts` 的 BSP 装载段构造，交给
 *  `apps/game/src/renderer/renderer-main.ts` 的 `loadScene`。**不是跨线程消息**。 */
export interface SceneDataMessage {
  type: 'scene-data';
  /** GLB 字节（transfer 零拷贝）。 */
  glb: ArrayBuffer;
  /** 出生点 JSON（主线程渲染 spawn 下拉）。 */
  spawnJson: string;
  /** PVS JSON（主线程渲染剔除）。 */
  pvsJson: string;
  metadata: {
    mapName: string;
    numFaces: number;
    numVertices: number;
    numBrushes: number;
    numModels: number;
  };
  /** 初始出生点（Y-up）。 */
  spawn: { x: number; y: number; z: number; yawDeg: number };
  glbSizeKb: number;
  numSpawnPoints: number;
  hasPvs: boolean;
  /** 纹理画质 manifest：`{ 纹理名(小写 basetexture): mosaic v4 字节码 }` JSON。
   * 画质切换（原始/压缩低清）时按贴图名查表，`mosaic_decode` 还原低清 PNG 替换。 */
  mosaicManifest?: string; skyboxTexture?: import('three').CubeTexture | null;
  /** 地图线性雾（`env_fog_controller`，见 renderer-shared/environment/fog-controller.js）；无控制器为 null。 */
  fogParams?: { color: number; start: number; end: number; maxDensity: number } | null;
  /** 3D 天空盒的 `sky_camera` 参数（见 renderer-shared/environment/miniature-sky.js）；无则不加天空层。 */
  skyCamera?: { origin: [number, number, number]; scale: number; fog?: { enable: boolean; color: number; start: number; end: number } | null } | null;
  /**
   * Source 实体 I/O 无损数据（`buildWorldBundle` 的 `entityIoJson`）。
   * 渲染主线程据此装配通用 `EntitySystem`；wasm 未重建时缺省 ⇒ 不启用新运行期。
   */
  entityIoJson?: string;
}

/** `stats`：**本工程内无发送方、无接收点**（HUD 速度值由主线程
 *  `apps/game/src/app.ts` 直接读渲染物理实例）。 */
export interface StatsMessage {
  type: 'stats';
  fps: number;
  speed: number;
  speedY: number;
  speedTotal: number;
  onGround: boolean;
}

/** `error`：字面量由 `src/ts-shared/auth/worker-dispatch.ts` 的 `wasm-init` 分支发出、
 *  由 `apps/game/src/app.ts` 的 `onmessage` 消费；两侧都不引用本类型。 */
export interface ErrorMessage {
  type: 'error';
  message: string;
}

/** `health-log`：字面量由共享 `worker-runtime` 的 `postHealth` 发出、
 *  由 `apps/game/src/app.ts` 交面板控制台消费；两侧都不引用本类型。 */
export interface HealthLogMessage {
  type: 'health-log';
  message: string;
}

/** `player-respawn`：**本工程内无发送方、无接收点**（respawn / 传送由
 *  `sync-render-state` 消息与主线程自身的 `respawn` 调用承担）。 */
export interface PlayerRespawnMessage {
  type: 'player-respawn';
  pos: number[];
  yawDeg: number;
}

/** `phys-frame`：权威帧，仅 `MsgState` 消息回退通道使用；发送方是
 *  `src/ts-shared/auth/shared-state.ts` 的 `MsgState.writeAuthoritative`，消费方是
 *  `apps/game/src/app.ts` 的 `phys-frame` 分支（转 `recvFrame`）。
 *  载荷形状与 `AuthFrame`（同文件）一致。 */
export interface PhysFrameMessage {
  type: 'phys-frame';
  va: number;
  frame: {
    pos: { x: number; y: number; z: number };
    yaw: number;
    pitch: number;
    vel: { x: number; y: number; z: number };
    onGround: boolean;
    eyeHeight: number;
    timeMs: number;
  };
}

/** `phys-event`：权威碰撞事件（落地 / 撞墙瞬间）；发送方是
 *  `src/ts-shared/auth/auth-loop.ts` 的碰撞事件出口（经 `post` 注入的 `postMessage`），
 *  消费方是 `apps/game/src/app.ts` 的 `phys-event` 分支（转
 *  `RendererMain.applyCollisionCorrection`）。 */
export interface PhysEventMessage {
  type: 'phys-event';
  kind: 'land' | 'blocked';
  pos: number[];
  /** 权威碰撞瞬间朝向（度；权威仅在碰撞判断时可影响渲染角度）。 */
  yawDeg: number;
  pitchDeg: number;
  /** 权威碰撞瞬间速度（land：权威速度为校准基准；blocked：供参考）。 */
  vel?: number[];
  timeMs: number;
}

/** Worker → 主线程的联合类型（11 条）：`ready` / `bsp-metadata` / `stats` / `error` /
 *  `player-respawn` / `phys-event` / `health-log` / `phys-frame` / `mode-ack` /
 *  `world-build-ms` / `world-parse-ms`。前 8 条的游戏侧语义见上；后 3 条见本组末尾。 */
export type MainMessage =
  | ReadyMessage | BspMetadataMessage
  | StatsMessage
  | ErrorMessage | PlayerRespawnMessage
  | PhysEventMessage | HealthLogMessage
  | PhysFrameMessage
  | ModeAckMessage
  | WorldBuildMsMessage
  | WorldParseMsMessage;

// ── 输入状态（共享内存 keys 位掩码，与 Rust KEY_MASK 一致；掩码常量/转换
//    收敛到 ts-shared auth/shared-state.ts，此处仅保留类型）─────

/** 按键状态。字段集与 `src/ts-shared/auth/shared-state.ts` 的 `KeyState` 同名同型，
 *  而 `keysToMask` / `maskToKeys` 的形参用的是共享层那一份——两处结构等价，可直接互传。
 *  位掩码常量 `KEY_MASK` 也只定义在共享层。 */
export interface KeyState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  duck: boolean;
  sprint: boolean;
  reset: boolean;
  wheelJump: boolean;
  yawLeft: boolean;
  yawRight: boolean;
}

// ── 补录：实际收发面里此前未声明的 6 条消息（T-048）───────────────────
// 其中主线程 → Worker 的 8 条（`sync-render-state` / `set-spawn-points` /
// `teleport-to-pos` / `set-mode` / `set-hold` 等）已随 2026-11-18 的共享类型面
// 收敛到 `src/ts-shared/auth/worker-protocol-types.ts`，此处只留 Worker → 主线程侧
// 与端独有消息。载荷形状的权威来源是分发器对应分支与 worker main.ts 的发送点。

/** `mode-ack`（Worker → 主线程）：模式握手回执，由分发器无条件发出。 */
export interface ModeAckMessage {
  type: 'mode-ack';
  mode: string;
  appliedAtMs: number;
}

/** `world-build-ms`（Worker → 主线程）：`build_world` 段耗时诊断（主线程只打 console）。
 *  `source` 区分世界负载形态（T-D135：`json` = 两条 JSON.parse，`bin` = WSBW 解码）。 */
export interface WorldBuildMsMessage {
  type: 'world-build-ms';
  ms: number;
  source?: 'json' | 'bin';
}

/** `world-parse-ms`（Worker → 主线程）：两个大 JSON 的解析耗时诊断（主线程只打 console）。 */
export interface WorldParseMsMessage {
  type: 'world-parse-ms';
  brush: number;
  tri: number;
}
