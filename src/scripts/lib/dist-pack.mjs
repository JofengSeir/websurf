/**
 * dist 打包内核 —— 三个应用工程共用的唯一实现。
 *
 * 调用方（三份都从 '../../../src/scripts/lib/dist-pack.mjs' 导入）：
 *   `apps/debug/scripts/build-dist.mjs`   `bundleIife` / `bundleEsm` /
 *       `writeEmbeddedPreamble` / `rewriteIndexToClassicScript` / `cleanDist` /
 *       `cleanStale` / `copyLicensePair` / `printTree`
 *   `apps/game/scripts/build-dist.mjs`    同上八项
 *   `apps/viewer/scripts/build-dist.mjs`  六项（不用 bundleEsm 与 copyLicensePair）
 * `commonEsbuildOptions` 与 `assertBuildFunction` 也导出，但当前没有任何外部导入方
 * （后者只被 `bundleIife` / `bundleEsm` 调用）。
 *
 * 硬约束（必须保持）：
 *   1. 本文件不 import esbuild：它只装在工程侧（各 apps/<app>/node_modules），仓库根与
 *      src/ 下都没有 node_modules。build 函数由调用方注入，未注入时
 *      `assertBuildFunction` 直接抛错，不静默产出空产物。
 *   2. 除 `node:` 内建外零裸说明符，也不 import 任何 apps/ 路径：内核位置固定，
 *      工程差异（wasm 文件名、入口、产物集）全部由参数传入。
 *   3. 判据：`git grep -nE "apps/|\.\./\.\./\.\." -- src/scripts/lib` 只命中注释。
 */
import { rm, mkdir, writeFile, readFile, copyFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 两路打包共用的 esbuild 配置：bundle / target / minify / sourcemap / write /
 * legalComments / logLevel。entryPoints、format 与写盘方式由 `bundleIife` /
 * `bundleEsm` 各自补齐。
 */
export function commonEsbuildOptions({ logLevel = 'warning', inlineImportMetaUrl = false } = {}) {
  const options = {
    bundle: true,
    target: 'es2022',
    minify: true,
    sourcemap: false,
    write: false,
    // 法律注释搬到产物末尾保留：上游 @unsurf/cs-movement 为 Apache-2.0
    // （全文见 src/phys/LICENSE，声明见 src/phys/NOTICE），勿改成 none
    legalComments: 'eof',
    logLevel,
  };
  if (inlineImportMetaUrl) {
    // 传 true 时用 define 把 import.meta.url 整体换成 JSON 字符串 'about:blank'：
    // IIFE 形态没有模块上下文，内嵌形态也不走 fetch（读取侧见
    // src/ts-shared/auth/worker-dispatch.ts）
    options.define = { 'import.meta.url': JSON.stringify('about:blank') };
  }
  return options;
}

/** 注入校验：build 必须是工程侧传入的 esbuild build 函数，否则抛错（硬约束 1 的负对照）。 */
export function assertBuildFunction(build) {
  if (typeof build !== 'function') {
    throw new Error('dist-pack: build 未注入（工程侧须 import { build } from \'esbuild\' 后传入）');
  }
  return build;
}

/** 打包为 IIFE，返回 outputFiles 首项的 text（write:false，不写盘）。 */
export async function bundleIife({ build, entry, options = {} }) {
  assertBuildFunction(build);
  const result = await build({
    ...commonEsbuildOptions({ logLevel: options.logLevel, inlineImportMetaUrl: true }),
    ...options,
    entryPoints: [entry],
    format: 'iife',
    write: false,
  });
  const file = result?.outputFiles?.[0];
  if (!file) throw new Error(`dist-pack: bundleIife 未产出文件（entry: ${entry}）`);
  return file.text;
}

/** 打包为 ESM（write:false 取文本），先 mkdir -p 目标目录再写入 outfile，返回 outfile。 */
export async function bundleEsm({ build, entry, outfile, options = {} }) {
  assertBuildFunction(build);
  const result = await build({
    ...commonEsbuildOptions({ logLevel: options.logLevel, inlineImportMetaUrl: false }),
    ...options,
    entryPoints: [entry],
    format: 'esm',
    write: false,
  });
  const file = result?.outputFiles?.[0];
  if (!file) throw new Error(`dist-pack: bundleEsm 未产出文件（entry: ${entry}）`);
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, file.text);
  return outfile;
}

