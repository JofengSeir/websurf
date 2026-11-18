/**
 * 产物级共享指纹门禁（task-57 G2；task-84/B3 收紧）。
 *
 * 背景：`src/renderer-shared` + `src/ts-shared` 是唯一实现源，但三端 app.js/worker.js 是各自
 * esbuild 产物（`git ls-files apps` 对生成物 0 命中）。本脚本解析 esbuild 产出的
 * `// <path>` 模块注释，从「真的进了 bundle 的模块」层面证明三端共用同一份共享层，
 * 并抓两类分叉：
 *   1) 共享模块在 debug/game app.js 中文本不再一致（数字后缀归一化只允许白名单模块）；
 *   2) 物理/权威模块被误打进 viewer（viewer 无物理是已定架构）。
 *
 * 判据（全部满足才 exit 0）：
 *   - 六个产物 app.js/worker.js 要么全缺（打印 SKIP，exit 0，CI 未构建场景），要么全在；
 *     部分缺失视为「产物存在但判据无法完整计算」⇒ FAIL；
 *   - 必需指纹矩阵（见 REQUIRED）：每端每产物必须含指定共享模块；
 *   - CORE_MODULES：三端 app.js 文本必须一致；若只在 `NUMERIC_RENAME_ALLOW` 登记过的模块，
 *     才允许「仅数字后缀不同」归一化后一致（task-84/B3：不再全局归一化）；
 *   - debug/game app.js 共同共享模块同样按上面规则比对（`KNOWN_CONTENT_DIFF_ALLOW` 为
 *     已知内容差异的显式登记，仅作跳过并做「登记仍有效」反空转）；
 *   - 单端独有共享模块必须正好等于 APP_ONLY_ALLOW（出现新独有模块 = 新分叉）；
 *   - viewer 产物不得含 FORBIDDEN_IN_VIEWER；
 *   - WORKER_PROTOCOL 字面量：bundle 内出现就必须等于源文件值，且至少一个 bundle 出现
 *     （防规则空转）；
 *   - 同一模块在同一产物类型（app/worker）跨端行数差 >15% 打印 WARN；差异 >2× 且未在
 *     `LINE_COUNT_ALLOW` 登记 ⇒ FAIL（阈值理由见 .tmp/gates2/EVIDENCE.md：同一个模块在同类
 *     产物中行数应基本不变，>15% 已说明树摇/条件分支变化，>2× 基本等于不同实现）。
 *
 * 用法：`node src/scripts/check-shared-artifacts.mjs [--root <dir>]`（--root 供反向样本）。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ROOT = arg('--root', process.cwd());
const APPS = ['debug', 'game', 'viewer'];
const KINDS = ['app', 'worker'];
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

const violations = [];
const warnings = [];
const fail = (msg) => violations.push(msg);
const warn = (msg) => warnings.push(msg);

/**
 * esbuild 为避免顶层重名会给标识符加数字后缀（px2/scene2/renderSession2）。
 * task-84/B3：只在 `NUMERIC_RENAME_ALLOW` 登记的模块上启用该归一化，且只用于「文本已不同」
 * 的模块；未登记模块要求逐字节相同。
 */
const normNumeric = (lines) => lines.map((l) => l.replace(/([A-Za-z_$][\w$]*?)(\d+)\b/g, '$1')).join('\n');
const rawText = (lines) => lines.join('\n');

/** 从产物文本提取 `// <path>` 注释分隔的模块段。返回 Map<repo 相对路径, 行数组>。 */
function parseModules(file, app) {
  const lines = readFileSync(file, 'latin1').split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('// ')) continue;
    const p = l.slice(3).trim();
    if (!/[./]/.test(p) || p.length > 220) continue;
    if (/^[A-Za-z0-9_$-]+$/.test(p)) continue;
    if (!/\.(ts|js|mjs|cjs|json)$/.test(p) && !p.startsWith('pkg/')) continue;
    marks.push({ i, p });
  }
  const mods = new Map();
  for (let k = 0; k < marks.length; k++) {
    const start = marks[k].i;
    const end = k + 1 < marks.length ? marks[k + 1].i : lines.length;
    // 归一化路径：`../../` = 仓库相对；`src/...` = app 相对；node_modules 同理
    const raw = marks[k].p;
    let repoPath;
    if (raw.startsWith('../../')) repoPath = raw.slice(6);
    else if (raw.startsWith('../')) repoPath = raw.slice(3);
    else if (raw.startsWith('src/') || raw.startsWith('node_modules/')) repoPath = `apps/${app}/${raw}`;
    else repoPath = raw;
    mods.set(repoPath, lines.slice(start, end));
  }
  return mods;
}

