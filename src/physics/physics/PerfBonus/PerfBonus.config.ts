/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import type { PerfSettings } from './PerfBonus.types.js';

export const DEFAULT_PERF_SETTINGS: PerfSettings = {
  enabled: false,
  maxAirSpeed: 390, // 实测 nopre chasemod 上限
};

// 空中速度超过 maxAirSpeed 后逼近上限的渐进程度（不可调，同 BHOP_MAX_SPEED_FACTOR 层级）。
// 值越低钳制越狠/越早。AirMove.ts 每空中 tick 应用，防止连跳链经 air-strafe 增益累计超过上限。
export const AIR_SPEED_CEILING_SOFTNESS = 10;
