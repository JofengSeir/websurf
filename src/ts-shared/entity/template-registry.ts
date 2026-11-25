/**
 * point_template 成员登记与「单实例」生命周期（T-N2a）。
 *
 * 背景：point_template 在 SDK 里是「模板集合 + 实例工厂」——地图解析阶段
 * StartBuildingTemplates 把 Template01..16 指向的实体从世界移除并登记成模板；
 * ForceSpawn（直接调用或经 env_entity_maker）用这些登记项重新 CreateInstance，
 * 生成真正可用的副本并 fire OnEntitySpawned。本仓此前只 emit 了诊断事件，
 * 成员实体照常留在场景里，于是 ze_cursed 出现「Boss 开局就在、触发后反而不出现」。
 *
 * 本卡只做**单实例闭环**（T-N2b 再做多份动态克隆）：
 * - 装载期扫描全图 point_template 的 Template01..16，登记成员（含同名多实体）；
 * - 只接管「全图恰好 1 处 ForceSpawn 站点」的模板。站点数从实体 I/O 连接图推导：
 *   统计 ForceSpawn / ForceSpawnAtEntityOrigin 输入、且目标解析到该模板
 *   （直接指向模板，或指向 EntityTemplate 等于它的 env_entity_maker）的连接条数。
 *   多站点模板（ze_cursed 的 4 个）保持现状，原样留给 T-N2b；
 * - 出生时把成员摘除：brush/prop 隐藏 + 非实心，trigger/logic 置 disabled；
 * - ForceSpawn 时按**出生快照**恢复（不是无条件打开：StartDisabled 的成员
 *   恢复后仍应保持关闭），随后由调用方 fire OnEntitySpawned。
 *
 * spawnflags（CPointTemplate）：
 * - bit0 0x0001 = DONTREMOVE_TEMPLATE_ENTITIES：置位时成员不摘除，本层不接管；
 * - bit1 0x0002 = PRESERVE_NAMES：抑制 CreateInstance 后的名字去重。单实例闭环
 *   不产生副本，没有可去重的名字，因此按语义 no-op（T-N2b 做克隆时必须实现）。
 *
 * 依赖方向：本模块只依赖 base-entity / entity-list（+ 类型），
 * 由 entity-system 与 classes/logic 单向引用，不反向 import 系统层或类注册表，
 * 保持 src/ts-shared/entity/ 无环。
 */
import type { Entity, EntityRuntime } from './base-entity.js';
import { namesMatch } from './entity-list.js';
import type { EventAction } from './entity-io.js';

/** SF_POINTTEMPLATE_DONTREMOVE_TEMPLATEENTITIES（point_template.cpp）。 */
export const SPAWNFLAG_DONTREMOVE_TEMPLATE_ENTITIES = 0x0001;
/** SF_POINTTEMPLATE_PRESERVE_NAMES（point_template.cpp）：单实例闭环无副本可去重。 */
export const SPAWNFLAG_PRESERVE_NAMES = 0x0002;
/** env_entity_maker 的 AUTOSPAWN（env_entity_maker.cpp:SF_ENV_ENTITY_MAKER_AUTOSPAWN）。 */
export const ENV_ENTITY_MAKER_AUTOSPAWN = 0x0001;

export type TemplateMemberKind = 'brush' | 'trigger' | 'logic';

/** 成员在「出生摘除」前的状态快照；ForceSpawn 按它恢复。 */
interface MemberState {
  entity: Entity;
  kind: TemplateMemberKind;
  disabled: boolean;
  triggerSolidFlag: boolean;
  brushOn: boolean;
}

interface ManagedTemplate {
  template: Entity;
  members: MemberState[];
}

/** 一次装载的接管概况（诊断 / 测试）。 */
export interface TemplateSummary {
  /** 被接管的模板 targetname（全图仅 1 处 ForceSpawn 站点）。 */
  managed: string[];
  /** 有 >1 处站点、按卡留给 T-N2b 的模板。 */
  skippedMultiSite: string[];
  /** spawnflags bit0 置位、按 SDK 保留成员的模板。 */
  skippedKeepMembers: string[];
  /** 被接管模板的成员实体总数。 */
  managedMembers: number;
  /** 当前仍处于摘除状态的 brush 成员下标数。 */
  suppressedBrushes: number;
}

const EMPTY_SUMMARY: TemplateSummary = {
  managed: [], skippedMultiSite: [], skippedKeepMembers: [], managedMembers: 0, suppressedBrushes: 0,
};

const registries = new WeakMap<EntityRuntime, TemplateRegistry>();

