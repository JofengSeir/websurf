/**
 * WebSurf-test — 主线程入口（时序图 阶段0/1/4）。
 *
 * 职责（绝不做物理/渲染）：
 * - 前置条件检测：crossOriginIsolated + SharedArrayBuffer 支持 → 共享内存模式；
 *   不满足 → **消息回退模式**（postMessage 通道，功能等价，不再停止）
 * - 创建 SAB + WorkerA（物理）/ WorkerB（渲染），transfer 共享内存（或消息通道直连）
 * - 阶段1：捕获鼠标（pointer lock 后累积）与键盘（WASD/空格），
 *   每 rAF 一次性写入输入（SAB Atomics.add / 消息回退 postMessage 批投递）
 *   → wake()（双槽通知：WAKEUP → WorkerA 物理背压；RENDER_WAKEUP → WorkerB
 *   渲染帧信号——**主驱动 = 主线程 rAF（vsync 对齐，呈现平滑）**，WorkerA 发布
 *   不 notify；见 shared-state.ts / worker-b.ts）
 * - 阶段0：难度按钮 → 写 SAB 控制区 TICK_RATE（仅 store，无 notify）
 * - 阶段4：R 键 → postMessage({type:'respawn'}) 到 WorkerA
 */

import { keysToMask, SHARED_BUFFER_SIZE, TestShared } from './shared-state.js';
import { ShmState, SHARED_BUFFER_SIZE as AUTH_BUFFER_SIZE } from '../../../src/ts-shared/auth/shared-state.js';
import type { ComputeMode } from '../../../src/ts-shared/auth/compute-mode.js';
import { formatWorkerStatsLine, type WorkerTickStats } from './panel/tick-telemetry-format.js';
import { BspProcessor, initSync } from '../pkg/websurf_test_wasm.js';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
const rateLabel = document.getElementById('rateLabel') as HTMLElement | null;
const bspFileInput = document.getElementById('bspFile') as HTMLInputElement | null;
const bspStatusEl = document.getElementById('bspStatus') as HTMLElement | null;

// ── 鼠标输入优化（与 game/debug 的 MouseBuffer + PointerLock 对齐）──────────
/** 单次 mousemove 事件增量削平阈值（像素）。Pointer Lock 初始跳变由 discardNext 处理，
 *  这里只做驱动异常/浏览器事件合并的兜底 CLAMP（保留方向与大部分量级）。 */
const MOUSE_MAX_DELTA = 1000;
/** Pointer Lock 变化后丢弃下一个 mousemove（cs-movement discardNextMouse 语义）。 */
let discardNextMouse = false;

/** 绝对削平：将增量限制在 ±MOUSE_MAX_DELTA，保留符号（方向）。 */
function clampMouseDelta(v: number): number {
  return Math.max(-MOUSE_MAX_DELTA, Math.min(MOUSE_MAX_DELTA, v));
}

/** requestPointerLock 运行时签名：现代 Chromium 支持 options 并返回 Promise。 */
type RequestPointerLockFn = (
  options?: { unadjustedMovement?: boolean },
) => Promise<void> | void;

/**
 * 请求 Pointer Lock：优先使用 `{ unadjustedMovement: true }` 禁用 OS 鼠标加速；
 * 不支持时降级为普通锁定（与 game/src/input/pointer-lock.ts 同策略）。
 */
function requestPointerLockWithUnadjusted(target: HTMLElement): void {
  const fn = target.requestPointerLock as unknown as RequestPointerLockFn;
  try {
    const result: unknown = fn.call(target, { unadjustedMovement: true });
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).catch(() => {
        console.warn('[main] unadjustedMovement 不可用，降级为普通锁定');
        try {
          fn.call(target);
        } catch {
          /* 忽略降级失败 */
        }
      });
    }
  } catch {
    // 旧浏览器不接受 options 参数：直接普通锁定
    try {
      fn.call(target);
    } catch {
      /* 忽略 */
    }
  }
}

if (!canvas) {
  throw new Error('canvas#game 未找到');
}

