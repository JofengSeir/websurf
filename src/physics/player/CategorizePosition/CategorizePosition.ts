/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import { STANDABLE_NORMAL } from '../../constants.js';
import { copy, set } from '../../math/vec3.js';
import { addStamina } from '../../physics/Stamina/Stamina.js';
import type { MovementContext } from '../MovementContext.js';
import { GROUND_TRACE_DIST, NON_JUMP_VELOCITY } from './CategorizePosition.config.js';

function setNotGrounded(ctx: MovementContext): void {
  ctx.onGround = false;
}

export function categorizePosition(ctx: MovementContext): void {
  // 上升速度快于此值，不可能"站"在任何物体上。
  if (ctx.velocity.y > NON_JUMP_VELOCITY) {
    setNotGrounded(ctx);
    return;
  }

  const tr = ctx.world.trace(
    ctx.origin,
    set(ctx.tmpA, ctx.origin.x, ctx.origin.y - GROUND_TRACE_DIST, ctx.origin.z),
    ctx.mins,
    ctx.maxs,
  );

  if (tr.fraction < 1 && !tr.startSolid && tr.normal !== null && tr.normal.y >= STANDABLE_NORMAL) {
    const wasAirborne = !ctx.onGround;
    ctx.onGround = true;
    copy(ctx.groundNormal, tr.normal);
    copy(ctx.origin, tr.endPos);
    if (wasAirborne) {
      ctx.groundTicksSinceLanding = 0;
      // 本 tick 只有 y 被地面法线裁剪，x/z 仍保留落地时的实际速度。现在快照它，
      // 赶在 walkMove 的摩擦消耗之前，让完美重跳有真实速度可继承（见 PerfBonus）。
      set(ctx.landingVelocity, ctx.velocity.x, ctx.velocity.y, ctx.velocity.z);
      if (ctx.settings.stamina.enabled) {
        ctx.stamina = addStamina(ctx.stamina, ctx.settings.stamina.landCost, ctx.settings.stamina.max);
      }
      if (ctx.settings.viewPunch && ctx.fallVelocity > 250) {
        ctx.landPunch = Math.min((ctx.fallVelocity - 250) * 0.012, 10);
      }
    }
    ctx.fallVelocity = 0;
  } else {
    setNotGrounded(ctx);
  }
}
