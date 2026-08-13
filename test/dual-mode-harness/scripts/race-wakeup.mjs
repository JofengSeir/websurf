#!/usr/bin/env node
/**
 * WebSurf-test — 唤醒槽并发协议测试（node worker_threads 真线程模拟；评审 B2/B3 节质疑）。
 *
 * 用法：node scripts/race-wakeup.mjs
 *
 * 测试 0（对照·旧单槽协议）：WorkerA 与 WorkerB 都挂起在 WAKEUP 同一槽，主线程
 *   store+notify(1) —— notify 每次只唤醒一个等待者 → 渲染帧被物理"抢唤醒"，
 *   渲染 Worker 只能拿到约一半的帧信号（量化 B2 声称的耦合危害）。
 * 测试 1（新双槽协议）：WAKEUP（WorkerA 物理背压）与 RENDER_WAKEUP（WorkerB 渲染帧）
 *   分离，主线程双槽 store+notify —— 渲染 Worker 每帧都被唤醒（≈100%）——
 *   量化"RENDER_WAKEUP 独立槽"修复效果；且 WorkerA 高频 CAS 复位抢 WAKEUP 不影响
 *   WorkerB 的 RENDER_WAKEUP 唤醒节奏。
 * 测试 2（B3）：WorkerB 阻塞在 waitRenderWakeup(20ms) 期间 postMessage 的投递延迟
 *   （理论 ≤ 20ms = wait 剩余）；对照：无阻塞时 < 5ms。
 *
 * 注：node 主线程不允许 Atomics.wait（与浏览器主线程一致），wait 只发生在 worker 线程。
 * 布局常量与 shared-state.ts 一致：I_WAKEUP=1 / I_RENDER_WAKEUP=7。
 */

import { Worker } from 'node:worker_threads';

const I_WAKEUP = 1;
const I_RENDER_WAKEUP = 7;

