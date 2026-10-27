/**
 * WebSurf agent 记忆/交接的**唯一入口**（弱 agent 也不容易卡）。
 *
 * 为什么有这一层：AMH 原 client 的命令能直接跑，但要求 agent 记住 --app、brief/handoff 的
 * 字段、gateway 失败时要停；不同 agent 能力不一样，容易在这些地方卡住。本脚本把
 * 「开工读、过程中存、收尾交接」收成三条命令，并且 **gateway 不可用时落本地 outbox、
 * 不阻塞**（下次 gateway 恢复用 flush 补写）。
 *
 * 用法（仓库根）：
 *   node src/scripts/agent-memory.mjs brief [--limit 10]
 *   node src/scripts/agent-memory.mjs save --content "..." [--type fact] [--concepts "a,b"] [--files "a.ts,b.ts"]
 *   node src/scripts/agent-memory.mjs handoff --content "..." [--next "..."] [--task T-650] [--status partial] [--files "..."]
 *   node src/scripts/agent-memory.mjs flush [--dry-run]
 *   node src/scripts/agent-memory.mjs doctor
 *
 * 通用参数：--app <name>（默认 dsh；不知道就用默认）、--dry-run、--offline（模拟 gateway 不可用）。
 *
 * 位置：
 *   - gateway 路径读 `.amh/gateway.path`（本机 gitignore 文件）；可用 AMH_GATEWAY 覆盖。
 *   - client 路径 = <gateway>/bin/client.mjs；可用 AMH_CLIENT 覆盖。
 *   - 离线 outbox = `.dsh/amh-outbox/*.json`（`.dsh/` 已 gitignore）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUTBOX = join(ROOT, '.dsh', 'amh-outbox');
const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'brief';

function opt(name, fallback = null) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
function flag(name) {
  return argv.includes('--' + name);
}

const APP = opt('app', process.env.AMH_APP ?? 'dsh');
const DRY = flag('dry-run');
const OFFLINE = flag('offline') || process.env.AMH_OFFLINE === '1';

function gatewayDir() {
  if (process.env.AMH_GATEWAY) return process.env.AMH_GATEWAY;
  const p = join(ROOT, '.amh', 'gateway.path');
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  return null;
}
function clientPath() {
  if (process.env.AMH_CLIENT) return process.env.AMH_CLIENT;
  const gw = gatewayDir();
  return gw ? join(gw, 'bin', 'client.mjs') : null;
}

function ensureOutbox() {
  if (!existsSync(OUTBOX)) mkdirSync(OUTBOX, { recursive: true });
}
function outboxFiles() {
  if (!existsSync(OUTBOX)) return [];
  return readdirSync(OUTBOX)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(OUTBOX, f));
}
function writeOutbox(kind, args) {
  ensureOutbox();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(OUTBOX, `${stamp}-${kind}.json`);
  writeFileSync(file, JSON.stringify({ kind, createdAt: new Date().toISOString(), argv: { app: APP, ...args } }, null, 2), 'utf8');
  return file;
}

/** 调 AMH client；成功返回解析后的 JSON，失败返回 { ok:false, error }。 */
function callClient(args) {
  if (OFFLINE) return { ok: false, error: 'AMH_OFFLINE/--offline 模拟不可用' };
  const client = clientPath();
  if (!client || !existsSync(client)) return { ok: false, error: '找不到 AMH client（.amh/gateway.path 或 AMH_CLIENT）' };
  const r = spawnSync(process.execPath, [client, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || out || `client exit ${r.status}`).slice(0, 2000) };
  }
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end < start) return { ok: false, error: 'client 输出不是 JSON：' + out.slice(0, 500) };
  try {
    return { ok: true, data: JSON.parse(out.slice(start, end + 1)) };
  } catch (e) {
    return { ok: false, error: 'client JSON 解析失败：' + String(e) };
  }
}

function requireContent() {
  const content = opt('content');
  if (!content || !content.trim()) {
    console.error('缺少 --content（写清楚改了什么/决定是什么；不要空壳交接）');
    console.error('例：node src/scripts/agent-memory.mjs handoff --content "渲染收口完成，提交 88d652b" --next "验收 boreas/666"');
    process.exit(2);
  }
  return content;
}

