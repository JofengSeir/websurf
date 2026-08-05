/**
 * 共享状态层 — 主线程 ↔ Worker 的跨线程数据通道
 *
 * 架构（对应高频输入闭环时序图）：
 * - 阶段一（主线程）：交互参数（鼠标增量 + 按键位掩码 + 时间戳）写入共享内存
 *   输入环形缓冲区（SPSC 无锁：唯一生产者=主线程，唯一消费者=Worker），
 *   积压 ≥ NOTIFY_THRESHOLD 时 Atomics.notify（仅发信号，无数据）；满则覆盖最旧
 *   （消费者跟不上时自动降采样）；再发轻量 `frame` 触发信号。
 * - 阶段二（Worker）：批量取输入（排空 [head, tail) 聚合）→ 固定步长物理 →
 *   加写锁（Atomics）写输出区（位置/视角/速度/onGround/mode + 时间戳 + seq）。
 * - 阶段三（主线程）：安全检查（锁占用 → 复用上一帧缓存；释放 → 读取 + seq 校验）
 *   → LERP 插值 → 渲染。
 *
 * 双实现：
 * - ShmState：SharedArrayBuffer + Atomics（需 crossOriginIsolated，dev serve.py 已配 COOP/COEP）
 * - MsgState：postMessage 数据通道回退（无 COOP/COEP 时自动降级，功能等价、延迟更高）
 *
 * 共享内存布局（字节偏移见常量）：
 *   Int32 区：lock / outSeq / inHead / inTail（head=消费者推进，tail=生产者推进，
 *     均单调递增计数，槽址用 & (RING_CAPACITY-1)；满则覆盖最旧——自动降采样）
 *   Float64 区（8 字节对齐）：pos.x/y/z / yaw / pitch / vel.x/y/z / timeMs / eyeHeight
 *   Ring 区（SOA 四数组，8 字节对齐）：dxs[64] / dys[64] / tss[64]（Float64）+ keys[64]（Int32）
 *
 * 环形缓冲内存序约定（SPSC 无锁）：
 * - 写者：先写槽数据（普通写）→ 最后 Atomics.store(tail)（release 序）
 * - 读者：先 Atomics.load(tail)（acquire 序）→ 再批量读 [head, tail) 快照
 * - 写者只写"当前 tail 槽"，恰在读快照边界之外；读者看到的每槽都是完整写入
 * - 读上限 min(tail-head, RING_CAPACITY)：tail-head > N 的积压场景防回绕重读
 *
 * notify 唤醒协议（M2 Worker 自驱预留）：
 * - 唤醒目标 = I_IN_TAIL：写者 store(tail) 后积压 ≥ 阈值 → Atomics.notify(I_IN_TAIL, 1)
 * - 无唤醒丢失：notify 时若无等待者，等待者随后 Atomics.wait 因条件不满足
 *   （tail ≠ 期望值）立即返回
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
const I_IN_HEAD = 2; // 输入环形缓冲 head（消费者推进）
const I_IN_TAIL = 3; // 输入环形缓冲 tail（生产者推进；也是 notify/wait 唤醒目标）
const I_ONGROUND = 4; // onGround（0/1）
const I_MODE = 5; // 物理模式（0=noclip 1=physics）
// 6-7 预留

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

/** 输入环形缓冲容量（2 的幂，槽址用 & (RING_CAPACITY-1) 免取模）。 */
const RING_CAPACITY = 64;
const RING_MASK = RING_CAPACITY - 1;

/**
 * 积压唤醒阈值：生产者写入后 pending = tail - head ≥ 阈值 → Atomics.notify。
 * mousemove 被节流到显示刷新率（60-144Hz），64 槽环几乎不积压；
 * 阈值 8 ≈ 33-66ms 积压（M2 Worker 60Hz 自驱轮询兜底，notify 仅加速）。
 */
const NOTIFY_THRESHOLD = 8;

