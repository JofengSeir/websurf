//! `bsp_to_gltf_core` —— BSP → GLB（glTF 二进制）导出的核心：世界几何、面材质、lightmap 图集。
//!
//! 核心实现并入自外部参照实现 **bsp-to-gltf-core**。
//!
//! 在主流程中的位置：
//! - 上游：三个工程的 wasm 导出层构造 [`ConvertOptions`] 后调用 [`export_bsp`] 或
//!   [`export_bsp_with_models`]，入参是已经解析好的 `Arc<Bsp>`
//!   （`apps/game/crates/wasm/src/lib.rs` 的 `export_glb_with_defaults_opts` 两个分支；
//!   debug / viewer 侧调用形制相同）。
//! - 下游：`mosaic` 反向复用本模块的 `materials::load_material_bsp` 逐材质取图
//!   （`src/wasm-core/mosaic/manifest.rs` 的 `texture_to_code`），由它自己遍历 model / face，不重新解析 BSP。
//!
//! 职责（与本文件的模块声明一一对应）：
//! - `convert`：导出主流程——遍历 model / face，产出节点、网格、图元，并组装 GLB
//! - `gltf_builder`：材质与纹理 → `gltf_json` 结构，并把 PNG 字节追加进 BIN 缓冲
//! - `lightmap`（`pub`）：lightmap 图集打包、luxel 读取与导出契约注入
//! - `materials`（`pub(crate)`）：VMT/VTF 解析与缺失贴图回退
//! - 本文件：共享选项 [`ConvertOptions`]、导出结果 [`ExportResult`]、缺失资源清单
//!   [`MissingResource`] 及其两个枚举、错误类型 [`Error`]
//!
//! 关键不变量：
//! - 门面只再导出 [`fallback_key`] 与 [`fallback_texture_png`]；`materials` 其余部分保持
//!   crate 私有。两项里只有 `fallback_texture_png` 有 crate 外调用点
//!   （`apps/game/crates/wasm/src/lib.rs` 的 `resolve_pakfile_materials`）；`fallback_key` 由它内部调用。
//! - lightmap 单页上界由 `lightmap` 的常量与 [`ConvertOptions::lightmap_max_atlas_area`]
//!   共同决定：单边上界 `MAX_ATLAS_SIDE = 4096` px、面积上界
//!   `MAX_ATLAS_PAGE_AREA = 4096 × 4096 / 2 = 8,388,608` px²（即 4096×2048）；
//!   单面 luxel 边长上界 `MAX_LUXEL_SIDE = 256`。
//! - 本模块整体 `#![allow(dead_code)]`：未接线项不会以编译告警的形式暴露，
//!   判断某项是否在用必须查调用点。
//!
//! 边界：不做 BSP 字节解析（`vbsp` 负责）、不做物理与渲染、不接触 DOM 与网络；
//! 不写文件——GLB 以 [`ExportResult::glb`] 的 `gltf::Glb<'static>` 结构返回，
//! 落盘、传输与缓存由调用方决定。
//!
//! 测试归属：本文件、`materials.rs`、`gltf_builder.rs` 均无 `#[cfg(test)]` 与 `#[test]`；
//! 本模块的内联测试全在 `lightmap.rs`（6 个 `#[test]`）。
#![allow(dead_code)]

mod convert;
mod gltf_builder;
pub mod lightmap;
pub(crate) mod materials;

// 缺失纹理回退表的键口径与查表解码入口的门面再导出（`materials` 模块保持 crate 私有）。
// 导出层实际用到的是 `fallback_texture_png`：`apps/game/crates/wasm/src/lib.rs` 的
// `resolve_pakfile_materials` 用它
// 给 PAKFILE 模型材质补 pakfile 内没有的贴图；`fallback_key` 在 crate 外无调用点，
// 只由 `fallback_texture_png` 在 `materials.rs` 内部调用。
pub use materials::{fallback_key, fallback_texture_png};

use thiserror::Error;
use ahash::RandomState;
use serde::Deserialize;
use std::hash::{BuildHasher, Hash, Hasher};

