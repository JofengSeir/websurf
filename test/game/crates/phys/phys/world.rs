//! 世界碰撞容器（Rust 移植自 @unsurf/cs-movement 的 Collision.ts / World.ts / brush-grid.ts / triangle-grid.ts）。
//!
//! 纯计算模块，无 wasm-bindgen 依赖。约定与 TS 版逐字一致：
//! - 平面法线朝外（内部 `dot(n,p) - dist <= 0`）；brush AABB 用于宽阶段；
//! - Minkowski 扩张：盒子 mins/maxs 使平面 dist 增加 planeOffset；
//! - 双空间索引（BrushGrid / TriangleGrid）：均匀网格 + epoch 去重 + 大对象兜底。
//!
//! 坐标：Y-up（Rust 导出层已旋转），与渲染一致。

// ---------------------------------------------------------------------------
// 基础类型
// ---------------------------------------------------------------------------

pub type V3 = [f64; 3];

/// 平面（法线朝外，dist = dot(normal, pointOnPlane)）。
#[derive(Clone, Copy, Debug)]
pub struct Plane {
    pub normal: V3,
    pub dist: f64,
}

/// 凸 brush（平面列表 + AABB 宽阶段边界）。
#[derive(Clone, Debug)]
pub struct Brush {
    pub planes: Vec<Plane>,
    pub min: V3,
    pub max: V3,
}

/// 梯子 brush（可攀爬面朝向，水平方向指向墙外）。
#[derive(Clone, Debug)]
#[allow(dead_code)] // min/max 供构造临时 Brush 使用（ladder_at），保持与 Brush 同构
pub struct LadderVolume {
    pub planes: Vec<Plane>,
    pub min: V3,
    pub max: V3,
    pub facing: V3,
}

/// 模型三角形碰撞网格（世界空间，与显示逐位一致）。
#[derive(Clone, Debug)]
#[allow(dead_code)] // min/max 为 tri JSON 契约字段（TriangleGrid 用 TriEntry 过滤）
pub struct TriMesh {
    pub vertices: Vec<V3>,
    pub indices: Vec<[u32; 3]>,
    pub min: V3,
    pub max: V3,
}

/// 扫掠盒追踪结果。
#[derive(Clone, Debug)]
pub struct TraceResult {
    /// 移动完成比例 0..1。
    pub fraction: f64,
    /// 终点位置（fraction < 1 时 = start + dir * fraction）。
    pub end_pos: V3,
    /// 命中平面法线（fraction == 1 时为 None）。
    pub normal: Option<V3>,
    /// 起点是否在实体内部。
    pub start_solid: bool,
    /// 全实体（无出口）。
    pub all_solid: bool,
}

impl TraceResult {
    pub fn new(end: V3) -> Self {
        TraceResult {
            fraction: 1.0,
            end_pos: end,
            normal: None,
            start_solid: false,
            all_solid: false,
        }
    }
}

// ---------------------------------------------------------------------------
// 向量辅助
// ---------------------------------------------------------------------------

