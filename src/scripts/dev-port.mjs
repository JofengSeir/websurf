#!/usr/bin/env node
/**
 * dev 启动前的端口预检与旧服务回收。
 *
 * 用法：node src/scripts/dev-port.mjs <port> [--check-only]
 *   默认（回收模式）：只杀掉占该端口的 **WebSurf 自己的服务进程**（新版 node serve.mjs，
 *                     兼容旧版 python serve.py）；其它占用一律不碰，明确报错让调用方换端口。
 *   --check-only     ：只读报告，不杀任何进程；有 LISTENING 即 exit 2。
 *
 * 为什么放在 build:wasm 之前：旧的 dev server 会持有 web/*.wasm 的文件句柄，
 * 此时 copy-wasm-pkg.mjs 覆写会报 os error 5 / EBUSY（见 skills/websurf-env-traps §9）。
 * 先回收旧服务，一次性消掉「端口占用 → 静默退出」和「产物被锁 → 构建失败」两类反复故障。
 *
 * 识别规则（安全优先，宁可不杀也不误杀）：
 *   - node.exe 且任一 PID 文件（仓库 .tmp 下的 dev 版，或各 app 的 dist 目录下
 *     的内联 dist 版）记录的 PID 与监听者一致 ⇒ WebSurf 的 serve.mjs；
 *   - python.exe ⇒ 旧版 serve.py（保持向后兼容）；
 *   - 其它进程名 / PID 不匹配 ⇒ 一律不动，exit 2。
 * 只处理指定端口上的 LISTENING 者，绝不动外部程序或其它端口的 dev server。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2]);
const checkOnly = process.argv.includes('--check-only');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('[dev-port] usage: node dev-port.mjs <port> [--check-only]');
  process.exit(1);
}

/** 返回在指定端口上 LISTENING 的 PID 列表（去重）。 */
function listenersOn(targetPort) {
  let out;
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
  } catch (e) {
    console.error(`[dev-port] netstat failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const pids = new Set();
  for (const line of String(out).split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[1] ?? '';
    const pid = cols[4] ?? '';
    // 只认本地地址列结尾的 :port，避免把「远端端口恰好相同」的 TIME_WAIT 行算进来。
    if (!local.endsWith(`:${targetPort}`)) continue;
    if (/^\d+$/.test(pid)) pids.add(pid);
  }
  return [...pids];
}

/** 用 tasklist 取进程名（CSV 第一列，不依赖中文输出）。 */
function processName(pid) {
  try {
    const out = execFileSync(
      'tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true },
    );
    const first = String(out).trim().split(/\r?\n/)[0] ?? '';
    const m = first.match(/^"?([^",]+)"?/);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// dev 版 serve.mjs 写仓库 .tmp/；dist 版内联服务器写各自 dist/ 目录。
// 两个位置都只认「PID 与端口监听者一致」的 node.exe，避免误杀同端口的外部 node 程序。
const pidFiles = [
  join(REPO, '.tmp', `dev-server-${port}.pid`),
  ...['debug', 'game', 'viewer'].map((a) => join(REPO, 'apps', a, 'dist', `.dev-server-${port}.pid`)),
];

function matchesPidFile(pid) {
  for (const f of pidFiles) {
    try {
      if (existsSync(f) && readFileSync(f, 'utf8').trim() === String(pid)) return true;
    } catch { /* 读不到就不认 */ }
  }
  return false;
}

function dropPidFiles() {
  for (const f of pidFiles) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* 忽略 */ }
  }
}

/** 判断监听者是不是 WebSurf 的服务；返回 'node' | 'python' | null（null = 不许碰）。 */
function serverKind(pid) {
  const name = processName(pid);
  if (/^python(?:\.exe)?$/i.test(name)) return 'python';
  if (/^node(?:\.exe)?$/i.test(name) && matchesPidFile(pid)) return 'node';
  return null;
}

const pids = listenersOn(port);
if (pids.length === 0) {
  console.log(`[dev-port] port ${port}: free`);
  process.exit(0);
}

if (checkOnly) {
  for (const pid of pids) {
    const kind = serverKind(pid);
    console.log(`[dev-port] port ${port}: LISTENING pid=${pid} process=${processName(pid) || '?'} websurf=${kind ?? 'NO'}`);
  }
  console.log(`[dev-port] port ${port}: occupied`);
  process.exit(2);
}

for (const pid of pids) {
  const kind = serverKind(pid);
  if (!kind) {
    console.error(`[dev-port] port ${port} is held by a NON-WebSurf process (pid=${pid}, ${processName(pid) || '?'}); not touching it.`);
    console.error(`[dev-port] HINT: use another port, e.g. dev.cmd ${port + 1}`);
    process.exit(2);
  }
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore', windowsHide: true });
    console.log(`[dev-port] port ${port}: recycled stale WebSurf ${kind} server (pid=${pid})`);
  } catch (e) {
    console.error(`[dev-port] failed to stop pid=${pid}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(3);
  }
}
dropPidFiles();

// 回收后立刻复查：TIME_WAIT 不算占用，但仍有 LISTENING 说明回收没生效。
const left = listenersOn(port);
if (left.length > 0) {
  console.error(`[dev-port] port ${port} still has LISTENING pid(s): ${left.join(', ')}`);
  process.exit(3);
}
console.log(`[dev-port] port ${port}: ready`);
