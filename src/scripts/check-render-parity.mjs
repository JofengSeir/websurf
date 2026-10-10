#!/usr/bin/env node
/**
 * 渲染同源门禁（render parity）—— 静态断言 `apps/**` 不再出现「渲染实现符号」，且三端都经共享入口装配。
 *
 * 出处：任务书 `.tmp/task-unify-render/TASK.md` §5「`apps/**` 禁用写法」+ §0 判据 4（T-454 P7）。
 * 为什么需要它：P2（渲染器工厂）/P3（装配核 + 相机）/P4（可见性）/P7（两遍法 + 雾）已经把
 * 每种渲染能力收进 `src/renderer-shared/**`，但「谁在 apps 里偷偷又写了一遍」此前没有门禁——
 * 复制一份骨架不会编译失败，只会让三端在某个地图上悄悄分叉。
 *
 * 断言（逐条独立判定，任一失败即 exit 1）：
 *   A 实现符号：`apps/**` 0 命中，**无例外**（清单见 `IMPL_SYMBOLS`；`applyLightmapToMeshes(` 是
 *     旧名别名，`applyLightmap(` 是真名，两条都留；`renderer.compile(` 与
 *     `collectWorldTransitionTextures(` 取自 `.tmp/task-unify-render/TASK-handoff.md` §14.3）。
 *   B 旧偏好键字面量（`vbsp:panelPrefs` / `vbsp:uiPrefs`）：只许出现在 §5 白名单「各端面板/偏好 UI」
 *     的文件里（键的维护者），其余位置一律失败；白名单命中会逐条打印，不静默。
 *   C 三端共享入口装配：`apps/<app>/src/**` 的 import 面必须覆盖 `SHARED_ENTRIES` 全部共享模块
 *     （装配核 / 两遍法 / 渲染器工厂 / 可见性 / 相机口径 / 呈现档 / 位姿入口）。
 *   D app 清单同源：本脚本的 `APPS` 必须与 `apps/` 下的工程目录一致（防漏扫一端）。
 *   E 装配核实参透传：`mergeMain` 必须接收装配核传进来的 `(root, gltf)`——写成零参箭头会把实参
 *     丢掉，主模型合并整体早退（回落未合并的 mapRoot），**不会编译失败、只会静默退化**。
 *   F 底层提取口径同源：三端 `crates/wasm/src/lib.rs` 里 `collect_pakfile_models` 的
 *     `case_insensitive_model_names` 必须同值（跨端不同 ⇒ 同一张图导出的 prop 集合可能不同）。
 *     **当前为提示级**（待 `OWNER.md` 裁决基准），裁决落地后转硬断言。
 *   G 预编译必须晚于挂载：地图根 `scene.add(...)` 的行号必须小于 `precompileScene(...)` 的行号
 *     （早于它则编译的是空场景，预编译形同未做）。
 *   H 无 3D 天空盒时的清屏色三端同值（基准 `0x222222`）。
 *
 * 扫描面：`git ls-files --cached --others --exclude-standard` 下 `apps/**` 的 .ts/.mjs/.js，
 * 再排除 `pkg/`（wasm 胶水，生成物）、`dist/`、`node_modules/`。
 *
 * 用法：
 *   node src/scripts/check-render-parity.mjs            # 默认只打印结论
 *   node src/scripts/check-render-parity.mjs --verbose  # 逐条打印每个符号的命中数
 *
 * 退出码：任一硬断言（A/B/C/D/E/G/H）失败 → 1（逐条打印 `文件:行号` 与命中行）；全部通过 → 0。
 *
 * 能力边界：A/B/C 是静态文本判定——「符号没出现」不等于「行为已同源」；E/G/H 是**行为层**判定
 * （实参透传 / 调用顺序 / 取值同源），能守住 2026-10-10 全量排查里 R1 / R6 / R7 那类
 * 「编译得过、跑起来静默分叉」的缺陷。但以下仍需**像素基线 / 运行期探针**覆盖，本脚本管不到：
 *   - 合并后的实际块数与包围球垫圈是否生效（R1 的后果侧）；
 *   - 剔除距离与 PVS 开关的三端口径（R4 / R5，实现仍在各端私有路径上，见任务书）；
 *   - `normalizeGroup` 钩子是否只有一端注入（R8）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERBOSE = process.argv.includes('--verbose');

/** 三端工程目录名（断言 D 会核它与 `apps/` 同源）。 */
const APPS = ['debug', 'game', 'viewer'];

