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

import { KEY_MASK, keysToMask, SHARED_BUFFER_SIZE, TestShared } from './shared-state.js';
import { BspProcessor, initSync } from '../pkg/websurf_test_wasm.js';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
const rateLabel = document.getElementById('rateLabel') as HTMLElement | null;
const bspFileInput = document.getElementById('bspFile') as HTMLInputElement | null;
const bspStatusEl = document.getElementById('bspStatus') as HTMLElement | null;

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

// HUD 模式提示（共享内存 / 消息回退）
const modeNotice = document.createElement('div');
modeNotice.className = 'hint';
modeNotice.style.color = useSab ? '#8ab4f8' : '#c9a05c';
modeNotice.textContent = useSab
  ? '通道：共享内存（SAB）'
  : '通道：消息回退（无 SharedArrayBuffer，postMessage 等价传输）';
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
  parts.push(`渲染 ${msg.fps} f/s · 重绘 ${msg.repaintSec}/s`);
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
// 与 game handleLoadBsp 同管线精简：借用导出（brush/模型碰撞/teleport/spawn）必须在
// export_glb_with_pakfile_models（消费 Bsp 实例）之前完成。
const BRUSH_FILTER_JSON = JSON.stringify({
  include_ladder: true,
  include_solid: true,
  min_brush_volume: 0,
  skip_sky: true,
  skip_nodraw: false,
});

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

/** BSP 方位角 yaw（顺时针）→ cs-movement yaw（逆时针），与 ts-shared bspYawToCsYaw 一致。 */
function bspYawToCsYaw(bspYaw: number): number {
  return ((270 - bspYaw) % 360 + 360) % 360;
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
    const teleportJson = proc.parse_teleports();
    const spawnJson = proc.parse_spawn_points();
    // PVS（借用导出，须在 GLB 之前——export_glb_with_pakfile_models 消费 Bsp 实例）
    const pvsJson = proc.parse_pvs_data();

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

    workerA.postMessage({ type: 'world-json', brushJson, triJson, teleportJson, spawn });

    // PVS → WorkerB（先于 GLB 发送——消息同信道保序，GLB 挂载后即消费剔除）
    workerB.postMessage({ type: 'pvs', pvsJson });

    // GLB（含 PAKFILE 模型）→ WorkerB 渲染；transfer 零拷贝
    const glb = proc.export_glb_with_pakfile_models();
    const glbBuffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
    workerB.postMessage({ type: 'glb', bytes: glbBuffer }, [glbBuffer]);

    setBspStatus(
      `${file.name}：${meta.magic ?? 'VBSP'}，${meta.num_brushes ?? 0} brushes，` +
        `${spawnPoints.length} 出生点，GLB ${Math.round(glbBuffer.byteLength / 1024)} KB`,
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

// 指针锁定：点击画布请求（浏览器要求用户手势）
canvas.addEventListener('click', () => {
  if (!locked) void canvas.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (!locked) {
    // 退锁：清残留输入，防 ESC 前最后输入/按住键残留
    mouseDx = 0;
    mouseDy = 0;
    for (const k of Object.keys(keyState) as Array<keyof typeof keyState>) keyState[k] = false;
  }
});

// 鼠标增量 → 本地累积（仅锁定时；mousemove 高频事件不触碰 SAB）
window.addEventListener('mousemove', (e) => {
  if (!locked) return;
  mouseDx += e.movementX;
  mouseDy += e.movementY;
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

// ── 视野 FOV：滑块 → WorkerB set-fov 消息（相机透视矩阵即时更新；CS:S 标准 75）──
const fovRange = document.getElementById('fovRange') as HTMLInputElement | null;
const fovVal = document.getElementById('fovVal') as HTMLElement | null;
fovRange?.addEventListener('input', () => {
  const fov = Number(fovRange.value);
  if (fovVal) fovVal.textContent = String(fov);
  workerB.postMessage({ type: 'set-fov', fov });
});

// ── 路径记录（trace）：按钮状态机 **开始 → 保存 → 删除 → 开始** 循环——
//    开始：清空 + 开启记录（WorkerA 采样节点）；保存：停止记录（路径保留显示）；
//    删除：清空路径线。节点经 main 转发 WorkerB → **3D 场景中显示两条空间路径线**
//    （绿 = 无限制基准，红 = tick 实际）。仅记录时 WorkerA 发送节点（防内存溢出）──
const traceBtn = document.getElementById('traceBtn') as HTMLButtonElement | null;
const TRACE_MAX_NODES = 2000;
/** 记录状态机：off（未记录）→ recording（记录中）→ saved（已保存保留显示）→ off。 */
type TraceState = 'off' | 'recording' | 'saved';
let traceState: TraceState = 'off';
/** WorkerA 节点滚动窗口上限（转发前截断，防内存溢出）。 */
const traceNodes: { base: { x: number; y: number; z: number }; tick: { x: number; y: number; z: number } }[] = [];

/** 按钮切换（开始 → 保存 → 删除 → 开始 循环）。 */
traceBtn?.addEventListener('click', () => {
  if (traceState === 'off') {
    // 开始：清空旧路径 + 开启记录
    workerB.postMessage({ type: 'trace-clear' });
    traceNodes.length = 0;
    traceSyncCount = 0;
    workerA.postMessage({ type: 'trace', enabled: true });
    traceState = 'recording';
    traceBtn.textContent = '保存';
  } else if (traceState === 'recording') {
    // 保存：停止记录（WorkerA 停止采样发送），路径保留在 3D 场景中显示
    workerA.postMessage({ type: 'trace', enabled: false });
    traceState = 'saved';
    traceBtn.textContent = '删除';
  } else {
    // 删除：清空路径线（3D 场景）→ 回到初始
    workerB.postMessage({ type: 'trace-clear' });
    traceNodes.length = 0;
    traceState = 'off';
    traceBtn.textContent = '开始';
  }
});

// WorkerA trace-data 消息：累积节点（滚动窗口上限）→ 转发 WorkerB 3D 路径线
// trace-sync：兜底事件计数（图例显示）
let traceSyncCount = 0;
workerA.onmessage = (e: MessageEvent<{ type: string; baseX?: number; baseY?: number; baseZ?: number; tickX?: number; tickY?: number; tickZ?: number; dist?: number }>) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'trace-sync') {
    // 位置兜底触发（physBase 拉回 phys）——拟合良好时应仅偶发
    traceSyncCount++;
    const legend = document.getElementById('traceLegend');
    if (legend) legend.textContent = `兜底 ×${traceSyncCount}`;
    return;
  }
  if (msg.type !== 'trace-data') return;
  // 仅记录中转发（保存/删除后忽略残留消息）
  if (traceState !== 'recording') return;
  traceNodes.push({
    base: { x: msg.baseX!, y: msg.baseY!, z: msg.baseZ! },
    tick: { x: msg.tickX!, y: msg.tickY!, z: msg.tickZ! },
  });
  if (traceNodes.length > TRACE_MAX_NODES) traceNodes.shift();
  // 转发 WorkerB → 3D 场景路径线更新
  workerB.postMessage({
    type: 'trace-point',
    baseX: msg.baseX!, baseY: msg.baseY!, baseZ: msg.baseZ!,
    tickX: msg.tickX!, tickY: msg.tickY!, tickZ: msg.tickZ!,
  });
};

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
  shared.wake(); // 双槽通知：WAKEUP → WorkerA 背压 + RENDER_WAKEUP → WorkerB 渲染帧信号（vsync 对齐）
}
requestAnimationFrame(frame);