// ── 1) 产物清单（全缺 SKIP；部分缺失 FAIL）──────────────────────────────────
const art = {};
for (const app of APPS) {
  for (const kind of KINDS) {
    const file = join(ROOT, 'apps', app, 'web', `${kind}.js`);
    if (existsSync(file)) {
      art[`${app}/${kind}`] = { file, size: statSync(file).size, mods: parseModules(file, app) };
    }
  }
}
const keys = Object.keys(art);
if (keys.length === 0) {
  console.log('[shared-artifacts] SKIP：apps/{debug,game,viewer}/web/{app,worker}.js 均不存在（未构建产物，CI 无产物场景）。');
  process.exit(0);
}
const EXPECTED_KEYS = APPS.flatMap((a) => KINDS.map((k) => `${a}/${k}`));
const missing = EXPECTED_KEYS.filter((k) => !art[k]);
if (missing.length) {
  fail(`产物部分缺失：${missing.join(', ')}（全缺才 SKIP；部分缺失时判据无法完整计算，必须 FAIL）`);
}
for (const k of keys) {
  if (art[k].mods.size === 0) fail(`${k}: 解析不到任何 esbuild 模块注释（产物格式变化或不是 esbuild 输出）`);
}

// ── 2) 判据常量（现状由 .tmp/gates2/probe.mjs 取证，EVIDENCE 记录）───────────
const REQUIRED = {
  'debug/app': [
    'src/renderer-shared/scene/render-session.ts',
    'src/renderer-shared/environment/post-fx.ts',
    'src/renderer-shared/shader/water.ts',
    'src/ts-shared/entity/entity-system.ts',
    'src/ts-shared/gameplay/entity-gameplay.ts',
    'src/renderer-shared/scene/lasers.ts',
    'src/renderer-shared/scene/particles.ts',
    'src/ts-shared/app/config-sync.ts',
  ],
  'debug/worker': ['src/ts-shared/auth/worker-dispatch.ts', 'src/ts-shared/auth/worker-protocol.ts'],
  'game/app': [
    'src/renderer-shared/scene/render-session.ts',
    'src/renderer-shared/environment/post-fx.ts',
    'src/renderer-shared/shader/water.ts',
    'src/ts-shared/entity/entity-system.ts',
    'src/ts-shared/gameplay/entity-gameplay.ts',
    'src/renderer-shared/scene/lasers.ts',
    'src/renderer-shared/scene/particles.ts',
    'src/ts-shared/app/config-sync.ts',
  ],
  'game/worker': ['src/ts-shared/auth/worker-dispatch.ts', 'src/ts-shared/auth/worker-protocol.ts'],
  'viewer/app': [
    'src/renderer-shared/scene/render-session.ts',
    'src/renderer-shared/environment/post-fx.ts',
    'src/renderer-shared/shader/water.ts',
    'src/ts-shared/entity/entity-system.ts',
    'src/renderer-shared/scene/lasers.ts',
    'src/renderer-shared/scene/particles.ts',
  ],
  'viewer/worker': ['src/renderer-shared/config/render-prefs.ts'],
};

/** 三端 app.js 必须一致的共享渲染/数据核心。 */
const CORE_MODULES = [
  'src/renderer-shared/scene/assemble-scene.ts',
  'src/renderer-shared/scene/visibility-controller.ts',
  'src/renderer-shared/scene/water-merge.ts',
  'src/renderer-shared/scene/lasers.ts',
  'src/renderer-shared/scene/particles.ts',
  'src/renderer-shared/scene/texture-quality.ts',
  'src/renderer-shared/shader/water.ts',
  'src/renderer-shared/environment/post-fx.ts',
  'src/renderer-shared/environment/scene-environment.ts',
  'src/renderer-shared/camera/near-plane.ts',
  'src/ts-shared/entity/entity-system.ts',
  'src/ts-shared/entity/host.ts',
  'src/ts-shared/entity/classes/triggers.ts',
  'src/ts-shared/materials/vmt-fallback.ts',
];

/**
 * 允许「仅数字后缀不同」的模块（精确到文件+模块）。
 * 来源：.tmp/gates2/probe.mjs 实测 esbuild 顶层重命名（同一源，三端命名冲突不同）。
 * 未登记模块必须逐字节相同；登记条目若已无差异 ⇒ FAIL（白名单过期，防长期漂移）。
 */
