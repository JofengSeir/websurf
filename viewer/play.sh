#!/usr/bin/env bash
# WebSurf-viewer 源码工作区双击入口：起本地服务器并自动打开浏览器（macOS/Linux）。
# 实际逻辑在 dist/play.sh（构建产物自包含，拷走/部署时依然可用）；本文件只是快捷方式。
set -e
cd "$(dirname "$0")"
if [ ! -f "dist/play.sh" ]; then
  echo "[错误] 尚未构建 dist/：请先在 viewer/ 目录运行  npm run build:dist" >&2
  echo "       或 npm run build（= build:wasm + build:ts 后再 build:dist）" >&2
  exit 1
fi
exec ./dist/play.sh "$@"