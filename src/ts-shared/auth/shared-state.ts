/**
 * 共享状态层（公共化 v1）— 输入槽（主线程写）+ 权威帧双缓冲（Worker 写）。
 *
 * 由 debug/game 两端收敛而来（game 原版 + debug 的 SharedState 联合类型），
 * 此后权威帧协议变更只改本文件一处。
 *
 * 架构（v7 定案，用户核心思想）：
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
 *     [3] V_D      解耦状态版本号（WorkerA release 递增；0=未开始）〔双模式扩展〕
 *     [4] WAKEUP   背压唤醒电平（主 rAF store(1)+notify；解耦线 wait+CAS 复位）〔双模式扩展〕
 *     [5] I_A_SEG  tick 段序号（断窗帧 +1，自愈式断窗主防线）〔tick 模式扩展〕
 *     [6] I_A_TICK tickIndex（仅真实 tick 递增；α 确定性网格载体）〔tick 模式扩展〕
 *     [7] I_A_EVT  事件位掩码（bit0-7 事件类型 + bit8 OPT 乐观帧标记）〔tick 模式扩展〕
 *     [8] I_A_PSEQ 发布序守卫（seqlock：proto 三元组读一致性）〔tick 模式扩展〕
 *     [9-15] 保留
 *   （tick 模式扩展槽全部落 20-63B 保留区；B_DX_ACC 在 i64[8]=字节 64 起，不冲突）
 *   BigInt64 输入槽（字节 64-127，index 8-9）：
 *     [8] dxAcc  [9] dyAcc —— BigInt64 原子累加（主线程 add / Worker exchange）
 *   BigInt64 权威帧双缓冲（字节 128-415，index 16-35）：
 *     S_A[0] = 16..25（10 值）  S_A[1] = 26..35（10 值）
 *   BigInt64 解耦帧双缓冲（字节 288-447，index 36-55）〔双模式扩展〕：
 *     S_D[0] = 36..45（10 值）  S_D[1] = 46..55（10 值）
 *   每帧 10 值：posX/Y/Z(×100) yaw(×1000) pitch(×1000) velX/Y/Z(×100) eyeHeight(×100) timeMs(×1)
 *
 * 读写协议：
 * - Worker 写空闲槽 S_A[V_A&1] → release 递增 V_A
 * - 主线程读 S_A[(V_A-1)&1]（写者已离开的槽，无撕裂）
 * - 解耦帧同式（V_D/S_D；onGround 复用 i32[2]——模式互斥运行，同一槽位两模式
 *   顺序使用，无并发冲突）
 */

// ── 按键状态（与 Rust KEY_MASK 一致；两端 keyboard 实现结构兼容）───────

export interface KeyState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  duck: boolean;
  /** Shift 键：noclip 模式=冲刺倍率，physics 模式映射到 input.walk（慢走）。 */
  sprint: boolean;
  /** R 键：重生（cs-movement input.reset）。 */
  reset: boolean;
  /** 滚轮连跳（chasemod 风格 bhop）：本帧是否有滚轮 +jump 脉冲。 */
  wheelJump: boolean;
  /** Q 键：yaw 左旋（turn bind）。 */
  yawLeft: boolean;
  /** E 键：yaw 右旋（turn bind）。 */
  yawRight: boolean;
}

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

/** 位掩码 → KeyState（keysToMask 逆变换；node 测试/调试用）。 */
export function maskToKeys(mask: number): KeyState {
  return {
    forward: (mask & KEY_MASK.forward) !== 0,
    backward: (mask & KEY_MASK.backward) !== 0,
    left: (mask & KEY_MASK.left) !== 0,
    right: (mask & KEY_MASK.right) !== 0,
    jump: (mask & KEY_MASK.jump) !== 0,
    duck: (mask & KEY_MASK.duck) !== 0,
    sprint: (mask & KEY_MASK.sprint) !== 0,
    reset: (mask & KEY_MASK.reset) !== 0,
    wheelJump: (mask & KEY_MASK.wheelJump) !== 0,
    yawLeft: (mask & KEY_MASK.yawLeft) !== 0,
    yawRight: (mask & KEY_MASK.yawRight) !== 0,
  };
}

