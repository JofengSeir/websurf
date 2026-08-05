/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import { cross, dot, length, normalize, scale, set, vec3 } from '../../math/vec3.js';
import type { LadderVolume } from '../../physics/Collision/Collision.types.js';
import { DEG2RAD, type MovementContext } from '../MovementContext.js';
import { tryPlayerMove } from '../TryPlayerMove/TryPlayerMove.js';
import { LADDER_JUMP_OFF_SPEED, LADDER_SPEED } from './Ladder.config.js';

export function checkLadder(ctx: MovementContext): LadderVolume | null {
  if (ctx.ladderCooldown > 0) return null;
  const ladder = ctx.world.ladderAt(ctx.origin, ctx.mins, ctx.maxs);
  if (!ladder) return null;
  if (ctx.onLadder) return ladder; // 已在梯上——保持

  // 仅在空中、或主动走向梯子时抓住。
  if (!ctx.onGround) return ladder;
  const yawRad = ctx.yaw * DEG2RAD;
  const facingDot = -Math.sin(yawRad) * -ladder.facing.x + -Math.cos(yawRad) * -ladder.facing.z;
  if (ctx.input.forward && facingDot > 0.3) return ladder;
  return null;
}

export function ladderMove(ctx: MovementContext, dt: number, ladder: LadderVolume): void {
  ctx.onLadder = ladder;
  ctx.onGround = false;
  ctx.fallVelocity = 0;

  // 跳离：推离梯面。
  if (ctx.input.jump && !ctx.oldJump) {
    scale(ctx.velocity, ladder.facing, LADDER_JUMP_OFF_SPEED);
    ctx.ladderCooldown = 0.25;
    ctx.onLadder = null;
    tryPlayerMove(ctx, dt);
    return;
  }

  const fmove = (ctx.input.forward ? 1 : 0) - (ctx.input.back ? 1 : 0);
  const smove = (ctx.input.right ? 1 : 0) - (ctx.input.left ? 1 : 0);

  // 完整 3D 视角基——仰视 + 前进向上爬，俯视下降。
  const yawRad = ctx.yaw * DEG2RAD;
  const pitchRad = ctx.pitch * DEG2RAD;
  const cp = Math.cos(pitchRad);
  const fwd = set(ctx.tmpA, -Math.sin(yawRad) * cp, Math.sin(pitchRad), -Math.cos(yawRad) * cp);
  const right = set(ctx.tmpB, Math.cos(yawRad), 0, -Math.sin(yawRad));

  // 每个输入轴贡献其完整的攀爬速度——刻意不归一化，同 Source。这正是 CS:GO
  // fastclimb 的原理：斜对梯子按 W+横移会叠加两轴贡献，约 1.41 倍攀爬速度。
  const wish = ctx.wishDir;
  set(
    wish,
    (fwd.x * fmove + right.x * smove) * LADDER_SPEED,
    (fwd.y * fmove + right.y * smove) * LADDER_SPEED,
    (fwd.z * fmove + right.z * smove) * LADDER_SPEED,
  );
  const wlen = length(wish);
  if (wlen === 0) {
    set(ctx.velocity, 0, 0, 0);
    return;
  }
  // 限制在真实 fastclimb 上限（√2 × 攀爬速度）。
  const maxWish = LADDER_SPEED * Math.SQRT2;
  if (wlen > maxWish) scale(wish, wish, maxWish / wlen);

  // 将 wish 拆分为沿梯面横向与垂直墙面两部分；垂直部分重定向到攀爬方向。
  const n = ladder.facing;
  const normalVel = dot(wish, n);
  const lateral = set(ctx.tmpA, wish.x - n.x * normalVel, wish.y - n.y * normalVel, wish.z - n.z * normalVel);

  const up = set(ctx.tmpB, 0, 1, 0);
  const along = cross(vec3(), n, up); // 水平、沿墙方向
  const climbDir = cross(vec3(), along, n); // 垂直于梯面向上
  normalize(climbDir);

  set(
    ctx.velocity,
    lateral.x + climbDir.x * -normalVel,
    lateral.y + climbDir.y * -normalVel,
    lateral.z + climbDir.z * -normalVel,
  );

  tryPlayerMove(ctx, dt);
}
