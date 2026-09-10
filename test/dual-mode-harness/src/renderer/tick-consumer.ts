/**
 * tick 模式主线程消费器（任务 t5 · 零物理实例纯历史插值消费 + F4 lede/修订缝合）。
 *
 * 设计基线（逐条对应）：
 * - **P0 逐帧等式**（t4-acceptance §1.1 / plan-v2 §1.3.2）：τ_display =
 *   max(τ_prev, now − anchor − Δ)；确定性网格 α（t_k = T0 + k·T，T0_est =
 *   EMA(W_k − k·T)，发布残差不进 α）；pos/pitch/eyeHeight 弦插值、yaw 最短弧；
 *   α < 1 + 1e−9 一票否决；容差 1e−3 HU / 1e−3°（P0 自检计数为 Gate 2 信号）。
 * - **消费侧硬不变量四条**（t4-acceptance §5.1）：① τ 单调非递减（Δ 增大/EMA
 *   更新只延长 hold 绝不回退）；② 跨线程时钟锚（首帧一次性 + EMA 漂移刷新 +
 *   drift 快照安全网）；③ 光标跳变白名单 + 遥测（重锚/快进/断窗直出/修订 snap
 *   逐次计数）；④ 断点帧禁跨界插值（I_A_SEG 段匹配配对，t2 裁定细则①）。
 * - **六显示态单状态机**（t6-render-ahead §8.3）：lerp / extrapolate-capped /
 *   direct-opt / hold-scheduled / hold-starved / break-direct；policy ∈
 *   {pure-history（F4-off 回退，零外推红线）, f4（lede 标签先行，已追认受控
 *   推定）}；政策自动升级（首个 OPT 帧到达）+ 渐进降级内建（分支数据驱动，
 *   无 OPT/无 f4 数据时逐帧回落 pure-history 语义）。
 * - **红线（t3-memo §3.5 + t6 §3）**：兜底零外推——starvation → 冻结最后已
 *   发布值 + 计数，禁止为遮盖而外推；外推只属于 f4 正常领先循环（截断窗封帽
 *   = 最新已发布网格点 +1 tick，P-ra-1；越帽 hold 恒值）。pure-history 政策
 *   下 P-tick-2 凸组合断言逐帧成立（p0Violations 恒 0 = Gate 2 信号）。
 * - **F4-C 修订流对接**（t6 §8.1/§11.3 + t2-protocol-verdict）：OPT 帧 =
 *   I_A_EVT bit8（事件位恒 0）；乐观帧直出至自身网格点、越点 hold 不得再外推
 *   （两格领先 = optLeadViolations 防御计数）；修订（同 tick 真帧）到达 →
 *   snap 直跳（≤1 渲染帧收敛，P-ra-2）+ div 双桶遥测（bulk ≤ 2-3u 硬断言 /
 *   flip 独立计数）+ P99 逃逸条款（div_flip P99 > 阈值 → p99Escape 粘滞置位，
 *   回开混合评审信号，不自动改行为）。
 * - **封帽谓词消费侧代理**（t6 §11.3）：修订帧 evt 事件位非空 ∨ onGround 翻转
 *   → div_flip 桶；其余 → div_bulk 桶。on_ladder/ducked/blocked 计数不在 10 值
 *   帧内——worker 侧（t4）遥测承担，消费侧用可见代理并在手测指引披露。
 * - **通道合同**（t2-protocol-verdict ①③④）：readAuthoritativeInto 零分配
 *   双通道等价（SAB seqlock / MsgState 消息快照）；i32 wrap-safe tick diff
 *   ((b−a)|0)；orphan/内容封帽判定在本消费器（t5 eval 面），排序门属 worker。
 * - **Δ 事件驱动控制器**（t3-memo §3.1.1 v1.3，pure-history 政策资产，t6 §8.3
 *   「v1.6 原样全套保留」）：starvation 事件 → guard +1ms（⟺ Δ+1ms，硬帽
 *   Δ_max = 1.5T + 8 = 31.4375）；连续 1000 clean 槽 → 每 100 槽 −0.25ms
 *   （下界 guard 4 ⟺ Δ_min = T + 4 = 19.625 量化守卫界）；ΔAdjustEvents 记账
 *   供 P-tick-8 收敛仲裁（稳态 <20 次/5s、无极限环）；f4 政策下 Δ 退役改压缩档
 *   （computeDeltaEff = T − lead_ema + f4Guard），guard 只服务 pure-history。
 *   τ 单调钳制构造性吸收 Δ 增量（max 钳 = 硬不变量①无例外）。
 *
 * 工程纪律：零分配热路径（预分配 ring/scratch/out）；时间注入（node 可测）；
 * 不 import three/DOM；计数器为会话累计（reset 只清运行态不清账）。
 */

import { AUTH_EVT, AUTH_EVT_OPT } from '../../../../src/ts-shared/auth/shared-state.js';

/** 八类控制面/内核事件位掩码（bit0-7；bit8 OPT 不在内）。 */
const EVT_MASK_ALL =
  AUTH_EVT.teleport | AUTH_EVT.death | AUTH_EVT.respawn | AUTH_EVT.reset |
  AUTH_EVT.holdRelease | AUTH_EVT.load | AUTH_EVT.modeSwitch | AUTH_EVT.worldRebuild;

/** 显示政策：pure-history = F4-off 回退（零外推红线）；f4 = lede 标签先行。 */
export type TickPolicy = 'pure-history' | 'f4';

/** 六显示态（t6 §8.3）。 */
export type TickDisplayState =
  | 'lerp'
  | 'extrapolate-capped'
  | 'direct-opt'
  | 'hold-scheduled'
  | 'hold-starved'
  | 'break-direct';

