/**
 * WASM API 契约引擎（共享，D-03 / T-03）
 *
 * 定位：把原先在 debug / game / harness 三份 `scripts/check-wasm-api.mjs` 中各自实现的
 * 校验骨架收敛为**唯一实现**。本文件是**纯函数 + 参数**形态：
 *   - 零工程依赖：不 import 任何 `apps/` 路径，不读 `package.json`；
 *   - 零裸模块说明符：只 import `node:` 内建（因此可从仓库任意深度被相对路径导入）；
 *   - 不打印、不 `process.exit`、不抛业务错误：只返回结果对象，由调用方（薄配置）决定
 *     输出文案与退出码。
 *
 * 依赖方向（【必须】，规范 §5.4 规则 2）：
 *   工程薄配置 → 本引擎；引擎 → 无（不得反向依赖任何工程）。
 *   3 个函数对应的调用方：
 *     extractExportsFromPkgJs          ← debug（动态比对导出面）
 *     readDtsApiNames / extractExportsFromDts ← game / viewer（声明面比对）
 *     assertTsImportsCoveredByExports  ← debug（TS 导入面 ⊆ 导出面）
 *
 * 用法（工程薄配置，深度 D=3）：
 *   import { assertDtsExports, readDtsApiNames, extractExportsFromDts }
 *     from '../../../src/scripts/lib/wasm-api-contract.mjs';
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 默认的「pkg 尚未构建」提示语（各工程可按需覆盖，避免文案分叉） */
export const DEFAULT_MISSING_PKG_HINT =
  '请先运行 npm run build:wasm（wasm-pack release）后再重试。';

/** 读取文本；读不到时抛出带路径的错误（避免静默产出空契约） */
function readTextFile(filePath) {
  if (!filePath) throw new Error('wasm-api-contract: 缺少必需参数 filePath');
  return readFileSync(filePath, 'utf8');
}

/**
 * pkg 目录下是否为 wasm-bindgen 的可加载入口 JS（排除 `.d.ts` / `.bg.js` 等辅助文件）
 * @param {string} fileName
 * @returns {boolean}
 */
function isPkgEntryJs(fileName) {
  return fileName.endsWith('.js') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.bg.js');
}

/**
 * 从任意文本（pkg 入口 `.js` 或 `.d.ts`）提取导出符号名。
 *
 * 覆盖 6 类写法：`export function` / `export class` / `export const` /
 * `export { a, b as c }`（`as` 取别名） / `export default` / `export declare class`。
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function extractExportNames(text) {
  const out = new Set();
  for (const m of text.matchAll(/export\s+(?:declare\s+)?function\s+(\w+)/g)) out.add(m[1]);
  for (const m of text.matchAll(/export\s+(?:declare\s+)?class\s+(\w+)/g)) out.add(m[1]);
  for (const m of text.matchAll(/export\s+(?:declare\s+)?const\s+(\w+)/g)) out.add(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const item of m[1].split(',')) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
      out.add(asMatch ? asMatch[2] : trimmed);
    }
  }
  if (/export\s+default\s+/.test(text)) out.add('default');
  return out;
}

/**
 * 从 `pkg/<basename>.js`（wasm-bindgen 生成入口）提取导出符号名。
 *
 * @param {string} pkgJsPath
 * @returns {Set<string>}
 */
export function extractExportsFromPkgJs(pkgJsPath) {
  return extractExportNames(readTextFile(pkgJsPath));
}

/**
 * 从 `pkg/<basename>.d.ts`（wasm-bindgen 生成声明）提取导出面。
 * 与 `extractExportsFromPkgJs` 共用同一套提取规则，故两种口径不会分叉。
 *
 * @param {string} dtsPath
 * @returns {Set<string>}
 */
export function extractExportsFromDts(dtsPath) {
  return extractExportNames(readTextFile(dtsPath));
}

/**
 * 读取声明文件全文，并做「存在性 + 非空」前置校验。
 * 返回 `{ ok, text, message }`：`ok=false` 时调用方应打印 `message` 并以退出码 1 结束。
 *
 * 注意：不得在 `existsSync` 失败时静默返回空契约——那会把「pkg 未构建」变成「契约全缺」的
 * 误导性报错（原 debug/game 两份脚本的差异之一）。
 *
 * @param {{ dtsPath: string, missingHint?: string }} args
 * @returns {{ ok: boolean, text?: string, message?: string }}
 */
