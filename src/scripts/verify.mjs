#!/usr/bin/env node
/**
 * 仓库统一跨 Shell 验证器（A 项改进）：替代容易在 PowerShell 5.1 写错的 `&&` 长链。
 *
 * 用法：
 *   node src/scripts/verify.mjs <fast|rust|ts|full> [--list] [--skip-wasm]
 *   npm run verify:fast   # TS 三端 typecheck + test:ts + 源码/着色器/配置门禁（~10s）
 *   npm run verify:rust   # websurf-phys + websurf-wasm-core 宿主机单测（Windows 自动选 msvc 工具链）
 *   npm run verify:ts     # 三端 build:ts + verify:fast + 共享产物指纹
 *   npm run verify:full   # rust + 三端 build:wasm + check:api + ts + 锁/导出/GLB 门禁
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPS = ['debug', 'game', 'viewer'];
const PROFILES = ['fast', 'rust', 'ts', 'full'];

const argv = process.argv.slice(2);
const profile = argv.find((a) => !a.startsWith('-'));
const listOnly = argv.includes('--list');
const skipWasm = argv.includes('--skip-wasm');

if (!profile || !PROFILES.includes(profile)) {
  console.error('用法: node src/scripts/verify.mjs <fast|rust|ts|full> [--list] [--skip-wasm]');
  process.exit(1);
}

/**
 * 从仓内 `.wasm-pack-cache` 查找本地预置的可执行文件目录（离线/沙箱免联网）。
 * 目前需要两类二进制：`wasm-bindgen`（wasm-pack 生成 JS 胶水）与
 * `wasm-opt`（release profile 的 `wasm-opt = ["-Os"]`，D-134b 起启用）。
 */
function findCacheBinaryDir(repoRoot, binName) {
  const cacheRoot = join(repoRoot, '.wasm-pack-cache');
  if (!existsSync(cacheRoot)) return null;
  const exeName = process.platform === 'win32' ? `${binName}.exe` : binName;
  const stack = [cacheRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isFile() && ent.name.toLowerCase() === exeName) return dir;
      if (ent.isDirectory()) stack.push(full);
    }
  }
  return null;
}

/** 在系统 PATH 中查找可执行文件（用于判断是否已由系统包管理器安装）。 */
function findOnPath(binName) {
  const exeName = process.platform === 'win32' ? `${binName}.exe` : binName;
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, exeName))) return dir;
  }
  return null;
}

