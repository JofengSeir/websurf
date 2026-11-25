/**
 * Worker 协议消息的共享类型面：主线程 → 权威 Worker、debug 与 game 两端**同形**、且由共享
 * 分派器 `src/ts-shared/auth/worker-dispatch.ts` 的判别式分支消费的消息。
 *
 * 为什么在这里：两端 `apps/{debug,game}/src/worker/worker-types.ts` 过去各写一份同样的
 * 接口，字段靠「两边都记得改」同步；分派器只按 `type` 字符串分支、不做运行时校验，故类型
 * 面的唯一权威就是本文件。两端文件改为 `import type` + `re-export`（保留原导出名），端独有
 * 消息（物理面板、场景数据、诊断等）仍留在各端。
 *
 * 规矩：
 * - 本文件只有 `interface`/`type`，编译后不产生运行时代码（esbuild 整模块擦除）。
 * - 字段形状以 `worker-dispatch.ts` 各分支实际读取的为准；本文件不引入 app 侧类型。
 * - 增删改字段 / `type` 字面量 = 协议语义变化 ⇒ 必须同步把
 *   `src/ts-shared/auth/worker-protocol.ts` 的 `WORKER_PROTOCOL` +1（旧构建的
 *   `web/worker.js` 无握手，会静默忽略新消息）。
 * - 端与端行为不同的消息**不要**放这里：例如 `config` 的 `section` 在 app 侧是各自的
 *   `keyof RuntimeConfig`，共享面按分派器实际读取放宽为 `string`。
 */
import type { ComputeMode } from './compute-mode.js';

/** 主线程同步渲染态的结构等价声明（10 字段）。字段与
 * `src/ts-shared/phys/authority-calibrator.ts` 的 `SyncRenderState` 逐一同名同类型；
 * 本文件不导入校准器模块，两端按结构兼容。消费点：`SetModeMessage.state` 与
 * `worker-dispatch.ts` 的 `onSetMode(mode, state)` 形参。 */
export interface SyncRenderStateLike {
  posX: number;
  posY: number;
  posZ: number;
  yaw: number;
  pitch: number;
  velX: number;
  velY: number;
  velZ: number;
  onGround: boolean;
  eyeHeight: number;
}

/** 存点全量恢复形状的结构等价声明。与 `apps/game/src/savepoint.ts` 的 `SavePoint`
 * 同字段，差别只在 `t`：本声明可选，那边的 `SavePoint.t` 是必需的时间戳（列表排序用）。
 * 消费点：`SetHoldMessage.release` 与 `worker-dispatch.ts` 的
 * `onSetHold(hold, release)` 形参。 */
export interface SavePointLike {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  t?: number;
}

/** `set-hold` 消息注入的冻结态。字段与 `src/ts-shared/auth/auth-loop.ts` 的
 * `HoldSnapshot` 逐一同名同类型——两端各就地声明、不做模块间类型依赖。 */
export interface HoldState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  onGround: boolean;
}

/** 共享分派器认识的入站 `type` 字面量全集（判别用；消息接口见下方各 interface）。 */
export type WorkerInboundType =
  | 'init'
  | 'input'
  | 'wasm-init'
  | 'world-json'
  | 'config'
  | 'respawn'
  | 'sync-render-state'
  | 'set-spawn-points'
  | 'teleport'
  | 'teleport-to-pos'
  | 'set-death-threshold'
  | 'set-player-name'
  | 'add-velocity'
  | 'set-push-velocity'
  | 'set-speed-cap'
  | 'set-jump-height'
  | 'set-map-physics-param'
  | 'set-brush-solid'
  | 'set-brush-offset'
  | 'set-mode'
  | 'set-hold';

/**
 * `wasm-init`：实例化 wasm。`wasmB64` 为真走内嵌 base64 同步解码；否则 `wasmUrl` 取字节后
 * 同步实例化；两者都缺席时分派层直接返回（`ready` 保持 false）。`mtzB64` 与 wasm 无关，
 * 由各端 `onWasmInit` 钩子取走（debug 落到 `mtz-data.ts` 的 `setMtzB64`，game 忽略）。
 */
export interface WasmInitMessage {
  type: 'wasm-init';
  wasmB64?: string;
  wasmUrl?: string;
  /** 默认纹理包 base64（构建产物内嵌；两端发送方都从全局常量读出）。 */
  mtzB64?: string;
}

