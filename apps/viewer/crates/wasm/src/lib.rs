//! WebSurf-viewer 的 WASM 薄导出层。
//!
//! 唯一导出类型是 [`BspProcessor`]：`new` 解析 BSP 字节，之后用各方法取元数据、取出生点、
//! 导出 GLB。解析与合并全部落在共享解析层 `src/wasm-core/`（crate `websurf-wasm-core`，由本
//! crate 的 `Cargo.toml` 以路径依赖引入），本文件只做参数搬运与错误翻译。
//!
//! 方法与 JS 侧的对应关系（消费方 `apps/viewer/src/core/bsp.ts`）：
//! - `metadata()`：地图元数据 JSON（magic / 各 lump 计数 / pakfile 条目数）；
//! - `parse_spawn_points()`：出生点报告 JSON（该工程的初始视角与面板 ★ 标记都读它）；
//! - `export_glb_with_pakfile_models_with_defaults_and_lights(defaults_json)`：主导出入口——
//!   PAKFILE 模型并进地图 + **缺失材质回退**（defaults_json = textures.mtz 解压产物，pakfile
//!   内没有的 VTF 用默认纹理包低清纹理补位，2026-10-04 起与 game 同款，消除 viewer 材质纯色）
//!   + `KHR_lights_punctual` 灯实体（渲染端 `buildMapScene` 会摘除，导出端带上只为 GLB 自包含）；
//! - `export_glb_with_pakfile_models()`：无回退的裸导出，仅作主导出失败时的 TS 侧回退路径；
//! - `decompress_mtz()`：MTZ 容器解压（TS 侧构建 defaults_json 用）。
//!
//! 早期「导出面刻意压到最小、不导出默认纹理包相关接口」的口径已在 2026-10-04 owner 裁决
//! （三应用渲染对齐 game）后放开；物理/碰撞类接口仍然不导出。TS 侧唯一导入 `pkg/` 的地方是
//! `apps/viewer/src/core/bsp.ts`，契约清单由 `apps/viewer/scripts/check-wasm-api.mjs` 守着
//! （取自实际消费面，另带反向覆盖断言）。
//!
//! 顺序契约：两个 `export_glb_*` 都会取走内部 `Bsp` 实例，必须排在另外两个方法之后；
//! 取走之后再调那两个方法一律得到错误，而不是旧值。

use std::collections::HashMap;
use std::io::Cursor;

use wasm_bindgen::prelude::*;

// 解析层来自仓库根的共享 crate websurf-wasm-core（路径依赖 ../../../../src/wasm-core）
use websurf_wasm_core::{bsp_to_gltf_core, model_integrator, pakfile_models, texture_utils, vbsp};
use model_integrator::{
    ExportOptions, InMemoryModel, InMemoryResources, ModelIntegrator, StaticProp,
};

// ---------------------------------------------------------------------------
// 错误翻译：把 Rust 侧错误压成带上下文的 JS 字符串
// ---------------------------------------------------------------------------

/// 把任意错误转成 JS 错误值，格式为 `"{上下文}: {Debug 格式的错误}"`。
/// `ctx` 由调用点给，用来区分同一条链路上的多个失败点（解析 / 解码 / 序列化）。
fn to_js_err<E: std::fmt::Debug>(e: E, ctx: &str) -> JsValue {
    JsValue::from_str(&format!("{}: {:?}", ctx, e))
}

// ---------------------------------------------------------------------------
// PAKFILE 内嵌模型：模型三件套提取与材质解析
// ---------------------------------------------------------------------------

/// 一次材质解析的产物：喂给 `InMemoryResources` 的三张表。
#[derive(Default)]
struct PakMaterials {
    /// `材质名 → PNG 字节`（对应 `InMemoryResources` 的 `textures`）。
    /// 键取自 `vmdl` 的纹理名，须与下面这个查表键逐字符一致，否则该贴图进不了 GLB：
    /// `src/wasm-core/model_integrator/mod.rs` 的 `push_texture`。
    textures: HashMap<String, Vec<u8>>,
    /// `材质名 → alpha_mode`（对应 `InMemoryResources` 的 `material_alpha_mode`）：
    /// 1 = Blend（双面）、2 = Mask（`alphaCutoff = 0.5`）、0 = Opaque。
    alpha_modes: HashMap<String, u8>,
    /// 自发光 / 无光照材质名集合（对应 `InMemoryResources` 的 `material_unlit`）；
    /// 渲染侧据此走全亮，不吃 lightmap 与 ambient cube。
    unlit: std::collections::HashSet<String>,
}

