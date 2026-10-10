#!/usr/bin/env node
/**
 * 记忆库「现状文档」锚点体检（T-641 的持久判据）。
 *
 * ## 为什么需要它
 *
 * `documents/**`（47 篇工程/共享层/架构文档）已于 2026-10-10 全量迁入 agentmemory；它们的原文在
 * `archive/memory/2026-10/<路径>`（冻结不改），库内是分块副本。这些文档自称「内容全部来自当前源码
 * 实测，每个结论带 `路径:行号` 锚点」，但**迁出仓库后就没有任何门禁再看它们的锚点了**
 * （`check-doc-drift [B]` 只扫仓库内 16 篇 md）⇒ 行号可静默漂移甚至越界，而读者会把它当现状。
 *
 * 本脚本从记忆库读出 `documents/**` 条目，把其中的 `路径:行号` 锚点**逐个对当前仓库源码核**，
 * 报三类：`missing`（路径不存在）、`overflow`（行号超出文件长度）、`ok`（在范围内）。它不判断
 * 「内容是否还成立」——那需要人读；但越界与路径消失是**硬证据**，足以触发复核。
 *
 * ## 用法与判定
 *
 *   node src/scripts/check-kb-doc-drift.mjs [--strict] [--json] [--top=20] [--port=3113]
 *
 * 默认**只报告**、exit 0（迁移时点快照本就允许行号漂移）；`--strict` 时，**文档正文条目**
 * （marker 的 kind 为 chunk/index/sec）出现 `missing` 或 `overflow` ⇒ exit 1。`errata` 条目单独统计
 * （勘误会刻意引用已被取代的旧行号，不计入硬判定）。知识库不可达 ⇒ 打印 SKIP、exit 0（与另两个
 * CDP 门禁同一约定：缺依赖不红）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const JSON_OUT = argv.includes('--json');
const opt = (k, d) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const PORT = opt('port', '3113');
const TOP = Number(opt('top', '20'));
const skip = (why) => { console.log('SKIP 记忆库文档锚点体检：' + why); process.exit(0); };

/** 拉全量条目（判存在性用权威列表，不用检索）。 */
async function fetchMemories() {
  const url = `http://127.0.0.1:${PORT}/memories?limit=1000`;
  let res;
  try { res = await fetch(url); } catch (e) { skip('无法连接 ' + url + '（' + (e?.cause?.code ?? e?.message ?? '?') + '）'); }
  if (!res.ok) skip('HTTP ' + res.status + ' @ ' + url);
  const j = await res.json();
  return Array.isArray(j) ? j : (j.memories ?? []);
}

const MARKER_RE = /websurf\/(documents\/[^#\s`|]+)#([a-z]+)(\d+)@[0-9a-f]{12}/;
/** 只认「含目录的仓库相对路径 + 行号」（裸文件名如 `lib.rs:87` 无法定位，跳过）。 */
const ANCHOR_RE = /([A-Za-z0-9_][\w./-]*\/[\w./-]+\.(?:ts|mts|cts|mjs|cjs|js|jsx|tsx|rs|md|json|html|cmd)):(\d+)(?:-(\d+))?/g;
const IGNORE_EXT = new Set(['.md']);   // md 之间互引由 [K]/文档契约管，不在这里算漂移

const memories = await fetchMemories();
const docs = [];
for (const m of memories) {
  const text = String(m.content ?? '') + '\n' + String(m.title ?? '');
  const mk = MARKER_RE.exec(text);
  if (!mk) continue;
  docs.push({ id: m.id, source: mk[1], kind: mk[2], seq: Number(mk[3]), marker: `websurf/${mk[1]}#${mk[2]}${mk[3]}@${String(mk[0]).slice(-12)}`, text });
}
if (!docs.length) skip('库内没有 `websurf/documents/**` 条目');

const fileCache = new Map();
function fileInfo(rel) {
  if (fileCache.has(rel)) return fileCache.get(rel);
  const abs = path.join(ROOT, rel);
  let info = null;
  try {
    if (fs.statSync(abs).isFile() && !IGNORE_EXT.has(path.extname(rel))) {
      info = { lines: fs.readFileSync(abs, 'utf8').split(/\r?\n/).length };
    }
  } catch { info = null; }
  fileCache.set(rel, info);
  return info;
}

const perEntry = [];
for (const d of docs) {
  ANCHOR_RE.lastIndex = 0;
  const found = [];
  for (const hit of d.text.matchAll(ANCHOR_RE)) {
    const rel = hit[1].replace(/^\.\//, '');
    const line = Number(hit[2]);
    const info = fileInfo(rel);
    const kind = !info ? 'missing' : line > info.lines ? 'overflow' : 'ok';
    found.push({ rel, line, kind, fileLines: info?.lines ?? 0 });
  }
  perEntry.push({ ...d, anchors: found, missing: found.filter((a) => a.kind === 'missing').length, overflow: found.filter((a) => a.kind === 'overflow').length });
}

const body = perEntry.filter((e) => e.kind !== 'errata');
const errata = perEntry.filter((e) => e.kind === 'errata');
const sum = (list, k) => list.reduce((a, e) => a + e[k], 0);
const total = {
  entries: body.length + errata.length,
  bodyEntries: body.length,
  errataEntries: errata.length,
  anchors: sum(body, 'anchors'), // 占位，下面覆盖
  missing: sum(body, 'missing'),
  overflow: sum(body, 'overflow'),
  errataMissing: sum(errata, 'missing'),
  errataOverflow: sum(errata, 'overflow'),
};
total.anchors = body.reduce((a, e) => a + e.anchors.length, 0);

if (JSON_OUT) {
  console.log(JSON.stringify({ total, entries: perEntry.map((e) => ({ marker: e.marker, kind: e.kind, anchors: e.anchors.length, missing: e.missing, overflow: e.overflow })) }, null, 2));
} else {
  console.log('记忆库「现状文档」锚点体检（documents/** ⇒ 当前源码）');
  console.log(`库内条目：正文 ${total.bodyEntries} 条 / 勘误 ${total.errataEntries} 条；正文锚点 ${total.anchors} 处`);
  console.log(`正文：路径失效 ${total.missing} 处 ｜ 行号越界 ${total.overflow} 处（其余在文件长度范围内，内容是否仍成立需人读）`);
  console.log(`勘误：路径失效 ${total.errataMissing} 处 ｜ 越界 ${total.errataOverflow} 处（勘误会刻意引用被取代的旧行号，不计入判定）`);
  const worst = body.filter((e) => e.missing || e.overflow).sort((a, b) => (b.missing + b.overflow) - (a.missing + a.overflow));
  if (worst.length) {
    console.log('\n需要复核的文档条目（前 ' + Math.min(TOP, worst.length) + ' 条）：');
    for (const e of worst.slice(0, TOP)) {
      console.log(`  ${e.marker}`);
      for (const a of e.anchors.filter((x) => x.kind !== 'ok').slice(0, 6)) {
        console.log(`     ${a.kind === 'missing' ? '路径失效' : '行号越界'} ${a.rel}:${a.line}${a.kind === 'overflow' ? `（该文件 ${a.fileLines} 行）` : ''}`);
      }
    }
  }
}

if (STRICT && total.missing + total.overflow > 0) {
  console.log(`\n记忆库文档锚点体检（--strict）：失败 ${total.missing + total.overflow} 处（正文条目路径失效/越界）`);
  process.exit(1);
}
console.log('\n记忆库文档锚点体检：' + (STRICT ? '通过' : '完成（报告模式）') + '（exit 0）');
