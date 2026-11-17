/**
 * 依赖/导出面一致性门禁（task-57 G4）。
 *
 * 背景：三端各自独立 Cargo workspace（debug/game 依赖共享 `websurf-phys` 路径 crate，viewer 只依赖
 * `websurf-wasm-core`）；wasm 导出面因 feature 差异天然不同（debug 94 / game 80 / viewer 27）。
 * 没有机械门禁时，这些差异会静默漂移。本脚本把「允许的差异」写成显式白名单：
 *   - 物理内核：debug/game 的 crates/wasm/Cargo.toml 必须 path 依赖同一个 `../../../../src`；
 *     viewer 必须不含 websurf-phys；Cargo.lock 中 websurf-phys 只出现在 debug/game；
 *   - 共同包版本：debug↔game 的共同包版本必须一致，只允许已登记的小版本差（3 个）；
 *   - 共享核心 crate：wasm-bindgen/serde/serde_json/js-sys 三端版本一致；
 *   - wasm 导出面：game ⊆ debug（game 独有必须为空）；debug 独有必须正好等于登记清单；
 *     viewer 独有必须正好等于登记清单；物理导出（physworld_* 与 PhysWorld）必须在 debug/game 一致、
 *     且 viewer 为 0；
 *   - wasm 字符串契约：三端 wasm 必须含 vbsp_* 6 个注入键 + take_mosaic_manifest/setVmtFallback/
 *     export_entity_io（CI_GLB_GATE 的立即可用替代，抓 viewer pkg 漂移）。
 *
 * 缺失口径：Cargo.lock/Cargo.toml 是**入库源码**（源码类门禁没有「无产物」场景），缺失即 FAIL；
 * 仅 `apps/<app>/pkg` 属于构建产物：全缺 ⇒ 打印 SKIP 并 exit 0（CI 未构建 wasm 的 job），部分缺失
 * ⇒ FAIL（存在而判据无法计算）。
 *
 * 用法：`node src/scripts/check-lock-consistency.mjs [--root <dir>]`
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ROOT = arg('--root', process.cwd());
const APPS = ['debug', 'game', 'viewer'];

const violations = [];
const skips = [];
const fail = (m) => violations.push(m);
const skip = (m) => skips.push(m);

// ── 1) Cargo.lock ───────────────────────────────────────────────────────────
/** 已登记的 debug↔game 小版本差（锁文件时间不同步导致；新差异必须显式登记）。 */
const ALLOWED_VERSION_DIFFS = new Set(['bytemuck_derive', 'zerocopy', 'zerocopy-derive']);
/** 三端必须同版本的共享核心 crate。 */
const CORE_CRATES = ['wasm-bindgen', 'serde', 'serde_json', 'js-sys'];
/** 必须 path 依赖共享物理 crate 的 Cargo.toml。 */
const PHYS_PATH_DEP = 'websurf-phys';

function parseLock(file) {
  const text = readFileSync(file, 'utf8');
  const pkgs = new Map();
  for (const block of text.split('[[package]]').slice(1)) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block);
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block);
    if (name && version) pkgs.set(name[1], version[1]);
  }
  return pkgs;
}

const locks = {};
const lockPaths = {};
for (const app of APPS) {
  const p = join(ROOT, 'apps', app, 'Cargo.lock');
  lockPaths[app] = p;
  if (existsSync(p)) locks[app] = parseLock(p);
}
const lockKeys = Object.keys(locks);
if (lockKeys.length === 0) {
  // 锁文件入库；全缺说明仓库被裁剪/门禁被绕过 ⇒ 不能当成功
  fail('三端 Cargo.lock 均不存在（源码类门禁：锁文件入库，缺失即 FAIL 而非 SKIP）');
} else if (lockKeys.length !== APPS.length) {
  fail(`Cargo.lock 部分缺失：${APPS.filter((a) => !locks[a]).join(',')}（全缺才 SKIP）`);
} else {
  // 物理内核归属
  if (!locks.debug.has(PHYS_PATH_DEP)) fail('apps/debug/Cargo.lock 不含 websurf-phys（物理内核未接入）');
  if (!locks.game.has(PHYS_PATH_DEP)) fail('apps/game/Cargo.lock 不含 websurf-phys（物理内核未接入）');
  if (locks.viewer.has(PHYS_PATH_DEP)) fail('apps/viewer/Cargo.lock 含 websurf-phys（viewer 无物理是架构约定）');
  if (locks.debug.get(PHYS_PATH_DEP) !== locks.game.get(PHYS_PATH_DEP)) {
    fail(`websurf-phys 版本不一致：debug=${locks.debug.get(PHYS_PATH_DEP)} game=${locks.game.get(PHYS_PATH_DEP)}`);
  }
  // 共享核心 crate 三端同版本
  for (const crate of CORE_CRATES) {
    const got = APPS.map((a) => `${a}=${locks[a].get(crate) ?? '(absent)'}`);
    if (new Set(got.map((s) => s.split('=')[1])).size !== 1) fail(`共享 crate ${crate} 三端版本不一致：${got.join(' ')}`);
  }
  // debug↔game 共同包版本（白名单外必须一致）
  const commonDG = [...locks.debug.keys()].filter((n) => locks.game.has(n));
  const newDiffs = commonDG
    .filter((n) => locks.debug.get(n) !== locks.game.get(n) && !ALLOWED_VERSION_DIFFS.has(n))
    .map((n) => `${n}:${locks.debug.get(n)}/${locks.game.get(n)}`);
  for (const d of newDiffs) fail(`debug↔game 共同包出现未登记版本差：${d}`);
  const allowedSeen = commonDG.filter((n) => locks.debug.get(n) !== locks.game.get(n));
  // viewer 是独立薄 workspace：与共享端的版本差只做 INFO（不 fail）
  const viewerDiffCount = [...locks.debug.keys()].filter((n) => locks.viewer.has(n) && locks.debug.get(n) !== locks.viewer.get(n)).length;
  console.log(`[lock] Cargo.lock：debug=${locks.debug.size} game=${locks.game.size} viewer=${locks.viewer.size} 包；` +
    `debug/game 共同包 ${commonDG.length}，已登记版本差 ${allowedSeen.join(',') || '(none)'}；viewer 与 debug 版本差 ${viewerDiffCount}（INFO，独立 workspace）`);
}

