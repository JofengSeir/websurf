//! `websurf-wasm-core` —— 三个工程共用的 BSP 解析 / GLB 导出 / 模型与纹理资源解析核心。
//!
//! **不含 wasm-bindgen 导出层**：本 crate 是 rlib，依赖表里没有 wasm-bindgen；WASM 边界上
//! 的 `BspProcessor` 等导出项由各工程的 `crates/wasm` cdylib 提供。三个工程都依赖本 crate
//! （`apps/debug/crates/wasm/Cargo.toml`、`apps/game/crates/wasm/Cargo.toml`、
//! `apps/viewer/crates/wasm/Cargo.toml`）。
//!
//! 在主流程中的位置（以 apps/game 为例）：用户选图 → 主线程 `buildWorldBundle`
//! （`src/ts-shared/phys/world-builder.ts`）依次调用所在工程的 `BspProcessor`；
//! 其中"字节 → 结构化数据 / GLB"的全部工作在本 crate 内完成，产出的 GLB 与
//! brush / tri / teleport JSON 再分别交给渲染线与物理线。
//!
//! 职责清单（与本文件 `pub mod` 声明一一对应，共 **8** 个模块）：
//! - `vbsp`：BSP 文件解析（64 个 lump 目录项、LZMA 封装、实体与 game lump）
//! - `bsp_to_gltf_core`：BSP → GLB 导出（几何、材质、lightmap atlas）
//! - `model_integrator`：MDL 模型整合（放置、网格、材质）
//! - `pakfile_models`：PAKFILE 索引与 VMT 解析
//! - `phyfile`：`.phy` 模型自带碰撞解析
//! - `texture_utils`：VTF 解码
//! - `mosaic`：mosaic v4 纹理字节码与 MTZ 容器
//! - `vhv`：prop 顶点光照（`parse_vhv` → `PropVertexLighting`）
//!
//! 关键不变量：BSP 头是 **64** 个 lump 目录项（`vbsp/data/mod.rs` 的
//! `entries: [LumpEntry; 64]`），逐模块的其余不变量见各模块文档。
//!
//! 边界：只做解析与导出。不做物理模拟，不接触 DOM / 渲染与网络；
//! 输入字节全部由调用方以切片传入。
//!
//! 测试归属：各模块内联 `#[cfg(test)]`，共 **30** 个 `#[test]`
//! （`bsp_to_gltf_core/lightmap.rs` 6、`mosaic/mtz.rs` 6、`vbsp/data/mod.rs` 6、`vhv.rs` 4、
//! `pakfile_models.rs` 3、`vbsp/data/game.rs` 2、`vbsp/mod.rs` 2、`phyfile.rs` 1）。
//! 坑：在缺少 `dlltool.exe` 的 Windows 宿主上 `cargo test -p websurf-wasm-core` 会在
//! `windows-sys` / `getrandom` 的宿主构建阶段失败；此时以
//! `cargo check -p websurf-wasm-core` 作为编译门。

pub mod bsp_to_gltf_core;
pub mod model_integrator;
pub mod mosaic;
pub mod pakfile_models;
pub mod phyfile;
pub mod texture_utils;
pub mod vbsp;
pub mod vhv;
