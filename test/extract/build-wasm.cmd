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
REM Step 1: toolchain check + 构建方式选择
REM ------------------------------------------------------------
echo [1/3] Checking toolchain...
where cargo >nul 2>&1
if errorlevel 1 (
  echo   [!] cargo not found. Install Rust: https://rustup.rs
  goto :failed
)
echo   cargo: OK

REM wasm-pack 优先（系统 0.13.1 自动管理 wasm-bindgen-cli，最可靠）：
REM 找不到才回退手动 cargo + wasm-bindgen（见 :manual_bindgen 段）
where wasm-pack >nul 2>&1
if errorlevel 1 (
  echo   wasm-pack not found - will fall back to manual cargo + wasm-bindgen.
  set "USE_WASM_PACK=0"
) else (
  echo   wasm-pack: OK
  set "USE_WASM_PACK=1"
)

REM ------------------------------------------------------------
REM Step 2: build（wasm-pack 或 手动 cargo）
REM ------------------------------------------------------------
if "%USE_WASM_PACK%"=="1" (
  echo.
  echo [2/2] Building with wasm-pack (release, target web, features=wasm)...
  call wasm-pack build --release --target web --out-dir pkg -- --features wasm
  if errorlevel 1 goto :failed
  goto :done
)

REM ---- 手动回退：cargo build + wasm-bindgen-cli ----
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

REM wasm-bindgen-cli 0.2.126 prebuilt（与 Cargo.toml =0.2.126 匹配）：
REM 本机已有直接复用；否则 cargo install（crates.io）——GitHub release 直连可能不稳
set "WB_VERSION=0.2.126"
where wasm-bindgen >nul 2>&1
if errorlevel 1 (
  echo   [3/3] wasm-bindgen-cli missing - installing %WB_VERSION% (cargo install, 1-3 min)...
  call cargo install -f wasm-bindgen-cli --version %WB_VERSION%
  if errorlevel 1 (
    echo   [!] cargo install failed. Install manually:
    echo       cargo install -f wasm-bindgen-cli --version %WB_VERSION%
    goto :failed
  )
)
echo   wasm-bindgen: OK (%WB_VERSION%)

echo.
echo [3/3] Running wasm-bindgen (--target web)...
call wasm-bindgen --target web --out-dir pkg --no-typescript target\wasm32-unknown-unknown\release\bsp_extract.wasm
if errorlevel 1 goto :failed
echo [3/3] wasm-bindgen OK.

:done
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
