#!/usr/bin/env node
/**
 * 看板使用规程的「软提示」——对应 AGENTS.md §0.1 第 3 与第 5 条。
 *
 * owner 2026-10-07 裁决：这一层**只提示、不拦提交**（不上硬门），因此 CI 以
 * continue-on-error 运行；本脚本自身默认 exit 0，只有显式 --strict 才 exit 1。
 *
 * 判据：本次改动触及 `src/` / `apps/` / `documents/`，但既没改 `TODO.md`，
 * 提交信息里也没有 `T-###` 或「无待办影响」字样 ⇒ 打一条提示。
 *
 * 用法：
 *   node src/scripts/check-board-touch.mjs --staged                  # 提交前（看暂存区）
 *   node src/scripts/check-board-touch.mjs --base <rev> --head <rev>  # CI / 手动（看提交区间）
 * 可选：--strict（提示时 exit 1；CI 未启用）
 */
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const strict = argv.includes('--strict');
const staged = argv.includes('--staged');
const base = arg('--base');
const head = arg('--head') || 'HEAD';

const git = (args) => { try { return execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 }).toString('utf8'); } catch { return null; } };
const skip = (why) => { console.log('[看板提示] 跳过：' + why); process.exit(0); };

let files = [];
let messages = '';
if (staged) {
  files = (git(['diff', '--cached', '--name-only']) || '').split(/\r?\n/).filter(Boolean);
} else {
  if (!base) skip('未给 --base（首次推送，或请在本地用 --staged 跑）');
  if (/^0+$/.test(base)) skip('--base 全零（首次推送，无对比基线）');
  const range = base + '..' + head;
  const out = git(['diff', '--name-only', range]);
  if (out === null) skip('无法解析 ' + range + '（浅克隆或该提交不在本地）');
  files = out.split(/\r?\n/).filter(Boolean);
  messages = git(['log', '--format=%B', range]) || '';
}

const touched = files.filter((f) => /^(src|apps|documents)\//.test(f));
const boardTouched = files.includes('TODO.md');
const noted = /T-\d{3}/.test(messages) || /无待办影响/.test(messages);

console.log('[看板提示] 本次涉及 ' + files.length + ' 个文件，其中代码/文档 ' + touched.length + ' 个；TODO.md ' + (boardTouched ? '已更新' : '未更新'));
if (!touched.length || boardTouched || noted) {
  console.log('[看板提示] 与 AGENTS.md §0.1 一致（改了代码或文档就同提交更新对应行，或已注明无待办影响）。');
  process.exit(0);
}
console.log('[看板提示] ⚠ 触及 ' + touched.length + ' 个代码/文档文件，但既未更新 TODO.md，提交信息里也没有 T-### 或「无待办影响」。');
console.log('            按 AGENTS.md §0.1 第 3/5 条：若改动触及既有结论，请同提交更新对应行；若不涉待办，请在提交信息写明「无待办影响」。本提示不拦提交。');
process.exit(strict ? 1 : 0);
