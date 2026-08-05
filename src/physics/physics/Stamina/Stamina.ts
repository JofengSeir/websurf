/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.


/** 累加耐力消耗（跳跃或落地），钳制到池上限。 */
export function addStamina(current: number, cost: number, max: number): number {
  return Math.min(max, current + cost);
}

/** 按 `recoveryRate`（每秒占 max 的比例）向 0 恢复耐力。 */
export function recoverStamina(current: number, recoveryRate: number, max: number, dt: number): number {
  return Math.max(0, current - recoveryRate * max * dt);
}

/** 满耐力池对最大速度/起跳速度的抑制：空池 1.0，满池降至 `1 - maxPenalty`。 */
export function staminaPenaltyMultiplier(current: number, max: number, maxPenalty: number): number {
  if (max <= 0) return 1;
  const frac = Math.min(1, current / max);
  return 1 - frac * maxPenalty;
}
