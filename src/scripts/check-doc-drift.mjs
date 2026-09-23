#!/usr/bin/env node
/**
 * 文档漂移体检（doc-drift check）—— 校验 md 里的「文件地图」是否与代码一致。
 *
 * 扫描面：`tracked` 取自 git ls-files --cached --others --exclude-standard，再按磁盘
 * 存在性过滤成 `live` 并配 `LINES` 行数表；`mds` 无参数时是全仓 .md，有参数时只取参数
 * 里以 .md 结尾的那些。
 *
 * 检查项（对应 drift / badAnchor / missing / ambiguous 四个累加器）：
 *   A 行数声明：`path`(NNN)、`path`（NNN 行）与 | path | NNN | 三种写法的声明值是否等于
 *     `wc` 实测值（实测值 = 文件里 LF 字节的个数）
 *   B 锚点越界：`path:NNN`（含 `NNN-NNN` 区间、全角冒号与 -/–/~ 分隔）的高位是否超过
 *     目标文件行数 + 1
 *   C 路径失效：`resolve` 在候选集合里找不到任何文件
 *   D 歧义路径：`resolve` 的前两名候选评分相同（同名多份，无法自动消歧），仅计数
 *
 * `resolve` 的候选来自 scopeRoots(doc) × APP_EXTRA / SHARED_EXTRA 的拼接，外加 live 里
 * 的后缀命中与裸文件名命中；评分 = 行数够 (4) + 在文档作用域内 (2) + 非裸名且后缀命中 (1)，
 * 按分数降序、路径长度升序取首位。
 *
 * 用法：
 *   node src/scripts/check-doc-drift.mjs                 # 全仓 md
 *   node src/scripts/check-doc-drift.mjs documents/architecture/overview.md ...
 *
 * 退出码：A 或 B 非空 → 1；C 与 D 只打印、不影响退出码。
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
  const score = (f) => (fits(f) ? 4 : 0) + (inScope(f) ? 2 : 0) + (!bare && f.endsWith(suffix) ? 1 : 0);
  list.sort((a, b) => score(b) - score(a) || a.length - b.length);
  if (list.length > 1 && score(list[1]) === score(list[0])) return { ambiguous: list.slice(0, 3) };
  return { rel: list[0] };
};

const targets = process.argv.slice(2).filter((a) => a.endsWith('.md'));
const mds = (targets.length ? targets : live.filter((f) => f.endsWith('.md')))
  .filter((f) => fs.existsSync(path.join(ROOT, f)))
  .filter((f) => !/archive\//.test(f)); // 快照目录（本行正则）不参与：其定位即「不作为事实来源」
const drift = [], badAnchor = [], missing = [];
let claims = 0, anchors = 0, ambiguous = 0;

for (const doc of mds) {
  const lines = fs.readFileSync(path.join(ROOT, doc), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const ln = i + 1;
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
      if (r.ambiguous) { ambiguous++; continue; }
      const total = LINES.get(r.rel);
      if (f.kind === 'claim') {
        if (total !== f.n) drift.push(`  ${doc}:${ln}  ${f.p} → ${r.rel}  声明 ${f.n} / 实测 ${total} (差 ${total - f.n})`);
      } else if (hi > total + 1) {
        badAnchor.push(`  ${doc}:${ln}  ${f.raw} → ${r.rel}（共 ${total} 行）`);
      }
    }
  });
}

console.log(`文档漂移体检：${mds.length} 篇 md ｜ 行数声明 ${claims}（漂移 ${drift.length}）｜锚点 ${anchors}（越界 ${badAnchor.length}）｜路径失效 ${missing.length} ｜歧义未判 ${ambiguous}`);
if (drift.length) console.log('\n[A] 行数声明漂移（失败）：\n' + drift.join('\n'));
if (badAnchor.length) console.log('\n[B] 锚点越界（失败）：\n' + badAnchor.join('\n'));
if (missing.length) console.log('\n[C] 路径失效（告警，可能是刻意保留的历史路径）：\n' + [...new Set(missing)].map((s) => '  ' + s).join('\n'));
if (ambiguous) console.log(`\n[D] 歧义 ${ambiguous} 处（跨工程文档的裸文件名，需人工判读；非错误）`);

process.exit(drift.length || badAnchor.length ? 1 : 0);
