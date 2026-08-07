/**
 * 共享状态层（终版）— 对齐 `docs/项目时序图.md` 终版审查结论。
 *
 * SAB 布局（512B）：
 *   Int32 控制区（字节 0-63）：
 *     [0]  V_A      权威版本号（Worker-A release 递增；主线程 acquire 读）
 *     [1]  gen_A    权威代际（Worker-A 每帧写 = V_A 高位，供预测代际校验）
 *     [2]  seq_P    预测序列号（代际复合 (gen<<16)|counter；Worker-B 写）
 *     [3]  gen_P    预测代际（Worker-B 发布时 = gen_A 快照）
 *     [4]  keys     输入位掩码（主线程 store / Worker load）
 *     [5]  A_GROUND 权威 onGround（0/1）
 *     [6]  P_GROUND 预测 onGround（0/1）
 *     [7-15] 保留
 *   BigInt64 输入槽（字节 64-127，index 8-15）：
 *     [8] dxAcc  [9] dyAcc  —— BigInt64 原子累加（V6 防溢出，永不 wrap）
 *   BigInt64 状态双缓冲（字节 128-415，index 16-51）：
 *     S_A[0] = 16..24（9 值）  S_A[1] = 25..33（9 值）   权威双缓冲（V2 防撕裂）
 *     S_P[0] = 34..42（9 值）  S_P[1] = 43..51（9 值）   预测双缓冲
 *   每状态 9 值：posX/Y/Z(×100) yaw(×1000) pitch(×1000) velX/Y/Z(×100) eyeHeight(×100)
 *
 * 版本号 → 双缓冲槽选择：
 * - 权威：Worker-A 写 S_A[V_A&1]，V_A++；主线程读 S_A[(V_A-1)&1]（写者已离开的槽）
 * - 预测：Worker-B 写 S_P[seq&1]，seq_P++；主线程读 S_P[(seq-1)&1]
 *
 * 代际校验（V3，废弃主线程清零）：
 * - Worker-B 发布预测携带 gen_P = gen_A 快照
 * - 主线程仅接受 gen_P == 当前 gen_A 的预测；不匹配 → 回退权威（不操作序列号）
 * - 主线程不再 store(seq_P, 0)（避免覆盖 Worker-B 新预测的竞争）
 */

import type { KeyState } from './worker-types.js';

// ── 按键位掩码（与 Rust KEY_MASK 一致）───────────────────────
export const KEY_MASK = {
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
} as const;

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

// ── SAB 布局 ─────────────────────────────────────────────────
// Int32 控制区
const I_V_A = 0;
const I_GEN_A = 1;
const I_SEQ_P = 2;
const I_GEN_P = 3;
const I_KEYS = 4;
const I_A_GROUND = 5;
const I_P_GROUND = 6;

// BigInt64 输入槽（index 8-9）
const B_DX_ACC = 8;
const B_DY_ACC = 9;

// BigInt64 状态双缓冲基址
const B_A0 = 16; // 权威 S_A[0]
const B_A1 = 25; // 权威 S_A[1]
const B_P0 = 34; // 预测 S_P[0]
const B_P1 = 43; // 预测 S_P[1]

/** SAB 总字节（512B，双缓冲 + BigInt64 输入）。 */
export const SHARED_BUFFER_SIZE = 512;

/** 状态快照（主线程三源决策产物）。 */
export interface PhysState {
  pos: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  vel: { x: number; y: number; z: number };
  onGround: boolean;
  eyeHeight: number;
  timeMs: number;
}

/** 输入样本（Worker takeInput 返回值）。 */
export interface InputSample {
  dx: number;
  dy: number;
  keysMask: number;
}

// ── 共享内存通道 ──────────────────────────────────────────────

export class ShmState {
  readonly isShared = true;
  private readonly i32: Int32Array;
  private readonly b64: BigInt64Array;
  private readonly buffer: SharedArrayBuffer;

  constructor(buffer: SharedArrayBuffer) {
    this.buffer = buffer;
    this.i32 = new Int32Array(buffer);
    this.b64 = new BigInt64Array(buffer);
  }

  /** 暴露底层 SAB（Worker-B 热待机 Atomics.wait 用）。 */
  bufferOf(): SharedArrayBuffer {
    return this.buffer;
  }

  /** notify 预测唤醒（主线程权威就绪后调用；目标 = V_A 槽）。 */
  notifyPrediction(): void {
    Atomics.notify(this.i32, I_V_A, 1);
  }

