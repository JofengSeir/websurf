/**
 * WorkerA — 双模物理核心（阶段2：模式A 1ms 无限制渲染数据源 + 模式B Tick 难度修正）。
 *
 * 职责（用户核心定调：渲染参数必须唯一来源于模式A 的 1ms 无限制物理真理源；
 * 另一个 tick 计算源（模式B）只能做速度修正，绝不允许污染共享状态槽）：
 * - 阶段0：TICK_RATE 由 WorkerA 消费——**模式B 难度修正步长**（1/TICK_RATE）；0 = 关闭难度修正
 * - 阶段2 模式A（物理真理源，**共享状态槽唯一写入者**）：1ms 固定子步
 *   （RENDER_DT=0.001），每轮最多 8 次——
 *   delta = clamp(实际间隔, 0, 50ms) → 累加器 += delta → while 累加器 >= 1ms && 步数 < 8:
 *   consumeInput(限幅 ±1000 防穿墙) → phys.tick(1ms) → writeState（写空闲槽 + V add）
 *   ——**渲染数据源**：位置/视角连续平滑
 * - 阶段2 模式B（tick 速度修正源）：每 1/TICK_RATE 用粗糙步长 tick → **只覆盖 phys 内部
 *   速度向量**（位置/角度恢复为模式A 真理源快照）——手感 = 64tick 难度，显示不受影响；
 *   ★ 不调用 writeStateFromPhys——共享状态槽（V + 双缓冲 S[2]）只由模式A 写入，
 *   渲染参数零污染
 * - 阶段2 背压：距下次子步剩余 >= 1ms → waitWakeup(timeout)（挂起 WAKEUP 槽，
 *   可被阶段1 wake store+notify 提前唤醒；返回后 WAKEUP 复位为 0）；否则自旋
 * - 阶段4：respawn 消息 → phys.respawn() → writeStateFromPhys()（写空闲槽 + V add）
 *
 * 世界构建：由主线程 BSP 解析分发（{type:'world-json'}）——brush/模型三角形碰撞/
 * 传送 report/出生点全部来自 BspProcessor 导出，WorkerA 只负责 set_hull + build_world +
 * 死亡阈值（brushJson min y）。BSP 是唯一玩法，无地图时物理 ready=false 空转等待。
 *
 * 循环驱动：setTimeout(loop, 0) 而非 while(true)——Atomics.wait 是阻塞等待，
 * 阻塞期间事件循环完全停摆，postMessage 的 respawn/init-wasm 消息将永远无法投递
 * （阶段4 失效）；setTimeout 每轮让出一次事件循环保证消息可达，同时本 Worker
 * 独立线程永不阻塞主线程。背压 waitWakeup 仍承担休眠职责：多数轮次挂起/自旋交替。
 */

/// <reference lib="webworker" />

import { TestShared } from './shared-state.js';
import { PhysWorld, initSync } from '../pkg/websurf_test_wasm.js';

// ── 常量（与 README 最新时序图 阶段2 一致）─────────────────────
/** 单模固定子步：1ms（RENDER_DT）。 */
const RENDER_DT = 0.001;
/** delta 限幅防炸：rAF 长帧/卡顿兜底，clamp(实际间隔, 0, 50ms)。 */
const MAX_DELTA = 0.05;
/** 每轮最多执行的 1ms 子步数（大 delta 防死亡螺旋；超限丢弃剩余累加）。 */
const MAX_STEPS_PER_ROUND = 8;
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

// ── 消息协议（与 main.ts 约定）──────────────────────────────────
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
/** 主线程 BspProcessor 导出 → 真实世界构建（BSP 唯一玩法）。 */
interface WorldJsonMessage {
  type: 'world-json';
  brushJson: string;
  triJson: string;
  teleportJson: string;
  spawn: [number, number, number, number]; // [x, y, z, yaw]
}
type WorkerAMessage = InitSharedMessage | InitWasmMessage | RespawnMessage | WorldJsonMessage;

// ── 运行时状态 ──────────────────────────────────────────────────
let shared: TestShared | null = null;
let phys: PhysWorld | null = null;
/** init-wasm 消息携带的 wasmUrl（先于 init-shared 到达时暂存）。 */
let pendingWasmUrl: string | null = null;
/** wasm 初始化只执行一次（init-shared 或 init-wasm 先到者触发）。 */
let initStarted = false;
/** world-json 先于 wasm 初始化到达时暂存，初始化完成后立即应用。 */
let pendingWorld: WorldJsonMessage | null = null;

/** 单模累加器（秒）+ 上次循环时刻（阶段2 自驱循环）。 */
let acc = 0;
/** 模式B（难度修正）累加器：每 1/TICK_RATE 触发一次粗糙步长速度覆盖。 */
let loAcc = 0;
let lastNow = performance.now();

