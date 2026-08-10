/**
 * WorkerA — 双模物理核心（阶段2：模式A 1ms 无限制渲染数据源 + 模式B Tick 难度修正）。
 *
 * 职责（用户核心定调：渲染参数必须唯一来源于模式A 的 1ms 无限制物理真理源；
 * 另一个 tick 计算源（模式B）只做速度修正，绝不允许污染共享状态槽）：
 * - 阶段0：TICK_RATE 由 WorkerA 消费——**模式B 难度修正步长**（1/TICK_RATE）；0 = 关闭难度修正
 * - 阶段2 模式A（物理真理源，**共享状态槽唯一写入者**）：1ms 固定子步
 *   （RENDER_DT=0.001），每轮最多 8 次——
 *   delta = clamp(实际间隔, 0, 50ms) → 累加器 += delta → while 累加器 >= 1ms && 步数 < 8:
 *   consumeInput(限幅 ±1000 防穿墙) → phys.tick_into(1ms)（零分配热路径：状态写 wasm
 *   固定缓冲，经 state_out_ptr 的 Float64Array 视图直读 8 标量 → writeStateRaw 直写 SAB——
 *   每子步零 JS 对象分配，GC 压力归零）→ writeStateRaw（写空闲槽 + V add）
 *   ——**渲染数据源**：位置/视角连续平滑
 * - 阶段2 模式A 上限耗尽：**保留剩余累加**（时间不丢失，后续轮补跑），仅封顶 50ms 防无限追赶；
 *   原 acc=0 丢弃会在任何停顿后永久丢失模拟时间（V 发布率跌穿 1kHz 无法回升）
 * - 阶段2 模式B（**64t 全输入采样**——phys 本身即"64t 键位+鼠标采样 + 1ms 物理"）：
 *   **键位按 1/TICK_RATE 采样**（authKeysSnap 快照——起跳/移动/松键响应延迟 ≤1 tick：
 *   落地后起跳延迟 → 摩擦损失累积 → 连跳速度显著低于基准 = 真实低 tick 难度；
 *   采样网格 loAcc 保留余数——32/64/128 延迟单调）；**鼠标 dx/dy 同步 tick 采样**
 *   （每 tickDt 边界读取一次输入读数并保持——真实 64t 手感：视角台阶式旋转，
 *   快速转向下轨迹与无限制明显分歧）；**无独立权威实例**
 *   ★ 不调用 writeStateFromPhys——共享状态槽（V + 双缓冲 S[2]）只由模式A 写入，
 *   渲染参数零污染；★ TICK_RATE ≥ 1000（tickDt ≤ 1ms）时模式B 与模式A 完全等价——
 *   **跳过模式B 防双倍物理**（1000Hz 按钮不再白跑一套完整 tick）
 * - 阶段2 背压：距下次子步剩余 >= 1ms → waitWakeup(timeout)（挂起 WAKEUP 槽——
 *   **WorkerA 专用槽**，与 WorkerB 的 RENDER_WAKEUP 分离，帧对齐互不干扰；
 *   可被阶段1 wake store+notify 提前唤醒；返回后 WAKEUP 复位为 0）；否则自旋
 * - 阶段4：respawn 消息 → phys.respawn() → writeStateFromPhys()（写空闲槽 + V add）
 *
 * 世界构建：由主线程 BSP 解析分发（{type:'world-json'}）——brush/模型三角形碰撞/
 * 传送 report/出生点全部来自 BspProcessor 导出，WorkerA 只负责 set_hull + build_world +
 * 死亡阈值（brushJson min y）。BSP 是唯一玩法，无地图时物理 ready=false 空转等待。
 *
 * 通道双模式（init-shared / init-msg 二选一，API 完全一致）：
 * - SAB 模式：consumeInput/writeStateRaw 直读写 SAB；waitWakeup 挂起 WAKEUP 槽
 * - 消息回退模式（无 SAB）：main 的 shared-input/shared-tick-rate 消息 → 本地累加；
 *   writeStateRaw → 本地 V++ → 直连端口投递 shared-state 给 WorkerB；
 *   waitWakeup 立即超时返回（自投递续环即自驱）——语义等价，仅传输介质不同
 *
 * 通道双模式（init-shared / init-msg 二选一，API 完全一致）：
 * - SAB 模式：consumeInput/writeStateRaw 直读写 SAB；waitWakeup 挂起 WAKEUP 槽
 * - 消息回退模式（无 SAB）：main 的 shared-input/shared-tick-rate 消息 → 本地累加；
 *   writeStateRaw → 本地 V++ → 直连端口投递 shared-state 给 WorkerB；
 *   waitWakeup 立即超时返回（自投递续环即自驱）——语义等价，仅传输介质不同
 *
 * 循环驱动：MessageChannel 自投递消息续环（port2.postMessage → port1.onmessage →
 * loop）而非 while(true)——Atomics.wait 是阻塞等待，阻塞期间事件循环完全停摆，
 * postMessage 的 respawn/init-wasm 消息将永远无法投递（阶段4 失效）；自投递消息
 * 每轮让出一次事件循环保证消息可达，同时本 Worker 独立线程永不阻塞主线程。
 * ★ 不用 setTimeout(loop, 0)：定时器嵌套（定时器回调内再排定时器）第 5 层起被
 * 浏览器钳制到最小 4ms，会把 1ms 物理轮询率锁死在 ~250Hz（V 按 ~4ms 突发批量发布，
 * 高刷屏渲染重复状态）；消息任务无此钳制，轮询率回到 1ms 设计频率，且 respawn/
 * world-json 消息投递延迟反而更低（≤ ~2ms）。背压 waitWakeup 仍承担休眠职责。
 */

