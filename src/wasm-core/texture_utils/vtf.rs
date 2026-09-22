//! VTF 文件层：读写 VTF 头与 VTF 7.3 资源表，并把 (mip, frame, face, slice) 换算成字节偏移。
//!
//! 在主流程中的位置：
//! - 上游：`src/wasm-core/texture_utils/mod.rs` 的 `from_bytes` 转调 [`VTF::read`]；本仓的调用方
//!   是三个工程的 `decode_vtf_to_png`（`apps/debug/crates/wasm/src/lib.rs`、
//!   `apps/game/crates/wasm/src/lib.rs`、`apps/viewer/crates/wasm/src/lib.rs`），它们都只取
//!   `highres_image` 再 `decode(0)`。
//! - 下游：`src/wasm-core/texture_utils/image.rs` 的 `VTFImage::get_frame` 用 [`get_offset`]
//!   定位帧字节；[`VTFHeader`] 是 `VTFImage` 持有的头类型。
//! - 同名的外部类型：`bsp_to_gltf_core::materials::load_texture_bsp` 用的是外部 `vtf` crate 的
//!   `vtf::vtf::VTF`（`src/wasm-core/bsp_to_gltf_core/materials.rs`；依赖项见
//!   `src/wasm-core/Cargo.toml` 的 `vtf`），与本文件的 [`VTF`] 不是同一套类型。
//!
//! 职责：
//! - [`VTF`]：一份 VTF 的三个视图——头 + 低清图 + 高清图，两个图像视图借用同一份字节切片。
//! - [`VTFHeader`]：头字段的读写与头长度 [`VTFHeader::size`]。
//! - [`ResourceType`] / [`Resource`] / [`ResourceList`]：VTF 7.3 资源表。
//! - [`get_offset`] / [`get_mip_size`]：mip 层与帧的字节偏移。
//!
//! 关键不变量与坑：
//! - 魔数 [`VTFHeader::SIGNATURE`] = `0x00465456`：小端读入后即 ASCII `VTF` 再跟 `0x00`；
//!   不符则 `Error::InvalidSignature`。
//! - 两个版本门都是两段合取：`version[0] >= 7 && version[1] >= 2` 决定 `depth` 的读写，
//!   `version[0] >= 7 && version[1] >= 3` 决定资源表的读写；门不成立时读侧落 `depth = 1`
//!   与 `ResourceList::empty()`。除这两个门，`read` 对任何版本都走同一字段顺序，不校验
//!   版本上下界。
//! - [`VTFHeader::write`] 写进头长度位置的是 [`VTFHeader::size`] 的计算值，**不是**
//!   `header_size` 字段；`size()` 只看 `version[1]`：0 或 1 → 64，其余 → `80 + 资源数 × 8`。
//!   实写字节数比它少 1（7.1）或少 15（7.2），7.3 起相等——三者都以 `version[0] >= 7` 为前提，
//!   `version[0] < 7` 时两个版本门都不成立，一律只实写 63 字节。
//! - `ResourceList::read` 先吞一个 `u64` 占位，而 `ResourceList::write` 不写它——那段占位
//!   由 [`VTFHeader::write`] 写；单独调 `ResourceList::write` 写不出能被读回的区段。
//! - [`VTF::read`] 的低清图偏移优先取资源 `ResourceType::VTF_LEGACY_RSRC_LOW_RES_IMAGE` 的
//!   `data`，退路是头里的 `header_size` 字段（不是已消费的字节数）；高清图优先取
//!   `ResourceType::VTF_LEGACY_RSRC_IMAGE` 的 `data`，否则接在低清图之后，其长度由
//!   `lowres_image_format` 与低清图幅经 `ImageFormat::frame_size` 算出（格式不在尺寸表内
//!   即返回 `Err`）。
//! - 低清图幅直接取头里的 `lowres_image_width` / `lowres_image_height`（`u8`），不乘系数。
//! - [`get_mip_size`] 的宽高恒取 `header` 的 `width` / `height`（高清图幅），不区分调用方
//!   拿的是低清视图还是高清视图；而 `VTFImage::get_frame` 的切片长度按视图自己的宽高算，
//!   低清视图上两者口径不同。
//! - [`get_offset`] 把 `frame` 与 `face` 加成一个线性项，头里没有面数字段；本仓唯一调用点
//!   （`src/wasm-core/texture_utils/image.rs` 的 `VTFImage::get_frame`）固定传 `face = 0` /
//!   `slice = 0` / `mip_level = 0`。
//! - 偏移与尺寸全程 `u32`，不做溢出检查，也不校验算出的偏移是否落在字节切片内——越界要等
//!   `VTFImage::get_frame` 切片时 panic。
//!
//! 边界：不解码像素（在兄弟模块 `texture_utils::image` 的 `VTFImage::decode` 里）、不生成
//! mipmap、不读 zip / pakfile、不校验像素数据与格式是否自洽。唯一的落盘点是
//! [`VTF::save_as_png`]；它与 [`VTF::create`] 在本仓都没有调用点。
//!
//! 测试归属：本文件无 `#[test]`。
use crate::texture_utils::image::{ImageFormat, VTFImage};
use crate::texture_utils::Error;
use image::DynamicImage;
use std::fs::File;
use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use std::convert::TryFrom;
use std::io::{Cursor, Read, Write};
use std::path::Path;
use std::vec::Vec;

