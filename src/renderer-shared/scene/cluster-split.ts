/**
 * 按 cluster 拆分合并块 —— 把「看得见才画」从**块级并集**下沉到**三角形级**。
 *
 * 为什么需要这一步：`mergeIntoChunks` 把同一个 cell 里的面合并成一块，一个块经常横跨好几个
 * 房间（BSP leaf）。运行期 PVS 只能判「这块里有没有一个 cluster 可见」，于是「任一分区可见
 * ⇒ 整块画」——块里属于**别的房间**的三角形也跟着出来。surf_666 室内隔着窗看到别处关卡结构，
 * 量出来就是：21 个绘制块里 398 个采样三角形中有 208 个属于不可见 cluster（52%）。
 *
 * 做法（装载期一次性）：
 * - 三角形重心 + 面法线朝可见侧外偏 → BSP leaf → cluster，按 cluster 分桶；
 * - 每个桶生成一个子 Mesh：**共享父几何的顶点属性**（同一个 BufferAttribute 实例，three 按
 *   对象缓存 GPU buffer，不重传、不翻倍显存），只重建 index；
 * - 子块记 `userData.splitClusters`（单元素，超限合并时是并集），运行期 PVS 判定精确到房间；
 * - 单 cluster 的块不动（绝大多数块走这条路，draw 数基本不变）。
 *
 * 三个必须绕开的坑（都是有代价的实测结论）：
 * 1. **水面块不能拆**：镜面驱动是按 mesh 挂的（`water.ts` 的 `attachMirrorDriver`），水面高度
 *    也按 mesh 包围球推；拆了子片不进 `mirrorMeshes`，水面直接没有反射。
 * 2. **包围盒必须按子 index 自己算**：three r165 的 `computeBoundingBox/Sphere` 只看 position，
 *    忽略 index ⇒ 直接调用只会得到父块的大盒，距离档与透明排序会退回块级口径。
 * 3. **groups 的 start/count 是「顶点或 index 单元」不是三角形序号**：非索引几何里它按顶点区间
 *    给，拿三角形序号去比会把材质挂错。
 */
import * as THREE from 'three';
import type { VisibilityController } from './visibility-controller.js';
import type { PvsManager } from '../../ts-shared/world/pvs-manager.js';

/** 拆分结果（装载期打印一次，便于对照 draw 数变化）。 */
export interface ClusterSplitStats {
  /** 交给拆分器考虑的块（`clusterIds.length > 1`）。 */
  candidates: number;
  /** 真正被拆开的块数。 */
  split: number;
  /** 生成的子片总数。 */
  pieces: number;
  /** 一个三角形都归属不出来的块（顶点全在固体里），保持原样。 */
  unmapped: number;
  /** 因水面/过小/预算不足而跳过的块。 */
  skipped: number;
  /** 采样耗时（毫秒）。 */
  sampleMs: number;
}

export interface ClusterSplitOptions {
  /** 小于这个三角形数的块不拆：拆出来的片太小，收益抵不过 draw 开销。 */
  minTris?: number;
  /** 只有 cluster 数达到这个值的块才拆（跨房间才值得拆）。 */
  minClusters?: number;
  /** 单块最多拆成几片（超过则把最小片并进最大片，并集记进 `splitClusters`）。 */
  maxPieces?: number;
  /** 全局新增片数预算（占原块数比例）：防止 draw 爆炸。 */
  maxNewPieceRatio?: number;
}

const DEFAULT_MIN_TRIS = 256;
const DEFAULT_MAX_PIECES = 8;
const DEFAULT_MAX_NEW_RATIO = 1.2;
/** 默认只有跨 4 个以上房间的块才拆。 */
const DEFAULT_MIN_CLUSTERS = 4;

/** 水面块：镜面驱动逐 mesh 挂，拆了就没有反射。 */
function isWaterMesh(mesh: THREE.Mesh): boolean {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    if (m?.userData && (m.userData as Record<string, unknown>).vbsp_water) return true;
  }
  return /water/i.test(mesh.name || '');
}

/**
 * 逐三角形求所属 cluster：用**面法线**（几何法线）朝可见侧外偏，避开顶点法线在硬边上的歧义。
 * 返回 -1 表示这个三角形整块埋在固体里（地图外壳、brush 内壁），交给调用方并进兜底片。
 */
