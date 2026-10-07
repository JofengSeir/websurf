//! `.phy` 凸体补面（`phys::hull_bevels`）回归（3 项）：VBSP `AddBrushBevels` 的两类面
//! 决定盒在模型尖脊上的停靠；撤掉生成即回到「按斜面扩张提前触停」的虚浮停位。
//!
//! 夹具全部手搓（不依赖真实地图），做法与 `bevel_rest_tests` 同约定：**只走 `world::trace_box`**
//! （与 `ridge_contact_tests` 同一条凸体平面表追踪路径），所以这三项钉的是「模型凸体的平面表
//! 该长什么样」，而不是站立判据本身（站立判据由 `ridge_contact_tests` 钉住）。
//!
//! - 第 1 项：**水平**刀刃脊（52° 两张斜面 + 两端 + 底面的三棱柱）。凸体自己没有水平顶面，
//!   故 VBSP 的 box bevel 会补上 AABB 顶面 `(0,1,0)`——盒停在**脊线**上、法线 `(0,1,0)`；
//!   只给真实面时盒按斜面扩张面提前停住，虚浮 `16·tan52° ≈ 20.5 HU`。两项成对，撤掉生成即 FAIL。
//! - 第 2 项：**斜**脊（同一夹具沿 z 做仿射剪切，脊线沿 z 下行 ⇒ 各面仍是平面、凸体成立）。
//!   此时 AABB 顶面在脊线之上、不 binding，真正接住盒的是**过脊线的 edge bevel**
//!   （法线 `normalize(cross(脊线方向, 轴))`，即 VBSP 的斜切轴面）——这正是 `s1_ramp1b`
//!   「被两边斜坡面影响」的病灶面：`s1_ramp1b` 的各块 AABB 顶面全在脊线以上。
//! - 第 3 项：**纯轴向**凸体（长方体）不该生成任何补面（VBSP 对 `numsumsides == 6` 直接 return），
//!   防止生成器变成「无脑灌面」。
//!
//! 量化对照（本轮实测，`surf_666` 的 `s1_ramp1b` z=−9900 那块）：只给真实面 ⇒ 虚浮 20.65 HU、
//! 法线 `n_y = 0.612`（不可站）；加 VBSP 平面表 ⇒ 停在脊线（虚浮 0.00 HU）、法线 `n_y = 0.996`。

use crate::phys::hull_bevels::{face_planes, hull_bevels};
use crate::phys::world::{trace_box, Brush, Plane, TraceResult, V3};

/// 脊高、半长（沿 z）、底面高度：沿用 `bevel_rest_tests` 的量级。
const H: f64 = 512.0;
const Z: f64 = 512.0;
const BOTTOM: f64 = -400.0;

/// 52° 斜面的外法线分量（`sin52 = 0.7880`、`cos52 = 0.6157 < 0.7` ⇒ 单张斜面不可站）。
const SLAB_SIN: f64 = 0.7880107536067220;
const SLAB_COS: f64 = 0.6156614753256583;

/// 斜脊沿 z 的下行量（第 2 项）：脊从 `z = -Z` 的 `y = H` 降到 `z = +Z` 的 `y = H - DROP`。
const DROP: f64 = 200.0;

/// 盒半宽（虚浮深度 = `16·tan52° ≈ 20.5 HU`）。
const X_HALF: f64 = 16.0;

/// 三棱柱夹具的顶点：脊线在 `x = 0`、底面在 `y = BOTTOM`。
///
/// `drop` 为 0 时是水平脊；非 0 时把 `+z` 端整端下沉 `drop`（对 z 的仿射剪切）——各面仍是
/// 平面、凸体仍然成立，脊线沿 z 下行。
fn prism_vertices(drop: f64) -> Vec<V3> {
    // 让两张斜面恰成 52°：底面处斜面离脊线的水平距离由平面方程解出。
    let x_base = SLAB_COS * (H - BOTTOM) / SLAB_SIN;
    vec![
        [-x_base, BOTTOM, -Z],        // 0 A
        [x_base, BOTTOM, -Z],         // 1 B
        [0.0, H, -Z],                 // 2 C（脊的 -z 端）
        [-x_base, BOTTOM - drop, Z],  // 3 D
        [x_base, BOTTOM - drop, Z],   // 4 E
        [0.0, H - drop, Z],           // 5 F（脊的 +z 端）
    ]
}

