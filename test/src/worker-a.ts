/**
 * WorkerA — 双模物理核心（阶段2：模式A 1ms 无限制真理源 + 模式B 权威 tick 速度校准）。
 *
 * 用户核心定调：
 * - **渲染参数唯一来自模式A**（1ms 无限制物理真理源）——共享状态槽只由模式A 写入；
 * - **TICK_RATE 只影响手感（难度）**：模式B 每 1/TICK_RATE 边界执行"权威 tick"——
 *   参考 game 双线实现（renderer-main tick：addInput → correctFromAuthority →
 *   calibrateVelocity（set_velocity 只覆盖速度）→ predPhys.tick（可变 dt 单步）→
 *   渲染直读 state()——**位置/渲染 = 主线程物理（连续流畅）；速度被权威校准
 *   （Worker 固定步长 1/tickRate 的结果，64t 离散）**）：
 *   - 输入采样：键位/鼠标每 1/TICK_RATE 边界采样一次（consumeInput 累积增量——
 *     bhop 时机、转向台阶、跳跃延迟 ≤1 tick = 难度核心）；
 *   - 粗糙 tick：phys.tick(tickDt, 采样键位, 采样dx, 采样dy)——64t 粒度的物理结果
 *     （"权威帧"：64t 摩擦/加速）；
 *   - 速度校准（game calibrateVelocity 语义）：xz 用粗糙结果（64t 摩擦/加速——
 *     难度手感）；vy 用模式A 的（重力/跳跃正确——单实例下粗糙 tick 会重复推进该
 *     时间窗口，vy 采用模式A 避免"重力变大/浮空"）；位置/角度恢复模式A 快照——
 *     渲染参数（位置/角度）连续由模式A 推进（单实例无独立权威实例，粗糙 tick 的
 *     位置推进不能残留，否则渲染位置被双倍推进）；
 * - 模式B 不写共享槽（共享槽只由模式A 写——渲染参数零污染）；
 * - 双重"tick 难度"：输入采样（操作粒度 64t）+ 速度校准（64t 摩擦/加速）；
 * - TICK_RATE=0 或 ≥1000（tickDt≤1ms，与模式A 等价）→ 跳过模式B（纯 1ms 无限制实时输入）。
 *
 * 世界构建：主线程 BSP 解析分发（{type:'world-json'}）→ set_hull + build_world +
 * 死亡阈值（brushJson min y）。BSP 是唯一玩法。
 *
 * 循环驱动：setTimeout(loop, 0)——让出事件循环投递消息（respawn/world-json）；
 * 独立 Worker 线程永不阻塞主线程。背压 waitWakeup 承担休眠（多数轮次挂起/自旋交替）。
 */

/// <reference lib="webworker" />

import { TestShared } from './shared-state.js';
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
/** 单次步进 dx/dy 上限 ±1000（防穿墙，与 game 输入层 CLAMP 一致）。 */
const MAX_INPUT_DELTA = 1000;
/** 背压休眠阈值：距下次子步剩余 >= 1ms 才挂起（WAKEUP 槽），否则自旋。 */
const WAIT_THRESHOLD_MS = 1;
/** 单次最长休眠（ms）：限制 respawn/init-wasm 等消息最坏延迟。 */
const MAX_WAIT_MS = 4;
/** 重力（默认 PhysParams.gravity=800；test 无重力调节面板）。 */
const GRAVITY = 800;
/** wasm 文件（build:wasm 已复制到 test 根）。 */
const DEFAULT_WASM_URL = './websurf_test_wasm_bg.wasm';

// ── 消息协议 ────────────────────────────────────────────────────
interface InitSharedMessage {
  type: 'init-shared';
  shared: SharedArrayBuffer;
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
  teleportJson: string;
  spawn: [number, number, number, number];
}
type WorkerAMessage = InitSharedMessage | InitWasmMessage | RespawnMessage | WorldJsonMessage;

// ── 运行时状态 ──────────────────────────────────────────────────
let shared: TestShared | null = null;
let phys: PhysWorld | null = null;
let pendingWasmUrl: string | null = null;
let initStarted = false;
/** world-json 先于 wasm 初始化到达时暂存。 */
let pendingWorld: WorldJsonMessage | null = null;

/** 模式A 累加器（秒）。 */
let acc = 0;
/** 模式B 累加器（秒；保留余数——网格对齐真实时间轴）。 */
let loAcc = 0;
let lastNow = performance.now();

// ── 世界构建（BSP 导出分发）─────────────────────────────────────
function applyWorld(msg: WorldJsonMessage): void {
  if (!phys) return;
  const [sx, sy, sz, yaw] = msg.spawn;
  phys.set_hull(16, 72, 54);
  phys.build_world(msg.brushJson, msg.triJson, msg.teleportJson, sx, sy, sz, yaw);
  // 死亡阈值：brushJson 最小 min[1] - 100（默认 -100000 兜底）
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
  writeStateFromPhys(); // 首帧状态即刻可见
}

/** 状态写回（模式A 子步 / respawn 共用）：写空闲槽（S[V&1^1]）→ Atomics.add(V,1）。 */
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
    if (pendingWorld) {
      applyWorld(pendingWorld);
      pendingWorld = null;
    }
    loop();
  } catch (e) {
    console.error('[worker-a] wasm 初始化失败:', e);
  }
}

