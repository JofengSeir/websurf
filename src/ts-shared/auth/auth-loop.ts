/**
 * 权威帧计算循环（公共化 v1）— setTimeout 4ms 自驱 + 固定步长累积器 + 碰撞事件。
 *
 * Worker = 权威帧计算器：持权威 PhysWorld（world-json 一次性构建），
 * 墙钟驱动固定步长（默认 64Hz；config.physics.tickRate 动态覆盖）独立模拟
 * 权威物理线（含碰撞/摩擦/重力），每 tick：
 * - takeInput 消费主线程写 SAB 输入槽（或 MsgState 回退缓冲）的鼠标/按键
 * - phys.tick 完整推进（含碰撞/传送/死亡）
 * - writeAuthoritative 写权威帧到 SAB 双缓冲（或 phys-frame 消息回退）
 * - 权威碰撞事件（land/blocked）postMessage 回传主线程做位置微调 + 角度同步
 *
 * 抽象：wasm 模块（PhysWorld）由调用方注入（结构性接口 PhysWorldLike），
 * 碰撞事件可经 onCollisionEvent 回调接管（默认 postMessage）。
 */

import type { ShmState, MsgState, AuthPublishMeta } from './shared-state.js';
import { isAuthLineMode, type ComputeMode } from './compute-mode.js';
import type { TickF4Controller } from './tick-authority.js';

/** C 键 hold 冻结快照（t3-memo §4.6；decoupled-loop HoldState 结构性满足——
 * 就地定义避免 auth→decoupled 模块依赖，双线解耦）。 */
export interface HoldSnapshot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  onGround: boolean;
}

/** 权威 PhysWorld 最小接口（两端 pkg/websurf_wasm.js 的 PhysWorld 结构性满足）。 */
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
  /** 释放 wasm 实例（wasm-bindgen free；双模式 world-json 重建时防泄漏——
   * phys-mode-port P5。可选：缺省无 free 的注入实现跳过）。 */
  free?(): void;
}

/** 权威碰撞事件（低频，postMessage 回传主线程；两端 MainMessage 同构）。 */
export interface AuthCollisionEvent {
  type: 'phys-event';
  kind: 'land' | 'blocked';
  pos: number[];
  /** 权威碰撞瞬间朝向（度；权威仅在碰撞判断时可影响渲染角度）。 */
  yawDeg: number;
  pitchDeg: number;
  /** 权威碰撞瞬间速度（land：以权威速度为校准基准；blocked：供参考）。 */
  vel: number[];
  timeMs: number;
}

export interface AuthLoopEnv {
  /** 跨线程状态通道（SAB 或 MsgState 回退；动态读取——init 消息后注入）。 */
  shared: ShmState | MsgState | null;
  getPhys(): PhysWorldLike | null;
  /** 消息发送（缺省 self.postMessage；node 测试注入）。 */
  post?(msg: unknown): void;
  /** 碰撞事件回调（缺省 postMessage；可注入做断言/过滤）。 */
  onCollisionEvent?(ev: AuthCollisionEvent): void;
  /** 模式门（§3.2 双线互斥门，additive）：返回 false = 本线早退（解耦线独占
   * 物理推进）。缺省 undefined = 恒真——v7 单线行为零变化。
   * 三模式语义（auth/compute-mode.ts 四向交接矩阵 tick 行）：auth 线在 coupled
   * 与 tick 模式推进、decoupled 早退（isAuthLineMode）。 */
  modeGate?: () => boolean;
  /** 三模式直读钩子（可选，t2 门谓词三值化入口）：提供时缺省门 =
   * isAuthLineMode(getComputeMode())——耦合/tick 推进、解耦早退，worker 装配
   * 免再写谓词（main.ts 现行 `() => computeMode === 'coupled'` 二值注入可原样
   * 保留；显式 modeGate 优先，向后兼容）。 */
  getComputeMode?: () => ComputeMode;
  /** C 键 hold 冻结快照（可选，t4 · t3-memo §4.6）：非 null 时 stepPhysics
   * 顶置跳过 phys.tick、set_state(held, vel=0)、丢弃本 tick 输入增量（键位
   * 实时态不损）。装配侧仅 tick 模式返回非 null（耦合/解耦恒 null——零影响）。
   * 缺省 undefined = 恒 null = v7 零变化。 */
  holdState?: () => HoldSnapshot | null;
  /** tick 模式 F4-C 控制器钩子（可选，t4 主案引擎）：提供时 loop 每唤醒在
   * 累积器推进前回调 onWake（乐观窗评估），stepPhysics 走 tick 模式零分配
   * 支路（tick_into + state_out 视图）。控制器全部方法自查模式——非 tick
   * 模式等价缺省。缺省 undefined = 引擎本体逐行不动（耦合/解耦零回归）。 */
  tickF4?: TickF4Controller;
  /** 渲染轨迹采样源（可选，渲染轨迹采样扩展）：提供时**耦合模式**的权威发布
   * 位置改为「渲染折线上按τ插值取点」——tick 折线成为渲染曲线的内接 ~64 边形
   * （每个发布点都落在渲染 polyline 上）。
   *
   * 两条硬约束（设计裁定）：
   * - R1：渲染预测仍是 input→display 最快响应者——本钩子只在**发布侧**被调用
   *   （渲染的位置路径零新增读/等待/分配）；
   * - R2：权威仍是速度之主——`calibrateVelocity` 每帧覆盖渲染速度是**有意**的
   *   （玩法难度），本钩子不触碰它，也不经 set_state 反向注入位置。
   *
   * 缺省 undefined = 逐行保持今日行为（发布位置 = phys.state() 自身位置，
   * 且 writePublishedTau 不被调用）——耦合/解耦/tick 既有路径字节级零回归。 */
  renderTrajectory?: RenderTrajectorySource;
}

