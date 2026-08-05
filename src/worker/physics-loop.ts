/**
 * Worker 侧物理循环（渲染搬回主线程后，Worker 只保留密集物理计算）。
 *
 * 对应重构时序图阶段二（Worker 隔离区）：
 * - 收到主线程 `frame` 信号（携带主线程时间戳 t）→ 计算 dt
 * - 从共享内存读取输入（鼠标增量 + 按键位掩码）→ 应用到视角/移动
 * - 固定步长（默认 1/128s，最多 MAX_FIXED_STEPS 步/帧）执行 PlayerController.tick
 * - 结果写入共享内存输出区（加写锁 + seq 版本号），供主线程安全读取 + LERP
 *
 * 渲染相关（相机/LOD/PVS/雾/准星/碰撞箱可视化）全部移出，由主线程 RendererMain 承担。
 */

import { applyConfigPatch } from '../config.js';
import type { RuntimeConfig } from '../config.js';
import type { PlayerController } from '../physics/player/PlayerController.js';
import type { KeyState } from '../worker/worker-types.js';
import { SharedState, maskToKeys } from '../worker/shared-state.js';

/** 度 → 弧度。 */
const DEG2RAD = Math.PI / 180;
/** cs-movement m_yaw（deg/count）。 */
const M_YAW = 0.022;
/** pitch 限位（度）。 */
const PITCH_CLAMP_DEG = 89;
/** 默认物理固定步长（64Hz，跟随 config.physics.tickRate；构造时以配置为准）。 */
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

/** noclip 模式临时视角/位置（player 未创建或 noclip 模式使用）。 */
interface NoclipView {
  yaw: number;
  pitch: number;
  pos: { x: number; y: number; z: number };
}

/**
 * Worker 物理循环。
 */
export class PhysicsLoop {
  /** 物理后回调（传送检测/游戏状态/周期 stats，由 Worker 设置）。 */
  onAfterPhysics: ((dt: number, didPhysicsTick: boolean) => void) | null = null;

