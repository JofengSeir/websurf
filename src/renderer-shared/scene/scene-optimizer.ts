/**
 * 空间分块合并（scene optimizer）：把 GLTFLoader 逐 primitive 生成的数万 Mesh 收敛成数百个
 * 空间块，降低每帧遍历与 draw call 数量。2026-10-02 自 apps/game/src/renderer/renderer-main.ts
 * 的同名私有方法原样抽出、现居渲染共享层（game 经 tsconfig include 收编；逻辑零改动；this.camera / config.hud.fov 两个诊断读数改为入参传入）。
 *
 * 2026-10-03 Phase 3c 拆成「共享核 + 调用方包装」：mergeIntoChunks 是不改根、不挂载、不打日志的
 * 纯收集合并核（game 与 viewer 共用同一份算法）；root 挂载方式与诊断日志留在各调用方——game 的
 * optimizeScene 包装与拆分前逐行等价（先收集合并，再挂回 bspRoot、移除 GLB 子树、垫包围球、打统计）。
 *
 * 合并期另按输入顺序记一张**来源区间表**（原 mesh 名 + 其 `userData.vbsp` 元数据，见 MergeSourceTable）
 * 挂到合并结果几何的 `userData` 上：块 mesh 是新建的、不带 name/userData，射线命中它之后要靠这张表
 * 才能反查"真正被指到的是哪份几何"。新增的只有 userData——顶点/索引/材质/分组布局与合并前完全相同。
 */

