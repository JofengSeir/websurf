//! colliders_impl.rs —— 碰撞 / 传送 / PVS 导出的共享实现（T-P1-1a）。
//!
//! `glb.rs`（game/viewer）与 `debug_tools.rs`（debug）历史上各自持有一份逐字相近的实现，
//! 本模块收拢 5 个函数体；`#[wasm_bindgen]` 外壳、`#[cfg]` 分块与公开签名仍留在原文件，
//! 外壳只保留「取 bsp / 取 pak」与各自的错误文案、`VhvLog` 档位，然后委托到这里。
//!
//! 无导出面变化：本模块不含 `#[wasm_bindgen]`，函数名与 JS 侧无关。

use super::to_js_err;
use wasm_bindgen::prelude::*;
use websurf_wasm_core::vbsp;

// 仅碰撞/传送导出使用的依赖；viewer-export 只编译 PVS 导出，故按 feature 关闭以免 unused 警告。
#[cfg(any(feature = "glb-lite", feature = "debug-tools"))]
use websurf_wasm_core::render_bundle::{load_vmdl, PakfileModels};
#[cfg(any(feature = "glb-lite", feature = "debug-tools"))]
use websurf_wasm_core::{model_integrator, pakfile_models, phyfile};

/// 单个 brush 的局部区域：`(AABB min, AABB max, 凸包平面 [nx,ny,nz,dist])`。
/// viewer-export 只编译 PVS 导出，用不到本别名，故与下面的碰撞函数同条件编译。
#[cfg(any(feature = "glb-lite", feature = "debug-tools"))]
type BrushRegion = ([f32; 3], [f32; 3], Vec<[f32; 4]>);

#[cfg(any(feature = "glb-lite", feature = "debug-tools"))]
pub(crate) fn parse_teleports(bsp: &vbsp::Bsp) -> Result<String, JsValue> {
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
        /// 触发器自身的 `filtername`（原始值，指向 filter 实体的 targetname）；
        /// `None` = 无门控。仅作溯源，运行时判定用 `filter_name`。
        filtername: Option<String>,
        /// 解析后的名门控模式：`filtername` → `filter_activator_name.filtername`
        /// （filter 实体里真正要匹配的玩家名，支持末尾 `*`）。`None` = 无门控或解析不到。
        filter_name: Option<String>,
        /// 名门控是否取反：来自 filter 实体的 `Negated` 键。默认 false = 匹配才放行；
        /// true = **不匹配才放行**（surf_666 起点 3 条门控全是 Negated=1）。
        filter_negated: bool,
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
    ) -> Vec<BrushRegion> {
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
                stack.push(node.children[0]);
                stack.push(node.children[1]);
            }
        }
        // 2. 每个 brush：planes → 凸包顶点 → 局部 AABB（与 compute_vertices 同算法）
        let mut out: Vec<BrushRegion> = Vec::new();
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

    // 名门控表：`filter_activator_name.targetname` → (玩家名模式, 是否取反)。
    // 与 debug-tools 路径共用 `teleport_filters` 一份实现（2026-11-19：此前 glb-lite
    // 这份缺名门控，game 端把 `*361` 当无门控 → 拿到 krazy1 仍每 0.5s 回卷）。
    let filter_names = super::teleport_filters::build_filter_names(bsp);

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

            // StartDisabled：实体文本在读入时已整体转小写（`src/wasm-core/vbsp/reader.rs` 的
            // `read_entities` 调 `to_ascii_lowercase`），而 `RawEntity::prop` 是 `key == prop_key`
            // 的逐字节比较 ⇒ 这里必须传**小写**键，否则取不到、被 `.unwrap_or(false)` 吞掉
            // （2026-10-09 T-015 修；此前恒 false）。
            let start_disabled = ent
                .prop("startdisabled")
                .map(|s| s == "1")
                .unwrap_or(false);

            // 名门控：trigger.filtername 指向 filter 实体，filter.filtername 是玩家名模式。
            // 解析不到（比如指向不存在的 filter）按无门控处理，保持旧地图行为。
            let filtername_raw = ent.prop("filtername").ok().map(|s| s.to_string());
            let (filtername, filter_name, filter_negated) =
                super::teleport_filters::resolve_trigger_filter(&filter_names, filtername_raw);

            // model 格式 "*N" 指向 bsp.models[N]，几何为局部坐标（相对实体 origin）。
            // trigger 可把多个分散 brush 绑到同一实体（Hammer 的 Tie to entity），此时
            // model.mins/maxs 只是总包围盒 ⇒ 逐个 brush 单独算区域。
            let origin_yup = rotate_yup(origin);

            // 每个 brush 一个区域（局部 AABB + 凸包平面，BSP Z-up）
            let regions: Vec<BrushRegion> = match model.as_deref() {
                Some(m) if m.starts_with('*') => m[1..]
                    .parse::<usize>()
                    .ok()
                    .map(|i| model_brush_aabbs(bsp, i))
                    .unwrap_or_default(),
                _ => Vec::new(),
            };
            // 世界 AABB 与世界凸包平面：局部值经 Y-up 旋转后加实体 origin 平移
            let world_regions: Vec<BrushRegion> =
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
                    filtername,
                    filter_name,
                    filter_negated,
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
                        filtername: filtername.clone(),
                        filter_name: filter_name.clone(),
                        filter_negated,
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

