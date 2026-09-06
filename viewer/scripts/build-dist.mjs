/**
 * viewer 打包：单文件（single）产物 → viewer/dist/（唯一产物目录）。
 *
 * ── single（默认/唯一，本地双击 file:// 可用，也可 HTTP 服务/部署）→ viewer/dist/ ──
 *   index.html — classic `<script>`（file:// 下 module script 被浏览器 CORS 拦截）
 *   app.js     — IIFE：内嵌 WASM(base64) + 录像解析 Worker 代码（Blob URL 启动）
 *   styles.css
 *   assets/maps/*.replay.json/.rule.json（参考资源；file:// 无法 fetch，载入走面板文件选择）
 *   serve.py   — 静态服务器（python serve.py [port]）
 *   play.cmd / play.sh — 双击启动：起服务器 + 延时 1s 自动打开浏览器（python 缺失 → 中文提示 + npx serve 备选）
 *   README.md / .nojekyll
 *
 * dist-multi / --multi / --bsp 分支已移除（2026-09：单一 dist 策略）。
 *
 * 用法（在 viewer/ 目录）：
 *   node scripts/build-dist.mjs    # single → dist/
 */

import { mkdir, rm, copyFile, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const viewerRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(viewerRoot, '..');
const dist = join(viewerRoot, 'dist');

const APP_SRC = join(viewerRoot, 'src/app.ts');
const WORKER_SRC = join(viewerRoot, 'src/worker/parse-worker.ts');

const SERVE_PY = `"""WebSurf-viewer 静态服务器（本地预览；部署时任意静态托管均可）。

用法：python serve.py [port]   # 默认 8090，服务目录 = 本脚本所在目录
"""
import http.server
import socketserver
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
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


DEMO = (
    "/index.html?replay=assets/maps/surf_null_4.replay.json"
    "&rule=assets/maps/surf_null_4.rule.json"
)


class Server(socketserver.TCPServer):
    # SO_REUSEADDR：关窗后立刻重开不会被 TIME_WAIT 卡死（"通常每个套接字地址
    # 只允许使用一次"）；占用中的活动端口仍会报错，由下方 OSError 提示兜底
    allow_reuse_address = True


try:
    server = Server(("", PORT), Handler)
except OSError as e:
    print(f"[错误] 端口 {PORT} 无法监听：{e}")
    print(f"[提示] 端口可能已被占用——换一个端口：python serve.py {PORT + 1}")
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
rem usage: play.cmd [port] (default 8090; close this window to stop, Ctrl+C also works)
setlocal EnableExtensions
cd /d "%~dp0"

set PORT=8090
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
echo   demo    http://localhost:%PORT%/index.html?replay=assets/maps/surf_null_4.replay.json^&rule=assets/maps/surf_null_4.rule.json
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
# 用法：./play.sh [port]（默认 8090；关闭本窗口即停止服务，Ctrl+C 亦可）
set -e
cd "$(dirname "$0")"
PORT="\${1:-8090}"

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
  echo "[提示] 未找到 python —— 请先安装 Python 3（https://www.python.org/downloads/）。"
  if command -v npx >/dev/null 2>&1; then
    echo "[提示] 使用 Node 备选：npx serve（python 缺失，自动安装并启动）。"
    echo "[提示] 正在启动：npx --yes serve -l $PORT ."
    open_browser
    exec npx --yes serve -l "$PORT" .
  fi
  echo "[提示] 也未找到 npx —— 需要 Node.js（https://nodejs.org/）。"
  echo "[提示] 手动备选：安装 Python 3 或 Node.js 后重试；或装好任意静态服务器后运行  npx serve -l $PORT ."
  exit 1
fi

echo "============================================================"
echo " WebSurf-viewer 本地预览（关闭本窗口即停止服务；Ctrl+C 亦可）"
echo "  普通页  http://localhost:$PORT/index.html"
echo "  示例    http://localhost:$PORT/index.html?replay=assets/maps/surf_null_4.replay.json&rule=assets/maps/surf_null_4.rule.json"
echo "============================================================"
open_browser
exec "$PY" serve.py "$PORT"
`;

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'assets', 'maps'), { recursive: true });

