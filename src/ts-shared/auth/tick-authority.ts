/**
 * tick 模式乐观评估控制器：在权威线之外维护一个 scratch 第二实例，抢在真实 tick
 * 到达之前把该标号的帧投影出来先行发布，真值到达后再以同一标号发修订帧。
 *
 * ── 定位 ──────────────────────────────────────────────────────────────────
 * 共享层 `src/ts-shared/` 的发布侧编排器。它不推进权威物理、不碰固定步长累积器，
 * 只做三件事：① 每次唤醒判断「现在开火值不值」；② 在 scratch 实例上单步投影并决定
 * 这一帧发不发；③ 真实帧到达后把投影与真值对上账（修订对账 + 双桶位移差遥测）。
 * 渲染侧只认权威帧，因此本控制器的输出决定主线程看到的那一帧出自哪条时间线。
 *
 * ── 上下游调用点（各一个）─────────────────────────────────────────────────
 * - 上游：`src/ts-shared/auth/auth-loop.ts` 的 `createAuthLoop`。它经
 *   `AuthLoopEnv.tickF4` 钩子每唤醒调 `onWake`，真实步依次调 `authorityTickInto` /
 *   `publishMeta` / `onRealTick`，hold 支路调 `noteHoldTick`。
 * - 下游：`src/ts-shared/auth/shared-state.ts` 的 `ShmState.writeAuthoritative`（发布；
 *   带 meta 时三元组与 onGround 走 seqlock 写序）与 `ShmState.peekInput`（非消耗输入
 *   读）；放行裁决来自 `src/ts-shared/tick/ordering-gate.ts` 的 `createOrderingGate`。
 *
 * ── 接线状态：已实现、未接线 ─────────────────────────────────────────────
 * 全仓对 `createTickAuthority` 的调用只有 `src/ts-shared/auth/tick-authority.test.ts`
 * 一处；`apps/debug` 与 `apps/game` 的 `createAuthLoop` 装配点都不提供 `tickF4`，
 * 也没有任何工程 import 本模块。线上权威帧因此走的是
 * `src/ts-shared/auth/auth-loop.ts` 的 `stepPhysics` 里 `f4` 缺省的那条分支
 * （`phys.tick` + `phys.state` 返回对象），本文件描述的乐观发布、零分配支路与双桶
 * 对账在当前工况下不参与线上运行。Rust 侧同理：`src/phys/mod.rs` 的 `tick_into` 与
 * `state_out_ptr` 由本文件与 `src/ts-shared/decoupled/decoupled-loop.ts` 驱动
 * （后者只读前 8 槽），`seed_from` 在本文件之外的调用点只有
 * `apps/game/scripts/phys-seed-smoke.mjs`（另见本文件的单测里对种子通道的桩调用）。
 *
 * ── 关键不变量 ────────────────────────────────────────────────────────────
 * - 排序：标号 L 的乐观帧只有在权威已发 L-1 时才放行（门内比较
 *   `lastAuthoritative === (label - 1) | 0`）；门的提前量被钳到 T - ε_max，
 *   故 δ + ε_max ≤ T 成立。
 * - 每标号至多一帧乐观帧：同一 L 已发出即直接返回（窗内重复唤醒不重发）。
 * - 乐观帧的事件位恒为 `AUTH_EVT_OPT`（= 256）；低 8 位事件位恒 0——事件只在
 *   `publishMeta` 与 `firstFrameMeta` 两条出口随帧发布，且发布后立即清零。
 * - 标号与段号都按 i32 环推进：`nextTickLabel = (nextTickLabel + 1) | 0`、
 *   `segSeq = (segSeq + 1) | 0`。
 * - 乐观帧的 `timeMs` 取该标号的网格 due（调用方给的 `nextDueMs`），不取墙钟。
 * - 乐观路径对权威实例只有 `seed_from` 一次调用（单向拷贝，不改权威）；权威实例的
 *   `tick_into` 只由真实步驱动。
 *
 * ── 边界与容错 ────────────────────────────────────────────────────────────
 * - 非 tick 模式：两个发布出口返回 undefined，下游 meta 走缺省（协议槽零触碰）；
 *   `authorityTickInto` 与 `noteHoldTick` 不查 `tickMode`，由调用方把关。
 * - 通道没有 `peekInput`（`MsgState`）或缺 scratch / 权威 / wasm buffer → `f4Ready`
 *   为 false，乐观径整体不尝试，真实步照常出帧。
 * - 引导期（还没有真实帧标号）→ 不尝试；窗未开（`remaining > T - δ`）→ 不尝试且
 *   不记账；迟到地板（`remaining ≤ OPT_FIRE_FLOOR_MS`）→ 不尝试并计 `floorSkips`。
 * - 键沿变化与内容封帽都在排序门之前判掉：前者计 `keyEdgeSkips`，后者计
 *   `orphanedCap`，两者都不进门的闭账。
 * - `getTickPeriodMs()` 非正数 → 本唤醒直接返回；周期变化 → 整门重建，旧锚随旧门
 *   丢弃，重建后第一次尝试按无锚记 `leadMiss`。
 * - world 重建 → 标号归零、锚置空（回到引导期）、段号 +1、整门重建。
 *
 * ── 测试归属 ──────────────────────────────────────────────────────────────
 * `src/ts-shared/auth/tick-authority.test.ts`（node 下 esbuild 打包后运行）用一个
 * 确定性 `FakeWorld` 顶替真实 wasm 实例，实际断言：输入 peek 不消耗且按 maxStep
 * 饱和；引导期只计 `bootstrapSkips`；乐观帧的 `timeMs` 等于 due、位置等于
 * seed + 截断窗投影、三元组为 seg 沿用 / tick = L / evt = `AUTH_EVT_OPT`，并逐轮
 * 校验门闭账恒等式 `optimisticPublished + leadMiss + blockedOrder ≡ 尝试数`；
 * 位移差按接触类字段是否翻转过入 `divFlip` 或 `divBulk`，`divBulkOverCap` 在 2.5u
 * 处计数、`divBulkSumU` 累加；事件与 `on_ground` / `blocked` / `ladder` / `ducked` /
 * `surfing` 六类封帽各自孤儿化；键沿跳过；窗外、地板、追爆三条都不触门；同标号
 * 不重发；R 键边沿与 `take_event` 的 teleport / death 各自推进段号并入事件位；
 * hold 令投影作废（不产生修订）而标号继续；world 重建后回到引导期；非 tick 模式
 * 全钩子 no-op；`MsgState` 下 `f4Ready` 为 false；周期改 10ms 后门重建且
 * `leadDeltaMs` 为 2。另有两条集成断言用真 timer 驱动 `createAuthLoop`：零分配支路
 * 确实调到了 `tick_into`、hold 期帧定格而标号继续；以及不注入 `tickF4` 时耦合路径
 * 的 `I_A_*` 槽零触碰。红线用例另断言乐观发布只让 scratch 步进、权威实例步数不变，
 * 且 `F4AuthorityWorld` 的方法面恰为 `seed_from` / `state_out_ptr` / `take_event` /
 * `tick_into` 四个，无任何 set 写面。
 *
 * ── 与相邻文件的边界 ──────────────────────────────────────────────────────
 * - `src/ts-shared/tick/ordering-gate.ts`：只裁决与计数，不认识标号以外的东西，
 *   也不发布任何帧。
 * - `src/ts-shared/auth/shared-state.ts`：只管槽位与发布序，不区分乐观帧与真值帧。
 * - `src/ts-shared/auth/auth-loop.ts`：持累积器与真实步；本文件不推进物理。
 * - `src/ts-shared/decoupled/decoupled-loop.ts`：解耦线的独立控制器，与本文件互不调用。
 * - `src/phys/mod.rs`：`tick_into` / `state_out_ptr` / `seed_from` / `take_event`
 *   四个 Rust 导出及其 `state_out` 槽位语义的实现侧。
 */

