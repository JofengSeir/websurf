/**
 * 帧预算状态机（P2-2c 从 `render-session.ts` 原样搬出，逻辑零改动）。
 *
 * 为什么独立成类：这套判定有 17 个私有采样状态（帧间隔环、恢复窗口位环、粘滞/评估计时），
 * 混在 `RenderSession` 里既读不出「哪些是采样、哪些是决策」，也无法单独对拍。
 * 会话侧只保留 4 个接触点：`update()`、`reset()`、`softResetWindow()`、`lastStart`。
 *
 * 档位经 `RenderFrameContext.budgetLevel` 显式下传（T-P2-1），本类不读 globalThis 里的档位；
 * 诊断用的 `__vbspBudget` 仍由这里写（只写）。
 */
import type { RenderFrameContext } from './render-context.js';

// ── 帧预算控制器常量 ─────────────────────────────────────────────────────────
//
// 双槽阈值沿用 320Hz 档的 3.125ms/帧口径：dt>4.8ms（≈1.5 槽）算「漏了一槽」，
// dt<3.6ms 算「单槽可达」。升档判据（30/60 帧双槽数与占比）保持不变。
//
// 恢复判据（2026-11-21 改，审查 P1-4）：旧实现要求「连续 1600/3200 帧无双槽」，
// 慢机每秒仍会偶发双槽、切后台回来的首帧更是必然超长 ⇒ 实际永远达不到，降档后永久粘住。
// 改为「最近 120 帧双槽 ≤1（≈0.8%，低于正常偶发抖动）+ 持续约 1s」：
// 120 帧在 320Hz 下约 0.38s，单看窗口太短，加 1s 累计把「偶发 1 次抖动」和「持续健康」区分开；
// 仍比旧的 5~10s 快一个数量级，且不再要求「一帧都不能掉」。
const BUDGET_DOUBLE_SLOT_MS = 4.8;
const BUDGET_SINGLE_SLOT_MS = 3.6;
const BUDGET_RECOVER_WINDOW = 120;
const BUDGET_RECOVER_MAX_DOUBLES = 1;
const BUDGET_RECOVER_HOLD_MS = 1000;
const BUDGET_EVALUATE_FIRST_FRAMES = 30;
const BUDGET_EVALUATE_INTERVAL = 10;

/** 采样窗口帧数（最近 60 帧的 rAF 帧间隔）。 */
const BUDGET_DT_WINDOW = 60;

