#!/usr/bin/env node
/**
 * WebSurf 开发服务器（Node 版；与 src/scripts/serve.py 等价，且不依赖系统 Python）。
 *
 * 用法：node src/scripts/serve.mjs [port] [root_dir]
 *   - port：默认 8080
 *   - root_dir：服务根目录，默认 = 当前工作目录。dev.cmd 传各自工程目录（服务根 = 工程根
 *     ⇒ /web/index.html 可访问）；start.cmd 传 dist 目录本身 ⇒ 页面走 /index.html。
 *
 * 为什么存在：三端 dev.cmd / npm run dev / start.cmd 原先都调用 `python serve.py`。
 * Windows 上 `where python` 常命中 Microsoft Store 的 App Execution Alias
 * （C:\Users\<u>\AppData\Local\Microsoft\WindowsApps\python.exe）——where 返回 0，
 * 但实际执行静默失败 / exit 9009。于是「工具链检查通过、构建全过、服务器窗口空白、
 * 就绪探测 10 秒 fetch failed」成了反复出现的故障。Node 在 dev 链里已被 build:ts /
 * build:wasm / check:api 证明可用，故把静态服务也收敛到 Node，彻底移除 Python 运行时依赖。
 *
 * 与 serve.py 的等价点：
 *   - bind 到 0.0.0.0:<port>（python 的 ("", PORT)），127.0.0.1 可直达；
 *   - 所有响应（含 3xx / 4xx / 5xx）都带 Access-Control-Allow-Origin: *、
 *     Cross-Origin-Opener-Policy: same-origin、Cross-Origin-Embedder-Policy: require-corp
 *     ⇒ 页面 crossOriginIsolated，SharedArrayBuffer 可用；
 *   - Cache-Control: no-store；.wasm / .bsp / .js / .mjs / .html 的 MIME 覆盖；
 *   - 访问日志写 stderr，stdout 只留启动提示；端口占用时明确报错并 exit 1。
 * 有意差异：目录且无 index.html 时返回 404，不生成 python 版那种目录列表（dev 链不需要）。
 *
 * 另外启动时把自身 PID 写到 .tmp/dev-server-<port>.pid，供 dev-port.mjs 精确识别并
 * 回收「上一次的 WebSurf 服务」，避免误杀占用同一端口的其它 node 进程。
 */
import http from 'node:http';
import {
  createReadStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..', '..');

const port = Number(process.argv[2] ?? 8080);
const root = resolve(process.argv[3] ?? process.cwd());

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[serve] invalid port: ${process.argv[2]}`);
  process.exit(1);
}
if (!existsSync(root)) {
  console.error(`[serve] serve root does not exist: ${root}`);
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bsp': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.vtf': 'application/octet-stream',
  '.vmt': 'text/plain; charset=utf-8',
  '.dem': 'application/octet-stream',
  '.replay': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.mp4': 'video/mp4',
};

const BASE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
};

function send(res, status, body, contentType, headOnly) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': contentType,
    'Content-Length': buf.length,
  });
  res.end(headOnly ? undefined : buf);
}

const TEXT = 'text/plain; charset=utf-8';
const HTML = 'text/html; charset=utf-8';

const server = http.createServer((req, res) => {
  const method = (req.method ?? 'GET').toUpperCase();
  const headOnly = method === 'HEAD';
  if (method !== 'GET' && method !== 'HEAD') {
    send(res, 501, 'Unsupported method\n', TEXT, headOnly);
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    send(res, 400, 'Bad request\n', TEXT, headOnly);
    return;
  }
  if (pathname.includes('\0')) {
    send(res, 400, 'Bad request\n', TEXT, headOnly);
    return;
  }

  const rel = pathname.replace(/\\/g, '/').replace(/^\/+/, '');
  let full = resolve(root, rel);
  // 防目录穿越：URL 里编码过的 .. 在这里统一被前缀判据拦下。
  if (full !== root && !full.startsWith(root + sep)) {
    send(res, 403, 'Forbidden\n', TEXT, headOnly);
    return;
  }

  let st;
  try {
    st = statSync(full);
  } catch {
    send(res, 404, 'Not found\n', TEXT, headOnly);
    return;
  }
  if (st.isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { ...BASE_HEADERS, Location: `${pathname}/`, 'Content-Length': 0 });
      res.end();
      return;
    }
    const index = join(full, 'index.html');
    if (!existsSync(index)) {
      send(res, 404, 'Not found\n', TEXT, headOnly);
      return;
    }
    full = index;
    st = statSync(index);
  }

  const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': type,
    'Content-Length': st.size,
    'Last-Modified': st.mtime.toUTCString(),
  });
  if (headOnly) {
    res.end();
  } else {
    const stream = createReadStream(full);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
  process.stderr.write(`${req.socket.remoteAddress ?? '-'} - "${method} ${req.url}" 200 -\n`);
});

const pidFile = join(REPO, '.tmp', `dev-server-${port}.pid`);
mkdirSync(dirname(pidFile), { recursive: true });
writeFileSync(pidFile, String(process.pid));

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) unlinkSync(pidFile);
  } catch { /* 文件或被别的端口清理过 */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

server.on('error', (e) => {
  cleanup();
  if (/** @type {NodeJS.ErrnoException} */ (e).code === 'EADDRINUSE') {
    console.error(`[ERROR] port ${port} is already in use: ${e.message}`);
    console.error(`[HINT] use another port, or inspect: node src/scripts/dev-port.mjs ${port} --check-only`);
  } else {
    console.error(`[ERROR] cannot start server: ${e.message}`);
  }
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  const appPath = existsSync(join(root, 'web', 'index.html')) ? 'web/index.html' : 'index.html';
  console.log(`Serving ${root} at http://localhost:${port}/`);
  console.log(`  App:   http://localhost:${port}/${appPath}`);
  console.log('  Quit:  Ctrl+C');
});
