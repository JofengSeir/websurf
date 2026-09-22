//! BSP 解析：把整份 `.bsp` 字节组装成一份已校验的 [`Bsp`]。
//!
//! 上游：各工程 `crates/wasm` 的导出层把字节切片交给 `Bsp::read`
//! （`apps/debug/crates/wasm/src/lib.rs`、`apps/game/crates/wasm/src/lib.rs`、
//! `apps/viewer/crates/wasm/src/lib.rs` 均有 `vbsp::Bsp::read` 调用点）。
//! 下游：本文件驱动 `bspfile.rs`（按 lump 取字节）与 `reader.rs`（按记录读出结构），
//! 产出的 `Bsp` 再交给 `bsp_to_gltf_core`（GLB 与 lightmap 图集）、`model_integrator`
//! （静态道具放置）、`mosaic`（纹理清单）以及各工程导出层的 brush / PVS / teleport JSON。
//!
//! 职责：① `BspFile::new` 校验头部与 64 项 lump 目录；② 按固定顺序逐个 lump 取值并解析进
//! `Bsp` 的对应字段；③ 在 LDR / HDR 两条光照 lump 里择一并复核解压后字节数；
//! ④ 收尾跑 `validate` 做跨表索引检查。
//!
//! 关键不变量与坑（逐条取值口径写在各方法上，这里只列踩了会错的）：
//! - **nodes 必须先于 leaves 读**：`read_leaves` 的记录大小（32 B 或 56 B）由 BSP 树实际引用的
//!   最大 leaf 索引决定，而这个索引只能从 `nodes` 的负 `children` 反推。
//! - **leaf 表不能排序**：`Node::children` 存的是按位取反的 leaf 绝对下标，重排会让树遍历落到
//!   错误的 leaf；cluster 视图另存一份 `sorted_leaves`。
//! - 光照 lump 与叶环境光**不是同一条择一规则**：前者按"HDR 是否非空"，后者按"HDR 是否严格
//!   长于 LDR"（见 `prop_ambient_cube`）。
//! - 四条叶环境光 lump 走 `unwrap_or_default()`：读失败与"该图没有这条 lump"都落成空 `Vec`，
//!   调用方无法区分这两者。
//! - `AMBIENT_SCALE` 是本模块内 prop ambient cube 唯一的量级乘子。
//!
//! 边界：只做解析、组装与跨表校验；不解释各 lump 的内部布局（那是 `data/**` 的职责），
//! 不做几何与光照计算——`prop_ambient_cube` 是唯一对外的查询例外。
//!
//! 测试归属：本文件 2 个 `#[test]`：`test_leaf_clusters`（钉 `Leaves::clusters` 的分组语义）
//! 与 `tf2_file`（`#[ignore]`，要求工作目录下存在本地 BSP 文件）。
//!
//! 来源：本模块是 crates.io `vbsp` 0.6.0 的本地分叉（`Cargo.toml` 依赖表内没有 `vbsp` 条目）。

// 本模块保留完整的 BSP 解析面，其中一部分项没有被三个工程取用（`handle/mod.rs` 同样声明）。
#![allow(dead_code)]

mod bspfile;
pub mod data;
pub mod error;
mod handle;
mod reader;

use crate::vbsp::bspfile::LumpType;
pub use crate::vbsp::data::TextureFlags;
pub use crate::vbsp::data::Vector;
pub use crate::vbsp::data::*;

/// prop ambient cube 的**唯一量级旋钮**：对 `decode_linear_ambient` 的结果统一乘它。
///
/// 当前值 `1.0`，即按 `data/game.rs` 的 `decode_linear_ambient` 原值输出（mantissa × 2^exp，不除 255）。
/// 读取点只有两处，都在 `prop_ambient_cube` 内：中性灰兜底 `NEUTRAL` 与六个面的写出。
pub(crate) const AMBIENT_SCALE: f32 = 1.0;
use crate::vbsp::error::ValidationError;
pub use crate::vbsp::handle::Handle;
use binrw::io::Cursor;
use binrw::{BinRead, BinReaderExt};
use bspfile::BspFile;
pub use error::{BspError, StringError};
use lzma_rs::decompress::{Options, UnpackedSize};
use reader::LumpReader;
use std::cmp::min;
use std::ops::Deref;

/// 本模块统一的返回类型：`Result<T, BspError>`。
///
/// 失败原因的分类见 `error.rs`：字节读不出来是 `MalformedData` / `IO`，
/// 文件完整但内容不成立是 `Validation`。
pub type BspResult<T> = Result<T, BspError>;

/// leaf 表：同一批 `Leaf` 存两份视图——树遍历要的**原始下标顺序**，与 cluster 分组要的**排序副本**。
///
/// `Leaf` 固定 32 B（`data/mod.rs` 的编译期断言），两份表就是两倍常驻内存。
#[derive(Debug, Clone)]
pub struct Leaves {
    /// 原始顺序的 leaves（与文件中的下标一一对应）；`Deref` / 三种 `IntoIterator` 都读它。
    ///
    /// **不能重排**：`Node::children` 里的 leaf 项是按位取反的绝对下标，
    /// 排序会让 `Bsp::leaf_at` 与 `Bsp::prop_ambient_cube` 的树遍历落到错误的 leaf。
    leaves: Vec<Leaf>,
    /// 按 `cluster` 排序的副本，只喂 `clusters()`，不参与任何下标寻址。
    sorted_leaves: Vec<Leaf>,
}

impl Leaves {
    /// 建表：克隆一份 leaves 并按 `cluster` 排序当分组视图，传入的那份保持原顺序。
    pub fn new(leaves: Vec<Leaf>) -> Self {
        // 排序副本只服务 clusters()；leaves 本身保持调用方给的顺序
        let mut sorted_leaves = leaves.clone();
        sorted_leaves.sort_unstable_by_key(|leaf| leaf.cluster);
        Leaves {
            leaves,
            sorted_leaves,
        }
    }

    /// 按原始顺序迭代（与 `Deref` 到 `[Leaf]` 看到的是同一份数据）。
    pub fn iter(&self) -> impl Iterator<Item = &Leaf> {
        self.into_iter()
    }

    /// 按原始顺序可变迭代；改这里**不会**同步到 `sorted_leaves`，两份视图就此分叉。
    pub fn iter_mut(&mut self) -> impl Iterator<Item = &mut Leaf> {
        self.into_iter()
    }

    /// 取回原始顺序的 `Vec<Leaf>`；`sorted_leaves` 随之丢弃。
    pub fn into_inner(self) -> Vec<Leaf> {
        self.leaves
    }

