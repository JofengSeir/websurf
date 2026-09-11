#!/usr/bin/env node
/**
 * GLB 场景规模量化（诊断工具）— 用 debug 的 wasm pkg 在 node 里导出 BSP 的 GLB，
 * 解析其 JSON chunk，统计 mesh / primitive / node / material / 顶点数。
 *
 * 用途：为渲染性能问题提供硬数字。GLTFLoader 对**每个 primitive 生成一个
 * `THREE.Mesh`**，故「场景 Mesh 数 = primitive 数」——这个数直接决定每帧的
 * 对象遍历与 draw call 量级。据此判断某张地图是否需要空间分块合并
 * （`RendererMain.optimizeScene`；回归测试见 `scripts/optimize-scene-verify.mjs`）。
 *
 * 实测（surf_666.bsp）：117 glTF mesh / **34409 primitive** / 377385 顶点 / 319 材质 /
 * 515 nodes；GLB 136.0 MB。即未合并时场景约 3.4 万个 Mesh 对象。
 *
 * 用法：npm run count:glb-meshes            （默认 maps/surf_666.bsp）
 *       npm run count:glb-meshes -- <path.bsp>
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const debugDir = join(__dirname, '..');
const repoRoot = join(debugDir, '..', '..');

const mapPath = process.argv[2] ?? join(repoRoot, 'test', 'maps', 'surf_666.bsp');
const pkgJs = join(debugDir, 'pkg', 'websurf_wasm.js');
const pkgWasm = join(debugDir, 'pkg', 'websurf_wasm_bg.wasm');

const t0 = Date.now();
const mod = await import(pathToFileURL(pkgJs).href);
mod.initSync({ module: readFileSync(pkgWasm) });
console.log(`wasm 初始化完成 (${Date.now() - t0} ms)`);

const t1 = Date.now();
const bytes = readFileSync(mapPath);
const proc = new mod.BspProcessor(new Uint8Array(bytes));
console.log(`BSP 解析完成 (${Date.now() - t1} ms)  ${(bytes.length / 1048576).toFixed(1)} MB`);

const t2 = Date.now();
const glb = proc.export_glb_with_pakfile_models();
console.log(`GLB 导出完成 (${Date.now() - t2} ms)  ${(glb.byteLength / 1048576).toFixed(1)} MB`);

// ── GLB 解析（magic u32 / version u32 / length u32，随后 chunk: len u32 + type u32 + data）──
const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
const magic = dv.getUint32(0, true);
if (magic !== 0x46546c67) throw new Error(`不是 GLB（magic=0x${magic.toString(16)}）`);
const jsonLen = dv.getUint32(12, true);
const jsonType = dv.getUint32(16, true);
if (jsonType !== 0x4e4f534a) throw new Error(`首个 chunk 非 JSON（type=0x${jsonType.toString(16)}）`);
const json = JSON.parse(
  new TextDecoder().decode(new Uint8Array(glb.buffer, glb.byteOffset + 20, jsonLen)),
);

const meshes = json.meshes ?? [];
const nodes = json.nodes ?? [];
const materials = json.materials ?? [];
const accessors = json.accessors ?? [];

let primitives = 0;
let multiPrimMeshes = 0;
let posVertices = 0;
// 世界包围盒（POSITION accessor 的 min/max 聚合）——用于核对剔除/视距设置
const gmin = [Infinity, Infinity, Infinity];
const gmax = [-Infinity, -Infinity, -Infinity];
for (const m of meshes) {
  const ps = m.primitives ?? [];
  primitives += ps.length;
  if (ps.length > 1) multiPrimMeshes++;
  for (const p of ps) {
    const acc = accessors[p.attributes?.POSITION];
    if (acc && typeof acc.count === 'number') posVertices += acc.count;
    if (acc?.min && acc?.max) {
      for (let i = 0; i < 3; i++) {
        if (acc.min[i] < gmin[i]) gmin[i] = acc.min[i];
        if (acc.max[i] > gmax[i]) gmax[i] = acc.max[i];
      }
    }
  }
}
const finite = gmin.every(Number.isFinite) && gmax.every(Number.isFinite);
const size = finite ? [gmax[0] - gmin[0], gmax[1] - gmin[1], gmax[2] - gmin[2]] : null;
const diag = size ? Math.hypot(size[0], size[1], size[2]) : 0;
const maxDim = size ? Math.max(size[0], size[1], size[2]) : 0;

console.log('\n── GLB 场景规模 ──');
console.log(`  meshes（glTF 定义）      : ${meshes.length}`);
console.log(`  primitives（= 场景 Mesh）: ${primitives}   <-- GLTFLoader 每个 primitive 一个 THREE.Mesh`);
console.log(`  多 primitive 的 mesh     : ${multiPrimMeshes}`);
console.log(`  nodes                    : ${nodes.length}`);
console.log(`  materials                : ${materials.length}`);
console.log(`  POSITION 顶点总数         : ${posVertices}`);
if (size) {
  console.log(`  世界包围盒尺寸            : ${size.map((v) => v.toFixed(0)).join(' × ')}`);
  console.log(`  对角 diag                 : ${diag.toFixed(0)}   maxDim: ${maxDim.toFixed(0)}`);
  console.log('');
  console.log('  视距剔除参考（各实现的实际取值）：');
  console.log(`    game  ：maxDim × 0.5            = ${Math.max(maxDim * 0.5, 1000).toFixed(0)}`);
  console.log(`    debug ：min(⌈diag×2/100⌉×100, 12800) = ${Math.min(Math.ceil((diag * 2) / 100) * 100, 12800)}`);
}
console.log('');
console.log(`  未合并时：每帧遍历 ~${primitives} 个 Mesh + 逐 mesh draw call`);
console.log(`  分块合并后（目标 300~800 块）：draw call 约降 ${(primitives / 600).toFixed(0)}×`);