import type { ShmState, MsgState, AuthPublishMeta } from './shared-state.js';
import { AUTH_EVT, AUTH_EVT_OPT } from './shared-state.js';
import {
  createOrderingGate,
  type OrderingGate,
  type OrderingGateStats,
  EPSILON_MAX_SETTIMEOUT_MS,
} from '../tick/ordering-gate.js';

/**
 * 乐观评估所需的权威实例最小面（`src/phys/mod.rs` 的 `PhysWorld` 结构性满足）。
 *
 * - `tick_into`：推进一个子步，状态写进实例自带的固定缓冲，不构造任何 wasm→JS
 *   对象；`state_out_ptr` 给出该缓冲在线性内存中的字节地址（本文件按 22 槽建视图）。
 * - `take_event`：取走最近一次物理事件并清空槽位（一次性消费，无事件时返回 null）。
 * - `seed_from`：种子通道——把 `src` 的种子字段逐字段拷进本实例，`src` 只被读。
 *
 * 接口刻意不含 `set_state` / `set_params` / `teleport_to` 一类写面，因此它同时是
 * 红线审计面：乐观路径能碰的东西全在这四个方法里。乐观路径（`onWake`）实际只调其中
 * `seed_from` 一次；`take_event` 由 `publishMeta` 在真实帧上调用，`tick_into` 由
 * `authorityTickInto` 在真实步上调用。
 */
export interface F4AuthorityWorld {
  tick_into(dt: number, keysMask: number, dx: number, dy: number): void;
  state_out_ptr(): number;
  take_event(): unknown;
  seed_from(src: object): void;
}

/** scratch 第二实例的类型别名：与 `F4AuthorityWorld` 逐字段相同。`seed_from` 的
 * `src` 形参在两侧都放宽为 `object`，故权威实例可以直接作为实参传入。 */
export type F4ScratchWorld = F4AuthorityWorld;

