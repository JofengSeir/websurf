/**
 * dist 打包内核（D-04 / T-04）——三个应用工程共用的唯一实现。
 *
 * 谁在用：
 *   apps/debug/scripts/build-dist.mjs   （single + multi）
 *   apps/game/scripts/build-dist.mjs    （single + multi）
 *   apps/viewer/scripts/build-dist.mjs  （single-only，dist 自带启动器与说明）
 *
 * 硬约束（详见 documents/framework-decoupling.md D-04 / rollout-plan.md §3.2）：
 *   1. 本文件**不得** import esbuild —— 仓库根与 src/ 下都解析不到 esbuild
 *      （实测 require.resolve('esbuild', {paths:['src/scripts/lib']}) → MODULE_NOT_FOUND）。
 *      esbuild 的 build 函数由调用方（工程侧）作为参数注入；未注入时显式报错，
 *      绝不静默产出空产物。
 *   2. 本文件除 node: 内建外**零裸说明符**，也不得 import 任何 apps/* 路径：
 *      内核位置固定，工程差异（wasm 文件名、入口、产物集）全部由参数传入。
 *   3. 本文件的相对路径字符串只允许出现在注释里（判据：
 *      git grep -nE "apps/|\.\./\.\./\.\." -- src/scripts/lib 只命中注释）。
 *
 * 与规范的关系：framework-launch-structure.md §5.2/§5.3（形态与产物清单）、
 * §5.4（web/ 三产物与 dev 加载路径）、§7.2（新工程脚手架参考实现）、
 * framework-decoupling.md D-23 / §8.2 E-08（许可证唯一源 src/phys/）。
 */
import { rm, mkdir, writeFile, readFile, copyFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** esbuild 公共配置（single/IIFE 与 multi/ESM 共用；不含 entry/format/outfile）。 */
export function commonEsbuildOptions({ logLevel = 'warning', inlineImportMetaUrl = false } = {}) {
  const options = {
    bundle: true,
    target: 'es2022',
    minify: true,
    sourcemap: false,
    write: false,
    // 保留 @license 法律注释（@unsurf/cs-movement Apache-2.0 要求，勿移除）
    legalComments: 'eof',
    logLevel,
  };
  if (inlineImportMetaUrl) {
    // IIFE 不支持 import.meta.url；内嵌模式不走 fetch 路径，用占位符替换。
    options.define = { 'import.meta.url': JSON.stringify('about:blank') };
  }
  return options;
}

/** 注入校验：build 必须是工程侧传入的 esbuild build 函数（硬约束 1 的负对照）。 */
export function assertBuildFunction(build) {
  if (typeof build !== 'function') {
    throw new Error('dist-pack: build 未注入（工程侧须 import { build } from \'esbuild\' 后传入）');
  }
  return build;
}

/** 打包为 IIFE，返回打包后的源码文本（不写盘）。 */
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

/** 打包为 ESM 并写盘（outfile），返回写入的路径。 */
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
 * 拼装并写出 single 模式的 app.js：
 *   [upstreamLicense] + headerComment + globalThis.__VBSP_* 前缀 + appCode
 * 唯一允许拼装 __VBSP_* 的地方（规范 §5.4：single = base64 内嵌）。
 * 返回 { path, bytes, preamble }（preamble 供自检比对，不参与运行）。
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
 * 把 web/index.html 的 module script 改写为 classic script（file:// 下 module 被 CORS 拦截）
 * 并写入 dist/index.html。返回是否命中替换（false = 页面结构与预期不符，调用方须 [WARN]）。
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

/** 全量重建 dist/：先删后建（规范 §5.2 R-15，禁止增量残留）。 */
export async function cleanDist(distDir) {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  return distDir;
}

/**
 * 删除 dist/ 顶层不在 keep 名单内的文件（目录不动），返回被删名单。
 * cleanDist 已保证全量重建；本函数把「本形态的产物清单」写成可执行断言，
 * 供自定义产物集（规范 §7 脚手架）与回归自检使用。
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
 * 从许可证唯一源（src/phys/{LICENSE,NOTICE}，D-23 / E-08）拷贝产物级副本到 dist/。
 * dist/ 内的 LICENSE.cs-movement / NOTICE.cs-movement 是**产物级副本**（法律要求随
 * 产物分发），不是第二份源副本；源缺失即报错，不允许静默跳过。
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

/** 目录树（名字 + KB），供打包完成后打印产物清单。 */
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