/** 消费器输出（预分配单对象；renderer 直接读）。 */
export interface TickDisplayPose {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  eyeHeight: number;
  /** 展示速度（lerp = 弦插值速度；直出/外推 = 帧速度；hold = 冻结值）。 */
  vx: number; vy: number; vz: number;
  state: TickDisplayState;
  policy: TickPolicy;
}

/** 会话累计遥测（面板/Gate 2 数据面；reset 不清零）。 */
export interface TickConsumerStats {
  /** 通道摄入帧数（含 OPT）/ 跳过发布数（va 跨步 >1，catch-up 指标）/ 读冲突。 */
  framesIngested: number;
  skippedPublishes: number;
  readConflicts: number;
  /** 显示态逐帧占账（兜底率分母 = displayedFrames）。 */
  displayedFrames: number;
  lerpFrames: number;
  extrapolatedFrames: number;
  directOptFrames: number;
  holdScheduledFrames: number;
  holdStarvedFrames: number;
  breakDirectFrames: number;
  /** 兜底账（hold-scheduled + hold-starved + 冻结直出各路径合并）。 */
  fallbackFrames: number;
  /** 采样漏帧/catch-up 跳格导致的配对缺失帧数（诚实冻结或端点直出）。 */
  gapFrames: number;
  /** starvation（发布迟到，逐 tick 去重）。 */
  starvedTicks: number;
  /** Δ 控制器调节事件数（±步进都计；P-tick-8 稳态 <20 次/5s、无极限环）。 */
  deltaAdjustEvents: number;
  /** 白名单跳变账（硬不变量③）。 */
  anchorEvents: number;
  reanchorEvents: number;
  fastForwardEvents: number;
  segEvents: number;
  /** 消费侧封帽代理强制断窗（worker 漏标 seg 的自愈面 = Gate 2 缺陷信号）。 */
  evtForceBreaks: number;
  deathYBreaks: number;
  geoJumpBreaks: number;
  /** F4 面。 */
  optFramesSeen: number;
  optDisplayedFrames: number;
  optLeadViolations: number;
  policyUpgrades: number;
  revisionSnaps: number;
  revisionMissed: number;
  /** div 双桶（bulk ≤ cap 硬断言；flip 独立计数 + P99 逃逸条款）。 */
  divBulkSamples: number;
  divFlipSamples: number;
  divBulkMaxU: number;
  divFlipMaxU: number;
  divBulkHardViolations: number;
  divFlipP99U: number;
  p99Escape: boolean;
  lastDivU: number;
  /** P0 / P-ra-0 自检违例（Gate 2 阻断信号；设计恒 0）。 */
  p0AlphaViolations: number;
  p0ConvexViolations: number;
  /** 政策降级（F4 断供 → pure-history 回退，渐进降级内建，t6 §8.3）。 */
  policyDowngrades: number;
  /** 当前生效 Δ（ms；f4 = T − δ_eff + f4Guard 压缩档，pure-history = T + guard）。 */
  deltaEffMs: number;
  /** OPT 提前量实测 EMA（ms；Δ_f4 自调源）。 */
  leadEmaMs: number;
  /** 实测延迟列（ms）：发布观测滞后 EMA（ε_publish + rAF 采样滞后）。 */
  publishLagEmaMs: number;
  /** 当前网格锚 T0_est（主线程时钟刻度；面板实测列）。 */
  t0EstMs: number;
}

export interface TickConsumerOptions {
  /** 权威 tick 率（raw，无 +3；t3-memo §4 raw 直译）。 */
  tickRate?: number;
  /** 插值延迟 guard（ms）：Δ = T + guard。缺省 8（setTimeout 档 ε≤8 安全位）。 */
  guardMs?: number;
  /** 发布预算 ε_max（ms）：starvation 判据 = now > t_{K+1} + ε_max。缺省 8。 */
  epsMaxMs?: number;
  /** T0 EMA 步进系数。缺省 1/16。 */
  emaAlpha?: number;
  /** 死亡阈值（scene deathY；非空时 pos.y < deathY 且无 seg 标记 → 强制断窗）。 */
  deathY?: number | null;
  /** 几何兜底阈值（HU；0 = 默认关——t4-acceptance §5.1 |Δpos|>100u 兜底默认关）。 */
  geoJumpU?: number;
  /** div_bulk 硬断言上限（HU；t6 §11.3 双桶 2-3u 带内取 2.5）。 */
  divBulkCapU?: number;
  /** div_flip P99 逃逸阈值（HU；t6 Q3' 1-2u 带内取 1.5）。 */
  flipP99EscapeU?: number;
  /** EMA 漂移快照阈值（ms；epoch 级漂移安全网，须远大于发布抖动带）。 */
  driftSnapMs?: number;
  /** f4 政策 guard（ms）：Δ_f4 = T − δ_eff + f4Guard（压缩档，乐观窗开启条件）。 */
  f4GuardMs?: number;
  /** 政策降级阈值：连续 N 个真实 tick 无 OPT → 回退 pure-history（渐进降级）。 */
  policyDownTicks?: number;
}

/** 环形缓冲深度（帧）：16 × 15.625ms = 250ms 历史窗。 */
const RING_DEPTH = 16;
/** P99 样本窗（bulk/flip 各自独立环形样本）。 */
const P99_SAMPLES = 64;
/** 断言容差：P0 位置 1e-3 HU（t4-acceptance §1.1）。 */
const POS_TOL = 1e-3;
/** α 一票否决上界。 */
const ALPHA_MAX = 1 + 1e-9;

