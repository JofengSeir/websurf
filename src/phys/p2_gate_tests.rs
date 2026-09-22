//! 坡顶幽灵面回归（4 项）：`world::trace_box` 对坡形 brush 的扫掠结果。
//!
//! 文件保护的不变量：坡形 brush 在"端帽""起始实心""贴顶悬停滑行"三种姿态下都不产生
//! 假命中，而合法的表面落地必须保留。三项断言"无命中"（`fraction == 1.0`，其中一项
//! 同时断言 `start_solid` / `all_solid` 为 false），一项断言 `fraction < 1.0`。
//!
//! 钉住的 `world.rs` 语义：
//! - `trace_box` 先做宽阶段候选过滤 —— 按 brush AABB 与扫掠盒 AABB 的三轴分离剔除
//!   （`pad = 1.0`），再对留下的 brush 走 `clip_planes` 的平面裁剪；
//! - `clip_planes` 的盒-AABB 门（`aabb_overlaps_at`）：进入平面在真实接触分数 `f_true`
//!   处若与本 brush 的 AABB 三轴分离，就只跳过该平面（逐平面否决，保留更晚的真实接触，
//!   不做整实体否决）；"起点在体内"同样过门，分离即不判 `start_solid` / `all_solid`；
//!   两处否决都自增 `world::GATE_VETO_COUNT`；
//! - 该判据只在"分离"时下否决结论 —— 分离的 AABB 必不相交，而重叠并不等于相交，
//!   所以它不用于确认命中，只用于剔除假进入（真实进入由 `enter_frac` 与
//!   `leave_frac` 的比较决定）。
//!
//! 四个用例实际走到的路径（逐个按 `trace_box` 的宽阶段条件核算，并用
//! `gate_veto_count()` 的增量复核）：
//! - `p2_endcap_phantom_vetoed`、`p2_start_solid_phantom_vetoed`：盒 AABB 与坡 AABB
//!   在 y 轴分离，宽阶段已把 brush 整体剔除，`clip_planes` 不被调用 —— 这两项
//!   **不经过盒-AABB 门**，否决计数增量为 0；
//! - `p2_hover_glide_edge_phantom_vetoed`：唯一走到逐平面门的用例（悬停间隙 0.03
//!   大于门容差 `DIST_EPSILON / 8`），否决计数在此自增 1；
//! - `p2_surface_landing_kept`：真实表面进入被保留。
//!
//! 夹具：`ramp()` 与 `apps/game/scripts/phys-p2-regression.mjs` 的
//! `rampDown(0, 1500, 3000)` 逐字段同参数；`p2_endcap_phantom_vetoed` 的线段与
//! `apps/game/scripts/phys-gate-probe2.mjs` 的 `debug_trace` 调用参数逐字相同，
//! 长度恰为一次 64Hz 步进（Δz = 4.6875 = 300 × 1/64）。四个用例的盒子一律取站立箱
//! `[-16, 0, -16] / [16, 72, 16]`，直接调 `trace_box(&start, &end, &mins, &maxs, &[&Brush])`，
//! 不经 `World` 的空间索引。

use crate::phys::world::{Plane, Brush, trace_box};

/// `Plane` 的简写构造：`dist` 是面沿外法线的偏移（实体侧 `dot(normal, p) <= dist`，
/// 由 `clip_planes` 里的 `d1 = dot(normal, start) - dist` 判据可见）。
fn p(n: [f64; 3], d: f64) -> Plane {
    Plane { normal: n, dist: d }
}

/// 60° 坡：法线 `(0, 0.5, 0.8660254037844386)`，表面 `y = -z·tan60°`，实体侧
/// `0.5y + 0.866z <= 0`。与 `apps/game/scripts/phys-p2-regression.mjs` 的
/// `rampDown(0, 1500, 3000)` 同参数：六个平面依次是坡面 / 底面 / ±x 侧墙 /
/// z = 0 处的端帽平面（法线 `[0, 0, -1]`、`dist = 0`）/ z = 1500 的闭合面，
/// AABB 为 `[-4000, -3000, 0] .. [4000, 0, 1500]`。
/// 端帽平面是三项"幽灵面"用例要越过的那个无限平面边界。
fn ramp() -> Brush {
    let cos = 0.5f64;
    let sin = 0.8660254037844386f64;
    Brush {
        planes: vec![
            p([0.0, cos, sin], 0.0),      // 表面
            p([0.0, -1.0, 0.0], 3000.0),  // 底
            p([1.0, 0.0, 0.0], 4000.0),   // +x
            p([-1.0, 0.0, 0.0], 4000.0),  // -x
            p([0.0, 0.0, -1.0], 0.0),     // z=0 端盖（P2 幻影平面）
            p([0.0, 0.0, 1.0], 1500.0),   // +z 闭合
        ],
        min: [-4000.0, -3000.0, 0.0],
        max: [4000.0, 0.0, 1500.0],
    }
}

