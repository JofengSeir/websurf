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
 * 半透明图元专用的 cell 细化倍率（分桶时把 cellSize 除以本值后再归 cell）。
 *
 * 为什么单列：three 给合并产物算的排序键 z 是**整个合并几何的包围球中心**，同一个 chunk 的
 * 所有材质槽共用这一个 z（three 0.165 `WebGLRenderer.js:1342-1370` 的材质数组分支，循环内
 * z 不重新计算）⇒ 挤在同一块里的多个半透明槽，其绘制次序与摄像机位置无关、只取决于它们在
 * 材质数组里的下标。cell 越小，一块里的半透明越少，排序就越细。
 *
 * 代价是半透明块数变多；半透明在 BSP 地图里是少数（玻璃/水/冰），且不透明侧完全不受影响，
 * 故只对半透明这一路细化。取 4 = 每维 4 倍分辨率，块数上界仍是「半透明图元数」。
 */
const OPT_TRANS_CELL_DIV = 4;
/**
 * 视锥外保留圈的半径膨胀系数（分块结束时乘到每块的包围球半径上）。
 * three 的视锥剔除按 geometry.boundingSphere 判定，膨胀后视锥外一圈的块仍参与渲染 ⇒
 * 快速转动时新进入视野的块上一帧已在画，边缘不闪空。只影响剔除判定，不改几何与材质。
 */
const FRUSTUM_PAD = 1.6;

/**
 * 合并期细粒度计时（诊断用，默认零开销）：页面把 `globalThis.__vbspMergePerf = true` 后加载地图，
 * 合并结束会 `console.info('[merge-perf] …')` 打一行 JSON 分项，供 task-25 的链路分析取数。
 * 只在合并开始/结束与每个 cell 的粗粒度区间取 `performance.now()`，不改变任何几何/材质行为。
 */
interface MergePerf {
  t0: number;
  collect: number;
  cellAdapt: number;
  bucket: number;
  mergeTotal: number;
  multiBake: number;
  groupMerge: number;
  finalMerge: number;
  meshes: number;
  cells: number;
  chunks: number;
}

function mergePerfOn(): boolean {
  return (globalThis as unknown as { __vbspMergePerf?: boolean }).__vbspMergePerf === true;
}

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

/**
 * 这只 mesh 的材质是不是半透明。
 *
 * 判定直接取 `material.transparent` —— 它是 GLB 的 `alphaMode=BLEND` 经 GLTFLoader 落地的
 * 结果（`GLTFLoader.js:3573-3574`），而不是去读导出侧 extras 里的 `vbsp_translucent`：
 * 后者目前在本仓库的 TS 侧没有任何读取点（写了没人用），拿它当判据会把分块结果绑在一条
 * 无人验证的契约上。收集阶段已排除多材质 mesh，这里的数组分支只是类型收窄。
 */
function optIsTranslucent(m: THREE.Material | THREE.Material[]): boolean {
  return !Array.isArray(m) && m.transparent === true;
}

/**
 * 几何的「属性布局签名」。
 *
 * why：`mergeGeometries` 以组内第一份几何的属性键集合为基准，要求其余几何不多不少、
 * 同名属性 itemSize / normalized / 数组类型一致，且索引形态一致。GLB 里同一材质实例的
 * mesh 常有的带 `normal` / `uv1`、有的不带（水面、unlit prop 常见）。过去它们被塞进
 * 同一个合并组，两层合并（按材质子合并 + 多材质块最终合并）都会返回 null，只能回退成
 * 「各自保留独立几何」⇒ draw call 随组内 mesh 数线性增长。
 *
 * 做法：把签名并入两层分组键，让属性布局不同的几何自然落到不同组，每组都能真正合并。
 * **不改写任何几何数据**（补零法线会改变 vertex-lighting / lightmap 的材质路由，
 * 实测会造出 220 个「真漏网」mesh），签名是确定性字符串，Map 迭代仍按插入顺序。
 */
