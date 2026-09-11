@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-viewer build dist
cd /d "%~dp0"

REM ============================================================
REM   WebSurf-viewer - Build dist package (single-file IIFE)
REM   ASCII-only batch (avoid codepage issues). Double-click safe:
REM   window stays open on both success and failure.
REM   Step skeleton aligned with game\build-dist.cmd (R6): [0]
REM   toolchain check -> [1] node deps (inline auto npm install,
REM   viewer has no ensure-node-deps.cmd) -> [2] wasm release
REM   (always rebuilt; dist embeds it as base64) -> [3] ts
REM   typecheck + bundle -> [4] dist (direct node call, exit code
REM   flows through). No WASM API contract check step: viewer has
REM   no check:api script.
REM ============================================================
echo.
echo ============================================================
echo   WebSurf-viewer - Build dist package
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
REM Shared cargo/wasm-pack env (root .cargo-home / .wasm-pack-cache
REM / .tmp) - same pre-wasm call as viewer\play.cmd.
REM ------------------------------------------------------------
call "%~dp0..\..\src\scripts\cargo-env.cmd"

REM ------------------------------------------------------------
REM Step 1: Node dependencies (inline check - auto npm install only
REM when node_modules is missing, same pattern as viewer\play.cmd)
REM ------------------------------------------------------------
if exist "node_modules\esbuild" goto :deps_done

echo.
echo [1/4] Installing Node dependencies (npm install, only when missing)...
call npm install
if errorlevel 1 goto :deps_failed
:deps_done
echo [1/4] Node dependencies ready.

REM ------------------------------------------------------------
REM Step 2: WASM build (release) - always rebuilt so dist embeds a
REM release wasm (base64) and web/ gets the dev copy.
REM ------------------------------------------------------------
set "WASM_FILE=%~dp0pkg\websurf_viewer_wasm_bg.wasm"

echo.
echo [2/4] Building WASM (release)...
call npm run build:wasm
if errorlevel 1 goto :wasm_failed

if exist "%WASM_FILE%" (
  echo [2/4] WASM ready ^(release^).
) else (
  echo ERROR: %WASM_FILE% not found after build.
  goto :wasm_failed
)

REM ------------------------------------------------------------
REM Step 3: TypeScript typecheck + bundle (worker/app)
REM ------------------------------------------------------------
echo.
echo [3/4] TypeScript typecheck + bundle...
call npm run build:ts
if errorlevel 1 goto :ts_failed

REM ------------------------------------------------------------
REM Step 4: dist package (single mode: IIFE app + wasm base64
REM inline). Direct node call (same as game\build-dist.cmd):
REM bypasses npm run so the exit code flows straight through.
REM ------------------------------------------------------------
echo.
echo [4/4] Building dist package...
call node "%~dp0scripts\build-dist.mjs"
if errorlevel 1 goto :dist_failed

echo.
echo ============================================================
echo   Build complete.
echo   Run dist via: play.cmd (or python ..\..\src\serve.py 8090 . +
echo   open http://localhost:8090/dist/index.html).
echo   dist is single mode (IIFE app + wasm base64 inline): works
echo   over HTTP and file:// both.
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