// ── SAB 布局 ─────────────────────────────────────────────────
const I_V_A = 0;
const I_KEYS = 1;
const I_A_GROUND = 2;
// 双模式扩展（phys-mode-port §3.3，additive——保留区启用，既有槽位零触碰）
const I_V_D = 3;
const I_WAKEUP = 4;

// ── tick 模式协议槽（t3-memo §2.5 v1.4 + t6-render-ahead §8.1，additive——
//    i32 保留区字节 20-63；既有槽位 i32[0-4] 与全部 i64 区零触碰）─────────
// ⚠️ i64[4..7]（字节 32-63）**永久禁用作数据槽**（t2 裁定书②钉死）：字节 32-35
// 已被 I_A_PSEQ 占用——未来若把 i64[4] 用作输入累加/数据区将直接踩 PSEQ 槽。
// i32 保留区余量 = i32[9..15]（字节 36-63），后续扩展仍充足。
// 可执行锁 = shared-state.protocol.test.ts [1]（i64 区字节核算）。
/** [5] I_A_SEG 段序号（bytes 20-23）：状态不连续事件（八类断窗/world 重建/set-mode 交接）帧
 * +1，其余帧沿用——消费端「seg 变化」谓词 = 断窗判定（自愈式：任意后续帧暴露
 * 漏检，t2-bench-brief §9.1 G1c 主防线；几何兜底降为旁路自检）。 */
export const I_A_SEG = 5;
/** [6] I_A_TICK tickIndex（bytes 24-27）：仅真实 tick 递增；publishCurrentState 等非 tick 发布
 * 不递增（沿用）；world 重建归零 + 段号 +1。α 时间基准=确定性网格的载体
 * （t4-acceptance §1.3 裁定：发布墙钟抖动不进 α）。 */
export const I_A_TICK = 6;
/** [7] I_A_EVT 事件位掩码（bytes 28-31）：bit0-7=事件类型（双源合成——内核 take_event() 排空
 * 产 teleport/death 两类；控制面产 respawn/reset/holdRelease/load/modeSwitch/
 * worldRebuild 六类，t3-memo §13.1），bit8=OPT（乐观帧标记）。逐帧量非粘滞量：
 * tick 模式发布每帧显式写（无事件写 0），消费端按「本帧事件」语义消费。 */
export const I_A_EVT = 7;
/** [8] I_A_PSEQ 发布序守卫（bytes 32-35；seqlock；本任务读侧一致性补强）：写者「store 奇数 →
 * 写 onGround+seg/tick/evt → store 偶数」；读者「偶值快照 → 读 → 复检不变才
 * 接受」。消除 catch-up 突发期消费器读到跨代混合三元组（帧 k + tick k+1 标签）
 * 的竞态——标签错配即 α 网格错相/伪断窗/幻影事件（Gate 2 断言假阳性源）。
 * 仅 tick 模式写者驱动（writeAuthoritative 带 meta 时）；耦合/解耦零触碰。
 * ⚠️ 本槽占用 i64[4] 视图前 4 字节（字节 32-35）——i64[4..7]（字节 32-63）
 * 永久禁用作数据槽（见上方区头注 + t2 裁定书②钉死）。 */
export const I_A_PSEQ = 8;

/** I_A_EVT 位定义（双源合成语义，t3-memo §13.1——内核源 teleport/death 两类；
 * 控制面源 respawn/reset/holdRelease/load/modeSwitch/worldRebuild 六类；
 * 位掩码≠内核事件计数：控制面六类不是内核泄漏，P-tick-7 断言须分源）。 */
export const AUTH_EVT = {
  teleport: 1 << 0,
  death: 1 << 1,
  respawn: 1 << 2,
  reset: 1 << 3,
  holdRelease: 1 << 4,
  load: 1 << 5,
  modeSwitch: 1 << 6,
  worldRebuild: 1 << 7,
} as const;

/** I_A_EVT bit8（OPT 位，t6-render-ahead §8.1）：乐观帧标记——乐观帧置位且
 * 事件位恒 0；权威/修订帧不标记（消费器自持「已展示乐观 k」状态，MsgState
 * 节流下权威 k 即普通帧、天然鲁棒）。 */
export const AUTH_EVT_OPT = 1 << 8;

