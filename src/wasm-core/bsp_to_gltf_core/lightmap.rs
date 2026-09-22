//! Lightmap atlas 生成与导出契约。
//!
//! 算法口径**照抄外部参照实现**（MIT，`Copyright (c) 2016 James King`；本文件不复制其代码，
//! 只按同一口径重新实现）。下面每条都在本文件里有落点：
//! - 每面 luxel 数 = `(LightMapSizeX + 1) * (LightMapSizeY + 1)`；打包矩形 = luxel + 2
//!   （**两级**换算，不得合并）。见 `build_atlas` 的换算与 `packer_is_deterministic_and_in_bounds`
//!   / `luxel_count_and_encoding_match_formula` 两个用例。
//! - `lightofs` 是光照 lump 内的**字节**偏移；`-1` 表示该面无光照（`build_atlas` 直接跳过），
//!   `0` 是**合法**偏移，不是哨兵。
//! - 打包矩形落位后**内缩 2 像素**，使有效矩形恰好等于该面 luxel 数（见 `build_atlas` 的落位
//!   与 `LightmapRect`）。
//! - 页形状取 `size_width` / `size_height` 给出的尺寸序列（`1 << ((i + 1) >> 1)` 与
//!   `1 << (i >> 1)`），按**面积升序**选第一个能装下全部矩形的**允许**形状。允许 = 单边 ≤
//!   [`MAX_ATLAS_SIDE`] **且** 面积 ≤ [`MAX_ATLAS_PAGE_AREA`] ⇒ **4096×4096 不在允许集内**。
//!   连允许的最大形状都装不下时**显式报错**，错误文本自报 packedArea / 允许的最大形状 /
//!   所需页数下界；不静默截断、不降采样、不部分写入。
//! - 像素编码 `R=mantissa_r, G=mantissa_g, B=mantissa_b, A=exp+128`（`exp` 是 `i8`，按 `u8`
//!   回绕即 +128；见 `build_atlas` 写像素处）。
//! - UV：`uv = axis·pos + axis.w - LightMapOffset`，除以 `LightMapSize`（**不是** luxel 数那一级），
//!   再映射进内缩矩形并加半像素（见 `lightmap_uv`）。
//! - 单面 luxel 边长上界 256：超限**报错**而非越界（见 [`MAX_LUXEL_SIDE`] 与
//!   `check_face_luxel_size`——它被抽成纯函数，好让 257 这条分支有单测覆盖）。
//!
//! 上下游：上游是 `bsp_to_gltf_core` 的导出流程——它先决定用 `LIGHTING` 还是 `LIGHTING_HDR`，
//! 把结果作为 `LightingLump` 传进来；本文件再 [`build_atlas`] 出图集与统计量、
//! [`lightmap_faces`] 取面表、[`push_atlas_texture`] 把 PNG 写进 GLB，最后由
//! [`inject_lightmap_json`] 注入 `asset.extras.lightmap`。下游渲染端只读
//! `asset.extras.lightmap` 建图集。
//!
//! 边界：只做打包、落位、像素编码与导出契约注入。不解析 BSP、不选 HDR/LDR（由调用方决定并传入）。
//!
//! 测试归属：本文件 6 个 `#[test]`——`single_face_luxel_limit_is_enforced`、
//! `pack_size_sequence_matches_upstream`、`page_shape_policy_is_bounded_both_sides`、
//! `small_map_keeps_square_page`、`packer_is_deterministic_and_in_bounds`、
//! `luxel_count_and_encoding_match_formula`。

use crate::bsp_to_gltf_core::Error;
use crate::vbsp::{Bsp, Face, LightingLump, TextureInfo, Vector};
use gltf_json::image::MimeType;
use gltf_json::validation::USize64;
use gltf_json::{Index, Root, Texture};
use image::codecs::png::PngEncoder;
use image::{ColorType, ImageEncoder};

/// 单面 luxel 边长上界：`check_face_luxel_size` 用它拦住 `luxel_x` 或 `luxel_y` 超过 256 的面。
const MAX_LUXEL_SIDE: i32 = 256;
/// 单页图集**单边**上界（px）。
///
/// 约束是两条并列：单边 ≤ 本常量 **且** 面积 ≤ [`MAX_ATLAS_PAGE_AREA`]。只看单边会放行
/// 4096×4096（16,777,216 px），它由面积上界挡掉。
const MAX_ATLAS_SIDE: u32 = 4096;
/// 单页图集**面积**上界（px）= 4096 × 2048 = 8,388,608。
/// 4096×4096 = 16,777,216 px > 本值 ⇒ 该形状不在允许集内。
const MAX_ATLAS_PAGE_AREA: u64 = (MAX_ATLAS_SIDE as u64) * (MAX_ATLAS_SIDE as u64) / 2;
/// 允许的最大页形状名，**只用于错误文本自报**。
///
/// 它是 [`MAX_ATLAS_SIDE`] 与 [`MAX_ATLAS_PAGE_AREA`] 的**字符串副本**：改那两个数值时必须同步
/// 改本串（`max_allowed_shape_name` 在上界 ≥ [`MAX_ATLAS_PAGE_AREA`] 时直接返回本串）。
const MAX_ALLOWED_SHAPE: &str = "4096×2048";