// ── 前置条件检测（阶段0 前置）：crossOriginIsolated + SharedArrayBuffer ──
// 满足 → 共享内存模式（SAB 无锁通道，最高性能）；不满足 → **消息回退模式**
// （postMessage 通道，功能等价——无 SAB 环境（file:// 无 COOP/COEP / 旧浏览器）
// 不再停止，HUD 提示模式）
const sabSupported = typeof SharedArrayBuffer !== 'undefined';
const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
const useSab = sabSupported && isolated;

// ── 共享内存 + 双 Worker 创建（dev 与 dist 同构：module worker + 外置 wasm）──
const workerA = new Worker(new URL('./worker-a.js', import.meta.url), { type: 'module' });
const workerB = new Worker(new URL('./worker-b.js', import.meta.url), { type: 'module' });
workerA.onerror = (e) => console.error('[main] WorkerA 错误:', e.message);
workerB.onerror = (e) => console.error('[main] WorkerB 错误:', e.message);

/** 计算模式（主线程镜像）。真相源在 WorkerA——本值只由 mode-ack 更新，
 *  不做乐观切换（避免 UI 与 worker 实态不一致）。 */
let computeMode: ComputeMode = 'coupled';
/** tick 遥测账行 DOM（tick-authority 每秒自发 {type:'tick-stats'}）。 */
const tickStatsLine = document.getElementById('tickStatsLine') as HTMLElement | null;
workerA.onmessage = (
  e: MessageEvent<{ type?: string; mode?: ComputeMode; stats?: WorkerTickStats }>,
) => {
  const msg = e.data;
  if (msg?.type === 'mode-ack' && msg.mode) {
    computeMode = msg.mode;
    setActiveComputeMode(msg.mode);
    // 渲染侧同步（tick 模式由 TickConsumer 消费 auth 通道；其余走渲染通道镜像）
    workerB.postMessage({ type: 'compute-mode', mode: msg.mode });
    // 离开 tick 模式：清掉上一段会话的遥测（不让陈旧账目冒充当前状态）
    if (msg.mode !== 'tick' && tickStatsLine) {
      tickStatsLine.textContent = formatWorkerStatsLine(null);
    }
  } else if (msg?.type === 'tick-stats') {
    if (tickStatsLine) tickStatsLine.textContent = formatWorkerStatsLine(msg.stats);
  }
};

// 通道模式：SAB 满足 → 共享内存（最高性能）；否则 → 消息回退（postMessage，功能等价）
let shared: TestShared;
if (useSab) {
  const sab = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
  shared = TestShared.create(sab, workerA); // postMessage 共享 SAB（非 transfer）
  workerB.postMessage({ type: 'init-shared', shared: sab }); // 同上：SAB 不可进 transfer list
} else {
  shared = TestShared.createMessaging(workerA); // msg-main：输入/难度 → postMessage
  // WorkerA ↔ WorkerB 直连通道（状态发布不经主线程中转）
  const physRender = new MessageChannel();
  workerA.postMessage({ type: 'init-msg', renderPort: physRender.port1 }, [physRender.port1]);
  workerB.postMessage({ type: 'init-msg', renderPort: physRender.port2 }, [physRender.port2]);
}

// ── auth 通道（三模式物理的唯一读写面）───────────────────────────
// 与渲染通道（TestShared，192B）职责分离：本通道走 src/ts-shared 共享协议
// （ShmState，512B）。三种模式的物理计算（auth-loop / decoupled-loop /
// tick-authority）全部经此消费输入并发布权威帧；WorkerA 侧的 MirrorShmState
// 在每次发布时把帧镜像回 TestShared → WorkerB 渲染路径**零改动**。
let authShared: ShmState | null = null;
if (useSab) {
  const authSab = new SharedArrayBuffer(AUTH_BUFFER_SIZE);
  authShared = new ShmState(authSab);
  workerA.postMessage({ type: 'auth-init', shared: authSab }); // 共享传递（非 transfer）
  // WorkerB 也持 auth 通道：tick 模式经 TickConsumer 消费权威帧（渲染通道仅作镜像兜底）
  workerB.postMessage({ type: 'init-auth', shared: authSab });
} else {
  workerA.postMessage({ type: 'auth-init', shared: null }); // MsgState 回退
  workerB.postMessage({ type: 'init-auth', shared: null });
}

