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
  private readonly invMat = new THREE.Matrix4();
  private readonly localCam = new THREE.Vector3();

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
  private sortFaces(mesh: THREE.Mesh, camera: THREE.Camera, pvs: TransparentPvsQuery | null, pvsChanged: boolean): void {
    const geom = mesh.geometry;
    const pos = geom.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos) return;
    type Cache = {
      positionCount: number;
      indexCount: number;
      /** `geom.groups.length` 快照（0 = 没有材质组，按单组处理）；变了就重建索引缓存。 */
      groupCount: number;
      triCount: number;
      triA: Uint32Array;
      triB: Uint32Array;
      triC: Uint32Array;
      triGroup: Uint16Array;
      /** 局部空间三角形重心（`[cx, cy, cz, ...]`），建缓存时预计算，避免每帧 9 次 BufferAttribute 读取。 */
      centroids: Float32Array;
      /** 局部包围盒某一轴跨度接近 0（纯平面水面/玻璃）：任意视角无互相遮挡，完全跳过归并排序。 */
      isCoplanar: boolean;
      pvsSynced: boolean;
      dists: Float64Array;
      triClustersA: Int32Array | null;
      triClustersB: Int32Array | null;
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
      let triCount = 0;
      for (let gi = 0; gi < groupCount; gi++) {
        const gCount = groupsEmpty ? idx.count : geom.groups[gi].count;
        triCount += Math.floor(gCount / 3);
      }
      const triA = new Uint32Array(triCount);
      const triB = new Uint32Array(triCount);
      const triC = new Uint32Array(triCount);
      const triGroup = new Uint16Array(triCount);
      const centroids = new Float32Array(triCount * 3);
      let ti = 0;
      let loX = Infinity, hiX = -Infinity;
      let loY = Infinity, hiY = -Infinity;
      let loZ = Infinity, hiZ = -Infinity;
      for (let gi = 0; gi < groupCount; gi++) {
        const gStart = groupsEmpty ? 0 : geom.groups[gi].start;
        const gCount = groupsEmpty ? idx.count : geom.groups[gi].count;
        for (let i = gStart; i + 2 < gStart + gCount; i += 3) {
          const a = idx.getX(i);
          const b = idx.getX(i + 1);
          const cc = idx.getX(i + 2);
          triA[ti] = a;
          triB[ti] = b;
          triC[ti] = cc;
          triGroup[ti] = gi;
          const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
          const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
          const cx = pos.getX(cc), cy = pos.getY(cc), cz = pos.getZ(cc);
          centroids[ti * 3] = (ax + bx + cx) / 3;
          centroids[ti * 3 + 1] = (ay + by + cy) / 3;
          centroids[ti * 3 + 2] = (az + bz + cz) / 3;
          if (ax < loX) loX = ax; if (ax > hiX) hiX = ax;
          if (bx < loX) loX = bx; if (bx > hiX) hiX = bx;
          if (cx < loX) loX = cx; if (cx > hiX) hiX = cx;
          if (ay < loY) loY = ay; if (ay > hiY) hiY = ay;
          if (by < loY) loY = by; if (by > hiY) hiY = by;
          if (cy < loY) loY = cy; if (cy > hiY) hiY = cy;
          if (az < loZ) loZ = az; if (az > hiZ) hiZ = az;
          if (bz < loZ) loZ = bz; if (bz > hiZ) hiZ = bz;
          if (cz < loZ) loZ = cz; if (cz > hiZ) hiZ = cz;
          ti++;
        }
      }
      const isCoplanar = triCount <= 1 || (hiX - loX < 1e-2 || hiY - loY < 1e-2 || hiZ - loZ < 1e-2);
      cache = {
        positionCount: pos.count,
        indexCount: idx.count,
        groupCount: groupsEmpty ? 0 : geom.groups.length,
        triCount,
        triA,
        triB,
        triC,
        triGroup,
        centroids,
        isCoplanar,
        pvsSynced: false,
        dists: new Float64Array(triCount),
        triClustersA: null,
        triClustersB: null,
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
    const triCount = c.triCount;
    if (pvs && (!c.triClustersA || !c.triClustersB)) {
      const tcA = new Int32Array(triCount).fill(-1);
      const tcB = new Int32Array(triCount).fill(-1);
      const mw = mesh.matrixWorld;
      const va = this.pvsTmpA;
      const vb = this.pvsTmpB;
      const vc = this.pvsTmpC;
      const vn = this.pvsTmpN;
      const vp = this.pvsTmpP;
      for (let i = 0; i < triCount; i++) {
        va.fromBufferAttribute(pos, c.triA[i]).applyMatrix4(mw);
        vb.fromBufferAttribute(pos, c.triB[i]).applyMatrix4(mw);
        vc.fromBufferAttribute(pos, c.triC[i]).applyMatrix4(mw);
        const cx = (va.x + vb.x + vc.x) / 3;
        const cy = (va.y + vb.y + vc.y) / 3;
        const cz = (va.z + vb.z + vc.z) / 3;
        vp.set(cx, cy, cz);
        const centerCl = pvs.getClusterAt(vp);
        vb.sub(va);
        vc.sub(va);
        vn.crossVectors(vb, vc);
        const hasNorm = vn.lengthSq() >= 1e-12;
        if (hasNorm) vn.normalize();
        let clA = centerCl;
        if (clA < 0 && hasNorm) {
          for (const off of [8, 32]) {
            vp.set(cx + vn.x * off, cy + vn.y * off, cz + vn.z * off);
            clA = pvs.getClusterAt(vp);
            if (clA >= 0) break;
          }
        }
        let clB = -1;
        if (hasNorm) {
          for (const off of [-8, -32]) {
            vp.set(cx + vn.x * off, cy + vn.y * off, cz + vn.z * off);
            clB = pvs.getClusterAt(vp);
            if (clB >= 0) break;
          }
        }
        tcA[i] = clA;
        tcB[i] = clB;
      }
      c.triClustersA = tcA;
      c.triClustersB = tcB;
    }

    const idxArr = idx.array as unknown as number[];
    const cullAll = (globalThis as { __vbspPvsCullAll?: boolean }).__vbspPvsCullAll === true;

    // 共面/单三角快路径：共面三角在任意视角下永不互相遮挡，无需归并排序，只在 PVS 开关/房间变化时写一次 index。
    if (c.isCoplanar) {
      if (pvs === null && !c.pvsSynced) return;
      if (pvs !== null && !pvsChanged && c.pvsSynced) return;
      let changed = !c.prevIdx || c.prevIdx.length !== idxArr.length;
      const prevIdx = c.prevIdx;
      const groupsEmpty = c.groupCount === 0;
      const groupCount = groupsEmpty ? 1 : c.groupCount;
      let ti = 0;
      let k = 0;
      for (let gi = 0; gi < groupCount; gi++) {
        let cursor = groupsEmpty ? 0 : geom.groups[gi].start;
        while (ti < triCount && c.triGroup[ti] === gi) {
          let hidden = false;
          if (pvs !== null && c.triClustersA !== null && c.triClustersB !== null) {
            if (cullAll) {
              hidden = true;
            } else {
              const ca = c.triClustersA[ti];
              const cb = c.triClustersB[ti];
              const hasAny = ca >= 0 || cb >= 0;
              hidden = hasAny && !(ca >= 0 && pvs.isVisible(ca)) && !(cb >= 0 && pvs.isVisible(cb));
            }
          }
          const ia = c.triA[ti];
          const ib = hidden ? ia : c.triB[ti];
          const ic = hidden ? ia : c.triC[ti];
          if (!changed && (prevIdx![k] !== ia || prevIdx![k + 1] !== ib || prevIdx![k + 2] !== ic)) changed = true;
          idxArr[cursor] = ia;
          idxArr[cursor + 1] = ib;
          idxArr[cursor + 2] = ic;
          cursor += 3;
          k += 3;
          ti++;
        }
      }
      c.pvsSynced = pvs !== null;
      if (changed) {
        if (!c.prevIdx || c.prevIdx.length !== idxArr.length) c.prevIdx = new Uint32Array(idxArr.length);
        c.prevIdx.set(idxArr as unknown as ArrayLike<number>);
        idx.needsUpdate = true;
      }
      return;
    }

    // 把相机点变换一次到局部空间算平方距离（等比正交下局部距离平方与世界距离平方严格正比，省去每三角 4x4 矩阵乘）
    const me = mesh.matrixWorld.elements;
    const sx2 = me[0] * me[0] + me[1] * me[1] + me[2] * me[2];
    const sy2 = me[4] * me[4] + me[5] * me[5] + me[6] * me[6];
    const sz2 = me[8] * me[8] + me[9] * me[9] + me[10] * me[10];
    const tol = sx2 * 1e-3 + 1e-6;
    const uniformRigid =
      sx2 >= 1e-12 &&
      Math.abs(sy2 - sx2) <= tol &&
      Math.abs(sz2 - sx2) <= tol &&
      Math.abs(me[0] * me[4] + me[1] * me[5] + me[2] * me[6]) <= tol &&
      Math.abs(me[0] * me[8] + me[1] * me[9] + me[2] * me[10]) <= tol &&
      Math.abs(me[4] * me[8] + me[5] * me[9] + me[6] * me[10]) <= tol;

    const centroids = c.centroids;
    const dists = c.dists;
    if (uniformRigid) {
      this.invMat.copy(mesh.matrixWorld).invert();
      this.localCam.copy(camera.position).applyMatrix4(this.invMat);
      const lx = this.localCam.x;
      const ly = this.localCam.y;
      const lz = this.localCam.z;
      for (let i = 0; i < triCount; i++) {
        const off = i * 3;
        const dx = centroids[off] - lx;
        const dy = centroids[off + 1] - ly;
        const dz = centroids[off + 2] - lz;
        dists[i] = dx * dx + dy * dy + dz * dz;
      }
    } else {
      const cam = camera.position;
      const p = this.sortPoint;
      for (let i = 0; i < triCount; i++) {
        const off = i * 3;
        p.set(centroids[off], centroids[off + 1], centroids[off + 2]).applyMatrix4(mesh.matrixWorld);
        dists[i] = p.distanceToSquared(cam);
      }
    }

    // 原地归并（稳定、0 分配）：复用两根 Int32Array，语义见 `isFaceBefore`。
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
    const groupsEmpty = c.groupCount === 0;
    const groupCount = groupsEmpty ? 1 : c.groupCount;
    const counts = c.bucketCounts;
    const offsets = c.bucketOffsets;
    const cursors = c.bucketCursors;
    const bucketSorted = c.bucketSorted;
    for (let gi = 0; gi < groupCount; gi++) counts[gi] = 0;
    for (let i = 0; i < triCount; i++) counts[c.triGroup[i]]++;
    let acc = 0;
    for (let gi = 0; gi < groupCount; gi++) {
      offsets[gi] = acc;
      cursors[gi] = acc;
      acc += counts[gi];
    }
    for (let i = 0; i < triCount; i++) {
      const oi = sorted[i];
      bucketSorted[cursors[c.triGroup[oi]]++] = oi;
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
        let hidden = false;
        if (pvs !== null && c.triClustersA !== null && c.triClustersB !== null) {
          if (cullAll) {
            hidden = true;
          } else {
            const ca = c.triClustersA[ti];
            const cb = c.triClustersB[ti];
            const hasAny = ca >= 0 || cb >= 0;
            hidden = hasAny && !(ca >= 0 && pvs.isVisible(ca)) && !(cb >= 0 && pvs.isVisible(cb));
          }
        }
        const ia = c.triA[ti];
        const ib = hidden ? ia : c.triB[ti];
        const ic = hidden ? ia : c.triC[ti];
        if (!changed && (prevIdx![k] !== ia || prevIdx![k + 1] !== ib || prevIdx![k + 2] !== ic)) changed = true;
        idxArr[cursor] = ia;
        idxArr[cursor + 1] = ib;
        idxArr[cursor + 2] = ic;
        cursor += 3;
        k += 3;
      }
    }
    c.pvsSynced = pvs !== null;
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
    const moved = !(cameraPos.distanceToSquared(this.faceSortLastPos) <= 0.0625);
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
        this.sortFaces(mesh, camera, pvs, pvsChanged);
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
