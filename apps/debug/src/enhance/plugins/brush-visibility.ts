/**
 * 增强插件 v2：动态 brush 可见性。
 *
 * 补的是什么缺口（来自 2026-11-22 BSP 审计）：地图里大量 `func_brush` / `func_wall_toggle`
 * （以及开门时的 `func_door` 行为体）在运行期被脚本 `Enable` / `Disable` / `Toggle`。TS 实体层
 * 已经实现了这套语义：`brushSetEnabled()` 改内部 `brushOn` 并把 `setBrushEnabled(实体下标, on)`
 * 交给观测宿主（`src/ts-shared/entity/attach.ts:73` → `{kind:'brush', detail:'<下标>:<true|false>'}`）。
 * 但合并渲染链在几何合批后只留一张大 buffer，实体层的开关没有渲染侧消费方，所以「脚本把
 * 实体关了」在画面上仍然可见。
 *
 * 做法（只消费实体事件，不改核心渲染语义）：
 *   - `onMapLoad` 时遍历宿主注入的场景根，读每张合并几何的
 *     `geometry.userData['websurfMergeSourceTable']`（见 `src/renderer-shared/scene/scene-optimizer.ts`），
 *     按 `meshName === 'brush_<实体下标>'` 把区间归到实体，建「实体 → 区间」索引（一次性）。
 *   - 索引几何且**没有** PVS 逐三角形状态：把区间内的 index 全写成同一个顶点（0）→ 三角形面积为零，
 *     不产生片元；恢复时把备份的 index 片段逐元素写回。
 *   - 索引几何但被 PVS 接管（`mesh.userData.clusterIndex.origIndex` 存在）：相机换房间时
 *     `src/renderer-shared/scene/cluster-filter.ts` 会按可见性**重排/裁剪 `geometry.index`**，来源表
 *     的区间偏移不再对应实体三角形，直接写 index 会打到别的三角形。此时改读 `origIndex`（原始顺序，
 *     与来源表同序）拿实体三角形自己的顶点，塌缩这些顶点的 position —— PVS 从不写 position，口径稳定。
 *   - 非索引几何（本项目含 brush 的合并块大多被 `normalizeMergeGroup` 转成这样）：**不改几何
 *     结构**（不往 geometry 里塞 index 缓冲），而是把区间内每个顶点的 position 三坐标写成
 *     该区间首顶点坐标 → 三角形塌成一点；恢复时写回原坐标。
 *   - 以上做法都只动目标实体自己的区间：不动 draw call、不动 drawRange、不动其它实体的区间、
 *     不重算包围体（退化三角形仍在原包围体内，剔除结果不变）。PVS 重排几何建索引时会检查目标
 *     顶点是否与其它区间共享；一旦共享就整张几何跳过并记限制，不做「可能误伤别人」的写。
 *
 * 语义依据：`brushSetEnabled(entity, enabled)` 的 `enabled=false` 对应 Source 的
 * `EF_NODRAW`/不可见（func_door 到顶 `doorHitTop` 关、下降 `doorGoDown` 开；func_wall_toggle
 * 的 Toggle 在两者之间切换，见 `src/ts-shared/entity/classes/brush.ts`）。
 *
 * 边界（如实标注）：
 *   - 只处理**印在来源表里的 brush 区间**；若某实体在合并期没有留下来源表（或表形态校验失败），
 *     事件会计入「未定位」，不做任何隐藏——不会误伤别的几何。
 *   - `table.indexed` 与实际 `geometry.index` 可能不一致（装载后 46/324 张），因此单位口径
 *     **以 geometry.index 是否存在为准**，并要求区间首尾相接覆盖整个 buffer 才接受该表。
 *   - 合并后同一实体可能跨多张几何（多材质），全部区间一起切换。
 *
 * 性能：默认关 → 不装载本模块；启用后只在换图时遍历一次场景（O(区间数)），之后每个 brush
 * 事件只写受影响的区间片段（`needsUpdate` 由渲染器在下一帧上传）。
 */
import type { EnhancePlugin, EnhanceRuntime, EnhanceSceneContext } from '../../../../../src/ts-shared/enhance/plugin.js';
import type { EntityEvent } from '../../../../../src/ts-shared/entity/types.js';

/** 合并来源表挂在几何 userData 上的键（与 `scene-optimizer.ts` 的 `MERGE_SOURCE_TABLE_KEY` 一致）。 */
const MERGE_SOURCE_TABLE_KEY = 'websurfMergeSourceTable';
/** 来源表里 brush 实体的区间名前缀（`brush_<实体下标>`）。 */
const BRUSH_MESH_PREFIX = 'brush_';
/** 前 N 次操作/诊断打日志，之后只计数（避免刷屏）。 */
const LOG_LIMIT = 12;

