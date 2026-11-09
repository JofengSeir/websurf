/**
 * `CBaseFilter` 家族。对照 Source SDK 2013 `game/server/filters.cpp`：
 * - `:19-72`（CBaseFilter DATADESC / PassesFilter / InputTestActivator）
 * - `:90-230`（CFilterMultiple：Filter01..05、AND/OR、Activate 时压成连续数组）
 * - `:240-270`（CFilterName，`!player` 特例）
 * - `:276-300`（CFilterClass）、`:305-325`（FilterTeam）
 * - `:330-355`（CFilterMassGreater）、`:360-390`（FilterDamageType）
 * - `:396-630`（CFilterEnemy，AI 相关，宿主侧降级）
 *
 * 硬语义：
 * - `PassesFilter = Negated ? !PassesFilterImpl(...) : PassesFilterImpl(...)`，取反只在**最外层**；
 *   所以 `filter_multi` 组合子 filter 时必须调 `passesFilter(child, ...)` 而不是直接调 impl。
 * - `NameMatches(query)` 的通配符在 **query**（即地图写的 `filtername`）里，不是在被检实体名里；
 *   `NamesMatch` 只支持末尾 `*`（见 entity-list.ts）。
 * - `filter_multi` 的 AND 在空列表下返回 true，OR 在空列表下返回 false。
 */
import type { Entity, EntityClass } from '../base-entity.js';
import { FIELD_INPUT } from '../variant.js';
import { findAllByName, input, passesFilter, setFilterImpl } from './common.js';
import { registerClass } from './registry.js';

/** `CBaseFilter`（filters.cpp:19-72）。 */
export const BaseFilterClass: EntityClass = {
  name: 'filter_base',
  base: 'logical',
  keyfields: [{ name: 'Negated', type: 'bool', defaultValue: false }],
  outputs: [
    { name: 'OnPass', kind: 'event' },
    { name: 'OnFail', kind: 'event' },
  ],
  inputs: [
    input('TestActivator', FIELD_INPUT, (e, d) => {
      const tested = d.activator as Entity | null;
      const caller = d.caller as Entity | null;
      if (!tested) return;
      // InputTestActivator 用 pCaller 作 caller、pActivator 作被测实体，
      // 并把 pActivator 原样透传为输出的 activator（filters.cpp:65-72）。
      if (passesFilter(e, caller, tested)) e.fire('OnPass', tested, e);
      else e.fire('OnFail', tested, e);
    }),
  ],
  spawn: (e) => setFilterImpl(e, () => true),
};

/** 判断实体是否为 filter 类族（`filter_multi::Activate` 的 dynamic_cast 等价物）。 */
export function isFilter(entity: Entity | null): boolean {
  return !!entity && entity.classChain.some((c) => c.name === 'filter_base');
}

/** `CFilterName`（filters.cpp:240-270）。 */
export const FilterNameClass: EntityClass = {
  name: 'filter_activator_name',
  base: 'filter_base',
  keyfields: [{ name: 'filtername', type: 'string', defaultValue: '' }],
  spawn: (e) => setFilterImpl(e, (_caller, tested) => {
    const name = e.getString('filtername', '') || e.getRaw('filtername') || '';
    // 玩家的 GetEntityName 不是 "!player"，SDK 显式特判。
    if (name.toLowerCase() === '!player') return tested.isPlayer();
    return tested.nameMatches(name);
  }),
};

/** `CFilterClass`（filters.cpp:276-300）。 */
export const FilterClassClass: EntityClass = {
  name: 'filter_activator_class',
  base: 'filter_base',
  keyfields: [{ name: 'filterclass', type: 'string', defaultValue: '' }],
  spawn: (e) => setFilterImpl(e, (_caller, tested) =>
    tested.classMatches(e.getString('filterclass', '') || e.getRaw('filterclass') || '')),
};

/** `FilterTeam`（filters.cpp:305-325）。`GetTeamNumber` 对应 `SetTeam` 写入的 `teamnum`。 */
export const FilterTeamClass: EntityClass = {
  name: 'filter_activator_team',
  base: 'filter_base',
  keyfields: [{ name: 'filterteam', type: 'int', defaultValue: 0 }],
  spawn: (e) => setFilterImpl(e, (_caller, tested) =>
    tested.getNumber('teamnum', 0) === e.getNumber('filterteam', 0)),
};

