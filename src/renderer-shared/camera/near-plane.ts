/**
 * 近平面贴墙自适应控制器：防贴墙时 near 裁掉墙面、透视看到地图外。
 *
 * 2026-10-02 自 apps/game/src/renderer/renderer-main.ts 的 updateNearPlane 私有方法与（现居渲染共享层，
 * game 经 tsconfig include 收编）nearProbeDist / nearRatio / defaultNear 字段及五个复用探测对象原样抽出（逻辑零改动；
 * camera / scene 由调用方每次传入，不再读渲染器类字段）。由 renderer-main 的 `tick`
 * 每 2 帧调用一次 `update`（节流开关留在调用方）。
 */
import * as THREE from 'three';

/** near 允许的硬下限（仅在贴脸 < 1.5 HU 时才可能触底；保持 24-bit 深度精度）。 */
const CAMERA_NEAR_MIN = 0.5;
/** 场景默认 near 上限（与起源 DEFAULT_NEARZ=7 同量级，防大图 defaultNear 过大导致穿墙）。 */
const CAMERA_DEFAULT_NEAR_MAX = 8;
/** 探测距离默认值（HU）：`update` 探测半径上限与包围球粗筛半径都由它推出。 */
const NEAR_PROBE_DIST_DEFAULT = 200;
/** near 收缩系数默认值：0 = 按视锥角安全公式自适应收缩（防穿墙且保留最高深度精度）。 */
const NEAR_RATIO_DEFAULT = 0;
/**
 * 滞回：相机移动小于该距离（HU）且朝向变化小于阈值时复用上一次探测结果。
 *
 * **必须很小**：near 按探测时的距离留出视锥安全余量；之后相机再靠近 Δ 而没重探，
 * 若 Δ 超过余量墙就会被近平面切掉——因此余量与滞回半径联动钳制。
 */
const NEAR_STICKY_DIST = 2;
/** 滞回：朝向点积阈值（≈0.26°）。 */
const NEAR_STICKY_DOT = 0.99999;

/**
 * 透视相机近平面四角点到相机原点的距离倍率 `k = ||corner|| / near`：
 * 近平面是矩形而非球面，四角点距离相机 `near * sqrt(1 + tan²(fov/2) * (1 + aspect²))`
 * （73.6° 16:9 约 1.83×，90° 约 2.27×，110° 约 3.08×）。必须按 `minD / k` 收缩才不会切角穿墙。
 */
function frustumCornerFactor(camera: THREE.PerspectiveCamera): number {
  const fov = Number.isFinite(camera.fov) ? Math.min(Math.max(camera.fov, 1), 175) : 75;
  const zoom = Number.isFinite(camera.zoom) && camera.zoom > 1e-4 ? camera.zoom : 1;
  const aspect = Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : 1;
  const tanHalfV = Math.tan((fov * Math.PI) / 360) / zoom;
  return Math.sqrt(1 + tanHalfV * tanHalfV * (1 + aspect * aspect));
}

/**
 * 点到三角形最近距离的平方（Ericson《Real-Time Collision Detection》§5.1.5 的区域判据）。
 *
 * 为什么不再是射线：`camera.near` 是**球**语义——比 near 更近的所有东西都会被近平面裁掉，
 * 与它在视野的哪个方向无关。四向射线只能覆盖 ±forward / ±right 四条线，贴墙时若墙面与视线
 * 成 45°，100 HU 的射线要走 141 HU 才碰到墙 ⇒ 探不到，near 停在默认值（本图 32.65），
 * 眼前 20 HU 的墙就被裁开一个洞——这就是「视角穿透面」。最近表面距离对方向不敏感。
 */
function pointTriangleDist2(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = apx - v * abx, qy = apy - v * aby, qz = apz - v * abz;
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = apx - w * acx, qy = apy - w * acy, qz = apz - w * acz;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const qx = bpx - w * (cx - bx), qy = bpy - w * (cy - by), qz = bpz - w * (cz - bz);
    return qx * qx + qy * qy + qz * qz;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const qx = apx - v * abx - w * acx;
  const qy = apy - v * aby - w * acy;
  const qz = apz - v * abz - w * acz;
  return qx * qx + qy * qy + qz * qz;
}

