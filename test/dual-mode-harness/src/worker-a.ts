/**
 * WorkerA — 双模物理核心（2026-08-11 重构：tick 先行 + 独立 64t 权威速度线）。
 *
 * 架构（依据 test/dual-mode-harness/CONCLUSION.md 会审结论 + 四条用户要求）：
 * - **输入唯一入口**：主线程只写 SAB 输入槽（或消息回退），WorkerA 是唯一消费者；
 *   模式A（无限制）逐 1ms 子步**实时消耗**——位置/角度只由模式A 推进；
 * - **先 tick 计算、后无限制计算**：每轮循环先检查 tick 节点（loAcc ≥ tickDt），
 *   未到达**跳过直达无限制计算**；到达则：
 *   ① 输入采样（tick 边界快照：键位 = 当前掩码 peekKeys；鼠标 = 自上一边界
 *      模式A 实时消耗的累积增量——64t 操作粒度 = 难度核心）；
 *   ② **独立 tick 实例**（tickPhys，第二个 PhysWorld，只走 tickDt 步长）推进——
 *      真实 64t 物理（摩擦/加速/碰撞/bhop 钳制相位全在 64t 网格上，game 权威
 *      实例语义）；**分叉兜底锚定**：与模式A 位置偏差 > TICK_ANCHOR_DIST（死亡/
 *      传送/卡墙/坡缘等极限操作后的无界分叉——校准速度脱离渲染上下文的"渲染
 *      混乱"根因）→ 全量拉回模式A；正常演化不干预（64t 离散相位保留）；
 *      其状态时刻 = 边界时刻 → 校准速度与模式A 位置**同刻**（消除旧单实例
 *      "未来速度"伪差）；
 *   ③ **速度校准（唯一 tick 影响通道）**：`phys.set_velocity(tickPhys 三轴速度)`
 *      —— 位置/角度绝不触碰；vy 用 tick 实例的（独立实例无重复重力问题，
 *      旧实现"vy 用模式A"的补救 hack 不再需要）；
 * - **模式A（无限制真理源）**：1ms 子步 + 实时输入，共享状态槽唯一写入者 =
 *   模式A 子步（WorkerB 渲染参数唯一来源——用户要求 4）；
 * - TICK_RATE=0 或 ≥1000（tickDt ≤ 1ms，与模式A 等价）→ 跳过 tick
 *   （纯 1ms 无限制实时输入）；
 * - 模式B 停用→激活边沿：累积器清零 + tickPhys.set_state(phys 全状态) 对齐起点；
 *   respawn / world-json：双实例同步重建。
 *
 * 预期行为：sustained surf 稳态速度仍 tick 无关（dt 标定正确物理）；tick 难度
 * 可见于 bhop 时机（速度通道延迟 ∈(0,tickDt]）、快变输入、碰撞相位。
 *
 * 世界构建：主线程 BSP 解析分发（{type:'world-json'}）→ set_hull + build_world +
 * 死亡阈值（brushJson min y）。BSP 是唯一玩法。
 *
 * 循环驱动：setTimeout(loop, 0)——让出事件循环投递消息（respawn/world-json）；
 * 独立 Worker 线程永不阻塞主线程。背压 waitWakeup 承担休眠（多数轮次挂起/自旋交替）。
 */

/// <reference lib="webworker" />

import { TestShared, type SharedInputMsg, type SharedTickRateMsg } from './shared-state.js';
import { PhysWorld, initSync } from '../pkg/websurf_test_wasm.js';

// ── 常量 ────────────────────────────────────────────────────────
/** 模式A：1ms 固定子步（无限制真理源）。 */
const RENDER_DT = 0.001;
/** delta 限幅防炸：clamp(实际间隔, 0, 50ms)。 */
const MAX_DELTA = 0.05;
/** 每轮最多执行的 1ms 子步数（大 delta 防死亡螺旋；超限保留剩余累加防时间丢失）。 */
const MAX_STEPS_PER_ROUND = 8;
/** 累加器封顶（秒）：8 次上限耗尽后的残留上限，防无限追赶。 */
const MAX_ACC = 0.02;
/** 单次 mousemove 事件削平阈值（主线程已按事件 CLAMP；这里用于 tick 边界窗口上限）。 */
const MAX_INPUT_DELTA = 1000;
/** tick 边界鼠标增量上限：按 tick 窗口放大（1000/ms × tickDt），防极端甩视角穿墙。 */
function tickInputMax(tickDt: number): number {
  return MAX_INPUT_DELTA * (tickDt / RENDER_DT);
}
/** 背压休眠阈值：距下次子步剩余 >= 1ms 才挂起（WAKEUP 槽），否则自旋。 */
const WAIT_THRESHOLD_MS = 1;
/** 单次最长休眠（ms）：限制 respawn/init-wasm 等消息最坏延迟。 */
const MAX_WAIT_MS = 4;
/** 重力（默认 PhysParams.gravity=800；test 无重力调节面板）。 */
const GRAVITY = 800;
/** wasm 文件（build:wasm 已复制到 test 根）。 */
const DEFAULT_WASM_URL = './websurf_test_wasm_bg.wasm';
/** 空传送 report：最小集明确排除传送区域，build_world 必须接收该参数。 */
const EMPTY_TELEPORT_JSON = '{"teleports":[],"triggers":[]}';

