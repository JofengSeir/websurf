@echo off
chcp 65001 >nul
title WebSurf dev server

cd /d "%~dp0"

REM ============================================================
REM Step 1: WASM build (skipped when pkg already exists)
REM ============================================================

set "WASM_FILE=%~dp0pkg\websurf_wasm_bg.wasm"

if exist "%WASM_FILE%" goto :wasm_done

echo [1/3] Building WASM ^(release^)...

REM Redirect env vars to the project dir to bypass system TEMP permission issues
set "CARGO_HOME=%~dp0.cargo-home"
set "TMP=%~dp0.tmp"
set "TEMP=%~dp0.tmp"
set "WASM_PACK_CACHE=%~dp0.wasm-pack-cache"

if not exist "%CARGO_HOME%" mkdir "%CARGO_HOME%"
if not exist "%TMP%" mkdir "%TMP%"
if not exist "%WASM_PACK_CACHE%" mkdir "%WASM_PACK_CACHE%"

REM GNU toolchain self-contained bin (dlltool.exe etc.)
set "PATH=C:\Users\Jofen\.rustup\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained;%PATH%"

echo [1/3] Ensuring wasm-bindgen-cli v0.2.128 is present (auto-install if missing)...
call "%~dp0scripts\install-wasm-bindgen.cmd" nopause
if errorlevel 1 goto :wasm_failed
echo [1/3] wasm-bindgen-cli ready. Building WASM...
REM Let wasm-pack use the prebuilt CLI instead of a slow source build.
if exist "%~dp0.wasm-pack-cache\.wasm-bindgen-cargo-install-0.2.128\bin\wasm-bindgen.exe" set "WASM_BINDGEN=%~dp0.wasm-pack-cache\.wasm-bindgen-cargo-install-0.2.128\bin\wasm-bindgen.exe"
if not defined WASM_BINDGEN if exist "%~dp0.cargo-home\bin\wasm-bindgen.exe" set "WASM_BINDGEN=%~dp0.cargo-home\bin\wasm-bindgen.exe"
echo [1/3] using WASM_BINDGEN=%WASM_BINDGEN%
echo [1/3] Next, wasm-pack will run in order: check target - compile Rust to WASM - install wasm-bindgen - wasm-opt optimize. The wasm-opt step usually prints nothing; that is normal. Keep the window open until you see "Done in", which means this step finished. Total time depends on your machine; as long as there is no red error, it is still progressing.
call npm run build:wasm
if errorlevel 1 goto :wasm_failed

:wasm_done
if exist "%WASM_FILE%" echo [1/3] WASM ready.

REM ============================================================
REM Step 2: TypeScript build (worker.js + app.js)
REM ============================================================
echo [2/3] Ensuring Node build dependencies are installed (auto npm install if missing)...
call "%~dp0scripts\ensure-node-deps.cmd" nopause
if errorlevel 1 goto :ts_failed
echo [2/3] Building TypeScript...
call npm run build:ts
if errorlevel 1 goto :ts_failed

REM ============================================================
REM Step 3: start HTTP server + open browser
REM ============================================================
echo [3/3] Starting HTTP server...

REM Check whether port 8080 is already in use
netstat -ano | findstr ":8080 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto :start_server

echo Port 8080 already in use. Opening browser...
start "" http://localhost:8080/web/index.html
goto :running

:start_server
REM Note: root arg uses "%~dp0." (trailing dot): "%~dp0" ends with a backslash,
REM which CommandLineToArgvW parses as an escaped quote (root gets a trailing quote, os.chdir fails).
start "" python "%~dp0..\src\serve.py" 8080 "%~dp0."
timeout /t 2 /nobreak >nul
echo Opening browser...
start "" http://localhost:8080/web/index.html

:running
echo.
echo WebSurf is running at http://localhost:8080/web/index.html
echo Close this window to stop the server.
echo.
cmd /k
exit /b 0

:wasm_failed
echo.
echo WASM build failed.
echo If wasm-bindgen-cli install fails, run: scripts\install-wasm-bindgen.cmd
echo.
pause
exit /b 1

:ts_failed
echo.
echo TS build failed.
pause
exit /b 1
