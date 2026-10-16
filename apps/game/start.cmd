@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-game - Start
cd /d "%~dp0"

set PORT=8091
if not "%~1"=="" set PORT=%~1

REM ---- start = 单独启动：不做任何构建，只服务已打包的 dist/ ----
REM 注意：**不要**在这里加 python 守卫 —— 那会遮蔽下面更优的产物自带启动器（规范 §2.3 第 3 条）
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
echo   App:     http://localhost:%PORT%/index.html
echo   Close this window to stop the server.
echo ============================================================

REM 启动链三级优先（规范 §2.3 第 3 条）：产物自带启动器 -> python -> npx serve
if exist "%~dp0dist\play.cmd" (
  REM 产物自带的启动器（由 scripts/build-dist.mjs 生成）自己服务 dist\ 并打开页面
  call "%~dp0dist\play.cmd" %PORT%
  exit /b 0
)
where python >nul 2>nul
if not errorlevel 1 (
  REM A detached "cmd /c" opens the page after timeout /t 1; the server call below blocks.
  start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/index.html"
  REM src/scripts/serve.py takes its serve root from argv[2]; here it is dist\ itself.
  python "%~dp0..\..\src\scripts\serve.py" %PORT% "%~dp0dist"
  exit /b %errorlevel%
)
where npx >nul 2>nul
if not errorlevel 1 (
  echo [WARN] python not found - using Node fallback: npx serve ^(no COOP/COEP; SAB path degrades^).
  start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/index.html"
  npx --yes serve -l %PORT% "%~dp0dist"
  exit /b %errorlevel%
)
echo [ERROR] Neither dist\play.cmd nor Python 3 nor Node/npx is available.
echo [HINT] Run build.cmd first (it generates dist\play.cmd), or install Python 3 / Node.js.
pause
exit /b 1
