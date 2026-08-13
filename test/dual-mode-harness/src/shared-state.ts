/**
 * WebSurf-test 共享内存布局（SAB 无锁通信，与 README 最新时序图一致）。
 *
 * 布局（Int32 索引 / 字节偏移）：
 *
 * ┌─ 控制区 ────────────────────────────────────────────────
 * │ [0]   字节 0..3    TICK_RATE  Int32    动态难度（64/128/256/1000；阶段0 仅 store，无 notify）
 * │ [1]   字节 4..7    WAKEUP     Int32    唤醒信号（阶段1 store(1)+notify → WorkerA wait 立即返回）
 * ├─ 输入槽 ────────────────────────────────────────────────
 * │ [2]   字节 8..15   dxAcc      BigInt64（BigInt64 索引 1）鼠标增量累加（主线程 add / WorkerA CAS 消费）
 * │ [4]   字节 16..23  dyAcc      BigInt64（BigInt64 索引 2）
 * │ [6]   字节 24..27  keysMask   Int32    当前键位掩码（store 覆盖，松手即清零）
 * │ [7]   字节 28..31  RENDER_WAKEUP Int32  渲染唤醒信号（WorkerB 专用槽——与 WAKEUP 分离，
 * │                                         防 WorkerA 背压抢唤醒/帧边界抖动；主线程 wake() 双槽通知）
 * ├─ 状态槽（双缓冲 S[2]）──────────────────────────────────
 * │ [8]   字节 32..35  V          Int32    版本号（WorkerA add 递增 / WorkerB acquire 读）
 * │ 槽0   Float64 [5..12]  字节 40..103   pos×3 / vel×3 / yaw / pitch
 * │ 槽1   Float64 [13..20] 字节 104..167  pos×3 / vel×3 / yaw / pitch
 * └─ 168B 起为末尾（SHARED_BUFFER_SIZE = 192B）
 *
 * 读写协议（最新时序图）：
 * - 控制区：阶段0 主线程 store TICK_RATE（仅 store，不 notify——WorkerA 每轮循环自动识别）；
 *   WAKEUP 槽承载阶段1 物理背压唤醒：wake() = store(WAKEUP,1) + notify(WAKEUP,1)
 *   （WorkerA 专用，背压 wait 挂起其上）；
 *   RENDER_WAKEUP 槽承载渲染唤醒：**主驱动 = 主线程 rAF 帧信号**（wake() 的
 *   store+notify——vsync 对齐，渲染节奏 = 显示器刷新）；**WorkerA 发布不 notify**
 *   （1kHz 随机相位唤醒 → 渲染/呈现时间不规则 → 观感抖动；醒后只读最新槽）；
 *   主线程停摆 → WorkerB 超时兜底自驱；两槽分离——物理背压与渲染帧对齐
 *   互不干扰（WorkerA 抢唤醒不再拖延渲染帧边界）
 * - 输入槽：主线程 Atomics.add 累加（无上限），WorkerA consumeInput(maxDelta) CAS 清零消费 + 限幅
 * - 状态槽双缓冲：writeState/writeStateRaw 写"当前 V 的另一槽"（S[V&1 ^ 1]，不覆盖读槽）→ Atomics.add(V,1)；
 *   readState acquire 读 V，V 未变返回 null（非阻塞采样），否则读当前槽 S[V&1]（double-check 防撕裂）
 *
 * ── 消息回退模式（无 SAB：file:// 无 COOP/COEP / 旧浏览器）────────────────
 * TestShared 同一 API 双实现：'msg-*' 模式不走 SAB，全部经 postMessage——
 * - msg-main（主线程）：addInput/writeTickRate → 投递 {type:'shared-input'} /
 *   {type:'shared-tick-rate'} 给 WorkerA；wake() 无操作（消息模式双 Worker 均自驱）
 * - msg-physics（WorkerA）：consumeInput 读本地累加（onInputMessage 填充）；
 *   writeStateRaw → 本地 V++ → 投递 {type:'shared-state'} 给 WorkerB（直连 MessageChannel）；
 *   waitWakeup 立即超时返回 false（无阻塞原语，MessageChannel 自投递续环即自驱）
 * - msg-render（WorkerB）：readState 返回最近一条 shared-state（onStateMessage 缓存），
 *   V 未变返回 null（重绘判定与 SAB 模式一致）；waitRenderWakeup 立即返回 false
 * 语义等价性：V 版本/仅状态更新重绘/输入限幅/难度识别全部保留，仅传输介质不同。
 */

