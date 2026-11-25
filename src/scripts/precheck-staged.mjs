#!/usr/bin/env node
/**
 * pre-commit 机械检查（D-124，2026-10-27 owner 采用；2026-11-25 扩展）。
 *
 * 只管高确定性的机械红线，不做风格/AMH 审查（D-125 保留不挂 commit-msg）：
 * 1) 当前分支为 `main`：禁止直接往 main 提交（§0 红线，除非 PRECHECK_BYPASS=1）；
 * 2) staged 了生成物 / 本地目录：pkg/、dist/、web/*.wasm、web/app.js、web/worker.js、.wasm-pack-cache/、.tmp/、.dsh/、.amh/；
 * 3) staged 的 .cmd / .bat / .ps1 必须是纯 CRLF + 纯 ASCII（曾出过 LF 行尾与 chcp 65001 非 ASCII 两次事故）；
 * 4) staged 的文本源码/配置（ts/js/mjs/cjs/json/rs/yml/yaml/md）不得带 UTF-8 BOM（EF BB BF）。
 *
 * 逃生门：PRECHECK_BYPASS=1 git commit ...（只用于确知无害或 owner 明确要求提交 main；输出里会留痕）。
 * 安装：npm run hooks:install（设置 core.hooksPath=.githooks）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const GENERATED = [
  /(^|\/)pkg\//,
  /(^|\/)dist\//,
  /(^|\/)web\/[^/]+\.wasm$/,
  /(^|\/)web\/(app|worker)\.js$/,
  /(^|\/)\.wasm-pack-cache\//,
  /(^|\/)\.tmp\//,
  /(^|\/)\.dsh\//,
  /(^|\/)\.amh\//,
];
const SCRIPT_EXT = /\.(cmd|bat|ps1)$/i;
const NO_BOM_EXT = /\.(ts|tsx|js|mjs|cjs|json|rs|yml|yaml|md)$/i;

const problems = [];

try {
  const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  if (branch === 'main') {
    problems.push('当前分支为 main：禁止直接往 main 提交（请切回 dev；owner 明确要求时用 PRECHECK_BYPASS=1）');
  }
} catch {
  // detached HEAD（如 bisect/rebase）放行
}

let files = [];
try {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { encoding: 'utf8' });
  files = out.split('\0').filter(Boolean);
} catch {
  process.exit(0);
}

function readStagedBytes(file) {
  try {
    return execFileSync('git', ['show', ':' + file], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return readFileSync(file);
  }
}

for (const f of files) {
  if (GENERATED.some((re) => re.test(f))) {
    problems.push(f + ': 生成物 / 本地目录不得入库（pkg、dist、web/*.wasm、web/app.js、web/worker.js、.wasm-pack-cache、.tmp、.dsh、.amh）');
    continue;
  }
  const needScriptCheck = SCRIPT_EXT.test(f);
  const needBomCheck = NO_BOM_EXT.test(f);
  if (!needScriptCheck && !needBomCheck) continue;

  if (needBomCheck) {
    try {
      const stagedBuf = readStagedBytes(f);
      if (stagedBuf.length >= 3 && stagedBuf[0] === 0xef && stagedBuf[1] === 0xbb && stagedBuf[2] === 0xbf) {
        problems.push(f + ': 含 UTF-8 BOM（EF BB BF），请改为无 BOM UTF-8（避免 PowerShell Set-Content 污染）');
      }
    } catch {
      // ignore missing
    }
  }
  if (!needScriptCheck) continue;

  // .cmd/.bat/.ps1 在 core.autocrlf=true 下索引常为 LF、工作树才是实际运行的 CRLF，
  // 因此 CRLF 与 ASCII 检查必须读工作树文件（与 cmd.exe/PowerShell 实际执行内容一致）。
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
