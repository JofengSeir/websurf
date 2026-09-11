/**
 * 排序门（tick 模式 F4-C 乐观评估的发布协议门；任务 t2 落地，纯函数零分配）。
 *
 * 设计基线：t6 渲染先行立场件 §8.1/§8.4（原 plan-discuss/t6-render-ahead-stance.md，
 * 2026-09 清理；终榜 F4-C 主案：worker 内 scratch 第二实例乐观评估、权威实例零触碰零写入）。
 *
 * 排序不变量（§8.1）：`optimistic(k+1) 不得先于 authoritative(k) 发布`，
 * 静态充要条件 **δ + ε_max ≤ T**——
 * - δ（leadDeltaMs）：乐观评估提前量——worker 在 t_{k-1}+δ 用「截断输入窗」
 *   乐观预计算 tick k，先发 rev=OPT 乐观帧；t_k 全窗真算后发修订帧（权威终
 *   序列，F4-C 修订流）；
 * - ε_max（epsilonMaxMs）：发布延迟上界——调度档位（t3-memo §3.1.1）：
 *   setTimeout(4) 自驱档 ≈ 8ms；Atomics.wait 精确唤醒档 < 1ms（严格界取 1）；
 * - T（tickPeriodMs）：raw tick 周期 1/64 s = 15.625 ms（用户裁定 tickRate=
 *   raw 64，无 +3 偏移）。
 *
 * 动态兜底（发布门，§8.1 ε 尾条款）：乐观发布尝试落在本 tick 网格 due 之后
 * （ε 尾溢出）→ 丢弃该乐观帧——该 tick 回落 pure-history 一拍，lead-miss
 * 计数 +1（lead-miss 率 = P(停顿 > δ)，与 starvation 分列预算，§8.5；
 * 丢弃红利：T0_est EMA 样本率仍翻倍）。
 *
 * 排序不变量被违（authoritative(label-1) 未发布即试图乐观发布）→ block-order
 * 拒发（动作面三值之一）。分账（§8.5 对齐，见 createOrderingGate 头注）：
 * unordered（auth(label−1) 停顿未发/引导期无锚）→ leadMiss（ε 尾主机制，
 * =「停顿杀死领先」P(停顿>δ)）；superseded（auth(label) 已发/锚回跳）→
 * blockedOrder（worker 侧编排缺陷的报警面，稳态设计值为 0）。
 *
 * 档位数值（§8.4）：δ cap = T − ε_max → setTimeout 档 7.625ms（§8.4 记 7.6）/
 * Atomics 档 14.625ms（记 14.6）；δ*=7.6ms 通用（§8.4「δ=8 双量子超 0.4ms，
 * 排序门吸收但严格值 7.6」——本模块取严格界，越界配置由构造期钳制吸收）。
 */

/** raw 64Hz tick 周期（ms）。 */
export const TICK_PERIOD_MS = 1000 / 64; // 15.625

/** setTimeout(4) 自驱档 ε_max（ms）：量化 <4ms + 事件循环迟到余量 ~4ms。 */
export const EPSILON_MAX_SETTIMEOUT_MS = 8;

/** Atomics.wait 精确唤醒档 ε_max（ms）：ε<1ms——排序门取严格界 1ms。 */
export const EPSILON_MAX_ATOMICS_MS = 1;

/**
 * 排序门静态上界：δ ≤ T − ε_max（t6 §8.1 排序不变量的 δ cap 形态）。
 * ε_max ≥ T 或非有限（负数/NaN——无可靠上界即不授早窗）→ 返回 0
 * （退化为 pure-history）。
 */
export function deriveLeadCapMs(tickPeriodMs: number, epsilonMaxMs: number): number {
  if (!(epsilonMaxMs >= 0) || !(tickPeriodMs > 0)) return 0;
  return Math.max(0, tickPeriodMs - epsilonMaxMs);
}

/** δ 合法性判定（含边界：δ = cap 恰好满足 ≤；δ < 0 非法）。 */
export function isLeadWithinCap(
  leadDeltaMs: number,
  tickPeriodMs: number,
  epsilonMaxMs: number,
): boolean {
  return leadDeltaMs >= 0 && leadDeltaMs <= deriveLeadCapMs(tickPeriodMs, epsilonMaxMs);
}

/** 乐观发布门裁决。 */
export type OptimisticDecision =
  /** 放行：乐观帧可发布（rev=OPT 位随 I_A_EVT 发布；消费器按 OPT 位走
   * 直出+修订即撤路径）。 */
  | 'publish'
  /** ε 尾：发布已越本 tick due → 丢弃（该 tick 回落 pure-history 一拍，
   * lead-miss+1；不是错误，是 §8.1 设计好的退化路径）。 */
  | 'drop-late'
  /** 排序违例：authoritative(label-1) 未发布 → 拒绝（协议违例报警，
   * 稳态设计值 0；非零 = worker 编排缺陷）。 */
  | 'block-order';

/** 遥测计数器（预分配可变对象，面板直读零分配；div 双桶遥测的 lead-miss 源）。 */
export interface OrderingGateStats {
  /** 已放行乐观发布数。 */
  optimisticPublished: number;
  /** ε 尾丢弃数（lead-miss——该 tick 回落 pure-history 一拍）。 */
  leadMiss: number;
  /** 排序违例拒绝数（稳态设计值 0；非零 = worker 编排缺陷）。 */
  blockedOrder: number;
}