    /// 按 cluster 分组迭代：外层每项是一个 cluster，内层是该 cluster 的 leaves。
    ///
    /// 组内次序即 `sorted_leaves` 的次序（排序不稳定，同 cluster 内的相对顺序无保证）。
    /// 本仓没有生产调用点，唯一调用是 `test_leaf_clusters`；三工程的导出路径迭代的是未排序的 `leaves`。
    pub fn clusters(&self) -> impl Iterator<Item = impl Iterator<Item = &Leaf>> {
        LeafClusters {
            leaves: &self.sorted_leaves,
            index: 0,
        }
    }
}

/// `Leaves::clusters` 的迭代器：在已按 `cluster` 排序的切片上，每次切出一段相邻同 cluster 的 leaves。
///
/// 分组靠"相邻 `cluster` 相等"（`take_while`），不查表也不哈希，因此**依赖输入已排序**；
/// 游标按整组条数前进，所以外层每项都非空。
struct LeafClusters<'a> {
    leaves: &'a [Leaf],
    index: usize,
}

impl<'a> Iterator for LeafClusters<'a> {
    type Item = <&'a [Leaf] as IntoIterator>::IntoIter;

    fn next(&mut self) -> Option<Self::Item> {
        let cluster = self.leaves.get(self.index)?.cluster;
        let remaining_leaves = self.leaves.get(self.index..)?;
        let cluster_size = remaining_leaves
            .iter()
            .take_while(|leaf| leaf.cluster == cluster)
            .count();
        self.index += cluster_size;
        Some(remaining_leaves[0..cluster_size].iter())
    }
}

/// 钉住 `clusters()` 的分组结果：按 cluster 排序后，cluster 0 → `[0, 1]`、cluster 1 → `[2]`、
/// cluster 2 → `[3, 4]`（断言里的数字是各 leaf 的 `contents`，即构造顺序）。
#[test]
fn test_leaf_clusters() {
    let leaves: Leaves = vec![
        Leaf {
            contents: 0,
            cluster: 0,
            ..Default::default()
        },
        Leaf {
            contents: 1,
            cluster: 0,
            ..Default::default()
        },
        Leaf {
            contents: 2,
            cluster: 1,
            ..Default::default()
        },
        Leaf {
            contents: 3,
            cluster: 2,
            ..Default::default()
        },
        Leaf {
            contents: 4,
            cluster: 2,
            ..Default::default()
        },
    ]
    .into();

    let clustered: Vec<Vec<i32>> = leaves
        .clusters()
        .map(|cluster| cluster.map(|leaf| leaf.contents).collect())
        .collect();
    assert_eq!(vec![vec![0, 1], vec![2], vec![3, 4]], clustered);
}

/// 与 `Leaves::new` 同义：排序副本在转换时建立。
impl From<Vec<Leaf>> for Leaves {
    fn from(other: Vec<Leaf>) -> Self {
        Self::new(other)
    }
}

/// 解引用到**原始顺序**的 `[Leaf]`：`len()` / `get()` / `iter()` 都由此生效（各工程用的是这些）。
impl Deref for Leaves {
    type Target = [Leaf];

    fn deref(&self) -> &Self::Target {
        &self.leaves
    }
}

/// 消费式迭代：按原始顺序移出 leaves。
impl IntoIterator for Leaves {
    type Item = Leaf;
    type IntoIter = <Vec<Leaf> as IntoIterator>::IntoIter;

    fn into_iter(self) -> Self::IntoIter {
        self.leaves.into_iter()
    }
}

/// 借用迭代：按原始顺序，与 `Leaves::iter` 同一份数据。
impl<'a> IntoIterator for &'a Leaves {
    type Item = &'a Leaf;
    type IntoIter = <&'a [Leaf] as IntoIterator>::IntoIter;

    fn into_iter(self) -> Self::IntoIter {
        self.leaves[..].iter()
    }
}

/// 可变借用迭代：按原始顺序，不动 `sorted_leaves`。
impl<'a> IntoIterator for &'a mut Leaves {
    type Item = &'a mut Leaf;
    type IntoIter = <&'a mut [Leaf] as IntoIterator>::IntoIter;

    fn into_iter(self) -> Self::IntoIter {
        self.leaves.iter_mut()
    }
}

/// 光照 lump 的择一结果：`LumpType::Lighting` 与 `LumpType::LightingHdr` 取其一后的样本字节。
///
/// `data` 是**解压后**的原始字节——`BspFile::get_lump` 里 `match lump.ident`：`0` 直接借用
/// 原始切片，`_` 才走 LZMA 解压。按 `ColorRgbExp32` 样本序列切分：4 B/样本，
/// R/G/B 尾数各 1 B + 共享指数 1 B，解码在 `data/game.rs` 的 `decode_linear`。
///
/// 两条 lump 的目录项另存成 `ldr` / `hdr`：这样"选了哪条、那条压没压缩、解压后多长"都能直接读到，
/// 不必为落选的那条再解压一份缓冲。
///
/// 样本布局与 LDR/HDR 择一规则对齐外部参照实现。
#[derive(Debug, Clone)]
pub struct LightingLump {
    /// 样本是否取自 `LumpType::LightingHdr`。
    pub is_hdr: bool,
    /// 解压后的完整字节；长度必须是 4 的整数倍（`Bsp::read` 已强制）。
    pub data: Vec<u8>,
    /// `LumpType::Lighting` 的目录项快照（与 `is_hdr` 一起构成选择证据）。
    pub ldr: LightingLumpSource,
    /// `LumpType::LightingHdr` 的目录项快照。
    pub hdr: LightingLumpSource,
}

/// 一条光照 lump 的目录项快照：只留元数据，不持有第二份字节缓冲。
///
/// 字段就是 `BspFile::lump_entry` 返回的目录项原值。`ident != 0` 表示该 lump 被 Source LZMA
/// 封装，此时 `ident` 是**解压后**长度（判断与解压都在 `BspFile::get_lump` 里）。
#[derive(Debug, Clone, Copy, Default)]
pub struct LightingLumpSource {
    /// 盘上长度（LZMA 时是压缩流长度）。**不是**解压后长度。
    pub dir_length: u32,
    /// `0` = 未压缩；非 0 = LZMA 封装，且该值等于解压后字节数。
    pub ident: u32,
}

impl LightingLumpSource {
    /// 该 lump 解压后的字节数：`ident != 0` 取 `ident`，否则取 `dir_length`。
    ///
    /// 一切按字节数算的容量（样本数、luxel 预算、缓冲大小）都必须以它为分母：
    /// 压缩 lump 的 `dir_length` 只是压缩流长度，与 `LightingLump::decompressed_bytes` 不是同一口径
    /// ——`Bsp::read` 收尾的自检正是拿这两者比对。
    pub fn decompressed_length(&self) -> u64 {
        if self.ident != 0 {
            self.ident as u64
        } else {
            self.dir_length as u64
        }
    }

