/**
 * tick 模式 F4-C scratch 乐观评估控制器（任务 t4 · 主案引擎）。
 *
 * 设计基线（全部落盘）：t6 渲染先行立场件 §8.1/§8.4/§8.5/§10.1/§11.2/§11.3
 * （原 plan-discuss/t6-render-ahead-stance.md，2026-09 清理；F4-C 主案：worker 内第二实例乐观评估、权威实例零触碰零
 * 写入、scratch 事件随意排空 + 权威真步确定性重放）；t3-memo §2.5（I_A_*
 * 槽语义 + AUTH_EVT 位表）；t2 契约（I_A_SEG/TICK/EVT 槽 + OPT 位 256 + f'
 * 发布序 shared-state.ts writeAuthoritative）。
 *
 * ── 逐 tick 双发流水线（t6 §8.1 排序不变量 δ+ε_max≤T）──────────────────
 * - 乐观径（本控制器 onWake）：t_{k-1}+δ 时刻（= 网格 due 前 T−δ 窗开）用
 *   **截断输入窗**（peekInput 非消耗读，饱和截断同 takeInput）在 scratch 第二
 *   实例上 `seed_from(权威)` → `tick_into` 单步投影 → 内容封帽谓词（§11.3
 *   扩展）→ 排序门 authorize → 发布 rev=OPT 乐观帧（I_A_EVT bit8 ∧ 事件位恒 0）。
 * - 权威径（stepPhysics 零分配支路）：t_k 全窗真算（authority.tick_into，
 *   step_core 与 tick() 同一 Rust 函数=bit 级同物理）→ 修订帧（同一 label k）
 *   + noteAuthoritative + div 双桶对账（乐观帧 vs 真帧：flip=接触类字段翻转 /
 *   bulk=其余，§11.3）。
 * - 红线（§10.1「实例不动」字面合规）：**乐观评估路径**对 authority 的唯一
 *   调用 = seed_from 的 src 单向提取（Rust 侧 &PhysWorld 不可变借用）+
 *   take_event 事件槽排空（事件非状态写入）。authority 的 tick_into 驱动只
 *   发生在 stepPhysics 真实步（权威线自身职责，非 F4 评估路径）。
 * - peek 两难消解（§11.2）：scratch 的 take_event 随意排空（事件随实例丢弃），
 *   权威真步重放同一事件逐位同；事件槽需求整体消失。
 *
 * ── 发布侧封帽编排（captain t4 指令⑤）：检出即不发、不经门────────────────
 * - key-edge gating（§8.4）：(t_k−δ,now] 内键位掩码变化（含 R 键 reset 位）→
 *   该 tick 跳过乐观发布（事件 tick div=0；计数 keyEdgeSkips，非门尝试）。
 * - 内容封帽（§11.3）：scratch 步后廉价字段读——take_event 非空 ∨ on_ground
 *   翻转 ∨ blocked_ticks 增量 ∨ on_ladder 翻转 ∨ ducked 翻转 ∨ surfing 翻转
 *  （对乐观步自身种子基线）→ 孤儿化该乐观帧（不发；修订照常 t_k 到达）→
 *   orphanedCap。
 * - 两类封帽都不触碰排序门 → 门闭账恒等式（指令⑧）：published + leadMiss +
 *   blockedOrder ≡ 门尝试数，原样成立（封帽是门上游的编排边界）。
 *
 * ── 零分配（t6 §8.5 P0 升阻断级）─────────────────────────────────────
 * - scratch 径：seed_from（零序列化 f64 拷贝）+ tick_into（step_core 零分配）
 *   + state_out 预建 Float64Array 视图（实例/buffer 更换才重建）+ 计数器预分配
 *   对象——稳态热路径零 JS 分配。
 * - 权威径（tick 模式 stepPhysics 零分配支路）：tick_into + 同款视图读入
 *   authorityPose 预分配记录——v7 耦合/解耦支路（tick()+state()）逐行不动。
 * - OPT 帧字面量 = writeAuthoritative API 形状（≤64/s，非热路径；P0 界定的是
 *   per-substep 物理路径分配）。遥测快照 1s 一次 postMessage（非热路径）。
 */

