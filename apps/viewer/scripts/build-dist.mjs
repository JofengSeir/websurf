/**
 * viewer 打包：单文件（single）产物 → viewer/dist/（唯一产物目录）。薄入口（D-04 / T-04）。
 *
 * ── single（本地双击 file://；wasm 内嵌 app.js）与 multi（--multi，Pages 部署；wasm 外置 + 内嵌回退）→ viewer/dist/ ──
 *   index.html — classic `<script>`（file:// 下 module script 被浏览器 CORS 拦截）
 *   app.js     — IIFE：内嵌 WASM(base64) + 录像解析 Worker 代码（Blob URL 启动）
 *   styles.css — web/styles.css 原样拷贝
 *   assets/maps/surf_null_4.replay（原生 Shavit 示例录像；HTTP 深链演示用，file:// 走面板文件选择）
 *   serve.py   — 静态服务器（python serve.py [port]，默认 8101）
 *   play.cmd / play.sh — 双击启动：起服务器 + 延时 1s 自动打开浏览器（python 缺失 → 提示 + npx serve 备选）
 *   README.md / .nojekyll
 *
 * 【2026-09-12 维护者裁定解除 single-only】：Pages 部署改用 multi（外置 wasm 请求优先，
 * 失败回退 wasm-embedded.js 内嵌副本）；single 保留为本地 file:// 双击形态。
 *
 * 打包内核（esbuild 注入、cleanDist 先删后建、__VBSP_* 拼装）：
 *   ../../../src/scripts/lib/dist-pack.mjs
 *
 * 用法（在 viewer/ 目录）：
 *   node scripts/build-dist.mjs    # single → dist/
 */
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  bundleIife,
  writeEmbeddedPreamble,
  rewriteIndexToClassicScript,
  cleanDist,
  cleanStale,
  printTree,
} from '../../../src/scripts/lib/dist-pack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(HERE, '..'); // apps/viewer
const repoRoot = join(viewerRoot, '..', '..'); // 仓库根
const dist = join(viewerRoot, 'dist');

const multi = process.argv.includes('--multi');

const APP_SRC = join(viewerRoot, 'src/app.ts');
const WORKER_SRC = join(viewerRoot, 'src/worker/main.ts');
const HEADER = '/* WebSurf-viewer single-file build — auto-generated, do not edit */\n';
const KEEP_SINGLE = [
  '.nojekyll',
  'README.md',
  'serve.py',
  'play.cmd',
  'play.sh',
  'index.html',
  'app.js',
  'styles.css',
];
const KEEP_MULTI = [
  ...KEEP_SINGLE.filter((f) => f !== 'index.html' && f !== 'app.js'),
  'index.html',
  'app.js',
  'worker.js',
  'websurf_viewer_wasm_bg.wasm',
  'wasm-embedded.js',
  'coi-serviceworker.js',
];

const SERVE_PY = `"""WebSurf-viewer 静态服务器（本地预览；部署时任意静态托管均可）。

用法：python serve.py [port]   # 默认 8101，服务目录 = 本脚本所在目录
"""
import http.server
import socketserver
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8101
ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".bsp": "application/octet-stream",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".html": "text/html; charset=utf-8",
    }

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\\n")


DEMO = "/index.html?replay=assets/maps/surf_null_4.replay"


class Server(socketserver.TCPServer):
    # SO_REUSEADDR：关窗后立刻重开不会被 TIME_WAIT 卡死（"通常每个套接字地址
    # 只允许使用一次"）；占用中的活动端口仍会报错，由下方 OSError 提示兜底
    allow_reuse_address = True


try:
    server = Server(("", PORT), Handler)
except OSError as e:
    print(f"[ERROR] 端口 {PORT} 无法监听：{e}")
    print(f"[HINT] 端口可能已被占用——换一个端口：python serve.py {PORT + 1}")
    sys.exit(1)

with server:
    print(f"Serving {ROOT} at http://localhost:{PORT}/")
    print(f"  App:  http://localhost:{PORT}/index.html")
    if os.path.isdir(os.path.join(ROOT, "assets")):
        print(f"  Demo: http://localhost:{PORT}{DEMO}")
    print("  Quit: Ctrl+C")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\\nShutting down.")
`;