export interface OrderingGateOptions {
  /** raw tick 周期 ms（缺省 15.625）。 */
  tickPeriodMs?: number;
  /** 发布延迟上界 ms（缺省 setTimeout 档 8）。 */
  epsilonMaxMs?: number;
  /** 乐观评估提前量 ms（缺省 = cap = T−ε_max，早窗占比 δ/T ≈ 49%，§8.4）。 */
  leadDeltaMs?: number;
}

export interface OrderingGate {
  /** δ 静态上界 T−ε_max（ms）。 */
  readonly capMs: number;
  /** 实际配置的乐观提前量 δ（ms；构造期对 cap 钳制）。 */
  readonly leadDeltaMs: number;
  /** 遥测计数器（就地更新，零分配）。 */
  readonly stats: OrderingGateStats;
  /** 权威帧 label 已发布（worker 每 authoritative 发布后调用——排序锚）。 */
  noteAuthoritative(label: number): void;
  /**
   * 乐观发布门：label=k 的乐观帧在 nowMs 的发布尝试（dueMs = 该 tick 网格
   * due 时刻 t_k）。判定序：①排序不变量（动态）②ε 尾发布门。
   */
  authorizeOptimistic(label: number, nowMs: number, dueMs: number): OptimisticDecision;
}

/**
 * 构造排序门。δ 缺省 = cap（严格界内最大化早窗）；显式越界配置钳到 cap
 * （§8.4「双量子 8 由排序门吸收」同款纪律——硬约束不靠调用方自觉）。
 *
 * 分账（§8.5 对齐，t2 裁定文档③修订——用例集 §2 管线计数器合账）：
 * - **leadMiss = unordered + late 合账**（=「停顿杀死领先」= P(停顿 > δ)）：
 *   auth(label−1) 发布停顿未发（unordered，主机制）+ 乐观径自身 ε 尾越 due
 *   （late，次要机制）。div 双桶遥测的 lead-miss 源。
 * - **blockedOrder = superseded 专账**（= 编排缺陷报警面，稳态设计值 0）：
 *   auth(label) 已发（真值抢先）或锚回跳——只在「auth(label−1) 已发且
 *   auth(label) 也已发」的不可达路径报警。引导期无锚（lastAuthoritative=null）
 *   归 leadMiss（自启动以来 auth 未到 = 停顿，回落 pure-history 一拍）。
 * - **同因互斥**（仿真不变量③）：auth 单调发布 ⇒ superseded 与 unordered
 *   不可同时真——分账完备（闭账 = published + leadMiss + blockedOrder ≡ 尝试数）。
 * - 动作面（返回值）保持三值不变：拒发统一 'block-order'（消费端按动作处理，
 *   分账走 stats 遥测，API 变更最小）。
 */
export function createOrderingGate(options: OrderingGateOptions = {}): OrderingGate {
  const tickPeriodMs = options.tickPeriodMs ?? TICK_PERIOD_MS;
  const epsilonMaxMs = options.epsilonMaxMs ?? EPSILON_MAX_SETTIMEOUT_MS;
  const capMs = deriveLeadCapMs(tickPeriodMs, epsilonMaxMs);
  const leadDeltaMs =
    options.leadDeltaMs === undefined
      ? capMs
      : Math.max(0, Math.min(capMs, options.leadDeltaMs));
  const stats: OrderingGateStats = { optimisticPublished: 0, leadMiss: 0, blockedOrder: 0 };
  /** 最新已发布权威 tick label（null = 尚无权威帧——optimistic(0) 无
   * authoritative(-1) 锚，必拒；首个可放行乐观 label = 1）。 */
  let lastAuthoritative: number | null = null;
  return {
    capMs,
    leadDeltaMs,
    stats,
    noteAuthoritative(label: number): void {
      // 更新性判定 i32 wrap-safe：i32 距离 (label − last)|0 > 0 = 「更新」
      //（SG-S3a：回绕后 i32min 仍正确接替 i32max；排除全量回绕歧义由
      // >0 判定天然满足——全量回绕距离为负）。
      if (lastAuthoritative === null || ((label - lastAuthoritative) | 0) > 0) {
        lastAuthoritative = label;
      }
    },
    authorizeOptimistic(label: number, nowMs: number, dueMs: number): OptimisticDecision {
      // ① 排序不变量（动态兜底）：authoritative(label-1) 必须已发布——
      //    prev = (label−1)|0（i32 wrap-safe，SG-S3a：prev(i32min)=i32max）。
      //    分账细分（§8.5）：superseded（auth(label) 已发 = i32 距离
      //    (last − label)|0 ≥ 0）→ blockedOrder 专账；unordered（auth(label−1)
      //    停顿未发 / 引导期无锚）→ leadMiss 主机制。
      const prev = (label - 1) | 0;
      if (lastAuthoritative === null || lastAuthoritative !== prev) {
        if (lastAuthoritative !== null && ((lastAuthoritative - label) | 0) >= 0) {
          stats.blockedOrder++; // superseded：真值抢先/锚回跳（编排缺陷面，稳态 0）
        } else {
          stats.leadMiss++; // unordered：auth(label−1) 停顿 / 引导期无锚（§8.5）
        }
        return 'block-order';
      }
      // ② ε 尾发布门：乐观发布已越过本 tick 网格 due → 丢弃（回落 pure-history）
      if (nowMs > dueMs) {
        stats.leadMiss++;
        return 'drop-late';
      }
      stats.optimisticPublished++;
      return 'publish';
    },
  };
}
