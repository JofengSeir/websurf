/**
 * 消息协议 — 主线程 ↔ Worker
 *
 * WASM 在 Worker 内加载并解析 BSP；主线程仅发送原始字节（load-bsp），
 * Worker 回传元数据/出生点/解析进度，并自行导出 GLB/碰撞体/出生点/PVS
 * 后构建场景 + 物理 + 渲染循环。
 */

import type { RuntimeConfig } from '../config.js';
import type { WasmBspMetadata } from '../world/types.js';

// ── 主线程 → Worker ──────────────────────────────────────────

/** 主线程 → Worker：注入 WASM 模块。dist 内嵌用 base64（wasmB64）initSync；dev 模式用 URL（wasmUrl）fetch。 */
export interface WasmInitMessage {
  type: 'wasm-init';
  wasmB64?: string;
  wasmUrl?: string;
  /** 默认纹理包 base64（single 打包内嵌；file:// 下 worker 无法 fetch，经此下发）。 */
  mtzB64?: string;
}

export interface InitMessage {
  type: 'init';
  /**
   * 共享内存（SharedArrayBuffer）：
   * - 非 null（crossOriginIsolated）：输入/物理结果走共享内存 + 原子操作
   * - null（无 COOP/COEP）：回退 postMessage 数据通道（MsgState）
   */
  shared: SharedArrayBuffer | null;
  width: number;
  height: number;
  dpr: number;
}

/** 主线程 → Worker：发送 BSP 原始字节（Worker 内解析）。 */
export interface LoadBspMessage {
  type: 'load-bsp';
  name: string;
  data: ArrayBuffer;
}

/** 输入状态消息（仅回退模式 MsgState 使用）。 */
export interface InputMessage {
  type: 'input';
  keys: KeyState;
  mouseDx: number;
  mouseDy: number;
}

/**
 * 帧信号（主线程 → Worker，每帧一条，无数据负载）。
 *
 * 纯触发信号：输入数据已在共享内存环形缓冲中，物理 dt 由 Worker 侧
 * performance.now() 计算（与主线程同源时钟，LERP 插值基准不变）。
 * M2 Worker 自驱循环落地后，本信号废弃。
 */
export interface FrameSignalMessage {
  type: 'frame';
}

/** 配置部分更新消息。 */
export interface ConfigMessage {
  type: 'config';
  section: keyof RuntimeConfig;
  patch: Record<string, unknown>;
}

export interface ResizeMessage {
  type: 'resize';
  width: number;
  height: number;
}

export interface RespawnMessage {
  type: 'respawn';
}

export interface SetPhysicsModeMessage {
  type: 'set-physics-mode';
  mode: 'noclip' | 'physics';
}

/** 设置物理参数（物理控制面板）。 */
export interface SetPhysicsParamMessage {
  type: 'set-physics-param';
  name: string;
  value: number | boolean;
}

/** 恢复物理参数到 mode-default（缺省 name = 全部）。 */
export interface ResetPhysicsParamMessage {
  type: 'reset-physics-param';
  name?: string;
}

/** 设置碰撞箱体型（立即生效）。 */
export interface SetHullMessage {
  type: 'set-hull';
  hull: { halfWidth: number; standHeight: number; duckHeight: number };
}

/** 恢复默认碰撞箱。 */
export interface ResetHullMessage {
  type: 'reset-hull';
}

/** 碰撞箱自动恢复开关。 */
export interface SetAutoRestoreHullMessage {
  type: 'set-auto-restore-hull';
  enabled: boolean;
}

export interface SetCullDistanceMessage {
  type: 'set-cull-distance';
  value: number;
}

/** 传送到指定出生点索引。 */
export interface TeleportMessage {
  type: 'teleport';
  target: number;
}

/** 传送到任意自定义坐标（自定义传送点面板）。 */
export interface TeleportToPosMessage {
  type: 'teleport-to-pos';
  pos: [number, number, number];
  yaw?: number;
}

/** 请求玩家当前位置（自定义传送点「保存当前位置」用）。 */
export interface GetPlayerPosMessage {
  type: 'get-player-pos';
}

/**
 * 设置掉落死亡阈值（主线程从场景包围盒算出的 Y 下限）。
 * 渲染搬主线程后 Worker 不再持有场景，死亡判定所需的世界 Y 下限由主线程回传。
 */
