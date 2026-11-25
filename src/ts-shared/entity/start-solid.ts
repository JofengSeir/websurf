/**
 * brush 实体「出生时是否实心」的共享判定（Rust ↔ TS 单源契约）。
 *
 * 唯一真源是 `src/wasm-core/render_bundle.rs` 的 `eval_entity_start_solid`：物理世界建好后，
 * 初始关的 brush 碰撞体不参与查询（`start_solid=false`）。TS 侧三个消费点
 * （EntityGameplay 初态隐藏、debug 的 brush-visibility 插件、FuncBrushClass.spawn）过去各写
 * 一份解析，已经出现三处漂移：
 *
 *   - `entity-gameplay.ts` 用 `startsWith('func_door')` 漏了 `func_water_analog`，且 `parseFloat`
 *     会把 `"1abc"` 截成 1（Rust 整体解析失败当 0）；
 *   - `brush-visibility.ts` 对 `func_wall_toggle` 也吃 `startdisabled`（Rust 只看 bit0）；
 *   - `FuncBrushClass.spawn` 用 keyfield 数字 `startdisabled`，同样让 `func_wall_toggle` 多吃。
 *
 * 本模块把解析收成一份逐字镜像：KV 文本 `trim()` 后必须**整体**是 i64，否则当 0；bit 判定
 * 在 BigInt 上做，避免 `spawnflags` 超过 2^32 时 JS 位运算截断。
 *
 * 契约夹具是 `start-solid-cases.json`：Rust `#[cfg(test)]`（`include_str!`）与
 * `src/scripts/check-entity-start-solid.mjs` 读同一份文件，任一侧漂移都会红。
 *
 * 夹具扫描结论（2026-11-25，test/maps 全部 12 张图）：
 *   - `func_water_analog`：0 个；
 *   - `func_wall_toggle`：6 个（spawnflags=0 ×5、=1 ×1），`startdisabled` 全为 0；
 *   - `func_brush`：12 个（spawnflags=2、startdisabled=0）；
 *   - `func_door`：39 个（spawnpos=1 有 8 个；spawnflags 含 4/12/4096/4100）；
 *   - `func_door_rotating`：7 个（spawnpos=0）。
 * 即上面两处漂移在现有夹具上零命中：本模块对齐 Rust 规则**不改变任何现有地图的行为**。
 */

/** Rust `entity_start_solid` 读取的三条 KV 原文；缺省 / `undefined` 等价于 Rust 的 `None`。 */
export interface StartSolidKv {
  spawnflags?: string;
  startdisabled?: string;
  spawnpos?: string;
}

/** 适配器需要的最小实体面（`Entity` 满足它；不 import 实体类，避免环）。 */
export interface StartSolidEntityLike {
  classname: string;
  spawnflags?: number;
  getRaw(key: string): string | undefined;
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/**
 * 按 Rust `raw.trim().parse::<i64>().ok().unwrap_or(0)` 的口径解析 KV。
 *
 * `"abc"` / `"1abc"` / 空串都当 0；`" 5 "` 合法（trim 后 5）；超出 i64 范围也当 0
 * （Rust `parse` 失败，JS 的 `parseInt` 会给出一个不精确的大数，这里必须显式挡掉）。
 */
function parseI64(raw: string | undefined): bigint {
  if (raw === undefined) return 0n;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return 0n;
  let value: bigint;
  try {
    value = BigInt(trimmed);
  } catch {
    return 0n;
  }
  return value < I64_MIN || value > I64_MAX ? 0n : value;
}

/**
 * 纯核心：brush 实体出生时是否实心（`true` = 实心）。逐字镜像 Rust
 * `eval_entity_start_solid`：
 *
 * - `func_wall_toggle`：`spawnflags & 1 == 0`（bit0 = START_OFF；**不看** StartDisabled）；
 * - `func_brush`：`StartDisabled == 0`（不看 spawnflags）；
 * - `func_door` | `func_door_rotating` | `func_water_analog`：
 *   `spawnpos == 0 && spawnflags & 512 == 0`（512 = START_OPEN_OBSOLETE）；
 * - 其余（含未知类 / `func_movelinear` / `func_rotating`）：恒实心。
 */
export function entityStartSolidRaw(classname: string, kv: StartSolidKv): boolean {
  const flags = parseI64(kv.spawnflags);
  switch (classname) {
    case 'func_wall_toggle':
      return (flags & 1n) === 0n;
    case 'func_brush':
      return parseI64(kv.startdisabled) === 0n;
    case 'func_door':
    case 'func_door_rotating':
    case 'func_water_analog':
      return parseI64(kv.spawnpos) === 0n && (flags & 512n) === 0n;
    default:
      return true;
  }
}

/**
 * 适配器：实体对象是否**出生即非实心**（`true` = 初始关 / 隐藏）。
 *
 * 优先读地图 KV 原文（`getRaw`），只有缺 `spawnflags` 原文时才退回解析后的
 * `entity.spawnflags`——`keyValue` 里的 `atoi` 会截断 `"1abc"`，不能作为主口径。
 */
export function entityStartsNonSolid(entity: StartSolidEntityLike): boolean {
  return !entityStartSolidRaw(entity.classname, {
    spawnflags: entity.getRaw('spawnflags') ?? String(entity.spawnflags ?? 0),
    startdisabled: entity.getRaw('startdisabled'),
    spawnpos: entity.getRaw('spawnpos'),
  });
}
