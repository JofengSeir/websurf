/**
 * 共享层权威线引擎：以固定步长在 Worker 内独立推进唯一权威 PhysWorld，并把每个步长的
 * 权威帧写进跨线程状态通道。
 *
 * 定位：`src/ts-shared/auth/` 三条线里的权威生产端。与它并行的是主线程渲染线自持的
 * 预测物理实例（`apps/game/src/renderer/renderer-main.ts` 的 `predPhys`），两侧只经
 * `src/ts-shared/auth/shared-state.ts` 的输入槽 / 权威帧槽 / 渲染采样槽交换数据。模式门、
 * 帧协议、tick 模式控制器分别由同目录其它模块负责，本文件只把三者串成一条自驱循环。
 *
 * 上下游（各一个调用点）：
 * - 上游装配：`apps/game/src/worker/main.ts` 的 `createAuthLoop`（另一处同构调用点是
 *   `apps/debug/src/worker/main.ts` 的 `createAuthLoop`）——注入状态通道、权威实例取值器、
 *   消息出口与渲染轨迹采样源。
 * - 下游消费：`src/ts-shared/auth/worker-dispatch.ts` 的 `createWorkerDispatch` —— 持有
 *   `AuthLoop`，wasm 初始化成功后调 `start`，world-json 重建与物理配置 tickRate 变更时调
 *   `setFixedDt` / `reset`。帧的读端是主线程 `readAuthoritative`
 *   （`src/ts-shared/auth/shared-state.ts`），事件的读端是
 *   `src/ts-shared/phys/authority-calibrator.ts` 的 `applyCollisionCorrection`（经
 *   `apps/game/src/app.ts` 与 `apps/debug/src/app.ts` 的 `phys-event` 分支转发）。
 *
 * 关键不变量：
 * - 每个步长的顺序固定：先 `takeInput` 消费一次输入，再推进物理，最后 `writeAuthoritative`
 *   写帧；单次唤醒可连推多步，但每个循环体只消费一份输入。
 * - 欠账由 (now − simMs) 直接重算，不做增量累加，故「要补多少」不依赖上一次唤醒是否发生、
 *   期间是否被 `reset`；`simMs` 只在真实步长处按 `fixedDt` 前进。
 * - 模式门关断时 `lastWall` / `acc` / `simMs` 一并归零，开门后的首次唤醒从当前时刻重新播种，
 *   关断窗口内的墙钟时间不补跑。
 * - 单次唤醒最多排空 64 个步长，且欠账被 `MAX_CATCHUP_MS` 截顶，落后量因此有界。
 *
 * 边界与容错：
 * - `env.shared` 为 null 或 `env.getPhys()` 返回 null 时：`publishCurrentState` /
 *   `stepPhysics` / `holdStep` 直接返回，`loop` 只续期定时器，都不推进物理、不写帧。
 * - 权威实例未 `build_world` 时 `tick` 返回当前状态且不推进（`src/phys/mod.rs` 的 `tick`），
 *   本文件不额外判就绪。
 * - `post` 缺省走 `self.postMessage`；环境里没有 `self`（node 内测试）时该缺省实现静默丢弃。
 *
 * 测试归属：
 * - `apps/debug/scripts/auth-clock-verify.mjs`：`apps/debug/package.json` 的 `test:auth-clock`
 *   脚本先用 esbuild 打包本文件，再由该脚本驱动真实循环统计权威步数。
 * - `src/ts-shared/auth/tick-authority.test.ts`：`createAuthLoop` 与 `tickF4` / `holdState`
 *   钩子的集成。
 * - `src/ts-shared/auth/compute-mode.test.ts`：`resolveAuthGateOpen` 的门语义。
 *
 * 与相邻文件的边界：
 * - `src/ts-shared/auth/shared-state.ts`：槽位布局与 `ShmState` / `MsgState` 两个实现；本文件
 *   只按接口调用 `takeInput` / `writeAuthoritative` / `writePublishedTau`，不直接读写槽位常量。
 * - `src/ts-shared/auth/compute-mode.ts`：`ComputeMode` 三值与 `isAuthLineMode`；本文件的模式门
 *   只消费谓词，不定义模式。
 * - `src/ts-shared/auth/tick-authority.ts`：`TickF4Controller`；本文件只在唤醒与步长处回调它，
 *   不实现控制器。
 * - `src/ts-shared/decoupled/decoupled-loop.ts`：解耦线，与本线由模式门互斥；本文件不导入它
 *   （该文件反向导入本文件的 `PhysWorldLike`）。
 */

