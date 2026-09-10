#!/usr/bin/env node
/**
 * 三模式运行时验证（node，无浏览器）——直接驱动**构建产物** worker-a.js。
 *
 * 为什么存在：harness 的三模式物理计算迁自 game（game 侧已判定失败并回退为
 * 耦合单模）。迁移后必须证明「本工程真能跑三模式 + 热切」，而不是只通过类型门。
 * 本脚本在 node 里给 worker bundle 补最小 Web Worker 宿主（self / addEventListener
 * / postMessage），按真实消息序列驱动：
 *
 *   init-shared（渲染通道 192B）→ auth-init（auth 通道 512B）→ wasm-init（内嵌
 *   base64，绕开 fetch）→ world-json（空世界，物理可跑）→ 依次 set-mode 三值
 *
 * 断言：
 *   1. wasm 初始化成功（无 error 消息）；
 *   2. 每模式 set-mode 均回 mode-ack 且 mode 与请求一致（热切握手闭合）；
 *   3. 同 mode 重复 set-mode 幂等（回 ack 但不重复执行交接）；
 *   4. 未知 mode 被拒（不回 ack）；
 *   5. 每个模式运行期间 TestShared 渲染通道的版本号 V 前进（帧真的发布了）；
 *   6. 三模式可连续往返切换（coupled→decoupled→tick→coupled→tick→decoupled）。
 *
 * 用法：node scripts/three-mode-verify.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const TEST_BUFFER_SIZE = 192; // harness TestShared（渲染通道）
const AUTH_BUFFER_SIZE = 512; // src/ts-shared ShmState（auth 通道）

// ── 最小 Web Worker 宿主 ─────────────────────────────────────────
const messageListeners = [];
const posted = []; // worker → main 的消息（mode-ack / error / …）
globalThis.self = globalThis;
globalThis.addEventListener = (type, fn) => {
  if (type === 'message') messageListeners.push(fn);
};
globalThis.postMessage = (msg) => {
  posted.push(msg);
};

function send(msg) {
  for (const fn of messageListeners) fn({ data: msg });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 断言 ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`[PASS] ${label}`);
  } else {
    failed++;
    console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── 启动 ────────────────────────────────────────────────────────
const testSab = new SharedArrayBuffer(TEST_BUFFER_SIZE);
const authSab = new SharedArrayBuffer(AUTH_BUFFER_SIZE);
const wasmB64 = readFileSync(join(root, 'pkg', 'websurf_test_wasm_bg.wasm')).toString('base64');

console.log('── 三模式运行时验证（驱动构建产物 worker-a.js）──');
const t0 = Date.now();
await import(pathToFileURL(join(root, 'worker-a.js')).href);
console.log(`worker-a.js 已加载（${Date.now() - t0} ms）`);
check('worker bundle 注册了 message 监听', messageListeners.length > 0, `listeners=${messageListeners.length}`);

// 真实消息序列（与 main.ts 一致）
send({ type: 'init-shared', shared: testSab });
send({ type: 'auth-init', shared: authSab });
send({ type: 'wasm-init', wasmB64 });

// 等 wasm 初始化（initSync + authLoop.start）
await sleep(400);
const errs = posted.filter((m) => m && m.type === 'error');
check('wasm 初始化无 error', errs.length === 0, errs.map((e) => e.message).join('; '));

// 空世界：无 brush/tri，玩家自由落体——足够驱动三模式物理与发布
send({
  type: 'world-json',
  brushJson: '[]',
  triJson: '[]',
  teleportJson: '{"teleports":[],"triggers":[]}',
  spawn: { x: 0, y: 200, z: 0, yawDeg: 0 },
});
await sleep(150);

const worldErrs = posted.filter((m) => m && m.type === 'error');
check('world-json 构建无 error', worldErrs.length === 0, worldErrs.map((e) => e.message).join('; '));

// TestShared 渲染通道的版本号（帧发布计数）——布局见 src/shared-state.ts: I_V = 8
const testI32 = new Int32Array(testSab);
const I_V = 8;

// ── 热切：三模式 + 幂等 + 往返 ───────────────────────────────────
/** 请求 set-mode 并等待 mode-ack（带超时）。 */
async function setModeAndWait(mode, timeoutMs = 1500) {
  const before = posted.filter((m) => m && m.type === 'mode-ack').length;
  send({ type: 'set-mode', mode });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const acks = posted.filter((m) => m && m.type === 'mode-ack');
    if (acks.length > before) return acks[acks.length - 1];
    await sleep(20);
  }
  return null;
}

const observed = {};
for (const mode of ['decoupled', 'tick', 'coupled']) {
  const vBefore = Atomics.load(testI32, I_V);
  const ack = await setModeAndWait(mode);
  check(`set-mode ${mode} → mode-ack`, ack !== null && ack.mode === mode, ack ? `ack.mode=${ack.mode}` : '超时无 ack');
  observed[mode] = ack;
  // 让该模式跑一会儿，观察渲染通道是否真有帧发布（V 前进）
  await sleep(250);
  const vAfter = Atomics.load(testI32, I_V);
  check(`${mode} 模式运行期有帧发布（TestShared V 前进）`, vAfter > vBefore, `V ${vBefore} → ${vAfter}`);
}

// 幂等：同 mode 重复请求仍回 ack
const idem = await setModeAndWait('coupled');
check('同 mode 重复 set-mode 幂等回 ack', idem !== null && idem.mode === 'coupled');

// 非法 mode：不回 ack
const beforeBad = posted.filter((m) => m && m.type === 'mode-ack').length;
send({ type: 'set-mode', mode: 'bogus' });
await sleep(200);
const afterBad = posted.filter((m) => m && m.type === 'mode-ack').length;
check('非法 mode 被拒（不回 ack）', afterBad === beforeBad, `acks ${beforeBad} → ${afterBad}`);

// 连续往返切换（真实热切压力）
const seq = ['decoupled', 'tick', 'coupled', 'tick', 'decoupled', 'coupled'];
let ok = true;
for (const mode of seq) {
  const ack = await setModeAndWait(mode);
  if (!ack || ack.mode !== mode) {
    ok = false;
    break;
  }
}
check(`连续往返热切 ${seq.join('→')} 全部闭合`, ok);

// ── tick 遥测链路（worker → 面板）─────────────────────────────────
// tick-authority 每 1000ms 自发 {type:'tick-stats'}；main 用共享层
// tick-telemetry-format.formatWorkerStatsLine 渲染成面板账行。
await setModeAndWait('tick');
await sleep(1300);
const tickStats = posted.filter((m) => m && m.type === 'tick-stats');
check('tick 模式自发 tick-stats（面板遥测链路）', tickStats.length > 0, `收到 ${tickStats.length} 条`);
if (tickStats.length > 0) {
  const s = tickStats[tickStats.length - 1].stats ?? {};
  check('tick-stats 载荷含门分账字段', typeof s.optimisticPublished === 'number', JSON.stringify(s).slice(0, 140));
}

// 无未捕获异常（process 会因 unhandled rejection 崩；此处仅汇总）
console.log(`\n三模式运行时验证：${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
