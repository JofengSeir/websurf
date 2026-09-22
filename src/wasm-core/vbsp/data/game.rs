//! `sprp` game lump（静态道具）与 leaf ambient cube 的解析。
//!
//! 定位：`vbsp` 解析链的下游。`bspfile.rs` 取 lump 字节、`reader.rs` 读目录与叶，本模块把
//! 其中两条数据解释成结构体：
//! - **`sprp`**：四套记录布局（V6 / V7 / V10 / V11）归一成 `StaticPropLump`；
//! - **leaf ambient cube**：`LeafAmbientSample` 与 `LeafAmbientIndex`。
//!
//! 上下游：
//! - 上游 `src/wasm-core/vbsp/mod.rs` 的 `Bsp::read`：`GameLumpHeader` 从 `LumpType::GameLump`
//!   读出，再 `find` 出 `PropStaticGameLump`（找不到该 lump 时报 `ValidationError::NoStaticPropLump`）；
//! - 下游 `vbsp::Bsp::prop_ambient_cube`：逐面调 `ColorRgbExp32::decode_linear_ambient`，
//!   出口再统一乘 `vbsp` 的 `AMBIENT_SCALE`（当前 `1.0`）。
//!
//! 关键不变量：
//! - `StaticPropLumpV10` 与归一结构 `StaticPropLump` 的 `size_of` 相等（本文件末尾有编译期
//!   断言），即 V10 与归一结构同布局；**V7 与 V10 共用同一读取分支**；
//! - `StaticPropLump::angles` 字段私有，只经 `rotation()`（四元数）与 `angles()`
//!   （`[pitch, yaw, roll]`）读出；
//! - `Angles`（定义在 `src/wasm-core/vbsp/data/mod.rs`）是 `pitch` / `yaw` / `roll` 三个 `f32`、
//!   派生 `BinRead`，因此 **V6 / V7 / V10 / V11 读的 `angles` 都是 12 字节**，四版无差异；
//! - `ColorRgbExp32` 的指数是 `u8`，两个解码函数都按 `as i8` 当有符号指数用，**只差一个
//!   `/255`**：`decode_linear` 归 lightmap，`decode_linear_ambient` 归 leaf ambient cube，
//!   不可互换。
//!
//! 边界：只做反序列化与数值换算。不做几何、不查叶、不挑采样点、不读写文件。
//!
//! 测试归属：本文件 2 个 `#[test]`（V6 与 V10 各一），都调 `super::test_read_bytes::<T>()`——该
//! 助手读 512 个零字节后断言 `reader.position() == size_of::<T>()`，即**只验字节宽度**，不验
//! 字段值。V11 与 `StaticPropLumpV11` 无测试覆盖。

use crate::vbsp::error::UnsupportedLumpVersion;
use crate::vbsp::{lzma_decompress_with_header, Angles, BspError, FixedString, Vector};
use binrw::{BinRead, BinReaderExt, BinResult, Endian};
use bitflags::bitflags;
use cgmath::Quaternion;
use std::borrow::Cow;
use std::io::{Cursor, Read, Seek};
use std::mem::size_of;

/// game lump 目录：条目数 + 条目表（表的长度由 `count` 驱动）。
#[derive(Debug, Clone, BinRead)]
pub struct GameLumpHeader {
    pub count: i32,
    #[br(count = count)]
    pub lumps: Vec<GameLump>,
}

