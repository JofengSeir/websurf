#!/usr/bin/env node
/**
 * GLB 场景规模量化（诊断工具：只读文件、只打印读数，不写任何产物）。
 *
 * 做什么：用 `apps/debug/pkg` 的 wasm 产物（`websurf_wasm.js` + `websurf_wasm_bg.wasm`，由
 * `apps/debug/package.json` 的 `build:wasm` 生成）在 node 里解析一张 BSP，调
 * `BspProcessor.export_glb_with_pakfile_models` 导出 GLB，再就地解析 GLB 的 JSON chunk，
 * 统计 glTF 的 mesh / primitive / node / material 数与 POSITION 顶点总数、世界包围盒。
 *
 * 为什么要这个数：GLTFLoader 对每个 primitive 生成一个 `THREE.Mesh`，于是「场景 Mesh 数 =
 * primitive 数」，它决定每帧对象遍历、视锥剔除与逐 mesh draw call 的量级，用于判断某张地图
 * 是否值得做空间分块合并 —— 合并的实现是 `apps/debug/src/renderer/renderer-main.ts` 的
 * `RendererMain.optimizeScene`，其回归验证在 `apps/debug/scripts/optimize-scene-verify.mjs`。
 *
 * 输入：argv[2] 为地图路径，缺省 <仓库根>/test/maps/surf_666.bsp（`test/maps` 被 gitignore）。
 * 输出：全部走 stdout，无断言、不落盘；结论不以退出码表达（只有抛异常才非 0）。
 *
 * 用法：npm run count:glb-meshes            （默认 test/maps/surf_666.bsp）
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

// GLB 头是 magic / version / length 三个 u32（本脚本只用 magic 判格式，长度字段不读）；
// 首个 chunk 的头是 len u32 + type u32，JSON 数据紧接其后。
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
// 世界包围盒：把各 primitive 的 POSITION accessor 的 min/max 逐轴聚合（缺 min/max 的不参与）
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
