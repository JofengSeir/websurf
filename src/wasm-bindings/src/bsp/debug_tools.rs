// debug_tools: task-73 slice2 生成（源=debug），请勿手改。

// debug_tools: task-73 slice2 生成（源=三端 lib.rs 按 body 指纹分组），请勿手改。

#![allow(unused_imports, dead_code, non_snake_case)]
use super::{to_js_err, BspProcessor};
use wasm_bindgen::prelude::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use websurf_wasm_core::{bsp_to_gltf_core, model_integrator, pakfile_models, phyfile, vbsp};
use websurf_wasm_core::render_bundle::{
    aabb_volume, brush_entity_indices, brush_model_indices, build_brush_model_origins,
    build_vmt_stem_index, collect_light_entities, collect_pakfile_models_bundle,
    entity_is_non_solid, entity_start_solid, load_vmdl, model_classnames,
    resolve_pakfile_materials, ColliderFilter, PakfileModels, VhvLog,
};
use model_integrator::{ExportOptions, InMemoryModel, InMemoryResources, ModelIntegrator};


// ---------------- 导出方法（#[wasm_bindgen] impl） ----------------

#[wasm_bindgen]
impl BspProcessor {

    /// 导出 BSP brush 的平面列表。
        ///
        /// 与 `export_colliders_with_filter` 的区别：
        /// - 输出平面列表（`Plane {normal, dist}`）而非三角化顶点，直接匹配 cs-movement 的 `Brush` 类型
        /// - 坐标旋转 `[x,y,z]→[y,z,x]`（det=+1，正交，不翻转绕序）
        /// - 废弃旧 `[x,y,z]→[x,z,y]` 反射约定（det=−1，需翻转绕序）
        ///
        /// 返回 `WasmBrush[]` JSON：`[{ planes: [{normal, dist}], min, max,
        /// is_ladder, is_solid }]`。
        ///
        /// **坐标转换**：BSP Z-up → Three.js Y-up（`[x,y,z]→[y,z,x]`）。
        /// 法线旋转 `normal = [n.y, n.z, n.x]`；dist 不变（正交变换 `dot(Rn,Rp)=dot(n,p)`）。
        ///
        /// `filter_json` 参数同 `export_colliders_with_filter`（`ColliderFilter` JSON）。
        pub fn export_brushes_planes(&self, filter_json: &str) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;
            // 共享实现（bsp/common.rs）：debug 端额外输出 is_real_face / is_bevel 诊断键，
            // 控制台统计保持原来的 total/exported/skipped 三项。
            super::common::export_brushes_planes_impl(
                bsp,
                filter_json,
                super::common::BrushPlanesOpts {
                    debug_plane_flags: true,
                    detailed_skip_log: false,
                },
            )
        }

    /// 导出 BSP brush 的凸包碰撞体数据（无过滤，便捷方法）。
        ///
        /// 等价于 `export_colliders_with_filter("{}")`，保留以兼容旧调用方；
        /// 需要过滤 sky/nodraw/ladder/solid/小体积 brush 时用
        /// [`BspProcessor::export_colliders_with_filter`]。
        pub fn export_colliders(&self) -> Result<String, JsValue> {
            self.export_colliders_with_filter("{}")
        }

    /// 导出 BSP brush 的凸包碰撞体数据（带过滤参数）。
        ///
        /// 每个 SOLID/LADDER brush 转换为一个 ConvexPolyhedron（顶点 + 三角面索引），
        /// 参考 webgl-kz 方案：brush 即凸多面体，法线来自真实面，支持斜坡。
        ///
        /// `filter_json` 是 [`ColliderFilter`] 的 JSON，控制导出哪些 brush：
        /// - `include_ladder` / `include_solid`: 是否导出 LADDER / SOLID brush（默认 true）
        /// - `skip_sky`: 是否跳过含 SKY 纹理的 brush（默认 false，见下）；`skip_nodraw`: 是否跳过含 NODRAW 纹理的 brush（默认 false）
        /// - `min_brush_volume`: 跳过 AABB 体积小于此值的 brush（默认 0，不跳过）
        ///
        /// 算法：收集 brush 平面 → 三平面求交得凸包顶点（过滤正侧）→ 按面 fan 三角化 →
        /// 坐标转换 BSP Z-up → Three.js Y-up。
        /// 注意：该转换是 reflection（det=-1）会反转手性，故翻转三角形顶点顺序
        /// `[a,b,c]→[a,c,b]` 保持法线朝外。
        ///
        /// 返回 JSON：`{ "colliders": [{ "points": [...], "indexs": [[a,c,b], ...],
        /// "is_ladder": false, "is_solid": true, "brush_index": 0 }],
        /// "total_brushes": N, "exported": N, "skipped": N }`
        pub fn export_colliders_with_filter(
            &self,
            filter_json: &str,
        ) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

            // 解析过滤参数（无效 JSON 或缺失字段用默认值）
            let filter: ColliderFilter =
                serde_json::from_str(filter_json).unwrap_or_default();

            use vbsp::{Brush, BrushFlags, Plane};

            #[derive(serde::Serialize)]
            struct Collider {
                points: Vec<[f32; 3]>,
                indexs: Vec<[u32; 3]>,
                is_ladder: bool,
                is_solid: bool,
                brush_index: usize,
            }
            #[derive(serde::Serialize)]
            struct ColliderReport {
                colliders: Vec<Collider>,
                total_brushes: usize,
                exported: usize,
                skipped: usize,
            }

            // 三平面求交（克莱默法则）：det = n1·(n2×n3)
            // P = (d1*(n2×n3) + d2*(n3×n1) + d3*(n1×n2)) / det
            fn plane_intersect(p1: &Plane, p2: &Plane, p3: &Plane) -> Option<[f32; 3]> {
                let n1 = &p1.normal;
                let n2 = &p2.normal;
                let n3 = &p3.normal;
                // n2 × n3
                let c23 = [
                    n2.y * n3.z - n2.z * n3.y,
                    n2.z * n3.x - n2.x * n3.z,
                    n2.x * n3.y - n2.y * n3.x,
                ];
                let det = n1.x * c23[0] + n1.y * c23[1] + n1.z * c23[2];
                if det.abs() < 1e-6 {
                    return None;
                }
                // n3 × n1
                let c31 = [
                    n3.y * n1.z - n3.z * n1.y,
                    n3.z * n1.x - n3.x * n1.z,
                    n3.x * n1.y - n3.y * n1.x,
                ];
                // n1 × n2
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

            // 单次遍历 brush_sides 收集平面引用 + texture_flags（sky/nodraw），合并原三次遍历
            fn collect_planes_and_flags<'a>(
                bsp: &'a vbsp::Bsp,
                brush: &Brush,
            ) -> (Vec<&'a Plane>, bool /*is_sky*/, bool /*is_nodraw*/) {
                let mut planes = Vec::new();
                let mut is_sky = false;
                let mut is_nodraw = false;
                let sky_flags = vbsp::TextureFlags::SKY | vbsp::TextureFlags::SKY2D;
                let start = brush.brush_side as usize;
                let count = brush.num_brush_sides as usize;
                for i in 0..count {
                    let Some(side) = bsp.brush_sides.get(start + i) else {
                        continue;
                    };
                    // BSP 原生 bevel side（`side.bevel != 0`，编译器为"盒子别卡在棱上"生成的
                    // 过棱小平面）**照常进平面表**：刀刃脊可站由它承担（owner 裁决；
                    // 旧口径"在此剔除 bevel、运行时另合成切角平面"已整段撤除）。
                    // 收集平面引用
                    if let Some(plane) = bsp.planes.get(side.plane as usize) {
                        planes.push(plane);
                    }
                    // 检查 texture_flags（未命中时检查，短路优化）
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
                (planes, is_sky, is_nodraw)
            }

            // 计算 brush 顶点：三平面组合求交 + 过滤
            fn compute_vertices(planes: &[&Plane]) -> Vec<[f32; 3]> {
                let mut verts: Vec<[f32; 3]> = Vec::new();
                // 空间哈希去重：cell=0.1 HU，key=(x*10,y*10,z*10) as i32，O(m²)→O(m)
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
                                // 验证 v 在所有平面正侧（容差 1.0 HU，容许大坐标浮点误差）
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
                                // 空间哈希去重：距离 < 0.1 HU 视为同一点，查 3x3x3 邻域
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

            // 按面三角化：取平面上的顶点，按角度排序后 fan triangulate
            fn triangulate(planes: &[&Plane], verts: &[[f32; 3]]) -> Vec<[u32; 3]> {
                let mut indexs = Vec::new();
                for p in planes {
                    let normal = &p.normal;
                    // 找到在该平面上的顶点（距离 < eps）
                    let mut face_verts: Vec<usize> = Vec::new();
                    for (vi, v) in verts.iter().enumerate() {
                        let d = normal.x * v[0] + normal.y * v[1] + normal.z * v[2] - p.dist;
                        if d.abs() < 0.1 {
                            face_verts.push(vi);
                        }
                    }
                    if face_verts.len() < 3 {
                        continue;
                    }
                    // 计算质心
                    let mut cx = 0.0f32;
                    let mut cy = 0.0f32;
                    let mut cz = 0.0f32;
                    for &vi in &face_verts {
                        cx += verts[vi][0];
                        cy += verts[vi][1];
                        cz += verts[vi][2];
                    }
                    let inv_n = 1.0 / face_verts.len() as f32;
                    cx *= inv_n;
                    cy *= inv_n;
                    cz *= inv_n;
                    // 选参考方向（与法线不平行）
                    let ref_dir = if normal.x.abs() < 0.9 {
                        [1.0f32, 0.0, 0.0]
                    } else {
                        [0.0, 1.0, 0.0]
                    };
                    // u = normalize(ref_dir - (ref_dir·normal)*normal)，平面内参考轴
                    let dot_rn = ref_dir[0] * normal.x + ref_dir[1] * normal.y + ref_dir[2] * normal.z;
                    let u_raw = [
                        ref_dir[0] - dot_rn * normal.x,
                        ref_dir[1] - dot_rn * normal.y,
                        ref_dir[2] - dot_rn * normal.z,
                    ];
                    let ulen = (u_raw[0] * u_raw[0] + u_raw[1] * u_raw[1] + u_raw[2] * u_raw[2]).sqrt();
                    if ulen < 1e-6 {
                        continue;
                    }
                    let u = [u_raw[0] / ulen, u_raw[1] / ulen, u_raw[2] / ulen];
                    // v = normal × u（在平面内，与 u 正交）
                    let v = [
                        normal.y * u[2] - normal.z * u[1],
                        normal.z * u[0] - normal.x * u[2],
                        normal.x * u[1] - normal.y * u[0],
                    ];
                    // 预计算顶点极角（每顶点 1 次 atan2），避免 sort 比较器重复计算，提速 5-10×
                    let mut angled: Vec<(usize, f32)> = face_verts
                        .iter()
                        .map(|&vi| {
                            let va = &verts[vi];
                            let da = [va[0] - cx, va[1] - cy, va[2] - cz];
                            let ang = (da[0] * u[0] + da[1] * u[1] + da[2] * u[2])
                                .atan2(da[0] * v[0] + da[1] * v[1] + da[2] * v[2]);
                            (vi, ang)
                        })
                        .collect();
                    angled.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
                    face_verts = angled.into_iter().map(|(vi, _)| vi).collect();
                    // fan triangulate（顶点顺序 [0, i, i+1] 为 CCW 从法线方向看）
                    for i in 1..(face_verts.len() - 1) {
                        indexs.push([
                            face_verts[0] as u32,
                            face_verts[i] as u32,
                            face_verts[i + 1] as u32,
                        ]);
                    }
                }
                indexs
            }

            // 主循环
            let mut colliders = Vec::new();
            let mut skipped = 0;
            // 【修复】brush → 模型 world origin 映射（实体 brush 局部坐标 → 世界坐标）
            let brush_model_origins = build_brush_model_origins(bsp);
            // 【修复】无碰撞实体（trigger_* / func_illusionary 等）的 brush 不导出为碰撞体，
            // 否则玩家会在触发区域踩到透明空气墙（用户实测）。
            let brush_models = brush_model_indices(bsp);
            let model_classes = model_classnames(bsp);
            // 调试：跳过原因统计
            let mut skip_no_solid_ladder = 0;
            let mut skip_filter_ladder = 0;
            let mut skip_filter_solid = 0;
            let mut skip_sky = 0;
            let mut skip_nodraw = 0;
            let mut skip_planes_lt4 = 0;
            let mut skip_verts_lt4 = 0;
            let mut skip_volume = 0;
            let mut skip_triangulate_empty = 0;
            const MAX_BRUSHES: usize = 8000; // 性能保护：上限

            for (brush_idx, brush) in bsp.brushes.iter().enumerate() {
                if colliders.len() >= MAX_BRUSHES {
                    break;
                }
                // Source 引擎 MASK_PLAYERSOLID 语义：SOLID | WINDOW(玻璃) | GRATE(栅栏) |
                // PLAYERCLIP(玩家 clip) | MOVEABLE(可移动实体)。
                // WATER/SLIME 不在掩码中（可游入），不生成碰撞体。
                let player_solid_mask = BrushFlags::SOLID
                    | BrushFlags::WINDOW
                    | BrushFlags::GRATE
                    | BrushFlags::PLAYERCLIP
                    | BrushFlags::MOVEABLE;
                let is_solid = brush.flags.intersects(player_solid_mask);
                let is_ladder = brush.flags.contains(BrushFlags::LADDER);
                // 只导出 MASK_PLAYERSOLID 或 LADDER brush
                if !is_solid && !is_ladder {
                    skipped += 1;
                    skip_no_solid_ladder += 1;
                    continue;
                }
                // 无碰撞实体 brush 过滤：trigger_* / func_illusionary 等不产生碰撞体
                if let Some(mi) = brush_models.get(brush_idx).copied().flatten() {
                    if let Some(cls) = model_classes.get(mi).and_then(|c| c.as_deref()) {
                        if entity_is_non_solid(cls) {
                            skipped += 1;
                            continue;
                        }
                    }
                }
                // 应用过滤参数
                if !filter.include_ladder && is_ladder {
                    skipped += 1;
                    skip_filter_ladder += 1;
                    continue;
                }
                if !filter.include_solid && is_solid {
                    skipped += 1;
                    skip_filter_solid += 1;
                    continue;
                }
                // 单次遍历收集 planes + sky/nodraw 标志
                let (planes, is_sky, is_nodraw) = collect_planes_and_flags(bsp, brush);
                // 【修复】实体模型 brush 的 planes 是局部坐标——平移模型 origin 到世界位置，
                // 否则碰撞体全部堆在模型原点（"大量不可见碰撞箱堆积在 0,0,0"）。
                let origin = brush_model_origins[brush_idx];
                let has_origin = origin[0] != 0.0 || origin[1] != 0.0 || origin[2] != 0.0;
                let owned_planes: Vec<Plane> = if has_origin {
                    planes
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
                let plane_refs: Vec<&Plane> = if has_origin {
                    owned_planes.iter().collect()
                } else {
                    planes
                };
                if filter.skip_sky && is_sky {
                    skipped += 1;
                    skip_sky += 1;
                    continue;
                }
                if filter.skip_nodraw && is_nodraw {
                    skipped += 1;
                    skip_nodraw += 1;
                    continue;
                }
                if plane_refs.len() < 4 {
                    skipped += 1;
                    skip_planes_lt4 += 1;
                    continue;
                }

                // 正常计算顶点
                let mut verts = compute_vertices(&plane_refs);
                // 回退：顶点 < 4 时翻转法线重算（部分编辑器生成法线朝内的 brush）
                let flipped: Vec<Plane> = if verts.len() < 4 {
                    plane_refs.iter().map(|p| Plane {
                        normal: vbsp::Vector { x: -p.normal.x, y: -p.normal.y, z: -p.normal.z },
                        dist: -p.dist,
                        ty: p.ty,
                    }).collect()
                } else { Vec::new() };
                if verts.len() < 4 && !flipped.is_empty() {
                    let flipped_refs: Vec<&Plane> = flipped.iter().collect();
                    verts = compute_vertices(&flipped_refs);
                }
                if verts.len() < 4 {
                    skipped += 1;
                    skip_verts_lt4 += 1;
                    continue;
                }

                // min_brush_volume 过滤（AABB 体积估算），提前于 triangulate 避免无用的三角化
                if filter.min_brush_volume > 0.0 {
                    let vol = aabb_volume(&verts);
                    if vol < filter.min_brush_volume {
                        skipped += 1;
                        skip_volume += 1;
                        continue;
                    }
                }

                // 三角化使用翻转后的法线（如已翻转）
                let triangulate_planes: Vec<&Plane> = if !flipped.is_empty() {
                    flipped.iter().collect()
                } else {
                    plane_refs.clone()
                };
                let mut indexs = triangulate(&triangulate_planes, &verts);
                if indexs.is_empty() {
                    skipped += 1;
                    skip_triangulate_empty += 1;
                    continue;
                }

                // 坐标转换 BSP Z-up → Three.js Y-up：`[x,y,z]→[x,z,y]`（det=-1 reflection，反转手性），
                // 翻转三角形顶点顺序 [a,b,c]→[a,c,b] 保持法线朝外；原地修改后 move，避免额外分配
                for v in verts.iter_mut() {
                    let (x, y, z) = (v[0], v[1], v[2]);
                    v[0] = x;
                    v[1] = z;
                    v[2] = y;
                }
                let points = verts; // move，verts 不再使用
                for tri in indexs.iter_mut() {
                    tri.swap(1, 2);
                }

                colliders.push(Collider {
                    points,
                    indexs,
                    is_ladder,
                    is_solid,
                    brush_index: brush_idx,
                });
            }

            let report = ColliderReport {
                total_brushes: bsp.brushes.len(),
                exported: colliders.len(),
                skipped,
                colliders,
            };
            // 调试：输出跳过原因统计到控制台
            web_sys::console::log_1(&format!(
                "[Colliders Debug] total={}, exported={}, skipped={}, skip_reasons: no_solid_ladder={}, filter_ladder={}, filter_solid={}, sky={}, nodraw={}, planes_lt4={}, verts_lt4={}, volume={}, triangulate_empty={}",
                report.total_brushes, report.exported, report.skipped,
                skip_no_solid_ladder, skip_filter_ladder, skip_filter_solid,
                skip_sky, skip_nodraw, skip_planes_lt4, skip_verts_lt4,
                skip_volume, skip_triangulate_empty
            ).into());
            serde_json::to_string(&report).map_err(|e| to_js_err(e, "序列化碰撞体数据失败"))
        }

    /// 导出为 GLB 字节数组（纯地图，不带内嵌模型）。
        ///
        /// 用 `bsp_to_gltf_core::ConvertOptions::default()` 调 `export_bsp`，故不带缺失纹理回退、
        /// 不生成缺失列表、不导出光源。
        ///
        /// 消费内部 `bsp`（`export_bsp` 收 `Arc<Bsp>` 且此处用 `take()`）：再次导出需重新
        /// `new BspProcessor(bytes)`；已被消费时报 `"BSP 未解析或已被导出消费"`。
        /// 其余失败语义：`"GLB 导出失败: <Debug>"` / `"GLB 序列化失败: <Debug>"`。
        pub fn export_glb(&mut self) -> Result<Vec<u8>, JsValue> {
            let bsp = self
                .bsp
                .take()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费"))?;
            super::glb_impl::run_glb_export(
                self,
                bsp,
                super::glb_impl::GlbExportOpts {
                    vhv_log: VhvLog::IfAnyProp,
                    options: super::glb_impl::OptionsSource::Plain,
                    include_lights: false,
                    force_integrator: false,
                    skip_model_extraction: true,
                    cache_mosaic: false,
                    materials_win_mosaic: false,
                },
            )
        }

    /// 导出为 GLB，并把调用方传入的**内存模型**（`.mdl/.vvd/.dx90.vtx` 字节）合并进同一地图。
        ///
        /// 模型字节由 JS 侧提供，本入口不读 PAKFILE，也不用其中的纹理或材质标注 —— 除
        /// `static_props` 放置表外，`InMemoryResources` 其余字段都留空
        /// （`entities` / `light_entities` 为空、两张材质表为空），故这条路径不导出灯光、
        /// 也没有内置透明度标注，透明度只能靠 `textures_js` 之外的环节补齐。
        ///
        /// # 参数
        /// - `models_js`: 逐元素反序列化成 `InMemoryModel`，形状为
        ///   `{ "name": "…/crate.mdl", "mdl": Uint8Array, "vvd": Uint8Array, "vtx": Uint8Array }`；
        ///   解析失败报 `"模型参数解析失败: <Debug>"`。
        /// - `textures_js`: 反序列化成 `HashMap<String, Vec<u8>>`；键为纹理名（如 `"metal/crate"`），
        ///   值为 PNG 字节。解析失败报 `"纹理参数解析失败: <Debug>"`。
        ///
        /// # 放置信息
        /// 位置（origin）、朝向（angles）、solid 与两级 prop 光照全部由
        /// `bsp.static_props()` 派生（复用 `collect_pakfile_models`），不从入参取。
        ///
        /// 同样**消费**内部 `bsp`，被消费后报 `"BSP 未解析或已被导出消费，请重新 new"`。
        pub fn export_glb_with_models(
            &mut self,
            models_js: JsValue,
            textures_js: JsValue,
        ) -> Result<Vec<u8>, JsValue> {
            let bsp = self
                .bsp
                .take()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;

            // 解析 JS 传入的内存模型与纹理表
            let models: Vec<InMemoryModel> = serde_wasm_bindgen::from_value(models_js)
                .map_err(|e| JsValue::from_str(&format!("模型参数解析失败: {:?}", e)))?;
            let textures: HashMap<String, Vec<u8>> = serde_wasm_bindgen::from_value(textures_js)
                .map_err(|e| JsValue::from_str(&format!("纹理参数解析失败: {:?}", e)))?;

            // 从 BSP 派生静态道具放置信息（位置 / 朝向 / solid），并带上两级 prop 烘焙光照
            // （第 1 级 `sp_<idx>.vhv` 逐顶点 / 第 2 级 leaf ambient cube）——
            // 与 PAKFILE 提取路径共用 `collect_pakfile_models` 的同一份派生。
            // 本入口只取放置表：模型与条目名都丢弃（模型字节来自 `models_js`）。
            let pak = self.collect_models_for(&bsp, VhvLog::IfAnyProp)?;

            let resources = InMemoryResources {
                models,
                entities: Vec::new(),
                static_props: pak.static_props.clone(),
                textures,
                material_alpha_mode: std::collections::HashMap::new(),
                material_unlit: std::collections::HashSet::new(),
                material_envmap: std::collections::HashMap::new(), material_bumpmap: std::collections::HashMap::new(), material_water: std::collections::HashMap::new(),
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

    /// 自动从 BSP 的 PAKFILE 提取模型并合并进同一份地图 GLB。
        ///
        /// 流程：`collect_pakfile_models` 枚举 PAKFILE 取出被 `static_props` 引用且三件套齐全的模型
        /// 与放置表 → 建 `pakfile_models::PakIndex` → `resolve_pakfile_materials` 解 VMT 标注并解 VTF
        /// → 装 `InMemoryResources` → `ModelIntegrator::from_in_memory` → `export_bsp_with_models`。
        ///
        /// 回退条件：提取到的模型表为空时（PAKFILE 里没有被引用的模型，或三件套不齐全）改用
        /// `bsp_to_gltf_core::export_bsp` 输出纯地图，不报错、不产生区别对待的返回值。
        ///
        /// 本入口不导出灯光（`light_entities` 留空、`ExportOptions` 用默认值），要带灯光用
        /// `export_glb_with_pakfile_models_with_lights` 或 `..._with_defaults_and_lights`；也不注入
        /// 缺失纹理回退表（`missing_fallback` 为空），要回退用 `..._with_defaults`。
        ///
        /// 消费内部 `bsp`；被消费后报 `"BSP 未解析或已被导出消费，请重新 new"`。
        pub fn export_glb_with_pakfile_models(&mut self) -> Result<Vec<u8>, JsValue> {
            let bsp = self
                .bsp
                .take()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;
            super::glb_impl::run_glb_export(
                self,
                bsp,
                super::glb_impl::GlbExportOpts {
                    vhv_log: VhvLog::IfAnyProp,
                    options: super::glb_impl::OptionsSource::Plain,
                    include_lights: false,
                    force_integrator: false,
                    skip_model_extraction: false,
                    cache_mosaic: false,
                    materials_win_mosaic: false,
                },
            )
        }

    /// 导出 GLB（PAKFILE 模型 + **BSP 光照**），不注入缺失纹理回退表。
        ///
        /// 实现上是 `export_glb_with_defaults_opts("{}", 0, true)`：回退表为空 map，
        /// 故与 `..._with_defaults_and_lights` 只差一个非空回退表。手写 TS 侧无调用点。
        pub fn export_glb_with_pakfile_models_with_lights(&mut self) -> Result<Vec<u8>, JsValue> {
            let bsp = self
                .bsp
                .take()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;
            super::glb_impl::run_glb_export(
                self,
                bsp,
                super::glb_impl::GlbExportOpts {
                    vhv_log: VhvLog::IfAnyProp,
                    options: super::glb_impl::OptionsSource::Defaults {
                        json: "{}",
                        atlas: 0,
                    },
                    include_lights: true,
                    force_integrator: false,
                    skip_model_extraction: false,
                    cache_mosaic: true,
                    materials_win_mosaic: false,
                },
            )
        }

    pub fn export_missing_model_textures(&self, defaults_json: &str) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 已被消费或未加载"))?;
            let fallback: std::collections::HashMap<String, String> = serde_json::from_str(defaults_json)
                .map_err(|e| to_js_err(e, "默认纹理包 JSON 解析失败"))?;
            let pak = self.collect_models(VhvLog::Never)?;
            let index = pakfile_models::PakIndex::build(&pak.entry_names);
            let mat = resolve_pakfile_materials(bsp, &pak.models, &index, true, Some(&fallback));
            let mut missing: Vec<String> = mat
                .alpha_modes
                .keys()
                .filter(|n| !mat.textures.contains_key(*n))
                .cloned()
                .collect();
            missing.sort();
            serde_json::to_string(&missing).map_err(|e| to_js_err(e, "序列化模型缺失纹理列表失败"))
        }

    /// 导出缺失材质纹理列表（VMT/VTF 缺失或解码失败 → 占位色）JSON 字符串数组。
        ///
        /// 前端加载后与默认配置纹理包（textures.mtz 解压的键集合）比对，
        /// 列出默认包也无法覆盖的缺失纹理并等待用户确认。
        pub fn export_missing_textures(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 已被消费或未加载"))?;
            let options = websurf_wasm_core::bsp_to_gltf_core::ConvertOptions {
                probe_only: true,
                vmt_fallback: self.vmt_fallback.clone(),
                ..websurf_wasm_core::bsp_to_gltf_core::ConvertOptions::default()
            };
            let missing = websurf_wasm_core::mosaic::manifest::collect_missing_textures_with(bsp, &options);
            serde_json::to_string(&missing).map_err(|e| to_js_err(e, "序列化缺失纹理列表失败"))
        }

    pub fn export_model_phy_bevels(&self) -> Result<String, JsValue> {
                const MAX_PIECES: usize = 40_000;
                const MAX_PLANES: usize = 80_000;
                let json = self.export_model_phy_colliders()?;
            let meshes: Vec<PhyColliderMesh> =
                serde_json::from_str(&json).map_err(|e| to_js_err(e, "解析 .phy 碰撞 JSON"))?;
            let mut out: Vec<serde_json::Value> = Vec::new();
            let mut planes_total = 0usize;
            for mesh in &meshes {
                if out.len() >= MAX_PIECES || planes_total >= MAX_PLANES {
                    break;
                }
                for ids in vertex_components(mesh.vertices.len(), &mesh.indices) {
                    if ids.len() < 4 {
                        continue;
                    }
                    let mut remap: Vec<u32> = vec![u32::MAX; mesh.vertices.len()];
                    let mut verts: Vec<[f64; 3]> = Vec::with_capacity(ids.len());
                    for &i in &ids {
                        remap[i as usize] = verts.len() as u32;
                        let v = mesh.vertices[i as usize];
                        verts.push([v[0] as f64, v[1] as f64, v[2] as f64]);
                    }
                    let tris: Vec<[u32; 3]> = mesh
                        .indices
                        .iter()
                        .filter(|t| remap[t[0] as usize] != u32::MAX)
                        .map(|t| {
                            [
                                remap[t[0] as usize],
                                remap[t[1] as usize],
                                remap[t[2] as usize],
                            ]
                        })
                        .collect();
                    if tris.is_empty() {
                        continue;
                    }
                    let bevels = websurf_phys::phys::hull_bevels::hull_bevels(&verts, &tris);
                    if bevels.box_added + bevels.edge_added == 0 {
                        continue;
                    }
                    let mut min = [f64::INFINITY; 3];
                    let mut max = [f64::NEG_INFINITY; 3];
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
                    let generated: Vec<[f64; 11]> = bevels
                        .added
                        .iter()
                        .map(|b| {
                            // 11 个数：平面 [nx,ny,nz,d] + 类别（0=box / 1=edge）+ 来源边两端点
                            // [ax,ay,az,bx,by,bz]（box bevel 没有来源边，写 0）。
                            let (kind, a, b2) = match (b.kind, b.edge) {
                                (websurf_phys::phys::hull_bevels::BevelKind::Edge, Some([a, b2])) => {
                                    (1.0, a, b2)
                                }
                                _ => (0.0, [0.0; 3], [0.0; 3]),
                            };
                            [
                                b.plane.normal[0],
                                b.plane.normal[1],
                                b.plane.normal[2],
                                b.plane.dist,
                                kind,
                                a[0],
                                a[1],
                                a[2],
                                b2[0],
                                b2[1],
                                b2[2],
                            ]
                        })
                        .collect();
                    planes_total += generated.len();
                    out.push(serde_json::json!({
                        "name": mesh.name,
                        "min": min,
                        "max": max,
                        "box": bevels.box_added,
                        "edge": bevels.edge_added,
                        "rejected": bevels.rejected_edge_candidates,
                        "planes": generated,
                    }));
                }
            }
            serde_json::to_string(&out).map_err(|e| to_js_err(e, "序列化 .phy 补面失败"))
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
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;
            let pak = self.collect_models(VhvLog::IfAnyProp)?;
            super::colliders_impl::export_model_phy_colliders(bsp, &pak)
        }

    /// 导出 PAKFILE 内嵌模型的**可视网格**当碰撞网格用（世界空间三角形，不做几何简化）。
        ///
        /// 本入口不做任何碰撞体转化：不挤出厚度、不共面合并、不凸包、不做 OBB 回退，
        /// 逐顶点搬进世界空间后直接输出三角形。顶点链是
        /// `map_coords(model.apply_root_transform(v))` → `pakfile_models::place_point`
        /// （用 `placement` 的 `translation` / `rotation` / `scale` 就地烘进坐标）；
        /// 其中 `placement` 与 GLB 显示路径同源，都来自 `model_integrator::resolve_placements`，
        /// 但显示路径是把这组值写在 glTF 节点上（见 `src/wasm-core/model_integrator/mod.rs` 的
        /// `add_models_to_gltf`），不在 CPU 侧改顶点，故两条路径的顶点数值一致、承载方式不同。
        ///
        /// 输出 JSON：`[{ "name", "vertices": [[x,y,z]...], "indices": [[a,b,c]...],
        /// "min": [...], "max": [...] }]`，每个放置实例一个条目，世界坐标 Y-up。
        ///
        /// 门控：唯一门控是放置表上的 `solid == Some(0)`（`vbsp` 的 `SolidType::None`）。
        /// **不按材质透明度剔除**：起源引擎的碰撞来自模型的 `.phy`（vphysics）与 BSP 的 `contents` 位，
        /// `$translucent` / `$alphatest` 这类材质键只进渲染，从不参与碰撞定义
        /// （玻璃 / 水面道具本该可站可撞；探针在 `surf_666` 的窗与 `surf_sedona` 的坡上实测到被误剔）。
        ///
        /// 规模护栏：累计三角形数达 `MAX_TRI_TOTAL`（200_000）后停止取新模型、并中止当前实例循环，
        /// 已产出的条目照常返回；放置表为空或三件套不全的模型直接跳过。
        ///
        /// # 调用时机
        /// 只借用 `bsp`，须在消费 `bsp` 的导出入口之前调用；被消费后报
        /// `"BSP 未解析或已被导出消费，请重新 new"`。模型表为空时返回字符串 `"[]"`。
        pub fn export_model_tri_colliders(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;
            let pak = self.collect_models(VhvLog::IfAnyProp)?;
            super::colliders_impl::export_model_tri_colliders(bsp, &pak)
        }

    /// 生成纹理画质 manifest：`{ 纹理名(小写 VMT 路径): mosaic v4 字节码 }` JSON。
        ///
        /// 前端画质切换（原始/压缩低清）用：GLB 导出后调用一次（export_glb* 消费 BSP 之前），
        /// 切换画质时用 `mosaic_decode` 还原低清 PNG 替换贴图，无需重载地图。
        ///
        /// 覆盖两类纹理（与 GLB texture.name 对应）：
        /// 1. 地图 face 纹理（key = basetexture 小写，如 "materials/xxx"）
        /// 2. PAKFILE 模型贴图（key = 材质名小写，如 "maplebark"——修复 prop 墙面未压缩）
        pub fn export_mosaic_manifest(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 已被消费或未加载"))?;
            let pak = self.collect_models(VhvLog::IfAnyProp).ok();
            super::meta_impl::export_mosaic_manifest(bsp, pak.as_deref())
        }

    /// 列出 pakfile 中所有打包文件名（不含内容）。
        ///
        /// 用于快速检查 BSP 是否打包了 Lua/cfg/脚本等参与触发逻辑的资源。
        /// 返回 JSON：`{ "files": ["path1", ...], "total": N }`
        pub fn list_pakfile(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

            #[derive(serde::Serialize)]
            struct PakfileList {
                files: Vec<String>,
                total: usize,
            }

            let zip = bsp.pack.clone().into_zip();
            let mut zip_guard = zip.lock().map_err(|e| {
                JsValue::from_str(&format!("pakfile 锁定失败: {e}"))
            })?;

            let mut files: Vec<String> = Vec::new();
            for i in 0..zip_guard.len() {
                if let Ok(entry) = zip_guard.by_index(i) {
                    files.push(entry.name().to_string());
                }
            }

            let total = files.len();
            serde_json::to_string(&PakfileList { files, total })
                .map_err(|e| to_js_err(e, "序列化 pakfile 列表失败"))
        }

    /// 取元数据 JSON 字符串，字段集见 `BspMetadata`；只借用内部 `bsp`，不消费实例。
        ///
        /// 失败语义：实例已被某个 `export_*` 入口消费时返回 `JsValue` 字符串
        /// `"BSP 未解析或已导出"`（导出入口用的是带「请重新 new」的另一条文案）；序列化失败走
        /// `"序列化 BSP 元数据失败: <Debug>"`。
        pub fn metadata(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;
            super::meta_impl::metadata(bsp, self.packed_files)
        }

    /// 创建处理器并立即解析 BSP 数据；失败语义同 `parse_bsp`（`"BSP 解析失败: <Debug>"`）。
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

    /// 性能/正确性定位用：取一个 pakfile 条目，返回**解压后**的字节。取不到返回 `null`。
        ///
        /// 与 [`BspProcessor::pack_stats`] 同批加的诊断口。用途之一是**差分验证**：把这里的字节与
        /// Python 标准库 `zipfile`（底层 liblzma，独立实现）的产物逐字节对读 —— 修 vendored `lzma`
        /// 的滑窗复杂度时，就是靠它证明「解出来的字节一个都没变」。
        pub fn pack_get(&self, name: &str) -> Result<Option<Vec<u8>>, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 已被消费或未加载"))?;
            match bsp.pack.get(name) {
                Ok(Some(v)) => Ok(Some(v)),
                Ok(None) => Ok(None),
                Err(e) => Err(to_js_err(e, "取 pakfile 条目失败")),
            }
        }

    pub fn pack_stats(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 已被消费或未加载"))?;
            let s = bsp.pack.stats();
            serde_json::to_string(&s).map_err(|e| to_js_err(e, "序列化 pakfile 计数失败"))
        }

    pub fn parse_entities(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;
        super::meta_impl::parse_entities(bsp)
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
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;
            super::colliders_impl::parse_pvs_data(bsp)
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

    /// 解析传送触发器与目的地（trigger_teleport + info_teleport_destination）。
        ///
        /// 返回 JSON：`{ "triggers": [{ index, target, classname, origin,
        /// model_mins, model_maxs, spawnflags, start_disabled, filtername?,
        /// filter_name?, filter_negated }], "links": [{ trigger_idx, dest_idx }], ... }`。
        ///
        /// **名门控**：`filtername` 是实体原始值（指向 filter 实体的 targetname）；
        /// `filter_name` 是从 `filter_activator_name.filtername` 解析出的玩家名模式
        /// （None = 无门控；静态解析，不跟踪 logic_* 运行时改写）；
        /// `filter_negated` 来自 filter 实体的 `Negated` 键（1 = 不匹配才放行）。
        ///
        /// **坐标转换**：BSP Z-up → Three.js Y-up（`[x,y,z]→[y,z,x]`，det=+1）。
        /// `origin` 已旋转为 Y-up；`angles` 保持 BSP 原始 `[pitch, yaw, roll]`。
        pub fn parse_teleports(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;
            super::colliders_impl::parse_teleports(bsp)
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

    /// 读取 pakfile 中所有文本类脚本（lua/cfg/txt/vmt/vdf）。
        ///
        /// 跳过二进制资源（vtf/vpk/bsp/sound）防内存爆炸；单文件上限 256KB。
        ///
        /// 返回 JSON：`{ "files": [{ "name": "path", "size": N, "content": "..." }], "total": N }`
        pub fn read_pakfile_scripts(&self) -> Result<String, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

            #[derive(serde::Serialize)]
            struct ScriptFile {
                name: String,
                size: usize,
                content: String,
            }

            #[derive(serde::Serialize)]
            struct ScriptReport {
                files: Vec<ScriptFile>,
                total: usize,
            }

            // 允许的文本类扩展名（小写）
            const TEXT_EXTS: &[&str] = &[
                "lua", "cfg", "txt", "vmt", "vdf", "kv", "kv3", "res",
                "nut", "sma", "sp", "inc", "json", "xml", "ini",
            ];
            const MAX_FILE_SIZE: usize = 256 * 1024; // 256KB

            let zip = bsp.pack.clone().into_zip();
            let mut zip_guard = zip.lock().map_err(|e| {
                JsValue::from_str(&format!("pakfile 锁定失败: {e}"))
            })?;

            let mut files: Vec<ScriptFile> = Vec::new();
            for i in 0..zip_guard.len() {
                let Ok(mut entry) = zip_guard.by_index(i) else {
                    continue;
                };
                let name = entry.name().to_string();
                // 过滤扩展名
                let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
                if !TEXT_EXTS.contains(&ext.as_str()) {
                    continue;
                }
                // 大小保护
                let size = entry.size() as usize;
                if size > MAX_FILE_SIZE {
                    continue;
                }
                // 读取内容
                let mut buf = Vec::with_capacity(size);
                use std::io::Read;
                if entry.read_to_end(&mut buf).is_err() {
                    continue;
                }
                // 转 String（非 UTF-8 用 lossy 转换）
                let content = String::from_utf8_lossy(&buf).into_owned();
                files.push(ScriptFile {
                    name,
                    size: buf.len(),
                    content,
                });
            }

            let total = files.len();
            serde_json::to_string(&ScriptReport { files, total })
                .map_err(|e| to_js_err(e, "序列化 pakfile 脚本失败"))
        }

}

// ---------------- 内部方法/辅助（普通 impl） ----------------

impl BspProcessor {

    /// 取（或建立）缓存；只读入口用。
        pub(crate) fn collect_models(&self, vhv_log: VhvLog) -> Result<Rc<PakfileModels>, JsValue> {
            let bsp = self
                .bsp
                .as_ref()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;
            self.collect_models_for(bsp, vhv_log)
        }

    /// 四个 defaults 系列入口的共用实现（`lightmap_max_atlas_area` / `include_lights` 可调）。
        ///
        /// `defaults_json` 先整体反序列化成 `HashMap<String, String>`（失败即报
        /// `"默认纹理包 JSON 解析失败: <Debug>"`，不进后续步骤），再经 `options` 闭包写进
        /// `ConvertOptions` 的 `missing_fallback` / `generate_missing_list` / `lightmap_max_atlas_area`。
        ///
        /// 两条支路：模型表为空且 `include_lights == false` 时走 `export_bsp` 纯地图导出
        /// （注意该支路照样传 `options(true)`，即仍会生成缺失纹理列表）；否则装
        /// `InMemoryResources`（`light_entities` 仅当 `include_lights` 为真时由 `collect_light_entities` 填充）
        /// 后走 `export_bsp_with_models`。
        ///
        /// 消费内部 `bsp`；失败语义同其它导出入口。
        pub(crate) fn export_glb_with_defaults_opts(
            &mut self,
            defaults_json: &str,
            lightmap_max_atlas_area: u64,
            include_lights: bool,
        ) -> Result<Vec<u8>, JsValue> {
            let bsp = self
                .bsp
                .take()
                .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;
            super::glb_impl::run_glb_export(
                self,
                bsp,
                super::glb_impl::GlbExportOpts {
                    vhv_log: VhvLog::IfAnyProp,
                    options: super::glb_impl::OptionsSource::Defaults {
                        json: defaults_json,
                        atlas: lightmap_max_atlas_area,
                    },
                    include_lights,
                    force_integrator: false,
                    skip_model_extraction: false,
                    cache_mosaic: true,
                    materials_win_mosaic: false,
                },
            )
        }

}

// ---------------- 顶层辅助条目 ----------------

// ---------------------------------------------------------------------------
// `.phy` 凸体补面导出（debug 第六路线框的数据源）
// ---------------------------------------------------------------------------

/// `export_model_phy_colliders` 输出的一项；本模块只读这三个字段。
#[derive(serde::Deserialize)]
struct PhyColliderMesh {
    name: String,
    vertices: Vec<[f32; 3]>,
    indices: Vec<[u32; 3]>,
}

// ---------------- 自由函数 ----------------

// ---------------------------------------------------------------------------
// 全局初始化：panic 钩子
// ---------------------------------------------------------------------------

/// 把 panic 信息经 `web_sys::console::error_1` 打到控制台，前缀固定为 `"vbsp-wasm panic: "`。
///
/// 仅 `wasm32` 编译（非 wasm 目标下本函数不存在）。无 `#[wasm_bindgen]`，JS 侧无法直接调用，
/// 唯一调用点是 `start`；重复调用会替换掉前一个钩子（`set_hook` 语义）。
#[cfg(target_arch = "wasm32")]
pub fn init_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        web_sys::console::error_1(&format!("vbsp-wasm panic: {}", info).into());
    }));
}

