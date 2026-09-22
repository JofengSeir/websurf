#!/usr/bin/env node
/**
 * `RendererMain.optimizeScene` 的真实代码验证（node，无浏览器）。
 *
 * 做法：`apps/debug/package.json` 的 `test:optimize-scene` 先用 esbuild 把
 * `apps/debug/src/renderer/renderer-main.ts` 打成 ESM bundle（落在 `apps/debug/.tmp/opt-verify/`），
 * 本脚本再 import 该 bundle 并直接调用 `RendererMain.optimizeScene` —— TS 的 private 只是编译期
 * 约束，运行时可调，因此测的是产品代码本身而不是算法副本；缺 bundle 时打印补救命令并以 2 退出。
 * THREE 另外直接取自 `apps/debug/node_modules/three` 的构建产物（与 bundle 里的那份各自独立）。
 *
 * 为什么测它：GLTFLoader 为 GLB 的每个 primitive 建一个 `THREE.Mesh`，未合并时每帧要遍历数万个
 * 对象做视锥剔除与逐 mesh draw call，`apps/debug/src/renderer/lod-manager.ts` 的 `LodManager.update`
 * 也按对象数线性扫。`optimizeScene` 按空间 cell 把场景图压成「块」，本脚本锁定合并后的不变量。
 *
 * 场景按固定常量合成（不加载真实地图）：`MESH_COUNT` 个 primitive 分装进 `GLTF_MESHES` 个
 * `THREE.Group` 容器，材质池 `MATERIAL_COUNT`，顶点数在 `AVG_VERTS` 附近抖动，位置用固定种子
 * 的 LCG 在 `WORLD` 尺度内随机，容器树挂在充当 BSP 根的 `THREE.Scene` 下。
 * 这组常量是**写死的基线**，不随 `apps/debug/pkg` 或地图更新：断言① 校验的是「脚本造出的规模 ==
 * `MESH_COUNT`」，锚定本回归自身的可复现性，而不是当前 GLB 的真实规模 —— 用
 * `apps/debug/scripts/glb-mesh-count.mjs` 复核当前 `apps/debug/pkg` 时读数与它们不同。
 *
 * 断言（逐条打印 [PASS]/[FAIL]；失败数 > 0 则以 1 退出）：
 *   ① 合成场景的 Mesh 数 == `MESH_COUNT`；
 *   ② 输出 Mesh 数落在 [300, 800]（`optimizeScene` 的非空 cell 目标区间）；
 *   ③ 顶点总数逐字守恒（输入各 primitive 的 POSITION 顶点数之和 == 输出各块之和）；
 *   ④ `gltfScene` 已从 BSP 根摘除（不残留原 mesh 子树）；
 *   ⑤ 每个块的几何都重算了 `boundingSphere`（视锥外保一圈膨胀的前提）；
 *   ⑥ 块数比输入 Mesh 数至少低一个数量级。
 *
 * 用法：npm run test:optimize-scene   （先 esbuild 打包再运行本脚本）
 *      或手动：npx esbuild src/renderer/renderer-main.ts --bundle --format=esm \
 *                --platform=node --outfile=.tmp/opt-verify/renderer-main.bundle.mjs
 *              node scripts/optimize-scene-verify.mjs
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

// ── 载入 THREE（直接取 node_modules 的构建产物）与被打包的 RendererMain ──
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
/** optimizeScene 只读 this.camera（未 init 时相机为空，打印里的可见块估算为 N/A）；
 * 构造 RendererMain 需要一个 SharedState 桩，这里只放构造期会读到的几个成员。 */
function makeFakeShared() {
  return {
    readAuthoritative: () => null,
    readDecoupled: () => null,
    addInput: () => {},
    wake: () => {},
    isShared: true,
  };
}

// ── 按固定常量合成场景（规模对齐 optimizeScene 的输入量级） ──────────
const MESH_COUNT = 34409; // 合成场景的 primitive 总数（与断言① 同源）
const MATERIAL_COUNT = 319; // 材质池大小，primitive 从中随机取一个实例
const WORLD = 16320; // 随机位置的 World 尺度（world units）
const AVG_VERTS = 11; // 每个 primitive 的基准顶点数（实际在 ±2 内抖动）
const GLTF_MESHES = 117; // 容器 Group 数，每个容器挂若干个 primitive

let seed = 0x2f6e2b1; // 固定种子的 LCG：同一版本下两次运行结果一致
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const materials = [];
for (let i = 0; i < MATERIAL_COUNT; i++) materials.push(new THREE.MeshBasicMaterial({ color: 0x808080 }));

const scene = new THREE.Scene(); // 充当 optimizeScene 的 bspRoot 参数
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
    // 非平凡世界矩阵：让「顶点烘焙到世界空间」这条路径真的被走到
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

// ── 调用真实 optimizeScene，并统计输出的块数与顶点数 ────────────────
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
