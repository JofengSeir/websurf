/**
 * 物理面板参数的持久化（localStorage）。
 *
 * 为什么放在共享层：debug 与 game 各有一套物理面板，但「面板上改过的参数刷新后要还在」
 * 是同一条产品规则（owner 2026-11-18：面板上有的参数都必须可调，写死的都是错的）。
 * 两端用同一套键名与数据结构，避免出现「debug 记住、game 丢」的半套行为。
 *
 * 存储格式（JSON）：
 *   { "version": 1, "params": { "<面板参数名>": number | boolean } }
 * - 键名：`vbsp:physicsPrefs:<app>`，app 取 `debug` / `game` / `viewer`，两端互不覆盖。
 * - version 只做前进兼容：读到未知/更高 version 时按空处理（宁可回默认，也不拿错数据）。
 * - 白名单由调用方传入（debug 用 `PARAM_DEFS` 的名字，game 用自己的物理字段名），
 *   这样已删除的参数（例如 teleportGateTicks）即使残留在旧存储里也不会被读回来。
 * - localStorage 不可用（隐私模式/配额满/非浏览器环境）时静默降级为「无持久化」，
 *   绝不因为存储失败影响面板本身。
 */

/** localStorage 键前缀；完整键 = 前缀 + app。 */
export const PHYSICS_PREFS_KEY_PREFIX = 'vbsp:physicsPrefs:';

/** 当前存储结构版本。字段语义变化时 +1。 */
export const PHYSICS_PREFS_VERSION = 1;

/** 持久化允许的取值类型（与 ParamDef.value / game config 一致）。 */
export type PhysicsParamValue = number | boolean;

/** 物理参数覆盖表（内存形态，来源一律视为「手动」）。 */
export type PhysicsParamOverrides = Record<string, PhysicsParamValue>;

/** 构造某端的完整存储键。 */
export function physicsPrefsKey(app: string): string {
  return `${PHYSICS_PREFS_KEY_PREFIX}${app}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isAllowedValue(value: unknown): value is PhysicsParamValue {
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * 读取某端持久化的物理参数覆盖。
 *
 * @param app 端名（debug/game/viewer），用来拼存储键。
 * @param allowedNames 允许的参数名白名单（PARAM_DEFS / game 物理字段名）。
 * @returns 只含白名单内且类型合法的条目；无数据/损坏/版本不符时返回空对象。
 */
export function loadPhysicsParamPrefs(
  app: string,
  allowedNames: readonly string[],
): PhysicsParamOverrides {
  const store = storage();
  if (!store) return {};
  const raw = store.getItem(physicsPrefsKey(app));
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const record = parsed as { version?: unknown; params?: unknown };
  if (record.version !== PHYSICS_PREFS_VERSION) return {};
  if (!record.params || typeof record.params !== 'object') return {};
  const allowed = new Set(allowedNames);
  const out: PhysicsParamOverrides = {};
  for (const [name, value] of Object.entries(record.params as Record<string, unknown>)) {
    if (!allowed.has(name) || !isAllowedValue(value)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * 保存某端物理参数覆盖。空表等价于清除（避免留下 `{"params":{}}` 的脏键）。
 *
 * @param app 端名。
 * @param values 要保存的覆盖（通常来自 PhysicsParams.overrides 或 game 面板改动）。
 * @param allowedNames 白名单；不在名单内的条目直接丢弃。
 */
export function savePhysicsParamPrefs(
  app: string,
  values: Readonly<PhysicsParamOverrides>,
  allowedNames: readonly string[],
): void {
  const store = storage();
  if (!store) return;
  const allowed = new Set(allowedNames);
  const params: PhysicsParamOverrides = {};
  for (const [name, value] of Object.entries(values)) {
    if (!allowed.has(name) || !isAllowedValue(value)) continue;
    params[name] = value;
  }
  if (Object.keys(params).length === 0) {
    clearPhysicsParamPrefs(app);
    return;
  }
  try {
    store.setItem(
      physicsPrefsKey(app),
      JSON.stringify({ version: PHYSICS_PREFS_VERSION, params }),
    );
  } catch {
    // 配额/隐私模式：不持久化，面板照常工作。
  }
}

/** 清除某端持久化的物理参数缓存（面板「恢复默认」时调用）。 */
export function clearPhysicsParamPrefs(app: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(physicsPrefsKey(app));
  } catch {
    // 忽略：清不掉也不该影响面板。
  }
}
