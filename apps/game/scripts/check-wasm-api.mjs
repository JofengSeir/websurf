/**
 * WASM 契约校验：确认 `pkg/websurf_wasm.d.ts` 包含最小化实现所需的全部 API。
 *
 * 本文件是**薄配置**：引擎在共享层 `src/scripts/lib/wasm-api-contract.mjs`（D-03 / T-03），
 * 本文件只声明「本工程的 pkg 名 + 契约面」并把结果落到输出与退出码。
 *
 * 校验面分两级（与改造前保持同一契约范围）：
 *   1) 声明面 `EXPORT_API` / `PHYS_API`：逐项断言 `\b<name>\s*\(` 命中声明文件；
 *   2) 导入面：`src/**\/*.ts` 对 `pkg/websurf_wasm*` 的实际导入符号必须 ⊆ 声明面，
 *      防止「清单写全了但源码引用了克隆里已删的符号」这类静默漂移。
 *
 * 用法：node scripts/check-wasm-api.mjs
 * 退出码：0 = 通过，1 = 不匹配
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDtsExports,
  assertTsImportsCoveredByExports,
  extractExportsFromDts,
  readDtsApiNames,
} from '../../../src/scripts/lib/wasm-api-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PKG_BASE = 'websurf_wasm';
const DTS = join(ROOT, 'pkg', `${PKG_BASE}.d.ts`);

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

const read = readDtsApiNames({ dtsPath: DTS });
if (!read.ok) {
  console.error(read.message);
  process.exit(1);
}

const api = [...EXPORT_API, ...PHYS_API];
const assertion = assertDtsExports({ dtsPath: DTS, apiNames: api, extraTokens: ['class PhysWorld'] });
const coverage = assertTsImportsCoveredByExports({
  tsRoot: join(ROOT, 'src'),
  pkgBasename: PKG_BASE,
  exports: extractExportsFromDts(DTS),
});

if (assertion.ok && coverage.ok) {
  console.log(`✓ WASM 契约通过：导出 ${EXPORT_API.length} + 物理 ${PHYS_API.length} API 全部存在。`);
  process.exit(0);
}

if (!assertion.ok) {
  console.error(`✗ WASM 契约缺失 ${assertion.missing.length} 个 API:`);
  for (const m of assertion.missing) console.error(`    - ${m}`);
  console.error('请先运行 npm run build:wasm（wasm-pack release），并确认 phys 模块已导出。');
}
if (!coverage.ok) {
  console.error(`✗ TS 导入了声明面之外的符号 ${coverage.missing.length} 个:`);
  for (const m of coverage.missing) console.error(`    - ${m}`);
}
process.exit(1);