/** 权威姿态记录（预分配可变对象，控制器生命周期内恒为同一引用）。
 *
 * `authorityTickInto` 每次真实步把权威 `state_out` 视图原地填进本对象，
 * `src/ts-shared/auth/auth-loop.ts` 的 `stepPhysics` 按字段读它组装权威帧，随后把
 * 同一对象交给 `onRealTick`——稳态因此没有逐 tick 的对象分配。`onGround` / `ducked` /
 * `surfing` / `blockedTicks` / `ladder` 五个字段供内容封帽基线与位移差翻转分类使用。 */
export interface AuthorityPose {
  x: number;
  y: number;
  z: number;
  velX: number;
  velY: number;
  velZ: number;
  yaw: number;
  pitch: number;
  eyeHeight: number;
  onGround: boolean;
  ducked: number;
  surfing: number;
  blockedTicks: number;
  ladder: number;
}

/** 真实 tick 回传的姿态类型：与 `AuthorityPose` 同一形状（`authorityPose` 常被直接
 * 回传，故 `onRealTick` 的实参就是 `authorityTickInto` 刚填过的那个对象）。 */
export type RealTickPose = AuthorityPose;

/** 控制器遥测（预分配可变对象，控制器生命周期内同一引用）。
 *
 * `optimisticPublished` / `leadMiss` / `blockedOrder` 三项是排序门计数的镜像
 * （`mirrorGateStats` 就地拷贝），闭账恒等式以 `gate.stats` 为权威源；其余字段由
 * 控制器自己维护。`bootstrapSkips` / `orphanedCap` / `keyEdgeSkips` / `floorSkips`
 * 四项都是门上游损失，不参与门的闭账，门重建也不清零。`onWake` 每秒把本对象浅拷贝
 * 一份 post 出去——该拷贝是这条路径上唯一的分配。 */
export interface TickF4Stats extends OrderingGateStats {
  /** 引导期跳过：tick 模式下还没有真实帧标号，门里没有可比的前驱锚（不在门闭账内）。 */
  bootstrapSkips: number;
  /** 内容封帽孤儿：投影结果触发封帽，这一帧直接丢弃、不经过门（不在门闭账内）。 */
  orphanedCap: number;
  /** 键沿跳过：输入键位掩码与上一次真实帧相比有任何一位不同，本 tick 不发乐观帧。 */
  keyEdgeSkips: number;
  /** 迟到地板跳过（`remaining ≤ OPT_FIRE_FLOOR_MS`）：留给乐观帧的展示时长不足
   * 1ms 而修订帧随即到达，放弃本 tick（无乐观帧，回落 pure-history 一拍）。这是
   * **门上游**损失，与 `bootstrapSkips` / `orphanedCap` / `keyEdgeSkips` 同层，
   * 不进门的闭账。开火地板使门内 ε 尾分支从本调用点不可达（本调用点保证
   * `nowMs < nextDueMs`），故门的 `leadMiss` 只由无锚分支贡献；本计数把地板损失
   * 单独记账，两处相加才是完整口径。窗外唤醒（`remaining > T - δ`）属正常早醒，
   * 不计入本计数。 */
  floorSkips: number;
  /** 修订对账次数：乐观帧已发、且到达的真实帧标号与它相同。 */
  revisions: number;
  /** 位移差 bulk 桶计数：真实帧与乐观帧相比接触类字段无翻转。 */
  divBulk: number;
  /** 位移差 flip 桶计数：接触类字段（着地 / 蹲伏 / 滑行 / 被阻 tick / 梯子）有翻转。 */
  divFlip: number;
  /** bulk 桶的最大位移差（HU，由三轴 f64 差值算模长）。 */
  divBulkMaxU: number;
  /** flip 桶的最大位移差（HU）。 */
  divFlipMaxU: number;
  /** bulk 桶位移差累计（均值分母取 `divBulk`）。 */
  divBulkSumU: number;
  /** bulk 桶中位移差超过 2.5HU 的次数（残余告警面：只比较位置三轴，差值超界即计数）。 */
  divBulkOverCap: number;
  /** hold 冻结期间的 tick 数（`noteHoldTick` 调用次数）。 */
  holdTicks: number;
  /** 当前段号（与 `src/ts-shared/auth/shared-state.ts` 的 `I_A_SEG` 同源）。 */
  seg: number;
  /** 下一个真实帧将使用的标号。 */
  tickLabel: number;
  /** 乐观径是否就绪（tick 模式 ∧ 通道有 `peekInput` ∧ 权威与 scratch 都在 ∧
   * wasm buffer 非空）；每次评估时刷新。 */
  f4Ready: boolean;
}

/** 控制器装配环境：全部成员都是 getter，控制器每次用到时才读，因此注入方可以在
 * init 或配置消息到达之后再让它们返回真实对象，时序不影响正确性。
 * 当前工作区没有装配点（见模块头的接线状态），唯一注入方是单测。 */
