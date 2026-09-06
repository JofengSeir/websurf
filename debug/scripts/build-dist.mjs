/**
 * 构建 debug dist/，双模式：
 *
 * ── single（默认，本地双击 file://）─────────────────────────────
 *   dist/index.html — classic script（非 ES module；file:// 下 module 被 CORS 拦截）
 *   dist/app.js     — IIFE，内嵌 WASM(base64) + Worker 代码(Blob URL) + 默认纹理包(base64)
 *   所有资源内嵌 → file:// 双击完整可用（含缺失纹理回退）
 *
 * ── multi（--multi，GitHub Pages / HTTP 部署）─────────────────
 *   dist/index.html — module script
 *   dist/app.js     — ESM
 *   dist/worker.js  — ESM（module worker）
 *   dist/websurf_wasm_bg.wasm — WASM 外置（fetch）
 *   dist/textures.mtz         — 默认纹理包外置（fetch）
 *   HTTP 下 fetch 正常，无需内嵌（体积更小、COOP/COEP 由 Pages 场景不需要——
 *   无 SAB 时自动 MsgState 回退）
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
	// 保留 @license 法律注释（@unsurf/cs-movement Apache-2.0 要求，勿移除）
	legalComments: 'eof',
	// IIFE 不支持 import.meta.url；用占位符替换（single 内嵌模式不走 fetch 路径）
	define: {
		'import.meta.url': JSON.stringify('about:blank'),
	},
	external: [],
	logLevel: 'info',
};

async function main() {
	console.log(`=== WebSurf dist 构建（${multi ? 'multi / HTTP 部署' : 'single / 本地 file://'}）===\n`);

	// 0. 检查 WASM / 默认纹理包已就绪
	const wasmPath = join(root, 'pkg', 'websurf_wasm_bg.wasm');
	if (!existsSync(wasmPath)) {
		console.error('错误: pkg/websurf_wasm_bg.wasm 不存在。请先运行 npm run build:wasm');
		process.exit(1);
	}
	const mtzPath = join(root, '..', 'src', 'materials', 'textures.mtz');
	if (!existsSync(mtzPath)) {
		console.error(`错误: 默认纹理包不存在（${mtzPath}）`);
		process.exit(1);
	}

	const distDir = join(root, 'dist');
	if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

	if (multi) {
		await buildMulti(distDir, wasmPath, mtzPath);
	} else {
		await buildSingle(distDir, wasmPath, mtzPath);
	}
}

/** single：单文件 IIFE，WASM/Worker/默认纹理包全内嵌（file:// 双击可用）。 */
async function buildSingle(distDir, wasmPath, mtzPath) {
	// 1. WASM → base64
	console.log('[1/5] 编码 WASM (base64)...');
	const wasmBytes = readFileSync(wasmPath);
	const wasmBase64 = wasmBytes.toString('base64');

	// 2. 默认纹理包 → base64（缺失纹理回退；file:// 无法 fetch）
	console.log('[2/5] 编码默认纹理包 (base64)...');
	const mtzBytes = readFileSync(mtzPath);
	const mtzBase64 = mtzBytes.toString('base64');

	// 3. worker → IIFE（Blob URL）
	console.log('[3/5] 打包 worker (IIFE)...');
	const workerResult = await build({
		...commonOptions,
		entryPoints: [join(root, 'src', 'worker', 'main.ts')],
		format: 'iife',
	});
	const workerCode = workerResult.outputFiles[0].text;

	// 4. app → IIFE
	console.log('[4/5] 打包 app (IIFE)...');
	const appResult = await build({
		...commonOptions,
		entryPoints: [join(root, 'src', 'app.ts')],
		format: 'iife',
	});
	const appCode = appResult.outputFiles[0].text;

	// 5. 生成 dist/
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
		`/* WebSurf single-file build — auto-generated, do not edit */\n` +
		`globalThis.__VBSP_WASM_B64__=${JSON.stringify(wasmBase64)};\n` +
		`globalThis.__VBSP_WORKER_JS__=${JSON.stringify(workerCode)};\n` +
		`globalThis.__VBSP_TEXTURES_MTZ_B64__=${JSON.stringify(mtzBase64)};\n`;
	const finalAppJs = embeddedPreamble + appCode;
	writeFileSync(join(distDir, 'app.js'), finalAppJs);
	console.log(`      dist/app.js: ${(finalAppJs.length / 1024 / 1024).toFixed(2)} MB`);

	const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
	const distHtml = html.replace(
		'<script type="module" src="./app.js"></script>',
		'<script src="./app.js"></script>',
	);
	writeFileSync(join(distDir, 'index.html'), distHtml);

	// 清理旧的多文件产物（single 全内嵌，外置文件无用）
	for (const stale of ['worker.js', 'websurf_wasm_bg.wasm', 'textures.mtz']) {
		try {
			unlinkSync(join(distDir, stale));
		} catch {
			/* 不存在则忽略 */
		}
	}

	copyFileSync(join(root, 'src', 'physics', 'LICENSE'), join(distDir, 'LICENSE.cs-movement'));
	copyFileSync(join(root, 'src', 'physics', 'NOTICE'), join(distDir, 'NOTICE.cs-movement'));

	console.log('\n=== 构建完成（single）===');
	console.log(`总大小: ${(finalAppJs.length / 1024 / 1024).toFixed(2)} MB`);
	console.log(`\n双击 dist/index.html 即可在浏览器中打开（缺失纹理回退已内嵌可用）。`);
}

/** multi：多文件 ESM（HTTP 部署，fetch 正常，体积更小）。 */
async function buildMulti(distDir, wasmPath, mtzPath) {
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

	// 2. app.js 前缀注入 WASM URL（multi 模式下 fetch 相对 dist/ 的 wasm）
	const appPath = join(distDir, 'app.js');
	const appCode = readFileSync(appPath, 'utf8');
	writeFileSync(
		appPath,
		`/* WebSurf multi-file build — auto-generated, do not edit */\n` +
			`globalThis.__VBSP_WASM_URL__=${JSON.stringify('./websurf_wasm_bg.wasm')};\n` +
			appCode,
	);

	// 3. 复制 WASM + 默认纹理包（外置，fetch 加载）
	console.log('[2/4] 复制 WASM / 默认纹理包...');
	copyFileSync(wasmPath, join(distDir, 'websurf_wasm_bg.wasm'));
	copyFileSync(mtzPath, join(distDir, 'textures.mtz'));
	console.log(`      websurf_wasm_bg.wasm / textures.mtz 已复制`);

	// 4. index.html（module script 原样；web/ 与 dist/ 同构）+ 许可证
	console.log('[3/4] 复制 index.html...');
	copyFileSync(join(root, 'web', 'index.html'), join(distDir, 'index.html'));
	copyFileSync(join(root, 'src', 'physics', 'LICENSE'), join(distDir, 'LICENSE.cs-movement'));
	copyFileSync(join(root, 'src', 'physics', 'NOTICE'), join(distDir, 'NOTICE.cs-movement'));

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
