#!/usr/bin/env node
/**
 * optimizeScene 真实代码验证（node，无浏览器）。
 *
 * 直接调用 debug 渲染器构建产物里的 `RendererMain.optimizeScene`（TypeScript private
 * 仅编译期约束，运行时可调）——不是复制算法，**测的就是产品代码本身**。
 *
 * 为什么需要：debug 的流畅度主因是 GLB 场景规模。实测（见文末「实测规模」）
 * surf_666 的 GLB 有 **34409 个 primitive**，而 GLTFLoader 对每个 primitive 生成一个
 * `THREE.Mesh` → 场景 ~34409 个 Mesh。未做分块合并时每帧要遍历 3.4 万对象做视锥剔除、
 * 逐 mesh draw call，且 `LodManager.update()` 每帧线性扫 3.4 万项 —— 渲染耗时逼近/超过
 * vsync 间隔 → 掉帧与卡顿。本脚本锁定修复后的不变量，防回归。
 *
 * 断言：
 *   1. 输入规模 == 34409 Mesh（与实测 GLB primitive 数一致，防测试自身失真）；
 *   2. 分块生效：输出 Mesh 数落在 [300, 800]；
 *   3. **顶点总数逐字守恒**（无几何丢失、无重复计数）；
 *   4. gltf.scene 已从 BSP 根摘除（不残留 3.4 万原 mesh）；
 *   5. 每块 geometry.boundingSphere 均已重算（FRUSTUM_PAD 膨胀的前提）；
 *   6. 块数至少降一个数量级（draw call 量级下降）。
 *
 * 用法：npm run test:optimize-scene   （本项目 package.json；内部先 esbuild 打包再运行）
 *      或手动：npx esbuild src/renderer/renderer-main.ts --bundle --format=esm \
 *                --platform=node --outfile=.tmp/opt-verify/renderer-main.bundle.mjs
 *              node scripts/optimize-scene-verify.mjs
 *
 * 实测规模（`.tmp/glb-mesh-count.mjs` 用 debug pkg wasm 导出真实 GLB 后统计）：
 *   117 glTF mesh / 34409 primitive / 377385 POSITION 顶点 / 319 材质 / 515 nodes；
 *   GLB 136.0 MB，BSP 75.5 MB。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const debugDir = join(__dirname, '..');
const bundlePath = join(debugDir, '.tmp', 'opt-verify', 'renderer-main.bundle.mjs');

if (!existsSync(bundlePath)) {
  console.error(
    `缺少打包产物 ${bundlePath}\n请先执行：\n` +
      `  cd debug && npx esbuild src/renderer/renderer-main.ts --bundle --format=esm ` +
      `--platform=node --outfile=.tmp/opt-verify/renderer-main.bundle.mjs`,
  );
  process.exit(2);
}

// ── 载入 THREE 与被打包的 RendererMain ───────────────────────────────
const THREE = await import(
  pathToFileURL(join(debugDir, 'node_modules', 'three', 'build', 'three.module.js')).href
);
const mod = await import(pathToFileURL(bundlePath).href);
const RendererMain = mod.RendererMain;

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function countMeshes(rootObj) {
  let n = 0;
  rootObj.traverse((o) => {
    if (o.isMesh) n++;
  });
  return n;
}
/** optimizeScene 只读取 this.camera；构造 RendererMain 需要一个 SharedState 桩。 */
function makeFakeShared() {
  return {
    readAuthoritative: () => null,
    readDecoupled: () => null,
    addInput: () => {},
    wake: () => {},
    isShared: true,
  };
}

// ── 按实测 GLB 规模构造场景 ─────────────────────────────────────────
const MESH_COUNT = 34409; // 实测 primitive 数
const MATERIAL_COUNT = 319; // 实测材质数
const WORLD = 16320; // surf_666 世界尺度（world units）
const AVG_VERTS = 11; // 377385 / 34409 ≈ 11
const GLTF_MESHES = 117; // 实测 glTF mesh 数（multi-primitive 容器）

let seed = 0x2f6e2b1; // 确定性 LCG（结果可复现）
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const materials = [];
for (let i = 0; i < MATERIAL_COUNT; i++) materials.push(new THREE.MeshBasicMaterial({ color: 0x808080 }));

const scene = new THREE.Scene(); // = bspRoot
const gltfScene = new THREE.Group();
gltfScene.userData.isBspModel = true;

let expectedVerts = 0;
const primsPerMesh = Math.floor(MESH_COUNT / GLTF_MESHES);
const extra = MESH_COUNT - primsPerMesh * GLTF_MESHES;
for (let mi = 0; mi < GLTF_MESHES; mi++) {
  const container = new THREE.Group();
  const n = primsPerMesh + (mi < extra ? 1 : 0);
  for (let pi = 0; pi < n; pi++) {
    const verts = AVG_VERTS + Math.floor(rnd() * 5) - 2;
    const pos = new Float32Array(verts * 3);
    for (let v = 0; v < verts; v++) {
      pos[v * 3] = (rnd() - 0.5) * 64;
      pos[v * 3 + 1] = (rnd() - 0.5) * 64;
      pos[v * 3 + 2] = (rnd() - 0.5) * 64;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(verts * 2), 2));
    const mesh = new THREE.Mesh(geo, materials[Math.floor(rnd() * MATERIAL_COUNT)]);
    // 非平凡世界矩阵：验证「顶点烘焙世界空间」路径
    mesh.position.set((rnd() - 0.5) * WORLD, (rnd() - 0.5) * WORLD * 0.3, (rnd() - 0.5) * WORLD);
    mesh.updateMatrix();
    container.add(mesh);
    expectedVerts += verts;
  }
  gltfScene.add(container);
}
scene.add(gltfScene);

check(
  '输入规模 == 34409 场景 Mesh（与实测 GLB primitive 数一致）',
  countMeshes(scene) === MESH_COUNT,
  `实际 ${countMeshes(scene)}`,
);

// ── 调用真实 optimizeScene ──────────────────────────────────────────
const r = new RendererMain(makeFakeShared());
const sceneBefore = countMeshes(scene);
const t0 = Date.now();
r.optimizeScene(scene, gltfScene);
const ms = Date.now() - t0;

const outMeshes = countMeshes(scene);
let outVerts = 0;
let sphereCount = 0;
for (const child of scene.children) {
  const g = child.geometry;
  if (!g?.attributes?.position) continue;
  outVerts += g.attributes.position.count;
  if (g.boundingSphere) sphereCount++;
}

console.log(`\n── optimizeScene 结果（${ms} ms，地图加载期一次性）──`);
console.log(`  输入 Mesh ${sceneBefore} → 输出 Mesh ${outMeshes}`);
console.log(`  顶点 入 ${expectedVerts} → 出 ${outVerts}\n`);

check('分块生效：输出 Mesh 数落在 [300, 800]', outMeshes >= 300 && outMeshes <= 800, `实际 ${outMeshes}`);
check('顶点总数守恒（无几何丢失 / 无重复计数）', outVerts === expectedVerts, `入 ${expectedVerts} vs 出 ${outVerts}`);
check('gltf.scene 已从 BSP 根摘除（无原 mesh 残留）', !scene.children.includes(gltfScene));
check('每块 boundingSphere 均已重算（FRUSTUM_PAD 前提）', sphereCount === outMeshes, `${sphereCount}/${outMeshes}`);
check('块数至少降一个数量级（draw call 量级下降）', outMeshes < sceneBefore / 10, `${sceneBefore} → ${outMeshes}`);

console.log(`\noptimizeScene 验证：${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
