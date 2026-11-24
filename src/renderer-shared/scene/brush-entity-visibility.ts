/**
 * 合并几何上的实体级可见性（renderer-shared 共享模块）。
 *
 * 补的缺口：地图里大量 `func_brush` / `func_wall_toggle`（以及开门行为体）在运行期被脚本
 * `Enable` / `Disable` / `Toggle`。TS 实体层已实现这套语义：`brushSetEnabled()` 改内部 `brushOn`
 * 并把 `setBrushEnabled(实体下标, on)` 交给观测宿主（`src/ts-shared/entity/attach.ts:73` →
 * `{kind:'brush', detail:'<下标>:<true|false>'}`）。但合并渲染链在几何合批后只留一张大 buffer，
 * 实体层的开关没有渲染侧消费方，所以「脚本把实体关了」在画面上仍然可见。
 *
 * 做法（只按区间操作合并 buffer，不改核心渲染语义：不动材质、不改分组、不动 draw call /
 * drawRange、不重算包围体——退化三角形仍在原包围体内，剔除结果不变）：
 *   - `build(sceneRoot)` 时遍历场景根，读每张合并几何的
 *     `geometry.userData['websurfMergeSourceTable']`（见 `src/renderer-shared/scene/scene-optimizer.ts`），
 *     按 `meshName === 'brush_<实体下标>'` 把区间归到实体，建「实体 → 区间槽」索引（每个实体可跨
 *     多张几何/多材质，全部区间一起切换）。
 *   - 索引几何且**没有** PVS 逐三角形状态：把区间内的 index 全写成同一个顶点（0）→ 三角形面积为零，
 *     不产生片元；恢复时把备份的 index 片段逐元素写回。
 *   - 索引几何但被 PVS 接管（`mesh.userData.clusterIndex.origIndex` 存在）：相机换房间时
 *     `src/renderer-shared/scene/cluster-filter.ts` 会按可见性**重排/裁剪 `geometry.index`**，来源表
 *     的区间偏移不再对应实体三角形，直接写 index 会打到别的三角形。此时改读 `origIndex`（原始顺序，
 *     与来源表同序）拿实体三角形自己的顶点，塌缩这些顶点的 position——PVS 从不写 position，口径稳定。
 *   - 非索引几何：没法「把三角形退化成一点」，只能把区间内每个顶点的 position 三坐标写成
 *     该区间首顶点坐标 → 三角形塌成一点；恢复时写回原坐标。同样不改几何结构。
 *
 * 边界（如实标注）：
 *   - 只处理**印在来源表里的 brush 区间**；没有来源表（或表形态校验失败）的几何不计入索引，
 *     之后的事件只计「未定位」，不做任何隐藏——不会误伤别的几何。
 *   - `table.indexed` 与实际 `geometry.index` 可能不一致（装载后 46/324 张），因此单位口径
 *     **以 geometry.index 是否存在为准**，并要求区间首尾相接覆盖整个 buffer 才接受该表
 *     （宁可跳过也不猜单位：表形态不一致时任何偏移都可能是错的）。
 *   - PVS 重排几何建索引时检查实体顶点是否与其它区间共享（合并是逐源拼接，正常不共享；一旦共享，
 *     塌缩会波及别的实体）——共享就整张几何跳过并记限制，不做「可能误伤别人」的写。
 *   - 本模块只负责渲染侧区间操作；事件 detail 解析、`entityIoJson.entities_text` 初态解析留在
 *     应用层（debug 增强插件），日志/状态行文案也留在应用层。
 *
 * 性能：由调用方按需实例化；`build()` 只遍历一次场景（O(区间数)），之后每个 brush 事件只写
 * 受影响的区间片段（`needsUpdate` 由渲染器在下一帧上传）。
 *
 * 本模块故意不 import three、也不 import 任何应用代码：场景根与几何都按结构类型自省，
 * 保证可被 debug 插件以及将来 game/viewer 共用，不把 three 类型带进调用方。
 */

/** 合并来源表挂在几何 userData 上的键（与 `scene-optimizer.ts` 的 `MERGE_SOURCE_TABLE_KEY` 一致，改动需同步）。 */
const MERGE_SOURCE_TABLE_KEY = 'websurfMergeSourceTable';
/**
 * 来源表里「挂在实体上的区间」名字前缀：
 * - `brush_<实体下标>`：brush 实体（门/移动平台/可碎墙…），用于隐藏与位移；
 * - `prop_<实体下标>`：prop 实体（道具/矿车模型…），只用于位移（父 brush 运动时子 prop 跟随）。
 */
