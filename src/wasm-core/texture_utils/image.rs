use crate::texture_utils::vtf::VTFHeader;
use crate::texture_utils::vtf::get_offset;
use crate::texture_utils::Error;
pub use image::{DynamicImage, ImageBuffer, Pixel};
use num_enum::TryFromPrimitive;
use parse_display::Display;
use std::ops::Deref;
use std::vec::Vec;
use texpresso::Format;

/// VTF 里一张图（低清图或高清图）的视图：头 + 格式 + 图幅 + 借用的字节切片 + 起始偏移。
///
/// `bytes` 与 `offset` 私有，取像素只能经 `get_frame` / `decode`；`header` 是整份头的克隆
/// （帧偏移计算要用到 `mipmap_count` / `frames` / `depth`）。
#[derive(Debug)]
pub struct VTFImage<'a> {
    /// 整份 VTF 头的克隆（低清图与高清图各持一份）。
    pub header: VTFHeader,
    /// 这张图的像素格式。
    pub format: ImageFormat,
    /// 图宽（像素）。低清图由头里的 `u8` 字段加宽而来。
    pub width: u16,
    /// 图高（像素）。
    pub height: u16,
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> VTFImage<'a> {
    /// 组装一个视图。`offset` 是这张图在 `bytes` 里的起始字节位置。
    ///
    /// 不做任何校验：`offset` 越界、格式与实际数据不符都留到 `get_frame` / `decode` 暴露。
    pub fn new(
        header: VTFHeader,
        format: ImageFormat,
        width: u16,
        height: u16,
        bytes: &'a [u8],
        offset: usize,
    ) -> VTFImage<'a> {
        VTFImage {
            header,
            format,
            width,
            height,
            bytes,
            offset,
        }
    }

    /// 取第 `frame` 帧的**原始字节**（未解码），长度 = `frame_size(width, height)`。
    ///
    /// 起始位置 = 本视图的 `offset` + `get_offset(header, format, frame, 0, 0, 0)`，
    /// 即 face / slice / mip 层都取 0。格式不支持时返回 `Err`；`bytes` 不够长时**直接
    /// panic**（切片索引，本函数不做边界检查）。
    pub fn get_frame(&self, frame: u32) -> Result<&[u8], Error> {
        let frame_size = self
            .format
            .frame_size(self.width as u32, self.height as u32)? as usize;
        let base: usize =
            self.offset + get_offset(&self.header, &self.format, frame, 0, 0, 0)? as usize;
        Ok(&self.bytes[base..base + frame_size])
    }

    /// 用 `texpresso` 把一块 BC 数据解成 `width × height × 4` 的 **RGBA8** 缓冲。
    ///
    /// 输出固定 4 通道，与 `variant` 是 BC1 还是 BC2/BC3 无关。不校验 `bytes` 长度，也不
    /// 校验它是否真的是 `variant` 对应的块数据。
    fn decode_dxt(&self, bytes: &[u8], variant: Format) -> Result<Vec<u8>, Error> {
        let mut output: Vec<u8> = vec![0; self.width as usize * self.height as usize * 4];
        variant.decompress(
            bytes,
            self.width as usize,
            self.height as usize,
            &mut output,
        );
        Ok(output)
    }

    /// 把裸缓冲按 `width × height` 包成 `DynamicImage`。
    ///
    /// `ImageBuffer::from_raw` 返回 `None`（缓冲长度不足以放下这么多像素）时给
    /// `InvalidImageData`。像素类型与容器由调用点传进来的构造函数决定
    /// （`DynamicImage::ImageRgba8` → `Rgba<u8>`，`ImageRgb8` → `Rgb<u8>`）。
    fn image_from_buffer<P, Container, F>(
        &self,
        buffer: Container,
        format: F,
    ) -> Result<DynamicImage, Error>
    where
        P: Pixel + 'static,
        P::Subpixel: 'static,
        Container: Deref<Target = [P::Subpixel]>,
        F: FnOnce(ImageBuffer<P, Container>) -> DynamicImage,
    {
        ImageBuffer::from_raw(self.width as u32, self.height as u32, buffer)
            .map(format)
            .ok_or(Error::InvalidImageData)
    }

    /// 解码第 `frame` 帧为 `DynamicImage`。
    ///
    /// 有分支的格式共 8 个：
    /// - `Dxt1` 与 `Dxt1Onebitalpha` → BC1、`Dxt3` → BC2、`Dxt5` → BC3，结果都是 RGBA8；
    /// - `Rgba8888` 原样按 RGBA8；`Rgb888` 原样按 RGB8；
    /// - `Bgr888` 与 `Bgra8888` 先按 4 字节块交换 B/R（`convert_bgra`），再按 `ImageRgb8`
    ///   解释。注意这两个格式的 `frame_size` 是 `w*h*3` 与 `w*h*4`，而 `ImageRgb8` 的缓冲
    ///   是每像素 3 字节——长度口径并不一致；
    /// - 其余格式（含 `Dxt1Onebitalpha` 之外的全部未列表格式）→ `UnsupportedImageFormat`。
    ///
    /// 不做：不选 mip 层（固定 0）、不做色彩空间转换、不处理 Bluescreen 变体。
    pub fn decode(&self, frame: u32) -> Result<DynamicImage, Error> {
        let bytes = self.get_frame(frame)?;
        match self.format {
            ImageFormat::Dxt1 => {
                let buf = self.decode_dxt(bytes, Format::Bc1)?;
                self.image_from_buffer(buf, DynamicImage::ImageRgba8)
            }
            ImageFormat::Dxt1Onebitalpha => {
                let buf = self.decode_dxt(bytes, Format::Bc1)?;
                self.image_from_buffer(buf, DynamicImage::ImageRgba8)
            }
            ImageFormat::Dxt3 => {
                let buf = self.decode_dxt(bytes, Format::Bc2)?;
                self.image_from_buffer(buf, DynamicImage::ImageRgba8)
            }
            ImageFormat::Dxt5 => {
                let buf = self.decode_dxt(bytes, Format::Bc3)?;
                self.image_from_buffer(buf, DynamicImage::ImageRgba8)
            }
            ImageFormat::Rgba8888 => {
                self.image_from_buffer(bytes.to_vec(), DynamicImage::ImageRgba8)
            }
            ImageFormat::Rgb888 => self.image_from_buffer(bytes.to_vec(), DynamicImage::ImageRgb8),
            ImageFormat::Bgr888 => {
                let mut bgra = bytes.to_vec();
                convert_bgra(&mut bgra);
                self.image_from_buffer(bgra, DynamicImage::ImageRgb8)
            }
            ImageFormat::Bgra8888 => {
                let mut bgra = bytes.to_vec();
                convert_bgra(&mut bgra);
                self.image_from_buffer(bgra, DynamicImage::ImageRgb8)
            }
            _ => Err(Error::UnsupportedImageFormat(self.format)),
        }
    }
}

