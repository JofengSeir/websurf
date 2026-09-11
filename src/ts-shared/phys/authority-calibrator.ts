/**
 * 权威校准四件套（公共化 v1）— correctFromAuthority / calibrateVelocity /
 * applyCollisionCorrection / resetTo + normalizeAngleDeg / computeAuthAccel。
 *
 * 由 game/debug 两端 renderer-main 收敛而来（debug 阶段 2 与 game 同构）：
 * - 只读权威（readAuth），绝不反写；权威对渲染的**唯一**影响是速度（`calibrateVelocity`
 *   逐帧 + `land` 事件瞬间，R2）与 `land` 事件里的 `onGround=true`（**仅当渲染自己
 *   已着地**——腾空时的权威 land 事件是双线相位差，写了会让渲染半空重新起跳，见
 *   `applyCollisionCorrection` 修复 B）
 * - **没有任何位置/角度通道**（缺陷修复 C，2026-09-11）：`applyCollisionCorrection`
 *   曾用 `phys.set_state(投影点, 权威 yaw/pitch, …)` 把渲染沿来路拖回最多 60 HU 并
 *   注入滞后朝向——那是渲染折线上 24 处方向反转（实测最狠 171° 回头）与"神秘碰撞"
 *   的根因；位置写与角度写已**全部删除**（见该方法头）。
 * - 兜底方向（用户定调）：渲染主线（144Hz 预测物理）精度高于权威（64Hz +
 *   消息延迟），大偏差时**以渲染主线为准反向同步权威**——同步内容 = 渲染主线
 *   帧那一刻的完整状态，同步瞬间清空主线程与权威侧未消费的鼠标/按键增量
 *   （onSyncRenderState 回调 → Worker sync-render-state；权威侧 resetInput）。
 *   **另有 routine 反向重锚**（缺陷修复 A）：常规游玩中定期把渲染当前状态
 *   重锚到权威，使权威的碰撞解算发生在玩家真正所在的位置（见 ROUTINE_ANCHOR_*）。
 *
 * 抽象：主线程渲染物理（PhysWorldLike 子集）与 pending 输入清空经 deps 注入，
 * 两端 RendererMain 仅保留"喂入/喂出"接线。
 *
 * ── 位置投影时代的口径修正（本次修订）───────────────────────────────
 * Worker 侧权威**发布**的位置不再是权威物理自身的位置，而是
 * `env.renderTrajectory.sampleAtTau(τ)` 在**渲染折线上**取的一个采样点
 * （auth-loop `stepPhysics` 耦合支路；权威自持物理只有**速度**还是主）。
 * 后果：
 * ① 兜底的 `dist`（发布位置 vs 渲染位置）恒 ≈ v × 发布延迟（1300 HU/s 下
 *    ≈0–26 HU），永远到不了旧的 300/500 阈值 → 旧条件①②（dist>500、
 *    dist>300 且同向）**恒不成立**，已删除（保留会误导后来者）；
 * ② 旧条件③（dist ≤ 300 ∧ yawDiff > 45）退化成**只看 yaw**，而权威 yaw
 *    天生滞后渲染 yaw 一个 tick 的未消费鼠标增量（>~2900°/s 的快速甩视角就能
 *    触发），触发即 clearPendingInput() 丢掉**当帧鼠标增量** = 可见瞄准顿挫 →
 *    已改为「渲染 yaw 连续 N 帧静止仍分叉」判据（见 YAW_FAULT_FRAMES）。
 * 位置类硬约束不变：**渲染位置永不被本类的任何逻辑校正**——`correctFromAuthority`
 * 只把渲染状态**推给权威**（单向），`applyCollisionCorrection` 只写速度/着地。
 * 渲染位置发生变化只可能来自两条**显式**路径：`resetTo`（respawn/传送/检查点回退，
 * 用户主动的位置突变）与渲染物理自身 tick 的碰撞解算。
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

/**
 * 渲染物理全状态（`CalibratorPhys.state()` 的结构性视图）。
 * 与 `SyncRenderState` 同字段——`state()` 返回 `unknown`，本类内部统一 cast 到它。
 */
export type SyncPhysState = SyncRenderState;