function optGeometrySignature(g: THREE.BufferGeometry): string {
  const parts: string[] = [`ix:${g.index ? 1 : 0}`];
  for (const name of Object.keys(g.attributes).sort()) {
    const a = g.attributes[name] as THREE.BufferAttribute;
    const holder = a as unknown as {
      gpuType?: number;
      isInterleavedBufferAttribute?: boolean;
      array?: { constructor?: { name?: string } };
      data?: { array?: { constructor?: { name?: string } } };
    };
    parts.push(
      `${name}:${a.itemSize}:${a.normalized ? 1 : 0}` +
      `:${holder.array?.constructor?.name ?? holder.data?.array?.constructor?.name ?? 'interleaved'}` +
      `:${holder.gpuType ?? 0}:${holder.isInterleavedBufferAttribute ? 1 : 0}`,
    );
  }
  parts.push(`morph:${Object.keys(g.morphAttributes).sort().join(',')}:${g.morphTargetsRelative ? 1 : 0}`);
  return parts.join('|');
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
  /** 半透明是否单独成块（T/O 分桶 + `cellSize/4`）。默认 `true`；`false` 用于 A/B 复现并块问题。 */
  translucentSplit?: boolean;
  /**
   * 目标块数（默认 512，主世界用）。只给**天空区**这类「一次整片可见、不需要逐块剔除」的对象
   * 调小：天空遍实测在水平线要画 160 多块（1.7ms），是俯仰掉帧的主要来源；天空区怎么合并都
   * 整片显示，块数只影响 draw 数。
   */
  targetCells?: number;
  /**
   * **不透明**图元的目标块数（默认与 `targetCells` 相同）。只给不透明桶用：半透明桶的 cell 边长
   * 永远由 `targetCells` 决定（再除以 `OPT_TRANS_CELL_DIV`），所以调这个值不会改变水面/冰面等
   * 半透明块的切分与镜面高度来源 —— 2026-11-13「合并粒度调粗导致水体消失」就是粗合并动了
   * 半透明桶，这里把两者拆开。
   *
   * 主世界用它换 draw 数：实测单 draw ≈ 7~10µs，开阔路段 344~368 块 / 344~503 draw 时主遍
   * 3~4.4ms，超过 320fps 的 3.12ms 预算；不透明块细分粒度减半能砍掉一半左右的 draw。
   */
  opaqueTargetCells?: number;
  /**
   * 排除谓词：返回 true 的 mesh 不进合并块，原样进入 `keptMeshes`（几何仍烘焙到世界
   * 空间、变换清成单位阵，与多材质保留口径一致）。
   *
   * 用途：需要保留模型身份、之后还要单独做变换的对象——`momentary_rot_button` 的符文盘
   * 就是这类（`rot-buttons.ts` 要把它们挂到 pivot 上转，合并掉就找不回模型边界了）。
   */
  exclude?: (mesh: THREE.Mesh) => boolean;
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
  /** 原 primitive 的 BSP 面序号（GLTF extras `faceIndex`；缺失时 undefined）。 */
  faceIndex?: number;
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
  const raw = (mesh.userData as { faceIndex?: unknown } | undefined)?.faceIndex;
  return {
    meshName: mesh.name ?? '',
    faceIndex: typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined,
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
    ranges.push({ start: cursor, count, meshName: seeds[i].meshName, faceIndex: seeds[i].faceIndex, vbsp: seeds[i].vbsp });
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
      ranges.push({ start: r.start + cursor, count: r.count, meshName: r.meshName, faceIndex: r.faceIndex, vbsp: r.vbsp });
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
  const perfOn = mergePerfOn();
  const perf: MergePerf = {
    t0: perfOn ? performance.now() : 0,
    collect: 0,
    cellAdapt: 0,
    bucket: 0,
    mergeTotal: 0,
    multiBake: 0,
    groupMerge: 0,
    finalMerge: 0,
    meshes: 0,
    cells: 0,
    chunks: 0,
  };
  // ① 收集：先刷新 matrixWorld 作为世界变换基准。多材质 mesh（GLB primitive 恒单材质，此处是
  //    防御路径）烘焙到世界空间后保留；无材质 mesh 原样跳过。两者都不参与分块
  const tCollect = perfOn ? performance.now() : 0;
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
    // 需要保留模型身份的对象（旋钮/符文盘这类要单独做变换的实体）：烘焙到世界空间后
    // 原样保留，不进合并块。口径与下面的多材质保留一致（顶点已在世界空间、变换清单位阵），
    // 方便调用方之后按自身 pivot 重新挂载。
    if (opts?.exclude?.(m)) {
      const baked = m.geometry.clone();
      baked.applyMatrix4(m.matrixWorld);
      m.geometry.dispose();
      m.geometry = baked;
      m.position.set(0, 0, 0);
      m.rotation.set(0, 0, 0);
      m.scale.set(1, 1, 1);
      m.updateMatrix();
      keptMeshes.push(m);
      return;
    }
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
  if (perfOn) perf.collect = performance.now() - tCollect;
  perf.meshes = infos.length;
  if (infos.length === 0) {
    return { infos, keptMeshes, chunks: [], cellSize: 0, cellsCount: 0, chunkCount: 0, vertsTotal: 0, drawCallEst: 0 };
  }

  // ①b 合并失败不丢几何：`mergeGeometries` 在属性集不一致时返回 null，而本函数每一处失败分支
  //     都回退成「保留各自独立几何」，不存在"合并失败就丢弃"的路径。

  // ② cell 边长自适应：初值取世界包围盒对角线 / cbrt(目标块数)，随后按非空 cell 数缩放（收敛到
  //    OPT_MIN_CELLS..OPT_MAX_CELLS；给了 `targetCells` 时按同一比例收窄上下限）
  const tCell = perfOn ? performance.now() : 0;
  const targetCells = Math.max(1, Math.round(opts?.targetCells ?? OPT_TARGET_CELLS));
  const minCells = Math.max(1, Math.min(OPT_MIN_CELLS, Math.round(targetCells * 0.6)));
  const maxCells = Math.max(minCells, Math.min(OPT_MAX_CELLS, Math.round(targetCells * 1.6)));
  const diag = Math.max(worldBox.getSize(new THREE.Vector3()).length(), 1);
  let cellSize = Math.min(Math.max(diag / Math.cbrt(targetCells), OPT_CELL_MIN), OPT_CELL_MAX);
  for (let i = 0; i < 6; i++) {
    const n = optCountCells(infos, cellSize);
    if (n >= minCells && n <= maxCells) break;
    const scale = Math.min(Math.max(Math.cbrt(n / targetCells), 0.55), 1.8);
    cellSize = Math.min(Math.max(cellSize * scale, OPT_CELL_MIN), OPT_CELL_MAX);
  }

  // ②b 不透明桶的 cell 边长（可选）：与半透明桶**分开算**，这样调粗不透明块不会顺带改变水面
  //    块的切分（半透明桶仍用 ② 算出的 `cellSize / OPT_TRANS_CELL_DIV`）。
  const opaqueInfos = opts?.translucentSplit !== false ? infos.filter((it) => !optIsTranslucent(it.mesh.material)) : infos;
  let cellSizeO = cellSize;
  if (opts?.opaqueTargetCells && opaqueInfos.length > 0) {
    const oTarget = Math.max(1, Math.round(opts.opaqueTargetCells));
    const oMin = Math.max(1, Math.min(OPT_MIN_CELLS, Math.round(oTarget * 0.6)));
    const oMax = Math.max(oMin, Math.min(OPT_MAX_CELLS, Math.round(oTarget * 1.6)));
    let cs = Math.min(Math.max(diag / Math.cbrt(oTarget), OPT_CELL_MIN), OPT_CELL_MAX);
    for (let i = 0; i < 6; i++) {
      const n = optCountCells(opaqueInfos, cs);
      if (n >= oMin && n <= oMax) break;
      const scale = Math.min(Math.max(Math.cbrt(n / oTarget), 0.55), 1.8);
      cs = Math.min(Math.max(cs * scale, OPT_CELL_MIN), OPT_CELL_MAX);
    }
    cellSizeO = cs;
  }
  if (perfOn) perf.cellAdapt = performance.now() - tCell;

  // ③ 分桶：按每个 mesh 的世界包围盒中心归 cell（横跨多 cell 的归中心所在 cell）。
  //    半透明另起一套更细的 cell 并单独成桶 —— 排序键 z 是「整块包围球中心、块内槽共用」，
  //    见 OPT_TRANS_CELL_DIV 处的说明。键前缀把两类桶彻底隔开：哪怕半透明细化后的 cell 编号
  //    与不透明的撞上，也进不到同一个桶。不透明侧的键与产物与改前逐字相同。
  const tBucket = perfOn ? performance.now() : 0;
  const cells = new Map<string, OptMeshInfo[]>();
  for (const it of infos) {
    // 面板可关：关掉后半透明与不透明同块（复现「水面被并进大块 ⇒ RT 自采样/放射反射」）。
    const isTrans = opts?.translucentSplit !== false && optIsTranslucent(it.mesh.material);
    const cs = isTrans ? cellSize / OPT_TRANS_CELL_DIV : cellSizeO;
    const key = (isTrans ? 'T' : 'O') + optCellKey(it.cx, it.cy, it.cz, cs);
    let arr = cells.get(key);
    if (!arr) {
      arr = [];
      cells.set(key, arr);
    }
    arr.push(it);
  }
  if (perfOn) {
    perf.bucket = performance.now() - tBucket;
    perf.cells = cells.size;
  }

  // ④ 合并：单 mesh 的 cell 保留原 mesh（几何烘焙到世界空间、变换清零）；多 mesh 的 cell
  //    先按材质实例分组子合并，再 mergeGeometries(useGroups = true) 合成一个 Mesh + 材质数组
  //    （groups 与材质数组下标一一对应）
  const chunks: THREE.Mesh[] = [];
  let chunkCount = 0;
  let drawCallEst = 0;
  let vertsTotal = 0;
  const tMerge = perfOn ? performance.now() : 0;
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
    const byMat = new Map<string, {
      mat: THREE.Material;
      geoms: THREE.BufferGeometry[];
      seeds: MergeSourceSeed[];
    }>();
    const tBake = perfOn ? performance.now() : 0;
    for (const it of arr) {
      const m = it.mesh;
      const mat = m.material as THREE.Material;
      const baked = m.geometry.clone();
      baked.applyMatrix4(m.matrixWorld);
      const key = `${mat.uuid}|${optGeometrySignature(baked)}`;
      let group = byMat.get(key);
      if (!group) {
        group = { mat, geoms: [], seeds: [] };
        byMat.set(key, group);
      }
      group.geoms.push(baked);
      group.seeds.push(meshSourceSeed(m));
    }
    if (perfOn) perf.multiBake += performance.now() - tBake;
    const mergedGeoms: THREE.BufferGeometry[] = [];
    // 与 mergedGeoms 同下标的来源表（null = 这一份没有表，最终合并出的块也不带表）
    const mergedTables: (MergeSourceTable | null)[] = [];
    const mats: THREE.Material[] = [];
    const tGroup = perfOn ? performance.now() : 0;
    for (const group of byMat.values()) {
      const mat = group.mat;
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
    if (perfOn) perf.groupMerge += performance.now() - tGroup;
    if (mergedGeoms.length === 0) {
      for (const it of arr) it.mesh.geometry.dispose();
      continue;
    }
    // ⑤ 最终合并：按属性签名分桶，每桶单独合成一个 Mesh + 材质数组。
    //    不同签名的几何硬塞进一次 mergeGeometries 必然返回 null；过去的防御分支只能
    //    「每个材质单独一块」，draw call 随之暴涨。分桶只改变分块边界，不改几何数据。
    const tFinal = perfOn ? performance.now() : 0;
    const finalGroups = new Map<string, {
      geoms: THREE.BufferGeometry[];
      mats: THREE.Material[];
      tables: (MergeSourceTable | null)[];
    }>();
    for (let i = 0; i < mergedGeoms.length; i++) {
      const sig = optGeometrySignature(mergedGeoms[i]);
      let grp = finalGroups.get(sig);
      if (!grp) {
        grp = { geoms: [], mats: [], tables: [] };
        finalGroups.set(sig, grp);
      }
      grp.geoms.push(mergedGeoms[i]);
      grp.mats.push(mats[i]);
      grp.tables.push(mergedTables[i]);
    }
    if (perfOn) perf.finalMerge += performance.now() - tFinal;
    const tFinalMerge = perfOn ? performance.now() : 0;
    for (const grp of finalGroups.values()) {
      let chunk: THREE.Mesh;
      if (grp.geoms.length === 1) {
        chunk = new THREE.Mesh(grp.geoms[0], grp.mats[0]);
        attachSourceTable(grp.geoms[0], grp.tables[0]);
        drawCallEst++;
      } else {
        // 归一后的数组既做最终合并的入参，也定区间表的长度口径（逐项对应）
        const normalized = (opts?.normalizeGroup ?? normalizeMergeGroup)(grp.geoms);
        const final = mergeGeometries(normalized, true);
        if (final) {
          for (const g of grp.geoms) if (g !== final) g.dispose();
          chunk = new THREE.Mesh(final, grp.mats);
          drawCallEst += final.groups.length;
          attachSourceTable(final, concatSourceTables(normalized, grp.tables));
        } else {
          // 极端防御：签名相同却仍失败时，每份单独一块
          chunk = new THREE.Mesh(grp.geoms[0], grp.mats[0]);
          attachSourceTable(grp.geoms[0], grp.tables[0]);
          drawCallEst++;
          for (let i = 1; i < grp.geoms.length; i++) {
            const extra = new THREE.Mesh(grp.geoms[i], grp.mats[i]);
            attachSourceTable(grp.geoms[i], grp.tables[i]);
            chunks.push(extra);
            chunkCount++;
            drawCallEst++;
          }
        }
      }
      chunks.push(chunk);
      chunkCount++;
    }
    if (perfOn) perf.finalMerge += performance.now() - tFinalMerge;
    for (const it of arr) it.mesh.geometry.dispose();
    for (const g of mergedGeoms) vertsTotal += g.attributes.position.count;
  }

  if (perfOn) {
    perf.mergeTotal = performance.now() - tMerge;
    perf.chunks = chunkCount;
    perf.t0 = performance.now() - perf.t0;
    console.info('[merge-perf] ' + JSON.stringify(perf));
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
export function mergeIntoNewRoot(src: THREE.Object3D, opts?: MergeOptions): THREE.Group {
  const r = mergeIntoChunks(src, opts);
  const root = new THREE.Group();
  for (const m of r.chunks) root.add(m);
  for (const m of r.keptMeshes) root.add(m);
  padBoundingSpheres(root);
  attachMergeStats(root, { meshes: r.infos.length, chunks: r.chunkCount, drawCallEst: r.drawCallEst });
  return root;
}

// ── 不透明几何按材质全局合批（task-30 / PERF_ARCH_PLAN §2-A）────────────────────────────
// 现状：mergeIntoChunks 以 chunk(cell) 为一级分桶，同一材质在不同 chunk 各成一组 draw
// （surf_boreas 终点机位实测 154 块 / 259 材质组，只有 55 种材质）。这里在 chunk 合并之后
// 再做一级「按材质」合批：同材质（+ 属性签名 + 父节点，可选空间格）跨 chunk 合成一个
// 单材质 Mesh（无 groups ⇒ 1 draw）。保留三样东西：
// - 世界坐标/单位变换（与 chunk 一致，新 mesh 直接挂回同一父节点）；
// - 顶点属性（含 `_vbsp_face`，cluster-filter 的逐三角形 PVS 过滤靠它按三角形取 cluster）；
// - 来源区间表（`lookupMergeSource` 拾取仍能按面号反查原 mesh / faceIndex / vbsp 元数据）。
// 安全边界：只处理「全部材质槽都不透明」的 Mesh；旋钮/符文盘（`userData.vbspRot`）、
// 半透明/水面/天空、以及多材质里混了透明槽的块一律不动。关掉（A/B，装载期读一次）：
// `globalThis.__vbspOpaqueMatMergeOff = true`。
const OPAQUE_MAT_MERGED_KEY = 'vbspOpaqueMatMerged';

export interface OpaqueMatMergeOptions {
  /** 额外的材质过滤（默认只做上面的基础判定）。 */
  includeMaterial?: (material: THREE.Material) => boolean;
  /** >0 时再按世界空间格二级分桶（HU；0/未给 = 只按材质全局合批）。A/B：`__vbspOpaqueMatMergeCell`。 */
  spatialCell?: number;
  /** true = 只统计不改场景（诊断）。 */
  dryRun?: boolean;
}

export interface OpaqueMatMergeStats {
  /** 输入 Mesh 数（root 下被扫到的）。 */
  meshes: number;
  /** 参与合并的材质槽数（≈ 合并前的 draw 数）。 */
  slots: number;
  /** 唯一材质数。 */
  materials: number;
  /** 实际合成的 Mesh 数（单槽桶保留原 mesh，不新建）。 */
  mergedMeshes: number;
  /** 合并后新增/保留的 draw 数（= 新建 mesh 数 + 未合并的单槽原 mesh 数）。 */
  drawCallsAfter: number;
  removedMeshes: number;
  failed: number;
  tris: number;
  ms: number;
  skipped: Record<string, number>;
}

/** 材质槽提取结果：几何（与源共享属性数组或整份原几何）+ 自己的来源表。 */
interface OpaqueSlotSource {
  mesh: THREE.Mesh;
  parent: THREE.Object3D;
  /** 单材质 mesh 直接用整份几何；多材质 mesh 按 group 切出来的新几何（共享属性）。 */
  geometry: THREE.BufferGeometry;
  table: MergeSourceTable | null;
  material: THREE.Material;
  renderOrder: number;
  layersMask: number;
}

/** 一只 mesh 的合并资格与清理状态。 */
interface OpaqueMeshState {
  parent: THREE.Object3D;
  /** 该 mesh 贡献的材质槽数（单材质 mesh = 1；多材质 = groups 数）。 */
  slots: number;
  /** 需要额外 dispose 的临时几何（烘焙克隆 / group 切片）。 */
  tempGeoms: THREE.BufferGeometry[];
}

export function mergeOpaqueByMaterial(
  root: THREE.Object3D,
  opts?: OpaqueMatMergeOptions,
): OpaqueMatMergeStats | null {
  const globals = globalThis as unknown as {
    __vbspOpaqueMatMergeOff?: boolean;
    __vbspOpaqueMatMergeCell?: number;
  };
  if (globals.__vbspOpaqueMatMergeOff === true) return null;
  const cellSize = Math.max(0, Math.round(opts?.spatialCell ?? globals.__vbspOpaqueMatMergeCell ?? 0));
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const skipped: Record<string, number> = {};
  const why = (k: string): void => {
    skipped[k] = (skipped[k] ?? 0) + 1;
  };
  const stats: OpaqueMatMergeStats = {
    meshes: 0, slots: 0, materials: 0, mergedMeshes: 0, drawCallsAfter: 0, removedMeshes: 0,
    failed: 0, tris: 0, ms: 0, skipped,
  };

  // ① 收集：扫 root 下所有 mesh，逐个材质槽判断资格（不透明才收）。
  interface Bucket {
    material: THREE.Material;
    parent: THREE.Object3D;
    renderOrder: number;
    layersMask: number;
    slots: OpaqueSlotSource[];
  }
  const buckets = new Map<string, Bucket>();
  const materialSet = new Set<string>();
  const meshStates = new Map<THREE.Mesh, OpaqueMeshState>();
  const center = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom || !geom.getAttribute('position')) return;
    if ((mesh.userData as { vbspRot?: unknown })?.vbspRot) { why('rot'); return; }
    if (Object.keys(geom.morphAttributes).length > 0) { why('morph'); return; }
    if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) { why('skinned'); return; }
    if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) { why('instanced'); return; }
    const rawMat = mesh.material;
    const mats = Array.isArray(rawMat) ? rawMat : [rawMat];
    if (mats.length === 0 || mats.some((m) => !m)) { why('noMaterial'); return; }
    if (mats.some((m) => !isOpaqueMergeMaterial(m as THREE.Material, opts?.includeMaterial))) {
      why('transparent');
      return;
    }
    if (mesh.visible === false) { why('hidden'); return; }
    stats.meshes++;
    const parent = mesh.parent ?? root;
    const state: OpaqueMeshState = { parent, slots: 0, tempGeoms: [] };
    meshStates.set(mesh, state);
    const srcTable = (geom.userData?.[MERGE_SOURCE_TABLE_KEY] as MergeSourceTable | undefined) ?? null;
    let baked = geom;
    if (!isIdentityMatrix(mesh.matrixWorld)) {
      baked = geom.clone();
      baked.applyMatrix4(mesh.matrixWorld);
      state.tempGeoms.push(baked);
    }
    const addSlot = (slotGeom: THREE.BufferGeometry, table: MergeSourceTable | null, material: THREE.Material): void => {
      const sig = optGeometrySignature(slotGeom);
      let cellKey = '';
      if (cellSize > 0) {
        if (!slotGeom.boundingBox) slotGeom.computeBoundingBox();
        slotGeom.boundingBox?.getCenter(center);
        cellKey = '|' + optCellKey(center.x, center.y, center.z, cellSize);
      }
      const key =
        parent.uuid + '|' + material.uuid + '|' + sig + '|' + mesh.renderOrder + '|' + mesh.layers.mask + cellKey;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { material, parent, renderOrder: mesh.renderOrder, layersMask: mesh.layers.mask, slots: [] };
        buckets.set(key, bucket);
      }
      bucket.slots.push({ mesh, parent, geometry: slotGeom, table, material, renderOrder: mesh.renderOrder, layersMask: mesh.layers.mask });
      stats.slots++;
      state.slots++;
      materialSet.add(material.uuid);
    };
    if (!Array.isArray(rawMat)) {
      // 单材质：整份几何一个槽（来源表随几何走；没有表就让下游兜底建一条）。
      addSlot(baked, srcTable, mats[0] as THREE.Material);
      return;
    }
    // 多材质：按 groups 逐槽切几何；先全部切成功再入桶，避免「半合并 + 原 mesh 又保留」的重复 draw。
    if (baked.groups.length === 0) {
      why('nogroups');
      meshStates.delete(mesh);
      return;
    }
    const pending: Array<{ geometry: THREE.BufferGeometry; table: MergeSourceTable | null; material: THREE.Material }> = [];
    for (const g of baked.groups) {
      const material = g.materialIndex === undefined ? undefined : (mats[g.materialIndex] as THREE.Material | undefined);
      if (!material) { why('groupMaterial'); meshStates.delete(mesh); return; }
      const extracted = extractSlotGeometry(baked, g.start, g.count);
      if (!extracted) { why('extract'); meshStates.delete(mesh); return; }
      state.tempGeoms.push(extracted);
      pending.push({ geometry: extracted, table: srcTable ? sliceSourceTable(srcTable, g.start, g.count) : null, material });
    }
    for (const p of pending) addSlot(p.geometry, p.table, p.material);
  });
  if (buckets.size === 0) {
    // 全是「一次性槽」：没有可合并的桶，场景保持原样（draw 数 = 收集到的槽数）。
    for (const state of meshStates.values()) {
      for (const g of state.tempGeoms) g.dispose();
    }
    stats.drawCallsAfter = stats.slots;
    stats.ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    return stats;
  }

  // ② 只保留「全部槽都会进多槽桶」的 mesh：落在单槽桶里的 mesh 原样保留，避免合并副本 + 原 mesh
  //    重复绘制（同一三角形画两遍虽不可见，但白花一次 draw；也会让 draw 统计失真）。
  for (;;) {
    let single: Bucket | null = null;
    for (const b of buckets.values()) {
      if (b.slots.length === 1) { single = b; break; }
    }
    if (!single) break;
    const mesh = single.slots[0].mesh;
    const keys = Array.from(buckets.keys());
    for (const k of keys) {
      const b = buckets.get(k);
      if (!b) continue;
      b.slots = b.slots.filter((s) => s.mesh !== mesh);
      if (b.slots.length === 0) buckets.delete(k);
    }
  }

  // ③ 逐桶合并：mergeGeometries 合成单材质 Mesh（无 groups ⇒ 1 draw）。
  const mergedSlots = new Map<THREE.Mesh, number>();
  for (const bucket of buckets.values()) {
    const geoms = bucket.slots.map((s) => s.geometry);
    const tables = bucket.slots.map(
      (s) => s.table ?? buildSourceTable([s.geometry], [meshSourceSeed(s.mesh)]),
    );
    let merged = mergeGeometries(geoms, false);
    let tableGeoms = geoms;
    if (!merged) {
      const norm = normalizeMergeGroup(geoms);
      merged = mergeGeometries(norm, false);
      if (merged) tableGeoms = norm;
    }
    if (!merged) {
      // 合并失败：该桶原样保留（没有 mergedSlots 记账，原 mesh 不会被摘除）。
      stats.failed++;
      continue;
    }
    if (opts?.dryRun) {
      merged.dispose();
      stats.mergedMeshes++;
      continue;
    }
    // 几何已在世界坐标；包围球/盒重算并垫同样的视锥余量（与 chunk 一致）。
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    if (merged.boundingSphere) (merged.boundingSphere as THREE.Sphere).radius *= FRUSTUM_PAD;
    const mesh = new THREE.Mesh(merged, bucket.material);
    mesh.name = `matBatch:${bucket.material.name || bucket.material.uuid}`;
    mesh.renderOrder = bucket.renderOrder;
    mesh.layers.mask = bucket.layersMask;
    mesh.userData[OPAQUE_MAT_MERGED_KEY] = true;
    attachSourceTable(merged, concatSourceTables(tableGeoms, tables));
    bucket.parent.add(mesh);
    stats.mergedMeshes++;
    stats.tris += merged.index ? merged.index.count / 3 : (merged.getAttribute('position') as THREE.BufferAttribute).count / 3;
    for (const s of bucket.slots) {
      mergedSlots.set(s.mesh, (mergedSlots.get(s.mesh) ?? 0) + 1);
    }
  }

  // ④ 替换：所有槽都被合并的 mesh 摘除 + dispose（临时烘焙/切片几何一并释放）。
  //    dryRun 时只统计、不动场景。
  let keptDraws = 0;
  for (const [mesh, state] of meshStates) {
    const covered = mergedSlots.get(mesh) ?? 0;
    if (!opts?.dryRun && covered > 0 && covered >= state.slots) {
      state.parent.remove(mesh);
      mesh.geometry.dispose();
      stats.removedMeshes++;
    }
    for (const g of state.tempGeoms) {
      if (g !== mesh.geometry) g.dispose();
    }
    // 没被合并掉的 mesh 原样留在场景里（单槽桶被排除 / 桶合并失败），draw 按原槽数计。
    if (covered < state.slots) keptDraws += state.slots - covered;
  }
  stats.drawCallsAfter = opts?.dryRun ? stats.slots : stats.mergedMeshes + keptDraws;

  stats.materials = materialSet.size;
  stats.ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  return stats;
}

