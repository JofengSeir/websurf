#!/usr/bin/env node
/**
 * dev 启动前的生成物自检 / 三端一键诊断。
 *
 * 用法：
 *   node src/scripts/dev-preflight.mjs game          # 单端（npm run predev 用）
 *   node src/scripts/dev-preflight.mjs --all        # 三端 + 端口报告（npm run dev:check）
 *
 * 为什么需要：`apps/<app>/web/app.js`、`worker.js`、`*.wasm` 全是 .gitignore 的生成物，
 * 而旧 `npm run dev` 只做 sync-web-assets + 起静态服务，从不构建它们。
 * 新克隆 / 清理产物后页面必定白屏或 404，且没有任何提示——这是「dev 起不来」
 * 反复出现的另一条根因。这里让缺失变成一条明确的、带修复命令的错误。
 *
 * 只读：不构建、不杀进程、不改文件。
 */
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPS = ['debug', 'game', 'viewer'];
const PORTS = { debug: 8080, game: 8090, viewer: 8100 };
// viewer 的 wasm 胶水前缀与 game/debug 不同（websurf_viewer_wasm vs websurf_wasm）。
const glueFor = (app) => (app === 'viewer' ? 'websurf_viewer_wasm' : 'websurf_wasm');

function checkApp(app) {
  const root = join(REPO, 'apps', app);
  const glue = glueFor(app);
  // styles.css 不是三端共有（debug 的 index.html 不引用它），故不作为硬判据。
  // index.html 是跟踪文件，留作 checkout 完整性的最小检查。
  const required = [
    { f: 'web/index.html', fix: 'tracked file - check your checkout' },
    { f: 'web/app.js', fix: 'npm run build:ts' },
    { f: 'web/worker.js', fix: 'npm run build:ts' },
    { f: `web/${glue}.js`, fix: 'npm run build:wasm' },
    { f: `web/${glue}_bg.wasm`, fix: 'npm run build:wasm' },
  ];
  const missing = [];
  const sizes = [];
  for (const r of required) {
    const p = join(root, r.f);
    if (!existsSync(p) || statSync(p).size === 0) {
      missing.push(r);
    } else {
      sizes.push(`${r.f}=${(statSync(p).size / 1024).toFixed(0)}KB`);
    }
  }
  return { app, missing, sizes };
}

/** 只读端口报告；与 dev-port.mjs 的判据一致（本地地址列 + LISTENING）。 */
function portReport() {
  let out = '';
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
  } catch {
    return ['  netstat unavailable'];
  }
  const lines = [];
  for (const [app, port] of Object.entries(PORTS)) {
    let pid = null;
    for (const line of String(out).split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      if ((cols[1] ?? '').endsWith(`:${port}`)) { pid = cols[4] ?? '?'; break; }
    }
    lines.push(`  ${app.padEnd(7)} :${port}  ${pid ? `LISTENING pid=${pid}` : 'free'}`);
  }
  return lines;
}

const arg = process.argv[2];
const apps = arg === '--all' ? APPS : [arg || basename(process.cwd())];
if (!apps.every((a) => APPS.includes(a))) {
  console.error(`[dev-preflight] unknown app: ${apps.join(', ')} (expected debug|game|viewer|--all)`);
  process.exit(1);
}

let bad = 0;
for (const app of apps) {
  const r = checkApp(app);
  if (r.missing.length === 0) {
    console.log(`  OK   ${app}: ${r.sizes.join(' ')}`);
  } else {
    bad++;
    console.log(`  MISS ${app}:`);
    for (const m of r.missing) console.log(`         ${m.f.padEnd(34)} <- ${m.fix}`);
  }
}

if (arg === '--all') {
  console.log('\n端口：');
  for (const line of portReport()) console.log(line);
  console.log('\n入口：双击 apps/<app>/dev.cmd（回收端口 -> 构建 -> 独立窗口起服务 -> 就绪后开浏览器）');
  console.log('静态服务：Node 版 src/scripts/serve.mjs，不依赖系统 Python（Store 假别名会导致启动失败）');
  console.log('诊断：node src/scripts/dev-port.mjs <port> --check-only');
}

if (bad > 0) {
  console.error(`\n[dev-preflight] ${bad} app(s) missing dev artifacts.`);
  console.error('[HINT] In that app dir run: npm run build:wasm && npm run build:ts');
  process.exit(1);
}
console.log('[dev-preflight] OK');
