/** 位姿：人物脚底位置 + 视角（出生点跳转 / HUD 读数 / 回放相机共用）。 */

import { DEG2RAD, EYE_STAND, PITCH_LIMIT } from './constants.js';

/** 位姿：pos = [x,y,z] 脚底位置；ang = [yawDeg, pitchDeg]。 */
export interface Pose {
  pos: [number, number, number];
  ang: [number, number];
}

/** 角度归一到 [0,360)。单点实现在此；replay/helpers 从本模块转发导出（两条路径共用）。 */
export function wrapDeg(d: number): number {
  return (((d % 360) + 360) % 360) || 0;
}

/**
 * BSP 出生点实体 Source yaw → viewer yaw：wrap(src + 180)。
 * 与 .replay 帧解码同一定标（shavit-replay.ts 实测定标：facing·motion cos=0.9992；
 * 本轴映射 [x,y,z]→[y,z,x]（det=+1）下 Source 前向 (cos yaw, sin yaw) → viewer
 * (sin yaw, cos yaw)，恒等式即 +180）。旧式 (270 − yaw) 是 det=−1 镜像映射
 * （surf_null primary spawn Source yaw=180 → 应为 0°，旧式给 90°），已废弃。
 */
export function bspYawToCsYaw(bspYaw: number): number {
  return wrapDeg(bspYaw + 180);
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
