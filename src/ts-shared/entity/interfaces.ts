/**
 * 引擎全局量的**结构接口**（叶层：只 import 纯类型 `primitives.ts`）。
 *
 * `runtime.ts` 的 `g_Runtime` 原本直接引用 `EventQueue` / `EntityList` / `Entity`
 * 三个具体类，于是 `runtime -> event-queue -> runtime` 这类环只能靠「都是 type import」
 * 回避（运行时本来无环，类型层仍然有环）。这里把全局槽收敛成结构接口，`runtime.ts`
 * 只依赖本文件，具体类由顶层 `entity-system.ts` 装配后赋进去。
 *
 * 为什么接口里是 `EntityRef` 而不是 `EntityLike`：`EntityLike.acceptInput` 的参数是
 * `Variant`，而 `variant.ts` 依赖 `runtime.ts`；本文件若 import 它就会重新造环。
 * 查找与派发实际只需要 `targetname` / `classname`。确实需要具体成员的调用点
 * （`classes/common.ts` 的查找助手、`entity-list.ts` 的 `!player`、`event-queue.ts`
 * 的派发循环）各自做一次窄化，理由写在那里。
 */
import type { EntityRef } from './primitives.js';

/** `CGlobalEntityList` 的最小接口（`entitylist.cpp:482-623`）。 */
export interface IEntityList<E extends EntityRef = EntityRef> {
  findEntityByName(
    startEntity: E | null,
    name: string,
    searchingEntity: E | null,
    activator: E | null,
    caller: E | null,
  ): E | null;
  findEntityByClassname(startEntity: E | null, name: string): E | null;
  findFirstByName(name: string): E | null;
}

/**
 * `CEventQueue` 的最小接口（`eventqueue.h:19-79`）。
 * `value` 是调用点 clone 后透传的 `Variant`；这里不写类型以免反向依赖 `variant.ts`。
 */
export interface IEventQueue {
  addEventByName(
    target: string,
    input: string,
    value: unknown,
    fireDelay: number,
    activator: EntityRef | null,
    caller: EntityRef | null,
    outputID?: number,
  ): void;
  addEventForEntityVoid(
    target: EntityRef,
    input: string,
    fireDelay: number,
    activator: EntityRef | null,
    caller: EntityRef | null,
    outputID?: number,
  ): void;
  cancelEvents(caller: EntityRef | null): void;
}
