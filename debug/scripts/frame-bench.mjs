#!/usr/bin/env node
/**
 * debug 渲染帧耗时实测（headless Chromium + CDP，**真实 GPU**）。
 *
 * 目的：把「流畅度」从主观感受变成可复现的测量。headless Edge/Chrome 在本机走
 * ANGLE/D3D11 + 真实 GPU（非 SwiftShader 软渲染），故帧耗时具备参考性。
 *
 * 流程：启动 headless 浏览器 → 打开 debug 页面 → CDP `DOM.setFileInputFiles` 注入
 * .bsp（绕过人工选文件）→ 等地图就绪 → 页面内 rAF 采样帧间隔 → 输出统计。
 *
 * 前置：debug 静态服务已在跑（`cd debug && npm run dev` → 8080）；
 *       地图文件存在（默认 maps/surf_666.bsp）。
 *
 * 用法：npm run bench:frames
 *       npm run bench:frames -- <label> <url> <mapPath>
 *
 * 实测基线（surf_666.bsp，1280×720，本机 RTX 4060）：
 *   合并开启（当前实现）：mean 3.13ms（~319 FPS），p95 4.5ms，400 帧 0 次 >33ms
 *   合并关闭（OPTIMIZE_SCENE_ENABLED=false 复现旧路径）：mean 16.09ms（~62 FPS）
 *   → 约 5.1× 差距；旧路径 16.1ms 已贴住 16.7ms vsync 预算，任何抖动即掉帧。
 *
 * 提示：headless 下 rAF 不做 vsync 节流，因此读数反映**每帧处理耗时（吞吐）**，
 * 而非锁帧后的显示帧率——正是我们要比较的量。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const debugDir = join(__dirname, '..');
const repoRoot = join(debugDir, '..');

const LABEL = process.argv[2] ?? 'run';
const URL = process.argv[3] ?? 'http://localhost:8080/web/index.html';
const MAP = process.argv[4] ?? join(repoRoot, 'maps', 'surf_666.bsp');
const SAMPLES = 400;
const LOAD_TIMEOUT_MS = 90000;

// headless 浏览器：优先 Chrome，回退 Edge（均为 Chromium，CDP 同协议）
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const BROWSER = CANDIDATES.find((p) => p && existsSync(p));
if (!BROWSER) {
  console.error('未找到 Chrome/Edge（headless CDP 需要其一）');
  process.exit(2);
}
if (!existsSync(MAP)) {
  console.error(`地图不存在：${MAP}\n（*.bsp 被 .gitignore 忽略，需自备 test/maps/surf_666.bsp）`);
  process.exit(2);
}

const PORT = 9251 + Math.floor(Math.random() * 60);
const browser = spawn(
  BROWSER,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + (process.env.TEMP ?? '.') + '/ws-frame-bench-' + PORT,
    '--window-size=1280,720',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCdp() {
  for (let i = 0; i < 80; i++) {
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
  new Promise((res) => {
    const myId = ++id;
    pending[myId] = res;
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('DOM.enable');

console.log(`[${LABEL}] ${BROWSER.split('/').pop()} → ${URL}`);
console.log(`[${LABEL}] 地图 ${MAP}`);
await send('Page.navigate', { url: URL });
await sleep(3000);

const doc = await send('DOM.getDocument', { depth: -1 });
const nodeRes = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#bspFile' });
if (!nodeRes?.nodeId) {
  console.error('页面里找不到 #bspFile 文件输入框');
  browser.kill();
  process.exit(1);
}
await send('DOM.setFileInputFiles', { nodeId: nodeRes.nodeId, files: [MAP] });
console.log(`[${LABEL}] 已注入地图，等待加载…`);

// 就绪判据：出现 optimizeScene 日志（合并开启时）；超时则继续（合并关闭时不会有该日志）
const t0 = Date.now();
let sawMarker = false;
while (Date.now() - t0 < LOAD_TIMEOUT_MS) {
  if (consoleLines.some((l) => l.includes('optimizeScene') || l.includes('分块合并'))) {
    sawMarker = true;
    break;
  }
  await sleep(500);
}
console.log(
  `[${LABEL}] 就绪标记 ${sawMarker ? '出现' : '未出现（合并关闭或超时）'}（${((Date.now() - t0) / 1000).toFixed(1)}s）`,
);
const optLine = consoleLines.find((l) => l.includes('optimizeScene'));
if (optLine) console.log(`[${LABEL}] ${optLine}`);

await sleep(3000); // 让 LOD/PVS 注册与首帧渲染稳定

// 剔除统计（app.ts updateCullStatsUI → #cullStats）——面消失类问题的第一现场：
// 重点看「隐藏 N」（PVS 错误剔除数）与「可见 X/Y」。PVS 关、视距对齐后应为 隐藏 0。
const cullStats = await evalJs(`(document.getElementById('cullStats')?.textContent ?? '(无 #cullStats)')`);
console.log(`[${LABEL}] 剔除: ${cullStats}`);

await evalJs(`(() => {
  window.__ft = [];
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    window.__ft.push(now - last);
    last = now;
    if (window.__ft.length < ${SAMPLES}) requestAnimationFrame(tick);
    else window.__ftDone = true;
  };
  window.__ftDone = false;
  requestAnimationFrame(tick);
  return true;
})()`);

const waitStart = Date.now();
while (Date.now() - waitStart < 60000) {
  if (await evalJs('window.__ftDone === true')) break;
  await sleep(500);
}

const stats = await evalJs(`(() => {
  const a = (window.__ft || []).slice().sort((x, y) => x - y);
  if (a.length === 0) return null;
  const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  return JSON.stringify({
    n: a.length,
    meanMs: +mean.toFixed(3),
    fps: +(1000 / mean).toFixed(1),
    p50: +q(0.5).toFixed(3),
    p95: +q(0.95).toFixed(3),
    p99: +q(0.99).toFixed(3),
    max: +a[a.length - 1].toFixed(3),
    over33ms: a.filter((v) => v > 33).length,
    over50ms: a.filter((v) => v > 50).length,
  });
})()`);

console.log(`\n── [${LABEL}] 帧间隔统计 ──`);
if (!stats) {
  console.log('  无采样（渲染循环可能未启动）');
} else {
  const s = JSON.parse(stats);
  console.log(`  样本 ${s.n} 帧 | 平均 ${s.meanMs}ms（${s.fps} FPS）`);
  console.log(`  p50 ${s.p50} | p95 ${s.p95} | p99 ${s.p99} | max ${s.max}`);
  console.log(`  >33ms（掉 2 帧）${s.over33ms} | >50ms ${s.over50ms}`);
  console.log(`  RESULT_JSON ${stats}`);
}

ws.close();
browser.kill();
process.exit(stats ? 0 : 1);
