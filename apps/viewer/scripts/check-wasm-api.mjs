/**
 * WASM 契约校验：确认 `pkg/websurf_viewer_wasm.d.ts` 导出了 viewer 实际使用的 API。
 *
 * 本文件是**薄配置**（D-03 / T-03 要求 viewer 补 `check:api` 时**不得**再复制第 4 份实现）：
 * 引擎在共享层 `src/scripts/lib/wasm-api-contract.mjs`，本文件只声明本工程的 pkg 名与契约面。
 *
 * 为什么清单只有 BspProcessor + initSync：viewer 是单入口最小查看器，
 * 其 `src/` 对 pkg 的全部导入就是 `apps/viewer/src/core/bsp.ts:3` 的
 * `import { BspProcessor, initSync } from '../../pkg/websurf_viewer_wasm.js'`（实测），
 * 因此声明面清单**取自实际消费面**而非「和 game 对齐」——多列未使用的 API 会让契约失去含义。
 * 同时用 `assertTsImportsCoveredByExports` 反向断言：源码若新增导入而声明面未跟上，本检查会失败。
 *
 * 用法：node scripts/check-wasm-api.mjs
 * 退出码：0 = 通过，1 = 不匹配
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDtsExports,
  assertTsImportsCoveredByExports,
  extractExportsFromDts,
  readDtsApiNames,
} from '../../../src/scripts/lib/wasm-api-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PKG_BASE = 'websurf_viewer_wasm';
const DTS = join(ROOT, 'pkg', `${PKG_BASE}.d.ts`);

// viewer 消费面：BSP 解析类 + wasm 同步初始化
const VIEWER_API = ['initSync'];

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

if (assertion.ok && coverage.ok) {
  console.log(`✓ WASM 契约通过：BspProcessor 类 + ${VIEWER_API.length} 个 API 全部导出。`);
  console.log(`  TS 导入符号 (${coverage.imports.length}): ${coverage.imports.join(', ')}`);
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
process.exit(1);
