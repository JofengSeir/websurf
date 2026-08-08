/**
 * F4: WASM API 契约检查（构建期校验 WASM 导出与 TS 导入一致）
 *
 * 对比 wasm-pack 生成的 pkg/websurf_wasm.js 导出符号与 TS 源码导入符号，
 * 确保 100% 匹配（TS 导入的符号必须在 WASM 导出中存在）。
 *
 * 用法：node scripts/check-wasm-api.mjs
 * 退出码：0 = 通过，1 = 不匹配
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. 提取 WASM 导出符号（从 pkg/websurf_wasm.js）
// ---------------------------------------------------------------------------

function extractWasmExports() {
	const wasmJsPath = join(ROOT, 'pkg', 'websurf_wasm.js');
	const src = readFileSync(wasmJsPath, 'utf-8');
	const exports = new Set();

	// 匹配 `export function name` / `export class Name` / `export const name`
	const funcMatches = src.matchAll(/export\s+function\s+(\w+)/g);
	for (const m of funcMatches) exports.add(m[1]);

	const classMatches = src.matchAll(/export\s+class\s+(\w+)/g);
	for (const m of classMatches) exports.add(m[1]);

	const constMatches = src.matchAll(/export\s+const\s+(\w+)/g);
	for (const m of constMatches) exports.add(m[1]);

	// `export { name1, name2 as alias, ... }` 形式（含 `as default`）
	const namedExportRegex = /export\s*\{([^}]*)\}/g;
	for (const m of src.matchAll(namedExportRegex)) {
		for (const item of m[1].split(',')) {
			const trimmed = item.trim();
			if (!trimmed) continue;
			// `name as alias` → 取 alias；`name` → 取 name
			const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
			if (asMatch) {
				exports.add(asMatch[2]); // alias（可能是 default）
			} else {
				exports.add(trimmed);
			}
		}
	}

	// `export default ...` 直接形式
	if (/export\s+default\s+/.test(src)) {
		exports.add('default');
	}

	return exports;
}

// ---------------------------------------------------------------------------
// 2. 提取 TS 导入符号（从 src/**/*.ts 中匹配 pkg/websurf_wasm 导入）
// ---------------------------------------------------------------------------

function extractTsImports() {
	const srcDir = join(ROOT, 'src');
	const imports = new Set();

	function scanDir(dir) {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				scanDir(fullPath);
			} else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
				const src = readFileSync(fullPath, 'utf-8');
				// 匹配 `import init, { a, b } from '...pkg/websurf_wasm.js'`
				// 默认导入映射到 'default'（WASM 导出名）
				const withNamedRegex =
					/import\s+(?:(\w+)\s*,\s*)?\{([^}]*)\}\s+from\s+['"][^'"]*pkg\/websurf_wasm/g;
				for (const m of src.matchAll(withNamedRegex)) {
					if (m[1]) imports.add('default'); // 默认导入
					if (m[2]) {
						for (const name of m[2].split(',')) {
							const trimmed = name.trim().replace(/^type\s+/, '');
							if (trimmed) imports.add(trimmed);
						}
					}
				}
				// 匹配 `import init from '...pkg/websurf_wasm.js'`（仅默认导入）
				const defaultOnlyRegex =
					/import\s+(\w+)\s+from\s+['"][^'"]*pkg\/websurf_wasm/g;
				for (const m of src.matchAll(defaultOnlyRegex)) {
					if (!m[0].includes('{')) {
						imports.add('default');
					}
				}
			}
		}
	}

	scanDir(srcDir);
	return imports;
}

// ---------------------------------------------------------------------------
// 3. 对比并报告
// ---------------------------------------------------------------------------

const wasmExports = extractWasmExports();
const tsImports = extractTsImports();

console.log('=== F4: WASM API 契约检查 ===');
console.log(`WASM 导出符号 (${wasmExports.size}):`, [...wasmExports].sort().join(', '));
console.log(`TS  导入符号 (${tsImports.size}):`, [...tsImports].sort().join(', '));

const missing = [...tsImports].filter((name) => !wasmExports.has(name));

if (missing.length === 0) {
	console.log('\n✅ F4 通过: 所有 TS 导入的符号都在 WASM 导出中存在');
	process.exit(0);
} else {
	console.error(`\n❌ F4 失败: ${missing.length} 个 TS 导入的符号在 WASM 导出中缺失:`);
	for (const name of missing) {
		console.error(`   - ${name}`);
	}
	process.exit(1);
}
