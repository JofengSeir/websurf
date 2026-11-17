//! debug 工程的 WASM 包装层（P4 切片 2）：导出实现已下沉到共享
//! `websurf-wasm-bindings`（feature：core / phys / glb / debug-tools）。
//!
//! 本文件只做 re-export；pkg basename 仍由本 crate 包名 `websurf-wasm` 决定（不变）。
//! 实现与分组见 `src/wasm-bindings/src/bsp/`（由三端原绑定层搬迁而来，此即唯一实现源）。

pub use websurf_wasm_bindings::*;
