/**
 * 运行时配置（最小化版）— 物理参数经 config 消息 → Worker-A → wasm set_params/set_hull。
 */

export interface PhysicsConfig {
  /** 物理模式：physics（权威物理）/ noclip（自由视角，禁物理/传送）。 */
  mode: 'physics' | 'noclip';
  /** 物理模拟频率（Hz，默认 64；面板 48-128 可调，Worker-A/B 步长联动）。 */
  tickRate: number;
  gravity: number;
  jumpSpeed: number;
  maxSpeed: number;
  friction: number;
  accelerate: number;
  airAccel: number;
  stopSpeed: number;
  autobhop: boolean;
}

export interface InputConfig {
  sensitivity: number;
  pitchLimit: number;
  /** Q/E 键 yaw 旋转速度（度/秒，turn bind）。 */
  yawBindSpeed: number;
  /** noclip 自由视角移动速度（HU/s）。 */
  noclipSpeed: number;
}

export interface PlayerConfig {
  halfWidth: number;
  standHeight: number;
  duckHeight: number;
}

export interface HudConfig {
  showCrosshair: boolean;
  /** 速度面板模式：'lateral' 横向 / 'lateral-vertical' 横+竖 / 'total' 综合。 */
  speedMode: 'lateral' | 'lateral-vertical' | 'total';
}

export interface RuntimeConfig {
  /**
   * 锁定 tick 频率（V8/P2 公平性）：true = 锁定 64Hz 只读（计时玩法）；
   * false = 调试构建，面板 48-128 可调。切换后需 reload。
   */
  lockTickRate: boolean;
  physics: PhysicsConfig;
  input: InputConfig;
  player: PlayerConfig;
  hud: HudConfig;
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  // 调试期 false（面板可调）；上计时玩法前置 true 锁定 64Hz
  lockTickRate: false,
  physics: {
    mode: 'physics',
    tickRate: 64,
    gravity: 800,
    jumpSpeed: 302,
    maxSpeed: 250,
    friction: 4,
    accelerate: 10,
    airAccel: 100,
    stopSpeed: 100,
    autobhop: true,
  },
  input: {
    sensitivity: 1.5,
    pitchLimit: 89,
    yawBindSpeed: 210,
    noclipSpeed: 800,
  },
  player: {
    halfWidth: 16,
    standHeight: 72,
    duckHeight: 54,
  },
  hud: {
    showCrosshair: true,
    speedMode: 'lateral',
  },
};

export function createConfig(): RuntimeConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export function applyConfigPatch(
  config: RuntimeConfig,
  section: keyof RuntimeConfig,
  patch: Record<string, unknown>,
): void {
  const target = config[section];
  if (!target || typeof target !== 'object') return;
  Object.assign(target, patch);
}