impl GameLumpHeader {
    /// 按类型 ID 找条目并解出该 lump。
    ///
    /// 返回值有三态：`None` = 目录里没有这个 ID；`Some(Err(_))` = 找到了但取字节或解码失败；
    /// `Some(Ok(v))` = 成功。失败原因走 `BspError`：压缩条目的长度定位越界
    /// （`GameLumpOutOfBounds`）、LZMA 解压失败，或 `read_le_args` 的反序列化错误。
    pub fn find<T: GameLumpType<Args<'static> = (u16,)>>(
        &self,
        data: &[u8],
    ) -> Option<Result<T, BspError>> {
        let (i, lump) = self
            .lumps
            .iter()
            .enumerate()
            .find(|(_, lump)| lump.id == T::ID)?;

        let data = match self.get_game_lump_data(i, lump, data) {
            Ok(data) => data,
            Err(e) => return Some(Err(e)),
        };
        let mut reader = Cursor::new(data);
        Some(reader.read_le_args((lump.version,)).map_err(BspError::from))
    }

    /// 取条目载荷字节。
    ///
    /// `COMPRESSED` 条目：结束位置由**下一条目**的 `offset` 决定（`next.offset - lump.offset`），
    /// 再走 `lzma_decompress_with_header`；因此压缩条目若排在目录最后一项，会因 `lumps.get(i + 1)`
    /// 为空而报 `GameLumpOutOfBounds`。
    ///
    /// 非压缩条目：直接借用 `data` 的 `offset..offset + length`，越界报 `GameLumpOutOfBounds`。
    fn get_game_lump_data<'a>(
        &self,
        i: usize,
        lump: &GameLump,
        data: &'a [u8],
    ) -> Result<Cow<'a, [u8]>, BspError> {
        if lump.flags.contains(GameLumpFlags::COMPRESSED) {
            let next_lump = self
                .lumps
                .get(i + 1)
                .ok_or_else(|| BspError::GameLumpOutOfBounds(lump.clone()))?;
            let compressed_size = next_lump.offset - lump.offset;
            let raw_data = data
                .get(lump.offset as usize..(lump.offset + compressed_size) as usize)
                .ok_or_else(|| BspError::GameLumpOutOfBounds(lump.clone()))?;
            let mut output = lzma_decompress_with_header(raw_data, lump.length as usize)?;
            // 解压结果后固定追加 8 字节 0；不校验 output.len() 是否已等于 lump.length
            output.extend_from_slice(&[0; 8]);
            Ok(Cow::Owned(output))
        } else {
            let data = data
                .get(lump.offset as usize..(lump.offset + lump.length) as usize)
                .ok_or_else(|| BspError::GameLumpOutOfBounds(lump.clone()))?;
            Ok(Cow::Borrowed(data))
        }
    }
}

/// game lump 目录项。
///
/// `id` 是 4CC 的大端 `i32`（构造写法见 `GameLumpType::ID`）；`version` 决定记录布局；
/// `offset` / `length` 是相对 game lump 数据区起点的字节区间（不是文件绝对偏移）。
#[derive(Debug, Clone, BinRead)]
pub struct GameLump {
    pub id: i32,
    pub flags: GameLumpFlags,
    pub version: u16,
    pub offset: i32,
    pub length: i32,
}

/// game lump 目录项的标志位。当前只定义 `COMPRESSED` 一位，其余位读出后保留但不解释。
#[derive(BinRead, Debug, Clone, Copy)]
pub struct GameLumpFlags(u16);

bitflags! {
    impl GameLumpFlags: u16 {
        const COMPRESSED = 0b0000_0000_0000_0000_0001;
    }
}

/// game lump 的类型标识。`ID` 是 4CC 的大端 `i32`（如 `i32::from_be_bytes(*b"sprp")`）。
pub trait GameLumpType: BinRead {
    const ID: i32;
}

/// `sprp` 条目的三段：字典（道具名表）→ 叶表 → 记录表；记录表按 `version` 分派布局。
#[derive(Debug, Clone, BinRead)]
#[br(import(version: u16))]
pub struct PropStaticGameLump {
    pub dict: StaticPropDictLump,
    pub leaf: StaticPropLeafLump,
    #[br(args(version))]
    pub props: StaticPropLumps,
}

impl GameLumpType for PropStaticGameLump {
    const ID: i32 = i32::from_be_bytes(*b"sprp");
}

/// 道具名字典：`entries` 条、每条 `FixedString<128>`。
#[derive(Debug, Clone, BinRead)]
pub struct StaticPropDictLump {
    pub entries: i32,
    #[br(count = entries)]
    pub name: Vec<FixedString<128>>,
}

