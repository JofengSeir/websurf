/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

// 来源（Valve source-sdk-2013, game/shared/gamemovement.cpp）：CGameMovement::Friction

import type { Vec3 } from '../../math/vec3.js';

/** 地面摩擦。只消耗水平分量（y 为垂直方向，地面时本就归零）。 */
export function applyFriction(vel: Vec3, friction: number, stopspeed: number, dt: number): void {
  const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  if (speed < 0.1) return;

  const control = speed < stopspeed ? stopspeed : speed;
  const drop = control * friction * dt;

  let newspeed = speed - drop;
  if (newspeed < 0) newspeed = 0;

  if (newspeed !== speed) {
    const ratio = newspeed / speed;
    vel.x *= ratio;
    vel.z *= ratio;
  }
}