// wasm 就绪：dispatch 收到 wasm-init 后 initSync + 启动 authLoop
workerA.postMessage({ type: 'wasm-init', wasmUrl: './websurf_test_wasm_bg.wasm' });

// HUD 模式提示（共享内存 / 消息回退）
const modeNotice = document.createElement('div');
modeNotice.className = 'hint';
modeNotice.style.color = useSab ? '#8ab4f8' : '#c9a05c';
modeNotice.textContent = useSab
  ? '通道：共享内存（SAB）'
  : '通道：消息回退（无跨源隔离或 SharedArrayBuffer 不可用，postMessage 等价传输）';
document.getElementById('hud')?.appendChild(modeNotice);

// ── WorkerB 状态摘要（每秒一次）→ DOM HUD（渲染 HUD 移出 Worker：OffscreenCanvas 仅一个
//    context 被 WebGL 占用；状态/进度文本由页面 DOM 承载）──────────────────────────
interface WorkerBStatusMessage {
  type: 'status';
  v: number;
  pos: { x: number; y: number; z: number } | null;
  vel: { x: number; y: number; z: number } | null;
  yaw: number | null;
  pitch: number | null;
  glbReady: boolean;
  fps: number;
  repaintSec: number;
}
const statusLine = document.createElement('div');
statusLine.className = 'hint';
statusLine.style.color = '#9aa3b2';
document.getElementById('hud')?.appendChild(statusLine);
workerB.onmessage = (e: MessageEvent<WorkerBStatusMessage>) => {
  const msg = e.data;
  if (!msg || msg.type !== 'status') return;
  const parts: string[] = [];
  if (!msg.glbReady) parts.push('GLB 加载中…');
  if (!msg.pos) parts.push('等待 WorkerA 物理首帧');
  if (msg.pos && msg.vel) {
    const speed = Math.hypot(msg.vel.x, msg.vel.y, msg.vel.z);
    parts.push(`pos (${msg.pos.x.toFixed(1)}, ${msg.pos.y.toFixed(1)}, ${msg.pos.z.toFixed(1)})`);
    parts.push(`速度 ${speed.toFixed(1)} u/s`);
    if (msg.yaw !== null && msg.pitch !== null) {
      parts.push(`yaw/pitch ${msg.yaw.toFixed(1)}° / ${msg.pitch.toFixed(1)}°`);
    }
  }
  parts.push(`V${msg.v}`);
  parts.push(`渲染 ${msg.fps} f/s · 物理刷新 ${msg.repaintSec}/s`);
  statusLine.textContent = parts.join(' · ');
};

// WorkerB 渲染控制权：canvas → transferControlToOffscreen 后 transfer（阶段3）。
// 注：transfer 后原 canvas 元素仍可接收事件/指针锁定，仅渲染上下文归 WorkerB。
canvas.width = Math.max(1, Math.round(canvas.clientWidth));
canvas.height = Math.max(1, Math.round(canvas.clientHeight));
const offscreen = canvas.transferControlToOffscreen();
workerB.postMessage({ type: 'init-canvas', canvas: offscreen }, [offscreen]);
window.addEventListener('resize', () => {
  workerB.postMessage({
    type: 'resize',
    width: Math.max(1, Math.round(canvas.clientWidth)),
    height: Math.max(1, Math.round(canvas.clientHeight)),
  });
});

// 默认难度 64Hz（阶段0：仅 store，无 notify）
const DEFAULT_RATE = 64;
shared.writeTickRate(DEFAULT_RATE);
setActiveRate(DEFAULT_RATE);