export interface SetDeathThresholdMessage {
  type: 'set-death-threshold';
  value: number;
}

export type WorkerMessage =
  | WasmInitMessage
  | InitMessage
  | LoadBspMessage
  | InputMessage
  | FrameSignalMessage
  | ConfigMessage
  | ResizeMessage
  | RespawnMessage
  | SetPhysicsModeMessage
  | SetPhysicsParamMessage
  | ResetPhysicsParamMessage
  | SetHullMessage
  | ResetHullMessage
  | SetAutoRestoreHullMessage
  | SetCullDistanceMessage
  | TeleportMessage
  | TeleportToPosMessage
  | GetPlayerPosMessage
  | SetDeathThresholdMessage;

// ── Worker → 主线程 ──────────────────────────────────────────

/** BSP 元数据。 */
export interface BspMetadataMessage {
  type: 'bsp-metadata';
  metadata: WasmBspMetadata;
}

/** 解析进度（阶段名）。 */
export interface ParseProgressMessage {
  type: 'parse-progress';
  stage: string;
}

/** 出生点列表。 */
export interface SpawnOptionsMessage {
  type: 'spawn-options';
  spawnJson: string;
}

export interface ReadyMessage {
  type: 'ready';
}

/**
 * Worker → 主线程：场景数据（BSP 解析完成，一次性传输）。
 *
 * 渲染在主线程：GLB 字节 + 碰撞体/出生点/PVS/传送点 JSON 全传主线程，负责
 * GLTFLoader 建场景、LOD/PVS/准星/碰撞箱可视化；Worker 保留同份数据构建物理。
 */
export interface SceneDataMessage {
  type: 'scene-data';
  /** GLB 字节（transfer 零拷贝）。 */
  glb: ArrayBuffer;
  /** 碰撞体 JSON（WASM brushes → 主线程 adaptBrushes 转换）。 */
  brushJson: string;
  /** 模型「可视网格」三角形碰撞 JSON（零转化；可选，失败时缺省）。 */
  triJson?: string;
  /** 纹理画质 manifest：`{ 纹理名(小写 basetexture): mosaic v4 字节码 }` JSON。
   * 画质切换（原始/压缩低清）时按贴图名查表，`mosaic_decode` 还原低清 PNG 替换。 */
  mosaicManifest?: string;
  /** 缺失材质纹理列表（VMT/VTF 缺失 → 占位色）；与默认纹理包比对用。 */
  missingTextures?: string[];
  spawnJson: string;
  pvsJson: string;
  teleportJson: string;
  metadata: {
    mapName: string;
    numFaces: number;
    numVertices: number;
    numBrushes: number;
    numModels: number;
  };
  /** 初始出生点（Y-up 坐标 + 朝向）。 */
  spawn: { x: number; y: number; z: number; yawDeg: number };
  diagonal: number;
  maxCull: number;
  defaultCull: number;
  glbSizeKb: number;
  numSpawnPoints: number;
  hasPvs: boolean;
  /** 死亡阈值（世界最低 Y，用于掉落死亡判定）。 */
  deathThresholdY: number;
}

/** 物理帧快照（共享内存输出区 / 回退消息的载荷）。 */
export interface FrameSnapshot {
  pos: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  vel: { x: number; y: number; z: number };
  onGround: boolean;
  mode: 'noclip' | 'physics';
  /** 眼睛高度（渲染时 pos.y + eyeHeight）。 */
  eyeHeight: number;
  /** 快照时间戳（主线程帧信号时间，跨线程同基准，LERP 插值用）。 */
  timeMs: number;
  /** 版本号（递增，检测新帧）。 */
  seq: number;
}

/** 物理帧（仅回退模式 MsgState 使用）。 */
export interface PhysFrameMessage {
  type: 'phys-frame';
  frame: FrameSnapshot;
}

export interface StatsMessage {
  type: 'stats';
  fps: number;
  pos: [number, number, number];
  vel: [number, number, number];
  onGround: boolean;
  cluster: number;
  speed: number;
  /** 最近一次速度归零的诊断原因（无 = null）。 */
  zeroCause?: string | null;
}