/// <reference lib="webworker" />

import { TestShared, type SharedInputMsg, type SharedTickRateMsg } from './shared-state.js';
import { PhysWorld, initSync } from '../pkg/websurf_test_wasm.js';

// ── 常量（与 README 最新时序图 阶段2 一致）─────────────────────
/** 单模固定子步：1ms（RENDER_DT）。 */
const RENDER_DT = 0.001;
/** delta 限幅防炸：rAF 长帧/卡顿兜底，clamp(实际间隔, 0, 50ms)。 */
const MAX_DELTA = 0.05;
/** 每轮最多执行的 1ms 子步数（大 delta 防单轮长时间卡顿；超限剩余累加**保留**，下轮继续补跑）。 */
const MAX_STEPS_PER_ROUND = 8;
/** 累加器封顶（秒）：防长期停顿后无限追赶（= delta 上限，最多落后 50ms 可补回）。 */
const MAX_ACC = 0.05;
/**
 * 单次步进 dx/dy 上限 ±1000（与 game 输入层 CLAMP@1000 一致）。
 * 限幅防穿墙：极端鼠标抖动/长帧攒积的大增量若整体注入单步子步，
 * 单帧位移可穿过薄墙；限幅后大增量留到后续子步分批消耗。
 */
const MAX_INPUT_DELTA = 1000;
/** 背压休眠阈值：距下次子步剩余 >= 1ms 才挂起（WAKEUP 槽），否则自旋。 */
const WAIT_THRESHOLD_MS = 1;
/** 单次最长休眠（ms）：限制 respawn/init-wasm 等消息最坏延迟。 */
const MAX_WAIT_MS = 4;
/** wasm 文件（build:wasm 已复制到 test 根，与 worker-a.js 同目录）。 */
const DEFAULT_WASM_URL = './websurf_test_wasm_bg.wasm';

// ── 零分配热路径状态（tick_into 输出缓冲视图；wasm 内存增长后按 buffer 身份重建）──
/** initSync 返回的 wasm 导出（memory 用于建 state_out 的 Float64Array 视图）。 */
let wasmOutput: { memory: WebAssembly.Memory } | null = null;
/** state_out 缓冲视图（tick_into 写入 8 个 f64：pos×3/yaw/pitch/vel×3）。 */
let stateOutView: Float64Array | null = null;

/**
 * 自驱续环通道：port2 每轮末 postMessage(null) → port1 onmessage → loop()。
 * 消息任务不受 setTimeout 嵌套 4ms 钳制（见文件头注释），1ms 轮询率不被锁死；
 * 自投递间隙事件循环照常投递 respawn/world-json 消息。
 */
const resumeChannel = new MessageChannel();
resumeChannel.port1.onmessage = () => loop();

