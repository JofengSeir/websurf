/**
 * 实体关联链只读收集（`+use` 浮层 / 连锁连线共用）。
 *
 * 为什么单独成模块：
 * - `interact-visualizer.ts` 只关心「画哪条线」，`interact-ui.ts` 只关心「列表怎么显示」；
 *   两者都需要同一份「根实体 → outputs 目标（2 层）」解析结果，拆成纯数据函数避免各写一份、
 *   也保证 G 键浮层里看到的关联与画面连线严格同源。
 *
 * 解析规则与实体 I/O 一致：沿 `Entity.outputs` 的 `EventAction` 取 `target`，
 * 用 `EntityList.findEntityByName` 解析 targetname（大小写不敏感、支持尾部 `*`、同名可多个），
 * 跳过 `!self` / `!activator` 这类特殊目标（它们不是实体表里的名字）。
 */
import type { Entity } from '../../../../src/ts-shared/entity/base-entity.js';
import type { EntitySystem } from '../../../../src/ts-shared/entity/entity-system.js';

/** 连锁展开深度（按钮 → counter → 碎墙/门 恰好 2 层）。 */
export const CHAIN_DEPTH = 2;
/** 同时最多收集多少条边（防止大图 outputs 爆炸）。 */
export const CHAIN_MAX_EDGES = 96;

/** 一条「输出 → 目标实体」的关联边（含触发它的 output 名与输入动作）。 */
export interface ChainEdgeInfo {
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
  edges: ChainEdgeInfo[];
  /** 是否因边数上限被截断。 */
  truncated: boolean;
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
  let frontier: Entity[] = [root];
  let truncated = false;

  outer: for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: Entity[] = [];
    for (const source of frontier) {
      for (const [outputName, output] of source.outputs) {
        for (const action of output.getActionList()) {
          const targetName = action.target;
          if (!targetName || targetName.startsWith('!')) continue;
          const matches = resolveTargetEntities(system, targetName);
          for (const target of matches) {
            if (target.index === source.index || seen.has(target.index)) continue;
            seen.add(target.index);
            next.push(target);
            nodes.push({ entity: target, depth: d });
            edges.push({
              from: source.index,
              to: target.index,
              depth: d,
              output: outputName,
              input: action.targetInput ?? 'Use',
              parameter: action.parameter,
              delay: action.delay,
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

  return { root, nodes, edges, truncated };
}
