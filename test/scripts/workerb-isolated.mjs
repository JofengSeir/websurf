// WorkerB 隔离测试：无物理竞争，测纯渲染能力上限
// 用法：node scripts/workerb-isolated.mjs [refreshHz] [renderMs] [durMs]
import { Worker } from 'node:worker_threads';

const REFRESH_HZ = Number(process.argv[2] ?? 320);
const RENDER_MS = Number(process.argv[3] ?? 3);
const DURATION_MS = Number(process.argv[4] ?? 1200);
const sab = new SharedArrayBuffer(64);
const i32 = new Int32Array(sab);

// rAF 帧信号
const raf = new Worker(
  `
const { parentPort, workerData } = require('node:worker_threads');
const { sab, refreshHz, durMs } = workerData;
const i32 = new Int32Array(sab);
const periodUs = 1e6 / refreshHz;
const t0 = process.hrtime.bigint();
let n = 0;
while (Number(process.hrtime.bigint() - t0) / 1e3 < durMs * 1000) {
  if (Number(process.hrtime.bigint() - t0) / 1e3 >= (n + 1) * periodUs) {
    Atomics.add(i32, 7, 1); Atomics.notify(i32, 7, 1);
    n++;
  }
}
parentPort.postMessage({ count: n });
`,
  { eval: true, workerData: { sab, refreshHz: REFRESH_HZ, durMs: DURATION_MS } },
);

// WorkerB：纯渲染循环（无 readState 依赖，只有 waitRenderWakeup + busy 渲染）
const wb = new Worker(
  `
const { parentPort, workerData } = require('node:worker_threads');
const { sab, renderMs, durMs } = workerData;
const i32 = new Int32Array(sab);
let lastWake = 0, renders = 0;
const t0 = Date.now();
function loop() {
  if (Atomics.load(i32, 7) !== lastWake) {
    lastWake = Atomics.load(i32, 7);
  } else {
    const res = Atomics.wait(i32, 7, lastWake, 50);
    if (res === 'timed-out') { setImmediate(loop); return; }
    lastWake = Atomics.load(i32, 7);
  }
  const busyEnd = Date.now() + renderMs;
  while (Date.now() < busyEnd) {}
  renders++;
  // absorb：吸收渲染期间新信号
  lastWake = Atomics.load(i32, 7);
  setImmediate(loop);
}
loop();
setInterval(() => {
  parentPort.postMessage({ rendersPerSec: Math.round(renders / ((Date.now() - t0) / 1000)) });
}, durMs);
`,
  { eval: true, workerData: { sab, renderMs: RENDER_MS, durMs: DURATION_MS } },
);

let rafCount = 0;
raf.on('message', (m) => (rafCount = m.count));
wb.on('message', (m) => {
  const cap = Math.min(REFRESH_HZ, 1000 / RENDER_MS);
  console.log('\n═══ WorkerB 隔离测试（无物理竞争）═══');
  console.log(`刷新率 ${REFRESH_HZ}Hz · 渲染 ${RENDER_MS}ms/帧 · rAF 实测 ${rafCount} 次`);
  console.log(`WorkerB 渲染频率: ${m.rendersPerSec} f/s（理论上限 ${cap.toFixed(0)} f/s）`);
  console.log(`判定: ${m.rendersPerSec >= cap * 0.85 ? 'PASS ✓ 纯渲染能力跑满' : 'CHECK ' + m.rendersPerSec + ' vs ' + cap.toFixed(0)}`);
  process.exit(0);
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, DURATION_MS + 3000);
