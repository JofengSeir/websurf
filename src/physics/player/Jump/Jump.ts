/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import { addStamina, staminaPenaltyMultiplier } from '../../physics/Stamina/Stamina.js';
import { currentMaxSpeed } from '../CurrentMaxSpeed/CurrentMaxSpeed.js';
import type { MovementContext } from '../MovementContext.js';
import { BHOP_MAX_SPEED_FACTOR, getJumpVelocity } from './Jump.config.js';

export function checkJump(ctx: MovementContext): void {
  if (!ctx.onGround) return;
  if (!ctx.input.jump) return;
  // 原版行为：必须在落地时按下——空中按住跳跃落地无效。Autobhop 跳过该检查。
  if (!ctx.settings.autobhop && ctx.oldJump) return;

  // sv_enablebunnyhopping 0：起跳速度钳制为 1.1 × maxspeed（Source 的
  // PreventBunnyJumping），连跳不叠加速度。完美连跳继承（下）可恢复更多，
  // 其余情况——迟重跳、autobhop、surf 落地——都保持此钳制值。
  if (ctx.settings.bhopSpeedClamp) {
    const maxScaled = currentMaxSpeed(ctx) * BHOP_MAX_SPEED_FACTOR;
    const speed = ctx.horizontalSpeed;
    if (speed > maxScaled) {
      const fraction = maxScaled / speed;
      ctx.velocity.x *= fraction;
      ctx.velocity.z *= fraction;
    }
  }

  if (ctx.settings.perf.enabled) {
    // "完美连跳" = 真实、技能时机的即时重跳：仅手动输入（autobhop 不能有技能
    // 时机——它总是尽量立即重发，所以永远不达标）、落地后下一 tick、且落地
    // 非来自 surf（surf 速度不能这样"兑现"）。其它情况无任何继承——近失不给折扣。
    const isPerfectBhop =
      !ctx.settings.autobhop &&
      ctx.hasJumpedBefore &&
      !ctx.surfedSinceGrounded &&
      ctx.groundTicksSinceLanding === 0;
    if (isPerfectBhop) {
      ctx.velocity.x = ctx.landingVelocity.x;
      ctx.velocity.z = ctx.landingVelocity.z;
      ctx.lastHopQuality = 'perfect';
    } else {
      ctx.lastHopQuality = 'normal';
    }
  }

  // 面板可调（jumpHeight/gravity → 动态推导起跳速度）
  let jumpVelocity = getJumpVelocity();
  if (ctx.settings.stamina.enabled) {
    jumpVelocity *= staminaPenaltyMultiplier(ctx.stamina, ctx.settings.stamina.max, ctx.settings.stamina.maxPenalty);
    ctx.stamina = addStamina(ctx.stamina, ctx.settings.stamina.jumpCost, ctx.settings.stamina.max);
  }
  ctx.velocity.y = jumpVelocity;
  ctx.onGround = false;
  ctx.hasJumpedBefore = true;
  // 无论如何都是全新飞行——本次起跳前的任何 surf 接触与之后无关。
  ctx.surfedSinceGrounded = false;
}
