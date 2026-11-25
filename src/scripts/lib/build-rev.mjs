/**
 * 计算构建版本号（自动写入 `RENDER_REV` / `__WEBSURF_BUILD_REV__`）。
 *
 * 硬约束（与 `dist-pack.mjs` 保持一致）：只用 `node:*` 内建模块，零外部依赖、零 `apps/` 引用。
 * 口径：
 *   1. 取当前提交 `<commit-date>-<short-hash>`（例如 `2026-11-26-5ea607e`）；
 *   2. 若工作树有未提交改动（`git status --porcelain` 非空），追加基于 `git diff HEAD` +
 *      `git status --porcelain` 的 6 位 sha256 指纹（`-dirty-<6hex>`）；
 *      这样同一工作树下连续构建 debug / game / viewer 产出完全相同的字符串，
 *      既能自动随每次代码改动变化、又不破坏跨端产物指纹一致性校验；
 *   3. 无 git 环境时回退 `'dev'`。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function runGit(args) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export function computeBuildRev() {
  try {
    const base = runGit(['log', '-1', '--format=%cs-%h']).trim();
    if (!base) return 'dev';
    const status = runGit(['status', '--porcelain']).trim();
    if (!status) return base;
    let diff = '';
    try {
      diff = runGit(['diff', 'HEAD']);
    } catch {
      diff = '';
    }
    const hash = createHash('sha256')
      .update(status)
      .update('\n')
      .update(diff)
      .digest('hex')
      .slice(0, 6);
    return `${base}-dirty-${hash}`;
  } catch {
    return 'dev';
  }
}
