/**
 * 解耦环控制器（共享层 `src/ts-shared/`）。
 *
 * 定位：本文件导出闭包式控制器工厂 `createDecoupledLoop`。控制器用 `setTimeout` 自驱轮询，
 * 每轮按 mode gate 决定是否推进被注入的物理实例：
 * - `phys`：1ms 定长子步的真理源，位置与角度只由它推进；
 * - `tickPhys`：可选第二实例，按 raw tick 速率独立演化，对本环的唯一影响通道是
 *   `set_velocity`（速度校准线）。
 * 推进结果经跨线程状态通道的解耦帧写入方法发到解耦帧槽（`S_D`）供主线程消费。
 *
 * 上下游调用点（各一）：
 * - 下游：`src/ts-shared/auth/worker-dispatch.ts` 的 `createWorkerDispatch`——其环境槽
 *   `decoupledLoop` 以本文件的 `DecoupledLoop` 类型接收环句柄，并在 `publishCurrentState`、
 *   `onTickRateChanged`、`resetSamplers` 三处调用。
 * - 上游：`src/ts-shared/auth/shared-state.ts` 的 `ShmState` / `MsgState`——本环经
 *   `writeDecoupled` 发帧、经 `consumeInput` / `peekKeys` 取输入、经 `waitWakeup` 做背压。
 *
 * 装配现状：`createDecoupledLoop` 在 `src/**` 与 `apps/**` 内没有调用点——三个工程的 worker
 * 入口都只装配 `createWorkerDispatch`，而其中接收 `decoupledLoop` 的槽是可选的、无人填充。
 * 即本环**已实现、未接线**；上面写的下游调用点描述的是类型与方法契约的消费方，不是运行中的
 * 装配点。
 *
 * 关键不变量：
 * - 同一时刻至多一条线推进 `phys`：`loop` 以 `env.isDecoupled()` 为 mode gate，门关时整轮
 *   不取输入、不推进、不发帧。
 * - `phys` 的位置与角度只由 `tick_into` 推进——`set_velocity` 只覆盖速度三轴；唯一例外是
 *   hold 冻结轮用 `set_state` 显式写入冻结态。
 * - `tickPhys` 与 `phys` 之间只有两条通道：`alignTickPhys` 写 `tickPhys`（对齐），
 *   `set_velocity` 写 `phys`（校准）。本环从不读 `tickPhys` 的位置或角度。
 * - 每轮 `loop` 在做任何物理计算**之前**先排下一轮 `setTimeout`：任何提前返回（门关、
 *   通道为空、实例为空、hold 冻结）都不会中断自驱链。
 * - `state_out` 的 `Float64Array` 视图与 `memory.buffer` 绑定；`buffer` 更换后必须按
 *   `state_out_ptr` 重建，否则旧视图被 detach。
 *
 * 边界与容错：
 * - `env.shared` 或 `env.getPhys()` 为空 ⇒ 本轮 4ms 空转，不推进物理。
 * - 未注入 `getWasmMemory` 或其返回 null ⇒ 发布退化到 `phys.state()` 的对象读数路径，
 *   仍然发帧。
 * - `getTickPhys()` 为空，或速率归一后 `1 / tickRate <= RENDER_DT` ⇒ 本环只跑 1ms
 *   无限制线、`loAcc` 归零，且不再向 tick 边界累积输入。
 * - `getHold()` 返回非 null ⇒ 整轮冻结：时间与输入丢弃、物理静止，只发冻结帧。
 * - 主循环自带三级限幅：delta 钳到 `[0, MAX_DELTA]`、每轮子步数不超过
 *   `MAX_STEPS_PER_ROUND`、残留累加器封顶 `MAX_ACC`。
 *
 * 测试归属：本文件在 `src/**` 与 `apps/**` 内无装配点，全仓也没有导入本文件的 `*.test.ts`
 * （`src/ts-shared/` 下现有四篇测试分别针对 compute-mode、shared-state 协议、tick-authority
 * 与 ordering-gate）。可用的门是类型检查：`apps/game`、`apps/debug`、`apps/viewer` 各自的
 * `npm run typecheck`。
 *
 * 与相邻文件的边界：
 * - `src/ts-shared/auth/auth-loop.ts`：`createAuthLoop` 是另一条线。两线共用 `PhysWorldLike`
 *   结构面与 `src/ts-shared/auth/compute-mode.ts` 的模式谓词，但输入消费口径不同——
 *   `AuthLoop` 走 `takeInput(maxStep)` 的饱和截断，本环走 `consumeInput()` 的 CAS 清零不截断。
 * - `src/ts-shared/auth/shared-state.ts`：本环只写解耦帧槽（`writeDecoupled`），不写权威帧；
 *   权威帧与标号(tick) 三元组由另一条线负责。
 * - `src/ts-shared/auth/tick-authority.ts`：同样消费 `state_out`，但它建 22 槽视图来驱动
 *   `tick_into`；本环只建 8 槽（0-7），不读 8 槽之后的慢字段。
 * - `src/ts-shared/phys/constants.ts`：本环只取 `EYE_STAND` 作慢字段缓存初值。
 */

