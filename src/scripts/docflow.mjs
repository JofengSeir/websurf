#!/usr/bin/env node
/**
 * 文档契约（docflow）—— md 的只读/可编辑划分、哈希钉住、同意留痕与任务变更契约。
 *
 * 解决的问题：① 哪些 md 属「宪法层」（改之前要 owner 许可）、哪些日常可改；② 一篇改了，
 * 是否连带该改的另一篇也改了；③ 一个任务声称改哪些文件，结束时是否真的只改了那些。
 *
 * 划分口径（`docflow.json` 的 policy.readonly 可覆盖；未列入的一律「可编辑」）：
 *   只读（默认，机器清单见代码里的 DEFAULT_READONLY）：AGENTS.md、README.md、
 *        CONTRIBUTING.md、SECURITY.md、documents/norms 全篇、.github 下的 .md 模板、
 *        skills 下的 SKILL.md
 *   可编辑：OWNER.md、CHANGELOG.md、documents 其余各篇、progress（含看板镜像 board.jsonl）、skills 其余
 *        —— 控制层与过程记录**必须**能被 agent 写（§0.1 状态流转、§0.3 决策登记、§0.2 收尾）。
 *
 * 哈希口径：文件内容按 LF 归一后取 sha256。与体检 [F] 的「提交形态」一致——仓库
 * core.autocrlf=true，工作树的 CRLF 只是检出产物，不算改动。
 *
 * 锚点指纹按 `目标文件:行号`（**不是**按出现次序）存与比：一篇里插一行新锚点不会连带报错。
 * 重钉只处理点名/审批/新出现的篇，且锚点真有变化时必须给 `--reason`，留痕进 `rebaselines`。
 * 新增与删除同样受管：只读类的**新文件**（无钉）与**消失的钉**都算违规，须先 approve。
 *
 * 子命令（退出码：check / verify 有违规 → 1）：
 *   report                                       打印划分与锁状态（给人看）
 *   check [--quiet] [--all] [--base R]           只读漂移 / 单元权限 / 锚点内容 / 联动（体检 [O] 同口径）
 *                                                git 基础设施故障重试 3 次后降级 [WARN] + exit 0（见 gitRetry）
 *   approve --path P --by W --reason R [--task T]   登记一次「临时可动」许可
 *   sync [--path P…] [--all] [--by W] [--reason R]  落实许可并重钉（锚点有变化时 --reason 必填）
 *   claim --task T --may A,B [--must C,D]        认领：写任务变更契约（同一时刻只允许一条）
 *   verify                                       用认领校验结束条件（must 未改 / 越界改动 / 只读漂移）
 *   release                                      释放认领
 *
 * **CI 里的「改了什么」**：CI 工作树等于 HEAD，`git status` 恒为空，联动（binds / cochange）
 * 必须相对基线算——给 `--base <rev>`，或由 CI 环境自动取 `HEAD^`。
 *
 * **定位（别误当沙箱）**：agent 有完整文件权限，`--by` 是自报的。本工具是**审计与同意协议**：
 * 划分显式、漂移可检、同意留痕（随 docflow.json 进版本库、可复核）、结束条件可锁。
 * 调用方：体检 [O] 与 `AGENTS §0.2` 的认领/收尾步骤。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCK = path.join(ROOT, 'docflow.json');
/** 收尾必动、不参与「越界改动」判定的文件（§0.2 强制同提交更新它们）。 */
const STD = ['OWNER.md', 'docflow.json', 'progress/board.jsonl'];
/** 默认只读集：宪法层里**不随提交滚动**的那些。 */
const DEFAULT_READONLY = ['AGENTS.md', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', '.github/**/*.md', 'skills/**/SKILL.md'];
/** 候选提升为只读、但需先解决「每提交都要改它」的文件（report 会提示）。 */
const CANDIDATES = [
  ['progress/board.jsonl', '看板机器可读镜像（人类可读看板在 agentmemory）；agent 每次认领/结案都要改 ⇒ 只锁「新建/删除」而非「改行」才有意义'],
  ['OWNER.md', '§0.3 规定 agent 要写 D-### 决策行 ⇒ 同上'],
];
const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'report';
/** 取 `--name value`（可重复）。 */
const optAll = (name) => argv.flatMap((a, i) => (a === '--' + name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
const opt = (name, dflt) => (optAll(name).length ? optAll(name)[optAll(name).length - 1] : dflt);
const flag = (name) => argv.includes('--' + name);
/** 全量模式：CI 或显式 --all。本地默认「改动面模式」，只查受影响的目标，控住单次体检成本。 */
const ALL_MODE = flag('all') || !!process.env.CI;
/** 变更基线：显式 --base 优先；CI 下退回 HEAD^（CI 工作树 == HEAD，没有基线就判不出「改了什么」）。 */
const BASE = opt('base') || (ALL_MODE ? tryRev('HEAD^') : null);
function tryRev(r) {
  try { return execFileSync('git', ['rev-parse', '--verify', '--quiet', r], { cwd: ROOT, encoding: 'utf8' }).trim() || null; } catch { return null; }
}
/** 只算一次的懒值：git 调用很贵，同一事实在一个进程里只取一次。 */
function memo(fn) { let v, done = false; return () => { if (!done) { v = fn(); done = true; } return v; }; }
/** 同步退避：无事件循环可 await，Atomics.wait 是 Node 的同步 sleep 惯用法。 */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** git 调用重试：并发或杀软占用下偶发 EBUSY（见 skills/websurf-env-traps）。3 次仍失败才抛出。 */
function gitRetry(args, n = 3) {
  for (let i = 1; ; i++) {
    try { return execFileSync('git', args, { cwd: ROOT, maxBuffer: 64e6, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { if (i >= n) throw e; sleepSync(200 * i); }
  }
}
/** `**` 跨目录、`*` 不跨目录的极简 glob。 */
function globToRe(g) {
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { if (g[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i++; } }
      else out += '[^/]*';
    }
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^$()|[\]{}]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}
const load = () => (fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, 'utf8')) : { version: 1, policy: { readonly: DEFAULT_READONLY, candidates: CANDIDATES }, pins: {}, unitPins: {}, units: {}, binds: [], approvals: [], cochange: [], rebaselines: [], claim: null });
const save = (d) => fs.writeFileSync(LOCK, JSON.stringify(d, null, 2) + '\n');
const readonlyGlobs = (d) => (d.policy && d.policy.readonly ? d.policy.readonly : DEFAULT_READONLY);
const isReadonly = (d, f) => readonlyGlobs(d).some((g) => globToRe(g).test(f));
/** sha256（LF 归一）；文件不存在返回 null。 */
function hash(f) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(p).toString('utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}
/** 版本库里与工作区的 md（已跟踪 + 未忽略的未跟踪）。 */
const listMd = memo(() => {
  const out = gitRetry(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md']).split('\u0000').filter(Boolean);
  return [...new Set(out)].filter((f) => fs.existsSync(path.join(ROOT, f)));
});
/** 变更面：有基线就比 `基线..工作树`（CI 里才算得出「本次改了什么」），否则工作树 vs HEAD。 */
const changed = memo(() => {
  const z = (o) => o.toString('utf8').split('\u0000').filter(Boolean);
  if (BASE) {
    const diff = execFileSync('git', ['diff', '--name-only', '-z', BASE, '--'], { cwd: ROOT, maxBuffer: 64e6 });
    const unt = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: ROOT, maxBuffer: 64e6 });
    return new Set([...z(diff), ...z(unt)]);
  }
  return new Set(execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => l.slice(3).trim()));
});
const permitFor = (d, f) => d.approvals.find((a) => a.path === f && !a.consumed);
const autoOk = (f) => STD.includes(f) || f.startsWith('progress/');

/** sha256（UTF-8）。 */
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
/** 从文本抽出「单元」（表格行）：id -> { cells, line }；unit.idCell 指定哪列当 id。 */
function extractUnits(text, spec) {
  const re = new RegExp(spec.match);
  const out = new Map();
  text.split(/\r?\n/).forEach((l, i) => {
    if (!re.test(l)) return;
    const cells = l.split('|').slice(1, -1).map((x) => x.trim());
    if (cells.length < 2) return;
    out.set(cells[spec.idCell ?? 0], { cells, line: i + 1 });
  });
  return out;
}
/** 受保护列指纹（权限判定用）。 */
const protFp = (u, spec) => sha((spec.pinned || []).map((i) => u.cells[i] ?? '').join('|'));
/** 单元全指纹（强绑定判定用）。 */
const fullFp = (u) => sha(u.cells.join('|'));
/** 权限规格指纹：规格变了要单独报，不能与「受保护列被改」混为一谈。 */
const specHash = (spec) => sha(JSON.stringify({ p: spec.pinned || [], n: !!spec.allowNew, d: !!spec.allowDelete }));
/** 基线的同一文件内容（强绑定比对的起点）：有 --base 用 --base，否则 HEAD。 */
function baselineText(f) {
  const rev = BASE || 'HEAD';
  try { return execFileSync('git', ['show', rev + ':' + f.split(path.sep).join('/')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32e6 }); } catch { return ''; }
}
const unitsOfText = (d, f, text) => extractUnits(text, d.units[f]);
const unitsOfFile = (d, f) => unitsOfText(d, f, fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), 'utf8') : '');
/** 权限：受保护列不得改、行集合不得增删（除非该文件拿到许可）。 */
function checkUnits(d) {
  const bad = [];
  for (const [f, spec] of Object.entries(d.units || {})) {
    if (!ALL_MODE && !changed().has(f)) continue;
    const cur = unitsOfFile(d, f);
    const pins = d.unitPins[f] || {};
    const permit = permitFor(d, f);
    for (const [id, want] of Object.entries(pins)) {
      const u = cur.get(id);
      if (!u) {
        if (!spec.allowDelete && !permit) bad.push('  ' + f + ' 单元 ' + id + ' 被删除（本文件不许删行；分卷/归档或误删都须先 `node src/scripts/docflow.mjs approve --path ' + f + ' --by <谁> --reason <分卷|归档|误删>`，改完 sync）');
        continue;
      }
      if (protFp(u, spec) !== want.p && !permit) {
        if (want.s && want.s !== specHash(spec)) bad.push('  ' + f + ' 单元 ' + id + ' 的权限规格已变（现受保护列 [' + (spec.pinned || []).join(',') + ']）⇒ 复核后 approve 并 sync');
        else bad.push('  ' + f + ' 单元 ' + id + ' 的受保护列 [' + ((spec.pinned || []).join(',') || '无') + '] 内容被改 ⇒ 须先 approve 并 sync');
      }
    }
    for (const id of cur.keys()) if (!(id in pins) && !spec.allowNew && !permit) bad.push('  ' + f + ' 新增单元 ' + id + '（本文件不许 agent 新增行；须先 approve）');
  }
  return bad;
}
/** 强绑定：单元变了 ⇒ 配对单元必须也变（比工作树与基线）。`#*` = 整篇任一单元。 */
function checkBinds(d) {
  const bad = [];
  const changedIn = (f, id) => {
    const cur = unitsOfFile(d, f), base = unitsOfText(d, f, baselineText(f));
    if (id === '*') return [...cur.keys()].some((k) => !base.has(k) || fullFp(cur.get(k)) !== fullFp(base.get(k)));
    if (cur.has(id) !== base.has(id)) return true;
    return cur.has(id) && fullFp(cur.get(id)) !== fullFp(base.get(id));
  };
  for (const b of d.binds || []) {
    const [fa, ia] = String(b.if).split('#');
    if (!(d.units || {})[fa]) continue;
    if (!changedIn(fa, ia)) continue;
    for (const t of b.then) {
      const [fb, ib] = String(t).split('#');
      if (!(d.units || {})[fb]) continue;
      if (!changedIn(fb, ib)) bad.push('  强绑定：' + b.if + ' 变了，但配对的 ' + t + ' 没动');
    }
  }
  return bad;
}
/** 重钉单元（sync 调用；受保护列变了要求有许可）。不变的钉保留原日期，避免整表噪声。 */
function refreshUnits(d) {
  for (const [f, spec] of Object.entries(d.units || {})) {
    const cur = unitsOfFile(d, f);
    const prev = d.unitPins[f] || {};
    const keep = {};
    for (const [id, u] of cur) {
      const p = protFp(u, spec);
      const s = specHash(spec);
      if (prev[id] && prev[id].p !== p && !permitFor(d, f)) { keep[id] = prev[id]; continue; }
      if (prev[id] && prev[id].p === p && prev[id].s === s) { keep[id] = { ...prev[id], line: u.line }; continue; }
      keep[id] = { p, s, at: new Date().toISOString().slice(0, 10), line: u.line };
    }
    for (const [id, v] of Object.entries(prev)) if (!cur.has(id) && !spec.allowDelete && !permitFor(d, f)) keep[id] = v;
    d.unitPins[f] = keep;
  }
}

