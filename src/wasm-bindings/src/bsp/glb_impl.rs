//! GLB 导出管线的共享实现（T-P1-1c）。
//!
//! 三端的 export_glb* 入口原本各有一份几乎相同的流程：解析默认纹理包 → 取 PAKFILE 模型 →
//! 解 VMT/VTF → 装整合器（或走纯地图回退）→ 序列化 + 合并 mosaic manifest。差异只有六项：
//! 日志档位、ConvertOptions 的来源、是否注入灯光、是否强制走整合器、是否跳过模型提取、
//! 以及 mosaic 合并顺序。这里把这六项收进 GlbExportOpts，由各前端薄壳按自己的语义填。
//!
//! **字节级契约**：本模块只是搬移代码，贴图/材质/mosaic 的处理次序与原来逐句对应，
//! GLB 的 sha256 必须与重构前逐字节相同（T-P1-1c 的验收判据）。
#![allow(clippy::needless_return)]

use super::{to_js_err, BspProcessor};
use std::collections::HashMap;
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use websurf_wasm_core::render_bundle::{
    build_vmt_stem_index, collect_light_entities, resolve_pakfile_materials, PakfileModels, VhvLog,
};
use websurf_wasm_core::{bsp_to_gltf_core, model_integrator, pakfile_models, vbsp};
use model_integrator::{ExportOptions, InMemoryResources, ModelIntegrator};

/// ConvertOptions 的来源：裸导出（默认值）或带默认纹理回退表（defaults 系列）。
pub(crate) enum OptionsSource<'a> {
    Plain,
    Defaults { json: &'a str, atlas: u64 },
}

/// 一条 GLB 导出路径的全部可调语义（三端薄壳的唯一差异面）。
pub(crate) struct GlbExportOpts<'a> {
    /// PAKFILE 模型提取的日志档位（game 总是打 / debug 仅在有 prop 时 / viewer 不打）。
    pub vhv_log: VhvLog,
    /// ConvertOptions 的来源。
    pub options: OptionsSource<'a>,
    /// 是否注入 KHR_lights_punctual 灯实体。
    pub include_lights: bool,
    /// 即使模型表为空也走整合器路径（viewer 的主导出入口要保证灯实体照常注入）。
    pub force_integrator: bool,
    /// 只导出纯地图，不提取 PAKFILE 模型（export_glb 纯地图入口）。
    pub skip_model_extraction: bool,
    /// 是否把本次导出的 mosaic manifest 写进 BspProcessor::mosaic_cache。
    pub cache_mosaic: bool,
    /// mosaic 合并顺序：true = 模型材质覆盖世界面（game/viewer），false = 世界面覆盖模型材质（debug）。
    pub materials_win_mosaic: bool,
}

/// 执行一次 GLB 导出，并在需要时更新实例上的 mosaic 缓存。
pub(crate) fn run_glb_export(
    proc: &mut BspProcessor,
    bsp: Arc<vbsp::Bsp>,
    opts: GlbExportOpts<'_>,
) -> Result<Vec<u8>, JsValue> {
    let (output, mosaic) = export_glb_impl(proc, bsp, &opts)?;
    if let Some(mosaic) = mosaic {
        proc.mosaic_cache = mosaic;
    }
    Ok(output)
}

