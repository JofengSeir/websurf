#!/usr/bin/env node
/**
 * 闸 B（库侧批量迁移闸）：新增台账行必须先过这里的校验。
 *
 * 与 `check-memory-sync.mjs` 的分工：
 *   check-memory-sync.mjs  —— **仓侧**（只依赖 git + fs）：marker 形状/唯一、stale（双哈希）、
 *                              orphan/retired、leak/xproj、missing。
 *   本脚本                 —— **库侧**（连记忆库，补它判不了的四条）：
 *                              ① 分档大小：chunk/errata ≤ 8 KiB；index > 16 KiB 需分片或显式豁免
 *                              ② 悬空 supersedes：新条目的 supersedes 必须都还存在
 *                              ③ 头部规范：首行 [线索] + 主题 + 摘要
 *                              ④ 重迁必须 supersede：同 source#kind<seq> 换 sha12 再迁时，
 *                                 新条目必须 supersede 掉旧行的 memoryId（禁「先删后写」）
 *
 * **历史冻结件豁免（T-729，owner 2026-10-17 批准口径）**：迁移初期那一批（2026-10-10 前后批量入库的
 * `snapshot`）里存在与现行口径不符的段 —— 它们**已经冻结**（原文与 sha12 都不再变），补链无对象
 * （旧 id 早已被重迁删除）、重切段等于改写历史且会再产生版本链。故台账行可以带一个**明面上的**豁免标记
 * `audit_exempt`（值 = 理由，写清批次与日期）：
 *   · `--all`（存量审计）：**只**把「口径类」违规（体积三条 + `dangling-supersedes` +
 *     `re-migration-without-supersede`）转成 `exempt`，计入 `exempt_rows` / `exempt_by_rule`
 *     **单列展示**、不计入 `blocking_rows`；**结构类**（marker 形状/重复、条目不在库、头部规范、
 *     sha12 与磁盘不符、源缺失未标 retired…）照旧硬查 —— 冻结件不许成为结构问题的藏身处。
 *   · `--row-file` / `--new`（**写入闸**）：**不认**这个标记 —— 新行自带 `audit_exempt` 直接报
 *     `exemption-not-allowed-for-new-rows`（豁免是给历史库存的一次性口径，不是写入后门）。
 *
 * 用法（退出码非 0 = 有阻塞项）：
 *   node src/scripts/check-kb-gate.mjs --all          存量审计（基线，不判失败）
 *   node src/scripts/check-kb-gate.mjs --new=<N>      只校验台账第 N 行之后的新增行（闸门模式）
 *   node src/scripts/check-kb-gate.mjs --selftest     规则自测（不读库不读盘）
 *   附加：--json=<路径> 落完整结果
 *
 * 口径与 check-memory-sync.mjs 对齐：marker 必须带项目前缀；sha12 用双哈希（raw 与「去 BOM + LF 归一」）；
 * 源缺失由台账 `retired` 决定容忍与否（未标 retired 的源缺失才是真 orphan）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = path.join(ROOT, 'progress/memory-index.jsonl');
const PROJECT = 'websurf';
const LIMITS = { chunk: 8192, errata: 8192, index: 16384 };
const HEADER_REQUIRED = ['主题：', '摘要：'];
const MARKER_RE = /^([a-z0-9_-]+)\/([^#]+)#([a-z]+)(\d+)@([0-9a-f]{12})$/;

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : (d === undefined ? '' : d); };
const has = (k) => process.argv.some((a) => a === '--' + k || a.startsWith('--' + k + '='));
const valOf = (k) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : null; };

const sha12sOf = (buf) => new Set([
  crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12),
  crypto.createHash('sha256').update(Buffer.from(buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), 'utf8')).digest('hex').slice(0, 12),
]);
const LINENO = /[\w\-./]+\.(?:mjs|js|ts|tsx|rs|md|json|yml|yaml|cmd):\d+/;
/**
 * 「口径类」违规 —— 只有这些允许被历史冻结件（台账行 `audit_exempt`）在 `--all` 里豁免。
 * 它们是「现行口径不追溯冻结件」的三类：分档体积、悬空 supersedes、重迁未 supersede。
 * 结构类（marker 形状/重复、条目不在库、头部规范、sha12 不符、源缺失未标 retired）**永不豁免**。
 */