/** tick 模式发布元数据（writeAuthoritative 第三参，additive）。
 * 缺省（undefined）= 四个协议槽零触碰——耦合/解耦既有调用点字节级零回归。
 * 提供时：seg/tick 未给 = 沿用槽内当前值；evt 未给 = 写 0（事件位是逐帧量，
 * 粘滞残留会把旧事件复用成新帧事件）。 */
export interface AuthPublishMeta {
  /** 段序号：断窗帧传新段号（+1），普通帧传当前段（或省略=沿用）。 */
  seg?: number;
  /** tick 序号：真实 tick 发布传 k；publishCurrentState 等省略=沿用。 */
  tick?: number;
  /** 事件位掩码（含 AUTH_EVT_OPT）；无事件传 0。 */
  evt?: number;
}

// BigInt64 输入槽（导出：tick 协议槽位联测的字节锚——i64[i] = 字节 8i..8i+7）
export const B_DX_ACC = 8;
export const B_DY_ACC = 9;

// BigInt64 权威帧双缓冲基址（每帧 10 值）
export const B_A0 = 16;
export const B_A1 = 26;

// BigInt64 解耦帧双缓冲基址（字节 288-447；与 S_A 同款 10 值定点编码）
export const B_D0 = 36;
export const B_D1 = 46;

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

/**
 * 消息通道回退（MsgState）——无 SharedArrayBuffer 环境（线上静态部署无 COOP/COEP 头）。
 *
 * 与 ShmState 同接口（addInput/readAuthoritative/takeInput/writeAuthoritative），
 * 用 postMessage 消息实现：
 * - 主线程每帧 addInput → postMessage `input`（增量 + 当前键位；有序不丢）
 * - Worker onmessage `input` → 累积输入缓冲（takeInput exchange 清空，语义同 SAB）
 * - Worker 每 tick writeAuthoritative → postMessage `phys-frame`（权威帧 + va）
 * - 主线程 onmessage `phys-frame` → 缓存最新帧（readAuthoritative 返回）
 *
 * 功能等价、性能降级（消息拷贝 vs 共享内存）；本地高性能游玩走 SAB 不受影响。
 */
export class MsgState {
  readonly isShared = false;

  /** 解耦帧发布间隔下限（ms）：物理仍 1ms 子步实时推进，仅发布节流到 ≈250Hz
   * 防消息风暴（phys-mode-port §3.3；SAB 模式每子步发布无此限制）。 */
  static readonly publishFloorMs = 4;

  // ── 主线程侧状态 ───────────────────────────────────────────
  private latest: { frame: AuthFrame; va: number } | null = null;
  /** tick 协议三元组粘滞镜像（recvFrame 逐帧刷新；「槽内当前值」语义同 SAB——
   * seg/tick 未提供的消息沿用旧值，evt 逐帧覆盖）。供 readAuthoritativeInto。 */
  private segCur = 0;
  private tickCur = 0;
  private evtCur = 0;
  /** 解耦帧缓存（phys-mode-port：与 latest 同载荷——mode 内互斥运行保证
   * phys-frame 读者语义单解，耦合期为耦合帧、解耦期为解耦帧）。 */
  private latestDecoupled: { frame: AuthFrame; vd: number } | null = null;
  // ── Worker 侧状态 ──────────────────────────────────────────
  private dxAcc = 0;
  private dyAcc = 0;
  private keysMask = 0;
  private va = 0;
  /** 解耦帧本地版本（writeDecoupled 递增；独立于耦合 va）。 */
  private vd = 0;
  /** 解耦发布节流基准（performance.now()）。 */
  private lastDecoupledPublishMs = 0;

  /** 消息发送目标：主线程侧 = Worker 引用；Worker 侧 = null（用 self.postMessage）。 */
  private readonly worker: Worker | null;

  constructor(worker: Worker | null) {
    this.worker = worker;
  }

  private post(msg: Record<string, unknown>): void {
    if (this.worker) {
      this.worker.postMessage(msg);
    } else {
      self.postMessage(msg);
    }
  }

  // ── 主线程侧 ───────────────────────────────────────────────

  /** 输入 → postMessage `input`（每帧一次；增量累积由 Worker 端缓冲）。 */
  addInput(dx: number, dy: number, keysMask: number): void {
    this.post({ type: 'input', dx, dy, keys: keysMask });
  }