// ── 公共尾随产物 ────────────────────────────────────────────────────
await writeFile(join(dist, '.nojekyll'), '');
await copyFile(join(viewerRoot, 'scripts/dist-README.md'), join(dist, 'README.md'));
await writeFile(join(dist, 'serve.py'), SERVE_PY);
// .cmd 必须 CRLF：LF-only 批处理会触发 cmd.exe 解析错乱（行被撕开执行）
await writeFile(join(dist, 'play.cmd'), PLAY_CMD.replace(/\n/g, '\r\n'));
await writeFile(join(dist, 'play.sh'), PLAY_SH);

// ── single：app 打成 IIFE，WASM/WORKER 内嵌，classic script —— file:// 双击可用 ──
const iife = {
  bundle: true,
  target: 'es2022',
  format: 'iife',
  minify: true,
  sourcemap: false,
  legalComments: 'eof',
  logLevel: 'warning',
  write: false,
  // IIFE 无 import.meta；内嵌构建不走 fetch 路径（bsp/importer 已按内嵌分支短路）
  define: { 'import.meta.url': JSON.stringify('about:blank') },
};

console.log('[1/3] 编码 WASM → base64 …');
const wasmBytes = await readFile(join(viewerRoot, 'websurf_viewer_wasm_bg.wasm'));
const wasmB64 = wasmBytes.toString('base64');

console.log('[2/3] 打包录像解析 Worker（IIFE，Blob URL 用）…');
const workerResult = await build({ ...iife, entryPoints: [WORKER_SRC] });
const workerCode = workerResult.outputFiles[0].text;

console.log('[3/3] 打包 app（IIFE + 内嵌）…');
const appResult = await build({ ...iife, entryPoints: [APP_SRC] });
const appCode = appResult.outputFiles[0].text;

const preamble =
  `/* WebSurf-viewer single-file build — auto-generated, do not edit */\n` +
  `globalThis.__VBSP_WASM_B64__=${JSON.stringify(wasmB64)};\n` +
  `globalThis.__VBSP_WORKER_JS__=${JSON.stringify(workerCode)};\n`;
await writeFile(join(dist, 'app.js'), preamble + appCode);

// classic script：file:// 下 module script 被 CORS 拦截
const html = await readFile(join(viewerRoot, 'index.html'), 'utf8');
const distHtml = html.replace(
  '<script type="module" src="./app.js"></script>',
  '<script src="./app.js"></script>',
);
await writeFile(join(dist, 'index.html'), distHtml);
await copyFile(join(viewerRoot, 'styles.css'), join(dist, 'styles.css'));

// 参考资源（file:// 不能 fetch，载入走面板「选择 JSON 录像」）。
// 入库白名单：maps/surf_null_4.*.json（见根 .gitignore）；缺失时警告跳过，不阻断构建。
for (const name of ['surf_null_4.replay.json', 'surf_null_4.rule.json']) {
  const src = join(repoRoot, 'maps', name);
  if (existsSync(src)) {
    await copyFile(src, join(dist, 'assets/maps', name));
  } else {
    console.warn(`[warn] 示例资产缺失，跳过: maps/${name}（dist 示例深链将不可用）`);
  }
}

async function tree(dir) {
  const out = [];
  for (const name of (await readdir(dir)).sort()) {
    const p = join(dir, name);
    const st = await stat(p);
    if (st.isDirectory()) out.push(`  ${name}/` + (await tree(p)).join(''));
    else out.push(`  ${name}  ${(st.size / 1024).toFixed(0)} KB`);
  }
  return out;
}
console.log(`\nsingle（本地 file:// 双击 + HTTP 均可）打包完成 → ${dist}`);
console.log((await tree(dist)).join('\n'));