export interface TickAuthorityEnv {
  /** 跨线程状态通道：`ShmState`（SAB，带 `peekInput`）可走乐观径；`MsgState` 没有
   * `peekInput`，乐观径整体禁用、真实步照常。 */
  getShared(): ShmState | MsgState | null;
  /** 权威实例（真实步零分配面 + 事件槽排空 + 种子源）；返回 null 时乐观径禁用。 */
  getAuthority(): F4AuthorityWorld | null;
  /** scratch 第二实例（乐观投影的执行体）；返回 null 时乐观径禁用，不报错也不退化。 */
  getScratch(): F4ScratchWorld | null;
  /** wasm 线性内存 buffer（`state_out` 视图的宿主）；线性内存增长会换新对象，
   * 视图按身份重建。 */
  getWasmBuffer(): ArrayBuffer | null;
  /** 当前 raw tick 周期（ms）。返回值与建门时的周期不同即整门重建；非正数视为无效
   * 配置，本唤醒直接返回。 */
  getTickPeriodMs(): number;
  /** 乐观提前量 δ（ms）。缺省时门取自己的上界 cap = T - ε_max；显式越界由门钳回 cap。 */
  getLeadDeltaMs?(): number;
  /** 遥测消息发送（缺省 `self.postMessage`；node 测试注入收集器）。 */
  post?(msg: unknown): void;
}

/** auth-loop 侧钩子接口（`src/ts-shared/auth/auth-loop.ts` 的 `AuthLoopEnv.tickF4` 形状）。
 *
 * 两条调用纪律：① 除 `authorityTickInto` 与 `noteHoldTick` 外，每个方法进入时自查
 * `tickMode` 并早退，两个发布出口因此返回 undefined，使下游 meta 走缺省；②
 * `publishMeta` 与 `firstFrameMeta` 是唯二会动标号与事件位的出口，`onWake` 只发
 * 乐观帧、不推进标号。 */
export interface TickF4Controller {
  /** 每次 loop 唤醒、累积器推进之前调用一次：遥测节拍 + 乐观窗评估 + 放行时发布乐观帧。 */
  onWake(nowMs: number, nextDueMs: number): void;
  /** 真实 tick 的输入消费之后调用：更新键沿基线，R 键边沿按断点处理。 */
  onInput(keysMask: number): void;
  /** 真实帧发布用的 meta：tick 模式返回 `{seg, tick, evt}` 并推进标号、排空事件位、
   * 把新标号写进排序门锚；非 tick 模式返回 undefined。 */
  publishMeta(): AuthPublishMeta | undefined;
  /** 真实帧发布之后调用：乐观帧修订对账 + 位移差分桶 + 刷新封帽基线 + 镜像门计数。 */
  onRealTick(nowMs: number, pose: RealTickPose): void;
  /** 真实步的零分配驱动：刷新视图缓存 → 权威 `tick_into` → 把视图填进 `authorityPose`。
   * 本方法不查 `tickMode`，由调用方用 `isActive()` 把关。 */
  authorityTickInto(dt: number, keysMask: number, dx: number, dy: number): void;
  /** 预分配姿态记录（真实步直读；恒为同一对象）。 */
  readonly authorityPose: AuthorityPose;
  /** 真实步零分配支路是否可走：`tickMode` ∧ 权威实例存在 ∧ wasm buffer 存在。 */
  isActive(): boolean;
  /** hold 冻结接管：`holdTicks` +1，并作废待对账的乐观帧。本方法不查 `tickMode`。 */
  noteHoldTick(): void;
  /** 交接进入 tick 模式：段号 +1、置 `AUTH_EVT.modeSwitch`、作废投影，并用 `peekKeys`
   * 初始化键沿基线（通道没有 `peekKeys` 时取 0）。 */
  enterMode(): void;
  /** 交接离开 tick 模式：清 `tickMode`、作废投影、丢弃尚未发布的事件位（避免陈旧位
   * 漏进 meta 走缺省的耦合/解耦发布）；重复调用是 no-op。 */
  exitMode(): void;
  /** 交接首帧的 meta：用当前段号与当前标号组帧并排空事件位，但不递增标号、也不动
   * 排序门锚（这两点与 `publishMeta` 不同，故首帧之后门仍处于无锚状态）；非 tick
   * 模式返回 undefined。 */
  firstFrameMeta(): AuthPublishMeta | undefined;
  /** 外部断点：段号 +1，并把调用方给的位或进事件位；非 tick 模式 no-op。位含义由
   * 调用方按 `src/ts-shared/auth/shared-state.ts` 的 `AUTH_EVT` 选取。 */
  externalBreak(evtBit: number): void;
  /** world 重建：标号归零、锚置空（回到引导期）、段号 +1 并置 `AUTH_EVT.worldRebuild`、
   * 整门重建（旧锚随旧门一起丢弃，否则旧锚会把归零后的新标号判成乱序）。 */
  externalWorldRebuild(): void;
  /** 遥测快照（恒为同一预分配对象）。 */
  readonly stats: TickF4Stats;
  /** 当前排序门（周期变更或 world 重建会替换它，故为 getter）。 */
  readonly gate: OrderingGate;
}

/** 乐观开火地板（ms）：`remaining ≤ 本值` 时放弃本 tick 的乐观帧——留给它的展示时长
 * 不足 1ms，而修订帧随即到达，发出去只会多一次撤帧。该判据同时吞掉追赶爆发
 * （`remaining ≤ 0`）：两条都记入门上游的 `floorSkips`。 */
