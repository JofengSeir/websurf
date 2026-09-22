/**
 * 标号（tick）权威帧的渲染侧消费器：把上游发布的权威帧按确定性时间网格插值成相机姿态。
 *
 * 定位：tick 协议的读侧末端。本文件只读 `SharedState`，不持有物理实例、不写协议槽——对
 * `shared` 的全部使用就是每次 `consume` 调一次 `readAuthoritativeInto`。
 *
 * 上下游调用点（符号名）
 * - 上游：`src/ts-shared/auth/shared-state.ts` 的 `ShmState.readAuthoritativeInto`（消息
 *   回退路径是同文件的 `MsgState.readAuthoritativeInto`）——它把载荷写进本文件构造期分配
 *   的 `dstF`/`dstI` 并返回样本序号 va。常量 `EYE_STAND` 取自
 *   `src/ts-shared/phys/constants.ts`，只用作 `pose.eyeHeight` 的构造期初值。
 * - 下游：当前工作区内没有装配点——全仓对 `createTickConsumer` 的引用只有本文件的定义
 *   本身。消费面由 `TickConsumer.consume` 的三值返回与 `TickConsumer.pose` 界定。
 *
 * 关键不变量
 * - 显示时间单调：`tauDisplay` 只经 `Math.max` 前进，能把它调小的只有显式重锚
 *   （`reanchorTau`）与 `deactivate`；被钳住的那次调用计入 `stats.tauClamp`。
 * - 零外推：本文件从不读 `dstF` 的 vel 槽位；直出与冻结都只搬运已发布的姿态字段，不存在
 *   「上一姿态 + 速度 × dt」这类推演。
 * - 端点校验：插值要求高槽标号等于 `kCur`、低槽标号等于 `(kCur − 1) | 0`，且两槽段号都等于
 *   `lastSeg`；任一不成立即冻结，不做半段插值。
 * - 新帧门：入环、时钟锚采样、断窗判定、乐观与修订记账只在 `isNew`（本轮 va 与上次不同）上
 *   执行一次；τ 推进、端点校验、Δ 恢复计数每次调用都执行。
 * - 时钟锚只由修订帧推进：`insertRevision` 是唯一增量写入 `t0Est` 的路径；乐观帧不进环、
 *   不改 `lastRevTick`、不更新 `t0Est`。
 * - 零堆分配：环形槽、`dstF`/`dstI`、姿态与两个遥测对象全部构造期一次分配；`consume` 路径
 *   不构造对象、数组或闭包，姿态是原地覆写。
 *
 * 边界与容错
 * - 读返回 0（通道未开始）或 −1（读写冲突）时立即早退：不采信帧内容、不更新新帧判据、不计
 *   冻结计数，返回 `'hold'`（尚无姿态）或 `'frozen'`（保留上一产出）；冲突另计
 *   `stats.readConflictSkip`。
 * - 端点对不上（含刚播种后的第一段区间）与「下一标号未及时发布」走同一条冻结分支：情形 B
 *   的判据就是端点校验失败，不区分成因。
 * - 环形寻址用字面量掩码 `& 15`（四处），与导出的 `RING_CAP` 是两个独立出处；两者必须同为
 *   16，改 `RING_CAP` 不会改变掩码。
 * - `deactivate` 不重置 `lastSeg`：再入时若段号与停机前相同，则不触发断窗分支，直接按播种
 *   处理。
 * - 角度短弧插值只作用于 yaw，且结果不归一化（见 `lerpAngleDeg`）。
 *
 * 测试归属：工作区内没有测试文件引用本文件；同目录 `src/ts-shared/tick/ordering-gate.test.ts`
 * 只覆盖 `ordering-gate.ts` 的导出面。三个工程的 tsconfig 都把 `src/ts-shared` 目录下的
 * 全部 `.ts` 纳入 include，故本文件的类型面由 `apps/debug`、`apps/game`、`apps/viewer` 的 `npm run typecheck`
 * 共同把关。
 *
 * 与相邻文件的边界
 * - `src/ts-shared/tick/ordering-gate.ts`：只做发布侧排序裁决（`createOrderingGate`），自带
 *   一份同值的 `TICK_PERIOD_MS`；本文件不导入它，两侧无符号共享。乐观帧的消费侧处理（直出
 *   + 显示保持 + 修订记账）只落在本文件。
 * - `src/ts-shared/auth/shared-state.ts`：定义 SAB 布局、seqlock 与 `readAuthoritativeInto`
 *   的读写约定；本文件不直接读共享内存槽位，也不读渲染尾槽——`RT_SEQ` / `RT_I0` /
 *   `RT_EPOCH` / `RT_PUB_TAU` / `RT_X` / `RT_Y` / `RT_Z` / `RT_T` 这一组常量在本文件中零引用。
 */

