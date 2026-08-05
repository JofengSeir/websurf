/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import { length2D, lengthSq, set } from '../../math/vec3.js';
import { getRuntimePhysics } from '../../runtime.js';
import { accelerate } from '../../physics/Accelerate/Accelerate.js';
import { applyFriction } from '../../physics/Friction/Friction.js';
import { currentMaxSpeed } from '../CurrentMaxSpeed/CurrentMaxSpeed.js';
import type { MovementContext } from '../MovementContext.js';
import { stayOnGround } from '../StayOnGround/StayOnGround.js';
import { stepMove } from '../StepMove/StepMove.js';
import { computeWish } from '../WishDir/WishDir.js';

export function walkMove(ctx: MovementContext, dt: number): void {
  // 面板可调（sv_accelerate / sv_friction / sv_stopspeed）
  const { accelerate: accel, friction, stopSpeed } = getRuntimePhysics();
  ctx.velocity.y = 0;
  applyFriction(ctx.velocity, friction, stopSpeed, dt);

  const wishspeed = computeWish(ctx);
  accelerate(ctx.velocity, ctx.wishDir, wishspeed, accel, dt);
  ctx.velocity.y = 0;

  // "nopre"：空中 strafe/prestrafe 增益（AirMove.ts）完全自由——在这里被花掉。
  // 一旦落地并自主移动，地速被硬性钳制在当前最大速度，没有"保留落地速度"的
  // 例外。这就是 nopre 的意义——空中仍可攒速度秀操作，只是不能兑现成永久地速。
  //
  // 限速分两段（chasemod 行为，Source 原版语义）：
  // - 落地首个 walkMove tick（groundTicksSinceLanding === 0）与无输入时：
  //   按 |velocity| 硬钳——空中积累的速度落地时强制兑现为 runSpeed
  //   （nopre 的本质，测试 3 语义）。
  // - 已在地面持续移动且有输入（wishspeed > 0）：按 dot(velocity, wishdir)
  //   投影钳制——同向跑动被限制在 cap，但**地面拖拽**（wishdir 与速度有夹角，
  //   如按住 W 持续转视角）允许速度到 cap/cosθ 的"轻微突破"（CS 原版
  //   addspeed = wishspeed - dot 公式的固有结果，即用户要求的 chasemod
  //   ground-strafe 行为；250 上限本身未解除）。
  if (ctx.settings.noPrestrafe) {
    const cap = currentMaxSpeed(ctx);
    if (wishspeed > 0 && ctx.groundTicksSinceLanding > 0) {
      // wishDir 已归一化（computeWish），投影 = |v|·cosθ
      const proj = ctx.velocity.x * ctx.wishDir.x + ctx.velocity.z * ctx.wishDir.z;
      if (proj > cap) {
        const scale = cap / proj;
        ctx.velocity.x *= scale;
        ctx.velocity.z *= scale;
      }
    } else {
      const speed = length2D(ctx.velocity);
      if (speed > cap) {
        const scale = cap / speed;
        ctx.velocity.x *= scale;
        ctx.velocity.z *= scale;
      }
    }
  }

  if (lengthSq(ctx.velocity) < 1e-6) {
    set(ctx.velocity, 0, 0, 0);
    return;
  }

  stepMove(ctx, dt);
  stayOnGround(ctx);
}