  // ── 主线程侧 ───────────────────────────────────────────────

  /** 写入鼠标增量（BigInt64 原子累加，V6 永不溢出）+ 键位。 */
  addInput(dx: number, dy: number, keysMask: number): void {
    const dxFixed = BigInt(Math.round(dx * 1000));
    const dyFixed = BigInt(Math.round(dy * 1000));
    if (dxFixed !== 0n) Atomics.add(this.b64, B_DX_ACC, dxFixed);
    if (dyFixed !== 0n) Atomics.add(this.b64, B_DY_ACC, dyFixed);
    // 无条件写 keysMask（0 也写）：反映"当前按键状态"，松手即清零，
    // 避免残留旧位导致 Worker 一直前进（松手停不下来）
    Atomics.store(this.i32, I_KEYS, keysMask);
  }

  /**
   * 三源决策路径 A：读权威（双缓冲槽 (V_A-1)&1，V2 无撕裂）。
   * @returns { state, va, gen } 权威状态 + 版本号 + 代际。
   */
  readAuthoritative(): { state: PhysState; va: number; gen: number } | null {
    const va = Atomics.load(this.i32, I_V_A);
    if (va === 0) return null;
    const slot = (va - 1) & 1; // 写者已离开的槽
    const state = this.readState(slot === 0 ? B_A0 : B_A1, slot === 0 ? I_A_GROUND : I_A_GROUND);
    return { state, va, gen: Atomics.load(this.i32, I_GEN_A) };
  }

  /**
   * 三源决策路径 B：读预测（双缓冲槽 (seq-1)&1，V2 无撕裂）。
   * @returns { state, seq, gen } 预测状态 + 序列号 + 预测代际。
   */
  readPredicted(): { state: PhysState; seq: number; gen: number } | null {
    const seq = Atomics.load(this.i32, I_SEQ_P);
    if (seq === 0) return null;
    const slot = (seq - 1) & 1;
    const state = this.readState(slot === 0 ? B_P0 : B_P1, I_P_GROUND);
    return { state, seq, gen: Atomics.load(this.i32, I_GEN_P) };
  }

  /** 当前权威代际（V3：主线程校验预测 gen_P == gen_A 用）。 */
  getGen(): number {
    return Atomics.load(this.i32, I_GEN_A);
  }

  /**
   * 废弃（V3）：不再由主线程清零预测序列号——改为代际校验。
   * 保留方法仅为兼容调用点，内部无操作。
   * @deprecated 代际校验已取代清零，调用处应改用 getGen() 校验。
   */
  clearPrediction(): void {
    // V3 修复：主线程清零会与 Worker-B 写新预测竞争，废弃。
  }

  private readState(base: number, groundIdx: number): PhysState {
    const b = this.b64;
    const i = this.i32;
    // 注意：BigInt 除法是整数除法（截断），定点解码必须用 Number 转换后除
    return {
      pos: {
        x: Number(b[base]) / 100,
        y: Number(b[base + 1]) / 100,
        z: Number(b[base + 2]) / 100,
      },
      yaw: Number(b[base + 3]) / 1000,
      pitch: Number(b[base + 4]) / 1000,
      vel: {
        x: Number(b[base + 5]) / 100,
        y: Number(b[base + 6]) / 100,
        z: Number(b[base + 7]) / 100,
      },
      onGround: i[groundIdx] === 1,
      eyeHeight: Number(b[base + 8]) / 100,
      timeMs: 0,
    };
  }

  // ── Worker-A 侧 ────────────────────────────────────────────

  /**
   * 消耗输入（BigInt64 exchange 清空 + 饱和截断；maxStep 防穿墙）。
   * 仅 Worker-A 调用。
   */
  takeInput(maxStep: number): InputSample {
    const dxFixed = Atomics.exchange(this.b64, B_DX_ACC, 0n);
    const dyFixed = Atomics.exchange(this.b64, B_DY_ACC, 0n);
    const maxStepFixed = BigInt(Math.round(maxStep * 1000));
    const dxAbs = dxFixed < 0n ? -dxFixed : dxFixed;
    const dyAbs = dyFixed < 0n ? -dyFixed : dyFixed;
    const dxClamped = dxAbs > maxStepFixed ? maxStepFixed : dxAbs;
    const dyClamped = dyAbs > maxStepFixed ? maxStepFixed : dyAbs;
    // 定点解码：Number 转换后除（BigInt 除法会截断）
    const dx = Number(dxFixed < 0n ? -dxClamped : dxClamped) / 1000;
    const dy = Number(dyFixed < 0n ? -dyClamped : dyClamped) / 1000;
    return { dx, dy, keysMask: Atomics.load(this.i32, I_KEYS) };
  }

