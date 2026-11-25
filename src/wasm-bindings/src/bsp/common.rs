// common: task-73 slice2 生成（源=三端 lib.rs 按 body 指纹分组），请勿手改。

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

// ---------------- export_brushes_planes 共享实现（debug / game） ----------------
//
// 此前 `debug_tools.rs` 与 `glb.rs` 各有一份逐行拷贝：debug 那份输出 `entity` /
// `start_solid` 与平面诊断键，game 那份漏掉前两个字段。下游 `src/phys/mod.rs` 的
// `parse_brushes` 对缺失字段静默填 `entity = -1` / `start_solid = true`，于是 game 里
// 所有实体 brush（func_door / func_wall_toggle / func_movelinear / 实体梯子）在物理层都被
// 当成不可切换、不可移动的静态 worldspawn（渲染动了，碰撞箱还在原地）。
//
// 现在只保留这一份实现：两端的 `WasmBrush` **无条件**输出 `entity` 与 `start_solid`；
// 平面上的 `is_real_face` / `is_bevel` 只给 debug 侧显示用，game 端不输出
// （`skip_serializing_if`），保持 game 的 JSON 不多出无用调试字段。

/// `export_brushes_planes_impl` 的行为开关：两端历史上只有这两处不同。
pub(crate) struct BrushPlanesOpts {
    /// 平面是否额外输出 `is_real_face` / `is_bevel` 两个 debug 诊断键。
    pub debug_plane_flags: bool,
    /// 控制台统计是否带九分支自证（game 端）；debug 端只打 total/exported/skipped。
    pub detailed_skip_log: bool,
}

/// brush 平面输出项；`is_real_face` / `is_bevel` 为 `None` 时整键不序列化。
#[derive(serde::Serialize)]
struct WasmBrushPlane {
    normal: [f32; 3],
    dist: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_real_face: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_bevel: Option<bool>,
}

/// 单块 brush 的碰撞体描述。字段顺序即 JSON 键顺序。
#[derive(serde::Serialize)]
struct WasmBrush {
    planes: Vec<WasmBrushPlane>,
    min: [f32; 3],
    max: [f32; 3],
    is_ladder: bool,
    is_solid: bool,
    /// 所属实体下标（`-1` = worldspawn / 无实体归属）。运行期碰撞开关按这个下标定位。
    entity: i32,
    /// 出生时是否实心。`false`（实体层出生即关，如 `func_wall_toggle` START_OFF）时
    /// 物理世界建好后该 brush 不参与碰撞，运行期由实体 I/O 开关切回。
    start_solid: bool,
}

/// 顶点"落在某平面上"的判定容差（HU）。凸包顶点由 `plane_intersect` 从三元组交点直接
/// 产出，落在其定义平面上时残差是浮点级；0.1 HU 足够宽以稳定收集，又足够窄以不把
/// 邻近平面的顶点误收进来。
const ON_PLANE_EPS: f32 = 0.1;
/// 面最小宽度（HU）：面上顶点到直径连线的最大垂距低于此值即判退化（顶点全共线）。
/// 偏保守是刻意的——判成"非面"的后果只是不显示，判成"面"的后果是显示一张假面。
const MIN_FACE_WIDTH: f32 = 0.5;