const ENTITY_MESH_PREFIXES = ['brush_', 'prop_'] as const;

// ── 结构类型：本模块不 import three，只描述自省所需的最小形状 ─────────────────
interface NumericArray {
  readonly length: number;
  [index: number]: number;
}

interface AttributeLike {
  readonly array: NumericArray;
  readonly count: number;
  needsUpdate?: boolean;
}

interface GeometryLike {
  readonly index: AttributeLike | null;
  readonly attributes: { readonly position?: AttributeLike };
  readonly userData?: Record<string, unknown>;
}

interface MeshLike {
  readonly isMesh?: boolean;
  readonly geometry?: GeometryLike;
  readonly userData?: Record<string, unknown>;
}

/**
 * PVS 逐三角形过滤挂在 mesh.userData 上的状态（见 `src/renderer-shared/scene/cluster-filter.ts`）。
 * `origIndex` 是**原始顺序**的索引缓冲副本（triangle t 的顶点 = origIndex[3t..3t+2]），
 * 与来源表区间口径一致；相机换房间时 `geometry.index`（outIndex）会被按可见三角形重排/裁剪。
 */
interface ClusterIndexLike {
  readonly origIndex?: NumericArray;
}

interface SceneRootLike {
  traverse(callback: (object: MeshLike) => void): void;
}

interface SourceRangeLike {
  readonly start?: unknown;
  readonly count?: unknown;
  readonly meshName?: unknown;
}

interface SourceTableLike {
  readonly indexed?: unknown;
  readonly ranges?: unknown;
}

/**
 * 区间槽口径：
 * - `index`：几何没有 PVS 逐三角形过滤（`geometry.index` 与来源表同序）→ 区间内索引写 0；
 * - `position`：非索引几何 → 区间内顶点位置塌同一点；
 * - `vertex`：几何被 PVS 接管（相机换房间时 `cluster-filter` 按可见性重排 `geometry.index`，
 *   来源表的偏移不再对应实体三角形）→ 按 `clusterIndex.origIndex` 拿到实体三角形自己的顶点，
 *   塌缩这些顶点的 position（PVS 从不写 position，所以口径稳定）。
 */
type SlotKind = 'index' | 'position' | 'vertex';

interface Slot {
  readonly attribute: AttributeLike;
  readonly array: NumericArray;
  readonly kind: SlotKind;
  /** index 模式：登记时的几何与其 index 缓冲；用于发现运行期被 PVS 换掉的缓冲。 */
  readonly geometry?: GeometryLike;
  /** index 模式：登记时固化的 index 属性（PVS 运行时开起来会换成新属性）。 */
  readonly captured?: AttributeLike;
  /** 区间起点（索引缓冲元素 / 顶点，取决于 kind；vertex 模式不使用）。 */
  readonly start: number;
  /** 区间长度（元素数；三角形数 = count / 3）。 */
  readonly count: number;
  /** 每单位在 array 里的原始元素数：index=1，position=3。 */
  readonly width: 1 | 3;
  /** 该区间用到的顶点下标（去重；index 模式从 index 缓冲收集，position 模式连续区间）。 */
  readonly vertices?: readonly number[];
  /** 顶点位置属性/缓冲（位移写回用；index 模式下它和 `attribute` 不是同一个）。 */
  readonly positionAttribute?: AttributeLike;
  readonly positionArray?: NumericArray;
  /** 顶点基准位置（与 `vertices` 同序，每顶点 3 个元素；位移 = base + offset）。 */
  readonly basePositions?: number[];
  /** 隐藏前的原始 index 元素备份（仅 index 模式；null = 当前未隐藏）。 */
  backup: number[] | null;
}

interface EntityBinding {
  readonly entityIndex: number;
  readonly slots: Slot[];
  /** 该实体全部区间的三角形数。 */
  triangles: number;
  /** 其中按 index 写 0 隐藏的区间数。 */
  indexSlots: number;
  /** 其中靠顶点塌缩隐藏的区间数（非索引 / PVS 重排几何，如实暴露口径）。 */
  vertexSlots: number;
  hidden: boolean;
  /** 当前位移（相对 BSP 出生位置，Y-up）；隐藏时仍记录，恢复时按它写回。 */
  offset: [number, number, number];
}