/// 就地交换每 4 字节块里的 `[0]` 与 `[2]`（B ↔ R），第 3、4 字节原样写回。
///
/// 用 `chunks_exact_mut(4)`：长度不是 4 的倍数时，末尾不足 4 字节的尾巴**不处理**。
fn convert_bgra(bgra: &mut [u8]) {
    for src in bgra.chunks_exact_mut(4) {
        let (blue, green, red, alpha) = (src[0], src[1], src[2], src[3]);
        src[0] = red;
        src[1] = green;
        src[2] = blue;
        src[3] = alpha;
    }
}

/// VTF 头里的图像格式枚举：判别值就是文件里写的 `i16`——`None = -1`，其余从
/// `Rgba8888 = 0` 顺序递增到 `Uvlx8888 = 26`（共 28 个变体）。
///
/// `TryFromPrimitive`：判别值不在表内时给出 `TryFromPrimitiveError`，由
/// `texture_utils::Error` 转成 `InvalidImageFormat`；`Display` 输出变体名。
#[derive(Debug, Display, Clone, Copy, PartialEq, TryFromPrimitive)]
#[repr(i16)]
pub enum ImageFormat {
    None = -1,
    Rgba8888 = 0,
    Abgr8888,
    Rgb888,
    Bgr888,
    Rgb565,
    I8,
    Ia88,
    P8,
    A8,
    Rgb888Bluescreen,
    Bgr888Bluescreen,
    Argb8888,
    Bgra8888,
    Dxt1,
    Dxt3,
    Dxt5,
    Bgrx8888,
    Bgr565,
    Bgrx5551,
    Bgra4444,
    Dxt1Onebitalpha,
    Bgra5551,
    Uv88,
    Uvwq8888,
    Rgba16161616f,
    Rgba16161616,
    Uvlx8888,
}

impl ImageFormat {
    /// 单帧字节数（**不含 mip**，按传入的 `width × height` 直接算）。
    ///
    /// 表内口径：`None` → 0；`Rgba8888` / `Abgr8888` / `Argb8888` / `Bgra8888` → `w*h*4`；
    /// `Rgb888` / `Bgr888` → `w*h*3`；`Rgb565` / `Ia88` → `w*h*2`；`I8` / `A8` → `w*h`；
    /// `Rgba16161616f` / `Rgba16161616` → `w*h*8`；`Dxt1` → 每个 4×4 块 8B；
    /// `Dxt3` / `Dxt5` → 每个 4×4 块 16B。
    ///
    /// 块数按 `((w + 3) / 4) * ((h + 3) / 4)` 向上取整，边长不是 4 的倍数时按整块算。
    /// 表外格式（`Dxt1Onebitalpha`、`P8`、`Bgrx8888`、`Uv88` 等）→ `UnsupportedImageFormat`。
    pub fn frame_size(&self, width: u32, height: u32) -> Result<u32, Error> {
        match self {
            ImageFormat::None => Ok(0),
            ImageFormat::Rgba8888 => Ok(width * height * 4),
            ImageFormat::Abgr8888 => Ok(width * height * 4),
            ImageFormat::Rgb888 => Ok(width * height * 3),
            ImageFormat::Bgr888 => Ok(width * height * 3),
            ImageFormat::Rgb565 => Ok(width * height * 2),
            ImageFormat::I8 => Ok(width * height),
            ImageFormat::Ia88 => Ok(width * height * 2),
            ImageFormat::A8 => Ok(width * height),
            ImageFormat::Argb8888 => Ok(width * height * 4),
            ImageFormat::Bgra8888 => Ok(width * height * 4),
            ImageFormat::Dxt1 => Ok(((width + 3) / 4) * ((height + 3) / 4) * 8),
            ImageFormat::Dxt3 => Ok(((width + 3) / 4) * ((height + 3) / 4) * 16),
            ImageFormat::Dxt5 => Ok(((width + 3) / 4) * ((height + 3) / 4) * 16),
            ImageFormat::Rgba16161616f => Ok(width * height * 8),
            ImageFormat::Rgba16161616 => Ok(width * height * 8),
            _ => Err(Error::UnsupportedImageFormat(*self)),
        }
    }
}
