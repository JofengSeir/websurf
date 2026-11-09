/**
 * 实体类实现的公共辅助（对应 SDK 的 `gEntList.FindEntityByName`、`CBaseFilter::PassesFilter`、
 * `UTIL_Remove`、常见的 Enable/Disable/Toggle 输入样板）。
 *
 * 这里刻意不写任何「地图专有」逻辑：所有助手都是引擎原语，类实现只做声明与组合。
 */
import { g_Runtime } from '../runtime.js';
import type { Entity, InputDef } from '../base-entity.js';
import { OutputTyped } from '../entity-io.js';
import { FIELD_VOID } from '../variant.js';
import type { FieldType } from '../variant.js';
import type { InputData } from '../types.js';

/** `gEntList.FindEntityByName(NULL, name, ...)` —— 第一个同名实体。 */
export function findByName(name: string): Entity | null {
  if (!name) return null;
  const list = g_Runtime.entList;
  if (!list) return null;
  return list.findEntityByName(null, name, null, null, null);
}

/** 遍历全部同名匹配（ServiceEvents 的语义）。 */
export function findAllByName(name: string): Entity[] {
  const out: Entity[] = [];
  const list = g_Runtime.entList;
  if (!list || !name) return out;
  let cur: Entity | null = null;
  for (;;) {
    cur = list.findEntityByName(cur, name, null, null, null);
    if (!cur) break;
    out.push(cur);
  }
  return out;
}

/** `gEntList.FindEntityByClassname` 的全部匹配。 */
export function findAllByClassname(name: string): Entity[] {
  const out: Entity[] = [];
  const list = g_Runtime.entList;
  if (!list || !name) return out;
  let cur: Entity | null = null;
  for (;;) {
    cur = list.findEntityByClassname(cur, name);
    if (!cur) break;
    out.push(cur);
  }
  return out;
}

/** `CBaseFilter::PassesFilterImpl` 的函数形态，由各 filter 类在 spawn/activate 时注入。 */
export type FilterImpl = (caller: Entity | null, tested: Entity) => boolean;
const FILTER_IMPL_KEY = '__filterImpl';
const NEGATED_KEY = 'negated';

export function setFilterImpl(entity: Entity, impl: FilterImpl): void {
  entity.set(FILTER_IMPL_KEY, impl);
}

/**
 * `CBaseFilter::PassesFilter`（filters.cpp:33-40）：
 * `PassesFilterImpl` 的结果在最外层按 `Negated` 取反。
 */
export function passesFilter(filter: Entity | null, caller: Entity | null, tested: Entity): boolean {
  if (!filter) return true;
  const impl = filter.get<FilterImpl>(FILTER_IMPL_KEY);
  const baseResult = impl ? impl(caller, tested) : true;
  return filter.getBool(NEGATED_KEY, false) ? !baseResult : baseResult;
}

export function isNegated(filter: Entity): boolean {
  return filter.getBool(NEGATED_KEY, false);
}

/** `UTIL_Remove` 的延迟版（SDK 多处避免在 touch 回调里直接删自己）。 */
export function scheduleRemove(entity: Entity, delay = 0.1): void {
  entity.setThink(() => entity.remove(), delay);
}

/** 常用三件套：Enable / Disable / Toggle；`onChange` 是类自己的状态切换。 */
export function enableDisableInputs(onChange: (e: Entity, enabled: boolean) => void, withToggle = true): InputDef[] {
  const defs: InputDef[] = [
    { name: 'Enable', type: FIELD_VOID, handler: (e) => onChange(e, true) },
    { name: 'Disable', type: FIELD_VOID, handler: (e) => onChange(e, false) },
  ];
  if (withToggle) {
    defs.push({
      name: 'Toggle',
      type: FIELD_VOID,
      handler: (e) => onChange(e, !e.getBool('enabled', true)),
    });
  }
  return defs;
}

/** 把一个简单输入声明压缩成一行。 */
export function input(name: string, type: FieldType, handler: (e: Entity, d: InputData) => void): InputDef {
  return { name, type, handler };
}

/** 触发一个无参输出的简写（caller = 实体自身，与 SDK 绝大多数调用点一致）。 */
export function fire(entity: Entity, outputName: string, activator: Entity | null = null): void {
  entity.fire(outputName, activator, entity);
}

/** 触发一个带值输出的简写（`CEntityOutputTemplate::Set`）。 */
export function fireValue(
  entity: Entity,
  outputName: string,
  value: unknown,
  activator: Entity | null = null,
): void {
  const out = entity.output(outputName);
  if (out instanceof OutputTyped) out.set(value, activator, entity);
  else entity.fire(outputName, activator, entity);
}

/** 取 `filtername` 指向的 filter 实体（在 `Activate` 阶段解析，与 triggers.cpp:240-249 一致）。 */
export function resolveFilter(entity: Entity): Entity | null {
  const name = entity.getString('filtername', '') || entity.getRaw('filtername') || '';
  return name ? findByName(name) : null;
}

/** 供类实现读宿主（不暴露给外部）。 */
export function hostOf(entity: Entity) {
  return entity.runtime.host;
}