/** `stats()` 的诊断口径（与应用层状态行/日志字段一一对应）。 */
export interface BrushEntityVisibilityStats {
  /** 是否成功接收场景根并建立索引（false = 状态行显示「尚未载图」）。 */
  readonly sceneLoaded: boolean;
  /** 已建索引的实体数。 */
  readonly entities: number;
  /** 区间槽总数（同一实体跨多张几何/多材质会累加）。 */
  readonly slots: number;
  /** 区间覆盖的三角形总数。 */
  readonly triangles: number;
  /** 其中按 index 写 0 隐藏的区间数。 */
  readonly indexSlots: number;
  /** 其中按顶点塌缩隐藏的区间数（非索引 / PVS 重排几何）。 */
  readonly vertexSlots: number;
  readonly hiddenEntities: number;
  readonly hiddenSlots: number;
  readonly hiddenTriangles: number;
  readonly hiddenIndexSlots: number;
  readonly hiddenVertexSlots: number;
  /** 收到 brush 事件但定位不到区间的次数（不会误伤其它几何）。 */
  readonly unresolvedEvents: number;
  /** 当前「应隐藏」实体数（事件 + 载图初态；PVS 重建后按它重放）。 */
  readonly desiredHidden: number;
  /** 接受索引的来源表几何张数。 */
  readonly tablesAccepted: number;
  /** 因表形态/区间共享冲突被整张跳过的来源表几何张数。 */
  readonly skippedGeometries: number;
  /** PVS 运行期换掉 index 缓冲后自动重建索引的次数。 */
  readonly rebuilds: number;
  /** 建索引时记录的限制文本（只读引用；状态行通常只显示条数）。 */
  readonly limitations: readonly string[];
}

/** `setEntityHidden()` 的结果：调用方据此保持原有日志文案与顺序。 */
export type BrushEntityHideResult =
  | { readonly status: 'changed'; readonly rebuilt: boolean; readonly triangles: number; readonly slots: number }
  | { readonly status: 'unchanged'; readonly rebuilt: boolean }
  | { readonly status: 'unresolved'; readonly rebuilt: boolean };

/** `setEntityOffset()` 的结果：位移与隐藏一样，定位不到时只计数、不误伤几何。 */
export type BrushEntityOffsetResult =
  | { readonly status: 'changed'; readonly rebuilt: boolean; readonly triangles: number; readonly slots: number }
  | { readonly status: 'unchanged'; readonly rebuilt: boolean }
  | { readonly status: 'unresolved'; readonly rebuilt: boolean };

// ── 纯函数 helper ───────────────────────────────────────────────────────────

/** 从区间名解析实体下标；非实体区间 / 名字不合法返回 null。 */
function entityIndexFromRangeName(meshName: string): number | null {
  for (const prefix of ENTITY_MESH_PREFIXES) {
    if (!meshName.startsWith(prefix)) continue;
    const suffix = meshName.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) return null;
    const index = Number.parseInt(suffix, 10);
    return Number.isSafeInteger(index) ? index : null;
  }
  return null;
}

/** 读并浅校验来源表；没有表/空表返回 null（视作普通几何，不碰）。 */
function sourceTableOf(geometry: GeometryLike): SourceTableLike | null {
  const raw = geometry.userData?.[MERGE_SOURCE_TABLE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const table = raw as SourceTableLike;
  if (!Array.isArray(table.ranges) || table.ranges.length === 0) return null;
  return table;
}

/**
 * 表形态校验：整数、%3 对齐、首尾相接、覆盖整个 buffer。
 * 表按升序连续覆盖整张 buffer；不满足说明口径不一致（宁可跳过也不猜单位）。
 */
function validateRanges(
  rawRanges: readonly unknown[],
  bufferLength: number,
): { ranges: { start: number; count: number; meshName: string }[] } | null {
  const ranges: { start: number; count: number; meshName: string }[] = [];
  let cursor = 0;
  for (const raw of rawRanges) {
    if (!raw || typeof raw !== 'object') return null;
    const { start, count, meshName } = raw as SourceRangeLike;
    if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) return null;
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return null;
    if (typeof meshName !== 'string') return null;
    if (start !== cursor || start % 3 !== 0 || count % 3 !== 0) return null;
    cursor += count;
    ranges.push({ start, count, meshName });
  }
  return cursor === bufferLength ? { ranges } : null;
}

/** 区间内 index 全写 0（退化三角形：三个索引指向同一顶点）。 */
function degenerateIndexes(slot: Slot): void {
  const { array, start, count } = slot;
  for (let i = 0; i < count; i += 1) array[start + i] = 0;
}

