//! BSP 文件头与 lump 目录（`BspFile`）。
//!
//! 上游：调用方把整份 `.bsp` 字节以切片传入，唯一构造点在 `vbsp/mod.rs` 的
//! `BspFile::new`。
//! 下游：`lump_reader` / `get_lump` / `lump_entry` 供 `vbsp/mod.rs` 与各数据段解析器
//! 按 lump 取字节。
//!
//! 职责：① 校验 `VBSP` 魔数与版本区间；② 读出 64 项 lump 目录；③ 按目录项定位并取出
//! lump 字节，`ident != 0` 时做 LZMA 解压。
//!
//! 关键不变量与坑：
//! - 目录项固定 **64** 项：`LumpType` 有 64 个变体，由
//!   `const_assert_eq!(LumpType::DisplacementMultiBlend as usize, 63)` 在编译期钉死。
//! - `length` 是盘上长度；`ident` 非 0 时是**解压后**长度——两者不可混用。
//! - 版本区间为 19..=29，越界或魔数不符一律返回 `UnexpectedHeader`，没有兼容降级分支。
//! - 本文件不解释任何 lump 的内部布局，那是 `data/**` 的职责。
//!
//! 测试归属：本文件无 `#[test]`；BSP 相关测试在 `vbsp/mod.rs`、`vbsp/data/mod.rs`、
//! `vbsp/data/game.rs` 内联。

use crate::vbsp::*;
use binrw::io::Cursor;
use binrw::BinReaderExt;
use std::borrow::Cow;

/// 一份已校验的 BSP：持有原始字节（零拷贝）+ 已解析的表头与 64 项 lump 目录。
/// 只解析"目录"，不解析任何 lump 内容——那是 `data/**` 的工作。
pub struct BspFile<'a> {
    data: &'a [u8],
    directories: Directories,
    header: Header,
}

impl<'a> BspFile<'a> {
    /// 校验并解析表头：读 `VBSP` 魔数与版本号，校验通过后再读 64 项 lump 目录。
    ///
    /// 失败条件（都返回 `UnexpectedHeader`，不区分是魔数错还是版本越界）：
    /// 魔数不等于 `VBSP`，或版本不在 19..=29 内。
    /// 本方法**不**校验各 lump 的 offset/length 是否落在 `data` 内——那一步推迟到
    /// `get_lump` 真正取字节时。
    pub fn new(data: &'a [u8]) -> BspResult<Self> {
        const EXPECTED_HEADER: Header = Header {
            v: b'V',
            b: b'B',
            s: b'S',
            p: b'P',
        };
        // 接受的版本区间（含两端）。本文件只用区间检查版本，不用它选结构体布局；
        // 记录大小由 `data/mod.rs` 的编译期断言固定（`Node` 32B、`Leaf` 32B、`Face` 56B）。
        // 目录项自带的 lump version 会被 `lump_reader` 透传给 `LumpReader`。
        const VERSION_MIN: u32 = 19;
        const VERSION_MAX: u32 = 29;

        let mut cursor = Cursor::new(data);
        let header: Header = cursor.read_le()?;
        let version: u32 = cursor.read_le()?;

        if header != EXPECTED_HEADER || !(VERSION_MIN..=VERSION_MAX).contains(&version) {
            return Err(BspError::UnexpectedHeader(header));
        }

        let directories = cursor.read_le()?;

        Ok(BspFile {
            data,
            directories,
            header,
        })
    }

    /// 返回解析时读到的魔数（`v`/`b`/`s`/`p` 四个字节，正常即 `VBSP`）。
    pub fn header(&self) -> &Header {
        &self.header
    }

