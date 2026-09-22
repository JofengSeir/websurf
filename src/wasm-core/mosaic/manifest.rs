//! 纹理画质 manifest：BSP 地图的全部纹理 → mosaic 字节码。
//!
//! 上游：本模块自己遍历 `Bsp` 的 model / face 取纹理名，再经
//! `bsp_to_gltf_core::materials::load_material_bsp` 解析出 VTF 图像。
//! 下游：`apps/debug` 与 `apps/game` 的 wasm 层调用 `build_mosaic_manifest`，
//! 把结果随导出物一起下发给前端，供画质切换时还原低清图。
//!
//! 两条互相补充的输出：
//! - `build_mosaic_manifest`：**解析成功**的纹理 → `(名, 字节码)` 列表
//! - `collect_missing_textures`：**解析失败**的纹理名列表（缺 VMT/VTF 或解码失败）
//!
//! 键的口径：两端都用**小写纹理名**（`collect_face_texture_names` 用 face 的材质名，
//! `texture_to_code` 用加载后 `texture.name`），与 GLB 的 `texture.name` 同源，
//! 前端按贴图名匹配。
//!
//! 容错：单张纹理失败只跳过该张，不中断整图 manifest（`build_mosaic_manifest` 内的
//! `if let Ok(...)`）；因此 manifest 长度可以小于纹理去重后的总数，
//! 差额由 `collect_missing_textures` 补齐。

use crate::bsp_to_gltf_core::materials::load_material_bsp;
use crate::bsp_to_gltf_core::ConvertOptions;
use crate::mosaic::encode::img_to_code;
use crate::vbsp::Bsp;

/// 遍历全部 model 的 face，收集**可见** face 的材质名（转小写）并按首次出现顺序去重。
///
/// 只取名字，不读 VMT/VTF，因此不会因为纹理缺失而失败。返回顺序由 model / face 的
/// 遍历顺序决定，是下面三个函数的公共输入。
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

/// 逐个试探纹理能否加载，返回**加载失败**的材质名列表，顺序同 `collect_face_texture_names`。
///
/// 判据是 `load_material_bsp` 返回 `Err`，涵盖缺 VMT、缺 VTF、解码失败等全部失败形态
/// （本函数不区分具体原因）。与 `build_mosaic_manifest` 互补——后者只收成功的。
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

/// 生成整图 manifest：`[(纹理名小写, 字节码), ...]`，顺序同 `collect_face_texture_names`。
///
/// 逐张调用 `texture_to_code`；**单张失败只跳过该张**——不返回错误、不中断整体。
/// 因此返回长度 ≤ 去重纹理总数，差额就是 `collect_missing_textures` 里的那些名字。
/// 键取自加载后 `texture.name` 的小写形式，与 GLB 的 `texture.name` 同源。
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

/// 单张纹理的完整链路：VMT → basetexture → VTF → 解码成图像 → 编成 PNG 字节 →
/// mosaic 字节码，返回 `(小写纹理名, 字节码)`。
///
/// 键用的是加载后的 `texture.name`，**不是**传入的 `material_name`——两者可以不同。
/// 没有贴图、PNG 编码失败或 `img_to_code` 失败都返回 `Err`，由调用方吞掉并跳过。
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