  /** 读最近权威帧（Worker `phys-frame` 消息缓存）。 */
  readAuthoritative(): { frame: AuthFrame; va: number } | null {
    return this.latest;
  }

  /**
   * 零分配读权威帧 + tick 协议三元组（布局契约同 ShmState.readAuthoritativeInto：
   * dstF64[0..9]=pos×3/yaw/pitch/vel×3/eyeHeight/timeMs，dstI32[0..4]=onGround/
   * va/seg/tick/evt）。MsgState 消息即快照，无跨线程读写竞态——返回契约对齐
   * Shm（≥0；冲突返回值 −1 在本路径不出现）。
   */
  readAuthoritativeInto(dstF64: Float64Array, dstI32: Int32Array): number {
    const l = this.latest;
    if (l === null) return 0;
    const f = l.frame;
    dstF64[0] = f.pos.x;
    dstF64[1] = f.pos.y;
    dstF64[2] = f.pos.z;
    dstF64[3] = f.yaw;
    dstF64[4] = f.pitch;
    dstF64[5] = f.vel.x;
    dstF64[6] = f.vel.y;
    dstF64[7] = f.vel.z;
    dstF64[8] = f.eyeHeight;
    dstF64[9] = f.timeMs;
    dstI32[0] = f.onGround ? 1 : 0;
    dstI32[1] = l.va;
    dstI32[2] = this.segCur;
    dstI32[3] = this.tickCur;
    dstI32[4] = this.evtCur;
    return l.va;
  }

  /** 读最新解耦帧（无新帧也返回最近帧；vd 不变——同 ShmState 语义）。 */
  readDecoupled(): { frame: AuthFrame; vd: number } | null {
    return this.latestDecoupled;
  }

  /** 主线程背压唤醒（MsgState 无阻塞原语，no-op——解耦循环由 setTimeout 自驱）。 */
  wake(): void {
    /* MsgState 回退：无 SAB 原子原语可挂起/唤醒；解耦线 setTimeout 自驱，无需唤醒 */
  }

  /** 主线程接收 `phys-frame`（app.ts onmessage 调用）。meta = tick 协议三元组
   * （MsgState 回退双喂，plan-v2 §1.3.1；缺省=耦合/解耦消息零感知）。 */
  recvFrame(frame: AuthFrame, va: number, meta?: AuthPublishMeta): void {
    if (meta !== undefined) {
      if (meta.seg !== undefined) this.segCur = meta.seg;
      if (meta.tick !== undefined) this.tickCur = meta.tick;
      this.evtCur = meta.evt ?? 0;
    }
    this.latest = { frame, va };
    // 双模式扩展：同载荷喂解耦缓存（mode 内互斥运行——耦合期 readDecoupled 无消费者；
    // 解耦期 phys-frame 即解耦帧，§3.3 复用现有消息形态）
    this.latestDecoupled = { frame, vd: va };
  }

  // ── Worker 侧 ──────────────────────────────────────────────

  /** Worker 接收 `input` 消息（dispatch 调用）：累积 + 键位覆盖（同 SAB 语义）。 */
  recvInput(dx: number, dy: number, keys: number): void {
    this.dxAcc += dx;
    this.dyAcc += dy;
    this.keysMask = keys; // 无条件覆盖：反映"当前按键状态"，松手即清零
  }

  /** 消耗输入（清空缓冲 + maxStep 截断，语义同 SAB takeInput）。 */
  takeInput(maxStep: number): InputSample {
    const clamp = (v: number): number => Math.max(-maxStep, Math.min(maxStep, v));
    const dx = clamp(this.dxAcc);
    const dy = clamp(this.dyAcc);
    this.dxAcc = 0;
    this.dyAcc = 0;
    return { dx, dy, keysMask: this.keysMask };
  }

  /** 非消耗读当前键位掩码（解耦 tickPhys 边界快照用；不消费增量）。 */
  peekKeys(): number {
    return this.keysMask;
  }

  /** 消耗输入（CAS 清零不限幅——解耦 1ms 真理源实时消费；与 takeInput(maxStep) 并存）。 */
  consumeInput(): InputSample {
    const dx = this.dxAcc;
    const dy = this.dyAcc;
    this.dxAcc = 0;
    this.dyAcc = 0;
    return { dx, dy, keysMask: this.keysMask };
  }

