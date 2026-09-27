@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-debug - Start
cd /d "%~dp0"

set PORT=8081
if not "%~1"=="" set PORT=%~1

REM ---- start = 单独启动：不做任何构建，只服务已打包的 dist/ ----
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found.
  echo [HINT] Install Python 3 and make sure "python" is on PATH.
  pause
  exit /b 1
)

if exist "%~dp0dist\index.html" goto :dist_ok
echo [ERROR] dist\index.html not found - nothing to start.
echo [HINT] Run build.cmd first, then retry.
pause
exit /b 1
:dist_ok

netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto :start_server
echo [SKIP] Port %PORT% is already in use - opening the browser to the running server.
start "" http://localhost:%PORT%/dist/index.html
exit /b 0

:start_server
echo ============================================================
echo   WebSurf-debug - Start (dist, no rebuild)
echo   Server:  http://localhost:%PORT%/
echo   App:     http://localhost:%PORT%/dist/index.html
echo   Close this window to stop the server.
echo ============================================================

REM A detached "cmd /c" opens the page after timeout /t 1; the python call below blocks.
start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/dist/index.html"
REM src/serve.py takes its serve root from argv[2]; "%~dp0." = this app root (trailing dot),
REM so /dist/index.html is served from dist/.
python "%~dp0..\..\src\serve.py" %PORT% "%~dp0."
