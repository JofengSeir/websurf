/**
 * Worker 侧物理循环（物理已迁移到共享 Rust 物理 websurf-phys）。
 *
 * 对应重构时序图阶段二（Worker 隔离区）：
 * - 收到主线程 `frame` 信号 → 计算 dt
 * - 从共享内存读取输入（鼠标增量 + 按键位掩码）→ 应用到视角/移动
 * - 固定步长（默认 1/64s，最多 MAX_FIXED_STEPS 步/帧）执行 PhysWorld.tick
 * - 结果写入共享内存输出区（加写锁 + seq 版本号），供主线程安全读取 + LERP
 *
 * 输入链路（与 game 输入层语义一致）：
 * - 鼠标增量在 TS 侧乘灵敏度（config.input.sensitivity），Rust 端 sensitivity 固定 1，
 *   yaw -= dx × (1 × M_YAW)；Q/E 生成等效像素量（yaw_bind_speed/M_YAW × dt）并入 dx，
 *   独立增量不受灵敏度影响
 * - noclip 模式保持 TS 侧自由飞行（noclipView），不进入 Rust 物理
 */

import { applyConfigPatch } from '../config.js';
import type { RuntimeConfig } from '../config.js';
import type { KeyState } from '../worker/worker-types.js';
import { SharedState, maskToKeys, keysToMask } from '../worker/shared-state.js';
import type { PhysWorld } from '../../pkg/websurf_wasm.js';

/** 度 → 弧度。 */
const DEG2RAD = Math.PI / 180;
/** cs-movement m_yaw（deg/count，Rust player.rs M_YAW）。 */
const M_YAW = 0.022;
/** pitch 限位（度）。 */
const PITCH_CLAMP_DEG = 89;
/** 默认物理固定步长（64Hz，构造时以 config.physics.tickRate 为准）。 */
const FIXED_DT = 1 / 64;
/** 每帧最多固定步数（低帧率保护）。 */
const MAX_FIXED_STEPS = 10;

/** 空按键状态。 */
function emptyKeys(): KeyState {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    duck: false,
    sprint: false,
    reset: false,
    wheelJump: false,
    yawLeft: false,
    yawRight: false,
  };
}

/** noclip 模式临时视角/位置（noclip 时使用，物理模式时同步回 Rust）。 */
interface NoclipView {
  yaw: number;
  pitch: number;
  pos: { x: number; y: number; z: number };
}

/** Worker 物理循环。 */
export class PhysicsLoop {
  /** 物理后回调（游戏状态/周期 stats）。 */
  onAfterPhysics: ((dt: number, didPhysicsTick: boolean) => void) | null = null;

