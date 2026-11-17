/**
 * 地图 `servercommand` → 物理参数的映射（Source convar 语义）。
 *
 * 背景：地图用 `logic_auto → point_servercommand Command "..."` 设玩服参数。
 * surf_666 的 logic_auto 就设了 `sv_airaccelerate 150`、`sv_enablebunnyhopping 1`、
 * `mp_freezetime 0`、`sv_maxvelocity 10000`；surf_hades2 设了 `sv_airaccelerate 150`。
 *
 * 分工：
 * - `sv_maxvelocity` 不走本表：它要钳「水平速度模长」，由 `EntityGameplay` 单独处理
 *   （`set_max_horizontal_speed`，语义与 `set_params` 的普通参数不同）。
 * - 其余 convar 在这里翻成**物理面板参数名**（与 `param-names.ts` 的 `PANEL_TO_RUST`
 *   同源），宿主再写物理实例，并让面板显示来源「地图」。
 *
 * 只映射「确实影响物理、且我们有对应参数」的 convar；没映射到的（如 `mp_freezetime`）
 * 静默忽略 —— 它们是服务器规则，不是物理参数。
 */
export interface MapPhysicsParam {
  /** 物理面板参数名（`PARAM_DEFS` 的 name，如 `airAccelerate`/`bhopSpeedClamp`）。 */
  name: string;
  value: number | boolean;
}

/** 数值型 convar → 物理面板参数名。 */
const CVAR_TO_PANEL: Record<string, string> = {
  sv_maxspeed: 'maxSpeed',
  sv_accelerate: 'accelerate',
  sv_airaccelerate: 'airAccelerate',
  sv_friction: 'friction',
  sv_stopspeed: 'stopSpeed',
  sv_gravity: 'gravity',
};

const CVAR_VALUE = /^\s*([A-Za-z_][\w]*)\s+(-?\d+(?:\.\d+)?)\s*$/;

/**
 * 把一条 `Command` 载荷解析成物理参数列表。
 *
 * 支持一条消息里多条命令（Source 的 servercommand 用 `;` 分隔；地图实体里也常写成
 * 换行分隔），例如 `"sv_airaccelerate 150;sv_enablebunnyhopping 1"`。
 *
 * `sv_enablebunnyhopping` 是布尔语义（1 = 允许连跳不限速）：映射为
 * `bhopSpeedClamp = (value === 0)` —— 这是引擎里与它等价的开关（面板「连跳限速」）。
 */
export function mapCvarsToPhysicsParams(command: string): MapPhysicsParam[] {
  const out: MapPhysicsParam[] = [];
  for (const raw of command.split(/[;\n]/)) {
    const m = CVAR_VALUE.exec(raw);
    if (!m) continue;
    const cvar = m[1].toLowerCase();
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    if (cvar === 'sv_enablebunnyhopping') {
      out.push({ name: 'bhopSpeedClamp', value: value === 0 });
      continue;
    }
    const panel = CVAR_TO_PANEL[cvar];
    if (panel) out.push({ name: panel, value });
  }
  return out;
}
