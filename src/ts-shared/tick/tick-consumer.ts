/**
 * tick 权威消费器（任务 t5；主线程零物理实例消费，t3-memo §3 基线 +
 * t4-acceptance §1 P0 等式 + t2 接口合同）。
 *
 * 三情形时间线（t3-memo §3.1）：
 * - A 正常插值：α 由确定性网格决定 `g = (now − T0_est) − Δ`，发布抖动不进 α；
 * - B 兜底冻结：下一 tick 未及时发布 → 冻结最后已发布帧（α 钳 1）+ starvation
 *   计数——**任何路径零外推**（红线：渲染管线不存在 pos+vel×dt 形态）；
 * - C 快进/重锚：大空洞后 τ_display 一次快进到位（白名单事件逐次计数）。
 *
 * 硬不变量四条（t4-acceptance §1.3，全进 Gate 2）：
 * ①显示时间单调：τ_display = max(τ_prev, now − T0_est − Δ)——Δ 增大/EMA 更新
 *   只延长 hold 绝不回退（防 ~3.5u @3500u/s 倒退跳变）；
 * ②时钟锚：T0_est 由 I_A_TICK 逐帧 EMA 锚定（**仅修订帧采样**——乐观帧 timeMs
 *   是 eval 墙钟会污染网格；断窗/播种重置）；now_m 取 rAF 时间戳参数；
 * ③光标跳变白名单 + 遥测：starvation hold / Δ 调节 / 快进重锚 / 断窗直出 /
 *   OPT 直出逐事件计数；fallback 率 = frozenFrames/(published+frozenFrames)；
 * ④断窗帧禁跨界插值：seg 变化 = 断窗 → 新帧直出 + τ 重锚（防 lerp 扫场伪影）。
 *
 * PSEQ 读侧纪律（t2 裁定③ + Gate 2 口径③）：readAuthoritativeInto 返回 −1
 * （读写冲突）→ 本帧整体跳过（readConflictSkip 独立计数）——**不采信、不进
 * T0_est EMA、不进断窗/事件统计、不触发重锚**（冲突 ≠ 饥饿 ≠ 通道死亡）；
 * 帧内容（含标签）不采信，显示保持上一产出。
 *
 * OPT 帧（evt&256，t6 §8.1 修订流）正确形态：直出 + **显示保持**——OPT(k) 直出
 * 后持续显示 scratch 姿态直到 τ_display 追过网格 t_k；修订帧到达只记账
 * （optWithdraw，不确定性解除）不提前接管（α 链在 τ≈t_k−Δ 接管 = 显示回退
 * ~1.5 tick，违硬不变量①）。交回时链端点=修订帧 k（姿态 ≈ OPT 姿态，scratch
 * 误差量级）→ 连续。OPT 帧不进环形缓冲、不采 T0_est、不推进插值游标。
 *
 * 新帧检测：SAB/MsgState 均为粘滞最新帧——va 不变即无新发布；τ/网格/弦每 rAF
 * 推进（显示连续），入环/T0 采样/断窗/记账仅在新帧（isNew）上执行。
 *
 * Δ 控制器（t3 §3.1.1，事件驱动步进非 EMA）：starvation 事件 → Δ+1ms（硬帽
 * 1.5T+8）；连续 1000 槽无 starvation → 每 100 槽 −0.25ms（下界 T+4）；
 * P-tick-8 收敛断言在单测。
 *
 * 零分配：环形缓冲 + dst 视图 + 姿态输出全部构造期单次分配；consume 路径无
 * 对象字面量（S4 堆分配 = 0）。角度最短弧 wrap 感知（≤26.4°/tick 短弧安全）。
 * i32 标签比较 wrap-safe（(b−a)|0，回绕 ≈194 天/次）。
 */

import type { SharedState } from '../auth/shared-state.js';

/** raw 64Hz tick 周期（ms）——与排序门同源常量。 */
export const TICK_PERIOD_MS = 1000 / 64; // 15.625

/** T0_est EMA 系数（t3-memo §3.1.1：~0.05，重锚重置）。 */
export const T0_EST_EMA = 0.05;

/** Δ 预算（J 口径，t4 §1.3）：缺省 = T + 8ms setTimeout 守卫。 */
export const DELTA_DEFAULT_MS = TICK_PERIOD_MS + 8; // 23.625

/** Δ 自适应下界 = T + 4ms（t3 §3.1.1 量化守卫界）。 */
export const DELTA_MIN_MS = TICK_PERIOD_MS + 4; // 19.625

