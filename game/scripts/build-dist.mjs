/**
 * 构建 WebSurf-min dist/（常规多文件打包，非 base64 内嵌单文件）。
 *
 * 背景：权威物理 Worker 依赖 SharedArrayBuffer（需 COOP/COEP 头），file:// 双击无法
 * 启用——dist 本就只能经本地服务器（play.cmd / serve.py）运行，base64 内嵌（为
 * file:// 兜底）不再有意义，改为与 dev（web/）同构的常规打包：
 *
 * 产物：
 *   dist/index.html            — module script 引用 ./app.js
 *   dist/app.js                — esbuild ESM（创建 ./worker.js 权威 Worker）
 *   dist/worker.js             — 权威 Worker（ESM）
 *   dist/websurf_wasm_bg.wasm  — WASM 外置文件（worker 内 fetch 相对路径加载）
 *
 * 用法：node scripts/build-dist.mjs
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// esbuild 公共配置（ESM：保留 import.meta.url 供 worker 内相对定位 wasm）
const commonOptions = {
  bundle: true,
  target: 'es2022',
  format: 'esm',
  minify: true,
  sourcemap: false,
  legalComments: 'eof',
  logLevel: 'info',
};

async function main() {
  console.log('=== WebSurf-min dist 构建（多文件）===\n');

  // 0. 检查 WASM 已构建
  const wasmPath = join(root, 'pkg', 'websurf_wasm_bg.wasm');
  if (!existsSync(wasmPath)) {
    console.error('错误: pkg/websurf_wasm_bg.wasm 不存在。请先运行 npm run build:wasm');
    process.exit(1);
  }

  const distDir = join(root, 'dist');
  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

  // 1. esbuild 三产物（ESM）
  console.log('[1/4] 打包 app / worker (ESM)...');
  const entries = [
    ['app', join(root, 'src', 'app.ts')],
    ['worker', join(root, 'src', 'worker', 'main.ts')],
  ];
  for (const [name, entry] of entries) {
    await build({ ...commonOptions, entryPoints: [entry], outfile: join(distDir, name + '.js') });
    const size = existsSync(join(distDir, name + '.js')) ? readFileSync(join(distDir, name + '.js')).length : 0;
    console.log(`      ${name}.js: ${(size / 1024).toFixed(0)} KB`);
  }

  // 2. 复制 WASM（worker 内 fetch './websurf_wasm_bg.wasm' 相对自身加载）
  console.log('[2/4] 复制 WASM...');
  copyFileSync(wasmPath, join(distDir, 'websurf_wasm_bg.wasm'));
  console.log(`      websurf_wasm_bg.wasm: ${(readFileSync(wasmPath).length / 1024).toFixed(0)} KB`);

  // 3. index.html（保持 module script 引用 ./app.js）
  console.log('[3/4] 复制 index.html...');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  writeFileSync(join(distDir, 'index.html'), html);
  console.log(`      index.html: ${(html.length / 1024).toFixed(0)} KB`);

  // 4. 总览
  console.log('[4/4] 完成');
  const total = ['app.js', 'worker.js', 'websurf_wasm_bg.wasm']
    .reduce((acc, f) => acc + (existsSync(join(distDir, f)) ? readFileSync(join(distDir, f)).length : 0), 0);
  console.log(`\n=== 构建完成 ===`);
  console.log(`总大小: ${(total / 1024 / 1024).toFixed(2)} MB（4 个文件）`);
  console.log(`\n运行：双击 play.cmd（推荐）或 python serve.py 8137 后访问 /dist/index.html`);
  console.log(`注意：直接双击 dist/index.html（file://）无法启用 SharedArrayBuffer，会显示引导卡片。`);
}

main().catch((err) => {
  console.error('构建失败:', err);
  process.exit(1);
});