  private playerController: PlayerController | null = null;
  private physicsMode: 'noclip' | 'physics' = 'noclip';
  private fixedDt = FIXED_DT;
  private moveAccumulator = 0;
  private lastFrameT = 0;
  private keys: KeyState = emptyKeys();
  private readonly noclipView: NoclipView = { yaw: 0, pitch: 0, pos: { x: 0, y: 0, z: 0 } };
  /** 输出快照版本号。 */
  private seq = 0;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly shared: SharedState,
  ) {
    // 物理固定步长跟随 config.physics.tickRate（默认 64Hz；面板可调 48-128）
    if (config.physics.tickRate > 0) {
      this.fixedDt = 1 / config.physics.tickRate;
    }
  }

  // ── 生命周期 / 配置 ─────────────────────────────────────────

  /** 设置玩家控制器（physics 模式必需）。 */
  setPlayerController(player: PlayerController | null): void {
    this.playerController = player;
  }

  /** 设置物理模式（noclip ↔ physics），并双向同步视角/位置权威源。 */
  setPhysicsMode(mode: 'noclip' | 'physics'): void {
    if (this.physicsMode === mode) return;
    if (this.playerController) {
      if (mode === 'noclip') {
        // physics → noclip：noclipView 继承 player（noclip 后视角/位置写入 noclipView）
        this.noclipView.yaw = this.playerController.yaw;
        this.noclipView.pitch = this.playerController.pitch;
        this.noclipView.pos = { ...this.playerController.origin };
      } else {
        // noclip → physics：player 继承 noclipView（保持自由飞行后的位置/朝向）
        this.playerController.yaw = this.noclipView.yaw;
        this.playerController.pitch = this.noclipView.pitch;
        this.playerController.origin = { ...this.noclipView.pos };
      }
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
    if (section === 'input' && this.playerController) {
      // 同步 sensitivity 到 player.settings（cs-movement 模型）
      this.playerController.settings.sensitivity = this.config.input.sensitivity;
    } else if (section === 'physics') {
      this.setPhysicsMode(this.config.physics.mode);
    }
  }

  /** 统一设置视角（度）：同时更新 noclipView 与 player（若存在），并立即写一帧输出。 */
  setView(yawDeg: number, pitchDeg: number): void {
    this.noclipView.yaw = yawDeg;
    this.noclipView.pitch = pitchDeg;
    if (this.playerController) {
      this.playerController.yaw = yawDeg;
      this.playerController.pitch = pitchDeg;
    }
    this.writeFrame();
  }

  /** 传送/出生后调用：清空累积器（避免大 dt 补步）。 */
  onTeleport(): void {
    this.moveAccumulator = 0;
  }

  /** 立即写一帧共享输出（传送/模式切换/出生等外部变更后调用）。 */
  writeFrame(): void {
    this.writeFrameInternal();
  }

  /** 物理模式只读（stats 回传用）。 */
  getPhysicsMode(): 'noclip' | 'physics' {
    return this.physicsMode;
  }

  /** noclip 模式位置/视角只读（stats / 模式切换 / 传送对齐用）。 */
  getNoclipState(): { pos: { x: number; y: number; z: number }; yaw: number; pitch: number } {
    return {
      pos: { ...this.noclipView.pos },
      yaw: this.noclipView.yaw,
      pitch: this.noclipView.pitch,
    };
  }

  /** 设置 noclip 位置（传送对齐用，noclip 模式下相机位置权威源在 Worker）。 */
  setNoclipPos(pos: { x: number; y: number; z: number }): void {
    this.noclipView.pos = { ...pos };
  }

  // ── 帧驱动（阶段二）────────────────────────────────────────

  /**
   * 收到主线程 frame 触发信号：读共享输入环形缓冲（批量聚合）→
   * 固定步长物理 → 写共享输出。
   *
   * dt 由 Worker 侧 performance.now() 计算——Worker 与主线程共享同一
   * performance 时钟源，快照 timeMs 与主线程渲染时刻可比，LERP 插值基准不变。
   * M2 Worker 自驱循环落地后，本方法即成为自驱 tick 本体，frame 信号废弃。
   */
  frame(): void {
    const now = performance.now();
    const dt = this.lastFrameT === 0 ? 0 : Math.min((now - this.lastFrameT) / 1000, 0.1);
    this.lastFrameT = now;

    // 读输入（阶段二步骤 6：批量取 [head, tail) 聚合——增量求和保留，防视角跳变）
    const input = this.shared.takeInput();
    this.keys = maskToKeys(input.keysMask);
    this.applyMouseDelta(input.dx, input.dy);

    // 固定步长推进
    this.moveAccumulator += dt;
    this.moveAccumulator = Math.min(this.moveAccumulator, this.fixedDt * MAX_FIXED_STEPS);
    let didPhysicsTick = false;
    while (this.moveAccumulator >= this.fixedDt) {
      this.moveAccumulator -= this.fixedDt;
      this.stepFixed(this.fixedDt);
      didPhysicsTick = true;
    }

    // 写共享输出（阶段二步骤 8：临界区写锁保护）
    this.writeFrame();

    // 物理后回调：传送检测 / 游戏状态 / 周期 stats
    if (this.onAfterPhysics) {
      this.onAfterPhysics(dt, didPhysicsTick);
    }
  }

  /** 单个固定步长：Q/E 旋转 → 移动（physics / noclip）。 */
  private stepFixed(dt: number): void {
    // Q/E 键 yaw 旋转（turn bind）：写入当前模式视角权威源
    const yawDir = (this.keys.yawRight ? 1 : 0) - (this.keys.yawLeft ? 1 : 0);
    if (yawDir !== 0) {
      const yawDelta = yawDir * this.config.input.yawBindSpeed * dt;
      if (this.physicsMode === 'physics' && this.playerController) {
        this.playerController.yaw -= yawDelta;
      } else {
        this.noclipView.yaw -= yawDelta;
      }
    }

    if (this.physicsMode === 'physics' && this.playerController) {
      this.syncPlayerInput();
      this.playerController.tick(dt);
    } else {
      // noclip 模式：自由飞行（方向由 noclipView 视角计算，无相机依赖）
      this.noclipStep(dt);
    }
  }

  /** 将 KeyState 映射到 PlayerController.input（cs-movement 契约）。 */
  private syncPlayerInput(): void {
    const p = this.playerController;
    if (!p) return;
    const inp = p.input;
    inp.forward = this.keys.forward;
    inp.back = this.keys.backward;
    inp.left = this.keys.left;
    inp.right = this.keys.right;
    inp.jump = this.keys.jump;
    inp.duck = this.keys.duck;
    inp.walk = this.keys.sprint;
    inp.reset = this.keys.reset;
    // 滚轮连跳：wheelJump 为 true 时强制 input.jump = true（chasemod 风格）
    if (this.keys.wheelJump) {
      inp.jump = true;
    }
  }

  /**
   * noclip 模式单步移动。
   *
   * 与原 RenderLoop.noclipStep 等价（原实现用 camera.getWorldDirection /
   * quaternion；此处直接从 yaw/pitch 构造方向，YXZ 顺序数学一致）：
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

  /** 应用鼠标增量到当前视角（cs-movement MouseInput.ts 公式忠实复刻）。 */
  private applyMouseDelta(dx: number, dy: number): void {
    const sens = this.effectiveSensitivity();
    // 写入当前模式视角权威源：physics = player；noclip = noclipView
    // （writeFrame 读取同一来源，保证视角数据不丢）
    if (this.physicsMode === 'physics' && this.playerController) {
      this.playerController.yaw -= dx * sens;
      this.playerController.pitch -= dy * sens;
      this.playerController.pitch = Math.max(
        -PITCH_CLAMP_DEG,
        Math.min(PITCH_CLAMP_DEG, this.playerController.pitch),
      );
    } else {
      this.noclipView.yaw -= dx * sens;
      this.noclipView.pitch -= dy * sens;
      this.noclipView.pitch = Math.max(
        -PITCH_CLAMP_DEG,
        Math.min(PITCH_CLAMP_DEG, this.noclipView.pitch),
      );
    }
  }

  /** 有效灵敏度 = sensitivity * m_yaw（cs-movement MouseInput.ts 公式）。 */
  private effectiveSensitivity(): number {
    if (this.playerController) {
      return (
        this.playerController.settings.sensitivity *
        this.playerController.settings.mYaw
      );
    }
    return (this.config.input.sensitivity ?? 1.5) * M_YAW;
  }

  // ── 共享输出（阶段二步骤 8）────────────────────────────────

  /** 从当前 player/noclip 状态写共享内存输出区。 */
  private writeFrameInternal(): void {
    // 数据源选择：physics 模式 = player（origin 每帧更新）；noclip 模式 = noclipView
    // （noclipStep 只更新 noclipView.pos，player.origin 不随自由飞行移动）。
    const inPhysics = this.physicsMode === 'physics' && this.playerController;
    let pos: { x: number; y: number; z: number };
    let yaw: number;
    let pitch: number;
    let vel: { x: number; y: number; z: number };
    let onGround: boolean;
    let eyeHeight: number;

    if (inPhysics && this.playerController) {
      const p = this.playerController;
      pos = p.origin;
      yaw = p.yaw;
      pitch = p.pitch;
      vel = p.velocity;
      onGround = p.onGround;
      eyeHeight = p.eyeHeight;
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