/**
 * dist/play.cmd —— 双击启动入口（Windows）。
 * 契约（静态可测）：python 优先；缺失 → 提示 + npx serve 自动备选；双缺 → 两条指引 + pause；
 * 打印地址（普通页 + 示例深链）；`start ""` 延时 1s 异步开浏览器；前台起 serve.py（端口首参可覆盖）。
 * ⚠️ 全文纯 ASCII：cmd.exe 对「非 ASCII + chcp」的批处理存在解析失步风险（行被从中间
 * 撕开执行）；写盘统一转 CRLF（LF-only 批处理同样会触发解析错乱，见 2026-09-05 修复）。
 */
const PLAY_CMD = `@echo off
chcp 65001 >nul
rem WebSurf-viewer local preview: serve dist and open browser (Windows)
rem usage: play.cmd [port] (default 8101; close this window to stop, Ctrl+C also works)
setlocal EnableExtensions
cd /d "%~dp0"

set PORT=8101
if not "%~1"=="" set PORT=%~1

rem -- toolchain: python first, fallback to npx serve --
where python >nul 2>nul
if errorlevel 1 (
  echo [WARN] python not found -- install Python 3 first ^(https://www.python.org/downloads/^).
  where npx >nul 2>nul
  if errorlevel 1 (
    echo [WARN] npx not found either -- install Node.js ^(https://nodejs.org/^).
    echo [HINT] install Python 3 or Node.js and retry; or run: npx serve -l %PORT% .
    pause
    exit /b 1
  )
  echo [INFO] python missing - using Node fallback: npx serve.
  echo [INFO] starting: npx --yes serve -l %PORT% .
  start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/index.html"
  npx --yes serve -l %PORT% .
  exit /b %errorlevel%
)

echo ============================================================
echo  WebSurf-viewer local preview ^(close this window to stop^)
echo   page    http://localhost:%PORT%/index.html
echo   demo    http://localhost:%PORT%/index.html?replay=assets/maps/surf_null_4.replay
echo ============================================================
rem open browser after 1s (async, does not block server startup)
start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/index.html"
python serve.py %PORT%
`;

/**
 * dist/play.sh —— 双击启动入口（macOS/Linux）。行为对齐 play.cmd：
 * python3 → python → npx（`npx --yes serve -l <port> .`）依次回退；双缺 → 中文提示并退出非 0。
 */
const PLAY_SH = `#!/usr/bin/env bash
# WebSurf-viewer 本地预览：起静态服务并自动打开浏览器（macOS/Linux）
# 用法：./play.sh [port]（默认 8101；关闭本窗口即停止服务，Ctrl+C 亦可）
set -e
cd "$(dirname "$0")"
PORT="\${1:-8101}"

open_browser() {
  ( sleep 1
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$PORT/index.html" >/dev/null 2>&1
    elif command -v open >/dev/null 2>&1; then open "http://localhost:$PORT/index.html" >/dev/null 2>&1
    fi
  ) &
}

if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else
  echo "[HINT] 未找到 python —— 请先安装 Python 3（https://www.python.org/downloads/）。"
  if command -v npx >/dev/null 2>&1; then
    echo "[HINT] 使用 Node 备选：npx serve（python 缺失，自动安装并启动）。"
    echo "[HINT] 正在启动：npx --yes serve -l $PORT ."
    open_browser
    exec npx --yes serve -l "$PORT" .
  fi
  echo "[HINT] 也未找到 npx —— 需要 Node.js（https://nodejs.org/）。"
  echo "[HINT] 手动备选：安装 Python 3 或 Node.js 后重试；或装好任意静态服务器后运行  npx serve -l $PORT ."
  exit 1
fi

echo "============================================================"
echo " WebSurf-viewer 本地预览（关闭本窗口即停止服务；Ctrl+C 亦可）"
echo "  普通页  http://localhost:$PORT/index.html"
echo "  示例    http://localhost:$PORT/index.html?replay=assets/maps/surf_null_4.replay"
echo "============================================================"
open_browser
exec "$PY" serve.py "$PORT"
`;

