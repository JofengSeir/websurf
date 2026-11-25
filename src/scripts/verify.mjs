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

/** 从仓内 `.wasm-pack-cache` 查找本地预置的 `wasm-bindgen` 可执行目录（离线/沙箱免联网）。 */
function findWasmBindgenDir(repoRoot) {
  const cacheRoot = join(repoRoot, '.wasm-pack-cache');
  if (!existsSync(cacheRoot)) return null;
  const binName = process.platform === 'win32' ? 'wasm-bindgen.exe' : 'wasm-bindgen';
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
      if (ent.isFile() && ent.name.toLowerCase() === binName) return dir;
      if (ent.isDirectory()) stack.push(full);
    }
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

const wasmBindgenDir = findWasmBindgenDir(REPO);
const steps = buildSteps(profile);

if (listOnly) {
  console.log(`[verify:${profile}] 共 ${steps.length} 步（wasm-bindgen 缓存: ${wasmBindgenDir ?? '未命中，走系统 PATH'}）:`);
  steps.forEach((step, idx) => {
    console.log(`  ${String(idx + 1).padStart(2, ' ')}. ${step.label}`);
  });
  process.exit(0);
}

function runStep(step, index, total) {
  const started = Date.now();
  console.log(`\n[verify:${profile}] (${index + 1}/${total}) ${step.label}`);
  const env = { ...process.env };
  if (step.needsWasmCache && wasmBindgenDir) {
    // Windows 的 PATH 常以 `Path` 大小写存在；直接写 env.PATH 会新建一条空 PATH，
    // 导致 spawn('cmd.exe') 找不到系统目录（ENOENT），verify:full 无法启动 wasm 构建。
    // 按实际键名前置，保留系统 PATH 的其余段。
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = `${wasmBindgenDir}${delimiter}${env[pathKey] ?? ''}`;
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
