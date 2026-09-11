/**
 * 位姿：人物脚底位置 + 视角（出生点跳转 / HUD 读数 / 回放相机共用）。
 *
 * 角度换算与标定常量已上提共享层（D-08 / D-16）：本模块**re-export** 共享单点，
 * 使 viewer 内 20 余处 `from './pose.js'` / `'../core/pose.js'` 调用方零改动。
 */

import { EYE_STAND, DEG2RAD, PITCH_LIMIT } from './constants.js';
export { wrapDeg, bspYawToCsYaw } from '../../../../src/ts-shared/phys/angles.js';

/** 位姿：pos = [x,y,z] 脚底位置；ang = [yawDeg, pitchDeg]。 */
export interface Pose {
  pos: [number, number, number];
  ang: [number, number];
}

/** 度 → 弧度并做 pitch 限幅（±89°）。 */
export function pitchClampedRad(pitchDeg: number): number {
  const limit = PITCH_LIMIT / DEG2RAD;
  return Math.max(-limit, Math.min(limit, pitchDeg)) * DEG2RAD;
}

/** 相机眼高（pos 脚底 → 相机 y）。 */
export function eyeHeight(hu = EYE_STAND): number {
  return hu;
}