/// 一份 VTF 的三个视图：头 + 低清图 + 高清图。
///
/// `header` 是所有权的原件，两个图像视图各持它的克隆；三个字段都借用**同一份** `bytes`
/// （`VTFImage` 只存切片与起始偏移，不复制像素）。
///
/// 只由 [`VTF::read`] 构造，构造时不校验偏移是否落在 `bytes` 内：越界要等
/// `VTFImage::get_frame` 切片时 panic。
#[derive(Debug)]
pub struct VTF<'a> {
    /// 整份 VTF 头（两个视图各持一份克隆）。
    pub header: VTFHeader,
    /// 低清图视图：图幅取头里的 `lowres_image_width` / `lowres_image_height`。
    pub lowres_image: VTFImage<'a>,
    /// 高清图视图：图幅取头里的 `width` / `height`；本仓调用方只用这一个视图。
    pub highres_image: VTFImage<'a>,
}

impl<'a> VTF<'a> {
    /// 读头并定位低清图 / 高清图的起始偏移，返回借用 `bytes` 的三个视图。
    ///
    /// 两个偏移的取法：
    /// - 低清图：资源 `ResourceType::VTF_LEGACY_RSRC_LOW_RES_IMAGE` 的 `data`；资源表里没有
    ///   该条目时退回头里的 `header_size` 字段。
    /// - 高清图：资源 `ResourceType::VTF_LEGACY_RSRC_IMAGE` 的 `data`；否则 = 低清图偏移 +
    ///   低清图单帧大小，该大小由 `lowres_image_format` 与低清图幅经 `ImageFormat::frame_size`
    ///   算出（格式不在尺寸表内即 `Err`）。
    ///
    /// 只读头与偏移，**不解码像素**；偏移是否落在 `bytes` 内、`header_size` 与实际头长度是否
    /// 自洽，都不校验。失败来自头解析（签名不符、格式判别值不在表内、字节不够）与高清图退路
    /// 里的 `ImageFormat::frame_size`（格式不在尺寸表内）。
    pub fn read(bytes: &'a [u8]) -> Result<VTF<'a>, Error> {
        let mut cursor = Cursor::new(bytes);

        let header = VTFHeader::read(&mut cursor)?;

        // 资源表里没有低清图条目时，退回头里声明的头长度，而不是当前游标位置
        let lowres_offset = match header
            .resources
            .get_by_type(ResourceType::VTF_LEGACY_RSRC_LOW_RES_IMAGE)
        {
            Some(resource) => resource.data,
            None => header.header_size,
        };

        // 没有高清图资源条目时，高清图紧接在低清图之后
        let highres_offset = match header
            .resources
            .get_by_type(ResourceType::VTF_LEGACY_RSRC_IMAGE)
        {
            Some(resource) => resource.data,
            None => {
                lowres_offset
                    + header.lowres_image_format.frame_size(
                        header.lowres_image_width as u32,
                        header.lowres_image_height as u32,
                    )?
            }
        };

        // 低清图幅直接取头里的两个 u8 字段，不做放大；视图各持一份 header 克隆
        let lowres_image = VTFImage::new(
            header.clone(),
            header.lowres_image_format,
            header.lowres_image_width as u16,
            header.lowres_image_height as u16,
            bytes,
            lowres_offset as usize,
        );

        let highres_image = VTFImage::new(
            header.clone(),
            header.highres_image_format,
            header.width,
            header.height,
            bytes,
            highres_offset as usize,
        );

        Ok(VTF {
            header,
            lowres_image,
            highres_image,
        })
    }

    /// 由图像生成 VTF 字节（编码方向；本仓无调用点，经 `texture_utils::create` 包装保留）。
    ///
    /// 前提：`image` 的宽高都要是 2 的幂且 ≤ `u16::MAX`，否则 `Error::InvalidImageSize`。
    /// 只读宽高，不读像素，也不做重采样或像素编码。
    ///
    /// 产出：**只有文件头**——`signature` 取 `VTFHeader::SIGNATURE`、`version` 写死 `[7, 1]`、
    /// `header_size` 字段 64、`mipmap_count` 1、低清图格式 `Dxt1` 且低清图幅为 0、`depth` 1、
    /// 资源表空、`flags` 写死 8972（本模块不解释其位含义）。
    ///
    /// 返回值不是一份可解码的 VTF：7.1 分支下 `VTFHeader::write` 实写 63 字节，而写进头长度
    /// 字段的 `VTFHeader::size()` 是 64。把它回灌 [`VTF::read`]，`lowres_offset` 取到头里的
    /// 64 已越过缓冲末尾，`decode` 不是先返回 `UnsupportedImageFormat`，就是在
    /// `VTFImage::get_frame` 的切片处越界 panic。
    pub fn create(image: DynamicImage, image_format: ImageFormat) -> Result<Vec<u8>, Error> {
        if !image.width().is_power_of_two()
            || !image.height().is_power_of_two()
            || image.width() > u16::MAX as u32
            || image.height() > u16::MAX as u32
        {
            return Err(Error::InvalidImageSize);
        }

        let header = VTFHeader {
            signature: VTFHeader::SIGNATURE,
            version: [7, 1],
            header_size: 64,
            width: image.width() as u16,
            height: image.height() as u16,
            flags: 8972,
            frames: 1,
            first_frame: 0,
            reflectivity: [0.0, 0.0, 0.0],
            bumpmap_scale: 1.0,
            highres_image_format: image_format,
            mipmap_count: 1,
            lowres_image_format: ImageFormat::Dxt1,
            lowres_image_width: 0,
            lowres_image_height: 0,
            depth: 1,
            resources: ResourceList::empty(),
        };

        // 容量按"头 + 一帧像素"预留，但下面只写头：帧数据不由本函数产出
        let mut data = Vec::with_capacity(
            header.header_size as usize
                + image_format.frame_size(image.width(), image.height())? as usize,
        );

        header.write(&mut data)?;
        Ok(data)
    }
    
    /// 解码 `highres_image` 的 mip 0 并写成 PNG 文件：本模块唯一的落盘点，本仓无调用点。
    ///
    /// 用 `std::io::BufWriter` 包 `File::create(path)`，缓冲在 `writer` 析构时刷出，函数体内
    /// 没有显式 `flush`。PNG 用的是 `image` crate 的 `ImageFormat::Png`，与本模块的
    /// `ImageFormat`（VTF 图像格式枚举）不是一个类型。
    ///
    /// 不做：不解低清图、不做格式回退、不缩放、不建父目录。解码失败与 IO / PNG 编码失败都经
    /// `Error` 返回（编码失败由 `Error::Image` 承接）。
    pub fn save_as_png(&self, path: &Path) -> Result<(), Error> {
        let image = self.highres_image.decode(0)?;
        let output_file = File::create(path)?;
        let mut writer = std::io::BufWriter::new(output_file);
        image.write_to(&mut writer, image::ImageFormat::Png)?;
        Ok(())
    }
}


// ── VTF 文件头：字段布局、读写与头长度 ────────────────────

/// VTF 文件头的逐字段容器，字段顺序即 [`VTFHeader::read`] / [`VTFHeader::write`] 的读写顺序。
///
/// 字段宽度就是文件里的宽度：`width` / `height` 是 `u16`（高清图幅），低清图幅只有 `u8`；
/// 两个格式字段在文件里占 4 字节，读侧 `as i16` 后经 `ImageFormat::try_from` 转换，表外判别值
/// → `Error::InvalidImageFormat`。
///
/// `Clone` 是 [`VTF::read`] 给两个图像视图各克隆一份头所必需的。
#[derive(Debug, Clone)]
pub struct VTFHeader {
    /// 魔数；[`VTFHeader::read`] 校验通过才构造，故本字段恒等于 [`VTFHeader::SIGNATURE`]。
    pub signature: u32,
    /// `[主版本, 次版本]`；两个版本门与 [`VTFHeader::size`] 都只看它。
    pub version: [u32; 2],
    /// 头里声明的头长度；[`VTFHeader::write`] **不写本字段**（写 `size()`），[`VTF::read`]
    /// 只在缺低清图资源条目时把它当低清图偏移用。
    pub header_size: u32,
    /// 高清图宽（像素）。
    pub width: u16,
    /// 高清图高（像素）。
    pub height: u16,
    /// 标志位，原样读写；本模块不解释其位含义（[`VTF::create`] 写死 8972）。
    pub flags: u32,
    /// 帧数；[`get_offset`] 把更粗 mip 的整卷总量乘上它。
    pub frames: u16,
    /// 首帧序号，原样读写，不参与任何偏移计算。
    pub first_frame: u16,
    /// 反射率三通道，原样读写（[`VTF::create`] 写全 0）。
    pub reflectivity: [f32; 3],
    /// 凹凸缩放，原样读写（[`VTF::create`] 写 1.0）。
    pub bumpmap_scale: f32,
    /// 高清图像素格式。
    pub highres_image_format: ImageFormat,
    /// mip 层数；[`get_offset`] 用它当前缀和的循环上界。
    pub mipmap_count: u8,
    /// 低清图像素格式。
    pub lowres_image_format: ImageFormat,
    /// 低清图宽：`u8`，直接当像素数用，不乘系数。
    pub lowres_image_width: u8,
    /// 低清图高：`u8`，直接当像素数用，不乘系数。
    pub lowres_image_height: u8,
    /// 体纹理层数；版本门不成立时读成 1。
    pub depth: u16,
    /// VTF 7.3 资源表；版本门不成立时是空表。
    pub resources: ResourceList,
}

impl VTFHeader {
    /// VTF 魔数：小端读入后即 ASCII `VTF` 再跟 `0x00`。
    pub const SIGNATURE: u32 = 0x00465456;

