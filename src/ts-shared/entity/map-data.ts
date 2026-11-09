/**
 * `CEntityMapData` 视角的实体文本解析。
 *
 * 对照 Source SDK 2013：
 * - `game/server/mapentities.cpp:543/581` → `CBaseEntity::ParseMapData`
 *   （`game/shared/baseentity_shared.cpp:295-315`）
 * - `game/shared/baseentity_shared.cpp:320-328`：`KeyValue` 的 `#` 重复键截断
 * - `game/server/saverestore_gamedll.cpp:24-118`：`ParseKeyvalue` 的 `stricmp` 键匹配
 *
 * BSP 的 entities lump 是 `{ "k" "v" ... }` 块拼接的文本；引擎拿到的是已按 `\0`
 * 切好的 map data，所以引擎**不靠花括号**判断块边界。这里为了容错，解析时跟踪引号
 * 状态再找 `}`，避免 VScript 值里的 `}` 把块提前截断（Rust 侧 `Entities::iter`
 * 的朴素实现没做这一步）。
 */
export interface KeyValuePair {
  key: string;
  value: string;
}

/** Hammer 允许 `OnTrigger#1` / `OnTrigger#2` 表示重复键；引擎把 `#` 及之后整段截掉。 */
export function stripHammerDuplicateSuffix(key: string): string {
  const i = key.indexOf('#');
  return i < 0 ? key : key.slice(0, i);
}

/** 按引号成对扫描一个块内的 `"key" "value"` 序列，保留顺序与重复键。 */
export function parseKeyValuePairs(block: string): KeyValuePair[] {
  const pairs: KeyValuePair[] = [];
  let p = 0;
  for (;;) {
    const k1 = block.indexOf('"', p);
    if (k1 < 0) break;
    const k2 = block.indexOf('"', k1 + 1);
    if (k2 < 0) break;
    const v1 = block.indexOf('"', k2 + 1);
    if (v1 < 0) break;
    const v2 = block.indexOf('"', v1 + 1);
    if (v2 < 0) break;
    pairs.push({ key: block.slice(k1 + 1, k2), value: block.slice(v1 + 1, v2) });
    p = v2 + 1;
  }
  return pairs;
}

/** 从 `{` 起找与之配对的 `}`；引号内的花括号不算边界。找不到返回 -1。 */
function findBlockEnd(text: string, open: number): number {
  let quoted = false;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '}') return i;
  }
  return -1;
}

/**
 * 把 entities lump 原文切成实体块（每块一组有序 keyvalue）。
 * 与 Rust `Entities::iter()` 的实体序号一一对应（同序、同数量），
 * 因而 `EntityVolume.index` 可以直接用来索引这里的结果。
 */
export function parseEntityBlocks(text: string): KeyValuePair[][] {
  const out: KeyValuePair[][] = [];
  let cursor = 0;
  for (;;) {
    const open = text.indexOf('{', cursor);
    if (open < 0) break;
    const close = findBlockEnd(text, open);
    if (close < 0) break;
    out.push(parseKeyValuePairs(text.slice(open + 1, close)));
    cursor = close + 1;
  }
  return out;
}

/** 取首个匹配键（大小写不敏感）；SDK `RawEntity::prop` 的等价物。 */
export function firstProp(pairs: readonly KeyValuePair[], key: string): string | undefined {
  const lower = key.toLowerCase();
  for (const p of pairs) if (p.key.toLowerCase() === lower) return p.value;
  return undefined;
}

/** 解析 `"x y z"` 形式的向量；分量缺失按 0。 */
export function parseVec3(raw: string | undefined): [number, number, number] {
  if (!raw) return [0, 0, 0];
  const nums = raw.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g);
  if (!nums) return [0, 0, 0];
  return [
    nums[0] !== undefined ? Number.parseFloat(nums[0]) : 0,
    nums[1] !== undefined ? Number.parseFloat(nums[1]) : 0,
    nums[2] !== undefined ? Number.parseFloat(nums[2]) : 0,
  ];
}

/**
 * BSP Z-up `[x,y,z]` → 项目物理 Y-up `[y,z,x]`（det=+1 的正交循环置换）。
 * 与 `src/wasm-core/render_bundle.rs::io_rotate_yup`、`src/ts-shared/phys/angles.ts`
 * 的轴映射契约一致；`Entity.origin` 与 `EntityVolume` 都在这一坐标系里。
 *
 * 注意：`angles` **不做**这个置换——Source 的 `[pitch,yaw,roll]` 仍按引擎语义保存，
 * 消费端（teleport / pushdir）各自换算 yaw。
 */
export function bspVec3ToYup(v: [number, number, number]): [number, number, number] {
  return [v[1], v[2], v[0]];
}
