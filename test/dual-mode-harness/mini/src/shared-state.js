/**
 * mini — 最小核心链路共享状态层（SAB 通道）
 *
 * 复刻 test/src/shared-state.ts 的 SAB 布局与 TestShared 核心语义（仅 SAB 模式，
 * 剔除消息回退——mini 目标是架构演示，SAB 为唯一通道；布局与完整版逐字节一致）。
 *
 * 布局（192B）：
 * ┌────┬────┬──────┬──────┬───────┬───────┬────────────┬───────┬─────┬──────────────────┐
 * │ I0 │ I1 │ b64[1]│ b64[2]│ I_KEYS │ I_RW  │ 状态槽 S0   │ 状态槽 S1│  I_V │  尾部            │
 * │TICK│WAKE│ dxAcc │ dyAcc │ =6    │ =7    │ F64[5..12]  │ F64[13..20]│ =8  │                  │
 * └────┴────┴───────┴───────┴───────┴───────┴────────────┴──────────┴─────┴──────────────────┘
 *
 * 关键语义（与完整版一致，含 2026-08-12 计数语义修复）：
 * - WAKEUP（I1）：电平语义，WorkerA 物理背压（store 1 + CAS 复位）
 * - RENDER_WAKEUP（I7）：**计数语义**（Atomics.add 递增）——主线程每 rAF +1；
 *   WorkerB waitRenderWakeup 消费差值，渲染后 absorbRenderWake 吸收渲染期间
 *   新信号（合并丢弃）→ 渲染频率 = min(刷新率, GPU 耗时)，杜绝忙循环超限
 * - 状态双缓冲 S[2]：WorkerA 写空闲槽 S[V&1^1] → V++（add）；WorkerB 读 S[V&1]
 * - 输入槽：dx/dy 鼠标（BigInt64 定点 ×1000 原子累加）+ keysMask（Int32 覆盖）
 */

// ── 布局常量（与 shared-state.ts 一致）────────────────────────────
export const KEY_MASK = {
  forward: 1,
  backward: 2,
  left: 4,
  right: 8,
  jump: 16,
};

export const SHARED_BUFFER_SIZE = 192;

const I_TICK_RATE = 0;
const I_WAKEUP = 1;
const B_DX_ACC = 1;
const B_DY_ACC = 2;
const I_KEYS_MASK = 6;
const I_RENDER_WAKEUP = 7;
const I_V = 8;
const F_SLOT_BASE = 5;
const F_SLOT_STRIDE = 8;
const F_POS_X = 0;
const F_POS_Y = 1;
const F_POS_Z = 2;
const F_VEL_X = 3;
const F_VEL_Y = 4;
const F_VEL_Z = 5;
const F_YAW = 6;
const F_PITCH = 7;
const FIXED_SCALE = 1000;

/**
 * mini TestShared（SAB 模式专用；API 与完整版一致——main/worker-a/worker-b 用法相同）。
 */
export class TestShared {
  /** 主线程创建：包装 SAB 并 postMessage 给 WorkerA（SAB 共享传递，不可 transfer）。 */
  static create(buffer, worker) {
    return new TestShared(buffer, worker);
  }

  /** WorkerA 侧：收到 init-shared 后包装既有 SAB。 */
  static init(buffer) {
    return new TestShared(buffer, null);
  }

  /** WorkerB 侧：收到 init-shared 后包装既有 SAB（无 worker 引用，仅读/等待）。 */
  static initRender(buffer) {
    return new TestShared(buffer, null);
  }

  constructor(buffer, worker) {
    this.i32 = new Int32Array(buffer);
    this.b64 = new BigInt64Array(buffer);
    this.f64 = new Float64Array(buffer);
    this.worker = worker;
    // readState 上次见到的 V（未变返回 null）
    this.lastV = 0;
    // waitRenderWakeup 上次消费的唤醒计数（计数语义）
    this.lastRenderWake = 0;
    // 消息模式下用的键位掩码（mini 仅 SAB，保留占位）
    this.msgKeysMask = 0;
  }

  // ── 控制 ────────────────────────────────────────────────────
  /** 难度 tick 率（模式B 开关；0 = 纯 1ms 无限制）。 */
  writeTickRate(rate) {
    Atomics.store(this.i32, I_TICK_RATE, rate);
  }
  readTickRate() {
    return Atomics.load(this.i32, I_TICK_RATE);
  }

  // ── 唤醒（双槽分离：WAKEUP 电平 / RENDER_WAKEUP 计数）──────────
  /** 主线程每 rAF 调用：WAKEUP 电平 + RENDER_WAKEUP 计数 +1。 */
  wake() {
    Atomics.store(this.i32, I_WAKEUP, 1);
    Atomics.notify(this.i32, I_WAKEUP, 1);
    Atomics.add(this.i32, I_RENDER_WAKEUP, 1);
    Atomics.notify(this.i32, I_RENDER_WAKEUP, 1);
  }