// ── 键位掩码（与 Rust src/phys/mod.rs apply_input 位定义一致）────────
export const KEY_MASK = {
  forward: 1,
  backward: 2,
  left: 4,
  right: 8,
  jump: 16,
} as const;

/** 键位掩码 → boolean 集合（main 键盘状态 → 掩码）。 */
export function keysToMask(keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; jump: boolean }): number {
  let m = 0;
  if (keys.forward) m |= KEY_MASK.forward;
  if (keys.backward) m |= KEY_MASK.backward;
  if (keys.left) m |= KEY_MASK.left;
  if (keys.right) m |= KEY_MASK.right;
  if (keys.jump) m |= KEY_MASK.jump;
  return m;
}

// ── SAB 布局偏移常量（Int32 索引；BigInt64 槽占 2 个 Int32 索引）──────

/** 控制区：TICK_RATE（Int32）。 */
const I_TICK_RATE = 0;
/** 控制区：WAKEUP 物理背压唤醒信号（Int32，WorkerA 专用槽）。 */
const I_WAKEUP = 1;

/** 输入槽：dxAcc / dyAcc（BigInt64 原子累加）。BigInt64 索引 1/2 → 字节 8..15 / 16..23。
 * 注意：BigInt64Array 索引 1 = 字节 8..15（Int32 索引 2..3）、索引 2 = 字节 16..23（Int32 4..5）；
 * 此前误用 2/4（= 字节 16..23 / 32..39）导致 dyAcc 与 V（Int32 8，字节 32..35）重叠——
 * 主线程 addInput(dy≠0) 会污染 V、writeState 的 V++ 会破坏 dyAcc（屏闪根因，已修复）。 */
const B_DX_ACC = 1;
const B_DY_ACC = 2;
/** 输入槽：keysMask（Int32 覆盖写）。 */
const I_KEYS_MASK = 6;

/** 控制区：RENDER_WAKEUP 渲染帧对齐唤醒信号（Int32，WorkerB 专用槽）。
 * 与 WAKEUP 分离：WorkerA 物理背压与 WorkerB 渲染帧循环不再挂起同一槽——
 * 物理 wait 的 CAS 复位不再"抢"渲染唤醒（帧边界抖动/一帧双绘根因）。
 * **计数语义**（Atomics.add 递增，非 store 电平）：主线程每 rAF add+1；
 * WorkerB waitRenderWakeup 记录 lastRenderWake 消费差值——渲染完成后
 * absorbRenderWake 吸收渲染期间到达的信号（合并丢弃），渲染频率严格 =
 * min(显示器刷新率, GPU 渲染耗时)，杜绝忙循环超限（渲染快时不会 > 刷新率）。 */
const I_RENDER_WAKEUP = 7;

/** 状态槽：V 版本号（Int32，Atomics.add 递增）。 */
const I_V = 8;

/** 双缓冲 S[2]：每槽 8 个 Float64（pos×3/vel×3/yaw/pitch）。槽 s 起始 Float64 索引。 */
const F_SLOT_BASE = 5;
const F_SLOT_STRIDE = 8;
/** 槽内字段相对偏移（Float64 索引）。 */
const F_POS_X = 0;
const F_POS_Y = 1;
const F_POS_Z = 2;
const F_VEL_X = 3;
const F_VEL_Y = 4;
const F_VEL_Z = 5;
const F_YAW = 6;
const F_PITCH = 7;

/** 定点缩放：鼠标增量 ×1000 存 BigInt64（与 game ts-shared 一致）。 */
const FIXED_SCALE = 1000;

/** SAB 总字节数（布局实际使用至 168B，对齐取 192B）。 */
export const SHARED_BUFFER_SIZE = 192;

// ── 数据结构 ────────────────────────────────────────────────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** WorkerA 写入 / WorkerB 采样的完整状态。 */
export interface SharedStateData {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  /** 读取到的版本号。 */
  v: number;
}

