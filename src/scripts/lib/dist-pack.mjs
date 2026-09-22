/**
 * dist 打包内核 —— 三个应用工程共用的唯一实现。
 *
 * 调用方（三份都从 '../../../src/scripts/lib/dist-pack.mjs' 导入）：
 *   `apps/debug/scripts/build-dist.mjs`   `bundleIife` / `bundleEsm` /
 *       `writeEmbeddedPreamble` / `rewriteIndexToClassicScript` / `cleanDist` /
 *       `cleanStale` / `copyLicensePair` / `printTree`
 *   `apps/game/scripts/build-dist.mjs`    同上八项
 *   `apps/viewer/scripts/build-dist.mjs`  六项（不用 bundleEsm 与 copyLicensePair）
 * `commonEsbuildOptions` 与 `assertBuildFunction` 也导出，但当前没有任何外部导入方
 * （后者只被 `bundleIife` / `bundleEsm` 调用）。
 *
 * 硬约束（必须保持）：
 *   1. 本文件不 import esbuild：它只装在工程侧（各 apps/<app>/node_modules），仓库根与
 *      src/ 下都没有 node_modules。build 函数由调用方注入，未注入时
 *      `assertBuildFunction` 直接抛错，不静默产出空产物。
 *   2. 除 `node:` 内建外零裸说明符，也不 import 任何 apps/ 路径：内核位置固定，
 *      工程差异（wasm 文件名、入口、产物集）全部由参数传入。
 *   3. 判据：`git grep -nE "apps/|\.\./\.\./\.\." -- src/scripts/lib` 只命中注释。
 */
import { rm, mkdir, writeFile, readFile, copyFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 两路打包共用的 esbuild 配置：bundle / target / minify / sourcemap / write /
 * legalComments / logLevel。entryPoints、format 与写盘方式由 `bundleIife` /
 * `bundleEsm` 各自补齐。
 */
export function commonEsbuildOptions({ logLevel = 'warning', inlineImportMetaUrl = false } = {}) {
  const options = {
    bundle: true,
    target: 'es2022',
    minify: true,
    sourcemap: false,
    write: false,
    // 法律注释搬到产物末尾保留：上游 @unsurf/cs-movement 为 Apache-2.0
    // （全文见 src/phys/LICENSE，声明见 src/phys/NOTICE），勿改成 none
    legalComments: 'eof',
    logLevel,
  };
  if (inlineImportMetaUrl) {
    // 传 true 时用 define 把 import.meta.url 整体换成 JSON 字符串 'about:blank'：
    // IIFE 形态没有模块上下文，内嵌形态也不走 fetch（读取侧见
    // src/ts-shared/auth/worker-dispatch.ts）
    options.define = { 'import.meta.url': JSON.stringify('about:blank') };
  }
  return options;
}

/** 注入校验：build 必须是工程侧传入的 esbuild build 函数，否则抛错（硬约束 1 的负对照）。 */
export function assertBuildFunction(build) {
  if (typeof build !== 'function') {
    throw new Error('dist-pack: build 未注入（工程侧须 import { build } from \'esbuild\' 后传入）');
  }
  return build;
}

/** 打包为 IIFE，返回 outputFiles 首项的 text（write:false，不写盘）。 */
export async function bundleIife({ build, entry, options = {} }) {
  assertBuildFunction(build);
  const result = await build({
    ...commonEsbuildOptions({ logLevel: options.logLevel, inlineImportMetaUrl: true }),
    ...options,
    entryPoints: [entry],
    format: 'iife',
    write: false,
  });
  const file = result?.outputFiles?.[0];
  if (!file) throw new Error(`dist-pack: bundleIife 未产出文件（entry: ${entry}）`);
  return file.text;
}

/** 打包为 ESM（write:false 取文本），先 mkdir -p 目标目录再写入 outfile，返回 outfile。 */
export async function bundleEsm({ build, entry, outfile, options = {} }) {
  assertBuildFunction(build);
  const result = await build({
    ...commonEsbuildOptions({ logLevel: options.logLevel, inlineImportMetaUrl: false }),
    ...options,
    entryPoints: [entry],
    format: 'esm',
    write: false,
  });
  const file = result?.outputFiles?.[0];
  if (!file) throw new Error(`dist-pack: bundleEsm 未产出文件（entry: ${entry}）`);
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, file.text);
  return outfile;
}

/**
 * 拼装并写出 single 形态的 app.js，片段顺序为
 *   [upstreamLicense] + headerComment + globalThis.__VBSP_WASM_B64__ 赋值
 *   + [globalThis.__VBSP_WORKER_JS__ 赋值] + [globalThis.__VBSP_TEXTURES_MTZ_B64__ 赋值]
 *   + appCode
 * upstreamLicense 为空串时整段不写；workerJs / mtzB64 为 null 时对应片段整体不写。
 * 每个赋值都用 JSON.stringify 包装并以换行结尾。本函数不是全仓唯一的 __VBSP_* 拼装点：
 * `apps/viewer/scripts/build-dist.mjs` 为 multi 形态生成的 wasm-embedded.js 自己写
 * globalThis.__VBSP_WASM_B64__（fetch 失败时的内嵌回退副本）。
 * 返回 { path, bytes, preamble }：bytes 取 text.length（UTF-16 码元数），
 * apps/debug/scripts/build-dist.mjs 与 apps/game/scripts/build-dist.mjs 只取它打 MB；
 * path 与 preamble 当前无外部消费方。
 */