/** 非索引几何：区间内每个顶点位置塌到区间首顶点（退化三角形），不改 buffer 结构。 */
function collapsePositions(slot: Slot): void {
  const { array, start, count } = slot;
  const anchorOffset = start * 3;
  const anchorX = array[anchorOffset];
  const anchorY = array[anchorOffset + 1];
  const anchorZ = array[anchorOffset + 2];
  for (let vertex = 0; vertex < count; vertex += 1) {
    const offset = (start + vertex) * 3;
    array[offset] = anchorX;
    array[offset + 1] = anchorY;
    array[offset + 2] = anchorZ;
  }
}

/** 备份一组顶点的 position 三元组。 */
function copyVertices(array: NumericArray, vertices: readonly number[]): number[] {
  const backup = new Array<number>(vertices.length * 3);
  for (let i = 0; i < vertices.length; i += 1) {
    const offset = vertices[i] * 3;
    backup[i * 3] = array[offset];
    backup[i * 3 + 1] = array[offset + 1];
    backup[i * 3 + 2] = array[offset + 2];
  }
  return backup;
}

/**
 * 把一组顶点位置写成 `base + offset`（移动 brush 的逐帧位移）。
 *
 * 只写 position、不碰 index：几何是按来源合并的静态缓冲，没有「实体 → 节点变换」，
 * 实体的出生位置已经烘进顶点（BSP 几何 + origin 平移），所以位移只能在顶点上做。
 * 位移与隐藏互斥：隐藏时区间已被塌缩，调用方只在 `!binding.hidden` 时写。
 */
function writeVertexPositions(
  array: NumericArray,
  vertices: readonly number[],
  base: readonly number[],
  offset: readonly [number, number, number],
): void {
  for (let i = 0; i < vertices.length; i += 1) {
    const target = vertices[i] * 3;
    array[target] = base[i * 3] + offset[0];
    array[target + 1] = base[i * 3 + 1] + offset[1];
    array[target + 2] = base[i * 3 + 2] + offset[2];
  }
}

/** 连续区间顶点下标（非索引几何：一个区间就是一串顶点）。 */
function continuousVertices(start: number, count: number): number[] {
  const vertices = new Array<number>(count);
  for (let i = 0; i < count; i += 1) vertices[i] = start + i;
  return vertices;
}

/** 把一组顶点位置塌到首顶点（退化三角形）；PVS 只重排 index，position 稳定。 */
function collapseVertices(array: NumericArray, vertices: readonly number[]): void {
  const anchorOffset = vertices[0] * 3;
  const anchorX = array[anchorOffset];
  const anchorY = array[anchorOffset + 1];
  const anchorZ = array[anchorOffset + 2];
  for (const vertex of vertices) {
    const offset = vertex * 3;
    array[offset] = anchorX;
    array[offset + 1] = anchorY;
    array[offset + 2] = anchorZ;
  }
}

/** 从 origin 数组收集区间内三角形用到的顶点（去重，保持出现顺序）。 */
function collectRangeVertices(origIndex: NumericArray, start: number, count: number): number[] {
  const seen = new Set<number>();
  const vertices: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const vertex = origIndex[start + i];
    if (!seen.has(vertex)) {
      seen.add(vertex);
      vertices.push(vertex);
    }
  }
  return vertices;
}

/** 复制 array 的一段原始元素（隐藏前备份）。 */
function copyRange(array: NumericArray, offset: number, length: number): number[] {
  const backup = new Array<number>(length);
  for (let i = 0; i < length; i += 1) backup[i] = array[offset + i];
  return backup;
}

// ── 主体 ───────────────────────────────────────────────────────────────────

/**
 * 「实体下标 → 合并几何区间槽」索引 + 隐藏/恢复操作。
 *
 * 生命周期：`build(sceneRoot)` → 若干次 `setEntityHidden()` / `applyInitialHidden()` →
 * 换图前 `restoreAll()` + 再次 `build()`；插件 dispose 时 `dispose()`。
 */
export class BrushEntityVisibility {
  /** 本图「实体 → 区间」索引；换图/卸载时清空。 */
  private readonly bindings = new Map<number, EntityBinding>();
  /** 本图建立索引时遇到的口径/形态限制（状态行只显示条数，细节由调用方记日志）。 */
  private readonly limitations: string[] = [];
  private sceneLoaded = false;
  /** 当前场景根（换图时替换；PVS 运行时换 index 缓冲后按它重建索引）。 */
  private root: SceneRootLike | null = null;
  /** 事件与载图初态共同驱动的「应隐藏」集合；重建索引后按它重放。 */
  private readonly desiredHidden = new Set<number>();
  /** 移动 brush 的位移镜像（事件驱动的绝对偏移；重建索引后按它重放）。 */
  private readonly desiredOffsets = new Map<number, [number, number, number]>();
  private tablesAccepted = 0;
  private tablesRejected = 0;
  private bindingSlots = 0;
  private bindingTriangles = 0;
  private indexSlots = 0;
  private vertexSlots = 0;
  private hiddenEntities = 0;
  private hiddenSlots = 0;
  private hiddenTriangles = 0;
  private hiddenIndexSlots = 0;
  private hiddenVertexSlots = 0;
  private unresolvedEvents = 0;
  private rebuilds = 0;

