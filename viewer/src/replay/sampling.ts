/**
 * Clip 采样（纯函数，无状态）。
 *
 * 单独成模块是为了让 TrackSet 与 ReplayPlayer 都能用它而不互相 import——
 * 播放器持有轨道集、轨道集需要采样，直接互引会成环。
 */

import type { Clip, Sample } from './types.js';

/** 角度最短弧插值（yaw/roll 用，避免 359°→1° 时绕远路）。 */
export function lerpAngle(a: number, b: number, t: number): number {
  const diff = (((b - a + 540) % 360) - 180) * t;
  return a + diff;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 时间 → 帧序号（插值左端）。t 超出范围会被夹到首尾帧。
 * clip.t 单调不减（buildClip 保证），所以可以二分。
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

/** 取 clip 在内部时间 t（秒，相对该 clip 片头）的插值位姿。 */
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

/** 水平速度（HU/s）；无速度数据返回 null。 */
export function horizontalSpeed(s: Sample | null): number | null {
  if (!s?.vel) return null;
  return Math.hypot(s.vel[0], s.vel[2]);
}
