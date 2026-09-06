@echo off
setlocal EnableExtensions
title WebSurf build dist
cd /d "%~dp0"

echo ============================================================
echo   WebSurf - Build dist package
echo ============================================================
echo.

REM ------------------------------------------------------------
REM Step 1: WASM 构建（release）——始终重建，确保 dist 内嵌 release wasm。
REM wasm32-unknown-unknown 目标不需要原生 GNU binutils（as.exe），
REM 因此在原生导出器构建失败的机器上也能工作。
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

echo [1/3] Ensuring wasm-bindgen-cli v0.2.128 is present (auto-install if missing)...
call "%~dp0scripts\install-wasm-bindgen.cmd" nopause
echo [1/3] wasm-bindgen-cli installer returned with code %errorlevel%.
if errorlevel 1 (
    echo [1/3] wasm-bindgen-cli setup failed.
    goto :wasm_failed
)
echo [1/3] wasm-bindgen-cli ready. Building WASM...
REM 让 wasm-pack 使用预构建 CLI，避免回退到静默源码编译。
if exist "%~dp0.wasm-pack-cache\.wasm-bindgen-cargo-install-0.2.128\bin\wasm-bindgen.exe" set "WASM_BINDGEN=%~dp0.wasm-pack-cache\.wasm-bindgen-cargo-install-0.2.128\bin\wasm-bindgen.exe"
if not defined WASM_BINDGEN if exist "%~dp0.cargo-home\bin\wasm-bindgen.exe" set "WASM_BINDGEN=%~dp0.cargo-home\bin\wasm-bindgen.exe"
echo [1/3] using WASM_BINDGEN=%WASM_BINDGEN%
echo [1/3] Next, wasm-pack will run in order: check target - compile Rust to WASM - install wasm-bindgen - wasm-opt optimize. The wasm-opt step usually prints nothing; that is normal. Keep the window open until you see "Done in", which means this step finished. Total time depends on your machine; as long as there is no red error, it is still progressing.
call npm run build:wasm
if errorlevel 1 goto :wasm_failed

if exist "%WASM_FILE%" (
  echo [1/3] WASM ready ^(release^).
) else (
  echo ERROR: %WASM_FILE% not found after build.
  goto :wasm_failed
)

REM WASM API 契约检查：所有 TS 导入必须存在于 wasm-pack 导出中
call node "%~dp0scripts\check-wasm-api.mjs"
if errorlevel 1 goto :wasm_api_failed

REM ------------------------------------------------------------
REM Step 2: TypeScript 类型检查 + 构建（worker.js + app.js）
REM ------------------------------------------------------------
echo [2/3] Ensuring Node build dependencies are installed (auto npm install if missing)...
call "%~dp0scripts\ensure-node-deps.cmd" nopause
if errorlevel 1 goto :ts_failed
echo [2/3] Building TypeScript...
call npm run build:ts
if errorlevel 1 goto :ts_failed

REM ------------------------------------------------------------
REM Step 3: 构建 dist 包（内嵌 WASM + worker Blob URL）
REM ------------------------------------------------------------
echo [3/3] Building dist package...
call npm run build:dist
if errorlevel 1 goto :dist_failed

REM ------------------------------------------------------------
REM 完成 - 打开输出目录
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