// ── Δ 事件驱动控制器常量（t3-memo §3.1.1 v1.3，pure-history 政策资产）──
/** starvation 事件 → Δ 步进量（guard 域 +1ms ⟺ Δ +1ms）。 */
export const DELTA_STARVE_STEP_MS = 1;
/** 恢复期步降量（每 100 clean 槽 −0.25ms）。 */
export const DELTA_RECOVER_STEP_MS = 0.25;
/** 恢复步降周期（clean 槽计数）。 */
export const DELTA_RECOVER_EVERY_SLOTS = 100;
/** 恢复期门控：连续 clean 槽 ≥ 此值才开始收回（P-tick-8 防棘轮前提）。 */
export const DELTA_RECOVER_AFTER_CLEAN = 1000;
/** guard 下界（ms）：Δ_min = T + 4 ⟺ 量化守卫界 19.625ms。 */
export const DELTA_MIN_GUARD_MS = 4;
/** guard 绝对上界（ms）：Δ_max = 1.5T + 8 = 31.4375（由 tickRate 缩放的保底帽，
 * 构造期再按 0.5·T + 8 精确化）。 */
export const DELTA_GUARD_CAP_BASE_MS = 8;

/** i32 wrap-safe tick 差（t2 shared-state.protocol.test [4b] 同语义）。 */
export function tickDiff(b: number, a: number): number {
  return (b - a) | 0;
}

/** wrap 感知最短弧插值（t4-acceptance §1.2 允许清单 3）。结果归一化到 [0, 360)。 */
export function shortestArcLerp(yawA: number, yawB: number, alpha: number): number {
  let d = (yawB - yawA) % 360;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  const r = (yawA + d * alpha) % 360;
  return r < 0 ? r + 360 : r;
}

/** P99 估计（样本环形窗；就地插入排序到 scratch，零分配）。 */
function percentile99(buf: Float64Array, count: number, scratch: Float64Array): number {
  if (count <= 0) return 0;
  const n = Math.min(count, P99_SAMPLES);
  for (let i = 0; i < n; i++) scratch[i] = buf[i];
  for (let i = 1; i < n; i++) {
    const v = scratch[i];
    let j = i - 1;
    while (j >= 0 && scratch[j] > v) {
      scratch[j + 1] = scratch[j];
      j--;
    }
    scratch[j + 1] = v;
  }
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(n * 0.99) - 1));
  return scratch[idx];
}

export class TickConsumer {
  readonly out: TickDisplayPose = {
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, eyeHeight: 0,
    vx: 0, vy: 0, vz: 0,
    state: 'hold-scheduled',
    policy: 'pure-history',
  };
  readonly stats: TickConsumerStats = {
    framesIngested: 0, skippedPublishes: 0, readConflicts: 0,
    displayedFrames: 0, lerpFrames: 0, extrapolatedFrames: 0, directOptFrames: 0,
    holdScheduledFrames: 0, holdStarvedFrames: 0, breakDirectFrames: 0,
    fallbackFrames: 0, gapFrames: 0, starvedTicks: 0, deltaAdjustEvents: 0,
    anchorEvents: 0, reanchorEvents: 0, fastForwardEvents: 0, segEvents: 0,
    evtForceBreaks: 0, deathYBreaks: 0, geoJumpBreaks: 0,
    optFramesSeen: 0, optDisplayedFrames: 0, optLeadViolations: 0, policyUpgrades: 0,
    revisionSnaps: 0, revisionMissed: 0,
    divBulkSamples: 0, divFlipSamples: 0, divBulkMaxU: 0, divFlipMaxU: 0,
    divBulkHardViolations: 0, divFlipP99U: 0, p99Escape: false, lastDivU: 0,
    p0AlphaViolations: 0, p0ConvexViolations: 0,
    policyDowngrades: 0, deltaEffMs: 0, leadEmaMs: 0,
    publishLagEmaMs: 0,
    t0EstMs: 0,
  };

  // ── 配置（可运行时调；guard 调小触发快进白名单计数）──────────
  tickDtMs: number;
  private guardMs: number;
  /** guard 域上界 = 0.5·T + 8（⟺ Δ 上限 1.5T + 8 = 31.4375ms，t3 §3.1.1）。 */
  private deltaGuardMaxMs: number;
  private readonly epsMaxMs: number;
  private readonly emaAlpha: number;
  private deathY: number | null;
  private readonly geoJumpU: number;
  private readonly divBulkCapU: number;
  private readonly flipP99EscapeU: number;
  private readonly driftSnapMs: number;
  private readonly f4GuardMs: number;
  private readonly policyDownTicks: number;

  // ── 环形缓冲（零分配；slot*10 布局同 readAuthoritativeInto dstF64）──
  private readonly rf = new Float64Array(RING_DEPTH * 10);
  private readonly rGround = new Int32Array(RING_DEPTH);
  private readonly rTick = new Int32Array(RING_DEPTH);
  private readonly rEvt = new Int32Array(RING_DEPTH);
  private readonly rSeg = new Int32Array(RING_DEPTH);
  private readonly rOpt = new Int32Array(RING_DEPTH);
  private ringHead = 0; // 下一写槽
  private ringCount = 0;

  // ── 通道/锚定运行态 ─────────────────────────────────────────
  private lastVa = 0;
  private anchored = false;
  private t0Est = 0;
  private lastRealTick = 0;
  private lastRealPosValid = false;
  private lastRealPosX = 0;
  private lastRealPosY = 0;
  private lastRealPosZ = 0;
  private lastSeg: number | null = null;
  private breakPending = false;
  private tauPrev: number | null = null;
  private shownOptTick: number | null = null;
  private lastStarvedTick: number | null = null;
  /** OPT 提前量实测 EMA（ms；<0 = 未测）。 */
  private leadEmaMs = -1;
  /** 连续真实 tick 无 OPT 计数（渐进降级源）。 */
  private realTicksSinceOpt = 0;
  /** 上一步生效 Δ（快进白名单检测基线）。 */
  private lastDeltaEff = 0;
  /** Δ 控制器：连续 clean 显示槽数 / 恢复期信用槽（t3 §3.1.1 v1.3）。 */
  private cleanStreak = 0;
  private recoverCredit = 0;

