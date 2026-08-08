@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-game - Play
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
echo  WebSurf-game  Local Play
echo  Server:  http://localhost:%PORT%/
echo  App:     http://localhost:%PORT%/dist/index.html
echo  Close this window to stop the server.
echo ============================================

start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/dist/index.html"
REM 注意：root 参数用 "%~dp0."（尾点）——"%~dp0" 以反斜杠结尾会被
REM CommandLineToArgvW 把 \" 解析为转义引号（root 收到尾引号，os.chdir 失败）。
python "%~dp0..\src\serve.py" %PORT% "%~dp0."
