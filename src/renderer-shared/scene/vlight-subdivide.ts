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
  const fast = (globalThis as { __vbspVLightFast?: boolean }).__vbspVLightFast !== false;
  const gs = globalThis as {
    __vbspSubdivPerf?: {
      chunks: number; median: number; capture: number; resample: number; levels0: number; levelsN: number;
    };
  };
  const perf = (gs.__vbspSubdivPerf ??= { chunks: 0, median: 0, capture: 0, resample: 0, levels0: 0, levelsN: 0 });
  const vAttr = geom.getAttribute('_vbsp_vlight');
  const idx = geom.getIndex();
  const pos = geom.getAttribute('position');
  if (!vAttr || !idx || !pos) return 0;

  const triCount = Math.floor(idx.count / 3);
  if (triCount === 0) return 0;
  const tm = performance.now();
  const edge = medianEdge(geom, triCount);
  perf.median += performance.now() - tm;
  const levels = edge > SUBDIV_EDGE_L2 ? 2 : edge > SUBDIV_EDGE_L1 ? 1 : 0;

  // 不细分不等于不用管：细密网格上的 vhv 仍可能是硬边（s3_ramp1b 这类）。
  // 没有新增顶点时也做一次重采样，等价于「按真实空间尺度做一次连续核平滑」。
  if (levels === 0) {
    perf.levels0++;
    const tc = performance.now();
    let fastSparse: SparseFast | null = null;
    let legacySparse: SparseSample[] | null = null;
    if (fast) fastSparse = captureSparseFast(geom);
    else legacySparse = captureSparse(geom);
    perf.capture += performance.now() - tc;
    if ((fast && fastSparse!.count > 1) || (!fast && legacySparse!.length > 1)) {
      const tr = performance.now();
      if (fast) resampleFast(geom, fastSparse!, edge);
      else resampleFromSparse(geom, legacySparse!, edge);
      perf.resample += performance.now() - tr;
    }
    perf.chunks++;
    if (perf.chunks % 100 === 0) console.info('[subdiv-perf] ' + JSON.stringify(perf));
    return 0;
  }
  perf.levelsN++;
  if (triCount * 16 ** levels > SUBDIV_MAX_INDICES) return 0;

  const tc = performance.now();
  let fastSparse: SparseFast | null = null;
  let legacySparse: SparseSample[] | null = null;
  if (fast) fastSparse = captureSparseFast(geom);
  else legacySparse = captureSparse(geom);
  perf.capture += performance.now() - tc;
  let done = 0;
  for (let l = 0; l < levels; l++) {
    if (!subdivideOnce(geom)) break;
    done++;
  }
  // 细分本身只是把同一张线性插值切得更碎，视觉不变；必须**重采样**才有效：
  // 按细分前稀疏顶点的值做半径加权平均，得到连续的场，再写到细分后的每个顶点上。
  if (done > 0) {
    const tr = performance.now();
    if (fast) resampleFast(geom, fastSparse!, edge);
    else resampleFromSparse(geom, legacySparse!, edge);
    perf.resample += performance.now() - tr;
  }

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
  perf.chunks++;
  if (perf.chunks % 100 === 0) console.info('[subdiv-perf] ' + JSON.stringify(perf));
  return done;
}

// ---------------------------------------------------------------------------
// 等价加速实现（A/B：`globalThis.__vbspVLightFast = false` 回退到上面的 legacy 路径）。
// 语义（量化 Math.round(x*2)、示例顺序、半径、权重、层数判定）与 legacy 完全一致，
// 只替换实现：焊接 key 从字符串 Set 换成数字哈希桶 + 精确三元组比较；
// resample 用「每个顶点 cell 的 27 邻域样本索引缓存 + 直接写回属性数组」，
// 避免每个顶点 27 次 Map.get 与一次额外 out 数组往返。
// ---------------------------------------------------------------------------

interface SparseFast {
  count: number;
  sx: Float64Array;
  sy: Float64Array;
  sz: Float64Array;
  sr: Float64Array;
  sg: Float64Array;
  sb: Float64Array;
}

function emptySparseFast(): SparseFast {
  return {
    count: 0,
    sx: new Float64Array(0),
    sy: new Float64Array(0),
    sz: new Float64Array(0),
    sr: new Float64Array(0),
    sg: new Float64Array(0),
    sb: new Float64Array(0),
  };
}

