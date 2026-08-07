@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-min build dist
cd /d "%~dp0"

REM ============================================================
REM   WebSurf-min - Build dist package (single-file)
REM   ASCII-only batch (avoid codepage issues). Double-click safe:
REM   window stays open on both success and failure.
REM ============================================================
echo.
echo ============================================================
echo   WebSurf-min - Build dist package
echo ============================================================
echo.

REM ------------------------------------------------------------
REM PATH boost for double-click context: ensure npm/node/wasm-pack
REM ------------------------------------------------------------
set "PATH=%PATH%;%APPDATA%\npm;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%USERPROFILE%\.cargo\bin"

echo [0/4] Checking toolchain...
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
REM Step 1: WASM build (release). wasm-opt=false is set in
REM crates/wasm/Cargo.toml (NODE_OPTIONS pollutes wasm-opt node script).
REM ------------------------------------------------------------
set "WASM_FILE=%~dp0pkg\websurf_wasm_bg.wasm"

echo.
echo [1/4] Building WASM (release)...
call npm run build:wasm
if errorlevel 1 goto :wasm_failed

if exist "%WASM_FILE%" (
  echo [1/4] WASM ready ^(release^).
) else (
  echo ERROR: %WASM_FILE% not found after build.
  goto :wasm_failed
)

REM ------------------------------------------------------------
REM Step 2: WASM API contract check (9 export + 10 phys)
REM ------------------------------------------------------------
echo.
echo [2/4] Checking WASM API contract...
call node "%~dp0scripts\check-wasm-api.mjs"
if errorlevel 1 goto :wasm_api_failed

REM ------------------------------------------------------------
REM Step 3: TypeScript typecheck + bundle (worker/predictor/app)
REM ------------------------------------------------------------
echo.
echo [3/4] TypeScript typecheck + bundle...
call npm run build:ts
if errorlevel 1 goto :ts_failed

REM ------------------------------------------------------------
REM Step 4: dist single-file package (WASM base64 + dual Worker Blob)
REM ------------------------------------------------------------
echo.
echo [4/4] Building dist single-file...
call node "%~dp0scripts\build-dist.mjs"
if errorlevel 1 goto :dist_failed

echo.
echo ============================================================
echo   Build complete.
echo   dist\index.html can be opened by double-click (file://).
echo ============================================================
echo.
pause
exit /b 0

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