// ── 消息协议 ────────────────────────────────────────────────────
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
interface WorldJsonMessage {
  type: 'world-json';
  brushJson: string;
  triJson: string;
  spawn: [number, number, number, number];
}
type WorkerAMessage =
  | InitSharedMessage
  | InitMsgMessage
  | InitWasmMessage
  | RespawnMessage
  | WorldJsonMessage
  | SharedInputMsg
  | SharedTickRateMsg;

// ── 运行时状态 ──────────────────────────────────────────────────
let shared: TestShared | null = null;
/** 模式A：无限制 1ms 真理源（渲染参数唯一源；共享槽唯一写入者）。 */
let phys: PhysWorld | null = null;
/** 模式B：独立 64t 权威速度线（tickPhys，只走 tickDt 步长；对模式A 唯一影响 =
 *  set_velocity 三轴速度校准）。 */
let tickPhys: PhysWorld | null = null;
let pendingWasmUrl: string | null = null;
let initStarted = false;
/** world-json 先于 wasm 初始化到达时暂存。 */
let pendingWorld: WorldJsonMessage | null = null;

/** 模式A 累加器（秒）。 */
let acc = 0;
/** 模式B 累加器（秒；保留余数——网格对齐真实时间轴）。 */
let loAcc = 0;
/** 模式B tick 边界采样累积（自上一边界以来模式A 实时消耗的鼠标增量——tick 实例
 *  每 tickDt 消费一次；键位取边界当前掩码 peekKeys）。 */
let tickDxAcc = 0;
let tickDyAcc = 0;
/** 模式B 上一轮是否激活（激活边沿重置采样器 + 对齐 tickPhys）。 */
let modeBWasActive = false;
let lastNow = performance.now();

// ── 世界构建（BSP 导出分发）─────────────────────────────────────
function applyWorld(msg: WorldJsonMessage): void {
  if (!phys) return;
  const [sx, sy, sz, yaw] = msg.spawn;
  phys.set_hull(16, 72, 54);
  phys.build_world(msg.brushJson, msg.triJson, EMPTY_TELEPORT_JSON, sx, sy, sz, yaw);
  // tick 实例同世界构建（独立 64t 权威线——与模式A 同出生点同世界）
  if (tickPhys) {
    tickPhys.set_hull(16, 72, 54);
    tickPhys.build_world(msg.brushJson, msg.triJson, EMPTY_TELEPORT_JSON, sx, sy, sz, yaw);
  }
  // 死亡阈值：brushJson 最小 min[1] - 100（默认 -100000 兜底）
  try {
    const brushes = JSON.parse(msg.brushJson) as Array<{ min: number[] }>;
    let minY = Infinity;
    for (const b of brushes) {
      if (b.min[1] < minY) minY = b.min[1];
    }
    if (Number.isFinite(minY)) {
      phys.set_death_y(minY - 100);
      tickPhys?.set_death_y(minY - 100);
    }
  } catch (e) {
    console.error('[worker-a] brushJson 解析失败（死亡阈值保持默认）:', e);
  }
  writeStateFromPhys(); // 首帧状态即刻可见
}

/** 状态写回（模式A 子步 / respawn 共用）：写空闲槽（S[V&1^1]）→ Atomics.add(V,1）。
 * 共享槽**唯一写入者 = 模式A**（WorkerB 渲染参数唯一来源——用户要求 4）。 */
function writeStateFromPhys(): void {
  if (!shared || !phys) return;
  const s = phys.state();
  shared.writeState(
    { x: s.posX, y: s.posY, z: s.posZ },
    { x: s.velX, y: s.velY, z: s.velZ },
    s.yaw,
    s.pitch,
  );
}

/** tickPhys 对齐模式A 当前全状态（模式B 停用→激活边沿 / 分叉兜底锚定调用；
 * 之后 tickPhys 独立演化）。 */