export interface CalibratorDeps {
  readAuth(): { frame: AuthFrame; va: number } | null;
  getPhys(): CalibratorPhys | null;
  /** 清空待喂输入（pendingDx/Dy/Keys；同步瞬间的旧增量不注入新状态）。 */
  clearPendingInput(): void;
  /**
   * 渲染主线全状态 → 权威（app.ts 注册后发 `sync-render-state` 消息；Worker 侧
   * `set_state`）。
   *
   * @param teleport true = **真位置突变**（传送/重生/换图，`teleportExemptUntilMs`
   *   窗口内）——Worker 侧允许清未消费输入增量（旧增量对新位置无意义）；
   *   false = **常规反向重锚**（缺陷修复 A，`routineReanchor`）——Worker 侧必须
   *   **保留**输入增量，否则每几十毫秒丢一次鼠标增量 = 可见瞄准顿挫。
   */
  onSyncRenderState?(s: SyncRenderState, teleport: boolean): void;
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

// ── 解耦消费外推（phys-mode-port §3.5 T7'，additive）──────────────

/** 外推输入帧（结构化最小面：AuthFrame / AuthSnap 均满足）。 */
export interface ExtrapolatableFrame {
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  eyeHeight: number;
  /** 权威帧产生时刻（ms）。 */
  timeMs: number;
}

/** 外推输出位姿（相机直用；角度保持度数，renderer 统一 DEG2RAD）。 */
export interface ExtrapolatedPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  eyeHeight: number;
}

/** 解耦模式权威外推上限（ms）：超过视为权威线停滞，冻结在最后一帧位置
 * （防权威线卡死时幽灵漂移；phys-mode-port §3.5 T7' 冻结值 250）。 */
export const EXTRAP_MAX_MS = 250;

/**
 * 解耦消费外推纯函数（§3.5 冻结：位置 = 权威帧位置 + 权威速度 × dt 线性一阶，
 * 无加速度项——加速度项吸收自耦合线 computeAuthAccel 差分口径，作为常量开关
 * 留 t5 验收后评估启用；角度/眼高直读权威帧——权威帧已含全部输入语义）。
 * 耦合模式的 calibrateVelocity 算式由此改向承接（终审③：外推数学复用，
 * 反向同步链废弃——解耦语义 = 权威拉渲染单向，不回写权威）。
 */
export function extrapolateAuthPose(frame: ExtrapolatableFrame, nowMs: number): ExtrapolatedPose {
  const dtS = Math.max(0, Math.min(EXTRAP_MAX_MS, nowMs - frame.timeMs)) / 1000;
  return {
    x: frame.pos.x + frame.vel.x * dtS,
    y: frame.pos.y + frame.vel.y * dtS,
    z: frame.pos.z + frame.vel.z * dtS,
    yaw: frame.yaw,
    pitch: frame.pitch,
    eyeHeight: frame.eyeHeight,
  };
}

export class AuthorityCalibrator {
  private lastVa = -1;
  private curAuth: AuthSnap | null = null;
  private prevAuthVel: { x: number; y: number; z: number } | null = null;
  private prevAuthTimeMs = 0;
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
   * 旧位置；若不豁免，`correctFromAuthority` 的首帧分支会用权威旧位置覆盖回去
   * → 视觉上"传送/重置没生效"（位置类兜底条件已删除，但首帧起点校准仍在）。
   * 豁免期内：只读权威速度供外推，绝不覆盖渲染物理位置；并把主线程新状态
   * 同步给 Worker（onSyncRenderState），让权威侧追平到新位置。
   */
  private teleportExemptUntilMs = 0;

  constructor(private readonly deps: CalibratorDeps) {}

  /** 兜底处理冷却（ms）：同步/撤回后 250ms 内不再触发，防抖（用户调 2s→250ms）。 */
  static readonly SYNC_COOLDOWN_MS = 250;

  /**
   * 主线程读到当前权威帧的时刻（`performance.now()`，同线程时钟）。
   * `calibrateVelocity` 用 `now - authArrivedAtMs` 作为帧龄做加速度外推；
   * 不能用 `AuthFrame.timeMs`（跨线程时钟基准不同，实测固定偏移 ≈1132ms）。
   */
  private authArrivedAtMs = 0;

  // ── 条件③（yaw 分叉）故障判据状态 ─────────────────────────────
  /** 上一条权威帧时刻的渲染 yaw（判「渲染 yaw 是否已静止」用）。 */
  private prevFrameRenderYaw = 0;
  /** 渲染 yaw 连续静止、且与权威 yaw 分叉 > 阈值的权威帧计数。 */
  private yawDivergedFrames = 0;

