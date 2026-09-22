//! surf / 蹲姿语义回归（6 项）：`player::update_duck` 的起立判定，以及地面/空中动量上限。
//!
//! 钉住的 `player.rs` 语义：
//! - **起立判定**（`update_duck`）：蹲键松开时，若 `on_ground` 为真，则以**站立箱**在
//!   `origin` 原地调 `is_position_free`，被挡就保持蹲姿（origin 不动）；空中则走"放脚"
//!   路径 —— 目标 origin 下移 `stand_maxs[1] - duck_maxs[1]`（默认箱高
//!   `DEFAULT_HULL_STAND_HEIGHT` 72 − `DEFAULT_HULL_DUCK_HEIGHT` 54 = 18），
//!   以站立箱从当前 origin 扫掠到目标，`start_solid || all_solid || fraction != 1`
//!   即**不起立**。
//! - **碰撞箱与视角分离**：`ducked` 决定 `mins()` / `maxs()`（箱体瞬时切换），
//!   `duck_frac` 只驱动 `eye_height()` —— 地面按 `DUCK_LERP_TIME`（0.2s）线性趋近，
//!   空中与落地 tick 直接置位。
//! - **动量上限**（`current_max_speed`）：只有 `on_ground && ducked` 取 `crouch_speed`
//!   （默认 85）；否则 `input.walk` 为真取 `walk_speed`，否则 `run_speed`（默认 250）
//!   —— 空中即使处于蹲姿也走 `run_speed`。
//! - **空中加速**（`air_accelerate`）：`addspeed` 用钳到 `AIR_SPEED_CAP`（30）的 wishspeed，
//!   `accelspeed = air_accelerate × wishspeed × dt` 再被 `addspeed` 钳住。
//! - **surf 判定**（`try_player_move`）：每次调用起点先清 `surfing`，撞到法线
//!   y ∈ (0.05, 0.7) 的面时置位。
//!
//! ⇒ 贴坡滑行时脚下没有这 18u 空间，松开蹲键保持蹲姿 —— 由
//! `surf_ramp_release_keeps_crouch` 与 `slope_sweep_release_keeps_crouch` 封住；
//! 落地、或空中脚下有空隙时必须起立 —— 由 `grounded_release_stands_up` 与
//! `air_release_with_clearance_stands_up` 封住；动量口径由另外两项用例封住。
//!
//! 夹具：`ramp(ny)` 造法线 `(0, ny, √(1−ny²))` 的斜面 brush（表面 `y = −(s/ny)·z`），
//! `floor()` 造顶面 `y = 0` 的水平地面，`world_with` 把单个 brush 压进 `World.solids`
//! 后 `build_index()`（`World::trace` 与 `is_position_free` 都从空间索引取候选）；
//! `rest_y` / `clearance` 只用于构造初始位置与断言消息里的间隙值。
//! 全部用例按 `DT`（64Hz）推进，直接调 `player_tick` —— 不经 `PhysWorld`，
//! 因此不涉及传送、死亡与 reset 逻辑。

use crate::phys::player::{create_player, player_tick, PhysParams, Player};
use crate::phys::world::{Brush, Plane, World};

/// `Plane` 的简写构造（法线朝外，`dist` 为面沿法线的偏移）。
fn pl(n: [f64; 3], d: f64) -> Plane {
    Plane { normal: n, dist: d }
}

/// `ramp(0.5)` 的横向分量 s = √(1 − 0.25) = 0.8660254037844386：
/// 第一个用例用固定坡度 0.5 构造初始位置与断言消息里的间隙值。
const S: f64 = 0.8660254037844386f64;

/// 斜面 brush：法线 `(0, ny, s)`（`s = √(1 − ny²)`）、过原点，返回 `(brush, s)`。
/// 表面 `ny·y + s·z = 0` 即 `y = −(s/ny)·z`，实体侧 `ny·y + s·z <= 0`；
/// AABB 为 `[-2000, -8000, 0] .. [2000, 0, 8000]`，z = 0 与 z = 8000 两面闭合。
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

/// 水平地面：顶面 `y = 0`，AABB 为 `[-2000, -2000, -2000] .. [2000, 0, 2000]`。
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

/// 单 brush 世界：压进 `World.solids` 后 `build_index()`。空间索引必须建 ——
/// `World::trace` 与 `World::is_position_free` 都只对索引查出的候选做扫掠。
fn world_with(brush: Brush) -> World {
    let mut w = World::new();
    w.solids.push(brush);
    w.build_index();
    w
}

/// 令盒底 z − 16 棱恰落在坡面上的 origin.y，由 `ny·y + s·(z − 16) = 0` 解出。
fn rest_y(ny: f64, s: f64, z: f64) -> f64 {
    -(s / ny) * (z - 16.0)
}

/// 盒到坡面的最小带符号距离 `ny·y + s·(z − 16)`：盒底与 z − 16 棱使该式取最小，
/// >0 表示尚未接触，<0 表示已侵入。
fn clearance(ny: f64, s: f64, p: &Player) -> f64 {
    ny * p.origin[1] + s * (p.origin[2] - 16.0)
}

/// 固定步长（64Hz）。`air_crouch_momentum_uses_standing_params` 用等值本地 `dt`，不引用本常量。
const DT: f64 = 1.0 / 64.0;

/// 贴坡滑行中松开蹲键：**应保持蹲姿**（空中放脚扫掠失败）。
/// 前置断言要求已蹲下，且这 40 个 tick 里 `surfing` 至少出现 5 次。
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

/// 落地后松开蹲键：有地面支撑 → 走原地站立箱判定，空闲即起立（origin 不动，只换箱体）。
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

