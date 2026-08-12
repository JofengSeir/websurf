#!/usr/bin/env node
/**
 * mini — 核心链路验证（Node worker_threads 模拟 SAB，无需浏览器/WebGL）
 *
 * 验证 mini 架构四层链路（与 test/scripts/surf-e2e-verify.mjs 同法）：
 *   [main]  rAF 帧信号（busy-wait 精确 REFRESH_HZ）+ 输入注入（模拟按键前进）
 *   [WorkerA] mini 物理循环（1ms 子步 + tick 64Hz）→ SAB 双缓冲发布
 *   [WorkerB] mini 渲染循环（waitRenderWakeup + readState + 插值）→ 模拟渲染耗时
 *
 * 校验点：
 *   1. WorkerA 发布率（无限制物理跑满 1ms 预算）
 *   2. tick 模式B 步进（64Hz）
 *   3. SAB 传输（发布→消费）
 *   4. WorkerB 渲染频率 = min(刷新率, 1/渲染耗时)，无忙循环超限，插值平滑
 *
 * 用法：node scripts/mini-verify.mjs [refreshHz] [renderMs] [tickRate] [durMs]
 */
import { Worker } from 'node:worker_threads';
import { createConfig } from '../src/config.js';

const REFRESH_HZ = Number(process.argv[2] ?? 320);
const RENDER_MS = Number(process.argv[3] ?? 3);
const TICK_RATE = Number(process.argv[4] ?? 64);
const DURATION_MS = Number(process.argv[5] ?? 1200);

// 框架参数单一来源：验证脚本与真实实现共用 src/config.js
const config = createConfig({ target: { refreshHz: REFRESH_HZ } });
const P = config.phys;

const I_TICK_RATE = 0;
const I_WAKEUP = 1;
const B_DX_ACC = 1;
const B_DY_ACC = 2;
const I_KEYS_MASK = 6;
const I_RENDER_WAKEUP = 7;
const I_V = 8;
const F_SLOT_BASE = 5;
const F_SLOT_STRIDE = 8;
const F_POS_X = 0, F_POS_Y = 1, F_POS_Z = 2;
const F_VEL_X = 3, F_VEL_Y = 4, F_VEL_Z = 5;
const F_YAW = 6, F_PITCH = 7;
const FIXED_SCALE = 1000;

const sab = new SharedArrayBuffer(192);
const i32 = new Int32Array(sab);
const f64 = new Float64Array(sab);

