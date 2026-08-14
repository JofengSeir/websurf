use crate::vbsp::error::UnsupportedLumpVersion;
use crate::vbsp::{lzma_decompress_with_header, Angles, BspError, FixedString, Vector};
use binrw::{BinRead, BinReaderExt, BinResult, Endian};
use bitflags::bitflags;
use cgmath::Quaternion;
use std::borrow::Cow;
use std::io::{Cursor, Read, Seek};
use std::mem::size_of;

#[derive(Debug, Clone, BinRead)]
pub struct GameLumpHeader {
    pub count: i32,
    #[br(count = count)]
    pub lumps: Vec<GameLump>,
}

impl GameLumpHeader {
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
            // 部分压缩 lump 实际略小，补 8 字节填充
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

#[derive(Debug, Clone, BinRead)]
pub struct GameLump {
    pub id: i32,
    pub flags: GameLumpFlags,
    pub version: u16,
    pub offset: i32,
    pub length: i32,
}

#[derive(BinRead, Debug, Clone, Copy)]
pub struct GameLumpFlags(u16);

bitflags! {
    impl GameLumpFlags: u16 {
        const COMPRESSED = 0b0000_0000_0000_0000_0001;
    }
}

pub trait GameLumpType: BinRead {
    const ID: i32;
}

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

#[derive(Debug, Clone, BinRead)]
pub struct StaticPropDictLump {
    pub entries: i32,
    #[br(count = entries)]
    pub name: Vec<FixedString<128>>,
}

#[derive(Debug, Clone, BinRead)]
pub struct StaticPropLeafLump {
    pub entries: i32,
    #[br(count = entries)]
    pub leaves: Vec<u16>,
}

#[derive(Debug, Clone, BinRead)]
#[br(import(version: u16))]
pub struct StaticPropLumps {
    pub entries: i32,
    #[br(args_raw = binrw::VecArgs{count: entries as usize, inner: (version,)})]
    pub props: Vec<StaticPropLump>,
}

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
    /// 以四元数形式返回道具的旋转
    pub fn rotation(&self) -> Quaternion<f32> {
        self.angles.as_quaternion()
    }

    /// 以 [pitch, yaw, roll] 形式返回道具朝向（供 WASM 内存合并路径构造放置信息使用）
    pub fn angles(&self) -> [f32; 3] {
        [self.angles.pitch, self.angles.yaw, self.angles.roll]
    }
}

impl BinRead for StaticPropLump {
    type Args<'a> = (u16,);

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

impl From<StaticPropLumpFlagsV6> for StaticPropLumpFlags {
    fn from(v6: StaticPropLumpFlagsV6) -> Self {
        StaticPropLumpFlags::from_bits_truncate(v6.bits().into())
    }
}

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

#[test]
fn test_static_prop_lump_v6_bytes() {
    super::test_read_bytes::<StaticPropLumpV6>();
}

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

// 与 StaticPropLump 相同但由派生 BinRead 读取
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

// CS:GO 后期 sprp v11（80B/记录，实测 ze_cursed_bear_tales 2026-08-14）：
// 与 V10 的差异——angles 为 3×f32（12B，非 QAngle 6B）；flags 移到 solid 之后；
// 新增 min/max_gpu_level、diff_modulation、unknown；无 lightmap_resolution。
#[derive(BinRead)]
struct StaticPropLumpV11 {
    pub origin: Vector,
    /// 角度（pitch/yaw/roll，f32 三元组——与 V10 的 QAngle i16 不同）。
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

#[test]
fn test_static_prop_lump_bytes() {
    super::test_read_bytes::<StaticPropLumpV10>();
}

static_assertions::const_assert_eq!(size_of::<StaticPropLumpV10>(), size_of::<StaticPropLump>());

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