// Cargo.toml 路径依赖（比 lock 更直接：确认是同一个 crate 路径）
for (const app of ['debug', 'game']) {
  const p = join(ROOT, 'apps', app, 'crates', 'wasm', 'Cargo.toml');
  if (!existsSync(p)) { fail(`apps/${app}/crates/wasm/Cargo.toml 不存在`); continue; }
  const text = readFileSync(p, 'utf8');
  if (!new RegExp(`${PHYS_PATH_DEP}\\s*=\\s*\\{[^}]*path\\s*=\\s*"\\.\\./\\.\\./\\.\\./\\.\\./src"`).test(text)) {
    fail(`apps/${app}/crates/wasm/Cargo.toml 未 path 依赖 ../../../../src（${PHYS_PATH_DEP}）`);
  }
}
const viewerToml = join(ROOT, 'apps', 'viewer', 'crates', 'wasm', 'Cargo.toml');
if (existsSync(viewerToml)) {
  // TOML 注释里可能声明「不含 websurf-phys」（设计说明），必须剥注释后判依赖行。
  const tomlCode = readFileSync(viewerToml, 'utf8').replace(/#[^\n]*/g, '');
  if (new RegExp(`^\\s*${PHYS_PATH_DEP}\\s*=`, 'm').test(tomlCode)) {
    fail('apps/viewer/crates/wasm/Cargo.toml 依赖 websurf-phys（viewer 无物理是架构约定）');
  }
}

// ── 2) pkg 导出面 + wasm 字符串契约 ─────────────────────────────────────────
/** game 必须相对 debug 缺失的导出（feature 差异，显式登记）。 */
const ALLOWED_DEBUG_ONLY_EXPORTS = [
  'ChromaSampling',
  'bspprocessor_export_colliders',
  'bspprocessor_export_colliders_with_filter',
  'bspprocessor_export_glb_with_models',
  'bspprocessor_export_missing_model_textures',
  'bspprocessor_export_model_phy_bevels',
  'bspprocessor_list_pakfile',
  'bspprocessor_pack_get',
  'bspprocessor_pack_stats',
  'bspprocessor_read_pakfile_scripts',
  'compress_mtz',
  'disp_vertex_alpha_stats',
  'export_visleaf_pvs',
  'parse_bsp',
  'start',
];
/** viewer 相对 debug 允许的独有导出。 */
const ALLOWED_VIEWER_ONLY_EXPORTS = ['bspprocessor_probeMissingResources'];
/** 三端 wasm 都必须含的字符串契约（材质注入键 + 导出入口名）。 */
const WASM_STRING_CONTRACT = [
  'vbsp_water', 'vbsp_additive', 'vbsp_render_color',
  'vbsp_render_mode', 'vbsp_rot_button', 'vbsp_texture_scroll',
  'take_mosaic_manifest', 'setVmtFallback', 'export_entity_io',
];
const PHYS_EXPORT_RE = /^physworld_|^PhysWorld$/;

const pkgDirs = {};
for (const app of APPS) {
  const dir = join(ROOT, 'apps', app, 'pkg');
  pkgDirs[app] = existsSync(dir) ? dir : null;
}
const pkgPresent = Object.values(pkgDirs).filter(Boolean).length;
const exportSets = {};
const wasmFiles = {};
if (pkgPresent === 0) {
  skip('三端 apps/*/pkg 均不存在（CI 未构建 wasm 的 job；导出面/字符串契约部分跳过）');
} else {
  for (const app of APPS) {
    const dir = pkgDirs[app];
    if (!dir) { fail(`apps/${app}/pkg 缺失而其他端存在（部分缺失时判据无法完整计算）`); continue; }
    const dts = readdirSync(dir).filter((n) => n.endsWith('.d.ts'));
    const wasm = readdirSync(dir).filter((n) => n.endsWith('.wasm'));
    if (dts.length === 0) fail(`apps/${app}/pkg 中没有 .d.ts（导出面判据无法计算）`);
    if (wasm.length === 0) fail(`apps/${app}/pkg 中没有 .wasm（字符串契约判据无法计算）`);
    const names = new Set();
    for (const f of dts) {
      const text = readFileSync(join(dir, f), 'utf8');
      for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
    }
    exportSets[app] = names;
    wasmFiles[app] = wasm.length ? join(dir, wasm[0]) : null;
    if (names.size === 0) fail(`apps/${app}/pkg 的 d.ts 解析出 0 个导出（格式变化，判据无法计算）`);
  }
}

if (exportSets.debug && exportSets.game && exportSets.viewer) {
  const sorted = (set) => [...set].sort();
  const gameOnly = sorted(exportSets.game).filter((n) => !exportSets.debug.has(n));
  for (const n of gameOnly) fail(`wasm 导出面越界：game 有而 debug 没有 ${n}（game 必须是 debug 子集）`);
  const debugOnly = sorted(exportSets.debug).filter((n) => !exportSets.game.has(n));
  const allowedDebugOnly = [...ALLOWED_DEBUG_ONLY_EXPORTS].sort();
  if (JSON.stringify(debugOnly) !== JSON.stringify(allowedDebugOnly)) {
    const extra = debugOnly.filter((n) => !ALLOWED_DEBUG_ONLY_EXPORTS.includes(n));
    const missingAllowed = ALLOWED_DEBUG_ONLY_EXPORTS.filter((n) => !debugOnly.includes(n));
    if (extra.length) fail(`debug-only 导出出现未登记项：${extra.join(',')}（新增差异必须显式登记）`);
    if (missingAllowed.length) fail(`登记的 debug-only 导出已不存在：${missingAllowed.join(',')}（白名单过期）`);
  }
  const viewerOnly = sorted(exportSets.viewer).filter((n) => !exportSets.debug.has(n));
  if (JSON.stringify(viewerOnly) !== JSON.stringify([...ALLOWED_VIEWER_ONLY_EXPORTS].sort())) {
    fail(`viewer-only 导出与登记不符：实际 ${JSON.stringify(viewerOnly)}，登记 ${JSON.stringify(ALLOWED_VIEWER_ONLY_EXPORTS)}`);
  }
  // 物理导出面
  const phys = (app) => sorted(exportSets[app]).filter((n) => PHYS_EXPORT_RE.test(n));
  const physDebug = phys('debug');
  const physGame = phys('game');
  const physViewer = phys('viewer');
  if (physDebug.length === 0) fail('debug wasm 没有 physworld_* 导出（物理内核判据空转）');
  if (JSON.stringify(physDebug) !== JSON.stringify(physGame)) fail(`debug/game 物理导出面不一致：debug=${physDebug.length} game=${physGame.length}`);
  if (physViewer.length !== 0) fail(`viewer wasm 出现物理导出（${physViewer.slice(0, 5).join(',')}…）`);
  console.log(`[lock] 导出面：debug=${exportSets.debug.size} game=${exportSets.game.size} viewer=${exportSets.viewer.size}；` +
    `物理导出 debug=${physDebug.length} game=${physGame.length} viewer=${physViewer.length}；登记差异 debug-only=${ALLOWED_DEBUG_ONLY_EXPORTS.length} viewer-only=${ALLOWED_VIEWER_ONLY_EXPORTS.length}`);
}

for (const app of APPS) {
  const f = wasmFiles[app];
  if (!f) continue;
  const text = readFileSync(f, 'latin1');
  const missingKeys = WASM_STRING_CONTRACT.filter((k) => !text.includes(k));
  if (missingKeys.length) fail(`apps/${app}/pkg wasm 缺少字符串契约：${missingKeys.join(',')}`);
}
if (pkgPresent) console.log(`[lock] wasm 字符串契约：${WASM_STRING_CONTRACT.length} 个键 × ${pkgPresent} 端已检查`);

// ── 输出 ────────────────────────────────────────────────────────────────────
if (violations.length) {
  console.error(`[lock-consistency] 违规 ${violations.length} 处：`);
  for (const v of violations) console.error('  - ' + v);
  process.exit(1);
}
for (const s of skips) console.log(`[lock-consistency] SKIP：${s}`);
console.log(`[lock-consistency] OK：物理内核归属/共同包版本/导出面/字符串契约均符合登记白名单${skips.length ? '（含 SKIP 项）' : ''}。`);
