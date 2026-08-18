//! WASM bindings for BSP parsing, GLB export and VTF decoding.
//!
//! 将 BSP 解析、GLB 导出、VTF 纹理解码暴露给 JavaScript，供浏览器直接预览/导出。
//!
//! MVP 范围：
//! - [`parse_bsp`]: 解析 BSP 字节数组，返回元数据 JSON（不持有 Bsp 实例）
//! - [`BspProcessor`]: 持有已解析的 Bsp 实例，可调用 [`BspProcessor::export_glb`] 导出 GLB 字节
//! - [`decode_vtf_to_png`]: 将 VTF 字节数组解码为 PNG 字节数组

use std::collections::HashMap;
use std::io::Cursor;

use wasm_bindgen::prelude::*;

// 解析层共享自仓库根 src/wasm-core/（websurf-wasm-core crate）
use websurf_wasm_core::{bsp_to_gltf_core, model_integrator, pakfile_models, phyfile, texture_utils, vbsp};
use model_integrator::{
    ExportOptions, InMemoryModel, InMemoryResources, ModelIntegrator, StaticProp,
};

// 物理系统：共享自仓库根 src/（websurf-phys crate）
pub use websurf_phys::phys::PhysWorld;

// ---------------------------------------------------------------------------
// 错误处理辅助
// ---------------------------------------------------------------------------

/// 将任意错误转换为 JavaScript 错误。
fn to_js_err<E: std::fmt::Debug>(e: E, ctx: &str) -> JsValue {
    JsValue::from_str(&format!("{}: {:?}", ctx, e))
}

// ---------------------------------------------------------------------------
// PAKFILE 内嵌模型：三件套提取 / 材质解析 / 碰撞体参数
// ---------------------------------------------------------------------------

/// PAKFILE 材质解析产物。
#[derive(Default)]
struct PakMaterials {
    /// `材质名 → PNG 字节`。键须与 `vmdl::TextureInfo::name` 逐字符一致，供 `push_texture` 查表。
    textures: HashMap<String, Vec<u8>>,
    /// `材质名 → alpha_mode`（0 = Opaque，1 = Blend，2 = Mask）。
    alpha_modes: HashMap<String, u8>,
}

/// 提取被 `static_props` 引用且 `.mdl/.vvd/.dx90.vtx` 齐全的模型。
///
/// 返回 `(模型三件套, 静态道具放置表, PAKFILE 全部条目名)`；
/// 第三项供 [`pakfile_models::PakIndex`] 复用，避免为找材质再遍历 zip。
fn collect_pakfile_models(
    bsp: &vbsp::Bsp,
) -> Result<(Vec<InMemoryModel>, Vec<StaticProp>, Vec<String>), JsValue> {
    // 1. 被静态道具引用的模型路径集合
    let mut referenced: std::collections::HashSet<String> = std::collections::HashSet::new();
    for prop in bsp.static_props() {
        referenced.insert(prop.model().to_string());
    }

    // 2. 枚举 PAKFILE 全部条目（zip 只锁一次）
    let zip = bsp.pack.clone().into_zip();
    let mut zip_guard = zip
        .lock()
        .map_err(|e| JsValue::from_str(&format!("pakfile 锁定失败: {e}")))?;
    let mut entry_names: Vec<String> = Vec::with_capacity(zip_guard.len());
    for i in 0..zip_guard.len() {
        if let Ok(entry) = zip_guard.by_index(i) {
            entry_names.push(entry.name().to_string());
        }
    }
    drop(zip_guard);

    // 3. 仅为被引用的模型提取三件套（缺任一件即跳过）
    let mut models: Vec<InMemoryModel> = Vec::new();
    for name in &entry_names {
        if !name.to_ascii_lowercase().ends_with(".mdl") || !referenced.contains(name) {
            continue;
        }
        let vvd_name = name.replace(".mdl", ".vvd");
        let vtx_name = name.replace(".mdl", ".dx90.vtx");
        let mdl = match bsp.pack.get(name) {
            Ok(Some(d)) => d,
            _ => continue,
        };
        let vvd = match bsp.pack.get(&vvd_name) {
            Ok(Some(d)) => d,
            _ => continue,
        };
        let vtx = match bsp.pack.get(&vtx_name) {
            Ok(Some(d)) => d,
            _ => continue,
        };
        models.push(InMemoryModel {
            name: name.clone(),
            mdl,
            vvd,
            vtx,
        });
    }

    // 4. static_props 放置表（GLB 节点与碰撞体共用）
    let static_props: Vec<StaticProp> = bsp
        .static_props()
        .enumerate()
        .map(|(_i, prop)| StaticProp {
            model: prop.model().to_string(),
            origin: [prop.origin.x, prop.origin.y, prop.origin.z],
            angles: prop.angles(),
            solid: prop.solid as u8,
        })
        .collect();

    Ok((models, static_props, entry_names))
}

/// 加载内存中的模型三件套为 `vmdl::Model`（任一环节失败即返回 `None`）。
fn load_vmdl(m: &InMemoryModel) -> Option<vmdl::Model> {
    let mdl = vmdl::Mdl::read(&m.mdl).ok()?;
    let vtx = vmdl::Vtx::read(&m.vtx).ok()?;
    let vvd = vmdl::Vvd::read(&m.vvd).ok()?;
    Some(vmdl::Model::from_parts(mdl, vtx, vvd))
}

/// 解析所有被引用模型的材质：从 PAKFILE 取 `.vmt` 得透明度标注，再按 `$basetexture` 取 `.vtf` 解码为 PNG。
///
/// `decode_textures = false` 时只解析标注、跳过图像解码（碰撞体路径用此模式）。
///
/// 材质路径解析顺序：`TextureInfo::search_paths` → `Mdl::texture_paths` → 裸材质名，
/// 均交 [`pakfile_models::PakIndex`] 做大小写不敏感 + `materials/` 前缀补全匹配。
fn resolve_pakfile_materials(
    bsp: &vbsp::Bsp,
    models: &[InMemoryModel],
    index: &pakfile_models::PakIndex,
    decode_textures: bool,
) -> PakMaterials {
    let mut out = PakMaterials::default();

    // 从 PAKFILE 取 VMT 文本
    let fetch_vmt = |path: &str| -> Option<pakfile_models::VmtInfo> {
        let entry = index.find(path, "vmt")?;
        let bytes = match bsp.pack.get(entry) {
            Ok(Some(b)) => b,
            _ => return None,
        };
        Some(pakfile_models::parse_vmt(&String::from_utf8_lossy(&bytes)))
    };

    for m in models {
        // 只读 .mdl 枚举材质（比 from_parts 便宜）
        let Ok(mdl) = vmdl::Mdl::read(&m.mdl) else {
            continue;
        };

        for tex in &mdl.textures {
            if out.alpha_modes.contains_key(&tex.name) {
                continue; // 共享材质只解析一次
            }

            // 候选路径：搜索目录 + 材质名，外加裸材质名
            let mut candidates: Vec<String> = Vec::new();
            for sp in tex.search_paths.iter().chain(mdl.texture_paths.iter()) {
                let sp = sp.replace('\\', "/");
                let sp = sp.trim_matches('/');
                if sp.is_empty() {
                    continue;
                }
                candidates.push(format!("{sp}/{}", tex.name));
            }
            candidates.push(tex.name.clone());

            let Some(mut info) = candidates.iter().find_map(|c| fetch_vmt(c)) else {
                // VMT 未打包 → 按不透明处理（保留碰撞）
                out.alpha_modes.insert(tex.name.clone(), 0);
                continue;
            };

            // `patch` 材质：跟一层 include 拿真正的 $basetexture；母材质半透明时透明度继承
            if info.basetexture.is_none() {
                if let Some(inc) = info.include.clone() {
                    if let Some(base_info) = fetch_vmt(&inc) {
                        info.basetexture = base_info.basetexture;
                        if info.alpha_mode == 0 {
                            info.alpha_mode = base_info.alpha_mode;
                        }
                    }
                }
            }

            out.alpha_modes.insert(tex.name.clone(), info.alpha_mode);

            if !decode_textures {
                continue;
            }
            let Some(base) = info.basetexture else {
                continue;
            };
            let Some(vtf_entry) = index.find(&base, "vtf") else {
                continue;
            };
            let Ok(Some(vtf_bytes)) = bsp.pack.get(vtf_entry) else {
                continue;
            };
            if let Ok(png) = decode_vtf_to_png(&vtf_bytes) {
                out.textures.insert(tex.name.clone(), png);
            }
        }
    }

    out
}

// ---------------------------------------------------------------------------
// 全局初始化
// ---------------------------------------------------------------------------

/// 在 WASM panic 时打印到控制台，便于调试。
#[cfg(target_arch = "wasm32")]
pub fn init_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        web_sys::console::error_1(&format!("vbsp-wasm panic: {}", info).into());
    }));
}

// ---------------------------------------------------------------------------
// 元数据 / 解析入口
// ---------------------------------------------------------------------------

/// 顶层元数据，前端通过 `JSON.parse(parse_bsp(data))` 直接使用。
///
/// 普通 Rust 结构体（不标 `#[wasm_bindgen]`）：wasm_bindgen 导出要求字段实现 `Copy`，
/// 而 `String` 字段不满足；经 `parse_bsp` / [`BspProcessor::metadata`] 序列化为 JSON 返回。
#[derive(serde::Serialize)]
pub struct BspMetadata {
    pub schema_version: u32,
    /// BSP 魔术字（如 "VBSP"），由 header.v/b/s/p 拼成。
    pub magic: String,
    pub map_name: String,
    pub num_models: usize,
    pub num_faces: usize,
    pub num_original_faces: usize,
    pub num_vertices: usize,
    pub num_edges: usize,
    pub num_textures_data: usize,
    pub num_textures_info: usize,
    pub num_displacements: usize,
    pub num_entities: usize,
    pub num_static_props: usize,
    pub num_brushes: usize,
    pub num_leaves: usize,
    pub num_nodes: usize,
    /// pakfile 中打包的文件数（VFS 资源数）。
    pub packed_files: usize,
}

impl BspMetadata {
    // packed_files 由调用方传入：vbsp 0.6.0 的 Packfile.zip 为私有字段，
    // into_zip() 消费 self，只能 clone 后取 len()；由 new 缓存避免 metadata() 重复克隆。
    fn from_bsp(bsp: &vbsp::Bsp, packed_files: usize) -> Self {
        let num_entities = bsp.entities.iter().count();
        let num_static_props = bsp.static_props().count();

        let h = &bsp.header;
        let magic = format!("{}{}{}{}", h.v as char, h.b as char, h.s as char, h.p as char);

        BspMetadata {
            schema_version: 1,
            magic,
            map_name: String::new(),
            num_models: bsp.models.len(),
            num_faces: bsp.faces.len(),
            num_original_faces: bsp.original_faces.len(),
            num_vertices: bsp.vertices.len(),
            num_edges: bsp.edges.len(),
            num_textures_data: bsp.textures_data.len(),
            num_textures_info: bsp.textures_info.len(),
            num_displacements: bsp.displacements.len(),
            num_entities,
            num_static_props,
            num_brushes: bsp.brushes.len(),
            num_leaves: bsp.leaves.len(),
            num_nodes: bsp.nodes.len(),
            packed_files,
        }
    }

    fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(self).map_err(|e| to_js_err(e, "序列化 BSP 元数据失败"))
    }
}

/// 一次性解析 BSP 字节数组，返回元数据 JSON 字符串。
///
/// 这个函数不持有 Bsp 实例。如果需要导出 GLB，请使用 [`BspProcessor`]。
#[wasm_bindgen]
pub fn parse_bsp(data: &[u8]) -> Result<String, JsValue> {
    let bsp = vbsp::Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;
    // Packfile.zip 私有，clone 后取 len()
    let packed_files = bsp.pack.clone().into_zip().lock().unwrap().len();
    let metadata = BspMetadata::from_bsp(&bsp, packed_files);
    metadata.to_json()
}

// ---------------------------------------------------------------------------
// 处理器（持有 Bsp 实例，可重复导出 / 提取）
// ---------------------------------------------------------------------------

/// BSP 处理器：先调用 [`BspProcessor::new`] 解析字节数组，再调用
/// [`BspProcessor::export_glb`] 导出 GLB，或 [`BspProcessor::metadata`]
/// 获取元数据。
#[wasm_bindgen]
pub struct BspProcessor {
    bsp: Option<vbsp::Bsp>,
    /// 缓存的 pakfile 文件数，避免 metadata() 重复克隆 Packfile
    packed_files: usize,
}

#[wasm_bindgen]
impl BspProcessor {
    /// 创建处理器并立即解析 BSP 数据。
    #[wasm_bindgen(constructor)]
    pub fn new(data: &[u8]) -> Result<BspProcessor, JsValue> {
        let bsp = vbsp::Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;
        // 一次性计算并缓存 packed_files，避免 metadata() 重复克隆 Packfile
        let packed_files = bsp.pack.clone().into_zip().lock().unwrap().len();
        Ok(BspProcessor {
            bsp: Some(bsp),
            packed_files,
        })
    }

    /// 获取元数据 JSON 字符串（不消耗内部 Bsp 实例）。
    pub fn metadata(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;
        let metadata = BspMetadata::from_bsp(bsp, self.packed_files);
        metadata.to_json()
    }

    /// 导出为 GLB 字节数组。
    ///
    /// 消耗内部 Bsp 实例（`export_bsp` 接收 `Bsp` 而非 `&Bsp`）；再次导出需重新 [`BspProcessor::new`]。
    pub fn export_glb(&mut self) -> Result<Vec<u8>, JsValue> {
        let bsp = self
            .bsp
            .take()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费"))?;

        let options = bsp_to_gltf_core::ConvertOptions::default();
        let result = bsp_to_gltf_core::export_bsp(bsp, options)
            .map_err(|e| to_js_err(e, "GLB 导出失败"))?;

        // Glb::to_writer 接受任何 std::io::Write 对象
        let mut output: Vec<u8> = Vec::new();
        result
            .glb
            .to_writer(&mut output)
            .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;

        Ok(output)
    }

    /// 导出为 GLB，并将**内存中的模型**（.mdl/.vvd/.dx90.vtx 字节）直接合并进同一地图。
    ///
    /// 全程在 WASM 内存完成"模型 + 地图"合并，不依赖文件系统
    /// （对应 EXPORT_GUIDE.md 的磁盘两步流程）。
    ///
    /// # 参数
    /// - `models_js`: 模型字节数组。元素形如
    ///   `{ "name": "…/crate.mdl", "mdl": Uint8Array, "vvd": Uint8Array, "vtx": Uint8Array }`；
    ///   `name` 须能在 BSP 静态道具字典中找到，用于匹配世界坐标/朝向。
    /// - `textures_js`: 可选纹理对象。键为纹理名（如 `"metal/crate"`），值为 PNG 字节。
    ///
    /// # 放置信息
    /// 位置（origin）、朝向（angles）、默认缩放与类名均从 BSP 的 `static_props` lump 自动派生，无需外部 JSON。
    ///
    /// 注意：同样会**消耗**内部 Bsp 实例（与 [`BspProcessor::export_glb`] 一致）。
    pub fn export_glb_with_models(
        &mut self,
        models_js: JsValue,
        textures_js: JsValue,
    ) -> Result<Vec<u8>, JsValue> {
        let bsp = self
            .bsp
            .take()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;

        // 解析 JS 传入的内存模型与纹理
        let models: Vec<InMemoryModel> = serde_wasm_bindgen::from_value(models_js)
            .map_err(|e| JsValue::from_str(&format!("模型参数解析失败: {:?}", e)))?;
        let textures: HashMap<String, Vec<u8>> = serde_wasm_bindgen::from_value(textures_js)
            .map_err(|e| JsValue::from_str(&format!("纹理参数解析失败: {:?}", e)))?;

        // 从 BSP 派生静态道具放置信息（位置/朝向/缩放）
        let mut static_props = Vec::new();
        for (_i, prop) in bsp.static_props().enumerate() {
            static_props.push(StaticProp {
                model: prop.model().to_string(),
                origin: [prop.origin.x, prop.origin.y, prop.origin.z],
                angles: prop.angles(),
                solid: prop.solid as u8,
            });
        }

        let resources = InMemoryResources {
            models,
            entities: Vec::new(),
            static_props,
            textures,
            material_alpha_mode: std::collections::HashMap::new(),
            light_entities: Vec::new(),
        };

        let integrator = ModelIntegrator::from_in_memory(resources, ExportOptions::default());
        let options = bsp_to_gltf_core::ConvertOptions::default();
        let result = bsp_to_gltf_core::export_bsp_with_models(bsp, options, Some(&integrator))
            .map_err(|e| to_js_err(e, "GLB 导出失败"))?;

        let mut output: Vec<u8> = Vec::new();
        result
            .glb
            .to_writer(&mut output)
            .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;

        Ok(output)
    }

