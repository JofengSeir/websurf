/**
 * viewer 打包：把 `web/` 下的产物与源码切片装配进 `viewer/dist/`（本脚本唯一的输出目录）。
 *
 * 两种模式共用同一批公共产物，差别只在 app/worker/wasm 的形态：
 * - **single（默认）**：app 打成 IIFE，WASM(base64) 与录像解析 Worker 代码一并内嵌进 app.js，
 *   `index.html` 改写成 classic `<script>`（file:// 下 module script 会被浏览器拦），供本地双击；
 * - **multi（`--multi`）**：复制 `web/` 的 ESM 产物与外置 `websurf_viewer_wasm_bg.wasm`，另生成
 *   `wasm-embedded.js`（fetch 失败时的内嵌回退副本），并把预缓存清单注入
 *   `web/coi-serviceworker.js` 后写进 dist，供 Pages 部署。
 *
 * 公共产物（两种模式都写）：`.nojekyll`、`README.md`（内容取自 `scripts/dist-README.md`）、
 * `serve.py`（内联生成）、`play.cmd` / `play.sh`（内联生成：起静态服务 + 延时 1s 开浏览器），
 * 以及存在时的 `assets/maps/surf_null_4.replay` 示例录像。
 * single 侧额外：`index.html` / `app.js` / `styles.css`；
 * multi 侧额外：`index.html` / `app.js` / `worker.js` / `styles.css` /
 * `websurf_viewer_wasm_bg.wasm` / `wasm-embedded.js` / `coi-serviceworker.js`。
 *
 * 重建策略：先 `cleanDist` 清空 dist，写完再用 `cleanStale` 删掉不在保留清单里的残留，
 * 避免上一次另一种模式的产物留在目录里。打包内核（esbuild 注入、`__VBSP_*` 拼装、index 改写）
 * 在 `src/scripts/lib/dist-pack.mjs`。
 *
 * 用法（在 `apps/viewer/` 下）：
 *   node scripts/build-dist.mjs            # single → dist/
 *   node scripts/build-dist.mjs --multi    # multi → dist/
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
 * 契约：`python` 优先；缺失时打印提示并改用 `npx --yes serve -l <port> .`；两者都缺则打印指引 +
 * `pause` 后退出；打印普通页与示例深链两个地址；用 `start` 起一个延时 1s 的异步子进程开浏览器，
 * 前台交给 `serve.py`（端口取首个参数，默认 8101）。
 * ⚠️ 全文纯 ASCII，且写盘时统一转 CRLF：cmd.exe 解析非 ASCII 或 LF-only 的批处理时会把行撕开执行。
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
 * `python3` → `python` → `npx --yes serve -l <port> .` 依次回退；两者都缺时打印中文指引并 `exit 1`。
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
  // 全量重建：先清空 dist，产物只由本轮写入（不留上一次的残留）
  await cleanDist(dist);
  await mkdir(join(dist, 'assets', 'maps'), { recursive: true });

  // ── 两种模式共用的产物 ──────────────────────────────────────────────
  await writeFile(join(dist, '.nojekyll'), '');
  await copyFile(join(viewerRoot, 'scripts/dist-README.md'), join(dist, 'README.md'));
  await writeFile(join(dist, 'serve.py'), SERVE_PY);
  // .cmd 必须 CRLF：LF-only 的批处理会让 cmd.exe 解析错乱（行被撕开执行）
  await writeFile(join(dist, 'play.cmd'), PLAY_CMD.replace(/\n/g, '\r\n'));
  await writeFile(join(dist, 'play.sh'), PLAY_SH);

  // ── 示例录像（深链演示用；本地夹具缺失时告警并跳过）──────────────
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
    // ── multi：web/ 的 ESM 产物 + 外置 wasm + 内嵌回退副本 ────
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

    // 预缓存清单与「内容哈希派生的缓存名」一起注入 SW 模板（multi 专用）
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
    // 缓存名由「清单 + 各文件内容」的 sha256 派生：内容变 → SW 字节变 → 浏览器触发 install → 缓存刷新；
    // 固定缓存名会让 SW 字节不变，部署后长期命中旧缓存。
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

  // ── single：app 打成 IIFE（WASM 与 Worker 内嵌），index.html 改写成 classic script ──
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
