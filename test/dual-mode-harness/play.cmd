@echo off
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

REM ---- bootstrap: deps -> wasm -> ts (auto when missing) ----
if exist "node_modules\.bin\tsc" goto :deps_done
echo [1/3] Installing Node dependencies (npm install, only when missing)...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed. Check network connectivity and package-lock.json.
  echo         This window will stay open until you press a key.
  pause
  exit /b 1
)
:deps_done

if exist "pkg\websurf_test_wasm.js" goto :wasm_done
echo [2/3] WASM missing - building (release, slow on first run; Rust toolchain required)...
call npm run build:wasm
if errorlevel 1 (
  echo [ERROR] WASM build failed - check Rust toolchain: rustup + wasm-pack.
  echo         This window will stay open until you press a key.
  pause
  exit /b 1
)
:wasm_done

echo [3/3] Building TS bundles (npm run build:ts) ...
call npm run build:ts
if errorlevel 1 (
  echo [ERROR] TS build failed - see esbuild errors above.
  echo         This window will stay open until you press a key.
  pause
  exit /b 1
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
REM Note: root arg uses "%~dp0." (trailing dot): "%~dp0" ends with a backslash,
REM which CommandLineToArgvW parses as an escaped quote (root gets a trailing quote, os.chdir fails).
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