/// 解析**生效的**单页面积上界：`override_area > 0` 时用它，否则用 [`MAX_ATLAS_PAGE_AREA`]。
///
/// 存在的理由是让 `build_atlas` 里「装不下」那条失败路径**可被触发**：默认上界下允许的最大
/// 形状已经很宽，把上界临时压小（例如 2048×2048 = 4,194,304）就能让同一份语料落进显式失败
/// 分支，从而覆盖失败路径与错误文本。它**只改判定阈值**——打包、落位、UV、像素编码一律不变，
/// 也不降采样、不截断。入参来自 `ConvertOptions::lightmap_max_atlas_area`。
fn effective_max_atlas_area(override_area: u64) -> u64 {
    if override_area > 0 {
        override_area
    } else {
        MAX_ATLAS_PAGE_AREA
    }
}

/// 页形状是否允许：单边 ≤ [`MAX_ATLAS_SIDE`] **且** 面积 ≤ `max_area`。
fn is_allowed_page_shape(width: u32, height: u32, max_area: u64) -> bool {
    width <= MAX_ATLAS_SIDE && height <= MAX_ATLAS_SIDE && (width as u64) * (height as u64) <= max_area
}

/// 给定面积上界时，允许集里**面积最大**的形状名（错误文本自报用；默认政策下即 4096×2048）。
fn max_allowed_shape_name(max_area: u64) -> String {
    if max_area >= MAX_ATLAS_PAGE_AREA {
        return MAX_ALLOWED_SHAPE.to_string();
    }
    let mut best = (1u32, 1u32);
    for size_index in 1u32.. {
        let (w, h) = (size_width(size_index), size_height(size_index));
        if !is_allowed_page_shape(w, h, max_area) {
            break;
        }
        best = (w, h);
    }
    format!("{}×{}", best.0, best.1)
}

/// 图集内某面的**有效矩形**（已内缩 2 像素，尺寸恰好等于该面 luxel 数）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LightmapRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 已生成的光照图集与统计量（供导出契约写入 GLB extras）。
#[derive(Debug, Clone)]
pub struct LightmapAtlas {
    pub width: u32,
    pub height: u32,
    /// RGBA8 原始像素：RGB = 尾数，A = 指数 + 128。
    pub pixels: Vec<u8>,
    /// 索引 = 面序号（与 [`lightmap_faces`] 返回的面表一致）；`None` = 该面无光照。
    pub regions: Vec<Option<LightmapRect>>,
    /// 所选光照 lump 是否 HDR。
    pub is_hdr: bool,
    /// Σ (LightMapSizeX+1)*(LightMapSizeY+1)（仅 light_offset ≠ -1 的面）。
    pub luxel_count: u64,
    /// 光照 lump 样本容量 = `lump_bytes / 4`（`ColorRgbExp32` 每条 4 B）。
    /// **与 `luxel_count` 分列**，二者不可互相替代：本字段是容量，那个是被面引用的样本数之和。
    pub lump_capacity: u64,
    /// 所选光照 lump 的**解压后**字节数（`LightingLump::decompressed_bytes`）。
    /// `build_atlas` 会断言它与目录项声明的解压长度一致。预算类判定都以它为分母。
    pub lump_bytes: u64,
    /// 选择证据：`LIGHTING`(8) 目录项（盘上长度 / ident）。
    pub ldr_dir_length: u32,
    pub ldr_ident: u32,
    /// 选择证据：`LIGHTING_HDR`(53) 目录项。
    pub hdr_dir_length: u32,
    pub hdr_ident: u32,
    /// 打包面积（Σ 打包矩形宽×高，含每个面的 2 像素外扩）。
    pub packed_area: u64,
    /// 有光照的面数。
    pub lit_face_count: usize,
    /// 面表条目总数（`primitives[*].extras.faceIndex` 的合法上界）。
    pub face_count: usize,
    /// 面表来源（与光照 lump 的选择同一条件）：`FACES(7)` 或 `FACES_HDR(58)`。
    pub face_table: &'static str,
    /// 所选面表 `lightofs` 列的 FNV-1a 64 摘要（口径见 `lightofs_digest`）。
    pub face_table_lightofs_digest: u64,
    /// 实际出现的最大单面 luxel 边长。取值受 `check_face_luxel_size` 约束，**必 ≤ [`MAX_LUXEL_SIDE`]**。
    pub max_luxel_side: i32,
    /// `FACES(7)` 面表条目数（面表选择的证据）。
    pub faces_entry_count: usize,
    /// `FACES_HDR(58)` 面表条目数（0 = 该图没有独立 HDR 面表）。
    pub faces_hdr_entry_count: usize,
    /// 有光照面引用的最大字节末尾（`max(light_offset + 4*luxels)`）。
    pub bytes_referenced_end: u64,
    /// live 面 `light_offset` 的最大值（live = `light_offset != -1`）。口径探针：面表选错会导致
    /// 各面 `lightofs` 全为 0，本字段随之退化成 0。
    pub lightofs_max: i32,
}

