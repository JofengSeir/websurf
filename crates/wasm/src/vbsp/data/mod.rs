// vbsp 子模块：保留完整解析语义，允许未使用项
#![allow(dead_code)]

mod displacement;
mod entity;
mod game;
mod prop;
mod vector;

pub use self::displacement::*;
pub use self::entity::*;
pub use self::game::*;

pub use self::vector::*;
use crate::vbsp::bspfile::LumpType;
use crate::vbsp::error::EntityParseError;
use crate::vbsp::{BspResult, StringError};
use arrayvec::ArrayString;
use binrw::error::CustomError;
use binrw::{BinRead, BinResult, Endian};
use bitflags::bitflags;
use bv::BitVec;
use cgmath::{Deg, Quaternion, Rotation3};
use num_enum::{TryFromPrimitive, TryFromPrimitiveError};
use serde::de::{Error, Unexpected};
use serde::{Deserialize, Deserializer};
use std::borrow::Cow;
use std::cmp::min;
use std::fmt;
use std::fmt::{Debug, Display, Formatter};
use std::io::{Cursor, Read, Seek};
use std::mem::{align_of, size_of};
use std::ops::Index;
use std::str::FromStr;
use std::sync::Mutex;
use zip::result::ZipError;
use zip::ZipArchive;

/// Validate that reading the type consumes `size_of::<T>()` bytes
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
        const LIGHT      = 0b0000_0000_0000_0000_0001; // value will hold the light strength
        const SKY2D      = 0b0000_0000_0000_0000_0010; // don't draw, indicate we should skylight + draw 2d sky but don't draw the 3d skybox
        const SKY        = 0b0000_0000_0000_0000_0100; // don't draw, but add the skybox
        const WARP       = 0b0000_0000_0000_0000_1000; // turbulent water warp
        const TRANS      = 0b0000_0000_0000_0001_0000; // texture is translucent
        const NOPORTAL   = 0b0000_0000_0000_0010_0000; // the surface can't have a portal placed on it
        const TRIGGER    = 0b0000_0000_0000_0100_0000; // xbox hack to work around elimination of trigger surfaces
        const NODRAW     = 0b0000_0000_0000_1000_0000; // don't bother referencing the texture
        const HINT       = 0b0000_0000_0001_0000_0000; // make a primary bsp splitter
        const SKIP       = 0b0000_0000_0010_0000_0000; // completely ignore, allowing non-closed brushes
        const NOLIGHT    = 0b0000_0000_0100_0000_0000; // dont calculate light
        const BUMPLIGHT  = 0b0000_0000_1000_0000_0000; // calculate thee light maps for the surface for bump mapping
        const NOSHADOWS  = 0b0000_0001_0000_0000_0000; // don't receive shadows
        const NODECALS   = 0b0000_0010_0000_0000_0000; // don't receive decals
        const NOCHOP     = 0b0000_0100_0000_0000_0000; // don't subdivide patches on this surface
        const HITBOX     = 0b0000_1000_0000_0000_0000; // surface is part of a hitbox
    }
}

/// Fixed length, null-terminated string
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
    // first 9 bits is area, last 7 bits is flags
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
        const EMPTY =       	        0; // 	No contents
        const SOLID =       	        0x1; // 	an eye is never valid in a solid
        const WINDOW =      	        0x2; // 	translucent, but not watery (glass)
        const AUX =         	        0x4;
        const GRATE =       	        0x8; // 	alpha-tested "grate" textures. Bullets/sight pass through, but solids don't
        const SLIME =       	        0x10;
        const WATER =       	        0x20;
        const MIST =        	        0x40;
        const OPAQUE =      	        0x80; // 	block AI line of sight
        const TESTFOGVOLUME =          0x100; // 	things that cannot be seen through (may be non-solid though)
        const UNUSED =      	        0x200; // 	unused
        const UNUSED6 =                0x400; // 	unused
        const TEAM1 =       	        0x800; // 	per team contents used to differentiate collisions between players and objects on different teams
        const TEAM2 =       	        0x1000;
        const IGNORE_NODRAW_OPAQUE =   0x2000; // 	ignore CONTENTS_OPAQUE on surfaces that have SURF_NODRAW
        const MOVEABLE =               0x4000; // 	hits entities which are MOVETYPE_PUSH (doors, plats, etc.)
        const AREAPORTAL =             0x8000; // 	remaining contents are non-visible, and don't eat brushes
        const PLAYERCLIP =             0x10000;
        const MONSTERCLIP =            0x20000;
        const CURRENT_0 =              0x40000; // 	currents can be added to any other contents, and may be mixed
        const CURRENT_90 =             0x80000;
        const CURRENT_180 =            0x100000;
        const CURRENT_270 =            0x200000;
        const CURRENT_UP =             0x400000;
        const CURRENT_DOWN =           0x800000;
        const ORIGIN =      	        0x1000000; // 	removed before bsping an entity
        const MONSTER =                0x2000000; // 	should never be on a brush, only in game
        const DEBRIS =      	        0x4000000;
        const DETAIL =      	        0x8000000; // 	brushes to be added after vis leafs
        const TRANSLUCENT =            0x10000000; // 	auto set if any surface has trans
        const LADDER =      	        0x20000000;
        const HITBOX =      	        0x40000000; // 	use accurate hitboxes on trace
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