// ── 模式B 输入采样状态（CS 64t 服务器 / game 权威 tick 粒度手感：键位与鼠标每
//    1/TICK_RATE 边界采样一次——bhop 时机、转向台阶、跳跃延迟 ≤1 tick = 难度核心；
//    模式A 子步用采样快照——物理仍 1ms 步长，重力/跳跃物理正确性不受影响）──────
let keysSnap = 0;
let dxSnap = 0;
let dySnap = 0;
/** 本 tickDt 内鼠标增量是否已应用（每 tick 只消费一次增量，避免 16 个子步重复旋转）。 */
let dxApplied = false;
/** 模式B 是否在上一轮激活（激活边沿重置采样器）。 */
let modeBWasActive = false;

// ── 双模自驱循环（阶段2）────────────────────────────────────────
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
  // 停用→激活边沿：重置采样器（快照清零，避免陈旧键位/鼠标误注入）
  if (modeBActive && !modeBWasActive) {
    keysSnap = 0;
    dxSnap = 0;
    dySnap = 0;
    dxApplied = true;
    loAcc = 0;
  }
  modeBWasActive = modeBActive;

  // ── 模式A：1ms 无限制高精度子步（渲染数据源——每轮最多 MAX_STEPS_PER_ROUND 次）──
  acc += delta;
  if (acc >= RENDER_DT) {
    let steps = 0;
    while (acc >= RENDER_DT && steps < MAX_STEPS_PER_ROUND) {
      acc -= RENDER_DT;
      steps++;
      // 输入：模式B 激活时用 64t 采样快照（keys 保持、dx/dy 每 tick 只应用一次——
      // 防重复旋转；操作粒度 64t——跳跃/转向台阶）；否则实时输入
      let dx: number;
      let dy: number;
      let keys: number;
      if (modeBActive) {
        keys = keysSnap;
        if (!dxApplied) {
          dx = dxSnap;
          dy = dySnap;
          dxApplied = true;
        } else {
          dx = 0;
          dy = 0;
        }
      } else {
        const inp = shared.consumeInput(MAX_INPUT_DELTA); // CAS 清零 + 限幅防穿墙
        dx = inp.dx;
        dy = inp.dy;
        keys = inp.keysMask;
      }
      phys.tick(RENDER_DT, keys, dx, dy); // 1ms 子步
      writeStateFromPhys(); // 写空闲槽（S[V&1 ^ 1]）→ Atomics.add(V,1)——唯一写槽者
    }
    // 8 次上限耗尽：保留剩余累加（时间不丢失，下轮继续补跑），仅封顶防无限追赶
    if (acc > MAX_ACC) acc = MAX_ACC;
  }

  // ── 模式B：权威 tick + 速度校准（每 1/TICK_RATE 边界——game 双线 calibrateVelocity
  //    语义；不写共享槽——渲染参数零污染；渲染位置/角度 = 模式A 1ms 连续推进）──
  if (modeBActive) {
    const tickDt = 1 / tickRate;
    loAcc += delta;
    while (loAcc >= tickDt) {
      loAcc -= tickDt;
      // 输入采样（tickDt 粒度——game 主线程每帧消费输入的等价：键位/鼠标在 tick
      // 边界采样一次；累积增量经 consumeInput 一次性取出——子步用快照）
      const inp = shared.consumeInput(MAX_INPUT_DELTA);
      keysSnap = inp.keysMask;
      dxSnap = inp.dx;
      dySnap = inp.dy;
      dxApplied = false; // 下一个模式A 子步应用该增量（每 tick 只应用一次）
      // 粗糙 tick（64t 粒度的物理结果——"权威帧"）：在模式A 连续状态上推进一个 tickDt
      const a = phys.state(); // 快照当前（模式A 连续状态——渲染参数源）
      phys.tick(tickDt, keysSnap, dxSnap, dySnap);
      const rough = phys.state();
      // 校准速度（game calibrateVelocity 语义——只覆盖速度，不动位置/角度/渲染参数）：
      //   xz 用粗糙结果（64t 摩擦/加速——难度手感）；vy 用模式A 的（重力/跳跃正确——
      //   单实例下粗糙 tick 会重复推进该时间，vy 采用模式A 避免"重力变大/浮空"）；
      //   位置/角度恢复模式A 快照——渲染参数连续由模式A 推进（单实例无独立权威实例，
      //   粗糙 tick 的位置推进不能残留——否则渲染位置被双倍推进）
      phys.set_state(
        a.posX, a.posY, a.posZ, a.yaw, a.pitch,
        rough.velX, a.velY, rough.velZ, a.onGround,
      );
    }
  } else {
    loAcc = 0; // 关闭难度修正（0）/ 与模式A 等价（≥1000Hz）：纯 1ms 无限制实时输入
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
    case 'init-wasm':
      if (msg.wasmUrl) pendingWasmUrl = msg.wasmUrl;
      if (shared && !initStarted) void startInit();
      break;
    case 'respawn':
      // 阶段4：立即重置物理状态 → 写空闲槽 + Atomics.add(V,1)
      if (phys) {
        phys.respawn();
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
  }
});

// ── 入口 ────────────────────────────────────────────────────────
export function startWorkerA(): void {
  // 消息监听已在模块顶层注册；循环在 wasm 就绪后自驱
}

startWorkerA();
