/**
 * WebSurf-test 共享内存布局（SAB 无锁通信，与 README 最新时序图一致）。
 *
 * 布局（Int32 索引 / 字节偏移）：
 *
 * ┌─ 控制区 ────────────────────────────────────────────────
 * │ [0]   字节 0..3    TICK_RATE  Int32    动态难度（64/128/256/1000；阶段0 仅 store，无 notify）
 * │ [1]   字节 4..7    WAKEUP     Int32    唤醒信号（阶段1 store(1)+notify → WorkerA wait 立即返回）
 * ├─ 输入槽 ────────────────────────────────────────────────
 * │ [2]   字节 8..15   dxAcc      BigInt64（BigInt64 索引 1）鼠标增量累加（主线程 add / WorkerA CAS 消费）
 * │ [4]   字节 16..23  dyAcc      BigInt64（BigInt64 索引 2）
 * │ [6]   字节 24..27  keysMask   Int32    当前键位掩码（store 覆盖，松手即清零）
 * │ [7]   字节 28..31   （保留）
 * ├─ 状态槽（双缓冲 S[2]）──────────────────────────────────
 * │ [8]   字节 32..35  V          Int32    版本号（WorkerA add 递增 / WorkerB acquire 读）
 * │ 槽0   Float64 [5..12]  字节 40..103   pos×3 / vel×3 / yaw / pitch
 * │ 槽1   Float64 [13..20] 字节 104..167  pos×3 / vel×3 / yaw / pitch
 * └─ 168B 起为末尾（SHARED_BUFFER_SIZE = 192B）
 *
 * 读写协议（最新时序图）：
 * - 控制区：阶段0 主线程 store TICK_RATE（仅 store，不 notify——WorkerA 每轮循环自动识别）；
 *   WAKEUP 槽承载阶段1 唤醒信号：wake() = store(WAKEUP,1) + notify(WAKEUP,1)，
 *   WorkerA waitWakeup() 挂起在 WAKEUP 槽上（wait(WAKEUP,0,timeout)），返回后 store(WAKEUP,0) 复位
 * - 输入槽：主线程 Atomics.add 累加（无上限），WorkerA consumeInput(maxDelta) CAS 清零消费 + 限幅
 * - 状态槽双缓冲：writeState 写"当前 V 的另一槽"（S[V&1 ^ 1]，不覆盖读槽）→ Atomics.add(V,1)；
 *   readState acquire 读 V，V 未变返回 null（非阻塞采样），否则读当前槽 S[V&1]（double-check 防撕裂）
 */

// ── 键位掩码（与 Rust src/phys/mod.rs apply_input 位定义一致）────────
export const KEY_MASK = {
  forward: 1,
  backward: 2,
  left: 4,
  right: 8,
  jump: 16,
} as const;

/** 键位掩码 → boolean 集合（main 键盘状态 → 掩码）。 */
export function keysToMask(keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; jump: boolean }): number {
  let m = 0;
  if (keys.forward) m |= KEY_MASK.forward;
  if (keys.backward) m |= KEY_MASK.backward;
  if (keys.left) m |= KEY_MASK.left;
  if (keys.right) m |= KEY_MASK.right;
  if (keys.jump) m |= KEY_MASK.jump;
  return m;
}

// ── SAB 布局偏移常量（Int32 索引；BigInt64 槽占 2 个 Int32 索引）──────

/** 控制区：TICK_RATE（Int32）。 */
const I_TICK_RATE = 0;
/** 控制区：WAKEUP 唤醒信号（Int32）。 */
const I_WAKEUP = 1;

/** 输入槽：dxAcc / dyAcc（BigInt64 原子累加）。BigInt64 索引 1/2 → 字节 8..15 / 16..23。
 * 注意：BigInt64Array 索引 1 = 字节 8..15（Int32 索引 2..3）、索引 2 = 字节 16..23（Int32 4..5）；
 * 此前误用 2/4（= 字节 16..23 / 32..39）导致 dyAcc 与 V（Int32 8，字节 32..35）重叠——
 * 主线程 addInput(dy≠0) 会污染 V、writeState 的 V++ 会破坏 dyAcc（屏闪根因，已修复）。 */
const B_DX_ACC = 1;
const B_DY_ACC = 2;
/** 输入槽：keysMask（Int32 覆盖写）。 */
const I_KEYS_MASK = 6;

/** 状态槽：V 版本号（Int32，Atomics.add 递增）。 */
const I_V = 8;

