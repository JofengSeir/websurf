#!/usr/bin/env node
/**
 * `RendererMain.optimizeScene` 的真实代码验证（node，无浏览器）。
 *
 * 做法：`apps/debug/package.json` 的 `test:optimize-scene` 先用 esbuild 把
 * `apps/debug/src/renderer/renderer-main.ts` 打成 ESM bundle（落在 `apps/debug/.tmp/opt-verify/`），
 * 再打一份共享优化器 `src/renderer-shared/scene/scene-optimizer.ts`（本脚本要直接调它的
 * `lookupMergeSource` 查表）。本脚本再 import 这两个 bundle 并直接调用 `RendererMain.optimizeScene`
 * —— TS 的 private 只是编译期约束，运行时可调，因此测的是产品代码本身而不是算法副本；
 * 缺 bundle 时打印补救命令并以 2 退出。THREE 另外直接取自仓库根 `node_modules/three` 的构建产物
 * （与 bundle 里的那份各自独立；`lookupMergeSource` 只读 `geometry.userData` 与 `userData` 里的
 * 普通字段，不跨实例判 `instanceof`，故两份 THREE 互不影响）。
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
 * 另有一组「来源区间表」断言（准星面板报 `(unnamed mesh)` 的修复面；撤掉表实现即 FAIL）：
 *   ⑦ 每个块几何都带表，且表的区间首尾相接、覆盖整段缓冲（索引/顶点两种长度口径）；
 *   ⑧ 全场景区间条目数 == `MESH_COUNT`（每只输入 mesh 恰好一条，无丢失无重复）；
 *   ⑨ 区间长度与所声明来源 mesh 的顶点数逐条相等；
 *   ⑩ **独立复算**：区间起点处的顶点世界坐标 == 该区间所声明来源 mesh 的第 0 个顶点 ——
 *      即表里的「名字」与缓冲里的「几何」真的对得上（只靠表自身推不出这一条）；
 *   ⑪ `lookupMergeSource` 的答案与测试脚本内独立二分的结果一致，越界 / 无表几何返回 null；
 *   ⑫ 第二个场景覆盖**索引 / 非索引 / 同一材质下混合**三种形态（走真实 `RendererMain.optimizeScene`
 *      注入的 `normalizeMergeGroup` 钩子），逐块核对表与两种口径下的 `faceIndex` 反查。
 *
 * 用法：npm run test:optimize-scene   （先 esbuild 打包再运行本脚本）
 *      或手动：npx esbuild src/renderer/renderer-main.ts --bundle --format=esm \
 *                --platform=node --outfile=.tmp/opt-verify/renderer-main.bundle.mjs
 *              npx esbuild ../../src/renderer-shared/scene/scene-optimizer.ts --bundle \
 *                --format=esm --platform=node --outfile=.tmp/opt-verify/scene-optimizer.bundle.mjs
 *              node scripts/optimize-scene-verify.mjs
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const debugDir = join(__dirname, '..');
const bundlePath = join(debugDir, '.tmp', 'opt-verify', 'renderer-main.bundle.mjs');
const sharedBundlePath = join(debugDir, '.tmp', 'opt-verify', 'scene-optimizer.bundle.mjs');

if (!existsSync(bundlePath) || !existsSync(sharedBundlePath)) {
  console.error(
    `缺少打包产物（${bundlePath} / ${sharedBundlePath}）\n请先执行：\n` +
      `  cd debug && npx esbuild src/renderer/renderer-main.ts --bundle --format=esm ` +
      `--platform=node --outfile=.tmp/opt-verify/renderer-main.bundle.mjs\n` +
      `  cd debug && npx esbuild ../../src/renderer-shared/scene/scene-optimizer.ts --bundle ` +
      `--format=esm --platform=node --outfile=.tmp/opt-verify/scene-optimizer.bundle.mjs`,
  );
  process.exit(2);
}

// ── 载入 THREE（直接取仓库根 node_modules 的构建产物——three 单实例已上收根级）与被打包的 RendererMain ──
const THREE = await import(
  pathToFileURL(join(debugDir, '..', '..', 'node_modules', 'three', 'build', 'three.module.js')).href
);
const mod = await import(pathToFileURL(bundlePath).href);
const RendererMain = mod.RendererMain;
const shared = await import(pathToFileURL(sharedBundlePath).href);
const { lookupMergeSource, MERGE_SOURCE_TABLE_KEY } = shared;

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

/** 逐只输入 mesh 的名字 → 独立复算用的原始事实（顶点数、第 0 个顶点的世界坐标）。 */
const sourceByName = new Map();

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
    // 名字与 userData.vbsp 与真实装载期同构（GLTFLoader 写 node.name、collectMetadata 写分类元数据）：
    // 逐只唯一，合并后要能在来源区间表里原样查回来
    mesh.name = `prim_${mi}_${pi}`;
    mesh.userData.vbsp = {
      isTools: false,
      isNodraw: false,
      hasTexture: true,
      isWater: false,
      isTrans: false,
      isLightEmissive: false,
      textureName: `tex_${mi}_${pi}`,
      materialName: `mat_${mi}_${pi}`,
    };
    sourceByName.set(mesh.name, {
      verts,
      // 世界坐标 = 局部顶点 + mesh.position（本场景只平移，无旋转/缩放）
      worldP0: [pos[0] + mesh.position.x, pos[1] + mesh.position.y, pos[2] + mesh.position.z],
      materialName: mesh.userData.vbsp.materialName,
    });
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

