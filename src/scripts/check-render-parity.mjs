/**
 * 渲染/物理归属静态门禁：三端的「共享步骤」必须只在共享层存在（task-57 起分两层判据；
 * task-84/B3 起补「绑定解析 + 拼接/模板串联 + 别名/解构 + 动态 require/import + 构造参数」检测）。
 *
 * 背景（2026-10-23）：`assembleScene` 只统一了 GLB→终扫的 7 步；load/环境/天空/相机/可见性/
 * 画质/每帧 draw 仍是三份。事故：回退 VMT 表只装在 viewer 的 `core/bsp.ts`，debug/game 没装
 * ⇒ debug 水层 alpha=0 不绘制。本脚本把「哪些调用只许出现在共享层」写成可执行判据。
 *
 * 判据（全部满足才 exit 0）：
 *   1. `apps/<app>/src` 下的 TS 不得出现共享步骤的调用/构造（注释不算）——两层：
 *      1a. 逐行字符串兜底（包含 `renderer.render(`、`scene.fog =` 这类原文命中）；
 *      1b. 语义层（task-84/B3）：剥注释 + 折叠字符串拼接/模板后，
 *          - 调用点解析（含 `(0, obj.fn)()` 间接调用、`obj['lit']()` 动态属性调用）；
 *          - `new X(` 构造；`scene.fog =` 这类成员赋值；
 *          - 括号字符串属性名（`obj['set_'+'jump_height']` 折叠后命中）；
 *          - 字符串字面量恰等于禁词名（构造参数/对象字面量透传）；
 *          - `import { X as Y }` 别名、`const { X: Y } = obj` 解构别名；
 *          - `require()` / 动态 `import()` 引用共享层模块（静态可审计性要求）。
 *      1c. 共享层装配点：`src/ts-shared`、`src/renderer-shared` 下也不得出现未登记的装配点调用
 *          （防「共享层第二个文件又 new 一份物理世界」）。
 *   2. 三端渲染入口必须引用 `RenderSession`（viewer `core/scene.ts`、game/debug `renderer-main.ts`）；
 *   3. 共享 `render-session.ts` 必须真的包含装配/天空/可见性三件事（防它被掏空后仍过关）。
 *
 * 用法：`node src/scripts/check-render-parity.mjs [--root <dir>]`（仓库根运行）。违规时 exit 1。
 * `--root` 只给反向对照样本用：指向别的目录时按同一规则扫描该目录，不修改真实仓库。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

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

/** 只许由共享层 `EntityGameplay` / `worker-dispatch` 下发的物理副作用 API（Rust 侧 snake_case）。 */
const FORBIDDEN_PHYS = [
  ['add_velocity(', '物理冲量（add 语义）'],
  ['set_push_velocity(', '推力板速度（set 语义）'],
  ['set_jump_height(', '跳高改写'],
  ['set_max_horizontal_speed(', '水平限速'],
  ['set_teleport_player_name(', '传送玩家名'],
  ['set_teleport_filter_enabled', '传送过滤门控'],
  ['set_player_base_velocity(', '基础速度（AddOutput basevelocity）'],
];

/** 实体→物理宿主适配层 API（camelCase）：只许 EntityGameplay/worker-dispatch 内部使用。 */
const FORBIDDEN_HOST = [
  ['addPlayerVelocity', '物理冲量（host add）'],
  ['setPlayerBaseVelocity', '基础速度（host set）'],
  ['setPushVelocity', '推力板速度（host）'],
  ['setJumpHeight', '跳高改写（host）'],
  ['setMaxHorizontalSpeed', '水平限速（host）'],
  ['setTeleportPlayerName', '传送玩家名（host）'],
  ['setTeleportFilterEnabled', '传送过滤门控（host）'],
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
    // 唯一调用点 app-runtime（P2 下沉后三端共用）+ 定义本体 shared-state.ts。
    files: ['src/ts-shared/app/app-runtime.ts', 'src/ts-shared/auth/shared-state.ts'],
  },
  {
    needle: 'attachEntitySystem(',
    what: '实体系统挂载',
    // 实体宿主的三处合法位置：viewer 观察模式（无物理）、共享 EntityGameplay（debug/game），
    // 以及 attach.ts 里的定义本体。共享层第二个「自己再挂一套」的文件会因此被拦下。
    files: [
      'apps/viewer/src/app.ts',
      'src/ts-shared/gameplay/entity-gameplay.ts',
      'src/ts-shared/entity/attach.ts',
    ],
  },
];

