/**
 * `RenderSession` 的**只读诊断**集合（T-P2-2c 从 render-session.ts 抽出）。
 *
 * 这些方法只读会话现场（相机 / 主根 / PVS / 可见性条目），不改任何渲染状态，供
 * `__vbspChunkAudit` 等调试口调用。抽出的动机是体积：原文件把 ~410 行诊断与
 * 帧主流程混在一起，改一次帧逻辑要翻过大段取证代码。
 *
 * 约束：只走 `host` 的四个只读字段——不回调会话方法、不写状态。
 */
import * as THREE from 'three';
import type { PvsManager } from '../../ts-shared/world/pvs-manager.js';
import type { VisibilityItem } from './visibility-controller.js';
import { lookupMergeSource } from './scene-optimizer.js';

/** 沿面法线外推的距离（HU）：面本身是边界，重心必然贴着 brush。 */
const CLUSTER_LEAK_PROBE_PUSH = [4, 16, 64, 192] as const;

/** 诊断只需要的会话现场（全部只读）。 */
export interface ChunkDiagnosticsHost {
  camera: THREE.PerspectiveCamera;
  root: THREE.Object3D | null;
  pvs: PvsManager | null;
  visibility: {
    readonly items: readonly VisibilityItem[];
    readonly enablePvs: boolean;
    readonly cullDistance: number;
  };
}

export function auditChunks(host: ChunkDiagnosticsHost, limit = 40): {
  cull: number;
  total: number;
  drawn: number;
  noCluster: number;
  pvsActive: boolean;
  far: Array<{ name: string; d: number; r: number; boxD: number | null; clusters: number; pvsVisible: boolean | null; visible: boolean; tris: number }>;
  nearCulled: Array<{ idx: number; name: string; d: number; r: number; clusters: number; pvsVisible: boolean | null; tris: number }>;
} {
  const p = host.camera.position;
  const items = host.visibility.items;
  const pvsActive = !!(host.visibility.enablePvs && host.pvs?.enabled);
  const all: Array<{ name: string; d: number; r: number; boxD: number | null; clusters: number; pvsVisible: boolean | null; visible: boolean; tris: number }> = [];
  const nearCulled: Array<{ idx: number; name: string; d: number; r: number; clusters: number; pvsVisible: boolean | null; tris: number }> = [];
  let drawn = 0;
  let noCluster = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const g = item.mesh.geometry as THREE.BufferGeometry | undefined;
    const tris = g?.index ? g.index.count / 3 : (g?.getAttribute('position')?.count ?? 0) / 3;
    const d = item.center.distanceTo(p);
    if (item.clusterIds.length === 0) noCluster++;
    const pvsVisible = item.clusterIds.length === 0 ? null : item.clusterIds.some((c) => host.pvs?.isVisible(c) ?? false);
    if (!item.mesh.visible) {
      // 近处被剔的块 = 「本该出现在眼前却没了」的头号嫌疑（缺墙 / 玻璃消失）。
      if (d < 8000) {
        nearCulled.push({ idx: i, name: item.mesh.name || '(anon)', d: Math.round(d), r: Math.round(item.radius), clusters: item.clusterIds.length, pvsVisible, tris: Math.round(tris) });
      }
      continue;
    }
    drawn++;
    all.push({
      name: item.mesh.name || '(anon)',
      d: Math.round(d),
      r: Math.round(item.radius),
      boxD: item.box ? Math.round(item.box.distanceToPoint(p)) : null,
      clusters: item.clusterIds.length,
      pvsVisible,
      visible: true,
      tris: Math.round(tris),
    });
  }
  all.sort((a, b) => b.d - a.d);
  nearCulled.sort((a, b) => a.d - b.d);
  return { cull: host.visibility.cullDistance, total: items.length, drawn, noCluster, pvsActive, far: all.slice(0, limit), nearCulled: nearCulled.slice(0, limit) };
}

/**
 * 诊断：块级并集到底放进来多少「来自不可见 cluster」的三角形。
 *
 * 语义背景：一个合并块可以横跨多个房间（`clusterIds` 有多个），运行期只要**任一个**
 * cluster 在可见集里就整块画 ⇒ 别的房间的三角形跟着出来，这是「看得见才画」的粒度上限。
 * 这里逐三角形质心 → BSP leaf → cluster，统计每块里 PVS 判不可见的占比，
 * 给出「块级并集」实际泄漏量的直接证据（质心采样，不是精确面积）。
 */
