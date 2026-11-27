/**
 * 共享「固定步长模拟时钟」（`src/ts-shared/app/`）。
 *
 * 定位：给主线程预测/游戏逻辑提供**与 rAF 解耦的固定步长泵**。三端共用一份实现：
 * debug / game 的主线程预测循环接入，viewer 无物理、只沿用 HUD 口径。本文件只导出工厂
 * `createSimClock` 与相关类型，不含 DOM / 三方依赖。
 *
 * 语义：
 * - 有效频率 `rate = 1 / min(getTargetHz(), getCapHz?.() ?? getTargetHz())`，步长恒为 `dt = 1 / rate`（秒）。
 *   目标/上限每次唤醒都重新读取，面板改值下一拍生效（换频发生在两次唤醒之间，不跳步、不补错步）。
 * - 用「墙钟累计器 + 固定步长」补步：欠账够一个 `dt` 才执行一步，余数留在累计器里。因此
 *   唤醒频率的抖动/量化（计时器钳制、窗口节流）**不影响计算步频**，只影响延迟分布。
 * - 单次唤醒最多补 `MAX_STEPS_PER_PUMP`（64）步；欠账最多背 `maxCatchUpMs`（默认 50ms，且不小于
 *   一个步长：否则频率低于 `1/maxCatchUpMs` 时永远攒不够一步）。
 *   超上限的欠账直接丢弃：页面后台被浏览器节流后恢复时，不会出现「几千步补帧风暴」。
 * - `stats.actualHz` 用最近 1s 窗口内的步数算，供 HUD / 验收「计算 Hz 达标 ±10%」。
 *
 * 与 rAF 的关系：
 * - 本时钟不消费、也不依赖 rAF 时间戳。rAF 仍只负责**呈现**：每个呈现帧取最新模拟状态渲染，
 *   呈现 fps 由显示器/rAF 决定；本模块只负责**计算频率**（compute Hz）。
 * - 典型接法（P1，debug/game 主线程）：`PlayerPresentation.step(dtSeconds)`（见
 *   `src/ts-shared/app/player-presentation.ts` 的 `step`，专为固定步长时钟预留）作为本时钟的
 *   `step` 回调；rAF tick 里不再用 `update(now)` 的墙钟 dt 推进预测物理，只做呈现。
 *   调用方可用 `running` 判断本时钟是否在跑（在跑就不再走 rAF 变步长兜底）。
 * - 调用方（renderer-main 的预测循环 / HUD）读 `stats`：`targetHz`/`capHz`/`actualHz` 是计算口径，
 *   呈现 fps 由各自 rAF 侧另行统计。
 * - 频率来源由调用方注入（`getTargetHz` / `getCapHz`）：面板「计算帧率上限」默认 = 实测 rAF
 *   频率 ×1.5（取不到则 480Hz，见 2026-11-19 owner 决策）。本模块不读配置、不写配置。
 *
 * 驱动（scheduler）：
 * - 默认调度器 = `MessageChannel` + `setTimeout` 混合，各自只承担擅长的语义：
 *   - 消息往返（`post`）只有「尽快」语义、没有延迟语义：用于①欠账时**立即续跑**（不阻塞当前
 *     任务）、②累计器已欠账时立刻补步。消息任务不受计时器 ~4ms 钳制。
 *   - 等待本身交给 `setTimeout`（粗粒度、可能晚到几毫秒）：因为补步靠累计器而不是「一次唤醒
 *     一步」，4ms 粒度下仍能达到 480/640Hz 的**计算步频**（每次唤醒补 2–3 步）。
 *     纯消息自旋虽然可以做到每步独立唤醒，但 480Hz 下每步要几十次往返，会持续占用主线程，
 *     所以默认不采用；需要更小唤醒延迟时可注入自定义 `scheduler`（例如自旋泵）。
 * - `MessageChannel` 用 `globalThis` 探测（不直接依赖 DOM 类型）。探测不到时（少数嵌入式环境）
 *   退化到 `setTimeout(0)` 派发「尽快」回调，`start()` 仍可用，只是唤醒粒度受 4ms 钳制；
 *   也可以完全不 start、只调 `pump(nowMs)` 手动推进（Node 自测 / 回放）。
 *
 * 后台节流时的降级行为（页面隐藏/被遮挡/窗口失焦）：
 * - 浏览器会把计时器节流到秒级；本模块不监听 visibilitychange（保持无 DOM 依赖）。唤醒变少后
 *   每醒一次按 `maxCatchUpMs` 截断欠账补步（默认最多补 50ms），计算频率自然降到「计时器允许的
 *   频率 × 截断后的补步量」，**不抛错、不卡死**；恢复前台后从截断点继续，不补历史欠账。
 * - 需要「后台完全暂停」时由调用方在 visibilitychange 里 `stop()` / `start()`，本模块不做。
 *
 * 生命周期与错误：
 * - `start()` / `stop()` 幂等；`start()` 复位时基与累计器（丢弃停止期间经过的时间），
 *   `steps` 一直累计不清零（需要区间值请调用方做差）。
 * - `step` 回调抛错时自动泵停止（`stop()` 清理排程）并把错误继续抛给宿主，避免每个唤醒重复
 *   刷屏；修好后由调用方重新 `start()`。
 * - `pump(nowMs)` 可在未 start 时调用（测试/回放/单步），返回本拍执行的步数；运行中手动 pump
 *   只推进一拍，不改变自动泵的排程。`nowMs` 缺省取 `performance.now()`，非法/回拨按「经过 0」处理。
 *   首次 `pump` 只建立时基（不把「创建 → 首次推进」的间隔算进欠账），便于用假时钟做确定性测试；
 *   `start()` 会自行复位时基。
 *
 * 边界：
 * - 纯 TS、无三方依赖；权威物理 Worker 自己的固定步长是另一条线（`src/ts-shared/auth/auth-loop.ts`），
 *   本模块只服务主线程预测/游戏逻辑。
 * - 历史教训：不要用帧计数当时间（`src/ts-shared/gameplay/entity-gameplay.ts:206-208`）；
 *   本模块唯一时间基准是调用方给的毫秒时间戳（缺省 `performance.now()`）。
 * - 防御性上限 `MAX_RATE_HZ = 2000`：配置再高也按 2000Hz 计，避免 `dt` 过小导致欠账补步无限细分、
 *   把主线程拖进「每拍补 64 步仍然追不上」的自旋。面板量程建议 48–1000，正常不会触顶。
 *
 * 测试归属：`.tmp/simclock/sim-clock.test.mjs`（Node 直跑；假时钟 `pump` 为主，含真实泵冒烟）。
 * 类型门：`cd apps/debug && npx tsc --noEmit`（`apps/debug/tsconfig.json` 的 include 覆盖本文件）。
 */

