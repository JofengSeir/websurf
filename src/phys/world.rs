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
//! - `solids` 按实体归属拆两路：`entity < 0` 的世界几何进 `BrushGrid`（cell 512）；
//!   `entity >= 0` 的实体 brush 不进网格，只在 `World::dynamic_solid_indices` 里记下标，
//!   查询时按扫掠盒 AABB 现场过滤 —— 电梯/门每帧移动**不需要重建静态网格**。
//!   `tri_meshes` → `TriangleGrid`（cell 256，且仅在 `tri_meshes` 非空时构建）；
//!   **`ladders` 不进任何索引**，`World::ladder_at` 对它线性扫描。
//! - `BrushGrid` 只存下标、不复制 brush（查询直接读 `World::solids`）；`TriangleGrid::build`
//!   对每个网格深克隆一次、网格内按 `Rc` 共享。因此 `build_index` 之后再改
//!   `World::tri_meshes`（或增删世界几何），索引仍是旧副本，必须重建才生效；
//!   实体 brush 的位移经 `World::set_entity_offset` 直接写回 `World::solids`，
//!   由动态下标指向，下一次查询立即生效。
//!
//! 关键约定（全部由本文件代码固定）：
//! - 平面法线**朝外**，实体 = 各半空间交集 `dot(n, p) - dist <= 0`；
//! - Minkowski 扩张：盒 `mins` / `maxs` 把平面 `dist` 抬高 `plane_offset`，故裁剪出的
//!   进入点带 `DIST_EPSILON`（0.03125）的悬停间隙；点判（`box_in_brush`）用同一扩张；
//! - 盒-AABB 必要校验（`aabb_overlaps_at`）的容差是函数内局部常量
//!   `DIST_EPSILON / 8.0`（0.00390625，**不在模块作用域**）：无限平面造成的假进入
//!   只跳过该条平面，保留同一实体更晚的真实接触，不做整实体否决；
//! - 网格查询给出的是**超集**（AABB 相交即候选），是否真的命中由 `clip_planes` 决定；
//! - **三角形走 Minkowski 和的精确面集**（`clip_box_to_triangle`）：三角面 ⊕ 盒顶点（±n）、
//!   三角边 ⊕ 盒棱（每条边 ×3 盒轴，法线 `cross(edge, axis)`）、三角顶点 ⊕ 盒面（±三轴）。
//!   等价于 SDK `CDispCollTree::SweepAABBTriIntersect` 的 `AxisPlanesXYZ` + `EdgeCrossAxis*`。
//!   少掉边/轴两类 ⇒ 盒脚印跨棱线时一次接触都不产生（会穿过去）；只用「边墙」
//!   `cross(edge, n)` 代替 ⇒ 障碍集被放大（那条法线的支撑集只有 1 维），贴坡时会被横法线
//!   挡死（「脚底黏住」）。三角形**不参与 `start_solid` / `all_solid`**：盒跨在面两侧是
//!   贴地/贴坡的常态，不是嵌入实体，当实心会让贴面行走每 tick 误报一次「起点在实体内」。
//! - 大对象兜底：跨度超 `BIG_CELL_LIMIT`（512 个 cell）的对象进 `big` 列表，
//!   每次查询无条件参与。
//!
//! 边界：不做 BSP 解析、不生成网格、不移动玩家、不碰渲染；`start_solid` 不钉住追踪
//! （起点实心时该实体的裁剪整段返回，`fraction` 不因此变小），脱离重叠起点由移动方
//! 负责；本模块不持有全局可变状态，唯一例外是诊断计数器 `GATE_VETO_COUNT`
//! （只增不减、无复位入口，同模块内所有实例共享一份）。
//!
//! 测试归属：`p2_gate_tests`（4 项）直接构造 60° 坡面 brush 调 `trace_box`；
//! `tri_surface_tests`（4 项）钉三角形「面」语义（面不成实心、边墙不出法线、陡面仍挡）；
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
    /// 所属实体下标（实体枚举顺序，与 wasm 导出的 `vbsp_entity_index` 一致）；
    /// `-1` = worldspawn 或无实体归属（世界几何，恒实心）。
    ///
    /// 运行期碰撞开关按这个下标查 [`World::entity_solid`]：`func_wall_toggle` /
    /// `func_door` 等实体 brush 可能在出生时是「关」的（`start_solid=false`），
    /// 之后由实体 I/O 切换。减面/抗锯齿不影响判定，它只做候选过滤。
    pub entity: i32,
}

/// 梯子 brush：几何与 `Brush` 同构（`planes` 朝外 + AABB），额外带一个可攀爬面朝向
/// `facing`（由 `compute_ladder_facing` 从平面集求得，y 恒为 0）与所属实体下标。
/// `World::ladder_at` 只用 `planes` 判相交，并按实体碰撞状态过滤。
///
/// **facing 只是兜底**：盒子形状的梯子（四个竖直面水平分量都是 1）在
/// `compute_ladder_facing` 里会因平面顺序选到任意一面（可能沿 X 或 Z），所以真正攀爬用的
/// 朝向在每次附身时由 [`LadderVolume::facing_toward`] 按玩家所在方位重新选面。
#[derive(Clone, Debug)]
pub struct LadderVolume {
    pub planes: Vec<Plane>,
    /// AABB 下界：`facing_toward` 用中心/最近点判玩家所在方位。
    pub min: V3,
    /// AABB 上界：同 `min`。
    pub max: V3,
    /// 攀爬面朝向的**兜底值**（水平分量已归一化、y 恒为 0）：玩家正好落在梯子 AABB
    /// 水平投影内、无法从方位选面时使用。
    pub facing: V3,
    /// 所属实体枚举下标（-1 = worldspawn）。与 [`Brush::entity`] 同序：实体 brush
    /// 的碰撞状态切换（`World::entity_solid`）同样决定该梯子是否可攀爬——`func_door`
    /// 等实体被隐藏/设为非实心后，它内部带 LADDER 内容的刷子不应还能被爬
    /// （否则会出现「看不见却能挂上去」的隐形梯）。
    pub entity: i32,
}

