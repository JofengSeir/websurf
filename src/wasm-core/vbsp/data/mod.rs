//! BSP 各 lump 的记录类型、两个手写 `BinRead` 与少量派生计算（wasm-core 的 BSP 数据结构层）。
//!
//! 上游：`vbsp/reader.rs` 的 `LumpReader::read` / `read_vec` 按 `size_of::<T>()` 切段后逐条
//! `BinRead` 出本文件的类型；`vbsp/bspfile.rs` 的 `BspFile::new` 读出 `Directories`（lump 目录）。
//! 组装点：`vbsp/mod.rs` 的 `Bsp::read` —— 每个 lump 对应 `Bsp` 的一个字段。
//! 下游：`vbsp/handle/mod.rs` 的 `Handle` 访问器（面顶点链、位移邻接、纹理 UV、PVS 可见集）、
//! `bsp_to_gltf_core`（几何 / 材质 / lightmap）、`mosaic/manifest.rs`，以及三个工程
//! `crates/wasm` 的导出层（`parse_pvs_data`、`export_visleaf_pvs`、brush 凸包导出等）。
//!
//! 职责：
//! - lump 目录：`Directories` / `LumpEntry` / `Header`；
//! - 记录类型：纹理三件套、几何链、BSP 树、`Model` / `Brush` / `BrushSide` / `Plane`、
//!   可视图、位移相关、顶点法线；
//! - 两个手写 `BinRead`：`FixedString`（定长 NUL 结尾串）与 `DisplacementNeighbour`（可缺子邻居）；
//! - 派生访问器：`SurfaceEdge::edge_index` / `direction`、`Face::displacement_index`、
//!   `Brush::is_visible`、`DisplacementInfo::vertex_count` / `triangle_count`、`Vector` 的运算符、
//!   `Angles::as_quaternion` 与三个 `as_prop_placement`；
//! - PVS 的 RLE 解码 `decode_pvs_row`；PAKFILE 容器 `Packfile`。
//!
//! 关键不变量与坑（数字都出自本文件的编译期断言或调用点）：
//! - 记录大小由 `static_assertions::const_assert_eq!` 钉死（共 9 处）：`TextureInfo` 72、
//!   `Node` 32、`Leaf` 32、`Model` 48、`Face` 56、`DisplacementInfo` 176、
//!   `DisplacementNeighbour` 12、`DisplacementSubNeighbour` 6、`DisplacementCornerNeighbour` 10；
//!   另有 1 处 `align_of::<DisplacementSubNeighbour>() == 2`。动字段前先看断言。
//! - `Directories` 固定 **64** 项，下标就是 `LumpType` 的判别值（0..=63，末项判别值由
//!   `bspfile.rs` 的编译期断言钉死），因此 `Index<LumpType>` 直接数组索引不会越界。
//! - `Leaf` 的字段累加是 30 字节，靠末字段的 `align_after = align_of::<Leaf>()` 补到 32；
//!   `DisplacementSubNeighbour`（5→6）与 `DisplacementCornerNeighbour`（9→10）同理 ——
//!   去掉 `align_after` 会让每条记录少读 1~2 字节，并与断言冲突。
//! - `DisplacementInfo` 在 `map_face` 之后由 `align_before = 4` 跳 2 字节，否则总长凑不满 176。
//! - `Node.children` 是**有符号**索引：`>= 0` 指节点，`< 0` 用按位取反 `!child` 指 leaf，
//!   即 leaf 是位置索引；leaf 表一旦重排，同一索引会落到另一条记录（需要按 cluster 分组的
//!   只读副本由 `vbsp/mod.rs` 的 `Leaves` 另存，不动原表）。
//! - 本文件只定义类型与读法：不切记录、不查 lump 越界、不解压、不校验索引（分别属于
//!   `reader.rs`、`bspfile.rs`、`vbsp/mod.rs` 的 `Bsp::validate`）。
//! - 不少字段只为保持记录布局完整而解析，本仓没有读取点（`VisData::pas_offsets` 只被写入，
//!   `Brush::is_visible` 与 `DisplacementInfo::triangle_count` 无调用点）——模块级
//!   `#![allow(dead_code)]` 正是为此。
//! - `decode_pvs_row` 与 `VisData::visible_clusters` 是两份各自独立的 RLE 循环，都在使用中：
//!   前者供三个工程的导出层逐行解码，后者供 `Handle::<Leaf>::visible_set`；改规则要同时改。
//!
//! 测试归属：本文件 **6** 个 `#[test]` —— `test_leaf_bytes`、`test_displacement_bytes`、
//! `test_neighbour_bytes`、`test_sub_neighbour_bytes`、`test_corner_neighbour_bytes` 均经
//! `test_read_bytes::<T>()` 钉死每条记录消费的字节数；
//! `decode_pvs_row_rle_skip_is_in_groups_of_8_clusters` 钉死 RLE 跳过的单位是 8 个 cluster。
//! `test_read_bytes` 同时被 `data/game.rs` 复用。
#![allow(dead_code)]

// 子模块：实体键值文本（entity）与 game lump 记录（game）；两者经下面的 `pub use` 重导出，
// 于是 `crate::vbsp::*` 能一次看到三块内容。
mod entity;
mod game;

pub use self::entity::*;
pub use self::game::*;

use crate::vbsp::bspfile::LumpType;
use crate::vbsp::error::{EntityParseError, InvalidNeighbourError};
use crate::vbsp::{BspResult, Handle, StringError};
use arrayvec::ArrayString;
use binrw::error::CustomError;
use binrw::{BinRead, BinResult, Endian};
use bitflags::bitflags;
use bv::BitVec;
use cgmath::{Deg, Quaternion, Rotation3, Vector3};
use num_enum::{TryFromPrimitive, TryFromPrimitiveError};
use serde::de::{Error, Unexpected};
use serde::{Deserialize, Deserializer};
use std::borrow::Cow;
use std::cmp::{min, Ordering};
use std::fmt;
use std::fmt::{Debug, Display, Formatter};
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::mem::{align_of, size_of};
use std::ops::{Add, Index, Mul, Sub};
use std::str::FromStr;
use std::sync::Mutex;
use zip::result::ZipError;
use zip::ZipArchive;

/// 断言 `T` 的 `BinRead` 实现恰好消费 `size_of::<T>()` 字节（游标必须停在记录末尾）。
///
/// 用法：`test_read_bytes::<T>()`，仅 `#[cfg(test)]` 编译；`data/game.rs` 的静态道具记录测试
/// 也复用它。
///
/// 前提：从 512 字节全零缓冲读一条记录，`read_le` 的失败路径是 `unwrap`（直接崩），所以记录
/// 大小必须 ≤ 512，且读法不能拒绝全零内容。它只适用于“消费字节数恰等于 `size_of::<T>()`”的
/// 定长记录；`FixedString` 这类“读 `LEN` 字节、`size_of` 更大”的类型喂进来必然断言失败。
#[cfg(test)]
fn test_read_bytes<T: BinRead>()
where
    T::Args<'static>: Default,
    <T as BinRead>::Args<'static>: Clone,
{
    use binrw::BinReaderExt;
    use std::any::type_name;

    let bytes = [0; 512];
    let mut reader = Cursor::new(bytes);

    let _ = reader.read_le::<T>().unwrap();

    assert_eq!(
        reader.position() as usize,
        size_of::<T>(),
        "Invalid number of bytes used to read {}",
        type_name::<T>()
    );
}

/// BSP 头之后的 lump 目录：固定 **64** 项，项序与 `LumpType` 的判别值一一对应。
///
/// `entries` 私有，取项只经 `Index<LumpType>`（按 `index as usize` 直接数组索引）；`LumpType`
/// 恰好 64 个变体（末项 `DisplacementMultiBlend` 的判别值 63 由 `bspfile.rs` 的编译期断言
/// 钉死），所以索引不会越界。
///
/// 本类型只承载目录：不解释 lump 内容，也不校验 `offset` / `length` —— 那是 `bspfile.rs` 的
/// `get_lump` 在真正取字节时做的。
#[derive(Clone, BinRead)]
pub struct Directories {
    entries: [LumpEntry; 64],
}

