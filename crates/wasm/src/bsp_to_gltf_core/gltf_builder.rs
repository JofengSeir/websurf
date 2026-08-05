//! GLTF 构建器模块

use crate::bsp_to_gltf_core::convert::pad_byte_vector;
use crate::bsp_to_gltf_core::materials::{MaterialData, TextureData};
use crate::bsp_to_gltf_core::{ConvertOptions, MissingResource};
use gltf_json::buffer::View;
use gltf_json::extensions::texture::{TextureTransform, TextureTransformOffset, TextureTransformRotation, TextureTransformScale};
use gltf_json::image::MimeType;
use gltf_json::material::{AlphaCutoff, AlphaMode, PbrBaseColorFactor, PbrMetallicRoughness, StrengthFactor};
use gltf_json::texture::Info;
use gltf_json::validation::Checked::Valid;
use gltf_json::validation::USize64;
use gltf_json::{Extras, Image, Index, Material, Root, Texture};
use image::codecs::png::PngEncoder;
use image::{ColorType, DynamicImage, ImageEncoder};
use std::f32::consts::PI;
use crate::vbsp::Bsp;

/// 从 BSP 文件中获取或创建材质
pub fn push_or_get_material_bsp(
    buffer: &mut Vec<u8>,
    gltf: &mut Root,
    bsp: &Bsp,
    material: &str,
    options: &ConvertOptions,
    missing_resources: &mut Vec<MissingResource>,
    texture_collector: Option<std::rc::Rc<std::cell::RefCell<crate::bsp_to_gltf_core::materials::TextureCollector>>>,
) -> Index<Material> {
    let material = material.to_ascii_lowercase();
    match get_material_index(&gltf.materials, &material) {
        Some(index) => index,
        None => {
            // 处理 texture_collector 参数
            if let Some(tc) = texture_collector {
                let mut tc_mut = tc.borrow_mut();
                let material = crate::bsp_to_gltf_core::materials::load_material_fallback_bsp(&material, &[String::new()], bsp, options, missing_resources, Some(&mut tc_mut));
                let index = gltf.materials.len() as u32;
                let material = push_material(buffer, gltf, material);
                gltf.materials.push(material);
                Index::new(index)
            } else {
                let material = crate::bsp_to_gltf_core::materials::load_material_fallback_bsp(&material, &[String::new()], bsp, options, missing_resources, None);
                let index = gltf.materials.len() as u32;
                let material = push_material(buffer, gltf, material);
                gltf.materials.push(material);
                Index::new(index)
            }
        }
    }
}

/// 获取材质索引
fn get_material_index(materials: &[Material], path: &str) -> Option<Index<Material>> {
    materials
        .iter()
        .enumerate()
        .find_map(|(i, mat)| (mat.name.as_deref() == Some(path)).then_some(i))
        .map(|i| Index::new(i as u32))
}

/// 推送材质到 GLTF
pub fn push_material(buffer: &mut Vec<u8>, gltf: &mut Root, material: MaterialData) -> Material {
    let texture_index = material
        .texture
        .map(|tex| push_or_get_texture(buffer, gltf, tex));

    let alpha_mode = match (material.translucent, material.alpha_test.is_some()) {
        (true, _) => AlphaMode::Blend,
        (false, true) => AlphaMode::Mask,
        _ => AlphaMode::Opaque,
    };

    let transform = material.transform.map(|transform| TextureTransform {
        offset: TextureTransformOffset(transform.translate),
        rotation: TextureTransformRotation(transform.rotate / 180.0 * PI),
        scale: TextureTransformScale(transform.scale),
        ..TextureTransform::default()
    });
    let extensions = transform.map(|transform| gltf_json::extensions::texture::Info {
        texture_transform: Some(transform),
    });

    Material {
        name: Some(material.name),
        alpha_cutoff: material
            .alpha_test
            .map(AlphaCutoff)
            .filter(|_| alpha_mode == AlphaMode::Mask),
        double_sided: material.no_cull,
        alpha_mode: Valid(alpha_mode),
        pbr_metallic_roughness: PbrMetallicRoughness {
            base_color_factor: PbrBaseColorFactor(
                [
                    material.color[0] as f32 / 255.0,
                    material.color[1] as f32 / 255.0,
                    material.color[2] as f32 / 255.0,
                    material.color[3] as f32 / 255.0
                ],
            ),
            base_color_texture: texture_index.map(|index| Info {
                index,
                tex_coord: 0,
                extensions,
                extras: Extras::default(),
            }),
            // BSP 纹理是漫反射颜色贴图（非金属），显式设置避免默认值 1.0 全金属导致场景发黑
            metallic_factor: StrengthFactor(0.0),
            roughness_factor: StrengthFactor(1.0),
            ..PbrMetallicRoughness::default()
        },
        ..Material::default()
    }
}

/// 获取或创建纹理
fn push_or_get_texture(
    buffer: &mut Vec<u8>,
    gltf: &mut Root,
    texture: TextureData,
) -> Index<Texture> {
    match get_texture_index(&gltf.textures, &texture.name) {
        Some(index) => index,
        None => {
            let index = gltf.textures.len() as u32;
            let texture = push_texture(buffer, gltf, texture);
            gltf.textures.push(texture);
            Index::new(index)
        }
    }
}

/// 获取纹理索引
fn get_texture_index(textures: &[Texture], name: &str) -> Option<Index<Texture>> {
    textures
        .iter()
        .enumerate()
        .find_map(|(i, tex)| (tex.name.as_deref() == Some(name)).then_some(i))
        .map(|i| Index::new(i as u32))
}

/// 推送纹理到 GLTF
fn push_texture(buffer: &mut Vec<u8>, gltf: &mut Root, texture: TextureData) -> Texture {
    let mut image = texture.image;
    if image.color() != ColorType::Rgba8 && image.color() != ColorType::Rgb8 {
        if image.color().has_alpha() {
            image = DynamicImage::ImageRgba8(image.into_rgba8());
        } else {
            image = DynamicImage::ImageRgb8(image.into_rgb8());
        }
    }
    let buffer_start = buffer.len() as u64;
    let view_start = gltf.buffer_views.len() as u32;
    let image_start = gltf.images.len() as u32;
    let image_buffer_size = (image.color().bits_per_pixel() / 8) as u32 * image.width() * image.height();

    let mut png_buffer = Vec::new();
    let encoder = PngEncoder::new(&mut png_buffer);
    encoder
        .write_image(
            &image.as_bytes()[0..image_buffer_size as usize],
            image.width(),
            image.height(),
            image.color().into(),
        )
        .expect("failed to encode");

    buffer.extend_from_slice(&png_buffer);

    let byte_length = buffer.len() as u64 - buffer_start;
    pad_byte_vector(buffer);

    let view = View {
        buffer: Index::new(0),
        byte_length: USize64(byte_length),
        byte_offset: Some(USize64(buffer_start)),
        byte_stride: None,
        extensions: Default::default(),
        extras: Default::default(),
        name: Some(texture.name.clone()),
        target: None,
    };

    gltf.buffer_views.push(view);

    let image = Image {
        buffer_view: Some(Index::new(view_start)),
        mime_type: Some(MimeType("image/png".into())),
        name: Some(texture.name.clone()),
        uri: None,
        extensions: None,
        extras: Default::default(),
    };
    gltf.images.push(image);

    Texture {
        name: Some(texture.name),
        sampler: None,
        source: Index::new(image_start),
        extensions: None,
        extras: Default::default(),
    }
}
