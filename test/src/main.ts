/**
 * WebSurf-test — 主线程入口（时序图 阶段0/1/4）。
 *
 * 职责（绝不做物理/渲染）：
 * - 前置条件检测：crossOriginIsolated + SharedArrayBuffer 支持，失败显示错误面板并停止
 * - 创建 SAB + WorkerA（物理）/ WorkerB（渲染），transfer 共享内存
 * - 阶段1：捕获鼠标（pointer lock 后累积）与键盘（WASD/空格），
 *   每 rAF 一次性 Atomics.add 写入 SAB 输入槽后清零（提取无上限）
 *   → wake()（store(WAKEUP,1) + notify(WAKEUP,1) 唤醒 WorkerA）
 *   → workerB.postMessage({type:'frame'})（帧信号驱动 WorkerB 渲染）
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
const sabSupported = typeof SharedArrayBuffer !== 'undefined';
const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
if (!sabSupported || !isolated) {
  const reasons: string[] = [];
  if (!sabSupported) reasons.push('当前浏览器不支持 SharedArrayBuffer');
  if (!isolated) reasons.push('页面未启用 crossOriginIsolated（需 HTTP + COOP/COEP 响应头）');
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed;inset:0;z-index:99;display:flex;align-items:center;justify-content:center;',
    'background:#1a1016;color:#ffb4b4;font:14px/1.8 -apple-system,"PingFang SC",monospace;',
  ].join('');
  const box = document.createElement('div');
  box.style.cssText = 'max-width:640px;padding:28px 32px;border:1px solid rgba(255,90,90,.4);border-radius:12px;background:#241419;';
  box.innerHTML =
    '<div style="font-size:16px;font-weight:600;margin-bottom:8px">WebSurf-test 无法启动</div>' +
    '<div>共享内存前置条件未满足：</div>' +
    `<ul style="margin:8px 0 12px 20px">${reasons.map((r) => `<li>${r}</li>`).join('')}</ul>` +
    '<div style="color:#d99">请用 <code>python ../src/serve.py 8080 dist</code> 提供 HTTP + COOP/COEP 头后访问。</div>';
  panel.appendChild(box);
  document.body.appendChild(panel);
  throw new Error(`前置条件失败: ${reasons.join('；')}`);
}

// ── 共享内存 + 双 Worker 创建（dev 与 dist 同构：module worker + 外置 wasm）──
const sab = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
const workerA = new Worker(new URL('./worker-a.js', import.meta.url), { type: 'module' });
const workerB = new Worker(new URL('./worker-b.js', import.meta.url), { type: 'module' });
workerA.onerror = (e) => console.error('[main] WorkerA 错误:', e.message);
workerB.onerror = (e) => console.error('[main] WorkerB 错误:', e.message);

const shared = TestShared.create(sab, workerA); // postMessage 共享 SAB（非 transfer）
workerB.postMessage({ type: 'init-shared', shared: sab }); // 同上：SAB 不可进 transfer list

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

// ── 主线程 rAF 循环（阶段1）：输入转发 + wake（WorkerB 渲染由自身 rAF 自驱，不依赖 frame 消息——
//    移除 frame 消息避免双渲染过载卡死；渲染绝对自主不受主线程频率限制）──
function frame(): void {
  requestAnimationFrame(frame);
  const dx = mouseDx;
  const dy = mouseDy;
  mouseDx = 0;
  mouseDy = 0;
  const mask = locked ? keysToMask(keyState) : 0;
  shared.addInput(dx, dy, mask); // Atomics.add 累加（主线程耗时 < 0.1ms，绝不参与物理/渲染）
  shared.wake(); // store(WAKEUP,1) + notify(WAKEUP,1) → 唤醒可能挂起的 WorkerA
}
requestAnimationFrame(frame);