  /** 条件③判定：yaw 分叉必须**连续**这么多条权威帧都满足才视为故障（≈8×15.6ms≈125ms）。 */
  static readonly YAW_FAULT_FRAMES = 8;
  /** 条件③阈值：yaw 最小角差（度）超过它才算分叉（沿用旧 45°）。 */
  static readonly YAW_FAULT_DEG = 45;
  /** 「渲染 yaw 已静止」判据：相邻权威帧之间渲染 yaw 变化 < 本值（度）≈ 无横向输入。 */
  static readonly YAW_STILL_DEG = 1;

  /** 残差位置校正已按用户硬约束移除（不得影响渲染响应）；保留占位说明见文件内注释。 */

  /** 传送/重置后权威豁免时长（ms）：约 12 个 64Hz 权威帧窗口，足够权威追平新位置。 */
  static readonly TELEPORT_EXEMPT_MS = 200;

  // ── 常规反向重锚（缺陷修复 A）──────────────────────────────────
  /**
   * 常规重锚的「权威已跑偏」门限（HU）。
   *
   * 判定量 = `|权威**自身**位置 − 渲染当前位置|`。为什么要减掉权威发布延迟：
   * 权威帧在渲染帧 k 里被读到，此刻渲染已又走了 v×(k→k+1) 的距离（实测 8–22ms
   * 往返 ≈ 10–30 HU @1300 HU/s），所以「权威自身位置」天生落后渲染当前位置
   * 一个发布间隔——那段是**时钟滞后**，不是几何漂移。门限取 16 HU 即「超过约
   * 半个发布间隔的额外偏移才算真漂移」。
   *
   * 为什么必须有 routine 重锚（而不是只在传送窗口里锚）：权威的碰撞解算用的是
   * **它自己的**位置。修复 C 之前，`applyCollisionCorrection` 会把渲染位置反向
   * 拖回 5–60 HU，双端偏差因此被不断"重造"（实测偏移 5–40 HU、尖峰 204 HU）；
   * 而权威在**错位置**上算出的碰撞速度会经 `calibrateVelocity`（R2，每帧写渲染
   * 速度）注入渲染——实测签名就是单帧、单分量（vy −71.6 → +5704.5 → −76.5，
   * vx/vz 逐位不变）的速度尖峰 jog。把权威位置 routine 锚回渲染位置，碰撞解算
   * 才发生在玩家真正所在的位置。
   *
   * 不影响 R2（权威仍是速度之主）：锚定只改权威**位置**，不改渲染速度、不改渲染
   * 位置；权威速度仍由它自己的 `phys.tick` 产出并逐帧写进渲染。
   */
  static readonly ROUTINE_ANCHOR_HU = 16;
  /** 两次常规重锚之间的最小间隔（ms）：防消息风暴（≈20/s 上限）。 */
  static readonly ROUTINE_ANCHOR_MIN_GAP_MS = 50;
  /** 常规重锚的兜底节拍（ms）：即使偏移始终小于门限也至少这么频繁地锚一次。 */
  static readonly ROUTINE_ANCHOR_MAX_GAP_MS = 250;

  /** 上次常规重锚时刻（performance.now()；-∞ = 尚未锚过）。 */
  private lastRoutineAnchorAtMs = Number.NEGATIVE_INFINITY;
  /**
   * 重锚后的加速度基准抑制帧数（2 帧）。
   *
   * 为什么需要：`set_state` 把权威位置瞬移 Δ，下一权威 tick 算出的位移里就多了
   * 这个 Δ，`computeAuthAccel` 的差分 → 巨大加速度 → `calibrateVelocity` 外推把
   * 它写进渲染速度（正是我们要消除的单帧速度尖峰）。故重锚把 `prevAuthVel` 清空
   * （该帧 accel=0），随后**再**抑制一帧（重锚位移仍会体现在下一帧的速度差里），
   * 两帧后恢复正常。
   */
  private accelSuppressFrames = 0;

  /** 传送/重置豁免期内的反向同步（真正的位置突变；`resetInput` 语义保留）。 */
  private emitTeleportSync(st: SyncPhysState): void {
    this.deps.onSyncRenderState?.(
      {
        posX: st.posX, posY: st.posY, posZ: st.posZ,
        yaw: st.yaw, pitch: st.pitch,
        velX: st.velX, velY: st.velY, velZ: st.velZ,
        onGround: st.onGround, eyeHeight: st.eyeHeight,
      },
      true, // teleport = true：这是真位置突变，允许清输入增量
    );
  }