// ── 结构类型：插件契约不 import three，用自省所需的最小形状 ──────────────────
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
 * 区间口径：
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
  /** vertex 模式：属于该实体区间的顶点下标（已去重）。 */
  readonly vertices?: readonly number[];
  /** 隐藏前的原始元素备份（长度 = count * width）；null = 当前未隐藏。 */
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
}

interface ParsedBrushEvent {
  entityIndex: number;
  /** 实体层 `setBrushEnabled` 的 on：true=可见，false=隐藏。 */
  enabled: boolean;
}

/** 解析 `brush` 事件 detail：`'<实体下标>:<true|false>'`（兼容 1/0 手写）。 */
function parseBrushEventDetail(detail: string): ParsedBrushEvent | null {
  const separator = detail.indexOf(':');
  if (separator <= 0) return null;
  const indexText = detail.slice(0, separator).trim();
  const stateText = detail.slice(separator + 1).trim().toLowerCase();
  if (!/^\d+$/.test(indexText)) return null;
  const entityIndex = Number.parseInt(indexText, 10);
  if (!Number.isSafeInteger(entityIndex)) return null;
  if (stateText === 'true' || stateText === '1') return { entityIndex, enabled: true };
  if (stateText === 'false' || stateText === '0') return { entityIndex, enabled: false };
  return null;
}

/** 从区间名解析实体下标；非 brush 区间 / 名字不合法返回 null。 */
function entityIndexFromRangeName(meshName: string): number | null {
  if (!meshName.startsWith(BRUSH_MESH_PREFIX)) return null;
  const suffix = meshName.slice(BRUSH_MESH_PREFIX.length);
  if (!/^\d+$/.test(suffix)) return null;
  const index = Number.parseInt(suffix, 10);
  return Number.isSafeInteger(index) ? index : null;
}

/**
 * 判断单个实体文本块（BSP entities 的 KV 原文）在载图初态是否应为「不可见」。
 *
 * 实体层 spawn 刻意 `applyHost=false` 不发事件，所以插件必须自己补初态；这里与
 * `src/ts-shared/entity/classes/brush.ts` 的 spawn 语义保持一致：
 * `StartDisabled != 0`，或 `func_wall_toggle` 的 spawnflags bit0（START_OFF）。
 */
