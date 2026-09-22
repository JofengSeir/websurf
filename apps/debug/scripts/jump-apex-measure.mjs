#!/usr/bin/env node
/**
 * 跳跃顶高实测脚本：headless Chromium + CDP，驱动**真实页面**（真 wasm 物理、真 Worker
 * 权威、真共享内存通道、真 `AuthorityCalibrator`、真 `sync-render-state` 消息链路）。
 *
 * 与 `apps/debug/scripts/jump-apex-verify.mjs` 的分工：后者是 node 侧架构镜像（自己重写
 * 接线、自己造权威帧），本脚本跑真页面——两者的读数来源与可控变量都不同。
 *
 * 流程：连浏览器 CDP → 导航到 URL → 给页面的 `#bspFile` 注入 BSP 文件触发加载 →
 *   轮询就绪判据（脚本内含）→ 轮询至连续四帧满足「`onGround` 为真且 `velY` 绝对值小于 1」
 *   （判据表达式见正文，60 秒上限）→ 装页内 rAF 采样器（每个采样点取渲染状态一次，并尝试取
 *   一次权威帧只读快照）→ 置 `window.__jumpMask = 16`（跳键位）→ 采样 seconds 秒 →
 *   掩码归零 → 再等 4 秒 → 读采样摘要与原始数组 → 写 JSON → 退出码 0。
 *
 * 读数口径（按代码，与就绪判据同源）：脚本从探针 `globalThis.__jumpProbe` 取两个入口——
 *   · `state()` 取自 `apps/debug/src/renderer/renderer-main.ts` 的 `RendererMain.getCurrentState`，
 *     返回 `{ pos, yaw, pitch, vel, onGround }`：位置三分量嵌在 `pos` 下、速度三分量嵌在
 *     `vel` 下，只有 `yaw` / `pitch` / `onGround` 在顶层；
 *   · `auth()` 取自 `src/ts-shared/auth/shared-state.ts` 的 `readAuthoritative` 返回的权威帧，
 *     并经服务端补丁**压成扁平四项**（`posY` / `velY` / `onGround` / `timeMs`）。
 *   **上述两个入口都由服务端补丁提供，仓库内没有 `__jumpProbe` 的定义**：预置入口的是
 *   `apps/debug/scripts/jump-apex-serve.mjs`（它在 OS 临时目录的 `app.ts` 副本里注入探针与
 *   按键掩码覆盖槽，仓库源文件不被改动）；探针不存在时，本脚本的 `#bspFile` 注入会失败。
 *   读数口径不一致（如实登记，只记录不改代码）：`getCurrentState` 的返回结构里没有顶层
 *   `posY` / `posX` / `posZ` / `velX` / `velY` / `velZ`，故就绪判据恒为假（轮询必然吃满
 *   180 秒并 `finish(1)`，采样阶段到不了）；即便进到采样阶段，采样表达式读到的这几个字段
 *   也恒为 `undefined`，`JSON.stringify` 会把它们整体丢弃，落盘样本只剩
 *   `i` / `t` / `dt` / `g` 四个键；同一前缀使 `auth()` 的 `frame.posY` / `frame.velY`
 *   也取不到值。同源问题另见 `apps/debug/scripts/jump-apex-smoke.mjs`。
 *
 * CLI：argv[2] 标签（缺省 `run`，决定输出文件名）；argv[3] 页面 URL（缺省
 *   `http://localhost:8080/web/index.html`）；argv[4] BSP 路径（缺省
 *   `test/maps/surf_666.bsp`）；argv[5] 采样时长秒数（缺省 45）。浏览器按 Chrome ×2 →
 *   Edge ×2 的顺序取第一个存在的可执行文件，找不到即退出码 2；BSP 不存在同样退出码 2。
 *
 * 前置：静态服务已在 8080 提供 `apps/debug`（`src/serve.py` 的用法是
 *   `python serve.py [port] [root_dir]`，在 `apps/debug` 下跑即 `python ../../src/serve.py 8080 .`，
 *   也是该工程 `npm run dev` 的内容）。
 *
 * 输出：`apps/debug/.tmp/jump-apex/<label>.json`（`.tmp` 为 gitignore 的中间产物目录），
 *   内容为逐帧样本数组，每项含 `i` / `t` / `dt` / `x,y,z` / `vx,vy,vz` / `g` 与权威侧
 *   `ay` / `avg` / `avy` / `avx` / `avz` / `ava`。消费方是
 *   `apps/debug/scripts/jump-apex-report.mjs`（按 label 读该目录）。
 *
 * 退出码：0 = 采样并落盘成功；1 = CDP 不可用、页面异常、探针超时或未捕获异常；
 *   2 = 找不到浏览器 / BSP 不存在。
 *
 * 用法：node scripts/jump-apex-measure.mjs <label> [url] [mapPath] [seconds]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const debugDir = join(__dirname, '..');
const repoRoot = join(debugDir, '..', '..');

const LABEL = process.argv[2] ?? 'run';
const URL_ = process.argv[3] || 'http://localhost:8080/web/index.html';
const MAP = process.argv[4] || join(repoRoot, 'test', 'maps', 'surf_666.bsp');
const SECONDS = Number(process.argv[5] || 45);
const OUT_DIR = join(debugDir, '.tmp', 'jump-apex');
const LOAD_TIMEOUT_MS = 180000; // 就绪轮询上限：超时即 finish(1)

const KEY_JUMP = 16; // 跳键位，取自 src/ts-shared/auth/shared-state.ts 的 KEY_MASK.jump

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

/** 轮询 CDP 的 `/json/list` 取第一个 page 目标；120 次 × 250ms 仍取不到即抛错（调用点转 finish(1)）。 */
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
// 自建 CDP 通道：请求按自增 id 配对，单条请求 60 秒上限；控制台输出与页面异常各收一份到 consoleLines。
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

