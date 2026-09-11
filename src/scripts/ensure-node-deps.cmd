@echo off
setlocal EnableExtensions
REM ============================================================
REM Shared Node dependency bootstrap (D-01 / T-01).
REM
REM CALLER CONTRACT: the caller must already be in the APP ROOT,
REM i.e. every entrypoint does `cd /d "%~dp0"` before calling this
REM script. This file no longer derives the app root from its own
REM location (it lives in src/scripts/, so `%~dp0..` would resolve
REM to src/ instead of the app root).
REM
REM Usage (from apps/<app>/build-dist.cmd etc.):
REM   call "%~dp0..\..\src\scripts\ensure-node-deps.cmd" nopause
REM
REM Exit codes: 0 = dependencies ready, 1 = not an app root / npm install failed.
REM NOTE: keep this file pure ASCII with CRLF line endings.
REM ============================================================

set "APP_ROOT=%CD%"

REM ---- pause control: parsed BEFORE the guard below, so "nopause" also
REM      suppresses the guard's pause (automated callers must never block) ----
set "PAUSE_FLAG="
if /i "%~1"=="nopause" set "PAUSE_FLAG=nopause"

if not exist "%APP_ROOT%\package.json" (
    echo [ERROR] ensure-node-deps: current directory is not an app root ^(package.json missing^): %APP_ROOT%
    echo [HINT] cd into the app root first ^(every WebSurf entrypoint does "cd /d %%~dp0"^), then retry.
    if not defined PAUSE_FLAG pause
    exit /b 1
)

echo [deps] ============================================================
echo [deps] Checking Node build dependencies (typescript / esbuild / three ...)
echo [deps] Project root: %APP_ROOT%
echo [deps] ============================================================

if exist "node_modules\.bin\tsc" (
    echo [deps] typescript already detected at node_modules\.bin\tsc - dependencies ready, skipping npm install.
    goto :done
)

echo [deps] Local dependencies not found - running npm install to fetch all deps...
echo [deps] This downloads and links packages; npm shows a progress bar, please wait...
echo [deps] ------------------------------------------------------------
call npm install
if errorlevel 1 (
    echo [deps][ERROR] npm install failed. Check network connectivity and package-lock.json.
    goto :fail
)
echo [deps] ------------------------------------------------------------
echo [deps] npm install finished, dependencies ready.

goto :done

:fail
echo.
if not defined PAUSE_FLAG pause
exit /b 1

:done
if not defined PAUSE_FLAG pause
exit /b 0