impl LadderVolume {
    /// 按玩家位置选一个「朝向玩家」的水平面法线，作为本次攀爬的 facing。
    ///
    /// 盒子梯子的竖直面法线水平分量全是 1，`compute_ladder_facing` 的「取最大」会
    /// 退化成按平面顺序任选一面；若选中切线方向，攀爬会变成「只推墙不上升」（表现为
    /// 挂住不动）。这里改为：取玩家到 AABB 最近点（水平）的方向，在梯子竖直面法线里
    /// 选与其夹角最小者（即玩家所站那一面），退化时回退 [`Self::facing`]。
    pub fn facing_toward(&self, origin: &V3) -> V3 {
        // 玩家水平投影相对梯子 AABB 的方位（最近点法：玩家在 AABB 外时稳定）。
        let near_x = origin[0].clamp(self.min[0], self.max[0]);
        let near_z = origin[2].clamp(self.min[2], self.max[2]);
        let mut dir = [origin[0] - near_x, 0.0, origin[2] - near_z];
        let len = (dir[0] * dir[0] + dir[2] * dir[2]).sqrt();
        if len > 1e-3 {
            dir[0] /= len;
            dir[2] /= len;
            let mut best = self.facing;
            let mut best_dot = 0.2f64; // 至少要明显朝向玩家，否则回退兜底 facing
            for plane in &self.planes {
                let h_len = (plane.normal[0] * plane.normal[0]
                    + plane.normal[2] * plane.normal[2])
                    .sqrt();
                if h_len < 0.3 {
                    continue;
                }
                let nx = plane.normal[0] / h_len;
                let nz = plane.normal[2] / h_len;
                let d = nx * dir[0] + nz * dir[2];
                if d > best_dot {
                    best_dot = d;
                    best = [nx, 0.0, nz];
                }
            }
            return best;
        }
        // 玩家水平落在 AABB 内：用中心指向玩家（可能仍退化），最后回退兜底 facing。
        let cx = (self.min[0] + self.max[0]) * 0.5;
        let cz = (self.min[2] + self.max[2]) * 0.5;
        let mut dir = [origin[0] - cx, 0.0, origin[2] - cz];
        let len = (dir[0] * dir[0] + dir[2] * dir[2]).sqrt();
        if len > 1e-3 {
            dir[0] /= len;
            dir[2] /= len;
            for plane in &self.planes {
                let h_len = (plane.normal[0] * plane.normal[0]
                    + plane.normal[2] * plane.normal[2])
                    .sqrt();
                if h_len < 0.3 {
                    continue;
                }
                let nx = plane.normal[0] / h_len;
                let nz = plane.normal[2] / h_len;
                if nx * dir[0] + nz * dir[2] > 0.2 {
                    return [nx, 0.0, nz];
                }
            }
        }
        self.facing
    }
}

/// 模型三角形碰撞网格：`vertices` 是世界空间顶点，`indices` 是三元组下标。
/// 顶点与索引按 JSON 原样收下，本文件不重采样、不做坐标变换、不合并三角形。
#[derive(Clone, Debug)]
#[allow(dead_code)] // min/max/name 见各字段注释
pub struct TriMesh {
    /// 模型名（来自 tri JSON 的 `name` 字段，如 `models/props/666/s1_ramp1b.mdl`）。
    ///
    /// **只用于诊断归属**：`World::collide_attrib` 报「哪个碰撞体挡住了玩家」时经
    /// `PhysWorld::debug_tri_mesh_name` 把它交给 JS。碰撞判定本身不读它。
    ///
    /// 此前该字段在 `parse_tri_meshes` 的 `WasmTriMesh` 上**没有声明**，serde 按默认行为
    /// 忽略未知字段，于是 `export_model_phy_colliders` 明明吐了 `name`、落地后却查不到
    /// 「这条三角形属于哪个模型」——看板 `T-065` 的待裁决第 ① 条就是它。
    pub name: String,
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
    /// 被采纳的接触面法线（朝外，已归一化）。同分数接触取平均，见 `clip_planes` 内的
    /// `CONTACT_FRAC_TIE`。进入分数被夹取到 0.0 时照样写入；没有任何平面被采纳时保持
    /// `None`。
    pub normal: Option<V3>,
    /// 本次命中里**最陡**的那张接触面法线（`normal[1]` 最小者），已归一化。
    ///
    /// 为什么必须和 [`TraceResult::normal`] 分开带：`normal` 是**平均**法线，在凸棱/凹谷
    /// 上会把两张斜面平均成一个"看着像平地"的法线（45°/45° 棱 → `n.y = 1.0`）。这正是
    /// 要的；但同一招会把 52°/52° 棱也平均成 `n.y = 1.0`，真正陡的坡就被判成可站。
    /// 所以站立判据拆成两条、缺一不可：
    /// 1. **没有任何接触面陡过阈值**（读本字段，不读 `normal`）——逐面判定，与哪张面
    ///    "赢得" enter_frac 竞赛**无关**，从而消掉棱线上的浮点抽签；
    /// 2. 平均法线本身可站（读 `normal`）——决定"是否算站在地面上"。
    ///
    /// 只有真正挡住盒子的面才可能是进入面（贴墙时墙面 `d1 <= 0 && d2 <= 0`，直接跳过），
    /// 故这条不会因为"旁边有堵墙"而误判。
    pub steepest_normal: Option<V3>,
    /// 起点落在实体内：`clip_planes` 的 `start_out == false` 分支且通过了盒-AABB 必要
    /// 校验。**不钉住追踪** —— 该实体的裁剪整段返回，`fraction` 不因此变小；是否清零
    /// 速度由移动方决定。
    pub start_solid: bool,
    /// 全实体：`start_solid` 且没有任何平面给出出口（`get_out == false`）。
    pub all_solid: bool,
}

