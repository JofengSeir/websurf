//! feature `phys`：物理导出（debug/game 使用）。
//!
//! `PhysWorld` 的 `#[wasm_bindgen]` 实现仍在共享物理层 `src/phys/mod.rs`
//! （`crate websurf-phys`，41 个 `physworld_*` wasm 导出）；本 crate 只把它再导出一层，
//! 让三端包装 crate 走同一条 `pub use websurf_wasm_bindings::*;`（后续切片把 BSP 导出也
//! 收进来后，包装 crate 才会变真正的 3-10 行薄包装）。
//!
//! viewer 不开本 feature（其 wasm crate 不依赖 `websurf-phys`）。
pub use websurf_phys::phys::PhysWorld;