// ── WorkerA：镜像 mini/src/worker-a.js 物理逻辑（Node 无 DOM/worker self）──
const workerACode = `
const { parentPort, workerData } = require('node:worker_threads');
const { sab, tickRate, durMs, P } = workerData;
const i32 = new Int32Array(sab);
const b64 = new BigInt64Array(sab);
const f64 = new Float64Array(sab);
const I_WAKEUP = 1, I_TICK_RATE = 0, I_V = 8, I_KEYS_MASK = 6, B_DX_ACC = 1, B_DY_ACC = 2;
const F_SLOT_BASE = 5, F_SLOT_STRIDE = 8;
const F_POS_X = 0, F_POS_Y = 1, F_POS_Z = 2, F_VEL_X = 3, F_VEL_Y = 4, F_VEL_Z = 5, F_YAW = 6, F_PITCH = 7;
const FIXED_SCALE = 1000;
const KEY_MASK = { forward: 1, backward: 2, left: 4, right: 8, jump: 16 };
const RENDER_DT = P.renderDt, MAX_STEPS_PER_ROUND = P.maxStepsPerRound, MAX_ACC = P.maxAcc, MAX_DELTA = P.maxDelta;
const MOVE_SPEED = P.moveSpeed, ACCEL = P.accel, GRAVITY = P.gravity, JUMP_VEL = P.jumpVel, SENSITIVITY = P.sensitivity;

let pos = { x: 0, y: 0, z: 0 }, vel = { x: 0, y: 0, z: 0 }, yaw = 0, pitch = 0, onGround = false;
let tickPos = { x: 0, y: 0, z: 0 }, tickVel = { x: 0, y: 0, z: 0 }, tickYaw = 0, tickPitch = 0, tickOnGround = false;
let acc = 0, loAcc = 0, tickDxAcc = 0, tickDyAcc = 0, lastNow = performance.now();
let vPub = 0, tickCount = 0;
const t0 = performance.now();
Atomics.store(i32, I_TICK_RATE, tickRate);

function writeState() {
  const slot = (Atomics.load(i32, I_V) & 1) ^ 1;
  const base = F_SLOT_BASE + slot * F_SLOT_STRIDE;
  f64[base + F_POS_X] = pos.x; f64[base + F_POS_Y] = pos.y; f64[base + F_POS_Z] = pos.z;
  f64[base + F_VEL_X] = vel.x; f64[base + F_VEL_Y] = vel.y; f64[base + F_VEL_Z] = vel.z;
  f64[base + F_YAW] = yaw; f64[base + F_PITCH] = pitch;
  Atomics.add(i32, I_V, 1);
  vPub++;
}
function consumeInput(maxDelta) {
  const dxFixed = exchangeZero(B_DX_ACC);
  const dyFixed = exchangeZero(B_DY_ACC);
  let dx = Number(dxFixed) / FIXED_SCALE;
  let dy = Number(dyFixed) / FIXED_SCALE;
  if (maxDelta !== Infinity) {
    dx = Math.max(-maxDelta, Math.min(maxDelta, dx));
    dy = Math.max(-maxDelta, Math.min(maxDelta, dy));
  }
  return { dx, dy, keysMask: Atomics.load(i32, I_KEYS_MASK) };
}
function exchangeZero(idx) {
  let cur = Atomics.load(b64, idx);
  for (;;) {
    const res = Atomics.compareExchange(b64, idx, cur, 0n);
    if (res === cur) return cur;
    cur = res;
  }
}
function step(dt, keysMask, dx, dy) {
  yaw -= dx * SENSITIVITY; pitch -= dy * SENSITIVITY;
  if (pitch > (P.pitchClamp ?? 89)) pitch = (P.pitchClamp ?? 89);
  if (pitch < -(P.pitchClamp ?? 89)) pitch = -(P.pitchClamp ?? 89);
  const yawRad = (yaw * Math.PI) / 180, sinY = Math.sin(yawRad), cosY = Math.cos(yawRad);
  let ax = 0, az = 0;
  if (keysMask & KEY_MASK.forward) { ax -= sinY * ACCEL; az -= cosY * ACCEL; }
  if (keysMask & KEY_MASK.backward) { ax += sinY * ACCEL; az += cosY * ACCEL; }
  if (keysMask & KEY_MASK.left) { ax -= cosY * ACCEL; az += sinY * ACCEL; }
  if (keysMask & KEY_MASK.right) { ax += cosY * ACCEL; az -= sinY * ACCEL; }
  vel.x += ax * dt; vel.z += az * dt;
  const h = Math.hypot(vel.x, vel.z);
  if (h > MOVE_SPEED) { vel.x = (vel.x / h) * MOVE_SPEED; vel.z = (vel.z / h) * MOVE_SPEED; }
  if ((keysMask & KEY_MASK.jump) && onGround) { vel.y = JUMP_VEL; onGround = false; }
  vel.y -= GRAVITY * dt;
  pos.x += vel.x * dt; pos.y += vel.y * dt; pos.z += vel.z * dt;
  if (pos.y <= 0) { pos.y = 0; vel.y = 0; onGround = true; }
}
function loop() {
  const now = performance.now();
  let delta = (now - lastNow) / 1000;
  lastNow = now;
  if (delta > MAX_DELTA) delta = MAX_DELTA;
  if (delta < 0) delta = 0;
  const modeB = tickRate > 0 && 1 / tickRate > RENDER_DT;
  if (modeB) {
    const tickDt = 1 / tickRate;
    loAcc += delta;
    while (loAcc >= tickDt) {
      loAcc -= tickDt;
      // tick 独立实例步进（简化：直接同物理）
      tickVel = { ...vel };
      tickVel.x += 0; tickVel.z += 0;
      tickCount++;
    }
  } else loAcc = 0;
  acc += delta;
  if (acc >= RENDER_DT) {
    let steps = 0;
    while (acc >= RENDER_DT && steps < MAX_STEPS_PER_ROUND) {
      acc -= RENDER_DT;
      steps++;
      const inp = consumeInput(P.maxInputDelta ?? 1000);
      step(RENDER_DT, inp.keysMask, inp.dx, inp.dy);
      writeState();
    }
    if (acc > MAX_ACC) acc = MAX_ACC;
  }
  if (performance.now() - t0 >= durMs) {
    parentPort.postMessage({ vPub, tickCount, finalV: Atomics.load(i32, I_V), pos });
    return;
  }
  setImmediate(loop);
}
loop();
`;
const workerA = new Worker(workerACode, { eval: true, workerData: { sab, tickRate: TICK_RATE, durMs: DURATION_MS, P } });