const EXEMPT_RULES = new Set([
  'over-8KiB-chunk',
  'over-8KiB-errata',
  'index-over-16KiB-needs-shard-or-exemption',
  'dangling-supersedes',
  're-migration-without-supersede',
]);

/** 单行校验。ctx: { byId, ledgerMarkerCount, libLatestMarkerCount, sourceSha12s, deletedAt, prevByKey, allowIndexExempt, mode } */
function checkRow(row, ctx) {
  const errs = [];
  const warns = [];
  const exempt = [];
  const marker = String(row.marker ?? '');
  const m = MARKER_RE.exec(marker);
  if (!m) { errs.push({ rule: 'marker-shape', detail: marker }); return { errs, warns, exempt, marker, kind: null, bytes: null }; }
  const [, proj, rel, kind, , sha12] = m;
  const source = String(row.source ?? rel);
  if (proj !== PROJECT) errs.push({ rule: 'cross-project-marker', detail: proj + ' ≠ ' + PROJECT });
  if (row.source !== undefined && row.source !== rel) errs.push({ rule: 'marker-source-mismatch', detail: rel + ' vs ' + row.source });

  if ((ctx.ledgerMarkerCount.get(marker) ?? 0) > 1) errs.push({ rule: 'marker-duplicate-in-ledger', detail: marker });
  if ((ctx.libLatestMarkerCount.get(marker) ?? 0) > 1) errs.push({ rule: 'marker-multiple-latest', detail: marker });

  const rec = ctx.byId.get(row.memoryId);
  let bytes = null;
  if (!rec) {
    errs.push({ rule: 'memory-not-in-library', detail: String(row.memoryId) });
  } else {
    const content = String(rec.content ?? '');
    bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > LIMITS[kind]) {
      if (kind === 'index' && (row.index_exempt === true || ctx.allowIndexExempt)) warns.push({ rule: 'index-over-16KiB-exempted', detail: bytes + ' B' });
      else if (kind === 'index') errs.push({ rule: 'index-over-16KiB-needs-shard-or-exemption', detail: bytes + ' B' });
      else errs.push({ rule: 'over-8KiB-' + kind, detail: bytes + ' B' });
    }
    if (!content.startsWith('[线索]')) errs.push({ rule: 'header-first-line-not-marker', detail: content.split('\n')[0].slice(0, 60) });
    for (const k of HEADER_REQUIRED) if (!content.includes(k)) errs.push({ rule: 'header-missing-' + k.replace('：', '') });
    // P1-6：compact 只给 title ⇒ 新条目的 title 不应停留在 "content 前 80 字"（那样 marker 就吃满了）
    if (String(rec.title ?? '') === content.slice(0, 80)) {
      warns.push({ rule: 'title-not-semantic', detail: 'title 仍是 content 前 80 字；建议 memory_evolve(newTitle=…) 设为「<proj> · <kind><seq> · <主题> · <摘要>」' });
    }
    // P0-4 判别器：errata / 无源路径 = 交互式结论条目 ⇒ 按"禁 文件:行号"给出**具名**提示
    const lineNoHits = content.match(LINENO);
    if (lineNoHits) {
      if (kind === 'errata' || !kind) warns.push({ rule: 'interactive-entry-with-file-lineno', detail: lineNoHits.length + ' 处：结论型条目应改符号名（P0-4）' });
      else warns.push({ rule: 'batch-entry-with-file-lineno', detail: lineNoHits.length + ' 处：批量产物固有行号，靠 sha12 检测过期（P0-4）' });
    }
    for (const s of rec.supersedes ?? []) if (!ctx.byId.has(s)) errs.push({ rule: 'dangling-supersedes', detail: marker + ' → ' + s });
  }

  const disk = ctx.sourceSha12s(source);
  if (disk === null) {
    if (row.retired === true) {
      const del = ctx.deletedAt.get(source);
      warns.push({ rule: 'source-retired', detail: del ? source + ' ← ' + del.sha.slice(0, 8) : source });
    } else errs.push({ rule: 'source-missing-not-retired', detail: source });
  } else if (!disk.has(sha12)) errs.push({ rule: 'sha12-mismatch', detail: sha12 + ' vs ' + [...disk].join('/') });

  const prev = ctx.prevByKey.get(source + '#' + kind + m[4]);
  if (prev && prev.sha12 !== sha12 && !(rec?.supersedes ?? []).includes(prev.memoryId)) {
    errs.push({ rule: 're-migration-without-supersede', detail: source + '#' + kind + m[4] + '：旧 ' + prev.memoryId + ' 未被 supersede' });
  }

  // 历史冻结件豁免（T-729）：台账行上的 `audit_exempt`（值 = 理由）只在存量审计里生效，
  // 且只把 EXEMPT_RULES 那几条转成 `exempt`；写入闸一律拒绝这个标记（不许新行自带豁免）。
  const reason = typeof row.audit_exempt === 'string' ? row.audit_exempt.trim() : '';
  if (reason) {
    if (ctx.mode === 'all') {
      for (let i = errs.length - 1; i >= 0; i--) if (EXEMPT_RULES.has(errs[i].rule)) exempt.unshift(...errs.splice(i, 1));
      if (exempt.length === 0) warns.push({ rule: 'audit-exempt-unused', detail: reason.slice(0, 60) });
    } else {
      errs.push({ rule: 'exemption-not-allowed-for-new-rows', detail: reason.slice(0, 60) });
    }
  }
  return { errs, warns, exempt, marker, kind, bytes };
}