#[inline]
fn dot(a: &V3, b: &V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn sub(a: &V3, b: &V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
fn cross(a: &V3, b: &V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

// ---------------------------------------------------------------------------
// 轴向 bevel（Quake QBSP 同款，P2 坡顶入坡幻影碰撞根治）
// ---------------------------------------------------------------------------
//
// 问题：brush 的凸棱（两面交线）在 Minkowski 扫掠下产生"过近似区"——扫掠盒在棱外
// 先于真实表面命中一个幻影面（如坡顶台缘：坡面扩张面与台竖直面扩张面在棱外组成
// 一个透明墙/角，玩家贴缘低空穿过时被拦截/吸附→两线分叉）。Quake Q1/Q2 生成的
// 地图在 BSP 编译期给每个凸棱补轴向 bevel 平面：平面过棱（不切实体、与两棱面不
// 平行），把过近似区切回真实棱附近——扫掠盒平滑滑过棱，而非撞上幻影。
//
// 构建期一次后处理（Brush 构造后、build_index 前），热路径零开销。
// 风险：bevel 命中会占 try_player_move 的 MAX_CLIP_PLANES(=8) 槽位——Quake 原版
// 上限 5 且 bevel 常态存在，正常无碍；回归重点看 V 形槽/夹缝场景（见回归脚本）。

/// 3x3 线性方程组求解（列主元消元；det 过小返回 None）。
fn solve3(m: [[f64; 3]; 3], rhs: [f64; 3]) -> Option<V3> {
    let mut a = m;
    let mut b = rhs;
    const PIVOT_MIN: f64 = 1e-9;
    for col in 0..3 {
        let mut piv = col;
        for row in col + 1..3 {
            if a[row][col].abs() > a[piv][col].abs() {
                piv = row;
            }
        }
        if a[piv][col].abs() < PIVOT_MIN {
            return None; // 平面两两平行/退化（两面以上共面）
        }
        a.swap(col, piv);
        b.swap(col, piv);
        for row in 0..3 {
            if row == col {
                continue;
            }
            let f = a[row][col] / a[col][col];
            for c in 0..3 {
                a[row][c] -= f * a[col][c];
            }
            b[row] -= f * b[col];
        }
    }
    Some([
        b[0] / a[0][0],
        b[1] / a[1][1],
        b[2] / a[2][2],
    ])
}

/// 凸多面体顶点：三分平面交点 + 全平面可行性 + 共点去重。
/// 顶点 σ 容差：BSP 平面来自 f32，解析交点满足其余平面的误差应 < 1e-2；
/// 0.25 同时兼容共点合并（真实顶点由 ≥3 面共享，同一角点会被多组三分命中）。
fn brush_vertices(planes: &[Plane]) -> Vec<V3> {
    const VERT_COINC_EPS: f64 = 0.25;
    let n = planes.len();
    // 注：平面数少（6~8 面），O(n³) 试凑可接受（构建期一次）。
    let mut out: Vec<V3> = Vec::new();
    for i in 0..n {
        for j in i + 1..n {
            for k in j + 1..n {
                let m = [
                    planes[i].normal,
                    planes[j].normal,
                    planes[k].normal,
                ];
                let rhs = [planes[i].dist, planes[j].dist, planes[k].dist];
                let Some(v) = solve3(m, rhs) else { continue };
                // 可行性：全部平面内侧（容差放宽到 DIST_EPSILON——真实顶点恰在面上，
                // 浮点误差只可能使交点略偏入实体，不会出界）
                let mut ok = true;
                for p in planes {
                    if dot(&p.normal, &v) - p.dist > DIST_EPSILON {
                        ok = false;
                        break;
                    }
                }
                if !ok {
                    continue;
                }
                let dup = out.iter().any(|w| {
                    (w[0] - v[0]).abs() < VERT_COINC_EPS
                        && (w[1] - v[1]).abs() < VERT_COINC_EPS
                        && (w[2] - v[2]).abs() < VERT_COINC_EPS
                });
                if !dup {
                    out.push(v);
                }
            }
        }
    }
    out
}

/// 顶点对共享的平面索引（两点都在同一平面上的平面；棱 = 恰好共享 2 个平面的顶点对）。
fn shared_planes(planes: &[Plane], a: &V3, b: &V3, on_eps: f64) -> Vec<usize> {
    let mut out = Vec::new();
    for (idx, p) in planes.iter().enumerate() {
        let da = (dot(&p.normal, a) - p.dist).abs();
        let db = (dot(&p.normal, b) - p.dist).abs();
        if da <= on_eps && db <= on_eps {
            out.push(idx);
        }
    }
    out
}

/// 为 brush 生成轴向 bevel 平面并追加到 planes（幂等：同一实例调用一次）。
///
/// 保留条件（三条件全满足才保留）：
/// 1. 平面过棱上任一点（取棱段中点），法线为 6 个轴向之一（±x/±y/±z）；
/// 2. 不切掉实体：brush 全部顶点仍在平面内侧（或共面）——
///    否则平面多出的半空间会吃掉真实实体体积；
/// 3. 平面方向与形成该棱的两面均不平行（否则 bevel 与该面重合/冗余）。
/// 过近似区：平面外侧 = 棱外 A∩B 半空间之外；满足 2 时该区域不含实体，
/// 只含扫掠过近似——bevel 命中即把该区域切回真实棱附近。
pub fn add_axial_bevels(brush: &mut Brush) {
    if brush.planes.len() < 3 {
        return;
    }
    let verts = brush_vertices(&brush.planes);
    if verts.len() < 4 {
        return; // 退化（不足以构成多面体）
    }
    const AXES: [V3; 6] = [
        [1.0, 0.0, 0.0],
        [-1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, -1.0, 0.0],
        [0.0, 0.0, 1.0],
        [0.0, 0.0, -1.0],
    ];
    /// 顶点"在面上"容差（棱共享检测；BSP f32 面 + 三分求解合入误差远小于此）。
    const ON_PLANE_EPS: f64 = 0.5;
    /// 平行判定：|dot| 超过此值视为平行（1 − 1e-3，轴向 vs 面法线非 0/±1 即不平行）。
    const PARALLEL_EPS: f64 = 1e-3;
    /// bevel 去重容差（同一平面经多条共线棱重复命中时只加一份）。
    const SAME_PLANE_EPS: f64 = 0.125;

    let mut bevels: Vec<Plane> = Vec::new();
    for i in 0..verts.len() {
        for j in i + 1..verts.len() {
            let shared = shared_planes(&brush.planes, &verts[i], &verts[j], ON_PLANE_EPS);
            if shared.len() != 2 {
                continue;
            }
            let na = &brush.planes[shared[0]].normal;
            let nb = &brush.planes[shared[1]].normal;
            let dir = cross(na, nb);
            if dot(&dir, &dir) < 1e-8 {
                continue; // 两棱面平行/共面，非真实棱
            }
            let p = [
                (verts[i][0] + verts[j][0]) * 0.5,
                (verts[i][1] + verts[j][1]) * 0.5,
                (verts[i][2] + verts[j][2]) * 0.5,
            ];
            for na_axis in AXES {
                let dist = dot(&na_axis, &p);
                // 条件2：全部顶点在平面内侧（dot <= dist，容差 DIST_EPSILON）
                let mut all_inside = true;
                for v in &verts {
                    if dot(&na_axis, v) - dist > DIST_EPSILON {
                        all_inside = false;
                        break;
                    }
                }
                if !all_inside {
                    continue;
                }
                // 条件3：与两个棱面均不平行
                if dot(&na_axis, na).abs() > 1.0 - PARALLEL_EPS
                    || dot(&na_axis, nb).abs() > 1.0 - PARALLEL_EPS
                {
                    continue;
                }
                // 去重：同轴向 + 近同 dist（共线棱重复命中同一平面）
                let dup = bevels.iter().any(|b| {
                    dot(&b.normal, &na_axis).abs() > 1.0 - PARALLEL_EPS
                        && (b.dist - dist).abs() < SAME_PLANE_EPS
                });
                if !dup {
                    bevels.push(Plane {
                        normal: na_axis,
                        dist,
                    });
                }
            }
        }
    }
    brush.planes.extend(bevels);
}

// ---------------------------------------------------------------------------
// Minkowski 扩张 + 平面裁剪
// ---------------------------------------------------------------------------

/// 盒子 mins/maxs 对平面 dist 的扩张量。
#[inline]
fn plane_offset(n: &V3, mins: &V3, maxs: &V3) -> f64 {
    (if n[0] > 0.0 { mins[0] } else { maxs[0] }) * n[0]
        + (if n[1] > 0.0 { mins[1] } else { maxs[1] }) * n[1]
        + (if n[2] > 0.0 { mins[2] } else { maxs[2] }) * n[2]
}

/// 浮点容差（与 Collision.config.ts 的 DIST_EPSILON 一致）。
const DIST_EPSILON: f64 = 0.03125;

/// 对一组平面做 Minkowski 扩张的扫掠盒裁剪（clipBoxToBrush / clipBoxToTriangle 核心循环）。
/// 约定：实体 = 各半空间交集 `dot(n, p) - dist <= 0`（法线朝外）。
fn clip_planes(
    planes: &[Plane],
    start: &V3,
    end: &V3,
    mins: &V3,
    maxs: &V3,
    result: &mut TraceResult,
) {
    let mut enter_frac = -1.0f64;
    let mut leave_frac = 1.0f64;
    let mut clip_plane: Option<&Plane> = None;
    let mut start_out = false;
    let mut get_out = false;

    for p in planes {
        let dist = p.dist - plane_offset(&p.normal, mins, maxs);
        let d1 = dot(&p.normal, start) - dist;
        let d2 = dot(&p.normal, end) - dist;

        if d2 > 0.0 {
            get_out = true;
        }
        if d1 > 0.0 {
            start_out = true;
        }
        // 起点在平面前且未明显接近则跳过。关键稳健性守卫：物体恰好停在 epsilon
        // 距离、速度与平面平行时，d2 会因浮点噪声比 d1 小几个 ulp。若不跳过，
        // 每次碰撞都会记为一个极小的"命中"——把物体钉住并重置 clip 平面列表。
        if d1 > 0.0 && (d2 >= DIST_EPSILON || d2 >= d1 || d1 - d2 < 1e-6) {
            return;
        }
        if d1 <= 0.0 && d2 <= 0.0 {
            continue;
        }

        if d1 > d2 {
            // 通过该平面进入凸体。
            let f = (d1 - DIST_EPSILON) / (d1 - d2);
            if f > enter_frac {
                enter_frac = f;
                clip_plane = Some(p);
            }
        } else {
            // 通过该平面离开凸体。
            let f = (d1 + DIST_EPSILON) / (d1 - d2);
            if f < leave_frac {
                leave_frac = f;
            }
        }
    }

    if !start_out {
        result.start_solid = true;
        if !get_out {
            result.all_solid = true;
        }
        return;
    }

    if enter_frac < leave_frac && enter_frac > -1.0 && enter_frac < result.fraction {
        result.fraction = if enter_frac < 0.0 { 0.0 } else { enter_frac };
        if let Some(cp) = clip_plane {
            result.normal = Some(cp.normal);
        }
    }
}

/// 扫掠盒 vs 单 brush。
fn clip_box_to_brush(
    brush: &Brush,
    start: &V3,
    end: &V3,
    mins: &V3,
    maxs: &V3,
    result: &mut TraceResult,
) {
    clip_planes(&brush.planes, start, end, mins, maxs, result);
}

/// 扫掠盒 vs 单个三角形（模型可视网格原样碰撞）。
///
/// 不做 brush 转化：把三角形面 + 三条边表示为 5 个平面（面 ± 法线 + 3 条边），
/// 经 Minkowski 扩张后走与 brush 相同的平面裁剪。双面碰撞，退化三角形跳过。
#[allow(clippy::too_many_arguments)]
fn clip_box_to_triangle(
    mesh: &TriMesh,
    a: u32,
    b: u32,
    c: u32,
    start: &V3,
    end: &V3,
    mins: &V3,
    maxs: &V3,
    result: &mut TraceResult,
) {
    let va = mesh.vertices[a as usize];
    let vb = mesh.vertices[b as usize];
    let vc = mesh.vertices[c as usize];

    let e1 = sub(&vb, &va);
    let e2 = sub(&vc, &va);
    let raw_n = cross(&e1, &e2);
    let n_len = (dot(&raw_n, &raw_n)).sqrt();
    if n_len < 1e-8 {
        return; // 退化三角形
    }
    let n = [raw_n[0] / n_len, raw_n[1] / n_len, raw_n[2] / n_len];
    let d = dot(&n, &va);

    // 质心（用于边平面方向校准）
    let centroid = [
        (va[0] + vb[0] + vc[0]) / 3.0,
        (va[1] + vb[1] + vc[1]) / 3.0,
        (va[2] + vb[2] + vc[2]) / 3.0,
    ];

    // 面平面：双面（±n，厚度 0；Minkowski 展开后自然分开）
    let mut planes = vec![
        Plane { normal: n, dist: d },
        Plane { normal: [-n[0], -n[1], -n[2]], dist: -d },
    ];

    // 三条边的侧平面：法线 = normalize(cross(edge, n))，经质心校准朝外
    let edges = [(&va, &vb), (&vb, &vc), (&vc, &va)];
    for (pa, pb) in edges {
        let e = sub(pb, pa);
        let raw = cross(&e, &n);
        let len = (dot(&raw, &raw)).sqrt();
        if len < 1e-8 {
            continue; // 与面法线平行的退化边
        }
        let mut en = [raw[0] / len, raw[1] / len, raw[2] / len];
        let mut ed = dot(&en, pa);
        // 质心必须在"内侧"（负侧）；否则翻转该边平面（顶点顺序无关）
        if dot(&en, &centroid) - ed > 0.0 {
            en = [-en[0], -en[1], -en[2]];
            ed = -ed;
        }
        planes.push(Plane { normal: en, dist: ed });
    }

    if planes.len() < 5 {
        return;
    }
    clip_planes(&planes, start, end, mins, maxs, result);
}

// ---------------------------------------------------------------------------
// 扫掠盒追踪（全量 / 索引候选）
// ---------------------------------------------------------------------------

/// 扫掠盒 vs 候选 brush 列表（traceBox）。
pub fn trace_box(
    start: &V3,
    end: &V3,
    mins: &V3,
    maxs: &V3,
    brushes: &[&Brush],
) -> TraceResult {
    let mut result = TraceResult::new(*end);

    let pad = 1.0;
    let s_min_x = start[0].min(end[0]) + mins[0] - pad;
    let s_min_y = start[1].min(end[1]) + mins[1] - pad;
    let s_min_z = start[2].min(end[2]) + mins[2] - pad;
    let s_max_x = start[0].max(end[0]) + maxs[0] + pad;
    let s_max_y = start[1].max(end[1]) + maxs[1] + pad;
    let s_max_z = start[2].max(end[2]) + maxs[2] + pad;

    for brush in brushes {
        if brush.min[0] > s_max_x
            || brush.max[0] < s_min_x
            || brush.min[1] > s_max_y
            || brush.max[1] < s_min_y
            || brush.min[2] > s_max_z
            || brush.max[2] < s_min_z
        {
            continue;
        }
        clip_box_to_brush(brush, start, end, mins, maxs, &mut result);
    }

    // startSolid 不钉住追踪（Quake 2 语义）；脱离重叠起点是移动者的职责
    if result.fraction < 1.0 {
        result.end_pos = [
            start[0] + (end[0] - start[0]) * result.fraction,
            start[1] + (end[1] - start[1]) * result.fraction,
            start[2] + (end[2] - start[2]) * result.fraction,
        ];
    }
    result
}

/// 扫掠盒 vs 空间索引候选三角形（模型碰撞；候选来自 TriangleGrid.query）。
pub fn trace_box_tri_entries(
    start: &V3,
    end: &V3,
    mins: &V3,
    maxs: &V3,
    entries: &[&TriEntry],
) -> TraceResult {
    let mut result = TraceResult::new(*end);

    let pad = 1.0;
    let s_min_x = start[0].min(end[0]) + mins[0] - pad;
    let s_min_y = start[1].min(end[1]) + mins[1] - pad;
    let s_min_z = start[2].min(end[2]) + mins[2] - pad;
    let s_max_x = start[0].max(end[0]) + maxs[0] + pad;
    let s_max_y = start[1].max(end[1]) + maxs[1] + pad;
    let s_max_z = start[2].max(end[2]) + maxs[2] + pad;

    for e in entries {
        if e.min_x > s_max_x
            || e.max_x < s_min_x
            || e.min_y > s_max_y
            || e.max_y < s_min_y
            || e.min_z > s_max_z
            || e.max_z < s_min_z
        {
            continue;
        }
        clip_box_to_triangle(
            &e.mesh, e.a, e.b, e.c, start, end, mins, maxs, &mut result,
        );
    }

    if result.fraction < 1.0 {
        result.end_pos = [
            start[0] + (end[0] - start[0]) * result.fraction,
            start[1] + (end[1] - start[1]) * result.fraction,
            start[2] + (end[2] - start[2]) * result.fraction,
        ];
    }
    result
}

/// `origin` 处的盒子是否与（凸）体相交。
/// planes 由调用方提供切片——调用方（如 ladder_at）无需构造带克隆的 Brush 中间体。
pub fn box_in_brush(origin: &V3, mins: &V3, maxs: &V3, planes: &[Plane]) -> bool {
    for p in planes {
        let dist = p.dist - plane_offset(&p.normal, mins, maxs);
        if dot(&p.normal, origin) - dist > 0.0 {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------
// 空间索引：均匀网格 + epoch 去重
// ---------------------------------------------------------------------------

/// 单个对象可覆盖的最大 cell 数（超过则按"大对象"处理，query 时始终参与）。
const BIG_CELL_LIMIT: i64 = 512;

/// 网格 cell 内 brush 索引。
struct GridCells<T> {
    cells: std::collections::HashMap<(i32, i32, i32), Vec<usize>>,
    big: Vec<usize>,
    visited: Vec<i64>,
    epoch: i64,
    _marker: std::marker::PhantomData<T>,
}

impl<T> GridCells<T> {
    fn new() -> Self {
        GridCells {
            cells: std::collections::HashMap::new(),
            big: Vec::new(),
            visited: Vec::new(),
            epoch: 0,
            _marker: std::marker::PhantomData,
        }
    }

    fn rebuild(&mut self, count: usize) {
        self.cells.clear();
        self.big.clear();
        self.visited = vec![0i64; count];
        self.epoch = 0;
    }

    /// 插入一个对象（跨 cell 超限 → big 列表）。
    /// 返回是否需要走 big 路径（调用方决定，避免重复计算 span）。
    fn insert(&mut self, key_span: i64, insert_fn: impl FnOnce(&mut std::collections::HashMap<(i32, i32, i32), Vec<usize>>)) {
        if key_span > BIG_CELL_LIMIT {
            return; // 大对象：不进 cell（query 时始终参与，见 big 列表）
        }
        insert_fn(&mut self.cells);
    }

    /// 标记一个大对象参与查询。
    fn push_big(&mut self, idx: usize) {
        self.big.push(idx);
    }

    /// 查询覆盖 cell 范围内的对象（超集，已按 epoch 去重——同一对象只 visit 一次，
    /// 调用方无需再次去重）。
    /// `cell_keys` 由调用方生成（避免闭包借用冲突）。
    ///
    /// 热路径（每物理 tick 数次查询）：用字段级借用拆分直读 `big`/`cells`，
    /// 不再 clone 大对象列表与命中 cell 的 Vec——避免每次查询的堆分配。
    fn query(&mut self, keys: impl Iterator<Item = (i32, i32, i32)>, visit: &mut impl FnMut(usize)) {
        self.epoch += 1;
        let epoch = self.epoch;
        let visited = &mut self.visited;
        // big 始终参与
        for &id in &self.big {
            if visited[id] != epoch {
                visited[id] = epoch;
                visit(id);
            }
        }
        for key in keys {
            if let Some(arr) = self.cells.get(&key) {
                for &id in arr {
                    if visited[id] != epoch {
                        visited[id] = epoch;
                        visit(id);
                    }
                }
            }
        }
    }
}

/// brush 空间索引（broadphase）。
pub struct BrushGrid {
    cell_size: f64,
    cells: GridCells<Brush>,
    /// 全部 brush（引用由 World 持有，构建时复制索引）。
    brushes: Vec<Brush>,
    /// 查询复用缓冲（避免每次 query_refs 新建 ids Vec——热路径零分配）。
    scratch: Vec<usize>,
}

impl BrushGrid {
    pub fn new() -> Self {
        BrushGrid {
            cell_size: 512.0,
            cells: GridCells::new(),
            brushes: Vec::new(),
            scratch: Vec::new(),
        }
    }

    pub fn build(&mut self, brushes: &[Brush], cell_size: f64) {
        self.brushes = brushes.to_vec();
        self.cell_size = cell_size;
        self.cells.rebuild(brushes.len());

        let inv = 1.0 / cell_size;
        for (i, b) in brushes.iter().enumerate() {
            let cx0 = (b.min[0] * inv).floor() as i32;
            let cx1 = (b.max[0] * inv).floor() as i32;
            let cy0 = (b.min[1] * inv).floor() as i32;
            let cy1 = (b.max[1] * inv).floor() as i32;
            let cz0 = (b.min[2] * inv).floor() as i32;
            let cz1 = (b.max[2] * inv).floor() as i32;
            let span = ((cx1 - cx0 + 1) as i64) * ((cy1 - cy0 + 1) as i64) * ((cz1 - cz0 + 1) as i64);
            if span > BIG_CELL_LIMIT {
                self.cells.push_big(i);
                continue;
            }
            self.cells.insert(span, |cells| {
                for cx in cx0..=cx1 {
                    for cy in cy0..=cy1 {
                        for cz in cz0..=cz1 {
                            cells.entry((cx, cy, cz)).or_default().push(i);
                        }
                    }
                }
            });
        }
    }

    /// 查询与 AABB 相交的所有 brush 索引（超集，已去重——GridCells.query 的 epoch 去重保证，
    /// 无需 contains 线性去重（原 O(n²)，大候选集下是每 tick 查询的主要开销））。
    fn query_indices(&mut self, min: &V3, max: &V3, out: &mut Vec<usize>) {
        out.clear();
        let inv = 1.0 / self.cell_size;
        let cx0 = (min[0] * inv).floor() as i32;
        let cx1 = (max[0] * inv).floor() as i32;
        let cy0 = (min[1] * inv).floor() as i32;
        let cy1 = (max[1] * inv).floor() as i32;
        let cz0 = (min[2] * inv).floor() as i32;
        let cz1 = (max[2] * inv).floor() as i32;

        let key_iter = (cx0..=cx1).flat_map(move |cx| {
            (cy0..=cy1).flat_map(move |cy| {
                (cz0..=cz1).map(move |cz| (cx, cy, cz))
            })
        });
        self.cells.query(key_iter, &mut |id: usize| out.push(id));
    }

    /// 查询 brush 引用（World.trace 用；复用 scratch 缓冲，无热路径分配）。
    fn query_refs<'a>(&'a mut self, min: &V3, max: &V3, out: &mut Vec<&'a Brush>) {
        // 先用 mem::take 把复用缓冲挪出 self（零成本），避免 query_indices(&mut self)
        // 与 &mut self.scratch 的双重可变借用冲突
        let mut scratch = std::mem::take(&mut self.scratch);
        self.query_indices(min, max, &mut scratch);
        for &id in &scratch {
            out.push(&self.brushes[id]);
        }
        self.scratch = scratch;
    }
}

/// 三角形空间索引条目。
#[derive(Clone)]
pub struct TriEntry {
    pub mesh: TriMesh,
    pub a: u32,
    pub b: u32,
    pub c: u32,
    pub min_x: f64,
    pub min_y: f64,
    pub min_z: f64,
    pub max_x: f64,
    pub max_y: f64,
    pub max_z: f64,
}

/// 三角形空间索引（模型碰撞 broadphase）。
pub struct TriangleGrid {
    cell_size: f64,
    cells: GridCells<TriEntry>,
    entries: Vec<TriEntry>,
}

impl TriangleGrid {
    pub fn new() -> Self {
        TriangleGrid {
            cell_size: 256.0,
            cells: GridCells::new(),
            entries: Vec::new(),
        }
    }

    pub fn build(&mut self, meshes: &[TriMesh], cell_size: f64) {
        self.cell_size = cell_size;
        self.entries.clear();
        let mut total = 0usize;
        for mesh in meshes {
            total += mesh.indices.len();
        }
        self.cells.rebuild(total);
        self.entries.reserve(total);

        let inv = 1.0 / cell_size;
        for mesh in meshes {
            let v = &mesh.vertices;
            for [a, b, c] in &mesh.indices {
                let va = v[*a as usize];
                let vb = v[*b as usize];
                let vc = v[*c as usize];
                let min_x = va[0].min(vb[0]).min(vc[0]);
                let max_x = va[0].max(vb[0]).max(vc[0]);
                let min_y = va[1].min(vb[1]).min(vc[1]);
                let max_y = va[1].max(vb[1]).max(vc[1]);
                let min_z = va[2].min(vb[2]).min(vc[2]);
                let max_z = va[2].max(vb[2]).max(vc[2]);
                let idx = self.entries.len();
                self.entries.push(TriEntry {
                    mesh: mesh.clone(),
                    a: *a,
                    b: *b,
                    c: *c,
                    min_x,
                    min_y,
                    min_z,
                    max_x,
                    max_y,
                    max_z,
                });

                let cx0 = (min_x * inv).floor() as i32;
                let cx1 = (max_x * inv).floor() as i32;
                let cy0 = (min_y * inv).floor() as i32;
                let cy1 = (max_y * inv).floor() as i32;
                let cz0 = (min_z * inv).floor() as i32;
                let cz1 = (max_z * inv).floor() as i32;
                let span = ((cx1 - cx0 + 1) as i64) * ((cy1 - cy0 + 1) as i64) * ((cz1 - cz0 + 1) as i64);
                if span > BIG_CELL_LIMIT {
                    self.cells.push_big(idx);
                    continue;
                }
                self.cells.insert(span, |cells| {
                    for cx in cx0..=cx1 {
                        for cy in cy0..=cy1 {
                            for cz in cz0..=cz1 {
                                cells.entry((cx, cy, cz)).or_default().push(idx);
                            }
                        }
                    }
                });
            }
        }
    }

    /// 查询候选三角形条目（超集，已去重）。
    fn query_entries(&mut self, min: &V3, max: &V3, out: &mut Vec<usize>) {
        out.clear();
        let inv = 1.0 / self.cell_size;
        let cx0 = (min[0] * inv).floor() as i32;
        let cx1 = (max[0] * inv).floor() as i32;
        let cy0 = (min[1] * inv).floor() as i32;
        let cy1 = (max[1] * inv).floor() as i32;
        let cz0 = (min[2] * inv).floor() as i32;
        let cz1 = (max[2] * inv).floor() as i32;

        let key_iter = (cx0..=cx1).flat_map(move |cx| {
            (cy0..=cy1).flat_map(move |cy| {
                (cz0..=cz1).map(move |cz| (cx, cy, cz))
            })
        });
        let mut visit = |id: usize| {
            if !out.contains(&id) {
                out.push(id);
            }
        };
        self.cells.query(key_iter, &mut visit);
    }

    fn query_refs<'a>(&'a mut self, min: &V3, max: &V3, out: &mut Vec<&'a TriEntry>) {
        let mut ids: Vec<usize> = Vec::new();
        self.query_entries(min, max, &mut ids);
        for id in ids {
            out.push(&self.entries[id]);
        }
    }
}

// ---------------------------------------------------------------------------
// World（顶层容器）
// ---------------------------------------------------------------------------

pub struct World {
    pub solids: Vec<Brush>,
    pub ladders: Vec<LadderVolume>,
    pub tri_meshes: Vec<TriMesh>,
    grid: BrushGrid,
    tri_grid: TriangleGrid,
}

impl World {
    pub fn new() -> Self {
        World {
            solids: Vec::new(),
            ladders: Vec::new(),
            tri_meshes: Vec::new(),
            grid: BrushGrid::new(),
            tri_grid: TriangleGrid::new(),
        }
    }

    /// 构建空间索引（solids/tri_meshes 赋值后调用）。
    pub fn build_index(&mut self) {
        self.grid.build(&self.solids, 512.0);
        if !self.tri_meshes.is_empty() {
            self.tri_grid.build(&self.tri_meshes, 256.0);
        }
    }

    pub fn trace(&mut self, start: &V3, end: &V3, mins: &V3, maxs: &V3) -> TraceResult {
        let pad = 1.0;
        let s_min = [
            start[0].min(end[0]) + mins[0] - pad,
            start[1].min(end[1]) + mins[1] - pad,
            start[2].min(end[2]) + mins[2] - pad,
        ];
        let s_max = [
            start[0].max(end[0]) + maxs[0] + pad,
            start[1].max(end[1]) + maxs[1] + pad,
            start[2].max(end[2]) + maxs[2] + pad,
        ];

        // brush 候选
        let mut candidates: Vec<&Brush> = Vec::new();
        self.grid.query_refs(&s_min, &s_max, &mut candidates);
        let brush_result = trace_box(start, end, mins, maxs, &candidates[..]);

        // 模型三角形碰撞：候选 + clip，取更早命中者
        if !self.tri_meshes.is_empty() {
            let mut tri_candidates: Vec<&TriEntry> = Vec::new();
            self.tri_grid.query_refs(&s_min, &s_max, &mut tri_candidates);
            let tri_result = trace_box_tri_entries(start, end, mins, maxs, &tri_candidates[..]);
            if tri_result.fraction < brush_result.fraction {
                return tri_result;
            }
        }
        brush_result
    }

    /// mins/maxs 碰撞箱在 origin 处能否不与世界相交。
    pub fn is_position_free(&mut self, origin: &V3, mins: &V3, maxs: &V3) -> bool {
        let q_min = [
            origin[0] + mins[0] - 1.0,
            origin[1] + mins[1] - 1.0,
            origin[2] + mins[2] - 1.0,
        ];
        let q_max = [
            origin[0] + maxs[0] + 1.0,
            origin[1] + maxs[1] + 1.0,
            origin[2] + maxs[2] + 1.0,
        ];

        let mut candidates: Vec<&Brush> = Vec::new();
        self.grid.query_refs(&q_min, &q_max, &mut candidates);
        let tr = trace_box(origin, origin, mins, maxs, &candidates[..]);
        if tr.start_solid {
            return false;
        }
        if !self.tri_meshes.is_empty() {
            let mut tri_candidates: Vec<&TriEntry> = Vec::new();
            self.tri_grid.query_refs(&q_min, &q_max, &mut tri_candidates);
            let tri_tr = trace_box_tri_entries(origin, origin, mins, maxs, &tri_candidates[..]);
            if tri_tr.start_solid {
                return false;
            }
        }
        true
    }

    /// 玩家碰撞箱是否与某个梯子相交（返回该梯子索引——避免返回引用导致每 tick 克隆）。
    pub fn ladder_at(&self, origin: &V3, mins: &V3, maxs: &V3) -> Option<usize> {
        for (i, ladder) in self.ladders.iter().enumerate() {
            if box_in_brush(origin, mins, maxs, &ladder.planes) {
                return Some(i);
            }
        }
        None
    }
}