// ---------------- 自由函数 ----------------

/// 一次性解析 BSP 字节数组，返回元数据 JSON 字符串。
///
/// 不持有 `Bsp` 实例：解析出的 `Bsp` 在本函数结束时释放，故只要元数据时用这里更省内存；
/// 要导出 GLB 或做各类提取，改用 [`BspProcessor`]。
///
/// 失败语义：`vbsp::Bsp::read` 失败 → `"BSP 解析失败: <Debug>"`；序列化失败 →
/// `"序列化 BSP 元数据失败: <Debug>"`。
#[wasm_bindgen]
pub fn parse_bsp(data: &[u8]) -> Result<String, JsValue> {
    let bsp = vbsp::Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;
    // Packfile.zip 私有，clone 后取 len()；此处只算一次
    let packed_files = bsp.pack.clone().into_zip().lock().unwrap().len();
    let metadata = BspMetadata::from_bsp(&bsp, packed_files);
    metadata.to_json()
}

// ---------------- 自由函数 ----------------

// ---------------------------------------------------------------------------
// visleaf + PVS 二进制导出（WASM 版 export-vis-pvs，供 Node 脚本离线导出）
//
// 契约：输出 .visleaf.bin / .pvs.bin（格式 v1），字节与旧工作区对照实现（crates/vbsp 的
// export-vis-pvs bin，从未入库、已不存在）完全一致；本导出是该格式当前的唯一实现。
// 依赖 vbsp 修复：leaves lump version 1 解析 + vis data 完整基址。
// ---------------------------------------------------------------------------

