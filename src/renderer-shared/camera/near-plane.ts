/**
 * 近平面贴墙自适应控制器：防贴墙时 near 裁掉墙面、透视看到地图外。
 *
 * 2026-10-02 自 apps/game/src/renderer/renderer-main.ts 的 updateNearPlane 私有方法与（现居渲染共享层，
 * game 经 tsconfig include 收编）nearProbeDist / nearRatio / defaultNear 字段及五个复用探测对象原样抽出（逻辑零改动；
 * camera / scene 由调用方每次传入，不再读渲染器类字段）。由 renderer-main 的 `tick`
 * 每 2 帧调用一次 `update`（节流开关留在调用方）。
 */
import * as THREE from 'three';

/** near 允许的最小值（收缩与默认值都不得低于它）。 */
const CAMERA_NEAR_MIN = 0.05;
/** 探测距离默认值（HU）：`update` 的射线长度上限与包围球粗筛半径都由它推出。 */
const NEAR_PROBE_DIST_DEFAULT = 200;
/** near 收缩系数默认值：命中几何时 near = 命中距离 × 本值（0 表示直接贴到 CAMERA_NEAR_MIN）。 */
const NEAR_RATIO_DEFAULT = 0;
/**
 * 滞回：相机移动小于该距离（HU）且朝向变化小于阈值时复用上一次探测结果。
 *
 * **必须很小**：near 按探测时的距离 d 取 0.3d；之后相机再靠近 Δ 而没重探，墙就在 d−Δ 处，
 * 只要 `0.3d > d−Δ`（即 `d < 1.43Δ`）墙就会被近平面切掉——这正是「边走边贴墙时突然看到墙背面」。
 * 取 2 HU（两帧步行的量级）时该窗口只剩 d < 2.9 HU，玩家碰撞半径进不去；早期取 16 HU 时
 * 窗口是 d < 22.9 HU，贴墙走就穿。
 */
