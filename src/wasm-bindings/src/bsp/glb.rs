// glb.rs —— A2（task-78）：GLB 绑定三份合一后的唯一实现文件。
//
// 历史：task-73 slice2 曾把 debug+game 共用（glb.rs，4 个方法）、game 主体（glb_lite.rs，18 个）、
// viewer（viewer_export.rs，12 个）分成三个 feature 互斥文件。本文件按「body 指纹 + 导出面基线」
// 合并为一份，删除 glb_lite.rs / viewer_export.rs：
//   - 完全相同（body 逐字一致）→ 单一共享 impl，cfg 取并集；
//   - 同名不同实现 → 保留各端实现，用 `#[cfg(feature = …)]` 分块，并在块首注释差异来源；
//   - 各来源文件的顶层辅助类型（BspMetadata + impl）随其 feature 分节搬运；
//   - debug 自己的 GLB 方法仍在 debug_tools.rs（debug-tools feature），此处不重复定义。
// 三端 feature 映射沿用 Cargo.toml：debug = core,phys,glb,debug-tools；game = core,phys,glb-lite
// （glb-lite 只是 game 子集标记，不再对应独立文件，并依赖 glb）；viewer = core,viewer-export。
// 导出面必须与 `.tmp/wasm-bindings/baseline/` 的 d.ts 基线逐名一致（compare-exports.mjs 校验）。
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

// ================= 1) game + viewer 完全相同的实现（body 指纹一致） =================
// 来源：glb_lite.rs 与 viewer_export.rs 的 parse_pvs_data 逐字相同；debug 的版本在 debug_tools.rs（body 不同）。
// parse_pvs_data：game（glb-lite）与 viewer（viewer-export）共用；两 feature 互斥，故只定义一份。
#[cfg(any(feature = "glb-lite", feature = "viewer-export"))]
#[wasm_bindgen]
impl BspProcessor {

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
            super::colliders_impl::parse_pvs_data(bsp)
        }
}

// ================= 2) debug + game 相同（既有 glb.rs；game 经 glb-lite→glb 启用） =================
// 来源：task-73 slice2 的 glb.rs（debug 与 game 的 body 指纹一致）。viewer 另有自己的同名变体（见第 4 节）。
// feature glb：debug 直接启用；game 经 glb-lite→glb 启用。
#[cfg(feature = "glb")]
#[wasm_bindgen]
impl BspProcessor {

    /// 检查 BSP 是否仍持有（未被 export_glb 消费）。
        pub fn is_alive(&self) -> bool {
            self.bsp.is_some()
        }
}

// 默认变体 3 个都调用内部 helper export_glb_with_defaults_opts；该 helper 只存在于 debug-tools /
// glb-lite / viewer-export 三处（各自 body 不同）。纯 `core,glb` 组合没有提供方，故这三个方法要求
// 同时启用至少一个提供方 feature；app 侧 debug（debug-tools）与 game（glb-lite）均满足，导出面不变。
// feature glb + 提供方：3 个默认变体。
#[cfg(all(feature = "glb", any(feature = "debug-tools", feature = "glb-lite")))]
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
}

// ================= 3) game 主体（glb-lite，来源 glb_lite.rs） =================
// 与 viewer 同名但实现不同（new/metadata/parse_* /export_glb* 等）；debug 版本在 debug_tools.rs。
// feature glb-lite：仅 game 启用。
#[cfg(feature = "glb-lite")]
#[wasm_bindgen]
impl BspProcessor {