// ===== 锚点内容指纹：`路径:行号` 指的那一行是否还是复核时的样子 =====
/** 反引号写法（文档与规范面统一用这个）。 */
const ANCHOR_RE = /`([A-Za-z0-9_./\\-]+\.(?:ts|mts|mjs|cjs|js|rs|json|cmd|ps1|sh|yml|yaml|html|css|toml|py|md)):(\d+)(?:-(\d+))?`/g;
/** 裸写法：控制层（TODO/OWNER）的证据列不套反引号，单列一套。 */
const BARE_RE = /(?<![A-Za-z0-9_./\\`-])([A-Za-z0-9_./\\-]+\.(?:ts|mts|mjs|cjs|js|rs|json|cmd|ps1|sh|yml|yaml|html|css|toml|py|md)):(\d+)(?:-(\d+))?(?![0-9A-Za-z_`-])/g;
/** 归一化一行（压空白）——纯格式化不算改动。 */
const normLine = (s) => String(s).trim().replace(/\s+/g, ' ');
const LINE_CACHE = new Map();
/** 目标文件的行数组（不存在 → null）；同一文件只读一次。 */
function fileLines(p) {
  if (!LINE_CACHE.has(p)) {
    let L = null;
    try { if (fs.statSync(p).isFile()) L = fs.readFileSync(p, 'utf8').split(/\r?\n/); } catch { L = null; }
    LINE_CACHE.set(p, L);
  }
  return LINE_CACHE.get(p);
}
function scanAnchors(text, bare) {
  const hits = [];
  const add = (t, a, b) => {
    const target = t.split('\\').join('/');
    const L = fileLines(path.join(ROOT, target));
    let fp = '-';
    if (L) { const lines = []; for (let i = a; i <= b; i++) lines.push(normLine(L[i - 1] ?? '')); fp = sha(lines.join('\n')).slice(0, 8); }
    hits.push({ t: target, l: a, e: b, fp });
  };
  for (const m of text.matchAll(ANCHOR_RE)) add(m[1], Number(m[2]), m[3] ? Number(m[3]) : Number(m[2]));
  if (bare) for (const m of text.matchAll(BARE_RE)) add(m[1], Number(m[2]), m[3] ? Number(m[3]) : Number(m[2]));
  return hits;
}
/** 纳入锚点检查的 md：全仓已跟踪 md，排除过程记录 progress/ 与 skills/（历史与技能允许陈旧锚点）。 */
const anchorDocs = memo(() => execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: ROOT, maxBuffer: 64e6 }).toString('utf8').split('\u0000').filter(Boolean)
  .filter((f) => !f.startsWith('progress/') && !f.startsWith('skills/') && fs.existsSync(path.join(ROOT, f))));