export function readDtsApiNames({ dtsPath, missingHint = DEFAULT_MISSING_PKG_HINT } = {}) {
  if (!dtsPath) throw new Error('wasm-api-contract: readDtsApiNames 缺少 dtsPath');
  if (!existsSync(dtsPath)) {
    return { ok: false, message: `wasm-api-contract: 未找到 ${dtsPath}。${missingHint}` };
  }
  try {
    const text = readTextFile(dtsPath);
    if (!text.trim()) {
      return { ok: false, message: `wasm-api-contract: ${dtsPath} 为空文件（pkg 可能未构建完成）。` };
    }
    return { ok: true, text };
  } catch (error) {
    return { ok: false, message: `wasm-api-contract: 无法读取 ${dtsPath}（${error.message}）。` };
  }
}

/**
 * 断言声明文件覆盖给定契约面。
 *
 * - `apiNames`：逐个断言「声明中出现了该符号」，判据为 `\b<name>\s*\(`（方法/函数声明）。
 * - `extraTokens`：不做括号约束的额外断言（如 `class BspProcessor`），用于验证装饰类。
 *
 * @param {{ dtsPath: string, apiNames?: string[], extraTokens?: string[], missingHint?: string }} args
 * @returns {{ ok: boolean, missing: string[], message?: string }}
 */
export function assertDtsExports({ dtsPath, apiNames = [], extraTokens = [], missingHint } = {}) {
  const read = readDtsApiNames({ dtsPath, ...(missingHint === undefined ? {} : { missingHint }) });
  if (!read.ok) return { ok: false, missing: [], message: read.message };

  const dts = read.text;
  const missing = [];
  for (const token of extraTokens) {
    if (!new RegExp(`\\b${token}\\b`).test(dts)) missing.push(token);
  }
  for (const name of apiNames) {
    if (!new RegExp(`\\b${name}\\s*\\(`).test(dts)) missing.push(name);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * 断言「TS 源码中的 pkg 导入符号 ⊆ pkg 导出面」。
 *
 * 判据与原始 debug 实现一致：带命名列表的 `import` 记入每个符号（剥掉 `type ` 前缀）；
 * **默认导入记入 `default`**（`init` 这一默认导出在 pkg 里名为 `default`）。
 *
 * @param {{ tsRoot: string, pkgBasename: string, exports: Set<string>|string[] }} args
 *        `pkgBasename` 例：`websurf_wasm`（匹配 `pkg/websurf_wasm(.js|.bg.js|…)`）
 * @returns {{ ok: boolean, imports: string[], missing: string[], scannedFiles: number }}
 */
export function assertTsImportsCoveredByExports({ tsRoot, pkgBasename, exports } = {}) {
  if (!tsRoot) throw new Error('wasm-api-contract: assertTsImportsCoveredByExports 缺少 tsRoot');
  if (!pkgBasename) throw new Error('wasm-api-contract: assertTsImportsCoveredByExports 缺少 pkgBasename');
  const exportSet = exports instanceof Set ? exports : new Set(exports ?? []);
  const imports = new Set();
  let scannedFiles = 0;

  // 只匹配「本 pkg」的导入说明符：pkg/<basename> 后允许 .js/.d.ts/.bg.js 或无扩展名
  const spec = `pkg/${pkgBasename}(?:\\.(?:bg\\.)?(?:js|d\\.ts))?['"]`;
  const withNamed = new RegExp(`import\\s+(?:(\\w+)\\s*,\\s*)?\\{([^}]*)\\}\\s+from\\s+['"][^'"]*${spec}`, 'g');
  const defaultOnly = new RegExp(`import\\s+(\\w+)\\s+from\\s+['"][^'"]*${spec}`, 'g');

  const scanDir = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(full);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        scannedFiles++;
        const text = readTextFile(full);
        for (const m of text.matchAll(withNamed)) {
          if (m[1]) imports.add('default');
          for (const raw of m[2].split(',')) {
            const name = raw.trim().replace(/^type\s+/, '');
            if (name) imports.add(name);
          }
        }
        for (const m of text.matchAll(defaultOnly)) {
          if (!m[0].includes('{')) imports.add('default');
        }
      }
    }
  };

  scanDir(tsRoot);
  const importList = [...imports].sort();
  const missing = importList.filter((name) => !exportSet.has(name));
  return { ok: missing.length === 0, imports: importList, missing, scannedFiles };
}

/**
 * 定位 `pkg/` 下的 wasm-bindgen 入口 JS（`<basename>.js`，排除 `.d.ts` / `.bg.js`）。
 * 供「未显式传 pkgJsPath」的调用方使用。
 *
 * @param {string} pkgDir
 * @returns {string|null}
 */
export function findPkgEntryJs(pkgDir) {
  if (!existsSync(pkgDir)) return null;
  const hit = readdirSync(pkgDir).filter(isPkgEntryJs);
  return hit.length ? join(pkgDir, hit[0]) : null;
}
