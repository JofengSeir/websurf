/**
 * 增强插件 v2：动态 brush 可见性（薄适配层）。
 *
 * 纯渲染逻辑已抽到共享模块 `src/renderer-shared/scene/brush-entity-visibility.ts`：合并几何上
 * 「实体 → 区间」索引的建立、区间隐藏/恢复、PVS 运行期换缓冲后的重建全在那里。本文件只留
 * 应用层职责：
 *   - 解析实体事件 detail（`'<实体下标>:<true|false>'`）；
 *   - 从 `entityIoJson.entities_text` 解析载图初态就应隐藏的实体（实体层 spawn 时
 *     `brushSetEnabled(..., applyHost=false)` 刻意不发事件，必须自己补初态）；
 *   - 调共享模块的 `build` / `setEntityHidden` / `applyInitialHidden`，并保留原有日志、状态行
 *     文案与计数口径；
 *   - 插件生命周期（onMapLoad / onEvent / statusText / dispose）。
 *
 * 语义依据：`brushSetEnabled(entity, enabled)` 的 `enabled=false` 对应 Source 的
 * `EF_NODRAW`/不可见（func_door 到顶 `doorHitTop` 关、下降 `doorGoDown` 开；func_wall_toggle
 * 的 Toggle 在两者之间切换，见 `src/ts-shared/entity/classes/brush.ts`）。
 *
 * 插件契约不 import three；共享模块同样按结构类型自省场景根，所以这里直接传 `unknown` 的
 * `context.sceneRoot`，不做类型断言。
 */
import { BrushEntityVisibility } from '../../../../../src/renderer-shared/scene/brush-entity-visibility.js';
import { entityStartSolidRaw } from '../../../../../src/ts-shared/entity/start-solid.js';
import type { EnhancePlugin, EnhanceRuntime, EnhanceSceneContext } from '../../../../../src/ts-shared/enhance/plugin.js';
import type { EntityEvent } from '../../../../../src/ts-shared/entity/types.js';

/** 前 N 次操作/诊断打日志，之后只计数（避免刷屏）。 */
const LOG_LIMIT = 12;

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

/**
 * 判断单个实体文本块（BSP entities 的 KV 原文）在载图初态是否应为「不可见」。
 *
 * 判定本身走共享单源 `src/ts-shared/entity/start-solid.ts`（逐字镜像 Rust
 * `render_bundle::eval_entity_start_solid`），这里只保留**类别过滤**：门族的初态由
 * EntityGameplay 的 `brush:...` 事件链负责，本插件只管 `func_brush` / `func_wall_toggle`。
 *
 * 注意 `func_wall_toggle` 与 `func_brush` 的键含义不同：前者只看 spawnflags bit0
 * （START_OFF，**不吃** StartDisabled），后者只看 StartDisabled（不看 spawnflags）。
 */
function blockShouldStartHidden(block: string): boolean {
  const props = new Map<string, string>();
  const pair = /"([^"\\]*)"\s+"([^"\\]*)"/g;
  for (let match = pair.exec(block); match; match = pair.exec(block)) {
    if (!props.has(match[1].toLowerCase())) props.set(match[1].toLowerCase(), match[2]);
  }
  const classname = (props.get('classname') ?? '').toLowerCase();
  if (classname !== 'func_brush' && classname !== 'func_wall_toggle') return false;
  return !entityStartSolidRaw(classname, {
    spawnflags: props.get('spawnflags'),
    startdisabled: props.get('startdisabled'),
    spawnpos: props.get('spawnpos'),
  });
}

/**
 * 从 `entityIoJson.entities_text` 解析载图初态就应隐藏的 brush 实体下标集合。
 *
 * 实体层 spawn 时 `brushSetEnabled(..., applyHost=false)` 刻意不发事件，所以本应关闭的
 * brush 载图后会保持可见，直到第一次运行期 toggle 才纠正。这里读同一份无损 KV 原文补初态；
 * 实体下标 = 文本块顺序（与 `EntitySystem` 的装载顺序一致，见 `entity-system.ts`）。
 */
function parseInitialHidden(entityIoJson: string | undefined): Set<number> {
  const hidden = new Set<number>();
  if (!entityIoJson) return hidden;
  let entitiesText: string | undefined;
  try {
    const payload = JSON.parse(entityIoJson) as { entities_text?: unknown } | null;
    if (payload && typeof payload.entities_text === 'string') entitiesText = payload.entities_text;
  } catch {
    return hidden;
  }
  if (!entitiesText) return hidden;
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
        if (blockShouldStartHidden(entitiesText.slice(blockStart, i))) hidden.add(index);
        index += 1;
      }
      depth = Math.max(0, depth - 1);
    }
  }
  return hidden;
}

