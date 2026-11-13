/**
 * 逐三角形 PVS 过滤（不拆 mesh）。
 *
 * 背景：PVS 的可见单位是 cluster（≈ 房间），而渲染单位是合并块。合并块横跨几十个房间时，
 * 「块内任一 cluster 可见就整块画」会把别的房间/别的关卡区域带进画面 —— 用户看到的
 * 「窗外悬空结构」就是这个。拆 mesh 能做到精确，但 2000+ mesh 的每帧开销会把帧率打死。
 *
 * 做法：对跨房间的块，装载期把每个三角形归属的 cluster 记下来；相机所在 cluster 变化时
 * （PVS 与视角无关，只在换房间时变），按当前可见集重建该块的 index，只留可见三角形。
 * 一个 mesh 一个 draw，三角形级精度。
 *
 * 两个必须守住的边界（都踩过）：
 * - 合并块是「一个 mesh + 材质数组 + groups 区间」。重排 index 却不重建 groups，group 的
 *   start/count 仍指向旧区间 ⇒ 三角形按错误的 materialIndex 画 = 材质乱飞/自己切换。
 *   所以输出必须按 group 顺序成组产出，并 `clearGroups()` 后按新的区间重建。
 * - 半透明块（玻璃/冰面/水面）由 `sortTransparentFaces` 每帧重写自己的 index 做逐面排序，
 *   和这里的重建互相覆盖 ⇒ 直接跳过，让它们走原来的块级判定。
 */
import * as THREE from 'three';

/** 装载期求几何法线的临时向量（`normalSideCluster` 无 `normal` 属性时用）。 */
const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();

/** 只用到这两个查询，避免把 PvsManager 的实现类型拖进来。 */
export interface PvsFilterQuery {
  getFaceCluster(face: number): number;
  isVisible(clusterId: number): boolean;
  /** 没有 `_vbsp_face` 的块退回「三角形重心 + 法线偏移」采样。 */
  getClusterAt?(pos: { x: number; y: number; z: number }): number;
}

/**
 * 每块记：三角形 → cluster（两个来源）、原始 index 备份、输出 index、分组归属。
 *
 * 为什么要两个来源：`faceClusters[]` 是 BSP 导出时「按 leaf 顺序填第一个引用该面的非固体
 * leaf」——它只是**引用**了这张面，不代表面朝着那个房间。一块地板常常先被楼下/隔壁的 leaf
 * 引用，于是拿到别的房间的 cluster：站在地板上、人贴着脸，PVS 照样把它判成不可见 ⇒ 地面开洞、
 * 直接看穿到下层区域。用户看到的「人都贴跟前了还看不到」就是这个。
 *
 * 所以再沿**面法线**取一次「面朝向的那个房间」：`triClustersN`。两个来源任一可见就画；
 * 只有两个都定不到位（都在墙外/虚空）才剔——这才是「悬空尖刺」该被剔的情形。
 */
interface ClusterIndexState {
  triClusters: Uint16Array;
  /** 沿面法线采样得到的 cluster（面真正朝向的房间），0xffff = 采不到。 */
  triClustersN: Uint16Array;
  origIndex: Uint32Array;
  outIndex: Uint32Array;
  attr: THREE.BufferAttribute;
  /** group 划分：每组的 materialIndex 与它包含的三角形编号（保持原顺序）。 */
  groups: { materialIndex: number; tris: Uint32Array }[];
  /** 上次重建时的相机 cluster（-1 = 还没建过）。 */
  lastCluster: number;
  /** 上次重建后可见三角形数。 */
  visTris: number;
}

export interface ClusterIndexStats {
  prepared: number;
  skipped: number;
  /** 跳过原因分项（诊断：为什么没进过滤）。 */
  reasons: Record<string, number>;
  tris: number;
  preparedMs: number;
}

/**
 * 沿面法线取「这张面朝向的那个房间」的 cluster。
 *
 * 先用重心、再沿 +法线 8/32 HU（面朝向的一侧是房间，背面是实体），最后退一步试 -法线
 * （双面材质/倒角朝外的情况）。全部落空返回 -1（= 在墙外/虚空，不参与 PVS）。
 */