impl Index<LumpType> for Directories {
    type Output = LumpEntry;

    fn index(&self, index: LumpType) -> &Self::Output {
        &self.entries[index as usize]
    }
}

/// BSP 文件头的魔数四个字节（正常即 `VBSP`，比较在 `bspfile.rs` 的 `BspFile::new`）。
///
/// 字段名是单字符、看不出顺序，比较用的是整个结构体的相等；本类型不含版本号 —— 版本是紧随其后的
/// 一个 u32，由 `BspFile::new` 单独读。
#[derive(Debug, Clone, PartialEq, Eq, BinRead)]
#[br(little)]
pub struct Header {
    pub v: u8,
    pub b: u8,
    pub s: u8,
    pub p: u8,
}

/// 一个 lump 的目录项（4 × u32，共 16 字节），`Directories` 的数组元素。
///
/// - `offset` / `length`：该 lump 在**文件里**的字节偏移与长度（盘上口径，不是解压后长度）。
/// - `version`：该 lump 自身的版本号，`BspFile::lump_reader` 原样透传给 `LumpReader::version`。
/// - `ident`：非 0 表示该 lump 被 LZMA 封装，此时它是**解压后**长度；判定与解压都在
///   `bspfile.rs` 的 `get_lump` 里，本类型只承载字段。
#[derive(Clone, Copy, Debug, Default, BinRead)]
#[br(little)]
pub struct LumpEntry {
    pub offset: u32,
    pub length: u32,
    pub version: u32,
    pub ident: u32,
}

/// leaf → face 的引用项：`face` 是 `Bsp.faces` 的下标。
///
/// leaf 自己不带面表，只持有 `Leaf::first_leaf_face` / `Leaf::leaf_face_count` 指向
/// `Bsp.leaf_faces` 的一段；`Handle::<Leaf>::faces` 把这里的 `face` 解成面。
#[derive(Debug, Clone, BinRead)]
pub struct LeafFace {
    pub face: u16,
}

/// 纹理（surface）标志位，`u32` 位掩码，位值见下方 bitflags 常量。
///
/// 判定点两处：`vbsp/handle/mod.rs` 的 `Handle::<Face>::is_visible`（命中 SKY2D / SKY / TRIGGER /
/// HINT / SKIP / NODRAW 任一即判为不可见），以及三个工程导出层对 `NODRAW`、`SKY | SKY2D` 的
/// 单独判定。本类型没有 `Default`，比较一律走 `contains` / `intersects`。
#[derive(BinRead, Debug, Clone, Copy)]
pub struct TextureFlags(u32);

bitflags! {
    impl TextureFlags: u32 {
        const LIGHT      = 0b0000_0000_0000_0000_0001; // 值保存光照强度
        const SKY2D      = 0b0000_0000_0000_0000_0010; // 不绘制；绘制 2D 天空，不绘制 3D 天空盒
        const SKY        = 0b0000_0000_0000_0000_0100; // 不绘制，但添加天空盒
        const WARP       = 0b0000_0000_0000_0000_1000; // 湍流水面扭曲
        const TRANS      = 0b0000_0000_0000_0001_0000; // 纹理半透明
        const NOPORTAL   = 0b0000_0000_0000_0010_0000; // 该面不能放置传送门
        const TRIGGER    = 0b0000_0000_0000_0100_0000; // xbox hack：绕过 trigger 面剔除
        const NODRAW     = 0b0000_0000_0000_1000_0000; // 不引用纹理（不可见）
        const HINT       = 0b0000_0000_0001_0000_0000; // 作为主 BSP 分割器
        const SKIP       = 0b0000_0000_0010_0000_0000; // 完全忽略，允许非闭合 brush
        const NOLIGHT    = 0b0000_0000_0100_0000_0000; // 不计算光照
        const BUMPLIGHT  = 0b0000_0000_1000_0000_0000; // 为凹凸贴图计算光照图
        const NOSHADOWS  = 0b0000_0001_0000_0000_0000; // 不接收阴影
        const NODECALS   = 0b0000_0010_0000_0000_0000; // 不接收贴花
        const NOCHOP     = 0b0000_0100_0000_0000_0000; // 不细分该面上的 patch
        const HITBOX     = 0b0000_1000_0000_0000_0000; // 面属于 hitbox
    }
}

/// 定长、以 NUL 结尾的字符串：从流里读满 `LEN` 字节，取第一个 `0` 之前的部分。
///
/// 失败条件（都会中止解析）：`LEN` 字节里找不到 `0` → `StringError::NotNullTerminated`；
/// 截出的字节不是 UTF-8 → `StringError::NonUTF8`。两者都先包成 `binrw::Error::Custom`，
/// 再由 `error.rs` 的 `From<binrw::Error>` 还原成 `BspError::String`。
///
/// 记录大小：`BinRead` 恒定消费 `LEN` 字节（不足即 IO 错误），而 `size_of::<Self>()` 还含
/// `ArrayString` 的长度字段，两者不相等 —— 所以不能喂给 `test_read_bytes`。截出内容必然短于
/// `LEN`，构造后的 `expect` 不可达。实际使用方是 `data/game.rs` 的静态道具模型名字典。
#[derive(Debug, Clone)]
pub struct FixedString<const LEN: usize>(ArrayString<LEN>);

impl<const N: usize> AsRef<str> for FixedString<N> {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl<const N: usize> FixedString<N> {
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl<const LEN: usize> Display for FixedString<LEN> {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        Display::fmt(&self.0, f)
    }
}

impl<const LEN: usize> BinRead for FixedString<LEN> {
    type Args<'a> = ();

