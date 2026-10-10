#!/usr/bin/env node
/**
 * 知识库兜底：agentmemory MCP 工具不可用时，仍能读规则 / 写进展的最小可操作系统。
 *
 * 三层（probe 逐层探测并给出该走哪条）：
 *   L1 宿主 MCP 工具 memory_*：正常路径（脚本探测不到，agent 自己知道手里有没有）
 *   L2 agentmemory 服务 HTTP：读 GET http://127.0.0.1:3113/memories?limit=N，写走 REST http://127.0.0.1:3111
 *   L3 仓库兜底：规则从 skills/** 与门禁脚本重建（脚本即规则的可执行定义）；
 *      写不进知识库的条目落 progress/pending-kb.jsonl，服务恢复后用 plan 回放，done 删除
 *
 * 用法：
 *   node src/scripts/kb-fallback.mjs probe
 *   node src/scripts/kb-fallback.mjs queue --marker <websurf/...> --note <文本> [--source <路径>]
 *   node src/scripts/kb-fallback.mjs list [--json]
 *   node src/scripts/kb-fallback.mjs plan
 *   node src/scripts/kb-fallback.mjs done --marker <websurf/...>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const QUEUE = path.join(ROOT, 'progress/pending-kb.jsonl');
const LEDGER = path.join(ROOT, 'progress/memory-index.jsonl');
const VIEWER = 'http://127.0.0.1:3113/memories?limit=1';
const REST = 'http://127.0.0.1:3111/status';
const STARTERS = ['../agentmemory/start-agentmemory.cmd', '../../agentmemory/start-agentmemory.cmd', 'D:/code/projects/agentmemory/start-agentmemory.cmd'];

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : (d === undefined ? '' : d); };
const rows = () => (fs.existsSync(QUEUE) ? fs.readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const save = (list) => { fs.mkdirSync(path.dirname(QUEUE), { recursive: true }); fs.writeFileSync(QUEUE, list.map((r) => JSON.stringify(r)).join('\n') + (list.length ? '\n' : ''), 'utf8'); };
const nLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : -1);

async function http(u) {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(1500), headers: { accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function probe() {
  const q = rows();
  const viewer = await http(VIEWER);
  const rest = await http(REST);
  const starter = STARTERS.map((s) => path.resolve(ROOT, s)).find((p) => fs.existsSync(p));
  const ledger = nLines(LEDGER);
  console.log('知识库兜底探测（L1 由宿主决定：你手里有没有 memory_* 工具）');
  console.log('  L2 读（viewer :3113）: ' + (viewer ? '可用 ｜ 库内 total=' + viewer.total : '不可用'));
  console.log('  L2 写（REST :3111）  : ' + (rest ? '可用' : '不可用'));
  console.log('  L2 起服务            : ' + (starter || '未找到 start-agentmemory.cmd（自行确认 agentmemory 安装位置）'));
  console.log('  L3 仓库兜底          : 始终可用（skills/** + 门禁脚本 + 本队列）');
  console.log('  待补写条目           : ' + q.length + (q.length ? '（' + q.slice(0, 3).map((r) => r.marker).join('、') + (q.length > 3 ? ' …' : '') + '）' : ''));
  console.log('  台账行数             : ' + ledger + (viewer ? (viewer.total === ledger ? ' ｜ 与库内 total 一致' : ' ｜ **与库内 total=' + viewer.total + ' 不一致**') : ''));
  console.log('');
  console.log('该走哪条：');
  if (viewer || rest) {
    console.log('  ① L1 可用 → 正常走 memory_* 工具（约定见 skills/agentmemory-usage/SKILL.md）。');
    console.log('  ② L1 不可用但服务在 → 读用 GET ' + VIEWER + '；写按 plan 的 JSON 调 MCP，或等服务恢复回放。');
  } else {
    console.log('  ① 先起服务：' + (starter || '找到 start-agentmemory.cmd 后运行') + '，然后重跑 probe。');
    console.log('  ② 服务起不来 → 走 L3：规则读 skills/** 与门禁脚本（A–P 即文档规则、docflow.json 即只读规则）；');
    console.log('     当轮进展用 queue 落盘，**不要因为写不进知识库就丢掉进展**。');
  }
  if (q.length) console.log('  ③ 队列非空 → 恢复后按 plan 逐条 memory_save 并补台账，再 done。');
}

function queue() {
  const marker = arg('marker');
  if (!marker) { console.error('缺 --marker'); process.exit(2); }
  const list = rows();
  if (list.some((r) => r.marker === marker)) { console.log('已在队列：' + marker); return; }
  list.push({ at: new Date().toISOString(), marker, source: arg('source', marker.replace(/^websurf\//, '').replace(/#.*$/, '')), note: arg('note'), status: 'pending' });
  save(list);
  console.log('已排队 ' + marker + '（队列 ' + list.length + ' 条）——恢复后用 plan 回放');
}

function listCmd() {
  const list = rows();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(list, null, 1)); return; }
  console.log('待补写 ' + list.length + ' 条');
  for (const r of list) console.log('  ' + r.at + '  ' + r.marker + '  ' + String(r.note || '').slice(0, 60));
}

function plan() {
  const list = rows();
  if (!list.length) { console.log('队列为空，无需回放'); return; }
  console.log('逐条执行下面的 memory_save（MCP），然后把 ledger 行追加到 progress/memory-index.jsonl：');
  list.forEach((r, i) => {
    const body = ['[线索] ' + r.marker, '主题：' + String(r.note || '兜底补写').slice(0, 40), '路径：' + r.source + '（兜底补写）', '小节：', '  兜底补写', '摘要：' + String(r.note || '见正文').slice(0, 120), '---', r.note || ''].join('\n');
    console.log('');
    console.log('【' + (i + 1) + '】memory_save ' + JSON.stringify({ project: 'websurf', type: 'workflow', concepts: 'websurf,兜底补写', files: r.source, content: body }));
    console.log('  ledger: ' + JSON.stringify({ marker: r.marker, source: r.source, kind: 'index', seq: 0, memoryId: '<上一步返回的 id>', at: r.at.slice(0, 10), retired: true, shape: 'snapshot' }));
  });
  console.log('');
  console.log('回放完一条就 done --marker <marker> 从队列删除。');
}

function done() {
  const marker = arg('marker');
  if (!marker) { console.error('缺 --marker'); process.exit(2); }
  const list = rows();
  const rest = list.filter((r) => r.marker !== marker);
  if (rest.length === list.length) { console.log('队列里没有：' + marker); return; }
  save(rest);
  console.log('已从队列删除 ' + marker + '（剩 ' + rest.length + ' 条）');
}

const cmd = process.argv[2] || 'probe';
if (cmd === 'probe') await probe();
else if (cmd === 'queue') queue();
else if (cmd === 'list') listCmd();
else if (cmd === 'plan') plan();
else if (cmd === 'done') done();
else { console.error('未知子命令：' + cmd + '（probe | queue | list | plan | done）'); process.exit(2); }
