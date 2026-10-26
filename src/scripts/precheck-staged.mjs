#!/usr/bin/env node
/**
 * pre-commit 机械检查（D-124，2026-10-27 owner 采用）。
 *
 * 只管两类已经发生过事故的机械问题，不做风格审查：
 * 1) staged 了生成物 / 本地目录：pkg/、dist/、web/*.wasm、.tmp/、.dsh/、.amh/；
 * 2) staged 的 .cmd / .bat / .ps1 必须是纯 CRLF + 纯 ASCII（曾出过 LF 行尾与 chcp 65001 非 ASCII 两次事故）。
 *
 * 逃生门：PRECHECK_BYPASS=1 git commit ...（只用于确知无害的紧急提交；输出里会留痕）。
 * 安装：npm run hooks:install（设置 core.hooksPath=.githooks）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const GENERATED = [
  /(^|\/)pkg\//,
  /(^|\/)dist\//,
  /(^|\/)web\/[^/]+\.wasm$/,
  /(^|\/)\.tmp\//,
  /(^|\/)\.dsh\//,
  /(^|\/)\.amh\//,
];
const SCRIPT_EXT = /\.(cmd|bat|ps1)$/i;

let files = [];
try {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { encoding: 'utf8' });
  files = out.split('\0').filter(Boolean);
} catch {
  process.exit(0);
}

const problems = [];
for (const f of files) {
  if (GENERATED.some((re) => re.test(f))) {
    problems.push(f + ': 生成物 / 本地目录不得入库（pkg、dist、web/*.wasm、.tmp、.dsh、.amh）');
    continue;
  }
  if (!SCRIPT_EXT.test(f)) continue;
  let buf;
  try {
    buf = readFileSync(f);
  } catch {
    continue;
  }
  let line = 1;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0a) {
      if (i === 0 || buf[i - 1] !== 0x0d) {
        problems.push(f + ':' + line + ': 行尾是 LF（.cmd/.bat/.ps1 必须 CRLF）');
        break;
      }
      line++;
      continue;
    }
    if (b > 0x7f) {
      problems.push(f + ':' + line + ': 含非 ASCII 字节 0x' + b.toString(16) + '（chcp 65001 下会咬命令）');
      break;
    }
  }
}

if (!problems.length) process.exit(0);
const bypass = process.env.PRECHECK_BYPASS === '1';
console.error('[precheck-staged] 提交被拦下：');
for (const p of problems) console.error('  - ' + p);
if (bypass) {
  console.error('[precheck-staged] PRECHECK_BYPASS=1：按逃生门放行（请在提交信息里写明原因）');
  process.exit(0);
}
console.error('[precheck-staged] 修好后再提交；确知无害时可用 PRECHECK_BYPASS=1（提交信息里写明原因）。');
process.exit(1);
