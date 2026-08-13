/**
 * mini — 主线程（架构与 test/src/main.ts 一致：仅输入转发 / UI / 帧信号）
 *
 * 职责（绝不做物理/渲染）：
 * - 创建 config + SAB + WorkerA（物理）/ WorkerB（渲染），transfer 共享内存
 * - 键盘/鼠标输入收集 → SAB 输入槽（addInput；键位映射来自 config）
 * - rAF 循环：每帧 wake()（双槽：WAKEUP → WorkerA 背压 + RENDER_WAKEUP → WorkerB 帧信号）
 * - WorkerB 状态摘要 → HUD（每秒一次）
 *
 * 所有可调参数来自 ./config.js（createConfig 单一来源）——改参数不碰业务代码。
 */

import { TestShared, KEY_MASK, SHARED_BUFFER_SIZE } from './shared-state.js';
import { createConfig } from './config.js';

// 应用全局配置（生产跟随显示器刷新率；测试可注入 target.refreshHz）
// 注入方式（优先级从高到低）：
//   1. URL 查询参数 ?config=<JSON>（浏览器直接改参数，无需改代码）
//   2. globalThis.__MINI_CONFIG__（测试环境注入）
let injected = globalThis.__MINI_CONFIG__;
try {
  const q = new URLSearchParams(location.search).get('config');
  if (q) injected = JSON.parse(q);
} catch { /* 非法 JSON 忽略，用默认 */ }
const config = createConfig(injected);
const keyMap = config.input.keyMap;

const canvas = document.getElementById('game');
const statusEl = document.getElementById('status');

// ── 键盘状态（键位映射来自 config）─────────────────────────────
const keyState = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  jump: false,
};
const keyCodeToAction = Object.fromEntries(
  Object.entries(keyMap).map(([action, code]) => [code, action]),
);
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const action = keyCodeToAction[e.code];
  if (action === 'respawn') {
    workerA?.postMessage({ type: 'respawn' });
    return;
  }
  if (action && action in keyState) keyState[action] = true;
});
window.addEventListener('keyup', (e) => {
  const action = keyCodeToAction[e.code];
  if (action && action in keyState) keyState[action] = false;
});

// ── 指针锁定 + 鼠标增量（mousemove 高频事件只累积，不触碰 SAB）──
let locked = false;
let mouseDx = 0;
let mouseDy = 0;
canvas.addEventListener('click', () => {
  if (!locked) void canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  mouseDx = 0;
  mouseDy = 0;
});
window.addEventListener('mousemove', (e) => {
  if (!locked) return;
  mouseDx += e.movementX;
  mouseDy += e.movementY;
});

// ── Worker 创建 + SAB 共享 + config 注入 ──────────────────────
const workerA = new Worker(new URL('./worker-a.js', import.meta.url), { type: 'module' });
const workerB = new Worker(new URL('./worker-b.js', import.meta.url), { type: 'module' });
workerA.onerror = (e) => console.error('[mini] WorkerA 错误:', e.message);
workerB.onerror = (e) => console.error('[mini] WorkerB 错误:', e.message);

const sab = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
const shared = TestShared.create(sab, workerA);
workerA.postMessage({ type: 'init-shared', shared: sab, config });
workerB.postMessage({ type: 'init-shared', shared: sab, config });

// ── 难度选择（tick 率：0=纯无限制，32/64/128/1000）────────────
const rateBtns = document.querySelectorAll('#ratebar button');
rateBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    rateBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    shared.writeTickRate(Number(btn.dataset.rate));
  });
});
shared.writeTickRate(config.phys.tickRate);

// ── WorkerB 渲染控制权 + 状态摘要 ──────────────────────────────
const offscreen = canvas.transferControlToOffscreen();
workerB.postMessage({ type: 'init-canvas', canvas: offscreen }, [offscreen]);
// 首帧同步实际窗口尺寸（OffscreenCanvas 转移后无样式，必须显式设置 buffer 尺寸）
workerB.postMessage({
  type: 'resize',
  width: Math.max(1, Math.round(canvas.clientWidth || window.innerWidth)),
  height: Math.max(1, Math.round(canvas.clientHeight || window.innerHeight)),
});
window.addEventListener('resize', () => {
  workerB.postMessage({
    type: 'resize',
    width: Math.max(1, Math.round(canvas.clientWidth)),
    height: Math.max(1, Math.round(canvas.clientHeight)),
  });
});

workerB.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'status') return;
  const parts = [];
  if (msg.pos) {
    parts.push(`pos (${msg.pos.x.toFixed(1)}, ${msg.pos.y.toFixed(1)}, ${msg.pos.z.toFixed(1)})`);
    if (msg.yaw !== null) parts.push(`yaw ${msg.yaw.toFixed(1)}°`);
    if (msg.pitch !== null) parts.push(`pitch ${msg.pitch.toFixed(1)}°`);
  }
  parts.push(`渲染 ${msg.fps} f/s · 物理刷新 ${msg.repaintSec}/s`);
  statusEl.textContent = parts.join(' · ');
};

// ── 主线程 rAF 循环（阶段1）：输入转发 + wake（双槽帧信号）──
function frame() {
  requestAnimationFrame(frame);
  const dx = mouseDx;
  const dy = mouseDy;
  mouseDx = 0;
  mouseDy = 0;
  const mask = locked ? keysToMask(keyState) : 0;
  shared.addInput(dx, dy, mask);
  shared.wake(); // WAKEUP → WorkerA 背压 + RENDER_WAKEUP → WorkerB 帧信号
}
requestAnimationFrame(frame);

function keysToMask(keys) {
  let m = 0;
  if (keys.forward) m |= KEY_MASK.forward;
  if (keys.backward) m |= KEY_MASK.backward;
  if (keys.left) m |= KEY_MASK.left;
  if (keys.right) m |= KEY_MASK.right;
  if (keys.jump) m |= KEY_MASK.jump;
  return m;
}