/**
 * 渲染轨迹采样源（由 worker 装配侧实现；读侧只碰 Number，热路径零分配）。
 *
 * 语义：`tickInstantToTau` 把权威时钟瞬时值换算到**渲染时钟域** τ；`sampleAtTau`
 * 在渲染折线上按 τ 线性插值取点（绝不外推）。两者任一不可用即返回 -1 / null，
 * 调用方回退到自身物理位置（本 tick 不做投影）。
 */
export interface RenderTrajectorySource {
  /** 权威时钟瞬时值(worker performance.now 域, ms) → 渲染时钟 τ(ms)；不可用返回 -1。 */
  tickInstantToTau(workerInstMs: number): number;
  /** 在渲染折线上按 τ 取点（线性插值，绝不外推）；不可用返回 null。 */
  sampleAtTau(tauMs: number): { x: number; y: number; z: number } | null;
}

export interface AuthLoop {
  /** 固定步长（Hz；config.physics.tickRate 变更即时生效）。 */
  setFixedDt(rate: number): boolean;
  /** 清累积器/基准墙钟（world-json 重建后防新旧步长错配）。 */
  reset(): void;
  /** 启动自驱循环（幂等；wasm-init 就绪后调用一次）。 */
  start(): void;
  /** 立即发布当前权威状态一帧（不 tick；phys-mode-port §3.4.C 解耦→耦合复入
   * 首帧——主线程 readAuthoritative 读到切换时刻态而非耦合期陈旧帧）。
   * meta（可选，t4）：tick 模式交接首帧携带 {seg,tick,evt}（mode_switch 断点
   * 可见化）；缺省 undefined = 既有调用点零感知（I_A_* 槽零触碰）。 */
  publishCurrentState(meta?: AuthPublishMeta): void;
}

/** 防穿墙：单 tick 输入增量上限（度）。 */
const MAX_INPUT_PER_STEP_BASE = 1200;

/**
 * 门开合判定（§3.2 双线互斥门 · 谓词三值化入口，任务 t2）：
 * ① 显式 modeGate 优先（v7 二值注入语义原样保留，向后兼容）；
 * ② 否则 getComputeMode 钩子 → isAuthLineMode（coupled/tick 推进、decoupled 早退）；
 * ③ 两者皆缺省 = 恒开（v7 单线零变化）。
 * 纯函数：可注入单测；引擎本体（stepPhysics/累积器）零改动——t3-memo §2.6。
 */
export function resolveAuthGateOpen(
  env: Pick<AuthLoopEnv, 'modeGate' | 'getComputeMode'>,
): boolean {
  if (env.modeGate) return env.modeGate();
  if (env.getComputeMode) return isAuthLineMode(env.getComputeMode());
  return true;
}