/** Δ 上界 = 1.5T + 8（t3 §3.1.1 硬帽）。 */
export const DELTA_MAX_MS = 1.5 * TICK_PERIOD_MS + 8; // 31.4375

/** Δ 控制器：starvation 事件 +1ms / 恢复期每 100 槽 −0.25ms。 */
export const DELTA_STARVE_STEP_MS = 1;
export const DELTA_RECOVER_STEP_MS = 0.25;
export const DELTA_RECOVER_EVERY_SLOTS = 100;
/** 恢复期门控：连续无 starvation 槽 ≥ 此值才开收回（P-tick-8 收敛前提）。 */
export const DELTA_RECOVER_AFTER_CLEAN = 1000;

/** OPT 乐观帧位（evt bit8）——与 shared-state.AUTH_EVT_OPT 同值。 */
export const OPT_BIT = 256;

/** 环形深度：Δ ≤ 31.4ms ≈ 2 tick，16 深足够（含 catch-up 补跑余量）。 */
export const RING_CAP = 16;

/** 直跳分桶阈值（u）：≤2.5 归 bulk 桶（≤2-3u 硬），>2.5 归 flip 桶
 * （div_flip 遥测源——回开混合评审条款的人工判读面；快运动下 OPT/断窗直出
 * 本身即大位移跳变，flip 桶按速度剖面人工判读，慢速稳态下 flip≈0 为无伪影证据）。 */
export const DIV_BULK_MAX_U = 2.5;

/** 大空洞判定：单次 starvation 跨过 ≥ 此 tick 数，恢复时走快进重锚。 */
export const FAST_FORWARD_TICKS = 2;

/** 相机姿态输出（构造期单次分配；consume 原地覆写）。 */
export interface TickPose {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  eyeHeight: number;
  onGround: boolean;
}

/** 遥测计数器（面板直读；全部构造期分配、consume 原地递增）。 */
export interface TickConsumerStats {
  /** starvation 事件数（兜底冻结触发；S2 预算 <1 次/10s）。 */
  starvationEvents: number;
  /** 累计 starved tick 数（单次事件 <2 tick，S2）。 */
  starvedTicks: number;
  /** PSEQ 读冲突跳过（Gate 2 口径③：不进任何统计面）。 */
  readConflictSkip: number;
  /** OPT 直出帧数。 */
  optDirect: number;
  /** 修订即撤记账数（同 tick 同段修订帧到达；显示保持到 τ 过 t_k）。 */
  optWithdraw: number;
  /** 断窗直出次数（seg 变化；八类触发源，lastBreakEvtBits 记最近一类）。 */
  breakDirect: number;
  /** 最近断窗事件位（bit0-7）。 */
  lastBreakEvtBits: number;
  /** 快进重锚次数（大空洞，≥FAST_FORWARD_TICKS）。 */
  reanchor: number;
  /** τ 钳制事件数（τ 回退需求被单调钳——硬不变量①的白名单遥测）。 */
  tauClamp: number;
  /** Δ 调节次数（±步进都计；P-tick-8 稳态 <20 次/5s）。 */
  deltaAdjust: number;
  /** 直跳分桶：bulk（≤2.5u 硬）。 */
  divBulk: number;
  /** 直跳分桶：flip（>2.5u）。 */
  divFlip: number;
  /** 正常弦插值帧数（含端点钳 1−1e−9 形态；fallback 率分母）。 */
  published: number;
  /** 兜底冻结帧数（fallback 率分子，M5）。 */
  frozenFrames: number;
}

/** 消费器诊断快照（面板实时读；构造期分配）。 */
export interface TickConsumerDiag {
  alpha: number;
  tauDisplay: number;
  deltaMs: number;
  /** 网格锚估计（null=未锚定）。 */
  t0Est: number | null;
  /** 最近修订帧 tick（i32 语义）。 */
  lastTick: number;
  seg: number;
  /** 确定性网格：t_k = T0_est + k·T（面板直显用；未锚定时 NaN）。 */
  gridT(k: number): number;
}

export interface TickConsumer {
  readonly stats: TickConsumerStats;
  readonly diag: TickConsumerDiag;
  /** 最近一次 consume 产出的姿态（原地覆写；未产出时内容未定义）。 */
  readonly pose: TickPose;
  /** 每帧消费：读权威帧 + 三情形分派 + 相机姿态产出（零分配热路径）。
   * @returns 'pose'（pose 已更新或保持显示——相机写入 pose）/ 'hold'（通道未
   *          开始——相机保持不动）/ 'frozen'（兜底冻结——pose 冻结在最后已
   *          发布帧或 OPT 保持姿态，零外推）。 */
  consume(nowMs: number): 'pose' | 'hold' | 'frozen';
  /** 模式离开（tick → 回滚/切出）：停机态（计数器保留，再入时重新播种）。 */
  deactivate(): void;
  /** 是否已播种（首修订帧到达、α 链可用）。 */
  isSeeded(): boolean;
}