/// 叶索引序列：`entries` 个 `u16`。
#[derive(Debug, Clone, BinRead)]
pub struct StaticPropLeafLump {
    pub entries: i32,
    #[br(count = entries)]
    pub leaves: Vec<u16>,
}

/// 记录表：`entries` 条 `StaticPropLump`，逐条把 `version` 透传给记录的反序列化。
#[derive(Debug, Clone, BinRead)]
#[br(import(version: u16))]
pub struct StaticPropLumps {
    pub entries: i32,
    #[br(args_raw = binrw::VecArgs{count: entries as usize, inner: (version,)})]
    pub props: Vec<StaticPropLump>,
}

/// 归一后的静态道具记录：V6 / V7 / V10 / V11 四套布局都转成本结构。
///
/// 各版本与它的差别只在字段顺序与有无：`lightmap_resolution` 只有 V10 有，V6 与 V11 转换时
/// 填 `Default::default()`。
#[derive(Debug, Clone)]
pub struct StaticPropLump {
    pub origin: Vector,
    angles: Angles,
    pub prop_type: u16,
    pub first_leaf: u16,
    pub leaf_count: u16,
    pub solid: SolidType,
    pub skin: i32,
    pub fade_min_distance: f32,
    pub fade_max_distance: f32,
    pub lighting_origin: Vector,
    pub forced_fade_scale: f32,
    pub min_dx_level: u16,
    pub max_dx_level: u16,
    pub flags: StaticPropLumpFlags,
    pub lightmap_resolution: [u16; 2],
}

impl StaticPropLump {
    /// 以四元数形式返回道具朝向（由 `Angles::as_quaternion` 按 yaw·pitch·roll 左乘序组合）。
    /// 消费点：`src/wasm-core/vbsp/data/mod.rs` 的 `PropDynamic` / `PropDynamicOverride` 归一路径。
    pub fn rotation(&self) -> Quaternion<f32> {
        self.angles.as_quaternion()
    }

    /// 以 `[pitch, yaw, roll]` 形式返回道具朝向（单位：度）。
    /// 消费点：三工程 `crates/wasm/src/lib.rs` 的 `angles: prop.angles()`，用于构造放置信息。
    pub fn angles(&self) -> [f32; 3] {
        [self.angles.pitch, self.angles.yaw, self.angles.roll]
    }
}

impl BinRead for StaticPropLump {
    type Args<'a> = (u16,);

    /// 版本分派：`6` → V6；`7` 与 `10` → **共用** V10 布局；`11` → V11。
    /// 其余版本返回 `binrw::Error::Custom`（内嵌 `UnsupportedLumpVersion`），
    /// 错误位置取 `reader.stream_position()`。
    fn read_options<R: Read + Seek>(
        reader: &mut R,
        endian: Endian,
        args: Self::Args<'static>,
    ) -> BinResult<Self> {
        match args.0 {
            6 => StaticPropLumpV6::read_options(reader, endian, ()).map(StaticPropLump::from),
            7 | 10 => StaticPropLumpV10::read_options(reader, endian, ()).map(StaticPropLump::from),
            11 => StaticPropLumpV11::read_options(reader, endian, ()).map(StaticPropLump::from),
            version => Err(binrw::Error::Custom {
                err: Box::new(UnsupportedLumpVersion {
                    lump_type: "static props",
                    version,
                }),
                pos: reader.stream_position().unwrap(),
            }),
        }
    }
}

/// 归一后的静态道具标志位（`u32`，9 位）。V6 的 1 字节标志位经 `From` 零扩展进来。
#[derive(BinRead, Debug, Clone, Copy)]
pub struct StaticPropLumpFlags(u32);

bitflags! {
    impl StaticPropLumpFlags: u32 {
        const FLAG_FADES = 0x1;
        const USE_LIGHTING_ORIGIN = 0x2;
        const NO_DRAW = 0x4;
        const IGNORE_NORMALS = 0x8;
        const NO_SHADOW	= 0x10;
        const SCREEN_SPACE_FADE	= 0x20;
        const NO_PER_VERTEX_LIGHTING = 0x40;
        const NO_SELF_SHADOWING = 0x80;
        const NO_PER_TEXEL_LIGHTING = 0x100;
    }
}