  /**
   * 只读输入（Worker-B 预测用）——不 exchange，绝不与 Worker-A 抢输入。
   */
  readInput(): InputSample {
    const dxFixed = Atomics.load(this.b64, B_DX_ACC);
    const dyFixed = Atomics.load(this.b64, B_DY_ACC);
    return {
      dx: Number(dxFixed) / 1000,
      dy: Number(dyFixed) / 1000,
      keysMask: Atomics.load(this.i32, I_KEYS),
    };
  }

  /**
   * Worker-A 写权威：写空闲槽 S_A[V_A&1] → release 递增 V_A + gen_A。
   * V2：主线程按 (V_A-1)&1 读另一槽，绝对完整。
   */
  writeAuthoritative(s: PhysState, eyeHeight: number, onGround: boolean): number {
    const slot = Atomics.load(this.i32, I_V_A) & 1;
    const base = slot === 0 ? B_A0 : B_A1;
    const b = this.b64;
    b[base] = BigInt(Math.round(s.pos.x * 100));
    b[base + 1] = BigInt(Math.round(s.pos.y * 100));
    b[base + 2] = BigInt(Math.round(s.pos.z * 100));
    b[base + 3] = BigInt(Math.round(s.yaw * 1000));
    b[base + 4] = BigInt(Math.round(s.pitch * 1000));
    b[base + 5] = BigInt(Math.round(s.vel.x * 100));
    b[base + 6] = BigInt(Math.round(s.vel.y * 100));
    b[base + 7] = BigInt(Math.round(s.vel.z * 100));
    b[base + 8] = BigInt(Math.round(eyeHeight * 100));
    this.i32[I_A_GROUND] = onGround ? 1 : 0;
    // 状态先于版本号可见（release）
    const va = Atomics.load(this.i32, I_V_A) + 1;
    Atomics.store(this.i32, I_V_A, va);
    Atomics.store(this.i32, I_GEN_A, va);
    return va;
  }

  // ── Worker-B 侧 ────────────────────────────────────────────

  /**
   * Worker-B 写预测：写空闲槽 S_P[seq&1] → release 递增 seq_P + 写 gen_P。
   * V3：gen_P 携带预测基于的权威代际，主线程据此校验。
   */
  writePredicted(s: PhysState, genA: number, counter: number): number {
    const seq = Atomics.load(this.i32, I_SEQ_P);
    const slot = seq & 1;
    const base = slot === 0 ? B_P0 : B_P1;
    const b = this.b64;
    b[base] = BigInt(Math.round(s.pos.x * 100));
    b[base + 1] = BigInt(Math.round(s.pos.y * 100));
    b[base + 2] = BigInt(Math.round(s.pos.z * 100));
    b[base + 3] = BigInt(Math.round(s.yaw * 1000));
    b[base + 4] = BigInt(Math.round(s.pitch * 1000));
    b[base + 5] = BigInt(Math.round(s.vel.x * 100));
    b[base + 6] = BigInt(Math.round(s.vel.y * 100));
    b[base + 7] = BigInt(Math.round(s.vel.z * 100));
    b[base + 8] = BigInt(Math.round(s.eyeHeight * 100));
    this.i32[I_P_GROUND] = s.onGround ? 1 : 0;
    // 代际复合序列号 + 预测代际（V3）
    const newSeq = ((genA & 0xffff) << 16) | (counter & 0xffff);
    Atomics.store(this.i32, I_SEQ_P, newSeq);
    Atomics.store(this.i32, I_GEN_P, genA);
    return newSeq;
  }

  /** 读当前权威版本号（Worker-B 基线快照用）。 */
  getVa(): number {
    return Atomics.load(this.i32, I_V_A);
  }
}

/** 主线程侧创建（SAB 强制）。 */
export function createMainSharedState(buffer: SharedArrayBuffer): ShmState {
  return new ShmState(buffer);
}

/** Worker 侧创建。 */
export function createWorkerSharedState(buffer: SharedArrayBuffer): ShmState {
  return new ShmState(buffer);
}
