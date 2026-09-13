#!/usr/bin/env node
/**
 * wasm-stale-check.mjs —— WASM 产物过期检测（mtime 比对，三工程 start-dev.cmd 共用）。
 *
 * 用法:
 *   node wasm-stale-check.mjs <wasm-artifact-path> <source-root> [<source-root>...]
 *
 * 判定: 产物不存在，或任一 <source-root> 下的 .rs/.toml 的 mtime 比产物新 → 过期。
 * 退出码: 0 = 新鲜（可跳过重建）；1 = 过期（需要重建）；2 = 用法/IO 错误（调用方按需重建，安全侧）。
 *
 * 设计约定:
 * - 扫描 <source-root> 整棵子树（排除 target/、node_modules/），扩展名限 .rs/.toml
 *   （Rust 源 + Cargo 清单；build.rs 也覆盖）。TS/资源变更不影响 wasm，不参与判定。
 * - git checkout/pull 会刷新全部 mtime → 检出后首次 start-dev 可能多重建一次（安全方向，无害）。
 * - stdout 只输出人类可读的 [INFO] 行；调用方（start-dev.cmd）只依赖退出码。
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
    return; // 不可读目录跳过（判定覆盖面缩小是安全侧：最多漏报过期→不会误建）
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