    /// 导出 BSP brush 的凸包碰撞体：`WasmBrush[]` JSON 数组，每项含 `planes`（世界坐标 Y-up、
        /// 法线朝外的平面）/ `min` / `max` / `is_ladder` / `is_solid`。
        ///
        /// `filter_json` 是 `ColliderFilter` 的 JSON（字段全部可选，缺失取默认值）；文本解析失败一律
        /// 退回 `ColliderFilter::default()`。过滤分两类——调用方开关（`skip_sky` / `skip_nodraw` /
        /// `include_ladder` / `include_solid` / `min_brush_volume`），以及固定几何条件（既非玩家固体
        /// 亦非 LADDER 的 brush、所属实体被 `entity_is_non_solid` 判为无碰撞、平面数 < 4、
        /// 顶点数 < 4）。已产出 brush 数达到 `MAX_BRUSHES` 时提前结束，剩余 brush 全部计入跳过计数。
        ///
        /// 结束时用 `web_sys::console::log_1` 打一行 `[BrushPlanes]` 统计：九个具名分支计数之和等于
        /// `skipped` 且 `exported + skipped == total` 时末尾为 `ok`，否则为 `MISMATCH`。
        ///
        /// **平面约定**：BSP 读出的平面法线朝内（内部点 `dot(n,p)-dist >= 0`），本方法转到 Y-up 后取负
        /// `normal` 与 `dist`，输出扫掠侧要的「法线朝外」平面；BSP 原生 bevel side（编译器为
        /// "盒子别卡在棱上"生成的过棱小平面）照常进平面表（owner 裁决：刀刃脊可站由它承担）。
        pub fn export_brushes_planes(&self, filter_json: &str) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
            // 共享实现（bsp/common.rs）：game 端不输出 is_real_face / is_bevel 诊断键，
            // 控制台统计带九分支自证。**无条件**输出 entity / start_solid。
            super::common::export_brushes_planes_impl(
                bsp,
                filter_json,
                super::common::BrushPlanesOpts {
                    debug_plane_flags: false,
                    detailed_skip_log: true,
                },
            )
        }

    /// 导出为 GLB 字节数组：`bsp_to_gltf_core::export_bsp` + `ConvertOptions::default()`
        /// ——不含 PAKFILE 模型、不注入光照、不回退缺失纹理。
        ///
        /// 借用式导出：`self.bsp` 在成功与失败后都保留，可重复调用且字节一致；
        /// 失败文本前缀 `GLB 导出失败` / `GLB 序列化失败`。
        pub fn export_glb(&mut self) -> Result<Vec<u8>, JsValue> {
            let bsp = self.take_bsp()?;
            super::glb_impl::run_glb_export(
                self,
                bsp,
                super::glb_impl::GlbExportOpts {
                    vhv_log: VhvLog::Always,
                    options: super::glb_impl::OptionsSource::Plain,
                    include_lights: false,
                    force_integrator: false,
                    skip_model_extraction: true,
                    cache_mosaic: false,
                    materials_win_mosaic: true,
                },
            )
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
            super::glb_impl::run_glb_export(
                self,
                bsp,
                super::glb_impl::GlbExportOpts {
                    vhv_log: VhvLog::Always,
                    options: super::glb_impl::OptionsSource::Plain,
                    include_lights: false,
                    force_integrator: false,
                    skip_model_extraction: false,
                    cache_mosaic: false,
                    materials_win_mosaic: true,
                },
            )
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
            super::glb_impl::run_glb_export(
                self,
                bsp,
                super::glb_impl::GlbExportOpts {
                    vhv_log: VhvLog::Always,
                    options: super::glb_impl::OptionsSource::Plain,
                    include_lights: true,
                    force_integrator: false,
                    skip_model_extraction: false,
                    cache_mosaic: false,
                    materials_win_mosaic: true,
                },
            )
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
            let options = websurf_wasm_core::bsp_to_gltf_core::ConvertOptions {
                probe_only: true,
                vmt_fallback: self.vmt_fallback.clone(),
                ..websurf_wasm_core::bsp_to_gltf_core::ConvertOptions::default()
            };
            let missing = websurf_wasm_core::mosaic::manifest::collect_missing_textures_with(bsp, &options);
            serde_json::to_string(&missing).map_err(|e| to_js_err(e, "序列化缺失纹理列表失败"))
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
            let pak = self.collect_models(VhvLog::Always)?;
            super::colliders_impl::export_model_phy_colliders(bsp, &pak)
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
        /// 唯一门控是 `Placement::solid == Some(0)`（`SolidType::None` / `SOLID_NONE`，由 BSP 的静态道具
        /// 记录给出）。**不按材质透明度剔除**：起源引擎的碰撞来自模型的 `.phy`（vphysics）与 BSP 的
        /// `contents` 位，`$translucent` / `$alphatest` 这类材质键只进渲染，从不参与碰撞定义
        /// （玻璃 / 水面道具本该可站可撞，探针在 `surf_666` 的窗与 `surf_sedona` 的坡上实测到过被误剔）。
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
            let pak = self.collect_models(VhvLog::Always)?;
            super::colliders_impl::export_model_tri_colliders(bsp, &pak)
        }

    /// 导出 brush 平面碰撞体的 **WSBW 二进制**（与 `export_brushes_planes` 同一提取路径）。
    ///
    /// 格式常量与编解码只有一份：`websurf-phys` 的 `src/phys/world_bin.rs`（magic `WSBW`、
    /// version 1、little-endian，头部 16 字节）。本方法只做编码，不参与解码。
    /// 返回 `Uint8Array`；缓冲区由 wasm-bindgen 拷进 JS 堆，可安全 transfer 给 Worker。
    #[cfg(feature = "phys")]
    pub fn export_brushes_planes_bin(&self, filter_json: &str) -> Result<js_sys::Uint8Array, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
        super::world_bin_impl::brushes_planes_bin(
            bsp,
            filter_json,
            super::common::BrushPlanesOpts {
                debug_plane_flags: false,
                detailed_skip_log: true,
            },
        )
    }

    /// 导出模型 `.phy` 凸包碰撞三角形为 **WSBW 二进制**。
    #[cfg(feature = "phys")]
    pub fn export_model_phy_colliders_bin(&self) -> Result<js_sys::Uint8Array, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
        let pak = self.collect_models(VhvLog::Always)?;
        super::world_bin_impl::phy_colliders_bin(bsp, &pak)
    }

    /// 导出模型可视网格（含置换面）碰撞三角形为 **WSBW 二进制**。
    #[cfg(feature = "phys")]
    pub fn export_model_tri_colliders_bin(&self) -> Result<js_sys::Uint8Array, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
        let pak = self.collect_models(VhvLog::Always)?;
        super::world_bin_impl::tri_colliders_bin(bsp, &pak)
    }

    /// 按 `colliderSource`（`auto` / `phy` / `visual`）导出模型碰撞三角形为 **WSBW 二进制**。
    ///
    /// `auto` 的逐实例回退在 Rust 内完成（与 TS 旧实现同一判据：`.phy` 实例在前，
    /// 可视网格里 `name` 未出现在 `.phy` 结果中的实例补在后），因此主线程不需要
    /// 解析任何 JSON 就能拿到合并后的单一缓冲区。
    #[cfg(feature = "phys")]
    pub fn export_model_colliders_bin(&self, source: &str) -> Result<js_sys::Uint8Array, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
        let pak = self.collect_models(VhvLog::Always)?;
        super::world_bin_impl::model_colliders_bin(bsp, &pak, source)
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
            let pak = self.collect_models(VhvLog::Always).ok();
            super::meta_impl::export_mosaic_manifest(bsp, pak.as_deref())
        }

    /// 获取元数据 JSON 字符串（不消耗内部 Bsp 实例）。
        pub fn metadata(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
            super::meta_impl::metadata(bsp, self.packed_files)
        }

    /// 创建处理器并立即解析 BSP 数据。
        #[wasm_bindgen(constructor)]
        pub fn new(data: &[u8]) -> Result<BspProcessor, JsValue> {
            let (bsp, packed_files) = super::meta_impl::load_bsp(data)?;
            Ok(BspProcessor {
                bsp: Some(bsp),
                packed_files,
                mosaic_cache: std::collections::HashMap::new(),
                pak_models: RefCell::new(None),
                vmt_fallback: std::collections::HashMap::new(),
            })
        }

    pub fn parse_entities(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
        super::meta_impl::parse_entities(bsp)
    }

    /// 提取出生点实体，输出 JSON：`{ "spawn_points": [{ classname, origin, angles, origin_raw,
        /// angles_raw }], "total": N, "primary": M }`（`primary` 无值时为 `null`）。
        ///
        /// 命中条件：classname 在 `SPAWN_CLASSNAMES` 内，或以 `info_player_` 开头；
        /// `origin` 解析不出三个浮点数就跳过该实体，`angles` 缺失或解析失败则填 `[0.0, 0.0, 0.0]`。
        /// `primary` 按玩家出生点优先级选择：`info_player_start` > `info_player_terrorist` >
        /// `info_player_counterterrorist` > `info_player_deathmatch` > `info_player_teamspawn` >
        /// `info_player_axis` > `info_player_allied` > `info_player_coop` > 其它 `info_player_*`；
        /// 完全没有玩家出生点时回退列表第一个（可能是 `info_teleport_destination`），无出生点时为 `null`。
        ///
        /// **坐标转换**：`origin` 经 `rotate_yup` 转成 Y-up（`[x,y,z]→[y,z,x]`，det=+1 正交变换），
        /// `angles` 保持 BSP 原始 `[pitch, yaw, roll]` 顺序不转。
        pub fn parse_spawn_points(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
            super::meta_impl::parse_spawn_points(bsp)
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
        ///   `[nx,ny,nz,dist]`，朝外）/ `spawnflags` / `start_disabled` /
        ///   `filtername` / `filter_name` / `filter_negated`（名门控，与 debug-tools 路径
        ///   共用 `bsp/teleport_filters.rs`；`filter_name=None` 即无门控）/
        ///   `origin_raw` / `model_raw`。
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
            super::colliders_impl::parse_teleports(bsp)
        }

    /// 读取 pakfile 内文件字节（找不到返回空数组）；供天空盒取 6 面 VTF。
        pub fn read_pakfile_file(&self, name: &str) -> Result<Vec<u8>, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
            super::meta_impl::read_pakfile_file(bsp, name)
        }
}

