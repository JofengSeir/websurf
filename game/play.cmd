@echo off
setlocal EnableExtensions
title WebSurf-game - Play
cd /d "%~dp0"

set PORT=8137

REM ---- toolchain check ----
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Please install Python 3 first.
  pause
  exit /b 1
)

REM ---- shared cargo/wasm-pack env (root .cargo-home / .wasm-pack-cache / .tmp) ----
call "%~dp0..\src\scripts\cargo-env.cmd"

REM ---- bootstrap: deps -> wasm -> ts -> dist (auto when missing) ----
REM Fresh-clone friendly: first click installs deps, builds WASM and dist
REM (a few minutes), later clicks reuse pkg/ and only rebuild TS + dist.

echo [1/4] Ensuring Node build dependencies (auto npm install if missing)...
call "%~dp0scripts\ensure-node-deps.cmd" nopause
if errorlevel 1 (
  echo [ERROR] npm install failed. Check network connectivity and package-lock.json.
  pause
  exit /b 1
)

if exist "pkg\websurf_wasm_bg.wasm" goto :wasm_done
echo [2/4] WASM missing - building (release, slow on first run; Rust toolchain required)...
call npm run build:wasm
if errorlevel 1 (
  echo [ERROR] WASM build failed - check Rust toolchain (rustup + wasm-pack^).
  pause
  exit /b 1
)
:wasm_done
echo [2/4] WASM ready.

echo [3/4] Building TypeScript (worker.js + app.js)...
call npm run build:ts
if errorlevel 1 (
  echo [ERROR] TypeScript build failed.
  pause
  exit /b 1
)

echo [4/4] Building dist package (single, embedded WASM - always fresh)...
call node scripts\build-dist.mjs
if errorlevel 1 (
  echo [ERROR] dist build failed - see errors above.
  pause
  exit /b 1
)

REM ---- start server (foreground) + open browser (delayed 1s) ----
echo ============================================
echo  WebSurf-game  Local Play
echo  Server:  http://localhost:%PORT%/
echo  App:     http://localhost:%PORT%/dist/index.html
echo  Close this window to stop the server.
echo ============================================

start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/dist/index.html"
REM Note: root arg uses "%~dp0." (trailing dot): "%~dp0" ends with a backslash,
REM which CommandLineToArgvW parses as an escaped quote (root gets a trailing quote, os.chdir fails).
python "%~dp0..\src\serve.py" %PORT% "%~dp0."