  // ── 零分配 scratch ─────────────────────────────────────────
  private readonly srcF = new Float64Array(10);
  private readonly srcI = new Int32Array(5);
  private readonly p99BulkBuf = new Float64Array(P99_SAMPLES);
  private readonly p99FlipBuf = new Float64Array(P99_SAMPLES);
  private readonly p99Scratch = new Float64Array(P99_SAMPLES);
  private p99BulkCount = 0;
  private p99FlipCount = 0;
  private p99BulkCursor = 0;
  private p99FlipCursor = 0;

  constructor(opts: TickConsumerOptions = {}) {
    const tickRate = opts.tickRate ?? 64;
    if (!(tickRate > 0) || !Number.isFinite(tickRate)) {
      throw new Error(`[tick-consumer] 非法 tickRate: ${tickRate}`);
    }
    this.tickDtMs = 1000 / tickRate;
    this.guardMs = opts.guardMs ?? 8;
    this.deltaGuardMaxMs = 0.5 * this.tickDtMs + DELTA_GUARD_CAP_BASE_MS;
    this.epsMaxMs = opts.epsMaxMs ?? 8;
    this.emaAlpha = opts.emaAlpha ?? 1 / 16;
    this.deathY = opts.deathY ?? null;
    this.geoJumpU = opts.geoJumpU ?? 0;
    this.divBulkCapU = opts.divBulkCapU ?? 2.5;
    this.flipP99EscapeU = opts.flipP99EscapeU ?? 1.5;
    this.driftSnapMs = opts.driftSnapMs ?? 25;
    this.f4GuardMs = opts.f4GuardMs ?? 1;
    this.policyDownTicks = opts.policyDownTicks ?? 8;
  }

  // ── 运行时配置 ─────────────────────────────────────────────

  /** 插值延迟更新：guard 调小即显示快进（白名单经 Δ_eff 对比自动计数）。 */
  setGuardMs(ms: number): void {
    if (!(ms >= 0) || !Number.isFinite(ms)) return;
    this.guardMs = ms;
    // 手动调节 = 新基线：控制器 clean 连计清零重新门控
    this.cleanStreak = 0;
    this.recoverCredit = 0;
  }
  getGuardMs(): number {
    return this.guardMs;
  }
  /** Δ 事件驱动步进·饥饿面（t3-memo §3.1.1 v1.3）：starvation 事件 → guard +1ms
   *（⟺ Δ +1ms，硬帽 Δ_max = 1.5T + 8）；τ 单调钳制吸收增量只延长 hold（硬不变量①
   * 由 max 钳构造性保证）。事件驱动步进、非 EMA（t2 纠名采纳）。 */
  private bumpDeltaForStarvation(): void {
    this.cleanStreak = 0;
    this.recoverCredit = 0;
    if (this.guardMs < this.deltaGuardMaxMs) {
      // 步向帽收敛（钳制到帽，最后一步可为部分步长——防步长粒度卡死在帽前）
      this.guardMs = Math.min(this.guardMs + DELTA_STARVE_STEP_MS, this.deltaGuardMaxMs);
      this.stats.deltaAdjustEvents++;
    }
  }
  /** Δ 事件驱动步进·恢复面：连续 clean 槽 ≥ 1000 才开收回，每 100 槽 −0.25ms，
   * guard 下界 4（⟺ Δ_min = T + 4 = 19.625ms 量化守卫界，不再低于量化守卫）。
   * P-tick-8（收敛断言）：尾部结束后回落 ≥90%、稳态 5s 窗调整 <20 次无极限环——
   * 注记：1000 槽门控 @144Hz ≈ 6.9s 才开始步降，与「5s 回落 ≥90%」预算存在张力，
   * 若 bench（t6/t7）实测失败，按 t3 备用方向（饥饿率比例控制）重设计；面板列
   * deltaAdjustEvents 供实测仲裁。 */
  private noteCleanSlot(): void {
    this.cleanStreak++;
    if (this.cleanStreak < DELTA_RECOVER_AFTER_CLEAN) return;
    this.recoverCredit++;
    if (this.recoverCredit < DELTA_RECOVER_EVERY_SLOTS) return;
    this.recoverCredit = 0;
    if (this.guardMs > DELTA_MIN_GUARD_MS) {
      // 步向下界收敛（钳制到下界，最后一步可为部分步长——防离格值卡死在下界上方）
      this.guardMs = Math.max(this.guardMs - DELTA_RECOVER_STEP_MS, DELTA_MIN_GUARD_MS);
      this.stats.deltaAdjustEvents++;
    }
  }
  /** 插值延迟全量（pure-history 档：Δ = T + guard，ms）。 */
  getDeltaMs(): number {
    return this.tickDtMs + this.guardMs;
  }

  /** 调试/测试锚读取（node 单测精确等式核对用；面板不消费）。 */
  debugAnchorT0(): number {
    return this.t0Est;
  }
  /**
   * 生效 Δ：pure-history = T + guard（安全档）；f4 = T − δ_eff + f4Guard
   * （压缩档 < T，乐观窗开启条件——L 对消：Δ 压缩量 ≈ OPT 提前量 δ）。
   * δ_eff 取实测 EMA（未测时用协议封帽 7.625ms，与 t2 排序门 setTimeout 档对齐）。
   */
  private computeDeltaEff(): number {
    if (this.out.policy !== 'f4') return this.tickDtMs + this.guardMs;
    const lead = this.leadEmaMs >= 0 ? this.leadEmaMs : 7.625;
    const d = this.tickDtMs - lead + this.f4GuardMs;
    return Math.min(Math.max(d, 2), this.tickDtMs - 0.25);
  }
  setDeathY(y: number | null): void {
    this.deathY = y;
  }

