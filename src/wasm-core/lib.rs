//! WebSurf 共享 WASM 核心（websurf-wasm-core）。
//!
//! BSP 解析 / GLB 导出 / 模型整合 / 纹理解码 / PAKFILE 模型 / .phy 解析。
//! 统一自 debug/ 与 game/ 两工程的 crates/wasm 解析层（game 精简演进版差异已并入）。
//! 不含 wasm-bindgen 导出（由各工程 cdylib lib.rs 提供）。
//!
//! 模块说明：
//! - vbsp:            BSP 文件解析（26 lump，Leaves 排序修复，LZMA 支持）
//! - bsp_to_gltf_core: BSP → GLB 导出
//! - model_integrator: MDL 模型整合（放置/网格/材质）
//! - pakfile_models:   PAKFILE 索引、VMT 解析
//! - phyfile:          .phy 模型自带碰撞解析
//! - texture_utils:    VTF 解码

pub mod bsp_to_gltf_core;
pub mod model_integrator;
pub mod mosaic;
pub mod pakfile_models;
pub mod phyfile;
pub mod texture_utils;
pub mod vbsp;