function summarizeHandoff(h) {
  const o = h.observation ?? h;
  const title = o.title ?? o.narrative ?? '';
  const text = (o.facts?.[0] ?? o.narrative ?? title ?? '').replace(/\s+/g, ' ').trim();
  const status = /status=([^;]+)/.exec(text)?.[1]?.trim();
  const next = /next=([^;]+)/.exec(text)?.[1]?.trim();
  const task = (o.concepts ?? []).find((c) => String(c).startsWith('task:'))?.slice(5) ?? '';
  return { id: o.id ?? '', task, status, next, title: text.slice(0, 180), at: o.timestamp ?? o.createdAt ?? '' };
}

function brief() {
  const limit = Number(opt('limit', '10'));
  const days = Number(opt('days', '3'));
  const r = callClient(['brief', '--app', APP, '--limit', String(limit)]);
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? '?';
  const dirty = (spawnSync('git', ['status', '--short'], { cwd: ROOT, encoding: 'utf8' }).stdout ?? '').trim();
  const offline = outboxFiles();
  console.log(`[agent-memory] project=WEBSURF app=${APP} gateway=${r.ok ? 'up' : 'DOWN'} HEAD=${head} worktree=${dirty ? 'DIRTY' : 'clean'}`);
  console.log(`[agent-memory] outbox=${offline.length} 个待补写${offline.length ? '（gateway 恢复后跑 flush）' : ''}`);
  if (!r.ok) {
    console.log(`[agent-memory] gateway 不可用：${r.error}`);
    console.log('[agent-memory] 不阻塞：先按 AGENTS.md 的代码/构建流程做，决定与交接落 outbox（save/handoff 会自动写）。');
  } else {
    const handoffList = (Array.isArray(r.data.handoffs) ? r.data.handoffs : (r.data.handoffs?.results ?? []))
      // brief 的 handoffs 有时把普通 workflow 写入也带进来；只保留真正的 HANDOFF 记录
      .filter((h) => {
        const o = h.observation ?? h;
        const text = String(o.facts?.[0] ?? o.narrative ?? o.title ?? '');
        return /^HANDOFF\b/.test(text);
      });
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const sorted = handoffList
      .map(summarizeHandoff)
      .filter((h) => {
        const t = Date.parse(h.at);
        return Number.isFinite(t) && t >= cutoff;
      })
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    // 同一 task 只留最新一条；否则 T-650 的十几条旧 handoff 会把 brief 淹没
    const byTask = new Map();
    for (const h of sorted) {
      const key = h.task || '(no task)';
      if (!byTask.has(key)) byTask.set(key, h);
    }
    const handoffs = [...byTask.values()].slice(0, 3);
    console.log(`--- 最近 ${days} 天 handoff（每个 task 只留最新一条；更早用 recall）---`);
    if (!handoffs.length) console.log(`（最近 ${days} 天无 handoff；更早用 recall "<关键词>"）`);
    for (const h of handoffs) {
      console.log(`- ${h.task || '(no task)'} | ${h.status || '(no status)'} | ${h.at}`);
      console.log(`  ${h.title || '(empty)'}`);
      if (h.next) console.log(`  next: ${h.next.slice(0, 240)}`);
    }
    const recent = (r.data.recent ?? []).slice(0, 5);
    console.log('--- 最近写入（最多 5 条）---');
    if (!recent.length) console.log('（无）');
    for (const x of recent) console.log(`- [${x.type ?? '?'}] ${String(x.title ?? x.id ?? '').slice(0, 160)}`);
  }
  console.log('--- 下一步 ---');
  console.log('先读 AGENTS.md；改完跑三端 typecheck/相关构建；收尾用 agent-memory handoff。');
}

