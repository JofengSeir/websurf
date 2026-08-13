@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-test - Play (close this window to stop the server)
cd /d "%~dp0"

set PORT=8080

REM ---- toolchain check ----
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Please install Python 3 first.
  echo         This window will stay open until you press a key.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  echo         This window will stay open until you press a key.
  pause
  exit /b 1
)

REM ---- rebuild TS bundles (best-effort; keep app in sync with src/) ----
echo [1/2] Building TS bundles (npm run build:ts) ...
call npm run build:ts >nul 2>nul
if errorlevel 1 (
  echo [WARN] TS build failed ^(node_modules missing? run "npm install" first^).
  echo        Serving existing bundles in "%~dp0." instead.
)

REM ---- start server (foreground) + open browser (delayed 1s) ----
echo ============================================
echo  WebSurf-test  Local Play
echo  Server:  http://localhost:%PORT%/
echo  App:     http://localhost:%PORT%/index.html
echo.
echo  [IMPORTANT] This window is the server. Keep it open while playing;
echo  close it (or press Ctrl+C) to stop the server and free resources.
echo ============================================

start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/index.html"
REM 注意：root 参数用 "%~dp0."（尾点）——"%~dp0" 以反斜杠结尾会被
REM CommandLineToArgvW 把 \" 解析为转义引号（root 收到尾引号，os.chdir 失败）。
python "%~dp0..\..\src\serve.py" %PORT% "%~dp0."
if errorlevel 1 (
  echo.
  echo [ERROR] Server exited with an error ^(e.g. port %PORT% already in use^).
  echo         Fix the issue and run again.
  echo         This window will stay open until you press a key.
  pause
  exit /b 1
)

echo.
echo Server stopped. This window will stay open until you press a key.
pause