// ── worker 源码（eval 模式；真实线程 + 真实 Atomics.wait）─────────────
const workerSrc = `
const { parentPort, workerData } = require('node:worker_threads');
const i32 = new Int32Array(workerData.sab);
function waitSlot(idx, timeoutMs) {
  const res = Atomics.wait(i32, idx, 0, timeoutMs);
  if (res === 'timed-out') return false;
  Atomics.compareExchange(i32, idx, 1, 0); // CAS 消费唤醒并复位（与 shared-state.ts 一致）
  return true;
}
parentPort.on('message', (m) => {
  if (m.type === 'loop') {
    let wakes = 0;
    const t0 = Date.now();
    for (let i = 0; i < m.n; i++) {
      if (waitSlot(m.slot, m.timeout)) wakes++;
    }
    parentPort.postMessage({ type: 'done', wakes, ms: Date.now() - t0 });
  } else if (m.type === 'block') {
    waitSlot(m.slot, m.ms);
    parentPort.postMessage({ type: 'blocked', ms: Date.now() - m.t0 });
  } else if (m.type === 'ping') {
    parentPort.postMessage({ type: 'pong', dt: Date.now() - m.t });
  }
});
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkWorker = (sab) => new Worker(workerSrc, { eval: true, workerData: { sab } });

// ── 断言工具 ────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── 测试 0/1：单槽 vs 双槽 —— 渲染 Worker 的帧信号份额 ────────────────
console.log('── 测试0/1：WAKEUP 单槽耦合 vs RENDER_WAKEUP 双槽分离（B2 量化）──');
const N = 100;
const MAIN_INTERVAL = 5;
const PHYS_TIMEOUT = 50; // 物理 Worker：长挂起（模拟背压等待态）
const RENDER_TIMEOUT = 50; // 渲染 Worker：长挂起（模拟帧等待态）

async function runSlotTest(renderSlot, mainNotifyFn, label) {
  const sab = new SharedArrayBuffer(192);
  const i32 = new Int32Array(sab);
  const physW = mkWorker(sab);
  const rendW = mkWorker(sab);
  const donePhys = new Promise((r) => physW.on('message', r));
  const doneRend = new Promise((r) => rendW.on('message', r));
  // WorkerA：物理背压——挂起 WAKEUP 槽（旧协议下与渲染争抢同一槽）
  physW.postMessage({ type: 'loop', n: N, slot: I_WAKEUP, timeout: PHYS_TIMEOUT });
  rendW.postMessage({ type: 'loop', n: N, slot: renderSlot, timeout: RENDER_TIMEOUT });
  for (let i = 0; i < N; i++) {
    mainNotifyFn(i32); // 每帧唤醒
    await sleep(MAIN_INTERVAL);
  }
  const rp = await donePhys;
  const rr = await doneRend;
  physW.terminate();
  rendW.terminate();
  const physShare = (rp.wakes / N * 100).toFixed(0);
  const rendShare = (rr.wakes / N * 100).toFixed(0);
  console.log(`  [${label}] 物理 wakes=${rp.wakes}/${N}（${physShare}%），渲染 wakes=${rr.wakes}/${N}（${rendShare}%）`);
  return { phys: rp.wakes, rend: rr.wakes };
}

{
  // 旧单槽协议：双 Worker 争抢 WAKEUP，notify(1) 每帧只服务一个等待者
  const oldProto = await runSlotTest(
    I_WAKEUP,
    (i32) => {
      Atomics.store(i32, I_WAKEUP, 1);
      Atomics.notify(i32, I_WAKEUP, 1);
    },
    '对照·旧单槽（WAKEUP 共用，notify 1）',
  );
  check(
    '旧单槽：渲染 Worker 帧信号被物理抢占（份额 < 90%——耦合危害可观测）',
    oldProto.rend < 0.9 * N,
    `渲染份额=${(oldProto.rend / N * 100).toFixed(0)}%`,
  );
}
{
  // 新双槽协议：物理挂 WAKEUP，渲染挂 RENDER_WAKEUP，主线程双槽各 notify(1)
  const newProto = await runSlotTest(
    I_RENDER_WAKEUP,
    (i32) => {
      Atomics.store(i32, I_WAKEUP, 1);
      Atomics.notify(i32, I_WAKEUP, 1);
      Atomics.store(i32, I_RENDER_WAKEUP, 1);
      Atomics.notify(i32, I_RENDER_WAKEUP, 1);
    },
    '新双槽（WAKEUP + RENDER_WAKEUP 分离）',
  );
  check(
    '新双槽：渲染 Worker 每帧都被唤醒（份额 ≥ 90%——RENDER_WAKEUP 独立槽有效）',
    newProto.rend >= 0.9 * N,
    `渲染份额=${(newProto.rend / N * 100).toFixed(0)}%`,
  );
  check(
    '新双槽：物理 Worker 同样每帧被唤醒（两槽互不干扰）',
    newProto.phys >= 0.9 * N,
    `物理份额=${(newProto.phys / N * 100).toFixed(0)}%`,
  );
}
{
  // 新双槽 + WorkerA 高频 CAS 复位抢 WAKEUP（模拟物理 1ms 背压 churn）：渲染应完全不受影响
  const sab = new SharedArrayBuffer(192);
  const i32 = new Int32Array(sab);
  const physW = mkWorker(sab);
  const rendW = mkWorker(sab);
  const donePhys = new Promise((r) => physW.on('message', r));
  const doneRend = new Promise((r) => rendW.on('message', r));
  physW.postMessage({ type: 'loop', n: N * 4, slot: I_WAKEUP, timeout: 1 }); // 1ms 超时高频 churn
  rendW.postMessage({ type: 'loop', n: N, slot: I_RENDER_WAKEUP, timeout: 50 });
  for (let i = 0; i < N; i++) {
    Atomics.store(i32, I_WAKEUP, 1);
    Atomics.notify(i32, I_WAKEUP, 2); // 物理槽 notify 2（churn 环境下可能双等待者）
    Atomics.store(i32, I_RENDER_WAKEUP, 1);
    Atomics.notify(i32, I_RENDER_WAKEUP, 1);
    await sleep(MAIN_INTERVAL);
  }
  const rr = await doneRend;
  const rp = await donePhys;
  physW.terminate();
  rendW.terminate();
  const rendShare = (rr.wakes / N * 100).toFixed(0);
  const physShare = (rp.wakes / (N * 4) * 100).toFixed(0);
  console.log(`  [新双槽+物理 churn] 物理 wakes=${rp.wakes}/${N * 4}（${physShare}%），渲染 wakes=${rr.wakes}/${N}（${rendShare}%）`);
  check(
    '新双槽 + 物理高频 churn：渲染帧信号份额仍 ≥ 90%（CAS 复位不抢 RENDER_WAKEUP）',
    rr.wakes >= 0.9 * N,
    `渲染份额=${rendShare}%`,
  );
}

// ── 测试 2：waitRenderWakeup 阻塞期间的消息投递延迟（B3）─────────────
console.log('\n── 测试2：waitRenderWakeup(20ms) 阻塞期间 postMessage 投递延迟 ──');

async function measurePingDelay(blockMs, label) {
  const sab = new SharedArrayBuffer(192);
  const w = mkWorker(sab);
  const queue = [];
  w.on('message', (m) => queue.push(m));
  if (blockMs > 0) {
    w.postMessage({ type: 'block', slot: I_RENDER_WAKEUP, ms: blockMs, t0: Date.now() });
    await sleep(Math.max(1, blockMs * 0.25)); // 让 worker 先进入阻塞态
  }
  const t = Date.now();
  w.postMessage({ type: 'ping', t });
  const deadline = Date.now() + 2000;
  while (!queue.some((m) => m.type === 'pong') && Date.now() < deadline) {
    await sleep(2);
  }
  const pong = queue.find((m) => m.type === 'pong');
  w.terminate();
  return pong ? pong.dt : null;
}

{
  const dtBlock = await measurePingDelay(20, '阻塞 20ms');
  const dtFree = await measurePingDelay(0, '无阻塞');
  console.log(`  阻塞 waitRenderWakeup(20ms) 中 postMessage → 处理延迟 ${dtBlock}ms（理论 ≤ 20ms = wait 剩余）`);
  console.log(`  无阻塞 postMessage → 处理延迟 ${dtFree}ms`);
  check('阻塞 wait：消息延迟 ≤ 20ms（B3 断言成立，未超时兜底）', dtBlock !== null && dtBlock <= 20, `dt=${dtBlock}ms`);
  check('阻塞 wait：消息延迟显著大于无阻塞（量化语义回退）', dtBlock !== null && dtFree !== null && dtBlock > dtFree + 5, `阻塞 ${dtBlock}ms vs 无阻塞 ${dtFree}ms`);
  check('无阻塞对照：消息延迟 < 5ms（基线）', dtFree !== null && dtFree < 5, `dt=${dtFree}ms`);
}

// ── 汇总 ────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + fail} PASS${fail > 0 ? ` — ${fail} FAIL` : ''}`);
if (fail > 0) process.exitCode = 1;