function triangleCluster(
  pvs: PvsManager,
  pos: THREE.BufferAttribute,
  face: THREE.BufferAttribute | null,
  i0: number,
  i1: number,
  i2: number,
  matrix: THREE.Matrix4,
  out: THREE.Vector3,
): number {
  // 首选几何里已有的 `_vbsp_face`：face → BSP face → cluster 是**精确**归属，不受「法线朝哪边
  // 偏」的影响（墙面正处在两个房间的交界，按法线偏 4 HU 很容易偏进隔壁房间，那正是拆分后
  // 仍有 50% 三角形被判到不可见 cluster 的原因）。
  if (face) {
    const f = face.getX(i0);
    const cl = pvs.getFaceCluster(Math.round(f));
    if (cl >= 0) return cl;
  }
  const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
  const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
  const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);
  const gx = (ax + bx + cx) / 3;
  const gy = (ay + by + cy) / 3;
  const gz = (az + bz + cz) / 3;
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  for (const off of [4, 16, 64]) {
    for (const s of [off, -off]) {
      out.set(gx + nx * s, gy + ny * s, gz + nz * s).applyMatrix4(matrix);
      const cl = pvs.getClusterAt({ x: out.x, y: out.y, z: out.z });
      if (cl >= 0) return cl;
    }
  }
  out.set(gx, gy, gz).applyMatrix4(matrix);
  return pvs.getClusterAt({ x: out.x, y: out.y, z: out.z });
}

/** 按本片自己的三角形算包围盒/球（three 自带方法会忽略 index，退回父块尺寸）。 */
function computeSubsetBounds(geom: THREE.BufferGeometry, indexArray: ArrayLike<number>, matrix: THREE.Matrix4): void {
  const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < indexArray.length; i++) {
    v.fromBufferAttribute(pos, indexArray[i]).applyMatrix4(matrix);
    box.expandByPoint(v);
  }
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  // 1.6 的余量：与 `scene-optimizer.ts` 里合并块包围球的口径一致（视锥判定偏保守，不误剔）。
  sphere.radius *= 1.6;
  geom.boundingBox = box;
  geom.boundingSphere = sphere;
}

/**
 * 把主根里「跨多个 cluster」的块按三角形 cluster 拆开。
 *
 * 调用时机：`visibility.collect()` 之后（每块已有 `clusterIds`）、`root.updateMatrixWorld(true)`
 * 之后。调用方在拆分后需要重新 `visibility.collect()` 与 `collectTransparentChunks()`。
 */
