/**
 * 光照导出冒烟测试 —— wasm `export_glb_with_pakfile_models_with_lights` 端到端验证。
 *
 * 读入 .bsp → 解析 → 导出含 KHR_lights_punctual 的 GLB →
 * 校验 extensionsUsed / lights 定义 / 光源节点 / 模型 mesh 存在。
 *
 * 用法：node scripts/check-lights.mjs [bsp路径]
 * 默认 ../../maps/ze_cursed_bear_tales_v1_2.bsp（v21 CS:GO，光照实体丰富）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initSync, BspProcessor } from '../pkg/websurf_wasm.js';

const bspPath = process.argv[2] ?? '../../maps/ze_cursed_bear_tales_v1_2.bsp';
const fullPath = resolve(bspPath);

// 1. wasm 初始化（node：直接喂 wasm 字节）
initSync({ module: readFileSync(new URL('../pkg/websurf_wasm_bg.wasm', import.meta.url)) });

// 2. 解析 + 导出（模型 + 光照）
console.log(`读取 BSP: ${fullPath}`);
const bytes = readFileSync(fullPath);
console.log(`  大小: ${(bytes.length / 1048576).toFixed(1)} MB`);
const t0 = Date.now();
const proc = new BspProcessor(bytes);
const glb = proc.export_glb_with_pakfile_models_with_lights();
console.log(`  导出耗时: ${((Date.now() - t0) / 1000).toFixed(1)} s | GLB: ${(glb.length / 1048576).toFixed(1)} MB`);

// 3. 解析 GLB JSON 块（GLB 头 12B + JSON 长度 u32 LE + JSON）
if (glb.length < 20) {
  console.error('✗ GLB 过短');
  process.exit(1);
}
const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
const jsonLen = view.getUint32(12, true);
const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb.buffer, glb.byteOffset + 20, jsonLen)));

// 4. 校验
const used = json.extensionsUsed ?? [];
const hasLights = used.includes('KHR_lights_punctual');
const lights = json.extensions?.KHR_lights_punctual?.lights ?? [];
const lightNodes = (json.nodes ?? []).filter(
  (n) => n.extensions?.KHR_lights_punctual !== undefined,
).length;
const meshCount = json.meshes?.length ?? 0;
const nodeCount = json.nodes?.length ?? 0;

const types = {};
for (const l of lights) types[l.type] = (types[l.type] ?? 0) + 1;

console.log('── 校验结果 ──');
console.log(`  extensionsUsed: ${used.join(', ')}`);
console.log(`  KHR_lights_punctual: ${hasLights ? '✓ 存在' : '✗ 缺失'}`);
console.log(`  灯光定义: ${lights.length} 个 (${JSON.stringify(types)})`);
console.log(`  光源节点: ${lightNodes} 个`);
console.log(`  mesh: ${meshCount} | nodes: ${nodeCount}`);

let failed = false;
if (!hasLights || lights.length === 0 || lightNodes === 0) {
  console.error('✗ 光照导出失败');
  failed = true;
}
if (meshCount === 0) {
  console.error('✗ 无 mesh（导出异常）');
  failed = true;
}
console.log(failed ? '✗ FAIL' : '✓ PASS');
process.exit(failed ? 1 : 0);