/**
 * 拼装并写出 single 形态的 app.js，片段顺序为
 *   [upstreamLicense] + headerComment + globalThis.__VBSP_WASM_B64__ 赋值
 *   + [globalThis.__VBSP_WORKER_JS__ 赋值] + [globalThis.__VBSP_TEXTURES_MTZ_B64__ 赋值]
 *   + appCode
 * upstreamLicense 为空串时整段不写；workerJs / mtzB64 为 null 时对应片段整体不写。
 * 每个赋值都用 JSON.stringify 包装并以换行结尾。本函数不是全仓唯一的 __VBSP_* 拼装点：
 * `apps/viewer/scripts/build-dist.mjs` 为 multi 形态生成的 wasm-embedded.js 自己写
 * globalThis.__VBSP_WASM_B64__（fetch 失败时的内嵌回退副本）。
 * 返回 { path, bytes, preamble }：bytes 取 text.length（UTF-16 码元数），
 * apps/debug/scripts/build-dist.mjs 与 apps/game/scripts/build-dist.mjs 只取它打 MB；
 * path 与 preamble 当前无外部消费方。
 */
export async function writeEmbeddedPreamble({
  distDir,
  appFile = 'app.js',
  appCode,
  headerComment,
  upstreamLicense = '',
  wasmB64,
  workerJs = null,
  mtzB64 = null,
}) {
  if (typeof appCode !== 'string') throw new Error('dist-pack: writeEmbeddedPreamble 缺少 appCode');
  if (typeof headerComment !== 'string') throw new Error('dist-pack: writeEmbeddedPreamble 缺少 headerComment');
  const parts = [];
  if (upstreamLicense) parts.push(upstreamLicense);
  parts.push(headerComment);
  parts.push(`globalThis.__VBSP_WASM_B64__=${JSON.stringify(wasmB64)};\n`);
  if (workerJs != null) parts.push(`globalThis.__VBSP_WORKER_JS__=${JSON.stringify(workerJs)};\n`);
  if (mtzB64 != null) parts.push(`globalThis.__VBSP_TEXTURES_MTZ_B64__=${JSON.stringify(mtzB64)};\n`);
  const preamble = parts.join('');
  const text = preamble + appCode;
  await mkdir(distDir, { recursive: true });
  const target = join(distDir, appFile);
  await writeFile(target, text);
  return { path: target, bytes: text.length, preamble };
}

/**
 * 把 web/index.html 里的 <script type="module" src="./app.js"></script> 改写成
 * classic 的 <script src="./app.js"></script>（file:// 下 module script 被 CORS 拦），
 * 写到 distIndex。返回是否命中替换（false = 页面结构与预期不符，调用方须告警）。
 */
export async function rewriteIndexToClassicScript({ webIndex, distIndex }) {
  const html = await readFile(webIndex, 'utf8');
  const distHtml = html.replace(
    '<script type="module" src="./app.js"></script>',
    '<script src="./app.js"></script>',
  );
  await writeFile(distIndex, distHtml);
  return distHtml !== html;
}

/** 全量重建 dist/：先 rm -r 再 mkdir，返回 distDir（不留增量残留）。 */
export async function cleanDist(distDir) {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  return distDir;
}

/**
 * 删除 distDir 顶层不在 keep 名单里的**文件**（子目录原样保留），返回被删名字。
 * distDir 不存在时返回空数组。
 */