// 内部辅助方法（非导出；glb-lite 专用）。
// feature glb-lite：内部实现，不对 JS 导出。
#[cfg(feature = "glb-lite")]
impl BspProcessor {

    /// 只读入口用。
        pub(crate) fn collect_models(&self, vhv_log: VhvLog) -> Result<Rc<PakfileModels>, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析"))?;
            self.collect_models_for(bsp, vhv_log)
        }

        pub(crate) fn export_glb_with_defaults_opts(
            &mut self,
            defaults_json: &str,
            lightmap_max_atlas_area: u64,
            include_lights: bool,
        ) -> Result<Vec<u8>, JsValue> {
            let bsp = self.take_bsp()?;
            super::glb_impl::run_glb_export(
                self,
                bsp,
                super::glb_impl::GlbExportOpts {
                    vhv_log: VhvLog::Always,
                    options: super::glb_impl::OptionsSource::Defaults {
                        json: defaults_json,
                        atlas: lightmap_max_atlas_area,
                    },
                    include_lights,
                    force_integrator: false,
                    skip_model_extraction: false,
                    cache_mosaic: true,
                    materials_win_mosaic: true,
                },
            )
        }

    /// 克隆出 `Arc<Bsp>` 句柄（**不**清空 `self.bsp`）。
        ///
        /// 导出成功或失败后处理器都仍持有原句柄，可再次调用；`bsp` 为 `None` 时返回文本为
        /// `BSP 未解析` 的 [`JsValue`]。
        pub(crate) fn take_bsp(&self) -> Result<std::sync::Arc<vbsp::Bsp>, JsValue> {
            self.bsp
                .as_ref()
                .map(std::sync::Arc::clone)
                .ok_or_else(|| JsValue::from_str("BSP 未解析"))
        }
}