// ── 来源区间表（准星面板报 (unnamed mesh) 的修复面）──────────────────────────
// 表挂在合并结果几何的 userData 上（键由共享优化器导出）；这里既核对表自身的一致性，
// 也用「原始 mesh 的第 0 个顶点」作独立事实源复核表里的名字，最后调产品的 lookupMergeSource。

/** 读缓冲下标处的顶点坐标（索引几何先过 index，非索引几何直接用该下标）。 */
function positionAt(geometry, bufferIndex) {
  if (geometry.index) {
    const vi = geometry.index.getX(bufferIndex);
    return [geometry.attributes.position.getX(vi), geometry.attributes.position.getY(vi), geometry.attributes.position.getZ(vi)];
  }
  return [
    geometry.attributes.position.getX(bufferIndex),
    geometry.attributes.position.getY(bufferIndex),
    geometry.attributes.position.getZ(bufferIndex),
  ];
}
/** 几何在合并口径下的缓冲长度（索引数或顶点数）。 */
function bufferLength(geometry) {
  if (geometry.index) return geometry.index.count;
  return geometry.attributes.position ? geometry.attributes.position.count : 0;
}
/** 测试脚本自己的二分（与产品实现无关的对照实现）。 */
function searchRange(ranges, probe) {
  let lo = 0;
  let hi = ranges.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].start <= probe) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const range = ranges[found];
  return probe < range.start + range.count ? range : null;
}
/** 坐标比对容差：合并缓冲是 Float32，而期望值按双精度算（量级 ~1e4 时单精度尾数量级 1e-3）。 */
function closeTo(a, b) {
  return Math.abs(a - b) <= 1e-3 + Math.abs(b) * 1e-6;
}

const chunkEntries = [];
for (const child of scene.children) {
  const g = child.geometry;
  if (!g?.attributes?.position) continue;
  chunkEntries.push({ geometry: g, table: g.userData?.[MERGE_SOURCE_TABLE_KEY] });
}

let tableCount = 0;
let rangeCount = 0;
let contiguousOk = true;
let coverOk = true;
let indexedFlagOk = true;
let countOk = true;
let posOk = true;
let posChecked = 0;
let lookupOk = true;
let lookupProbed = 0;
const posBadSamples = [];
for (const entry of chunkEntries) {
  const g = entry.geometry;
  const table = entry.table;
  if (!table) continue;
  tableCount++;
  const ranges = table.ranges;
  rangeCount += ranges.length;
  if (ranges.length === 0 || ranges[0].start !== 0) contiguousOk = false;
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i - 1].start + ranges[i - 1].count !== ranges[i].start) contiguousOk = false;
  }
  const last = ranges[ranges.length - 1];
  const bufLen = bufferLength(g);
  if (!last || last.start + last.count !== bufLen) coverOk = false;
  if (table.indexed !== (g.index !== null)) indexedFlagOk = false;

  for (const range of ranges) {
    const src = sourceByName.get(range.meshName);
    if (!src) {
      posOk = false;
      continue;
    }
    if (range.count !== src.verts) countOk = false;
    const got = positionAt(g, range.start);
    if (!closeTo(got[0], src.worldP0[0]) || !closeTo(got[1], src.worldP0[1]) || !closeTo(got[2], src.worldP0[2])) {
      posOk = false;
      if (posBadSamples.length < 5) posBadSamples.push(`${range.meshName} start=${range.start} got=${got.join(',')} want=${src.worldP0.join(',')}`);
    }
    posChecked++;
  }

  // faceIndex 反查：抽样与测试脚本独立二分的结果对照（两种口径都按 faceIndex * 3 落区间）。
  // 三角形序号范围与 three 的 Mesh.raycast 一致：i 从 0 步进 3，i < count ⇒ 最大 t = ceil(count/3) - 1
  const stride = Math.max(1, Math.floor(Math.ceil(bufLen / 3) / 40));
  for (let t = 0; t * 3 < bufLen; t += stride) {
    lookupProbed++;
    const want = searchRange(ranges, t * 3);
    const got = lookupMergeSource(g, t);
    if (!want || !got || got.start !== want.start || got.meshName !== want.meshName || got.count !== want.count) {
      lookupOk = false;
    }
  }
  if (lookupMergeSource(g, bufLen) !== null) lookupOk = false; // probe = 3×缓冲长度 ⇒ 必在全部区间之外
}