import type { ShmState, MsgState, AuthPublishMeta } from './shared-state.js';
import { isAuthLineMode, type ComputeMode } from './compute-mode.js';
import type { TickF4Controller } from './tick-authority.js';

/** hold 冻结期的姿态快照：`AuthLoopEnv.holdState` 返回它，`holdStep` 用它把权威实例定格在
 * 冻结前姿态。
 *
 * 六个字段与 `PhysWorldLike.set_state` 的前五个入参加 `onGround` 一一对应。
 * `src/ts-shared/decoupled/decoupled-loop.ts` 的 `HoldState` 是同名同型的六个字段，可结构化
 * 赋给本接口；本文件不导入该类型，以免出现 auth → decoupled 的模块依赖反向。 */
export interface HoldSnapshot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  onGround: boolean;
}

/** 权威线使用的 PhysWorld 最小结构接口；wasm-bindgen 产物实例凭结构满足即可注入。
 *
 * 成员集同时是分发层的实例槽类型——`src/ts-shared/auth/worker-dispatch.ts` 用 `PhysWorldLike`
 * 声明它的 `phys` / `tickPhys` / `scratch` 三个槽并在那里调用 `build_world` / `set_params` /
 * `set_hull` / `set_noclip` / `set_state` / `respawn` / `teleport_to_spawn` / `teleport_to` /
 * `set_spawn_points` / `set_death_y`。本文件自身只调用 `state`、`tick` 与 `set_state`。
 *
 * 失败面：`state` 与 `tick` 都返回 `unknown`，本文件按调用点的窄化断言读取字段；取出未 `build_world`
 * 的实例时 `tick` 返回当前状态而不推进。 */
export interface PhysWorldLike {
  state(): unknown;
  tick(dt: number, keysMask: number, dx: number, dy: number): unknown;
  build_world(
    brushJson: string,
    triJson: string,
    teleportJson: string,
    x: number,
    y: number,
    z: number,
    yawDeg: number,
  ): void;
  set_params(json: string): void;
  set_hull(halfWidth: number, standHeight: number, duckHeight: number): void;
  set_noclip(active: boolean): void;
  set_state(
    posX: number,
    posY: number,
    posZ: number,
    yaw: number,
    pitch: number,
    velX: number,
    velY: number,
    velZ: number,
    onGround: boolean,
  ): void;
  respawn(): void;
  teleport_to_spawn(idx: number): void;
  teleport_to(x: number, y: number, z: number, yaw: number): void;
  set_spawn_points(json: string): void;
  set_death_y(y: number): void;
  /** 释放 wasm 实例（wasm-bindgen 的 free）。本文件从不调用它；world 重建时由
   * `src/ts-shared/auth/worker-dispatch.ts` 的 `createWorkerDispatch` 释放旧实例。声明为可选，
   * 使没有 free 的注入实现（node 内测试桩）也能满足接口。 */
  free?(): void;
}

/** 权威碰撞事件：由 `stepPhysics` 在耦合 / 回落支路发出，是本文件唯一的非帧消息。
 *
 * 载荷全部取自事件时刻的权威 `phys.state()` 读数（位置/朝向/速度）加 `performance.now()`；
 * 事件只在事件时刻发出一次，不重发、不合并。 */
export interface AuthCollisionEvent {
  type: 'phys-event';
  kind: 'land' | 'blocked';
  pos: number[];
  /** 事件时刻权威 `state()` 的 `yaw` / `pitch`（度）。两个字段随协议携带，但消费端不使用：
   * `src/ts-shared/phys/authority-calibrator.ts` 的 `applyCollisionCorrection` 以 `_yawDeg` /
   * `_pitchDeg` 形参接收且不读取，渲染角度不会被权威朝向改写。 */
  yawDeg: number;
  pitchDeg: number;
  /** 事件时刻权威 `state()` 的 `velX` / `velY` / `velZ`（HU/s）。`kind === 'land'` 时消费端据它
   * 改写渲染速度（且仅在渲染自身已着地时）；`kind === 'blocked'` 时消费端在 kind 判定处即返回，
   * 整个载荷都不被读取。 */
  vel: number[];
  timeMs: number;
}

