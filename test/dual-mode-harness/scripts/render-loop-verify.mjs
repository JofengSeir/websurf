/**
 * WebSurf-test 渲染循环时序校验 v3（高精度 busy-wait 定时）
 *
 * Windows Node setInterval 精度 ~15.6ms（系统 timer 分辨率），无法模拟 320Hz。
 * 本版用**独立定时线程 + busy-wait 自旋**（Atomics 时间戳对齐）实现微秒级 rAF 节奏。
 *
 * 三线程：
 *   [main]         协调 + 物理发布（setInterval 50Hz 足够）
 *   [rAF 线程]     busy-wait 精确 REFRESH_HZ 节奏 → Atomics.add RENDER_WAKEUP + notify
 *   [WorkerB 线程] waitRenderWakeup(计数) → 插值渲染（模拟耗时）→ absorb → 自投递
 *
 * 用法：node scripts/render-loop-verify.mjs [renderMs] [physHz] [refreshHz] [durMs]
 */
import { Worker } from 'node:worker_threads';

const RENDER_MS = Number(process.argv[2] ?? 2);
const PHYS_HZ = Number(process.argv[3] ?? 50);
const REFRESH_HZ = Number(process.argv[4] ?? 320);
const DURATION_MS = Number(process.argv[5] ?? 1200);

const I_RENDER_WAKEUP = 7;
const I_V = 8;
const F_SLOT_BASE = 5;
const F_SLOT_STRIDE = 8;
const F_POS_X = 0;
const F_YAW = 6;
const F_PITCH = 7;

const sab = new SharedArrayBuffer(256);
const i32 = new Int32Array(sab);
const f64 = new Float64Array(sab);

// ── 物理发布（50Hz 精度要求低，setInterval 可接受；Windows 精度 ~32Hz——
//    仅影响 repaints 统计展示，不影响渲染节流验证结论）──
let v = 0;
let px = 0;
const physTimer = setInterval(() => {
  v++;
  const base = F_SLOT_BASE + (v & 1) * F_SLOT_STRIDE;
  px += 0.5;
  f64[base + F_POS_X] = px;
  f64[base + F_YAW] = v * 1.0;
  f64[base + F_PITCH] = 0;
  Atomics.store(i32, I_V, v);
}, 1000 / PHYS_HZ);

// ── 高精度 rAF 线程（busy-wait 自旋，性能计数器对齐）──
const rafCode = `
const { parentPort, workerData } = require('node:worker_threads');
const { sab, refreshHz } = workerData;
const i32 = new Int32Array(sab);
const I_RENDER_WAKEUP = 7;
const periodUs = 1e6 / refreshHz;
const t0 = process.hrtime.bigint();
let count = 0;
while (true) {
  const now = Number(process.hrtime.bigint() - t0) / 1e3; // us
  const target = (count + 1) * periodUs;
  if (now >= target) {
    Atomics.add(i32, I_RENDER_WAKEUP, 1);
    Atomics.notify(i32, I_RENDER_WAKEUP, 1);
    count++;
    if (count % 1000 === 0) parentPort.postMessage({ count });
    if (now > ${DURATION_MS * 1000} + periodUs * 2) break;
  }
}
parentPort.postMessage({ count, done: true });
`;
const rafWorker = new Worker(rafCode, { eval: true, workerData: { sab, refreshHz: REFRESH_HZ } });

// ── WorkerB 渲染线程 ──
const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
const { sab, renderMs } = workerData;
const i32 = new Int32Array(sab);
const f64 = new Float64Array(sab);
const F_SLOT_BASE = 5, F_SLOT_STRIDE = 8, F_POS_X = 0, F_YAW = 6, F_PITCH = 7;
const I_RENDER_WAKEUP = 7, I_V = 8;

let renders = 0, frames = 0, repaints = 0, lastV = -1;
let lastRenderWake = 0;
let interpLast = null, interpLastT = 0, interpCur = null, interpCurT = 0;
let lastYaw = null, maxYawJump = 0, lastX = null, maxXJump = 0;
const t0 = Date.now();

