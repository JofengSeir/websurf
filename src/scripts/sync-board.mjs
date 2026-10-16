#!/usr/bin/env node
/**
 * 看板重迁——`progress/board.jsonl` 一改，它的 KB 条目就全部 sha12 失配（check-memory-sync stale=N）。
 * 本脚本把「渲染 → 切块 → 生成 marker → 打印要执行的 MCP 调用」压成两条命令，避免每轮手搓切块。
 *
 * 用法：
 *   node src/scripts/sync-board.mjs                                  # ① 打印计划（旧条目删除调用 + 新条目 memory_save 参数）
 *   node src/scripts/sync-board.mjs --done --ids m1=id1,m2=id2,...    # ② 落台账 + 更新 control-ids
 *   node src/scripts/sync-board.mjs --status                         # 只比「磁盘 sha12 vs 台账 sha12」，失配 exit 1
 *
 * 切块口径与迁移时一致：按记录边界（表格行/列表项/标题/有序项）切，上限 8192 字节；末尾补一条 #index0 索引。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOARD = join(ROOT, 'progress/board.jsonl');
const LEDGER = join(ROOT, 'progress/memory-index.jsonl');
const IDS = join(ROOT, 'progress/control-ids.json');
const SRC = 'progress/board.jsonl';
const CHUNK_MAX = 8192;
const VIEWER = process.env.AGENTMEMORY_VIEWER_URL || 'http://127.0.0.1:3113';
const TERMINAL = ['已记录', '已结案'];
// **终态按前缀认**（2026-10-16 修）：实际状态带日期后缀（「已结案 · 2026-10-16」），
// 原先的精确相等让当天结案行仍被算作「未结项」—— 盘面「取活」列表里混进一堆已结案行。
const isTerminal = (s) => TERMINAL.some((t) => String(s ?? '').startsWith(t));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const value = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };

if (!existsSync(BOARD)) { console.error('缺少 ' + SRC); process.exit(2); }
const raw = readFileSync(BOARD, 'utf8');
const sha12 = createHash('sha256').update(raw).digest('hex').slice(0, 12);
const rows = raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
const live = rows.filter((r) => !isTerminal(r.status));
const count = {};
for (const r of rows) count[r.status] = (count[r.status] || 0) + 1;

const ledger = () => readFileSync(LEDGER, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const mine = () => ledger().filter((e) => e.source === SRC);
const shaOf = (e) => (String(e.marker).match(/@([0-9a-f]{12})$/) || [])[1];

function render() {
  const cell = (r) => [r.id, r.title, r.type, r.owner, r.status, r.evidence, r.detail, r.criteria, r.origin].join(' | ');
  const groups = Object.keys(count).filter((k) => !isTerminal(k)).map((k) => k.slice(0, 12) + ' ' + count[k]).join(' / ');
  // **取活列表按优先级排**（行上的可选字段 `prio`：P0/P1/P2；缺省排最后）。
  // 优先级只影响这一份渲染的顺序与标注，**不进总表**（总表列数被 `check-doc-drift` 的 [G] 按位解析，不能动）。
  const PRIO_ORDER = { P0: 0, P1: 1, P2: 2 };
  const liveSorted = [...live].sort(
    (a, b) => (PRIO_ORDER[a.prio] ?? 9) - (PRIO_ORDER[b.prio] ?? 9) || String(a.id).localeCompare(String(b.id)),
  );
  return [
    '# 待办看板（已迁入 agentmemory）',
    '',
    '来源：`' + SRC + '`（机器可读镜像，sha12 `' + sha12 + '`）。本条目是它的人类可读渲染，供 agent 取活/收尾阅读。',
    '行上的 `prio`（P0/P1/P2）只用于本节的排序与标注；状态口径见下。',
    '',
    '## 状态口径',
    '',
    '| 状态 | 含义 |',
    '|---|---|',
    '| 待裁决 | 修法有分歧，或改动会动到行为契约，需要 owner 定 |',
    '| 待修 | 修法明确、改动局部，可直接排期 |',
    '| 已取证待立项 | 根因清楚但工作量超出一次改动，需要单独任务书 |',
    '| 进行中 | 已开工，尚未收口（必须带认领 `进行中 · <agent> · <YYYY-MM-DD>`） |',
    '| 阻塞 | 卡住：等 owner 裁决 / 等外部条件；已登记 OWNER.md |',
    '| 已记录 | 已知事实 / 工具边界，无需行动，仅备查 |',
    '| 已结案 | 已按结论改完，或已判定无需行动 |',
    '',
    '## 取活（未结项 ' + live.length + ' 条，按优先级：' + groups + '）',
    '',
    ...liveSorted.map((r) => '- **' + r.id + '**' + (r.prio ? '（' + r.prio + '）' : '') + ' ' + r.title + '　`' + r.owner + '`（' + r.status + '）'),
    '',
    '## 总表（' + rows.length + ' 条）',
    '',
    '| ID | 事项 | 类型 | 归属 | 状态 | 证据 | 详情 | 判据 | 原号 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => '| ' + cell(r) + ' |'),
    '',
  ].join('\n');
}

function chunk(lines, max = CHUNK_MAX) {
  const isRec = (l) => /^\|/.test(l) || /^- /.test(l) || /^#{1,6} /.test(l) || /^\d+\. /.test(l);
  const out = [];
  let start = 0, size = 0, open = false;
  const flush = (end) => { if (open) out.push({ start, end }); };
  lines.forEach((l, i) => {
    const lb = Buffer.byteLength(l, 'utf8') + 1;
    const boundary = !open || isRec(l);
    if (open && boundary && size + lb > max) { flush(i); start = i; size = 0; open = false; }
    open = true; size += lb;
  });
  flush(lines.length);
  return out;
}

function plan() {
  const lines = render().split('\n');
  const parts = chunk(lines);
  const items = parts.map((c, i) => ({
    marker: 'websurf/' + SRC + '#chunk' + i + '@' + sha12,
    kind: 'chunk', seq: i, total: parts.length,
    text: lines.slice(c.start, c.end).join('\n'),
  }));
  items.push({ marker: 'websurf/' + SRC + '#index0@' + sha12, kind: 'index', seq: 0, total: parts.length, text: lines.slice(0, 40).join('\n') });
  return items;
}

if (flag('status')) {
  const led = shaOf({ marker: (mine()[0] || {}).marker || '' });
  const ok = led === sha12;
  console.log('sync-board：磁盘 sha12=' + sha12 + ' ｜ 台账 sha12=' + (led || '（无）') + ' ｜ 条目 ' + mine().length + ' ｜ ' + (ok ? '已同步' : '⚠ 失配 ⇒ 需重迁'));
  process.exit(ok ? 0 : 1);
}

if (flag('done')) {
  let pairs = String(value('ids') || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const i = s.indexOf('='); return { marker: s.slice(0, i), memoryId: s.slice(i + 1) }; });
  if (!pairs.length) {
    // 没给 --ids：自己从库里按 marker 认（库内条目的首行就是 [线索] marker）。
    // 这样「plan → 逐条 memory_save → --done」三步里最后一步不需要人工抄 id。
    const need = plan().map((it) => it.marker);
    try {
      const res = await fetch(VIEWER + '/memories?limit=4000', { signal: AbortSignal.timeout(30000) });
      const live = (await res.json()).memories || [];
      const got = new Map();
      for (const m of live) {
        const mk = (String(m.content || '').match(/^\[线索\] (\S+)/) || [])[1];
        if (mk && need.indexOf(mk) >= 0 && !got.has(mk)) got.set(mk, m.id);
      }
      pairs = [...got].map(([marker, memoryId]) => ({ marker, memoryId }));
      console.log('sync-board：自动解析到 ' + pairs.length + '/' + need.length + ' 条（库内按 marker 匹配）');
    } catch (err) {
      console.error('自动解析失败（库不可达？）：' + (err && err.message ? err.message : err));
    }
    if (pairs.length !== need.length) { console.error('--done 需要 ' + need.length + ' 条，只解析到 ' + pairs.length + ' 条 ⇒ 先按计划逐条 memory_save，或显式传 --ids marker=id,...'); process.exit(2); }
  }
  const keep = ledger().filter((e) => e.source !== SRC);
  for (const it of pairs) {
    keep.push({
      marker: it.marker, source: SRC,
      kind: /#index/.test(it.marker) ? 'index' : 'chunk',
      seq: Number((it.marker.match(/#chunk(\d+)/) || [])[1] || 0),
      memoryId: it.memoryId,
      at: new Date().toISOString().slice(0, 10),
      retired: true, shape: 'snapshot',
    });
  }
  writeFileSync(LEDGER, keep.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  const cid = JSON.parse(readFileSync(IDS, 'utf8'));
  cid.board = { source: SRC, sha12, live: live.map((r) => r.id), closed: rows.filter((r) => isTerminal(r.status)).map((r) => r.id), by_status: count };
  writeFileSync(IDS, JSON.stringify(cid, null, 2) + '\n', 'utf8');
  console.log('sync-board：台账更新 ' + pairs.length + ' 条 ｜ control-ids.board.sha12=' + sha12 + ' ｜ live ' + live.length);
  console.log('下一步：node src/scripts/check-memory-sync.mjs --keys');
  process.exit(0);
}

const items = plan();
console.log(JSON.stringify({
  source: SRC, sha12, rows: rows.length, live: live.length, bytes: Buffer.byteLength(raw, 'utf8'),
  saved: mine().map((e) => e.marker),
  deletes: mine().map((e) => ({ marker: e.marker, memoryId: e.memoryId })),
  saves: items.map((it) => ({
    marker: it.marker, kind: it.kind, bytes: Buffer.byteLength(it.text, 'utf8'),
    content: '[线索] ' + it.marker + '\n主题：待办看板（活动板）\n路径：' + SRC + (it.kind === 'index' ? '（索引）' : '（第 ' + (it.seq + 1) + '/' + it.total + ' 段）') + '\n小节：\n  看板（取活/状态流转）\n摘要：' + Buffer.byteLength(it.text, 'utf8') + ' B ｜ ' + rows.length + ' 条\n---\n' + it.text,
  })),
}, null, 1));
