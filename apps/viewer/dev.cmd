@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-viewer - Dev
cd /d "%~dp0"

set PORT=8100
if not "%~1"=="" set PORT=%~1

echo ============================================================
echo   WebSurf-viewer - dev
echo   Full chain: toolchain -^> recycle stale server -^> deps -^> WASM rebuild
echo          -^> TS rebuild -^> API check -^> start server -^> verify -^> open browser
echo   Page:    http://localhost:%PORT%/web/index.html
echo ============================================================

echo [1/5] Checking toolchain...
set "TOOLCHAIN_OK=1"
where npm >nul 2>nul
if errorlevel 1 (echo   [!] npm not found. Install Node.js and add it to PATH.& set "TOOLCHAIN_OK=0") else (echo   npm: OK)
where node >nul 2>nul
if errorlevel 1 (echo   [!] node not found. Install Node.js and add it to PATH.& set "TOOLCHAIN_OK=0") else (echo   node: OK)
echo   static server: Node (no system Python required)
where wasm-pack >nul 2>nul
if errorlevel 1 (echo   [!] wasm-pack not found. Install with: cargo install wasm-pack& set "TOOLCHAIN_OK=0") else (echo   wasm-pack: OK)
if not "%TOOLCHAIN_OK%"=="1" (
  echo [ERROR] Toolchain incomplete.
  echo [HINT] Install Node.js ^(npm + node^) and wasm-pack, then retry.
  pause
  exit /b 1
)

echo [1/5] Recycling stale WebSurf server on port %PORT%...
call node "%~dp0..\..\src\scripts\dev-port.mjs" %PORT%
if errorlevel 1 (
  echo [ERROR] Port %PORT% is unavailable - held by a non-WebSurf process or recycle failed.
  echo [HINT] Use another port:  dev.cmd ^<port^>
  pause
  exit /b 1
)

REM ---- src/scripts/cargo-env.cmd: CARGO_HOME / WASM_PACK_CACHE / TMP + TEMP -> repo root ----
call "%~dp0..\..\src\scripts\cargo-env.cmd"

echo [2/5] Ensuring Node build dependencies (auto npm install if missing)...
call "%~dp0..\..\src\scripts\ensure-node-deps.cmd" nopause
if errorlevel 1 (
  echo [ERROR] npm install failed.
  echo [HINT] Check network connectivity and package-lock.json, then retry.
  pause
  exit /b 1
)
echo [2/5] Node dependencies ready.
echo [2/5] Syncing shared web assets (src/materials + src/web -^> web/)...
call node "%~dp0..\..\src\scripts\sync-web-assets.mjs"
if errorlevel 1 (
  echo [ERROR] Shared web asset sync failed.
  pause
  exit /b 1
)

echo [3/5] Rebuilding WASM (release)...
call npm run build:wasm
if errorlevel 1 (
  echo [WARN] WASM build failed - retrying once ^(transient file locks are common^)...
  timeout /t 2 /nobreak >nul 2>&1
  call npm run build:wasm
)
if errorlevel 1 (
  echo [ERROR] WASM build failed twice.
  echo [HINT] If the log says "failed to write ... pkg\websurf_wasm_bg.wasm" ^(os error 5 / access denied^):
  echo [HINT]   a file lock or a second build window holds it - close other dev/build windows, then retry.
  echo [HINT] Otherwise install Rust + wasm-pack ^(rustup + cargo install wasm-pack^), then retry.
  pause
  exit /b 1
)
echo [3/5] WASM ready.

echo [4/5] Rebuilding TypeScript (typecheck + worker.js + app.js)...
call npm run build:ts
if errorlevel 1 (
  echo [ERROR] TypeScript build failed.
  echo [HINT] Fix the tsc/esbuild errors printed above, then retry.
  pause
  exit /b 1
)
echo [4/5] TypeScript ready.

echo [5/5] Checking WASM API contract...
call npm run check:api
if errorlevel 1 (
  echo [ERROR] WASM API contract check failed.
  echo [HINT] Run npm run check:api, fix src/wasm.d.ts vs crates/wasm, then retry.
  pause
  exit /b 1
)
echo [5/5] WASM API contract OK.

:start_server
echo ============================================================
echo   WebSurf-viewer - Dev Server (web/)
echo   Server:  http://localhost:%PORT%/
echo   App:     http://localhost:%PORT%/web/index.html
echo ============================================================

REM The server runs in its OWN minimized window (title below, on the taskbar).
REM Closing this build window does NOT kill it; stop it by closing that window,
REM pressing Ctrl+C inside it, or running stop.cmd in this folder.
REM serve.mjs is the Node static server: NO system Python needed. Windows
REM Store python aliases pass toolchain probes but cannot actually run.
REM argv[2] = "%~dp0." (this app root) => /web/index.html is served.
start "WebSurf-viewer dev server :%PORT%" /min cmd /k node "%~dp0..\..\src\scripts\serve.mjs" %PORT% "%~dp0."

REM Open the browser ONLY after the server answers 200. The old fixed 1s delay
REM opened a blank "connection failed" page whenever the server failed to bind.
call node "%~dp0..\..\src\scripts\wait-for-server.mjs" %PORT%
if errorlevel 1 (
  echo [ERROR] Server did not become ready on port %PORT%.
  echo [HINT] Check the "WebSurf-viewer dev server :%PORT%" window for the bind error.
  echo [HINT] Or use another port:  dev.cmd ^<port^>
  pause
  exit /b 1
)
start "" http://localhost:%PORT%/web/index.html
echo [OK] Server is live at http://localhost:%PORT%/web/index.html
echo      Stop it by closing the dev server window, or run stop.cmd here.
exit /b 0
