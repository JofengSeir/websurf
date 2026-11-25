/**
 * `EntityHost` 的通用观测适配器。
 *
 * Source 的 server DLL 直接改世界（UTIL_Remove / Teleport / ScreenFade / engine->ServerCommand）；
 * 浏览器宿主把「世界长什么样」拆给渲染层 / 物理层 / UI 层，所以这里只做**能力注入**：
 * 每个副作用都原样转给 sink，由宿主决定是真正施加、还是只记一条诊断。
 *
 * 这样实体层不需要认识任何一端的类，也不会因为「某一端没有玩家」「某一端不能改物理」
 * 就在 I/O 链里写 if —— 这正是 SDK 里 server/client 分工的等价物。
 */
import type {
  Color32, EntityHost, EntityRef, PlayerState, Vec3,
} from './types.js';

export interface EntityEffectSink {
  teleport?(origin: Vec3, angles: Vec3 | null, velocity: Vec3 | null): void;
  addVelocity?(delta: Vec3): void;
  baseVelocity?(value: Vec3 | null): void;
  gravity?(value: number): void;
  damage?(amount: number, damageType: number): void;
  removePlayer?(): void;
  gameText?(message: string, params: Record<string, string | number>): void;
  fade?(color: Color32, duration: number, hold: number, flags: number): void;
  serverCommand?(command: string): void;
  clientCommand?(command: string): void;
  playSound?(soundName: string, entityIndex: number): void;
  stopSound?(soundName: string, entityIndex: number): void;
  brushEnabled?(entityIndex: number, enabled: boolean): void;
  /** 移动 brush（`func_movelinear` / 门）的绝对位移（相对 BSP 出生位置，Y-up）。 */
  brushOffset?(entityIndex: number, offset: Vec3): void;
  /** 旋转 brush（`func_rotating` / 旋转门）的 three 欧拉角（弧度，绕实体 origin）。 */
  brushRotation?(entityIndex: number, angles: Vec3): void;
  /** `env_sprite` 的 ShowSprite / HideSprite / ToggleSprite。 */
  spriteVisible?(entityIndex: number, visible: boolean): void;
  /** `info_particle_system` 的 Start / Stop。 */
  particleActive?(entityIndex: number, active: boolean): void;
  /** `prop_dynamic` 的 TurnOn / TurnOff（只改可见性，不动碰撞）。 */
  propVisible?(entityIndex: number, visible: boolean): void;
  script?(code: string, context: {
    kind: 'code' | 'file' | 'function';
    entity: EntityRef;
    activator: EntityRef | null;
    caller: EntityRef | null;
  }): void;
  terminateScriptScope?(entityIndex: number): void;
  log?(message: string): void;
}

/**
 * 用「玩家状态读取函数 + 副作用 sink」造一个 `EntityHost`。
 * sink 缺哪个能力，对应输入就走 SDK 的「server-only 端无表现」降级路径，
 * 但 I/O 分派、输出、事件队列仍然完整执行。
 */
export function createObservingHost(
  getPlayerState: () => PlayerState,
  sink: EntityEffectSink = {},
): EntityHost {
  return {
    getPlayerState,
    teleportPlayer: (origin, angles, velocity) => sink.teleport?.(origin, angles, velocity),
    addPlayerVelocity: (delta) => sink.addVelocity?.(delta),
    setPlayerBaseVelocity: (value) => sink.baseVelocity?.(value),
    setPlayerGravity: (value) => sink.gravity?.(value),
    damagePlayer: (amount, damageType) => sink.damage?.(amount, damageType),
    removePlayer: () => sink.removePlayer?.(),
    showGameText: (message, params) => sink.gameText?.(message, params),
    fadeScreen: (color, duration, hold, flags) => sink.fade?.(color, duration, hold, flags),
    runServerCommand: (command) => sink.serverCommand?.(command),
    runClientCommand: (command) => sink.clientCommand?.(command),
    playSound: (soundName, entityIndex) => sink.playSound?.(soundName, entityIndex),
    stopSound: (soundName, entityIndex) => sink.stopSound?.(soundName, entityIndex),
    setBrushEnabled: (entityIndex, enabled) => sink.brushEnabled?.(entityIndex, enabled),
    setBrushOffset: (entityIndex, offset) => sink.brushOffset?.(entityIndex, offset),
    setBrushRotation: (entityIndex, angles) => sink.brushRotation?.(entityIndex, angles),
    setSpriteVisible: (entityIndex, visible) => sink.spriteVisible?.(entityIndex, visible),
    setParticleActive: (entityIndex, active) => sink.particleActive?.(entityIndex, active),
    setPropVisible: (entityIndex, visible) => sink.propVisible?.(entityIndex, visible),
    evalScript: (code, context) => sink.script?.(code, context),
    terminateScriptScope: (entityIndex) => sink.terminateScriptScope?.(entityIndex),
    log: (message) => sink.log?.(message),
  };
}

/** 把 `PhysWorld.state()` 之类的「x/y/z + yaw/pitch + vel + onGround」形状映射成 PlayerState。 */
export interface RawPlayerState {
  posX: number; posY: number; posZ: number;
  yaw?: number; pitch?: number;
  velX?: number; velY?: number; velZ?: number;
  onGround?: boolean;
  alive?: boolean;
}

/** 本项目 cs-movement 的碰撞盒：origin 在脚底，Y 向上，站立高 72、半宽 16。 */
export const DEFAULT_HULL_MINS: Vec3 = [-16, 0, -16];
export const DEFAULT_HULL_MAXS: Vec3 = [16, 72, 16];

export function playerStateFromRaw(raw: RawPlayerState): PlayerState {
  return {
    origin: [raw.posX, raw.posY, raw.posZ],
    velocity: [raw.velX ?? 0, raw.velY ?? 0, raw.velZ ?? 0],
    // 这里保留 Source `[pitch,yaw,roll]` 语义；yaw 已是宿主度数值。
    angles: [raw.pitch ?? 0, raw.yaw ?? 0, 0],
    hullMins: [...DEFAULT_HULL_MINS] as Vec3,
    hullMaxs: [...DEFAULT_HULL_MAXS] as Vec3,
    onGround: raw.onGround ?? false,
    alive: raw.alive ?? true,
  };
}