/// 收集 PAKFILE 里的内嵌模型：被 `static_props` 引用、且 `.mdl` / `.vvd` / `.dx90.vtx` 三件齐全的那些。
///
/// 返回 `(三件套字节, 静态道具放置表, PAKFILE 全部条目名)`：
/// - 三件套只收 `static_props` 的模型名在 zip 里精确命中的条目，缺任一件即跳过该模型；
/// - 放置表逐项来自 `Bsp::static_props()`，同时补齐 `ambient_cube`（`Bsp::prop_ambient_cube` 给的
///   leaf 环境盒）与 `vertex_lighting`（同一轮扫描顺手取出的 `sp_<idx>.vhv` 顶点光照，HDR 优先）；
/// - 第三项是留给 [`pakfile_models::PakIndex`] 复用的条目名清单，免得为了找材质再遍历一次 zip。
///
/// zip 索引只锁一次：锁在本轮条目扫描期间一直持有，扫描结束立刻释放。
fn collect_pakfile_models(
    bsp: &vbsp::Bsp,
) -> Result<(Vec<InMemoryModel>, Vec<StaticProp>, Vec<String>), JsValue> {
    // 1. 静态道具引用到的模型名（字典里的名字，与 zip 条目名按原样比较）
    let mut referenced: std::collections::HashSet<String> = std::collections::HashSet::new();
    for prop in bsp.static_props() {
        referenced.insert(prop.model().to_string());
    }

    // 2. 一次遍历枚举全部条目：收集条目名，并顺手挑出 sp_<idx>.vhv 顶点光照
    let zip = bsp.pack.clone().into_zip();
    let mut zip_guard = zip
        .lock()
        .map_err(|e| JsValue::from_str(&format!("pakfile 锁定失败: {e}")))?;
    let mut entry_names: Vec<String> = Vec::with_capacity(zip_guard.len());
    // vhv 命名是 `sp_<idx>.vhv` 与 `sp_hdr_<idx>.vhv`（idx 对应 static_props 的序号）：
    // 同一个 idx 上 HDR 版本覆盖非 HDR 版本；解析不出下标、读失败或读出空字节的条目直接丢弃。
    let mut vhv_blobs: std::collections::HashMap<usize, Vec<u8>> = std::collections::HashMap::new();
    for i in 0..zip_guard.len() {
        if let Ok(mut entry) = zip_guard.by_index(i) {
            let name = entry.name().to_string();
            let lower = name.to_ascii_lowercase();
            if lower.starts_with("sp_") && lower.ends_with(".vhv") {
                let mid = &lower[3..lower.len() - 4];
                let (idx_part, is_hdr) = match mid.strip_prefix("hdr_") {
                    Some(rest) => (rest, true),
                    None => (mid, false),
                };
                if let Ok(idx) = idx_part.parse::<usize>() {
                    let mut buf = Vec::with_capacity(entry.size() as usize);
                    if std::io::Read::read_to_end(&mut entry, &mut buf).is_ok() && !buf.is_empty() {
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

    // 3. 逐个被引用模型取三件套：`.mdl` 命中后按名替换出 `.vvd` / `.dx90.vtx`，缺一即跳过
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

    // 4. 放置表：本工程只喂 GLB 节点；带碰撞导出的工程另用同一个字段
    let static_props: Vec<StaticProp> = bsp
        .static_props()
        .enumerate()
        .map(|(i, prop)| StaticProp {
            model: prop.model().to_string(),
            origin: [prop.origin.x, prop.origin.y, prop.origin.z],
            angles: prop.angles(),
            solid: prop.solid as u8,
            ambient_cube: bsp.prop_ambient_cube(i),
            vertex_lighting: vhv_blobs
                .get(&i)
                .and_then(|b| websurf_wasm_core::vhv::parse_vhv(b))
                .map(|v| v.colors),
        })
        .collect();

    Ok((models, static_props, entry_names))
}

/// 单个 VTF 字节 → PNG 字节（导出给 TS 侧天空盒解码；内部材质解析同样调用它）。
/// 只解最高分辨率图的第 0 帧；三条失败链各自带上下文：VTF 解析 / 图像解码 / PNG 编码。
#[wasm_bindgen] pub fn decode_vtf_to_png(data: &[u8]) -> Result<Vec<u8>, JsValue> {
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

/// 解析被引用模型的材质标注与贴图：取 `.vmt` 得 `alpha_mode` / `unlit` / `$basetexture`，
/// 再按 `$basetexture` 取 `.vtf` 解码为 PNG；`patch` 材质多跟一层 `include` 母材质。
///
/// VMT 候选路径按 `mdl.textures[].search_paths` 与 `mdl.texture_paths` 逐条拼上材质名，末尾补一条
/// 裸材质名；查询一律走 [`pakfile_models::PakIndex::find`]。已解析过的材质名不再重复解析。
///
/// `fallback` = 默认纹理包（`textures.mtz` 解压产物，键形如 `materials/<小写路径>`）：pakfile 内
/// 没有该 VTF 时，按 `$basetexture` 路径与材质名依次查包取低清纹理补位；传 `None` 即不回落，
/// 此时没有 pakfile VTF 的材质没有贴图。（与 game crate 同签名同语义；2026-10-04 起 viewer 的
/// 主导出路径传入回退表。）
fn resolve_pakfile_materials(
    bsp: &vbsp::Bsp,
    models: &[InMemoryModel],
    index: &pakfile_models::PakIndex,
    fallback: Option<&std::collections::HashMap<String, String>>,
) -> PakMaterials {
    let mut out = PakMaterials::default();

    // 闭包：按候选路径取 VMT 文本并解析（取不到返回 None）
    let fetch_vmt = |path: &str| -> Option<pakfile_models::VmtInfo> {
        let entry = index.find(path, "vmt")?;
        let bytes = match bsp.pack.get(entry) {
            Ok(Some(b)) => b,
            _ => return None,
        };
        Some(pakfile_models::parse_vmt(&String::from_utf8_lossy(&bytes)))
    };

    for m in models {
        // 纹理名表只在 .mdl 里，故不碰 .vvd / .dx90.vtx
        let Ok(mdl) = vmdl::Mdl::read(&m.mdl) else {
            continue;
        };

        for tex in &mdl.textures {
            if out.alpha_modes.contains_key(&tex.name) {
                continue; // 共享材质只解析一次
            }

            // 候选路径：每个搜索目录拼一个，最后再补一个裸材质名
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
                // VMT 没打包进来 → 该材质按 Opaque 记一笔
                out.alpha_modes.insert(tex.name.clone(), 0);
                continue;
            };

            // patch 材质：跟一层 include 取母材质的 $basetexture；本材质未标透明度时继承母材质
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

/// BSP 光照实体（classname ∈ `LIGHT_CLASSNAMES`）→ [`model_integrator::Entity`]。
///
/// 只搬运光照解析要用的属性子集：`model`/`origin`/`angles`/`scale` 与 `_light`/`_cone`/
/// `_inner_cone`/三个衰减系数/`pitch`；取不到的属性一律留成 `None`，`classname` 取不到则跳过该实体。
/// 消费端 [`ModelIntegrator`] 把这些实体写成 `KHR_lights_punctual` 扩展（渲染端 buildMapScene 摘除）。
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

// ---------------------------------------------------------------------------
// 元数据与解析入口
// ---------------------------------------------------------------------------

/// `BspProcessor::metadata()` 的返回值：序列化成 JSON 字符串交给前端 `JSON.parse`。
///
/// 不标 `#[wasm_bindgen]`：本结构体只用于序列化，不跨边界暴露字段或方法。字段与来源：
/// `schema_version` 固定为 1；`magic` 由 `header` 的 v/b/s/p 四个字节拼成；`map_name` 当前恒为空串
/// （`from_bsp` 不填该字段）；`num_models` / `num_faces` / `num_vertices` / `num_brushes` 直接取
/// `Bsp` 对应 lump 的长度；`num_static_props` 现数一遍 `Bsp::static_props()`；`packed_files` 由
/// `BspProcessor::new` 缓存后传入。键名与 `apps/viewer/src/core/bsp.ts` 的 `BspMeta` 一一对应，
/// TS 侧字段全部可选，缺键不报错。
#[derive(serde::Serialize)]
pub struct BspMetadata {
    pub schema_version: u32,
    /// BSP 魔术字，由 `header` 的 v/b/s/p 拼成（如 "VBSP"）。
    pub magic: String,
    pub map_name: String,
    pub num_models: usize,
    pub num_faces: usize,
    pub num_vertices: usize,
    pub num_brushes: usize,
    pub num_static_props: usize,
    /// pakfile 的 zip 条目数（不是解压后的总字节数）。
    pub packed_files: usize,
}

impl BspMetadata {
    /// 由 `Bsp` 现算元数据；`packed_files` 由 `BspProcessor` 缓存的字段传入——
    /// `Packfile` 的 zip 字段私有（`src/wasm-core/vbsp/data/mod.rs`），取条目数只能先 `clone()`
    /// 再 `into_zip()`（消费 self），故在构造期算一次、此后复用，免得每次 `metadata()` 都克隆。
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
// 处理器：持有 Bsp 实例，三个方法各取所需
// ---------------------------------------------------------------------------

/// BSP 处理器：`new` 解析字节数组并缓存元数据要用的计数，之后调用各取值 / 导出方法。
///
/// 顺序契约：`export_glb_with_pakfile_models` 会把内部 `Bsp`（`Arc<Bsp>`）`take()` 走，
/// 因此必须排在 `metadata` / `parse_spawn_points` 之后；被取走后再调这两个方法会返回
/// `"BSP 未解析或已导出"` 错误。
#[wasm_bindgen]
pub struct BspProcessor {
    bsp: Option<std::sync::Arc<vbsp::Bsp>>,
    /// 构造期缓存下来的 pakfile 条目数（zip 字段私有，取 len 得先 clone + into_zip）
    packed_files: usize,
}

#[wasm_bindgen]
impl BspProcessor {
    /// 解析 BSP 字节并建处理器；解析失败时转成上下文为 "BSP 解析失败" 的 JS 错误。
    /// 同时把 pakfile 条目数一次算好存进 `packed_files`（共享层 `Packfile` 的锁中毒会 panic，
    /// 这里同样直接 `unwrap`）。
    #[wasm_bindgen(constructor)]
    pub fn new(data: &[u8]) -> Result<BspProcessor, JsValue> {
        let bsp = vbsp::Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;
        // zip 只在这里 clone 一次：Packfile 没有「只读条目数」的接口
        let packed_files = bsp.pack.clone().into_zip().lock().unwrap().len();
        Ok(BspProcessor {
            bsp: Some(std::sync::Arc::new(bsp)),
            packed_files,
        })
    }

    /// 元数据 JSON 字符串；借用内部 `Bsp`，不消耗它。
    /// 实例已被导出方法取走时返回 "BSP 未解析或已导出" 错误。
    pub fn metadata(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;
        let metadata = BspMetadata::from_bsp(bsp, self.packed_files);
        metadata.to_json()
    }

    /// 提取出生点实体，返回 JSON 报告（该工程初始视角与面板 ★ 标记的数据源）。
    ///
    /// 收录判据两道：`classname` 命中 `SPAWN_CLASSNAMES` 里的某一项，或（不看是否命中）以
    /// `info_player_` 开头；随后 `origin` 必须能解析出三个分量，否则整条跳过。
    /// `info_teleport_destination` 只走第一道判据，充当「没有玩家出生点时」的备用点。
    ///
    /// 输出 JSON：`{ "spawn_points": [{ classname, origin: [x,y,z], angles: [p,y,r],
    /// origin_raw, angles_raw }], "total": N, "primary": N|null }`。
    /// - `origin` 已做 Z-up → Y-up 旋转（`[x,y,z] → [y,z,x]`，det = +1），与地图 GLB 同一变换；
    /// - `angles` 保持 BSP 原始次序 `[pitch, yaw, roll]`（度），由消费端自行换算；
    /// - `origin_raw` / `angles_raw` 是实体文本里的原始字符串，`angles` 缺键时为 null；
    /// - `primary` = 首个 `info_player_start` 的下标，没有时回落收录列表的第 0 条，列表为空时为 null。
    ///
    /// 两处输入约定来自共享层：实体文本在 `src/wasm-core/vbsp/reader.rs` 的 `read_entities` 里
    /// 已整体小写化，故这里的 classname 字面量全用小写；`prop` 缺键返回错误、值为空串时照常返回空串。
    /// 分量解析用函数内的 `parse_vec3`：按空白切分并取前三个 `f32`，逗号分隔的写法（`"1,2,3"`）
    /// 切不出三个分量，该条会被跳过。不消耗内部 `Bsp`；被导出方法取走时同样返回错误。
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

        // 位置旋转 [x,y,z] → [y,z,x]（正交、det = +1；BSP Z-up → 地图 Y-up）
        fn rotate_yup(v: [f32; 3]) -> [f32; 3] {
            [v[1], v[2], v[0]]
        }

        // 收录用的 classname 字面量（与下面的 info_player_ 前缀判据并列，两份都算命中）
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
            // 前缀判据：任何 info_player_* 都算出生点候选
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

            // 首个 info_player_start 记为 primary（下标是收录顺序，不是实体序）
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

        // 没有 info_player_start：回落到收录列表的第 0 条
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

    /// 导出 GLB：把 PAKFILE 里被静态道具引用的模型（`.mdl` / `.vvd` / `.dx90.vtx` 三件套）连同
    /// 贴图并进同一张地图，而不是另发一个文件。
    ///
    /// 流程：`collect_pakfile_models` 取三件套 + 放置表 + 条目名 → 用条目名建
    /// [`pakfile_models::PakIndex`] → `resolve_pakfile_materials` 解 VMT/VTF（PNG 字节、透明度档位、
    /// 无光照名集合）→ 组装 `InMemoryResources` 与 `ModelIntegrator` →
    /// 调 [`bsp_to_gltf_core::export_bsp_with_models`] 合并导出，再写进 `Vec<u8>`。
    ///
    /// 回退：一个被引用模型都没收集到时改用 [`bsp_to_gltf_core::export_bsp`] 走纯地图导出，不报错；
    /// 单张贴图解码失败同样只跳过该项。
    ///
    /// 副作用：`&mut self`，内部 `Bsp` 被 `take()` 走（导出函数要的是所有权），调用之后
    /// `metadata` / `parse_spawn_points` 一律返回 "BSP 未解析或已被导出消费，请重新 new"。
    pub fn export_glb_with_pakfile_models(&mut self) -> Result<Vec<u8>, JsValue> {
        let bsp = self
            .bsp
            .take()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;

        // 1~3. 三件套 + 放置表 + PAKFILE 条目名
        let (models, static_props, entry_names) = collect_pakfile_models(&bsp)?;

        // 4. 没有任何被引用模型：纯地图导出（Bsp 同样已被取走）
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

        // 5. VMT/VTF → 贴图字节 + 透明度档位 + 无光照名集合（裸导出无回退表）
        let index = pakfile_models::PakIndex::build(&entry_names);
        let materials = resolve_pakfile_materials(&bsp, &models, &index, None);

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

    /// 导出 GLB（含 PAKFILE 模型 + **默认纹理回退** + BSP 光照实体）——viewer 的主导出入口。
    ///
    /// `defaults_json` 是默认纹理包文本（`{ "materials/<材质路径小写>": "#mosaic v4 字节码" }`，
    /// TS 侧由 `textures.mtz` 经 [`decompress_mtz`] 解出），解析失败即报「默认纹理包 JSON 解析失败」；
    /// pakfile 内没有该 VTF 的材质用它解码出的低清纹理补位。世界面另经 `vmt_stem_index`（基名
    /// VMT 回退）命中作者写的 VMT。与 game crate 的同名方法同一实现（2026-10-04 对齐，owner
    /// 裁决三应用渲染以 game 为基准）。
    ///
    /// 失败不消费实例：失败后 `self.bsp` 仍为 `Some`，同一实例可再次导出（TS 侧失败时回退裸导出）。
    pub fn export_glb_with_pakfile_models_with_defaults_and_lights(
        &mut self,
        defaults_json: &str,
    ) -> Result<Vec<u8>, JsValue> {
        let bsp = self
            .bsp
            .take()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;
        // 失败不消费实例：实现核拿的是 Arc 克隆，失败时把原 Arc 放回，TS 侧可回退裸导出
        match Self::export_glb_with_defaults_impl(bsp.clone(), defaults_json, true) {
            Ok(result) => {
                let mut output: Vec<u8> = Vec::new();
                result
                    .glb
                    .to_writer(&mut output)
                    .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;
                Ok(output)
            }
            Err(e) => {
                self.bsp = Some(bsp);
                Err(e)
            }
        }
    }

    /// [`BspProcessor::export_glb_with_pakfile_models_with_defaults_and_lights`] 的实现核
    /// （消费传入的 `Bsp`；`include_lights` 决定是否注入 `KHR_lights_punctual` 灯实体）。
    fn export_glb_with_defaults_impl(
        bsp: std::sync::Arc<vbsp::Bsp>,
        defaults_json: &str,
        include_lights: bool,
    ) -> Result<bsp_to_gltf_core::ExportResult, JsValue> {
        let fallback: std::collections::HashMap<String, String> =
            serde_json::from_str(defaults_json)
                .map_err(|e| to_js_err(e, "默认纹理包 JSON 解析失败"))?;

        let (models, static_props, entry_names) = collect_pakfile_models(&bsp)?;

        // 世界面材质的基名 VMT 回退索引（texinfo 给的贴图名在包内无精确路径时按基名命中）
        let stem_index = build_vmt_stem_index(&entry_names);

        let options = bsp_to_gltf_core::ConvertOptions {
            missing_fallback: fallback.clone(),
            vmt_stem_index: stem_index,
            ..bsp_to_gltf_core::ConvertOptions::default()
        };

        // 无模型时仍走整合器路径（空模型不产出节点，光照注入照常发生）——与 game 同语义
        let index = pakfile_models::PakIndex::build(&entry_names);
        let materials = resolve_pakfile_materials(&bsp, &models, &index, Some(&fallback));
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
        let integrator =
            ModelIntegrator::from_in_memory(resources, ExportOptions { include_lights });
        bsp_to_gltf_core::export_bsp_with_models(bsp, options, Some(&integrator))
            .map_err(|e| to_js_err(e, "GLB 导出失败"))
    }
}

/// MTZ 容器字节（魔数 `MTZ6`，兼容读 `MTZ5`）→ JSON 对象文本：`键 → "#mosaic v4 字节码"`。
/// 键取条目 `B[名字:宽x高]` 的名段里 `|` 之前的一段（形如 `materials/buildings/antn00`）；
/// 错误文本前缀 `decompress_mtz`，本工程由 `apps/viewer/src/core/bsp.ts` 构建 defaults_json 用
/// （2026-10-04 起，与 game/debug 同款）。
#[wasm_bindgen]
pub fn decompress_mtz(bytes: &[u8]) -> Result<String, JsValue> {
    websurf_wasm_core::mosaic::mtz::decompress_mtz(bytes)
        .map_err(|e| JsValue::from_str(&format!("decompress_mtz: {e}")))
}


// ---------------------------------------------------------------------------
// T-417：2D 天空盒复用 `src/renderer-shared/environment/skybox.ts` 的同一套 TS 逻辑，
// 需要与 debug / game 同形的两个导出。追加为**独立 `impl` 块**，既有行号一格不移（保住文档锚点）。
// ---------------------------------------------------------------------------

#[wasm_bindgen]
impl BspProcessor {
    /// 实体集合 JSON：字段与 debug / game 的同名导出一致（天空盒取 `worldspawn.skyname`）。
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
            let classname = ent.prop("classname").map(|s| s.to_string()).unwrap_or_default();
            let targetname = ent.prop("targetname").map(|s| s.to_string()).unwrap_or_default();
            let origin_raw = ent.prop("origin").map(|s| s.to_string()).unwrap_or_default();
            let model_raw = ent.prop("model").ok().map(|s| s.to_string());
            let mut props = std::collections::BTreeMap::new();
            let mut outputs = Vec::new();
            for (key, val) in ent.properties() {
                if key.starts_with("On") || key.starts_with("on") {
                    outputs.push(format!("{} {}", key, val));
                } else {
                    props.insert(key.to_string(), val.to_string());
                }
            }
            result.push(EntityOut { index: i, classname, targetname, props, outputs, origin_raw, model_raw });
        }

        serde_json::to_string(&result).map_err(|e| JsValue::from_str(&format!("序列化失败: {e}")))
    }

    /// 读取 pakfile 内文件字节（找不到返回空数组）；供天空盒取 6 面 VTF。
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

    /// 解析 PVS（可见性）数据：节点 / 叶簇 AABB / 每簇可见位串 —— 供渲染端 PVS 剔除与 3D 天空盒
    /// 的天空区判据（「图元采样点所在的 BSP cluster」）使用。
    ///
    /// 与 debug/game 同一导出同签名同载荷（本工程薄导出层的副本）：节点 plane normal 与叶簇
    /// mins/maxs 按 [x,y,z]→[y,z,x] 转到 Three.js Y-up，plane dist 不变。这是**解析层**接口
    /// （websurf-wasm-core），不含物理与碰撞——本工程仍不引入 websurf-phys。
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
}
