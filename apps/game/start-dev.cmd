@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-game - Dev Server
cd /d "%~dp0"

set PORT=8090
if not "%~1"=="" set PORT=%~1

REM ---- toolchain gate: "where python" runs before src/serve.py is started ----
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found.
  echo [HINT] Install Python 3 and make sure "python" is on PATH.
  pause
  exit /b 1
)

REM ---- src/scripts/cargo-env.cmd: CARGO_HOME / WASM_PACK_CACHE / TMP + TEMP -> repo root ----
call "%~dp0..\..\src\scripts\cargo-env.cmd"

REM ---- serve root = this app root ("%~dp0."); entry page /web/index.html loads ----
REM ---- web\websurf_wasm_bg.wasm, the copy npm run build:wasm makes from pkg\. ----
REM Gate: node src/scripts/wasm-stale-check.mjs (pkg\websurf_wasm_bg.wasm vs newest .rs/.toml
REM under <repo>/src and crates/); exit 0 -> goto :wasm_done, else (or no node) rebuild.
where node >nul 2>nul
if not errorlevel 1 (
  node "%~dp0..\..\src\scripts\wasm-stale-check.mjs" "%~dp0pkg\websurf_wasm_bg.wasm" "%~dp0..\..\src" "%~dp0crates"
  if not errorlevel 1 goto :wasm_done
)
echo [1/3] Building WASM (release)...
call npm run build:wasm
if errorlevel 1 (
  echo [ERROR] WASM build failed.
  echo [HINT] Install Rust and wasm-pack ^(rustup + cargo install wasm-pack^), then retry.
  pause
  exit /b 1
)
:wasm_done
echo [1/3] WASM ready.

echo [2/3] Ensuring Node build dependencies (auto npm install if missing)...
call "%~dp0..\..\src\scripts\ensure-node-deps.cmd" nopause
if errorlevel 1 (
  echo [ERROR] npm install failed.
  echo [HINT] Check network connectivity and package-lock.json, then retry.
  pause
  exit /b 1
)
echo [2/3] Building TypeScript (worker.js + app.js)...
call npm run build:ts
if errorlevel 1 (
  echo [ERROR] TypeScript build failed.
  echo [HINT] Fix the tsc/esbuild errors printed above, then retry.
  pause
  exit /b 1
)

echo [3/3] Starting HTTP server...
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto :start_server
echo [SKIP] Port %PORT% is already in use - opening the browser to the running server.
start "" http://localhost:%PORT%/web/index.html
exit /b 0

:start_server
echo ============================================================
echo   WebSurf-game - Dev Server (web/)
echo   Server:  http://localhost:%PORT%/
echo   App:     http://localhost:%PORT%/web/index.html
echo   Close this window to stop the server.
echo ============================================================

REM A detached "cmd /c" opens the page after timeout /t 1; the python call below blocks.
start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/web/index.html"
REM src/serve.py takes its serve root from argv[2]; the literal here is "%~dp0." (this app
REM root written with a trailing dot), and serve.py os.chdir()s to it before serving.
python "%~dp0..\..\src\serve.py" %PORT% "%~dp0."
