@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-viewer - Play
cd /d "%~dp0"

set PORT=8101
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

REM ---- bootstrap: deps -> wasm -> ts -> dist (auto when missing) ----
echo [1/4] Ensuring Node build dependencies (auto npm install if missing)...
call "%~dp0..\..\src\scripts\ensure-node-deps.cmd" nopause
if errorlevel 1 (
  echo [ERROR] npm install failed.
  echo [HINT] Check network connectivity and package-lock.json, then retry.
  pause
  exit /b 1
)

if exist "pkg\websurf_viewer_wasm_bg.wasm" goto :wasm_done
echo [2/4] WASM missing - building (release, slow on first run; Rust toolchain required)...
call npm run build:wasm
if errorlevel 1 (
  echo [ERROR] WASM build failed.
  echo [HINT] Install Rust and wasm-pack (rustup + cargo install wasm-pack), then retry.
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
start "" http://localhost:%PORT%/index.html
exit /b 0

:start_server
echo ============================================================
echo   WebSurf-viewer - Local Play (dist)
echo   Server:  http://localhost:%PORT%/
echo   App:     http://localhost:%PORT%/index.html
echo   Close this window to stop the server.
echo ============================================================

REM viewer delivery form (framework-launch-structure.md 8.2): dist/ ships its own
REM launcher (dist\play.cmd / dist\play.sh); the app-root entry reuses it as the
call "dist\play.cmd" %PORT%