/** WorkerA consumeInput 返回的输入样本。 */
export interface InputSample {
  dx: number;
  dy: number;
  keysMask: number;
}

// ── 消息回退模式协议（无 SAB：postMessage 载荷；类型字段与 SAB 槽语义一一对应）──

/** 主线程 → WorkerA：每 rAF 输入批次（等价 SAB 输入槽 addInput 一次）。 */
export interface SharedInputMsg {
  type: 'shared-input';
  dx: number;
  dy: number;
  keysMask: number;
}

/** WorkerA → WorkerB：状态发布（等价 writeStateRaw + V++ 一次；直连 MessageChannel）。 */
export interface SharedStateMsg {
  type: 'shared-state';
  v: number;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
}

/** 主线程 → WorkerA：难度调节（等价 writeTickRate 一次）。 */
export interface SharedTickRateMsg {
  type: 'shared-tick-rate';
  rate: number;
}

/** TestShared 工作模式：'sab' 共享内存 / 'msg-*' 消息回退（无 SAB 环境自适应）。 */
type TestSharedMode = 'sab' | 'msg-main' | 'msg-physics' | 'msg-render';

/**
 * 共享内存通道（SAB 直连）。SAB 不可用（file:// 无 COOP/COEP / 旧浏览器）时
 * 用消息回退模式（createMessaging/initMessaging/initMessagingRender）——
 * 同一 API 双实现，输入/状态/难度经 postMessage，V 版本与重绘语义等价。
 */
export class TestShared {
  private readonly mode: TestSharedMode;
  /** SAB 模式视图（msg-* 模式为空视图占位，方法按 mode 分支不触碰）。 */
  private readonly i32: Int32Array;
  private readonly b64: BigInt64Array;
  private readonly f64: Float64Array;
  /** readState 上次见到的版本号（acquire 读 V 比对，未变返回 null）。 */
  private lastV = 0;
  /** waitRenderWakeup 上次消费的唤醒计数（SAB 计数语义：每 rAF 一次 add，
   * 渲染循环消费差值——渲染快时不会忙循环超过刷新率）。 */
  private lastRenderWake = 0;

  // ── 消息回退模式状态（msg-* 模式专用；SAB 模式不使用）──
  /** msg-physics 本地输入累加（main 的 shared-input 消息 onInputMessage 填充）。 */
  private msgDx = 0;
  private msgDy = 0;
  private msgKeysMask = 0;
  /** msg-physics 本地难度（main 的 shared-tick-rate 消息填充）。 */
  private msgTickRate = 0;
  /** msg-physics 本地版本号（writeStateRaw 递增，随 shared-state 投递）。 */
  private msgV = 0;
  /** msg-render 最近一条状态缓存（onStateMessage 更新；readState 消费）。 */
  private msgLatest: SharedStateData | null = null;
  /** msg-main：输入/难度消息投递目标（WorkerA）。 */
  private readonly postToPhysics?: (msg: unknown) => void;
  /** msg-physics：状态发布目标（WorkerB 直连端口）。 */
  private readonly postToRender?: (msg: unknown) => void;

  private constructor(
    buffer: SharedArrayBuffer | null,
    mode: TestSharedMode,
    postToPhysics?: (msg: unknown) => void,
    postToRender?: (msg: unknown) => void,
  ) {
    this.mode = mode;
    if (buffer) {
      this.i32 = new Int32Array(buffer);
      this.b64 = new BigInt64Array(buffer);
      this.f64 = new Float64Array(buffer);
    } else {
      // msg-* 模式：空视图占位（方法按 mode 分支，不会触碰 SAB 视图）
      this.i32 = new Int32Array(0);
      this.b64 = new BigInt64Array(0);
      this.f64 = new Float64Array(0);
    }
    this.postToPhysics = postToPhysics;
    this.postToRender = postToRender;
  }

  /** 包装既有 SAB（Worker 侧收到 init-shared 后调用）。 */
  static init(buffer: SharedArrayBuffer): TestShared {
    return new TestShared(buffer, 'sab');
  }

  /**
   * 暴露 SAB（WorkerA 背压 wait/阶段1 wake 与阶段0 store 共用同一缓冲区）。
   */
  get sab(): SharedArrayBuffer {
    return this.i32.buffer as SharedArrayBuffer;
  }

