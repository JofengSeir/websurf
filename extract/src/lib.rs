//! # bsp-extract
//!
//! 独立实现的 Source 1 (CS:GO) BSP 解包器(Rust 版),功能对齐 VPKEdit/sourcepp 的 bsppp:
//!
//! - [`BspFile`]:解析 VBSP 头 + 64 个 lump 目录,按需切片/解压任意 lump
//! - [`lzma`]:Valve LZMA 17 字节头格式解压
//! - [`pak`]:PAKFILE(zip)枚举/提取、ENTITIES 实体文本解析
//!
//! 全部依赖为纯 Rust crate(lzma-rs / zip),可编译到 wasm32-unknown-unknown。
//! 本 crate 完全独立于仓库其他工程,不依赖 `websurf-wasm-core`。

pub mod bsp;
pub mod glb;
pub mod lzma;
pub mod pak;
pub mod scene;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use bsp::{lump_name, lumps, BspError, BspHeader, BspVersion, LumpEntry, BSP_LUMP_COUNT};
pub use pak::{open_pak, parse_entities, pak_extract, list_pak_entries, Entity, PakEntryInfo};

use std::io::Cursor;
use zip::ZipArchive;

/// 已加载的 BSP 文件:持有全部字节 + 解析后的头。
///
/// 与 sourcepp `bsppp::BSP` 对应,但数据常驻内存(适合 wasm/网页场景)。
#[derive(Debug, Clone)]
pub struct BspFile {
    data: Vec<u8>,
    header: BspHeader,
}

impl BspFile {
    /// 从文件字节加载并解析头。
    pub fn new(data: Vec<u8>) -> Result<Self, BspError> {
        let header = BspHeader::parse(&data)?;
        let version = BspVersion(header.version);
        if !version.is_source1() {
            return Err(BspError::UnsupportedVersion(header.version));
        }
        Ok(BspFile { data, header })
    }

    /// 从磁盘路径加载。
    pub fn from_path(path: &str) -> Result<Self, BspError> {
        let data = std::fs::read(path)?;
        Self::new(data)
    }

    /// 版本号。
    #[inline]
    pub fn version(&self) -> u32 {
        self.header.version
    }

    /// mapRevision。
    #[inline]
    pub fn map_revision(&self) -> u32 {
        self.header.map_revision
    }

    /// 头信息。
    #[inline]
    pub fn header(&self) -> &BspHeader {
        &self.header
    }

    /// 某 lump 的目录项。
    #[inline]
    pub fn lump_entry(&self, index: usize) -> Option<&LumpEntry> {
        self.header.lumps.get(index)
    }

    /// 是否含有某 lump。
    #[inline]
    pub fn has_lump(&self, index: usize) -> bool {
        self.lump_entry(index).is_some_and(|l| l.is_present())
    }

    /// 某 lump 是否被 LZMA 压缩。
    #[inline]
    pub fn is_lump_compressed(&self, index: usize) -> bool {
        self.lump_entry(index).is_some_and(|l| l.is_compressed())
    }

    /// 获取 lump 数据(自动 Valve LZMA 解压)。
    ///
    /// `no_decompress = true` 时返回原始字节(压缩态原样)。
    pub fn lump_data(&self, index: usize, no_decompress: bool) -> Result<Option<Vec<u8>>, BspError> {
        let Some(raw) = bsp::raw_lump(&self.data, &self.header, index)? else {
            return Ok(None);
        };
        if no_decompress {
            return Ok(Some(raw.to_vec()));
        }
        if self.is_lump_compressed(index) {
            Ok(Some(lzma::decompress_valve_lzma(raw)?))
        } else {
            Ok(Some(raw.to_vec()))
        }
    }

    /// 打开 PAKFILE 为 zip 归档。
    pub fn open_pak(&self) -> Result<Option<ZipArchive<Cursor<Vec<u8>>>>, BspError> {
        let Some(raw) = bsp::raw_lump(&self.data, &self.header, lumps::PAKFILE)? else {
            return Ok(None);
        };
        // PAKFILE 永不套 LZMA(引擎侧即 zip);若个别地图异常压缩则容错
        let bytes = if raw.len() >= 4 && &raw[0..4] == b"LZMA" {
            lzma::decompress_valve_lzma(raw)?
        } else {
            raw.to_vec()
        };
        Ok(Some(open_pak(bytes)?))
    }

    /// 枚举 PAKFILE 全部条目。
    pub fn pak_entries(&self) -> Result<Vec<PakEntryInfo>, BspError> {
        let mut zip = self.open_pak()?.ok_or_else(|| {
            BspError::Zip("该 BSP 没有 PAKFILE lump".into())
        })?;
        list_pak_entries(&mut zip)
    }

    /// 按路径提取 PAKFILE 内文件(大小写不敏感)。
    pub fn pak_extract(&self, name: &str) -> Result<Option<Vec<u8>>, BspError> {
        let mut zip = self.open_pak()?.ok_or_else(|| {
            BspError::Zip("该 BSP 没有 PAKFILE lump".into())
        })?;
        pak::pak_extract(&mut zip, name)
    }

    /// 解析实体。
    pub fn entities(&self) -> Result<Vec<Entity>, BspError> {
        let Some(data) = self.lump_data(lumps::ENTITIES, false)? else {
            return Ok(Vec::new());
        };
        let text = String::from_utf8(data)
            .map_err(|e| BspError::Entity(format!("实体 lump 非 UTF-8:{e}")))?;
        parse_entities(&text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_rejects_non_source1_version() {
        let mut bytes = vec![0u8; 1036];
        bytes[0..4].copy_from_slice(b"VBSP");
        bytes[4..8].copy_from_slice(&30u32.to_le_bytes());
        assert!(BspFile::new(bytes).is_err());
    }
}
