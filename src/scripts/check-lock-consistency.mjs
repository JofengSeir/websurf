/**
 * 依赖/导出面一致性门禁（task-57 G4）。
 *
 * 背景：三端各自独立 Cargo workspace（物理内核 `websurf-phys` 在共享 `src/`，viewer 只依赖
 * `websurf-wasm-core`）；wasm 导出面因 feature 差异天然不同（debug 94 / game 80 / viewer 27）。
 * 没有机械门禁时，这些差异会静默漂移。本脚本把「允许的差异」写成显式白名单：
 *   - 物理内核：debug/game 的 crates/wasm/Cargo.toml 必须把 `../../../../src` 接进依赖图——
 *     直接 path 依赖 `websurf-phys`，或经共享 `src/wasm-bindings` crate 的 `phys` feature 间接依赖
 *     （两条路都必须落回同一路径；P4 切片后 game 走后者）；
 *     viewer 必须不含 websurf-phys 且不得启用 bindings 的 phys feature；Cargo.lock 中 websurf-phys
 *     只出现在 debug/game；
 *   - 共同包版本：debug↔game 的共同包版本必须一致，只允许已登记的小版本差（3 个）；
 *   - 共享核心 crate：wasm-bindgen/serde/serde_json/js-sys 三端版本一致；
 *   - wasm 导出面：期望集由 `src/wasm-bindings` 源码 + 三端 `crates/wasm/Cargo.toml` 的
 *     bindings features **推导**（P4 revision 3：不再手写导出名白名单）：
 *       ① 每端 derived ⊆ actual（golden 逐名，源码声明了但 pkg 没有 = FAIL）；
 *       ② game ⊆ debug（game 独有必须为空）；
 *       ③ debug-only / viewer-only 必须正好等于「推导差集 + 依赖图产物登记（DEP_GRAPH_EXPORTS）」，
 *          多余或缺失都 FAIL，不允许把新导出塞进白名单蒙混；
 *       ④ 物理导出（physworld_* 与 PhysWorld）debug/game 一致、viewer 为 0；
 *       ⑤ `.wasm` 体积预算：迁移前基线 ×1.05，超限 FAIL（防止 feature 泄漏把工具链塞进产品端）；
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

// Cargo.toml 路径依赖（比 lock 更直接：确认物理内核确实接进依赖图）
// 两条合法路径：① app crate 直接 path 依赖 `../../../../src`；② 经共享
// `src/wasm-bindings` 的 `phys` feature 间接依赖。两者都必须落回同一路径，且②还要求
// bindings crate 自身把 `websurf-phys`（path=".."）接在 phys feature 上，避免断链。
const BINDINGS_TOML = join(ROOT, 'src', 'wasm-bindings', 'Cargo.toml');
const bindingsTomlText = existsSync(BINDINGS_TOML) ? readFileSync(BINDINGS_TOML, 'utf8') : '';
const bindingsPhysDep = new RegExp(`${PHYS_PATH_DEP}\\s*=\\s*\\{[^}]*path\\s*=\\s*"\\.\\."`).test(bindingsTomlText);
const bindingsPhysFeature = /^\s*phys\s*=\s*\[[^\]]*dep:websurf-phys/m.test(bindingsTomlText);
for (const app of ['debug', 'game']) {
  const p = join(ROOT, 'apps', app, 'crates', 'wasm', 'Cargo.toml');
  if (!existsSync(p)) { fail(`apps/${app}/crates/wasm/Cargo.toml 不存在`); continue; }
  const text = readFileSync(p, 'utf8');
  const direct = new RegExp(`${PHYS_PATH_DEP}\\s*=\\s*\\{[^}]*path\\s*=\\s*"\\.\\./\\.\\./\\.\\./\\.\\./src"`).test(text);
  const viaBindings = /websurf-wasm-bindings\s*=\s*\{[^}]*path\s*=\s*"\.\.\/\.\.\/\.\.\/\.\.\/src\/wasm-bindings"[^}]*features\s*=\s*\[[^\]]*"phys"/s.test(text);
  if (!direct && !viaBindings) {
    fail(`apps/${app}/crates/wasm/Cargo.toml 既未 path 依赖 ../../../../src（${PHYS_PATH_DEP}），也未经 ../../../../src/wasm-bindings 的 phys feature 接入物理内核`);
  }
  if (viaBindings && !(bindingsPhysDep && bindingsPhysFeature)) {
    fail(`src/wasm-bindings/Cargo.toml 未把 ${PHYS_PATH_DEP}（path=".."）接到 phys feature；apps/${app} 的间接依赖断链`);
  }
}
const viewerToml = join(ROOT, 'apps', 'viewer', 'crates', 'wasm', 'Cargo.toml');
if (existsSync(viewerToml)) {
  // TOML 注释里可能声明「不含 websurf-phys」（设计说明），必须剥注释后判依赖行。
  const tomlCode = readFileSync(viewerToml, 'utf8').replace(/#[^\n]*/g, '');
  if (new RegExp(`^\\s*${PHYS_PATH_DEP}\\s*=`, 'm').test(tomlCode)) {
    fail('apps/viewer/crates/wasm/Cargo.toml 依赖 websurf-phys（viewer 无物理是架构约定）');
  }
  if (/websurf-wasm-bindings\s*=\s*\{[^}]*features\s*=\s*\[[^\]]*"phys"/s.test(tomlCode)) {
    fail('apps/viewer/crates/wasm/Cargo.toml 启用了 bindings 的 phys feature（viewer 无物理是架构约定）');
  }
}

