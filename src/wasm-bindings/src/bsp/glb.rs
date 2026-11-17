// glb: task-73 slice2 生成（源=debug），请勿手改。

// glb: task-73 slice2 生成（源=三端 lib.rs 按 body 指纹分组），请勿手改。

#![allow(unused_imports, dead_code, non_snake_case)]
use super::{to_js_err, BspProcessor};
use wasm_bindgen::prelude::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use websurf_wasm_core::{bsp_to_gltf_core, model_integrator, pakfile_models, phyfile, vbsp};
use websurf_wasm_core::render_bundle::{
    aabb_volume, brush_model_indices, build_brush_model_origins, build_vmt_stem_index,
    collect_light_entities, collect_pakfile_models_bundle, entity_is_non_solid, load_vmdl,
    model_classnames, resolve_pakfile_materials, ColliderFilter, PakfileModels, VhvLog,
};
use model_integrator::{ExportOptions, InMemoryModel, InMemoryResources, ModelIntegrator};


// ---------------- 导出方法（#[wasm_bindgen] impl） ----------------

#[wasm_bindgen]
impl BspProcessor {

    /// 导出 GLB（PAKFILE 模型）+ **缺失纹理回退**：`defaults_json` 是
        /// `{ "materials/<材质路径小写>": "#mosaic v4 字节码" }` 形式的回退表，命中的材质在导出期
        /// 就地解码低清纹理并嵌进 GLB（`ConvertOptions.missing_fallback`），渲染端拿到的是自包含场景。
        ///
        /// 与 `export_glb_with_pakfile_models` 同一实现，差异只有回退表与 `generate_missing_list`；
        /// 图集面积上界取 0（= 共享层政策上界），且**不导出灯光**。
        pub fn export_glb_with_pakfile_models_with_defaults(
            &mut self,
            defaults_json: &str,
        ) -> Result<Vec<u8>, JsValue> {
            self.export_glb_with_defaults_opts(defaults_json, 0, false)
        }

    /// `export_glb_with_pakfile_models_with_defaults` 的**图集面积上界可覆盖**变体。
        ///
        /// `lightmap_max_atlas_area`（像素面积）：有限且 `> 0` 时经 `as u64` 截断后写入
        /// `ConvertOptions.lightmap_max_atlas_area`；非有限值、0 或负数都归一成 0，即用共享层的
        /// 政策上界。其余行为与 `_with_defaults` 相同（不含灯光）。
        ///
        /// 该变体在手写 TS 侧无调用点（只出现在 `apps/debug/src/wasm.d.ts` 未声明的导出面上），
        /// 是公开导出里唯一能改写该阈值的入口。
        pub fn export_glb_with_pakfile_models_with_defaults_and_atlas_limit(
            &mut self,
            defaults_json: &str,
            lightmap_max_atlas_area: f64,
        ) -> Result<Vec<u8>, JsValue> {
            let area = if lightmap_max_atlas_area.is_finite() && lightmap_max_atlas_area > 0.0 {
                lightmap_max_atlas_area as u64
            } else {
                0
            };
            self.export_glb_with_defaults_opts(defaults_json, area, false)
        }

    /// 导出 GLB（PAKFILE 模型 + **缺失纹理回退** + **BSP 光照**）：回退表与灯光两条支路同时生效。
        ///
        /// 灯光来自 `collect_light_entities` 挑出的 `light` / `light_spot` / `light_environment` 实体，
        /// 经 `ExportOptions { include_lights: true }` 写成 `KHR_lights_punctual`；图集面积上界取 0。
        /// 共享层 `src/ts-shared/phys/world-builder.ts` 的 `buildWorldBundle` 首选本入口，
        /// 失败时回退 `export_glb_with_pakfile_models`。
        pub fn export_glb_with_pakfile_models_with_defaults_and_lights(
            &mut self,
            defaults_json: &str,
        ) -> Result<Vec<u8>, JsValue> {
            self.export_glb_with_defaults_opts(defaults_json, 0, true)
        }

    /// 检查 BSP 是否仍持有（未被 export_glb 消费）。
        pub fn is_alive(&self) -> bool {
            self.bsp.is_some()
        }

}

// ---------------- 内部方法/辅助（普通 impl） ----------------

