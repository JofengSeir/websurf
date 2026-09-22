/**
 * 乐观发布排序门：在「乐观帧先发、权威帧后到」的双链下裁决每一次乐观发布尝试。
 *
 * ## 定位与消费点
 * 唯一生产消费方是 `src/ts-shared/auth/tick-authority.ts`：它用 `createOrderingGate`
 * 建门（ε 取 `EPSILON_MAX_SETTIMEOUT_MS`），每发一帧权威结果调一次 `noteAuthoritative`，
 * 每次要发乐观帧前调一次 `authorizeOptimistic`。测试见
 * `src/ts-shared/tick/ordering-gate.test.ts`（`deriveLeadCapMs` / `isLeadWithinCap`
 * 目前只有测试引用）。
 * 本模块是纯函数 + 闭包计数：不注册计时器、不做 IO、每次调用不新建对象。
 *
 * ## 静态约束：δ + ε_max ≤ T
 * 记 T = `tickPeriodMs`（raw tick 周期）、ε_max = `epsilonMaxMs`（发布延迟上界）、
 * δ = `leadDeltaMs`（乐观评估提前量）。`deriveLeadCapMs` 给出 δ 的上界 `T − ε_max`；
 * `isLeadWithinCap` 是同一判据的判定形式，**含等号**（δ 恰等于上界合法），且 δ < 0 非法。
 * 构造期把显式传入的 δ 钳进 `[0, cap]`，不传则直接取 cap。
 *
 * ## 运行时裁决（`authorizeOptimistic(label, nowMs, dueMs)`）
 * 按序三次判定，**每次调用恰好命中一个计数器**，故三计数之和恒等于调用次数：
 * 1. 锚点必须是**正好**的前一 tick：`noteAuthoritative` 记录的最新 label 等于
 *    `(label - 1) | 0`。不等则拒发 `'block-order'`，并再分两种账：
 *    已有锚且锚不早于本 label（真值抢先 / 锚回跳）→ `blockedOrder`；
 *    尚无锚或权威帧停顿未发 → `leadMiss`。
 * 2. 过了锚点再看发布时刻：`nowMs > dueMs` 即已越过该 tick 网格 → `'drop-late'`，
 *    `leadMiss` 自增（这是设计好的退化路径，不是错误）。
 * 3. 其余 → `'publish'`，`optimisticPublished` 自增。
 *
 * ## 标签算术按 i32 回绕
 * `(label - 1) | 0` 与 `(lastAuthoritative - label) | 0` 都是 i32 运算，
 * 因此 label 从 `2^31 − 1` 回绕到 `-2^31` 时「前一 tick」仍判得出来。
 * `noteAuthoritative` 只在 `(label - last) | 0 > 0` 时前移锚点，重复或回退的标签被忽略。
 */

/** raw 64Hz 的 tick 周期（ms）。等价写法见 `src/ts-shared/tick/tick-consumer.ts` 的同名常量。 */
export const TICK_PERIOD_MS = 1000 / 64; // 15.625

/** 自驱档（setTimeout 唤醒）的发布延迟上界 ε_max（ms）：定时器量化 + 事件循环迟到余量。 */
export const EPSILON_MAX_SETTIMEOUT_MS = 8;

/** 精确唤醒档（Atomics 等待）的发布延迟上界 ε_max（ms）：取严格界 1。 */
export const EPSILON_MAX_ATOMICS_MS = 1;

/**
 * 排序门的 δ 上界：`max(0, tickPeriodMs − epsilonMaxMs)`。
 *
 * 两个入参都先做「非有限即拒」的防御：`epsilonMaxMs` 为负或 NaN、或 `tickPeriodMs`
 * 非正或 NaN 时返回 0，即不授予任何提前量。
 *
 * @param tickPeriodMs raw tick 周期 T（ms）。
 * @param epsilonMaxMs 发布延迟上界 ε_max（ms）。
 * @returns δ 的合法上界（ms）。
 */
export function deriveLeadCapMs(tickPeriodMs: number, epsilonMaxMs: number): number {
  if (!(epsilonMaxMs >= 0) || !(tickPeriodMs > 0)) return 0;
  return Math.max(0, tickPeriodMs - epsilonMaxMs);
}

/**
 * δ 合法性判定：`δ ≥ 0` 且 `δ ≤ cap`（边界含等号）。
 *
 * @param leadDeltaMs 待判的提前量 δ（ms）。
 * @param tickPeriodMs raw tick 周期 T（ms）。
 * @param epsilonMaxMs 发布延迟上界 ε_max（ms）。
 * @returns 是否落在合法区间内。
 */
export function isLeadWithinCap(
  leadDeltaMs: number,
  tickPeriodMs: number,
  epsilonMaxMs: number,
): boolean {
  return leadDeltaMs >= 0 && leadDeltaMs <= deriveLeadCapMs(tickPeriodMs, epsilonMaxMs);
}

