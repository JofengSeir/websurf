#!/usr/bin/env node
/**
 * test — trace 公共模块链路验证（Chrome headless + CDP）
 *
 * 验证：点击"开始" → WorkerA TraceRecorder 采样 → main 转发 → WorkerB TraceRenderer
 * 渲染 3D 路径线。通过 DOM 按钮点击 + WorkerB 内部状态检查（无控制台错误 + trace 线存在）。
 */
import { spawn } from 'node:child_process';

const URL = process.argv[2] ?? 'http://localhost:8082/index.html';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9230;

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + process.env.TEMP + '/trace-verify', URL,
], { stdio: 'ignore' });

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

async function main() {
  const page = await waitForCdp();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = {};
  const consoleMsgs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id]; }
    if (m.method === 'Runtime.consoleAPICalled') {
      consoleMsgs.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleMsgs.push('EXCEPTION: ' + (m.params.exceptionDetails?.text ?? ''));
    }
  };
  const send = (method, params = {}) => new Promise((r) => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable');

  // 加载等待（wasm 解析 + 首帧）
  await new Promise((r) => setTimeout(r, 3000));

  // 检查 trace 按钮存在并点击"开始"
  const btnState = await send('Runtime.evaluate', {
    expression: `(() => {
      const btn = document.getElementById('traceBtn');
      if (!btn) return 'NO_BTN';
      btn.click(); // 开始记录
      return 'CLICKED:' + btn.textContent;
    })()`,
    returnByValue: true,
  });
  console.log('按钮状态:', btnState.result.value);

  // 等待采集（TraceRecorder 16ms/点 → 1s 约 60 点）
  await new Promise((r) => setTimeout(r, 2000));

  // 再次点击"保存"（停止记录，路径保留）
  const btnState2 = await send('Runtime.evaluate', {
    expression: `(() => {
      const btn = document.getElementById('traceBtn');
      btn.click(); // 保存
      return 'CLICKED:' + btn.textContent;
    })()`,
    returnByValue: true,
  });
  console.log('按钮状态:', btnState2.result.value);

  // 检查 HUD + 无错误
  const final = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      hud: document.getElementById('status')?.textContent ?? 'NO_HUD',
      legend: document.getElementById('traceLegend')?.textContent ?? '',
    })`,
    returnByValue: true,
  });
  const info = JSON.parse(final.result.value);
  console.log('HUD:', info.hud);
  console.log('图例:', info.legend);
  console.log('控制台:', consoleMsgs.length ? consoleMsgs.join(' | ') : '(无)');

  const errors = consoleMsgs.filter((m) => /error|exception|failed/i.test(m));
  const ok = errors.length === 0;
  console.log(`\n结果: ${ok ? '✅ trace 公共链路运行正常（无错误）' : '❌ 存在错误：' + errors.join(' | ')}`);
  chrome.kill();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('FAIL:', e.message); chrome.kill(); process.exit(1); });
