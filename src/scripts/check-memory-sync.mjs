#!/usr/bin/env node
/**
 * 记忆库同步体检（memory-index 台账 ↔ 磁盘）——对应 AGENTS §5 的门禁之一。
 *
 * 解决的问题：agentmemory 里的条目是 md 的**派生线索**，源文件一旦改动，条目就陈旧，
 * 但记忆库自身查不出来（§2：分数与命中数都不能判存在性，也没有 entry 级版本）。
 * 所以把「哪条记忆对应哪个源的哪个哈希」留在**仓库侧台账** `progress/memory-index.jsonl`，
 * 由本工具离线核对。台账是 append-only 的权威记录，记忆库只作检索面。
 *
 * 三段检查（只依赖 git + fs，不连记忆库）：
 *   stale   台账 marker 里的 sha12 与磁盘源文件不符 ⇒ 源变了、条目陈旧
 *   orphan  台账有、磁盘无：未标 `retired` 计 orphan（真丢源），标了计 retired（有意迁出）
 *   missing 迁出范围内的 md 在台账里没有 source 记录 ⇒ 漏迁
 *   leak    台账里出现排除前缀的 source（`.cargo-home` / `node_modules` / `test/project`）⇒ 越界入库
 *   arch    源已迁出仓库：原文与 `.meta.json` 落在 `archive/memory/`；此处核对**归档原文的 sha12 是否仍与 marker 一致**
 *           （`retired` 的计数含义即「源已归档」，与「这条知识作废」无关——两者语义不同，见 AUDIT.md）
 *   xproj   marker 的项目前缀不是本项目 ⇒ **跨项目串台**（agentmemory 单实例共享库，无自动隔离）
 *
 * 口径：哈希两套并用以兼容检出形态——`sha256(raw)` 或 `sha256(LF 归一 + 去 BOM)`，
 * 与 `docflow.json:pins` 的 LF 归一口径同源（**不另造第三套**）。
 *
 * 用法（退出码：有违规 → 1）：
 *   node src/scripts/check-memory-sync.mjs            完整检查
 *   node src/scripts/check-memory-sync.mjs --keys     只打印 marker/entry 计数（V7）
 *   node src/scripts/check-memory-sync.mjs --rerun    与上次状态比对，报 new_writes（V2）
 *   node src/scripts/check-memory-sync.mjs --list     逐条打印违规明细
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = path.join(ROOT, 'progress/memory-index.jsonl');
const STATE = path.join(ROOT, '.tmp/md-migrate/memory-sync-state.json');
const PROJECT = 'websurf';
/** 迁移范围的保留项：不参与 missing 判定（见任务书 §四 与 AGENTS §0.1 第 6 条）。 */
/** 迁出范围根：这些根下的 md 必须在台账里有记录（KEEP 除外）。 */
const SCOPE_ROOTS = ['progress/'];
/** 归档区：源迁出后原文与 `.meta.json` 落在 archive/memory/<yyyy-MM>/<原路径>。 */
const ARCHIVE = path.join(ROOT, 'archive/memory');
const KEEP = [
  // 当前为空：progress/** 与 documents/** 的 md 已全部迁出，仓库只剩非 md 的台账与 ID 索引。
  // 将来若重新引入流程性 md，把不该入记忆库的路径（规则/控制层）登记在这里。
];
/** 绝不允许进台账的路径前缀（任务书 §七 leak 段）。 */
const EX = ['.cargo-home', 'node_modules', 'test/project'];

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
if (flag('documents')) SCOPE_ROOTS.push('documents/');

const sha12 = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
/** 两套并用的哈希前缀：raw 与 LF 归一 + 去 BOM。 */
function hash12s(abs) {
  const raw = fs.readFileSync(abs);
  let txt = raw.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return new Set([sha12(raw), sha12(Buffer.from(txt, 'utf8'))]);
}
/** 进展直接写 agentmemory：仓库既无进度卷、也无导航文件，「当前写入目标」机制已不存在。 */
function writeTarget() {
  return null;
}
const inScope = (rel) => rel.endsWith('.md') && SCOPE_ROOTS.some((r) => rel.startsWith(r))
  && !KEEP.some((k) => rel.startsWith(k))
  && rel !== writeTarget()
  && !EX.some((e) => rel.startsWith(e));

// ===== 读台账 =====
const lines = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter((l) => l.trim()) : [];
const badJson = [];
const entries = [];
for (const [i, l] of lines.entries()) {
  try { entries.push(JSON.parse(l)); } catch { badJson.push('  ' + (i + 1) + ' 行不是合法 JSON'); }
}
const MARKER_RE = new RegExp('^([a-z0-9_-]+)/([^#]+)#([a-z]+)(\\d+)@([0-9a-f]{12})$');

/** 归档索引：source -> { abs, exists }；`.meta.json` 与原路径同目录同名加后缀。 */
function buildArchiveIndex() {
  const idx = new Map();
  if (!fs.existsSync(ARCHIVE)) return idx;
  const stack = [ARCHIVE];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.name.endsWith('.meta.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const src = p.replace(/\.meta\.json$/, '');
        idx.set(String(j.source), { abs: src, exists: fs.existsSync(src) });
      } catch { /* 坏 meta 由外部核对，不在本门禁职责内 */ }
    }
  }
  return idx;
}
/** 文件系统枚举（不再依赖 git：治理层已移出跟踪，git 视野里没有它们）。 */
function walkMd(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', '.git', 'target', 'pkg', 'dist', '__pycache__'].includes(e.name)) walkMd(p, out); }
    else if (e.name.endsWith('.md')) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
  }
  return out;
}
const archive = buildArchiveIndex();