export interface AuthLoopEnv {
  /** 跨线程状态通道（SAB 环境是 `ShmState`，无 SAB 的 `postMessage` 回退环境是 `MsgState`，
   * 两者接口一致）。装配点用取值器转发，故本文件每次读取都拿到 init 消息之后的最新值；
   * init 之前为 null，此时各入口按「通道不可用」早退。 */
  shared: ShmState | MsgState | null;
  /** 权威实例取值器。取值时机完全由本文件决定（`loop` 的守卫、`stepPhysics` / `holdStep` 顶置、
   * `publishCurrentState`），故装配点可借它挂探测钩子——`apps/game/src/worker/main.ts` 的
   * `createAuthLoop` 调用点就把它写成了带副作用的表达式。返回 null = 实例未就绪。 */
  getPhys(): PhysWorldLike | null;
  /** 消息出口：缺省 `self.postMessage`，环境无 `self` 时静默丢弃；node 内测试可注入收集器。
   * 只有碰撞事件走这里（`onCollisionEvent` 缺席时）。 */
  post?(msg: unknown): void;
  /** 碰撞事件回调。提供时事件只走回调，`post` 不再收到它（二选一，不重复发）。 */
  onCollisionEvent?(ev: AuthCollisionEvent): void;
  /** 显式模式门：存在时 `resolveAuthGateOpen` 直接返回它的返回值，此时 `getComputeMode`
   * 被忽略。返回 false = 本线早退（该窗口内的物理推进由另一端负责）。 */
  modeGate?: () => boolean;
  /** 计算模式直读钩子：提供时缺省门取 `isAuthLineMode(该值)`，即 `decoupled` 早退、其余推进。
   * 与 `modeGate` 一样每次唤醒实时取值，故门可以随配置翻转。当前装配点都不注入本钩子
   * （唯一注入处是测试），此时门恒真。 */
  getComputeMode?: () => ComputeMode;
  /** hold 冻结快照源。返回非 null 时 `stepPhysics` 本步长改走 `holdStep`（定格 + 写帧，不推进
   * 物理）。缺省 undefined 等价恒 null；当前装配点都不注入（唯一注入处是测试）。 */
  holdState?: () => HoldSnapshot | null;
  /** tick 模式控制器钩子。提供时：`loop` 每次唤醒在累积器排空前回调一次 `onWake`；`stepPhysics`
   * 在 `isActive()` 为 true 时走零分配支路（`authorityTickInto` + `authorityPose`）并停发碰撞
   * 事件。控制器各方法自行判模式，非 tick 模式等价于缺省。缺省 undefined = 不进入该支路。 */
  tickF4?: TickF4Controller;
  /** 渲染轨迹采样源（可选）。提供时，耦合支路的**发布位置**改取「渲染折线上 τ 处的采样点」，
   * `phys.state()` 自身位置退为回退值；`phys.state()` 的其余九值（朝向/速度/眼高/着地/时间）
   * 不受影响。
   *
   * 调用面只有 `stepPhysics` 的发布段：`tickInstantToTau(simMs)` → `sampleAtTau(tau)`；本文件
   * 不因该钩子产生额外的物理写、等待或位置回注。缺省 undefined = 发布位置恒为权威自身位置。
   */
  renderTrajectory?: RenderTrajectorySource;
}

/**
 * 渲染轨迹采样源（由装配侧实现，本文件只读它的返回值）。
 *
 * 语义：`tickInstantToTau` 把权威时钟的瞬时值换算到渲染时钟域 τ；`sampleAtTau` 在渲染折线上
 * 按 τ 取点。两者把「不可用」显式编码为 -1 / null，本文件据此回退到权威自身位置，本步长不做
 * 投影。
 */
