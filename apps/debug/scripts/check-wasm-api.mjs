/**
 * F4: WASM API 契约检查（构建期校验 WASM 导出与 TS 导入一致）
 *
 * 本文件是**薄配置**：引擎在共享层 `src/scripts/lib/wasm-api-contract.mjs`（D-03 / T-03），
 * 本文件只声明「本工程的 pkg 名 + 契约面」并把结果落到输出与退出码。
 *
 * 三层校验（debug 的工程特有能力，规范 §8.2【禁止】删除动态比对）：
 *   1) 声明面：`pkg/websurf_wasm.d.ts` 必须导出 BspProcessor / PhysWorld；
 *   2) 导入面：`src/**\/*.ts` 中所有 `pkg/websurf_wasm*` 导入符号必须 ⊆ pkg 导出面；
 *   3) 不变量：导入面不得为空（防止扫描路径写错后「空集全通过」的假绿）。
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
