/**
 * WASM 契约检查：确认 `pkg/websurf_viewer_wasm.d.ts` 导出了 viewer 实际使用的 API。
 *
 * 本文件是**薄配置**：检查引擎在共享层 `src/scripts/lib/wasm-api-contract.mjs`，
 * 本文件只声明本工程的 pkg 名（`websurf_viewer_wasm`）与契约清单。
 *
 * 清单只有 `BspProcessor` + `initSync`：viewer 的 `src` 对 pkg 的全部导入就是
 * `apps/viewer/src/core/bsp.ts` 里那一行 `import { BspProcessor, initSync } from ...`。
 * 清单取自**实际消费面**，而非与其他工程对齐——多列未使用的 API 会让契约失去含义。
 * 反向断言由 `assertTsImportsCoveredByExports` 完成：源码新增导入而清单未跟上时本检查失败。
 *
 * 第三层（2026-10-09 起）：`BspMetadata`（Rust serde 键名）↔ `BspMeta`（TS 接口键名）逐键对齐
 * （`assertStructFieldsMatchInterface`）——两侧都不把对方纳入编译期校验，字段改名即失败。
 *
 * 用法：node scripts/check-wasm-api.mjs [--source-only]
 *   `--source-only` 只跑第三层（Rust serde 键名 ↔ TS 接口键名）：该层只读源码、不碰 `pkg/`，
 *   故可进 CI 的轻量 job（`OWNER.md` D-022 选项 (a)）；不带参数时三层全跑，需先 `build:wasm`。
 * 退出码：0 = 通过，1 = 不匹配
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDtsExports,
  assertStructFieldsMatchInterface,
  assertTsImportsCoveredByExports,
  extractExportsFromDts,
  readDtsApiNames,
} from '../../../src/scripts/lib/wasm-api-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PKG_BASE = 'websurf_viewer_wasm';
const DTS = join(ROOT, 'pkg', `${PKG_BASE}.d.ts`);

// viewer 消费面：BSP 解析类 + wasm 同步初始化 + MTZ 解压（2026-10-04 起缺失纹理回退链路）
const VIEWER_API = ['initSync', 'decompress_mtz'];

// 第三层先算（只读源码）：`--source-only` 在读 `pkg/` 之前就返回，故该模式不要求 build:wasm
const metaFields = assertStructFieldsMatchInterface({
  rustPath: join(ROOT, 'crates', 'wasm', 'src', 'lib.rs'),
  structName: 'BspMetadata',
  tsPath: join(ROOT, 'src', 'core', 'bsp.ts'),
  interfaceName: 'BspMeta',
});
if (process.argv.includes('--source-only')) {
  if (metaFields.ok) {
    console.log('✓ 源码级契约通过：BspMetadata ↔ BspMeta 键名逐一对齐（--source-only，未读 pkg/）。');
    process.exit(0);
  }
  if (metaFields.message) console.error(`✗ ${metaFields.message}`);
  for (const m of metaFields.missingInTs) console.error(`✗ Rust 有而 TS 缺的键：${m}`);
  for (const m of metaFields.missingInRust) console.error(`✗ TS 有而 Rust 缺的键：${m}`);
  process.exit(1);
}

const read = readDtsApiNames({ dtsPath: DTS });
if (!read.ok) {
  console.error(read.message);
  process.exit(1);
}

const assertion = assertDtsExports({ dtsPath: DTS, apiNames: VIEWER_API, extraTokens: ['class BspProcessor'] });
const coverage = assertTsImportsCoveredByExports({
  tsRoot: join(ROOT, 'src'),
  pkgBasename: PKG_BASE,
  exports: extractExportsFromDts(DTS),
});
if (assertion.ok && coverage.ok && metaFields.ok) {
  console.log(`✓ WASM 契约通过：BspProcessor 类 + ${VIEWER_API.length} 个 API 全部导出。`);
  console.log(`  TS 导入符号 (${coverage.imports.length}): ${coverage.imports.join(', ')}`);
  console.log('  BspMetadata ↔ BspMeta 键名逐一对齐。');
  process.exit(0);
}

if (!assertion.ok) {
  console.error(`✗ WASM 契约缺失 ${assertion.missing.length} 项:`);
  for (const m of assertion.missing) console.error(`    - ${m}`);
  console.error('请先运行 npm run build:wasm（wasm-pack release）。');
}
if (!coverage.ok) {
  console.error(`✗ TS 导入了声明面之外的符号 ${coverage.missing.length} 个:`);
  for (const m of coverage.missing) console.error(`    - ${m}`);
}
if (!metaFields.ok) {
  if (metaFields.message) console.error(`✗ ${metaFields.message}`);
  if (metaFields.missingInTs.length) {
    console.error(`✗ Rust 有而 TS 缺的键 ${metaFields.missingInTs.length} 个（TS 侧会静默拿到 undefined）:`);
    for (const m of metaFields.missingInTs) console.error(`    - ${m}`);
  }
  if (metaFields.missingInRust.length) {
    console.error(`✗ TS 有而 Rust 缺的键 ${metaFields.missingInRust.length} 个:`);
    for (const m of metaFields.missingInRust) console.error(`    - ${m}`);
  }
}
process.exit(1);