/** Windows 下优先选用 msvc 工具链跑 wasm-core 宿主机单测（避免默认 gnu 缺 dlltool.exe）。 */
function detectWasmCoreCargoArgs() {
  if (process.platform === 'win32') {
    const res = spawnSync('rustup', ['toolchain', 'list'], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (res.status === 0 && /stable-x86_64-pc-windows-msvc/.test(res.stdout ?? '')) {
      return ['+stable-x86_64-pc-windows-msvc', 'test', '-p', 'websurf-wasm-core'];
    }
  }
  return ['test', '-p', 'websurf-wasm-core'];
}

function buildSteps(name) {
  const rustSteps = [
    { kind: 'cargo', label: 'cargo test -p websurf-phys', args: ['test', '-p', 'websurf-phys'] },
    // T-D134a：12 个仅 debug 的 PhysWorld 导出与 `phys::seed` 都在 `phys-debug` feature 后。
    // 默认构建不再编译它们 —— 少了这一遍，门控代码与 seed 面在 CI/本地就永远没有编译证据。
    {
      kind: 'cargo',
      label: 'cargo test -p websurf-phys --features phys-debug',
      args: ['test', '-p', 'websurf-phys', '--features', 'phys-debug'],
    },
    {
      kind: 'cargo',
      label: 'cargo test -p websurf-wasm-core (host)',
      args: detectWasmCoreCargoArgs(),
      isWasmCoreHost: true,
    },
  ];
  const fastSteps = [
    ...APPS.map((app) => ({
      kind: 'npm',
      label: `apps/${app} typecheck`,
      args: ['--prefix', `apps/${app}`, 'run', 'typecheck'],
    })),
    { kind: 'node', label: 'TS shared unit tests (test-ts-shared.mjs)', args: ['src/scripts/test-ts-shared.mjs'] },
    { kind: 'node', label: 'Entity I/O selftest (check-entity-io.mjs)', args: ['src/scripts/check-entity-io.mjs'] },
    {
      kind: 'node',
      label: 'Entity start_solid contract (check-entity-start-solid.mjs)',
      args: ['src/scripts/check-entity-start-solid.mjs'],
    },
    {
      kind: 'node',
      label: 'Entity import cycles (check-entity-cycles.mjs)',
      args: ['src/scripts/check-entity-cycles.mjs'],
    },
    { kind: 'node', label: 'Render parity gate (check-render-parity.mjs)', args: ['src/scripts/check-render-parity.mjs'] },
    { kind: 'node', label: 'Visual loop contract (check-visual-loop.mjs)', args: ['src/scripts/check-visual-loop.mjs'] },
    { kind: 'node', label: 'Shader anchors gate (check-shader-anchors.mjs)', args: ['src/scripts/check-shader-anchors.mjs'] },
    {
      kind: 'node',
      label: 'Config sync contract (check-config-sync-contract.mjs)',
      args: ['src/scripts/check-config-sync-contract.mjs'],
    },
  ];
  const tsTailSteps = fastSteps.slice(APPS.length).concat([
    {
      kind: 'node',
      label: 'Shared artifacts gate (check-shared-artifacts.mjs)',
      args: ['src/scripts/check-shared-artifacts.mjs'],
    },
  ]);
  const tsSteps = [
    ...APPS.map((app) => ({
      kind: 'npm',
      label: `apps/${app} build:ts`,
      args: ['--prefix', `apps/${app}`, 'run', 'build:ts'],
    })),
    ...tsTailSteps,
  ];
  if (name === 'rust') return rustSteps;
  if (name === 'fast') return fastSteps;
  if (name === 'ts') return tsSteps;

  const wasmBuildSteps = skipWasm
    ? []
    : APPS.map((app) => ({
        kind: 'npm',
        label: `apps/${app} build:wasm`,
        args: ['--prefix', `apps/${app}`, 'run', 'build:wasm'],
        needsWasmCache: true,
      }));
  const wasmApiSteps = APPS.map((app) => ({
    kind: 'npm',
    label: `apps/${app} check:api`,
    args: ['--prefix', `apps/${app}`, 'run', 'check:api'],
  }));
  return [
    ...rustSteps,
    ...wasmBuildSteps,
    ...wasmApiSteps,
    ...tsSteps,
    {
      kind: 'node',
      label: 'Lock & export baseline gate (check-lock-consistency.mjs)',
      args: ['src/scripts/check-lock-consistency.mjs'],
    },
    { kind: 'node', label: 'Three-end GLB parity (check-glb-parity.mjs)', args: ['src/scripts/check-glb-parity.mjs'] },
  ];
}

const wasmBindgenDir = findCacheBinaryDir(REPO, 'wasm-bindgen');
const wasmOptDir = findCacheBinaryDir(REPO, 'wasm-opt') ?? findOnPath('wasm-opt');
const steps = buildSteps(profile);
const wasmBuildSteps = steps.filter((step) => step.needsWasmCache).length;

if (listOnly) {
  console.log(
    `[verify:${profile}] 共 ${steps.length} 步（wasm-bindgen 缓存: ${wasmBindgenDir ?? '未命中，走系统 PATH'}；` +
      `wasm-opt: ${wasmOptDir ?? '未命中'}）:`,
  );
  steps.forEach((step, idx) => {
    console.log(`  ${String(idx + 1).padStart(2, ' ')}. ${step.label}`);
  });
  process.exit(0);
}

// D-134b：三端 release profile 已启用 `wasm-opt = ["-Os"]`。缺二进制时 wasm-pack 要么报错、
// 要么联网下载（离线/沙箱环境不可用），这里提前给出可执行的准备指引，而不是让它跑到一半才炸。
if (wasmBuildSteps > 0 && !wasmOptDir) {
  console.error('[verify] 未找到 wasm-opt：D-134b 起 release 构建需要 Binaryen wasm-opt。');
  console.error(
    '[verify] 解决：把 Binaryen version_133 解压到 .wasm-pack-cache/binaryen-version_133/（含 bin/wasm-opt[.exe]），或安装后加入系统 PATH。',
  );
  process.exit(1);
}

function runStep(step, index, total) {
  const started = Date.now();
  console.log(`\n[verify:${profile}] (${index + 1}/${total}) ${step.label}`);
  const env = { ...process.env };
  if (step.needsWasmCache && (wasmBindgenDir || wasmOptDir)) {
    // Windows 的 PATH 常以 `Path` 大小写存在；直接写 env.PATH 会新建一条空 PATH，
    // 导致 spawn('cmd.exe') 找不到系统目录（ENOENT），verify:full 无法启动 wasm 构建。
    // 按实际键名前置，保留系统 PATH 的其余段。
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    const cacheDirs = [...new Set([wasmBindgenDir, wasmOptDir].filter(Boolean))];
    env[pathKey] = `${cacheDirs.join(delimiter)}${delimiter}${env[pathKey] ?? ''}`;
  }
  let res;
  if (step.kind === 'node') {
    res = spawnSync(process.execPath, step.args, { cwd: REPO, stdio: 'inherit', env, windowsHide: true });
  } else if (step.kind === 'cargo') {
    res = spawnSync('cargo', step.args, { cwd: REPO, stdio: 'inherit', env, windowsHide: true });
  } else if (process.platform === 'win32') {
    res = spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm', ...step.args], {
      cwd: REPO,
      stdio: 'inherit',
      env,
      windowsHide: true,
    });
  } else {
    res = spawnSync('npm', step.args, { cwd: REPO, stdio: 'inherit', env });
  }

  const elapsedSec = ((Date.now() - started) / 1000).toFixed(2);
  if (res.error) {
    console.error(`[verify:${profile}] FAIL (${index + 1}/${total}) ${step.label}: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`[verify:${profile}] FAIL (${index + 1}/${total}) ${step.label} (exit ${res.status}, ${elapsedSec}s)`);
    if (step.isWasmCoreHost && process.platform === 'win32') {
      console.error('[verify] 提示：若报 dlltool.exe 缺失，请先执行 `rustup toolchain install stable-x86_64-pc-windows-msvc`，严禁修改 ~/.cargo/registry。');
    }
    process.exit(res.status ?? 1);
  }
  console.log(`[verify:${profile}] OK   (${index + 1}/${total}) ${step.label} (${elapsedSec}s)`);
}

const totalStarted = Date.now();
for (let i = 0; i < steps.length; i++) {
  runStep(steps[i], i, steps.length);
}
const totalSec = ((Date.now() - totalStarted) / 1000).toFixed(2);
console.log(`\n[verify:${profile}] PASS (${steps.length}/${steps.length} steps in ${totalSec}s)`);
