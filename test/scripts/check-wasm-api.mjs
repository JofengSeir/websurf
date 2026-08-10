/**
 * WASM 契约校验：确认 pkg/websurf_test_wasm.d.ts 导出 PhysWorld 及方法集。
 *
 * 契约 = 薄导出层 12 API（build_world/tick/predict/respawn/teleport_to/set_params/
 * set_hull/set_yaw_pitch/set_velocity/set_state/state/take_event）。
 * 缺失任一 API 即失败（提示先 npm run build:wasm）。
 *
 * 用法：node scripts/check-wasm-api.mjs
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dtsPath = join(root, 'pkg', 'websurf_test_wasm.d.ts');

if (!existsSync(dtsPath)) {
  console.error('错误: pkg/websurf_test_wasm.d.ts 不存在。请先运行 npm run build:wasm');
  process.exit(1);
}

const dts = readFileSync(dtsPath, 'utf8');

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

const missing = [];
if (!/\bclass PhysWorld\b/.test(dts)) missing.push('PhysWorld 类导出');
for (const api of PHYS_API) {
  // 匹配 "  name(...)" 方法声明
  const re = new RegExp(`\\b${api}\\s*\\(`);
  if (!re.test(dts)) missing.push(api);
}

if (missing.length > 0) {
  console.error(`✗ WASM 契约缺失 ${missing.length} 项:`);
  for (const m of missing) console.error(`    - ${m}`);
  console.error('请先运行 npm run build:wasm（wasm-pack release），并确认 websurf-phys 已导出。');
  process.exit(1);
}

console.log(`✓ WASM 契约通过：PhysWorld 类 + ${PHYS_API.length} 个方法全部导出。`);