    /// 该 lump 是否被 LZMA 封装（即 `ident != 0`）；`Bsp::read` 据此挑选报错变体。
    pub fn is_compressed(&self) -> bool {
        self.ident != 0
    }

    /// 盘上长度为 0，即这条 lump 没有数据。
    ///
    /// 注意光照择一判的是 `BspFile::get_lump` 取回的**字节**是否为空（即解压后长度），
    /// 不是本方法；本仓没有调用点。
    pub fn is_empty(&self) -> bool {
        self.dir_length == 0
    }
}

impl LightingLump {
    /// 样本数 = 解压后字节数 / 4（`ColorRgbExp32` 4 B/样本）。
    ///
    /// 整数除法：`Bsp::read` 已拒绝字节数不能被 4 整除的 lump，所以这里不会静默丢余数。
    /// `bsp_to_gltf_core/lightmap.rs` 用它当 luxel 预算的分母。
    pub fn sample_count(&self) -> u64 {
        (self.data.len() / 4) as u64
    }

    /// 实际持有的解压后字节数（= `data.len()`）。
    ///
    /// `Bsp::read` 要求它等于所选目录项的 `LightingLumpSource::decompressed_length()`，
    /// 不等即返回 `BspError::UnexpectedCompressedLumpSize` / `UnexpectedUncompressedLumpSize`。
    pub fn decompressed_bytes(&self) -> u64 {
        self.data.len() as u64
    }

    /// 选了哪条 lump 的可读标签：`"hdr"` 或 `"ldr"`；调用方把它写进报错与导出信息。
    pub fn chosen_kind(&self) -> &'static str {
        if self.is_hdr {
            "hdr"
        } else {
            "ldr"
        }
    }
}

// 内存注记：各字段是各自独立的 `Vec`（`leaves` 还额外持一份排序副本），逐字段遍历会多次跳 cache line；
// 若要内联存储，这里是改造点。
/// 一份解析完成、已通过 `validate` 的 BSP。
///
/// `#[non_exhaustive]`：外部 crate 不能用结构体字面量构造；crate 内也只有 `Bsp::read` 组装它。
/// 字段基本都是 `pub`，但常规读取路径是 `Bsp` 上的句柄访问器（`leaf` / `plane` / `face` / `node` /
/// `displacement`）与 `models()` / `textures()` / `static_props()` 这些迭代器；
/// 直接读字段的主要是各工程 `crates/wasm` 的 brush / PVS / teleport 导出路径。
///
/// 同一份数据存在两套口径：`faces` 与 `faces_hdr` 是两张面表，
/// 叶环境光也有 `leaf_ambient_lighting` / `leaf_ambient_lighting_hdr` 两组；
/// 选哪一套由使用方按各自的择一规则决定。
#[derive(Debug)]
#[non_exhaustive]
pub struct Bsp {
    /// 魔数四字节（`v`/`b`/`s`/`p`）。lump 目录**不**保留在这里——它只存在于 `BspFile` 内部。
    pub header: Header,
    /// 实体文本；`reader.rs` 的 `read_entities` 已整体转小写，键值解析在 `data/entity.rs`。
    pub entities: Entities,
    /// 纹理元数据表（宽高、名称表下标、反射率）。
    pub textures_data: Vec<TextureData>,
    /// 每条一个：UV 变换向量 + `flags` + 指向 `textures_data` 的下标。
    pub textures_info: Vec<TextureInfo>,
    /// 纹理名在 `texture_string_data` 里的**字节**偏移（`validate` 按字节长度查界，不是按条数）。
    pub texture_string_tables: Vec<i32>,
    /// 纹理名缓冲区，`\0` 分隔；取名单条时按偏移切到下一个 `\0`。
    pub texture_string_data: String,
    /// 平面表（`normal` + `dist`），被 `nodes` 与 `faces` 引用。
    pub planes: Vec<Plane>,
    /// BSP 树节点：`children[i] >= 0` 是节点下标，`< 0` 时 `!children[i]` 是 `leaves` 的下标；下标 0 是根。
    pub nodes: Vec<Node>,
    /// leaf 表（原始顺序 + 按 cluster 排序的副本两套视图）。
    pub leaves: Leaves,
    /// leaf → face 下标表；`Handle<Leaf>::faces` 按 `Leaf::first_leaf_face` / `leaf_face_count` 切它。
    pub leaf_faces: Vec<LeafFace>,
    /// leaf → brush 下标表；本仓无读取方，`validate` 也不检查它。
    pub leaf_brushes: Vec<LeafBrush>,
    /// 模型表；下标 0 是世界模型（`bsp_to_gltf_core/convert.rs` 的 `bsp_models` 取 `models().next()`，
    /// 取不到即报 `No world model`）。
    pub models: Vec<Model>,
    /// 刷子（凸体）表；`brush_sides` 按 `Brush::brush_side` / `num_brush_sides` 切。
    pub brushes: Vec<Brush>,
    /// 刷子面表。
    pub brush_sides: Vec<BrushSide>,
    /// 顶点表（Source 坐标）。
    pub vertices: Vec<Vertex>,
    /// 边表：`start_index` / `end_index` 是 `vertices` 下标，方向由引用它的 `surface_edges` 决定。
    pub edges: Vec<Edge>,
    /// 面 → 边的索引表；`edge` 带符号，`edge_index()` 取绝对值、符号即方向。
    pub surface_edges: Vec<SurfaceEdge>,
    /// `FACES`(7) 面表：`first_edge` / `num_edges` 切 `surface_edges`，`light_offset` 切光照 lump（4 B/样本）。
    pub faces: Vec<Face>,
    /// `FACES_HDR`(58) 面表；空表示该图没有独立的 HDR 面表。
    ///
    /// 选它要与光照 lump 的选择保持一致：`bsp_to_gltf_core/lightmap.rs` 的 `lightmap_faces`
    /// 只在"选了 HDR 光照**且**本表非空"时用它，且要求两张面表条目数相等，否则显式报错
    /// ——否则 `light_offset` 会错位，读出来的每面光照都落在错误的位置。
    pub faces_hdr: Vec<Face>,
    /// 光照 lump（`LumpType::Lighting` / `LumpType::LightingHdr` 二选一）；两条都空时为 `None`。
    pub lighting: Option<LightingLump>,
    /// `ORIGINAL_FACES`(27) 面表（BSP 切分前的原始面）。
    ///
    /// 只有字段与读取流程，本仓没有遍历它的访问器——`Bsp::original_faces` 迭代的是 `faces`。
    pub original_faces: Vec<Face>,
    /// 可见性数据；`pvs_offsets` / `pas_offsets` 是相对 `data` **起点**的偏移（`reader.rs` 的 `read_visdata`）。
    pub vis_data: VisData,
    /// displacement 信息表（被 `Face::displacement_info` 引用）。
    pub displacements: Vec<DisplacementInfo>,
    /// displacement 顶点表（位移量），由 `DisplacementInfo` 的区间字段切。
    pub displacement_vertices: Vec<DisplacementVertex>,
    /// displacement 三角表。
    pub displacement_triangles: Vec<DisplacementTriangle>,
    /// 顶点法线表：私有字段，只有 `validate` 用它（检查索引落在表内），没有对外访问器。
    vertex_normals: Vec<VertNormal>,
    /// 顶点法线索引表：同上，私有且只被 `validate` 使用。
    vertex_normal_indices: Vec<VertNormalIndex>,
    /// 静态道具 game lump（`data/game.rs` 里 `PropStaticGameLump::ID = b"sprp"`）：
    /// 模型名字典、放置表与道具叶表。
    pub static_props: PropStaticGameLump,
    /// `LEAF_AMBIENT_LIGHTING`(56) 的 LDR 采样表；空 = 该图没有这条 lump **或**读取失败。
    pub leaf_ambient_lighting: Vec<LeafAmbientSample>,
    /// `LEAF_AMBIENT_LIGHTING_HDR`(55) 的 HDR 采样表；空 = 该图没有这条 lump **或**读取失败。
    pub leaf_ambient_lighting_hdr: Vec<LeafAmbientSample>,
    /// `LEAF_AMBIENT_INDEX`(52)：每 leaf 的采样区间（LDR 组）。
    pub leaf_ambient_indices: Vec<LeafAmbientIndex>,
    /// `LEAF_AMBIENT_INDEX_HDR`(51)：每 leaf 的采样区间（HDR 组）。
    pub leaf_ambient_indices_hdr: Vec<LeafAmbientIndex>,
    /// `PAKFILE`(40) 解出的 zip 包：模型三件套、VMT/VTF、逐顶点光照 `.vhv` 都从这里取。
    pub pack: Packfile,
}