    /// 按文件顺序小端读出一个头：签名 → 版本 → 头长度 → 图幅 → 标志 → 帧序号 → 反射率 →
    /// 凹凸缩放 → 两个格式字段 → 低清图幅 →（版本门）体深度 →（版本门）资源表。
    ///
    /// 两处 `_padding` 是从流里读掉即丢的 `u32` 占位，不进入结构体。
    /// 失败：签名不符 → `Error::InvalidSignature`；两个格式字段的原始 `i16` 不在
    /// `ImageFormat` 判别值里 → `Error::InvalidImageFormat`；字节不够 → `Error::Io`。
    ///
    /// 不做：不校验 `header_size` 与实际消费的字节数是否一致，也不按 `header_size` 跳到数据区
    /// （读完最后一个字段，游标停在头尾）；除两个版本门，任何版本都按同一顺序读，不校验版本
    /// 上下界。
    pub fn read(bytes: &mut impl Read) -> Result<Self, Error> {
        let signature = bytes.read_u32::<LittleEndian>()?;

        if signature != Self::SIGNATURE {
            return Err(Error::InvalidSignature);
        }

        let version = [
            bytes.read_u32::<LittleEndian>()?,
            bytes.read_u32::<LittleEndian>()?,
        ];
        let header_size = bytes.read_u32::<LittleEndian>()?;
        let width = bytes.read_u16::<LittleEndian>()?;
        let height = bytes.read_u16::<LittleEndian>()?;
        let flags = bytes.read_u32::<LittleEndian>()?;
        let frames = bytes.read_u16::<LittleEndian>()?;
        let first_frame = bytes.read_u16::<LittleEndian>()?;

        let _padding = bytes.read_u32::<LittleEndian>()?;

        let reflectivity = [
            bytes.read_f32::<LittleEndian>()?,
            bytes.read_f32::<LittleEndian>()?,
            bytes.read_f32::<LittleEndian>()?,
        ];

        let _padding = bytes.read_u32::<LittleEndian>()?;

        let bumpmap_scale = bytes.read_f32::<LittleEndian>()?;
        let highres_image_format = bytes.read_u32::<LittleEndian>()?;
        let mipmap_count = bytes.read_u8()?;
        let lowres_image_format = bytes.read_u32::<LittleEndian>()?;
        let lowres_image_width = bytes.read_u8()?;
        let lowres_image_height = bytes.read_u8()?;

        let depth = if version[0] >= 7 && version[1] >= 2 {
            bytes.read_u16::<LittleEndian>()?
        } else {
            1
        };
        let resources = if version[0] >= 7 && version[1] >= 3 {
            let _padding = [bytes.read_u8()?, bytes.read_u8()?, bytes.read_u8()?];
            let num_resources = bytes.read_u32::<LittleEndian>()?;
            ResourceList::read(bytes, num_resources)?
        } else {
            ResourceList::empty()
        };

        Ok(VTFHeader {
            signature,
            version,
            header_size,
            width,
            height,
            flags,
            frames,
            first_frame,
            reflectivity,
            bumpmap_scale,
            highres_image_format: ImageFormat::try_from(highres_image_format as i16)?,
            mipmap_count,
            lowres_image_format: ImageFormat::try_from(lowres_image_format as i16)?,
            lowres_image_width,
            lowres_image_height,
            depth,
            resources,
        })
    }

