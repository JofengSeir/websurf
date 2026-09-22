#!/usr/bin/env node
/**
 * wasm-stale-check.mjs —— WASM 产物过期检测（只看 mtime，不读内容）。
 *
 * 用法:
 *   node wasm-stale-check.mjs <wasm-artifact-path> <source-root> [<source-root>...]
 *
 * 判定: 产物不存在，或任一 <source-root> 子树里 .rs/.toml 的最大 mtime 大于产物的
 *       mtime → 过期。
 * 退出码: 0 = 新鲜（可跳过重建）；1 = 产物缺失或已过期（需要重建）；2 = 用法错误
 *         （参数缺失）。
 *
 * 调用方: apps/debug/start-dev.cmd、apps/game/start-dev.cmd、apps/viewer/start-dev.cmd
 * 各传三条路径 —— 该工程 pkg 下的 *_bg.wasm、仓库根 src、该工程 crates；三处判据都是
 * `if not errorlevel 1 goto :wasm_done`，故退出码 1 与 2 都落到完整重建。
 *
 * 设计约定:
 * - 递归 <source-root> 时按目录名排除 target/ 与 node_modules/，文件只收 .rs 与 .toml
 *   （Rust 源 + Cargo 清单；build.rs 也在 .rs 之内）。TS 与资源变更不参与判定。
 * - 判据只有 mtime、没有内容哈希：任何刷新 mtime 的操作（检出、切换分支、touch）都会
 *   让产物显得过期并多重建一次，方向安全。
 * - 若 <source-root> 下没有任何 .rs/.toml，newest.mtime 保持初值 -1，判为新鲜。
 * - stdout 只出现 [INFO] 行；用法错误走 stderr。
 */

import { statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [wasmPath, ...roots] = process.argv.slice(2);
if (!wasmPath || roots.length === 0) {
  console.error('[wasm-stale] usage: node wasm-stale-check.mjs <wasm-artifact-path> <source-root>...');
  process.exit(2);
}

let wasmMtime;
try {
  wasmMtime = statSync(wasmPath).mtimeMs;
} catch {
  console.log('[INFO] wasm artifact missing - build required');
  process.exit(1);
}

const newest = { mtime: -1, file: '' };
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 不可读目录跳过：覆盖面缩小只会漏报过期，不会把新鲜的判成过期
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'target' && e.name !== 'node_modules') walk(p);
      continue;
    }
    if (!e.name.endsWith('.rs') && !e.name.endsWith('.toml')) continue;
    let m;
    try {
      m = statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (m > newest.mtime) {
      newest.mtime = m;
      newest.file = p;
    }
  }
}
for (const r of roots) walk(resolve(r));

if (newest.mtime > wasmMtime) {
  console.log(`[INFO] wasm stale - newest source ${newest.file} is newer than artifact`);
  process.exit(1);
}
console.log('[INFO] wasm up-to-date (artifact newer than all Rust sources) - skipping build');
process.exit(0);