/** 双缓冲 S[2]：每槽 8 个 Float64（pos×3/vel×3/yaw/pitch）。槽 s 起始 Float64 索引。 */
const F_SLOT_BASE = 5;
const F_SLOT_STRIDE = 8;
/** 槽内字段相对偏移（Float64 索引）。 */
const F_POS_X = 0;
const F_POS_Y = 1;
const F_POS_Z = 2;
const F_VEL_X = 3;
const F_VEL_Y = 4;
const F_VEL_Z = 5;
const F_YAW = 6;
const F_PITCH = 7;

/** 定点缩放：鼠标增量 ×1000 存 BigInt64（与 game ts-shared 一致）。 */
const FIXED_SCALE = 1000;

/** SAB 总字节数（布局实际使用至 168B，对齐取 192B）。 */
export const SHARED_BUFFER_SIZE = 192;

// ── 数据结构 ────────────────────────────────────────────────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** WorkerA 写入 / WorkerB 采样的完整状态。 */
export interface SharedStateData {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  /** 读取到的版本号。 */
  v: number;
}

/** WorkerA consumeInput 返回的输入样本。 */
export interface InputSample {
  dx: number;
  dy: number;
  keysMask: number;
}

/**
 * 共享内存通道（SAB 直连，无 MsgState 回退——test 仅 HTTP 运行，
 * serve.py 带 COOP/COEP，SharedArrayBuffer 恒定可用）。
 */
export class TestShared {
  private readonly i32: Int32Array;
  private readonly b64: BigInt64Array;
  private readonly f64: Float64Array;
  /** readState 上次见到的版本号（acquire 读 V 比对，未变返回 null）。 */
  private lastV = 0;

  private constructor(buffer: SharedArrayBuffer) {
    this.i32 = new Int32Array(buffer);
    this.b64 = new BigInt64Array(buffer);
    this.f64 = new Float64Array(buffer);
  }

  /** 包装既有 SAB（Worker 侧收到 init-shared 后调用）。 */
  static init(buffer: SharedArrayBuffer): TestShared {
    return new TestShared(buffer);
  }

  /**
   * 暴露 SAB（WorkerA 背压 wait/阶段1 wake 与阶段0 store 共用同一缓冲区）。
   */
  get sab(): SharedArrayBuffer {
    return this.i32.buffer as SharedArrayBuffer;
  }

  /** 主线程创建：包装 SAB 并 postMessage 给 WorkerA（SAB 共享传递，**不可放 transfer list**）。 */
  static create(buffer: SharedArrayBuffer, worker: Worker): TestShared {
    const s = new TestShared(buffer);
    worker.postMessage({ type: 'init-shared', shared: buffer });
    return s;
  }

  // ── 控制区（主线程写 / WorkerA 读）──────────────────────────

  /**
   * 阶段0 动态难度调节：仅 store 新 TICK_RATE（无 notify）。
   * 唤醒职责已移交 WAKEUP 槽（阶段1 wake），WorkerA 背压不再挂起在 TICK_RATE 上。
   */
  writeTickRate(rate: number): void {
    Atomics.store(this.i32, I_TICK_RATE, rate);
  }

  /** 读当前 TICK_RATE（WorkerA 每轮循环 / WorkerB 抽帧间隔计算）。 */
  readTickRate(): number {
    return Atomics.load(this.i32, I_TICK_RATE);
  }

  /**
   * 阶段1 唤醒 WorkerA：store(WAKEUP,1) + notify(WAKEUP,1)。
   * WorkerA 背压 waitWakeup 挂起在 WAKEUP 槽（值为 0）上，本调用使其立即返回。
   */
  wake(): void {
    Atomics.store(this.i32, I_WAKEUP, 1);
    Atomics.notify(this.i32, I_WAKEUP, 1);
  }

  /**
   * WorkerA 背压：wait(WAKEUP, 0, timeoutMs) 挂起（可被阶段1 wake 提前唤醒），
   * 返回后无论结果一律 store(WAKEUP,0) 复位（时序图：挂起 → 复位）。
   * @returns 是否被唤醒（'ok' 或 'not-equal'）；超时返回 false。
   */
  waitWakeup(timeoutMs: number): boolean {
    const res = Atomics.wait(this.i32, I_WAKEUP, 0, timeoutMs);
    Atomics.store(this.i32, I_WAKEUP, 0);
    return res === 'ok' || res === 'not-equal';
  }

  // ── 输入槽（主线程累加写 / WorkerA CAS 消费）──────────────────

