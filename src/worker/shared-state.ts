/**
 * 共享状态层 — 主线程 ↔ Worker 的跨线程数据通道
 *
 * 架构（对应重构时序图）：
 * - 阶段一（主线程）：交互参数（鼠标增量 + 按键位掩码）写入共享内存输入区，
 *   再发送轻量 `frame` 信号（仅携带主线程时间戳）。
 * - 阶段二（Worker）：收到信号后从共享内存读取输入 → 固定步长物理计算 →
 *   加写锁（Atomics）写入输出区（位置/视角/速度/onGround/mode + 时间戳 + seq）。
 * - 阶段三（主线程）：渲染循环安全检查（锁占用 → 复用上一帧缓存；释放 →
 *   读取 + seq 校验）→ LERP 插值 → 渲染。
 *
 * 双实现：
 * - ShmState：SharedArrayBuffer + Atomics（需 crossOriginIsolated，dev serve.py 已配 COOP/COEP）
 * - MsgState：postMessage 数据通道回退（无 COOP/COEP 时自动降级，功能等价、延迟更高）
 *
 * 共享内存布局（字节偏移见常量）：
 *   Int32 区：lock / outSeq / inSeq / keysMask / onGround / mode / inDx / inDy
 *   Float64 区（8 字节对齐，index 4 起）：pos.x/y/z / yaw / pitch / vel.x/y/z / timeMs
 */

import type { FrameSnapshot, KeyState } from './worker-types.js';

// ---------------------------------------------------------------------------
// 按键位掩码
// ---------------------------------------------------------------------------

/** KeyState 字段 → 位掩码。 */
export const KEY_MASK: Record<keyof KeyState, number> = {
  forward: 1,
  backward: 2,
  left: 4,
  right: 8,
  jump: 16,
  duck: 32,
  sprint: 64,
  reset: 128,
  wheelJump: 256,
  yawLeft: 512,
  yawRight: 1024,
};

/** KeyState → 按键位掩码（主线程写入共享内存用）。 */
export function keysToMask(keys: KeyState): number {
  let m = 0;
  if (keys.forward) m |= KEY_MASK.forward;
  if (keys.backward) m |= KEY_MASK.backward;
  if (keys.left) m |= KEY_MASK.left;
  if (keys.right) m |= KEY_MASK.right;
  if (keys.jump) m |= KEY_MASK.jump;
  if (keys.duck) m |= KEY_MASK.duck;
  if (keys.sprint) m |= KEY_MASK.sprint;
  if (keys.reset) m |= KEY_MASK.reset;
  if (keys.wheelJump) m |= KEY_MASK.wheelJump;
  if (keys.yawLeft) m |= KEY_MASK.yawLeft;
  if (keys.yawRight) m |= KEY_MASK.yawRight;
  return m;
}

/** 按键位掩码 → KeyState（Worker 物理消费）。 */
export function maskToKeys(mask: number): KeyState {
  const has = (b: number): boolean => (mask & b) !== 0;
  return {
    forward: has(KEY_MASK.forward),
    backward: has(KEY_MASK.backward),
    left: has(KEY_MASK.left),
    right: has(KEY_MASK.right),
    jump: has(KEY_MASK.jump),
    duck: has(KEY_MASK.duck),
    sprint: has(KEY_MASK.sprint),
    reset: has(KEY_MASK.reset),
    wheelJump: has(KEY_MASK.wheelJump),
    yawLeft: has(KEY_MASK.yawLeft),
    yawRight: has(KEY_MASK.yawRight),
  };
}

// ---------------------------------------------------------------------------
// 共享内存布局
// ---------------------------------------------------------------------------

/** Int32 区索引（0-7，共 32 字节）。 */
const I_LOCK = 0; // 输出写锁（1 = Worker 写中）
const I_OUT_SEQ = 1; // 输出版本号（Worker 写完 ++）
const I_IN_SEQ = 2; // 输入版本号（主线程写入 ++）
const I_KEYS = 3; // 按键位掩码
const I_ONGROUND = 4; // onGround（0/1）
const I_MODE = 5; // 物理模式（0=noclip 1=physics）
const I_IN_DX = 6; // 鼠标 dx 累加器（主线程 Atomics.add）
const I_IN_DY = 7; // 鼠标 dy 累加器

/** Float64 区索引（index 4 起 = 字节 32，8 字节对齐）。 */
const F_POS_X = 4;
const F_POS_Y = 5;
const F_POS_Z = 6;
const F_YAW = 7;
const F_PITCH = 8;
const F_VEL_X = 9;
const F_VEL_Y = 10;
const F_VEL_Z = 11;
const F_TIME = 12;
const F_EYE_HEIGHT = 13;

