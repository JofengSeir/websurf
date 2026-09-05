/** 位姿：人物脚底位置 + 视角。三通道（URL 参数 / hash / JS API）共用这里的类型与解析。 */

import { DEG2RAD, EYE_STAND, PITCH_LIMIT } from './constants.js';

/** 位姿：pos = [x,y,z] 脚底位置；ang = [yawDeg, pitchDeg]。 */
export interface Pose {
  pos: [number, number, number];
  ang: [number, number];
}

/** 兼容对象形式（外部工具常用）：{ pos: {x,y,z}, ang: {yaw,pitch} }。 */
export interface PoseLike {
  pos: [number, number, number] | { x: number; y: number; z: number };
  ang: [number, number] | { yaw: number; pitch: number };
}

export function normalizePose(input: PoseLike): Pose {
  const pos = Array.isArray(input.pos)
    ? [input.pos[0], input.pos[1], input.pos[2]]
    : [input.pos.x, input.pos.y, input.pos.z];
  const ang = Array.isArray(input.ang)
    ? [input.ang[0], input.ang[1]]
    : [input.ang.yaw, input.ang.pitch];
  return { pos: [pos[0], pos[1], pos[2]], ang: [ang[0], ang[1]] };
}

/** 从 URLSearchParams 解析 `pos=x,y,z&ang=yaw,pitch`（分隔符支持逗号/空白）。 */
export function parsePoseParams(params: URLSearchParams): Pose | null {
  const posRaw = params.get('pos');
  const angRaw = params.get('ang');
  if (!posRaw || !angRaw) return null;
  const toNums = (s: string): number[] =>
    s
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  const pos = toNums(posRaw);
  const ang = toNums(angRaw);
  if (pos.length !== 3 || ang.length !== 2) return null;
  return { pos: [pos[0], pos[1], pos[2]], ang: [ang[0], ang[1]] };
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
