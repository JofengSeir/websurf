/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import { set, vec3 } from '../../math/vec3.js';
import type { MovementContext } from '../MovementContext.js';
import { HULL_DUCK_HEIGHT, HULL_HALF_WIDTH, HULL_STAND_HEIGHT } from './Duck.config.js';

/**
 * @deprecated 碰撞箱已参数化（PlayerController.hull）。以下模块级常量仅保留兼容
 * 导出；运行时体型一律从 `ctx.standMins/standMaxs/duckMins/duckMaxs` 读取
 * （由 PlayerController.setHull 派生），勿再直接引用。
 */
export const STAND_MINS = vec3(-HULL_HALF_WIDTH, 0, -HULL_HALF_WIDTH);
export const STAND_MAXS = vec3(HULL_HALF_WIDTH, HULL_STAND_HEIGHT, HULL_HALF_WIDTH);
export const DUCK_MINS = vec3(-HULL_HALF_WIDTH, 0, -HULL_HALF_WIDTH);
export const DUCK_MAXS = vec3(HULL_HALF_WIDTH, HULL_DUCK_HEIGHT, HULL_HALF_WIDTH);

function tryUnduck(ctx: MovementContext): void {
  if (ctx.onGround) {
    if (ctx.world.isPositionFree(ctx.origin, ctx.standMins, ctx.standMaxs)) {
      ctx.ducked = false;
    }
    return;
  }
  // 空中：有空间则放下双脚，否则原地站立。
  const delta = ctx.standMaxs.y - ctx.duckMaxs.y;
  set(ctx.tmpA, ctx.origin.x, ctx.origin.y - delta, ctx.origin.z);
  if (ctx.world.isPositionFree(ctx.tmpA, ctx.standMins, ctx.standMaxs)) {
    ctx.origin.y -= delta;
    ctx.ducked = false;
  } else if (ctx.world.isPositionFree(ctx.origin, ctx.standMins, ctx.standMaxs)) {
    ctx.ducked = false;
  }
}

export function updateDuck(ctx: MovementContext): void {
  const want = ctx.input.duck;
  if (want && !ctx.ducked) {
    ctx.ducked = true;
    if (!ctx.onGround) {
      // 空中蹲下把脚收起、头部不动（可蹲上平台边缘，同 CS）。
      const delta = ctx.standMaxs.y - ctx.duckMaxs.y;
      set(ctx.tmpA, ctx.origin.x, ctx.origin.y + delta, ctx.origin.z);
      if (ctx.world.isPositionFree(ctx.tmpA, ctx.duckMins, ctx.duckMaxs)) {
        ctx.origin.y += delta;
      }
    }
  } else if (!want && ctx.ducked) {
    tryUnduck(ctx);
  }
}