#!/usr/bin/env node
/**
 * 跳跃顶高【实测】harness（headless Chromium + CDP，真实渲染物理线 + 真实 Worker 权威）。
 *
 * 与 `jump-apex-verify.mjs` 的区别：后者是 node 侧架构镜像（自己重写接线），本脚本
 * 跑**真页面**：真 wasm 物理、真 Worker 权威、真 SAB、真 AuthorityCalibrator、真
 * `sync-render-state` 消息链路——A/B 只需改 `src/ts-shared/auth/worker-dispatch.ts`。
 *
 * 流程：静态服务(8080) → headless Edge/Chrome → CDP 注入 surf_666.bsp →
 *   等 `window.__jumpProbe.state()` 出现 → 静置至落地 → `__jumpMask = 16`（jump 位，
 *   shared-state.ts KEY_MASK.jump）按住 → 页内 rAF 采样（渲染物理线 state + 权威帧
 *   只读 SAB）→ 松开 → 落地 → 导出 JSON。
 *
 * 前置：静态服务已跑（`cd debug && python ../src/serve.py 8080 .`）。
 * 用法：node scripts/jump-apex-measure.mjs <label> [url] [mapPath] [seconds]
 * 输出：debug/.tmp/jump-apex/<label>.json
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const debugDir = join(__dirname, '..');
const repoRoot = join(debugDir, '..');

const LABEL = process.argv[2] ?? 'run';
const URL_ = process.argv[3] || 'http://localhost:8080/web/index.html';
const MAP = process.argv[4] || join(repoRoot, 'test', 'maps', 'surf_666.bsp');
const SECONDS = Number(process.argv[5] || 45);
const OUT_DIR = join(debugDir, '.tmp', 'jump-apex');
const LOAD_TIMEOUT_MS = 180000;

const KEY_JUMP = 16; // src/ts-shared/auth/shared-state.ts KEY_MASK.jump

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const BROWSER = CANDIDATES.find((p) => p && existsSync(p));
if (!BROWSER) {
  console.error('未找到 Chrome/Edge');
  process.exit(2);
}
if (!existsSync(MAP)) {
  console.error(`地图不存在：${MAP}`);
  process.exit(2);
}

const PORT = 9400 + Math.floor(Math.random() * 90);
const browser = spawn(
  BROWSER,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + (process.env.TEMP ?? '.') + '/ws-jump-' + PORT,
    '--window-size=1280,720',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCdp() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/json/list`);
      if (r.ok) {
        const page = (await r.json()).find((t) => t.type === 'page');
        if (page) return page;
      }
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error('CDP 不可用');
}

const page = await waitForCdp();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});

let id = 0;
const pending = {};
const consoleLines = [];
ws.onclose = () => {
  console.error('[harness] CDP WebSocket closed');
  for (const k of Object.keys(pending)) {
    pending[k]?.({ __wsClosed: true });
    delete pending[k];
  }
};
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending[m.id]) {
    pending[m.id](m.result);
    delete pending[m.id];
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    consoleLines.push(
      (m.params.args ?? [])
        .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
        .join(' '),
    );
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleLines.push('EXCEPTION: ' + (m.params.exceptionDetails?.text ?? ''));
  }
};
const send = (method, params = {}) =>
  Promise.race([
    new Promise((res) => {
      const myId = ++id;
      pending[myId] = res;
      try {
        ws.send(JSON.stringify({ id: myId, method, params }));
      } catch (e) {
        delete pending[myId];
        res({ __wsClosed: true, err: String(e) });
      }
    }),
    new Promise((res) => setTimeout(() => res({ __timeout: true }), 60000)),
  ]);
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.__wsClosed) throw new Error('CDP WebSocket closed');
  if (r?.__timeout) throw new Error('CDP evaluate timeout: ' + expression.slice(0, 80));
  if (r?.exceptionDetails) {
    throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
  }
  return r?.result?.value;
};

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  try { ws.close(); } catch { /* noop */ }
  try { browser.kill(); } catch { /* noop */ }
  process.exit(code);
}
process.on('unhandledRejection', (e) => {
  console.error('[harness] unhandledRejection:', e instanceof Error ? e.stack : e);
  finish(1);
});
process.on('uncaughtException', (e) => {
  console.error('[harness] uncaughtException:', e instanceof Error ? e.stack : e);
  finish(1);
});

await send('Runtime.enable');
await send('Page.enable');
await send('DOM.enable');

console.log(`[${LABEL}] ${BROWSER.split('/').pop()} -> ${URL_}`);
console.log(`[${LABEL}] map ${MAP}`);
await send('Page.navigate', { url: URL_ });
await sleep(3000);

const doc = await send('DOM.getDocument', { depth: -1 });
const nodeRes = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#bspFile' });
if (!nodeRes?.nodeId) {
  console.error('page has no #bspFile');
  finish(1);
}
await send('DOM.setFileInputFiles', { nodeId: nodeRes.nodeId, files: [MAP] });
console.log(`[${LABEL}] bsp injected, loading...`);

