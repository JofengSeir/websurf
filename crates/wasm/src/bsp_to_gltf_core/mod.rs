//! BSP 到 GLTF 格式的转换库（迁移自 bsp-to-gltf-core 模块并入，核心版）。
//!
//! 将 Valve BSP 文件转换为 GLTF 格式，专注导出地图结构本身
//! （几何结构与材质），不包含地图内置模型。
//! 保留库 API 结构（WASM 仅用部分路径）。
#![allow(dead_code)]

mod convert;
mod error;
mod gltf_builder;
mod materials;

use ahash::RandomState;
use serde::Deserialize;
use std::hash::{BuildHasher, Hash, Hasher};

/// 导出 BSP 文件为 GLTF 格式
pub use convert::{export_bsp, export_bsp_with_models};

/// 错误类型
pub use error::Error;

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