import type { SharedState } from '../auth/shared-state.js';
import { EYE_STAND } from '../phys/constants.js';

/** 标号周期（ms）：`1000 / 64` = 64 Hz。同目录 `ordering-gate.ts` 另有一份同值导出，两侧
 * 各自声明、无导入关系。本文件用它做网格步长、锚差换算与环形标号回校验。 */
export const TICK_PERIOD_MS = 1000 / 64; // 15.625

/** 时钟锚 `t0Est` 的一阶低通系数，唯一使用点是 `insertRevision` 的采样分支。重锚路径
 * （断窗、播种）不经它，直接赋值。 */
export const T0_EST_EMA = 0.05;

/** Δ 缺省预算（ms）= 标号周期 + 8。构造期、`deactivate` 与播种分支都用它复位。 */
export const DELTA_DEFAULT_MS = TICK_PERIOD_MS + 8; // 23.625

/** Δ 下界（ms）= 标号周期 + 4。降档门是 `deltaMs − DELTA_RECOVER_STEP_MS ≥ DELTA_MIN_MS`，
 * 故 Δ 可以恰好落到本值。 */
export const DELTA_MIN_MS = TICK_PERIOD_MS + 4; // 19.625

/** Δ 上界常量（ms）= 1.5 × 标号周期 + 8。升档门是
 * `deltaMs + DELTA_STARVE_STEP_MS ≤ DELTA_MAX_MS`，而 Δ 只取 `DELTA_DEFAULT_MS` 加上整数个
 * `DELTA_STARVE_STEP_MS`、再减去整数个 `DELTA_RECOVER_STEP_MS` 所得的值（即 0.125ms 的奇数
 * 倍），故实际可达的最大值是 31.375，本常量值自身取不到。 */
export const DELTA_MAX_MS = 1.5 * TICK_PERIOD_MS + 8; // 31.4375

/** Δ 升档步长（ms）：每个 starvation 事件起点最多升一次；被上界门挡下时不升、也不计入
 * `stats.deltaAdjust`。 */
export const DELTA_STARVE_STEP_MS = 1;
/** Δ 降档步长（ms）：恢复期内每凑满一个降档节拍降一次；被下界门挡下时不降、也不计入
 * `stats.deltaAdjust`。 */
export const DELTA_RECOVER_STEP_MS = 0.25;
/** 降档节拍：干净帧计数进入恢复期后，每累计这么多次插值帧产生一次降档尝试。 */
export const DELTA_RECOVER_EVERY_SLOTS = 100;
/** 恢复期开启门：干净帧计数达到本值后才开始累计降档节拍。该计数在 starvation 事件起点归
 * 0，在插值帧上自增。 */
export const DELTA_RECOVER_AFTER_CLEAN = 1000;

/** 乐观帧标记位（事件字 bit8）：置位的新帧走「直出 + 显示保持」路径。`consume` 用它与
 * `OPT_BIT` 之外的位无关地判定，事件字的低 8 位另作断窗遥测。同值常量 `AUTH_EVT_OPT` 在
 * `src/ts-shared/auth/shared-state.ts` 另有一份声明，本文件独立声明字面量、不做导入。 */
export const OPT_BIT = 256;

/** 环形槽数。寻址掩码是字面量 `& 15`，与本常量无引用关系：两者必须同时为 16，把本值改成
 * 别的数只会改变构造期建出的槽数。 */
export const RING_CAP = 16;

/** 直出跳变的分桶阈值（u）。跳变量取三轴位移绝对差之和；`≤` 本值计 `stats.divBulk`，
 * `>` 本值计 `stats.divFlip`。两条直出路径共用该阈值，且只在已有姿态（`havePose` 为真）时
 * 计分。 */