    /// 按 [`VTFHeader::read`] 的顺序把小端头写出。
    ///
    /// 三处写出的值不等于同名字段：
    /// - 头长度位置写 [`VTFHeader::size`] 的计算值，不是 `header_size` 字段；
    /// - 两处 `u32` 占位与 7.3 区的 3 字节 0 是写死的常量占位（读侧对应丢掉的 `_padding`）；
    /// - 两个格式字段按 `as i16 as u32` 写出，负判别值（`ImageFormat::None` = -1）在文件里
    ///   是全 1。
    ///
    /// 7.3 分支在资源条目之前先写 3 字节 0 + `u32` 资源数 + `u64` 0，再让
    /// `ResourceList::write` 写条目——那个 `u64` 占位由本函数负责，不在 `ResourceList::write`
    /// 里（而读侧的 `ResourceList::read` 会读它）。
    ///
    /// 写出长度只由版本门决定，不补齐到 `size()` 声明的长度。`version[0] >= 7` 时：
    /// `version[1]` 为 1 实写 63 字节而头里声明 64，为 2 实写 65 字节而声明 80，为 3 及以上
    /// 实写 `80 + 条目数 × 8` 与声明值相等。`version[0] < 7` 时两个门都不成立，无论
    /// `version[1]` 是多少都只实写 63 字节。
    pub fn write(&self, bytes: &mut impl Write) -> Result<(), Error> {
        bytes.write_u32::<LittleEndian>(self.signature)?;

        bytes.write_u32::<LittleEndian>(self.version[0])?;
        bytes.write_u32::<LittleEndian>(self.version[1])?;

        // 头长度位置写的是 size() 的计算值，不是 self.header_size 字段
        bytes.write_u32::<LittleEndian>(self.size() as u32)?;
        bytes.write_u16::<LittleEndian>(self.width)?;
        bytes.write_u16::<LittleEndian>(self.height)?;
        bytes.write_u32::<LittleEndian>(self.flags)?;
        bytes.write_u16::<LittleEndian>(self.frames)?;
        bytes.write_u16::<LittleEndian>(self.first_frame)?;

        bytes.write_u32::<LittleEndian>(0)?;

        bytes.write_f32::<LittleEndian>(self.reflectivity[0])?;
        bytes.write_f32::<LittleEndian>(self.reflectivity[1])?;
        bytes.write_f32::<LittleEndian>(self.reflectivity[2])?;

        bytes.write_u32::<LittleEndian>(0)?;

        bytes.write_f32::<LittleEndian>(self.bumpmap_scale)?;
        bytes.write_u32::<LittleEndian>(self.highres_image_format as i16 as u32)?;
        bytes.write_u8(self.mipmap_count)?;
        bytes.write_u32::<LittleEndian>(self.lowres_image_format as i16 as u32)?;
        bytes.write_u8(self.lowres_image_width)?;
        bytes.write_u8(self.lowres_image_height)?;

        if self.version[0] >= 7 && self.version[1] >= 2 {
            bytes.write_u16::<LittleEndian>(self.depth)?;
        }

        if self.version[0] >= 7 && self.version[1] >= 3 {
            bytes.write_u8(0)?;
            bytes.write_u8(0)?;
            bytes.write_u8(0)?;
            bytes.write_u32::<LittleEndian>(self.resources.resources.len() as u32)?;
            // 资源条目之前的 u64 占位由本函数写，读侧对应 ResourceList::read 的第一次读取
            bytes.write_u64::<LittleEndian>(0)?;
            self.resources.write(bytes)?;
        }

        Ok(())
    }

