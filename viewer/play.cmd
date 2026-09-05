@echo off
chcp 65001 >nul
title WebSurf-viewer - Play
setlocal EnableExtensions
cd /d "%~dp0"

rem WebSurf-viewer 源码工作区双击入口（对齐 debug/start-dev.cmd 的自动化程度）：
rem 自动补 WASM/pkg 与 Node 依赖 → 每次重建 dist（源码改动即生效）→
rem 端口被占时复用已运行实例，否则起服务器 + 自动开浏览器。
rem 用法：play.cmd [port]（默认 8090）
set PORT=8090
if not "%~1"=="" set PORT=%~1

REM ============================================================
REM Step 1: WASM 产物检查（pkg 缺失才构建；已有 dist 不受影响）
REM ============================================================
if exist "pkg\websurf_viewer_wasm.js" goto :pkg_done

echo [1/3] WASM 产物缺失，构建 pkg（wasm-pack，需 Rust 工具链；首次较慢）...
call npm run build:wasm
if errorlevel 1 goto :wasm_failed
:pkg_done
if exist "pkg\websurf_viewer_wasm.js" echo [1/3] WASM ready.

REM ============================================================
REM Step 2: Node 依赖 + 构建 dist（esbuild 打包 + WASM 内嵌，秒级）
REM ============================================================
if exist "node_modules\esbuild" goto :deps_done

echo [2/3] 安装 Node 依赖（npm install，仅缺失时执行）...
call npm install
if errorlevel 1 goto :deps_failed
:deps_done

echo [2/3] 构建 dist（源码改动每次生效）...
call npm run build:dist
if errorlevel 1 goto :build_failed

REM ============================================================
REM Step 3: 端口检测 → 复用或起服务器（dist/play.cmd：python 优先 +
REM         npx serve 备选 + 延时开浏览器；serve.py 带 SO_REUSEADDR）
REM ============================================================
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto :start_server

echo 端口 %PORT% 已被占用——直接打开浏览器（复用已运行的 viewer）。
start "" http://localhost:%PORT%/index.html
goto :running

:start_server
echo [3/3] 启动本地服务器并自动打开浏览器...
call "dist\play.cmd" %PORT%

:running
echo.
echo WebSurf-viewer 运行中：http://localhost:%PORT%/index.html
echo 关闭服务器窗口即停止。
exit /b 0

:wasm_failed
echo.
echo [错误] WASM 构建失败——需要 Rust 工具链（rustup + wasm-pack）。
echo [提示] 若只想预览而不重建：已有 dist\ 可直接双击 dist\play.cmd。
echo.
pause
exit /b 1

:deps_failed
echo.
echo [错误] npm install 失败——请检查 Node.js（https://nodejs.org/）与网络。
echo.
pause
exit /b 1

:build_failed
echo.
echo [错误] dist 构建失败——查看上方 esbuild 报错信息。
echo [提示] 若只想预览：已有 dist\ 可直接双击 dist\play.cmd。
echo.
pause
exit /b 1
