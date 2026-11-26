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
import { MERGE_SOURCE_TABLE_KEY, type MergeSourceTable } from './scene-optimizer.js';

/** 装载期求几何法线的临时向量（`normalSideCluster` 无 `normal` 属性时用）。 */
const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();

/** 只用到这两个查询，避免把 PvsManager 的实现类型拖进来。 */
export interface PvsFilterQuery {
  getFaceCluster(face: number): number;
  isVisible(clusterId: number): boolean;
  /** 没有 `_vbsp_face` 的块退回「三角形重心 + 法线偏移」采样。 */
  getClusterAt?(pos: { x: number; y: number; z: number }): number;
  /**
   * 当前可见集的稠密位图（下标 = cluster，1 = 可见；`PvsManager.visibleRow()`）。
   *
   * 重建一次要判 120 万三角形 × 3 个来源，逐次 `isVisible()`（Set.has + 虚调用）实测
   * 单次 15–25 ms；摊平成 `Uint8Array` 后按下标读，配合下面的「块可见签名」跳过可省到 1/3 以下。
   */
  visibleRow?(): Uint8Array | null;
}

/**
 * 每块记：三角形 → cluster（两个来源）、原始 index 备份、输出 index、分组归属。
 *
 * 为什么要两个来源：`faceClusters[]` 是 BSP 导出时「按 leaf 顺序填第一个引用该面的非固体
 * leaf」——它只是**引用**了这张面，不代表面朝着那个房间。一块地板常常先被楼下/隔壁的 leaf
 * 引用，于是拿到别的房间的 cluster：站在地板上、人贴着脸，PVS 照样把它判成不可见 ⇒ 地面开洞、
 * 直接看穿到下层区域。用户看到的「人都贴跟前了还看不到」就是这个。
 *
 * 所以再沿**面法线**取一次「面朝向的那个房间」：`triClustersN`；以及沿**反法线**取一次
 * 背面房间：`triClustersN2`（厚墙/大面板两侧各属一间，只记一侧会在另一侧看穿）。
 * 三个来源任一可见就画；全都定不到位（都在墙外/虚空）才剔——这才是「悬空尖刺」该被剔的情形。
 */
interface ClusterIndexState {
  triClusters: Uint16Array;
  /** 沿面法线采样得到的 cluster（面真正朝向的房间），0xffff = 采不到。 */
  triClustersN: Uint16Array;
  /** 沿**反**法线采样得到的 cluster（面的背面房间），0xffff = 采不到。 */
  triClustersN2: Uint16Array;
  origIndex: Uint32Array;
  outIndex: Uint32Array;
  attr: THREE.BufferAttribute;
  /** group 划分：每组的 materialIndex 与它包含的三角形编号（保持原顺序）。 */
  groups: { materialIndex: number; tris: Uint32Array }[];
  /** 上次重建时的相机 cluster（-1 = 还没建过）。 */
  lastCluster: number;
  /** 上次重建后可见三角形数。 */
  visTris: number;
  /**
   * 该块用到的 cluster 去重表（装载期生成）。运行期用「可见签名」判断要不要重建：
   * 签名只由这些 cluster 的可见位决定，签名不变 ⇒ 选中的三角形不变 ⇒ 跳过重建。
   */
  clusters: Uint16Array;
  /** 上次重建时的可见签名（FNV-1a）；0 = 还没算过。 */
  sig: number;
  /**
   * 单 group（整块单材质槽）块的增量重建状态。全量重排 123 万三角实测 15–25ms，而换房间时
   * 一行 PVS 通常只翻几十个 cluster 的可见位；增量路径只处理「翻位 cluster → 三角形」的
   * 那一小撮，可见→隐藏用 swap-remove（O(1)/三角形），隐藏→可见 append。
   * 多 group 块仍走全量路径（group 顺序语义复杂，收益也小）。
   */
  incremental?: IncrementalState;
  /** 上次更新时对应的全局可见行版本（`rowVersion`）；-1 表示还没按行更新过。 */
  rowVersion: number;
}