  /** 是否消息回退模式（msg-*：无阻塞原语，循环需自节流，见 worker-b.ts）。 */
  get isMessageMode(): boolean {
    return this.mode !== 'sab';
  }

  /** 主线程创建：包装 SAB 并 postMessage 给 WorkerA（SAB 共享传递，**不可放 transfer list**）。 */
  static create(buffer: SharedArrayBuffer, worker: Worker): TestShared {
    const s = new TestShared(buffer, 'sab');
    worker.postMessage({ type: 'init-shared', shared: buffer });
    return s;
  }

  // ── 消息回退模式工厂（无 SAB 环境：file:// 无 COOP/COEP / 旧浏览器）──

  /**
   * 主线程侧（msg-main）：addInput/writeTickRate → postMessage 到 WorkerA
   * （载荷：SharedInputMsg / SharedTickRateMsg）；wake() 无操作。
   */
  static createMessaging(workerA: Worker): TestShared {
    return new TestShared(null, 'msg-main', (msg) => workerA.postMessage(msg as never));
  }

  /**
   * WorkerA 侧（msg-physics）：consumeInput 读本地累加（onInputMessage 填充）；
   * writeStateRaw → 本地 V++ → postToRender 投递 SharedStateMsg（直连 WorkerB 端口）。
   */
  static initMessaging(postToRender: (msg: unknown) => void): TestShared {
    return new TestShared(null, 'msg-physics', undefined, postToRender);
  }

  /** WorkerB 侧（msg-render）：readState 返回 onStateMessage 缓存的最近状态。 */
  static initMessagingRender(): TestShared {
    return new TestShared(null, 'msg-render');
  }

  // ── 控制区（主线程写 / WorkerA 读）──────────────────────────

  /**
   * 阶段0 动态难度调节：仅 store 新 TICK_RATE（无 notify）。
   * 唤醒职责已移交 WAKEUP 槽（阶段1 wake），WorkerA 背压不再挂起在 TICK_RATE 上。
   */
  writeTickRate(rate: number): void {
    if (this.mode === 'msg-main') {
      // 消息回退：投递 SharedTickRateMsg（WorkerA onTickRateMessage 收）
      this.postToPhysics?.({ type: 'shared-tick-rate', rate });
      return;
    }
    Atomics.store(this.i32, I_TICK_RATE, rate);
  }

  /** 读当前 TICK_RATE（WorkerA 每轮循环 / WorkerB 抽帧间隔计算）。 */
  readTickRate(): number {
    if (this.mode === 'msg-physics') {
      return this.msgTickRate; // 主线程 shared-tick-rate 消息已缓存
    }
    return Atomics.load(this.i32, I_TICK_RATE);
  }

  /** 非消耗读当前键位掩码（模式B tick 边界采样用——不消费累积鼠标增量；
   * 键位是"当前状态"覆盖写，读边界时刻的当前值 = 真实 64t 服务器语义）。 */
  peekKeys(): number {
    if (this.mode === 'msg-physics') {
      return this.msgKeysMask; // 最近一条 shared-input 消息的键位
    }
    return Atomics.load(this.i32, I_KEYS_MASK);
  }

  /**
   * 阶段1 唤醒双 Worker（双槽分离）：WAKEUP → WorkerA 物理背压；RENDER_WAKEUP → WorkerB
   * 渲染帧循环。WAKEUP 用 store 电平 + CAS 复位（单等待者）；RENDER_WAKEUP 用 **计数语义**
   * （Atomics.add 递增）：主线程每 rAF 唤醒一次 → 计数 +1，WorkerB waitRenderWakeup 消费
   * 差值——渲染期间到达的信号由 absorbRenderWake 合并丢弃，渲染频率不会超过刷新率。
   */
  wake(): void {
    if (this.mode === 'msg-main') {
      return; // 消息回退：双 Worker 均消息自驱（MessageChannel 自投递），无阻塞等待可唤醒
    }
    Atomics.store(this.i32, I_WAKEUP, 1);
    Atomics.notify(this.i32, I_WAKEUP, 1);
    Atomics.add(this.i32, I_RENDER_WAKEUP, 1); // 计数 +1（非 store——防止渲染期间覆盖丢失）
    Atomics.notify(this.i32, I_RENDER_WAKEUP, 1);
  }