const OPT_FIRE_FLOOR_MS = 1;

/** 梯子字段的空值（`src/phys/mod.rs` 的 `state_out` 第 14 槽在不在梯子上时写 -1）。 */
const LADDER_NONE = -1;

/** 组装控制器：读一次周期建门、分配遥测与姿态记录，返回 `TickF4Controller`。
 *
 * 副作用只有建门那次（`Float64Array` 视图与门的替换都是后续的懒建/重建）；调用本身
 * 不触碰通道、不触碰任何物理实例，也不发布帧——发布要等 `enterMode` 之后的
 * `onWake` 或 `publishMeta`。 */
export function createTickAuthority(env: TickAuthorityEnv): TickF4Controller {
  const post: (msg: unknown) => void =
    env.post ??
    ((msg: unknown): void => {
      if (typeof self !== 'undefined') {
        (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
      }
    });

  // ── 排序门（周期变更即整门重建——罕见路径，允许分配）。ε_max 固定取
  // EPSILON_MAX_SETTIMEOUT_MS，故 δ 的上界随周期变成 T - 8；换精确唤醒档位时
  // 只需改这里传入的档位常量。────────────────────────────────────────────
  function makeGate(periodMs: number): OrderingGate {
    return createOrderingGate({
      tickPeriodMs: periodMs,
      epsilonMaxMs: EPSILON_MAX_SETTIMEOUT_MS,
      leadDeltaMs: env.getLeadDeltaMs?.(),
    });
  }
  let gatePeriodMs = env.getTickPeriodMs();
  let gate: OrderingGate = makeGate(gatePeriodMs);

  // ── 预分配状态（下列对象在控制器生命周期内只建一次）────────────────────
  const stats: TickF4Stats = {
    optimisticPublished: 0,
    leadMiss: 0,
    blockedOrder: 0,
    bootstrapSkips: 0,
    orphanedCap: 0,
    keyEdgeSkips: 0,
    floorSkips: 0,
    revisions: 0,
    divBulk: 0,
    divFlip: 0,
    divBulkMaxU: 0,
    divFlipMaxU: 0,
    divBulkSumU: 0,
    divBulkOverCap: 0,
    holdTicks: 0,
    seg: 0,
    tickLabel: 0,
    f4Ready: false,
  };
  /** 权威姿态记录：真实步写、`onRealTick` 读，两侧共用同一对象。 */
  const pose: AuthorityPose = {
    x: 0, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
    eyeHeight: 0, onGround: false, ducked: 0, surfing: 0, blockedTicks: 0, ladder: LADDER_NONE,
  };
  /** 待对账的乐观帧（字段复用：每次发布就地覆写，不新建对象）。 */
  const pendingOpt = {
    valid: false,
    label: 0,
    x: 0,
    y: 0,
    z: 0,
    onGround: false,
    ducked: 0,
    surfing: 0,
    blockedTicks: 0,
    ladder: LADDER_NONE,
  };

  // 视图缓存（权威与 scratch 各一组；实例身份或 buffer 身份变了才重建）
  let authorityView: Float64Array | null = null;
  let authorityViewInst: F4AuthorityWorld | null = null;
  let authorityViewBuffer: ArrayBuffer | null = null;
  let scratchView: Float64Array | null = null;
  let scratchViewInst: F4ScratchWorld | null = null;
  let scratchViewBuffer: ArrayBuffer | null = null;

  // tick 模式状态机
  let tickMode = false;
  /** 最近一次已发布真实帧的标号（null = tick 模式下还没有真实帧，即引导期）。 */
  let lastAuthLabel: number | null = null;
  /** 下一个真实帧会使用的标号（`publishMeta` 递增，world 重建归零）。 */
  let nextTickLabel = 0;
  /** 段号（与 `src/ts-shared/auth/shared-state.ts` 的 `I_A_SEG` 同源；断点事件 +1）。 */
  let segSeq = 0;
  /** 尚未发布的事件位（外部断点、键沿、事件排空累积；由发布出口排空）。 */
  let pendingEvt = 0;
  /** 键沿比对基线（`onInput` 每次覆写；`enterMode` 用 `peekKeys` 初始化）。 */
  let lastRealKeys = 0;
  /** 封帽与翻转分类的对照基线：上一次真实帧经 `onRealTick` 记下的接触类字段。 */
  let baseOnGround = false;
  let baseDucked = 0;
  let baseSurfing = 0;
  let baseBlocked = 0;
  let baseLadder = LADDER_NONE;
  /** 遥测节拍的上次发送时刻（1s 一次）。 */
  let lastStatsPostMs = 0;

  /** 乐观径就绪判据：tick 模式 ∧ 通道有 `peekInput` ∧ 权威与 scratch 都在 ∧
   * wasm buffer 非空。 */
  function optReady(): boolean {
    if (!tickMode) return false;
    const shared = env.getShared();
    const authority = env.getAuthority();
    const scratch = env.getScratch();
    if (!shared || !authority || !scratch) return false;
    if (typeof (shared as { peekInput?: unknown }).peekInput !== 'function') return false;
    if (!env.getWasmBuffer()) return false;
    return true;
  }

  /** 懒重建视图：实例身份或 buffer 身份变了才新建 `Float64Array`（真实步与每次唤醒
   * 各查一次，身份未变即零分配）。 */
  function refreshViews(): void {
    const buffer = env.getWasmBuffer();
    const authority = env.getAuthority();
    if (authority && buffer) {
      if (authorityViewInst !== authority || authorityViewBuffer !== buffer) {
        authorityView = new Float64Array(buffer, authority.state_out_ptr(), 22);
        authorityViewInst = authority;
        authorityViewBuffer = buffer;
      }
    } else {
      authorityView = null;
      authorityViewInst = null;
      authorityViewBuffer = null;
    }
    const scratch = env.getScratch();
    if (scratch && buffer) {
      if (scratchViewInst !== scratch || scratchViewBuffer !== buffer) {
        scratchView = new Float64Array(buffer, scratch.state_out_ptr(), 22);
        scratchViewInst = scratch;
        scratchViewBuffer = buffer;
      }
    } else {
      scratchView = null;
      scratchViewInst = null;
      scratchViewBuffer = null;
    }
  }

  /** 视图 → 姿态记录（原地覆写，零分配）。槽位映射：0-2 位置、3-5 速度、6 偏航、
   * 7 俯仰、8 蹲伏、12 滑行、13 被阻 tick、14 梯子索引、20 眼高、21 着地（`=== 1`）；
   * 9-11 与 15-19 槽本文件不读。槽位定义在 `src/phys/mod.rs` 的 `fill_state_out`
   * 与 `tick_into` 里。 */
  function fillPoseFromView(o: Float64Array, p: AuthorityPose): void {
    p.x = o[0];
    p.y = o[1];
    p.z = o[2];
    p.velX = o[3];
    p.velY = o[4];
    p.velZ = o[5];
    p.yaw = o[6];
    p.pitch = o[7];
    p.ducked = o[8];
    p.surfing = o[12];
    p.blockedTicks = o[13];
    p.ladder = o[14];
    p.eyeHeight = o[20];
    p.onGround = o[21] === 1;
  }

  /** 把门的三个计数就地拷进遥测（遥测的单读入口；门的 `stats` 才是权威源，门重建后
   * 由下一次拷贝刷新）。 */
  function mirrorGateStats(): void {
    stats.optimisticPublished = gate.stats.optimisticPublished;
    stats.leadMiss = gate.stats.leadMiss;
    stats.blockedOrder = gate.stats.blockedOrder;
  }

  return {
    stats,

    get gate(): OrderingGate {
      // 门会被替换（周期变更或 world 重建），故每次取当前实例
      return gate;
    },

    isActive(): boolean {
      // 比 optReady 宽松：真实步只需要权威实例与 buffer，不需要 scratch 与 peekInput
      return tickMode && env.getAuthority() !== null && env.getWasmBuffer() !== null;
    },

    authorityTickInto(dt: number, keysMask: number, dx: number, dy: number): void {
      // 调用方（auth-loop 的零分配支路）已按 isActive 把关，本方法不再查 tickMode
      const authority = env.getAuthority();
      if (!authority) return;
      refreshViews();
      authority.tick_into(dt, keysMask, dx, dy);
      if (authorityView) fillPoseFromView(authorityView, pose);
    },

    authorityPose: pose,

    noteHoldTick(): void {
      stats.holdTicks++;
      pendingOpt.valid = false; // 冻结接管：投影作废，下一个真实帧不再与它对账
    },

    onInput(keysMask: number): void {
      if (!tickMode) return;
      // R 键（位 128 = src/ts-shared/auth/shared-state.ts 的 KEY_MASK.reset）取上升沿：
      // src/phys/mod.rs 的 step_core 走 reset 分支重生时不置物理事件（只有传送与掉落
      // 死亡会置），故这次状态不连续只能由输入侧补齐。取边沿而非电平——按住期间不会
      // 重复刷段。
      if ((keysMask & 128) !== 0 && (lastRealKeys & 128) === 0) {
        segSeq = (segSeq + 1) | 0;
        pendingEvt |= AUTH_EVT.reset;
        stats.seg = segSeq;
      }
      lastRealKeys = keysMask;
    },

    publishMeta(): AuthPublishMeta | undefined {
      if (!tickMode) return undefined;
      // 先排空事件槽再组帧：事件位随本帧出，且 take_event 是一次性消费。本控制器是
      // tick 模式下唯一排空权威事件槽的一方（meta 走缺省的耦合/解耦路径根本不调本方法）
      const authority = env.getAuthority();
      if (authority) {
        const ev = authority.take_event() as { kind?: string } | null;
        if (ev) {
          // 只认 teleport 与 death 两类（与 src/phys/mod.rs 的 take_event 返回的 kind
          // 集合一致）；其他 kind 既不改段号也不置位
          if (ev.kind === 'teleport') {
            segSeq = (segSeq + 1) | 0;
            pendingEvt |= AUTH_EVT.teleport;
          } else if (ev.kind === 'death') {
            segSeq = (segSeq + 1) | 0;
            pendingEvt |= AUTH_EVT.death;
          }
        }
      }
      const meta: AuthPublishMeta = { seg: segSeq, tick: nextTickLabel, evt: pendingEvt };
      lastAuthLabel = nextTickLabel;
      nextTickLabel = (nextTickLabel + 1) | 0;
      pendingEvt = 0;
      gate.noteAuthoritative(lastAuthLabel); // 排序锚：门用它判定乐观帧的前驱是否已发
      stats.seg = segSeq;
      stats.tickLabel = nextTickLabel;
      return meta;
    },

    onRealTick(_nowMs: number, p: RealTickPose): void {
      if (!tickMode) return;
      // 修订对账 + 位移差分桶：位置三轴算模长（HU）；接触类字段任一翻转进 flip 桶，
      // 其余进 bulk 桶
      if (pendingOpt.valid) {
        if (pendingOpt.label === lastAuthLabel) {
          const dx = p.x - pendingOpt.x;
          const dy = p.y - pendingOpt.y;
          const dz = p.z - pendingOpt.z;
          const div = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const flip =
            p.onGround !== pendingOpt.onGround ||
            p.ducked !== pendingOpt.ducked ||
            p.surfing !== pendingOpt.surfing ||
            p.blockedTicks > pendingOpt.blockedTicks ||
            p.ladder !== pendingOpt.ladder;
          if (flip) {
            stats.divFlip++;
            if (div > stats.divFlipMaxU) stats.divFlipMaxU = div;
          } else {
            stats.divBulk++;
            stats.divBulkSumU += div;
            if (div > stats.divBulkMaxU) stats.divBulkMaxU = div;
            if (div > 2.5) stats.divBulkOverCap++;
          }
          stats.revisions++;
        }
        // 标号对不上（帧被 hold 或 world 重建吞掉）→ 本帧不作对账，投影照样作废
        pendingOpt.valid = false;
      }
      // 基线刷新：供下一次内容封帽与翻转分类对照
      baseOnGround = p.onGround;
      baseDucked = p.ducked;
      baseSurfing = p.surfing;
      baseBlocked = p.blockedTicks;
      baseLadder = p.ladder;
      mirrorGateStats();
    },

    onWake(nowMs: number, nextDueMs: number): void {
      if (!tickMode) return;
      // 遥测节拍：1s 一次浅拷贝快照（这条路径上唯一的分配点）
      if (nowMs - lastStatsPostMs >= 1000) {
        lastStatsPostMs = nowMs;
        mirrorGateStats();
        post({ type: 'tick-stats', stats: { ...stats } });
      }
      const ready = optReady();
      stats.f4Ready = ready;
      if (!ready) return;
      if (lastAuthLabel === null) {
        stats.bootstrapSkips++; // 引导期无锚：本 tick 不尝试，真实步照常
        return;
      }
      // 周期变了就整门重建（δ 上界随周期重算）；非正数视为无效配置，本唤醒退出
      const periodMs = env.getTickPeriodMs();
      if (!(periodMs > 0)) return;
      if (periodMs !== gatePeriodMs) {
        gatePeriodMs = periodMs;
        gate = makeGate(periodMs);
      }
      const remaining = nextDueMs - nowMs;
      // 开火窗 = due 前 T - δ；再早属每 tick 多次的正常早醒，不尝试也不记账
      const fireWindowMs = periodMs - gate.leadDeltaMs;
      if (remaining > fireWindowMs) return; // 窗外早醒（非损失，不记账）
      if (remaining <= OPT_FIRE_FLOOR_MS) {
        // 迟到地板：留给乐观帧的展示不足 1ms，且追赶爆发（remaining ≤ 0）同落此分支
        // ——放弃本 tick，并把这笔门上游损失显式记账（未触门，门闭账照旧恒等）
        stats.floorSkips++;
        return;
      }
      const shared = env.getShared() as ShmState; // optReady 已确认有 peekInput（MsgState 没有）
      const authority = env.getAuthority() as F4AuthorityWorld;
      const scratch = env.getScratch() as F4ScratchWorld;
      const maxStep = 1200; // 整 tick 的输入上限（未按 dt 缩放）；src/ts-shared/auth/auth-loop.ts 的 MAX_INPUT_PER_STEP_BASE 同为 1200，那边按 dt 缩放后才交给 takeInput
      const peek = shared.peekInput(maxStep);
      // 键沿守卫：与上一次真实帧的键位相比有任何一位不同就跳过本 tick（含松键，R 位在内）
      if ((peek.keysMask ^ lastRealKeys) !== 0) {
        stats.keyEdgeSkips++;
        return;
      }
      const L = (lastAuthLabel + 1) | 0;
      // 同标号守卫：本标号的乐观帧已经发出，窗内重复唤醒不重发（门的放行计数即帧数）
      if (pendingOpt.valid && pendingOpt.label === L) return;
      // 单向播种：把权威的当前种子逐字段拷进 scratch，src 只被读——这是乐观路径对
      // 权威实例的唯一一次调用
      scratch.seed_from(authority);
      // 乐观单步：dt 取整 tick 周期，代表标号 L 的网格时刻（输入是上面的非消耗读）
      scratch.tick_into(periodMs / 1000, peek.keysMask, peek.dx, peek.dy);
      // scratch 的事件槽随手排空（事件随该实例丢弃，真实步会在权威实例上重放同一事件）
      // ——但本帧一旦检出事件或 scratch 视图缺失就孤儿化该帧：不经过门，也就不进门闭账
      const ev = scratch.take_event();
      refreshViews();
      const o = scratchView;
      if ((ev !== null && ev !== undefined) || !o) {
        stats.orphanedCap++;
        return;
      }
      // 内容封帽：接触类字段任一偏离基线即孤儿化（与事件判据并列，同为门上游）
      const oDucked = o[8];
      const oSurfing = o[12];
      const oBlocked = o[13];
      const oLadder = o[14];
      const oOnGround = o[21] === 1;
      if (
        oOnGround !== baseOnGround ||
        oBlocked > baseBlocked ||
        oLadder !== baseLadder ||
        oDucked !== baseDucked ||
        oSurfing !== baseSurfing
      ) {
        stats.orphanedCap++;
        return;
      }
      // 排序门裁决：排序不变量 + ε 尾；非 publish 即本 tick 不发乐观帧
      const verdict = gate.authorizeOptimistic(L, nowMs, nextDueMs);
      mirrorGateStats();
      if (verdict !== 'publish') return;
      // 乐观帧：evt 只带 AUTH_EVT_OPT 位（低 8 位事件位为 0），三元组与 onGround 由
      // writeAuthoritative 的 seqlock 写序发布
      shared.writeAuthoritative(
        {
          pos: { x: o[0], y: o[1], z: o[2] },
          yaw: o[6],
          pitch: o[7],
          vel: { x: o[3], y: o[4], z: o[5] },
          eyeHeight: o[20],
          timeMs: nextDueMs, // 该标号的网格 due（乐观帧代表 L 时刻态，不取墙钟）
        },
        oOnGround,
        { seg: segSeq, tick: L, evt: AUTH_EVT_OPT },
      );
      pendingOpt.valid = true;
      pendingOpt.label = L;
      pendingOpt.x = o[0];
      pendingOpt.y = o[1];
      pendingOpt.z = o[2];
      pendingOpt.onGround = oOnGround;
      pendingOpt.ducked = oDucked;
      pendingOpt.surfing = oSurfing;
      pendingOpt.blockedTicks = oBlocked;
      pendingOpt.ladder = oLadder;
    },

    enterMode(): void {
      tickMode = true;
      segSeq = (segSeq + 1) | 0; // 交接本身是一次断点：段号 +1 并置 modeSwitch 位
      pendingEvt |= AUTH_EVT.modeSwitch;
      pendingOpt.valid = false;
      const keys = env.getShared();
      lastRealKeys =
        keys && typeof (keys as { peekKeys?: unknown }).peekKeys === 'function'
          ? (keys as ShmState).peekKeys()
          : 0;
      stats.seg = segSeq;
      stats.tickLabel = nextTickLabel;
      stats.f4Ready = optReady();
    },

    exitMode(): void {
      if (!tickMode) return;
      tickMode = false;
      pendingOpt.valid = false;
      pendingEvt = 0; // 未发布的事件位不得漏进耦合/解耦发布（那边 meta 走缺省）
      stats.f4Ready = false;
    },

    firstFrameMeta(): AuthPublishMeta | undefined {
      if (!tickMode) return undefined;
      // 首帧与 publishMeta 的两点差别：标号不递增（沿用当前值），排序门锚不动——
      // 故首帧之后门仍处无锚状态，第一次乐观尝试会被记成 leadMiss。事件位同样在此排空。
      const meta: AuthPublishMeta = { seg: segSeq, tick: nextTickLabel, evt: pendingEvt };
      pendingEvt = 0;
      return meta;
    },

    externalBreak(evtBit: number): void {
      if (!tickMode) return;
      segSeq = (segSeq + 1) | 0;
      pendingEvt |= evtBit;
      stats.seg = segSeq;
    },

    externalWorldRebuild(): void {
      if (!tickMode) return;
      nextTickLabel = 0; // 标号归零：重建后第一个真实帧从 0 开始
      lastAuthLabel = null; // 锚置空 → 回到引导期，重建后重新 bootstrap
      segSeq = (segSeq + 1) | 0;
      pendingEvt |= AUTH_EVT.worldRebuild;
      gate = makeGate(gatePeriodMs); // 旧门连同旧锚一起丢弃（留着旧锚会把新标号判成乱序）
      mirrorGateStats();
      stats.seg = segSeq;
      stats.tickLabel = 0;
      stats.f4Ready = optReady();
    },
  };
}