#[cfg(any(feature = "glb-lite", feature = "viewer-export", feature = "debug-tools"))]
pub(crate) fn parse_pvs_data(bsp: &vbsp::Bsp) -> Result<String, JsValue> {
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
    let bytes_per_row = (cluster_count as usize).div_ceil(8);
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

/// 一个放置实例的三角形碰撞网格（JSON 与 WSBW 二进制共用同一条提取结果）。
///
/// `surfaceprop` 只有 `.phy` 路径有（可视网格 / 置换面为 `None`，JSON 里整键不出现），
/// 字段顺序即 JSON 键顺序：`name, surfaceprop?, vertices, indices, min, max`。
#[cfg(any(feature = "glb-lite", feature = "debug-tools"))]
#[derive(serde::Serialize)]
pub(crate) struct TriMeshData {
    pub(crate) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) surfaceprop: Option<String>,
    pub(crate) vertices: Vec<[f32; 3]>,
    pub(crate) indices: Vec<[u32; 3]>,
    pub(crate) min: [f32; 3],
    pub(crate) max: [f32; 3],
}

/// `.phy` 凸包碰撞提取：返回结构体，供 JSON 与二进制两个出口复用。
#[cfg(any(feature = "glb-lite", feature = "debug-tools"))]
pub(crate) fn export_model_phy_colliders_data(
    bsp: &vbsp::Bsp,
    pak: &PakfileModels,
) -> Result<Vec<TriMeshData>, JsValue> {
    let models = &pak.models;
    let static_props = &pak.static_props;
    if models.is_empty() {
        return Ok(Vec::new());
    }

    let no_entities: Vec<model_integrator::Entity> = Vec::new();

    const MAX_TRI_TOTAL: usize = 200_000;
    let mut out: Vec<TriMeshData> = Vec::new();
    let mut tri_total = 0usize;

    for m in models {
        if tri_total >= MAX_TRI_TOTAL {
            break;
        }
        // 只处理被 static_props 引用的模型；无 .phy 条目或解析失败即跳过该模型
        let placements =
            model_integrator::resolve_placements(&m.name, &no_entities, static_props);
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
            out.push(TriMeshData {
                name: m.name.clone(),
                surfaceprop: Some(sprop.clone()),
                vertices: verts,
                indices: tris.clone(),
                min,
                max,
            });
        }
    }

    Ok(out)
}

/// JSON 出口（对外字符串契约不变）。
#[cfg(any(feature = "glb-lite", feature = "debug-tools"))]
pub(crate) fn export_model_phy_colliders(
    bsp: &vbsp::Bsp,
    pak: &PakfileModels,
) -> Result<String, JsValue> {
    let out = export_model_phy_colliders_data(bsp, pak)?;
    serde_json::to_string(&out).map_err(|e| to_js_err(e, "序列化模型 PHY 碰撞失败"))
}

