/**
 * Source 实体系统 —— 公共类型与宿主接口。
 *
 * 本层零 `three` / 零 DOM 依赖：所有与渲染、物理、音频、UI 的连接都通过 `EntityHost`
 * 注入。这样 engine 侧逻辑可以在 Node 里直接跑测试（与 SDK 的 server DLL 同构）。
 *
 * 对照：Source SDK 2013 `game/server/baseentity.h:221-227`（inputdata_t）、
 * `game/server/entityoutput.h`、`game/server/eventqueue.h`。
 */

import type { Variant } from './variant.js';
import type { Color32, EntityRef, Vec3 } from './primitives.js';

/** 叶层结构类型（见 `primitives.ts`）在旧路径上继续可用。 */
export type { Color32, EntityRef, Vec3 };

/** 引擎 `CBaseEntity` 的最小接口，供 I/O 层引用，不依赖具体类实现。 */
export interface EntityLike extends EntityRef {
  acceptInput(
    name: string,
    activator: EntityLike | null,
    caller: EntityLike | null,
    value: Variant,
    outputID: number,
  ): boolean;
}

/** `inputdata_t`：输入处理函数收到的上下文。 */
export interface InputData {
  /** 触发这条链路的原始实体（沿 I/O 链一路透传）。 */
  activator: EntityLike | null;
  /** 直接发出这条输入的实体（通常是上一个实体）。 */
  caller: EntityLike | null;
  /** 参数；`AcceptInput` 已按输入声明类型转换好。 */
  value: Variant;
  /** `CEventAction::m_iIDStamp`；`Use` 输入会把它当 USE_TYPE 用。 */
  outputID: number;
}

/** 玩家/世界在宿主侧的可读写状态（Y-up 世界坐标，与 `src/phys` 一致）。 */
export interface PlayerState {
  origin: Vec3;
  velocity: Vec3;
  /** 度：`[pitch, yaw, roll]`。 */
  angles: Vec3;
  /** 玩家碰撞盒相对 origin 的偏移。 */
  hullMins: Vec3;
  hullMaxs: Vec3;
  onGround: boolean;
  alive: boolean;
}

/**
 * 宿主必须提供的世界副作用。缺省方法表示「该端不实现这类表现」，
 * 实体逻辑照常走到调用点，只是没有可见效果（与 SDK 里 server-only 端的降级一致）。
 */
export interface EntityHost {
  getPlayerState(): PlayerState;
  /** `CTriggerTeleport::Touch` 的 Teleport；`angles`/`velocity` 为 null 表示保留原值。 */
  teleportPlayer(origin: Vec3, angles: Vec3 | null, velocity: Vec3 | null): void;
  /** `ApplyAbsVelocityImpulse`（trigger_push 的 PUSH_ONCE 路径）。 */
  addPlayerVelocity(delta: Vec3): void;
  /** `SetBaseVelocity`（trigger_push 常规路径）；null = 清除 basevelocity。 */
  setPlayerBaseVelocity(value: Vec3 | null): void;
  /** `CTriggerHurt::HurtEntity`；负数为治疗。 */
  damagePlayer(amount: number, damageType: number): void;
  /** `UTIL_Remove(player)`（trigger_remove）。 */
  removePlayer?(): void;
  /** `game_text` / `CGameText::Display`。 */
  showGameText?(message: string, params: Record<string, string | number>): void;
  /** `env_fade` / `UTIL_ScreenFade`。 */
  fadeScreen?(color: Color32, duration: number, hold: number, flags: number): void;
  /** `point_servercommand` / `engine->ServerCommand`。 */
  runServerCommand?(command: string): void;
  /** `point_clientcommand` / `engine->ClientCommand`。 */
  runClientCommand?(command: string): void;
  /**
   * VScript 执行钩子（`CBaseEntity::InputRunScript*` / `InputCallScriptFunction`）。
   * SDK 用 Squirrel VM，宿主侧可注入任意等价执行器；不注入时输入按 SDK 走完
   * `ValidateScriptScope` / `activator`+`caller` 注入流程，但无可见效果。
   * `code` 已经过 `InputRunScript` 的反引号 → 双引号替换。
   */
  evalScript?(
    code: string,
    context: {
      kind: 'code' | 'file' | 'function';
      entity: EntityRef;
      activator: EntityRef | null;
      caller: EntityRef | null;
    },
  ): void;
  /** `CBaseEntity::TerminateScriptScope`。 */
  terminateScriptScope?(entityIndex: number): void;
  /** `ambient_generic` 等声音实体的播放。 */
  playSound?(soundName: string, entityIndex: number): void;
  stopSound?(soundName: string, entityIndex: number): void;
  /** brush 实体的 Enable/Disable 视觉与碰撞开关。 */
  setBrushEnabled?(entityIndex: number, enabled: boolean): void;
  /**
   * 运行期平移实体 brush 的几何/碰撞（`func_movelinear`、`func_door` 等移动 brush）。
   * `offset` 是相对 BSP 出生位置的**绝对位移**（不是增量），单位 HU、Y-up。
   * 物理与渲染由宿主各自消费：物理线用 `PhysWorld.set_brush_offset`，渲染线把合并几何
   * 的顶点写回 `base + offset`（见 `BrushEntityVisibility.setEntityOffset`）。
   */
  setBrushOffset?(entityIndex: number, offset: Vec3): void;
  /** `trigger_gravity` 改玩家重力倍数；不实现时该 trigger 只记录状态。 */
  setPlayerGravity?(value: number): void;
  /** 诊断日志（默认丢弃）。 */
  log?(message: string): void;
}

/** Rust `render_bundle::EntityBrushVolume` 的 JSON 形状。 */
export interface EntityBrushVolume {
  mins: Vec3;
  maxs: Vec3;
  /** `[nx, ny, nz, dist]`，法线朝外，内部 `dot(n,p) - dist <= 0`。 */
  planes: number[][];
}

/** Rust `render_bundle::EntityVolume` 的 JSON 形状。 */
export interface EntityVolume {
  index: number;
  model: string;
  origin: Vec3;
  brushes: EntityBrushVolume[];
}

/** `BspProcessor.export_entity_io()` 的 JSON 形状。 */
export interface EntityIoPayload {
  /** entities lump 无损原文（保留大小写、重复键、ESC 分隔的 I/O 串）。 */
  entities_text: string;
  volumes: EntityVolume[];
}

/** 一个实体被宿主观测到的事件，用于 debug HUD / 回放 / 计时状态机。 */
export interface EntityEvent {
  kind: string;
  entityIndex: number;
  classname: string;
  targetname: string;
  activatorName?: string;
  detail?: string;
  time: number;
}
