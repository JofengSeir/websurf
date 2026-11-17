// viewer_export: task-73 slice2 生成（源=viewer），请勿手改。

// viewer_export: task-73 slice2 生成（源=三端 lib.rs 按 body 指纹分组），请勿手改。

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
            let PakfileModels { models, static_props, entry_names } =
                self.take_models_for(&bsp, VhvLog::Never)?;

            // 4. 没有任何被引用模型：纯地图导出（Bsp 同样已被取走）
            if models.is_empty() {
                let options = bsp_to_gltf_core::ConvertOptions::default();
                let result = bsp_to_gltf_core::export_bsp(bsp, options)
                    .map_err(|e| to_js_err(e, "GLB 导出失败"))?;
                // 世界面那一半来自 convert 的收集器（装配材质时顺手缩出来的）
                self.mosaic_cache = result.mosaic.iter().cloned().collect();
                let mut output: Vec<u8> = Vec::new();
                result
                    .glb
                    .to_writer(&mut output)
                    .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;
                return Ok(output);
            }

            // 5. VMT/VTF → 贴图字节 + 透明度档位 + 无光照名集合（裸导出无回退表）
            let index = pakfile_models::PakIndex::build(&entry_names);
            let materials = resolve_pakfile_materials(&bsp, &models, &index, true, None);

            let resources = InMemoryResources {
                models,
                entities: model_integrator::collect_model_entities(&bsp),
                static_props,
                textures: materials.textures,
                material_alpha_mode: materials.alpha_modes,
                material_unlit: materials.unlit,
                material_envmap: materials.envmap_tints, material_bumpmap: materials.bumpmaps, material_water: materials.waters,
                light_entities: Vec::new(),
            };

            let integrator = ModelIntegrator::from_in_memory(resources, ExportOptions::default());
            let options = bsp_to_gltf_core::ConvertOptions::default();
            let result = bsp_to_gltf_core::export_bsp_with_models(bsp, options, Some(&integrator))
                .map_err(|e| to_js_err(e, "GLB 导出失败"))?;
            // mosaic manifest 两半在此会合：世界面那一半来自 convert 的收集器（装配材质时顺手缩的），
            // 模型那一半来自 resolve_pakfile_materials。不再需要重解一遍贴图。
            self.mosaic_cache = result
                .mosaic
                .iter()
                .cloned()
                .chain(
                    materials
                        .mosaic
                        .iter()
                        .map(|(n, c)| (n.to_ascii_lowercase(), c.clone())),
                )
                .collect();

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
            match self.export_glb_with_defaults_impl(bsp.clone(), defaults_json, true) {
                Ok((result, mosaic)) => {
                    // 导出顺手产出的 mosaic manifest 存下来，TS 侧用 take_mosaic_manifest() 取
                    self.mosaic_cache = mosaic;
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

    pub fn export_mosaic_manifest(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 已被消费或未加载"))?;
            let mut pairs = websurf_wasm_core::mosaic::manifest::build_mosaic_manifest(bsp);
            // 模型贴图（材质名 → PNG → mosaic）；失败静默跳过（不影响地图纹理覆盖）
            if let Ok(pak) = self.collect_models(VhvLog::Never) {
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

    /// 元数据 JSON 字符串；借用内部 `Bsp`，不消耗它。
        /// 实例已被导出方法取走时返回 "BSP 未解析或已导出" 错误。
        pub fn metadata(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;
            let metadata = BspMetadata::from_bsp(bsp, self.packed_files, self.cached_static_props);
            metadata.to_json()
        }

    /// 解析 BSP 字节并建处理器；解析失败时转成上下文为 "BSP 解析失败" 的 JS 错误。
        /// 同时把 pakfile 条目数与 static_props 计数一次算好存进字段（`Packfile` 的锁中毒在此
        /// 转成 JS 错误，不再 `unwrap` panic——T-146）。
        #[wasm_bindgen(constructor)]
        pub fn new(data: &[u8]) -> Result<BspProcessor, JsValue> {
            let bsp = vbsp::Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;
            // zip 只在这里 clone 一次：Packfile 没有「只读条目数」的接口
            let packed_files = bsp.pack.clone().into_zip().lock().map_err(|e| JsValue::from_str(&format!("pakfile 锁定失败: {e}")))?.len();
            let cached_static_props = bsp.static_props().count();
            Ok(BspProcessor {
                bsp: Some(std::sync::Arc::new(bsp)),
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

            match bsp.pack.get(name) {
                Ok(Some(data)) => Ok(data),
                Ok(None) => Ok(Vec::new()),
                Err(e) => Err(to_js_err(e, "读取 pakfile 文件失败")),
            }
        }

}

// ---------------- 内部方法/辅助（普通 impl） ----------------

impl BspProcessor {

    /// 只读入口用。
        pub(crate) fn collect_models(&self, vhv_log: VhvLog) -> Result<Rc<PakfileModels>, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 已被消费或未加载"))?;
            self.collect_models_for(bsp, vhv_log)
        }

    /// [`BspProcessor::export_glb_with_pakfile_models_with_defaults_and_lights`] 的实现核
        /// （消费传入的 `Bsp`；`include_lights` 决定是否注入 `KHR_lights_punctual` 灯实体）。
        pub(crate) fn export_glb_with_defaults_impl(
            &mut self,
            bsp: std::sync::Arc<vbsp::Bsp>,
            defaults_json: &str,
            include_lights: bool,
        ) -> Result<
            (
                bsp_to_gltf_core::ExportResult,
                std::collections::HashMap<String, String>,
            ),
            JsValue,
        > {
            let fallback: std::collections::HashMap<String, String> =
                serde_json::from_str(defaults_json)
                    .map_err(|e| to_js_err(e, "默认纹理包 JSON 解析失败"))?;

            let PakfileModels { models, static_props, entry_names } =
                self.take_models_for(&bsp, VhvLog::Never)?;

            // 世界面材质的基名 VMT 回退索引（texinfo 给的贴图名在包内无精确路径时按基名命中）
            let stem_index = build_vmt_stem_index(&entry_names);

            let options = bsp_to_gltf_core::ConvertOptions {
                missing_fallback: fallback.clone(),
                vmt_stem_index: stem_index,
                vmt_fallback: self.vmt_fallback.clone(),
                ..bsp_to_gltf_core::ConvertOptions::default()
            };

            // 无模型时仍走整合器路径（空模型不产出节点，光照注入照常发生）——与 game 同语义
            let index = pakfile_models::PakIndex::build(&entry_names);
            let materials = resolve_pakfile_materials(&bsp, &models, &index, true, Some(&fallback));
            let resources = InMemoryResources {
                models,
                entities: model_integrator::collect_model_entities(&bsp),
                static_props,
                textures: materials.textures,
                material_alpha_mode: materials.alpha_modes,
                material_unlit: materials.unlit,
                material_envmap: materials.envmap_tints, material_bumpmap: materials.bumpmaps, material_water: materials.waters,
                light_entities: if include_lights {
                    collect_light_entities(&bsp)
                } else {
                    Vec::new()
                },
            };
            let integrator =
                ModelIntegrator::from_in_memory(resources, ExportOptions { include_lights });
            bsp_to_gltf_core::export_bsp_with_models(bsp, options, Some(&integrator))
                .map(|result| {
                    // mosaic manifest 两半在此会合：世界面那一半来自 convert 的收集器（装配材质时就
                    // 顺手缩好了，不必再解一遍贴图），模型那一半来自 resolve_pakfile_materials。
                    let mosaic: std::collections::HashMap<String, String> = result
                        .mosaic
                        .iter()
                        .cloned()
                        .chain(
                            materials
                                .mosaic
                                .iter()
                                .map(|(n, c)| (n.to_ascii_lowercase(), c.clone())),
                        )
                        .collect();
                    (result, mosaic)
                })
                .map_err(|e| to_js_err(e, "GLB 导出失败"))
        }

}


// ---------------- 本端 BspMetadata（序列化输出面各端不同）----------------


// ---------------------------------------------------------------------------
// 纹理解码与图集/MTZ 导出已迁至共享 `websurf-wasm-bindings`（feature `core`）：
// decode_vtf_to_png / mosaic_encode / mosaic_decode / decompress_mtz 由本文件顶部的
// `pub use websurf_wasm_bindings::*;` 原样再导出。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 元数据与解析入口
// ---------------------------------------------------------------------------

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



impl BspMetadata {
    /// 由 `Bsp` 组元数据；`packed_files` 与 `num_static_props` 都由 `BspProcessor` 的构造期
    /// 缓存传入——`Packfile` 的 zip 字段私有（`src/wasm-core/vbsp/data/mod.rs`），取条目数只能先
    /// `clone()` 再 `into_zip()`（消费 self）；`static_props()` 是线性扫描。两者都只在构造期算一次。
    fn from_bsp(bsp: &vbsp::Bsp, packed_files: usize, num_static_props: usize) -> Self {

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
