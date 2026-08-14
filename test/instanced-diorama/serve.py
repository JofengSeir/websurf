"""instanced-diorama 开发服务器：test 根 + /maps/ 别名到仓库 maps/（BSP 模式验证用）。

用法：python serve.py [port]
  - 根目录 = 本脚本所在目录（test/instanced-diorama/）
  - /maps/* 映射到仓库 maps/ 目录（?bsp=maps/xxx.bsp 直接加载）
"""
import http.server
import socketserver
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
ROOT = os.path.dirname(os.path.abspath(__file__))
MAPS = os.path.normpath(os.path.join(ROOT, '..', '..', 'maps'))

os.chdir(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.wasm': 'application/wasm',
        '.bsp': 'application/octet-stream',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
    }

    def translate_path(self, path):
        parts = path.split('?', 1)[0].split('#', 1)[0].strip('/').split('/')
        if parts and parts[0] == 'maps':
            return os.path.join(MAPS, *parts[1:])
        return super().translate_path(path)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")


with socketserver.TCPServer(('', PORT), Handler) as s:
    print(f"Serving {ROOT} at http://localhost:{PORT}/")
    print(f"  Maps: {MAPS}")
    print(f"  Quit: Ctrl+C")
    sys.stdout.flush()
    try:
        s.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
