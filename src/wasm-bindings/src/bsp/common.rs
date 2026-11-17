// common: task-73 slice2 生成（源=三端 lib.rs 按 body 指纹分组），请勿手改。

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
        /// 导出 Source 实体 I/O 数据：无损 entities lump 原文 + 所有 `model="*N"` 实体的世界凸包。
        ///
        /// 与 `parse_entities()` 并存但互不影响：后者是「整体小写 + BTreeMap」的旧视图，
        /// 只供雾 / 天空参数读取；本方法是通用实体系统的唯一数据入口，保留重复键、
        /// `OnXxx` 输出键与 ESC 分隔的连接串。**必须在 `export_glb*`（会消费 BSP）之前调用。**
        pub fn export_entity_io(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
            let data = websurf_wasm_core::render_bundle::export_entity_io_data(bsp);
            serde_json::to_string(&data)
                .map_err(|e| JsValue::from_str(&format!("序列化失败: {e}")))
        }

    /// 装入**回退 VMT 文本表**（`{ "<材质名小写>": "<VMT 原文>" }`）。
        ///
        /// 地图 pakfile 里没有、但**游戏本体自带**的材质（如 `dev/dev_water2`）靠它拿到真实
        /// `$fogcolor` / `$translucent` 等参数；来源必须能与游戏安装目录的 VPK 逐字节对上
        /// （`src/materials/vmts-fallback.json`；dev 由 `src/scripts/sync-web-assets.mjs` 分发，dist 由 `build-dist.mjs` 复制）。
        /// 空表 = 不启用；查不到就按「数据缺失」处理，不编造缺省值。
        #[wasm_bindgen(js_name = setVmtFallback)]
        pub fn set_vmt_fallback(&mut self, json: &str) -> Result<(), JsValue> {
            let map: std::collections::HashMap<String, String> =
                serde_json::from_str(json).map_err(|e| to_js_err(e, "回退 VMT 表 JSON 解析失败"))?;
            self.vmt_fallback = map;
            Ok(())
        }

    /// 取 [`BspProcessor::export_glb_with_defaults_opts`] **顺带产出**的 mosaic manifest（JSON）。
        ///
        /// 与 [`BspProcessor::export_mosaic_manifest`] 的产物**同口径**（同样的键、同样的字节码），
        /// 但不需要再解析一遍模型材质 —— 那份工作 GLB 导出已经做过，mosaic 就是在解码 VTF 时顺手
        /// 缩出来的。也因此它**不借用 `bsp`**：`export_glb*` 已经把它消费掉了，这正是本方法存在的
        /// 原因（`export_mosaic_manifest` 在 GLB 导出之后无法再调用）。
        ///
        /// 用法：`export_glb*` → `take_mosaic_manifest()`。若尚未导出过 GLB，返回 `"{}"`。
        pub fn take_mosaic_manifest(&self) -> Result<String, JsValue> {
            serde_json::to_string(&self.mosaic_cache)
                .map_err(|e| to_js_err(e, "序列化 mosaic manifest 失败"))
        }

}

// ---------------- 内部方法/辅助（普通 impl） ----------------

impl BspProcessor {

    /// 取（或建立）本处理器缓存的 PAKFILE 模型收集结果；`vhv_log` 口径不同则重建。
        /// 显式收 `&Bsp`，因为消费 BSP 的 GLB 入口在 `take()` 之后仍要读缓存。
        pub(crate) fn collect_models_for(&self, bsp: &vbsp::Bsp, vhv_log: VhvLog) -> Result<Rc<PakfileModels>, JsValue> {
            if let Some((cached_log, pak)) = self.pak_models.borrow().as_ref() {
                if *cached_log == vhv_log {
                    return Ok(Rc::clone(pak));
                }
            }
            let pak = Rc::new(
                collect_pakfile_models_bundle(bsp, vhv_log).map_err(|e| JsValue::from_str(&e))?,
            );
            *self.pak_models.borrow_mut() = Some((vhv_log, Rc::clone(&pak)));
            Ok(pak)
        }

    /// 消费 BSP 的 GLB 入口用：取走缓存（没有就现算）并解包成所有权，避免复制模型字节。
        pub(crate) fn take_models_for(&mut self, bsp: &vbsp::Bsp, vhv_log: VhvLog) -> Result<PakfileModels, JsValue> {
            if let Some((cached_log, pak)) = self.pak_models.borrow_mut().take() {
                if cached_log == vhv_log {
                    if let Ok(pak) = Rc::try_unwrap(pak) {
                        return Ok(pak);
                    }
                }
            }
            collect_pakfile_models_bundle(bsp, vhv_log).map_err(|e| JsValue::from_str(&e))
        }

}