import * as THREE from 'three';
import { deinterleaveGeometry, mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
// ── 空间分块合并参数（GLB 挂载后一次性执行；见 optimizeScene）──────────
// GLTFLoader 按 GLB 的 primitive 逐个建 THREE.Mesh，图元多的地图因此会产生数万个 Mesh 对象：
// 每帧都要遍历它们做剔除，可见的还要逐个 draw call。分块合并把这批 Mesh 收敛成数百个空间块
// （块内先按材质实例分组，再合并成「每块一个 Mesh + 一份材质数组」），几何与材质实例不变；
// 合并失败的分支逐块回退为保留独立几何。
/** cell 大小自适应的目标块数：初值 = 世界包围盒对角线 / cbrt(本值)，随后按非空 cell 数微调。 */
const OPT_TARGET_CELLS = 512;
/** 自适应接受的「非空 cell 数」区间；落进区间即停止调整（最多 6 轮）。 */
const OPT_MIN_CELLS = 300;
const OPT_MAX_CELLS = 800;
/** cell 边长钳制区间（世界单位）：初值与每轮微调都被夹在区间内。 */
const OPT_CELL_MIN = 128;
const OPT_CELL_MAX = 4096;
/**
 * 视锥外保留圈的半径膨胀系数（分块结束时乘到每块的包围球半径上）。
 * three 的视锥剔除按 geometry.boundingSphere 判定，膨胀后视锥外一圈的块仍参与渲染 ⇒
 * 快速转动时新进入视野的块上一帧已在画，边缘不闪空。只影响剔除判定，不改几何与材质。
 */
const FRUSTUM_PAD = 1.6;

/** 分块收集项：mesh + 它的世界包围盒中心（分桶键用）。 */
interface OptMeshInfo {
  mesh: THREE.Mesh;
  cx: number;
  cy: number;
  cz: number;
}

/** cell 键：世界坐标三分量各除以 cellSize 后向下取整，拼成字符串（一次性分桶）。 */
function optCellKey(x: number, y: number, z: number, cellSize: number): string {
  return Math.floor(x / cellSize) + '|' + Math.floor(y / cellSize) + '|' + Math.floor(z / cellSize);
}

/** 统计给定 cellSize 下的非空 cell 数（cell 大小自适应循环用）。 */
function optCountCells(infos: OptMeshInfo[], cellSize: number): number {
  const keys = new Set<string>();
  for (const it of infos) keys.add(optCellKey(it.cx, it.cy, it.cz, cellSize));
  return keys.size;
}

/**
 * 合并前归一（`mergeIntoChunks` 的**默认**钩子；T-460 WP4 从 debug 侧搬入，三端同一份）。
 *
 * 为什么需要：同组 geometry 的属性布局不一致时，three 的 `mergeGeometries` 直接返回 null，该组只能
 * 回退成「各自保留独立几何」⇒ draw call 随组数线性增长（T-636：这正是 game/viewer 与 debug 分叉处）。
 *
 * 两步：
 * ① 索引不一致（组内既有带 `index` 又有不带）时，把带 `index` 的转成非索引几何；全带或全不带原样保留。
 * ② 组内出现多于一种 `BufferAttribute.gpuType`（`undefined` 按 0 计）时逐份 clone 后重建属性：
 *    交错属性先解交错，再按 `count × itemSize` 显式拷成 `Float32Array`，保留 `normalized` 标志。
 *
 * 交错属性必须解交错：`InterleavedBufferAttribute.array` 是整段 stride 缓冲（长度 = count × stride），
 * 而 `itemSize` 只是逻辑分量数，直接按 `itemSize` 重建会得到非整数顶点数 ⇒ 逐顶点读到 `undefined`、
 * 包围球变 NaN ⇒ 剔除判定失效、整块不渲染。
 *
 * 契约：输出与输入**逐项对应**（长度与顺序不变）——来源区间表按输入顺序与钩子输出配对。
 */
export function normalizeMergeGroup(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry[] {
  const hasIdx = geoms.some((g) => g.index !== null);
  const allIdx = geoms.every((g) => g.index !== null);
  let out = hasIdx && !allIdx ? geoms.map((g) => (g.index ? g.toNonIndexed() : g)) : geoms;
  const gpuTypes = new Set<number>();
  for (const g of out) {
    for (const name of Object.keys(g.attributes)) {
      const a = g.attributes[name] as THREE.BufferAttribute;
      gpuTypes.add((a as unknown as { gpuType?: number }).gpuType ?? 0);
    }
  }
  if (gpuTypes.size > 1) {
    out = out.map((g) => {
      const g2 = g.clone();
      // 交错属性先摊平成普通属性：其 array 是整段 stride 缓冲，直接重建会切出非整数顶点数
      if (Object.values(g2.attributes).some((a) => (a as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute)) {
        deinterleaveGeometry(g2);
      }
      for (const name of Object.keys(g2.attributes)) {
        const a = g2.attributes[name] as THREE.BufferAttribute;
        // 长度固定为 count × itemSize 的新缓冲，逐元素拷贝原数据
        const src = a.array as ArrayLike<number>;
        const arr = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < arr.length; i++) arr[i] = src[i] as number;
        // 长度自洽检查：分配式与比较式同为 count × itemSize，不等时打印属性名与三个长度
        if (arr.length !== a.count * a.itemSize) {
          console.error(`[optimizeScene] 属性 ${name} 长度不自洽：array=${arr.length} count=${a.count} itemSize=${a.itemSize}`);
        }
        g2.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
      }
      g2.dispose();
      return g2;
    });
  }
  return out;
}

/**
 * 合并可选钩子：`normalizeGroup` 在两处合并入参前调用，**默认值**即上面的共享 `normalizeMergeGroup`
 * ——T-460 WP4 起三端都走同一份归一（此前只有 debug 注入，game/viewer 走合批失败保留分支）。
 * 传入自定义函数即整体替换（逃生口）；传 `(g) => g` 可显式关掉归一（调试/对照用）。
 *
 * 契约：输出与输入**逐项对应**（长度与顺序不变）。来源区间表按输入顺序与钩子输出配对，长度不等时
 * 该组不带表（`lookupMergeSource` 返回 null，退回按 mesh 自身的 name/userData 取名）。
 */
export interface MergeOptions {
  normalizeGroup?: (geoms: THREE.BufferGeometry[]) => THREE.BufferGeometry[];
}

/** mergeIntoChunks 的产物：chunks / keptMeshes 由调用方自行挂载，统计字段供诊断日志用。 */
export interface MergeResult {
  infos: OptMeshInfo[];
  keptMeshes: THREE.Mesh[];
  chunks: THREE.Mesh[];
  cellSize: number;
  cellsCount: number;
  chunkCount: number;
  vertsTotal: number;
  drawCallEst: number;
}

// ── 来源区间表（块 mesh 无名，靠它反查"命中的是哪份原几何"）──────────────────
// 表按合并输入顺序首尾相接：第 i 条覆盖合并后缓冲的 [start, start + count)。
// 索引几何以索引缓冲计（count = 该份几何的 index.count），非索引几何以顶点计
// （count = 该份几何的 position.count）——两种口径下"三角形序号 × 3"都落在区间内。

/** 来源区间表在 `geometry.userData` 上的键。 */
export const MERGE_SOURCE_TABLE_KEY = 'websurfMergeSourceTable';

/** 来源 mesh 的 `userData.vbsp` 分类元数据（装载期由各应用写入；共享层只读不改、按引用带过）。 */
export interface MergeSourceMeta {
  isTools?: boolean;
  isNodraw?: boolean;
  hasTexture?: boolean;
  isWater?: boolean;
  isTrans?: boolean;
  isLightEmissive?: boolean;
  textureName?: string;
  materialName?: string;
}

/** 一条来源区间：合并后缓冲里的 `[start, start + count)` 来自哪只原 mesh。 */
export interface MergeSourceRange {
  /** 起点：索引几何为**索引缓冲下标**，非索引几何为**顶点下标**（由表的 `indexed` 区分）。 */
  start: number;
  /** 长度：索引几何为索引数，非索引几何为顶点数。 */
  count: number;
  /** 原 mesh 的节点名（GLTFLoader 写入；未命名时为空串）。 */
  meshName: string;
  /** 原 mesh 的 `userData.vbsp`（同一对象按引用带过，不复制）。 */
  vbsp?: MergeSourceMeta;
}

/** 合并后几何的来源区间表（挂在 `geometry.userData[MERGE_SOURCE_TABLE_KEY]` 上）。 */
export interface MergeSourceTable {
  /** true = `start`/`count` 以索引缓冲计；false = 以顶点计。 */
  indexed: boolean;
  ranges: MergeSourceRange[];
}

/** 一份来源几何的元数据 = 区间表条目去掉 `[start, count)`。 */
type MergeSourceSeed = Omit<MergeSourceRange, 'start' | 'count'>;

/** 读一只 mesh 的来源元数据（节点名 + `userData.vbsp` 引用）。 */
function meshSourceSeed(mesh: THREE.Mesh): MergeSourceSeed {
  return {
    meshName: mesh.name ?? '',
    vbsp: mesh.userData?.vbsp as MergeSourceMeta | undefined,
  };
}

/** 几何在合并缓冲里的长度：带 index 取索引数，否则取 POSITION 顶点数（无 POSITION 记 0）。 */
function mergeBufferLength(geometry: THREE.BufferGeometry): number {
  if (geometry.index) return geometry.index.count;
  const pos = geometry.attributes.position as THREE.BufferAttribute | undefined;
  return pos ? pos.count : 0;
}

/** 按合并输入顺序把「每份几何一条来源」摊成区间表。 */
function buildSourceTable(geometries: THREE.BufferGeometry[], seeds: MergeSourceSeed[]): MergeSourceTable {
  const ranges: MergeSourceRange[] = [];
  let cursor = 0;
  for (let i = 0; i < geometries.length; i++) {
    const count = mergeBufferLength(geometries[i]);
    ranges.push({ start: cursor, count, meshName: seeds[i].meshName, vbsp: seeds[i].vbsp });
    cursor += count;
  }
  return { indexed: geometries.length > 0 && geometries[0].index !== null, ranges };
}

/**
 * 把子几何各自的表按同一顺序拼成一张总表：子区间整体平移到总缓冲的坐标。
 * `geometries` 传**实际参与最终合并的那一组**（可为钩子归一后的产物，长度口径与它一致）。
 * 长度不等（钩子未逐项对应）或任一子表缺失时返回 null ⇒ 该块不带表。
 */
function concatSourceTables(
  geometries: THREE.BufferGeometry[],
  tables: (MergeSourceTable | null)[],
): MergeSourceTable | null {
  if (geometries.length === 0 || geometries.length !== tables.length) return null;
  const ranges: MergeSourceRange[] = [];
  let cursor = 0;
  for (let i = 0; i < geometries.length; i++) {
    const table = tables[i];
    if (!table) return null;
    for (const r of table.ranges) {
      ranges.push({ start: r.start + cursor, count: r.count, meshName: r.meshName, vbsp: r.vbsp });
    }
    cursor += mergeBufferLength(geometries[i]);
  }
  return { indexed: geometries[0].index !== null, ranges };
}

/** 把表挂到几何的 userData 上（空表不挂，保持未合并几何的 userData 原样）。 */
function attachSourceTable(geometry: THREE.BufferGeometry, table: MergeSourceTable | null): void {
  if (!table || table.ranges.length === 0) return;
  geometry.userData[MERGE_SOURCE_TABLE_KEY] = table;
}

/**
 * 按射线命中的面序号反查来源区间。
 *
 * `faceIndex` 是**三角形序号**：three 的 `Mesh.raycast` 对索引几何写索引缓冲下标 /3、对非索引几何
 * 写顶点下标 /3 ⇒ 两种口径都折算成缓冲下标 `faceIndex * 3` 再落区间（区间各按自己的缓冲计数）。
 *
 * @returns 命中的区间；几何没有来源表、`faceIndex` 非法或落在全部区间之外时返回 null。
 */
export function lookupMergeSource(
  geometry: THREE.BufferGeometry | null | undefined,
  faceIndex: number | null | undefined,
): MergeSourceRange | null {
  if (!geometry || faceIndex === null || faceIndex === undefined || !(faceIndex >= 0)) return null;
  const table = geometry.userData?.[MERGE_SOURCE_TABLE_KEY] as MergeSourceTable | undefined;
  const ranges = table?.ranges;
  if (!ranges || ranges.length === 0) return null;
  const probe = faceIndex * 3;
  // 区间按 start 升序且首尾相接 ⇒ 二分出最后一个 start <= probe 的区间，再判它是否覆盖 probe
  let lo = 0;
  let hi = ranges.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].start <= probe) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const range = ranges[found];
  return probe < range.start + range.count ? range : null;
}