// 收尾只执行一次：关 WS、杀浏览器进程、按 code 退出。未捕获异常与未处理的 Promise 拒绝都走这里（码 1）。
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

// 三个域必须开：Runtime 供 page 内求值、Page 供导航、DOM 供 #bspFile 节点查询与置文件。
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

// ── 就绪轮询：每 500ms 求值一次判据，每 10s 打印一行诊断；轮询期出错只重试不失败 ──
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
    // 判据三项：探针存在、`state()` 取到对象、`state().posY` 为真值。
    // 第三项与 `RendererMain.getCurrentState` 的嵌套返回结构不符（位置在 `state().pos.y`），
    // 故按当前源码该判据恒不成立，轮询必然走到 LOAD_TIMEOUT_MS 上限。
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

// ── 静置：连续 4 次读到「着地且竖直速度绝对值 < 1」即认为已稳定，60 秒上限 ──
const settleT0 = Date.now();
let settledFrames = 0;
let settleInfo = null;
while (Date.now() - settleT0 < 60000) {
  settleInfo = await evalJs(
    `(() => { const s = window.__jumpProbe.state(); return s ? { y: s.posY, vy: s.velY, g: s.onGround } : null; })()`,
  );
  // settleInfo 的三个键分别是 y / vy / g（见上面的表达式）；g 即 onGround、vy 来自 velY。
  if (settleInfo && settleInfo.g === true && Math.abs(settleInfo.vy) < 1) {
    settledFrames++;
    if (settledFrames >= 4) break;
  } else {
    settledFrames = 0;
  }
  await sleep(250);
}
console.log(`[${LABEL}] settled: ${JSON.stringify(settleInfo)}`);

// 装页内 rAF 采样器：常驻自递归，只有 __jumpSamplerOn 为真时才记录；每记录一点就顺带读一次
// 权威帧快照（`auth()` 抛错时该点的权威五项为 null）。`t` 用页面时钟 `performance.now()`，
// `dt` 是相邻记录点之差（首点为 0）。
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

// ── 按住跳键采样：每 2 秒查一次已记录点数，为 0 时打一行告警（rAF 停摆）但不中断 ──
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

// 采样摘要：帧数、总时长、着地帧数、平均帧率与最大帧间隔、y 极值、取到权威帧的样本数、yaw。
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

// 原始样本整串取一次（页面内序列化，避免逐点过 CDP 通道）；目录不存在则递归建。
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
