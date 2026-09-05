/**
 * 坐标系半自动标定（Q4）。
 *
 * 用户给 N≥2 组「录像原始坐标 ↔ viewer 世界坐标」的对应点，这里搜出一组变换：
 *
 *     out = scale · S · P · in + T
 *
 * 其中 P 是轴置换、S 是对角符号、scale 是统一缩放、T 是平移。
 * 覆盖了绝大多数跨引擎/跨工具导出差异：轴序不同、某些轴要取反、单位不同、原点不同。
 *
 * 为什么暴力搜：轴置换只有 6 种、符号 8 种，共 48 个候选；而给定 (P, S) 后
 * scale 与 T 有闭式最小二乘解（对 scale 求导可得）。48 次闭式解比任何迭代都快且稳。
 * 负 scale 与「全部符号取反」等价，直接跳过，于是每个合法解只出现一次。
 */

import type { AxisSrc, Sign } from './types.js';

/** 一组对应点：录像侧原始坐标（未经规则变换）↔ viewer 世界坐标。 */
export interface Correspondence {
  /** 输入坐标系下的原始坐标（就是规则里 posX/posY/posZ 取到的值）。 */
  raw: [number, number, number];
  /** viewer 世界坐标，Y-up，人物脚底。 */
  world: [number, number, number];
}

export interface Transform {
  axis: [AxisSrc, AxisSrc, AxisSrc];
  sign: [Sign, Sign, Sign];
  scale: number;
  offset: [number, number, number];
  /** det = −1：把右手系变成左手系。只在数据源本身是镜像约定时才合理，否则多半是搜错了。 */
  mirrored: boolean;
}

export interface Solution extends Transform {
  /** 所有对应点上的最大残差（HU）。越小越可信。 */
  maxResidual: number;
}

export type CalibResult =
  | {
      ok: true;
      best: Solution;
      /** 次优解的残差：与 best 接近说明对应点不足以定出唯一解。 */
      runnerUp: number;
      /** 世界侧点位跨度（HU），用于判断残差的相对量级。 */
      worldSpread: number;
      warnings: string[];
    }
  | { ok: false; error: string };

const AXIS_IDX: Record<AxisSrc, number> = { x: 0, y: 1, z: 2 };

/** 6 种轴置换，附带置换本身的奇偶性（用于算行列式）。 */
const PERMS: Array<{ axis: [AxisSrc, AxisSrc, AxisSrc]; parity: 1 | -1 }> = [
  { axis: ['x', 'y', 'z'], parity: 1 },
  { axis: ['y', 'z', 'x'], parity: 1 },
  { axis: ['z', 'x', 'y'], parity: 1 },
  { axis: ['x', 'z', 'y'], parity: -1 },
  { axis: ['z', 'y', 'x'], parity: -1 },
  { axis: ['y', 'x', 'z'], parity: -1 },
];

const SIGNS: Array<[Sign, Sign, Sign]> = [
  [1, 1, 1],
  [1, 1, -1],
  [1, -1, 1],
  [1, -1, -1],
  [-1, 1, 1],
  [-1, 1, -1],
  [-1, -1, 1],
  [-1, -1, -1],
];

function mapPoint(axis: Transform['axis'], sign: Transform['sign'], v: readonly number[]): number[] {
  return [
    sign[0] * v[AXIS_IDX[axis[0]]],
    sign[1] * v[AXIS_IDX[axis[1]]],
    sign[2] * v[AXIS_IDX[axis[2]]],
  ];
}

