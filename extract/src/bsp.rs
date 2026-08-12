//! Source 1 (CS:GO / Source 2004+) BSP 解析器(Rust 实现,参照 VPKEdit/sourcepp bsppp)。
//!
//! 核心思路与 C++ 版一致:VBSP 文件 = 头(签名 + 版本)+ 64 个 16 字节 lump 目录项 + mapRevision,
//! 每个 lump 按目录项 offset/length 切片;`uncompressedLength > 0` 表示该 lump 被 Valve LZMA 压缩。

use std::fmt;

/// BSP 签名 "VBSP" 小端读取后为 0x50534256("PSBV")。
pub const BSP_SIGNATURE: u32 = 0x5053_4256;
/// Console 变体签名 "PSBV"(大端文件,本实现不支持,检测后报错)。
pub const BSP_CONSOLE_SIGNATURE: u32 = 0x5642_5350;

/// 标准 Source 1 BSP 的 lump 数量。
pub const BSP_LUMP_COUNT: usize = 64;

/// BSP 版本(常见:v19/v20 = CS:S/HL2 系,v21 = CS:GO/L4D2/Portal2)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BspVersion(pub u32);

impl BspVersion {
    /// 是否属于 Source 1 家族(本解析器支持范围)。
    pub fn is_source1(self) -> bool {
        matches!(self.0, 19..=29)
    }
}

impl fmt::Display for BspVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// lump 目录项(16 字节)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LumpEntry {
    /// 数据在文件中的字节偏移。
    pub offset: u32,
    /// 数据长度(若被压缩则为压缩后长度)。
    pub length: u32,
    /// lump 格式版本。
    pub version: u32,
    /// 解压后长度;>0 表示该 lump 被 Valve LZMA 压缩。
    pub uncompressed_length: u32,
}

impl LumpEntry {
    /// 该 lump 是否存在(offset 与 length 均非 0)。
    #[inline]
    pub fn is_present(&self) -> bool {
        self.offset != 0 && self.length != 0
    }

    /// 是否被 LZMA 压缩。
    #[inline]
    pub fn is_compressed(&self) -> bool {
        self.uncompressed_length > 0
    }
}

/// 解析错误。
#[derive(Debug)]
pub enum BspError {
    #[allow(dead_code)]
    /// 文件过短。
    TooSmall(usize),
    /// 非法签名。
    BadSignature(u32),
    /// 不支持的 BSP 版本(console 大端或非 Source1)。
    UnsupportedVersion(u32),
    /// lump 越界。
    LumpOutOfBounds { index: usize, offset: u32, length: u32, filesize: usize },
    /// LZMA 解压失败。
    Lzma(String),
    /// I/O 错误。
    Io(String),
    /// 实体解析错误。
    Entity(String),
    /// zip 解析错误。
    Zip(String),
}

impl std::fmt::Display for BspError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BspError::TooSmall(n) => write!(f, "文件过短:需要至少 16 字节头,实际 {n}"),
            BspError::BadSignature(s) => write!(f, "非法签名:期望 VBSP,实际 0x{s:08X}"),
            BspError::UnsupportedVersion(v) => write!(f, "不支持的 BSP 版本 v{v}(console 大端或非 Source1)"),
            BspError::LumpOutOfBounds { index, offset, length, filesize } => {
                write!(f, "lump #{index} 越界:offset={offset} length={length} filesize={filesize}")
            }
            BspError::Lzma(e) => write!(f, "LZMA 解压失败:{e}"),
            BspError::Io(e) => write!(f, "I/O 错误:{e}"),
            BspError::Entity(e) => write!(f, "实体解析错误:{e}"),
            BspError::Zip(e) => write!(f, "zip 解析错误:{e}"),
        }
    }
}

impl std::error::Error for BspError {}

impl From<std::io::Error> for BspError {
    fn from(e: std::io::Error) -> Self {
        BspError::Io(e.to_string())
    }
}

/// 已解析的 BSP 头(签名 + 版本 + lump 目录 + mapRevision)。
#[derive(Debug, Clone)]
pub struct BspHeader {
    /// 原始版本号。
    pub version: u32,
    /// 64 个 lump 目录项。
    pub lumps: [LumpEntry; BSP_LUMP_COUNT],
    /// 地图修订号。
    pub map_revision: u32,
}