// ── 消息协议（与 main.ts 约定）──────────────────────────────────
interface InitSharedMessage {
  type: 'init-shared';
  shared: SharedArrayBuffer;
}
/** 消息回退模式初始化（无 SAB）：renderPort 为 WorkerA→WorkerB 状态发布直连端口。 */
interface InitMsgMessage {
  type: 'init-msg';
  renderPort: MessagePort;
}
interface InitWasmMessage {
  type: 'init-wasm';
  wasmUrl?: string;
}
interface RespawnMessage {
  type: 'respawn';
}
/** 路径记录开关（main 按钮点击；仅开启时记录/发送——防内存溢出）。 */
interface TraceMessage {
  type: 'trace';
  enabled: boolean;
}
/** 主线程 BspProcessor 导出 → 真实世界构建（BSP 唯一玩法）。 */
interface WorldJsonMessage {
  type: 'world-json';
  brushJson: string;
  triJson: string;
  teleportJson: string;
  spawn: [number, number, number, number]; // [x, y, z, yaw]
}
type WorkerAMessage =
  | InitSharedMessage
  | InitMsgMessage
  | InitWasmMessage
  | RespawnMessage
  | WorldJsonMessage
  | TraceMessage
  | SharedInputMsg
  | SharedTickRateMsg;

// ── 运行时状态 ──────────────────────────────────────────────────
let shared: TestShared | null = null;
/** 无限制物理真理源（模式A，1ms，渲染数据源）。模式B 激活时键位输入用 64t 采样快照。 */
let phys: PhysWorld | null = null;
/** init-wasm 消息携带的 wasmUrl（先于 init-shared 到达时暂存）。 */
let pendingWasmUrl: string | null = null;
/** wasm 初始化只执行一次（init-shared 或 init-wasm 先到者触发）。 */
let initStarted = false;
/** world-json 先于 wasm 初始化到达时暂存，初始化完成后立即应用。 */
let pendingWorld: WorldJsonMessage | null = null;

/** 单模累加器（秒）+ 上次循环时刻（阶段2 自驱循环）。 */
let acc = 0;
/** 模式B 输入采样累加器（秒；保留余数——网格精确对齐真实时间轴）。 */
let loAcc = 0;
let lastNow = performance.now();

// ── 模式B 64t 输入采样状态 ───────────────────────────────────
/** 模式A consumeInput 的当前键位（每子步更新；tickDt 边界采样）。 */
let authKeys = 0;
/** 模式A consumeInput 的当前鼠标增量（每子步更新；tickDt 边界采样）。 */
let authDx = 0;
let authDy = 0;
/** 64t 键位采样快照（tickDt 边界快照并保持——phys 键位输入用该快照：
 *  起跳/移动/松键响应延迟 ≤1 tick → 落地后起跳延迟 → 摩擦损失累积 →
 *  连跳速度显著低于基准 = 真实低 tick 难度） */
let authKeysSnap = 0;
/** 64t 鼠标采样快照（tickDt 边界读取一次 dx/dy 并保持——真实 tick 视角：
 *  快速转向下视角台阶式旋转、轨迹与无限制明显分歧）。 */
let authDxSnap = 0;
let authDySnap = 0;
/** 模式B 是否在上一轮激活（激活边沿重置采样器）。 */
let modeBWasActive = false;

// ── 路径记录（trace）状态：无限制基准（physBase，实时键位）vs tick 实际（phys，
//    采样键位）移动路径节点对比——按钮开启才记录/发送，防内存溢出 ──
/** 记录开关（main 按钮 → {type:'trace'} 消息）。 */
let traceEnabled = false;
/** 无限制基准对照实例（实时键位 + 实时鼠标 = 纯 1ms 无限制物理；仅记录模式运行）。 */
let physBase: PhysWorld | null = null;
/** 最近一次发送节点的时刻（每 TRACE_INTERVAL_MS 记一个节点）。 */
let traceLastMs = 0;
/** 最近一次 consumeInput 的实时键位（physBase 推进用；phys 用采样键位）。 */
let lastRealKeys = 0;
/** 最近一次 world-json（trace 开启时 physBase 需同世界构建——brushJson 已消费须暂存）。 */
let lastWorldJson: WorldJsonMessage | null = null;
/** trace 节点采样间隔（ms）：10 节点/s——路径足够密且内存/消息可控。 */
const TRACE_INTERVAL_MS = 100;
/** trace 位置兜底阈值：phys（tick 实际）与 physBase（无限制基准）偏差 > 此值时
 *  physBase 拉回 phys（防对照无限漂移）并回传兜底事件——理想拟合下仅偶发触发。 */
