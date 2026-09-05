/**
 * 朝向一致性诊断（Shavit 录像等 Source 系数据的核心验收算法）。
 *
 * 只使用录像自身数据：首段轨迹的**移动方向** vs 首帧**朝向**（前向向量）的夹角。
 *
 * ⚠ **能力边界（务必先看）**：这个检查对**任意正交映射都成立**——
 * 你随便把轴怎么置换、怎么翻符号、yaw 怎么偏移，只要位置和朝向用的是同一套映射，
 * 夹角都不变。所以它只能证明「映射链内部自洽」，**证明不了轨迹与地图对齐**。
 * 轨迹与地图是否对齐由「起点对齐 / 坐标系标定」（拿出生点当已知点）负责。
 *
 * 2026-09-03 教训：默认映射曾误用 glTF 风格 (x,z,−y)+yaw−90，诊断照样 PASS，
 * 但轨迹相对地图整体绕竖直轴偏 90°（首帧离出生点 5706 HU）。实测定标后默认映射
 * 已改为 **与 GLB/出生点同一变换：位置 (y,z,x)、viewerYaw = srcYaw + 180、pitch 取反**
 * （首帧离最近出生点 191 HU），见 codegen.ts PRESETS「source-world」/「shavit-replay」。
 *
 * - 源空间（Source 约定）：yaw=0 → +X；fwd_xy = (cos p·cos y, cos p·sin y)；水平面 = (x, y)
 * - viewer 空间（本工程约定）：yaw 0 → −Z；fwd_xz = (−sin θ, −cos θ)；水平面 = (x, z)
 *
 * 判定：**保角自洽**——存在窗口满足 |θ_view − θ_src| ≤ 1° → PASS（yaw 补偿与轴映射配套，
 * 视角与运动方向的自洽性与源空间一致）；所有候选 yaw 偏移都不自洽 → FAIL（可一键修正）；
 * 位移不足 / 起跑原地转向 → SKIP（数据不足，不算 FAIL）。
 * 注意：绝对夹角（θ ≤ 35°）不作 PASS 条件——surf 起跑常侧身蹭速，正身夹角可 >35°，
 * 只要源/viewer 两个空间算出来的夹角相等，映射链就是粘合的。
 *
 * 本模块是纯函数、无 DOM 依赖：viewer 面板、Node 自检、tools 校验共用同一实现。
 * 参数与常量沿用 notes/requirements.md §2.1（判定语义已按 2026-09-03 定标更新）。
 */

import { compileScript } from './codegen.js';
import { REPLAY_HELPERS } from './helpers.js';
import type { Frame, RuleConfig } from './types.js';

export interface OrientParams {
  /** 窗口帧数（录像前 N 帧；66.67 tick 下 ≈ 0.45s）。 */
  N: number;
  /** 夹角阈值（度）。 */
  THETA: number;
  /** 窗口位移最小阈值（HU）：低于此视为「起跑前站立/原地转向」，数据不足。 */
  D_MIN: number;
  /** 转向守卫：窗口内 yaw 累计变化 ≥ 此值 → 收缩窗口。 */
  TURN: number;
  /** 收缩后的有效窗口最小帧数。 */
  K_MIN: number;
}

export const ORIENT_DEFAULTS: OrientParams = { N: 30, THETA: 35, D_MIN: 24, TURN: 45, K_MIN: 10 };

/** 诊断输入：原始帧（只要 pos 与 ang=[pitch,yaw]，其余字段可缺）。 */
export interface OrientFrame {
  pos: number[];
  ang: number[];
}

/** 单个被评估的窗口（源/viewer 双空间同窗）。 */
export interface OrientWindow {
  s: number;
  e: number;
  /** 源空间水平位移（HU）。 */
  displacement: number;
  /** 源空间 yaw 累计变化 wrap180(yaw[e]−yaw[s])（度）。 */
  deltaYaw: number;
  /** 源空间夹角 θ_src（度，[0,180]）。 */
  srcAngleDeg: number;
  /** viewer 空间夹角 θ_view（度，[0,180]）。 */
  viewAngleDeg: number;
  /** 映射链保角校验：|θ_src − θ_view| ≤ 1°。 */
  conformal: boolean;
}