    /// 自动从 BSP 的 **PAKFILE lump** 提取模型并合并进同一份地图 GLB。
    ///
    /// 许多 Source BSP 会把引用的 `.mdl/.vvd/.dx90.vtx` 打包进 PAKFILE，
    /// 因此无需外部游戏资源即可在浏览器还原静态道具几何。
    ///
    /// 流程：收集 `static_props` 引用的模型路径 → 枚举 PAKFILE 提取三件套字节 →
    /// 从 `static_props` 派生位置/朝向 → 调 [`bsp_to_gltf_core::export_bsp_with_models`] 合并导出。
    ///
    /// 若 BSP 未打包任何被引用模型（依赖共享游戏资源，如多数 CS:S 官方图），
    /// **自动回退为纯地图导出**，不报错、不降级。
    ///
    /// 注意：此操作会消耗内部 Bsp 实例（与 [`BspProcessor::export_glb`] 一致）。
    pub fn export_glb_with_pakfile_models(&mut self) -> Result<Vec<u8>, JsValue> {
        let bsp = self
            .bsp
            .take()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;

        // 1~3. 提取被引用且三件套齐全的模型 + 放置表 + PAKFILE 条目清单
        let (models, static_props, entry_names) = collect_pakfile_models(&bsp)?;

        // 4. 未打包任何模型 → 回退为纯地图导出（非破坏式）
        if models.is_empty() {
            let options = bsp_to_gltf_core::ConvertOptions::default();
            let result = bsp_to_gltf_core::export_bsp(bsp, options)
                .map_err(|e| to_js_err(e, "GLB 导出失败"))?;
            let mut output: Vec<u8> = Vec::new();
            result
                .glb
                .to_writer(&mut output)
                .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;
            return Ok(output);
        }

        // 5. 解析 PAKFILE 内的 VMT/VTF：贴图字节 + 内置透明度标注
        let index = pakfile_models::PakIndex::build(&entry_names);
        let materials = resolve_pakfile_materials(&bsp, &models, &index, true);

        let resources = InMemoryResources {
            models,
            entities: Vec::new(),
            static_props,
            textures: materials.textures,
            material_alpha_mode: materials.alpha_modes,
            light_entities: Vec::new(),
        };

        let integrator = ModelIntegrator::from_in_memory(resources, ExportOptions::default());
        let options = bsp_to_gltf_core::ConvertOptions::default();
        let result = bsp_to_gltf_core::export_bsp_with_models(bsp, options, Some(&integrator))
            .map_err(|e| to_js_err(e, "GLB 导出失败"))?;

        let mut output: Vec<u8> = Vec::new();
        result
            .glb
            .to_writer(&mut output)
            .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;

        Ok(output)
    }

    /// 导出 GLB（含 PAKFILE 模型）+ **缺失纹理回退**：`defaults_json` 为默认纹理包
    /// （`{ "materials/<材质路径小写>": "#mosaic v4 字节码" }`），材质缺失时直接
    /// 在导出期解码低清纹理嵌入 GLB——渲染端拿到的即自包含场景，零后期处理。
    ///
    /// 与 [`BspProcessor::export_glb_with_pakfile_models`] 同流程，仅注入回退表。
    pub fn export_glb_with_pakfile_models_with_defaults(
        &mut self,
        defaults_json: &str,
    ) -> Result<Vec<u8>, JsValue> {
        let bsp = self
            .bsp
            .take()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;
        let fallback: std::collections::HashMap<String, String> =
            serde_json::from_str(defaults_json).map_err(|e| to_js_err(e, "默认纹理包 JSON 解析失败"))?;

        let (models, static_props, entry_names) = collect_pakfile_models(&bsp)?;

        let options = |generate_missing_list: bool| bsp_to_gltf_core::ConvertOptions {
            missing_fallback: fallback.clone(),
            generate_missing_list,
            ..bsp_to_gltf_core::ConvertOptions::default()
        };

        if models.is_empty() {
            let result = bsp_to_gltf_core::export_bsp(bsp, options(true))
                .map_err(|e| to_js_err(e, "GLB 导出失败"))?;
            let mut output: Vec<u8> = Vec::new();
            result
                .glb
                .to_writer(&mut output)
                .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;
            return Ok(output);
        }

        let index = pakfile_models::PakIndex::build(&entry_names);
        let materials = resolve_pakfile_materials(&bsp, &models, &index, true);
        let resources = InMemoryResources {
            models,
            entities: Vec::new(),
            static_props,
            textures: materials.textures,
            material_alpha_mode: materials.alpha_modes,
            light_entities: Vec::new(),
        };
        let integrator = ModelIntegrator::from_in_memory(resources, ExportOptions::default());
        let result = bsp_to_gltf_core::export_bsp_with_models(bsp, options(true), Some(&integrator))
            .map_err(|e| to_js_err(e, "GLB 导出失败"))?;
        let mut output: Vec<u8> = Vec::new();
        result
            .glb
            .to_writer(&mut output)
            .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;
        Ok(output)
    }

    /// 导出 **PAKFILE 内嵌模型的「可视网格」作为碰撞网格**（世界空间三角形，零转化）。
    ///
    /// 本方法**不做任何转化**：不挤出厚度、不共面合并、不凸包、不 OBB 回退 ——
    /// 输出的三角形与 GLB 显示网格**逐位一致**（顶点 = 同一条变换链
    /// `map_coords(apply_root_transform(v))` → `place_point`（scale/rot/translation），
    /// 其中 `quat`/`translation` 来自与 GLB 节点同一份 `resolve_placements`）。
    ///
    /// 输出 JSON：`[{ "name", "vertices": [[x,y,z]...], "indices": [[a,b,c]...],
    /// "min": [...], "max": [...] }]`（每个放置实例一个 mesh，世界坐标 Y-up）。
    ///
    /// 透明度门控与碰撞导出一致：真半透明（`$translucent`/`$alpha<1`）材质跳过；
    /// `static_prop.solid == 0`（SOLID_NONE）实例跳过；无标注默认保留。
    ///
    /// # 调用时机
    /// 只借用 BSP，须在 [`BspProcessor::export_glb_with_pakfile_models`]（消费 BSP）之前调用。
    pub fn export_model_tri_colliders(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;

        let (models, static_props, entry_names) = collect_pakfile_models(bsp)?;
        if models.is_empty() {
            return Ok("[]".to_string());
        }

        let index = pakfile_models::PakIndex::build(&entry_names);
        let materials = resolve_pakfile_materials(bsp, &models, &index, false);

        let no_entities: Vec<model_integrator::Entity> = Vec::new();

        /// 单个实例的三角形网格（世界空间，与显示逐位一致）。
        #[derive(serde::Serialize)]
        struct TriMeshOut {
            name: String,
            vertices: Vec<[f32; 3]>,
            indices: Vec<[u32; 3]>,
            min: [f32; 3],
            max: [f32; 3],
        }

        /// 总三角形护栏（防止超大地图把所有 prop 都展开成百万三角形拖垮 trace）。
        const MAX_TRI_TOTAL: usize = 200_000;

        let mut out: Vec<TriMeshOut> = Vec::new();
        let mut tri_total = 0usize;

        for m in &models {
            if tri_total >= MAX_TRI_TOTAL {
                break;
            }

            let placements =
                model_integrator::resolve_placements(&m.name, &no_entities, &static_props);
            let placements: Vec<_> = placements
                .into_iter()
                .filter(|p| p.solid != Some(0))
                .collect();
            if placements.is_empty() {
                continue;
            }

            let Some(model) = load_vmdl(m) else { continue };

            // ---- 局部空间顶点（Y-up，与 GLB 顶点同一变换链）----
            let src = model.vertices();
            let mut local: Vec<[f32; 3]> = Vec::with_capacity(src.len());
            for v in src {
                local.push(model_integrator::map_coords(
                    model.apply_root_transform(v.position),
                ));
            }
            if local.is_empty() {
                continue;
            }

            // ---- 展开三角（vendored vmdl 已修复条带展开），逐 mesh 做透明度门控 ----
            let skin = model.skin_tables().next();
            let mut tris: Vec<[u32; 3]> = Vec::new();
            for mesh in model.meshes() {
                let alpha = skin
                    .as_ref()
                    .and_then(|s| s.texture_info(mesh.material_index()))
                    .and_then(|t| materials.alpha_modes.get(&t.name).copied())
                    .unwrap_or(0);
                if alpha == 1 {
                    continue; // 真半透明：可穿过
                }
                let idx: Vec<usize> = mesh.vertex_strip_indices().flatten().collect();
                for c in idx.chunks_exact(3) {
                    let (a, b, d) = (c[0], c[1], c[2]);
                    if a >= local.len() || b >= local.len() || d >= local.len() {
                        continue;
                    }
                    tris.push([a as u32, b as u32, d as u32]);
                }
            }
            if tris.is_empty() {
                continue;
            }

            // ---- 每个放置实例：顶点搬移到世界空间（与 GLB 节点同一变换）----
            for p in &placements {
                if tri_total >= MAX_TRI_TOTAL {
                    break;
                }
                let mut verts: Vec<[f32; 3]> = Vec::with_capacity(local.len());
                for v in &local {
                    verts.push(pakfile_models::place_point(
                        *v, p.translation, p.rotation, p.scale,
                    ));
                }
                let mut min = [f32::INFINITY; 3];
                let mut max = [f32::NEG_INFINITY; 3];
                for v in &verts {
                    for i in 0..3 {
                        if v[i] < min[i] {
                            min[i] = v[i];
                        }
                        if v[i] > max[i] {
                            max[i] = v[i];
                        }
                    }
                }
                if !min.iter().all(|f| f.is_finite()) {
                    continue;
                }
                tri_total += tris.len();
                out.push(TriMeshOut {
                    name: m.name.clone(),
                    vertices: verts,
                    indices: tris.clone(),
                    min,
                    max,
                });
            }
        }

        serde_json::to_string(&out).map_err(|e| to_js_err(e, "序列化模型三角形碰撞失败"))
    }

    /// 导出 **PAKFILE 内嵌模型的「自带物理碰撞体」（`.phy`）** 为世界空间凸包三角形。
    ///
    /// 与 [`BspProcessor::export_model_tri_colliders`]（可视网格）不同，本方法解析模型
    /// 自己打包的 vphysics 碰撞体（`.phy`，Source 引擎实际使用的碰撞，凸包分解、更简化）。
    /// 输出格式与三角形碰撞**同构**（`TriMesh` + `surfaceprop`），前端可复用同一套
    /// `TriangleGrid` + `clipBoxToTriangle` 消费。
    ///
    /// 限制（首版）：
    /// - 仅支持 `modelType == 0`（IVPCompactSurface 凸包）；MOPP/Ball/Virtual 报错跳过；
    /// - 仅支持 `bone_index == 0` 的凸体（静态模型；带骨骼的动态模型顶点相对骨骼，
    ///   需要骨骼变换矩阵，暂跳过）；
    /// - 顶点米制 → HU（×39.3701），再经 `map_coords`（Z-up→Y-up）+ `place_point` 搬世界空间。
    ///
    /// 输出 JSON：`[{ "name", "surfaceprop", "vertices": [[x,y,z]...], "indices": [[a,b,c]...],
    /// "min": [...], "max": [...] }]`（每个放置实例一个条目）。
    pub fn export_model_phy_colliders(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;

        let (models, static_props, _entry_names) = collect_pakfile_models(bsp)?;
        if models.is_empty() {
            return Ok("[]".to_string());
        }

        let no_entities: Vec<model_integrator::Entity> = Vec::new();

        #[derive(serde::Serialize)]
        struct TriMeshOut {
            name: String,
            surfaceprop: String,
            vertices: Vec<[f32; 3]>,
            indices: Vec<[u32; 3]>,
            min: [f32; 3],
            max: [f32; 3],
        }

        const MAX_TRI_TOTAL: usize = 200_000;
        let mut out: Vec<TriMeshOut> = Vec::new();
        let mut tri_total = 0usize;

        for m in &models {
            if tri_total >= MAX_TRI_TOTAL {
                break;
            }
            // 只解析被引用的模型（static_props 匹配）；无 .phy 或解析失败 → 跳过（前端 auto 回退）
            let placements =
                model_integrator::resolve_placements(&m.name, &no_entities, &static_props);
            let placements: Vec<_> = placements
                .into_iter()
                .filter(|p| p.solid != Some(0))
                .collect();
            if placements.is_empty() {
                continue;
            }
            let phy_name = m.name.replace(".mdl", ".phy");
            let Ok(Some(phy_bytes)) = bsp.pack.get(&phy_name) else {
                continue;
            };
            let solids = match phyfile::parse_phy(&phy_bytes) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("⚠️ 跳过 PHY 解析失败 {}: {e}", m.name);
                    continue;
                }
            };
            if solids.is_empty() {
                continue;
            }
            // 加载模型（供 apply_root_transform 使用，与显示端同一根变换）
            let Some(model) = load_vmdl(m) else {
                continue;
            };

            // 收集该模型全部 bone==0 凸体的三角形（局部空间，HU，Z-up）
            let mut local: Vec<[f32; 3]> = Vec::new();
            let mut tris: Vec<[u32; 3]> = Vec::new();
            let mut sprop = String::new();
            for s in &solids {
                if s.surfaceprop.is_some() && sprop.is_empty() {
                    sprop = s.surfaceprop.clone().unwrap_or_default();
                }
                for c in &s.convexes {
                    if c.bone_index != 0 {
                        continue; // 动态骨骼：跳过
                    }
                    let base = local.len() as u32;
                    for v in &c.vertices {
                        // 关键：PHY 顶点存的是 **IVP 坐标系**（vphysics 内部，Y-up 左手系），
                        // Source 是 Z-up 右手系 —— 转换 = **绕 x 轴 90°：source = (x, z, -y)**
                        // （det=+1 纯旋转；仅 y↔z 交换是 det=-1 镜像，会上下颠倒）。
                        // 实测 79/87 模型尺寸映射 + 符号验证（probe_phy_mapping/orientation）。
                        let ivp2src = [v[0], v[2], -v[1]];
                        // 再施加与显示端相同的根骨骼变换（非 STATIC_PROP 时骨骼 0 带旋转）
                        let rt = model.apply_root_transform(vmdl::Vector {
                            x: ivp2src[0],
                            y: ivp2src[1],
                            z: ivp2src[2],
                        });
                        local.push(model_integrator::map_coords([rt.x, rt.y, rt.z]));
                    }
                    for t in &c.indices {
                        tris.push([base + t[0], base + t[1], base + t[2]]);
                    }
                }
            }
            if local.is_empty() || tris.is_empty() {
                continue;
            }