  /**
   * WorkerA 物理背压：wait(WAKEUP, 0, timeoutMs) 挂起（可被阶段1 wake 提前唤醒），
   * 返回后复位（时序图：挂起 → 复位）。
   * 复位用 CAS(1→0)：'ok'/'not-equal' 时值必为 1（wake 已置位），CAS 消费本次唤醒；
   * 'timed-out' 时跳过复位——超时窗口内新到的 store(1) 保留给下一轮 wait 立即消费
   * （无条件 store(0) 会把窗口内新唤醒清掉，造成唤醒丢失）。
   * @returns 是否被唤醒（'ok' 或 'not-equal'）；超时返回 false。
   */
  waitWakeup(timeoutMs: number): boolean {
    if (this.mode !== 'sab') {
      return false; // 消息回退：无阻塞原语，立即"超时"返回——循环由 MessageChannel 自投递自驱
    }
    const res = Atomics.wait(this.i32, I_WAKEUP, 0, timeoutMs);
    if (res === 'timed-out') return false;
    Atomics.compareExchange(this.i32, I_WAKEUP, 1, 0); // 'ok'/'not-equal'：CAS 消费唤醒并复位
    return true;
  }

  /**
   * WorkerB 渲染帧循环：wait(RENDER_WAKEUP, lastRenderWake, timeoutMs) 挂起在**帧信号槽**上——
   * 主驱动 = 主线程 rAF 的 wake()（Atomics.add RENDER_WAKEUP + notify——vsync 对齐，渲染
   * 节奏 = 显示器刷新，呈现平滑）；WorkerA 发布（writeStateRaw）**不 notify**（仅
   * V++，1kHz 随机相位唤醒已移除——见 writeStateRaw）；超时兜底自驱（主线程 rAF
   * 停摆时仍以自身节奏采样 V，渲染不冻结）。
   * **计数语义**：等待"计数 > lastRenderWake"（非电平），消费差值后更新 lastRenderWake。
   * 渲染完成后须调 absorbRenderWake() 吸收渲染期间新到的信号——否则渲染期间到达的
   * add 会让下次 wait 立即返回 → 忙循环（渲染频率 = 1/渲染耗时，可能远超刷新率）。
   * @returns 是否被唤醒；超时返回 false。
   */
  waitRenderWakeup(timeoutMs: number): boolean {
    if (this.mode !== 'sab') {
      return false; // 消息回退：同 waitWakeup——自投递续环即自驱，无等待
    }
    // 快路径：已有未消费信号（渲染期间到达）→ 直接消费一次
    if (Atomics.load(this.i32, I_RENDER_WAKEUP) !== this.lastRenderWake) {
      this.lastRenderWake = Atomics.load(this.i32, I_RENDER_WAKEUP);
      return true;
    }
    const res = Atomics.wait(this.i32, I_RENDER_WAKEUP, this.lastRenderWake, timeoutMs);
    if (res === 'timed-out') return false;
    // 'ok'/'not-equal'：计数已变（>= lastRenderWake+1），消费到当前值
    this.lastRenderWake = Atomics.load(this.i32, I_RENDER_WAKEUP);
    return true;
  }

  /**
   * 渲染完成后吸收渲染期间新到的唤醒信号（SAB 渲染帧节流关键）：
   * 渲染耗时 < 帧间隔时，主线程在渲染期间仍会 add RENDER_WAKEUP；若不吸收，
   * 下一次 waitRenderWakeup 看到计数变化立即返回 → 忙循环超过刷新率（重复释放
   * 性能上限）。吸收 = 合并丢弃渲染期间到达的信号，渲染频率严格 = 刷新率上限。
   */
  absorbRenderWake(): void {
    if (this.mode !== 'sab') return;
    this.lastRenderWake = Atomics.load(this.i32, I_RENDER_WAKEUP);
  }

  // ── 输入槽（主线程累加写 / WorkerA CAS 消费）──────────────────

