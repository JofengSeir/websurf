//! WSBW 二进制碰撞世界导出（T-D135）。
//!
//! **单一编解码实现**：这里的导出只负责把 BSP / PAKFILE 的碰撞数据喂进
//! `websurf_phys::phys::world_bin` 的编码器；解码只在 `websurf-phys` 侧
//! （`PhysWorld::build_world_binary`）存在一份。禁止在这里另写格式。
//!
//! 数据来源与 JSON 出口完全同一份提取函数：
//! - brush：`bsp::common::extract_brushes_planes`（过滤、九分支统计、坐标/法线约定不变）
//! - 模型三角形：`bsp::colliders_impl::export_model_{phy,tri}_colliders_data`（含置换面）
//!
//! 只读 `&Bsp` / `&PakfileModels`，不消费 BSP 句柄。

use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use websurf_phys::phys::world::TriMesh;
use websurf_phys::phys::world_bin::{encode_brushes, encode_tri_meshes};
use websurf_phys::phys::{PhysBrush, PhysPlane};
use websurf_wasm_core::render_bundle::PakfileModels;
use websurf_wasm_core::vbsp;

use super::colliders_impl::{export_model_phy_colliders_data, export_model_tri_colliders_data, TriMeshData};
use super::common::{extract_brushes_planes, BrushPlanesOpts, WasmBrush};

/// 把 JSON 出口的 brush 结构转成物理侧 `PhysBrush`（字段一一对应，无重算）。
fn to_phys_brush(b: WasmBrush) -> PhysBrush {
    PhysBrush {
        planes: b
            .planes
            .into_iter()
            .map(|p| PhysPlane {
                normal: p.normal,
                dist: p.dist,
            })
            .collect(),
        min: b.min,
        max: b.max,
        is_ladder: b.is_ladder,
        is_solid: b.is_solid,
        entity: b.entity,
        start_solid: b.start_solid,
    }
}

/// 把碰撞提取结果转成物理侧 `TriMesh`（JSON 里是 f32，二进制格式也是 f32，宽度一致）。
fn to_tri_mesh(d: TriMeshData) -> TriMesh {
    TriMesh {
        name: d.name,
        vertices: d
            .vertices
            .iter()
            .map(|v| [v[0] as f64, v[1] as f64, v[2] as f64])
            .collect(),
        indices: d.indices,
        min: [d.min[0] as f64, d.min[1] as f64, d.min[2] as f64],
        max: [d.max[0] as f64, d.max[1] as f64, d.max[2] as f64],
    }
}

fn encode_error(e: websurf_phys::phys::world_bin::WorldBinError) -> JsValue {
    JsValue::from_str(&format!("WSBW 编码失败: {e}"))
}

/// 编码后的缓冲区直接给 JS `Uint8Array`（wasm-bindgen 会拷进 JS 堆，主线程可安全 transfer）。
fn to_js_bytes(bytes: Vec<u8>) -> Uint8Array {
    Uint8Array::from(bytes.as_slice())
}

/// brush 平面 → WSBW 二进制。
pub(crate) fn brushes_planes_bin(
    bsp: &vbsp::Bsp,
    filter_json: &str,
    opts: BrushPlanesOpts,
) -> Result<Uint8Array, JsValue> {
    let brushes = extract_brushes_planes(bsp, filter_json, opts)?;
    let phys: Vec<PhysBrush> = brushes.into_iter().map(to_phys_brush).collect();
    let bytes = encode_brushes(&phys).map_err(encode_error)?;
    Ok(to_js_bytes(bytes))
}

/// 可视网格三角形 → WSBW 二进制。
pub(crate) fn tri_colliders_bin(
    bsp: &vbsp::Bsp,
    pak: &PakfileModels,
) -> Result<Uint8Array, JsValue> {
    let data = export_model_tri_colliders_data(bsp, pak)?;
    encode_meshes(data)
}

/// `.phy` 凸包三角形 → WSBW 二进制。
pub(crate) fn phy_colliders_bin(
    bsp: &vbsp::Bsp,
    pak: &PakfileModels,
) -> Result<Uint8Array, JsValue> {
    let data = export_model_phy_colliders_data(bsp, pak)?;
    encode_meshes(data)
}

/// `colliderSource` 语义（与 TS `buildWorldBundle` 的 auto 分支逐条一致）：
/// - `visual`：可视网格
/// - `phy`（以及任何未知值）：`.phy`
/// - `auto`：`.phy` 实例在前，再加可视网格里 `name` 未出现在 `.phy` 结果中的实例
///
/// 逐实例回退（而非整表回退）是既有语义：个别模型缺 `.phy` 时只有它退到可视网格。
pub(crate) fn model_colliders_bin(
    bsp: &vbsp::Bsp,
    pak: &PakfileModels,
    source: &str,
) -> Result<Uint8Array, JsValue> {
    if source == "visual" {
        return tri_colliders_bin(bsp, pak);
    }
    if source != "auto" {
        return phy_colliders_bin(bsp, pak);
    }

    let phy = export_model_phy_colliders_data(bsp, pak)?;
    let phy_names: std::collections::HashSet<String> =
        phy.iter().map(|d| d.name.clone()).collect();
    let visual = export_model_tri_colliders_data(bsp, pak)?;
    let mut merged = phy;
    merged.extend(
        visual
            .into_iter()
            .filter(|d| !phy_names.contains(&d.name)),
    );
    encode_meshes(merged)
}

fn encode_meshes(data: Vec<TriMeshData>) -> Result<Uint8Array, JsValue> {
    let meshes: Vec<TriMesh> = data.into_iter().map(to_tri_mesh).collect();
    let bytes = encode_tri_meshes(&meshes).map_err(encode_error)?;
    Ok(to_js_bytes(bytes))
}
