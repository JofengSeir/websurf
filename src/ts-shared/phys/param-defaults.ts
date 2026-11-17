/**
 * 物理参数默认值的唯一来源（2026-11-18）。
 *
 * 为什么要集中：debug 与 game 的 Worker 入口 / 主线程预测参数过去各自写死物理默认值
 * （debug `worker/main.ts` 与 `physics/prediction-params.ts` 的 `walkSpeed: 130`、
 * `crouchSpeed: 85`、`autobhop: true`、`bhopSpeedClamp: true`），而 debug 的面板又有自己一份
 * `PARAM_DEFS` 默认值。三处字面量靠人肉同步，任一处改动都会造成「面板显示的值」与「权威
 * 物理实际生效的值」分叉——用户明确要求「面板上有的都必须可调，写死的都是错的」。
 *
 * 现在的口径：默认值只在本文件声明一次。
 * - `apps/debug/src/config.ts` 与 `apps/game/src/config.ts` 的 `DEFAULT_CONFIG.physics`
 *   从这里取值；面板默认值（`apps/debug/src/physics/param-defs.ts`）也引用这里。
 * - 两端的 Worker / 主线程预测参数只读自己的 `RuntimeConfig.physics`，不再出现数值字面量。
 * - 端与端有意为之的差异（例如 game 把 `bhopSpeedClamp` 默认设为 false，
 *   对应地图 `sv_enablebunnyhopping 1`）仍由各端 `DEFAULT_CONFIG` 显式覆盖，并就地注释。
 *
 * 不在这里的：`jumpSpeed`（各端 config 单位不同，Rust 侧统一按
 * `jump_height = jumpSpeed² / (2·gravity)` 反算，见 `src/ts-shared/phys/params.ts`）、
 * 输入层参数（`yawBindSpeed` / `noclipSpeed`，属 `config.input`）。
 */

/** 物理可调参数的默认值；键名与 debug 面板 `PARAM_DEFS` 的 `name` 对齐。 */
export const PHYSICS_PARAM_DEFAULTS = {
  /** 地速上限（HU/s）→ Rust `run_speed`。 */
  maxSpeed: 250,
  /** 走路速度（HU/s，Shift 慢走）→ Rust `walk_speed`。 */
  walkSpeed: 130,
  /** 蹲走速度（HU/s）→ Rust `crouch_speed`。 */
  crouchSpeed: 85,
  /** 空中加速上限 → Rust `air_accelerate`。 */
  airAccelerate: 150,
  /** 重力加速度（HU/s²）→ Rust `gravity`。 */
  gravity: 800,
  /** 地面加速系数 → Rust `accelerate`。 */
  accelerate: 10,
  /** 地面摩擦系数 → Rust `friction`。 */
  friction: 4,
  /** 停速阈值（HU/s）→ Rust `stop_speed`。 */
  stopSpeed: 100,
  /** 跳跃高度（HU）；Rust 侧实际收到的是由它反算的起跳速度。 */
  jumpHeight: 57,
  /** 自动连跳（按住跳跃键持续起跳）→ Rust `autobhop`。 */
  autobhop: true,
  /** 连跳速度钳制（true = 起跳水平速度不超过 1.1×地速）→ Rust `bhop_speed_clamp`。 */
  bhopSpeedClamp: true,
  /** 物理模拟频率（Hz）；JS 驱动层参数，不进 Rust。 */
  tickRate: 64,
  /** 撞到面后沿法线推开的距离（HU）→ Rust `push_out`；仅 debug 面板可调。 */
  pushOut: 0.1,
  /** 只在起点已嵌入时才推开 → Rust `push_out_only_when_solid`；仅 debug 面板可调。 */
  pushOutOnlyWhenSolid: true,
} as const;

/** 默认碰撞箱（HU）：与 `src/phys/player.rs` 的 DEFAULT_HULL_* 常量同值。 */
export const DEFAULT_HULL = {
  halfWidth: 16,
  standHeight: 72,
  duckHeight: 54,
} as const;