/** 锚点的稳定键（`目标:首行:末行`；同一篇里同键重复时加 `~N` 后缀）。 */
const anchorKey = (a) => a.t + ':' + a.l + ':' + (a.e ?? a.l);
function anchorMap(list) {
  const out = {}; const seen = new Map();
  for (const a of list) { const k = anchorKey(a); const n = (seen.get(k) || 0) + 1; seen.set(k, n); out[n === 1 ? k : k + '~' + n] = a.fp; }
  return out;
}
/** 键 → {t,l}（键里的行号可能带 `~N` 后缀）。 */
function keyOf(k) {
  const p = k.replace(/~\d+$/, '').split(':');
  return { t: p.slice(0, -2).join(':'), l: p[p.length - 2] };
}
/** 锚点内容指纹校验：按 `目标:行号` 对位，点名到具体哪一处。 */
function checkAnchors(d) {
  const bad = [];
  const pins = d.anchorPins || {};
  const ch = changed();
  const surface = !ALL_MODE;                       // 本地只查改动面；CI / --all 全量
  for (const f of anchorDocs()) {
    const want = pins[f];
    if (!want) continue;
    if (Array.isArray(want)) { bad.push('  ' + f + ' 锚点钉是旧格式（按出现次序存的数组）⇒ 运行：node src/scripts/docflow.mjs sync --all --reason 升级锚点钉格式'); continue; }
    const bare = !!(d.units || {})[f];
    const cur = anchorMap(scanAnchors(fs.readFileSync(path.join(ROOT, f), 'utf8'), bare));
    const docChanged = ch.has(f);
    let shown = 0;
    const push = (s) => { shown++; if (shown <= 8) bad.push(s); };
    for (const [k, fp] of Object.entries(want)) {
      const now = cur[k];
      const { t, l } = keyOf(k);
      if (now === undefined) {
        if (!surface || docChanged) push('  ' + f + ' 锚点 `' + k + '` 已从文档里消失（或行号改了）⇒ 复核后 sync --path ' + f + ' --reason <理由>');
        continue;
      }
      if (now === '-') { push('  ' + f + ' 锚点 `' + t + ':' + l + '` 的目标文件已不存在（死锚点）⇒ 修正路径或删除该锚点'); continue; }
      if (now === fp) continue;
      if (surface && !docChanged && !ch.has(t)) continue;
      push('  ' + f + ' 锚点 `' + t + ':' + l + '` 指向的行内容已变 ⇒ 复核该断言后 sync --path ' + f + ' --reason <理由>');
    }
    for (const k of Object.keys(cur)) if (!(k in want)) { if (!surface || docChanged) push('  ' + f + ' 新增锚点 `' + k + '` ⇒ 复核后 sync --path ' + f + ' --reason <理由>'); }
    if (shown > 8) bad.push('  … ' + f + ' 同篇另有 ' + (shown - 8) + ' 处锚点问题未逐条打印');
  }
  return bad;
}
/** 重钉计划：只处理 targets（点名的 + 有审批的 + 还没钉过的新篇），并数出内容真变了几处。 */
function anchorPlan(d, targets) {
  const plan = [];
  const pins = d.anchorPins || {};
  for (const f of anchorDocs()) {
    const prev = pins[f];
    const fresh = prev === undefined;
    if (!fresh && !targets.has(f)) continue;
    const next = scanAnchors(fs.readFileSync(path.join(ROOT, f), 'utf8'), !!(d.units || {})[f]);
    const nm = anchorMap(next);
    let diff = 0;
    if (fresh || Array.isArray(prev)) diff = next.length;
    else {
      for (const [k, fp] of Object.entries(nm)) { if (prev[k] === undefined || prev[k] !== fp) diff++; }
      for (const k of Object.keys(prev)) if (nm[k] === undefined) diff++;
    }
    plan.push({ path: f, map: nm, diff, fresh, total: next.length });
  }
  return plan;
}