/** 材质是否可按「不透明」合批：普通不透明（含 alphaTest 镂空）才收，混合/透明/不写深度一律不收。 */
function isOpaqueMergeMaterial(
  mat: THREE.Material,
  include?: (m: THREE.Material) => boolean,
): boolean {
  if (!mat) return false;
  if (mat.visible === false) return false;
  if (mat.transparent === true) return false;
  if (mat.blending !== THREE.NormalBlending) return false;
  if (mat.depthWrite === false) return false;
  if ((mat.userData as { vbspNoMatMerge?: boolean })?.vbspNoMatMerge === true) return false;
  return include ? include(mat) : true;
}

/** 矩阵是否单位阵（内容比较，不看 matrixWorldNeedsUpdate）。 */
function isIdentityMatrix(m: THREE.Matrix4): boolean {
  const e = m.elements;
  const id = IDENTITY_ELEMENTS;
  for (let i = 0; i < 16; i++) {
    if (Math.abs(e[i] - id[i]) > 1e-9) return false;
  }
  return true;
}
const IDENTITY_ELEMENTS = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * 从几何里切出一个 group 区间的子几何。索引几何只复制 index 缓冲（属性数组共享，最终
 * mergeGeometries 会把数据复制走，因此不会把源几何的缓冲区搞坏）；非索引几何按顶点区间
 * 逐属性切片。返回 null 表示该形态（交错属性/异常区间）不支持，调用方保守跳过。
 */