impl Bsp {
    /// 解析整份 BSP：建 `BspFile` → 逐 lump 取值 → 择一光照 lump → 组装 `Bsp` → 校验。
    ///
    /// 读取顺序（与字段依赖绑定，改序会改语义）：
    /// 1. `BspFile::new`：校验魔数 `VBSP` 与版本 19..=29，并读出 64 项 lump 目录；
    /// 2. `Entities` → `TextureData` → `TextureInfo` → `TextureDataStringTable` →
    ///    `TextureDataStringData`（最后一条走 `get_lump` + `String::from_utf8`，非 UTF-8 返回 `BspError::String`）；
    /// 3. `Planes` → `Nodes`；
    /// 4. 从 `nodes` 的负 `children` 取反求最大值得到 `max_leaf_index`（一个负 child 都没有时为 `-1`），
    ///    再读 `Leaves`——**`read_leaves` 的记录大小（32 B 或 56 B）由这个索引决定，所以 nodes 必须先读完**；
    /// 5. `LeafFaces` / `LeafBrushes` / `Models` / `Brushes` / `BrushSides` / `Vertices` / `Edges` /
    ///    `SurfaceEdges` / `Faces` / `FacesHdr`；
    /// 6. 光照 lump 择一并自检（见下）；
    /// 7. `OriginalFaces` / `Visibility`（走 `read_visdata`）/ displacement 三表 / 顶点法线两表；
    /// 8. `GameLump` 头 → `GameLumpHeader::find` 找 `PropStaticGameLump`（ID `sprp`）得 `static_props`
    ///    （找不到即 `ValidationError::NoStaticPropLump`）；
    ///    `PakFile` 交给 `Packfile::read` 建 zip；
    /// 9. 四条叶环境光 lump（`LeafAmbientLightingHdr` / `LeafAmbientLighting` / `LeafAmbientIndexHdr` /
    ///    `LeafAmbientIndex`），读取失败一律 `unwrap_or_default()` 落成空 `Vec`；
    /// 10. 组装 `Bsp`，最后跑 `validate`。
    ///
    /// 光照 lump 择一规则（先判 HDR 那条）：`get_lump(LightingHdr)` 的**字节非空** ⇒ 采用 HDR
    /// （`is_hdr = true`）；否则再看 `get_lump(Lighting)`：非空 ⇒ 采用 LDR，为空 ⇒ `lighting = None`。
    /// 判的是 `get_lump` 返回的**长度**（已解压），不是目录项 `dir_length`，也不与 LDR 比长度；
    /// HDR 非空时不会去解压 LDR。选定后再自检两条：解压后字节数必须等于所选目录项的
    /// `decompressed_length()`（不等时按 `is_compressed()` 返回 `UnexpectedCompressedLumpSize` 或
    /// `UnexpectedUncompressedLumpSize`），且必须是 4 的整数倍（否则 `InvalidLumpSize`，
    /// `element_size = 4`）。
    ///
    /// 失败：头部、lump 越界、记录长度不整除、跨表索引校验失败都直接返回 `BspError`，
    /// 没有兼容降级分支；`Bsp` 只有本方法一个组装点。
    pub fn read(data: &[u8]) -> BspResult<Self> {
        let bsp_file = BspFile::new(data)?;

        let entities = bsp_file.lump_reader(LumpType::Entities)?.read_entities()?;
        let textures_data = bsp_file
            .lump_reader(LumpType::TextureData)?
            .read_vec(|r| r.read())?;
        let textures_info = bsp_file
            .lump_reader(LumpType::TextureInfo)?
            .read_vec(|r| r.read())?;
        let texture_string_tables = bsp_file
            .lump_reader(LumpType::TextureDataStringTable)?
            .read_vec(|r| r.read())?;
        let texture_string_data = String::from_utf8(
            bsp_file
                .get_lump(LumpType::TextureDataStringData)?
                .into_owned(),
        )
        .map_err(|e| BspError::String(StringError::NonUTF8(e.utf8_error())))?;
        let planes = bsp_file
            .lump_reader(LumpType::Planes)?
            .read_vec(|r| r.read())?;
        let nodes = bsp_file
            .lump_reader(LumpType::Nodes)?
            .read_vec(|r| r.read())?;
        // 自适应 leaf 记录大小要用它：取所有负 child（leaf 侧）里取反后的最大下标
        let max_leaf_index = nodes
            .iter()
            .flat_map(|node: &Node| node.children)
            .filter(|c| *c < 0)
            .map(|c| !c)
            .max()
            .unwrap_or(-1);
        let leaves = bsp_file
            .lump_reader(LumpType::Leaves)?
            .read_leaves(max_leaf_index)?
            .into();
        let leaf_faces = bsp_file
            .lump_reader(LumpType::LeafFaces)?
            .read_vec(|r| r.read())?;
        let leaf_brushes = bsp_file
            .lump_reader(LumpType::LeafBrushes)?
            .read_vec(|r| r.read())?;
        let models = bsp_file
            .lump_reader(LumpType::Models)?
            .read_vec(|r| r.read())?;
        let brushes = bsp_file
            .lump_reader(LumpType::Brushes)?
            .read_vec(|r| r.read())?;
        let brush_sides = bsp_file
            .lump_reader(LumpType::BrushSides)?
            .read_vec(|r| r.read())?;
        let vertices = bsp_file
            .lump_reader(LumpType::Vertices)?
            .read_vec(|r| r.read())?;
        let edges = bsp_file
            .lump_reader(LumpType::Edges)?
            .read_vec(|r| r.read())?;
        let surface_edges = bsp_file
            .lump_reader(LumpType::SurfaceEdges)?
            .read_vec(|r| r.read())?;
        let faces = bsp_file
            .lump_reader(LumpType::Faces)?
            .read_vec(|r| r.read())?;
        // FACES_HDR(58)：独立于 FACES 的 HDR 面表；读法与 Faces 相同（失败即向上返回）。
        let faces_hdr = bsp_file
            .lump_reader(LumpType::FacesHdr)?
            .read_vec(|r| r.read())?;
        // 光照 lump 择一：先取 HDR 字节，非空即采用；为空再看 LDR，LDR 也空则 lighting 为 None。
        // get_lump 已按 ident 做过 LZMA 解压，所以这里判的是解压后长度（不是目录项 dir_length），
        // 也不与 LDR 比长短。两条 lump 的目录项同时留档，使"选了哪条、那条压没压缩"可直接读出。
        let ldr_entry = bsp_file.lump_entry(LumpType::Lighting);
        let hdr_entry = bsp_file.lump_entry(LumpType::LightingHdr);
        let ldr_source = LightingLumpSource {
            dir_length: ldr_entry.length,
            ident: ldr_entry.ident,
        };
        let hdr_source = LightingLumpSource {
            dir_length: hdr_entry.length,
            ident: hdr_entry.ident,
        };
        let lighting = {
            let hdr_raw = bsp_file.get_lump(LumpType::LightingHdr)?;
            if !hdr_raw.is_empty() {
                Some(LightingLump {
                    is_hdr: true,
                    data: hdr_raw.into_owned(),
                    ldr: ldr_source,
                    hdr: hdr_source,
                })
            } else {
                let ldr_raw = bsp_file.get_lump(LumpType::Lighting)?;
                if ldr_raw.is_empty() {
                    None
                } else {
                    Some(LightingLump {
                        is_hdr: false,
                        data: ldr_raw.into_owned(),
                        ldr: ldr_source,
                        hdr: hdr_source,
                    })
                }
            }
        };
        // 自检两条：① 解压后字节数等于所选目录项声明的解压后长度（未压缩的 lump 同样要等于
        // dir_length，只有报错变体按 is_compressed() 二分）；② 长度是 4 的整数倍（4 B/样本）。
        if let Some(lighting) = &lighting {
            let (source, lump_type) = if lighting.is_hdr {
                (hdr_source, LumpType::LightingHdr)
            } else {
                (ldr_source, LumpType::Lighting)
            };
            let declared = source.decompressed_length();
            if lighting.decompressed_bytes() != declared {
                let got = lighting.decompressed_bytes() as u32;
                let expected = declared as u32;
                return Err(if source.is_compressed() {
                    BspError::UnexpectedCompressedLumpSize { got, expected }
                } else {
                    BspError::UnexpectedUncompressedLumpSize { got, expected }
                });
            }
            if lighting.decompressed_bytes() % 4 != 0 {
                return Err(BspError::InvalidLumpSize {
                    lump: lump_type,
                    element_size: 4,
                    lump_size: lighting.decompressed_bytes() as usize,
                });
            }
        }
        let original_faces = bsp_file
            .lump_reader(LumpType::OriginalFaces)?
            .read_vec(|r| r.read())?;
        let vis_data = bsp_file.lump_reader(LumpType::Visibility)?.read_visdata()?;
        let displacements = bsp_file
            .lump_reader(LumpType::DisplacementInfo)?
            .read_vec(|r| r.read())?;
        let displacement_vertices = bsp_file
            .lump_reader(LumpType::DisplacementVertices)?
            .read_vec(|r| r.read())?;
        let displacement_triangles = bsp_file
            .lump_reader(LumpType::DisplacementTris)?
            .read_vec(|r| r.read())?;
        let vertex_normals = bsp_file
            .lump_reader(LumpType::VertNormals)?
            .read_vec(|r| r.read())?;
        let vertex_normal_indices = bsp_file
            .lump_reader(LumpType::VertNormalIndices)?
            .read_vec(|r| r.read())?;
        let game_lumps: GameLumpHeader = bsp_file.lump_reader(LumpType::GameLump)?.read()?;
        let pack = Packfile::read(bsp_file.lump_reader(LumpType::PakFile)?.into_data())?;

        let static_props = game_lumps
            .find(data)
            .ok_or(ValidationError::NoStaticPropLump)??;
        // Leaf ambient light：HDR 组先读、LDR 组后读，lump 缺失或读取失败都落成空 vec。
        // 组的选择不在这里——prop_ambient_cube 另行按"哪组更长"挑，与光照 lump 的规则不同。
        let leaf_ambient_lighting_hdr = bsp_file
            .lump_reader(LumpType::LeafAmbientLightingHdr)
            .and_then(|mut r| r.read_vec(|r| r.read()))
            .unwrap_or_default();
        let leaf_ambient_lighting = bsp_file
            .lump_reader(LumpType::LeafAmbientLighting)
            .and_then(|mut r| r.read_vec(|r| r.read()))
            .unwrap_or_default();
        let leaf_ambient_indices_hdr = bsp_file
            .lump_reader(LumpType::LeafAmbientIndexHdr)
            .and_then(|mut r| r.read_vec(|r| r.read()))
            .unwrap_or_default();
        let leaf_ambient_indices = bsp_file
            .lump_reader(LumpType::LeafAmbientIndex)
            .and_then(|mut r| r.read_vec(|r| r.read()))
            .unwrap_or_default();

        let bsp = Bsp {
            header: bsp_file.header().clone(),
            entities,
            textures_data,
            textures_info,
            texture_string_tables,
            texture_string_data,
            planes,
            nodes,
            leaves,
            leaf_faces,
            leaf_brushes,
            models,
            brushes,
            brush_sides,
            vertices,
            edges,
            surface_edges,
            faces,
            faces_hdr,
            lighting,
            original_faces,
            vis_data,
            displacements,
            displacement_vertices,
            displacement_triangles,
            vertex_normals,
            vertex_normal_indices,
            static_props,
            leaf_ambient_lighting,
            leaf_ambient_lighting_hdr,
            leaf_ambient_indices,
            leaf_ambient_indices_hdr,
            pack,
        };
        bsp.validate()?;
        Ok(bsp)
    }