impl BspHeader {
    /// 从字节流解析 BSP 头。
    ///
    /// 布局(小端):
    /// - 0..4   "VBSP"
    /// - 4..8   version (u32)
    /// - 8..1032 64 × 16B lump 目录
    /// - 1032..1036 mapRevision (u32)
    pub fn parse(data: &[u8]) -> Result<Self, BspError> {
        const HEADER_SIZE: usize = 4 + 4 + BSP_LUMP_COUNT * 16 + 4; // 1036
        if data.len() < HEADER_SIZE {
            return Err(BspError::TooSmall(data.len()));
        }

        let signature = u32::from_le_bytes(data[0..4].try_into().unwrap());
        if signature != BSP_SIGNATURE {
            if signature == BSP_CONSOLE_SIGNATURE {
                return Err(BspError::UnsupportedVersion(0)); // console 大端
            }
            return Err(BspError::BadSignature(signature));
        }

        let version = u32::from_le_bytes(data[4..8].try_into().unwrap());

        let mut lumps = [LumpEntry::default(); BSP_LUMP_COUNT];
        let mut cursor = 8usize;
        for entry in lumps.iter_mut() {
            *entry = LumpEntry {
                offset: u32::from_le_bytes(data[cursor..cursor + 4].try_into().unwrap()),
                length: u32::from_le_bytes(data[cursor + 4..cursor + 8].try_into().unwrap()),
                version: u32::from_le_bytes(data[cursor + 8..cursor + 12].try_into().unwrap()),
                uncompressed_length: u32::from_le_bytes(data[cursor + 12..cursor + 16].try_into().unwrap()),
            };
            cursor += 16;
        }

        let map_revision = u32::from_le_bytes(data[cursor..cursor + 4].try_into().unwrap());

        Ok(BspHeader { version, lumps, map_revision })
    }
}

/// lump 索引常量(与 Source SDK 的 L 枚举一致,取值 0..64)。
pub mod lumps {
    pub const ENTITIES: usize = 0;
    pub const PLANES: usize = 1;
    pub const TEXDATA: usize = 2;
    pub const VERTEXES: usize = 3;
    pub const VISIBILITY: usize = 4;
    pub const NODES: usize = 5;
    pub const TEXINFO: usize = 6;
    pub const FACES: usize = 7;
    pub const LIGHTING: usize = 8;
    pub const LEAFS: usize = 10;
    pub const EDGES: usize = 12;
    pub const SURFEDGES: usize = 13;
    pub const MODELS: usize = 14;
    pub const LEAFFACES: usize = 16;
    pub const LEAFBRUSHES: usize = 17;
    pub const BRUSHES: usize = 18;
    pub const BRUSHSIDES: usize = 19;
    pub const DISPINFO: usize = 26;
    pub const ORIGINALFACES: usize = 27;
    pub const GAME_LUMP: usize = 35;
    pub const PAKFILE: usize = 40;
    pub const TEXDATA_STRING_DATA: usize = 43;
    pub const TEXDATA_STRING_TABLE: usize = 44;
    pub const DISP_TRIS: usize = 48;
}

/// 常用 lump 名称(供 CLI/调试显示)。
pub fn lump_name(index: usize) -> &'static str {
    const NAMES: [&str; BSP_LUMP_COUNT] = [
        "ENTITIES", "PLANES", "TEXDATA", "VERTEXES", "VISIBILITY", "NODES",
        "TEXINFO", "FACES", "LIGHTING", "OCCLUSION", "LEAFS", "FACEIDS",
        "EDGES", "SURFEDGES", "MODELS", "WORLDLIGHTS", "LEAFFACES", "LEAFBRUSHES",
        "BRUSHES", "BRUSHSIDES", "AREAS", "AREAPORTALS", "UNUSED0", "UNUSED1",
        "UNUSED2", "UNUSED3", "DISPINFO", "ORIGINALFACES", "PHYSDISP", "PHYSCOLLIDE",
        "VERTNORMALS", "VERTNORMALINDICES", "UNUSED4", "DISP_VERTS", "DISP_LIGHTMAP_ALPHAS",
        "GAME_LUMP", "LEAFWATERDATA", "PRIMITIVES", "PRIMVERTS", "PRIMINDICES",
        "PAKFILE", "CLIPPORTALVERTS", "CUBEMAPS", "TEXDATA_STRING_DATA", "TEXDATA_STRING_TABLE",
        "OVERLAYS", "LEAFMINDISTTOWATER", "FACE_MACRO_TEXTURE_INFO", "DISP_TRIS", "UNUSED5",
        "WATEROVERLAYS", "LEAF_AMBIENT_INDEX_HDR", "LEAF_AMBIENT_INDEX", "LIGHTING_HDR",
        "WORLDLIGHTS_HDR", "LEAF_AMBIENT_LIGHTING_HDR", "LEAF_AMBIENT_LIGHTING", "XBOX_XZIPPAKFILE",
        "FACES_HDR", "MAP_FLAGS", "OVERLAY_FADES", "OVERLAY_SYSTEM_LEVELS", "PHYSLEVEL",
        "DISP_MULTIBLEND",
    ];
    NAMES.get(index).copied().unwrap_or("UNKNOWN")
}

