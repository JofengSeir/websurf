@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-game - Dev
cd /d "%~dp0"

set PORT=8090
if not "%~1"=="" set PORT=%~1

echo ============================================================
echo   WebSurf-game - dev
echo   全链条：工具链自检 -^> 依赖 -^> WASM 重编译 -^> TS 重编译
echo          -^> 测试门 -^> 起 dev 服务并打开浏览器
echo   Page:    http://localhost:%PORT%/web/index.html
echo ============================================================

echo [1/5] Checking toolchain...
set "TOOLCHAIN_OK=1"
where npm >nul 2>nul
if errorlevel 1 (echo   [!] npm not found. Install Node.js and add it to PATH.& set "TOOLCHAIN_OK=0") else (echo   npm: OK)
where node >nul 2>nul
if errorlevel 1 (echo   [!] node not found. Install Node.js and add it to PATH.& set "TOOLCHAIN_OK=0") else (echo   node: OK)
where python >nul 2>nul
if errorlevel 1 (echo   [!] python not found. Install Python 3 and add it to PATH.& set "TOOLCHAIN_OK=0") else (echo   python: OK)
where wasm-pack >nul 2>nul
if errorlevel 1 (echo   [!] wasm-pack not found. Install with: cargo install wasm-pack& set "TOOLCHAIN_OK=0") else (echo   wasm-pack: OK)
if not "%TOOLCHAIN_OK%"=="1" (
  echo [ERROR] Toolchain incomplete.
  echo [HINT] Install Node.js ^(npm + node^), Python 3 and wasm-pack, then retry.
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

echo [3/5] Rebuilding WASM (release)...
call npm run build:wasm
if errorlevel 1 (
  echo [ERROR] WASM build failed.
  echo [HINT] Install Rust and wasm-pack ^(rustup + cargo install wasm-pack^), then retry.
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

echo [5/5] Running test gates...
for %%T in (test:phys test:seed-smoke test:surf-crouch) do (
  echo   - npm run %%T
  call npm run %%T
  if errorlevel 1 (
    echo [ERROR] Gate %%T failed.
    echo [HINT] Fix the failure printed above, then retry.
    pause
    exit /b 1
  )
)
echo [5/5] All test gates passed.

netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto :start_server
echo ============================================================
echo   WebSurf-game - Dev Server (web/)
echo   Server:  http://localhost:%PORT%/
echo   App:     http://localhost:%PORT%/web/index.html
echo ============================================================

REM A detached "cmd /c" opens the page after timeout /t 1. The server itself runs in
REM its OWN minimized window (title below, visible on the taskbar): closing this build
REM window never kills the server, and the server can be stopped by closing that
REM window (or Ctrl+C inside it) or by running stop.cmd in this folder.
start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/web/index.html"
REM src/serve.py takes its serve root from argv[2]; the literal here is "%~dp0." (this app
REM root written with a trailing dot), and serve.py os.chdir()s to it before serving.
start "WebSurf-game dev server :%PORT%" /min cmd /c python "%~dp0..\..\src\serve.py" %PORT% "%~dp0."
echo [OK] Server launched in its own minimized window: "WebSurf-game dev server :%PORT%".
echo      Stop it by closing that window or by running stop.cmd here.
exit /b 0