function selftest() {
  const okContent = (marker) => ['[线索] websurf/' + marker, '主题：t', '路径：p', '小节：', '  正', '摘要：s', '---', 'body'].join('\n');
  const base = () => ({
    byId: new Map(), ledgerMarkerCount: new Map(), libLatestMarkerCount: new Map(),
    sourceSha12s: () => new Set(['aaaaaaaaaaaa']), deletedAt: new Map(), prevByKey: new Map(), allowIndexExempt: false,
    mode: 'all',
  });
  const cases = [];
  const mk = (name, row, mutate, expect) => {
    const ctx = base();
    ctx.byId.set(row.memoryId, { id: row.memoryId, content: okContent(row.marker.replace(/^[^/]+\//, '')), supersedes: [] });
    ctx.ledgerMarkerCount.set(row.marker, 1);
    ctx.libLatestMarkerCount.set(row.marker, 1);
    mutate?.(ctx, row);
    const r = checkRow(row, ctx);
    cases.push({ name, expect: expect ?? '(无错误)', got: r.errs.map((e) => e.rule), pass: expect === null ? r.errs.length === 0 : r.errs.some((e) => e.rule === expect) });
  };
  const R = () => ({ marker: 'websurf/progress/notes/x.md#chunk0@aaaaaaaaaaaa', source: 'progress/notes/x.md', memoryId: 'mem_ok' });
  mk('基准行应当通过', R(), null, null);
  mk('marker 形状非法', { ...R(), marker: 'nope' }, null, 'marker-shape');
  mk('台账内重复 marker', R(), (c) => c.ledgerMarkerCount.set(R().marker, 2), 'marker-duplicate-in-ledger');
  mk('latest 内重复 marker', R(), (c) => c.libLatestMarkerCount.set(R().marker, 2), 'marker-multiple-latest');
  mk('条目不在库内', R(), (c) => c.byId.clear(), 'memory-not-in-library');
  mk('chunk 超 8 KiB', R(), (c) => c.byId.set('mem_ok', { id: 'mem_ok', content: '[线索] x\n主题：t\n摘要：s\n' + '字'.repeat(4000), supersedes: [] }), 'over-8KiB-chunk');
  mk('index 超 16 KiB 未豁免', { ...R(), marker: 'websurf/a/b.md#index0@aaaaaaaaaaaa', source: 'a/b.md', memoryId: 'mem_i' }, (c) => {
    c.byId.clear();
    c.byId.set('mem_i', { id: 'mem_i', content: '[线索] x\n主题：t\n摘要：s\n' + '字'.repeat(6000), supersedes: [] });
    c.ledgerMarkerCount.set('websurf/a/b.md#index0@aaaaaaaaaaaa', 1);
    c.libLatestMarkerCount.set('websurf/a/b.md#index0@aaaaaaaaaaaa', 1);
  }, 'index-over-16KiB-needs-shard-or-exemption');
  mk('sha12 与磁盘不符', R(), (c) => { c.sourceSha12s = () => new Set(['bbbbbbbbbbbb']); }, 'sha12-mismatch');
  mk('源文件消失且未标 retired', R(), (c) => { c.sourceSha12s = () => null; }, 'source-missing-not-retired');
  mk('悬空 supersedes', R(), (c) => c.byId.set('mem_ok', { id: 'mem_ok', content: okContent('progress/notes/x.md#chunk0@aaaaaaaaaaaa'), supersedes: ['mem_gone'] }), 'dangling-supersedes');
  mk('重迁未 supersede', R(), (c) => c.prevByKey.set('progress/notes/x.md#chunk0', { sha12: 'cccccccccccc', memoryId: 'mem_old' }), 're-migration-without-supersede');
  mk('首行非 [线索]', R(), (c) => c.byId.set('mem_ok', { id: 'mem_ok', content: '正文\n主题：t\n摘要：s', supersedes: [] }), 'header-first-line-not-marker');
  mk('缺摘要', R(), (c) => c.byId.set('mem_ok', { id: 'mem_ok', content: '[线索] x\n主题：t\n', supersedes: [] }), 'header-missing-摘要');
  mk('跨项目 marker', { ...R(), marker: 'other/progress/notes/x.md#chunk0@aaaaaaaaaaaa' }, null, 'cross-project-marker');
  mk('marker 与 source 不一致', { ...R(), source: 'progress/notes/other.md' }, null, 'marker-source-mismatch');

  // ── 历史冻结件豁免（T-729）三条：豁免生效、写入闸不认、结构类不被豁免 ──
  const bigContent = '[线索] x\n主题：t\n摘要：s\n' + '字'.repeat(4000);
  {
    const row = { ...R(), audit_exempt: 'T-729 历史冻结件（迁移初期批量）' };
    const ctx = base();
    ctx.byId.set(row.memoryId, { id: row.memoryId, content: bigContent, supersedes: [] });
    ctx.ledgerMarkerCount.set(row.marker, 1); ctx.libLatestMarkerCount.set(row.marker, 1);
    const r = checkRow(row, ctx);
    cases.push({ name: '历史冻结件：--all 下体积违规转为 exempt、不计 blocking', expect: 'errs 0 + exempt 1', got: r.errs.map((e) => e.rule) + ' / exempt ' + (r.exempt ?? []).length, pass: r.errs.length === 0 && r.exempt.length === 1 });
  }
  {
    const row = { ...R(), audit_exempt: '想偷偷豁免' };
    const ctx = base(); ctx.mode = 'row';
    ctx.byId.set(row.memoryId, { id: row.memoryId, content: bigContent, supersedes: [] });
    ctx.ledgerMarkerCount.set(row.marker, 1); ctx.libLatestMarkerCount.set(row.marker, 1);
    const r = checkRow(row, ctx);
    cases.push({ name: '写入闸拒绝自带豁免的新行', expect: 'exemption-not-allowed-for-new-rows + over-8KiB-chunk', got: r.errs.map((e) => e.rule), pass: r.errs.some((e) => e.rule === 'exemption-not-allowed-for-new-rows') && r.errs.some((e) => e.rule === 'over-8KiB-chunk') && r.exempt.length === 0 });
  }
  {
    const row = { ...R(), marker: 'websurf/progress/notes/x.md#chunk0@aaaaaaaaaaaa', audit_exempt: 'T-729 历史冻结件（迁移初期批量）' };
    const ctx = base();
    ctx.byId.set(row.memoryId, { id: row.memoryId, content: '正文\n主题：t\n摘要：s', supersedes: ['mem_gone'] });
    ctx.ledgerMarkerCount.set(row.marker, 1); ctx.libLatestMarkerCount.set(row.marker, 1);
    const r = checkRow(row, ctx);
    cases.push({ name: '历史冻结件：结构类（首行非线索）与头部缺失不被豁免', expect: 'header-first-line-not-marker 仍在 errs', got: r.errs.map((e) => e.rule), pass: r.errs.some((e) => e.rule === 'header-first-line-not-marker') });
  }

  const pass = cases.every((c) => c.pass);
  console.log(JSON.stringify({ selftest: pass ? 'PASS' : 'FAIL', cases }, null, 2));
  process.exitCode = pass ? 0 : 1;
}

if (has('selftest')) { selftest(); } else { await main(); }

async function main() {
  const rowFile = valOf('row-file');
  const MODE = rowFile !== null ? 'row' : valOf('new') !== null ? 'new' : 'all';
  const FROM = MODE === 'new' ? Number(valOf('new')) : 0;

  const secretPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.agentmemory', 'secret');
  let secret = process.env.AGENTMEMORY_SECRET ? process.env.AGENTMEMORY_SECRET.trim() : null;
  if (!secret) { try { secret = fs.readFileSync(secretPath, 'utf8').trim(); } catch { /* 无密钥时靠 loopback 免鉴权 */ } }
  const H = secret ? { Authorization: 'Bearer ' + secret } : {};

  const libRes = await fetch('http://127.0.0.1:3111/agentmemory/memories?limit=1000', { headers: H }).catch(() => null);
  if (!libRes || !libRes.ok) {
    console.error('闸 B 需要记忆库（http://127.0.0.1:3111）。库不可达时**不得**放行批量写入 —— 请先起库再重跑。');
    process.exitCode = 2;
    return;
  }
  const all = ((await libRes.json()).memories) ?? [];
  const lat = all.filter((m) => m.isLatest);
  const byId = new Map(all.map((m) => [m.id, m]));
  // 只在 latest 范围内数 marker：版本演化（mem::evolve，改标题不改内容）会让同一 marker 有多个历史版本，
  // 那是合法版本链，不是重复。真正的违规是"同一 marker 有两条 latest"。
  const libLatestMarkerCount = new Map();
  for (const m of lat) {
    const mk = /\[线索\]\s*(\S+?)#([a-z]+\d+)@([0-9a-f]{12})/.exec(String(m.content ?? ''));
    if (mk) { const k = mk[1] + '#' + mk[2] + '@' + mk[3]; libLatestMarkerCount.set(k, (libLatestMarkerCount.get(k) ?? 0) + 1); }
  }

  const deletedAt = new Map();
  try {
    const p = spawnSync('git', ['log', '--all', '--diff-filter=D', '--name-only', '--pretty=format:\u0001%H|%ad|%s', '--date=short'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    let cur = null;
    for (const raw of String(p.stdout || '').split(/\r?\n/)) {
      if (raw.startsWith('\u0001')) { const [sha, date, ...rest] = raw.slice(1).split('|'); cur = { sha, date, subject: rest.join('|') }; }
      else if (raw.trim() && cur && !deletedAt.has(raw.trim())) deletedAt.set(raw.trim(), cur);
    }
  } catch { /* 无 git 时 source-retired 只认台账 retired 标记 */ }

  const cache = new Map();
  const sourceSha12s = (source) => {
    if (cache.has(source)) return cache.get(source);
    const abs = path.join(ROOT, source);
    let v = null;
    if (fs.existsSync(abs)) { try { v = sha12sOf(fs.readFileSync(abs)); } catch { v = null; } }
    cache.set(source, v);
    return v;
  };

  const rows = (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter((l) => l.trim()) : [])
    .map((l, i) => { try { const o = JSON.parse(l); o.__line = i + 1; return o; } catch { return { __line: i + 1, __bad: l.slice(0, 120) }; } });

  const ledgerMarkerCount = new Map();
  for (const r of rows) if (r.marker) ledgerMarkerCount.set(r.marker, (ledgerMarkerCount.get(r.marker) ?? 0) + 1);

  const prevByKey = new Map();
  for (const r of rows) {
    const m = MARKER_RE.exec(String(r.marker ?? ''));
    if (!m) continue;
    const k = r.source + '#' + m[3] + m[4];
    if (!prevByKey.has(k)) prevByKey.set(k, { sha12: m[5], memoryId: r.memoryId });
  }

  const ctx = { byId, ledgerMarkerCount, libLatestMarkerCount, sourceSha12s, deletedAt, prevByKey, allowIndexExempt: false, mode: MODE };

  // 闸门主用法：校验**尚未入台账的那一行**（close-round --done 在追加前调用）。
  // 注意不能用 --new=<现有行数>：那按 __line > N 取行，新行还没写进去，scope 恒为空 ⇒ 闸门形同虚设。
  let scope;
  if (MODE === 'row') {
    const p = path.resolve(ROOT, rowFile);
    if (!fs.existsSync(p)) { console.error('闸 B：找不到 --row-file=' + rowFile); process.exitCode = 2; return; }
    let candidate;
    try { candidate = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { console.error('闸 B：--row-file 不是合法 JSON：' + e.message); process.exitCode = 2; return; }
    // 候选行也要参与"台账内 marker 唯一"的判定
    if (candidate.marker) ledgerMarkerCount.set(candidate.marker, (ledgerMarkerCount.get(candidate.marker) ?? 0) + 1);
    scope = [{ ...candidate, __line: rows.length + 1 }];
  } else {
    scope = rows.filter((r) => r.__line > FROM);
  }
  const results = scope.map((r) => ({ line: r.__line, ...(r.__bad ? { bad_line: r.__bad } : checkRow(r, ctx)) }));
  const tally = (key) => {
    const t = {};
    for (const r of results) for (const e of r[key] ?? []) t[e.rule] = (t[e.rule] ?? 0) + 1;
    return Object.fromEntries(Object.entries(t).sort((a, b) => b[1] - a[1]));
  };
  const out = {
    checkedAt: new Date().toISOString(), mode: MODE, from_line: FROM, row_file: rowFile ?? null,
    ledger: LEDGER, scope_rows: scope.length,
    blocking_rows: results.filter((r) => (r.errs ?? []).length > 0).length,
    exempt_rows: results.filter((r) => (r.exempt ?? []).length > 0).length,
    errors_by_rule: tally('errs'), exempt_by_rule: tally('exempt'), warnings_by_rule: tally('warns'),
    blocking_examples: results.filter((r) => (r.errs ?? []).length > 0).slice(0, 20),
  };
  const jsonPath = valOf('json');
  if (jsonPath) fs.writeFileSync(path.resolve(ROOT, jsonPath), JSON.stringify({ ...out, results }, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = (MODE === 'new' || MODE === 'row') && out.blocking_rows > 0 ? 1 : 0;
}
