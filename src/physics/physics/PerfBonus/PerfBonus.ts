/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.


/**
 * 将超过 `ceiling` 的速度渐近压缩回 ceiling——超出越多增益越少，
 * 是递减收益而非硬钳制。速度不高于 `ceiling` 时原样返回；`softness` 控制曲线
 * 逼近上限的渐进程度（真实渐近线在其上方 `softness` 处——刻意如此，
 * 精确硬钳制就等同 `bhopSpeedClamp` 了）。
 */
export function applyAirSpeedCeiling(speed: number, ceiling: number, softness: number): number {
  if (speed <= ceiling) return speed;
  const excess = speed - ceiling;
  return ceiling + softness * (1 - Math.exp(-excess / softness));
}