  /** 清空未消费输入增量（同步瞬间；键位保留，同 SAB resetInput）。 */
  resetInput(): void {
    this.dxAcc = 0;
    this.dyAcc = 0;
  }

  /** Worker 写权威帧 → postMessage `phys-frame`。meta 提供时消息附带
   * seg/tick/evt（tick 协议双喂，plan-v2 §1.3.1）；缺省=既有消息形态零变化。 */
  writeAuthoritative(a: Omit<AuthFrame, 'onGround'>, onGround: boolean, meta?: AuthPublishMeta): number {
    this.va++;
    const frame = { ...a, onGround };
    if (meta === undefined) {
      this.post({ type: 'phys-frame', va: this.va, frame });
    } else {
      this.post({
        type: 'phys-frame',
        va: this.va,
        frame,
        seg: meta.seg,
        tick: meta.tick,
        evt: meta.evt ?? 0,
      });
    }
    return this.va;
  }

  /** Worker 写解耦帧 → postMessage `phys-frame`（同消息形态，publishFloorMs 节流；
   * 被节流丢弃的间隔内物理照常推进，仅发布降频——§3.3）。 */
  writeDecoupled(frame: AuthFrame): void {
    const now = performance.now();
    if (now - this.lastDecoupledPublishMs < MsgState.publishFloorMs) return;
    this.lastDecoupledPublishMs = now;
    this.vd++;
    this.post({ type: 'phys-frame', va: this.vd, frame });
  }

  /** 背压挂起（MsgState 无 SAB 原子原语——立即返回未唤醒，循环由 setTimeout 自驱）。 */
  waitWakeup(_timeoutMs: number): boolean {
    return false;
  }
}

// ── 共享内存通道 ──────────────────────────────────────────────

export class ShmState {
  readonly isShared = true;
  private readonly i32: Int32Array;
  private readonly b64: BigInt64Array;

