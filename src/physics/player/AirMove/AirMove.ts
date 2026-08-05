/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import { length2D } from '../../math/vec3.js';
import { getRuntimePhysics } from '../../runtime.js';
import { airAccelerate } from '../../physics/AirAccelerate/AirAccelerate.js';
import { AIR_SPEED_CEILING_SOFTNESS } from '../../physics/PerfBonus/PerfBonus.config.js';
import { applyAirSpeedCeiling } from '../../physics/PerfBonus/PerfBonus.js';
import type { MovementContext } from '../MovementContext.js';
import { tryPlayerMove } from '../TryPlayerMove/TryPlayerMove.js';
import { computeWish } from '../WishDir/WishDir.js';

// noPrestrafe 不作用于本函数：空中 strafe/prestrafe 增益始终不受该设置限制。
// "nopre" 意为这些速度不能在地面"兑现"——见 WalkMove.ts。perf.enabled 则作用于
// 本函数（见下）——真实 bhop-assist chasemod 服务器限制的是空中速度本身，而非仅起跳。
export function airMove(ctx: MovementContext, dt: number): void {
  const wishspeed = computeWish(ctx);
  airAccelerate(ctx.velocity, ctx.wishDir, wishspeed, ctx.settings.airAccelerate, dt);

  const gravity = getRuntimePhysics().gravity; // 面板可调（sv_gravity）
  ctx.velocity.y -= 0.5 * gravity * dt; // 移动前先施加半重力
  tryPlayerMove(ctx, dt);
  ctx.velocity.y -= 0.5 * gravity * dt; // 移动后再施加半重力

  if (ctx.surfing) {
    // Surf 可任意提速，且本段飞行（离开斜坡后至再次真实落地前）始终成立；
    // Jump.ts 在新跳跃发起的瞬间清除该标记。
    ctx.surfedSinceGrounded = true;
  }

  // 真实 bhop-assist 服务器把空中速度本身压在 perf.maxAirSpeed 附近，而非仅限制
  // 完美连跳在起跳时恢复的值（Jump.ts）——否则连跳间的 air-strafe 增益会把观测
  // 峰值推到远超预期上限。Surf（及从它携带的速度）豁免——它是另一条物理路径，
  // 本就允许超过此值。
  if (ctx.settings.perf.enabled && !ctx.surfing && !ctx.surfedSinceGrounded) {
    const speed = length2D(ctx.velocity);
    const capped = applyAirSpeedCeiling(speed, ctx.settings.perf.maxAirSpeed, AIR_SPEED_CEILING_SOFTNESS);
    if (capped < speed) {
      const scale = capped / speed;
      ctx.velocity.x *= scale;
      ctx.velocity.z *= scale;
    }
  }
}