// ===== 检查 =====
const stale = [], orphan = [], leak = [], xproj = [], dup = [], archMismatch = [];
const seen = new Set();
const sources = new Set();
let retired = 0;
  let archiveAbsent = 0;   // 本机没有归档区（全新克隆）时，原文不在本机 ⇒ 不计 orphan
for (const e of entries) {
  const m = MARKER_RE.exec(String(e.marker || ''));
  if (!m) { leak.push('  marker 形状不合法：' + e.marker); continue; }
  if (seen.has(e.marker)) dup.push('  marker 重复：' + e.marker);
  seen.add(e.marker);
  const [, proj, rel, , , mk12] = m;
  if (proj !== PROJECT) { xproj.push('  marker 项目前缀不是 ' + PROJECT + '：' + e.marker); continue; }
  if (e.source !== rel) leak.push('  marker 与 source 不一致：' + e.marker + ' vs ' + e.source);
  if (EX.some((x) => rel.startsWith(x))) leak.push('  排除前缀泄漏：' + rel);
  sources.add(rel);
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    if (!fs.existsSync(ARCHIVE)) { archiveAbsent++; continue; }
    const a = archive.get(rel);
    if (!a) { orphan.push('  ' + rel + '（台账有，但仓库与 archive/ 都无）'); continue; }
    if (!a.exists) { orphan.push('  ' + rel + '（归档 .meta.json 在、原文缺）'); continue; }
    if (e.retired !== true) { orphan.push('  ' + rel + '（源已迁出）但台账未标 retired'); continue; }
    retired++;
    const okA = hash12s(a.abs);
    if (!okA.has(mk12)) archMismatch.push('  ' + rel + '#' + (e.kind || '') + (e.seq ?? '') + ' 台账 ' + mk12 + ' / 归档 ' + [...okA][0]);
    continue;
  }
  const ok = hash12s(abs);
  if (!ok.has(mk12)) stale.push('  ' + rel + '#' + (e.kind || '') + (e.seq ?? '') + ' 台账 ' + mk12 + ' / 磁盘 ' + [...ok][0]);
}

// missing：迁出范围内、磁盘上有、台账里没有 source 记录的 md（**文件系统枚举**，不依赖 git）
const scope = SCOPE_ROOTS.reduce((a, r) => a.concat(walkMd(path.join(ROOT, r))), []).filter(inScope);
const missing = scope.filter((f) => !sources.has(f)).map((f) => '  ' + f).sort();

/** 唯一违规判据：主检查与 --rerun 共用，避免两处口径分叉。 */
const bad = (t) => Boolean(t.stale || t.orphan || t.missing || t.leak || t.xproj || t.dup || t.badJson || t.archMismatch);
const sum = {
  entries: entries.length, markers: seen.size, sources: sources.size, scope: scope.length,
  stale: stale.length, orphan: orphan.length, archive_absent: archiveAbsent, retired, missing: missing.length,
  leak: leak.length, xproj: xproj.length, dup: dup.length, badJson: badJson.length, archMismatch: archMismatch.length,
};
const line = `entries=${sum.entries} markers=${sum.markers} sources=${sum.sources} scope=${sum.scope} ` +
  `scope_roots=${SCOPE_ROOTS.map((r) => r.replace('/', '')).join('+')} ` +
  `stale=${sum.stale} orphan=${sum.orphan} archive_absent=${sum.archive_absent} archived=${sum.retired} archive_mismatch=${sum.archMismatch} ` +
  `missing=${sum.missing} leak=${sum.leak} cross_project_leak=${sum.xproj} dup=${sum.dup}`;

if (flag('keys')) { console.log(`markers=${sum.markers} entries=${sum.entries}`); process.exit(sum.markers === sum.entries && !sum.badJson ? 0 : 1); }

if (flag('rerun')) {
  const prev = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
  const now = [...seen].sort();
  const prevSet = new Set(prev ? prev.markers : []);
  const newWrites = now.filter((x) => !prevSet.has(x)).length;
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ at: new Date().toISOString(), markers: now }, null, 1));
  const bytewiseSame = prev ? JSON.stringify(prev.markers) === JSON.stringify(now) : false;
  console.log(`entries=${sum.entries} markers=${sum.markers} new_writes=${newWrites} entries_identical=${bytewiseSame}`);
  process.exit(bad(sum) ? 1 : 0);
}

console.log('记忆库同步体检：' + line);
const detail = (title, arr) => { if (arr.length) console.log('\n[' + title + ']（' + arr.length + '）：\n' + (flag('list') ? arr.join('\n') : arr.slice(0, 10).join('\n') + (arr.length > 10 ? `\n  … 另 ${arr.length - 10} 条（--list 看全）` : ''))); };
detail('stale', stale); detail('orphan', orphan); detail('archive_mismatch', archMismatch); detail('missing', missing); detail('leak', leak); detail('cross_project_leak', xproj); detail('dup', dup); detail('badJson', badJson);
if (bad(sum)) {
  console.log('\n  —— stale：源变了 ⇒ 重迁该 marker；orphan：源没归档好 ⇒ 先备份再标 retired；archive_mismatch：归档原文与 marker 不符 ⇒ 条目已陈旧；missing：范围内漏迁；leak：不该入库的进了台账');
}
process.exit(bad(sum) ? 1 : 0);
