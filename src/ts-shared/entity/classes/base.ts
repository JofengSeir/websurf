/**
 * SDK 基类族：`CBaseTrigger` / `CBaseToggle` / `CLogicalEntity` / `CPointEntity`。
 *
 * 对照 Source SDK 2013：
 * - `game/server/triggers.cpp:98-124`（CBaseTrigger DATADESC）、`:138-178`（输入）、
 *   `:182-201`（Spawn）、`:220-301`（Enable/Disable/Toggle/TouchTest）、`:348-374`（InitTrigger）、
 *   `:381-457`（PassesTriggerFilters）、`:482-556`（StartTouch/EndTouch）、`:588-600`（InputToggle）
 * - `game/server/triggers.h:21-36`（spawnflags 常量）
 * - `game/server/subs.cpp:155-190`（`CBaseToggle::KeyValue` 的 `wait` / `lip` / `distance` / `master`）
 *
 * 两个容易写错的点：
 * - `m_bDisabled` 与 `FSOLID_TRIGGER` 是**两个独立状态**：`InputToggle` 只翻后者，不改 `m_bDisabled`。
 * - `EndTouch` 里防 disabled 的 `if (!m_bDisabled)` 被 Valve **注释掉了**，所以 disable 后仍会 fire
 *   `OnEndTouch` / `OnEndTouchAll`。
 */
import type { Entity, EntityClass } from '../base-entity.js';
import { FIELD_VOID, FIELD_STRING } from '../variant.js';
import { fire, passesFilter, resolveFilter, input, scheduleRemove } from './common.js';
import { registerClass } from './registry.js';

/** `triggers.h:21-36`。 */
export const SF_TRIGGER: Record<string, number> = {
  ALLOW_CLIENTS: 0x01,
  ALLOW_NPCS: 0x02,
  ALLOW_PUSHABLES: 0x04,
  ALLOW_PHYSICS: 0x08,
  ONLY_PLAYER_ALLY_NPCS: 0x10,
  ONLY_CLIENTS_IN_VEHICLES: 0x20,
  ALLOW_ALL: 0x40,
  PUSH_ONCE: 0x80,
  PUSH_AFFECT_PLAYER_ON_LADDER: 0x100,
  ONLY_CLIENTS_OUT_OF_VEHICLES: 0x200,
  TOUCH_DEBRIS: 0x400,
  ONLY_NPCS_IN_VEHICLES: 0x800,
  DISALLOW_BOTS: 0x1000,
};

/** `CBaseToggle::KeyValue`（subs.cpp:168-190）。 */
export const BaseToggleClass: EntityClass = {
  name: 'base_toggle',
  base: 'base',
  keyfields: [
    { name: 'wait', type: 'float', defaultValue: 0 },
    { name: 'lip', type: 'float', defaultValue: 0 },
    { name: 'distance', type: 'float', defaultValue: 0 },
    { name: 'speed', type: 'float', defaultValue: 0 },
  ],
};

/** `CLogicalEntity` / `CPointEntity`：无新增 I/O，只作为 datamap 链上的基类节点。 */
export const LogicalEntityClass: EntityClass = { name: 'logical', base: 'base' };
export const PointEntityClass: EntityClass = { name: 'point', base: 'base' };

/** `CBaseTrigger::Activate`（triggers.cpp:240-249）：把 `filtername` 解析成实体句柄。 */
function activateTrigger(entity: Entity): void {
  entity.set('__filter', resolveFilter(entity));
  const startDisabled = entity.getBool('startdisabled', false);
  entity.disabled = startDisabled;
  // InitTrigger：StartDisabled ⇒ 移除 FSOLID_TRIGGER（triggers.cpp:348-374）
  entity.triggerSolidFlag = !startDisabled;
  entity.touchingEntities.length = 0;
}

/** `CBaseTrigger::Spawn`（triggers.cpp:182-201）：spawnflags 自动补全。 */
function spawnTrigger(entity: Entity): void {
  if (
    entity.hasSpawnFlags(SF_TRIGGER.ONLY_PLAYER_ALLY_NPCS) ||
    entity.hasSpawnFlags(SF_TRIGGER.ONLY_NPCS_IN_VEHICLES)
  ) {
    entity.addSpawnFlags(SF_TRIGGER.ALLOW_NPCS);
  }
  if (
    entity.hasSpawnFlags(SF_TRIGGER.ONLY_CLIENTS_IN_VEHICLES) ||
    entity.hasSpawnFlags(SF_TRIGGER.ONLY_CLIENTS_OUT_OF_VEHICLES)
  ) {
    entity.addSpawnFlags(SF_TRIGGER.ALLOW_CLIENTS);
  }
}