/// 空中且脚下有 18u 空间：起立走放脚路径 —— origin 下移
/// `stand_maxs[1] - duck_maxs[1]`（默认 18），该 tick 内还会叠加一次空中重力位移，
/// 故断言只要求下移超过 17。
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

/// 坡度扫描：surf 判定区间 (0.05, 0.7) 内的 8 个法线 y（0.10 … 0.69）逐个重复
/// "贴坡滑行 → 松开蹲键"，全部应保持蹲姿；顺带打印各坡度的最小间隙。
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

/// 空中蹲姿的动量按**站姿参数**算：`wishspeed` 取 `run_speed`（250），
/// `air_accelerate` 的加速度上限 `AIR_ACCELERATE × run_speed × dt`（≈585.9/帧）
/// 高于本场景的 `addspeed`，实际增量由 `addspeed` 钳住 —— 于是蹲姿与站姿的每 tick
/// 增量完全相同。空世界（无碰撞）隔离出纯 `air_accelerate` 的作用；蹲姿一路必须按住
/// 蹲键，否则空世界里立刻起立。
#[test]
fn air_crouch_momentum_uses_standing_params() {
    use crate::phys::player::{AIR_ACCELERATE, CROUCH_SPEED};

    let params = PhysParams::default();
    let dt = 1.0 / 64.0;

    // 空世界（无碰撞）：只留 air_accelerate 的作用，隔离姿态差异
    let step = |ducked: bool| {
        let mut world = World::new();
        world.build_index();
        let mut p = create_player([0.0, 1000.0, 0.0], &params);
        p.ducked = ducked;
        p.duck_frac = if ducked { 1.0 } else { 0.0 };
        p.velocity = [0.0, 0.0, 300.0];
        p.yaw = 0.0;
        p.input.forward = true;
        p.input.right = true;
        p.input.duck = ducked; // 蹲姿一路必须按住，否则空世界里立刻起立
        let before = p.velocity;
        player_tick(&mut world, &mut p, &params, dt);
        [
            p.velocity[0] - before[0],
            p.velocity[1] - before[1],
            p.velocity[2] - before[2],
        ]
    };

    let dv_duck = step(true);
    let dv_stand = step(false);
    // 水平增量：去掉重力项 dv[1]
    let mag = |dv: [f64; 3]| (dv[0] * dv[0] + dv[2] * dv[2]).sqrt();
    let m_duck = mag(dv_duck);
    let m_stand = mag(dv_stand);

    // 期望：wishdir = (1,0,-1)/√2；currentspeed = dot((0,0,300), wishdir) = -300/√2；
    // wishspd = min(run_speed, AIR_SPEED_CAP=30) = 30 → addspeed = 30 + 300/√2 ≈ 242.13
    let addspeed = 30.0 + 300.0 / 2.0_f64.sqrt();
    let cap_duck = AIR_ACCELERATE * CROUCH_SPEED * dt;
    let cap_stand = AIR_ACCELERATE * params.run_speed * dt;
    println!(
        "  addspeed={:.4} | 蹲姿上限={:.4} 实测={:.4} | 站姿上限={:.4} 实测={:.4}",
        addspeed, cap_duck, m_duck, cap_stand, m_stand
    );

    // 蹲姿在空中：上限由 run_speed 导出（≈585.9）→ 实际被 addspeed 钳住；
    // cap_duck（用 CROUCH_SPEED 算）只作打印对照，未被断言采用。
    assert!(
        (m_duck - addspeed).abs() < 1e-6,
        "空中蹲姿加速度应由 addspeed 钳住（站姿参数）；期望 {:.6}，实测 {:.6}",
        addspeed,
        m_duck
    );
    assert!(
        (m_stand - addspeed).abs() < 1e-6,
        "站姿空中加速度应由 addspeed 钳住；期望 {:.6}，实测 {:.6}",
        addspeed,
        m_stand
    );
    assert!(
        (m_duck - m_stand).abs() < 1e-9,
        "空中蹲姿与站姿的每 tick 速度增量必须完全相同；蹲 {:.6} vs 站 {:.6}",
        m_duck,
        m_stand
    );
    // 上限核算：站姿上限高于 addspeed，故两者都不受上限约束
    assert!(
        cap_stand > addspeed,
        "站姿上限 {:.4} 应高于 addspeed {:.4}",
        cap_stand,
        addspeed
    );
    println!("  空中：蹲姿 {:.4} == 站姿 {:.4}（均为 addspeed {:.4}）", m_duck, m_stand, addspeed);
}

/// 地面蹲姿仍使用蹲姿速度：`current_max_speed` 的 `on_ground && ducked` 分支取
/// `crouch_speed`（85），持续前进后水平速度收敛到它（断言容差 1.0）。
#[test]
fn ground_crouch_uses_crouch_speed() {
    use crate::phys::player::CROUCH_SPEED;

    let params = PhysParams::default();
    let mut world = world_with(floor());
    let mut p = create_player([0.0, 1.0, 0.0], &params);

    p.input.duck = true;
    p.input.forward = true;
    for _ in 0..40 {
        player_tick(&mut world, &mut p, &params, DT);
    }
    assert!(p.on_ground, "前置：应在地面 on_ground={}", p.on_ground);
    assert!(p.ducked, "前置：应已蹲下");

    // 地面持续前进 → 水平速度收敛到蹲姿速度（而非 run_speed）
    let spd = (p.velocity[0] * p.velocity[0] + p.velocity[2] * p.velocity[2]).sqrt();
    println!("  地面蹲姿前进速度 = {:.3}（crouch_speed={}）", spd, CROUCH_SPEED);
    assert!(
        (spd - CROUCH_SPEED).abs() < 1.0,
        "地面蹲姿速度应收敛到 crouch_speed；期望≈{}，实测 {:.3}",
        CROUCH_SPEED,
        spd
    );
}
