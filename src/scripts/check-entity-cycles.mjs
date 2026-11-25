#!/usr/bin/env node
/**
 * check-entity-cycles.mjs —— `src/ts-shared/entity/**` 的 import 环门禁（T-N3）。
 *
 * 背景：实体体系是 `classes/` 下的继承树 + `entity-system` / `entity-io` 的横向协作，
 * 类型定义（`types.ts` / `map-data.ts`）与实现（`base-entity.ts` / `classes/base.ts`）之间
 * 只差一层引用就成环。ESM 的循环 import 在 tsc 与 esbuild 阶段都是**静默**的：先求值
 * 的一侧拿到尚未初始化的绑定，运行期才炸 `ReferenceError: Cannot access 'X' before
 * initialization` 或 `undefined is not a constructor`，且只在特定入口的加载顺序下复现。
 * 本脚本把这类问题前移到门禁，进 `verify:fast` / `test:ts` / CI 的 ts-typecheck。
 *
 * 做四件事：
 *   1. 递归收集 `src/ts-shared/entity` 下的 .ts（跳过 *.d.ts）；
 *   2. 去注释后提取 `import ... from '...'`、`import type ... from '...'`、
 *      `export ... from '...'` 与副作用 `import '...'` 的模块字面量；只保留相对路径
 *      （裸模块名是外部依赖，不进图）；落在字符串字面量里的"假 import"不算；
 *   3. 相对路径按 ESM 约定解析回 .ts（`.js` 后缀映射回 `.ts`、目录取 `index.ts`），
 *      **解析不到的相对 import 直接判 FAIL** —— 写错的路径会让边静默消失，环也就查不出来；
 *   4. DFS 三色标记判环，环数必须为 0；反空洞守卫：文件数 >= 10、去重有向边 >= 20
 *      （目录搬走 / 正则写坏 / 全部被过滤时不允许"恒绿"）。
 *
 * 零外部依赖，不需要 wasm / node_modules。
 * 用法：node src/scripts/check-entity-cycles.mjs [--dir=<path>]
 *   `--dir` 只给门禁自测用（默认扫描仓库里的 entity 目录）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

/** 反空洞守卫：参与扫描的文件数下限。 */
const MIN_FILES = 10;
/** 反空洞守卫：去重后有向边数下限。 */
const MIN_EDGES = 20;

/** 语句级 `import ... from '...'` / `import type ... from '...'` / `export ... from '...'`。 */
const FROM_RE =
  /^[ \t]*(import|export)\b[^'";]*?\bfrom\b[ \t]*['"]([^'"]+)['"][ \t]*;?[ \t]*(?:\r?\n|$)/gm;
/** 副作用 import：`import './x.js';`（没有 from 子句）。 */
const SIDE_EFFECT_RE = /^[ \t]*import[ \t]*['"]([^'"]+)['"][ \t]*;?[ \t]*(?:\r?\n|$)/gm;

/** 递归收集 .ts（跳过 *.d.ts），按路径排序保证输出稳定。 */
function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) files.push(...walk(full));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) files.push(full);
  }
  files.sort();
  return files;
}

/**
 * 把注释替换成空格（保留换行与字符偏移），同时记下字符串字面量的区间。
 *
 * 返回 `{ code, strings }`：`strings` 是 `[start, end)` 偏移列表，用来剔除"写在字符串里的
 * import 文本"（例如文档字符串 / 夹具源码），避免正则把字面量当成真依赖。
 */
