@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-game - Play
cd /d "%~dp0"

set PORT=8091
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

REM ---- [1/4] deps -> [2/4] wasm unless pkg\websurf_wasm_bg.wasm exists -> [3/4] ts -> [4/4] dist ----
echo [1/4] Ensuring Node build dependencies (auto npm install if missing)...
call "%~dp0..\..\src\scripts\ensure-node-deps.cmd" nopause
if errorlevel 1 (
  echo [ERROR] npm install failed.
  echo [HINT] Check network connectivity and package-lock.json, then retry.
  pause
  exit /b 1
)

if exist "pkg\websurf_wasm_bg.wasm" goto :wasm_done
echo [2/4] WASM missing - building (release, slow on first run; Rust toolchain required)...
call npm run build:wasm
if errorlevel 1 (
  echo [ERROR] WASM build failed.
  echo [HINT] Install Rust and wasm-pack ^(rustup + cargo install wasm-pack^), then retry.
  pause
  exit /b 1
)
:wasm_done
echo [2/4] WASM ready.

echo [3/4] Building TypeScript (worker.js + app.js)...
call npm run build:ts
if errorlevel 1 (
  echo [ERROR] TypeScript build failed.
  echo [HINT] Fix the tsc/esbuild errors printed above, then retry.
  pause
  exit /b 1
)

echo [4/4] Building dist package (single, embedded WASM - always fresh)...
call node "%~dp0scripts\build-dist.mjs"
if errorlevel 1 (
  echo [ERROR] dist build failed.
  echo [HINT] See the build-dist.mjs errors printed above, then retry.
  pause
  exit /b 1
)

netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto :start_server
echo [SKIP] Port %PORT% is already in use - opening the browser to the running server.
start "" http://localhost:%PORT%/dist/index.html
exit /b 0

:start_server
echo ============================================================
echo   WebSurf-game - Local Play (dist)
echo   Server:  http://localhost:%PORT%/
echo   App:     http://localhost:%PORT%/dist/index.html
echo   Close this window to stop the server.
echo ============================================================

REM A detached "cmd /c" opens the page after timeout /t 1; the python call below blocks.
start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/dist/index.html"
REM src/serve.py takes its serve root from argv[2]; the literal here is "%~dp0." (this app
REM root written with a trailing dot), and serve.py os.chdir()s to it before serving.
python "%~dp0..\..\src\serve.py" %PORT% "%~dp0."
