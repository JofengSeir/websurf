/**
 * 增强插件：prop 外观层级（rendermode / renderamt / renderfx / parentname / skin）。
 *
 * 补的是什么缺口（2026-11-22 BSP 审计 N4/N5/N6）：地图里 `prop_dynamic*` 实体的
 * `rendermode`（10 = Don't Render、1..5 = 各类叠加/发光）、`renderamt`（不透明度）、
 * `renderfx`、`parentname`（运动平台跟随父实体）、`skin` 在 GLB 装配链里全部丢失，于是
 * 「地图设计上应该不显示或半透明的道具」在 Web 端照常显示。
 *
 * 本插件消费的扩展字段来自 `src/wasm-core/model_integrator/mod.rs` 写进 prop 节点的 glTF
 * extras（`vbsp_entity_index` / `vbsp_rendermode` / ...，见该文件的 `PlacementSource`）。
 *
 * 关键现实：debug 端装配链默认开场景合并（`renderer-main.ts` 的 `OPTIMIZE_SCENE_ENABLED`），
 * 合并后 prop 节点大多被吃进分块几何，节点 extras 不再存在于运行期对象上。因此身份走两条通道：
 *   1) **来源表通道（主路径）**：mod.rs 额外写 `vbsp_entity_name = 'prop_<实体下标>'`，
 *      `scene-optimizer.tagBrushEntityOwners` 会把它盖到后代 mesh 上，合并来源表
 *      （`geometry.userData['websurfMergeSourceTable']`）的区间 `meshName` 因此变成
 *      `prop_<下标>`，与 brush-visibility 的 `brush_<下标>` 同构。隐藏/透明按区间处理。
 *   2) **直挂节点通道（兼容）**：只含单个 mesh 的块会保留原 mesh 与该节点 userData
 *      （extras 仍在），此时直接按对应 mesh 处理（visible / 材质克隆），同一套语义。
 * 外观数值来源：优先节点/祖先上的 `vbsp_*` extras（直挂通道），否则解析
 * `context.entityIoJson.entities_text`（合并通道必需；切块口径复刻 wasm-core
 * `Entities::iter`：找最近的 `{` 与随后最近的 `}`，块序号即实体下标，才能与
 * `vbsp_entity_index` 对齐）。
 *
 * 语义（按 Source 的 RenderMode / RenderAmt 近似）：
 *   - `rendermode == 10`（Don't Render）→ 不显示：直挂 mesh `visible=false`；合并区间按口径退化
 *     （索引写同一顶点 / 顶点塌缩，与 brush-visibility 同一套 Slot 写法；PVS 重排几何用
 *     `clusterIndex.origIndex` 取实体顶点后塌 position）。
 *   - `rendermode ∈ 1..5` 且 `renderamt < 255` → 半透明：克隆**该实体独占**的材质（直挂 mesh 直接
 *     克隆；合并块按 `geometry.groups` 的材质槽，仅当该分组区间全部属于本实体才克隆，否则如实
 *     记限制、不误伤别人），`transparent=true`、`opacity=renderamt/255`；3(Glow)/5(Additive)
 *     用加法混合近似，其余用普通混合。
 *   - `rendermode` 0/缺省 → 不动。
 *   - `renderfx` 只统计；`parentname` / `skin` 只统计：skin 需要多套材质、GLB 侧没有切换入口，
 *     状态行明说「不可切换（GLB 无多套材质）」。
 *
 * 边界（如实标注）：模型不在 PAKFILE 里的 prop 实体不会出现在 GLB（ze_cursed 实测 75 个
 * prop_dynamic 里 29 个模型缺失，含 idx136 cone_helper），插件把这类计入「未入 GLB」但不做任何
 * 隐藏；入 GLB 的 46 个本图 rendermode 全为 0，或为 2 且 renderamt=255（不透明度 100%），所以
 * 本图「已应用」为 0 —— 应用能力由合成场景单测与浏览器注入用例验证。
 *
 * 性能：默认关（宿主不 import 本模块）；启用后只在 onMapLoad 遍历一次场景建索引，材质克隆 /
 * 区间退化都是载入期一次性工作，无每帧成本；dispose 全部恢复。
 */
import type { EnhancePlugin, EnhanceRuntime, EnhanceSceneContext } from '../../../../../src/ts-shared/enhance/plugin.js';