const NUMERIC_RENAME_ALLOW = new Set([
  // CORE 三端 app.js
  'src/renderer-shared/scene/assemble-scene.ts',
  'src/renderer-shared/scene/visibility-controller.ts',
  'src/renderer-shared/scene/lasers.ts',
  'src/renderer-shared/scene/particles.ts',
  'src/renderer-shared/shader/water.ts',
  'src/renderer-shared/environment/post-fx.ts',
  'src/renderer-shared/environment/scene-environment.ts',
  'src/renderer-shared/camera/near-plane.ts',
  'src/ts-shared/entity/entity-system.ts',
  'src/ts-shared/entity/classes/triggers.ts',
  // 仅 debug/game app.js 对比里出现数字重命名的模块
  'src/renderer-shared/render/create-renderer.ts',
  'src/renderer-shared/shader/bumpmap.ts',
  'src/renderer-shared/shader/world-transition.ts',
  'src/ts-shared/phys/map-cvars.ts',
]);

/**
 * debug/game app.js 共同共享模块允许的已知「非数字」内容差异（产物级：条件分支/摇树，
 * 非实现分叉）。登记时必须写清原因；条目若已无差异 ⇒ FAIL（白名单过期）。
 */
const KNOWN_CONTENT_DIFF_ALLOW = new Map([
  ['src/ts-shared/wasm/loader.ts', 'debug 走内嵌 wasm（__VBSP_WASM_B64__）分支，产物级条件差异'],
  ['src/renderer-shared/config/render-prefs.ts', 'debug 多 applyRenderDebugSwitches 调试开关（已登记差异）'],
  ['src/renderer-shared/camera/pose-entry.ts', 'debug 多 poseHold 注入点（回放/飞行相机）'],
  ['src/renderer-shared/environment/render-sky-pass.ts', 'debug 多调试层参数（产物级条件差异）'],
]);

/** 允许只出现在个别端 app.js 的共享模块（白名单，出现新的独有模块即分叉）。 */
const APP_ONLY_ALLOW = {
  'src/renderer-shared/environment/light-manager.ts': ['debug'],
  'src/ts-shared/input/input-layer.ts': ['debug', 'game'],
  'src/ts-shared/input/mouse-buffer.ts': ['debug', 'game'],
  'src/ts-shared/input/pointer-lock.ts': ['debug', 'game'],
  'src/ts-shared/phys/constants.ts': ['game'],
  'src/renderer-shared/scene/inject-stats.ts': ['game'],
  // 物理参数持久化（B2/D4）：目前只有 debug 物理面板接入；game 的物理参数随面板
  // 持久化走 apps/game/src/panel/panel-controller.ts 的 vbsp:panelPrefs，不引用本模块。
  // 若 game/viewer 将来接入同一存档格式，必须删除本登记（回到跨端一致性比对）。
  'src/ts-shared/phys/param-prefs.ts': ['debug'],
};

/** viewer 不得包含的物理/权威实现（viewer 无物理是架构约定）。 */
const FORBIDDEN_IN_VIEWER = [
  'src/ts-shared/auth/worker-dispatch.ts',
  'src/ts-shared/gameplay/entity-gameplay.ts',
  'src/ts-shared/phys/world-builder.ts',
  'src/ts-shared/phys/authority-calibrator.ts',
  'src/renderer-shared/environment/light-manager.ts',
];

/**
 * 同一模块同类型产物跨端行数差异登记（超过 15% 时白名单可抑制 WARN；>2× 未登记会 FAIL）。
 * maxRatio 用于让「已知且可解释」的差异保持静默。
 */
const LINE_COUNT_ALLOW = new Map([
  ['src/ts-shared/wasm/loader.ts', { maxRatio: 1.4, reason: 'debug 内嵌 wasm 分支只在 debug 产物展开' }],
  ['src/ts-shared/phys/param-defaults.ts', { maxRatio: 1.2, reason: 'debug worker 多物理调试默认值（doctor）' }],
]);
const LINE_WARN_RATIO = 1.15;
const LINE_FAIL_RATIO = 2.0;

// ── 3) 必需指纹 ─────────────────────────────────────────────────────────────
for (const [k, modules] of Object.entries(REQUIRED)) {
  const a = art[k];
  if (!a) continue; // 缺失已在上方记 violation
  for (const m of modules) if (!a.mods.has(m)) fail(`${k}: 缺少共享模块 ${m}（该共享步骤没有进产物）`);
}

