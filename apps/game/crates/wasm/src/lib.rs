//! `websurf-wasm`：把 BSP 解析、GLB 导出与纹理解码能力暴露给 JavaScript 的 wasm-bindgen 入口。
//!
//! 导出面（`#[wasm_bindgen]` 标注项）：
//! - [`BspProcessor`]：持有已解析的 `Arc<vbsp::Bsp>`，逐方法产出元数据 JSON / GLB 字节 / 碰撞体 JSON；
//!   构造与取用失败的报错文本由 `to_js_err` 或就地 `format!` 拼成。
//! - [`mosaic_encode`] / [`mosaic_decode`] / [`decompress_mtz`]：马赛克图与 MTZ 字节码的独立函数，
//!   不依赖 [`BspProcessor`] 实例。
//!
//! 内部辅助（非导出）：
//! - `decode_vtf_to_png`：VTF 字节 → PNG 字节，由 `resolve_pakfile_materials` 在解析 PAKFILE 材质时调用；
//! - `collect_pakfile_models` / `collect_light_entities`：装配 [`ModelIntegrator`] 的输入。
//!
//! 依赖分层（见 `apps/game/crates/wasm/Cargo.toml` 的 path 依赖）：
//! - `websurf-wasm-core` = 仓库根 `src/wasm-core`，共享解析层，提供 `vbsp` / `bsp_to_gltf_core` /
//!   `model_integrator` / `pakfile_models` / `phyfile` / `texture_utils` 各模块；
//! - `websurf-phys` = 仓库根 `src`，共享物理层，其 `phys::PhysWorld` 由本 crate 转出。
//!
//! `apps/debug`、`apps/game`、`apps/viewer` 的 `crates/` 下各只有 `wasm` 一个 crate；解析层与物理层
//! 由三个工程共用同一份源码，本工程内不存在隔离副本。

use std::collections::HashMap;
use std::io::Cursor;

use wasm_bindgen::prelude::*;

use model_integrator::{
    ExportOptions, InMemoryModel, InMemoryResources, ModelIntegrator, StaticProp,
};

// 共享解析层：仓库根 src/wasm-core（Cargo 包名 websurf-wasm-core）。
// 注意 `model_integrator` 亦经此处引入 crate 根，上面的 `use model_integrator::{…}` 走同名条目。
use websurf_wasm_core::{bsp_to_gltf_core, model_integrator, pakfile_models, phyfile, texture_utils, vbsp};

// 共享物理层：仓库根 src（Cargo 包名 websurf-phys）；转出 PhysWorld 供 JS 直接构造物理世界。
pub use websurf_phys::phys::PhysWorld;

// ---------------------------------------------------------------------------
// 错误处理辅助
// ---------------------------------------------------------------------------

/// 把任意 `Debug` 错误拼成 `"{ctx}: {e:?}"` 文本的 [`JsValue`]，作为 JS 侧抛出的错误值。
fn to_js_err<E: std::fmt::Debug>(e: E, ctx: &str) -> JsValue {
    JsValue::from_str(&format!("{}: {:?}", ctx, e))
}

// ---------------------------------------------------------------------------
// PAKFILE 内嵌模型：三件套提取 / 材质解析 / 碰撞体参数
// ---------------------------------------------------------------------------

/// PAKFILE 材质解析的产出，由 `resolve_pakfile_materials` 填充，再逐字段转交
/// `InMemoryResources` 的 `textures` / `material_alpha_mode` / `material_unlit`。
#[derive(Default)]
struct PakMaterials {
    /// `材质名 → PNG 字节`。键取 `vmdl::TextureInfo::name`，消费端按同名查表。
    textures: HashMap<String, Vec<u8>>,
    /// `材质名 → alpha_mode`（1 = Blend 且双面，2 = Mask 且阈值 0.5，其余按 Opaque）。
    alpha_modes: HashMap<String, u8>,
    /// 自发光 / 无光照材质名集合（着色器名以 `unlit` 开头，或 `$selfillum` 取到非 `0` 的非空值）。
    unlit: std::collections::HashSet<String>,
}