    /// 按目录项定位某个 lump，并包成一个带该 lump 版本号的 `LumpReader`。
    /// 取字节这一步走 `get_lump`，因此同样会做越界检查与 LZMA 解压。
    pub fn lump_reader(&self, lump: LumpType) -> BspResult<LumpReader<Cursor<Cow<'_, [u8]>>>> {
        let lump_entry = &self.directories[lump];
        let data = self.get_lump(lump)?;
        Ok(LumpReader::new(data, lump, lump_entry.version))
    }

    /// 只读返回某个 lump 的目录项副本。
    ///
    /// 字段语义：`offset` / `length` 是**盘上**位置与长度；`ident` 非 0 表示该 lump 被
    /// LZMA 封装，此时 `ident` 是**解压后**长度（判断与解压都在 `get_lump` 里）；
    /// `version` 是该 lump 自身的版本号。
    ///
    /// 用途：`vbsp/mod.rs`用它取出 LDR 与 HDR 两份光照目录项，再决定实际采用哪一份。
    pub fn lump_entry(&self, lump: LumpType) -> LumpEntry {
        self.directories[lump]
    }

    /// 取某个 lump 的字节。
    ///
    /// 行为：按 `offset..offset+length` 切片，越界返回 `LumpOutOfBounds`；
    /// `ident == 0` 时**零拷贝**返回借用切片；`ident != 0` 时按 `ident` 声明的解压后长度
    /// 做 LZMA 解压，返回 owned 数据。
    ///
    /// 不做缓存——每次调用都重新解压；需要复用请自行持有返回值。
    pub fn get_lump(&self, lump: LumpType) -> BspResult<Cow<'_, [u8]>> {
        let lump = &self.directories[lump];
        let raw_data = self
            .data
            .get(lump.offset as usize..lump.offset as usize + lump.length as usize)
            .ok_or(BspError::LumpOutOfBounds(*lump))?;

        Ok(match lump.ident {
            0 => Cow::Borrowed(raw_data),
            _ => {
                let data = lzma_decompress_with_header(raw_data, lump.ident as usize)?;
                Cow::Owned(data)
            }
        })
    }
}

/// lump 目录下标。变体顺序与 BSP 目录项一一对应，共 **64** 项；`#[repr(C)]` 使判别值
/// 等于声明序号，所以可以直接用 `self.directories[lump]` 这种方式当数组下标。
/// 末项索引 63 由本文件末尾的编译期断言钉死。`#[allow(dead_code)]` 是因为并非每个
/// lump 都被当前解析路径取用。
#[allow(dead_code)]
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum LumpType {
    Entities,
    Planes,
    TextureData,
    Vertices,
    Visibility,
    Nodes,
    TextureInfo,
    Faces,
    Lighting,
    Occlusion,
    Leaves,
    FaceIds,
    Edges,
    SurfaceEdges,
    Models,
    WorldLights,
    LeafFaces,
    LeafBrushes,
    Brushes,
    BrushSides,
    Areas,
    AreaPortals,
    Unused0,
    Unused1,
    Unused2,
    Unused3,
    DisplacementInfo,
    OriginalFaces,
    PhysDisplacement,
    PhysCollide,
    VertNormals,
    VertNormalIndices,
    DisplacementLightMapAlphas,
    DisplacementVertices,
    DisplacementLightMapSamplePositions,
    GameLump,
    LeafWaterData,
    Primitives,
    PrimVertices,
    PrimIndices,
    PakFile,
    ClipPortalVertices,
    CubeMaps,
    TextureDataStringData,
    TextureDataStringTable,
    Overlays,
    LeafMinimumDistanceToWater,
    FaceMacroTextureInfo,
    DisplacementTris,
    PhysicsCollideSurface,
    WaterOverlays,
    LeafAmbientIndexHdr,
    LeafAmbientIndex,
    LightingHdr,
    WorldLightsHdr,
    LeafAmbientLightingHdr,
    LeafAmbientLighting,
    XZipPakFile,
    FacesHdr,
    MapFlags,
    OverlayFades,
    OverlaySystemLevels,
    PhysLevel,
    DisplacementMultiBlend,
}

static_assertions::const_assert_eq!(LumpType::DisplacementMultiBlend as usize, 63);