  /**
   * 用宿主注入的场景根重建索引：先恢复旧隐藏，再遍历场景登记所有来源表几何的 brush 区间。
   *
   * `sceneRoot` 在各端是 `EnhanceSceneContext.sceneRoot`（契约故意为 unknown）；这里只要求
   * `traverse(callback)`，callback 收到的对象按 `{isMesh?, geometry?, userData?}` 自省。
   * 宿主未注入（或形状不对）时只记一条限制、`sceneLoaded=false`，不抛错。
   */
  build(sceneRoot: unknown): void {
    // 同一场景重入（重复 build）时先把旧隐藏恢复，再重建索引。
    this.restoreAll();
    this.reset();
    this.desiredHidden.clear();
    this.desiredOffsets.clear();
    const root = sceneRoot as SceneRootLike | null | undefined;
    if (!root || typeof root.traverse !== 'function') {
      this.limitations.push('宿主未注入 sceneRoot：拿不到合并后的几何（面板状态行会显示未载图）');
      return;
    }
    this.root = root;
    this.sceneLoaded = true;
    root.traverse((object) => {
      if (!object || object.isMesh === false) return;
      const geometry = object.geometry;
      if (!geometry) return;
      this.indexGeometry(geometry, object);
    });
  }

  /**
   * 隐藏/恢复某实体的全部区间。`hidden` 与实体层 `setBrushEnabled` 的 on 相反
   * （`enabled=false` 才隐藏，见 `src/ts-shared/entity/classes/brush.ts`）。
   *
   * 先更新「应隐藏」集合，再处理 PVS 运行期换 index 缓冲的重建，最后查索引并写区间。
   * 定位不到实体时只计数（`unresolvedEvents`），不动任何 buffer。
   */
  setEntityHidden(entityIndex: number, hidden: boolean): BrushEntityHideResult {
    if (hidden) this.desiredHidden.add(entityIndex);
    else this.desiredHidden.delete(entityIndex);
    // 装载期 PVS 关闭、运行期才补建 clusterIndex 时，cluster-filter 会换掉 geometry.index，
    // 旧 slot 会静默写进废弃缓冲。检测到就重建索引再重放（代价只在发生切换的第一帧）。
    let rebuilt = false;
    if (this.hasStaleIndexBuffer()) {
      this.refresh();
      rebuilt = true;
    }
    const binding = this.bindings.get(entityIndex);
    if (!binding) {
      this.unresolvedEvents += 1;
      return { status: 'unresolved', rebuilt };
    }
    if (binding.hidden === hidden) return { status: 'unchanged', rebuilt };
    this.setBindingHidden(binding, hidden);
    return { status: 'changed', rebuilt, triangles: binding.triangles, slots: binding.slots.length };
  }

  /**
   * 载图初态隐藏：实体层 spawn 时 `brushSetEnabled(..., applyHost=false)` 刻意不发事件，
   * 调用方需从实体文本（`entityIoJson.entities_text`）解析出初态集合再交给这里。
   * 返回本次实际隐藏的实体数（诊断用；可能小于入参，因为实体未必在本图来源表里）。
   */
  applyInitialHidden(entityIndices: Iterable<number>): number {
    let hidden = 0;
    for (const entityIndex of entityIndices) {
      this.desiredHidden.add(entityIndex);
      const binding = this.bindings.get(entityIndex);
      if (binding && !binding.hidden) {
        this.setBindingHidden(binding, true);
        hidden += 1;
      }
    }
    return hidden;
  }

  /** 恢复所有被隐藏的区间（换图/卸载前调用，避免把退化数据留在旧 buffer 上）。 */
  restoreAll(): void {
    for (const binding of this.bindings.values()) {
      if (binding.hidden) this.setBindingHidden(binding, false);
    }
    // 位移也还原到基准：换图后重建索引时会把当前 position 当成新基准，
    // 若不先归零，位移会被「烘」进基准并在下一轮叠加。
    for (const binding of this.bindings.values()) {
      const offset = binding.offset;
      if (offset[0] === 0 && offset[1] === 0 && offset[2] === 0) continue;
      binding.offset = [0, 0, 0];
      for (const slot of binding.slots) this.writeSlotOffset(slot, [0, 0, 0]);
    }
  }