/** `update` 的可选参数：`roots` 给出候选收集的根子树（省略时按 game 口径取 `scene.children` 里带 `isBspModel` 标记的根）。`vertical` 已无意义（探测改成最近表面距离后天然覆盖上下），保留字段只为三端调用点不改。 */
export interface NearPlaneOptions {
  roots?: THREE.Object3D[];
  vertical?: boolean;
}

/** 三角形数量少于这个值的块不值得建网格（线性扫更快）。 */
const NEAR_GRID_MIN_TRIS = 512;

/** `probeChunk` 用的块级三角形空间网格（局部空间，见 `triGridOf`）。 */
interface TriGrid {
  id: string;
  minX: number;
  minY: number;
  minZ: number;
  csx: number;
  csy: number;
  csz: number;
  nx: number;
  ny: number;
  nz: number;
  /** 每格在 `items` 里的起始下标（长度 cells+1，前缀和）。 */
  start: Int32Array;
  items: Int32Array;
  /** 跨格太多的大三角形（每次探测都扫）。 */
  big: Int32Array;
}

export class NearPlaneController {
  /** 探测距离（HU，`setParams` 可改；面板「近平面探测距离」量程 16..128）。 */
  private nearProbeDist = NEAR_PROBE_DIST_DEFAULT;
  /** near 收缩系数（`setParams` 可改，只接受 (0, 1]；面板量程 0.1..1）。 */
  private nearRatio = NEAR_RATIO_DEFAULT;
  /** 场景默认 near（`setDefaultNear` 由 loadScene 按 maxDim/1000 落账）；探测无命中时恢复它。 */
  private defaultNear = 0.1;
  /** 复用的探测对象（避免每帧分配）：射线起点、相机前/右方向、raycaster。 */
  private readonly _nearOrigin = new THREE.Vector3();
  private readonly _nearDirF = new THREE.Vector3();
  private readonly _nearDirR = new THREE.Vector3();
  private readonly _nearRaycaster = new THREE.Raycaster();
  private readonly _nearInv = new THREE.Matrix4();
  private readonly _nearOriginL = new THREE.Vector3();
  private readonly _nearInstMat = new THREE.Matrix4();
  private readonly _nearInstWorld = new THREE.Matrix4();
  private readonly _nearInstBox = new THREE.Box3();
  /** 上一次探测时的相机位置/朝向/探测距离（用于「几乎没动就复用」的滞回，见 update 第 0 步）。 */
  private readonly _nearLastOrigin = new THREE.Vector3(NaN, NaN, NaN);
  private readonly _nearLastDir = new THREE.Vector3();
  private _nearHaveLast = false;
  private _nearLastProbe = NaN;
  private _nearLastK = NaN;
  private _nearLastStickyDist = NEAR_STICKY_DIST;
  /** 上一次探测是否退回六向射线（只有射线路径才受相机朝向影响；球距离路径与朝向无关）。 */
  private _nearUsedRayFallback = false;
  /** 最近一次 `probeChunk` 实际测试的三角形计数（诊断用）。 */
  private _nearTestedTris = 0;

