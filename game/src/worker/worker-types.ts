/**
 * 消息协议（最小化版）— 主线程 ↔ Worker-A（权威）
 *
 * Main→Worker: wasm-init / init / load-bsp / config / respawn / teleport / set-death-threshold
 * Worker→Main: ready / bsp-metadata / scene-data / stats / error
 * Worker-B（预测）用独立协议（predictor-worker 内部，见 worker-types-predictor）。
 */

import type { RuntimeConfig } from '../config.js';

// ── 主线程 → Worker-A ────────────────────────────────────────

export interface WasmInitMessage {
  type: 'wasm-init';
  wasmUrl?: string;
}

export interface InitMessage {
  type: 'init';
  shared: SharedArrayBuffer | null;
  width: number;
  height: number;
  dpr: number;
}

export interface LoadBspMessage {
  type: 'load-bsp';
  name: string;
  data: ArrayBuffer;
}

export interface ConfigMessage {
  type: 'config';
  section: keyof RuntimeConfig;
  patch: Record<string, unknown>;
}

export interface RespawnMessage {
  type: 'respawn';
}

export interface TeleportMessage {
  type: 'teleport';
  /** 出生点索引。 */
  target: number;
}

export interface SetDeathThresholdMessage {
  type: 'set-death-threshold';
  value: number;
}

export type WorkerMessage =
  | WasmInitMessage
  | InitMessage
  | LoadBspMessage
  | ConfigMessage
  | RespawnMessage
  | TeleportMessage
  | SetDeathThresholdMessage;

// ── Worker-A → 主线程 ────────────────────────────────────────

export interface ReadyMessage {
  type: 'ready';
}

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
}

export interface StatsMessage {
  type: 'stats';
  fps: number;
  speed: number;
  speedY: number;
  speedTotal: number;
  onGround: boolean;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

/** Worker-A → 主线程：位置重置事件（respawn/teleport；位置突变时通知）。 */
export interface PlayerRespawnMessage {
  type: 'player-respawn';
  pos: number[];
  yawDeg: number;
}

/** Worker-A → 主线程：世界 JSON（主线程构建预测 PhysWorld 用；加载时一次，非热路径）。 */
export interface WorldJsonMessage {
  type: 'world-json';
  brushJson: string;
  triJson: string;
  teleportJson: string;
  spawn: { x: number; y: number; z: number; yawDeg: number };
}

/** Worker → 主线程：权威碰撞事件（落地/撞墙瞬间；低频，位置微调+角度同步用）。 */
export interface PhysEventMessage {
  type: 'phys-event';
  kind: 'land' | 'blocked';
  pos: number[];
  /** 权威碰撞瞬间朝向（度；权威仅在碰撞判断时可影响渲染角度）。 */
  yawDeg: number;
  pitchDeg: number;
  timeMs: number;
}

export type MainMessage =
  | ReadyMessage
  | BspMetadataMessage
  | SceneDataMessage
  | StatsMessage
  | ErrorMessage
  | PlayerRespawnMessage
  | WorldJsonMessage
  | PhysEventMessage;

// ── 输入状态（共享内存 keys 位掩码，与 Rust KEY_MASK 一致）─────

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

export const KEY_MASK: Record<keyof KeyState, number> = {
  forward: 1,
  backward: 2,
  left: 4,
  right: 8,
  jump: 16,
  duck: 32,
  sprint: 64,
  reset: 128,
  wheelJump: 256,
  yawLeft: 512,
  yawRight: 1024,
};

export function keysToMask(keys: KeyState): number {
  let m = 0;
  if (keys.forward) m |= KEY_MASK.forward;
  if (keys.backward) m |= KEY_MASK.backward;
  if (keys.left) m |= KEY_MASK.left;
  if (keys.right) m |= KEY_MASK.right;
  if (keys.jump) m |= KEY_MASK.jump;
  if (keys.duck) m |= KEY_MASK.duck;
  if (keys.sprint) m |= KEY_MASK.sprint;
  if (keys.reset) m |= KEY_MASK.reset;
  if (keys.wheelJump) m |= KEY_MASK.wheelJump;
  if (keys.yawLeft) m |= KEY_MASK.yawLeft;
  if (keys.yawRight) m |= KEY_MASK.yawRight;
  return m;
}
