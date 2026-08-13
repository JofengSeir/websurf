@echo off
chcp 65001 >nul
setlocal EnableExtensions
title bsp-extract - Build WASM
cd /d "%~dp0"

REM ============================================================
REM   bsp-extract - Build WASM package (pkg/)
REM   ASCII-only batch (avoid codepage issues). Double-click safe:
REM   window stays open on both success and failure.
REM
REM   Pipeline: cargo build (wasm32 + wasm feature) ->
REM             wasm-bindgen (--target web) -> pkg/
REM   Note: wasm-pack 0.2.x conflicts with newer cargo (--out-dir),
REM         so we drive cargo + wasm-bindgen-cli manually.
REM ============================================================
echo.
echo ============================================================
echo   bsp-extract - Build WASM package
echo ============================================================
echo.

REM ---- PATH boost for double-click context ----
set "PATH=%PATH%;%APPDATA%\npm;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%USERPROFILE%\.cargo\bin"

REM ---- isolate cargo env (avoid system TEMP permission issues) ----
set "CARGO_HOME=%~dp0.cargo-home"
if not exist "%CARGO_HOME%" mkdir "%CARGO_HOME%"

REM ------------------------------------------------------------
REM Step 1: toolchain check
REM ------------------------------------------------------------
echo [1/3] Checking toolchain...
where cargo >nul 2>&1
if errorlevel 1 (
  echo   [!] cargo not found. Install Rust: https://rustup.rs
  goto :failed
)
echo   cargo: OK
where wasm-bindgen >nul 2>&1
if errorlevel 1 (
  echo   [!] wasm-bindgen-cli not found. Install with:
  echo       cargo install -f wasm-bindgen-cli --version 0.2.103
  goto :failed
)
echo   wasm-bindgen: OK

REM ------------------------------------------------------------
REM Step 2: cargo build (wasm32-unknown-unknown + wasm feature)
REM ------------------------------------------------------------
echo.
echo [2/3] Building WASM (wasm32-unknown-unknown, release, features=wasm)...
rustup target list --installed | findstr /c:"wasm32-unknown-unknown" >nul 2>&1
if errorlevel 1 (
  echo   [!] wasm32 target missing. Install with:
  echo       rustup target add wasm32-unknown-unknown
  goto :failed
)
call cargo build --release --target wasm32-unknown-unknown --features wasm
if errorlevel 1 goto :failed
echo [2/3] cargo build OK.

REM ------------------------------------------------------------
REM Step 3: wasm-bindgen (--target web) -> pkg/
REM ------------------------------------------------------------
echo.
echo [3/3] Running wasm-bindgen (--target web)...
call wasm-bindgen --target web --out-dir pkg --no-typescript target\wasm32-unknown-unknown\release\bsp_extract.wasm
if errorlevel 1 goto :failed
echo [3/3] wasm-bindgen OK.

echo.
echo ============================================================
echo   Done: pkg\bsp_extract.js + pkg\bsp_extract_bg.wasm
echo ============================================================
echo.
pause
exit /b 0

:failed
echo.
echo Build failed. See messages above.
echo.
echo If the error mentions "denied access" on target\, another process
echo may be locking target (antivirus or a running build). Close other
echo terminals, wait a moment, then re-run this script.
echo.
pause
exit /b 1