export function leakChunks(host: ChunkDiagnosticsHost, limit = 20): {
  pvsActive: boolean;
  sampled: number;
  leaked: number;
  farLeaked: number;
  chunks: Array<{ name: string; tris: number; sampled: number; leaked: number; farLeaked: number; clusters: number }>;
} {
  const empty = { pvsActive: false, sampled: 0, leaked: 0, farLeaked: 0, chunks: [] };
  const pvs = host.pvs;
  if (!host.visibility.enablePvs || !pvs) return empty;
  const out = { pvsActive: true, sampled: 0, leaked: 0, farLeaked: 0, chunks: [] as Array<{ name: string; tris: number; sampled: number; leaked: number; farLeaked: number; clusters: number }> };
  const cam = host.camera.position;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (const item of host.visibility.items) {
    if (!item.mesh.visible) continue;
    // 单 cluster 的块过去被跳过（那时它不可能「半块泄漏」）。拆分之后正好相反：绝大多数
    // 画着的块都是单 cluster 片，必须一起采样，否则这个指标看不出「拆分是否真的精确」。
    if (item.clusterIds.length === 0) continue;
    const g = item.mesh.geometry as THREE.BufferGeometry | undefined;
    const pos = g?.getAttribute('position') as THREE.BufferAttribute | undefined;
    const index = g?.index ?? null;
    if (!pos) continue;
    // 合并块有两种：带 index 的（多材质 groups）与不带 index 的（单材质）。两种都要能采样。
    // 逐三角形过滤的块只画 `drawRange` 里的三角形：采样必须跟着 drawRange，否则会把
    // 「已经裁掉、根本没画」的三角形算成泄漏，指标直接失真（曾把 15% 的精确过滤读成 89%）。
    const total = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
    const drawnTris = g && g.drawRange.count !== Infinity
      ? Math.min(total, Math.floor(g.drawRange.count / 3))
      : total;
    const tris = drawnTris;
    if (tris === 0) continue;
    const matrix = item.mesh.matrixWorld;
    const stride = Math.max(1, Math.ceil(tris / 48));
    let sampled = 0;
    let leaked = 0;
    let farLeaked = 0;
    for (let t = 0; t < tris; t += stride) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      // 面法线：三角形重心**落在表面上**，直接查 leaf 会经常落进 brush 内部（cluster -1），
      // 那是判据噪声不是泄漏。按法线往外推几档再查，才是「这个面朝向的那间房」。
      a.add(b).add(c).multiplyScalar(1 / 3);
      const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
      const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      a.applyMatrix4(matrix);
      let cluster = -1;
      for (const push of CLUSTER_LEAK_PROBE_PUSH) {
        const px = a.x + nx * push, py = a.y + ny * push, pz = a.z + nz * push;
        cluster = pvs.getClusterAt({ x: px, y: py, z: pz });
        if (cluster >= 0) break;
        const bx = a.x - nx * push, by = a.y - ny * push, bz = a.z - nz * push;
        cluster = pvs.getClusterAt({ x: bx, y: by, z: bz });
        if (cluster >= 0) break;
      }
      if (cluster < 0) continue; // 两侧都采不到房间（纯内部面），不参与判定
      sampled++;
      if (pvs.isVisible(cluster)) continue;
      leaked++;
      if (a.distanceTo(cam) > 12000) farLeaked++;
    }
    out.sampled += sampled;
    out.leaked += leaked;
    out.farLeaked += farLeaked;
    if (leaked > 0) out.chunks.push({ name: item.mesh.name || '(anon)', tris, sampled, leaked, farLeaked, clusters: item.clusterIds.length });
  }
  out.chunks.sort((x, y) => y.leaked - x.leaked);
  out.chunks.splice(limit);
  return out;
}

/**
 * 诊断：几何真值——从相机朝该块的最近顶点射一条线，看**第一个挡住它的是谁**。
 * `sameChunk: true` 就说明「这块肉眼可见却被剔了」＝PVS 判错（先用它区分 PVS 误剔与单纯背对相机）。
 */