/** 合并来源表挂在几何 userData 上的键（与 `scene-optimizer.ts` 的 `MERGE_SOURCE_TABLE_KEY` 一致）。 */
const MERGE_SOURCE_TABLE_KEY = 'websurfMergeSourceTable';
/** 来源表里 prop 实体的区间名前缀（`prop_<实体下标>`，mod.rs 的 `PlacementSource` 写入）。 */
const PROP_MESH_PREFIX = 'prop_';
/** 节点 extras 键（与 mod.rs 的 `PlacementSource::write_extras` 对齐）。 */
const EXTRAS_KEYS = {
  entityIndex: 'vbsp_entity_index',
  classname: 'vbsp_classname',
  targetname: 'vbsp_targetname',
  parentname: 'vbsp_parentname',
  rendermode: 'vbsp_rendermode',
  renderamt: 'vbsp_renderamt',
  renderfx: 'vbsp_renderfx',
  skin: 'vbsp_skin',
} as const;
/** Source RenderMode：10 = Don't Render。 */
const RENDERMODE_DONT_RENDER = 10;
/** Source 里需要「叠加/发光」近似的 RenderMode 区间。 */
const RENDERMODE_FIRST_EFFECT = 1;
const RENDERMODE_LAST_EFFECT = 5;
/** RenderAmt 满值（255 = 完全不透明，不需要动材质）。 */
const FULL_RENDERAMT = 255;
/** three 的 Blending 常量（不 import three，按 three 源码数值；`NormalBlending = 1`）。 */
const BLENDING_NORMAL = 1;
const BLENDING_ADDITIVE = 2;
/** 前 N 条限制/诊断写日志，之后只计数。 */
const LOG_LIMIT = 12;
/** 上一层节点取 extras 的最大深度（GLTF 节点 → mesh 一般是 1~2 层）。 */
const MAX_ANCESTOR_DEPTH = 8;

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

interface GeometryGroupLike {
  readonly start: number;
  readonly count: number;
  readonly materialIndex?: number;
}

interface GeometryLike {
  readonly index?: AttributeLike | null;
  readonly attributes: { readonly position?: AttributeLike };
  readonly userData?: Record<string, unknown>;
  readonly groups?: GeometryGroupLike[];
}

interface MaterialLike {
  transparent?: boolean;
  opacity?: number;
  blending?: number;
  depthWrite?: boolean;
  needsUpdate?: boolean;
  clone?: () => MaterialLike;
}

interface MeshLike {
  readonly isMesh?: boolean;
  readonly geometry?: GeometryLike;
  material?: MaterialLike | MaterialLike[] | null;
  readonly userData?: Record<string, unknown>;
  readonly parent?: MeshLike | null;
  visible?: boolean;
}

interface SceneRootLike {
  traverse(callback: (object: MeshLike) => void): void;
}

/** PVS 逐三角形过滤状态（见 `src/renderer-shared/scene/cluster-filter.ts` 与 brush-visibility）。 */
interface ClusterIndexLike {
  readonly origIndex?: NumericArray;
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
 * 区间隐藏口径（与 brush-visibility 同一套）：
 * - `index`：索引几何、无 PVS 逐三角形过滤 → 区间内索引写 0；
 * - `position`：非索引几何 → 区间内顶点位置塌同一点；
 * - `vertex`：几何被 PVS 接管（`clusterIndex.origIndex` 存在，`geometry.index` 已被重排/裁剪）
 *   → 按 `origIndex` 取实体自己的顶点，塌缩这些顶点的 position。
 */
type SlotKind = 'index' | 'position' | 'vertex';

interface RangeSlot {
  readonly attribute: AttributeLike;
  readonly array: NumericArray;
  readonly kind: SlotKind;
  readonly start: number;
  readonly count: number;
  readonly width: 1 | 3;
  readonly vertices?: readonly number[];
  backup: number[] | null;
}

interface RangeDescriptor {
  readonly start: number;
  readonly count: number;
  readonly meshName: string;
}

/** 同一实体在一张几何上的区间集合（透明分组要用 `allRanges` 判独占）。 */
interface RangeEntry {
  readonly mesh: MeshLike;
  readonly geometry: GeometryLike;
  readonly allRanges: readonly RangeDescriptor[];
  readonly ranges: Array<{ start: number; count: number }>;
  readonly slots: RangeSlot[];
}

interface RangeBinding {
  readonly entityIndex: number;
  readonly entries: RangeEntry[];
  triangles: number;
  hidden: boolean;
}

/** 解析出的实体外观（entityIo / 节点 extras 合并后的视图）。 */
interface EntityAppearance {
  readonly entityIndex: number;
  readonly classname: string;
  readonly targetname?: string;
  readonly parentname?: string;
  readonly rendermode?: number;
  readonly renderamt?: number;
  readonly renderfx?: number;
  readonly skin?: number;
}

/** 解析出的实体（只保留插件关心的键；index 与 entities lump 块序号一致）。 */
interface ParsedEntity extends EntityAppearance {
  readonly model: string;
}

interface DirectBinding {
  readonly entityIndex: number;
  readonly mesh: MeshLike;
  readonly extras: Record<string, unknown>;
}

type AppearanceAction = 'hide' | 'translucent' | null;

// ── entities lump 解析（复刻 wasm-core `Entities::iter` 的切块口径） ─────────────

/**
 * 按出现顺序切出 `{ ... }` 块（含两端花括号）。切法与 wasm-core `Entities::iter` **逐字一致**：
 * 从游标起找最近的 `{`，再从该位置起找最近的 `}`；不识别引号/嵌套。块序号 = 实体下标。
 */
function splitEntityBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = text.indexOf('{', cursor);
    if (start < 0) break;
    const end = text.indexOf('}', start + 1);
    if (end < 0) break;
    blocks.push(text.slice(start, end + 1));
    cursor = end + 1;
  }
  return blocks;
}

