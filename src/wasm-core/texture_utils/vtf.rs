use crate::texture_utils::header::VTFHeader;
use crate::texture_utils::image::{ImageFormat, VTFImage};
use crate::texture_utils::resources::{ResourceList, ResourceType};
use crate::texture_utils::Error;
use image::DynamicImage;
use std::fs::File;
use std::io::Cursor;
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
