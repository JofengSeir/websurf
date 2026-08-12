#!/usr/bin/env python3
"""bsp-extract 本地预览服务器。用法:python serve.py [端口,默认 8280]"""
import http.server
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # wasm 需要正确的 MIME
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def guess_type(self, path):
        if path.endswith(".wasm"):
            return "application/wasm"
        return super().guess_type(path)

def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8280
    with socketserver.TCPServer(("", port), Handler) as httpd:
        print(f"bsp-extract 预览: http://localhost:{port}/web/")
        httpd.serve_forever()

if __name__ == "__main__":
    main()