export interface RenderTrajectorySource {
  /** 权威时钟瞬时值（worker `performance.now()` 域，ms；本文件传入的是 `simMs`）→ 渲染时钟
   * τ（ms）。不可用返回 -1，此时本文件不再调用 `sampleAtTau`。 */
  tickInstantToTau(workerInstMs: number): number;
  /** 取 τ 处的渲染折线采样点。不可用返回 null。 */
  sampleAtTau(tauMs: number): { x: number; y: number; z: number } | null;
}

export interface AuthLoop {
  /** 设置固定步长，入参为 Hz；内部生效值 = `1 / Math.max(rate, 1)` 秒（下界 1 Hz）。
   *
   * 返回值 = 步长是否真的变化：false 表示 `fixedDt` 未变，本调用不触碰任何内部量，调用方据此
   * 跳过 `reset`；true 表示已切换，且切换时把累积器余数折算进绝对时钟（换步长不丢已欠时间）。
   * 调用点：`src/ts-shared/auth/worker-dispatch.ts` 的 `createWorkerDispatch`（world-json 重建分支
   * 与 config tickRate 分支）与 `apps/debug/src/worker/main.ts` 的 `onTickRateChange`。 */
  setFixedDt(rate: number): boolean;
  /** 把 `acc` / `lastWall` / `simMs` 一并归零；下一次唤醒按「首次唤醒」重新播种基准。不触碰
   * 物理实例、不写帧，无返回值。调用点同 `setFixedDt`。 */
  reset(): void;
  /** 幂等启动自驱循环（首次调用后置位，重复调用不产生第二条定时器链）：立刻执行一次 `loop`，
   * 其后由 `loop` 内的 `setTimeout` 自驱。调用点：`src/ts-shared/auth/worker-dispatch.ts` 的
   * wasm 初始化分支。 */
  start(): void;
  /** 立刻按当前权威状态写一帧：读一次 `phys.state()` 原样发布，不推进物理、不动累积器、不判
   * 模式门；`shared` 或 `phys` 缺失时直接返回。`meta` 原样透传给 `writeAuthoritative`（缺省即
   * 该参数自身的缺省语义，协议槽零触碰）。本工作区内没有调用点；配套的 meta 来源之一是
   * `src/ts-shared/auth/tick-authority.ts` 的 `TickF4Controller.firstFrameMeta`。 */
  publishCurrentState(meta?: AuthPublishMeta): void;
}

/** 单步输入增量的基准上限（度 / (1/64) 秒）。
 *
 * 真正传给 `takeInput` 的上限是 `MAX_INPUT_PER_STEP_BASE * dt * 64`：默认步长 1/64 秒时恰为
 * 1200 度，步长变小则按比例收紧。`takeInput` 侧对 dx / dy 各自做饱和截断。hold 支路与耦合
 * 支路用的都是这一个式子。 */
const MAX_INPUT_PER_STEP_BASE = 1200;

/**
 * 模式门判定。纯函数——自身不持状态，但会调用注入的钩子，故返回值取决于钩子实现：
 * - `env.modeGate` 存在 → 返回它的返回值（显式门优先，`getComputeMode` 被忽略）；
 * - 否则 `env.getComputeMode` 存在 → 返回 `isAuthLineMode(该值)`，即 `coupled` / `tick` 为真、
 *   `decoupled` 为假；
 * - 两者都缺省 → 恒真。
 *
 * 钩子每次调用实时取值，故门可以在运行期翻转。调用点：本文件的 `loop`（每次唤醒判一次，门关时
 * 归零三个时钟量并早退）；`src/ts-shared/auth/compute-mode.test.ts` 覆盖三分支。
 */
export function resolveAuthGateOpen(
  env: Pick<AuthLoopEnv, 'modeGate' | 'getComputeMode'>,
): boolean {
  if (env.modeGate) return env.modeGate();
  if (env.getComputeMode) return isAuthLineMode(env.getComputeMode());
  return true;
}