/// 导出入口：`export_bsp` 只导世界几何，`export_bsp_with_models` 再并入 MDL 模型
/// （模型放置与网格整合由 `model_integrator` 完成）。
///
/// 两者都收已解析的 `Arc<Bsp>` 与 [`ConvertOptions`]，返回组装好的 [`ExportResult`]。
pub use convert::{export_bsp, export_bsp_with_models};
/// lightmap 导出契约门面：图集构建 `build_atlas`、单面 luxel 尺寸校验
/// `check_face_luxel_size`、契约注入 `inject_lightmap_json`，
/// 以及 `LightmapAtlas` / `LightmapRect` / `lightmap_faces` / `lightmap_uv` 四个数据结构与取值入口。
pub use lightmap::{
    build_atlas, check_face_luxel_size, inject_lightmap_json, lightmap_faces, lightmap_uv,
    LightmapAtlas, LightmapRect,
};

/// 资源类型标签，用于 [`MissingResource`] 分类。
///
/// 全仓只有 `Material` 有构造点（`materials` 模块的两条失败分支）；
/// `Texture` 与 `Other` 当前无构造点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceType {
    /// 材质（VMT 加载失败）
    Material,
    /// 纹理（VTF）
    Texture,
    /// 其他资源
    Other,
}

/// 缺失资源的来源通路标签，用于 [`MissingResource::possible_source`]。
///
/// 取值由**调用通路**决定，不是逐条判定的猜测值：
/// `materials::load_material_fallback` 填 `GameDirectory`，
/// `materials::load_material_fallback_bsp` 填 `BspFile`；`Unknown` 当前无构造点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceSource {
    /// 游戏目录
    GameDirectory,
    /// BSP文件内
    BspFile,
    /// 未知来源
    Unknown,
}

/// 一条缺失资源记录，累积进 [`ExportResult::missing_resources`]。
#[derive(Debug, Clone)]
pub struct MissingResource {
    /// 资源类型；现有两处构造点恒为 `ResourceType::Material`。
    pub r#type: ResourceType,
    /// 资源名：两条 `load_material_fallback*` 通路传入的是**材质名**。
    pub name: String,
    /// 失败原因文本，由 `Debug` 格式化的底层错误拼成，形如
    /// `Failed to load material: {e:?}`，BSP 通路多一段 `from BSP` 字样。
    pub reason: String,
    /// 来源通路标签，取值见 [`ResourceSource`]。
    pub possible_source: ResourceSource,
}

/// 导出结果：组装好的 GLB、缺失资源清单、以及导出期登记过的材质名。
#[derive(Debug)]
pub struct ExportResult {
    /// 组装好的 GLB（JSON chunk + BIN chunk），未落盘。
    pub glb: gltf::Glb<'static>,
    /// 缺失资源清单；只在 `options.generate_missing_list == true` 时增长。
    pub missing_resources: Vec<MissingResource>,
    /// 导出期登记进 `materials::TextureCollector` 的材质名（小写，去重且保持首次出现顺序）。
    ///
    /// 登记发生在材质加载**之前**（`materials` 两条 `load_material_fallback*` 入口的第一条语句），
    /// 因此列表里既有加载成功的、也有加载失败的材质名；`ConvertOptions::textures == false` 时恒为空。
    pub textures: Vec<String>,
}