/** A 断言：渲染实现符号（`apps/**` 内出现即失败）。 */
const IMPL_SYMBOLS = [
  ['new THREE.WebGLRenderer', /new\s+THREE\.WebGLRenderer\b/],
  ['outputColorSpace =', /outputColorSpace\s*=/],
  ['toneMapping =', /toneMapping\s*=/],
  ['applyLightmapToMeshes(', /applyLightmapToMeshes\s*\(/],
  ['applyLightmap(', /applyLightmap\s*\(/],
  ['mergeIntoChunks(', /mergeIntoChunks\s*\(/],
  ['extractSkyArea(', /extractSkyArea\s*\(/],
  ['fullbrightUnlitLitMaterials(', /fullbrightUnlitLitMaterials\s*\(/],
  ['applyWorldTransitionShaders(', /applyWorldTransitionShaders\s*\(/],
  ['collectWorldTransitionTextures(', /collectWorldTransitionTextures\s*\(/],
  ['setExposure(', /setExposure\s*\(/],
  ['setLightGamma(', /setLightGamma\s*\(/],
  ['setAmbientScale(', /setAmbientScale\s*\(/],
  ['setPropVertexRelax(', /setPropVertexRelax\s*\(/],
  ['setPropVertexFlatten(', /setPropVertexFlatten\s*\(/],
  ['setFogMaxDensity(', /setFogMaxDensity\s*\(/],
  ['camera.far =', /camera\.far\s*=/],
  ['renderer.compile(', /renderer\.compile\s*\(/],
  ['padBoundingSpheres(', /padBoundingSpheres\s*\(/],
];

/** B 断言：只读兼容的旧偏好键字面量 + §5 白名单「各端面板/偏好 UI」的文件。 */
const LEGACY_PREF_KEYS = ['vbsp:panelPrefs', 'vbsp:uiPrefs'];
const PREF_UI_FILES = [
  /^apps\/game\/src\/panel\//,
  /^apps\/game\/src\/app\.ts$/,
  /^apps\/debug\/src\/app\.ts$/,
];

/** C 断言：三端都必须 import 的共享入口（模块相对 `src/` 的路径尾）。 */
const SHARED_ENTRIES = [
  ['装配核', 'renderer-shared/scene/assemble-scene.js'],
  ['两遍法/雾', 'renderer-shared/environment/render-sky-pass.js'],
  ['渲染器工厂', 'renderer-shared/render/create-renderer.js'],
  ['可见性', 'renderer-shared/scene/visibility-controller.js'],
  ['相机口径', 'renderer-shared/camera/scene-camera.js'],
  ['呈现档', 'renderer-shared/config/render-prefs.js'],
  ['位姿入口', 'renderer-shared/camera/pose-entry.js'],
];

/** E 断言：装配核第 ⑤ 步的 `mergeMain` 写成零参 ⇒ 丢弃装配核传入的 `(root, gltf)`。 */
const MERGE_MAIN_NOARG = /mergeMain:\s*(?:async\s*)?\(\s*\)/;

/** G 断言：地图根挂载（三端写法不同，故用共用模式）与预编译调用。 */
const MAP_ROOT_ADD = /this\.scene\.add\((?:mapRoot|scene|asm\.root)\)/;
const PRECOMPILE_CALL = /precompileScene\s*\(/;

/** H 断言：无 3D 天空盒时的清屏色基准（三端必须都出现该字面量）。 */
const BG_COLOR_LITERAL = '0x222222';

/** F 提示：底层 PAKFILE 模型提取口径（第一个布尔实参 = `case_insensitive_model_names`）。 */
const EXTRACT_CALL = /collect_pakfile_models\(\s*(?:&)?\w+\s*,\s*(true|false)\s*,/;

const files = execFileSync('git', ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'], {
  maxBuffer: 64 * 1024 * 1024,
})
  .toString('utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((f) => /^apps\//.test(f))
  .filter((f) => /\.(ts|mjs|js)$/.test(f))
  .filter((f) => !/(^|\/)(pkg|dist|node_modules)\//.test(f))
  .filter((f) => fs.existsSync(path.join(ROOT, f)));

const failures = [];
const notes = [];

// ── [A] 实现符号 ───────────────────────────────────────────────────────────
let symbolHits = 0;
for (const [name, re] of IMPL_SYMBOLS) {
  let hits = 0;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!re.test(line)) return;
      hits++;
      failures.push(`  [A] ${name} 出现在 ${f}:${i + 1}：${line.trim().slice(0, 120)}`);
    });
  }
  symbolHits += hits;
  if (VERBOSE) console.log(`  [A] ${name}：${hits} 命中`);
}

// ── [B] 旧偏好键字面量（只许 §5 白名单的偏好 UI 文件持有）─────────────────
let whitelistedPrefHits = 0;
for (const key of LEGACY_PREF_KEYS) {
  for (const f of files) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.includes(key)) return;
      if (PREF_UI_FILES.some((re) => re.test(f))) {
        whitelistedPrefHits++;
        notes.push(`  [B] 白名单「各端面板/偏好 UI」：${f}:${i + 1} 持有 ${key}`);
        return;
      }
      failures.push(`  [B] 旧偏好键字面量 ${key} 出现在 ${f}:${i + 1}（只许在 §5 白名单的偏好 UI 文件里）`);
    });
  }
}

// ── [C] 三端共享入口装配 ───────────────────────────────────────────────────
const entryReport = [];
for (const app of APPS) {
  const srcFiles = files.filter((f) => f.startsWith(`apps/${app}/src/`));
  const specifiers = [];
  for (const f of srcFiles) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/from\s*['"]([^'"]+)['"]/g)) specifiers.push({ file: f, spec: m[1] });
  }
  const missing = [];
  for (const [label, tail] of SHARED_ENTRIES) {
    if (!specifiers.some((s) => s.spec.replace(/\\/g, '/').endsWith(tail))) missing.push(`${label}（${tail}）`);
  }
  entryReport.push(`${app} ${SHARED_ENTRIES.length - missing.length}/${SHARED_ENTRIES.length}`);
  if (missing.length) failures.push(`  [C] apps/${app} 未 import 的共享入口：${missing.join('、')}`);
}

// ── [D] app 清单同源 ───────────────────────────────────────────────────────
const appsDir = path.join(ROOT, 'apps');
const onDisk = fs
  .readdirSync(appsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(appsDir, e.name, 'package.json')))
  .map((e) => e.name)
  .sort();
if (onDisk.join(',') !== APPS.slice().sort().join(',')) {
  failures.push(`  [D] apps/ 工程目录 [${onDisk.join(',')}] 与本脚本 APPS [${APPS.join(',')}] 不一致`);
}

// ── [E] 装配核实参透传 ─────────────────────────────────────────────────────
let mergeMainChecked = 0;
for (const f of files) {
  const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!/mergeMain\s*:/.test(line)) return;
    mergeMainChecked++;
    if (MERGE_MAIN_NOARG.test(line)) {
      failures.push(
        `  [E] ${f}:${i + 1} 的 mergeMain 写成零参 ⇒ 丢弃装配核传入的 (root, gltf)，主模型合并会整体早退：${line.trim().slice(0, 120)}`,
      );
    }
  });
}

// ── [F] 底层提取口径同源（提示级：待 OWNER.md 裁决后转硬断言）────────────────
const extractModes = [];
for (const app of APPS) {
  const libRs = path.join(ROOT, 'apps', app, 'crates', 'wasm', 'src', 'lib.rs');
  if (!fs.existsSync(libRs)) {
    failures.push(`  [F] apps/${app}/crates/wasm/src/lib.rs 不存在（无法核对提取口径）`);
    continue;
  }
  const text = fs.readFileSync(libRs, 'utf8');
  const modes = new Set();
  for (const m of text.matchAll(new RegExp(EXTRACT_CALL.source, 'g'))) modes.add(m[1]);
  extractModes.push(`${app}=${[...modes].sort().join('|') || '无调用'}(${[...text.matchAll(new RegExp(EXTRACT_CALL.source, 'g'))].length} 处)`);
}
const distinctModes = new Set(extractModes.map((s) => s.split('=')[1].replace(/\(\d+ 处\)/, '')));
if (distinctModes.size > 1) {
  notes.push(
    `  [F] 提示（不拦）：底层 collect_pakfile_models 的 case_insensitive_model_names 三端不同 ⇒ ${extractModes.join('、')}；` +
      `待 owner 裁决基准后本条转硬断言（差异后果：模型名大小写不一致时三端导出的 prop 集合不同）`,
  );
}

// ── [G] 预编译必须晚于挂载地图根 ───────────────────────────────────────────
const orderReport = [];
for (const app of APPS) {
  const srcFiles = files.filter((f) => f.startsWith(`apps/${app}/src/`));
  let addLine = -1;
  let preLine = -1;
  let addFile = '';
  let preFile = '';
  for (const f of srcFiles) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (MAP_ROOT_ADD.test(line)) {
        addLine = i + 1;
        addFile = f;
      }
      if (PRECOMPILE_CALL.test(line)) {
        preLine = i + 1;
        preFile = f;
      }
    });
  }
  if (preLine < 0) {
    failures.push(`  [G] apps/${app} 未调用 precompileScene（三端都应有）`);
    orderReport.push(`${app}:缺预编译`);
    continue;
  }
  if (addLine < 0) {
    failures.push(`  [G] apps/${app} 未找到地图根挂载（三端都应 scene.add 地图根）`);
    orderReport.push(`${app}:缺挂载`);
    continue;
  }
  orderReport.push(`${app}:add@${addLine}→precompile@${preLine}`);
  if (addLine > preLine) {
    failures.push(
      `  [G] apps/${app} 预编译早于地图根挂载：${preFile}:${preLine} 的 precompileScene 早于 ${addFile}:${addLine} 的 scene.add ⇒ 编译的是空场景`,
    );
  }
}