export function rayCheckChunk(host: ChunkDiagnosticsHost, idx: number): { name: string; chunkVisible: boolean; sameChunk: boolean; hitName: string; hitDist: number; targetDist: number } | null {
  const item = host.visibility.items[idx];
  if (!item || !host.root) return null;
  const cam = host.camera.position;
  const g = item.mesh.geometry as THREE.BufferGeometry;
  const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return null;
  const m = new THREE.Matrix4();
  item.mesh.updateWorldMatrix(true, false);
  m.copy(item.mesh.matrixWorld);
  const v = new THREE.Vector3();
  const best = new THREE.Vector3();
  let bestD = Infinity;
  const step = Math.max(1, Math.floor(pos.count / 4000));
  for (let i = 0; i < pos.count; i += step) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    const d = v.distanceToSquared(cam);
    if (d < bestD) { bestD = d; best.copy(v); }
  }
  if (!Number.isFinite(bestD)) return null;
  const dir = best.clone().sub(cam);
  const targetDist = dir.length();
  if (targetDist < 1e-3) return null;
  dir.divideScalar(targetDist);
  const rc = new THREE.Raycaster(cam.clone(), dir, 0.1, targetDist + 50);
  const hits = rc.intersectObject(host.root!, true);
  const first = hits.find((h) => (h.object as THREE.Mesh).isMesh && h.object.visible);
  return {
    name: item.mesh.name || '(anon)',
    chunkVisible: item.mesh.visible,
    sameChunk: !!first && first.object === item.mesh,
    hitName: first ? ((first.object as THREE.Mesh).name || '(anon)') : '(nothing)',
    hitDist: first ? Math.round(first.distance) : -1,
    targetDist: Math.round(targetDist),
  };
}

/**
 * 诊断：视锥网格射线审计——「眼前这一片，第一眼看到的东西里有多少是被剔掉的块」。
 * 这是 PVS 误剔的**像素级真值**：`culledFirst` 就是「本该画却没了」的采样点，
 * 比看截图快，也不需要知道相机朝向。
 */
export function auditFrustum(host: ChunkDiagnosticsHost, sx = 40, sy = 24): { rays: number; hits: number; culledFirst: number; samples: Array<{ name: string; d: number; clusters: number; pvsVisible: boolean | null }> } {
  const out = { rays: 0, hits: 0, culledFirst: 0, samples: [] as Array<{ name: string; d: number; clusters: number; pvsVisible: boolean | null }> };
  if (!host.root) return out;
  const byMesh = new Map<THREE.Object3D, number>();
  for (let i = 0; i < host.visibility.items.length; i++) byMesh.set(host.visibility.items[i].mesh, i);
  const cam = host.camera;
  const rc = new THREE.Raycaster();
  rc.far = 60000;
  const ndc = new THREE.Vector2();
  for (let y = 0; y < sy; y++) {
    for (let x = 0; x < sx; x++) {
      ndc.set(((x + 0.5) / sx) * 2 - 1, -(((y + 0.5) / sy) * 2 - 1));
      rc.setFromCamera(ndc, cam);
      out.rays++;
      const hits = rc.intersectObject(host.root, true);
      const first = hits.find((h) => (h.object as THREE.Mesh).isMesh);
      if (!first) continue;
      out.hits++;
      const obj = first.object as THREE.Mesh;
      if (obj.visible) continue;
      const idx = byMesh.get(obj);
      if (idx === undefined) continue;
      const item = host.visibility.items[idx];
      out.culledFirst++;
      if (out.samples.length < 12) {
        out.samples.push({
          name: obj.name || '(anon)',
          d: Math.round(first.distance),
          clusters: item.clusterIds.length,
          pvsVisible: item.clusterIds.length === 0 ? null : item.clusterIds.some((c) => host.pvs?.isVisible(c) ?? false),
        });
      }
    }
  }
  return out;
}

/**
 * 诊断：PVS 判定链路的现场快照——相机在哪个 leaf/cluster、可见集多大、
 * 最近 N 个块的 cluster 集合里是否含相机 cluster（不含才是「看不见自己所在房间」的真因）。
 */
