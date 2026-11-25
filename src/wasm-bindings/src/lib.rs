//! WebSurf wasm-bindings：三端共享 wasm-bindgen 导出层（P4 单一 crate + features）。
//!
//! 本文件与 `bsp/` 由 task-73 slice2 从三端原绑定层搬迁而来；搬迁后即为三端共享的
//! 唯一实现源，可直接修改（feature 分组见 `Cargo.toml`）。

#[cfg(feature = "core")]
mod texture;
#[cfg(feature = "core")]
pub use texture::*;

#[cfg(feature = "core")]
mod bsp;
#[cfg(feature = "core")]
pub use bsp::*;

#[cfg(feature = "phys")]
pub mod phys;
#[cfg(feature = "phys")]
pub use phys::*;
