// agent-audit（agent-constraints-plan.md §6.4）：从 git log 统计最近 N 笔提交的
// AMH 尾注率与纯格式提交占比，打印一行摘要。
//
// 判据：脚本**只读 git**，不改任何文件、不做任何写操作。
// 口径：
// - AMH 尾注 = 提交信息匹配 `AMH: <memory-id|none|down>`（AGENTS §3.3 三选一）；
// - 纯格式提交 = 提交信息含「无行为变化」（AGENTS §7 对纯格式/注释改动的约定标记，
//   机械代理口径——不做逐行 diff 语义分析）。
import { execFileSync } from 'node:child_process';

const COUNT = 50;

function git(args) {
	return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// 先断言规模再判读（env-traps）：提交数不足时按实际数计，0 笔则报错退出。
const raw = git(['log', `-n`, `${COUNT}`, '--format=%H%x1f%s%x1f%b%x1e']);
const commits = raw.split('\x1e').map((s) => s.trim()).filter(Boolean);
if (commits.length === 0) {
	console.error('agent-audit: git log returned 0 commits — refusing to print a summary');
	process.exit(1);
}

let amh = 0;
let pureFormat = 0;
for (const c of commits) {
	const [hash, subject, body] = c.split('\x1f');
	const message = `${subject ?? ''}\n${body ?? ''}`;
	if (/^AMH: (mem_\S+|none|down)\s*$/m.test(message)) amh++;
	if (message.includes('无行为变化')) pureFormat++;
	console.assert(hash && hash.length === 40, 'unexpected commit hash shape');
}

const n = commits.length;
const pct = (k) => `${k}/${n} (${Math.round((k / n) * 100)}%)`;
console.log(`agent-audit: 最近 ${n} 笔提交 — AMH 尾注 ${pct(amh)}；纯格式（无行为变化）${pct(pureFormat)}`);