function blockShouldStartHidden(block: string): boolean {
  const props = new Map<string, string>();
  const pair = /"([^"\\]*)"\s+"([^"\\]*)"/g;
  for (let match = pair.exec(block); match; match = pair.exec(block)) {
    if (!props.has(match[1].toLowerCase())) props.set(match[1].toLowerCase(), match[2]);
  }
  const classname = (props.get('classname') ?? '').toLowerCase();
  if (classname !== 'func_brush' && classname !== 'func_wall_toggle') return false;
  const startDisabled = Number.parseInt(props.get('startdisabled') ?? '0', 10);
  if (Number.isFinite(startDisabled) && startDisabled !== 0) return true;
  if (classname === 'func_wall_toggle') {
    const spawnFlags = Number.parseInt(props.get('spawnflags') ?? '0', 10);
    if (Number.isFinite(spawnFlags) && (spawnFlags & 1) !== 0) return true;
  }
  return false;
}

/** 读并浅校验来源表；没有表/空表返回 null（视作普通几何，不碰）。 */
function sourceTableOf(geometry: GeometryLike): SourceTableLike | null {
  const raw = geometry.userData?.[MERGE_SOURCE_TABLE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const table = raw as SourceTableLike;
  if (!Array.isArray(table.ranges) || table.ranges.length === 0) return null;
  return table;
}

/** 表形态校验：整数、%3 对齐、首尾相接、覆盖整个 buffer。 */
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
    // 表按升序连续覆盖整张 buffer；不满足说明口径不一致（宁可跳过也不猜单位）。
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

export function createBrushVisibilityPlugin(runtime: EnhanceRuntime): EnhancePlugin {
  /** 本图「实体 → 区间」索引；换图/卸载时清空。 */
  const bindings = new Map<number, EntityBinding>();
  /** 本图建立索引时遇到的口径/形态限制（状态行只显示条数，细节进日志）。 */
  const limitations: string[] = [];
  let sceneLoaded = false;
  let tablesAccepted = 0;
  let tablesRejected = 0;
  let bindingSlots = 0;
  let bindingTriangles = 0;
  let indexSlots = 0;
  let vertexSlots = 0;
  let hiddenEntities = 0;
  let hiddenSlots = 0;
  let hiddenTriangles = 0;
  let hiddenIndexSlots = 0;
  let hiddenVertexSlots = 0;
  let unresolvedEvents = 0;
  let loggedLimitations = 0;
  let lastEvent: string | null = null;
  /** 当前场景根（换图时替换；PVS 运行时换 index 缓冲后按它重建索引）。 */
  let sceneRootRef: SceneRootLike | null = null;
  /** 事件与载图初态共同驱动的「应隐藏」集合；重建索引后按它重放。 */
  const desiredHidden = new Set<number>();
  /** 载图时从 entityIoJson 解析出的初态隐藏实体数（诊断用）。 */
  let initialHiddenCount = 0;

  const resetBindings = (): void => {
    bindings.clear();
    limitations.length = 0;
    sceneLoaded = false;
    sceneRootRef = null;
    initialHiddenCount = 0;
    tablesAccepted = 0;
    tablesRejected = 0;
    bindingSlots = 0;
    bindingTriangles = 0;
    indexSlots = 0;
    vertexSlots = 0;
    hiddenEntities = 0;
    hiddenSlots = 0;
    hiddenTriangles = 0;
    hiddenIndexSlots = 0;
    hiddenVertexSlots = 0;
    unresolvedEvents = 0;
    loggedLimitations = 0;
    lastEvent = null;
  };

  /** 隐藏/恢复单个实体的全部区间；写回备份或退化，并置 needsUpdate。 */
  const setBindingHidden = (binding: EntityBinding, hide: boolean): void => {
    for (const slot of binding.slots) {
      if (hide) {
        if (slot.backup) continue;
        if (slot.kind === 'vertex') {
          const vertices = slot.vertices ?? [];
          slot.backup = copyVertices(slot.array, vertices);
          collapseVertices(slot.array, vertices);
        } else {
          slot.backup = copyRange(slot.array, slot.start * slot.width, slot.count * slot.width);
          if (slot.kind === 'index') degenerateIndexes(slot);
          else collapsePositions(slot);
        }
      } else {
        const backup = slot.backup;
        if (!backup) continue;
        if (slot.kind === 'vertex') {
          const vertices = slot.vertices ?? [];
          for (let i = 0; i < vertices.length; i += 1) {
            const offset = vertices[i] * 3;
            slot.array[offset] = backup[i * 3];
            slot.array[offset + 1] = backup[i * 3 + 1];
            slot.array[offset + 2] = backup[i * 3 + 2];
          }
        } else {
          const rawStart = slot.start * slot.width;
          for (let i = 0; i < backup.length; i += 1) slot.array[rawStart + i] = backup[i];
        }
        slot.backup = null;
      }
      slot.attribute.needsUpdate = true;
    }
    if (binding.hidden === hide) return;
    binding.hidden = hide;
    const sign = hide ? 1 : -1;
    hiddenEntities += sign;
    hiddenSlots += sign * binding.slots.length;
    hiddenTriangles += sign * binding.triangles;
    hiddenIndexSlots += sign * binding.indexSlots;
    hiddenVertexSlots += sign * binding.vertexSlots;
  };

  const restoreAll = (): void => {
    for (const binding of bindings.values()) {
      if (binding.hidden) setBindingHidden(binding, false);
    }
  };

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
  const indexGeometry = (geometry: GeometryLike, mesh: MeshLike): void => {
    const table = sourceTableOf(geometry);
    if (!table) return;
    const indexAttribute = geometry.index && geometry.index.count > 0 ? geometry.index : null;
    const positionAttribute = geometry.attributes.position;
    if (!positionAttribute || positionAttribute.count <= 0) {
      tablesRejected += 1;
      limitations.push('缺 position 属性的来源表几何');
      return;
    }
    const bufferLength = indexAttribute ? indexAttribute.count : positionAttribute.count;
    const rawRanges = Array.isArray(table.ranges) ? table.ranges : [];
    const validated = validateRanges(rawRanges, bufferLength);
    if (!validated) {
      tablesRejected += 1;
      limitations.push(`来源表形态与几何不一致（bufferLength=${bufferLength}，区间=${rawRanges.length}）`);
      return;
    }
    // 单位口径以实际 index 缓冲为准（`table.indexed` 有 46/324 张与实际不一致，不可信）。
    const attribute = indexAttribute ?? positionAttribute;
    const array = attribute?.array;
    if (!array || typeof array.length !== 'number') {
      tablesRejected += 1;
      limitations.push('来源表几何缺可写缓冲');
      return;
    }
    const width: 1 | 3 = indexAttribute ? 1 : 3;
    if (array.length < bufferLength * width) {
      tablesRejected += 1;
      limitations.push(`来源表几何缓冲长度不足（${array.length} < ${bufferLength * width}）`);
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
        tablesRejected += 1;
        limitations.push(conflict);
        return;
      }
    }
    const mode: SlotKind = origIndex ? 'vertex' : indexAttribute ? 'index' : 'position';
    for (const range of validated.ranges) {
      const entityIndex = entityIndexFromRangeName(range.meshName);
      if (entityIndex === null) continue; // 非 brush 区间：保持原样，绝不动
      const triangleCount = range.count / 3;
      let binding = bindings.get(entityIndex);
      if (!binding) {
        binding = {
          entityIndex,
          slots: [],
          triangles: 0,
          indexSlots: 0,
          vertexSlots: 0,
          hidden: false,
        };
        bindings.set(entityIndex, binding);
      }
      if (mode === 'vertex' && origIndex) {
        binding.slots.push({
          attribute: positionAttribute,
          array: positionArray,
          kind: 'vertex',
          start: 0,
          count: 0,
          width: 3,
          vertices: collectRangeVertices(origIndex, range.start, range.count),
          backup: null,
        });
        binding.vertexSlots += 1;
        vertexSlots += 1;
      } else {
        binding.slots.push({
          attribute,
          array,
          kind: mode,
          geometry: mode === 'index' ? geometry : undefined,
          captured: mode === 'index' ? attribute : undefined,
          start: range.start,
          count: range.count,
          width,
          backup: null,
        });
        if (mode === 'index') {
          binding.indexSlots += 1;
          indexSlots += 1;
        } else {
          binding.vertexSlots += 1;
          vertexSlots += 1;
        }
      }
      binding.triangles += triangleCount;
      bindingSlots += 1;
      bindingTriangles += triangleCount;
    }
    tablesAccepted += 1;
  };

  const storeLimitations = (): void => {
    for (const message of limitations) {
      if (loggedLimitations >= LOG_LIMIT) break;
      loggedLimitations += 1;
      runtime.log(`brush 可见性限制：${message}`);
    }
  };

  /**
   * 从 `entityIoJson.entities_text` 解析载图初态就应隐藏的 brush 实体。
   *
   * 实体层 spawn 时 `brushSetEnabled(..., applyHost=false)` 刻意不发事件，所以本应关闭的
   * brush 载图后会保持可见，直到第一次运行期 toggle 才纠正。这里读同一份无损 KV 原文补初态；
   * 实体下标 = 文本块顺序（与 `EntitySystem` 的装载顺序一致，见 `entity-system.ts`）。
   */
  const parseInitialHidden = (entityIoJson: string | undefined): number => {
    if (!entityIoJson) return 0;
    let entitiesText: string | undefined;
    try {
      const payload = JSON.parse(entityIoJson) as { entities_text?: unknown } | null;
      if (payload && typeof payload.entities_text === 'string') entitiesText = payload.entities_text;
    } catch {
      return 0;
    }
    if (!entitiesText) return 0;
    let found = 0;
    let index = 0;
    let depth = 0;
    let blockStart = -1;
    let inQuotes = false;
    for (let i = 0; i < entitiesText.length; i += 1) {
      const ch = entitiesText[i];
      if (inQuotes) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inQuotes = false;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === '{') {
        depth += 1;
        if (depth === 1) blockStart = i + 1;
      } else if (ch === '}') {
        if (depth === 1 && blockStart >= 0) {
          if (blockShouldStartHidden(entitiesText.slice(blockStart, i))) {
            desiredHidden.add(index);
            found += 1;
          }
          index += 1;
        }
        depth = Math.max(0, depth - 1);
      }
    }
    return found;
  };

  /** 把「应隐藏」集合应用到已建好的实体区间（已隐藏的跳过）。 */
  const applyDesiredHidden = (): void => {
    for (const entityIndex of desiredHidden) {
      const binding = bindings.get(entityIndex);
      if (binding && !binding.hidden) setBindingHidden(binding, true);
    }
  };

  /** 运行期 PVS 打开后 `cluster-filter` 会换 `geometry.index`；旧 slot 会写进废弃缓冲。 */
  const hasStaleIndexBuffer = (): boolean => {
    for (const binding of bindings.values()) {
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
  };

  /** 按当前场景根重建「实体→区间」索引，并重放应隐藏集合（PVS 换缓冲后调用）。 */
  const refreshIndex = (): void => {
    const keepEvent = lastEvent;
    const keepDesired = new Set(desiredHidden);
    const keepRoot = sceneRootRef;
    restoreAll();
    resetBindings();
    lastEvent = keepEvent;
    sceneRootRef = keepRoot;
    desiredHidden.clear();
    for (const entityIndex of keepDesired) desiredHidden.add(entityIndex);
    sceneRootRef?.traverse((object) => {
      if (!object || object.isMesh === false) return;
      const geometry = object.geometry;
      if (!geometry) return;
      indexGeometry(geometry, object);
    });
    applyDesiredHidden();
    runtime.log(
      `brush 可见性索引已按 PVS 新缓冲重建：${bindings.size} 实体，重放隐藏 ${desiredHidden.size} 个`,
    );
  };

  return {
    id: 'brush-visibility',

    onMapLoad(context: EnhanceSceneContext): void {
      // 同一场景重入（重复 onMapLoad）时先把旧隐藏恢复，再重建索引。
      restoreAll();
      resetBindings();
      desiredHidden.clear();
      const root = context.sceneRoot as SceneRootLike | null | undefined;
      if (!root || typeof root.traverse !== 'function') {
        limitations.push('宿主未注入 sceneRoot：拿不到合并后的几何（面板状态行会显示未载图）');
        storeLimitations();
        return;
      }
      sceneRootRef = root;
      sceneLoaded = true;
      root.traverse((object) => {
        if (!object || object.isMesh === false) return;
        const geometry = object.geometry;
        if (!geometry) return;
        indexGeometry(geometry, object);
      });
      // 实体层 spawn 不发 brush 事件，这里用同一份实体文本补「载图初态」，之后事件只做增量。
      initialHiddenCount = parseInitialHidden(context.entityIoJson);
      applyDesiredHidden();
      storeLimitations();
      runtime.log(
        `brush 可见性索引：${bindings.size} 个实体 / ${bindingSlots} 区间 / ${bindingTriangles} 三角` +
          `（几何 ${tablesAccepted} 张：索引写 0 ${indexSlots} 区间、顶点塌缩 ${vertexSlots} 区间；` +
          `跳过 ${tablesRejected} 张；初态隐藏 ${initialHiddenCount} 个）`,
      );
    },

    onEvent(event: EntityEvent): void {
      if (event.kind !== 'brush' || !event.detail) return;
      const parsed = parseBrushEventDetail(event.detail);
      if (!parsed) {
        runtime.log(`brush 事件 detail 无法解析：${event.detail.slice(0, 40)}`);
        return;
      }
      lastEvent = `${parsed.entityIndex}:${parsed.enabled}`;
      const shouldHide = !parsed.enabled;
      if (shouldHide) desiredHidden.add(parsed.entityIndex);
      else desiredHidden.delete(parsed.entityIndex);
      // 装载期 PVS 关闭、运行期才补建 clusterIndex 时，cluster-filter 会换掉 geometry.index，
      // 旧 slot 会静默写进废弃缓冲。检测到就重建索引再重放（代价只在发生切换的第一帧）。
      if (hasStaleIndexBuffer()) refreshIndex();
      const binding = bindings.get(parsed.entityIndex);
      if (!binding) {
        unresolvedEvents += 1;
        if (unresolvedEvents <= LOG_LIMIT) {
          runtime.log(`brush 事件实体 ${parsed.entityIndex} 未定位到合并区间（换图/来源表缺失），不隐藏`);
        }
        return;
      }
      if (binding.hidden === shouldHide) return;
      setBindingHidden(binding, shouldHide);
      runtime.log(
        `brush 实体 ${parsed.entityIndex} ${shouldHide ? '隐藏' : '恢复'}：` +
          `${binding.triangles} 三角 / ${binding.slots.length} 区间`,
      );
    },

    statusText(): string {
      if (!sceneLoaded) return '尚未载图（未建立实体→区间索引）';
      const last = lastEvent ?? '—';
      const limit = limitations.length > 0 ? `；限制 ${limitations.length} 项` : '';
      return (
        `已隐藏 ${hiddenEntities}/${bindings.size} 实体，退化 ${hiddenTriangles} 三角/${hiddenSlots} 区间` +
        `（索引写 0 ${hiddenIndexSlots} 区间；顶点塌缩 ${hiddenVertexSlots} 区间）；` +
        `初态隐藏 ${initialHiddenCount}；最后事件 ${last}；未定位 ${unresolvedEvents}${limit}`
      );
    },

    dispose(): void {
      restoreAll();
      resetBindings();
    },
  };
}
