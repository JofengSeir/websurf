@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-game - Stop dev/start servers

REM Stops this app's dev (8090) and start (8091) servers.
REM Delegates to dev-port.mjs: it only kills WebSurf own server on that port
REM (node serve.mjs with a matching PID file, or legacy python serve.py) and
REM never touches a foreign process. Optional arg: stop a single port.
REM A minimized "dev server" window closes when its node process dies.

set "PORTS=8090 8091"
if not "%~1"=="" set "PORTS=%~1"

for %%P in (%PORTS%) do call node "%~dp0..\..\src\scripts\dev-port.mjs" %%P
pause
exit /b 0
