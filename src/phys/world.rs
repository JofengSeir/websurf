//! 世界碰撞容器：凸 brush / 三角网格的扫掠盒裁剪，外加两套均匀网格 broadphase。
//!
//! 本文件是 crate 内的纯计算层：不含 wasm-bindgen、serde、js_sys 引用，只被同 crate
//! 的 `player`、`mod` 与测试模块调用；它是 `@unsurf/cs-movement` 的改写产物
//! （许可与来源见 `src/phys/NOTICE`、`src/phys/LICENSE`）。
//!
//! 上下游位置：
//! - 上游（建世界）：`src/phys/mod.rs` 的 `PhysWorld::build_world` 把 JSON 解析出的
//!   brush 按 `is_ladder` / `is_solid` 分流进 `World::ladders` / `World::solids`、
//!   把三角网格装进 `World::tri_meshes`，随后一次性调 `World::build_index`
//!   建索引。
//! - 下游（消费）：`player::player_tick` 用 `World::trace` 做移动裁剪、台阶、贴地
//!   与落地判定，用 `World::is_position_free` 做空中起立与卡死挤出，用
//!   `World::ladder_at` 判抓梯；`src/phys/mod.rs` 的 `PhysWorld::debug_trace`
//!   把一次 `World::trace` 直接暴露给诊断脚本。
//!
//! 三份数据 ↔ 两套索引（`World::build_index` 一次建齐）：
//! - `solids` → `BrushGrid`（cell 512）；`tri_meshes` → `TriangleGrid`（cell 256，
//!   且仅在 `tri_meshes` 非空时构建）；**`ladders` 不进任何索引**，
//!   `World::ladder_at` 对它线性扫描。
//! - `BrushGrid::build` 用 `to_vec` 把 brush **按值复制**进网格，`TriangleGrid::build`
//!   对每个网格深克隆一次、网格内按 `Rc` 共享。因此 `build_index` 之后再改
//!   `World::solids` / `World::tri_meshes`，索引仍是旧副本，必须重建才生效。
//!
//! 关键约定（全部由本文件代码固定）：
//! - 平面法线**朝外**，实体 = 各半空间交集 `dot(n, p) - dist <= 0`；
//! - Minkowski 扩张：盒 `mins` / `maxs` 把平面 `dist` 抬高 `plane_offset`，故裁剪出的
//!   进入点带 `DIST_EPSILON`（0.03125）的悬停间隙；点判（`box_in_brush`）用同一扩张；
//! - 盒-AABB 必要校验（`aabb_overlaps_at`）的容差是函数内局部常量
//!   `DIST_EPSILON / 8.0`（0.00390625，**不在模块作用域**）：无限平面造成的假进入
//!   只跳过该条平面，保留同一实体更晚的真实接触，不做整实体否决；
//! - 网格查询给出的是**超集**（AABB 相交即候选），是否真的命中由 `clip_planes` 决定；
//! - 大对象兜底：跨度超 `BIG_CELL_LIMIT`（512 个 cell）的对象进 `big` 列表，
//!   每次查询无条件参与。
//!
//! 边界：不做 BSP 解析、不生成网格、不移动玩家、不碰渲染；`start_solid` 不钉住追踪
//! （起点实心时该实体的裁剪整段返回，`fraction` 不因此变小），脱离重叠起点由移动方
//! 负责；本模块不持有全局可变状态，唯一例外是诊断计数器 `GATE_VETO_COUNT`
//! （只增不减、无复位入口，同模块内所有实例共享一份）。
//!
//! 测试归属：`p2_gate_tests`（4 项）直接构造 60° 坡面 brush 调 `trace_box`；
//! `duck_surf_tests`（6 项）经 `World::new` + `World::build_index` 后驱动 `player_tick`。
//! 本文件自身无 `#[test]`。

// ---------------------------------------------------------------------------
// 基础类型
// ---------------------------------------------------------------------------

/// 三维向量 / 点 `[x, y, z]`：Y-up，单位与 brush / tri 的 JSON 数据一致
/// （本文件不做坐标变换，也不区分"位置"与"位移"——含义由调用方决定）。
pub type V3 = [f64; 3];

/// 凸体的一个面：`normal` 为单位外法线，`dist = dot(normal, pointOnPlane)`。
/// 实体内部 = `dot(normal, p) - dist <= 0`。**判号约定唯一**：本文件各处都用 `> 0`
/// 表示"在体外"（`clip_planes` 的 `d1` / `d2`、`box_in_brush` 的同一式子），
/// 平面集里混入朝内法线即把该凸体判成补集。
#[derive(Clone, Copy, Debug)]
pub struct Plane {
    pub normal: V3,
    pub dist: f64,
}

/// 凸 brush：`planes` 为朝外平面集，`min` / `max` 是同一凸体的 AABB。
/// AABB 有两处用途 —— 宽阶段（`trace_box`、`BrushGrid`）与"命中处盒-AABB 必要校验"
/// （`aabb_overlaps_at`）；它不参与精确裁剪，但必须包住平面集，否则真实接触会被必要
/// 校验判成假进入而丢弃。
#[derive(Clone, Debug)]
pub struct Brush {
    pub planes: Vec<Plane>,
    pub min: V3,
    pub max: V3,
}