async function rebuildDist() {
  // 全量重建：先删后建（规范 §5.2 R-15，禁止增量残留）
  await cleanDist(dist);
  await mkdir(join(dist, 'assets', 'maps'), { recursive: true });

  // ── 公共尾随产物 ────────────────────────────────────────────────────
  await writeFile(join(dist, '.nojekyll'), '');
  await copyFile(join(viewerRoot, 'scripts/dist-README.md'), join(dist, 'README.md'));
  await writeFile(join(dist, 'serve.py'), SERVE_PY);
  // .cmd 必须 CRLF：LF-only 批处理会触发 cmd.exe 解析错乱（行被撕开执行）
  await writeFile(join(dist, 'play.cmd'), PLAY_CMD.replace(/\n/g, '\r\n'));
  await writeFile(join(dist, 'play.sh'), PLAY_SH);

  // ── 公共参考资源（示例深链；fixture 缺失时警告跳过）──────────────
  await mkdir(join(dist, 'assets', 'maps'), { recursive: true });
  for (const name of ['surf_null_4.replay']) {
    const srcReplay = join(repoRoot, 'test', 'maps', name);
    if (existsSync(srcReplay)) {
      await copyFile(srcReplay, join(dist, 'assets/maps', name));
    } else {
      console.warn(`[WARN] 示例资产缺失，跳过: test/maps/${name}（dist 示例深链将不可用）`);
    }
  }

  if (multi) {
    // ── multi：ESM app/worker + 外置 wasm + 内嵌回退副本（Pages 部署）────
    console.log('[multi] 复制 web/ 产物（app.js/worker.js/styles.css/index.html）…');
    await copyFile(join(viewerRoot, 'web/index.html'), join(dist, 'index.html'));
    await copyFile(join(viewerRoot, 'web/app.js'), join(dist, 'app.js'));
    await copyFile(join(viewerRoot, 'web/worker.js'), join(dist, 'worker.js'));
    await copyFile(join(viewerRoot, 'web/styles.css'), join(dist, 'styles.css'));
    console.log('[multi] 复制外置 WASM …');
    const wasmMulti = join(dist, 'websurf_viewer_wasm_bg.wasm');
    await copyFile(join(viewerRoot, 'web/websurf_viewer_wasm_bg.wasm'), wasmMulti);
    console.log('[multi] 生成 wasm-embedded.js（fetch 失败时的内嵌回退副本）…');
    const wasmBytes = await readFile(join(viewerRoot, 'web/websurf_viewer_wasm_bg.wasm'));
    await writeFile(
      join(dist, 'wasm-embedded.js'),
      `/* WebSurf-viewer WASM 内嵌回退副本（fetch 失败时由 bsp.ts 动态加载）—— auto-generated */\n` +
        `globalThis.__VBSP_WASM_B64__ = "${wasmBytes.toString('base64')}";\n`,
    );

    // 生成预缓存清单并注入 SW（multi 模式专用）
    const precacheManifest = [
      './index.html',
      './app.js',
      './worker.js',
      './websurf_viewer_wasm_bg.wasm',
      './wasm-embedded.js',
      './styles.css',
      './coi-serviceworker.js',
    ].filter((f) => existsSync(join(dist, f.slice(2)))); // 仅存在的文件（去掉 './' 前缀）

    const swTemplate = await readFile(join(viewerRoot, 'web', 'coi-serviceworker.js'), 'utf8');
    // 缓存名按「预缓存内容哈希」派生：内容变 → SW 文件字节变 → 浏览器触发 install → 缓存刷新；
    // 固定缓存名会导致 SW 字节不变、缓存永不更新，部署后用户长期拿到旧 app.js。
    const cacheHash = createHash('sha256');
    cacheHash.update(JSON.stringify(precacheManifest));
    for (const entry of precacheManifest) {
      const abs = join(dist, entry.slice(2));
      if (existsSync(abs)) { cacheHash.update(entry); cacheHash.update(await readFile(abs)); }
    }
    const cacheName = 'websurf-coi-' + cacheHash.digest('hex').slice(0, 12);
    const swWithManifest = swTemplate
      .replace(
        'const PRECACHE_MANIFEST =\n  typeof __PRECACHE_MANIFEST__ === "object" && __PRECACHE_MANIFEST__ ? __PRECACHE_MANIFEST__ : [];',
        `const PRECACHE_MANIFEST = ${JSON.stringify(precacheManifest)};`
      )
      .replace(
        'const CACHE_NAME = typeof __CACHE_NAME__ === "string" ? __CACHE_NAME__ : "websurf-coi-dev";',
        `const CACHE_NAME = ${JSON.stringify(cacheName)};`
      );
    if (
      swWithManifest.includes('typeof __PRECACHE_MANIFEST__') ||
      swWithManifest.includes('typeof __CACHE_NAME__')
    ) {
      throw new Error(
        '[build-dist] SW 占位符未被替换：web/coi-serviceworker.js 的声明行与构建脚本不一致'
      );
    }
    await writeFile(join(dist, 'coi-serviceworker.js'), swWithManifest);
    console.log(`[multi] 注入 SW 预缓存清单: ${precacheManifest.length} 个资源`);

    await cleanStale(dist, KEEP_MULTI);
    return;
  }

  // ── single：app 打成 IIFE，WASM/WORKER 内嵌，classic script —— file:// 双击可用 ──
  console.log('[5/5] 编码 WASM → base64 …');
  const wasmBytes = await readFile(join(viewerRoot, 'web/websurf_viewer_wasm_bg.wasm'));
  const wasmB64 = wasmBytes.toString('base64');

  console.log('[5/5] 打包录像解析 Worker（IIFE，Blob URL 用）…');
  const workerCode = await bundleIife({
    build,
    entry: WORKER_SRC,
    options: { logLevel: 'warning' },
  });

  console.log('[5/5] 打包 app（IIFE + 内嵌）…');
  const appCode = await bundleIife({
    build,
    entry: APP_SRC,
    options: { logLevel: 'warning' },
  });

  console.log('[5/5] 写入 dist/（classic index.html + 内嵌 app.js + styles.css）…');
  await writeEmbeddedPreamble({
    distDir: dist,
    appCode,
    headerComment: HEADER,
    wasmB64,
    workerJs: workerCode,
  });
  const rewritten = await rewriteIndexToClassicScript({
    webIndex: join(viewerRoot, 'web/index.html'),
    distIndex: join(dist, 'index.html'),
  });
  if (!rewritten) {
    console.warn('[WARN] web/index.html 未命中 module script 特征串，dist/index.html 可能仍是 module script。');
  }
  await copyFile(join(viewerRoot, 'web/styles.css'), join(dist, 'styles.css'));

  await cleanStale(dist, KEEP_SINGLE);
}

rebuildDist()
  .then(async () => {
    console.log(`[${multi ? 'multi（Pages 部署）' : 'single（file:// 双击）'}] 打包完成 → ${dist}`);
    console.log((await printTree(dist)).join('\n'));
  })
  .catch((err) => {
    console.error(`[ERROR] dist build failed: ${err?.message ?? err}`);
    console.error('[HINT] See the message above, fix the input or toolchain, then retry.');
    process.exit(1);
  });