// ── BSP 地图加载（文件选择 → 主线程解析 → WorkerA world-json / WorkerB glb）──
// 与 game handleLoadBsp 同管线精简：借用导出（brush/模型碰撞/spawn）必须在
// export_glb_with_pakfile_models（消费 Bsp 实例）之前完成。
// 最小集：只导出核心移动所需数据——brush 碰撞、模型碰撞（.phy 优先/可视网格回退）、
// 出生点、GLB（基本几何+材质纹理+模型）。不导出 teleport/PVS（检测/传送区域等非核心）。
const BRUSH_FILTER_JSON = JSON.stringify({
  include_ladder: true,
  include_solid: true,
  min_brush_volume: 0,
  skip_sky: true,
  skip_nodraw: false,
});

/** 传送区域明确排除（最小集）：空 teleport report → 物理世界不注册任何
 *  trigger/destination（与迁移前 worker-a 的 EMPTY_TELEPORT_JSON 同义）。 */
const EMPTY_TELEPORT_JSON = '{"teleports":[],"triggers":[]}';

/** 主线程 wasm 懒初始化（BspProcessor 与 WorkerA 同一 wasm 文件，独立实例化一次）。 */
let mainWasmReady: Promise<void> | null = null;
function ensureMainWasm(): Promise<void> {
  if (!mainWasmReady) {
    mainWasmReady = (async () => {
      const resp = await fetch('./websurf_test_wasm_bg.wasm');
      if (!resp.ok) throw new Error(`fetch wasm → ${resp.status}`);
      const bytes = await resp.arrayBuffer();
      initSync({ module: bytes });
    })();
  }
  return mainWasmReady;
}

/** BSP 实体 Source yaw → cs-movement yaw：wrap(src + 180)，与 ts-shared bspYawToCsYaw 同口径（旧式 270− 为 det=−1 镜像，已废弃）。 */
function bspYawToCsYaw(bspYaw: number): number {
  return (((bspYaw + 180) % 360) + 360) % 360;
}

function setBspStatus(text: string): void {
  if (bspStatusEl) bspStatusEl.textContent = text;
}

/** 文件选择 → 读 ArrayBuffer → BspProcessor 导出 → 双 Worker 分发（协议见 README/任务）。 */
async function loadBsp(file: File): Promise<void> {
  try {
    setBspStatus(`正在解析 ${file.name}（主线程 BSP 解析）…`);
    await ensureMainWasm();
    await new Promise((r) => setTimeout(r, 0)); // 先让 UI 刷新（大图解析可能数百 ms）

    const proc = new BspProcessor(new Uint8Array(await file.arrayBuffer()));
    const meta = JSON.parse(proc.metadata()) as { magic?: string; num_brushes?: number; num_faces?: number };
    const brushJson = proc.export_brushes_planes(BRUSH_FILTER_JSON);
    // 模型碰撞：.phy 凸包优先，空则回退可视网格（与 game colliderSource=auto 等价）
    let triJson = proc.export_model_phy_colliders();
    if ((JSON.parse(triJson) as unknown[]).length === 0) {
      triJson = proc.export_model_tri_colliders();
    }
    const spawnJson = proc.parse_spawn_points();

    // 首个出生点（primary 优先）：origin 已 Y-up，yaw 用 cs 转换
    const spawnData = JSON.parse(spawnJson) as {
      spawn_points?: Array<{ classname: string; origin: number[]; angles: number[] }>;
      primary?: number;
    };
    const spawnPoints = spawnData.spawn_points ?? [];
    const primary = spawnPoints[spawnData.primary ?? 0] ?? spawnPoints[0];
    const spawn: [number, number, number, number] = primary
      ? [primary.origin[0], primary.origin[1], primary.origin[2], bspYawToCsYaw(primary.angles[1])]
      : [0, 100, 0, 0];

    // 传送区域明确排除：空 teleport report，确保物理世界不注册任何 trigger/destination
    // （dispatch 期望 spawn 为对象 + yawDeg 字段名）
    workerA.postMessage({
      type: 'world-json',
      brushJson,
      triJson,
      teleportJson: EMPTY_TELEPORT_JSON,
      spawn: { x: spawn[0], y: spawn[1], z: spawn[2], yawDeg: spawn[3] },
    });

    // GLB（含 PAKFILE 模型）→ WorkerB 渲染；transfer 零拷贝
    const glb = proc.export_glb_with_pakfile_models();
    const glbBuffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
    const glbSize = glbBuffer.byteLength; // transfer 前保存，transfer 后 byteLength 会变 0
    workerB.postMessage({ type: 'glb', bytes: glbBuffer }, [glbBuffer]);

    setBspStatus(
      `${file.name}：${meta.magic ?? 'VBSP'}，${meta.num_brushes ?? 0} brushes，` +
        `${spawnPoints.length} 出生点，GLB ${Math.round(glbSize / 1024)} KB`,
    );
  } catch (e) {
    setBspStatus(`BSP 加载失败：${e instanceof Error ? e.message : String(e)}`);
    console.error('[main] BSP 加载失败:', e);
  }
}

