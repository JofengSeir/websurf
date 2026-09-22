/**
 * Clip 采样（纯函数，无状态）。
 *
 * 独立成模块是为了让两个消费方共用同一份实现：`apps/viewer/src/replay/tracks.ts` 取 sampleClip，
 * `apps/viewer/src/replay/player.ts` 取 indexInClip / sampleClip / horizontalSpeed。而 player.ts
 * 本身已 import tracks.ts，采样函数若放进其一，另一方就得反向 import。
 */

import type { Clip, Sample } from './types.js';

/** 角度插值：按 360 取模走最短弧（`(b − a + 540) % 360 − 180`），再按 t 取份额；yaw 与 roll 用
 *  （359° → 1° 得 +2°）。注意 JS 的 `%` 保留被除数符号：`b − a < −540` 时结果 < −180 即越出
 *  [−180, 180)，本函数不钳制。 */
export function lerpAngle(a: number, b: number, t: number): number {
  const diff = (((b - a + 540) % 360) - 180) * t;
  return a + diff;
}

/** 线性插值：t = 0 得 a、t = 1 得 b；不钳制 t。 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 时间 → 帧下标（插值左端）：返回满足 clip.t[i] ≤ t 的最大 i；t 早于首帧得 0，晚于末帧得 n − 1。
 * 用二分的前提是 clip.t 单调不减——.replay 路径由 t(i) = (i − preFrames) / tickrate（tickrate > 0）保证。
 * count = 0 时返回 0。
 */
export function indexInClip(clip: Clip, t: number): number {
  const n = clip.count;
  if (n === 0) return 0;
  const arr = clip.t;
  if (t <= arr[0]) return 0;
  if (t >= arr[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 取 clip 在内部时间 t（秒，相对该 clip 片头）的插值位姿。
 * 采样区间取 [i, i + 1]（i = indexInClip），插值系数夹在 [0, 1]；时间段长为 0（末帧或重复时间戳）时
 * 系数取 0，直接返回第 i 帧的值。yaw 与 roll 走最短弧插值，pitch 与 pos 走线性插值；clip.vel 存在时
 * 同样线性插值，否则 Sample.vel 为 null。count = 0 时返回 null；Sample.index 为左端帧号 i。
 */
export function sampleClip(clip: Clip, t: number): Sample | null {
  const n = clip.count;
  if (n === 0) return null;
  const i = indexInClip(clip, t);
  const j = Math.min(i + 1, n - 1);
  const t0 = clip.t[i];
  const t1 = clip.t[j];
  const span = t1 - t0;
  const a = span > 1e-9 && j > i ? Math.max(0, Math.min(1, (t - t0) / span)) : 0;

  const p = clip.pos;
  const g = clip.ang;
  const pos: [number, number, number] = [
    lerp(p[i * 3], p[j * 3], a),
    lerp(p[i * 3 + 1], p[j * 3 + 1], a),
    lerp(p[i * 3 + 2], p[j * 3 + 2], a),
  ];
  const ang: [number, number, number] = [
    lerpAngle(g[i * 3], g[j * 3], a),
    lerp(g[i * 3 + 1], g[j * 3 + 1], a),
    lerpAngle(g[i * 3 + 2], g[j * 3 + 2], a),
  ];

  let vel: [number, number, number] | null = null;
  if (clip.vel) {
    const v = clip.vel;
    vel = [
      lerp(v[i * 3], v[j * 3], a),
      lerp(v[i * 3 + 1], v[j * 3 + 1], a),
      lerp(v[i * 3 + 2], v[j * 3 + 2], a),
    ];
  }
  return { pos, ang, vel, index: i };
}

/** 水平速度（HU/s）：Y-up 下取 vel 的 X、Z 分量求模；vel 为 null 时返回 null。 */
export function horizontalSpeed(s: Sample | null): number | null {
  if (!s?.vel) return null;
  return Math.hypot(s.vel[0], s.vel[2]);
}