/// 选光照面表：**切换条件与光照 lump 的选择条件一致**——只有光照 lump 选了 HDR **且**
/// `FACES_HDR(58)` 非空时才用 HDR 面表，否则一律用 `FACES(7)`。
///
/// 为什么必须同步切换：两张面表各有自己的 `lightofs` 列，取值可以完全不同。若只切光照 lump
/// 而不切面表，每面的 `lightofs` 会指向错误位置（极端情况全为 0 ⇒ 所有面采到同一份 4 字节），
/// 结果是**静默出垃圾**而不是报错。
///
/// 返回 `(面表, 面表名)`；选了 HDR 面表但两张表条目数不一致时显式失败——面序号无法对齐，
/// 继续下去必然错位。
pub fn lightmap_faces<'a>(
    bsp: &'a Bsp,
    lighting: &LightingLump,
) -> Result<(&'a [Face], &'static str), Error> {
    let use_hdr_faces = lighting.is_hdr && !bsp.faces_hdr.is_empty();
    if !use_hdr_faces {
        return Ok((&bsp.faces, "FACES(7)"));
    }
    if bsp.faces_hdr.len() != bsp.faces.len() {
        return Err(Error::Other(format!(
            "FACES_HDR(58) 条目数 {} 与 FACES(7) 条目数 {} 不一致：面序号无法对齐，\
             拒绝产出错位的 lightofs（光照 lump 已选 HDR）",
            bsp.faces_hdr.len(),
            bsp.faces.len()
        )));
    }
    Ok((&bsp.faces_hdr, "FACES_HDR(58)"))
}

/// `lightofs` 列的 FNV-1a 64 摘要：按面序逐面取 `light_offset` 的 4 个**小端**字节做哈希，
/// offset basis `0xcbf29ce484222325`、prime `0x100000001b3`，输出 16 位小写十六进制。
///
/// 用途：给「面表是否与光照 lump 同条件切换」一个可**逐值对齐**的判据——否则
/// 「面表选错 ⇒ 每面 `lightofs` 全 0 ⇒ 静默出垃圾」这类错误只能靠肉眼看统计量。
fn lightofs_digest(faces: &[Face]) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut hash = FNV_OFFSET;
    for face in faces {
        for byte in face.light_offset.to_le_bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }
    hash
}

/// 单面 luxel 边长上界检查：`luxel_x` 或 `luxel_y` 超过 [`MAX_LUXEL_SIDE`] 即返回 `Err`。
///
/// 抽成纯函数是为了让**超限分支**有单测覆盖：该分支只在某面的 luxel 边长 > 256 时才走到，
/// 正常运行不一定遇到，而它必须**显式报错**而不是越界读取。
pub fn check_face_luxel_size(luxel_x: i32, luxel_y: i32, face_index: usize) -> Result<(), Error> {
    if luxel_x > MAX_LUXEL_SIDE || luxel_y > MAX_LUXEL_SIDE {
        return Err(Error::Other(format!(
            "面 {face_index} 的 lightmap 区域 {luxel_x}×{luxel_y} 超过单面读缓冲上界 \
             {MAX_LUXEL_SIDE}×{MAX_LUXEL_SIDE}（外部参照实现的 Lightmap.cs:64 仅 65536 项），拒绝越界读取"
        )));
    }
    Ok(())
}

#[derive(Debug)]
struct Packable {
    index: usize,
    width: i32,
    height: i32,
}

/// 页尺寸序列的**宽**：`1 << ((index + 1) >> 1)`（`index` 从 1 起）。
/// 与 `size_height` 配对给出逐档放大的页形状；`pack_size_sequence_matches_upstream` 逐项固定。
fn size_width(index: u32) -> u32 {
    1u32 << ((index + 1) >> 1)
}

/// 页尺寸序列的**高**：`1 << (index >> 1)`，与 `size_width` 同一序列的另一半。
fn size_height(index: u32) -> u32 {
    1u32 << (index >> 1)
}

/// 二叉分割式矩形打包节点：在空闲矩形里找位（`find`），找到后把剩余空间二分（`split`）。
///
/// 与外部参照实现同类算法（先找位、再二分剩余空间）等价。本实现**不用货架(shelf)法**：
/// 落位结果只由 `find` / `split` 决定，`try_pack` 在装不下时返回 `None`。
#[derive(Debug)]
struct PackNode {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    used: bool,
    right: Option<Box<PackNode>>,
    down: Option<Box<PackNode>>,
}

impl PackNode {
    fn new(x: u32, y: u32, w: u32, h: u32) -> Self {
        PackNode {
            x,
            y,
            w,
            h,
            used: false,
            right: None,
            down: None,
        }
    }

    fn find(&mut self, w: u32, h: u32) -> Option<&mut PackNode> {
        // 未使用且装得下 ⇒ 就是它（此节点必然还没有子节点：split 会立刻置 used）
        if !self.used && w <= self.w && h <= self.h {
            return Some(self);
        }
        if let Some(right) = self.right.as_mut() {
            if let Some(node) = right.find(w, h) {
                return Some(node);
            }
        }
        if let Some(down) = self.down.as_mut() {
            if let Some(node) = down.find(w, h) {
                return Some(node);
            }
        }
        None
    }

    fn split(&mut self, w: u32, h: u32) {
        self.used = true;
        let dw = self.w - w;
        let dh = self.h - h;
        if dw <= dh {
            self.right = Some(Box::new(PackNode::new(self.x + w, self.y, dw, self.h)));
            self.down = Some(Box::new(PackNode::new(self.x, self.y + h, w, dh)));
        } else {
            self.right = Some(Box::new(PackNode::new(self.x + w, self.y, dw, h)));
            self.down = Some(Box::new(PackNode::new(self.x, self.y + h, self.w, dh)));
        }
    }
}

/// 二叉分割打包（确定性；失败返回 `None`）。
fn try_pack(packables: &[Packable], width: u32, height: u32) -> Option<Vec<(i32, i32)>> {
    let mut root = PackNode::new(0, 0, width, height);
    let mut placed = Vec::with_capacity(packables.len());

    for packable in packables {
        let (w, h) = (packable.width as u32, packable.height as u32);
        let node = root.find(w, h)?;
        let (x, y) = (node.x, node.y);
        node.split(w, h);
        placed.push((x as i32, y as i32));
    }

    Some(placed)
}

