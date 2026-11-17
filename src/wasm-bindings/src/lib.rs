//! WebSurf 三端共享 wasm-bindgen 导出层（P4 单一 crate + features）。
//!
//! 上游：`websurf-wasm-core`（仓库根 `src/wasm-core/`，BSP/GLB/材质解析）与
//! `websurf-phys`（仓库根 `src/`，物理系统）。
//! 下游：`apps/{debug,game,viewer}/crates/wasm` 三个 cdylib 薄包装 crate —— crate 名保持
//! `websurf-wasm` / `websurf-viewer-wasm` 不变，`pkg` basename（`websurf_wasm_bg.wasm` /
//! `websurf_viewer_wasm_bg.wasm`）因此不变（`src/ts-shared/wasm/loader.ts:22-24` 约束）。
//!
//! 当前切片（task-69，可回退）：只迁移 `core` 与 `phys` 两组导出；BSP/GLB 导出面仍在
//! 三个 app 的 `lib.rs` 里（后续切片再搬）。未实现 feature 只声明不导出，避免三端 build 断。
//!
//! 不变量：
//! - 本 crate 只是 `rlib`；`#[wasm_bindgen]` 项经包装 crate `pub use` 后由 wasm-pack 收集
//!   （验证见 `.tmp/wasmspike/RESULT.md`：跨 crate 导出可行，未引用符号有 DCE 风险）；
//! - wasm-bindgen 版本必须与三端包装 crate 一致（都是 `0.2`）；
//! - 错误文本格式与迁移前逐字一致（`"<上下文>: <错误>"`），JS 侧不感知实现位置变化。

#[cfg(feature = "core")]
mod texture;
#[cfg(feature = "core")]
pub use texture::*;

#[cfg(feature = "phys")]
mod phys;
#[cfg(feature = "phys")]
pub use phys::*;
