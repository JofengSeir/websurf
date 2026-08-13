/**
 * 构建 WebSurf-test dist/（多文件模式：dev 与 dist 同构，HTTP 运行）。
 *
 *   dist/index.html            — module script（原样）
 *   dist/app.js                — ESM（主线程）
 *   dist/worker-a.js           — ESM（module worker，物理）
 *   dist/worker-b.js           — ESM（module worker，渲染）
 *   dist/websurf_test_wasm_bg.wasm — WASM 外置（运行时 fetch './websurf_test_wasm_bg.wasm'）
 *
 * 与 dev（serve.py 服务 test 根目录）产物同构：相对路径 './worker-a.js' 等
 * 在 dist/ 下同样解析。无 single 内嵌模式（test 仅 HTTP 运行，SAB 恒定可用）。
 *
 * 用法：node scripts/build-dist.mjs
 */
import { build } from 'esbuild';
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const ENTRIES = [
  ['src/main.ts', 'app.js'],
  ['src/worker-a.ts', 'worker-a.js'],
  ['src/worker-b.ts', 'worker-b.js'],
];

async function main() {
  console.log('=== WebSurf-test dist 构建（multi / HTTP 部署）===\n');

  const wasmPath = join(root, 'pkg', 'websurf_test_wasm_bg.wasm');
  if (!existsSync(wasmPath)) {
    console.error('错误: pkg/websurf_test_wasm_bg.wasm 不存在。请先运行 npm run build:wasm');
    process.exit(1);
  }

  const distDir = join(root, 'dist');
  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

  // 1. 三产物（app + 两个 worker）→ ESM
  console.log('[1/3] 打包 app / worker-a / worker-b (ESM)...');
  for (const [entry, out] of ENTRIES) {
    await build({
      bundle: true,
      target: 'es2022',
      format: 'esm',
      minify: true,
      sourcemap: false,
      legalComments: 'eof',
      logLevel: 'info',
      entryPoints: [join(root, entry)],
      outfile: join(distDir, out),
    });
  }
  console.log(`      app.js / worker-a.js / worker-b.js 已生成`);

  // 2. 复制 WASM（外置，fetch 加载；与 dev 同相对路径 './websurf_test_wasm_bg.wasm'）
  console.log('[2/3] 复制 WASM...');
  copyFileSync(wasmPath, join(distDir, 'websurf_test_wasm_bg.wasm'));

  // 3. index.html（module script 原样）
  console.log('[3/3] 复制 index.html...');
  copyFileSync(join(root, 'index.html'), join(distDir, 'index.html'));

  const total = ['app.js', 'worker-a.js', 'worker-b.js', 'websurf_test_wasm_bg.wasm', 'index.html']
    .reduce((acc, f) => acc + (existsSync(join(distDir, f)) ? readFileSync(join(distDir, f)).length : 0), 0);
  console.log('\n=== 构建完成（multi）===');
  console.log(`总大小: ${(total / 1024 / 1024).toFixed(2)} MB（5 个文件）`);
  console.log(`\n用 HTTP 服务 dist/（如 python ../../src/serve.py 8080 dist）后访问 dist/index.html。`);
}

main().catch((err) => {
  console.error('构建失败:', err);
  process.exit(1);
});