export class FrameBudgetController {
  /** 当前档位：0=不降级，1=bloom 光晕降频，2=再叠加水面镜面降频。 */
  level = 0;
  private up = 0;
  private down = 0;
  private lastCpuMs = 0;
  /** 上一帧 `frame()` 的进入时刻，用于算 rAF 帧间隔（控制器主信号）。 */
  lastStart = 0;
  /** 最近 60 帧的帧间隔环形缓冲 + 游标 + 已填样本数。 */
  private readonly dt = new Float32Array(BUDGET_DT_WINDOW);
  private dtAt = 0;
  private dtCount = 0;
  /** 距下一次评估还有多少帧。 */
  private evaluateIn = BUDGET_EVALUATE_FIRST_FRAMES;
  /** 升档后的最短保持帧数（期间不降档，避免「降级→恢复→再掉」的振荡）。 */
  private hold = 0;
  /** 连续「非双槽帧」的帧数：仅诊断（`__vbspBudget.stable`）；恢复判据已改为比例窗口。 */
  private stableFrames = 0;
  /** 最近 `BUDGET_RECOVER_WINDOW` 帧「是否双槽」的位环（FIFO 计数，恢复判据用）。 */
  private readonly recoverRing = new Uint8Array(BUDGET_RECOVER_WINDOW);
  private recoverAt = 0;
  private recoverFilled = 0;
  private recoverDoubles = 0;
  /** 满足恢复窗口条件的累计时长（ms）：窗口条件破即清零，满 `BUDGET_RECOVER_HOLD_MS` 才允许降档。 */
  private recoverMs = 0;
  /** 页面隐藏/切回后的首帧 dt 跨了整个不可见期，丢弃一次采样。 */
  private skipSampleOnce = false;

/**
 * 帧预算状态机（task-33 方案 C1 的修订版）。**主信号是 rAF 帧间隔**，而不是渲染段 CPU：
 * 实测（pcf-semantics 2026-11-16）终点机位渲染段 CPU 只有 1.5~2.8ms，却仍有 3.1/6.2ms
 * 交替 —— 说明超时的那一帧卡在 GPU/合成等待上，用 CPU 时长做阈值永远不触发。
 *
 * 采样与时钟口径（2026-11-21 修，审查 P1-3）：
 * 1) `__vbspBudgetOn=false`（载图预热/用户 A/B）时**先返回、不采样**——预热帧是假帧，
 *    且与上一帧的间隔跨整个载图段，采进来就是一次假双槽；
 * 2) 页面隐藏期间与「切回后的第一帧」不采样（`document.hidden` / `skipSampleOnce`）；
 * 3) `loadScene()` 与 `prewarmPasses()` 入口调 `reset()` 硬重置（清窗口/稳定计数/
 *    粘滞/档位），否则新图第一帧拿到的评估窗口里混着旧图样本。
 *
 * 判定（2026-11-19 改敏感版，未变）：每 10 帧评估一次，最多 2 级；
 * - 升 L1：最近 30 帧里双槽帧（dt>4.8ms）≥2（≈6.7%）或最近 60 帧占比 ≥8%；
 * - 升 L2：L1 基础上最近 30 帧双槽 ≥5（≈16.7%）或 60 帧占比 ≥15%；
 * - 为什么要求「窗口内出现过单槽帧」：如果显示器本身就是 160Hz（dt 恒 6.25），控制器不该一直降级。
 * 旧判据（60 帧占比 ≥25% 才升）在实测里几乎不触发：用户机是「每秒丢 15~20 帧」≈5~7% 双槽，
 * 落在 5%~25% 死区里，导致水面 cadence 自适应从未生效（`__vbspBudgetLevel` 恒 0）。
 *
 * 降档（2026-11-21 改，审查 P1-4）：升档后先保持 180 帧；之后按「最近 `BUDGET_RECOVER_WINDOW`
 * 帧双槽 ≤ `BUDGET_RECOVER_MAX_DOUBLES` 且该状态累计 ≥ `BUDGET_RECOVER_HOLD_MS`」降一级。
 * 旧的「连续 1600/3200 帧无双槽」在慢机上永远达不到（慢机双槽是常态），一旦误降就永久粘住；
 * 现在允许窗口里有一次抖动，但要求约 1s 的持续健康（仍比旧实现快一个数量级）。
 *
 * 关闭开关：`globalThis.__vbspBudgetOn = false`；强制档位：`__vbspBudgetForce = 0|1|2`。
 */
update(cpuMs: number, dtMs: number, frameCtx: RenderFrameContext): void {
  this.lastCpuMs = cpuMs;
  const g = globalThis as {
    __vbspBudgetOn?: boolean;
    __vbspBudgetForce?: number;
    __vbspBudgetLevel?: number;
    __vbspBudget?: {
      level: number;
      ms: number;
      dt: number;
      doublePct: number;
      doubles30: number;
      doubles60: number;
      doubles120: number;
      recoverMs: number;
      stable: number;
      up: number;
      down: number;
      hold: number;
    };
  };
  const write = (): void => {
    // 等级写进上下文（唯一生产读点来源）；旧的 `__vbspBudgetLevel` 由帧末
    // `mirrorFrameContext` 统一镜像，这里不再各写一份。
    frameCtx.budgetLevel = this.level;
    g.__vbspBudget = {
      level: this.level,
      ms: +this.lastCpuMs.toFixed(3),
      dt: +dtMs.toFixed(3),
      doublePct: this.doublePct(),
      doubles30: this.doubles(30),
      doubles60: this.doubles(60),
      doubles120: this.recoverDoubles,
      recoverMs: Math.round(this.recoverMs),
      stable: this.stableFrames,
      up: this.up,
      down: this.down,
      hold: this.hold,
    };
  };
  // ① 逃生舱/预热：不采样、不清窗口（窗口由 loadScene/prewarm 入口的硬重置负责）。
  if (g.__vbspBudgetOn === false) {
    this.level = 0;
    write();
    return;
  }
  // ② 隐藏期间不采样，也不消费 skip 标记；切回后的首帧间隔跨了整个隐藏期，丢弃一次。
  if (typeof document !== 'undefined' && document.hidden) {
    write();
    return;
  }
  if (this.skipSampleOnce) {
    this.skipSampleOnce = false;
    write();
    return;
  }
  // ③ 滚动窗口采样 rAF 帧间隔 + 恢复窗口。
  if (dtMs > 0) {
    this.dt[this.dtAt] = dtMs;
    this.dtAt = (this.dtAt + 1) % this.dt.length;
    this.dtCount = Math.min(this.dtCount + 1, this.dt.length);
    this.stableFrames = dtMs > BUDGET_DOUBLE_SLOT_MS ? 0 : this.stableFrames + 1;
    this.sampleRecoverWindow(dtMs);
  }
  if (typeof g.__vbspBudgetForce === 'number') {
    this.level = Math.max(0, Math.min(2, Math.floor(g.__vbspBudgetForce)));
    write();
    return;
  }
  // 每 `BUDGET_EVALUATE_INTERVAL` 帧评估一次；窗口未填满前不动作。
  this.evaluateIn--;
  if (this.hold > 0) this.hold--;
  if (this.evaluateIn > 0 || this.dtCount < BUDGET_EVALUATE_FIRST_FRAMES) {
    write();
    return;
  }
  this.evaluateIn = BUDGET_EVALUATE_INTERVAL;
  const doubles30 = this.doubles(30);
  const doubles60 = this.doubles(60);
  const ratio60 = doubles60 / Math.max(1, this.dtCount);
  if (this.level === 0) {
    if ((doubles30 >= 2 || ratio60 >= 0.08) && this.hasSingleSlot(60)) {
      this.level = 1;
      this.up++;
      this.hold = 180;
    }
  } else if (this.level === 1) {
    if (doubles30 >= 5 || ratio60 >= 0.15) {
      this.level = 2;
      this.up++;
      this.hold = 180;
    } else if (this.hold === 0 && this.recoverReady()) {
      this.level = 0;
      this.down++;
      this.recoverMs = 0;
    }
  } else if (this.hold === 0 && this.recoverReady()) {
    this.level = 1;
    this.down++;
    this.recoverMs = 0;
  }
  write();
}

/**
 * 恢复窗口采样：最近 `BUDGET_RECOVER_WINDOW` 帧里双槽帧数 ≤ `BUDGET_RECOVER_MAX_DOUBLES`
 * （≈0.8%，低于正常偶发抖动）才累计「干净时长」；条件一破即清零。
 * 320Hz 下窗口只有约 0.38s，不够区分偶发抖动，所以再看累计时长 ≥ `BUDGET_RECOVER_HOLD_MS`。
 */
private sampleRecoverWindow(dtMs: number): void {
  const isDouble = dtMs > BUDGET_DOUBLE_SLOT_MS ? 1 : 0;
  if (this.recoverFilled >= BUDGET_RECOVER_WINDOW) {
    this.recoverDoubles -= this.recoverRing[this.recoverAt];
  } else {
    this.recoverFilled++;
  }
  this.recoverRing[this.recoverAt] = isDouble;
  this.recoverDoubles += isDouble;
  this.recoverAt = (this.recoverAt + 1) % BUDGET_RECOVER_WINDOW;
  if (this.recoverFilled >= BUDGET_RECOVER_WINDOW
    && this.recoverDoubles <= BUDGET_RECOVER_MAX_DOUBLES) {
    this.recoverMs += dtMs;
  } else {
    this.recoverMs = 0;
  }
}

/** 降档判据：窗口已填满且双槽数达标，并且该状态累计持续了 `BUDGET_RECOVER_HOLD_MS`。 */
private recoverReady(): boolean {
  return this.recoverFilled >= BUDGET_RECOVER_WINDOW
    && this.recoverDoubles <= BUDGET_RECOVER_MAX_DOUBLES
    && this.recoverMs >= BUDGET_RECOVER_HOLD_MS;
}

/** 清空预算采样与恢复窗口；档位/粘滞等「决策状态」由调用方决定是否保留。 */
private clearSamples(): void {
  this.dt.fill(0);
  this.dtAt = 0;
  this.dtCount = 0;
  this.stableFrames = 0;
  this.recoverRing.fill(0);
  this.recoverAt = 0;
  this.recoverFilled = 0;
  this.recoverDoubles = 0;
  this.recoverMs = 0;
  this.evaluateIn = BUDGET_EVALUATE_FIRST_FRAMES;
}

/**
 * 换图/预热的硬重置（审查 P1-3）：窗口、稳定计数、粘滞、档位全归零，下一帧 dt 记为 0。
 * 不把 `lastStart` 清零的话，新图第一帧的 dt 会跨整个载图段（数百 ms），直接算一次双槽。
 */
reset(): void {
  this.clearSamples();
  this.hold = 0;
  this.level = 0;
  this.lastStart = 0;
  this.skipSampleOnce = false;
  (globalThis as { __vbspBudgetLevel?: number }).__vbspBudgetLevel = 0;
}

/** 可见性切换的软重置（审查 P1-4）：只清采样窗口，保留档位与粘滞（后台时间不是性能证据）。 */
softResetWindow(): void {
  this.clearSamples();
  this.skipSampleOnce = true;
}

/** 最近 `n` 帧样本里的双槽帧（dt>BUDGET_DOUBLE_SLOT_MS）个数（按时间顺序取最后 n 个）。 */
private doubles(n: number): number {
  const len = this.dt.length;
  const count = Math.min(this.dtCount, n);
  const start = (this.dtAt - count + len * 2) % len;
  let dbl = 0;
  for (let i = 0; i < count; i++) if (this.dt[(start + i) % len] > BUDGET_DOUBLE_SLOT_MS) dbl++;
  return dbl;
}

/** 最近 `n` 帧里是否出现过单槽帧（dt<BUDGET_SINGLE_SLOT_MS）——证明这台机器的 320Hz 档确实可达。 */
private hasSingleSlot(n: number): boolean {
  const len = this.dt.length;
  const count = Math.min(this.dtCount, n);
  const start = (this.dtAt - count + len * 2) % len;
  for (let i = 0; i < count; i++) if (this.dt[(start + i) % len] < BUDGET_SINGLE_SLOT_MS) return true;
  return false;
}

/** 滚动窗口里「双槽帧」占比（dt>BUDGET_DOUBLE_SLOT_MS）；窗口未填满按已有样本算。 */
private doublePct(): number {
  const n = this.dtCount;
  if (n === 0) return 0;
  let dbl = 0;
  for (let i = 0; i < n; i++) if (this.dt[i] > BUDGET_DOUBLE_SLOT_MS) dbl++;
  return +(dbl / n).toFixed(3);
}
}

