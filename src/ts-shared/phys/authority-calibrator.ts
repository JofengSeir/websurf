/**
 * 权威校准四件套（公共化 v1）— correctFromAuthority / calibrateVelocity /
 * applyCollisionCorrection / resetTo + normalizeAngleDeg / computeAuthAccel。
 *
 * 由 game/debug 两端 renderer-main 收敛而来（debug 阶段 2 与 game 同构）：
 * - 只读权威（readAuth），绝不反写；权威仅速度外推校准 + 碰撞事件（phys-event）
 *   时可影响渲染（位置微调 + 角度同步）
 * - 兜底方向（用户定调）：渲染主线（144Hz 预测物理）精度高于权威（64Hz +
 *   消息延迟），大偏差时**以渲染主线为准反向同步权威**——同步内容 = 渲染主线
 *   帧那一刻的完整状态，同步瞬间清空主线程与权威侧未消费的鼠标/按键增量
 *   （onSyncRenderState 回调 → Worker sync-render-state；权威侧 resetInput）
 *
 * 抽象：主线程渲染物理（PhysWorldLike 子集）与 pending 输入清空经 deps 注入，
 * 两端 RendererMain 仅保留"喂入/喂出"接线。
 */

import type { AuthFrame } from '../auth/shared-state.js';

/** 主线程渲染物理（PhysWorld 结构性接口子集）。 */
export interface CalibratorPhys {
  state(): unknown;
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
  set_velocity(x: number, y: number, z: number): void;
}

/** 渲染主线 → 权威同步的全状态（app.ts 注册后发 sync-render-state 消息）。 */
export interface SyncRenderState {
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
}

export interface CalibratorDeps {
  readAuth(): { frame: AuthFrame; va: number } | null;
  getPhys(): CalibratorPhys | null;
  /** 清空待喂输入（pendingDx/Dy/Keys；同步瞬间的旧增量不注入新状态）。 */
  clearPendingInput(): void;
  onSyncRenderState?(s: SyncRenderState): void;
}

/** 权威帧快照（A2；速度外推校准依据）。 */
interface AuthSnap {
  pos: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  vel: { x: number; y: number; z: number };
  /** 权威最近加速度（两权威帧速度差 / tick；外推校准用）。 */
  accel: { x: number; y: number; z: number };
  eyeHeight: number;
  /** 权威帧产生时刻（tick 结束时刻，ms）。 */
  timeMs: number;
}

/** 角度归一化到 (-180, 180]：最小角差/旋转方向判断用（350° vs 0° → 10°）。 */
export function normalizeAngleDeg(a: number): number {
  return ((a + 180) % 360 + 360) % 360 - 180;
}

export class AuthorityCalibrator {
  private lastVa = -1;
  private curAuth: AuthSnap | null = null;
  private prevAuthVel: { x: number; y: number; z: number } | null = null;
  private prevAuthTimeMs = 0;
  /** 上次记录时的渲染物理 yaw / 权威 yaw（水平转动方向判断用）。 */
  private prevRenderYaw = 0;
  private prevAuthYaw = 0;
  /** 渲染主线 → 权威同步在途（防权威追平前重复触发）。 */
  private syncInFlight = false;
  /** 上次兜底处理时间戳（同步或撤回；冷却内不重复处理）。 */
  private lastSyncAt = 0;
  /** 主线程渲染物理是否已用首个权威帧校准起点。 */
  private predStarted = false;
  /**
   * 传送/重置后的权威豁免截止时间戳（performance.now()，ms）。
   *
   * 位置突变（respawn/teleport/noclip/检查点回退）的瞬间，权威 Worker 侧仍是
   * 旧位置；若不豁免，`correctFromAuthority` 会把已突变的位置当"分叉（dist>500）"
   * 或"首个权威帧"用权威旧位置覆盖回去 → 视觉上"传送/重置没生效"。
   * 豁免期内：只读权威速度供外推，绝不覆盖渲染物理位置；并把主线程新状态
   * 同步给 Worker（onSyncRenderState），让权威侧追平到新位置。
   */
  private teleportExemptUntilMs = 0;

  constructor(private readonly deps: CalibratorDeps) {}

  /** 兜底处理冷却（ms）：同步/撤回后 250ms 内不再触发，防抖（用户调 2s→250ms）。 */
  static readonly SYNC_COOLDOWN_MS = 250;

  /** 传送/重置后权威豁免时长（ms）：约 12 个 64Hz 权威帧窗口，足够权威追平新位置。 */
  static readonly TELEPORT_EXEMPT_MS = 200;