/** 环形槽（构造期分配；k&15 寻址，tick 标签回校验防陈旧槽错配）。 */
interface RingSlot {
  k: number;
  seg: number;
  wallMs: number;
  f: Float64Array;
  onGround: number;
}

/** i32 wrap-safe 序列序：a 在 b 之前（±2^30 窗内；全量回绕歧义天然排除）。 */
function before(a: number, b: number): boolean {
  const d = (b - a) | 0;
  return d > 0 && d < 0x40000000;
}

/** 角度最短弧插值（wrap 感知，度域）。 */
function lerpAngleDeg(a: number, b: number, t: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return a + d * t;
}

export function createTickConsumer(shared: SharedState): TickConsumer {
  // ── 构造期单次分配（S4：consume 路径零堆分配）────────────────
  const dstF = new Float64Array(12);
  const dstI = new Int32Array(6);
  const ring: RingSlot[] = [];
  for (let i = 0; i < RING_CAP; i++) {
    ring.push({ k: 0, seg: 0, wallMs: 0, f: new Float64Array(10), onGround: 0 });
  }
  const pose: TickPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, eyeHeight: 64.09, onGround: false };

  const stats: TickConsumerStats = {
    starvationEvents: 0, starvedTicks: 0, readConflictSkip: 0,
    optDirect: 0, optWithdraw: 0, breakDirect: 0, lastBreakEvtBits: 0,
    reanchor: 0, tauClamp: 0, deltaAdjust: 0, divBulk: 0, divFlip: 0,
    published: 0, frozenFrames: 0,
  };
  const diag: TickConsumerDiag = {
    alpha: 0, tauDisplay: 0, deltaMs: DELTA_DEFAULT_MS, t0Est: null,
    lastTick: 0, seg: 0,
    gridT: (k: number) => (diag.t0Est === null ? NaN : diag.t0Est + k * TICK_PERIOD_MS),
  };

  // ── 消费器状态 ───────────────────────────────────────────────
  let seeded = false;
  let t0Est: number | null = null;
  let tauDisplay = 0;
  let tauValid = false;
  let deltaMs = DELTA_DEFAULT_MS;
  let cleanStreak = 0;
  let recoverCredit = 0;
  let lastSeg = 0;
  let lastRevTick: number | null = null;
  /** OPT 显示保持：OPT(k) 直出后持续显示 scratch 姿态直到 τ 追过 t_k（见头注）。 */
  let optHoldTick: number | null = null;
  let optHoldSeg = 0;
  let lastVa = -1; // 新帧检测（SAB/MsgState 粘滞读；va 单调递增）
  let starvedTicksCur = 0;
  let starving = false;
  let havePose = false;

  function syncDiag(): void {
    diag.tauDisplay = tauDisplay;
    diag.deltaMs = deltaMs;
    diag.t0Est = t0Est;
    diag.lastTick = lastRevTick ?? 0;
    diag.seg = lastSeg;
  }

  /** 直出（OPT/断窗/播种共用；直出前后位移差 → div 双桶）。 */
  function directOutFromDst(count: 'opt' | 'break' | 'seed'): void {
    if (havePose) {
      const d =
        Math.abs(dstF[0] - pose.x) + Math.abs(dstF[1] - pose.y) + Math.abs(dstF[2] - pose.z);
      if (d > DIV_BULK_MAX_U) stats.divFlip++;
      else stats.divBulk++;
    }
    pose.x = dstF[0]; pose.y = dstF[1]; pose.z = dstF[2];
    pose.yaw = dstF[3]; pose.pitch = dstF[4];
    pose.eyeHeight = dstF[8];
    pose.onGround = dstI[0] === 1;
    if (count === 'opt') stats.optDirect++;
    else if (count === 'break') {
      stats.breakDirect++;
      stats.lastBreakEvtBits = dstI[4] & 0xff;
    }
    havePose = true;
  }

  /** τ 重锚（快进/断窗/播种共用）：τ_display 直接落当前网格需求值。 */
  function reanchorTau(nowMs: number): void {
    if (t0Est === null) return;
    tauDisplay = nowMs - t0Est - deltaMs;
    tauValid = true;
  }

  /** 修订帧入环 + T0_est 采样（仅修订帧、仅新帧；仅同段 tick 严格前进样本）。 */
  function insertRevision(k: number, seg: number, onGround: number): void {
    const slot = ring[k & 15];
    slot.k = k;
    slot.seg = seg;
    slot.wallMs = dstF[9];
    slot.onGround = onGround;
    for (let i = 0; i < 10; i++) slot.f[i] = dstF[i];
    if (seg === lastSeg && lastRevTick !== null && before(lastRevTick, k)) {
      const sample = dstF[9] - k * TICK_PERIOD_MS;
      t0Est = t0Est === null ? sample : t0Est + T0_EST_EMA * (sample - t0Est);
    }
    lastRevTick = k;
  }

  function consume(nowMs: number): 'pose' | 'hold' | 'frozen' {
    const va = shared.readAuthoritativeInto(dstF, dstI);
    if (va === 0) return havePose ? 'frozen' : 'hold'; // 通道未开始：相机保持
    if (va === -1) {
      // PSEQ 读冲突（Gate 2 口径③）：整体跳过——不采信/不采样/不污染统计；
      // 帧内容不采信，显示保持（pose 未被本调用覆写）
      stats.readConflictSkip++;
      return havePose ? 'frozen' : 'hold';
    }
    const isNew = va !== lastVa;
    lastVa = va;
    const seg = dstI[2];
    const k = dstI[3];
    const evt = dstI[4];

    if (isNew) {
      // ── 新帧面：断窗 / OPT 直出 / 修订入环（仅新帧执行一次）──────
      if (seg !== lastSeg) {
        const firstEver = !seeded;
        lastSeg = seg;
        lastRevTick = null; // 新段 tick 样本链重建（world 重建 tick 归零合法）
        optHoldTick = null; // 断窗作废 scratch 显示（新段从直出重启）
        t0Est = dstF[9] - k * TICK_PERIOD_MS; // T0_est 重置（网格重锚定）
        if (!firstEver) {
          directOutFromDst('break');
          reanchorTau(nowMs);
          starving = false; // 断窗终止 starvation（新段重启）
          syncDiag();
          return 'pose';
        }
      }
      const isOpt = (evt & OPT_BIT) !== 0;
      if (isOpt) {
        optHoldTick = k; // 新 scratch 总是更新保持（更接近墙钟）
        optHoldSeg = seg;
        directOutFromDst('opt');
        syncDiag();
        return 'pose';
      }
      // 修订帧：修订即撤·记账（同 tick 同段 = OPT 不确定性解除；显示保持到 τ 过 t_k）
      if (optHoldTick !== null && k === optHoldTick && seg === optHoldSeg) {
        stats.optWithdraw++;
      }
      insertRevision(k, seg, dstI[0] === 1 ? 1 : 0);
      if (!seeded) {
        // 播种：直出（无对端可插值）+ T0_est 初始锚 + τ 重锚 + Δ 复位
        seeded = true;
        t0Est = dstF[9] - k * TICK_PERIOD_MS;
        directOutFromDst('seed');
        reanchorTau(nowMs);
        deltaMs = DELTA_DEFAULT_MS;
        stats.published++; // 播种帧计入已消费（fallback 率分母）
        syncDiag();
        return 'pose';
      }
    }

    if (t0Est === null) return havePose ? 'frozen' : 'hold';

    // ── α 网格需求（每 rAF 推进；硬不变量①：τ 单调钳制）──────────
    const g = nowMs - t0Est - deltaMs;
    const tauNew = tauValid ? Math.max(tauDisplay, g) : g;
    if (tauValid && tauNew !== g) stats.tauClamp++;
    tauDisplay = tauNew;

    // ── OPT 显示保持门：τ 未追过 t_k → scratch 姿态继续（修订已记账）────
    if (optHoldTick !== null) {
      const tHold = t0Est + optHoldTick * TICK_PERIOD_MS;
      if (tauDisplay < tHold) {
        syncDiag();
        return 'pose'; // OPT 姿态持续显示（pose 自 OPT 直出后未被覆盖）
      }
      optHoldTick = null; // τ ≥ t_k：交回 α 链（端点=修订帧 k，姿态连续）
    }

    // 段定位：候选 k = ceil((τ − T0)/T)；端点双槽标签+段回校验
    const kCur = Math.ceil((tauDisplay - t0Est) / TICK_PERIOD_MS) | 0;
    const sHi = ring[kCur & 15];
    const sLo = ring[(kCur - 1) & 15];
    const hiOk = sHi.k === kCur && sHi.seg === lastSeg;
    const loOk = sLo.k === ((kCur - 1) | 0) && sLo.seg === lastSeg;

    if (hiOk && loOk) {
      // ── 情形 A：正常弦插值（P0 等式本体）────────────────────────
      if (starving) {
        // 兜底冻结结束 → 快进判定（大空洞才重锚，短空洞自然追上）
        starving = false;
        if (starvedTicksCur >= FAST_FORWARD_TICKS) {
          stats.reanchor++;
          reanchorTau(nowMs);
        }
        starvedTicksCur = 0;
      }
      cleanStreak++;
      let alpha = (tauDisplay - (t0Est + (kCur - 1) * TICK_PERIOD_MS)) / TICK_PERIOD_MS;
      if (alpha < 0) alpha = 0;
      if (alpha >= 1) alpha = 1 - 1e-9; // P0：α < 1 + 1e−9（端点钳 = 冻结语义）
      const t = alpha;
      pose.x = sLo.f[0] + (sHi.f[0] - sLo.f[0]) * t;
      pose.y = sLo.f[1] + (sHi.f[1] - sLo.f[1]) * t;
      pose.z = sLo.f[2] + (sHi.f[2] - sLo.f[2]) * t;
      pose.yaw = lerpAngleDeg(sLo.f[3], sHi.f[3], t);
      pose.pitch = sLo.f[4] + (sHi.f[4] - sLo.f[4]) * t;
      pose.eyeHeight = sLo.f[8] + (sHi.f[8] - sLo.f[8]) * t;
      pose.onGround = sHi.onGround === 1;
      diag.alpha = alpha;
      stats.published++;
      havePose = true;
      // Δ 恢复期（P-tick-8）：clean ≥ 1000 后每 100 槽 −0.25ms（下界 T+4）
      if (cleanStreak >= DELTA_RECOVER_AFTER_CLEAN) {
        recoverCredit++;
        if (recoverCredit >= DELTA_RECOVER_EVERY_SLOTS) {
          recoverCredit = 0;
          if (deltaMs - DELTA_RECOVER_STEP_MS >= DELTA_MIN_MS) {
            deltaMs -= DELTA_RECOVER_STEP_MS;
            stats.deltaAdjust++;
          }
        }
      }
      syncDiag();
      return 'pose';
    }

    // ── 情形 B：兜底冻结（下一 tick 未及时发布）──────────────────
    if (!starving) {
      starving = true;
      stats.starvationEvents++;
      starvedTicksCur = 0;
      cleanStreak = 0;
      recoverCredit = 0;
      // starvation 事件 → Δ += 1ms（事件驱动步进，硬帽 1.5T+8）
      if (deltaMs + DELTA_STARVE_STEP_MS <= DELTA_MAX_MS) {
        deltaMs += DELTA_STARVE_STEP_MS;
        stats.deltaAdjust++;
      }
      // 始发冻结直出（含 div 分桶——OPT scratch 撤回/链冻结的跳变量；
      // 后续冻结 rAF 重复覆写同值不重复计数）
      const lr0 = lastRevTick;
      if (lr0 !== null) {
        const s0 = ring[lr0 & 15];
        if (s0.seg === lastSeg && s0.k === lr0) {
          if (havePose) {
            const d =
              Math.abs(s0.f[0] - pose.x) + Math.abs(s0.f[1] - pose.y) + Math.abs(s0.f[2] - pose.z);
            if (d > DIV_BULK_MAX_U) stats.divFlip++;
            else stats.divBulk++;
          }
          pose.x = s0.f[0]; pose.y = s0.f[1]; pose.z = s0.f[2];
          pose.yaw = s0.f[3]; pose.pitch = s0.f[4];
          pose.eyeHeight = s0.f[8];
          pose.onGround = s0.onGround === 1;
          havePose = true;
        }
      }
    }
    starvedTicksCur++;
    stats.starvedTicks++;
    stats.frozenFrames++;
    havePose = true;
    syncDiag();
    return 'frozen';
  }

  function deactivate(): void {
    seeded = false;
    t0Est = null;
    tauValid = false;
    starving = false;
    starvedTicksCur = 0;
    optHoldTick = null;
    lastRevTick = null;
    deltaMs = DELTA_DEFAULT_MS;
    cleanStreak = 0;
    recoverCredit = 0;
    havePose = false;
    lastVa = -1;
    diag.alpha = 0;
    diag.tauDisplay = 0;
    diag.t0Est = null;
    // 计数器保留（面板跨会话累计）
  }

  return {
    stats,
    diag,
    pose,
    consume,
    deactivate,
    isSeeded: () => seeded,
  };
}