/** 把实体块拆成 token：引号串（处理 `\\` 与 `\"`）与裸词；花括号与空白跳过。 */
function tokenizeEntityBlock(block: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const length = block.length;
  while (i < length) {
    const ch = block[i];
    if (ch === '"') {
      i += 1;
      let value = '';
      while (i < length) {
        const current = block[i];
        if (current === '\\' && i + 1 < length) {
          value += block[i + 1];
          i += 2;
          continue;
        }
        if (current === '"') {
          i += 1;
          break;
        }
        value += current;
        i += 1;
      }
      tokens.push(value);
      continue;
    }
    if (ch === '{' || ch === '}' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    let value = '';
    while (i < length) {
      const current = block[i];
      if (current === '{' || current === '}' || current === '"' || current === ' ' || current === '\t' || current === '\r' || current === '\n') break;
      value += current;
      i += 1;
    }
    tokens.push(value);
  }
  return tokens;
}

/** 实体块 → 小写键的键值表（后出现的同名键覆盖先出现的，与 Source KeyValues 取值习惯一致）。 */
function parseEntityBlock(block: string): Map<string, string> {
  const tokens = tokenizeEntityBlock(block);
  const properties = new Map<string, string>();
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    properties.set(tokens[i].toLowerCase(), tokens[i + 1]);
  }
  return properties;
}

/** 非负整数解析（超出 max 视为缺省，避免把脏数据当外观指令）。 */
function parseUnsigned(text: string | undefined, max: number): number | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return undefined;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
}

// ── 外观判定 ────────────────────────────────────────────────────────────────

/** 单值 extras 读取。 */
function numberFromExtras(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringFromExtras(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 决定该实体的外观动作；`null` = 保持原样。 */
function decideAction(appearance: EntityAppearance | null): AppearanceAction {
  if (!appearance) return null;
  const mode = appearance.rendermode;
  if (mode === RENDERMODE_DONT_RENDER) return 'hide';
  if (mode === undefined) return null;
  if (mode >= RENDERMODE_FIRST_EFFECT && mode <= RENDERMODE_LAST_EFFECT) {
    const amount = appearance.renderamt ?? FULL_RENDERAMT;
    return amount < FULL_RENDERAMT ? 'translucent' : null;
  }
  return null;
}

/** 把渲染副作用写到材质上（只改克隆出来的材质，不动原材质）。 */
function applyTranslucentMaterial(material: MaterialLike, appearance: EntityAppearance): void {
  const amount = appearance.renderamt ?? FULL_RENDERAMT;
  const opacity = Math.min(1, Math.max(0, amount / FULL_RENDERAMT));
  material.transparent = true;
  material.opacity = Math.min(typeof material.opacity === 'number' ? material.opacity : 1, opacity);
  if (appearance.rendermode === 3 || appearance.rendermode === 5) {
    // Glow/Additive：Source 里是加色发光，用加法混合近似。
    material.blending = BLENDING_ADDITIVE;
    material.depthWrite = false;
  } else {
    material.blending = BLENDING_NORMAL;
  }
  material.needsUpdate = true;
}

// ── 来源表 / 区间隐藏（与 brush-visibility 同口径） ─────────────────────────

/** 从区间名解析 prop 实体下标；非 prop 区间 / 名字不合法返回 null。 */
function propEntityIndexFromRangeName(meshName: string): number | null {
  if (!meshName.startsWith(PROP_MESH_PREFIX)) return null;
  const suffix = meshName.slice(PROP_MESH_PREFIX.length);
  if (!/^\d+$/.test(suffix)) return null;
  const index = Number.parseInt(suffix, 10);
  return Number.isSafeInteger(index) ? index : null;
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
 * 校验来源表区间。先用 brush-visibility 的严格口径（升序首尾相接覆盖整个 buffer、%3 对齐）；
 * 不一致时退回「宽容口径」：只要求每个 prop 区间自身是合法的 %3 区间且在 buffer 内——
 * 合并几何的表形态实测有 46/324 张与 buffer 口径对不上，严格口径会整张丢掉 prop 区间。
 */
function validateRanges(
  rawRanges: readonly unknown[],
  bufferLength: number,
): { ranges: RangeDescriptor[]; strict: boolean } | null {
  const strictRanges: RangeDescriptor[] = [];
  let cursor = 0;
  let strictOk = true;
  for (const raw of rawRanges) {
    if (!raw || typeof raw !== 'object') {
      strictOk = false;
      break;
    }
    const { start, count, meshName } = raw as SourceRangeLike;
    if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) {
      strictOk = false;
      break;
    }
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
      strictOk = false;
      break;
    }
    if (typeof meshName !== 'string') {
      strictOk = false;
      break;
    }
    if (start !== cursor || start % 3 !== 0 || count % 3 !== 0) {
      strictOk = false;
      break;
    }
    cursor += count;
    strictRanges.push({ start, count, meshName });
  }
  if (strictOk && cursor === bufferLength) return { ranges: strictRanges, strict: true };

  const loose: RangeDescriptor[] = [];
  for (const raw of rawRanges) {
    if (!raw || typeof raw !== 'object') continue;
    const { start, count, meshName } = raw as SourceRangeLike;
    if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) continue;
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) continue;
    if (typeof meshName !== 'string') continue;
    if (start % 3 !== 0 || count % 3 !== 0) continue;
    if (start + count > bufferLength) continue;
    loose.push({ start, count, meshName });
  }
  return loose.length > 0 ? { ranges: loose, strict: false } : null;
}