const t0 = Date.now();
let ready = false;
let lastDiag = 0;
while (Date.now() - t0 < LOAD_TIMEOUT_MS) {
  let ok = false;
  try {
    const diag = await evalJs(`(() => {
      const p = window.__jumpProbe;
      let st = null, err = '';
      try { st = p ? p.state() : null; } catch (e) { err = String(e); }
      return {
        hasProbe: typeof p === 'object' && p !== null,
        hasState: !!st,
        posY: st ? st.posY : null,
        err,
        status: (document.getElementById('status') || {}).textContent || '',
        metadata: ((document.getElementById('metadata') || {}).textContent || '').slice(0, 120),
      };
    })()`);
    ok = !!(diag && diag.hasProbe && diag.hasState && diag.posY);
    if (!ok && Date.now() - lastDiag > 10000) {
      lastDiag = Date.now();
      console.log(`[${LABEL}] waiting... probe=${diag?.hasProbe} state=${diag?.hasState} err=${diag?.err} status="${(diag?.status ?? '').slice(0, 160)}" meta="${diag?.metadata ?? ''}"`);
    }
    if (ok) ready = true;
  } catch (e) {
    console.error(`[${LABEL}] readiness poll error (retry): ${e.message}`);
    await sleep(1000);
    continue;
  }
  if (ready) break;
  await sleep(500);
}
if (!ready) {
  console.error(`[${LABEL}] render physics not ready (${LOAD_TIMEOUT_MS}ms timeout)`);
  console.error(consoleLines.slice(-25).join('\n'));
  finish(1);
}
console.log(`[${LABEL}] physics ready (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const settleT0 = Date.now();
let settledFrames = 0;
let settleInfo = null;
while (Date.now() - settleT0 < 60000) {
  settleInfo = await evalJs(
    `(() => { const s = window.__jumpProbe.state(); return s ? { y: s.posY, vy: s.velY, g: s.onGround } : null; })()`,
  );
  if (settleInfo && settleInfo.g === true && Math.abs(settleInfo.vy) < 1) {
    settledFrames++;
    if (settledFrames >= 4) break;
  } else {
    settledFrames = 0;
  }
  await sleep(250);
}
console.log(`[${LABEL}] settled: ${JSON.stringify(settleInfo)}`);

await evalJs(`(() => {
  window.__jumpSamples = [];
  window.__jumpSamplerOn = false;
  let last = 0, seq = 0;
  const tick = () => {
    requestAnimationFrame(tick);
    if (!window.__jumpSamplerOn) return;
    const p = window.__jumpProbe;
    const s = p.state();
    if (!s) return;
    const now = performance.now();
    let au = null;
    try { au = p.auth(); } catch (e) { au = null; }
    window.__jumpSamples.push({
      i: seq++,
      t: now,
      dt: last === 0 ? 0 : now - last,
      x: s.posX, y: s.posY, z: s.posZ,
      vy: s.velY, vx: s.velX, vz: s.velZ,
      g: s.onGround ? 1 : 0,
      ay: au ? au.frame.posY : null,
      avg: au ? (au.frame.onGround ? 1 : 0) : null,
      avy: au ? au.frame.velY : null,
      avx: au ? au.frame.velX : null,
      avz: au ? au.frame.velZ : null,
      ava: au ? au.va : null,
    });
    last = now;
  };
  requestAnimationFrame(tick);
  return true;
})()`);

console.log(`[${LABEL}] holding jump (mask=${KEY_JUMP}) for ${SECONDS}s ...`);
try {
  await evalJs('(window.__jumpMask = ' + KEY_JUMP + ')');
} catch (e) {
  console.error('[harness] set jump mask failed:', e.message);
  finish(1);
}
await evalJs('(window.__jumpSamplerOn = true)');
const recT0 = Date.now();
while (Date.now() - recT0 < SECONDS * 1000) {
  await sleep(2000);
  const n = await evalJs('window.__jumpSamples.length');
  if (typeof n === 'number' && n === 0) console.error(`[${LABEL}] zero samples (rAF stalled?)`);
}
await evalJs('(window.__jumpSamplerOn = false)');
await evalJs('(window.__jumpMask = 0)');
console.log(`[${LABEL}] released jump, waiting for landing ...`);
await sleep(4000);

const summary = await evalJs(`(() => {
  const a = window.__jumpSamples || [];
  const n = a.length;
  if (n === 0) return JSON.stringify({ n: 0 });
  let gFrames = 0, maxDt = 0, sumDt = 0;
  for (const s of a) { if (s.g) gFrames++; if (s.dt > maxDt) maxDt = s.dt; sumDt += s.dt; }
  const st = window.__jumpProbe.state();
  const ys = a.map(function (s) { return s.y; });
  return JSON.stringify({
    n: n, seconds: +(sumDt / 1000).toFixed(2), gFrames: gFrames,
    meanHz: +(1000 / (sumDt / n)).toFixed(1), maxDt: +maxDt.toFixed(1),
    yMin: Math.min.apply(null, ys), yMax: Math.max.apply(null, ys),
    authFrames: a.filter(function (s) { return s.ava !== null; }).length,
    yaw: st ? st.yaw : null,
  });
})()`);

const raw = await evalJs('JSON.stringify(window.__jumpSamples)');
mkdirSync(OUT_DIR, { recursive: true });
const outFile = join(OUT_DIR, `${LABEL}.json`);
writeFileSync(outFile, raw, 'utf8');
console.log(`[${LABEL}] sample summary ${summary}`);
console.log(`[${LABEL}] raw samples -> ${outFile}`);
if (consoleLines.length) {
  console.log(`[${LABEL}] last 6 console lines:`);
  for (const l of consoleLines.slice(-6)) console.log('   ' + l.slice(0, 200));
}
finish(0);