// ── [H] 无 3D 天空盒时的清屏色三端同值 ─────────────────────────────────────
const bgReport = [];
for (const app of APPS) {
  const srcFiles = files.filter((f) => f.startsWith(`apps/${app}/src/`));
  let hits = 0;
  for (const f of srcFiles) {
    if (fs.readFileSync(path.join(ROOT, f), 'utf8').includes(BG_COLOR_LITERAL)) hits++;
  }
  bgReport.push(`${app}:${hits}`);
  if (hits === 0) {
    failures.push(`  [H] apps/${app}/src/** 未出现清屏色基准 ${BG_COLOR_LITERAL} ⇒ 与另两端在无 3D 天空盒时背景不同`);
  }
}

// ── 结论 ───────────────────────────────────────────────────────────────────
console.log('渲染同源门禁（apps/**）');
console.log(`扫描面：${files.length} 个文件（git ls-files --cached --others --exclude-standard；排除 pkg/dist/node_modules）`);
console.log(`[A] 实现符号：${IMPL_SYMBOLS.length} 条断言，${symbolHits} 命中${symbolHits === 0 ? '（0 命中 = 全部经共享入口）' : ''}`);
console.log(`[B] 旧偏好键字面量：${whitelistedPrefHits} 处在 §5 白名单文件内`);
if (VERBOSE) for (const n of notes) console.log(n);
console.log(`[C] 三端共享入口装配：${entryReport.join('、')}（共 ${SHARED_ENTRIES.length} 项）`);
console.log(`[D] app 清单同源：apps/ = ${onDisk.join(',')}`);
console.log(`[E] 装配核实参透传：${mergeMainChecked} 处 mergeMain（零参即失败）`);
console.log(`[F] 底层提取口径：${extractModes.join('、')}${distinctModes.size > 1 ? ' ⇒ 不一致（提示级，待裁决）' : '（同源）'}`);
console.log(`[G] 预编译顺序（挂载→预编译）：${orderReport.join('、')}`);
console.log(`[H] 清屏色基准 ${BG_COLOR_LITERAL} 命中文件数：${bgReport.join('、')}`);
if (failures.length) {
  console.log(`\n渲染同源门禁：失败 ${failures.length} 条\n` + failures.join('\n'));
  process.exit(1);
}
console.log('\n渲染同源门禁：通过（exit 0）');