    /// prop 静态环境光：查该 prop 采样点的 6 面 ambient cube，返回线性 RGB 的 18 个 float
    /// （face 序 `[+X, -X, +Y, -Y, +Z, -Z]`，每面 3 个分量，见 `data/game.rs` 的 `LeafAmbientSample::cube`）。
    ///
    /// 取值链，任何一步不成立都退回中性灰 `NEUTRAL`：
    /// - `prop_index` 越界 / 该图没有静态道具 → `NEUTRAL`；
    /// - 查询点：`StaticPropLump::flags` 的 `0x2` 位置位时取 `lighting_origin`，否则取 `origin`；
    ///   直接拿这三个 Source 坐标分量，不做坐标旋转；
    /// - LDR / HDR 组选择按**长度比较**：只有 `leaf_ambient_lighting_hdr.len()` **严格大于**
    ///   `leaf_ambient_lighting.len()` 才用 HDR 组，相等或更短都用 LDR 组——与 `Bsp::read` 选光照
    ///   lump 的"HDR 非空即 HDR"不是同一条规则；
    /// - leaf 定位走 **BSP 树遍历**：从 `nodes[0]` 起，`plane.normal · p - plane.dist >= 0` 走
    ///   `children[0]`，否则走 `children[1]`，遇到负 child 取 `!child` 当 leaf 下标；最多循环 256 次，
    ///   用尽仍未落到 leaf 即放弃（按 leaf bounds 线性筛选会命中相邻 leaf，故不这么做）；
    /// - leaf 内多采样点：把样本的 `x`/`y`/`z`（各 0..255）按该 leaf 的 `mins`/`maxs` 线性映射成
    ///   世界位置，取与查询点**距离平方最小**的一条，不做插值；
    /// - 每面 `decode_linear_ambient()`（mantissa × 2^exp，不除 255）后统一乘 `AMBIENT_SCALE`。
    ///
    /// 返回类型是 `Option<[f32; 18]>`，但当前实现**每条路径都返回 `Some`**：
    /// 全 `NEUTRAL` 的 18 个分量就是"没有 ambient 数据"的表示，`None` 从未被构造。
    ///
    /// 索引前提：叶环境光的采样表与区间表都走 `get`，越界只跳过；但树遍历里的
    /// `self.nodes[node_idx]` 与 `self.planes[node.plane_index]` 是**直接下标**，
    /// 依赖 `validate` 已确认节点表非空、且节点引用的平面与子节点都在表内。
    pub fn prop_ambient_cube(&self, prop_index: usize) -> Option<[f32; 18]> {
        // 中性灰兜底：解码域是 mantissa × 2^exp（不除 255），固定常数 0.0109 再乘 AMBIENT_SCALE，
        // 使没有 ambient 数据的 prop 与有数据的 prop 落在同一量级；18 个分量取同一个值。
        const NEUTRAL: [f32; 18] = [AMBIENT_SCALE * 0.0109; 18];
        let Some(prop) = self.static_props.props.props.get(prop_index) else {
            return Some(NEUTRAL);
        };
        let use_lighting_origin = (prop.flags.bits() & 0x2) != 0;
        let lo = prop.lighting_origin;
        let origin = prop.origin;
        let p = if use_lighting_origin {
            [lo.x, lo.y, lo.z]
        } else {
            [origin.x, origin.y, origin.z]
        };
        // 组选择：严格更长才用 HDR（长度相等时归 LDR 组）；两组都空由下面的 is_empty 守卫拦下
        let use_hdr = self.leaf_ambient_lighting_hdr.len() > self.leaf_ambient_lighting.len();
        let (indices, samples) = if use_hdr {
            (&self.leaf_ambient_indices_hdr, &self.leaf_ambient_lighting_hdr)
        } else {
            (&self.leaf_ambient_indices, &self.leaf_ambient_lighting)
        };
        if indices.is_empty() || samples.is_empty() {
            return Some(NEUTRAL);
        }
        // leaf 定位：与 leaf_at 同一套判定（侧面 >= 0 走 children[0]），差别是这里有 256 次上限
        let mut node_idx: i32 = 0;
        let mut leaf_idx: Option<usize> = None;
        for _ in 0..256 {
            let node = &self.nodes[node_idx as usize];
            let plane = &self.planes[node.plane_index as usize];
            let side = plane.normal.x * p[0] + plane.normal.y * p[1] + plane.normal.z * p[2]
                - plane.dist;
            let child = if side >= 0.0 { node.children[0] } else { node.children[1] };
            if child >= 0 {
                node_idx = child;
            } else {
                leaf_idx = Some((!child) as usize);
                break;
            }
        }
        let li = match leaf_idx {
            Some(li) => li,
            None => return Some(NEUTRAL),
        };
        let Some(index) = indices.get(li) else {
            return Some(NEUTRAL);
        };
        if index.ambient_sample_count == 0 {
            return Some(NEUTRAL);
        }
        let Some(leaf) = self.leaves.get(li) else {
            return Some(NEUTRAL);
        };
        // 最近采样点：样本的 0..255 相对坐标按 leaf bounds 展开成世界位置，比距离平方
        let mut best: Option<(f32, usize)> = None;
        for k in 0..index.ambient_sample_count as usize {
            let Some(s) = samples.get(index.first_ambient_sample as usize + k) else {
                continue;
            };
            let rel = [s.x as f32 / 255.0, s.y as f32 / 255.0, s.z as f32 / 255.0];
            let mut d2 = 0.0f32;
            for a in 0..3 {
                let w = leaf.mins[a] as f32 + rel[a] * (leaf.maxs[a] as f32 - leaf.mins[a] as f32);
                let dd = w - p[a];
                d2 += dd * dd;
            }
            if best.map_or(true, |(bd, _)| d2 < bd) {
                best = Some((d2, index.first_ambient_sample as usize + k));
            }
        }
        let Some((_, si)) = best else {
            return Some(NEUTRAL);
        };
        let Some(s) = samples.get(si) else {
            return Some(NEUTRAL);
        };
        let mut out = [0f32; 18];
        for (j, face) in s.cube.iter().enumerate() {
            let v = face.decode_linear_ambient();
            out[j * 3] = v[0] * AMBIENT_SCALE;
            out[j * 3 + 1] = v[1] * AMBIENT_SCALE;
            out[j * 3 + 2] = v[2] * AMBIENT_SCALE;
        }
        Some(out)
    }