/// 从 BSP 字节数组导出 visleaf + PVS 二进制数据。
///
/// 返回 JS 对象：`{ visleaf_bin: Uint8Array(VBVL), pvs_bin: Uint8Array(VBPV),
/// md5Hex: 源 BSP MD5, clusterCount, leafCount, nodeCount, faceCount }`
#[wasm_bindgen]
pub fn export_visleaf_pvs(data: &[u8]) -> Result<JsValue, JsValue> {
    use vbsp::{Bsp, Leaf, Node, Plane, Vector};

    // ---- 源 BSP MD5 ----
    let md5_bytes: [u8; 16] = md5::compute(data).0;
    let md5_hex: String = md5_bytes.iter().map(|b| format!("{:02x}", b)).collect();

    // ---- 解析（含修复：leaves v1 / vis 完整基址）----
    let bsp = Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;

    // ---- 坐标旋转 [x,y,z] → [y,z,x]（BSP Z-up → Three.js Y-up，det=+1）----
    fn rotate_yup_f32(v: &Vector) -> [f32; 3] {
        [v.y, v.z, v.x]
    }
    fn rotate_yup_i16(v: [i16; 3]) -> [i16; 3] {
        [v[1], v[2], v[0]]
    }
    fn default_plane() -> Plane {
        Plane {
            normal: Vector { x: 0.0, y: 0.0, z: 1.0 },
            dist: 0.0,
            ty: 0,
        }
    }

    // ---- nodes ----
    let nodes: Vec<([f32; 3], f32, [i32; 2])> = bsp
        .nodes
        .iter()
        .map(|node: &Node| {
            let plane_idx = node.plane_index as usize;
            let dp = default_plane();
            let plane = bsp.planes.get(plane_idx).unwrap_or(&dp);
            (rotate_yup_f32(&plane.normal), plane.dist, node.children)
        })
        .collect();

    // ---- leaves ----
    let leaves: Vec<(i16, [i16; 3], [i16; 3], bool)> = bsp
        .leaves
        .iter()
        .map(|leaf: &Leaf| {
            (
                leaf.cluster,
                rotate_yup_i16(leaf.mins),
                rotate_yup_i16(leaf.maxs),
                leaf.cluster < 0,
            )
        })
        .collect();

    // ---- face → cluster ----
    let mut face_clusters = vec![-1i32; bsp.faces.len()];
    for leaf in bsp.leaves.iter() {
        if leaf.cluster < 0 {
            continue;
        }
        let start = leaf.first_leaf_face as usize;
        let count = leaf.leaf_face_count as usize;
        if start + count > bsp.leaf_faces.len() {
            continue;
        }
        for fi in start..(start + count) {
            let face_idx = bsp.leaf_faces[fi].face as usize;
            if face_idx < face_clusters.len() && face_clusters[face_idx] < 0 {
                face_clusters[face_idx] = leaf.cluster as i32;
            }
        }
    }

    // ---- PVS 位图（vbsp::decode_pvs_row 为唯一权威解码）----
    let cluster_count = bsp.vis_data.cluster_count;
    let bytes_per_row = (cluster_count as usize).div_ceil(8);
    let mut pvs_bits = vec![0u8; (cluster_count as usize) * bytes_per_row];
    if cluster_count > 0 && !bsp.vis_data.pvs_offsets.is_empty() {
        let vis_data = &bsp.vis_data.data;
        for c in 0..cluster_count {
            let c_usize = c as usize;
            if c_usize >= bsp.vis_data.pvs_offsets.len() {
                break;
            }
            let offset = bsp.vis_data.pvs_offsets[c_usize] as usize;
            vbsp::decode_pvs_row(
                vis_data,
                offset,
                cluster_count,
                bytes_per_row,
                c_usize * bytes_per_row,
                &mut pvs_bits,
            );
        }
    }

    // ---- 打包 visleaf.bin (VBVL) ----
    let mut vl: Vec<u8> = Vec::with_capacity(40 + nodes.len() * 24 + leaves.len() * 15 + face_clusters.len() * 4);
    vl.extend_from_slice(b"VBVL");
    vl.extend_from_slice(&1u32.to_le_bytes());
    vl.extend_from_slice(&md5_bytes);
    vl.extend_from_slice(&cluster_count.to_le_bytes());
    vl.extend_from_slice(&(leaves.len() as u32).to_le_bytes());
    vl.extend_from_slice(&(nodes.len() as u32).to_le_bytes());
    vl.extend_from_slice(&(face_clusters.len() as u32).to_le_bytes());
    for (normal, dist, children) in &nodes {
        for c in normal {
            vl.extend_from_slice(&c.to_le_bytes());
        }
        vl.extend_from_slice(&dist.to_le_bytes());
        for c in children {
            vl.extend_from_slice(&c.to_le_bytes());
        }
    }
    for (cluster, mins, maxs, is_solid) in &leaves {
        vl.extend_from_slice(&cluster.to_le_bytes());
        for c in mins {
            vl.extend_from_slice(&c.to_le_bytes());
        }
        for c in maxs {
            vl.extend_from_slice(&c.to_le_bytes());
        }
        vl.push(*is_solid as u8);
    }
    for fc in &face_clusters {
        vl.extend_from_slice(&fc.to_le_bytes());
    }

    // ---- 打包 pvs.bin (VBPV) ----
    let mut pv: Vec<u8> = Vec::with_capacity(32 + pvs_bits.len());
    pv.extend_from_slice(b"VBPV");
    pv.extend_from_slice(&1u32.to_le_bytes());
    pv.extend_from_slice(&md5_bytes);
    pv.extend_from_slice(&cluster_count.to_le_bytes());
    pv.extend_from_slice(&(bytes_per_row as u32).to_le_bytes());
    pv.extend_from_slice(&pvs_bits);

    // ---- 组装返回对象 ----
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("visleaf_bin"),
        &js_sys::Uint8Array::from(&vl[..]),
    )
    .map_err(|e| to_js_err(e, "设置 visleaf_bin 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("pvs_bin"),
        &js_sys::Uint8Array::from(&pv[..]),
    )
    .map_err(|e| to_js_err(e, "设置 pvs_bin 失败"))?;
    js_sys::Reflect::set(&obj, &JsValue::from_str("md5Hex"), &JsValue::from_str(&md5_hex))
        .map_err(|e| to_js_err(e, "设置 md5Hex 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("clusterCount"),
        &JsValue::from_f64(cluster_count as f64),
    )
    .map_err(|e| to_js_err(e, "设置 clusterCount 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("leafCount"),
        &JsValue::from_f64(leaves.len() as f64),
    )
    .map_err(|e| to_js_err(e, "设置 leafCount 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("nodeCount"),
        &JsValue::from_f64(nodes.len() as f64),
    )
    .map_err(|e| to_js_err(e, "设置 nodeCount 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("faceCount"),
        &JsValue::from_f64(face_clusters.len() as f64),
    )
    .map_err(|e| to_js_err(e, "设置 faceCount 失败"))?;

    Ok(obj.into())
}

// ---------------- 自由函数 ----------------

// ---------------------------------------------------------------------------
// 纹理与图集导出已迁至共享 `websurf-wasm-bindings`（feature `core`）：
// decode_vtf_to_png / mosaic_encode / mosaic_decode / decompress_mtz 由本文件顶部的
// `pub use websurf_wasm_bindings::*;` 原样再导出，错误文本与迁移前逐字一致。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 初始化入口
// ---------------------------------------------------------------------------

/// 模块初始化：安装 panic hook，便于调试。
#[wasm_bindgen(start)]
pub fn start() {
    #[cfg(target_arch = "wasm32")]
    init_panic_hook();
}

// ---------------- 自由函数 ----------------

/// 顶点连通分量（并查集）：把「一只模型的全部凸体块拼成一个 mesh」按三角形连接性拆回块。
///
/// 导出时每块凸体占一段**连续**顶点区间（`base = local.len()` 之后整段拷入），三角形不跨块，
/// 故连通分量与解析期的凸体块一一对应。
fn vertex_components(vertex_count: usize, tris: &[[u32; 3]]) -> Vec<Vec<u32>> {
    let mut parent: Vec<u32> = (0..vertex_count as u32).collect();
    fn find(parent: &mut [u32], mut x: u32) -> u32 {
        while parent[x as usize] != x {
            let gp = parent[parent[x as usize] as usize];
            parent[x as usize] = gp;
            x = gp;
        }
        x
    }
    for t in tris {
        let a = find(&mut parent, t[0]);
        for o in [t[1], t[2]] {
            let r = find(&mut parent, o);
            if r != a {
                parent[r as usize] = a;
            }
        }
    }
    let mut groups: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for i in 0..vertex_count as u32 {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }
    groups.into_values().collect()
}

// ---------------- 自由函数 ----------------

/// 探查：位移顶点 `alpha`（Source `CDispVert.m_flAlpha`）分布 —— `WorldVertexTransition`
/// 的两贴图混合权重。返回分桶直方图，用于验证「雪/岩混合」是否有可用数据。
#[wasm_bindgen]
pub fn disp_vertex_alpha_stats(data: &[u8]) -> Result<String, JsValue> {
    let bsp = vbsp::Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;
    let verts = &bsp.displacement_vertices;
    let mut buckets = [0usize; 10];
    let mut zeros = 0usize;
    let mut ones = 0usize;
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    let mut sum = 0f64;
    for v in verts.iter() {
        let a = v.alpha;
        sum += f64::from(a);
        min = min.min(a);
        max = max.max(a);
        if a <= 0.0 {
            zeros += 1;
        }
        if a >= 1.0 {
            ones += 1;
        }
        let idx = ((a.clamp(0.0, 0.999) * 10.0) as usize).min(9);
        buckets[idx] += 1;
    }
    let n = verts.len().max(1) as f64;
    Ok(format!("{{\"count\":{},\"zeros\":{},\"ones\":{},\"min\":{:.3},\"max\":{:.3},\"mean\":{:.3},\"buckets\":{:?}}}",
        verts.len(), zeros, ones, if verts.is_empty() { 0.0 } else { min }, if verts.is_empty() { 0.0 } else { max }, sum / n, buckets))
}

// ---------------- 自由函数 ----------------

/// 置换面（displacement）的**碰撞三角形汤**（世界坐标，Y-up），供物理侧建洞穴壁/地形碰撞。
///
/// 为什么需要单独一条：笔刷碰撞走平面凸包（`export_brushes_planes`），而置换面把可见表面从基础
/// 笔刷平面**推出去**了——只拿基础平面做碰撞，玩家撞到的是藏在可见面后面那层旧平面，看得见的
/// 洞穴壁反而没有碰撞。Source 对置换面的做法就是**按置换面自身的三角形**烘碰撞（VBSP 的 disp
/// coll），这里与渲染端共用同一条细分+位移路径（`Handle::triangulated_displaced_vertices`），
/// 保证"看到的"与"撞到的"是同一张面。
///
/// 返回 JSON：`[[x,y,z], ...]`，每 3 个顶点一个三角形（与 `triangulated_displaced_vertices`
/// 同序）；坐标已按 `map_coords` 转成与其它碰撞体一致的 Y-up 世界坐标。
#[wasm_bindgen]
pub fn export_displacement_colliders(data: &[u8]) -> Result<String, JsValue> {
    super::colliders_impl::export_displacement_colliders(data)
}

// ---------------- 自由函数 ----------------

/// 压缩 textures.json 文本 → MTZ 容器字节（`src/materials/textures.mtz` 的**写出方向**）。
///
/// 与 [`decompress_mtz`] 互逆：文本是 `{ "materials/<小写路径>": "#mosaic v4 字节码" }` 的逐行形式
/// （见 `websurf_wasm_core::mosaic::mtz` 的 `parse_json` / `render_json`）。
/// **仅供构建期工具 `src/scripts/build-textures-mtz.mjs` 重建默认纹理包使用**，运行时链路不调用。
#[wasm_bindgen]
pub fn compress_mtz(json: &str) -> Result<Vec<u8>, JsValue> {
    websurf_wasm_core::mosaic::mtz::compress_json(json)
        .map_err(|e| JsValue::from_str(&format!("compress_mtz: {e}")))
}


// ---------------- 本端 BspMetadata（序列化输出面各端不同）----------------


// ---------------------------------------------------------------------------
// 元数据 / 解析入口
// ---------------------------------------------------------------------------

/// 顶层元数据：由 `parse_bsp` 与 `BspProcessor::metadata` 序列化成 JSON 字符串返回，
/// 前端 `JSON.parse` 后直接使用。字段名全部是 `snake_case`（无 `rename_all`）。
///
/// 普通 Rust 结构体（不标 `#[wasm_bindgen]`）：wasm_bindgen 导出要求字段实现 `Copy`，
/// 而 `String` 字段不满足；故只能走 `serde_json` 字符串这条出口。
#[derive(serde::Serialize)]
pub struct BspMetadata {
    /// 结构版本号，由 `from_bsp` 写死为 `1`；消费方按它判断字段集。
    pub schema_version: u32,
    /// BSP 魔术字（如 "VBSP"），由 header.v/b/s/p 拼成。
    pub magic: String,
    /// 地图名。`from_bsp` 恒写空串，本结构没有别的写入点。
    pub map_name: String,
    /// 以下计数一律取对应 lump 的长度（`Vec::len()`），不是 BSP 头里的声明值。
    pub num_models: usize,
    pub num_faces: usize,
    /// 原始面数（`original_faces` lump），与 `num_faces` 是两个不同的 lump。
    pub num_original_faces: usize,
    pub num_vertices: usize,
    pub num_edges: usize,
    /// 纹理数据条目数（`textures_data` lump）。
    pub num_textures_data: usize,
    /// 纹理信息条目数（`textures_info` lump）。
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
    // packed_files 由调用方传入，不在本函数内自取：`Packfile.zip` 是私有字段，
    // `into_zip()` 消费 self，取 len 只能先 clone 再开锁；两个调用点各自算一次后复用。
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