    fn read_options<R: Read + binrw::io::Seek>(
        reader: &mut R,
        endian: Endian,
        args: Self::Args<'static>,
    ) -> BinResult<Self> {
        use std::str;

        let start = reader.stream_position().unwrap();

        let name_buf = <[u8; LEN]>::read_options(reader, endian, args)?;

        let zero_pos =
            name_buf
                .iter()
                .position(|c| *c == 0)
                .ok_or_else(|| binrw::Error::Custom {
                    pos: start,
                    err: Box::new(StringError::NotNullTerminated),
                })?;
        let name = &name_buf[..zero_pos];
        Ok(FixedString(
            ArrayString::from(
                str::from_utf8(name)
                    .map_err(StringError::NonUTF8)
                    .map_err(|e| binrw::Error::Custom {
                        pos: start,
                        err: Box::new(e),
                    })?,
            )
            .expect(
                "Programmer error: it should be impossible for the string to exceed the capacity",
            ),
        ))
    }
}

/// `TEXTURE_INFO` 记录（编译期断言固定 **72** 字节）：一个面的纹理映射与标志。
///
/// - `texture_transforms_u` / `texture_transforms_v`：各 4 个 f32 的仿射系数 —— 前三个是 xyz 的
///   线性项、第 4 个是常数项；`Handle::<TextureInfo>::u` / `v` 用它算纹理坐标，再分别除以
///   `TextureData::width` / `height`。
/// - `light_map_scale` / `light_map_transform`：lightmap 的两个轴（`bsp_to_gltf_core/lightmap.rs`
///   用它把 luxel 映射回世界坐标）。
/// - `flags`：`TextureFlags`。
/// - `texture_data_index`：`Bsp.textures_data` 下标，越界由 `Bsp::validate` 拦下。
#[derive(Debug, Clone, BinRead)]
pub struct TextureInfo {
    pub texture_transforms_u: [f32; 4],
    pub texture_transforms_v: [f32; 4],
    pub light_map_scale: [f32; 4],
    pub light_map_transform: [f32; 4],
    pub flags: TextureFlags,
    pub texture_data_index: i32,
}

static_assertions::const_assert_eq!(size_of::<TextureInfo>(), 72);

/// `TEXTURE_DATA` 记录：纹理尺寸与名字入口。
///
/// - `reflectivity`：平均反射色（`Vector`）。
/// - `name_string_table_id`：`Bsp.texture_string_tables` 下标；取出的值再当作
///   `texture_string_data` 的字节偏移 —— `Handle::<TextureData>::name` 正是这两跳，解到第一个
///   NUL 为止。
/// - `width` / `height`：纹理像素尺寸，`Handle::<TextureInfo>::u` / `v` 用它做除数。
/// - `view_width` / `view_height`：本仓无读取点。
#[derive(Debug, Clone, BinRead)]
pub struct TextureData {
    pub reflectivity: Vector,
    pub name_string_table_id: i32,
    pub width: i32,
    pub height: i32,
    pub view_width: i32,
    pub view_height: i32,
}

/// 分割平面（`PLANES` 记录）：`normal` 法线 + `dist` 平面到原点的有符号距离，同为 BSP 世界
/// 坐标；`ty` 是平面类型标签。
///
/// 消费方：`Handle::<Node>::plane`、`vbsp/mod.rs` 的树遍历（按点到平面的有符号距离定前后），
/// 以及 `Bsp::validate` 对 `Node::plane_index` 的越界检查。
#[derive(Debug, Clone, BinRead)]
pub struct Plane {
    pub normal: Vector,
    pub dist: f32,
    pub ty: i32,
}

/// BSP 树节点（编译期断言固定 **32** 字节）。
///
/// - `plane_index`：`Bsp.planes` 下标，分割该节点；越界由 `Bsp::validate` 拦下。
/// - `children`：两个**有符号**索引 —— `>= 0` 是子节点在 `Bsp.nodes` 里的下标，`< 0` 是 leaf，
///   取法为按位取反 `!child`（`vbsp/mod.rs` 算 `max_leaf_index` 与 `Bsp::validate` 都这么解）。
///   所以 leaf 是位置索引：leaf 表重排会让同一索引落到另一条记录。
/// - `mins` / `maxs`：节点包围盒（i16，BSP 坐标）。
/// - `first_face` / `face_count`：本仓无读取点。
/// - `area`：读入后本仓无读取点；`padding` 是记录内的填充字段，同样无读取点。
#[derive(Debug, Clone, BinRead)]
pub struct Node {
    pub plane_index: i32,
    pub children: [i32; 2],
    pub mins: [i16; 3],
    pub maxs: [i16; 3],
    pub first_face: u16,
    pub face_count: u16,
    pub area: i16,
    pub padding: i16,
}

static_assertions::const_assert_eq!(size_of::<Node>(), 32);

/// BSP 树叶（编译期断言固定 **32** 字节）。字段累加只有 30 字节，靠末字段的
/// `align_after = align_of::<Leaf>()` 补出剩余 2 字节 —— 去掉它会让 `reader.rs` 的
/// `read_leaves` 每条少读 2 字节，并与断言冲突。
///
/// `Default` 供测试用 `..Default::default()` 造叶子，与解析无关。
#[derive(Default, Debug, Clone, BinRead)]
pub struct Leaf {
    /// 内容类型位集；本仓的读取点只有 `vbsp/mod.rs` 的簇迭代测试（拿它当标记）。
    pub contents: i32,
    /// PVS 簇号。负值 = 不属于任何簇：`Handle::<Leaf>::visible_set` 对 `cluster < 0` 直接返回
    /// `None`；`Leaves::clusters` 也按该字段分组。
    pub cluster: i16,
    /// area 与 flags 打包在同一个 i16 里；本仓无读取点（不解包、不判定）。
    pub area_and_flags: i16,
    /// `mins` / `maxs`：leaf 包围盒（i16，BSP 坐标）。
    pub mins: [i16; 3],
    pub maxs: [i16; 3],
    /// `Bsp.leaf_faces` 的区间起点与条数；`Handle::<Leaf>::faces` 与三个工程的导出层按它取面。
    pub first_leaf_face: u16,
    pub leaf_face_count: u16,
    /// `Bsp.leaf_brushes` 的区间起点与条数；三个工程的导出层按它收集 leaf 的 brush。
    pub first_leaf_brush: u16,
    pub leaf_brush_count: u16,
    /// leaf 的水面数据下标（字段拼写沿用记录本身）；本仓无读取点。
    #[br(align_after = align_of::< Leaf > ())]
    pub leaf_watter_data_id: i16,
}

static_assertions::const_assert_eq!(size_of::<Leaf>(), 32);

#[test]
fn test_leaf_bytes() {
    test_read_bytes::<Leaf>();
}

/// leaf → brush 的引用项：`brush` 是 `Bsp.brushes` 的下标，由 `Leaf::first_leaf_brush` /
/// `leaf_brush_count` 切段；消费方是三个工程的导出层（收集 leaf 内的 brush 做碰撞与凸包）。
#[derive(Debug, Clone, BinRead)]
pub struct LeafBrush {
    pub brush: u16,
}

/// `MODELS` 记录（编译期断言固定 **48** 字节）：一个可见模型，0 号是 worldspawn。
///
/// - `mins` / `maxs` / `origin`：包围盒与原点（`Vector`，BSP 坐标）。
/// - `head_node`：该模型 BSP 子树的根节点下标；导出层从它向下遍历收集 brush。
/// - `first_face` / `face_count`：`Bsp.faces` 的区间（`Handle::<Model>::faces` 用它，
///   `bsp_to_gltf_core` 也用它把面归属回模型）。
#[derive(Debug, Clone, BinRead)]
pub struct Model {
    pub mins: Vector,
    pub maxs: Vector,
    pub origin: Vector,
    pub head_node: i32,
    pub first_face: i32,
    pub face_count: i32,
}

static_assertions::const_assert_eq!(size_of::<Model>(), 48);

/// `BRUSHES` 记录：一个凸体。
///
/// - `brush_side` / `num_brush_sides`：`Bsp.brush_sides` 的区间；导出层按它取每个 brush 的面
///   与凸包平面。
/// - `flags`：`BrushFlags`。
#[derive(Debug, Clone, BinRead)]
pub struct Brush {
    pub brush_side: u32,
    pub num_brush_sides: u32,
    pub flags: BrushFlags,
}

impl Brush {
    /// 该 brush 是否参与可见性：命中 SOLID / GRATE / OPAQUE / TESTFOGVOLUME / TRANSLUCENT
    /// 任一即真。
    ///
    /// 本仓无调用点；面侧的可见性判定走 `Handle::<Face>::is_visible`（看纹理标志），
    /// brush 侧的碰撞判定在导出层直接读 `brush.flags`。
    pub fn is_visible(&self) -> bool {
        self.flags.intersects(
            BrushFlags::SOLID
                | BrushFlags::GRATE
                | BrushFlags::OPAQUE
                | BrushFlags::TESTFOGVOLUME
                | BrushFlags::TRANSLUCENT,
        )
    }
}

/// brush 内容标志位，`u32` 位掩码，位值见下方 bitflags 常量。
///
/// 读取点两处：`Brush::is_visible`（本仓无调用点）与三个工程导出层的
/// `brush.flags.intersects(..)` / `contains(BrushFlags::LADDER)` 判定。
#[derive(BinRead, Debug, Clone, Copy)]
pub struct BrushFlags(u32);

bitflags! {
    impl BrushFlags: u32 {
        const EMPTY =       	        0; // 	无内容
        const SOLID =       	        0x1; // 	实体中永不为空
        const WINDOW =      	        0x2; // 	半透明但不含水（玻璃）
        const AUX =         	        0x4;
        const GRATE =       	        0x8; // 	alpha 测试的"栅格"纹理；子弹/视线穿过，实体不穿过
        const SLIME =       	        0x10;
        const WATER =       	        0x20;
        const MIST =        	        0x40;
        const OPAQUE =      	        0x80; // 	阻挡 AI 视线
        const TESTFOGVOLUME =          0x100; // 	不可透视（未必是固体）
        const UNUSED =      	        0x200; // 	未使用
        const UNUSED6 =                0x400; // 	未使用
        const TEAM1 =       	        0x800; // 	按队伍区分碰撞
        const TEAM2 =       	        0x1000;
        const IGNORE_NODRAW_OPAQUE =   0x2000; // 	忽略 SURF_NODRAW 面上的 CONTENTS_OPAQUE
        const MOVEABLE =               0x4000; // 	可碰撞 MOVETYPE_PUSH 实体（门、平台等）
        const AREAPORTAL =             0x8000; // 	其余内容不可见，不消耗 brush
        const PLAYERCLIP =             0x10000;
        const MONSTERCLIP =            0x20000;
        const CURRENT_0 =              0x40000; // 	水流可与其他内容叠加
        const CURRENT_90 =             0x80000;
        const CURRENT_180 =            0x100000;
        const CURRENT_270 =            0x200000;
        const CURRENT_UP =             0x400000;
        const CURRENT_DOWN =           0x800000;
        const ORIGIN =      	        0x1000000; // 	编译 BSP 前移除
        const MONSTER =                0x2000000; // 	只存在于游戏中，不该出现在 brush 上
        const DEBRIS =      	        0x4000000;
        const DETAIL =      	        0x8000000; // 	vis leaf 之后添加的 brush
        const TRANSLUCENT =            0x10000000; // 	任一面有 trans 时自动设置
        const LADDER =      	        0x20000000;
        const HITBOX =      	        0x40000000; // 	trace 时使用精确 hitbox
    }
}

/// brush 的一个面：`plane` 是 `Bsp.planes` 下标；`texture_info` 是 `Bsp.textures_info` 下标
/// （负值 = 该侧无纹理，导出层按 `>= 0` 判）；`bevel` 非 0 表示倒角面，导出层会把它剔除。
///
/// `displacement_info` 本仓无读取点。
#[derive(Debug, Clone, BinRead)]
pub struct BrushSide {
    pub plane: u16,
    pub texture_info: i16,
    pub displacement_info: i16,
    pub bevel: i16,
}

/// `VERTICES` 记录：一个顶点位置（`Vector`，BSP 坐标）。
///
/// 面的顶点链 `Face` → `SurfaceEdge` → `Edge` → 本表由 `Handle::<Face>::vertices` 解开；
/// `Bsp::validate` 检查两张 u16 索引表是否落在本表内。
#[derive(Debug, Clone, BinRead)]
pub struct Vertex {
    pub position: Vector,
}

/// `EDGES` 记录：两个顶点下标（`Bsp.vertices`）。
///
/// 同一条边可被两个面以相反方向引用，走哪一端由引用它的 `SurfaceEdge` 的符号决定。
#[derive(Debug, Clone, BinRead)]
pub struct Edge {
    pub start_index: u16,
    pub end_index: u16,
}

/// 面沿 `Edge` 走的方向。
///
/// 消费点：`vbsp/handle/mod.rs` 的 `vertex_indexes` —— `FirstToLast` 取 `Edge::start_index`，
/// `LastToFirst` 取 `Edge::end_index`。
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum EdgeDirection {
    FirstToLast,
    LastToFirst,
}

/// `SURFEDGES` 记录：面的顶点链一环，`edge` 是**带符号**的 `Bsp.edges` 下标（私有字段，
/// 只经下面两个方法暴露）。
///
/// 面的顶点链 = `Bsp.surface_edges[Face::first_edge .. first_edge + num_edges]`，逐项解到
/// `Edge` 与 `Vertex`。
#[derive(Debug, Clone, BinRead)]
pub struct SurfaceEdge {
    edge: i32,
}

impl SurfaceEdge {
    /// 边下标：对 `edge` 取绝对值（`i32::unsigned_abs`）。
    pub fn edge_index(&self) -> u32 {
        self.edge.unsigned_abs()
    }