/** SharedArrayBuffer 总字节数（Int32 32B + Float64 14×8B = 144B）。 */
export const SHARED_BUFFER_SIZE = 32 + 14 * 8;

/** 输入脉冲结构（Worker takeInput 返回值）。 */
export interface InputSample {
  dx: number;
  dy: number;
  keysMask: number;
}

// ---------------------------------------------------------------------------
// 抽象接口
// ---------------------------------------------------------------------------

/**
 * 跨线程状态通道。
 *
 * 主线程侧：setInput / setKeys / readFrame
 * Worker 侧：takeInput / writeFrame
 */
export abstract class SharedState {
  /** 是否为共享内存模式（false = postMessage 回退）。 */
  abstract readonly isShared: boolean;

  // ── 主线程侧 ──────────────────────────────────────────────

  /** 写入鼠标增量（累加）与按键位掩码，并标记输入版本。 */
  abstract setInput(dx: number, dy: number, keysMask: number): void;

  /** 仅更新按键位掩码（无鼠标增量时每帧调用）。 */
  abstract setKeys(keysMask: number): void;

  /** 安全读取最新物理快照（锁占用/写入中返回 null → 复用上一帧缓存）。 */
  abstract readFrame(): FrameSnapshot | null;

  // ── Worker 侧 ─────────────────────────────────────────────

  /** 读取输入并清零增量（keysMask 保留为当前状态）。 */
  abstract takeInput(): InputSample;

  /** 写入物理快照（加写锁保护临界区）。 */
  abstract writeFrame(snap: FrameSnapshot): void;
}

// ---------------------------------------------------------------------------
// ShmState — SharedArrayBuffer + Atomics
// ---------------------------------------------------------------------------

/** 共享内存实现（crossOriginIsolated 时启用）。 */
export class ShmState extends SharedState {
  readonly isShared = true;
  private readonly i32: Int32Array;
  private readonly f64: Float64Array;

  constructor(buffer: SharedArrayBuffer) {
    super();
    this.i32 = new Int32Array(buffer);
    this.f64 = new Float64Array(buffer);
  }

  setInput(dx: number, dy: number, keysMask: number): void {
    // 鼠标增量累加（整数 px）：Worker takeInput 时 Atomics.exchange 清零
    Atomics.add(this.i32, I_IN_DX, Math.trunc(dx));
    Atomics.add(this.i32, I_IN_DY, Math.trunc(dy));
    Atomics.store(this.i32, I_KEYS, keysMask);
    Atomics.add(this.i32, I_IN_SEQ, 1);
  }

  setKeys(keysMask: number): void {
    Atomics.store(this.i32, I_KEYS, keysMask);
  }

  takeInput(): InputSample {
    const dx = Atomics.exchange(this.i32, I_IN_DX, 0);
    const dy = Atomics.exchange(this.i32, I_IN_DY, 0);
    const keysMask = Atomics.load(this.i32, I_KEYS);
    return { dx, dy, keysMask };
  }

  writeFrame(snap: FrameSnapshot): void {
    // 临界区：加写锁 → 写数据 → 版本号 → 释放锁
    Atomics.store(this.i32, I_LOCK, 1);
    this.f64[F_POS_X] = snap.pos.x;
    this.f64[F_POS_Y] = snap.pos.y;
    this.f64[F_POS_Z] = snap.pos.z;
    this.f64[F_YAW] = snap.yaw;
    this.f64[F_PITCH] = snap.pitch;
    this.f64[F_VEL_X] = snap.vel.x;
    this.f64[F_VEL_Y] = snap.vel.y;
    this.f64[F_VEL_Z] = snap.vel.z;
    this.f64[F_TIME] = snap.timeMs;
    this.f64[F_EYE_HEIGHT] = snap.eyeHeight;
    Atomics.store(this.i32, I_ONGROUND, snap.onGround ? 1 : 0);
    Atomics.store(this.i32, I_MODE, snap.mode === 'physics' ? 1 : 0);
    Atomics.store(this.i32, I_OUT_SEQ, snap.seq);
    Atomics.store(this.i32, I_LOCK, 0);
  }