/** 环形缓冲字节偏移（Float64 输出区 32+10*8=112 起，全部 8 字节对齐）。 */
const RING_DXS_BYTE = 32 + 10 * 8; // 112
const RING_DYS_BYTE = RING_DXS_BYTE + RING_CAPACITY * 8; // 624
const RING_TSS_BYTE = RING_DYS_BYTE + RING_CAPACITY * 8; // 1136
const RING_KEYS_BYTE = RING_TSS_BYTE + RING_CAPACITY * 8; // 1648

/** SharedArrayBuffer 总字节数：Int32 头 32B + Float64 输出 10×8B + 环 dxs/dys/tss 64×8B×3 + 环 keys 64×4B = 1904B */
export const SHARED_BUFFER_SIZE = RING_KEYS_BYTE + RING_CAPACITY * 4;

/** 输入样本结构（Worker takeInput 返回值）。 */
export interface InputSample {
  dx: number;
  dy: number;
  keysMask: number;
  /** 批量消费扩展（环形缓冲模式）：本帧聚合的样本数（无输入时为 0）。 */
  sampleCount?: number;
  /** 本批次首个样本时间戳（performance.now()，ms）。 */
  firstTs?: number;
  /** 本批次末个样本时间戳（performance.now()，ms）。 */
  lastTs?: number;
}

// ---------------------------------------------------------------------------
// 抽象接口
// ---------------------------------------------------------------------------

/**
 * 跨线程状态通道。
 * 主线程侧：setInput / setKeys / readFrame；Worker 侧：takeInput / writeFrame。
 */
export abstract class SharedState {
  /** 是否为共享内存模式（false = postMessage 回退）。 */
  abstract readonly isShared: boolean;

  // ── 主线程侧 ──────────────────────────────────────────────

  /**
   * 写入鼠标增量 + 按键位掩码（环形缓冲模式 = 追加一个样本）。
   * @param ts 样本时间戳（performance.now()）；缺省 = 实现内采集。
   */
  abstract setInput(dx: number, dy: number, keysMask: number, ts?: number): void;

  /**
   * 仅更新按键位掩码（无鼠标增量时每帧调用）。
   * 环形缓冲模式下追加零增量样本，保证按键状态持续刷新。
   */
  abstract setKeys(keysMask: number, ts?: number): void;

  /** 安全读取最新物理快照（锁占用/写入中返回 null → 复用上一帧缓存）。 */
  abstract readFrame(): FrameSnapshot | null;

  // ── Worker 侧 ─────────────────────────────────────────────

  /**
   * 读取本帧输入并排空缓冲（环形缓冲模式 = 批量读 [head, tail) 聚合求和）。
   * keysMask 为批次内最新样本；无输入时返回缓存按键状态。
   */
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
  /** 输入环形缓冲视图（SOA：dxs/dys/tss Float64 + keys Int32）。 */
  private readonly ringDxs: Float64Array;
  private readonly ringDys: Float64Array;
  private readonly ringTss: Float64Array;
  private readonly ringKeys: Int32Array;
  /** 生产者 tail（主线程实例本地推进，写共享内存）。 */
  private tail = 0;
  /** 消费者 head（Worker 实例本地推进，写共享内存）。 */
  private head = 0;
  /** 最近按键位掩码（takeInput 空批次时返回缓存）。 */
  private lastKeys = 0;

  constructor(buffer: SharedArrayBuffer) {
    super();
    this.i32 = new Int32Array(buffer);
    this.f64 = new Float64Array(buffer);
    this.ringDxs = new Float64Array(buffer, RING_DXS_BYTE, RING_CAPACITY);
    this.ringDys = new Float64Array(buffer, RING_DYS_BYTE, RING_CAPACITY);
    this.ringTss = new Float64Array(buffer, RING_TSS_BYTE, RING_CAPACITY);
    this.ringKeys = new Int32Array(buffer, RING_KEYS_BYTE, RING_CAPACITY);
  }

  setInput(dx: number, dy: number, keysMask: number, ts?: number): void {
    this.lastKeys = keysMask;
    this.pushSample(dx, dy, keysMask, ts ?? performance.now());
  }