import type { ShmState, MsgState, AuthFrame } from '../auth/shared-state.js';
import type { PhysWorldLike } from '../auth/auth-loop.js';
import { EYE_STAND } from '../phys/constants.js';

/** 计算模式三值的类型再导出。权威定义在 `src/ts-shared/auth/compute-mode.ts` 的
 * `ComputeMode`（`'coupled' | 'decoupled' | 'tick'`），同文件的 `isDecoupledLineMode`
 * 是它的解耦线谓词。本仓当前没有从本文件导入该类型的消费方。 */
export type { ComputeMode } from '../auth/compute-mode.js';

/** 主线程同步渲染态的结构等价声明（10 字段）。字段与
 * `src/ts-shared/phys/authority-calibrator.ts` 的 `SyncRenderState` 逐一同名同类型；
 * 本文件不导入校准器模块，两端按结构兼容。消费点：`src/ts-shared/auth/worker-dispatch.ts`
 * 的 `onSetMode(mode, state)` 形参。 */
export interface SyncRenderStateLike {
  posX: number;
  posY: number;
  posZ: number;
  yaw: number;
  pitch: number;
  velX: number;
  velY: number;
  velZ: number;
  onGround: boolean;
  eyeHeight: number;
}

/** 存点全量恢复形状的结构等价声明。与 `apps/game/src/savepoint.ts` 的 `SavePoint`
 * 同字段，差别只在 `t`：本声明可选，那边的 `SavePoint.t` 是必需的时间戳（列表排序用）。
 * 消费点：`src/ts-shared/auth/worker-dispatch.ts` 的 `onSetHold(hold, release)` 形参。 */
export interface SavePointLike {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  t?: number;
}

/** 解耦 hold 冻结态，即 `set-hold` 消息注入的载荷。字段与
 * `src/ts-shared/auth/auth-loop.ts` 的 `HoldSnapshot` 逐一同名同类型——两端各就地声明、
 * 不做模块间类型依赖。本环在冻结轮用它逐轮强制 `set_state`（速度写 0）。 */
export interface HoldState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  onGround: boolean;
}

/** 解耦环要求 wasm 实例额外具备的接口：在 `PhysWorldLike` 之上补零分配热路径与速度校准
 * 通道。满足方是 `src/phys/mod.rs` 的 `PhysWorld`（`tick_into` / `state_out_ptr` /
 * `set_velocity` 三个方法均已导出），经 `apps/debug/crates/wasm/src/lib.rs` 与
 * `apps/game/crates/wasm/src/lib.rs` 的 `pub use websurf_phys::phys::PhysWorld` 转出；
 * `apps/viewer` 的 wasm 包不转出 `PhysWorld`。 */
export interface DecoupledPhysWorld extends PhysWorldLike {
  /** 零分配推进：状态写进实例固定缓冲 `state_out` 的 0-7 槽（0-2 位置 x/y/z、
   * 3-5 速度 x/y/z、6 yaw、7 pitch），不构造 wasm→JS 对象。`src/phys/mod.rs` 的
   * `tick_into` 在 `build_world` 未执行时直接返回、不写缓冲。 */
  tick_into(dt: number, keysMask: number, dx: number, dy: number): void;
  /** `state_out` 在 wasm 线性内存中的字节地址，供 `Float64Array` 视图定位。
   * 地址在实例存活期内不变；wasm 内存增长会更换 `memory.buffer`，视图须重建。 */
  state_out_ptr(): number;
  /** 速度注入：只覆盖速度三轴，位置、朝向、着地状态都不动（`src/phys/mod.rs` 的
   * `set_velocity`）。本环把它当作 `tickPhys` → `phys` 的唯一校准通道。 */
  set_velocity(vx: number, vy: number, vz: number): void;
}

