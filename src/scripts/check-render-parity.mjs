/**
 * 渲染/物理归属静态门禁：三端的「共享步骤」必须只在共享层存在（task-57 起分两层判据）。
 *
 * 背景（2026-10-23）：`assembleScene` 只统一了 GLB→终扫的 7 步；load/环境/天空/相机/可见性/
 * 画质/每帧 draw 仍是三份。事故：回退 VMT 表只装在 viewer 的 `core/bsp.ts`，debug/game 没装
 * ⇒ debug 水层 alpha=0 不绘制。本脚本把「哪些调用只许出现在共享层」写成可执行判据。
 *
 * 2026-11-18（task-57 补强，依据 .tmp/audit/REVIEW_VERDICT.md G1）：
 *   - 渲染禁词补 `renderer.render(` / `scene.fog =` / `scene.background =`（apps 内除白名单）；
 *   - 新增物理/权威 API 禁词：apps/<app>/src 不得直接调用物理副作用 API（`add_velocity(`、
 *     `set_push_velocity(`、`set_jump_height(` 等），只能由共享 `EntityGameplay`/`worker-dispatch` 下发；
 *   - 装配点白名单：`new PhysWorld(` 只许出现在 debug/game 的 worker/main.ts 与 renderer-main.ts，
 *     `createMainSharedState(` 只许 debug/game 的 app.ts，`attachEntitySystem(` 只许 viewer 的 app.ts；
 *     白名单文件必须存在且真的命中（防「门禁空转」）；
 *   - import 别名检测：`import { PhysWorld as PW }` 这类 `as` 重命名在非白名单文件里直接违规
 *     （字符串兜底抓不到别名，故先解析 import 绑定名）；
 *   - 共享层反空转：`entity-gameplay.ts` 必须真的含物理 API 调用、`worker-dispatch.ts` 必须含
 *     `add-velocity`/`set-push-velocity` 消息名（否则禁词规则变成空转）。
 *
 * 判据：
 *   1. `apps/<app>/src` 下的 TS 不得出现下列共享步骤的调用/构造（注释不算）；
 *   2. 三端渲染入口必须引用 `RenderSession`（viewer `core/scene.ts`、game/debug `renderer-main.ts`）；
 *   3. 共享 `render-session.ts` 必须真的包含装配/天空/可见性三件事（防它被掏空后仍过关）。
 *
 * 用法：`node src/scripts/check-render-parity.mjs [--root <dir>]`（仓库根运行）。违规时 exit 1。
 * `--root` 只给反向对照样本用：指向别的目录时按同一规则扫描该目录，不修改真实仓库。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ROOT = arg('--root', process.cwd());
const APPS = ['apps/debug', 'apps/game', 'apps/viewer'];

/** 只许出现在共享层 / 只许由共享会话调用的渲染步骤。 */
const FORBIDDEN = [
  ['new THREE.WebGLRenderer', '渲染器构造'],
  ['createRenderer(', '渲染器构造'],
  ['precompileScene(', '着色器预编译'],
  ['installRenderProbe(', '只读渲染探针'],
  ['assembleScene(', 'GLB 装配核'],
  ['mergeIntoChunks(', '分块合并'],
  ['mergeIntoNewRoot(', '分块合并'],
  ['optimizeScene(', '分块合并'],
  ['renderSkyPass(', '天空/主世界每帧绘制'],
  ['createSkyCamera(', '天空相机'],
  ['setSceneEnvironment(', '环境登记'],
  ['setSceneBackgroundColor(', '背景登记'],
  ['clearSceneEnvironment(', '环境清理'],
  ['applySceneCamera(', '相机 near/far/fov'],
  ['shrinkNearPlane(', '近平面贴墙'],
  ['new VisibilityController', '可见性判定'],
  ['new NearPlaneController', '近平面控制器'],
  ['new PvsManager', 'PVS 装载'],
  ['applySceneTextureQuality(', '贴图画质切换'],
  ['buildMapScene(', 'GLB → 场景'],
  ['applyLightmap(', 'lightmap 施加'],
  ['fullbrightUnlitLitMaterials(', '装配后终扫'],
  ['applyWorldTransitionShaders(', '世界过渡注入'],
  ['applyBumpShaders(', '法线注入'],
  ['applyWaterShaders(', '水面注入'],
  ['disposeObject(', '渲染资源释放'],
  // task-57 新增：主循环渲染/环境登记 —— 必须由 RenderSession 内部完成
  ['renderer.render(', '主循环渲染'],
  ['scene.fog =', '雾参数登记'],
  ['scene.fog=', '雾参数登记'],
  ['scene.background =', '背景登记'],
  ['scene.background=', '背景登记'],
];