  constructor(buffer: SharedArrayBuffer) {
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
   * 清空未消费的输入增量（渲染主线 → 权威同步瞬间调用）：丢弃同步前的
   * 残留鼠标增量，防止旧输入注入新状态；键位（keysMask）保留——按键
   * 按住状态是实时的，清掉会导致丢按键。
   */
  resetInput(): void {
    Atomics.store(this.b64, B_DX_ACC, 0n);
    Atomics.store(this.b64, B_DY_ACC, 0n);
  }

  // ── 双模式扩展（phys-mode-port §3.3/§3.4.B，additive）─────────

  /** 非消耗读当前键位掩码（解耦 tickPhys 边界快照用——键位是"当前状态"
   * 覆盖写，读边界时刻的当前值 = 真实 64t 服务器语义）。 */
  peekKeys(): number {
    return Atomics.load(this.i32, I_KEYS);
  }

  /** 非消耗读当前输入（F4-C scratch 乐观评估投影用，任务 t4）：读 B_DX/B_DY
   * 累加器**不清零**——真实 tick 仍经 takeInput 全窗消费（Crux-1 输入台账单源：
   * 乐观评估是 peek 投影、绝不成为第二消费者）。截断同 takeInput(maxStep)
   * 饱和定点比较；键位读当前掩码。仅 ShmState（SAB）提供——MsgState 回退
   * 无乐观路径（消费器回落 pure-history，t2 语义评审 F4 降级链）。 */
  peekInput(maxStep: number): InputSample {
    const dxFixed = Atomics.load(this.b64, B_DX_ACC);
    const dyFixed = Atomics.load(this.b64, B_DY_ACC);
    const maxStepFixed = BigInt(Math.round(maxStep * 1000));
    const dxAbs = dxFixed < 0n ? -dxFixed : dxFixed;
    const dyAbs = dyFixed < 0n ? -dyFixed : dyFixed;
    const dxClamped = dxAbs > maxStepFixed ? maxStepFixed : dxAbs;
    const dyClamped = dyAbs > maxStepFixed ? maxStepFixed : dyAbs;
    return {
      dx: Number(dxFixed < 0n ? -dxClamped : dxClamped) / 1000,
      dy: Number(dyFixed < 0n ? -dyClamped : dyClamped) / 1000,
      keysMask: Atomics.load(this.i32, I_KEYS),
    };
  }

  /** 消耗输入（CAS 清零，不限幅——解耦 1ms 真理源实时消费完整帧增量；
   * 与 takeInput(maxStep) 饱和截断并存，各归各线）。 */
  consumeInput(): InputSample {
    const dxFixed = this.exchangeZero(B_DX_ACC);
    const dyFixed = this.exchangeZero(B_DY_ACC);
    return {
      dx: Number(dxFixed) / 1000,
      dy: Number(dyFixed) / 1000,
      keysMask: Atomics.load(this.i32, I_KEYS),
    };
  }

  /** CAS 清零：原子地"读出累加值并归零"，返回读出的定点增量。 */
  private exchangeZero(idx: number): bigint {
    let cur = Atomics.load(this.b64, idx);
    for (;;) {
      const res = Atomics.compareExchange(this.b64, idx, cur, 0n);
      if (res === cur) return cur;
      cur = res;
    }
  }

  /**
   * Worker 写解耦帧：写空闲槽 S_D[V_D&1] → release 递增 V_D（协议同
   * writeAuthoritative）；onGround 复用 i32[2]（模式互斥运行，同一槽位两模式
   * 顺序使用——耦合线停写期间仅解耦线写它）。
   */
  writeDecoupled(frame: AuthFrame): void {
    const slot = Atomics.load(this.i32, I_V_D) & 1;
    const base = slot === 0 ? B_D0 : B_D1;
    const b = this.b64;
    b[base] = BigInt(Math.round(frame.pos.x * 100));
    b[base + 1] = BigInt(Math.round(frame.pos.y * 100));
    b[base + 2] = BigInt(Math.round(frame.pos.z * 100));
    b[base + 3] = BigInt(Math.round(frame.yaw * 1000));
    b[base + 4] = BigInt(Math.round(frame.pitch * 1000));
    b[base + 5] = BigInt(Math.round(frame.vel.x * 100));
    b[base + 6] = BigInt(Math.round(frame.vel.y * 100));
    b[base + 7] = BigInt(Math.round(frame.vel.z * 100));
    b[base + 8] = BigInt(Math.round(frame.eyeHeight * 100));
    b[base + 9] = BigInt(Math.round(frame.timeMs));
    // 状态先于版本号可见（release）
    const vd = Atomics.load(this.i32, I_V_D) + 1;
    this.i32[I_A_GROUND] = frame.onGround ? 1 : 0;
    Atomics.store(this.i32, I_V_D, vd);
  }

  /**
   * 读最新解耦帧（双缓冲槽 (V_D-1)&1，无撕裂；无新帧也返回最近帧）。
   * @returns { frame, vd } 解耦帧 + 版本号；V_D=0（未开始）返回 null。
   */
  readDecoupled(): { frame: AuthFrame; vd: number } | null {
    const vd = Atomics.load(this.i32, I_V_D);
    if (vd === 0) return null;
    const slot = (vd - 1) & 1; // 写者已离开的槽
    const b = this.b64;
    const base = slot === 0 ? B_D0 : B_D1;
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
      vd,
    };
  }

  /** 主线程背压唤醒（rAF 每帧调用）：store(1) 电平 + notify 单等待者。 */
  wake(): void {
    Atomics.store(this.i32, I_WAKEUP, 1);
    Atomics.notify(this.i32, I_WAKEUP, 1);
  }

  /**
   * 解耦线物理背压：wait(WAKEUP, 0, timeoutMs) 挂起（可被 wake 提前唤醒）。
   * 复位用 CAS(1→0)：'ok'/'not-equal' 时值必为 1（wake 已置位），CAS 消费本次唤醒；
   * 'timed-out' 时跳过复位——超时窗口内新到的 store(1) 保留给下一轮立即消费
   * （无条件 store(0) 会把窗口内新唤醒清掉，造成唤醒丢失；harness waitWakeup 同式）。
   * @returns 是否被唤醒（'ok' 或 'not-equal'）；超时返回 false。
   */
  waitWakeup(timeoutMs: number): boolean {
    const res = Atomics.wait(this.i32, I_WAKEUP, 0, timeoutMs);
    if (res === 'timed-out') return false;
    Atomics.compareExchange(this.i32, I_WAKEUP, 1, 0);
    return true;
  }