/** 把求出的变换施加到一个原始坐标上（预览与自检用）。 */
export function applyTransform(t: Transform, raw: readonly number[]): [number, number, number] {
  const u = mapPoint(t.axis, t.sign, raw);
  return [t.scale * u[0] + t.offset[0], t.scale * u[1] + t.offset[1], t.scale * u[2] + t.offset[2]];
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function meanVec(vs: number[][]): number[] {
  const s = [0, 0, 0];
  for (const v of vs) {
    s[0] += v[0];
    s[1] += v[1];
    s[2] += v[2];
  }
  const n = vs.length || 1;
  return [s[0] / n, s[1] / n, s[2] / n];
}

/** 点位跨度：任意两点最大距离的上界近似（够用来判断残差量级）。 */
function spread(pts: ReadonlyArray<readonly number[]>): number {
  let max = 0;
  for (let i = 1; i < pts.length; i++) max = Math.max(max, dist(pts[i], pts[0]));
  return max;
}

/**
 * 求解。对应点越多、在空间中越分散，解越可信。
 * 2 点能定出全部参数但没有冗余（残差恒为 0，无法验证），建议至少 3 点。
 */
export function solveTransform(pairs: Correspondence[]): CalibResult {
  const n = pairs.length;
  if (n < 2) {
    return {
      ok: false,
      error: '至少需要 2 组对应点——1 组只能定平移，定不出轴映射与缩放',
    };
  }

  const rawPts = pairs.map((p) => p.raw);
  const worldPts = pairs.map((p) => p.world);
  const rawSpread = spread(rawPts);
  const worldSpread = spread(worldPts);

  if (!(rawSpread > 1e-9)) {
    return { ok: false, error: '录像侧这些点几乎重合，定不出缩放——请挑相距较远的帧' };
  }
  if (!(worldSpread > 1e-9)) {
    return { ok: false, error: '世界侧这些点几乎重合——对应点标错了' };
  }

  let best: Solution | null = null;
  let runnerUp = Infinity;

  for (const perm of PERMS) {
    for (const sign of SIGNS) {
      const u = rawPts.map((p) => mapPoint(perm.axis, sign, p));
      const ubar = meanVec(u);
      const wbar = meanVec(worldPts as number[][]);

      // 对 scale 求导的闭式最小二乘：先各自去均值消掉 T，再投影求 scale
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
          const a = worldPts[i][k] - wbar[k];
          const b = u[i][k] - ubar[k];
          num += a * b;
          den += b * b;
        }
      }
      if (!(den > 1e-12)) continue;
      const scale = num / den;
      // 负 scale 与「符号全取反」等价（后者已在枚举里），跳过以免重复解
      if (!(scale > 1e-12)) continue;

      const offset = [0, 1, 2].map((k) => wbar[k] - scale * ubar[k]) as [number, number, number];

      let maxResidual = 0;
      for (let i = 0; i < n; i++) {
        const pred = [0, 1, 2].map((k) => scale * u[i][k] + offset[k]);
        maxResidual = Math.max(maxResidual, dist(pred, worldPts[i]));
      }

      const mirrored = perm.parity * sign[0] * sign[1] * sign[2] < 0;
      const cand: Solution = { axis: perm.axis, sign, scale, offset, mirrored, maxResidual };

      if (!best || maxResidual < best.maxResidual) {
        runnerUp = best ? best.maxResidual : Infinity;
        best = cand;
      } else if (maxResidual < runnerUp) {
        runnerUp = maxResidual;
      }
    }
  }

  if (!best) {
    return { ok: false, error: '没能求出有效变换——检查对应点是否有 NaN' };
  }

  const warnings: string[] = [];
  // 2 点无冗余，残差必然是 0，说明不了什么
  if (n === 2) {
    warnings.push('只有 2 组对应点：参数刚好定死、没有冗余校验（残差恒为 0），建议再加 1~2 组');
  } else if (best.maxResidual > worldSpread * 0.02) {
    warnings.push(
      `最大残差 ${best.maxResidual.toFixed(1)} HU 相对点位跨度 ${worldSpread.toFixed(0)} HU 偏大——` +
        '极可能有对应点点错了，或这份录像跟当前地图不是同一个',
    );
  }
  if (best.mirrored) {
    warnings.push('最优解是镜像变换（会左右翻转）：除非数据源确实是左手系，否则大概率是对应点不足导致搜歪了');
  }
  if (!Number.isFinite(runnerUp)) {
    // 只有一个候选通过，通常不会走到这里
  } else if (runnerUp < best.maxResidual * 3 + 1e-3) {
    warnings.push(
      `次优解残差 ${runnerUp.toFixed(1)} HU 与最优 ${best.maxResidual.toFixed(1)} HU 接近——` +
        '对应点不足以区分这两组变换，再加几组分散的点',
    );
  }
  if (Math.abs(best.scale - 1) > 1e-6) {
    warnings.push(`单位缩放解出 ${best.scale.toFixed(4)}（非 1），确认录像单位与地图是否一致`);
  }

  return { ok: true, best, runnerUp, worldSpread, warnings };
}
