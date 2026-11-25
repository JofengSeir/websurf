/**
 * 三端共用的「实体运行期装配器」。
 *
 * 宿主一律用观测模式：世界副作用经 `onEvent` 上报，不直接改物理。理由见各端
 * `setupEntitySystem` 注释——teleport / damage 目前仍由 Rust `build_world` 那条链承担，
 * 两条链同时施加会重复传送。要「完全收编」时只需在宿主侧把对应事件接到
 * `PhysWorld.teleport_to` / worker `teleport-to-pos`，实体层代码不用动。
 */
import { EntitySystem } from './entity-system.js';
import { createObservingHost } from './host.js';
import type { EntityEvent, PlayerState } from './types.js';

export interface AttachEntityOptions {
  /** `buildWorldBundle().entityIoJson`；缺省 / 空串 ⇒ 不装配。 */
  entityIoJson?: string;
  /** 每帧由宿主读取的真实玩家状态（Y-up）。 */
  getPlayerState(): PlayerState;
  /** I/O 输入、宿主副作用请求的统一观测回调。 */
  onEvent?: (event: EntityEvent) => void;
  /** 实体层诊断日志（未建模类 / 未处理输入），默认丢弃。 */
  log?: (message: string) => void;
  /** 装配失败时的告警出口；默认 `console.warn`。 */
  warn?: (message: string, error: unknown) => void;
}

/**
 * 缺省诊断出口：只打印低频、能证明 I/O 链真的在跑的事件，每个 kind 每秒最多一条。
 * 每次 `AcceptInput` 都会产生 `kind: 'input'` 事件，量很大，故不在白名单内。
 */
const DIAG_KINDS = new Set([
  'vscript', 'servercommand', 'clientcommand', 'game_text', 'env_fade',
  'entity:teleport', 'entity:damage', 'entity:unhandled',
]);

function createConsoleSink(): (event: EntityEvent) => void {
  const lastAt = new Map<string, number>();
  return (event) => {
    if (!DIAG_KINDS.has(event.kind)) return;
    const now = Date.now();
    if (now - (lastAt.get(event.kind) ?? 0) < 1000) return;
    lastAt.set(event.kind, now);
    console.info(`[entity-io] ${event.kind}${event.detail ? ` ${event.detail}` : ''}`);
  };
}

/** 装配一个 `EntitySystem`；`entityIoJson` 缺失或抛错时返回 null（宿主自行跳过 frame）。 */
export function attachEntitySystem(options: AttachEntityOptions): EntitySystem | null {
  if (!options.entityIoJson) return null;
  let system: EntitySystem | null = null;
  const consoleSink = createConsoleSink();
  const emit = (event: EntityEvent): void => {
    options.onEvent?.(event);
    consoleSink(event);
  };
  const effect = (kind: string, detail: string): void => {
    emit({ kind, detail, entityIndex: -1, classname: '', targetname: '', time: system?.time ?? 0 });
  };
  const host = createObservingHost(options.getPlayerState, {
    // 载荷带上 angles/velocity：增强插件（`entity:teleport` 消费方）需要朝向才能按
    // Source 语义落点；旧格式（裸 origin）不再产生，但插件仍兼容解析。
    teleport: (origin, angles, velocity) => effect('entity:teleport', JSON.stringify({ origin, angles, velocity })),
    addVelocity: (v) => effect('entity:addVelocity', JSON.stringify(v)),
    baseVelocity: (v) => effect('entity:baseVelocity', JSON.stringify(v)),
    gravity: (v) => effect('entity:gravity', String(v)),
    damage: (amount, type) => effect('entity:damage', `${amount}/${type}`),
    removePlayer: () => effect('entity:removePlayer', ''),
    gameText: (message) => effect('game_text', message),
    // 载荷带上颜色：增强插件（`env_fade` 消费方）要用 rendercolor/renderamt 才能按参数
    // 呈现过场渐变；旧格式（duration/hold/flags 三个数字）不再产生，但插件仍兼容解析。
    fade: (color, duration, hold, flags) => effect('env_fade', JSON.stringify({ color, duration, hold, flags })),
    serverCommand: (c) => effect('servercommand', c),
    clientCommand: (c) => effect('clientcommand', c),
    playSound: (s, i) => effect('sound:play', `${i}:${s}`),
    stopSound: (s, i) => effect('sound:stop', `${i}:${s}`),
    brushEnabled: (i, on) => effect('brush', `${i}:${on}`),
    // 移动 brush 的绝对位移（相对 BSP 出生位置，Y-up）。载荷用逗号分隔的定点小数，
    // 与 brush 开关同一「`<实体下标>:<值>`」约定，消费方在 EntityGameplay 解析。
    brushOffset: (i, o) => effect('brush:offset', `${i}:${o[0]},${o[1]},${o[2]}`),
    // 旋转 brush 的 three 欧拉角（弧度，绕实体 origin）；与位移同一「`<下标>:<x>,<y>,<z>`」载荷。
    brushRotation: (i, a) => effect('brush:rotation', `${i}:${a[0]},${a[1]},${a[2]}`),
    // sprite / 粒子的可见性与发射开关，沿用同一「`<实体下标>:<bool>`」载荷约定。
    spriteVisible: (i, on) => effect('sprite', `${i}:${on}`),
    particleActive: (i, on) => effect('particle', `${i}:${on}`),
    propVisible: (i, on) => effect('prop', `${i}:${on}`),
    script: (code, ctx) => effect('vscript', `${ctx.kind}:${code}`),
    terminateScriptScope: (i) => effect('vscript:terminate', String(i)),
  });
  try {
    system = new EntitySystem({ host, onEvent: emit, log: options.log });
    system.load(options.entityIoJson);
    const stats = system.stats();
    console.info(
      `[entity-io] 已装配：实体 ${stats.entityCount}（${Object.keys(stats.classCounts).length} 类）` +
      ` I/O 连接 ${stats.outputConnections} 带体积 ${stats.volumeEntities}`,
    );
    return system;
  } catch (e) {
    system?.dispose();
    (options.warn ?? ((m, err) => console.warn(m, err)))('[entity-io] 装配失败，本图不启用 Source 实体运行期:', e);
    return null;
  }
}