/// 该平面在 `verts` 上是否构成一张有面积的真实面。
///
/// 判据两条，都要满足才算真面：
/// 1. 落在平面上的顶点 ≥ 3（容差 [`ON_PLANE_EPS`]）；
/// 2. 这些顶点**不共线**：取直径最远的一对作基线，其余点到该基线的垂距最大值
///    ≥ [`MIN_FACE_WIDTH`]。
///
/// ⚠️ **不能用 Newell 多边形面积**：它要求顶点按边界环序排列，而这里的 `on` 是按
/// `compute_vertices` 的枚举顺序收集的（它按平面三元组下标遍历产出，不是环序）⇒
/// 叉积互相抵消、面积恒算成 0。实测 `surf_666` 的五棱柱 brush 有 5 张真实面被这样
/// 误判成"非面"。直径 + 垂距是**与顶点顺序无关**的判据。
fn plane_is_real_face(plane: &vbsp::Plane, verts: &[[f32; 3]]) -> bool {
    if verts.len() < 3 {
        return false;
    }
    let n = &plane.normal;
    let mut on: Vec<[f32; 3]> = Vec::new();
    for v in verts {
        let d = n.x * v[0] + n.y * v[1] + n.z * v[2] - plane.dist;
        if d.abs() < ON_PLANE_EPS {
            on.push([v[0], v[1], v[2]]);
        }
    }
    if on.len() < 3 {
        return false;
    }
    let mut ai = 0usize;
    let mut bi = 1usize;
    let mut best = -1.0f32;
    for x in 0..on.len() {
        for y in (x + 1)..on.len() {
            let dx = on[x][0] - on[y][0];
            let dy = on[x][1] - on[y][1];
            let dz = on[x][2] - on[y][2];
            let d = (dx * dx + dy * dy + dz * dz).sqrt();
            if d > best {
                best = d;
                ai = x;
                bi = y;
            }
        }
    }
    if best < MIN_FACE_WIDTH {
        return false;
    }
    let a = on[ai];
    let b = on[bi];
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let mut width = 0.0f32;
    for (i, p) in on.iter().enumerate() {
        if i == ai || i == bi {
            continue;
        }
        let ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
        let cx = ab[1] * ap[2] - ab[2] * ap[1];
        let cy = ab[2] * ap[0] - ab[0] * ap[2];
        let cz = ab[0] * ap[1] - ab[1] * ap[0];
        width = width.max((cx * cx + cy * cy + cz * cz).sqrt() / best);
    }
    width >= MIN_FACE_WIDTH
}