  /**
   * 设置移动 brush 的绝对位移（相对 BSP 出生位置，Y-up，单位 HU）。
   *
   * 只写 position 顶点；index / 结构不重建（隐藏中的实体只记目标位移，恢复时按它写回）。
   * 与 `setEntityHidden` 共用 PVS 换缓冲检测：位移依赖的顶点集合来自登记时的缓冲，
   * 缓冲被换掉后必须重建索引再写。
   */
  setEntityOffset(
    entityIndex: number,
    offset: [number, number, number],
  ): BrushEntityOffsetResult {
    const previous = this.desiredOffsets.get(entityIndex);
    this.desiredOffsets.set(entityIndex, offset);
    let rebuilt = false;
    if (this.hasStaleIndexBuffer()) {
      this.refresh();
      rebuilt = true;
    }
    const binding = this.bindings.get(entityIndex);
    if (!binding) return { status: 'unresolved', rebuilt };
    if (
      previous
      && previous[0] === offset[0]
      && previous[1] === offset[1]
      && previous[2] === offset[2]
    ) {
      return { status: 'unchanged', rebuilt };
    }
    binding.offset = [offset[0], offset[1], offset[2]];
    if (!binding.hidden) {
      for (const slot of binding.slots) this.writeSlotOffset(slot, binding.offset);
    }
    return { status: 'changed', rebuilt, triangles: binding.triangles, slots: binding.slots.length };
  }

  /** 诊断快照：实体/区间/隐藏计数与限制文本（字段口径与应用层状态行一致）。 */
  stats(): BrushEntityVisibilityStats {
    return {
      sceneLoaded: this.sceneLoaded,
      entities: this.bindings.size,
      slots: this.bindingSlots,
      triangles: this.bindingTriangles,
      indexSlots: this.indexSlots,
      vertexSlots: this.vertexSlots,
      hiddenEntities: this.hiddenEntities,
      hiddenSlots: this.hiddenSlots,
      hiddenTriangles: this.hiddenTriangles,
      hiddenIndexSlots: this.hiddenIndexSlots,
      hiddenVertexSlots: this.hiddenVertexSlots,
      unresolvedEvents: this.unresolvedEvents,
      desiredHidden: this.desiredHidden.size,
      tablesAccepted: this.tablesAccepted,
      skippedGeometries: this.tablesRejected,
      rebuilds: this.rebuilds,
      limitations: this.limitations,
    };
  }

  /** 恢复隐藏、清空索引与计数：dispose 后不保留场景根/几何/缓冲引用。 */
  dispose(): void {
    this.restoreAll();
    this.reset();
    this.desiredHidden.clear();
    this.desiredOffsets.clear();
  }

  // ── 内部实现 ─────────────────────────────────────────────────────────────

  private reset(): void {
    this.bindings.clear();
    this.limitations.length = 0;
    this.sceneLoaded = false;
    this.root = null;
    this.tablesAccepted = 0;
    this.tablesRejected = 0;
    this.bindingSlots = 0;
    this.bindingTriangles = 0;
    this.indexSlots = 0;
    this.vertexSlots = 0;
    this.hiddenEntities = 0;
    this.hiddenSlots = 0;
    this.hiddenTriangles = 0;
    this.hiddenIndexSlots = 0;
    this.hiddenVertexSlots = 0;
    this.unresolvedEvents = 0;
    this.rebuilds = 0;
  }

  /** 按当前场景根重建索引并重放「应隐藏」集合（PVS 运行期换缓冲后调用）。 */
  private refresh(): void {
    const root = this.root;
    this.restoreAll();
    this.reset();
    this.root = root;
    this.sceneLoaded = root !== null;
    root?.traverse((object) => {
      if (!object || object.isMesh === false) return;
      const geometry = object.geometry;
      if (!geometry) return;
      this.indexGeometry(geometry, object);
    });
    this.applyDesiredHidden();
    this.applyDesiredOffsets();
    this.rebuilds += 1;
  }

