/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

export const NON_JUMP_VELOCITY = 180; // 上升速度快于此值时不判定落地
export const GROUND_TRACE_DIST = 2; // CategorizePosition 向下追踪距离