function captureSparseFast(geom: THREE.BufferGeometry): SparseFast {
  const pos = geom.getAttribute('position');
  const col = geom.getAttribute('_vbsp_vlight');
  if (!pos || !col) return emptySparseFast();
  const n = pos.count;
  if (n === 0) return emptySparseFast();
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const sz = new Float64Array(n);
  const sr = new Float64Array(n);
  const sg = new Float64Array(n);
  const sb = new Float64Array(n);
  const qx = new Int32Array(n);
  const qy = new Int32Array(n);
  const qz = new Int32Array(n);
  const weld = new Map<number, number[]>();
  const posIA = (pos as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute === true;
  const colIA = (col as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute === true;
  const pa =
    !posIA && pos.itemSize === 3 && pos.array instanceof Float32Array
      ? (pos.array as Float32Array)
      : null;
  const ca =
    !colIA && col.itemSize === 3 && col.array instanceof Float32Array
      ? (col.array as Float32Array)
      : null;
  let m = 0;
  for (let i = 0; i < n; i++) {
    const x = pa ? pa[i * 3] : pos.getX(i);
    const y = pa ? pa[i * 3 + 1] : pos.getY(i);
    const z = pa ? pa[i * 3 + 2] : pos.getZ(i);
    const ex = Math.round(x * 2);
    const ey = Math.round(y * 2);
    const ez = Math.round(z * 2);
    const h = (Math.imul(ex, 0x9e3779b1) ^ Math.imul(ey, 0x85ebca77) ^ Math.imul(ez, 0xc2b2ae3d)) >>> 0;
    const bucket = weld.get(h);
    let found = false;
    if (bucket !== undefined) {
      for (let t = 0; t < bucket.length; t++) {
        const c = bucket[t];
        if (qx[c] === ex && qy[c] === ey && qz[c] === ez) {
          found = true;
          break;
        }
      }
    }
    if (found) continue;
    const arr = bucket ?? [];
    if (bucket === undefined) weld.set(h, arr);
    arr.push(m);
    qx[m] = ex;
    qy[m] = ey;
    qz[m] = ez;
    sx[m] = x;
    sy[m] = y;
    sz[m] = z;
    sr[m] = ca ? ca[i * 3] : col.getX(i);
    sg[m] = ca ? ca[i * 3 + 1] : col.getY(i);
    sb[m] = ca ? ca[i * 3 + 2] : col.getZ(i);
    m++;
  }
  return {
    count: m,
    sx: sx.subarray(0, m),
    sy: sy.subarray(0, m),
    sz: sz.subarray(0, m),
    sr: sr.subarray(0, m),
    sg: sg.subarray(0, m),
    sb: sb.subarray(0, m),
  };
}

function resampleFast(geom: THREE.BufferGeometry, sparse: SparseFast, edge: number): void {
  const col = geom.getAttribute('_vbsp_vlight');
  const pos = geom.getAttribute('position');
  if (!col || !pos || sparse.count === 0) return;
  const n = pos.count;
  const R = Math.max(RESAMPLE_RADIUS_MIN, edge * RESAMPLE_EDGE_SCALE);
  const invR = 1 / R;
  const cellKey = (gx: number, gy: number, gz: number): number =>
    (gx + 2048) * 4194304 + (gy + 2048) * 2048 + (gz + 2048);
  const { count, sx, sy, sz, sr, sg, sb } = sparse;

  // 样本分桶（与 legacy 相同：Map<key, 样本下标数组>，数组内按样本顺序）
  const cells = new Map<number, number[]>();
  for (let s = 0; s < count; s++) {
    const k = cellKey(Math.floor(sx[s] * invR), Math.floor(sy[s] * invR), Math.floor(sz[s] * invR));
    let arr = cells.get(k);
    if (!arr) {
      arr = [];
      cells.set(k, arr);
    }
    arr.push(s);
  }

  // 27 邻域偏移（dx→dy→dz 升序，与 legacy 的循环顺序一致）
  const offsets = new Int32Array(27);
  {
    let w = 0;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) offsets[w++] = dx * 4194304 + dy * 2048 + dz;
  }
  // 顶点 cell -> 有序 27 邻域样本下标缓存（同一 cell 的所有顶点复用同一顺序表）
  const cache = new Map<number, Int32Array>();
  const posIA = (pos as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute === true;
  const colIA = (col as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute === true;
  const pa =
    !posIA && pos.itemSize === 3 && pos.array instanceof Float32Array
      ? (pos.array as Float32Array)
      : null;
  const ca =
    !colIA && col.itemSize === 3 && col.array instanceof Float32Array
      ? (col.array as Float32Array)
      : null;
  // 顶点去重：合并块里同一位置 + 同一 vlight 值会被多个三角形/分组重复持有；
  // 结果只依赖 (位置, 原值) ⇒ 每个唯一组合只算一次，再按 rep 写回（位级结果不变）。
  const rep = new Int32Array(n);
  const repX = new Float64Array(n);
  const repY = new Float64Array(n);
  const repZ = new Float64Array(n);
  const repR = new Float64Array(n);
  const repG = new Float64Array(n);
  const repB = new Float64Array(n);
  const buckets = new Map<number, number[]>();
  const tmpF = new Float32Array(6);
  const tmpU = new Uint32Array(tmpF.buffer);
  let repCount = 0;
  for (let i = 0; i < n; i++) {
    const x = pa ? pa[i * 3] : pos.getX(i);
    const y = pa ? pa[i * 3 + 1] : pos.getY(i);
    const z = pa ? pa[i * 3 + 2] : pos.getZ(i);
    const cr = ca ? ca[i * 3] : col.getX(i);
    const cg = ca ? ca[i * 3 + 1] : col.getY(i);
    const cb = ca ? ca[i * 3 + 2] : col.getZ(i);
    tmpF[0] = x; tmpF[1] = y; tmpF[2] = z; tmpF[3] = cr; tmpF[4] = cg; tmpF[5] = cb;
    const h = (Math.imul(tmpU[0], 73856093)
      ^ Math.imul(tmpU[1], 19349663)
      ^ Math.imul(tmpU[2], 83492791)
      ^ Math.imul(tmpU[3], 50331653)
      ^ Math.imul(tmpU[4], 16777619)
      ^ Math.imul(tmpU[5], 2654435761)) >>> 0;
    let bucket = buckets.get(h);
    let found = -1;
    if (bucket !== undefined) {
      for (let t = 0; t < bucket.length; t++) {
        const c = bucket[t];
        if (Object.is(repX[c], x) && Object.is(repY[c], y) && Object.is(repZ[c], z)
          && Object.is(repR[c], cr) && Object.is(repG[c], cg) && Object.is(repB[c], cb)) { found = c; break; }
      }
    }
    if (found >= 0) { rep[i] = found; continue; }
    const c = repCount++;
    rep[i] = c;
    repX[c] = x; repY[c] = y; repZ[c] = z; repR[c] = cr; repG[c] = cg; repB[c] = cb;
    if (bucket !== undefined) bucket.push(c); else buckets.set(h, [c]);
  }

  const outR = new Float64Array(repCount);
  const outG = new Float64Array(repCount);
  const outB = new Float64Array(repCount);
  const safeR2 = (R * 1.000001) * (R * 1.000001);
  for (let q = 0; q < repCount; q++) {
    const x = repX[q];
    const y = repY[q];
    const z = repZ[q];
    const baseKey = cellKey(Math.floor(x * invR), Math.floor(y * invR), Math.floor(z * invR));
    let cand = cache.get(baseKey);
    if (cand === undefined) {
      const list: number[] = [];
      for (let k = 0; k < 27; k++) {
        const arr = cells.get(baseKey + offsets[k]);
        if (!arr) continue;
        for (let t = 0; t < arr.length; t++) list.push(arr[t]);
      }
      cand = Int32Array.from(list);
      cache.set(baseKey, cand);
    }
    let wr = 0;
    let wg = 0;
    let wb = 0;
    let wsum = 0;
    for (let k = 0; k < cand.length; k++) {
      const s = cand[k];
      const dx = sx[s] - x;
      const dy = sy[s] - y;
      const dz = sz[s] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      // 只跳过「必然 d>=R」的样本（留 1ppm 安全余量）；边界样本仍走 sqrt 做与 legacy 相同的精确判定
      if (d2 > safeR2) continue;
      const d = Math.sqrt(d2);
      if (d >= R) continue;
      const e = 1 - d * invR;
      const w = e * e;
      wr += sr[s] * w;
      wg += sg[s] * w;
      wb += sb[s] * w;
      wsum += w;
    }
    // wsum===0 时保持原值（等价于 legacy 的 else 分支写回 col.getX/Y/Z(i)）
    if (wsum > 0) {
      const inv = 1 / wsum;
      outR[q] = wr * inv;
      outG[q] = wg * inv;
      outB[q] = wb * inv;
    } else {
      outR[q] = repR[q];
      outG[q] = repG[q];
      outB[q] = repB[q];
    }
  }
  for (let i = 0; i < n; i++) {
    const q = rep[i];
    const r = outR[q];
    const g = outG[q];
    const b = outB[q];
    if (ca) {
      ca[i * 3] = r;
      ca[i * 3 + 1] = g;
      ca[i * 3 + 2] = b;
    } else {
      col.setXYZ(i, r, g, b);
    }
  }
  col.needsUpdate = true;
  const ud = geom.userData as { __vlResampled?: number };
  ud.__vlResampled = ud.__vlResampled ?? 0;
  ud.__vlResampled += 1;
}
