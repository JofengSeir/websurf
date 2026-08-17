/**
 * 构建 WebSurf-game dist/，双模式：
 *
 * ── single（默认，本地双击 file://）─────────────────────────────
 *   dist/index.html — classic script（file:// 下 module 被 CORS 拦截）
 *   dist/app.js     — IIFE，内嵌 WASM(base64) + Worker 代码(Blob URL)
 *   file:// 兼容：MsgState 回退（无 SAB）+ initSync（wasm 内嵌）+ Blob Worker
 *
 * ── multi（--multi，GitHub Pages / HTTP 部署）─────────────────
 *   dist/index.html — module script
 *   dist/app.js     — ESM
 *   dist/worker.js  — ESM（module worker）
 *   dist/websurf_wasm_bg.wasm — WASM 外置（fetch；game 的 dev/multi 路径统一
 *                              为 './websurf_wasm_bg.wasm'，运行时零改动）
 *   dist/textures.mtz         — 默认纹理包外置（公共资源，HTTP fetch 可用）
 *
 * 用法：node scripts/build-dist.mjs [--multi]
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const multi = process.argv.includes('--multi');

// esbuild 公共配置
const commonOptions = {
  bundle: true,
  target: 'es2022',
  minify: true,
  sourcemap: false,
  write: false,
  legalComments: 'eof',
  // IIFE 不支持 import.meta.url；用占位符替换（内嵌模式不走 fetch 路径）
  define: {
    'import.meta.url': JSON.stringify('about:blank'),
  },
  logLevel: 'info',
};

async function main() {
  console.log(`=== WebSurf-game dist 构建（${multi ? 'multi / HTTP 部署' : 'single / 本地 file://'}）===\n`);

  const wasmPath = join(root, 'pkg', 'websurf_wasm_bg.wasm');
  if (!existsSync(wasmPath)) {
    console.error('错误: pkg/websurf_wasm_bg.wasm 不存在。请先运行 npm run build:wasm');
    process.exit(1);
  }

  const distDir = join(root, 'dist');
  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

  if (multi) {
    await buildMulti(distDir, wasmPath);
  } else {
    await buildSingle(distDir, wasmPath);
  }
}

/** single：单文件 IIFE，WASM + Worker 内嵌（file:// 双击可用）。 */
async function buildSingle(distDir, wasmPath) {
  // 1. WASM → base64
  console.log('[1/4] 编码 WASM (base64)...');
  const wasmBytes = readFileSync(wasmPath);
  const wasmBase64 = wasmBytes.toString('base64');

  // 2. worker → IIFE（Blob URL）
  console.log('[2/4] 打包 worker (IIFE)...');
  const workerResult = await build({
    ...commonOptions,
    entryPoints: [join(root, 'src', 'worker', 'main.ts')],
    format: 'iife',
  });
  const workerCode = workerResult.outputFiles[0].text;

  // 3. app → IIFE
  console.log('[3/4] 打包 app (IIFE)...');
  const appResult = await build({
    ...commonOptions,
    entryPoints: [join(root, 'src', 'app.ts')],
    format: 'iife',
  });
  const appCode = appResult.outputFiles[0].text;

  // 4. 生成 dist/
  // 移植注：纹理包已随共享层拷贝到工程内 src/materials（原指向仓根 src/materials）
  const mtzBytes = readFileSync(join(root, 'src', 'materials', 'textures.mtz'));
  const mtzBase64 = mtzBytes.toString('base64');
  const embeddedPreamble =
    `/* WebSurf-game embedded build — auto-generated, do not edit */\n` +
    `globalThis.__VBSP_WASM_B64__=${JSON.stringify(wasmBase64)};\n` +
    `globalThis.__VBSP_WORKER_JS__=${JSON.stringify(workerCode)};\n` +
    `globalThis.__VBSP_TEXTURES_MTZ_B64__=${JSON.stringify(mtzBase64)};\n`;
  const finalAppJs = embeddedPreamble + appCode;
  writeFileSync(join(distDir, 'app.js'), finalAppJs);
  console.log(`      dist/app.js: ${(finalAppJs.length / 1024 / 1024).toFixed(2)} MB`);

  // classic script（file:// 下 module 被 CORS 拦截）
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  const distHtml = html.replace(
    '<script type="module" src="./app.js"></script>',
    '<script src="./app.js"></script>',
  );
  writeFileSync(join(distDir, 'index.html'), distHtml);

  // 清理旧的多文件产物（single 内嵌全量，外置文件无用）
  for (const stale of ['worker.js', 'websurf_wasm_bg.wasm', 'predictor.js', 'textures.mtz']) {
    try {
      unlinkSync(join(distDir, stale));
    } catch {
      /* 不存在则忽略 */
    }
  }

  console.log('\n=== 构建完成（single）===');
  console.log(`总大小: ${(finalAppJs.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`\n双击 dist/index.html 即可在浏览器中打开（无 SAB 自动走 MsgState 回退）。`);
}

/** multi：多文件 ESM（HTTP 部署，fetch 正常，体积更小）。 */
async function buildMulti(distDir, wasmPath) {
  // 1. app / worker → ESM
  console.log('[1/4] 打包 app / worker (ESM)...');
  await build({
    bundle: true,
    target: 'es2022',
    format: 'esm',
    minify: true,
    sourcemap: false,
    legalComments: 'eof',
    logLevel: 'info',
    entryPoints: [join(root, 'src', 'app.ts')],
    outfile: join(distDir, 'app.js'),
  });
  await build({
    bundle: true,
    target: 'es2022',
    format: 'esm',
    minify: true,
    sourcemap: false,
    legalComments: 'eof',
    logLevel: 'info',
    entryPoints: [join(root, 'src', 'worker', 'main.ts')],
    outfile: join(distDir, 'worker.js'),
  });
  console.log(`      app.js / worker.js 已生成`);

  // 2. 复制 WASM + 默认纹理包（外置，fetch 加载；game 的运行时统一 fetch './websurf_wasm_bg.wasm'）
  console.log('[2/4] 复制 WASM / 默认纹理包...');
  copyFileSync(wasmPath, join(distDir, 'websurf_wasm_bg.wasm'));
  copyFileSync(join(root, 'src', 'materials', 'textures.mtz'), join(distDir, 'textures.mtz'));
  console.log(`      websurf_wasm_bg.wasm / textures.mtz 已复制`);

  // 3. index.html（module script 原样）+ 清理旧单文件
  console.log('[3/4] 复制 index.html...');
  copyFileSync(join(root, 'web', 'index.html'), join(distDir, 'index.html'));
  try {
    unlinkSync(join(distDir, 'predictor.js'));
  } catch {
    /* 不存在则忽略 */
  }

  // 4. 总览
  console.log('[4/4] 完成');
  const total = ['app.js', 'worker.js', 'websurf_wasm_bg.wasm', 'textures.mtz']
    .reduce((acc, f) => acc + (existsSync(join(distDir, f)) ? readFileSync(join(distDir, f)).length : 0), 0);
  console.log('\n=== 构建完成（multi）===');
  console.log(`总大小: ${(total / 1024 / 1024).toFixed(2)} MB（5 个文件）`);
  console.log(`\n部署到 HTTP（GitHub Pages 等）后访问 dist/index.html。`);
}

main().catch((err) => {
  console.error('构建失败:', err);
  process.exit(1);
});