export const DIV_BULK_MAX_U = 2.5;

/** 大空洞阈值。一次 starvation 期间的冻结帧数达到本值时，恢复的那一帧走快进重锚
 * （`stats.reanchor` 加 1，τ 直接落到当前网格需求值）；未达到则只结束冻结、让 τ 自然追上。
 * 参与比较的计数单位是 `consume` 的冻结返回次数。 */
export const FAST_FORWARD_TICKS = 2;

/** 相机姿态（构造期一次分配；`consume` 原地覆写，接口上的引用恒为同一对象）。字段全部来自
 * 已发布的权威帧：直出取当前帧，插值取环形两端点的结果，冻结取最后一次入环的修订帧。 */
export interface TickPose {
  /** 世界坐标位移（u）。 */
  x: number; y: number; z: number;
  /** 视角角（度）：yaw 走短弧插值，pitch 走线性插值。 */
  yaw: number; pitch: number;
  /** 眼高（HU，脚底为基准）；构造期初值为 `EYE_STAND`。 */
  eyeHeight: number;
  /** 取较新那帧（插值分支的高槽）的值，不做混合。 */
  onGround: boolean;
}

/** 遥测计数器（构造期一次分配；`consume` 原地自增）。读侧直接读该对象；`deactivate` 不清零。 */
export interface TickConsumerStats {
  /** starvation 事件数：从「不饥饿」翻转到饥饿的那次冻结返回计一次，同一段连续冻结的后续
   * 返回不再计。 */
  starvationEvents: number;
  /** 冻结返回总数（每次返回 `'frozen'` 且本轮已完成读取的调用都计），单位是 `consume` 调用
   * 次数，不是标号数。 */
  starvedTicks: number;
  /** 读写冲突跳过数：`readAuthoritativeInto` 返回 −1 的调用数。这类调用不写其它任何计数。 */
  readConflictSkip: number;
  /** 乐观帧直出次数（每个新到的乐观帧一次）。 */
  optDirect: number;
  /** 修订即撤记账数：修订帧的标号与段号都命中当前乐观保持态时计一次（只记账，不改显示）。 */
  optWithdraw: number;
  /** 断窗直出次数：段号变化且已经播种过时计一次；首次播种那次不计。 */
  breakDirect: number;
  /** 最近一次断窗直出时事件字的低 8 位（掩掉乐观位）。 */
  lastBreakEvtBits: number;
  /** 快进重锚次数：一次 starvation 的冻结帧数达到 `FAST_FORWARD_TICKS` 后恢复时计一次。 */
  reanchor: number;
  /** τ 钳制次数：本轮算出的网格需求值小于当前 τ、被 `Math.max` 挡住而回退需求的那次调用计
   * 一次。 */
  tauClamp: number;
  /** Δ 实际步进次数：升档与降档都计；被上界/下界门挡下的尝试不计。 */
  deltaAdjust: number;
  /** 直出跳变分桶——`≤ DIV_BULK_MAX_U`。 */
  divBulk: number;
  /** 直出跳变分桶——`> DIV_BULK_MAX_U`。 */
  divFlip: number;
  /** 弦插值返回次数，另加播种那一次；与 `frozenFrames` 配对构成冻结占比的分母（`'hold'` 与
   * 早退的 `'frozen'` 两者都不计）。 */
  published: number;
  /** 冻结返回次数，与 `published` 配对构成冻结占比的分子；读返回 0 或 −1 的早退不计。 */
  frozenFrames: number;
}

/** 消费器诊断快照（面板实时读；构造期分配，由 `syncDiag` 与插值路径就地写入）。 */
export interface TickConsumerDiag {
  /** 最近一次弦插值算出的 α；直出、冻结、保持路径都不改写它，`deactivate` 归 0。 */
  alpha: number;
  /** 显示时间 τ（ms）。只在 `syncDiag` 里被刷新，故早退路径上它是上一次同步的值。 */
  tauDisplay: number;
  /** 当前 Δ（ms）。同样只在 `syncDiag` 里刷新。 */
  deltaMs: number;
  /** 网格锚（null = 未锚定，此时 `gridT` 返回 NaN）。 */
  t0Est: number | null;
  /** 最近入环的修订帧标号（`lastRevTick`）；尚无修订帧时为 0。 */
  lastTick: number;
  /** 当前段号（`lastSeg`）。 */
  seg: number;
  /** 标号 k 的网格时刻 = `t0Est + k × TICK_PERIOD_MS`；未锚定时返回 NaN。读的是本对象的
   * `t0Est` 字段，不是闭包里的局部状态。 */
  gridT(k: number): number;
}