    /// 遍历方向：`edge >= 0` 为 `FirstToLast`，否则 `LastToFirst`。
    pub fn direction(&self) -> EdgeDirection {
        if self.edge >= 0 {
            EdgeDirection::FirstToLast
        } else {
            EdgeDirection::LastToFirst
        }
    }
}

/// `FACES` / `FACES_HDR` 记录（编译期断言固定 **56** 字节）：一个面。同一类型被两张面表复用，
/// 用哪一张由光照侧决定（`bsp_to_gltf_core/lightmap.rs` 的 `lightmap_faces`：选了 HDR 光照
/// 且 HDR 面表非空时用 `FACES_HDR`，并要求两张表条目数一致）。
///
/// - `plane_num`：`Bsp.planes` 下标。
/// - `first_edge` / `num_edges`：顶点链区间，指向 `Bsp.surface_edges`（消费方
///   `Handle::<Face>::vertices` 与 `vertex_indexes`）。
/// - `texture_info`：`Bsp.textures_info` 下标（`Handle::<Face>::texture`），越界由 `Bsp::validate`
///   拦下。
/// - `displacement_info`：位移下标，负值 = 该面无位移（`displacement_index()` 按此判定）。
/// - `light_offset`：光照 lump 内的字节偏移，`-1` 表示该面无光照
///   （`bsp_to_gltf_core/lightmap.rs` 据此跳过）。
/// - `light_map_texture_min` / `light_map_texture_size`：lightmap 在原图里的像素起点与尺寸。
/// - `area`：面面积（f32）。
/// - `styles` / `surface_fog_volume_id` / `on_node` / `side` / `original_face` /
///   `primitive_count` / `first_primitive_index` / `smoothing_groups`：读入后本仓无读取点。
#[derive(Debug, Clone, BinRead)]
pub struct Face {
    pub plane_num: u16,
    pub side: u8,
    pub on_node: u8,
    pub first_edge: i32,
    pub num_edges: i16,
    pub texture_info: i16,
    pub displacement_info: i16,
    pub surface_fog_volume_id: i16,
    pub styles: [u8; 4],
    pub light_offset: i32,
    pub area: f32,
    pub light_map_texture_min: [i32; 2],
    pub light_map_texture_size: [i32; 2],
    pub original_face: i32,
    pub primitive_count: u16,
    pub first_primitive_index: u16,
    pub smoothing_groups: u32,
}

impl Face {
    /// `displacement_info >= 0` 时返回它，否则 `None` —— 位移下标用负值表示“没有”。
    ///
    /// 消费点：`vbsp/mod.rs` 收集位移时的过滤、`Bsp::validate` 的位移索引检查，以及“位移面
    /// 必须 4 条边”的检查（不满足返回 `ValidationError::NonSquareDisplacement`）。
    pub fn displacement_index(&self) -> Option<i16> {
        (self.displacement_info >= 0).then_some(self.displacement_info)
    }
}

static_assertions::const_assert_eq!(size_of::<Face>(), 56);

/// VIS lump 的解析结果：簇数、两张偏移表，以及**整段** lump 字节。
///
/// - `data`：含 `numclusters` 头与两张偏移表在内的完整 lump；偏移表里的值是相对 **lump 起点**
///   的偏移，所以 `data[offset]` 就是行首（构造逻辑与理由见 `reader.rs` 的 `read_visdata`）。
/// - `pvs_offsets`：每簇 PVS 行的起点；两条解码路径都直接拿 `cluster` 当它的下标，**不查越界**。
/// - `pas_offsets`：每簇 PAS 行的起点；本仓只写入，没有读取点。
/// - `cluster_count`：簇总数，同时是两条解码路径的簇上限。
///
/// 消费方：`Handle::<Leaf>::visible_set`（走 `visible_clusters`），以及三个工程导出层的
/// `parse_pvs_data` / `export_visleaf_pvs`（按 `pvs_offsets` 逐簇调 `decode_pvs_row`，且自己
/// 带边界判断）。
#[derive(Default, Debug, Clone)]
pub struct VisData {
    pub cluster_count: u32,
    pub pvs_offsets: Vec<i32>,
    pub pas_offsets: Vec<i32>,
    pub data: Vec<u8>,
}

impl VisData {
    /// 解出 `cluster` 这一行的 PVS，返回长度 `cluster_count` 的位图（位下标 = 目标簇号）。
    ///
    /// 与 `decode_pvs_row` 同一套 RLE 规则，但这里是**另一份独立循环**：非零字节覆盖 8 个簇
    /// （LSB 在前），零字节转义后的下一字节是要跳过的**字节**数（每字节 = 8 个不可见簇），
    /// 压缩字节耗尽即跳出、剩余簇保持不可见。
    ///
    /// 不做边界检查：`pvs_offsets[cluster]` 与 `data[offset..]` 都是直接索引，`cluster` 越界或
    /// offset 落在 `data` 之外都会 panic；wasm 侧因此改在导出层逐簇调 `decode_pvs_row` 并自带
    /// 边界判断。改 RLE 规则时两个函数必须同步。
    pub fn visible_clusters(&self, cluster: i16) -> BitVec<u8> {
        let offset = self.pvs_offsets[cluster as usize] as usize;
        let pvs_buffer = &self.data[offset..];
        let mut visible_clusters = BitVec::with_capacity(min(self.cluster_count as u64, 1024));
        visible_clusters.resize(self.cluster_count as u64, false);

        let mut cluster_index = 0;
        let mut buffer_index = 0;

        while cluster_index < self.cluster_count {
            if buffer_index >= pvs_buffer.len() {
                break;
            }
            if pvs_buffer[buffer_index] == 0 {
                if buffer_index + 1 >= pvs_buffer.len() {
                    break;
                }
                let skip = pvs_buffer[buffer_index + 1];
                cluster_index += skip as u32 * 8;
                buffer_index += 2;
            } else {
                let packed = pvs_buffer[buffer_index];
                for i in 0..8 {
                    let bit = 1 << i;
                    if (packed & bit) == bit {
                        visible_clusters.set(cluster_index as u64, true);
                    }
                    cluster_index += 1;
                }
                buffer_index += 1;
            }
        }

        visible_clusters
    }
}

/// 把一行 RLE 压缩的 PVS 解码进调用方的位图 —— 三个工程导出层用的那一份。
///
/// 参数与单位：
/// - `vis_data`：可见性 lump 的完整字节；`offset >= vis_data.len()` 时直接返回（该行按不可见
///   算，不报错）。
/// - `offset`：该簇 PVS 行在 `vis_data` 内的**字节**偏移，取自 `VisData::pvs_offsets`。
/// - `cluster_count`：地图簇总数，决定本行最多写到哪个簇。
/// - `_bytes_per_row`：调用方按 `(cluster_count + 7) / 8` 传（一个簇一行占多少字节），本函数
///   **不读**它 —— 行首由 `row_offset` 直接给出，保留该形参只为调用处参数成组。
/// - `row_offset`：本行在 `pvs_bits` 里的起始字节，调用方按 `簇号 * bytes_per_row` 算。
/// - `pvs_bits`：调用方分配的位图，须覆盖到 `row_offset + cluster_count / 8`；目标簇 `t` 写在
///   第 `row_offset + t / 8` 字节的第 `t % 8` 位（LSB 在前），其余位保持原值（本函数只置位）。
///
/// RLE 格式（字节格式源自 Source 引擎的 `CM_DecompressVis`）：
/// - 输出每字节覆盖 8 个簇，簇计数从 0 开始。
/// - 非零字节 `b`：第 `i` 位为 1 即簇 `cluster_index + i` 可见；前进 8 个簇、消耗 1 字节。
/// - 零字节：转义；**下一**字节 `n` 是要跳过的零字节数，每字节代表 8 个不可见簇，
///   故前进 `n * 8` 个簇、消耗 2 字节。
/// - 压缩字节提前耗尽时跳出，剩余簇保持不可见。
///
/// 本函数只解一行：多簇由调用方按 `pvs_offsets` 循环；它与 `VisData::visible_clusters` 是两份
/// 独立实现，规则改动要一起改。
pub fn decode_pvs_row(
    vis_data: &[u8],
    offset: usize,
    cluster_count: u32,
    _bytes_per_row: usize,
    row_offset: usize,
    pvs_bits: &mut [u8],
) {
    if offset >= vis_data.len() {
        return;
    }
    let pvs_buffer = &vis_data[offset..];
    let mut cluster_index: u32 = 0;
    let mut buffer_index: usize = 0;
    while cluster_index < cluster_count {
        if buffer_index >= pvs_buffer.len() {
            break; // 压缩字节耗尽，剩余 cluster 保持不可见
        }
        let byte = pvs_buffer[buffer_index];
        if byte == 0 {
            // RLE 转义：下一字节 = 要跳过的零字节数（每组 = 8 个 cluster）
            if buffer_index + 1 >= pvs_buffer.len() {
                break;
            }
            let skip_bytes = pvs_buffer[buffer_index + 1] as u32;
            cluster_index += skip_bytes * 8; // 修复：跳过单位是 8-cluster 组
            buffer_index += 2;
        } else {
            // 8 个 cluster 的可见性按位掩码编码
            for i in 0..8u32 {
                let bit = 1u8 << i;
                if (byte & bit) == bit {
                    let target = cluster_index + i;
                    if target < cluster_count {
                        let t = target as usize;
                        pvs_bits[row_offset + (t / 8)] |= 1 << (t % 8);
                    }
                }
            }
            cluster_index += 8;
            buffer_index += 1;
        }
    }
}

/// `VERTNORMALS` 记录：一个 f32 法线分量。
///
/// 读进 `Bsp` 的私有字段 `vertex_normals`，本仓的读取点只有 `Bsp::validate` —— 拿它当
/// `VertNormalIndex::index` 的越界上界。
#[derive(Debug, Clone, BinRead)]
pub struct VertNormal {
    pub normal: f32,
}

/// `VERTNORMALINDICES` 记录：`Bsp` 私有字段 `vertex_normal_indices` 的元素，`index` 是
/// `vertex_normals` 的下标，由 `Bsp::validate` 检查越界。
#[derive(Debug, Clone, BinRead)]
pub struct VertNormalIndex {
    pub index: i16,
}

/// `PAKFILE` lump 的 zip 容器（`Bsp.pack`）：地图自带的材质与模型就以条目形式存在这里。
///
/// `zip` 私有且必须持锁访问，所以对外只有 `read` / `get` / `has` / `into_zip` 四个口子。
pub struct Packfile {
    zip: Mutex<ZipArchive<Cursor<Vec<u8>>>>,
}

impl Clone for Packfile {
    /// 深拷贝整个 `ZipArchive`（含底层字节缓冲），因此克隆不便宜；克隆期间持锁，锁中毒会 panic。
    fn clone(&self) -> Self {
        Packfile {
            zip: Mutex::new(self.zip.lock().unwrap().clone()),
        }
    }
}

impl Debug for Packfile {
    /// 只打印条目名（逗号连接），不打印内容字节；锁中毒会 panic。
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.debug_struct("Packfile")
            .field(
                "zip",
                &self
                    .zip
                    .lock()
                    .unwrap()
                    .file_names()
                    .collect::<Vec<_>>()
                    .join(", "),
            )
            .finish()
    }
}

