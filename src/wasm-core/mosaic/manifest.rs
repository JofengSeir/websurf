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
use crate::mosaic::encode::img_to_code_dyn;
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
/// 判据有两条：`load_material_bsp` 返回 `Err`（缺 VMT、解码失败等），或返回 `Ok` 但
/// `MaterialData.texture_absent` 为真（`$basetexture` 指向的 `.vtf` 取不到）。
/// 「本就没有 `$basetexture`」（Water）不算缺失。与 `build_mosaic_manifest` 互补。
///
/// **开探针模式**（`ConvertOptions::probe_only`）：这里只要一个布尔结论，原先却对每张不同材质
/// **完整解码**一遍 VTF。实测 `surf_axil` 因此要 857 s、`surf_kraken` 8.2 s；探针只做「头部可解析 +
/// 格式有解码臂 + 帧长落在字节内」，判否时才真解一次兜底，结论不变。
pub fn collect_missing_textures(bsp: &Bsp) -> Vec<String> {
    collect_missing_textures_with(bsp, &ConvertOptions::default())
}

/// 同 `collect_missing_textures`，但接受调用方的选项（至少带上回退 VMT 表）。
///
/// 为什么需要：P1 之后，地图 pakfile 里没有、但游戏本体自带的 VMT 由
/// `ConvertOptions::vmt_fallback` 救回；诊断面板若仍用空表，会把已救回的材质继续报成缺失。
/// `probe_only` 由本函数强制为真（诊断只问「能不能解」）。
pub fn collect_missing_textures_with(bsp: &Bsp, options: &ConvertOptions) -> Vec<String> {
    let names = collect_face_texture_names(bsp);
    let mut options = options.clone();
    options.probe_only = true;
    let options = options;
    let mut missing = Vec::new();
    for name in &names {
        match load_material_bsp(name, &[String::new()], bsp, &options) {
            Ok(m) if !m.texture_absent => {}
            _ => missing.push(name.clone()),
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
    // 直接喂已解码的图：原先这里先 `write_to(Png)` 编一遍、`img_to_code` 再 `load_from_memory`
    // 解回来，而本链路只要一张 ≤50 像素的缩略 —— 4096×4096 上这轮往返是秒级纯浪费。
    let code = img_to_code_dyn(&texture.image, &texture.name);
    Ok((texture.name.to_ascii_lowercase(), code))
}