export function pvsSnapshot(host: ChunkDiagnosticsHost, limit = 8): {
  camera: number[];
  clusterAtCamera: number;
  current: number;
  visible: number;
  total: number;
  selfVisible: boolean | null;
  nearest: Array<{ name: string; d: number; clusters: number[]; hasCamera: boolean; visible: boolean }>;
} | null {
  if (!host.pvs) return null;
  const p = host.camera.position;
  const at = host.pvs.getClusterAt({ x: p.x, y: p.y, z: p.z });
  const st = host.pvs.getStats();
  const near = host.visibility.items
    .map((it) => ({ it, d: it.center.distanceTo(p) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map(({ it, d }) => ({
      name: it.mesh.name || '(anon)',
      d: Math.round(d),
      clusters: it.clusterIds.slice(0, 8),
      hasCamera: it.clusterIds.includes(at),
      visible: it.mesh.visible,
    }));
  return {
    camera: [p.x, p.y, p.z].map(Math.round),
    clusterAtCamera: at,
    current: st.currentCluster,
    visible: st.visibleCount,
    total: st.totalClusters,
    selfVisible: at >= 0 ? host.pvs.isVisible(at) : null,
    nearest: near,
  };
}

/** 诊断：屏幕某点（NDC）射线打中的第一个块，及其 cluster / 可见性——「眼前这面墙到底被谁剔了」。 */
export function pickChunkAt(host: ChunkDiagnosticsHost, ndcX = 0, ndcY = 0): { idx: number; name: string; d: number; clusters: number[]; cameraCluster: number; hasCamera: boolean; pvsVisible: boolean | null; visible: boolean; mat: string; matTransparent: boolean; matMap: string; matWater: boolean; srcMesh: string; srcFace: number | null; srcTri: number } | null {
  if (!host.root) return null;
  const rc = new THREE.Raycaster();
  rc.far = 60000;
  rc.setFromCamera(new THREE.Vector2(ndcX, ndcY), host.camera);
  const hits = rc.intersectObject(host.root, true);
  const first = hits.find((h) => (h.object as THREE.Mesh).isMesh);
  if (!first) return null;
  const obj = first.object as THREE.Mesh;
  const idx = host.visibility.items.findIndex((it) => it.mesh === obj);
  const item = idx >= 0 ? host.visibility.items[idx] : null;
  const p = host.camera.position;
  const camCluster = host.pvs ? host.pvs.getClusterAt({ x: p.x, y: p.y, z: p.z }) : -1;
  const clusters = item ? item.clusterIds : [];
  // 材质名 + 是否透明：用来区分「被剔了」和「画了但材质/贴图不对」（两种现象看起来都是「空的」）。
  const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
  const g = first.face?.materialIndex ?? 0;
  const mat = mats[Math.min(g, mats.length - 1)] as THREE.Material | undefined;
  // 来源面：合并块本身无名，按 faceIndex 反查区间表 → 来源 glTF 网格名 + BSP 面号（extras.faceIndex）。
  const src = lookupMergeSource(obj.geometry, first.faceIndex);
  const srcTri = src && first.faceIndex != null ? Math.floor((first.faceIndex * 3 - src.start) / 3) : -1;
  return {
    idx,
    name: obj.name || '(anon)',
    d: Math.round(first.distance),
    clusters: clusters.slice(0, 12),
    cameraCluster: camCluster,
    hasCamera: clusters.includes(camCluster),
    pvsVisible: item ? (clusters.length === 0 ? null : clusters.some((c) => host.pvs?.isVisible(c) ?? false)) : null,
    visible: obj.visible,
    mat: mat?.name || '(unnamed)',
    matTransparent: mat?.transparent ?? false,
    matMap: (mat as THREE.MeshBasicMaterial | undefined)?.map?.name || '(nomap)',
    matWater: (mat?.userData as { vbsp_water?: unknown } | undefined)?.vbsp_water != null,
    srcMesh: src?.meshName || '(unknown)',
    srcFace: src?.faceIndex ?? null,
    srcTri,
  };
}

/**
 * 诊断：某个块（按索引）的 cluster 采样明细——每个顶点落到哪个 cluster、多少落进固体、
 * 以及**离相机最近的顶点们**分别落在哪个 cluster。
 *
 * 用途：缺墙时判断「块里靠相机那部分的顶点根本没采到房间 cluster」还是「采到了但 PVS 不认」。
 */
export function chunkClusterSample(host: ChunkDiagnosticsHost, idx: number, nearHU = 600): {
  name: string;
  tris: number;
  verts: number;
  solid: number;
  clusters: Array<{ c: number; n: number }>;
  nearVerts: Array<{ d: number; c: number }>;
  center: [number, number, number];
  radius: number;
  matrixBaked: boolean;
} | null {
  const item = host.visibility.items[idx];
  if (!item || !host.pvs) return null;
  const mesh = item.mesh;
  const geom = mesh.geometry;
  const pos = geom.attributes.position;
  const nrm = geom.attributes.normal;
  const cam = host.camera.position;
  const counts = new Map<number, number>();
  const nearVerts: Array<{ d: number; c: number }> = [];
  const v = new THREE.Vector3();
  let solid = 0;
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (nrm) v.addScaledVector(new THREE.Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i)), 4);
    v.applyMatrix4(mesh.matrixWorld);
    const c = host.pvs.getClusterAt({ x: v.x, y: v.y, z: v.z });
    if (c < 0) solid++;
    else counts.set(c, (counts.get(c) ?? 0) + 1);
    const d = v.distanceTo(cam);
    if (d <= nearHU) nearVerts.push({ d: Math.round(d), c });
  }
  const clusters = [...counts.entries()].map(([c, n]) => ({ c, n })).sort((a, b) => b.n - a.n).slice(0, 12);
  nearVerts.sort((a, b) => a.d - b.d);
  const m = mesh.matrixWorld.elements;
  const matrixBaked = m[12] === 0 && m[13] === 0 && m[14] === 0 && m[0] === 1 && m[5] === 1 && m[10] === 1;
  return {
    name: mesh.name || '(anon)',
    tris: pos.count / 3,
    verts: pos.count,
    solid,
    clusters,
    nearVerts: nearVerts.slice(0, 16),
    center: [item.center.x, item.center.y, item.center.z].map(Math.round) as [number, number, number],
    radius: Math.round(item.radius),
    matrixBaked,
  };
}