const NEAR_STICKY_DIST = 2;
/** 滞回：朝向点积阈值（≈0.26°）。 */
const NEAR_STICKY_DOT = 0.99999;

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
  /** 三角形粗筛缓冲（每 9 个 float 一个三角形，网格局部空间），复用避免每次探测分配。 */
  private readonly _nearTris: number[] = [];
  private readonly _nearInv = new THREE.Matrix4();
  private readonly _nearOriginL = new THREE.Vector3();
  /** 上一次探测时的相机位置/朝向/探测距离（用于「几乎没动就复用」的滞回，见 update 第 0 步）。 */
  private readonly _nearLastOrigin = new THREE.Vector3(NaN, NaN, NaN);
  private readonly _nearLastDir = new THREE.Vector3();
  private _nearHaveLast = false;
  private _nearLastProbe = NaN;

  /**
   * 块级世界 AABB 缓存（挂在 `mesh.userData.__nearBox`，按 geometry.uuid 失效）。
   *
   * 为什么：合并后每块覆盖半张图，包围球粗筛（`probe*2 + radius`，radius 已被 1.6× 垫过）
   * 几乎筛不掉任何块，于是每条射线都对整块合并几何做逐三角形求交——实测占全帧 16%~46%。
   * AABB 到射起点的距离是几何距离的**下界**：距离 > probe 的块不可能有 ≤probe 的命中，
   * 所以这层筛选**不改变结果**，只把三角形级工作限制到真正贴脸的块。
   */
  private worldBoxOf(mesh: THREE.Mesh): THREE.Box3 | null {
    const geom = mesh.geometry as THREE.BufferGeometry | null;
    if (!geom) return null;
    if (!geom.boundingBox) geom.computeBoundingBox();
    const bb = geom.boundingBox;
    if (!bb) return null;
    const cached = mesh.userData.__nearBox as { id: string; box: THREE.Box3 } | undefined;
    if (cached && cached.id === geom.uuid) return cached.box;
    const box = bb.clone().applyMatrix4(mesh.matrixWorld);
    mesh.userData.__nearBox = { id: geom.uuid, box };
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
  private probeChunk(mesh: THREE.Mesh, probe: number): number {
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return Infinity;
    const m = mesh.matrixWorld;
    const e = m.elements;
    const s = Math.abs(e[0]);
    // 非等比缩放时「局部空间球」不成立，退回 Raycaster（场景里没有这种块，只是兜底）
    if (Math.abs(Math.abs(e[5]) - s) > 1e-3 || Math.abs(Math.abs(e[10]) - s) > 1e-3 || s < 1e-6) {
      return NaN;
    }
    const inv = this._nearInv.copy(m).invert();
    const oL = this._nearOriginL.copy(this._nearOrigin).applyMatrix4(inv);
    const localProbe = probe / s;
    const ox = oL.x;
    const oy = oL.y;
    const oz = oL.z;
    const idx = geom.index?.array as ArrayLike<number> | undefined;
    const triCount = idx ? idx.length / 3 : pos.count / 3;
    const arr = pos.array as ArrayLike<number>;
    const tris = this._nearTris;
    tris.length = 0;
    const reach = localProbe * localProbe;
    const pushTri = (t: number): void => {
      const i0 = idx ? idx[t * 3] : t * 3;
      const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
      const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const ax = arr[i0 * 3], ay = arr[i0 * 3 + 1], az = arr[i0 * 3 + 2];
      const bx = arr[i1 * 3], by = arr[i1 * 3 + 1], bz = arr[i1 * 3 + 2];
      const cx = arr[i2 * 3], cy = arr[i2 * 3 + 1], cz = arr[i2 * 3 + 2];
      // 三角形 AABB 到球心的平方距离（分量钳制）——球外 ⇒ 最近表面距离必然 > probe，丢掉
      const loX = ax < bx ? (ax < cx ? ax : cx) : bx < cx ? bx : cx;
      const hiX = ax > bx ? (ax > cx ? ax : cx) : bx > cx ? bx : cx;
      const loY = ay < by ? (ay < cy ? ay : cy) : by < cy ? by : cy;
      const hiY = ay > by ? (ay > cy ? ay : cy) : by > cy ? by : cy;
      const loZ = az < bz ? (az < cz ? az : cz) : bz < cz ? bz : cz;
      const hiZ = az > bz ? (az > cz ? az : cz) : bz > cz ? bz : cz;
      const dx = ox < loX ? loX - ox : ox > hiX ? ox - hiX : 0;
      const dy = oy < loY ? loY - oy : oy > hiY ? oy - hiY : 0;
      const dz = oz < loZ ? loZ - oz : oz > hiZ ? oz - hiZ : 0;
      if (dx * dx + dy * dy + dz * dz > reach) return;
      tris.push(ax, ay, az, bx, by, bz, cx, cy, cz);
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
        for (let z = gz0; z <= gz1; z++) {
          for (let y = gy0; y <= gy1; y++) {
            const row = (z * grid.ny + y) * grid.nx;
            const from = grid.start[row + gx0];
            const to = grid.start[row + gx1 + 1];
            for (let k = from; k < to; k++) pushTri(grid.items[k]);
          }
        }
      }
      const big = grid.big;
      for (let k = 0; k < big.length; k++) pushTri(big[k]);
    } else {
      for (let t = 0; t < triCount; t++) pushTri(t);
    }
    if (tris.length === 0) return Infinity;
    let bestSq = Infinity;
    const n = tris.length / 9;
    for (let k = 0; k < n; k++) {
      const o = k * 9;
      const d2 = pointTriangleDist2(
        ox, oy, oz,
        tris[o], tris[o + 1], tris[o + 2],
        tris[o + 3], tris[o + 4], tris[o + 5],
        tris[o + 6], tris[o + 7], tris[o + 8],
      );
      if (d2 < bestSq) bestSq = d2;
    }
    return bestSq === Infinity ? Infinity : Math.sqrt(bestSq) * s;
  }

  /** 场景默认 near：maxDim/1000，下限 CAMERA_NEAR_MIN（loadScene 算 near/far 用）。 */
  static defaultNearForScene(maxDim: number): number {
    return Math.max(maxDim / 1000, CAMERA_NEAR_MIN);
  }

  /** 落账场景默认 near（探测无命中时 `update` 恢复到它）。 */
  setDefaultNear(v: number): void {
    this.defaultNear = v;
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
   * 近平面自适应：以 (px, py, pz) 为射线起点，沿相机局部系的前/后/左/右四个水平方向在
   * `nearProbeDist` 内探测最近的 BSP mesh；命中则把 `camera.near` 收到
   * max(命中距离 × nearRatio, CAMERA_NEAR_MIN)，无命中恢复 `defaultNear`。
   * 粗筛：块级世界 AABB 到起点距离 > 探测距离的块直接跳过（合并块很大，旧的包围球粗筛筛不掉
   * 任何块 ⇒ 每条射线都对整块几何逐三角形求交，实测占全帧 16%~46%）。
   * 滞回：位置变动 < 16 HU 且朝向变化 < ~1.8° 时复用上一次结果（near 是缓变量）。
   * 只写 `camera.near`（变化超过 0.001 才更新投影矩阵）；由 `tick` 每 2 帧调用一次。
   */
  update(camera: THREE.PerspectiveCamera | null, scene: THREE.Object3D | null, px: number, py: number, pz: number, opts?: NearPlaneOptions): void {
    if (!camera || !scene) return;
    const probe = this.nearProbeDist;
    this._nearOrigin.set(px, py, pz);

    // 0. 滞回：位置/朝向/探测距离几乎没变就复用上一次的 near。
    //    逐三角形探测对合并块很贵（每块数万面），而 near 是缓变量；16 HU / 1.8° 的阈值
    //    在走动时大约每 3~7 帧才真正探一次，站立时完全不探。
    const dirNow = this._nearDirF.set(0, 0, -1).applyQuaternion(camera.quaternion);
    if (
      this._nearHaveLast &&
      this._nearLastProbe === probe &&
      this._nearOrigin.distanceToSquared(this._nearLastOrigin) < NEAR_STICKY_DIST * NEAR_STICKY_DIST &&
      dirNow.dot(this._nearLastDir) > NEAR_STICKY_DOT
    ) {
      return;
    }
    this._nearLastOrigin.copy(this._nearOrigin);
    this._nearLastDir.copy(dirNow);
    this._nearHaveLast = true;
    this._nearLastProbe = probe;

    // 1. 块级 AABB 粗筛：盒子到起点的距离 > 探测距离 ⇒ 该块不可能有 ≤probe 的命中，直接跳过。
    const candidates: THREE.Mesh[] = [];
    const collectRoots = opts?.roots ?? Array.from(scene.children).filter((r) => r.userData?.isBspModel);
    for (const root of collectRoots) {
      root.traverse((obj) => {
        if (!(obj as THREE.Mesh).isMesh) return;
        const mesh = obj as THREE.Mesh;
        if (!mesh.visible) return; // 已被距离/PVS 剔除的块不参与探测
        const box = this.worldBoxOf(mesh);
        if (!box) return;
        if (box.distanceToPoint(this._nearOrigin) > probe) return;
        candidates.push(mesh);
      });
    }

    // 2. 逐块求「最近表面距离」：near 是球语义（比 near 近的东西都会被裁掉，跟方向无关），
    //    所以探测的是距离而不是射线。贴墙斜站（墙与视线 45°）时四向射线要走 141 HU 才碰到，
    //    探不到就会让 near 停在默认 32.65，眼前 20 HU 的墙被裁开——「视角穿透面」的成因。
    let minD = Infinity;
    if (candidates.length > 0) {
      for (const mesh of candidates) {
        const d = this.probeChunk(mesh, probe);
        if (Number.isNaN(d)) {
          // 非等比缩放的块（极少）：退回 three 的 Raycaster，用六向射线兜底
          const q = camera.quaternion;
          const fwd = this._nearDirF.set(0, 0, -1).applyQuaternion(q);
          const right = this._nearDirR.set(1, 0, 0).applyQuaternion(q);
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
          const dirs = [fwd, fwd.clone().negate(), right.clone(), right.clone().negate(), up, up.clone().negate()];
          for (const dir of dirs) {
            this._nearRaycaster.set(this._nearOrigin, dir);
            this._nearRaycaster.near = 0;
            this._nearRaycaster.far = probe;
            const hits = this._nearRaycaster.intersectObject(mesh, false);
            if (hits.length > 0 && hits[0].distance < minD) minD = hits[0].distance;
          }
        } else if (d < minD) {
          minD = d;
        }
      }
    }

    // 3. 设定 near（贴墙收缩，空旷恢复默认）
    // 只允许**往下**收缩：最近表面距离可能远大于探测距离（大三角形的 AABB 擦到探测球、
    // 面本身在几百 HU 外），此时 minD×ratio 会超过 defaultNear，把眼前的几何裁掉 ⇒ 视角穿面。
    const target = isFinite(minD)
      ? Math.min(Math.max(minD * this.nearRatio, CAMERA_NEAR_MIN), this.defaultNear)
      : this.defaultNear;
    if (Math.abs(camera.near - target) > 0.001) {
      camera.near = target;
      camera.updateProjectionMatrix();
    }
    // 诊断（临时）：最近命中距离 / 候选块数 / 本次 near，供「移动掉帧」与贴墙收缩核对
    (globalThis as unknown as { __vbspNearStats?: unknown }).__vbspNearStats = {
      minD: isFinite(minD) ? +minD.toFixed(2) : null,
      candidates: candidates.length,
      tris: this._nearTris.length / 9,
      near: +camera.near.toFixed(3),
      probe,
    };
  }
}
