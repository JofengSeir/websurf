/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import { STANDABLE_NORMAL } from '../../constants.js';
import { clone, copy, set } from '../../math/vec3.js';
import type { MovementContext } from '../MovementContext.js';
import { tryPlayerMove } from '../TryPlayerMove/TryPlayerMove.js';
import { STEP_HEIGHT } from './StepMove.config.js';

/**
 * Source 的 StepMove：先直接移动，再先抬升 18 单位再移动；
 * 保留水平位移更远的那个结果。
 */
export function stepMove(ctx: MovementContext, dt: number): void {
  const startOrigin = clone(ctx.origin);
  const startVel = clone(ctx.velocity);

  // 尝试 1：直接。
  tryPlayerMove(ctx, dt);
  const downOrigin = clone(ctx.origin);
  const downVel = clone(ctx.velocity);

  // 尝试 2：上、移、下。
  copy(ctx.origin, startOrigin);
  copy(ctx.velocity, startVel);
  let tr = ctx.world.trace(
    ctx.origin,
    set(ctx.tmpA, ctx.origin.x, ctx.origin.y + STEP_HEIGHT, ctx.origin.z),
    ctx.mins,
    ctx.maxs,
  );
  if (!tr.startSolid && !tr.allSolid) copy(ctx.origin, tr.endPos);

  tryPlayerMove(ctx, dt);

  tr = ctx.world.trace(
    ctx.origin,
    set(ctx.tmpA, ctx.origin.x, ctx.origin.y - STEP_HEIGHT, ctx.origin.z),
    ctx.mins,
    ctx.maxs,
  );
  const steppedOntoSteep = tr.fraction < 1 && tr.normal !== null && tr.normal.y < STANDABLE_NORMAL;
  if (!tr.startSolid && !tr.allSolid && !steppedOntoSteep) {
    copy(ctx.origin, tr.endPos);
  }

  if (steppedOntoSteep) {
    copy(ctx.origin, downOrigin);
    copy(ctx.velocity, downVel);
    return;
  }

  const dxUp = ctx.origin.x - startOrigin.x;
  const dzUp = ctx.origin.z - startOrigin.z;
  const dxDown = downOrigin.x - startOrigin.x;
  const dzDown = downOrigin.z - startOrigin.z;
  if (dxDown * dxDown + dzDown * dzDown > dxUp * dxUp + dzUp * dzUp) {
    copy(ctx.origin, downOrigin);
    copy(ctx.velocity, downVel);
  } else {
    // 保留抬升结果，但采用直接移动的垂直速度（同 Source）。
    ctx.velocity.y = downVel.y;
  }
}
