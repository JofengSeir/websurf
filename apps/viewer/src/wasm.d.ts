/**
 * WASM 类型入口：把 `pkg/websurf_viewer_wasm.js`（wasm-bindgen 生成，同目录另有同名 `.d.ts`）
 * 的导出整体转出，使本工程可按 `./wasm.js` 引用 wasm 侧类型。
 *
 * `pkg/` 是构建产物，被 `.gitignore` 中忽略 `pkg` 目录的规则覆盖；它由 `apps/viewer/package.json`
 * 的 `build:wasm` 生成（`wasm-pack build --release --target web --out-dir ../../pkg`）。
 *
 * 现状：本文件在 `apps/viewer/src` 内**零导入点**——`apps/viewer/src/core/bsp.ts` 直接导入
 * `../../pkg/websurf_viewer_wasm.js` 的 `BspProcessor` 与 `initSync`；本文件仅由
 * `apps/viewer/tsconfig.json` 的 `include` 收进编译程序。
 */

export * from '../pkg/websurf_viewer_wasm.js';