  /** tick 率参数单写（tick 模式参数链消费侧钩子；worker 端 tick 边界原子生效由
   * t4 参数单写链负责，本侧收到新率即结构常量重建）。幂等：同率 no-op。
   * 变率 = tickDtMs/Δ 控制器帽重建 + guard 回默认工作点 + 运行态清零（reset
   * 语义：锚/EMA/环形/τ/streak 全清，下帧重新 bootstrap；stats 会话累计账保留，
   * 显示未锚定窗口由 renderer anchored 门控兜住相机不瞬移）。 */
  setTickRate(rate: number): void {
    if (!(rate > 0) || !Number.isFinite(rate)) {
      throw new Error(`[tick-consumer] 非法 tickRate: ${rate}`);
    }
    const dt = 1000 / rate;
    if (dt === this.tickDtMs) return; // 幂等：同率零开销
    this.tickDtMs = dt;
    this.deltaGuardMaxMs = 0.5 * dt + DELTA_GUARD_CAP_BASE_MS;
    this.guardMs = 8; // Δ=T+guard 回默认工作点（结构常量变更=新基线，手动调档作废）
    this.reset();
  }

  /** 当前生效 tick 率（Hz；renderer 参数链比对/面板用）。 */
  get tickRateHz(): number {
    return 1000 / this.tickDtMs;
  }

  /** 模式退出/重入：清运行态（环形/锚/τ/封帽标记/δ 实测/政策）；计数器保留（会话累计账）。 */
  reset(): void {
    this.ringHead = 0;
    this.ringCount = 0;
    this.lastVa = 0;
    this.anchored = false;
    this.t0Est = 0;
    this.lastRealTick = 0;
    this.lastRealPosValid = false;
    this.lastSeg = null;
    this.breakPending = false;
    this.tauPrev = null;
    this.shownOptTick = null;
    this.lastStarvedTick = null;
    this.leadEmaMs = -1;
    this.realTicksSinceOpt = 0;
    this.lastDeltaEff = 0;
    this.cleanStreak = 0;
    this.recoverCredit = 0;
    this.out.policy = 'pure-history';
    this.out.state = 'hold-scheduled';
  }

  // ── 主入口（rAF 每帧一次）────────────────────────────────────

  /**
   * 单步：摄入最新通道帧（readAuthoritativeInto 契约：≥1 成功 / 0 未开始 /
   * −1 发布冲突）→ 推进显示状态机 → 写 this.out。readInto 由调用方注入
   * （renderer 绑 this.shared.readAuthoritativeInto；node 测试喂脚本帧）。
   */
  step(now: number, readInto: (dstF64: Float64Array, dstI32: Int32Array) => number): void {
    const va = readInto(this.srcF, this.srcI);
    if (va > 0) {
      if (va !== this.lastVa) {
        if (this.lastVa > 0) {
          const skipped = va - this.lastVa - 1;
          if (skipped > 0) this.stats.skippedPublishes += skipped;
        }
        this.lastVa = va;
        this.ingest(now);
      }
      // va === lastVa：同帧重读（rAF 率 > 发布率是常态）——只推进显示，
      // 绝不重复摄入（重复摄入会污染 T0_est EMA / 重计断窗 / 误触发降级）
    } else if (va === -1) {
      // seqlock 冲突（两次复检均撞发布）：本轮弃读，显示沿用上一态（t2 读契约 −1）
      // 注：不更新 lastVa——下次成功读到该 va 时仍按新帧摄入
      this.stats.readConflicts++;
    }
    // va === 0：通道未开始——显示保持零位/上一态，不计账
    this.display(now);
  }

  // ── 摄入（真实帧 + OPT 帧统一入口）──────────────────────────