/** 单 group 块的增量重建状态：cluster → 三角形倒排 + 输出缓冲里的位置索引。 */
interface IncrementalState {
  /** outIndex 里每个位置放的三角形序号。 */
  posOfTri: Int32Array;
  /** 每个 outIndex 槽位放的三角形序号（与 visTris 前缀配合）。 */
  slotTri: Int32Array;
  /** 该块用到的 cluster，升序（只用来二分「本帧翻位」的那几个 cluster）。 */
  clusterKeys: Uint16Array;
  /** CSR 倒排：clusterKeys[i] 的三角形在 triIds[offsets[i]..offsets[i+1])。 */
  offsets: Uint32Array;
  triIds: Uint32Array;
  /** 每帧按 epoch 去重（同一三角形可能被多个 cluster 命中）。 */
  marks: Uint32Array;
  /** 该块的单 group materialIndex（重建 groups 时用）。 */
  materialIndex: number;
}

export interface ClusterIndexStats {
  prepared: number;
  skipped: number;
  /** 跳过原因分项（诊断：为什么没进过滤）。 */
  reasons: Record<string, number>;
  tris: number;
  preparedMs: number;
}

// ── 可见行差分缓存（每个 renderer 进程一份）─────────────────────────────────────────────
// PVS 可见行只在相机换 cluster 时变。这里保存上一帧的可见行快照，把「本帧翻位的 cluster」
// 摊成一个小数组；增量块只处理这些 cluster 对应的三角形，而不是全块重排。
let lastRow: Uint8Array | null = null;
/** 行版本号：每次可见行变化 +1（增量块按「上次更新时的版本」判断差分是否连续）。 */
let rowVersion = 0;
/** 自上次快照以来翻位的 cluster（升序不保证；增量块内部按需二分）。 */
const pendingChanged: number[] = [];
/** true = 快照刚建立 / 长度变化，必须全量重建。 */
let pendingFull = true;
/** 增量翻位去重用的 epoch（每帧 +1，避免每帧清 marks 数组）。 */
let flipEpoch = 0;
/** 装载期建倒排用的 cluster→局部下标临时表（65536 项，建完复位，避免每块 256KB 常驻）。 */
const probeIndex = new Int32Array(0x10000).fill(-1);

/** 更新可见行快照并计算差分。必须在 applyClusterIndex 的每帧开头调用一次。 */
function refreshRowDiff(row: Uint8Array | null): void {
  if (!row) {
    if (lastRow) lastRow = null;
    pendingChanged.length = 0;
    pendingFull = true;
    return;
  }
  if (!lastRow || lastRow.length !== row.length) {
    lastRow = new Uint8Array(row.length);
    lastRow.set(row);
    pendingChanged.length = 0;
    pendingFull = true;
    rowVersion++;
    return;
  }
  const list = pendingChanged;
  list.length = 0;
  let changed = false;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    if (lastRow[i] !== v) {
      lastRow[i] = v;
      list.push(i);
      changed = true;
    }
  }
  pendingFull = false;
  if (changed) rowVersion++;
}

