"""WebSurf 开发服务器：为 WASM + BSP + Worker 提供正确 MIME 类型的静态服务。

用法：python serve.py [port] [root_dir]
  - port：默认 8080
  - root_dir：服务根目录（默认 = 本脚本所在目录 src/）。
    debug/ 与 game/ 的启动脚本传各自工程目录（%~dp0），
    使 /web/index.html 能以正确 MIME 加载 /pkg WASM 与 /web/worker.js。
"""
import http.server
import socketserver
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
ROOT = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".bsp": "application/octet-stream",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".html": "text/html; charset=utf-8",
    }

    def end_headers(self):
        # Worker 模块脚本需要正确的 CORS 头才能加载
        self.send_header("Access-Control-Allow-Origin", "*")
        # crossOriginIsolated：启用 SharedArrayBuffer（共享内存输入/物理结果通道）
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # 禁止缓存：dev 产物无文件名 hash，避免浏览器缓存旧 JS
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")


with socketserver.TCPServer(("", PORT), Handler) as s:
    print(f"Serving {ROOT} at http://localhost:{PORT}/")
    print(f"  App:   http://localhost:{PORT}/web/index.html")
    print(f"  Quit:  Ctrl+C")
    sys.stdout.flush()
    try:
        s.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
