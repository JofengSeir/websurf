//! VTF 纹理解码：`.vtf` 字节 → `DynamicImage`（再由调用方编码成 PNG）。
//!
//! 上游：PAKFILE 里的 `.vtf` 条目字节（由调用方从 zip 取出）。
//! 下游：三个工程的 `crates/wasm/src/lib.rs` 里 `decode_vtf_to_png` 调 `from_bytes` 取
//! `highres_image` 再 `decode(0)` 编成 PNG。`apps/viewer` 也引用本模块（它不引用 `mosaic`）。
//!
//! **`bsp_to_gltf_core::materials` 不经过本模块**：那边用的是**外部 `vtf` crate** 的
//! `vtf::vtf::VTF`（依赖见 `src/wasm-core/Cargo.toml` 的 `vtf = "0.3"`），与本模块的 `VTF`
//! 是两套独立实现；本模块的 `VTF` 只被上面三个工程的 `decode_vtf_to_png` 使用。
//!
//! 职责：① `vtf::VTF::read` 读头并定位低清 / 高清图；② `image::VTFImage::decode` 按
//! `ImageFormat` 分发解码；③ 用 `Error` 把 IO、签名、格式、尺寸四类失败分开。
//!
//! 关键数字与坑：
//! - 魔数 `VTFHeader::SIGNATURE` = `0x00465456`，不符即 `InvalidSignature`。
//! - `decode` 有分支的格式只有 8 个：`Dxt1`、`Dxt1Onebitalpha`、`Dxt3`、`Dxt5`、
//!   `Rgba8888`、`Rgb888`、`Bgr888`、`Bgra8888`；其中 `Dxt1` 与 `Dxt1Onebitalpha` 都走
//!   BC1（不单独处理 1bit alpha）。其余格式一律 `UnsupportedImageFormat`。
//! - `frame_size` 的格式表与 `decode` 的分支表**口径不同**：前者还认识 `None` /
//!   `Abgr8888` / `Rgb565` / `I8` / `Ia88` / `A8` / `Argb8888` / `Rgba16161616f` /
//!   `Rgba16161616`，却**不含** `Dxt1Onebitalpha`。由于 `get_frame` 先调 `frame_size`，
//!   `decode` 里那条 `Dxt1Onebitalpha` 分支实际上取不到——该格式会先落到
//!   `UnsupportedImageFormat`。
//! - `create` 要求宽高都是 2 的幂且 ≤ `u16::MAX`，否则 `InvalidImageSize`。
//! - `UnsupportedEncodeImageFormat` 在本仓**没有构造点**（只保留在枚举里）。
//!
//! 边界：只解析 VTF 头与解码像素。不生成 mipmap、不改写 VTF、不读 zip；唯一会落盘的是
//! `VTF::save_as_png`，三个工程的调用点都不用它。
//!
//! 测试归属：`mod.rs` / `image.rs` / `vtf.rs` 均无 `#[test]`。
#![allow(dead_code)]
/// VTF 图像：`ImageFormat` 的逐格式尺寸表与像素解码。
pub mod image;
/// VTF 文件头、VTF 7.3 资源表与 mip 偏移计算。
pub mod vtf;

/// 解码结果的图像类型（`image` crate 的 `DynamicImage`，本模块不另立图像类型）。
pub use crate::texture_utils::image::DynamicImage;
/// VTF 图像格式枚举（判别值与 VTF 头里的 `i16` 一一对应）。
pub use crate::texture_utils::image::ImageFormat;
use crate::texture_utils::vtf::VTF;
use num_enum::TryFromPrimitiveError;
use thiserror::Error;

/// VTF 读取与解码的全部失败原因。
///
/// 变体即失败类别，调用方按类别处理即可；`#[error(...)]` 的文案是英文，属对外错误信息。
#[derive(Debug, Error)]
pub enum Error {
    /// 底层 IO 失败（`Cursor` / 文件读写）。
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    /// 头 4 字节不等于 `VTFHeader::SIGNATURE`。
    #[error("File does not have a valid vtf signature")]
    InvalidSignature,
    /// 头里的图像格式字段（原始 `i16`）不在 `ImageFormat` 的判别值里。
    #[error("File does not have a valid vtf image format: {0}")]
    InvalidImageFormat(i16),
    /// `image` crate 报错（例如 `save_as_png` 的 PNG 编码）。
    #[error("Error manipulating image data: {0}")]
    Image(#[from] ::image::ImageError),
    /// 该格式在本模块的解码分支或尺寸表里没有条目。
    #[error("Decoding {0} images is not supported")]
    UnsupportedImageFormat(ImageFormat),
    /// `ImageBuffer::from_raw` 判缓冲放不下 `width × height` 个像素。
    #[error("Decoded image data does not have the expected size")]
    InvalidImageData,
    /// `VTF::create` 入参边长不是 2 的幂，或超过 `u16::MAX`。
    #[error("Image size needs to be a power of 2 and below 2^16")]
    InvalidImageSize,
    /// 编码不支持的格式。**本仓没有构造点**，仅作为错误分类保留。
    #[error("Encoding {0} images is not supported")]
    UnsupportedEncodeImageFormat(ImageFormat),
}

/// 把 `num_enum` 的判别值转换失败转成 `InvalidImageFormat`，原样带上出错的 `i16`。
impl From<TryFromPrimitiveError<image::ImageFormat>> for Error {
    fn from(err: TryFromPrimitiveError<image::ImageFormat>) -> Self {
        Error::InvalidImageFormat(err.number)
    }
}

/// 解析 `.vtf` 字节，返回头 + 低清图 + 高清图三个视图（均借用同一份 `bytes`）。
///
/// 只读头与偏移，**不解码像素**：像素要再调 `VTFImage::decode`。任何结构不符返回 `Err`。
/// 不做尺寸校验——图幅是否与字节长度自洽由 `decode` 阶段的 `frame_size` 决定。
pub fn from_bytes(bytes: &[u8]) -> Result<VTF<'_>, Error> {
    VTF::read(bytes)
}

/// 由图像生成 VTF 字节（编码方向；本仓内**无调用点**，靠文件头的 `allow(dead_code)` 保留）。
///
/// 入参：`image`（只读它的宽高）、`image_format`（写进头的高清图格式）。
/// 预处理：宽高必须都是 2 的幂且 ≤ `u16::MAX`，否则 `InvalidImageSize`。
/// 产出：**只有文件头**（版本写死 `[7, 1]`、`mipmap_count = 1`、无图像数据）。
pub fn create(image: DynamicImage, image_format: ImageFormat) -> Result<Vec<u8>, Error> {
    VTF::create(image, image_format)
}
