/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

// 来源（Valve source-sdk-2013, game/shared/gamemovement.cpp）：CGameMovement::AirAccelerate

import type { Vec3 } from '../../math/vec3.js';
import { AIR_SPEED_CAP } from './AirAccelerate.config.js';

/**
 * 空气加速——bhop/surf 的核心公式。注意其刻意的不对称：
 * `addspeed` 用 30 u/s 钳制后的 wishspeed，`accelspeed` 用未钳制的 wishspeed，
 * 这正是 Source 原版行为，也是大 sv_airaccelerate 能获得近乎瞬时空中控制的原因。
 * 最终速度无上限，故 strafe 可超过 maxspeed。
 */
export function airAccelerate(
  vel: Vec3,
  wishdir: Vec3,
  wishspeed: number,
  airaccel: number,
  dt: number,
  airCap: number = AIR_SPEED_CAP,
): void {
  const wishspd = wishspeed > airCap ? airCap : wishspeed;

  const currentspeed = vel.x * wishdir.x + vel.y * wishdir.y + vel.z * wishdir.z;
  const addspeed = wishspd - currentspeed;
  if (addspeed <= 0) return;

  let accelspeed = airaccel * wishspeed * dt;
  if (accelspeed > addspeed) accelspeed = addspeed;

  vel.x += accelspeed * wishdir.x;
  vel.y += accelspeed * wishdir.y;
  vel.z += accelspeed * wishdir.z;
}
