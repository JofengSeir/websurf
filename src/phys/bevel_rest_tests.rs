//! BSP 原生 bevel 承担「刀刃脊可站」的回归（2 项）：停靠面由 bevel 决定。
//!
//! 背景（owner 裁决，见 `TODO.md T-501` §9）：wasm 导出层曾剔除
//! `side.bevel != 0` 的 BSP 原生 bevel side、改由运行时合成过棱切角平面承担
//! 「盒停在刀刃脊顶」；该合成机制已整段撤除，平面表回到「真实面 + 原生 bevel」。
//! 本文件用**手搓 brush**钉住机器可验证的证据：
//!
//! - 夹具 = 两张 52° 斜面相交的刀刃脊（单张面 `n.y = 0.616 < STANDABLE_NORMAL`，
//!   与 `surf_666` 的五棱柱屋面同角度），外加一张**原生 bevel 平面**——法线
//!   `(0, 1, 0)`、恰好过脊线（正是起源编译器为"盒子别卡在棱上"生成的过棱小平面）。
//! - 第 1 项：带 bevel 下探，整箱停在**脊顶**（盒底 y = 脊高，误差浮点级），
//!   接触法线是 bevel 的 `(0, 1, 0)`——停靠面由 bevel 决定。
//! - 第 2 项（撤掉 bevel 必 FAIL 的对照）：同一夹具去掉那张 bevel 平面，整箱停在
//!   脊线**上方约 20.5 HU**（`= 16·tan52°`，盒按逐平面扩张的假想面提前停住、
//!   虚浮在脊顶之上），最陡接触面变回 52° 斜面。第 1 项与第 2 项是同一场景
//!   ± bevel 的成对断言——若有人把 bevel 从平面表里再剔掉，第 1 项即失败。
//!
//! 机理一句：纯平面扩张（盒按各自平面的支撑偏移外推）得到的"扩张凸包"是
//! **过近似**——它缺掉 Minkowski 和在棱上新增的 bevel 面，盒在脊上按斜面
//! 的扩张面提前触停。原生 bevel 平面补的正是这些棱面（`world.rs` 的 `trace_box`
//! 按逐平面扩张做整箱扫掠，故 bevel 平面必须**在平面表里**才生效）。
//!
//! 只用 `world::trace_box`（与 `ridge_contact_tests` 同约定）：站立判据本身由
//! `ridge_contact_tests` 钉住，本文件钉的是**碰撞平面表的来源**。

use crate::phys::world::{trace_box, Brush, Plane};

/// `Plane` 的简写构造，与 `ridge_contact_tests` 同约定：实体侧 `dot(normal, p) <= dist`。
fn p(n: [f64; 3], d: f64) -> Plane {
    Plane { normal: n, dist: d }
}

/// 脊高与半宽，取值沿用 `ridge_contact_tests` 的量级。
const H: f64 = 512.0;
const X: f64 = 512.0;
const Z: f64 = 512.0;
const BOTTOM: f64 = -400.0;

/// 斜面外法线的水平 / 垂直分量（52°：`sin52 = 0.7880`、`cos52 = 0.6157 < 0.7`）。
const SLAB_SIN: f64 = 0.7880107536067220;
const SLAB_COS: f64 = 0.6156614753256583;

/// 盒半宽：虚浮深度 = `X_HALF · tan52° ≈ 20.5 HU`。
const X_HALF: f64 = 16.0;

