//! BSP 解析层的错误分类（`BspError`）与各子错误类型。
//!
//! 上游：`vbsp` 下的解析函数一律返回 `BspResult<T>`（`Result<T, BspError>`）。
//! 下游：各工程 `crates/wasm` 的导出层把它转成 JS 侧异常。
//!
//! 职责：把 `binrw` 读错误、LZMA 解压错误、zip 错误、UTF-8 错误与 BSP 语义校验失败
//! 收敛到同一个枚举，让调用方按类别处理。
//!
//! 关键不变量与坑：
//! - `BspError` 是 `#[non_exhaustive]`：外部 crate 匹配时必须带 `_` 分支。
//! - `From<binrw::Error>` 对**无法识别的自定义错误**走 `panic!`——这是刻意的 fail-loud，
//!   代价是解析期存在 panic 路径，而不是一律返回 `Err`。
//! - `LumpOutOfBounds` / `GameLumpOutOfBounds` 携带出错的目录项本身，便于定位。
//! - `InvalidLumpSize` 的语义是"lump 长度不是记录大小的整数倍"，不是"越界"。
//!
//! 边界：本文件只定义错误类型与转换，不含解析逻辑。`#[error(...)]` 的文案是英文，
//! 属于对外错误信息，不随文档语言变化。
//!
//! 测试归属：本文件无 `#[test]`。

use crate::vbsp::bspfile::LumpType;
use crate::vbsp::data::*;
use std::num::{ParseFloatError, ParseIntError};
use thiserror::Error;
use zip::result::ZipError;

/// BSP 解析的全部失败原因。`#[non_exhaustive]`：新增变体不算破坏性变更，
/// 但外部 crate 匹配时必须保留 `_` 分支。
#[non_exhaustive]
#[derive(Debug, Error)]
pub enum BspError {
    #[error("unexpected magic numbers or version")]
    UnexpectedHeader(Header),
    #[error("bsp lump is out of bounds of the bsp file")]
    LumpOutOfBounds(LumpEntry),
    #[error("bsp game lump is out of bounds of the bsp file")]
    GameLumpOutOfBounds(GameLump),
    #[error("compressed game lump is malformed")]
    MalformedCompressedGameLump,
    #[error("Invalid lump size, lump size {lump_size} is not a multiple of the element size {element_size}")]
    InvalidLumpSize {
        lump: LumpType,
        element_size: usize,
        lump_size: usize,
    },
    #[error("unexpected length of uncompressed lump, got {got} but expected {expected}")]
    UnexpectedUncompressedLumpSize { got: u32, expected: u32 },
    #[error("unexpected length of compressed lump, got {got} but expected {expected}")]
    UnexpectedCompressedLumpSize { got: u32, expected: u32 },
    #[error("error while decompressing lump")]
    LumpDecompressError(lzma_rs::error::Error),
    #[error("io error while reading data: {0}")]
    IO(#[from] std::io::Error),
    #[error(transparent)]
    String(#[from] StringError),
    #[error("Malformed field found while parsing: {0:#}")]
    MalformedData(binrw::Error),
    #[error("bsp file is well-formed but contains invalid data")]
    Validation(#[from] ValidationError),
    #[error(transparent)]
    LumpVersion(UnsupportedLumpVersion),
    #[error(transparent)]
    Zip(#[from] ZipError),
}

/// 把 `binrw` 的读错误映射成 `BspError`。
///
/// 分派规则：回溯错误先解包再递归；IO 错误转 `IO`；`Custom` 里只认得
/// `StringError` / `UnsupportedLumpVersion` / `InvalidNeighbourError` 三种（它们由本 crate
/// 自己构造），其余一律 `panic!`；剩下的原样包成 `MalformedData`。
impl From<binrw::Error> for BspError {
    fn from(e: binrw::Error) -> Self {
        use binrw::Error;

        // 只有这几种自定义错误由本 crate 构造，故只需在此识别它们
        match e {
            Error::Backtrace(trace) => Self::from(*trace.error),
            Error::Io(e) => BspError::IO(e),
            Error::Custom { err, .. } => {
                if err.is::<StringError>() {
                    BspError::String(*err.downcast::<StringError>().unwrap())
                } else if err.is::<UnsupportedLumpVersion>() {
                    BspError::LumpVersion(*err.downcast::<UnsupportedLumpVersion>().unwrap())
                } else if err.is::<InvalidNeighbourError>() {
                    BspError::Validation(ValidationError::Neighbour(
                        *err.downcast::<InvalidNeighbourError>().unwrap(),
                    ))
                } else {
                    panic!("unexpected custom error")
                }
            }
            e => BspError::MalformedData(e),
        }
    }
}

/// 把 LZMA 解压错误映射成 `BspError`：底层 IO 错误转 `IO`，其余归到 `LumpDecompressError`。
impl From<lzma_rs::error::Error> for BspError {
    fn from(e: lzma_rs::error::Error) -> Self {
        use lzma_rs::error::Error;

        match e {
            Error::IoError(e) => BspError::IO(e),
            e => BspError::LumpDecompressError(e),
        }
    }
}

/// 字符串类 lump 的读取失败：字节不是合法 UTF-8，或本应 NUL 结尾的字符串没有终止符。
#[derive(Debug, Error)]
pub enum StringError {
    #[error(transparent)]
    NonUTF8(#[from] std::str::Utf8Error),
    #[error("String is not null-terminated")]
    NotNullTerminated,
}

/// 某个 lump 的版本号不被当前解析路径支持；`lump_type` 是 lump 名称，用于报错定位。
#[derive(Debug, Error)]
#[error("Unsupported lump version {version} for {lump_type} lump")]
pub struct UnsupportedLumpVersion {
    pub lump_type: &'static str,
    pub version: u16,
}

/// 文件结构完整、但内容在语义上不成立——即"读得出来但用不了"。
/// 与 `MalformedData` 的区别：后者是字节层面读不出记录，本类是读完之后的校验失败。
#[derive(Debug, Error)]
pub enum ValidationError {
    #[error(
    "A {source_} indexes into {target} but the index {index} is out of range of the size {size}"
    )]
    ReferenceOutOfRange {
        source_: &'static str,
        target: &'static str,
        index: i64,
        size: usize,
    },
    #[error("bsp contains no root node")]
    NoRootNode,
    #[error("displacement face with {0} edges")]
    NonSquareDisplacement(i16),
    #[error("No static prop lump found")]
    NoStaticPropLump,
    #[error(transparent)]
    Neighbour(InvalidNeighbourError),
}

/// displacement 邻接关系非法：跨度或朝向取值超出允许范围。由 `ValidationError::Neighbour` 承载。
#[derive(Debug, Error)]
pub enum InvalidNeighbourError {
    #[error("Invalid neighbour span")]
    InvalidNeighbourSpan(u8),
    #[error("Invalid neighbour orientation")]
    InvalidNeighbourOrientation(u8),
}

/// 实体键值文本的解析失败：键不存在、元素个数不符，或数值字面量解析失败。
#[derive(Debug, Error)]
pub enum EntityParseError {
    #[error("no such property: {0}")]
    NoSuchProperty(&'static str),
    #[error("wrong number of elements")]
    ElementCount,
    #[error(transparent)]
    Float(#[from] ParseFloatError),
    #[error(transparent)]
    Int(#[from] ParseIntError),
}
