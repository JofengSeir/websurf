/**
 * 构建最小打包文件到 dist/ 目录。
 *
 * 产物：
 *   dist/index.html  — classic script 引用（非 ES module）
 *   dist/app.js      — IIFE 格式，内嵌 WASM(base64, 仅一份) + Worker 代码(Blob URL)
 *
 * 设计：
 * - WASM base64 编码为全局变量 __VBSP_WASM_B64__（唯一一份，主线程持有），运行时：
 *     · 通过 `wasm-init` 消息下发给 worker，worker 据此 initSync（避免 file:// fetch 失败）。
 * - Worker 代码作为全局变量 __VBSP_WORKER_JS__，运行时 Blob URL 创建（避免 file:// module worker 失败）。
 * - app.js 用 IIFE 格式（避免 file:// 下 ES module CORS 限制）
 *
 * 结果：双击 dist/index.html 即可在浏览器中运行，功能完整，无需 HTTP 服务器。
 *
 * 用法：node scripts/build-dist.mjs
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
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
	// 保留 @license 法律注释（@unsurf/cs-movement Apache-2.0 要求，勿移除）
	legalComments: 'eof',
	// IIFE 不支持 import.meta.url；用占位符替换（内嵌模式不走 fetch 路径）
	define: {
		'import.meta.url': JSON.stringify('about:blank'),
	},
	external: [],
	logLevel: 'info',
};

async function main() {
	console.log('=== WebSurf dist 构建 ===\n');

	// 0. 检查 WASM 已构建
	const wasmPath = join(root, 'pkg', 'websurf_wasm_bg.wasm');
	if (!existsSync(wasmPath)) {
		console.error('错误: pkg/websurf_wasm_bg.wasm 不存在。请先运行 npm run build:wasm');
		process.exit(1);
	}

	// 1. 读取 WASM → base64
	console.log('[1/5] 编码 WASM (base64)...');
	const wasmBytes = readFileSync(wasmPath);
	const wasmBase64 = wasmBytes.toString('base64');
	console.log(`      WASM 原始: ${(wasmBytes.length / 1024).toFixed(0)} KB → base64: ${(wasmBase64.length / 1024).toFixed(0)} KB`);

	// 2. esbuild 打包 worker → IIFE
	console.log('[2/5] 打包 worker (IIFE)...');
	const workerResult = await build({
		...commonOptions,
		entryPoints: [join(root, 'src', 'worker', 'main.ts')],
		format: 'iife',
	});
	const workerCode = workerResult.outputFiles[0].text;
	console.log(`      worker 大小: ${(workerCode.length / 1024).toFixed(0)} KB`);

	// 3. esbuild 打包 app → IIFE
	console.log('[3/5] 打包 app (IIFE)...');
	const appResult = await build({
		...commonOptions,
		entryPoints: [join(root, 'src', 'app.ts')],
		format: 'iife',
	});
	const appCode = appResult.outputFiles[0].text;
	console.log(`      app 大小: ${(appCode.length / 1024).toFixed(0)} KB`);

	// 4. 生成 dist/
	console.log('[4/5] 写入 dist/...');
	const distDir = join(root, 'dist');
	if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

	// 4a. 生成 dist/app.js（前缀注入全局变量 + IIFE app 代码）
	// 头部附上游 @license 声明（@unsurf/cs-movement Apache-2.0 要求保留；
	// index.ts 未被 bundle 引用，esbuild 不会自动带入，手动附加）
	const upstreamLicense =
		'/*!\n' +
		' * @license\n' +
		' * @unsurf/cs-movement — Counter-Strike style movement physics\n' +
		' * Copyright 2026 unsurf\n' +
		' * SPDX-License-Identifier: Apache-2.0\n' +
		' * (modified by WebSurf — see NOTICE.cs-movement)\n' +
		' */\n';
	const embeddedPreamble =
		upstreamLicense +
		`/* WebSurf embedded build — auto-generated, do not edit */\n` +
		`globalThis.__VBSP_WASM_B64__=${JSON.stringify(wasmBase64)};\n` +
		`globalThis.__VBSP_WORKER_JS__=${JSON.stringify(workerCode)};\n`;
	const finalAppJs = embeddedPreamble + appCode;
	writeFileSync(join(distDir, 'app.js'), finalAppJs);
	console.log(`      dist/app.js: ${(finalAppJs.length / 1024 / 1024).toFixed(2)} MB`);

	// 4b. 生成 dist/index.html（classic script 引用）
	console.log('[5/5] 生成 dist/index.html...');
	const htmlPath = join(root, 'web', 'index.html');
	const html = readFileSync(htmlPath, 'utf8');
	const distHtml = html.replace(
		'<script type="module" src="./app.js"></script>',
		'<script src="./app.js"></script>',
	);
	writeFileSync(join(distDir, 'index.html'), distHtml);
	console.log(`      dist/index.html: ${(distHtml.length / 1024).toFixed(0)} KB`);

	// 4c. 附带第三方许可证副本（@unsurf/cs-movement Apache-2.0 要求随分发提供 LICENSE + NOTICE）
	copyFileSync(join(root, 'src', 'physics', 'LICENSE'), join(distDir, 'LICENSE.cs-movement'));
	copyFileSync(join(root, 'src', 'physics', 'NOTICE'), join(distDir, 'NOTICE.cs-movement'));
	console.log('      已附带 LICENSE.cs-movement / NOTICE.cs-movement (Apache-2.0)');

	console.log('\n=== 构建完成 ===');
	console.log(`总大小: ${(finalAppJs.length / 1024 / 1024).toFixed(2)} MB`);
	console.log(`\n双击 dist/index.html 即可在浏览器中打开。`);
}

main().catch((err) => {
	console.error('构建失败:', err);
	process.exit(1);
});