/** 消费器。三个只读字段的引用在构造期固定，内容就地更新。 */
export interface TickConsumer {
  /** 遥测计数器（见 `TickConsumerStats`）。 */
  readonly stats: TickConsumerStats;
  /** 诊断快照（见 `TickConsumerDiag`）。 */
  readonly diag: TickConsumerDiag;
  /** 最近一次产出的姿态（原地覆写）。尚无产出时内容为构造初值：`x`/`y`/`z`/`yaw`/`pitch` 为
   * 0、`eyeHeight` 为 `EYE_STAND`、`onGround` 为 false。 */
  readonly pose: TickPose;
  /** 消费一帧：读权威帧 + 三情形分派 + 就地写出姿态。
   * @param nowMs 调用方时钟（ms，与权威帧 timeMs 同域）；本文件不自己读时钟。
   * @returns 'pose' = 本轮有可用姿态（新算出、直出或保持显示三种来源）；'hold' = 尚未产出过
   *          姿态，调用方应保持相机不动；'frozen' = 保留上一产出（读取未开始、读写冲突或端点
   *          校验失败）。 */
  consume(nowMs: number): 'pose' | 'hold' | 'frozen';
  /** 停机：清播种标志、时钟锚、姿态有效位、饥饿与乐观保持态、Δ 与恢复计数、新帧判据，并把
   * `diag` 的 α/τ/锚归零。`stats` 各计数器保留（跨停机累计），`lastSeg` 也不重置，`diag` 的
   * `deltaMs`/`lastTick`/`seg` 要等下一次 `syncDiag` 才刷新。 */
  deactivate(): void;
  /** 是否已播种：首个修订帧走完播种分支后为真，`deactivate` 后回到假。 */
  isSeeded(): boolean;
}

/** 环形槽：一个修订帧的快照。槽位按 `k & 15` 复用，读时必须用 `k`/`seg` 回校验该槽是否
 * 仍属当前段与本 tick（不匹配即视为陈旧、跳过）；`f` 按 `dstF` 的槽位序整段复制 10 个 f64
 * （含本文件不读回的 vel 与 timeMs）；`wallMs` 与 `f[9]` 同值，是同一来源的两次记录；
 * `onGround` 存 0/1 整数（取自 `dstI[0]`），插值分支再用 `=== 1` 取回布尔。 */
interface RingSlot {
  k: number;
  seg: number;
  wallMs: number;
  f: Float64Array;
  onGround: number;
}

/** i32 环绕安全的「a 在 b 之前」判定：只认原始差落在 (0, 2^30) 的样本——差为 0、为负或
 * ≥ 2^30（含全量回绕后的歧义区）一律判否。2^30 个标号 × 15.625ms ≈ 194 天。唯一调用点是
 * `insertRevision` 的时钟锚采样门。 */
function before(a: number, b: number): boolean {
  const d = (b - a) | 0;
  return d > 0 && d < 0x40000000;
}

/** 角度短弧插值（度域）：把 `b − a` 折到绝对值不超过 180 的区间（±180 原样保留），再按 t
 * 线性推进，返回 `a + d × t`。结果不归一化——a=350、b=10 时返回向 370 增长的值，调用方
 * （`consume` 的弦插值分支）直接把它写进 `pose.yaw`；`t` 由调用方钳在 [0, 1) 内。 */
function lerpAngleDeg(a: number, b: number, t: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return a + d * t;
}