bspFileInput?.addEventListener('change', () => {
  const file = bspFileInput.files?.[0];
  if (file) void loadBsp(file);
});

// ── 输入累积（本线程本地缓存，每帧一次性写入 SAB）───────────────
let mouseDx = 0;
let mouseDy = 0;
const keyState = { forward: false, backward: false, left: false, right: false, jump: false };
let locked = false;

const MOVEMENT_CODES = new Map<string, keyof typeof keyState>([
  ['KeyW', 'forward'],
  ['ArrowUp', 'forward'],
  ['KeyS', 'backward'],
  ['ArrowDown', 'backward'],
  ['KeyA', 'left'],
  ['ArrowLeft', 'left'],
  ['KeyD', 'right'],
  ['ArrowRight', 'right'],
  ['Space', 'jump'],
]);

// 指针锁定：点击画布请求（浏览器要求用户手势；优先 unadjustedMovement 禁用 OS 加速）
canvas.addEventListener('click', () => {
  if (!locked) requestPointerLockWithUnadjusted(canvas);
});

document.addEventListener('pointerlockerror', () => {
  console.warn('[main] Pointer Lock 请求失败');
});

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  // Pointer Lock 状态变化后丢弃下一个 mousemove（初始跳变通常 2000-5000+ px）
  discardNextMouse = true;
  if (!locked) {
    // 退锁：清残留输入，防 ESC 前最后输入/按住键残留
    mouseDx = 0;
    mouseDy = 0;
    for (const k of Object.keys(keyState) as Array<keyof typeof keyState>) keyState[k] = false;
  }
});

// 鼠标增量 → 本地累积（仅锁定时；mousemove 高频事件不触碰 SAB）
// 每个事件先做 discardNext + 绝对削平（CLAMP），与 game MouseBuffer 对齐；
// 完整帧增量仍由 rAF 一次性写入 SAB，但不再在 WorkerA 的 1ms 子步里被截断。
window.addEventListener('mousemove', (e) => {
  if (!locked) return;
  if (discardNextMouse) {
    discardNextMouse = false;
    return;
  }
  mouseDx += clampMouseDelta(e.movementX);
  mouseDy += clampMouseDelta(e.movementY);
});

// 键盘：WASD/空格 → 键位状态；R → respawn 消息（阶段4）
window.addEventListener('keydown', (e) => {
  if (!locked) return;
  const action = MOVEMENT_CODES.get(e.code);
  if (action) {
    e.preventDefault();
    keyState[action] = true;
    return;
  }
  if (e.code === 'KeyR' && !e.repeat) {
    workerA.postMessage({ type: 'respawn' }); // 阶段4：立即重置物理状态
  }
});

window.addEventListener('keyup', (e) => {
  if (!locked) return;
  const action = MOVEMENT_CODES.get(e.code);
  if (action) keyState[action] = false;
});

window.addEventListener('blur', () => {
  for (const k of Object.keys(keyState) as Array<keyof typeof keyState>) keyState[k] = false;
  mouseDx = 0;
  mouseDy = 0;
});