/** 取某个运行期实例的模板登记表（装载期由 EntitySystem 创建并 scan）。 */
export function registryFor(runtime: EntityRuntime): TemplateRegistry {
  let registry = registries.get(runtime);
  if (!registry) {
    registry = new TemplateRegistry(runtime);
    registries.set(runtime, registry);
  }
  return registry;
}

/**
 * point_template::InputForceSpawn 的生命周期部分：恢复已登记成员。
 * 返回 false 表示该模板未被接管（多站点 / bit0 / 无成员），调用方保持既有输出行为。
 */
export function forceSpawnTemplate(template: Entity): boolean {
  return registryFor(template.runtime).forceSpawn(template);
}

export class TemplateRegistry {
  private readonly runtime: EntityRuntime;
  private readonly managed = new Map<Entity, ManagedTemplate>();
  private readonly suppressedBrushes = new Set<number>();
  private summaryData: TemplateSummary = EMPTY_SUMMARY;

  constructor(runtime: EntityRuntime) {
    this.runtime = runtime;
  }

  /** 换图 / 卸载：清空登记与摘除集合（实体对象由 EntitySystem 自己回收）。 */
  reset(): void {
    this.managed.clear();
    this.suppressedBrushes.clear();
    this.summaryData = EMPTY_SUMMARY;
  }

  /** 装载期扫描（在全部实体 Spawn + Activate 之后调用，才能拿到正确的出生状态）。 */
  scan(entities: readonly Entity[]): void {
    this.reset();
    const sites = collectForceSpawnSites(entities);
    const managed: string[] = [];
    const skippedMultiSite: string[] = [];
    const skippedKeepMembers: string[] = [];
    let managedMembers = 0;

    for (const template of entities) {
      if (!isClassname(template, 'point_template')) continue;
      const name = template.targetname.trim();
      if (!name) continue;
      // SDK CPointTemplate::ShouldRemoveTemplateEntities()：bit0 置位 ⇒ 成员保留。
      if (template.hasSpawnFlags(SPAWNFLAG_DONTREMOVE_TEMPLATE_ENTITIES)) {
        skippedKeepMembers.push(name);
        continue;
      }
      const templateSites = sites.get(name.toLowerCase());
      if (!templateSites || templateSites.size === 0) continue;
      if (templateSites.size > 1) {
        skippedMultiSite.push(name);
        continue;
      }
      const members = resolveMembers(template, entities);
      if (members.length === 0) continue;

      const states: MemberState[] = members.map((entity) => ({
        entity,
        kind: memberKind(entity),
        disabled: entity.disabled,
        triggerSolidFlag: entity.triggerSolidFlag,
        brushOn: entity.getBool('brushOn', true),
      }));
      for (const state of states) suppressMember(state);
      for (const state of states) {
        if (state.kind === 'brush') this.suppressedBrushes.add(state.entity.index);
      }
      this.managed.set(template, { template, members: states });
      managedMembers += states.length;
      managed.push(name);
    }

    this.summaryData = { managed, skippedMultiSite, skippedKeepMembers, managedMembers, suppressedBrushes: this.suppressedBrushes.size };
    if (managed.length > 0) {
      this.runtime.log(
        '[point_template] 单实例接管 ' + managed.length + ' 个模板 / ' + managedMembers + ' 个成员；' +
        '多站点保留 ' + skippedMultiSite.length + ' 个：' + (skippedMultiSite.join(',') || '-'),
      );
    }
  }

  /** ForceSpawn：按出生快照恢复成员。未接管返回 false。 */
  forceSpawn(template: Entity): boolean {
    const entry = this.managed.get(template);
    if (!entry) return false;
    for (const state of entry.members) {
      restoreMember(state);
      if (state.kind === 'brush') this.suppressedBrushes.delete(state.entity.index);
    }
    return true;
  }

  /** 仍处于「出生摘除」状态的 brush 成员下标（EntityGameplay 装载期同步渲染/物理镜像）。 */
  suppressedBrushIndices(): number[] {
    return [...this.suppressedBrushes];
  }

  summary(): TemplateSummary {
    return { ...this.summaryData, suppressedBrushes: this.suppressedBrushes.size };
  }
}

// ── 站点统计 ────────────────────────────────────────────────────────────────

/**
 * 统计每个模板的 ForceSpawn 站点（输出连接条数），key 是模板名的小写。
 *
 * 解析口径与 FindEntityByName 一致：NamesMatch（大小写不敏感、支持末尾 *），
 * !self 一类过程名不参与（模板不存在以过程名为 target 的写法）。
 * 目标为 env_entity_maker 时按其 EntityTemplate 归属到模板。
 */
