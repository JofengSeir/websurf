// vbsp 子模块：保留完整解析语义，允许未使用项
#![allow(dead_code)]

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

/// 验证读取该类型恰好消费 `size_of::<T>()` 字节
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

#[derive(Debug, Clone, PartialEq, Eq, BinRead)]
#[br(little)]
pub struct Header {
    pub v: u8,
    pub b: u8,
    pub s: u8,
    pub p: u8,
}

#[derive(Clone, Copy, Debug, Default, BinRead)]
#[br(little)]
pub struct LumpEntry {
    pub offset: u32,
    pub length: u32,
    pub version: u32,
    pub ident: u32,
}

#[derive(Debug, Clone, BinRead)]
pub struct LeafFace {
    pub face: u16,
}

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

/// 定长、以空字符结尾的字符串
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

#[derive(Debug, Clone, BinRead)]
pub struct TextureData {
    pub reflectivity: Vector,
    pub name_string_table_id: i32,
    pub width: i32,
    pub height: i32,
    pub view_width: i32,
    pub view_height: i32,
}

#[derive(Debug, Clone, BinRead)]
pub struct Plane {
    pub normal: Vector,
    pub dist: f32,
    pub ty: i32,
}

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

#[derive(Default, Debug, Clone, BinRead)]
pub struct Leaf {
    pub contents: i32,
    pub cluster: i16,
    pub area_and_flags: i16,
    // 前 9 位是 area，后 7 位是 flags
    pub mins: [i16; 3],
    pub maxs: [i16; 3],
    pub first_leaf_face: u16,
    pub leaf_face_count: u16,
    pub first_leaf_brush: u16,
    pub leaf_brush_count: u16,
    #[br(align_after = align_of::< Leaf > ())]
    pub leaf_watter_data_id: i16,
}

static_assertions::const_assert_eq!(size_of::<Leaf>(), 32);

#[test]
fn test_leaf_bytes() {
    test_read_bytes::<Leaf>();
}

#[derive(Debug, Clone, BinRead)]
pub struct LeafBrush {
    pub brush: u16,
}

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

#[derive(Debug, Clone, BinRead)]
pub struct Brush {
    pub brush_side: u32,
    pub num_brush_sides: u32,
    pub flags: BrushFlags,
}