/** `CFilterMassGreater`（filters.cpp:330-355）：没有 VPhysics 对象一律 false。 */
export const FilterMassGreaterClass: EntityClass = {
  name: 'filter_activator_mass_greater',
  base: 'filter_base',
  keyfields: [{ name: 'filtermass', type: 'float', defaultValue: 0 }],
  spawn: (e) => setFilterImpl(e, (_caller, tested) => {
    const mass = tested.getNumber('mass', Number.NaN);
    return Number.isFinite(mass) && mass > e.getNumber('filtermass', 0);
  }),
};

/** `FilterDamageType`（filters.cpp:360-390）：PassesFilterImpl 只有 Assert(false) + return true。 */
export const FilterDamageTypeClass: EntityClass = {
  name: 'filter_damage_type',
  base: 'filter_base',
  keyfields: [{ name: 'damagetype', type: 'int', defaultValue: 0 }],
  spawn: (e) => setFilterImpl(e, () => true),
};

const MAX_FILTERS = 5;
const FILTER_AND = 0;
const FILTER_OR = 1;

/**
 * `CFilterMultiple`（filters.cpp:90-230）。
 * Activate 时把 Filter01..05 解析成**连续**句柄数组（非 filter 实体被跳过）；
 * 每个子 filter 走完整的 `PassesFilter`（含它自己的 Negated）。
 */
export const FilterMultipleClass: EntityClass = {
  name: 'filter_multi',
  base: 'filter_base',
  keyfields: [
    { name: 'FilterType', type: 'int', defaultValue: FILTER_AND },
    ...Array.from({ length: MAX_FILTERS }, (_, i) => ({
      name: `Filter${String(i + 1).padStart(2, '0')}`,
      type: 'string' as const,
      defaultValue: '',
    })),
  ],
  activate: (e) => {
    const list: Entity[] = [];
    for (let i = 1; i <= MAX_FILTERS; i++) {
      const key = `filter${String(i).padStart(2, '0')}`;
      const name = e.getString(key, '') || e.getRaw(key) || '';
      if (!name) continue;
      // SDK 用 FindEntityByName(NULL, ...) 只取**第一个**同名 filter。
      const found = findAllByName(name).find(isFilter) ?? null;
      if (found) list.push(found);
    }
    e.set('__filters', list);
  },
  spawn: (e) => setFilterImpl(e, (caller, tested) => {
    const list = e.get<Entity[]>('__filters') ?? [];
    if (e.getNumber('filtertype', FILTER_AND) === FILTER_OR) {
      // OR：空列表返回 false
      for (const f of list) if (passesFilter(f, caller, tested)) return true;
      return false;
    }
    // AND（也是 FilterType 缺省值）：空列表返回 true
    for (const f of list) if (!passesFilter(f, caller, tested)) return false;
    return true;
  }),
};

/**
 * `CFilterEnemy`（filters.cpp:396-630）依赖 AI squad / NPC 关系图，浏览器宿主没有 AI。
 * 这里保留 `filtername` 名字匹配的降级语义并显式标注，不假装实现了 squad 逻辑。
 */
export const FilterEnemyClass: EntityClass = {
  name: 'filter_enemy',
  base: 'filter_base',
  keyfields: [
    { name: 'filtername', type: 'string', defaultValue: '' },
    { name: 'filter_radius', type: 'float', defaultValue: 0 },
    { name: 'filter_outer_radius', type: 'float', defaultValue: 0 },
    { name: 'filter_max_per_enemy', type: 'int', defaultValue: 0 },
  ],
  spawn: (e) => setFilterImpl(e, (_caller, tested) => {
    const name = e.getString('filtername', '') || e.getRaw('filtername') || '';
    return name ? tested.nameMatches(name) : true;
  }),
};

/** 其它分支常见的 filter：保留基类行为（默认通过 + Negated + TestActivator），连接不丢。 */
const PLAIN_FILTERS = [
  'filter_activator_flag',
  'filter_activator_health',
  'filter_activator_speed',
  'filter_activator_model',
  'filter_activator_context',
  'filter_activator_attribute_int',
  'filter_activator_attribute_float',
  'filter_activator_classify',
  'filter_proximity',
  'filter_los',
  'filter_human',
];

export function registerFilterClasses(): void {
  for (const cls of [
    BaseFilterClass,
    FilterMultipleClass,
    FilterNameClass,
    FilterClassClass,
    FilterTeamClass,
    FilterMassGreaterClass,
    FilterDamageTypeClass,
    FilterEnemyClass,
  ]) registerClass(cls);
  for (const name of PLAIN_FILTERS) registerClass({ name, base: 'filter_base' });
}
