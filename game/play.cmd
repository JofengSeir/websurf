@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-min - Play
cd /d "%~dp0"

set PORT=8137

REM ---- toolchain check ----
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Please install Python 3 first.
  pause
  exit /b 1
)

REM ---- start server (foreground) + open browser (delayed 1s) ----
echo ============================================
echo  WebSurf-min  Local Play
echo  Server:  http://localhost:%PORT%/
echo  App:     http://localhost:%PORT%/dist/index.html
echo  Close this window to stop the server.
echo ============================================

start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/dist/index.html"
python serve.py %PORT%