export function createBrushVisibilityPlugin(runtime: EnhanceRuntime): EnhancePlugin {
  /** 共享模块：合并几何的「实体 → 区间」索引与隐藏/恢复。 */
  const visibility = new BrushEntityVisibility();
  /** 最近一次 brush 事件（`<下标>:<enabled>`，状态行显示；PVS 重建时保留）。 */
  let lastEvent: string | null = null;
  /**
   * 载图时从 entityIoJson 解析出的初态隐藏实体数（诊断用）。
   * 原实现的重建路径会走 `resetBindings()` 把这个计数清零（且不恢复），这里在 `rebuilt` 时
   * 同样清零，保持状态行行为不变。
   */
  let initialHiddenCount = 0;
  /**
   * 是否处于「已载图」状态（仅状态行用）。
   * 原实现的 `refreshIndex()` 走 `resetBindings()` 后没有把 `sceneLoaded` 置回 true，所以 PVS
   * 运行期重建后状态行会一直显示「尚未载图」；这里保留该状态位以复现同样的可观察行为
   * （共享模块本身的 `stats().sceneLoaded` 在重建后是 true）。
   */
  let sceneLoaded = false;

  /** 前 N 条限制打日志，之后只计数（与原实现一致，避免刷屏）。 */
  const logLimitations = (messages: readonly string[]): void => {
    const limit = Math.min(messages.length, LOG_LIMIT);
    for (let i = 0; i < limit; i += 1) runtime.log(`brush 可见性限制：${messages[i]}`);
  };

  return {
    id: 'brush-visibility',

    onMapLoad(context: EnhanceSceneContext): void {
      // 同一场景重入（重复 onMapLoad）时模块内部会先恢复旧隐藏，再重建索引。
      lastEvent = null;
      initialHiddenCount = 0;
      sceneLoaded = false;
      visibility.build(context.sceneRoot);
      const stats = visibility.stats();
      if (!stats.sceneLoaded) {
        logLimitations(stats.limitations);
        return;
      }
      sceneLoaded = true;
      // 实体层 spawn 不发 brush 事件，这里用同一份实体文本补「载图初态」，之后事件只做增量。
      const initialHidden = parseInitialHidden(context.entityIoJson);
      initialHiddenCount = initialHidden.size;
      if (initialHidden.size > 0) visibility.applyInitialHidden(initialHidden);
      const after = visibility.stats();
      logLimitations(after.limitations);
      runtime.log(
        `brush 可见性索引：${after.entities} 个实体 / ${after.slots} 区间 / ${after.triangles} 三角` +
          `（几何 ${after.tablesAccepted} 张：索引写 0 ${after.indexSlots} 区间、顶点塌缩 ${after.vertexSlots} 区间；` +
          `跳过 ${after.skippedGeometries} 张；初态隐藏 ${initialHiddenCount} 个` +
          `${after.groupEntities > 0 ? `；动态组 ${after.groupEntities} 个` : ''}）`,
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
      const result = visibility.setEntityHidden(parsed.entityIndex, shouldHide);
      if (result.rebuilt) {
        // PVS 运行期才接管时 index 缓冲被换掉，模块会整张重建索引并重放隐藏状态。
        // 原实现重建走 resetBindings()，会把「初态隐藏」计数与 sceneLoaded 一起清零且不恢复，
        // 这里照做以保持状态行文案不变（属原实现 quirk，不是新语义）。
        initialHiddenCount = 0;
        sceneLoaded = false;
        const stats = visibility.stats();
        runtime.log(
          `brush 可见性索引已按 PVS 新缓冲重建：${stats.entities} 实体，重放隐藏 ${stats.desiredHidden} 个`,
        );
      }
      if (result.status === 'unresolved') {
        const stats = visibility.stats();
        if (stats.unresolvedEvents <= LOG_LIMIT) {
          runtime.log(`brush 事件实体 ${parsed.entityIndex} 未定位到合并区间（换图/来源表缺失），不隐藏`);
        }
        return;
      }
      if (result.status === 'unchanged') return;
      const amount = result.slots > 0
        ? `${result.triangles} 三角 / ${result.slots} 区间`
        : '整组显隐（不写几何缓冲）';
      runtime.log(
        `brush 实体 ${parsed.entityIndex} ${shouldHide ? '隐藏' : '恢复'}：${amount}`,
      );
    },

    statusText(): string {
      const stats = visibility.stats();
      if (!sceneLoaded) return '尚未载图（未建立实体→区间索引）';
      const last = lastEvent ?? '—';
      const limit = stats.limitations.length > 0 ? `；限制 ${stats.limitations.length} 项` : '';
      const groupPart = stats.groupEntities > 0
        ? `；动态组 ${stats.groupEntities}（隐藏 ${stats.groupHidden}）`
        : '';
      return (
        `已隐藏 ${stats.hiddenEntities}/${stats.entities} 实体，退化 ${stats.hiddenTriangles} 三角/${stats.hiddenSlots} 区间` +
        `（索引写 0 ${stats.hiddenIndexSlots} 区间；顶点塌缩 ${stats.hiddenVertexSlots} 区间）${groupPart}；` +
        `初态隐藏 ${initialHiddenCount}；最后事件 ${last}；未定位 ${stats.unresolvedEvents}${limit}`
      );
    },

    dispose(): void {
      visibility.dispose();
      lastEvent = null;
      initialHiddenCount = 0;
      sceneLoaded = false;
    },
  };
}