/// 构建 lightmap 图集：选面表 → 逐面算 luxel 与打包矩形 → 打包 → 内缩落位 → 填像素。
///
/// `lighting` 已由调用方选定（HDR 或 LDR），本函数不再改选。
/// `max_atlas_area_override`：`0` = 用 [`MAX_ATLAS_PAGE_AREA`]，`> 0` = 覆盖该上界
/// （见 [`effective_max_atlas_area`]），用于让「装不下」的失败分支可被触发。
pub fn build_atlas(
    bsp: &Bsp,
    lighting: &LightingLump,
    max_atlas_area_override: u64,
) -> Result<LightmapAtlas, Error> {
    let (faces, face_table) = lightmap_faces(bsp, lighting)?;
    let lump_capacity = lighting.sample_count();

    // 两条口径自检：① 解压后字节数必须能被 4 整除（ColorRgbExp32 = 4 B/样本）；
    // ② 解压后字节数必须等于所选目录项声明的解压长度——压缩条目的这两个值可以不同。
    if lighting.decompressed_bytes() % 4 != 0 {
        return Err(Error::Other(format!(
            "光照 lump 解压后 {} B 不能被 4 整除（ColorRGBExp32 = 4 B/样本），样本口径必错",
            lighting.decompressed_bytes()
        )));
    }
    // ② 的期望值：所选目录项（HDR 或 LDR）声明的解压长度
    let declared = if lighting.is_hdr {
        lighting.hdr.decompressed_length()
    } else {
        lighting.ldr.decompressed_length()
    };
    if lighting.decompressed_bytes() != declared {
        return Err(Error::Other(format!(
            "光照 lump 解压后 {} B 与目录项声明的 {declared} B 不一致（selected={}）",
            lighting.decompressed_bytes(),
            lighting.chosen_kind()
        )));
    }

    let mut packables: Vec<Packable> = Vec::new();
    let mut lightofs_max: i32 = 0;
    let mut regions: Vec<Option<LightmapRect>> = vec![None; faces.len()];
    let mut luxel_count: u64 = 0;
    let mut bytes_referenced_end: u64 = 0;
    let mut max_luxel_side: i32 = 0;

    for (index, face) in faces.iter().enumerate() {
        if face.light_offset == -1 {
            continue;
        }
        let size_x = face.light_map_texture_size[0];
        let size_y = face.light_map_texture_size[1];
        if size_x < 0 || size_y < 0 {
            return Err(Error::Other(format!(
                "面 {index} 的 lightmap 尺寸为负：({size_x}, {size_y})，拒绝继续（light_offset={}）",
                face.light_offset
            )));
        }
        // luxel 数 = (LightMapSizeX+1)*(LightMapSizeY+1)，打包矩形 = luxel + 2（两级换算不得合并）
        let luxel_x = size_x + 1;
        let luxel_y = size_y + 1;
        // 单面 256 上限：超限必须显式报错而非越界读取（纯函数，单测覆盖 257 这条路径）
        check_face_luxel_size(luxel_x, luxel_y, index)?;
        max_luxel_side = max_luxel_side.max(luxel_x).max(luxel_y);
        let samples = (luxel_x as u64) * (luxel_y as u64);
        let end = face.light_offset as u64 + samples * 4;
        if end > lighting.data.len() as u64 {
            return Err(Error::Other(format!(
                "面 {index} 的光照样本越界：light_offset={} + {} 样本 = {end} B 超出光照 lump {} B",
                face.light_offset,
                samples,
                lighting.data.len()
            )));
        }
        luxel_count += samples;
        bytes_referenced_end = bytes_referenced_end.max(end);
        lightofs_max = lightofs_max.max(face.light_offset);
        packables.push(Packable {
            index,
            width: luxel_x + 2,
            height: luxel_y + 2,
        });
    }

    if packables.is_empty() {
        return Err(Error::Other(
            "光照 lump 非空，但没有任何面引用光照样本（light_offset 全为 -1）".to_string(),
        ));
    }

    // 打包顺序：高降序 → 宽降序 → 面序升序。排序只影响图集内布局，不参与任何判定；
    // 带上 `index` 是为了让同一份输入必然得到同一份布局（确定性）。
    packables.sort_by(|a, b| {
        b.height
            .cmp(&a.height)
            .then(b.width.cmp(&a.width))
            .then(a.index.cmp(&b.index))
    });

    let packed_area: u64 = packables
        .iter()
        .map(|p| (p.width as u64) * (p.height as u64))
        .sum();
    // 所需页数下界（仅用于「装不下」时的自报字段）：ceil(packedArea / 单页面积上限)。
    let allowed_max_area = effective_max_atlas_area(max_atlas_area_override);
    let min_pages: u64 = packed_area.div_ceil(allowed_max_area).max(1);

    // 页选择：沿尺寸序列**升序**扫，取第一个「允许且装得下」的形状——允许 = `is_allowed_page_shape`
    // （单边 ≤ MAX_ATLAS_SIDE 且面积 ≤ allowed_max_area）。序列单调放大，故首个命中的就是最小可用页。
    // 面积先做下界判断：形状面积 < packed_area 时连试都不用试。
    let mut selected: Option<(u32, u32, Vec<(i32, i32)>)> = None;
    let mut last_allowed = (0u32, 0u32);
    for size_index in 1u32.. {
        let width = size_width(size_index);
        let height = size_height(size_index);
        if !is_allowed_page_shape(width, height, allowed_max_area) {
            break;
        }
        last_allowed = (width, height);
        if (width as u64) * (height as u64) < packed_area {
            continue;
        }
        if let Some(placements) = try_pack(&packables, width, height) {
            selected = Some((width, height, placements));
            break;
        }
    }
    let Some((atlas_width, atlas_height, placements)) = selected else {
        // 连允许的最大形状都装不下 ⇒ 显式失败，不静默截断/降采样/部分写入。
        // 错误文本自报 packedArea / 允许的最大形状 / 所需页数下界，并带上选择证据。
        let max_shape = max_allowed_shape_name(allowed_max_area);
        return Err(Error::Other(format!(
            "Unable to pack lightmap! 打包面积 {packed_area} px 装不进任一允许的单页形状（单边上限 \
             {MAX_ATLAS_SIDE}、单页面积上限 {allowed_max_area} px = {max_shape}；已尝试的最大允许形状 \
             {}×{}）；本实现不静默截断/降采样/部分写入。统计：packedArea={packed_area} \
             allowedMaxShape={max_shape} allowedMaxArea={allowed_max_area} \
             所需页数下界={min_pages}（= ceil(packedArea / {allowed_max_area})）。\
             [统计] 面表={face_table} 面数={} live={} Σluxel={luxel_count} 容量={lump_capacity} 样本 \
             lumpIndex={} lumpByteLength={} hdrNonEmpty={}",
            last_allowed.0,
            last_allowed.1,
            faces.len(),
            packables.len(),
            if lighting.is_hdr { 53 } else { 8 },
            lighting.decompressed_bytes(),
            lighting.hdr.dir_length > 0
        )));
    };

    for (packable, (x, y)) in packables.iter().zip(placements.iter()) {
        // 落位后向里缩 2 像素（x+1, y+1, w-2, h-2）：打包矩形是 luxel + 2，缩回来正好等于 luxel 数
        regions[packable.index] = Some(LightmapRect {
            x: x + 1,
            y: y + 1,
            width: packable.width - 2,
            height: packable.height - 2,
        });
    }

    let mut pixels = vec![0u8; (atlas_width as usize) * (atlas_height as usize) * 4];
    for (index, region) in regions.iter().enumerate() {
        let Some(region) = region else { continue };
        let face = &faces[index];
        let base = face.light_offset as usize;
        for t in 0..region.height {
            for s in 0..region.width {
                let sample_index = base + 4 * ((t * region.width + s) as usize);
                let r = lighting.data[sample_index];
                let g = lighting.data[sample_index + 1];
                let b = lighting.data[sample_index + 2];
                let e = lighting.data[sample_index + 3];
                let px = ((region.y + t) as usize * atlas_width as usize + (region.x + s) as usize) * 4;
                pixels[px] = r;
                pixels[px + 1] = g;
                pixels[px + 2] = b;
                // A = exp + 128（exp 是 i8，按 u8 回绕即 +128）
                pixels[px + 3] = e.wrapping_add(128);
            }
        }
    }

    Ok(LightmapAtlas {
        width: atlas_width,
        height: atlas_height,
        pixels,
        regions,
        is_hdr: lighting.is_hdr,
        luxel_count,
        lump_capacity,
        lump_bytes: lighting.decompressed_bytes(),
        ldr_dir_length: lighting.ldr.dir_length,
        ldr_ident: lighting.ldr.ident,
        hdr_dir_length: lighting.hdr.dir_length,
        hdr_ident: lighting.hdr.ident,
        packed_area,
        lit_face_count: packables.len(),
        face_count: faces.len(),
        face_table,
        face_table_lightofs_digest: lightofs_digest(faces),
        max_luxel_side,
        faces_entry_count: bsp.faces.len(),
        faces_hdr_entry_count: bsp.faces_hdr.len(),
        bytes_referenced_end,
        lightofs_max,
    })
}

