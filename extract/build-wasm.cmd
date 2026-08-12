@echo off
rem bsp-extract:构建 wasm 产物(--target web)到 pkg/
rem 注:wasm-pack 0.2.x 与新版 cargo 的 --out-dir 有兼容问题,故手动走 cargo + wasm-bindgen CLI
cd /d %~dp0

echo [1/2] cargo build (wasm32-unknown-unknown, features=wasm)...
call cargo build --release --target wasm32-unknown-unknown --features wasm
if errorlevel 1 (
  echo 构建失败
  exit /b 1
)

echo [2/2] wasm-bindgen (--target web)...
call wasm-bindgen --target web --out-dir pkg --no-typescript target\wasm32-unknown-unknown\release\bsp_extract.wasm
if errorlevel 1 (
  echo wasm-bindgen 失败
  exit /b 1
)

echo 构建完成:pkg\bsp_extract.js + bsp_extract_bg.wasm