    /// 按下标取 leaf 句柄；越界返回 `None`。
    ///
    /// 句柄借用整个 `Bsp`（`Handle::new(self, leaf)`），所以它存活期间 `Bsp` 不能被可变借用。
    pub fn leaf(&self, n: usize) -> Option<Handle<'_, Leaf>> {
        self.leaves.get(n).map(|leaf| Handle::new(self, leaf))
    }

    /// 按下标取平面句柄；越界返回 `None`。
    pub fn plane(&self, n: usize) -> Option<Handle<'_, Plane>> {
        self.planes.get(n).map(|plane| Handle::new(self, plane))
    }

    /// 按下标取面句柄（`FACES`(7) 表，不含 `faces_hdr`）；越界返回 `None`。
    pub fn face(&self, n: usize) -> Option<Handle<'_, Face>> {
        self.faces.get(n).map(|face| Handle::new(self, face))
    }

    /// 按下标取树节点句柄；越界返回 `None`。
    pub fn node(&self, n: usize) -> Option<Handle<'_, Node>> {
        self.nodes.get(n).map(|node| Handle::new(self, node))
    }

    /// 按下标取 displacement 句柄；越界返回 `None`（负数转 `usize` 后同样落空）。
    pub fn displacement(&self, n: usize) -> Option<Handle<'_, DisplacementInfo>> {
        self.displacements
            .get(n)
            .map(|displacement| Handle::new(self, displacement))
    }

    /// 按下标取 displacement 顶点句柄；越界返回 `None`。只被 `Handle<DisplacementInfo>` 使用。
    fn displacement_vertex(&self, n: usize) -> Option<Handle<'_, DisplacementVertex>> {
        self.displacement_vertices
            .get(n)
            .map(|vert| Handle::new(self, vert))
    }

    /// 取根节点（`nodes[0]`）。
    ///
    /// **会 panic**：`nodes` 为空时 `node(0)` 返回 `None` 而这里 `unwrap()`；
    /// `validate` 已把"空节点表"拦在 `Bsp::read` 内，所以解析成功的 `Bsp` 不会走到这一分支。
    pub fn root_node(&self) -> Handle<'_, Node> {
        self.node(0).unwrap()
    }

    /// 迭代全部模型，顺序即 `models` 的顺序（下标 0 是世界模型）。
    pub fn models(&self) -> impl Iterator<Item = Handle<'_, Model>> {
        self.models.iter().map(move |m| Handle::new(self, m))
    }

    /// 迭代全部纹理信息（`textures_info`），不是"某个模型用到的纹理"。
    pub fn textures(&self) -> impl Iterator<Item = Handle<'_, TextureInfo>> {
        self.textures_info.iter().map(move |m| Handle::new(self, m))
    }

    /// 求点所在的 leaf：从根节点起，`dot >= plane.dist` 走 `children[0]`（正面）、否则走
    /// `children[1]`（背面），遇到负 child 取 `!child` 当 leaf 下标。
    ///
    /// `point` 用 Source 坐标，不做旋转。**会 panic**：树走到越界的节点或 leaf 时
    /// `node()` / `leaf()` 落空而这里 `unwrap()`；`validate` 已确认索引都在表内。
    /// 判定与 `prop_ambient_cube` 的树遍历一致，但这里没有循环次数上限。
    pub fn leaf_at(&self, point: Vector) -> Handle<'_, Leaf> {
        let mut current = self.root_node();

        loop {
            let plane = current.plane();
            let dot: f32 = point
                .iter()
                .zip(plane.normal.iter())
                .map(|(a, b)| a * b)
                .sum();

            let [front, back] = current.children;

            let next = if dot < plane.dist { back } else { front };

            if next < 0 {
                return self.leaf((!next) as usize).unwrap();
            } else {
                current = self.node(next as usize).unwrap();
            }
        }
    }

    /// 迭代全部静态道具（`static_props.props.props`），顺序即放置表顺序。
    ///
    /// 该顺序与 `prop_ambient_cube` 的 `prop_index` 对齐——三工程导出层用 `enumerate()` 取下标，
    /// 再把同一序号交给 `prop_ambient_cube` 取环境光。本方法同时被 `validate` 用来检查
    /// `prop_type` 是否落在模型名字典内。
    pub fn static_props(&self) -> impl Iterator<Item = Handle<'_, StaticPropLump>> {
        self.static_props
            .props
            .props
            .iter()
            .map(|lump| Handle::new(self, lump))
    }

    /// 迭代面表。
    ///
    /// 实现读的是 `self.faces`（`FACES`(7)），**不是**同名的 `original_faces` 字段
    /// ——`original_faces` 只有字段与读取流程，本仓没有遍历它的访问器。
    pub fn original_faces(&self) -> impl Iterator<Item = Handle<'_, Face>> {
        self.faces.iter().map(move |face| Handle::new(self, face))
    }

    /// 跨表索引自检，`Bsp::read` 组装完成后调用一次。
    ///
    /// 逐条检查的关系（括号里是 `ReferenceOutOfRange` 的 `source_` / `target` 标签）：
    /// face→displacement、displacement→face、face→surface_edge（取 `first_edge + num_edges - 1`）、
    /// surface_edge→edge、edge→vertex、displacement→displacement（角邻居与边邻居两处）、
    /// face→texture_info、texture_info→texture_data、textures_data→texture_string_tables、
    /// texture_string_tables→texture_string_data（按**字节**长度）、node→plane、node→node、
    /// node→leaf、static prop→模型名、顶点法线索引→顶点法线表。
    ///
    /// 另加两条整体条件：`nodes` 非空（否则 `NoRootNode`）、带 displacement 的面必须正好 4 条边
    /// （否则 `NonSquareDisplacement(num_edges)`）。
    ///
    /// **不覆盖**：`models` 的 face 区间、`leaf_faces` / `leaf_brushes` 的区间、`faces` 的
    /// `plane_num`，以及任何"取一次下标"之外的语义一致性——这些由读取方自行承担。
    fn validate(&self) -> BspResult<()> {
        self.validate_indexes(
            self.faces
                .iter()
                .filter_map(|face| face.displacement_index()),
            &self.displacements,
            "face",
            "displacement",
        )?;
        self.validate_indexes(
            self.displacements
                .iter()
                .map(|displacement| displacement.map_face),
            &self.faces,
            "displacement",
            "face",
        )?;
        self.validate_indexes(
            self.faces
                .iter()
                .map(|face| face.first_edge + face.num_edges as i32 - 1),
            &self.surface_edges,
            "face",
            "surface_edge",
        )?;
        self.validate_indexes(
            self.surface_edges.iter().map(|edge| edge.edge_index()),
            &self.edges,
            "surface_edge",
            "edge",
        )?;
        self.validate_indexes(
            self.edges
                .iter()
                .flat_map(|edge| [edge.start_index, edge.end_index]),
            &self.vertices,
            "edge",
            "vertex",
        )?;
        self.validate_indexes(
            self.displacements
                .iter()
                .flat_map(|displacement| &displacement.corner_neighbours)
                .flat_map(|corner| corner.neighbours()),
            &self.displacements,
            "displacement",
            "displacement",
        )?;
        self.validate_indexes(
            self.displacements
                .iter()
                .flat_map(|displacement| &displacement.edge_neighbours)
                .flat_map(|edge| edge.iter())
                .map(|sub| sub.neighbour_index),
            &self.displacements,
            "displacement",
            "displacement",
        )?;
        self.validate_indexes(
            self.faces.iter().map(|face| face.texture_info),
            &self.textures_info,
            "face",
            "texture_info",
        )?;
        self.validate_indexes(
            self.textures_info
                .iter()
                .map(|texture| texture.texture_data_index),
            &self.textures_data,
            "texture_info",
            "texture_data",
        )?;
        self.validate_indexes(
            self.textures_data
                .iter()
                .map(|texture| texture.name_string_table_id),
            &self.texture_string_tables,
            "textures_data",
            "texture_string_tables",
        )?;
        self.validate_indexes(
            self.texture_string_tables.iter().copied(),
            self.texture_string_data.as_bytes(),
            "texture_string_tables",
            "texture_string_data",
        )?;
        self.validate_indexes(
            self.nodes.iter().map(|node| node.plane_index),
            &self.planes,
            "node",
            "plane",
        )?;
        self.validate_indexes(
            self.nodes
                .iter()
                .flat_map(|node| node.children)
                .filter(|index| *index >= 0),
            &self.nodes,
            "node",
            "node",
        )?;
        self.validate_indexes(
            self.nodes
                .iter()
                .flat_map(|node| node.children)
                .filter_map(|index| (index < 0).then_some(!index)),
            &self.leaves,
            "node",
            "leaf",
        )?;
        self.validate_indexes(
            self.static_props().map(|prop| prop.prop_type),
            &self.static_props.dict.name,
            "static props",
            "static prop models",
        )?;
        self.validate_indexes(
            self.vertex_normal_indices.iter().map(|i| i.index),
            &self.vertex_normals,
            "vertex normal indices",
            "vertex normals",
        )?;

        if self.nodes.is_empty() {
            return Err(ValidationError::NoRootNode.into());
        }

        for face in &self.faces {
            if face.displacement_index().is_some() && face.num_edges != 4 {
                return Err(ValidationError::NonSquareDisplacement(face.num_edges).into());
            }
        }

        Ok(())
    }

    /// 通用查界：取 `indexes` 的**最大值**，转成 `usize` 后在 `list` 里取一次；
    /// 失败即返回 `ValidationError::ReferenceOutOfRange { source_, target, index, size }`。
    ///
    /// 只验最大值，不是逐元素校验：非最大的越界项不会在这里暴露。负数下标在 `try_into()` 阶段
    /// 就失败，所以只要最大值是负数同样报错。空迭代器直接返回 `Ok`——`T` 的具体类型只用于取下标。
    fn validate_indexes<
        'b,
        Index: TryInto<usize> + Into<i64> + Copy + Ord + Default,
        Indexes: Iterator<Item = Index>,
        T: 'b,
    >(
        &'b self,
        indexes: Indexes,
        list: &[T],
        source: &'static str,
        target: &'static str,
    ) -> BspResult<()> {
        let max = match indexes.max() {
            Some(max) => max,
            None => return Ok(()),
        };
        max.try_into()
            .ok()
            .and_then(|index| list.get(index))
            .ok_or_else(|| ValidationError::ReferenceOutOfRange {
                source_: source,
                target,
                index: max.into(),
                size: list.len(),
            })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::Bsp;

    /// 端到端冒烟：从当前工作目录读一个本地 BSP 文件并跑通 `Bsp::read`。
    ///
    /// 默认 `#[ignore]`：该文件不随仓库分发，且用的是相对路径（要求测试时的工作目录里就有它）。
    /// 断言只有"解析不返回 `Err`"，不校验任何字段值。
    #[test]
    #[ignore = "需要本地 koth_bagel_rc2a.bsp（未随仓库分发）"]
    fn tf2_file() {
        use std::fs::read;

        let data = read("koth_bagel_rc2a.bsp").unwrap();

        Bsp::read(&data).unwrap();
    }
}