const TRACE_SYNC_DIST = 50;
/** trace 软校正阈值：偏差 > 此值且 < 硬阈值时，physBase 位置向 phys 渐进收敛
 * （消除跳跃采样延迟导致的位置偏差累积——硬兜底次数压缩至 1% 内；
 * 速度保留 physBase 自己的演化，基准轻微渐进对齐）。 */
const TRACE_SOFT_SYNC_DIST = 20;
/** 软校正收敛比例（0-1）：偏差在软阈值区间时每次收敛的比例。 */
const TRACE_SOFT_RATIO = 0.5;

// ── 世界构建（BSP 导出分发；删除原手工 brush 世界）─────────────────

/**
 * 应用真实地图世界：set_hull(16,72,54) → build_world（brush + 模型三角形 +
 * teleport report + 出生点）→ 死亡阈值 = brushJson 最小 min[1] - 100。
 * teleportJson 必须是 report 对象（{"teleports":[],"triggers":[]} 或 parse_teleports 输出）。
 * **phys 与 physAuth 同世界同出生点双实例构建**（game 权威双实例精华）：
 * physAuth 在 world-json 时创建（懒创建依赖的世界数据已被消费，无法事后补齐）。
 */
function applyWorld(msg: WorldJsonMessage): void {
  if (!phys) return;
  lastWorldJson = msg; // trace 开启时 physBase 需同世界构建（brushJson 已消费须暂存）
  const [sx, sy, sz, yaw] = msg.spawn;
  phys.set_hull(16, 72, 54);
  phys.build_world(msg.brushJson, msg.triJson, msg.teleportJson, sx, sy, sz, yaw);
  // 死亡阈值：brushJson 遍历取最小 min[1]（Y-up y 轴）；默认 -100000 兜底
  try {
    const brushes = JSON.parse(msg.brushJson) as Array<{ min: number[] }>;
    let minY = Infinity;
    for (const b of brushes) {
      if (b.min[1] < minY) minY = b.min[1];
    }
    if (Number.isFinite(minY)) phys.set_death_y(minY - 100);
  } catch (e) {
    console.error('[worker-a] brushJson 解析失败（死亡阈值保持默认）:', e);
  }
  // 重置模式B 采样器（换图后键位快照清零）
  authKeys = 0;
  authKeysSnap = 0;
  loAcc = 0;
  modeBWasActive = false;
  // 换图后 physBase 与 phys 同世界重建（若记录模式已开启）
  if (traceEnabled) initTraceBase();
}

// ── 状态写回（阶段4 respawn / 换图首帧共用：写空闲槽 + V add；
//    阶段2 子步热路径不用本函数——直接消费 tick() 返回值，见 loop）──
function writeStateFromPhys(): void {
  if (!shared || !phys) return;
  const s = phys.state(); // posX/posY/posZ/velX/velY/velZ/yaw/pitch（见 pkg d.ts）
  shared.writeState(
    { x: s.posX, y: s.posY, z: s.posZ },
    { x: s.velX, y: s.velY, z: s.velZ },
    s.yaw,
    s.pitch,
  );
}

