/**
 * Worker 消息协议的类型声明：主线程与权威 Worker 之间的 `type` 字面量与载荷形状。
 *
 * 本文件只有类型、没有实现：分支实现在 `src/ts-shared/auth/worker-dispatch.ts` 的
 * `createWorkerDispatch`，装配点是 `apps/game/src/worker/main.ts` 的 `self.onmessage`。
 *
 * 本文件共 29 个导出（27 个接口 + 2 个联合类型），在本工程内只有两个有导入点：
 * - `KeyState`：`apps/game/src/app.ts`、`apps/game/src/input/keyboard.ts`、
 *   `apps/game/src/input/keymap.ts`（后者用它派生 `BindableAction`）；
 * - `SceneDataMessage`：`apps/game/src/renderer/renderer-main.ts` 的 `loadScene` 形参，调用方是
 *   `apps/game/src/app.ts` 的 BSP 装载段——是主线程内的调用载荷，不是跨线程消息。
 * 其余声明无导入点，只作协议形状的记录；方向与当前收发双方不一致的逐条在下方注明。
 *
 * 两个联合类型按方向划分：`WorkerMessage`（主线程 → Worker）与 `MainMessage`（Worker → 主线程）。
 * 两者按方向列全了实际收发面（T-048 补齐），但只作类型用途——分发器按 `type` 字符串分派，不做运行时校验。
 */

import type { RuntimeConfig } from '../config.js';

// ── 主线程 → Worker-A ────────────────────────────────────────

/** `wasm-init`：实例化 wasm。声明与分发器读取面一致——
 *  `{ wasmB64?: string; wasmUrl?: string; mtzB64?: string }`（内嵌 base64 优先，其次按 URL 取），
 *  发送方 `apps/game/src/app.ts` 只发 `wasmB64` 或 `wasmUrl` 两者之一。 */
export interface WasmInitMessage {
  type: 'wasm-init';
  wasmUrl?: string; wasmB64?: string; mtzB64?: string;
}

/** `init`：建跨线程状态通道。分发器只读 `shared`（`null` = 落到 `MsgState` 消息回退通道）；
 *  `width` / `height` / `dpr` 在本工程内**既无发送方也无读取点**——发送方
 *  `apps/game/src/app.ts` 只发 `type` 与 `shared`。 */
export interface InitMessage {
  type: 'init';
  shared: SharedArrayBuffer | null;
  width: number;
  height: number;
  dpr: number;
}

/** `load-bsp`：**本工程内无发送方、也无对应分发分支**，已从联合里移除（地图装载在主线程完成，
 *  经 `apps/game/src/app.ts` 的 `buildWorldBundle` 后以 `world-json` 消息交给 Worker）。 */
export interface LoadBspMessage {
  type: 'load-bsp';
  name: string;
  data: ArrayBuffer;
}

/** `config`：面板参数下发。`section` 是 `RuntimeConfig` 的顶层段名；`physics` / `input`
 *  两段的 `patch` 先做 snake_case → camelCase 键名归一（含 `jump_height` 的值换算）。 */
export interface ConfigMessage {
  type: 'config';
  section: keyof RuntimeConfig;
  patch: Record<string, unknown>;
}

/** `respawn`：回到 `build_world` 给定的出生点，无载荷。 */
export interface RespawnMessage {
  type: 'respawn';
}

/** `teleport`：传送到权威出生点列表的第 `target` 项。 */
export interface TeleportMessage {
  type: 'teleport';
  /** 出生点索引。 */
  target: number;
}

/** `set-death-threshold`：掉落死亡线（`pos.y < value` 即判死亡），写入全部已注入实例。 */
export interface SetDeathThresholdMessage {
  type: 'set-death-threshold';
  value: number;
}

/** 主线程 → Worker 的联合类型（T-048 补齐）：按实际收发面列全 13 条——`wasm-init` / `init` /
 *  `config` / `respawn` / `teleport` / `set-death-threshold` / `world-json` / `input` /
 *  `sync-render-state` / `set-spawn-points` / `teleport-to-pos` / `set-mode` / `set-hold`。 */
export type WorkerMessage =
  | WasmInitMessage | InitMessage
  | ConfigMessage | RespawnMessage
  | TeleportMessage | SetDeathThresholdMessage
  | WorldJsonMessage | InputMessage
  | SyncRenderStateMessage | SetSpawnPointsMessage
  | TeleportToPosMessage | SetModeMessage
  | SetHoldMessage;

// ── Worker-A → 主线程（本组末尾两条 `WorldJsonMessage` / `InputMessage`
//    实际方向相反，仍声明在原位）──────────────────────────────

