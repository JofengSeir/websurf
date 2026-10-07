#!/usr/bin/env node
/**
 * 文档漂移体检（doc-drift check）—— 校验 md 里的「文件地图」是否与代码一致。
 *
 * 扫描面：`tracked` 取自 git ls-files --cached --others --exclude-standard，再按磁盘
 * 存在性过滤成 `live` 并配 `LINES` 行数表；`mds` 无参数时是全仓 .md，有参数时只取参数
 * 里以 .md 结尾的那些。
 *
 * 检查项（A–D 是原四项；E–G 于 2026-10-07 补齐，用于让「规则—待办—门禁」闭环）：
 *   A 行数声明：`path`(NNN)、`path`（NNN 行）与 | path | NNN | 三种写法的声明值是否等于
 *     `wc` 实测值（实测值 = 文件里 LF 字节的个数）
 *   B 锚点越界：`path:NNN`（含 `NNN-NNN` 区间、全角冒号与 -/–/~ 分隔）的高位是否超过
 *     目标文件行数 + 1
 *   C 路径失效：`resolve` 在候选集合里找不到任何文件
 *   D 歧义路径：`resolve` 的前两名候选评分相同（同名多份，无法自动消歧），仅计数
 *   E 坏链：md 里的相对链接 `[..](target)` 在磁盘上是否存在（http/https/mailto/纯锚点跳过）
 *   F 行尾与 BOM：**以索引 blob（提交形态）为准**——不得含 CR、不得含 UTF-8 BOM。
 *     注意：仓库 `core.autocrlf=true` 且无 `.gitattributes` ⇒ 规范形式是 **LF**，
 *     工作树里的 CRLF 只是检出产物（Linux CI 上会是 LF），故不能拿工作树行尾当判据。
 *   G 待办同源：① 全仓 `T-###` 引用必须能在根 TODO.md 里找到（悬空即失败）；
 *     ② TODO.md 里的 ID 不得重复；③ 未结项的证据列不得为空（须写 `文件:行号` 或 `见详情`）；
 *     ④ 规范面文档不得自行声明待办状态
 *     （`状态：待裁决` 一类），状态只写在 TODO.md——过程记录 `progress/**` 与
 *     `TODO.md` / `AGENTS.md` / `documents/norms/**` 豁免。
 *
 * `resolve` 的候选来自 scopeRoots(doc) × APP_EXTRA / SHARED_EXTRA 的拼接，外加 live 里
 * 的后缀命中与裸文件名命中；评分 = 行数够 (4) + 在文档作用域内 (2) + 非裸名且后缀命中 (1)，
 * 按分数降序、路径长度升序取首位。
 *
 * 用法：
 *   node src/scripts/check-doc-drift.mjs                 # 全仓 md
 *   node src/scripts/check-doc-drift.mjs documents/architecture/overview.md ...
 *
 * 退出码：A / B / E / F / G 非空 → 1；C 与 D 只打印、不影响退出码。
 * 调用方：`.github/workflows/doc-drift.yml` 的 `Run doc drift check` 步骤直接跑本脚本。
 *
 * 能力边界（重要）：
 *   1. 锚点只校验「是否越界」，不校验「锚点处内容是否与描述相符」——文件在锚点之前增删
 *      代码会让锚点「在范围内但错位」，这类只能人工判读。
 *   2. 跨工程文档里的裸文件名无法自动消歧，计入 D 而不判错。
 *   3. `mds` 的 `filter` 跳过路径命中快照目录正则的 md（其定位即「不作为事实来源」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const EXT = 'ts|tsx|rs|mjs|js|py|cmd|json|md|toml|html|css|yml|yaml';

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8').split(/\r?\n/).filter(Boolean);
// ls-files 会把「已删除但未暂存」的条目也列出来，故按磁盘存在性再过滤一次
const live = tracked.filter((f) => fs.existsSync(path.join(ROOT, f)));
const wc = (rel) => { let n = 0; const b = fs.readFileSync(path.join(ROOT, rel)); for (const x of b) if (x === 10) n++; return n; };
const LINES = new Map(live.map((f) => [f, wc(f)]));

const scopeRoots = (doc) => {
  const r = [];
  const m = doc.match(/^documents\/(debug|game|viewer)\//);
  if (m) r.push(`apps/${m[1]}`);
  if (/^apps\/(debug|game|viewer)\//.test(doc)) r.push(doc.split('/').slice(0, 2).join('/'));
  r.push('apps/debug', 'apps/game', 'apps/viewer', 'src');
  return r;
};
const APP_EXTRA = ['', 'src', 'web', 'scripts', 'crates/wasm/src'];
const SHARED_EXTRA = ['', 'src', 'phys', 'wasm-core/src', 'ts-shared/auth', 'ts-shared/phys', 'ts-shared/input', 'ts-shared/tick', 'ts-shared/decoupled', 'vendor/vmdl/src'];

const resolve = (raw, doc, maxLine) => {
  const clean = raw.replace(/^\.\//, '').replace(/^(\.\.\/)+/, '');
  const bare = !clean.includes('/');
  const cands = new Set();
  for (const root of scopeRoots(doc)) {
    const extras = root.startsWith('src') ? SHARED_EXTRA : APP_EXTRA;
    for (const ex of extras) {
      const p = [root, ex, clean].filter(Boolean).join('/');
      if (live.includes(p)) cands.add(p);
    }
  }
  if (live.includes(clean)) cands.add(clean);
  const suffix = '/' + clean;
  for (const f of live) {
    if (f.endsWith(suffix)) cands.add(f);
    else if (bare && path.basename(f) === clean) cands.add(f);
  }
  if (!cands.size) return { missing: true };
  const list = [...cands];
  const fits = (f) => LINES.get(f) + 1 >= maxLine;
  const inScope = (f) => scopeRoots(doc).some((r) => f.startsWith(r + '/'));
  // 根级文件优先：文档约定「app 文件写全路径、仓库根文件写裸名」（如裸 package.json / Cargo.toml）
  const score = (f) => (fits(f) ? 4 : 0) + (inScope(f) ? 2 : 0) + (!bare && f.endsWith(suffix) ? 1 : 0) + (f.includes('/') ? 0 : 3);
  list.sort((a, b) => score(b) - score(a) || a.length - b.length);
  if (list.length > 1 && score(list[1]) === score(list[0])) return { ambiguous: list.slice(0, 3) };
  return { rel: list[0] };
};

const targets = process.argv.slice(2).filter((a) => a.endsWith('.md'));
const mds = (targets.length ? targets : live.filter((f) => f.endsWith('.md')))
  .filter((f) => fs.existsSync(path.join(ROOT, f)))
  .filter((f) => !/archive\//.test(f)); // 快照目录（本行正则）不参与：其定位即「不作为事实来源」
const drift = [], badAnchor = [], missing = [], broken = [];
let claims = 0, anchors = 0, ambiguous = 0;
const ambByDoc = {};

for (const doc of mds) {
  const lines = fs.readFileSync(path.join(ROOT, doc), 'utf8').split(/\r?\n/);
  let fence = false;                       // [E] 跳过围栏代码块里的伪链接
  lines.forEach((line, i) => {
    const ln = i + 1;
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    const found = [];
    for (const m of line.matchAll(new RegExp('`?([A-Za-z0-9_./-]+\\.(?:' + EXT + '))`?[\\(（]\\s*(\\d+)\\s*(?:行)?\\s*[\\)）]', 'g'))) found.push({ p: m[1], n: +m[2], kind: 'claim' });
    const t = line.match(new RegExp('^\\|\\s*`?([A-Za-z0-9_./-]+\\.(?:' + EXT + '))`?\\s*\\|\\s*(\\d+)\\s*\\|'));
    if (t) found.push({ p: t[1], n: +t[2], kind: 'claim' });
    for (const m of line.matchAll(new RegExp('`?([A-Za-z0-9_./-]+\\.(?:' + EXT + '))[:：](\\d+)(?:[-–~](\\d+))?`?', 'g')))
      found.push({ p: m[1], n: +m[2], n2: m[3] ? +m[3] : null, kind: 'anchor', raw: m[0] });

    for (const f of found) {
      if (f.kind === 'claim') claims++; else anchors++;
      const hi = f.n2 ?? f.n;
      const r = resolve(f.p, doc, hi);
      if (r.missing) { missing.push(`${doc}:${ln} ${f.p}`); continue; }
      if (r.ambiguous) { ambiguous++; ambByDoc[doc] = (ambByDoc[doc] || 0) + 1; continue; }
      const total = LINES.get(r.rel);
      if (f.kind === 'claim') {
        if (total !== f.n) drift.push(`  ${doc}:${ln}  ${f.p} → ${r.rel}  声明 ${f.n} / 实测 ${total} (差 ${total - f.n})`);
      } else if (hi > total + 1) {
        badAnchor.push(`  ${doc}:${ln}  ${f.raw} → ${r.rel}（共 ${total} 行）`);
      }
    }

    // [E] 坏链：相对链接必须能在磁盘上解析（围栏内的伪链接跳过）
    if (!fence) {
      for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        let raw = m[1];
        if (/^(https?:|mailto:|#|data:)/.test(raw)) continue;
        raw = raw.split('#')[0];
        if (!raw) continue;
        let decoded = raw;
        try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
        if (!fs.existsSync(path.resolve(ROOT, path.dirname(doc), decoded))) broken.push(`  ${doc}:${ln}  → ${m[1]}`);
      }
    }
  });
}

// ===== [F] 行尾与 BOM：以索引 blob（提交形态）为准 =====
const TEXT_EXT = /\.(md|ts|tsx|rs|mjs|js|py|cmd|json|toml|html|css|yml|yaml|txt)$/;
const byExt = (f) => TEXT_EXT.test(f) || /(^|\/)\.(gitignore|gitattributes)$/.test(f);
const eolBad = [];
for (const f of live) {
  if (!byExt(f)) continue;
  const b = fs.readFileSync(path.join(ROOT, f));
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) eolBad.push(`  ${f}  含 UTF-8 BOM`);
}
let indexCR = [];
try {
  const out = execFileSync('git', ['-C', ROOT, 'grep', '--cached', '-l', '-P', '\\r', '--', '*.md', '*.ts', '*.rs', '*.mjs', '*.js', '*.json', '*.toml', '*.yml', '*.yaml', '*.html', '*.css', '*.py', '*.cmd', '*.txt'],
    { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  indexCR = out.split(/\r?\n/).filter(Boolean);
} catch { indexCR = []; }   // git grep 无命中时 exit 1
for (const f of indexCR) eolBad.push(`  ${f}  索引中仍含 CR（规范形式为 LF，core.autocrlf=true）`);

// ===== [G] 待办同源 =====
const todoPath = 'TODO.md';
const todoRaw = fs.existsSync(path.join(ROOT, todoPath)) ? fs.readFileSync(path.join(ROOT, todoPath), 'utf8') : '';
const todoIds = [...todoRaw.matchAll(/\|\s*(T-\d{3})\s*\|/g)].map((m) => m[1]);
const todoSet = new Set(todoIds);
const dupRows = [...new Set(todoIds.filter((id, i) => todoIds.indexOf(id) !== i))].map((id) => `  ${todoPath}  ${id} 重复`);
const dangling = [];
const noEvidence = [];                       // [G] 未结项的证据列不得为空（可为 `文件:行号` 或 `见详情`）
todoRaw.split(/\r?\n/).forEach((line) => {
  const s = line.trim();
  if (!s.startsWith('|') || /^\|[\s\-:|]+\|$/.test(s)) return;
  const c = s.split('|').slice(1, -1).map((x) => x.trim());
  if (c.length < 8 || !/^T-\d{3}$/.test(c[0])) return;
  if (!['已记录', '已结案'].includes(c[4]) && (!c[5] || c[5] === '—')) noEvidence.push(`  ${c[0]} 未结项但证据列为空`);
})
const statusClaim = [];
const STATUS_RE = /状态\s*[：:]\s*(待裁决|待修|已取证待立项|进行中|已记录|已结案)/;
const isExempt = (f) => f.startsWith('progress/') || f === todoPath || f === 'AGENTS.md' || f.startsWith('documents/norms/') || f.startsWith('src/scripts/');
if (!todoRaw) dangling.push(`  缺少根 ${todoPath}`);
for (const f of live) {
  if (!/\.(md|ts|rs|mjs|js|json|html|css|yml|toml)$/.test(f)) continue;
  const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/T-\d{3}/g)) if (!todoSet.has(m[0])) dangling.push(`  ${f}:${i + 1}  ${m[0]} 不在 ${todoPath}`);
    if (!isExempt(f) && STATUS_RE.test(line)) statusClaim.push(`  ${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
  });
}

const fail = drift.length || badAnchor.length || broken.length || eolBad.length || dangling.length || statusClaim.length || dupRows.length || noEvidence.length;
console.log(`文档漂移体检：${mds.length} 篇 md ｜ 行数声明 ${claims}（漂移 ${drift.length}）｜锚点 ${anchors}（越界 ${badAnchor.length}）｜路径失效 ${missing.length} ｜歧义未判 ${ambiguous} ｜坏链 ${broken.length} ｜行尾/BOM ${eolBad.length} ｜待办同源 ${dangling.length + statusClaim.length + dupRows.length + noEvidence.length}`);
if (drift.length) console.log('\n[A] 行数声明漂移（失败）：\n' + drift.join('\n'));
if (badAnchor.length) console.log('\n[B] 锚点越界（失败）：\n' + badAnchor.join('\n'));
if (missing.length) console.log('\n[C] 路径失效（告警，可能是刻意保留的历史路径）：\n' + [...new Set(missing)].map((s) => '  ' + s).join('\n'));
if (ambiguous) { const inProg = Object.entries(ambByDoc).filter(([k]) => k.startsWith(`progress/`)).reduce((s, [, v]) => s + v, 0); console.log(`\n[D] 歧义 ${ambiguous} 处（跨工程文档的裸文件名，需人工判读；非错误）｜规范面 ${ambiguous - inProg} 处、progress/ 过程记录 ${inProg} 处`); }
if (broken.length) console.log('\n[E] 坏链（失败）：\n' + broken.join('\n'));
if (eolBad.length) console.log('\n[F] 行尾/BOM（失败）：\n' + [...new Set(eolBad)].join('\n'));
if (dangling.length || statusClaim.length || dupRows.length || noEvidence.length) console.log('\n[G] 待办同源（失败）：\n' + [...dangling, ...dupRows, ...statusClaim, ...noEvidence].join('\n'));

process.exit(fail ? 1 : 0);