export function probeChunkByName(host: ChunkDiagnosticsHost, name: string): { name: string; found: number; d: number; r: number; clusters: number; pvsVisible: boolean | null; visible: boolean; tris: number; collider: boolean } | null {
  const key = name.trim();
  for (const item of host.visibility.items) {
    const n = item.mesh.name || '';
    if (n !== key) continue;
    const g = item.mesh.geometry as THREE.BufferGeometry | undefined;
    const tris = g?.index ? g.index.count / 3 : (g?.getAttribute('position')?.count ?? 0) / 3;
    return {
      name: n,
      found: 1,
      d: Math.round(item.center.distanceTo(host.camera.position)),
      r: Math.round(item.radius),
      clusters: item.clusterIds.length,
      pvsVisible: item.clusterIds.length === 0 ? null : item.clusterIds.some((c) => host.pvs?.isVisible(c) ?? false),
      visible: item.mesh.visible,
      tris: Math.round(tris),
      collider: false,
    };
  }
  return null;
}

/** 诊断：主根内「当前被绘制」的块按距离分桶（判断 PVS 是否把很远的东西也留着）。 */
export function drawnChunkStats(host: ChunkDiagnosticsHost): { drawn: number; buckets: Record<string, number>; far: string[] } {
  const p = host.camera.position;
  const v = new THREE.Vector3();
  const buckets: Record<string, number> = { '0-2k': 0, '2-5k': 0, '5-10k': 0, '10-20k': 0, '>20k': 0 };
  const far: string[] = [];
  let drawn = 0;
  if (!host.root) return { drawn, buckets, far };
  host.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    drawn++;
    const g = m.geometry as THREE.BufferGeometry | undefined;
    if (!g) return;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const bs = g.boundingSphere;
    if (!bs) return;
    // 合并块的几何已烘焙世界坐标、mesh 自身矩阵通常是单位阵 ⇒ 必须用包围球心，不能取 matrixWorld 平移。
    v.copy(bs.center).applyMatrix4(m.matrixWorld);
    const d = v.distanceTo(p);
    if (d < 2000) buckets['0-2k']++;
    else if (d < 5000) buckets['2-5k']++;
    else if (d < 10000) buckets['5-10k']++;
    else if (d < 20000) buckets['10-20k']++;
    else {
      buckets['>20k']++;
      if (far.length < 5) far.push(`${m.name || '(anon)'}@${Math.round(d)}`);
    }
  });
  return { drawn, buckets, far };
}

/** 可见性统计（形状与 debug 的 `LodStats` 兼容）。 */
