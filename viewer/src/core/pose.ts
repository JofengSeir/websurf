/** 位姿：人物脚底位置 + 视角（出生点跳转 / HUD 读数 / 回放相机共用）。 */

import { DEG2RAD, EYE_STAND, PITCH_LIMIT } from './constants.js';

/** 位姿：pos = [x,y,z] 脚底位置；ang = [yawDeg, pitchDeg]。 */
export interface Pose {
  pos: [number, number, number];
  ang: [number, number];
}

/** BSP 方位角 yaw（顺时针）→ viewer yaw（逆时针，与 ts-shared bspYawToCsYaw 一致）。 */
export function bspYawToCsYaw(bspYaw: number): number {
  return (((270 - bspYaw) % 360) + 360) % 360;
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
