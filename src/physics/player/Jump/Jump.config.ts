/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import { GRAVITY } from '../../constants.js';
import { getRuntimePhysics } from '../../runtime.js';

export const JUMP_HEIGHT = 57; // jump apex, units（基准默认，面板可覆盖）
/** 基准起跳速度（默认重力 × 默认跳高推导）。 */
export const JUMP_VELOCITY = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT); // ≈ 301.993

/**
 * 当前起跳速度：随 runtime 重力/跳高实时推导
 * （v = √(2·g·h)，Source 的 Jump 公式）。
 */
export function getJumpVelocity(): number {
  const { gravity, jumpHeight } = getRuntimePhysics();
  return Math.sqrt(2 * gravity * jumpHeight);
}
// sv_enablebunnyhopping 0: horizontal speed is clamped to 1.1 × maxspeed on
// every takeoff, so hops cruise ~275 instead of gaining unboundedly.
export const BHOP_MAX_SPEED_FACTOR = 1.1;