/**
 * `CBaseTrigger::PassesTriggerFilters`（triggers.cpp:381-457）。
 * spawnflags 是「或」关系白名单；通过后才有玩家存活/bot 等「与」约束；最后才调 filter。
 *
 * 宿主适配：地图没写 `spawnflags` 时按 `ALLOW_CLIENTS(1)` 处理（与本项目既有
 * `parse_teleports` 的默认口径一致）。浏览器端只有一个玩家，没有 NPC / 载具 / bot。
 */
export function passesTriggerFilters(entity: Entity, other: Entity): boolean {
  let flags = entity.spawnflags;
  if (flags === 0) flags = SF_TRIGGER.ALLOW_CLIENTS;

  const isPlayer = other.isPlayer();
  const isNpc = !isPlayer && other.getBool('isNpc', false);
  const isPushable = other.classname === 'func_pushable';
  const isPhysics = other.getBool('movetypePhysics', false);

  const allowed =
    (flags & SF_TRIGGER.ALLOW_ALL) !== 0 ||
    ((flags & SF_TRIGGER.ALLOW_CLIENTS) !== 0 && isPlayer) ||
    ((flags & SF_TRIGGER.ALLOW_NPCS) !== 0 && isNpc) ||
    ((flags & SF_TRIGGER.ALLOW_PUSHABLES) !== 0 && isPushable) ||
    ((flags & SF_TRIGGER.ALLOW_PHYSICS) !== 0 && isPhysics);
  if (!allowed) return false;

  if (isPlayer && !other.isAlive()) return false;
  return passesFilter(entity.get<Entity | null>('__filter') ?? null, entity, other);
}

/** `CBaseTrigger::StartTouch`（triggers.cpp:482-505）。 */
export function baseTriggerStartTouch(entity: Entity, other: Entity): void {
  if (!passesTriggerFilters(entity, other)) return;
  let added = false;
  if (!entity.touchingEntities.includes(other)) {
    entity.touchingEntities.push(other);
    added = true;
  }
  entity.fire('OnStartTouch', other, entity);
  if (added && entity.touchingEntities.length === 1) {
    entity.fire('OnStartTouchAll', other, entity);
  }
}

/** `CBaseTrigger::EndTouch`（triggers.cpp:512-556）。 */
export function baseTriggerEndTouch(entity: Entity, other: Entity): void {
  const i = entity.touchingEntities.indexOf(other);
  if (i < 0) return; // IsTouching(pOther)：必须是已通过 filter 的
  entity.touchingEntities.splice(i, 1);

  // 保护 `if (!m_bDisabled)` 在 SDK 里被注释掉 ⇒ disable 后照常 fire
  entity.fire('OnEndTouch', other, entity);

  for (let k = entity.touchingEntities.length - 1; k >= 0; k--) {
    const h = entity.touchingEntities[k];
    if (!h || (h.isPlayer() && !h.isAlive()) || h.markedForDeletion) {
      entity.touchingEntities.splice(k, 1);
    }
  }
  if (entity.touchingEntities.length === 0) {
    entity.fire('OnEndTouchAll', other, entity);
  }
}

/** `CBaseTrigger::TouchTest`（triggers.cpp:286-301）。 */
function touchTest(entity: Entity): void {
  if (entity.disabled) return;
  if (entity.touchingEntities.length !== 0) entity.fire('OnTouching', entity, entity);
  else entity.fire('OnNotTouching', entity, entity);
}

/** `CBaseTrigger::Enable/Disable`（triggers.cpp:220-282）。 */
function setTriggerEnabled(entity: Entity, enabled: boolean): void {
  entity.disabled = !enabled;
  entity.triggerSolidFlag = enabled;
  // SDK 在这里调 PhysicsTouchTriggers() 立即重算；本运行期由下一帧 touch 扫描统一完成。
}

/**
 * `InputDisableAndEndTouch`（triggers.cpp:143-160）：
 * 逆序逐个 EndTouch（每轮重取长度以容错删除），**全部补发完才 Disable**。
 */
function disableAndEndTouch(entity: Entity): void {
  for (;;) {
    const list = entity.touchingEntities;
    if (list.length === 0) break;
    const other = list[list.length - 1];
    invokeEndTouch(entity, other);
    if (list.includes(other)) list.splice(list.indexOf(other), 1);
  }
  setTriggerEnabled(entity, false);
}

