// vbsp（crates.io vbsp 0.6.0 本地修复版）：BSP 文件解析模块。
// 保留完整 BSP 解析语义；WASM 场景下部分字段/方法未使用，统一允许 dead_code。
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

/// prop ambient cube 的**唯一量级旋钮**（P3 校准用，decode_linear_ambient 结果统一乘它）。
/// 1.0 = 外部参照实现口径（mantissa × 2^exp，不除 255）的原始值。
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

pub type BspResult<T> = Result<T, BspError>;

#[derive(Debug, Clone)]
pub struct Leaves {
    /// 原始顺序的 leaves（保持 BSP 文件中的索引顺序）。
    ///
    /// 【重要】不能对 leaves 排序，否则 BSP 树 `node.children` 中的 leaf 索引
    /// （按位取反）会指向错误的 leaf，导致 `Bsp::leaf_at` 返回错误结果。
    leaves: Vec<Leaf>,
    /// 按 cluster 排序的 leaves 副本，仅供 `clusters()` 迭代器使用。
    sorted_leaves: Vec<Leaf>,
}

impl Leaves {
    pub fn new(leaves: Vec<Leaf>) -> Self {
        // 构建排序副本供 clusters() 使用，leaves 本身保持原始顺序
        let mut sorted_leaves = leaves.clone();
        sorted_leaves.sort_unstable_by_key(|leaf| leaf.cluster);
        Leaves {
            leaves,
            sorted_leaves,
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = &Leaf> {
        self.into_iter()
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = &mut Leaf> {
        self.into_iter()
    }

    pub fn into_inner(self) -> Vec<Leaf> {
        self.leaves
    }

    pub fn clusters(&self) -> impl Iterator<Item = impl Iterator<Item = &Leaf>> {
        LeafClusters {
            leaves: &self.sorted_leaves,
            index: 0,
        }
    }
}

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

impl From<Vec<Leaf>> for Leaves {
    fn from(other: Vec<Leaf>) -> Self {
        Self::new(other)
    }
}

impl Deref for Leaves {
    type Target = [Leaf];

    fn deref(&self) -> &Self::Target {
        &self.leaves
    }
}

impl IntoIterator for Leaves {
    type Item = Leaf;
    type IntoIter = <Vec<Leaf> as IntoIterator>::IntoIter;

    fn into_iter(self) -> Self::IntoIter {
        self.leaves.into_iter()
    }
}

impl<'a> IntoIterator for &'a Leaves {
    type Item = &'a Leaf;
    type IntoIter = <&'a [Leaf] as IntoIterator>::IntoIter;

    fn into_iter(self) -> Self::IntoIter {
        self.leaves[..].iter()
    }
}

impl<'a> IntoIterator for &'a mut Leaves {
    type Item = &'a mut Leaf;
    type IntoIter = <&'a mut [Leaf] as IntoIterator>::IntoIter;

    fn into_iter(self) -> Self::IntoIter {
        self.leaves.iter_mut()
    }
}

/// 光照 lump 数据（阶段 1）。
///
/// 覆盖 `LIGHTING`(8) 与 `LIGHTING_HDR`(53) 两个 lump，字节为
/// `ColorRGBExp32` 样本序列（4 B/样本：R/G/B 尾数 u8 + 共享指数 i8）。
///
/// 择一规则**照抄外部参照实现的 `Lightmap.cs:55`**：以「HDR lump 是否非空」判定，
/// 而不是比较长度（叶环境光走的是另一套「长度更大」规则，见 `AmbientCubes.cs:44`）。
/// 注意本仓库 `BspFile::get_lump` 已按 lump 目录的 `ident != 0` 自动做 LZMA 解压
/// （`vbsp/bspfile.rs:62-68`），故 `data.len()` 是**解压后**的真长
/// （实测 surf_null.bsp：盘上 6,062,916 B → `data.len() == 22,961,620`）。
#[derive(Debug, Clone)]
pub struct LightingLump {
    /// 是否取自 `LIGHTING_HDR`(53)。
    pub is_hdr: bool,
    /// 解压后的原始字节（每 4 字节一个 `ColorRGBExp32` 样本）。
    pub data: Vec<u8>,
    /// `LIGHTING`(8) 的目录项（选择证据，见 [`LightingLumpSource`]）。
    pub ldr: LightingLumpSource,
    /// `LIGHTING_HDR`(53) 的目录项（选择证据）。
    pub hdr: LightingLumpSource,
}

/// 光照 lump 的目录项证据（**只记元数据，不额外持有另一份缓冲**）。
///
/// 判据来自 `get_lump`（`vbsp/bspfile.rs:62-68`）：`ident == 0` ⇒ 原始字节；
/// `ident != 0` ⇒ Source `LZMA` 封装，且 `ident` 就是**期望解压长度**。
/// 三图实测零反例（surf_null：LZMA 者 `ident == actualSize`、raw 者 `ident == 0`；
/// surf_666 / ze_cursed：非空 lump 全 raw、`ident == 0`）。
#[derive(Debug, Clone, Copy, Default)]
pub struct LightingLumpSource {
    /// lump 目录 `length`（盘上长度；LZMA 时是压缩流长度）。
    pub dir_length: u32,
    /// lump 目录 `ident`（0 = 未压缩；非 0 = LZMA 封装且值等于解压后字节数）。
    pub ident: u32,
}

impl LightingLumpSource {
    /// 解压后字节数：`ident != 0` 时取 `ident`，否则取盘上长度。
    ///
    /// **一切 luxel 预算/缓冲/页数都必须以它（而不是 `dir_length`）为分母**——
    /// surf_null 用盘上长度会低估 3.8 倍（6,062,916 vs 22,961,620）。
    pub fn decompressed_length(&self) -> u64 {
        if self.ident != 0 {
            self.ident as u64
        } else {
            self.dir_length as u64
        }
    }

    pub fn is_compressed(&self) -> bool {
        self.ident != 0
    }

    /// 空 lump（盘上长度 0）。
    pub fn is_empty(&self) -> bool {
        self.dir_length == 0
    }
}

impl LightingLump {
    /// 样本总数（= 解压后字节数 / 4）。要求字节数能被 4 整除，否则口径必错。
    pub fn sample_count(&self) -> u64 {
        (self.data.len() / 4) as u64
    }

    /// 解压后字节数（= 目录项 `ident`，二者必须一致；不一致说明解压口径有问题）。
    pub fn decompressed_bytes(&self) -> u64 {
        self.data.len() as u64
    }

    /// 选择依据的可读描述（写入导出契约，供 t4 做替代断言）。
    pub fn chosen_kind(&self) -> &'static str {
        if self.is_hdr {
            "hdr"
        } else {
            "ldr"
        }
    }
}

// TODO: 将所有已分配对象内联存储以改善缓存利用率
/// 已解析的 BSP 文件
#[derive(Debug)]
#[non_exhaustive]
pub struct Bsp {
    pub header: Header,
    pub entities: Entities,
    pub textures_data: Vec<TextureData>,
    pub textures_info: Vec<TextureInfo>,
    pub texture_string_tables: Vec<i32>,
    pub texture_string_data: String,
    pub planes: Vec<Plane>,
    pub nodes: Vec<Node>,
    pub leaves: Leaves,
    pub leaf_faces: Vec<LeafFace>,
    pub leaf_brushes: Vec<LeafBrush>,
    pub models: Vec<Model>,
    pub brushes: Vec<Brush>,
    pub brush_sides: Vec<BrushSide>,
    pub vertices: Vec<Vertex>,
    pub edges: Vec<Edge>,
    pub surface_edges: Vec<SurfaceEdge>,
    pub faces: Vec<Face>,
    /// `FACES_HDR`(58) 面表；空表示该图没有独立的 HDR 面表。
    ///
    /// 外部参照实现的 `Lightmap.cs:65`：面光照使用 `FacesHdr` 非空则用 FacesHdr，
    /// 否则用 Faces —— 必须与光照 lump 的择一规则同步，否则 `lightofs` 错位。
    pub faces_hdr: Vec<Face>,
    /// 光照 lump（`Lighting`/`LightingHdr`），两者都为空时为 `None`。
    pub lighting: Option<LightingLump>,
    pub original_faces: Vec<Face>,
    pub vis_data: VisData,
    pub displacements: Vec<DisplacementInfo>,
    pub displacement_vertices: Vec<DisplacementVertex>,
    pub displacement_triangles: Vec<DisplacementTriangle>,
    vertex_normals: Vec<VertNormal>,
    vertex_normal_indices: Vec<VertNormalIndex>,
    pub static_props: PropStaticGameLump,
    /// Leaf ambient light cube（LDR/HDR 两组；空 = 该图无此 lump）。
    /// prop 静态光照数据源（对齐外部参照实现的 ambient cube 机制，见 game.rs 注释）。
    pub leaf_ambient_lighting: Vec<LeafAmbientSample>,
    pub leaf_ambient_lighting_hdr: Vec<LeafAmbientSample>,
    pub leaf_ambient_indices: Vec<LeafAmbientIndex>,
    pub leaf_ambient_indices_hdr: Vec<LeafAmbientIndex>,
    pub pack: Packfile,
}

impl Bsp {
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
        // 自适应 leaf 记录大小所需的 BSP 树最大 leaf 索引
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
        // FACES_HDR(58)：HDR 光照的面表（多数 v20 图为空）。读取失败时的处理与 Faces 一致。
        let faces_hdr = bsp_file
            .lump_reader(LumpType::FacesHdr)?
            .read_vec(|r| r.read())?;
        // 光照 lump 择一（外部参照实现 Lightmap.cs:55）：HDR 非空即 HDR，否则 LDR；
        // 两者皆空 → None（该图无烘培光照）。get_lump 已自动 LZMA 解压，故此处拿到的是真长。
        // 同时记录两条 lump 的目录项（dirLength/ident），让「选了哪个」可观测——
        // 本地三图无法判别该规则（surf_666 仅 LDR、ze_cursed 仅 HDR、surf_null 两条同数据）。
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
        // 自检：解压后字节数必须等于目录项声明的解压后长度（ident != 0 时），且能被 4 整除。
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
        // Leaf ambient light（缺失/空 lump → 空 vec；多数图有，老图可能没有）。
        // HDR 优先的择一口径与光照 lump 一致（见 prop_ambient_cube）。
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

    /// prop 静态环境光：返回该 prop 采样点的 6 面 ambient cube（线性 RGB）。
    ///
    /// 对齐外部参照实现：
    /// - 组选择：**HDR/LDR 长度比较**（AmbientCubes.cs:44 的 Hdr.Length > Lighting.Length 规则）才用
    ///   HDR）——实测 surf_666 的 HDR 组全 0、LDR 组 99% 非零，非长度规则会选错组
    /// - 查询点：flags 含 USE_LIGHTING_ORIGIN(0x2) 时用 `lighting_origin`，否则 `origin`（Source 坐标）
    /// - leaf 定位：**BSP 树遍历**（对齐引擎 PointInLeaf / 外部参照实现 getLeafAt，
    ///   线性扫 bounds 会命中错误的相邻 leaf）
    /// - leaf 内多采样点：取距查询点最近的一个（BspModel.ts:141-165 为 nearest）
    /// - 无数据 / 定位失败 / leaf 无采样 → 中性灰兜底（0.214 = 外部参照实现 0x7f 的线性值）
    pub fn prop_ambient_cube(&self, prop_index: usize) -> Option<[f32; 18]> {
        // 中性灰兜底：外部参照实现无 ambient 数据时顶点色写 0x7f（sRGB 0.5），
        // 本工程在 linear 域工作，等价线性值 = ((0.5+0.055)/1.055)^2.4 ≈ 0.2139
        // 中性灰兜底：新口径域（mantissa × 2^exp）下取实测 p50（surf_666 LDR 组
        // p50 = 4.28e-5 × 255 ≈ 0.0109，见 prop-ambient-lighting.md §4.1），
        // 与 AMBIENT_SCALE 联动 —— 保证兜底 prop 与正常 prop 同量级（P3 副判据）。
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
        // 组选择：长度比较（HDR 组更长才用 HDR；两空时走 LDR 分支再由长度守卫拦下）
        let use_hdr = self.leaf_ambient_lighting_hdr.len() > self.leaf_ambient_lighting.len();
        let (indices, samples) = if use_hdr {
            (&self.leaf_ambient_indices_hdr, &self.leaf_ambient_lighting_hdr)
        } else {
            (&self.leaf_ambient_indices, &self.leaf_ambient_lighting)
        };
        if indices.is_empty() || samples.is_empty() {
            return Some(NEUTRAL);
        }
        // leaf 定位：BSP 树遍历（children[0]=正面，children<0 取反为 leaf 索引）
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
        // 最近采样点（leaf 内相对位置 → 世界位置 → 距离平方最小者）
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


    pub fn leaf(&self, n: usize) -> Option<Handle<'_, Leaf>> {
        self.leaves.get(n).map(|leaf| Handle::new(self, leaf))
    }

    pub fn plane(&self, n: usize) -> Option<Handle<'_, Plane>> {
        self.planes.get(n).map(|plane| Handle::new(self, plane))
    }

    pub fn face(&self, n: usize) -> Option<Handle<'_, Face>> {
        self.faces.get(n).map(|face| Handle::new(self, face))
    }