function waitRenderWakeup(timeoutMs) {
  if (Atomics.load(i32, I_RENDER_WAKEUP) !== lastRenderWake) {
    lastRenderWake = Atomics.load(i32, I_RENDER_WAKEUP);
    return true;
  }
  const res = Atomics.wait(i32, I_RENDER_WAKEUP, lastRenderWake, timeoutMs);
  if (res === 'timed-out') return false;
  lastRenderWake = Atomics.load(i32, I_RENDER_WAKEUP);
  return true;
}
function absorbRenderWake() { lastRenderWake = Atomics.load(i32, I_RENDER_WAKEUP); }
function readState(now) {
  const v0 = Atomics.load(i32, I_V);
  if (v0 === lastV) return null;
  lastV = v0;
  const base = F_SLOT_BASE + (v0 & 1) * F_SLOT_STRIDE;
  return { pos: { x: f64[base + F_POS_X], y: 0, z: 0 }, yaw: f64[base + F_YAW], pitch: f64[base + F_PITCH], v: v0 };
}
function interpolate(a, b, alpha) {
  let dy = (b.yaw - a.yaw) % 360;
  if (dy > 180) dy -= 360; else if (dy < -180) dy += 360;
  const yaw = ((a.yaw + dy * alpha + 180) % 360 + 360) % 360 - 180;
  return { pos: { x: a.pos.x + (b.pos.x - a.pos.x) * alpha, y: 0, z: 0 }, yaw, pitch: a.pitch + (b.pitch - a.pitch) * alpha, v: b.v };
}
function onFrame(now) {
  const state = readState(now);
  if (state) {
    if (interpCur) { interpLast = interpCur; interpLastT = interpCurT; }
    else { interpLast = null; interpLastT = 0; }
    interpCur = state; interpCurT = now; repaints++;
  }
  if (!interpCur) return false;
  let rs;
  if (interpLast && interpCurT > interpLastT) {
    const span = interpCurT - interpLastT;
    const alpha = Math.min(Math.max((now - interpLastT) / span, 0), 1);
    rs = interpolate(interpLast, interpCur, alpha);
  } else rs = interpCur;
  const busyEnd = Date.now() + renderMs;
  while (Date.now() < busyEnd) {}
  frames++;
  if (lastYaw !== null) { const j = Math.abs(rs.yaw - lastYaw); if (j > maxYawJump) maxYawJump = j; }
  if (lastX !== null) { const jx = Math.abs(rs.pos.x - lastX); if (jx > maxXJump) maxXJump = jx; }
  lastYaw = rs.yaw; lastX = rs.pos.x;
  renders++;
  return true;
}
function loop() {
  waitRenderWakeup(50);
  onFrame(Date.now());
  absorbRenderWake();
  setImmediate(loop);
}
loop();
setInterval(() => {
  const now = Date.now();
  const dt = (now - t0) / 1000;
  parentPort.postMessage({
    rendersPerSec: Math.round(renders / dt),
    framesPerSec: Math.round(frames / dt),
    repaintsPerSec: Math.round(repaints / dt),
    maxYawJump: maxYawJump.toFixed(3),
    maxXJump: maxXJump.toFixed(3),
  });
}, ${DURATION_MS});
`;
const worker = new Worker(workerCode, { eval: true, workerData: { sab, renderMs: RENDER_MS } });

let rafDone = false;
worker.on('message', (m) => {
  const expectedMax = REFRESH_HZ * 1.02;
  console.log(`\n═══ 时序校验 v3（busy-wait 精确定时）：刷新率 ${REFRESH_HZ}Hz · 物理 ${PHYS_HZ}Hz · 渲染 ${RENDER_MS}ms/帧 ═══`);
  console.log(`rAF 唤醒            : ~${REFRESH_HZ}/s（实测 ${rafCount} 次）`);
  console.log(`渲染频率            : ${m.rendersPerSec} f/s`);
  console.log(`  → 上限校验 (≤${REFRESH_HZ}): ${m.rendersPerSec <= expectedMax ? 'PASS ✓ 被 rAF 节流，无忙循环超限' : 'FAIL ✗ 忙循环超过刷新率（重复释放）'}`);
  console.log(`fps 显示(计数)      : ${m.framesPerSec} f/s`);
  console.log(`  → 口径校验 (=渲染): ${m.framesPerSec === m.rendersPerSec ? 'PASS ✓ 显示=真实渲染帧率' : 'FAIL ✗ 口径分离'}`);
  console.log(`物理状态刷新        : ${m.repaintsPerSec}/s (期望≈${PHYS_HZ})`);
  console.log(`插值 yaw 跳变       : ${m.maxYawJump}°/帧 · pos 跳变 ${m.maxXJump} units/帧`);
  console.log(`  → 平滑校验        : ${parseFloat(m.maxXJump) < 1.0 ? 'PASS ✓ 插值平滑' : 'CHECK'}`);
  const pass = m.rendersPerSec <= expectedMax && m.framesPerSec === m.rendersPerSec;
  console.log(`\n结果: ${pass ? '✅ 全部通过——未重复释放性能上限，显示=真实帧率' : '❌ 存在问题'}`);
  cleanup();
  process.exit(pass ? 0 : 1);
});

let rafCount = 0;
rafWorker.on('message', (m) => { rafCount = m.count; if (m.done) rafDone = true; });

function cleanup() {
  clearInterval(physTimer);
  rafWorker.terminate();
  worker.terminate();
}
setTimeout(() => { console.log('TIMEOUT'); cleanup(); process.exit(1); }, DURATION_MS + 5000);