/** 升序 Uint16 表里二分查找（找不到返回 -1）。 */
function locateCluster(keys: Uint16Array, id: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = keys[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** 单个三角形在当前可见行下是否要画（三来源任一可见；已做子模型继承，仍为 0xffff 说明纯虚空，直接剔除）。 */
function triVisible(
  st: ClusterIndexState,
  t: number,
  row: Uint8Array | null,
  pvs: PvsFilterQuery,
): boolean {
  const ca = st.triClusters[t];
  const cn = st.triClustersN[t];
  const cn2 = st.triClustersN2[t];
  if (row) {
    return (
      (ca !== 0xffff && ca < row.length && row[ca] === 1) ||
      (cn !== 0xffff && cn < row.length && row[cn] === 1) ||
      (cn2 !== 0xffff && cn2 < row.length && row[cn2] === 1)
    );
  }
  return (
    (ca !== 0xffff && pvs.isVisible(ca)) ||
    (cn !== 0xffff && pvs.isVisible(cn)) ||
    (cn2 !== 0xffff && pvs.isVisible(cn2))
  );
}

/** 装载期：给单 group 块建「cluster → 三角形」倒排（扫描计数 + 前缀和填充）。 */
function buildIncremental(
  tris: number,
  triClusters: Uint16Array,
  triClustersN: Uint16Array,
  triClustersN2: Uint16Array,
  clusters: Uint16Array,
  materialIndex: number,
): IncrementalState {
  const clusterKeys = Uint16Array.from(clusters);
  clusterKeys.sort();
  const k = clusterKeys.length;
  for (let i = 0; i < k; i++) probeIndex[clusterKeys[i]] = i;
  const counts = new Uint32Array(k);
  const addCount = (id: number): void => {
    if (id === 0xffff) return;
    const idx = probeIndex[id];
    if (idx >= 0) counts[idx]++;
  };
  for (let t = 0; t < tris; t++) {
    addCount(triClusters[t]);
    addCount(triClustersN[t]);
    addCount(triClustersN2[t]);
  }
  const offsets = new Uint32Array(k + 1);
  for (let i = 0; i < k; i++) offsets[i + 1] = offsets[i] + counts[i];
  const triIds = new Uint32Array(offsets[k]);
  const cursor = offsets.slice(0, k);
  const addTri = (id: number, t: number): void => {
    if (id === 0xffff) return;
    const idx = probeIndex[id];
    if (idx >= 0) triIds[cursor[idx]++] = t;
  };
  for (let t = 0; t < tris; t++) {
    addTri(triClusters[t], t);
    addTri(triClustersN[t], t);
    addTri(triClustersN2[t], t);
  }
  for (let i = 0; i < k; i++) probeIndex[clusterKeys[i]] = -1;
  const posOfTri = new Int32Array(tris);
  const slotTri = new Int32Array(tris);
  for (let t = 0; t < tris; t++) {
    posOfTri[t] = t;
    slotTri[t] = t;
  }
  return { posOfTri, slotTri, clusterKeys, offsets, triIds, marks: new Uint32Array(tris), materialIndex };
}

/** 增量：把三角形插到可见前缀末尾。 */
function insertTri(
  inc: IncrementalState,
  outIndex: Uint32Array,
  origIndex: Uint32Array,
  t: number,
  visTris: number,
): number {
  const pos = visTris;
  const s = t * 3;
  outIndex[pos * 3] = origIndex[s];
  outIndex[pos * 3 + 1] = origIndex[s + 1];
  outIndex[pos * 3 + 2] = origIndex[s + 2];
  inc.posOfTri[t] = pos;
  inc.slotTri[pos] = t;
  return visTris + 1;
}

/** 增量：把三角形从可见前缀里 swap-remove（O(1)，不整体压缩）。 */
function removeTri(
  inc: IncrementalState,
  outIndex: Uint32Array,
  t: number,
  visTris: number,
): number {
  const pos = inc.posOfTri[t];
  const last = visTris - 1;
  if (pos !== last) {
    const lastTri = inc.slotTri[last];
    const from = last * 3;
    const to = pos * 3;
    outIndex[to] = outIndex[from];
    outIndex[to + 1] = outIndex[from + 1];
    outIndex[to + 2] = outIndex[from + 2];
    inc.slotTri[pos] = lastTri;
    inc.posOfTri[lastTri] = pos;
  }
  inc.slotTri[last] = -1;
  inc.posOfTri[t] = -1;
  return last;
}

/** 单 group 块的全量重建（首次 / 行不连续 / 无可见行时用）。 */
function rebuildIncrementalFull(
  st: ClusterIndexState,
  row: Uint8Array | null,
  pvs: PvsFilterQuery,
): void {
  const inc = st.incremental;
  if (!inc) return;
  const tris = st.triClusters.length;
  const { origIndex, outIndex } = st;
  inc.posOfTri.fill(-1);
  inc.slotTri.fill(-1);
  let n = 0;
  for (let t = 0; t < tris; t++) {
    if (!triVisible(st, t, row, pvs)) continue;
    const s = t * 3;
    outIndex[n * 3] = origIndex[s];
    outIndex[n * 3 + 1] = origIndex[s + 1];
    outIndex[n * 3 + 2] = origIndex[s + 2];
    inc.posOfTri[t] = n;
    inc.slotTri[n] = t;
    n++;
  }
  st.visTris = n;
}

interface FlipResult {
  dirty: boolean;
  minPos: number;
  maxPos: number;
  changedDrawRange: boolean;
}

/** 增量：只翻本帧变了的 cluster 名下的三角形，并记录 outIndex 实际被改写的最小/最大槽位。 */
function flipChangedClusters(
  st: ClusterIndexState,
  row: Uint8Array | null,
  pvs: PvsFilterQuery,
  changed: readonly number[],
  epoch: number,
): FlipResult {
  const inc = st.incremental;
  if (!inc) return { dirty: false, minPos: 0, maxPos: -1, changedDrawRange: false };
  const { origIndex, outIndex } = st;
  const prevVisTris = st.visTris;
  let visTris = prevVisTris;
  let dirty = false;
  let minPos = Number.POSITIVE_INFINITY;
  let maxPos = -1;
  for (let ci = 0; ci < changed.length; ci++) {
    const slot = locateCluster(inc.clusterKeys, changed[ci]);
    if (slot < 0) continue;
    const end = inc.offsets[slot + 1];
    for (let k = inc.offsets[slot]; k < end; k++) {
      const t = inc.triIds[k];
      if (inc.marks[t] === epoch) continue;
      inc.marks[t] = epoch;
      const on = triVisible(st, t, row, pvs);
      const pos = inc.posOfTri[t];
      if (on) {
        if (pos < 0) {
          const writePos = visTris;
          visTris = insertTri(inc, outIndex, origIndex, t, visTris);
          dirty = true;
          if (writePos < minPos) minPos = writePos;
          if (writePos > maxPos) maxPos = writePos;
        }
      } else if (pos >= 0) {
        const last = visTris - 1;
        visTris = removeTri(inc, outIndex, t, visTris);
        // 只有删除的不是末尾元素时才会把末尾元素搬到 pos 位置；末尾删除只需缩 drawRange。
        if (pos !== last) {
          dirty = true;
          if (pos < minPos) minPos = pos;
          if (pos > maxPos) maxPos = pos;
        }
      }
    }
  }
  st.visTris = visTris;
  return { dirty, minPos, maxPos, changedDrawRange: visTris !== prevVisTris };
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
  flip = false,
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
    n.fromBufferAttribute(nrm, vi).transformDirection(mw);
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
  // `flip` = 取背面的房间：厚墙/大面板两侧常常各属一个房间，只记一侧会在另一侧看穿。
  if (flip) n.negate();
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
  minTris = 2,
): ClusterIndexStats {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const stats: ClusterIndexStats = { prepared: 0, skipped: 0, tris: 0, preparedMs: 0, reasons: {} };
  const why = (k: string): void => {
    stats.skipped++;
    stats.reasons[k] = (stats.reasons[k] ?? 0) + 1;
  };
  for (const item of items) {
    const mesh = item.mesh;
    if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) { why('instanced'); continue; }
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
    const triClustersN2 = new Uint16Array(tris);
    triClustersN.fill(0xffff);
    triClustersN2.fill(0xffff);
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
        // 背面房间：厚墙/大面板两侧各属一间时，站在背面这一侧不能因为正面房间不可见就被剔。
        const cn2 = get ? normalSideCluster(index, pos, nrm ?? null, mw, t, get, v, n, true) : -1;
        if (cn2 >= 0) triClustersN2[t] = cn2;
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
        n.set(0, 1, 0);
        if (nrm) {
          const vi = index ? index.getX(t * 3) : t * 3;
          n.fromBufferAttribute(nrm, vi).transformDirection(mw);
          if (n.lengthSq() < 1e-6) n.set(0, 1, 0); else n.normalize();
        } else {
          // 合并块没有 normal 属性：用三角形叉积，不能默认朝上（竖直面会全落进天花/实体）。
          const ia = index ? index.getX(t * 3) : t * 3;
          const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
          const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
          scratchA.fromBufferAttribute(pos, ia).applyMatrix4(mw);
          scratchB.fromBufferAttribute(pos, ib).applyMatrix4(mw);
          v.fromBufferAttribute(pos, ic).applyMatrix4(mw);
          n.crossVectors(scratchB.sub(scratchA), v.sub(scratchA));
          if (n.lengthSq() < 1e-12) n.set(0, 1, 0); else n.normalize();
        }
        // 先在重心试，再沿 ±法线 8/32/96 HU 试：墙内侧是实体，外侧才是房间。
        const sample = (x: number, y: number, z: number): number => {
          for (const off of [0, 8, -8, 32, -32, 96, -96]) {
            v.set(x + n.x * off, y + n.y * off, z + n.z * off);
            const rr = get(v);
            if (rr >= 0) return rr;
          }
          return -1;
        };
        const c0 = sample(cx, cy, cz);
        // 只取重心会把这个大面判成「最近的那间房」。再沿 ±法线各取一个远样本，
        // 三个来源任一可见就画（对应有 face 属性的块的三来源判据）。
        const c1 = sample(cx + n.x * 96, cy + n.y * 96, cz + n.z * 96);
        const c2 = sample(cx - n.x * 96, cy - n.y * 96, cz - n.z * 96);
        if (c0 < 0 && c1 < 0 && c2 < 0) unmapped++;
        triClusters[t] = c0 < 0 ? 0xffff : c0;
        triClustersN[t] = c1 < 0 ? 0xffff : c1;
        triClustersN2[t] = c2 < 0 ? 0xffff : c2;
      }
    } else {
      why('noface');
      continue;
    }
    // 子模型继承：同一源子模型内（如伸出地板进虚空的 s2_pillbig 柱底），部分三角形落进 -1 虚空时
    // 继承同子模型内其余有效三角形的 cluster，既不漏到别的关卡，飞到该关卡时也不会缺底面。
    const mergeTable = geom.userData?.[MERGE_SOURCE_TABLE_KEY] as MergeSourceTable | undefined;
    const subRanges =
      mergeTable && mergeTable.ranges.length > 0
        ? mergeTable.ranges.map((r) => [
            Math.max(0, Math.floor(r.start / 3)),
            Math.min(tris, Math.floor((r.start + r.count) / 3)),
          ] as const)
        : ([[0, tris]] as const);
    for (const [from, to] of subRanges) {
      if (to <= from) continue;
      let c0 = 0xffff;
      let c1 = 0xffff;
      let c2 = 0xffff;
      let hasUnknown = false;
      for (let t = from; t < to; t++) {
        const a = triClusters[t];
        const b = triClustersN[t];
        const c = triClustersN2[t];
        if (a === 0xffff && b === 0xffff && c === 0xffff) {
          hasUnknown = true;
          continue;
        }
        for (const vCl of [a, b, c]) {
          if (vCl === 0xffff) continue;
          if (c0 === 0xffff) c0 = vCl;
          else if (c1 === 0xffff && vCl !== c0) c1 = vCl;
          else if (c2 === 0xffff && vCl !== c0 && vCl !== c1) c2 = vCl;
        }
      }
      if (hasUnknown && c0 !== 0xffff) {
        for (let t = from; t < to; t++) {
          if (triClusters[t] === 0xffff && triClustersN[t] === 0xffff && triClustersN2[t] === 0xffff) {
            triClusters[t] = c0;
            triClustersN[t] = c1;
            triClustersN2[t] = c2;
            unmapped--;
          }
        }
      }
    }
    // 一半以上三角形定不到位 ⇒ 这张脸的映射不可信，宁可整块按老办法（块级）处理。
    if (unmapped > tris * 0.5) { stats.skipped++; continue; }

    // 本块用到的 cluster 去重表：运行期「可见签名」只需遍历这张小表（几十个 id），
    // 不用逐三角形重算一遍可见性，就能判断上次写进去的 index 是否仍然正确。
    const uniq = new Set<number>();
    for (let t = 0; t < tris; t++) {
      const a = triClusters[t];
      if (a !== 0xffff) uniq.add(a);
      const b = triClustersN[t];
      if (b !== 0xffff) uniq.add(b);
      const c2 = triClustersN2[t];
      if (c2 !== 0xffff) uniq.add(c2);
    }
    const clusters = new Uint16Array(uniq.size);
    let ci = 0;
    for (const c of uniq) clusters[ci++] = c;

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
    // 单 group 且覆盖全部三角形的块走增量路径；多 group 块保留全量重排（group 顺序语义复杂）。
    const singleGroup = groups.length === 1 && groups[0].tris.length === tris;
    const incremental = singleGroup
      ? buildIncremental(tris, triClusters, triClustersN, triClustersN2, clusters, groups[0].materialIndex)
      : undefined;
    (mesh.userData as { clusterIndex?: ClusterIndexState }).clusterIndex = {
      triClusters, triClustersN, triClustersN2, origIndex, outIndex, attr, groups, lastCluster: -1, visTris: tris,
      clusters, sig: 0, incremental, rowVersion: -1,
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
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  let rebuilt = 0;
  let skipped = 0;
  let flipped = 0;
  // 稠密可见位图（下标 = cluster）：360 万次 `Set.has` 换成按下标读 Uint8Array。
  // 无 PVS / 尚未 update 时返回 null，退回原来的 `isVisible` 路径。
  const row = pvs.visibleRow ? pvs.visibleRow() : null;
  // 每帧更新一次可见行快照 + 差分（换房间时真正翻位的 cluster 通常只有几十个）。
  refreshRowDiff(row);
  const epoch = ++flipEpoch;
  for (const item of items) {
    const st = (item.mesh.userData as { clusterIndex?: ClusterIndexState }).clusterIndex;
    if (!st) continue;
    // 距离场外的远景块暂不重建也不上传，等进入视距后再补齐。
    if (item.mesh.userData.lodLevel === 2) {
      skipped++;
      continue;
    }
    if (st.lastCluster === camCluster) continue;
    const geom = item.mesh.geometry;
    const inc = st.incremental;
    if (inc) {
      // 增量块：①行没变 ⇒ 上次写进去的 index 仍然正确，只更新 lastCluster；
      // ②行变了且本块状态正好停在上一版行上 ⇒ 只翻本帧变了的 cluster；
      // ③其余（首次/行长度变化/状态落后多版）⇒ 全量重建一次兜底。
      if (row && !pendingFull && st.lastCluster !== -1 && st.rowVersion === rowVersion) {
        st.lastCluster = camCluster;
        skipped++;
        continue;
      }
      const canFlip =
        row !== null && !pendingFull && st.lastCluster !== -1 && st.rowVersion === rowVersion - 1;
      if (canFlip) {
        const res = flipChangedClusters(st, row, pvs, pendingChanged, epoch);
        flipped++;
        if (res.dirty && st.visTris > 0) {
          if (typeof st.attr.clearUpdateRanges === 'function') {
            st.attr.clearUpdateRanges();
            st.attr.addUpdateRange(res.minPos * 3, (res.maxPos - res.minPos + 1) * 3);
          }
          st.attr.needsUpdate = true;
        }
      } else {
        rebuildIncrementalFull(st, row, pvs);
        rebuilt++;
        if (st.visTris > 0) {
          if (typeof st.attr.clearUpdateRanges === 'function') {
            st.attr.clearUpdateRanges();
            st.attr.addUpdateRange(0, st.visTris * 3);
          }
          st.attr.needsUpdate = true;
        }
      }
      st.lastCluster = camCluster;
      st.rowVersion = rowVersion;
      geom.setDrawRange(0, st.visTris * 3);
      // 距离场优先：`visibility-controller` 已把场外块标成 LOD_FAR，这里不能把它重新点亮。
      item.mesh.visible = st.visTris > 0 && item.mesh.userData.lodLevel === 0;
      continue;
    }
    // 多 group 块：保留原来的「块可见签名」快路径 + 全量重排。
    // 快路径：本块用到的 cluster 可见性没变 ⇒ 上次写进 index 的三组三角形集合仍然是正确的，
    // 直接跳过（换房间时绝大多数块都属于这一类；全量重排 123 万三角实测 15–25ms）。
    if (row && st.lastCluster !== -1 && st.clusters.length > 0) {
      let sig = 0x811c9dc5;
      const cl = st.clusters;
      for (let i = 0; i < cl.length; i++) {
        const c = cl[i];
        sig ^= c < row.length ? row[c] : 0;
        sig = Math.imul(sig, 0x01000193);
      }
      sig >>>= 0;
      if (sig === st.sig && st.sig !== 0) {
        st.lastCluster = camCluster;
        st.rowVersion = rowVersion;
        skipped++;
        continue;
      }
      st.sig = sig;
    }
    const { triClusters, triClustersN, triClustersN2, origIndex, outIndex, attr, groups } = st;
    let n = 0;
    geom.clearGroups();
    for (const g of groups) {
      const start = n;
      for (let i = 0; i < g.tris.length; i++) {
        const t = g.tris[i];
        // 两个来源任一可见就画：face 引用映射可能是「楼下/隔壁的房间」，法线采样才是面朝向的房间。
        const ca = triClusters[t];
        const cn = triClustersN[t];
        const cn2 = triClustersN2[t];
        // 已做子模型继承，仍为全 0xffff 说明该子模型完全在虚空里，不再放行。
        const on = row
          ? (ca !== 0xffff && ca < row.length && row[ca] === 1) ||
            (cn !== 0xffff && cn < row.length && row[cn] === 1) ||
            (cn2 !== 0xffff && cn2 < row.length && row[cn2] === 1)
          : (ca !== 0xffff && pvs.isVisible(ca)) ||
            (cn !== 0xffff && pvs.isVisible(cn)) ||
            (cn2 !== 0xffff && pvs.isVisible(cn2));
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
    st.rowVersion = rowVersion;
    if (n > 0) {
      if (typeof attr.clearUpdateRanges === 'function') {
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, n);
      }
      attr.needsUpdate = true;
    }
    geom.setDrawRange(0, n);
    // 距离场优先：`visibility-controller` 已把场外块标成 LOD_FAR，这里不能把它重新点亮。
    item.mesh.visible = st.visTris > 0 && item.mesh.userData.lodLevel === 0;
    rebuilt++;
  }
  // 诊断：换房间那一下到底重排了多少块、跳过了多少块、花了多少毫秒（飞行回放调参用）。
  (globalThis as { __vbspClusterRebuild?: unknown }).__vbspClusterRebuild = {
    rebuilt,
    skipped,
    flipped,
    total: items.length,
    ms: (typeof performance !== 'undefined' ? performance.now() : 0) - t0,
    pvsRow: row ? row.length : 0,
  };
  return rebuilt;
}

/**
 * 关掉 PVS 时把逐三角形 index 还原成原始全量。
 *
 * `applyClusterIndex` 写进去的 index 是「当前房间可见集」，关掉 PVS 后不会自己复原：
 * drawRange 与 groups 仍停在上一间房的结果上，用户看到的是「PVS 明明关了、墙还是缺一块」。
 * 这里按 `origIndex` 全量写回，并复位 `lastCluster`，下次开 PVS 会按当前房间重算。
 */
export function restoreClusterIndex(items: readonly { mesh: THREE.Mesh }[]): number {
  let restored = 0;
  for (const item of items) {
    const st = (item.mesh.userData as { clusterIndex?: ClusterIndexState }).clusterIndex;
    if (!st) continue;
    const geom = item.mesh.geometry;
    const total = st.origIndex.length;
    if (st.lastCluster === -1 && st.visTris === total / 3) continue;
    st.outIndex.set(st.origIndex);
    if (st.incremental) {
      // 增量状态复位：identity 顺序 = 全部三角形都可见（与 outIndex 全量一致）。
      const inc = st.incremental;
      const tris = st.triClusters.length;
      for (let t = 0; t < tris; t++) {
        inc.posOfTri[t] = t;
        inc.slotTri[t] = t;
      }
      st.visTris = tris;
    }
    geom.clearGroups();
    let start = 0;
    for (const g of st.groups) {
      const count = g.tris.length * 3;
      if (count > 0) geom.addGroup(start, count, g.materialIndex);
      start += count;
    }
    if (typeof st.attr.clearUpdateRanges === 'function') st.attr.clearUpdateRanges();
    st.attr.needsUpdate = true;
    st.visTris = total / 3;
    st.lastCluster = -1;
    // 行版本/签名复位：下次开 PVS 不能把「关之前的行」误当成当前行。
    st.rowVersion = -1;
    st.sig = 0;
    geom.setDrawRange(0, total);
    item.mesh.visible = item.mesh.userData.lodLevel === 0;
    restored++;
  }
  return restored;
}

/** 相机 cluster 变化后需要重建的块数（诊断用）。 */
export function clusterIndexStates(items: readonly { mesh: THREE.Mesh }[]): number {
  let n = 0;
  for (const item of items) if ((item.mesh.userData as { clusterIndex?: unknown }).clusterIndex) n++;
  return n;
}