  /**
   * Worker 写权威帧：写空闲槽 S_A[V_A&1] → release 递增 V_A。
   *
   * tick 模式协议（meta 提供时，t3-memo §2.5 写序 + t2 语义评审 F1 成对修复
   * 的 f' 序）：帧值 → PSEQ 奇数 → seg/tick/evt/ground（全 Atomics.store，F2）
   * → release V_A → PSEQ 偶数（最后一步）。f' 序要点：VA release 挪到三元组
   * 之后、PSEQ 偶之前——「PS 偶已稳定 ⇒ VA 已 ≥ 本代」恒成立，读侧 VA 复检
   * 据此封死「v1 陈旧 × 三元组已新代」的跨代混合接受窗口（F1 本体；单改任一
   * 边不完备，论证见 temp/phys-plan-discuss/t2-semantic-review-protocol-engineer.md）。
   * meta 缺省（耦合/解耦）：逐字节保持 v7 行为（PSEQ 与三槽零触碰，additive-only）。
   */
  writeAuthoritative(a: Omit<AuthFrame, 'onGround'>, onGround: boolean, meta?: AuthPublishMeta): number {
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
    if (meta === undefined) {
      this.i32[I_A_GROUND] = onGround ? 1 : 0;
      Atomics.store(this.i32, I_V_A, va);
      return va;
    }
    // tick 模式：seqlock 发布（写者侧，f' 序）——onGround 一并纳入守卫集；
    // 协议槽写全 Atomics.store（F2：SAB 内存模型规范；耦合路径 621 行零触碰不动）
    const pseq = Atomics.load(this.i32, I_A_PSEQ);
    Atomics.store(this.i32, I_A_PSEQ, pseq + 1);
    if (meta.seg !== undefined) Atomics.store(this.i32, I_A_SEG, meta.seg);
    if (meta.tick !== undefined) Atomics.store(this.i32, I_A_TICK, meta.tick);
    Atomics.store(this.i32, I_A_EVT, meta.evt ?? 0);
    Atomics.store(this.i32, I_A_GROUND, onGround ? 1 : 0);
    Atomics.store(this.i32, I_V_A, va); // release：帧值+三元组+ground 全可见
    Atomics.store(this.i32, I_A_PSEQ, pseq + 2); // 偶=本代完整可见（最后一步）
    return va;
  }