export function createAuthLoop(env: AuthLoopEnv): AuthLoop {
  /** 权威固定步长（默认 64Hz；config.physics.tickRate 动态覆盖）。 */
  let fixedDt = 1 / 64;
  /** 累积器：真实墙钟 → 固定步长推进（不设上限，低帧率不丢物理时间）。 */
  let acc = 0;
  let lastWall = 0;
  /**
   * 已模拟到的**墙钟刻度**（worker 时钟域，ms）——权威仿真时钟。
   *
   * 为什么需要它：原实现只用 `lastWall` 累积**增量**，任何一次 `reset()` 都会把
   * 「累积器余数（均值 fixedDt/2）+ 上次唤醒到本次唤醒的整个区间」永久删掉，且
   * 只跟踪"距上次唤醒的增量"，丢掉的墙钟时间再也回不来。
   * 而 `input-bridge.ts` 把 `tickRate` 塞进**每一条** physics 配置消息 →
   * `setFixedDt + reset()` 对任何物理面板改动都会触发：拖滑条（≈60 事件/秒）
   * 实测每秒丢 ≈0.69s 仿真时间，**权威时钟只跑到墙钟的 31%** 且不可恢复。
   * 改成以 `simMs` 为绝对基准重算欠账，任何区间都不会被静默删除。
   */
  let simMs = 0;
  /**
   * 欠账上限（ms）：显式有界，避免定时器节流后无限落后。
   * 约束 `MAX_CATCHUP_MS ≤ 64 * fixedDt ≈ 955ms`，保证保留的欠账**一轮唤醒内可排空**
   * （250 / 14.925 ≈ 16.8 < 64）。
   */
  const MAX_CATCHUP_MS = 250;
  let started = false;

  // 碰撞事件检测基准（tick 前快照）
  let prevOnGround = false;
  let prevSpeed = 0;
  let prevOrigin: [number, number, number] | null = null;

  const post: (msg: unknown) => void =
    env.post ??
    ((msg: unknown): void => {
      if (typeof self !== 'undefined') {
        (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
      }
    });

  const emitCollision = (ev: AuthCollisionEvent): void => {
    if (env.onCollisionEvent) env.onCollisionEvent(ev);
    else post(ev);
  };

  /** hold 冻结单步（t3-memo §4.6 顶置：跳过 phys.tick，held 定格 + vel=0，
   * 输入增量丢弃（键位实时态不损——takeInput 只清 dx/dy 累计），本 tick 时间
   * 丢弃不补；网格继续（publishMeta 标号推进），段不变。释放走 set-hold(null,
   * savepoint) 全量恢复（零参数触碰，§4.5 已证）。 */
  function holdStep(dt: number, held: HoldSnapshot): void {
    const shared = env.shared;
    const phys = env.getPhys();
    if (!shared || !phys) return;
    const maxStep = (MAX_INPUT_PER_STEP_BASE * dt) / (1 / 64);
    shared.takeInput(maxStep);
    phys.set_state(held.x, held.y, held.z, held.yaw, held.pitch, 0, 0, 0, held.onGround);
    // eyeHeight 取实例当前姿态（set_state 不动 ducked/duck_frac → 冻结前值）
    const s = phys.state() as { eyeHeight: number };
    env.tickF4?.noteHoldTick();
    // 冻结期网格继续：meta 照常（标号推进、段不变、事件位随排空）
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

  /** 单个权威步长：消费输入 → 完整物理 tick（含碰撞）→ 写权威帧。 */
  function stepPhysics(dt: number): void {
    const shared = env.shared;
    const phys = env.getPhys();
    if (!shared || !phys) return;
    // ── hold 冻结顶置（t4 · t3-memo §4.6；holdState 缺省 undefined = 恒 null
    // = v7 零变化；装配侧仅 tick 模式返回非 null）─────────────────────────
    const held = env.holdState?.() ?? null;
    if (held) {
      holdStep(dt, held);
      return;
    }
    const maxStep = (MAX_INPUT_PER_STEP_BASE * dt) / (1 / 64);
    // ── tick 模式零分配支路（t4 ⑦ · additive）：tick_into + state_out 视图——
    // step_core 与 tick() 同一 Rust 函数（bit 级同物理）；帧 B_A 十值 + B5
    // 廉价字段同源视图读。tickF4 缺省（debug/耦合单实例）= 下面 v7 逐行不动。
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
      // 碰撞事件停发（tick 模式：主线程零预测实例，land/blocked 位置微调无
      // 消费者；t3-memo §2.6 #4 可选项落地——事件显示面改经 I_A_EVT 位 +
      // 消费器路由，t3-memo §2.5「帧流成为唯一事件真源」）
      return;
    }
    const input = shared.takeInput(maxStep);
    // 碰撞事件检测基准（tick 前）
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
    // meta 透传（t4 additive）：tick 模式回落路径（isActive=false 边缘）携带
    // {seg,tick,evt}；耦合/解耦 publishMeta 返回 undefined = meta 缺省语义
    // = I_A_* 槽零触碰（v7 字节级零回归）
    const meta = env.tickF4?.publishMeta();
    // ── 渲染轨迹采样投影（渲染轨迹采样扩展；R1/R2 见 AuthLoopEnv.renderTrajectory）──
    // 发布位置 = 渲染折线上 τ 处的一个采样点（tick 折线 = 渲染曲线的内接 ~64 边形）。
    // 门控三重：钩子存在 ∧ 非 f4 支路（上文 258-283 早退）∧ 计算模式确为 coupled
    // ——本分支同时是 tick 模式的回落路径，不 gate 会在 tick 模式误投影。
    // holdStep / f4 支路 / publishCurrentState 三处**不投影**（各自早退或独立函数）。
    // 钩子缺省（undefined）时 `rt !== undefined` 恒 false → pub 恒 null → 发布位置
    // 表达式退化为 `{x:s.posX,y:s.posY,z:s.posZ}`（与旧字面量同值同序），
    // tickInstantToTau/sampleAtTau 一次都不被调用；唯一可观察差异是下面那行
    // writePublishedTau(0)（该行**仅对真实 ShmState/MsgState 生效**，且只写
    // RT_PUB_TAU 一个此前从未被写过的槽——对未被接线的调用方零影响）。
    const rt = env.renderTrajectory;
    let pub: { x: number; y: number; z: number } | null = null;
    let tau = 0;
    if (rt !== undefined && (env.getComputeMode?.() ?? 'coupled') === 'coupled') {
      tau = rt.tickInstantToTau(simMs);
      if (tau >= 0) pub = rt.sampleAtTau(tau);
    }
    // τ 回写（微秒；主线程记录器用同一 τ 给 tick 节点打时标）：只有真的用了投影
    // 才写非零；未投影写 0 = 主线程显式看到「本帧不是投影帧」。
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

    // 权威碰撞事件（低频，postMessage 回传主线程做位置微调 + 角度同步）：
    // - land：onGround 上升沿（权威真实落地点；渲染侧相位差可能差几 units）
    // - blocked：撞墙/被阻——速度骤降（>250 u/s）且实际位移远小于速度对应位移
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

  /** 主循环：墙钟驱动固定步长权威 tick（250Hz 轮询 > 最大 tick 率）。 */
  function loop(): void {
    setTimeout(loop, 4);
    // 模式门（§3.2 三值化入口，resolveAuthGateOpen；缺省恒真）：关断时冻结墙钟
    // 基准——复入时从当前时刻重新累积，不补跑关断期间的时间（该窗口内物理时间
    // 由解耦线独占消耗；tick 模式关断窗=解耦线推进窗，交接矩阵 tick 行②/④）
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
    // **绝对欠账**：由 (now, simMs) 直接重算，而不是累积增量——
    // 这样任何墙钟区间都不会因为 reset/漏唤醒被静默删除。
    acc = (now - simMs) / 1000;
    lastWall = now;
    // 显式有界：定时器被节流（后台 ≥1s/次、深度节流 1 次/分钟）时，
    // 超出上限的部分主动跳过并缩短 simMs，避免欠账无界增长。
    if (acc * 1000 > MAX_CATCHUP_MS) {
      simMs = now - MAX_CATCHUP_MS;
      acc = MAX_CATCHUP_MS / 1000;
    }
    // ── tick 模式 F4-C 乐观窗（t4 additive · 唯一新增调用点）：nextDue =
    // 本唤醒将触发的下一真实 tick 网格 due——由同一累积器相位推导（lastWall +
    // (fixedDt−acc)·1000），与真实网格零漂移；追赶爆发（acc≥fixedDt）时
    // remaining≤0 被控制器开火地板吞掉（该 tick 回落 pure-history）。引擎本体
    // 其余逐行不动。
    if (env.tickF4) {
      env.tickF4.onWake(now, now + Math.max(0, (fixedDt - acc) * 1000));
    }
    // 固定步长推进（不设上限：低帧率补足全部欠步）
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
      // **关键**：`input-bridge` 把 tickRate 塞进每一条 physics 配置消息，
      // 而调用方原本在 setFixedDt 之后无条件 reset()。步长未变时返回 false，
      // 调用方据此跳过 reset()，不再无谓删掉累积器余数与唤醒区间
      // （原先每秒丢 ≈0.69s 仿真时间 = 用户报告的「tick 计算滑落」）。
      if (next === fixedDt) return false;
      // 换步长不丢时间：把当前余数折算进绝对时钟基准
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