/**
 * 创建权威线循环实例（不启动：`start` 才挂上定时器）。
 *
 * 返回对象的四个方法各自见 `AuthLoop` 的文档；闭包内持有的状态是固定步长、累积器与仿真时钟，
 * 三个 `prev*` 判据基准以及 `started` 幂等标志。装配点必须提供可用的 `shared` 取值器与
 * `getPhys` 取值器，否则循环只空转不写帧。
 *
 * 环境钩子全部可选：`modeGate` / `getComputeMode` 决定本线是否推进，`holdState` 决定是否定格，
 * `tickF4` 决定是否走零分配支路，`renderTrajectory` 决定发布位置是否取渲染折线采样点。
 */
export function createAuthLoop(env: AuthLoopEnv): AuthLoop {
  /** 权威固定步长（秒）。初值 1/64 秒；由 `setFixedDt` 改写。 */
  let fixedDt = 1 / 64;
  /** 未排空的欠账（秒）。每次唤醒由 (now − simMs) 直接重算并被 `MAX_CATCHUP_MS` 截顶；
   * 排空循环每步减 `fixedDt`，换步长时折算进 `simMs` 后归零。 */
  let acc = 0;
  let lastWall = 0;
  /**
   * 权威仿真时钟：已模拟到的墙钟刻度（worker `performance.now()` 域，ms）。
   *
   * 播种时机只有两处——首次唤醒（`lastWall === 0`）与模式门关断后的首次唤醒，都取播种那一刻的
   * `now`；其后每个真实步长前进 `fixedDt * 1000`。欠账超过 `MAX_CATCHUP_MS` 时被回拨到
   * `now − MAX_CATCHUP_MS`，即主动丢弃超限欠账，而不是让时钟无界落后。
   *
   * 它同时是本文件两个量的共同来源：欠账的减数（`acc = (now − simMs) / 1000`）与渲染轨迹钩子的
   * 入参（`tickInstantToTau(simMs)`）。
   */
  let simMs = 0;
  /**
   * 单次唤醒允许保留的最大欠账（ms）。超过它就把 `simMs` 回拨到 `now − MAX_CATCHUP_MS` 并把
   * `acc` 置为 250ms，超限部分直接丢弃——唤醒被节流时落后量因此有界。
   *
   * 可核对的关系：排空循环上限 64 步，故保留的欠账能在一次唤醒内排空的条件是
   * `64 * fixedDt * 1000 >= MAX_CATCHUP_MS`，即 `fixedDt >= 3.90625` 毫秒（步长频率不高于
   * 256Hz）。默认的 1/64 秒（15.625 毫秒）满足该条件。
   */
  const MAX_CATCHUP_MS = 250;
  /** `start` 的幂等标志：置位后重复调用不再启动第二条定时器链。 */
  let started = false;

  // 碰撞事件判据的三个基准，每个真实步长在 phys.tick 之前刷新：
  // - prevOnGround：onGround 的上一值（land 判上升沿）；
  // - prevSpeed：上一速度模长（blocked 判速度骤降）；
  // - prevOrigin：上一位置（blocked 判实际位移）。
  // hold 支路与 tick 模式零分配支路都在刷新点之前返回，故这两条支路期间三个基准保持不动。
  let prevOnGround = false;
  let prevSpeed = 0;
  let prevOrigin: [number, number, number] | null = null;

  /** 消息出口。缺省实现只认 `self.postMessage`；无 `self` 时静默丢弃。 */
  const post: (msg: unknown) => void =
    env.post ??
    ((msg: unknown): void => {
      if (typeof self !== 'undefined') {
        (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
      }
    });

  /** 事件出口：`onCollisionEvent` 存在时只走回调，否则走 `post`。 */
  const emitCollision = (ev: AuthCollisionEvent): void => {
    if (env.onCollisionEvent) env.onCollisionEvent(ev);
    else post(ev);
  };

  /** hold 冻结期的单步：用 `held` 定格权威实例并写一帧，跳过 `phys.tick`。
   *
   * - 输入仍被消费：`takeInput` 的 dx / dy 被清空后丢弃（键位掩码是实时读取，不受影响），故冻结
   *   不会把鼠标增量攒到解冻之后；
   * - `set_state(held…, vel = 0)` 只覆盖位置/朝向/速度/着地，蹲伏态字段保持实例当前值，故下面的
   *   `eyeHeight` 读到的是冻结前的姿态；
   * - 本步长的时钟已在 `loop` 里照常扣减与前进，本函数不补物理时间；
   * - 帧的 meta 仍经 `tickF4.publishMeta()` 取得，故标号与事件位在冻结期照常推进；
   * - `shared` 或 `phys` 缺失时直接返回：本步长既不推进也不写帧。 */
  function holdStep(dt: number, held: HoldSnapshot): void {
    const shared = env.shared;
    const phys = env.getPhys();
    if (!shared || !phys) return;
    const maxStep = (MAX_INPUT_PER_STEP_BASE * dt) / (1 / 64);
    shared.takeInput(maxStep);
    phys.set_state(held.x, held.y, held.z, held.yaw, held.pitch, 0, 0, 0, held.onGround);
    // eyeHeight 取实例当前姿态：set_state 不覆盖蹲伏态字段，故这里读到的是冻结前的蹲伏姿态
    const s = phys.state() as { eyeHeight: number };
    env.tickF4?.noteHoldTick();
    // 冻结期帧流继续：meta 照常发布（标号推进、事件位随排空），权威实例只是被定格
    shared.writeAuthoritative(
      {
        pos: { x: held.x, y: held.y, z: held.z },
        yaw: held.yaw,
        pitch: held.pitch,
        vel: { x: 0, y: 0, z: 0 },
        eyeHeight: s.eyeHeight,
        timeMs: performance.now(),
      },
      held.onGround,
      env.tickF4?.publishMeta(),
    );
  }

  /** 单个权威步长。三条支路依次判定：hold 冻结 → tick 模式零分配支路 → 耦合 / 回落支路；
   * 写帧之后再判碰撞事件。
   *
   * 三条支路都不自行判模式门（门在 `loop` 层判定），都要求 `shared` 与 `phys` 同时可用，否则本
   * 步长直接返回。前两条支路在刷新碰撞判据基准之前返回，故那期间不产生 `phys-event`。 */
  function stepPhysics(dt: number): void {
    const shared = env.shared;
    const phys = env.getPhys();
    if (!shared || !phys) return;
    // ── hold 冻结顶置：holdState 提供且返回非 null 时，本步长只定格 + 写帧（holdStep），
    // 既不推进物理，也不进入下面的 tick 模式支路；缺省 undefined 时该支路不进入 ──────
    const held = env.holdState?.() ?? null;
    if (held) {
      holdStep(dt, held);
      return;
    }
    const maxStep = (MAX_INPUT_PER_STEP_BASE * dt) / (1 / 64);
    // ── tick 模式零分配支路：输入消费一次后交给控制器（onInput → authorityTickInto），发布
    // 姿态从控制器的预分配对象 authorityPose 读出；本文件不调用 phys.tick、不新建状态对象。
    // isActive() 为 false（控制器缺省或未就绪）时跳过本支路，走下面的耦合 / 回落路径 ──────
    const f4 = env.tickF4;
    if (f4 !== undefined && f4.isActive()) {
      const input = shared.takeInput(maxStep);
      f4.onInput(input.keysMask);
      f4.authorityTickInto(dt, input.keysMask, input.dx, input.dy);
      const p = f4.authorityPose;
      const meta = f4.publishMeta();
      shared.writeAuthoritative(
        {
          pos: { x: p.x, y: p.y, z: p.z },
          yaw: p.yaw,
          pitch: p.pitch,
          vel: { x: p.velX, y: p.velY, z: p.velZ },
          eyeHeight: p.eyeHeight,
          timeMs: performance.now(),
        },
        p.onGround,
        meta,
      );
      f4.onRealTick(performance.now(), p);
      // 本支路不发碰撞事件（onRealTick 之后直接返回）：tick 模式的事件面是帧携带的协议 meta，
      // 不再产生 phys-event 消息
      return;
    }
    const input = shared.takeInput(maxStep);
    // 刷新碰撞判据基准（tick 前快照）
    const before = phys.state() as {
      posX: number;
      posY: number;
      posZ: number;
      velX: number;
      velY: number;
      velZ: number;
      onGround: boolean;
    };
    prevOnGround = before.onGround;
    prevSpeed = Math.hypot(before.velX, before.velY, before.velZ);
    prevOrigin = [before.posX, before.posY, before.posZ];

    phys.tick(dt, input.keysMask, input.dx, input.dy);
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
    // 发布 meta：控制器缺省（或非 tick 模式）时 publishMeta 返回 undefined，writeAuthoritative
    // 的 meta 参数即回到缺省语义（协议槽零触碰）；tick 模式的回落路径仍能带上控制器当前 meta
    const meta = env.tickF4?.publishMeta();
    // ── 渲染轨迹采样投影（renderTrajectory 提供时）────────────────────────
    // 发布位置 = 渲染折线上 τ 处的采样点，而非 phys.state() 自身位置；s 的其余九值不受影响。
    // 三个条件同时成立才投影：① 钩子存在；② 走的是本支路（tick 模式零分配支路与 hold 支路
    // 都已在前面的 return 处结束）；③ `(env.getComputeMode?.() ?? 'coupled') === 'coupled'`
    // ——未注入 getComputeMode 时条件③恒真。tick 模式的回落路径与本支路共用代码，条件③是它
    // 不投影的唯一依据。
    // 钩子缺省时 `rt !== undefined` 恒 false ⇒ pub 恒 null ⇒ 发布位置表达式退化为
    // `phys.state()` 位置，tickInstantToTau / sampleAtTau 一次都不被调用。
    const rt = env.renderTrajectory;
    let pub: { x: number; y: number; z: number } | null = null;
    let tau = 0;
    if (rt !== undefined && (env.getComputeMode?.() ?? 'coupled') === 'coupled') {
      tau = rt.tickInstantToTau(simMs);
      if (tau >= 0) pub = rt.sampleAtTau(tau);
    }
    // τ 回写（微秒）：真的用了投影才写非零 τ，未投影写 0——该槽位语义即「0 = 未发布」，主线程
    // 据此区分投影帧与未投影帧
    shared.writePublishedTau?.(pub ? Math.round(tau * 1000) : 0);
    shared.writeAuthoritative(
      {
        pos: pub ? { x: pub.x, y: pub.y, z: pub.z } : { x: s.posX, y: s.posY, z: s.posZ },
        yaw: s.yaw,
        pitch: s.pitch,
        vel: { x: s.velX, y: s.velY, z: s.velZ },
        eyeHeight: s.eyeHeight,
        timeMs: performance.now(),
      },
      s.onGround,
      meta,
    );

    // 碰撞事件（低频，两个判据二选一，land 命中即返回、同一步长不再评估 blocked）：
    // - land：onGround 上升沿（`!prevOnGround && s.onGround`），字段取本步长 tick 后的
    //   phys.state() 十值读数。权威与渲染的相位/位置不同源，消费端
    //   `src/ts-shared/phys/authority-calibrator.ts` 的 `applyCollisionCorrection` 只据
    //   kind=land 采纳这里的权威速度（且仅在渲染自身已着地时），不改渲染位置与角度。
    // - blocked：`curSpeed > 80` ∧ `prevSpeed − curSpeed > 250` ∧
    //   `moved < expectedMove * 0.3` 三条同时成立才发；`expectedMove = prevSpeed * dt`，
    //   `moved` 为本步长实际位移模长，两者都在此处现算。
    if (!prevOnGround && s.onGround) {
      emitCollision({
        type: 'phys-event',
        kind: 'land',
        pos: [s.posX, s.posY, s.posZ],
        yawDeg: s.yaw,
        pitchDeg: s.pitch,
        vel: [s.velX, s.velY, s.velZ],
        timeMs: performance.now(),
      });
      return;
    }
    const curSpeed = Math.hypot(s.velX, s.velY, s.velZ);
    const moved = prevOrigin
      ? Math.hypot(s.posX - prevOrigin[0], s.posY - prevOrigin[1], s.posZ - prevOrigin[2])
      : 0;
    const expectedMove = prevSpeed * dt;
    if (curSpeed > 80 && prevSpeed - curSpeed > 250 && moved < expectedMove * 0.3) {
      emitCollision({
        type: 'phys-event',
        kind: 'blocked',
        pos: [s.posX, s.posY, s.posZ],
        yawDeg: s.yaw,
        pitchDeg: s.pitch,
        vel: [s.velX, s.velY, s.velZ],
        timeMs: performance.now(),
      });
    }
  }

  /** 自驱主循环：每 4ms 唤醒一次（`setTimeout(loop, 4)`），用绝对欠账排空固定步长。
   *
   * 唤醒序列：先续期定时器，再判模式门（关断即归零三个时钟量并返回），随后要求 `shared` 与
   * `phys` 同时可用，接着播种或重算欠账、截顶、回调 `tickF4.onWake`，最后按 `fixedDt` 排空。 */
  function loop(): void {
    setTimeout(loop, 4);
    // 模式门关断：lastWall / acc / simMs 一并归零后返回——开门后的首次唤醒按「首次唤醒」重新
    // 播种（lastWall = now、simMs = now），关断窗口内的墙钟时间不补跑
    if (!resolveAuthGateOpen(env)) {
      lastWall = 0;
      acc = 0;
      simMs = 0;
      return;
    }
    if (!env.shared || !env.getPhys()) return;
    const now = performance.now();
    if (lastWall === 0) {
      lastWall = now;
      simMs = now;
      return;
    }
    // 绝对欠账：由 (now, simMs) 直接重算，而不是在旧值上累加增量——单次唤醒要补多少只取决于
    // 这两个绝对时刻，与上一次唤醒是否发生、期间是否 reset 无关。
    acc = (now - simMs) / 1000;
    lastWall = now;
    // 欠账截顶：超出 MAX_CATCHUP_MS 的部分主动丢弃（把 simMs 回拨到 now − MAX_CATCHUP_MS），
    // 唤醒被节流时欠账不会无界增长。
    if (acc * 1000 > MAX_CATCHUP_MS) {
      simMs = now - MAX_CATCHUP_MS;
      acc = MAX_CATCHUP_MS / 1000;
    }
    // ── tick 模式乐观窗评估：本文件每唤醒在排空前回调一次，第二参 = 本唤醒将触发的下一真实
    // 步长到期时刻，由同一累积器相位推出 `now + max(0, (fixedDt − acc) * 1000)`（上一行刚把
    // lastWall 赋为 now，故此处 lastWall 与 now 同值）；acc ≥ fixedDt 时括号内为 0，由控制器
    // 自身的开火下限处理 ──────────────────────────────────────────────
    if (env.tickF4) {
      env.tickF4.onWake(now, now + Math.max(0, (fixedDt - acc) * 1000));
    }
    // 排空欠账：每步扣 fixedDt、把仿真时钟推进 fixedDt * 1000 毫秒，并执行一个权威步长；
    // 单次唤醒最多 64 步（guard 上限），未排完的欠账留到下一次唤醒
    let guard = 0;
    while (acc >= fixedDt && guard < 64) {
      acc -= fixedDt;
      simMs += fixedDt * 1000;
      stepPhysics(fixedDt);
      guard++;
    }
  }

  return {
    setFixedDt(rate: number): boolean {
      const next = 1 / Math.max(rate, 1);
      // 步长未变：返回 false 且不触碰任何内部量。physics 配置消息每条都带 tickRate，调用方据此
      // 跳过 reset，累积器余数与本次唤醒区间不会因此被清掉。
      if (next === fixedDt) return false;
      // 换步长：把当前余数折算进绝对时钟基准再清零累积器——已欠的时间不丢。
      simMs += acc * 1000;
      acc = 0;
      fixedDt = next;
      return true;
    },
    reset(): void {
      acc = 0;
      lastWall = 0;
      simMs = 0;
    },
    start(): void {
      if (started) return;
      started = true;
      loop();
    },
    publishCurrentState(meta?: AuthPublishMeta): void {
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
      shared.writeAuthoritative(
        {
          pos: { x: s.posX, y: s.posY, z: s.posZ },
          yaw: s.yaw,
          pitch: s.pitch,
          vel: { x: s.velX, y: s.velY, z: s.velZ },
          eyeHeight: s.eyeHeight,
          timeMs: performance.now(),
        },
        s.onGround,
        meta,
      );
    },
  };
}
