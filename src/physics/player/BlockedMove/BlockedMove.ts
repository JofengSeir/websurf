/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import { lengthSq, set } from '../../math/vec3.js';
import type { MovementContext } from '../MovementContext.js';

/**
 * 冻结检测：正常状态不会出现大速度而位置逐 tick 无变化——这种模式意味着物体
 * 卡在 clip 循环无法解开的几何中（平面接缝处的极端浮点对齐）。放任不管会成为
 * 失控的速度累积器（位置被钉住、重力持续被 clip 转换）。检测到即清空速度。
 */
export function detectBlockedMove(ctx: MovementContext): void {
  const speed = Math.sqrt(lengthSq(ctx.velocity));
  const moved = Math.hypot(
    ctx.origin.x - ctx.prevPos.x,
    ctx.origin.y - ctx.prevPos.y,
    ctx.origin.z - ctx.prevPos.z,
  );
  // 速度骤降校验（未归零但大幅减速）：空中 + 本 tick 有撞击接触 + 进入速度
  // >300 且降幅 >30% → 记录"卡坡减速"诊断（HUD 显示原因，如接缝多平面剪裁/
  // 夹缝转向消耗）。不归零——只是让用户可见减速来源，便于针对性修复。
  const prev = ctx.prevSpeed ?? speed;
  if (!ctx.onGround && prev > 300 && speed < prev * 0.7 && ctx.contactsThisTick.length > 0) {
    const drop = Math.round((1 - speed / prev) * 100);
    ctx.zeroCause = `slowdown-${drop}% c[${ctx.contactsThisTick.slice(0, 4).join(' ')}]`;
  }
  // "Blocked" = 真正钉死：正常滑动每 tick 移动约 speed*dt（至少一个单位），
  // 冻结状态则完全不动。连续 6 tick（约 0.1s @64Hz）才归零——放宽到 6 给
  // 贴面推开（TryPlayerMove PUSH_OUT）留出收敛时间，减少 surf 坡面误判。
  if (!ctx.onGround && speed > 150 && moved < 0.05) {
    ctx.blockedTicks++;
    if (ctx.blockedTicks >= 6) {
      ctx.log(
        `move blocked ${ctx.blockedTicks} ticks at ` +
          `(${ctx.origin.x.toFixed(2)}, ${ctx.origin.y.toFixed(2)}, ${ctx.origin.z.toFixed(2)}) ` +
          `vel (${ctx.velocity.x.toFixed(1)}, ${ctx.velocity.y.toFixed(1)}, ${ctx.velocity.z.toFixed(1)}) ` +
          `contacts [${ctx.contactsThisTick.join(' ')}] — velocity zeroed`,
      );
      ctx.zeroCause = `blocked×${ctx.blockedTicks} ${ctx.contactsThisTick.slice(0, 4).join(' ')}`;
      set(ctx.velocity, 0, 0, 0);
      ctx.blockedTicks = 0;
    }
  } else {
    ctx.blockedTicks = 0;
  }
}