export async function cleanStale(distDir, keep) {
  const keepSet = new Set(keep);
  const removed = [];
  if (!existsSync(distDir)) return removed;
  for (const name of await readdir(distDir)) {
    if (keepSet.has(name)) continue;
    const p = join(distDir, name);
    if ((await stat(p)).isDirectory()) continue;
    await rm(p, { force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * 从许可证唯一源 repoRoot/srcDir 下的 LICENSE 与 NOTICE 拷贝**产物级副本**到 distDir，
 * 目标名由 targets 给定（LICENSE.cs-movement / NOTICE.cs-movement）。源缺失即抛错，
 * 不静默跳过。dist/ 里的副本属产物内容：`src/scripts/check-shared-sync.mjs`（已随 T-653 移除） 的
 * `collectAppLicenseFiles` 跳过 dist 目录，故不会把它判成「apps/ 下的第二份许可源」。
 */
export async function copyLicensePair({
  repoRoot,
  distDir,
  srcDir = 'src/phys',
  names = ['LICENSE', 'NOTICE'],
  targets = ['LICENSE.cs-movement', 'NOTICE.cs-movement'],
}) {
  const written = [];
  await mkdir(distDir, { recursive: true });
  for (let i = 0; i < names.length; i++) {
    const from = join(repoRoot, srcDir, names[i]);
    if (!existsSync(from)) {
      throw new Error(`dist-pack: 许可证唯一源缺失 ${from}（D-23 / E-08：唯一源为 ${srcDir}/，工程内不得留源副本）`);
    }
    const to = join(distDir, targets[i]);
    await copyFile(from, to);
    written.push(to);
  }
  return written;
}

/**
 * 递归目录树：目录行 `  名字/` + 子项，文件行 `  名字  N KB`（N = size / 1024 取整）。
 * 返回字符串数组，调用方 join 换行后打印。
 */
/**
 * dist 自带的**本地预览启动器**（三个文件，由构建脚本内联生成，见各工程 `scripts/build-dist.mjs`）。
 *
 * 契约（三端一致，T-628 收敛到这一份实现）：
 *   `serve.mjs` 起静态服务（补 `.wasm` / `.bsp` / `.js` / `.mjs` 的 MIME + no-cache + 允许跨域），
 *   `play.cmd`（Windows）与 `play.sh`（macOS/Linux）双击即用：只依赖 Node，
 *   不再依赖系统 Python —— Windows Store 的 python.exe 假别名会让 `where python`
 *   通过、实际却无法执行，是「本地预览起不来」反复出现的根因。
 *
 * @param appName 展示名（`WebSurf-viewer` / `WebSurf-debug` / `WebSurf-game`）
 * @param port 默认端口（viewer 8101 / debug 8081 / game 8091，与各端 dev 端口同尾数）
 * @param demoReplay 可选的示例录像（相对 dist 的路径，如 `assets/maps/surf_null_4.replay`）——
 *   只有认这条深链的端才传（当前只有 viewer）；不传时启动器里不出现示例地址那几行。
 * @returns `{ serveMjs, playCmd, playSh }`；**`playCmd` 已转 CRLF**
 *   （cmd.exe 解析 LF-only 批处理会把行撕开执行，这一步不能留给调用方）。
 */
export function distLaunchers({ appName, port, demoReplay = '' }) {
  const demoNode = demoReplay
    ? `if (existsSync(join(ROOT, 'assets'))) console.log('  Demo: http://localhost:' + PORT + '/index.html?replay=${demoReplay}');\n`
    : '';
  const serveMjs =
`#!/usr/bin/env node
/** ${appName} 静态服务器（本地预览；部署时任意静态托管均可）。
 * 用法：node serve.mjs [port]   # 默认 ${port}，服务目录 = 本脚本所在目录
 * 只依赖 Node：Windows 的 Microsoft Store python.exe 别名会让 where python 通过、
 * 实际却无法执行，因此不采用 python 版启动器。
 */
import http from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] ?? ${port});
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bsp': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
};
const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-cache',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400, HEADERS); res.end('Bad request'); return;
  }
  // '.' + pathname 让 resolve 以 ROOT 为基准；URL 已规范化 ../，编码过的 .. 由前缀判据拦下。
  const full = resolve(ROOT, '.' + pathname);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    res.writeHead(403, HEADERS); res.end('Forbidden'); return;
  }
  let file = full;
  let st;
  try { st = statSync(file); } catch {
    res.writeHead(404, HEADERS); res.end('Not found'); return;
  }
  if (st.isDirectory()) {
    const index = join(file, 'index.html');
    if (!existsSync(index)) { res.writeHead(404, HEADERS); res.end('Not found'); return; }
    file = index; st = statSync(index);
  }
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { ...HEADERS, 'Content-Type': type, 'Content-Length': st.size });
  if ((req.method ?? 'GET') === 'HEAD') { res.end(); return; }
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
  process.stderr.write((req.socket.remoteAddress ?? '-') + ' - "' + req.method + ' ' + req.url + '" 200 -\\n');
});

// PID 文件供仓库内 dev-port.mjs / stop.cmd 精确识别并回收（只认 PID 匹配的 node.exe）。
const PID_FILE = join(ROOT, '.dev-server-' + PORT + '.pid');
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

server.on('error', (e) => {
  cleanup();
  console.error('[ERROR] port ' + PORT + ' cannot listen: ' + e.message);
  console.error('[HINT] use another port: node serve.mjs ' + (PORT + 1));
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  writeFileSync(PID_FILE, String(process.pid));
  console.log('Serving ' + ROOT + ' at http://localhost:' + PORT + '/');
  console.log('  App:  http://localhost:' + PORT + '/index.html');
${demoNode}  console.log('  Quit: Ctrl+C');
});
`;
  const demoEchoCmd = demoReplay
    ? `echo   demo    http://localhost:%PORT%/index.html?replay=${demoReplay}
`
    : '';
  const playCmd = (
`@echo off
chcp 65001 >nul
rem ${appName} local preview: serve dist and open browser (Windows)
rem usage: play.cmd [port] (default ${port}; close this window to stop, Ctrl+C also works)
setlocal EnableExtensions
cd /d "%~dp0"

set PORT=${port}
if not "%~1"=="" set PORT=%~1

rem -- toolchain: Node only (no system Python needed) --
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found -- install Node.js ^(https://nodejs.org/^).
  echo [HINT] The Store python.exe alias is not enough; this launcher needs Node.js.
  pause
  exit /b 1
)

echo ============================================================
echo  ${appName} local preview ^(close this window to stop^)
echo   page    http://localhost:%PORT%/index.html
${demoEchoCmd}echo ============================================================
rem open browser after 1s (async, does not block server startup)
start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%/index.html"
node serve.mjs %PORT%
`
  ).replace(/\n/g, '\r\n');
  const demoEchoSh = demoReplay
    ? `echo "  示例    http://localhost:$PORT/index.html?replay=${demoReplay}"
`
    : '';
  const playSh = `#!/usr/bin/env bash
# ${appName} 本地预览：起静态服务并自动打开浏览器（macOS/Linux）
# 用法：./play.sh [port]（默认 ${port}；关闭本窗口即停止服务，Ctrl+C 亦可）
set -e
cd "$(dirname "$0")"
PORT="\${1:-${port}}"

open_browser() {
  ( sleep 1
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$PORT/index.html" >/dev/null 2>&1
    elif command -v open >/dev/null 2>&1; then open "http://localhost:$PORT/index.html" >/dev/null 2>&1
    fi
  ) &
}

if ! command -v node >/dev/null 2>&1; then
  echo "[HINT] 未找到 node —— 请安装 Node.js（https://nodejs.org/）。"
  exit 1
fi

echo "============================================================"
echo " ${appName} 本地预览（关闭本窗口即停止服务；Ctrl+C 亦可）"
echo "  普通页  http://localhost:$PORT/index.html"
${demoEchoSh}echo "============================================================"
open_browser
exec node serve.mjs "$PORT"
`;
  return { serveMjs, playCmd, playSh };
}

/**
 * `cleanStale` 的保留名单里要带上启动器三个文件名 —— 漏了会在下一步被当成残留删掉。
 */
export const DIST_LAUNCHER_FILES = ['serve.mjs', 'play.cmd', 'play.sh'];

export async function printTree(dir) {
  const out = [];
  for (const name of (await readdir(dir)).sort()) {
    const p = join(dir, name);
    const st = await stat(p);
    if (st.isDirectory()) out.push(`  ${name}/` + (await printTree(p)).join(''));
    else out.push(`  ${name}  ${(st.size / 1024).toFixed(0)} KB`);
  }
  return out;
}
