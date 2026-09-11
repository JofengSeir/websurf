/**
 * 消息协议 — 主线程 ↔ Worker（阶段 2：Worker = 权威帧计算器）
 *
 * Worker 不再解析 BSP/构建渲染场景：主线程解析后经 world-json 下发世界数据，
 * Worker 持权威 PhysWorld（固定步长自驱），每 tick 写权威帧（SAB 双缓冲或
 * phys-frame 消息回退）+ 碰撞事件（phys-event）。
 */

import type { RuntimeConfig } from '../config.js';

// ── 主线程 → Worker ──────────────────────────────────────────

/** 主线程 → Worker：注入 WASM 模块。dist 内嵌用 base64（wasmB64）initSync；dev 模式用 URL（wasmUrl）fetch。 */
export interface WasmInitMessage {
  type: 'wasm-init';
  wasmB64?: string;
  wasmUrl?: string;
  /** 默认纹理包 base64（single 打包内嵌；file:// 下 worker 无法 fetch，经此下发）。
   * 阶段 2 起 Worker 不再解析 BSP/导出 GLB，此字段仅为协议兼容保留。 */
  mtzB64?: string;
}

export interface InitMessage {
  type: 'init';
  /**
   * 共享内存（SharedArrayBuffer）：
   * - 非 null（crossOriginIsolated）：输入/权威帧走共享内存 + 原子操作
   * - null（无 COOP/COEP）：回退 postMessage 数据通道（MsgState）
   */
  shared: SharedArrayBuffer | null;
  width: number;
  height: number;
  dpr: number;
}

/** 输入状态消息（仅回退模式 MsgState 使用；dx/dy 增量 + keys 位掩码）。 */
export interface InputMessage {
  type: 'input';
  dx: number;
  dy: number;
  keys: number;
}

/** 世界数据（主线程解析 BSP 后下发；Worker 构建权威 PhysWorld）。 */
export interface WorldJsonMessage {
  type: 'world-json';
  brushJson: string;
  triJson: string;
  teleportJson: string;
  spawn: { x: number; y: number; z: number; yawDeg: number };
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

/** 设置出生点列表（spawn 下拉切换用；world-json 只设初始 spawn）。 */
export interface SetSpawnPointsMessage {
  type: 'set-spawn-points';
  json: string;
}

/**
 * 渲染主线 → 权威同步（大偏差兜底：以渲染主线为准反向校准权威）。
 * 同步瞬间权威侧清空未消费输入增量（键位保留）。
 */
export interface SyncRenderStateMessage {
  type: 'sync-render-state';
  state: {
    posX: number; posY: number; posZ: number;
    yaw: number; pitch: number;
    velX: number; velY: number; velZ: number;
    onGround: boolean;
  };
}

/** 设置掉落死亡阈值（主线程从场景包围盒算出的 Y 下限）。 */
export interface SetDeathThresholdMessage {
  type: 'set-death-threshold';
  value: number;
}

export type WorkerMessage =
  | WasmInitMessage
  | InitMessage
  | InputMessage
  | WorldJsonMessage
  | ConfigMessage
  | ResizeMessage
  | RespawnMessage
  | SetPhysicsParamMessage
  | ResetPhysicsParamMessage
  | SetHullMessage
  | ResetHullMessage
  | SetAutoRestoreHullMessage
  | SetCullDistanceMessage
  | TeleportMessage
  | TeleportToPosMessage
  | SetSpawnPointsMessage
  | SyncRenderStateMessage
  | SetDeathThresholdMessage;

// ── Worker → 主线程 ──────────────────────────────────────────

export interface ReadyMessage {
  type: 'ready';
}

/** 权威帧（仅回退模式 MsgState 使用；SAB 模式走共享内存）。 */
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

/** 权威碰撞事件（落地/撞墙瞬间；低频，位置微调 + 角度同步用）。 */
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

export type MainMessage =
  | ReadyMessage
  | PhysFrameMessage
  | PhysEventMessage
  | PhysicsSnapshotMessage
  | PhysicsEventMessage
  | ErrorMessage;

/** 准星射线检测信息（hover 查看模型/实体平面/触发面；主线程渲染器本地计算）。 */
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
  /** brush/trigger 索引（type=solid/ladder 时在对应数组中的位置；
   * type=trigger 时在 TeleportManager.triggers 中的位置）。 */
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

// ── 场景数据（主线程解析 → 渲染器本地数据；renderer-main 使用）──

/**
 * 主线程解析 BSP 后本地传入渲染器的场景数据（不再经 Worker）。
 * 保留此结构：app.ts handleLoadBsp 构建，renderer.loadScene 消费。
 */
export interface SceneDataMessage {
  type: 'scene-data';
  /** GLB 字节。 */
  glb: ArrayBuffer;
  /** 碰撞体 JSON（WASM brushes → 主线程 adaptBrushes 转换）。 */
  brushJson: string;
  /** 模型「可视网格」三角形碰撞 JSON（可选，失败时缺省）。 */
  triJson?: string;
  /** 纹理画质 manifest：`{ 纹理名(小写 basetexture): mosaic v4 字节码 }` JSON。 */
  mosaicManifest?: string;
  /** 缺失材质纹理列表（VMT/VTF 缺失 → 占位色）。 */
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
