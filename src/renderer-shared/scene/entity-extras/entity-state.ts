/**
 * 实体初态门控的共用解析（T-N6）。
 *
 * 这里只回答「载入时这个实体该不该可见/发射」，逐类按 Source SDK 2013 核对，
 * **不能**把 spawnflags 当成通用开关：
 *
 * - `env_sprite` = `CSprite`（`game/shared/Sprite.cpp:190-227`）：
 *   `if ( GetEntityName() != NULL_STRING && !(m_spawnflags & SF_SPRITE_STARTON) ) TurnOff();`
 *   即「有 targetname 且未置 bit0」才初始隐藏；**没有 targetname 的 sprite 恒亮**，
 *   与 spawnflags 无关——把 spawnflags=0 的静态光晕判成「未点亮」是错的。
 * - `info_particle_system` = `CParticleSystem`（`game/server/particle_system.cpp:36,163-175`）：
 *   键名是小写的 `start_active`（FIELD_BOOLEAN），默认 false；为 0 载入后不发射，
 *   等 I/O `Start`。
 * - `prop_dynamic` = `CDynamicProp`（`game/server/props.cpp:1830,1927-1930`）：
 *   `StartDisabled != 0` ⇒ Spawn 末尾 `AddEffects( EF_NODRAW )`。
 * - `point_worldtext` = `CPointWorldText`（`game/server/point_worldtext.cpp:14-28`）：
 *   datadesc 里没有 StartDisabled / spawnflags / Show/Hide ⇒ 恒可见，本模块不参与。
 *
 * A/B：`__vbspEntityStateGating === false` 时所有解析都返回「初始可见/激活」，
 * 行为回到 T-N6 之前，便于在实机上把可见变化归因到本卡。
 */

/** 初态门控总开关（A/B 用）。默认开。 */
export function entityStateGatingOn(): boolean {
  return (globalThis as Record<string, unknown>).__vbspEntityStateGating !== false;
}

/**
 * 读布尔键值：KV 键大小写不敏感（BSP 里同一键有 `StartDisabled` / `startdisabled` 两种写法），
 * 值只认 Source 的 0/1 以及常见文本真值。缺键返回 `fallback`。
 */
export function readBoolKey(
  block: Record<string, string>,
  key: string,
  fallback = false,
): boolean {
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(block)) {
    if (k.toLowerCase() !== lower) continue;
    const text = v.trim().toLowerCase();
    if (text === '') return fallback;
    return text === '1' || text === 'true' || text === 'yes' || text === 'on';
  }
  return fallback;
}

/** 读整数键值（大小写不敏感）；缺键或非数字返回 `fallback`。 */
export function readIntKey(
  block: Record<string, string>,
  key: string,
  fallback = 0,
): number {
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(block)) {
    if (k.toLowerCase() !== lower) continue;
    const n = Number.parseInt(v.trim(), 10);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** `SF_SPRITE_STARTON`（`game/shared/Sprite.h:17`）。 */
export const SF_SPRITE_STARTON = 0x0001;

/**
 * `CSprite::Spawn` 的初态：**无 targetname 恒亮**；有 targetname 时只有 bit0 置位才亮。
 * `env_sprite_clientside` 共用 `CSprite`（`game/client/c_sprite.cpp`），同口径。
 */
export function spriteStartsVisible(block: Record<string, string>): boolean {
  if (!entityStateGatingOn()) return true;
  const name = (block['targetname'] ?? '').trim();
  if (name === '') return true;
  return (readIntKey(block, 'spawnflags', 0) & SF_SPRITE_STARTON) !== 0;
}

/** `CParticleSystem::Activate`：`start_active`（小写键）为真才在载入后发射。 */
export function particleStartsActive(block: Record<string, string>): boolean {
  if (!entityStateGatingOn()) return true;
  return readBoolKey(block, 'start_active', false);
}
