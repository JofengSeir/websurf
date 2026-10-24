/**
 * 三端同机位截图（本地可视化验收工具；不是 CI 判据）。
 *
 * 规则（owner 2026-10-22）：WebSurf 渲染以**看图**为准，禁止用像素统计代替判断。
 * 本脚本只做「同图、同机位、关掉 HUD」的截图，输出三张图给人工比对；不比较像素。
 *
 * 前置：本机已用远程调试端口起 Edge/Chrome（二选一）：
 *   msedge.exe --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\edge-cdp ^
 *     --no-first-run --use-angle=swiftshader --enable-unsafe-swiftshader --window-size=1600,900 about:blank
 *
 * 用法（仓库根）：
 *   node src/scripts/capture-render.mjs --url <页面 URL> [--map <bsp 绝对路径>] \
 *     [--pose x,y,z,yaw,pitch] --out <png 路径> [--wait 300000]
 *
 * 说明：
 * - viewer 走 `?bsp=` 深链时不要传 `--map`；game/debug 传 `--map`，脚本用 CDP 给 `#bspFile` 设文件。
 * - `--pose` 是**相机位姿**（HU + 度），经各端共享 `globalThis.__vbspPose` 钉住。
 * - 只截 WebGL canvas（DOM HUD/面板会临时隐藏）；三端 canvas 比例可能不同，属已知差异。
 */
import { writeFileSync } from 'node:fs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const url = arg('url');
const map = arg('map');
const out = arg('out', 'render.png');
const waitMs = Number(arg('wait', '300000'));
const poseArg = arg('pose');
/** 页面加载前注入的诊断全局（例：globalThis.__vbspWaterReflectOff=true）。 */
const initScript = arg('init');
if (!url) {
  console.error('缺少 --url');
  process.exit(2);
}
const pose = poseArg
  ? (() => {
      const [x, y, z, yawDeg, pitchDeg] = poseArg.split(',').map(Number);
      if ([x, y, z, yawDeg, pitchDeg].some((v) => !Number.isFinite(v))) throw new Error('--pose 需要 x,y,z,yaw,pitch');
      return { pos: [x, y, z], yawDeg, pitchDeg };
    })()
  : null;

const cdp = arg('cdp', 'http://127.0.0.1:9222');
const targets = await (await fetch(cdp + '/json/list')).json();
let target = targets.find((t) => t.type === 'page');
if (!target) target = await (await fetch(cdp + '/json/new?about:blank', { method: 'PUT' })).json();

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let seq = 0;
const pending = new Map();
const consoleLines = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    consoleLines.push('[' + msg.params.type + '] ' + (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    consoleLines.push('[exception] ' + (msg.params.exceptionDetails?.text ?? '') + ' ' + (msg.params.exceptionDetails?.exception?.description ?? ''));
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('DOM.enable');
if (initScript) await send('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
await send('Page.navigate', { url });

const started = Date.now();
let mounted = false;
while (Date.now() - started < 30000) {
  try { mounted = await evaluate('!!globalThis.__vbspRenderProbe'); } catch { /* 导航中 */ }
  if (mounted) break;
  await sleep(300);
}
if (!mounted) throw new Error('__vbspRenderProbe 未挂载：页面没起来？');

if (map && !url.includes('bsp=')) {
  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#bspFile' });
  if (!q.nodeId) throw new Error('页面没有 #bspFile，无法自动载图');
  await send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [map] });
}

let state = null;
while (Date.now() - started < waitMs) {
  try {
    state = await evaluate(`(() => {
      const p = globalThis.__vbspRenderProbe;
      if (!p) return { probe: false };
      const s = p.snapshot();
      return { probe: true, merge: s.merge, sky: s.sky, cull: s.cull, fp: s.prefs.fingerprint };
    })()`);
    if (state?.merge) break;
  } catch { /* 解析/装配中 */ }
  await sleep(700);
}
if (!state?.merge) throw new Error('场景未完成合并（等待超时）');

if (pose) {
  const applied = await evaluate(`(async () => {
    const e = globalThis.__vbspPose;
    if (!e) return { ok: false, why: '__vbspPose 未挂载' };
    return { ok: true, pose: await e.setPose(${JSON.stringify(pose)}) };
  })()`);
  if (!applied?.ok) throw new Error('位姿未应用：' + JSON.stringify(applied));
  await sleep(2500);
}
const camera = await evaluate('globalThis.__vbspPose ? globalThis.__vbspPose.cameraPose() : null');

// 只留 canvas，隐藏 DOM HUD/面板（截图裁剪里不再混入界面）。
await evaluate(`(() => {
  const s = document.createElement('style');
  s.textContent = 'body *{visibility:hidden!important} canvas{visibility:visible!important}';
  document.head.appendChild(s);
})()`);
await sleep(300);
const rect = await evaluate(`(() => {
  const c = document.querySelector('canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`);
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  ...(rect ? { clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } } : {}),
});
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(JSON.stringify({ url, map: map ?? null, out, pose, camera, rect, state, elapsedMs: Date.now() - started }, null, 2));
const bad = consoleLines.filter((l) => /exception|\[error\]/.test(l));
if (bad.length) {
  console.log('--- console errors (' + bad.length + ') ---');
  for (const l of bad.slice(-20)) console.log(l);
}
ws.close();