// ── 4) 三端 CORE 模块一致（仅白名单模块允许数字后缀归一化）──────────────────
const numericUsed = new Set();
const numericStale = new Set(NUMERIC_RENAME_ALLOW);
for (const m of CORE_MODULES) {
  const parts = APPS.map((app) => {
    const a = art[`${app}/app`];
    return a && a.mods.has(m) ? a.mods.get(m) : null;
  });
  const absent = APPS.filter((app, i) => parts[i] === null);
  if (absent.length) {
    fail(`CORE 模块 ${m}: 未进入 ${absent.join(',')} 的 app.js（三端必须都包含）`);
    continue;
  }
  const raws = parts.map(rawText);
  if (new Set(raws).size === 1) continue; // 逐字节相同
  if (!NUMERIC_RENAME_ALLOW.has(m)) {
    fail(`CORE 模块 ${m}: 三端 app.js 文本不一致且未登记 NUMERIC_RENAME_ALLOW（${parts.map((p) => sha(rawText(p))).join(' / ')}）`);
    continue;
  }
  const norms = parts.map((p) => normNumeric(p));
  if (new Set(norms).size !== 1) {
    fail(`CORE 模块 ${m}: 已登记数字重命名但仍不一致（${norms.map(sha).join(' / ')}）⇒ 共享层可能已分叉`);
  } else {
    numericUsed.add(m);
    numericStale.delete(m);
  }
}