/// Decode one Source-engine RLE-compressed VIS row into a visibility bitmap.
///
/// This is the single canonical implementation of Source's `CM_DecompressVis`
/// (see `docs/VISLEAF-PVS.md`). All PVS paths — the WASM `parse_pvs_data`,
/// the offline `.bin` exporter, and the deprecated `VisData::visible_clusters`
/// — must route through this so the decoded visibility matches the engine.
///
/// # Arguments
/// - `vis_data`: the raw `VIS` lump bytes.
/// - `offset`: byte offset of this cluster's PVS row inside `vis_data`.
/// - `cluster_count`: total number of clusters in the map.
/// - `_bytes_per_row`: `(cluster_count + 7) / 8`; unused here (the row start is
///   given by `row_offset`), kept for API symmetry with callers.
/// - `row_offset`: byte offset where this cluster's row begins inside `pvs_bits`
///   (normally `source_cluster * bytes_per_row`).
/// - `pvs_bits`: caller-allocated bitmap for ALL clusters; this writes the
///   target-cluster bits for the current source cluster. Bit for target `t` is
///   `pvs_bits[row_offset + t/8]`, bit `t % 8` (LSB-first).
///
/// # RLE format (`CM_DecompressVis`)
/// - Each output **byte** covers 8 clusters.
/// - Non-zero byte `b`: bit `i` set ⇒ cluster `(cluster_index + i)` visible.
///   Advance 8 clusters, consume 1 byte.
/// - Zero byte `0x00`: RLE escape; the **next** byte `n` is the number of
///   all-zero bytes (each = a group of 8 invisible clusters) to skip.
///   Advance `n * 8` clusters, consume 2 bytes.  ← the `* 8` is the historical bug.
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
            break; // ran out of compressed bytes — leave remaining clusters invisible
        }
        let byte = pvs_buffer[buffer_index];
        if byte == 0 {
            // RLE escape: next byte = number of *zero bytes* (8-cluster groups) to skip.
            if buffer_index + 1 >= pvs_buffer.len() {
                break;
            }
            let skip_bytes = pvs_buffer[buffer_index + 1] as u32;
            cluster_index += skip_bytes * 8; // FIX: skip is in units of 8-cluster groups
            buffer_index += 2;
        } else {
            // 8 clusters of visibility encoded as a bitmask.
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
        // angles are applied in roll, pitch, yaw order
        Quaternion::from_angle_y(Deg(self.yaw))
            * Quaternion::from_angle_x(Deg(self.pitch))
            * Quaternion::from_angle_z(Deg(self.roll))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PVS RLE decode: the `0x00` escape's next byte is a count of *zero bytes*
    /// (each = 8 invisible clusters), not a cluster count. A `skip` of 1 must
    /// advance 8 clusters, not 1. This is the historical bug (VISLEAF-PVS.md).
    #[test]
    fn decode_pvs_row_rle_skip_is_in_groups_of_8_clusters() {
        // cluster_count = 24 => bytes_per_row = 3.
        // Want visible: clusters 0,1,2,3 and 16,17,18,19.
        // RLE (Source CM_DecompressVis):
        //   byte0 = 0x0F -> clusters 0..7, bits 0..3 set => 0..3 visible
        //   byte1 = 0x00, byte2 = 0x01 -> RLE escape: skip 1 zero-byte = 8 clusters (8..15 invisible)
        //   byte3 = 0x0F -> clusters 16..23, bits 0..3 => 16..19 visible
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