import type { ShmState, MsgState, AuthPublishMeta } from './shared-state.js';
import { AUTH_EVT, AUTH_EVT_OPT } from './shared-state.js';
import {
  createOrderingGate,
  type OrderingGate,
  type OrderingGateStats,
  EPSILON_MAX_SETTIMEOUT_MS,
} from '../tick/ordering-gate.js';

/**
 * F4-C 双实例面（game pkg PhysWorld 结构性满足）。
 * - `F4AuthorityWorld`：真实步零分配面（stepPhysics tick 支路驱动 tick_into +
 *   视图读）+ 事件槽排空 + seed_from 提取源。**不含任何 set_state/set_params/
 *   teleport 写面**——乐观评估路径（onWake）只经 seed_from 的 src 与 take_event
 *   触碰它（红线审计面：本接口即权限清单）。
 * - `F4ScratchWorld`：乐观评估执行体（同构；seed_from 的 src 参数结构化放宽为
 *   object——d.ts 精类型经方法双变兼容，src 实参运行时恒为具体 PhysWorld，
 *   main.ts 装配保证）。
 */
export interface F4AuthorityWorld {
  tick_into(dt: number, keysMask: number, dx: number, dy: number): void;
  state_out_ptr(): number;
  take_event(): unknown;
  seed_from(src: object): void;
}

export type F4ScratchWorld = F4AuthorityWorld;

/** 权威实例零分配视图姿态（预分配可变记录；原地填充——stepPhysics tick 支路
 * 逐字段读 + onRealTick 回传，稳态零分配）。B5 廉价字段供内容封帽基线 + div
 * flip 分类（§11.3）。 */
export interface AuthorityPose {
  x: number;
  y: number;
  z: number;
  velX: number;
  velY: number;
  velZ: number;
  yaw: number;
  pitch: number;
  eyeHeight: number;
  onGround: boolean;
  ducked: number;
  surfing: number;
  blockedTicks: number;
  ladder: number;
}

/** stepPhysics 真实 tick 回传（与 authorityTickInto 同一姿态记录）。 */
export type RealTickPose = AuthorityPose;

/** 控制器遥测（预分配可变对象；面板直读零分配）。门三计数为镜像（闭账恒等式
 * 以 gate.stats 为权威源）。 */
export interface TickF4Stats extends OrderingGateStats {
  /** 引导期无锚跳过（首个 meta'd 真实 tick 前；不在门闭账内）。 */
  bootstrapSkips: number;
  /** 内容封帽孤儿（§11.3 检出即不发；不在门闭账内）。 */
  orphanedCap: number;
  /** key-edge 跳过（§8.4；不在门闭账内）。 */
  keyEdgeSkips: number;
  /** 乐观窗迟到地板跳过（`remaining ≤ OPT_FIRE_FLOOR_MS`：追爆/慢唤醒——该 tick
   * 无乐观帧、回落 pure-history 一拍）。**门上游**计数，不在门闭账内（与
   * bootstrapSkips/orphanedCap/keyEdgeSkips 同层）。telemetry-honesty 注记
   * （protocol-engineer-2 t4 评审预备件 Q1/V2）：开火地板使门的 ε 尾 `drop-late`
   * 分支从 onWake 路径不可达，`leadMiss` 实测只含 unordered 分支；本计数把
   * 「迟到地板」这一同类损失显式记账，令遥测可复原 lead-miss 全口径。
   * 窗外唤醒（`remaining > T−δ`，每 tick 多次的正常早醒）不计——非损失。 */
  floorSkips: number;
  /** 修订对账次数（OPT 已发且真实帧到达）。 */
  revisions: number;
  /** div bulk 桶（非翻转 tick，§11.3 div_cap 2-3u 硬断言域）。 */
  divBulk: number;
  /** div flip 桶（接触判定翻转 tick 独立计数，§11.3）。 */
  divFlip: number;
  /** bulk 桶最大位移差（u；f64 出口差——显示位级）。 */
  divBulkMaxU: number;
  /** flip 桶最大位移差（u）。 */
  divFlipMaxU: number;
  /** bulk 桶位移差累计（均值分母 = divBulk）。 */
  divBulkSumU: number;
  /** bulk 桶超 2.5u 计数（残余告警面——真侧 B5 经视图可见，仅 pos 差超界）。 */
  divBulkOverCap: number;
  /** hold 冻结 tick 数（auth-loop hold 顶置期间）。 */
  holdTicks: number;
  /** 当前段序号（I_A_SEG 同源）。 */
  seg: number;
  /** 下一 meta'd 真实 tick 将发布的标号。 */
  tickLabel: number;
  /** F4 乐观径可用（tick 模式 + SAB peekInput + 双实例 + wasm 视图就绪）。 */
  f4Ready: boolean;
}

