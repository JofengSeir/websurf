//! 纹理画质 manifest：BSP 地图的全部纹理名 → mosaic 字节码。
//!
//! 前端画质切换（原始纹理 / 压缩低清纹理）的数据源：
//! - 纹理名 = VMT 材质路径小写（`face.texture().name()`，与 GLB material.name 一致）
//! - 字节码 = mosaic v4（`encode::img_to_code`），前端切换时 `decode::code_to_img` 还原低清 PNG
//! 生成时机：GLB 导出后一次遍历（复用 VMT→basetexture→VTF→image 解析链）。

use crate::bsp_to_gltf_core::materials::load_material_bsp;
use crate::bsp_to_gltf_core::ConvertOptions;
use crate::mosaic::encode::img_to_code;
use crate::vbsp::Bsp;

/// 收集地图全部可见 face 的纹理名（VMT 材质路径，小写，去重）。
/// 与 bsp_to_gltf_core 导出时的 TextureCollector 收集逻辑一致。
pub fn collect_face_texture_names(bsp: &Bsp) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for model in bsp.models() {
        for face in model.faces() {
            if !face.is_visible() {
                continue;
            }
            let name = face.texture().name().to_ascii_lowercase();
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names
}

/// 收集地图缺失的材质纹理（VMT/VTF 缺失或解码失败，导出为占位色）。
/// 与 `build_mosaic_manifest` 互补：成功的进 manifest，失败的进此列表。
pub fn collect_missing_textures(bsp: &Bsp) -> Vec<String> {
    let names = collect_face_texture_names(bsp);
    let options = ConvertOptions::default();
    let mut missing = Vec::new();
    for name in &names {
        if load_material_bsp(name, &[String::new()], bsp, &options).is_err() {
            missing.push(name.clone());
        }
    }
    missing
}

/// 生成全部纹理的 mosaic manifest：`[(basetexture 小写, 字节码), ...]`。
/// key 与 GLB texture.name 一致（前端按贴图名匹配）；
/// 单个纹理失败（缺 VMT/VTF）跳过，不中断整体。
pub fn build_mosaic_manifest(bsp: &Bsp) -> Vec<(String, String)> {
    let names = collect_face_texture_names(bsp);
    let options = ConvertOptions::default();
    let mut out = Vec::new();
    for name in &names {
        if let Ok(code) = texture_to_code(bsp, name, &options) {
            out.push(code);
        }
    }
    out
}

/// 单个纹理：VMT → basetexture → VTF → 解码 → PNG 字节 → mosaic 字节码。
/// 返回 (basetexture 小写, 字节码)。
fn texture_to_code(
    bsp: &Bsp,
    material_name: &str,
    options: &ConvertOptions,
) -> Result<(String, String), crate::bsp_to_gltf_core::Error> {
    let material = load_material_bsp(material_name, &[String::new()], bsp, options)?;
    let texture = material
        .texture
        .ok_or_else(|| crate::bsp_to_gltf_core::Error::Other(format!("{material_name}: 无贴图")))?;
    let mut png: Vec<u8> = Vec::new();
    texture
        .image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| crate::bsp_to_gltf_core::Error::Other(format!("PNG 编码失败: {e}")))?;
    let code = img_to_code(&png, &texture.name)
        .map_err(|e| crate::bsp_to_gltf_core::Error::Other(e))?;
    Ok((texture.name.to_ascii_lowercase(), code))
}
