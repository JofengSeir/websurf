/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import type { StaminaSettings } from '../physics/Stamina/Stamina.types.js';
import type { PerfSettings } from '../physics/PerfBonus/PerfBonus.types.js';

export type { StaminaSettings, PerfSettings };

export interface CrosshairSettings {
  color: string;
  size: number; // 臂长，px
  thickness: number; // 粗细，px
  gap: number; // 中心到臂起点的距离，px
  outline: boolean;
  dot: boolean;
  tStyle: boolean; // 无顶部臂
}

export interface Settings {
  sensitivity: number;
  mYaw: number; // 每鼠标 count 度数，CS:GO 的 m_yaw/m_pitch
  fov: number; // CS:GO 4:3 口径的水平 FOV
  tickRate: number;
  autobhop: boolean;
  /** sv_enablebunnyhopping 0——起跳速度钳制为 1.1 × maxspeed。 */
  bhopSpeedClamp: boolean;
  /**
   * "nopre"：空中 strafe/prestrafe 速度增益（见 airAccelerate）完全不受限——
   * 本项不限制 AirMove。它给的是地速硬上限（玩家当前最大速度）：落地速度超过
   * 该值（来自 prestrafe、无上限连跳链、完美连跳继承等），walkMove 会在你
   * 落地自主移动的瞬间钳下来。空中仍可攒速度秀操作，只是不能兑现成永久地速冲刺。
   */
  noPrestrafe: boolean;
  airAccelerate: number;
  runSpeed: number;
  walkSpeed: number;
  crouchSpeed: number;
  showSpeed: boolean;
  showFps: boolean;
  showDebug: boolean;
  viewPunch: boolean;
  crosshair: CrosshairSettings;
  stamina: StaminaSettings;
  perf: PerfSettings;
}
