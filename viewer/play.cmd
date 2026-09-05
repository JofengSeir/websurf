@echo off
chcp 65001 >nul
rem WebSurf-viewer 源码工作区双击入口：起本地服务器并自动打开浏览器（Windows）。
rem 实际逻辑在 dist/play.cmd（构建产物自包含，拷走/部署时依然可用）；本文件只是快捷方式。
setlocal EnableExtensions
cd /d "%~dp0"
if not exist "dist\play.cmd" (
  echo [错误] 尚未构建 dist/：请先在 viewer/ 目录运行  npm run build:dist
  rem 或 npm run build（= build:wasm + build:ts 后再 build:dist）
  pause
  exit /b 1
)
call "dist\play.cmd" %*