@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title bsp-extract - Viewer
cd /d "%~dp0"

REM ============================================================
REM   bsp-extract - Scene Viewer (BSP parse + GLB view)
REM   ASCII-only batch (avoid codepage issues). Double-click safe:
REM   window stays open while server runs; close window to stop.
REM
REM   Usage:
REM     view-glb.cmd                 start viewer (default port 8299)
REM     view-glb.cmd 8080            start on custom port
REM     view-glb.cmd maps/xxx.bsp    open a BSP (parsed by wasm in browser)
REM     view-glb.cmd maps/xxx.glb    open a GLB directly
REM ============================================================

set "PORT=8299"
set "FILE="

REM ---- parse args: first non-digit = file, digit-only = port ----
for %%a in (%*) do (
  echo %%a|findstr /r "^[0-9][0-9]*$" >nul 2>&1
  if not errorlevel 1 (
    set "PORT=%%a"
  ) else if not defined FILE (
    set "FILE=%%a"
  )
)

REM ---- PATH boost for double-click context ----
set "PATH=%PATH%;%APPDATA%\npm;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%USERPROFILE%\.cargo\bin"

REM ---- toolchain check ----
where python >nul 2>&1
if errorlevel 1 (
  echo   [!] Python not found. Install Python 3 and add it to PATH.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   bsp-extract - Scene Viewer
echo   Server: http://localhost:%PORT%/
echo   App:    http://localhost:%PORT%/test/extract/viewer/
if defined FILE echo   File:   !FILE!
echo   Close this window to stop the server.
echo ============================================================
echo.

REM ---- build app URL (optionally with ?file=) ----
set "APPURL=http://localhost:%PORT%/test/extract/viewer/"
if defined FILE (
  set "APPURL=!APPURL!?file=/!FILE:\=/!"
)

REM ---- open browser after short delay (background) ----
start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" !APPURL!"

REM ---- serve repo root so /maps/, /test/extract/ are reachable ----
python "%~dp0serve.py" %PORT%
if errorlevel 1 (
  echo.
  echo [!] Server failed to start (python error above).
  echo     Port %PORT% may already be in use.
  echo.
  pause
  exit /b 1
)