function collectForceSpawnSites(entities: readonly Entity[]): Map<string, Set<EventAction>> {
  const sites = new Map<string, Set<EventAction>>();
  for (const source of entities) {
    for (const output of source.outputs.values()) {
      const actions = output.getActionList();
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        const input = (action.targetInput ?? '').toLowerCase();
        if (input !== 'forcespawn' && input !== 'forcespawnatentityorigin') continue;
        const target = (action.target ?? '').trim();
        if (!target || target.startsWith('!')) continue;
        for (const hit of entitiesNamed(entities, target)) {
          if (isClassname(hit, 'point_template')) {
            addSite(sites, hit.targetname, action);
          } else if (isClassname(hit, 'env_entity_maker')) {
            addSite(sites, hit.getString('entitytemplate', '').trim(), action);
          }
        }
      }
    }
  }
  return sites;
}

function addSite(sites: Map<string, Set<EventAction>>, templateName: string, action: EventAction): void {
  const key = templateName.trim().toLowerCase();
  if (!key) return;
  const set = sites.get(key);
  if (set) set.add(action);
  else sites.set(key, new Set([action]));
}

/** 按 NamesMatch 解析名字（含末尾 *）：对应 SDK 的 FindEntityByName 遍历。 */
function entitiesNamed(entities: readonly Entity[], query: string): Entity[] {
  const out: Entity[] = [];
  for (const entity of entities) {
    if (entity.targetname && namesMatch(query, entity.targetname)) out.push(entity);
  }
  return out;
}

/** 汇总 Template01..16 的成员实体（同名多实体全部登记，与 SDK 的循环查找一致）。 */
function resolveMembers(template: Entity, entities: readonly Entity[]): Entity[] {
  const members: Entity[] = [];
  const seen = new Set<Entity>();
  for (let i = 1; i <= 16; i++) {
    const key = 'Template' + String(i).padStart(2, '0');
    const name = template.getString(key, '').trim();
    if (!name) continue;
    for (const hit of entitiesNamed(entities, name)) {
      if (seen.has(hit)) continue;
      seen.add(hit);
      members.push(hit);
    }
  }
  return members;
}

// ── 成员分类与状态切换 ──────────────────────────────────────────────────────

function isClassname(entity: Entity, classname: string): boolean {
  return entity.classname.toLowerCase() === classname;
}

/**
 * 成员类型判定（决定摘除/恢复用哪条通道）：
 * - trigger：classChain 含 trigger 基类 —— disabled + FSOLID_TRIGGER 双状态；
 * - brush/prop：有 brush 体积、非 *N 的 model（贴图/精灵/道具），或 func_/prop_/weapon_ 前缀；
 * - 其余按逻辑实体：只置 disabled（acceptInput 不检查它，见各触发器的既有语义）。
 */
function memberKind(entity: Entity): TemplateMemberKind {
  if (entity.classChain.some((cls) => cls.name === 'trigger')) return 'trigger';
  if (entity.volumes.length > 0) return 'brush';
  const model = (entity.getRaw('model') ?? entity.model ?? '').trim();
  if (model && !model.startsWith('*')) return 'brush';
  const classname = entity.classname.toLowerCase();
  if (
    classname.startsWith('func_') || classname.startsWith('prop_') || classname.startsWith('weapon_') ||
    classname === 'env_sprite' || classname === 'env_beam'
  ) {
    return 'brush';
  }
  return 'logic';
}

/** 出生摘除：brush/prop 隐藏+非实心；trigger 双状态关闭；logic 只 disabled。 */
function suppressMember(state: MemberState): void {
  const entity = state.entity;
  if (state.kind === 'brush') {
    entity.set('brushOn', false);
    entity.disabled = true;
    entity.runtime.host.setBrushEnabled?.(entity.index, false);
    return;
  }
  entity.disabled = true;
  if (state.kind === 'trigger') entity.triggerSolidFlag = false;
}

/** ForceSpawn 恢复：回到成员自己的出生状态（不是无条件可见/实心）。 */
function restoreMember(state: MemberState): void {
  const entity = state.entity;
  if (state.kind === 'brush') {
    entity.set('brushOn', state.brushOn);
    entity.disabled = state.disabled;
    entity.runtime.host.setBrushEnabled?.(entity.index, state.brushOn);
    return;
  }
  entity.disabled = state.disabled;
  if (state.kind === 'trigger') entity.triggerSolidFlag = state.triggerSolidFlag;
}