  /**
   * 块级世界 AABB 缓存（挂在 `mesh.userData.__nearBox`，按 geometry.uuid 与 matrixWorld 失效）。
   *
   * 为什么：合并后每块覆盖半张图，包围球粗筛（`probe*2 + radius`，radius 已被 1.6× 垫过）
   * 几乎筛不掉任何块，于是每条射线都对整块合并几何做逐三角形求交——实测占全帧 16%~46%。
   * AABB 到起点的距离是几何距离的**下界**：距离 > probe 的块不可能有 ≤probe 的命中，
   * 所以这层筛选**不改变结果**，只把三角形级工作限制到真正贴脸的块；同时比对 `matrixWorld`，
   * 避免移动/旋转实体（门/平台）一直命中出生点的旧 AABB。
   */
  private worldBoxOf(mesh: THREE.Mesh): THREE.Box3 | null {
    const geom = mesh.geometry as THREE.BufferGeometry | null;
    if (!geom) return null;
    let bb: THREE.Box3 | null;
    if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) {
      const inst = mesh as THREE.InstancedMesh;
      if (!inst.boundingBox) inst.computeBoundingBox();
      bb = inst.boundingBox;
    } else {
      if (!geom.boundingBox) geom.computeBoundingBox();
      bb = geom.boundingBox;
    }
    if (!bb) return null;
    const me = mesh.matrixWorld.elements;
    const cached = mesh.userData.__nearBox as { id: string; box: THREE.Box3; mat: Float64Array } | undefined;
    if (cached && cached.id === geom.uuid) {
      const cm = cached.mat;
      let same = true;
      for (let i = 0; i < 16; i++) {
        if (cm[i] !== me[i]) {
          same = false;
          break;
        }
      }
      if (same) return cached.box;
      for (let i = 0; i < 16; i++) cm[i] = me[i];
      cached.box.copy(bb).applyMatrix4(mesh.matrixWorld);
      return cached.box;
    }
    const box = bb.clone().applyMatrix4(mesh.matrixWorld);
    const mat = new Float64Array(me);
    mesh.userData.__nearBox = { id: geom.uuid, box, mat };
    return box;
  }

  /**
   * 块级三角形空间网格（局部空间），挂在 `mesh.userData.__nearGrid`，按 geometry.uuid 失效。
   *
   * 为什么：`probeChunk` 原本每次探测都把整块三角形扫一遍（合并块常在 1~3 万面），
   * CPU profile 里 `probeChunk` + `getVertexPosition` + `intersectTriangle` 合计约占主线程 12%。
   * 三角形在块内分布稀疏，而探测球半径只有 `probe`（默认 100 HU）⇒ 用网格把候选三角形
   * 收窄到「球覆盖的格子 + 邻格 + 少量大三角形」，结果与全扫**完全等价**（后面仍做精确
   * 点到三角形距离），只是少了十几万次 AABB 比较。
   */
  private triGridOf(mesh: THREE.Mesh, geom: THREE.BufferGeometry, pos: THREE.BufferAttribute, idx: ArrayLike<number> | undefined, triCount: number): TriGrid | null {
    if (triCount < NEAR_GRID_MIN_TRIS) return null;
    const cached = mesh.userData.__nearGrid as (TriGrid & { id: string }) | undefined;
    if (cached && cached.id === geom.uuid) return cached;
    if (!geom.boundingBox) geom.computeBoundingBox();
    const bb = geom.boundingBox;
    if (!bb) return null;
    const lenX = Math.max(bb.max.x - bb.min.x, 1e-3);
    const lenY = Math.max(bb.max.y - bb.min.y, 1e-3);
    const lenZ = Math.max(bb.max.z - bb.min.z, 1e-3);
    // 目标「每格约 1 个三角形」；单轴格数封顶 64，避免超长块产生百万格。
    const ideal = Math.cbrt((lenX * lenY * lenZ) / triCount) * 1.4;
    const cellSize = Math.min(Math.max(ideal, 4), Math.max(lenX, lenY, lenZ) / 4);
    const nx = Math.min(64, Math.max(1, Math.ceil(lenX / cellSize)));
    const ny = Math.min(64, Math.max(1, Math.ceil(lenY / cellSize)));
    const nz = Math.min(64, Math.max(1, Math.ceil(lenZ / cellSize)));
    const csx = lenX / nx;
    const csy = lenY / ny;
    const csz = lenZ / nz;
    const arr = pos.array as ArrayLike<number>;
    const cellCount = nx * ny * nz;
    const counts = new Int32Array(cellCount + 1);
    const bigIdx: number[] = [];
    const forEachCell = (t: number, visit: (cell: number) => void): void => {
      const i0 = idx ? idx[t * 3] : t * 3;
      const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
      const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const ax = arr[i0 * 3], ay = arr[i0 * 3 + 1], az = arr[i0 * 3 + 2];
      const bx = arr[i1 * 3], by = arr[i1 * 3 + 1], bz = arr[i1 * 3 + 2];
      const cx = arr[i2 * 3], cy = arr[i2 * 3 + 1], cz = arr[i2 * 3 + 2];
      const loX = Math.min(ax, bx, cx), hiX = Math.max(ax, bx, cx);
      const loY = Math.min(ay, by, cy), hiY = Math.max(ay, by, cy);
      const loZ = Math.min(az, bz, cz), hiZ = Math.max(az, bz, cz);
      const x0 = Math.max(0, Math.min(nx - 1, Math.floor((loX - bb.min.x) / csx)));
      const x1 = Math.max(0, Math.min(nx - 1, Math.floor((hiX - bb.min.x) / csx)));
      const y0 = Math.max(0, Math.min(ny - 1, Math.floor((loY - bb.min.y) / csy)));
      const y1 = Math.max(0, Math.min(ny - 1, Math.floor((hiY - bb.min.y) / csy)));
      const z0 = Math.max(0, Math.min(nz - 1, Math.floor((loZ - bb.min.z) / csz)));
      const z1 = Math.max(0, Math.min(nz - 1, Math.floor((hiZ - bb.min.z) / csz)));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 27) {
        // 跨太多格的大三角形（水面/贴墙大面）：单独登记，每次探测都扫，避免漏
        bigIdx.push(t);
        return;
      }
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          const row = (z * ny + y) * nx;
          for (let x = x0; x <= x1; x++) visit(row + x);
        }
      }
    };
    for (let t = 0; t < triCount; t++) forEachCell(t, (cell) => counts[cell + 1]++);
    for (let c = 0; c < cellCount; c++) counts[c + 1] += counts[c];
    const startOffset = Int32Array.from(counts);
    const fillCursor = Int32Array.from(counts);
    const items = new Int32Array(counts[cellCount]);
    for (let t = 0; t < triCount; t++) forEachCell(t, (cell) => { items[fillCursor[cell]++] = t; });
    const grid = {
      id: geom.uuid,
      minX: bb.min.x,
      minY: bb.min.y,
      minZ: bb.min.z,
      csx,
      csy,
      csz,
      nx,
      ny,
      nz,
      start: startOffset,
      items,
      big: Int32Array.from(bigIdx),
    };
    mesh.userData.__nearGrid = grid;
    return grid;
  }

  /**
   * 逐块探测：先按三角形 AABB 把「离探测球 probe 之外」的面丢掉，再对剩下的几十个面求
   * **点到三角形最近距离**，返回最近表面距离（无命中为 `Infinity`；非等比缩放返回 `NaN` 由调用方回退）。
   *
   * 为什么不用 `Raycaster.intersectObjects`：它会对传入 mesh 的**全部**三角形求交。合并块常在
   * 数万面量级，而相机又经常落在块的 AABB 内部（块级粗筛失效）⇒ 4 条射线 × 数块，实测在
   * 「人一动」的帧上出现 10~15 ms 尖峰（静止帧每帧只有 3 ms，看到的就是掉帧）。
   */
  private probeChunk(mesh: THREE.Mesh, probe: number, stopDist: number): number {
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return Infinity;
    if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) {
      const inst = mesh as THREE.InstancedMesh;
      if (!geom.boundingBox) geom.computeBoundingBox();
      const lbb = geom.boundingBox;
      const ox = this._nearOrigin.x;
      const oy = this._nearOrigin.y;
      const oz = this._nearOrigin.z;
      const probeSq = probe * probe;
      let best = Infinity;
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, this._nearInstMat);
        this._nearInstWorld.multiplyMatrices(mesh.matrixWorld, this._nearInstMat);
        if (lbb) {
          this._nearInstBox.copy(lbb).applyMatrix4(this._nearInstWorld);
          const b = this._nearInstBox;
          const dx = ox < b.min.x ? b.min.x - ox : ox > b.max.x ? ox - b.max.x : 0;
          const dy = oy < b.min.y ? b.min.y - oy : oy > b.max.y ? oy - b.max.y : 0;
          const dz = oz < b.min.z ? b.min.z - oz : oz > b.max.z ? oz - b.max.z : 0;
          if (dx * dx + dy * dy + dz * dz > probeSq) continue;
        }
        const d = this.probeChunkWithMatrix(mesh, geom, pos, this._nearInstWorld, Math.min(probe, best), stopDist);
        if (Number.isNaN(d)) return NaN;
        if (d < best) {
          best = d;
          if (stopDist > 0 && best <= stopDist) return best;
        }
      }
      return best;
    }
    return this.probeChunkWithMatrix(mesh, geom, pos, mesh.matrixWorld, probe, stopDist);
  }

  private probeChunkWithMatrix(
    mesh: THREE.Mesh,
    geom: THREE.BufferGeometry,
    pos: THREE.BufferAttribute,
    m: THREE.Matrix4,
    probe: number,
    stopDist: number,
  ): number {
    const e = m.elements;
    // 用 3 个基向量的长度平方与正交点积判定等比正交变换（支持任意旋转的实体/模型）
    const sx2 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
    const sy2 = e[4] * e[4] + e[5] * e[5] + e[6] * e[6];
    const sz2 = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
    const tol = sx2 * 1e-3 + 1e-6;
    const d01 = e[0] * e[4] + e[1] * e[5] + e[2] * e[6];
    const d02 = e[0] * e[8] + e[1] * e[9] + e[2] * e[10];
    const d12 = e[4] * e[8] + e[5] * e[9] + e[6] * e[10];
    if (
      sx2 < 1e-12 ||
      Math.abs(sy2 - sx2) > tol ||
      Math.abs(sz2 - sx2) > tol ||
      Math.abs(d01) > tol ||
      Math.abs(d02) > tol ||
      Math.abs(d12) > tol
    ) {
      return NaN;
    }
    const s = Math.sqrt(sx2);
    const inv = this._nearInv.copy(m).invert();
    const oL = this._nearOriginL.copy(this._nearOrigin).applyMatrix4(inv);
    const localProbe = probe / s;
    const localStopSq = stopDist > 0 ? (stopDist / s) * (stopDist / s) : -1;
    const ox = oL.x;
    const oy = oL.y;
    const oz = oL.z;
    const idx = geom.index?.array as ArrayLike<number> | undefined;
    const triCount = idx ? idx.length / 3 : pos.count / 3;
    const arr = pos.array as ArrayLike<number>;
    let bestSq = Infinity;
    let reach = localProbe * localProbe;
    let tested = 0;
    const testTri = (t: number): boolean => {
      const i0 = idx ? idx[t * 3] : t * 3;
      const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
      const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const ax = arr[i0 * 3], ay = arr[i0 * 3 + 1], az = arr[i0 * 3 + 2];
      const bx = arr[i1 * 3], by = arr[i1 * 3 + 1], bz = arr[i1 * 3 + 2];
      const cx = arr[i2 * 3], cy = arr[i2 * 3 + 1], cz = arr[i2 * 3 + 2];
      // 三角形 AABB 到球心的平方距离（分量钳制）——球外 ⇒ 最近表面距离必然 > current reach，丢掉
      const loX = ax < bx ? (ax < cx ? ax : cx) : bx < cx ? bx : cx;
      const hiX = ax > bx ? (ax > cx ? ax : cx) : bx > cx ? bx : cx;
      const loY = ay < by ? (ay < cy ? ay : cy) : by < cy ? by : cy;
      const hiY = ay > by ? (ay > cy ? ay : cy) : by > cy ? by : cy;
      const loZ = az < bz ? (az < cz ? az : cz) : bz < cz ? bz : cz;
      const hiZ = az > bz ? (az > cz ? az : cz) : bz > cz ? bz : cz;
      const dx = ox < loX ? loX - ox : ox > hiX ? ox - hiX : 0;
      const dy = oy < loY ? loY - oy : oy > hiY ? oy - hiY : 0;
      const dz = oz < loZ ? loZ - oz : oz > hiZ ? oz - hiZ : 0;
      if (dx * dx + dy * dy + dz * dz > reach) return false;
      tested++;
      const d2 = pointTriangleDist2(ox, oy, oz, ax, ay, az, bx, by, bz, cx, cy, cz);
      if (d2 < bestSq) {
        bestSq = d2;
        if (d2 < reach) reach = d2;
        if (localStopSq > 0 && d2 <= localStopSq) return true;
      }
      return false;
    };
    const grid = this.triGridOf(mesh, geom, pos, idx, triCount);
    if (grid) {
      // 球覆盖的格子再往外扩 1 格：三角形按「自身 AABB 覆盖的格子」登记，扩一格保证不漏边界。
      const gx0 = Math.max(0, Math.floor((ox - localProbe - grid.minX) / grid.csx) - 1);
      const gx1 = Math.min(grid.nx - 1, Math.floor((ox + localProbe - grid.minX) / grid.csx) + 1);
      const gy0 = Math.max(0, Math.floor((oy - localProbe - grid.minY) / grid.csy) - 1);
      const gy1 = Math.min(grid.ny - 1, Math.floor((oy + localProbe - grid.minY) / grid.csy) + 1);
      const gz0 = Math.max(0, Math.floor((oz - localProbe - grid.minZ) / grid.csz) - 1);
      const gz1 = Math.min(grid.nz - 1, Math.floor((oz + localProbe - grid.minZ) / grid.csz) + 1);
      if (gx0 <= gx1 && gy0 <= gy1 && gz0 <= gz1) {
        outer: for (let z = gz0; z <= gz1; z++) {
          for (let y = gy0; y <= gy1; y++) {
            const row = (z * grid.ny + y) * grid.nx;
            const from = grid.start[row + gx0];
            const to = grid.start[row + gx1 + 1];
            for (let k = from; k < to; k++) {
              if (testTri(grid.items[k])) break outer;
            }
          }
        }
      }
      if (!(localStopSq > 0 && bestSq <= localStopSq)) {
        const big = grid.big;
        for (let k = 0; k < big.length; k++) {
          if (testTri(big[k])) break;
        }
      }
    } else {
      for (let t = 0; t < triCount; t++) {
        if (testTri(t)) break;
      }
    }
    this._nearTestedTris += tested;
    return bestSq === Infinity ? Infinity : Math.sqrt(bestSq) * s;
  }

  /** 场景默认 near：clamp(maxDim/1000, CAMERA_NEAR_MIN, CAMERA_DEFAULT_NEAR_MAX)。 */
  static defaultNearForScene(maxDim: number): number {
    return Math.min(Math.max(maxDim / 1000, CAMERA_NEAR_MIN), CAMERA_DEFAULT_NEAR_MAX);
  }

  /** 落账场景默认 near（探测无命中时 `update` 恢复到它）。 */
  setDefaultNear(v: number): void {
    this.defaultNear = v;
    this._nearHaveLast = false;
  }

  /** 动态实体发生位移/旋转时清空滞回缓存，避免相机静止时被移动门/平台穿墙。 */
  invalidateCache(): void {
    this._nearHaveLast = false;
  }

  /**
   * 预建块级三角形空间网格（`triGridOf` 的缓存），返回本次真正新建的块数。
   *
   * 为什么：网格是**首次探测时懒建**的，整图所有合并块建一遍实测 ~58ms。冷启动首飞第一帧
   * 正是第一次探测（`tick` 每 2 帧一次、`updateNearPlane` 在物理就绪后才开），这笔开销就落在
   * 首飞那一帧上：`.tmp/perf/ph3` 实测 near 段 57.66ms、整帧 64.91ms（program 数没变 ⇒ 不是
   * 着色器编译）。载图期先建好，把一次性成本挪进载图（相对 8.7s 载图可忽略）。
   *
   * 幂等：已建过的块按 `geometry.uuid` 命中缓存，第二次调用返回 0。
   */
  prewarmGrids(root: THREE.Object3D | null): number {
    if (!root) return 0;
    let built = 0;
    root.traverse((obj) => {
      // 预热是「锦上添花」：任何一块的几何异常都不该让载图失败，单块失败就跳过
      // （那一块的网格退化成首次探测时全扫，行为与未预热一致）。
      try {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const geom = mesh.geometry as THREE.BufferGeometry;
        const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (!pos) return;
        const idx = geom.index?.array as ArrayLike<number> | undefined;
        const triCount = idx ? idx.length / 3 : pos.count / 3;
        const before = mesh.userData.__nearGrid;
        if (this.triGridOf(mesh, geom, pos, idx, triCount) && mesh.userData.__nearGrid !== before) built++;
      } catch {
        /* 单块跳过 */
      }
    });
    return built;
  }

  /** 面板实时调整探测距离与收缩系数：probeDist 夹到 [100, 300]，ratio 接受 [0, 1]；
   *  任一变更会清掉滞回缓存使滑块拖动立即生效。 */
  setParams(probeDist?: number, ratio?: number): void {
    let changed = false;
    if (probeDist !== undefined && Number.isFinite(probeDist) && probeDist > 0) {
      this.nearProbeDist = Math.min(300, Math.max(100, probeDist));
      changed = true;
    }
    if (ratio !== undefined && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) {
      this.nearRatio = ratio;
      changed = true;
    }
    if (changed) {
      this._nearHaveLast = false;
    }
  }

  /**
   * 近平面自适应：在有效探测球内求最近 BSP/实体表面距离 `minD`，
   * 按视锥四角安全倍率 `k = ||corner|| / near` 收缩 `camera.near`，既防贴墙/斜角穿面，
   * 又保留尽可能大的 `near` 以维持 24-bit 深度缓冲精度（避免远距 Z-Fighting）。
   */
  update(camera: THREE.PerspectiveCamera | null, scene: THREE.Object3D | null, px: number, py: number, pz: number, opts?: NearPlaneOptions): void {
    if (!camera || !scene) return;
    const k = frustumCornerFactor(camera);
    // 数学上只有距离 <= needRadius 的面才可能使 target < defaultNear，收窄搜索半径可省大量三角测试
    const safeNeed = this.defaultNear * k + NEAR_STICKY_DIST + 1;
    const needRadius = this.nearRatio > 0 ? Math.max(safeNeed, this.defaultNear / this.nearRatio) : safeNeed;
    const probe = Math.min(this.nearProbeDist, needRadius);
    this._nearOrigin.set(px, py, pz);

    // 0. 滞回：位置/FOV/探测半径几乎没变就复用上一次的 near。
    //    最近表面距离是纯球语义、与视角朝向无关；只有上次退回射线路径时才额外校验朝向。
    const dirNow = this._nearDirF.set(0, 0, -1).applyQuaternion(camera.quaternion);
    if (
      this._nearHaveLast &&
      this._nearLastProbe === probe &&
      Math.abs(this._nearLastK - k) <= 1e-4 &&
      this._nearOrigin.distanceToSquared(this._nearLastOrigin) < this._nearLastStickyDist * this._nearLastStickyDist &&
      (!this._nearUsedRayFallback || dirNow.dot(this._nearLastDir) > NEAR_STICKY_DOT)
    ) {
      return;
    }
    this._nearLastOrigin.copy(this._nearOrigin);
    this._nearLastDir.copy(dirNow);
    this._nearHaveLast = true;
    this._nearLastProbe = probe;
    this._nearLastK = k;
    this._nearUsedRayFallback = false;
    this._nearTestedTris = 0;

    // 1. 块级 AABB 粗筛：跳过不可见子树（隐藏的动态实体组），并按块世界 AABB 过滤 > probe 的块。
    const candidates: THREE.Mesh[] = [];
    const collectRoots = opts?.roots ?? Array.from(scene.children).filter((r) => r.userData?.isBspModel);
    const visit = (obj: THREE.Object3D): void => {
      if (!obj.visible) return;
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const box = this.worldBoxOf(mesh);
        if (box && box.distanceToPoint(this._nearOrigin) <= probe) {
          candidates.push(mesh);
        }
      }
      const children = obj.children;
      for (let i = 0; i < children.length; i++) {
        visit(children[i]);
      }
    };
    for (const root of collectRoots) {
      visit(root);
    }

    // 2. 逐块求「最近表面距离」并单调收紧上界：一旦发现更近的面，后续块只需扫 minD 以内；
    //    若已近到足以把 near 压到 CAMERA_NEAR_MIN，立即提前结束。
    const floorStopDist = CAMERA_NEAR_MIN * k;
    let minD = Infinity;
    if (candidates.length > 0) {
      for (const mesh of candidates) {
        const limit = Math.min(probe, minD);
        const box = this.worldBoxOf(mesh);
        if (!box || box.distanceToPoint(this._nearOrigin) > limit) continue;
        const d = this.probeChunk(mesh, limit, floorStopDist);
        if (Number.isNaN(d)) {
          this._nearUsedRayFallback = true;
          // 非等比缩放的块（极少）：退回 three 的 Raycaster，用六向射线兜底
          const q = camera.quaternion;
          const fwd = this._nearDirF.set(0, 0, -1).applyQuaternion(q);
          const right = this._nearDirR.set(1, 0, 0).applyQuaternion(q);
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
          const dirs = [fwd, fwd.clone().negate(), right.clone(), right.clone().negate(), up, up.clone().negate()];
          for (const dir of dirs) {
            this._nearRaycaster.set(this._nearOrigin, dir);
            this._nearRaycaster.near = 0;
            this._nearRaycaster.far = limit;
            const hits = this._nearRaycaster.intersectObject(mesh, false);
            if (hits.length > 0 && hits[0].distance < minD) minD = hits[0].distance;
          }
        } else if (d < minD) {
          minD = d;
        }
        if (minD <= floorStopDist) break;
      }
    }

    // 3. 设定 near：按视锥角距离 `k` 留出滞回余量，既保证四角点不到墙面，又避免无谓压低 near。
    let target: number;
    if (isFinite(minD)) {
      const margin = Math.min(NEAR_STICKY_DIST, minD * 0.25);
      const geoSafe = (minD - margin) / k;
      const rawTarget = this.nearRatio === 0 ? geoSafe : Math.min(minD * this.nearRatio, geoSafe);
      target = Math.min(Math.max(rawTarget, CAMERA_NEAR_MIN), this.defaultNear);
      this._nearLastStickyDist = Math.max(0.25, Math.min(NEAR_STICKY_DIST, margin));
    } else {
      target = this.defaultNear;
      this._nearLastStickyDist = NEAR_STICKY_DIST;
    }
    if (Math.abs(camera.near - target) > 0.001) {
      camera.near = target;
      camera.updateProjectionMatrix();
    }
    // 诊断：最近命中距离 / 候选块数 / 本次 near / 视锥角倍率
    (globalThis as unknown as { __vbspNearStats?: unknown }).__vbspNearStats = {
      minD: isFinite(minD) ? +minD.toFixed(2) : null,
      candidates: candidates.length,
      tris: this._nearTestedTris,
      near: +camera.near.toFixed(3),
      probe: +probe.toFixed(1),
      k: +k.toFixed(3),
    };
  }
}
