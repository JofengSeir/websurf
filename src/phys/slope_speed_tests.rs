//! 地面移动保真度回归：**斜坡上任何方向的水平速度都保持 `maxspeed`**。
//!
//! 钉住的起源语义（`test/project/source-sdk-2013-master/src/game/shared/gamemovement.cpp`）：
//! - 地面上速度是**纯水平**的：`CGameMovement::WalkMove` 在 `Accelerate` 前后各写一次
//!   `mv->m_vecVelocity[2] = 0`（`:1958`、`:1960`），`FullWalkMove` 落地后再写一次
//!   "If we are on ground, no downward velocity"（`:2073`~`:2076`）。
//! - `CategorizePosition` **不剪地面速度**：只清向下的竖直分量，水平分量一个数都不动。
//! - 爬坡靠 `CGameMovement::StepMove`（`:1515`）的"地面滑 / 抬 18-滑-落 18 择优" ⇒
//!   **上坡的水平位移与平地一样**，爬升量 `tanθ × 水平位移` 是白送的。
//!
//! 参考实现读数（`test/surf-phys-reference/physics.mjs`，脚本 `.tmp/slope-ref.mjs`）：
//! 40.5° 上坡的水平速度 = 260.00（= `maxSpeed`）、120 tick 水平位移 **430.73 HU**，与平地逐位相同。
//!
//! 修前（`categorize_position` 把地面速度投影到坡面）实测：40.5° 上坡水平速度 220.28，
//! 再叠加"地面上清竖直分量"后 140.24 —— owner 2026-10-06 在真图更陡处读到 190。

use crate::phys::player::{create_player, player_tick, PhysParams, RUN_SPEED};
use crate::phys::world::{Brush, Plane, World};

const DT: f64 = 1.0 / 64.0;

fn pl(n: [f64; 3], d: f64) -> Plane {
    Plane { normal: n, dist: d }
}

/// 法线 `(0, ny, s)`（`s = √(1 − ny²)`）的斜面 brush：表面 `y = −(s/ny)·z`，实体在下侧。
fn ramp(ny: f64) -> Brush {
    let s = (1.0 - ny * ny).sqrt();
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
    }
}

/// 水平地面（顶面 `y = 0`），作为平地对照。
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

fn world_with(b: Brush) -> World {
    let mut w = World::new();
    w.solids.push(b);
    w.build_index();
    w
}

/// 静置 30 tick 落地后按住前进（yaw = 0 ⇒ 朝 −z）120 tick，统计**末 40 tick**：
/// 返回（水平速度均值、每 tick 平均水平位移、着地 tick 数）。
fn walk_forward(mut w: World, start: [f64; 3]) -> (f64, f64, usize) {
    let params = PhysParams::default();
    let mut p = create_player(start, &params);
    for _ in 0..30 {
        player_tick(&mut w, &mut p, &params, DT);
    }
    let (mut hs, mut steps, mut g, mut n) = (0.0, 0.0, 0usize, 0usize);
    let mut pz = p.origin[2];
    for i in 0..120 {
        p.input.forward = true;
        player_tick(&mut w, &mut p, &params, DT);
        if i >= 80 {
            let h = (p.velocity[0] * p.velocity[0] + p.velocity[2] * p.velocity[2]).sqrt();
            hs += h;
            steps += (p.origin[2] - pz).abs();
            if p.on_ground {
                g += 1;
            }
            n += 1;
        }
        pz = p.origin[2];
    }
    (hs / n as f64, steps / n as f64, g)
}

/// 可站坡度（≤ `acos(STANDABLE_NORMAL)` = 45.573°）上往上走：水平速度顶到 `RUN_SPEED`、每 tick
/// 位移与平地相同；更陡的坡判滑（着地 0，不是"走得慢"）。
///
/// 与参考实现逐档对照（`.tmp/slope-ref.mjs`）：45.0° / 45.4° ⇒ 水平 260.00 满速；46°（ny 0.6947
/// < 0.7）⇒ 17.57 且着地 0/40。
#[test]
fn walkable_slopes_keep_maxspeed_and_steeper_ones_slide() {
    for ang in [30.0f64, 35.0, 40.5, 43.0, 45.0] {
        let ny = ang.to_radians().cos();
        let s = (1.0 - ny * ny).sqrt();
        let y = -(s / ny) * 1000.0;
        let (h, step, g) = walk_forward(world_with(ramp(ny)), [0.0, y + 1.0, 1000.0]);
        assert!(
            (h - RUN_SPEED).abs() < 1.0,
            "可站坡度 {ang}°（ny {ny:.4}）上坡的水平速度应为 maxspeed，实测 {h:.2}"
        );
        assert!(
            (step - RUN_SPEED * DT).abs() < 0.02,
            "可站坡度 {ang}° 每 tick 水平位移应为 {:.4}，实测 {step:.4}",
            RUN_SPEED * DT
        );
        assert!(g >= 38, "可站坡度 {ang}° 应贴坡着地，实测 {g}/40");
    }
    for ang in [47.0f64, 50.0, 55.0] {
        let ny = ang.to_radians().cos();
        let s = (1.0 - ny * ny).sqrt();
        let y = -(s / ny) * 1000.0;
        let (h, _, g) = walk_forward(world_with(ramp(ny)), [0.0, y + 1.0, 1000.0]);
        assert!(
            h < 0.5 * RUN_SPEED && g <= 2,
            "陡于可站上限的 {ang}°（ny {ny:.4}）应判滑（水平 {h:.2}、着地 {g}/40），而不是走得慢"
        );
    }
}

/// 40.5° 坡上往上走：水平速度必须顶到 `RUN_SPEED`，**每 tick 水平位移与平地相同**。
#[test]
fn slope_walking_preserves_maxspeed_horizontally() {
    let ny = (40.5f64).to_radians().cos();
    let s = (1.0 - ny * ny).sqrt();
    let y = -(s / ny) * 1000.0;
    let (flat_h, flat_step, _) = walk_forward(world_with(floor()), [0.0, 1.0, 1000.0]);
    let (ramp_h, ramp_step, ramp_g) =
        walk_forward(world_with(ramp(ny)), [0.0, y + 1.0, 1000.0]);

    assert!(
        (flat_step - RUN_SPEED * DT).abs() < 0.02,
        "平地每 tick 水平位移应为 maxspeed·dt = {:.4}，实测 {:.4}",
        RUN_SPEED * DT,
        flat_step
    );
    assert!(
        (flat_h - RUN_SPEED).abs() < 1.0,
        "平地水平速度应为 {:.0}，实测 {:.2}",
        RUN_SPEED,
        flat_h
    );
    assert!(
        (ramp_h - RUN_SPEED).abs() < 1.0,
        "40.5° 上坡的水平速度应为 maxspeed({:.0})——不是 maxspeed·cos²θ；实测 {:.2}",
        RUN_SPEED,
        ramp_h
    );
    assert!(
        (ramp_step - flat_step).abs() < 0.02,
        "上坡每 tick 水平位移 {:.4} 应与平地 {:.4} 相同（起源 StepMove：抬-滑-落抹平坡度）",
        ramp_step,
        flat_step
    );
    assert!(ramp_g >= 38, "40.5° 上坡应贴坡着地，实测 {}/40", ramp_g);
}
