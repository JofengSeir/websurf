//! 棋盘马赛克纹理字节码（mosaic v4 DSL）—— 纹理压缩为字节 / 从字节还原低清纹理。
//!
//! 提取自 `materials-mini`（img2code.rs / code2img.rs），格式与 materials-test 的
//! v4 DSL 兼容。共享给 debug/ 与 game/：GLB 导出时生成 manifest（纹理名 → 字节码），
//! 前端画质切换时用 [`decode::code_to_img`] 还原低清贴图，不重新加载地图。

pub mod decode;
pub mod encode;
pub mod manifest;
pub mod mtz;