impl TraceResult {
    /// 无命中初值：`fraction = 1.0`、`end_pos = end`、`normal = None`、
    /// `steepest_normal = None`、`start_solid` / `all_solid` 均为 `false`。
    pub fn new(end: V3) -> Self {
        TraceResult {
            fraction: 1.0,
            end_pos: end,
            normal: None,
            steepest_normal: None,
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
pub(crate) fn dot(a: &V3, b: &V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// 三维差 `a - b`（`sub(&vb, &va)` = 由 `va` 指向 `vb` 的边）。
#[inline]
pub(crate) fn sub(a: &V3, b: &V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// 三维叉积（右手系；结果未归一化，模长 = 两向量张成的平行四边形面积）。
#[inline]
pub(crate) fn cross(a: &V3, b: &V3) -> V3 {
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

/// 进入分数的"同处一地"容差：两次进入分数之差小于它即视为**同时接触**，法线一并计入
/// 平均（见 `clip_planes`）。
///
/// 取值理由：玩家沿坡上行时 tick 位移 ~0.3 HU，盒半高 ~16 HU；真正"同一处"的多个面
/// （棱、谷、台阶棱）彼此的分数差是浮点级（两条面 `d1 ≈ 0` ⇒ `f_true ≈ 0`），而不同
/// 几何处的接触分数差至少是 `盒尺寸 / 位移` 量级。故 1e-4 足以覆盖棱线、又不至于把
/// 相邻两级台阶的不同面混成一组。
const CONTACT_FRAC_TIE: f64 = 1e-4;

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
/// 消费方是三个排查脚本（`apps/game/scripts/phys-p2-trace.mjs`（已移除）、
/// `apps/game/scripts/phys-p2-ground.mjs`（已移除）、`apps/game/scripts/phys-gate-probe2.mjs`（已移除）
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
    // 命中分数处的接触面法线累加（同分数 = 同一处同时接触，如棱/谷），以及其中最陡的一张。
    let mut contact_sum = [0.0f64; 3];
    let mut contact_n = 0usize;
    let mut steepest: Option<V3> = None;
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
            if !aabb_overlaps_at(bmin, bmax, start, end, mins, maxs, f_true) {
                // 无限平面造成的假进入（坡面端盖、沿平台顶悬停滑行撞上坡前缘）。
                GATE_VETO_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            } else if contact_n == 0 || f > enter_frac + CONTACT_FRAC_TIE {
                // 明显更近的接触：另起一组。
                enter_frac = f;
                contact_sum = p.normal;
                contact_n = 1;
                steepest = Some(p.normal);
            } else if f > enter_frac - CONTACT_FRAC_TIE {
                // 与当前最优**同处一地**（进入分数之差在 `CONTACT_FRAC_TIE` 内，**含略低
                // 的那一张**）：棱线、谷底、台阶棱等处多张面同时接触。累加求平均，而不是让
                // 浮点抽签决定谁赢。必须对称地收略低的那张——对称棱上两张面谁大谁小纯属
                // 浮点噪声，只收"更大"的等价于按噪声分组。
                if f > enter_frac {
                    enter_frac = f;
                }
                contact_sum = [
                    contact_sum[0] + p.normal[0],
                    contact_sum[1] + p.normal[1],
                    contact_sum[2] + p.normal[2],
                ];
                contact_n += 1;
                steepest = Some(match steepest {
                    Some(s) if s[1] <= p.normal[1] => s,
                    _ => p.normal,
                });
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
        if contact_n > 0 {
            let len =
                (contact_sum[0] * contact_sum[0] + contact_sum[1] * contact_sum[1]
                    + contact_sum[2] * contact_sum[2])
                    .sqrt();
            result.normal = Some(if len > 1e-9 {
                [
                    contact_sum[0] / len,
                    contact_sum[1] / len,
                    contact_sum[2] / len,
                ]
            } else {
                contact_sum
            });
            result.steepest_normal = steepest;
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

/// 扫掠盒 vs 单个三角形：取 **Minkowski 和 `三角形 ⊕ 盒` 的精确面集**（SDK 口径）。
///
/// 三角形是「面」不是实体（置换面恒走这条路，`.phy` 里凸性不达标的块也走它），
/// 故障碍集是 `Tri ⊕ (-Box)`，它的面（facet）只有三类，**缺一类就漏接触**：
///
/// 1. **三角面 ⊕ 盒顶点** ⇒ ±n 两张零厚度平面（Minkowski 扩张后自然带盒的厚度）；
/// 2. **三角边 ⊕ 盒棱（沿盒轴）** ⇒ 每条边 ×3 条盒轴，法线 `±normalize(cross(edge, axis))`
///    **两个朝向都要**（见下）；
/// 3. **三角顶点 ⊕ 盒面** ⇒ ±x/±y/±z 六张，`dist` 取三角形在该轴向上的支撑值。
///
/// 三类合起来等价于 SDK `CDispCollTree::SweepAABBTriIntersect`（`public/dispcoll_common.h`）：
/// 它以 `AxisPlanesXYZ`（第 3 类）+ `Cache_EdgeCrossAxisX/Y/Z`（第 2 类）+ 三角面逐面求交，
/// 再用 `ResolveRayPlaneIntersect` 定进入/离开分数 —— 即引擎对置换面那套「盒 vs 三角」扫掠。
///
/// **为什么不能只留第 1 类**（2026-10-08 实测）：盒的脚印**跨过三角形棱线**时，面平面的进入
/// 分数是用「盒沿 n 的支撑角」算的，而那个角可能落在三角形面域**之外** ⇒ 命中处盒 AABB 与
/// 该三角形 AABB 分离 ⇒ `aabb_overlaps_at` 正当否决 ⇒ 该三角形一次接触都不产生 ⇒ 盒**从棱线
/// 处穿过去**（`surf_boreas` 13183,10060 附近 `__disp_176` 的棱上，连跳几下就掉到 -256）。
/// 补上第 2/3 类后棱线自会被 `cross(edge, axis)` 面接住。
///
/// **为什么不能用「边墙」`cross(edge, n)` 代替第 2 类**（2026-10-07/08 两轮实测）：那条法线
/// **不是** `Tri ⊕ (-Box)` 的面（其支撑集是 1 维的），它属于 `Tri ⊕ 线段(n)` ⇒ 障碍集被放大，
/// 贴坡行走时盒的前缘会在相邻三角的棱线上被一张横法线挡住、法线又几乎与移动方向相反 ⇒
/// 速度被整段剪掉、每 tick 只挪零点几 HU（表现为「脚底黏住」）。第 2 类的法线是斜的，
/// 接触后盒沿坡面滑走。
///
/// **第 2 类必须两个朝向都压入**（2026-11-17 实测修复）：按上面的 `cross(edge, axis)`
/// 只用**一个**朝向时，约一半的 (边, 盒轴) 组合拿到的是「反 inward」方向 —— 它仍是障碍集的
/// 合法支撑面，但**不是外法线那张面**；真正的那张（`-u`，`dist = support(-u)`）漏掉后，
/// 半空间交集比 `Tri ⊕ (-Box)` 大，盒在**两块三角的折痕附近**会被提前挡住。`surf_boreas`
/// 雪山 `(-1148,11618)`（两块 512 HU 置换三角的对角折痕，法线相差约 20°）实测：32×72×32 盒
/// 下扫命中 12603.44，而严格 SAT（盒 vs 三角 13 轴）真值是 12597.52 ⇒ 幽灵台阶高 5.92 HU；
/// 补上 `-u` 后该点命中 12597.52（沿线 9 个采样点全部收敛到 SAT 值）。物理上这就是玩家
/// 报的「慢速跨接缝时莫名抬升/下降几个单位，像走台阶」。
///
/// 三角形不写 `start_solid` / `all_solid`：盒跨在面两侧是站/贴面的常态，不是嵌入实体；
/// 写成实心会让贴面行走每 tick 命中一次「起点实心」把速度清零。
///
/// 退化情形直接返回：三角形面积近似 0（`|cross| < 1e-8`）；法线平行的边不产面（`continue`）。
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

    // 三角形在方向 u 上的支撑值（面集里每张面的 `dist` 都取它，故面都恰是支撑面）
    let support = |u: &V3| dot(u, &va).max(dot(u, &vb)).max(dot(u, &vc));

    // 第 1 类：三角面 ⊕ 盒顶点（±n）
    let mut planes: Vec<Plane> = Vec::with_capacity(26);
    planes.push(Plane { normal: n, dist: d });
    planes.push(Plane {
        normal: [-n[0], -n[1], -n[2]],
        dist: -d,
    });

    // 第 2 类：三角边 ⊕ 盒棱（三条盒轴）；±u 两个朝向都要（见函数注释：只压一个朝向时
    // 折痕附近障碍集偏大，盒会被提前挡住形成幽灵台阶）
    let axes: [V3; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let push = |planes: &mut Vec<Plane>, u: V3| {
        planes.push(Plane {
            normal: u,
            dist: support(&u),
        });
    };
    for (pa, pb) in [(&va, &vb), (&vb, &vc), (&vc, &va)] {
        let e = sub(pb, pa);
        for ax in &axes {
            let raw = cross(&e, ax);
            let len = (dot(&raw, &raw)).sqrt();
            if len < 1e-8 {
                continue; // 边与盒轴平行 ⇒ 该面退化成零面积，跳过
            }
            let u = [raw[0] / len, raw[1] / len, raw[2] / len];
            push(&mut planes, u);
            push(&mut planes, [-u[0], -u[1], -u[2]]);
        }
    }

    // 第 3 类：三角顶点 ⊕ 盒面（±三轴）
    for i in 0..3 {
        for s in [1.0, -1.0] {
            let mut u: V3 = [0.0, 0.0, 0.0];
            u[i] = s;
            planes.push(Plane {
                normal: u,
                dist: support(&u),
            });
        }
    }
    if planes.len() < 4 {
        return; // 退化保护（正常路径恒 26 张）
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

    // 走 `cand` 再挑字段：三角形**不传播** `start_solid` / `all_solid`（见上）
    let mut cand = TraceResult::new(*end);
    clip_planes(&planes, start, end, mins, maxs, &tmin, &tmax, &mut cand);
    if cand.fraction >= 1.0 || cand.fraction >= result.fraction {
        return;
    }
    result.fraction = cand.fraction;
    result.normal = cand.normal;
    result.steepest_normal = cand.steepest_normal;
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
    trace_box_iter(start, end, mins, maxs, brushes.iter().copied())
}

/// 扫掠盒宽阶段包围盒：盒心线段按 `pad = 1.0` 外扩。
///
/// 两处必须共用同一份口径：`trace_box_iter` / `trace_box_tri_iter` 的内层 AABB 判据，
/// 与 `World::collect_brush_candidates` 对动态 brush 的过滤。任何一处单独改 pad 都会让
/// “候选是超集”不再成立（动态 brush 会被提前砍掉）。
fn sweep_bounds(start: &V3, end: &V3, mins: &V3, maxs: &V3) -> (V3, V3) {
    let pad = 1.0;
    (
        [
            start[0].min(end[0]) + mins[0] - pad,
            start[1].min(end[1]) + mins[1] - pad,
            start[2].min(end[2]) + mins[2] - pad,
        ],
        [
            start[0].max(end[0]) + maxs[0] + pad,
            start[1].max(end[1]) + maxs[1] + pad,
            start[2].max(end[2]) + maxs[2] + pad,
        ],
    )
}

/// `trace_box` 的泛型核心：接受任意 `&Brush` 迭代器（全量切片或按下标现取），
/// 语义与返回值同 `trace_box`。
fn trace_box_iter<'a>(
    start: &V3,
    end: &V3,
    mins: &V3,
    maxs: &V3,
    brushes: impl IntoIterator<Item = &'a Brush>,
) -> TraceResult {
    let mut result = TraceResult::new(*end);
    let (s_min, s_max) = sweep_bounds(start, end, mins, maxs);

    for brush in brushes {
        if brush.min[0] > s_max[0]
            || brush.max[0] < s_min[0]
            || brush.min[1] > s_max[1]
            || brush.max[1] < s_min[1]
            || brush.min[2] > s_max[2]
            || brush.max[2] < s_min[2]
        {
            continue;
        }
        clip_box_to_brush(brush, start, end, mins, maxs, &mut result);
    }
    finish_trace(result, start, end)
}

/// 按下标从 `solids` 现取 brush：热路径候选只存下标，这里避免先摊成 `Vec<&Brush>`。
fn trace_box_indices(
    start: &V3,
    end: &V3,
    mins: &V3,
    maxs: &V3,
    solids: &[Brush],
    ids: &[usize],
) -> TraceResult {
    trace_box_iter(start, end, mins, maxs, ids.iter().map(|&i| &solids[i]))
}

/// 收尾：`fraction < 1.0` 时按 `start + (end - start) * fraction` 反算 `end_pos`；
/// `start_solid` 不改变 `fraction`（不钉住追踪），脱离重叠起点由移动方负责。
fn finish_trace(mut result: TraceResult, start: &V3, end: &V3) -> TraceResult {
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
    trace_box_tri_iter(start, end, mins, maxs, entries.iter().copied())
}

/// `trace_box_tri_entries` 的泛型核心（与 brush 侧同构，宽阶段按 `TriEntry` 三轴 AABB）。
fn trace_box_tri_iter<'a>(
    start: &V3,
    end: &V3,
    mins: &V3,
    maxs: &V3,
    entries: impl IntoIterator<Item = &'a TriEntry>,
) -> TraceResult {
    let mut result = TraceResult::new(*end);
    let (s_min, s_max) = sweep_bounds(start, end, mins, maxs);

    for e in entries {
        if e.min_x > s_max[0]
            || e.max_x < s_min[0]
            || e.min_y > s_max[1]
            || e.max_y < s_min[1]
            || e.min_z > s_max[2]
            || e.max_z < s_min[2]
        {
            continue;
        }
        clip_box_to_triangle(
            &e.mesh, e.a, e.b, e.c, start, end, mins, maxs, &mut result,
        );
    }
    finish_trace(result, start, end)
}

/// 按下标从 `TriangleGrid::entries` 现取（同 `trace_box_indices`）。
fn trace_box_tri_indices(
    start: &V3,
    end: &V3,
    mins: &V3,
    maxs: &V3,
    entries: &[TriEntry],
    ids: &[usize],
) -> TraceResult {
    trace_box_tri_iter(start, end, mins, maxs, ids.iter().map(|&i| &entries[i]))
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
///
/// **不持有 brush 副本**：格子里只存 `World::solids` 的下标，查询返回的也是下标，
/// 由调用方现取几何。因此运行期平移实体 brush 不需要重建本索引（它们本就不在格子里）。
pub struct BrushGrid {
    /// 入格与查询共用同一个 cell 尺寸（`build` 写入，`World::build_index` 传 512.0）。
    cell_size: f64,
    cells: GridCells<Brush>,
}

impl BrushGrid {
    /// 空索引：`cell_size` 先写 512.0，随后由 `build` 传入的值覆盖
    /// （`World::build_index` 传的也是 512.0）。
    pub fn new() -> Self {
        BrushGrid {
            cell_size: 512.0,
            cells: GridCells::new(),
        }
    }

    /// 重建索引：记下 `cell_size`、重置 cell 表，然后逐个 brush 求覆盖的 cell 区间
    /// `[floor(min / cell_size), floor(max / cell_size)]`。
    ///
    /// `keep` 返回 `false` 的 brush **不入格**（`World::build_index` 用它排除
    /// `entity >= 0` 的实体 brush，那些走动态候选）；入格用的是它在参数切片里的
    /// **原始下标**，与 `World::solids` 同序，故 `GridCells::rebuild` 的 `count`
    /// 必须是 `brushes.len()` 而不是入格数量。
    ///
    /// 三轴 cell 数之积 `span` 以 `i64` 计算：超 `BIG_CELL_LIMIT` 的 brush 走
    /// `push_big` + `continue`，其余按 cell 逐个 `push` 下标 —— 同一个 brush 会在它
    /// 覆盖的每个 cell 里各出现一次，跨 cell 的重复由查询侧的 `epoch` 消掉。
    ///
    /// 副作用：丢掉全部 `cells`；本函数不读 `World::solids`，只认参数里的切片。
    pub fn build(&mut self, brushes: &[Brush], keep: impl Fn(&Brush) -> bool, cell_size: f64) {
        self.cell_size = cell_size;
        self.cells.rebuild(brushes.len());

        let inv = 1.0 / cell_size;
        for (i, b) in brushes.iter().enumerate() {
            if !keep(b) {
                continue;
            }
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
    /// `contains` 线性扫描。
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
    /// 本三角形所属网格在 `World::tri_meshes` 里的下标。
    ///
    /// **诊断用途**：`World::collide_attrib` 靠它把命中归属报给 JS，再经
    /// `PhysWorld::debug_tri_mesh_name` 取到模型名。
    ///
    /// 之所以不用 `Rc` 指针反查：`mesh` 是 `Rc::new(mesh.clone())` 克隆出来的，
    /// 地址与 `World::tri_meshes` 里的原对象**必然不同**，按 `as_ptr` 比对永远失配。
    pub mesh_index: usize,
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
    /// 全部三角形条目：`build` 先 `clear` 再逐个压入，`query_indices` 返回下标的取值源。
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
        for (mesh_index, mesh) in meshes.iter().enumerate() {
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
                    mesh_index,
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
    /// 去重完全交给 `GridCells::query` 的 `epoch`：同一三角形在一次查询里至多回调一次，
    /// 因此这里**不再**做 `out.contains(&id)` 线性扫描（旧实现在候选多时是平方级开销）。
    /// `pub(crate)` 供 `brush_offset_tests` 验证跨多 cell 的三角形只出现一次。
    pub(crate) fn query_indices(&mut self, min: &V3, max: &V3, out: &mut Vec<usize>) {
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
}

// ---------------------------------------------------------------------------
// World（顶层容器）
// ---------------------------------------------------------------------------

/// 一份地图的碰撞数据 + 两套索引。
///
/// `solids` / `ladders` / `tri_meshes` 是权威数据（上游 `PhysWorld::build_world` 填充），
/// `static_grid` / `tri_grid` 是它们的索引副本。字段公开可写，但索引不会跟着变 ——
/// 改完这三个字段必须重跑 `World::build_index`（实体 brush 的位移是例外：走
/// `World::set_entity_offset`，直接写回 `solids`，不经网格）。
///
/// `trace` 与 `is_position_free` 取 `&mut self`：查询要推进 `GridCells` 的 `epoch`
/// 并复用内部缓冲。
pub struct World {
    pub solids: Vec<Brush>,
    pub ladders: Vec<LadderVolume>,
    pub tri_meshes: Vec<TriMesh>,
    /// 实体 brush 的当前碰撞状态（下标 = 实体枚举下标的 `Brush::entity`）。
    ///
    /// **权威状态**：`true` = 实心，参与碰撞；缺省/越界按实心处理（保守）。由
    /// `PhysWorld::build_world` 按 `start_solid` 初值填，运行期经
    /// [`World::set_entity_solid`] 切换。`solids` 始终保留全部 brush（静态网格只收
    /// 世界几何，实体 brush 由动态下标指向），查询时按这张表过滤——切换不需要重建
    /// 索引，也不移动砍掉的几何。
    pub entity_solid: Vec<bool>,
    /// 每个实体 brush 的当前位移（下标 = 实体枚举下标；缺省 `[0.0, 0.0, 0.0]`）。
    ///
    /// 运行期移动 brush（`func_movelinear` / `func_door` 等）按**实体**整体平移，
    /// 见 [`World::set_entity_offset`]；`solids` 里存的是「基准几何 + 当前位移」的副本。
    pub entity_offsets: Vec<V3>,
    /// `entity >= 0` 的 brush 在 `solids` 里的原始下标（`build_index` /
    /// `capture_base_solids` 现扫）。它们不进静态网格，每次查询按扫掠盒 AABB 现场过滤。
    pub(crate) dynamic_solid_indices: Vec<usize>,
    /// 动态 brush 的基准快照 `(solids 下标, 位移前几何)`，只含 `entity >= 0`。
    /// `set_entity_offset` 每次从它重算，避免逐帧累加漂移。`pub(crate)` 供
    /// `PhysWorld` 做「站在移动 brush 上的玩家随平台带走」判定
    /// （见 `PhysWorld::set_brush_offset`）。
    pub(crate) dynamic_base_solids: Vec<(usize, Brush)>,
    /// `ladders` 的基准快照（位移前），与 [`World::dynamic_base_solids`] 同口径：
    /// 只含 `entity >= 0` 的梯子，`set_entity_offset` 按绝对位移从它重算。
    pub(crate) dynamic_base_ladders: Vec<(usize, LadderVolume)>,
    /// 只索引 `entity < 0` 的世界几何；实体 brush 位移不触碰它。
    static_grid: BrushGrid,
    tri_grid: TriangleGrid,
    /// `trace` / `is_position_free` / `collide_attrib` 复用的候选下标缓冲
    /// （先 `mem::take` 借出、用完还回，避免每次查询分配）。
    scratch_brush_ids: Vec<usize>,
    scratch_tri_ids: Vec<usize>,
}

/// 单个三角形的命中归属（`World::collide_attrib` 报的第一个三角形命中）。
#[derive(Clone, Copy, Debug, Default)]
pub struct TriHit {
    /// 所属网格在 `World::tri_meshes` 里的下标（`TriEntry::mesh_index`，建索引时写入）。
    /// 名字经 `World::tri_mesh_name` / `PhysWorld::debug_tri_mesh_name` 取。
    pub mesh_index: usize,
    /// 该三角形在网格 `indices` 里的三个顶点下标。
    pub verts: [u32; 3],
    /// 该三角形的 AABB（`TriangleGrid::build` 入格时现算）。
    pub aabb: (V3, V3),
}

/// 盒体在给定位置的碰撞归属汇总（`World::collide_attrib` 的返回值）。
///
/// 字段语义：`free` 是 `!is_position_free` 的等价复述（由两个命中计数推出），
/// 两个 `*_hits` 是**逐个候选**判实心的数量，不是 broadphase 候选数。
#[derive(Clone, Copy, Debug, Default)]
pub struct CollideAttrib {
    /// 无任何碰撞体把该盒体判成实心 —— 等价于 `is_position_free` 返回 `true`。
    pub free: bool,
    /// 判该盒体实心的 brush 个数。
    pub brush_hits: usize,
    /// 判该盒体实心的三角形个数。
    pub tri_hits: usize,
    /// 第一个实心 brush 的 AABB。brush 不带名字（`Brush` 只有 `planes` / `min` / `max`），
    /// 归属靠 AABB 人工比对。
    pub first_brush_aabb: Option<(V3, V3)>,
    /// 第一个实心三角形的归属。
    pub first_tri: Option<TriHit>,
}

/// brush 当前是否参与碰撞：世界几何（`entity < 0`）恒实心；实体 brush 查
/// [`World::entity_solid`]，越界/未登记按实心（保守：宁可挡人也不让玩家穿墙）。
fn brush_is_active(brush: &Brush, entity_solid: &[bool]) -> bool {
    if brush.entity < 0 {
        return true;
    }
    entity_solid
        .get(brush.entity as usize)
        .copied()
        .unwrap_or(true)
}

/// 梯子当前是否可攀爬：与 [`brush_is_active`] 同口径（世界梯子恒可爬；实体梯子查
/// `entity_solid`，越界按可爬=保守，避免误判把正常梯子关掉）。
fn ladder_is_active(ladder: &LadderVolume, entity_solid: &[bool]) -> bool {
    if ladder.entity < 0 {
        return true;
    }
    entity_solid
        .get(ladder.entity as usize)
        .copied()
        .unwrap_or(true)
}

impl World {
    /// 空世界：三份数据为空、两套索引为空。索引要用 `World::build_index` 才建起来。
    pub fn new() -> Self {
        World {
            solids: Vec::new(),
            ladders: Vec::new(),
            tri_meshes: Vec::new(),
            entity_solid: Vec::new(),
            entity_offsets: Vec::new(),
            dynamic_solid_indices: Vec::new(),
            dynamic_base_solids: Vec::new(),
            dynamic_base_ladders: Vec::new(),
            static_grid: BrushGrid::new(),
            tri_grid: TriangleGrid::new(),
            scratch_brush_ids: Vec::new(),
            scratch_tri_ids: Vec::new(),
        }
    }

    /// 一次建齐两套索引：`BrushGrid` 用 `solids` 里 **`entity < 0`** 的世界几何与
    /// **512** 的 cell（`entity >= 0` 的实体 brush 只登记进
    /// `World::dynamic_solid_indices`，不进网格）；`TriangleGrid` 用 `tri_meshes` 与
    /// **256** 的 cell，且**只在 `tri_meshes` 非空时**才构建（空网格时 `trace` /
    /// `is_position_free` 也都不查三角索引）。
    ///
    /// 调用时机：`solids` / `ladders` / `tri_meshes` 赋值**之后**。索引是副本，此后改动
    /// 这三个字段必须重新调用才生效。`ladders` 不参与索引（`World::ladder_at` 线性扫描）。
    /// 本函数只读三个字段、只写索引与动态下标，不改几何。
    pub fn build_index(&mut self) {
        self.refresh_dynamic_indices();
        self.static_grid
            .build(&self.solids, |b| b.entity < 0, 512.0);
        if !self.tri_meshes.is_empty() {
            self.tri_grid.build(&self.tri_meshes, 256.0);
        }
    }

    /// 重新收集动态 brush 下标（`entity >= 0`）。`build_index` 与
    /// `capture_base_solids` 都调它：只建索引、不落基准的用法（如
    /// `brush_solid_tests` 的 `world_with`）也必须能查到实体 brush。
    fn refresh_dynamic_indices(&mut self) {
        self.dynamic_solid_indices.clear();
        for (i, b) in self.solids.iter().enumerate() {
            if b.entity >= 0 {
                self.dynamic_solid_indices.push(i);
            }
        }
    }

    /// 运行期切换某个实体 brush 的碰撞：`solid = true` 实心、`false` 可穿过。
    ///
    /// 参数 `entity` 是实体枚举下标（与 `Brush::entity`、GLB extras
    /// `vbsp_entity_index`、实体 I/O 事件里的下标同序）。越界时状态表按需扩容；
    /// 返回切换前的值（未登记/越界按实心 `true`）。
    ///
    /// 只改 [`World::entity_solid`]，不动 `solids` / 空间索引，所以**不需要重建索引**，
    /// 下一次 `trace` / `is_position_free` 立即生效。世界几何（`entity < 0`）不可切换。
    /// 消费方：`PhysWorld::set_brush_solid`（wasm 导出）← TS `EntityGameplay` 收 brush 事件后调用。
    pub fn set_entity_solid(&mut self, entity: usize, solid: bool) -> bool {
        if self.entity_solid.len() <= entity {
            self.entity_solid.resize(entity + 1, true);
        }
        let previous = self.entity_solid[entity];
        self.entity_solid[entity] = solid;
        previous
    }

    /// 把当前**动态** brush（`entity >= 0`）记成「位移基准」。
    fn capture_dynamic_base_solids(&mut self) {
        self.refresh_dynamic_indices();
        self.dynamic_base_solids.clear();
        for k in 0..self.dynamic_solid_indices.len() {
            let index = self.dynamic_solid_indices[k];
            let base = self.solids[index].clone();
            self.dynamic_base_solids.push((index, base));
        }
    }

    /// 把当前**动态**梯子（`entity >= 0`）记成「位移基准」。
    fn capture_dynamic_base_ladders(&mut self) {
        self.dynamic_base_ladders.clear();
        for (index, ladder) in self.ladders.iter().enumerate() {
            if ladder.entity >= 0 {
                self.dynamic_base_ladders.push((index, ladder.clone()));
            }
        }
    }

    /// 把当前**动态** brush / 梯子（`entity >= 0`）记成「位移基准」。装载完成、
    /// `build_index` 之后调用一次；之后 [`World::set_entity_offset`] 都从这份快照重算，
    /// 不依赖几何的现值。世界几何（`entity < 0`）不会移动，不进快照。
    pub fn capture_base_solids(&mut self) {
        self.capture_dynamic_base_solids();
        self.capture_dynamic_base_ladders();
    }

    /// 运行期平移某个实体的全部 brush（电梯 / 移动平台 / 可移动门）。
    ///
    /// `offset` 是相对**基准几何**的位移（绝对量，不是增量）：每次按
    /// `dynamic_base_solids` / `dynamic_base_ladders` 重算，所以反复调用不会累积
    /// 浮点误差。只动属于该实体的 brush / ladder（`entity` 字段匹配者）；
    /// 世界几何（`entity = -1`）不受影响。
    ///
    /// **不重建静态网格**：`entity >= 0` 的 brush 本就不在 `static_grid` 里，查询时按
    /// `dynamic_solid_indices` 现取（见 `World::collect_brush_candidates`），所以这里只写
    /// `solids`，下一次 `trace` / `is_position_free` 立即看到新位置；三角网格也不重建。
    ///
    /// 返回命中的 brush 数（0 = 该实体在本图没有实心 brush，调用方忽略即可）。
    /// 消费方：`PhysWorld::set_brush_offset`（wasm 导出）← TS 移动 brush 驱动每帧下发。
    pub fn set_entity_offset(&mut self, entity: i32, offset: V3) -> usize {
        if entity < 0 {
            return 0;
        }
        if self.dynamic_base_solids.is_empty() && self.solids.iter().any(|b| b.entity >= 0) {
            // 还没落基准（例如测试直接构造 World）：以当前几何为基准。
            self.capture_dynamic_base_solids();
        }
        if self.dynamic_base_ladders.is_empty() && self.ladders.iter().any(|l| l.entity >= 0) {
            // 只有实体梯子而无动态 solid 时也要独立建立梯子基准。
            self.capture_dynamic_base_ladders();
        }
        let entity_index = entity as usize;
        if self.entity_offsets.len() <= entity_index {
            self.entity_offsets.resize(entity_index + 1, [0.0; 3]);
        }
        self.entity_offsets[entity_index] = offset;
        let mut moved = 0usize;
        for (index, base) in &self.dynamic_base_solids {
            if base.entity != entity {
                continue;
            }
            moved += 1;
            // 平移凸体：AABB 直接加 offset；平面 `dot(n, p) = dist` 平移后
            // `dot(n, p - offset) = dist` ⇒ `dist += dot(n, offset)`。
            let mut brush = base.clone();
            brush.min = [
                base.min[0] + offset[0],
                base.min[1] + offset[1],
                base.min[2] + offset[2],
            ];
            brush.max = [
                base.max[0] + offset[0],
                base.max[1] + offset[1],
                base.max[2] + offset[2],
            ];
            for plane in &mut brush.planes {
                plane.dist += plane.normal[0] * offset[0]
                    + plane.normal[1] * offset[1]
                    + plane.normal[2] * offset[2];
            }
            self.solids[*index] = brush;
        }
        // 梯子也随所属实体一起平移（门的 LADDER 面、移动平台上的梯子等）：
        // 与 solids 同口径从动态基准快照重算，避免累加漂移。
        for (index, base) in &self.dynamic_base_ladders {
            if base.entity != entity {
                continue;
            }
            let mut ladder = base.clone();
            ladder.min = [
                base.min[0] + offset[0],
                base.min[1] + offset[1],
                base.min[2] + offset[2],
            ];
            ladder.max = [
                base.max[0] + offset[0],
                base.max[1] + offset[1],
                base.max[2] + offset[2],
            ];
            for plane in &mut ladder.planes {
                plane.dist += plane.normal[0] * offset[0]
                    + plane.normal[1] * offset[1]
                    + plane.normal[2] * offset[2];
            }
            self.ladders[*index] = ladder;
        }
        moved
    }

    /// 收集查询盒 `[s_min, s_max]` 命中的 brush 下标（超集）到 `scratch_brush_ids`。
    ///
    /// 静态部分由 `static_grid` 给出（只含 `entity < 0`，与 cell 相交即候选）；动态
    /// brush 不在网格里，逐条按**与 `trace_box_iter` 内层完全相同**的 AABB 分离判据过滤，
    /// 并跳过被 `entity_solid` 关掉的。因此这份候选是任何全量遍历的超集：这里保留的
    /// brush 才可能在精判里命中，这里跳过的在精判里也必然被跳过。
    fn collect_brush_candidates(&mut self, s_min: &V3, s_max: &V3) {
        let mut ids = std::mem::take(&mut self.scratch_brush_ids);
        self.static_grid.query_indices(s_min, s_max, &mut ids);
        for &index in &self.dynamic_solid_indices {
            let brush = &self.solids[index];
            if !brush_is_active(brush, &self.entity_solid)
                || brush.min[0] > s_max[0]
                || brush.max[0] < s_min[0]
                || brush.min[1] > s_max[1]
                || brush.max[1] < s_min[1]
                || brush.min[2] > s_max[2]
                || brush.max[2] < s_min[2]
            {
                continue;
            }
            ids.push(index);
        }
        self.scratch_brush_ids = ids;
    }

    /// 收集查询盒命中的三角形下标（超集）到 `scratch_tri_ids`；调用方保证
    /// `tri_meshes` 非空（此时索引也只在非空时建立）。
    fn collect_tri_candidates(&mut self, s_min: &V3, s_max: &V3) {
        let mut ids = std::mem::take(&mut self.scratch_tri_ids);
        self.tri_grid.query_indices(s_min, s_max, &mut ids);
        self.scratch_tri_ids = ids;
    }

    /// 扫掠盒追踪：brush 与三角网格两条线各取候选，返回更早的那次命中。
    ///
    /// 流程：① `sweep_bounds` 把扫掠运动外扩成查询盒 `[s_min, s_max]`；
    /// ② 静态网格 + 动态 brush 取候选得 `brush_result`；③ 仅当 `tri_meshes` 非空时
    /// 再取三角候选得 `tri_result`，**严格小于**才改判为三角命中 —— 两者同分时取
    /// brush；④ 无三角网格时直接返回 brush 结果。
    ///
    /// 参数与返回语义同 `trace_box`（`fraction`、`end_pos`、`normal`、`start_solid` /
    /// `all_solid`）。需要 `&mut self` 是因为查询会推进 `epoch` 并复用内部缓冲。
    /// 本函数不移动任何东西，也只返回**单个**最早命中（不返回命中列表）。
    pub fn trace(&mut self, start: &V3, end: &V3, mins: &V3, maxs: &V3) -> TraceResult {
        let (s_min, s_max) = sweep_bounds(start, end, mins, maxs);
        self.collect_brush_candidates(&s_min, &s_max);
        let brush_ids = std::mem::take(&mut self.scratch_brush_ids);
        let brush_result = trace_box_indices(start, end, mins, maxs, &self.solids, &brush_ids);

        // 三角网格同理；只有更早（严格小于）才覆盖 brush 结果
        if !self.tri_meshes.is_empty() {
            self.collect_tri_candidates(&s_min, &s_max);
            let tri_ids = std::mem::take(&mut self.scratch_tri_ids);
            let tri_result =
                trace_box_tri_indices(start, end, mins, maxs, &self.tri_grid.entries, &tri_ids);
            self.scratch_tri_ids = tri_ids;
            if tri_result.fraction < brush_result.fraction {
                self.scratch_brush_ids = brush_ids;
                return tri_result;
            }
        }
        self.scratch_brush_ids = brush_ids;
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

        self.collect_brush_candidates(&q_min, &q_max);
        let brush_ids = std::mem::take(&mut self.scratch_brush_ids);
        let mut free =
            !trace_box_indices(origin, origin, mins, maxs, &self.solids, &brush_ids).start_solid;
        if free && !self.tri_meshes.is_empty() {
            self.collect_tri_candidates(&q_min, &q_max);
            let tri_ids = std::mem::take(&mut self.scratch_tri_ids);
            free = !trace_box_tri_indices(
                origin,
                origin,
                mins,
                maxs,
                &self.tri_grid.entries,
                &tri_ids,
            )
            .start_solid;
            self.scratch_tri_ids = tri_ids;
        }
        self.scratch_brush_ids = brush_ids;
        free
    }

    /// 归属诊断：给定盒体位置，报"哪些碰撞体把它判成实心"。
    ///
    /// 与 [`World::is_position_free`] 的**判决谓词完全一致** —— 它同样是逐个候选单独调
    /// `trace_box_iter` / `trace_box_tri_iter` 并看 `start_solid`，只是每次只传一个候选。
    /// 谓词一致是刻意的：若这里改用 `box_in_brush` 之类另一套判定，报出的归属可能与
    /// `is_position_free` 的实际判决对不上，那这份诊断就不可信了。
    ///
    /// 代价是 O(候选数) 次扫掠而非 1 次 —— **仅供诊断调用**，`is_position_free` 的热路径
    /// 不经过它。
    ///
    /// 宽phase 的候选查询盒沿用 `is_position_free` 的 ±1.0 膨胀，保证候选集相同。
    pub fn collide_attrib(&mut self, origin: &V3, mins: &V3, maxs: &V3) -> CollideAttrib {
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
        let mut out = CollideAttrib::default();

        // 候选已按实体碰撞状态过滤（collect_brush_candidates），这里逐条精判。
        self.collect_brush_candidates(&q_min, &q_max);
        let brush_ids = std::mem::take(&mut self.scratch_brush_ids);
        for &index in &brush_ids {
            let b = &self.solids[index];
            if trace_box_iter(origin, origin, mins, maxs, std::iter::once(b)).start_solid {
                out.brush_hits += 1;
                if out.first_brush_aabb.is_none() {
                    out.first_brush_aabb = Some((b.min, b.max));
                }
            }
        }
        self.scratch_brush_ids = brush_ids;

        if !self.tri_meshes.is_empty() {
            self.collect_tri_candidates(&q_min, &q_max);
            let tri_ids = std::mem::take(&mut self.scratch_tri_ids);
            for &index in &tri_ids {
                let e = &self.tri_grid.entries[index];
                if trace_box_tri_iter(origin, origin, mins, maxs, std::iter::once(e)).start_solid {
                    out.tri_hits += 1;
                    if out.first_tri.is_none() {
                        out.first_tri = Some(TriHit {
                            mesh_index: e.mesh_index,
                            verts: [e.a, e.b, e.c],
                            aabb: (
                                [e.min_x, e.min_y, e.min_z],
                                [e.max_x, e.max_y, e.max_z],
                            ),
                        });
                    }
                }
            }
            self.scratch_tri_ids = tri_ids;
        }
        out.free = out.brush_hits == 0 && out.tri_hits == 0;
        out
    }

    /// 盒（盒心 `origin` + 偏移 `mins` / `maxs`）命中的**第一个**梯子下标，无命中返回 `None`。
    ///
    /// 逐个梯子调 `box_in_brush`，只用 `planes`（不看梯子的 AABB）。`ladders` 不在任何
    /// 空间索引里，这里是按数据顺序的线性扫描：多个梯子重叠时返回下标最小者。
    ///
    /// **按实体碰撞状态过滤**：实体 brush（如 `func_door`）里的 LADDER 面在实体被隐藏/
    /// 设为非实心后不可再攀爬（否则会有「看不见却能挂上去」的隐形梯）。
    ///
    /// 返回下标而不是引用，是为了让调用方（`player::check_ladder`）能在拿到结果后继续
    /// 以 `&mut world` 走移动流程；它再用下标去取 `facing` / `facing_toward`。
    pub fn ladder_at(&self, origin: &V3, mins: &V3, maxs: &V3) -> Option<usize> {
        for (i, ladder) in self.ladders.iter().enumerate() {
            if !ladder_is_active(ladder, &self.entity_solid) {
                continue;
            }
            if box_in_brush(origin, mins, maxs, &ladder.planes) {
                return Some(i);
            }
        }
        None
    }
}
