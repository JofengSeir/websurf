/**
 * `CGlobalEntityList` 的 1:1 复刻（引擎侧全局实体链表 + 名字查找）。
 *
 * 对照 Source SDK 2013：
 * - `game/server/entitylist.cpp:482-505`（`FindEntityByClassname`）
 * - `game/server/entitylist.cpp:515-573`（`FindEntityProcedural`，`!xxx` 特殊名）
 * - `game/server/entitylist.cpp:583-623`（`FindEntityByName`）
 * - `game/server/baseentity.cpp:3450-3499`（`NamesMatch` / `NameMatchesComplex`）
 *
 * 必须保留：
 * - **无哈希索引**，线性扫描全局实体链表；`pStartEntity` 从它的 `m_pNext` 开始 ⇒
 *   `while(target = FindEntityByName(target, ...))` 能遍历全部同名匹配而不重复。
 * - `!` 特殊名**只有 `pStartEntity === null` 才返回一次**，防止无限循环。
 * - `NamesMatch` 大小写不敏感，且**只支持末尾 `*``**（无中间通配、无 `?`）。
 */
import { g_Runtime } from './runtime.js';
import type { Entity } from './base-entity.js';
import type { EntityLike } from './types.js';

function asciiFoldUp(c: number): number {
  return c >= 97 && c <= 122 ? c - 32 : -1;
}
function asciiFoldDown(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : -1;
}

/**
 * `NamesMatch(pszQuery, string_t nameToMatch)`（baseentity.cpp:3450-3486）。
 * `name === null` 表示 `NULL_STRING`：只匹配空 query 或 `*`。
 */
export function namesMatch(query: string, name: string | null): boolean {
  if (name === null) return query === '' || query === '*';
  let i = 0;
  while (i < name.length && i < query.length) {
    const cName = name.charCodeAt(i);
    const cQuery = query.charCodeAt(i);
    if (cName === cQuery || asciiFoldDown(cName) === cQuery || asciiFoldUp(cName) === cQuery) {
      i++;
      continue;
    }
    break;
  }
  if (i === query.length && i === name.length) return true;
  // "Perhaps support real wildcards. Right now, only thing supported is trailing *"
  return query[i] === '*';
}

export class EntityList {
  /** `CEntInfo` 链表：实体按地图加载顺序排列，不可随意排序。 */
  readonly entities: Entity[] = [];

  add(entity: Entity): void {
    this.entities.push(entity);
  }

  remove(entity: Entity): void {
    const i = this.entities.indexOf(entity);
    if (i >= 0) this.entities.splice(i, 1);
  }

  clear(): void {
    this.entities.length = 0;
  }

  get count(): number {
    return this.entities.length;
  }

  /** `FindEntityByName`（entitylist.cpp:583-623）。 */
  findEntityByName(
    startEntity: EntityLike | null,
    name: string,
    searchingEntity: EntityLike | null,
    activator: EntityLike | null,
    caller: EntityLike | null,
  ): Entity | null {
    if (!name || name.length === 0) return null;
    if (name[0] === '!') {
      return startEntity === null
        ? this.findEntityProcedural(name, searchingEntity, activator, caller)
        : null;
    }
    const from = startEntity === null ? 0 : this.entities.indexOf(startEntity as Entity) + 1;
    for (let i = from; i < this.entities.length; i++) {
      const ent = this.entities[i];
      if (!ent.targetname) continue; // 无 m_iName 的实体跳过
      if (namesMatch(name, ent.targetname)) return ent;
    }
    return null;
  }

  /** `FindEntityByClassname`（entitylist.cpp:482-505）；与按名查找同构。 */
  findEntityByClassname(startEntity: EntityLike | null, name: string): Entity | null {
    if (!name || name.length === 0) return null;
    const from = startEntity === null ? 0 : this.entities.indexOf(startEntity as Entity) + 1;
    for (let i = from; i < this.entities.length; i++) {
      const ent = this.entities[i];
      if (namesMatch(name, ent.classname)) return ent;
    }
    return null;
  }

  /** 便捷封装：按名字找第一个（相当于 `FindEntityByName(NULL, ...)`）。 */
  findFirstByName(name: string): Entity | null {
    return this.findEntityByName(null, name, null, null, null);
  }

  /** `FindEntityGeneric`（entitylist.cpp:953-963）：先名字再 classname。 */
  findEntityGeneric(startEntity: EntityLike | null, name: string): Entity | null {
    return (
      this.findEntityByName(startEntity, name, null, null, null) ??
      this.findEntityByClassname(startEntity, name)
    );
  }

  /**
   * `FindEntityProcedural`（entitylist.cpp:515-573）。
   * `FStrEq` 是 `V_stricmp`，大小写不敏感；`!self` 解析为 `pSearchingEntity`
   * （在 ServiceEvents 里被设成 caller）。
   */
  findEntityProcedural(
    name: string,
    searchingEntity: EntityLike | null,
    activator: EntityLike | null,
    caller: EntityLike | null,
  ): Entity | null {
    if (name[0] !== '!') return null;
    switch (name.slice(1).toLowerCase()) {
      case 'player':
      case 'pvsplayer':
      case 'picker':
        // 结构槽只能约束到 EntityRef；装配方放的是具体 Entity。
        return g_Runtime.player as Entity | null;
      case 'activator':
        return (activator as Entity | null) ?? null;
      case 'caller':
        return (caller as Entity | null) ?? null;
      case 'self':
        return (searchingEntity as Entity | null) ?? null;
      default:
        // SDK 里是 Warning + Assert；宿主侧静默忽略无效名。
        return null;
    }
  }
}
