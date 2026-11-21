#!/usr/bin/env node
/**
 * 等 dev server 真正回答 200，再放行「打开浏览器」这一步。
 *
 * 用法：node src/scripts/wait-for-server.mjs <port> [timeoutMs]
 *
 * 背景：三端 dev.cmd 原来用固定 `timeout /t 1` 延时硬开浏览器。只要静态服务
 * bind 失败（端口占用 / 旧进程锁文件 / 服务进程启动失败），浏览器照样打开，
 * 用户看到的就是「连接失败」空白页，而批处理还在末尾打印 [OK] 并 exit 0。
 * 这里把「服务就绪」变成显式判据：不 200 就不开浏览器，并明确报错。
 */
const port = Number(process.argv[2]);
const timeoutMs = Number(process.argv[3] ?? 10_000);

if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(timeoutMs)) {
  console.error('[wait-for-server] usage: node wait-for-server.mjs <port> [timeoutMs]');
  process.exit(1);
}

const url = `http://127.0.0.1:${port}/web/index.html`;
const deadline = Date.now() + timeoutMs;
let last = 'no response yet';

while (Date.now() < deadline) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(900) });
    if (r.ok) {
      console.log(`[wait-for-server] ready: ${url}`);
      process.exit(0);
    }
    last = `HTTP ${r.status}`;
  } catch (e) {
    // 把底层 cause 一起带出来：fetch failed 本身看不出是 ECONNREFUSED（服务没起）
    // 还是代理/超时，排障时会白等 10 秒还不知道原因。
    const cause = e instanceof Error && e.cause ? `: ${String(/** @type {any} */ (e.cause).message ?? e.cause)}` : '';
    last = (e instanceof Error ? e.message : String(e)) + cause;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

console.error(`[ERROR] server did not answer 200 on ${url} within ${timeoutMs} ms (${last})`);
console.error('[HINT] Check the "dev server" window for a bind error, or that node is on PATH.');
console.error('[HINT] Another process may hold the port: node src/scripts/dev-port.mjs ' + port + ' --check-only');
process.exit(1);