/**
 * `init`：建跨线程状态通道。分派层只读 `shared`：非 null 建 `ShmState`（共享内存 + 原子），
 * null 建 `MsgState`（`input` / `phys-frame` 消息回退通道）；随后调 `onInit` 钩子。
 * `width` / `height` / `dpr` 目前无 Worker 侧读取点，声明保留（两端发送面一致）。
 */
export interface InitMessage {
  type: 'init';
  shared: SharedArrayBuffer | null;
  width: number;
  height: number;
  dpr: number;
}

/**
 * `input`：仅 `MsgState` 回退通道使用的每帧输入（SAB 模式走共享槽）。三个必填字段之外还会
 * 承载渲染采样六字段（由 `src/ts-shared/auth/shared-state.ts` 的 `MsgState.addInput` 附带；
 * 接收侧只在 `rt` 有值时才写采样槽，旧形态消息天然零影响）。
 */
export interface InputMessage {
  type: 'input';
  dx: number;
  dy: number;
  keys: number;
  rt?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  ri0?: number;
  repoch?: number;
}

/**
 * `world-json`：世界数据（主线程解析 BSP 后下发）。前置条件 wasm 已就绪，否则整条丢弃。
 * 处理：释放旧实例 → 新建实例 → `build_world(brushJson, triJson, teleportJson, spawn...)`
 * → 重放参数/固定步长/死亡阈值/玩家名/速度上限/跳跃高度 → `onWorldBuilt`/`onWorldSpawn`。
 */
export interface WorldJsonMessage {
  type: 'world-json';
  brushJson: string;
  triJson: string;
  teleportJson: string;
  spawn: { x: number; y: number; z: number; yawDeg: number };
}

/**
 * `config`：配置部分更新。`physics` / `input` 两段的 `patch` 先做键名归一（snake_case →
 * camelCase，并把 `jump_height` 换算成 `jumpSpeed`），其余段原样透传；归一后写 Worker 自身
 * config 副本，`physics` 段的 `tickRate` 随即使固定步长生效。
 *
 * `section` 在分派器里按 `string` 比较；app 侧发送面各自有更窄的 `keyof RuntimeConfig`，
 * 共享面不引入 app 配置类型，故此处放宽为 `string`。
 */
export interface ConfigMessage {
  type: 'config';
  section: string;
  patch: Record<string, unknown>;
}

/** `respawn`：回到 `build_world` 给定的初始出生点（检查点回退走 `teleport-to-pos`）。 */
export interface RespawnMessage {
  type: 'respawn';
}

/**
 * `sync-render-state`：主线程 → 权威的全态注入通道。分派器按可选 `teleport` 分两支：
 * 显式 `false` 走「常规重锚」（位置与 yaw/pitch 取渲染状态，速度与 on_ground 保留权威自身）；
 * 缺省或 `true` 走全态注入（九个字段整体写入，并清空未消费的输入增量）。
 */
export interface SyncRenderStateMessage {
  type: 'sync-render-state';
  state: SyncRenderStateLike;
  teleport?: boolean;
}

/** `set-spawn-points`：出生点列表 JSON（`[[x,y,z,yaw], ...]`），只影响 `teleport_to_spawn`
 *  的可选目标；缺此列表时索引越界被静默忽略。不改 `build_world` 的初始出生点。 */
export interface SetSpawnPointsMessage {
  type: 'set-spawn-points';
  json: string;
}

/** `teleport`：传送到权威出生点列表中的第 `target` 项（写全部已注入实例）。 */
export interface TeleportMessage {
  type: 'teleport';
  target: number;
}

/** `teleport-to-pos`：传送到任意坐标；`yaw` 缺省时保持**权威当前朝向**（从主实例现读）。 */
export interface TeleportToPosMessage {
  type: 'teleport-to-pos';
  pos: [number, number, number];
  yaw?: number;
}

/** `set-death-threshold`：掉落死亡线（`pos.y < value` 即判死亡）；值被记忆并在世界重建后重放。 */
export interface SetDeathThresholdMessage {
  type: 'set-death-threshold';
  value: number;
}

/** `set-player-name`：玩家实体当前 targetname（地图脚本 `AddOutput targetname` 改名）→
 *  传送门控。`filterEnabled` 缺省不改总开关；显式 `false` 是 `__vbspTeleportFilterOff`
 *  回退路径。名字/开关被记忆并在世界重建后重放。 */
export interface SetPlayerNameMessage {
  type: 'set-player-name';
  name: string;
  filterEnabled?: boolean;
}

/** `add-velocity`：给玩家叠加速度冲量（HU/s，Y-up）。语义 `PhysWorld::add_velocity`：
 *  `velocity += v`，`vy > 0` 时同时脱地。瞬时冲量，不记忆、不重放。 */
