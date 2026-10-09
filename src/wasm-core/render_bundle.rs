//! 三端 WASM 导出层的共享编排：PAKFILE 内嵌模型提取、材质解析与碰撞体派生。
//!
//! **纯 Rust、零 wasm-bindgen**：本文件不出现绑定层的导出属性、JS 值类型，也不出现绑定
//! crate 的路径前缀；这些只允许留在各端 `apps/*/crates/wasm/src/lib.rs`。
//!
//! 职责（调用方是三个工程的 `crates/wasm/src/lib.rs` 薄壳）：
//! - [`collect_pakfile_models`]：枚举 PAKFILE，取出被引用的 `.mdl` / `.vvd` / `.dx90.vtx` 三件套、
//!   静态道具放置表（含 `sp_<idx>.vhv` 逐顶点光照）与全部条目名；
//! - [`resolve_pakfile_materials`]：`.vmt` 标注（透明度档位 / unlit / `$envmaptint`）与
//!   `$basetexture` → `.vtf` → PNG；
//! - [`build_vmt_stem_index`]：世界面材质的 VMT 基名回退索引；
//! - [`collect_light_entities`]：`light` / `light_spot` / `light_environment` → 集成器实体；
//! - [`load_vmdl`]：内存三件套 → `vmdl::Model`；
//! - [`ColliderFilter`] 与 [`entity_is_non_solid`] / [`model_classnames`] /
//!   [`brush_model_indices`] / [`build_brush_model_origins`] / [`aabb_volume`]：碰撞体导出的过滤与归属派生。
//!
//! 边界：只做解析与装配，产出 Rust 类型；转 JS 错误值、序列化 JSON、`Option::take` 消费 BSP 等
//! 薄壳职责留在各端。本模块不接触 DOM / 渲染 / 物理模拟。
//!
//! 不变量（搬动自各端时逐条保留，导出结果须与搬动前逐字节相同）：
//! - 跨端差异一律用**形参**表达，不留分叉实现：`collect_pakfile_models` 的
//!   `case_insensitive_model_names`（viewer 按小写比对被引用模型名，debug/game 精确比对）与
//!   `vhv_log`（三端 stderr 口径不同）；`resolve_pakfile_materials` 的 `decode_textures`
//!   （viewer 恒 `true`）。
//! - 提取与解析**不产生失败返回**：单条目读取失败、`vhv` 解析失败、三件套缺件都只跳过并计数。
//!   [`collect_pakfile_models`] 的唯一 `Err` 是 PAKFILE 互斥锁被毒化，文本为
//!   `pakfile 锁定失败: <Debug>`；各端把该文本原样转成 JS 错误值，不经 `to_js_err`
//!   （那会多一层 `ctx` 前缀，改变 JS 侧看到的文本）。
//! - 候选路径顺序、同名材质只解析一次、`PakIndex::find` 取首个命中等语义不得改动。
//! - 二进制产物一律以 `Vec<u8>` 返回，由调用方在 WASM 边界复制成 JS 侧 `Uint8Array`。

use std::collections::{HashMap, HashSet};

use crate::model_integrator::{self, InMemoryModel, StaticProp};
use crate::{bsp_to_gltf_core, pakfile_models, texture_utils, vbsp};

// ---------------------------------------------------------------------------
// PAKFILE 内嵌资源：材质三张表 / 模型三件套 / 光源实体
// ---------------------------------------------------------------------------

/// 一次材质解析的产物：喂给 `InMemoryResources` 的三张表加一张渲染端回退表。
#[derive(Default)]
pub struct PakMaterials {
    /// `材质名 → PNG 字节`。键须与 `vmdl::TextureInfo::name` 逐字符一致，供 `push_texture` 查表。
    /// 只收 `$basetexture` 命中、VTF 取到且解码成功的条目；`decode_textures = false` 时整表为空。
    pub textures: HashMap<String, Vec<u8>>,
    /// `材质名 → alpha_mode`（0 = Opaque，1 = Blend，2 = Mask）。
    /// VMT 未打包或候选路径全未命中时写 0；与是否解码纹理无关，只要扫到材质就写。
    pub alpha_modes: HashMap<String, u8>,
    /// 自发光 / 无光照材质名集合（`$selfillum` / `UnlitGeneric`）：`InMemoryResources.material_unlit`
    /// 的输入（共享层用 `extras.unlit` 标记这类图元；缺失会让自发光 prop 被当受光材质处理）。
    pub unlit: HashSet<String>,
    /// `材质名 → $envmaptint`（仅 `$envmap` 材质）：渲染端据此挂 env_cubemap 近似反射。
    pub envmap_tints: HashMap<String, [f32; 3]>,
}