  private ingest(now: number): void {
    const f = this.srcF;
    const i = this.srcI;
    const tick = i[3];
    const evt = i[4];
    const seg = i[2];
    const isOpt = (evt & AUTH_EVT_OPT) !== 0;

    // 写环（OPT 帧也入环——direct-opt 显示源；配对/EMA 只用真实帧）
    const slot = this.ringHead;
    const base = slot * 10;
    for (let k = 0; k < 10; k++) this.rf[base + k] = f[k];
    this.rGround[slot] = i[0];
    this.rTick[slot] = tick;
    this.rEvt[slot] = evt;
    this.rSeg[slot] = seg;
    this.rOpt[slot] = isOpt ? 1 : 0;
    this.ringHead = (slot + 1) % RING_DEPTH;
    if (this.ringCount < RING_DEPTH) this.ringCount++;
    this.stats.framesIngested++;

    if (isOpt) {
      this.stats.optFramesSeen++;
      if (this.out.policy !== 'f4') {
        this.out.policy = 'f4';
        this.stats.policyUpgrades++;
      }
      // δ（OPT 提前量）实测：到自身网格点的剩余时间 EMA（Δ_f4 压缩档自调源）。
      // 注意：δ 实测用的 T0_est 是真实帧锚定的网格锚（OPT 不改锚），语义一致。
      if (this.anchored) {
        const leadSample = this.t0Est + tick * this.tickDtMs - now;
        if (leadSample >= 0 && leadSample <= this.tickDtMs) {
          if (this.leadEmaMs < 0) this.leadEmaMs = leadSample;
          else this.leadEmaMs += this.emaAlpha * (leadSample - this.leadEmaMs);
        }
      }
      this.realTicksSinceOpt = 0;
      // 两格领先防御（P-ra-1）：OPT 标签超前最新真实 tick >1 → 违规计数；
      // 显示面 findOptAfterReal 只认「最新真实 +1」，超前的 OPT 不会被展示。
      const newestReal = this.findNewestReal();
      if (newestReal >= 0 && tickDiff(tick, this.rTick[newestReal]) > 1) {
        this.stats.optLeadViolations++;
      }
      return;
    }

    // ── 真实帧 ──
    // EMA / 锚（确定性网格 α；发布残差不进 α——残差只影响「那格是否已可用」）
    const sample = now - tick * this.tickDtMs;
    if (!this.anchored) {
      this.t0Est = sample;
      this.anchored = true;
      this.stats.anchorEvents++;
    } else {
      const residual = sample - this.t0Est;
      // 实测延迟列：发布观测滞后 EMA（ε_publish + rAF 采样滞后的会话均值）
      this.stats.publishLagEmaMs += this.emaAlpha * (residual - this.stats.publishLagEmaMs);
      if (Math.abs(residual) > this.driftSnapMs) {
        // 漂移刷新（硬不变量②）：epoch 级漂移安全网（远大于抖动带才触发）
        this.t0Est = sample;
        this.stats.reanchorEvents++;
      } else {
        this.t0Est += this.emaAlpha * residual;
      }
    }
    this.lastRealTick = tick;

    // 渐进降级（t6 §8.3）：连续 policyDownTicks 个真实 tick 无 OPT → 回退
    // pure-history（Δ 恢复安全档；f4-off 回退 = v1.6 原样语义）。
    this.realTicksSinceOpt++;
    if (this.out.policy === 'f4' && this.realTicksSinceOpt >= this.policyDownTicks) {
      this.out.policy = 'pure-history';
      this.stats.policyDowngrades++;
    }

    // 断窗检测（硬不变量④ + 消费侧封帽代理）
    const firstEstablish = this.lastSeg === null;
    const segChanged = !firstEstablish && seg !== this.lastSeg;
    this.lastSeg = seg;
    if (firstEstablish) {
      // 首帧 = 锚定直出（非断窗事件，但显示面按直出语义走一步）
      this.breakPending = true;
    } else if (segChanged) {
      this.stats.segEvents++;
      this.breakPending = true;
    } else if ((evt & EVT_MASK_ALL) !== 0) {
      // worker 漏标 seg 的事件帧：消费侧封帽代理强制断窗（自愈 + Gate 2 缺陷信号）
      this.stats.evtForceBreaks++;
      this.breakPending = true;
    } else if (this.deathY !== null && f[1] < this.deathY) {
      this.stats.deathYBreaks++;
      this.breakPending = true;
    } else if (
      this.geoJumpU > 0 && this.lastRealPosValid &&
      Math.hypot(f[0] - this.lastRealPosX, f[1] - this.lastRealPosY, f[2] - this.lastRealPosZ) > this.geoJumpU
    ) {
      this.stats.geoJumpBreaks++;
      this.breakPending = true;
    }

    // 修订对账（shownOptTick 非空时，本真实帧即该 tick 的权威修订或后继）
    if (this.shownOptTick !== null) {
      const d = tickDiff(tick, this.shownOptTick);
      if (d === 0) {
        this.recordRevision(this.shownOptTick, f);
        this.shownOptTick = null;
      } else if (d > 0) {
        // 修订帧被 rAF 采样跳过（hitch）：div 无法测量，snap 语义不变（计数披露）
        this.stats.revisionMissed++;
        this.shownOptTick = null;
      }
    }

    this.lastRealPosX = f[0];
    this.lastRealPosY = f[1];
    this.lastRealPosZ = f[2];
    this.lastRealPosValid = true;
  }

  /** 修订事件：div 双桶 + P99 逃逸条款（t6 §11.3/§11.4）。 */
  private recordRevision(shownTick: number, revF: Float64Array): void {
    const optSlot = this.findOptWithTick(shownTick);
    if (optSlot < 0) return;
    const ob = optSlot * 10;
    const dx = revF[0] - this.rf[ob];
    const dy = revF[1] - this.rf[ob + 1];
    const dz = revF[2] - this.rf[ob + 2];
    const div = Math.hypot(dx, dy, dz);
    this.stats.lastDivU = div;
    this.stats.revisionSnaps++;
    // 封帽谓词消费侧代理：修订帧事件位非空 ∨ onGround 翻转 → flip 桶
    const revEvt = this.srcI[4] & EVT_MASK_ALL;
    const onGroundFlip = (this.rGround[optSlot] !== 0) !== (this.srcI[0] !== 0);
    if (revEvt !== 0 || onGroundFlip) {
      this.stats.divFlipSamples++;
      if (div > this.stats.divFlipMaxU) this.stats.divFlipMaxU = div;
      this.p99FlipBuf[this.p99FlipCursor] = div;
      this.p99FlipCursor = (this.p99FlipCursor + 1) % P99_SAMPLES;
      this.p99FlipCount++;
      const p99 = percentile99(this.p99FlipBuf, this.p99FlipCount, this.p99Scratch);
      this.stats.divFlipP99U = p99;
      if (p99 > this.flipP99EscapeU) this.stats.p99Escape = true; // 粘滞：回开混合评审信号
    } else {
      this.stats.divBulkSamples++;
      if (div > this.stats.divBulkMaxU) this.stats.divBulkMaxU = div;
      if (div > this.divBulkCapU) this.stats.divBulkHardViolations++;
      this.p99BulkBuf[this.p99BulkCursor] = div;
      this.p99BulkCursor = (this.p99BulkCursor + 1) % P99_SAMPLES;
      this.p99BulkCount++;
    }
  }

  // ── 环查找（最新优先；真实帧/OPT 帧分离）────────────────────

  private slotAt(i: number): number {
    return (((this.ringHead - 1 - i) % RING_DEPTH) + RING_DEPTH) % RING_DEPTH;
  }

  private findNewestReal(): number {
    for (let n = 0; n < this.ringCount; n++) {
      const s = this.slotAt(n);
      if (this.rOpt[s] === 0) return s;
    }
    return -1;
  }

  /** 最新真实帧之后（标签 K+1）的同段 OPT 帧（两格领先天然钳制）。 */
  private findOptAfterReal(realSlot: number): number {
    const kNext = this.rTick[realSlot] + 1;
    for (let n = 0; n < this.ringCount; n++) {
      const s = this.slotAt(n);
      if (this.rOpt[s] === 1 && this.rSeg[s] === this.rSeg[realSlot] && tickDiff(this.rTick[s], kNext) === 0) {
        return s;
      }
    }
    return -1;
  }

