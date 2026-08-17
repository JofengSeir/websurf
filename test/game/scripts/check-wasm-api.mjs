/**
 * WASM 契约校验：确认 pkg/websurf_wasm.d.ts 包含最小化实现所需的全部 API。
 *
 * 契约 = 导出层 16 API（BSP 解析/导出/纹理）+ 物理层 17 API（PhysWorld）。
 * 缺失任一 API 即失败（提示先 npm run build:wasm）。
 *
 * 用法：node scripts/check-wasm-api.mjs
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dtsPath = join(root, 'pkg', 'websurf_wasm.d.ts');

if (!existsSync(dtsPath)) {
  console.error('错误: pkg/websurf_wasm.d.ts 不存在。请先运行 npm run build:wasm');
  process.exit(1);
}

const dts = readFileSync(dtsPath, 'utf8');

// 导出层：BspProcessor 方法与独立函数（BSP 解析 → GLB/碰撞/实体/PVS/纹理）
const EXPORT_API = [
  'metadata',
  'parse_spawn_points',
  'parse_teleports',
  'parse_pvs_data',
  'export_brushes_planes',
  'export_model_tri_colliders',
  'export_model_phy_colliders',
  'export_glb_with_pakfile_models',
  'export_glb_with_pakfile_models_with_defaults',
  'export_glb',
  'export_mosaic_manifest',
  'export_missing_textures',
  'take_event',
  // 独立函数（纹理压缩/解压）
  'mosaic_encode',
  'mosaic_decode',
  'decompress_mtz',
];

// 物理层：PhysWorld 类（Rust phys 模块，双 Worker 权威/预测共用）
const PHYS_API = [
  'build_world',
  'tick',
  'tick_into',
  'predict',
  'state',
  'state_out_ptr',
  'respawn',
  'teleport_to',
  'teleport_to_spawn',
  'set_spawn_points',
  'set_death_y',
  'set_params',
  'set_hull',
  'set_noclip',
  'set_state',
  'set_velocity',
  'set_yaw_pitch',
];

const missing = [];
for (const api of [...EXPORT_API, ...PHYS_API]) {
  // 匹配 "  name(...)" 方法声明或 "export function name" 独立函数
  const re = new RegExp(`\\b${api}\\s*\\(`);
  if (!re.test(dts)) missing.push(api);
}

if (missing.length > 0) {
  console.error(`✗ WASM 契约缺失 ${missing.length} 个 API:`);
  for (const m of missing) console.error(`    - ${m}`);
  console.error('请先运行 npm run build:wasm（wasm-pack release），并确认 phys 模块已导出。');
  process.exit(1);
}

console.log(`✓ WASM 契约通过：导出 ${EXPORT_API.length} + 物理 ${PHYS_API.length} API 全部存在。`);
