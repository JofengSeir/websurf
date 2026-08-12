//! wasm-bindgen 导出层(仅 `--features wasm` 时编译)。
//!
//! 最小"导入 → 解析 → 导出"API:
//! - [`bsp_to_glb`]:bsp 字节 → GLB 字节(一条龙:解析 + 场景重建 + 序列化)
//! - [`bsp_info`]:bsp 字节 → 元数据 JSON(版本/lump/实体数/三角形统计)

#![cfg(feature = "wasm")]

use wasm_bindgen::prelude::*;

use crate::{BspError, BspFile};

/// 解析 BSP 并导出 GLB 字节。
///
/// @param {Uint8Array} bsp_bytes BSP 文件内容
/// @returns {Uint8Array} GLB 字节
#[wasm_bindgen]
pub fn bsp_to_glb(bsp_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    let bsp = BspFile::new(bsp_bytes.to_vec()).map_err(js_err)?;
    let primitives = crate::scene::rebuild_scene(&bsp).map_err(js_err)?;
    Ok(crate::glb::build_glb(&primitives, "bsp"))
}

/// 解析 BSP 返回元数据 JSON。
///
/// @param {Uint8Array} bsp_bytes BSP 文件内容
/// @returns {string} JSON:版本、mapRevision、lump 列表、实体数、PAK 条目数、几何统计
#[wasm_bindgen]
pub fn bsp_info(bsp_bytes: &[u8]) -> Result<String, JsValue> {
    let bsp = BspFile::new(bsp_bytes.to_vec()).map_err(js_err)?;

    // lump 概况
    let mut lumps_present = 0;
    let mut lumps_compressed = 0;
    for i in 0..crate::BSP_LUMP_COUNT {
        if let Some(entry) = bsp.lump_entry(i) {
            if entry.is_present() {
                lumps_present += 1;
                if entry.is_compressed() {
                    lumps_compressed += 1;
                }
            }
        }
    }

    // 实体数
    let entities = bsp.entities().map_err(js_err)?;

    // PAK 条目数
    let pak_entries = bsp.pak_entries().map(|v| v.len()).unwrap_or(0);

    // 几何统计(与 GLB 导出同路径)
    let primitives = crate::scene::rebuild_scene(&bsp).map_err(js_err)?;
    let total_verts: usize = primitives.iter().map(|p| p.vertices.len()).sum();
    let total_tris: usize = primitives.iter().map(|p| p.indices.len() / 3).sum();
    let material_groups = primitives.len();

    let info = serde_json::json!({
        "version": bsp.version(),
        "mapRevision": bsp.map_revision(),
        "lumpsPresent": lumps_present,
        "lumpsCompressed": lumps_compressed,
        "entities": entities.len(),
        "pakEntries": pak_entries,
        "materialGroups": material_groups,
        "vertices": total_verts,
        "triangles": total_tris,
    });

    Ok(serde_json::to_string(&info).map_err(js_err)?)
}

fn js_err<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

// 编译期确认 BspError 可用于错误路径
#[allow(dead_code)]
fn _type_check(_: BspError) -> JsValue {
    js_err(BspError::TooSmall(0))
}
