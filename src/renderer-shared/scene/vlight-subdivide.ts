/**
 * 逐顶点烘焙光（`_vbsp_vlight`）的分段线性条带修复：按网格尺度做**均匀**细分。
 *
 * 背景：prop 曲面常常只有 2~3 列顶点，VRAD 的顶点色按 ~100 HU 采样一次。
 * Gouraud 在两条顶点行之间是恒定斜率的线性渐变，到下一行斜率突变，观感上就是
 * 「一张张纸叠起来」的硬边条带。只改原顶点的值（平滑）去不掉这个结构，
 * 必须提高采样密度：均匀细分大三角形，中点值取两端平均，再交给平滑收敛。
 *
 * 均匀细分（整块同一层级）不会产生 T 形裂缝；层级按中位边长选，控制顶点膨胀。
 */

import * as THREE from 'three';

/** 平均边长超过该值（HU）才细分。 */
const SUBDIV_EDGE_L1 = 96;
const SUBDIV_EDGE_L2 = 256;
/** 单个几何最多细分出的索引数，防爆。 */
const SUBDIV_MAX_INDICES = 600_000;
/** 重采样半径 = max(该下限, RESAMPLE_EDGE_SCALE × 中位边长)。 */
const RESAMPLE_RADIUS_MIN = 120;
const RESAMPLE_EDGE_SCALE = 5;

interface SparseSample {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
}

/** 记下细分前的稀疏光照样本（按位置去重，避免重复顶点被重复加权）。 */
function captureSparse(geom: THREE.BufferGeometry): SparseSample[] {
  const pos = geom.getAttribute('position');
  const col = geom.getAttribute('_vbsp_vlight');
  if (!pos || !col) return [];
  const seen = new Set<string>();
  const out: SparseSample[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${Math.round(x * 2)},${Math.round(y * 2)},${Math.round(z * 2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x, y, z, r: col.getX(i), g: col.getY(i), b: col.getZ(i) });
  }
  return out;
}

/** 用稀疏样本的半径加权平均给细分后的每个顶点重新取值（这才是视觉上真正生效的一步）。 */
function resampleFromSparse(geom: THREE.BufferGeometry, sparse: SparseSample[], edge: number): void {
  const col = geom.getAttribute('_vbsp_vlight');
  const pos = geom.getAttribute('position');
  if (!col || !pos || sparse.length === 0) return;

  const R = Math.max(RESAMPLE_RADIUS_MIN, edge * RESAMPLE_EDGE_SCALE);
  const invR = 1 / R;
  // 位置分桶用数字键（每顶点要查 27 个格子，字符串拼接在大网格上很贵）。
  const cellKey = (gx: number, gy: number, gz: number): number =>
    (gx + 2048) * 4194304 + (gy + 2048) * 2048 + (gz + 2048);
  const sx = new Float32Array(sparse.length);
  const sy = new Float32Array(sparse.length);
  const sz = new Float32Array(sparse.length);
  const sr = new Float32Array(sparse.length);
  const sg = new Float32Array(sparse.length);
  const sb = new Float32Array(sparse.length);
  for (let s = 0; s < sparse.length; s++) {
    sx[s] = sparse[s].x;
    sy[s] = sparse[s].y;
    sz[s] = sparse[s].z;
    sr[s] = sparse[s].r;
    sg[s] = sparse[s].g;
    sb[s] = sparse[s].b;
  }
  const cells = new Map<number, number[]>();
  for (let s = 0; s < sparse.length; s++) {
    const k = cellKey(Math.floor(sx[s] * invR), Math.floor(sy[s] * invR), Math.floor(sz[s] * invR));
    let arr = cells.get(k);
    if (!arr) {
      arr = [];
      cells.set(k, arr);
    }
    arr.push(s);
  }

  const out = new Float32Array(col.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const cx = Math.floor(x * invR);
    const cy = Math.floor(y * invR);
    const cz = Math.floor(z * invR);
    let wr = 0;
    let wg = 0;
    let wb = 0;
    let wsum = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const arr = cells.get(cellKey(cx + dx, cy + dy, cz + dz));
          if (!arr) continue;
          for (let t = 0; t < arr.length; t++) {
            const s = arr[t];
            const d2 = (sx[s] - x) ** 2 + (sy[s] - y) ** 2 + (sz[s] - z) ** 2;
            const d = Math.sqrt(d2);
            if (d >= R) continue;
            const w = (1 - d * invR) ** 2;
            wr += sr[s] * w;
            wg += sg[s] * w;
            wb += sb[s] * w;
            wsum += w;
          }
        }
      }
    }
    if (wsum > 0) {
      const inv = 1 / wsum;
      out[i * 3] = wr * inv;
      out[i * 3 + 1] = wg * inv;
      out[i * 3 + 2] = wb * inv;
    } else {
      out[i * 3] = col.getX(i);
      out[i * 3 + 1] = col.getY(i);
      out[i * 3 + 2] = col.getZ(i);
    }
  }
  for (let i = 0; i < col.count; i++) {
    col.setXYZ(i, out[i * 3], out[i * 3 + 1], out[i * 3 + 2]);
  }
  col.needsUpdate = true;
  (geom.userData as { __vlResampled?: number }).__vlResampled = (geom.userData as { __vlResampled?: number }).__vlResampled ?? 0;
  (geom.userData as { __vlResampled?: number }).__vlResampled! += 1;
}