export async function writeEmbeddedPreamble({
  distDir,
  appFile = 'app.js',
  appCode,
  headerComment,
  upstreamLicense = '',
  wasmB64,
  workerJs = null,
  mtzB64 = null,
}) {
  if (typeof appCode !== 'string') throw new Error('dist-pack: writeEmbeddedPreamble 缺少 appCode');
  if (typeof headerComment !== 'string') throw new Error('dist-pack: writeEmbeddedPreamble 缺少 headerComment');
  const parts = [];
  if (upstreamLicense) parts.push(upstreamLicense);
  parts.push(headerComment);
  parts.push(`globalThis.__VBSP_WASM_B64__=${JSON.stringify(wasmB64)};\n`);
  if (workerJs != null) parts.push(`globalThis.__VBSP_WORKER_JS__=${JSON.stringify(workerJs)};\n`);
  if (mtzB64 != null) parts.push(`globalThis.__VBSP_TEXTURES_MTZ_B64__=${JSON.stringify(mtzB64)};\n`);
  const preamble = parts.join('');
  const text = preamble + appCode;
  await mkdir(distDir, { recursive: true });
  const target = join(distDir, appFile);
  await writeFile(target, text);
  return { path: target, bytes: text.length, preamble };
}

/**
 * 把 web/index.html 里的 <script type="module" src="./app.js"></script> 改写成
 * classic 的 <script src="./app.js"></script>（file:// 下 module script 被 CORS 拦），
 * 写到 distIndex。返回是否命中替换（false = 页面结构与预期不符，调用方须告警）。
 */
export async function rewriteIndexToClassicScript({ webIndex, distIndex }) {
  const html = await readFile(webIndex, 'utf8');
  const distHtml = html.replace(
    '<script type="module" src="./app.js"></script>',
    '<script src="./app.js"></script>',
  );
  await writeFile(distIndex, distHtml);
  return distHtml !== html;
}

/** 全量重建 dist/：先 rm -r 再 mkdir，返回 distDir（不留增量残留）。 */
export async function cleanDist(distDir) {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  return distDir;
}

/**
 * 删除 distDir 顶层不在 keep 名单里的**文件**（子目录原样保留），返回被删名字。
 * distDir 不存在时返回空数组。
 */
export async function cleanStale(distDir, keep) {
  const keepSet = new Set(keep);
  const removed = [];
  if (!existsSync(distDir)) return removed;
  for (const name of await readdir(distDir)) {
    if (keepSet.has(name)) continue;
    const p = join(distDir, name);
    if ((await stat(p)).isDirectory()) continue;
    await rm(p, { force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * 从许可证唯一源 repoRoot/srcDir 下的 LICENSE 与 NOTICE 拷贝**产物级副本**到 distDir，
 * 目标名由 targets 给定（LICENSE.cs-movement / NOTICE.cs-movement）。源缺失即抛错，
 * 不静默跳过。dist/ 里的副本属产物内容：`src/scripts/check-shared-sync.mjs` 的
 * `collectAppLicenseFiles` 跳过 dist 目录，故不会把它判成「apps/ 下的第二份许可源」。
 */
export async function copyLicensePair({
  repoRoot,
  distDir,
  srcDir = 'src/phys',
  names = ['LICENSE', 'NOTICE'],
  targets = ['LICENSE.cs-movement', 'NOTICE.cs-movement'],
}) {
  const written = [];
  await mkdir(distDir, { recursive: true });
  for (let i = 0; i < names.length; i++) {
    const from = join(repoRoot, srcDir, names[i]);
    if (!existsSync(from)) {
      throw new Error(`dist-pack: 许可证唯一源缺失 ${from}（D-23 / E-08：唯一源为 ${srcDir}/，工程内不得留源副本）`);
    }
    const to = join(distDir, targets[i]);
    await copyFile(from, to);
    written.push(to);
  }
  return written;
}

/**
 * 递归目录树：目录行 `  名字/` + 子项，文件行 `  名字  N KB`（N = size / 1024 取整）。
 * 返回字符串数组，调用方 join 换行后打印。
 */
export async function printTree(dir) {
  const out = [];
  for (const name of (await readdir(dir)).sort()) {
    const p = join(dir, name);
    const st = await stat(p);
    if (st.isDirectory()) out.push(`  ${name}/` + (await printTree(p)).join(''));
    else out.push(`  ${name}  ${(st.size / 1024).toFixed(0)} KB`);
  }
  return out;
}