/** 区间内索引全写 0（退化三角形：三个索引指向同一顶点）。 */
function degenerateIndexes(slot: RangeSlot): void {
  const { array, start, count } = slot;
  for (let i = 0; i < count; i += 1) array[start + i] = 0;
}

/** 非索引几何：区间内每个顶点位置塌到区间首顶点（退化三角形），不改 buffer 结构。 */
function collapsePositions(slot: RangeSlot): void {
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

/** 把一组顶点位置塌到首顶点（退化三角形）。 */
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

// ── 插件主体 ────────────────────────────────────────────────────────────────

export function createPropAppearancePlugin(runtime: EnhanceRuntime): EnhancePlugin {
  /** entities lump 解析结果（实体下标 = 块序号）。 */
  const entities = new Map<number, ParsedEntity>();
  const rangeBindings = new Map<number, RangeBinding>();
  const directBindings = new Map<number, DirectBinding[]>();
  /** 直挂 mesh 的隐藏 / 材质克隆恢复动作。 */
  const hiddenMeshRecords: Array<{ mesh: MeshLike; previousVisible: boolean }> = [];
  const opacityRestores: Array<() => void> = [];
  /** 已动作的实体集合（状态行与恢复用）。 */
  const hiddenEntities = new Set<number>();
  const translucentEntities = new Set<number>();
  const appliedEntities = new Set<number>();
  const limitations: string[] = [];

  let sceneLoaded = false;
  let totalPropEntities = 0;
  let skinSkipped = 0;
  let parentnameStats = 0;
  let tablesAccepted = 0;
  let tablesRejected = 0;
  let rangeSlotCount = 0;
  let rangeTriangleCount = 0;
  let directMeshCount = 0;
  let loggedLimitations = 0;

  const resetState = (): void => {
    entities.clear();
    rangeBindings.clear();
    directBindings.clear();
    hiddenMeshRecords.length = 0;
    opacityRestores.length = 0;
    hiddenEntities.clear();
    translucentEntities.clear();
    appliedEntities.clear();
    limitations.length = 0;
    sceneLoaded = false;
    totalPropEntities = 0;
    skinSkipped = 0;
    parentnameStats = 0;
    tablesAccepted = 0;
    tablesRejected = 0;
    rangeSlotCount = 0;
    rangeTriangleCount = 0;
    directMeshCount = 0;
    loggedLimitations = 0;
  };

  const storeLimitations = (): void => {
    for (const message of limitations) {
      if (loggedLimitations >= LOG_LIMIT) break;
      loggedLimitations += 1;
      runtime.log(`prop 外观限制：${message}`);
    }
  };

  // ── entities lump → 实体表 ────────────────────────────────────────────────
  const parseEntityIo = (entityIoJson: string | undefined): void => {
    if (!entityIoJson) {
      limitations.push('宿主未注入 entityIoJson：外观数值只能来自节点 extras');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(entityIoJson);
    } catch {
      limitations.push('entityIoJson 不是合法 JSON');
      return;
    }
    const text = typeof (parsed as { entities_text?: unknown }).entities_text === 'string'
      ? (parsed as { entities_text: string }).entities_text
      : null;
    if (!text) {
      limitations.push('entityIoJson 缺 entities_text');
      return;
    }
    const blocks = splitEntityBlocks(text);
    for (let index = 0; index < blocks.length; index += 1) {
      const properties = parseEntityBlock(blocks[index]);
      const classname = properties.get('classname') ?? '';
      const model = properties.get('model') ?? '';
      const entity: ParsedEntity = {
        entityIndex: index,
        classname,
        model,
        targetname: properties.get('targetname'),
        parentname: properties.get('parentname'),
        rendermode: parseUnsigned(properties.get('rendermode'), 255),
        renderamt: parseUnsigned(properties.get('renderamt'), 255),
        renderfx: parseUnsigned(properties.get('renderfx'), 255),
        skin: parseUnsigned(properties.get('skin'), 65535),
      };
      entities.set(index, entity);
      if (!/^prop/i.test(classname) || model === '') continue;
      totalPropEntities += 1;
      if (entity.skin !== undefined && entity.skin !== 0) skinSkipped += 1;
      if (entity.parentname !== undefined) parentnameStats += 1;
    }
  };

  /** 合并实体表与节点 extras，得到该实体实际生效的外观。 */
  const appearanceOf = (entityIndex: number, extras: Record<string, unknown> | null): EntityAppearance | null => {
    const entity = entities.get(entityIndex) ?? null;
    if (!entity && !extras) return null;
    return {
      entityIndex,
      classname: stringFromExtras(extras?.[EXTRAS_KEYS.classname]) ?? entity?.classname ?? '',
      targetname: stringFromExtras(extras?.[EXTRAS_KEYS.targetname]) ?? entity?.targetname,
      parentname: stringFromExtras(extras?.[EXTRAS_KEYS.parentname]) ?? entity?.parentname,
      rendermode: numberFromExtras(extras?.[EXTRAS_KEYS.rendermode]) ?? entity?.rendermode,
      renderamt: numberFromExtras(extras?.[EXTRAS_KEYS.renderamt]) ?? entity?.renderamt,
      renderfx: numberFromExtras(extras?.[EXTRAS_KEYS.renderfx]) ?? entity?.renderfx,
      skin: numberFromExtras(extras?.[EXTRAS_KEYS.skin]) ?? entity?.skin,
    };
  };

  // ── 区间隐藏 ──────────────────────────────────────────────────────────────
  const setRangeBindingHidden = (binding: RangeBinding, hide: boolean): void => {
    for (const entry of binding.entries) {
      for (const slot of entry.slots) {
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
    }
    binding.hidden = hide;
  };

  // ── 区间透明（按材质分组，仅当分组独占时克隆） ────────────────────────────
  const groupOwnedByEntity = (entry: RangeEntry, group: GeometryGroupLike): boolean => {
    const groupEnd = group.start + group.count;
    for (const range of entry.allRanges) {
      const rangeEnd = range.start + range.count;
      if (range.start >= groupEnd || rangeEnd <= group.start) continue;
      const own = entry.ranges.some((item) => item.start === range.start && item.count === range.count);
      if (!own) return false;
    }
    return true;
  };

  const applyTranslucentRanges = (binding: RangeBinding, appearance: EntityAppearance): boolean => {
    let any = false;
    for (const entry of binding.entries) {
      const material = entry.mesh.material;
      const groups = entry.geometry.groups;
      const handledGroups = new Set<number>();
      for (const range of entry.ranges) {
        let slotIndex = -1;
        if (Array.isArray(groups) && groups.length > 0) {
          slotIndex = groups.findIndex((group) => range.start >= group.start && range.start < group.start + group.count);
          if (slotIndex < 0) {
            limitations.push(`实体 ${binding.entityIndex} 的区间 ${range.start}+${range.count} 未落在任何材质分组`);
            continue;
          }
          if (handledGroups.has(slotIndex)) continue;
          handledGroups.add(slotIndex);
          const group = groups[slotIndex];
          if (!groupOwnedByEntity(entry, group)) {
            limitations.push(`实体 ${binding.entityIndex} 的材质分组 ${slotIndex} 与其它来源共享，跳过透明`);
            continue;
          }
        } else if (Array.isArray(material)) {
          limitations.push(`实体 ${binding.entityIndex} 的几何有材质数组但无分组，跳过透明`);
          break;
        }
        const groupAt = slotIndex >= 0 && groups ? groups[slotIndex] : undefined;
        const groupMaterial = typeof groupAt?.materialIndex === 'number' ? groupAt.materialIndex : undefined;
        const materialIndex = slotIndex >= 0 && Array.isArray(material)
          ? groupMaterial ?? slotIndex
          : 0;
        if (Array.isArray(material)) {
          const original = material[materialIndex];
          if (!original || typeof original.clone !== 'function') {
            limitations.push(`实体 ${binding.entityIndex} 的材质槽 ${materialIndex} 不可克隆，跳过透明`);
            continue;
          }
          const clone = original.clone();
          applyTranslucentMaterial(clone, appearance);
          material[materialIndex] = clone;
          opacityRestores.push(() => {
            material[materialIndex] = original;
          });
          any = true;
        } else if (material) {
          const cloneFactory = material.clone;
          if (typeof cloneFactory !== 'function') {
            limitations.push(`实体 ${binding.entityIndex} 的单材质不可克隆，跳过透明`);
            continue;
          }
          // 单材质块：只有整张表都属于本实体才允许整体克隆，避免把别人的三角形也改了。
          if (!groupOwnedByEntity(entry, { start: 0, count: Number.MAX_SAFE_INTEGER })) {
            limitations.push(`实体 ${binding.entityIndex} 的整块材质与其它来源共享，跳过透明`);
            continue;
          }
          const original = material;
          const clone = cloneFactory.call(original);
          applyTranslucentMaterial(clone, appearance);
          entry.mesh.material = clone;
          opacityRestores.push(() => {
            entry.mesh.material = original;
          });
          any = true;
        }
        if (any) break;
      }
    }
    return any;
  };

  // ── 直挂节点（单 mesh 块） ─────────────────────────────────────────────────
  const hideDirectMesh = (mesh: MeshLike): boolean => {
    if (mesh.visible === false) return false;
    hiddenMeshRecords.push({ mesh, previousVisible: true });
    mesh.visible = false;
    return true;
  };

  const applyTranslucentDirectMeshes = (bindings: readonly DirectBinding[], appearance: EntityAppearance): boolean => {
    let any = false;
    for (const binding of bindings) {
      const material = binding.mesh.material;
      if (!material) continue;
      if (Array.isArray(material)) {
        const cloned = material.map((item) => {
          if (!item || typeof item.clone !== 'function') return item;
          const clone = item.clone();
          applyTranslucentMaterial(clone, appearance);
          return clone;
        });
        const changed = cloned.some((item, index) => item !== material[index]);
        if (!changed) continue;
        const original = material;
        binding.mesh.material = cloned;
        opacityRestores.push(() => {
          binding.mesh.material = original;
        });
        any = true;
      } else {
        const cloneFactory = material.clone;
        if (typeof cloneFactory !== 'function') continue;
        const original = material;
        const clone = cloneFactory.call(original);
        applyTranslucentMaterial(clone, appearance);
        binding.mesh.material = clone;
        opacityRestores.push(() => {
          binding.mesh.material = original;
        });
        any = true;
      }
    }
    return any;
  };

  // ── 场景 → 实体索引 ───────────────────────────────────────────────────────
  /** 从 mesh 自己与祖先节点收集实体下标与外观 extras（GLTF 节点 → mesh 一般 1~2 层）。 */
  const collectNodeIdentity = (mesh: MeshLike): DirectBinding | null => {
    let entityIndex: number | null = null;
    const extras: Record<string, unknown> = {};
    const appearanceKeys = Object.values(EXTRAS_KEYS);
    let node: MeshLike | null | undefined = mesh;
    let depth = 0;
    while (node && depth < MAX_ANCESTOR_DEPTH) {
      const userData = node.userData;
      if (userData && typeof userData === 'object') {
        if (entityIndex === null) {
          const rawIndex = userData[EXTRAS_KEYS.entityIndex];
          if (typeof rawIndex === 'number' && Number.isInteger(rawIndex)) entityIndex = rawIndex;
        }
        for (const key of appearanceKeys) {
          if (extras[key] === undefined && userData[key] !== undefined) extras[key] = userData[key];
        }
      }
      node = node.parent ?? null;
      depth += 1;
    }
    return entityIndex === null ? null : { entityIndex, mesh, extras };
  };

  /** 为一张带来源表的几何登记 prop 区间（返回是否登记到至少一个 prop 实体）。 */
  const indexGeometryRanges = (geometry: GeometryLike, mesh: MeshLike): boolean => {
    const table = sourceTableOf(geometry);
    if (!table) return false;
    const indexAttribute = geometry.index && geometry.index.count > 0 ? geometry.index : null;
    const positionAttribute = geometry.attributes.position;
    if (!positionAttribute || positionAttribute.count <= 0) {
      tablesRejected += 1;
      limitations.push('prop 来源表几何缺 position 属性');
      return false;
    }
    const bufferLength = indexAttribute ? indexAttribute.count : positionAttribute.count;
    const rawRanges = Array.isArray(table.ranges) ? table.ranges : [];
    const validated = validateRanges(rawRanges, bufferLength);
    if (!validated) {
      tablesRejected += 1;
      limitations.push(`prop 来源表形态与几何不一致（bufferLength=${bufferLength}，区间=${rawRanges.length}）`);
      return false;
    }
    if (!validated.strict) {
      limitations.push(`prop 来源表未通过严格覆盖校验（${validated.ranges.length} 区间 / bufferLength=${bufferLength}），按宽容口径取 prop_ 区间`);
    }
    const attribute = indexAttribute ?? positionAttribute;
    const array = attribute.array;
    if (!array || typeof array.length !== 'number') {
      tablesRejected += 1;
      limitations.push('prop 来源表几何缺可写缓冲');
      return false;
    }
    const width: 1 | 3 = indexAttribute ? 1 : 3;
    if (array.length < bufferLength * width) {
      tablesRejected += 1;
      limitations.push(`prop 来源表几何缓冲长度不足（${array.length} < ${bufferLength * width}）`);
      return false;
    }
    const positionArray = positionAttribute.array;
    const cluster = mesh.userData?.['clusterIndex'] as ClusterIndexLike | undefined;
    const origIndex = indexAttribute && cluster?.origIndex && cluster.origIndex.length >= bufferLength
      ? cluster.origIndex
      : null;
    if (origIndex) {
      // PVS 重排几何：确认 prop 实体的顶点不与其它来源共享，否则塌缩会误伤，整张几何跳过。
      const owners = new Map<number, number>();
      let conflict: string | null = null;
      for (const range of validated.ranges) {
        const owner = propEntityIndexFromRangeName(range.meshName) ?? -1;
        for (let i = range.start; i < range.start + range.count; i += 1) {
          const vertex = origIndex[i];
          const previous = owners.get(vertex);
          if (previous === undefined) owners.set(vertex, owner);
          else if (previous !== owner && conflict === null) {
            conflict = `PVS 重排几何顶点 ${vertex} 同时被实体 ${previous} 与 ${owner} 使用，跳过整张几何`;
          }
        }
      }
      if (conflict) {
        tablesRejected += 1;
        limitations.push(conflict);
        return false;
      }
    }
    const mode: SlotKind = origIndex ? 'vertex' : indexAttribute ? 'index' : 'position';
    const entriesByEntity = new Map<number, { entry: RangeEntry; slots: RangeSlot[]; triangles: number }>();
    for (const range of validated.ranges) {
      const entityIndex = propEntityIndexFromRangeName(range.meshName);
      if (entityIndex === null) continue; // 非 prop 区间：保持原样
      const triangles = range.count / 3;
      let group = entriesByEntity.get(entityIndex);
      if (!group) {
        group = {
          entry: { mesh, geometry, allRanges: validated.ranges, ranges: [], slots: [] },
          slots: [],
          triangles: 0,
        };
        entriesByEntity.set(entityIndex, group);
      }
      group.entry.ranges.push({ start: range.start, count: range.count });
      group.triangles += triangles;
      let slot: RangeSlot;
      if (mode === 'vertex' && origIndex) {
        slot = {
          attribute: positionAttribute,
          array: positionArray,
          kind: 'vertex',
          start: 0,
          count: 0,
          width: 3,
          vertices: collectRangeVertices(origIndex, range.start, range.count),
          backup: null,
        };
      } else {
        slot = {
          attribute,
          array,
          kind: mode,
          start: range.start,
          count: range.count,
          width,
          backup: null,
        };
      }
      group.slots.push(slot);
      rangeSlotCount += 1;
      rangeTriangleCount += triangles;
    }
    if (entriesByEntity.size === 0) return false;
    for (const [entityIndex, group] of entriesByEntity) {
      let binding = rangeBindings.get(entityIndex);
      if (!binding) {
        binding = { entityIndex, entries: [], triangles: 0, hidden: false };
        rangeBindings.set(entityIndex, binding);
      }
      binding.entries.push(group.entry);
      for (const slot of group.slots) group.entry.slots.push(slot);
      binding.triangles += group.triangles;
    }
    tablesAccepted += 1;
    return true;
  };

  // ── 应用与恢复 ────────────────────────────────────────────────────────────
  const applyRangeEntity = (entityIndex: number): void => {
    const binding = rangeBindings.get(entityIndex);
    if (!binding) return;
    const appearance = appearanceOf(entityIndex, null);
    const action = decideAction(appearance);
    if (!action || !appearance) return;
    if (action === 'hide') {
      setRangeBindingHidden(binding, true);
      hiddenEntities.add(entityIndex);
      appliedEntities.add(entityIndex);
      return;
    }
    if (applyTranslucentRanges(binding, appearance)) {
      translucentEntities.add(entityIndex);
      appliedEntities.add(entityIndex);
    }
  };

  const applyDirectEntity = (entityIndex: number, bindings: readonly DirectBinding[]): void => {
    const appearance = appearanceOf(entityIndex, bindings[0]?.extras ?? null);
    const action = decideAction(appearance);
    if (!action || !appearance) return;
    if (action === 'hide') {
      for (const binding of bindings) {
        if (hideDirectMesh(binding.mesh)) {
          hiddenEntities.add(entityIndex);
          appliedEntities.add(entityIndex);
        }
      }
      return;
    }
    if (applyTranslucentDirectMeshes(bindings, appearance)) {
      translucentEntities.add(entityIndex);
      appliedEntities.add(entityIndex);
    }
  };

  const applyAll = (): void => {
    for (const entityIndex of rangeBindings.keys()) applyRangeEntity(entityIndex);
    for (const [entityIndex, bindings] of directBindings) applyDirectEntity(entityIndex, bindings);
  };

  const restoreAll = (): void => {
    for (const binding of rangeBindings.values()) {
      if (binding.hidden) setRangeBindingHidden(binding, false);
    }
    while (hiddenMeshRecords.length > 0) {
      const record = hiddenMeshRecords.pop();
      if (record) record.mesh.visible = record.previousVisible;
    }
    while (opacityRestores.length > 0) {
      const restore = opacityRestores.pop();
      if (restore) restore();
    }
  };

  /**
   * 场景里已定位到的 **prop 实体** 下标集合。
   *
   * 来源表只登记 `prop_<idx>`，天然是 prop；直挂通道（`vbsp_entity_index`）还会命中 brush 实体
   * 等非 prop 节点，若不按实体表过滤会把 `已定位` 算虚高（statusText 的 `未入 GLB` 也会偏小）。
   * entityIoJson 缺失时没有实体表可判，退回原始集合并由 statusText 明确提示。
   */
  const locatedEntityIndexes = (): Set<number> => {
    const raw = new Set<number>(rangeBindings.keys());
    for (const entityIndex of directBindings.keys()) raw.add(entityIndex);
    if (entities.size === 0) return raw;
    const located = new Set<number>();
    for (const entityIndex of raw) {
      const entity = entities.get(entityIndex);
      if (entity && /^prop/i.test(entity.classname) && entity.model !== '') located.add(entityIndex);
    }
    return located;
  };

  return {
    id: 'prop-appearance',

    onMapLoad(context: EnhanceSceneContext): void {
      // 同一场景重入（重复 onMapLoad / 换图）时先恢复旧状态，再重建索引。
      restoreAll();
      resetState();
      parseEntityIo(context.entityIoJson);
      const root = context.sceneRoot as SceneRootLike | null | undefined;
      if (!root || typeof root.traverse !== 'function') {
        limitations.push('宿主未注入 sceneRoot：拿不到合并后的几何');
        storeLimitations();
        return;
      }
      sceneLoaded = true;
      root.traverse((object) => {
        if (!object || object.isMesh === false) return;
        const geometry = object.geometry;
        if (!geometry) return;
        if (indexGeometryRanges(geometry, object)) return;
        const identity = collectNodeIdentity(object);
        if (!identity) return;
        directMeshCount += 1;
        const list = directBindings.get(identity.entityIndex);
        if (list) list.push(identity);
        else directBindings.set(identity.entityIndex, [identity]);
      });
      applyAll();
      storeLimitations();
      const located = locatedEntityIndexes().size;
      runtime.log(
        `prop 外观索引：定位 ${located}/${totalPropEntities} 个 prop 实体` +
          `（来源表 ${tablesAccepted} 张/跳过 ${tablesRejected} 张，区间 ${rangeSlotCount} 个/${rangeTriangleCount} 三角；` +
          `直挂 mesh ${directMeshCount}）；已应用 ${appliedEntities.size}` +
          `（隐藏 ${hiddenEntities.size}、透明 ${translucentEntities.size}；skin 跳过 ${skinSkipped}、parentname ${parentnameStats} 仅统计）`,
      );
    },

    statusText(): string {
      if (!sceneLoaded) return '尚未载图（未建立 prop 外观索引）';
      const located = locatedEntityIndexes().size;
      const limit = limitations.length > 0 ? `；限制 ${limitations.length} 项` : '';
      if (entities.size === 0) {
        return located > 0
          ? `已定位 ${located} 个 prop 节点，但 entityIoJson 缺失，无法读取 rendermode${limit}`
          : `已应用 0/${totalPropEntities} prop 实体：GLB 未含扩展字段（需重建 wasm）${limit}`;
      }
      if (located === 0) {
        return `已应用 0/${totalPropEntities} prop 实体：GLB 未含扩展字段（需重建 wasm）${limit}`;
      }
      const notInGlb = Math.max(0, totalPropEntities - located);
      return (
        `已应用 ${appliedEntities.size}/${totalPropEntities} prop 实体` +
        `（隐藏 ${hiddenEntities.size}、透明 ${translucentEntities.size}、` +
        `skin 跳过 ${skinSkipped}（不可切换：GLB 无多套材质）、parentname ${parentnameStats} 仅统计；` +
        `已定位 ${located}${notInGlb > 0 ? `，未入 GLB ${notInGlb}` : ''}）${limit}`
      );
    },

    dispose(): void {
      restoreAll();
      resetState();
    },
  };
}