/// 梯子 brush：几何与 `Brush` 同构（`planes` 朝外 + AABB），额外带一个可攀爬面朝向
/// `facing`（由 `compute_ladder_facing` 从平面集求得，y 恒为 0）。
/// `World::ladder_at` 只用 `planes` 判相交。
#[derive(Clone, Debug)]
#[allow(dead_code)] // min/max 供构造临时 Brush 使用（ladder_at），保持与 Brush 同构
pub struct LadderVolume {
    pub planes: Vec<Plane>,
    /// AABB 下界：当前代码内无读取方（判定只用 `planes`），保留以与 brush 数据同构。
    pub min: V3,
    /// AABB 上界：同 `min`，当前代码内无读取方。
    pub max: V3,
    /// 攀爬面朝向（水平分量已归一化、y 恒为 0）：`player::check_ladder` 用它判"是否面朝
    /// 梯子"，`player::ladder_move` 用它在跳离时给三轴速度。
    pub facing: V3,
}

/// 模型三角形碰撞网格：`vertices` 是世界空间顶点，`indices` 是三元组下标。
/// 顶点与索引按 JSON 原样收下，本文件不重采样、不做坐标变换、不合并三角形。
#[derive(Clone, Debug)]
#[allow(dead_code)] // min/max 为 tri JSON 契约字段（TriangleGrid 用 TriEntry 过滤）
pub struct TriMesh {
    /// 顶点表（Y-up、HU）。
    pub vertices: Vec<V3>,
    /// 三角形顶点下标（相对 `vertices`）。
    pub indices: Vec<[u32; 3]>,
    /// JSON 契约字段：入索引时**不被读取** —— `TriangleGrid::build` 按每个三角形的三个
    /// 顶点现算 AABB（`TriEntry` 的三轴 min/max 由此而来）。当前无读取方。
    pub min: V3,
    /// JSON 契约字段：同 `min`，当前无读取方。
    pub max: V3,
}

/// 一次扫掠盒追踪的结果，`trace_box` / `trace_box_tri_entries` / `World::trace` 共用。
#[derive(Clone, Debug)]
pub struct TraceResult {
    /// 移动完成比例 ∈ [0, 1]：1.0 = 全程无接触。多实体 / 多平面竞争时取**最小**的进入
    /// 分数（`clip_planes` 只收紧，不放松）。
    pub fraction: f64,
    /// 终点 = `start + (end - start) * fraction`。`TraceResult::new` 先写成 `end`，
    /// 命中（`fraction < 1.0`）后由追踪函数按分数反算覆盖。
    pub end_pos: V3,
    /// 被采纳的那条进入平面的法线（朝外，未重新归一化）。进入分数被夹取到 0.0 时照样
    /// 写入；没有任何平面被采纳时保持 `None`。
    pub normal: Option<V3>,
    /// 起点落在实体内：`clip_planes` 的 `start_out == false` 分支且通过了盒-AABB 必要
    /// 校验。**不钉住追踪** —— 该实体的裁剪整段返回，`fraction` 不因此变小；是否清零
    /// 速度由移动方决定。
    pub start_solid: bool,
    /// 全实体：`start_solid` 且没有任何平面给出出口（`get_out == false`）。
    pub all_solid: bool,
}

