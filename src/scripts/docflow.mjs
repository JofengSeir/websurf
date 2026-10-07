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
 *   可编辑：TODO.md、OWNER.md、CHANGELOG.md、documents 其余各篇、progress、skills 其余
 *        —— 控制层与过程记录**必须**能被 agent 写（§0.1 状态流转、§0.3 决策登记、§0.2 收尾）。
 *
 * 哈希口径：文件内容按 LF 归一后取 sha256。与体检 [F] 的「提交形态」一致——仓库
 * core.autocrlf=true，工作树的 CRLF 只是检出产物，不算改动。
 *
 * 新增与删除同样受管：只读类的**新文件**（无钉）与**消失的钉**都算违规，须先 approve。
 *
 * 子命令（退出码：check / verify 有违规 → 1）：
 *   report                                       打印划分与锁状态（给人看）
 *   check [--quiet]                              只读漂移 / 未落实审批 / 联动缺失（体检 [O] 同口径）
 *   approve --path P --by W --reason R [--task T-###]   登记一次「临时可动」许可
 *   sync                                         落实许可：重钉只读哈希并消耗许可
 *   claim --task T-### --may A,B [--must C,D]    认领：写任务变更契约（同一时刻只允许一条）
 *   verify                                       用认领校验结束条件（must 未改 / 越界改动 / 只读漂移）
 *   release                                      释放认领
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
const STD = ['TODO.md', 'OWNER.md', 'CHANGELOG.md', 'docflow.json'];
/** 默认只读集：宪法层里**不随提交滚动**的那些。 */
const DEFAULT_READONLY = ['AGENTS.md', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'documents/norms/**', '.github/**/*.md', 'skills/**/SKILL.md'];
/** 候选提升为只读、但需先解决「每提交都要改它」的文件（report 会提示）。 */
const CANDIDATES = [
  ['TODO.md', '唯一状态源，agent 每次认领/结案都要改 ⇒ 只锁「新建/删除」而非「改行」才有意义'],
  ['OWNER.md', '§0.3 规定 agent 要写 D-### 决策行 ⇒ 同上'],
];
const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'report';
/** 取 `--name value`（可重复）。 */
const optAll = (name) => argv.flatMap((a, i) => (a === '--' + name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
const opt = (name, dflt) => (optAll(name).length ? optAll(name)[optAll(name).length - 1] : dflt);
const flag = (name) => argv.includes('--' + name);
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
const load = () => (fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, 'utf8')) : { version: 1, policy: { readonly: DEFAULT_READONLY, candidates: CANDIDATES }, pins: {}, unitPins: {}, units: {}, binds: [], approvals: [], cochange: [], claim: null });
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
function listMd() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md'], { cwd: ROOT, maxBuffer: 64e6 }).toString('utf8').split('\u0000').filter(Boolean);
  return [...new Set(out)].filter((f) => fs.existsSync(path.join(ROOT, f)));
}
/** 相对 HEAD 的改动面（含未跟踪）。 */
function changed() {
  return new Set(execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => l.slice(3).trim()));
}
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
/** HEAD 版本的同一文件（强绑定基线）。 */
function headText(f) {
  try { return execFileSync('git', ['show', 'HEAD:' + f.split(path.sep).join('/')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32e6 }); } catch { return ''; }
}
const unitsOfText = (d, f, text) => extractUnits(text, d.units[f]);
const unitsOfFile = (d, f) => unitsOfText(d, f, fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), 'utf8') : '');
/** 权限：受保护列不得改、行集合不得增删（除非该文件拿到许可）。 */
function checkUnits(d) {
  const bad = [];
  for (const [f, spec] of Object.entries(d.units || {})) {
    const cur = unitsOfFile(d, f);
    const pins = d.unitPins[f] || {};
    const permit = permitFor(d, f);
    for (const [id, want] of Object.entries(pins)) {
      const u = cur.get(id);
      if (!u) { if (!spec.allowDelete && !permit) bad.push('  ' + f + ' 单元 ' + id + ' 被删除（本文件不许删行；须先 approve）'); continue; }
      if (protFp(u, spec) !== want.p && !permit) bad.push('  ' + f + ' 单元 ' + id + ' 的受保护列被改（列 ' + (spec.pinned || []).join(',') + '；须先 approve）');
    }
    for (const id of cur.keys()) if (!(id in pins) && !spec.allowNew && !permit) bad.push('  ' + f + ' 新增单元 ' + id + '（本文件不许 agent 新增行；须先 approve）');
  }
  return bad;
}
/** 强绑定：单元变了 ⇒ 配对单元必须也变（比工作树与 HEAD）。`#*` = 整篇任一单元。 */
function checkBinds(d) {
  const bad = [];
  const changedIn = (f, id) => {
    const cur = unitsOfFile(d, f), head = unitsOfText(d, f, headText(f));
    if (id === '*') return [...cur.keys()].some((k) => !head.has(k) || fullFp(cur.get(k)) !== fullFp(head.get(k)));
    if (cur.has(id) !== head.has(id)) return true;
    return cur.has(id) && fullFp(cur.get(id)) !== fullFp(head.get(id));
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
/** 重钉单元（sync 调用；受保护列变了要求有许可）。 */
function refreshUnits(d) {
  for (const [f, spec] of Object.entries(d.units || {})) {
    const cur = unitsOfFile(d, f);
    const prev = d.unitPins[f] || {};
    const keep = {};
    for (const [id, u] of cur) {
      const p = protFp(u, spec);
      if (prev[id] && prev[id].p !== p && !permitFor(d, f)) { keep[id] = prev[id]; continue; }
      keep[id] = { p, at: new Date().toISOString().slice(0, 10), line: u.line };
    }
    for (const [id, v] of Object.entries(prev)) if (!cur.has(id) && !spec.allowDelete && !permitFor(d, f)) keep[id] = v;
    d.unitPins[f] = keep;
  }
}

/** 只读漂移：钉住的对不上、有钉的文件消失、只读类新文件未登记。 */
function checkReadonly(d) {
  const bad = [];
  const md = new Set(listMd());
  for (const [f, h] of Object.entries(d.pins)) {
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
  const bad = [...checkReadonly(d), ...checkCochange(d), ...checkUnits(d), ...checkBinds(d)];
  const pend = d.approvals.filter((a) => !a.consumed);
  if (pend.length) bad.push('  ' + pend.length + ' 条审批尚未落实（编辑完成后运行 sync 重钉）');
  if (!quiet) console.log('docflow check：只读规则 ' + readonlyGlobs(d).length + ' 条 / 钉 ' + Object.keys(d.pins).length + ' 个 / 审批 ' + d.approvals.length + ' 条 / 联动 ' + (d.cochange || []).length + ' 对');
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
    console.log((d.binds || []).length ? '\n强绑定：' + d.binds.map((b) => b.if + ' ⇒ ' + b.then.join(' , ')).join('；') : '\n强绑定：未配置（内核已就绪，配对策略待定）');
  }
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
  const pend = d.approvals.filter((a) => !a.consumed);
  if (!pend.length) { console.log('无待落实的审批'); return; }
  refreshUnits(d);
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
else if (cmd === 'check') code = runCheck(flag('quiet')) ? 1 : 0;
else if (cmd === 'approve') runApprove();
else if (cmd === 'sync') runSync();
else if (cmd === 'claim') runClaim();
else if (cmd === 'verify') code = runVerify();
else if (cmd === 'release') { const d = load(); d.claim = null; save(d); console.log('已释放认领'); }
else { console.error('未知子命令：' + cmd + '（report|check|approve|sync|claim|verify|release）'); code = 2; }
process.exit(code);
