//! BSP 到 GLTF 格式的转换库（迁移自 bsp-to-gltf-core 模块并入，核心版）。
//!
//! 将 Valve BSP 文件转换为 GLTF 格式，专注导出地图结构本身
//! （几何结构与材质），不包含地图内置模型。
//! 保留库 API 结构（WASM 仅用部分路径）。
#![allow(dead_code)]

mod convert;
mod gltf_builder;
pub mod lightmap;
pub(crate) mod materials;

// 缺失纹理回退的表键与查表入口：供导出层（`crates/wasm`）对 PAKFILE 模型材质复用同一口径
// （`materials` 模块保持 crate 私有，只门面式再导出这两项）。
pub use materials::{fallback_key, fallback_texture_png};

use thiserror::Error;
use ahash::RandomState;
use serde::Deserialize;
use std::hash::{BuildHasher, Hash, Hasher};

/// 导出 BSP 文件为 GLTF 格式
pub use convert::{export_bsp, export_bsp_with_models};
/// 阶段 2：lightmap 图集与导出契约
pub use lightmap::{
    build_atlas, check_face_luxel_size, inject_lightmap_json, lightmap_faces, lightmap_uv,
    LightmapAtlas, LightmapRect,
};

/// 资源类型
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceType {
    /// 材质
    Material,
    /// 纹理
    Texture,
    /// 其他资源
    Other,
}

/// 资源来源
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceSource {
    /// 游戏目录
    GameDirectory,
    /// BSP文件内
    BspFile,
    /// 未知来源
    Unknown,
}

/// 缺失资源信息
#[derive(Debug, Clone)]
pub struct MissingResource {
    /// 资源类型
    pub r#type: ResourceType,
    /// 资源名称或路径
    pub name: String,
    /// 缺失原因
    pub reason: String,
    /// 可能的来源
    pub possible_source: ResourceSource,
}

/// 导出结果，包含生成的GLB文件、缺失资源清单和收集的纹理信息
#[derive(Debug)]
pub struct ExportResult {
    /// 生成的GLB文件
    pub glb: gltf::Glb<'static>,
    /// 缺失资源清单
    pub missing_resources: Vec<MissingResource>,
    /// 收集的纹理信息
    pub textures: Vec<String>,
}

/// 转换选项
#[derive(Debug, Deserialize, Clone)]
pub struct ConvertOptions {
    /// 是否启用纹理
    #[serde(default = "default_enable")]
    pub textures: bool,
    /// 纹理缩放比例
    #[serde(default = "default_scale")]
    pub texture_scale: f32,
    /// 是否生成缺失资源清单
    #[serde(default = "default_enable_missing_list")]
    pub generate_missing_list: bool,
    /// 缺失纹理回退（GLB 导出期直接嵌入，渲染端零后期处理）：
    /// `{ "materials/<材质路径小写>": "#mosaic v4 字节码" }`（默认纹理包）。
    /// 材质加载失败（BSP 内无 VMT/VTF）时查表 → 解码低清纹理嵌入 GLB。
    #[serde(default)]
    pub missing_fallback: std::collections::HashMap<String, String>,
    /// pakfile 内 VMT 的**基名索引**：`基名小写` → `materials/` 前缀去扩展名的材质路径。
    ///
    /// 由导出入口用 `collect_pakfile_models` 的 `entry_names` 构建（`ConvertOptions::default()`
    /// 下为空 ⇒ 不启用基名回退）。存在理由：世界面的贴图名来自 BSP texinfo（如
    /// `METAL/METALGRATE013A2`），精确路径 `materials/metal/metalgrate013a2.vmt` 不在 pakfile 内时，
    /// 作者**同一基名**的 VMT（`materials/666/metalgrate013a2.vmt`）仍携带权威的 `$basetexture`
    /// 与 `$translucent`/`$alphatest` 声明 —— 实测 surf_666 有 14 种世界贴图（8400 面）属于此列。
    #[serde(default)]
    pub vmt_stem_index: std::collections::HashMap<String, String>,
    /// 单页图集面积上界（px）的**显式覆盖**（默认 0 = 用政策上界 4096×2048 = 8,388,608）。
    ///
    /// 存在理由（契约 `documents/game/implementation/console-fix-contract.md` §4.3）：政策上界下，
    /// 「装不下」这条失败路径对任何**真实** BSP 都不可能触发 —— 容量守卫与单面 256 上界共同保证
    /// `packedArea ≤ (257/256)² × cap/4 < 8,388,608`（surf_666：≤ 7,318,032 px）。而 fail-visible
    /// 分支**不得删除**、必须能用**仍会失败的输入**触发。该字段只改**判定阈值**，
    /// 不改打包/落位/UV/像素口径，也不降采样、不截断。
    #[serde(default)]
    pub lightmap_max_atlas_area: u64,
}

impl ConvertOptions {
    /// 计算选项的哈希值，用于缓存
    pub fn key(&self) -> u64 {
        let mut hasher = RandomState::with_seeds(1, 2, 3, 4).build_hasher();
        self.textures.hash(&mut hasher);
        self.texture_scale.to_le_bytes().hash(&mut hasher);
        self.generate_missing_list.hash(&mut hasher);
        hasher.finish()
    }
}

impl Default for ConvertOptions {
    fn default() -> Self {
        ConvertOptions {
            textures: true,
            texture_scale: 1.0,
            generate_missing_list: true,
            missing_fallback: std::collections::HashMap::new(),
            vmt_stem_index: std::collections::HashMap::new(),
            lightmap_max_atlas_area: 0,
        }
    }
}

/// 默认启用选项
fn default_enable() -> bool {
    true
}

/// 默认缩放比例
fn default_scale() -> f32 {
    1.0
}

/// 默认启用缺失资源清单生成
fn default_enable_missing_list() -> bool {
    true
}


// ── 错误类型（并入自 error.rs）─────────────────────────────
/// 错误类型
#[derive(Error, Debug, miette::Diagnostic)]
pub enum Error {
    /// 资源未找到
    #[error("资源未找到: {0}")]
    ResourceNotFound(String),
    /// 其他错误
    #[error("{0}")]
    Other(String),
    /// IO 错误
    #[error("IO 错误: {0}")]
    IoError(#[from] std::io::Error),
    /// UTF-8 错误
    #[error("UTF-8 错误: {0}")]
    Utf8Error(#[from] std::string::FromUtf8Error),
    /// VTF 错误
    #[error("VTF 错误: {0}")]
    VtfError(#[from] vtf::Error),
    /// VDF 错误
    #[error("VDF 错误: {0}")]
    VdfError(#[from] vmt_parser::VdfError),
    /// GLTF JSON 错误
    #[error("GLTF JSON 错误: {0}")]
    GltfJsonError(#[from] gltf_json::Error),
    /// 模型集成错误
    #[error("模型集成错误: {0}")]
    ModelIntegratorError(#[from] crate::model_integrator::ModelIntegratorError),
}
