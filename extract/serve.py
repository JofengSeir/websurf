#!/usr/bin/env python3
"""bsp-extract 本地预览服务器。

服务根目录 = extract/(含 /web/ 与 /viewer/);启动时向仓库根开放 ../maps/ 供查看器加载示例。
用法:python serve.py [端口,默认 8280]
"""
import http.server
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent  # 仓库根

# 服务根 = 仓库根:统一暴露 /extract/、/maps/、/game/ 等
SERVE_ROOT = REPO

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SERVE_ROOT), **kwargs)

    def end_headers(self):
        # wasm 需要正确的 MIME;查看器允许跨目录读 maps/
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def guess_type(self, path):
        if path.endswith(".wasm"):
            return "application/wasm"
        if path.endswith(".glb"):
            return "model/gltf-binary"
        if path.endswith(".js"):
            return "text/javascript"
        if path.endswith(".mjs"):
            return "text/javascript"
        return super().guess_type(path)

def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8280
    with socketserver.TCPServer(("", port), Handler) as httpd:
        print(f"bsp-extract 预览: http://localhost:{port}/extract/web/")
        print(f"GLB Viewer       : http://localhost:{port}/extract/viewer/")
        print(f"示例地图          : http://localhost:{port}/extract/viewer/?file=/maps/surf_666.glb")
        httpd.serve_forever()

if __name__ == "__main__":
    main()
