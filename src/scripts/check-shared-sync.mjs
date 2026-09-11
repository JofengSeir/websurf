/**
 * 共享层一致性门禁（T-05 / B4-7）— 四项子检查，任一失败 `exit 1`。
 *
 * 定位：把「**不可合并的重复**」变成可判定门禁。这些重复因语义原因不可合并
 * （E-01…E-08），若同时没有门禁，它们就是「靠文档记载维持的一致性」。
 *
 * | 子检查 | 断言 | 依据 |
 * |---|---|---|
 * | `mtz` | 三处 `textures.mtz` sha256 全等；`apps/viewer/web/textures.mtz` **不得存在** | D-11、E-04、t2 §8.2 |
 * | `vmdl-patch` | 五份 `Cargo.toml` 均含 `[patch.crates-io]` 且 `vmdl` 指向 `src/vendor/vmdl` | E-02、R-21 |
 * | `eye-stand` | `src/phys/player.rs` 的 `EYE_STAND` 与 `src/ts-shared/phys/constants.ts` 的 TS 单点**逐位相等** | D-16、E-06 |
 * | `license-src` | `src/phys/{LICENSE,NOTICE}` 存在，且 `apps/` 下无第二份 cs-movement 许可**源** | D-23、E-08、R-17 |
 *
 * **实现约束（必须保持）**：纯 `node:fs` + `node:crypto`，**禁止** `child_process`——
 * `src/scripts/check-doc-drift.mjs` 用 `execFileSync` 起 `git`，在禁止子进程 spawn 的
 * 环境（file sandbox）会 `EPERM -4048`；本工具因此可在任何沙箱直接运行。
 *
 * 调用方式（不经任何 `package.json` 注册，与 check-doc-drift 同模式）：
 *   node src/scripts/check-shared-sync.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const failures = [];
const notes = [];

/** 记录一项失败（不抛异常，收齐后统一报）。 */
function fail(check, message) {
  failures.push(`[${check}] ${message}`);
}

/** 记录一项通过明细。 */
function note(check, message) {
  notes.push(`  [OK] [${check}] ${message}`);
}

/** sha256 前 16 位。 */
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// 1. mtz：三处纹理包一致性 + viewer 不得有副本（D-11 / E-04）
// ---------------------------------------------------------------------------

function checkMtz() {
  const check = 'mtz';
  const triple = [
    'src/materials/textures.mtz',
    'apps/debug/web/textures.mtz',
    'apps/game/web/textures.mtz',
  ];
  const digests = [];
  for (const rel of triple) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      fail(check, `缺少纹理包副本: ${rel}`);
      continue;
    }
    digests.push([rel, sha256(abs), fs.statSync(abs).size]);
  }
  if (digests.length === triple.length && new Set(digests.map((d) => d[1])).size !== 1) {
    fail(
      check,
      `三处 textures.mtz 不一致: ${digests.map((d) => `${d[0]}=${d[1]}(${d[2]}B)`).join(' | ')}`,
    );
  } else if (digests.length === triple.length) {
    note(check, `三处 textures.mtz sha256 全等 = ${digests[0][1]}（各 ${digests[0][2]} B）`);
  }

  const viewerMtz = path.join(ROOT, 'apps/viewer/web/textures.mtz');
  if (fs.existsSync(viewerMtz)) {
    fail(check, 'apps/viewer/web/textures.mtz 存在（t2 §8.2 声明 viewer 无该副本）');
  } else {
    note(check, 'apps/viewer/web/textures.mtz 不存在（符合声明）');
  }
}

// ---------------------------------------------------------------------------
// 2. vmdl-patch：五份 [patch.crates-io] vmdl 声明（E-02 / R-21）
// ---------------------------------------------------------------------------

function checkVmdlPatch() {
  const check = 'vmdl-patch';
  const manifests = [
    'Cargo.toml',
    'apps/debug/Cargo.toml',
    'apps/game/Cargo.toml',
    'apps/viewer/Cargo.toml',
    'test/dual-mode-harness/Cargo.toml',
  ];
  for (const rel of manifests) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      fail(check, `缺少模块清单: ${rel}`);
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    if (!text.includes('[patch.crates-io]')) {
      fail(check, `${rel} 缺少 [patch.crates-io] 段（E-02：patch 只对声明它的 workspace 生效）`);
      continue;
    }
    const patchBlock = text.slice(text.indexOf('[patch.crates-io]'));
    if (!/vmdl\s*=\s*\{[^}]*path\s*=\s*"[^"]*src\/vendor\/vmdl/.test(patchBlock)) {
      fail(check, `${rel} 的 vmdl patch 未指向 src/vendor/vmdl`);
      continue;
    }
    note(check, `${rel} 含 [patch.crates-io] vmdl → src/vendor/vmdl`);
  }
}