impl Packfile {
    /// 用 PAKFILE lump 的字节建 zip 索引。传入的 `Cow` 一律 `into_owned`（必然拷贝一份）后交给
    /// `ZipArchive`；zip 目录非法时返回 `BspError::Zip`。
    ///
    /// 唯一构造点在 `vbsp/mod.rs` 的 `Bsp::read`，输入是 `PAKFILE` lump 的整段字节。本方法不做
    /// 缓存复用，重复调用会重复建索引。
    pub fn read(data: Cow<[u8]>) -> BspResult<Self> {
        let reader = Cursor::new(data.into_owned());
        let zip = Mutex::new(ZipArchive::new(reader)?);
        Ok(Packfile { zip })
    }

    /// 按条目名取内容，返回该条目**解压后**的字节。
    ///
    /// 三种结果：命中 → `Ok(Some(bytes))`；`ZipError::FileNotFound` → `Ok(None)`（“没有这个
    /// 文件”不算错误）；其他 zip 错误（条目损坏等）→ `Err(BspError::Zip)`。按名精确匹配，
    /// 大小写敏感。整段读取期间持锁。
    pub fn get(&self, name: &str) -> BspResult<Option<Vec<u8>>> {
        let mut zip = self.zip.lock().unwrap();
        let mut entry = match zip.by_name(name) {
            Ok(entry) => entry,
            Err(ZipError::FileNotFound) => {
                return Ok(None);
            }
            Err(e) => {
                return Err(e.into());
            }
        };
        let mut buff = vec![0; entry.size() as usize];
        entry.read_exact(&mut buff)?;
        Ok(Some(buff))
    }