/** 只许由共享层 `EntityGameplay` / `worker-dispatch` 下发的物理副作用 API。 */
const FORBIDDEN_PHYS = [
  ['add_velocity(', '物理冲量（add 语义）'],
  ['set_push_velocity(', '推力板速度（set 语义）'],
  ['set_jump_height(', '跳高改写'],
  ['set_max_horizontal_speed(', '水平限速'],
  ['set_teleport_player_name(', '传送玩家名'],
  ['set_teleport_filter_enabled(', '传送过滤门控'],
  ['set_player_base_velocity(', '基础速度（AddOutput basevelocity）'],
];

/**
 * 装配点白名单（必须且只允许出现在这些文件；每个文件必须真的命中，防判据空转）。
 * 注意：新增装配文件时要显式登记——这是刻意的：装配点属于架构面，不该悄悄增长。
 */
const ASSEMBLY = [
  {
    needle: 'new PhysWorld(',
    what: '物理世界实例化',
    files: [
      'apps/debug/src/worker/main.ts',
      'apps/debug/src/renderer/renderer-main.ts',
      'apps/game/src/worker/main.ts',
      'apps/game/src/renderer/renderer-main.ts',
    ],
  },
  {
    needle: 'createMainSharedState(',
    what: '主线程共享状态（权威桥）',
    files: ['apps/debug/src/app.ts', 'apps/game/src/app.ts'],
  },
  {
    needle: 'attachEntitySystem(',
    what: '实体系统挂载',
    files: ['apps/viewer/src/app.ts'],
  },
];

/** 别名绕过的敏感符号：出现在 import { X as Y } 里且文件不在对应装配白名单 ⇒ 违规。 */
const ALIAS_SENSITIVE = new Set([
  'PhysWorld',
  'createMainSharedState',
  'attachEntitySystem',
  'addPlayerVelocity',
  'setPlayerBaseVelocity',
  'setPushVelocity',
  'setJumpHeight',
  'setMaxHorizontalSpeed',
  'setTeleportPlayerName',
  'setTeleportFilterEnabled',
]);
const ALIAS_ALLOWED_FILES = new Set(ASSEMBLY.flatMap((a) => a.files));

/** 三端渲染入口（必须引用共享 RenderSession）。 */
const ENTRY_FILES = [
  'apps/viewer/src/core/scene.ts',
  'apps/game/src/renderer/renderer-main.ts',
  'apps/debug/src/renderer/renderer-main.ts',
];

/**
 * 允许自带 `WebGLRenderer` 的**独立预览页**（不属于三端渲染入口）。
 *
 * `apps/debug/src/preview-particles.ts` 是 PCF 粒子的空白场景预览：它只实例化
 * `ParticleSystems`，不装配地图、不加载 GLB，用途是脱离世界光照单独迭代粒子观感。
 * 因此它不需要也不应该走 `RenderSession`；列为显式例外，避免门禁误报。
 */
const ALLOWED_FILES = new Set(['apps/debug/src/preview-particles.ts']);

const SHARED_SESSION = 'src/renderer-shared/scene/render-session.ts';

/** 共享层反空转：这些文件必须真的含对应 API/消息名，否则上方的 apps 禁词判据就是空转。 */
const SHARED_GUARDS = [
  {
    file: 'src/ts-shared/gameplay/entity-gameplay.ts',
    needles: ['add_velocity', 'set_push_velocity', 'set_jump_height', 'set_max_horizontal_speed'],
    what: '实体→物理副作用下发',
  },
  {
    file: 'src/ts-shared/auth/worker-dispatch.ts',
    needles: ['add-velocity', 'set-push-velocity'],
    what: '权威 worker 消息分发',
  },
];

/** 保留行号的注释剥离（块注释里的换行保留，行号不漂）。 */
function stripComments(text) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/(^|[^:])\/\/[^\n]*/gm, (m, prefix) => prefix + ' '.repeat(m.length - prefix.length));
  return out;
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

/** 收集 apps 下各端 src 的所有 TS 文件（已剥注释、保留行号）。 */
const files = [];
for (const app of APPS) {
  const src = join(ROOT, app, 'src');
  if (!existsSync(src)) continue;
  for (const abs of walk(src)) {
    const rel = relative(ROOT, abs).replace(/\\/g, '/');
    files.push({ abs, rel, code: stripComments(readFileSync(abs, 'utf8')) });
  }
}

const violations = [];