export function splitChunksByCluster(
  root: THREE.Object3D,
  visibility: VisibilityController,
  pvs: PvsManager | null,
  options: ClusterSplitOptions = {},
): ClusterSplitStats {
  const minTris = options.minTris ?? DEFAULT_MIN_TRIS;
  const minClusters = options.minClusters ?? DEFAULT_MIN_CLUSTERS;
  const maxPieces = options.maxPieces ?? DEFAULT_MAX_PIECES;
  const maxNewPieceRatio = options.maxNewPieceRatio ?? DEFAULT_MAX_NEW_RATIO;
  const stats: ClusterSplitStats = { candidates: 0, split: 0, pieces: 0, unmapped: 0, skipped: 0, sampleMs: 0 };
  if (!pvs || !pvs.enabled) return stats;

  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const out = new THREE.Vector3();
  type Plan = {
    item: (typeof visibility.items)[number];
    buckets: Map<number, number[]>;
    extra: Map<number, number[]>;
    tris: number;
  };
  const plans: Plan[] = [];

  for (const item of visibility.items) {
    // 只拆「跨房间」的块：单 cluster 的块不可能把别的房间带进来，拆它纯属白涨 draw。
    // 少 cluster（2~3）的块同理，泄漏面积小，优先保帧率。
    if (item.clusterIds.length < minClusters) continue;
    if (isWaterMesh(item.mesh)) { stats.skipped++; continue; }
    const geom = item.mesh.geometry as THREE.BufferGeometry | undefined;
    const pos = geom?.attributes.position as THREE.BufferAttribute | undefined;
    if (!geom || !pos) continue;
    const index = geom.index;
    const tris = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
    if (tris < minTris) { stats.skipped++; continue; }
    stats.candidates++;

    const matrix = item.mesh.matrixWorld;
    // _vbsp_face 是逐顶点 BSP face 号：用它可以精确把三角形归到 face→cluster，不靠几何采样。
    const faceAttr = (geom.getAttribute('_vbsp_face') as THREE.BufferAttribute | undefined) ?? null;
    const buckets = new Map<number, number[]>();
    let mapped = 0;
    for (let t = 0; t < tris; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      const cl = triangleCluster(pvs, pos, faceAttr, i0, i1, i2, matrix, out);
      const key = cl < 0 ? -1 : cl;
      if (cl >= 0) mapped++;
      let arr = buckets.get(key);
      if (!arr) buckets.set(key, (arr = []));
      arr.push(t, i0, i1, i2);
    }
    if (mapped === 0) { stats.unmapped++; continue; }

    // 归属不明的三角形（埋在固体里，本来就看不见）并进最大片，不会露到别的房间。
    const solid = buckets.get(-1);
    if (solid) {
      buckets.delete(-1);
      if (buckets.size === 0) { stats.unmapped++; continue; }
      let bestKey = -1;
      let bestLen = -1;
      for (const [k, v] of buckets) if (v.length > bestLen) { bestLen = v.length; bestKey = k; }
      const arr = buckets.get(bestKey)!;
      for (let i = 0; i < solid.length; i++) arr.push(solid[i]);
    }
    if (buckets.size < 2) continue;

    // 片数上限：把最小片并进最大片，并**记录并集**（否则并进来的那部分会随主片被误剔 = 开洞）。
    const extra = new Map<number, number[]>();
    if (buckets.size > maxPieces) {
      const order = [...buckets.entries()].sort((a, b) => a[1].length - b[1].length);
      const keep = new Set(order.slice(order.length - maxPieces).map(([k]) => k));
      const biggest = order[order.length - 1][0];
      for (const [k, v] of order) {
        if (keep.has(k)) continue;
        const arr = buckets.get(biggest)!;
        for (let i = 0; i < v.length; i++) arr.push(v[i]);
        buckets.delete(k);
        let list = extra.get(biggest);
        if (!list) extra.set(biggest, (list = []));
        list.push(k);
      }
    }
    plans.push({ item, buckets, extra, tris });
  }

  // 全局预算：按三角形数从大到小分配（泄漏量 ∝ 三角形数），超出预算的块保持原样。
  const budget = Math.max(1, Math.floor(visibility.items.length * maxNewPieceRatio));
  plans.sort((a, b) => b.tris - a.tris);
  let spent = 0;
  const accepted: Plan[] = [];
  for (const p of plans) {
    const cost = p.buckets.size - 1;
    if (spent + cost > budget) { stats.skipped++; continue; }
    spent += cost;
    accepted.push(p);
  }

  for (const { item, buckets, extra } of accepted) {
    const src = item.mesh;
    const geom = src.geometry as THREE.BufferGeometry;
    const parent = src.parent;
    if (!parent) continue;
    const materials = Array.isArray(src.material) ? src.material : null;
    const srcGroups = geom.groups.length > 0 ? geom.groups.slice() : null;
    const posCount = (geom.attributes.position as THREE.BufferAttribute).count;
    const IndexArray = posCount < 65536 ? Uint16Array : Uint32Array;
    const srcIndex = geom.index;
    const newMeshes: THREE.Mesh[] = [];

    for (const [cluster, flat] of buckets) {
      const triCount = flat.length / 4;
      const indexArray = new IndexArray(triCount * 3);
      for (let t = 0; t < triCount; t++) {
        indexArray[t * 3] = flat[t * 4 + 1];
        indexArray[t * 3 + 1] = flat[t * 4 + 2];
        indexArray[t * 3 + 2] = flat[t * 4 + 3];
      }
      const sub = new THREE.BufferGeometry();
      // 共享属性缓冲：同一个 BufferAttribute 实例，GPU buffer 不会复制。
      for (const name of Object.keys(geom.attributes)) sub.setAttribute(name, geom.getAttribute(name));
      sub.setIndex(new THREE.BufferAttribute(indexArray, 1));

      // 多材质块：按「本片三角形所属的原始材质组」重建 groups（片内按组排序成连续段）。
      // 注意 group.start/count 的单位：索引几何是 index 单元，非索引几何是**顶点**编号。
      if (materials && srcGroups) {
        const unitOf = (tri: number): number => (srcIndex ? srcIndex.getX(tri * 3) : tri * 3);
        const byMat = new Map<number, number[]>();
        for (let t = 0; t < triCount; t++) {
          const vtx = unitOf(flat[t * 4]);
          let matIndex = 0;
          for (const g of srcGroups) {
            if (vtx >= g.start && vtx < g.start + g.count) { matIndex = g.materialIndex ?? 0; break; }
          }
          let arr = byMat.get(matIndex);
          if (!arr) byMat.set(matIndex, (arr = []));
          arr.push(t);
        }
        const sortedMats = [...byMat.keys()].sort((a, b) => a - b);
        const remap = new IndexArray(triCount * 3);
        let cursor = 0;
        for (const matIndex of sortedMats) {
          const list = byMat.get(matIndex)!;
          const start = cursor;
          for (const t of list) {
            remap[cursor * 3] = indexArray[t * 3];
            remap[cursor * 3 + 1] = indexArray[t * 3 + 1];
            remap[cursor * 3 + 2] = indexArray[t * 3 + 2];
            cursor++;
          }
          sub.addGroup(start * 3, (cursor - start) * 3, matIndex);
        }
        (sub.getIndex() as THREE.BufferAttribute).array.set(remap);
      }
      computeSubsetBounds(sub, indexArray, src.matrixWorld);

      const mesh = new THREE.Mesh(sub, src.material);
      mesh.name = `${src.name || '(anon)'}#c${cluster}`;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.identity();
      mesh.matrixWorld.identity();
      mesh.renderOrder = src.renderOrder;
      mesh.frustumCulled = src.frustumCulled;
      mesh.castShadow = src.castShadow;
      mesh.receiveShadow = src.receiveShadow;
      mesh.layers.mask = src.layers.mask;
      // 父块上挂的缓存（面排序缓存/近平面盒/PVS 预处理标记）都按父块的 index 长度记，必须清掉。
      const parentData = src.userData as Record<string, unknown>;
      const kept: Record<string, unknown> = {};
      for (const key of ['vbspMerge', 'isBspModel', 'chunkIndex']) {
        if (key in parentData) kept[key] = parentData[key];
      }
      mesh.userData = {
        ...kept,
        splitCluster: cluster,
        // 超限被并进来的 cluster 也记上：其中任一个可见就画这片，否则并进来的部分会被误剔。
        splitClusters: [cluster, ...(extra.get(cluster) ?? [])],
        splitFrom: src.name || '',
      };
      newMeshes.push(mesh);
    }
    if (newMeshes.length < 2) continue;

    for (const m of newMeshes) {
      m.visible = src.visible;
      parent.add(m);
    }
    parent.remove(src);
    // **不要 dispose 源几何**：属性与所有子片共享同一个 GPU buffer，dispose 会把它删掉，
    // 下一帧整批顶点重传。只丢掉一个 index 引用，代价可忽略。
    stats.split++;
    stats.pieces += newMeshes.length;
  }

  // 没被拆的块也打上标记：第二次 collect 时 `assignClusters` 直接沿用已有 cluster 集合，
  // 省掉对 1.5M 顶点的全量重采样（那一步约 170ms）。
  for (const item of visibility.items) {
    if (item.clusterIds.length > 0 && item.mesh.userData?.splitClusters === undefined) {
      item.mesh.userData.splitClusters = item.clusterIds.slice();
    }
  }

  stats.sampleMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  if (stats.split > 0) root.updateMatrixWorld(true);
  console.info(
    `[pvs] 按 cluster 拆分：候选 ${stats.candidates} 块 → 拆开 ${stats.split} 块 / ${stats.pieces} 片` +
      `（跳过 ${stats.skipped}、无主 ${stats.unmapped}、上限 ${maxPieces} 片/块、预算 ${budget} 片、${stats.sampleMs.toFixed(0)}ms）`,
  );
  return stats;
}
