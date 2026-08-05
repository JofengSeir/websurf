/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import { STANDABLE_NORMAL } from '../../constants.js';
import { clone, copy, cross, dot, lengthSq, normalize, scale, addScaled, set, type Vec3 } from '../../math/vec3.js';
import { clipVelocity } from '../../physics/ClipVelocity/ClipVelocity.js';
import { OVERBOUNCE_DEFAULT, OVERBOUNCE_SURF } from '../../physics/ClipVelocity/ClipVelocity.config.js';
import type { MovementContext } from '../MovementContext.js';
import { MAX_CLIP_PLANES } from './TryPlayerMove.config.js';

function overbounceFor(normal: Vec3): number {
  // Surf 陡坡用 1.0 剪裁、完全不损失速度；其余（地面、墙、天花板）用 1.001。
  const ny = normal.y;
  return ny > 0.05 && ny < STANDABLE_NORMAL ? OVERBOUNCE_SURF : OVERBOUNCE_DEFAULT;
}

/**
 * Source 的 TryPlayerMove：扫掠，对本 tick 触及的每个平面剪裁速度
 * （折角沿共享边滑动），最多重复 4 次 bump。
 */
export function tryPlayerMove(ctx: MovementContext, dt: number): void {
  let timeLeft = dt;
  const planes: Vec3[] = [];
  const originalVel = clone(ctx.velocity);
  const primalVel = clone(ctx.velocity);
  ctx.surfing = false;

  for (let bump = 0; bump < 4; bump++) {
    if (lengthSq(ctx.velocity) === 0) break;

    addScaled(ctx.moveEnd, ctx.origin, ctx.velocity, timeLeft);
    const tr = ctx.world.trace(ctx.origin, ctx.moveEnd, ctx.mins, ctx.maxs);

    if (tr.allSolid) {
      ctx.log('tryPlayerMove: allSolid — velocity zeroed');
      set(ctx.velocity, 0, 0, 0);
      return;
    }
    if (tr.fraction > 0) {
      copy(ctx.origin, tr.endPos);
      copy(originalVel, ctx.velocity);
      planes.length = 0;
    }
    if (tr.fraction === 1) break;

    const n = tr.normal!;
    ctx.contactsThisTick.push(`${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}@${tr.fraction.toFixed(2)}`);

    timeLeft -= timeLeft * tr.fraction;

    if (planes.length >= MAX_CLIP_PLANES) {
      ctx.log('tryPlayerMove: exceeded MAX_CLIP_PLANES — velocity zeroed');
      set(ctx.velocity, 0, 0, 0);
      return;
    }
    // 零比例 bump 会重复上报已贴靠的平面；累积重复会使折角回退算出 cross(n, n) = 0
    // 而清零全部速度（斜坡"粘住"）。
    if (!planes.some((p) => dot(p, tr.normal!) > 0.99)) {
      planes.push(clone(tr.normal!));
    }
    if (tr.normal!.y > 0.05 && tr.normal!.y < STANDABLE_NORMAL) ctx.surfing = true;

    // 找出一种不重新进入任何平面的原速度剪裁。
    let i = 0;
    for (; i < planes.length; i++) {
      copy(ctx.velocity, originalVel);
      clipVelocity(ctx.velocity, planes[i], overbounceFor(planes[i]));
      let ok = true;
      for (let j = 0; j < planes.length; j++) {
        if (j !== i && dot(ctx.velocity, planes[j]) < 0) {
          ok = false;
          break;
        }
      }
      if (ok) break;
    }

    if (i === planes.length) {
      // 单平面剪裁均无效——沿前两个平面的交线滑动。
      if (planes.length !== 2) {
        ctx.log(`tryPlayerMove: cornered by ${planes.length} planes — velocity zeroed`);
        set(ctx.velocity, 0, 0, 0);
        return;
      }
      cross(ctx.tmpB, planes[0], planes[1]);
      const creaseLen = normalize(ctx.tmpB);
      if (creaseLen < 1e-6) {
        // 退化（近平行平面）：回退为单平面剪裁而非清零移动。
        ctx.log('tryPlayerMove: degenerate crease — single-plane fallback');
        copy(ctx.velocity, originalVel);
        clipVelocity(ctx.velocity, planes[0], overbounceFor(planes[0]));
      } else {
        scale(ctx.velocity, ctx.tmpB, dot(ctx.tmpB, ctx.velocity));
      }
    }

    // 若被反弹回原方向，立即停死（防止在角落振荡）。
    if (dot(ctx.velocity, primalVel) <= 0) {
      set(ctx.velocity, 0, 0, 0);
      return;
    }
  }
}
