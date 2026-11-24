/**
 * 实体关联链只读收集（`G` 关联浮层 / 连锁连线共用）。
 *
 * 为什么单独成模块：
 * - `interact-visualizer.ts` 只关心「画哪条线」，`interact-ui.ts` 只关心「列表怎么显示」；
 *   两者都需要同一份「根实体 → outputs 目标（2 层）」解析结果，拆成纯数据函数避免各写一份、
 *   也保证 G 键浮层里看到的关联与画面连线严格同源。
 *
 * 解析规则与实体 I/O 一致：沿 `Entity.outputs` 的 `EventAction` 取 `target`，
 * 用 `EntityList.findEntityByName` 解析 targetname（大小写不敏感、支持尾部 `*`、同名可多个）。
 * `!self` / `!activator` 这类特殊目标不是实体表里的名字，跳过并在结果里计数，供 UI 解释空链。
 *
 * 图结构：
 * - `nodes` 按 BFS 首次发现去重（一个实体在列表里只出现一次，层级取最近层）；
 * - `edges` 尽量完整：先记 BFS 发现边（`primary: true`，每个目标一条），再补一次
 *   「根 + 目前已发现节点」之间的全部边（跨层、重复触发都保留，按 from/to/output/input/
 *   parameter/delay 去重），供抽屉完整展示；面板每行只展示主触发路径，其余以 `+N` 标注。
 */
import type { Entity } from '../../../../src/ts-shared/entity/base-entity.js';
import type { EntitySystem } from '../../../../src/ts-shared/entity/entity-system.js';

/** 连锁展开深度（按钮 → counter → 碎墙/门 恰好 2 层）。 */
export const CHAIN_DEPTH = 2;
/** BFS 最多收集多少条发现边（防止大图 outputs 爆炸）。 */
export const CHAIN_MAX_EDGES = 96;
/** 二次补全（跨层/重复触发）的边数上限；只影响抽屉完整度，不影响节点。 */
const CHAIN_MAX_ALL_EDGES = 192;

/** 实体运行时状态（列表徽记 / 刷新签名共用）。 */
export type EntityLifeState = 'live' | 'disabled' | 'removed';

/** 一条「输出 → 目标实体」的关联边（含触发它的 output 名与输入动作）。 */
export interface ChainEdgeInfo {
  /** 去重键：from/to/output/input/parameter/delay。 */
  key: string;
  /** 发出输出的实体下标。 */
  from: number;
  /** 被触发的目标实体下标。 */
  to: number;
  /** 距根实体的层数（1 = 根的直接输出目标）。 */
  depth: number;
  /** 发出该连接的 output 名（如 `onpressed`）。 */
  output: string;
  /** 目标输入名（如 `Add`；解析规则同 EventAction：空 ⇒ `Use`）。 */
  input: string;
  /** 输入参数（null = 用默认参数）。 */
  parameter: string | null;
  /** 延迟（秒）。 */
  delay: number;
  /** 该动作剩余可触发次数（-1 = 无限；有限值会随运行时递减）。 */
  timesToFire: number;
  /** 是否为目标的首条发现边（面板每一行只展示主触发路径）。 */
  primary: boolean;
}

/** 关联链里的一个目标实体。 */
export interface ChainNodeInfo {
  entity: Entity;
  depth: number;
}

/** 一次关联链收集结果。 */
export interface ChainInfo {
  root: Entity;
  /** 根实体之外、沿输出可达的目标实体（去重，按首次发现顺序）。 */
  nodes: ChainNodeInfo[];
  /** 关联边：发现边 + 补全的跨层/重复边（见文件头注释）。 */
  edges: ChainEdgeInfo[];
  /** 是否因边数上限被截断。 */
  truncated: boolean;
  /** 指向 `!activator` / `!self` 等特殊目标的动作数（不产生实体关联）。 */
  skippedSpecial: number;
  /** 目标名能解析但就是发出者自身的动作数（已忽略）。 */
  skippedSelf: number;
  /** 目标名为空或在实体表里找不到的动作数。 */
  skippedUnresolved: number;
}

/** 输出统计（事件名数 / 连接数）。 */
export interface EntityOutputStats {
  events: number;
  links: number;
}

/** 实体输出事件与连接总数（面板副标题、抽屉信息格用）。 */
export function entityOutputStats(entity: Entity): EntityOutputStats {
  let events = 0;
  let links = 0;
  for (const output of entity.outputs.values()) {
    const n = output.getActionList().length;
    if (n > 0) events++;
    links += n;
  }
  return { events, links };
}

/** 实体输出连接总数（含全部 output 事件）。 */
export function entityOutputLinkCount(entity: Entity): number {
  return entityOutputStats(entity).links;
}

/** 实体运行时状态：被移除 > 被禁用 > 正常。 */
export function entityLifeState(entity: Entity): EntityLifeState {
  if (entity.markedForDeletion) return 'removed';
  if (entity.disabled) return 'disabled';
  return 'live';
}

/**
 * 按 targetname 解析出全部目标实体（与 `EntityList.findEntityByName` 同规则）。
 *
 * 不做 `volumes` 过滤：按钮的目标大多是 math_counter / prop_dynamic / env_entity_maker
 * 这类没有 brush 体积的实体，过滤掉会让连线/列表永远为空（实测按钮有多条 OnPressed 连接，
 * 但按体积过滤后 chainEdges 为 0）。
 */
