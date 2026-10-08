#!/usr/bin/env node
/**
 * 面板默认值 ↔ config 默认值的交叉校验（`TODO.md T-302`）。
 *
 * **要防的回归**：面板侧默认值写在 `apps/debug/src/physics/param-defs.ts` 的 `PARAM_DEFS`，
 * 配置侧默认值写在 `apps/debug/src/config.ts` 的 `DEFAULT_CONFIG`，两者**各自手抄**同一组
 * `src/phys/player.rs` 的 `PhysParams::default` 常量。改一处忘另一处时，面板会显示一个与
 * 物理实际取值不同的「默认值」，且没有任何信号。
 *
 * **比较口径**：对每个 number 型面板项，取 `PARAM_TO_RUST` 的 Rust 键，与
 * `buildPhysicsParams(DEFAULT_CONFIG.physics, DEFAULT_CONFIG.input)` 的同键值比对
 * （即「config 经共享层换算后的物理取值」）。容差 `TOL`：`jumpHeight` 面板侧是取整的顶点
 * 高度 57，config 侧给的是起跳速度 302，换算 302²/(2×800) = 57.0025，差 0.0025。
 * 没有 config 对应项的项（`walkSpeed` / `crouchSpeed` / `pushOut` 等）与布尔项只列出、不比对。
 *
 * 用法：`npm run check:param-defaults`（退出码 0 = 全部一致，1 = 有不一致）。
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
/** 容差：见文件头的 jumpHeight 说明。 */
const TOL = 1e-2;

const bundle = await build({
  stdin: {
    contents: [
      "export { PARAM_DEFS } from '../src/physics/param-defs.js';",
      "export { PARAM_TO_RUST } from '../src/physics/physics-params.js';",
      "export { DEFAULT_CONFIG } from '../src/config.js';",
      "export { buildPhysicsParams } from '../../../src/ts-shared/phys/params.js';",
    ].join('\n'),
    resolveDir: here,
    sourcefile: 'param-defaults-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
});
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text, 'utf8').toString('base64')
);

const shared = mod.buildPhysicsParams(mod.DEFAULT_CONFIG.physics, mod.DEFAULT_CONFIG.input);
const mismatched = [];
const skipped = [];
for (const def of mod.PARAM_DEFS) {
  const rustKey = mod.PARAM_TO_RUST[def.name];
  const fromConfig = rustKey ? shared[rustKey] : undefined;
  if (def.kind === 'boolean' || typeof fromConfig !== 'number') {
    skipped.push(def.name + (rustKey ? '' : '（无 Rust 映射）'));
    continue;
  }
  const panel = Number(def.default);
  const ok = Math.abs(panel - fromConfig) <= TOL;
  console.log(
    `${ok ? 'OK  ' : '不一致'} ${def.name.padEnd(16)} → ${String(rustKey).padEnd(16)} 面板 ${String(panel).padEnd(9)} config 换算 ${fromConfig}`,
  );
  if (!ok) mismatched.push(`${def.name}（面板 ${panel} / config ${fromConfig}）`);
}
if (skipped.length > 0) console.log('未比对（无 config 对应项或布尔项）：' + skipped.join('、'));
if (mismatched.length > 0) {
  console.error('\n[check-param-defaults] 面板默认值与 config 默认值不一致：' + mismatched.join('；'));
  console.error('改 `apps/debug/src/physics/param-defs.ts` 的 PARAM_DEFS 或 `apps/debug/src/config.ts` 的 DEFAULT_CONFIG，使两者同值。');
  process.exit(1);
}
console.log('\n[check-param-defaults] 面板默认值与 config 默认值全部一致。');