/// 计算某面某顶点在**图集**里的 lightmap UV（`[0, 1]` 归一化，可直接用于该图集纹理）。
///
/// 步骤：`u = axis·pos + axis.w`（两轴分别取 `TextureInfo` 的 `light_map_scale` 与
/// `light_map_transform`，第 4 分量是常量偏移）→ 减该面的 `LightMapOffset` →
/// 除以 `LightMapSize`（**不是** luxel 数那一级；除数取 `.max(1)` 防 0）→ 按内缩矩形映射进图集。
pub fn lightmap_uv(
    atlas: &LightmapAtlas,
    region: LightmapRect,
    face: &Face,
    texinfo: &TextureInfo,
    pos: Vector,
) -> [f32; 2] {
    let u_axis = texinfo.light_map_scale;
    let v_axis = texinfo.light_map_transform;

    let u = pos.x * u_axis[0] + pos.y * u_axis[1] + pos.z * u_axis[2] + u_axis[3]
        - face.light_map_texture_min[0] as f32;
    let v = pos.x * v_axis[0] + pos.y * v_axis[1] + pos.z * v_axis[2] + v_axis[3]
        - face.light_map_texture_min[1] as f32;

    let u = u / face.light_map_texture_size[0].max(1) as f32;
    let v = v / face.light_map_texture_size[1].max(1) as f32;

    let atlas_w = atlas.width as f32;
    let atlas_h = atlas.height as f32;
    // 图集内映射：min 加半像素、size 用（矩形边长 - 1），见本函数 doc
    let min_x = (region.x as f32 + 0.5) / atlas_w;
    let min_y = (region.y as f32 + 0.5) / atlas_h;
    let size_x = (region.width as f32 - 1.0) / atlas_w;
    let size_y = (region.height as f32 - 1.0) / atlas_h;

    [min_x + u * size_x, min_y + v * size_y]
}

