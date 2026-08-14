use crate::texture_utils::image::{ImageFormat, VTFImage};
use crate::texture_utils::Error;
use image::DynamicImage;
use std::fs::File;
use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use std::convert::TryFrom;
use std::io::{Cursor, Read, Write};
use std::path::Path;
use std::vec::Vec;

#[derive(Debug)]
pub struct VTF<'a> {
    pub header: VTFHeader,
    pub lowres_image: VTFImage<'a>,
    pub highres_image: VTFImage<'a>,
}

impl<'a> VTF<'a> {
    pub fn read(bytes: &'a [u8]) -> Result<VTF<'a>, Error> {
        let mut cursor = Cursor::new(bytes);

        let header = VTFHeader::read(&mut cursor)?;

        let lowres_offset = match header
            .resources
            .get_by_type(ResourceType::VTF_LEGACY_RSRC_LOW_RES_IMAGE)
        {
            Some(resource) => resource.data,
            None => header.header_size,
        };

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

        let mut data = Vec::with_capacity(
            header.header_size as usize
                + image_format.frame_size(image.width(), image.height())? as usize,
        );

        header.write(&mut data)?;
        Ok(data)
    }
    
    pub fn save_as_png(&self, path: &Path) -> Result<(), Error> {
        let image = self.highres_image.decode(0)?;
        let output_file = File::create(path)?;
        let mut writer = std::io::BufWriter::new(output_file);
        image.write_to(&mut writer, image::ImageFormat::Png)?;
        Ok(())
    }
}


// ── VTF 头（并入自 header.rs）──────────────────────────────

#[derive(Debug, Clone)]
pub struct VTFHeader {
    pub signature: u32,
    pub version: [u32; 2],
    pub header_size: u32,
    pub width: u16,
    pub height: u16,
    pub flags: u32,
    pub frames: u16,
    pub first_frame: u16,
    pub reflectivity: [f32; 3],
    pub bumpmap_scale: f32,
    pub highres_image_format: ImageFormat,
    pub mipmap_count: u8,
    pub lowres_image_format: ImageFormat,
    pub lowres_image_width: u8,
    pub lowres_image_height: u8,
    pub depth: u16,
    pub resources: ResourceList,
}

impl VTFHeader {
    pub const SIGNATURE: u32 = 0x00465456;

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

    pub fn write(&self, bytes: &mut impl Write) -> Result<(), Error> {
        bytes.write_u32::<LittleEndian>(self.signature)?;

        bytes.write_u32::<LittleEndian>(self.version[0])?;
        bytes.write_u32::<LittleEndian>(self.version[1])?;

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
            bytes.write_u64::<LittleEndian>(0)?;
            self.resources.write(bytes)?;
        }

        Ok(())
    }

    pub fn size(&self) -> usize {
        match self.version[1] {
            0 | 1 => 64,
            _ => 80 + (self.resources.resources.len() * 8),
        }
    }
}

// ── 资源表（并入自 resources.rs，VTF 7.3）──────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResourceType {
    id: [u8; 3],
    flags: u8,
}

impl ResourceType {
    pub const VTF_LEGACY_RSRC_LOW_RES_IMAGE: ResourceType = ResourceType {
        id: [0x01, 0x00, 0x00],
        flags: 0,
    };
    pub const VTF_LEGACY_RSRC_IMAGE: ResourceType = ResourceType {
        id: [0x30, 0x00, 0x00],
        flags: 0,
    };

    const HAS_NO_DATA_CHUNK: u8 = 0x02;

    pub fn has_resource_type(&self) -> bool {
        self.flags & Self::HAS_NO_DATA_CHUNK == 0
    }
}

impl ResourceType {
    pub fn read(bytes: &mut impl Read) -> Result<Self, Error> {
        Ok(ResourceType {
            id: [bytes.read_u8()?, bytes.read_u8()?, bytes.read_u8()?],
            flags: bytes.read_u8()?,
        })
    }

    pub fn write(&self, bytes: &mut impl Write) -> Result<(), Error> {
        bytes.write_u8(self.id[0])?;
        bytes.write_u8(self.id[1])?;
        bytes.write_u8(self.id[2])?;
        bytes.write_u8(self.flags)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Resource {
    ty: ResourceType,
    pub data: u32,
}

impl Resource {
    pub fn read(bytes: &mut impl Read) -> Result<Self, Error> {
        Ok(Resource {
            ty: ResourceType::read(bytes)?,
            data: bytes.read_u32::<LittleEndian>()?,
        })
    }

    pub fn write(&self, bytes: &mut impl Write) -> Result<(), Error> {
        self.ty.write(bytes)?;
        bytes.write_u32::<LittleEndian>(self.data)?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct ResourceList {
    pub resources: Vec<Resource>,
}

impl ResourceList {
    pub fn empty() -> Self {
        ResourceList {
            resources: Vec::new(),
        }
    }

    pub fn read(bytes: &mut impl Read, num_resources: u32) -> Result<Self, Error> {
        let _padding = bytes.read_u64::<LittleEndian>()?;

        let resources = (0..num_resources)
            .map(|_| Resource::read(bytes))
            .collect::<Result<Vec<Resource>, Error>>()?;
        Ok(ResourceList { resources })
    }

    pub fn write(&self, bytes: &mut impl Write) -> Result<(), Error> {
        self.resources
            .iter()
            .try_for_each(|resource| resource.write(bytes))
    }

    pub fn get_by_type(&self, ty: ResourceType) -> Option<&Resource> {
        self.resources.iter().find(|resource| resource.ty == ty)
    }
}

// ── mip 偏移（并入自 utils.rs）─────────────────────────────

pub fn get_offset(
    header: &VTFHeader,
    image_format: &ImageFormat,
    frame: u32,
    face: u32,
    slice: u32,
    mip_level: i32,
) -> Result<u32, Error> {
    let mut offset: u32 = 0;

    for i in (mip_level + 1..(header.mipmap_count) as i32).rev() {
        offset += get_mip_size(header, image_format, i as u32, header.depth)?;
    }

    offset *= header.frames as u32;

    let volume_bytes: u32 = get_mip_size(header, image_format, mip_level as u32, header.depth)?;
    let slice_bytes: u32 = get_mip_size(header, image_format, mip_level as u32, 1)?;

    offset += volume_bytes * (frame + face);
    offset += slice_bytes * slice;

    Ok(offset)
}

pub fn get_mip_size(
    header: &VTFHeader,
    image_format: &ImageFormat,
    mip_level: u32,
    depth: u16,
) -> Result<u32, Error> {
    let mut mip_width = header.width.wrapping_shr(mip_level);
    let mut mip_height = header.height.wrapping_shr(mip_level);
    let mut mip_depth = depth.wrapping_shr(mip_level);

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