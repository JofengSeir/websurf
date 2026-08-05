/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import type { MovementContext } from '../MovementContext.js';

/**
 * Chromium 的 pointer lock 偶尔会发出一次虚假的巨大 movementX/Y（多在（重新）
 * 获取锁或焦点异常后），表现为视角"瞬移"。过滤：丢弃锁变化后的首个事件，
 * 并丢弃既大又远超出上一事件趋势的孤立尖峰。
 *
 * 返回 mousemove 处理器及其所需的 pointerlockchange 钩子（两者共享同一
 * 丢弃/基线采样状态）。
 */
export function createMouseInputHandlers(ctx: MovementContext): {
  onPointerLockChange: () => void;
  onMouseMove: (dx: number, dy: number) => void;
} {
  let discardNextMouse = true;
  let lastDx = 0;
  let lastDy = 0;

  return {
    onPointerLockChange(): void {
      discardNextMouse = true;
    },
    onMouseMove(dx: number, dy: number): void {
      if (discardNextMouse) {
        discardNextMouse = false;
        lastDx = dx;
        lastDy = dy;
        return;
      }
      const spikeX = Math.abs(dx) > 350 && Math.abs(dx) > 8 * Math.abs(lastDx) + 100;
      const spikeY = Math.abs(dy) > 350 && Math.abs(dy) > 8 * Math.abs(lastDy) + 100;
      if (spikeX || spikeY || Math.abs(dx) > 1200 || Math.abs(dy) > 1200) {
        ctx.log(`mouse snap filtered (dx ${dx}, dy ${dy})`);
        // 仍更新基线：快速但合法的转向只丢这一帧，而不是让后续每帧都拿陈旧
        // 的小基线对比而反复误触发。
        lastDx = dx;
        lastDy = dy;
        return;
      }
      lastDx = dx;
      lastDy = dy;
      const sens = ctx.settings.sensitivity * ctx.settings.mYaw;
      ctx.yaw -= dx * sens;
      ctx.pitch -= dy * sens;
      ctx.pitch = Math.max(-89, Math.min(89, ctx.pitch));
    },
  };
}
