/**
 * 引擎全局量。对应 SDK 里的 `g_EventQueue`（`cbase.cpp:730`）、
 * `gEntList`（`entitylist.cpp`）、`gpGlobals->curtime`、`UTIL_PlayerByIndex(1)`。
 *
 * 单独成文件是为了打断 `variant` / `entity-output` / `event-queue` / `entity-list`
 * 之间的运行时循环依赖：这里只有容器和 type-only 引用。
 */
import type { EventQueue } from './event-queue.js';
import type { EntityList } from './entity-list.js';
import type { Entity } from './base-entity.js';

export interface RuntimeGlobals {
  eventQueue: EventQueue | null;
  entList: EntityList | null;
  /** `!player` / `!picker` 的解析结果；viewer 这类无玩家端可为 null。 */
  player: Entity | null;
  /** `gpGlobals->curtime`（秒）。由 `EntitySystem.frame` 推进。 */
  time: number;
  /** `STRING` → 实体；`variant_t::Convert(FIELD_EHANDLE)` 用。 */
  resolveEntityByName: ((name: string) => Entity | null) | null;
}

export const g_Runtime: RuntimeGlobals = {
  eventQueue: null,
  entList: null,
  player: null,
  time: 0,
  resolveEntityByName: null,
};

/** 测试/重置用：把全局量恢复成未装配状态。 */
export function resetRuntime(): void {
  g_Runtime.eventQueue = null;
  g_Runtime.entList = null;
  g_Runtime.player = null;
  g_Runtime.time = 0;
  g_Runtime.resolveEntityByName = null;
}