function normalSideCluster(
  index: THREE.BufferAttribute | null,
  pos: THREE.BufferAttribute,
  nrm: THREE.BufferAttribute | null,
  mw: THREE.Matrix4,
  t: number,
  get: (p: { x: number; y: number; z: number }) => number,
  v: THREE.Vector3,
  n: THREE.Vector3,
): number {
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < 3; k++) {
    const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
    v.fromBufferAttribute(pos, vi).applyMatrix4(mw);
    cx += v.x; cy += v.y; cz += v.z;
  }
  cx /= 3; cy /= 3; cz /= 3;
  n.set(0, 1, 0);
  if (nrm) {
    const vi = index ? index.getX(t * 3) : t * 3;
    n.fromBufferAttribute(nrm, vi);
    if (n.lengthSq() < 1e-6) n.set(0, 1, 0); else n.normalize();
  } else {
    // 合并后的世界块大多没有 `normal`（它们是无光照的 BasicMaterial）。不能默认朝上：
    // 竖直墙面沿 +Y 偏 8/32 HU 会落进实体或天花，normalSide 永远采不到房间，三角形就只能
    // 靠 `faceClusters`（可能记的是楼下/隔壁那间）判定 ⇒ 贴在眼前仍被剔除。
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    scratchA.fromBufferAttribute(pos, ia).applyMatrix4(mw);
    scratchB.fromBufferAttribute(pos, ib).applyMatrix4(mw);
    v.fromBufferAttribute(pos, ic).applyMatrix4(mw);
    n.crossVectors(scratchB.sub(scratchA), v.sub(scratchA));
    if (n.lengthSq() < 1e-12) n.set(0, 1, 0); else n.normalize();
  }
  for (const off of [8, 32, 0, -8, -32]) {
    v.set(cx + n.x * off, cy + n.y * off, cz + n.z * off);
    const r = get(v);
    if (r >= 0) return r;
  }
  return -1;
}

/** `_vbsp_face` 顶点属性 → face 号 → cluster。没有该属性时放弃（不猜）。 */
function faceAttrOf(geom: THREE.BufferGeometry): THREE.BufferAttribute | null {
  const a = geom.getAttribute('_vbsp_face');
  return a instanceof THREE.BufferAttribute ? a : null;
}

/** 半透明/水面块由逐面排序接管 index，不能被这里改写。 */
function isSortedPerFace(mesh: THREE.Mesh): boolean {
  const mat = mesh.material;
  const list = Array.isArray(mat) ? mat : [mat];
  return list.some((m) => (m as THREE.Material | undefined)?.transparent === true);
}

/**
 * 装载期：给跨 cluster 的块建立逐三角形 cluster 表。
 * 只处理「索引几何 + `clusterIds.length >= 2` + 有 `_vbsp_face` + 三角形数 >= minTris + 不透明」的块。
 */
export function prepareClusterIndex(
  items: readonly { mesh: THREE.Mesh; clusterIds: number[] }[],
  pvs: PvsFilterQuery,
  minTris = 64,
): ClusterIndexStats {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const stats: ClusterIndexStats = { prepared: 0, skipped: 0, tris: 0, preparedMs: 0, reasons: {} };
  const why = (k: string): void => {
    stats.skipped++;
    stats.reasons[k] = (stats.reasons[k] ?? 0) + 1;
  };
  for (const item of items) {
    const mesh = item.mesh;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom) { why('geom'); continue; }
    if ((mesh.userData as { clusterIndex?: ClusterIndexState }).clusterIndex) continue;
    const index = geom.index;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) { why('pos'); continue; }
    if (isSortedPerFace(mesh)) { why('transparent'); continue; }
    // 合并块大多是**非索引**几何（mergeGeometries 对无索引输入直接返回无索引结果）——
    // 这里统一按三角形序号处理：非索引时顶点顺序就是三角形顺序，`t*3` 即首顶点。
    const tris = Math.floor((index ? index.count : pos.count) / 3);
    if (tris < minTris) { why('small'); continue; }
    const faces = faceAttrOf(geom);
    // 单 cluster 的块没有泄漏面，不需要过滤（省下重建开销）。
    if (item.clusterIds.length < 2) { why('onecluster'); continue; }

    const triClusters = new Uint16Array(tris);
    const triClustersN = new Uint16Array(tris);
    triClustersN.fill(0xffff);
    const origIndex = new Uint32Array(tris * 3);
    const nrm = geom.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const mw = mesh.matrixWorld;
    const get = pvs.getClusterAt ? pvs.getClusterAt.bind(pvs) : null;
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    let unmapped = 0;
    if (faces) {
      for (let t = 0; t < tris; t++) {
        const vi = index ? index.getX(t * 3) : t * 3;
        const face = faces.getX(vi);
        const c = pvs.getFaceCluster(face);
        triClusters[t] = c < 0 ? 0xffff : c;
        for (let k = 0; k < 3; k++) origIndex[t * 3 + k] = index ? index.getX(t * 3 + k) : t * 3 + k;
        // 第二个来源：面朝向的那个房间（`faceClusters` 只是「引用过这张面的第一个 leaf」）。
        const cn = get ? normalSideCluster(index, pos, nrm ?? null, mw, t, get, v, n) : -1;
        if (cn >= 0) triClustersN[t] = cn;
        if (c < 0 && cn < 0) unmapped++;
      }
    } else if (get) {
      // 没有 face 属性（合并时没带过来的那批块）：退回几何采样。
      // 沿**面法线**双向偏移取样，才能跨过共面墙进到房间中心；只取重心会大面积落进实体。
      for (let t = 0; t < tris; t++) {
        let cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < 3; k++) {
          const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
          origIndex[t * 3 + k] = vi;
          v.fromBufferAttribute(pos, vi).applyMatrix4(mw);
          cx += v.x; cy += v.y; cz += v.z;
        }
        cx /= 3; cy /= 3; cz /= 3;
        let c = -1;
        n.set(0, 1, 0);
        if (nrm) {
          const vi = index ? index.getX(t * 3) : t * 3;
          n.fromBufferAttribute(nrm, vi);
          if (n.lengthSq() < 1e-6) n.set(0, 1, 0); else n.normalize();
        }
        // 先在重心试，再沿 ±法线 8/32/96 HU 试：墙内侧是实体，外侧才是房间。
        for (const off of [0, 8, -8, 32, -32, 96, -96]) {
          v.set(cx + n.x * off, cy + n.y * off, cz + n.z * off);
          const r = get(v);
          if (r >= 0) { c = r; break; }
        }
        if (c < 0) unmapped++;
        triClusters[t] = c < 0 ? 0xffff : c;
        triClustersN[t] = triClusters[t];
      }
    } else {
      why('noface');
      continue;
    }
    // 一半以上三角形定不到位 ⇒ 这张脸的映射不可信，宁可整块按老办法（块级）处理。
    if (unmapped > tris * 0.5) { stats.skipped++; continue; }

    // 按 geometry.groups 切成「materialIndex + 三角形列表」。没有 groups 就是单一材质。
    const rawGroups = geom.groups.length > 0 ? geom.groups : [{ start: 0, count: index ? index.count : pos.count, materialIndex: 0 }];
    const groups: { materialIndex: number; tris: Uint32Array }[] = [];
    for (const g of rawGroups) {
      // group 的 start/count 是 index 单元；换算成三角形序号并夹到合法范围。
      const from = Math.max(0, Math.floor(g.start / 3));
      const to = Math.min(tris, Math.floor((g.start + g.count) / 3));
      if (to <= from) continue;
      const list = new Uint32Array(to - from);
      for (let t = from; t < to; t++) list[t - from] = t;
      groups.push({ materialIndex: g.materialIndex ?? 0, tris: list });
    }
    if (groups.length === 0) { why('nogroup'); continue; }

    const outIndex = new Uint32Array(tris * 3);
    outIndex.set(origIndex);
    const attr = new THREE.BufferAttribute(outIndex, 1);
    attr.setUsage(THREE.DynamicDrawUsage);
    geom.setIndex(attr);
    (mesh.userData as { clusterIndex?: ClusterIndexState }).clusterIndex = {
      triClusters, triClustersN, origIndex, outIndex, attr, groups, lastCluster: -1, visTris: tris,
    };
    stats.prepared++;
    stats.tris += tris;
  }
  stats.preparedMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  return stats;
}