    /// 只回答条目是否存在：匹配规则与错误分类同 `get`，但不解压内容。
    pub fn has(&self, name: &str) -> BspResult<bool> {
        let mut zip = self.zip.lock().unwrap();
        let result = match zip.by_name(name) {
            Ok(_) => Ok(true),
            Err(ZipError::FileNotFound) => {
                return Ok(false);
            }
            Err(e) => {
                return Err(e.into());
            }
        };
        result
    }

    /// 交出内层 `Mutex<ZipArchive<…>>`（所有权转移，不再拷贝）。
    ///
    /// 三个工程的导出层用它枚举材质/模型条目与取 `len()`；因为会消费 `self`，那边普遍先
    /// `pack.clone()` 再 `into_zip()`。
    pub fn into_zip(self) -> Mutex<ZipArchive<Cursor<Vec<u8>>>> {
        self.zip
    }
}

/// 读一个 `TryFromPrimitive` 枚举：先按底层整数类型读原始值，再 `try_from_primitive`。
///
/// 转换失败时用 `err_map(原始值)` 造错，并包成 `binrw::Error::Custom`（附上读原始值之前的游标
/// 位置，`stream_position().unwrap()`），所以 `Error` 必须满足 `CustomError + 'static` —— 本文件
/// 传的是 `InvalidNeighbourError::InvalidNeighbourSpan` / `InvalidNeighbourOrientation`，由
/// `error.rs` 的 `From<binrw::Error>` 还原成 `ValidationError::Neighbour`。
fn try_read_enum<Enum, Reader, Error, ErrorFn>(
    reader: &mut Reader,
    endian: Endian,
    args: <<Enum as TryFromPrimitive>::Primitive as BinRead>::Args<'static>,
    err_map: ErrorFn,
) -> BinResult<Enum>
where
    Reader: Read + Seek,
    Enum: TryFromPrimitive<Error = TryFromPrimitiveError<Enum>>,
    Enum::Primitive: BinRead,
    ErrorFn: FnOnce(Enum::Primitive) -> Error,
    Error: CustomError + 'static,
{
    let start = reader.stream_position().unwrap();
    let raw = <Enum::Primitive>::read_options(reader, endian, args)?;

    Enum::try_from_primitive(raw)
        .map_err(|e| err_map(e.number))
        .map_err(|e| binrw::Error::Custom {
            pos: start,
            err: Box::new(e),
        })
}

/// 欧拉角（度）：`pitch` / `yaw` / `roll` 三个私有字段。构造与读取路径：
///
/// - serde 反序列化：从 `"pitch yaw roll"` 这种空格分隔的字符串解析，失败给 `invalid_value`
///   （不是 `EntityParseError`）—— `data/entity.rs` 的实体结构体都带 `angles: Angles` 字段。
/// - `FromStr`：同样按空格切，取前三个 f32；不足三个返回 `EntityParseError::ElementCount`，
///   数值解析失败返回 `EntityParseError::Float`，多余元素被忽略。
/// - `as_quaternion`：四元数视图；`data/game.rs` 的 `StaticPropLump::angles()` 直接读三个私有
///   字段（子模块可见），用于 WASM 侧构造放置信息。
#[derive(Debug, Copy, Clone, BinRead)]
pub struct Angles {
    pitch: f32,
    yaw: f32,
    roll: f32,
}

impl<'de> Deserialize<'de> for Angles {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let str = <&str>::deserialize(deserializer)?;
        str.parse()
            .map_err(|_| D::Error::invalid_value(Unexpected::Other(str), &"a list of angles"))
    }
}

impl FromStr for Angles {
    type Err = EntityParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let mut floats = s.split(' ').map(f32::from_str);
        let pitch = floats.next().ok_or(EntityParseError::ElementCount)??;
        let yaw = floats.next().ok_or(EntityParseError::ElementCount)??;
        let roll = floats.next().ok_or(EntityParseError::ElementCount)??;
        Ok(Angles { pitch, yaw, roll })
    }
}

impl Angles {
    /// 转成四元数（模块私有，但子模块 `data/game.rs` 的 `StaticPropLump::rotation` 与本文件的
    /// `PropDynamic` / `PropDynamicOverride` 都在用）。
    fn as_quaternion(&self) -> Quaternion<f32> {
        // 旋转按 from_angle_y(yaw) * from_angle_x(pitch) * from_angle_z(roll) 的左乘序组合；
        // 与 `src/vendor/vmdl/src/shared.rs` 的 `From<RadianEuler> for cgmath::Quaternion<f32>` 同一写法。
        Quaternion::from_angle_y(Deg(self.yaw))
            * Quaternion::from_angle_x(Deg(self.pitch))
            * Quaternion::from_angle_z(Deg(self.roll))
    }
}

/// 本文件唯一的 `#[cfg(test)]` 模块；其余 5 个 `#[test]` 直接写在模块作用域（同样只在 test
/// 配置下编译）。
#[cfg(test)]
mod tests {
    use super::*;

    /// 钉死 RLE 转义的跳过量纲：零字节之后的那个字节是要跳过的**零字节**数，每字节代表 8 个簇，
    /// 所以 `skip = 1` 要前进 8 个簇而不是 1 个。这条断言同时是 `decode_pvs_row` 与
    /// `VisData::visible_clusters` 共用的规则判据。
    #[test]
    fn decode_pvs_row_rle_skip_is_in_groups_of_8_clusters() {
        // cluster_count = 24 => bytes_per_row = 3，单行位图。
        // 输入 0x0F, 0x00, 0x01, 0x0F：
        //   0x0F        -> 簇 0..7，bit 0..3 置位 => 0..3 可见
        //   0x00, 0x01  -> 转义：跳过 1 个零字节 = 8 个簇（8..15 不可见）
        //   0x0F        -> 簇 16..23，bit 0..3 置位 => 16..19 可见
        // 期望可见集合：0,1,2,3 与 16,17,18,19。
        let vis_data: Vec<u8> = vec![0x0F, 0x00, 0x01, 0x0F];
        let cluster_count = 24u32;
        let bytes_per_row = ((cluster_count as usize) + 7) / 8; // 3
        let mut pvs_bits = vec![0u8; bytes_per_row]; // single row
        decode_pvs_row(&vis_data, 0, cluster_count, bytes_per_row, 0, &mut pvs_bits);

        assert_eq!(pvs_bits[0], 0x0F, "clusters 0..7 bitmap");
        assert_eq!(pvs_bits[1], 0x00, "clusters 8..15 bitmap");
        assert_eq!(pvs_bits[2], 0x0F, "clusters 16..23 bitmap");

        let is_visible = |t: usize| -> bool {
            let byte = pvs_bits[t / 8];
            (byte & (1u8 << (t % 8))) != 0
        };
        for t in 0..24usize {
            let expect = matches!(t, 0 | 1 | 2 | 3 | 16 | 17 | 18 | 19);
            assert_eq!(is_visible(t), expect, "cluster {} visibility", t);
        }
    }
}


// ── vector：坐标与运算符 ──────────────────────────────

/// BSP 世界坐标里的三维向量（Z-up），既当点也当方向。
///
/// 运算符语义：`Add` / `Sub` / `Mul<f32>` 逐分量；`PartialEq` 逐分量比较（浮点，所以没有 `Eq`）。
/// **`PartialOrd` 比的是 `length_squared()`**，不是分量字典序 —— `Handle::<DisplacementInfo>`
/// 找位移起始角点时正是靠 `min_by(partial_cmp)` 取模长最小者，改这里会连带改掉那个选择结果。
#[derive(Debug, Clone, Copy, BinRead, Default)]
pub struct Vector {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vector {
    /// 按 `x` / `y` / `z` 顺序产出三个分量。
    pub fn iter(&self) -> impl Iterator<Item = f32> {
        [self.x, self.y, self.z].into_iter()
    }

    /// 模长平方（不开方），也是 `PartialOrd` 的比较键。
    pub fn length_squared(&self) -> f32 {
        self.x.powf(2.0) + self.y.powf(2.0) + self.z.powf(2.0)
    }
}

// 逐分量算术；没有 `Mul<Vector>`（点积由调用方自己写）。
impl Add<Vector> for Vector {
    type Output = Vector;

    fn add(self, rhs: Vector) -> Self::Output {
        Vector {
            x: self.x + rhs.x,
            y: self.y + rhs.y,
            z: self.z + rhs.z,
        }
    }
}

impl Sub<Vector> for Vector {
    type Output = Vector;