  /**
   * 零分配读权威帧 + tick 协议三元组（tick 模式消费器热路径，t3-memo §3.2 #1）。
   *
   * dstF64[0..9] = posX,posY,posZ,yaw,pitch,velX,velY,velZ,eyeHeight,timeMs
   *   （定点还原：pos/vel/eyeHeight ÷100，yaw/pitch ÷1000，timeMs 原值 ms）
   * dstI32[0..4] = onGround(0/1), va, segId, tickIndex, evtBits
   *
   * 一致性（t2 语义评审 F1 修复后）：帧值经双缓冲槽（写者只写空闲槽，读者槽
   * 天然无撕裂）；onGround+seg/tick/evt 四元组经 I_A_PSEQ seqlock（Atomics.load
   * 配对读，F3）——读窗口内有发布序翻转即弃读重试；PSEQ 复检后再加 V_A 代际
   * 配对复检（「v1 读取早于写者 VA release、偶值快照晚于 PS 偶」窗口的唯一
   * 守卫：PSEQ 已稳定新代偶值而 v1 陈旧 → 必须重试，防 va=X−1 + 第 X 帧三元组
   * 跨代混合被接受）。写侧 f' 序（VA release 先于 PS 偶）+ 读侧 VA 复检成对
   * 封死该窗口（单改任一边不完备）。
   *
   * @returns va（≥1，成功）；0 = 通道未开始（V_A=0，dst 未动）；
   *          −1 = 读写冲突（连两次撞发布，dst 内容弃用——消费器跳过本轮、
   *          下一 rAF 重读；≠「通道未开始」，勿触发重引导）。
   *
   * @param probe 读侧一致性探针（仅测试接缝，生产恒 undefined）：单线程
   *              node 单测无法真实交错写者，三处可选回调把「写者读中插入」
   *              确定性注入；不传时行为与探针不存在完全一致（零开销热路径）。
   */
  readAuthoritativeInto(dstF64: Float64Array, dstI32: Int32Array, probe?: ReadProbe): number {
    for (let attempt = 0; attempt < 2; attempt++) {
      const va = Atomics.load(this.i32, I_V_A);
      if (va === 0) return 0;
      probe?.afterVaLoad?.(); // 测试接缝（F1）：VA 读取后、偶值快照前（生产 undefined）
      const pseq0 = Atomics.load(this.i32, I_A_PSEQ);
      if ((pseq0 & 1) !== 0) continue; // 写者正发布（奇数态）——重试
      probe?.afterEvenSnapshot?.(pseq0); // 测试接缝：模拟写者读中插入（生产 undefined）
      const slot = (va - 1) & 1; // 写者已离开的槽
      const base = slot === 0 ? B_A0 : B_A1;
      const b = this.b64;
      dstF64[0] = Number(b[base]) / 100;
      dstF64[1] = Number(b[base + 1]) / 100;
      dstF64[2] = Number(b[base + 2]) / 100;
      dstF64[3] = Number(b[base + 3]) / 1000;
      dstF64[4] = Number(b[base + 4]) / 1000;
      dstF64[5] = Number(b[base + 5]) / 100;
      dstF64[6] = Number(b[base + 6]) / 100;
      dstF64[7] = Number(b[base + 7]) / 100;
      dstF64[8] = Number(b[base + 8]) / 100;
      dstF64[9] = Number(b[base + 9]);
      dstI32[0] = Atomics.load(this.i32, I_A_GROUND) === 1 ? 1 : 0; // F3：与写侧 Atomics.store 配对
      dstI32[1] = va;
      dstI32[2] = Atomics.load(this.i32, I_A_SEG); // F3：四元组原子读
      dstI32[3] = Atomics.load(this.i32, I_A_TICK);
      dstI32[4] = Atomics.load(this.i32, I_A_EVT);
      probe?.beforeRecheck?.(); // 测试接缝：复检前注入发布（生产 undefined）
      if (Atomics.load(this.i32, I_A_PSEQ) !== pseq0) continue; // 发布序翻转——三元组弃用
      if (Atomics.load(this.i32, I_V_A) !== va) continue; // 代际配对复检（F1 新增）
      return va;
    }
    return -1;
  }
}

/**
 * 读侧一致性探针（ShmState.readAuthoritativeInto 测试接缝；生产恒 undefined）。
 * 单线程 node 单测无法真实交错写者——三处回调把「写者读中插入」确定性注入：
 * - afterVaLoad()：V_A 读取后、偶值快照前（F1 场景：写者整段发布插入此窗 →
 *   v1 陈旧 × pseq0 已新代偶值 → 唯 VA 复检可拒，防跨代混合返回）；
 * - afterEvenSnapshot(pseq0)：偶值快照取得后、读值前（此后插入发布 → 复检必翻
 *   → 走重试路径，验证「弃旧代、取新代」防跨代混合核心语义）；
 * - beforeRecheck()：值读取完成后、复检前（同上，注入窗更窄）。
 * 各回调每 attempt 至多一次调用——测试侧用闭包状态控制只触发一次。
 */
export interface ReadProbe {
  afterVaLoad?: () => void;
  afterEvenSnapshot?: (pseq0: number) => void;
  beforeRecheck?: () => void;
}

/** 跨线程状态通道（SAB / MsgState 统一类型）。 */
export type SharedState = ShmState | MsgState;

/** 主线程侧创建：crossOriginIsolated（本地 serve.py COOP/COEP）→ SAB 高性能；
 * 否则（线上静态部署无 COOP/COEP）→ MsgState postMessage 回退（功能等价，性能降级）。 */
export function createMainSharedState(
  buffer: SharedArrayBuffer | null,
  worker: Worker,
): ShmState | MsgState {
  return buffer ? new ShmState(buffer) : new MsgState(worker);
}

/** Worker 侧创建（init.shared 为 null = MsgState 回退）。 */
export function createWorkerSharedState(buffer: SharedArrayBuffer | null): ShmState | MsgState {
  return buffer ? new ShmState(buffer) : new MsgState(null);
}