/** §3.1 只读内省报告（冒烟断言走 window.viewer.replay.orientation，不得依赖面板文字）。 */
export interface OrientationReport {
  /** viewer 空间夹角（主值，度）。取通过窗口的最小者；无有效窗口时为 NaN。 */
  angleDeg: number;
  /** 源空间夹角（度；诊断用）。 */
  srcAngleDeg: number;
  /** 窗口位移（HU）。 */
  displacement: number;
  /** 窗口 Δyaw（度）。 */
  deltaYaw: number;
  /** 判定：pass = 一致；fix = 需要修正 yaw 映射；skip = 数据不足。 */
  verdict: 'pass' | 'fix' | 'skip';
  /** 结论所依据窗口的保角校验（|θ_src − θ_view| ≤ 1°）。 */
  conformal: boolean;
  /** skip 的原因（有则填）。 */
  reason?: string;
  /** 使用了 preFrames 附加窗口（runs 起点）。 */
  preFramesUsed: boolean;
  /** 所有被评估的窗口。 */
  windows: OrientWindow[];
  /** 一键修正已应用时的记录（重新导入后仍保留，供内省）。 */
  applied?: { yawOffsetFrom: number; yawOffsetTo: number; angleBefore: number; angleAfter: number };
}

/** §3.2 一键修正候选搜索的结果。 */
export interface YawFixSuggestion {
  /** false = 无需/无法自动修正（数据不足时 reason 说明）。 */
  applicable: boolean;
  /** false 且 reason 说明 = 需要目视确认，不改规则。 */
  needHuman: boolean;
  yawOffsetFrom: number;
  yawOffsetTo: number;
  angleBefore: number;
  angleAfter: number;
  reason?: string;
  /** 各候选偏移对应的 θ_view（同窗口）。 */
  candidates: Array<{ offset: number; angleDeg: number }>;
}

