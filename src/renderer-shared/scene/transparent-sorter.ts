/**
 * 半透明块的每帧前后重排（T-P2-2c 从 render-session.ts 拆出；行为逐字节不变）。
 *
 * 为什么需要：合并后的块 `position` 都是 `(0,0,0)`，three 的半透明排序在
 * `groupOrder/renderOrder` 相同后按对象 z（这里全为 0）再按 id ⇒ **退化成创建顺序**。
 * surf_666 的模型容器里，玻璃块 id 比水面块小 ⇒ 玻璃先画、水后画；水的 alpha 随视角
 * 变化，就把玻璃“盖淡”甚至盖没（owner 2026-10-24 报的“玻璃板有时像消失”）。
 */
import * as THREE from 'three';

/** 半透明块逐三角形 PVS 剔除所需最小查询接口。 */
export interface TransparentPvsQuery {
  isVisible(clusterId: number): boolean;
  getClusterAt(pos: { x: number; y: number; z: number }): number;
}

/**
 * 半透明逐面排序的比较：距离大在前；距离相等时**下标小的在前**。
 *
 * 等价于旧实现 `order.sort((a, b) => dists[b] - dists[a])` 的稳定排序结果
 * （V8 的 Array#sort 稳定，等距元素保持插入顺序 = 三角形下标升序），
 * 但可以在复用的 Int32Array 上做归并，完全不分配。
 */
function isFaceBefore(dists: Float64Array, a: number, b: number): boolean {
  const da = dists[a];
  const db = dists[b];
  if (da > db) return true;
  if (da < db) return false;
  return a < b;
}

/** 主根里的半透明块 + 排序用的复用 scratch（原 RenderSession 字段，引用同一批对象）。 */
export class TransparentSorter {
  private chunks: THREE.Mesh[] = [];
  private readonly sortBox = new THREE.Box3();
  private readonly sortPoint = new THREE.Vector3();
  /** 上次半透明排序时的相机位置与可见集指纹；用于「没动就别排」。 */
  private readonly sortLastPos = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
  private sortLastHash = 0;
  private sortLastVisible = -1;
  /** 上次逐面排序时的相机位置；位置没动就不必重算三角形距离（转视角不改距离）。 */
  private readonly faceSortLastPos = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
  /** 上次排序时的相机 PVS cluster；跨房间换区时强制重排并更新逐面 PVS 剔除。 */
  private lastPvsCluster = -2;
  private readonly pvsTmpA = new THREE.Vector3();
  private readonly pvsTmpB = new THREE.Vector3();
  private readonly pvsTmpC = new THREE.Vector3();
  private readonly pvsTmpN = new THREE.Vector3();
  private readonly pvsTmpP = new THREE.Vector3();

  /** 当前收集到的半透明块数（诊断用）。 */
  get size(): number {
    return this.chunks.length;
  }

  /** 换图/卸载时清空（原 `disposeScene` 里的 `this.transparentChunks = []`）。 */
  clear(): void {
    this.chunks = [];
    this.lastPvsCluster = -2;
  }

