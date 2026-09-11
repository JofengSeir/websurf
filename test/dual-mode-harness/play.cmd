@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-test - Play
cd /d "%~dp0"

set PORT=8110

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

REM ---- bootstrap: deps -> wasm -> ts (auto when missing) ----
echo [1/3] Ensuring Node build dependencies (auto npm install if missing)...
call "%~dp0..\..\src\scripts\ensure-node-deps.cmd" nopause
if errorlevel 1 (
  echo [ERROR] npm install failed.
  echo [HINT] Check network connectivity and package-lock.json, then retry.
  pause
  exit /b 1
)

if exist "pkg\websurf_test_wasm.js" goto :wasm_done
echo [2/3] WASM missing - building (release, slow on first run; Rust toolchain required)...
REM Shared ability (framework-launch-structure.md 8.2): ensure wasm-bindgen-cli
REM v0.2.128 as a [2/3] sub-step, reported with [INFO] lines only.
echo [INFO] Ensuring wasm-bindgen-cli v0.2.128 is present (auto-install if missing)...
call "%~dp0..\..\src\scripts\install-wasm-bindgen.cmd" nopause
if errorlevel 1 (
  echo [ERROR] wasm-bindgen-cli setup failed.
  echo [HINT] Run the shared src\scripts\install-wasm-bindgen.cmd manually, then retry.
  pause
  exit /b 1
)
echo [INFO] wasm-bindgen-cli ready.
call npm run build:wasm
if errorlevel 1 (
  echo [ERROR] WASM build failed.
  echo [HINT] Install Rust and wasm-pack ^(rustup + cargo install wasm-pack^), then retry.
  pause
  exit /b 1
)
:wasm_done
echo [2/3] WASM ready.

echo [3/3] Building TypeScript (app.js + worker-a.js + worker-b.js)...
call npm run build:ts
if errorlevel 1 (
  echo [ERROR] TypeScript build failed.
  echo [HINT] Fix the tsc/esbuild errors printed above, then retry.
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
echo   WebSurf-test - Local Play (root)
echo   Server:  http://localhost:%PORT%/
echo   App:     http://localhost:%PORT%/index.html
echo   Close this window to stop the server.
echo ============================================================
echo [INFO] Keep this window open while playing; closing it ^(or Ctrl+C^) stops the server.

REM Open the browser after 1s (async) so the server is already listening.
start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/index.html"
REM Note: root arg uses "%~dp0." (trailing dot): "%~dp0" ends with a backslash,
REM which CommandLineToArgvW parses as an escaped quote (root gets a trailing quote, os.chdir fails).
python "%~dp0..\..\src\serve.py" %PORT% "%~dp0."
if errorlevel 1 (
  echo [ERROR] Server exited with an error ^(port %PORT% may already be in use^).
  echo [HINT] Close the process holding port %PORT%, then run play.cmd again.
  pause
  exit /b 1
)

echo Server stopped.
pause