export function resolveTargetEntities(system: EntitySystem, name: string): Entity[] {
  const out: Entity[] = [];
  let cur: Entity | null = null;
  for (let guard = 0; guard < 64; guard++) {
    const found = system.entList.findEntityByName(cur, name, null, null, null);
    if (!found) break;
    out.push(found);
    cur = found;
  }
  return out;
}

/** 实体显示名：targetname 优先，否则 classname。 */
export function entityDisplayName(entity: Entity): string {
  return entity.targetname || entity.classname || `#${entity.index}`;
}

/** 该实体是否有任何已解析的输出连接（用于「G 关联」提示是否出现）。 */
export function entityHasOutputs(entity: Entity): boolean {
  for (const output of entity.outputs.values()) {
    if (output.getActionList().length > 0) return true;
  }
  return false;
}

function edgeKey(
  from: number,
  to: number,
  output: string,
  input: string,
  parameter: string | null,
  delay: number,
): string {
  return `${from}|${to}|${output}|${input}|${parameter ?? ''}|${delay}`;
}

/**
 * 从根实体沿 outputs 展开关联链。
 *
 * @returns 根实体不存在/未就绪时返回 null。
 */
export function collectEntityChain(
  system: EntitySystem | null,
  rootIndex: number,
  depth = CHAIN_DEPTH,
  maxEdges = CHAIN_MAX_EDGES,
): ChainInfo | null {
  if (!system || rootIndex < 0) return null;
  const root = system.getEntity(rootIndex);
  if (!root) return null;

  const nodes: ChainNodeInfo[] = [];
  const edges: ChainEdgeInfo[] = [];
  const seen = new Set<number>([root.index]);
  const edgeKeys = new Set<string>();
  const nodeDepth = new Map<number, number>([[root.index, 0]]);
  let frontier: Entity[] = [root];
  let truncated = false;
  let skippedSpecial = 0;
  let skippedSelf = 0;
  let skippedUnresolved = 0;

  /** BFS 一遍：建立节点集合与主发现边。 */
  outer: for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: Entity[] = [];
    for (const source of frontier) {
      for (const [outputName, output] of source.outputs) {
        for (const action of output.getActionList()) {
          const targetName = action.target;
          if (!targetName) {
            skippedUnresolved++;
            continue;
          }
          if (targetName.startsWith('!')) {
            skippedSpecial++;
            continue;
          }
          const matches = resolveTargetEntities(system, targetName);
          if (matches.length === 0) {
            skippedUnresolved++;
            continue;
          }
          for (const target of matches) {
            if (target.index === source.index) {
              skippedSelf++;
              continue;
            }
            if (seen.has(target.index)) continue;
            seen.add(target.index);
            nodeDepth.set(target.index, d);
            next.push(target);
            nodes.push({ entity: target, depth: d });
            const key = edgeKey(
              source.index,
              target.index,
              outputName,
              action.targetInput ?? 'Use',
              action.parameter,
              action.delay,
            );
            edgeKeys.add(key);
            edges.push({
              key,
              from: source.index,
              to: target.index,
              depth: d,
              output: outputName,
              input: action.targetInput ?? 'Use',
              parameter: action.parameter,
              delay: action.delay,
              timesToFire: action.timesToFire,
              primary: true,
            });
            if (edges.length >= maxEdges) {
              truncated = true;
              break outer;
            }
          }
        }
      }
    }
    frontier = next;
  }

  /**
   * 第二遍：在「根 + 已发现节点」之间补全所有边。
   *
   * 只补边不补节点——节点集合已经由 BFS 决定；这里解决两类丢失：
   * - 同一目标被多个 output 触发（BFS 只会遇到一次）；
   * - 二级节点反向/跨层输出到一级节点或根（BFS 因 seen 直接跳过）。
   */
  if (!truncated && edges.length < CHAIN_MAX_ALL_EDGES) {
    const inChain = seen;
    const sources: Entity[] = [root, ...nodes.map((n) => n.entity)];
    for (const source of sources) {
      for (const [outputName, output] of source.outputs) {
        for (const action of output.getActionList()) {
          const targetName = action.target;
          if (!targetName || targetName.startsWith('!')) continue;
          const matches = resolveTargetEntities(system, targetName);
          for (const target of matches) {
            if (target.index === source.index || !inChain.has(target.index)) continue;
            const key = edgeKey(
              source.index,
              target.index,
              outputName,
              action.targetInput ?? 'Use',
              action.parameter,
              action.delay,
            );
            if (edgeKeys.has(key)) continue;
            edgeKeys.add(key);
            edges.push({
              key,
              from: source.index,
              to: target.index,
              depth: nodeDepth.get(target.index) ?? depth,
              output: outputName,
              input: action.targetInput ?? 'Use',
              parameter: action.parameter,
              delay: action.delay,
              timesToFire: action.timesToFire,
              primary: false,
            });
            if (edges.length >= CHAIN_MAX_ALL_EDGES) {
              truncated = true;
              break;
            }
          }
          if (truncated) break;
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
  }

  return { root, nodes, edges, truncated, skippedSpecial, skippedSelf, skippedUnresolved };
}
