@echo off
setlocal EnableExtensions
REM Enter project root (parent of scripts/) so npm install runs in the right place
cd /d "%~dp0.."

set "PAUSE_FLAG="
if /i "%~1"=="nopause" set "PAUSE_FLAG=nopause"

echo [deps] ============================================================
echo [deps] Checking Node build dependencies (typescript / esbuild / three ...)
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