  /** WorkerA 物理背压：wait(WAKEUP, 0, timeout) 挂起，返回后 CAS 复位。 */
  waitWakeup(timeoutMs) {
    const res = Atomics.wait(this.i32, I_WAKEUP, 0, timeoutMs);
    if (res === 'timed-out') return false;
    Atomics.compareExchange(this.i32, I_WAKEUP, 1, 0);
    return true;
  }

  /**
   * WorkerB 渲染帧循环：wait(计数 > lastRenderWake, timeout) —— 主驱动 = 主线程
   * rAF 帧信号（vsync 对齐）。渲染完成后须调 absorbRenderWake() 吸收渲染期间
   * 新到的信号（合并丢弃）→ 渲染频率严格 = min(刷新率, 1/渲染耗时)。
   */
  waitRenderWakeup(timeoutMs) {
    if (Atomics.load(this.i32, I_RENDER_WAKEUP) !== this.lastRenderWake) {
      this.lastRenderWake = Atomics.load(this.i32, I_RENDER_WAKEUP);
      return true;
    }
    const res = Atomics.wait(this.i32, I_RENDER_WAKEUP, this.lastRenderWake, timeoutMs);
    if (res === 'timed-out') return false;
    this.lastRenderWake = Atomics.load(this.i32, I_RENDER_WAKEUP);
    return true;
  }

  /** 渲染完成后吸收渲染期间新到的唤醒信号（合并丢弃，防忙循环超限）。 */
  absorbRenderWake() {
    this.lastRenderWake = Atomics.load(this.i32, I_RENDER_WAKEUP);
  }

  // ── 输入（主线程写 / WorkerA 消费）────────────────────────────
  /** 主线程：鼠标增量（×1000 定点原子累加）+ 键位掩码（覆盖）。 */
  addInput(dx, dy, keysMask) {
    if (dx !== 0) Atomics.add(this.b64, B_DX_ACC, BigInt(Math.round(dx * FIXED_SCALE)));
    if (dy !== 0) Atomics.add(this.b64, B_DY_ACC, BigInt(Math.round(dy * FIXED_SCALE)));
    Atomics.store(this.i32, I_KEYS_MASK, keysMask);
  }

  /** WorkerA：CAS 清零累加器（读当前值→归零→返回增量），限幅防穿墙。 */
  consumeInput(maxDelta = Infinity) {
    const dxFixed = this.exchangeZero(B_DX_ACC);
    const dyFixed = this.exchangeZero(B_DY_ACC);
    let dx = Number(dxFixed) / FIXED_SCALE;
    let dy = Number(dyFixed) / FIXED_SCALE;
    if (maxDelta !== Infinity) {
      dx = Math.max(-maxDelta, Math.min(maxDelta, dx));
      dy = Math.max(-maxDelta, Math.min(maxDelta, dy));
    }
    return { dx, dy, keysMask: Atomics.load(this.i32, I_KEYS_MASK) };
  }

  /** WorkerA tick 边界：读键位掩码快照（不消费）。 */
  peekKeys() {
    return Atomics.load(this.i32, I_KEYS_MASK);
  }

  exchangeZero(idx) {
    let cur = Atomics.load(this.b64, idx);
    for (;;) {
      const res = Atomics.compareExchange(this.b64, idx, cur, 0n);
      if (res === cur) return cur;
      cur = res;
    }
  }

  // ── 状态双缓冲（WorkerA 写 / WorkerB 读）───────────────────────
  /** WorkerA：写空闲槽（S[V&1^1]）→ V++。零分配直写。 */
  writeStateRaw(x, y, z, vx, vy, vz, yaw, pitch) {
    const slot = (Atomics.load(this.i32, I_V) & 1) ^ 1;
    const base = F_SLOT_BASE + slot * F_SLOT_STRIDE;
    this.f64[base + F_POS_X] = x;
    this.f64[base + F_POS_Y] = y;
    this.f64[base + F_POS_Z] = z;
    this.f64[base + F_VEL_X] = vx;
    this.f64[base + F_VEL_Y] = vy;
    this.f64[base + F_VEL_Z] = vz;
    this.f64[base + F_YAW] = yaw;
    this.f64[base + F_PITCH] = pitch;
    Atomics.add(this.i32, I_V, 1);
  }

  /** WorkerB：读当前槽（V 未变返回 null——只在新状态时重绘）。双槽防撕裂。 */
  readState() {
    const v0 = Atomics.load(this.i32, I_V);
    if (v0 === this.lastV) return null;
    const f = this.f64;
    let v = v0;
    let pos = { x: 0, y: 0, z: 0 };
    let vel = { x: 0, y: 0, z: 0 };
    let yaw = 0;
    let pitch = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const base = F_SLOT_BASE + (v & 1) * F_SLOT_STRIDE;
      pos = { x: f[base + F_POS_X], y: f[base + F_POS_Y], z: f[base + F_POS_Z] };
      vel = { x: f[base + F_VEL_X], y: f[base + F_VEL_Y], z: f[base + F_VEL_Z] };
      yaw = f[base + F_YAW];
      pitch = f[base + F_PITCH];
      const v2 = Atomics.load(this.i32, I_V);
      if (v2 === v) break;
      v = v2;
    }
    this.lastV = v;
    return { pos, vel, yaw, pitch, v };
  }
}
