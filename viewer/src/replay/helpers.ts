/**
 * 规则脚本的辅助函数集合（H）。主线程与解析 Worker 各自持有一份（纯函数，无副作用）。
 * 脚本里能用到的全部能力都在这里——保证「UI 生成的脚本」与「手写的脚本」能力对等。
 */

import { EYE_STAND, PITCH_LIMIT_DEG } from '../core/constants.js';

/** 路径分词：`a.b[0].c` → ['a','b',0,'c']；也支持 `a.0`。 */
function tokenize(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /\[(-?\d+)\]|([^.[\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) out.push(Number(m[1]));
    else if (m[2] !== undefined) out.push(m[2]);
  }
  return out;
}

/** 按路径取值；取不到返回 undefined（不抛异常）。 */
export function getPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  const tokens = tokenize(path);
  if (tokens.length === 0) return undefined;
  let cur: unknown = root;
  for (const tk of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof tk === 'number') {
      if (Array.isArray(cur)) cur = cur[tk];
      else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[String(tk)];
      else return undefined;
    } else {
      if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[tk];
      else return undefined;
    }
  }
  return cur;
}

/** 转数字；不可转返回 NaN（脚本里用 H.num 取值，NaN 会在校验阶段被抓出来）。 */
export function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return Number.NaN;
}

/** 角度归一到 [0,360)。 */
export function wrapDeg(d: number): number {
  return (((d % 360) + 360) % 360) || 0;
}

/** pitch 限幅 ±89°。 */
export function clampPitch(d: number): number {
  if (!Number.isFinite(d)) return 0;
  return Math.max(-PITCH_LIMIT_DEG, Math.min(PITCH_LIMIT_DEG, d));
}

/** 弧度 → 度。 */
export function deg(rad: number): number {
  return rad * (180 / Math.PI);
}

/** 脚本里拿到的 H。 */
export const REPLAY_HELPERS = {
  get: getPath,
  num,
  wrap: wrapDeg,
  clampPitch,
  deg,
  /** 站立眼高（HU）——输入坐标是眼位时用它换算回脚底。 */
  EYE: EYE_STAND,
  /** 限幅到指定区间。 */
  clamp: (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v)),
};

// ── 帧数组自动探测 ──────────────────────────────────────────────────

export interface ArrayCandidate {
  /** JSON 根到该数组的路径；'' 表示根本身就是帧数组。 */
  path: string;
  length: number;
  depth: number;
}

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 广度探测 JSON 中所有「元素为对象的数组」，作为帧数组的候选。
 * 只下钻前若干个元素（避免大数组全量遍历），深度上限 4 层。
 */
export function findArrayCandidates(root: unknown, maxDepth = 4): ArrayCandidate[] {
  const out: ArrayCandidate[] = [];
  const seen = new Set<unknown>();

  const consider = (value: unknown, path: string, depth: number): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && isPlainObject(value[0])) {
      out.push({ path, length: value.length, depth });
    }
  };

  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > maxDepth || out.length > 60) return;
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      consider(value, path, depth);
      for (let i = 0; i < Math.min(value.length, 5); i++) {
        visit(value[i], `${path}[${i}]`, depth + 1);
      }
      return;
    }

    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key.length > 48) continue;
      const child = obj[key];
      const childPath = path ? `${path}.${key}` : key;
      if (Array.isArray(child)) {
        consider(child, childPath, depth);
        for (let i = 0; i < Math.min(child.length, 5); i++) {
          visit(child[i], `${childPath}[${i}]`, depth + 1);
        }
      } else if (isPlainObject(child)) {
        visit(child, childPath, depth + 1);
      }
    }
  };

  visit(root, '', 0);

  // 长数组优先，同长度浅路径优先
  out.sort((a, b) => b.length - a.length || a.depth - b.depth);
  return out.slice(0, 30);
}

/** 自动挑一个最像帧数组的路径。 */
export function pickFrameArray(root: unknown): string | null {
  const cands = findArrayCandidates(root);
  return cands.length > 0 ? cands[0].path : null;
}
