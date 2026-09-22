/**
 * WASM API 契约检查（构建期校验：wasm 导出面 ∋ TS 导入面）
 *
 * 本文件是**薄配置**：检查引擎在共享层 `src/scripts/lib/wasm-api-contract.mjs`，
 * 本文件只声明本工程的 pkg 名（`websurf_wasm`）与契约面，并把结果落到 stdout 与退出码。
 *
 * 三层校验：
 *   1) 声明面：`pkg/websurf_wasm.d.ts` 必须含 `class BspProcessor` 与 `class PhysWorld`；
 *   2) 导入面：`src` 下全部 `.ts` 对 `pkg/websurf_wasm*` 的导入符号必须 ⊆ pkg 导出面；
 *   3) 不变量：导入面不得为空——扫描路径写错时得到空集，而空集会让上面两层「全通过」，
 *      故把「导入面为空」单列一条判失败。
 *
 * 用法：node scripts/check-wasm-api.mjs
 * 退出码：0 = 通过，1 = 不匹配
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDtsExports,
  assertTsImportsCoveredByExports,
  extractExportsFromPkgJs,
  readDtsApiNames,
} from '../../../src/scripts/lib/wasm-api-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PKG_BASE = 'websurf_wasm';
const PKG_JS = join(ROOT, 'pkg', `${PKG_BASE}.js`);
const DTS = join(ROOT, 'pkg', `${PKG_BASE}.d.ts`);

const read = readDtsApiNames({ dtsPath: DTS });
if (!read.ok) {
  console.error(read.message);
  process.exit(1);
}

const wasmExports = extractExportsFromPkgJs(PKG_JS);
const classCheck = assertDtsExports({ dtsPath: DTS, extraTokens: ['class BspProcessor', 'class PhysWorld'] });
const coverage = assertTsImportsCoveredByExports({ tsRoot: join(ROOT, 'src'), pkgBasename: PKG_BASE, exports: wasmExports });

console.log('=== F4: WASM API 契约检查 ===');
console.log(`WASM 导出符号 (${wasmExports.size}):`, [...wasmExports].sort().join(', '));
console.log(`TS  导入符号 (${coverage.imports.length}):`, coverage.imports.join(', '));

const failures = [];
if (!classCheck.ok) failures.push(`声明面缺少：${classCheck.missing.join(', ')}`);
if (coverage.imports.length === 0) failures.push(`未在 src/**/*.ts 扫描到任何 pkg/${PKG_BASE} 导入（契约面为空，判为失败）`);
if (!coverage.ok) failures.push(`TS 导入但 WASM 未导出：${coverage.missing.join(', ')}`);

if (failures.length === 0) {
  console.log('\n✅ F4 通过: 所有 TS 导入的符号都在 WASM 导出中存在');
  process.exit(0);
}
for (const line of failures) console.error(`✗ ${line}`);
console.error(`\n❌ F4 失败: ${failures.length} 项。`);
process.exit(1);
