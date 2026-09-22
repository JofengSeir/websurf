/**
 * 构建 apps/debug 的 dist/：同一入口出两种形态（薄入口，`--multi` 切换）。
 *
 * ── single（默认，本地 file:// 双击）──────────────────────────────
 *   dist/index.html — 由 web/index.html 改写而来：module script 换成 classic script
 *   dist/app.js     — IIFE；前缀由 `src/scripts/lib/dist-pack.mjs` 的 `writeEmbeddedPreamble` 拼装：
 *                     上游许可证 + 构建头注释 + `__VBSP_WASM_B64__` / `__VBSP_WORKER_JS__` /
 *                     `__VBSP_TEXTURES_MTZ_B64__` 三个全局键（WASM、Worker 源码、默认纹理包全内嵌）；
 *                     页面侧据此建 Blob URL 起 worker，并把 WASM 与纹理包交给 worker
 *   dist/LICENSE.cs-movement、dist/NOTICE.cs-movement — 许可证的产物级副本
 *
 * ── multi（--multi，HTTP 部署）───────────────────────────────────
 *   dist/index.html — 原样复制 web/index.html
 *   dist/app.js     — ESM，文件头注入 `globalThis.__VBSP_WASM_URL__`（指向同目录的 wasm 文件）
 *   dist/worker.js  — ESM（module worker）
 *   dist/websurf_wasm_bg.wasm、dist/textures.mtz — 外置，页面侧 fetch
 *   dist/coi-serviceworker.js — 由 web/coi-serviceworker.js 生成：把预缓存清单与按清单内容
 *                     派生的缓存名写进脚本；两个占位符若有残留即抛错（不产出半成品）
 *   dist/LICENSE.cs-movement、dist/NOTICE.cs-movement — 许可证的产物级副本
 *
 * 共用内核：`src/scripts/lib/dist-pack.mjs`（esbuild 的 build 由本脚本注入；`cleanDist` 先删后建；
 * `cleanStale` 按形态的 keep 名单清残留；许可证的唯一源是 `src/phys` 下的 LICENSE 与 NOTICE）。
 * 顺序：校验输入 → 清空 dist/ → 打包 → 拷许可证 → 按名单清残留 → 打印产物树。
 * 输入缺失（`apps/debug/pkg/websurf_wasm_bg.wasm` 或 `src/materials/textures.mtz`）即抛错，
 * 顶层 catch 打印 `[ERROR]` 与 `[HINT]` 后以 1 退出。
 *
 * 用法：node scripts/build-dist.mjs [--multi]        （`npm run build:dist` 走默认 single）
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
const ROOT = join(HERE, '..'); // 本工程目录 apps/debug
const REPO = join(ROOT, '..', '..'); // 仓库根（apps/debug 的上两级）
const DIST = join(ROOT, 'dist');
const INDEX_HTML = join(ROOT, 'web', 'index.html');
const WASM_FILE = 'websurf_wasm_bg.wasm';
const MTZ = join(REPO, 'src', 'materials', 'textures.mtz');

const HEADER = '/* WebSurf single-file build — auto-generated, do not edit */\n';
const UPSTREAM_LICENSE =
  '/*!\n' +
  ' * @license\n' +
  ' * @unsurf/cs-movement — Counter-Strike style movement physics\n' +
  ' * Copyright 2026 unsurf\n' +
  ' * SPDX-License-Identifier: Apache-2.0\n' +
  ' * (modified by WebSurf — see NOTICE.cs-movement)\n' +
  ' */\n';

const KEEP_SINGLE = ['index.html', 'app.js', 'LICENSE.cs-movement', 'NOTICE.cs-movement'];
const KEEP_MULTI = [
  'index.html',
  'app.js',
  'worker.js',
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

/** single 形态：单文件 IIFE，WASM / Worker 源码 / 默认纹理包全部内嵌。 */
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

  console.log('[5/5] 写入 dist/（classic index.html + 内嵌 app.js）...');
  const { bytes } = await writeEmbeddedPreamble({
    distDir: DIST,
    appCode,
    headerComment: HEADER,
    upstreamLicense: UPSTREAM_LICENSE,
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
  console.log(`[5/5] dist/app.js: ${(bytes / 1024 / 1024).toFixed(2)} MB（single 全内嵌）`);
}

/** multi 形态：多文件 ESM，WASM 与纹理包外置，页面侧 fetch。 */
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

  // 给 app.js 头部注入 WASM 地址：multi 形态由页面按该地址 fetch，不走 base64 内嵌
  const appPath = join(DIST, 'app.js');
  writeFileSync(
    appPath,
    `/* WebSurf multi-file build — auto-generated, do not edit */\n` +
      `globalThis.__VBSP_WASM_URL__=${JSON.stringify('./' + WASM_FILE)};\n` +
      readFileSync(appPath, 'utf8'),
  );

  console.log('[5/5] 复制 WASM / 默认纹理包...');
  copyFileSync(wasmPath, join(DIST, WASM_FILE));
  copyFileSync(MTZ, join(DIST, 'textures.mtz'));  // COI serviceworker：静态托管上补发 COOP/COEP 响应头，使页面处于 crossOriginIsolated

  console.log('[5/5] 复制 index.html（module script 原样，与 web/ 同构）...');
  copyFileSync(INDEX_HTML, join(DIST, 'index.html'));

  // multi 专用：按 dist/ 里实际存在的文件生成预缓存清单，连同缓存名一起注入 SW
  const precacheManifest = [
    './index.html',
    './app.js',
    './worker.js',
    './' + WASM_FILE,
    './textures.mtz',
    './coi-serviceworker.js',
  ].filter((f) => existsSync(join(DIST, f.slice(2)))); // 去掉 './' 前缀后探存在性，只把 dist/ 里确实有的项写进清单

  const swTemplate = readFileSync(join(ROOT, 'web', 'coi-serviceworker.js'), 'utf8');
  // 缓存名由「预缓存清单 + 各文件字节」的 sha256 前 12 位派生：分发的文件一变，SW 自身字节就变，
  // 浏览器随即重装 SW 并换缓存；缓存名固定时 SW 字节不变，旧的 app.js 会被长期命中。
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

  // 全量重建：先删 dist/ 再建，避免上一形态的产物残留
  await cleanDist(DIST);

  if (multi) await buildMulti(wasmPath);
  else await buildSingle(wasmPath);

  // 许可证：从唯一源 src/phys 拷出产物级副本，产物名带 .cs-movement 后缀
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
