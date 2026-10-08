//! 三角形「面」语义回归（4 项）：置换面 / `.phy` 遗留三角是**面**，不是实体。
//!
//! 钉住的契约（`src/phys/world.rs` 的 `clip_box_to_triangle`）：
//! - **面没有内部**：盒跨在面两侧（贴地、贴坡的常态）**不算**嵌入实体 ⇒
//!   `is_position_free` 为真、追踪不写 `start_solid` / `all_solid`。修前把三角形当
//!   实心凸体（±法线 + 三条边墙的 5 面闭集），贴面行走每 tick 被判「起点实心」，
//!   `check_stuck` 冻结、或移动被剪成每 tick 零点几 HU —— owner 报的「脚底黏住」。
//! - **边墙不出法线**：接触法线恒取面法线 ±n。边墙若也参与接触，盒的前缘会在相邻三角
//!   的**棱线**上被一张横法线挡住，法线又几乎与移动方向相反 ⇒ 速度被整段剪掉。
//!   第 2 项（沿锯齿坡滑行不被边墙挡）与第 3 项（陡面仍按面法线挡）钉住这条的两侧；
//!   两项在修前也通过 —— 真实地图上的黏住由**斜向法线**的边墙触发（斜法线才能同时满足
//!   "盒在墙外"与"盒 AABB 与该三角形重叠"），手搓夹具难以逐位复刻；
//!   端到端前后对照见 `TODO.md` T-444 的证据列。
//!
//! 第 1 项是修前的回归对照：撤掉 `clip_box_to_triangle` 的"面"改法后必 FAIL（已实测）。
//!
//! 全部走 `World::trace` / `World::is_position_free`：不碰 wasm、不碰地图夹具。

use crate::phys::player::{create_player, player_tick, PhysParams};
use crate::phys::world::{TriMesh, World};

const DT: f64 = 1.0 / 64.0;
const MINS: [f64; 3] = [-16.0, 0.0, -16.0];
const MAXS: [f64; 3] = [16.0, 72.0, 16.0];

fn mesh(name: &str, vertices: Vec<[f64; 3]>, indices: Vec<[u32; 3]>) -> TriMesh {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for v in &vertices {
        for k in 0..3 {
            if v[k] < min[k] {
                min[k] = v[k];
            }
            if v[k] > max[k] {
                max[k] = v[k];
            }
        }
    }
    TriMesh {
        name: name.to_string(),
        vertices,
        indices,
        min,
        max,
    }
}

fn world(m: TriMesh) -> World {
    let mut w = World::new();
    w.tri_meshes.push(m);
    w.build_index();
    w
}

/// 单张水平三角面（y = 0），覆盖盒的落点。
fn flat_triangle() -> TriMesh {
    mesh(
        "flat",
        vec![
            [-400.0, 0.0, -400.0],
            [400.0, 0.0, -400.0],
            [0.0, 0.0, 400.0],
        ],
        vec![[0, 1, 2]],
    )
}

/// 陡三角面：表面 y = 3x（71.6°、不可站），x ∈ [0, 200] —— 盒沿 +x 撞上去必须被挡住。
/// 用陡面而不是绝对竖直面：竖直面的 AABB 在 x 上宽度为 0，会先被盒-AABB 必要校验否掉，
/// 测不到面法线这条路。
fn steep_wall() -> TriMesh {
    mesh(
        "steep",
        vec![
            [0.0, 0.0, -400.0],
            [0.0, 0.0, 400.0],
            [200.0, 600.0, 0.0],
        ],
        vec![[0, 1, 2]],
    )
}

/// 锯齿状上升坡带：沿 −z 每 100 HU 一环，环高交替 ±6 HU 叠加 0.25 的平均坡，
/// 于是相邻四边形**法线不同**、棱线处存在横向边墙面。x 两列（−50 / +50）。
fn zigzag_slope(rings: usize) -> TriMesh {
    let mut vertices: Vec<[f64; 3]> = Vec::new();
    let mut indices: Vec<[u32; 3]> = Vec::new();
    for j in 0..=rings {
        let z = -100.0 * j as f64;
        let mut h = 25.0 * j as f64;
        if j % 2 == 1 {
            h -= 6.0;
        }
        vertices.push([-50.0, h, z]);
        vertices.push([50.0, h, z]);
    }
    for j in 0..rings {
        let b = (2 * j) as u32;
        indices.push([b, b + 2, b + 1]);
        indices.push([b + 1, b + 2, b + 3]);
    }
    mesh("zigzag", vertices, indices)
}