impl TraceResult {
    /// 无命中初值：`fraction = 1.0`、`end_pos = end`、`normal = None`、
    /// `start_solid` / `all_solid` 均为 `false`。
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

/// 三维点积。
#[inline]
fn dot(a: &V3, b: &V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// 三维差 `a - b`（`sub(&vb, &va)` = 由 `va` 指向 `vb` 的边）。
#[inline]
fn sub(a: &V3, b: &V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// 三维叉积（右手系；结果未归一化，模长 = 两向量张成的平行四边形面积）。
#[inline]
fn cross(a: &V3, b: &V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

// ---------------------------------------------------------------------------
// Minkowski 扩张 + 平面裁剪
// ---------------------------------------------------------------------------

/// Minkowski 扩张量：盒 `mins` / `maxs` 对平面 `dist` 的抬高值。
///
/// 逐轴取"离平面更远的那一侧"的盒面 —— 法线分量为正取 `mins`，否则取 `maxs` ——
/// 与法线分量相乘后求和；零法线得 0.0。
///
/// 两个调用点用同一个式子：`clip_planes` 里算 `p.dist - plane_offset(...)`（把平面推到
/// 盒外），`box_in_brush` 里把它与盒心比较。返回的是**有符号**距离，不做绝对值。
#[inline]
fn plane_offset(n: &V3, mins: &V3, maxs: &V3) -> f64 {
    (if n[0] > 0.0 { mins[0] } else { maxs[0] }) * n[0]
        + (if n[1] > 0.0 { mins[1] } else { maxs[1] }) * n[1]
        + (if n[2] > 0.0 { mins[2] } else { maxs[2] }) * n[2]
}

/// 浮点容差（0.03125）—— 三处用途都作用在"盒面到平面的距离"这一量纲上：
/// ① `clip_planes` 里"起点在外且未明显接近"的跳过阈值（`d2 >= DIST_EPSILON`）；
/// ② 进入分数 `(d1 - DIST_EPSILON) / (d1 - d2)` 与离开分数
///    `(d1 + DIST_EPSILON) / (d1 - d2)` 的 Minkowski 悬停间隙；
/// ③ `aabb_overlaps_at` 内局部常量 `EPS`（= `DIST_EPSILON / 8.0`）的除数。
const DIST_EPSILON: f64 = 0.03125;

/// 盒-AABB 必要校验的否决计数（`AtomicU32`，初值 0）。**只增不减、无复位入口**，
/// 且是模块级静态量：同一 wasm 模块内所有 `PhysWorld` 实例读到的是同一份计数，
/// 它不是"某个实例的"统计。
///
/// 自增点只有 `clip_planes` 里的两处（写法都是 `fetch_add(1, Ordering::Relaxed)`）：
/// 进入平面未被采纳（`aabb_overlaps_at` 否决，**或**该进入分数不比如今最优更近 ——
/// 这两件事共用同一个 `else`），以及"起点在体内"分支被 `aabb_overlaps_at` 否决。
/// 因此它读作"否决路径被走到的次数"，而不是纯假进入计数。
///
/// 唯一 Rust 读取方是 `src/phys/mod.rs` 的 `PhysWorld::gate_veto_count`；
/// 消费方是三个排查脚本（`apps/game/scripts/phys-p2-trace.mjs`、
/// `apps/game/scripts/phys-p2-ground.mjs`、`apps/game/scripts/phys-gate-probe2.mjs`
/// 里的 `gate_veto_count` 调用）。
pub static GATE_VETO_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// 在命中分数 `f` 处，盒 AABB 与实体 AABB 三轴都重叠（真实相交的**必要条件**）。
///
/// 任一轴分离即返回 `false`，可以据此剔除该"进入平面"：AABB 分离时两凸形必不相交，
/// 故不产生误杀。
///
/// 关键在评估位置：判据取**真实接触分数**（`clip_planes` 另行算出的
/// `f_true = d1 / (d1 - d2)`，盒表面恰贴平面、扩张量为 0），而不是带
/// `DIST_EPSILON` 悬停间隙的"扩展进入分数"。`EPS` 是函数内局部常量
/// `DIST_EPSILON / 8.0`（0.00390625），只需吸收浮点误差：真实接触处两 AABB 各轴差
/// ≤ 0；若把 0.03125 的穿透量也吸收进来，就会放过"沿平台顶悬停滑行的盒对相邻
/// brush 前缘"的假进入。
///
/// 调用点把它当**逐平面**判据用（只否决单条平面，保留该实体更晚的真实接触），
/// 而不是整实体否决 —— 后者会丢掉合法接触。
#[inline]
fn aabb_overlaps_at(
    bmin: &V3,
    bmax: &V3,
    start: &V3,
    end: &V3,
    mins: &V3,
    maxs: &V3,
    f: f64,
) -> bool {
    const EPS: f64 = DIST_EPSILON / 8.0;
    for i in 0..3 {
        let px = start[i] + (end[i] - start[i]) * f;
        let lo = px + mins[i];
        let hi = px + maxs[i];
        if hi < bmin[i] - EPS || lo > bmax[i] + EPS {
            return false;
        }
    }
    true
}

/// 扫掠盒 vs 一组平面（Minkowski 扩张版裁剪循环）：brush 的平面集与三角形的
/// 5 条构造平面共用这一条路径。
///
/// 约定：实体 = 各半空间交集 `dot(n, p) - dist <= 0`（法线朝外）。要解的是"盒沿
/// `start` → `end` 与实体相交"的分数区间 `[enter_frac, leave_frac]`。
///
/// 参数：`start` / `end` 是盒心线段，`mins` / `maxs` 是盒相对盒心的偏移（`mins[1]` 是
/// 盒底，通常为 0）；`bmin` / `bmax` 是**实体**的 AABB，只服务 `aabb_overlaps_at`。
/// 输出就地写进 `result`：`fraction`（只在更早命中时收紧）、`normal`（被采纳的那条
/// 进入平面的法线）、起点实心时的 `start_solid` 与无出口时的 `all_solid`。
///
/// 三处不明显的行为：
/// - `d1 > 0.0 && (d2 >= DIST_EPSILON || d2 >= d1 || d1 - d2 < 1e-6)` 直接 `return`：
///   起点在外、又几乎不朝平面靠近时，浮点噪声会让 `d2` 比 `d1` 小几个 ulp；不拦这一手，
///   每次贴合都会被记成一次极小的"命中"并把盒钉在平面上。注意返回的是**整个实体**的
///   裁剪，不是跳过单条平面。
/// - 进入分数用 `(d1 - DIST_EPSILON)` 作分子（盒提前 `DIST_EPSILON` 停住），可以为负；
///   写回 `fraction` 时按 0.0 夹取，故 `fraction` 不会为负；同时要求
///   `enter_frac < leave_frac && enter_frac > -1.0 && enter_frac < result.fraction`
///   才采纳（`-1.0` 是 `enter_frac` 的哨兵初值）。
/// - `start_out == false`（每条平面都判起点在体内）才走实心分支：先用
///   `aabb_overlaps_at(..., 0.0)` 做三轴必要校验，分离则整实体跳过并计数；通过才置
///   `start_solid`，并在 `get_out == false`（所有平面都不给出口）时再置 `all_solid`。
///
/// 不写 `end_pos`（由调用方按最终 `fraction` 反算），不清零速度，不筛候选。
fn clip_planes(
    planes: &[Plane],
    start: &V3,
    end: &V3,
    mins: &V3,
    maxs: &V3,
    bmin: &V3,
    bmax: &V3,
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
        // 起点在平面外且未明显靠近 → 整实体到此为止（不是跳过单条平面）。
        // 这是贴面稳健性守卫：盒停在 DIST_EPSILON 距离、又几乎与平面平行时，d2 会因
        // 浮点噪声比 d1 小几个 ulp；不拦它就会每 tick 记一次极小"命中"，把盒钉住。
        if d1 > 0.0 && (d2 >= DIST_EPSILON || d2 >= d1 || d1 - d2 < 1e-6) {
            return;
        }
        if d1 <= 0.0 && d2 <= 0.0 {
            continue;
        }

        if d1 > d2 {
            // 沿该平面进入凸体：f 是带 DIST_EPSILON 悬停间隙的进入分数。
            let f = (d1 - DIST_EPSILON) / (d1 - d2);
            // 必要校验：在**真实接触分数**处（盒表面恰贴平面、无悬停间隙）看盒 AABB 与
            // 该实体的 AABB 是否三轴重叠。不重叠即为无限平面造成的假进入（坡面端盖、
            // 沿平台顶悬停滑行撞上坡前缘都属于这一类）；此时只跳过这一条平面，
            // 保留该实体更晚的真实接触——整实体否决会丢接触。
            // 注意 else 同时覆盖"校验通过但该进入分数不比如今最优更近"，两件事都计数。
            let f_true = d1 / (d1 - d2);
            if aabb_overlaps_at(bmin, bmax, start, end, mins, maxs, f_true) && f > enter_frac {
                enter_frac = f;
                clip_plane = Some(p);
            } else {
                GATE_VETO_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        } else {
            // 沿该平面离开凸体：只收紧 leave_frac，不参与命中判定。
            let f = (d1 + DIST_EPSILON) / (d1 - d2);
            if f < leave_frac {
                leave_frac = f;
            }
        }
    }

    if !start_out {
        // 起点实心分支。这里同样受无限平面过逼近影响：盒只刺入某条平面不到 EPS、
        // 盒 AABB 却与实体分离时（盒底高于坡顶、仅侧棱刚过端盖平面），判 start_solid /
        // all_solid 会让移动方整速清零并把盒钉在该平面上。
        // 与进入平面同一判据（真实接触分数 0.0，即起点自身）：AABB 分离即真实不相交。
        if !aabb_overlaps_at(bmin, bmax, start, start, mins, maxs, 0.0) {
            GATE_VETO_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return;
        }
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

/// 扫掠盒 vs 单 brush：把 `brush.planes` 与 `brush.min` / `brush.max` 转交
/// `clip_planes`。本函数不筛候选（宽阶段在 `trace_box` 与 `BrushGrid` 里），
/// 也不读写盒的状态。
fn clip_box_to_brush(
    brush: &Brush,
    start: &V3,
    end: &V3,
    mins: &V3,
    maxs: &V3,
    result: &mut TraceResult,
) {
    clip_planes(
        &brush.planes, start, end, mins, maxs, &brush.min, &brush.max, result,
    );
}

/// 扫掠盒 vs 单个三角形：模型可视网格原样参与碰撞，不做 brush 近似。
///
/// 把三角形表示成 5 条平面后走与 brush 相同的 `clip_planes`：面用 ±法线两条零厚度
/// 平面（Minkowski 扩张后自然成为有厚度的板，故双面都可碰），三条边各一条侧平面，
/// 法线取 `normalize(cross(edge, n))` 再按质心翻正（顶点绕序不影响结果）。
///
/// 两种退化情形直接返回：三角形面积近似 0（`|cross| < 1e-8`）、有效平面不足 5 条
/// （某条边与面法线平行而 `continue`）。
///
/// 喂给 `aabb_overlaps_at` 的实体 AABB 是三个顶点现算的三角形包围盒，
/// **不是** `TriMesh` 的 `min` / `max` 字段。
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

    // 质心：只用于给边平面的法线定向（不是几何中心之外的任何量）
    let centroid = [
        (va[0] + vb[0] + vc[0]) / 3.0,
        (va[1] + vb[1] + vc[1]) / 3.0,
        (va[2] + vb[2] + vc[2]) / 3.0,
    ];

    // 面平面：±n 两条、厚度 0。单靠它们只能约束"到面的距离"，是 Minkowski 扩张把
    // 盒撑出厚度；两条都留才能命中三角形的任意一侧。
    let mut planes = vec![
        Plane { normal: n, dist: d },
        Plane { normal: [-n[0], -n[1], -n[2]], dist: -d },
    ];

    // 三条边的侧平面：法线初值 normalize(cross(边, n))，再用质心定朝向
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
    // 三角形自己的包围盒：与 brush 同一条必要校验路径（命中处盒 AABB 必须与它重叠）
    let tmin = [
        va[0].min(vb[0]).min(vc[0]),
        va[1].min(vb[1]).min(vc[1]),
        va[2].min(vb[2]).min(vc[2]),
    ];
    let tmax = [
        va[0].max(vb[0]).max(vc[0]),
        va[1].max(vb[1]).max(vc[1]),
        va[2].max(vb[2]).max(vc[2]),
    ];
    clip_planes(&planes, start, end, mins, maxs, &tmin, &tmax, result);
}

// ---------------------------------------------------------------------------
// 扫掠盒追踪（全量 / 索引候选）
// ---------------------------------------------------------------------------

/// 扫掠盒 vs 一列候选 brush，返回其中最早的一次命中。
///
/// 候选由调用方给定（`World::trace` 给的是 `BrushGrid` 查出的超集），本函数自己再做
/// 一层 AABB 宽阶段：把扫掠运动的包围盒按 `pad = 1.0` 外扩后与 `brush.min` /
/// `brush.max` 比较，任一轴分离即跳过该 brush。
///
/// 参数：`start` / `end` 是盒心线段；`mins` / `maxs` 是盒相对盒心的偏移（HU，Y 向上，
/// `mins[1]` 通常为 0）。返回值：`fraction == 1.0` 且 `start_solid == false` 表示无命中，
/// 此时 `end_pos` 保持 `end`；`fraction < 1.0` 时按 `start + (end - start) * fraction`
/// 反算 `end_pos`。
///
/// **起点实心不钉住追踪**：`start_solid` 只作标记返回，清零速度与脱困属于移动方；
/// `normal` 只在有平面被采纳时写入，无命中保持 `None`。
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

    // start_solid 不改变 fraction（不钉住追踪），脱离重叠起点由移动方负责
    if result.fraction < 1.0 {
        result.end_pos = [
            start[0] + (end[0] - start[0]) * result.fraction,
            start[1] + (end[1] - start[1]) * result.fraction,
            start[2] + (end[2] - start[2]) * result.fraction,
        ];
    }
    result
}

/// 扫掠盒 vs 一列候选三角形条目：语义与 `trace_box` 对齐 —— 同样的 `pad = 1.0`
/// 宽阶段（这里按 `TriEntry` 的三轴 min/max 过滤）、同样的 `end_pos` 反算、
/// 同样不因 `start_solid` 钉住追踪。
///
/// 差别只在候选粒度与几何构造：命中精度交给 `clip_box_to_triangle`，
/// `TriEntry.mesh` 是共享 `Rc`（本函数只读它，不克隆顶点）。
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

/// 盒（盒心 `origin` + 偏移 `mins` / `maxs`）是否与 `planes` 描述的凸体相交。
///
/// 判据：每条平面都不把盒判在外侧。平面 `dist` 先经 `plane_offset` 做 Minkowski 扩张，
/// 再与盒心比较；只有严格 `> 0`（盒心在平面外）才返回 `false`，**等于 0 算相交**，
/// 故贴面接触算在内。
///
/// 只收 `planes` 切片：不建 `Brush` 中间体、不查宽阶段、不做盒-AABB 必要校验
/// （那是 `clip_planes` 的判据，本函数没有这一步）。调用方 `World::ladder_at`
/// 直接把梯子的 `planes` 传进来；空切片恒为 `true`（无约束）。
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

/// 单个对象允许覆盖的最大 cell 数（512，`i64`）：三轴 cell 数之积 `span` 超过它即按
/// "大对象"处理 —— 不进 `cells` 哈希表（`GridCells::insert` 直接返回），改由
/// `GridCells::push_big` 记入 `big` 列表，此后每次查询无条件参与。
///
/// 两个索引各自判定一次（`BrushGrid::build`、`TriangleGrid::build`），
/// `GridCells::insert` 内还有一次同值判定。`span` 用 `i64` 连乘，避免三个 `i32`
/// cell 计数相乘时溢出。
const BIG_CELL_LIMIT: i64 = 512;

/// 均匀网格的 cell 表（`BrushGrid` 与 `TriangleGrid` 共用）。
///
/// 表里存的是**对象下标**（`usize`）而不是对象本身，故 `T` 只出现在
/// `PhantomData` 上；下标必须落在 `visited` 的长度内（由 `rebuild` 的 `count` 保证）。
///
/// 去重不是靠排序或 `contains`，而是 `visited[id] != epoch` 这一对字段：
/// 每次查询先把 `epoch` 自增，命中过的对象记下当前 `epoch`。
struct GridCells<T> {
    cells: std::collections::HashMap<(i32, i32, i32), Vec<usize>>,
    big: Vec<usize>,
    visited: Vec<i64>,
    epoch: i64,
    _marker: std::marker::PhantomData<T>,
}

impl<T> GridCells<T> {
    /// 空表：`cells` / `big` / `visited` 均空，`epoch = 0`（首次 `query` 会把它推到 1）。
    fn new() -> Self {
        GridCells {
            cells: std::collections::HashMap::new(),
            big: Vec::new(),
            visited: Vec::new(),
            epoch: 0,
            _marker: std::marker::PhantomData,
        }
    }

    /// 按对象总数重建去重表：清空 `cells` / `big`，`visited = vec![0; count]`、
    /// `epoch = 0`。
    /// `count` 必须是**对象总数**：`visited` 用对象下标索引，给小了 `query` 会越界 panic。
    fn rebuild(&mut self, count: usize) {
        self.cells.clear();
        self.big.clear();
        self.visited = vec![0i64; count];
        self.epoch = 0;
    }

    /// 把对象写进它覆盖的各个 cell；实际写入由 `insert_fn` 闭包完成（调用方已算过
    /// `span`，这里不重复计算）。
    /// `key_span > BIG_CELL_LIMIT` 时**直接返回、什么都不写** —— 调用方已在此之前调
    /// `push_big` 把它登记为大对象。本函数返回 `()`，不回报走了哪条路径。
    fn insert(&mut self, key_span: i64, insert_fn: impl FnOnce(&mut std::collections::HashMap<(i32, i32, i32), Vec<usize>>)) {
        if key_span > BIG_CELL_LIMIT {
            return; // 大对象：不进 cell（query 时始终参与，见 big 列表）
        }
        insert_fn(&mut self.cells);
    }

    /// 登记一个大对象：下一次 `query` 起它无条件参与，与它落在哪个 cell 无关。
    /// 只在 `build` 里被调用（索引重建时 `big` 被清空）。
    fn push_big(&mut self, idx: usize) {
        self.big.push(idx);
    }

    /// 遍历覆盖 `keys` 的对象并对每个对象**至多回调一次**（给的是超集，未做精确相交
    /// 判定）。`cell_keys` 由调用方生成，避免闭包内借用 `self`。
    ///
    /// 去重机制：先 `epoch += 1`（首次为 1，`visited` 初值 0，因此不会误判成已访问），
    /// 访问前只比较 `visited[id] != epoch`。调用方无需再去重，也不要依赖回调顺序 ——
    /// `big` 列表先全部访问一遍，之后才按 `keys` 命中 cell。
    ///
    /// 借用形态是为热路径定的：`visited` 先取出字段借用，`big` / `cells` 直读，
    /// 既不 clone 大对象列表，也不 clone 命中 cell 的 `Vec`，一次查询不产生堆分配。
    /// 本函数只产出下标，`visit` 拿它做什么与本结构无关。
    fn query(&mut self, keys: impl Iterator<Item = (i32, i32, i32)>, visit: &mut impl FnMut(usize)) {
        self.epoch += 1;
        let epoch = self.epoch;
        let visited = &mut self.visited;
        // big 列表无条件先访问一遍（大对象不在任何 cell 里）
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

/// brush 的均匀网格 broadphase（cell 512）：`BrushGrid::build` 后可用。
/// `brushes` 是 `World::solids` 的按值副本，二者不共享内存。
pub struct BrushGrid {
    /// 入格与查询共用同一个 cell 尺寸（`build` 写入，`World::build_index` 传 512.0）。
    cell_size: f64,
    cells: GridCells<Brush>,
    /// 全部 brush 的副本（`build` 用 `to_vec` 复制）：既是查询的数据源，
    /// 也是 `query_refs` 返回引用的所有者，故 `build` 之后旧引用全部失效。
    brushes: Vec<Brush>,
    /// 查询复用缓冲：`query_refs` 每次先 `mem::take` 走它、用完再还回，
    /// 使每 tick 的多次查询不再新建 `Vec`。
    scratch: Vec<usize>,
}

impl BrushGrid {
    /// 空索引：`cell_size` 先写 512.0，随后由 `build` 传入的值覆盖
    /// （`World::build_index` 传的也是 512.0）。
    pub fn new() -> Self {
        BrushGrid {
            cell_size: 512.0,
            cells: GridCells::new(),
            brushes: Vec::new(),
            scratch: Vec::new(),
        }
    }

    /// 重建索引：按值复制 `brushes`、记下 `cell_size`、重置 cell 表，然后逐个 brush
    /// 求覆盖的 cell 区间 `[floor(min / cell_size), floor(max / cell_size)]`。
    ///
    /// 三轴 cell 数之积 `span` 以 `i64` 计算：超 `BIG_CELL_LIMIT` 的 brush 走
    /// `push_big` + `continue`，其余按 cell 逐个 `push` 下标 —— 同一个 brush 会在它
    /// 覆盖的每个 cell 里各出现一次，跨 cell 的重复由查询侧的 `epoch` 消掉。
    ///
    /// 副作用：丢掉旧 `brushes` 副本与全部 `cells`（`scratch` 的容量保留）；
    /// 本函数不读 `World::solids`，只认参数里的切片。
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

    /// 查与 AABB 相交的 brush 下标（超集，已去重）。
    ///
    /// 覆盖范围按 `[floor(min / cell_size), floor(max / cell_size)]` 取整成 cell 区间，
    /// 全部交给 `GridCells::query`；去重由后者的 `epoch` 负责，本函数不做
    /// `contains` 线性扫描（对比 `TriangleGrid::query_entries`，那里保留了一次）。
    /// `out` 进入时先被 `clear`，因此调用方复用的缓冲不会累积上一轮结果。
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

    /// 查 brush 引用（`World::trace` / `World::is_position_free` 用）：先用复用的
    /// `scratch` 取下标，再逐个映射成 `&Brush` **追加**进 `out`（本函数不清空 `out`，
    /// 清空发生在上游 `query_indices`）。返回的引用借自 `self.brushes`。
    fn query_refs<'a>(&'a mut self, min: &V3, max: &V3, out: &mut Vec<&'a Brush>) {
        // mem::take 把复用缓冲整块挪出 self（零成本移动），避开
        // query_indices(&mut self) 与 &mut self.scratch 的双重可变借用
        let mut scratch = std::mem::take(&mut self.scratch);
        self.query_indices(min, max, &mut scratch);
        for &id in &scratch {
            out.push(&self.brushes[id]);
        }
        self.scratch = scratch;
    }
}

/// 三角形空间索引条目：一个条目 = 一个三角形。
///
/// `a` / `b` / `c` 是指向 `mesh.vertices` 的下标，`min_*` / `max_*` 是 `build` 时由
/// 三个顶点现算的三轴 AABB（宽阶段用它过滤，不用 `TriMesh` 的 min/max 字段）。
#[derive(Clone)]
pub struct TriEntry {
    /// 三角形所属网格，按 `Rc` **共享**：`TriangleGrid::build` 对每个网格只深克隆一次
    /// （`Rc::new(mesh.clone())`），网格内所有三角形各持一个 `Rc::clone`。
    /// 若改成按值持有，每个三角形都会深克隆整份 `vertices` + `indices`，
    /// 拷贝量随"三角形数 × 网格大小"增长。
    /// 约束：`Rc` 不是线程安全的，此处只适用于 wasm 单线程。
    pub mesh: std::rc::Rc<TriMesh>,
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

/// 三角形的均匀网格 broadphase（cell 256）：与 `BrushGrid` 同构，差别是表里存
/// `TriEntry`、按每个三角形的 AABB 入格，并且每个网格只深克隆一次（网格内共享 `Rc`）。
pub struct TriangleGrid {
    /// 入格与查询共用同一个 cell 尺寸（`build` 写入，`World::build_index` 传 256.0）。
    cell_size: f64,
    cells: GridCells<TriEntry>,
    /// 全部三角形条目：`build` 先 `clear` 再逐个压入，`query_refs` 返回的引用源。
    entries: Vec<TriEntry>,
}

impl TriangleGrid {
    /// 空索引：`cell_size` 先写 256.0，随后由 `build` 传入的值覆盖
    /// （`World::build_index` 传的也是 256.0）。
    pub fn new() -> Self {
        TriangleGrid {
            cell_size: 256.0,
            cells: GridCells::new(),
            entries: Vec::new(),
        }
    }

    /// 重建索引：`entries` 清空后按 `meshes` 顺序逐三角形压入，同时求入格范围。
    ///
    /// `total` 是**三角形总数**（`Σ mesh.indices.len()`），三处口径必须一致：
    /// `cells.rebuild(total)` 用它定长 `visited`、`entries.reserve(total)` 预分配、
    /// 实际压入条数也等于它（退化三角形在压入之后才由 `clip_box_to_triangle` 忽略，
    /// 不在建索引阶段剔除）。
    ///
    /// 每个网格固定深克隆一次（`Rc::new(mesh.clone())`，`indices` 为空的网格也算），
    /// 网格内所有三角形共享它。`span > BIG_CELL_LIMIT` 的三角形进 `big` 列表。
    ///
    /// 副作用：丢弃旧 `entries` 与全部 `cells`；不读 `TriMesh.min` / `max`。
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
            // 本网格只深克隆这一次：三角形条目共享同一个 Rc，不再逐三角形 clone
            let shared = std::rc::Rc::new(mesh.clone());
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
                    mesh: std::rc::Rc::clone(&shared),
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

    /// 查候选三角形下标（超集）。覆盖范围取整方式与 `BrushGrid::query_indices` 相同，
    /// `out` 同样先清空。
    ///
    /// 与 brush 侧的唯一结构差别：这里的 `visit` 闭包在 push 前多做一次
    /// `out.contains(&id)` 线性去重。`GridCells::query` 的 `epoch` 已经保证同一对象每次
    /// 查询只回调一次，所以这一步在当前实现下是重复的（候选多时是平方级开销）。
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

    /// 查三角形条目引用：先取下标，再逐个映射成 `&TriEntry` **追加**进 `out`
    /// （不清空 `out`）。`ids` 是每次调用新建的局部缓冲 —— 与 `BrushGrid::query_refs`
    /// 复用 `scratch` 的做法不同，这条路径每次查询都分配一次。
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

/// 一份地图的碰撞数据 + 两套索引。
///
/// `solids` / `ladders` / `tri_meshes` 是权威数据（上游 `PhysWorld::build_world` 填充），
/// `grid` / `tri_grid` 是它们的索引副本。字段公开可写，但索引不会跟着变 ——
/// 改完这三个字段必须重跑 `World::build_index`。
///
/// `trace` 与 `is_position_free` 取 `&mut self`：查询要推进 `GridCells` 的 `epoch`
/// 并复用内部缓冲。
pub struct World {
    pub solids: Vec<Brush>,
    pub ladders: Vec<LadderVolume>,
    pub tri_meshes: Vec<TriMesh>,
    grid: BrushGrid,
    tri_grid: TriangleGrid,
}

impl World {
    /// 空世界：三份数据为空、两套索引为空。索引要用 `World::build_index` 才建起来。
    pub fn new() -> Self {
        World {
            solids: Vec::new(),
            ladders: Vec::new(),
            tri_meshes: Vec::new(),
            grid: BrushGrid::new(),
            tri_grid: TriangleGrid::new(),
        }
    }

    /// 一次建齐两套索引：`BrushGrid` 用 `solids` 与 **512** 的 cell；`TriangleGrid` 用
    /// `tri_meshes` 与 **256** 的 cell，且**只在 `tri_meshes` 非空时**才构建
    /// （空网格时 `trace` / `is_position_free` 也都不查三角索引）。
    ///
    /// 调用时机：`solids` / `ladders` / `tri_meshes` 赋值**之后**。索引是副本，此后改动
    /// 这三个字段必须重新调用才生效。`ladders` 不参与索引（`World::ladder_at` 线性扫描）。
    /// 本函数只读三个字段，不改任何数据。
    pub fn build_index(&mut self) {
        self.grid.build(&self.solids, 512.0);
        if !self.tri_meshes.is_empty() {
            self.tri_grid.build(&self.tri_meshes, 256.0);
        }
    }

    /// 扫掠盒追踪：brush 与三角网格两条线各取候选，返回更早的那次命中。
    ///
    /// 流程：① 把扫掠运动的包围盒按 `pad = 1.0` 外扩成 `[s_min, s_max]`；
    /// ② 向 `BrushGrid` 取候选得 `brush_result`；③ 仅当 `tri_meshes` 非空时再向
    /// `TriangleGrid` 取候选得 `tri_result`，**严格小于**才改判为三角命中 ——
    /// 两者同分时取 brush；④ 无三角网格时直接返回 brush 结果。
    ///
    /// 参数与返回语义同 `trace_box`（`fraction`、`end_pos`、`normal`、`start_solid` /
    /// `all_solid`）。需要 `&mut self` 是因为查询会推进 `epoch` 并复用内部缓冲。
    /// 本函数不移动任何东西，也只返回**单个**最早命中（不返回命中列表）。
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

        // brush 候选：网格给出的是超集，命中判定在 trace_box 里
        let mut candidates: Vec<&Brush> = Vec::new();
        self.grid.query_refs(&s_min, &s_max, &mut candidates);
        let brush_result = trace_box(start, end, mins, maxs, &candidates[..]);

        // 三角网格同理；只有更早（严格小于）才覆盖 brush 结果
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

    /// 盒（盒心 `origin` + 偏移 `mins` / `maxs`）在该点是否自由：与任何 brush、任何三角形
    /// 都不相交。
    ///
    /// 实现是**零长追踪**：`trace_box(origin, origin, ...)` 起点即终点，此时只有
    /// "起点在实体内"这一条路能判出相交，于是取 `start_solid` 作答案。查询范围比盒各轴
    /// 再外扩 1.0；brush 与三角网格两侧都查（后者仅在 `tri_meshes` 非空时）。
    ///
    /// 返回 `true` 只说明这一点不与几何体相交，不检查周围空间、不看速度与姿态。
    /// 消费方是 `player` 的空中起立判定、地面起立判定与卡死挤出。
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

    /// 盒（盒心 `origin` + 偏移 `mins` / `maxs`）命中的**第一个**梯子下标，无命中返回 `None`。
    ///
    /// 逐个梯子调 `box_in_brush`，只用 `planes`（不看梯子的 AABB）。`ladders` 不在任何
    /// 空间索引里，这里是按数据顺序的线性扫描：多个梯子重叠时返回下标最小者。
    ///
    /// 返回下标而不是引用，是为了让调用方（`player::check_ladder`）能在拿到结果后继续
    /// 以 `&mut world` 走移动流程；它再用下标去取 `facing`。
    pub fn ladder_at(&self, origin: &V3, mins: &V3, maxs: &V3) -> Option<usize> {
        for (i, ladder) in self.ladders.iter().enumerate() {
            if box_in_brush(origin, mins, maxs, &ladder.planes) {
                return Some(i);
            }
        }
        None
    }
}