/// 静态道具的碰撞类型（1 字节判别值，8 个变体）。
///
/// 消费方只对 `None`（= 0）做判断：三工程 `crates/wasm/src/lib.rs` 的碰撞导出用
/// `filter(|p| p.solid != Some(0))` 跳过「明确无碰撞」的实例，其余取值原样透传。
#[repr(u8)]
#[derive(BinRead, Debug, Copy, Clone)]
#[br(repr = u8)]
pub enum SolidType {
    None = 0,
    Bsp,
    Bbox,
    Obb,
    ObbYaw,
    Custom,
    Physics,
    Last,
}

/// V6 的 1 字节标志位 → 归一 `u32` 标志位：零扩展，`from_bits_truncate` 丢弃两边不重合的位。
impl From<StaticPropLumpFlagsV6> for StaticPropLumpFlags {
    fn from(v6: StaticPropLumpFlagsV6) -> Self {
        StaticPropLumpFlags::from_bits_truncate(v6.bits().into())
    }
}

/// V6 记录：`solid` 只占 1 字节（**无** `pad_after`），`flags` 是 1 字节的
/// `StaticPropLumpFlagsV6` 且排在 `skin` **之前**，末尾没有 `lightmap_resolution`。
#[derive(BinRead)]
struct StaticPropLumpV6 {
    pub origin: Vector,
    pub angles: Angles,
    pub prop_type: u16,
    pub first_leaf: u16,
    pub leaf_count: u16,
    pub solid: SolidType,
    pub flags: StaticPropLumpFlagsV6,
    pub skin: i32,
    pub fade_min_distance: f32,
    pub fade_max_distance: f32,
    pub lighting_origin: Vector,
    pub forced_fade_scale: f32,
    pub min_dx_level: u16,
    pub max_dx_level: u16,
}

/// 断言 V6 记录的**读取字节数**等于 `size_of::<StaticPropLumpV6>()`（见 `super::test_read_bytes`）。
#[test]
fn test_static_prop_lump_v6_bytes() {
    super::test_read_bytes::<StaticPropLumpV6>();
}

/// V6 的 1 字节标志位（8 位，取值与归一 `StaticPropLumpFlags` 的前 8 位相同）。
#[derive(BinRead, Debug, Clone, Copy)]
struct StaticPropLumpFlagsV6(u8);

bitflags! {
    impl StaticPropLumpFlagsV6: u8 {
        const FLAG_FADES	= 0x1;
        const USE_LIGHTING_ORIGIN	= 0x2;
        const NO_DRAW = 0x4;
        const IGNORE_NORMALS	= 0x8;
        const NO_SHADOW	= 0x10;
        const SCREEN_SPACE_FADE	= 0x20;
        const NO_PER_VERTEX_LIGHTING = 0x40;
        const NO_SELF_SHADOWING = 0x80;
    }
}

/// V10 记录：字段与归一结构 `StaticPropLump` **逐字段相同**（末尾 `const_assert_eq!` 钉死二者
/// `size_of` 相等），唯一额外之处是 `#[br(pad_after = 1)]` 让 `solid` 占 2 字节。
/// **V7 也走这一套布局**（见 `StaticPropLump::read_options` 的 `7 | 10` 分支）。
#[derive(BinRead)]
struct StaticPropLumpV10 {
    pub origin: Vector,
    pub angles: Angles,
    pub prop_type: u16,
    pub first_leaf: u16,
    pub leaf_count: u16,
    // pad，而非 align
    #[br(pad_after = 1)]
    pub solid: SolidType,
    pub skin: i32,
    pub fade_min_distance: f32,
    pub fade_max_distance: f32,
    pub lighting_origin: Vector,
    pub forced_fade_scale: f32,
    pub min_dx_level: u16,
    pub max_dx_level: u16,
    pub flags: StaticPropLumpFlags,
    pub lightmap_resolution: [u16; 2],
}

