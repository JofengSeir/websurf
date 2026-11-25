#!/usr/bin/env node
/**
 * check-shader-anchors.mjs —— Three.js 内置 GLSL 锚点静态门禁（T-P1-7）。
 *
 * 背景：`src/renderer-shared/shader/**` 大量依赖 three 内置着色器的 **原始
 * `#include <chunk>` 文本**做 `String.prototype.replace` 注入（`onBeforeCompile` 拿到的是
 * 尚未 `resolveIncludes` 的源码，见 lightmap-shader.ts:572-580）。three 小版本升级若改动
 * 某个 chunk 名，TypeScript 与 esbuild **都不会报错**，运行期只是静默替换失败（黑屏/失去光照）。
 *
 * 本脚本做四件事：
 *   1. 递归扫描 src/renderer-shared/shader 目录下的全部 .ts（去注释后）提取 `#include <name>` 字面量；
 *   2. 断言每个 name 在 `THREE.ShaderChunk` 中真实存在（唯一例外是显式声明的防御性通道）；
 *   3. 断言每个 name 真的出现在 `THREE.ShaderLib[*]` 的原始着色器模板里 —— 只存在于 ShaderChunk
 *      但没有任何材质模板 include 它的名字，`.replace()` 同样永远命中不到；
 *   4. 反空洞守卫：扫到的锚点总数必须 > 10（正则写坏 / 目录搬走时不允许“恒绿”）。
 *
 * 零外部依赖，只用仓库根已安装的 `three`（本地 `npm ci` / CI `ts-typecheck` job 都装了）。
 * 用法：node src/scripts/check-shader-anchors.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SHADER_DIR = join(REPO, 'src', 'renderer-shared', 'shader');

/** 反空洞守卫：扫描到的 `#include <...>` 字面量总数下限（必须严格大于该值）。 */
const MIN_OCCURRENCES = 10;
/** 反空洞守卫：不同锚点名下限。 */
const MIN_DISTINCT = 5;

/**
 * 允许缺失的锚点（显式豁免，必须写清理由）。
 *
 * 注意：豁免项**不计入** PASS 的锚点数，只在输出里标 `DEF`。若某天 three 补上了该 chunk，
 * 脚本会提示把它从豁免表移除（提示不改变退出码）。
 */
const DEFENSIVE_ANCHORS = new Map([
  [
    'lightmap_fragment',
    'three 0.165.0 的 ShaderChunk 只有 lightmap_pars_fragment、没有 lightmap_fragment；' +
      'src/renderer-shared/shader/lightmap-shader.ts:624-626 说明这是给未来版本的防御性通道，命中数恒为 0。',
  ],
]);

/**
 * 通过 `THREE.ShaderChunk[name]` 直接取块文本（而不是 `#include` 字面量）的名字。
 * 这些名字同样是硬契约：名字不存在 ⇒ 覆盖逻辑静默失效。
 */
const DIRECT_CHUNK_NAMES = new Map([
  ['colorspace_fragment', 'lightmap-shader.ts:794 COLORSPACE_CHUNK_NAME（installGamma22Output 覆盖 γ2.2 输出）'],
]);

const ANCHOR_RE = /#include\s*<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>/g;

/** 递归收集 .ts（跳过 *.d.ts）。 */
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
 * 把注释替换成空格（保留换行与字符偏移），字符串/模板字面量原样保留 ——
 * 锚点必须从**真实字符串字面量**里取，不能从注释里的举例取。
 */
function stripComments(src) {
  const chars = src.split('');
  const n = chars.length;
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
      continue;
    }
    i++;
  }
  return chars.join('');
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