  /** 写入累积鼠标增量（BigInt64 原子累加）+ 当前键位掩码（store 覆盖）。 */
  addInput(dx: number, dy: number, keysMask: number): void {
    if (this.mode === 'msg-main') {
      // 消息回退：每 rAF 投递一批 SharedInputMsg（WorkerA onInputMessage 累加）——
      // 无条件投递（含 keysMask=0：松手即清零语义与 SAB 模式一致）
      this.postToPhysics?.({ type: 'shared-input', dx, dy, keysMask });
      return;
    }
    const dxFixed = BigInt(Math.round(dx * FIXED_SCALE));
    const dyFixed = BigInt(Math.round(dy * FIXED_SCALE));
    if (dxFixed !== 0n) Atomics.add(this.b64, B_DX_ACC, dxFixed);
    if (dyFixed !== 0n) Atomics.add(this.b64, B_DY_ACC, dyFixed);
    // 无条件写 keysMask（0 也写）：反映"当前按键状态"，松手即清零
    Atomics.store(this.i32, I_KEYS_MASK, keysMask);
  }

  /**
   * 主线程 shared-input 消息接收（msg-physics）：累加本地输入 + 覆盖键位掩码
   * （与 SAB 模式 addInput 的累加/覆盖语义一致）。
   */
  onInputMessage(dx: number, dy: number, keysMask: number): void {
    this.msgDx += dx;
    this.msgDy += dy;
    this.msgKeysMask = keysMask;
  }

  /** 主线程 shared-tick-rate 消息接收（msg-physics）：更新本地难度。 */
  onTickRateMessage(rate: number): void {
    this.msgTickRate = rate;
  }

  /**
   * 消耗输入（WorkerA 每次 1ms 子步前调用）：CAS 清零累加器——
   * 读当前值 → Atomics.compareExchange 为 0 直到成功，返回累加增量。
   * @param maxDelta 可选限幅（调用方传入，如 ±1000 防穿墙）；缺省 Infinity = 不限幅。
   */
  consumeInput(maxDelta: number = Infinity): InputSample {
    if (this.mode === 'msg-physics') {
      const dx = this.msgDx;
      const dy = this.msgDy;
      this.msgDx = 0;
      this.msgDy = 0;
      if (maxDelta !== Infinity) {
        return {
          dx: Math.max(-maxDelta, Math.min(maxDelta, dx)),
          dy: Math.max(-maxDelta, Math.min(maxDelta, dy)),
          keysMask: this.msgKeysMask,
        };
      }
      return { dx, dy, keysMask: this.msgKeysMask };
    }
    const dxFixed = this.exchangeZero(this.b64, B_DX_ACC);
    const dyFixed = this.exchangeZero(this.b64, B_DY_ACC);
    let dx = Number(dxFixed) / FIXED_SCALE;
    let dy = Number(dyFixed) / FIXED_SCALE;
    if (maxDelta !== Infinity) {
      dx = Math.max(-maxDelta, Math.min(maxDelta, dx));
      dy = Math.max(-maxDelta, Math.min(maxDelta, dy));
    }
    return {
      dx,
      dy,
      keysMask: Atomics.load(this.i32, I_KEYS_MASK),
    };
  }

  /** CAS 清零：原子地"读出累加值并归零"，返回读出的增量。 */
  private exchangeZero(b: BigInt64Array, idx: number): bigint {
    let cur = Atomics.load(b, idx);
    for (;;) {
      const res = Atomics.compareExchange(b, idx, cur, 0n);
      if (res === cur) return cur;
      cur = res;
    }
  }

  // ── 状态槽双缓冲（WorkerA release 写 / WorkerB acquire 非阻塞读）──

  /**
   * WorkerA 写入状态：写"当前 V 的另一槽"（S[V&1 ^ 1]，不覆盖 WorkerB 正在读的 S[V&1]）
   * → Atomics.add(V, 1)（V 递增用 add，Reader 随即切到新槽）。
   * @returns 递增后的新版本号。
   */
  writeState(pos: Vec3, vel: Vec3, yaw: number, pitch: number): number {
    return this.writeStateRaw(pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, yaw, pitch);
  }

