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

use model_integrator::{
    ExportOptions, InMemoryModel, InMemoryResources, ModelIntegrator, StaticProp,
};

// 解析层：本工程内的隔离副本 crates/wasm-core（仓库根 src/wasm-core/ 的逐字节副本，
// websurf-wasm-core 0.1.0-fork；Cargo 包名与 Rust crate 名均不变）。副本化的授权、范围与
// 回并路径见 documents/game/implementation/lighting-merge-plan.md §9.1 与 §6.2。
use websurf_wasm_core::{bsp_to_gltf_core, model_integrator, pakfile_models, phyfile, texture_utils, vbsp};

// 物理系统：仍共享仓库根 src/（websurf-phys crate，原 game/crates/wasm/src/phys/ 已迁出）——
// 本轮未副本化，保持指向根部同一份。
pub use websurf_phys::phys::PhysWorld;

// 诊断探针：仅在 `cargo test` 下编译，复刻 export_model_colliders 管线 dump 中间产物。

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

/// 原始三角网格碰撞的路径预算（三角数上限）；超出回退 OBB 粗碰撞。
///
/// 不做共面合并后每个三角生成一个 brush，故用三角数卡护栏（比面数预算大得多）。
#[derive(Default)]
struct PakMaterials {
    /// `材质名 → PNG 字节`。键须与 `vmdl::TextureInfo::name` 逐字符一致，供 `push_texture` 查表。
    textures: HashMap<String, Vec<u8>>,
    /// `材质名 → alpha_mode`（0 = Opaque，1 = Blend，2 = Mask）。
    alpha_modes: HashMap<String, u8>,
    /// 自发光 / 无光照材质名集合（`$selfillum` / `UnlitGeneric`）。
    unlit: std::collections::HashSet<String>,
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
    //    顺手把 prop_static 的**逐顶点预烘焙光照**（`sp_<idx>.vhv` / `sp_hdr_<idx>.vhv`）读出来：
    //    它是 Source 的第 1 级 prop 光照来源（见 `wasm_core::vhv`），与条目枚举共用同一遍扫描。
    let zip = bsp.pack.clone().into_zip();
    let mut zip_guard = zip
        .lock()
        .map_err(|e| JsValue::from_str(&format!("pakfile 锁定失败: {e}")))?;
    let mut entry_names: Vec<String> = Vec::with_capacity(zip_guard.len());
    let mut vhv_blobs: std::collections::HashMap<usize, Vec<u8>> = std::collections::HashMap::new();
    for i in 0..zip_guard.len() {
        if let Ok(mut entry) = zip_guard.by_index(i) {
            let name = entry.name().to_string();
            let lower = name.to_ascii_lowercase();
            // 只收 sp_<数字>.vhv（HDR 版优先，见下面择一）
            if lower.starts_with("sp_") && lower.ends_with(".vhv") {
                let mid = &lower[3..lower.len() - 4];
                let (idx_part, is_hdr) = match mid.strip_prefix("hdr_") {
                    Some(rest) => (rest, true),
                    None => (mid, false),
                };
                if let Ok(idx) = idx_part.parse::<usize>() {
                    let mut buf = Vec::with_capacity(entry.size() as usize);
                    if std::io::Read::read_to_end(&mut entry, &mut buf).is_ok() && !buf.is_empty() {
                        // HDR 版覆盖 LDR 版（与 lightmap/ambient 的择一口径一致）
                        if is_hdr || !vhv_blobs.contains_key(&idx) {
                            vhv_blobs.insert(idx, buf);
                        }
                    }
                }
            }
            entry_names.push(name);
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
    //    逐实例挂上第 1 级逐顶点光照（`sp_<idx>.vhv`）；解析失败/缺失则留 None 回退 cube。
    let mut vhv_ok = 0usize;
    let mut vhv_bad = 0usize;
    let static_props: Vec<StaticProp> = bsp
        .static_props()
        .enumerate()
        .map(|(i, prop)| {
            let vertex_lighting =
                match vhv_blobs.get(&i).and_then(|b| websurf_wasm_core::vhv::parse_vhv(b)) {
                Some(v) => {
                    vhv_ok += 1;
                    Some(v.colors)
                }
                None => {
                    if vhv_blobs.contains_key(&i) {
                        vhv_bad += 1;
                    }
                    None
                }
            };
            StaticProp {
                model: prop.model().to_string(),
                origin: [prop.origin.x, prop.origin.y, prop.origin.z],
                angles: prop.angles(),
                solid: prop.solid as u8,
                ambient_cube: bsp.prop_ambient_cube(i),
                vertex_lighting,
            }
        })
        .collect();
    eprintln!(
        "[vhv] prop 逐顶点预烘焙光照：pakfile 命中 {} 个文件，解析成功 {} 个，解析失败 {} 个，共 {} 个 prop",
        vhv_blobs.len(),
        vhv_ok,
        vhv_bad,
        static_props.len()
    );

    Ok((models, static_props, entry_names))
}

/// BSP 光照实体（`light` / `light_spot` / `light_environment`）→ [`model_integrator::Entity`]。
///
/// 只提取光照解析所需的属性子集（origin/angles/_light/_cone/衰减/pitch），
/// 后续交给 [`ModelIntegrator`] 的 KHR_lights_punctual 管线（颜色/亮度/范围/锥角/方向）。
fn collect_light_entities(bsp: &vbsp::Bsp) -> Vec<model_integrator::Entity> {
    const LIGHT_CLASSNAMES: &[&str] = &["light", "light_spot", "light_environment"];
    let mut out = Vec::new();
    for ent in bsp.entities.iter() {
        let Ok(classname) = ent.prop("classname") else {
            continue;
        };
        if !LIGHT_CLASSNAMES.contains(&classname) {
            continue;
        }
        let prop = |key: &'static str| ent.prop(key).ok().map(|s| s.to_string());
        out.push(model_integrator::Entity {
            properties: model_integrator::EntityProperties {
                classname: classname.to_string(),
                model: prop("model"),
                origin: prop("origin"),
                angles: prop("angles"),
                scale: prop("scale"),
                light: prop("_light"),
                cone: prop("_cone"),
                inner_cone: prop("_inner_cone"),
                constant_attn: prop("_constant_attn"),
                linear_attn: prop("_linear_attn"),
                quadratic_attn: prop("_quadratic_attn"),
                pitch: prop("pitch"),
            },
        });
    }
    out
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

/// 解压默认配置纹理包（textures.mtz，MTZ5/6 容器）→ textures.json 文本。
/// 纹理键 = `materials/xxx`（与 basetexture 一致），供缺失纹理回退/比对。
#[wasm_bindgen]
pub fn decompress_mtz(bytes: &[u8]) -> Result<String, JsValue> {
    websurf_wasm_core::mosaic::mtz::decompress_mtz(bytes)
        .map_err(|e| JsValue::from_str(&format!("decompress_mtz: {e}")))
}

/// 加载内存中的模型三件套为 `vmdl::Model`（任一环节失败即返回 `None`）。
fn load_vmdl(m: &InMemoryModel) -> Option<vmdl::Model> {
    let mdl = vmdl::Mdl::read(&m.mdl).ok()?;
    let vtx = vmdl::Vtx::read(&m.vtx).ok()?;
    let vvd = vmdl::Vvd::read(&m.vvd).ok()?;
    Some(vmdl::Model::from_parts(mdl, vtx, vvd))
}




/// 从 PAKFILE 条目名构建 VMT **基名索引**：`基名小写` → `materials/` 前缀去 `.vmt` 的路径
/// （保留条目原始大小写，因为 `Packfile::get` 按名精确匹配）。
///
/// 用途见 `ConvertOptions::vmt_stem_index`：世界面的贴图名来自 BSP texinfo
/// （`METAL/METALGRATE013A2`），精确路径不在包内时，作者**同一基名**的 VMT 是唯一的权威
/// `$basetexture`/`$translucent`/`$alphatest` 来源。实测 surf_666：68 种世界贴图里 14 种
/// （8400 面）只有基名命中，其中 13 种的 `$basetexture` 与材质名逐字符相同（作者对同一张贴图的重写）。
///
/// 同名多条时取**路径最短**者：`666/x.vmt` 优先于 `models/props/generated_prop/x.vmt`。
fn build_vmt_stem_index(entry_names: &[String]) -> std::collections::HashMap<String, String> {
    let mut out: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for name in entry_names {
        let norm = name.replace('\\', "/");
        let lower = norm.to_ascii_lowercase();
        if !lower.starts_with("materials/") || !lower.ends_with(".vmt") {
            continue;
        }
        let path = &norm["materials/".len()..norm.len() - ".vmt".len()];
        let stem = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
        match out.get(&stem) {
            Some(prev) if prev.len() <= path.len() => {}
            _ => {
                out.insert(stem, path.to_string());
            }
        }
    }
    out
}

/// 解析所有被引用模型的材质：从 PAKFILE 取 `.vmt` 得透明度标注，再按 `$basetexture` 取 `.vtf` 解码为 PNG。
///
/// `decode_textures = false` 时只解析标注、跳过图像解码（碰撞体路径用此模式）。
///
/// 材质路径解析顺序：`TextureInfo::search_paths` → `Mdl::texture_paths` → 裸材质名，
/// 均交 [`pakfile_models::PakIndex`] 做大小写不敏感 + `materials/` 前缀补全匹配。
///
/// `fallback` = 默认纹理包（`textures.mtz` 解压产物）：pakfile 内没有该 VTF（stock 贴图未打包）时
/// 按 **`$basetexture` 路径**查包（键是源资源路径，不是材质名），把低清纹理（含 alpha 镂空）交给
/// `ModelIntegrator`。`None`（碰撞体 / mosaic manifest 路径）保持历史行为：无 pakfile VTF 即无贴图。
fn resolve_pakfile_materials(
    bsp: &vbsp::Bsp,
    models: &[InMemoryModel],
    index: &pakfile_models::PakIndex,
    decode_textures: bool,
    fallback: Option<&std::collections::HashMap<String, String>>,
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
            if info.unlit {
                out.unlit.insert(tex.name.clone());
            }

            if !decode_textures {
                continue;
            }
            let Some(base) = info.basetexture else {
                continue;
            };
            // ① pakfile 内的 VTF（原始分辨率）
            if let Some(vtf_entry) = index.find(&base, "vtf") {
                if let Ok(Some(vtf_bytes)) = bsp.pack.get(vtf_entry) {
                    if let Ok(png) = decode_vtf_to_png(&vtf_bytes) {
                        out.textures.insert(tex.name.clone(), png);
                        continue;
                    }
                }
            }
            // ② pakfile 内没有这张 VTF（stock 贴图未打包）→ 查默认纹理包。
            //    键必须是 **`$basetexture` 路径**而不是材质名：模型材质名常年是裸基名
            //    （`metalfence007a`），包里的键是源资源路径（`materials/metal/metalfence007a`）
            //    ——实测铁丝网 prop 正因此拿不到贴图（含 17.6% alpha 镂空的铁网全部丢失）。
            if let Some(fallback) = fallback {
                if let Some(png) = websurf_wasm_core::bsp_to_gltf_core::fallback_texture_png(
                    fallback,
                    &[base.as_str(), tex.name.as_str()],
                    8,
                ) {
                    out.textures.insert(tex.name.clone(), png);
                }
            }
        }
    }

    out
}

// ---------------------------------------------------------------------------
// 全局初始化
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 处理器（持有 Bsp 实例，可重复导出 / 提取）
// ---------------------------------------------------------------------------

/// BSP 处理器：先调用 [`BspProcessor::new`] 解析字节数组，再调用
/// [`BspProcessor::export_glb`] 导出 GLB，或 [`BspProcessor::metadata`]
/// 获取元数据。
///
/// **生命周期契约（契约 §3.1 ④）**：`bsp` 是 `Option<Arc<Bsp>>`。导出入口把 `Arc` 的引用计数
/// **交出去但保留自己那一份**——于是「成功后再导出」与「失败后再导出」都不报「已被导出消费」，
/// 真正的失败原因（光照图集打包、面表口径…）不会被误导性的「已消费 / 请重新 new」覆盖，
/// 且失败不会毒化实例状态（借用类接口继续可用）。导出链路内部只读 `&Bsp`（见 `convert.rs`）。
#[wasm_bindgen]
pub struct BspProcessor {
    bsp: Option<std::sync::Arc<vbsp::Bsp>>,
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
            bsp: Some(std::sync::Arc::new(bsp)),
            packed_files,
        })
    }

    /// 取出可移交的 `Arc<Bsp>` 句柄（**不**清空 `self.bsp`）。
    ///
    /// 命名沿用「take」，语义是**借用式移交**：调用方拿到一份引用计数，处理器仍持有原句柄
    /// ⇒ 导出失败不消费、成功后可再次调用（见类型级文档）。真正的「未解析」只有一种情况：
    /// 构造函数失败（`BspProcessor::new` 抛错时根本没有实例）——故这里的文本不再宣称「已消费」。
    fn take_bsp(&self) -> Result<std::sync::Arc<vbsp::Bsp>, JsValue> {
        self.bsp
            .as_ref()
            .map(std::sync::Arc::clone)
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))
    }

    /// 获取元数据 JSON 字符串（不消耗内部 Bsp 实例）。
    pub fn metadata(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
        let metadata = BspMetadata::from_bsp(bsp, self.packed_files);
        metadata.to_json()
    }

    /// 导出为 GLB 字节数组。
    ///
    /// **导出借用内部 Bsp**（`take_bsp()` 交出的是 `Arc<Bsp>` 克隆），**成功与失败均不消费实例**；
    /// 实例在整个处理器生命周期内保持可用，可重复导出且字节一致。`export_bsp` 收到 `Arc<Bsp>`
    /// 后只读 `&Bsp`。真正的「未解析」只有一种情形：`BspProcessor::new` 失败时根本没有实例。
    pub fn export_glb(&mut self) -> Result<Vec<u8>, JsValue> {
        let bsp = self.take_bsp()?;

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

    /// 导出 GLB（含 PAKFILE 模型）+ **缺失纹理回退**：`defaults_json` 为默认纹理包
    /// （`{ "materials/<材质路径小写>": "#mosaic v4 字节码" }`），材质缺失时直接在
    /// 导出期解码低清纹理嵌入 GLB——渲染端拿到的即自包含场景，零后期处理。
    ///
    /// 与 [`BspProcessor::export_glb_with_pakfile_models`] 同流程，仅注入回退表。
    ///
    /// **失败不消费**：`Arc<Bsp>` 为借用式移交，导出失败（例如光照图集打包面积装不下任何允许
    /// 单页形状）时 `self.bsp` 仍为 `Some` ⇒ 同一实例可再次导出并报同一根因，借用类接口
    /// （`metadata()` / `parse_spawn_points()` / `export_brushes_planes(…)` …）继续可用。
    pub fn export_glb_with_pakfile_models_with_defaults(
        &mut self,
        defaults_json: &str,
    ) -> Result<Vec<u8>, JsValue> {
        self.export_glb_with_defaults_opts(defaults_json, 0, false)
    }

    /// [`BspProcessor::export_glb_with_pakfile_models_with_defaults`] 的**阈值可覆盖**变体。
    ///
    /// `lightmap_max_atlas_area`：> 0 时覆盖单页图集面积上界（px），0 = 政策上界（4096×2048）。
    /// **仅供 fail-visible 负控**（契约 `documents/game/implementation/console-fix-contract.md` §4.3）：
    /// 政策上界下「装不下」不可由真实语料触发（容量守卫 + 单面 256 上界 ⇒ packedArea ≤ 7.32M < 8.39M），
    /// 但该失败路径必须能被可红断言覆盖。它只改判定阈值，不改打包/落位/UV/像素口径。
    pub fn export_glb_with_pakfile_models_with_defaults_and_atlas_limit(
        &mut self,
        defaults_json: &str,
        lightmap_max_atlas_area: f64,
    ) -> Result<Vec<u8>, JsValue> {
        // f64 而非 u64：wasm-bindgen 的 u64 形参要求 JS 传 BigInt，测试侧传普通 number 会报
        // 「Cannot convert … to a BigInt」；这里收 f64 再校验/取整，接口对 JS 更直白。
        let area = if lightmap_max_atlas_area.is_finite() && lightmap_max_atlas_area > 0.0 {
            lightmap_max_atlas_area as u64
        } else {
            0
        };
        self.export_glb_with_defaults_opts(defaults_json, area, false)
    }

    /// 导出 GLB（含 PAKFILE 模型 + **默认纹理回退** + **BSP 光照**）。
    ///
    /// 组合入口：[`BspProcessor::export_glb_with_pakfile_models_with_defaults`] 的
    /// 缺失纹理回退表 + [`BspProcessor::export_glb_with_pakfile_models_with_lights`]
    /// 的 `light`/`light_spot`/`light_environment` → `KHR_lights_punctual` 导出。
    /// 此前二者互斥（一个收 defaults 不收 lights、一个收 lights 不收 defaults），
    /// `world-builder` 只能调 `_with_defaults` ⇒ GLB 从未携带灯光。
    ///
    /// 无模型时与 `_with_lights` 同语义：仍走 integrator 路径（空模型无副作用，
    /// 光照注入照常发生）。**导出借用内部 Bsp**，成功与失败均不消费实例。
    pub fn export_glb_with_pakfile_models_with_defaults_and_lights(
        &mut self,
        defaults_json: &str,
    ) -> Result<Vec<u8>, JsValue> {
        self.export_glb_with_defaults_opts(defaults_json, 0, true)
    }

    fn export_glb_with_defaults_opts(
        &mut self,
        defaults_json: &str,
        lightmap_max_atlas_area: u64,
        include_lights: bool,
    ) -> Result<Vec<u8>, JsValue> {
        let bsp = self.take_bsp()?;
        let fallback: std::collections::HashMap<String, String> =
            serde_json::from_str(defaults_json).map_err(|e| to_js_err(e, "默认纹理包 JSON 解析失败"))?;

        let (models, static_props, entry_names) = collect_pakfile_models(&bsp)?;

        // 世界面材质的**基名 VMT 回退**索引（见 `ConvertOptions::vmt_stem_index`）：
        // texinfo 名 `METAL/METALGRATE013A2` 的精确 VMT 不在包内时，作者同一基名的
        // `materials/666/metalgrate013a2.vmt` 提供权威 `$basetexture`/`$translucent`。
        let stem_index = build_vmt_stem_index(&entry_names);

        let options = |generate_missing_list: bool| bsp_to_gltf_core::ConvertOptions {
            missing_fallback: fallback.clone(),
            vmt_stem_index: stem_index.clone(),
            generate_missing_list,
            lightmap_max_atlas_area,
            ..bsp_to_gltf_core::ConvertOptions::default()
        };

        // 无模型时：include_lights=false 保持历史纯 export_bsp 路径（行为不变）；
        // include_lights=true 走 integrator 路径（与 _with_lights 语义一致）。
        if models.is_empty() && !include_lights {
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
        let materials = resolve_pakfile_materials(&bsp, &models, &index, true, Some(&fallback));
        let resources = InMemoryResources {
            models,
            entities: Vec::new(),
            static_props,
            textures: materials.textures,
            material_alpha_mode: materials.alpha_modes,
            material_unlit: materials.unlit,
            light_entities: if include_lights {
                collect_light_entities(&bsp)
            } else {
                Vec::new()
            },
        };
        let integrator = ModelIntegrator::from_in_memory(resources, ExportOptions { include_lights });
        let result = bsp_to_gltf_core::export_bsp_with_models(bsp, options(true), Some(&integrator))
            .map_err(|e| to_js_err(e, "GLB 导出失败"))?;
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
    /// **导出借用内部 Bsp**（`Arc<Bsp>` 克隆），成功与失败均不消费实例；
    /// 实例可重复导出且字节一致（见 [`BspProcessor::export_glb_with_pakfile_models_with_defaults`]）。
    pub fn export_glb_with_pakfile_models(&mut self) -> Result<Vec<u8>, JsValue> {
        let bsp = self.take_bsp()?;

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
        let materials = resolve_pakfile_materials(&bsp, &models, &index, true, None);

        let resources = InMemoryResources {
            models,
            entities: Vec::new(),
            static_props,
            textures: materials.textures,
            material_alpha_mode: materials.alpha_modes,
            material_unlit: materials.unlit,
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

    /// 导出 GLB（含 PAKFILE 模型 + **BSP 光照**）。
    ///
    /// 在 [`BspProcessor::export_glb_with_pakfile_models`] 基础上，把 BSP 实体中的
    /// `light` / `light_spot` / `light_environment` 解析为 `KHR_lights_punctual` 扩展
    /// 写入 GLB（光源节点 + lights 定义；three.js GLTFLoader 原生解析为
    /// PointLight / SpotLight / DirectionalLight）。无模型时仍走 integrator 路径
    /// （`add_models_to_gltf` 空模型无副作用，光照注入照常发生）。
    ///
    /// **导出借用内部 Bsp**（`Arc<Bsp>` 克隆），成功与失败均不消费实例
    /// （与其它 `export_glb*` 入口一致；实例可重复导出且字节一致）。
    pub fn export_glb_with_pakfile_models_with_lights(&mut self) -> Result<Vec<u8>, JsValue> {
        let bsp = self.take_bsp()?;

        let (models, static_props, entry_names) = collect_pakfile_models(&bsp)?;

        // 解析 PAKFILE 内的 VMT/VTF：贴图字节 + 内置透明度标注
        let index = pakfile_models::PakIndex::build(&entry_names);
        let materials = resolve_pakfile_materials(&bsp, &models, &index, true, None);

        let resources = InMemoryResources {
            models,
            entities: Vec::new(),
            static_props,
            textures: materials.textures,
            material_alpha_mode: materials.alpha_modes,
            material_unlit: materials.unlit,
            light_entities: collect_light_entities(&bsp),
        };

        let integrator = ModelIntegrator::from_in_memory(
            resources,
            ExportOptions {
                include_lights: true,
            },
        );
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

    /// 导出 **PAKFILE 内嵌模型**的碰撞体，输出与
    /// [`BspProcessor::export_brushes_planes`] **同构**的 `WasmBrush[]` JSON 数组。
    ///
    /// 前端将其与地图 brush JSON 合并交给 `adaptBrushes` 即可，无新增数据契约。
    ///
    /// # 与显示几何一致
    ///
    /// 显示与碰撞共用同一条顶点变换链 `map_coords(model.apply_root_transform(v))` → `scale` → `quat` → `translation`，
    /// `quat`/`translation` 来自与 GLB 节点同一份 [`model_integrator::resolve_placements`]，无「看得到摸不着」偏移。
    ///
    /// 几何为「原始三角网格 → 逐三角沿法线反向挤出薄壳」，逐面贴合显示网格（surf 图 ramp 坡的硬要求）。
    /// 不做共面合并（会把薄斜坡变成 quad + filler 面，致碰撞外观与显示不一致）。
    /// 三角数超预算（`MAX_MODEL_TRIS`）时回退 OBB 粗碰撞，避免高模装饰件拖垮 `traceBox` 线性 broadphase。
    ///
    /// # 透明度门控（没有标注就默认有碰撞）
    ///
    /// Source 的透明度标注全部写在 `.vmt` 里，据此逐 mesh 判定：
    ///
    /// | 情形 | 判定 |
    /// |---|---|
    /// | `$translucent 1` / `$alpha < 1` | 真半透明 → **跳过碰撞** |
    /// | `$alphatest 1`（铁丝网/栅栏镂空） | Source 中本是实体 → **保留碰撞** |
    /// | VMT 未打包 / 无任何标注 | 按不透明 → **保留碰撞** |
    /// | `static_prop.solid == 0`（`SOLID_NONE`） | 引擎级明确无碰撞 → **跳过** |
    ///
    /// # 调用时机
    ///
    /// 只**借用** BSP；导出入口（`export_glb*`）也只借用式移交 `Arc` ⇒ 本方法在导出前后都可调用。
    pub fn export_model_tri_colliders(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;

        let (models, static_props, entry_names) = collect_pakfile_models(bsp)?;
        if models.is_empty() {
            return Ok("[]".to_string());
        }

        let index = pakfile_models::PakIndex::build(&entry_names);
        let materials = resolve_pakfile_materials(bsp, &models, &index, false, None);

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
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;

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

    /// 检查 BSP 是否仍持有（导出走借用式移交 ⇒ 除构造失败外恒为 true）。
    pub fn is_alive(&self) -> bool {
        self.bsp.is_some()
    }

    /// 生成纹理画质 manifest：`{ 纹理名(小写 VMT 路径): mosaic v4 字节码 }` JSON。
    ///
    /// 前端画质切换（原始/压缩低清）用：导出前后均可调用（`export_glb*` 只借用式移交 BSP），
    /// 切换画质时用 `mosaic_decode` 还原低清 PNG 替换贴图，无需重载地图。
    ///
    /// 覆盖两类纹理（与 GLB texture.name 对应）：
    /// 1. 地图 face 纹理（key = basetexture 小写，如 "materials/xxx"）
    /// 2. PAKFILE 模型贴图（key = 材质名小写，如 "maplebark"——修复 prop 墙面未压缩）
    pub fn export_mosaic_manifest(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
        let mut pairs = websurf_wasm_core::mosaic::manifest::build_mosaic_manifest(bsp);
        // 模型贴图（材质名 → PNG → mosaic）；失败静默跳过（不影响地图纹理覆盖）
        if let Ok((models, _props, entry_names)) = collect_pakfile_models(bsp) {
            let index = pakfile_models::PakIndex::build(&entry_names);
            let materials = resolve_pakfile_materials(bsp, &models, &index, true, None);
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
    /// 前端加载后与默认配置纹理包（textures.mtz 解压的键集合）比对；
    /// 可覆盖的已在 GLB 导出期自动回退（见
    /// [`BspProcessor::export_glb_with_pakfile_models_with_defaults`]）。
    pub fn export_missing_textures(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
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
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;

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
    pub fn parse_teleports(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;

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
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;

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
    pub fn export_brushes_planes(&self, filter_json: &str) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;

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
        // ⑤ 跳过计数的**分支分解**（契约 §3.1 ⑤）：单一 `skipped` 计数器无法自证，
        // 故逐分支计数并保证「各分支之和 == skipped」，让「跳过是否预期」可核验。
        // 三个具名分支 = 契约要求的 sky / nonPlayerSolid / planesLt4：
        //   - 非玩家固体（既非 SOLID 族亦非 LADDER 的标志，或实体类名判定为无碰撞）
        //   - SKY（MASK 命中 SKY|SKY2D）后被 `filter.skip_sky` 剔除
        //   - 剔除 bevel 后平面数 < 4（`planesLt4`）
        // 其余分支（调用方 filter 决定的两条 + nodraw/顶点/体积/上限截断）同样必须计数，
        // 否则 `Σ分支 == skipped` 不闭合，分解就失去意义。
        let mut skipped_non_player_solid = 0usize;
        let mut skipped_sky = 0usize;
        let mut skipped_planes_lt4 = 0usize;
        let mut skipped_ladder_excluded = 0usize;
        let mut skipped_solid_excluded = 0usize;
        let mut skipped_nodraw = 0usize;
        let mut skipped_verts_lt4 = 0usize;
        let mut skipped_volume = 0usize;
        let mut skipped_early_exit = 0usize;
        // bevel 侧被剔除的总数（仅作诊断：它是**侧**级而非 brush 级，故不进 `skipped` 分解）
        let mut bevel_sides_dropped = 0usize;
        /// 单分支跳过计数：`skipped` 与具名分支**同时**自增，避免两处手写不一致。
        macro_rules! skip_branch {
            ($branch:ident) => {{
                skipped += 1;
                $branch += 1;
                continue;
            }};
        }
        // 【修复】brush → 模型 world origin 映射（实体 brush 局部坐标 → 世界坐标）
        let brush_model_origins = build_brush_model_origins(bsp);
        // 【修复】无碰撞实体（trigger_* / func_illusionary 等）的 brush 不导出为碰撞体，
        // 否则玩家会在触发区域踩到透明空气墙（用户实测）。
        let brush_models = brush_model_indices(bsp);
        let model_classes = model_classnames(bsp);

        for (brush_idx, brush) in bsp.brushes.iter().enumerate() {
            if brushes_out.len() >= MAX_BRUSHES {
                // 早退（MAX_BRUSHES 上限截断）：同样计入分解，保证 total == exported + Σ分支
                skipped_early_exit = bsp.brushes.len() - brush_idx;
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
                skip_branch!(skipped_non_player_solid);
            }
            // 无碰撞实体 brush 过滤：trigger_* / func_illusionary 等不产生碰撞体
            if let Some(mi) = brush_models.get(brush_idx).copied().flatten() {
                if let Some(cls) = model_classes.get(mi).and_then(|c| c.as_deref()) {
                    if entity_is_non_solid(cls) {
                        skip_branch!(skipped_non_player_solid);
                    }
                }
            }
            if !filter.include_ladder && is_ladder {
                skip_branch!(skipped_ladder_excluded);
            }
            if !filter.include_solid && is_solid {
                skip_branch!(skipped_solid_excluded);
            }

            // 单次遍历 brush_sides 收集平面引用 + sky/nodraw 标志；
            // 数组访问用 .get() 防 panic 破坏 wasm-bindgen 借用状态
            let mut bsp_planes: Vec<&Plane> = Vec::new();
            let mut is_sky = false;
            let mut is_nodraw = false;
            let start = brush.brush_side as usize;
            let count = brush.num_brush_sides as usize;
            for i in 0..count {
                let Some(side) = bsp.brush_sides.get(start + i) else {
                    continue;
                };
                // 【遗弃 BSP bevel】剔除高悬 bevel 面（详见 debug/crates/wasm export_brushes_planes 说明）
                if side.bevel != 0 {
                    bevel_sides_dropped += 1;
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
                skip_branch!(skipped_sky);
            }
            if filter.skip_nodraw && is_nodraw {
                skip_branch!(skipped_nodraw);
            }
            if bsp_planes.len() < 4 {
                skip_branch!(skipped_planes_lt4);
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
                skip_branch!(skipped_verts_lt4);
            }

            // 体积过滤（基于 AABB 体积估算）
            if filter.min_brush_volume > 0.0 {
                let vol = aabb_volume(&verts_bsp);
                if vol < filter.min_brush_volume {
                    skip_branch!(skipped_volume);
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

            // =========================================================================
            // 运行时棱边 chamfer(AddEdgeBevels 简化版) —— 替代被遗弃的 BSP bevel
            // 与 debug/crates/wasm export_brushes_planes 完全同构。
            // 对每条真实凸棱生成微小外切角平面：法线 = 两相邻面法线均值归一化，
            // 并校验所有其它凸包顶点都在其外侧（不会挤压凸包、不破坏可站性）。
            // =========================================================================
            let mut chamfer_planes: Vec<Plane> = Vec::new();
            {
                let eps_plane = 0.1f32;
                let n_planes = bsp_plane_refs.len();
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
                        let ndot = ni[0] * nj[0] + ni[1] * nj[1] + ni[2] * nj[2];
                        if ndot.abs() > 0.999 {
                            continue; // 共面/平行，无真实棱
                        }
                        let mut shared: Vec<usize> = Vec::new();
                        for (vi, on) in vert_planes.iter().enumerate() {
                            if on.contains(&i) && on.contains(&j) {
                                shared.push(vi);
                            }
                        }
                        if shared.len() < 2 {
                            continue;
                        }
                        let mut nch = [ni[0] + nj[0], ni[1] + nj[1], ni[2] + nj[2]];
                        let len = (nch[0] * nch[0] + nch[1] * nch[1] + nch[2] * nch[2]).sqrt();
                        if len < 1e-6 {
                            continue;
                        }
                        nch = [nch[0] / len, nch[1] / len, nch[2] / len];
                        let anchor = &verts_bsp[shared[0]];
                        let dist = nch[0] * anchor[0] + nch[1] * anchor[1] + nch[2] * anchor[2];
                        let mut first_side: Option<f32> = None;
                        let mut valid = true;
                        for (vi0, v) in verts_bsp.iter().enumerate() {
                            if shared.contains(&vi0) {
                                continue;
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
                        let radj = first_side.unwrap_or(1.0);
                        let nch_final = if radj > 0.0 { nch } else { [-nch[0], -nch[1], -nch[2]] };
                        let dist_final =
                            nch_final[0] * anchor[0] + nch_final[1] * anchor[1] + nch_final[2] * anchor[2];
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
            // 合并真实面 + chamfer（先取 flipped 或 bsp 平面，统一与 chamfer 一起序列化）
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

            // 旋转平面法线到 Y-up，并翻转法线方向（vbsp 内部约定 → cs-movement 约定）。
            //
            // **法线方向转换（关键修复）**：vbsp 读取的平面为"法线朝内"约定
            // （内部在正侧 `dot(n,p)-dist >= 0`，`compute_vertices` 的 `d < -1.0` 检查与此一致）；
            // cs-movement 的 `traceBox` / `brushFromAABB` 用"法线朝外"（内部在负侧，`d1>0` 表示起点在外）。
            // 直接导出会导致 cs-movement 误判内外，`traceBox` 永远返回 `fraction=1`（玩家穿透）。
            //
            // 修复：对每平面取负 `normal` 与 `dist`（`dot(-n,p)-(-dist) = -(dot(n,p)-dist)`，
            // 内部点 d>=0 → d<=0，等价翻转半空间）。先旋转到 Y-up 再取负（二者可交换）。
            // 统一从 all_planes_src（真实面 + 运行时 chamfer）构建，chamfer 一并输出
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

        // ⑤ 跳过计数自证（契约 §3.1 ⑤）：单一 `skipped` 无法核验，故附**分支分解**。
        // 判据（任一本地地图都必须成立）：`sky + nonPlayerSolid + planesLt4 + ladderExcluded
        // + solidExcluded + nodraw + vertsLt4 + volume + earlyExit == skipped` 且
        // `exported + skipped == total`。过滤语义本轮**未改**（只让计数自证）。
        let breakdown_sum = skipped_sky
            + skipped_non_player_solid
            + skipped_planes_lt4
            + skipped_ladder_excluded
            + skipped_solid_excluded
            + skipped_nodraw
            + skipped_verts_lt4
            + skipped_volume
            + skipped_early_exit;
        web_sys::console::log_1(
            &format!(
                "[BrushPlanes] total={}, exported={}, skipped={}, sky={}, nonPlayerSolid={}, \
                 planesLt4={}, ladderExcluded={}, solidExcluded={}, nodraw={}, vertsLt4={}, \
                 volume={}, earlyExit={}, breakdownSum={}, bevelSidesDropped={}, cover={}",
                bsp.brushes.len(),
                brushes_out.len(),
                skipped,
                skipped_sky,
                skipped_non_player_solid,
                skipped_planes_lt4,
                skipped_ladder_excluded,
                skipped_solid_excluded,
                skipped_nodraw,
                skipped_verts_lt4,
                skipped_volume,
                skipped_early_exit,
                breakdown_sum,
                bevel_sides_dropped,
                if breakdown_sum == skipped && brushes_out.len() + skipped == bsp.brushes.len() {
                    "ok"
                } else {
                    "MISMATCH"
                }
            )
            .into(),
        );

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