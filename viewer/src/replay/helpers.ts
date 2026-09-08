/**
 * 录像域公共角度工具（纯函数，无副作用）。
 * （t4：JSON 时代的脚本辅助函数集合已随 JSON 解析通道移除。）
 */

import { PITCH_LIMIT_DEG } from '../core/constants.js';

/** 角度归一到 [0,360)。 */
export function wrapDeg(d: number): number {
  return (((d % 360) + 360) % 360) || 0;
}

/** pitch 限幅 ±89°。 */
export function clampPitch(d: number): number {
  if (!Number.isFinite(d)) return 0;
  return Math.max(-PITCH_LIMIT_DEG, Math.min(PITCH_LIMIT_DEG, d));
}
