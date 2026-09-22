/**
 * 构建 WebSurf-game 的 dist/，两种形态（命令行含 --multi 走 multi）：
 *
 * ── single（缺省，file:// 双击可跑）──────────────────────────────
 *   dist/index.html — 由 web/index.html 改写：module script 换成 classic script
 *   dist/app.js     — IIFE：先由 writeEmbeddedPreamble 前置 __VBSP_WASM_B64__ /
 *                     __VBSP_WORKER_JS__ / __VBSP_TEXTURES_MTZ_B64__ 三个全局键，再接 app 代码
 *   dist/styles.css — web/styles.css 原样拷贝
 *   dist/LICENSE.cs-movement、dist/NOTICE.cs-movement — 许可证产物级副本
 *
 * ── multi（--multi，GitHub Pages / 任意 HTTP 托管）───────────────
 *   dist/index.html — web/index.html 原样拷贝（保留 module script）
 *   dist/app.js     — ESM，前缀注入 globalThis.__VBSP_WASM_URL__ = './websurf_wasm_bg.wasm'
 *   dist/worker.js  — ESM（module worker）
 *   dist/styles.css — web/styles.css 原样拷贝
 *   dist/websurf_wasm_bg.wasm、dist/textures.mtz — 外置，由页面按 URL 取
 *   dist/coi-serviceworker.js — 由 web/coi-serviceworker.js 注入预缓存清单与内容哈希缓存名
 *   dist/LICENSE.cs-movement、dist/NOTICE.cs-movement — 许可证产物级副本
 *
 * 运行时回退（实现在 apps/game/src/app.ts 与 src/ts-shared/auth/shared-state.ts）：
 *   __VBSP_WORKER_JS__ 存在 → Worker 用 Blob URL 装载（file:// 下 module worker 被 CORS 拒）；
 *   __VBSP_WASM_B64__ 存在 → initSync 同步实例化（file:// 下无法 fetch）；
 *   SharedArrayBuffer 不可用 → 输入/物理通道落到 MsgState 的 postMessage 回退；
 *   __VBSP_TEXTURES_MTZ_B64__ 在 apps/game/src 内当前没有读取点（apps/debug 侧有）。
 *
 * 打包内核（esbuild 由本脚本注入、cleanDist 先删后建、__VBSP_ 前缀拼装、许可证唯一源拷贝）：
 *   src/scripts/lib/dist-pack.mjs
 *
 * 用法：node scripts/build-dist.mjs [--multi]（也可 npm run build:dist）。输入缺失即抛错：
 *   apps/game/pkg/websurf_wasm_bg.wasm（先 npm run build:wasm）与 src/materials/textures.mtz。
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleIife,
  bundleEsm,
  writeEmbeddedPreamble,
  rewriteIndexToClassicScript,
  cleanDist,
  cleanStale,
  copyLicensePair,
  printTree,
} from '../../../src/scripts/lib/dist-pack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..'); // apps/game
const REPO = join(ROOT, '..', '..'); // 仓库根
const DIST = join(ROOT, 'dist'); // 产物目录：cleanDist 会整目录先删再建
const INDEX_HTML = join(ROOT, 'web', 'index.html'); // single 改写它、multi 原样拷贝
const STYLES = join(ROOT, 'web', 'styles.css'); // 两种形态都原样拷贝
const WASM_FILE = 'websurf_wasm_bg.wasm'; // 外置 wasm 的文件名，multi 下同时用作 URL
const MTZ = join(REPO, 'src', 'materials', 'textures.mtz'); // 默认纹理包（仓库根共享资产）

const HEADER = '/* WebSurf-game embedded build — auto-generated, do not edit */\n'; // 内嵌形态 app.js 的 banner

// single 形态保留的 dist/ 顶层文件（cleanStale 按它删掉多余文件）
const KEEP_SINGLE = ['index.html', 'app.js', 'styles.css', 'LICENSE.cs-movement', 'NOTICE.cs-movement'];
// multi 形态保留的 dist/ 顶层文件（多出 worker.js、外置 wasm / 纹理包与 coi-serviceworker.js）
const KEEP_MULTI = [
  'index.html',
  'app.js',
  'worker.js',
  'styles.css',
  WASM_FILE,
  'textures.mtz',
  'coi-serviceworker.js',
  'LICENSE.cs-movement',
  'NOTICE.cs-movement',
];