// ── 2) pkg 导出面 + wasm 字符串契约 ─────────────────────────────────────────
// 期望导出面从 bindings 源码按 feature 推导（不手写导出名白名单）：
//   feature → 源文件（feature 启用时 wasm-bindgen 会导出其中的标注项）
//   feature 闭包与 src/wasm-bindings/Cargo.toml 保持一致（glb-lite→glb→core 等）
//   解析规则：`#[wasm_bindgen] impl BspProcessor { pub fn foo }` → bspprocessor_<js_name|foo>；
//            `#[wasm_bindgen(js_name = X)] pub fn bar` → X；其余 `#[wasm_bindgen] pub fn f` → f。
const BINDINGS_SRC = join(ROOT, 'src', 'wasm-bindings', 'src');
const FEATURE_MODULES = {
  core: ['bsp/common.rs', 'texture.rs'],
  glb: ['bsp/glb.rs'],
  'glb-lite': ['bsp/glb_lite.rs'],
  'debug-tools': ['bsp/debug_tools.rs'],
  'viewer-export': ['bsp/viewer_export.rs'],
};
const FEATURE_CLOSURE = {
  core: [],
  phys: ['core'],
  glb: ['core'],
  'glb-lite': ['glb'],
  'debug-tools': ['core', 'phys'],
  'viewer-export': ['core'],
};
/** 依赖图（非 bindings 源码）带进 wasm 的导出，必须单列登记并附来源说明。
 *  ChromaSampling = v_frame（rav1e 依赖链）在 wasm32 上的 `#[wasm_bindgen]` 枚举；
 *  2026-11-18 实测只有 debug 的依赖图保留它（game/viewer 无），prod 端不应新增此类项。 */
const DEP_GRAPH_EXPORTS = { debug: ['ChromaSampling'], game: [], viewer: [] };
/** 迁移前 .wasm 体积基线（P4 slice1 后 / slice2 前，字节）与容忍度（预算 = 基线 ×1.05）。 */
const WASM_SIZE_BUDGET = { debug: 4211056, game: 4045966, viewer: 3660334 };
const WASM_SIZE_TOLERANCE = 1.05;
/** wasm-bindgen 生成的固定脚手架导出（三端等价，随 --target web 总会产出）。 */
const WASM_SCAFFOLD = ['BspProcessor', 'InitInput', 'InitOutput', 'SyncInitInput', 'initSync'];