/**
 * 收集与合并核：traverse `collectRoot` 收集单材质 Mesh → cell 边长自适应 → 分桶 → 逐 cell 合并。
 * 不改根、不挂载、不打日志（root 处理与诊断是调用方的事）；infos 为空时 chunks/keptMeshes
 * 的收集（多材质烘焙）已经完成，调用方按各自语义处理空集路径。
 */
export function mergeIntoChunks(collectRoot: THREE.Object3D, opts?: MergeOptions): MergeResult {
  // ① 收集：先刷新 matrixWorld 作为世界变换基准。多材质 mesh（GLB primitive 恒单材质，此处是
  //    防御路径）烘焙到世界空间后保留；无材质 mesh 原样跳过。两者都不参与分块
  collectRoot.updateMatrixWorld(true);
  const infos: OptMeshInfo[] = [];
  const keptMeshes: THREE.Mesh[] = [];
  const worldBox = new THREE.Box3();
  const box = new THREE.Box3();
  const center = new THREE.Vector3();
  collectRoot.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh) return;
    if (!m.geometry || !m.geometry.attributes.position) return;
    if (Array.isArray(m.material) || !m.material) {
      // 多材质：烘焙到世界空间后整体保留（不参与分块合并）
      if (Array.isArray(m.material)) {
        const baked = m.geometry.clone();
        baked.applyMatrix4(m.matrixWorld);
        m.geometry.dispose();
        m.geometry = baked;
        m.position.set(0, 0, 0);
        m.rotation.set(0, 0, 0);
        m.scale.set(1, 1, 1);
        m.updateMatrix();
        keptMeshes.push(m);
      }
      return;
    }
    const g = m.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox) return;
    box.copy(g.boundingBox).applyMatrix4(m.matrixWorld);
    worldBox.union(box);
    box.getCenter(center);
    infos.push({ mesh: m, cx: center.x, cy: center.y, cz: center.z });
  });
  if (infos.length === 0) {
    return { infos, keptMeshes, chunks: [], cellSize: 0, cellsCount: 0, chunkCount: 0, vertsTotal: 0, drawCallEst: 0 };
  }

  // ①b 合并失败不丢几何：`mergeGeometries` 在属性集不一致时返回 null，而本函数每一处失败分支
  //     都回退成「保留各自独立几何」，不存在"合并失败就丢弃"的路径。

  // ② cell 边长自适应：初值取世界包围盒对角线 / cbrt(目标块数)，随后按非空 cell 数缩放（收敛到
  //    OPT_MIN_CELLS..OPT_MAX_CELLS）
  const diag = Math.max(worldBox.getSize(new THREE.Vector3()).length(), 1);
  let cellSize = Math.min(Math.max(diag / Math.cbrt(OPT_TARGET_CELLS), OPT_CELL_MIN), OPT_CELL_MAX);
  for (let i = 0; i < 6; i++) {
    const n = optCountCells(infos, cellSize);
    if (n >= OPT_MIN_CELLS && n <= OPT_MAX_CELLS) break;
    const scale = Math.min(Math.max(Math.cbrt(n / OPT_TARGET_CELLS), 0.55), 1.8);
    cellSize = Math.min(Math.max(cellSize * scale, OPT_CELL_MIN), OPT_CELL_MAX);
  }

  // ③ 分桶：按每个 mesh 的世界包围盒中心归 cell（横跨多 cell 的归中心所在 cell）
  const cells = new Map<string, OptMeshInfo[]>();
  for (const it of infos) {
    const key = optCellKey(it.cx, it.cy, it.cz, cellSize);
    let arr = cells.get(key);
    if (!arr) {
      arr = [];
      cells.set(key, arr);
    }
    arr.push(it);
  }

  // ④ 合并：单 mesh 的 cell 保留原 mesh（几何烘焙到世界空间、变换清零）；多 mesh 的 cell
  //    先按材质实例分组子合并，再 mergeGeometries(useGroups = true) 合成一个 Mesh + 材质数组
  //    （groups 与材质数组下标一一对应）
  const chunks: THREE.Mesh[] = [];
  let chunkCount = 0;
  let drawCallEst = 0;
  let vertsTotal = 0;
  for (const arr of cells.values()) {
    if (arr.length === 1) {
      const m = arr[0].mesh;
      const baked = m.geometry.clone();
      baked.applyMatrix4(m.matrixWorld);
      m.geometry.dispose();
      m.geometry = baked;
      m.position.set(0, 0, 0);
      m.rotation.set(0, 0, 0);
      m.scale.set(1, 1, 1);
      m.updateMatrix();
      // 单 mesh 的 cell 保留了原 mesh 的 name/userData，仍写一张单区间表：
      // 让消费方只有一条查表路径（不必区分"这只 mesh 是不是合并产物"）
      attachSourceTable(baked, buildSourceTable([baked], [meshSourceSeed(m)]));
      chunks.push(m);
      chunkCount++;
      drawCallEst++;
      vertsTotal += baked.attributes.position.count;
      continue;
    }

    // 多 mesh cell：按材质实例分组，组内合并成一个几何（每组对应一个材质槽）。
    // 来源元数据与几何并行收集（同一下标），供合并后拼区间表用。
    const byMat = new Map<THREE.Material, { geoms: THREE.BufferGeometry[]; seeds: MergeSourceSeed[] }>();
    for (const it of arr) {
      const m = it.mesh;
      const mat = m.material as THREE.Material;
      const baked = m.geometry.clone();
      baked.applyMatrix4(m.matrixWorld);
      let group = byMat.get(mat);
      if (!group) {
        group = { geoms: [], seeds: [] };
        byMat.set(mat, group);
      }
      group.geoms.push(baked);
      group.seeds.push(meshSourceSeed(m));
    }
    const mergedGeoms: THREE.BufferGeometry[] = [];
    // 与 mergedGeoms 同下标的来源表（null = 这一份没有表，最终合并出的块也不带表）
    const mergedTables: (MergeSourceTable | null)[] = [];
    const mats: THREE.Material[] = [];
    for (const [mat, group] of byMat) {
      const geomsRaw = group.geoms;
      const geoms = (opts?.normalizeGroup ?? normalizeMergeGroup)(geomsRaw);
      // 钩子须逐项对应（长度不变）才谈得上"哪份几何进了哪段缓冲"
      const seeds = geoms.length === group.seeds.length ? group.seeds : null;
      let merged: THREE.BufferGeometry[];
      let tables: (MergeSourceTable | null)[];
      if (geoms.length === 1) {
        merged = geoms;
        tables = [seeds ? buildSourceTable(geoms, seeds) : null];
      } else {
        const mg = mergeGeometries(geoms, false);
        if (mg) {
          for (const g of geoms) g.dispose();
          merged = [mg];
          tables = [seeds ? buildSourceTable(geoms, seeds) : null];
        } else {
          merged = geoms; // 属性不一致（防御分支）：保留各自独立几何
          tables = geoms.map((_, i) => (seeds ? buildSourceTable([geoms[i]], [seeds[i]]) : null));
        }
      }
      for (let i = 0; i < merged.length; i++) {
        mergedGeoms.push(merged[i]);
        mergedTables.push(tables[i]);
        mats.push(mat);
      }
    }
    if (mergedGeoms.length === 0) {
      for (const it of arr) it.mesh.geometry.dispose();
      continue;
    }
    let chunk: THREE.Mesh;
    if (mergedGeoms.length === 1) {
      chunk = new THREE.Mesh(mergedGeoms[0], mats[0]);
      attachSourceTable(mergedGeoms[0], mergedTables[0]);
      drawCallEst++;
    } else {
      // 归一后的数组既做最终合并的入参，也定区间表的长度口径（逐项对应）
      const normalized = (opts?.normalizeGroup ?? normalizeMergeGroup)(mergedGeoms);
      const final = mergeGeometries(normalized, true);
      if (final) {
        for (const g of mergedGeoms) if (g !== final) g.dispose();
        chunk = new THREE.Mesh(final, mats);
        drawCallEst += final.groups.length;
        attachSourceTable(final, concatSourceTables(normalized, mergedTables));
      } else {
        // 最终合并失败（极端防御）：每个材质单独一块
        chunk = new THREE.Mesh(mergedGeoms[0], mats[0]);
        attachSourceTable(mergedGeoms[0], mergedTables[0]);
        for (let i = 1; i < mergedGeoms.length; i++) {
          const extra = new THREE.Mesh(mergedGeoms[i], mats[i]);
          attachSourceTable(mergedGeoms[i], mergedTables[i]);
          chunks.push(extra);
          chunkCount++;
          drawCallEst++;
        }
      }
    }
    for (const it of arr) it.mesh.geometry.dispose();
    chunkCount++;
    for (const g of mergedGeoms) vertsTotal += g.attributes.position.count;
    chunks.push(chunk);
  }

  return { infos, keptMeshes, chunks, cellSize, cellsCount: cells.size, chunkCount, vertsTotal, drawCallEst };
}