  /**
   * 处理一张带来源表的合并几何：校验表并登记 brush 区间。
   *
   * 口径分三种：
   * - 非索引几何：顶点位置落在来源表区间上（position 区间）；
   * - 索引几何且**没有** PVS 逐三角形状态：`geometry.index` 与来源表同序，写区间 index；
   * - 索引几何且被 PVS 接管（`mesh.userData.clusterIndex.origIndex`）：`geometry.index` 已被
   *   按相机房间重排/裁剪，来源表偏移不再对应实体三角形 —— 改用 `origIndex` 取实体顶点，
   *   塌缩这些顶点的 position（PVS 只写 index，position 口径稳定）。
   *   注意 origIndex 是**原始顺序**，与来源表区间同序，所以三角形 t 仍是区间内第 t 个。
   */
  private indexGeometry(geometry: GeometryLike, mesh: MeshLike): void {
    const table = sourceTableOf(geometry);
    if (!table) return;
    const indexAttribute = geometry.index && geometry.index.count > 0 ? geometry.index : null;
    const positionAttribute = geometry.attributes.position;
    if (!positionAttribute || positionAttribute.count <= 0) {
      this.tablesRejected += 1;
      this.limitations.push('缺 position 属性的来源表几何');
      return;
    }
    const bufferLength = indexAttribute ? indexAttribute.count : positionAttribute.count;
    const rawRanges = Array.isArray(table.ranges) ? table.ranges : [];
    const validated = validateRanges(rawRanges, bufferLength);
    if (!validated) {
      this.tablesRejected += 1;
      this.limitations.push(`来源表形态与几何不一致（bufferLength=${bufferLength}，区间=${rawRanges.length}）`);
      return;
    }
    // 单位口径以实际 index 缓冲为准（`table.indexed` 有 46/324 张与实际不一致，不可信）。
    const attribute = indexAttribute ?? positionAttribute;
    const array = attribute?.array;
    if (!array || typeof array.length !== 'number') {
      this.tablesRejected += 1;
      this.limitations.push('来源表几何缺可写缓冲');
      return;
    }
    const width: 1 | 3 = indexAttribute ? 1 : 3;
    if (array.length < bufferLength * width) {
      this.tablesRejected += 1;
      this.limitations.push(`来源表几何缓冲长度不足（${array.length} < ${bufferLength * width}）`);
      return;
    }
    const positionArray = positionAttribute.array;
    const cluster = mesh.userData?.['clusterIndex'] as ClusterIndexLike | undefined;
    const origIndex = indexAttribute && cluster?.origIndex && cluster.origIndex.length >= bufferLength
      ? cluster.origIndex
      : null;
    // PVS 重排几何：确认实体顶点不与其它区间的三角形共享（合并是逐源拼接，正常不会共享；
    // 一旦共享，塌缩会波及别的实体，宁可整张几何跳过并如实记限制）。
    if (origIndex) {
      const owners = new Map<number, number>();
      let conflict: string | null = null;
      for (const range of validated.ranges) {
        const owner = entityIndexFromRangeName(range.meshName) ?? -1;
        for (let i = range.start; i < range.start + range.count; i += 1) {
          const vertex = origIndex[i];
          const previous = owners.get(vertex);
          if (previous === undefined) owners.set(vertex, owner);
          else if (previous !== owner && conflict === null) {
            conflict = `PVS 重排几何顶点 ${vertex} 同时被实体 ${previous} 与 ${owner} 的三角形使用，跳过整张几何`;
          }
        }
      }
      if (conflict) {
        this.tablesRejected += 1;
        this.limitations.push(conflict);
        return;
      }
    }
    const mode: SlotKind = origIndex ? 'vertex' : indexAttribute ? 'index' : 'position';
    for (const range of validated.ranges) {
      const entityIndex = entityIndexFromRangeName(range.meshName);
      if (entityIndex === null) continue; // 非 brush 区间：保持原样，绝不动
      const triangleCount = range.count / 3;
      let binding = this.bindings.get(entityIndex);
      if (!binding) {
        binding = {
          entityIndex,
          slots: [],
          triangles: 0,
          indexSlots: 0,
          vertexSlots: 0,
          hidden: false,
          offset: [0, 0, 0],
        };
        this.bindings.set(entityIndex, binding);
      }
      if (mode === 'vertex' && origIndex) {
        const vertices = collectRangeVertices(origIndex, range.start, range.count);
        binding.slots.push({
          attribute: positionAttribute,
          array: positionArray,
          kind: 'vertex',
          start: 0,
          count: 0,
          width: 3,
          vertices,
          positionAttribute,
          positionArray,
          // 登记时 position 处于基准位置（build/refresh 前都先 restoreAll 归零位移）。
          basePositions: copyVertices(positionArray, vertices),
          backup: null,
        });
        binding.vertexSlots += 1;
        this.vertexSlots += 1;
      } else {
        const vertices = mode === 'index'
          ? collectRangeVertices(array, range.start, range.count)
          : continuousVertices(range.start, range.count);
        binding.slots.push({
          attribute,
          array,
          kind: mode,
          geometry: mode === 'index' ? geometry : undefined,
          captured: mode === 'index' ? attribute : undefined,
          start: range.start,
          count: range.count,
          width,
          vertices,
          positionAttribute,
          positionArray,
          basePositions: copyVertices(positionArray, vertices),
          backup: null,
        });
        if (mode === 'index') {
          binding.indexSlots += 1;
          this.indexSlots += 1;
        } else {
          binding.vertexSlots += 1;
          this.vertexSlots += 1;
        }
      }
      binding.triangles += triangleCount;
      this.bindingSlots += 1;
      this.bindingTriangles += triangleCount;
    }
    this.tablesAccepted += 1;
  }