impl Brush {
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

#[derive(BinRead, Debug, Clone, Copy)]
pub struct BrushFlags(u32);

bitflags! {
    impl BrushFlags: u32 {
        const EMPTY =       	        0; // 	无内容
        const SOLID =       	        0x1; // 	实体中永远不可能是空
        const WINDOW =      	        0x2; // 	半透明但不含水（玻璃）
        const AUX =         	        0x4;
        const GRATE =       	        0x8; // 	alpha 测试的"栅格"纹理；子弹/视线穿过，实体不穿过
        const SLIME =       	        0x10;
        const WATER =       	        0x20;
        const MIST =        	        0x40;
        const OPAQUE =      	        0x80; // 	阻挡 AI 视线
        const TESTFOGVOLUME =          0x100; // 	不可透视（可能非固体）
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

#[derive(Debug, Clone, BinRead)]
pub struct BrushSide {
    pub plane: u16,
    pub texture_info: i16,
    pub displacement_info: i16,
    pub bevel: i16,
}

#[derive(Debug, Clone, BinRead)]
pub struct Vertex {
    pub position: Vector,
}

#[derive(Debug, Clone, BinRead)]
pub struct Edge {
    pub start_index: u16,
    pub end_index: u16,
}

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum EdgeDirection {
    FirstToLast,
    LastToFirst,
}

#[derive(Debug, Clone, BinRead)]
pub struct SurfaceEdge {
    edge: i32,
}

impl SurfaceEdge {
    pub fn edge_index(&self) -> u32 {
        self.edge.unsigned_abs()
    }

    pub fn direction(&self) -> EdgeDirection {
        if self.edge >= 0 {
            EdgeDirection::FirstToLast
        } else {
            EdgeDirection::LastToFirst
        }
    }
}

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
    pub fn displacement_index(&self) -> Option<i16> {
        (self.displacement_info >= 0).then_some(self.displacement_info)
    }
}

static_assertions::const_assert_eq!(size_of::<Face>(), 56);

#[derive(Default, Debug, Clone)]
pub struct VisData {
    pub cluster_count: u32,
    pub pvs_offsets: Vec<i32>,
    pub pas_offsets: Vec<i32>,
    pub data: Vec<u8>,
}

impl VisData {
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

/// 把 Source 引擎 RLE 压缩的一行 VIS 解码为可见性位图。
///
/// 这是 Source `CM_DecompressVis` 的唯一权威实现（见 `docs/VISLEAF-PVS.md`）。
/// 所有 PVS 路径 —— WASM `parse_pvs_data`、离线 `.bin` 导出器、已废弃的
/// `VisData::visible_clusters` —— 都必须经由此处，保证解码与引擎一致。
///
/// # 参数
/// - `vis_data`: 原始 `VIS` lump 字节。
/// - `offset`: 该 cluster 的 PVS 行在 `vis_data` 内的字节偏移。
/// - `cluster_count`: 地图中 cluster 总数。
/// - `_bytes_per_row`: `(cluster_count + 7) / 8`；此处未用（行起始由 `row_offset` 给出），仅为保持调用方参数对称。
/// - `row_offset`: 该 cluster 的行在 `pvs_bits` 中的起始字节（通常 `source_cluster * bytes_per_row`）。
/// - `pvs_bits`: 调用方分配的、覆盖全部 cluster 的位图；这里写入当前 source cluster 的目标 cluster 位。
///   目标 `t` 的位在 `pvs_bits[row_offset + t/8]` 的第 `t % 8` 位（LSB 在前）。
///
/// # RLE 格式（`CM_DecompressVis`）
/// - 输出**每字节**覆盖 8 个 cluster。
/// - 非零字节 `b`：第 `i` 位为 1 ⇒ cluster `(cluster_index + i)` 可见。前进 8 个 cluster，消耗 1 字节。
/// - 零字节 `0x00`：RLE 转义；**下一**字节 `n` 是要跳过的全零字节数（每字节 = 一组 8 个不可见 cluster）。
///   前进 `n * 8` 个 cluster，消耗 2 字节。  ← `* 8` 是历史 bug 点。
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

#[derive(Debug, Clone, BinRead)]
pub struct VertNormal {
    pub normal: f32,
}

#[derive(Debug, Clone, BinRead)]
pub struct VertNormalIndex {
    pub index: i16,
}

pub struct Packfile {
    zip: Mutex<ZipArchive<Cursor<Vec<u8>>>>,
}

impl Clone for Packfile {
    fn clone(&self) -> Self {
        Packfile {
            zip: Mutex::new(self.zip.lock().unwrap().clone()),
        }
    }
}

impl Debug for Packfile {
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
    pub fn read(data: Cow<[u8]>) -> BspResult<Self> {
        let reader = Cursor::new(data.into_owned());
        let zip = Mutex::new(ZipArchive::new(reader)?);
        Ok(Packfile { zip })
    }

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

    pub fn into_zip(self) -> Mutex<ZipArchive<Cursor<Vec<u8>>>> {
        self.zip
    }
}

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
    fn as_quaternion(&self) -> Quaternion<f32> {
        // 角度按 roll、pitch、yaw 顺序应用
        Quaternion::from_angle_y(Deg(self.yaw))
            * Quaternion::from_angle_x(Deg(self.pitch))
            * Quaternion::from_angle_z(Deg(self.roll))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PVS RLE 解码：`0x00` 转义后的下一字节是**零字节**数（每字节 = 8 个不可见 cluster），
    /// 而非 cluster 数。`skip` 为 1 时必须前进 8 个 cluster，而非 1 —— 这就是历史 bug（VISLEAF-PVS.md）。
    #[test]
    fn decode_pvs_row_rle_skip_is_in_groups_of_8_clusters() {
        // cluster_count = 24 => bytes_per_row = 3。
        // 期望可见：clusters 0,1,2,3 与 16,17,18,19。
        // RLE（Source CM_DecompressVis）：
        //   byte0 = 0x0F -> clusters 0..7，bit 0..3 置位 => 0..3 可见
        //   byte1 = 0x00, byte2 = 0x01 -> RLE 转义：跳过 1 个零字节 = 8 个 cluster（8..15 不可见）
        //   byte3 = 0x0F -> clusters 16..23，bit 0..3 => 16..19 可见
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


// ── vector（并入自 vector.rs）──────────────────────────

#[derive(Debug, Clone, Copy, BinRead, Default)]
pub struct Vector {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vector {
    pub fn iter(&self) -> impl Iterator<Item = f32> {
        [self.x, self.y, self.z].into_iter()
    }

    pub fn length_squared(&self) -> f32 {
        self.x.powf(2.0) + self.y.powf(2.0) + self.z.powf(2.0)
    }
}

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

// ── prop（并入自 prop.rs）─────────────────────────────

#[derive(Debug, Clone)]
pub struct PropPlacement<'a> {
    pub model: &'a str,
    pub rotation: Quaternion<f32>,
    pub scale: f32,
    pub origin: Vector,
    pub skin: i32,
}

impl<'a> Handle<'a, StaticPropLump> {
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

// ── displacement（并入自 displacement.rs）──────────────

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
    pub fn vertex_count(&self) -> i32 {
        (2i32.pow(self.power as u32) + 1).pow(2)
    }

    pub fn triangle_count(&self) -> i32 {
        2 * 2i32.pow(self.power as u32).pow(2)
    }
}

#[test]
fn test_displacement_bytes() {
    test_read_bytes::<DisplacementInfo>();
}

static_assertions::const_assert_eq!(size_of::<DisplacementInfo>(), 176);

#[derive(Debug, Clone)]
pub struct DisplacementNeighbour {
    pub sub_neighbours: [Option<DisplacementSubNeighbour>; 2],
}

impl DisplacementNeighbour {
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

    // 非连接的 sub-neighbour 的朝向/跨度数据是垃圾值，直接跳过
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

#[derive(Debug, Clone, BinRead)]
pub struct DisplacementSubNeighbour {
    pub neighbour_index: u16,
    /// 邻居相对我们的朝向
    pub neighbour_orientation: NeighbourOrientation,
    /// 邻居如何嵌入我们
    pub span: NeighbourSpan,
    /// 我们如何嵌入邻居
    #[br(align_after = align_of::<DisplacementSubNeighbour>())]
    pub neighbour_span: NeighbourSpan,
}

#[test]
fn test_sub_neighbour_bytes() {
    test_read_bytes::<DisplacementSubNeighbour>();
}

static_assertions::const_assert_eq!(size_of::<DisplacementSubNeighbour>(), 6);
static_assertions::const_assert_eq!(align_of::<DisplacementSubNeighbour>(), 2);

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

#[derive(Debug, Clone, BinRead)]
pub struct DisplacementCornerNeighbour {
    neighbours: [u16; 4],
    #[br(align_after = align_of::< DisplacementCornerNeighbour > ())]
    neighbour_count: u8,
}

impl DisplacementCornerNeighbour {
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

#[derive(Debug, Clone, BinRead)]
pub struct DisplacementVertex {
    pub vector: Vector,
    pub distance: f32,
    pub alpha: f32,
}

impl DisplacementVertex {
    pub fn displacement(&self) -> Vector {
        self.vector * self.distance
    }
}

#[derive(Debug, Clone, BinRead)]
pub struct DisplacementTriangle {
    pub tags: DisplacementTriangleFlags,
}

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