function wrap180(d: number): number {
  if (!Number.isFinite(d)) return Number.NaN;
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

function wrap360(d: number): number {
  return (((d % 360) + 360) % 360) || 0;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function angleDeg(a: [number, number], b: [number, number]): number {
  const al = Math.hypot(a[0], a[1]);
  const bl = Math.hypot(b[0], b[1]);
  if (!(al > 0) || !(bl > 0)) return Number.NaN;
  const cos = clamp01((a[0] * b[0] + a[1] * b[1]) / (al * bl));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** 源空间前向向量（水平投影）：(cos p·cos y, cos p·sin y)，p=俯仰、y=偏航（度）。 */
function srcForward(pitchDeg: number, yawDeg: number): [number, number] {
  const p = (pitchDeg * Math.PI) / 180;
  const y = (yawDeg * Math.PI) / 180;
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y)];
}

/** viewer 空间前向向量（水平投影）：(−sin θ, −cos θ)，θ=viewer yaw（度）。 */
function viewForward(yawDeg: number): [number, number] {
  const y = (yawDeg * Math.PI) / 180;
  return [-Math.sin(y), -Math.cos(y)];
}

interface WindowResult {
  window?: OrientWindow;
  /** 跳过的原因（window 缺省时）。 */
  skip?: string;
}

/**
 * 评估一个窗口 [s, e]（两端均含）。
 * 移动方向 = pos[e] − pos[s]（源空间水平面 (x,y)；viewer 水平面 (x,z)）。
 * 朝向取窗口首帧；viewer 空间经规则脚本映射。
 */
function evaluateWindow(
  fn: (raw: unknown, i: number, H: unknown) => Frame,
  frames: OrientFrame[],
  s: number,
  e: number,
  params: OrientParams,
): WindowResult {
  const n = e - s + 1;
  if (n < 2) return { skip: `窗口过短（${n} 帧 < 2）` };
  if (n < params.K_MIN) return { skip: `收缩后窗口过短（${n} 帧 < K_MIN=${params.K_MIN}）` };

  const rawS = frames[s];
  let e2 = e;
  const p0 = rawS.pos;
  let pEnd = frames[e2].pos;
  if (!Number.isFinite(p0[0]) || !Number.isFinite(pEnd[0])) return { skip: '窗口两端 pos 非有限值' };

  // ── 源空间 ──
  const dx = pEnd[0] - p0[0];
  const dy = pEnd[1] - p0[1];
  let displacement = Math.hypot(dx, dy);
  if (displacement < params.D_MIN) {
    return { skip: `位移 ${displacement.toFixed(1)} HU < D_MIN=${params.D_MIN}（起跑前站立/原地转向，数据不足）` };
  }
  const srcYaw0 = Number.isFinite(rawS.ang[1]) ? rawS.ang[1] : NaN;
  const srcPitch0 = Number.isFinite(rawS.ang[0]) ? rawS.ang[0] : NaN;
  let srcAngle = Number.isFinite(srcYaw0)
    ? angleDeg([dx, dy], srcForward(Number.isFinite(srcPitch0) ? srcPitch0 : 0, srcYaw0))
    : NaN;

  const yawE = Number.isFinite(frames[e2].ang[1]) ? frames[e2].ang[1] : NaN;
  const deltaYaw = Number.isFinite(srcYaw0) && Number.isFinite(yawE) ? wrap180(yawE - srcYaw0) : NaN;

  // ── 转向守卫（源 yaw；收缩窗口后重算位移与夹角）──
  if (Number.isFinite(deltaYaw) && Math.abs(deltaYaw) >= params.TURN) {
    for (let k = s + 1; k <= e; k++) {
      const yk = frames[k].ang[1];
      if (Number.isFinite(yk) && Math.abs(wrap180(yk - srcYaw0)) >= params.TURN) {
        e2 = k - 1;
        break;
      }
    }
    if (e2 - s + 1 < params.K_MIN) {
      return { skip: `起跑即转向（|Δyaw|=${Math.abs(deltaYaw).toFixed(1)}° ≥ TURN=${params.TURN}°），有效窗口不足 K_MIN=${params.K_MIN}` };
    }
    pEnd = frames[e2].pos;
    const dx2 = pEnd[0] - p0[0];
    const dy2 = pEnd[1] - p0[1];
    displacement = Math.hypot(dx2, dy2);
    if (displacement < params.D_MIN) {
      return { skip: `收缩后位移 ${displacement.toFixed(1)} HU < D_MIN=${params.D_MIN}` };
    }
    srcAngle = Number.isFinite(srcYaw0)
      ? angleDeg([dx2, dy2], srcForward(Number.isFinite(srcPitch0) ? srcPitch0 : 0, srcYaw0))
      : NaN;
  }

  // ── viewer 空间（同窗口、经规则映射；H 是规则脚本的运行环境）──
  const fS = fn(rawS, s, REPLAY_HELPERS);
  const fE = fn(frames[e2], e2, REPLAY_HELPERS);
  if (!Number.isFinite(fS.pos[0]) || !Number.isFinite(fE.pos[0])) return { skip: '映射后 pos 非有限值' };
  const vx = fE.pos[0] - fS.pos[0];
  const vz = fE.pos[2] - fS.pos[2];
  const viewAngle = Number.isFinite(fS.ang[0]) ? angleDeg([vx, vz], viewForward(fS.ang[0])) : NaN;
  return {
    window: {
      s,
      e: e2,
      displacement,
      deltaYaw,
      srcAngleDeg: srcAngle,
      viewAngleDeg: viewAngle,
      conformal:
        Number.isFinite(srcAngle) && Number.isFinite(viewAngle) && Math.abs(srcAngle - viewAngle) <= 1,
    },
  };
}

/** 规则的映射函数缓存 key（同一 scriptSrc 编译一次）。 */
const mapperCache = new Map<string, (raw: unknown, i: number, H: unknown) => Frame>();

function mapperOf(rule: RuleConfig): (raw: unknown, i: number, H: unknown) => Frame {
  const key = rule.scriptSrc;
  let fn = mapperCache.get(key);
  if (!fn) {
    fn = compileScript(key);
    mapperCache.set(key, fn);
  }
  return fn;
}

/** 当前规则在同一首帧处的 viewer yaw（度，[0,360)）；yawPath 为空时为 NaN。 */
function currentViewYaw(fn: (raw: unknown, i: number, H: unknown) => Frame, rawS: unknown): number {
  const f = fn(rawS, 0, REPLAY_HELPERS);
  return Number.isFinite(f.ang[0]) ? f.ang[0] : Number.NaN;
}

/**
 * §2.1 朝向一致性诊断。frames = 原始帧（ang=[pitch,yaw]、pos=[x,y,z] 源空间约定）。
 * preFrames = 录像头部 preFrames（可选；主窗口 SKIP 时在 run 起点附加窗口重算）。
 */
export function computeOrientation(
  frames: OrientFrame[],
  rule: RuleConfig,
  preFrames = 0,
  params: OrientParams = ORIENT_DEFAULTS,
): OrientationReport {
  if (!Array.isArray(frames) || frames.length < 2) {
    return {
      angleDeg: NaN,
      srcAngleDeg: NaN,
      displacement: 0,
      deltaYaw: 0,
      verdict: 'skip',
      conformal: false,
      reason: '帧数不足（<2），无法评估',
      preFramesUsed: false,
      windows: [],
    };
  }

  const fn = mapperOf(rule);
  const len = frames.length;
  const winAt = (s: number): WindowResult => evaluateWindow(fn, frames, s, Math.min(s + params.N, len - 1), params);

  const windows: OrientWindow[] = [];
  const skips: string[] = [];
  const used: Array<{ win: OrientWindow; fromPre: boolean }> = [];

  const collect = (w: WindowResult, fromPre: boolean): void => {
    if (w.window) {
      windows.push(w.window);
      used.push({ win: w.window, fromPre });
    } else if (w.skip) {
      skips.push(w.skip);
    }
  };

  collect(winAt(0), false);
  const pfStart = Math.floor(preFrames);
  if (Number.isFinite(preFrames) && pfStart > 0 && pfStart + params.N < len) {
    collect(winAt(pfStart), true);
  }

  if (used.length === 0) {
    // 数据不足：报告原因（主窗口优先）
    return {
      angleDeg: NaN,
      srcAngleDeg: NaN,
      displacement: 0,
      deltaYaw: 0,
      verdict: 'skip',
      conformal: false,
      reason: skips[0] ?? '无有效窗口',
      preFramesUsed: false,
      windows,
    };
  }

  // 判定标准 = 源/viewer 双空间**保角自洽**（θ_view ≈ θ_src）：绝对夹角对 surf 无意义
  //（起跑常侧身蹭速，正身夹角可 >35°）；yaw 补偿与轴映射配套时，每个窗口两个空间算出的
  // 夹角必须相等。错误补偿（或轴映射与规则不配套）时二者差往往 >45°（乃至 ~90°）。
  const passed = used.find(
    (u) => u.win.conformal && Number.isFinite(u.win.srcAngleDeg) && Number.isFinite(u.win.viewAngleDeg),
  );
  const best =
    passed ??
    used.reduce((a, b) =>
      Math.abs((b.win.viewAngleDeg ?? NaN) - (b.win.srcAngleDeg ?? NaN)) <
      Math.abs((a.win.viewAngleDeg ?? NaN) - (a.win.srcAngleDeg ?? NaN))
        ? b
        : a,
    );
  const verdict = passed ? 'pass' : 'fix';
  return {
    angleDeg: best.win.viewAngleDeg,
    srcAngleDeg: best.win.srcAngleDeg,
    displacement: best.win.displacement,
    deltaYaw: best.win.deltaYaw,
    verdict,
    conformal: best.win.conformal,
    reason:
      verdict === 'fix'
        ? `映射链不自洽：θ_view=${Number.isFinite(best.win.viewAngleDeg) ? best.win.viewAngleDeg.toFixed(1) : '—'}°` +
          ` vs θ_src=${Number.isFinite(best.win.srcAngleDeg) ? best.win.srcAngleDeg.toFixed(1) : '—'}°` +
          `（差 ${Math.abs((best.win.viewAngleDeg ?? NaN) - (best.win.srcAngleDeg ?? NaN)).toFixed(1)}° > 1°）——` +
          `yaw 偏移或轴映射与规则不配套，可一键修正`
        : undefined,
    preFramesUsed: best.fromPre,
    windows,
  };
}

/**
 * §3.2 一键修正搜索：对当前输出 yaw 施加 {0, +90, −90, +180}（≡ yawOffset 候选
 * {c, c+90, c−90, c+180} mod 360），取与源空间夹角**自洽**（|θ_view − θ_src| ≤ 1°）
 * 的候选；当前已自洽则不动作；没有任何候选自洽（如轴映射与规则整体不配套）→
 * 需要目视确认/跑坐标系标定，不改规则。pitch 不参与自动修正。
 */
export function suggestYawFix(
  frames: OrientFrame[],
  rule: RuleConfig,
  preFrames = 0,
  params: OrientParams = ORIENT_DEFAULTS,
): YawFixSuggestion {
  const report = computeOrientation(frames, rule, preFrames, params);
  const from = rule.yawOffset;
  const notApplicable = (reason: string): YawFixSuggestion => ({
    applicable: false,
    needHuman: false,
    yawOffsetFrom: from,
    yawOffsetTo: from,
    angleBefore: NaN,
    angleAfter: NaN,
    reason,
    candidates: [],
  });
  if (report.verdict === 'skip') return notApplicable(`数据不足：${report.reason ?? '无有效窗口'}`);
  if (!rule.yawPath) return notApplicable('规则未配置 yaw 字段路径，无法自动修正朝向');

  // 用与诊断相同的窗口与两端（移动方向固定，只换朝向）重算 θ_view
  const window =
    report.windows.find((w) => w.viewAngleDeg === report.angleDeg) ??
    report.windows[report.windows.length - 1];
  if (!window) return notApplicable('无有效窗口');

  const fn = mapperOf(rule);
  const rawS = frames[window.s];
  const rawE = frames[window.e];
  const before = window.viewAngleDeg;
  const srcAngle = window.srcAngleDeg;
  const baseYaw = currentViewYaw(fn, rawS); // 当前映射在窗口首帧的输出 yaw

  const fS = fn(rawS, window.s, REPLAY_HELPERS);
  const fE = fn(rawE, window.e, REPLAY_HELPERS);
  const vx = fE.pos[0] - fS.pos[0];
  const vz = fE.pos[2] - fS.pos[2];

  const CONFORMAL_EPS = 1; // 与 evaluateWindow 的保角口径一致（度）
  const deltas = [0, 90, -90, 180];
  const candidates = deltas.map((d) => {
    const yaw = Number.isFinite(baseYaw) ? wrap360(baseYaw + d) : NaN;
    const angle = Number.isFinite(yaw) ? angleDeg([vx, vz], viewForward(yaw)) : NaN;
    const diff =
      Number.isFinite(angle) && Number.isFinite(srcAngle) ? Math.abs(angle - srcAngle) : NaN;
    return { offset: wrap180(from + d), angleDeg: angle, diff };
  });
  let bestIdx = 0;
  for (let i = 1; i < candidates.length; i++) {
    const a = candidates[bestIdx];
    const b = candidates[i];
    if (Number.isFinite(b.diff) && (!Number.isFinite(a.diff) || b.diff < a.diff)) bestIdx = i;
  }
  const best = candidates[bestIdx];
  if (!Number.isFinite(best.diff)) return notApplicable('无法计算候选夹角（数据异常）');
  if (best.diff > CONFORMAL_EPS) {
    return {
      applicable: false,
      needHuman: true,
      yawOffsetFrom: from,
      yawOffsetTo: from,
      angleBefore: before,
      angleAfter: best.angleDeg,
      reason: `所有候选 yawOffset {${candidates.map((c) => c.offset).join(', ')}}° 下 θ_view 与 θ_src` +
        `仍差 ${best.diff.toFixed(1)}°（>1°）——起跑转向/数据异常，或轴映射与规则整体不配套；` +
        `需要目视确认或跑「坐标系标定」，未改动规则`,
      candidates: candidates.map((c) => ({ offset: c.offset, angleDeg: c.angleDeg })),
    };
  }
  const unchanged = bestIdx === 0;
  return {
    applicable: !unchanged,
    needHuman: false,
    yawOffsetFrom: from,
    yawOffsetTo: best.offset,
    angleBefore: before,
    angleAfter: best.angleDeg,
    reason: unchanged
      ? '当前映射已自洽（θ_view ≈ θ_src），无需修正'
      : `候选 yawOffset {${candidates.map((c) => c.offset).join(', ')}}° → 取自洽解 ` +
        `${best.offset}°（θ_view ${Number.isFinite(before) ? before.toFixed(1) : '—'}° → ` +
        `${Number.isFinite(best.angleDeg) ? best.angleDeg.toFixed(1) : '—'}° ≈ θ_src ${Number.isFinite(srcAngle) ? srcAngle.toFixed(1) : '—'}°）`,
    candidates: candidates.map((c) => ({ offset: c.offset, angleDeg: c.angleDeg })),
  };
}