    /// 头长度（字节）：`version[1]` 为 0 或 1 → 64，其余 → `80 + 资源条目数 × 8`。
    ///
    /// 只看 `version[1]`，不看 `version[0]`、不看 `header_size` 字段，也不按实际写出的字节数
    /// 算——`version[0] >= 7` 时 [`VTFHeader::write`] 的 7.1 / 7.2 分支实写字节数分别比本值
    /// 小 1 / 15。资源条目按 8 字节计，与 [`Resource`] 的字段宽度（`id` 3 + `flags` 1 +
    /// `data` 4）一致。
    pub fn size(&self) -> usize {
        match self.version[1] {
            0 | 1 => 64,
            _ => 80 + (self.resources.resources.len() * 8),
        }
    }
}

// ── VTF 7.3 资源表：资源类型、条目与查表 ──────────────────

/// 资源类型标识：3 字节 `id` + 1 字节 `flags`。
///
/// 两个字段都私有，构造点只有 [`ResourceType::VTF_LEGACY_RSRC_LOW_RES_IMAGE`] /
/// [`ResourceType::VTF_LEGACY_RSRC_IMAGE`] 两个关联常量与 [`ResourceType::read`]。
/// `PartialEq` 派生自两个字段，因此 `ResourceList::get_by_type` 的命中条件是 `id` 与 `flags`
/// **都**相等：比较的是整个 `flags` 字节，不是它的某一位，`flags = 0x02` 的同 `id` 条目对
/// `flags = 0` 的常量不算命中。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResourceType {
    /// 3 字节类型 id。
    id: [u8; 3],
    /// 1 字节标志位：读写见于 `read` / `write`，位判断见于 `has_resource_type`。
    flags: u8,
}

