@echo off
setlocal EnableExtensions
title WebSurf build dist
cd /d "%~dp0"

echo ============================================================
echo   WebSurf - Build dist package
echo ============================================================
echo.

REM ------------------------------------------------------------
REM Step 1: WASM build (release) - always rebuild so dist embeds the
REM release wasm.  The wasm32-unknown-unknown target does NOT need the
REM native GNU binutils (as.exe), so this works even where the native
REM exporter build fails.
REM ------------------------------------------------------------
set "WASM_FILE=%~dp0pkg\websurf_wasm_bg.wasm"

echo [1/3] Building WASM (release)...
set "CARGO_HOME=%~dp0.cargo-home"
set "TMP=%~dp0.tmp"
set "TEMP=%~dp0.tmp"
set "WASM_PACK_CACHE=%~dp0.wasm-pack-cache"

if not exist "%CARGO_HOME%" mkdir "%CARGO_HOME%"
if not exist "%TMP%" mkdir "%TMP%"
if not exist "%WASM_PACK_CACHE%" mkdir "%WASM_PACK_CACHE%"

set "SC_DIR=C:\Users\Jofen\.rustup\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained"
if exist "%SC_DIR%" set "PATH=%SC_DIR%;%PATH%"

call npm run build:wasm
if errorlevel 1 goto :wasm_failed

if exist "%WASM_FILE%" (
  echo [1/3] WASM ready ^(release^).
) else (
  echo ERROR: %WASM_FILE% not found after build.
  goto :wasm_failed
)

REM WASM API contract check: every TS import must exist in wasm-pack exports
call node "%~dp0scripts\check-wasm-api.mjs"
if errorlevel 1 goto :wasm_api_failed

REM ------------------------------------------------------------
REM Step 2: TypeScript typecheck + build (worker.js + app.js)
REM ------------------------------------------------------------
echo [2/3] Building TypeScript...
call npm run build:ts
if errorlevel 1 goto :ts_failed

REM ------------------------------------------------------------
REM Step 3: Build dist package (embedded WASM + worker Blob URL)
REM ------------------------------------------------------------
echo [3/3] Building dist package...
call npm run build:dist
if errorlevel 1 goto :dist_failed

REM ------------------------------------------------------------
REM Done - open output folder
REM ------------------------------------------------------------
echo.
echo Build complete. Output: dist\
if exist "%~dp0dist\index.html" (
    echo dist\index.html ready - double-click to run in browser.
    start "" explorer "%~dp0dist"
) else (
    echo WARNING: dist\index.html not found. Check build output above.
)
echo.
pause
exit /b 0

:wasm_failed
echo.
echo WASM build failed.
echo If wasm-bindgen-cli install fails, run: scripts\install-wasm-bindgen.cmd
echo.
pause
exit /b 1

:wasm_api_failed
echo.
echo WASM API contract check FAILED - pkg exports do not match TS imports.
echo   Inspect: rebuild pkg (wasm-pack) or check src/wasm.d.ts vs crates/wasm.
echo.
pause
exit /b 1

:ts_failed
echo.
echo TS build failed.
pause
exit /b 1

:dist_failed
echo.
echo dist build failed.
pause
exit /b 1