  /** 写入累积鼠标增量（BigInt64 原子累加）+ 当前键位掩码（store 覆盖）。 */
  addInput(dx: number, dy: number, keysMask: number): void {
    const dxFixed = BigInt(Math.round(dx * FIXED_SCALE));
    const dyFixed = BigInt(Math.round(dy * FIXED_SCALE));
    if (dxFixed !== 0n) Atomics.add(this.b64, B_DX_ACC, dxFixed);
    if (dyFixed !== 0n) Atomics.add(this.b64, B_DY_ACC, dyFixed);
    // 无条件写 keysMask（0 也写）：反映"当前按键状态"，松手即清零
    Atomics.store(this.i32, I_KEYS_MASK, keysMask);
  }

  /**
   * 消耗输入（WorkerA 每次 1ms 子步前调用）：CAS 清零累加器——
   * 读当前值 → Atomics.compareExchange 为 0 直到成功，返回累加增量。
   * @param maxDelta 可选限幅（调用方传入，如 ±1000 防穿墙）；缺省 Infinity = 不限幅。
   */
  consumeInput(maxDelta: number = Infinity): InputSample {
    const dxFixed = this.exchangeZero(this.b64, B_DX_ACC);
    const dyFixed = this.exchangeZero(this.b64, B_DY_ACC);
    let dx = Number(dxFixed) / FIXED_SCALE;
    let dy = Number(dyFixed) / FIXED_SCALE;
    if (maxDelta !== Infinity) {
      dx = Math.max(-maxDelta, Math.min(maxDelta, dx));
      dy = Math.max(-maxDelta, Math.min(maxDelta, dy));
    }
    return {
      dx,
      dy,
      keysMask: Atomics.load(this.i32, I_KEYS_MASK),
    };
  }

  /** CAS 清零：原子地"读出累加值并归零"，返回读出的增量。 */
  private exchangeZero(b: BigInt64Array, idx: number): bigint {
    let cur = Atomics.load(b, idx);
    for (;;) {
      const res = Atomics.compareExchange(b, idx, cur, 0n);
      if (res === cur) return cur;
      cur = res;
    }
  }

  // ── 状态槽双缓冲（WorkerA release 写 / WorkerB acquire 非阻塞读）──

  /**
   * WorkerA 写入状态：写"当前 V 的另一槽"（S[V&1 ^ 1]，不覆盖 WorkerB 正在读的 S[V&1]）
   * → Atomics.add(V, 1)（V 递增用 add，Reader 随即切到新槽）。
   * @returns 递增后的新版本号。
   */
  writeState(pos: Vec3, vel: Vec3, yaw: number, pitch: number): number {
    const v0 = Atomics.load(this.i32, I_V);
    const base = F_SLOT_BASE + ((v0 & 1) ^ 1) * F_SLOT_STRIDE; // 空闲槽（非读槽）
    const f = this.f64;
    f[base + F_POS_X] = pos.x;
    f[base + F_POS_Y] = pos.y;
    f[base + F_POS_Z] = pos.z;
    f[base + F_VEL_X] = vel.x;
    f[base + F_VEL_Y] = vel.y;
    f[base + F_VEL_Z] = vel.z;
    f[base + F_YAW] = yaw;
    f[base + F_PITCH] = pitch;
    return Atomics.add(this.i32, I_V, 1) + 1;
  }

  /**
   * 读取状态（WorkerB 收到 frame 消息时采样）：acquire 读 V，与上次相同返回 null（非阻塞）。
   * 否则读当前槽 S[V&1]（双缓冲切槽）。
   * 防撕裂：读 V 后一次性读全部字段，再重读 V 校验（double-check）——
   * 不一致说明写入方在字段读取期间推进了版本，以新版本重读一次（最多 2 次尝试，
   * 8 个 Float64 连续读远快于 1ms 物理子步，实测竞争几乎不可能命中）。
   */
  readState(): SharedStateData | null {
    const v0 = Atomics.load(this.i32, I_V);
    if (v0 === this.lastV) return null;
    const f = this.f64;
    let v = v0;
    let pos: Vec3 = { x: 0, y: 0, z: 0 };
    let vel: Vec3 = { x: 0, y: 0, z: 0 };
    let yaw = 0;
    let pitch = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const base = F_SLOT_BASE + (v & 1) * F_SLOT_STRIDE; // 当前槽 S[V&1]
      pos = { x: f[base + F_POS_X], y: f[base + F_POS_Y], z: f[base + F_POS_Z] };
      vel = { x: f[base + F_VEL_X], y: f[base + F_VEL_Y], z: f[base + F_VEL_Z] };
      yaw = f[base + F_YAW];
      pitch = f[base + F_PITCH];
      const v2 = Atomics.load(this.i32, I_V);
      if (v2 === v) break; // 字段读取期间版本未推进 → 一致
      v = v2; // 撕裂：改用新版本重读
    }
    this.lastV = v;
    return { pos, vel, yaw, pitch, v };
  }
}