export interface DecoupledLoopEnv {
  /** 跨线程状态通道句柄（`ShmState` 走 SAB，`MsgState` 走消息回退）。本环每轮重新读取该
   * 字段，故可在 init 消息之后注入；为 null 时本轮 mode gate 判为不活跃。 */
  shared: ShmState | MsgState | null;
  /** 取真理源实例 `phys`。返回 null（世界尚未构建）时本轮判为不活跃。 */
  getPhys(): DecoupledPhysWorld | null;
  /** 取速度校准线实例 `tickPhys`。返回 null 时本环跳过 tick 边界计算并把 `loAcc` 归零。 */
  getTickPhys(): DecoupledPhysWorld | null;
  /** `tickPhys` 的步长源，单位 Hz。本环对返回值做归一：非有限或为负一律当 0；随后以
   * `tickRate > 0 && 1 / tickRate > RENDER_DT` 判定该线是否激活，故 0 与不小于 1000 的
   * 取值都落到不激活。 */
  getTickPhysRate(): number;
  /** mode gate：本环的活跃谓词。取值为假时整轮不做物理、不发帧，只按 4ms 空转。 */
  isDecoupled(): boolean;
  /** wasm 线性内存宿主（`state_out` 视图的 `memory.buffer` 来源）。未注入或返回 null ⇒
   * `publishFromStateOut` 返回 false，发布退化到 `phys.state()` 的对象读数路径。 */
  getWasmMemory?(): WebAssembly.Memory | null;
  /** 解耦 hold 冻结态。返回非 null ⇒ 本轮走 `runHeldRound`（时间与输入丢弃、物理静止）。 */
  getHold?(): HoldState | null;
}

export interface DecoupledLoop {
  /** `tickPhys` 速率变更后的重锚：清 `loAcc` / `tickDxAcc` / `tickDyAcc` 并对齐 `tickPhys`。
   * 不动 `acc` 与 `lastNow`——1ms 子步累加器与其墙钟基准跨速率变更继续沿用，步长变化后
   * 相位按新 `tickDt` 自然延续。也不复位 `modeBWasActive`，故下一轮仍按当前激活状态与
   * 上一轮比较，不会重复触发激活边沿。 */
  onTickRateChanged(): void;
  /** 采样器全清：`acc` / `loAcc` / `tickDxAcc` / `tickDyAcc` 归零，`modeBWasActive` 复位为
   * false，`lastNow` 刷新为当前墙钟；`align` 为真时再执行一次 `alignTickPhys`。复位
   * `modeBWasActive` 使下一轮把仍在激活的 `tickPhys` 当作一次新的激活边沿处理。 */
  resetSamplers(align?: boolean): void;
  /** 立即发一帧当前 `phys` 状态。与热路径不同，本方法固定走 `publishFromState` 的
   * `phys.state()` 对象读数路径，并在发帧前用 `refreshSlowFields(nowMs, true)` 强制刷新
   * 慢字段缓存；方法与刷新各取一次 `performance.now()`。 */
  publishCurrentState(): void;
  /** 启动自驱链（幂等）：`started` 已置位时直接返回；未置位时刷新 `lastNow` 并**同步**
   * 调用一次 `loop`。可在 wasm 就绪之前调用——此阶段 mode gate 为假，每轮只排 4ms 空转。 */
  start(): void;
}

// ── 本环自有常量（全部只在本文件内使用，无导出）────────────────────────
//    时间量单位为秒；像素量单位为 CSS 像素（与主线程输入口径一致）──
/** 真理源固定子步（秒）。`acc` 以它为步长累加与扣减，`tick_into` 以它为 dt；
 * 同时是 `tickInputMax` 把像素基数折算到 tick 窗口的归一基准。 */
const RENDER_DT = 0.001;
/** 单轮真实时间片上限（秒，= 50ms）。`loop` 先把 `now - lastNow` 换算成秒，再钳上界、
 * 最后把负值归零（墙钟回拨时）。 */
const MAX_DELTA = 0.05;
/** 单轮 `tick_into` 的调用次数上限（8 次）。用满时保留剩余 `acc`，由 `MAX_ACC` 封顶后
 * 交下一轮补跑。 */