/// 三棱柱的 8 个三角形（闭合凸包；绕序无关，`hull_bevels` 用质心定向）。
const PRISM_TRIS: [[u32; 3]; 8] = [
    [0, 1, 2], // -z 端
    [3, 4, 5], // +z 端
    [1, 2, 5], // +x 斜面
    [1, 5, 4],
    [0, 2, 5], // -x 斜面
    [0, 5, 3],
    [0, 1, 4], // 底面
    [0, 4, 3],
];

/// 由顶点集造 brush：`with_bevels = false` 时只给真实面（撤掉生成的对照口径）。
///
/// AABB 的 y 上界取「最高顶点 + 400」：与 `bevel_rest_tests` 同款——AABB 收到恰等脊高会让
/// 「盒底落在脊上」在宽阶段被当成无限平面假进入否决。
fn brush_of(vertices: &[V3], tris: &[[u32; 3]], with_bevels: bool) -> Brush {
    let planes: Vec<Plane> = if with_bevels {
        hull_bevels(vertices, tris).planes()
    } else {
        face_planes(vertices, tris)
    };
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for v in vertices {
        for i in 0..3 {
            if v[i] < min[i] {
                min[i] = v[i];
            }
            if v[i] > max[i] {
                max[i] = v[i];
            }
        }
    }
    max[1] += 400.0;
    Brush { planes, min, max }
}

/// 盒从脊上方 200 HU 垂直下探到脊下方 200 HU（`crest` = 盒正下方脊线的高度）。
fn drop_on(vertices: &[V3], tris: &[[u32; 3]], crest: f64, with_bevels: bool) -> TraceResult {
    let mins = [-X_HALF, 0.0, -X_HALF];
    let maxs = [X_HALF, 72.0, X_HALF];
    let start = [0.0, crest + 200.0, 0.0];
    let end = [0.0, crest - 200.0, 0.0];
    let brushes = [brush_of(vertices, tris, with_bevels)];
    trace_box(
        &start,
        &end,
        &mins,
        &maxs,
        &brushes.iter().collect::<Vec<_>>(),
    )
}

/// 水平刀刃脊：box bevel（AABB 顶面）承担停靠，盒停在脊线上、法线 `(0,1,0)`；
/// 撤掉生成则虚浮在脊线上方 `16·tan52° ≈ 20.5 HU`、最陡面回到 52° 斜面。
#[test]
fn horizontal_knife_ridge_rests_on_the_generated_box_bevel() {
    let v = prism_vertices(0.0);
    let bevels = hull_bevels(&v, &PRISM_TRIS);
    // 凸体自己没有水平顶面 ⇒ 必须补出 AABB 顶面 (0,1,0)、dist = 脊高。
    assert!(
        bevels.box_added >= 1,
        "水平刀刃脊应补出 AABB 顶面，实际 box_added={}",
        bevels.box_added
    );
    assert!(
        bevels
            .planes()
            .iter()
            .any(|p| p.normal == [0.0, 1.0, 0.0] && (p.dist - H).abs() < 1e-6),
        "补出的平面表里应含 (0,1,0)、dist={H} 的 AABB 顶面",
    );

    let with = drop_on(&v, &PRISM_TRIS, H, true);
    assert!(with.fraction < 1.0, "垂直下探必然命中");
    let bottom = with.end_pos[1];
    assert!(
        (bottom - H).abs() < 0.05,
        "带生成补面时盒底应停在脊顶 y={H}，实际 {bottom}",
    );
    let n = with.normal.expect("命中后必须有接触法线");
    assert!(
        (n[1] - 1.0).abs() < 1e-6,
        "停靠面应是 AABB 顶面 (0,1,0)，实际 {n:?}",
    );

    let without = drop_on(&v, &PRISM_TRIS, H, false);
    assert!(without.fraction < 1.0);
    let float = without.end_pos[1] - H;
    assert!(
        float > 16.0,
        "撤掉生成后盒底应虚浮在脊线上方（实测 {float:+.2} HU）",
    );
    let s = without.steepest_normal.expect("命中后必须有最陡面法线");
    assert!(
        (s[1] - SLAB_COS).abs() < 1e-6,
        "撤掉生成后最陡接触面应是 52° 斜面，实际 {s:?}",
    );
}

