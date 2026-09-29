/**
 * 最小 CDP 截图工具：起一个无头 Edge、打开 URL、等一会儿、截一张 PNG。
 *
 * 用途：给"观感类"改动做**眼睛可验**的证据 —— 单元测试与冒烟只能证明页面不崩，
 * 证明不了"好不好看"。有了它，改样式之后可以自己看一眼再交。
 *
 * 用法：node test/shot.mjs <url> <输出.png> [等待毫秒] [宽x高]
 * 环境变量：EDGE_PATH 覆盖浏览器路径。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8080/web/index.html';
const OUT = process.argv[3] ?? '.tmp/shot.png';
const WAIT = Number(process.argv[4] ?? 6000);
const SIZE = process.argv[5] ?? '1440x900';
const [W, H] = SIZE.split('x').map(Number);

const CANDIDATES = [
  process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const exe = CANDIDATES.find((p) => existsSync(p));
if (!exe) {
  console.error('找不到 Edge，可用 EDGE_PATH 指定');
  process.exit(1);
}

const port = 9500 + Math.floor(Math.random() * 200);
const proc = spawn(exe, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--window-size=${W},${H}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--user-data-dir=' + process.cwd() + '/.tmp/shot-profile',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function version() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('浏览器调试端口未就绪');
}

let id = 0;
function rpc(ws, method, params = {}, sessionId) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== msgId) return;
      ws.removeEventListener('message', onMsg);
      m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
}

try {
  const v = await version();
  const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const { targetInfos } = await rpc(ws, 'Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await rpc(ws, 'Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await rpc(ws, 'Page.enable', {}, sessionId);
  await rpc(ws, 'Emulation.setDeviceMetricsOverride',
    { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
  await rpc(ws, 'Page.navigate', { url: URL_ }, sessionId);
  await sleep(WAIT);
  const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`已截图 ${OUT}（${W}x${H}，等待 ${WAIT}ms）`);
  ws.close();
} finally {
  proc.kill();
}