function scanSource(src) {
  const chars = src.split('');
  const n = chars.length;
  const strings = [];
  let i = 0;
  while (i < n) {
    const c = chars[i];
    const d = chars[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && chars[i] !== '\n') chars[i++] = ' ';
      continue;
    }
    if (c === '/' && d === '*') {
      chars[i++] = ' ';
      chars[i++] = ' ';
      while (i < n && !(chars[i] === '*' && chars[i + 1] === '/')) {
        if (chars[i] !== '\n') chars[i] = ' ';
        i++;
      }
      if (i < n) {
        chars[i++] = ' ';
        chars[i++] = ' ';
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const start = i;
      i++;
      while (i < n) {
        if (chars[i] === '\\') {
          i += 2;
          continue;
        }
        if (chars[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      strings.push([start, i]);
      continue;
    }
    i++;
  }
  return { code: chars.join(''), strings };
}

/** 偏移是否落在某个字符串字面量内（匹配置信度用，不是解析器）。 */
function insideStrings(index, strings) {
  for (const [start, end] of strings) {
    if (index >= start && index < end) return true;
    if (start > index) break;
  }
  return false;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * 相对路径 → 仓库内的 .ts 绝对路径。
 *
 * @returns {{file: string} | {bare: true} | {unresolved: true}}
 */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return { bare: true };
  const base = resolve(dirname(fromFile), spec);
  const candidates = [];
  if (base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts');
  else if (base.endsWith('.mjs')) candidates.push(base.slice(0, -4) + '.ts');
  candidates.push(base, base + '.ts', join(base, 'index.ts'));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return { file: candidate };
  }
  return { unresolved: true };
}

/** 规范化环报告：把环旋转到字典序最小的节点开头，便于去重。 */
function canonicalCycle(nodes) {
  const body = nodes.slice(0, -1);
  let best = 0;
  for (let i = 1; i < body.length; i++) {
    if (body[i] < body[best]) best = i;
  }
  const rotated = body.slice(best).concat(body.slice(0, best));
  return rotated.concat(rotated[0]);
}

async function main() {
  const dirArg = process.argv.find((arg) => arg.startsWith('--dir='));
  const entityDir = dirArg ? resolve(REPO, dirArg.slice('--dir='.length)) : join(REPO, 'src', 'ts-shared', 'entity');

  if (!existsSync(entityDir) || !statSync(entityDir).isDirectory()) {
    console.error('[check-entity-cycles] FAIL: 目录不存在 ' + entityDir);
    process.exit(1);
  }

  const files = walk(entityDir);
  const relOf = (file) => relative(REPO, file).replace(/\\/g, '/');
  const relFiles = files.map(relOf);

  /** @type {{from: string, to: string, line: number, spec: string, kind: string}[]} */
  const sites = [];
  const unresolved = [];
  let importCount = 0;

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const { code, strings } = scanSource(text);
    const from = relOf(file);
    for (const [re, kind] of [
      [FROM_RE, 'from'],
      [SIDE_EFFECT_RE, 'side-effect'],
    ]) {
      re.lastIndex = 0;
      for (let m = re.exec(code); m; m = re.exec(code)) {
        if (insideStrings(m.index, strings)) continue;
        const spec = kind === 'from' ? m[2] : m[1];
        importCount++;
        const resolved = resolveSpec(file, spec);
        if (resolved.bare) continue;
        const line = lineOf(code, m.index);
        if (resolved.unresolved) {
          unresolved.push({ from, spec, line });
          continue;
        }
        sites.push({ from, to: relOf(resolved.file), line, spec, kind });
      }
    }
  }

  // 去重有向边（同一对文件之间可能有多条 import 语句）。
  const edgeSites = new Map();
  for (const site of sites) {
    const key = site.from + '\u0000' + site.to;
    const list = edgeSites.get(key) ?? [];
    list.push(site);
    edgeSites.set(key, list);
  }
  const adj = new Map();
  for (const site of sites) {
    const list = adj.get(site.from) ?? [];
    if (!list.some((e) => e.to === site.to)) list.push({ to: site.to, sites: edgeSites.get(site.from + '\u0000' + site.to) });
    adj.set(site.from, list);
  }

  // DFS 三色标记：0 未访问、1 在栈上、2 已完成；回边即一个环。
  const color = new Map(relFiles.map((f) => [f, 0]));
  const stack = [];
  const rawCycles = [];
  const visit = (node) => {
    color.set(node, 1);
    stack.push(node);
    for (const edge of adj.get(node) ?? []) {
      const c = color.get(edge.to) ?? 0;
      if (c === 0) visit(edge.to);
      else if (c === 1) rawCycles.push(stack.slice(stack.indexOf(edge.to)).concat(edge.to));
    }
    stack.pop();
    color.set(node, 2);
  };
  for (const file of relFiles) if (color.get(file) === 0) visit(file);

  const cycles = [];
  const seenCycles = new Set();
  for (const nodes of rawCycles) {
    const canonical = canonicalCycle(nodes);
    const key = canonical.join(' -> ');
    if (seenCycles.has(key)) continue;
    seenCycles.add(key);
    const hops = [];
    for (let i = 0; i + 1 < canonical.length; i++) {
      const from = canonical[i];
      const to = canonical[i + 1];
      const hopSites = edgeSites.get(from + '\u0000' + to) ?? [];
      hops.push({ from, to, lines: hopSites.map((s) => s.line) });
    }
    cycles.push({ nodes: canonical, hops });
  }

  const uniqueEdges = edgeSites.size;
  console.log(
    '[check-entity-cycles] 扫描 ' + files.length + ' 个文件 / ' + importCount + ' 条 import 语句 / ' +
      uniqueEdges + ' 条去重有向边',
  );

  const problems = [];
  if (files.length < MIN_FILES) {
    problems.push(
      '反空洞守卫：只扫到 ' + files.length + ' 个 .ts 文件（要求 >= ' + MIN_FILES + '）—— 目录或遍历逻辑疑似失效',
    );
  }
  if (uniqueEdges < MIN_EDGES) {
    problems.push(
      '反空洞守卫：只扫到 ' + uniqueEdges + ' 条去重有向边（要求 >= ' + MIN_EDGES + '）—— 正则或解析疑似失效，不允许恒绿',
    );
  }
  if (unresolved.length > 0) {
    problems.push(unresolved.length + ' 条相对 import 解析不到 .ts（写错的路径会让边静默消失）');
  }
  if (cycles.length > 0) problems.push(cycles.length + ' 个 import 环');

  for (const item of unresolved) {
    console.log('  FAIL ' + item.from + ':' + item.line + "  import '" + item.spec + "' 解析不到文件");
  }
  for (const cycle of cycles) {
    console.log('  FAIL 环: ' + cycle.nodes.join(' -> '));
    for (const hop of cycle.hops) {
      console.log('       ' + hop.from + ' -> ' + hop.to + '  @' + hop.lines.join(','));
    }
  }

  if (problems.length > 0) {
    console.error('');
    for (const p of problems) console.error('[check-entity-cycles] FAIL: ' + p);
    console.error('[check-entity-cycles] 结论：FAIL（实体层的 ESM 循环依赖会在特定加载顺序下静默炸初始化）');
    process.exit(1);
  }

  console.log(
    '[check-entity-cycles] PASS：0 个环（' + files.length + ' 个文件 >= ' + MIN_FILES + '，' +
      uniqueEdges + ' 条有向边 >= ' + MIN_EDGES + '）',
  );
  process.exit(0);
}

await main();