async function main() {
  let THREE;
  try {
    // 动态 import：缺 three 时给出可执行的提示，而不是一个裸的 ERR_MODULE_NOT_FOUND。
    THREE = await import('three');
  } catch (err) {
    console.error('[check-shader-anchors] FAIL: 无法 import \'three\'（' + (err && err.message) + '）');
    console.error('[check-shader-anchors] 提示：先在本机仓库根跑 npm ci（CI 里由 ts-typecheck job 的 Install root shared dependencies 负责）。');
    process.exit(1);
  }

  const version = (() => {
    try {
      return JSON.parse(readFileSync(join(REPO, 'node_modules', 'three', 'package.json'), 'utf8')).version;
    } catch {
      return 'unknown';
    }
  })();

  // 目录搬走 / 改名时给出明确原因，而不是一个裸 ENOENT 栈。
  if (!existsSync(SHADER_DIR) || !statSync(SHADER_DIR).isDirectory()) {
    console.error('[check-shader-anchors] FAIL: 目录不存在 ' + SHADER_DIR);
    process.exit(1);
  }

  const files = walk(SHADER_DIR);
  if (files.length === 0) {
    console.error('[check-shader-anchors] FAIL: ' + SHADER_DIR + ' 下没有 .ts 文件（反空洞守卫）');
    process.exit(1);
  }

  /** name -> { occurrences, sites: Map<relPath, number[]> } */
  const seen = new Map();
  let occurrences = 0;

  for (const file of files) {
    const rel = relative(REPO, file).replace(/\\/g, '/');
    const text = stripComments(readFileSync(file, 'utf8'));
    ANCHOR_RE.lastIndex = 0;
    for (let m = ANCHOR_RE.exec(text); m; m = ANCHOR_RE.exec(text)) {
      const name = m[1];
      occurrences++;
      const entry = seen.get(name) ?? { occurrences: 0, sites: new Map() };
      entry.occurrences++;
      const lines = entry.sites.get(rel) ?? [];
      lines.push(lineOf(text, m.index));
      entry.sites.set(rel, lines);
      seen.set(name, entry);
    }
  }

  const shaderChunk = THREE.ShaderChunk ?? {};
  const libNames = Object.keys(THREE.ShaderLib ?? {});
  const libSources = libNames.map((n) => {
    const lib = THREE.ShaderLib[n] ?? {};
    return { name: n, src: String(lib.vertexShader ?? '') + '\n' + String(lib.fragmentShader ?? '') };
  });

  const ok = [];
  const defensive = [];
  const missing = [];
  const notEmitted = [];
  const presentDefensive = [];

  for (const [name, entry] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const inChunk = Object.prototype.hasOwnProperty.call(shaderChunk, name);
    const inLibs = libSources.filter((l) => l.src.includes('#include <' + name + '>')).map((l) => l.name);
    const siteText = [...entry.sites.entries()]
      .map(([f, lines]) => f + ':' + lines.join(','))
      .join(' ');

    if (inChunk) {
      if (inLibs.length === 0) {
        notEmitted.push({ name, entry, siteText });
      } else {
        ok.push({ name, entry, inLibs });
      }
    } else if (DEFENSIVE_ANCHORS.has(name)) {
      defensive.push({ name, entry, siteText });
    } else {
      missing.push({ name, entry, siteText });
    }
  }

  for (const name of DEFENSIVE_ANCHORS.keys()) {
    if (Object.prototype.hasOwnProperty.call(shaderChunk, name)) presentDefensive.push(name);
  }

  const directMissing = [];
  for (const [name, why] of DIRECT_CHUNK_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(shaderChunk, name)) directMissing.push(name + '（' + why + '）');
  }

  console.log('[check-shader-anchors] three ' + version + '（REVISION ' + (THREE.REVISION ?? '?') + '）');
  console.log(
    '[check-shader-anchors] 扫描 ' + files.length + ' 个文件 / ' + occurrences + ' 处锚点 / ' + seen.size + ' 个不同名字',
  );
  for (const item of ok) {
    console.log(
      '  OK   #include <' + item.name + '>  x' + item.entry.occurrences + '  出现在 ShaderLib: ' + item.inLibs.join(', '),
    );
  }
  for (const item of defensive) {
    console.log(
      '  DEF  #include <' + item.name + '>  x' + item.entry.occurrences + '  （豁免：' + DEFENSIVE_ANCHORS.get(item.name) + '）',
    );
  }
  for (const item of notEmitted) {
    console.log('  FAIL #include <' + item.name + '> 在 ShaderChunk 里存在，但没有任何 ShaderLib 材质模板 include 它');
    console.log('       ' + item.siteText);
  }
  for (const item of missing) {
    console.log('  FAIL #include <' + item.name + '> 不在 THREE.ShaderChunk 中');
    console.log('       ' + item.siteText);
  }
  for (const name of presentDefensive) {
    console.log(
      '  NOTE 豁免项 ' + name + ' 现在已经存在于 ShaderChunk —— 请把它从 check-shader-anchors.mjs 的 DEFENSIVE_ANCHORS 移除',
    );
  }
  for (const item of directMissing) {
    console.log('  FAIL ShaderChunk["' + item + '"] 不存在（被代码直接取用）');
  }

  const problems = [];
  if (occurrences <= MIN_OCCURRENCES) {
    problems.push(
      '反空洞守卫：只扫到 ' + occurrences + ' 处 #include <...> 字面量（要求 > ' + MIN_OCCURRENCES + '）—— ' +
        '正则或扫描目录疑似失效，不允许恒绿',
    );
  }
  if (seen.size < MIN_DISTINCT) {
    problems.push('反空洞守卫：只扫到 ' + seen.size + ' 个不同锚点名（要求 >= ' + MIN_DISTINCT + '）');
  }
  if (missing.length > 0) problems.push(missing.length + ' 个锚点在 THREE.ShaderChunk 中缺失');
  if (notEmitted.length > 0) problems.push(notEmitted.length + ' 个锚点没有被任何 ShaderLib 材质模板 include');
  if (directMissing.length > 0) problems.push(directMissing.length + ' 个直接取用的 ShaderChunk 名字缺失');
  if (ok.length === 0) problems.push('没有任何锚点通过校验');

  if (problems.length > 0) {
    console.error('');
    for (const p of problems) console.error('[check-shader-anchors] FAIL: ' + p);
    console.error('[check-shader-anchors] 结论：FAIL（three 版本或锚点文本已漂移，注入会静默失效）');
    process.exit(1);
  }

  const okOccurrences = ok.reduce((sum, item) => sum + item.entry.occurrences, 0);
  console.log(
    '[check-shader-anchors] PASS：' + ok.length + ' 个锚点 / ' + okOccurrences + ' 处通过' +
      '（另有 ' + defensive.length + ' 个已写明的防御性豁免）',
  );
  process.exit(0);
}

await main();