/// 可视网格三角形碰撞提取（含置换面，与 JSON 出口同一份结果）。
#[cfg(any(feature = "glb-lite", feature = "debug-tools"))]
pub(crate) fn export_model_tri_colliders_data(
    bsp: &vbsp::Bsp,
    pak: &PakfileModels,
) -> Result<Vec<TriMeshData>, JsValue> {
    let models = &pak.models;
    let static_props = &pak.static_props;
    if models.is_empty() {
        return Ok(Vec::new());
    }

    let no_entities: Vec<model_integrator::Entity> = Vec::new();

    /// 累计三角形总护栏：达到上限后不再展开新的放置实例。
    const MAX_TRI_TOTAL: usize = 200_000;

    let mut out: Vec<TriMeshData> = Vec::new();
    let mut tri_total = 0usize;

    for m in models {
        if tri_total >= MAX_TRI_TOTAL {
            break;
        }

        let placements =
            model_integrator::resolve_placements(&m.name, &no_entities, static_props);
        let placements: Vec<_> = placements
            .into_iter()
            .filter(|p| p.solid != Some(0))
            .collect();
        if placements.is_empty() {
            continue;
        }

        let Some(model) = load_vmdl(m) else { continue };

        // ---- 局部空间顶点（Y-up，与 GLB 顶点同一变换链）----
        let skin = model.idle_skin_matrices();
        let src = model.vertices();
        let mut local: Vec<[f32; 3]> = Vec::with_capacity(src.len());
        for v in src {
            local.push(model_integrator::map_coords(
                model.skin_vertex_position(&skin, v),
            ));
        }
        if local.is_empty() {
            continue;
        }

        // ---- 展开三角：条带索引展平成三元组（逐 mesh 全收，不看材质透明度）----
        let mut tris: Vec<[u32; 3]> = Vec::new();
        for mesh in model.meshes() {
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
            out.push(TriMeshData {
                name: m.name.clone(),
                surfaceprop: None,
                vertices: verts,
                indices: tris.clone(),
                min,
                max,
            });
        }
    }


    // 置换面（displacement）：笔刷碰撞只覆盖平面凸包，而置换面把可见表面从基础笔刷平面推了
    // 出去 —— 只拿基础平面做碰撞，玩家撞到的是看不见的旧平面。Source 对置换面的做法就是按
    // 置换面自身的三角形烘碰撞；这里与渲染共用同一条细分+位移路径，并走本函数同一个出口
    // （`TriMesh[]`）⇒ 物理侧无需新增通道（auto 分支按「.phy 里没有的名字」回退，必被带上）。
    for i in 0..bsp.displacements.len() {
        let Some(disp) = bsp.displacement(i) else { continue };
        let mut verts: Vec<[f32; 3]> = Vec::new();
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for v in disp.triangulated_displaced_vertices() {
            let p = model_integrator::map_coords([v.x, v.y, v.z]);
            for k in 0..3 {
                if p[k] < min[k] { min[k] = p[k]; }
                if p[k] > max[k] { max[k] = p[k]; }
            }
            verts.push(p);
        }
        if verts.len() < 3 { continue; }
        let tri_count = (verts.len() / 3) as u32;
        out.push(TriMeshData {
            name: format!("__disp_{i}"),
            surfaceprop: None,
            vertices: verts,
            indices: (0..tri_count).map(|t| [t * 3, t * 3 + 1, t * 3 + 2]).collect(),
            min,
            max,
        });
    }
    Ok(out)
}

/// JSON 出口（对外字符串契约不变；字段顺序与旧 `TriMeshOut` 逐字一致）。
#[cfg(any(feature = "glb-lite", feature = "debug-tools"))]
pub(crate) fn export_model_tri_colliders(
    bsp: &vbsp::Bsp,
    pak: &PakfileModels,
) -> Result<String, JsValue> {
    let out = export_model_tri_colliders_data(bsp, pak)?;
    serde_json::to_string(&out).map_err(|e| to_js_err(e, "序列化模型三角形碰撞失败"))
}

#[cfg(any(feature = "glb-lite", feature = "debug-tools"))]
pub(crate) fn export_displacement_colliders(data: &[u8]) -> Result<String, JsValue> {
    let bsp = vbsp::Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;
    let mut out: Vec<[f32; 3]> = Vec::new();
    for i in 0..bsp.displacements.len() {
let Some(disp) = bsp.displacement(i) else {
    continue;
};
for v in disp.triangulated_displaced_vertices() {
    out.push(websurf_wasm_core::model_integrator::map_coords([v.x, v.y, v.z]));
}
    }
    serde_json::to_string(&out).map_err(|e| to_js_err(e, "序列化置换面碰撞失败"))
}