  /**
   * 收集主根里的半透明块（原 `collectTransparentChunks`）。
   */
  collect(root: THREE.Object3D | null): void {
    this.chunks = [];
    root?.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (!mats.some((m) => m && m.transparent === true)) return;
      if (mesh.userData.__vbspTransparentBaseOrder === undefined) {
        mesh.userData.__vbspTransparentBaseOrder = mesh.renderOrder;
      }
      this.chunks.push(mesh);
    });
  }

  /**
   * 半透明网格内部的**逐三角形**前后排序（通用口径，不依赖材质/水面分组；原 `sortTransparentFaces`）。
   *
   * three 只能按 object 排 `renderOrder`；同一块里的重叠玻璃面仍会按索引顺序画。
   * 这里直接按三角形中心到相机的距离重写 index buffer（远→近），组内保持材质组
   * 边界不变；非索引几何先补一条顺序 index。来源位置用几何原生 position，不重采样。
   */
  private sortFaces(mesh: THREE.Mesh, camera: THREE.Camera, pvs: TransparentPvsQuery | null): void {
    const geom = mesh.geometry;
    const pos = geom.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos) return;
    type Tri = { a: number; b: number; c: number; group: number };
    type Cache = {
      positionCount: number;
      indexCount: number;
      /** `geom.groups.length` 快照（0 = 没有材质组，按单组处理）；变了就重建索引缓存。 */
      groupCount: number;
      tris: Tri[];
      dists: Float64Array;
      triClusters: Int32Array | null;
      prevIdx: Uint32Array | null;
      /** 复用 scratch（长度随三角形数固定），逐面排序每帧 0 分配。 */
      order: Int32Array;
      orderTmp: Int32Array;
      bucketCounts: Int32Array;
      bucketOffsets: Int32Array;
      bucketCursors: Int32Array;
      bucketSorted: Int32Array;
    };
    let cache = mesh.userData.__vbspFaceSort as Cache | undefined;
    let idx = geom.index;
    if (!idx) {
      const n = pos.count;
      const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) arr[i] = i;
      geom.setIndex(new THREE.BufferAttribute(arr, 1));
      idx = geom.index;
    }
    if (!idx) return;
    if (
      !cache ||
      cache.positionCount !== pos.count ||
      cache.indexCount !== idx.count ||
      cache.groupCount !== geom.groups.length
    ) {
      const groupsEmpty = geom.groups.length === 0;
      const groupCount = groupsEmpty ? 1 : geom.groups.length;
      const tris: Tri[] = [];
      for (let gi = 0; gi < groupCount; gi++) {
        const gStart = groupsEmpty ? 0 : geom.groups[gi].start;
        const gCount = groupsEmpty ? idx.count : geom.groups[gi].count;
        for (let i = gStart; i + 2 < gStart + gCount; i += 3) {
          tris.push({ a: idx.getX(i), b: idx.getX(i + 1), c: idx.getX(i + 2), group: gi });
        }
      }
      const triCount = tris.length;
      cache = {
        positionCount: pos.count,
        indexCount: idx.count,
        groupCount: groupsEmpty ? 0 : geom.groups.length,
        tris,
        dists: new Float64Array(triCount),
        triClusters: null,
        prevIdx: null,
        order: new Int32Array(triCount),
        orderTmp: new Int32Array(triCount),
        bucketCounts: new Int32Array(groupCount),
        bucketOffsets: new Int32Array(groupCount),
        bucketCursors: new Int32Array(groupCount),
        bucketSorted: new Int32Array(triCount),
      };
      mesh.userData.__vbspFaceSort = cache;
    }
    const c = cache;
    if (pvs && !c.triClusters) {
      const tc = new Int32Array(c.tris.length);
      const mw = mesh.matrixWorld;
      const va = this.pvsTmpA;
      const vb = this.pvsTmpB;
      const vc = this.pvsTmpC;
      const vn = this.pvsTmpN;
      const vp = this.pvsTmpP;
      for (let i = 0; i < c.tris.length; i++) {
        const t = c.tris[i];
        va.fromBufferAttribute(pos, t.a).applyMatrix4(mw);
        vb.fromBufferAttribute(pos, t.b).applyMatrix4(mw);
        vc.fromBufferAttribute(pos, t.c).applyMatrix4(mw);
        const cx = (va.x + vb.x + vc.x) / 3;
        const cy = (va.y + vb.y + vc.y) / 3;
        const cz = (va.z + vb.z + vc.z) / 3;
        vp.set(cx, cy, cz);
        let cl = pvs.getClusterAt(vp);
        if (cl < 0) {
          vb.sub(va);
          vc.sub(va);
          vn.crossVectors(vb, vc);
          if (vn.lengthSq() >= 1e-12) {
            vn.normalize();
            for (const off of [8, -8, 32, -32]) {
              vp.set(cx + vn.x * off, cy + vn.y * off, cz + vn.z * off);
              cl = pvs.getClusterAt(vp);
              if (cl >= 0) break;
            }
          }
        }
        tc[i] = cl;
      }
      c.triClusters = tc;
    }
    const cam = camera.position;
    const p = this.sortPoint;
    for (let i = 0; i < c.tris.length; i++) {
      const t = c.tris[i];
      p.set(
        (pos.getX(t.a) + pos.getX(t.b) + pos.getX(t.c)) / 3,
        (pos.getY(t.a) + pos.getY(t.b) + pos.getY(t.c)) / 3,
        (pos.getZ(t.a) + pos.getZ(t.b) + pos.getZ(t.c)) / 3,
      ).applyMatrix4(mesh.matrixWorld);
      c.dists[i] = p.distanceToSquared(cam);
    }
    const idxArr = idx.array as unknown as number[];
    const triCount = c.tris.length;
    // 原地归并（稳定、0 分配）：旧的 `order: number[]` + `order.sort` 每帧都要建一个数组，
    // V8 的 TimSort 还要再分配一份工作副本；这里只复用两根 Int32Array，语义见 `isFaceBefore`。
    let src = c.order;
    let dst = c.orderTmp;
    for (let i = 0; i < triCount; i++) src[i] = i;
    for (let width = 1; width < triCount; width <<= 1) {
      const step = width << 1;
      for (let lo = 0; lo < triCount; lo += step) {
        const mid = Math.min(lo + width, triCount);
        const hi = Math.min(lo + step, triCount);
        let i = lo;
        let j = mid;
        let k = lo;
        while (i < mid && j < hi) {
          const a = src[i];
          const b = src[j];
          if (isFaceBefore(c.dists, a, b)) {
            dst[k++] = a;
            i++;
          } else {
            dst[k++] = b;
            j++;
          }
        }
        while (i < mid) dst[k++] = src[i++];
        while (j < hi) dst[k++] = src[j++];
      }
      const swap = src;
      src = dst;
      dst = swap;
    }
    const sorted = src;
    // 组内写回：每组 `start/count` 不变，组顺序仍是材质组顺序。
    // 计数分桶替代 `groups.map(() => [])` 的嵌套数组：两趟 O(tris) 得到「按组、组内已排序」。
    const groupsEmpty = c.groupCount === 0;
    const groupCount = groupsEmpty ? 1 : c.groupCount;
    const counts = c.bucketCounts;
    const offsets = c.bucketOffsets;
    const cursors = c.bucketCursors;
    const bucketSorted = c.bucketSorted;
    for (let gi = 0; gi < groupCount; gi++) counts[gi] = 0;
    for (let i = 0; i < triCount; i++) counts[c.tris[i].group]++;
    let acc = 0;
    for (let gi = 0; gi < groupCount; gi++) {
      offsets[gi] = acc;
      cursors[gi] = acc;
      acc += counts[gi];
    }
    for (let i = 0; i < triCount; i++) {
      const oi = sorted[i];
      bucketSorted[cursors[c.tris[oi].group]++] = oi;
    }
    let changed = false;
    const prevIdx = c.prevIdx;
    if (!prevIdx || prevIdx.length !== idxArr.length) {
      changed = true;
    }
    let k = 0;
    for (let gi = 0; gi < groupCount; gi++) {
      let cursor = groupsEmpty ? 0 : geom.groups[gi].start;
      const end = offsets[gi] + counts[gi];
      for (let j = offsets[gi]; j < end; j++) {
        const ti = bucketSorted[j];
        const t = c.tris[ti];
        const hidden =
          pvs !== null && c.triClusters !== null && c.triClusters[ti] >= 0 && !pvs.isVisible(c.triClusters[ti]);
        const ia = t.a;
        const ib = hidden ? t.a : t.b;
        const ic = hidden ? t.a : t.c;
        if (!changed && (prevIdx![k] !== ia || prevIdx![k + 1] !== ib || prevIdx![k + 2] !== ic)) changed = true;
        idxArr[cursor] = ia;
        idxArr[cursor + 1] = ib;
        idxArr[cursor + 2] = ic;
        cursor += 3;
        k += 3;
      }
    }
    // 只有排列真的变了才重传（three 的 WebGLAttributes.update 会整块 bufferSubData）。
    if (changed) {
      if (!c.prevIdx || c.prevIdx.length !== idxArr.length) c.prevIdx = new Uint32Array(idxArr.length);
      c.prevIdx.set(idxArr as unknown as ArrayLike<number>);
      idx.needsUpdate = true;
    }
  }

  /**
   * 每帧把半透明块按**相机到该块最近表面**的距离远→近重排 `renderOrder`（three 升序绘制；原 `sortTransparentChunks`）。
   *
   * 之前按“材质/水位归组”是补丁；通用口径应该来自几何本身：对每块取世界 AABB，
   * 把相机点 clamp 到盒内得到最近点，用这个距离决定前后。这样不猜材质，也不受
   * 合并后 `position=(0,0,0)`、three 退化成 id 顺序的影响。地图解析侧的
   * `faceIndex` 已随来源区间表保留，后续要升级到逐面排序时可直接用。
   */
  update(camera: THREE.Camera, pvs: TransparentPvsQuery | null = null, camCluster = -1): void {
    const list = this.chunks;
    if (list.length === 0) return;
    const box = this.sortBox;
    const point = this.sortPoint;
    const cameraPos = camera.position;
    // 早退：排序结果只取决于「相机位置」和「这帧哪些半透明块可见」。原地转视角（Q/E）相机位置不变，
    // 可见集不变时重排是纯浪费 —— pose3 实测 sortTransparentFaces 占整帧 CPU 的 7%（≈0.22ms），
    // 而它算的三角形-相机距离一个都没变。哈希用 id 的加权和，碰撞只会让顺序不变时多做一次排序。
    let visHash = 0;
    let visCount = 0;
    for (const mesh of list) {
      if (!mesh.visible) continue;
      visCount++;
      visHash = (visHash * 31 + mesh.id) | 0;
    }
    // 逐面排序（每块逐三角形算距离 + 重排 + index 重传）只在相机位置真的变了或 PVS cluster 变化时才做：
    // 转视角时相机位置不变 ⇒ 距离不变 ⇒ 排序结果与上一帧逐位相同（实测占整帧 7%）。
    const moved = cameraPos.distanceToSquared(this.faceSortLastPos) > 0.0625;
    if (moved) this.faceSortLastPos.copy(cameraPos);
    const pvsChanged = camCluster !== this.lastPvsCluster;
    this.lastPvsCluster = camCluster;
    if (
      visCount === this.sortLastVisible &&
      visHash === this.sortLastHash &&
      !moved &&
      !pvsChanged
    ) {
      return;
    }
    this.sortLastVisible = visCount;
    this.sortLastHash = visHash;
    this.sortLastPos.copy(cameraPos);
    for (const mesh of list) {
      const geom = mesh.geometry;
      if (!geom) continue;
      if (!mesh.visible) continue; // 被剔除的块不排序：省掉它的逐三角形重排
      if (!geom.boundingBox) geom.computeBoundingBox();
      const local = geom.boundingBox;
      if (!local) {
        mesh.userData.__vbspTransparentDist = 0;
        continue;
      }
      box.copy(local).applyMatrix4(mesh.matrixWorld);
      box.clampPoint(cameraPos, point);
      mesh.userData.__vbspTransparentDist = point.distanceToSquared(cameraPos);
      if ((moved || pvsChanged) && (globalThis as { __vbspNoFaceSort?: unknown }).__vbspNoFaceSort !== true) {
        this.sortFaces(mesh, camera, pvs);
      }
    }
    list.sort((a, b) => {
      const da = (a.userData.__vbspTransparentDist as number | undefined) ?? 0;
      const db = (b.userData.__vbspTransparentDist as number | undefined) ?? 0;
      return db - da;
    });
    for (let i = 0; i < list.length; i++) {
      const base = (list[i].userData.__vbspTransparentBaseOrder as number | undefined) ?? 0;
      list[i].renderOrder = base + i;
    }
  }
}
