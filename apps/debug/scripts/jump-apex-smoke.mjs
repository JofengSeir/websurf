#!/usr/bin/env node
/**
 * 快速冒烟测试：确认「掩码覆盖」真的让玩家在 headless 下连跳（不需要 45s）。
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
  } catch { /* retry */ }
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
