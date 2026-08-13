#!/usr/bin/env node
/**
 * mini — 真实浏览器验证（Chrome headless + CDP）
 *
 * 用系统 Chrome 无头模式加载 mini 页面，通过 CDP 捕获：
 *   - 控制台错误（Worker 加载失败/WebGL 错误）
 *   - HUD 状态文本（WorkerB status 消息 → "渲染 X f/s · 物理刷新 Y/s"）
 *   - SAB 可用性（crossOriginIsolated）
 *
 * 用法：node scripts/mini-browser-verify.mjs [url]
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://localhost:8081/index.html';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9223;

// ── 启动 Chrome headless + CDP ──
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + process.env.TEMP + '/mini-chrome-profile',
  URL,
], { stdio: 'ignore' });

// ── 轮询等待 CDP 可用 ──
async function waitForCdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://localhost:${DEBUG_PORT}/json/list`);
      if (r.ok) return (await r.json()).find((t) => t.type === 'page');
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('CDP 不可用');
}

let ws;
async function send(method, params = {}) {
  ws.send(JSON.stringify({ id: ++send.id, method, params }));
  return new Promise((resolve) => {
    const handler = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === send.id) {
        ws.removeEventListener('message', handler);
        resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
  });
}

async function main() {
  const page = await waitForCdp();
  if (!page) throw new Error('无页面目标');

  // Node 22 全局 WebSocket（浏览器实现）
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  const logs = [];
  const consoleMsgs = [];
  send.id = 0;

  // 订阅 Runtime.consoleAPICalled + 收集 HUD
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const txt = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      consoleMsgs.push(txt);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION: ' + JSON.stringify(msg.params.exceptionDetails?.text ?? ''));
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');

  // 等 5s 收集运行状态（首帧 + 至少一次 status 结算）
  await new Promise((r) => setTimeout(r, 5000));

  // 读取 HUD 文本（WorkerB status 消息落在这里）
  const evalRes = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      isolated: globalThis.crossOriginIsolated,
      sab: typeof SharedArrayBuffer !== 'undefined',
      hud: document.getElementById('status')?.textContent ?? '',
      hudTitle: document.getElementById('hud')?.textContent ?? '',
      canvasW: document.getElementById('game')?.width ?? -1,
      canvasH: document.getElementById('game')?.height ?? -1,
    })`,
    returnByValue: true,
  });
  const info = JSON.parse(evalRes.result.value);

  console.log('\n════════ mini 真实浏览器验证（Chrome headless + CDP）════════');
  console.log(`crossOriginIsolated: ${info.isolated}（SAB ${info.isolated ? '可用' : '不可用'}）`);
  console.log(`canvas: ${info.canvasW}×${info.canvasH}`);
  console.log(`HUD 状态: ${info.hud || '(空——WorkerB 未回传 status)'}`);
  if (info.hudTitle) console.log(`HUD 标题: ${info.hudTitle.split('\\n')[0]}`);
  console.log(`控制台消息: ${consoleMsgs.length ? consoleMsgs.join(' | ') : '(无)'}`);
  console.log(`异常: ${logs.length ? logs.join(' | ') : '(无)'}`);

  const ok =
    info.isolated === true &&
    (info.hud.includes('f/s') || info.hud.includes('等待')) &&
    !consoleMsgs.some((m) => /error|failed|uncaught/i.test(m)) &&
    logs.length === 0;

  console.log(`\n结果: ${ok ? '✅ 真实浏览器运行正常' : '❌ 存在问题（见上方输出）'}`);
  chrome.kill();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  chrome.kill();
  process.exit(1);
});