/** 别名/宿主符号的敏感清单（task-57 起保留，task-84 起与禁词派生集合合并）。 */
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

/**
 * 禁词符号表：从上面三张禁词表派生「调用/构造/赋值」可匹配的名字。
 * 语义层按名字匹配（而不是原文 includes），因此 `obj['set_'+'jump_height']`、
 * `(0, obj.setJumpHeight)()` 这类绕过能被折叠/解析后拦下。
 */
function deriveSymbols() {
  const out = [];
  for (const [needle, what] of [...FORBIDDEN, ...FORBIDDEN_PHYS, ...FORBIDDEN_HOST]) {
    let name = needle.trim();
    let kind = 'call';
    if (name.startsWith('new ')) {
      name = name.slice(4);
      kind = 'ctor';
    } else if (/=\s*$/.test(name) && !name.endsWith('=')) {
      name = name.replace(/=\s*$/, '').trim();
      kind = 'assign';
    } else if (/=$/.test(name) && !name.endsWith('==')) {
      name = name.replace(/=$/, '').trim();
      kind = 'assign';
    }
    if (name.endsWith('(')) name = name.slice(0, -1);
    out.push({ name: name.trim(), what, kind });
  }
  return out;
}
const SYMBOLS = deriveSymbols();
const SYM_BY_NAME = new Map(SYMBOLS.map((s) => [s.name, s]));

/** 装配符号在各自白名单文件里合法（否则 apps 内任何位置都不许出现）。 */
const SYMBOL_ALLOWED = new Map([
  ['PhysWorld', new Set(ASSEMBLY[0].files)],
  ['createMainSharedState', new Set(ASSEMBLY[1].files)],
  ['attachEntitySystem', new Set(ASSEMBLY[2].files)],
]);

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

/** 最小反转义（只服务判据；未知转义原样保留）。 */
function decodeStringBody(body) {
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, c) => {
    if (c[0] === 'u' && c.length > 1) {
      try { return String.fromCodePoint(parseInt(c[1] === '{' ? c.slice(2, -1) : c.slice(1), 16)); } catch { return m; }
    }
    if (c[0] === 'x' && c.length === 3) return String.fromCharCode(parseInt(c.slice(1), 16));
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      default: return c;
    }
  });
}

/**
 * 折叠字符串拼接与模板串联：
 *   'add_' + 'velocity'            → 'add_velocity'
 *   `set_${'jump'}_height`         → 'set_jump_height'
 * 迭代到不动点（最多 12 轮，防病态输入）。
 */
