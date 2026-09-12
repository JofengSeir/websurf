/**
 * 构建 WebSurf-game dist/，双模式（薄入口，D-04 / T-04）：
 *
 * ── single（默认，本地双击 file://）─────────────────────────────
 *   dist/index.html — classic script（file:// 下 module 被 CORS 拦截）
 *   dist/app.js     — IIFE，内嵌 WASM(base64) + Worker 代码(Blob URL) + 默认纹理包(base64)
 *   dist/styles.css — 外置样式表（web/styles.css 原样拷贝）
 *   dist/LICENSE.cs-movement、dist/NOTICE.cs-movement — 产物级许可证副本
 *   file:// 兼容：MsgState 回退（无 SAB）+ initSync（wasm 内嵌）+ Blob Worker
 *
 * ── multi（--multi，GitHub Pages / HTTP 部署）─────────────────
 *   dist/index.html — module script
 *   dist/app.js     — ESM（前缀注入 __VBSP_WASM_URL__）
 *   dist/worker.js  — ESM（module worker）
 *   dist/styles.css — 外置样式表（web/styles.css 原样拷贝）
 *   dist/websurf_wasm_bg.wasm — WASM 外置（fetch；dev/multi 路径统一为 './websurf_wasm_bg.wasm'）
 *   dist/textures.mtz         — 默认纹理包外置（公共资源，HTTP fetch 可用）
 *   dist/LICENSE.cs-movement、dist/NOTICE.cs-movement — 产物级许可证副本
 *
 * 打包内核（esbuild 注入、cleanDist 先删后建、__VBSP_* 拼装、许可证唯一源拷贝）：
 *   ../../../src/scripts/lib/dist-pack.mjs
 *
 * 用法：node scripts/build-dist.mjs [--multi]
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
const DIST = join(ROOT, 'dist');
const INDEX_HTML = join(ROOT, 'web', 'index.html');
const STYLES = join(ROOT, 'web', 'styles.css');
const WASM_FILE = 'websurf_wasm_bg.wasm';
const MTZ = join(REPO, 'src', 'materials', 'textures.mtz');

const HEADER = '/* WebSurf-game embedded build — auto-generated, do not edit */\n';

const KEEP_SINGLE = ['index.html', 'app.js', 'styles.css', 'LICENSE.cs-movement', 'NOTICE.cs-movement'];
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

const multi = process.argv.includes('--multi');

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

/** single：单文件 IIFE，WASM + Worker 内嵌（file:// 双击可用）。 */
async function buildSingle(wasmPath) {
  console.log('[5/5] 编码 WASM (base64)...');
  const wasmB64 = readFileSync(wasmPath).toString('base64');

  console.log('[5/5] 编码默认纹理包 (base64)...');
  const mtzB64 = readFileSync(MTZ).toString('base64');

  console.log('[5/5] 打包 worker (IIFE，Blob URL 用)...');
  const workerJs = await bundleIife({
    build,
    entry: join(ROOT, 'src', 'worker', 'main.ts'),
    options: { logLevel: 'info' },
  });

  console.log('[5/5] 打包 app (IIFE)...');
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
  if (!rewritten) {
    console.warn('[WARN] web/index.html 未命中 module script 特征串，dist/index.html 可能仍是 module script。');
  }
  copyFileSync(STYLES, join(DIST, 'styles.css'));
  console.log(`[5/5] dist/app.js: ${(bytes / 1024 / 1024).toFixed(2)} MB（single 全内嵌）`);
}

/** multi：多文件 ESM（HTTP 部署，fetch 正常，体积更小）。 */
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

  // app.js 前缀注入 WASM URL（multi 模式下 fetch 相对 dist/ 的 wasm）
  const appPath = join(DIST, 'app.js');
  writeFileSync(
    appPath,
    `/* WebSurf multi-file build — auto-generated, do not edit */\n` +
      `globalThis.__VBSP_WASM_URL__=${JSON.stringify('./' + WASM_FILE)};\n` +
      readFileSync(appPath, 'utf8'),
  );

  console.log('[5/5] 复制 WASM / 默认纹理包...');
  copyFileSync(wasmPath, join(DIST, WASM_FILE));
  copyFileSync(MTZ, join(DIST, 'textures.mtz'));  // COI serviceworker：静态托管上注入 COOP/COEP → crossOriginIsolated → SAB 可用

  console.log('[5/5] 复制 index.html / styles.css（module script 原样）...');
  copyFileSync(INDEX_HTML, join(DIST, 'index.html'));
  copyFileSync(STYLES, join(DIST, 'styles.css'));

  // 生成预缓存清单并注入 SW（multi 模式专用）
  const precacheManifest = [
    './index.html',
    './app.js',
    './worker.js',
    './' + WASM_FILE,
    './textures.mtz',
    './styles.css',
    './coi-serviceworker.js',
  ].filter((f) => existsSync(join(DIST, f.slice(2)))); // 仅存在的文件（去掉 './' 前缀）

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

  // 全量重建：先删后建（规范 §5.2 R-15，禁止增量残留）
  await cleanDist(DIST);

  if (multi) await buildMulti(wasmPath);
  else await buildSingle(wasmPath);

  // 许可证产物级副本：唯一源 src/phys/{LICENSE,NOTICE}（D-23 / E-08）
  await copyLicensePair({
    repoRoot: REPO,
    distDir: DIST,
    srcDir: 'src/phys',
    targets: ['LICENSE.cs-movement', 'NOTICE.cs-movement'],
  });

  await cleanStale(DIST, multi ? KEEP_MULTI : KEEP_SINGLE);
  console.log((await printTree(DIST)).join('\n'));
}

main().catch((err) => {
  console.error(`[ERROR] dist build failed: ${err?.message ?? err}`);
  console.error('[HINT] See the message above, fix the input or toolchain, then retry.');
  process.exit(1);
});