impl ResourceType {
    /// 低清图资源类型：`id = [0x01, 0x00, 0x00]`、`flags = 0`；[`VTF::read`] 用它取低清图偏移。
    pub const VTF_LEGACY_RSRC_LOW_RES_IMAGE: ResourceType = ResourceType {
        id: [0x01, 0x00, 0x00],
        flags: 0,
    };
    /// 高清图资源类型：`id = [0x30, 0x00, 0x00]`、`flags = 0`；[`VTF::read`] 用它取高清图偏移。
    pub const VTF_LEGACY_RSRC_IMAGE: ResourceType = ResourceType {
        id: [0x30, 0x00, 0x00],
        flags: 0,
    };

    /// 标志位掩码：`flags` 的 `0x02` 位，只被 `has_resource_type` 使用。
    const HAS_NO_DATA_CHUNK: u8 = 0x02;

    /// 该位未置位时为 `true`（即 `flags & 0x02 == 0`）。本仓无调用点，由模块级
    /// `#![allow(dead_code)]` 兜住（`src/wasm-core/texture_utils/mod.rs`）。
    pub fn has_resource_type(&self) -> bool {
        self.flags & Self::HAS_NO_DATA_CHUNK == 0
    }
}

impl ResourceType {
    /// 从流里逐个读 3 字节 `id` + 1 字节 `flags`（`u8` 不涉及字节序）。
    pub fn read(bytes: &mut impl Read) -> Result<Self, Error> {
        Ok(ResourceType {
            id: [bytes.read_u8()?, bytes.read_u8()?, bytes.read_u8()?],
            flags: bytes.read_u8()?,
        })
    }

