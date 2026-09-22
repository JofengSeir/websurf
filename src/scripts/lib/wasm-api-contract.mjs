/**
 * WASM API 契约引擎（共享）
 *
 * 定位：三个工程的 `scripts/check-wasm-api.mjs` 都是**薄配置**，只声明本工程的 pkg 名与
 * 契约清单；校验骨架（提取导出面、读声明文件、断言覆盖）全部落在本文件。
 * 本文件是**纯函数 + 参数**形态：
 *   - 零工程依赖：不 import 任何 apps/ 路径，不读 package.json；
 *   - 零裸模块说明符：只 import `node:` 内建，故可从仓库任意深度按相对路径导入；
 *   - 不打印、不 process.exit、不把业务失败当异常抛：只返回结果对象，输出文案与退出码
 *     由调用方决定（缺参数这类程序错误才 throw）。
 *
 * 依赖方向：工程薄配置 → 本引擎；引擎 → 无（不反向依赖任何工程）。
 * 各函数的调用方（三份薄配置的导入路径都是 '../../../src/scripts/lib/wasm-api-contract.mjs'）：
 *   assertDtsExports                 ← apps/debug、apps/game、apps/viewer 三份薄配置
 *   readDtsApiNames                  ← 同上三份
 *   assertTsImportsCoveredByExports  ← 同上三份
 *   extractExportsFromPkgJs          ← 仅 `apps/debug/scripts/check-wasm-api.mjs`
 *   extractExportsFromDts            ← 仅 `apps/game/scripts/check-wasm-api.mjs` 与
 *                                      `apps/viewer/scripts/check-wasm-api.mjs`
 *   findPkgEntryJs                   ← 当前无调用方
 *   DEFAULT_MISSING_PKG_HINT         ← 三份薄配置都不传 missingHint，故默认值生效
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 默认的「pkg 尚未构建」提示语；调用方可传 missingHint 覆盖，当前三份薄配置都用默认值。 */
export const DEFAULT_MISSING_PKG_HINT =
  '请先运行 npm run build:wasm（wasm-pack release）后再重试。';

/** 读取 UTF-8 文本；filePath 为空即抛错，文件不可读时 readFileSync 的异常向上抛。 */
function readTextFile(filePath) {
  if (!filePath) throw new Error('wasm-api-contract: 缺少必需参数 filePath');
  return readFileSync(filePath, 'utf8');
}

/**
 * pkg 目录下是否是 wasm-bindgen 的可加载入口 JS：名字以 .js 结尾且不以 .bg.js 结尾。
 * （.d.ts 本身不以 .js 结尾，故不会被这条规则单独排除。）
 * @param {string} fileName
 * @returns {boolean}
 */
function isPkgEntryJs(fileName) {
  return fileName.endsWith('.js') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.bg.js');
}

/**
 * 从任意文本（pkg 入口 .js 或 .d.ts）里提出导出符号名。
 *
 * 五条规则：export function / export class / export const（三类都允许 declare 前缀）、
 * export { … }（逐项取名字，`a as b` 取 `b`）、export default（记入字面量 'default'）。
 * 不覆盖 export let / export var、export * from、以及默认导出同时带名字的写法
 * （export default class X 只记 'default'）。
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
 * 从 pkg 目录下 wasm-bindgen 生成的入口 JS（<basename>.js）提取导出符号名。
 * 规则见 `extractExportNames`。
 *
 * @param {string} pkgJsPath
 * @returns {Set<string>}
 */
export function extractExportsFromPkgJs(pkgJsPath) {
  return extractExportNames(readTextFile(pkgJsPath));
}

/**
 * 从 pkg 目录下 wasm-bindgen 生成的声明文件（<basename>.d.ts）提取导出面。
 * 与 `extractExportsFromPkgJs` 共用 `extractExportNames`，故两种口径不会分叉。
 *
 * @param {string} dtsPath
 * @returns {Set<string>}
 */
export function extractExportsFromDts(dtsPath) {
  return extractExportNames(readTextFile(dtsPath));
}

/**
 * 读取声明文件全文，并做「存在性 + 非空」前置校验。
 * 返回 { ok, text, message }：ok=false 时调用方应打印 message 并以退出码 1 结束。
 *
 * 三种失败都转成 ok=false 而不抛异常：文件不存在、trim 后为空、读失败。这样
 * 「pkg 未构建」与「契约全缺」在调用方那里仍可区分。
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
 * - apiNames：逐个断言 `\b<name>\s*\(` 命中（方法/函数声明形态）。
 * - extraTokens：逐个断言 `\b<token>\b` 命中，不加括号约束（如 'class BspProcessor'）。
 * - missing 的顺序 = 先 extraTokens、后 apiNames；读取失败时 missing 为空数组，只带 message。
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
 * 断言「TS 源码对 pkg 的导入符号 ⊆ pkg 导出面」。
 *
 * 采集规则：递归 tsRoot 下全部 .ts/.tsx（不跳过任何子目录），只认说明符里出现
 * pkg/<pkgBasename> 的 import（后接 .js / .bg.js / .d.ts / .bg.d.ts / 无扩展名均可）。
 * 带命名列表的 import 逐项记入名字（剥掉 `type ` 前缀）；带默认导入名时记入 'default'
 * （pkg 的默认导出 init 在导出面里就叫 default）；只写默认导入的写法也记 'default'。
 * 副作用导入与 `import * as ns` 不采集。
 *
 * @param {{ tsRoot: string, pkgBasename: string, exports: Set<string>|string[] }} args
 *        pkgBasename 例：websurf_wasm（匹配 pkg 目录下同名的 JS / DTS）
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
 * 定位 pkg 目录下的 wasm-bindgen 入口 JS（.js 且非 .bg.js），取 readdirSync 顺序里的
 * 第一个命中项（未排序）；目录不存在时返回 null。
 * 当前无调用方（`extractExportsFromPkgJs` 的入参由各工程薄配置显式给出）。
 *
 * @param {string} pkgDir
 * @returns {string|null}
 */
export function findPkgEntryJs(pkgDir) {
  if (!existsSync(pkgDir)) return null;
  const hit = readdirSync(pkgDir).filter(isPkgEntryJs);
  return hit.length ? join(pkgDir, hit[0]) : null;
}
