//! surf / 蹲姿语义回归（对齐 Source `CGameMovement::CanUnduck()`）。
//!
//! Source 权威实现（`src/game/shared/gamemovement.cpp`）：
//!   - 有地面实体：`newOrigin += (VEC_DUCK_HULL_MIN - VEC_HULL_MIN)`（CS:GO 两者 z 相同 → 原点不动），
//!     以**站立箱**在原地判定，被挡则保持蹲；
//!   - 空中：`viewDelta = (standHull - duckHull)` 取负 → `newOrigin` 下移 18（放脚、头顶不动），
//!     以**站立箱**从当前 origin 扫掠到 newOrigin，`startsolid || fraction != 1` 即**不起立**。
//!
//! ⇒ 贴坡 surf 时脚下没有 18u 空间（实测脚底离坡仅 +0.03~0.13），松开蹲键**保持蹲姿**，
//!   直到离坡或落地。这是 CS:GO 原版行为，本文件据此封帽。
//!
//! 反例（曾经的错误实现）：额外加「原地站立箱可用即起立」兜底 → 脚不动、头顶 +18，
//! 偏离 Source 且依赖贴面间隙 ≈0 处的临界判定（容差 0、间隙 0.03），行为会随几何抖动。

use crate::phys::player::{create_player, player_tick, PhysParams, Player};
use crate::phys::world::{Brush, Plane, World};

fn pl(n: [f64; 3], d: f64) -> Plane {
    Plane { normal: n, dist: d }
}

/// 60° surf 坡：法线 (0, 0.5, 0.866)，normal.y = 0.5 ∈ surf 区间 (0.05, 0.7)。
/// 表面 0.5y + 0.866z = 0 → y = -1.732·z；实体侧 0.5y + 0.866z <= 0。
const S: f64 = 0.8660254037844386f64;

fn ramp(ny: f64) -> (Brush, f64) {
    let s = (1.0 - ny * ny).sqrt();
    (
        Brush {
            planes: vec![
                pl([0.0, ny, s], 0.0),
                pl([0.0, -1.0, 0.0], 8000.0),
                pl([1.0, 0.0, 0.0], 2000.0),
                pl([-1.0, 0.0, 0.0], 2000.0),
                pl([0.0, 0.0, -1.0], 0.0),
                pl([0.0, 0.0, 1.0], 8000.0),
            ],
            min: [-2000.0, -8000.0, 0.0],
            max: [2000.0, 0.0, 8000.0],
        },
        s,
    )
}

/// 水平地面（顶面 y = 0）。
fn floor() -> Brush {
    Brush {
        planes: vec![
            pl([0.0, 1.0, 0.0], 0.0),
            pl([0.0, -1.0, 0.0], 2000.0),
            pl([1.0, 0.0, 0.0], 2000.0),
            pl([-1.0, 0.0, 0.0], 2000.0),
            pl([0.0, 0.0, 1.0], 2000.0),
            pl([0.0, 0.0, -1.0], 2000.0),
        ],
        min: [-2000.0, -2000.0, -2000.0],
        max: [2000.0, 0.0, 2000.0],
    }
}

fn world_with(brush: Brush) -> World {
    let mut w = World::new();
    w.solids.push(brush);
    w.build_index();
    w
}

/// 盒底面上坡侧棱（z-16）恰贴坡面时的 origin.y。
fn rest_y(ny: f64, s: f64, z: f64) -> f64 {
    -(s / ny) * (z - 16.0)
}

/// 盒最低角到坡面的带符号距离（>0 自由，<0 已侵入）。
fn clearance(ny: f64, s: f64, p: &Player) -> f64 {
    ny * p.origin[1] + s * (p.origin[2] - 16.0)
}

const DT: f64 = 1.0 / 64.0;

