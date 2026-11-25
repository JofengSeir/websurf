// meta_impl.rs —— 元数据 / 实体 / 出生点 / pakfile / mosaic manifest 的共享实现（T-P1-1b）。
//
// 这 6 个入口此前在 glb.rs（game 的 glb-lite、viewer 的 viewer-export 各一份）与
// debug_tools.rs（debug-tools）里各复制一份；三份的实现逐字相同，差异只有错误文案与
// `collect_models` 的 `VhvLog` 档位。这里只留一份实现，各端保留薄外壳——外壳仍在
// `#[wasm_bindgen] impl BspProcessor` 里，故导出面与文案不变。
//
// 本文件不定义导出面：函数一律 `pub(crate)`，不标 `#[wasm_bindgen]`。

use super::to_js_err;
use wasm_bindgen::prelude::*;
use websurf_wasm_core::pakfile_models;
use websurf_wasm_core::render_bundle::{resolve_pakfile_materials, PakfileModels};
use websurf_wasm_core::vbsp;

/// 解析 BSP 字节，并一次性算好 pakfile 条目数（三端构造函数共用）。
///
/// `Packfile` 的 zip 字段私有，取条目数只能 clone 后 `into_zip()`（消费 self），故只在
/// 构造期算一次缓存。锁中毒在这里转成 JS 错误而不是 panic（与 viewer 的 T-146 语义一致）。
pub(crate) fn load_bsp(data: &[u8]) -> Result<(std::sync::Arc<vbsp::Bsp>, usize), JsValue> {
    let bsp = vbsp::Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;
    let packed_files = bsp
        .pack
        .clone()
        .into_zip()
        .lock()
        .map_err(|e| JsValue::from_str(&format!("pakfile 锁定失败: {e}")))?
        .len();
    Ok((std::sync::Arc::new(bsp), packed_files))
}

/// 元数据 JSON（game / glb-lite 的字段集，见 `super::glb::BspMetadata`）。
#[cfg(feature = "glb-lite")]
pub(crate) fn metadata(bsp: &vbsp::Bsp, packed_files: usize) -> Result<String, JsValue> {
    super::glb::BspMetadata::from_bsp(bsp, packed_files).to_json()
}

/// 元数据 JSON（viewer / viewer-export 的字段集）；static_props 计数由构造期缓存传入。
#[cfg(feature = "viewer-export")]
pub(crate) fn metadata(
    bsp: &vbsp::Bsp,
    packed_files: usize,
    cached_static_props: usize,
) -> Result<String, JsValue> {
    super::glb::BspMetadata::from_bsp(bsp, packed_files, cached_static_props).to_json()
}

/// 元数据 JSON（debug / debug-tools 的字段集，见 `super::debug_tools::BspMetadata`）。
#[cfg(feature = "debug-tools")]
pub(crate) fn metadata(bsp: &vbsp::Bsp, packed_files: usize) -> Result<String, JsValue> {
    super::debug_tools::BspMetadata::from_bsp(bsp, packed_files).to_json()
}

/// 读取 pakfile 内文件字节；条目不存在返回空数组（天空盒据此判断缺资源）。
pub(crate) fn read_pakfile_file(bsp: &vbsp::Bsp, name: &str) -> Result<Vec<u8>, JsValue> {
    match bsp.pack.get(name) {
        Ok(Some(data)) => Ok(data),
        Ok(None) => Ok(Vec::new()),
        Err(e) => Err(to_js_err(e, "读取 pakfile 文件失败")),
    }
}

/// mosaic manifest（材质名小写 → 压缩码）JSON。
///
/// 世界面那一半由 `build_mosaic_manifest` 收集；模型贴图那一半来自调用方已采集的
/// pakfile 模型包，采集失败时调用方传 `None`，此处静默跳过（不影响地图纹理覆盖）。
pub(crate) fn export_mosaic_manifest(
    bsp: &vbsp::Bsp,
    pak: Option<&PakfileModels>,
) -> Result<String, JsValue> {
    let mut pairs = websurf_wasm_core::mosaic::manifest::build_mosaic_manifest(bsp);
    if let Some(pak) = pak {
        let index = pakfile_models::PakIndex::build(&pak.entry_names);
        let materials = resolve_pakfile_materials(bsp, &pak.models, &index, true, None);
        for (name, png) in materials.textures {
            if let Ok(code) = websurf_wasm_core::mosaic::encode::img_to_code(&png, &name) {
                pairs.push((name.to_ascii_lowercase(), code));
            }
        }
    }
    let map: std::collections::HashMap<String, String> = pairs.into_iter().collect();
    serde_json::to_string(&map).map_err(|e| to_js_err(e, "序列化 mosaic manifest 失败"))
}

/// 实体列表 JSON（`index / classname / targetname / props / outputs / origin_raw / model_raw`）。
///
/// `On*` / `on*` 开头的键归入 `outputs`，其余进 `props`（BTreeMap，键序稳定）。
pub(crate) fn parse_entities(bsp: &vbsp::Bsp) -> Result<String, JsValue> {
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

/// 出生点报告 JSON：`{ spawn_points, total, primary }`。
///
/// 命中条件：classname 在 SPAWN_CLASSNAMES 内，或以 `info_player_` 开头；origin 转成
/// Y-up（`[x,y,z]→[y,z,x]`），angles 保持 BSP 原始 `[pitch, yaw, roll]`。
pub(crate) fn parse_spawn_points(bsp: &vbsp::Bsp) -> Result<String, JsValue> {
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
    let mut primary: Option<(u8, usize)> = None;

    for ent in bsp.entities.iter() {
        let Ok(classname) = ent.prop("classname") else {
            continue;
        };

        let is_spawn = SPAWN_CLASSNAMES.contains(&classname);
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

        // 真实玩家出生点按优先级竞争 primary（info_teleport_destination 等不参与）
        primary = super::track_spawn_primary(primary, spawn_points.len(), classname);

        spawn_points.push(SpawnPoint {
            classname: classname.to_string(),
            origin: rotate_yup(origin),
            angles,
            origin_raw,
            angles_raw,
        });
    }

    // 优先真实玩家出生点；完全没有玩家出生点时才回退到列表第一个
    // （可能是 info_teleport_destination），一个出生点都没有时为 null。
    let primary = primary
        .map(|(_, index)| index)
        .or_else(|| (!spawn_points.is_empty()).then_some(0));

    let report = SpawnReport {
        total: spawn_points.len(),
        spawn_points,
        primary,
    };

    serde_json::to_string(&report).map_err(|e| to_js_err(e, "序列化出生点数据失败"))
}