/** `ready`：**本工程内无发送方、无接收点**。 */
export interface ReadyMessage {
  type: 'ready';
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
  fogParams?: { color: number; start: number; end: number } | null;
  /** 3D 天空盒的 `sky_camera` 参数（见 renderer-shared/environment/miniature-sky.js）；无则退回合成山脊。 */
  skyCamera?: { origin: [number, number, number]; scale: number; fog?: { enable: boolean; color: number; start: number; end: number } | null } | null;
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

/** `health-log`：字面量由 `apps/game/src/worker/main.ts` 的 `postHealth` 发出、
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

/** `world-json`：地图碰撞世界 JSON，方向是**主线程 → Worker**：发送方
 *  `apps/game/src/app.ts` 的 BSP 装载段，接收方是 Worker 的 `createWorkerDispatch`，
 *  据此 `build_world` 建全部权威实例。 */
export interface WorldJsonMessage {
  type: 'world-json';
  brushJson: string;
  triJson: string;
  teleportJson: string;
  spawn: { x: number; y: number; z: number; yawDeg: number };
}

/** `input`：方向是**主线程 → Worker**，仅 `MsgState` 消息回退
 *  通道使用（SAB 模式走共享槽）；发送方是 `src/ts-shared/auth/shared-state.ts` 的
 *  `MsgState.addInput`，载荷 = 三个必填字段 + 渲染采样六字段（后者全部可选）。 */
export interface InputMessage {
  type: 'input';
  dx: number;
  dy: number;
  keys: number; rt?: number; rx?: number; ry?: number; rz?: number; ri0?: number; repoch?: number;
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

/** Worker → 主线程的联合类型（T-048 补齐）：11 条——`ready` / `bsp-metadata` / `stats` / `error` /
 *  `player-respawn` / `phys-event` / `health-log` / `phys-frame` / `mode-ack` / `world-build-ms` /
 *  `world-parse-ms`；`WorldJsonMessage` / `InputMessage` 方向相反已移上一组；`scene-data` 是主线程 `loadScene` 形参、不属本组。 */
export type MainMessage =
  | ReadyMessage | BspMetadataMessage
  | StatsMessage
  | ErrorMessage | PlayerRespawnMessage
  | PhysEventMessage | HealthLogMessage
  | PhysFrameMessage
  | ModeAckMessage
  | WorldBuildMsMessage
  | WorldParseMsMessage;
// ↑ 方向说明见两组标题注释；`WorldJsonMessage` / `InputMessage` 已归「主线程 → Worker」组。

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

// ── 补录：实际收发面里此前未声明的 8 条消息（T-048）─────────────────────
// 放在文件末尾是为了不改动上方任何一行 ⇒ 文档锚点行号零漂移。载荷形状的权威来源是
// 分发器 src/ts-shared/auth/worker-dispatch.ts 的对应分支与 apps/game/src/worker/main.ts 的发送点。

/** `sync-render-state`（主线程 → Worker）：渲染帧状态重锚 / 全态注入。
 *  发送方 `apps/game/src/app.ts` 的 `renderer.onSyncRenderState`。 */
export interface SyncRenderStateMessage {
  type: 'sync-render-state';
  state: import('../../../../src/ts-shared/decoupled/decoupled-loop.js').SyncRenderStateLike;
  teleport?: boolean;
}

/** `set-spawn-points`（主线程 → Worker）：出生点列表 JSON，只影响 `teleport_to_spawn` 的目标集。 */
export interface SetSpawnPointsMessage {
  type: 'set-spawn-points';
  json: string;
}

/** `teleport-to-pos`（主线程 → Worker）：传送到任意坐标；**本工程内无发送方**，分发器仍有分支。 */
export interface TeleportToPosMessage {
  type: 'teleport-to-pos';
  pos: [number, number, number];
  yaw?: number;
}

/** `set-mode`（主线程 → Worker）：计算模式握手；**本工程内无发送方**，分发器仍有分支。 */
export interface SetModeMessage {
  type: 'set-mode';
  mode: 'coupled' | 'decoupled' | 'tick';
  state?: import('../../../../src/ts-shared/decoupled/decoupled-loop.js').SyncRenderStateLike;
}

/** `set-hold`（主线程 → Worker）：解耦 hold 冻结 / 存点恢复；**本工程内无发送方**，分发器仍有分支。 */
export interface SetHoldMessage {
  type: 'set-hold';
  hold?: import('../../../../src/ts-shared/decoupled/decoupled-loop.js').HoldState | null;
  release?: import('../../../../src/ts-shared/decoupled/decoupled-loop.js').SavePointLike;
}

/** `mode-ack`（Worker → 主线程）：模式握手回执，由分发器无条件发出。 */
export interface ModeAckMessage {
  type: 'mode-ack';
  mode: string;
  appliedAtMs: number;
}

/** `world-build-ms`（Worker → 主线程）：`build_world` 段耗时诊断（主线程只打 console）。 */
export interface WorldBuildMsMessage {
  type: 'world-build-ms';
  ms: number;
}

/** `world-parse-ms`（Worker → 主线程）：两个大 JSON 的解析耗时诊断（主线程只打 console）。 */
export interface WorldParseMsMessage {
  type: 'world-parse-ms';
  brush: number;
  tri: number;
}
