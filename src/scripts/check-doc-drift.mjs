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
 *     ② TODO.md 与 progress/control-ids.json 的归档 ID 合计不得重复；③ 未结项的证据列不得为空（须写 `文件:行号` 或 `见详情`）；
 *     ④ 「未结项」列表与总表的 ID 集合必须一致（两份表示同源）；
 *     ⑤ 未结项的「详情」列必须非空且路径可解析；
 *     ⑥ 进行中的行必须带认领后缀；⑦ 待修/进行中/阻塞 行的判据不得为 [待补]（硬门）；
 *     ⑧ 若仓库仍有 documents/** 或 progress/** 的 md，则每篇必须出现在对应导航（当前两者都已迁出，检查自动跳过）；
 *        [H] 流程性 md 体积（AGENTS 32 / TODO 96 / OWNER 16 / 其余 48 KB）、[J] 注释纪律（单行 ≤160 硬门，块长只计数）；⑨ 规范面文档不得自行声明待办状态
 *     （`状态：待裁决` 一类），状态只写在 TODO.md——过程记录 `progress/**` 与
 *     `TODO.md` / `AGENTS.md` 豁免。
 *   L 文档缺口 ↔ 看板：终态行（已记录/已结案）的「详情」doc 里若仍引用该号，且该行没有
 *     「已消除 / 已修 / 已处置 / 已结案 / 已判定无需行动 / 已撤销 / ~~」标记 ⇒ 失败
 *     （文档不得留下假缺口）；详情不在 `documents/**`（如 `progress/`）的行不适用。
 *   M 假结案：终态行的判据若形如「git grep "<模式>" … ⇒ 0 命中」，则①该模式在判据自己声明的
 *     路径里必须真的 0 命中，②该模式在其「证据」文件里也必须 0 命中——`-- <路径>` 指错目录时
 *     判据会永远满足，条目就被永久假结案（实例：T-129 / T-132）。
 *   N 脚本与部署链契约（规范见 agentmemory `websurf/documents/norms/scripts-and-ci.md`）：① 三工程 `scripts/**` 的已跟踪脚本
 *     引用面必须非零（本工程 package.json / CI / 同族脚本），否则须登记进该篇 §1.1 豁免表；
 *     ② deploy-pages.yml 的 matrix.app 与装配段 for 循环必须与 `apps/` 目录三者一致；
 *     ③ 三工程 `.cmd` 必须 @echo off + exit /b，且不得写死 `C:\Users\` 路径。
 *   O 文档契约（docflow）——直接调用 `node src/scripts/docflow.mjs check`（口径单源）：只读 md
 *     漂移 / 未落实审批 / 联动缺失 / 只读类新建与删除。划分与子命令见该脚本头注与 `docflow.json`。
 *   P 本机路径：全仓文本不得出现**私人目录名 / 本机绝对路径**（Windows 用户目录、`/Users/<真名>`、
 *     `/home/<真名>`、`<盘符>:\code\...` 一类）。占位符（`<用户>` / `<本地工作区>` / `<盘符>` …）豁免。
 *     规则与 2026-10-07 事故记录见 agentmemory `websurf/documents/norms/local-path-hygiene.md`。
 *
 * `resolve` 的候选来自 scopeRoots(doc) × APP_EXTRA / SHARED_EXTRA 的拼接，外加 live 里
 * 的后缀命中与裸文件名命中；评分 = 行数够 (4) + 在文档作用域内 (2) + 非裸名且后缀命中 (1)，
 * 按分数降序、路径长度升序取首位。
 *
 * 用法：
 *   node src/scripts/check-doc-drift.mjs                 # 全仓 md
 *   node src/scripts/check-doc-drift.mjs AGENTS.md TODO.md ...
 *
 * 退出码：A / B / E / F / G / L / M 非空 → 1；C 与 D 只打印、不影响退出码。
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

/** 同步退避：无事件循环可 await，Atomics.wait 是 Node 的同步 sleep 惯用法。 */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** git 调用重试：并发或杀软占用下偶发 EBUSY（见 skills/websurf-env-traps）。3 次仍失败才抛出。 */
function gitRetry(args, n = 3) {
  for (let i = 1; ; i++) {
    try { return execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8'); }
    catch (e) { if (i >= n) throw e; sleepSync(200 * i); }
  }
}

/** 基础设施故障（git 不可用 / EBUSY）不等于「内容通过」：降级 WARN 并显式说明体检未完成。 */
let tracked;
try {
  tracked = gitRetry(['ls-files', '--cached', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean);
} catch (e) {
  console.log('[WARN] git 不可用（' + String((e && e.message) || e).slice(0, 120) + '）⇒ 本次体检未完成，不代表通过');
  process.exit(0);
}
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
// 已结案行（现为 agentmemory 条目）的 ID 也算已存在：悬空检查与重复检查都要认它。
// 机器可读来源 = progress/control-ids.json（控制层 ID 索引）。
let archIdsJson = [];
try { archIdsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'progress/control-ids.json'), 'utf8')).archived.t || []; } catch { }
const archRaw = '\n' + archIdsJson.map((id) => '| ' + id + ' |').join('\n');
const archIds = [...archRaw.matchAll(/\|\s*(T-\d{3})\s*\|/g)].map((m) => m[1]);
const todoIds = [...todoRaw.matchAll(/\|\s*(T-\d{3})\s*\|/g)].map((m) => m[1]).concat(archIds);
const todoSet = new Set(todoIds);
const dupRows = [...new Set(todoIds.filter((id, i) => todoIds.indexOf(id) !== i))].map((id) => `  ${todoPath}  ${id} 重复`);
const dangling = [];
const ownerPath = 'OWNER.md';                                   // owner 决策队列（控制层）
// 已决分卷（现为归档原文）里的 D-### 也算「已存在」——与 T-### 对称。
// 若不并入归档，OWNER.md 迁出的 D-### 引用会被判成悬空。
const ownerRaw = (fs.existsSync(path.join(ROOT, ownerPath)) ? fs.readFileSync(path.join(ROOT, ownerPath), 'utf8') : '')
  + ' ' + (() => { try { return (JSON.parse(fs.readFileSync(path.join(ROOT, 'progress/control-ids.json'), 'utf8')).archived.d || []).join(' '); } catch { return ''; } })();