  setKeys(keysMask: number, ts?: number): void {
    this.lastKeys = keysMask;
    // 零增量样本：保证"按住键不动鼠标"时 Worker 每帧仍能刷新 keys 状态
    this.pushSample(0, 0, keysMask, ts ?? performance.now());
  }

  /**
   * 追加一个输入样本（SPSC：唯一生产者=主线程，无锁）。
   *
   * 内存序：先写槽数据（普通写）→ 最后 Atomics.store(tail)（release 序）；
   * 消费者 load(tail)（acquire 序）后读槽，必见完整样本。
   * 满则覆盖最旧：写者始终写当前 tail 槽，不读 head 排空——消费者跟不上时
   * 自动降采样（丢弃最旧，保留最新 64 个）。
   *
   * notify（时序图步骤 6）：store(tail) 后积压 pending = tail - head ≥ 阈值
   * → Atomics.notify 仅发信号唤醒等待者（M2 Worker 自驱用）。
   */
  private pushSample(dx: number, dy: number, keysMask: number, ts: number): void {
    const idx = this.tail & RING_MASK;
    this.ringDxs[idx] = dx;
    this.ringDys[idx] = dy;
    this.ringKeys[idx] = keysMask;
    this.ringTss[idx] = ts;
    this.tail += 1;
    Atomics.store(this.i32, I_IN_TAIL, this.tail);
    // 积压检测（读 head 一次，~20ns）
    if (this.tail - Atomics.load(this.i32, I_IN_HEAD) >= NOTIFY_THRESHOLD) {
      Atomics.notify(this.i32, I_IN_TAIL, 1);
    }
  }

  takeInput(): InputSample {
    const tail = Atomics.load(this.i32, I_IN_TAIL);
    const count = tail - this.head;
    if (count <= 0) {
      // 空批次：返回缓存按键状态（增量归零）
      return { dx: 0, dy: 0, keysMask: this.lastKeys, sampleCount: 0 };
    }
    // 读上限：积压时只读最新 N 个（防回绕重读）
    const n = Math.min(count, RING_CAPACITY);
    let sumDx = 0;
    let sumDy = 0;
    let keys = this.lastKeys;
    let firstTs = 0;
    let lastTs = 0;
    for (let i = 0; i < n; i++) {
      const idx = (this.head + i) & RING_MASK;
      sumDx += this.ringDxs[idx];
      sumDy += this.ringDys[idx];
      keys = this.ringKeys[idx];
      const ts = this.ringTss[idx];
      if (i === 0) firstTs = ts;
      lastTs = ts;
    }
    this.head += n;
    Atomics.store(this.i32, I_IN_HEAD, this.head);
    this.lastKeys = keys;
    return {
      dx: sumDx,
      dy: sumDy,
      keysMask: keys,
      sampleCount: n,
      firstTs,
      lastTs,
    };
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
 * MsgStateMain：发 input 消息、缓存 Worker 回传的 phys-frame；
 * MsgStateWorker：从 handleInput 消息读输入、writeFrame 时回传。
 */
export class MsgStateMain extends SharedState {
  readonly isShared = false;
  private cached: FrameSnapshot | null = null;

  constructor(private readonly worker: Worker) {
    super();
  }

  setInput(dx: number, dy: number, keysMask: number, _ts?: number): void {
    this.worker.postMessage({
      type: 'input',
      keys: maskToKeys(keysMask),
      mouseDx: dx,
      mouseDy: dy,
    });
  }

  setKeys(keysMask: number, _ts?: number): void {
    this.worker.postMessage({
      type: 'input',
      keys: maskToKeys(keysMask),
      mouseDx: 0,
      mouseDy: 0,
    });
  }

  /** 缓存 Worker 回传的物理帧。 */
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

  setInput(_dx: number, _dy: number, _keysMask: number, _ts?: number): void {
    // Worker 侧不写输入
  }

  setKeys(_keysMask: number, _ts?: number): void {
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