function foldStrings(code) {
  let s = code;
  for (let round = 0; round < 12; round++) {
    const before = s;
    // 模板里只含字符串字面量的 ${'lit'} → lit
    s = s.replace(/\$\{\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\}/g, (_m, _q, body) => decodeStringBody(body));
    // 'a' + 'b' → 'ab'（异/同引号都行；\\ 与 ' 重新转义）
    s = s.replace(/(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\+\s*(['"])((?:\\.|(?!\3)[^\\])*)\3/g,
      (_m, _q1, b1, _q2, b2) => {
        const merged = decodeStringBody(b1) + decodeStringBody(b2);
        return "'" + merged.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
      });
    if (s === before) break;
  }
  return s;
}

function stringLiterals(code) {
  const out = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(code))) out.push({ index: m.index, value: decodeStringBody(m[2]) });
  return out;
}

/** 调用点解析：支持 `fn(`、`obj.fn(`、`(0, obj.fn)(`、`obj['lit'](`。 */
function callCallees(code) {
  const out = [];
  const re = /(?:\(\s*0\s*,\s*)?([A-Za-z_$][\w$]*(?:\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*(['"])(?:\\.|(?!\2)[^\\])*\2\s*\]))*)\s*\)?\s*\(/g;
  let m;
  while ((m = re.exec(code))) out.push({ index: m.index, callee: m[1].replace(/\s+/g, '') });
  return out;
}

function normalizeCallee(callee) {
  return callee.replace(/\['([^']*)'\]/g, '.$1').replace(/\["([^"]*)"\]/g, '.$1');
}

/** 命中哪个禁词符号（成员链后缀匹配；单段名字要求最后一段完全相同）。 */
function matchSymbol(callee) {
  const c = normalizeCallee(callee).replace(/^this\./, '');
  if (SYM_BY_NAME.has(c)) return SYM_BY_NAME.get(c);
  const segs = c.split('.');
  const last = segs[segs.length - 1];
  const sym = SYM_BY_NAME.get(last);
  if (sym && !sym.name.includes('.')) return sym;
  for (const s of SYMBOLS) {
    if (s.name.includes('.') && c.endsWith('.' + s.name)) return s;
  }
  return null;
}

function symbolAllowedIn(rel, sym) {
  const allow = SYMBOL_ALLOWED.get(sym.name);
  return Boolean(allow && allow.has(rel));
}

function lineOf(code, index) {
  let n = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === '\n') n++;
  return n;
}

/** 把相对 import 说明符解析成仓库相对路径；非相对/无法解析返回 null。 */
function resolveSpecifier(relFile, spec) {
  if (!spec.startsWith('.')) return null;
  const abs = resolve(ROOT, dirname(relFile), spec);
  return relative(ROOT, abs).replace(/\\/g, '/');
}

const SHARED_LAYER_RE = /^src\/(ts-shared|renderer-shared)\//;

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

/**
 * 共享层也要扫「装配点」：共享层是装配步骤的合法位置，但只允许登记的那几处。
 * 防的是「共享层里又冒出第二个 new PhysWorld / createMainSharedState」这类暗分叉。
 */
const sharedFiles = [];
for (const dir of ['src/ts-shared', 'src/renderer-shared']) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    sharedFiles.push({ abs: file, rel, code: stripComments(readFileSync(file, 'utf8')) });
  }
}

const violations = [];
const violationKeys = new Set();
const addViolation = (line, msg) => {
  const key = `${line === null ? '' : line}|${msg}`;
  if (violationKeys.has(key)) return;
  violationKeys.add(key);
  violations.push(line === null ? msg : `${line}  ${msg}`);
};

// ── 1) 渲染禁词 + 物理 API 禁词（逐行字符串兜底；保持 task-57 判据不缩水）─────
for (const f of files) {
  if (ALLOWED_FILES.has(f.rel)) continue;
  const lines = f.code.split('\n');
  for (const [needle, what] of FORBIDDEN) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(needle)) {
        addViolation(`${f.rel}:${i + 1}`, `${what} 只许出现在共享层（命中：${needle}）`);
      }
    }
  }
  for (const [needle, what] of FORBIDDEN_PHYS) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(needle)) {
        addViolation(`${f.rel}:${i + 1}`, `${what} 只许由共享 EntityGameplay/worker-dispatch 下发（命中：${needle}）`);
      }
    }
  }
}