function medianEdge(geom: THREE.BufferGeometry, triCount: number): number {
  const pos = geom.getAttribute('position');
  const idx = geom.getIndex();
  if (!pos || !idx) return 0;
  const step = Math.max(1, Math.floor(triCount / 200));
  const edges: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let t = 0; t + 2 < idx.count; t += 3 * step) {
    const i0 = idx.getX(t);
    const i1 = idx.getX(t + 1);
    const i2 = idx.getX(t + 2);
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    edges.push(a.distanceTo(b));
    a.fromBufferAttribute(pos, i1);
    b.fromBufferAttribute(pos, i2);
    edges.push(a.distanceTo(b));
  }
  if (edges.length === 0) return 0;
  edges.sort((x, y) => x - y);
  return edges[Math.floor(edges.length / 2)];
}

/** 统一 1→4 细分一层：每个三角形按三边中点拆成 4 个，属性线性插值。 */
function subdivideOnce(geom: THREE.BufferGeometry): boolean {
  const idx = geom.getIndex();
  const pos = geom.getAttribute('position');
  if (!idx || !pos) return false;

  const attrs: THREE.BufferAttribute[] = [];
  for (const name of Object.keys(geom.attributes)) {
    const attr = geom.getAttribute(name);
    if (!(attr instanceof THREE.BufferAttribute)) return false;
    if (!(attr.array instanceof Float32Array)) return false;
    attrs.push(attr);
  }
  if (attrs.length === 0) return false;

  const oldCount = pos.count;
  const totalItems = attrs.reduce((n, a) => n + a.itemSize, 0);
  const midCache = new Map<number, number>();
  const newVals: Float32Array[] = [];

  const midOf = (i0: number, i1: number): number => {
    const lo = Math.min(i0, i1);
    const hi = Math.max(i0, i1);
    const key = lo * oldCount + hi;
    const hit = midCache.get(key);
    if (hit !== undefined) return hit;
    const vi = oldCount + newVals.length;
    const vals = new Float32Array(totalItems);
    let o = 0;
    for (const attr of attrs) {
      for (let k = 0; k < attr.itemSize; k++) {
        vals[o++] = (attr.getComponent(lo, k) + attr.getComponent(hi, k)) * 0.5;
      }
    }
    newVals.push(vals);
    midCache.set(key, vi);
    return vi;
  };

  const out = new Uint32Array(idx.count * 4);
  let w = 0;
  const triCount = Math.floor(idx.count / 3);
  for (let t = 0; t < triCount; t++) {
    const i0 = idx.getX(t * 3);
    const i1 = idx.getX(t * 3 + 1);
    const i2 = idx.getX(t * 3 + 2);
    const m01 = midOf(i0, i1);
    const m12 = midOf(i1, i2);
    const m20 = midOf(i2, i0);
    out[w++] = i0; out[w++] = m01; out[w++] = m20;
    out[w++] = m01; out[w++] = i1; out[w++] = m12;
    out[w++] = m20; out[w++] = m12; out[w++] = i2;
    out[w++] = m01; out[w++] = m12; out[w++] = m20;
  }

  const newCount = oldCount + newVals.length;
  for (const attr of attrs) {
    const n = attr.itemSize;
    const arr = new Float32Array(newCount * n);
    arr.set(attr.array as Float32Array, 0);
    const dst = (oldCount * n) | 0;
    let o = dst;
    for (let j = 0; j < newVals.length; j++) {
      const vals = newVals[j];
      let src = 0;
      for (const a2 of attrs) {
        if (a2 === attr) {
          for (let k = 0; k < n; k++) arr[o++] = vals[src + k];
          break;
        }
        src += a2.itemSize;
      }
    }
    attr.array = arr;
    // BufferAttribute 的 count 在构造时按数组长度定型，换数组必须同步（类型上标了 readonly）
    (attr as unknown as { count: number }).count = newCount;
    attr.needsUpdate = true;
  }

  // 法线中点要重新归一化
  const nrm = geom.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (nrm) {
    const v = new THREE.Vector3();
    for (let i = oldCount; i < newCount; i++) {
      v.fromBufferAttribute(nrm, i).normalize();
      nrm.setXYZ(i, v.x, v.y, v.z);
    }
  }

  geom.setIndex(new THREE.BufferAttribute(out, 1));
  // 组区间按 4 倍平移（组边界落在三角形边界上时严格成立）
  const groups = geom.groups.map((g) => ({ ...g }));
  geom.clearGroups();
  for (const g of groups) geom.addGroup(g.start * 4, g.count * 4, g.materialIndex);
  geom.boundingSphere = null;
  geom.boundingBox = null;
  return true;
}

