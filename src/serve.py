"""WebSurf 开发服务器：为 WASM / BSP / Worker 提供正确 MIME 类型的静态服务。

用法：python serve.py [port] [root_dir]
  - port：默认 8080
  - root_dir：服务根目录（默认 = 本脚本所在目录，即仓库根的 src/）。
    启动时 os.chdir 到该目录，之后由 SimpleHTTPRequestHandler 按当前工作目录取文件。
    三个工程的 start-dev.cmd 与 debug/game 的 play.cmd 都传各自工程目录（"%~dp0."），
    三个 package.json 的 dev 脚本各传 "."，使 /web/index.html 能加载 /pkg 下的 WASM
    与 /web/worker.js。

本模块顶层即建服务器并 serve_forever（没有 __main__ 守卫）：导入即启动。
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
        # 放开跨源取用：所有响应都带 Access-Control-Allow-Origin: *
        self.send_header("Access-Control-Allow-Origin", "*")
        # COOP + COEP → 页面 crossOriginIsolated，SharedArrayBuffer 可用；主线程据此在
        # SAB 通道与 postMessage 回退之间二选一（src/ts-shared/auth/shared-state.ts
        # 的 createMainSharedState）。
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # 禁用缓存：本服务只服务本地开发，产物是固定文件名（没有内容 hash），
        # 禁缓存避免页面拿到旧的 JS / WASM
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # 访问日志走 stderr，stdout 只留启动提示
    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")


class Server(socketserver.TCPServer):
    # socketserver.TCPServer.server_bind 会读这个类属性并转成 SO_REUSEADDR：
    # 关窗后立刻重开不会被 TIME_WAIT 卡住；已被活动进程占用的端口照样 bind 失败，
    # 由下方的 OSError 分支打印原因与换端口提示
    allow_reuse_address = True


try:
    server = Server(("", PORT), Handler)
except OSError as e:
    print(f"[ERROR] 端口 {PORT} 无法监听：{e}")
    print(f"[HINT] 端口可能已被占用——换一个端口：python serve.py {PORT + 1}")
    sys.exit(1)

with server:
    print(f"Serving {ROOT} at http://localhost:{PORT}/")
    print(f"  App:   http://localhost:{PORT}/web/index.html")
    print(f"  Quit:  Ctrl+C")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