// ── wasm 初始化 + 启动自驱循环（幂等；世界由 world-json 消息构建）──
async function startInit(): Promise<void> {
  if (initStarted) return;
  initStarted = true;
  const url = pendingWasmUrl ?? DEFAULT_WASM_URL;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url} → ${resp.status}`);
    const bytes = await resp.arrayBuffer();
    wasmOutput = initSync({ module: bytes }); // 同步实例化（WebAssembly.Module 缓存，重复调用幂等）
    stateOutView = null; // wasm 内存实例更换：视图重建（build_world 内存增长后 buffer 身份自动重建）
    phys = new PhysWorld();
    if (pendingWorld) {
      // world-json 先到：初始化完成后立即构建世界并写首帧
      applyWorld(pendingWorld);
      pendingWorld = null;
      writeStateFromPhys(); // 首帧状态即刻可见（WorkerB 采样 V 无需等首个 tick）
    }
    loop();
  } catch (e) {
    console.error('[worker-a] wasm 初始化失败:', e);
  }
}

/**
 * tick_into 输出缓冲的 Float64Array 视图（8 个 f64：pos×3/vel×3/yaw/pitch，
 * 与 writeStateRaw 参数序一致）。
 * 懒建 + buffer 身份校验：wasm 内存增长（memory.buffer 更换）时视图失效，自动重建。
 */
function stateOutViewOf(phys: PhysWorld): Float64Array {
  if (
    !stateOutView ||
    stateOutView.buffer !== wasmOutput!.memory.buffer ||
    stateOutView.byteOffset !== phys.state_out_ptr()
  ) {
    stateOutView = new Float64Array(wasmOutput!.memory.buffer, phys.state_out_ptr(), 8);
  }
  return stateOutView;
}

// ── 路径记录（trace）辅助：physBase 构建/同步/推进/采样发送 ─────────

/**
 * 初始化/重建 physBase（无限制基准对照实例）：同世界同出生点构建（用 lastWorldJson），
 * 并同步 phys 当前状态为起点。仅记录模式开启时调用。
 */
function initTraceBase(): void {
  if (!phys || !lastWorldJson) return;
  if (!physBase) {
    physBase = new PhysWorld();
    physBase.set_hull(16, 72, 54);
  }
  const w = lastWorldJson;
  physBase.build_world(w.brushJson, w.triJson, w.teleportJson, w.spawn[0], w.spawn[1], w.spawn[2], w.spawn[3]);
  const s = phys.state();
  physBase.set_state(s.posX, s.posY, s.posZ, s.yaw, s.pitch, s.velX, s.velY, s.velZ, s.onGround);
}

/** 记录模式推进：physBase 用**实时键位**（无限制基准）推进，与 phys（采样键位）对比。 */
function traceTick(realKeys: number, dx: number, dy: number): void {
  if (!traceEnabled || !physBase || !phys) return;
  // physBase = 纯 1ms 无限制（实时键位 + 实时鼠标）
  physBase.tick(RENDER_DT, realKeys, dx, dy);
  // 每 TRACE_INTERVAL_MS 记一个节点（10 节点/s——路径可见且消息/内存可控）
  const nowMs = performance.now();
  if (nowMs - traceLastMs >= TRACE_INTERVAL_MS) {
    traceLastMs = nowMs;
    const s = phys.state(); // tick 实际（跳跃采样键位）
    const b = physBase.state(); // 无限制基准（实时键位）
    // 偏差管理（数据分析迭代：跳跃采样延迟产生位置偏差累积 → 硬兜底 50 频繁触发
    // （复杂运动 5-8%）→ 软校正消除累积，硬兜底压缩至 1% 内）：
    // ① 硬兜底：偏差 > 50 → physBase 拉回 phys（防无限漂移）+ 兜底事件（仅偶发）
    // ② 软校正：偏差 ∈ (20, 50] → physBase 位置向 phys 收敛 50%（速度保留 physBase
    //    演化——基准轻微渐进对齐，消除跳跃偏差累积）
    const d = Math.hypot(s.posX - b.posX, s.posZ - b.posZ);
    if (d > TRACE_SYNC_DIST) {
      physBase.set_state(s.posX, s.posY, s.posZ, s.yaw, s.pitch, s.velX, s.velY, s.velZ, s.onGround);
      self.postMessage({ type: 'trace-sync', dist: d });
    } else if (d > TRACE_SOFT_SYNC_DIST) {
      physBase.set_state(
        b.posX + (s.posX - b.posX) * TRACE_SOFT_RATIO,
        b.posY + (s.posY - b.posY) * TRACE_SOFT_RATIO,
        b.posZ + (s.posZ - b.posZ) * TRACE_SOFT_RATIO,
        b.yaw, b.pitch, b.velX, b.velY, b.velZ, b.onGround,
      );
    }
    // 3D 世界坐标节点（x/y/z——WorkerB 场景中画两条空间路径线）
    self.postMessage({
      type: 'trace-data',
      baseX: b.posX, baseY: b.posY, baseZ: b.posZ,
      tickX: s.posX, tickY: s.posY, tickZ: s.posZ,
    });
  }
}

// ── 双模自驱循环（阶段2 核心：模式A 1ms 无限制渲染数据源 + 模式B Tick 难度修正）──
function loop(): void {
  if (!shared || !phys) return;

  // 真实时间片 delta（clamp 0~50ms 防炸）
  const now = performance.now();
  let delta = (now - lastNow) / 1000;
  lastNow = now;
  if (delta > MAX_DELTA) delta = MAX_DELTA;
  if (delta < 0) delta = 0;

  // 模式B 激活判定（提前到模式A：子步键位输入需用 64t 采样快照）
  let tickRate = shared.readTickRate();
  if (!Number.isFinite(tickRate) || tickRate < 0) tickRate = 0;
  const modeBActive = tickRate > 0 && 1 / tickRate > RENDER_DT;

  // ── 模式A：1ms 无限制高精度子步（渲染数据源——每轮最多 MAX_STEPS_PER_ROUND 次）
  acc += delta;
  if (acc >= RENDER_DT) {
    let steps = 0;
    while (acc >= RENDER_DT && steps < MAX_STEPS_PER_ROUND) {
      acc -= RENDER_DT;
      steps++;
      const inp = shared.consumeInput(MAX_INPUT_DELTA); // CAS 清零 + 限幅防穿墙（±1000）
      // 当前键位/鼠标（模式B 每 tickDt 边界采样 → 快照）
      authKeys = inp.keysMask;
      authDx = inp.dx;
      authDy = inp.dy;
      lastRealKeys = inp.keysMask; // 实时键位（physBase 无限制基准推进用）
      // 1ms 子步零分配热路径：tick_into 把状态写进 wasm 固定缓冲（不构造 wasm→JS
      // 对象）→ Float64Array 视图直读 8 标量 → writeStateRaw 直写 SAB——
      // 每子步零 JS 对象分配（原 tick() 每次构造 1 个 11 属性对象 + GC 压力）。
      // **模式B 激活时输入分离采样（真实 tick 模型）**：**键位全位（WASD+跳跃）走
      // 64t 采样快照**（响应延迟 ∈(0, tickDt]——起跳延迟 → 摩擦损失累积 → 连跳速度
      // 显著低于基准 = 真实低 tick 难度；移动位采样 → 快速换向/点按下轨迹与无限制
      // 明显分歧）；**鼠标 dx/dy 同步 tick 采样**（每 tickDt 边界读取一次并保持——
      // 真实 64t 视角台阶式旋转）；模式B 关闭时全实时
      const keyForPhys = modeBActive ? authKeysSnap : inp.keysMask;
      const dxForPhys = modeBActive ? authDxSnap : inp.dx;
      const dyForPhys = modeBActive ? authDySnap : inp.dy;
      phys.tick_into(RENDER_DT, keyForPhys, dxForPhys, dyForPhys);
      const v = stateOutViewOf(phys); // [pos×3, vel×3, yaw, pitch]（与 writeStateRaw 参数序一致）
      shared.writeStateRaw(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]);
      // 路径记录：physBase（实时键位）同步推进 + 采样发送（仅按钮开启时）
      traceTick(inp.keysMask, inp.dx, inp.dy);
    }
    // 8 次上限耗尽：**保留剩余累加**（时间不丢失，下轮继续补跑），仅封顶防无限追赶。
    // 原 acc=0 丢弃：任何停顿（GC 暂停/大图物理耗时）都会永久丢失模拟时间——
    // 物理速率跌穿 1kHz 且永不回升（高刷屏渲染重复状态根因之一）
    if (acc > MAX_ACC) acc = MAX_ACC;
  }

  // ── 模式B：64t 键位+鼠标全输入采样（phys 输入用快照——起跳/移动/松键/转向
  //    响应延迟 ≤1 tick）──
  //    ★ 无独立权威实例：phys 本身即"64t 全输入采样 + 1ms 物理"——
  //       物理数值（重力/摩擦/碰撞/跳跃）与基准严格一致（无大步长离散化偏差）
  //    ★ 不 writeStateFromPhys——共享状态槽只由模式A 写，渲染参数零污染
  //    ★ TICK_RATE ≥ 1000（tickDt ≤ 1ms）时与模式A 完全等价 → **跳过**防双倍物理
  if (modeBActive) {
    // 停用→激活边沿：重置采样器（快照清零，避免陈旧键位误注入）
    if (!modeBWasActive) {
      authKeysSnap = 0;
      authDxSnap = 0;
      authDySnap = 0;
      loAcc = 0;
    }
    // 64t 输入采样：按 1/TICK_RATE 周期采样当前键位+鼠标增量并保持（输入响应延迟
    // ∈(0, tickDt]，平均 tickDt/2——32tick 平均 15.6ms > 64tick 7.8ms > 128tick 3.9ms，
    // **难度单调**）。**loAcc 保留余数**（-= tickDt 而非清零）——采样网格精确对齐
    // 真实时间轴，避免"清零重计"的网格漂移导致 32/64 起跳延迟锁相相同
    // （"越低越难"失效根因）
    loAcc += delta;
    if (loAcc >= 1 / tickRate) {
      loAcc -= 1 / tickRate;
      authKeysSnap = authKeys;
      authDxSnap = authDx;
      authDySnap = authDy;
    }
  } else {
    // 关闭难度修正（0）/ 与模式A 等价（≥1000Hz）：纯 1ms 无限制（最平滑手感）
  }
  modeBWasActive = modeBActive;

  // 背压：距下次 1ms 子步剩余时间 >= 1ms → 挂起 WAKEUP 槽（可被阶段1 wake 提前唤醒）；
  // 否则自旋直接继续（时序图 else 分支）
  const idleMs = (RENDER_DT - acc) * 1000;
  if (idleMs >= WAIT_THRESHOLD_MS) {
    shared.waitWakeup(Math.min(idleMs, MAX_WAIT_MS)); // wait(WAKEUP,0,timeout) → 复位 WAKEUP=0
  }

  // 让出事件循环（投递 respawn/world-json 消息；主线程零阻塞）——自投递消息续环，
  // 无 setTimeout 嵌套 4ms 钳制（见文件头注释），轮询率回到 1ms 设计频率
  resumeChannel.port2.postMessage(null);
}

// ── 消息处理 ────────────────────────────────────────────────────
self.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as WorkerAMessage;
  switch (msg.type) {
    case 'init-shared':
      shared = TestShared.init(msg.shared); // SAB 布局：控制区(含 WAKEUP) + 输入槽 + 双缓冲状态槽
      void startInit();
      break;
    case 'init-msg':
      // 消息回退模式（无 SAB）：renderPort 直连 WorkerB——状态发布不经主线程中转
      shared = TestShared.initMessaging((m) => msg.renderPort.postMessage(m as never));
      void startInit();
      break;
    case 'init-wasm':
      // 可选：携带 wasmUrl（dev 模式）；主线程当前未发送，默认 fetch 同目录 wasm
      if (msg.wasmUrl) pendingWasmUrl = msg.wasmUrl;
      if (shared && !initStarted) void startInit();
      break;
    case 'shared-input':
      // 消息回退：主线程每 rAF 输入批次 → 本地累加（consumeInput 消费，限幅语义同 SAB）
      shared?.onInputMessage(msg.dx, msg.dy, msg.keysMask);
      break;
    case 'shared-tick-rate':
      // 消息回退：难度调节 → 本地缓存（readTickRate 读取，下轮循环自动识别）
      shared?.onTickRateMessage(msg.rate);
      break;
    case 'respawn':
      // 阶段4：立即重置物理状态 → 写空闲槽 + Atomics.add(V,1)（重置模式B 采样器）
      if (phys) {
        phys.respawn();
        authKeys = 0;
        authKeysSnap = 0;
        // 记录模式：physBase 同步 phys 起点（重生后两条路径同起点对比）
        if (physBase) {
          const s = phys.state();
          physBase.set_state(s.posX, s.posY, s.posZ, s.yaw, s.pitch, s.velX, s.velY, s.velZ, s.onGround);
        }
        writeStateFromPhys();
      }
      break;
    case 'trace':
      // 路径记录开关（main 按钮；仅开启时记录/发送——防内存溢出）
      traceEnabled = msg.enabled;
      if (traceEnabled) {
        // 开启：初始化无限制基准对照实例（同世界同起点），重置采样时钟
        initTraceBase();
        traceLastMs = performance.now();
      } else {
        // 关闭：释放 physBase（停止记录/发送），main 侧自行清空节点
        physBase = null;
      }
      break;
    case 'world-json':
      // 主线程 BspProcessor 导出 → 构建真实世界（BSP 唯一玩法；可重复加载换图）
      if (phys) {
        applyWorld(msg);
        writeStateFromPhys(); // 首帧状态即刻可见
      } else {
        pendingWorld = msg; // wasm 未就绪：暂存，startInit 完成后应用
      }
      break;
  }
});

// ── 入口 ────────────────────────────────────────────────────────
export function startWorkerA(): void {
  // 消息监听已在模块顶层注册；循环在 wasm 就绪后自驱（init-shared/init-wasm 驱动）
}

startWorkerA();