/** 合并统计（T-460 WP7）：写在产出根的 `userData.vbspMerge` 上，供三端一致性探针逐字段比对。 */
export interface MergeStats {
  /** 参与合并的输入 mesh 数。 */
  meshes: number;
  /** 合并后的块数。 */
  chunks: number;
  /** draw call 估算（块内材质槽数之和）。 */
  drawCallEst: number;
}

/** 把合并统计挂到产出根（`optimizeScene` / `mergeIntoNewRoot` 各调一次）。 */
function attachMergeStats(root: THREE.Object3D, stats: MergeStats): void {
  (root.userData as { vbspMerge?: MergeStats }).vbspMerge = stats;
}

/** 读产出根上的合并统计（探针用；未合并过时为 null）。 */
export function mergeStatsOf(root: THREE.Object3D | null | undefined): MergeStats | null {
  if (!root) return null;
  return (root.userData as { vbspMerge?: MergeStats }).vbspMerge ?? null;
}

/**
 * 视锥外保留一圈：给 root 下每个 mesh 的包围球半径乘 FRUSTUM_PAD。必须无条件重算包围球（不能只判
 * null）：烘焙路径是 geometry.clone() + applyMatrix4(matrixWorld)，克隆会带上 GLB 局部空间的旧球
 * （非 null，不重算就会被当成有效值）⇒ 剔除按错误位置判定、眼前的块被误剔。顶点已烘焙到世界
 * 空间，重算才是对的。只影响剔除判定，不改几何与包围盒。game 与 viewer 共用。
 */
