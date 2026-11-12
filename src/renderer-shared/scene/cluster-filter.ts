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
 */
import * as THREE from 'three';

/** 只用到这两个查询，避免把 PvsManager 的实现类型拖进来。 */
export interface PvsFilterQuery {
  getFaceCluster(face: number): number;
  isVisible(clusterId: number): boolean;
}

/** 每块记：三角形 → cluster、原始 index 备份、输出 index。 */
interface ClusterIndexState {
  triClusters: Uint16Array;
  origIndex: Uint32Array;
  outIndex: Uint32Array;
  attr: THREE.BufferAttribute;
  /** 上次重建时的相机 cluster（-1 = 还没建过）。 */
  lastCluster: number;
  /** 上次重建后可见三角形数。 */
  visTris: number;
}

export interface ClusterIndexStats {
  prepared: number;
  skipped: number;
  tris: number;
  preparedMs: number;
}

/** `_vbsp_face` 顶点属性 → face 号 → cluster。没有该属性时放弃（不猜）。 */
function faceAttrOf(geom: THREE.BufferGeometry): THREE.BufferAttribute | null {
  const a = geom.getAttribute('_vbsp_face');
  return a instanceof THREE.BufferAttribute ? a : null;
}

/**
 * 装载期：给跨 cluster 的块建立逐三角形 cluster 表。
 * 只处理 `clusterIds.length >= 2`、有 `_vbsp_face`、三角形数 >= minTris 的块。
 */
export function prepareClusterIndex(
  items: readonly { mesh: THREE.Mesh; clusterIds: number[] }[],
  pvs: PvsFilterQuery,
  minTris = 64,
): ClusterIndexStats {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const stats: ClusterIndexStats = { prepared: 0, skipped: 0, tris: 0, preparedMs: 0 };
  for (const item of items) {
    const mesh = item.mesh;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom) { stats.skipped++; continue; }
    if ((mesh.userData as { clusterIndex?: ClusterIndexState }).clusterIndex) continue;
    const index = geom.index;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) { stats.skipped++; continue; }
    const tris = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
    if (tris < minTris) { stats.skipped++; continue; }
    const faces = faceAttrOf(geom);
    if (!faces) { stats.skipped++; continue; }
    // 单 cluster 的块没有泄漏面，不需要过滤（省下重建开销）。
    if (item.clusterIds.length < 2) { stats.skipped++; continue; }

    const triClusters = new Uint16Array(tris);
    const origIndex = new Uint32Array(tris * 3);
    let unmapped = 0;
    for (let t = 0; t < tris; t++) {
      const vi = index ? index.getX(t * 3) : t * 3;
      const face = faces.getX(vi);
      const c = pvs.getFaceCluster(face);
      if (c < 0) unmapped++;
      triClusters[t] = c < 0 ? 0xffff : c;
      for (let k = 0; k < 3; k++) origIndex[t * 3 + k] = index ? index.getX(t * 3 + k) : t * 3 + k;
    }
    // 一半以上三角形定不到位 ⇒ 这张脸的映射不可信，宁可整块按老办法（块级）处理。
    if (unmapped > tris * 0.5) { stats.skipped++; continue; }

    const outIndex = new Uint32Array(tris * 3);
    outIndex.set(origIndex);
    const attr = new THREE.BufferAttribute(outIndex, 1);
    attr.setUsage(THREE.DynamicDrawUsage);
    geom.setIndex(attr);
    (mesh.userData as { clusterIndex?: ClusterIndexState }).clusterIndex = {
      triClusters, origIndex, outIndex, attr, lastCluster: -1, visTris: tris,
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
    const { triClusters, origIndex, outIndex, attr } = st;
    const tris = triClusters.length;
    let n = 0;
    for (let t = 0; t < tris; t++) {
      const c = triClusters[t];
      if (c === 0xffff || pvs.isVisible(c)) {
        const s = t * 3;
        outIndex[n++] = origIndex[s];
        outIndex[n++] = origIndex[s + 1];
        outIndex[n++] = origIndex[s + 2];
      }
    }
    st.visTris = n / 3;
    st.lastCluster = camCluster;
    attr.needsUpdate = true;
    item.mesh.geometry.setDrawRange(0, n);
    item.mesh.visible = st.visTris > 0;
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
