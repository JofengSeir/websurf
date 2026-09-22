/**
 * 录像域角度工具（纯函数，无副作用）：角度归一与 pitch 限幅的统一出口。
 * 消费方：`apps/viewer/src/replay/shavit-replay.ts` 取 clampPitch 与 wrapDeg，
 * `apps/viewer/src/replay/build.ts` 取 wrapDeg，`apps/viewer/test/replay-selftest.ts` 两者都取。
 */

import { PITCH_LIMIT_DEG } from '../core/constants.js';

/** 角度归一到 [0, 360)：实现在 `src/ts-shared/phys/angles.ts` 的 wrapDeg，经 `apps/viewer/src/core/pose.ts` 转发到此。 */
export { wrapDeg } from '../core/pose.js';

/** pitch 限幅到 ±PITCH_LIMIT_DEG（89°）；非有限值（NaN、±Inf）返回 0。 */
export function clampPitch(d: number): number {
  if (!Number.isFinite(d)) return 0;
  return Math.max(-PITCH_LIMIT_DEG, Math.min(PITCH_LIMIT_DEG, d));
}
