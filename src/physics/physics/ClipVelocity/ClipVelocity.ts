/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

// 来源（Valve source-sdk-2013, game/shared/gamemovement.cpp）：CGameMovement::ClipVelocity

import type { Vec3 } from '../../math/vec3.js';

/**
 * 沿平面滑行速度。overbounce 1.0（surf）恰好移除垂直平面分量；
 * 1.001（普通剪裁）多移除一点，防止下一 tick 重新穿透平面。
 */
export function clipVelocity(vel: Vec3, normal: Vec3, overbounce: number): void {
  const backoff = (vel.x * normal.x + vel.y * normal.y + vel.z * normal.z) * overbounce;
  vel.x -= normal.x * backoff;
  vel.y -= normal.y * backoff;
  vel.z -= normal.z * backoff;

  // CS:GO 在 Source 上追加的修正步（针对 surf 斜坡）：overbounce 1.0 时浮点误差
  // 会残留垂直平面分量，导致物体每 tick 重复碰撞同一平面、最终粘住。
  const adjust = vel.x * normal.x + vel.y * normal.y + vel.z * normal.z;
  if (adjust < 0) {
    vel.x -= normal.x * adjust;
    vel.y -= normal.y * adjust;
    vel.z -= normal.z * adjust;
  }
}
