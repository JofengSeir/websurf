/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
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

  // "nopre": air-strafe/prestrafe gain (AirMove.ts) is left completely free —
  // this is where it gets spent instead. Ground speed is a hard ceiling at
  // the player's current max speed, full stop, the moment they're grounded
  // and moving under their own power: no "keep whatever you landed with"
  // exception. That's the point of nopre — you can still build wild speed in
  // the air for style/tech, you just can't cash it in as a permanent ground
  // sprint.
  //
  // 限速判定分两段（chasemod 行为，Source 原版语义）：
  // - 落地宽限期（groundTicksSinceLanding === 0，落地后的第一个 walkMove tick）
  //   与无输入时：按 |velocity| 硬钳 —— 空中积累的速度在落地时强制兑现为
  //   runSpeed（nopre 的本质，测试 3 语义）。
  // - 已在地面持续移动且有输入（wishspeed > 0）：按 dot(velocity, wishdir)
  //   投影钳制 —— 同向跑动仍被限制在 cap，但**地面拖拽**（wishdir 与速度
  //   有夹角，如按住 W 持续转视角）时允许速度到 cap/cosθ 的"稍微突破"
  //   （CS 原版 Accelerate 的 addspeed = wishspeed - dot 公式的固有结果，
  //   即用户要求的 chasemod ground-strafe 行为；250 限速本身未解除）。
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