function extractSlotGeometry(
  geom: THREE.BufferGeometry,
  start: number,
  count: number,
): THREE.BufferGeometry | null {
  if (!(count > 0)) return null;
  const index = geom.index;
  const pos = geom.getAttribute('position');
  const maxLen = index ? index.count : pos ? pos.count : 0;
  const from = Math.max(0, Math.floor(start));
  const to = Math.min(maxLen, from + Math.floor(count));
  if (to <= from) return null;
  const out = new THREE.BufferGeometry();
  if (index) {
    const src = index.array as ArrayLike<number>;
    const idx = new Uint32Array(to - from);
    for (let i = from; i < to; i++) idx[i - from] = src[i];
    for (const name of Object.keys(geom.attributes)) out.setAttribute(name, geom.attributes[name]);
    out.setIndex(new THREE.BufferAttribute(idx, 1));
  } else {
    for (const name of Object.keys(geom.attributes)) {
      const attr = geom.attributes[name];
      if ((attr as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) return null;
      const a = attr as THREE.BufferAttribute;
      const itemSize = a.itemSize;
      const arr = a.array as ArrayLike<number>;
      const begin = from * itemSize;
      const end = to * itemSize;
      const slice = new (a.array.constructor as new (n: number) => Float32Array)(end - begin);
      for (let i = begin; i < end; i++) slice[i - begin] = arr[i];
      out.setAttribute(name, new THREE.BufferAttribute(slice, itemSize, a.normalized));
    }
  }
  return out;
}

/** 把来源区间表裁到某个 group 区间（`start/count` 与表自己的缓冲口径一致）。 */
function sliceSourceTable(table: MergeSourceTable, start: number, count: number): MergeSourceTable | null {
  const from = start;
  const to = start + count;
  const ranges: MergeSourceRange[] = [];
  for (const r of table.ranges) {
    const s = Math.max(r.start, from);
    const e = Math.min(r.start + r.count, to);
    if (e <= s) continue;
    ranges.push({ start: s - from, count: e - s, meshName: r.meshName, faceIndex: r.faceIndex, vbsp: r.vbsp });
  }
  return ranges.length > 0 ? { indexed: table.indexed, ranges } : null;
}
