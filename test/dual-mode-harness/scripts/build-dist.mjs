/**
 * 构建 WebSurf-test dist/（multi 模式：dev 与 dist 同构，HTTP 运行）。
 *
 * 薄入口（D-04 / T-04）：打包内核在共享层 `src/scripts/lib/dist-pack.mjs`；
 * esbuild 的 `build` 由本文件注入（内核不得 import esbuild）。
 *
 *   dist/index.html                — module script（原样拷贝）
 *   dist/app.js                    — ESM（主线程）
 *   dist/worker-a.js               — ESM（module worker，物理）
 *   dist/worker-b.js               — ESM（module worker，渲染）
 *   dist/websurf_test_wasm_bg.wasm — WASM 外置（运行时 fetch './websurf_test_wasm_bg.wasm'）
 *
 * 与 dev（serve.py 服务 test 根目录）产物同构：相对路径 './worker-a.js' 等
 * 在 dist/ 下同样解析。无 single 内嵌模式（test 仅 HTTP 运行，SAB 恒定可用）。
 *
 * 用法：node scripts/build-dist.mjs
 * 退出码：0 = 成功，1 = 失败
 */
import { build } from 'esbuild';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleEsm,
  cleanDist,
  cleanStale,
  printTree,
} from '../../../src/scripts/lib/dist-pack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..'); // test/dual-mode-harness
const DIST = join(ROOT, 'dist');
const WASM_FILE = 'websurf_test_wasm_bg.wasm';

const ENTRIES = [
  ['src/main.ts', 'app.js'],
  ['src/worker-a.ts', 'worker-a.js'],
  ['src/worker-b.ts', 'worker-b.js'],
];

// 本形态的产物清单（cleanDist 已全量重建；cleanStale 把清单写成可执行断言）
const KEEP = ['index.html', 'app.js', 'worker-a.js', 'worker-b.js', WASM_FILE];

async function main() {
  const wasmPath = join(ROOT, 'pkg', WASM_FILE);
  if (!existsSync(wasmPath)) {
    throw new Error(`${wasmPath} 不存在（先运行 npm run build:wasm）`);
  }

  // 全量重建：先删后建（规范 §5.2 R-15，禁止增量残留）
  await cleanDist(DIST);

  console.log('[1/3] 打包 app / worker-a / worker-b (ESM)...');
  for (const [entry, out] of ENTRIES) {
    await bundleEsm({
      build,
      entry: join(ROOT, entry),
      outfile: join(DIST, out),
      options: { logLevel: 'info' },
    });
  }

  console.log('[2/3] 复制 WASM...');
  copyFileSync(wasmPath, join(DIST, WASM_FILE));

  console.log('[3/3] 复制 index.html...');
  copyFileSync(join(ROOT, 'index.html'), join(DIST, 'index.html'));

  const removed = await cleanStale(DIST, KEEP);
  if (removed.length) console.log(`[WARN] removed stale: ${removed.join(', ')}`);

  console.log((await printTree(DIST)).join('\n'));
  console.log('用 HTTP 服务 dist/（如 python ../../src/serve.py 8110 dist）后访问 dist/index.html。');
}

main().catch((err) => {
  console.error(`[ERROR] dist build failed: ${err?.message ?? err}`);
  console.error('[HINT] See the message above, fix the input or toolchain, then retry.');
  process.exit(1);
});
