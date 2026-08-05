/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import { copy, set } from '../../math/vec3.js';
import type { MovementContext } from '../MovementContext.js';

const DIRS: Array<[number, number, number]> = [
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
  [1, 0, 1],
  [-1, 0, 1],
  [1, 0, -1],
  [-1, 0, -1],
  [0, -1, 0],
];

/**
 * Source 风格 CheckStuck：若 hull 在某 tick 开始时与实体重叠（brush 相交处，
 * 如 Λ 形斜坡脊），就近挤出到空闲位置，而不是让移动管线在内部几何上磨蹭。
 * 仅彻底卡死时返回 true（此时同时清零速度，防止被钉住时重力泵速度）。
 */
export function checkStuck(ctx: MovementContext): boolean {
  if (ctx.world.isPositionFree(ctx.origin, ctx.mins, ctx.maxs)) {
    ctx.stuckTicks = 0;
    return false;
  }

  for (const dist of [1, 2, 4, 8, 16, 34]) {
    for (const [dx, dy, dz] of DIRS) {
      set(ctx.tmpA, ctx.origin.x + dx * dist, ctx.origin.y + dy * dist, ctx.origin.z + dz * dist);
      if (ctx.world.isPositionFree(ctx.tmpA, ctx.mins, ctx.maxs)) {
        if (ctx.stuckTicks === 0) {
          ctx.log(
            `unstuck: popped ${dist}u (${dx},${dy},${dz}) from ` +
              `(${ctx.origin.x.toFixed(1)}, ${ctx.origin.y.toFixed(1)}, ${ctx.origin.z.toFixed(1)})`,
          );
        }
        copy(ctx.origin, ctx.tmpA);
        ctx.stuckTicks = 0;
        return false;
      }
    }
  }

  if (ctx.stuckTicks % 128 === 0) {
    ctx.log(
      `STUCK: no free spot near (${ctx.origin.x.toFixed(1)}, ${ctx.origin.y.toFixed(1)}, ` +
        `${ctx.origin.z.toFixed(1)}) — velocity zeroed (press R to respawn)`,
    );
  }
  ctx.stuckTicks++;
  set(ctx.velocity, 0, 0, 0);
  return true;
}