const multi = process.argv.includes('--multi'); // 形态开关：含 --multi 即多文件 ESM

/** 校验两个输入存在（pkg 的 wasm 与仓库根的默认纹理包），返回 wasm 绝对路径；缺任一即抛错。 */
function requireInputs() {
  const wasm = join(ROOT, 'pkg', WASM_FILE);
  if (!existsSync(wasm)) {
    throw new Error(`${wasm} 不存在（先运行 npm run build:wasm）`);
  }
  if (!existsSync(MTZ)) {
    throw new Error(`默认纹理包不存在（${MTZ}）`);
  }
  return wasm;
}

/** single：IIFE 加三个内嵌全局键，并把 index.html 改写成 classic script（file:// 双击可用）。 */
async function buildSingle(wasmPath) {
  console.log('[5/5] 编码 WASM (base64)...');
  const wasmB64 = readFileSync(wasmPath).toString('base64');

  console.log('[5/5] 编码默认纹理包 (base64)...');
  const mtzB64 = readFileSync(MTZ).toString('base64');

  console.log('[5/5] 打包 worker (IIFE，Blob URL 用)...');
  // worker 打成 IIFE：文本经 __VBSP_WORKER_JS__ 内嵌，运行时由 apps/game/src/app.ts 做 Blob URL
  const workerJs = await bundleIife({
    build,
    entry: join(ROOT, 'src', 'worker', 'main.ts'),
    options: { logLevel: 'info' },
  });

  console.log('[5/5] 打包 app (IIFE)...');
  // app 打成 IIFE：与内嵌前缀一起写成 dist/app.js
  const appCode = await bundleIife({
    build,
    entry: join(ROOT, 'src', 'app.ts'),
    options: { logLevel: 'info' },
  });

  console.log('[5/5] 写入 dist/（classic index.html + 内嵌 app.js + styles.css）...');
  const { bytes } = await writeEmbeddedPreamble({
    distDir: DIST,
    appCode,
    headerComment: HEADER,
    wasmB64,
    workerJs,
    mtzB64,
  });
  const rewritten = await rewriteIndexToClassicScript({
    webIndex: INDEX_HTML,
    distIndex: join(DIST, 'index.html'),
  });
  // 未命中替换串时只告警：dist/index.html 仍是 module script，file:// 下打不开
  if (!rewritten) {
    console.warn('[WARN] web/index.html 未命中 module script 特征串，dist/index.html 可能仍是 module script。');
  }
  copyFileSync(STYLES, join(DIST, 'styles.css')); // 样式表外置（两种形态都拷贝）
  console.log(`[5/5] dist/app.js: ${(bytes / 1024 / 1024).toFixed(2)} MB（single 全内嵌）`);
}