/// 共享实现核：返回 (GLB 字节, 待写入缓存的 mosaic)。
fn export_glb_impl(
    proc: &mut BspProcessor,
    bsp: Arc<vbsp::Bsp>,
    opts: &GlbExportOpts<'_>,
) -> Result<(Vec<u8>, Option<HashMap<String, String>>), JsValue> {
    // 纯地图入口：不提取模型，也不碰 mosaic 缓存。
    if opts.skip_model_extraction {
        let result = bsp_to_gltf_core::export_bsp(bsp, bsp_to_gltf_core::ConvertOptions::default())
            .map_err(|e| to_js_err(e, "GLB 导出失败"))?;
        let output = glb_to_bytes(&result.glb)?;
        return Ok((output, None));
    }

    let fallback: Option<HashMap<String, String>> = match &opts.options {
        OptionsSource::Plain => None,
        OptionsSource::Defaults { json, .. } => Some(
            serde_json::from_str(json).map_err(|e| to_js_err(e, "默认纹理包 JSON 解析失败"))?,
        ),
    };
    let atlas = match &opts.options {
        OptionsSource::Plain => 0,
        OptionsSource::Defaults { atlas, .. } => *atlas,
    };

    let PakfileModels {
        models,
        static_props,
        entry_names,
    } = proc.take_models_for(&bsp, opts.vhv_log)?;

    // 基名 VMT 回退索引与 VMT 回退表只对带默认纹理包的路径有意义；裸导出保持空表。
    let (stem_index, vmt_fallback): (HashMap<String, String>, HashMap<String, String>) =
        if fallback.is_some() {
            (build_vmt_stem_index(&entry_names), proc.vmt_fallback.clone())
        } else {
            (HashMap::new(), HashMap::new())
        };

    let make_options = || match &fallback {
        None => bsp_to_gltf_core::ConvertOptions::default(),
        Some(fallback) => bsp_to_gltf_core::ConvertOptions {
            missing_fallback: fallback.clone(),
            vmt_stem_index: stem_index.clone(),
            vmt_fallback: vmt_fallback.clone(),
            generate_missing_list: true,
            lightmap_max_atlas_area: atlas,
            ..bsp_to_gltf_core::ConvertOptions::default()
        },
    };

    // 无模型且不要灯光：纯地图导出（是否仍带 defaults 由 make_options 决定）。
    if models.is_empty() && !opts.include_lights && !opts.force_integrator {
        let result = bsp_to_gltf_core::export_bsp(bsp, make_options())
            .map_err(|e| to_js_err(e, "GLB 导出失败"))?;
        let mosaic: Option<HashMap<String, String>> = if opts.cache_mosaic {
            Some(result.mosaic.iter().cloned().collect())
        } else {
            None
        };
        let output = glb_to_bytes(&result.glb)?;
        return Ok((output, mosaic));
    }

    let index = pakfile_models::PakIndex::build(&entry_names);
    let materials = resolve_pakfile_materials(&bsp, &models, &index, true, fallback.as_ref());
    let resources = InMemoryResources {
        models,
        entities: model_integrator::collect_model_entities(&bsp),
        static_props,
        textures: materials.textures,
        material_alpha_mode: materials.alpha_modes,
        material_unlit: materials.unlit,
        material_envmap: materials.envmap_tints,
        material_bumpmap: materials.bumpmaps,
        material_water: materials.waters,
        light_entities: if opts.include_lights {
            collect_light_entities(&bsp)
        } else {
            Vec::new()
        },
    };
    let integrator =
        ModelIntegrator::from_in_memory(resources, ExportOptions { include_lights: opts.include_lights });
    let result = bsp_to_gltf_core::export_bsp_with_models(bsp, make_options(), Some(&integrator))
        .map_err(|e| to_js_err(e, "GLB 导出失败"))?;

    let mosaic: Option<HashMap<String, String>> = if opts.cache_mosaic {
        let mut merged: HashMap<String, String> = HashMap::new();
        if opts.materials_win_mosaic {
            for (name, code) in &result.mosaic {
                merged.insert(name.clone(), code.clone());
            }
            for (name, code) in &materials.mosaic {
                merged.insert(name.to_ascii_lowercase(), code.clone());
            }
        } else {
            for (name, code) in &materials.mosaic {
                merged.insert(name.to_ascii_lowercase(), code.clone());
            }
            for (name, code) in &result.mosaic {
                merged.insert(name.clone(), code.clone());
            }
        }
        Some(merged)
    } else {
        None
    };

    let output = glb_to_bytes(&result.glb)?;
    Ok((output, mosaic))
}

fn glb_to_bytes(glb: &gltf::Glb<'static>) -> Result<Vec<u8>, JsValue> {
    let mut output: Vec<u8> = Vec::new();
    glb.to_writer(&mut output)
        .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;
    Ok(output)
}