/// V11 记录（按字段宽度累加为 **80 B/记录**），相对 V10 的差异是三处：
/// ① `flags` 移到 `solid` 之后、排在 `skin` **之前**；② 末尾新增
/// `min_gpu_level` / `max_gpu_level` / `diff_modulation` / `unknown`；
/// ③ **没有 `lightmap_resolution`**（转换时填 `Default::default()`）。
///
/// `solid` 同样带 `#[br(pad_after = 1)]`；`angles` 与 V6/V10 是同一个 `Angles`（12 字节）。
/// 本布局**无测试覆盖**。
#[derive(BinRead)]
struct StaticPropLumpV11 {
    pub origin: Vector,
    /// 角度（`Angles`：pitch / yaw / roll 三个 `f32`，与 V6/V10 同类型同宽度）。
    pub angles: Angles,
    pub prop_type: u16,
    pub first_leaf: u16,
    pub leaf_count: u16,
    #[br(pad_after = 1)]
    pub solid: SolidType,
    pub flags: StaticPropLumpFlags,
    pub skin: i32,
    pub fade_min_distance: f32,
    pub fade_max_distance: f32,
    pub lighting_origin: Vector,
    pub forced_fade_scale: f32,
    pub min_dx_level: u16,
    pub max_dx_level: u16,
    pub min_gpu_level: u16,
    pub max_gpu_level: u16,
    pub diff_modulation: u32,
    pub unknown: f32,
}

/// 断言 V10 记录的**读取字节数**等于 `size_of::<StaticPropLumpV10>()`。
#[test]
fn test_static_prop_lump_bytes() {
    super::test_read_bytes::<StaticPropLumpV10>();
}

// 编译期不变量：V10 与归一结构 `StaticPropLump` 的 `size_of` 必须相等。两者字段一一对应，
// 若某次字段改动只落在一侧，这里会直接编译失败。
static_assertions::const_assert_eq!(size_of::<StaticPropLumpV10>(), size_of::<StaticPropLump>());

/// V6 → 归一结构：`flags` 经 `From` 零扩展；`lightmap_resolution` 填默认值（V6 无此字段）。
impl From<StaticPropLumpV6> for StaticPropLump {
    fn from(from: StaticPropLumpV6) -> Self {
        StaticPropLump {
            origin: from.origin,
            angles: from.angles,
            prop_type: from.prop_type,
            first_leaf: from.first_leaf,
            leaf_count: from.leaf_count,
            solid: from.solid,
            skin: from.skin,
            fade_min_distance: from.fade_min_distance,
            fade_max_distance: from.fade_max_distance,
            lighting_origin: from.lighting_origin,
            forced_fade_scale: from.forced_fade_scale,
            min_dx_level: from.min_dx_level,
            max_dx_level: from.max_dx_level,
            flags: from.flags.into(),
            lightmap_resolution: Default::default(),
        }
    }
}

/// V10 → 归一结构：逐字段搬移，**含** `lightmap_resolution`。
impl From<StaticPropLumpV10> for StaticPropLump {
    fn from(from: StaticPropLumpV10) -> Self {
        StaticPropLump {
            origin: from.origin,
            angles: from.angles,
            prop_type: from.prop_type,
            first_leaf: from.first_leaf,
            leaf_count: from.leaf_count,
            solid: from.solid,
            skin: from.skin,
            fade_min_distance: from.fade_min_distance,
            fade_max_distance: from.fade_max_distance,
            lighting_origin: from.lighting_origin,
            forced_fade_scale: from.forced_fade_scale,
            min_dx_level: from.min_dx_level,
            max_dx_level: from.max_dx_level,
            flags: from.flags,
            lightmap_resolution: from.lightmap_resolution,
        }
    }
}