export function padBoundingSpheres(root: THREE.Object3D): void {
  for (const child of root.children) {
    const g = (child as THREE.Mesh).geometry;
    if (!g) continue;
    g.computeBoundingSphere();
    (g.boundingSphere as THREE.Sphere).radius *= FRUSTUM_PAD;
  }
}

// ── game 包装：签名与行为与抽取前逐行一致（loadScene 里挂载完 GLB 后执行一次）─────────────
// 目的：把 GLTFLoader 逐 primitive 生成的数万个 Mesh 收敛成数百个空间块，降低每帧遍历与 draw call
// 数量。载体是 BSP 场景根（`userData.isBspModel` 保持不变）：块 mesh 直接挂到它下面，原 GLB 子树移除。
// 流程：
// ① 收集与合并（mergeIntoChunks：收集单材质 Mesh、多材质烘焙保留、cell 自适应、逐 cell 合并）；
// ② 替换场景内容，并给每块重算包围球后乘 FRUSTUM_PAD；
// ③ 打印统计与「前向视锥可见块」估算（用入参 camera 与 fovDeg 粗估，仅诊断）。
export function optimizeScene(
  bspRoot: THREE.Scene,
  gltfScene: THREE.Object3D,
  camera: THREE.PerspectiveCamera | null,
  fovDeg: number,
  opts?: MergeOptions,
): void {
  const r = mergeIntoChunks(bspRoot, opts);
  if (r.infos.length === 0) return;

  // 替换：块 mesh 与保留 mesh 直接挂到 BSP 根（`add` 会自动让它们脱离原父节点），随后移除原
  // GLB 子树（旧几何已在上面逐个 dispose）。`bspRoot.userData.isBspModel` 保持不变——
  // disposeScene 与近平面自适应都依赖它
  const totalMeshes = r.infos.length;
  for (const m of r.chunks) bspRoot.add(m);
  for (const m of r.keptMeshes) bspRoot.add(m);
  bspRoot.remove(gltfScene);
  padBoundingSpheres(bspRoot);
  attachMergeStats(bspRoot, { meshes: totalMeshes, chunks: r.chunkCount, drawCallEst: r.drawCallEst });

  // 统计 + 前向视锥可见块估算（块中心与相机方向的点积粗估，FOV 取入参 fovDeg）
  const chunkBox = new THREE.Box3();
  const chunkCenter = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  let visibleEst = -1;
  if (camera) {
    camera.updateMatrixWorld(true);
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const cosHalfFov = Math.cos((fovDeg / 2) * (Math.PI / 180));
    visibleEst = 0;
    for (const child of bspRoot.children) {
      const mesh = child as THREE.Mesh;
      chunkBox.setFromObject(mesh);
      if (chunkBox.isEmpty()) continue;
      chunkBox.getCenter(chunkCenter);
      toCam.subVectors(chunkCenter, camera.position);
      const dist = toCam.length();
      if (dist < camera.far && toCam.dot(camDir) / dist > cosHalfFov) visibleEst++;
    }
  }
  console.log(
    `[optimizeScene] 分块合并: ${totalMeshes} mesh → ${r.chunkCount} 块` +
      `（cellSize=${r.cellSize.toFixed(1)}、非空 cell=${r.cellsCount}）| ` +
      `平均顶点/块 ${(r.vertsTotal / Math.max(r.chunkCount, 1)).toFixed(0)}（总顶点 ${r.vertsTotal}）| ` +
      `draw call 估算 ${r.drawCallEst} | ` +
      `前向视锥可见块估算 ${visibleEst >= 0 ? `${visibleEst}/${r.chunkCount}` : 'N/A（camera 未就绪）'}`,
  );
}

/**
 * 「新根」口径的合并包装：合并 `src` 的图元到一个**新建的 Group** 并垫包围球，返回新根。
 *
 * 与 `optimizeScene` 的唯一差别是载体的归属——后者原地挂回传入的 BSP 根；本函数把根交给调用方，
 * 由调用方决定挂到哪个场景、是否替换自己的根引用（`apps/viewer` 的 model getter / 拾取 /
 * `worldBox` 都按根切换）。收集与合并算法、失败回退、垫球口径与 `optimizeScene` 同一份。
 * 副作用：`src` 下被合并掉的原始几何会 dispose；`src` 本身**不**从任何父节点摘除。
 */
export function mergeIntoNewRoot(src: THREE.Object3D): THREE.Group {
  const r = mergeIntoChunks(src);
  const root = new THREE.Group();
  for (const m of r.chunks) root.add(m);
  for (const m of r.keptMeshes) root.add(m);
  padBoundingSpheres(root);
  attachMergeStats(root, { meshes: r.infos.length, chunks: r.chunkCount, drawCallEst: r.drawCallEst });
  return root;
}
