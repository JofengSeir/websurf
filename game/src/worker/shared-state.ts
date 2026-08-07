/**
 * 共享状态层 — 权威全状态（客户端预测修正源）。
 *
 * 架构（2026-08-07 v4.1）：主线程持 wasm 预测实例（每帧 predict 物理模拟），
 * Worker-A 权威 tick 后写**全状态**（含位置）到 SAB，主线程用 set_state 修正
 * 预测基线（标准客户端预测：本地模拟即时响应，权威定期纠偏）。
 *
 * SAB 布局（512B）：
 *   Int32 控制区（字节 0-63）：
 *     [0] V_A      权威版本号（Worker-A release 递增；主线程 acquire 读）
 *     [1] gen_A    权威代际（= V_A）
 *     [2] keys     输入位掩码（主线程 store / Worker load）
 *     [3] A_GROUND 权威 onGround（0/1）
 *     [4-15] 保留
 *   BigInt64 输入槽（字节 64-127，index 8-9）：
 *     [8] dxAcc  [9] dyAcc  —— BigInt64 原子累加（防溢出，永不 wrap）
 *   BigInt64 权威状态双缓冲（字节 128-415，index 16-33）：
 *     S_A[0] = 16..24（9 值）  S_A[1] = 25..33（9 值）
 *   每状态 9 值：posX/Y/Z(×100) yaw(×1000) pitch(×1000) velX/Y/Z(×100) eyeHeight(×100)
 *
 * 读写协议：
 * - Worker-A 写空闲槽 S_A[V_A&1] → release 递增 V_A + gen_A
 * - 主线程读 S_A[(V_A-1)&1]（写者已离开的槽，无撕裂）→ set_state 修正预测实例
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
const I_V_A = 0;
const I_GEN_A = 1;
const I_KEYS = 2;
const I_A_GROUND = 3;

// BigInt64 输入槽
const B_DX_ACC = 8;
const B_DY_ACC = 9;

// BigInt64 权威状态双缓冲基址（每槽 9 值）
const B_A0 = 16;
const B_A1 = 25;

/** SAB 总字节（512B 布局，实际使用至 416B）。 */
export const SHARED_BUFFER_SIZE = 512;

/** 权威全状态（客户端预测修正源；含位置）。 */
export interface AuthState {
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

  // ── 主线程侧 ───────────────────────────────────────────────

  /** 写入鼠标增量（BigInt64 原子累加）+ 键位。 */
  addInput(dx: number, dy: number, keysMask: number): void {
    const dxFixed = BigInt(Math.round(dx * 1000));
    const dyFixed = BigInt(Math.round(dy * 1000));
    if (dxFixed !== 0n) Atomics.add(this.b64, B_DX_ACC, dxFixed);
    if (dyFixed !== 0n) Atomics.add(this.b64, B_DY_ACC, dyFixed);
    // 无条件写 keysMask（0 也写）：反映"当前按键状态"，松手即清零
    Atomics.store(this.i32, I_KEYS, keysMask);
  }

  /**
   * 读权威全状态（双缓冲槽 (V_A-1)&1，无撕裂）。
   * @returns { state, va, gen } 权威状态 + 版本号 + 代际。
   */
  readAuthoritative(): { state: AuthState; va: number; gen: number } | null {
    const va = Atomics.load(this.i32, I_V_A);
    if (va === 0) return null;
    const slot = (va - 1) & 1; // 写者已离开的槽
    const b = this.b64;
    const base = slot === 0 ? B_A0 : B_A1;
    return {
      state: {
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
        eyeHeight: Number(b[base + 8]) / 100,
        onGround: this.i32[I_A_GROUND] === 1,
        timeMs: 0,
      },
      va,
      gen: Atomics.load(this.i32, I_GEN_A),
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
   * Worker-A 写权威全状态：写空闲槽 S_A[V_A&1] → release 递增 V_A + gen_A。
   * 全状态（含位置）——主线程预测实例据此 set_state 修正基线。
   */
  writeAuthoritative(a: Omit<AuthState, 'onGround'>, onGround: boolean): number {
    const slot = Atomics.load(this.i32, I_V_A) & 1;
    const base = slot === 0 ? B_A0 : B_A1;
    const b = this.b64;
    b[base] = BigInt(Math.round(a.pos.x * 100));
    b[base + 1] = BigInt(Math.round(a.pos.y * 100));
    b[base + 2] = BigInt(Math.round(a.pos.z * 100));
    b[base + 3] = BigInt(Math.round(a.yaw * 1000));
    b[base + 4] = BigInt(Math.round(a.pitch * 1000));
    b[base + 5] = BigInt(Math.round(a.vel.x * 100));
    b[base + 6] = BigInt(Math.round(a.vel.y * 100));
    b[base + 7] = BigInt(Math.round(a.vel.z * 100));
    b[base + 8] = BigInt(Math.round(a.eyeHeight * 100));
    // 状态先于版本号可见（release）
    const va = Atomics.load(this.i32, I_V_A) + 1;
    this.i32[I_A_GROUND] = onGround ? 1 : 0;
    Atomics.store(this.i32, I_V_A, va);
    Atomics.store(this.i32, I_GEN_A, va);
    return va;
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