/** 覆盖率：这些「公开面」必须被至少一篇文档（documents/** 或 AGENTS.md）以**仓库相对路径**提到。 */
const COVER_GLOBS = ['apps/*/scripts/*.mjs', 'apps/*/scripts/*.js', 'src/scripts/*.mjs'];
function coverageFiles() {
  const list = execFileSync('git', ['ls-files', '-z', '--', 'apps', 'src'], { cwd: ROOT, maxBuffer: 64e6 }).toString('utf8').split('\u0000').filter(Boolean);
  const res = COVER_GLOBS.map(globToRe);
  return list.filter((f) => res.some((r) => r.test(f))).sort();
}
/** 未被任何文档提到的公开面。同名脚本必须写全路径——裸文件名会被同名的另一份顶包。 */
function checkCoverage(d) {
  const docs = ['AGENTS.md'].concat(execFileSync('git', ['ls-files', '-z', '--', 'documents/*.md'], { cwd: ROOT, maxBuffer: 64e6 }).toString('utf8').split('\u0000').filter(Boolean));
  const text = docs.map((f) => (fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), 'utf8') : '')).join('\n');
  const files = coverageFiles();
  const byBase = new Map();
  for (const f of files) { const b = path.basename(f); byBase.set(b, (byBase.get(b) || []).concat(f)); }
  const bad = [];
  for (const f of files) {
    if (text.includes(f)) continue;
    const b = path.basename(f);
    const twins = byBase.get(b);
    if (twins.length === 1 && text.includes(b)) continue;
    bad.push('  ' + f + ' 未被任何文档以**仓库相对路径**提到' + (twins.length > 1 ? '（同名脚本 ' + twins.length + ' 份，裸文件名无法区分）' : '') + ' ⇒ 在 documents/** 补一行登记');
  }
  return bad;
}

