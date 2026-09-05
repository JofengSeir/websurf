@echo off
chcp 65001 >nul
title WebSurf-viewer - Play
setlocal EnableExtensions
cd /d "%~dp0"

rem WebSurf-viewer source workspace double-click entry, aligned with
rem debug/start-dev.cmd automation:
rem   auto build:wasm when pkg missing -> auto npm install when node_modules
rem   missing -> rebuild dist every run (source changes always take effect)
rem   -> port in use: reuse running instance; otherwise serve + open browser
rem usage: play.cmd [port] (default 8090)
rem NOTE: keep this file pure ASCII with CRLF line endings - cmd.exe breaks
rem       on non-ASCII content and on LF-only batch files.
set PORT=8090
if not "%~1"=="" set PORT=%~1

REM ============================================================
REM Step 1: WASM artifact check - build pkg only when missing
REM ============================================================
if exist "pkg\websurf_viewer_wasm.js" goto :pkg_done

echo [1/3] WASM pkg missing - building via wasm-pack ^(Rust toolchain required, slow on first run^)...
call npm run build:wasm
if errorlevel 1 goto :wasm_failed
:pkg_done
if exist "pkg\websurf_viewer_wasm.js" echo [1/3] WASM ready.

REM ============================================================
REM Step 2: Node deps + build dist (esbuild bundle with embedded WASM)
REM ============================================================
if exist "node_modules\esbuild" goto :deps_done

echo [2/3] Installing Node dependencies ^(npm install, only when missing^)...
call npm install
if errorlevel 1 goto :deps_failed
:deps_done

echo [2/3] Building dist ^(source changes take effect every run^)...
call npm run build:dist
if errorlevel 1 goto :build_failed

REM ============================================================
REM Step 3: port check -> reuse running instance or serve + open browser
REM         (dist\play.cmd: python first, npx serve fallback,
REM          serve.py has SO_REUSEADDR + friendly bind-error hint)
REM ============================================================
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto :start_server

echo Port %PORT% already in use - opening browser to the running viewer.
start "" http://localhost:%PORT%/index.html
goto :running

:start_server
echo [3/3] Starting local server and opening browser...
call "dist\play.cmd" %PORT%

:running
echo.
echo WebSurf-viewer is running at http://localhost:%PORT%/index.html
echo Close the server window to stop it.
exit /b 0

:wasm_failed
echo.
echo [ERROR] WASM build failed - Rust toolchain required ^(rustup + wasm-pack^).
echo [HINT] Preview only? If dist\ exists, just double-click dist\play.cmd.
echo.
pause
exit /b 1

:deps_failed
echo.
echo [ERROR] npm install failed - check Node.js install ^(https://nodejs.org/^) and network.
echo.
pause
exit /b 1

:build_failed
echo.
echo [ERROR] dist build failed - see esbuild errors above.
echo [HINT] Preview only? If dist\ exists, just double-click dist\play.cmd.
echo.
pause
exit /b 1
