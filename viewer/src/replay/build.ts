/** 帧序列 → Clip（定型数组）。主线程与解析 Worker 共用。 */

import { REPLAY_HELPERS } from './helpers.js';
import type { Clip, FrameMapper, RuleConfig } from './types.js';

export interface BuildParams {
  name: string;
  frames: unknown[];
  fn: FrameMapper;
  rule: RuleConfig;
  resolvedPath: string;
  onProgress?: (done: number, total: number) => void;
}

export interface BuildResult {
  clip: Clip;
  warnings: string[];
}

let clipSeq = 0;

/** 进度回调最小帧间隔：低于这个数就不值得上报（29 万帧约报 50 次）。 */
const PROGRESS_MIN_STEP = 4096;

/** 帧数超过这个值就提示关掉「改完自动重新导入」——每改一次都要重扫全量帧。 */
export const LARGE_CLIP_FRAMES = 100_000;

export function buildClip(params: BuildParams): BuildResult {
  const { frames, fn, rule, resolvedPath, name } = params;
  const n = frames.length;
  const warnings: string[] = [];

  const t = new Float64Array(n);
  const pos = new Float32Array(n * 3);
  const ang = new Float32Array(n * 3);
  const vel = new Float32Array(n * 3);

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let maxSpeed = 0;
  let anyVel = false;

  // 进度节流：约每 2% 报一次，且至少隔 PROGRESS_MIN_STEP 帧
  //（小文件不刷屏，29 万帧的大文件也不会卡在 0% 不动）
  const progressStep = Math.max(PROGRESS_MIN_STEP, Math.ceil(n / 50));

  let prevT = 0;
  let prevPos: [number, number, number] = [0, 0, 0];
  let prevAng: [number, number, number] = [0, 0, 0];
  let badTime = 0;
  let badNum = 0;

  for (let i = 0; i < n; i++) {
    let f;
    try {
      f = fn(frames[i], i, REPLAY_HELPERS);
    } catch (e) {
      throw new Error(
        `第 ${i} 帧映射出错：${e instanceof Error ? e.message : String(e)}\n` +
          `原始对象：${safePreview(frames[i])}`,
      );
    }

    let ft = typeof f?.t === 'number' && Number.isFinite(f.t) ? f.t : Number.NaN;
    if (!Number.isFinite(ft)) {
      ft = prevT;
      badTime++;
    } else if (ft < prevT) {
      ft = prevT; // 时间必须单调不减，否则二分查找失效
      badTime++;
    }
    t[i] = ft;
    prevT = ft;

    const p = finite3(f?.pos);
    if (p === null) {
      badNum++;
      pos[i * 3] = prevPos[0];
      pos[i * 3 + 1] = prevPos[1];
      pos[i * 3 + 2] = prevPos[2];
    } else {
      pos[i * 3] = p[0];
      pos[i * 3 + 1] = p[1];
      pos[i * 3 + 2] = p[2];
      prevPos = p;
    }

    const a = finite3(f?.ang);
    if (a === null) {
      badNum++;
      ang[i * 3] = prevAng[0];
      ang[i * 3 + 1] = prevAng[1];
      ang[i * 3 + 2] = prevAng[2];
    } else {
      ang[i * 3] = a[0];
      ang[i * 3 + 1] = a[1];
      ang[i * 3 + 2] = a[2];
      prevAng = a;
    }

    // 速度是可选字段：缺失/为 null 属正常，不计数告警
    const v = finite3(f?.vel);
    if (v) {
      anyVel = true;
      vel[i * 3] = v[0];
      vel[i * 3 + 1] = v[1];
      vel[i * 3 + 2] = v[2];
      const sp = Math.hypot(v[0], v[1], v[2]);
      if (sp > maxSpeed) maxSpeed = sp;
    }

    for (let k = 0; k < 3; k++) {
      const pv = pos[i * 3 + k];
      if (pv < min[k]) min[k] = pv;
      if (pv > max[k]) max[k] = pv;
    }

    if (params.onProgress && i % progressStep === 0) params.onProgress(i, n);
  }

  if (n === 0) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  if (badTime > 0) {
    warnings.push(`${badTime} 帧的时间无效或回退，已按上一帧时间兜底（时间轴可能不准）`);
  }
  if (badNum > 0) warnings.push(`${badNum} 帧存在 NaN/缺失数值，已沿用上一帧的值`);

  clipSeq += 1;
  const clip: Clip = {
    id: `clip-${clipSeq}`,
    name,
    count: n,
    t,
    pos,
    ang,
    vel: anyVel ? vel : null,
    duration: n > 0 ? t[n - 1] : 0,
    bbox: { min, max },
    maxSpeed,
    resolvedPath,
    rule,
  };
  return { clip, warnings };
}

/**
 * 校验「三个有限数字」。无效一律返回 null——不留兜底参数：
 * 传兜底值会让「无效」与「有效」在调用点无法区分，导致脏帧被静默吞掉、不告警。
 * 兜底由调用方显式处理并计数。
 */
function finite3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const a = Number(v[0]);
  const b = Number(v[1]);
  const c = Number(v[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null;
  return [a, b, c];
}

/** 出错时附一段原始对象摘要（截断，避免刷屏）。 */
export function safePreview(raw: unknown): string {
  try {
    const s = JSON.stringify(raw);
    if (s === undefined) return String(raw);
    return s.length > 240 ? s.slice(0, 240) + '…' : s;
  } catch {
    return String(raw);
  }
}