const ownerSet = new Set([...ownerRaw.matchAll(/D-\d{3}/g)].map((m) => m[0]));
if (!ownerRaw) dangling.push('  缺少根 ' + ownerPath);
const noEvidence = [];                       // [G] 未结项的证据列不得为空（可为 `文件:行号` 或 `见详情`）
todoRaw.split(/\r?\n/).forEach((line) => {
  const s = line.trim();
  if (!s.startsWith('|') || /^\|[\s\-:|]+\|$/.test(s)) return;
  const c = s.split('|').slice(1, -1).map((x) => x.trim());
  if (c.length < 8 || !/^T-\d{3}$/.test(c[0])) return;
  if (!['已记录', '已结案'].includes(c[4]) && (!c[5] || c[5] === '—')) noEvidence.push(`  ${c[0]} 未结项但证据列为空`);
})
const statusClaim = [];
const STATUS_RE = /状态\s*[：:]\s*(待裁决|待修|已取证待立项|进行中|已记录|已结案|阻塞)/;
const isExempt = (f) => f.startsWith('progress/') || f === todoPath || f === 'AGENTS.md' || f === 'src/scripts/check-doc-drift.mjs' || f === 'src/scripts/docflow.mjs' || f === 'src/scripts/check-memory-sync.mjs';
if (!todoRaw) dangling.push(`  缺少根 ${todoPath}`);
for (const f of live) {
  if (!/\.(md|ts|rs|mjs|js|json|html|css|yml|toml)$/.test(f)) continue;
  const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/T-\d{3}/g)) if (!todoSet.has(m[0])) dangling.push(`  ${f}:${i + 1}  ${m[0]} 不在 ${todoPath}`);
    if (!isExempt(f) && STATUS_RE.test(line)) statusClaim.push(`  ${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
  });
}

// [G] ⑦ 进行中的行必须带认领（进行中 · <agent> · <YYYY-MM-DD>）；待修行判据缺失只计数（D-001 补齐后转硬门）
const badClaim = [];
const badCrit = [];
let critPending = 0;
todoRaw.split(/\r?\n/).forEach((line) => {
  const s = line.trim();
  if (!s.startsWith('|') || /^\|[\s\-:|]+\|$/.test(s)) return;
  const c = s.split('|').slice(1, -1).map((x) => x.trim());
  if (c.length < 9 || !/^T-\d{3}$/.test(c[0])) return;
  if (c[4].startsWith('进行中') && !/^进行中 · .+ · \d{4}-\d{2}-\d{2}$/.test(c[4])) badClaim.push('  ' + c[0] + ' 进行中缺认领（应为 进行中 · <agent> · <YYYY-MM-DD>）');
  if (['待修', '进行中', '阻塞'].indexOf(c[4]) >= 0 && c[7] === '[待补]') { critPending++; badCrit.push('  ' + c[0] + ' 判据仍是 [待补]（D-001：待修必须有可执行判据）'); }
})

// [G] ⑧ 文档树导航覆盖——仓库已无文档树（documents/** 迁入 agentmemory），恒为空。
const idxRaw = '';
const idxMissing = [];

// [G] ⑥ 全仓任何 D-###（owner 决策编号）都必须在 OWNER.md 里真实存在
for (const f of live) {
  if (!/\.(md|ts|rs|mjs|js|json|html|css|yml|toml)$/.test(f)) continue;
  const dlines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
  dlines.forEach((line, i) => {
    for (const m of line.matchAll(/D-\d{3}/g)) if (!ownerSet.has(m[0])) dangling.push('  ' + f + ':' + (i + 1) + '  ' + m[0] + ' 不在 ' + ownerPath + '（或 progress/control-ids.json 的已决归档 ID）');
  });
}

// ===== [H] 流程文档体积 =====
const sizeBad = [];
const caps = [['AGENTS.md', 32], ['TODO.md', 96], ['OWNER.md', 16]];
for (const pair of caps) {
  const f = pair[0];
  if (!fs.existsSync(path.join(ROOT, f))) continue;
  const kb = fs.statSync(path.join(ROOT, f)).size / 1024;
  if (kb > pair[1]) sizeBad.push('  ' + f + ' 已 ' + kb.toFixed(1) + ' KB（上限 ' + pair[1] + ' KB；见 AGENTS §0.4）');
}
for (const f of live) {
  const isProc = false; // 仓库已无过程记录与文档树（皆迁入 agentmemory）
  const isRoot = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md'].indexOf(f) >= 0;
  if (!isProc && !isRoot) continue;
  const kb = fs.statSync(path.join(ROOT, f)).size / 1024;
  if (kb > 48) sizeBad.push('  ' + f + ' 已 ' + kb.toFixed(1) + ' KB（流程性 md 上限 48 KB；见 AGENTS §0.4）');
}

// ===== [I] 过程记录分卷可达（仓库已无过程记录卷：进展直接写 agentmemory，无导航文件） =====
const piRaw = '';
const piMissing = [];

// ===== [J] 代码注释纪律（in-file 块 >20 行 / 文件头 >60 行只计数；单行 >160 字符硬门） =====
const cmtInFile = [];
const cmtHead = [];
let cmtLong = 0;
for (const f of live) {
  if (!/^(src|apps)\//.test(f) || !/\.(ts|rs|mjs|js)$/.test(f)) continue;
  const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
  let run = 0; let start = 0; let head = 0; let seenCode = false;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    const isC = /^(\/\/|\/\*|\*)/.test(s) && s.length > 0;
    if (!seenCode) { if (isC || s.indexOf('#!') === 0) head++; else if (s !== '') seenCode = true; }
    if (isC) {
      if (run === 0) start = i + 1;
      run++;
      if (s.length > 160) cmtLong++;
    } else {
      if (run > 20 && start > 1 && !(start === 2 && lines[0].indexOf('#!') === 0)) cmtInFile.push(f + ':' + start + '（' + run + ' 行）');
      run = 0;
      if (s !== '') seenCode = true;
    }
  }
  if (run > 20 && start > 1 && !(start === 2 && lines[0].indexOf('#!') === 0)) cmtInFile.push(f + ':' + start + '（' + run + ' 行）');
  if (head > 60) cmtHead.push(f + '（' + head + ' 行）');
}

// [G] ⑤ 未结项的「详情」列必须非空且每个路径都能解析（支持 ；;、 分隔的多路径）
const badDetail = [];
todoRaw.split(/\r?\n/).forEach((line) => {
  const s = line.trim();
  if (!s.startsWith('|') || /^\|[\s\-:|]+\|$/.test(s)) return;
  const c = s.split('|').slice(1, -1).map((x) => x.trim());
  if (c.length < 8 || !/^T-\d{3}$/.test(c[0])) return;
  if (['已记录', '已结案'].includes(c[4])) return;
  const parts = (c[6] || '').split(/[；;、]/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) { badDetail.push(`  ${c[0]} 未结项但详情列为空`); return; }
  parts.forEach((d) => {
    if (fs.existsSync(d) || fs.existsSync(d + '.md')) return;
    badDetail.push(`  ${c[0]} 详情无法解析：${d}`);
  });
})

// [G] ④ 两份表示同源：「未结项」列表的 ID 集合必须等于总表里未结的 ID 集合
const tableOpen = new Set();
todoRaw.split(/\r?\n/).forEach((line) => {
  const s = line.trim();
  if (!s.startsWith('|') || /^\|[\s\-:|]+\|$/.test(s)) return;
  const c = s.split('|').slice(1, -1).map((x) => x.trim());
  if (c.length < 8 || !/^T-\d{3}$/.test(c[0])) return;
  if (!['已记录', '已结案'].includes(c[4])) tableOpen.add(c[0]);
})
const bulletSet = new Set([...todoRaw.matchAll(/^- \*\*(T-\d{3})\*\*/gm)].map((m) => m[1]));
const outOfSync = [
  ...[...bulletSet].filter((id) => !tableOpen.has(id)).map((id) => `  ${todoPath} 列表里有 ${id}，总表未结里没有`),
  ...[...tableOpen].filter((id) => !bulletSet.has(id)).map((id) => `  ${todoPath} 总表未结有 ${id}，列表里没有`),
];

// [K] 每个 md 都必须被 AGENTS §2 的「仓库内 md 清单」点到（仓库已无文档树与过程卷）
const agentsRaw = fs.existsSync(path.join(ROOT, 'AGENTS.md')) ? fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8') : '';
const parentMiss = [];
for (const f of live) {
  if (!f.endsWith('.md')) continue;
  const parts = f.split('/');
  const ok = f === 'AGENTS.md' || agentsRaw.includes(f) || agentsRaw.includes(parts.slice(0, -1).join('/') + '/') || agentsRaw.includes(parts[0] + '/**');
  if (!ok) parentMiss.push('  ' + f + ' 没有被 AGENTS §2 的 md 清单点到');
}

// [L] 文档缺口 ↔ 看板状态：终态行（已记录/已结案）的「详情」doc 里若仍引用该号，必须已标注解除
const RESOLVED_RE = /已消除|已修|已处置|已结案|已判定无需行动|已撤销|~~/;
const TERMINAL = ['已记录', '已结案'];
const boardRows = [];
todoRaw.split(/\r?\n/).forEach((line) => {
  const s = line.trim();
  if (!s.startsWith('|') || /^\|[\s\-:|]+\|$/.test(s)) return;
  const c = s.split('|').slice(1, -1).map((x) => x.trim());
  if (c.length < 9 || !/^T-\d{3}$/.test(c[0])) return;
  boardRows.push(c);
});
const docGap = [];
const falseClose = [];
boardRows.forEach((c) => {
  if (!TERMINAL.includes(c[4])) return;
  // [L]
  (c[6] || '').split(/[；;、]/).map((x) => x.trim()).filter((d) => d.startsWith('documents/') && d.endsWith('.md')).forEach((d) => {
    const fp = path.join(ROOT, d);
    if (!fs.existsSync(fp)) return;
    fs.readFileSync(fp, 'utf8').split(/\r?\n/).forEach((dl, i) => {
      if (!dl.includes(c[0]) || RESOLVED_RE.test(dl)) return;
      docGap.push('  ' + c[0] + '（' + c[4] + '）的详情 ' + d + ':' + (i + 1) + ' 仍把它写成活缺口 ⇒ 标「已消除（YYYY-MM-DD）+ 原因」或删该段');
    });
  });
  // [M]
  const crit = (c[7] || '').replace(/@BT@/g, '`');
  const gm = crit.match(/git grep[^`]*?"([^"]+)"(?:[^`]*?--\s*([^`]+))?/);
  if (!gm || !/0 命中/.test(crit)) return;
  const pat = gm[1];
  const critPaths = (gm[2] || '').trim().split(/\s+/).filter((x) => /^[A-Za-z0-9_./-]+$/.test(x));
  const run = (args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return ''; } };
  if (critPaths.length) {
    const own = run(['grep', '-n', '-e', pat, '--'].concat(critPaths));
    if (own) falseClose.push('  ' + c[0] + '（' + c[4] + '）判据声明 0 命中，实测其自身路径仍有命中 ⇒ 结案依据不成立');
  }
  const evm = (c[5] || '').replace(/`/g, '').match(/([A-Za-z0-9_./-]+\.(?:d\.ts|json|mts|mjs|cjs|ts|js|rs|md|cmd|ps1|sh|yml|yaml|html|css|toml))(?::\d+)?/);
  if (evm && !/\.md$/.test(evm[1]) && fs.existsSync(path.join(ROOT, evm[1]))) {
    const evHit = run(['grep', '-n', '-e', pat, '--', evm[1]]);
    if (evHit) falseClose.push('  ' + c[0] + '（' + c[4] + '）判据在 ' + critPaths.join(' ') + ' 判 0 命中，但证据文件 ' + evm[1] + ' 仍命中「' + pat + '」 ⇒ 判据范围可疑（假结案）');
  }
});

// [N] 脚本与部署链契约（脚本登记见 AGENTS §3.1）
const normRel = 'AGENTS.md';
const normRaw = fs.existsSync(path.join(ROOT, normRel)) ? fs.readFileSync(path.join(ROOT, normRel), 'utf8') : '';
const contract = [];
const appsDir = path.join(ROOT, 'apps');
const appNames = fs.existsSync(appsDir) ? fs.readdirSync(appsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
const ciRaw = live.filter((f) => f.startsWith('.github/workflows/')).map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
for (const a of appNames) {
  const sd = path.join(appsDir, a, 'scripts');
  const pkg = fs.existsSync(path.join(appsDir, a, 'package.json')) ? fs.readFileSync(path.join(appsDir, a, 'package.json'), 'utf8') : '';
  if (fs.existsSync(sd)) {
    for (const f of fs.readdirSync(sd).filter((x) => !x.startsWith('_') && /\.(mjs|js)$/.test(x))) {
      const rel = 'apps/' + a + '/scripts/' + f;
      if (!live.includes(rel)) continue;
      if (pkg.includes(f) || ciRaw.includes(f)) continue;
      if (fs.readdirSync(sd).some((o) => o !== f && fs.readFileSync(path.join(sd, o), 'utf8').includes(f))) continue;
      const exempted = normRaw.split(/\r?\n/).some((l) => /^-\s/.test(l.trim()) && l.includes('`' + rel + '`'));
      if (exempted) continue;
      contract.push('  ' + rel + ' 引用面为 0（本工程 package.json / CI / 同族脚本都没提它）⇒ 接线或登记进 AGENTS.md §3.1');
    }
  }
  for (const f of fs.readdirSync(path.join(appsDir, a)).filter((x) => x.endsWith('.cmd'))) {
    const rel = 'apps/' + a + '/' + f;
    const t = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (!/@echo off/i.test(t)) contract.push('  ' + rel + ' 缺 @echo off');
    if (!/exit\s*\/b/i.test(t)) contract.push('  ' + rel + ' 缺 exit /b（退出码口径）');
    if (/C:\\Users\\/i.test(t)) contract.push('  ' + rel + ' 写死了用户目录（换机器即失效）');
    const cmdLines = t.split(/\r?\n/);
    cmdLines.forEach((l, i) => {
      // 死分支：`goto :x` 的下一行就是 `:x` ⇒ 条件不改变任何行为（T-629 的 dev.cmd 端口守卫）
      const m = /^\s*(?:if\s+.*?\s+)?goto\s+:?([A-Za-z0-9_]+)\s*$/i.exec(l);
      if (m && (cmdLines[i + 1] ?? '').trim() === ':' + m[1]) {
        contract.push('  ' + rel + ':' + (i + 1) + ' `goto :' + m[1] + '` 的下一行就是该标签 ⇒ 死分支（检查不改变行为）');
      }
      // echo 行里未转义的 `>`（如 `->`）会被 cmd 当重定向：该行不打印，还生成一个杂散文件（T-642 实测）
      if (/^\s*@?echo\b/i.test(l) && /(?<!\^)>/.test(l)) {
        contract.push('  ' + rel + ':' + (i + 1) + ' echo 行含未转义 `>` ⇒ 会被当成重定向（不打印 + 生成杂散文件），应写 `^>`');
      }
    });
  }
}
const depRel = '.github/workflows/deploy-pages.yml';
if (fs.existsSync(path.join(ROOT, depRel))) {
  const dep = fs.readFileSync(path.join(ROOT, depRel), 'utf8');
  const mm = dep.match(/matrix:\s*\n\s*app:\s*\[([^\]]*)\]/);
  if (mm) {
    const listed = mm[1].split(',').map((x) => x.trim()).filter(Boolean);
    if (listed.slice().sort().join(',') !== appNames.slice().sort().join(',')) contract.push('  ' + depRel + ' matrix.app=[' + listed.join(',') + '] 与 apps/ 目录 [' + appNames.join(',') + '] 不一致');
  } else contract.push('  ' + depRel + ' 未找到 matrix.app 清单');
  const loop = dep.match(/for app in ([^\n;]+)/);
  if (loop) {
    const inLoop = loop[1].trim().split(/\s+/).filter(Boolean);
    if (inLoop.slice().sort().join(',') !== appNames.slice().sort().join(',')) contract.push('  ' + depRel + ' 装配段 for app in [' + inLoop.join(',') + '] 与 apps/ 目录 [' + appNames.join(',') + '] 不一致');
  }
}

// ===== [P] 本机路径：公开仓库不得出现私人目录 / 本机绝对路径（规则见 agentmemory `websurf/documents/norms/local-path-hygiene.md`） =====
const localPat = [
  [/[A-Za-z]:[\\/][Uu]sers[\\/][A-Za-z0-9]/, 'Windows 用户目录'],
  [/[A-Za-z]:[\\/]Documents and Settings[\\/][A-Za-z0-9]/, 'Windows 旧式用户目录'],
  [/[\\/][Uu]sers[\\/][A-Za-z0-9][A-Za-z0-9._-]*/, 'Unix 家目录'],
  [/[\\/]home[\\/][A-Za-z0-9][A-Za-z0-9._-]*/, 'Linux 家目录'],
  [/[A-Za-z]:[\\/](?:code|projects|dev|work)[\\/][A-Za-z0-9]/, '本机工作区绝对路径'],
];
/** 占位符豁免：规则篇与文档举例要能写出「形状」而不算泄漏。 */
const LOCAL_PLACEHOLDER = /<用户>|<本机用户>|<本地工作区>|<仓库根>|<盘符>|<真名>/g;
const localPath = [];
for (const f of live) {
  if (!TEXT_EXT.test(f)) continue;
  fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
    const s = line.replace(LOCAL_PLACEHOLDER, '');
    for (const [re, why] of localPat) if (re.test(s)) { localPath.push('  ' + f + ':' + (i + 1) + '  ' + why + '：' + line.trim().slice(0, 100)); break; }
  });
}
// [O] 文档契约（docflow）：口径与实现在 src/scripts/docflow.mjs，这里只取它的退出码与逐条明细
const docflow = [];
const docflowWarn = [];
/** docflow 把「git 基础设施故障」降级为 [WARN] 且 exit 0；这里必须还原成可见的告警而不是静默丢掉。 */
const splitDocflow = (out) => {
  for (const l of String(out).split('\n')) {
    if (!l.trim()) continue;
    (l.includes('[WARN]') ? docflowWarn : docflow).push('  ' + l.trim());
  }
};
try {
  splitDocflow(execFileSync('node', ['src/scripts/docflow.mjs', 'check', '--quiet'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
} catch (e) {
  const out = String(e.stdout || '').trim();
  if (out) splitDocflow(out);
  else docflow.push('  docflow check 非 0 退出（排查：node src/scripts/docflow.mjs check）');
}

const fail = drift.length || badAnchor.length || missing.length || localPath.length || broken.length || eolBad.length || dangling.length || statusClaim.length || dupRows.length || noEvidence.length || outOfSync.length || badDetail.length || badClaim.length || idxMissing.length || badCrit.length || sizeBad.length || piMissing.length || cmtLong || parentMiss.length || docGap.length || falseClose.length || contract.length || docflow.length;
console.log(`文档漂移体检：${mds.length} 篇 md ｜ 行数声明 ${claims}（漂移 ${drift.length}）｜锚点 ${anchors}（越界 ${badAnchor.length}）｜路径失效 ${missing.length} ｜本机路径 ${localPath.length} ｜歧义未判 ${ambiguous} ｜坏链 ${broken.length} ｜行尾/BOM ${eolBad.length} ｜待办同源 ${dangling.length + statusClaim.length + dupRows.length + noEvidence.length + outOfSync.length + badDetail.length + badClaim.length + idxMissing.length + badCrit.length + sizeBad.length + piMissing.length + cmtLong + parentMiss.length} ｜ 注释超长 ${cmtInFile.length} 块/${cmtHead.length} 头 ｜ 待修补判据 ${critPending} ｜ 缺口未标注 ${docGap.length} ｜ 假结案 ${falseClose.length} ｜ 脚本/入口契约 ${contract.length} ｜ 文档契约 ${docflow.length}`);
const todoKB = Buffer.byteLength(todoRaw, 'utf8') / 1024;
const todoRowCount = (todoRaw.match(/^\|\s*T-\d{3}\s*\|/gm) || []).length;
if (todoRaw && (todoKB > 80 || todoRowCount > 300)) console.log(`\n[提示] ${todoPath} 已 ${todoKB.toFixed(1)} KB / ${todoRowCount} 条，已达**提前分卷线 80 KB**（硬上限 96 KB / 300 条，见 AGENTS §0.4）——按头注的分卷规则处理「已记录 + 已结案」`);
if (drift.length) console.log('\n[A] 行数声明漂移（失败）：\n' + drift.join('\n'));
if (badAnchor.length) console.log('\n[B] 锚点越界（失败）：\n' + badAnchor.join('\n'));
if (missing.length) console.log('\n[C] 路径失效（失败）：\n' + [...new Set(missing)].map((s) => '  ' + s).join('\n') + '\n  —— 指向的文件必须真实存在；历史叙述请改写为纯文本（不要写成 `path:line` 或 `path(N)`）');
if (ambiguous) { const inProg = Object.entries(ambByDoc).filter(([k]) => k.startsWith(`progress/`)).reduce((s, [, v]) => s + v, 0); console.log(`\n[D] 歧义 ${ambiguous} 处（跨工程文档的裸文件名，需人工判读；非错误）｜规范面 ${ambiguous - inProg} 处、progress/ 过程记录 ${inProg} 处`); }
if (broken.length) console.log('\n[E] 坏链（失败）：\n' + broken.join('\n'));
if (eolBad.length) console.log('\n[F] 行尾/BOM（失败）：\n' + [...new Set(eolBad)].join('\n'));
const pendCount = boardRows.filter((c) => c[4] === '待裁决').length;
if (pendCount > 50) console.log('\n[提示·待裁决压力] 待裁决 ' + pendCount + ' 条（阈值 50）——按 `AGENTS §0.1` 第 8 条：每轮先清一批再取新活。');
if (localPath.length) console.log('\n[P] 本机路径（失败）：\n' + [...new Set(localPath)].join('\n') + '\n  —— 规则与处置见 agentmemory `websurf/documents/norms/local-path-hygiene.md`');
if (docflowWarn.length) console.log('\n[WARN] 文档契约 docflow 未完成：\n' + [...new Set(docflowWarn)].join('\n') + '\n  —— 基础设施故障，不是契约通过');
if (docflow.length) console.log('\n[O] 文档契约 docflow（失败）：\n' + docflow.join('\n'));
if (contract.length) console.log('\n[N] 脚本与部署链契约（失败）：\n' + contract.join('\n'));
if (docGap.length) console.log('\n[L] 文档缺口未标注（失败）：\n' + docGap.join('\n'));
if (falseClose.length) console.log('\n[M] 假结案（失败）：\n' + falseClose.join('\n'));
if (dangling.length || statusClaim.length || dupRows.length || noEvidence.length || outOfSync.length || badDetail.length || badClaim.length || idxMissing.length || badCrit.length || sizeBad.length || piMissing.length || cmtLong || parentMiss.length) console.log('\n[G] 待办同源（失败）：\n' + [...dangling, ...dupRows, ...statusClaim, ...noEvidence, ...outOfSync, ...badDetail, ...badClaim, ...badCrit, ...sizeBad, ...piMissing, ...idxMissing, ...parentMiss].join('\n'));

process.exit(fail ? 1 : 0);