/// 刀刃脊 brush（`with_bevel = true` 时附一张过脊线的原生 bevel 平面）。
///
/// 几何与 `ridge_contact_tests::ridge` 同构：脊线沿 z、位于 `x = 0`、`y = H`，实体在脊下。
/// bevel 平面 `dot((0,1,0), q) <= H` 的半空间与两张斜面的交集在脊下方完全重合，
/// **不放大实体体积**——这正是 bevel 只补"过棱接触"不补体积的性质。
fn tent(with_bevel: bool) -> Brush {
    let mut planes = vec![
        p([SLAB_SIN, SLAB_COS, 0.0], SLAB_COS * H),  // +x 侧斜面
        p([-SLAB_SIN, SLAB_COS, 0.0], SLAB_COS * H), // -x 侧斜面
        p([0.0, -1.0, 0.0], -BOTTOM),                // 底面（实体在 y >= BOTTOM）
        p([1.0, 0.0, 0.0], X),                       // +x 端
        p([-1.0, 0.0, 0.0], X),                      // -x 端
        p([0.0, 0.0, -1.0], Z),                      // -z 端
        p([0.0, 0.0, 1.0], Z),                       // +z 端
    ];
    if with_bevel {
        // BSP 原生 bevel side 的形状：法线竖直、恰好过脊线（脊上顶点都在面上）。
        planes.push(p([0.0, 1.0, 0.0], H));
    }
    Brush {
        planes,
        // AABB 取 `ridge_contact_tests` 同款的上余量：真实最高点是脊本身，
        // AABB 收到恰等脊高会让"盒底落在脊上"在宽阶段被当成无限平面假进入否决。
        min: [-X, BOTTOM, -Z],
        max: [X, H + 400.0, Z],
    }
}

/// 盒底从脊上方 100 HU 垂直下探到脊下方 100 HU，返回追踪结果。
fn drop_on_tent(with_bevel: bool) -> crate::phys::world::TraceResult {
    let mins = [-X_HALF, 0.0, -X_HALF];
    let maxs = [X_HALF, 72.0, X_HALF];
    let start = [0.0, H + 100.0, 0.0];
    let end = [0.0, H - 100.0, 0.0];
    let brushes = [tent(with_bevel)];
    trace_box(
        &start,
        &end,
        &mins,
        &maxs,
        &brushes.iter().collect::<Vec<_>>(),
    )
}

/// 带 bevel：整箱停在脊顶，接触法线是 bevel 的 `(0,1,0)`。
///
/// 若有人把 bevel 从碰撞平面表里剔除（回到旧口径），本条即失败。
#[test]
fn bevel_plane_decides_the_rest_face_on_a_knife_ridge() {
    let r = drop_on_tent(true);
    assert!(
        r.fraction < 1.0,
        "垂直下探必然命中，实际 fraction={}",
        r.fraction
    );
    // 盒底停在脊顶：end y（盒底）= H。实测落在 1/32 HU 的量化格上（512.03125）。
    let bottom = r.end_pos[1];
    assert!(
        (bottom - H).abs() < 0.05,
        "带 bevel 时盒底应停在脊顶 y={H}，实际 {bottom}",
    );
    // 停靠法线是 bevel 的竖直面，不是 52° 斜面。
    let n = r.normal.expect("命中后必须有接触法线");
    assert!(
        (n[1] - 1.0).abs() < 1e-6,
        "停靠面应是 bevel 的 (0,1,0)，实际 {:?}",
        n
    );
    // 被采纳的接触面就是 bevel（最陡 = 被采纳那张 = 竖直）。
    let s = r.steepest_normal.expect("命中后必须有最陡面法线");
    assert!(
        (s[1] - 1.0).abs() < 1e-6,
        "带 bevel 时最陡接触面应是 bevel 自身，实际 {:?}",
        s
    );
}

/// 撤掉 bevel 的对照：整箱按斜面的扩张面提前停住，盒底虚浮在脊线上方约
/// `16·tan52° ≈ 20.5 HU`，最陡接触面变回 52° 斜面。
///
/// 本条与上一条是同一场景 ± bevel 的成对断言；停位差 ≈ 20.5 HU 就是
/// "停靠面由 bevel 决定"的直接量度。
#[test]
fn without_the_bevel_plane_the_box_floats_above_the_ridge() {
    let r = drop_on_tent(false);
    assert!(r.fraction < 1.0);
    let bottom = r.end_pos[1];
    let float = bottom - H;
    assert!(
        float > 16.0,
        "撤掉 bevel 后盒底应虚浮在脊线上方（实测 {float:+.2} HU）",
    );
    // 最陡接触面回到 52° 斜面：bevel 不在平面表里，停靠不再由它决定。
    let s = r.steepest_normal.expect("命中后必须有最陡面法线");
    assert!(
        (s[1] - SLAB_COS).abs() < 1e-6,
        "撤掉 bevel 后最陡接触面应是 52° 斜面，实际 {:?}",
        s
    );
}