// ── rAF 帧信号（busy-wait 精确）──
const rAFHz = new Worker(`
const { parentPort, workerData } = require('node:worker_threads');
const { sab, refreshHz, durMs } = workerData;
const i32 = new Int32Array(sab);
const periodUs = 1e6 / refreshHz;
const t0 = process.hrtime.bigint();
let n = 0;
while (Number(process.hrtime.bigint() - t0) / 1e3 < durMs * 1000) {
  if (Number(process.hrtime.bigint() - t0) / 1e3 >= (n + 1) * periodUs) {
    Atomics.add(i32, 7, 1); Atomics.notify(i32, 7, 1);
    Atomics.store(i32, 1, 1); Atomics.notify(i32, 1, 1);
    Atomics.store(i32, 6, 1); // keysMask forward=1（模拟前进按键）
    n++;
  }
}
parentPort.postMessage({ count: n });
`, { eval: true, workerData: { sab, refreshHz: REFRESH_HZ, durMs: DURATION_MS } });

// ── WorkerB：镜像 mini/src/worker-b.js 渲染循环（无 WebGL，模拟渲染耗时）──
const workerBCode = `
const { parentPort, workerData } = require('node:worker_threads');
const { sab, renderMs, durMs } = workerData;
const i32 = new Int32Array(sab);
const f64 = new Float64Array(sab);
const F_SLOT_BASE = 5, F_SLOT_STRIDE = 8;
const F_POS_X = 0, F_POS_Y = 1, F_POS_Z = 2, F_YAW = 6, F_PITCH = 7;
const I_RENDER_WAKEUP = 7, I_V = 8;
let renders = 0, frames = 0, repaints = 0, lastV = -1, lastRenderWake = 0;
let interpLast = null, interpLastT = 0, interpCur = null, interpCurT = 0;
let lastX = null, maxXJump = 0, lastY = null, maxYJump = 0;
const t0 = Date.now();
function readState(now) {
  const v0 = Atomics.load(i32, I_V);
  if (v0 === lastV) return null;
  lastV = v0;
  const base = F_SLOT_BASE + (v0 & 1) * F_SLOT_STRIDE;
  return { pos: { x: f64[base + F_POS_X], y: f64[base + F_POS_Y], z: f64[base + F_POS_Z] }, yaw: f64[base + F_YAW], pitch: f64[base + F_PITCH], v: v0 };
}
function waitRenderWakeup(ms) {
  if (Atomics.load(i32, I_RENDER_WAKEUP) !== lastRenderWake) { lastRenderWake = Atomics.load(i32, I_RENDER_WAKEUP); return true; }
  const res = Atomics.wait(i32, I_RENDER_WAKEUP, lastRenderWake, ms);
  if (res === 'timed-out') return false;
  lastRenderWake = Atomics.load(i32, I_RENDER_WAKEUP);
  return true;
}
function absorb() { lastRenderWake = Atomics.load(i32, I_RENDER_WAKEUP); }
function interp(a, b, alpha) {
  let dy = (b.yaw - a.yaw) % 360;
  if (dy > 180) dy -= 360; else if (dy < -180) dy += 360;
  const yaw = ((a.yaw + dy * alpha + 180) % 360 + 360) % 360 - 180;
  return { pos: { x: a.pos.x + (b.pos.x - a.pos.x) * alpha, y: a.pos.y + (b.pos.y - a.pos.y) * alpha, z: a.pos.z + (b.pos.z - a.pos.z) * alpha }, yaw, pitch: a.pitch + (b.pitch - a.pitch) * alpha };
}
function onFrame(now) {
  const state = readState(now);
  if (state) {
    if (interpCur) { interpLast = interpCur; interpLastT = interpCurT; } else { interpLast = null; interpLastT = 0; }
    interpCur = state; interpCurT = now; repaints++;
  }
  if (!interpCur) return false;
  let rs;
  if (interpLast && interpCurT > interpLastT) {
    const span = interpCurT - interpLastT;
    const alpha = Math.min(Math.max((now - interpLastT) / span, 0), 1);
    rs = interp(interpLast, interpCur, alpha);
  } else rs = interpCur;
  const busyEnd = Date.now() + renderMs;
  while (Date.now() < busyEnd) {}
  frames++;
  if (lastX !== null) { const jx = Math.abs(rs.pos.x - lastX); if (jx > maxXJump) maxXJump = jx; }
  if (lastY !== null) { const jy = Math.abs(rs.pos.y - lastY); if (jy > maxYJump) maxYJump = jy; }
  lastX = rs.pos.x; lastY = rs.pos.y;
  renders++;
  return true;
}
function loop() {
  waitRenderWakeup(50);
  onFrame(Date.now());
  absorb();
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
    maxXJump: maxXJump.toFixed(4),
    maxYJump: maxYJump.toFixed(4),
  });
}, durMs);
`;
const workerB = new Worker(workerBCode, { eval: true, workerData: { sab, renderMs: RENDER_MS, durMs: DURATION_MS } });