/** 控制器装配环境（main.ts 注入；全部 getter 动态读——init/config 时序无关）。 */
export interface TickAuthorityEnv {
  /** 跨线程状态通道（SAB=peekInput 可用；MsgState=乐观径禁用、纯历史回落）。 */
  getShared(): ShmState | MsgState | null;
  /** 权威实例（game pkg PhysWorld；真实步零分配面 + 种子源 + 事件排空）。 */
  getAuthority(): F4AuthorityWorld | null;
  /** scratch 第二实例（G3 同图同参构建；未建时乐观径静默）。 */
  getScratch(): F4ScratchWorld | null;
  /** wasm 线性内存 buffer（state_out 视图宿主；memory.grow 更换后视图重建）。 */
  getWasmBuffer(): ArrayBuffer | null;
  /** raw tick 周期 ms（config.physics.tickRate 直译；面板变更自动生效）。 */
  getTickPeriodMs(): number;
  /** 乐观提前量 δ ms（缺省 = cap = T−ε_max；排序门构造期钳制）。 */
  getLeadDeltaMs?(): number;
  /** 消息发送（缺省 self.postMessage；node 测试注入）。 */
  post?(msg: unknown): void;
}

/** auth-loop 侧钩子接口（AuthLoopEnv.tickF4 的形状）。全部方法在非 tick 模式
 * 由控制器自查早退——引擎本体零改动纪律（t3-memo §2.6 #4）。 */
export interface TickF4Controller {
  /** 每 loop 唤醒、累积器推进前一次（乐观窗评估 + OPT 发布 + 遥测节拍）。 */
  onWake(nowMs: number, nextDueMs: number): void;
  /** 真实 tick 输入消费后（键沿检测：R 键 reset 边沿 → 断点标记）。 */
  onInput(keysMask: number): void;
  /** 真实 tick 发布 meta（tick 模式返回 {seg,tick,evt} 并推进标号/排空事件；
   * 缺省模式返回 undefined = 耦合/解耦 meta 缺省零触碰）。 */
  publishMeta(): AuthPublishMeta | undefined;
  /** 真实 tick 发布后（排序锚 + OPT 修订对账 + div 双桶 + 基线更新）。 */
  onRealTick(nowMs: number, pose: RealTickPose): void;
  /** stepPhysics tick 支路：权威实例零分配步（tick_into + 视图读入姿态记录）。 */
  authorityTickInto(dt: number, keysMask: number, dx: number, dy: number): void;
  /** 预分配姿态记录（stepPhysics tick 支路直读；恒同一对象=稳态零分配）。 */
  readonly authorityPose: AuthorityPose;
  /** tick 模式零分配支路激活（tickMode ∧ 权威/视图就绪）。 */
  isActive(): boolean;
  /** hold 冻结 tick 计数（stepPhysics hold 顶置支路调用）。 */
  noteHoldTick(): void;
  /** 交接进入 tick 模式（seg++ + modeSwitch 位 + 首帧 meta 就绪）。 */
  enterMode(): void;
  /** 交接离开 tick 模式（状态清理；非 tick 模式全部发布恢复 meta 缺省）。 */
  exitMode(): void;
  /** 交接首帧 meta（publishCurrentState 通道：不递增标号、排空 pending 事件）。 */
  firstFrameMeta(): AuthPublishMeta | undefined;
  /** 外部断点（dispatch respawn/teleport/load 消息；非 tick 模式 no-op）。 */
  externalBreak(evtBit: number): void;
  /** world-json 重建（tick 模式：标号归零 + seg++ + worldRebuild 位 + 门重建）。 */
  externalWorldRebuild(): void;
  /** 遥测快照（面板/bench 直读；同一预分配对象）。 */
  readonly stats: TickF4Stats;
  /** 排序门遥测（闭账恒等式源，指令⑧；world 重建时整门重建——getter 动态）。 */
  readonly gate: OrderingGate;
}