/// 端帽幽灵面：坡在 z = 0 处的端帽平面不产生命中（`fraction` 保持 1.0）。
/// 线段取自 `apps/game/scripts/phys-gate-probe2.mjs` 的 `debug_trace` 调用
/// （64Hz、H = 2.5、vz = 300 的第三个 tick）。
#[test]
fn p2_endcap_phantom_vetoed() {
    // 本线段全程盒底 y ∈ [1.62, 2.11]，坡 AABB 上界 y = 0，两 AABB 在 y 轴分离
    // （含宽阶段的 pad = 1.0）→ 端帽平面根本没有被评估的机会。
    let start = [0.0, 2.109375, -20.625];
    let end = [0.0, 1.62109375, -15.9375];
    let mins = [-16.0, 0.0, -16.0];
    let maxs = [16.0, 72.0, 16.0];

    let brushes = [ramp()];
    let r = trace_box(&start, &end, &mins, &maxs, &brushes.iter().collect::<Vec<_>>());
    // 期望：无命中。盒底始终高于坡顶（y = 0），端帽不构成接触。
    assert_eq!(
        r.fraction, 1.0,
        "门校验应否决端盖幻影进入，实际 fraction={} normal={:?}",
        r.fraction, r.normal
    );
}

/// 合法表面落地必须保留：盒从坡面上方降入表面半空间，命中处盒 AABB 与坡 AABB 三轴重叠，
/// 盒-AABB 门放行，因此 `fraction < 1.0`。这条是三项"幽灵面"用例的对照 ——
/// 门只在 AABB 分离时否决，不否决真实接触。
#[test]
fn p2_surface_landing_kept() {
    // 起点在坡上方（y = -20，坡面在 z = 30 处约 y = -51.96），终点越过坡面。
    let start = [0.0, -20.0, 30.0];
    let end = [0.0, -26.0, 30.5];
    let mins = [-16.0, 0.0, -16.0];
    let maxs = [16.0, 72.0, 16.0];

    let brushes = [ramp()];
    let r = trace_box(&start, &end, &mins, &maxs, &brushes.iter().collect::<Vec<_>>());
    assert!(
        r.fraction < 1.0,
        "合法表面接触不应被否决，实际 fraction={}",
        r.fraction
    );
}

/// 起始实心幽灵面：盒只刺入 z >= 0 半空间 0.0625（盒 z_max = -15.9375 + 16），
/// 而盒底 y = 1.621 与坡 AABB 上界 y = 0 分离 —— 宽阶段过滤直接剔除该 brush，
/// 于是既不产生命中，也不会被判 `start_solid` / `all_solid`
/// （后两者在 `try_player_move` 里会把速度清零并钉住盒子）。
#[test]
fn p2_start_solid_phantom_vetoed() {
    // 这是上一个用例线段的终点起步、再走一步的下一 tick。
    let start = [0.0, 1.62109375, -15.9375];
    let end = [0.0, 1.03515625, -11.25];
    let mins = [-16.0, 0.0, -16.0];
    let maxs = [16.0, 72.0, 16.0];

    let brushes = [ramp()];
    let r = trace_box(&start, &end, &mins, &maxs, &brushes.iter().collect::<Vec<_>>());
    assert!(
        !r.start_solid && !r.all_solid && r.fraction == 1.0,
        "start_solid 幻影应被 AABB 门否决，实际 start_solid={} all_solid={} fraction={}",
        r.start_solid, r.all_solid, r.fraction
    );
}

/// 贴顶悬停滑行的端帽进入：盒底 y = 0.03 沿平台顶悬停滑行，前端（z_max）越过坡的
/// z = 0 端帽平面。端帽的真实接触分数处，盒 AABB 与坡 AABB 在 y 轴分离 0.03，
/// 大于门容差 `DIST_EPSILON / 8`（= 0.00390625）→ 判分离，跳过该端帽平面，
/// `fraction` 保持 1.0。四个用例里只有这条真正走到盒-AABB 门：否决计数在此自增 1。
/// 盒底 y 是 0.03，而 `DIST_EPSILON` 是 0.03125 —— 两者不是同一个量，
/// 门吸收的是浮点误差（`DIST_EPSILON / 8`），不是悬停间隙本身。
#[test]
fn p2_hover_glide_edge_phantom_vetoed() {
    // 盒底与坡顶齐平的悬停间隙：0.03 小于 `DIST_EPSILON`，却大于门容差。
    let start = [0.0, 0.03, -25.0];
    let end = [0.0, 0.03, -10.0];
    let mins = [-16.0, 0.0, -16.0];
    let maxs = [16.0, 72.0, 16.0];

    let brushes = [ramp()];
    let r = trace_box(&start, &end, &mins, &maxs, &brushes.iter().collect::<Vec<_>>());
    assert_eq!(
        r.fraction, 1.0,
        "悬停滑行盒对坡前缘的端盖进入应在 f_true 处被否决（y 分离 0.03），实际 fraction={}",
        r.fraction
    );
}