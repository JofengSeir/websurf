/**
 * 运行时配置（最小化版）— 物理参数经 config 消息 → Worker-A → wasm set_params/set_hull。
 */

import { buildPhysicsParams as sharedBuildPhysicsParams } from '../../src/ts-shared/phys/params.js';

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
  /** 走路速度（HU/s，默认 130）。 */
  walkSpeed: number;
  /** 蹲走速度（HU/s，默认 85）。 */
  crouchSpeed: number;
  /** bhop 速度钳制（连跳不超 maxSpeed，默认 true）。 */
  bhopSpeedClamp: boolean;
  /** nopre：禁用预加速（落地速度硬钳到 runSpeed，默认 true）。 */
  noPrestrafe: boolean;
  /** 传送触发落地稳定门槛（帧，默认 3）：落地持续 >= 该值才判定位于传送平面。 */
  teleportGateTicks: number;
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

/** 准星风格化配置（面板可调，localStorage 持久化）。 */
export interface CrosshairConfig {
  /** 准星颜色（CSS hex）。 */
  color: string;
  /** 线条长度（px）。 */
  size: number;
  /** 线条粗细（px）。 */
  thickness: number;
  /** 中心间隙（px）。 */
  gap: number;
  /** 黑色描边（深色背景下更清晰）。 */
  outline: boolean;
  /** 中心点。 */
  dot: boolean;
}

export interface HudConfig {
  showCrosshair: boolean;
  /** 速度面板模式：'lateral' 横向 / 'lateral-vertical' 横+竖 / 'total' 综合。 */
  speedMode: 'lateral' | 'lateral-vertical' | 'total';
  /** 准星风格（见 CrosshairConfig）。 */
  crosshair: CrosshairConfig;
  /** 视野角 FOV（度，CS:S 标准 75；面板 60-110 可调）。 */
  fov: number;
}

/** 纹理画质配置（mosaic 共享模块，运行时切换贴图，无需重载地图）。 */
export interface TextureConfig {
  /** original = 原始纹理（VTF 解码）；mini = mosaic 压缩低清纹理（×8 最近邻）。 */
  quality: 'original' | 'mini';
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
  texture: TextureConfig;
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
    airAccel: 150,
    stopSpeed: 100,
    autobhop: true,
    walkSpeed: 130,
    crouchSpeed: 85,
    bhopSpeedClamp: true,
    noPrestrafe: true,
    teleportGateTicks: 1,
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
    fov: 75,
    crosshair: {
      color: '#4ade80',
      size: 6,
      thickness: 2,
      gap: 4,
      outline: true,
      dot: false,
    },
  },
  texture: {
    quality: 'original',
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

/** 构造 Rust `set_params` 兼容的全量参数对象（权威 Worker 与主线程预测实例共用）。
 * 公共化：映射实现收敛到 ts-shared（buildPhysicsParams + PhysicsParamsLike），
 * 本处仅做 config 字段名 → 统一入参接口的薄映射。 */
export function buildPhysicsParams(config: RuntimeConfig): Record<string, unknown> {
  const p = config.physics;
  return sharedBuildPhysicsParams(
    {
      gravity: p.gravity,
      accelerate: p.accelerate,
      friction: p.friction,
      stopSpeed: p.stopSpeed,
      jumpSpeed: p.jumpSpeed,
      airAccel: p.airAccel,
      maxSpeed: p.maxSpeed,
      walkSpeed: p.walkSpeed,
      crouchSpeed: p.crouchSpeed,
      autobhop: p.autobhop,
      bhopSpeedClamp: p.bhopSpeedClamp,
      noPrestrafe: p.noPrestrafe,
      teleportGateTicks: p.teleportGateTicks,
    },
    {
      yawBindSpeed: config.input.yawBindSpeed,
      noclipSpeed: config.input.noclipSpeed,
    },
  );
}