  private findRealWithTick(k: number, seg: number): number {
    for (let n = 0; n < this.ringCount; n++) {
      const s = this.slotAt(n);
      if (this.rOpt[s] === 0 && this.rSeg[s] === seg && tickDiff(this.rTick[s], k) === 0) return s;
    }
    return -1;
  }

  private findOptWithTick(k: number): number {
    for (let n = 0; n < this.ringCount; n++) {
      const s = this.slotAt(n);
      if (this.rOpt[s] === 1 && tickDiff(this.rTick[s], k) === 0) return s;
    }
    return -1;
  }

  // ── 显示状态机（六显示态）────────────────────────────────────

  private display(now: number): void {
    const o = this.out;
    const st = this.stats;

    if (!this.anchored) {
      // 未锚定（通道未开始/未首帧）：保持零位/上一态，不计显示账
      o.state = 'hold-scheduled';
      return;
    }

    // τ_display（绝对主时钟刻度）= max(τ_prev, now − Δ_eff)——单调钳制（硬不变量①）；
    // 网格点 t_k = T0_est + k·T（同一刻度，EMA 锚定）——两者可直接比较。
    // Δ_eff 缩小 = 快进白名单事件，放大 = 钳制吸收只延长 hold。
    // 刻度注记：t3-memo §3 形式「τ = now − anchor − Δ」为本式的相对刻度等价
    // 形（τ_rel = τ_abs − T0_est）；取绝对刻度使 EMA 重锚/漂移快照只移动网格
    // （t_k 系），τ 保持严格单调——重锚零跳变，钳制不变量无例外。
    const deltaEff = this.computeDeltaEff();
    if (this.lastDeltaEff > 0 && deltaEff < this.lastDeltaEff - 0.25) {
      this.stats.fastForwardEvents++;
    }
    this.lastDeltaEff = deltaEff;
    this.stats.deltaEffMs = deltaEff;
    this.stats.t0EstMs = this.t0Est;
    const tauTarget = now - deltaEff;
    const tau = this.tauPrev === null ? tauTarget : Math.max(this.tauPrev, tauTarget);
    this.tauPrev = tau;

    // 断窗直出优先（八类断窗/强制封帽代理/首帧锚定）
    if (this.breakPending) {
      const nr = this.findNewestReal();
      this.breakPending = false;
      if (nr >= 0) {
        this.copyFrameToOut(nr);
        o.state = 'break-direct';
        st.displayedFrames++;
        st.breakDirectFrames++;
        st.fallbackFrames++;
        this.shownOptTick = null; // 旧段 OPT 作废
        return;
      }
    }

    // 最新真实帧（当前段）与显示网格
    const nr = this.findNewestReal();
    if (nr < 0) {
      o.state = 'hold-scheduled';
      return;
    }
    const seg = this.rSeg[nr];
    const kNewest = this.rTick[nr];
    const tNewest = this.t0Est + kNewest * this.tickDtMs;

    if (tau < tNewest) {
      // 历史区：跨立对 (kLo, kLo+1) 弦插值（段匹配 = 断点禁跨界，硬不变量④）
      const kLo = Math.floor((tau - this.t0Est) / this.tickDtMs) | 0;
      const kUp = (kLo + 1) | 0;
      const sUp = this.findRealWithTick(kUp, seg);
      if (sUp < 0) {
        // 上端点帧缺失（rAF 采样漏帧/catch-up 跳格）：保持上一次显示值（诚实冻结）
        o.state = 'hold-scheduled';
        st.displayedFrames++;
        st.holdScheduledFrames++;
        st.fallbackFrames++;
        st.gapFrames++;
        return;
      }
      const sLo = this.findRealWithTick(kLo, seg);
      if (sLo < 0) {
        // 下端点缺失：直出上端点真帧（最新已发布真值直出，零推定冻结形态）
        this.copyFrameToOut(sUp);
        o.state = 'hold-scheduled';
        st.displayedFrames++;
        st.holdScheduledFrames++;
        st.fallbackFrames++;
        st.gapFrames++;
        return;
      }
      // P0 弦插值（α ∈ [0,1) 由 floor 构造保证；一票否决防御计数）
      const alpha = (tau - (this.t0Est + kLo * this.tickDtMs)) / this.tickDtMs;
      if (!(alpha >= 0) || alpha >= ALPHA_MAX) st.p0AlphaViolations++;
      const a = Math.min(Math.max(alpha, 0), 1 - 1e-12);
      const fb = sLo * 10;
      const ft = sUp * 10;
      const ax = this.rf[fb], ay = this.rf[fb + 1], az = this.rf[fb + 2];
      const bx = this.rf[ft], by = this.rf[ft + 1], bz = this.rf[ft + 2];
      const ex = ax + (bx - ax) * a;
      const ey = ay + (by - ay) * a;
      const ez = az + (bz - az) * a;
      o.x = ex; o.y = ey; o.z = ez;
      o.yaw = shortestArcLerp(this.rf[fb + 3], this.rf[ft + 3], a);
      o.pitch = this.rf[fb + 4] + (this.rf[ft + 4] - this.rf[fb + 4]) * a;
      o.eyeHeight = this.rf[fb + 8] + (this.rf[ft + 8] - this.rf[fb + 8]) * a;
      o.vx = this.rf[fb + 5] + (this.rf[ft + 5] - this.rf[fb + 5]) * a;
      o.vy = this.rf[fb + 6] + (this.rf[ft + 6] - this.rf[fb + 6]) * a;
      o.vz = this.rf[fb + 7] + (this.rf[ft + 7] - this.rf[fb + 7]) * a;
      o.state = 'lerp';
      st.displayedFrames++;
      st.lerpFrames++;
      this.noteCleanSlot(); // 历史区帧 = clean 槽（Δ 恢复期记账）
      // P-tick-2 凸组合断言（pure-history 全路径；fp 级自检 + α 界）
      if (
        Math.abs(o.x - (ax + (bx - ax) * a)) > POS_TOL ||
        Math.abs(o.y - (ay + (by - ay) * a)) > POS_TOL ||
        Math.abs(o.z - (az + (bz - az) * a)) > POS_TOL ||
        !(a >= 0 && a < ALPHA_MAX)
      ) {
        st.p0ConvexViolations++;
      }
      return;
    }

    // ── τ ≥ t_K（前沿之外：F4 领先窗 / 兜底冻结）───────────────
    const kNextTick = (kNewest + 1) | 0;
    const tNext = tNewest + this.tickDtMs;
    const optSlot = this.findOptAfterReal(nr);

    // starvation 判据：K+1 发布预算已过（逐 tick 去重）
    const starved = now > tNext + this.epsMaxMs;
    if (starved && (this.lastStarvedTick === null || tickDiff(kNextTick, this.lastStarvedTick) !== 0)) {
      this.stats.starvedTicks++;
      this.lastStarvedTick = kNextTick;
      this.bumpDeltaForStarvation(); // Δ 事件驱动步进（纯历史政策资产）
    }
    if (!starved) this.noteCleanSlot();

    if (optSlot >= 0 && tau < tNext) {
      // direct-opt：真物理精确直出至自身网格点（P-ra-0 ③支；P-ra-1 不再外推）
      this.copyFrameToOut(optSlot);
      o.state = 'direct-opt';
      st.displayedFrames++;
      st.directOptFrames++;
      this.shownOptTick = kNextTick;
      return;
    }

    if (optSlot >= 0 && tau >= tNext) {
      // 乐观窗用尽、修订未到：OPT 值冻结（不得再外推）
      this.copyFrameToOut(optSlot);
      this.shownOptTick = kNextTick;
      if (starved) {
        o.state = 'hold-starved';
        st.holdStarvedFrames++;
      } else {
        o.state = 'hold-scheduled';
        st.holdScheduledFrames++;
      }
      st.displayedFrames++;
      st.fallbackFrames++;
      return;
    }

    // 无 OPT：f4 政策 = lede 标签先行截断窗外推（已追认受控推定）；否则冻结兜底
    if (o.policy === 'f4') {
      const sSec = (tau - tNewest) / 1000;
      const halfT = this.tickDtMs / 1000;
      const sCap = Math.min(sSec, halfT);
      const ob = nr * 10;
      o.x = this.rf[ob] + this.rf[ob + 5] * sCap;
      o.y = this.rf[ob + 1] + this.rf[ob + 6] * sCap;
      o.z = this.rf[ob + 2] + this.rf[ob + 7] * sCap;
      o.yaw = this.rf[ob + 3];
      o.pitch = this.rf[ob + 4];
      o.eyeHeight = this.rf[ob + 8];
      o.vx = this.rf[ob + 5]; o.vy = this.rf[ob + 6]; o.vz = this.rf[ob + 7];
      if (sSec <= halfT) {
        o.state = 'extrapolate-capped';
        st.extrapolatedFrames++;
      } else {
        o.state = 'hold-scheduled'; // 越帽 hold（恒值 = 封帽点，t6 §3「越帽 hold」）
        st.holdScheduledFrames++;
        st.fallbackFrames++;
      }
      st.displayedFrames++;
      return;
    }

    // pure-history 兜底：冻结最后已发布值（α=1 语义；零外推红线）
    this.copyFrameToOut(nr);
    if (starved) {
      o.state = 'hold-starved';
      st.holdStarvedFrames++;
    } else {
      o.state = 'hold-scheduled';
      st.holdScheduledFrames++;
    }
    st.displayedFrames++;
    st.fallbackFrames++;
  }