// ── 1) 渲染禁词 + 物理 API 禁词（逐行字符串兜底）────────────────────────────
for (const f of files) {
  if (ALLOWED_FILES.has(f.rel)) continue;
  const lines = f.code.split('\n');
  for (const [needle, what] of FORBIDDEN) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(needle)) {
        violations.push(`${f.rel}:${i + 1}  ${what} 只许出现在共享层（命中：${needle}）`);
      }
    }
  }
  for (const [needle, what] of FORBIDDEN_PHYS) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(needle)) {
        violations.push(`${f.rel}:${i + 1}  ${what} 只许由共享 EntityGameplay/worker-dispatch 下发（命中：${needle}）`);
      }
    }
  }
}

// ── 2) import 别名拦截（防 `import { PhysWorld as PW }` 绕过字符串扫描）───────
const IMPORT_RE = /^[ \t]*import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"][^'"]+['"]/gm;
for (const f of files) {
  if (ALLOWED_FILES.has(f.rel) || ALIAS_ALLOWED_FILES.has(f.rel)) continue;
  for (const m of f.code.matchAll(IMPORT_RE)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim().replace(/^type\s+/, '');
      if (!piece) continue;
      const mm = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(piece);
      if (mm && ALIAS_SENSITIVE.has(mm[1])) {
        violations.push(`${f.rel}  import 用 \`as\` 重命名敏感符号 ${mm[1]} as ${mm[2]}（疑似绕过禁词扫描）`);
      }
    }
  }
}

// ── 3) 装配点白名单：只许出现在登记文件，且登记文件必须真的命中 ─────────────
for (const rule of ASSEMBLY) {
  const hits = [];
  for (const f of files) {
    const lines = f.code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(rule.needle)) hits.push({ rel: f.rel, line: i + 1 });
    }
  }
  for (const h of hits) {
    if (!rule.files.includes(h.rel)) {
      violations.push(`${h.rel}:${h.line}  ${rule.what} 是装配点，只许出现在 ${rule.files.join(' / ')}（命中：${rule.needle}）`);
    }
  }
  for (const allowed of rule.files) {
    if (!existsSync(join(ROOT, allowed))) {
      violations.push(`${allowed}  装配白名单文件不存在（${rule.what} 判据空转）`);
      continue;
    }
    if (!hits.some((h) => h.rel === allowed)) {
      violations.push(`${allowed}  未命中 ${rule.needle}（${rule.what} 判据空转：文件在但装配点没了）`);
    }
  }
}

// ── 4) 渲染入口必须走共享 RenderSession ────────────────────────────────────
for (const entry of ENTRY_FILES) {
  const p = join(ROOT, entry);
  if (!existsSync(p)) {
    violations.push(`${entry}  不存在（三端渲染入口清单过期）`);
    continue;
  }
  const text = readFileSync(p, 'utf8');
  if (!text.includes('RenderSession') || !text.includes('session.loadScene')) {
    violations.push(`${entry}  未引用共享 RenderSession / session.loadScene`);
  }
}

// ── 5) 共享 RenderSession 必须真的含装配/天空/可见性（防掏空）──────────────
if (!existsSync(join(ROOT, SHARED_SESSION))) {
  violations.push(`${SHARED_SESSION}  不存在`);
} else {
  const shared = readFileSync(join(ROOT, SHARED_SESSION), 'utf8');
  for (const needle of ['assembleScene', 'renderSkyPass', 'VisibilityController', 'disposeScene']) {
    if (!shared.includes(needle)) violations.push(`${SHARED_SESSION}  缺少共享步骤：${needle}`);
  }
}

// ── 6) 共享层反空转（禁词的「另一侧」必须真的实现）─────────────────────────
for (const guard of SHARED_GUARDS) {
  const p = join(ROOT, guard.file);
  if (!existsSync(p)) {
    violations.push(`${guard.file}  不存在（${guard.what} 判据空转）`);
    continue;
  }
  const text = stripComments(readFileSync(p, 'utf8'));
  for (const needle of guard.needles) {
    if (!text.includes(needle)) violations.push(`${guard.file}  缺少 ${needle}（${guard.what} 判据空转）`);
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────
if (violations.length) {
  console.error(`[render-parity] 违规 ${violations.length} 处：`);
  for (const v of violations) console.error('  - ' + v);
  console.error('\n规则：渲染步骤只在 src/renderer-shared/scene/render-session.ts；物理副作用只在共享 EntityGameplay/worker-dispatch；' +
    '装配点仅限登记的 worker/main.ts、renderer-main.ts、app.ts。');
  process.exit(1);
}
console.log(`[render-parity] OK：三端渲染入口都走共享 RenderSession；apps 内没有重写渲染步骤/物理副作用；` +
  `装配点 ${ASSEMBLY.reduce((n, r) => n + r.files.length, 0)} 处与共享层反空转 guard 均命中。`);
