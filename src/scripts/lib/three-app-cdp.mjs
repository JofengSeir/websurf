/**
 * 三端 CDP 小工具（`check-prefs-parity.mjs` / `check-render-consistency.mjs` 共用）。
 *
 * 只做四件事：解析浏览器可执行文件、探测三端 dev 服务、拉起 headless 浏览器（CDP 调试端口）、
 * 逐端开页面并收集控制台行 / 求值结果。**不引入 npm 依赖**：Node ≥ 22 自带全局 `WebSocket`，
 * CDP 的 JSON 协议直接跑在它上面（`ws` 之类不必进 `package.json`）。
 *
 * 依赖缺失（dev 服务没起 / 找不到浏览器）由调用方自报 `SKIP` 并 `exit 0`（D4：不接 CI，
 * 缺依赖不红）。本文件不是公开脚本（`src/scripts/lib/**` 不在 docflow 覆盖率清单内），
 * 不单独登记 AGENTS §3.1。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** 三端 dev 页面（端口与 AGENTS 附录 A 一致：debug 8080 / game 8090 / viewer 8100）。 */
export const APP_PAGES = [
  { app: 'debug', port: 8080, url: 'http://127.0.0.1:8080/web/index.html' },
  { app: 'game', port: 8090, url: 'http://127.0.0.1:8090/web/index.html' },
  { app: 'viewer', port: 8100, url: 'http://127.0.0.1:8100/web/index.html' },
];

/** 浏览器可执行文件的探测顺序：环境变量优先（`EDGE_PATH`），其后是 Edge 的两个常见安装位。 */
const BROWSER_CANDIDATES = [
  process.env.EDGE_PATH,
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

/** 返回可用的浏览器可执行文件路径；都没有时返回 null（调用方 SKIP）。 */
export function resolveBrowser() {
  return BROWSER_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** 逐个探测三端 dev 服务页可达性；返回 `{ app: boolean }`。任一不可达 ⇒ 调用方 SKIP。 */
export async function probeDevServers(timeoutMs = 2000) {
  const out = {};
  await Promise.all(
    APP_PAGES.map(async (p) => {
      try {
        const ctl = AbortSignal.timeout(timeoutMs);
        const r = await fetch(p.url, { signal: ctl });
        out[p.app] = r.ok;
      } catch {
        out[p.app] = false;
      }
    }),
  );
  return out;
}

/**
 * 拉起 headless 浏览器并等 CDP 调试端口就绪。
 *
 * `--enable-unsafe-swiftshader` + `--use-angle=swiftshader`：本机无 GPU 可用时也要能建 WebGL 上下文
 * （否则页面在 `createRenderer` 处直接抛错、控制台行收不全）。
 *
 * @returns `{ close() }`；`handle` 为 null 表示浏览器不可用。
 */
export async function launchBrowser({ root, port = 9412, profileDir, headless = true }) {
  const exe = resolveBrowser();
  if (!exe) return null;
  const profile = profileDir ?? join(root, '.tmp', 'cdp-profile');
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const proc = spawn(
    exe,
    [
      ...(headless ? ['--headless=new'] : []),
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--disable-gpu-sandbox',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  return { proc, port, close: () => { try { proc.kill(); } catch { /* 已退出 */ } } };
}

/** 连上 CDP：`{ send(method, params, sessionId), on(handler), close() }`。 */
export async function connectCdp(port, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let version = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch { /* 端口还没起 */ }
    await sleep(300);
  }
  if (!version) throw new Error(`浏览器调试端口未就绪：${port}`);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const handlers = new Set();
  ws.addEventListener('message', (ev) => {
    let msg = null;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    for (const h of handlers) h(msg);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  return {
    version,
    send,
    on: (h) => { handlers.add(h); return () => handlers.delete(h); },
    close: () => { try { ws.close(); } catch { /* 已关闭 */ } },
  };
}

/** 控制台实参 → 文本（`console.info('a', 'b')` 会分成两个实参）。 */
const argText = (a) => (a && a.value !== undefined ? String(a.value) : a && a.description !== undefined ? String(a.description) : '');

/**
 * 开一个页面、收控制台行、可选在页面里求值，然后关掉该页。
 *
 * 顺序契约：先 `Target.createTarget(about:blank)` → 附加（flat session）→ `Runtime.enable` →
 * `Page.navigate`。反过来会在页面脚本执行之后才订阅，页面初始化期的诊断行会全部丢失。
 *
 * @param cdp `connectCdp` 的返回值。
 * @param url 目标页面（可带查询串）。
 * @param opts.match 只保留匹配的控制台行（正则）。
 * @param opts.settleMs 导航后等待时间（页面初始化 + 首帧）。
 * @param opts.evaluate 可选：等待结束后在页面里求值的表达式（返回 JSON 可序列化值）。
 * @param opts.allowConsoleErrors 为真时把页面异常（`Runtime.exceptionThrown`）也收进 `errors`。
 * @returns `{ lines, errors, value }`
 */
export async function capturePage(cdp, url, opts = {}) {
  const { match = null, settleMs = 6000, evaluate = null } = opts;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const all = [];
  const errors = [];
  const off = cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map(argText).join(' ');
      all.push(text);
      if (msg.params.type === 'error') errors.push(text);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails ?? {};
      errors.push(d.exception?.description ?? d.text ?? '(页面异常)');
    }
  });
  try {
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    await sleep(settleMs);
    let value;
    if (evaluate) {
      const r = await cdp.send('Runtime.evaluate', { expression: evaluate, returnByValue: true, awaitPromise: true }, sessionId);
      value = r.result?.value;
    }
    const lines = match ? all.filter((l) => match.test(l)) : all;
    return { lines, all, errors, value };
  } finally {
    off();
    try { await cdp.send('Target.closeTarget', { targetId }); } catch { /* 页面已关 */ }
  }
}

/** 把 `[render-prefs] 生效：a=1 b=2` 之类的诊断行拆成键值表（用于逐字段定位差异）。 */
export function keyValueMap(line) {
  const body = line.includes('：') ? line.slice(line.indexOf('：') + 1) : line;
  const map = new Map();
  for (const tok of body.trim().split(/\s+/)) {
    const i = tok.indexOf('=');
    if (i > 0) map.set(tok.slice(0, i), tok.slice(i + 1));
  }
  return map;
}