/// `collect_pakfile_models` 末尾那条 `vhv` 统计日志的口径（三端历史差异，逐端保留）。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum VhvLog {
    /// 不打印（viewer 口径）。
    Never,
    /// 无条件打印（game 口径）。
    Always,
    /// 仅当命中过 `sp_<idx>.vhv` 或存在静态道具时打印（debug 口径）。
    IfAnyProp,
}

/// 提取被静态道具或带模型实体引用、且 `.mdl` / `.vvd` / `.dx90.vtx` 三件齐全的模型。
///
/// 返回 `(模型三件套, 静态道具放置表, PAKFILE 全部条目名)`；第三项是**未过滤**的全部条目名，
/// 供 [`pakfile_models::PakIndex`] 复用，避免为找材质再遍历 zip。
///
/// `case_insensitive_model_names`：被引用模型名与 zip 条目名的比对口径——`true` 时两侧都按
/// ASCII 小写比对（viewer 口径），`false` 时逐字符相等（debug/game 口径）。`vhv_log` 见
/// [`VhvLog`]。
///
/// 失败语义：zip 互斥锁被毒化时返回已成型的中文错误文本，其余情况一律不失败——单个条目读取出错、
/// `sp_*.vhv` 解析失败、模型三件套缺件都只跳过该条目并计数。
pub fn collect_pakfile_models(
    bsp: &vbsp::Bsp,
    case_insensitive_model_names: bool,
    vhv_log: VhvLog,
) -> Result<(Vec<InMemoryModel>, Vec<StaticProp>, Vec<String>), String> {
    let fold = |s: &str| -> String {
        if case_insensitive_model_names {
            s.to_ascii_lowercase()
        } else {
            s.to_string()
        }
    };

    // 1. 被静态道具**或带模型实体**（`prop_dynamic` 等）引用的模型路径集合
    let mut referenced: HashSet<String> = HashSet::new();
    let prop_models = bsp.static_props().map(|p| fold(p.model()));
    let ent_models = bsp
        .entities
        .iter()
        .filter_map(|e| e.prop("model").ok().map(&fold));
    for m in prop_models.chain(ent_models) {
        referenced.insert(m);
    }

    // 2. 枚举 PAKFILE 全部条目，zip 只锁一次；同一遍扫描顺手读走 prop_static 的
    //    逐顶点预烘焙光照 `sp_<idx>.vhv` / `sp_hdr_<idx>.vhv`（键 = prop 下标），不额外开锁。
    let zip = bsp.pack.clone().into_zip();
    let mut zip_guard = zip.lock().map_err(|e| format!("pakfile 锁定失败: {e}"))?;
    let mut entry_names: Vec<String> = Vec::with_capacity(zip_guard.len());
    let mut vhv_blobs: HashMap<usize, Vec<u8>> = HashMap::new();
    for i in 0..zip_guard.len() {
        if let Ok(mut entry) = zip_guard.by_index(i) {
            let name = entry.name().to_string();
            let lower = name.to_ascii_lowercase();
            // 只收 sp_<数字>.vhv；HDR 版（sp_hdr_<数字>.vhv）优先且不被非 HDR 版覆盖：
            // 条目名先整体小写，再要求 sp_ 前缀 + .vhv 后缀，中段剥掉 hdr_ 后须能解析成 usize
            // 下标，读出的字节非空才算命中。写入条件是 `is_hdr || !contains_key(idx)`。
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

    // 3. 仅为「名字以 .mdl 结尾且属于被引用集合」的条目取三件套；缺任一件即跳过该模型。
    //    后两件的名字由 `.mdl` 尾部 4 字节整体替换而来（`str::replace` 替换全部出现处，非只改后缀）。
    //    后缀判断走 `to_ascii_lowercase()`，归属判断走上面的比对口径，两者可以不一致。
    let mut models: Vec<InMemoryModel> = Vec::new();
    for name in &entry_names {
        if !name.to_ascii_lowercase().ends_with(".mdl") || !referenced.contains(&fold(name)) {
            continue;
        }
        let vvd_name = format!("{}.vvd", &name[..name.len() - 4]); // 去尾部 4 字节（`.mdl`，任意大小写）再拼后缀
        let vtx_name = format!("{}.dx90.vtx", &name[..name.len() - 4]);
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

    // 4. 静态道具放置表：GLB 节点与碰撞体共用同一份派生，逐实例挂两级光照——第 1 级是
    //    `vhv_blobs` 里的逐顶点预烘焙光照（解析出 `colors` 才计成功），第 2 级是
    //    `bsp.prop_ambient_cube(i)` 的 leaf ambient cube；两者都取不到时字段为 `None`，
    //    由集成层 / 渲染端自行回退。`solid` 直接透传实体的 solid 数值（`as u8`）。
    let mut vhv_ok = 0usize;
    let mut vhv_bad = 0usize;
    let static_props: Vec<StaticProp> = bsp
        .static_props()
        .enumerate()
        .map(|(i, prop)| {
            let vertex_lighting = match vhv_blobs.get(&i).and_then(|b| crate::vhv::parse_vhv(b)) {
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

    let log = match vhv_log {
        VhvLog::Never => false,
        VhvLog::Always => true,
        VhvLog::IfAnyProp => !vhv_blobs.is_empty() || !static_props.is_empty(),
    };
    if log {
        eprintln!(
            "[vhv] prop 逐顶点预烘焙光照：pakfile 命中 {} 个文件，解析成功 {} 个，解析失败 {} 个，共 {} 个 prop",
            vhv_blobs.len(),
            vhv_ok,
            vhv_bad,
            static_props.len()
        );
    }

    Ok((models, static_props, entry_names))
}

/// 从 BSP 实体里挑出**真光源**（`light` / `light_spot` / `light_environment`），
/// 转成 `model_integrator::Entity` 供集成器消费。
///
/// 只认这三个 `classname`（逐字符比较，实体文本已在解析期整体小写），其余实体跳过。每个命中实体取
/// `model` / `origin` / `angles` / `scale` 与 6 个光照键 `_light` / `_cone` / `_inner_cone` /
/// `_constant_attn` / `_linear_attn` / `_quadratic_attn`，外加 `pitch`；这些键缺失时对应字段为
/// `None`。消费方据此写 `KHR_lights_punctual`。
pub fn collect_light_entities(bsp: &vbsp::Bsp) -> Vec<model_integrator::Entity> {
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
            }, ambient_cube: None, // 灯实体没有模型，不查 leaf ambient cube
        });
    }
    out
}

/// 把内存三件套读成 `vmdl::Model`：按 `Mdl` → `Vtx` → `Vvd` 顺序读，任一环节 `Err` 即返回 `None`。
///
/// 只判成败、不区分失败原因，故调用点无法分辨是哪一个文件坏了。
pub fn load_vmdl(m: &InMemoryModel) -> Option<vmdl::Model> {
    let mdl = vmdl::Mdl::read(&m.mdl).ok()?;
    let vtx = vmdl::Vtx::read(&m.vtx).ok()?;
    let vvd = vmdl::Vvd::read(&m.vvd).ok()?;
    Some(vmdl::Model::from_parts(mdl, vtx, vvd))
}

/// 从 PAKFILE 条目名构建 VMT **基名索引**：`基名小写 → 去掉 materials/ 前缀与 .vmt 后缀的路径`。
///
/// 只收 `materials/` 下、以 `.vmt` 结尾的条目；值保留条目原始大小写（`Packfile::get` 按名精确
/// 匹配）。产物填进 `bsp_to_gltf_core::ConvertOptions` 的 `vmt_stem_index`，供世界面的贴图名在
/// 精确候选全部落空时按基名回退取 `$basetexture` 等标注（texinfo 名形如
/// `METAL/METALGRATE013A2`，包内同名 VMT 却在别的子目录下）。
///
/// 同名多条时取**路径最短**者；与当前值等长时保留先到的一条。
pub fn build_vmt_stem_index(entry_names: &[String]) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
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

/// 解析所有被引用模型的材质：从 PAKFILE 取 `.vmt` 得透明度标注，再按 `$basetexture` 取 `.vtf`
/// 解码为 PNG。
///
/// `decode_textures = false` 时只填 `alpha_modes` / `unlit` / `envmap_tints`、跳过图像解码
/// （碰撞体路径用此模式）；viewer 的调用点恒传 `true`（其原实现无该分支）。
///
/// 每个材质名只处理一次（`alpha_modes` 已有该键就跳过），候选路径按 `TextureInfo::search_paths`
/// 接 `Mdl::texture_paths` 的顺序展开（反斜杠归一为 `/`、去首尾 `/`），末尾再补一条裸材质名；
/// 逐条交 [`pakfile_models::PakIndex::find`] 查表，取**首个**命中。`find` 本身大小写不敏感，并按
/// 「原样 / `materials/` / `models/` / `materials/models/` 补后缀」四个候选加一条「只按基名」回退
/// 依次试。
///
/// `fallback` = 默认纹理包（textures.mtz 解压产物，键形如 `materials/<小写路径>`）：pakfile 内没有
/// 该 VTF（stock 贴图未打包）时，按 `$basetexture` 路径与材质名依次查包取低清纹理补位。传 `None`
/// 即不回落，此时没有 pakfile VTF 的材质没有贴图——模型会以基色因子着色（`alphaMode` 为 `MASK`
/// 的格栅/铁丝网会因基色 alpha 恒为 1 而整块变实心）。
///
/// 容错：候选全不中时按 alpha_mode 0（不透明）记账并继续；`$basetexture` 缺失时只跟一层 `include`
/// 指向的母材质（母材质半透明而 `patch` 自身为 0 时继承母材质的 alpha_mode）；VTF 条目找不到或
/// 解码失败都只跳过图像，不产生错误返回。
pub fn resolve_pakfile_materials(
    bsp: &vbsp::Bsp,
    models: &[InMemoryModel],
    index: &pakfile_models::PakIndex,
    decode_textures: bool,
    fallback: Option<&HashMap<String, String>>,
) -> PakMaterials {
    let mut out = PakMaterials::default();

    // 从 PAKFILE 取 VMT 文本并解析成标注（索引未命中或整包取不到字节都算未命中）
    let fetch_vmt = |path: &str| -> Option<pakfile_models::VmtInfo> {
        let entry = index.find(path, "vmt")?;
        let bytes = match bsp.pack.get(entry) {
            Ok(Some(b)) => b,
            _ => return None,
        };
        Some(pakfile_models::parse_vmt(&String::from_utf8_lossy(&bytes)))
    };

    for m in models {
        // 只读 .mdl 枚举材质（不走 from_parts，省掉 Vtx/Vvd 解析）
        let Ok(mdl) = vmdl::Mdl::read(&m.mdl) else {
            continue;
        };

        for tex in &mdl.textures {
            if out.alpha_modes.contains_key(&tex.name) {
                continue; // 同一材质名只解析一次
            }

            // 候选路径：搜索目录 + 材质名，末尾再补裸材质名
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
            if let Some(t) = info.envmap_tint {
                out.envmap_tints.insert(tex.name.clone(), t);
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
                    if let Some(png) = decode_vtf_png(&vtf_bytes) {
                        out.textures.insert(tex.name.clone(), png);
                        continue;
                    }
                }
            }
            // pakfile 内没有这张 VTF（stock 贴图未打包）时退到默认纹理包。查表键经
            // `bsp_to_gltf_core::fallback_key` 归一成 `materials/<小写路径>`，故这里按
            // `$basetexture` 路径与材质名依次试：模型材质名常是裸基名（`metalfence007a`），
            // 包里的键却是源资源路径（`materials/metal/metalfence007a`）。
            if let Some(fallback) = fallback {
                if let Some(png) = bsp_to_gltf_core::fallback_texture_png(
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

/// VTF 字节 → PNG 字节：取最高分辨率图的第 0 帧重新编码。
///
/// 与各端导出的 `decode_vtf_to_png` 是同一实现的三步（VTF 解析 / 图像解码 / PNG 编码），
/// 差别只在失败一律折成 `None`——本函数的唯一调用点（[`resolve_pakfile_materials`]）不区分
/// 失败原因，需要带上下文的错误文本时由各端自己的导出函数给出。
fn decode_vtf_png(data: &[u8]) -> Option<Vec<u8>> {
    let vtf = texture_utils::from_bytes(data).ok()?;
    let image = vtf.highres_image.decode(0).ok()?;

    let mut output: Vec<u8> = Vec::new();
    image
        .write_to(
            &mut std::io::Cursor::new(&mut output),
            ::image::ImageFormat::Png,
        )
        .ok()?;

    Some(output)
}

// ---------------------------------------------------------------------------
// 碰撞体导出：过滤参数与 brush / 模型归属派生
// ---------------------------------------------------------------------------

/// 碰撞体导出过滤参数，由前端以 JSON 传入，控制导出哪些 brush。所有字段可选，缺失时用默认值：
/// - `include_ladder` / `include_solid`（默认 true）：是否导出 LADDER / SOLID brush；
/// - `min_brush_volume`（f32，默认 0）：跳过 AABB 体积小于此值的 brush；
/// - `skip_sky`（默认 false）：跳过含 SKY 纹理的 brush。**碰撞只看 contents**，纹理不参与；
/// - `skip_nodraw`（默认 false）：跳过含 NODRAW 纹理的 brush（NODRAW 只影响渲染不影响碰撞）。
///
/// 示例：`{"skip_sky": false, "min_brush_volume": 100.0}`。
#[derive(serde::Deserialize, Clone)]
pub struct ColliderFilter {
    #[serde(default = "default_true")]
    pub include_ladder: bool,
    #[serde(default = "default_true")]
    pub include_solid: bool,
    #[serde(default)]
    pub min_brush_volume: f32,
    #[serde(default)]
    pub skip_sky: bool,
    #[serde(default)]
    pub skip_nodraw: bool,
}

/// 与 serde 默认一致（`include_*` = true，`skip_*` = false）；
/// `#[derive(Default)]` 会为 bool 生成 false，与 `#[serde(default = "default_true")]` 不一致。
impl Default for ColliderFilter {
    fn default() -> Self {
        ColliderFilter {
            include_ladder: true,
            include_solid: true,
            min_brush_volume: 0.0,
            skip_sky: false,
            skip_nodraw: false,
        }
    }
}

/// serde 的 `bool` 字段默认值：缺失即 `true`。
fn default_true() -> bool {
    true
}

/// Source 引擎中**无物理碰撞**的实体（brush 只是触发/标记区域，玩家可穿过）。
///
/// 这些实体 brush 不参与玩家碰撞（MASK_PLAYERSOLID 不包含 trigger 面）：
/// `trigger_*` / `func_illusionary` / `func_occluder` / `func_dustmotes` / `func_areaportal` /
/// `func_precipitation`。若导出为固体碰撞体，玩家会在触发区域踩到透明空气墙（用户实测的导出 bug）。
pub fn entity_is_non_solid(classname: &str) -> bool {
    classname.starts_with("trigger_")
        || classname == "func_illusionary"
        || classname == "func_occluder"
        || classname == "func_dustmotes"
        || classname == "func_areaportal"
        || classname == "func_precipitation"
}

/// 实体 → 模型 classname 映射（`model="*N"` 实体）；model[0]（worldspawn）为 None。
pub fn model_classnames(bsp: &vbsp::Bsp) -> Vec<Option<String>> {
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
pub fn brush_model_indices(bsp: &vbsp::Bsp) -> Vec<Option<usize>> {
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
/// 实体模型的 brush 几何以局部坐标存储（相对实体 origin），而 `dmodel_t.origin` 字段在本工具链的
/// BSP 中不可靠（实测为垃圾值/0），权威来源是 entities lump 中实体的 `origin` keyvalue（与
/// `parse_teleports` 一致）。worldspawn（model[0]）局部即世界，无需平移；无实体引用的 model 跳过。
pub fn build_brush_model_origins(bsp: &vbsp::Bsp) -> Vec<[f32; 3]> {
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
pub fn aabb_volume(verts: &[[f32; 3]]) -> f32 {
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
