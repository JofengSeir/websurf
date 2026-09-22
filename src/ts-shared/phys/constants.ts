/**
 * 物理标定常量的 TS 侧单点。
 *
 * **跨语言一致性**：本文件是这类常量在 TS 侧的唯一出处，数值必须与 Rust 权威定义逐位
 * 相等——`src/phys/player.rs` 的 `pub const EYE_STAND: f64 = 64.09`（Rust 侧
 * `eye_height()` 以它为缩放基准）。跨语言无法共享符号，只能靠数值约定；
 * 一致性由 `src/scripts/check-shared-sync.mjs` 的 `eye-stand` 子检查强制：它分别用
 * 正则抓取 Rust 与 TS 两侧的常量值再逐位比较，任一侧缺失或不等都判失败。
 *
 * **不要**为了消除这处重复而把 Rust 常量改成 TS 可注入的参数：Rust 侧是编译期
 * `pub const`，改成运行时参数会同时改动物理层接口与 wasm 导出面。
 *
 * 消费方（都通过 import 取值，没有字面量副本）：
 * - `src/ts-shared/decoupled/decoupled-loop.ts`、`src/ts-shared/tick/tick-consumer.ts`
 *   用作首帧/慢字段兜底
 * - `src/ts-shared/auth/shared-state.protocol.test.ts` 用作协议断言基准
 * - `apps/game/src/renderer/renderer-main.ts` 用作 eyeHeight 兜底
 * - `apps/viewer/src/core/constants.ts` 再导出，供该工程的 `pose.ts` / `fly.ts` 使用
 * - `apps/game/scripts/phys-smoke.mjs` **直接正则解析本文件源码**取常量值做容差断言
 *
 * 形状约束：上面最后一条意味着本文件的导出行写法（`export const EYE_STAND = <数字>;`）
 * 是被脚本依赖的接口，改写法会让该脚本解析失败。
 */

/** 固定站立眼高（HU）。`pos` 为脚底，相机 y = `pos.y + EYE_STAND`。 */
export const EYE_STAND = 64.09;