// 顶层辅助类型（glb-lite 专用）：BspMetadata 的 game 变体（17 字段）+ from_bsp。
#[cfg(feature = "glb-lite")]
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

#[cfg(feature = "glb-lite")]
impl BspMetadata {
    // packed_files 由调用方传入：`Packfile` 的 zip 字段私有，要拿条目数只能 clone 后走
    // `Packfile::into_zip()`（消费 self）再 `len()`，克隆代价高 ⇒ 在处理器构造时算一次缓存。
    pub(super) fn from_bsp(bsp: &vbsp::Bsp, packed_files: usize) -> Self {
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

    pub(super) fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(self).map_err(|e| to_js_err(e, "序列化 BSP 元数据失败"))
    }
}

// 自由函数（glb-lite 专用）。
#[cfg(feature = "glb-lite")]
/// 置换面（displacement）的**碰撞三角形汤**（世界坐标，Y-up）—— 与 debug 工程同名同签名，
/// 详见该工程里同名函数的说明：笔刷碰撞只覆盖平面凸包，而置换面把可见表面从基础笔刷平面推了
/// 出去；Source 对置换面的做法就是按置换面自身的三角形烘碰撞。这里与渲染端共用
/// `Handle::triangulated_displaced_vertices`，保证"看到的"与"撞到的"是同一张面。
#[wasm_bindgen]
pub fn export_displacement_colliders(data: &[u8]) -> Result<String, JsValue> {
    super::colliders_impl::export_displacement_colliders(data)
}

