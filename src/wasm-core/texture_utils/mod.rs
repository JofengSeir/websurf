// 迁移自 texture-utils：作为模块并入。WASM 仅用解码路径，保留编码 API 结构。
#![allow(dead_code)]
pub mod header;
pub mod image;
pub mod resources;
mod utils;
pub mod vtf;

pub use crate::texture_utils::image::DynamicImage;
pub use crate::texture_utils::image::ImageFormat;
use crate::texture_utils::vtf::VTF;
use num_enum::TryFromPrimitiveError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("File does not have a valid vtf signature")]
    InvalidSignature,
    #[error("File does not have a valid vtf image format: {0}")]
    InvalidImageFormat(i16),
    #[error("Error manipulating image data: {0}")]
    Image(#[from] ::image::ImageError),
    #[error("Decoding {0} images is not supported")]
    UnsupportedImageFormat(ImageFormat),
    #[error("Decoded image data does not have the expected size")]
    InvalidImageData,
    #[error("Image size needs to be a power of 2 and below 2^16")]
    InvalidImageSize,
    #[error("Encoding {0} images is not supported")]
    UnsupportedEncodeImageFormat(ImageFormat),
}

impl From<TryFromPrimitiveError<image::ImageFormat>> for Error {
    fn from(err: TryFromPrimitiveError<image::ImageFormat>) -> Self {
        Error::InvalidImageFormat(err.number)
    }
}

pub fn from_bytes(bytes: &[u8]) -> Result<VTF<'_>, Error> {
    VTF::read(bytes)
}

pub fn create(image: DynamicImage, image_format: ImageFormat) -> Result<Vec<u8>, Error> {
    VTF::create(image, image_format)
}