/** multi：分文件 ESM 加外置 wasm / 纹理包（HTTP 托管下 fetch 可用，产物比 single 小）。 */
async function buildMulti(wasmPath) {
  console.log('[5/5] 打包 app / worker (ESM)...');
  await bundleEsm({
    build,
    entry: join(ROOT, 'src', 'app.ts'),
    outfile: join(DIST, 'app.js'),
    options: { logLevel: 'info' },
  });
  await bundleEsm({
    build,
    entry: join(ROOT, 'src', 'worker', 'main.ts'),
    outfile: join(DIST, 'worker.js'),
    options: { logLevel: 'info' },
  });

  // 在 app.js 最前面插入 __VBSP_WASM_URL__：multi 形态由页面按相对 dist/ 的路径 fetch wasm
  const appPath = join(DIST, 'app.js');
  writeFileSync(
    appPath,
    `/* WebSurf multi-file build — auto-generated, do not edit */\n` +
      `globalThis.__VBSP_WASM_URL__=${JSON.stringify('./' + WASM_FILE)};\n` +
      readFileSync(appPath, 'utf8'),
  );

  console.log('[5/5] 复制 WASM / 默认纹理包...');
  copyFileSync(wasmPath, join(DIST, WASM_FILE));
  copyFileSync(MTZ, join(DIST, 'textures.mtz'));  // 默认纹理包外置

  console.log('[5/5] 复制 index.html / styles.css（module script 原样）...');
  copyFileSync(INDEX_HTML, join(DIST, 'index.html'));
  copyFileSync(STYLES, join(DIST, 'styles.css'));

  // coi-serviceworker.js：静态托管上用 SW 给响应补 COOP/COEP 头，使页面 crossOriginIsolated；
  // 这里生成预缓存清单，并把清单与缓存名注入 SW 模板（multi 形态专用）。
  const precacheManifest = [
    './index.html',
    './app.js',
    './worker.js',
    './' + WASM_FILE,
    './textures.mtz',
    './styles.css',
    './coi-serviceworker.js',
  ].filter((f) => existsSync(join(DIST, f.slice(2)))); // 只留 dist/ 内实际存在的文件（清单项带 './' 前缀，故先切片）

  // 读 SW 模板，按占位符声明行整行替换；下面的 includes 检查即断言替换确实命中
  const swTemplate = readFileSync(join(ROOT, 'web', 'coi-serviceworker.js'), 'utf8');
  // 缓存名按「预缓存内容哈希」派生：内容变 → SW 文件字节变 → 浏览器触发 install → 缓存刷新；
  // 固定缓存名会导致 SW 字节不变、缓存永不更新，部署后用户长期拿到旧 app.js。
  const cacheHash = createHash('sha256');
  cacheHash.update(JSON.stringify(precacheManifest));
  for (const entry of precacheManifest) {
    const abs = join(DIST, entry.slice(2));
    if (existsSync(abs)) { cacheHash.update(entry); cacheHash.update(readFileSync(abs)); }
  }
  const cacheName = 'websurf-coi-' + cacheHash.digest('hex').slice(0, 12);
  const swWithManifest = swTemplate
    .replace(
      'const PRECACHE_MANIFEST =\n  typeof __PRECACHE_MANIFEST__ === "object" && __PRECACHE_MANIFEST__ ? __PRECACHE_MANIFEST__ : [];',
      `const PRECACHE_MANIFEST = ${JSON.stringify(precacheManifest)};`
    )
    .replace(
      'const CACHE_NAME = typeof __CACHE_NAME__ === "string" ? __CACHE_NAME__ : "websurf-coi-dev";',
      `const CACHE_NAME = ${JSON.stringify(cacheName)};`
    );
  // 占位符没被替换掉即抛错：不发出仍带占位符的 SW（否则清单与缓存名都不生效）
  if (
    swWithManifest.includes('typeof __PRECACHE_MANIFEST__') ||
    swWithManifest.includes('typeof __CACHE_NAME__')
  ) {
    throw new Error(
      '[build-dist] SW 占位符未被替换：web/coi-serviceworker.js 的声明行与构建脚本不一致'
    );
  }
  writeFileSync(join(DIST, 'coi-serviceworker.js'), swWithManifest);
  console.log(`[5/5] 注入 SW 预缓存清单: ${precacheManifest.length} 个资源`);
}

async function main() {
  const wasmPath = requireInputs();

  // 全量重建：先删后建（cleanDist），落盘后再由 cleanStale 删掉不在保留名单里的文件
  await cleanDist(DIST);

  if (multi) await buildMulti(wasmPath);
  else await buildSingle(wasmPath);

  // 许可证产物级副本：唯一源是 src/phys/ 的 LICENSE / NOTICE（copyLicensePair 缺源即抛错）
  await copyLicensePair({
    repoRoot: REPO,
    distDir: DIST,
    srcDir: 'src/phys',
    targets: ['LICENSE.cs-movement', 'NOTICE.cs-movement'],
  });

  await cleanStale(DIST, multi ? KEEP_MULTI : KEEP_SINGLE);
  console.log((await printTree(DIST)).join('\n'));
}

// 顶层失败：打印错误与提示后以退出码 1 结束
main().catch((err) => {
  console.error(`[ERROR] dist build failed: ${err?.message ?? err}`);
  console.error('[HINT] See the message above, fix the input or toolchain, then retry.');
  process.exit(1);
});