/// 按索引获取 lump 原始字节(不解压)。
///
/// 返回 `None` 表示该 lump 不存在(offset/length 为 0 或越界)。
pub fn raw_lump<'a>(data: &'a [u8], header: &BspHeader, index: usize) -> Result<Option<&'a [u8]>, BspError> {
    let Some(entry) = header.lumps.get(index) else {
        return Ok(None);
    };
    if !entry.is_present() {
        return Ok(None);
    }
    let start = entry.offset as usize;
    let end = start + entry.length as usize;
    if end > data.len() || start > data.len() {
        return Err(BspError::LumpOutOfBounds {
            index,
            offset: entry.offset,
            length: entry.length,
            filesize: data.len(),
        });
    }
    Ok(Some(&data[start..end]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造最小 BSP 头:签名 + 版本 + 64 空 lump + mapRevision。
    fn make_header(version: u32, map_revision: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity(1036);
        out.extend_from_slice(b"VBSP");
        out.extend_from_slice(&version.to_le_bytes());
        for _ in 0..BSP_LUMP_COUNT {
            out.extend_from_slice(&[0u8; 16]);
        }
        out.extend_from_slice(&map_revision.to_le_bytes());
        out
    }

    #[test]
    fn parses_basic_header() {
        let bytes = make_header(20, 7);
        let header = BspHeader::parse(&bytes).unwrap();
        assert_eq!(header.version, 20);
        assert_eq!(header.map_revision, 7);
        assert!(header.lumps.iter().all(|l| !l.is_present()));
    }

    #[test]
    fn rejects_bad_signature() {
        let mut bytes = make_header(20, 0);
        bytes[0] = b'X';
        assert!(matches!(BspHeader::parse(&bytes), Err(BspError::BadSignature(_))));
    }

    #[test]
    fn rejects_console_signature() {
        let mut bytes = make_header(20, 0);
        bytes[0..4].copy_from_slice(b"PSBV");
        assert!(matches!(BspHeader::parse(&bytes), Err(BspError::UnsupportedVersion(_))));
    }

    #[test]
    fn rejects_too_small() {
        assert!(matches!(BspHeader::parse(&[0u8; 100]), Err(BspError::TooSmall(_))));
    }

    #[test]
    fn version_source1_ranges() {
        assert!(BspVersion(19).is_source1());
        assert!(BspVersion(20).is_source1());
        assert!(BspVersion(21).is_source1());
        assert!(!BspVersion(5).is_source1());
        assert!(!BspVersion(30).is_source1());
    }

    #[test]
    fn raw_lump_slices_correctly() {
        let mut bytes = make_header(20, 0);
        // 在文件末尾追加数据,并让 lump[3] 指向它
        let data_offset = bytes.len() as u32;
        bytes.extend_from_slice(&[1u8, 2, 3, 4, 5, 6, 7, 8]);
        let lump_off = 8 + 3 * 16;        bytes[lump_off..lump_off + 4].copy_from_slice(&data_offset.to_le_bytes());
        bytes[lump_off + 4..lump_off + 8].copy_from_slice(&8u32.to_le_bytes());

        let header = BspHeader::parse(&bytes).unwrap();
        let lump = raw_lump(&bytes, &header, 3).unwrap().unwrap();
        assert_eq!(lump, &[1u8, 2, 3, 4, 5, 6, 7, 8]);
        assert!(raw_lump(&bytes, &header, 5).unwrap().is_none());
    }

    #[test]
    fn raw_lump_rejects_out_of_bounds() {
        let mut bytes = make_header(20, 0);
        let lump_off = 8; // lump[0] 目录项偏移
        bytes[lump_off..lump_off + 4].copy_from_slice(&100u32.to_le_bytes()); // offset 在界内
        bytes[lump_off + 4..lump_off + 8].copy_from_slice(&5000u32.to_le_bytes()); // end = 5100 > 1036 越界
        let header = BspHeader::parse(&bytes).unwrap();
        assert!(matches!(raw_lump(&bytes, &header, 0), Err(BspError::LumpOutOfBounds { .. })));
    }
}