/// 三平面求交（Cramer 法则）— 用于计算 brush AABB。
fn plane_intersect(p1: &vbsp::Plane, p2: &vbsp::Plane, p3: &vbsp::Plane) -> Option<[f32; 3]> {
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

/// 计算 brush 顶点（半空间交集），用于 AABB — 空间哈希去重。
fn compute_vertices(planes: &[&vbsp::Plane]) -> Vec<[f32; 3]> {
    let mut verts: Vec<[f32; 3]> = Vec::new();
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
                    // 验证 v 在所有平面的正侧
                    let mut valid = true;
                    for p in planes {
                        let d = p.normal.x * v[0] + p.normal.y * v[1] + p.normal.z * v[2] - p.dist;
                        if d < -1.0 {
                            valid = false;
                            break;
                        }
                    }
                    if !valid {
                        continue;
                    }
                    // 空间哈希去重（距离 < 0.1 HU 视为同一点）
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

/// 坐标旋转 `[x,y,z]→[y,z,x]`（det=+1，正交变换，BSP Z-up → Three.js Y-up）。
fn rotate_yup(v: &vbsp::Vector) -> [f32; 3] {
    [v.y, v.z, v.x]
}

/// 导出 BSP brush 的凸包碰撞体（`WasmBrush[]` JSON）。
///
/// 两端 `#[wasm_bindgen]` 方法体只做「取 bsp + 报错文案 + 委托」，导出签名留在各自文件。
pub(crate) fn export_brushes_planes_impl(
    bsp: &vbsp::Bsp,
    filter_json: &str,
    opts: BrushPlanesOpts,
) -> Result<String, JsValue> {
    use vbsp::{BrushFlags, Plane};

    // 文本解析失败一律退回默认过滤（与两端原行为一致）。
    let filter: ColliderFilter = serde_json::from_str(filter_json).unwrap_or_default();

    const MAX_BRUSHES: usize = 8000; // 性能保护：上限
    let sky_flags = vbsp::TextureFlags::SKY | vbsp::TextureFlags::SKY2D;
    let mut brushes_out: Vec<WasmBrush> = Vec::new();
    let mut skipped = 0;
    // 跳过计数的**分支分解**：单一 `skipped` 计数器无法自证，故逐分支计数并保证
    // 「九个具名分支之和 == skipped」。九个分支依次是：
    //   非玩家固体（既非 SOLID 族亦非 LADDER，或所属实体被判定为无碰撞）、SKY、
    //   ladder 被排除、solid 被排除、nodraw、平面数 < 4、顶点数 < 4、
    //   体积不足、达到 MAX_BRUSHES 的早退。
    let mut skipped_non_player_solid = 0usize;
    let mut skipped_sky = 0usize;
    let mut skipped_planes_lt4 = 0usize;
    let mut skipped_ladder_excluded = 0usize;
    let mut skipped_solid_excluded = 0usize;
    let mut skipped_nodraw = 0usize;
    let mut skipped_verts_lt4 = 0usize;
    let mut skipped_volume = 0usize;
    let mut skipped_early_exit = 0usize;
    /// 单分支跳过计数：`skipped` 与具名分支**同时**自增，避免两处手写不一致。
    macro_rules! skip_branch {
        ($branch:ident) => {{
            skipped += 1;
            $branch += 1;
            continue;
        }};
    }
    // brush → 模型 world origin 映射（实体 brush 的平面是局部坐标，需平移到世界坐标）
    let brush_model_origins = build_brush_model_origins(bsp);
    // 无碰撞实体（trigger_* / func_illusionary 等）的 brush 不导出为碰撞体，
    // 否则玩家会在触发区域撞到不可见的空气墙。
    let brush_models = brush_model_indices(bsp);
    let model_classes = model_classnames(bsp);
    // 运行期碰撞开关：brush → 所属实体下标（-1=worldspawn），实体 → 出生时是否实心。
    // 初始关的实体 brush（func_wall_toggle START_OFF / func_brush StartDisabled）
    // 导出 `start_solid=false`，物理侧建世界后这些碰撞体不参与查询。
    let brush_entities = brush_entity_indices(bsp);
    let entity_solid = entity_start_solid(bsp);

    for (brush_idx, brush) in bsp.brushes.iter().enumerate() {
        if brushes_out.len() >= MAX_BRUSHES {
            // 达到 MAX_BRUSHES 上限：剩余 brush 全部计入早退分支，保证 total == exported + Σ分支
            skipped_early_exit = bsp.brushes.len() - brush_idx;
            break;
        }
        // 玩家固体掩码（MASK_PLAYERSOLID 同义）：SOLID|WINDOW|GRATE|PLAYERCLIP|MOVEABLE
        let player_solid_mask = BrushFlags::SOLID
            | BrushFlags::WINDOW
            | BrushFlags::GRATE
            | BrushFlags::PLAYERCLIP
            | BrushFlags::MOVEABLE;
        let is_solid = brush.flags.intersects(player_solid_mask);
        let is_ladder = brush.flags.contains(BrushFlags::LADDER);
        if !is_solid && !is_ladder {
            skip_branch!(skipped_non_player_solid);
        }
        // 无碰撞实体 brush 过滤：trigger_* / func_illusionary 等不产生碰撞体
        if let Some(mi) = brush_models.get(brush_idx).copied().flatten() {
            if let Some(cls) = model_classes.get(mi).and_then(|c| c.as_deref()) {
                if entity_is_non_solid(cls) {
                    skip_branch!(skipped_non_player_solid);
                }
            }
        }
        if !filter.include_ladder && is_ladder {
            skip_branch!(skipped_ladder_excluded);
        }
        if !filter.include_solid && is_solid {
            skip_branch!(skipped_solid_excluded);
        }

        // 单次遍历 brush_sides：收集平面引用、bevel 旗标与 sky/nodraw 标志；
        // 逐项用 `.get()` 取值，越界即跳过（不在导出路径里 panic）。
        let mut bsp_planes: Vec<&Plane> = Vec::new();
        let mut bsp_bevels: Vec<bool> = Vec::new();
        let mut is_sky = false;
        let mut is_nodraw = false;
        let start = brush.brush_side as usize;
        let count = brush.num_brush_sides as usize;
        for i in 0..count {
            let Some(side) = bsp.brush_sides.get(start + i) else {
                continue;
            };
            // BSP 原生 bevel side（`side.bevel != 0`）照常进平面表。
            if let Some(plane) = bsp.planes.get(side.plane as usize) {
                bsp_planes.push(plane);
                bsp_bevels.push(side.bevel != 0);
            }
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

        if filter.skip_sky && is_sky {
            skip_branch!(skipped_sky);
        }
        if filter.skip_nodraw && is_nodraw {
            skip_branch!(skipped_nodraw);
        }
        if bsp_planes.len() < 4 {
            skip_branch!(skipped_planes_lt4);
        }

        // 实体模型 brush 的平面是局部坐标（相对模型 origin）：按 origin 平移 `dist` 到世界坐标，
        // 否则这些碰撞体全部堆在模型原点。
        let origin = brush_model_origins[brush_idx];
        let has_origin = origin[0] != 0.0 || origin[1] != 0.0 || origin[2] != 0.0;
        let owned_planes: Vec<Plane> = if has_origin {
            bsp_planes
                .iter()
                .map(|p| Plane {
                    normal: vbsp::Vector {
                        x: p.normal.x,
                        y: p.normal.y,
                        z: p.normal.z,
                    },
                    dist: p.dist + p.normal.x * origin[0] + p.normal.y * origin[1] + p.normal.z * origin[2],
                    ty: p.ty,
                })
                .collect()
        } else {
            Vec::new()
        };
        let bsp_plane_refs: Vec<&Plane> = if has_origin {
            owned_planes.iter().collect()
        } else {
            // 浅克隆引用（Vec<&Plane>），后续 planes_yup 仍需借用 bsp_planes
            bsp_planes.clone()
        };
        // 与 bsp_plane_refs 逐位对齐的 bevel 旗标（origin 平移不改顺序）
        let plane_bevels: Vec<bool> = bsp_bevels;

        // 计算 BSP 坐标顶点（用于 AABB）
        let mut verts_bsp = compute_vertices(&bsp_plane_refs);

        // 回退：顶点数 < 4 时把全部平面法线与 `dist` 取负再算一次
        // （部分编辑器生成的 brush 法线朝内）
        let flipped_planes: Vec<Plane> = if verts_bsp.len() < 4 {
            bsp_plane_refs
                .iter()
                .map(|p| Plane {
                    normal: vbsp::Vector {
                        x: -p.normal.x,
                        y: -p.normal.y,
                        z: -p.normal.z,
                    },
                    dist: -p.dist,
                    ty: p.ty,
                })
                .collect()
        } else {
            Vec::new()
        };
        if verts_bsp.len() < 4 && !flipped_planes.is_empty() {
            let flipped_refs: Vec<&Plane> = flipped_planes.iter().collect();
            verts_bsp = compute_vertices(&flipped_refs);
        }
        if verts_bsp.len() < 4 {
            skip_branch!(skipped_verts_lt4);
        }

        // 体积过滤（基于 AABB 体积估算）
        if filter.min_brush_volume > 0.0 {
            let vol = aabb_volume(&verts_bsp);
            if vol < filter.min_brush_volume {
                skip_branch!(skipped_volume);
            }
        }

        // 旋转顶点到 Y-up 并计算 AABB
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for v in &verts_bsp {
            let ry = [v[1], v[2], v[0]]; // [x,y,z]→[y,z,x]
            for i in 0..3 {
                if ry[i] < min[i] {
                    min[i] = ry[i];
                }
                if ry[i] > max[i] {
                    max[i] = ry[i];
                }
            }
        }

        // 合并平面表（真实面 + BSP 原生 bevel side；flipped 法线翻转不改旗标）
        let mut all_planes_src: Vec<(Plane, bool)> = Vec::new();
        if !flipped_planes.is_empty() {
            all_planes_src.extend(
                flipped_planes
                    .iter()
                    .cloned()
                    .zip(plane_bevels.iter().copied()),
            );
        } else {
            for (p, bevel) in bsp_plane_refs.iter().zip(plane_bevels.iter().copied()) {
                all_planes_src.push((
                    Plane {
                        normal: p.normal.clone(),
                        dist: p.dist,
                        ty: p.ty,
                    },
                    bevel,
                ));
            }
        }
        // 旋转平面法线到 Y-up，并翻转法线方向（vbsp 内部约定 → 扫掠侧约定）。
        //
        // **法线方向**：`vbsp` 读出的平面是「法线朝内」约定（内部点 `dot(n,p)-dist >= 0`，
        // `compute_vertices` 的 `d < -1.0` 检查与此一致）；扫掠侧要「法线朝外」
        // （`src/phys/world.rs` 的 `Brush`：内部 = `dot(normal, p) - dist <= 0`）。
        // 故对每个平面取负 `normal` 与 `dist`：`dot(-n,p)-(-dist) = -(dot(n,p)-dist)`，
        // 内部点由 d >= 0 变成 d <= 0，半空间等价翻转；先旋转到 Y-up 再取负，二者可交换。
        let planes_yup: Vec<WasmBrushPlane> = all_planes_src
            .iter()
            .map(|(p, is_bevel)| {
                let r = rotate_yup(&p.normal);
                WasmBrushPlane {
                    normal: [-r[0], -r[1], -r[2]],
                    dist: -p.dist,
                    // `is_real_face` 的几何判据在 BSP 坐标下算，与 Y-up 无关（同一批顶点）。
                    is_real_face: opts
                        .debug_plane_flags
                        .then(|| plane_is_real_face(p, &verts_bsp)),
                    is_bevel: opts.debug_plane_flags.then_some(*is_bevel),
                }
            })
            .collect();

        let entity = brush_entities.get(brush_idx).copied().unwrap_or(-1);
        brushes_out.push(WasmBrush {
            planes: planes_yup,
            min,
            max,
            is_ladder,
            is_solid,
            // -1 = worldspawn/无实体归属；越界同样按无归属处理。
            entity,
            // 实体层出生即关（如 func_wall_toggle START_OFF）⇒ 初始不参与碰撞。
            // 无实体归属（worldspawn）恒实心。
            start_solid: if entity >= 0 {
                entity_solid.get(entity as usize).copied().unwrap_or(true)
            } else {
                true
            },
        });
    }

    if opts.detailed_skip_log {
        let breakdown_sum = skipped_sky
            + skipped_non_player_solid
            + skipped_planes_lt4
            + skipped_ladder_excluded
            + skipped_solid_excluded
            + skipped_nodraw
            + skipped_verts_lt4
            + skipped_volume
            + skipped_early_exit;
        web_sys::console::log_1(
            &format!(
                "[BrushPlanes] total={}, exported={}, skipped={}, sky={}, nonPlayerSolid={}, \
                 planesLt4={}, ladderExcluded={}, solidExcluded={}, nodraw={}, vertsLt4={}, \
                 volume={}, earlyExit={}, breakdownSum={}, cover={}",
                bsp.brushes.len(),
                brushes_out.len(),
                skipped,
                skipped_sky,
                skipped_non_player_solid,
                skipped_planes_lt4,
                skipped_ladder_excluded,
                skipped_solid_excluded,
                skipped_nodraw,
                skipped_verts_lt4,
                skipped_volume,
                skipped_early_exit,
                breakdown_sum,
                if breakdown_sum == skipped && brushes_out.len() + skipped == bsp.brushes.len() {
                    "ok"
                } else {
                    "MISMATCH"
                }
            )
            .into(),
        );
    } else {
        web_sys::console::log_1(
            &format!(
                "[BrushPlanes] total={}, exported={}, skipped={}",
                bsp.brushes.len(),
                brushes_out.len(),
                skipped
            )
            .into(),
        );
    }

    // 输出纯 WasmBrush[] JSON 数组
    serde_json::to_string(&brushes_out).map_err(|e| to_js_err(e, "序列化 brush 平面数据失败"))
}