/** 读取三端 crates/wasm/Cargo.toml 里 websurf-wasm-bindings 的 features 列表。 */
function parseBindingsFeatures(app) {
  const p = join(ROOT, 'apps', app, 'crates', 'wasm', 'Cargo.toml');
  if (!existsSync(p)) { fail(`apps/${app}/crates/wasm/Cargo.toml 不存在（features 推导无法计算）`); return []; }
  const code = readFileSync(p, 'utf8').replace(/#[^\n]*/g, '');
  const dep = /websurf-wasm-bindings\s*=\s*\{([^}]*)\}/s.exec(code);
  if (!dep) { fail(`apps/${app}/crates/wasm/Cargo.toml 未依赖 websurf-wasm-bindings（导出面判据无法计算）`); return []; }
  const got = /features\s*=\s*\[([^\]]*)\]/.exec(dep[1]);
  return got ? [...got[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
}

/** feature 名闭包展开（不认识的 feature 名 = 拼写漂移，直接 FAIL）。 */
function expandFeatures(names, app) {
  const out = new Set();
  const visit = (n) => {
    if (out.has(n)) return;
    if (!(n in FEATURE_CLOSURE)) { fail(`apps/${app} 引用了未登记 feature "${n}"（先更新 FEATURE_CLOSURE）`); return; }
    out.add(n);
    for (const d of FEATURE_CLOSURE[n]) visit(d);
  };
  for (const n of names) visit(n);
  return out;
}

/** 掩码 Rust 注释/字符串/字符字面量（保留换行与标识符），供括号匹配使用。 */
function maskRust(text) {
  const out = text.split('');
  const blank = (from, to) => { for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') { const j = text.indexOf('\n', i); const stop = j < 0 ? text.length : j; blank(i, stop); i = stop; continue; }
    if (c === '/' && d === '*') { const j = text.indexOf('*/', i + 2); const stop = j < 0 ? text.length : j + 2; blank(i, stop); i = stop; continue; }
    if (c === 'r' && (d === '"') && !/[\w]/.test(text[i - 1] ?? '')) {
      // 原始字符串 r"..." / r#"..."#（至多两个 #）
      const m = /^r(#*)"/.exec(text.slice(i, i + 5));
      if (m) { const hashes = m[1]; const close = '"' + hashes; const j = text.indexOf(close, i + m[0].length); const stop = j < 0 ? text.length : j + close.length; blank(i, stop); i = stop; continue; }
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length) { if (text[j] === '\\') { j += 2; continue; } if (text[j] === '"') { j++; break; } j++; }
      blank(i, j); i = j; continue;
    }
    if (c === "'") {
      const life = /^'[A-Za-z_][\w]*/.exec(text.slice(i));
      if (life) { i += life[0].length; continue; } // 生命周期/标签，保留
      let j = i + 1;
      while (j < text.length) { if (text[j] === '\\') { j += 2; continue; } if (text[j] === "'") { j++; break; } j++; }
      blank(i, j); i = j; continue;
    }
    i++;
  }
  return out.join('');
}

function matchBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 从 bindings 源码推导某 feature 集应导出的 wasm 名（不含脚手架与 physworld_*）。 */
function deriveExports(features, app) {
  const names = new Set();
  const files = new Set();
  for (const f of features) for (const rel of FEATURE_MODULES[f] ?? []) files.add(rel);
  for (const rel of files) {
    const p = join(BINDINGS_SRC, rel);
    if (!existsSync(p)) { fail(`bindings 源文件缺失：src/wasm-bindings/src/${rel}（${app} 导出面推导失败）`); continue; }
    const masked = maskRust(readFileSync(p, 'utf8'));
    // 顶层自由函数：属性行在 0 列，函数在 0 列（impl 内方法缩进，不匹配）
    const freeRe = /^#\[wasm_bindgen(?:\(([^)]*)\))?\]\s*$\n(?:^#\[[^\n]*\]\s*$\n)*^pub\s+(?:unsafe\s+)?fn\s+(\w+)/gm;
    for (const m of masked.matchAll(freeRe)) {
      const args = m[1] ?? '';
      const jsName = /js_name\s*=\s*(\w+)/.exec(args);
      names.add(jsName ? jsName[1] : m[2]);
    }
    // 导出方法：`#[wasm_bindgen(...)]` + `impl BspProcessor {` 块内的 pub fn
    const implRe = /^#\[wasm_bindgen(?:\(([^)]*)\))?\]\s*$\n(?:^#\[[^\n]*\]\s*$\n)*^impl\s+BspProcessor\s*\{/gm;
    for (const m of masked.matchAll(implRe)) {
      const open = masked.indexOf('{', m.index + m[0].length - 1);
      const close = matchBrace(masked, open);
      if (open < 0 || close < 0) { fail(`${rel} 的 impl BspProcessor 块括号不匹配（导出面推导失败）`); continue; }
      const block = masked.slice(open, close + 1);
      for (const fm of block.matchAll(/\bpub\s+fn\s+(\w+)/g)) {
        const before = masked.slice(Math.max(0, open + fm.index - 400), open + fm.index);
        const attr = /#\[wasm_bindgen\(([^)]*)\)\]\s*(?:\n\s*)*$/.exec(before);
        const args = attr ? attr[1] : '';
        const jsName = /js_name\s*=\s*(\w+)/.exec(args);
        names.add('bspprocessor_' + (jsName ? jsName[1] : fm[1]));
      }
    }
  }
  for (const n of WASM_SCAFFOLD) names.add(n);
  if (features.has('phys')) names.add('PhysWorld');
  return names;
}
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

if (pkgPresent > 0 && exportSets.debug && exportSets.game && exportSets.viewer) {
  const sorted = (set) => [...set].sort();
  const derived = {};
  for (const app of APPS) derived[app] = deriveExports(expandFeatures(parseBindingsFeatures(app), app), app);

  // ① golden 逐名：源码声明了就必须出现在 pkg（缺一即 FAIL）
  for (const app of APPS) {
    const missing = sorted(derived[app]).filter((n) => !exportSets[app].has(n));
    for (const n of missing) fail(`${app}: bindings 源码/features 推导出 ${n}，但 pkg 导出面没有（golden 逐名不符）`);
  }

  // ② game ⊆ debug
  const gameOnly = sorted(exportSets.game).filter((n) => !exportSets.debug.has(n));
  for (const n of gameOnly) fail(`wasm 导出面越界：game 有而 debug 没有 ${n}（game 必须是 debug 子集）`);

  // ③ debug-only = 推导差集 + 依赖图产物登记
  const debugOnly = sorted(exportSets.debug).filter((n) => !exportSets.game.has(n));
  const expectDebugOnly = sorted(
    [...derived.debug].filter((n) => !derived.game.has(n)).concat(DEP_GRAPH_EXPORTS.debug),
  );
  if (JSON.stringify(debugOnly) !== JSON.stringify(expectDebugOnly)) {
    const extra = debugOnly.filter((n) => !expectDebugOnly.includes(n));
    const missing = expectDebugOnly.filter((n) => !debugOnly.includes(n));
    if (extra.length) fail(`debug-only 出现 features 推导外的导出：${extra.join(',')}（新差异必须先落到 bindings feature/源码，或登记 DEP_GRAPH_EXPORTS）`);
    if (missing.length) fail(`features 推导的 debug-only 导出在 pkg 中缺失：${missing.join(',')}`);
  }

  // ④ viewer-only = 推导差集 + 依赖图产物登记
  const viewerOnly = sorted(exportSets.viewer).filter((n) => !exportSets.debug.has(n));
  const expectViewerOnly = sorted(
    [...derived.viewer].filter((n) => !derived.debug.has(n)).concat(DEP_GRAPH_EXPORTS.viewer),
  );
  if (JSON.stringify(viewerOnly) !== JSON.stringify(expectViewerOnly)) {
    fail(`viewer-only 导出与 features 推导不符：实际 ${JSON.stringify(viewerOnly)}，期望 ${JSON.stringify(expectViewerOnly)}`);
  }

  // ⑤ 物理导出面（physworld_* / PhysWorld；未被 bindings 源码推导覆盖，单独判据）
  const phys = (app) => sorted(exportSets[app]).filter((n) => PHYS_EXPORT_RE.test(n));
  const physDebug = phys('debug');
  const physGame = phys('game');
  const physViewer = phys('viewer');
  if (physDebug.length === 0) fail('debug wasm 没有 physworld_* 导出（物理内核判据空转）');
  if (JSON.stringify(physDebug) !== JSON.stringify(physGame)) fail(`debug/game 物理导出面不一致：debug=${physDebug.length} game=${physGame.length}`);
  if (physViewer.length !== 0) fail(`viewer wasm 出现物理导出（${physViewer.slice(0, 5).join(',')}…）`);

  // ⑥ .wasm 体积预算（迁移前基线 ×1.05）
  for (const app of APPS) {
    const f = wasmFiles[app];
    if (!f) continue;
    const size = statSync(f).size;
    const budget = Math.round(WASM_SIZE_BUDGET[app] * WASM_SIZE_TOLERANCE);
    if (size > budget) fail(`apps/${app} .wasm 体积 ${size} B 超出预算 ${budget} B（基线 ${WASM_SIZE_BUDGET[app]} ×${WASM_SIZE_TOLERANCE}；检查 feature 是否泄漏）`);
    console.log(`[lock] ${app} .wasm = ${size} B（预算 ${budget} B / 基线 ${WASM_SIZE_BUDGET[app]} B）`);
  }

  console.log(`[lock] 导出面（features 推导）：debug=${derived.debug.size} game=${derived.game.size} viewer=${derived.viewer.size} 项；` +
    `实际 debug=${exportSets.debug.size} game=${exportSets.game.size} viewer=${exportSets.viewer.size}；` +
    `物理导出 debug=${physDebug.length} game=${physGame.length} viewer=${physViewer.length}；` +
    `debug-only=${debugOnly.length}（推导 ${expectDebugOnly.length}）viewer-only=${viewerOnly.length}（推导 ${expectViewerOnly.length}）`);
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
console.log(`[lock-consistency] OK：物理内核归属/共同包版本/导出面（bindings features 推导）/字符串契约/体积预算均符合登记。${skips.length ? `（含 SKIP 项：${skips.join(';')}）` : ''}`);
