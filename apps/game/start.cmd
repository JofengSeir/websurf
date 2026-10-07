@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-game - Start
cd /d "%~dp0"

set PORT=8091
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
echo [WARN] Port %PORT% is already in use.
echo [WARN] Cannot verify the occupant serves this project's dist\ - not opening the browser.
echo [HINT] Use another port:  start.cmd ^<port^>
exit /b 0

:start_server
echo ============================================================
echo   WebSurf-game - Start (dist, no rebuild)
echo   Server:  http://localhost:%PORT%/
echo   App:     http://localhost:%PORT%/dist/index.html
echo   Close this window to stop the server.
echo ============================================================

REM 起服务三级回退：python -> npx serve -> 报错退出；两者都缺时给可操作指引。
where python >nul 2>nul
if not errorlevel 1 (
  REM A detached "cmd /c" opens the page after timeout /t 1; the server call below blocks.
  start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/dist/index.html"
  REM src/serve.py takes its serve root from argv[2]; "%~dp0." = this app root (trailing dot).
  python "%~dp0..\..\src\serve.py" %PORT% "%~dp0."
  exit /b %errorlevel%
)
where npx >nul 2>nul
if not errorlevel 1 (
  echo [WARN] python not found - using Node fallback: npx serve ^(no COOP/COEP; SAB path degrades^).
  start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/dist/index.html"
  npx --yes serve -l %PORT% "%~dp0."
  exit /b %errorlevel%
)
echo [ERROR] Neither Python 3 nor Node/npx found.
echo [HINT] Install Python 3 or Node.js; or serve .\dist with any static server on port %PORT%.
pause
exit /b 1
