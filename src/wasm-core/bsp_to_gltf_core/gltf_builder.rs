//! `gltf_builder` —— 材质与纹理 → `gltf_json` 结构，并把 PNG 字节追加进 GLB 的 BIN 缓冲。
//!
//! 在主流程中的位置：
//! - 上游：`src/wasm-core/bsp_to_gltf_core/convert.rs` 的 `push_bsp_face_bsp` 逐世界面调
//!   [`push_or_get_material_bsp`]，只在 `ConvertOptions::textures` 为真时；材质数据由
//!   `src/wasm-core/bsp_to_gltf_core/materials.rs` 的 `load_material_fallback_bsp` 提供。
//! - 下游：产出 glTF 的 `Material` / `Texture` / `Image` / `buffer::View` 四类对象与
//!   BIN 字节；材质侧只有 `wireframe` 一项写进 `extras`，由渲染端
//!   `copyMaterialRenderState` 读取（`apps/game/src/renderer/lightmap-shader.ts`，
//!   debug / viewer 各有一份同构副本）。
//!
//! 职责（与本文件的函数一一对应）：
//! - [`push_or_get_material_bsp`]：材质名归一 → 查重 → 加载 → 建 glTF 材质
//! - [`push_material`]：`MaterialData` → glTF `Material`（透明度模式、UV 变换、线框 extras）
//! - [`push_or_get_texture`] / [`push_texture`]：贴图查重 → PNG 编码 → view / image / texture
//! - [`get_material_index`] / [`get_texture_index`]：两条按 `name` 比对的线性查表
//! - [`texture_has_alpha_holes`]：贴图自带镂空的兜底判据
//!
//! 关键不变量：
//! - 查重键是对象自己的 `name` 字段、**大小写敏感的逐字符相等**。材质名在
//!   [`push_or_get_material_bsp`] 里先经 `to_ascii_lowercase`；纹理名保持
//!   `MaterialData::texture` 的 `name`（取自 `$basetexture`，回退材质取材质名）
//!   原样，两者口径不同。
//! - 新对象的下标一律在写入之前取 `len()`；[`push_material`] 不写 `gltf.materials`，
//!   追加由调用方完成，故下标与 `push` 后的位置一致。
//! - 命中查重即返回既有下标：同名材质 / 贴图不会重复追加 glTF 对象与 BIN 字节。
//! - buffer view 的 `buffer` 恒为 `Index::new(0)`——BIN chunk 只有这一个 buffer
//!   （`src/wasm-core/bsp_to_gltf_core/convert.rs` 的 `export_bsp` 建根时只 push 一个）。
//! - 贴图 buffer view 的 `byte_length` 不含随后补的 4 字节对齐零（先记长度，再调
//!   `src/wasm-core/bsp_to_gltf_core/convert.rs` 的 `pad_byte_vector`）；
//!   PNG 编码失败走 `expect` 直接 panic。
//! - 本模块整体 `#![allow(dead_code)]`（`src/wasm-core/bsp_to_gltf_core/mod.rs`
//!   的模块属性）：判断某个 `pub fn` 是否在用必须查调用点，未接线项不会有编译告警。
//!
//! 边界：不做 BSP 字节解析与 pakfile 读取（`bsp` 仅转交
//! `src/wasm-core/bsp_to_gltf_core/materials.rs`），不写文件、
//! 不接触 DOM 与网络——输入是已解码的 `MaterialData`，输出是内存中的 glTF 结构与
//! BIN 字节，GLB 的组装与序列化由 `src/wasm-core/bsp_to_gltf_core/convert.rs` 负责。
//! 本文件不是 crate 外 API：模块声明为私有
//! （`src/wasm-core/bsp_to_gltf_core/mod.rs` 的 `mod gltf_builder;`），
//! 其中的 `pub fn` 只对 `bsp_to_gltf_core` 内部可见。
//!
//! 测试归属：本文件无 `#[cfg(test)]` 与 `#[test]`；本模块的内联测试全在
//! `src/wasm-core/bsp_to_gltf_core/lightmap.rs`。

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

/// 按材质名取既有 glTF 材质；没有就加载并新建一个。
///
/// `material` 先经 `to_ascii_lowercase` 归一，随后同时充当查重键与加载入参：命中
/// `Material::name` 相等者直接返回其下标，**因此仅大小写不同的两个材质名共用同一份
/// glTF 材质**。未命中则调 `src/wasm-core/bsp_to_gltf_core/materials.rs` 的
/// `load_material_fallback_bsp`，把结果交给 [`push_material`] 后追加进 `gltf.materials`。
///
/// `paths` 实参固定为 `&[String::new()]`：查找路径由
/// `src/wasm-core/bsp_to_gltf_core/materials.rs` 的 `load_material_bsp` 自造，
/// 该形参在那边不被读取。
///
/// `texture_collector` 只影响**登记**，不影响加载与查重：`Some` 时 `borrow_mut` 借出后
/// 透传，`None` 时不登记；`src/wasm-core/bsp_to_gltf_core/convert.rs` 传的是共享
/// `Rc<RefCell<TextureCollector>>` 的克隆。
///
/// 返回材质下标：命中查重时是既有材质的，新建时取自追加之前的 `len()`。
/// `MaterialData` 的加载失败回退、缺失资源登记、缺失贴图回退表查表都发生在
/// `load_material_fallback_bsp` 内部，本函数不重复判定。
///
/// 副作用：命中查重时四处都不动；新建材质时向 `buffer` 追加 PNG 字节，向
/// `gltf.buffer_views` / `gltf.images` / `gltf.textures` 各追加对象，并向
/// `gltf.materials` 追加一项。
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
            // 两条分支只差 TextureCollector 的透传：加载入参与查重口径完全相同。
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

