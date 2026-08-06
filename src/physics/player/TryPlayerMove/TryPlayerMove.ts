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
import { MAX_CLIP_PLANES, PUSH_OUT } from './TryPlayerMove.config.js';

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
      ctx.zeroCause = `allSolid @(${ctx.origin.x.toFixed(0)},${ctx.origin.y.toFixed(0)},${ctx.origin.z.toFixed(0)})`;
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

    // 夹缝检测：planes 中已有平面与当前法线相对（dot < -0.5，即 V 形槽/墙缝）。
    // 夹缝中 PUSH_OUT 推开会来回撞墙（撞 A 推向 B → 撞 B 推回 A → 前后都卡死）；
    // 正确行为 = 沿两平面交线滑出夹缝，且不推开、不做单平面剪裁。
    const wedgePlane = planes.find((p) => dot(p, n) < -0.5);
    if (wedgePlane) {
      cross(ctx.tmpB, n, wedgePlane);
      const wedgeLen = normalize(ctx.tmpB);
      if (wedgeLen > 1e-6) {
        // 沿交线方向滑动（缝的方向，方向稳定）
        scale(ctx.velocity, ctx.tmpB, dot(ctx.tmpB, ctx.velocity));
      } else {
        // 退化（近平行相对面）：沿当前平面切向
        const backoff = dot(ctx.velocity, n);
        ctx.velocity.x -= n.x * backoff;
        ctx.velocity.y -= n.y * backoff;
        ctx.velocity.z -= n.z * backoff;
      }
      timeLeft -= timeLeft * tr.fraction;
      // 不推开、不累积平面——下一 bump 沿缝继续滑出
      continue;
    }

    // 撞击后沿法线推开（贴面解死锁）：surf 滑行时 AABB 表面停在距坡面
    // DIST_EPSILON 处，重力每 tick 注入垂直分量 → fraction≈0 微撞击 →
    // origin 不更新（moved≈0）→ blocked×3 误判归零。推开 PUSH_OUT 使
    // 下一 tick 有正常"进入距离"，切向滑行不再被 fraction≈0 吞掉。
    // fraction=0 时 origin 未更新（仍为起点），推开同样使其脱离贴面。
    ctx.origin.x += n.x * PUSH_OUT;
    ctx.origin.y += n.y * PUSH_OUT;
    ctx.origin.z += n.z * PUSH_OUT;

    timeLeft -= timeLeft * tr.fraction;

    if (planes.length >= MAX_CLIP_PLANES) {
      ctx.log('tryPlayerMove: exceeded MAX_CLIP_PLANES — velocity zeroed');
      ctx.zeroCause = `planes≥${MAX_CLIP_PLANES}(${planes.length})`;
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
      // 单平面剪裁均无效——优先用所有平面的平均法线剪裁（密集接缝区的
      // 法线分布接近平滑曲面，平均法线等效"接缝平滑"，避免 ≥3 平面围角
      // 直接归零）；平均法线仍进入某平面时回退：2 平面沿交线滑动，≥3 归零。
      let avgOk = false;
      if (planes.length >= 3) {
        set(ctx.tmpA, 0, 0, 0);
        for (const p of planes) {
          ctx.tmpA.x += p.x;
          ctx.tmpA.y += p.y;
          ctx.tmpA.z += p.z;
        }
        const avgLen = Math.sqrt(
          ctx.tmpA.x * ctx.tmpA.x + ctx.tmpA.y * ctx.tmpA.y + ctx.tmpA.z * ctx.tmpA.z,
        );
        if (avgLen > 1e-6) {
          set(ctx.tmpB, ctx.tmpA.x / avgLen, ctx.tmpA.y / avgLen, ctx.tmpA.z / avgLen);
          copy(ctx.velocity, originalVel);
          clipVelocity(ctx.velocity, ctx.tmpB, overbounceFor(ctx.tmpB));
          avgOk = planes.every((p) => dot(ctx.velocity, p) >= 0);
        }
      }
      if (!avgOk) {
        if (planes.length !== 2) {
          ctx.log(`tryPlayerMove: cornered by ${planes.length} planes — velocity zeroed`);
          ctx.zeroCause = `cornered×${planes.length} n(${planes
            .map((p) => `${p.y.toFixed(1)}`)
            .join(',')})`;
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
    }

    // 若被反弹回原方向：不整体归零——保留沿接缝/平面的滑动速度。
    // （原实现直接停死：surf 坡面"垂直转横线"折角带法线大角度变化时，
    //   剪裁后速度反向即被判定为振荡而清零，高速滑行在接缝处直接卡死。
    //   多平面时沿前两平面交线滑动（方向稳定），单平面时沿其切向。）
    if (dot(ctx.velocity, primalVel) <= 0) {
      if (planes.length >= 2) {
        // 折角：沿共享边（交线）滑动，方向稳定且不消耗速度
        cross(ctx.tmpB, planes[0], planes[1]);
        const creaseLen = normalize(ctx.tmpB);
        if (creaseLen > 1e-6) {
          scale(ctx.velocity, ctx.tmpB, dot(ctx.tmpB, ctx.velocity));
        } else {
          // 近平行退化：沿最后平面切向
          const last = planes[planes.length - 1];
          const backoff = dot(ctx.velocity, last);
          ctx.velocity.x -= last.x * backoff;
          ctx.velocity.y -= last.y * backoff;
          ctx.velocity.z -= last.z * backoff;
        }
      } else {
        const last = planes[planes.length - 1];
        if (last) {
          const backoff = dot(ctx.velocity, last);
          ctx.velocity.x -= last.x * backoff;
          ctx.velocity.y -= last.y * backoff;
          ctx.velocity.z -= last.z * backoff;
        }
      }
      return;
    }
  }
}