/// 贴坡滑行 → 蹲下 → 松开：**应保持蹲姿**（Source CanUnduck 失败）。
#[test]
fn surf_ramp_release_keeps_crouch() {
    let (brush, s) = ramp(0.5);
    let mut world = world_with(brush);
    let params = PhysParams::default();
    let z0 = 200.0;
    let mut p = create_player([0.0, rest_y(0.5, S, z0) + 1.0, z0], &params);
    p.velocity = [0.0, -400.0 * s, 400.0 * 0.5];

    p.input.duck = true;
    let mut contacts = 0u32;
    for _ in 0..40 {
        player_tick(&mut world, &mut p, &params, DT);
        if p.surfing {
            contacts += 1;
        }
    }
    assert!(p.ducked, "前置：应已蹲下");
    assert!(contacts > 5, "前置：应处于贴坡滑行（接触 tick={}）", contacts);

    p.input.duck = false;
    for _ in 0..60 {
        player_tick(&mut world, &mut p, &params, DT);
    }
    assert!(
        p.ducked,
        "贴坡 surf 松开蹲键应保持蹲姿（Source 语义）；实际 ducked={} surfing={} clearance={:+.4}",
        p.ducked, p.surfing, clearance(0.5, S, &p)
    );
}

/// 落地后（有地面实体）松开蹲键：**应起立**。
#[test]
fn grounded_release_stands_up() {
    let mut world = world_with(floor());
    let params = PhysParams::default();
    let mut p = create_player([0.0, 1.0, 0.0], &params);

    p.input.duck = true;
    for _ in 0..20 {
        player_tick(&mut world, &mut p, &params, DT);
    }
    assert!(p.on_ground, "前置：应已落地（on_ground={}）", p.on_ground);
    assert!(p.ducked, "前置：应已蹲下");

    p.input.duck = false;
    for _ in 0..10 {
        player_tick(&mut world, &mut p, &params, DT);
    }
    assert!(!p.ducked, "落地后松开蹲键应起立");
}

/// 空中且脚下有 ≥18u 空间：松开蹲键**应起立**（放脚，origin 下移 18）。
#[test]
fn air_release_with_clearance_stands_up() {
    let mut world = world_with(floor());
    let params = PhysParams::default();
    let mut p = create_player([0.0, 200.0, 0.0], &params);

    p.input.duck = true;
    player_tick(&mut world, &mut p, &params, DT);
    assert!(p.ducked, "前置：空中应能蹲下");

    let y_before = p.origin[1];
    p.input.duck = false;
    player_tick(&mut world, &mut p, &params, DT);
    assert!(!p.ducked, "空中脚下有空间时应起立（放脚 −18）");
    assert!(
        p.origin[1] < y_before - 17.0,
        "起立应把 origin 下移 ~18（放脚）；实际 {:.3} → {:.3}",
        y_before,
        p.origin[1]
    );
}

/// 坡度扫描：surf 区间内各坡度松开蹲键均应**保持蹲姿**（表征 Source 语义一致性）。
#[test]
fn slope_sweep_release_keeps_crouch() {
    let params = PhysParams::default();
    println!("{:>8} | {:>10} | {:>8}", "normal.y", "min_clear", "保持蹲");
    for ny in [0.10f64, 0.20, 0.30, 0.40, 0.50, 0.60, 0.65, 0.69] {
        let (brush, s) = ramp(ny);
        let mut world = world_with(brush);
        let z0 = 200.0;
        let mut p = create_player([0.0, rest_y(ny, s, z0) + 1.0, z0], &params);
        p.velocity = [0.0, -400.0 * s, 400.0 * ny];

        p.input.duck = true;
        let mut min_clear = f64::MAX;
        for _ in 0..40 {
            player_tick(&mut world, &mut p, &params, DT);
            min_clear = min_clear.min(clearance(ny, s, &p));
        }
        p.input.duck = false;
        for _ in 0..60 {
            player_tick(&mut world, &mut p, &params, DT);
        }
        println!(
            "{:>8.2} | {:>10.4} | {:>8}",
            ny, min_clear, if p.ducked { "yes" } else { "NO" }
        );
        assert!(p.ducked, "normal.y={} 贴坡松开蹲键应保持蹲姿", ny);
    }
}