  private phys: PhysWorld | null = null;
  private physicsMode: 'noclip' | 'physics' = 'noclip';
  private fixedDt = FIXED_DT;
  private moveAccumulator = 0;
  private lastFrameT = 0;
  private keys: KeyState = emptyKeys();
  private readonly noclipView: NoclipView = { yaw: 0, pitch: 0, pos: { x: 0, y: 0, z: 0 } };
  /** 输出快照版本号。 */
  private seq = 0;
  /** 本帧是否首次固定步（鼠标增量仅首步应用，Q/E 每步计入）。 */
  private firstStep = true;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly shared: SharedState,
  ) {
    // 固定步长跟随 config.physics.tickRate（默认 64Hz；面板可调 48-128）
    if (config.physics.tickRate > 0) {
      this.fixedDt = 1 / config.physics.tickRate;
    }
  }

  // ── 生命周期 / 配置 ─────────────────────────────────────────

  /** 绑定 Rust 物理世界（physics 模式必需）。 */
  setPhysWorld(phys: PhysWorld | null): void {
    this.phys = phys;
  }

  /** 设置物理模式（noclip ↔ physics），并双向同步视角/位置权威源。 */
  setPhysicsMode(mode: 'noclip' | 'physics'): void {
    if (this.physicsMode === mode) return;
    if (mode === 'noclip') {
      // physics → noclip：noclipView 继承 Rust player
      const s = this.phys?.state();
      if (s) {
        this.noclipView.yaw = s.yaw;
        this.noclipView.pitch = s.pitch;
        this.noclipView.pos = { x: s.posX, y: s.posY, z: s.posZ };
      }
    } else if (this.phys) {
      // noclip → physics：Rust player 继承 noclipView（保持自由飞行后的位置/朝向）
      this.phys.set_state(
        this.noclipView.pos.x,
        this.noclipView.pos.y,
        this.noclipView.pos.z,
        this.noclipView.yaw,
        this.noclipView.pitch,
        0,
        0,
        0,
        false,
      );
    }
    this.physicsMode = mode;
    // 切换后立即写一帧共享输出（主线程相机立即反映）
    this.writeFrame();
  }

  /** 设置物理固定步长（tickRate Hz）。 */
  setTickRate(rate: number): void {
    this.fixedDt = 1 / Math.max(rate, 1);
  }

  /** 应用配置 patch（config 消息转发）。 */
  applyConfigPatch(section: keyof RuntimeConfig, patch: Record<string, unknown>): void {
    applyConfigPatch(this.config, section, patch);
    if (section === 'physics') {
      this.setPhysicsMode(this.config.physics.mode);
    }
  }

  /** 统一设置视角（度）：noclip 更新 noclipView；physics 同步到 Rust（保留 pitch）。 */
  setView(yawDeg: number, pitchDeg: number): void {
    this.noclipView.yaw = yawDeg;
    this.noclipView.pitch = pitchDeg;
    if (this.physicsMode === 'physics' && this.phys) {
      this.phys.set_yaw_pitch(yawDeg, pitchDeg);
    }
    this.writeFrame();
  }

  /** 传送/出生后调用：清空累积器（避免大 dt 补步）。 */
  onTeleport(): void {
    this.moveAccumulator = 0;
  }

  /** 立即写一帧共享输出（传送/模式切换/出生后调用）。 */
  writeFrame(): void {
    this.writeFrameInternal();
  }

  /** 物理模式只读（stats 回传用）。 */
  getPhysicsMode(): 'noclip' | 'physics' {
    return this.physicsMode;
  }

  /** noclip 模式位置/视角只读（stats/模式切换/传送对齐用）。 */
  getNoclipState(): { pos: { x: number; y: number; z: number }; yaw: number; pitch: number } {
    return {
      pos: { ...this.noclipView.pos },
      yaw: this.noclipView.yaw,
      pitch: this.noclipView.pitch,
    };
  }

  /** 设置 noclip 位置（传送对齐用；noclip 模式下位置权威源在 Worker）。 */
  setNoclipPos(pos: { x: number; y: number; z: number }): void {
    this.noclipView.pos = { ...pos };
  }

  // ── 帧驱动 ──────────────────────────────────────────────────

  /**
   * 收到主线程 frame 触发信号：读共享输入环形缓冲（批量聚合）→
   * 固定步长物理 → 写共享输出。
   */
  frame(): void {
    const now = performance.now();
    const dt = this.lastFrameT === 0 ? 0 : Math.min((now - this.lastFrameT) / 1000, 0.1);
    this.lastFrameT = now;

    // 读输入：批量取 [head, tail) 聚合（增量求和保留，防视角跳变）
    const input = this.shared.takeInput();
    this.keys = maskToKeys(input.keysMask);

    // 鼠标增量（像素）→ 乘灵敏度（角度增量）；Rust 端 sensitivity 固定 1，内部乘 M_YAW。
    // 每帧应用一次（与旧 applyMouseDelta 同语义），Q/E 在每步内按等效像素并入。
    const sens = this.config.input.sensitivity ?? 1.5;
    const frameDx = input.dx * sens;
    const frameDy = input.dy * sens;

    // 固定步长推进
    this.moveAccumulator += dt;
    this.moveAccumulator = Math.min(this.moveAccumulator, this.fixedDt * MAX_FIXED_STEPS);
    let didPhysicsTick = false;
    this.firstStep = true;
    while (this.moveAccumulator >= this.fixedDt) {
      this.moveAccumulator -= this.fixedDt;
      this.stepFixed(this.fixedDt, frameDx, frameDy);
      didPhysicsTick = true;
    }

    // noclip 模式：鼠标增量应用到 noclipView（physics 模式已并入 Rust tick）
    if (this.physicsMode !== 'physics') {
      this.applyNoclipMouseDelta(input.dx, input.dy);
    }

    // 写共享输出（临界区写锁保护）
    this.writeFrame();

    // 物理后回调：游戏状态 / 周期 stats
    if (this.onAfterPhysics) {
      this.onAfterPhysics(dt, didPhysicsTick);
    }
  }

  /** 单个固定步长：Q/E 旋转 → 移动（physics / noclip）。 */
  private stepFixed(dt: number, frameDx: number, frameDy: number): void {
    if (this.physicsMode === 'physics' && this.phys) {
      // Q/E 等效像素量（独立增量不受灵敏度影响）：yaw_bind_speed/M_YAW × dt
      const yawDir = (this.keys.yawRight ? 1 : 0) - (this.keys.yawLeft ? 1 : 0);
      const qePx = yawDir * (this.config.input.yawBindSpeed * dt) / M_YAW;
      const keysMask = keysToMask(this.keys);
      // 鼠标增量仅首步应用（每帧一次），Q/E 每步计入
      const dx = this.firstStep ? frameDx + qePx : qePx;
      const dy = this.firstStep ? frameDy : 0;
      this.firstStep = false;
      this.phys.tick(dt, keysMask, dx, dy);
    } else {
      // noclip 模式：自由飞行（方向由 noclipView 视角计算，无相机依赖）
      this.noclipStep(dt);
    }
  }

  /**
   * noclip 模式单步移动。
   *
   * 与原 RenderLoop.noclipStep 等价（原实现用相机 quaternion；此处直接从
   * yaw/pitch 构造方向，YXZ 顺序数学一致）：
   *   forward = (−sinYaw·cosPitch, sinPitch, −cosYaw·cosPitch)
   *   right   = (cosYaw, 0, −sinYaw)
   */
  private noclipStep(dt: number): void {
    const k = this.keys;
    const forward = (k.forward ? 1 : 0) - (k.backward ? 1 : 0);
    const strafe = (k.right ? 1 : 0) - (k.left ? 1 : 0);
    if (forward === 0 && strafe === 0) return;

    const speed =
      this.config.movement.speed *
      (k.sprint ? this.config.movement.sprintMultiplier : 1) *
      dt;

    const yawRad = this.noclipView.yaw * DEG2RAD;
    const pitchRad = this.noclipView.pitch * DEG2RAD;
    const cp = Math.cos(pitchRad);
    const sp = Math.sin(pitchRad);
    const cy = Math.cos(yawRad);
    const sy = Math.sin(yawRad);

    const fwdX = -sy * cp;
    const fwdY = sp;
    const fwdZ = -cy * cp;
    const rightX = cy;
    const rightZ = -sy;

    this.noclipView.pos.x += (fwdX * forward + rightX * strafe) * speed;
    this.noclipView.pos.y += fwdY * forward * speed;
    this.noclipView.pos.z += (fwdZ * forward + rightZ * strafe) * speed;
  }

  /** noclip 模式应用鼠标增量到 noclipView（原 applyMouseDelta 保留逻辑）。 */
  private applyNoclipMouseDelta(dx: number, dy: number): void {
    const sens = (this.config.input.sensitivity ?? 1.5) * M_YAW;
    this.noclipView.yaw -= dx * sens;
    this.noclipView.pitch -= dy * sens;
    this.noclipView.pitch = Math.max(
      -PITCH_CLAMP_DEG,
      Math.min(PITCH_CLAMP_DEG, this.noclipView.pitch),
    );
  }

  // ── 共享输出 ─────────────────────────────────────────────────

  /** 从 Rust player / noclip 状态写共享内存输出区。 */
  private writeFrameInternal(): void {
    const inPhysics = this.physicsMode === 'physics' && this.phys;
    let pos: { x: number; y: number; z: number };
    let yaw: number;
    let pitch: number;
    let vel: { x: number; y: number; z: number };
    let onGround: boolean;
    let eyeHeight: number;

    if (inPhysics && this.phys) {
      const s = this.phys.state();
      pos = { x: s.posX, y: s.posY, z: s.posZ };
      yaw = s.yaw;
      pitch = s.pitch;
      vel = { x: s.velX, y: s.velY, z: s.velZ };
      onGround = s.onGround;
      eyeHeight = s.eyeHeight;
    } else {
      pos = this.noclipView.pos;
      yaw = this.noclipView.yaw;
      pitch = this.noclipView.pitch;
      vel = { x: 0, y: 0, z: 0 };
      onGround = false;
      eyeHeight = 0;
    }

    this.shared.writeFrame({
      pos: { ...pos },
      yaw,
      pitch,
      vel: { ...vel },
      onGround,
      mode: this.physicsMode,
      eyeHeight,
      timeMs: this.lastFrameT,
      seq: ++this.seq,
    });
  }
}