/**
 * 运行期：相机 cluster 变了才重建 index。全部块的可见集来自同一行 PVS，
 * 所以只在「相机 cluster 变化」时重建一次（PVS 与视角无关，这是关键前提）。
 * 输出按 group 顺序成组写入，并重建 groups 区间，保证 materialIndex 与原语义一致。
 */
export function applyClusterIndex(
  items: readonly { mesh: THREE.Mesh }[],
  pvs: PvsFilterQuery,
  camCluster: number,
): number {
  let rebuilt = 0;
  for (const item of items) {
    const st = (item.mesh.userData as { clusterIndex?: ClusterIndexState }).clusterIndex;
    if (!st) continue;
    if (st.lastCluster === camCluster) continue;
    const { triClusters, triClustersN, origIndex, outIndex, attr, groups } = st;
    const geom = item.mesh.geometry;
    let n = 0;
    geom.clearGroups();
    for (const g of groups) {
      const start = n;
      for (let i = 0; i < g.tris.length; i++) {
        const t = g.tris[i];
        // 两个来源任一可见就画：face 引用映射可能是「楼下/隔壁的房间」，法线采样才是面朝向的房间。
        const ca = triClusters[t];
        const cn = triClustersN[t];
        const on = (ca !== 0xffff && pvs.isVisible(ca)) || (cn !== 0xffff && pvs.isVisible(cn));
        // 两个来源都定不到位（墙外/虚空/地图外壳的重复道具）才剔——「悬空尖刺」正是这一类。
        if (on) {
          const s = t * 3;
          outIndex[n++] = origIndex[s];
          outIndex[n++] = origIndex[s + 1];
          outIndex[n++] = origIndex[s + 2];
        }
      }
      if (n > start) geom.addGroup(start, n - start, g.materialIndex);
    }
    st.visTris = n / 3;
    st.lastCluster = camCluster;
    attr.needsUpdate = true;
    geom.setDrawRange(0, n);
    // 距离场优先：`visibility-controller` 已把场外块标成 LOD_FAR，这里不能把它重新点亮。
    item.mesh.visible = st.visTris > 0 && item.mesh.userData.lodLevel === 0;
    rebuilt++;
  }
  return rebuilt;
}

/** 相机 cluster 变化后需要重建的块数（诊断用）。 */
export function clusterIndexStates(items: readonly { mesh: THREE.Mesh }[]): number {
  let n = 0;
  for (const item of items) if ((item.mesh.userData as { clusterIndex?: unknown }).clusterIndex) n++;
  return n;
}
