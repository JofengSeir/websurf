/**
 * 本工程的 WASM 类型入口：把 wasm-pack 生成到 `apps/game/pkg/` 的实体声明整体转出。
 *
 * `apps/game/pkg/websurf_wasm.d.ts` 由 `apps/game/crates/wasm` 经 `apps/game/package.json`
 * 的 `build:wasm` 脚本生成（wasm-pack，`--target web`），与 wasm 实现同源，故此处不重写成员声明。
 *
 * 与 `apps/debug/src/wasm.d.ts` 的分工不同：那一份用 `declare module` 通配声明匹配任意前缀下的
 * pkg 入口，逐成员手写，供产物缺失时让 tsc 解析；本文件只是一条 `export * from` 转出，
 * 行数与声明面都远小于它。
 *
 * 生效方式：`apps/game/tsconfig.json` 的 `include` 显式列出 `apps/game/src/wasm.d.ts`。工程内三个
 * 导入方（`apps/game/src/app.ts`、`apps/game/src/worker/main.ts`、
 * `apps/game/src/renderer/renderer-main.ts`）都直接写 pkg 路径，不经过本文件。
 */

export * from '../pkg/websurf_wasm.js';