/** `authorizeOptimistic` 的裁决结果（动作面只有这三个值）。 */
export type OptimisticDecision =
  /** 放行：乐观帧可发布（随发布写入乐观标记位，消费端据此走「先直出、权威修订到达即撤」）。 */
  | 'publish'
  /** 发布时刻已越过本 tick 网格：丢弃该乐观帧，该 tick 退回不带领先的路径，
   * `leadMiss` 自增。 */
  | 'drop-late'
  /** 排序违例：锚点不是正好前一 tick → 拒绝发布。稳态下应恒为 0，非零表示编排侧有缺陷。 */
  | 'block-order';

/** 遥测计数器：就地自增的可变对象，面板可直接读，不产生分配。 */
export interface OrderingGateStats {
  /** 已放行的乐观发布数。 */
  optimisticPublished: number;
  /** ε 尾丢弃数 + 锚点未到数（两者合账，统称 lead-miss）。 */
  leadMiss: number;
  /** 排序违例拒发数（真值抢先 / 锚回跳；稳态应为 0）。 */
  blockedOrder: number;
}

/** 建门参数；三项都可省，缺省值见 `createOrderingGate`。 */
export interface OrderingGateOptions {
  /** raw tick 周期 ms（缺省 `TICK_PERIOD_MS`）。 */
  tickPeriodMs?: number;
  /** 发布延迟上界 ms（缺省 `EPSILON_MAX_SETTIMEOUT_MS`）。 */
  epsilonMaxMs?: number;
  /** 乐观评估提前量 δ（ms）；缺省取 cap，显式越界值构造期钳到 cap。 */
  leadDeltaMs?: number;
}

/** 排序门实例。除 `stats` 外全部只读，`stats` 就地更新。 */
export interface OrderingGate {
  /** 本门生效的 δ 上界 `T − ε_max`（ms）。 */
  readonly capMs: number;
  /** 本门实际使用的 δ（ms，已按 cap 钳制）。 */
  readonly leadDeltaMs: number;
  /** 遥测计数器（就地更新，零分配）。 */
  readonly stats: OrderingGateStats;
  /** 记录一帧权威结果已发布，label 为它的 tick 标号（排序锚）。 */
  noteAuthoritative(label: number): void;
  /**
   * 乐观发布门：label=k 的乐观帧在 nowMs 时刻尝试发布，dueMs 为该 tick 网格的应发时刻。
   * 判定序见文件头（先锚点、后 ε 尾）。
   */
  authorizeOptimistic(label: number, nowMs: number, dueMs: number): OptimisticDecision;
}

/**
 * 构造排序门。
 *
 * 缺省配置为自驱档：T = `TICK_PERIOD_MS`、ε_max = `EPSILON_MAX_SETTIMEOUT_MS`、
 * δ = cap。显式传入的 δ 被钳进 `[0, cap]`——越界配置由构造期吸收，不依赖调用方自觉。
 *
 * 三个计数器从 0 起；锚点 `lastAuthoritative` 初值为 `null`，此时任何乐观发布都会被
 * 判为 `'block-order'` 并计入 `leadMiss`（首个可放行的乐观 label 是 1，它需要
 * `noteAuthoritative(0)` 先落地）。
 *
 * @param options 可选配置，见 `OrderingGateOptions`。
 * @returns 排序门实例。
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
  /** 最新已发布的权威 tick 标号；null 表示尚无权威帧——此时乐观发布无锚可依，必拒。 */
  let lastAuthoritative: number | null = null;
  return {
    capMs,
    leadDeltaMs,
    stats,
    noteAuthoritative(label: number): void {
      // 只在 i32 意义上「更新」时前移：回绕后仍成立（i32min 可接替 i32max），
      // 重复或更旧的标号不改变锚点。
      if (lastAuthoritative === null || ((label - lastAuthoritative) | 0) > 0) {
        lastAuthoritative = label;
      }
    },
    authorizeOptimistic(label: number, nowMs: number, dueMs: number): OptimisticDecision {
      // ① 锚点判定：期望锚 = 前一 tick（i32 回绕安全：prev(i32min) = i32max）。
      //    不等时按「锚是否已不早于本 label」分开计账：是 → 真值抢先/锚回跳（编排缺陷面）；
      //    否 → 尚无锚或权威帧尚未发布（lead-miss 主机制）。
      const prev = (label - 1) | 0;
      if (lastAuthoritative === null || lastAuthoritative !== prev) {
        if (lastAuthoritative !== null && ((lastAuthoritative - label) | 0) >= 0) {
          stats.blockedOrder++; // 真值抢先 / 锚回跳（稳态应为 0）
        } else {
          stats.leadMiss++; // 无锚引导期，或锚停在更早的标号
        }
        return 'block-order';
      }
      // ② ε 尾判定：发布时刻已过本 tick 网格 → 丢弃（该 tick 退回不带领先的路径）
      if (nowMs > dueMs) {
        stats.leadMiss++;
        return 'drop-late';
      }
      stats.optimisticPublished++;
      return 'publish';
    },
  };
}
