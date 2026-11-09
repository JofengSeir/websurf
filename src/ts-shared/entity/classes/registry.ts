/**
 * 实体类注册表：把 SDK 的 `LINK_ENTITY_TO_CLASS` + `BEGIN_DATADESC` 变成数据表。
 *
 * 对照 Source SDK 2013 `game/server/baseentity.cpp:2162-2205`、`datamap.h:190-215`：
 * - `AcceptInput` 遍历 `GetDataDescMap() → baseMap`，即**先派生、后基类**；
 * - `DEFINE_INPUTFUNC` / `DEFINE_OUTPUT` / `DEFINE_KEYFIELD` 就是这里的三张表。
 *
 * 新增一个 Source 实体类 = 调一次 `registerClass()`，不改任何分派代码。
 * 未注册的 classname 落到 `CBaseEntity` 通用行为（Kill / FireUser1-4 / OnUser1-4 /
 * AddOutput / Use / targetname 匹配），不会让地图逻辑断在「不认识这个类」上。
 */
import { BaseEntityClass, type EntityClass } from '../base-entity.js';

const registry = new Map<string, EntityClass>();

export function registerClass(cls: EntityClass): void {
  registry.set(cls.name.toLowerCase(), cls);
}

export function getClass(name: string): EntityClass | undefined {
  return registry.get(name.toLowerCase());
}

/** 所有已注册类名（调试面板 / 覆盖率统计）。 */
export function registeredClassnames(): string[] {
  return [...registry.keys()].sort();
}

/** 缓存链，避免每张地图上千实体重复解析。 */
const chainCache = new Map<string, EntityClass[]>();

/**
 * 展开 datamap 链：派生 → ... → 基类 → `CBaseEntity`。
 * 基类不存在时记一条日志并直接接 `CBaseEntity`（保持行为可控）。
 */
export function resolveClassChain(classname: string, log?: (msg: string) => void): EntityClass[] {
  const key = classname.toLowerCase();
  const cached = chainCache.get(key);
  if (cached) return cached;

  const chain: EntityClass[] = [];
  const seen = new Set<string>();
  let cls = registry.get(key);
  if (!cls) {
    log?.(`unknown classname: ${classname}`);
  } else {
    while (cls && !seen.has(cls.name)) {
      seen.add(cls.name);
      chain.push(cls);
      cls = cls.base ? registry.get(cls.base.toLowerCase()) : undefined;
    }
  }
  if (!seen.has(BaseEntityClass.name)) chain.push(BaseEntityClass);
  chainCache.set(key, chain);
  return chain;
}

/** 测试 / 热重载用。 */
export function clearRegistry(): void {
  registry.clear();
  chainCache.clear();
}

/** 判断一个实体是否属于某个类族（按 classname 或注册链上的类名）。 */
export function isKindOf(entity: { classChain: readonly EntityClass[] }, baseName: string): boolean {
  const lower = baseName.toLowerCase();
  return entity.classChain.some((c) => c.name.toLowerCase() === lower);
}