// ================= 4) viewer（viewer-export，来源 viewer_export.rs） =================
// 与 debug/game 同名不同 body 的方法各自保留；viewer 独有 probeMissingResources 等。
// feature viewer-export：仅 viewer 启用。
#[cfg(feature = "viewer-export")]
#[wasm_bindgen]
impl BspProcessor {

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
            super::glb_impl::run_glb_export(
                self,
                bsp,
                super::glb_impl::GlbExportOpts {
                    vhv_log: VhvLog::Never,
                    options: super::glb_impl::OptionsSource::Plain,
                    include_lights: false,
                    force_integrator: false,
                    skip_model_extraction: false,
                    cache_mosaic: true,
                    materials_win_mosaic: true,
                },
            )
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
            // 失败不消费实例：失败时把原 Arc 放回，TS 侧可回退裸导出
            match super::glb_impl::run_glb_export(
                self,
                bsp.clone(),
                super::glb_impl::GlbExportOpts {
                    vhv_log: VhvLog::Never,
                    options: super::glb_impl::OptionsSource::Defaults {
                        json: defaults_json,
                        atlas: 0,
                    },
                    include_lights: true,
                    force_integrator: true,
                    skip_model_extraction: false,
                    cache_mosaic: true,
                    materials_win_mosaic: true,
                },
            ) {
                Ok(output) => Ok(output),
                Err(e) => {
                    self.bsp = Some(bsp);
                    Err(e)
                }
            }
        }

    pub fn export_mosaic_manifest(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 已被消费或未加载"))?;
        let pak = self.collect_models(VhvLog::Never).ok();
        super::meta_impl::export_mosaic_manifest(bsp, pak.as_deref())
    }

    /// 元数据 JSON 字符串；借用内部 `Bsp`，不消耗它。
        /// 实例已被导出方法取走时返回 "BSP 未解析或已导出" 错误。
        pub fn metadata(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;
            super::meta_impl::metadata(bsp, self.packed_files, self.cached_static_props)
        }

    /// 解析 BSP 字节并建处理器；解析失败时转成上下文为 "BSP 解析失败" 的 JS 错误。
        /// 同时把 pakfile 条目数与 static_props 计数一次算好存进字段（`Packfile` 的锁中毒在此
        /// 转成 JS 错误，不再 `unwrap` panic——T-146）。
        #[wasm_bindgen(constructor)]
        pub fn new(data: &[u8]) -> Result<BspProcessor, JsValue> {
            let (bsp, packed_files) = super::meta_impl::load_bsp(data)?;
            let cached_static_props = bsp.static_props().count();
            Ok(BspProcessor {
                bsp: Some(bsp),
                packed_files,
                cached_static_props,
                mosaic_cache: std::collections::HashMap::new(),
                pak_models: RefCell::new(None),
                vmt_fallback: std::collections::HashMap::new(),
            })
        }

    pub fn parse_entities(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;
        super::meta_impl::parse_entities(bsp)
    }

    /// 提取出生点实体（info_player_start / info_player_terrorist / info_player_counterterrorist 等）。
        ///
        /// 返回 JSON：`{ "spawn_points": [{ classname, origin: [x,y,z], angles: [p,y,r],
        /// origin_raw, angles_raw }], "total": N, "primary": 0 }`。
        /// `primary` 为推荐出生点索引：按玩家出生点优先级选择（`info_player_start` 最高，
        /// 之后 `info_player_terrorist`、`info_player_counterterrorist` 等，其它 `info_player_*` 最后）；
        /// 完全没有玩家出生点时回退列表第一个（可能是 `info_teleport_destination`）。
        ///
        /// **坐标转换**：BSP Z-up → Three.js Y-up（`[x,y,z]→[y,z,x]`，det=+1）。
        /// `origin` 已旋转为 Y-up；`angles` 保持 BSP 原始 `[pitch, yaw, roll]`，前端按需转换。
        pub fn parse_spawn_points(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;
            super::meta_impl::parse_spawn_points(bsp)
        }

    /// **诊断**：只跑一遍材质/贴图解析（probe_only，不产出像素、不落 GLB），
        /// 返回缺失资源清单 JSON：{"missing":[{"name","reason"}...],"textures":[...]}。
        ///
        /// 与 export_glb* 不同，本方法**不消费** BSP（只克隆 Arc），可对同一实例多次调用；
        /// `src/scripts/audit-missing.mjs` 用它对比「有/无回退 VMT 表」「有/无默认纹理包」的缺口。
        #[wasm_bindgen(js_name = probeMissingResources)]
        pub fn probe_missing_resources(&self, defaults_json: &str) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?
                .clone();
            let fallback: std::collections::HashMap<String, String> =
                serde_json::from_str(defaults_json).unwrap_or_default();
            let options = bsp_to_gltf_core::ConvertOptions {
                probe_only: true,
                missing_fallback: fallback,
                vmt_fallback: self.vmt_fallback.clone(),
                ..bsp_to_gltf_core::ConvertOptions::default()
            };
            let result = bsp_to_gltf_core::export_bsp(bsp, options)
                .map_err(|e| to_js_err(e, "缺失资源探针失败"))?;
            let missing: Vec<serde_json::Value> = result
                .missing_resources
                .iter()
                .map(|m| serde_json::json!({ "name": m.name, "reason": m.reason }))
                .collect();
            Ok(serde_json::json!({ "missing": missing, "textures": result.textures }).to_string())
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
            super::meta_impl::read_pakfile_file(bsp, name)
        }
}