// ── 2) 语义层：绑定解析 + 拼接/模板折叠 + 别名/解构 + require/动态 import ────
for (const f of files) {
  if (ALLOWED_FILES.has(f.rel)) continue;
  const folded = foldStrings(f.code);
  const hits = [];

  // 2a) 调用点（含 (0,obj.fn)() 间接调用、obj['lit']() 动态属性调用）
  for (const { index, callee } of callCallees(folded)) {
    const sym = matchSymbol(callee);
    if (!sym) continue;
    if (symbolAllowedIn(f.rel, sym)) continue;
    hits.push([lineOf(folded, index), `调用点命中禁词 ${sym.name}（${sym.what}）/${sym.kind === 'ctor' ? '构造' : '调用'}：${callee}`]);
  }
  // 2b) new X( 构造（显式兜底，防止 callee 正则漏配）
  for (const m of folded.matchAll(/\bnew\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g)) {
    const sym = matchSymbol(m[1].replace(/\s+/g, ''));
    if (!sym || sym.kind !== 'ctor') continue;
    if (symbolAllowedIn(f.rel, sym)) continue;
    hits.push([lineOf(folded, m.index), `构造命中禁词 ${sym.name}（${sym.what}）`]);
  }
  // 2c) 成员赋值：scene.fog = / scene['background'] =
  for (const m of folded.matchAll(/([A-Za-z_$][\w$]*(?:\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*(['"])(?:\\.|(?!\2)[^\\])*\2\s*\]))*)\s*=(?!=)/g)) {
    const sym = matchSymbol(m[1].replace(/\s+/g, ''));
    if (!sym || sym.kind !== 'assign') continue;
    hits.push([lineOf(folded, m.index), `赋值命中禁词 ${sym.name}（${sym.what}）`]);
  }
  // 2d) 括号字符串属性名：obj['set_jump_height']（由 2a 覆盖调用，这里兜住非调用场景）
  for (const m of folded.matchAll(/\[\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\]/g)) {
    const sym = SYM_BY_NAME.get(decodeStringBody(m[2]));
    if (sym) hits.push([lineOf(folded, m.index), `动态属性名命中禁词 ${sym.name}（${sym.what}）`]);
  }
  // 2e) 字符串字面量恰等于禁词名（构造参数/对象字面量透传，如 {fn:'add_velocity'}）
  for (const lit of stringLiterals(folded)) {
    const sym = SYM_BY_NAME.get(lit.value);
    if (sym) hits.push([lineOf(folded, lit.index), `字符串字面量命中禁词 ${sym.name}（${sym.what}）`]);
  }

  // 2f) import 别名：import { X as Y } —— X 为禁词/宿主敏感符号（装配符号在白名单文件里合法）
  const IMPORT_RE = /^[ \t]*import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"][^'"]+['"]/gm;
  for (const m of folded.matchAll(IMPORT_RE)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim().replace(/^type\s+/, '');
      if (!piece) continue;
      const mm = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(piece);
      if (!mm) continue;
      const sym = SYM_BY_NAME.get(mm[1]);
      if (!sym) continue;
      if (symbolAllowedIn(f.rel, sym)) continue;
      hits.push([lineOf(folded, m.index), `import 用 \`as\` 重命名禁用符号 ${mm[1]} as ${mm[2]}（疑似绕过禁词扫描）`]);
    }
  }
  // 2g) 解构别名：const { X: Y } = obj / const { X } = obj
  for (const m of folded.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim().replace(/^type\s+/, '');
      if (!piece) continue;
      const mm = /^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/.exec(piece);
      if (!mm) continue;
      const sym = SYM_BY_NAME.get(mm[1]);
      if (!sym) continue;
      if (symbolAllowedIn(f.rel, sym)) continue;
      hits.push([lineOf(folded, m.index), `解构别名命中禁词 ${mm[1]}${mm[2] ? ' as ' + mm[2] : ''}（疑似绕过禁词扫描）`]);
    }
  }
  // 2h) require() / 动态 import() 引用共享层模块（静态可审计性要求；type import 不受影响）
  const DYN_RE = /(?<![\w$.])(require|import)\s*\(\s*(['"`])((?:\\[\s\S]|(?!\2)[^\\])*)\2/g;
  for (const m of folded.matchAll(DYN_RE)) {
    const spec = decodeStringBody(m[3]);
    const resolved = resolveSpecifier(f.rel, spec);
    const target = resolved ?? spec;
    if (SHARED_LAYER_RE.test(target) || spec.includes('/src/ts-shared/') || spec.includes('/src/renderer-shared/')) {
      hits.push([lineOf(folded, m.index), `${m[1]}() 动态引用共享层模块 ${spec}（绕过静态 import 审计）`]);
    }
  }
  // 2i) 动态构造的 require（非字面量说明符）
  for (const m of folded.matchAll(/(?<![\w$.])require\s*\(\s*(?!['"`])/g)) {
    hits.push([lineOf(folded, m.index), 'require() 说明符不是字符串字面量（无法静态审计）']);
  }

  for (const [line, msg] of hits) addViolation(`${f.rel}:${line}`, msg);
}

// ── 3) 装配点白名单：只许出现在登记文件，且登记文件必须真的命中 ─────────────
for (const rule of ASSEMBLY) {
  const hits = [];
  for (const f of [...files, ...sharedFiles]) {
    const lines = f.code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(rule.needle)) hits.push({ rel: f.rel, line: i + 1 });
    }
  }
  for (const h of hits) {
    if (!rule.files.includes(h.rel)) {
      addViolation(`${h.rel}:${h.line}`, `${rule.what} 是装配点，只许出现在 ${rule.files.join(' / ')}（命中：${rule.needle}）`);
    }
  }
  for (const allowed of rule.files) {
    if (!existsSync(join(ROOT, allowed))) {
      addViolation(null, `${allowed}  装配白名单文件不存在（${rule.what} 判据空转）`);
      continue;
    }
    if (hits.some((h) => h.rel === allowed)) continue;
    // 装配点可以落在共享层文件（不在 apps 扫描集合内）：直接读文件复核，仍防白名单空转。
    if (!files.some((f) => f.rel === allowed)) {
      const shared = stripComments(readFileSync(join(ROOT, allowed), 'utf8'));
      if (shared.includes(rule.needle)) continue;
    }
    addViolation(null, `${allowed}  未命中 ${rule.needle}（${rule.what} 判据空转：文件在但装配点没了）`);
  }
}

// ── 4) 渲染入口必须走共享 RenderSession ────────────────────────────────────
for (const entry of ENTRY_FILES) {
  const p = join(ROOT, entry);
  if (!existsSync(p)) {
    addViolation(null, `${entry}  不存在（三端渲染入口清单过期）`);
    continue;
  }
  const text = readFileSync(p, 'utf8');
  if (!text.includes('RenderSession') || !text.includes('session.loadScene')) {
    addViolation(null, `${entry}  未引用共享 RenderSession / session.loadScene`);
  }
}

// ── 5) 共享 RenderSession 必须真的含装配/天空/可见性（防掏空）──────────────
if (!existsSync(join(ROOT, SHARED_SESSION))) {
  addViolation(null, `${SHARED_SESSION}  不存在`);
} else {
  const shared = readFileSync(join(ROOT, SHARED_SESSION), 'utf8');
  for (const needle of ['assembleScene', 'renderSkyPass', 'VisibilityController', 'disposeScene']) {
    if (!shared.includes(needle)) addViolation(null, `${SHARED_SESSION}  缺少共享步骤：${needle}`);
  }
}

// ── 6) 共享层反空转（禁词的「另一侧」必须真的实现）─────────────────────────
for (const guard of SHARED_GUARDS) {
  const p = join(ROOT, guard.file);
  if (!existsSync(p)) {
    addViolation(null, `${guard.file}  不存在（${guard.what} 判据空转）`);
    continue;
  }
  const text = stripComments(readFileSync(p, 'utf8'));
  for (const needle of guard.needles) {
    if (!text.includes(needle)) addViolation(null, `${guard.file}  缺少 ${needle}（${guard.what} 判据空转）`);
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────
if (violations.length) {
  console.error(`[render-parity] 违规 ${violations.length} 处：`);
  for (const v of violations) console.error('  - ' + v);
  console.error('\n规则：渲染步骤只在 src/renderer-shared/scene/render-session.ts；物理副作用只在共享 EntityGameplay/worker-dispatch；' +
    '装配点仅限上面登记的白名单文件（含共享层唯一装配点），新增装配点必须显式登记。');
  process.exit(1);
}
console.log(`[render-parity] OK：三端渲染入口都走共享 RenderSession；apps 内没有重写渲染步骤/物理副作用` +
  `（含拼接/模板/别名/解构/动态 import 检测）；装配点 ${ASSEMBLY.reduce((n, r) => n + r.files.length, 0)} 处与共享层反空转 guard 均命中。`);