function alignTickPhys(): void {
  if (!phys || !tickPhys) return;
  const s = phys.state();
  tickPhys.set_state(s.posX, s.posY, s.posZ, s.yaw, s.pitch, s.velX, s.velY, s.velZ, s.onGround);
}

/** 分叉兜底锚定距离阈值（units）：tick 实例与模式A 位置偏差超过此值视为
 * "极限操作分叉"（死亡/传送/卡墙/坡缘），全量拉回；正常演化偏差有界（数十
 * units 内）不触发——tick 保持自身 64t 离散演化，避免锚定引入相位伪差。 */
const TICK_ANCHOR_DIST = 64;

/** tick 实例与模式A 位置是否已分叉（超阈值）。 */
function tickDiverged(): boolean {
  if (!phys || !tickPhys) return false;
  const s = phys.state();
  const t = tickPhys.state();
  const dx = s.posX - t.posX;
  const dy = s.posY - t.posY;
  const dz = s.posZ - t.posZ;
  return dx * dx + dy * dy + dz * dz > TICK_ANCHOR_DIST * TICK_ANCHOR_DIST;
}

// ── wasm 初始化 + 世界构建 + 启动自驱循环（幂等）──────────────────
async function startInit(): Promise<void> {
  if (initStarted) return;
  initStarted = true;
  const url = pendingWasmUrl ?? DEFAULT_WASM_URL;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url} → ${resp.status}`);
    const bytes = await resp.arrayBuffer();
    initSync({ module: bytes });
    phys = new PhysWorld();
    tickPhys = new PhysWorld();
    if (pendingWorld) {
      applyWorld(pendingWorld);
      pendingWorld = null;
    }
    loop();
  } catch (e) {
    console.error('[worker-a] wasm 初始化失败:', e);
  }
}

// ── 双模自驱循环（阶段2：先 tick 计算 → 后无限制计算）────────────
function loop(): void {
  if (!shared || !phys) return;

  // 真实时间片 delta（clamp 0~50ms 防炸）
  const now = performance.now();
  let delta = (now - lastNow) / 1000;
  lastNow = now;
  if (delta > MAX_DELTA) delta = MAX_DELTA;
  if (delta < 0) delta = 0;

  // TICK_RATE：模式B 激活判定（tickDt > 1ms 才激活；0 或 ≥1000Hz 等价模式A 时跳过）
  let tickRate = shared.readTickRate();
  if (!Number.isFinite(tickRate) || tickRate < 0) tickRate = 0;
  const modeBActive = tickRate > 0 && 1 / tickRate > RENDER_DT;
  // 停用→激活边沿：重置采样累积器 + tickPhys 对齐模式A（防陈旧输入/错位起点）
  if (modeBActive && !modeBWasActive) {
    loAcc = 0;
    tickDxAcc = 0;
    tickDyAcc = 0;
    alignTickPhys();
  } else if (!modeBActive && modeBWasActive) {
    loAcc = 0;
    tickDxAcc = 0;
    tickDyAcc = 0;
  }
  modeBWasActive = modeBActive;

  // ── 第一步：tick 计算（先——tick 节点到达才执行；未到达越过直达无限制计算）──
  if (modeBActive && tickPhys) {
    const tickDt = 1 / tickRate;
    loAcc += delta;
    while (loAcc >= tickDt) {
      loAcc -= tickDt;
      // 输入采样（tick 边界快照）：键位 = 当前掩码（64t 粒度——bhop/转向台阶）；
      // 鼠标 = 自上一边界模式A 实时消耗的累积增量（限幅防极端甩视角穿墙）
      const tickKeys = shared.peekKeys();
      const tickMax = tickInputMax(tickDt);
      const tickDx = Math.max(-tickMax, Math.min(tickMax, tickDxAcc));
      const tickDy = Math.max(-tickMax, Math.min(tickMax, tickDyAcc));
      tickDxAcc = 0;
      tickDyAcc = 0;
      // **分叉兜底锚定（极限操作防护）**：tick 实例与模式A 位置偏差 >
      // TICK_ANCHOR_DIST（死亡/传送/卡墙/坡缘等极限操作后位置/朝向无界分叉 →
      // 校准速度脱离渲染上下文的"渲染混乱"根因）→ 全量 set_state 拉回模式A；
      // 正常演化（偏差有界 ≤ 数十 units）**不干预**——tick 保持自身 64t 离散演化
      // （bhop 采样/碰撞/钳制相位），无锚定引入的相位伪差
      if (tickDiverged()) {
        alignTickPhys();
      }
      // 独立实例推进（真实 64t 物理——摩擦/加速/碰撞/bhop 钳制相位在 64t 网格上；
      // 状态时刻 = 边界时刻 → 校准速度与模式A 位置同刻，无"未来速度"伪差）
      tickPhys.tick(tickDt, tickKeys, tickDx, tickDy);
      // 速度校准（**唯一 tick 影响通道**——game calibrateVelocity 语义）：
      // 三轴速度写回模式A（含 vy——独立实例自身 64t 重力演化，无重复推进问题）；
      // 位置/角度绝不触碰（用户要求 3）
      const st = tickPhys.state();
      phys.set_velocity(st.velX, st.velY, st.velZ);
    }
  } else {
    loAcc = 0; // 关闭难度修正（0）/ 与模式A 等价（≥1000Hz）：纯 1ms 无限制实时输入
  }

  // ── 第二步：无限制计算（后——1ms 子步 + 实时输入；位置/角度只由模式A 推进）──
  acc += delta;
  if (acc >= RENDER_DT) {
    let steps = 0;
    while (acc >= RENDER_DT && steps < MAX_STEPS_PER_ROUND) {
      acc -= RENDER_DT;
      steps++;
      // 实时输入（模式A 是**唯一** SAB 消费路径——用户要求 1：输入仅进入 WorkerA）
      // 不在此削平：主线程已按单次 mousemove 事件 CLAMP；这里必须消费完整帧增量，
      // 避免“整帧累加器被排空 + 削平到 ±1000”导致快速甩动丢失（与 game 主线程直通一致）。
      const inp = shared.consumeInput();
      // tick 边界采样累积（模式B 专用：上一边界以来模式A 实时消耗的鼠标增量，
      // 下一边界一次性注入 tick 实例——与真实 64t 服务器"边界消费整窗口"等价）
      if (modeBActive) {
        tickDxAcc += inp.dx;
        tickDyAcc += inp.dy;
      }
      phys.tick(RENDER_DT, inp.keysMask, inp.dx, inp.dy); // 1ms 子步
      writeStateFromPhys(); // 写空闲槽（S[V&1 ^ 1]）→ Atomics.add(V,1)——唯一写槽者
    }
    // 8 次上限耗尽：保留剩余累加（时间不丢失，下轮继续补跑），仅封顶防无限追赶
    if (acc > MAX_ACC) acc = MAX_ACC;
  }

  // 背压：距下次 1ms 子步剩余时间 >= 1ms → 挂起 WAKEUP 槽（可被阶段1 wake 提前唤醒）；
  // 否则自旋直接继续（时序图 else 分支）
  const idleMs = (RENDER_DT - acc) * 1000;
  if (idleMs >= WAIT_THRESHOLD_MS) {
    shared.waitWakeup(Math.min(idleMs, MAX_WAIT_MS)); // wait(WAKEUP,0,timeout) → 复位 WAKEUP=0
  }

  // 让出事件循环（投递 respawn/world-json 消息；主线程零阻塞）
  setTimeout(loop, 0);
}

// ── 消息处理 ────────────────────────────────────────────────────
self.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as WorkerAMessage;
  switch (msg.type) {
    case 'init-shared':
      shared = TestShared.init(msg.shared);
      void startInit();
      break;
    case 'init-msg':
      // 消息回退模式：状态发布直连 WorkerB 端口；无 SAB 时 same API 双实现
      shared = TestShared.initMessaging((m: unknown) => msg.renderPort.postMessage(m));
      void startInit();
      break;
    case 'init-wasm':
      if (msg.wasmUrl) pendingWasmUrl = msg.wasmUrl;
      if (shared && !initStarted) void startInit();
      break;
    case 'respawn':
      // 阶段4：立即重置物理状态（双实例同步）+ 采样器重置 → 写空闲槽 + Atomics.add(V,1)
      if (phys) {
        phys.respawn();
        tickPhys?.respawn();
        loAcc = 0;
        tickDxAcc = 0;
        tickDyAcc = 0;
        writeStateFromPhys();
      }
      break;
    case 'world-json':
      if (phys) {
        applyWorld(msg);
      } else {
        pendingWorld = msg; // wasm 未就绪：暂存，startInit 完成后应用
      }
      break;
    case 'shared-input':
      // 消息回退模式：主线程每 rAF 投递的输入批次（等价 SAB addInput）
      shared?.onInputMessage(msg.dx, msg.dy, msg.keysMask);
      break;
    case 'shared-tick-rate':
      // 消息回退模式：难度调节（等价 SAB writeTickRate）
      shared?.onTickRateMessage(msg.rate);
      break;
  }
});

// ── 入口 ────────────────────────────────────────────────────────
export function startWorkerA(): void {
  // 消息监听已在模块顶层注册；循环在 wasm 就绪后自驱
}

startWorkerA();