/** 准星射线检测信息（hover 查看模型/实体平面/触发面）。 */
export interface PlaneInfo {
  /**
   * 命中类型：
   * - 'mesh'：GLB 模型几何（prop_static 等），含 meshName
   * - 'solid'：实体碰撞箱（World.solids 中的 brush）
   * - 'ladder'：梯子碰撞箱（World.ladders 中的 brush）
   * - 'trigger'：传送触发器 AABB
   */
  type: 'mesh' | 'solid' | 'ladder' | 'trigger';
  /** 命中点距离（HU）。 */
  distance: number;
  /** 命中点坐标（Y-up）。 */
  point: [number, number, number];
  /** 命中面法线（Y-up，朝外）。 */
  normal: [number, number, number] | null;
  /** 命中面 dist（dot(normal, pointOnPlane)）。 */
  planeDist: number | null;
  /**
   * brush/trigger 索引（type=solid/ladder 时在对应数组中的位置；
   * type=trigger 时在 TeleportManager.triggers 中的位置）。
   */
  brushIndex: number;
  // ── mesh 信息（type='mesh'）──
  /** 模型名（GLB 节点名，如 "crate"、"crate#1"）。 */
  meshName?: string;
  /** 材质名。 */
  materialName?: string;
  /** 纹理名。 */
  textureName?: string;
  /** 材质属性标记。 */
  meshMeta?: {
    isTools: boolean;
    isNodraw: boolean;
    hasTexture: boolean;
    isWater: boolean;
    isTrans: boolean;
    isLightEmissive: boolean;
  };
  // ── trigger 信息（type='trigger'）──
  /** 触发器目标 targetname。 */
  triggerTarget?: string;
  /** 触发器目标 dest 索引（-1 = 孤儿触发器）。 */
  triggerDestIdx?: number;
  /** 触发器 classname（如 trigger_teleport）。 */
  triggerClassname?: string;
  /** 触发器 spawnflags（bitfield）。 */
  triggerSpawnflags?: number;
  /** 触发器是否初始禁用。 */
  triggerStartDisabled?: boolean;
}

export interface CullStatsMessage {
  type: 'cull-stats';
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

/** 物理参数快照（参数/碰撞箱变更后回传，面板渲染）。 */
export interface PhysicsSnapshotMessage {
  type: 'physics-snapshot';
  /** 每项仅含 name/value/source；label 等定义在主线程本地 PARAM_DEFS。 */
  params: Array<{ name: string; value: number | boolean; source: string }>;
  hull: {
    halfWidth: number;
    standHeight: number;
    duckHeight: number;
    source: string;
    isDefault: boolean;
  };
  autoRestoreHull: boolean;
}

/** 物理事件通知（自动恢复等）。 */
export interface PhysicsEventMessage {
  type: 'physics-event';
  event: 'hull-auto-restored';
  message: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

/** 玩家当前位置（响应 get-player-pos）。 */
export interface PlayerPosMessage {
  type: 'player-pos';
  pos: [number, number, number];
  yaw: number;
  pitch: number;
}

/** 游戏状态快照（计时挑战模式）。 */
export interface GameStatsMessage {
  type: 'game-stats';
  phase: 'idle' | 'running' | 'finished';
  elapsedMs: number;
  checkpointCount: number;
  lastCheckpointName: string;
  finishTimeMs: number;
  deaths: number;
  justDied: boolean;
}

export type MainMessage =
  | ReadyMessage
  | BspMetadataMessage
  | ParseProgressMessage
  | SpawnOptionsMessage
  | SceneDataMessage
  | PhysFrameMessage
  | StatsMessage
  | CullStatsMessage
  | PhysicsSnapshotMessage
  | PhysicsEventMessage
  | GameStatsMessage
  | PlayerPosMessage
  | ErrorMessage;

// ── 输入状态 ─────────────────────────────────────────────────

export interface KeyState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  duck: boolean;
  /** Shift 键：noclip 模式=冲刺倍率，physics 模式映射到 input.walk（慢走）。 */
  sprint: boolean;
  /** R 键：重生（cs-movement input.reset）。 */
  reset: boolean;
  /** 滚轮连跳（chasemod 风格 bhop）：本帧是否有滚轮 +jump 脉冲。 */
  wheelJump: boolean;
  /** Q 键：yaw 左旋（turn bind）。 */
  yawLeft: boolean;
  /** E 键：yaw 右旋（turn bind）。 */
  yawRight: boolean;
}
