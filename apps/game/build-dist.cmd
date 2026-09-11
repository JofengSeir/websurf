@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-game - Build dist
cd /d "%~dp0"

set "DIST_MODE=single"
if /i "%~1"=="multi" set "DIST_MODE=multi"
if /i "%~1"=="" goto :mode_ok
if /i "%~1"=="single" goto :mode_ok
if /i "%~1"=="multi" goto :mode_ok
echo [ERROR] Unsupported argument: %~1
echo [HINT] Usage: build-dist.cmd [single^|multi]
pause
exit /b 1
:mode_ok

echo [0/5] Checking toolchain...
set "TOOLCHAIN_OK=1"
where npm >nul 2>nul
if errorlevel 1 (echo   [!] npm not found. Install Node.js and add it to PATH.& set "TOOLCHAIN_OK=0") else (echo   npm: OK)
where wasm-pack >nul 2>nul
if errorlevel 1 (echo   [!] wasm-pack not found. Install with: cargo install wasm-pack& set "TOOLCHAIN_OK=0") else (echo   wasm-pack: OK)
where node >nul 2>nul
if errorlevel 1 (echo   [!] node not found. Install Node.js and add it to PATH.& set "TOOLCHAIN_OK=0") else (echo   node: OK)
if not "%TOOLCHAIN_OK%"=="1" (
  echo [ERROR] Toolchain incomplete.
  echo [HINT] Install Node.js ^(npm + node^) and wasm-pack, then retry.
  pause
  exit /b 1
)

call "%~dp0..\..\src\scripts\cargo-env.cmd"

echo [1/5] Ensuring Node build dependencies (auto npm install if missing)...
call "%~dp0..\..\src\scripts\ensure-node-deps.cmd" nopause
if errorlevel 1 (
  echo [ERROR] npm install failed.
  echo [HINT] Check network connectivity and package-lock.json, then retry.
  pause
  exit /b 1
)
echo [1/5] Node dependencies ready.

if exist "pkg\websurf_wasm_bg.wasm" goto :wasm_done
echo [2/5] Building WASM (release)...
call npm run build:wasm
if errorlevel 1 (
  echo [ERROR] WASM build failed.
  echo [HINT] Delete crates\wasm\target\wasm32-unknown-unknown and retry ^(antivirus locks are the usual cause^).
  pause
  exit /b 1
)
:wasm_done
echo [2/5] WASM ready (release).

echo [3/5] Checking WASM API contract...
call npm run check:api
if errorlevel 1 (
  echo [ERROR] WASM API contract check failed.
  echo [HINT] Run npm run check:api, fix src/wasm.d.ts vs crates/wasm, then retry.
  pause
  exit /b 1
)

echo [4/5] Building TypeScript (worker.js + app.js)...
call npm run build:ts
if errorlevel 1 (
  echo [ERROR] TypeScript build failed.
  echo [HINT] Fix the tsc/esbuild errors printed above, then retry.
  pause
  exit /b 1
)

echo [5/5] Building dist package...
set "DIST_ARG="
if /i "%DIST_MODE%"=="multi" set "DIST_ARG=--multi"
call node "%~dp0scripts\build-dist.mjs" %DIST_ARG%
if errorlevel 1 (
  echo [ERROR] dist build failed.
  echo [HINT] See the build-dist.mjs errors printed above, then retry.
  pause
  exit /b 1
)

echo ============================================================
echo   WebSurf-game - Build dist package: complete
echo   Output:  dist/ (mode: %DIST_MODE%)
echo   Run:     play.cmd
if /i "%DIST_MODE%"=="multi" echo   Note:    multi mode needs the local HTTP server (play.cmd).
if /i "%DIST_MODE%"=="single" echo   Note:    file:// double-click works (WASM embedded).
echo ============================================================
exit /b 0