/** 返回细分层数（0 表示没动）。 */
export function subdivideVertexLit(geom: THREE.BufferGeometry): number {
  const vAttr = geom.getAttribute('_vbsp_vlight');
  const idx = geom.getIndex();
  const pos = geom.getAttribute('position');
  if (!vAttr || !idx || !pos) return 0;

  const triCount = Math.floor(idx.count / 3);
  if (triCount === 0) return 0;
  const edge = medianEdge(geom, triCount);
  const levels = edge > SUBDIV_EDGE_L2 ? 2 : edge > SUBDIV_EDGE_L1 ? 1 : 0;

  // 不细分不等于不用管：细密网格上的 vhv 仍可能是硬边（s3_ramp1b 这类）。
  // 没有新增顶点时也做一次重采样，等价于「按真实空间尺度做一次连续核平滑」。
  if (levels === 0) {
    const sparse0 = captureSparse(geom);
    if (sparse0.length > 1) resampleFromSparse(geom, sparse0, edge);
    return 0;
  }
  if (triCount * 16 ** levels > SUBDIV_MAX_INDICES) return 0;

  const sparse = captureSparse(geom);
  let done = 0;
  for (let l = 0; l < levels; l++) {
    if (!subdivideOnce(geom)) break;
    done++;
  }
  // 细分本身只是把同一张线性插值切得更碎，视觉不变；必须**重采样**才有效：
  // 按细分前稀疏顶点的值做半径加权平均，得到连续的场，再写到细分后的每个顶点上。
  if (done > 0) resampleFromSparse(geom, sparse, edge);

  // 合并来源区间表跟着放大（诊断/单模型渲染依赖它）
  const table = geom.userData?.websurfMergeSourceTable as
    | { ranges?: { start: number; count: number }[] }
    | undefined;
  if (done > 0 && table?.ranges) {
    const f = 4 ** done;
    for (const r of table.ranges) {
      r.start *= f;
      r.count *= f;
    }
  }
  return done;
}