/// 在既有材质里按 `Material::name` 查下标。
///
/// 比对是**大小写敏感的逐字符相等**（`mat.name.as_deref() == Some(path)`），`name` 为
/// `None` 的材质不命中；`find_map` 线性扫描，同名多项时返回下标最小者。
/// 扫描范围是整个 `gltf.materials`，其中也含
/// `src/wasm-core/model_integrator/mod.rs` 的 `push_material` 追加的模型材质。
///
/// 调用方 [`push_or_get_material_bsp`] 传入的是已转小写的名字，与建材质时写入的
/// 小写名同源，故两侧键口径一致。
fn get_material_index(materials: &[Material], path: &str) -> Option<Index<Material>> {
    materials
        .iter()
        .enumerate()
        .find_map(|(i, mat)| (mat.name.as_deref() == Some(path)).then_some(i))
        .map(|i| Index::new(i as u32))
}

/// 贴图是否**自带真实镂空**：`alpha < 32` 的像素占比 ≥ 1%。
///
/// 这是**兜底判据**：材质的透明度本应由 VMT 声明（`MaterialData::translucent` 与
/// `MaterialData::alpha_test`），但包内没有 VMT 的材质由
/// `src/wasm-core/bsp_to_gltf_core/materials.rs` 的 `load_material_fallback_bsp`
/// 两个回退分支产出，这两个字段取 `MaterialData::default()` 的 `false` / `None`
/// ⇒ 在 [`push_material`] 里落到 `Opaque`，贴图里已经画好的孔洞就会被当作实心像素上色。
/// 本函数对**每张**贴图都算一遍，让 [`push_material`] 有机会把这类材质改判 `Mask`。
///
/// 判据两端都比 glTF 的 `alphaCutoff 0.5` 严：算作孔洞像素的门槛是 `alpha < 32`
/// （`alphaCutoff 0.5` 的裁切线是 `alpha < 128`），且孔洞占比要 ≥ 1% 才翻转整个材质
/// —— 零星的半透明像素不会改变透明度模式。
///
/// 无 alpha 通道的图像、以及像素数据不足一个 RGBA 像素（`raw.len() < 4`）的图像一律
/// 返回 `false`。只读像素：不修改图像，也不看材质的任何声明。
fn texture_has_alpha_holes(image: &image::DynamicImage) -> bool {
    /// 算作「孔洞」的 alpha 上界：`alpha < 32` 计一个孔洞像素
    /// （`alphaCutoff 0.5` 的裁切线是 `alpha < 128`，这里严得多）。
    const HOLE_ALPHA: u8 = 32;
    /// 孔洞像素占比下限（1%）：低于该比例不改判透明度模式。
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

/// `MaterialData` → glTF `Material`，并把贴图交给 [`push_or_get_texture`] 落地。
///
/// 透明度模式先按 `(translucent, alpha_test.is_some())` 的两两分支决定：
/// - `translucent == true` → `Blend`，**此时 `alpha_test` 被丢弃**（`alpha_cutoff` 只有
///   `Mask` 才写，该值不进入 glTF）；
/// - 否则 `alpha_test.is_some()` → `Mask`；两者都不成立 → `Opaque`。
///
/// 再补一层：`Opaque` 且贴图自带镂空（[`texture_has_alpha_holes`]）→ 改判 `Mask`。
///
/// `Mask` 必定带 `alpha_cutoff`：`alpha_test` 有值用其值，`None` 时用 `0.5`
/// （`alpha_test` 是 [0,1] 的阈值语义，越界值已在 `src/wasm-core/bsp_to_gltf_core/materials.rs`
/// 的 `load_material_bsp` 里归一到 `0.5`）；非 `Mask` 一律 `None`。
///
/// 其余字段映射：`name` 原样写入（调用方已小写）、`no_cull` → `double_sided`、
/// `color` 四通道各除以 `255.0` 得 `base_color_factor`（含 alpha 通道）、
/// `texture` 存在时 `base_color_texture` 的 `tex_coord` 恒为 `0`。
/// `transform` 存在时写 texture info 的 `extensions.KHR_texture_transform`：
/// `translate` 原样作 `offset`、`rotate` 由度转弧度、`scale` 原样，扩展对象其余字段
/// 取默认。无贴图（`texture == None`）时 `base_color_texture` 为 `None`，
/// 材质只用 `base_color_factor` 着色。
/// `Material` 的结构性字段（法线 / 遮蔽 / 自发光贴图、`emissive_factor`、`extensions`）
/// 一律取 `Material::default()`。
///
/// `wireframe == true` 时往 `extras` 写 `{"vbsp_wireframe": true}`；该 `RawValue`
/// 构造失败则 `extras` 退回默认（不写）。渲染端 `copyMaterialRenderState`
/// 读 `material.userData.vbsp_wireframe` 并在替换材质时置 `wireframe = true`
/// （`apps/game/src/renderer/lightmap-shader.ts`）。
///
/// 副作用：`texture` 存在时向 `buffer`、`gltf.buffer_views` / `gltf.images` /
/// `gltf.textures` 追加内容。**不写 `gltf.materials`**——追加由调用方完成。
pub fn push_material(buffer: &mut Vec<u8>, gltf: &mut Root, material: MaterialData) -> Material {
    // 镂空判定必须赶在贴图被取走之前：下面的 `map` 会把 `TextureData` 移出
    // `material.texture`，故这里先用 `as_ref()` 借出来算。
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
    // 只在 `Opaque` 上补判，`Blend` / `Mask` 保持前一步给定的模式：
    // 走 `Opaque` 时 `alpha_cutoff` 为 `None`，贴图 alpha 不产生任何裁切。
    let alpha_mode = match alpha_mode {
        AlphaMode::Opaque if texture_has_holes => AlphaMode::Mask,
        other => other,
    };
    // 只有 `Mask` 才写入 `alpha_cutoff`；`alpha_test` 缺值（含上面补判成 MASK）时填 0.5。
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
            // BSP 侧只有基色贴图：金属度与粗糙度在这里显式写死，其余取 `..default()`。
            metallic_factor: StrengthFactor(0.0),
            roughness_factor: StrengthFactor(1.0),
            ..PbrMetallicRoughness::default()
        },
        // 线框标记：只有 `MaterialData::wireframe`（着色器名为 `Wireframe`，大小写不敏感，
        // 由 `src/wasm-core/bsp_to_gltf_core/materials.rs` 的 `load_material_bsp` 依 VMT 文本
        // 判定）为真才写这一项；键名 `vbsp_wireframe` 与渲染端读的 `material.userData` 键
        // 一致（`apps/game/src/renderer/lightmap-shader.ts` 的 `copyMaterialRenderState`
        // 据此置 `wireframe = true`）；`RawValue` 构造失败则 `extras` 退回默认，不写这一项。
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

/// 按 `TextureData::name` 取既有纹理；没有就编码新建一个。
///
/// 命中 [`get_texture_index`] 即返回既有下标，未命中才调 [`push_texture`] 追加。
/// 下标取自追加之前的 `len()`。
///
/// **本函数不做**：不改贴图名与像素、不按内容比对——查重只认名字，故两张像素不同
/// 但同名的贴图会复用同一份 PNG 与同一个 buffer view。
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

/// 在既有纹理里按 `Texture::name` 查下标。
///
/// 比对是**大小写敏感的逐字符相等**（`tex.name.as_deref() == Some(name)`），`name` 为
/// `None` 的纹理不命中；`find_map` 线性扫描，同名多项时返回下标最小者。
///
/// 与材质名不同，纹理名**不做大小写归一**：它取自 `$basetexture`（回退材质则取材质名），
/// 原样写入 [`push_texture`]，故仅大小写不同的两个名字在这里是两张纹理。
fn get_texture_index(textures: &[Texture], name: &str) -> Option<Index<Texture>> {
    textures
        .iter()
        .enumerate()
        .find_map(|(i, tex)| (tex.name.as_deref() == Some(name)).then_some(i))
        .map(|i| Index::new(i as u32))
}

/// 把一张贴图编码成 PNG 追加进 `buffer`，并补上 buffer view / image / texture 三件套。
///
/// 顺序与不变量：
/// - 颜色类型先归一到 `Rgba8` 或 `Rgb8`（保留原图有无 alpha 通道），此后
///   `bits_per_pixel() / 8` 即每像素字节数（4 或 3），乘宽高得到 `image_buffer_size`；
///   交给 PNG 编码器的是 `as_bytes()` 的前 `image_buffer_size` 字节。
/// - `buffer_start` / `view_start` / `image_start` 都在写入之前取，分别用作 buffer view 的
///   `byte_offset`、image 的 `buffer_view` 与 texture 的 `source`。
/// - `byte_length` 记的是本次 PNG 的字节数，**不含**随后
///   `src/wasm-core/bsp_to_gltf_core/convert.rs` 的 `pad_byte_vector` 补的 4 字节对齐零。
/// - buffer view 的 `buffer` 恒为 `Index::new(0)`，`target` 与 `byte_stride` 都是 `None`。
/// - `View` / `Image` / `Texture` 三者的 `name` 都写贴图名，`mime_type` 固定
///   `image/png`；`Image::uri` 与 `Texture::sampler` 保持 `None`（采样器不由本文件决定）。
///
/// **本函数不去重**：同名贴图由 [`push_or_get_texture`] 挡在前面，直接调用会重复追加
/// BIN 字节与三个 glTF 对象。
/// PNG 编码失败走 `expect("failed to encode")`，直接 panic 而不返回错误。
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
