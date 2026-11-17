/**
 * 产物级共享指纹门禁（task-57 G2）。
 *
 * 背景：`src/renderer-shared` + `src/ts-shared` 是唯一实现源，但三端 app.js/worker.js 是各自
 * esbuild 产物（`git ls-files apps` 对生成物 0 命中）。本脚本解析 esbuild 产出的
 * `// <path>` 模块注释，从「真的进了 bundle 的模块」层面证明三端共用同一份共享层，
 * 并抓两类分叉：
 *   1) 共享模块在 debug/game app.js 中文本不再一致（esbuild 重名数字后缀归一化后比较）；
 *   2) 物理/权威模块被误打进 viewer（viewer 无物理是已定架构）。
 *
 * 判据（全部满足才 exit 0）：
 *   - 六个产物 app.js/worker.js 要么全缺（打印 SKIP，exit 0，CI 未构建场景），要么全在；
 *     部分缺失视为「产物存在但判据无法完整计算」⇒ FAIL；
 *   - 必需指纹矩阵（见 REQUIRED）：每端每产物必须含指定共享模块；
 *   - CORE_MODULES：三端 app.js 中归一化文本必须逐字节一致；
 *   - debug/game app.js 共同共享模块归一化一致（允许 NORM_DIFF_ALLOW 已知差异集）；
 *   - 单端独有共享模块必须正好等于 APP_ONLY_ALLOW（出现新独有模块 = 新分叉）；
 *   - viewer 产物不得含 FORBIDDEN_IN_VIEWER；
 *   - WORKER_PROTOCOL 字面量：bundle 内出现就必须等于源文件值，且至少一个 bundle 出现
 *     （防规则空转）。
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
const fail = (msg) => violations.push(msg);

/** esbuild 在 bundle 里为避免顶层重名会给标识符加数字后缀（px2/scene2/renderSession2）。 */
const normText = (lines) => lines.map((l) => l.replace(/([A-Za-z_$][\w$]*?)(\d+)\b/g, '$1')).join('\n');

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

// ── 2) 判据常量（现状由 .tmp/gates/probe2.mjs 取证，EVIDENCE 记录）──────────
const REQUIRED = {
  'debug/app': [
    'src/renderer-shared/scene/render-session.ts',
    'src/renderer-shared/environment/post-fx.ts',
    'src/renderer-shared/shader/water.ts',
    'src/ts-shared/entity/entity-system.ts',
    'src/ts-shared/gameplay/entity-gameplay.ts',
    'src/renderer-shared/scene/lasers.ts',
    'src/renderer-shared/scene/particles.ts',
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

/** 三端 app.js 必须逐字节（归一化后）一致的共享渲染/数据核心。 */
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

/** debug/game app.js 共同共享模块允许的已知文本差异（产物级：define/摇树，非实现分叉）。 */
const NORM_DIFF_ALLOW = new Set([
  'src/ts-shared/wasm/loader.ts',
  'src/renderer-shared/config/render-prefs.ts',
  'src/renderer-shared/camera/pose-entry.ts',
  'src/renderer-shared/environment/render-sky-pass.ts',
]);

/** 允许只出现在个别端 app.js 的共享模块（白名单，出现新的独有模块即分叉）。 */
const APP_ONLY_ALLOW = {
  'src/renderer-shared/environment/light-manager.ts': ['debug'],
  'src/ts-shared/input/input-layer.ts': ['debug', 'game'],
  'src/ts-shared/input/mouse-buffer.ts': ['debug', 'game'],
  'src/ts-shared/input/pointer-lock.ts': ['debug', 'game'],
  'src/ts-shared/phys/constants.ts': ['game'],
  'src/renderer-shared/scene/inject-stats.ts': ['game'],
};

/** viewer 不得包含的物理/权威实现（viewer 无物理是架构约定）。 */
const FORBIDDEN_IN_VIEWER = [
  'src/ts-shared/auth/worker-dispatch.ts',
  'src/ts-shared/gameplay/entity-gameplay.ts',
  'src/ts-shared/phys/world-builder.ts',
  'src/ts-shared/phys/authority-calibrator.ts',
  'src/renderer-shared/environment/light-manager.ts',
];

// ── 3) 必需指纹 ─────────────────────────────────────────────────────────────
for (const [k, modules] of Object.entries(REQUIRED)) {
  const a = art[k];
  if (!a) continue; // 缺失已在上方记 violation
  for (const m of modules) if (!a.mods.has(m)) fail(`${k}: 缺少共享模块 ${m}（该共享步骤没有进产物）`);
}

// ── 4) 三端 CORE 模块归一化一致 ─────────────────────────────────────────────
for (const m of CORE_MODULES) {
  const hashes = APPS.map((app) => {
    const a = art[`${app}/app`];
    return a && a.mods.has(m) ? sha(normText(a.mods.get(m))) : null;
  });
  const absent = APPS.filter((app, i) => hashes[i] === null);
  if (absent.length) {
    fail(`CORE 模块 ${m}: 未进入 ${absent.join(',')} 的 app.js（三端必须都包含）`);
    continue;
  }
  if (new Set(hashes).size !== 1) fail(`CORE 模块 ${m}: 三端 app.js 归一化文本不一致（${hashes.join(' / ')}）`);
}

// ── 5) debug/game 共享模块一致 + 单端独有白名单 ─────────────────────────────
const dApp = art['debug/app'];
const gApp = art['game/app'];
if (dApp && gApp) {
  const sharedPaths = (mods) => [...mods.keys()].filter((p) => /^src\/(renderer-shared|ts-shared)\//.test(p));
  const dSet = new Set(sharedPaths(dApp.mods));
  const gSet = new Set(sharedPaths(gApp.mods));
  for (const p of new Set([...dSet, ...gSet])) {
    const inD = dSet.has(p);
    const inG = gSet.has(p);
    if (inD && inG) {
      if (NORM_DIFF_ALLOW.has(p)) continue;
      const hd = sha(normText(dApp.mods.get(p)));
      const hg = sha(normText(gApp.mods.get(p)));
      if (hd !== hg) fail(`${p}: debug/game app.js 归一化文本不一致（${hd} / ${hg}）⇒ 共享层可能已分叉`);
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

// ── 6) viewer 不得含物理/权威实现 ───────────────────────────────────────────
for (const k of ['viewer/app', 'viewer/worker']) {
  const a = art[k];
  if (!a) continue;
  for (const m of FORBIDDEN_IN_VIEWER) if (a.mods.has(m)) fail(`${k}: 出现了物理/权威模块 ${m}（viewer 无物理是架构约定）`);
}

// ── 7) WORKER_PROTOCOL 字面量一致（G3 的产物侧断言）─────────────────────────
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
if (violations.length) {
  console.error(`[shared-artifacts] 违规 ${violations.length} 处：`);
  for (const v of violations) console.error('  - ' + v);
  process.exit(1);
}
const modsSummary = keys.map((k) => `${k}=${art[k].mods.size}`).join(' ');
console.log(`[shared-artifacts] OK：六产物共享指纹一致（${modsSummary}）；核心用例 ${CORE_MODULES.length} 个跨端逐字节相同；debug/game 差异仅 ${NORM_DIFF_ALLOW.size} 个已知产物级差异；viewer 无物理模块。`);