    pub fn node(&self, n: usize) -> Option<Handle<'_, Node>> {
        self.nodes.get(n).map(|node| Handle::new(self, node))
    }

    pub fn displacement(&self, n: usize) -> Option<Handle<'_, DisplacementInfo>> {
        self.displacements
            .get(n)
            .map(|displacement| Handle::new(self, displacement))
    }

    fn displacement_vertex(&self, n: usize) -> Option<Handle<'_, DisplacementVertex>> {
        self.displacement_vertices
            .get(n)
            .map(|vert| Handle::new(self, vert))
    }

    /// 获取 bsp 的根节点
    pub fn root_node(&self) -> Handle<'_, Node> {
        self.node(0).unwrap()
    }

    /// 获取 bsp 中存储的所有模型
    pub fn models(&self) -> impl Iterator<Item = Handle<'_, Model>> {
        self.models.iter().map(move |m| Handle::new(self, m))
    }

    /// 获取 bsp 中存储的所有模型
    pub fn textures(&self) -> impl Iterator<Item = Handle<'_, TextureInfo>> {
        self.textures_info.iter().map(move |m| Handle::new(self, m))
    }

    /// 查找指定位置所在 leaf
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

    pub fn static_props(&self) -> impl Iterator<Item = Handle<'_, StaticPropLump>> {
        self.static_props
            .props
            .props
            .iter()
            .map(|lump| Handle::new(self, lump))
    }

    /// 获取 bsp 中存储的所有面
    pub fn original_faces(&self) -> impl Iterator<Item = Handle<'_, Face>> {
        self.faces.iter().map(move |face| Handle::new(self, face))
    }

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

    #[test]
    #[ignore = "需要本地 koth_bagel_rc2a.bsp（未随仓库分发）"]
    fn tf2_file() {
        use std::fs::read;

        let data = read("koth_bagel_rc2a.bsp").unwrap();

        Bsp::read(&data).unwrap();
    }
}

/// 带 Source 头部的 LZMA 解压
fn lzma_decompress_with_header(data: &[u8], expected_length: usize) -> Result<Vec<u8>, BspError> {
    // 多留 8 字节：game lumps 需要一些填充
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
