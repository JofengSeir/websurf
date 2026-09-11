#!/usr/bin/env node
/**
 * 文档漂移体检（doc-drift check）—— 校验 documents/ 与各工程 md 里的「文件地图」是否与代码一致。
 *
 * 检查项（按文档铁律「内容以实际代码为准」）：
 *   A 行数声明：`path`(NNN) / | path | NNN | 形式的行数是否等于实测 wc -l
 *   B 文件:行号 锚点：锚点是否超出文件总行数（在范围内但错位的锚点无法自动判定，见文末说明）
 *   C 路径失效：文档引用的文件是否在仓库内存在
 *   D 歧义路径：同名多份且无法据上下文判定（如跨工程文档里的裸 `app.ts` / `Cargo.toml`），仅计数
 *
 * 用法：
 *   node src/scripts/check-doc-drift.mjs                 # 全仓 md
 *   node src/scripts/check-doc-drift.mjs documents/game/overview.md ...
 *
 * 退出码：A（行数漂移）或 B（锚点越界）非空 → 1，可直接接 CI 门禁；
 *         C（路径失效）仅告警不失败——历史叙述里常有「原 xxx 已移出」这类刻意保留的旧路径。
 *
 * 能力边界（重要）：
 *   1. 锚点只校验「是否越界」，不校验「该行内容是否与文档描述相符」——文件在锚点前增删代码时
 *      锚点会「在范围内但错位」，需人工判读（2026-09 实测到过一例：`worker/main.ts:86` 实际已在 `:429`）。
 *   2. 跨工程文档使用裸文件名时无法自动消歧，计入 D 而非判定为错误。
 *   3. `archive/` 下的历史快照默认跳过（其定位即「不作为事实来源」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const EXT = 'ts|tsx|rs|mjs|js|py|cmd|json|md|toml|html|css|yml|yaml';

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8').split('\n').filter(Boolean);
// 注意：ls-files 会包含「已删除但未暂存」的条目，必须过滤为磁盘上真实存在的文件
const live = tracked.filter((f) => fs.existsSync(path.join(ROOT, f)));
const wc = (rel) => { let n = 0; const b = fs.readFileSync(path.join(ROOT, rel)); for (const x of b) if (x === 10) n++; return n; };
const LINES = new Map(live.map((f) => [f, wc(f)]));

const scopeRoots = (doc) => {
  const r = [];
  const m = doc.match(/^documents\/(debug|game|viewer)\//);
  if (m) r.push(`apps/${m[1]}`);
  if (doc.startsWith('test/dual-mode-harness/')) r.push('test/dual-mode-harness');
  if (/^apps\/(debug|game|viewer)\//.test(doc)) r.push(doc.split('/').slice(0, 2).join('/'));
  r.push('apps/debug', 'apps/game', 'apps/viewer', 'test/dual-mode-harness', 'src');
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
  .filter((f) => !/archive\//.test(f)); // 历史快照不参与（其定位即「不作为事实来源」）
const drift = [], badAnchor = [], missing = [];
let claims = 0, anchors = 0, ambiguous = 0;

for (const doc of mds) {
  const lines = fs.readFileSync(path.join(ROOT, doc), 'utf8').split('\n');
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
