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
 *     [5-15] 保留
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

// BigInt64 输入槽
const B_DX_ACC = 8;
const B_DY_ACC = 9;

// BigInt64 权威帧双缓冲基址（每帧 10 值）
const B_A0 = 16;
const B_A1 = 26;

// BigInt64 解耦帧双缓冲基址（字节 288-447；与 S_A 同款 10 值定点编码）
const B_D0 = 36;
const B_D1 = 46;

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

  /** 读最新解耦帧（无新帧也返回最近帧；vd 不变——同 ShmState 语义）。 */
  readDecoupled(): { frame: AuthFrame; vd: number } | null {
    return this.latestDecoupled;
  }

  /** 主线程背压唤醒（MsgState 无阻塞原语，no-op——解耦循环由 setTimeout 自驱）。 */
  wake(): void {
    /* MsgState 回退：无 SAB 原子原语可挂起/唤醒；解耦线 setTimeout 自驱，无需唤醒 */
  }

  /** 主线程接收 `phys-frame`（app.ts onmessage 调用）。 */
  recvFrame(frame: AuthFrame, va: number): void {
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

  /** Worker 写权威帧 → postMessage `phys-frame`。 */
  writeAuthoritative(a: Omit<AuthFrame, 'onGround'>, onGround: boolean): number {
    this.va++;
    this.post({
      type: 'phys-frame',
      va: this.va,
      frame: { ...a, onGround },
    });
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