// ---------------------------------------------------------------------------
// 3. eye-stand：Rust 权威 ↔ TS 单点逐位相等（D-16 / E-06）
// ---------------------------------------------------------------------------

function checkEyeStand() {
  const check = 'eye-stand';
  const rustRel = 'src/phys/player.rs';
  const tsRel = 'src/ts-shared/phys/constants.ts';
  const rustAbs = path.join(ROOT, rustRel);
  const tsAbs = path.join(ROOT, tsRel);

  if (!fs.existsSync(rustAbs)) {
    fail(check, `缺少 Rust 权威定义: ${rustRel}`);
    return;
  }
  if (!fs.existsSync(tsAbs)) {
    fail(check, `缺少 TS 单点: ${tsRel}（D-16 上提后应存在）`);
    return;
  }

  const rustText = fs.readFileSync(rustAbs, 'utf8');
  const tsText = fs.readFileSync(tsAbs, 'utf8');
  const rust = /pub\s+const\s+EYE_STAND\s*:\s*f64\s*=\s*([0-9]*\.?[0-9]+)\s*;/.exec(rustText);
  const ts = /export\s+const\s+EYE_STAND\s*=\s*([0-9]*\.?[0-9]+)\s*;/.exec(tsText);

  if (!rust) {
    fail(check, `${rustRel} 未找到 pub const EYE_STAND 定义`);
    return;
  }
  if (!ts) {
    fail(check, `${tsRel} 未找到 export const EYE_STAND 定义`);
    return;
  }
  if (rust[1] !== ts[1]) {
    fail(check, `EYE_STAND 跨语言不一致：Rust=${rust[1]} TS=${ts[1]}`);
    return;
  }
  note(check, `Rust ${rustRel} 与 TS ${tsRel} 逐位相等 = ${rust[1]}`);
}

// ---------------------------------------------------------------------------
// 4. license-src：许可唯一源 + apps/ 下无第二份许可源（D-23 / E-08 / R-17）
// ---------------------------------------------------------------------------

/** 递归收集 apps/ 下所有 LICENSE / NOTICE 文件（跳过 node_modules 与构建产物目录）。 */
function collectAppLicenseFiles() {
  const found = [];
  const skipDirs = new Set(['node_modules', 'dist', 'pkg', 'target', 'temp', '.tmp']);
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        walk(abs);
      } else if (/^(LICENSE|NOTICE)(\..+)?$/.test(e.name)) {
        found.push(path.relative(ROOT, abs).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(ROOT, 'apps'));
  return found;
}

function checkLicenseSrc() {
  const check = 'license-src';
  const source = ['src/phys/LICENSE', 'src/phys/NOTICE'];
  for (const rel of source) {
    if (fs.existsSync(path.join(ROOT, rel))) {
      note(check, `${rel} 存在（唯一许可源）`);
    } else {
      fail(check, `缺少许可源 ${rel}（D-23：cs-movement 许可唯一源落 src/phys/）`);
    }
  }
  const inApps = collectAppLicenseFiles();
  if (inApps.length > 0) {
    fail(
      check,
      `apps/ 下存在第二份许可源（E-08 判据①禁止源码副本；dist/ 产物拷贝不计）: ${inApps.join(', ')}`,
    );
  } else {
    note(check, 'apps/ 下无 LICENSE/NOTICE 许可源副本（dist/ 产物拷贝不计）');
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== 共享层一致性门禁（T-05）===');
console.log(`仓库根: ${ROOT}`);

checkMtz();
checkVmdlPatch();
checkEyeStand();
checkLicenseSrc();

for (const line of notes) console.log(line);

if (failures.length > 0) {
  console.error('');
  console.error(`❌ 门禁失败 ${failures.length} 项：`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
console.log('');
console.log('✅ 四项子检查全部通过（mtz / vmdl-patch / eye-stand / license-src）');
process.exit(0);
