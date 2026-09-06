@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Install wasm-bindgen-cli (pre-built)

REM ============================================================
REM Ensure a version-matched wasm-bindgen-cli is available so
REM wasm-pack does NOT silently fall back to `cargo install`
REM (a source compile that looks like the build is frozen).
REM
REM Called automatically by build-dist.cmd / start-dev.cmd.
REM Pass "nopause" as %1 when invoked from an automated build
REM so it never blocks waiting for a keypress.
REM ============================================================

set "VERSION=0.2.128"
set "ROOT=%~dp0.."
set "CACHE_DIR=%ROOT%\.wasm-pack-cache"
set "INSTALL_DIR=%CACHE_DIR%\.wasm-bindgen-cargo-install-%VERSION%\bin"
set "TARBALL=%CACHE_DIR%\wasm-bindgen-%VERSION%.tar.gz"
set "URL=https://github.com/rustwasm/wasm-bindgen/releases/download/%VERSION%/wasm-bindgen-%VERSION%-x86_64-pc-windows-msvc.tar.gz"
set "EXE_REL=wasm-bindgen-%VERSION%-x86_64-pc-windows-msvc\wasm-bindgen.exe"
set "CARGO_BIN=%ROOT%\.cargo-home\bin"
set "NO_PAUSE=0"
if /i "%~1"=="nopause" set "NO_PAUSE=1"

REM --- Idempotent: skip download if correct binary already present ---
if exist "%INSTALL_DIR%\wasm-bindgen.exe" (
    echo [wasm-bindgen] already installed at: %INSTALL_DIR%\wasm-bindgen.exe
    if not exist "%CARGO_BIN%" mkdir "%CARGO_BIN%"
    copy /Y "%INSTALL_DIR%\wasm-bindgen.exe" "%CARGO_BIN%\wasm-bindgen.exe" >nul 2>&1
    echo [wasm-bindgen] === install finished, exit 0 (normal return, not an error) ===
    if "%NO_PAUSE%"=="0" pause
    exit /b 0
)

echo [wasm-bindgen] Installing wasm-bindgen-cli v%VERSION% (prebuilt)...
if not exist "%CACHE_DIR%" mkdir "%CACHE_DIR%"

REM --- Download with visible progress (curl -#), PowerShell fallback ---
set "DL_OK=0"
where curl >nul 2>&1
if not errorlevel 1 (
    echo [wasm-bindgen] Downloading prebuilt binary via curl...
    REM IMPORTANT: `call` is required. If curl resolves to curl.cmd on this
    REM machine, invoking it without `call` transfers control permanently and
    REM the script (and the parent build) terminates right after download.
    call curl -# -L --retry 2 --connect-timeout 30 -o "%TARBALL%" "%URL%"
    if not errorlevel 1 (
        set "DL_OK=1"
        echo [wasm-bindgen] curl download complete.
    ) else (
        echo [wasm-bindgen] curl download returned an error, will try PowerShell fallback.
    )
)
if "%DL_OK%"=="0" (
    echo [wasm-bindgen] curl not available or failed, falling back to PowerShell...
    powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%URL%' -OutFile '%TARBALL%' -UseBasicParsing -TimeoutSec 120; Write-Host '[wasm-bindgen] PowerShell download OK'; exit 0 } catch { Write-Host '[wasm-bindgen] PowerShell download FAILED:' $_; exit 1 }"
    if not errorlevel 1 (
        set "DL_OK=1"
    )
)
if "%DL_OK%"=="0" (
    echo [wasm-bindgen] ERROR: download failed (both curl and PowerShell).
    echo [wasm-bindgen] Please download manually and place the exe at:
    echo   %INSTALL_DIR%\wasm-bindgen.exe
    echo   %URL%
    if "%NO_PAUSE%"=="0" pause
    exit /b 1
)

REM --- Extract (call tar; tar is tar.exe on Win10+, calling via `call` is safe) ---
echo [wasm-bindgen] Extracting...
if not exist "%CACHE_DIR%\extract" mkdir "%CACHE_DIR%\extract"
call tar -xzf "%TARBALL%" -C "%CACHE_DIR%\extract" 2>nul
if not exist "%CACHE_DIR%\extract\%EXE_REL%" (
    echo [wasm-bindgen] tar unavailable or failed, extracting via PowerShell...
    powershell -NoProfile -Command "try { tar -xzf '%TARBALL%' -C '%CACHE_DIR%\extract' 2>$null; if (-not (Test-Path '%CACHE_DIR%\extract\%EXE_REL%')) { throw 'tar extract produced no exe' }; Write-Host '[wasm-bindgen] PowerShell extract OK'; exit 0 } catch { Write-Host '[wasm-bindgen] PowerShell extract FAILED:' $_; exit 1 }"
)
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /Y "%CACHE_DIR%\extract\%EXE_REL%" "%INSTALL_DIR%\wasm-bindgen.exe" >nul 2>&1

REM Also place a copy in .cargo-home\bin as a fallback search path for wasm-pack.
if not exist "%CARGO_BIN%" mkdir "%CARGO_BIN%"
copy /Y "%INSTALL_DIR%\wasm-bindgen.exe" "%CARGO_BIN%\wasm-bindgen.exe" >nul 2>&1

if not exist "%INSTALL_DIR%\wasm-bindgen.exe" (
    echo [wasm-bindgen] ERROR: extraction failed (antivirus may have blocked the exe).
    echo [wasm-bindgen] The downloaded tarball is at: %TARBALL%
    if "%NO_PAUSE%"=="0" pause
    exit /b 1
)

echo [wasm-bindgen] Installed successfully (version %VERSION%):
echo   %INSTALL_DIR%\wasm-bindgen.exe
echo [wasm-bindgen] === install finished, exit 0 (normal return, not an error) ===
if "%NO_PAUSE%"=="0" (
    echo [wasm-bindgen] You can now build WASM (re-run the build script).
    pause
)
exit /b 0