// ── 难度调节（阶段0）：按钮 → 主线程仅 store TICK_RATE（无 notify）。
//    TICK_RATE 只影响 WorkerA 的难度手感（模式B 粗糙步长速度覆盖，1/TICK_RATE）；
//    渲染恒平滑跟随 1ms 无限制物理状态，不受影响。0 = 关闭难度修正（纯 1ms 无限制）。
function setActiveRate(rate: number): void {
  document.querySelectorAll<HTMLButtonElement>('#difficulty button[data-rate]').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.rate) === rate);
  });
  if (rateLabel) rateLabel.textContent = rate > 0 ? `难度手感：${rate} tick` : '难度修正：关闭（纯 1ms）';
}
document.querySelectorAll<HTMLButtonElement>('#difficulty button[data-rate]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const rate = Number(btn.dataset.rate);
    shared.writeTickRate(rate); // 阶段0：仅 store，WorkerA 下轮自动识别新 DT
    setActiveRate(rate);
  });
});

// ── 计算模式热切（coupled / decoupled / tick）─────────────────────
// 三种模式的物理计算本体在 src/ts-shared（auth-loop / decoupled-loop /
// tick-authority / compute-mode）；本页只发切换意图并显示 mode-ack
// （§3.4.C 握手）。harness 无主线程预测实例 → set-mode 不带 state
// （worker 侧三实例状态自持，交接由 worker 侧 onSetMode 收口）。
const MODE_LABEL: Record<ComputeMode, string> = {
  coupled: '耦合（auth 线 64Hz 权威）',
  decoupled: '解耦（1ms 无限制 + 64t 速度校准）',
  tick: 'tick（raw 64Hz + F4-C 乐观评估）',
};
const computeModeLabel = document.getElementById('computeModeLabel') as HTMLElement | null;
function setActiveComputeMode(mode: ComputeMode): void {
  document.querySelectorAll<HTMLButtonElement>('#computeMode button[data-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  if (computeModeLabel) computeModeLabel.textContent = `计算模式：${MODE_LABEL[mode]}`;
}
document.querySelectorAll<HTMLButtonElement>('#computeMode button[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode as ComputeMode;
    if (mode === computeMode) return;
    workerA.postMessage({ type: 'set-mode', mode }); // worker 翻转 gate → mode-ack
  });
});
setActiveComputeMode('coupled');

// ── 主线程 rAF 循环（阶段1）：输入转发 + wake（**RENDER_WAKEUP = WorkerB 渲染主驱动**：
//    主线程 rAF 与浏览器合成器/vsync 同相 → WorkerB 每帧信号渲染一次，呈现平滑；
//    WorkerA 发布不 notify（1kHz 随机相位唤醒 → 呈现时间不规则 → 观感抖动）；
//    WAKEUP = WorkerA 物理背压缩短休眠；渲染画面经 OffscreenCanvas 由浏览器合成器
//    零拷贝直通上屏，主线程不参与取帧）──
function frame(): void {
  requestAnimationFrame(frame);
  const dx = mouseDx;
  const dy = mouseDy;
  mouseDx = 0;
  mouseDy = 0;
  const mask = locked ? keysToMask(keyState) : 0;
  shared.addInput(dx, dy, mask); // SAB Atomics.add 累加 / 消息回退 postMessage 批投递（主线程耗时 < 0.1ms）
  shared.wake(); // RENDER_WAKEUP → WorkerB 渲染帧信号（vsync 对齐）
  // auth 通道输入（三模式物理的唯一消费面）+ 物理背压唤醒
  // （解耦/tick 循环 waitWakeup 挂在 auth 通道上，TestShared 的 WAKEUP 槽不参与）
  if (authShared) {
    authShared.addInput(dx, dy, mask);
    authShared.wake();
  } else {
    workerA.postMessage({ type: 'input', dx, dy, keys: mask }); // MsgState 回退
  }
}
requestAnimationFrame(frame);