  /**
   * 隐藏/恢复单个实体的全部区间；写回备份或退化，并置 needsUpdate。
   *
   * 隐藏时：index 模式备份原 index 再写 0；position/vertex 模式靠顶点塌缩。
   * 恢复时：index 模式先还原 index 备份，再把 position 按 `基准 + 当前位移` 写回
   * （隐藏期间移动 brush 的位移事件只记数不写点，恢复时必须补写）。
   */
  private setBindingHidden(binding: EntityBinding, hide: boolean): void {
    for (const slot of binding.slots) {
      if (hide) {
        if (slot.backup) continue;
        if (slot.kind === 'index') {
          slot.backup = copyRange(slot.array, slot.start * slot.width, slot.count * slot.width);
          degenerateIndexes(slot);
        } else if (slot.kind === 'vertex') {
          collapseVertices(slot.positionArray ?? slot.array, slot.vertices ?? []);
        } else {
          collapsePositions(slot);
        }
      } else {
        if (slot.kind === 'index') {
          const backup = slot.backup;
          if (backup) {
            const rawStart = slot.start * slot.width;
            for (let i = 0; i < backup.length; i += 1) slot.array[rawStart + i] = backup[i];
          }
          this.writeSlotOffset(slot, binding.offset);
        } else {
          this.writeSlotOffset(slot, binding.offset);
        }
        slot.backup = null;
      }
      slot.attribute.needsUpdate = true;
      if (slot.positionAttribute) slot.positionAttribute.needsUpdate = true;
    }
    if (binding.hidden === hide) return;
    binding.hidden = hide;
    const sign = hide ? 1 : -1;
    this.hiddenEntities += sign;
    this.hiddenSlots += sign * binding.slots.length;
    this.hiddenTriangles += sign * binding.triangles;
    this.hiddenIndexSlots += sign * binding.indexSlots;
    this.hiddenVertexSlots += sign * binding.vertexSlots;
  }

  /** 把一个区间的顶点写成 `基准 + offset`；隐藏中的位移不写点（恢复时补写）。 */
  private writeSlotOffset(slot: Slot, offset: [number, number, number]): void {
    const vertices = slot.vertices;
    const base = slot.basePositions;
    const positionArray = slot.positionArray;
    if (!vertices || !base || !positionArray) return;
    writeVertexPositions(positionArray, vertices, base, offset);
    if (slot.positionAttribute) slot.positionAttribute.needsUpdate = true;
  }

  /** 把位移镜像应用到已建好的实体区间（PVS 重建索引后重放）。 */
  private applyDesiredOffsets(): void {
    for (const [entityIndex, offset] of this.desiredOffsets) {
      const binding = this.bindings.get(entityIndex);
      if (!binding) continue;
      binding.offset = [offset[0], offset[1], offset[2]];
      if (binding.hidden) continue;
      for (const slot of binding.slots) this.writeSlotOffset(slot, binding.offset);
    }
  }

  /** 把「应隐藏」集合应用到已建好的实体区间（已隐藏的跳过）。 */
  private applyDesiredHidden(): void {
    for (const entityIndex of this.desiredHidden) {
      const binding = this.bindings.get(entityIndex);
      if (binding && !binding.hidden) this.setBindingHidden(binding, true);
    }
  }

  /** 运行期 PVS 打开后 `cluster-filter` 会换 `geometry.index`；旧 slot 会写进废弃缓冲。 */
  private hasStaleIndexBuffer(): boolean {
    for (const binding of this.bindings.values()) {
      for (const slot of binding.slots) {
        if (
          slot.kind === 'index'
          && slot.geometry
          && slot.captured
          && slot.geometry.index !== slot.captured
        ) {
          return true;
        }
      }
    }
    return false;
  }
}