// 内部辅助方法（非导出；viewer-export 专用）。
// feature viewer-export：内部实现，不对 JS 导出。
#[cfg(feature = "viewer-export")]
impl BspProcessor {

    /// 只读入口用。
        pub(crate) fn collect_models(&self, vhv_log: VhvLog) -> Result<Rc<PakfileModels>, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 已被消费或未加载"))?;
            self.collect_models_for(bsp, vhv_log)
        }

}

// 顶层辅助类型（viewer-export 专用）：BspMetadata 的 viewer 变体（9 字段）+ from_bsp。
#[cfg(feature = "viewer-export")]
/// `BspProcessor::metadata()` 的返回值：序列化成 JSON 字符串交给前端 `JSON.parse`。
///
/// 不标 `#[wasm_bindgen]`：本结构体只用于序列化，不跨边界暴露字段或方法。字段与来源：
/// `schema_version` 固定为 1；`magic` 由 `header` 的 v/b/s/p 四个字节拼成；`map_name` 当前恒为空串
/// （`from_bsp` 不填该字段）；`num_models` / `num_faces` / `num_vertices` / `num_brushes` 直接取
/// `Bsp` 对应 lump 的长度；`num_static_props` 与 `packed_files` 都由构造期缓存传入；
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

#[cfg(feature = "viewer-export")]
impl BspMetadata {
    /// 由 `Bsp` 组元数据；`packed_files` 与 `num_static_props` 都由 `BspProcessor` 的构造期
    /// 缓存传入——`Packfile` 的 zip 字段私有（`src/wasm-core/vbsp/data/mod.rs`），取条目数只能先
    /// `clone()` 再 `into_zip()`（消费 self）；`static_props()` 是线性扫描。两者都只在构造期算一次。
    pub(super) fn from_bsp(bsp: &vbsp::Bsp, packed_files: usize, num_static_props: usize) -> Self {

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

    pub(super) fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(self).map_err(|e| to_js_err(e, "序列化 BSP 元数据失败"))
    }
}

