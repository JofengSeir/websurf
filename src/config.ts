/**
 * 运行时配置 — 对应 render-worker.js 的 DEFAULT_CONFIG
 * 前端通过 postMessage({type:'config', patch}) 部分更新
 */

export interface PhysicsConfig {
  mode: 'noclip' | 'physics';
  gravity: number;
  jumpSpeed: number;
  maxSpeed: number;
  friction: number;
  accelerate: number;
  airAccel: number;
  stopSpeed: number;
  duckScale: number;
  groundAngle: number; // 弧度
  slideAngle: number; // 弧度
  /** 物理模拟频率（Hz，默认 128；面板可调 64-512）。 */
  tickRate: number;
}

export interface PlayerConfig {
  radius: number;
  standHeight: number;
  duckHeight: number;
  eyeOffset: number;
}

export interface MovementConfig {
  speed: number;
  sprintMultiplier: number;
}

export interface SmoothingConfig {
  speed: number;
}

export interface TeleportConfig {
  triggerRadius: number;
  cooldownMs: number;
}

export interface LodConfig {
  pvsEnabled: boolean;
  updateInterval: number;
  cullDistance: number;
}

export interface LightingConfig {
  ambientColor: number;
  ambientIntensity: number;
  hemiSkyColor: number;
  hemiGroundColor: number;
  hemiIntensity: number;
  dirColor: number;
  dirIntensity: number;
  dirAzimuth: number;
  dirElevation: number;
  bgColor: number;
}

export interface InputConfig {
  sensitivity: number;
  pitchLimit: number; // 度
  /** Q/E 键 yaw 旋转速度（度/秒，turn bind）。
   * 按住 Q/E 键时视角水平旋转，滑块控制速度。
   * 默认 180 度/秒（约 0.5 秒转半圈）。 */
  yawBindSpeed: number;
}

export interface HudConfig {
  /** 是否显示右上角 HUD 信息（stats/cullStats/gameStats/planeInfo）。
   * 关闭时 Worker 停止 stats 发送和平面射线检测，减少性能浪费。 */
  visible: boolean;
  /** 是否显示中心准星。 */
  showCrosshair: boolean;
}

export interface DebugConfig {
  /** 显示实体碰撞箱线框（附近 512 HU 内 brush AABB，地面绿/斜坡黄/墙红）。 */
  showSolids: boolean;
  /** 显示传送触发碰撞箱线框（所有 trigger AABB，青/紫/灰/橙分类）。 */
  showTriggers: boolean;
  /** 准星射线检测（hover 查看模型/实体平面/触发面信息）。 */
  showPlaneInfo: boolean;
  /**
   * 传送触发模式。
   *
   * - `start-touch`: StartTouch 边沿触发（CS:S 引擎原生行为，默认）
   * - `start-touch-grounded`: StartTouch + 着地状态（surf 服务器常见行为，
   *   "空中不传送，落到地面才传送"）
   */
  teleportTriggerMode: 'start-touch' | 'start-touch-grounded';
  /**
   * 触发传送所需的连续着地帧数阈值（仅 start-touch-grounded 模式生效）。
   *
   * - 1: 单帧落地即触发（最敏感，原始行为）
   * - 3-5: 过滤 surf 坡道短暂触地（典型 ckSurf 插件近似）
   * - 10: 严格模式，要求持续约 167ms 落地
   *
   * 默认 1，保持与原 start-touch-grounded 行为兼容。
   */
  groundedFramesRequired: number;
}

export interface RuntimeConfig {
  physics: PhysicsConfig;
  player: PlayerConfig;
  movement: MovementConfig;
  smoothing: SmoothingConfig;
  teleport: TeleportConfig;
  lod: LodConfig;
  lighting: LightingConfig;
  input: InputConfig;
  hud: HudConfig;
  debug: DebugConfig;
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  physics: {
    mode: 'physics',
    gravity: 800,
    jumpSpeed: 302,
    maxSpeed: 250,
    friction: 4,
    accelerate: 10,
    airAccel: 100,
    stopSpeed: 100,
    duckScale: 0.34,
    groundAngle: (30 * Math.PI) / 180,
    slideAngle: (70 * Math.PI) / 180,
    tickRate: 128,
  },
  player: {
    radius: 16,
    standHeight: 72,
    duckHeight: 54,
    eyeOffset: 8,
  },
  movement: {
    speed: 200,
    sprintMultiplier: 4,
  },
  smoothing: {
    speed: 12,
  },
  teleport: {
    triggerRadius: 64,
    cooldownMs: 600,
  },
  lod: {
    // PVS 默认开启；判定每帧执行，视角转动时剔除即时响应，显著降低 draw calls。
    pvsEnabled: true,
    updateInterval: 1,
    cullDistance: 12800, // 默认视距上限（加载后由场景计算覆盖，见 lod-manager）
  },
  lighting: {
    ambientColor: 0xffffff,
    ambientIntensity: 0.6,
    hemiSkyColor: 0xb0c4de,
    hemiGroundColor: 0x404030,
    hemiIntensity: 0.4,
    dirColor: 0xfff4e0,
    dirIntensity: 0.5,
    dirAzimuth: 45,
    dirElevation: 45,
    bgColor: 0x222222,
  },
  input: {
    // cs-movement 乘数模型：有效灵敏度 = sensitivity * m_yaw(0.022) deg/px
    sensitivity: 1.5,
    pitchLimit: 89,
    yawBindSpeed: 210,
  },
  hud: {
    visible: true,
    showCrosshair: true,
  },
  debug: {
    showSolids: false,
    showTriggers: false,
    showPlaneInfo: false,
    // 默认 StartTouch 边沿触发（CS:S 引擎原生行为）
    teleportTriggerMode: 'start-touch',
    groundedFramesRequired: 1,
  },
};

/** 深拷贝默认配置，避免运行时修改污染 */
export function createConfig(): RuntimeConfig {
  return structuredClone(DEFAULT_CONFIG);
}

/** 部分更新配置（对应 render-worker.js applyConfigPatch） */
export function applyConfigPatch(
  config: RuntimeConfig,
  section: keyof RuntimeConfig,
  patch: Record<string, unknown>,
): void {
  const target = config[section];
  if (!target || typeof target !== 'object') return;
  Object.assign(target, patch);
}