function save() {
  const content = requireContent();
  const type = opt('type', 'fact');
  const concepts = opt('concepts', `app:${APP}`);
  const files = opt('files');
  const args = ['save', '--app', APP, '--content', content, '--type', type, '--concepts', concepts];
  if (files) args.push('--files', files);
  if (DRY) {
    console.log('[agent-memory] dry-run: ' + [clientPath() || '<client>', ...args].join(' '));
    return;
  }
  const r = callClient(args);
  if (r.ok) {
    const id = r.data?.memory?.id ?? r.data?.id ?? null;
    console.log(`[agent-memory] saved${id ? ' id=' + id : ''}`);
    return;
  }
  const file = writeOutbox('save', { content, type, concepts, files });
  console.log(`[agent-memory] gateway 不可用，已落 outbox：${file}`);
  console.log('[agent-memory] 继续工作；提交信息写 AMH: down，gateway 恢复后 flush。');
}

function handoff() {
  const content = requireContent();
  const task = opt('task', 'agent-flow');
  const status = opt('status', 'partial');
  const next = opt('next', '未填写：下一个 agent 需补充');
  const files = opt('files');
  const args = ['handoff', '--app', APP, '--task', task, '--status', status, '--content', content, '--next', next];
  if (files) args.push('--files', files);
  if (DRY) {
    console.log('[agent-memory] dry-run: ' + [clientPath() || '<client>', ...args].join(' '));
    return;
  }
  const r = callClient(args);
  if (r.ok) {
    const id = r.data?.memory?.id ?? r.data?.id ?? null;
    console.log(`[agent-memory] handoff${id ? ' id=' + id : ''} task=${task} status=${status}`);
    return;
  }
  const file = writeOutbox('handoff', { task, status, content, next, files });
  console.log(`[agent-memory] gateway 不可用，已落 outbox：${file}`);
  console.log('[agent-memory] 继续工作；提交信息写 AMH: down，gateway 恢复后 flush。');
}

function flush() {
  const files = outboxFiles();
  if (!files.length) {
    console.log('[agent-memory] outbox 为空');
    return;
  }
  let ok = 0;
  let fail = 0;
  for (const file of files) {
    let item;
    try {
      item = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.log(`[agent-memory] 跳过无法解析的 outbox：${file}（${e}）`);
      fail++;
      continue;
    }
    const a = item.argv ?? {};
    const args = [item.kind === 'handoff' ? 'handoff' : 'save', '--app', a.app ?? APP];
    if (item.kind === 'handoff') {
      args.push('--task', a.task ?? 'agent-flow', '--status', a.status ?? 'partial', '--content', a.content ?? '', '--next', a.next ?? '未填写');
    } else {
      args.push('--content', a.content ?? '', '--type', a.type ?? 'fact', '--concepts', a.concepts ?? `app:${APP}`);
    }
    if (a.files) args.push('--files', a.files);
    if (!a.content) { console.log(`[agent-memory] 跳过空 content：${file}`); fail++; continue; }
    if (DRY) { console.log('[agent-memory] dry-run flush: ' + [clientPath() || '<client>', ...args].join(' ')); continue; }
    const r = callClient(args);
    if (r.ok) {
      unlinkSync(file);
      ok++;
      console.log(`[agent-memory] flushed ${item.kind}: ${file}`);
    } else {
      fail++;
      console.log(`[agent-memory] flush 失败（保留）：${file} — ${r.error}`);
    }
  }
  console.log(`[agent-memory] flush 完成：ok=${ok} fail=${fail}，剩余=${outboxFiles().length}`);
}

function doctor() {
  console.log(`[agent-memory] ROOT=${ROOT}`);
  console.log(`[agent-memory] gateway.path=${gatewayDir() ?? '(缺失)'}`);
  console.log(`[agent-memory] client=${clientPath() ?? '(缺失)'}`);
  console.log(`[agent-memory] outbox=${OUTBOX} files=${outboxFiles().length}`);
  const r = callClient(['sessions', '--app', APP, '--limit', '1']);
  console.log(`[agent-memory] client/sessions=${r.ok ? 'up' : 'DOWN: ' + r.error}`);
}

switch (cmd) {
  case 'brief': brief(); break;
  case 'save': save(); break;
  case 'handoff': handoff(); break;
  case 'flush': flush(); break;
  case 'doctor': doctor(); break;
  case '-h':
  case '--help':
    console.log('node src/scripts/agent-memory.mjs brief|save|handoff|flush|doctor [--app dsh] [--dry-run] [--offline]');
    break;
  default:
    console.error(`未知命令：${cmd}`);
    process.exit(2);
}