/// 导出选项。字段可经 serde 反序列化（键名即字段名），
/// 但本仓调用点一律用结构体字面量加 `..ConvertOptions::default()` 构造。
///
/// 默认值见 `impl Default for ConvertOptions`，与各字段 `serde(default = "…")` 的取值一致：
/// `textures = true`、`texture_scale = 1.0`、`generate_missing_list = true`，
/// 三个集合/数值字段为空表或 0。
#[derive(Debug, Deserialize, Clone)]
pub struct ConvertOptions {
    /// 是否走材质与纹理通路。`false` 时 `convert` 不调 `gltf_builder::push_or_get_material_bsp`，
    /// 图元不带材质索引，[`ExportResult::textures`] 保持为空。默认 `true`。
    #[serde(default = "default_enable")]
    pub textures: bool,
    /// 纹理缩放**倍数**（无量纲，非像素尺寸）。
    /// `materials::load_texture_bsp` 把它乘到解码后 VTF 的宽高上
    /// （`width * scale` 与 `height * scale` 截断为 `u32`，重采样用 `FilterType::CatmullRom`）；
    /// 恰为 `1.0` 时跳过缩放，直接返回原图。默认 `1.0`；代码不校验取值范围。
    #[serde(default = "default_scale")]
    pub texture_scale: f32,
    /// 是否把材质加载失败记入 [`ExportResult::missing_resources`]。默认 `true`。
    /// `false` 时清单恒为空，但材质回退行为（回退贴图、纯白默认材质）不变。
    #[serde(default = "default_enable_missing_list")]
    pub generate_missing_list: bool,
    /// 缺失纹理回退表：`{ "materials/<材质路径小写>": "#mosaic v4 字节码" }`（默认纹理包）。
    ///
    /// 值由 `mosaic::decode::code_to_img` 在导出期解成 PNG 字节，直接嵌进 GLB。
    /// 查表两处，都用 `scale = 8`：
    /// - `materials::load_material_fallback_bsp`：整条材质加载失败时按**材质名**查；
    /// - `materials::load_material_bsp`：`$basetexture` 的 VTF 加载失败时依次按
    ///   `$basetexture` 路径、材质名查（保留 VMT 已解析到的透明度声明）。
    ///
    /// 表由前端从默认纹理包解压得到，原样透传给导出入口
    /// （`src/ts-shared/phys/world-builder.ts` 的 `buildWorldBundle`）。空表即不启用，
    /// `ConvertOptions::default()` 就是空表。
    #[serde(default)]
    pub missing_fallback: std::collections::HashMap<String, String>,
    /// pakfile 内 VMT 的**基名索引**：`基名小写` → `materials/` 前缀、去 `.vmt` 后缀的路径
    /// （值保留条目原始大小写，因为 `bsp.pack.get` 走 `zip.by_name`，按名精确匹配）。
    ///
    /// 用途：世界面的贴图名来自 BSP texinfo（形如 `METAL/METALGRATE013A2`），当
    /// `materials/<该名>.vmt` 的 4 条精确候选路径全不命中时，改用**同一基名**的 VMT
    /// （形如 `materials/666/metalgrate013a2.vmt`）——它携带该贴图的 `$basetexture`
    /// 与透明度声明，是精确 VMT 不在包内时的替代来源。
    ///
    /// 构建方：apps 侧由 PAKFILE 条目名生成（`apps/game/crates/wasm/src/lib.rs` 的
    /// `build_vmt_stem_index`，同名多条时取路径最短者）。空表即不启用基名回退，
    /// `ConvertOptions::default()` 就是空表。
    #[serde(default)]
    pub vmt_stem_index: std::collections::HashMap<String, String>,
    /// 单页图集面积上界（px²）的**显式覆盖**：`0` = 用政策上界
    /// `MAX_ATLAS_PAGE_AREA = 4096 × 4096 / 2 = 8,388,608`（即 4096×2048）。
    ///
    /// `> 0` 时 `lightmap::effective_max_atlas_area` 直接把它当判定阈值，
    /// `lightmap::is_allowed_page_shape` 仍要求单边 ≤ `MAX_ATLAS_SIDE`(4096) 且面积 ≤ 该值；
    /// 连允许的最大形状都装不下时 `lightmap::build_atlas` 返回错误，错误文本自报
    /// `packedArea`、允许最大形状与所需页数下界。
    /// 该字段只改**判定阈值**：不改打包、落位、UV 与像素编码口径，也不降采样、不截断。
    ///
    /// apps 侧的 `defaults*` 入口把 f64 参数（有限且 > 0 时）截断为 u64 传入
    /// （`apps/game/crates/wasm/src/lib.rs` 的
    /// `export_glb_with_pakfile_models_with_defaults_and_atlas_limit`）。默认 `0`。
    #[serde(default)]
    pub lightmap_max_atlas_area: u64,
}