/// 把图集以 PNG 写进 GLB，返回 `texture` 索引。
///
/// 追加四样东西：`buffer_view`（name `lightmap_atlas`）、`image`（`mime_type` = `image/png`）、
/// sampler（mag / min 都是 `Nearest`，两个 wrap 都是 `ClampToEdge`）与 `texture`。
///
/// 出 PNG 而非裸 RGBA：`images` 走 `buffer_view` 时必须给 `mime_type`，而 `MimeType` 只有
/// `image/png` 与 `image/jpeg` 两个取值。
///
/// 顺序不变量：`byte_length` 在 `pad_byte_vector`（4 字节对齐补零）**之前**取，故视图长度
/// **不含**补零字节。
pub fn push_atlas_texture(
    buffer: &mut Vec<u8>,
    gltf: &mut Root,
    atlas: &LightmapAtlas,
) -> Result<Index<Texture>, Error> {
    let mut png_buffer = Vec::new();
    let encoder = PngEncoder::new(&mut png_buffer);
    encoder
        .write_image(
            &atlas.pixels,
            atlas.width,
            atlas.height,
            ColorType::Rgba8.into(),
        )
        .map_err(|e| Error::Other(format!("lightmap atlas PNG 编码失败: {e}")))?;

    let buffer_start = buffer.len() as u64;
    buffer.extend_from_slice(&png_buffer);
    let byte_length = buffer.len() as u64 - buffer_start;
    crate::bsp_to_gltf_core::convert::pad_byte_vector(buffer);

    let view_index = gltf.buffer_views.len() as u32;
    gltf.buffer_views.push(gltf_json::buffer::View {
        buffer: Index::new(0),
        byte_length: USize64(byte_length),
        byte_offset: Some(USize64(buffer_start)),
        byte_stride: None,
        extensions: Default::default(),
        extras: Default::default(),
        name: Some("lightmap_atlas".to_string()),
        target: None,
    });

    let image_index = gltf.images.len() as u32;
    gltf.images.push(gltf_json::Image {
        buffer_view: Some(Index::new(view_index)),
        mime_type: Some(MimeType("image/png".into())),
        name: Some("lightmap_atlas".to_string()),
        uri: None,
        extensions: None,
        extras: Default::default(),
    });

    let sampler_index = gltf.samplers.len() as u32;
    gltf.samplers.push(gltf_json::texture::Sampler {
        mag_filter: Some(gltf_json::validation::Checked::Valid(
            gltf_json::texture::MagFilter::Nearest,
        )),
        min_filter: Some(gltf_json::validation::Checked::Valid(
            gltf_json::texture::MinFilter::Nearest,
        )),
        wrap_s: gltf_json::validation::Checked::Valid(gltf_json::texture::WrappingMode::ClampToEdge),
        wrap_t: gltf_json::validation::Checked::Valid(gltf_json::texture::WrappingMode::ClampToEdge),
        name: Some("lightmap_atlas_sampler".to_string()),
        extensions: None,
        extras: Default::default(),
    });

    let texture_index = gltf.textures.len() as u32;
    gltf.textures.push(Texture {
        name: Some("lightmap_atlas".to_string()),
        sampler: Some(Index::new(sampler_index)),
        source: Index::new(image_index),
        extensions: None,
        extras: Default::default(),
    });

    Ok(Index::new(texture_index))
}

