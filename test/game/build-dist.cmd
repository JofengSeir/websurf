@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-game build dist
cd /d "%~dp0"

REM ============================================================
REM   WebSurf-game - Build dist package (multi-file ESM)
REM   ASCII-only batch (avoid codepage issues). Double-click safe:
REM   window stays open on both success and failure.
REM ============================================================
echo.
echo ============================================================
echo   WebSurf-game - Build dist package
echo ============================================================
echo.

REM ------------------------------------------------------------
REM PATH boost for double-click context: ensure npm/node/wasm-pack
REM ------------------------------------------------------------
set "PATH=%PATH%;%APPDATA%\npm;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%USERPROFILE%\.cargo\bin"

echo [0/5] Checking toolchain...
where npm >nul 2>&1
if errorlevel 1 (
  echo   [!] npm not found. Install Node.js and add it to PATH.
  goto :toolchain_failed
)
echo   npm: OK
where wasm-pack >nul 2>&1
if errorlevel 1 (
  echo   [!] wasm-pack not found. Install with: cargo install wasm-pack
  goto :toolchain_failed
)
echo   wasm-pack: OK
where node >nul 2>&1
if errorlevel 1 (
  echo   [!] node not found.
  goto :toolchain_failed
)
echo   node: OK

REM ------------------------------------------------------------
REM Step 1: Node dependencies (auto npm install if node_modules missing)
REM ------------------------------------------------------------
echo.
echo [1/5] Ensuring Node build dependencies (auto npm install if missing)...
call "%~dp0scripts\ensure-node-deps.cmd" nopause
if errorlevel 1 goto :deps_failed
echo [1/5] Node dependencies ready.

REM ------------------------------------------------------------
REM Step 2: WASM build (release). wasm-opt=false is set in
REM crates/wasm/Cargo.toml (NODE_OPTIONS pollutes wasm-opt node script).
REM ------------------------------------------------------------
set "WASM_FILE=%~dp0pkg\websurf_wasm_bg.wasm"

echo.
echo [2/5] Building WASM (release)...
call npm run build:wasm
if errorlevel 1 goto :wasm_failed

if exist "%WASM_FILE%" (
  echo [2/5] WASM ready ^(release^).
) else (
  echo ERROR: %WASM_FILE% not found after build.
  goto :wasm_failed
)

REM ------------------------------------------------------------
REM Step 3: WASM API contract check (9 export + 12 phys)
REM ------------------------------------------------------------
echo.
echo [3/5] Checking WASM API contract...
call node "%~dp0scripts\check-wasm-api.mjs"
if errorlevel 1 goto :wasm_api_failed

REM ------------------------------------------------------------
REM Step 4: TypeScript typecheck + bundle (worker/app)
REM ------------------------------------------------------------
echo.
echo [4/5] TypeScript typecheck + bundle...
call npm run build:ts
if errorlevel 1 goto :ts_failed

REM ------------------------------------------------------------
REM Step 5: dist package (multi-file ESM: app + worker + wasm)
REM ------------------------------------------------------------
echo.
echo [5/5] Building dist package...
call node "%~dp0scripts\build-dist.mjs"
if errorlevel 1 goto :dist_failed

echo.
echo ============================================================
echo   Build complete.
echo   Run dist via: play.cmd (or python serve.py 8137 . + open
echo   http://localhost:8137/dist/index.html).
echo   Note: file:// double-click does NOT work - SharedArrayBuffer
echo   requires COOP/COEP headers from a local server.
echo ============================================================
echo.
pause
exit /b 0

:deps_failed
echo.
echo *** ERROR: Node dependencies install failed ***
echo Check network connectivity and package-lock.json, then retry.
echo.
pause
exit /b 1

:toolchain_failed
echo.
echo *** ERROR: Toolchain incomplete ***
echo Install:
echo   - Node.js (npm + node)
echo   - wasm-pack: cargo install wasm-pack
echo Or add the bin directories to system PATH and retry.
echo.
pause
exit /b 1

:wasm_failed
echo.
echo *** ERROR: WASM build failed ***
echo If you see "os error 5 access denied" (antivirus locking target),
echo delete crates\wasm\target\wasm32-unknown-unknown and retry.
echo.
pause
exit /b 1

:wasm_api_failed
echo.
echo *** ERROR: WASM API contract check failed ***
echo Run npm run build:wasm first, or check scripts\check-wasm-api.mjs.
echo.
pause
exit /b 1

:ts_failed
echo.
echo *** ERROR: TypeScript build failed ***
echo Fix typecheck / esbuild errors and retry.
echo.
pause
exit /b 1

:dist_failed
echo.
echo *** ERROR: dist build failed ***
echo.
pause
exit /b 1
