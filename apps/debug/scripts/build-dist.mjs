/**
 * 构建 debug dist/，双模式（薄入口，D-04 / T-04）：
 *
 * ── single（默认，本地双击 file://）─────────────────────────────
 *   dist/index.html — classic script（非 ES module；file:// 下 module 被 CORS 拦截）
 *   dist/app.js     — IIFE，内嵌 WASM(base64) + Worker 代码(Blob URL) + 默认纹理包(base64)
 *   dist/LICENSE.cs-movement、dist/NOTICE.cs-movement — 产物级许可证副本
 *   所有资源内嵌 → file:// 双击完整可用（含缺失纹理回退）
 *
 * ── multi（--multi，GitHub Pages / HTTP 部署）─────────────────
 *   dist/index.html — module script
 *   dist/app.js     — ESM（前缀注入 __VBSP_WASM_URL__）
 *   dist/worker.js  — ESM（module worker）
 *   dist/websurf_wasm_bg.wasm — WASM 外置（fetch）
 *   dist/textures.mtz         — 默认纹理包外置（fetch）
 *   dist/LICENSE.cs-movement、dist/NOTICE.cs-movement — 产物级许可证副本
 *
 * 打包内核（esbuild 注入、cleanDist 先删后建、__VBSP_* 拼装、许可证唯一源拷贝）：
 *   ../../../src/scripts/lib/dist-pack.mjs
 *
 * 用法：node scripts/build-dist.mjs [--multi]
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
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
const ROOT = join(HERE, '..'); // apps/debug
const REPO = join(ROOT, '..', '..'); // 仓库根
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

/** single：单文件 IIFE，WASM/Worker/默认纹理包全内嵌（file:// 双击可用）。 */
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
  copyFileSync(join(ROOT, 'web', 'coi-serviceworker.js'), join(DIST, 'coi-serviceworker.js'));

  console.log('[5/5] 复制 index.html（module script 原样，与 web/ 同构）...');
  copyFileSync(INDEX_HTML, join(DIST, 'index.html'));
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