/** 乐观开火地板（ms）：remaining 低于此值时乐观帧展示时长不足 1ms 且修订
 * 即至——放弃（无用乐观）；天然吞掉追赶爆发（remaining≤0）路径。 */
const OPT_FIRE_FLOOR_MS = 1;

/** ladder 基线初值（−1 = 无梯）。 */
const LADDER_NONE = -1;

export function createTickAuthority(env: TickAuthorityEnv): TickF4Controller {
  const post: (msg: unknown) => void =
    env.post ??
    ((msg: unknown): void => {
      if (typeof self !== 'undefined') {
        (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
      }
    });

  // ── 排序门（动态周期：config tickRate 变更 → 门重建（罕见路径，允许分配）；
  // ε_max 恒 setTimeout 自驱档 8 → δ cap = T−8。Atomics.wait 精确唤醒档升级
  // 时改此档位常量即可——t6 §8.4 两档设计）。─────────────────────────────
  function makeGate(periodMs: number): OrderingGate {
    return createOrderingGate({
      tickPeriodMs: periodMs,
      epsilonMaxMs: EPSILON_MAX_SETTIMEOUT_MS,
      leadDeltaMs: env.getLeadDeltaMs?.(),
    });
  }
  let gatePeriodMs = env.getTickPeriodMs();
  let gate: OrderingGate = makeGate(gatePeriodMs);

  // ── 预分配状态（稳态零分配）───────────────────────────────────────────
  const stats: TickF4Stats = {
    optimisticPublished: 0,
    leadMiss: 0,
    blockedOrder: 0,
    bootstrapSkips: 0,
    orphanedCap: 0,
    keyEdgeSkips: 0,
    floorSkips: 0,
    revisions: 0,
    divBulk: 0,
    divFlip: 0,
    divBulkMaxU: 0,
    divFlipMaxU: 0,
    divBulkSumU: 0,
    divBulkOverCap: 0,
    holdTicks: 0,
    seg: 0,
    tickLabel: 0,
    f4Ready: false,
  };
  /** 权威姿态记录（预分配；stepPhysics tick 支路 + onRealTick 共用同一对象）。 */
  const pose: AuthorityPose = {
    x: 0, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
    eyeHeight: 0, onGround: false, ducked: 0, surfing: 0, blockedTicks: 0, ladder: LADDER_NONE,
  };
  /** 乐观帧对账记录（字段复用，无逐 tick 分配）。 */
  const pendingOpt = {
    valid: false,
    label: 0,
    x: 0,
    y: 0,
    z: 0,
    onGround: false,
    ducked: 0,
    surfing: 0,
    blockedTicks: 0,
    ladder: LADDER_NONE,
  };

  // 视图缓存（authority/scratch 各一；实例或 buffer 身份更换才重建）
  let authorityView: Float64Array | null = null;
  let authorityViewInst: F4AuthorityWorld | null = null;
  let authorityViewBuffer: ArrayBuffer | null = null;
  let scratchView: Float64Array | null = null;
  let scratchViewInst: F4ScratchWorld | null = null;
  let scratchViewBuffer: ArrayBuffer | null = null;

  // tick 模式状态机
  let tickMode = false;
  /** 最新已发布权威 tick 标号（null = tick 模式尚无 meta'd 真实 tick——引导期）。 */
  let lastAuthLabel: number | null = null;
  /** 下一 meta'd 真实 tick 将发布的标号。 */
  let nextTickLabel = 0;
  /** 段序号（I_A_SEG 同源；断点事件 +1）。 */
  let segSeq = 0;
  /** 待发布事件位（externalBreak/键沿/事件排空累积；逐帧排空）。 */
  let pendingEvt = 0;
  /** 键沿检测基线（最近真实 tick 的 keysMask）。 */
  let lastRealKeys = 0;
  /** 真实 tick 姿态基线（内容封帽 + div flip 对照；真侧 B5 经 state_out 视图）。 */
  let baseOnGround = false;
  let baseDucked = 0;
  let baseSurfing = 0;
  let baseBlocked = 0;
  let baseLadder = LADDER_NONE;
  /** 遥测节拍。 */
  let lastStatsPostMs = 0;

  /** 乐观径就绪判据：tick 模式 + 权威 + scratch + SAB(peekInput) + wasm buffer。 */
  function optReady(): boolean {
    if (!tickMode) return false;
    const shared = env.getShared();
    const authority = env.getAuthority();
    const scratch = env.getScratch();
    if (!shared || !authority || !scratch) return false;
    if (typeof (shared as { peekInput?: unknown }).peekInput !== 'function') return false;
    if (!env.getWasmBuffer()) return false;
    return true;
  }

  /** 视图懒重建（实例/buffer 身份检查每 tick 一次，命中即零分配）。 */
  function refreshViews(): void {
    const buffer = env.getWasmBuffer();
    const authority = env.getAuthority();
    if (authority && buffer) {
      if (authorityViewInst !== authority || authorityViewBuffer !== buffer) {
        authorityView = new Float64Array(buffer, authority.state_out_ptr(), 22);
        authorityViewInst = authority;
        authorityViewBuffer = buffer;
      }
    } else {
      authorityView = null;
      authorityViewInst = null;
      authorityViewBuffer = null;
    }
    const scratch = env.getScratch();
    if (scratch && buffer) {
      if (scratchViewInst !== scratch || scratchViewBuffer !== buffer) {
        scratchView = new Float64Array(buffer, scratch.state_out_ptr(), 22);
        scratchViewInst = scratch;
        scratchViewBuffer = buffer;
      }
    } else {
      scratchView = null;
      scratchViewInst = null;
      scratchViewBuffer = null;
    }
  }

  /** 视图 → 姿态记录（原地填充，零分配）。 */
  function fillPoseFromView(o: Float64Array, p: AuthorityPose): void {
    p.x = o[0];
    p.y = o[1];
    p.z = o[2];
    p.velX = o[3];
    p.velY = o[4];
    p.velZ = o[5];
    p.yaw = o[6];
    p.pitch = o[7];
    p.ducked = o[8];
    p.surfing = o[12];
    p.blockedTicks = o[13];
    p.ladder = o[14];
    p.eyeHeight = o[20];
    p.onGround = o[21] === 1;
  }

  /** 门计数镜像（stats 单读入口；闭账恒等式以 gate.stats 为权威）。 */
  function mirrorGateStats(): void {
    stats.optimisticPublished = gate.stats.optimisticPublished;
    stats.leadMiss = gate.stats.leadMiss;
    stats.blockedOrder = gate.stats.blockedOrder;
  }

  return {
    stats,

    get gate(): OrderingGate {
      return gate;
    },

    isActive(): boolean {
      return tickMode && env.getAuthority() !== null && env.getWasmBuffer() !== null;
    },

    authorityTickInto(dt: number, keysMask: number, dx: number, dy: number): void {
      const authority = env.getAuthority();
      if (!authority) return;
      refreshViews();
      authority.tick_into(dt, keysMask, dx, dy);
      if (authorityView) fillPoseFromView(authorityView, pose);
    },

    authorityPose: pose,

    noteHoldTick(): void {
      stats.holdTicks++;
      pendingOpt.valid = false; // 冻结接管：投影作废（下一个真实 tick 不对账）
    },

    onInput(keysMask: number): void {
      if (!tickMode) return;
      // R 键 reset 边沿（输入位 128——Rust step_core 内 respawn 无事件，输入侧
      // 可知 t3-memo §2.5；边沿触发——按住期重复 respawn 无新不连续，不刷段）
      if ((keysMask & 128) !== 0 && (lastRealKeys & 128) === 0) {
        segSeq = (segSeq + 1) | 0;
        pendingEvt |= AUTH_EVT.reset;
        stats.seg = segSeq;
      }
      lastRealKeys = keysMask;
    },

    publishMeta(): AuthPublishMeta | undefined {
      if (!tickMode) return undefined;
      // 事件排空先于帧（evt 位随本帧出；take_event 一次性消费——tick 模式权威
      // 实例独占，耦合线从不排空（零回归））
      const authority = env.getAuthority();
      if (authority) {
        const ev = authority.take_event() as { kind?: string } | null;
        if (ev) {
          if (ev.kind === 'teleport') {
            segSeq = (segSeq + 1) | 0;
            pendingEvt |= AUTH_EVT.teleport;
          } else if (ev.kind === 'death') {
            segSeq = (segSeq + 1) | 0;
            pendingEvt |= AUTH_EVT.death;
          }
        }
      }
      const meta: AuthPublishMeta = { seg: segSeq, tick: nextTickLabel, evt: pendingEvt };
      lastAuthLabel = nextTickLabel;
      nextTickLabel = (nextTickLabel + 1) | 0;
      pendingEvt = 0;
      gate.noteAuthoritative(lastAuthLabel); // 排序锚（乐观径 lastAuthoritative===prev 判据源）
      stats.seg = segSeq;
      stats.tickLabel = nextTickLabel;
      return meta;
    },

    onRealTick(_nowMs: number, p: RealTickPose): void {
      if (!tickMode) return;
      // 修订对账 + div 双桶（§11.3：flip=接触类字段翻转，bulk=其余）
      if (pendingOpt.valid) {
        if (pendingOpt.label === lastAuthLabel) {
          const dx = p.x - pendingOpt.x;
          const dy = p.y - pendingOpt.y;
          const dz = p.z - pendingOpt.z;
          const div = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const flip =
            p.onGround !== pendingOpt.onGround ||
            p.ducked !== pendingOpt.ducked ||
            p.surfing !== pendingOpt.surfing ||
            p.blockedTicks > pendingOpt.blockedTicks ||
            p.ladder !== pendingOpt.ladder;
          if (flip) {
            stats.divFlip++;
            if (div > stats.divFlipMaxU) stats.divFlipMaxU = div;
          } else {
            stats.divBulk++;
            stats.divBulkSumU += div;
            if (div > stats.divBulkMaxU) stats.divBulkMaxU = div;
            if (div > 2.5) stats.divBulkOverCap++;
          }
          stats.revisions++;
        }
        // label 错配（hold/重建吞掉了该标签）→ 对账作废（不 div）
        pendingOpt.valid = false;
      }
      // 基线更新（内容封帽 + 下一轮 div flip 对照）
      baseOnGround = p.onGround;
      baseDucked = p.ducked;
      baseSurfing = p.surfing;
      baseBlocked = p.blockedTicks;
      baseLadder = p.ladder;
      mirrorGateStats();
    },

    onWake(nowMs: number, nextDueMs: number): void {
      if (!tickMode) return;
      // 遥测节拍（1s 一次快照消息；非热路径）
      if (nowMs - lastStatsPostMs >= 1000) {
        lastStatsPostMs = nowMs;
        mirrorGateStats();
        post({ type: 'tick-stats', stats: { ...stats } });
      }
      const ready = optReady();
      stats.f4Ready = ready;
      if (!ready) return;
      if (lastAuthLabel === null) {
        stats.bootstrapSkips++; // 引导期无锚（§8.5：停顿=回落 pure-history 一拍）
        return;
      }
      // 动态周期：config tickRate 变更 → 门重建（δ cap 随 T 重钳）
      const periodMs = env.getTickPeriodMs();
      if (!(periodMs > 0)) return;
      if (periodMs !== gatePeriodMs) {
        gatePeriodMs = periodMs;
        gate = makeGate(periodMs);
      }
      const remaining = nextDueMs - nowMs;
      // 开火窗：due 前 T−δ 窗（t_{k-1}+δ 语义）；地板之上才有展示意义
      const fireWindowMs = periodMs - gate.leadDeltaMs;
      if (remaining > fireWindowMs) return; // 窗外早醒（每 tick 多次，非损失，不记账）
      if (remaining <= OPT_FIRE_FLOOR_MS) {
        // 迟到地板（追爆/慢唤醒）：乐观帧展示不足 1ms 且修订即至 → 该 tick 无乐观
        // 帧、回落 pure-history 一拍。门上游损失 → 显式记账（Q1/V2 口径补全），
        // 门闭账恒等式因「未触门」而原样成立。
        stats.floorSkips++;
        return;
      }
      const shared = env.getShared() as ShmState; // optReady 已验 peekInput（MsgState 无此法）
      const authority = env.getAuthority() as F4AuthorityWorld;
      const scratch = env.getScratch() as F4ScratchWorld;
      const maxStep = 1200; // 单 tick 满额（MAX_INPUT_PER_STEP_BASE 基准——截断语义同 takeInput）
      const peek = shared.peekInput(maxStep);
      // key-edge gating（§8.4）：(t_k−δ,now] 键沿（含 R 位）→ 跳过（事件 tick div=0）
      if ((peek.keysMask ^ lastRealKeys) !== 0) {
        stats.keyEdgeSkips++;
        return;
      }
      const L = (lastAuthLabel + 1) | 0;
      // 同标签重发守卫：本标签乐观帧已发（窗内多次唤醒不重发——每标签一 OPT，
      // published 计数 = OPT 帧数）
      if (pendingOpt.valid && pendingOpt.label === L) return;
      // 种子面单向播种（零序列化 f64 拷贝；事件硬编码不复制 t1 §5）——
      // 乐观评估路径对权威的唯一触碰（&PhysWorld 不可变借用，红线字面合规）
      scratch.seed_from(authority);
      // 乐观单步（截断输入窗；dt = 整 tick 周期——乐观帧代表 t_k 时刻态）
      scratch.tick_into(periodMs / 1000, peek.keysMask, peek.dx, peek.dy);
      // peek 两难消解（§11.2）：scratch 事件随意排空（随实例丢弃；权威真步
      // 确定性重放同一事件逐位同）——但本帧检出事件即孤儿化（T4 封帽）
      const ev = scratch.take_event();
      refreshViews();
      const o = scratchView;
      if ((ev !== null && ev !== undefined) || !o) {
        stats.orphanedCap++;
        return;
      }
      // 内容封帽谓词（§11.3 扩展）：on_ground 翻转 ∨ blocked 增量 ∨ ladder 翻转
      // ∨ ducked 翻转 ∨ surfing 翻转（对乐观步种子基线 = 权威当前态）
      const oDucked = o[8];
      const oSurfing = o[12];
      const oBlocked = o[13];
      const oLadder = o[14];
      const oOnGround = o[21] === 1;
      if (
        oOnGround !== baseOnGround ||
        oBlocked > baseBlocked ||
        oLadder !== baseLadder ||
        oDucked !== baseDucked ||
        oSurfing !== baseSurfing
      ) {
        stats.orphanedCap++;
        return;
      }
      // 排序门（t2 落地）：排序不变量 + ε 尾；闭账恒等式源（指令⑧）
      const verdict = gate.authorizeOptimistic(L, nowMs, nextDueMs);
      mirrorGateStats();
      if (verdict !== 'publish') return;
      // OPT 乐观帧发布（rev=OPT 位；事件位恒 0——§8.1 三槽语义；f' 序由
      // writeAuthoritative(meta) 承载）
      shared.writeAuthoritative(
        {
          pos: { x: o[0], y: o[1], z: o[2] },
          yaw: o[6],
          pitch: o[7],
          vel: { x: o[3], y: o[4], z: o[5] },
          eyeHeight: o[20],
          timeMs: nextDueMs, // 投影网格 due（乐观帧代表 t_k 时刻态）
        },
        oOnGround,
        { seg: segSeq, tick: L, evt: AUTH_EVT_OPT },
      );
      pendingOpt.valid = true;
      pendingOpt.label = L;
      pendingOpt.x = o[0];
      pendingOpt.y = o[1];
      pendingOpt.z = o[2];
      pendingOpt.onGround = oOnGround;
      pendingOpt.ducked = oDucked;
      pendingOpt.surfing = oSurfing;
      pendingOpt.blockedTicks = oBlocked;
      pendingOpt.ladder = oLadder;
    },

    enterMode(): void {
      tickMode = true;
      segSeq = (segSeq + 1) | 0; // mode_switch = 断点（t3-memo §3.4.1 九类）
      pendingEvt |= AUTH_EVT.modeSwitch;
      pendingOpt.valid = false;
      const keys = env.getShared();
      lastRealKeys =
        keys && typeof (keys as { peekKeys?: unknown }).peekKeys === 'function'
          ? (keys as ShmState).peekKeys()
          : 0;
      stats.seg = segSeq;
      stats.tickLabel = nextTickLabel;
      stats.f4Ready = optReady();
    },

    exitMode(): void {
      if (!tickMode) return;
      tickMode = false;
      pendingOpt.valid = false;
      pendingEvt = 0; // 陈旧事件位不得漏进耦合/解耦发布（meta 缺省本就零触碰）
      stats.f4Ready = false;
    },

    firstFrameMeta(): AuthPublishMeta | undefined {
      if (!tickMode) return undefined;
      // 首帧：不递增标号（publishCurrentState 契约——t3-memo §2.5）；排空 pending
      const meta: AuthPublishMeta = { seg: segSeq, tick: nextTickLabel, evt: pendingEvt };
      pendingEvt = 0;
      return meta;
    },

    externalBreak(evtBit: number): void {
      if (!tickMode) return;
      segSeq = (segSeq + 1) | 0;
      pendingEvt |= evtBit;
      stats.seg = segSeq;
    },

    externalWorldRebuild(): void {
      if (!tickMode) return;
      nextTickLabel = 0; // world 重建归零（t3-memo §2.5）
      lastAuthLabel = null; // 引导期重置（重建后重新 bootstrap）
      segSeq = (segSeq + 1) | 0;
      pendingEvt |= AUTH_EVT.worldRebuild;
      gate = makeGate(gatePeriodMs); // 排序锚随实例重建（陈旧锚会误报 superseded）
      mirrorGateStats();
      stats.seg = segSeq;
      stats.tickLabel = 0;
      stats.f4Ready = optReady();
    },
  };
}