/// V11 → 归一结构：`lightmap_resolution` 填默认值（V11 无此字段）；V11 新增的四个字段不进
/// 归一结构，转换时丢弃。
impl From<StaticPropLumpV11> for StaticPropLump {
    fn from(from: StaticPropLumpV11) -> Self {
        StaticPropLump {
            origin: from.origin,
            angles: from.angles,
            prop_type: from.prop_type,
            first_leaf: from.first_leaf,
            leaf_count: from.leaf_count,
            solid: from.solid,
            skin: from.skin,
            fade_min_distance: from.fade_min_distance,
            fade_max_distance: from.fade_max_distance,
            lighting_origin: from.lighting_origin,
            forced_fade_scale: from.forced_fade_scale,
            min_dx_level: from.min_dx_level,
            max_dx_level: from.max_dx_level,
            flags: from.flags,
            lightmap_resolution: Default::default(), // V11 无此字段
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// Leaf Ambient Light（prop 静态光照数据源）
//
// 两条 lump 组成一组数据：`LEAF_AMBIENT_LIGHTING(_HDR)` 是采样表，
// `LEAF_AMBIENT_INDEX(_HDR)` 给出每个 leaf 在采样表里的区间。
// 查询入口是 `vbsp::Bsp::prop_ambient_cube`；本文件只定义记录布局与数值换算。
// ═══════════════════════════════════════════════════════════════════

/// 4 字节颜色样本：R / G / B 尾数各 1 字节 + 共享指数 1 字节。
///
/// 指数字段是 `u8`，两个解码函数都按 `as i8` 当**有符号**指数用（`2^exp` 可小于 1）。
#[derive(Debug, Clone, Copy, BinRead)]
pub struct ColorRgbExp32 {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub exponent: u8,
}

impl ColorRgbExp32 {
    /// lightmap 口径：`mantissa / 255 × 2^exp`。
    ///
    /// 与渲染端 lightmap 着色器的 RGBExp32 解码同口径——那边 `rgb` 取自归一化 RGBA8 纹理
    /// （值域已除过 255），指数取自 alpha 通道。
    ///
    /// **只用于 lightmap 数据**；leaf ambient cube 用 [`Self::decode_linear_ambient`]，不可混用。
    pub fn decode_linear(&self) -> [f32; 3] {
        let scale = 2.0f32.powf(self.exponent as i8 as f32) / 255.0;
        [
            self.r as f32 * scale,
            self.g as f32 * scale,
            self.b as f32 * scale,
        ]
    }

    /// leaf ambient cube 口径：`mantissa × 2^exp`（**不除 255**）。
    ///
    /// 与 [`Self::decode_linear`] 只差这一个 255 因子；用哪个是**调用点的口径选择**。
    /// 唯一读点是 `vbsp::Bsp::prop_ambient_cube`，出口还会统一乘 `AMBIENT_SCALE`（当前 `1.0`）。
    pub fn decode_linear_ambient(&self) -> [f32; 3] {
        let scale = 2.0f32.powf(self.exponent as i8 as f32);
        [
            self.r as f32 * scale,
            self.g as f32 * scale,
            self.b as f32 * scale,
        ]
    }
}

/// `LUMP_LEAF_AMBIENT_LIGHTING(_HDR)` 的一条采样记录（**28 B**：6 面 × 4 B + 4 B 位置）：
/// 6 面 RGBExp32 cube + 该采样点在 leaf 内的相对位置。
///
/// `x` / `y` / `z` 是 `[0, 255]` 的归一化坐标；消费方 `prop_ambient_cube` 把它们各自除以 255
/// 后按 leaf 的包围盒展开成世界坐标，再在 leaf 内的多个采样点里取最近的一个（不做插值）。
#[derive(Debug, Clone, BinRead)]
pub struct LeafAmbientSample {
    /// 6 面 cube，face 序 `[+X, -X, +Y, -Y, +Z, -Z]`。
    pub cube: [ColorRgbExp32; 6],
    pub x: u8,
    pub y: u8,
    pub z: u8,
    pub _padding: u8,
}

/// `LUMP_LEAF_AMBIENT_INDEX(_HDR)` 的一条：该 leaf 在采样表里的起点与条数。
#[derive(Debug, Clone, BinRead)]
pub struct LeafAmbientIndex {
    pub ambient_sample_count: u16,
    pub first_ambient_sample: u16,
}
