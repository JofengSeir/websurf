/**
 * 物理标定常量共享单点（D-16）。
 *
 * **跨语言一致性**：本站数值必须与 Rust 权威定义逐位相等——
 * `src/phys/player.rs` 的 `pub const EYE_STAND: f64 = 64.09;`。
 * 跨语言无法共享符号，故本站是 E-06 例外中的「TS 侧单点」；
 * 一致性由 `src/scripts/check-shared-sync.mjs` 的 `eye-stand` 子检查保证。
 *
 * **禁止**为「消除重复」把 Rust 常量改成 TS 可注入参数（会改变物理层语义与
 * wasm 导出面，framework-decoupling §8.1 第 12 条明文禁止）。
 *
 * 上提来源（原 7 处 TS 字面量引用）：`apps/viewer/src/core/constants.ts`、
 * `apps/game/src/renderer/renderer-main.ts`、`src/ts-shared/decoupled/decoupled-loop.ts`、
 * `src/ts-shared/tick/tick-consumer.ts`、`src/ts-shared/auth/shared-state.protocol.test.ts`（2 处，
 * 含 1 处精确断言）、`apps/game/scripts/phys-smoke.mjs`（±0.5 容差断言）。
 */

/** 固定站立眼高（HU）。`pos` 为脚底，相机 y = `pos.y + EYE_STAND`。 */
export const EYE_STAND = 64.09;