    fn sub(self, rhs: Vector) -> Self::Output {
        Vector {
            x: self.x - rhs.x,
            y: self.y - rhs.y,
            z: self.z - rhs.z,
        }
    }
}

impl Mul<f32> for Vector {
    type Output = Vector;

    fn mul(self, rhs: f32) -> Self::Output {
        Vector {
            x: self.x * rhs,
            y: self.y * rhs,
            z: self.z * rhs,
        }
    }
}

// 相等逐分量；大小按模长平方（见下面的 `PartialOrd`）。
impl PartialEq for Vector {
    fn eq(&self, other: &Self) -> bool {
        self.x == other.x && self.y == other.y && self.z == other.z
    }
}

impl PartialOrd for Vector {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        self.length_squared().partial_cmp(&other.length_squared())
    }
}

// 与 `[f32; 3]` 的互转（另有 `From<&Vector>`），以及单向转出到 `cgmath::Vector3<f32>`。
impl From<Vector> for [f32; 3] {
    fn from(vector: Vector) -> Self {
        [vector.x, vector.y, vector.z]
    }
}

impl From<[f32; 3]> for Vector {
    fn from(vector: [f32; 3]) -> Self {
        Vector {
            x: vector[0],
            y: vector[1],
            z: vector[2],
        }
    }
}

impl From<&Vector> for [f32; 3] {
    fn from(vector: &Vector) -> Self {
        [vector.x, vector.y, vector.z]
    }
}

/// 从 `"x y z"`（空格分隔）解析；不足三个给 `EntityParseError::ElementCount`，数值错误给
/// `EntityParseError::Float`，多余元素被忽略。
impl FromStr for Vector {
    type Err = EntityParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let mut floats = s.split(' ').map(f32::from_str);
        let x = floats.next().ok_or(EntityParseError::ElementCount)??;
        let y = floats.next().ok_or(EntityParseError::ElementCount)??;
        let z = floats.next().ok_or(EntityParseError::ElementCount)??;
        Ok(Vector { x, y, z })
    }
}

impl From<Vector> for Vector3<f32> {
    fn from(v: Vector) -> Self {
        Vector3::new(v.x, v.y, v.z)
    }
}

/// serde 侧收字符串字面量（不是 JSON 数组），解析失败给 `invalid_value`。
impl<'de> Deserialize<'de> for Vector {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let str = <&str>::deserialize(deserializer)?;
        str.parse()
            .map_err(|_| D::Error::invalid_value(Unexpected::Other(str), &"a vector"))
    }
}

// ── prop：道具放置信息 ────────────────────────────────

/// 一个道具实例的放置信息：静态道具与 `prop_dynamic` 两条来源共用的中间表示。
///
/// - `model`：模型路径，借自 BSP 内部字符串（静态道具走 `StaticPropDictLump::name`，动态道具
///   直接借实体属性），生命周期跟随 BSP。
/// - `rotation`：世界旋转四元数，由 `Angles` 构造。
/// - `scale`：缩放。静态道具恒 `1.0`（记录里没有缩放字段），动态道具取实体键 `modelscale`。
/// - `origin`：世界坐标（BSP 坐标原样，未做 Y-up 变换）。
/// - `skin`：皮肤下标。静态道具取记录的 `skin`，动态道具恒 `0`（实体键里没有皮肤）。
#[derive(Debug, Clone)]
pub struct PropPlacement<'a> {
    pub model: &'a str,
    pub rotation: Quaternion<f32>,
    pub scale: f32,
    pub origin: Vector,
    pub skin: i32,
}

impl<'a> Handle<'a, StaticPropLump> {
    /// 静态道具 → 放置信息。挂在 `Handle` 上是因为模型名要从 `Bsp.static_props.dict.name` 取
    /// （记录的 `prop_type` 是字典下标）。
    ///
    /// `scale` 恒为 `1.0`；`skin` 取记录字段。
    pub fn as_prop_placement(&self) -> PropPlacement<'a> {
        PropPlacement {
            model: self.model(),
            rotation: self.rotation(),
            scale: 1.0,
            origin: self.origin,
            skin: self.skin,
        }
    }
}

impl<'a> PropDynamic<'a> {
    /// 实体 → 放置信息：`scale` 取实体键 `modelscale`，`rotation` 由 `angles` 转四元数，
    /// `skin` 恒 `0`。
    pub fn as_prop_placement(&self) -> PropPlacement<'a> {
        PropPlacement {
            model: self.model,
            rotation: self.angles.as_quaternion(),
            scale: self.scale,
            origin: self.origin,
            skin: 0,
        }
    }
}

impl<'a> PropDynamicOverride<'a> {
    /// 与 `PropDynamic` 同一套换算（`prop_dynamic_override` 的实体字段相同）。
    pub fn as_prop_placement(&self) -> PropPlacement<'a> {
        PropPlacement {
            model: self.model,
            rotation: self.angles.as_quaternion(),
            scale: self.scale,
            origin: self.origin,
            skin: 0,
        }
    }
}

// ── displacement：位移面与邻接 ────────────────────────

/// `DISPINFO` 记录（编译期断言固定 **176** 字节）：一个位移面的参数与四邻接。
///
/// - `start_position`：位移起始角点（BSP 坐标）；`Handle::<DisplacementInfo>::corner_positions`
///   用它决定 4 个角点的起点顺序。
/// - `displacement_vertex_start`：`Bsp.displacement_vertices` 的起始下标，取 `vertex_count()` 条。
/// - `displacement_triangle_tag_start`：`Bsp.displacement_triangles` 的起始下标；本仓无读取点。
/// - `power`：细分幂次，顶点数与三角形数由它推出（见下面两个方法）。
/// - `map_face`：对应的面下标（`Bsp.faces`），`Bsp::validate` 检查越界。
/// - `edge_neighbours` / `corner_neighbours`：四条边与四个角的邻接；`Bsp::validate` 逐个检查其中
///   的位移下标。
/// - `allowed_vertices`：10 个 u32 的允许顶点表；本仓无读取点。
/// - `minimum_tesselation` / `smoothing_angle` / `contents` / `lightmap_alpha_start` /
///   `lightmap_sample_position_start`：读入后本仓无读取点。
/// - `align_before = 4` 挂在 `lightmap_alpha_start` 上：`map_face`（u16）之后要跳到 4 字节边界，
///   否则总长对不上 176。
#[derive(Debug, Clone, BinRead)]
pub struct DisplacementInfo {
    pub start_position: Vector,
    pub displacement_vertex_start: i32,
    pub displacement_triangle_tag_start: i32,

    pub power: i32,
    pub minimum_tesselation: i32,
    pub smoothing_angle: f32,
    pub contents: i32,

    pub map_face: u16,

    #[br(align_before = 4)]
    pub lightmap_alpha_start: i32,
    pub lightmap_sample_position_start: i32,

    pub edge_neighbours: [DisplacementNeighbour; 4],
    pub corner_neighbours: [DisplacementCornerNeighbour; 4],

    pub allowed_vertices: [u32; 10],
}

impl DisplacementInfo {
    /// 位移网格的顶点数：`(2^power + 1)^2`。消费方
    /// `Handle::<DisplacementInfo>::displacement_vertices` 按它决定取多少条 `DisplacementVertex`。
    ///
    /// `power` 直接来自文件数据，本函数不校验上界。
    pub fn vertex_count(&self) -> i32 {
        (2i32.pow(self.power as u32) + 1).pow(2)
    }

    /// 位移网格的三角形数：`2 * (2^power)^2`（每个格子两个三角形）。本仓无调用点。
    pub fn triangle_count(&self) -> i32 {
        2 * 2i32.pow(self.power as u32).pow(2)
    }
}

#[test]
fn test_displacement_bytes() {
    test_read_bytes::<DisplacementInfo>();
}

static_assertions::const_assert_eq!(size_of::<DisplacementInfo>(), 176);