    /// 按 `id[0]`、`id[1]`、`id[2]`、`flags` 的顺序写出，与 `read` 对称。
    pub fn write(&self, bytes: &mut impl Write) -> Result<(), Error> {
        bytes.write_u8(self.id[0])?;
        bytes.write_u8(self.id[1])?;
        bytes.write_u8(self.id[2])?;
        bytes.write_u8(self.flags)?;
        Ok(())
    }
}

/// 资源表里的一条：类型 + 数据块偏移。
///
/// `ty` 私有，只在模块内被比较（`ResourceList::get_by_type`）；`data` 是资源在文件里的字节
/// 偏移，[`VTF::read`] 把它直接当低清图 / 高清图的起始偏移用。
#[derive(Debug, Clone, Copy)]
pub struct Resource {
    ty: ResourceType,
    /// 资源在文件里的字节偏移。
    pub data: u32,
}

impl Resource {
    /// 先读类型，再读小端 `u32` 偏移。
    pub fn read(bytes: &mut impl Read) -> Result<Self, Error> {
        Ok(Resource {
            ty: ResourceType::read(bytes)?,
            data: bytes.read_u32::<LittleEndian>()?,
        })
    }

    /// 先写类型，再写小端 `u32` 偏移，与 `read` 对称。
    pub fn write(&self, bytes: &mut impl Write) -> Result<(), Error> {
        self.ty.write(bytes)?;
        bytes.write_u32::<LittleEndian>(self.data)?;
        Ok(())
    }
}

/// VTF 7.3 的资源表。
///
/// 表长不在这里：`read` 的条目数由调用方传入（头里那个 `u32` 计数），`write` 不写计数；
/// 条目按文件顺序排列，`get_by_type` 取第一个命中项。
#[derive(Debug, Clone)]
pub struct ResourceList {
    /// 资源条目，顺序即文件顺序。
    pub resources: Vec<Resource>,
}

impl ResourceList {
    /// 空表：7.3 以下的头（[`VTFHeader::read`] 的版本门）与 [`VTF::create`] 都用它。
    pub fn empty() -> Self {
        ResourceList {
            resources: Vec::new(),
        }
    }

    /// 先吞一个 `u64` 占位，再连读 `num_resources` 条资源。
    ///
    /// 那个 `u64` 占位由本函数读、却**不**由 `ResourceList::write` 写：写侧由
    /// [`VTFHeader::write`] 在调 `write` 之前补齐，两侧调用必须成对。
    pub fn read(bytes: &mut impl Read, num_resources: u32) -> Result<Self, Error> {
        let _padding = bytes.read_u64::<LittleEndian>()?;

        let resources = (0..num_resources)
            .map(|_| Resource::read(bytes))
            .collect::<Result<Vec<Resource>, Error>>()?;
        Ok(ResourceList { resources })
    }

    /// 只按顺序写资源条目，不写计数、不写 `u64` 占位（两者由 [`VTFHeader::write`] 负责）。
    /// 单独调用它写不出能被 `ResourceList::read` 读回的区段。
    pub fn write(&self, bytes: &mut impl Write) -> Result<(), Error> {
        self.resources
            .iter()
            .try_for_each(|resource| resource.write(bytes))
    }

    /// 返回第一个类型完全相等（`id` 与 `flags` 都比）的条目，没有则 `None`。
    ///
    /// 比较走 `ResourceType` 的派生 `PartialEq`（比整个 `flags` 字节），不走
    /// `ResourceType::has_resource_type` 的位判断。
    pub fn get_by_type(&self, ty: ResourceType) -> Option<&Resource> {
        self.resources.iter().find(|resource| resource.ty == ty)
    }
}

