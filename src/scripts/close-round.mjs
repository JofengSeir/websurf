#!/usr/bin/env node
/**
 * 收尾单一入口：把「写进展」压成两步，并让「改了代码没留痕」可判定。
 *
 *  ① 生成本轮进展条目（写归档原文 + 算 marker + 打印可直接调用的 memory_save）
 *     node src/scripts/close-round.mjs --note <正文> [--slug <名>] [--task T-###]
 *  ② 登记结果（补台账 + 跑四道门禁 + 打印提交模板）
 *     node src/scripts/close-round.mjs --done --marker <marker> --id <memoryId>
 *  ③ 检查「改了代码但没留痕」（本仓规则：改代码须看板留痕 + 本轮进展）
 *     node src/scripts/close-round.mjs --check-round [--staged] [--soft]
 *
 * 知识库不可用时改用 kb-fallback queue（条目同样落 progress/pending-kb.jsonl）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = path.join(ROOT, 'progress/memory-index.jsonl');
const QUEUE = path.join(ROOT, 'progress/pending-kb.jsonl');
const ARCHIVE = path.join(ROOT, 'archive/memory');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : (d === undefined ? '' : d); };
const has = (k) => process.argv.includes('--' + k);
const sh = (c) => { const p = spawnSync(c, { shell: true, cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }); return { code: p.status, out: ((p.stdout || '') + (p.stderr || '')).trim() }; };
const hash12 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const slugify = (s) => s.replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);

function make() {
  const text = arg('note') || (arg('note-file') ? fs.readFileSync(path.resolve(ROOT, arg('note-file')), 'utf8') : '');
  if (!text) { console.error('缺 --note <正文> 或 --note-file <路径>'); process.exit(2); }
  const date = new Date().toISOString().slice(0, 10);
  const src = arg('source') || ('progress/notes/' + date + '-' + (arg('slug') || slugify(text) || 'round') + '.md');
  const abs = path.join(ARCHIVE, date.slice(0, 7), src);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const body = text.endsWith('\n') ? text : text + '\n';
  fs.writeFileSync(abs, body, 'utf8');
  const s12 = hash12(body);
  const marker = 'websurf/' + src + '#index0@' + s12;
  fs.writeFileSync(abs + '.meta.json', JSON.stringify({ source: src, sha256: hash12(body), sha12: s12, bytes: Buffer.byteLength(body), at: date, note: '收尾进展（close-round）', entries: [marker] }, null, 2) + '\n', 'utf8');
  const content = ['[线索] ' + marker, '主题：本轮进展 ' + String(arg('task', '')).slice(0, 20), '路径：' + src + '（索引）', '小节：', '  本轮进展', '摘要：' + body.split('\n')[0].slice(0, 80), '---', body.replace(/\n$/, '')].join('\n');
  console.log('归档原文: ' + path.relative(ROOT, abs).replace(/\\/g, '/'));
  console.log('marker   : ' + marker);
  console.log('');
  console.log('第 1 步：用 MCP 写这条条目（参数如下）：');
  console.log(JSON.stringify({ project: 'websurf', type: 'workflow', concepts: 'websurf,进展', files: src, content }, null, 1));
  console.log('');
  console.log('第 2 步：node src/scripts/close-round.mjs --done --marker ' + marker + ' --id <上一步返回的 id>');
  console.log('（知识库不可用：node src/scripts/kb-fallback.mjs queue --marker ' + marker + ' --note <正文>）');
}

function done() {
  const marker = arg('marker'); const id = arg('id');
  if (!marker || !id) { console.error('缺 --marker 与 --id'); process.exit(2); }
  const m = marker.match(/^websurf\/(.+)#(\w+)(\d+)@([0-9a-f]{12})$/);
  if (!m) { console.error('marker 形状不合法：' + marker); process.exit(2); }
  const src = m[1]; const abs = path.join(ARCHIVE, new Date().toISOString().slice(0, 7), src);
  if (!fs.existsSync(abs)) { console.error('归档原文不存在：' + src + ' ⇒ 先跑 ①（不带 --done）'); process.exit(2); }
  const cur = hash12(fs.readFileSync(abs, 'utf8'));
  if (cur !== m[4]) { console.error('marker 的 sha12 与归档原文不符（' + m[4] + ' vs ' + cur + '）⇒ 用 ① 打印的 marker'); process.exit(2); }
  const row = { marker, source: src, kind: m[2], seq: Number(m[3]), memoryId: id, at: new Date().toISOString().slice(0, 10), retired: true, shape: 'snapshot' };
  if (arg('task')) row.task = arg('task');
  const lines = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean) : [];
  if (lines.some((l) => l.includes(marker))) { console.log('台账已有该 marker，跳过追加'); } else { lines.push(JSON.stringify(row)); fs.writeFileSync(LEDGER, lines.join('\n') + '\n', 'utf8'); console.log('台账 +1 ⇒ ' + lines.length + ' 行'); }
  const q = fs.existsSync(QUEUE) ? fs.readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean) : [];
  const rest = q.filter((l) => !l.includes(marker));
  if (rest.length !== q.length) { fs.writeFileSync(QUEUE, rest.map((l) => l).join('\n') + (rest.length ? '\n' : ''), 'utf8'); console.log('待补写队列 -1 ⇒ ' + rest.length + ' 条'); }
  if (!has('no-gates')) {
    console.log('');
    console.log('四道门禁：');
    for (const c of ['node src/scripts/check-doc-drift.mjs', 'node src/scripts/check-memory-sync.mjs', 'node src/scripts/check-memory-sync.mjs --keys', 'node src/scripts/docflow.mjs check']) {
      const r = sh(c);
      console.log('  exit=' + r.code + '  ' + c.replace('node ', ''));
      if (r.code !== 0) console.log(r.out.split('\n').slice(0, 6).map((l) => '    ' + l).join('\n'));
    }
  }
  console.log('');
  console.log('提交模板：' + (arg('task') ? arg('task') + ' ' : '') + '<一句话>（无待办影响 / T-###）');
}

function checkRound() {
  const staged = has('staged');
  const files = sh(staged ? 'git diff --cached --name-only' : ('git diff --name-only ' + arg('base', 'origin/main'))).out.split('\n').filter(Boolean);
  const code = files.filter((f) => /^(apps|src)\//.test(f) && !/^src\/scripts\//.test(f));
  if (!code.length) { console.log('本轮没有代码改动（apps/** 或 src/**），无需留痕检查'); process.exit(0); }
  const todo = files.includes('progress/board.jsonl');
  const led = files.includes('progress/memory-index.jsonl');
  const gap = [];
  if (!todo) gap.push('  改了 ' + code.length + ' 个代码文件，但本轮没有 progress/board.jsonl 改动（改代码须看板留痕）');
  if (!led) gap.push('  改了 ' + code.length + ' 个代码文件，但本轮没有新的进展条目（progress/memory-index.jsonl 没有新增行）');
  if (!gap.length) { console.log('留痕检查通过：' + code.length + ' 个代码文件 + progress/board.jsonl + 进展台账'); process.exit(0); }
  console.log((has('soft') ? '[提示] ' : '[留痕缺口] ') + '本轮代码改动缺留痕：');
  gap.forEach((g) => console.log(g));
  console.log('  补法：node src/scripts/close-round.mjs --note <正文> …（见 --help 头注释）');
  process.exit(has('soft') ? 0 : 1);
}

if (has('check-round')) checkRound();
else if (has('done')) done();
else if (has('help') || process.argv.length <= 2) { console.log('用法见本脚本头部注释（① 生成条目 ② --done 登记 ③ --check-round 留痕检查）'); }
else make();