/// 位移一条边上的两个子邻居槽位，每槽都可为空（哨兵见 `read_option_sub_neighbour`）。
///
/// 手写 `BinRead`：两槽各调一次 `read_option_sub_neighbour`，每槽恒定 6 字节，所以整条记录恒定
/// 12 字节（编译期断言钉死）。
#[derive(Debug, Clone)]
pub struct DisplacementNeighbour {
    pub sub_neighbours: [Option<DisplacementSubNeighbour>; 2],
}

impl DisplacementNeighbour {
    /// 只迭代存在的子邻居（跳过空槽）；消费方是 `Bsp::validate` 与
    /// `Handle::<DisplacementInfo>::edge_neighbours`。
    pub fn iter(&self) -> impl Iterator<Item = &DisplacementSubNeighbour> {
        self.sub_neighbours.iter().filter_map(|sub| sub.as_ref())
    }
}

impl BinRead for DisplacementNeighbour {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        endian: Endian,
        args: Self::Args<'_>,
    ) -> BinResult<Self> {
        Ok(DisplacementNeighbour {
            sub_neighbours: [
                read_option_sub_neighbour(reader, endian, args)?,
                read_option_sub_neighbour(reader, endian, args)?,
            ],
        })
    }
}

fn read_option_sub_neighbour<R: Read + Seek>(
    reader: &mut R,
    endian: Endian,
    args: (),
) -> BinResult<Option<DisplacementSubNeighbour>> {
    let neighbour_index = u16::read_options(reader, endian, args)?;

    // u16::MAX 是“该槽没有邻居”的哨兵：后面 4 字节（= size_of::<DisplacementSubNeighbour>()
    // - 2）不再有意义，跳过即可。两个分支消费的字节数都是 6，这是整条记录 12 字节的前提。
    if neighbour_index == u16::MAX {
        reader.seek(SeekFrom::Current(
            size_of::<DisplacementSubNeighbour>() as i64 - 2,
        ))?;
        Ok(None)
    } else {
        reader.seek(SeekFrom::Current(-2))?;
        Ok(Some(DisplacementSubNeighbour::read_options(
            reader, endian, args,
        )?))
    }
}

static_assertions::const_assert_eq!(size_of::<DisplacementNeighbour>(), 12);

#[test]
fn test_neighbour_bytes() {
    test_read_bytes::<DisplacementNeighbour>();
}

/// 位移边上的一个子邻居（编译期断言固定 **6** 字节、对齐 2）：字段累加是 5 字节，末字段的
/// `align_after = align_of::<Self>()` 补出第 6 字节。
#[derive(Debug, Clone, BinRead)]
pub struct DisplacementSubNeighbour {
    /// 邻居的 `Bsp.displacements` 下标：`Bsp::validate` 检查越界，
    /// `Handle::<DisplacementSubNeighbour>::displacement` 用它取邻居。
    pub neighbour_index: u16,
    /// 朝向标签（`NeighbourOrientation`，取值 0..=3）；本仓无读取点。
    pub neighbour_orientation: NeighbourOrientation,
    /// 跨度标签（`NeighbourSpan`，取值 0..=2）；本仓无读取点。
    pub span: NeighbourSpan,
    /// 第二个跨度标签（`NeighbourSpan`）；与 `span` 一样只经受值校验，本仓无读取点。
    #[br(align_after = align_of::<DisplacementSubNeighbour>())]
    pub neighbour_span: NeighbourSpan,
}

#[test]
fn test_sub_neighbour_bytes() {
    test_read_bytes::<DisplacementSubNeighbour>();
}

static_assertions::const_assert_eq!(size_of::<DisplacementSubNeighbour>(), 6);
static_assertions::const_assert_eq!(align_of::<DisplacementSubNeighbour>(), 2);

/// 子邻居的跨度类型，判别值 0..=2（`CornerToCorner` / `CornerToMidPoint` / `MidPointToCorner`），
/// 由 `#[repr(u8)]` 固定。
///
/// `BinRead` 先读 u8 再 `try_from_primitive`：越界值造
/// `InvalidNeighbourError::InvalidNeighbourSpan`，包进 `binrw::Error::Custom` 后由 `error.rs`
/// 的 `From<binrw::Error>` 还原成 `BspError::Validation(ValidationError::Neighbour(..))`。
#[derive(Debug, Clone, TryFromPrimitive)]
#[repr(u8)]
pub enum NeighbourSpan {
    CornerToCorner = 0,
    CornerToMidPoint = 1,
    MidPointToCorner = 2,
}

impl BinRead for NeighbourSpan {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        endian: Endian,
        args: Self::Args<'_>,
    ) -> BinResult<Self> {
        try_read_enum(
            reader,
            endian,
            args,
            InvalidNeighbourError::InvalidNeighbourSpan,
        )
    }
}

/// 子邻居的朝向，判别值 0..=3（`Ccw0` / `Ccw90` / `Ccw180` / `Ccw270`），由 `#[repr(u8)]` 固定。
///
/// 越界值的错误路径同 `NeighbourSpan`，只是换成
/// `InvalidNeighbourError::InvalidNeighbourOrientation`。
#[derive(Debug, Clone, TryFromPrimitive)]
#[repr(u8)]
pub enum NeighbourOrientation {
    Ccw0 = 0,
    Ccw90 = 1,
    Ccw180 = 2,
    Ccw270 = 3,
}

impl BinRead for NeighbourOrientation {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        endian: Endian,
        args: Self::Args<'static>,
    ) -> BinResult<Self> {
        try_read_enum(
            reader,
            endian,
            args,
            InvalidNeighbourError::InvalidNeighbourOrientation,
        )
    }
}

/// 位移一个角上的邻居集合（编译期断言固定 **10** 字节）：`[u16; 4]` 8 字节 + 计数 1 字节，
/// 末字段的 `align_after = align_of::<Self>()` 补出第 10 字节。
///
/// 两个字段都私有，只能经 `neighbours()` 取；元素是 `Bsp.displacements` 下标，由 `Bsp::validate`
/// 检查越界。
#[derive(Debug, Clone, BinRead)]
pub struct DisplacementCornerNeighbour {
    neighbours: [u16; 4],
    #[br(align_after = align_of::< DisplacementCornerNeighbour > ())]
    neighbour_count: u8,
}

impl DisplacementCornerNeighbour {
    /// 产出前 `neighbour_count` 个邻居；计数超过 4 时按 4 截断（`take`，不报错）。
    pub fn neighbours(&self) -> impl Iterator<Item = u16> + '_ {
        self.neighbours
            .iter()
            .copied()
            .take(self.neighbour_count as usize)
    }
}

static_assertions::const_assert_eq!(size_of::<DisplacementCornerNeighbour>(), 10);

#[test]
fn test_corner_neighbour_bytes() {
    test_read_bytes::<DisplacementCornerNeighbour>();
}

/// `DISPVERTS` 记录：一个位移顶点 —— 方向 `vector` + 距离 `distance` + 权重 `alpha`。
///
/// 消费方 `Handle::<DisplacementInfo>::displaced_vertices` 把 `displacement()` 加到细分后的基准
/// 位置上；`alpha` 本仓无读取点。
#[derive(Debug, Clone, BinRead)]
pub struct DisplacementVertex {
    pub vector: Vector,
    pub distance: f32,
    pub alpha: f32,
}

impl DisplacementVertex {
    /// 位移向量 = `vector * distance`（`Vector` 的 `Mul<f32>`），直接加到基准点上。
    pub fn displacement(&self) -> Vector {
        self.vector * self.distance
    }
}

/// `DISP_TRIS` 记录：位移三角形，唯一字段是标签位集（1 字节）。本仓只把它读进
/// `Bsp.displacement_triangles`，无判定点。
#[derive(Debug, Clone, BinRead)]
pub struct DisplacementTriangle {
    pub tags: DisplacementTriangleFlags,
}

/// 位移三角形标签位，`u8` 位掩码，位值见下方 bitflags 常量；本仓无判定点。
#[derive(BinRead, Debug, Clone, Copy)]
pub struct DisplacementTriangleFlags(u8);

bitflags! {
    impl DisplacementTriangleFlags: u8 {
        const SURFACE =       0x01;
        const WALKABLE =      0x02;
        const BULDABLE =      0x04;
        const SURFACE_PROP1 = 0x08;
        const SURFACE_PROP2 = 0x10;
    }
}