export interface AddVelocityMessage {
  type: 'add-velocity';
  vel: [number, number, number];
}

/** `set-push-velocity`：把玩家速度**设成**给定向量（HU/s，Y-up；`trigger_push` 非 ONCE 的
 *  「设置速度」语义）。语义 `velocity = v`（不是累加），`vy > 0` 时脱地；不记忆、不重放。 */
export interface SetPushVelocityMessage {
  type: 'set-push-velocity';
  vel: [number, number, number];
}

/** `set-speed-cap`：设置水平速度上限（HU/s，**不含竖直分量**；对应 `sv_maxvelocity`）。
 *  `cap <= 0` 关闭钳制；值被记忆并在世界重建后重放（地图级设置）。 */
export interface SetSpeedCapMessage {
  type: 'set-speed-cap';
  cap: number;
}

/** `set-jump-height`：设置起跳高度（HU；「跳跃增幅区」内临时抬高，离开时发回默认值）。
 *  语义 `PhysWorld::set_jump_height`：只改之后起跳的初速 `sqrt(2·g·h)`，不动当前速度；
 *  值被记忆并在世界重建后重放。 */
export interface SetJumpHeightMessage {
  type: 'set-jump-height';
  height: number;
}

/** `set-map-physics-param`：地图 `servercommand`（如 `sv_airaccelerate`、`sv_enablebunnyhopping`）
 *  映射出的单个物理参数（`name` 是物理面板参数名，`value` 已按 convar 语义换算）。
 *  地图级设置 ⇒ 值被记忆并在世界重建后重放。 */
export interface SetMapPhysicsParamMessage {
  type: 'set-map-physics-param';
  name: string;
  value: number | boolean;
}

/** `set-brush-solid`：运行期切换某个实体 brush 的碰撞实心状态（对应 `PhysWorld::set_brush_solid`）。
 *  语义：只改该实体名下 brush 的实心标记，不动几何；世界几何（entity=-1）忽略。
 *  地图脚本的 `func_wall_toggle` / `func_brush` 开关、门的开合放行都经这条消息
 *  同步到权威 Worker（权威物理与主线程预测物理必须同语义，否则玩家会被拉回）。
 *  值被记忆并在世界重建后重放。 */
export interface SetBrushSolidMessage {
  type: 'set-brush-solid';
  entity: number;
  solid: boolean;
}

/** `set-brush-offset`：运行期平移某个实体 brush 的几何（对应 `PhysWorld::set_brush_offset`）。
 *  `x/y/z` 是相对 BSP 出生位置的**绝对**偏移（HU，Y-up；不是增量）；同一实体重复下发以最新值为准。
 *  移动平台/电梯/推拉门经这条消息把位移同步到权威物理。值被记忆并在世界重建后重放。 */
export interface SetBrushOffsetMessage {
  type: 'set-brush-offset';
  entity: number;
  x: number;
  y: number;
  z: number;
}

/** `set-mode`：计算模式握手。值域白名单三值；同 mode 重复到达只回 `mode-ack`、不重复执行
 *  钩子；切换所需的状态载荷随消息透传给 `onSetMode`。当前三端均无发送方（coupled 之外的
 *  两模式尚未接线），分派分支保留。 */
export interface SetModeMessage {
  type: 'set-mode';
  mode: ComputeMode;
  state?: SyncRenderStateLike;
}

/** `set-hold`：解耦 hold 冻结 / 存点全量恢复。`hold` 缺省归 null = 解除；`release` 非空时由
 *  钩子做存点恢复。当前三端均无发送方，分派分支保留。 */
export interface SetHoldMessage {
  type: 'set-hold';
  hold?: HoldState | null;
  release?: SavePointLike;
}

/** 共享分派器消费的全部入站消息（按 `type` 判别的 union 片段）。 */
export type WorkerInboundMessage =
  | WasmInitMessage
  | InitMessage
  | InputMessage
  | WorldJsonMessage
  | ConfigMessage
  | RespawnMessage
  | SyncRenderStateMessage
  | SetSpawnPointsMessage
  | TeleportMessage
  | TeleportToPosMessage
  | SetDeathThresholdMessage
  | SetPlayerNameMessage
  | AddVelocityMessage
  | SetPushVelocityMessage
  | SetSpeedCapMessage
  | SetJumpHeightMessage
  | SetMapPhysicsParamMessage
  | SetBrushSolidMessage
  | SetBrushOffsetMessage
  | SetModeMessage
  | SetHoldMessage;
