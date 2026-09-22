//! mosaic v4 纹理字节码：把纹理压成一段可内嵌的文本字节码，再从字节码还原低清图。
//!
//! 上游：GLB 导出流程复用 VMT → basetexture → VTF → image 解析链，对每张纹理调用
//! `encode::img_to_code` 产出字节码；整图批量生成见 `manifest`。
//! 下游：`apps/debug` 与 `apps/game` 的 wasm 层把它导出成 JS 函数
//! （`mosaic_encode` / `mosaic_decode` / `decompress_mtz`），前端切画质时用
//! `decode::code_to_img` 还原低清图，**不重新加载地图**；`bsp_to_gltf_core::materials`
//! 也在导出期直接调用 `code_to_img`。
//!
//! 子模块分工：
//! - `encode`：PNG 字节 → mosaic 字节码（`img_to_code`）
//! - `decode`：mosaic 字节码 → 低清图字节（`code_to_img`，带 `scale` 参数）
//! - `manifest`：整图 manifest 的生成与缺失纹理收集
//! - `mtz`：MTZ 容器（magic `MTZ6`，兼容读 `MTZ5`），内含哈夫曼与 LZ 两段压缩
//!
//! 使用范围：只被 `apps/debug` 与 `apps/game` 依赖；`apps/viewer` 的 wasm crate
//! 不引用本模块（其 `Cargo.toml` 明确排除 mosaic 与默认纹理包）。
//!
//! 边界：只处理字节码与容器格式。不做 BSP 解析、不碰网络；纹理来源由调用方给出。
//!
//! 测试归属：`mtz.rs` 内联 6 个 `#[test]`；`encode.rs` / `decode.rs` / `manifest.rs` 无。

pub mod decode;
pub mod encode;
pub mod manifest;
pub mod mtz;
