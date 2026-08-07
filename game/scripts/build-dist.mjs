/**
 * 构建最小打包文件到 dist/，通过 play.cmd（本地服务器 + 自动开浏览器）运行。
 *
 * 注意：dist/index.html 直接双击（file://）不可玩——Chrome 在非跨域隔离环境
 * 禁用 SharedArrayBuffer（物理双 Worker 依赖），页面会显示引导卡片。
 * 请双击 play.cmd 或 python serve.py 8137 后访问 /dist/index.html。
 *
 * 产物：
 *   dist/index.html — classic script 引用（非 ES module）
 *   dist/app.js     — IIFE 格式，内嵌 WASM(base64) + 双 Worker 代码(Blob URL)
 *
 * 设计：WASM base64 存于全局 __VBSP_WASM_B64__，经 `wasm-init` 下发给 worker
 * 做 initSync（避免 file:// fetch 失败）；权威 Worker 代码存于 __VBSP_WORKER_JS__、
 * 预测 Worker 代码存于 __VBSP_PREDICTOR_JS__，运行时以 Blob URL 创建；
 * app.js 用 IIFE（避免 file:// 下 ES module CORS 限制）。
 *
 * 用法：node scripts/build-dist.mjs
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// esbuild 公共配置
const commonOptions = {
  bundle: true,
  target: 'es2022',
  minify: true,
  sourcemap: false,
  write: false,
  legalComments: 'eof',
  define: {
    'import.meta.url': JSON.stringify('about:blank'),
  },
  external: [],
  logLevel: 'info',
};

async function main() {
  console.log('=== WebSurf-min dist 构建 ===\n');

  // 0. 检查 WASM 已构建
  const wasmPath = join(root, 'pkg', 'websurf_wasm_bg.wasm');
  if (!existsSync(wasmPath)) {
    console.error('错误: pkg/websurf_wasm_bg.wasm 不存在。请先运行 npm run build:wasm');
    process.exit(1);
  }

  // 1. 读取 WASM → base64
  console.log('[1/6] 编码 WASM (base64)...');
  const wasmBytes = readFileSync(wasmPath);
  const wasmBase64 = wasmBytes.toString('base64');
  console.log(`      WASM 原始: ${(wasmBytes.length / 1024).toFixed(0)} KB → base64: ${(wasmBase64.length / 1024).toFixed(0)} KB`);

  // 2. esbuild 打包权威 Worker → IIFE
  console.log('[2/6] 打包权威 Worker (IIFE)...');
  const workerResult = await build({
    ...commonOptions,
    entryPoints: [join(root, 'src', 'worker', 'main.ts')],
    format: 'iife',
  });
  const workerCode = workerResult.outputFiles[0].text;
  console.log(`      worker 大小: ${(workerCode.length / 1024).toFixed(0)} KB`);

  // 2b. esbuild 打包预测 Worker → IIFE
  console.log('[3/6] 打包预测 Worker (IIFE)...');
  const predResult = await build({
    ...commonOptions,
    entryPoints: [join(root, 'src', 'worker', 'predictor-main.ts')],
    format: 'iife',
  });
  const predCode = predResult.outputFiles[0].text;
  console.log(`      predictor 大小: ${(predCode.length / 1024).toFixed(0)} KB`);

  // 3. esbuild 打包 app → IIFE
  console.log('[4/6] 打包 app (IIFE)...');
  const appResult = await build({
    ...commonOptions,
    entryPoints: [join(root, 'src', 'app.ts')],
    format: 'iife',
  });
  const appCode = appResult.outputFiles[0].text;
  console.log(`      app 大小: ${(appCode.length / 1024).toFixed(0)} KB`);

  // 4. 生成 dist/
  console.log('[5/6] 写入 dist/...');
  const distDir = join(root, 'dist');
  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

  const embeddedPreamble =
    `/* WebSurf-min embedded build — auto-generated, do not edit */\n` +
    `globalThis.__VBSP_WASM_B64__=${JSON.stringify(wasmBase64)};\n` +
    `globalThis.__VBSP_WORKER_JS__=${JSON.stringify(workerCode)};\n` +
    `globalThis.__VBSP_PREDICTOR_JS__=${JSON.stringify(predCode)};\n`;
  const finalAppJs = embeddedPreamble + appCode;
  writeFileSync(join(distDir, 'app.js'), finalAppJs);
  console.log(`      dist/app.js: ${(finalAppJs.length / 1024 / 1024).toFixed(2)} MB`);

  // 5. 生成 dist/index.html（classic script 引用）
  console.log('[6/6] 生成 dist/index.html...');
  const htmlPath = join(root, 'web', 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  const distHtml = html.replace(
    '<script type="module" src="./app.js"></script>',
    '<script src="./app.js"></script>',
  );
  writeFileSync(join(distDir, 'index.html'), distHtml);
  console.log(`      dist/index.html: ${(distHtml.length / 1024).toFixed(0)} KB`);

  console.log('\n=== 构建完成 ===');
  console.log(`总大小: ${(finalAppJs.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`\n运行：双击 play.cmd（推荐）或 python serve.py 8137 后访问 /dist/index.html`);
  console.log(`注意：直接双击 dist/index.html（file://）无法启用 SharedArrayBuffer，会显示引导卡片。`);
}

main().catch((err) => {
  console.error('构建失败:', err);
  process.exit(1);
});
