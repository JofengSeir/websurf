//! 起跳高度回归（2 项）：「跳跃增幅区」用的 `PhysWorld::set_jump_height` 必须只改**后续**
//! 起跳的初速，不碰当前速度。
//!
//! 钉住的 `player.rs` 语义：`check_jump` 用 `sqrt(2 · gravity · params.jump_height)` **覆盖**
//! `velocity.y`（`player.rs:900-901`），默认 800 / 57 ⇒ ≈302.0 HU/s，顶点恰 57 HU。
//! surf_null 的 `autohop_zone` 区域内宿主把高度抬到 80 HU ⇒ 初速 ≈357.77、顶点 80 HU。
//!
//! 夹具：`floor()` 造顶面 y = 0 的水平地面（与 `duck_surf_tests` 同构，六面凸体 + 空间索引），
//! 玩家 origin 放在 `[0,0,0]` 正好站在面上；`jump_velocity_after_one_tick` 直接调 `player_tick`
//! （不经 `PhysWorld`，不涉及传送/死亡/reset），从 `p.velocity[1]` 读起跳初速。

use crate::phys::player::{create_player, player_tick, PhysParams};
use crate::phys::world::{Brush, Plane, World};

/// 顶面 y = 0 的水平地面 brush（AABB `[-2000,-1000,-2000] .. [2000,0,2000]`）。
fn floor() -> Brush {
    let pl = |n: [f64; 3], d: f64| Plane { normal: n, dist: d };
    Brush {
        planes: vec![
            pl([0.0, 1.0, 0.0], 0.0),
            pl([0.0, -1.0, 0.0], 1000.0),
            pl([1.0, 0.0, 0.0], 2000.0),
            pl([-1.0, 0.0, 0.0], 2000.0),
            pl([0.0, 0.0, 1.0], 2000.0),
            pl([0.0, 0.0, -1.0], 2000.0),
        ],
        min: [-2000.0, -1000.0, -2000.0],
        max: [2000.0, 0.0, 2000.0],
    }
}

fn world_with_floor() -> World {
    let mut world = World::new();
    world.solids.push(floor());
    world.build_index();
    world
}

/// 站在平地上按跳一拍，返回这一拍的 `velocity[1]`（起跳初速）。
fn jump_velocity_after_one_tick(height: f64) -> f64 {
    const DT: f64 = 1.0 / 64.0;
    let mut params = PhysParams::default();
    params.jump_height = height;
    let mut world = world_with_floor();
    let mut p = create_player([0.0, 0.0, 0.0], &params);
    p.on_ground = true;
    p.input.jump = true;
    player_tick(&mut world, &mut p, &params, DT);
    p.velocity[1]
}

/// 一拍内起跳初速的期望值：`check_jump` 先写 `√(2gh)`，随后同一拍的重力再扣 `g·dt`
/// （`player_tick` 里跳在重力之前），故读到的 `velocity[1]` 是 `√(2gh) − g·DT`。
fn expect_after_one_tick(height: f64) -> f64 {
    const DT: f64 = 1.0 / 64.0;
    (2.0 * 800.0 * height).sqrt() - 800.0 * DT
}

/// 默认 57 HU：起跳初速 = √(2 × 800 × 57) − g·DT ≈ 289.5（±0.5%）。
#[test]
fn default_height_matches_jump_speed() {
    let v = jump_velocity_after_one_tick(57.0);
    let expect = expect_after_one_tick(57.0);
    assert!(
        (v - expect).abs() / expect < 0.005,
        "默认跳高 57 的起跳初速应 ≈{expect:.2}，实际 {v:.2}"
    );
}

/// 抬到 80 HU：起跳初速 = √(2 × 800 × 80) − g·DT ≈ 345.3（±0.5%）——「跳跃增幅区」靠它
/// 跳上比坑底高 64 HU 的水泥台。
#[test]
fn boosted_height_raises_takeoff_speed() {
    let v = jump_velocity_after_one_tick(80.0);
    let expect = expect_after_one_tick(80.0);
    assert!(
        (v - expect).abs() / expect < 0.005,
        "跳高 80 的起跳初速应 ≈{expect:.2}，实际 {v:.2}"
    );
}