impl ConvertOptions {
    /// 选项的哈希键（u64）：固定种子 `RandomState::with_seeds(1, 2, 3, 4)`，
    /// 只写入 `textures`、`texture_scale`（按 `to_le_bytes` 逐字节）与 `generate_missing_list` 三个字段。
    ///
    /// `missing_fallback`、`vmt_stem_index`、`lightmap_max_atlas_area` **不参与**哈希，
    /// 因此仅在这三个字段上不同的两组选项会得到同一个键。
    /// 本仓检索不到调用点（`key()` 的唯一出现处就是这条定义）。
    pub fn key(&self) -> u64 {
        let mut hasher = RandomState::with_seeds(1, 2, 3, 4).build_hasher();
        self.textures.hash(&mut hasher);
        self.texture_scale.to_le_bytes().hash(&mut hasher);
        self.generate_missing_list.hash(&mut hasher);
        hasher.finish()
    }
}

/// 默认选项：`textures = true`、`texture_scale = 1.0`、`generate_missing_list = true`，
/// 另外三个字段为空表/空表/0 —— 即不启用基名回退与缺失贴图回退，lightmap 用政策上界。
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

/// `textures` 缺键时的 serde 缺省值：`true`（与 `Default` 一致）。
fn default_enable() -> bool {
    true
}

/// `texture_scale` 缺键时的 serde 缺省值：`1.0`，即不缩放（与 `Default` 一致）。
fn default_scale() -> f32 {
    1.0
}

/// `generate_missing_list` 缺键时的 serde 缺省值：`true`（与 `Default` 一致）。
fn default_enable_missing_list() -> bool {
    true
}


// ── 错误类型 ──────────────────────────────────────────────
/// 本模块的统一错误类型（`thiserror::Error` + `miette::Diagnostic`）。
///
/// 派生里没有任何 `#[diagnostic(...)]` 标注，因此不带错误码与帮助文本。
/// `#[from]` 让 `?` 可直接转换；本模块现有代码里确实出现转换点的变体：
/// `Utf8Error`（`materials` 的两处 `String::from_utf8(..)?`）、
/// `VtfError`（`materials::load_texture_bsp` 的 `VTF::read(..)?` 与 `decode(0)?`）、
/// `ModelIntegratorError`（`convert` 的 `add_lighting_to_gltf_json(..)?`）、
/// `Other`（手写文本，`convert` / `lightmap` / `materials` / `mosaic::manifest` 共用）。
#[derive(Error, Debug, miette::Diagnostic)]
pub enum Error {
    /// 资源未找到，携带资源名。
    ///
    /// 本模块内没有构造点：材质缺失一律走 `Other`，由 `materials` 的
    /// `Can't find VMT file in BSP. Tried: …` 一类文本承载。
    #[error("资源未找到: {0}")]
    ResourceNotFound(String),
    /// 自由文本错误。`Display` 就是载荷本身，不加前缀。
    #[error("{0}")]
    Other(String),
    /// IO 错误（`#[from]`）。本模块内没有构造点。
    #[error("IO 错误: {0}")]
    IoError(#[from] std::io::Error),
    /// UTF-8 解码错误（`#[from]`）。来源：`materials` 把 pakfile 里的 VMT 文本
    /// `String::from_utf8(..)` 时字节非法。
    #[error("UTF-8 错误: {0}")]
    Utf8Error(#[from] std::string::FromUtf8Error),
    /// VTF 解析或解码错误（`#[from]`）。来源：`materials::load_texture_bsp`。
    #[error("VTF 错误: {0}")]
    VtfError(#[from] vtf::Error),
    /// VDF 解析错误（`#[from]`）。本模块内没有构造点：
    /// `materials::load_material_bsp` 对 `vmt_parser::from_str` 的失败是就地 match 处理，不走 `?`。
    #[error("VDF 错误: {0}")]
    VdfError(#[from] vmt_parser::VdfError),
    /// glTF JSON 错误（`#[from]`）。本模块内没有构造点：
    /// 序列化失败在 `convert` 走 `expect("Serialization error")`，在 `lightmap` 转成 `Other`。
    #[error("GLTF JSON 错误: {0}")]
    GltfJsonError(#[from] gltf_json::Error),
    /// 模型整合错误（`#[from]`）。来源：`convert` 调 `model_integrator` 的灯光注入。
    #[error("模型集成错误: {0}")]
    ModelIntegratorError(#[from] crate::model_integrator::ModelIntegratorError),
}