  readFrame(): FrameSnapshot | null {
    // 安全检查点：锁被占用（Worker 写中）→ 返回 null，复用上一帧缓存
    if (Atomics.load(this.i32, I_LOCK) === 1) return null;
    const seqA = Atomics.load(this.i32, I_OUT_SEQ);
    const snap: FrameSnapshot = {
      pos: { x: this.f64[F_POS_X], y: this.f64[F_POS_Y], z: this.f64[F_POS_Z] },
      yaw: this.f64[F_YAW],
      pitch: this.f64[F_PITCH],
      vel: { x: this.f64[F_VEL_X], y: this.f64[F_VEL_Y], z: this.f64[F_VEL_Z] },
      onGround: Atomics.load(this.i32, I_ONGROUND) === 1,
      mode: Atomics.load(this.i32, I_MODE) === 1 ? 'physics' : 'noclip',
      timeMs: this.f64[F_TIME],
      eyeHeight: this.f64[F_EYE_HEIGHT],
      seq: seqA,
    };
    // 读后校验：写者已开始下一轮写入 → 数据可能不完整，丢弃本次
    if (Atomics.load(this.i32, I_LOCK) === 1) return null;
    if (Atomics.load(this.i32, I_OUT_SEQ) !== seqA) return null;
    return snap;
  }
}

// ---------------------------------------------------------------------------
// MsgState — postMessage 数据通道（回退）
// ---------------------------------------------------------------------------

/**
 * 回退实现：无 crossOriginIsolated 时使用。
 * 主线程侧（MsgStateMain）发 input 消息、缓存 Worker 回传的 phys-frame；
 * Worker 侧（MsgStateWorker）从 handleInput 消息读输入、writeFrame 时回传。
 */
export class MsgStateMain extends SharedState {
  readonly isShared = false;
  private cached: FrameSnapshot | null = null;

  constructor(private readonly worker: Worker) {
    super();
  }

  setInput(dx: number, dy: number, keysMask: number): void {
    this.worker.postMessage({
      type: 'input',
      keys: maskToKeys(keysMask),
      mouseDx: dx,
      mouseDy: dy,
    });
  }

  setKeys(keysMask: number): void {
    this.worker.postMessage({
      type: 'input',
      keys: maskToKeys(keysMask),
      mouseDx: 0,
      mouseDy: 0,
    });
  }

  /** 缓存 Worker 回传的物理帧（主线程 handleWorkerMessage 调用）。 */
  setCachedFrame(frame: FrameSnapshot): void {
    this.cached = frame;
  }

  readFrame(): FrameSnapshot | null {
    return this.cached;
  }

  takeInput(): InputSample {
    return { dx: 0, dy: 0, keysMask: 0 };
  }

  writeFrame(_snap: FrameSnapshot): void {
    // 主线程侧不写物理输出
  }
}

/** Worker 侧回退实现：输入由 handleInput 消息注入，输出经 phys-frame 回传。 */
export class MsgStateWorker extends SharedState {
  readonly isShared = false;
  private pending: InputSample = { dx: 0, dy: 0, keysMask: 0 };

  /**
   * 由 physics-worker.handleInput 注入。
   * dx/dy 累加（mousemove 与每帧 setKeys 消息交错时保证增量不丢失）；
   * keysMask 覆盖（当前状态）。
   */
  setPendingInput(sample: InputSample): void {
    this.pending.dx += sample.dx;
    this.pending.dy += sample.dy;
    this.pending.keysMask = sample.keysMask;
  }

  setInput(_dx: number, _dy: number, _keysMask: number): void {
    // Worker 侧不写输入
  }

  setKeys(_keysMask: number): void {
    // Worker 侧不写输入
  }

  readFrame(): FrameSnapshot | null {
    return null;
  }

  takeInput(): InputSample {
    // 读取并清零增量（keysMask 保留为当前状态，不参与清零）
    const sample = {
      dx: this.pending.dx,
      dy: this.pending.dy,
      keysMask: this.pending.keysMask,
    };
    this.pending.dx = 0;
    this.pending.dy = 0;
    return sample;
  }

  writeFrame(snap: FrameSnapshot): void {
    (self as unknown as Worker).postMessage({ type: 'phys-frame', frame: snap });
  }
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/** 主线程侧创建（返回实例后传给 InputBridge / 渲染器）。 */
export function createMainSharedState(worker: Worker, buffer: SharedArrayBuffer | null): SharedState {
  if (buffer && typeof SharedArrayBuffer !== 'undefined') {
    return new ShmState(buffer);
  }
  return new MsgStateMain(worker);
}

/** Worker 侧创建（init 消息携带 buffer；null = 回退模式）。 */
export function createWorkerSharedState(buffer: SharedArrayBuffer | null): SharedState {
  if (buffer) {
    return new ShmState(buffer);
  }
  return new MsgStateWorker();
}