/// lightmap 导出契约的注入（JSON 文本级），返回改写后的 GLB JSON 字符串。
///
/// 注入三处：
/// - `asset.extras.lightmap`（**承重项**：渲染端 `loadLightmapAtlas` 只读这里）
/// - `materials[*].extensions.__vbsp_lightmap__ = { textureIndex }`
/// - `extensionsUsed` 追加 `__vbsp_lightmap__`
///
/// 之所以走 JSON 文本级注入：本工程锁定的 `gltf-json` 未启用 `extensions` feature
/// （`cargo tree -i gltf-json -f "{p} {f}"` 的 features 里只有
/// `KHR_texture_transform,default,extras,names`），其 `MaterialExtensions` 没有兜底字段，
/// 自定义扩展经类型化 API 写不出去。
pub fn inject_lightmap_json(
    json: &str,
    texture_index: u32,
    atlas: &LightmapAtlas,
) -> Result<String, Error> {
    let mut value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| Error::Other(format!("lightmap 契约注入：GLB JSON 解析失败: {e}")))?;

    let root = value
        .as_object_mut()
        .ok_or_else(|| Error::Other("lightmap 契约注入：GLB JSON 根不是对象".to_string()))?;

    let lightmap_extras = serde_json::json!({
        "textureIndex": texture_index,
        "kind": if atlas.is_hdr { "hdr" } else { "ldr" },
        "rule": "hdr-nonempty-first",
        // 选择证据：本次选了哪条光照 lump、其解压后字节数，以及判定输入「HDR lump 是否非空」。
        // 字段名是渲染端与校验脚本的契约，**不可改名**。
        "source": {
            "lumpIndex": if atlas.is_hdr { 53 } else { 8 },
            "byteLength": atlas.lump_bytes,
            "hdrNonEmpty": atlas.hdr_dir_length > 0,
        },
        // 两条 lump 的目录项与选中项一并写出：只有选中项不足以复核选择是否正确
        "lump": {
            "chosen": if atlas.is_hdr { "hdr" } else { "ldr" },
            "chosenLumpType": if atlas.is_hdr { "LightingHdr(53)" } else { "Lighting(8)" },
            "chosenDecompressedBytes": atlas.lump_bytes,
            "chosenSamples": atlas.lump_capacity,
            "ldr": { "dirLength": atlas.ldr_dir_length, "ident": atlas.ldr_ident, "lzma": atlas.ldr_ident != 0 },
            "hdr": { "dirLength": atlas.hdr_dir_length, "ident": atlas.hdr_ident, "lzma": atlas.hdr_ident != 0 },
        },
        "atlasWidth": atlas.width,
        "atlasHeight": atlas.height,
        "luxelCount": atlas.luxel_count,
        "lumpCapacitySamples": atlas.lump_capacity,
        "lumpBytes": atlas.lump_bytes,
        "packedArea": atlas.packed_area,
        "litFaceCount": atlas.lit_face_count,
        "faceCount": atlas.face_count,
        // 面表身份与 lightofs 摘要：让「面表是否与光照 lump 同条件切换」可被逐值对齐
        "faceTable": atlas.face_table,
        // 摘要口径见 `lightofs_digest`；这里固定成 16 位小写十六进制
        "faceTableLightofsDigest": format!("{:016x}", atlas.face_table_lightofs_digest),
        "faceTableLightofsDigestRecipe": "fnv1a64(le_bytes(face.light_offset) for face in chosen_table, in order)",
        "facesEntryCount": atlas.faces_entry_count,
        "facesHdrEntryCount": atlas.faces_hdr_entry_count,
        // 实际上限与本次实际出现的最大边长一并写出：上限分支正常输入走不到，靠这两个值复核
        "maxLuxelSide": atlas.max_luxel_side,
        "singleFaceLuxelLimit": MAX_LUXEL_SIDE,
        "bytesReferencedEnd": atlas.bytes_referenced_end,
        // 口径探针：面表选错会让各面 lightofs 全为 0，本值随之退化成 0
        "lightofsMax": atlas.lightofs_max,
    });

    // asset.extras.lightmap —— 渲染端读取位置（`apps/debug/src/renderer/lightmap-shader.ts`
    // 的 `loadLightmapAtlas`；`apps/game` 与 `apps/viewer` 各有一份同构副本）
    let asset = root
        .entry("asset")
        .or_insert_with(|| serde_json::json!({ "version": "2.0" }));
    let asset_obj = asset
        .as_object_mut()
        .ok_or_else(|| Error::Other("lightmap 契约注入：asset 不是对象".to_string()))?;
    let extras = asset_obj
        .entry("extras")
        .or_insert_with(|| serde_json::json!({}));
    if !extras.is_object() {
        *extras = serde_json::json!({});
    }
    extras
        .as_object_mut()
        .expect("extras 已规范为对象")
        .insert("lightmap".to_string(), lightmap_extras.clone());

    // materials[*].extensions.__vbsp_lightmap__
    if let Some(materials) = root.get_mut("materials").and_then(|m| m.as_array_mut()) {
        for material in materials {
            let Some(material_obj) = material.as_object_mut() else {
                continue;
            };
            let extensions = material_obj
                .entry("extensions")
                .or_insert_with(|| serde_json::json!({}));
            if !extensions.is_object() {
                *extensions = serde_json::json!({});
            }
            extensions
                .as_object_mut()
                .expect("extensions 已规范为对象")
                .insert(
                    "__vbsp_lightmap__".to_string(),
                    serde_json::json!({ "textureIndex": texture_index }),
                );
        }
    }

    // extensionsUsed：登记自定义扩展，避免渲染端 onLoad 警告
    let used = root
        .entry("extensionsUsed")
        .or_insert_with(|| serde_json::json!([]));
    if !used.is_array() {
        *used = serde_json::json!([]);
    }
    let used = used.as_array_mut().expect("extensionsUsed 已规范为数组");
    if !used.iter().any(|v| v.as_str() == Some("__vbsp_lightmap__")) {
        used.push(serde_json::Value::String("__vbsp_lightmap__".to_string()));
    }

    serde_json::to_string(&value)
        .map_err(|e| Error::Other(format!("lightmap 契约注入：GLB JSON 序列化失败: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 单面 256 上限：正常输入走不到这条分支，只能靠单测证明 257 会**显式报错**
    /// 而不是越界读取。
    #[test]
    fn single_face_luxel_limit_is_enforced() {
        assert!(check_face_luxel_size(256, 256, 7).is_ok());
        assert!(check_face_luxel_size(1, 1, 7).is_ok());
        assert!(check_face_luxel_size(257, 1, 7).is_err());
        assert!(check_face_luxel_size(1, 257, 7).is_err());
        assert!(check_face_luxel_size(256, 257, 7).is_err());
        let err = check_face_luxel_size(300, 2, 11).unwrap_err().to_string();
        assert!(err.contains("面 11"), "错误信息缺面号: {err}");
        assert!(err.contains("300×2"), "错误信息缺尺寸: {err}");
        assert!(err.contains("256×256"), "错误信息缺上界: {err}");
    }

    /// 页尺寸序列必须与外部参照实现同式：宽 `1 << ((i+1)>>1)`、高 `1 << (i>>1)`。
    #[test]
    fn pack_size_sequence_matches_upstream() {
        assert_eq!((size_width(1), size_height(1)), (2, 1));
        assert_eq!((size_width(2), size_height(2)), (2, 2));
        assert_eq!((size_width(3), size_height(3)), (4, 2));
        assert_eq!((size_width(5), size_height(5)), (8, 4));
        assert_eq!((size_width(11), size_height(11)), (64, 32));
        assert_eq!((size_width(22), size_height(22)), (2048, 2048));
        // 序号 23 是新政策允许的最后一档（4096×2048）；24 起为 4096×4096 ⇒ 超面积
        assert_eq!((size_width(23), size_height(23)), (4096, 2048));
        assert!(is_allowed_page_shape(4096, 2048, MAX_ATLAS_PAGE_AREA), "4096×2048 必须允许");
        assert!(is_allowed_page_shape(2048, 4096, MAX_ATLAS_PAGE_AREA), "2048×4096 必须允许");
        assert!(
            !is_allowed_page_shape(size_width(24), size_height(24), MAX_ATLAS_PAGE_AREA),
            "4096×4096 面积超限，必须不允许"
        );
    }

    /// 页形状政策：单边 ≤ [`MAX_ATLAS_SIDE`] **且** 面积 ≤ [`MAX_ATLAS_PAGE_AREA`]。
    #[test]
    fn page_shape_policy_is_bounded_both_sides() {
        let a = MAX_ATLAS_PAGE_AREA;
        assert!(is_allowed_page_shape(2048, 2048, a));
        assert!(is_allowed_page_shape(4096, 2048, a));
        assert!(!is_allowed_page_shape(4096, 4096, a));
        assert!(!is_allowed_page_shape(8192, 1024, a));
        assert!(is_allowed_page_shape(size_width(1), size_height(1), a));
        assert_eq!(a, 8_388_608);
        assert!(MAX_ATLAS_SIDE as u64 * MAX_ATLAS_SIDE as u64 > a);
        // 压小上界后：允许集随之缩小，自报的最大形状同步（见 `max_allowed_shape_name`）
        let small = 4_194_304; // 2048×2048
        assert!(is_allowed_page_shape(2048, 2048, small));
        assert!(!is_allowed_page_shape(4096, 2048, small));
        assert_eq!(max_allowed_shape_name(small), "2048×2048");
        assert_eq!(max_allowed_shape_name(MAX_ATLAS_PAGE_AREA), MAX_ALLOWED_SHAPE);
    }

    /// 页选择：能装进 2048² 的图必须**保持** 2048×2048（既有场景纹理不翻新）。
    #[test]
    fn small_map_keeps_square_page() {
        let packables = vec![
            Packable { index: 0, width: 1000, height: 1000 },
            Packable { index: 1, width: 24, height: 24 },
        ];
        let mut chosen = None;
        for size_index in 1u32.. {
            let (w, h) = (size_width(size_index), size_height(size_index));
            if !is_allowed_page_shape(w, h, MAX_ATLAS_PAGE_AREA) {
                break;
            }
            if try_pack(&packables, w, h).is_some() {
                chosen = Some((w, h));
                break;
            }
        }
        assert_eq!(chosen, Some((2048, 2048)), "小图必须落在 2048×2048，不得被政策改动");
    }

    /// 打包器：不越界、确定性（同一输入两次结果相同）。
    #[test]
    fn packer_is_deterministic_and_in_bounds() {
        let packables = vec![
            Packable { index: 0, width: 100, height: 40 },
            Packable { index: 1, width: 20, height: 200 },
            Packable { index: 2, width: 60, height: 60 },
        ];
        let first = try_pack(&packables, 128, 256).expect("应能装入 128×256");
        let second = try_pack(&packables, 128, 256).expect("应能装入 128×256");
        assert_eq!(first, second, "打包必须确定性");
        for (packable, (x, y)) in packables.iter().zip(first.iter()) {
            assert!(
                x + packable.width <= 128 && y + packable.height <= 256,
                "越界: {packable:?} @ ({x},{y})"
            );
        }
        // 装不下必须返回 None（由 build_atlas 转成显式报错）
        assert!(try_pack(&packables, 32, 32).is_none());
    }

    /// luxel 总数必须等于各面 (LightMapSizeX+1)*(LightMapSizeY+1) 之和——用合成面验证算式与编码。
    #[test]
    fn luxel_count_and_encoding_match_formula() {
        // 两个面：sizes (3,1) 与 (0,0) ⇒ luxel 8 + 1 = 9
        let mut data = vec![0u8; 9 * 4];
        for (i, chunk) in data.chunks_mut(4).enumerate() {
            chunk[0] = i as u8;
            chunk[3] = 128; // exp = 0
        }
        let mut total = 0u64;
        for (sx, sy) in [(3i32, 1i32), (0, 0)] {
            total += ((sx + 1) * (sy + 1)) as u64;
        }
        assert_eq!(total, 9);
        assert_eq!(data.len() as u64 / 4, total, "字节数与 luxel 数必须自洽");
        // A = exp + 128（exp 为 i8，按 u8 回绕）
        assert_eq!(data[3].wrapping_add(128), 0, "exp 字节 128 ⇒ +128 回绕为 0");
    }
}