// ── 类型：调度器（只依赖最小结构，不绑定 DOM 的 MessagePort 类型） ─────────────────────

/** 消息事件的最小结构（默认调度器只读 `data`，这里不需要完整 MessageEvent）。 */
interface MessageLike {
  readonly data: unknown;
}

/** MessagePort 的最小结构；`unref` 是 Node 的可选扩展（不拖住事件循环的进程退出）。 */
interface MessagePortLike {
  onmessage: ((ev: MessageLike) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
  unref?(): void;
}

/** MessageChannel 的最小结构。 */
interface MessageChannelLike {
  port1: MessagePortLike;
  port2: MessagePortLike;
}

/**
 * 调度器：时钟只需要「尽快」与「延迟」两种排程语义。
 * 默认实现见 `createDefaultScheduler`；测试/桌面壳可注入自定义实现（例如假调度器）。
 */
export interface SimClockScheduler {
  /** 尽快排一次回调（默认走 `MessageChannel` 往返；同一时刻只保留一个未派发回调）。 */
  post(fn: () => void): void;
  /** 延迟 `ms` 后排一次回调（默认 `setTimeout`；可能晚到，时钟用累计器补偿）。 */
  delay(ms: number, fn: () => void): void;
  /** 取消尚未派发的回调（`stop()` 时调用；可选）。 */
  cancel?(): void;
  /** 释放底层资源（默认实现关闭 MessageChannel 两端；可选，可重复调用）。 */
  dispose?(): void;
}

// ── 本模块常量（全部只在文件内使用，不导出） ─────────────────────────────────────────

/** 频率下限（Hz）：非法目标/上限都夹到不低于它，避免 `dt = Infinity`。 */
const MIN_RATE_HZ = 1;
/** 防御性频率上限（Hz）：配置超过 2000 按 2000 计（见文件头「防御性上限」）。 */
const MAX_RATE_HZ = 2000;
/** 默认欠账上限（ms）：后台节流恢复后最多补这么多模拟时间。 */
const DEFAULT_MAX_CATCH_UP_MS = 50;
/** 单次唤醒最多执行的步数：限制单个任务占用（64 步 @480Hz ≈ 133ms 模拟时间）。 */
const MAX_STEPS_PER_PUMP = 64;
/** `stats.actualHz` 的滚动窗口（ms）。 */
const ACTUAL_WINDOW_MS = 1000;
/** 单次粗等待（setTimeout）的上限（ms）：目标频率上调后最多这么久重新取舍。 */
const MAX_TIMER_WAIT_MS = 25;
/** 频率采样点上限（防御异常长窗口；正常 480Hz 窗口内约 480 点）。 */
const MAX_RATE_SAMPLES = 2048;

// ── 默认调度器：MessageChannel（尽快）+ setTimeout（延迟） ────────────────────────────

/**
 * 构造默认调度器。
 * - `post` 优先走 `MessageChannel` 两端往返：任务派发不受计时器 4ms 钳制，用于欠账续跑/立即补步；
 *   无 `MessageChannel` 时退化到 `setTimeout(0)`（粒度差但语义相同）。
 * - `delay` 走 `setTimeout`：只用于「等待」，允许晚到，由累计器补偿。
 */
function createDefaultScheduler(): SimClockScheduler {
  // globalThis 探测：Node 18+/浏览器都有 MessageChannel；用临时结构类型避免依赖 DOM 声明。
  const globalLike = globalThis as unknown as { MessageChannel?: new () => MessageChannelLike };
  const ChannelCtor = globalLike.MessageChannel;
  const channel = typeof ChannelCtor === 'function' ? new ChannelCtor() : null;

  /** 未派发的「尽快」回调；同一时刻只有一个（排程合并）。 */
  let pending: (() => void) | null = null;
  /** 未到期的延迟回调句柄。 */
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 无 MessageChannel 时 `post` 的退化句柄。 */
  let immediate: ReturnType<typeof setTimeout> | null = null;
  /** `dispose` 之后拒绝一切排程（防止 stop 后迟到的 post 抛错）。 */
  let disposed = false;

  // Node 的 MessagePort 默认会拖住事件循环：unref 后不阻止进程退出，有其它任务时仍会派发。
  channel?.port1.unref?.();
  channel?.port2.unref?.();

  if (channel) {
    channel.port1.onmessage = (): void => {
      const fn = pending;
      pending = null;
      if (fn) fn();
    };
  }

  /** 清掉所有未派发排程（消息在途时靠 `pending` 为空跳过）。 */
  const clearScheduled = (): void => {
    pending = null;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (immediate !== null) {
      clearTimeout(immediate);
      immediate = null;
    }
  };

  /** 派发「尽快」回调（消息回调 / setTimeout(0) 退化路径共用）。 */
  const runPending = (): void => {
    const fn = pending;
    pending = null;
    if (fn) fn();
  };

  return {
    post(fn: () => void): void {
      if (disposed) return;
      clearScheduled();
      pending = fn;
      if (channel) {
        try {
          channel.port2.postMessage(0);
        } catch {
          // 端口已关闭（stop 后迟到的排程）：丢弃即可，不能把异常抛进调用方。
          pending = null;
        }
      } else {
        immediate = setTimeout(() => {
          immediate = null;
          runPending();
        }, 0);
      }
    },
    delay(ms: number, fn: () => void): void {
      if (disposed) return;
      // 作废可能还在队列里的消息：消息派发时发现 pending 为空即跳过。
      pending = null;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    cancel(): void {
      clearScheduled();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearScheduled();
      if (channel) {
        channel.port1.onmessage = null;
        channel.port1.close();
        channel.port2.close();
      }
    },
  };
}

// ── 对外类型 ────────────────────────────────────────────────────────────────────────

/** `createSimClock` 的参数。 */
export interface SimClockOptions {
  /** 执行一个固定步长（秒），`dtSeconds = 1 / 有效频率`；由时钟保证同一步长（换频后整拍切换）。 */
  step(dtSeconds: number): void;
  /** 期望计算频率（Hz）。每次唤醒都重新读取，面板改值下一拍生效。 */
  getTargetHz(): number;
  /** 计算频率上限（Hz）。缺省/非法时按 `getTargetHz()` 计（即上下限相同）。 */
  getCapHz?(): number;
  /** 欠账上限（ms），默认 50；非有限/非正值退回默认。 */
  maxCatchUpMs?: number;
  /** 自定义调度器（测试/桌面壳可注入）；缺省用 `MessageChannel + setTimeout`（见文件头「驱动」）。 */
  scheduler?: SimClockScheduler;
}

/** `stats` 字段（全部为即时读取的 getter，不是快照对象）。 */
export interface SimClockStats {
  /** 期望计算频率（`getTargetHz()` 口径，夹到 `[1Hz, 2000Hz]`）。首次 pump 前为创建时的解析值。 */
  readonly targetHz: number;
  /** 实际上限（`getCapHz?.() ?? getTargetHz()` 口径，夹到 `[1Hz, 2000Hz]`）。 */
  readonly capHz: number;
  /** 最近 1s 窗口内的实际步进频率（Hz）；窗口内不足两个采样点时沿用旧值/0。 */
  readonly actualHz: number;
  /** 自创建以来累计执行的步数（单调递增，含手动 pump）。 */
  readonly steps: number;
  /** 本次唤醒时累计的欠账（ms，截断**前**）：用于诊断节流程度与丢账，不参与执行。 */
  readonly lastOwedMs: number;
}

/** 模拟时钟实例。 */
export interface SimClock {
  /** 启动自动泵；幂等。已启动时直接返回。 */
  start(): void;
  /** 停止自动泵并释放调度器资源；幂等。停止期间经过的时间在下次 `start()` 时丢弃。 */
  stop(): void;
  /** 自动泵是否在跑（renderer 用它判断「本时钟驱动」还是「rAF 变步长兜底」）。 */
  readonly running: boolean;
  /** 尚未攒够一个步长的累计余量（ms，取值 `[0, 1000/rateHz)`），供渲染插值计算精确仿真相位。 */
  readonly pendingMs: number;
  /**
   * 手动推进一拍（测试/回放/单步）。
   * @param nowMs 毫秒时间戳；缺省取 `performance.now()`。非法值/回拨按「本拍经过 0」处理。
   * @returns 本拍实际执行的步数。
   */
  pump(nowMs?: number): number;
  /** 频率/步数/欠账统计（getter，实时读取）。 */
  readonly stats: SimClockStats;
  /** 注册有效频率变化回调（传 null 取消）。在频率发生变化的那一拍、执行步进之前调用。 */
  setOnRate(cb: ((rateHz: number) => void) | null): void;
}

// ── 工厂实现 ────────────────────────────────────────────────────────────────────────

interface ResolvedFreq {
  /** 期望频率（已夹到合法域）。 */
  targetHz: number;
  /** 实际上限（未配置时等于期望频率；已夹到合法域）。 */
  capHz: number;
  /** 有效频率 = min(targetHz, capHz)。 */
  rateHz: number;
}

/**
 * 创建固定步长模拟时钟（闭包工厂；所有状态私有，无其它实例级全局状态）。
 *
 * 调用顺序契约：`step` 回调里不要再 `pump()` / `start()` / `stop()` 本实例（重入）；需要换频请
 * 改 `getTargetHz` / `getCapHz` 的返回值（下一拍生效）。`step` 抛错会停止自动泵，见文件头。
 */
export function createSimClock(options: SimClockOptions): SimClock {
  const stepFn = options.step;

  /** 墙钟毫秒源：浏览器/Node 18+ 都有 performance.now；极端环境退回 Date.now。 */
  const wallNow = (): number =>
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

  /** 欠账上限（ms）：非法/非正退回默认值。 */
  function resolveMaxCatchUpMs(): number {
    const raw = options.maxCatchUpMs;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_CATCH_UP_MS;
    return raw;
  }
  const maxCatchUpMs = resolveMaxCatchUpMs();

  // ── 运行状态（闭包私有） ────────────────────────────────────────────────────────
  /** 上一次 pump 的毫秒时间戳（墙钟基准）。 */
  let lastNowMs = wallNow();
  /** 是否已建立手动 pump 时基：首次 `pump` 只记基准（见文件头「pump」段）。 */
  let timebaseReady = false;
  /** 固定步长欠账（ms）：不足一步的余数留在这里，跨唤醒累积。 */
  let accMs = 0;
  /** 累计执行步数（单调递增，不清零）。 */
  let stepsTotal = 0;
  /** 最近一次 pump 时累计的欠账（ms，截断前）。 */
  let lastOwedMs = 0;
  /** 最近一次解析出的期望频率（Hz）。 */
  let targetHz = MIN_RATE_HZ;
  /** 最近一次解析出的实际上限（Hz）。 */
  let capHz = MIN_RATE_HZ;
  /** 最近一次解析出的有效频率（Hz）。 */
  let rateHz = MIN_RATE_HZ;
  /** 最近 1s 窗口的步数采样环形缓冲：O(1) 零分配，避免 1000Hz 下每拍分配对象与 shift()。 */
  const sampleAt = new Float64Array(MAX_RATE_SAMPLES);
  const sampleCount = new Int32Array(MAX_RATE_SAMPLES);
  let sampleHead = 0;
  let sampleLen = 0;
  let sampleSum = 0;
  const freqScratch: ResolvedFreq = { targetHz: MIN_RATE_HZ, capHz: MIN_RATE_HZ, rateHz: MIN_RATE_HZ };
  /** 滚动窗口内的实际步频（Hz）。 */
  let actualHz = 0;
  /** 有效频率变化回调。 */
  let onRate: ((rateHz: number) => void) | null = null;
  /** 自动泵是否在跑。 */
  let running = false;
  /** 调度器句柄（惰性创建）。 */
  let scheduler: SimClockScheduler | null = null;
  /** 句柄是否由本模块创建（是则 stop 时负责 dispose）。 */
  let schedulerOwned = false;

  /** 解析期望/上限/有效频率。非法目标沿用上次有效值；上限非法/缺省按目标计。 */
  function resolveFreq(): ResolvedFreq {
    const rawTarget = Number(options.getTargetHz());
    let target = Number.isFinite(rawTarget) ? rawTarget : targetHz;
    if (!(target > 0)) target = MIN_RATE_HZ;
    if (target < MIN_RATE_HZ) target = MIN_RATE_HZ;
    else if (target > MAX_RATE_HZ) target = MAX_RATE_HZ;

    let cap = target;
    if (options.getCapHz) {
      const rawCap = Number(options.getCapHz());
      if (Number.isFinite(rawCap) && rawCap > 0) {
        cap = Math.max(MIN_RATE_HZ, Math.min(rawCap, MAX_RATE_HZ));
      }
    }
    freqScratch.targetHz = target;
    freqScratch.capHz = cap;
    freqScratch.rateHz = Math.min(target, cap);
    return freqScratch;
  }

  // 构造时先解析一次，让 stats 在首次 pump 前也有有意义的值。
  {
    const initial = resolveFreq();
    targetHz = initial.targetHz;
    capHz = initial.capHz;
    rateHz = initial.rateHz;
  }

  /** 记录一拍执行结果并刷新 `actualHz`：窗口 = 最早样本 → 当前拍，边界样本计入跨度但不计步数。 */
  function recordRateSample(atMs: number, count: number): void {
    if (count > 0) {
      if (sampleLen === MAX_RATE_SAMPLES) {
        sampleSum -= sampleCount[sampleHead];
        sampleHead = (sampleHead + 1) % MAX_RATE_SAMPLES;
        sampleLen--;
      }
      const tail = (sampleHead + sampleLen) % MAX_RATE_SAMPLES;
      sampleAt[tail] = atMs;
      sampleCount[tail] = count;
      sampleLen++;
      sampleSum += count;
    }
    while (sampleLen > 2 && atMs - sampleAt[sampleHead] > ACTUAL_WINDOW_MS) {
      sampleSum -= sampleCount[sampleHead];
      sampleHead = (sampleHead + 1) % MAX_RATE_SAMPLES;
      sampleLen--;
    }
    if (sampleLen < 2) {
      actualHz = 0;
      return;
    }
    const counted = sampleSum - sampleCount[sampleHead];
    const spanMs = atMs - sampleAt[sampleHead];
    if (spanMs > 0) actualHz = (counted * 1000) / spanMs;
  }

  /** 一拍的核心：解析频率 → 结欠账（截断）→ 补固定步长（步数上限）→ 记统计。返回执行的步数。 */
  function pumpInternal(nowMsArg?: number): number {
    const now = typeof nowMsArg === 'number' && Number.isFinite(nowMsArg) ? nowMsArg : wallNow();

    // 0) 首次手动推进只建立时基：创建到首次 pump 的间隔不可见，不计入欠账。
    if (!timebaseReady) {
      timebaseReady = true;
      lastNowMs = now;
    }

    // 1) 频率每次唤醒重新解析：面板改值下一拍生效；变化时通知调用方。
    const freq = resolveFreq();
    targetHz = freq.targetHz;
    capHz = freq.capHz;
    if (freq.rateHz !== rateHz) {
      rateHz = freq.rateHz;
      if (onRate) onRate(rateHz);
    }
    const dtMs = 1000 / rateHz;

    // 2) 墙钟欠账：回拨/同一时刻/非法值按 0 处理（不让负值倒扣累计器）。
    let elapsedMs = now - lastNowMs;
    if (!(elapsedMs > 0)) elapsedMs = 0;
    lastNowMs = now;

    // 3) 欠账截断：超过上限的部分直接丢弃（后台节流恢复后的补帧上限）。
    //    上限不小于一个步长：否则频率低于 1/maxCatchUpMs 时永远攒不够一步（例如目标 1Hz 时）。
    const catchUpLimitMs = Math.max(maxCatchUpMs, dtMs);
    let owedMs = accMs + elapsedMs;
    lastOwedMs = owedMs;
    if (owedMs > catchUpLimitMs) owedMs = catchUpLimitMs;

    // 4) 固定步长补步：单拍最多 MAX_STEPS_PER_PUMP 步；余数留在累计器里（跨拍会继续补）。
    let steps = Math.floor(owedMs / dtMs);
    if (!Number.isFinite(steps) || steps < 0) steps = 0;
    else if (steps > MAX_STEPS_PER_PUMP) steps = MAX_STEPS_PER_PUMP;
    accMs = owedMs - steps * dtMs;
    if (accMs > catchUpLimitMs) accMs = catchUpLimitMs;

    // 5) 执行步进（异常直接抛给调用方；自动泵由 onWake 负责清理）。
    if (steps > 0) {
      const dtSeconds = 1 / rateHz;
      for (let i = 0; i < steps; i++) {
        stepFn(dtSeconds);
        stepsTotal += 1;
      }
      recordRateSample(now, steps);
    }
    return steps;
  }

  /** 取/建调度器（默认实现总可用：无 MessageChannel 时退化到 setTimeout(0)）。 */
  function ensureScheduler(): SimClockScheduler {
    if (scheduler) return scheduler;
    if (options.scheduler) {
      scheduler = options.scheduler;
      schedulerOwned = false;
    } else {
      scheduler = createDefaultScheduler();
      schedulerOwned = true;
    }
    return scheduler;
  }

  /** 取消排程并释放调度器（仅默认调度器负责 dispose；注入的由注入方管理生命周期）。 */
  function releaseScheduler(): void {
    if (!scheduler) return;
    scheduler.cancel?.();
    if (schedulerOwned) scheduler.dispose?.();
    scheduler = null;
    schedulerOwned = false;
  }

  /** 安排下一次唤醒：已欠账立即续跑（消息往返），否则交给计时器等待。 */
  function scheduleNext(): void {
    if (!running) return;
    const drv = scheduler;
    if (!drv) return;
    const resolved = resolveFreq();
    const waitMs = 1000 / resolved.rateHz - accMs;
    if (!(waitMs > 0)) {
      drv.post(onWake); // 立即续跑：不阻塞当前任务，也不受计时器 4ms 钳制
      return;
    }
    // 粗等待（上限 25ms 保证频率上调及时生效）；晚到由累计器在下一拍补回。
    drv.delay(Math.min(waitMs, MAX_TIMER_WAIT_MS), onWake);
  }

  /** 自动泵的唤醒入口（计时器/消息共用）。 */
  function onWake(): void {
    if (!running) return;
    try {
      pumpInternal();
    } catch (err) {
      stop(); // 步进抛错：停止自动泵（避免每个唤醒重复刷错），错误继续抛给宿主
      throw err;
    }
    if (running) scheduleNext();
  }

  // ── 对外生命周期 ────────────────────────────────────────────────────────────────
  function start(): void {
    if (running) return;
    ensureScheduler();
    running = true;
    // 复位时基：停止/未启动期间经过的时间不计入欠账（回放/换图后不会突然补帧）。
    lastNowMs = wallNow();
    timebaseReady = true;
    accMs = 0;
    lastOwedMs = 0;
    sampleHead = 0;
    sampleLen = 0;
    sampleSum = 0;
    actualHz = 0;
    const resolved = resolveFreq();
    targetHz = resolved.targetHz;
    capHz = resolved.capHz;
    rateHz = resolved.rateHz;
    scheduleNext();
  }

  function stop(): void {
    const wasRunning = running;
    running = false;
    releaseScheduler();
    if (!wasRunning) return; // 幂等：未启动时只做资源清理
    lastNowMs = wallNow();
    accMs = 0;
    lastOwedMs = 0;
    sampleHead = 0;
    sampleLen = 0;
    sampleSum = 0;
    actualHz = 0;
  }

  const stats: SimClockStats = {
    get targetHz(): number {
      return targetHz;
    },
    get capHz(): number {
      return capHz;
    },
    get actualHz(): number {
      return actualHz;
    },
    get steps(): number {
      return stepsTotal;
    },
    get lastOwedMs(): number {
      return lastOwedMs;
    },
  };

  return {
    start,
    stop,
    get running(): boolean {
      return running;
    },
    get pendingMs(): number {
      return accMs;
    },
    pump(nowMsArg?: number): number {
      return pumpInternal(nowMsArg);
    },
    stats,
    setOnRate(cb: ((rateHz: number) => void) | null): void {
      onRate = cb;
    },
  };
}