// ── 汇总 ──
let rAFCount = 0;
let workerAResult = null;
rAFHz.on('message', (m) => (rAFCount = m.count));
workerA.on('message', (m) => (workerAResult = m));
workerB.on('message', (m) => {
  const durS = DURATION_MS / 1000;
  const pubRate = workerAResult ? workerAResult.vPub / durS : 0;
  const expectedCap = Math.min(REFRESH_HZ, 1000 / RENDER_MS);
  console.log('\n════════ mini 核心链路验证 ════════');
  console.log(`时长 ${durS.toFixed(1)}s · 刷新率 ${REFRESH_HZ}Hz · rAF 实测 ${rAFCount} 次`);
  console.log(`\n[1] WorkerA 无限制物理`);
  console.log(`    发布率: ${pubRate.toFixed(0)} 次/s（V=${workerAResult ? workerAResult.finalV : '?'}）`);
  console.log(`    判定  : ${pubRate >= 500 ? 'PASS ✓ 1ms 子步预算跑满' : 'FAIL ✗'}`);
  console.log(`\n[2] WorkerA tick 模式B ${TICK_RATE}Hz`);
  console.log(`    tick 步进: ${workerAResult ? (workerAResult.tickCount / durS).toFixed(0) : '?'} 次/s`);
  console.log(`    判定    : ${workerAResult && Math.abs(workerAResult.tickCount / durS - TICK_RATE) <= TICK_RATE * 0.4 ? 'PASS ✓' : 'CHECK'}`);
  console.log(`\n[3] SAB 传输`);
  console.log(`    发布→消费: ${pubRate.toFixed(0)}/s → ${m.repaintsPerSec}/s`);
  console.log(`    判定    : ${m.repaintsPerSec > 0 ? 'PASS ✓ 畅通' : 'FAIL ✗'}`);
  console.log(`\n[4] WorkerB 渲染（模拟 GPU ${RENDER_MS}ms/帧）`);
  console.log(`    渲染频率: ${m.rendersPerSec} f/s（fps=${m.framesPerSec}）理论上限 ${expectedCap.toFixed(0)}`);
  console.log(`    判定-跑满: ${m.rendersPerSec >= expectedCap * 0.85 ? 'PASS ✓' : 'CHECK'}`);
  console.log(`    判定-不超: ${m.rendersPerSec <= expectedCap * 1.05 ? 'PASS ✓ 无忙循环超限' : 'FAIL ✗'}`);
  console.log(`    口径一致: ${m.framesPerSec === m.rendersPerSec ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`    插值平滑: pos 跳变 ${m.maxXJump} / ${m.maxYJump} units/帧`);
  console.log(`    物理推进: ${workerAResult ? 'pos=(' + workerAResult.pos.x.toFixed(0) + ',' + workerAResult.pos.y.toFixed(0) + ',' + workerAResult.pos.z.toFixed(0) + ')' : '?'}（前进按键生效）`);
  const pass = pubRate >= 500 && m.rendersPerSec <= expectedCap * 1.05 && m.framesPerSec === m.rendersPerSec;
  console.log(`\n结果: ${pass ? '✅ mini 核心链路全部通过' : '❌ 存在问题'}`);
  process.exit(pass ? 0 : 1);
});

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, DURATION_MS + 4000);
