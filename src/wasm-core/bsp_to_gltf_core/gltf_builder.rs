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

/// 贴图是否**自带真实镂空**（`alpha < 32` 的像素占比 ≥ 1%）。
///
/// 判据来自实机缺陷（2026-09-20 铁丝网/格栅）：`metal/metalgrate013a` 的贴图有 28.2% 像素
/// `alpha == 0`、`metal/metalgrate013b` 有 11.8%，但二者在 BSP 内**没有**对应 VMT（stock 材质）
/// ⇒ 导出为 `OPAQUE` ⇒ glTF 语义下这些像素只能被画成它们自己的 RGB（实测 ≈ `#131414` 近黑），
/// 实机表现即「铁丝网的孔洞被涂成黑块」。
///
/// 反过来，`alpha == 0` 的像素在 glTF 里只有两种正当解释：`MASK` 裁掉，或 `BLEND` 混合。
/// 全量核对（surf_666，219 个有贴图且有 primitive 的材质）：有孔洞的 12 个里 10 个已由 VMT/模型
/// 标注为 MASK/BLEND，只有这 2 个漏标；其余 207 个 `alpha` 恒为 255 ⇒ 该判据的**影响面恰好
/// 是漏标的那 2 个**，不会把任何不透明贴图变成镂空。
///
/// 阈值取 1% 且用 `alpha < 32`（比 `alphaCutoff 0.5` = `alpha < 128` 更保守）：滤掉边缘抗锯齿
/// 与 mosaic 量化噪声，避免「一个像素半透明」就翻转整个材质。
fn texture_has_alpha_holes(image: &image::DynamicImage) -> bool {
    /// 视为「孔洞」的 alpha 上界（`alphaCutoff 0.5` 对应 128，这里更严）。
    const HOLE_ALPHA: u8 = 32;
    /// 孔洞像素占比下限（1%）。
    const MIN_RATIO: f32 = 0.01;

    if !image.color().has_alpha() {
        return false;
    }
    let rgba = image.to_rgba8();
    let raw = rgba.as_raw();
    if raw.len() < 4 {
        return false;
    }
    let total = raw.len() / 4;
    let mut holes = 0usize;
    let mut i = 3usize;
    while i < raw.len() {
        if raw[i] < HOLE_ALPHA {
            holes += 1;
        }
        i += 4;
    }
    holes as f32 >= total as f32 * MIN_RATIO
}

/// 推送材质到 GLTF
pub fn push_material(buffer: &mut Vec<u8>, gltf: &mut Root, material: MaterialData) -> Material {
    // 贴图自带镂空？必须在 `material.texture` 被 `push_or_get_texture` 消费前判定。
    let texture_has_holes = material
        .texture
        .as_ref()
        .map(|tex| texture_has_alpha_holes(&tex.image))
        .unwrap_or(false);

    let texture_index = material
        .texture
        .map(|tex| push_or_get_texture(buffer, gltf, tex));

    let alpha_mode = match (material.translucent, material.alpha_test.is_some()) {
        (true, _) => AlphaMode::Blend,
        (false, true) => AlphaMode::Mask,
        _ => AlphaMode::Opaque,
    };
    // 未声明透明的材质，若**贴图自带镂空**则补判 MASK（见 `texture_has_alpha_holes`）：
    // 没有这条，镂空像素会被当作实心 RGB 画出来（铁丝网孔洞变黑块）。
    let alpha_mode = match alpha_mode {
        AlphaMode::Opaque if texture_has_holes => AlphaMode::Mask,
        other => other,
    };
    // `$alphatest` 未给数值时用 glTF 规范默认 0.5；MASK 必须带 cutoff 才能稳定裁切。
    let alpha_cutoff = if alpha_mode == AlphaMode::Mask {
        Some(material.alpha_test.map(AlphaCutoff).unwrap_or(AlphaCutoff(0.5)))
    } else {
        None
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
        alpha_cutoff,
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
        // `Wireframe` 着色器（只画边线）标记给运行时：three.js GLTFLoader 会把 material `extras`
        // 放进 `material.userData`，替换材质时据此置 `wireframe = true`（见 lightmap-shader.ts）。
        extras: if material.wireframe {
            serde_json::value::to_raw_value(&serde_json::json!({ "vbsp_wireframe": true }))
                .map(Some)
                .unwrap_or_default()
        } else {
            Extras::default()
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