/** 调最派生的 `endTouch` 覆盖（子类负责显式调 `baseTriggerEndTouch`）。 */
export function invokeEndTouch(entity: Entity, other: Entity): void {
  for (const cls of entity.classChain) {
    if (cls.endTouch) {
      cls.endTouch(entity, other);
      return;
    }
  }
  baseTriggerEndTouch(entity, other);
}

/** 调最派生的 `startTouch` 覆盖。 */
export function invokeStartTouch(entity: Entity, other: Entity): void {
  for (const cls of entity.classChain) {
    if (cls.startTouch) {
      cls.startTouch(entity, other);
      return;
    }
  }
  baseTriggerStartTouch(entity, other);
}

/** 调最派生的 `touch` 覆盖（`m_pfnTouch`）。 */
export function invokeTouch(entity: Entity, other: Entity): void {
  for (const cls of entity.classChain) {
    if (cls.touch) {
      cls.touch(entity, other);
      return;
    }
  }
}

export const BaseTriggerClass: EntityClass = {
  name: 'trigger',
  base: 'base_toggle',
  brush: true,
  spawnFlags: SF_TRIGGER,
  keyfields: [
    { name: 'filtername', type: 'string', defaultValue: '' },
    { name: 'StartDisabled', type: 'bool', defaultValue: false },
  ],
  outputs: [
    { name: 'OnStartTouch', kind: 'event' },
    { name: 'OnStartTouchAll', kind: 'event' },
    { name: 'OnEndTouch', kind: 'event' },
    { name: 'OnEndTouchAll', kind: 'event' },
    { name: 'OnTouching', kind: 'event' },
    { name: 'OnNotTouching', kind: 'event' },
  ],
  inputs: [
    { name: 'Enable', type: FIELD_VOID, handler: (e) => setTriggerEnabled(e, true) },
    { name: 'Disable', type: FIELD_VOID, handler: (e) => setTriggerEnabled(e, false) },
    { name: 'DisableAndEndTouch', type: FIELD_VOID, handler: (e) => disableAndEndTouch(e) },
    {
      name: 'Toggle',
      type: FIELD_VOID,
      // 只翻 FSOLID_TRIGGER，不改 m_bDisabled（triggers.cpp:588-600）
      handler: (e) => {
        e.triggerSolidFlag = !e.triggerSolidFlag;
      },
    },
    { name: 'TouchTest', type: FIELD_VOID, handler: (e) => touchTest(e) },
    // 模拟触摸：用 pCaller，完全绕过几何（triggers.cpp:463-476）
    input('StartTouch', FIELD_VOID, (e, d) => {
      invokeStartTouch(e, (d.caller as Entity) ?? e);
    }),
    input('EndTouch', FIELD_VOID, (e, d) => {
      invokeEndTouch(e, (d.caller as Entity) ?? e);
    }),
  ],
  spawn: spawnTrigger,
  activate: activateTrigger,
  startTouch: baseTriggerStartTouch,
  endTouch: baseTriggerEndTouch,
};

/** 注册所有基类；由 `classes/index.ts` 在装配阶段调用。 */
export function registerBaseClasses(): void {
  // 注意：不要注册名为 `base` 的空壳。`CBaseEntity` 由 `resolveClassChain`
  // 在链尾统一追加，注册空壳会把真正的基类输入/输出遮蔽掉。
  registerClass(BaseToggleClass);
  registerClass(LogicalEntityClass);
  registerClass(PointEntityClass);
  registerClass(BaseTriggerClass);
}

/** 供其它类模块复用的 spawnflags 常量与基类触发助手。 */
export function fireUserOutput(entity: Entity, n: number, activator: Entity | null): void {
  fire(entity, `OnUser${n}`, activator);
}

/** `CTriggerMultiple` 的 wait 缺省修正（triggers.cpp:949-952）。 */
export function defaultWait(entity: Entity, value: number): number {
  return entity.getNumber('wait', 0) === 0 ? value : entity.getNumber('wait', 0);
}

/** `scheduleRemove` 的语义别名：trigger_once / PUSH_ONCE 用 0.1s 延迟删除。 */
export function removeSoon(entity: Entity): void {
  scheduleRemove(entity, 0.1);
}

/** `FIELD_STRING` 输入在类定义里高频出现，导出别名减少样板。 */
export const STR = FIELD_STRING;