/// 斜脊：AABB 顶面在脊线之上不 binding，真正接住盒的是过脊线的 edge bevel。
#[test]
fn inclined_ridge_rests_on_the_generated_edge_bevel_at_the_crest() {
    let v = prism_vertices(DROP);
    let crest = H - DROP / 2.0; // 脊线在 z = 0 处的高度（线性下行）
    let bevels = hull_bevels(&v, &PRISM_TRIS);

    // 斜脊必须靠 edge bevel：AABB 顶面取的是最高点（z = -Z 端），在 z = 0 处不限制盒。
    assert!(
        bevels.edge_added >= 1,
        "斜脊应补出 edge bevel，实际 edge_added={}",
        bevels.edge_added
    );
    assert!(
        bevels
            .planes()
            .iter()
            .any(|p| p.normal[1] > 0.9 && (p.normal[0].abs() < 1e-6)),
        "斜脊的 edge bevel 里应有一张朝上的（n_y > 0.9、法线落在 x=0 平面内）",
    );
    // 判据在干活：候选面里绝大多数因「有顶点在面外侧」被否决。
    assert!(
        bevels.rejected_edge_candidates > 0,
        "edge bevel 的顶点内测判据应否决掉一部分候选（实际 {}）",
        bevels.rejected_edge_candidates
    );

    let with = drop_on(&v, &PRISM_TRIS, crest, true);
    assert!(with.fraction < 1.0, "垂直下探必然命中");
    let bottom = with.end_pos[1];
    let hover = bottom - crest;
    let n = with.normal.expect("命中后必须有接触法线");
    assert!(
        n[1] >= 0.7,
        "斜脊的停靠法线应可站（n_y >= 0.7），实际 {n:?}",
    );
    // 残余虚浮是**几何量**、不是误差：斜脊的支撑面是那张过脊线的 edge bevel，盒底在足迹内
    // 沿 z 有半宽 16，脊线本身沿 z 下行 ⇒ 盒底停在上坡侧那一角上，抬高的解析值 =
    // `16·|n_z| / n_y`（n 为绑定面法线）。这一项把机理钉住：残余量随脊的倾角走，与"盒尺寸"
    // 同阶，且**法线恒定**（不翻转）。
    let expected_hover = X_HALF * n[2].abs() / n[1];
    assert!(
        (hover - expected_hover).abs() < 0.2,
        "残余虚浮应等于 16·|n_z|/n_y = {expected_hover:.2} HU（几何量），实际 {hover:+.2} HU",
    );

    let without = drop_on(&v, &PRISM_TRIS, crest, false);
    assert!(without.fraction < 1.0);
    let float = without.end_pos[1] - crest;
    assert!(
        float > 5.0,
        "撤掉生成后盒底应虚浮在斜脊上方（实测 {float:+.2} HU）",
    );
    assert!(
        float > hover * 3.0,
        "撤掉生成的虚浮应远大于几何残余（撤掉 {float:+.2} HU vs 生成后 {hover:+.2} HU）",
    );
    let s = without.steepest_normal.expect("命中后必须有最陡面法线");
    assert!(
        s[1] < 0.7,
        "撤掉生成后最陡接触面应是不可站的斜面（n_y < 0.7），实际 {s:?}",
    );
}

/// 纯轴向凸体（长方体）：一张补面都不该生成（VBSP 对纯轴向 brush 直接 return）。
#[test]
fn axial_box_hull_gets_no_extra_planes() {
    let v = vec![
        [-64.0, -64.0, -64.0],
        [64.0, -64.0, -64.0],
        [64.0, 64.0, -64.0],
        [-64.0, 64.0, -64.0],
        [-64.0, -64.0, 64.0],
        [64.0, -64.0, 64.0],
        [64.0, 64.0, 64.0],
        [-64.0, 64.0, 64.0],
    ];
    // 12 个三角形，闭合长方体
    let tris: [[u32; 3]; 12] = [
        [0, 1, 2],
        [0, 2, 3],
        [4, 6, 5],
        [4, 7, 6],
        [0, 4, 5],
        [0, 5, 1],
        [1, 5, 6],
        [1, 6, 2],
        [2, 6, 7],
        [2, 7, 3],
        [3, 7, 4],
        [3, 4, 0],
    ];
    let b = hull_bevels(&v, &tris);
    assert_eq!(
        b.faces.len(),
        6,
        "共面三角形应并成 6 张轴向面，实际 {}",
        b.faces.len()
    );
    assert_eq!(b.box_added, 0, "长方体的 6 张轴向面已齐，不该补 box bevel");
    assert_eq!(b.edge_added, 0, "长方体的边全是轴向边，不该补 edge bevel");
    assert_eq!(
        b.planes().len(),
        6,
        "平面表应仍是 6 张，实际 {}",
        b.planes().len()
    );
}