  /**
   * 零分配写状态热路径：与 writeState 同语义，但接收 8 个标量（tick_into 直读 wasm
   * 缓冲 → 本方法直写 SAB）——不构造 {x,y,z} Vec3 对象，1kHz 子步热路径零 JS 分配。
   * @returns 递增后的新版本号。
   */
  writeStateRaw(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    yaw: number,
    pitch: number,
  ): number {
    if (this.mode === 'msg-physics') {
      // 消息回退：本地 V++ → 投递 SharedStateMsg（WorkerB onStateMessage 缓存；
      // 载荷对象由 postMessage 结构化克隆——无 SAB 时不可避免，1kHz 下可接受）
      this.msgV++;
      this.postToRender?.({
        type: 'shared-state',
        v: this.msgV,
        pos: { x, y, z },
        vel: { x: vx, y: vy, z: vz },
        yaw,
        pitch,
      });
      return this.msgV;
    }
    const v0 = Atomics.load(this.i32, I_V);
    const base = F_SLOT_BASE + ((v0 & 1) ^ 1) * F_SLOT_STRIDE; // 空闲槽（非读槽）
    const f = this.f64;
    f[base + F_POS_X] = x;
    f[base + F_POS_Y] = y;
    f[base + F_POS_Z] = z;
    f[base + F_VEL_X] = vx;
    f[base + F_VEL_Y] = vy;
    f[base + F_VEL_Z] = vz;
    f[base + F_YAW] = yaw;
    f[base + F_PITCH] = pitch;
    const v = Atomics.add(this.i32, I_V, 1) + 1;
    // 渲染唤醒移交**主线程 rAF 帧信号**（wake() 的 RENDER_WAKEUP store+notify——
    // vsync 对齐：渲染节奏 = 显示器刷新，呈现平滑）。发布**不再 notify**
    // RENDER_WAKEUP：1kHz 随机相位唤醒 → 渲染完成时刻与显示器 BeginFrame 错位 →
    // 画面呈现时间不规则（"60 f/s 却观感 ~20f"的抖动根因）；醒后 WorkerB 只读
    // 最新槽（V 未变不重绘）。主线程停摆时由 WorkerB 超时兜底自驱。
    return v;
  }

  /**
   * 读取状态（WorkerB 收到 frame 消息时采样）：acquire 读 V，与上次相同返回 null（非阻塞）。
   * 否则读当前槽 S[V&1]（双缓冲切槽）。
   * 防撕裂：读 V 后一次性读全部字段，再重读 V 校验（double-check）——
   * 不一致说明写入方在字段读取期间推进了版本，以新版本重读一次（最多 2 次尝试，
   * 8 个 Float64 连续读远快于 1ms 物理子步，实测竞争几乎不可能命中）。
   */
  readState(): SharedStateData | null {
    if (this.mode === 'msg-render') {
      // 消息回退：返回 onStateMessage 缓存的最近状态；V 未变返回 null
      // （"仅状态更新时重绘"判定与 SAB 模式一致）
      const s = this.msgLatest;
      if (!s || s.v === this.lastV) return null;
      this.lastV = s.v;
      return s;
    }
    const v0 = Atomics.load(this.i32, I_V);
    if (v0 === this.lastV) return null;
    const f = this.f64;
    let v = v0;
    let pos: Vec3 = { x: 0, y: 0, z: 0 };
    let vel: Vec3 = { x: 0, y: 0, z: 0 };
    let yaw = 0;
    let pitch = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const base = F_SLOT_BASE + (v & 1) * F_SLOT_STRIDE; // 当前槽 S[V&1]
      pos = { x: f[base + F_POS_X], y: f[base + F_POS_Y], z: f[base + F_POS_Z] };
      vel = { x: f[base + F_VEL_X], y: f[base + F_VEL_Y], z: f[base + F_VEL_Z] };
      yaw = f[base + F_YAW];
      pitch = f[base + F_PITCH];
      const v2 = Atomics.load(this.i32, I_V);
      if (v2 === v) break; // 字段读取期间版本未推进 → 一致
      v = v2; // 撕裂：改用新版本重读
    }
    this.lastV = v;
    return { pos, vel, yaw, pitch, v };
  }

  /**
   * WorkerA shared-state 消息接收（msg-render）：缓存最近状态（本地副本唯一来源，
   * 与 SAB 模式 readState 的"只被物理发布更新"语义一致）。
   */
  onStateMessage(msg: SharedStateMsg): void {
    this.msgLatest = { pos: msg.pos, vel: msg.vel, yaw: msg.yaw, pitch: msg.pitch, v: msg.v };
  }
}
