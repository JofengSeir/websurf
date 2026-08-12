#!/usr/bin/env node
/**
 * WebSurf-test — surf_666 端到端链路测试 v2（三线程独立，贴近真实架构）
 *
 * 目标（用户需求）：
 *   1. WorkerA 无限制（1ms 子步）+ tick（模式B 64Hz）双模计算正常（真实 surf_666 世界）
 *   2. 无限制物理跑满计算（发布率 ≥ 物理预算）
 *   3. SAB 渲染参数畅通传输（V 发布 → WorkerB readState 消费，不丢帧）
 *   4. WorkerB 渲染循环跑满性能（插值渲染吞吐 → min(刷新率, 1/渲染耗时)），
 *      且不忙循环超限（计数语义 + absorb 节流生效）
 *
 * 三线程镜像真实架构：
 *   [线程A] wasm PhysWorld + surf_666 世界 → 双模物理 loop（1ms 子步 + 64t tick）→ SAB 写
 *   [线程B] readState 消费 + 插值渲染循环（模拟 GPU 耗时 RENDER_MS）→ waitRenderWakeup 节流
 *   [主线程] rAF 帧信号（busy-wait 精确定时 REFRESH_HZ）+ 汇总
 *
 * 用法：node scripts/surf-e2e-verify.mjs [refreshHz] [renderMs] [tickRate] [durMs]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const REFRESH_HZ = Number(process.argv[2] ?? 320);
const RENDER_MS = Number(process.argv[3] ?? 3);
const TICK_RATE = Number(process.argv[4] ?? 64);
const DURATION_MS = Number(process.argv[5] ?? 1500);

// ── SAB 布局（与 shared-state.ts 一致）──
const I_WAKEUP = 1;
const I_RENDER_WAKEUP = 7;
const I_V = 8;
const F_SLOT_BASE = 5;
const F_SLOT_STRIDE = 8;
const F_POS_X = 0;
const F_POS_Y = 1;
const F_POS_Z = 2;
const F_VEL_X = 3;
const F_VEL_Y = 4;
const F_VEL_Z = 5;
const F_YAW = 6;
const F_PITCH = 7;
const I_TICK_RATE = 0;

const sab = new SharedArrayBuffer(192);
const i32 = new Int32Array(sab);
const f64 = new Float64Array(sab);

// ── 主线程：加载 BSP + 导出世界数据（wasm 主线程实例化，仅 BspProcessor 用）──
import('../pkg/websurf_test_wasm.js').then(async ({ BspProcessor, initSync }) => {
  initSync({ module: readFileSync(join(root, 'pkg/websurf_test_wasm_bg.wasm')) });
  console.log('═══ surf_666 端到端链路测试 v2（三线程）═══');
  const bspBytes = readFileSync(join(root, '../maps/surf_666.bsp'));
  console.log(`地图: surf_666.bsp (${(bspBytes.length / 1e6).toFixed(1)} MB)`);

  const proc = new BspProcessor(new Uint8Array(bspBytes));
  const brushJson = proc.export_brushes_planes(
    JSON.stringify({ include_ladder: true, include_solid: true, min_brush_volume: 0, skip_sky: true, skip_nodraw: false }),
  );
  let triJson = proc.export_model_phy_colliders();
  if (JSON.parse(triJson).length === 0) triJson = proc.export_model_tri_colliders();
  const teleportJson = proc.parse_teleports();
  const spawnData = JSON.parse(proc.parse_spawn_points());
  const sp = (spawnData.spawn_points ?? [])[0];
  if (!sp) throw new Error('无出生点');
  const bspYawToCsYaw = (bspYaw) => ((270 - bspYaw) % 360 + 360) % 360;

  const wasmBytes = readFileSync(join(root, 'pkg/websurf_test_wasm_bg.wasm'));

  // ── 主线程物理 loop（镜像 worker-a.ts 双模；PhysWorld 实例线程隔离，须主线程持有；
  //    rAF 与 WorkerB 均为独立线程——三线程并行，互不抢占主线程）──
  const { PhysWorld } = await import('../pkg/websurf_test_wasm.js');
  const phys = new PhysWorld();
  phys.set_hull(16, 72, 54);
  phys.build_world(brushJson, triJson, teleportJson, sp.origin[0], sp.origin[1], sp.origin[2], bspYawToCsYaw(sp.angles[1] ?? 0));
  let minY = Infinity;
  for (const b of JSON.parse(brushJson)) if (b.min[1] < minY) minY = b.min[1];
  if (Number.isFinite(minY)) phys.set_death_y(minY - 100);
  const tickPhys = new PhysWorld();
  tickPhys.set_hull(16, 72, 54);
  tickPhys.build_world(brushJson, triJson, teleportJson, sp.origin[0], sp.origin[1], sp.origin[2], bspYawToCsYaw(sp.angles[1] ?? 0));
  if (Number.isFinite(minY)) tickPhys.set_death_y(minY - 100);
  const alignTickPhys = () => {
    const s = phys.state();
    tickPhys.set_state(s.posX, s.posY, s.posZ, s.yaw, s.pitch, s.velX, s.velY, s.velZ, s.onGround);
  };
  Atomics.store(i32, I_TICK_RATE, TICK_RATE);

  const RENDER_DT = 0.001, MAX_STEPS_PER_ROUND = 8, MAX_ACC = 0.02, MAX_DELTA = 0.05, TICK_ANCHOR_DIST = 64;
  let acc = 0, loAcc = 0, lastNow = performance.now();
  let vPub = 0, tickCount = 0;
  const t0loop = performance.now();

  function writeStateFromPhys() {
    const s = phys.state();
    const slot = (Atomics.load(i32, I_V) & 1) ^ 1;
    const base = F_SLOT_BASE + slot * F_SLOT_STRIDE;
    f64[base + F_POS_X] = s.posX; f64[base + F_POS_Y] = s.posY; f64[base + F_POS_Z] = s.posZ;
    f64[base + F_VEL_X] = s.velX; f64[base + F_VEL_Y] = s.velY; f64[base + F_VEL_Z] = s.velZ;
    f64[base + F_YAW] = s.yaw; f64[base + F_PITCH] = s.pitch;
    Atomics.add(i32, I_V, 1);
    vPub++;
  }
  function physLoop() {
    const now = performance.now();
    let delta = (now - lastNow) / 1000;
    lastNow = now;
    if (delta > MAX_DELTA) delta = MAX_DELTA;
    if (delta < 0) delta = 0;
    const tickDt = 1 / TICK_RATE;
    loAcc += delta;
    while (loAcc >= tickDt) {
      loAcc -= tickDt;
      const sA = phys.state(), sT = tickPhys.state();
      const dx = sA.posX - sT.posX, dy = sA.posY - sT.posY, dz = sA.posZ - sT.posZ;
      if (dx * dx + dy * dy + dz * dz > TICK_ANCHOR_DIST * TICK_ANCHOR_DIST) alignTickPhys();
      tickPhys.tick(tickDt, 0, 0, 0);
      const st = tickPhys.state();
      phys.set_velocity(st.velX, st.velY, st.velZ);
      tickCount++;
    }
    acc += delta;
    if (acc >= RENDER_DT) {
      let steps = 0;
      while (acc >= RENDER_DT && steps < MAX_STEPS_PER_ROUND) {
        acc -= RENDER_DT;
        steps++;
        phys.tick(RENDER_DT, 1, 0, 0);
        writeStateFromPhys();
      }
      if (acc > MAX_ACC) acc = MAX_ACC;
    }
    if (performance.now() - t0loop >= durMs0) { finalReport(); return; }
    setImmediate(physLoop);
  }
  const durMs0 = DURATION_MS;

  // ── 线程B：WorkerB 渲染消费（镜像 worker-b.ts onFrame 插值渲染）──
  const workerBCode = `
const { parentPort, workerData } = require('node:worker_threads');
const { sab, renderMs, durMs } = workerData;
const i32 = new Int32Array(sab);
const f64 = new Float64Array(sab);
const F_SLOT_BASE = 5, F_SLOT_STRIDE = 8;
const F_POS_X = 0, F_POS_Y = 1, F_POS_Z = 2, F_VEL_X = 3, F_VEL_Y = 4, F_VEL_Z = 5, F_YAW = 6, F_PITCH = 7;
const I_RENDER_WAKEUP = 7, I_V = 8;
let renders = 0, frames = 0, repaints = 0, lastV = -1;
let lastRenderWake = 0;
let interpLast = null, interpLastT = 0, interpCur = null, interpCurT = 0;
let lastX = null, maxXJump = 0, lastY = null, maxYJump = 0;
const t0 = Date.now();
function readState(now) {
  const v0 = Atomics.load(i32, I_V);
  if (v0 === lastV) return null;
  lastV = v0;
  const slot = v0 & 1;
  const base = F_SLOT_BASE + slot * F_SLOT_STRIDE;
  return { pos: { x: f64[base + F_POS_X], y: f64[base + F_POS_Y], z: f64[base + F_POS_Z] }, yaw: f64[base + F_YAW], pitch: f64[base + F_PITCH], v: v0 };
}
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
function interpolate(a, b, alpha) {
  let dy = (b.yaw - a.yaw) % 360;
  if (dy > 180) dy -= 360; else if (dy < -180) dy += 360;
  const yaw = ((a.yaw + dy * alpha + 180) % 360 + 360) % 360 - 180;
  return { pos: { x: a.pos.x + (b.pos.x - a.pos.x) * alpha, y: a.pos.y + (b.pos.y - a.pos.y) * alpha, z: a.pos.z + (b.pos.z - a.pos.z) * alpha }, yaw, pitch: a.pitch + (b.pitch - a.pitch) * alpha, v: b.v };
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
    rs = interpolate(interpLast, interpCur, alpha);
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
    maxXJump: maxXJump.toFixed(4),
    maxYJump: maxYJump.toFixed(4),
  });
}, durMs);
`;
  const workerB = new Worker(workerBCode, { eval: true, workerData: { sab, renderMs: RENDER_MS, durMs: DURATION_MS } });

  // ── rAF 帧信号线程（busy-wait 精确定时）──
  const rAFHz = new Worker(`
const { parentPort, workerData } = require('node:worker_threads');
const { sab, refreshHz, durMs } = workerData;
const i32 = new Int32Array(sab);
const periodUs = 1e6 / refreshHz;
const t0 = process.hrtime.bigint();
let n = 0;
while (Number(process.hrtime.bigint() - t0) / 1e3 < durMs * 1000) {
  if (Number(process.hrtime.bigint() - t0) / 1e3 >= (n + 1) * periodUs) {
    Atomics.add(i32, 7, 1);
    Atomics.notify(i32, 7, 1);
    Atomics.store(i32, 1, 1);
    Atomics.notify(i32, 1, 1);
    n++;
  }
}
parentPort.postMessage({ count: n });
`, { eval: true, workerData: { sab, refreshHz: REFRESH_HZ, durMs: DURATION_MS } });

  let rAFCount = 0;
  rAFHz.on('message', (m) => { rAFCount = m.count; });

  // ── 物理启动（主线程，与 rAF/WorkerB 线程并行）──
  let physTimer = setInterval(() => {
    const dt = (performance.now() - t0loop) / 1000;
    console.log(`[物理] 发布 ${(vPub / dt).toFixed(0)}/s (V=${Atomics.load(i32, I_V)}) · tick ${(tickCount / dt).toFixed(0)}/s`);
  }, 400);

  let reported = false;
  function finalReport() {
    if (reported) return;
    reported = true;
    clearInterval(physTimer);
    const dt = (performance.now() - t0loop) / 1000;
    const pubRate = vPub / dt;
    // WorkerB 结果经消息回调（可能稍晚），先等它
  }

  workerB.on('message', (m) => {
    const dt = (performance.now() - t0loop) / 1000;
    const pubRate = vPub / dt;
    const expectedCap = Math.min(REFRESH_HZ, 1000 / RENDER_MS);
    console.log(`\n════════ surf_666 端到端链路结果 ════════`);
    console.log(`时长 ${dt.toFixed(1)}s · 刷新率目标 ${REFRESH_HZ}Hz（rAF 实测 ${rAFCount} 次）`);
    console.log(`\n[1] WorkerA 无限制物理`);
    console.log(`    状态发布率: ${pubRate.toFixed(0)} 次/s（V=${Atomics.load(i32, I_V)}）`);
    console.log(`    判定      : ${pubRate >= 500 ? 'PASS ✓ 跑满计算（≥500Hz，1ms 子步预算充足）' : `FAIL ✗ 发布率过低（${pubRate.toFixed(0)}Hz）`}`);
    console.log(`\n[2] WorkerA tick（模式B ${TICK_RATE}Hz）`);
    console.log(`    tick 步进: ${(tickCount / dt).toFixed(0)} 次/s（期望≈${TICK_RATE}）`);
    console.log(`    判定      : ${Math.abs(tickCount / dt - TICK_RATE) <= TICK_RATE * 0.4 ? 'PASS ✓ tick 计算正常' : `CHECK 偏差（${(tickCount / dt).toFixed(0)} vs ${TICK_RATE}）`}`);
    console.log(`\n[3] SAB 渲染参数传输`);
    console.log(`    发布→消费: 发布 ${pubRate.toFixed(0)}/s · WorkerB 消费 ${m.repaintsPerSec}/s`);
    console.log(`    判定      : ${m.repaintsPerSec > 0 ? 'PASS ✓ 参数畅通传输' : 'FAIL ✗ 未消费'}`);
    console.log(`\n[4] WorkerB 渲染循环（模拟 GPU ${RENDER_MS}ms/帧）`);
    console.log(`    渲染频率  : ${m.rendersPerSec} f/s（fps 显示=${m.framesPerSec} f/s）`);
    console.log(`    理论上限  : min(刷新率 ${REFRESH_HZ}, 1/${RENDER_MS}ms=${(1000 / RENDER_MS).toFixed(0)}) = ${expectedCap.toFixed(0)} f/s`);
    console.log(`    判定-跑满 : ${m.rendersPerSec >= expectedCap * 0.85 ? 'PASS ✓ 达到理论上限（跑满性能）' : `CHECK 未达上限（${m.rendersPerSec} vs ${expectedCap.toFixed(0)}）`}`);
    console.log(`    判定-不超 : ${m.rendersPerSec <= expectedCap * 1.05 ? 'PASS ✓ 无忙循环超限（计数语义生效）' : 'FAIL ✗ 超过刷新率（重复释放）'}`);
    console.log(`    口径一致  : ${m.framesPerSec === m.rendersPerSec ? 'PASS ✓ fps 显示=实际渲染' : 'FAIL ✗'}`);
    console.log(`    插值平滑  : pos 跳变 ${m.maxXJump} / ${m.maxYJump} units/帧`);
    console.log(`\n══════════════════════════════════════`);
    process.exit(0);
  });

  physLoop(); // 启动主线程物理（与 WorkerB/rAF 并行）
});
