//! WebSurf-viewer WASM 薄导出层。
//!
//! 导出 [`BspProcessor`]（BSP 解析 + 导出集，解析层共享 src/wasm-core/）：
//! - `metadata()`：map 元数据（magic/brush/face/模型 计数等）
//! - `parse_spawn_points()`：出生点 report（初始视角默认位）
//! - `export_glb_with_pakfile_models()`：含 PAKFILE 模型的 GLB（渲染用；消费 BSP）
//!
//! 运行时最小集（app.ts）只调用上述三方法——自由视角查看器不需要
//! brush/模型碰撞/teleport/PVS/mosaic/默认纹理包，均不导出。

use std::collections::HashMap;
use std::io::Cursor;

use wasm_bindgen::prelude::*;

// 解析层共享自仓库根 src/wasm-core/（websurf-wasm-core crate）
use websurf_wasm_core::{bsp_to_gltf_core, model_integrator, pakfile_models, texture_utils, vbsp};
use model_integrator::{
    ExportOptions, InMemoryModel, InMemoryResources, ModelIntegrator, StaticProp,
};

// ---------------------------------------------------------------------------
// 错误处理辅助
// ---------------------------------------------------------------------------

/// 将任意错误转换为 JavaScript 错误。
fn to_js_err<E: std::fmt::Debug>(e: E, ctx: &str) -> JsValue {
    JsValue::from_str(&format!("{}: {:?}", ctx, e))
}

// ---------------------------------------------------------------------------
// PAKFILE 内嵌模型：三件套提取 / 材质解析
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

/// 内部 VTF → PNG 解码（GLB 材质贴图导出用；不导出为 wasm API）。
fn decode_vtf_to_png(data: &[u8]) -> Result<Vec<u8>, JsValue> {
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

/// 解析所有被引用模型的材质：从 PAKFILE 取 `.vmt` 得透明度标注，再按 `$basetexture` 取 `.vtf` 解码为 PNG。
fn resolve_pakfile_materials(
    bsp: &vbsp::Bsp,
    models: &[InMemoryModel],
    index: &pakfile_models::PakIndex,
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
                // VMT 未打包 → 按不透明处理
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
// 元数据 / 解析入口
// ---------------------------------------------------------------------------

/// 顶层元数据，前端通过 `JSON.parse(BspProcessor::metadata())` 直接使用。
///
/// 普通 Rust 结构体（不标 `#[wasm_bindgen]`）：wasm_bindgen 导出要求字段实现 `Copy`，
/// 而 `String` 字段不满足；经 `metadata` 序列化为 JSON 返回。
#[derive(serde::Serialize)]
pub struct BspMetadata {
    pub schema_version: u32,
    /// BSP 魔术字（如 "VBSP"），由 header.v/b/s/p 拼成。
    pub magic: String,
    pub map_name: String,
    pub num_models: usize,
    pub num_faces: usize,
    pub num_vertices: usize,
    pub num_brushes: usize,
    pub num_static_props: usize,
    /// pakfile 中打包的文件数（VFS 资源数）。
    pub packed_files: usize,
}

impl BspMetadata {
    // packed_files 由调用方传入：vbsp 0.6.0 的 Packfile.zip 为私有字段，
    // into_zip() 消费 self，只能 clone 后取 len()；由 new 缓存避免 metadata() 重复克隆。
    fn from_bsp(bsp: &vbsp::Bsp, packed_files: usize) -> Self {
        let num_static_props = bsp.static_props().count();

        let h = &bsp.header;
        let magic = format!("{}{}{}{}", h.v as char, h.b as char, h.s as char, h.p as char);

        BspMetadata {
            schema_version: 1,
            magic,
            map_name: String::new(),
            num_models: bsp.models.len(),
            num_faces: bsp.faces.len(),
            num_vertices: bsp.vertices.len(),
            num_brushes: bsp.brushes.len(),
            num_static_props,
            packed_files,
        }
    }

    fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(self).map_err(|e| to_js_err(e, "序列化 BSP 元数据失败"))
    }
}

// ---------------------------------------------------------------------------
// 处理器（持有 Bsp 实例，可重复导出 / 提取）
// ---------------------------------------------------------------------------

/// BSP 处理器：先调用 [`BspProcessor::new`] 解析字节数组，再调用各导出方法。
///
/// 注意：`export_glb_with_pakfile_models` 会**消费**内部 Bsp 实例，须在
/// 其余借用方法（spawn 等）之后调用。
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

    /// 提取出生点实体（info_player_start / info_player_terrorist / info_player_counterterrorist 等）。
    ///
    /// 返回 JSON：`{ "spawn_points": [{ classname, origin: [x,y,z], angles: [p,y,r],
    /// origin_raw, angles_raw }], "total": N, "primary": 0 }`。
    /// `primary` 为推荐出生点索引（优先 info_player_start）。
    ///
    /// **坐标转换**：BSP Z-up → Y-up（`[x,y,z]→[y,z,x]`，det=+1）。
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

        // 坐标旋转 [x,y,z]→[y,z,x]（det=+1，正交变换，BSP Z-up → Y-up）
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

    /// 导出为 GLB，并将 **PAKFILE 打包的模型**（.mdl/.vvd/.dx90.vtx 字节）直接合并进同一地图。
    ///
    /// 流程：收集 `static_props` 引用的模型路径 → 枚举 PAKFILE 提取三件套字节 →
    /// 从 `static_props` 派生位置/朝向 → 调 [`bsp_to_gltf_core::export_bsp_with_models`] 合并导出。
    /// 若 BSP 未打包任何被引用模型，**自动回退为纯地图导出**，不报错、不降级。
    ///
    /// 注意：此操作会**消耗**内部 Bsp 实例，须在其余借用方法（spawn 等）**之后**调用。
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
        let materials = resolve_pakfile_materials(&bsp, &models, &index);

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
}
