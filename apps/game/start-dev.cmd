@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-game - Dev Server
cd /d "%~dp0"

set PORT=8090
if not "%~1"=="" set PORT=%~1

REM ---- toolchain: python is required by the local server ----
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found.
  echo [HINT] Install Python 3 and make sure "python" is on PATH.
  pause
  exit /b 1
)

REM ---- shared cargo/wasm-pack env (root .cargo-home / .wasm-pack-cache / .tmp) ----
call "%~dp0..\..\src\scripts\cargo-env.cmd"

REM ---- dev serve target: web/ (<wasm> copy produced by build:wasm) ----
if exist "pkg\websurf_wasm_bg.wasm" goto :wasm_done
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

REM Open the browser after 1s (async) so the server is already listening.
start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/web/index.html"
REM Note: root arg uses "%~dp0." (trailing dot): "%~dp0" ends with a backslash,
REM which CommandLineToArgvW parses as an escaped quote (root gets a trailing quote, os.chdir fails).
python "%~dp0..\..\src\serve.py" %PORT% "%~dp0."