/// 1. 面没有内部：盒底压到面下 1 HU（跨面）不算嵌入实体。
///
/// 修前该断言为假（`start_solid` 由 ±法线的一对零厚度平面必然触发），
/// 于是 `check_stuck` 在贴地行走时每 tick 误报「卡死」。
#[test]
fn a_box_straddling_a_triangle_surface_is_not_inside_a_solid() {
    let mut w = world(flat_triangle());
    let at = [0.0, -1.0, 0.0];
    assert!(
        w.is_position_free(&at, &MINS, &MAXS),
        "三角形是面：盒跨在面两侧不算嵌入实体（修前这里报「不空」）"
    );
}

/// 2. 面只沿自己的法线推人：沿锯齿坡面滑行的盒不会被棱线处的横向边墙挡住。
///
/// 取一段贴着坡面、沿 −z 走 4 HU 的扫掠（坡在走，盒底就压在面上），
/// 断言**无命中**（`fraction == 1.0`）—— 面只约束"到面的距离"，不产生横向墙。
#[test]
fn a_box_sliding_along_a_faceted_surface_is_not_blocked_by_seam_walls() {
    let mut w = world(zigzag_slope(8));
    // 环 j=2 处坡面高 h=50（z=-200），从 z=-190 沿 −z 走 4 HU，盒底钉在坡面上
    let start = [0.0, 52.0, -190.0];
    let end = [0.0, 52.0, -194.0];
    let tr = w.trace(&start, &end, &MINS, &MAXS);
    assert_eq!(
        tr.fraction, 1.0,
        "面不产生横向墙：贴坡滑行不该被棱线处边墙挡住（法线 {:?}）",
        tr.normal
    );
}

/// 3. 反面：陡面仍然挡（面法线出手），且法线取自三角面而不是某个横向边墙。
#[test]
fn a_steep_triangle_wall_still_blocks_with_its_face_normal() {
    let mut w = world(steep_wall());
    let start = [-200.0, 100.0, 0.0];
    let end = [50.0, 100.0, 0.0];
    let tr = w.trace(&start, &end, &MINS, &MAXS);
    assert!(tr.fraction < 1.0, "陡面必须挡住盒：fraction={}", tr.fraction);
    let n = tr.normal.expect("命中必须给法线");
    assert!(
        n[0].abs() > 0.9 && n[1] > 0.0 && n[1] < 0.5,
        "接触法线应取自 71.6° 的三角面（≈ ±(0.949, 0.316, 0)），实际 {n:?}"
    );
}

/// 4. 玩家级：走上锯齿坡**必须保持水平速度**，不得出现「贴地却几乎不动」的 tick。
///
/// 修前实测：坡面棱线处每 tick 与横向墙接触 ⇒ 速度被剪到个位数 HU/s、
/// 每 tick 只挪零点几 HU（owner 报「脚底黏住」）。本项只断言"不黏住"，
/// 不断言爬升量（爬升是几何白送的）。
#[test]
fn walking_up_a_faceted_triangle_slope_keeps_horizontal_speed() {
    let mut w = world(zigzag_slope(20));
    let params = PhysParams::default();
    let mut p = create_player([0.0, 4.0, 0.0], &params);
    for _ in 0..40 {
        player_tick(&mut w, &mut p, &params, DT);
    }
    let z0 = p.origin[2];
    let mut slow = 0usize;
    let mut grounded = 0usize;
    for i in 0..240 {
        p.input.forward = true;
        player_tick(&mut w, &mut p, &params, DT);
        if i < 20 || !p.on_ground {
            continue;
        }
        grounded += 1;
        let hs = (p.velocity[0] * p.velocity[0] + p.velocity[2] * p.velocity[2]).sqrt();
        if hs < 100.0 {
            slow += 1;
        }
    }
    let advanced = z0 - p.origin[2];
    assert!(
        slow == 0,
        "贴地不该被棱线边墙黏住：{grounded} 个着地 tick 里有 {slow} 个水平速度 < 100 HU/s"
    );
    assert!(
        advanced > 200.0,
        "沿坡应正常前进：净 −z 位移 {advanced:.1} HU（起点 z={z0}）"
    );
}