// ── 世界构建（BSP 导出分发；删除原手工 brush 世界）─────────────────

/**
 * 应用真实地图世界：set_hull(16,72,54) → build_world（brush + 模型三角形 +
 * teleport report + 出生点）→ 死亡阈值 = brushJson 最小 min[1] - 100。
 * teleportJson 必须是 report 对象（{"teleports":[],"triggers":[]} 或 parse_teleports 输出）。
 */
function applyWorld(msg: WorldJsonMessage): void {
  if (!phys) return;
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
}

// ── 状态写回（阶段2 子步 / 阶段4 respawn 共用：写空闲槽 + V add）──
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
    initSync({ module: bytes }); // 同步实例化（WebAssembly.Module 缓存，重复调用幂等）
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

// ── 双模自驱循环（阶段2 核心：模式A 1ms 无限制渲染数据源 + 模式B Tick 难度修正）──
function loop(): void {
  if (!shared || !phys) return;

  // 真实时间片 delta（clamp 0~50ms 防炸）
  const now = performance.now();
  let delta = (now - lastNow) / 1000;
  lastNow = now;
  if (delta > MAX_DELTA) delta = MAX_DELTA;
  if (delta < 0) delta = 0;

  // ── 模式A：1ms 无限制高精度子步（渲染数据源——每轮最多 MAX_STEPS_PER_ROUND 次）
  acc += delta;
  if (acc >= RENDER_DT) {
    let steps = 0;
    while (acc >= RENDER_DT && steps < MAX_STEPS_PER_ROUND) {
      acc -= RENDER_DT;
      steps++;
      const inp = shared.consumeInput(MAX_INPUT_DELTA); // CAS 清零 + 限幅防穿墙（±1000）
      phys.tick(RENDER_DT, inp.keysMask, inp.dx, inp.dy); // 1ms 子步
      writeStateFromPhys(); // 写空闲槽（S[V&1 ^ 1]）→ Atomics.add(V,1)
    }
    if (acc >= RENDER_DT) acc = 0; // 8 次上限耗尽：丢弃剩余累加时间（防死亡螺旋，最多落后 8ms）
  }

  // ── 模式B：Tick 限制难度修正（tick 计算源，只做 phys 内部速度修正——
  //    TICK_RATE 只影响"手感"：速度向量被粗糙步长覆盖，位置/角度恢复模式A 真理源快照 →
  //    渲染显示平滑、手感是 64tick 难度；0 = 关闭难度修正）
  let tickRate = shared.readTickRate();
  if (!Number.isFinite(tickRate) || tickRate < 0) tickRate = 0;
  if (tickRate > 0) {
    const tickDt = 1 / tickRate;
    loAcc += delta;
    while (loAcc >= tickDt) {
      loAcc -= tickDt;
      const inp1 = shared.consumeInput(MAX_INPUT_DELTA);
      const a = phys.state(); // 快照真理源当前状态（pos/yaw/pitch/onGround）
      phys.tick(tickDt, inp1.keysMask, inp1.dx, inp1.dy); // 粗糙 tick（步长 = 1/TICK_RATE）
      const rough = phys.state(); // 粗糙结果（粗糙速度）
      // 只做速度修正：恢复位置/角度为真理源（a），保留粗糙速度（手感 = 难度）
      phys.set_state(
        a.posX, a.posY, a.posZ, a.yaw, a.pitch,
        rough.velX, rough.velY, rough.velZ, rough.onGround,
      );
      // ★ 不调用 writeStateFromPhys——共享状态槽（V + 双缓冲 S[2]）只由模式A 写，
      //   渲染参数零污染
    }
  } else {
    loAcc = 0; // 关闭难度修正：纯 1ms 无限制（最平滑手感）
  }

  // 背压：距下次 1ms 子步剩余时间 >= 1ms → 挂起 WAKEUP 槽（可被阶段1 wake 提前唤醒）；
  // 否则自旋直接继续（时序图 else 分支）
  const idleMs = (RENDER_DT - acc) * 1000;
  if (idleMs >= WAIT_THRESHOLD_MS) {
    shared.waitWakeup(Math.min(idleMs, MAX_WAIT_MS)); // wait(WAKEUP,0,timeout) → 复位 WAKEUP=0
  }

  // 让出事件循环（投递 respawn/init-wasm 消息；主线程零阻塞）
  setTimeout(loop, 0);
}

// ── 消息处理 ────────────────────────────────────────────────────
self.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as WorkerAMessage;
  switch (msg.type) {
    case 'init-shared':
      shared = TestShared.init(msg.shared); // SAB 布局：控制区(含 WAKEUP) + 输入槽 + 双缓冲状态槽
      void startInit();
      break;
    case 'init-wasm':
      // 可选：携带 wasmUrl（dev 模式）；主线程当前未发送，默认 fetch 同目录 wasm
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
