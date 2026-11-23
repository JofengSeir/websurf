/**
 * 增强插件（可选能力）的开关定义与持久化。
 *
 * 为什么单独一份、不进 `RuntimeConfig`：
 * `src/scripts/check-config-sync-contract.mjs` 用静态契约锁定 debug/game 的配置分段
 * （debug 启动 5 段 / 载图 7 段、game 4 段）。往 `RuntimeConfig` 里加一段，就要同时改
 * 门禁和三端契约；而这些「引擎当前缺失、但部分 Source 地图依赖」的语义属于可选增强，
 * 默认全关、随时可卸，不该进入配置主链、也不该下发 Worker。因此开关只走这里：
 *   - 面板复选框（debug 端「增强插件（实验）」区）；
 *   - UI 偏好落盘（`localStorage[ENHANCE_STORAGE_KEY]`）；
 *   - URL 临时开启（`?enhance=runtime-teleport`，调试/回归用，不落盘）。
 *
 * 本文件不依赖 three / DOM 类型之外的任何东西，纯函数便于单测与复用。
 */

/** 一个增强项的静态定义（id 参与 URL/存储，改名等于破坏兼容）。 */
export interface EnhanceFlagDef {
  readonly id: string;
  /** 面板显示名。 */
  readonly label: string;
  /** 一句话说明「补的是什么缺口、默认关意味着什么」。 */
  readonly summary: string;
}

/**
 * 已登记的增强项。
 *
 * 注意：这里只登记**已经实现、验证过**的项；审计报告里待做的（GLB 可寻址、prop
 * rendermode、brush origin 等）在实现并通过验证前不要提前加进来——面板上出现一个
 * 勾了没反应的开关，比没有更糟。
 */
export const ENHANCE_FLAGS: readonly EnhanceFlagDef[] = [
  {
    id: 'runtime-teleport',
    label: '运行时传送',
    summary:
      '补「StartDisabled=1 的传送触发器在运行期被 Enable 后不生效」的缺口：' +
      '由 TS 实体层判定接触并经主线程物理 + Worker 权威同步施加传送；' +
      'Rust 静态传送链保持原样，同一目标只施加一次、不重复传送。',
  },
  {
    id: 'brush-visibility',
    label: '动态 brush 可见性',
    summary:
      '补「brush 实体被脚本 Enable/Disable/Toggle 后在渲染上不消失/不恢复」的缺口：' +
      '消费实体层的 brush 开关事件，按合并几何的来源表把该实体自己的三角形区间退化为零面积' +
      '（索引几何改 index 缓冲；非索引几何把区间内顶点位置塌到同一点，不改几何结构）；' +
      '只动目标实体的区间，不改 draw call，恢复时逐字节写回原值，默认关。',
  },
  {
    id: 'prop-appearance',
    label: 'prop 外观层级',
    summary:
      '补「prop_dynamic* 的 rendermode / renderamt / renderfx / parentname / skin 在 GLB 里丢失」的缺口：' +
      '导出时把这些外观字段写进道具节点 extras，插件装载期按字段应用（rendermode 10 / EF_NODRAW 隐藏、' +
      '透明类 rendermode 调材质透明度、parentname 记父子关系供诊断）；skin 变色需要 GLB 带出多套材质，' +
      '本插件只报告不可切换。只动被标注的道具节点，默认关。',
  },
  {
    id: 'fade-screen',
    label: '运行时屏幕渐变',
    summary:
      '补「env_fade 触发后屏幕没有淡入淡出」的缺口：消费实体层的 env_fade 事件（现在带 rendercolor/' +
      'renderamt/duration/hold/flags），用一张 pointer-events:none 的全屏 DOM 覆盖层按 Source 时间轴近似呈现；' +
      'FFADE_IN 从颜色淡回游戏、FFADE_OUT 淡到颜色后保持 hold、STAYOUT 保持不淡出。' +
      '默认关：插件不装载、不建覆盖层、无 rAF 循环。',
  },
  {
    id: 'damage-health',
    label: '运行时伤害/生命',
    summary:
      '补「trigger_hurt 只在实体层判定伤害、玩家没有生命值模型」的缺口：消费 entity:damage 事件，' +
      '维护 HP/护甲并把受伤结果写到面板状态行；HP 归零时按 Source 语义传回本图出生点并重置。' +
      '默认关：不装载插件时不消费任何事件，也不影响现有物理/渲染链路。',
  },
];

/** localStorage 键：值为 JSON 字符串数组（已启用的 id）。 */
export const ENHANCE_STORAGE_KEY = 'vbsp:enhance';

/** URL 查询参数名：`?enhance=runtime-teleport` 或 `?enhance=runtime-teleport,other`。 */
export const ENHANCE_URL_PARAM = 'enhance';

const KNOWN_ENHANCE_IDS: ReadonlySet<string> = new Set(ENHANCE_FLAGS.map((flag) => flag.id));

/** 该 id 是否是已登记的增强项（未知 id 一律忽略，避免旧链接/旧偏好把面板弄脏）。 */
export function isKnownEnhanceId(id: string): boolean {
  return KNOWN_ENHANCE_IDS.has(id);
}

/** 按 id 取静态定义（诊断/状态显示用）。 */
export function enhanceFlagDef(id: string): EnhanceFlagDef | undefined {
  return ENHANCE_FLAGS.find((flag) => flag.id === id);
}

/**
 * 解析 URL 查询串里的 `enhance` 参数。
 * 接受带 `?` 或不带 `?` 的串（`location.search` / 手写测试两用），未知 id 忽略。
 */
export function parseEnhanceQuery(search: string): string[] {
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (!query) return [];
  const params = new URLSearchParams(query);
  const raw = params.get(ENHANCE_URL_PARAM);
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    // 大小写不敏感（手写 URL/自动化拼参数时大小写不一致很常见），id 本身一律小写。
    const id = part.trim().toLowerCase();
    if (id && isKnownEnhanceId(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 读出「当前启用」的增强项：localStorage 持久值 ∪ URL 临时值。
 * 存储损坏（非 JSON / 非数组）时按空处理并返回，不抛错。
 */
export function readEnabledEnhanceIds(
  storage: Pick<Storage, 'getItem'> | null,
  search = '',
): string[] {
  const ids: string[] = [];
  const push = (id: string): void => {
    if (isKnownEnhanceId(id) && !ids.includes(id)) ids.push(id);
  };
  try {
    const raw = storage?.getItem(ENHANCE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) for (const value of parsed) if (typeof value === 'string') push(value);
    }
  } catch {
    /* localStorage 被禁用（隐私模式）/ 值损坏：按「没有启用项」处理 */
  }
  for (const id of parseEnhanceQuery(search)) push(id);
  return ids;
}

/** 把启用集合写回 localStorage（空集合时删除键，不留下 `[]` 噪音）。 */
export function writeEnabledEnhanceIds(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null,
  ids: readonly string[],
): void {
  if (!storage) return;
  const known = ids.filter((id) => isKnownEnhanceId(id));
  try {
    if (known.length === 0) storage.removeItem(ENHANCE_STORAGE_KEY);
    else storage.setItem(ENHANCE_STORAGE_KEY, JSON.stringify(known));
  } catch {
    /* 隐私模式：只在本次会话内生效 */
  }
}
