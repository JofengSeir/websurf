#!/usr/bin/env node
/**
 * 跳跃冒烟采样（headless Chromium + CDP）：按住跳键一段时间，打印渲染物理线的读数。
 *
 * 与 `apps/debug/scripts/jump-apex-measure.mjs` 的分工：本脚本不落盘、不做断言、不做就绪判定，
 * 只把 3s 窗口的采样打到 stdout（后者默认采样 45s，并把逐帧样本写成 JSON 文件）。
 *
 * 前置（缺一即跑不通）：
 *   · 页面由 `apps/debug/scripts/jump-apex-serve.mjs` 提供 —— 它在 OS 临时目录里的 app.ts 副本中
 *     注入只读探针 `globalThis.__jumpProbe` 与按键掩码覆盖槽 `globalThis.__jumpMask`，
 *     仓库内的源文件不被改动；
 *   · 该服务默认监听 8080，故默认 URL 为 http://localhost:8080/web/index.html（argv[2] 可覆盖）。
 *
 * 流程：起 headless 浏览器（CDP 调试端口 9600 起随机 80 个）→ 给 `#bspFile` 注入
 * <仓库根>/test/maps/surf_666.bsp → 轮询探针至多 120s（未就绪也继续，只是打印 probe ready: false）→
 * 打印初始状态 → 置 `__jumpMask = 16`（`src/ts-shared/auth/shared-state.ts` 的 `KEY_MASK.jump`）→
 * 页内 rAF 采样 3s，打印该窗口内最大 vy 与 y 的极值、样本数 → 掩码复位 → 关 WS、杀浏览器。
 *
 * 退出码：结尾无条件 `process.exit(0)`，结论不以退出码表达。
 *
 * 读数口径提醒（按当前代码）：本脚本从 `window.__jumpProbe.state()` 上取 `posY` / `velY`，
 * 而该槽取的是 `apps/debug/src/renderer/renderer-main.ts` 的 `RendererMain.getCurrentState`，
 * 其返回值是 `{ pos, yaw, pitch, vel, onGround }` —— 这两个字段嵌在 `pos` / `vel` 之下。
 *
 * 用法：node scripts/jump-apex-smoke.mjs [url]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEBUG = join(HERE, '..');
const REPO = join(DEBUG, '..', '..');
const URL_ = process.argv[2] ?? 'http://localhost:8080/web/index.html';
const MAP = join(REPO, 'test', 'maps', 'surf_666.bsp');
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const BROWSER = CANDIDATES.find((p) => p && existsSync(p));
const PORT = 9600 + Math.floor(Math.random() * 80);
const browser = spawn(BROWSER, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + (process.env.TEMP ?? '.') + '/ws-jump-smoke-' + PORT,
  '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page = null;
for (let i = 0; i < 120 && !page; i++) {
  try {
    const r = await fetch(`http://localhost:${PORT}/json/list`);
    if (r.ok) page = (await r.json()).find((t) => t.type === 'page');
  } catch { /* retry */ } // 本轮 CDP 查询失败：忽略，交给循环下一轮 }
  if (!page) await sleep(250);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = {};
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id]; } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending[i] = res; ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;

await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
await send('Page.navigate', { url: URL_ });
await sleep(3000);
const doc = await send('DOM.getDocument', { depth: -1 });
const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#bspFile' });
await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [MAP] });
const t0 = Date.now();
let ready = false;
while (Date.now() - t0 < 120000) {
  const ok = await evalJs('!!(window.__jumpProbe && window.__jumpProbe.__jumpProbePatch && window.__jumpProbe.state())').catch(() => false);
  if (ok) { ready = true; break; }
  await sleep(500);
}
console.log('probe ready:', ready);
const before = await evalJs('JSON.stringify(window.__jumpProbe.state())');
console.log('state before:', before);
await evalJs('(window.__jumpMask = 16)');
await sleep(1500);
const maxVy = await evalJs(`(() => {
  let best = -1e9, ys = [];
  const t0 = performance.now();
  return new Promise((res) => {
    const tick = () => {
      const s = window.__jumpProbe.state();
      if (s) { if (s.velY > best) best = s.velY; ys.push(+s.posY.toFixed(2)); }
      if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
      else res(JSON.stringify({ maxVy: best, minY: Math.min.apply(null, ys), maxY: Math.max.apply(null, ys), n: ys.length }));
    };
    requestAnimationFrame(tick);
  });
})()`);
await evalJs('(window.__jumpMask = 0)');
console.log('3s hold-jump sample:', maxVy);
ws.close(); browser.kill(); process.exit(0);
