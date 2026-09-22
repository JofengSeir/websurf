@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Install wasm-bindgen-cli (pre-built)

REM ============================================================
REM Install a prebuilt, version-matched wasm-bindgen-cli.
REM
REM VERSION is the wasm-bindgen version pinned in every Cargo.lock
REM of this repo (0.2.128) and is also the release tag of the
REM tarball downloaded below. No path here compiles from source.
REM The exe ends up in two places, both rooted at the repository
REM root by src/scripts/cargo-env.cmd:
REM   WASM_PACK_CACHE\.wasm-bindgen-cargo-install-<VERSION>\bin
REM   CARGO_HOME\bin   (fallback search path)
REM
REM Called by apps/debug/start-dev.cmd and apps/debug/build-dist.cmd,
REM both passing "nopause" as the first argument, so an automated
REM build never blocks on a keypress (each pause below is guarded
REM by NO_PAUSE).
REM ============================================================

set "VERSION=0.2.128"
REM Shared env: CARGO_HOME / WASM_PACK_CACHE / WASM_BINDGEN are all
rem rooted at the REPOSITORY ROOT (see src/scripts/cargo-env.cmd).
call "%~dp0cargo-env.cmd"
set "CACHE_DIR=%WASM_PACK_CACHE%"
set "INSTALL_DIR=%CACHE_DIR%\.wasm-bindgen-cargo-install-%VERSION%\bin"
set "TARBALL=%CACHE_DIR%\wasm-bindgen-%VERSION%.tar.gz"
set "URL=https://github.com/rustwasm/wasm-bindgen/releases/download/%VERSION%/wasm-bindgen-%VERSION%-x86_64-pc-windows-msvc.tar.gz"
set "EXE_REL=wasm-bindgen-%VERSION%-x86_64-pc-windows-msvc\wasm-bindgen.exe"
set "CARGO_BIN=%CARGO_HOME%\bin"
set "NO_PAUSE=0"
if /i "%~1"=="nopause" set "NO_PAUSE=1"

REM --- Idempotent: skip the download if the versioned install dir already has the exe ---
if exist "%INSTALL_DIR%\wasm-bindgen.exe" (
    echo [wasm-bindgen] already installed at: %INSTALL_DIR%\wasm-bindgen.exe
    if not exist "%CARGO_BIN%" mkdir "%CARGO_BIN%"
    copy /Y "%INSTALL_DIR%\wasm-bindgen.exe" "%CARGO_BIN%\wasm-bindgen.exe" >nul 2>&1
    set "WASM_BINDGEN=%CARGO_BIN%\wasm-bindgen.exe"
    echo [wasm-bindgen] === install finished, exit 0 ^(normal return, not an error^) ===
    if "%NO_PAUSE%"=="0" pause
    exit /b 0
)

echo [wasm-bindgen] Installing wasm-bindgen-cli v%VERSION% (prebuilt)...
if not exist "%CACHE_DIR%" mkdir "%CACHE_DIR%"

REM --- Download with visible progress (curl -#), PowerShell as fallback ---
set "DL_OK=0"
where curl >nul 2>&1
if not errorlevel 1 (
    echo [wasm-bindgen] Downloading prebuilt binary via curl...
    REM IMPORTANT: `call` is required. If curl resolves to a .cmd shim on
    REM this machine, a plain invocation transfers control to that shim and
    REM this script (plus the parent build) ends right after the download.
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
    echo [wasm-bindgen] ERROR: download failed ^(both curl and PowerShell^).
    echo [wasm-bindgen] Please download manually and place the exe at:
    echo   %INSTALL_DIR%\wasm-bindgen.exe
    echo   %URL%
    if "%NO_PAUSE%"=="0" pause
    exit /b 1
)

REM --- Extract (call tar; tar is tar.exe on Win10+, so `call` returns here) ---
echo [wasm-bindgen] Extracting...
if not exist "%CACHE_DIR%\extract" mkdir "%CACHE_DIR%\extract"
call tar -xzf "%TARBALL%" -C "%CACHE_DIR%\extract" 2>nul
if not exist "%CACHE_DIR%\extract\%EXE_REL%" (
    echo [wasm-bindgen] tar unavailable or failed, extracting via PowerShell...
    powershell -NoProfile -Command "try { tar -xzf '%TARBALL%' -C '%CACHE_DIR%\extract' 2>$null; if (-not (Test-Path '%CACHE_DIR%\extract\%EXE_REL%')) { throw 'tar extract produced no exe' }; Write-Host '[wasm-bindgen] PowerShell extract OK'; exit 0 } catch { Write-Host '[wasm-bindgen] PowerShell extract FAILED:' $_; exit 1 }"
)
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /Y "%CACHE_DIR%\extract\%EXE_REL%" "%INSTALL_DIR%\wasm-bindgen.exe" >nul 2>&1

REM Also copy into CARGO_HOME\bin (= <repo>\.cargo-home\bin): the fallback
REM search path used when no .wasm-bindgen-cargo-install-* dir matches
REM (enumerated by src/scripts/cargo-env.cmd).
if not exist "%CARGO_BIN%" mkdir "%CARGO_BIN%"
copy /Y "%INSTALL_DIR%\wasm-bindgen.exe" "%CARGO_BIN%\wasm-bindgen.exe" >nul 2>&1

if not exist "%INSTALL_DIR%\wasm-bindgen.exe" (
    echo [wasm-bindgen] ERROR: extraction failed ^(antivirus may have blocked the exe^).
    echo [wasm-bindgen] The downloaded tarball is at: %TARBALL%
    if "%NO_PAUSE%"=="0" pause
    exit /b 1
)

echo [wasm-bindgen] Installed successfully (version %VERSION%):
echo   %INSTALL_DIR%\wasm-bindgen.exe
set "WASM_BINDGEN=%CARGO_BIN%\wasm-bindgen.exe"
echo [wasm-bindgen] === install finished, exit 0 ^(normal return, not an error^) ===
if "%NO_PAUSE%"=="0" (
    echo [wasm-bindgen] You can now build WASM ^(re-run the build script^).
    pause
)
exit /b 0