  /**
   * 常规反向重锚（缺陷修复 A 的实现）：把渲染**当前**状态推给权威，使权威的
   * 碰撞解算落在玩家真正所在的位置。
   *
   * 与传送豁免期的两点区别（都必须保住）：
   * 1. `teleport = false` → Worker 侧**不清未消费输入增量**。常规重锚是每几十
   *    毫秒一次的例行对齐，清输入会把正常甩视角的鼠标增量丢掉 = 可见瞄准顿挫。
   *    输入清空只属于真传送（位置突变，旧增量对新位置无意义）。
   * 2. 不置 `predStarted`（渲染起点早已校准）。
   *
   * 方向始终是**渲染 → 权威**：本方法只调 `onSyncRenderState` 回调，绝不碰
   * `phys`——实时输入到显示零新增延迟（R1）。
   */
  private routineReanchor(st: SyncPhysState, authPos: { x: number; y: number; z: number }): void {
    const now = performance.now();
    const since = now - this.lastRoutineAnchorAtMs;
    if (since < AuthorityCalibrator.ROUTINE_ANCHOR_MIN_GAP_MS) return;
    const drift = Math.hypot(st.posX - authPos.x, st.posY - authPos.y, st.posZ - authPos.z);
    if (drift <= AuthorityCalibrator.ROUTINE_ANCHOR_HU &&
        since < AuthorityCalibrator.ROUTINE_ANCHOR_MAX_GAP_MS) {
      return;
    }
    this.lastRoutineAnchorAtMs = now;
    // 抑制重锚瞬移带来的假加速度（见 accelSuppressFrames）
    this.prevAuthVel = null;
    this.prevAuthTimeMs = 0;
    this.accelSuppressFrames = 2;
    this.deps.onSyncRenderState?.(
      {
        posX: st.posX, posY: st.posY, posZ: st.posZ,
        yaw: st.yaw, pitch: st.pitch,
        velX: st.velX, velY: st.velY, velZ: st.velZ,
        onGround: st.onGround, eyeHeight: st.eyeHeight,
      },
      false, // 常规重锚 = false：Worker 不清输入增量
    );
  }