            for p in &placements {
                if tri_total >= MAX_TRI_TOTAL {
                    break;
                }
                let mut verts: Vec<[f32; 3]> = Vec::with_capacity(local.len());
                for v in &local {
                    verts.push(pakfile_models::place_point(
                        *v, p.translation, p.rotation, p.scale,
                    ));
                }
                let mut min = [f32::INFINITY; 3];
                let mut max = [f32::NEG_INFINITY; 3];
                for v in &verts {
                    for i in 0..3 {
                        if v[i] < min[i] {
                            min[i] = v[i];
                        }
                        if v[i] > max[i] {
                            max[i] = v[i];
                        }
                    }
                }
                if !min.iter().all(|f| f.is_finite()) {
                    continue;
                }
                tri_total += tris.len();
                out.push(TriMeshOut {
                    name: m.name.clone(),
                    surfaceprop: sprop.clone(),
                    vertices: verts,
                    indices: tris.clone(),
                    min,
                    max,
                });
            }
        }

        serde_json::to_string(&out).map_err(|e| to_js_err(e, "序列化模型 PHY 碰撞失败"))
    }

    /// 检查 BSP 是否仍持有（未被 export_glb 消费）。
    pub fn is_alive(&self) -> bool {
        self.bsp.is_some()
    }

    /// 生成纹理画质 manifest：`{ 纹理名(小写 VMT 路径): mosaic v4 字节码 }` JSON。
    ///
    /// 前端画质切换（原始/压缩低清）用：GLB 导出后调用一次（export_glb* 消费 BSP 之前），
    /// 切换画质时用 `mosaic_decode` 还原低清 PNG 替换贴图，无需重载地图。
    ///
    /// 覆盖两类纹理（与 GLB texture.name 对应）：
    /// 1. 地图 face 纹理（key = basetexture 小写，如 "materials/xxx"）
    /// 2. PAKFILE 模型贴图（key = 材质名小写，如 "maplebark"——修复 prop 墙面未压缩）
    pub fn export_mosaic_manifest(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 已被消费或未加载"))?;
        let mut pairs = websurf_wasm_core::mosaic::manifest::build_mosaic_manifest(bsp);
        // 模型贴图（材质名 → PNG → mosaic）；失败静默跳过（不影响地图纹理覆盖）
        if let Ok((models, _props, entry_names)) = collect_pakfile_models(bsp) {
            let index = pakfile_models::PakIndex::build(&entry_names);
            let materials = resolve_pakfile_materials(bsp, &models, &index, true);
            for (name, png) in materials.textures {
                if let Ok(code) = websurf_wasm_core::mosaic::encode::img_to_code(&png, &name) {
                    pairs.push((name.to_ascii_lowercase(), code));
                }
            }
        }
        let map: std::collections::HashMap<String, String> = pairs.into_iter().collect();
        serde_json::to_string(&map).map_err(|e| to_js_err(e, "序列化 mosaic manifest 失败"))
    }

    /// 导出缺失材质纹理列表（VMT/VTF 缺失或解码失败 → 占位色）JSON 字符串数组。
    ///
    /// 前端加载后与默认配置纹理包（textures.mtz 解压的键集合）比对，
    /// 列出默认包也无法覆盖的缺失纹理并等待用户确认。
    pub fn export_missing_textures(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 已被消费或未加载"))?;
        let missing = websurf_wasm_core::mosaic::manifest::collect_missing_textures(bsp);
        serde_json::to_string(&missing).map_err(|e| to_js_err(e, "序列化缺失纹理列表失败"))
    }

    /// 提取出生点实体（info_player_start / info_player_terrorist / info_player_counterterrorist 等）。
    ///
    /// 返回 JSON：`{ "spawn_points": [{ classname, origin: [x,y,z], angles: [p,y,r],
    /// origin_raw, angles_raw }], "total": N, "primary": 0 }`。
    /// `primary` 为推荐出生点索引（优先 info_player_start）。
    ///
    /// **坐标转换**：BSP Z-up → Three.js Y-up（`[x,y,z]→[y,z,x]`，det=+1）。
    /// `origin` 已旋转为 Y-up；`angles` 保持 BSP 原始 `[pitch, yaw, roll]`，前端按需转换。
    pub fn parse_spawn_points(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        #[derive(serde::Serialize)]
        struct SpawnPoint {
            classname: String,
            origin: [f32; 3],
            angles: [f32; 3],
            origin_raw: String,
            angles_raw: Option<String>,
        }

        #[derive(serde::Serialize)]
        struct SpawnReport {
            spawn_points: Vec<SpawnPoint>,
            total: usize,
            primary: Option<usize>,
        }

        fn parse_vec3(s: &str) -> Option<[f32; 3]> {
            let parts: Vec<&str> = s.split_whitespace().collect();
            if parts.len() < 3 {
                return None;
            }
            Some([
                parts[0].parse::<f32>().ok()?,
                parts[1].parse::<f32>().ok()?,
                parts[2].parse::<f32>().ok()?,
            ])
        }

        // 坐标旋转 [x,y,z]→[y,z,x]（det=+1，正交变换，BSP Z-up → Three.js Y-up）
        fn rotate_yup(v: [f32; 3]) -> [f32; 3] {
            [v[1], v[2], v[0]]
        }

        // 出生点 classname 列表（按优先级排序）
        const SPAWN_CLASSNAMES: &[&str] = &[
            "info_player_start",         // HL2 / CS:S 主出生点
            "info_player_terrorist",      // CS T 出生点
            "info_player_counterterrorist", // CS CT 出生点
            "info_player_deathmatch",     // CS DM 出生点
            "info_player_teamspawn",      // CS 团队出生点
            "info_player_axis",           // DOD 轴心出生点
            "info_player_allied",         // DOD 同盟出生点
            "info_player_coop",           // HL Coop 出生点
            "info_teleport_destination",  // 传送目标点（作为备用）
        ];

        let mut spawn_points: Vec<SpawnPoint> = Vec::new();
        let mut primary: Option<usize> = None;

        for ent in bsp.entities.iter() {
            let Ok(classname) = ent.prop("classname") else {
                continue;
            };

            let is_spawn = SPAWN_CLASSNAMES.iter().any(|sc| classname == *sc);
            // 也匹配 info_player_* 通配
            let is_player_spawn = is_spawn || classname.starts_with("info_player_");

            if !is_player_spawn {
                continue;
            }

            let origin_raw = ent.prop("origin").unwrap_or("").to_string();
            let Some(origin) = parse_vec3(&origin_raw) else {
                continue;
            };
            let angles_raw = ent.prop("angles").ok().map(|s| s.to_string());
            let angles = angles_raw
                .as_ref()
                .and_then(|s| parse_vec3(s))
                .unwrap_or([0.0, 0.0, 0.0]);

            // 如果是 info_player_start，设为 primary
            if primary.is_none() && classname == "info_player_start" {
                primary = Some(spawn_points.len());
            }

            spawn_points.push(SpawnPoint {
                classname: classname.to_string(),
                origin: rotate_yup(origin),
                angles,
                origin_raw,
                angles_raw,
            });
        }

        // 如果没有 info_player_start，用第一个出生点
        if primary.is_none() && !spawn_points.is_empty() {
            primary = Some(0);
        }

        let report = SpawnReport {
            total: spawn_points.len(),
            spawn_points,
            primary,
        };

        serde_json::to_string(&report).map_err(|e| to_js_err(e, "序列化出生点数据失败"))
    }

    /// 解析 BSP 中所有实体（含属性和 outputs），用于调试 I/O 连接逻辑
    /// （trigger_multiple / logic_relay / filter_* 等）。
    ///
    /// 输出 JSON 数组，每实体含：
    /// - `classname`: 实体类型
    /// - `targetname`: 实体名称（I/O 连接用）
    /// - `props`: 所有键值属性（spawnflags, StartDisabled, target, model 等）
    /// - `outputs`: 所有 outputs（OnStartTouch, OnTouch, OnTrigger 等）
    /// - `origin`: 原始 origin 字符串
    /// - `model`: 模型字符串（如 "*3"）
    pub fn parse_entities(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        #[derive(serde::Serialize)]
        struct EntityOut {
            index: usize,
            classname: String,
            targetname: String,
            props: std::collections::BTreeMap<String, String>,
            outputs: Vec<String>,
            origin_raw: String,
            model_raw: Option<String>,
        }

        let mut result: Vec<EntityOut> = Vec::new();
        for (i, ent) in bsp.entities.iter().enumerate() {
            let classname = ent
                .prop("classname")
                .map(|s| s.to_string())
                .unwrap_or_default();
            let targetname = ent
                .prop("targetname")
                .map(|s| s.to_string())
                .unwrap_or_default();
            let origin_raw = ent
                .prop("origin")
                .map(|s| s.to_string())
                .unwrap_or_default();
            let model_raw = ent.prop("model").ok().map(|s| s.to_string());

            // 收集所有属性（区分 outputs 和普通属性）
            let mut props = std::collections::BTreeMap::new();
            let mut outputs = Vec::new();
            for (key, val) in ent.properties() {
                // Source BSP outputs 以 On 开头（如 OnStartTouch, OnTrigger）
                if key.starts_with("On") || key.starts_with("on") {
                    outputs.push(format!("{} {}", key, val));
                } else {
                    props.insert(key.to_string(), val.to_string());
                }
            }

            result.push(EntityOut {
                index: i,
                classname,
                targetname,
                props,
                outputs,
                origin_raw,
                model_raw,
            });
        }

        serde_json::to_string(&result).map_err(|e| JsValue::from_str(&format!("序列化失败: {e}")))
    }

    /// 列出 pakfile 中所有打包文件名（不含内容）。
    ///
    /// 用于快速检查 BSP 是否打包了 Lua/cfg/脚本等可能控制触发逻辑的资源。
    /// 返回 JSON：`{ "files": ["path1", ...], "total": N }`
    pub fn list_pakfile(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        #[derive(serde::Serialize)]
        struct PakfileList {
            files: Vec<String>,
            total: usize,
        }

        let zip = bsp.pack.clone().into_zip();
        let mut zip_guard = zip.lock().map_err(|e| {
            JsValue::from_str(&format!("pakfile 锁定失败: {e}"))
        })?;

        let mut files: Vec<String> = Vec::new();
        for i in 0..zip_guard.len() {
            if let Ok(entry) = zip_guard.by_index(i) {
                files.push(entry.name().to_string());
            }
        }

        let total = files.len();
        serde_json::to_string(&PakfileList { files, total })
            .map_err(|e| to_js_err(e, "序列化 pakfile 列表失败"))
    }

    /// 读取 pakfile 中指定路径的文件内容（字节）。
    ///
    /// 用于提取 Lua/cfg/文本脚本；找不到时返回空 Vec（不报错）。
    ///
    /// @param name pakfile 内的相对路径（如 `scripts/map/surf_nsz_fix.lua`）
    /// @returns 文件内容字节；找不到返回空数组
    pub fn read_pakfile_file(&self, name: &str) -> Result<Vec<u8>, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        match bsp.pack.get(name) {
            Ok(Some(data)) => Ok(data),
            Ok(None) => Ok(Vec::new()),
            Err(e) => Err(to_js_err(e, "读取 pakfile 文件失败")),
        }
    }

    /// 读取 pakfile 中所有文本类脚本（lua/cfg/txt/vmt/vdf）。
    ///
    /// 跳过二进制资源（vtf/vpk/bsp/sound）防内存爆炸；单文件上限 256KB。
    ///
    /// 返回 JSON：`{ "files": [{ "name": "path", "size": N, "content": "..." }], "total": N }`
    pub fn read_pakfile_scripts(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        #[derive(serde::Serialize)]
        struct ScriptFile {
            name: String,
            size: usize,
            content: String,
        }

        #[derive(serde::Serialize)]
        struct ScriptReport {
            files: Vec<ScriptFile>,
            total: usize,
        }

        // 允许的文本类扩展名（小写）
        const TEXT_EXTS: &[&str] = &[
            "lua", "cfg", "txt", "vmt", "vdf", "kv", "kv3", "res",
            "nut", "sma", "sp", "inc", "json", "xml", "ini",
        ];
        const MAX_FILE_SIZE: usize = 256 * 1024; // 256KB

        let zip = bsp.pack.clone().into_zip();
        let mut zip_guard = zip.lock().map_err(|e| {
            JsValue::from_str(&format!("pakfile 锁定失败: {e}"))
        })?;

        let mut files: Vec<ScriptFile> = Vec::new();
        for i in 0..zip_guard.len() {
            let Ok(mut entry) = zip_guard.by_index(i) else {
                continue;
            };
            let name = entry.name().to_string();
            // 过滤扩展名
            let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
            if !TEXT_EXTS.contains(&ext.as_str()) {
                continue;
            }
            // 大小保护
            let size = entry.size() as usize;
            if size > MAX_FILE_SIZE {
                continue;
            }
            // 读取内容
            let mut buf = Vec::with_capacity(size);
            use std::io::Read;
            if entry.read_to_end(&mut buf).is_err() {
                continue;
            }
            // 转 String（非 UTF-8 用 lossy 转换）
            let content = String::from_utf8_lossy(&buf).into_owned();
            files.push(ScriptFile {
                name,
                size: buf.len(),
                content,
            });
        }

        let total = files.len();
        serde_json::to_string(&ScriptReport { files, total })
            .map_err(|e| to_js_err(e, "序列化 pakfile 脚本失败"))
    }

    /// 解析传送触发器与目的地（trigger_teleport + info_teleport_destination）。
    ///
    /// 返回 JSON：`{ "triggers": [{ index, target, classname, origin,
    /// model_mins, model_maxs }], "links": [{ trigger_idx, dest_idx }] }`。
    ///
    /// **坐标转换**：BSP Z-up → Three.js Y-up（`[x,y,z]→[y,z,x]`，det=+1）。
    /// `origin` 已旋转为 Y-up；`angles` 保持 BSP 原始 `[pitch, yaw, roll]`。
    pub fn parse_teleports(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        #[derive(serde::Serialize)]
        struct TeleportDest {
            index: usize,
            targetname: String,
            origin: [f32; 3],
            angles: [f32; 3],
            origin_raw: String,
            angles_raw: Option<String>,
        }

        #[derive(serde::Serialize)]
        struct TeleportTrigger {
            index: usize,
            classname: String,
            target: String,
            origin: [f32; 3],
            model: Option<String>,
            /// model brush AABB min（Y-up）。None = 无 model 或解析失败。
            model_mins: Option<[f32; 3]>,
            /// model brush AABB max（Y-up）。None = 无 model 或解析失败。
            model_maxs: Option<[f32; 3]>,
            /// 触发区域凸包平面（世界坐标 Y-up，[nx,ny,nz,dist] 朝外）。
            /// 楔形/斜面触发区不能用 AABB 代替（斜坡 case）。
            model_planes: Option<Vec<[f32; 4]>>,
            /// spawnflags（bitfield）：1=Clients, 2=NPCs, 8=PhysicsObjects, 16=Only players, 64=Everything。
            spawnflags: u32,
            /// StartDisabled（0=启用, 1=禁用）；disabled 不应触发传送。
            start_disabled: bool,
            origin_raw: String,
            model_raw: Option<String>,
        }

        #[derive(serde::Serialize)]
        struct TeleportLink {
            trigger_idx: usize,
            dest_idx: usize,
        }

        #[derive(serde::Serialize)]
        struct TeleportReport {
            teleports: Vec<TeleportDest>,
            triggers: Vec<TeleportTrigger>,
            links: Vec<TeleportLink>,
            total_triggers: usize,
            total_dests: usize,
            total_links: usize,
            orphan_triggers: usize,
            orphan_dests: usize,
        }

        fn parse_vec3(s: &str) -> Option<[f32; 3]> {
            let parts: Vec<&str> = s.split_whitespace().collect();
            if parts.len() < 3 {
                return None;
            }
            let x = parts[0].parse::<f32>().ok()?;
            let y = parts[1].parse::<f32>().ok()?;
            let z = parts[2].parse::<f32>().ok()?;
            Some([x, y, z])
        }

        // 坐标旋转 [x,y,z]→[y,z,x]（det=+1，正交变换，BSP Z-up → Three.js Y-up）
        fn rotate_yup(v: [f32; 3]) -> [f32; 3] {
            [v[1], v[2], v[0]]
        }

        // 三平面求交（克莱默法则），退化返回 None
        fn tri_intersect(
            p1: &vbsp::Plane,
            p2: &vbsp::Plane,
            p3: &vbsp::Plane,
        ) -> Option<[f32; 3]> {
            let n1 = &p1.normal;
            let n2 = &p2.normal;
            let n3 = &p3.normal;
            let c23 = [
                n2.y * n3.z - n2.z * n3.y,
                n2.z * n3.x - n2.x * n3.z,
                n2.x * n3.y - n2.y * n3.x,
            ];
            let det = n1.x * c23[0] + n1.y * c23[1] + n1.z * c23[2];
            if det.abs() < 1e-6 {
                return None;
            }
            let c31 = [
                n3.y * n1.z - n3.z * n1.y,
                n3.z * n1.x - n3.x * n1.z,
                n3.x * n1.y - n3.y * n1.x,
            ];
            let c12 = [
                n1.y * n2.z - n1.z * n2.y,
                n1.z * n2.x - n1.x * n2.z,
                n1.x * n2.y - n1.y * n2.x,
            ];
            let inv = 1.0 / det;
            Some([
                (c23[0] * p1.dist + c31[0] * p2.dist + c12[0] * p3.dist) * inv,
                (c23[1] * p1.dist + c31[1] * p2.dist + c12[1] * p3.dist) * inv,
                (c23[2] * p1.dist + c31[2] * p2.dist + c12[2] * p3.dist) * inv,
            ])
        }

        /// 遍历 model.head_node 收集其全部 brush 的局部 AABB + 凸包平面（BSP Z-up 坐标）。
        ///
        /// **关键修复**：Hammer 可将多个分散 brush 绑定到同一实体（"Tie to entity"），
        /// 此时 `model.mins/maxs` 只是**总包围盒**，若直接当触发区会把盒内所有区域都变成触发区
        /// （test.bsp trigger_teleport *6 的实证）。正确做法：遍历 BSP 树，为每个 brush 单独算局部 AABB，各生成一个触发区域。
        ///
        /// 返回 (局部 AABB min, 局部 AABB max, 局部凸包平面 [nx,ny,nz,dist])；
        /// 凸包平面供 TS 端精确判定（楔形/斜面触发区不是 AABB）。
        fn model_brush_aabbs(
            bsp: &vbsp::Bsp,
            model_idx: usize,
        ) -> Vec<([f32; 3], [f32; 3], Vec<[f32; 4]>)> {
            let Some(model) = bsp.models.get(model_idx) else {
                return Vec::new();
            };
            // 1. 遍历 head_node 收集 brush 索引（跨 leaf 去重）
            let mut stack: Vec<i32> = vec![model.head_node];
            let mut brush_set: std::collections::HashSet<usize> = std::collections::HashSet::new();
            while let Some(ni) = stack.pop() {
                if ni < 0 {
                    let li = (!ni) as usize;
                    let Some(leaf) = bsp.leaves.get(li) else {
                        continue;
                    };
                    let start = leaf.first_leaf_brush as usize;
                    let count = leaf.leaf_brush_count as usize;
                    for k in start..(start + count).min(bsp.leaf_brushes.len()) {
                        if let Some(lb) = bsp.leaf_brushes.get(k) {
                            brush_set.insert(lb.brush as usize);
                        }
                    }
                } else if let Some(node) = bsp.nodes.get(ni as usize) {
                    stack.push(node.children[0] as i32);
                    stack.push(node.children[1] as i32);
                }
            }
            // 2. 每个 brush：planes → 凸包顶点 → 局部 AABB（与 compute_vertices 同算法）
            let mut out: Vec<([f32; 3], [f32; 3], Vec<[f32; 4]>)> = Vec::new();
            for bi in brush_set {
                let Some(brush) = bsp.brushes.get(bi) else {
                    continue;
                };
                let start = brush.brush_side as usize;
                let count = brush.num_brush_sides as usize;
                let mut ps: Vec<&vbsp::Plane> = Vec::new();
                for s in start..(start + count).min(bsp.brush_sides.len()) {
                    if let Some(side) = bsp.brush_sides.get(s) {
                        if let Some(pl) = bsp.planes.get(side.plane as usize) {
                            ps.push(pl);
                        }
                    }
                }
                if ps.len() < 4 {
                    continue;
                }
                let mut verts: Vec<[f32; 3]> = Vec::new();
                for i in 0..ps.len() {
                    for j in (i + 1)..ps.len() {
                        for k in (j + 1)..ps.len() {
                            let Some(v) = tri_intersect(ps[i], ps[j], ps[k]) else {
                                continue;
                            };
                            let mut valid = true;
                            for p in &ps {
                                let d = p.normal.x * v[0] + p.normal.y * v[1] + p.normal.z * v[2] - p.dist;
                                // BSP 平面朝外约定（内部 dot(n,p)-dist <= 0），排除在外点
                                if d > 1.0 {
                                    valid = false;
                                    break;
                                }
                            }
                            if !valid {
                                continue;
                            }
                            let mut dup = false;
                            for ev in &verts {
                                let dx = ev[0] - v[0];
                                let dy = ev[1] - v[1];
                                let dz = ev[2] - v[2];
                                if dx * dx + dy * dy + dz * dz < 0.01 {
                                    dup = true;
                                    break;
                                }
                            }
                            if !dup {
                                verts.push(v);
                            }
                        }
                    }
                }
                if verts.len() < 4 {
                    continue;
                }
                let mut mn = [f32::INFINITY; 3];
                let mut mx = [f32::NEG_INFINITY; 3];
                for v in &verts {
                    for a in 0..3 {
                        mn[a] = mn[a].min(v[a]);
                        mx[a] = mx[a].max(v[a]);
                    }
                }
                // 局部凸包平面（朝外约定 [nx,ny,nz,dist]，BSP Z-up）
                let plane_arr: Vec<[f32; 4]> = ps
                    .iter()
                    .map(|p| [p.normal.x, p.normal.y, p.normal.z, p.dist])
                    .collect();
                out.push((mn, mx, plane_arr));
            }
            out
        }

        let mut teleports: Vec<TeleportDest> = Vec::new();
        let mut triggers: Vec<TeleportTrigger> = Vec::new();

        for (idx, ent) in bsp.entities.iter().enumerate() {
            let Ok(classname) = ent.prop("classname") else {
                continue;
            };
            // 严格过滤：只有 info_teleport_destination* 是传送目标点。
            // info_target / info_player_teleport 等不是传送目标。
            if classname == "info_teleport_destination"
                || classname.starts_with("info_teleport_destination_")
            {
                let Ok(targetname) = ent.prop("targetname") else {
                    continue;
                };
                let targetname = targetname.to_string();
                let origin_raw = ent.prop("origin").unwrap_or("").to_string();
                let origin = parse_vec3(&origin_raw).unwrap_or([0.0, 0.0, 0.0]);
                let angles_raw = ent.prop("angles").ok().map(|s| s.to_string());
                let angles = angles_raw
                    .as_ref()
                    .and_then(|s| parse_vec3(s))
                    .unwrap_or([0.0, 0.0, 0.0]);
                teleports.push(TeleportDest {
                    index: idx,
                    targetname,
                    origin: rotate_yup(origin),
                    angles,
                    origin_raw,
                    angles_raw,
                });
            }
            // 严格过滤：trigger_multiple 是通用触发器，不算传送触发器（否则误传送）；
            // 仅 trigger_teleport / _random / _relative 是传送触发器。
            if classname == "trigger_teleport"
                || classname == "trigger_teleport_random"
                || classname == "trigger_teleport_relative"
            {
                let Ok(target) = ent.prop("target") else {
                    continue;
                };
                let target = target.to_string();
                let origin_raw = ent.prop("origin").unwrap_or("").to_string();
                let origin = parse_vec3(&origin_raw).unwrap_or([0.0, 0.0, 0.0]);
                let model_raw = ent.prop("model").ok().map(|s| s.to_string());
                let model = model_raw.clone();

                // spawnflags 默认 1 = Clients；不含 Clients bit 时对玩家不生效，TS 端会跳过
                let spawnflags = ent
                    .prop("spawnflags")
                    .ok()
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(1);

                // StartDisabled 默认 false=启用；disabled 不应触发传送，TS 端会跳过
                let start_disabled = ent
                    .prop("StartDisabled")
                    .map(|s| s == "1")
                    .unwrap_or(false);

                // model 格式 "*N" 指向 bsp.models[N]，几何为局部坐标（相对实体 origin）。
                //
                // 【关键修复】trigger 可绑定多个分散 brush（Hammer "Tie to entity"），
                // model.mins/maxs 只是**总包围盒**——直接用会把盒内所有区域变触发区。
                // 改为遍历 BSP 树，按每个 brush 局部 AABB 生成独立触发区域。
                let origin_yup = rotate_yup(origin);

                // 每个 brush 一个区域（局部 AABB + 凸包平面，BSP Z-up）
                let regions: Vec<([f32; 3], [f32; 3], Vec<[f32; 4]>)> = match model.as_deref() {
                    Some(m) if m.starts_with('*') => m[1..]
                        .parse::<usize>()
                        .ok()
                        .map(|i| model_brush_aabbs(bsp, i))
                        .unwrap_or_default(),
                    _ => Vec::new(),
                };
                // 世界 AABB + 世界凸包平面（局部 + 实体 origin 平移，旋转为 Y-up）
                let world_regions: Vec<([f32; 3], [f32; 3], Vec<[f32; 4]>)> =
                    if !regions.is_empty() {
                        regions
                            .iter()
                            .map(|(mn, mx, ps)| {
                                let mn_local = rotate_yup(*mn);
                                let mx_local = rotate_yup(*mx);
                                // 世界凸包平面：n_world = rotate_yup(n)，d_world = d + n·origin
                                let planes_world: Vec<[f32; 4]> = ps
                                    .iter()
                                    .map(|p| {
                                        let n = rotate_yup([p[0], p[1], p[2]]);
                                        let d = p[3]
                                            + p[0] * origin[0]
                                            + p[1] * origin[1]
                                            + p[2] * origin[2];
                                        [n[0], n[1], n[2], d]
                                    })
                                    .collect();
                                (
                                    [
                                        origin_yup[0] + mn_local[0],
                                        origin_yup[1] + mn_local[1],
                                        origin_yup[2] + mn_local[2],
                                    ],
                                    [
                                        origin_yup[0] + mx_local[0],
                                        origin_yup[1] + mx_local[1],
                                        origin_yup[2] + mx_local[2],
                                    ],
                                    planes_world,
                                )
                            })
                            .collect()
                    } else {
                        // 回退：model 下无 brush（虚拟实体/解析失败）→ 用 model 总包围盒
                        match model.as_deref() {
                            Some(m) if m.starts_with('*') => m[1..]
                                .parse::<usize>()
                                .ok()
                                .and_then(|i| bsp.models.get(i))
                                .map(|md| {
                                    let mins_local =
                                        rotate_yup([md.mins.x, md.mins.y, md.mins.z]);
                                    let maxs_local =
                                        rotate_yup([md.maxs.x, md.maxs.y, md.maxs.z]);
                                    // 回退路径无凸包平面（AABB 判定）
                                    vec![(
                                        [
                                            origin_yup[0] + mins_local[0],
                                            origin_yup[1] + mins_local[1],
                                            origin_yup[2] + mins_local[2],
                                        ],
                                        [
                                            origin_yup[0] + maxs_local[0],
                                            origin_yup[1] + maxs_local[1],
                                            origin_yup[2] + maxs_local[2],
                                        ],
                                        Vec::new(),
                                    )]
                                })
                                .unwrap_or_default(),
                            _ => Vec::new(),
                        }
                    };

                if world_regions.is_empty() {
                    // 无区域信息：推入无 AABB 的 trigger（TS 端回退球形检测）
                    triggers.push(TeleportTrigger {
                        index: idx,
                        classname: classname.to_string(),
                        target,
                        origin: rotate_yup(origin),
                        model,
                        model_mins: None,
                        model_maxs: None,
                        model_planes: None,
                        spawnflags,
                        start_disabled,
                        origin_raw,
                        model_raw,
                    });
                } else {
                    // 每个 brush 区域生成一个 trigger 条目（共享 target/origin/标志位）
                    for (mm, mx, planes) in world_regions {
                        triggers.push(TeleportTrigger {
                            index: idx,
                            classname: classname.to_string(),
                            target: target.clone(),
                            origin: rotate_yup(origin),
                            model: model.clone(),
                            model_mins: Some(mm),
                            model_maxs: Some(mx),
                            model_planes: if planes.is_empty() {
                                None
                            } else {
                                Some(planes)
                            },
                            spawnflags,
                            start_disabled,
                            origin_raw: origin_raw.clone(),
                            model_raw: model_raw.clone(),
                        });
                    }
                }
            }
        }

        // 构建链接：trigger.target ↔ dest.targetname
        let mut links: Vec<TeleportLink> = Vec::new();
        let mut linked_dests = std::collections::HashSet::new();
        let mut linked_triggers = std::collections::HashSet::new();

        for (t_idx, trigger) in triggers.iter().enumerate() {
            for (d_idx, dest) in teleports.iter().enumerate() {
                if dest.targetname == trigger.target {
                    links.push(TeleportLink {
                        trigger_idx: t_idx,
                        dest_idx: d_idx,
                    });
                    linked_triggers.insert(t_idx);
                    linked_dests.insert(d_idx);
                }
            }
        }

        let report = TeleportReport {
            total_triggers: triggers.len(),
            total_dests: teleports.len(),
            total_links: links.len(),
            orphan_triggers: triggers.len() - linked_triggers.len(),
            orphan_dests: teleports.len() - linked_dests.len(),
            teleports,
            triggers,
            links,
        };

        serde_json::to_string(&report).map_err(|e| to_js_err(e, "序列化传送门数据失败"))
    }

    /// 导出 BSP PVS（Potentially Visible Set）数据用于遮挡检测。
    ///
    /// 利用编译期预计算的 PVS 位图，Worker 端可 O(1) 查表遮挡剔除：
    /// 找相机所在 leaf → 取其 cluster → 查 PVS 表 → 仅渲染可见 cluster 的 mesh。
    ///
    /// 返回 JSON：`{ root_node, nodes: [{normal, dist, children}],
    /// leaves: [{cluster, mins, maxs, is_solid}], face_clusters: [...], pvs_bits_base64,
    /// cluster_count, bytes_per_row }`。
    ///
    /// **坐标转换**：BSP Z-up → Three.js Y-up（`[x,y,z]→[y,z,x]`，det=+1，
    /// 与 `export_brushes_planes` 一致）。plane normal 旋转，dist 不变；leaf mins/maxs 同样旋转。
    ///
    /// **face_cluster**：face_index → 主 cluster（-1 = 无 cluster/固体）；多 leaf 时取第一个非固体 cluster。
    ///
    /// **pvs_bits_base64**：预解码 PVS 位图，每行 cluster_count 位。
    /// `pvs_bits[cluster * bytes_per_row + (target_cluster / 8)]` 的第 `(target_cluster % 8)` 位为 1
    /// 表示从 `cluster` 可见 `target_cluster`。
    pub fn parse_pvs_data(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        use vbsp::{Leaf, Node, Plane};

        // ---- 可序列化结构 ----
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct PvsNode {
            normal: [f32; 3],
            dist: f32,
            children: [i32; 2],
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct PvsLeaf {
            cluster: i16,
            mins: [i16; 3],
            maxs: [i16; 3],
            is_solid: bool,
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct PvsData {
            root_node: u32,
            nodes: Vec<PvsNode>,
            leaves: Vec<PvsLeaf>,
            face_clusters: Vec<i32>,
            pvs_bits_base64: String,
            cluster_count: u32,
            bytes_per_row: usize,
        }

        // 坐标旋转 [x,y,z]→[y,z,x]（BSP Z-up → Three.js Y-up），与其他导出函数保持一致
        fn rotate_yup_f32(v: &vbsp::Vector) -> [f32; 3] {
            [v.y, v.z, v.x]
        }
        fn rotate_yup_i16(v: [i16; 3]) -> [i16; 3] {
            [v[1], v[2], v[0]]
        }

        // ---- 1. 导出 nodes（BSP 树节点）----
        let nodes: Vec<PvsNode> = bsp
            .nodes
            .iter()
            .map(|node: &Node| {
                // 边界检查：plane_index 可能越界（损坏的 BSP 文件）
                let plane_idx = node.plane_index as usize;
                let default_plane = Plane { normal: vbsp::Vector { x: 0.0, y: 0.0, z: 1.0 }, dist: 0.0, ty: 0 };
                let plane = bsp.planes.get(plane_idx).unwrap_or(&default_plane);
                PvsNode {
                    normal: rotate_yup_f32(&plane.normal),
                    dist: plane.dist,
                    children: node.children,
                }
            })
            .collect();

        // ---- 2. 导出 leaves（cluster + 包围盒 + is_solid）----
        // leaves 保持原始 BSP 顺序（vbsp 解析模块已修复排序 bug）；
        // node.children 负数 → !index → 原始 leaf 索引
        let leaves: Vec<PvsLeaf> = bsp
            .leaves
            .iter()
            .map(|leaf: &Leaf| PvsLeaf {
                cluster: leaf.cluster,
                mins: rotate_yup_i16(leaf.mins),
                maxs: rotate_yup_i16(leaf.maxs),
                is_solid: leaf.cluster < 0,
            })
            .collect();

        // ---- 3. 建立 face → cluster 映射（取第一个非固体 cluster）----
        let mut face_clusters = vec![-1i32; bsp.faces.len()];
        for leaf in bsp.leaves.iter() {
            if leaf.cluster < 0 {
                continue; // 跳过固体 leaf（cluster == -1）
            }
            let start = leaf.first_leaf_face as usize;
            let count = leaf.leaf_face_count as usize;
            if start + count > bsp.leaf_faces.len() {
                continue; // 防止越界
            }
            for fi in start..(start + count) {
                let face_idx = bsp.leaf_faces[fi].face as usize;
                if face_idx < face_clusters.len() && face_clusters[face_idx] < 0 {
                    face_clusters[face_idx] = leaf.cluster as i32;
                }
            }
        }

        // ---- 4. 预解码 PVS 位图 ----
        // 直接解码 RLE 压缩的 PVS 数据；不用 visible_clusters()（无边界检查，越界 panic 会破坏 wasm-bindgen 状态）
        let cluster_count = bsp.vis_data.cluster_count;
        let bytes_per_row = ((cluster_count as usize) + 7) / 8;
        let mut pvs_bits = vec![0u8; (cluster_count as usize) * bytes_per_row];

        // 仅在有 PVS 数据时解码
        if cluster_count > 0 && !bsp.vis_data.pvs_offsets.is_empty() {
            let vis_data = &bsp.vis_data.data;
            let pvs_offsets = &bsp.vis_data.pvs_offsets;
            for c in 0..cluster_count {
                let c_usize = c as usize;
                if c_usize >= pvs_offsets.len() {
                    break;
                }
                let offset = pvs_offsets[c_usize] as usize;
                // 边界检查：offset 必须在 vis_data 范围内
                if offset >= vis_data.len() {
                    continue;
                }
                let row_offset = c_usize * bytes_per_row;
                // RLE 解码（权威实现：vbsp::decode_pvs_row，含 `*8` 修复）
                vbsp::decode_pvs_row(vis_data, offset, cluster_count, bytes_per_row, row_offset, &mut pvs_bits);
            }
        }

        let pvs_bits_base64 = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(&pvs_bits)
        };

        let pvs_data = PvsData {
            root_node: 0,
            nodes,
            leaves,
            face_clusters,
            pvs_bits_base64,
            cluster_count,
            bytes_per_row,
        };

        serde_json::to_string(&pvs_data).map_err(|e| to_js_err(e, "序列化 PVS 数据失败"))
    }

    /// 导出 BSP brush 的凸包碰撞体数据（无过滤，便捷方法）。
    ///
    /// 等价于 `export_colliders_with_filter("{}")`，保留以兼容旧调用方；
    /// 需要过滤 sky/nodraw/ladder/solid/小体积 brush 时用
    /// [`BspProcessor::export_colliders_with_filter`]。
    pub fn export_colliders(&self) -> Result<String, JsValue> {
        self.export_colliders_with_filter("{}")
    }

    /// 导出 BSP brush 的凸包碰撞体数据（带过滤参数）。
    ///
    /// 每个 SOLID/LADDER brush 转换为一个 ConvexPolyhedron（顶点 + 三角面索引），
    /// 参考 webgl-kz 方案：brush 即凸多面体，法线来自真实面，支持斜坡。
    ///
    /// `filter_json` 是 [`ColliderFilter`] 的 JSON，控制导出哪些 brush：
    /// - `include_ladder` / `include_solid`: 是否导出 LADDER / SOLID brush（默认 true）
    /// - `skip_sky`: 是否跳过含 SKY 纹理的 brush（默认 true）；`skip_nodraw`: 是否跳过含 NODRAW 纹理的 brush（默认 false）
    /// - `min_brush_volume`: 跳过 AABB 体积小于此值的 brush（默认 0，不跳过）
    ///
    /// 算法：收集 brush 平面 → 三平面求交得凸包顶点（过滤正侧）→ 按面 fan 三角化 →
    /// 坐标转换 BSP Z-up → Three.js Y-up。
    /// 注意：该转换是 reflection（det=-1）会反转手性，故翻转三角形顶点顺序
    /// `[a,b,c]→[a,c,b]` 保持法线朝外。
    ///
    /// 返回 JSON：`{ "colliders": [{ "points": [...], "indexs": [[a,c,b], ...],
    /// "is_ladder": false, "is_solid": true, "brush_index": 0 }],
    /// "total_brushes": N, "exported": N, "skipped": N }`
    pub fn export_colliders_with_filter(
        &self,
        filter_json: &str,
    ) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        // 解析过滤参数（无效 JSON 或缺失字段用默认值）
        let filter: ColliderFilter =
            serde_json::from_str(filter_json).unwrap_or_default();

        use vbsp::{Brush, BrushFlags, Plane};

        #[derive(serde::Serialize)]
        struct Collider {
            points: Vec<[f32; 3]>,
            indexs: Vec<[u32; 3]>,
            is_ladder: bool,
            is_solid: bool,
            brush_index: usize,
        }
        #[derive(serde::Serialize)]
        struct ColliderReport {
            colliders: Vec<Collider>,
            total_brushes: usize,
            exported: usize,
            skipped: usize,
        }

        // 三平面求交（克莱默法则）：det = n1·(n2×n3)
        // P = (d1*(n2×n3) + d2*(n3×n1) + d3*(n1×n2)) / det
        fn plane_intersect(p1: &Plane, p2: &Plane, p3: &Plane) -> Option<[f32; 3]> {
            let n1 = &p1.normal;
            let n2 = &p2.normal;
            let n3 = &p3.normal;
            // n2 × n3
            let c23 = [
                n2.y * n3.z - n2.z * n3.y,
                n2.z * n3.x - n2.x * n3.z,
                n2.x * n3.y - n2.y * n3.x,
            ];
            let det = n1.x * c23[0] + n1.y * c23[1] + n1.z * c23[2];
            if det.abs() < 1e-6 {
                return None;
            }
            // n3 × n1
            let c31 = [
                n3.y * n1.z - n3.z * n1.y,
                n3.z * n1.x - n3.x * n1.z,
                n3.x * n1.y - n3.y * n1.x,
            ];
            // n1 × n2
            let c12 = [
                n1.y * n2.z - n1.z * n2.y,
                n1.z * n2.x - n1.x * n2.z,
                n1.x * n2.y - n1.y * n2.x,
            ];
            let inv = 1.0 / det;
            Some([
                (c23[0] * p1.dist + c31[0] * p2.dist + c12[0] * p3.dist) * inv,
                (c23[1] * p1.dist + c31[1] * p2.dist + c12[1] * p3.dist) * inv,
                (c23[2] * p1.dist + c31[2] * p2.dist + c12[2] * p3.dist) * inv,
            ])
        }

        // 单次遍历 brush_sides 收集平面引用 + texture_flags（sky/nodraw），合并原三次遍历
        fn collect_planes_and_flags<'a>(
            bsp: &'a vbsp::Bsp,
            brush: &Brush,
        ) -> (Vec<&'a Plane>, bool /*is_sky*/, bool /*is_nodraw*/) {
            let mut planes = Vec::new();
            let mut is_sky = false;
            let mut is_nodraw = false;
            let sky_flags = vbsp::TextureFlags::SKY | vbsp::TextureFlags::SKY2D;
            let start = brush.brush_side as usize;
            let count = brush.num_brush_sides as usize;
            for i in 0..count {
                let Some(side) = bsp.brush_sides.get(start + i) else {
                    continue;
                };
                // 【遗弃 BSP 自带 bevel】Source 编译时生成的 bevel 平面常为"高悬于
                // 坡顶/凸棱之上、斜率远缓于原始面"的假想扩张面；在本引擎的
                // box-Minkowski 点扫掠模型里，直接用它们做碰撞会让"坡顶永远打滑"
                // 或产生穿模。因此这里**剔除 `side.bevel` 标记的面**，只保留真实
                // brush 面；棱边平滑改由运行时按 AddEdgeBevels 生成的 chamfer 承担。
                if side.bevel != 0 {
                    continue;
                }
                // 收集平面引用
                if let Some(plane) = bsp.planes.get(side.plane as usize) {
                    planes.push(plane);
                }
                // 检查 texture_flags（未命中时检查，短路优化）
                if side.texture_info >= 0 {
                    if let Some(ti) = bsp.textures_info.get(side.texture_info as usize) {
                        if !is_sky && ti.flags.intersects(sky_flags) {
                            is_sky = true;
                        }
                        if !is_nodraw && ti.flags.contains(vbsp::TextureFlags::NODRAW) {
                            is_nodraw = true;
                        }
                    }
                }
            }
            (planes, is_sky, is_nodraw)
        }

        // 计算 brush 顶点：三平面组合求交 + 过滤
        fn compute_vertices(planes: &[&Plane]) -> Vec<[f32; 3]> {
            let mut verts: Vec<[f32; 3]> = Vec::new();
            // 空间哈希去重：cell=0.1 HU，key=(x*10,y*10,z*10) as i32，O(m²)→O(m)
            let mut spatial: std::collections::HashMap<(i32, i32, i32), Vec<usize>> =
                std::collections::HashMap::new();
            let n = planes.len();
            if n < 4 {
                return verts;
            }
            for i in 0..n {
                for j in (i + 1)..n {
                    for k in (j + 1)..n {
                        if let Some(v) = plane_intersect(planes[i], planes[j], planes[k]) {
                            // 验证 v 在所有平面正侧（容差 1.0 HU，容许大坐标浮点误差）
                            let mut valid = true;
                            for p in planes {
                                let d = p.normal.x * v[0]
                                    + p.normal.y * v[1]
                                    + p.normal.z * v[2]
                                    - p.dist;
                                if d < -1.0 {
                                    valid = false;
                                    break;
                                }
                            }
                            if !valid {
                                continue;
                            }
                            // 空间哈希去重：距离 < 0.1 HU 视为同一点，查 3x3x3 邻域
                            let key = (
                                (v[0] * 10.0) as i32,
                                (v[1] * 10.0) as i32,
                                (v[2] * 10.0) as i32,
                            );
                            let mut dup = false;
                            'outer: for dx in -1..=1i32 {
                                for dy in -1..=1i32 {
                                    for dz in -1..=1i32 {
                                        if let Some(indices) =
                                            spatial.get(&(key.0 + dx, key.1 + dy, key.2 + dz))
                                        {
                                            for &idx in indices {
                                                let ev = &verts[idx];
                                                let ddx = ev[0] - v[0];
                                                let ddy = ev[1] - v[1];
                                                let ddz = ev[2] - v[2];
                                                if ddx * ddx + ddy * ddy + ddz * ddz < 0.01 {
                                                    dup = true;
                                                    break 'outer;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            if !dup {
                                spatial.entry(key).or_default().push(verts.len());
                                verts.push(v);
                            }
                        }
                    }
                }
            }
            verts
        }

        // 按面三角化：取平面上的顶点，按角度排序后 fan triangulate
        fn triangulate(planes: &[&Plane], verts: &[[f32; 3]]) -> Vec<[u32; 3]> {
            let mut indexs = Vec::new();
            for p in planes {
                let normal = &p.normal;
                // 找到在该平面上的顶点（距离 < eps）
                let mut face_verts: Vec<usize> = Vec::new();
                for (vi, v) in verts.iter().enumerate() {
                    let d = normal.x * v[0] + normal.y * v[1] + normal.z * v[2] - p.dist;
                    if d.abs() < 0.1 {
                        face_verts.push(vi);
                    }
                }
                if face_verts.len() < 3 {
                    continue;
                }
                // 计算质心
                let mut cx = 0.0f32;
                let mut cy = 0.0f32;
                let mut cz = 0.0f32;
                for &vi in &face_verts {
                    cx += verts[vi][0];
                    cy += verts[vi][1];
                    cz += verts[vi][2];
                }
                let inv_n = 1.0 / face_verts.len() as f32;
                cx *= inv_n;
                cy *= inv_n;
                cz *= inv_n;
                // 选参考方向（与法线不平行）
                let ref_dir = if normal.x.abs() < 0.9 {
                    [1.0f32, 0.0, 0.0]
                } else {
                    [0.0, 1.0, 0.0]
                };
                // u = normalize(ref_dir - (ref_dir·normal)*normal)，平面内参考轴
                let dot_rn = ref_dir[0] * normal.x + ref_dir[1] * normal.y + ref_dir[2] * normal.z;
                let u_raw = [
                    ref_dir[0] - dot_rn * normal.x,
                    ref_dir[1] - dot_rn * normal.y,
                    ref_dir[2] - dot_rn * normal.z,
                ];
                let ulen = (u_raw[0] * u_raw[0] + u_raw[1] * u_raw[1] + u_raw[2] * u_raw[2]).sqrt();
                if ulen < 1e-6 {
                    continue;
                }
                let u = [u_raw[0] / ulen, u_raw[1] / ulen, u_raw[2] / ulen];
                // v = normal × u（在平面内，与 u 正交）
                let v = [
                    normal.y * u[2] - normal.z * u[1],
                    normal.z * u[0] - normal.x * u[2],
                    normal.x * u[1] - normal.y * u[0],
                ];
                // 预计算顶点极角（每顶点 1 次 atan2），避免 sort 比较器重复计算，提速 5-10×
                let mut angled: Vec<(usize, f32)> = face_verts
                    .iter()
                    .map(|&vi| {
                        let va = &verts[vi];
                        let da = [va[0] - cx, va[1] - cy, va[2] - cz];
                        let ang = (da[0] * u[0] + da[1] * u[1] + da[2] * u[2])
                            .atan2(da[0] * v[0] + da[1] * v[1] + da[2] * v[2]);
                        (vi, ang)
                    })
                    .collect();
                angled.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
                face_verts = angled.into_iter().map(|(vi, _)| vi).collect();
                // fan triangulate（顶点顺序 [0, i, i+1] 为 CCW 从法线方向看）
                for i in 1..(face_verts.len() - 1) {
                    indexs.push([
                        face_verts[0] as u32,
                        face_verts[i] as u32,
                        face_verts[i + 1] as u32,
                    ]);
                }
            }
            indexs
        }

        // 主循环
        let mut colliders = Vec::new();
        let mut skipped = 0;
        // 【修复】brush → 模型 world origin 映射（实体 brush 局部坐标 → 世界坐标）
        let brush_model_origins = build_brush_model_origins(bsp);
        // 【修复】无碰撞实体（trigger_* / func_illusionary 等）的 brush 不导出为碰撞体，
        // 否则玩家会在触发区域踩到透明空气墙（用户实测）。
        let brush_models = brush_model_indices(bsp);
        let model_classes = model_classnames(bsp);
        // 调试：跳过原因统计
        let mut skip_no_solid_ladder = 0;
        let mut skip_filter_ladder = 0;
        let mut skip_filter_solid = 0;
        let mut skip_sky = 0;
        let mut skip_nodraw = 0;
        let mut skip_planes_lt4 = 0;
        let mut skip_verts_lt4 = 0;
        let mut skip_volume = 0;
        let mut skip_triangulate_empty = 0;
        const MAX_BRUSHES: usize = 8000; // 性能保护：上限

        for (brush_idx, brush) in bsp.brushes.iter().enumerate() {
            if colliders.len() >= MAX_BRUSHES {
                break;
            }
            // Source 引擎 MASK_PLAYERSOLID 语义：SOLID | WINDOW(玻璃) | GRATE(栅栏) |
            // PLAYERCLIP(玩家 clip) | MOVEABLE(可移动实体)。
            // WATER/SLIME 不在掩码中（可游入），不生成碰撞体。
            let player_solid_mask = BrushFlags::SOLID
                | BrushFlags::WINDOW
                | BrushFlags::GRATE
                | BrushFlags::PLAYERCLIP
                | BrushFlags::MOVEABLE;
            let is_solid = brush.flags.intersects(player_solid_mask);
            let is_ladder = brush.flags.contains(BrushFlags::LADDER);
            // 只导出 MASK_PLAYERSOLID 或 LADDER brush
            if !is_solid && !is_ladder {
                skipped += 1;
                skip_no_solid_ladder += 1;
                continue;
            }
            // 无碰撞实体 brush 过滤：trigger_* / func_illusionary 等不产生碰撞体
            if let Some(mi) = brush_models.get(brush_idx).copied().flatten() {
                if let Some(cls) = model_classes.get(mi).and_then(|c| c.as_deref()) {
                    if entity_is_non_solid(cls) {
                        skipped += 1;
                        continue;
                    }
                }
            }
            // 应用过滤参数
            if !filter.include_ladder && is_ladder {
                skipped += 1;
                skip_filter_ladder += 1;
                continue;
            }
            if !filter.include_solid && is_solid {
                skipped += 1;
                skip_filter_solid += 1;
                continue;
            }
            // 单次遍历收集 planes + sky/nodraw 标志
            let (planes, is_sky, is_nodraw) = collect_planes_and_flags(bsp, brush);
            // 【修复】实体模型 brush 的 planes 是局部坐标——平移模型 origin 到世界位置，
            // 否则碰撞体全部堆在模型原点（"大量不可见碰撞箱堆积在 0,0,0"）。
            let origin = brush_model_origins[brush_idx];
            let has_origin = origin[0] != 0.0 || origin[1] != 0.0 || origin[2] != 0.0;
            let owned_planes: Vec<Plane> = if has_origin {
                planes
                    .iter()
                    .map(|p| Plane {
                        normal: vbsp::Vector {
                            x: p.normal.x,
                            y: p.normal.y,
                            z: p.normal.z,
                        },
                        dist: p.dist
                            + p.normal.x * origin[0]
                            + p.normal.y * origin[1]
                            + p.normal.z * origin[2],
                        ty: p.ty,
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let plane_refs: Vec<&Plane> = if has_origin {
                owned_planes.iter().collect()
            } else {
                planes
            };
            if filter.skip_sky && is_sky {
                skipped += 1;
                skip_sky += 1;
                continue;
            }
            if filter.skip_nodraw && is_nodraw {
                skipped += 1;
                skip_nodraw += 1;
                continue;
            }
            if plane_refs.len() < 4 {
                skipped += 1;
                skip_planes_lt4 += 1;
                continue;
            }

            // 正常计算顶点
            let mut verts = compute_vertices(&plane_refs);
            // 回退：顶点 < 4 时翻转法线重算（部分编辑器生成法线朝内的 brush）
            let flipped: Vec<Plane> = if verts.len() < 4 {
                plane_refs.iter().map(|p| Plane {
                    normal: vbsp::Vector { x: -p.normal.x, y: -p.normal.y, z: -p.normal.z },
                    dist: -p.dist,
                    ty: p.ty,
                }).collect()
            } else { Vec::new() };
            if verts.len() < 4 && !flipped.is_empty() {
                let flipped_refs: Vec<&Plane> = flipped.iter().collect();
                verts = compute_vertices(&flipped_refs);
            }
            if verts.len() < 4 {
                skipped += 1;
                skip_verts_lt4 += 1;
                continue;
            }

            // min_brush_volume 过滤（AABB 体积估算），提前于 triangulate 避免无用的三角化
            if filter.min_brush_volume > 0.0 {
                let vol = aabb_volume(&verts);
                if vol < filter.min_brush_volume {
                    skipped += 1;
                    skip_volume += 1;
                    continue;
                }
            }

            // 三角化使用翻转后的法线（如已翻转）
            let triangulate_planes: Vec<&Plane> = if !flipped.is_empty() {
                flipped.iter().collect()
            } else {
                plane_refs.clone()
            };
            let mut indexs = triangulate(&triangulate_planes, &verts);
            if indexs.is_empty() {
                skipped += 1;
                skip_triangulate_empty += 1;
                continue;
            }

            // 坐标转换 BSP Z-up → Three.js Y-up：`[x,y,z]→[x,z,y]`（det=-1 reflection，反转手性），
            // 翻转三角形顶点顺序 [a,b,c]→[a,c,b] 保持法线朝外；原地修改后 move，避免额外分配
            for v in verts.iter_mut() {
                let (x, y, z) = (v[0], v[1], v[2]);
                v[0] = x;
                v[1] = z;
                v[2] = y;
            }
            let points = verts; // move，verts 不再使用
            for tri in indexs.iter_mut() {
                let tmp = tri[1];
                tri[1] = tri[2];
                tri[2] = tmp;
            }

            colliders.push(Collider {
                points,
                indexs,
                is_ladder,
                is_solid,
                brush_index: brush_idx,
            });
        }

        let report = ColliderReport {
            total_brushes: bsp.brushes.len(),
            exported: colliders.len(),
            skipped,
            colliders,
        };
        // 调试：输出跳过原因统计到控制台
        web_sys::console::log_1(&format!(
            "[Colliders Debug] total={}, exported={}, skipped={}, skip_reasons: no_solid_ladder={}, filter_ladder={}, filter_solid={}, sky={}, nodraw={}, planes_lt4={}, verts_lt4={}, volume={}, triangulate_empty={}",
            report.total_brushes, report.exported, report.skipped,
            skip_no_solid_ladder, skip_filter_ladder, skip_filter_solid,
            skip_sky, skip_nodraw, skip_planes_lt4, skip_verts_lt4,
            skip_volume, skip_triangulate_empty
        ).into());
        serde_json::to_string(&report).map_err(|e| to_js_err(e, "序列化碰撞体数据失败"))
    }

    /// 导出 BSP brush 的平面列表。
    ///
    /// 与 `export_colliders_with_filter` 的区别：
    /// - 输出平面列表（`Plane {normal, dist}`）而非三角化顶点，直接匹配 cs-movement 的 `Brush` 类型
    /// - 坐标旋转 `[x,y,z]→[y,z,x]`（det=+1，正交，不翻转绕序）
    /// - 废弃旧 `[x,y,z]→[x,z,y]` 反射约定（det=−1，需翻转绕序）
    ///
    /// 返回 `WasmBrush[]` JSON：`[{ planes: [{normal, dist}], min, max,
    /// is_ladder, is_solid }]`。
    ///
    /// **坐标转换**：BSP Z-up → Three.js Y-up（`[x,y,z]→[y,z,x]`）。
    /// 法线旋转 `normal = [n.y, n.z, n.x]`；dist 不变（正交变换 `dot(Rn,Rp)=dot(n,p)`）。
    ///
    /// `filter_json` 参数同 `export_colliders_with_filter`（`ColliderFilter` JSON）。
    pub fn export_brushes_planes(&self, filter_json: &str) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        let filter: ColliderFilter =
            serde_json::from_str(filter_json).unwrap_or_default();

        use vbsp::{BrushFlags, Plane};

        #[derive(serde::Serialize)]
        struct WasmBrushPlane {
            normal: [f32; 3],
            dist: f32,
        }
        #[derive(serde::Serialize)]
        struct WasmBrush {
            planes: Vec<WasmBrushPlane>,
            min: [f32; 3],
            max: [f32; 3],
            is_ladder: bool,
            is_solid: bool,
        }

        // 三平面求交（Cramer 法则）— 用于计算 brush AABB
        fn plane_intersect(p1: &Plane, p2: &Plane, p3: &Plane) -> Option<[f32; 3]> {
            let n1 = &p1.normal;
            let n2 = &p2.normal;
            let n3 = &p3.normal;
            let c23 = [
                n2.y * n3.z - n2.z * n3.y,
                n2.z * n3.x - n2.x * n3.z,
                n2.x * n3.y - n2.y * n3.x,
            ];
            let det = n1.x * c23[0] + n1.y * c23[1] + n1.z * c23[2];
            if det.abs() < 1e-6 {
                return None;
            }
            let c31 = [
                n3.y * n1.z - n3.z * n1.y,
                n3.z * n1.x - n3.x * n1.z,
                n3.x * n1.y - n3.y * n1.x,
            ];
            let c12 = [
                n1.y * n2.z - n1.z * n2.y,
                n1.z * n2.x - n1.x * n2.z,
                n1.x * n2.y - n1.y * n2.x,
            ];
            let inv = 1.0 / det;
            Some([
                (c23[0] * p1.dist + c31[0] * p2.dist + c12[0] * p3.dist) * inv,
                (c23[1] * p1.dist + c31[1] * p2.dist + c12[1] * p3.dist) * inv,
                (c23[2] * p1.dist + c31[2] * p2.dist + c12[2] * p3.dist) * inv,
            ])
        }

        // 计算 brush 顶点（半空间交集），用于 AABB — 空间哈希去重
        fn compute_vertices(planes: &[&Plane]) -> Vec<[f32; 3]> {
            let mut verts: Vec<[f32; 3]> = Vec::new();
            let mut spatial: std::collections::HashMap<(i32, i32, i32), Vec<usize>> =
                std::collections::HashMap::new();
            let n = planes.len();
            if n < 4 {
                return verts;
            }
            for i in 0..n {
                for j in (i + 1)..n {
                    for k in (j + 1)..n {
                        if let Some(v) = plane_intersect(planes[i], planes[j], planes[k]) {
                            // 验证 v 在所有平面的正侧
                            let mut valid = true;
                            for p in planes {
                                let d = p.normal.x * v[0]
                                    + p.normal.y * v[1]
                                    + p.normal.z * v[2]
                                    - p.dist;
                                if d < -1.0 {
                                    valid = false;
                                    break;
                                }
                            }
                            if !valid {
                                continue;
                            }
                            // 空间哈希去重（距离 < 0.1 HU 视为同一点）
                            let key = (
                                (v[0] * 10.0) as i32,
                                (v[1] * 10.0) as i32,
                                (v[2] * 10.0) as i32,
                            );
                            let mut dup = false;
                            'outer: for dx in -1..=1i32 {
                                for dy in -1..=1i32 {
                                    for dz in -1..=1i32 {
                                        if let Some(indices) =
                                            spatial.get(&(key.0 + dx, key.1 + dy, key.2 + dz))
                                        {
                                            for &idx in indices {
                                                let ev = &verts[idx];
                                                let ddx = ev[0] - v[0];
                                                let ddy = ev[1] - v[1];
                                                let ddz = ev[2] - v[2];
                                                if ddx * ddx + ddy * ddy + ddz * ddz < 0.01 {
                                                    dup = true;
                                                    break 'outer;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            if !dup {
                                spatial.entry(key).or_default().push(verts.len());
                                verts.push(v);
                            }
                        }
                    }
                }
            }
            verts
        }

        // 坐标旋转 [x,y,z]→[y,z,x]（det=+1，正交变换，BSP Z-up → Three.js Y-up）
        fn rotate_yup(v: &vbsp::Vector) -> [f32; 3] {
            [v.y, v.z, v.x]
        }

        const MAX_BRUSHES: usize = 8000; // 性能保护：上限
        let sky_flags = vbsp::TextureFlags::SKY | vbsp::TextureFlags::SKY2D;
        let mut brushes_out: Vec<WasmBrush> = Vec::new();
        let mut skipped = 0;
        // 【修复】brush → 模型 world origin 映射（实体 brush 局部坐标 → 世界坐标）
        let brush_model_origins = build_brush_model_origins(bsp);
        // 【修复】无碰撞实体（trigger_* / func_illusionary 等）的 brush 不导出为碰撞体，
        // 否则玩家会在触发区域踩到透明空气墙（用户实测）。
        let brush_models = brush_model_indices(bsp);
        let model_classes = model_classnames(bsp);

        for (brush_idx, brush) in bsp.brushes.iter().enumerate() {
            if brushes_out.len() >= MAX_BRUSHES {
                break;
            }
            // MASK_PLAYERSOLID 语义同 export_colliders_with_filter：SOLID|WINDOW|GRATE|PLAYERCLIP|MOVEABLE
            let player_solid_mask = BrushFlags::SOLID
                | BrushFlags::WINDOW
                | BrushFlags::GRATE
                | BrushFlags::PLAYERCLIP
                | BrushFlags::MOVEABLE;
            let is_solid = brush.flags.intersects(player_solid_mask);
            let is_ladder = brush.flags.contains(BrushFlags::LADDER);
            if !is_solid && !is_ladder {
                skipped += 1;
                continue;
            }
            // 无碰撞实体 brush 过滤：trigger_* / func_illusionary 等不产生碰撞体
            if let Some(mi) = brush_models.get(brush_idx).copied().flatten() {
                if let Some(cls) = model_classes.get(mi).and_then(|c| c.as_deref()) {
                    if entity_is_non_solid(cls) {
                        skipped += 1;
                        continue;
                    }
                }
            }
            if !filter.include_ladder && is_ladder {
                skipped += 1;
                continue;
            }
            if !filter.include_solid && is_solid {
                skipped += 1;
                continue;
            }

            // 单次遍历 brush_sides 收集平面引用 + sky/nodraw 标志；
            // 数组访问用 .get() 防 panic 破坏 wasm-bindgen 借用状态
            // 【遗弃 BSP bevel】：剔除 side.bevel 标记的高悬面(见 collect_planes_and_flags 说明)
            let mut bsp_planes: Vec<&Plane> = Vec::new();
            let mut is_sky = false;
            let mut is_nodraw = false;
            let start = brush.brush_side as usize;
            let count = brush.num_brush_sides as usize;
            for i in 0..count {
                let Some(side) = bsp.brush_sides.get(start + i) else {
                    continue;
                };
                if side.bevel != 0 {
                    continue;
                }
                if let Some(plane) = bsp.planes.get(side.plane as usize) {
                    bsp_planes.push(plane);
                }
                if side.texture_info >= 0 {
                    if let Some(ti) = bsp.textures_info.get(side.texture_info as usize) {
                        if !is_sky && ti.flags.intersects(sky_flags) {
                            is_sky = true;
                        }
                        if !is_nodraw && ti.flags.contains(vbsp::TextureFlags::NODRAW) {
                            is_nodraw = true;
                        }
                    }
                }
            }

            if filter.skip_sky && is_sky {
                skipped += 1;
                continue;
            }
            if filter.skip_nodraw && is_nodraw {
                skipped += 1;
                continue;
            }
            if bsp_planes.len() < 4 {
                skipped += 1;
                continue;
            }

            // 【修复】实体模型 brush 的 planes 是局部坐标（相对模型 origin），
            // 平移模型 origin 到世界坐标，否则碰撞体全部堆在模型原点
            // （nsz 169 个原点 brush 的实体部分、test.bsp 触发器碰撞箱堆积的根因）。
            let origin = brush_model_origins[brush_idx];
            let has_origin = origin[0] != 0.0 || origin[1] != 0.0 || origin[2] != 0.0;
            let owned_planes: Vec<Plane> = if has_origin {
                bsp_planes
                    .iter()
                    .map(|p| Plane {
                        normal: vbsp::Vector {
                            x: p.normal.x,
                            y: p.normal.y,
                            z: p.normal.z,
                        },
                        dist: p.dist
                            + p.normal.x * origin[0]
                            + p.normal.y * origin[1]
                            + p.normal.z * origin[2],
                        ty: p.ty,
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let bsp_plane_refs: Vec<&Plane> = if has_origin {
                owned_planes.iter().collect()
            } else {
                // 浅克隆引用（Vec<&Plane>），后续 planes_yup 仍需借用 bsp_planes
                bsp_planes.clone()
            };

        // 计算 BSP 坐标顶点（用于 AABB）
        let mut verts_bsp = compute_vertices(&bsp_plane_refs);

        // 回退：顶点 < 4 时翻转法线重算（部分编辑器生成法线朝内的 brush）
        // 与 export_colliders_with_filter 保持一致
        let flipped_planes: Vec<Plane> = if verts_bsp.len() < 4 {
            bsp_plane_refs
                .iter()
                .map(|p| Plane {
                    normal: vbsp::Vector {
                        x: -p.normal.x,
                        y: -p.normal.y,
                        z: -p.normal.z,
                    },
                    dist: -p.dist,
                    ty: p.ty,
                })
                .collect()
        } else {
            Vec::new()
        };
        if verts_bsp.len() < 4 && !flipped_planes.is_empty() {
            let flipped_refs: Vec<&Plane> = flipped_planes.iter().collect();
            verts_bsp = compute_vertices(&flipped_refs);
        }
        if verts_bsp.len() < 4 {
            skipped += 1;
            continue;
        }

        // =========================================================================
        // 运行时棱边 chamfer(AddEdgeBevels 简化版) —— 替代被遗弃的 BSP bevel
        // -------------------------------------------------------------------------
        // 对凸包的每条"真实棱边"（两个非平行面共享 ≥2 个顶点），构造一个微小切角
        // 平面：法线 = 两相邻面法线的归一化均值，位于棱边外侧。它负责：
        //   1) 高速盒角扫过坡顶棱线时平滑引导入坡；
        //   2) 打开凸包棱线的尖锐过渡，避免盒角在该处提前/异常碰撞。
        // 关键约束：chamfer 必须位于凸包**外部**（所有其它凸包顶点都在其
        // "外侧"），否则会实际挤压凸包、影响可站性 —— 这正是 BSP 高悬 bevel
        // 的问题所在，绝不能再犯。这里只在被原始面"夹住"的极薄棱外层生效。
        // 生成逻辑（BSP 坐标）：
        //   - 对每对平面 i<j：axis = cross(n_i,n_j) 为两平面交线方向；
        //   - 找同时落在这两平面上的顶点（距离 < eps）集合，若 ≥2 即是一条真实棱；
        //   - chamfer 法线 n_ch = normalize(n_i + n_j)（非共面才可用）；
        //   - 取其棱上一顶点作为过平面点，dist = dot(n_ch, 顶点)；
        //   - 验证：对凸包上**不属于该棱的其它顶点**，dot(n_ch, v) - dist 同号
        //     （都在 chamfer 平面的外侧）→ 才是"凸棱上的外切角"；否则丢弃。
        // =========================================================================
        let mut chamfer_planes: Vec<Plane> = Vec::new();
        {
            let eps_plane = 0.1f32; // 顶点在某平面上的判定容差
            let n_planes = bsp_plane_refs.len();
            // 预计算每个顶点落在哪些平面上（idx -> 平面索引集）
            let mut vert_planes: Vec<Vec<usize>> = Vec::with_capacity(verts_bsp.len());
            for v in &verts_bsp {
                let mut on: Vec<usize> = Vec::new();
                for (pi, p) in bsp_plane_refs.iter().enumerate() {
                    let d = p.normal.x * v[0] + p.normal.y * v[1] + p.normal.z * v[2] - p.dist;
                    if d.abs() < eps_plane {
                        on.push(pi);
                    }
                }
                vert_planes.push(on);
            }
            for i in 0..n_planes {
                for j in (i + 1)..n_planes {
                    let ni = [
                        bsp_plane_refs[i].normal.x,
                        bsp_plane_refs[i].normal.y,
                        bsp_plane_refs[i].normal.z,
                    ];
                    let nj = [
                        bsp_plane_refs[j].normal.x,
                        bsp_plane_refs[j].normal.y,
                        bsp_plane_refs[j].normal.z,
                    ];
                    // 共面或平行 → 无真实棱
                    let ndot = ni[0] * nj[0] + ni[1] * nj[1] + ni[2] * nj[2];
                    if ndot.abs() > 0.999 {
                        continue;
                    }
                    // 找出同时落在面 i、j 上的顶点
                    let mut shared: Vec<usize> = Vec::new();
                    for (vi, on) in vert_planes.iter().enumerate() {
                        if on.contains(&i) && on.contains(&j) {
                            shared.push(vi);
                        }
                    }
                    if shared.len() < 2 {
                        continue; // 非共边：只共享 0/1 个顶点（角点）
                    }
                    // chamfer 法线 = 两法线均值（BSP 朝内约定下同样适用，方向随后校验）
                    let mut nch = [
                        ni[0] + nj[0],
                        ni[1] + nj[1],
                        ni[2] + nj[2],
                    ];
                    let len = (nch[0] * nch[0] + nch[1] * nch[1] + nch[2] * nch[2]).sqrt();
                    if len < 1e-6 {
                        continue;
                    }
                    nch = [nch[0] / len, nch[1] / len, nch[2] / len];
                    // 取棱上一点（任一共享顶点）求 dist
                    let anchor = &verts_bsp[shared[0]];
                    let dist = nch[0] * anchor[0] + nch[1] * anchor[1] + nch[2] * anchor[2];
                    // 方向校验：chamfer 应位于凸包外侧。
                    // BSP 约定法线朝内（内部顶点 dot(n,v)-dist >= 0）。
                    // 定义"符号基准"：该棱两个共享顶点在 chamfer 平面上（≈0）。
                    // 其余凸包顶点应全部落在 chamfer 平面**同一侧**且该侧与"两相邻
                    // 面法线的均值指向"一致 → 若其它顶点都在 chamfer 的负侧(外部)，
                    // 说明 chamfer 法线朝外，正确；若混号则丢弃。
                    let mut first_side: Option<f32> = None;
                    let mut valid = true;
                    for (vi0, v) in verts_bsp.iter().enumerate() {
                        if shared.contains(&vi0) {
                            continue; // 棱上顶点，跳过
                        }
                        let d = nch[0] * v[0] + nch[1] * v[1] + nch[2] * v[2] - dist;
                        match first_side {
                            None => first_side = Some(if d > 0.0 { 1.0 } else { -1.0 }),
                            Some(s) => {
                                if d * s < -0.001 {
                                    valid = false;
                                    break;
                                }
                            }
                        }
                    }
                    if !valid {
                        continue;
                    }
                    // chamfer 法线需相对"两相邻面法线均值"同向（朝外）
                    let radj = match first_side {
                        Some(s) => s,
                        None => 1.0,
                    };
                    let nch_final = if radj > 0.0 {
                        nch
                    } else {
                        [-nch[0], -nch[1], -nch[2]]
                    };
                    let dist_final = nch_final[0] * anchor[0]
                        + nch_final[1] * anchor[1]
                        + nch_final[2] * anchor[2];
                    chamfer_planes.push(Plane {
                        normal: vbsp::Vector {
                            x: nch_final[0],
                            y: nch_final[1],
                            z: nch_final[2],
                        },
                        dist: dist_final,
                        ty: 0,
                    });
                }
            }
        }
        // 合并真实面 + chatfer（chamfer 也会参与最终序列化，同样 rotate+flip）
        let mut all_planes_src: Vec<Plane> = Vec::new();
        if !flipped_planes.is_empty() {
            all_planes_src.extend(flipped_planes.iter().cloned());
        } else {
            for p in &bsp_plane_refs {
                all_planes_src.push(Plane {
                    normal: p.normal.clone(),
                    dist: p.dist,
                    ty: p.ty,
                });
            }
        }
        all_planes_src.extend(chamfer_planes);

            // 体积过滤（基于 AABB 体积估算）
            if filter.min_brush_volume > 0.0 {
                let vol = aabb_volume(&verts_bsp);
                if vol < filter.min_brush_volume {
                    skipped += 1;
                    continue;
                }
            }

            // 旋转顶点到 Y-up 并计算 AABB
            let mut min = [f32::INFINITY; 3];
            let mut max = [f32::NEG_INFINITY; 3];
            for v in &verts_bsp {
                let ry = [v[1], v[2], v[0]]; // [x,y,z]→[y,z,x]
                for i in 0..3 {
                    if ry[i] < min[i] {
                        min[i] = ry[i];
                    }
                    if ry[i] > max[i] {
                        max[i] = ry[i];
                    }
                }
            }

            // 旋转平面法线到 Y-up，并翻转法线方向（vbsp 内部约定 → cs-movement 约定）。
            //
            // **法线方向转换（关键修复）**：vbsp 读取的平面为"法线朝内"约定
            // （内部在正侧 `dot(n,p)-dist >= 0`，`compute_vertices` 的 `d < -1.0` 检查与此一致）；
            // cs-movement 的 `traceBox` / `brushFromAABB` 用"法线朝外"（内部在负侧，`d1>0` 表示起点在外）。
            // 直接导出会导致 cs-movement 误判内外，`traceBox` 永远返回 `fraction=1`（玩家穿透）。
            //
            // 修复：对每平面取负 `normal` 与 `dist`（`dot(-n,p)-(-dist) = -(dot(n,p)-dist)`，
            // 内部点 d>=0 → d<=0，等价翻转半空间）。先旋转到 Y-up 再取负（二者可交换）。
            // 统一从 all_planes_src（真实面 + 运行时 chamfer）构建，chamfer 一并输出，
            // 既进物理碰撞也进 debug 线框显示。
            let planes_yup: Vec<WasmBrushPlane> = all_planes_src
                .iter()
                .map(|p| {
                    let r = rotate_yup(&p.normal);
                    WasmBrushPlane {
                        normal: [-r[0], -r[1], -r[2]],
                        dist: -p.dist,
                    }
                })
                .collect();

            brushes_out.push(WasmBrush {
                planes: planes_yup,
                min,
                max,
                is_ladder,
                is_solid,
            });
        }

        web_sys::console::log_1(&format!(
            "[BrushPlanes] total={}, exported={}, skipped={}",
            bsp.brushes.len(),
            brushes_out.len(),
            skipped
        ).into());

        // 输出纯 WasmBrush[] JSON 数组
        serde_json::to_string(&brushes_out).map_err(|e| to_js_err(e, "序列化 brush 平面数据失败"))
    }
}

// ---------------------------------------------------------------------------
// 碰撞体导出过滤参数与辅助函数
// ---------------------------------------------------------------------------

/// 碰撞体导出过滤参数，由前端以 JSON 传入，控制 [`BspProcessor::export_colliders_with_filter`]
/// 导出哪些 brush。所有字段可选，缺失时用默认值。字段名为 snake_case：
/// - `include_ladder` / `include_solid` (默认 true): 是否导出 LADDER / SOLID brush
/// - `min_brush_volume` (f32, 默认 0): 跳过 AABB 体积小于此值的 brush
/// - `skip_sky` (默认 true): 跳过含 SKY 纹理的 brush（天空无碰撞）
/// - `skip_nodraw` (默认 false): 跳过含 NODRAW 纹理的 brush。
///   注意：NODRAW 只影响渲染不影响碰撞，故默认不跳过。
///
/// 示例：`{"skip_sky": false, "min_brush_volume": 100.0}`
#[derive(serde::Deserialize, Clone)]
struct ColliderFilter {
    #[serde(default = "default_true")]
    include_ladder: bool,
    #[serde(default = "default_true")]
    include_solid: bool,
    #[serde(default)]
    min_brush_volume: f32,
    #[serde(default = "default_true")]
    skip_sky: bool,
    #[serde(default)]
    skip_nodraw: bool,
}

// 自定义 Default：与 serde 默认一致（include_*=true, skip_sky=true, skip_nodraw=false）；
// #[derive(Default)] 会为 bool 生成 false，与 #[serde(default = "default_true")] 不一致
impl Default for ColliderFilter {
    fn default() -> Self {
        ColliderFilter {
            include_ladder: true,
            include_solid: true,
            min_brush_volume: 0.0,
            skip_sky: true,
            skip_nodraw: false,
        }
    }
}

fn default_true() -> bool {
    true
}

/// Source 引擎中**无物理碰撞**的实体（brush 只是触发/标记区域，玩家可穿过）。
///
/// 这些实体 brush 不参与玩家碰撞（MASK_PLAYERSOLID 不包含 trigger 面）：
/// - `trigger_*`：触发器（trigger_teleport / trigger_multiple / trigger_push / trigger_hurt…）
/// - `func_illusionary`：幻觉实体（看得见摸不着）
/// - `func_occluder` / `func_dustmotes` / `func_areaportal` / `func_precipitation`
///
/// 若导出为固体碰撞体，玩家会在触发区域踩到透明空气墙（用户实测的导出 bug）。
fn entity_is_non_solid(classname: &str) -> bool {
    classname.starts_with("trigger_")
        || classname == "func_illusionary"
        || classname == "func_occluder"
        || classname == "func_dustmotes"
        || classname == "func_areaportal"
        || classname == "func_precipitation"
}

/// 实体 → 模型 classname 映射（`model="*N"` 实体）；model[0]（worldspawn）为 None。
fn model_classnames(bsp: &vbsp::Bsp) -> Vec<Option<String>> {
    let mut m: Vec<Option<String>> = vec![None; bsp.models.len()];
    for ent in bsp.entities.iter() {
        let Ok(model_raw) = ent.prop("model") else {
            continue;
        };
        let model_raw = model_raw.to_string();
        if !model_raw.starts_with('*') {
            continue;
        }
        let Ok(mi) = model_raw[1..].parse::<usize>() else {
            continue;
        };
        if mi == 0 || mi >= m.len() || m[mi].is_some() {
            continue; // 跳过 worldspawn 与重复引用（首个实体优先）
        }
        let Ok(cls) = ent.prop("classname") else {
            continue;
        };
        m[mi] = Some(cls.to_string());
    }
    m
}

/// brush → 模型索引映射（遍历 model.head_node 收集）；worldspawn 与无归属 brush 为 None。
fn brush_model_indices(bsp: &vbsp::Bsp) -> Vec<Option<usize>> {
    let mut map: Vec<Option<usize>> = vec![None; bsp.brushes.len()];
    for (mi, model) in bsp.models.iter().enumerate() {
        if mi == 0 {
            continue; // worldspawn 的 brush 归属模型 0（None）
        }
        let mut stack: Vec<i32> = vec![model.head_node];
        while let Some(node_idx) = stack.pop() {
            if node_idx < 0 {
                let leaf_idx = (!node_idx) as usize;
                let Some(leaf) = bsp.leaves.get(leaf_idx) else {
                    continue;
                };
                let start = leaf.first_leaf_brush as usize;
                let count = leaf.leaf_brush_count as usize;
                for k in start..(start + count).min(bsp.leaf_brushes.len()) {
                    if let Some(lb) = bsp.leaf_brushes.get(k) {
                        let bi = lb.brush as usize;
                        if bi < map.len() && map[bi].is_none() {
                            map[bi] = Some(mi);
                        }
                    }
                }
            } else if let Some(node) = bsp.nodes.get(node_idx as usize) {
                stack.push(node.children[0] as i32);
                stack.push(node.children[1] as i32);
            }
        }
    }
    map
}

/// 确定每个 brush 应平移的模型 origin（Z-up 世界坐标）。
///
/// **关键修复**：实体模型的 brush 几何以局部坐标存储（相对实体 origin），
/// 而 `dmodel_t.origin` 字段在本工具链的 BSP 中不可靠（实测为垃圾值/0），
/// 权威来源是 entities lump 中实体的 `origin` keyvalue（与 `parse_teleports` 一致）。
///
/// worldspawn（model[0]）局部即世界，无需平移；无实体引用的 model 跳过。
fn build_brush_model_origins(bsp: &vbsp::Bsp) -> Vec<[f32; 3]> {
    let mut origins = vec![[0.0f32; 3]; bsp.brushes.len()];

    // 1. 实体 → 模型 origin 映射（model="*N" 实体的 origin 为权威位置）
    let mut model_origins: Vec<Option<[f32; 3]>> = vec![None; bsp.models.len()];
    for ent in bsp.entities.iter() {
        let Ok(model_raw) = ent.prop("model") else {
            continue;
        };
        let model_raw = model_raw.to_string();
        if !model_raw.starts_with('*') {
            continue;
        }
        let Ok(mi) = model_raw[1..].parse::<usize>() else {
            continue;
        };
        if mi == 0 || mi >= model_origins.len() || model_origins[mi].is_some() {
            continue; // 跳过 worldspawn 与重复引用（首个实体优先）
        }
        let Ok(origin_raw) = ent.prop("origin") else {
            continue; // 无 origin keyvalue（如 func_door 旋转摆法）→ 不平移
        };
        let Ok(origin) = origin_raw.parse::<vbsp::Vector>() else {
            continue;
        };
        model_origins[mi] = Some(origin.into());
    }

    // 2. brush → 模型归属：从 model.head_node 遍历 BSP 树收集 brush
    for (mi, model) in bsp.models.iter().enumerate() {
        if mi == 0 {
            continue;
        }
        let Some(origin) = model_origins[mi] else {
            continue;
        };
        let mut stack: Vec<i32> = vec![model.head_node];
        while let Some(node_idx) = stack.pop() {
            if node_idx < 0 {
                // 负数 → leaf（~idx）
                let leaf_idx = (!node_idx) as usize;
                let Some(leaf) = bsp.leaves.get(leaf_idx) else {
                    continue;
                };
                let start = leaf.first_leaf_brush as usize;
                let count = leaf.leaf_brush_count as usize;
                for k in start..(start + count).min(bsp.leaf_brushes.len()) {
                    if let Some(lb) = bsp.leaf_brushes.get(k) {
                        let bi = lb.brush as usize;
                        if bi < origins.len() {
                            origins[bi] = origin;
                        }
                    }
                }
            } else if let Some(node) = bsp.nodes.get(node_idx as usize) {
                stack.push(node.children[0] as i32);
                stack.push(node.children[1] as i32);
            }
        }
    }
    origins
}

/// 计算 brush 顶点的 AABB 体积（粗略过滤用；非凸包真实体积，足以过滤过小 brush）。
fn aabb_volume(verts: &[[f32; 3]]) -> f32 {
    if verts.is_empty() {
        return 0.0;
    }
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for v in verts {
        for i in 0..3 {
            if v[i] < min[i] {
                min[i] = v[i];
            }
            if v[i] > max[i] {
                max[i] = v[i];
            }
        }
    }
    (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2])
}

// ---------------------------------------------------------------------------
// visleaf + PVS 二进制导出（WASM 版 export-vis-pvs，供 Node 脚本离线导出）
//
// 与 crates/vbsp/src/bin/export-vis-pvs.rs 的 compute_core + export_binary 一致，
// 输出字节完全相同的 .visleaf.bin / .pvs.bin（格式 v1）。
// 依赖 vbsp 修复：leaves lump version 1 解析 + vis data 完整基址（见 docs/PVS-BUG-ROOTCAUSE.md）。
// ---------------------------------------------------------------------------

/// 从 BSP 字节数组导出 visleaf + PVS 二进制数据。
///
/// 返回 JS 对象：`{ visleaf_bin: Uint8Array(VBVL), pvs_bin: Uint8Array(VBPV),
/// md5Hex: 源 BSP MD5, clusterCount, leafCount, nodeCount, faceCount }`
#[wasm_bindgen]
pub fn export_visleaf_pvs(data: &[u8]) -> Result<JsValue, JsValue> {
    use vbsp::{Bsp, Leaf, Node, Plane, Vector};

    // ---- 源 BSP MD5 ----
    let md5_bytes: [u8; 16] = md5::compute(data).0;
    let md5_hex: String = md5_bytes.iter().map(|b| format!("{:02x}", b)).collect();

    // ---- 解析（含修复：leaves v1 / vis 完整基址）----
    let bsp = Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;

    // ---- 坐标旋转 [x,y,z] → [y,z,x]（BSP Z-up → Three.js Y-up，det=+1）----
    fn rotate_yup_f32(v: &Vector) -> [f32; 3] {
        [v.y, v.z, v.x]
    }
    fn rotate_yup_i16(v: [i16; 3]) -> [i16; 3] {
        [v[1], v[2], v[0]]
    }
    fn default_plane() -> Plane {
        Plane {
            normal: Vector { x: 0.0, y: 0.0, z: 1.0 },
            dist: 0.0,
            ty: 0,
        }
    }

    // ---- nodes ----
    let nodes: Vec<([f32; 3], f32, [i32; 2])> = bsp
        .nodes
        .iter()
        .map(|node: &Node| {
            let plane_idx = node.plane_index as usize;
            let dp = default_plane();
            let plane = bsp.planes.get(plane_idx).unwrap_or(&dp);
            (rotate_yup_f32(&plane.normal), plane.dist, node.children)
        })
        .collect();

    // ---- leaves ----
    let leaves: Vec<(i16, [i16; 3], [i16; 3], bool)> = bsp
        .leaves
        .iter()
        .map(|leaf: &Leaf| {
            (
                leaf.cluster,
                rotate_yup_i16(leaf.mins),
                rotate_yup_i16(leaf.maxs),
                leaf.cluster < 0,
            )
        })
        .collect();

    // ---- face → cluster ----
    let mut face_clusters = vec![-1i32; bsp.faces.len()];
    for leaf in bsp.leaves.iter() {
        if leaf.cluster < 0 {
            continue;
        }
        let start = leaf.first_leaf_face as usize;
        let count = leaf.leaf_face_count as usize;
        if start + count > bsp.leaf_faces.len() {
            continue;
        }
        for fi in start..(start + count) {
            let face_idx = bsp.leaf_faces[fi].face as usize;
            if face_idx < face_clusters.len() && face_clusters[face_idx] < 0 {
                face_clusters[face_idx] = leaf.cluster as i32;
            }
        }
    }

    // ---- PVS 位图（vbsp::decode_pvs_row 为唯一权威解码）----
    let cluster_count = bsp.vis_data.cluster_count;
    let bytes_per_row = ((cluster_count as usize) + 7) / 8;
    let mut pvs_bits = vec![0u8; (cluster_count as usize) * bytes_per_row];
    if cluster_count > 0 && !bsp.vis_data.pvs_offsets.is_empty() {
        let vis_data = &bsp.vis_data.data;
        for c in 0..cluster_count {
            let c_usize = c as usize;
            if c_usize >= bsp.vis_data.pvs_offsets.len() {
                break;
            }
            let offset = bsp.vis_data.pvs_offsets[c_usize] as usize;
            vbsp::decode_pvs_row(
                vis_data,
                offset,
                cluster_count,
                bytes_per_row,
                c_usize * bytes_per_row,
                &mut pvs_bits,
            );
        }
    }

    // ---- 打包 visleaf.bin (VBVL) ----
    let mut vl: Vec<u8> = Vec::with_capacity(40 + nodes.len() * 24 + leaves.len() * 15 + face_clusters.len() * 4);
    vl.extend_from_slice(b"VBVL");
    vl.extend_from_slice(&1u32.to_le_bytes());
    vl.extend_from_slice(&md5_bytes);
    vl.extend_from_slice(&cluster_count.to_le_bytes());
    vl.extend_from_slice(&(leaves.len() as u32).to_le_bytes());
    vl.extend_from_slice(&(nodes.len() as u32).to_le_bytes());
    vl.extend_from_slice(&(face_clusters.len() as u32).to_le_bytes());
    for (normal, dist, children) in &nodes {
        for c in normal {
            vl.extend_from_slice(&c.to_le_bytes());
        }
        vl.extend_from_slice(&dist.to_le_bytes());
        for c in children {
            vl.extend_from_slice(&c.to_le_bytes());
        }
    }
    for (cluster, mins, maxs, is_solid) in &leaves {
        vl.extend_from_slice(&cluster.to_le_bytes());
        for c in mins {
            vl.extend_from_slice(&c.to_le_bytes());
        }
        for c in maxs {
            vl.extend_from_slice(&c.to_le_bytes());
        }
        vl.push(*is_solid as u8);
    }
    for fc in &face_clusters {
        vl.extend_from_slice(&fc.to_le_bytes());
    }

    // ---- 打包 pvs.bin (VBPV) ----
    let mut pv: Vec<u8> = Vec::with_capacity(32 + pvs_bits.len());
    pv.extend_from_slice(b"VBPV");
    pv.extend_from_slice(&1u32.to_le_bytes());
    pv.extend_from_slice(&md5_bytes);
    pv.extend_from_slice(&cluster_count.to_le_bytes());
    pv.extend_from_slice(&(bytes_per_row as u32).to_le_bytes());
    pv.extend_from_slice(&pvs_bits);

    // ---- 组装返回对象 ----
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("visleaf_bin"),
        &js_sys::Uint8Array::from(&vl[..]),
    )
    .map_err(|e| to_js_err(e, "设置 visleaf_bin 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("pvs_bin"),
        &js_sys::Uint8Array::from(&pv[..]),
    )
    .map_err(|e| to_js_err(e, "设置 pvs_bin 失败"))?;
    js_sys::Reflect::set(&obj, &JsValue::from_str("md5Hex"), &JsValue::from_str(&md5_hex))
        .map_err(|e| to_js_err(e, "设置 md5Hex 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("clusterCount"),
        &JsValue::from_f64(cluster_count as f64),
    )
    .map_err(|e| to_js_err(e, "设置 clusterCount 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("leafCount"),
        &JsValue::from_f64(leaves.len() as f64),
    )
    .map_err(|e| to_js_err(e, "设置 leafCount 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("nodeCount"),
        &JsValue::from_f64(nodes.len() as f64),
    )
    .map_err(|e| to_js_err(e, "设置 nodeCount 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("faceCount"),
        &JsValue::from_f64(face_clusters.len() as f64),
    )
    .map_err(|e| to_js_err(e, "设置 faceCount 失败"))?;

    Ok(obj.into())
}

// ---------------------------------------------------------------------------
// VTF 解码
// ---------------------------------------------------------------------------

/// 将 VTF 字节数组解码为 PNG 字节数组。
///
/// 默认解码高分辨率第一帧。
#[wasm_bindgen]
pub fn decode_vtf_to_png(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let vtf = texture_utils::from_bytes(data).map_err(|e| to_js_err(e, "VTF 解析失败"))?;
    let image = vtf
        .highres_image
        .decode(0)
        .map_err(|e| to_js_err(e, "VTF 图像解码失败"))?;

    let mut output: Vec<u8> = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut output), image::ImageFormat::Png)
        .map_err(|e| to_js_err(e, "PNG 编码失败"))?;

    Ok(output)
}

// ---------------------------------------------------------------------------
// 纹理画质切换（mosaic 共享模块：压缩/还原低清纹理）
// ---------------------------------------------------------------------------

/// PNG 字节 → mosaic v4 纹理字节码（压缩）。
#[wasm_bindgen]
pub fn mosaic_encode(png: &[u8], name: &str) -> Result<String, JsValue> {
    websurf_wasm_core::mosaic::encode::img_to_code(png, name)
        .map_err(|e| JsValue::from_str(&format!("mosaic_encode: {e}")))
}

/// mosaic v4 字节码 → PNG 字节（低清还原，最近邻放大 ×scale，默认 ×8）。
#[wasm_bindgen]
pub fn mosaic_decode(code: &str, scale: u32) -> Result<Vec<u8>, JsValue> {
    websurf_wasm_core::mosaic::decode::code_to_img(code, scale)
        .map_err(|e| JsValue::from_str(&format!("mosaic_decode: {e}")))
}

/// 解压默认配置纹理包（textures.mtz，MTZ5 容器）→ textures.json 文本。
/// 纹理键 = `materials/xxx`（与 basetexture 一致），供缺失纹理比对。
#[wasm_bindgen]
pub fn decompress_mtz(bytes: &[u8]) -> Result<String, JsValue> {
    websurf_wasm_core::mosaic::mtz::decompress_mtz(bytes)
        .map_err(|e| JsValue::from_str(&format!("decompress_mtz: {e}")))
}

// ---------------------------------------------------------------------------
// 初始化入口
// ---------------------------------------------------------------------------

/// 模块初始化：安装 panic hook，便于调试。
#[wasm_bindgen(start)]
pub fn start() {
    #[cfg(target_arch = "wasm32")]
    init_panic_hook();
}