// ── mip 偏移：把 mip / frame / face / slice 算成字节偏移 ───

/// 算出 `(mip_level, frame, face, slice)` 相对图像数据区起点的字节偏移。
///
/// 算法：先把比 `mip_level` 更粗的每一层按整卷计（`get_mip_size(header, image_format, i,
/// header.depth)`，`i` 从 `mip_level + 1` 到 `mipmap_count - 1`），总和乘 `header.frames`；
/// 再加上当前层的 `volume_bytes × (frame + face)` 与 `slice_bytes × slice`
/// （`volume_bytes` 传 `header.depth`、`slice_bytes` 传 `1`）。
/// `mip_level + 1 >= mipmap_count` 时前缀和为 0。
///
/// 坑：
/// - `frame` 与 `face` 被加成一个线性项，头里没有面数字段：帧数与面数同时大于 1 时，
///   两组索引会落到同一偏移上。
/// - `mip_level` 是 `i32`：负数会让前缀和从第 0 层起累加全部 mip，而后面 `mip_level as u32`
///   的移位量按 31 取模。本仓调用点只传 0。
/// - 返回值不含视图自己的 `offset`：`src/wasm-core/texture_utils/image.rs` 的
///   `VTFImage::get_frame` 把它加在自己的 `offset` 上。
///
/// 不做：不校验偏移是否落在切片内；全程 `u32`，不查溢出。
pub fn get_offset(
    header: &VTFHeader,
    image_format: &ImageFormat,
    frame: u32,
    face: u32,
    slice: u32,
    mip_level: i32,
) -> Result<u32, Error> {
    let mut offset: u32 = 0;

    // 前缀和：比目标层更粗的每一层都按整卷（含全部体层）计入，帧数在循环外单独乘
    for i in (mip_level + 1..(header.mipmap_count) as i32).rev() {
        offset += get_mip_size(header, image_format, i as u32, header.depth)?;
    }

    // 更粗 mip 的整卷总和在每一帧里重复一遍，故整体乘帧数
    offset *= header.frames as u32;

    let volume_bytes: u32 = get_mip_size(header, image_format, mip_level as u32, header.depth)?;
    // 单层大小按 depth = 1 算
    let slice_bytes: u32 = get_mip_size(header, image_format, mip_level as u32, 1)?;

    // frame 与 face 共用一个线性项：头里没有面数字段，face 没有独立步长
    offset += volume_bytes * (frame + face);
    offset += slice_bytes * slice;

    Ok(offset)
}

/// 一层 mip 的字节数：`frame_size(w >> mip_level, h >> mip_level)` × `(depth >> mip_level)`，
/// 宽 / 高 / 深各自小于 1 时钳到 1。
///
/// - 宽高恒取 `header.width` / `header.height`（高清图幅），与低清图视图自己的宽高无关；
///   而 `VTFImage::get_frame` 的切片长度按视图的 `width` / `height` 算，低清视图上两者口径
///   不同。
/// - 移位用 `wrapping_shr`：移位量按 31 取模，`mip_level >= 32` 会绕回。
/// - `depth` 是独立入参：调用方传 `header.depth` 取整卷、传 `1` 取单层。
///
/// 格式不在 `ImageFormat::frame_size` 的表内 → `UnsupportedImageFormat`。
pub fn get_mip_size(
    header: &VTFHeader,
    image_format: &ImageFormat,
    mip_level: u32,
    depth: u16,
) -> Result<u32, Error> {
    let mut mip_width = header.width.wrapping_shr(mip_level);
    let mut mip_height = header.height.wrapping_shr(mip_level);
    let mut mip_depth = depth.wrapping_shr(mip_level);

    // 右移到 0 时钳为 1：最粗一级的尺寸不小于 1
    if mip_width < 1 {
        mip_width = 1;
    }

    if mip_height < 1 {
        mip_height = 1;
    }
    if mip_depth < 1 {
        mip_depth = 1;
    }

    Ok(image_format.frame_size(mip_width as u32, mip_height as u32)? * mip_depth as u32)
}