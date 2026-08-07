/**
 * 共享状态层 — 输入槽（主线程写）+ 权威帧双缓冲（Worker 写）。
 *
 * 架构（2026-08-07 v7 定案，用户核心思想）：
 * - **Worker = 权威帧计算器**：加载地图（物理碰撞）、独立模拟权威物理线
 *   （固定 64Hz tick，含碰撞/摩擦/重力），每 tick 输出**权威帧**
 *   （位置/朝向/速度/眼高/着地/时间戳）
 * - **主线程 = 渲染预测线**：全速物理+渲染；每帧读权威帧，
 *   用权威速度（考虑中途地图碰撞后的正确速度）外推校准渲染物理——
 *   位置不强制同步，速度渐进对齐
 * - 输入：主线程写 SAB 输入槽（keys/dx/dy），Worker takeInput 消费
 *   （权威帧模拟需要同输入）
 *
 * SAB 布局（512B）：
 *   Int32 控制区（字节 0-63）：
 *     [0] V_A      权威版本号（Worker release 递增；主线程 acquire 读）
 *     [1] I_KEYS   输入键位掩码（主线程 store / Worker load）
 *     [2] A_GROUND 权威 onGround（0/1）
 *     [3-15] 保留
 *   BigInt64 输入槽（字节 64-127，index 8-9）：
 *     [8] dxAcc  [9] dyAcc —— BigInt64 原子累加（主线程 add / Worker exchange）
 *   BigInt64 权威帧双缓冲（字节 128-415，index 16-35）：
 *     S_A[0] = 16..25（10 值）  S_A[1] = 26..35（10 值）
 *   每帧 10 值：posX/Y/Z(×100) yaw(×1000) pitch(×1000) velX/Y/Z(×100) eyeHeight(×100) timeMs(×1)
 *
 * 读写协议：
 * - Worker 写空闲槽 S_A[V_A&1] → release 递增 V_A
 * - 主线程读 S_A[(V_A-1)&1]（写者已离开的槽，无撕裂）
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
const I_KEYS = 1;
const I_A_GROUND = 2;

// BigInt64 输入槽
const B_DX_ACC = 8;
const B_DY_ACC = 9;

// BigInt64 权威帧双缓冲基址（每帧 10 值）
const B_A0 = 16;
const B_A1 = 26;

/** SAB 总字节（512B 布局，实际使用至 416B）。 */
export const SHARED_BUFFER_SIZE = 512;

/** 权威帧（Worker 独立物理计算，含碰撞；主线程速度校准源）。 */
export interface AuthFrame {
  pos: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  vel: { x: number; y: number; z: number };
  onGround: boolean;
  eyeHeight: number;
  /** 权威帧产生时刻（Worker performance.now()，ms）。 */
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

  /** 写入鼠标增量（BigInt64 原子累加）+ 键位（Worker 权威帧模拟消费）。 */
  addInput(dx: number, dy: number, keysMask: number): void {
    const dxFixed = BigInt(Math.round(dx * 1000));
    const dyFixed = BigInt(Math.round(dy * 1000));
    if (dxFixed !== 0n) Atomics.add(this.b64, B_DX_ACC, dxFixed);
    if (dyFixed !== 0n) Atomics.add(this.b64, B_DY_ACC, dyFixed);
    // 无条件写 keysMask（0 也写）：反映"当前按键状态"，松手即清零
    Atomics.store(this.i32, I_KEYS, keysMask);
  }

  /**
   * 读权威帧（双缓冲槽 (V_A-1)&1，无撕裂）。
   * @returns { frame, va } 权威帧 + 版本号；V_A=0（未开始）返回 null。
   */
  readAuthoritative(): { frame: AuthFrame; va: number } | null {
    const va = Atomics.load(this.i32, I_V_A);
    if (va === 0) return null;
    const slot = (va - 1) & 1; // 写者已离开的槽
    const b = this.b64;
    const base = slot === 0 ? B_A0 : B_A1;
    return {
      frame: {
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
        timeMs: Number(b[base + 9]),
      },
      va,
    };
  }

  // ── Worker 侧 ──────────────────────────────────────────────

  /**
   * 消耗输入（BigInt64 exchange 清空 + 饱和截断；maxStep 防穿墙）。
   * 仅 Worker 权威帧模拟调用。
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
   * Worker 写权威帧：写空闲槽 S_A[V_A&1] → release 递增 V_A。
   */
  writeAuthoritative(a: Omit<AuthFrame, 'onGround'>, onGround: boolean): number {
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
    b[base + 9] = BigInt(Math.round(a.timeMs));
    // 状态先于版本号可见（release）
    const va = Atomics.load(this.i32, I_V_A) + 1;
    this.i32[I_A_GROUND] = onGround ? 1 : 0;
    Atomics.store(this.i32, I_V_A, va);
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
