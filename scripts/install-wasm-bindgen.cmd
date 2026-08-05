@echo off
chcp 65001 >nul
title Install wasm-bindgen-cli (pre-built)

cd /d "%~dp0.."

REM ============================================================
REM Download pre-built wasm-bindgen.exe to wasm-pack cache dir
REM
REM Background: wasm-pack fails to download wasm-bindgen-cli
REM (network/permission), and cargo install fails due to missing
REM as.exe (GNU toolchain incomplete). This script downloads the
REM pre-built binary directly from GitHub Releases.
REM
REM Usage: run this when start-dev.cmd WASM build step fails.
REM ============================================================

set "VERSION=0.2.126"
set "CACHE_DIR=%~dp0..\.wasm-pack-cache"
set "INSTALL_DIR=%CACHE_DIR%\.wasm-bindgen-cargo-install-%VERSION%\bin"
set "TARBALL=%CACHE_DIR%\wasm-bindgen-%VERSION%.tar.gz"
set "URL=https://github.com/rustwasm/wasm-bindgen/releases/download/%VERSION%/wasm-bindgen-%VERSION%-x86_64-pc-windows-msvc.tar.gz"

if exist "%INSTALL_DIR%\wasm-bindgen.exe" (
    echo wasm-bindgen %VERSION% already installed.
    "%INSTALL_DIR%\wasm-bindgen.exe" --version
    exit /b 0
)

echo Installing wasm-bindgen-cli v%VERSION% ...

if not exist "%CACHE_DIR%" mkdir "%CACHE_DIR%"

powershell -Command "try { Invoke-WebRequest -Uri '%URL%' -OutFile '%TARBALL%' -UseBasicParsing -TimeoutSec 120; Write-Host 'Download OK' } catch { Write-Host 'Download FAILED:' $_; exit 1 }"
if errorlevel 1 (
    echo Failed to download wasm-bindgen from GitHub.
    echo Please check network or manually download from:
    echo   %URL%
    pause
    exit /b 1
)

echo Extracting...
if not exist "%CACHE_DIR%\extract" mkdir "%CACHE_DIR%\extract"
tar -xzf "%TARBALL%" -C "%CACHE_DIR%\extract" 2>nul

if not exist "%CACHE_DIR%\extract\wasm-bindgen-%VERSION%-x86_64-pc-windows-msvc\wasm-bindgen.exe" (
    pushd "%CACHE_DIR%\extract"
    tar -xzf "%TARBALL%" "wasm-bindgen-%VERSION%-x86_64-pc-windows-msvc/wasm-bindgen.exe"
    popd
)

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /Y "%CACHE_DIR%\extract\wasm-bindgen-%VERSION%-x86_64-pc-windows-msvc\wasm-bindgen.exe" "%INSTALL_DIR%\wasm-bindgen.exe" >nul 2>&1

if not exist "%INSTALL_DIR%\wasm-bindgen.exe" (
    echo Failed to extract wasm-bindgen.exe.
    echo Antivirus may have quarantined the file.
    pause
    exit /b 1
)

echo.
echo wasm-bindgen installed successfully:
"%INSTALL_DIR%\wasm-bindgen.exe" --version
echo Location: %INSTALL_DIR%\wasm-bindgen.exe
echo.
echo Now re-run start-dev.cmd to build WASM.
pause