const MAX_STEPS_PER_ROUND = 8;
/** `acc` 的残留上限（秒，= 20ms）。`loop` 在子步 while 之后无条件执行钳制；该 while 只有
 * 两条出口——`acc < RENDER_DT`（此时 `acc` 已小于本值，钳制不改变取值）或子步数用满，
 * 故钳制只在子步数用满时起作用。 */
const MAX_ACC = 0.02;
/** 鼠标增量的基数（像素），与 `src/ts-shared/input/input-layer.ts` 的 `INPUT_CLAMP` 同值
 * ——主线程已把单帧增量钳到 ±`INPUT_CLAMP`。本环只用它经 `tickInputMax` 推 tick 边界窗口
 * 的上限，不直接参与钳制。 */
const MAX_INPUT_DELTA = 1000;
/** 背压挂起阈值（ms）。`loop` 末尾按 `acc` 余量算出距下一次 1ms 子步的剩余时间 `idleMs`，
 * 只有 `idleMs >= 本值` 才挂起，否则直接自旋进入下一轮。 */
const WAIT_THRESHOLD_MS = 1;
/** 单次背压挂起的时长上限（ms）。实际挂起时长为 `min(idleMs, 本值)`；hold 冻结轮固定用它。 */
const MAX_WAIT_MS = 4;
/** 分叉兜底锚定的距离阈值（HU）。`tickDiverged` 比较两者位置的三维距离平方与本值的平方
 * （严格大于），超过即由 `alignTickPhys` 把 `tickPhys` 整体拉回 `phys`。 */
const TICK_ANCHOR_DIST = 64;
/** 慢字段（`eyeHeight` / `onGround`）缓存的最短刷新间隔（ms，= 16）。`refreshSlowFields`
 * 以 `nowMs - lastSlowMs < 本值` 判定跳过；`force` 为真时绕过该判定。 */
const SLOW_FIELD_REFRESH_MS = 16;

/** tick 边界鼠标增量上限：以 `MAX_INPUT_DELTA` 为基数，按 tick 窗口相对 `RENDER_DT` 的倍数
 * 等比放大——即把"每 1ms 子步的基数"折算到整个 tick 窗口。`tickRate = 64` 时
 * `tickDt = 1 / 64`、倍率 15.625、上限 15625 像素。返回值为对称上界，交由 `clampAbs` 使用。 */
function tickInputMax(tickDt: number): number {
  return MAX_INPUT_DELTA * (tickDt / RENDER_DT);
}