// ── 5) debug/game 共享模块一致 + 单端独有白名单 ─────────────────────────────
const dApp = art['debug/app'];
const gApp = art['game/app'];
const contentDiffStale = new Set(KNOWN_CONTENT_DIFF_ALLOW.keys());
if (dApp && gApp) {
  const sharedPaths = (mods) => [...mods.keys()].filter((p) => /^src\/(renderer-shared|ts-shared)\//.test(p));
  const dSet = new Set(sharedPaths(dApp.mods));
  const gSet = new Set(sharedPaths(gApp.mods));
  for (const p of new Set([...dSet, ...gSet])) {
    const inD = dSet.has(p);
    const inG = gSet.has(p);
    if (inD && inG) {
      const raws = [rawText(dApp.mods.get(p)), rawText(gApp.mods.get(p))];
      if (raws[0] === raws[1]) continue;
      if (KNOWN_CONTENT_DIFF_ALLOW.has(p)) {
        contentDiffStale.delete(p);
        continue;
      }
      if (NUMERIC_RENAME_ALLOW.has(p)) {
        const norms = [normNumeric(dApp.mods.get(p)), normNumeric(gApp.mods.get(p))];
        if (norms[0] !== norms[1]) {
          fail(`${p}: debug/game app.js 已登记数字重命名但仍不一致（${sha(norms[0])} / ${sha(norms[1])}）⇒ 共享层可能已分叉`);
        } else {
          numericUsed.add(p);
          numericStale.delete(p);
        }
        continue;
      }
      fail(`${p}: debug/game app.js 文本不一致且未登记数字重命名/已知差异白名单（${sha(raws[0])} / ${sha(raws[1])}）`);
    } else {
      const only = inD ? 'debug' : 'game';
      const allowed = APP_ONLY_ALLOW[p];
      if (!allowed || !allowed.includes(only)) fail(`${p}: 只进入了 ${only} app.js（单端独有共享模块未登记白名单）`);
    }
  }
  // 白名单里的模块必须仍然只出现在登记的那端（防白名单过期后静默放过反向分叉）
  for (const [p, apps] of Object.entries(APP_ONLY_ALLOW)) {
    const actual = [dSet.has(p) ? 'debug' : null, gSet.has(p) ? 'game' : null].filter(Boolean);
    if (actual.join(',') !== apps.join(',')) fail(`${p}: 单端出现情况与白名单不符（白名单 ${apps.join(',')}，实际 ${actual.join(',') || '无'}）`);
  }
}

// ── 6) 白名单反空转：登记了但已无差异 = 过期登记，必须删 ────────────────────
for (const m of numericStale) fail(`NUMERIC_RENAME_ALLOW 条目已无差异：${m}（登记过期，请删除以免长期掩盖新分叉）`);
for (const m of contentDiffStale) fail(`KNOWN_CONTENT_DIFF_ALLOW 条目已无差异：${m}（登记过期，请删除）`);

// ── 7) 同一模块同类型产物跨端行数差（WARN；>2× 且未登记 ⇒ FAIL）─────────────
const lineCount = {}; // key: "app|src/..." -> { debug: n, game: n, viewer: n }
for (const app of APPS) {
  for (const kind of KINDS) {
    const a = art[`${app}/${kind}`];
    if (!a) continue;
    for (const [p, lines] of a.mods) {
      if (!/^src\/(renderer-shared|ts-shared)\//.test(p)) continue;
      const k = `${kind}|${p}`;
      if (!lineCount[k]) lineCount[k] = {};
      lineCount[k][app] = lines.length;
    }
  }
}
for (const [k, byApp] of Object.entries(lineCount)) {
  const ends = Object.entries(byApp);
  if (ends.length < 2) continue;
  const [kind, p] = k.split('|');
  const nums = ends.map(([, n]) => n);
  const ratio = Math.max(...nums) / Math.min(...nums);
  const allow = LINE_COUNT_ALLOW.get(p);
  const detail = ends.map(([a, n]) => `${a}:${n}`).join(' ');
  if (allow && ratio <= allow.maxRatio) continue;
  if (ratio > LINE_FAIL_RATIO) {
    fail(`${kind} 产物 ${p} 跨端行数比 ${ratio.toFixed(2)}× > ${LINE_FAIL_RATIO}×（${detail}）⇒ 疑似实现分叉；确认无问题请登记 LINE_COUNT_ALLOW`);
  } else if (ratio > LINE_WARN_RATIO) {
    warn(`${kind} 产物 ${p} 跨端行数比 ${ratio.toFixed(2)}×（${detail}）`);
  }
}

// ── 8) viewer 不得含物理/权威实现 ───────────────────────────────────────────
for (const k of ['viewer/app', 'viewer/worker']) {
  const a = art[k];
  if (!a) continue;
  for (const m of FORBIDDEN_IN_VIEWER) if (a.mods.has(m)) fail(`${k}: 出现了物理/权威模块 ${m}（viewer 无物理是架构约定）`);
}

// ── 9) WORKER_PROTOCOL 字面量一致（G3 的产物侧断言）─────────────────────────
const proto = join(ROOT, 'src', 'ts-shared', 'auth', 'worker-protocol.ts');
if (!existsSync(proto)) {
  fail('src/ts-shared/auth/worker-protocol.ts 不存在（协议指纹规则无法计算）');
} else {
  const srcVal = /WORKER_PROTOCOL\s*=\s*(\d+)/.exec(readFileSync(proto, 'utf8'))?.[1];
  if (!srcVal) {
    fail('src/ts-shared/auth/worker-protocol.ts 中找不到 WORKER_PROTOCOL = <number> 字面量（判据无法计算）');
  } else {
    let tokenArtifacts = 0;
    for (const k of keys) {
      const text = readFileSync(art[k].file, 'latin1');
      if (!text.includes('WORKER_PROTOCOL')) continue;
      tokenArtifacts++;
      const vals = [...text.matchAll(/WORKER_PROTOCOL\s*=\s*(\d+)/g)].map((m) => m[1]);
      if (vals.length === 0) fail(`${k}: 含 WORKER_PROTOCOL 但没有可解析的字面量赋值（判据无法计算）`);
      for (const v of vals) if (v !== srcVal) fail(`${k}: WORKER_PROTOCOL 字面量=${v}，源文件=${srcVal}（stale worker 风险）`);
    }
    if (tokenArtifacts === 0) fail('没有任何产物含 WORKER_PROTOCOL（协议断言退化为空转）');
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────
if (warnings.length) {
  console.error(`[shared-artifacts] WARN ${warnings.length} 处（不阻断）：`);
  for (const w of warnings) console.error('  - ' + w);
}
if (violations.length) {
  console.error(`[shared-artifacts] 违规 ${violations.length} 处：`);
  for (const v of violations) console.error('  - ' + v);
  process.exit(1);
}
const modsSummary = keys.map((k) => `${k}=${art[k].mods.size}`).join(' ');
console.log(`[shared-artifacts] OK：六产物共享指纹一致（${modsSummary}）；核心用例 ${CORE_MODULES.length} 个跨端一致` +
  `（其中 ${numericUsed.size} 个仅数字后缀差异已在白名单登记）；debug/game 已知内容差异 ${KNOWN_CONTENT_DIFF_ALLOW.size} 个；` +
  `行数差 WARN ${warnings.length} 处；viewer 无物理模块。`);
