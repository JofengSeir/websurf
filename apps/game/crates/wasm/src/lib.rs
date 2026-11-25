//! game 工程的 WASM 包装层（P4 切片 2）：导出实现已下沉到共享
//! `websurf-wasm-bindings`（feature：core / phys / glb-lite）。
//!
//! 本文件只做 re-export；pkg basename 由 apps/game/package.json 的 `wasm-pack --out-name
//! websurf_wasm` 固定为 websurf_wasm.*（D-133 起 crate 包名改为 websurf-game-wasm，产物名不变）。
//! 实现与分组见 `src/wasm-bindings/src/bsp/`（由三端原绑定层搬迁而来，此即唯一实现源）。

pub use websurf_wasm_bindings::*;