  /**
   * 权威帧到达（A2）处理 —— **只读权威，绝不反写**（v7 定案，2026-08-08 修订）。
   *
   * Worker 是权威帧计算器（加载地图碰撞、独立固定步长模拟）；本方法仅记录
   * 权威帧（速度供外推校准、位置/角度供异常兜底）。
   *
   * **兜底方向（用户定调）**：渲染主线（144Hz 预测物理）精度高于权威
   * （64Hz + 消息延迟），大偏差时**以渲染主线为准反向同步权威**——
   * 同步内容 = 渲染主线帧那一刻的完整状态（位置/角度/速度/着地/眼高），
   * 同步瞬间清空主线程与权威侧未消费的鼠标/按键增量
   * （onSyncRenderState 回调 → Worker；权威侧 resetInput）。
   * - 首次权威帧（或重载后）：仍以权威全状态作为渲染物理起点（无渲染历史）
   * - 触发条件（三条件 OR）：
   *   - 位置差 > 500 → **强制**同步（绝对异常，不看朝向）
   *   - 位置差 > 300 **且** 水平朝向一致（yaw 最小角差 ≤ 3° + 转动方向相同）→ 同步
   *   - 位置差 ≤ 300 但视角偏差 > 45° → 同步（位置接近但视角大幅分叉）
   * - 同步在途（syncInFlight）期间不重复触发，直到权威追平（dist < 300）
   * - 速度校准由 calibrateVelocity 在每个渲染帧执行（外推，位置不覆盖）
   */
  correctFromAuthority(): void {
    const phys = this.deps.getPhys();
    if (!phys) return;
    const auth = this.deps.readAuth();
    if (!auth) return;

    // ── 传送/重置豁免期：位置刚突变，权威侧仍可能是旧位置 ──
    // 绝不把权威旧位置覆盖到渲染物理（覆盖 = 传送被拉回）。只刷新权威速度供
    // calibrateVelocity 外推；同时把渲染物理当前（新）状态同步给权威 Worker，
    // 让权威在豁免窗口内追平，避免豁免结束后首次权威帧（predStarted 已置位）
    // 因 dist 过大再被 fallback 逻辑拉回。
    if (performance.now() < this.teleportExemptUntilMs) {
      // 记录权威帧（供 calibrateVelocity 外推速度），但不覆盖渲染位置
      this.lastVa = auth.va;
      const f = auth.frame;
      this.curAuth = {
        pos: { ...f.pos },
        yaw: f.yaw,
        pitch: f.pitch,
        vel: { ...f.vel },
        accel: this.computeAuthAccel(f.vel, f.timeMs),
        eyeHeight: f.eyeHeight,
        timeMs: f.timeMs,
      };
      // 主线程新状态 → 权威（覆盖旧位置，防止权威帧把它当起点/分叉拉回）
      const st = phys.state() as {
        posX: number; posY: number; posZ: number;
        yaw: number; pitch: number;
        velX: number; velY: number; velZ: number;
        onGround: boolean; eyeHeight: number;
      };
      this.deps.onSyncRenderState?.({
        posX: st.posX, posY: st.posY, posZ: st.posZ,
        yaw: st.yaw, pitch: st.pitch,
        velX: st.velX, velY: st.velY, velZ: st.velZ,
        onGround: st.onGround, eyeHeight: st.eyeHeight,
      });
      // 视为主线程已校准起点，避免豁免结束后权威帧再 set_state 旧位置
      this.predStarted = true;
      return;
    }

    if (auth.va === this.lastVa) return;
    this.lastVa = auth.va;
    const f = auth.frame;
    this.curAuth = {
      pos: { ...f.pos },
      yaw: f.yaw,
      pitch: f.pitch,
      vel: { ...f.vel },
      accel: this.computeAuthAccel(f.vel, f.timeMs),
      eyeHeight: f.eyeHeight,
      timeMs: f.timeMs,
    };

    // 首次权威帧（或重载后）：以权威全状态作为渲染物理起点
    if (!this.predStarted) {
      this.predStarted = true;
      phys.set_state(f.pos.x, f.pos.y, f.pos.z, f.yaw, f.pitch, f.vel.x, f.vel.y, f.vel.z, f.onGround);
      this.prevRenderYaw = f.yaw;
      this.prevAuthYaw = f.yaw;
      return;
    }

    const st = phys.state() as {
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
    const dist = Math.hypot(st.posX - f.pos.x, st.posY - f.pos.y, st.posZ - f.pos.z);

    // 水平转动方向（本权威帧间隔内；正负 = 转向，0 = 静止）
    const renderTurn = Math.sign(normalizeAngleDeg(st.yaw - this.prevRenderYaw));
    const authTurn = Math.sign(normalizeAngleDeg(f.yaw - this.prevAuthYaw));
    this.prevRenderYaw = st.yaw;
    this.prevAuthYaw = f.yaw;

    const yawDiff = Math.abs(normalizeAngleDeg(st.yaw - f.yaw));
    const now = performance.now();

    // 权威已追平（同步在途结束）：位置 < 300 且视角 ≤ 45° 视为收敛
    if (this.syncInFlight && dist < 300 && yawDiff <= 45) {
      this.syncInFlight = false;
    }
    if (this.syncInFlight) {
      // 撤回监视：同步在途但再次大幅分叉（dist > 500 或 yaw > 45°）——
      // 说明渲染侧在漂移/上次"渲染为准"的方向错误 → **撤回兜底**：
      // 以权威为准回滚渲染（权威保持自己的演化，不再盲从渲染）。
      if (dist > 500 || yawDiff > 45) {
        phys.set_state(f.pos.x, f.pos.y, f.pos.z, f.yaw, f.pitch, f.vel.x, f.vel.y, f.vel.z, f.onGround);
        this.deps.clearPendingInput();
        this.syncInFlight = false;
        this.lastSyncAt = now;
        this.prevRenderYaw = f.yaw;
        this.prevAuthYaw = f.yaw;
      }
      return;
    }

    // 冷却：同步/撤回后冷却期内不重复兜底处理（防抖；正常游玩快速甩视角
    // 或短暂分叉不会反复触发）
    if (now - this.lastSyncAt < AuthorityCalibrator.SYNC_COOLDOWN_MS) return;

    // 兜底判定（用户定调 2026-08-08，三条件 OR）：
    // ① 位置差 > 500 → 强制同步（绝对异常，不看朝向）
    // ② 位置差 > 300 且朝向一致（yaw 最小角差 ≤ 3° + 转动方向相同）→ 同步
    // ③ 位置差 ≤ 300 但视角偏差 > 45° → 同步（位置接近但视角大幅分叉；
    //    45° 为高阈值——正常快速甩视角 3 帧内不会超过 45°（144Hz × 3 ≈ 21ms，
    //    需 >2100°/s 才可能），只有双端视角真分叉才触发）
    const sameTurn = renderTurn === 0 || authTurn === 0 || renderTurn === authTurn;
    const shouldSync =
      dist > 500 ||
      (dist > 300 && yawDiff <= 3 && sameTurn) ||
      (dist <= 300 && yawDiff > 45);
    if (shouldSync) {
      this.syncInFlight = true;
      this.lastSyncAt = now;
      this.deps.onSyncRenderState?.({
        posX: st.posX, posY: st.posY, posZ: st.posZ,
        yaw: st.yaw, pitch: st.pitch,
        velX: st.velX, velY: st.velY, velZ: st.velZ,
        onGround: st.onGround,
        eyeHeight: st.eyeHeight,
      });
      // 清主线程待喂输入（同步瞬间的旧增量不注入新状态）
      this.deps.clearPendingInput();
    }
  }

  /** 权威加速度 = 两权威帧速度差 / 帧间隔（u/s²）；首帧/间隔异常 → 0。 */
  private computeAuthAccel(
    vel: { x: number; y: number; z: number },
    timeMs: number,
  ): { x: number; y: number; z: number } {
    const prev = this.prevAuthVel;
    const prevT = this.prevAuthTimeMs;
    this.prevAuthVel = { ...vel };
    this.prevAuthTimeMs = timeMs;
    if (!prev || prevT <= 0) return { x: 0, y: 0, z: 0 };
    const dt = (timeMs - prevT) / 1000;
    if (dt < 0.001 || dt > 0.5) return { x: 0, y: 0, z: 0 };
    // clamp ±20000（重力 800；碰撞瞬间速度跳变可能巨大，防外推爆炸）
    const clamp = (v: number): number => Math.max(-20000, Math.min(20000, v));
    return {
      x: clamp((vel.x - prev.x) / dt),
      y: clamp((vel.y - prev.y) / dt),
      z: clamp((vel.z - prev.z) / dt),
    };
  }

  /**
   * 逐帧速度校准（每个渲染帧、tick 之前）—— 权威速度外推反馈。
   *
   * Worker 权威帧速度已考虑中途地图物理碰撞（卡坡/穿墙/落地）→ 用它修正
   * 渲染物理速度，让渲染轨迹向权威对齐。权威帧到达滞后（64Hz vs 渲染帧）：
   *   vel_target = vel_A + a × (t_now − t_A)
   * a = 权威最近加速度；动态帧距（拿到权威帧的那一帧自动适配）。
   * 垂直落体实测：锯齿 5.54≈理论 5.56，滞后偏差消除。
   *
   * **角度不校准**（用户定调）：权威帧不得影响渲染帧角度——角度由渲染物理
   * 自己输入驱动（鼠标 + Q/E，144Hz 高精度），Q/E 速度等输入参数立即生效；
   * 权威仅在碰撞事件（phys-event）时才可影响角度（见 applyCollisionCorrection）。
   */
  calibrateVelocity(now: number): void {
    const phys = this.deps.getPhys();
    if (!phys || !this.curAuth) return;
    const a = this.curAuth;
    const dt = (now - a.timeMs) / 1000; // 权威帧产生 → 当前渲染帧（动态帧距）
    let v = a.vel;
    if (dt > 0 && dt <= 0.1) {
      v = {
        x: a.vel.x + a.accel.x * dt,
        y: a.vel.y + a.accel.y * dt,
        z: a.vel.z + a.accel.z * dt,
      };
    }
    // dt<=0（时间戳异常）或 >0.1s（权威停更/暂停恢复）→ 直接用权威速度，不外推防漂移
    phys.set_velocity(v.x, v.y, v.z);
  }

  /**
   * 位置突变归零（显式重置允许覆盖：respawn/teleport/noclip 切换/检查点回退）。
   * 清空权威校准状态，防止旧权威帧把突变位置拉回。
   */
  resetTo(pos: number[], yawDeg: number, pitchDeg = 0): void {
    const phys = this.deps.getPhys();
    if (!phys) return;
    phys.set_state(pos[0], pos[1], pos[2], yawDeg, pitchDeg, 0, 0, 0, true);
    // 清待喂输入，防突变后残留方向/跳跃
    this.deps.clearPendingInput();
    this.clear();
    // 传送/重置后设置权威豁免窗口：期间权威旧位置不得覆盖渲染物理，
    // 并把主线程新位置同步给 Worker（由 correctFromAuthority 中豁免分支执行）。
    this.teleportExemptUntilMs = performance.now() + AuthorityCalibrator.TELEPORT_EXEMPT_MS;
  }

  /** 清空全部权威校准状态（disposeScene / buildPredictionWorld 跨地图重置用）。 */
  clear(): void {
    this.prevAuthVel = null;
    this.prevAuthTimeMs = 0;
    this.prevRenderYaw = 0;
    this.prevAuthYaw = 0;
    this.syncInFlight = false;
    this.lastSyncAt = 0;
    this.predStarted = false;
    this.curAuth = null;
    this.lastVa = -1;
  }

  /**
   * 权威碰撞事件 → 位置微调 + 角度同步（用户定调：权威**仅在碰撞判断时**可影响
   * 渲染角度）。渲染物理与权威物理的碰撞相位差（64 vs 144Hz）导致落地/撞墙瞬间
   * 位置差几 units——权威碰撞结果回传一次，微调渲染位置让碰撞视觉对齐；
   * 角度取权威（碰撞瞬间的权威朝向，玩家注意力在碰撞上，小角度差无感）。
   * - land：权威全状态（落地瞬间速度已碰撞处理，权威为准）
   * - blocked：仅位置/角度（速度保留渲染侧，由逐帧校准收敛）
   * 距离 < 60 才调整；≥ 60 跳过防视觉跳变（异常场景仍由权威帧兜底处理）。
   */
  applyCollisionCorrection(
    kind: 'land' | 'blocked',
    pos: number[],
    yawDeg: number,
    pitchDeg: number,
    vel?: number[],
  ): void {
    const phys = this.deps.getPhys();
    if (!phys) return;
    const st = phys.state() as {
      posX: number;
      posY: number;
      posZ: number;
      velX: number;
      velY: number;
      velZ: number;
      onGround: boolean;
    };
    const dist = Math.hypot(st.posX - pos[0], st.posY - pos[1], st.posZ - pos[2]);
    if (dist >= 60) return;
    if (kind === 'land') {
      // 权威落地全状态：位置 + 角度 + **权威碰撞速度** + 着地 true（落地瞬间已碰撞处理）
      const vx = vel?.[0] ?? st.velX;
      const vy = vel?.[1] ?? st.velY;
      const vz = vel?.[2] ?? st.velZ;
      phys.set_state(pos[0], pos[1], pos[2], yawDeg, pitchDeg, vx, vy, vz, true);
    } else {
      // 撞墙：位置/角度取权威，速度保留渲染侧（由逐帧校准收敛——碰撞后方向由
      // 渲染物理自身演化，避免权威速度注入造成视觉抖动）
      phys.set_state(pos[0], pos[1], pos[2], yawDeg, pitchDeg, st.velX, st.velY, st.velZ, st.onGround);
    }
  }
}