export function createDecoupledLoop(env: DecoupledLoopEnv): DecoupledLoop {
  // ── 运行时状态（闭包私有；loop 与其被调函数之间共享）────────────────
  /** 1ms 子步累加器（秒）。只被第二步累加与扣减；`resetSamplers` 与 `runHeldRound` 清零。 */
  let acc = 0;
  /** `tickPhys` 的 `tickDt` 累加器（秒）。每个 tick 边界扣掉一个 `tickDt` 并保留余数，余数
   * 使边界相对真实时间轴不漂移；`tickPhys` 不激活的轮次、速率变更与冻结轮都把它清零。 */
  let loAcc = 0;
  /** tick 边界窗口内的鼠标 X 增量累积（像素）。只在第二步按 `consumeInput` 的读数累加，
   * 只在 tick 边界被取用并清零。 */
  let tickDxAcc = 0;
  /** tick 边界窗口内的鼠标 Y 增量累积（像素），与 `tickDxAcc` 同生命周期。 */
  let tickDyAcc = 0;
  /** 上一轮 `tickPhys` 是否激活。与本周期的判定值比较得出两种边沿：停用→激活（清累积器
   * 并对齐 `tickPhys`）与激活→停用（只清累积器）。 */
  let modeBWasActive = false;
  /** 上一轮取样时刻（`performance.now()`，ms）。`start`、`resetSamplers` 与不活跃轮都会
   * 刷新它，使下一轮的 delta 不跨越大段空闲。 */
  let lastNow = performance.now();
  /** `start` 的幂等标志。置位后 `start` 直接返回，不会产生第二条自驱链。 */
  let started = false;

  // ── 慢字段缓存（eyeHeight/onGround；按 SLOW_FIELD_REFRESH_MS 低频 state() 刷新）───────
  let slowEyeHeight = EYE_STAND; // 初值取共享层常量；首次刷新前被读取时用此兜底值
  /** `onGround` 缓存；初始 false，等首次 `refreshSlowFields` / `publishFromState` 覆盖。 */
  let slowOnGround = false;
  /** 最近一次**成功**刷新慢字段的时刻（ms）。`refreshSlowFields` 在 `phys` 为 null 提前返回
   * 时不更新它，故下一轮会立刻重试。 */
  let lastSlowMs = 0;

  // ── state_out 零分配视图（与 memory.buffer 绑定；内存增长后按地址重建）──────────────
  /** 8 槽 `Float64Array` 视图；null 表示尚未建立。 */
  let outView: Float64Array | null = null;
  /** 建立视图时所用的 `ArrayBuffer`。与当前 `memory.buffer` 不等即触发重建。 */
  let outBuffer: ArrayBuffer | null = null;

  /** 对称限幅：把 `v` 钳到 `[-max, max]`。两个比较都为假时原样返回，故 NaN 会穿透。 */
  const clampAbs = (v: number, max: number): number =>
    v > max ? max : v < -max ? -max : v;

  /** 把 `tickPhys` 的整体状态对齐到 `phys` 的当前状态：读 `phys.state()` 的 9 个字段
   * （位置 3、yaw、pitch、速度 3、onGround）经 `set_state` 写入 `tickPhys`；任一侧实例为
   * null 时直接返回（no-op）。三个调用点：激活边沿、分叉锚定、速率变更/交接。
   * 注意它读的是**调用时刻**的 `phys` 状态——`runHeldRound` 在把 `phys` 写成冻结态**之前**
   * 调用它，故首个冻结轮写进 `tickPhys` 的是进入冻结前的 `phys` 状态。 */
  function alignTickPhys(): void {
    const phys = env.getPhys();
    const tickPhys = env.getTickPhys();
    if (!phys || !tickPhys) return;
    const s = phys.state() as {
      posX: number;
      posY: number;
      posZ: number;
      yaw: number;
      pitch: number;
      velX: number;
      velY: number;
      velZ: number;
      onGround: boolean;
    };
    tickPhys.set_state(s.posX, s.posY, s.posZ, s.yaw, s.pitch, s.velX, s.velY, s.velZ, s.onGround);
  }

  /** `tickPhys` 与 `phys` 的位置是否已分叉：比较两者 `state()` 的位置三元组，三维距离平方
   * 严格大于 `TICK_ANCHOR_DIST` 的平方即判分叉。任一侧实例为 null 时返回 false。 */
  function tickDiverged(): boolean {
    const phys = env.getPhys();
    const tickPhys = env.getTickPhys();
    if (!phys || !tickPhys) return false;
    const s = phys.state() as { posX: number; posY: number; posZ: number };
    const t = tickPhys.state() as { posX: number; posY: number; posZ: number };
    const dx = s.posX - t.posX;
    const dy = s.posY - t.posY;
    const dz = s.posZ - t.posZ;
    return dx * dx + dy * dy + dz * dz > TICK_ANCHOR_DIST * TICK_ANCHOR_DIST;
  }

  /** 刷新 `eyeHeight` / `onGround` 缓存：距 `lastSlowMs` 不足 `SLOW_FIELD_REFRESH_MS` 且
   * `force` 为假时直接返回；`phys` 为 null 时也直接返回（此时不更新 `lastSlowMs`，下一轮
   * 重试）。只有真正刷新成功才把 `lastSlowMs` 推到 `nowMs`。 */
  function refreshSlowFields(nowMs: number, force: boolean): void {
    if (!force && nowMs - lastSlowMs < SLOW_FIELD_REFRESH_MS) return;
    const phys = env.getPhys();
    if (!phys) return;
    const s = phys.state() as { eyeHeight: number; onGround: boolean };
    slowEyeHeight = s.eyeHeight;
    slowOnGround = s.onGround;
    lastSlowMs = nowMs;
  }

  /** 零分配发布路径：直读 `outView` 的 8 槽（位置 0-2、速度 3-5、yaw 6、pitch 7），与慢字段
   * 缓存拼成一帧写入解耦帧槽。`timeMs` 用调用方传入的 `nowMs`——`loop` 每轮只取一次该
   * 时间戳，故同一轮内的多个子步共用同一个 `timeMs`。发帧前按需刷新慢字段
   * （`refreshSlowFields(nowMs, false)`，即受 `SLOW_FIELD_REFRESH_MS` 间隔约束）。
   * @returns 是否走了本路径：`shared` / `phys` 为空、未注入 `getWasmMemory` 或其返回 null 时
   *   返回 false，调用方据此退化到 `publishFromState`。 */
  function publishFromStateOut(nowMs: number): boolean {
    const shared = env.shared;
    const phys = env.getPhys();
    if (!shared || !phys) return false;
    const memory = env.getWasmMemory?.() ?? null;
    if (!memory) return false;
    if (!outView || outBuffer !== memory.buffer) {
      // 视图与 buffer 绑定：wasm 内存增长会换掉 memory.buffer，此处按 state_out_ptr 重建
      outBuffer = memory.buffer;
      outView = new Float64Array(outBuffer, phys.state_out_ptr(), 8);
    }
    refreshSlowFields(nowMs, false);
    const v = outView;
    shared.writeDecoupled({
      pos: { x: v[0], y: v[1], z: v[2] },
      yaw: v[6],
      pitch: v[7],
      vel: { x: v[3], y: v[4], z: v[5] },
      eyeHeight: slowEyeHeight,
      onGround: slowOnGround,
      timeMs: nowMs,
    });
    return true;
  }

  /** 兜底发布路径：读 `phys.state()` 的 10 个字段，并**无条件**用其中的 `eyeHeight` /
   * `onGround` 覆盖慢字段缓存、把 `lastSlowMs` 推到 `nowMs`（不受刷新间隔约束）。
   * `shared` 或 `phys` 为 null 时不发帧。 */
  function publishFromState(nowMs: number): void {
    const shared = env.shared;
    const phys = env.getPhys();
    if (!shared || !phys) return;
    const s = phys.state() as {
      posX: number;
      posY: number;
      posZ: number;
      yaw: number;
      pitch: number;
      velX: number;
      velY: number;
      velZ: number;
      onGround: boolean;
      eyeHeight: number;
    };
    slowEyeHeight = s.eyeHeight;
    slowOnGround = s.onGround;
    lastSlowMs = nowMs;
    shared.writeDecoupled({
      pos: { x: s.posX, y: s.posY, z: s.posZ },
      yaw: s.yaw,
      pitch: s.pitch,
      vel: { x: s.velX, y: s.velY, z: s.velZ },
      eyeHeight: s.eyeHeight,
      onGround: s.onGround,
      timeMs: nowMs,
    });
  }

  /** hold 冻结轮：把 `acc` / `loAcc` 归零（冻结期间不累积时间），丢弃 `consumeInput` 读到的
   * 鼠标增量（键位掩码不随消费改变），对齐一次 `tickPhys`，再用 `set_state` 把 `phys` 写成
   * 冻结态（速度写 0），最后发一帧速度恒为 0、位置取自冻结态的帧。
   * 函数内重新读一次 `env.getHold()`：调用方判定与本函数读取之间 hold 已解除时直接返回，
   * 本轮不做冻结。 */
  function runHeldRound(): void {
    const shared = env.shared;
    const phys = env.getPhys();
    if (!shared || !phys) return;
    const hold = env.getHold?.() ?? null;
    if (!hold) return; // 重读发现 hold 已解除：本轮不冻结，下一轮按调用方判定继续
    acc = 0; // 冻结期间不累积时间：两个累加器同时归零
    loAcc = 0;
    shared.consumeInput(); // 丢弃已累积的鼠标增量；键位掩码不随消费改变
    alignTickPhys(); // 对齐源是此刻的 phys 状态（下一行 set_state 尚未执行）
    phys.set_state(hold.x, hold.y, hold.z, hold.yaw, hold.pitch, 0, 0, 0, hold.onGround);
    const nowMs = performance.now();
    shared.writeDecoupled({
      pos: { x: hold.x, y: hold.y, z: hold.z },
      yaw: hold.yaw,
      pitch: hold.pitch,
      vel: { x: 0, y: 0, z: 0 },
      eyeHeight: slowEyeHeight,
      onGround: hold.onGround,
      timeMs: nowMs,
    });
  }

  /** 主循环的一轮。固定执行顺序（顺序本身是硬约束，理由逐条见各步骤上方的行内注释）：
   * ① 排下一轮定时器 → ② 取 delta 并刷新 `lastNow` → ③ hold 冻结轮判定 → ④ `tickPhys`
   * 激活判定与两种边沿处理 → ⑤ 第一步 tick 边界计算 → ⑥ 第二步 1ms 无限制子步 →
   * ⑦ 背压挂起。
   *
   * 关键的两条先后关系：
   * - ⑤ 必须早于 ⑥。⑥ 的 `consumeInput` 是输入增量的取走者，它把本帧增量追加进
   *   `tickDxAcc` / `tickDyAcc` 供**下一个** tick 边界一次性注入；两步互换后，⑤ 读到的
   *   将是尚未由 ⑥ 消费的旧累积，并在同一轮内与 ⑥ 形成对同一份输入的双重使用。同时
   *   ⑤ 末尾的 `set_velocity` 必须写在 ⑥ 的 `tick_into` 之前，否则本轮 1ms 子步用的仍是
   *   上一轮的速度。
   * - ① 必须在所有提前返回之前。`active` 为假、通道/实例为空、hold 冻结都会提前返回，
   *   若定时器排在返回之后，自驱链会在第一次提前返回时终止。 */
  function loop(): void {
    const active = env.isDecoupled() && !!env.shared && !!env.getPhys();
    // 先排下一轮：任何提前返回都不会中断自驱链。本次让出事件循环同时负责投递
    // respawn / world-json / set-mode 等消息——活跃时 0ms 急轮询，门关时 4ms
    // （与 src/ts-shared/auth/auth-loop.ts 的自驱节奏一致）
    setTimeout(loop, active ? 0 : 4);
    if (!active) {
      lastNow = performance.now(); // 不活跃轮也刷新基准，使复入首轮 delta 不含空闲时长
      return;
    }

    const shared = env.shared;
    const phys = env.getPhys();
    if (!shared || !phys) return;
    const hold = env.getHold?.() ?? null;

    // 真实时间片 → 秒：先钳上界防炸，再把负值（墙钟回拨）归零
    const now = performance.now();
    let delta = (now - lastNow) / 1000;
    lastNow = now;
    if (delta > MAX_DELTA) delta = MAX_DELTA;
    if (delta < 0) delta = 0;

    // ── hold 冻结轮：时间与输入丢弃、物理静止（整轮只发冻结帧）──
    if (hold) {
      runHeldRound();
      // 冻结轮照常做背压挂起，固定用 MAX_WAIT_MS：hold 期间不占用 CPU
      shared.waitWakeup(MAX_WAIT_MS);
      return;
    }

    // ── tickPhys 激活判定：速率归一后按 1 / tickRate > RENDER_DT 判定，故 0 与非正值、
    //    以及不小于 1000Hz（步长不大于 1ms 子步）都落到不激活 ──
    let tickRate = env.getTickPhysRate();
    if (!Number.isFinite(tickRate) || tickRate < 0) tickRate = 0;
    const modeBActive = tickRate > 0 && 1 / tickRate > RENDER_DT;
    // 两种边沿的处理不同：停用→激活要连 tickPhys 一起重锚（清掉停用期残留的鼠标累积，
    // 并把 tickPhys 拉到 phys 当前位置，否则第一个边界就从错位起点推进）；
    // 激活→停用只清累积器、不动实例（tickPhys 已不参与，其状态留给下次对齐覆盖）
    if (modeBActive && !modeBWasActive) {
      loAcc = 0;
      tickDxAcc = 0;
      tickDyAcc = 0;
      alignTickPhys();
    } else if (!modeBActive && modeBWasActive) {
      loAcc = 0;
      tickDxAcc = 0;
      tickDyAcc = 0;
    }
    modeBWasActive = modeBActive;

    // ── 第一步：tick 边界计算（必须早于第二步，理由见 loop 文档）──
    const tickPhys = env.getTickPhys();
    if (modeBActive && tickPhys) {
      const tickDt = 1 / tickRate;
      loAcc += delta;
      while (loAcc >= tickDt) {
        loAcc -= tickDt;
        // 边界输入快照：键位取当前掩码（非消耗读，反映边界时刻的按住状态）；
        // 鼠标取自上一边界以来第二步累积的增量，经 tickInputMax 对称限幅后一次性注入
        const tickKeys = shared.peekKeys();
        const tickMax = tickInputMax(tickDt);
        const tickDx = clampAbs(tickDxAcc, tickMax);
        const tickDy = clampAbs(tickDyAcc, tickMax);
        tickDxAcc = 0;
        tickDyAcc = 0;
        // 分叉兜底：位置偏差超过阈值时整体拉回，使 tickPhys 不带着发散轨迹继续影响校准
        // 速度。检查必须在推进之前——推进后再拉回等于丢掉本边界的推进结果，且会把分叉
        // 位置上的错误速度写回 phys
        if (tickDiverged()) {
          alignTickPhys();
        }
        // 推进独立实例：dt 恒为 tickDt，故摩擦/加速/碰撞等全部落在 tickDt 网格上，
        // 步进后的状态时刻就是本次边界时刻
        tickPhys.tick(tickDt, tickKeys, tickDx, tickDy);
        // 速度校准：把刚步进完的三轴速度（含 vy）经 set_velocity 写回 phys——这是 tickPhys
        // 影响 phys 的唯一通道，位置与角度不动
        const st = tickPhys.state() as { velX: number; velY: number; velZ: number };
        phys.set_velocity(st.velX, st.velY, st.velZ);
      }
    } else {
      loAcc = 0; // 不激活（或实例缺失）：丢弃 tickDt 累加，只跑 1ms 无限制线
    }

    // ── 第二步：1ms 无限制子步（必须晚于第一步；位置/角度在这里由 tick_into 推进）──
    acc += delta;
    if (acc >= RENDER_DT) {
      const nowMs = performance.now();
      let steps = 0;
      while (acc >= RENDER_DT && steps < MAX_STEPS_PER_ROUND) {
        acc -= RENDER_DT;
        steps++;
        // 实时输入：consumeInput 以 CAS 清零且不截断，一次取走自上一步以来的全部增量
        // （AuthLoop 走的是 takeInput(maxStep) 的饱和截断口径，两条线各用各的）
        const inp = shared.consumeInput();
        // 为下一个 tick 边界累积本帧增量（只在 tickPhys 激活时累积，边界处一次性注入）
        if (modeBActive) {
          tickDxAcc += inp.dx;
          tickDyAcc += inp.dy;
        }
        // 零分配热路径：tick_into 写 wasm state_out，本环用 8 槽视图直读后写解耦帧槽
        phys.tick_into(RENDER_DT, inp.keysMask, inp.dx, inp.dy);
        if (!publishFromStateOut(nowMs)) {
          // 退化路径：无 wasm 内存宿主，改用 phys.state() 的对象读数发帧
          publishFromState(nowMs);
        }
      }
      // 子步数用满时保留剩余 acc（不丢时间，下一轮继续补跑），仅封顶防无限追赶
      if (acc > MAX_ACC) acc = MAX_ACC;
    }

    // 背压：按 acc 余量算出距下一次 1ms 子步的剩余时间，达到阈值才挂起（上限 MAX_WAIT_MS）；
    // 剩余不足则直接自旋进入下一轮。SAB 通道用带超时的 Atomics.wait 挂起，MsgState 回退的
    // waitWakeup 立即返回 false（不挂起，循环仍由 setTimeout 自驱）
    const idleMs = (RENDER_DT - acc) * 1000;
    if (idleMs >= WAIT_THRESHOLD_MS) {
      shared.waitWakeup(Math.min(idleMs, MAX_WAIT_MS));
    }
  }

  return {
    onTickRateChanged(): void {
      loAcc = 0;
      tickDxAcc = 0;
      tickDyAcc = 0;
      alignTickPhys();
    },
    resetSamplers(align?: boolean): void {
      acc = 0;
      loAcc = 0;
      tickDxAcc = 0;
      tickDyAcc = 0;
      modeBWasActive = false; // 置为未激活：下一轮把仍在激活的 tickPhys 当新边沿重锚
      lastNow = performance.now(); // 刷新墙钟基准：此后的第一帧 delta 从这里起算
      if (align) alignTickPhys();
    },
    publishCurrentState(): void {
      refreshSlowFields(performance.now(), true);
      publishFromState(performance.now());
    },
    start(): void {
      if (started) return;
      started = true;
      lastNow = performance.now();
      loop();
    },
  };
}

/** 权威帧类型再导出。`AuthFrame` 的权威定义在 `src/ts-shared/auth/shared-state.ts`，是
 * `writeDecoupled(frame)` 的入参类型（`ShmState` 与 `MsgState` 两个实现都收它，即该文件
 * 导出的 `SharedState = ShmState | MsgState` 联合的公共帧形状）。本仓当前没有从本文件
 * 导入该类型的消费方。 */
export type { AuthFrame };