/// 解 Source 封装的 LZMA 块：头部 12 B（4 B 魔数 `LZMA` + 4 B 解压后长度 + 4 B 压缩流长度）
/// 之后才是 LZMA 流本身。
///
/// `expected_length` 是调用方声明的解压后长度（`BspFile::get_lump` 传目录项 `ident`，
/// `data/game.rs` 传 game lump 的 `length`）。失败条件：头部魔数不符 → `LumpDecompressError`；
/// `data` 短于 `lzma_size + 12` → `UnexpectedCompressedLumpSize`；解压结果长度不等于
/// `expected_length` → `UnexpectedUncompressedLumpSize`——最后这条是权威判据，前面的容量预留只是提示。
///
/// 解压选项固定为：`unpacked_size` 取头部声明的长度、`allow_incomplete = false`（流被截断即失败）、
/// 不限内存。输出缓冲预留 `min(expected_length + 8, 8 MiB)`：`+8` 对应 `data/game.rs` 解压后追加的
/// 8 字节填充，8 MiB 上限用于挡住坏头声明的超大长度。
fn lzma_decompress_with_header(data: &[u8], expected_length: usize) -> Result<Vec<u8>, BspError> {
    // 预留量见上方说明；最终长度由函数末尾的 output.len() 判定
    let mut output: Vec<u8> = Vec::with_capacity(min(expected_length + 8, 8 * 1024 * 1024));
    let mut cursor = Cursor::new(data);
    if b"LZMA" != &<[u8; 4]>::read(&mut cursor)? {
        return Err(BspError::LumpDecompressError(
            lzma_rs::error::Error::LzmaError("Invalid lzma header".into()),
        ));
    }
    let actual_size: u32 = cursor.read_le()?;
    let lzma_size: u32 = cursor.read_le()?;
    if data.len() < lzma_size as usize + 12 {
        return Err(BspError::UnexpectedCompressedLumpSize {
            got: data.len() as u32,
            expected: lzma_size,
        });
    }
    lzma_rs::lzma_decompress_with_options(
        &mut cursor,
        &mut output,
        &Options {
            unpacked_size: UnpackedSize::UseProvided(Some(actual_size as u64)),
            allow_incomplete: false,
            memlimit: None,
        },
    )
    .map_err(BspError::LumpDecompressError)?;
    if output.len() != expected_length {
        return Err(BspError::UnexpectedUncompressedLumpSize {
            got: output.len() as u32,
            expected: expected_length as u32,
        });
    }
    Ok(output)
}