/// 提取被 `static_props` 引用且 `.mdl/.vvd/.dx90.vtx` 三件齐全的模型，并装配静态道具放置表。
///
/// 返回 `(模型三件套, 静态道具放置表, PAKFILE 全部条目名)`；第三项供调用方交给
/// [`pakfile_models::PakIndex::build`]，无需为找材质再遍历一遍 zip。
fn collect_pakfile_models(
    bsp: &vbsp::Bsp,
) -> Result<(Vec<InMemoryModel>, Vec<StaticProp>, Vec<String>), JsValue> {
    // 1. 收集被静态道具引用的模型路径
    let mut referenced: std::collections::HashSet<String> = std::collections::HashSet::new();
    for prop in bsp.static_props() {
        referenced.insert(prop.model().to_string());
    }

    // 2. 枚举 PAKFILE 全部条目（整遍扫描共持有一把 zip 锁）
    //    同一遍里顺带取出 `sp_<idx>.vhv` / `sp_hdr_<idx>.vhv` 两个 blob：它们是 prop 的逐顶点
    //    预烘焙光照，解析器是共享层的 `websurf_wasm_core::vhv::parse_vhv`，产物落到
    //    `StaticProp::vertex_lighting`（与 `Bsp::prop_ambient_cube` 给出的 ambient cube 并列）。
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
            // 只收 sp_<数字>.vhv；sp_hdr_<数字>.vhv 去掉 hdr_ 前缀后与前者同属一个下标
            if lower.starts_with("sp_") && lower.ends_with(".vhv") {
                let mid = &lower[3..lower.len() - 4];
                let (idx_part, is_hdr) = match mid.strip_prefix("hdr_") {
                    Some(rest) => (rest, true),
                    None => (mid, false),
                };
                if let Ok(idx) = idx_part.parse::<usize>() {
                    let mut buf = Vec::with_capacity(entry.size() as usize);
                    if std::io::Read::read_to_end(&mut entry, &mut buf).is_ok() && !buf.is_empty() {
                        // 同一下标择一：HDR 版覆盖先到者，LDR 版不覆盖已存入的 HDR 版
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

    // 3. 只为被引用的模型提取三件套：按大小写不敏感判 .mdl，任一件取不到即跳过该模型
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

    // 4. static_props 放置表（GLB 节点与碰撞体共用同一份）
    //    逐实例挂上第 2 步取到的逐顶点光照；条目缺失或解析失败则留 None。
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

/// BSP 光照实体（classname ∈ `LIGHT_CLASSNAMES`）→ [`model_integrator::Entity`]。
///
/// 只搬运光照解析要用的属性子集：`model`/`origin`/`angles`/`scale` 与 `_light`/`_cone`/
/// `_inner_cone`/三个衰减系数/`pitch`；取不到的属性一律留成 `None`，`classname` 取不到则跳过该实体。
/// 消费端 [`ModelIntegrator`] 把这些实体写成 `KHR_lights_punctual` 扩展。
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



/// VTF 字节 → PNG 字节：取最高分辨率图的第 0 帧重新编码。未标 `#[wasm_bindgen]`，
/// 仅供本文件的 PAKFILE 材质解析调用。
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
// 纹理画质切换：转发共享解析层 src/wasm-core/mosaic 的马赛克编解码与 MTZ 解压
// ---------------------------------------------------------------------------

/// PNG 字节 → `#mosaic v4` 字节码文本；错误文本前缀 `mosaic_encode`。
#[wasm_bindgen]
pub fn mosaic_encode(png: &[u8], name: &str) -> Result<String, JsValue> {
    websurf_wasm_core::mosaic::encode::img_to_code(png, name)
        .map_err(|e| JsValue::from_str(&format!("mosaic_encode: {e}")))
}

/// `#mosaic v4` 字节码 → PNG 字节；`scale` 是最近邻放大倍数，错误文本前缀 `mosaic_decode`。
#[wasm_bindgen]
pub fn mosaic_decode(code: &str, scale: u32) -> Result<Vec<u8>, JsValue> {
    websurf_wasm_core::mosaic::decode::code_to_img(code, scale)
        .map_err(|e| JsValue::from_str(&format!("mosaic_decode: {e}")))
}

/// MTZ 容器字节（魔数 `MTZ6`，兼容读 `MTZ5`）→ JSON 对象文本：`键 → "#mosaic v4 字节码"`。
/// 键取条目 `B[名字:宽x高]` 的名段里 `|` 之前的一段（形如 `materials/buildings/antn00`）；
/// 错误文本前缀 `decompress_mtz`，本工程由 `apps/game/src/app.ts` 注入 `buildWorldBundle`。
#[wasm_bindgen]
pub fn decompress_mtz(bytes: &[u8]) -> Result<String, JsValue> {
    websurf_wasm_core::mosaic::mtz::decompress_mtz(bytes)
        .map_err(|e| JsValue::from_str(&format!("decompress_mtz: {e}")))
}

/// 内存中的 `.mdl`/`.vtx`/`.vvd` 三件字节 → `vmdl::Model`；任一步读取失败即返回 `None`。
fn load_vmdl(m: &InMemoryModel) -> Option<vmdl::Model> {
    let mdl = vmdl::Mdl::read(&m.mdl).ok()?;
    let vtx = vmdl::Vtx::read(&m.vtx).ok()?;
    let vvd = vmdl::Vvd::read(&m.vvd).ok()?;
    Some(vmdl::Model::from_parts(mdl, vtx, vvd))
}




/// 从 PAKFILE 条目名构建 VMT **基名索引**：`基名小写 → 去掉 materials/ 前缀与 .vmt 后缀的路径`。
///
/// 只收 `materials/` 下、以 `.vmt` 结尾的条目；值保留条目原始大小写（`Packfile::get` 按名精确
/// 匹配）。产物填进 `bsp_to_gltf_core::ConvertOptions::vmt_stem_index`，供世界面的贴图名在精确
/// 候选全部落空时按基名回退取 `$basetexture` 等标注。
///
/// 同名多条时取**路径最短**者；与当前值等长时保留先到的一条。
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

/// 解析被引用模型的材质标注与贴图：取 `.vmt` 得 `alpha_mode` / `unlit` / `$basetexture`，
/// 再按 `$basetexture` 取 `.vtf` 解码为 PNG；`patch` 材质多跟一层 `include` 母材质。
///
/// `decode_textures = false` 时只填 `alpha_modes` 与 `unlit`，跳过全部图像解码（碰撞体路径用此模式）。
///
/// VMT 候选路径按 `mdl.textures[].search_paths` 与 `mdl.texture_paths` 逐条拼上材质名，末尾补一条
/// 裸材质名；查询一律走 [`pakfile_models::PakIndex::find`]。已解析过的材质名不再重复解析。
///
/// `fallback` = 默认纹理包（`textures.mtz` 解压产物，键形如 `materials/<小写路径>`）：pakfile 内
/// 没有该 VTF 时，按 `$basetexture` 路径与材质名依次查包取低清纹理补位；传 `None` 即不回落，
/// 此时没有 pakfile VTF 的材质没有贴图。
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
            // 先在 pakfile 内按 `$basetexture` 找同路径 VTF（原始分辨率），解出 PNG 即用
            if let Some(vtf_entry) = index.find(&base, "vtf") {
                if let Ok(Some(vtf_bytes)) = bsp.pack.get(vtf_entry) {
                    if let Ok(png) = decode_vtf_to_png(&vtf_bytes) {
                        out.textures.insert(tex.name.clone(), png);
                        continue;
                    }
                }
            }
            // pakfile 内没有这张 VTF（stock 贴图未打包）时退到默认纹理包。
            // 查表键经 `bsp_to_gltf_core::fallback_key` 归一成 `materials/<小写路径>`，故这里按
            // `$basetexture` 路径与材质名依次试：模型材质名常是裸基名（`metalfence007a`），
            // 包里的键却是源资源路径（`materials/metal/metalfence007a`）。
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
// 元数据 / 处理器入口
// ---------------------------------------------------------------------------

/// 顶层元数据：各 lump 的条目计数与 BSP 魔术字。前端消费的是 [`BspProcessor::metadata`]
/// 返回的 JSON 文本（`JSON.parse` 后即为本结构）。
///
/// 不标 `#[wasm_bindgen]`：那一侧要求导出结构体的字段实现 `Copy`，本结构含 `String` 字段，
/// 故只经 `serde_json` 序列化成字符串返回；`schema_version` 固定写 1。
#[derive(serde::Serialize)]
pub struct BspMetadata {
    pub schema_version: u32,
    /// BSP 魔术字，由 header 的 `v`/`b`/`s`/`p` 四个字节按字符拼成（`VBSP` 地图）。
    pub magic: String,
    /// 地图名：当前实现恒为空串，未从任何 lump 取值。
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
    /// PAKFILE 内的条目数（`ZipArchive::len`），在构造处理器时算一次并缓存。
    pub packed_files: usize,
}

impl BspMetadata {
    // packed_files 由调用方传入：`Packfile` 的 zip 字段私有，要拿条目数只能 clone 后走
    // `Packfile::into_zip()`（消费 self）再 `len()`，克隆代价高 ⇒ 在处理器构造时算一次缓存。
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

#[wasm_bindgen]

// ---------------------------------------------------------------------------
// 处理器：持有 BSP 解析结果，借用式重复导出 / 提取
// ---------------------------------------------------------------------------

/// BSP 处理器：`new` 里解析字节数组并存成 `Option<Arc<vbsp::Bsp>>`，此后可反复调用
/// [`BspProcessor::metadata`] 取元数据 JSON，或调用各导出方法取 GLB 字节 / 碰撞体 JSON。
///
/// 导出入口 `take_bsp` 只克隆一份引用计数，处理器自己那份始终保留 ⇒ 导出成功或
/// 失败都不消费实例，重复导出的字节一致；取不到句柄的唯一情形是构造失败（那时本就没有实例）。
/// 导出侧 `bsp_to_gltf_core::export_bsp` 与 `export_bsp_with_models` 的形参都是 `Arc<Bsp>`。
#[wasm_bindgen]
pub struct BspProcessor {
    bsp: Option<std::sync::Arc<vbsp::Bsp>>,
    /// 构造时缓存的 PAKFILE 条目数（`metadata()` 直接复用，不再克隆 Packfile）
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

    /// 克隆出 `Arc<Bsp>` 句柄（**不**清空 `self.bsp`）。
    ///
    /// 导出成功或失败后处理器都仍持有原句柄，可再次调用；`bsp` 为 `None` 时返回文本为
    /// `BSP 未解析` 的 [`JsValue`]。
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

    /// 导出为 GLB 字节数组：`bsp_to_gltf_core::export_bsp` + `ConvertOptions::default()`
    /// ——不含 PAKFILE 模型、不注入光照、不回退缺失纹理。
    ///
    /// 借用式导出：`self.bsp` 在成功与失败后都保留，可重复调用且字节一致；
    /// 失败文本前缀 `GLB 导出失败` / `GLB 序列化失败`。
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

    /// 导出 GLB（含 PAKFILE 模型）+ **缺失纹理回退**：`defaults_json` 是默认纹理包文本
    /// （`{ "materials/<材质路径小写>": "#mosaic v4 字节码" }`），解析失败即报
    /// 「默认纹理包 JSON 解析失败」；pakfile 内没有该 VTF 的材质用它解码出的低清纹理补位。
    ///
    /// 与 [`BspProcessor::export_glb_with_pakfile_models`] 同一装配流程，差别只在注入回退表；
    /// 内部按 `lightmap_max_atlas_area = 0`、`include_lights = false` 调
    /// `export_glb_with_defaults_opts`。
    ///
    /// 失败不消费实例：失败后 `self.bsp` 仍为 `Some`，同一实例可再次导出，
    /// `metadata()` / `parse_spawn_points()` / `export_brushes_planes(…)` 等借用类接口继续可用。
    pub fn export_glb_with_pakfile_models_with_defaults(
        &mut self,
        defaults_json: &str,
    ) -> Result<Vec<u8>, JsValue> {
        self.export_glb_with_defaults_opts(defaults_json, 0, false)
    }

    /// [`BspProcessor::export_glb_with_pakfile_models_with_defaults`] 的**阈值可覆盖**变体。
    ///
    /// `lightmap_max_atlas_area` > 0 时用作单页光照图集面积上界（px），0 表示沿用政策上界
    /// 4096×2048 px（`src/wasm-core/bsp_to_gltf_core/lightmap.rs` 的 `MAX_ATLAS_PAGE_AREA`）；
    /// 非有限值或 ≤ 0 一律按 0 处理。它只改这一条判定阈值，打包 / 落位 / UV / 像素口径都不变；
    /// 本工程的 `.ts`/`.mjs` 无调用点，供显式压小上界以走「图集装不下」的失败路径。
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
    /// 组合入口：默认纹理回退表（同 [`BspProcessor::export_glb_with_pakfile_models_with_defaults`]）
    /// 与光照实体导出的 `KHR_lights_punctual`（同
    /// [`BspProcessor::export_glb_with_pakfile_models_with_lights`]）。本工程的实际调用点是
    /// `src/ts-shared/phys/world-builder.ts` 的 `buildWorldBundle`。
    ///
    /// 无模型时与 `_with_lights` 同语义：仍走整合器路径（空模型不产出节点，光照注入照常发生）。
    /// 借用式导出：成功与失败都不消费 `self.bsp`。
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

        // 世界面材质的**基名 VMT 回退**索引（填进 `ConvertOptions::vmt_stem_index`）：
        // texinfo 给的名字（如 `METAL/METALGRATE013A2`）在包内没有精确路径时，改按基名
        // `metalgrate013a2.vmt` 命中作者写的 VMT，取其中的 `$basetexture` 等标注。
        let stem_index = build_vmt_stem_index(&entry_names);

        let options = |generate_missing_list: bool| bsp_to_gltf_core::ConvertOptions {
            missing_fallback: fallback.clone(),
            vmt_stem_index: stem_index.clone(),
            generate_missing_list,
            lightmap_max_atlas_area,
            ..bsp_to_gltf_core::ConvertOptions::default()
        };

        // 无模型且 include_lights=false：走不装配整合器的纯 `export_bsp` 路径；
        // 只要 include_lights=true 就仍走整合器路径，光照注入照常发生。
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

    /// 导出为 GLB，并把 **PAKFILE 内嵌模型**（`.mdl`/`.vvd`/`.dx90.vtx` 三件套）合并进同一张地图。
    ///
    /// 本方法不收 JS 侧参数：模型、放置信息与贴图全部从 BSP 自己取——只有被 `static_props`
    /// 引用且三件齐全的模型才装配，origin/angles/solid 来自 static prop lump，
    /// `.vmt`/`.vtf` 从 PAKFILE 现解（`decode_textures = true`）；不做默认纹理回退、不注入光照。
    ///
    /// 一件模型都没取到时退回纯地图导出（`bsp_to_gltf_core::export_bsp`，不装配整合器）。
    /// 借用式导出：成功与失败都不消费 `self.bsp`，可重复调用且字节一致
    /// （对比 [`BspProcessor::export_glb_with_pakfile_models_with_defaults`]）。
    pub fn export_glb_with_pakfile_models(&mut self) -> Result<Vec<u8>, JsValue> {
        let bsp = self.take_bsp()?;

        // 1~3 步（见 `collect_pakfile_models`）：模型三件套 + 静态道具放置表 + PAKFILE 条目清单
        let (models, static_props, entry_names) = collect_pakfile_models(&bsp)?;

        // 4. 未打包任何模型 → 退回纯地图导出（不装配整合器）
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

        // 5. 解析 PAKFILE 内的 VMT/VTF：贴图 PNG 字节 + 透明度标注
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

    /// 导出 **PAKFILE 内嵌模型**的三角形碰撞体，序列化成 JSON 数组：每个放置实例一个条目，
    /// 字段为 `name` / `vertices`（世界空间顶点）/ `indices`（三角形下标）/ `min` / `max`。
    ///
    /// # 与显示几何一致
    ///
    /// 局部顶点走 `model_integrator::map_coords(model.apply_root_transform(v.position))`，
    /// 放置表来自与 GLB 节点同一份 [`model_integrator::resolve_placements`]，逐实例再用
    /// `pakfile_models::place_point` 按 `translation`/`rotation`/`scale` 搬进世界空间。
    /// 三角下标取自 `mesh.vertex_strip_indices()` 的三元组，越界下标丢弃；空网格不产出条目，
    /// 一件模型都取不到时返回 `[]`。累计三角数达到 `MAX_TRI_TOTAL`（200 000）后不再展开新实例，
    /// 已产出的条目保留。
    ///
    /// # 碰撞门控
    ///
    /// - `Placement::solid == Some(0)`（`SOLID_NONE`）的实例先被 `filter` 掉；
    /// - 逐 mesh 查 PAKFILE 标注：`alpha_mode == 1`（`$translucent` 置位，或 `$alpha < 1`）跳过该 mesh，
    ///   其余情形（`$alphatest` 的 2 与无标注的 0）保留。
    ///
    /// # 调用时机
    ///
    /// 只按 `&self.bsp` 借用、不取走句柄 ⇒ 导出前后都可调用。产物由
    /// `src/ts-shared/phys/world-builder.ts` 的 `buildWorldBundle` 放进 `triJson`，
    /// 经 `src/ts-shared/auth/worker-dispatch.ts` 的 `build_world` 进 `src/phys` 的 `TriangleGrid`。
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

        /// 单个放置实例的三角形网格条目（世界空间极值 + 下标）。
        #[derive(serde::Serialize)]
        struct TriMeshOut {
            name: String,
            vertices: Vec<[f32; 3]>,
            indices: Vec<[u32; 3]>,
            min: [f32; 3],
            max: [f32; 3],
        }

        /// 累计三角形总护栏：达到上限后不再展开新的放置实例。
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

            // ---- 展开三角：条带索引展平成三元组，逐 mesh 做透明度门控 ----
            let skin = model.skin_tables().next();
            let mut tris: Vec<[u32; 3]> = Vec::new();
            for mesh in model.meshes() {
                let alpha = skin
                    .as_ref()
                    .and_then(|s| s.texture_info(mesh.material_index()))
                    .and_then(|t| materials.alpha_modes.get(&t.name).copied())
                    .unwrap_or(0);
                if alpha == 1 {
                    continue; // alpha_mode == 1（Blend）：该 mesh 不参与碰撞
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

            // ---- 每个放置实例：顶点搬进世界空间（与 GLB 节点同一放置变换）----
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
    /// 与 [`BspProcessor::export_model_tri_colliders`]（可视网格）不同，本方法解析模型自己打包的
    /// vphysics 碰撞体（`.phy`）；输出与三角形碰撞**同构**（同样的 `name` / `vertices` / `indices` /
    /// `min` / `max`，另加 `surfaceprop`），消费端复用同一套 `src/phys` 的 `TriangleGrid`
    /// 与 `clip_box_to_triangle` 扫掠。
    ///
    /// 逐模型的处理顺序：按 `static_props` 取放置表（`solid == Some(0)` 的实例过滤掉）→ 由
    /// `.mdl` 路径换出 `.phy` 条目（缺失即跳过）→ `phyfile::parse_phy` 解析（失败打印一行
    /// `⚠️ 跳过 PHY 解析失败` 后跳过）→ `model.apply_root_transform` → `map_coords` →
    /// `place_point` 搬世界空间。顶点单位换算（米 → HU）与 `modelType` 校验都在
    /// `phyfile::parse_phy` 内（只接受 `modelType == 0` 的凸包，其余取值直接报错）。
    ///
    /// 本方法内另有两处跳过条件：凸体的 `bone_index != 0`（顶点相对骨骼，需要骨骼变换矩阵）、
    /// 以及解析后 `vertices`/`indices` 为空的模型。`surfaceprop` 取该模型第一个非空的取值，
    /// 全空则为空串。累计三角数达到 `MAX_TRI_TOTAL`（200 000）后不再展开新实例。
    ///
    /// 输出 JSON：`[{ "name", "surfaceprop", "vertices": [[x,y,z]...], "indices": [[a,b,c]...],
    /// "min": [...], "max": [...] }]`（每个放置实例一个条目，无模型时 `[]`）。
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
            // 只处理被 static_props 引用的模型；无 .phy 条目或解析失败即跳过该模型
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
            // 加载三件套：只为取 apply_root_transform（与显示端同一根骨骼变换）
            let Some(model) = load_vmdl(m) else {
                continue;
            };

            // 收集该模型全部 bone_index == 0 凸体的顶点与三角形（局部空间，HU，Z-up）
            let mut local: Vec<[f32; 3]> = Vec::new();
            let mut tris: Vec<[u32; 3]> = Vec::new();
            let mut sprop = String::new();
            for s in &solids {
                if s.surfaceprop.is_some() && sprop.is_empty() {
                    sprop = s.surfaceprop.clone().unwrap_or_default();
                }
                for c in &s.convexes {
                    if c.bone_index != 0 {
                        continue; // bone_index != 0：顶点相对骨骼，缺变换矩阵时不参与
                    }
                    let base = local.len() as u32;
                    for v in &c.vertices {
                        // PHY 顶点是 **IVP 坐标系**（vphysics 内部，Y-up 左手系），而 Source 是
                        // Z-up 右手系：转换取 **绕 x 轴 90°**，即 source = (x, z, -y)
                        // （det=+1 的纯旋转；只交换 y↔z 是 det=-1 的镜像，会上下颠倒）。
                        let ivp2src = [v[0], v[2], -v[1]];
                        // 再施加与显示端相同的根骨骼变换
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

    /// 检查 BSP 是否仍持有：构造成功后恒为 `true`（导出只克隆句柄，不取走 `self.bsp`）；
    /// 构造失败时没有实例，本方法无从调用。
    pub fn is_alive(&self) -> bool {
        self.bsp.is_some()
    }

    /// 生成纹理画质 manifest：`{ 纹理名: "#mosaic v4 字节码" }` 的 JSON 文本。
    ///
    /// 键有两类来源：地图 face 纹理走 `websurf_wasm_core::mosaic::manifest::build_mosaic_manifest`
    /// （键是加载后的 `texture.name` 小写形式，与 GLB 的 `texture.name` 同源），
    /// PAKFILE 模型贴图在本方法内用 `mosaic::encode::img_to_code` 逐张编码后以材质名小写补齐；
    /// 单张贴图取值或编码失败只跳过该张，同名键由后写入的模型贴图覆盖。
    ///
    /// 供前端在不重载地图的前提下切换画质：按名查到字节码后用 `mosaic_decode` 还原低清 PNG 替换贴图。
    /// 只借用 `&self.bsp`，导出前后均可调用。
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

    /// 导出缺失材质纹理列表（JSON 字符串数组）：判定与去重在
    /// `websurf_wasm_core::mosaic::manifest::collect_missing_textures`——凡 face 材质加载
    /// 报错（缺 VMT / 缺 VTF / 解码失败）都算缺失，顺序同 `collect_face_texture_names`。
    ///
    /// 供前端与默认纹理包的键集合比对；能在导出期回退的那部分已在
    /// [`BspProcessor::export_glb_with_pakfile_models_with_defaults`] 里补上贴图。
    pub fn export_missing_textures(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
        let missing = websurf_wasm_core::mosaic::manifest::collect_missing_textures(bsp);
        serde_json::to_string(&missing).map_err(|e| to_js_err(e, "序列化缺失纹理列表失败"))
    }

    /// 提取出生点实体，输出 JSON：`{ "spawn_points": [{ classname, origin, angles, origin_raw,
    /// angles_raw }], "total": N, "primary": M }`（`primary` 无值时为 `null`）。
    ///
    /// 命中条件：classname 在 `SPAWN_CLASSNAMES` 内，或以 `info_player_` 开头；
    /// `origin` 解析不出三个浮点数就跳过该实体，`angles` 缺失或解析失败则填 `[0.0, 0.0, 0.0]`。
    /// `primary` 是第一个 `info_player_start` 的下标，没有该实体时退化为 0，一个出生点都没有时为 `null`。
    ///
    /// **坐标转换**：`origin` 经 `rotate_yup` 转成 Y-up（`[x,y,z]→[y,z,x]`，det=+1 正交变换），
    /// `angles` 保持 BSP 原始 `[pitch, yaw, roll]` 顺序不转。
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

    /// 解析传送网络：传送目标点与传送触发器，并按 `target` → `targetname` 建立连接。
    ///
    /// 输出 JSON：`{ teleports, triggers, links, total_triggers, total_dests, total_links,
    /// orphan_triggers, orphan_dests }`。
    ///
    /// - `teleports[]`：`index`（实体序号）/ `targetname` / `origin`（Y-up）/ `angles`（原样）/
    ///   `origin_raw` / `angles_raw`。只收 `info_teleport_destination` 与
    ///   `info_teleport_destination_*`；缺 `targetname` 的不入列表，`origin` 解析失败按 `[0,0,0]` 计。
    /// - `triggers[]`：`index` / `classname` / `target` / `origin`（Y-up）/ `model` /
    ///   `model_mins` / `model_maxs`（世界 AABB，Y-up）/ `model_planes`（世界凸包平面
    ///   `[nx,ny,nz,dist]`，朝外）/ `spawnflags` / `start_disabled` / `origin_raw` / `model_raw`。
    ///   只收 `trigger_teleport` / `trigger_teleport_random` / `trigger_teleport_relative`；
    ///   缺 `target` 的不入列表，`spawnflags` 缺失或解析失败按 1 计。
    /// - `links[]`：`trigger_idx` → `dest_idx`，逐对比较 `trigger.target == dest.targetname`；
    ///   `orphan_triggers` / `orphan_dests` 是两边各自没配上对的数量。
    ///
    /// 触发区域几何按 `model` 的 `*N` 取 BSP 模型：逐个 brush 单独算局部 AABB 与凸包平面，再按
    /// 实体 origin 平移、按 Y-up 旋转成世界坐标——多个分散 brush 绑到同一实体时 `model.mins/maxs`
    /// 只是总包围盒，直接当触发区会把盒内所有区域都算成触发区。每个 brush 区域产出**一个** trigger
    /// 条目（共享 target/origin/标志位）；该模型一个 brush 都取不到时退回 `model.mins/maxs` 总包围盒
    /// 且 `model_planes` 为 `None`；连总包围盒都没有时三个几何字段全为 `None`。
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

        /// 遍历 `model.head_node` 收集该模型的全部 brush，逐个算局部 AABB 与凸包平面（BSP Z-up 坐标）。
        ///
        /// Hammer 可把多个分散的 brush 绑到同一实体（Tie to entity），此时 `model.mins/maxs` 只是
        /// **总包围盒**：直接拿它当触发区会把盒内所有区域都算成触发区。故这里遍历 BSP 树，
        /// 每个 brush 单独算局部 AABB，各生成一个触发区域；`head_node` 下多个 leaf 会覆盖到同一
        /// brush，故用集合去重。
        ///
        /// 返回 `(局部 AABB min, 局部 AABB max, 局部凸包平面 [nx,ny,nz,dist])`；凸包平面供消费端
        /// 精确判定（楔形 / 斜面触发区不能只用 AABB）。平面数 < 4 或顶点数 < 4 的 brush 跳过。
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
            // 只认 info_teleport_destination 与 info_teleport_destination_<后缀> 两种名字；
            // info_target 等同族实体不算传送目标点。
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
            // 只收这三种 classname；通用触发器（trigger_multiple 等）不入列表。
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

                // spawnflags：缺失或解析不成 u32 时按 1（Clients 位）计，原样写进 JSON。
                let spawnflags = ent
                    .prop("spawnflags")
                    .ok()
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(1);

                // StartDisabled：键按**大写**传入，而实体文本在读入时已整体转小写
                // （`src/wasm-core/vbsp/reader.rs` 的 `read_entities` 调 `to_ascii_lowercase`），
                // `RawEntity::prop` 又是 `key == prop_key` 的逐字节比较 ⇒ 这里取不到该键，
                // `.unwrap_or(false)` 把错误吞掉，`start_disabled` 恒为 false。
                let start_disabled = ent
                    .prop("StartDisabled")
                    .map(|s| s == "1")
                    .unwrap_or(false);

                // model 格式 "*N" 指向 bsp.models[N]，几何为局部坐标（相对实体 origin）。
                // trigger 可把多个分散 brush 绑到同一实体（Hammer 的 Tie to entity），此时
                // model.mins/maxs 只是总包围盒 ⇒ 逐个 brush 单独算区域。
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
                // 世界 AABB 与世界凸包平面：局部值经 Y-up 旋转后加实体 origin 平移
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
                        // 回退：模型下一个 brush 都没取到 → 改用 model.mins/maxs 总包围盒
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
                                    // 回退路径只有 AABB，凸包平面留空
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
                    // 连总包围盒都取不到：三个几何字段全为 None，推入一个裸 trigger 条目
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

    /// 导出 BSP PVS（Potentially Visible Set）数据，供 Worker 端做遮挡剔除。
    ///
    /// 输出 JSON（字段名经 `rename_all = "camelCase"`）：`{ rootNode, nodes, leaves, faceClusters,
    /// pvsBitsBase64, clusterCount, bytesPerRow }`，其中 `rootNode` 当前恒为 0。
    ///
    /// - `nodes[]`：`normal` / `dist` / `children`；某节点的 `plane_index` 越界（损坏的 BSP）时
    ///   该节点改用默认平面（法线 `(0, 0, 1)`、`dist = 0`），不中断整体导出。
    /// - `leaves[]`：`cluster` / `mins` / `maxs` / `isSolid`（`cluster < 0` 即固体 leaf）；
    ///   leaf 按 BSP 原始顺序输出，`nodes[].children` 里的负值取反即 leaf 下标。
    /// - `faceClusters[]`：长度等于 face 数，初值 -1；按 leaf 顺序填**第一个**非固体 cluster，
    ///   `leaf_faces` 区间越界或 face 下标越界都跳过。
    /// - `pvsBitsBase64`：把 RLE 压缩的 PVS 逐簇解码成位图后整体 base64。第 `cluster` 行
    ///   （长度 `bytesPerRow = (clusterCount + 7) / 8`）的第 `targetCluster` 位为 1 表示从
    ///   `cluster` 可见 `targetCluster`。`clusterCount == 0` 或 `pvs_offsets` 为空时不做解码，
    ///   `pvs_offsets` 用尽或偏移超出 `vis_data` 即停止/跳过该簇。
    ///
    /// **坐标转换**：BSP Z-up → Three.js Y-up（`[x,y,z]→[y,z,x]`，det=+1，与
    /// [`BspProcessor::export_brushes_planes`] 一致）；plane normal 与 leaf `mins`/`maxs` 同样旋转，
    /// plane `dist` 不变。
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
                // plane_index 越界（损坏的 BSP）时退回默认平面，不中断本次导出
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
        // leaves 按 BSP 原始顺序输出；`nodes[].children` 的负值取反即 leaf 下标。
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
                continue; // 固体 leaf（cluster < 0）不参与 face → cluster 映射
            }
            let start = leaf.first_leaf_face as usize;
            let count = leaf.leaf_face_count as usize;
            if start + count > bsp.leaf_faces.len() {
                continue; // leaf_faces 区间越出表尾：跳过该 leaf
            }
            for fi in start..(start + count) {
                let face_idx = bsp.leaf_faces[fi].face as usize;
                if face_idx < face_clusters.len() && face_clusters[face_idx] < 0 {
                    face_clusters[face_idx] = leaf.cluster as i32;
                }
            }
        }

        // ---- 4. 预解码 PVS 位图 ----
        // 逐簇调 `vbsp::decode_pvs_row`，不走 `VisData::visible_clusters`——后者是另一份独立
        // RLE 循环，offset 越界时 panic，而 wasm 导出的 panic 会破坏 wasm-bindgen 状态。
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
                // offset 超出 vis_data：跳过该簇
                if offset >= vis_data.len() {
                    continue;
                }
                let row_offset = c_usize * bytes_per_row;
                // RLE 解码：一次跳过覆盖 8 个簇，规则集中在 `vbsp::decode_pvs_row`
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

    /// 导出 BSP brush 的凸包碰撞体：`WasmBrush[]` JSON 数组，每项含 `planes`（世界坐标 Y-up、
    /// 法线朝外的平面）/ `min` / `max` / `is_ladder` / `is_solid`。
    ///
    /// `filter_json` 是 `ColliderFilter` 的 JSON（字段全部可选，缺失取默认值）；文本解析失败一律
    /// 退回 `ColliderFilter::default()`。过滤分两类——调用方开关（`skip_sky` / `skip_nodraw` /
    /// `include_ladder` / `include_solid` / `min_brush_volume`），以及固定几何条件（既非玩家固体
    /// 亦非 LADDER 的 brush、所属实体被 `entity_is_non_solid` 判为无碰撞、剔除 bevel 后平面数 < 4、
    /// 顶点数 < 4）。已产出 brush 数达到 `MAX_BRUSHES` 时提前结束，剩余 brush 全部计入跳过计数。
    ///
    /// 结束时用 `web_sys::console::log_1` 打一行 `[BrushPlanes]` 统计：九个具名分支计数之和等于
    /// `skipped` 且 `exported + skipped == total` 时末尾为 `ok`，否则为 `MISMATCH`。
    ///
    /// **平面约定**：BSP 读出的平面法线朝内（内部点 `dot(n,p)-dist >= 0`），本方法转到 Y-up 后取负
    /// `normal` 与 `dist`，输出扫掠侧要的「法线朝外」平面；另对每条真实凸棱补一个 chamfer 平面后
    /// 一并输出。
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
        // 跳过计数的**分支分解**：单一 `skipped` 计数器无法自证，故逐分支计数并保证
        // 「九个具名分支之和 == skipped」。九个分支依次是：
        //   非玩家固体（既非 SOLID 族亦非 LADDER，或所属实体被判定为无碰撞）、SKY、
        //   ladder 被排除、solid 被排除、nodraw、剔除 bevel 后平面数 < 4、顶点数 < 4、
        //   体积不足、达到 MAX_BRUSHES 的早退。
        // `bevel_sides_dropped` 是**侧**级计数，不属于 brush 级跳过，故不进分解。
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
        // brush → 模型 world origin 映射（实体 brush 的平面是局部坐标，需平移到世界坐标）
        let brush_model_origins = build_brush_model_origins(bsp);
        // 无碰撞实体（trigger_* / func_illusionary 等）的 brush 不导出为碰撞体，
        // 否则玩家会在触发区域撞到不可见的空气墙。
        let brush_models = brush_model_indices(bsp);
        let model_classes = model_classnames(bsp);

        for (brush_idx, brush) in bsp.brushes.iter().enumerate() {
            if brushes_out.len() >= MAX_BRUSHES {
                // 达到 MAX_BRUSHES 上限：剩余 brush 全部计入早退分支，保证 total == exported + Σ分支
                skipped_early_exit = bsp.brushes.len() - brush_idx;
                break;
            }
            // 玩家固体掩码（MASK_PLAYERSOLID 同义）：SOLID|WINDOW|GRATE|PLAYERCLIP|MOVEABLE
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

            // 单次遍历 brush_sides：收集平面引用与 sky/nodraw 标志；
            // 逐项用 `.get()` 取值，越界即跳过（不在导出路径里 panic）
            let mut bsp_planes: Vec<&Plane> = Vec::new();
            let mut is_sky = false;
            let mut is_nodraw = false;
            let start = brush.brush_side as usize;
            let count = brush.num_brush_sides as usize;
            for i in 0..count {
                let Some(side) = bsp.brush_sides.get(start + i) else {
                    continue;
                };
                // 剔除 BSP 自带的 bevel 面（`side.bevel != 0`），改由下面运行时补 chamfer；
                // 同类处理见 apps/debug/crates/wasm/src/lib.rs 的同名导出。
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

            // 实体模型 brush 的平面是局部坐标（相对模型 origin）：按 origin 平移 `dist` 到世界坐标，
            // 否则这些碰撞体全部堆在模型原点。
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

            // 回退：顶点数 < 4 时把全部平面法线与 `dist` 取负再算一次
            // （部分编辑器生成的 brush 法线朝内）
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
            // 运行时棱边 chamfer（AddEdgeBevels 的简化版）：对每条真实凸棱生成微小外切角平面。
            // 「真实棱」= 两平面法线不共线（`|dot| <= 0.999`）且至少共享 2 个凸包顶点；
            // 平面法线取两法线均值归一化，并校验其余凸包顶点都落在该平面同一侧，
            // 从而不挤压凸包、不改变可站性。
            // 同类处理见 apps/debug/crates/wasm/src/lib.rs 的同名导出。
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

            // 旋转平面法线到 Y-up，并翻转法线方向（vbsp 内部约定 → 扫掠侧约定）。
            //
            // **法线方向**：`vbsp` 读出的平面是「法线朝内」约定（内部点 `dot(n,p)-dist >= 0`，
            // `compute_vertices` 的 `d < -1.0` 检查与此一致）；扫掠侧要「法线朝外」
            // （`src/phys/world.rs` 的 `Brush`：内部 = `dot(normal, p) - dist <= 0`）。
            // 故对每个平面取负 `normal` 与 `dist`：`dot(-n,p)-(-dist) = -(dot(n,p)-dist)`，
            // 内部点由 d >= 0 变成 d <= 0，半空间等价翻转；先旋转到 Y-up 再取负，二者可交换。
            // 统一从 all_planes_src（真实面 + 运行时 chamfer）构建，chamfer 一并输出。
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

        // 跳过计数自证：附**分支分解**，并断言九个具名分支之和 == `skipped`
        // 且 `exported + skipped == total`；任一不成立，日志末尾就标 `MISMATCH`。
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

/// 碰撞体导出过滤参数，由前端以 JSON 传给 [`BspProcessor::export_brushes_planes`]，控制导出哪些
/// brush。字段全部可选，缺失时用默认值，字段名为 snake_case；自定义 `Default` 与 serde 默认值一致，
/// 因此「不传」与「传 `{}`」得到同一套取值：
/// - `include_ladder` / `include_solid`（默认 `true`）：是否导出 LADDER / SOLID brush；
/// - `min_brush_volume`（`f32`，默认 `0.0`）：跳过 AABB 体积小于此值的 brush；
/// - `skip_sky`（默认 `true`）：跳过含 SKY / SKY2D 纹理的 brush；
/// - `skip_nodraw`（默认 `false`）：跳过含 NODRAW 纹理的 brush（NODRAW 只影响渲染，不影响碰撞）。
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

/// 供 serde 用作「字段缺省即 `true`」的默认值函数。
fn default_true() -> bool {
    true
}

/// Source 引擎中**无物理碰撞**的实体（brush 只作触发或标记区域，玩家可穿过）。
///
/// 命中即判无碰撞：`trigger_` 前缀、`func_illusionary`、`func_occluder`、`func_dustmotes`、
/// `func_areaportal`、`func_precipitation`。这些 brush 若导出成固体碰撞体，
/// 玩家会在触发区域撞到不可见的空气墙。
fn entity_is_non_solid(classname: &str) -> bool {
    classname.starts_with("trigger_")
        || classname == "func_illusionary"
        || classname == "func_occluder"
        || classname == "func_dustmotes"
        || classname == "func_areaportal"
        || classname == "func_precipitation"
}

/// 每个 BSP 模型对应的实体 classname：按实体的 `model="*N"` 键填表；model[0]（worldspawn）、
/// 下标越界与已被更早实体占用的模型都留 `None`。
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

/// 每个 brush 归属的模型索引（遍历 `model.head_node` 下的 `leaf_brush` 收集）。
///
/// worldspawn（model[0]）的 brush 与不被任何模型引用的 brush 留 `None`；同一 brush 被多个模型
/// 覆盖时只记首个命中的归属。
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

/// 确定每个 brush 应平移的模型 origin（Z-up 世界坐标），返回长度与 `bsp.brushes` 等长的数组。
///
/// 实体模型的 brush 几何以局部坐标存储（相对实体 origin），本函数一律取 entities lump 中该实体的
/// `origin` 键作为平移量（`model="*N"`；缺该键或解析不成 `vbsp::Vector` 就不平移），
/// 不读 BSP 模型自带的 origin 字段。
///
/// worldspawn（model[0]）局部即世界，保持零平移；未被任何实体引用的模型同样保持零平移；
/// 同一模型被多个实体引用时取首个实体的 origin。
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