/**
 * 建立消费器：构造期一次分配全部缓冲与输出对象，返回的对象持有全部状态。
 *
 * @param shared 上游状态通道（SAB 路径或消息回退路径）。本文件只调用它的
 *   `readAuthoritativeInto`：每次 `consume` 一次，把载荷读进内部 `dstF`/`dstI`。
 * @returns 消费器：`consume` 的三值返回 + 就地更新的 `pose`/`stats`/`diag`。
 *
 * 副作用：无——不注册监听、不启动定时器、不写 `shared`。
 * 失败/退化：`shared` 尚未发布过帧时 `consume` 返回 `'hold'`；发布停止后退化为冻结，姿态停在
 * 最后一次入环的修订帧上。重复调用 `deactivate` 与调用一次等价（`stats` 计数器除外，它跨停机
 * 累计）。
 * 调用点：当前工作区内无调用方——全仓只有本文件的定义。
 */
export function createTickConsumer(shared: SharedState): TickConsumer {
  // ── 构造期单次分配：consume 路径不再申请堆（环形、视图、输出对象一次建齐）────
  const dstF = new Float64Array(12);
  const dstI = new Int32Array(6);
  const ring: RingSlot[] = [];
  for (let i = 0; i < RING_CAP; i++) {
    ring.push({ k: 0, seg: 0, wallMs: 0, f: new Float64Array(10), onGround: 0 });
  }
  const pose: TickPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, eyeHeight: EYE_STAND, onGround: false };

  // 两个视图的容量大于本文件的读取面：读取约定只写 dstF 的 0..9 与 dstI 的 0..4，
  // 多出的槽位是本文件的余量、不参与任何计算
  const stats: TickConsumerStats = {
    starvationEvents: 0, starvedTicks: 0, readConflictSkip: 0,
    optDirect: 0, optWithdraw: 0, breakDirect: 0, lastBreakEvtBits: 0,
    reanchor: 0, tauClamp: 0, deltaAdjust: 0, divBulk: 0, divFlip: 0,
    published: 0, frozenFrames: 0,
  };
  const diag: TickConsumerDiag = {
    alpha: 0, tauDisplay: 0, deltaMs: DELTA_DEFAULT_MS, t0Est: null,
    lastTick: 0, seg: 0,
    gridT: (k: number) => (diag.t0Est === null ? NaN : diag.t0Est + k * TICK_PERIOD_MS),
  };

  // ── 消费器标量状态（对象态只有上面那三个输出对象）──────────────────────
  let seeded = false;
  let t0Est: number | null = null;
  let tauDisplay = 0;
  let tauValid = false;
  let deltaMs = DELTA_DEFAULT_MS;
  let cleanStreak = 0;
  let recoverCredit = 0;
  let lastSeg = 0;
  let lastRevTick: number | null = null;
  /** 乐观保持态：乐观帧直出后继续显示该帧姿态，直到 τ 追过它的网格时刻。标号与段号成对
   * 记录，回校验失败即作废（`deactivate` 与断窗都会清掉标号）。 */
  let optHoldTick: number | null = null;
  let optHoldSeg = 0;
  let lastVa = -1; // 上次读到的样本序号；初值 -1 使首次读取必判为新帧
  let starvedTicksCur = 0;
  let starving = false;
  let havePose = false;

  /** 把五个标量快照进 `diag`（读侧只认 `diag`）：τ、Δ、锚、`lastRevTick ?? 0`、段号。
   * `alpha` 由插值分支单独写。没有走到这里的早退路径上，`diag` 保持上一次同步的值。 */
  function syncDiag(): void {
    diag.tauDisplay = tauDisplay;
    diag.deltaMs = deltaMs;
    diag.t0Est = t0Est;
    diag.lastTick = lastRevTick ?? 0;
    diag.seg = lastSeg;
  }

  /** 直出：把 `dstF`/`dstI` 里的当前帧姿态整段覆写进 `pose`，并按跳变量记分桶。
   * `count` 决定专账口径：'opt' 记 `stats.optDirect`；'break' 记 `stats.breakDirect` 并存下
   * 事件字低 8 位；'seed' 只做直出与分桶、不记专账（播种帧的 `stats.published` 由调用点记）。
   * 跳变量是三轴位移绝对差之和，仅在 `havePose` 为真时计分。副作用：写 `pose`、把
   * `havePose` 置真、递增分桶计数。 */
  function directOutFromDst(count: 'opt' | 'break' | 'seed'): void {
    if (havePose) {
      const d =
        Math.abs(dstF[0] - pose.x) + Math.abs(dstF[1] - pose.y) + Math.abs(dstF[2] - pose.z);
      if (d > DIV_BULK_MAX_U) stats.divFlip++;
      else stats.divBulk++;
    }
    pose.x = dstF[0]; pose.y = dstF[1]; pose.z = dstF[2];
    pose.yaw = dstF[3]; pose.pitch = dstF[4];
    pose.eyeHeight = dstF[8];
    pose.onGround = dstI[0] === 1;
    if (count === 'opt') stats.optDirect++;
    else if (count === 'break') {
      stats.breakDirect++;
      stats.lastBreakEvtBits = dstI[4] & 0xff;
    }
    havePose = true;
  }

  /** 重锚 τ：`tauDisplay = nowMs − t0Est − deltaMs` 并把 `tauValid` 置真——这是绕开单调钳、
   * 把 τ 调小的唯一路径。`t0Est` 未锚定时直接返回、什么都不改。快进、断窗、播种三处调用；
   * `stats.reanchor` 只由快进那一处递增。 */
  function reanchorTau(nowMs: number): void {
    if (t0Est === null) return;
    tauDisplay = nowMs - t0Est - deltaMs;
    tauValid = true;
  }

  /** 修订帧入环 + 时钟锚采样（只在新帧的修订分支调用，乐观帧在调用前已返回）。
   * - 入环：无条件覆写槽 `k & 15`——标号、段号、`wallMs` 与 10 个 f64 一起写，供端点回校验；
   * - 采样：仅当段号未变、已有前一修订帧、且 `before(lastRevTick, k)` 为真时更新 `t0Est`
   *   （样本 = 该帧 timeMs − k × 周期；首次直接赋值，之后按 `T0_EST_EMA` 一阶低通）；
   * - `lastRevTick` 无条件更新为 `k`（采样门未通过也推进，避免同一标号被反复采样）。 */
  function insertRevision(k: number, seg: number, onGround: number): void {
    const slot = ring[k & 15];
    slot.k = k;
    slot.seg = seg;
    slot.wallMs = dstF[9];
    slot.onGround = onGround;
    for (let i = 0; i < 10; i++) slot.f[i] = dstF[i];
    if (seg === lastSeg && lastRevTick !== null && before(lastRevTick, k)) {
      const sample = dstF[9] - k * TICK_PERIOD_MS;
      t0Est = t0Est === null ? sample : t0Est + T0_EST_EMA * (sample - t0Est);
    }
    lastRevTick = k;
  }

  /** 消费一次：读一帧 + 三情形分派 + 就地写出姿态。
   *
   * 分派顺序（前三步只在新帧上执行一次）：
   * 1. 段号变化 —— 清 `lastRevTick` 与乐观保持态，用本帧硬重置 `t0Est`；已播种则直出 + τ 重锚
   *    后返回（首次播种那次只重置，落到第 3 步的播种分支）；
   * 2. 乐观帧（事件字 `OPT_BIT` 置位）—— 记下保持标号与段号、直出、返回；
   * 3. 修订帧 —— 标号与段号命中保持态时记一次 `stats.optWithdraw`；入环 + 采样；未播种则在此
   *    播种（直出 + 设锚 + τ 重锚 + Δ 复位 + `stats.published`）后返回；
   * 4. τ 推进 —— `tauDisplay = max(τ_prev, nowMs − t0Est − deltaMs)`，被钳住则计
   *    `stats.tauClamp`；
   * 5. 乐观保持门 —— τ 未追过保持帧的网格时刻就直接返回，`pose` 保持乐观直出时的内容；
   * 6. 端点校验通过则弦插值写 `pose`（α 钳在 [0, 1 − 1e−9)）、计 `published`、走 Δ 恢复计数；
   *    否则进冻结分支。
   *
   * 冻结分支：事件起点计 `starvationEvents`、Δ 升一档、最后一次修订帧槽仍通过回校验时把姿态
   * 钉回该槽并记分桶；每次冻结返回都计 `starvedTicks` 与 `frozenFrames`。该返回不保证本轮写入
   * 了 `pose`——槽回校验失败时沿用上次内容。
   *
   * 零分配：本轮不构造对象、数组或闭包。 */
  function consume(nowMs: number): 'pose' | 'hold' | 'frozen' {
    const va = shared.readAuthoritativeInto(dstF, dstI);
    if (va === 0) return havePose ? 'frozen' : 'hold'; // 通道未开始：本轮不出姿态
    if (va === -1) {
      // 读写冲突：帧内容与标签都不采信，整体跳过——不采样、不入环、不触重锚、不计冻结；
      // 只计冲突账，显示保持（pose 未被本调用覆写）
      stats.readConflictSkip++;
      return havePose ? 'frozen' : 'hold';
    }
    const isNew = va !== lastVa;
    lastVa = va;
    const seg = dstI[2];
    const k = dstI[3];
    const evt = dstI[4];

    if (isNew) {
      // ── 新帧面：断窗 / 乐观直出 / 修订入环（每次新帧只走一遍）────────────
      if (seg !== lastSeg) {
        const firstEver = !seeded;
        lastSeg = seg;
        lastRevTick = null; // 新段的标号样本链从零重建
        optHoldTick = null; // 新段作废乐观保持态，从直出重新开始
        t0Est = dstF[9] - k * TICK_PERIOD_MS; // 时钟锚按本帧硬重置
        if (!firstEver) {
          directOutFromDst('break');
          reanchorTau(nowMs);
          starving = false; // 新段终止饥饿段
          syncDiag();
          return 'pose';
        }
      }
      const isOpt = (evt & OPT_BIT) !== 0;
      if (isOpt) {
        optHoldTick = k; // 保持态总是指向最新的乐观帧标号
        optHoldSeg = seg;
        directOutFromDst('opt');
        syncDiag();
        return 'pose';
      }
      // 修订帧：同标号同段即撤销乐观不确定性（只记账，显示保持到 τ 追过该标号的网格时刻）
      if (optHoldTick !== null && k === optHoldTick && seg === optHoldSeg) {
        stats.optWithdraw++;
      }
      insertRevision(k, seg, dstI[0] === 1 ? 1 : 0);
      if (!seeded) {
        // 播种：无对端可插值故直出，同时设初始锚 + 重锚 τ + 复位 Δ
        seeded = true;
        t0Est = dstF[9] - k * TICK_PERIOD_MS;
        directOutFromDst('seed');
        reanchorTau(nowMs);
        deltaMs = DELTA_DEFAULT_MS;
        stats.published++; // 播种帧计入已消费
        syncDiag();
        return 'pose';
      }
    }

    if (t0Est === null) return havePose ? 'frozen' : 'hold';

    // ── α 网格需求（每次调用推进一次；τ 单调钳制在这里）──────────────────
    const g = nowMs - t0Est - deltaMs;
    const tauNew = tauValid ? Math.max(tauDisplay, g) : g;
    if (tauValid && tauNew !== g) stats.tauClamp++;
    tauDisplay = tauNew;

    // ── 乐观保持门：τ 未追过该标号的网格时刻就继续显示乐观姿态（修订已记账）──
    if (optHoldTick !== null) {
      const tHold = t0Est + optHoldTick * TICK_PERIOD_MS;
      if (tauDisplay < tHold) {
        syncDiag();
        return 'pose'; // pose 自乐观直出后未被覆写
      }
      optHoldTick = null; // τ 已追上：交回插值链，端点即该标号的修订帧
    }

    // 段定位：候选标号 kCur = ceil((τ − T0)/T)；两端点各自回校验标号与段号
    const kCur = Math.ceil((tauDisplay - t0Est) / TICK_PERIOD_MS) | 0;
    const sHi = ring[kCur & 15];
    const sLo = ring[(kCur - 1) & 15];
    const hiOk = sHi.k === kCur && sHi.seg === lastSeg;
    const loOk = sLo.k === ((kCur - 1) | 0) && sLo.seg === lastSeg;

    if (hiOk && loOk) {
      // ── 情形 A：两端点齐备，弦插值 ──────────────────────────────
      if (starving) {
        // 冻结结束：大空洞才重锚，短空洞让 τ 自然追上
        starving = false;
        if (starvedTicksCur >= FAST_FORWARD_TICKS) {
          stats.reanchor++;
          reanchorTau(nowMs);
        }
        starvedTicksCur = 0;
      }
      cleanStreak++;
      let alpha = (tauDisplay - (t0Est + (kCur - 1) * TICK_PERIOD_MS)) / TICK_PERIOD_MS;
      if (alpha < 0) alpha = 0;
      if (alpha >= 1) alpha = 1 - 1e-9; // 端点钳：α < 1（不取到高槽端点）
      const t = alpha;
      pose.x = sLo.f[0] + (sHi.f[0] - sLo.f[0]) * t;
      pose.y = sLo.f[1] + (sHi.f[1] - sLo.f[1]) * t;
      pose.z = sLo.f[2] + (sHi.f[2] - sLo.f[2]) * t;
      pose.yaw = lerpAngleDeg(sLo.f[3], sHi.f[3], t);
      pose.pitch = sLo.f[4] + (sHi.f[4] - sLo.f[4]) * t;
      pose.eyeHeight = sLo.f[8] + (sHi.f[8] - sLo.f[8]) * t;
      pose.onGround = sHi.onGround === 1;
      diag.alpha = alpha;
      stats.published++;
      havePose = true;
      // Δ 恢复期：干净帧数过门后按节拍降档，降到下界为止
      if (cleanStreak >= DELTA_RECOVER_AFTER_CLEAN) {
        recoverCredit++;
        if (recoverCredit >= DELTA_RECOVER_EVERY_SLOTS) {
          recoverCredit = 0;
          if (deltaMs - DELTA_RECOVER_STEP_MS >= DELTA_MIN_MS) {
            deltaMs -= DELTA_RECOVER_STEP_MS;
            stats.deltaAdjust++;
          }
        }
      }
      syncDiag();
      return 'pose';
    }

    // ── 情形 B：端点不齐备 → 冻结（含下一标号未及时发布）────────────────
    if (!starving) {
      starving = true;
      stats.starvationEvents++;
      starvedTicksCur = 0;
      cleanStreak = 0;
      recoverCredit = 0;
      // 事件驱动升档：Δ 加一步（被上界门挡下时不加）
      if (deltaMs + DELTA_STARVE_STEP_MS <= DELTA_MAX_MS) {
        deltaMs += DELTA_STARVE_STEP_MS;
        stats.deltaAdjust++;
      }
      // 始发冻结：把姿态钉回最后一次入环的修订帧并记分桶；后续冻结帧沿用同一姿态，
      // 不重复计数
      const lr0 = lastRevTick;
      if (lr0 !== null) {
        const s0 = ring[lr0 & 15];
        if (s0.seg === lastSeg && s0.k === lr0) {
          if (havePose) {
            const d =
              Math.abs(s0.f[0] - pose.x) + Math.abs(s0.f[1] - pose.y) + Math.abs(s0.f[2] - pose.z);
            if (d > DIV_BULK_MAX_U) stats.divFlip++;
            else stats.divBulk++;
          }
          pose.x = s0.f[0]; pose.y = s0.f[1]; pose.z = s0.f[2];
          pose.yaw = s0.f[3]; pose.pitch = s0.f[4];
          pose.eyeHeight = s0.f[8];
          pose.onGround = s0.onGround === 1;
          havePose = true;
        }
      }
    }
    starvedTicksCur++;
    stats.starvedTicks++;
    stats.frozenFrames++;
    havePose = true;
    syncDiag();
    return 'frozen';
  }

  function deactivate(): void {
    seeded = false;
    t0Est = null;
    tauValid = false;
    starving = false;
    starvedTicksCur = 0;
    optHoldTick = null;
    lastRevTick = null;
    deltaMs = DELTA_DEFAULT_MS;
    cleanStreak = 0;
    recoverCredit = 0;
    havePose = false;
    lastVa = -1;
    diag.alpha = 0;
    diag.tauDisplay = 0;
    diag.t0Est = null;
    // stats 各计数器保留，跨停机累计
  }

  return {
    stats,
    diag,
    pose,
    consume,
    deactivate,
    isSeeded: () => seeded,
  };
}
