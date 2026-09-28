@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-viewer - Stop dev/start servers

REM Stops this app's dev (8100) and start (8101) servers: finds every process
REM LISTENING on those ports, kills only python ones (WebSurf servers) and leaves
REM anything else untouched, so a foreign program on the same port is never killed.
REM Optional arg: stop a single port instead (example: stop.cmd 8081).
REM A minimized "dev server" window closes when its python process dies.

set "PORTS=8100 8101"
if not "%~1"=="" set "PORTS=%~1"

set "KILLED=0"
for %%P in (%PORTS%) do call :kill_port %%P
if "%KILLED%"=="0" echo [INFO] No python server found listening on: %PORTS%.
if not "%KILLED%"=="0" echo [OK] Stopped %KILLED% python process(es).
pause
exit /b 0

:kill_port
for /f "tokens=5" %%Q in ('netstat -ano ^| findstr ":%~1 " ^| findstr "LISTENING"') do call :kill_pid %%Q %~1
goto :eof

:kill_pid
tasklist /FI "PID eq %~1" 2>nul | findstr /I "python" >nul 2>&1
if errorlevel 1 (
  echo   - port %~2: PID %~1 is not python - skipped
  goto :eof
)
echo   - port %~2: stopping python PID %~1
taskkill /F /T /PID %~1 >nul 2>&1
set "KILLED=1"
goto :eof
