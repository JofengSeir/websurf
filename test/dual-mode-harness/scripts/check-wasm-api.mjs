/**
 * WASM 契约校验（薄配置，D-03 / T-03）：断言 `pkg/websurf_test_wasm.d.ts`
 * 导出 `PhysWorld` 类及 12 个方法。
 *
 * 引擎在共享层 `src/scripts/lib/wasm-api-contract.mjs`（纯函数、零工程依赖），
 * 本文件只声明「本工程的 pkg 名 + 契约面」并把结果落到输出与退出码。
 *
 * 契约面 = 薄导出层 12 API（build_world/tick/predict/respawn/teleport_to/set_params/
 * set_hull/set_yaw_pitch/set_velocity/set_state/state/take_event）；缺一即失败。
 *
 * 用法：node scripts/check-wasm-api.mjs
 * 退出码：0 = 通过，1 = 不匹配
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDtsExports,
  readDtsApiNames,
} from '../../../src/scripts/lib/wasm-api-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DTS = join(ROOT, 'pkg', 'websurf_test_wasm.d.ts');

// PhysWorld 类（共享 websurf-phys，re-export 薄导出）
const PHYS_API = [
  'build_world',
  'tick',
  'predict',
  'respawn',
  'teleport_to',
  'set_params',
  'set_hull',
  'set_yaw_pitch',
  'set_velocity',
  'set_state',
  'state',
  'take_event',
];

const read = readDtsApiNames({
  dtsPath: DTS,
  missingHint: '请先运行 npm run build:wasm（wasm-pack release）后再重试。',
});
if (!read.ok) {
  console.error(read.message);
  process.exit(1);
}

const assertion = assertDtsExports({
  dtsPath: DTS,
  apiNames: PHYS_API,
  extraTokens: ['class PhysWorld'],
});

if (assertion.ok) {
  console.log(`✓ WASM 契约通过：PhysWorld 类 + ${PHYS_API.length} 个方法全部导出。`);
  process.exit(0);
}

console.error(`✗ WASM 契约缺失 ${assertion.missing.length} 项:`);
for (const m of assertion.missing) console.error(`    - ${m}`);
console.error('请先运行 npm run build:wasm（wasm-pack release），并确认 websurf-phys 已导出。');
process.exit(1);