check('每个块几何都带来源区间表（撤掉表实现即 FAIL）', tableCount === outMeshes, `${tableCount}/${outMeshes}`);
check('区间首尾相接（无缝隙、无重叠）', contiguousOk);
check('区间覆盖整段缓冲（索引口径或顶点口径）', coverOk);
check('表的 indexed 标记与几何是否带 index 一致', indexedFlagOk);
check('区间条目数 == 输入 mesh 数（每只恰好一条）', rangeCount === MESH_COUNT, `${rangeCount} vs ${MESH_COUNT}`);
check('区间长度 == 所声明来源 mesh 的顶点数', countOk);
check(
  '独立复算：区间起点顶点世界坐标 == 来源 mesh 第 0 个顶点',
  posOk && posChecked === MESH_COUNT,
  `核对 ${posChecked} 条，不符 ${posOk ? 0 : '>0'} ${posBadSamples.join(' | ')}`,
);
check(`lookupMergeSource 与独立二分一致（抽样 ${lookupProbed} 次）`, lookupOk);
check('无来源表的几何查表返回 null', lookupMergeSource(new THREE.BufferGeometry(), 0) === null);
check('faceIndex 非法（负值/缺省）返回 null', lookupMergeSource(chunkEntries[0]?.geometry, -1) === null && lookupMergeSource(null, 0) === null);

// ── 第二场景：索引 / 非索引 / 同材质混合三形态（走真实 optimizeScene 的归一钩子）──
// 簇 A：2 个材质 × 2 只索引几何（全索引 → 二级 useGroups 合并）；
// 簇 B：2 个材质 × 2 只非索引几何；
// 簇 C：同一材质下 1 只索引 + 1 只非索引（钩子把索引那只摊平后再合并）。
// 三簇相距 10 万 HU ⇒ 必落三个不同 cell（cellSize 上限 4096）。
const scene2 = new THREE.Scene();
const gltfScene2 = new THREE.Group();
gltfScene2.userData.isBspModel = true;
/** 第二场景的名字 → 独立事实（顶点数、世界第 0 顶点、期望的 indexed 口径）。 */
const source2 = new Map();
const matA1 = new THREE.MeshBasicMaterial({ color: 0x111111 });
const matA2 = new THREE.MeshBasicMaterial({ color: 0x222222 });
const matC = new THREE.MeshBasicMaterial({ color: 0x333333 });

function addPrim(baseX, name, verts, indexed, material) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(verts * 3);
  for (let v = 0; v < verts; v++) {
    pos[v * 3] = v;
    pos[v * 3 + 1] = v * 2;
    pos[v * 3 + 2] = v * 3;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(verts * 2), 2));
  if (indexed) {
    const idx = new Uint16Array(verts);
    for (let v = 0; v < verts; v++) idx[v] = v;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.position.set(baseX, 0, 0);
  mesh.updateMatrix();
  mesh.userData.vbsp = { materialName: `${name}_mat`, textureName: `${name}_tex` };
  source2.set(name, { verts, worldP0: [pos[0] + baseX, pos[1], pos[2]], materialName: `${name}_mat` });
  gltfScene2.add(mesh);
}
addPrim(100000, 'idxA1', 9, true, matA1);
addPrim(100010, 'idxA2', 6, true, matA1);
addPrim(100020, 'idxA3', 12, true, matA2);
addPrim(100030, 'idxA4', 6, true, matA2);
addPrim(-100000, 'nonB1', 9, false, matA1);
addPrim(-100010, 'nonB2', 6, false, matA1);
addPrim(-100020, 'nonB3', 12, false, matA2);
addPrim(-100030, 'nonB4', 6, false, matA2);
addPrim(200000, 'mixC1', 9, true, matC);
addPrim(200010, 'mixC2', 6, false, matC);
scene2.add(gltfScene2);
r.optimizeScene(scene2, gltfScene2);

