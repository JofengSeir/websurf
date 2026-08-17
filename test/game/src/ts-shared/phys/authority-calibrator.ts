/**
 * 权威校准四件套（公共化 v1）— correctFromAuthority / calibrateVelocity /
 * applyCollisionCorrection / resetTo + normalizeAngleDeg / computeAuthAccel。
 *
 * 由 game/debug 两端 renderer-main 收敛而来（debug 阶段 2 与 game 同构）：
 * - 渲染位置是最终真相：权威帧/碰撞事件不再回写渲染位置；一旦触发位置兜底，
 *   驳回该兜底并把权威（tick）位置强制跃迁到上一个渲染帧位置（矢量速度修正）
 * - 权威仅用于速度外推校准；碰撞事件等位置兜底全部改为“渲染→权威”反向同步
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
  /** 权威帧着地状态（P3-A2 摩擦灌入门控用）。 */
  onGround: boolean;
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

  /** 调试/验证：渲染→权威反向同步次数（含首帧/碰撞驳回/大偏差）。 */
  debugSyncCount = 0;
  /** 调试/验证：碰撞事件位置兜底驳回次数。 */
  debugCollisionRejectCount = 0;
  /** 调试/验证：最近一次反向同步时间戳（ms）。 */
  debugLastSyncAt = 0;

  constructor(private readonly deps: CalibratorDeps) {}

  /** 兜底处理冷却（ms）：大偏差反向同步后 63ms 内不再重复触发（用户要求 250→63）。 */
  static readonly SYNC_COOLDOWN_MS = 63;

  /**
   * 权威帧到达（A2）处理 —— **只读权威，绝不反写**（v7 定案，2026-08-08 修订）。
   *
   * Worker 是权威帧计算器（加载地图碰撞、独立固定步长模拟）；本方法仅记录
   * 权威帧（速度供外推校准、位置/角度供异常兜底）。
   *
   * **兜底方向（用户定调，2026-08-17 修订）**：渲染位置永远不被权威覆盖；
   * 任何位置兜底（首帧、碰撞事件、在途撤回）都“驳回”，改为把权威（tick）
   * 位置强制跃迁到上一个渲染帧位置，并用矢量计算修正权威速度（位置差/时间差）。
   * - 首次权威帧：同样不写回渲染，直接反向同步权威到渲染当前帧
   * - 触发条件（三条件 OR）：
   *   - 位置差 > 500 → **强制**同步（绝对异常，不看朝向）
   *   - 位置差 > 300 **且** 水平朝向一致（yaw 最小角差 ≤ 3° + 转动方向相同）→ 同步
   *   - 位置差 ≤ 300 但视角偏差 > 45° → 同步（位置接近但视角大幅分叉）
   * - 同步在途（syncInFlight）期间不再“撤回渲染”，而是按 63ms 冷却反复把权威
   *   拉回渲染，直到权威追平（dist < 300）
   * - 速度校准由 calibrateVelocity 在每个渲染帧执行（外推，位置不覆盖）
   */
  correctFromAuthority(): void {
    const phys = this.deps.getPhys();
    if (!phys) return;
    const auth = this.deps.readAuth();
    if (!auth || auth.va === this.lastVa) return;
    this.lastVa = auth.va;
    const f = auth.frame;
    this.curAuth = {
      pos: { ...f.pos },
      yaw: f.yaw,
      pitch: f.pitch,
      vel: { ...f.vel },
      accel: this.computeAuthAccel(f.vel, f.timeMs),
      eyeHeight: f.eyeHeight,
      onGround: f.onGround,
      timeMs: f.timeMs,
    };

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

    // 首次权威帧（或重载后）：同样遵循“渲染位置不被权威覆盖”——
    // 不把权威状态写回渲染，而是把权威位置跃迁到渲染当前帧位置。
    if (!this.predStarted) {
      this.predStarted = true;
      this.prevRenderYaw = st.yaw;
      this.prevAuthYaw = f.yaw;
      this.syncInFlight = true;
      this.lastSyncAt = performance.now();
      this.pushRenderToAuthority(st);
      return;
    }

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
      // 不再“撤回渲染到权威”：位置兜底一律驳回，保持渲染不动。
      // 若权威在同步在途期间再次大幅分叉，则按 63ms 冷却再次把权威拉到渲染位置，
      // 直到权威真正收敛（dist < 300 且 yaw ≤ 45°）。
      if (dist > 500 || yawDiff > 45) {
        if (now - this.lastSyncAt >= AuthorityCalibrator.SYNC_COOLDOWN_MS) {
          this.pushRenderToAuthority(st);
          this.lastSyncAt = now;
        }
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
      // 大偏差反向同步：以渲染为准，强制权威位置跃迁到上一个渲染帧位置；
      // 速度由 pushRenderToAuthority 做矢量修正（位置差 / 时间差）。
      this.pushRenderToAuthority(st);
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
   * 位置兜底“驳回”入口：渲染帧位置是最终真相，任何权威位置兜底都不再回写渲染。
   * 这里把权威（tick）位置强制跃迁到上一个渲染帧位置，并用矢量计算修正权威速度
   * （速度获取/损失 = 位置差 / 时间差），不进行物理碰撞检测。
   */
  private pushRenderToAuthority(st: {
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
  }): void {
    const a = this.curAuth;
    let vx = st.velX;
    let vy = st.velY;
    let vz = st.velZ;
    if (a) {
      // 矢量计算：位置差 / 时间差作为速度修正（获取或损失），叠加到权威原速度上。
      // 时间差下限 1/128s、上限 0.25s，避免暂停恢复/异常时间戳产生荒谬修正。
      const rawDt = (performance.now() - a.timeMs) / 1000;
      const dt = Math.min(Math.max(rawDt, 1 / 128), 0.25);
      const k = 1 / dt;
      vx = a.vel.x + (st.posX - a.pos.x) * k;
      vy = a.vel.y + (st.posY - a.pos.y) * k;
      vz = a.vel.z + (st.posZ - a.pos.z) * k;
      // 与 computeAuthAccel 一致的钳制，防止大偏差同步产生荒谬速度。
      const clampV = (v: number): number => Math.max(-20000, Math.min(20000, v));
      vx = clampV(vx);
      vy = clampV(vy);
      vz = clampV(vz);
    }
    this.deps.onSyncRenderState?.({
      posX: st.posX,
      posY: st.posY,
      posZ: st.posZ,
      yaw: st.yaw,
      pitch: st.pitch,
      velX: vx,
      velY: vy,
      velZ: vz,
      onGround: st.onGround,
      eyeHeight: st.eyeHeight,
    });
    // 同步瞬间清主线程待喂输入（旧增量不注入新状态）
    this.deps.clearPendingInput();
    this.debugSyncCount++;
    this.debugLastSyncAt = performance.now();
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
   *
   * 时间口径：直接比较 Worker 与主线程的 performance.now()（HR-Time 同 time origin）。
   * 旧环境若存在常数偏移，会被下方 dt≤0 / dt>0.1s 分支兜底为直接注入原始权威速度，
   * 只造成轻微相位差，不累积错误（timing-game-analysis §4 风险4）。
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
    // P3-A1（坡底速度规律归零根治，精确判定）：权威已落地（进入摩擦域）而渲染线
    // 仍在坡上滑行（surfing=true，渲染线 144Hz 相位超前，尚未落地）→ 跳过灌入。
    // 权威摩擦会把仍在坡上的渲染线速度“规律归零”；跳过让渲染线自己演化到落地
    // （相位差 <1 tick 自然收敛）；仅权威 grounded 才查询渲染状态——飞行热路径
    // （权威空中）零额外 state() 分配。
    if (a.onGround) {
      const st = phys.state() as { surfing: boolean };
      if (st.surfing === true) return;
    }
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
   * 权威碰撞事件 → 位置兜底“驳回”：不再把权威位置写回渲染。
   * 若碰撞事件本会把渲染位置拉向权威，这里改为把权威位置强制跃迁到
   * 渲染当前（上一个渲染帧）位置，并由 pushRenderToAuthority 做矢量速度修正。
   * - land：保留原“接近着地才处理”的 P3 门限；通过后驳回并反向同步权威。
   * - blocked：距离 < 60 即驳回并反向同步权威。
   * 距离 ≥ 60 跳过（不触发兜底）。
   */
  applyCollisionCorrection(
    kind: 'land' | 'blocked',
    pos: number[],
    _yawDeg: number,
    _pitchDeg: number,
    _vel?: number[],
  ): void {
    const phys = this.deps.getPhys();
    if (!phys) return;
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
    const dist = Math.hypot(st.posX - pos[0], st.posY - pos[1], st.posZ - pos[2]);
    if (dist >= 60) return;
    if (kind === 'land') {
      // P3 辅修（land snap 门限收紧）：渲染线还在坡上 surfing（空中）被硬吸到
      // 坡底落地点是"坡底规律归零"的另一来源。仅当渲染线接近着地
      // （已落地或垂直速度已收敛 <100 u/s）才应用；否则跳过，
      // 让渲染线跟随自身物理演化到落地（权威帧速度校准照常收敛）。
      if (!st.onGround && Math.abs(st.velY) >= 100) return;
    }
    // 驳回权威→渲染的位置替换：保持渲染不动，把权威拉到渲染位置
    this.debugCollisionRejectCount++;
    this.syncInFlight = true;
    this.lastSyncAt = performance.now();
    this.pushRenderToAuthority(st);
  }
}
