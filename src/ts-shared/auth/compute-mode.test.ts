/**
 * 单测：计算模式门谓词 + §3.2 四向交接矩阵（tick 行）+ auth-loop 三值化门入口。
 *
 * 覆盖（任务 t2 验收 #2/#4）：
 * - 门谓词三值化：auth 线 coupled/tick 推进、decoupled 早退；解耦线仅 decoupled；
 *   任意模式两谓词互斥且恰一为真（§3.2 单写者不变量）；
 * - 四向交接矩阵：tick 行①-④ + coupled↔decoupled 存档行的谓词一致性、
 *   互斥性质、stateInject 语义（t3-memo §2.2）、方向全覆盖；
 * - resolveAuthGateOpen：modeGate 优先（v7 二值注入零回归）→ getComputeMode
 *   三值缺省 → 全缺省恒开。
 *
 * 运行（node，禁浏览器）：
 *   cd game && npx esbuild ../src/ts-shared/auth/compute-mode.test.ts \
 *     --bundle --format=esm --platform=node --outfile=node_modules/.cache/t2-tests/compute-mode.test.mjs \
 *     && node node_modules/.cache/t2-tests/compute-mode.test.mjs
 */

import {
  isAuthLineMode,
  isDecoupledLineMode,
  MODE_HANDOVER_MATRIX,
  type ComputeMode,
} from './compute-mode.js';
import { resolveAuthGateOpen } from './auth-loop.js';

const ALL_MODES: readonly ComputeMode[] = ['coupled', 'decoupled', 'tick'];

let passed = 0;
let failed = 0;
function expect(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
  }
}

// ── 1. 门谓词三值化 ──────────────────────────────────────────
console.log('[1] gate predicates (three-valued)');
expect(isAuthLineMode('coupled') === true, 'auth line active in coupled');
expect(isAuthLineMode('tick') === true, 'auth line active in tick (三值化核心断言)');
expect(isAuthLineMode('decoupled') === false, 'auth line early-exit in decoupled');
expect(isDecoupledLineMode('decoupled') === true, 'decoupled line active in decoupled');
expect(isDecoupledLineMode('coupled') === false, 'decoupled line idle in coupled');
expect(isDecoupledLineMode('tick') === false, 'decoupled line auto-early-exit in tick');
for (const m of ALL_MODES) {
  const a = isAuthLineMode(m);
  const d = isDecoupledLineMode(m);
  expect(a !== d && (a || d), `exactly one line active in ${m} (§3.2 单写者)`);
}

// ── 2. 四向交接矩阵（tick 行补录）────────────────────────────
console.log('[2] §3.2 handover matrix (tick rows)');
const tickRows = MODE_HANDOVER_MATRIX.filter((r) => r.from === 'tick' || r.to === 'tick');
expect(tickRows.length === 4, 'four tick-direction rows present');
const keyOf = (r: { from: ComputeMode; to: ComputeMode }): string => `${r.from}->${r.to}`;
const byKey = new Map(MODE_HANDOVER_MATRIX.map((r) => [keyOf(r), r]));
for (const key of ['coupled->tick', 'decoupled->tick', 'tick->coupled', 'tick->decoupled']) {
  expect(byKey.has(key), `matrix row ${key} present`);
}
for (const row of MODE_HANDOVER_MATRIX) {
  expect(
    row.authLineAfter === isAuthLineMode(row.to),
    `${keyOf(row)} authLineAfter == isAuthLineMode(to)`,
  );
  expect(
    row.decoupledLineAfter === isDecoupledLineMode(row.to),
    `${keyOf(row)} decoupledLineAfter == isDecoupledLineMode(to)`,
  );
  expect(
    row.authLineAfter !== row.decoupledLineAfter,
    `${keyOf(row)} exactly one line after handover`,
  );
}
expect(
  byKey.get('coupled->tick')?.stateInject === true,
  'coupled→tick stateInject（主线程 predPhys 全态注入，t3 §2.2 行①）',
);
expect(
  byKey.get('decoupled->tick')?.stateInject === false,
  'decoupled→tick 零注入（worker phys 即真理源，行②）',
);
expect(byKey.get('tick->coupled')?.stateInject === false, 'tick→coupled 免注入（行③）');
expect(byKey.get('tick->decoupled')?.stateInject === false, 'tick→decoupled 免注入（行④）');
// 存档行零回归：既有两向语义不变
expect(byKey.get('coupled->decoupled')?.stateInject === true, '存档行 coupled→decoupled 注入');
expect(byKey.get('decoupled->coupled')?.stateInject === false, '存档行 decoupled→coupled 免注入');

// ── 3. auth-loop 三值化门入口 ────────────────────────────────
console.log('[3] resolveAuthGateOpen (auth-loop reuse entry)');
expect(resolveAuthGateOpen({}) === true, 'both hooks absent → always open (v7 zero change)');
expect(resolveAuthGateOpen({ modeGate: () => false }) === false, 'explicit modeGate wins (false)');
expect(resolveAuthGateOpen({ modeGate: () => true }) === true, 'explicit modeGate wins (true)');
expect(
  resolveAuthGateOpen({ modeGate: () => true, getComputeMode: () => 'decoupled' }) === true,
  'modeGate precedence over getComputeMode (向后兼容)',
);
expect(
  resolveAuthGateOpen({ getComputeMode: () => 'coupled' }) === true,
  'hook default gate: coupled open',
);
expect(
  resolveAuthGateOpen({ getComputeMode: () => 'tick' }) === true,
  'hook default gate: tick open（三值化核心断言）',
);
expect(
  resolveAuthGateOpen({ getComputeMode: () => 'decoupled' }) === false,
  'hook default gate: decoupled early-exit',
);

console.log(`compute-mode.test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  throw new Error(`compute-mode.test FAILED (${failed})`);
}