/** 只读漂移：钉住的对不上、有钉的文件消失、只读类新文件未登记。 */
function checkReadonly(d) {
  const bad = [];
  const md = new Set(listMd());
  const chg = ALL_MODE ? null : changed();
  for (const [f, h] of Object.entries(d.pins)) {
    if (chg && !chg.has(f)) continue;
    if (!md.has(f)) { bad.push('  ' + f + ' 已不存在（只读文件的删除须先 approve）'); continue; }
    if (hash(f) !== h && !permitFor(d, f)) bad.push('  ' + f + ' 内容已变且无审批 ⇒ owner 需 approve 后 sync');
  }
  for (const f of md) if (isReadonly(d, f) && !(f in d.pins)) bad.push('  ' + f + ' 属只读类但未登记（新增只读文件须先 approve）');
  return bad;
}
/** 联动：相对 HEAD，若 A 改了而配对的 B 没改（或反之），则断。 */
function checkCochange(d) {
  const bad = [];
  const ch = changed();
  for (const [a, b] of d.cochange || []) {
    if (ch.has(a) && !ch.has(b)) bad.push('  ' + a + ' 改了，但配对的 ' + b + ' 没改');
    if (ch.has(b) && !ch.has(a)) bad.push('  ' + b + ' 改了，但配对的 ' + a + ' 没改');
  }
  return bad;
}
function runCheck(quiet) {
  const d = load();
  const bad = [...checkReadonly(d), ...checkCochange(d), ...checkUnits(d), ...checkBinds(d), ...checkAnchors(d)];
  const cover = checkCoverage(d);
  if (cover.length && (d.policy.coverageMode === 'hard')) bad.push(...cover);
  if (cover.length && d.policy.coverageMode !== 'hard') console.log('  [覆盖率·计数] ' + cover.length + ' 个公开面未被文档提到（首批：' + cover.slice(0, 3).map((s) => s.trim().split(' ')[0]).join(', ') + '）');
  const pend = d.approvals.filter((a) => !a.consumed);
  if (pend.length) bad.push('  ' + pend.length + ' 条审批尚未落实（编辑完成后运行 sync 重钉）');
  if (!quiet) console.log('docflow check：只读规则 ' + readonlyGlobs(d).length + ' 条 / 钉 ' + Object.keys(d.pins).length + ' 个 / 审批 ' + d.approvals.length + ' 条 / 联动 ' + (d.cochange || []).length + ' 对' + (BASE ? ' / 基线 ' + BASE.slice(0, 7) : ''));
  if (bad.length) console.log(bad.join('\n'));
  return bad.length;
}
function runReport() {
  const d = load();
  const md = listMd().sort();
  const ro = md.filter((f) => isReadonly(d, f));
  const ed = md.filter((f) => !isReadonly(d, f));
  console.log('md 总数 ' + md.length + '｜只读 ' + ro.length + '｜可编辑 ' + ed.length);
  console.log('\n只读（改 / 新建 / 删除都需 owner 许可）：');
  for (const f of ro) console.log('  ' + (f in d.pins ? (hash(f) === d.pins[f] ? '✓ 已钉' : '✗ 漂移') : '· 未登记') + '  ' + f);
  console.log('\n可编辑 ' + ed.length + ' 篇（控制层与过程记录必须可写）：' + ed.slice(0, 24).join(', ') + (ed.length > 24 ? ' …' : ''));
  const us = Object.entries(d.units || {});
  if (us.length) {
    console.log('\n单元级功能权限（哈希只覆盖受保护列）：');
    for (const [f, s] of us) console.log('  ' + f + '  行匹配 ' + s.match + '  受保护列 [' + (s.pinned || []).join(',') + ']｜新增 ' + (s.allowNew ? '允许' : '需许可') + '｜删除 ' + (s.allowDelete ? '允许' : '需许可') + '｜已钉单元 ' + Object.keys(d.unitPins[f] || {}).length);
    const ap = d.anchorPins || {};
    console.log('  锚点内容指纹：' + Object.keys(ap).length + ' 篇 / ' + Object.values(ap).reduce((a, v) => a + Object.keys(v).length, 0) + ' 处（按 `目标:行号` 对位；只查 documents 与根文档，不含 progress 与 skills）');
    console.log('  — 控制层（TODO/OWNER）算裸写法 `路径:行号`，其余算反引号写法');
    console.log((d.binds || []).length ? '\n强绑定：' + d.binds.map((b) => b.if + ' ⇒ ' + b.then.join(' , ')).join('；') : '\n强绑定：未配置（内核已就绪，配对策略待定）');
  }
  const rb = d.rebaselines || [];
  if (rb.length) { console.log('\n重钉留痕（最近 ' + Math.min(rb.length, 3) + '/' + rb.length + ' 条）：'); for (const r of rb.slice(0, 3)) console.log('  ' + r.at.slice(0, 10) + '  ' + r.path + '  变 ' + r.changed + ' / 共 ' + r.total + '  —— ' + r.reason); }
  const cand = (d.policy && d.policy.candidates) || CANDIDATES;
  if (cand.length) { console.log('\n候选提升为只读（需先解决「每次提交都要改它」）：'); for (const [p, why] of cand) console.log('  ' + p + ' —— ' + why); }
  if (d.claim) console.log('\n当前认领：' + d.claim.task + '（may ' + d.claim.may.length + ' / must ' + d.claim.must.length + '，' + d.claim.at + '）');
}
function runApprove() {
  const d = load();
  const f = opt('path');
  if (!f) throw new Error('用法：approve --path <文件> --by <谁> --reason <为什么> [--task T-###]');
  if (!isReadonly(d, f) && !(f in d.pins) && !((d.units || {})[f])) throw new Error(f + ' 既不是只读类文件，也没有单元规格；无需审批');
  const a = { path: f, by: opt('by', 'unknown'), reason: opt('reason', ''), at: new Date().toISOString().slice(0, 10), task: opt('task', ''), consumed: false };
  d.approvals = d.approvals.filter((x) => x.path !== f).concat([a]);
  save(d);
  console.log('已登记许可：' + f + '（by ' + a.by + (a.task ? ' / ' + a.task : '') + '）⇒ 改完运行：node src/scripts/docflow.mjs sync');
}
function runSync() {
  const d = load();
  const by = opt('by', 'agent');
  const reason = opt('reason', '');
  const named = optAll('path').flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  for (const p of named) if (isReadonly(d, p) && !permitFor(d, p)) throw new Error(p + ' 属只读类：重钉前须先 owner `approve --path ' + p + '`（--path 不能替代许可）');
  const pend = d.approvals.filter((a) => !a.consumed);
  const targets = new Set(named.concat(pend.map((a) => a.path)));
  if (flag('all')) for (const f of anchorDocs()) targets.add(f);
  const plan = anchorPlan(d, targets);
  const dirty = plan.filter((p) => !p.fresh && p.diff > 0);
  const unexplained = dirty.filter((p) => !permitFor(d, p.path) && !reason);
  if (unexplained.length) {
    console.log('锚点有实际变化，但既没有对应审批、也没给 --reason —— 拒绝重钉（重钉＝声明「这些断言我已复核」）：');
    for (const p of unexplained.slice(0, 12)) console.log('  ' + p.path + '  变化 ' + p.diff + ' 处 / 共 ' + p.total + ' 处');
    if (unexplained.length > 12) console.log('  … 另有 ' + (unexplained.length - 12) + ' 篇');
    throw new Error('用法：node src/scripts/docflow.mjs sync --path <篇> --reason <为什么可以重钉>');
  }
  refreshUnits(d);
  d.anchorPins = d.anchorPins || {};
  d.rebaselines = d.rebaselines || [];
  let pinned = 0, rebased = 0;
  for (const p of plan) {
    d.anchorPins[p.path] = p.map;
    pinned += p.total;
    if (!p.fresh && p.diff > 0) {
      rebased++;
      d.rebaselines.unshift({ path: p.path, at: new Date().toISOString(), by, reason: (permitFor(d, p.path) || {}).reason || reason, changed: p.diff, total: p.total });
    }
  }
  d.rebaselines = d.rebaselines.slice(0, 40);
  for (const a of pend) {
    // 有单元规格的文件走 refreshUnits（字段级权限）；这里**只**给只读类文件建整篇钉，
    // 否则一个 approve 会把控制层文件整篇变只读，字段级权限就被盖住。
    if (!isReadonly(d, a.path) && !(a.path in d.pins)) { a.consumed = true; continue; }
    const h = hash(a.path);
    if (h) { d.pins[a.path] = h; console.log('  重钉 ' + a.path + ' → ' + h.slice(0, 12) + '…'); }
    else { delete d.pins[a.path]; console.log('  移除钉（文件已删）：' + a.path); }
    a.consumed = true;
  }
  save(d);
  console.log('锚点：重钉 ' + plan.length + ' 篇 / ' + pinned + ' 处' + (rebased ? '（其中 ' + rebased + ' 篇内容有变化，已留痕）' : '（无内容变化）'));
  console.log(pend.length ? '已落实审批 ' + pend.length + ' 条。' : '无待落实的审批。');
}
function runClaim() {
  const d = load();
  const task = opt('task');
  const may = optAll('may').flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  if (!task || !may.length) throw new Error('用法：claim --task T-### --may <文件或 glob,...> [--must <...>]');
  const must = optAll('must').flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  if (d.claim && !flag('force')) throw new Error('已有认领 ' + d.claim.task + '（一次只做一条；换任务先 release）');
  const base = {};
  for (const f of [...may, ...must]) { const h = hash(f); if (h) base[f] = h; }
  d.claim = { task, may, must, base, at: new Date().toISOString(), pins: { ...d.pins } };
  save(d);
  console.log('已认领 ' + task + '：may ' + may.length + ' / must ' + must.length + '；结束时运行：node src/scripts/docflow.mjs verify');
}
function runVerify() {
  const d = load();
  const c = d.claim;
  if (!c) { console.log('当前无认领'); return 0; }
  const bad = [];
  for (const f of c.must) if (hash(f) === (c.base[f] ?? null)) bad.push('  must 未改动：' + f);
  const mayRe = c.may.map((g) => globToRe(g));
  const mustSet = new Set(c.must);
  for (const f of changed()) {
    if (mustSet.has(f) || mayRe.some((r) => r.test(f)) || autoOk(f)) continue;
    bad.push('  越界改动（不在 may/must，也不是收尾必动）：' + f);
  }
  bad.push(...checkReadonly(d));
  console.log('verify ' + c.task + '：must ' + c.must.length + ' / may ' + c.may.length + ' ⇒ ' + (bad.length ? '不满足' : '满足'));
  if (bad.length) console.log(bad.join('\n'));
  return bad.length ? 1 : 0;
}
let code = 0;
if (cmd === 'report') runReport();
else if (cmd === 'check') {
  // 基础设施故障（EBUSY / git 不可用）≠ 契约违规：重试后仍失败则降级 WARN，且必须自报「未完成」。
  try { code = runCheck(flag('quiet')) ? 1 : 0; }
  catch (e) { console.log('  [WARN] git 不可用（' + String((e && e.message) || e).slice(0, 120) + '）⇒ 本次文档契约检查未完成'); code = 0; }
}
else if (cmd === 'approve') runApprove();
else if (cmd === 'sync') runSync();
else if (cmd === 'claim') runClaim();
else if (cmd === 'verify') code = runVerify();
else if (cmd === 'release') { const d = load(); d.claim = null; save(d); console.log('已释放认领'); }
else { console.error('未知子命令：' + cmd + '（report|check|approve|sync|claim|verify|release）'); code = 2; }
process.exit(code);