  /**
   * 权威帧消费（每渲染帧调用一次）—— **只读权威 + 速度校准，绝不改动渲染位置**
   * （用户硬约束：渲染响应速度不得受影响）。
   *
   * 四段：
   * ① 传送/重置豁免期（位置刚突变）：只记录权威帧供速度外推，并把渲染新状态
   *    **反向同步**给权威（`teleport=true`，允许清输入）；
   * ② 常规失败兜底：**仅 yaw 分叉**（渲染 yaw 连续 `YAW_FAULT_FRAMES` 条权威帧
   *    静止仍与权威分叉 > `YAW_FAULT_DEG`）才反向同步；旧的 dist>500 /
   *    dist>300+同向两条件因权威发布位置改为渲染折线采样点而恒不成立，已删除
   *    （见模块头「位置投影时代的口径修正」）；
   * ③ **常规反向重锚**（缺陷修复 A）：`ROUTINE_ANCHOR_*` 节拍内的例行对齐，
   *    `teleport=false`、不清输入（见 routineReanchor）；
   * ④ 首次权威帧（无渲染历史）：以权威全状态作为渲染物理起点（唯一的权威→渲染
   *    位置通道；此后渲染位置只由 `resetTo` 与渲染物理自身碰撞改变）。
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
      // 主线程新状态 → 权威（覆盖旧位置，防止权威把旧位置当起点拉回）
      const st = phys.state() as unknown as SyncPhysState;
      this.emitTeleportSync(st);
      // 视为主线程已校准起点，避免豁免结束后权威帧再 set_state 旧位置
      this.predStarted = true;
      // yaw 分叉计数清零：豁免期内的权威 yaw 仍是旧朝向，不参与故障累计
      this.prevFrameRenderYaw = st.yaw;
      this.yawDivergedFrames = 0;
      return;
    }

    if (auth.va === this.lastVa) return;
    this.lastVa = auth.va;
    // 记录**主线程**读到这一帧的时刻（同线程时钟）——calibrateVelocity 的帧龄基准。
    // 不能用 frame.timeMs：Worker 的 performance.now 与主线程不同基准（实测偏移 ≈1132ms）。
    this.authArrivedAtMs = performance.now();
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
      this.prevFrameRenderYaw = f.yaw;
      return;
    }

    const st = phys.state() as unknown as SyncPhysState;
    // 实测距离仅保留在同步在途判定里使用（决定「权威是否已追平」）；触发条件
    // 已与位置无关（见下）。旧①②用的转动方向量已删除——同向判据随①②一起作废。
    const dist = Math.hypot(st.posX - f.pos.x, st.posY - f.pos.y, st.posZ - f.pos.z);

    const yawDiff = Math.abs(normalizeAngleDeg(st.yaw - f.yaw));
    const now = performance.now();

    // ── ③ 常规反向重锚（缺陷修复 A）─────────────────────────────────────
    // 放在 syncInFlight / 冷却早退**之前**：位置对齐与 yaw 兜底是两件事，重锚必须
    // 每个渲染帧都有机会执行（否则 yaw 兜底在途或冷却期间权威又会跑偏）。
    // 只推渲染状态给权威、绝不碰 phys —— 实时输入→显示零新增延迟（R1）。
    this.routineReanchor(st, f.pos);

    // 权威已追平（同步在途结束）：位置 < 300 且视角 ≤ 45° 视为收敛
    if (this.syncInFlight && dist < 300 && yawDiff <= 45) {
      this.syncInFlight = false;
    }
    if (this.syncInFlight) {
      // 撤回监视：同步在途但再次大幅分叉（dist > 500 或 yaw > 45°）——
      // 说明渲染侧在漂移/上次"渲染为准"的方向错误 → 撤回兜底。
      //
      // ⚠️ 本次修订（位置投影时代）：**不再写位置**。原先这里用权威帧位置
      // `set_state(f.pos…)` 回滚渲染——权威发布位置如今是渲染折线上的一个采样点
      // （一个**过去**的点），把它写回渲染等于把渲染拖回过去，直接违反硬约束
      // 「渲染位置永不被校正」，并且会污染 Worker 正在采样的那条折线本身
      // （自反馈）。保留下来的只有「速度重述」：权威是速度之主，把当前权威帧速度
      // 直接落到渲染（与 calibrateVelocity 同值同语义，只是立刻生效而非等下一帧
      // 外推）——这不消耗预测前瞻，也不产生位置跳变。
      //
      // ⚠️ 这里**不再 clearPendingInput()**：清掉的正是渲染当帧的鼠标增量，
      // 会把一次正常甩视角变成可见瞄准顿挫（旧代码在 term③ 下的真实症状）。
      // 输入清空现在只在条件③（真·yaw 分叉且渲染已静止）这一处发生。
      if (dist > 500 || yawDiff > 45) {
        phys.set_velocity(f.vel.x, f.vel.y, f.vel.z);
        this.syncInFlight = false;
        this.lastSyncAt = now;
        this.prevFrameRenderYaw = st.yaw;
        this.yawDivergedFrames = 0;
      }
      return;
    }

    // 冷却：同步/撤回后冷却期内不重复兜底处理（防抖；正常游玩快速甩视角
    // 或短暂分叉不会反复触发）
    if (now - this.lastSyncAt < AuthorityCalibrator.SYNC_COOLDOWN_MS) return;

    // ── 位置校正：**已按用户硬约束移除**（2026-09-11）─────────────────────
    // 用户明确要求：不得做任何影响渲染的修改——「我的操作到显示必须是最新的，
    // 渲染响应速度不得受任何影响」。任何把渲染位置朝权威拉的校正，都会直接消耗
    // 预测前瞻、降低输入→显示的响应，因此这里**不再改动渲染位置**。
    // 位置漂移改从源头解决：`auth-loop.ts` 的 `setFixedDt` 幂等 + 绝对有界欠账
    // （权威时钟此前会在每次物理配置消息上 reset() 丢时间），以及 `calibrateVelocity`
    // 的帧龄改用主线程到达时刻（修好被跨时钟偏移弄死的速度外推，使注入的速度**更新**）。

    // 兜底判定 —— 单条件（①② 已删除，见模块头「位置投影时代的口径修正」）：
    // ① 位置差 > 500 → **恒不成立**（发布位置 = 渲染折线上的采样点，dist 恒
    //    ≈ v × 发布延迟 ≈0–26 HU @1300 HU/s）——删除，保留会误导。
    // ② 位置差 > 300 且同向 → 同上恒不成立——删除。
    // ③ **yaw 分叉**才是仍需兜底的一类（权威是速度之主，但角度不该被它拖住）：
    //    重写为「渲染 yaw 连续 YAW_FAULT_FRAMES 条权威帧静止不动、却仍与权威 yaw
    //    分叉 > YAW_FAULT_DEG 度」。
    //
    // 为什么不是旧的 `dist <= 300 && yawDiff > 45`：权威 yaw 天生落后渲染 yaw
    // 一个 tick 的**未消费鼠标增量**——快速甩视角（>~2900°/s 时单 tick Δyaw > 45°）
    // 会让旧判据在完全正常的输入下开火；开火即 clearPendingInput() 丢掉渲染当帧
    // 鼠标增量 + Worker resetInput()，玩家看到的是瞄准顿挫（本项目已知症状）。
    // 现实测「渲染 yaw 是否还在被输入推动」作为判据：只要渲染 yaw 还在动，分叉就
    // 是预期滞后（非故障）；渲染 yaw 静止（< YAW_STILL_DEG/frame）而权威仍分叉，
    // 才说明双端视角真的走散（权威侧丢输入/被卡住）。连续 8 帧（≈125ms）防抖，
    // 避免落地/撞墙瞬间的单帧抖动误判。
    //
    // 备选判据（本文件作者无权实施，记录给未来）：直接检查两个 SAB 鼠标累加器
    // （B_DX_ACC/B_DY_ACC，见 shared-state.ts takeInput）在权威 tick 后是否已排空
    // ——那需要 Worker 侧把「排空」信号回传/暴露，属于 shared-state.ts 与 worker
    // 装配面（其他 agent 所有），故未采用；本判据只用本文件已注入的 deps
    // （getPhys/readAuth/clearPendingInput），零新增接口。
    const yawStill =
      Math.abs(normalizeAngleDeg(st.yaw - this.prevFrameRenderYaw)) <
      AuthorityCalibrator.YAW_STILL_DEG;
    this.prevFrameRenderYaw = st.yaw;
    if (yawDiff > AuthorityCalibrator.YAW_FAULT_DEG && yawStill) {
      this.yawDivergedFrames++;
    } else {
      this.yawDivergedFrames = 0;
    }
    const shouldSync = this.yawDivergedFrames >= AuthorityCalibrator.YAW_FAULT_FRAMES;
    if (shouldSync) {
      this.syncInFlight = true;
      this.lastSyncAt = now;
      // yaw 分叉兜底 = 真·双端视角走散（渲染已静止）→ 按传送口径发（允许清输入；
      // 旧增量对已静止的视角无意义，且下面 clearPendingInput 语义本来就是它）
      this.emitTeleportSync(st);
      // 清主线程待喂输入（同步瞬间的旧增量不注入新状态）
      this.deps.clearPendingInput();
    }
  }

  /** 权威加速度 = 两权威帧速度差 / 帧间隔（u/s²）；首帧/间隔异常 → 0。 */
  private computeAuthAccel(
    vel: { x: number; y: number; z: number },
    timeMs: number,
  ): { x: number; y: number; z: number } {
    // 重锚抑制窗（见 accelSuppressFrames）：重锚位移会污染一帧速度差，
    // 期间**照常刷新**基准（prevAuthVel/prevAuthTimeMs）但不产出加速度。
    const suppress = this.accelSuppressFrames > 0;
    if (suppress) this.accelSuppressFrames--;
    const prev = this.prevAuthVel;
    const prevT = this.prevAuthTimeMs;
    this.prevAuthVel = { ...vel };
    this.prevAuthTimeMs = timeMs;
    if (suppress || !prev || prevT <= 0) return { x: 0, y: 0, z: 0 };
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
   * 自己输入驱动（鼠标 + Q/E，144Hz 高精度），Q/E 速度等输入参数立即生效。
   * 同理 `applyCollisionCorrection` 也**不再**写角度（缺陷修复 C）。
   */
  calibrateVelocity(now: number): void {
    const phys = this.deps.getPhys();
    if (!phys || !this.curAuth) return;
    const a = this.curAuth;
    // 帧龄用**主线程读到该权威帧的时刻**（同线程时钟）：
    // 原来用 `a.timeMs`（Worker 的 performance.now）——两者时间基准不同，
    // 实测固定偏移 ≈1132ms，于是 dt ≈ 1.13s，恒 > 0.1 的上限判断 →
    // **加速度外推永远不生效**，速度退化成"一个 tick 之前的原始权威速度"，
    // 渲染被钉死在滞后 ~15.6ms（1300 HU/s ≈ 20 HU）的速度上 = 用户报告的
    // 「tick 计算滑落，把渲染拖住」。
    const dt = (now - this.authArrivedAtMs) / 1000;
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
    this.prevFrameRenderYaw = 0;
    this.yawDivergedFrames = 0;
    this.syncInFlight = false;
    this.lastSyncAt = 0;
    this.predStarted = false;
    this.curAuth = null;
    this.lastVa = -1;
    // 常规重锚状态清零（新世界/新轨迹：旧节拍无意义）
    this.lastRoutineAnchorAtMs = Number.NEGATIVE_INFINITY;
    this.accelSuppressFrames = 0;
  }

  /**
   * 权威碰撞事件 → **纯提示**（phys-event 不再有位置/角度通道）。
   *
   * ⚠️ **本方法曾经写渲染位置与角度，现已全部删除**（缺陷修复 C）。原因与实测：
   *
   * 1. **位置写 = 渲染折线上的倒退段**（主症状）。旧实现在这里调
   *    `phys.set_state(corr…, yawDeg, pitchDeg, …)`：`corr` 来自「最近权威帧的
   *    发布位置（渲染折线上的一个采样点）+ vel×帧龄」，但权威发布位置天生滞后
   *    渲染当前位置 v×发布延迟（1300 HU/s 下 ≈20 HU，高速更甚），再加上外推误差
   *    ——每次碰撞事件都把渲染**沿它自己的来路拖回去**最多 `COLLISION_GATE_HU`
   *    （60 HU ≈ 1300 HU/s 下的 24 个渲染帧）。触发条件在 `auth-loop.ts` 里是
   *    `!prevOnGround && onGround`（land）与
   *    `curSpeed>80 && prevSpeed−curSpeed>250 && moved < expectedMove*0.3`
   *    （blocked）——**普通 surf 贴坡/擦墙就会命中**，不需要真的"撞"。
   *    实测（`debug/fixtures/path/tick-on-render-prefix.json`）：渲染线上
   *    24 处方向反转（最狠一处 dot=−0.988 ≈ 171° 回头），稳态垂距 p95 = 36.52 HU。
   * 2. **角度写 = 未加门的权威朝向注入**。权威 yaw/pitch 天生滞后渲染一个 tick 的
   *    未消费鼠标增量；碰撞瞬间把它写进渲染物理，会让**下一个 tick 的 surf 加速
   *    方向**按权威的旧朝向计算 → 玩家手感上的"神秘碰撞/乱转向"。
   * 3. **距离门 `COLLISION_GATE_HU`（60 HU）失去意义**。它当时是用来限制"位置
   *    单次跳变量"的；位置通道既然不存在，就只剩"事件离得远就不作为"这一副作用
   *    ——而权威内部位置与渲染位置相差 5–40 HU（尖峰 204 HU）是**常态**，
   *    保留它只会让本该生效的**速度**耦合随机失效（实测偏移尖峰 204 HU 已超过
   *    60 HU 门）。故一并删除；`collisionProjectedPos` 及
   *    `COLLISION_AGE_LIMIT_MS` 随其唯一消费者一起删除。
   *
   * 保留下来的两个通道（都**不碰位置、不碰角度**）：
   * - `land` → 权威**碰撞处理后的速度**（`vel`）+ `onGround = true`——但**仅当渲染
   *   自己此刻 `onGround` 已为真**（修复 B，2026-09-11：权威与渲染相位不重合，
   *   权威落地时渲染常仍在空中，此时强写 onGround=true 会让渲染在半空重新起跳、
   *   顶高 57→≈114 翻倍 —— 见方法后半段守卫注释与 `jump-apex-verify.mjs` 实测）。
   *   速度是权威作为「速度之主」的合法耦合（R2；与逐帧 `calibrateVelocity`
   *   同值同语义，只是落地瞬间立即生效）；`onGround` 用**渲染自己的当前位置/速度**
   *   重述（`set_state(st.pos…, st.vel…, true)`——写回的就是刚从 `state()` 读到的
   *   同一组值，位置零变化），不引入任何权威位置。渲染腾空时本分支退化为纯提示。
   * - `blocked` → **什么都不写**。撞墙瞬间权威速度与渲染速度本就相差一个碰撞相位，
   *   直接注入会造成可见抖动；跨墙后的方向由渲染物理自身演化、再由逐帧
   *   `calibrateVelocity` 渐进收敛。本分支保留在协议里只为让 `auth-loop` 的事件流
   *   仍是"可观测提示"（面板/HUD 用），对渲染**零影响**。
   *
   * `pos` / `yawDeg` / `pitchDeg` 三个入参**有意保留在签名里但不再使用**：
   * 它们由 `phys-event` 消息协议携带（`AuthCollisionEvent`，worker 侧发），
   * 删参数只会把"弃用"变成"协议变更"，对调用方没有任何好处。未使用参数以 `_`
   * 前缀标注（debug tsconfig 开了 `noUnusedParameters`）。
   */
  applyCollisionCorrection(
    kind: 'land' | 'blocked',
    _pos: number[],
    _yawDeg: number,
    _pitchDeg: number,
    vel?: number[],
  ): void {
    const phys = this.deps.getPhys();
    if (!phys) return;
    // 撞墙（blocked）：纯提示，零写入（见方法头 2）。
    if (kind !== 'land') return;

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
    };
    // ⚠️⚠️ **腾空时的 land 事件一律不采纳**（2026-09-11 修复 B，跳跃顶高翻倍根因）──
    //
    // 事件判据在**权威**侧是 `!prevOnGround && onGround`（auth-loop.ts:352），而
    // 双线位置/相位并不重合（发布位置 = 渲染折线采样点、权威自持物理位置差常态
    // 5–40 HU）：权威落地时**渲染常常还在空中**（实测 144Hz 平地连跳：29 次 land
    // 事件里 17 次渲染在空）。此时把 onGround 强写 true，等于告诉渲染物理「你站在
    // 地上」，而 `check_jump` 的唯一硬门就是 `on_ground`（player.rs:537），
    // `p.velocity[1] = jump_velocity`（≈302，**赋值**，player.rs:560-561）——
    // 按住空格（autobhop 下连 `old_jump` 边沿都不检查，player.rs:544）就会在**半空**
    // 重赋一个完整 +302：从顶点附近起跳 → 顶高 57 → ≈114 **恰翻倍**。
    // 实测（debug/scripts/jump-apex-verify.mjs，平地按住空格连跳 20s）：
    //   144Hz 修复前 顶高 max 111.5 HU（= 2×55.8）、17 次腾空起跳；
    //   本守卫落地后 顶高 max 59.7 HU、0 次腾空起跳（中位 56.2，抖动 ±3 HU）。
    // 注：本守卫**不削弱**任何合法语义——渲染自己已 grounded 时照常重述（那时
    // `st.onGround` 本就是 true，写入是幂等的），速度耦合（R2）也照常生效；
    // 渲染腾空期间则退化为与 `blocked` 同级的**纯提示**（零写入）。
    // 不能改成"以权威 onGround 为准"：权威位置与渲染位置不同源，它判定的落地
    // 时刻对渲染没有意义（渲染的着地由渲染自己的 categorize_position 决定）。
    if (!st.onGround) return;
    // 权威落地瞬间的速度（已过碰撞处理）——R2 的合法耦合；缺失则保留渲染速度。
    const vx = vel?.[0] ?? st.velX;
    const vy = vel?.[1] ?? st.velY;
    const vz = vel?.[2] ?? st.velZ;
    // ⚠️ 位置/角度全部写回**渲染自己的**当前值（不是权威的 _pos/_yawDeg/_pitchDeg、
    // 也不是任何投影点）：本调用唯一目的是把 onGround 置 true。位置零变化 ⇒ 渲染
    // 折线不会出现倒退段；角度零变化 ⇒ surf 加速方向不被权威滞后朝向改写。
    // （PhysWorld 没有单独的 set_on_ground；set_state 是唯一可写着地位的口。）
    phys.set_state(st.posX, st.posY, st.posZ, st.yaw, st.pitch, vx, vy, vz, true);
  }
}