  /** 环槽帧 → 输出（直出分支共用；10 值布局）。 */
  private copyFrameToOut(slot: number): void {
    const o = this.out;
    const b = slot * 10;
    o.x = this.rf[b]; o.y = this.rf[b + 1]; o.z = this.rf[b + 2];
    o.yaw = this.rf[b + 3]; o.pitch = this.rf[b + 4];
    o.eyeHeight = this.rf[b + 8];
    o.vx = this.rf[b + 5]; o.vy = this.rf[b + 6]; o.vz = this.rf[b + 7];
  }

  // ── 存点采样源（F_latest 真实帧；OPT 不作存点真值）──────────

  /** 最新真实帧快照（X 键存点=物理真值裁定，t3-memo §6 表；无帧返回 false）。 */
  getLatestRealPose(
    dst: { x: number; y: number; z: number; yaw: number; pitch: number; vx: number; vy: number; vz: number; onGround: boolean },
  ): boolean {
    const nr = this.findNewestReal();
    if (nr < 0) return false;
    const b = nr * 10;
    dst.x = this.rf[b]; dst.y = this.rf[b + 1]; dst.z = this.rf[b + 2];
    dst.yaw = this.rf[b + 3]; dst.pitch = this.rf[b + 4];
    dst.vx = this.rf[b + 5]; dst.vy = this.rf[b + 6]; dst.vz = this.rf[b + 7];
    dst.onGround = this.rGround[nr] === 1;
    return true;
  }
}

/** 面板/文档共用显示态中文名（遥测列）。 */
export const TICK_DISPLAY_STATE_LABEL: Record<TickDisplayState, string> = {
  'lerp': '弦插值',
  'extrapolate-capped': '截断窗外推',
  'direct-opt': '乐观直出',
  'hold-scheduled': '节拍保持',
  'hold-starved': '饥饿冻结',
  'break-direct': '断窗直出',
};