const chunkEntries2 = [];
for (const child of scene2.children) {
  const g = child.geometry;
  if (!g?.attributes?.position) continue;
  chunkEntries2.push({ geometry: g, table: g.userData?.[MERGE_SOURCE_TABLE_KEY] });
}
const byNames = (names) => {
  const want = new Set(names);
  return chunkEntries2.filter((e) => {
    const got = new Set((e.table?.ranges ?? []).map((x) => x.meshName));
    return got.size === want.size && [...want].every((n) => got.has(n));
  });
};
const clusterA = byNames(['idxA1', 'idxA2', 'idxA3', 'idxA4']);
const clusterB = byNames(['nonB1', 'nonB2', 'nonB3', 'nonB4']);
const clusterC = byNames(['mixC1', 'mixC2']);
check(
  '第二场景三个簇各自合并成一块',
  chunkEntries2.length === 3 && clusterA.length === 1 && clusterB.length === 1 && clusterC.length === 1,
  `块 ${chunkEntries2.length}（A ${clusterA.length} / B ${clusterB.length} / C ${clusterC.length}）`,
);

/** 逐块核对第二场景：表口径、条目数、长度、独立坐标复算、faceIndex 反查。 */
function verifyCluster(entry, expectIndexed) {
  const g = entry.geometry;
  const table = entry.table;
  const problems = [];
  if (!table) return ['无表'];
  if (table.indexed !== expectIndexed) problems.push(`indexed=${table.indexed} 期望 ${expectIndexed}`);
  if ((g.index !== null) !== expectIndexed) problems.push('几何 index 与期望不符');
  const ranges = table.ranges;
  let cursor = 0;
  for (const range of ranges) {
    const src = source2.get(range.meshName);
    if (!src) {
      problems.push(`未知来源名 ${range.meshName}`);
      continue;
    }
    if (range.start !== cursor) problems.push(`区间起点不接续 ${range.start} != ${cursor}`);
    // 索引几何的区间长度是索引数，非索引是顶点数；本场景两者相等（index = 恒等表）
    if (range.count !== src.verts) problems.push(`${range.meshName} 长度 ${range.count} != ${src.verts}`);
    const got = positionAt(g, range.start);
    if (!closeTo(got[0], src.worldP0[0]) || !closeTo(got[1], src.worldP0[1]) || !closeTo(got[2], src.worldP0[2])) {
      problems.push(`${range.meshName} 起点坐标 ${got.join(',')} != ${src.worldP0.join(',')}`);
    }
    // 区间起点必是三角形边界（本场景每份几何的顶点数都是 3 的倍数）
    const hit = lookupMergeSource(g, range.start / 3);
    if (!hit || hit.meshName !== range.meshName || hit.start !== range.start) problems.push(`${range.meshName} faceIndex 反查失配`);
    cursor += range.count;
  }
  if (cursor !== bufferLength(g)) problems.push(`区间总长 ${cursor} != 缓冲 ${bufferLength(g)}`);
  return problems;
}
const probsA = clusterA[0] ? verifyCluster(clusterA[0], true) : ['缺簇 A'];
const probsB = clusterB[0] ? verifyCluster(clusterB[0], false) : ['缺簇 B'];
const probsC = clusterC[0] ? verifyCluster(clusterC[0], false) : ['缺簇 C'];
check('第二场景 簇 A（全索引，二级 useGroups 合并）表自洽 + 反查正确', probsA.length === 0, probsA.join('；'));
check('第二场景 簇 B（全非索引）表自洽 + 反查正确', probsB.length === 0, probsB.join('；'));
check('第二场景 簇 C（同材质索引+非索引，钩子归一后按顶点计）表自洽 + 反查正确', probsC.length === 0, probsC.join('；'));
check(
  '第二场景元数据按来源带过（materialName 取自各自来源 mesh）',
  [clusterA[0], clusterB[0], clusterC[0]].every(
    (e) =>
      (e?.table?.ranges?.length ?? 0) > 0 &&
      e.table.ranges.every((range) => range.vbsp?.materialName === source2.get(range.meshName)?.materialName),
  ),
);

console.log(`\noptimizeScene 验证：${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
