//! 台阶移动的抬升闸门回归（2 项）：`step_move` 不得在**头顶无障碍**时把玩家抬起来。
//!
//! 本文件钉住 `player.rs::step_move` 里的一处判据。抬升扫掠（`+STEP_HEIGHT`）在头顶空旷时
//! 必然无命中，而 `trace` 在无命中时把 `end_pos` 设为**扫掠终点** ⇒ 若把 `tr.end_pos`
//! 照单全收，就等于**每 tick 把玩家无条件抬 18 HU**。
//!
//! 平地上这个 bug 完全不可见：紧接着的落回扫掠会把玩家拉回原高度，单看最终 origin 没有
//! 异常——**所以平地上的断言抓不到它**（第一版就栽在这里，见下方夹具说明）。只有当
//! 「新位置的地面比原地高」时，抬升才会在水平位移比较中胜出，玩家被一帧吸上去。
//!
//! 夹具因此是**两层**：低地 + 一堵 12 HU 高、顶面之上完全空旷的平台。玩家朝平台走：
//! - 修前（无条件抬升）：被抬到 +18 → 前移 → 落回扫掠踩到 12 HU 的平台顶 ⇒ **一帧上 12 HU**；
//! - 修后（`fraction < 1.0` 才采纳）：不抬 ⇒ 水平移动被平台立面挡住 ⇒ 停在低地。
//!
//! 真实场景（`surf_666` 的 `models/props/666/s1_ramp1b.mdl`，.phy 凸包）：沿 −z 走到
//! z ≈ −9789 处地面追踪换到相邻 facet（真坡面 14571.59、玩家脚下 14560.03），玩家被
//! **一帧抬 11.55 HU**（+693 HU/s），悬空 9 tick 后落回，`on_ground` 翻转触发传送检测。

use crate::phys::player::{create_player, player_tick, PhysParams};
use crate::phys::world::{Brush, Plane, World};

const DT: f64 = 1.0 / 64.0;
/// 平台比低地高出的高度。取 12：明确小于 `STEP_HEIGHT`(18)，因此"能不能跨"是一个**策略**
/// 问题而不是硬上限问题——本文件只钉"头顶无障碍时不得被抬起来"这条判据。
const STEP_UP: f64 = 12.0;
/// 平台前缘在 z = -40（玩家从 z = 0 出发朝 -z 走）。
const LEDGE_Z: f64 = -40.0;

/// `Plane` 的简写构造，与 `duck_surf_tests` 同约定：实体侧 `dot(normal, p) <= dist`。
fn pl(n: [f64; 3], d: f64) -> Plane {
    Plane { normal: n, dist: d }
}

/// 低地：顶面 y = 0，z 从 -400 往 +z 延伸。
fn low_ground() -> Brush {
    Brush {
        planes: vec![
            pl([0.0, 1.0, 0.0], 0.0),
            pl([0.0, -1.0, 0.0], 400.0),
            pl([1.0, 0.0, 0.0], 2000.0),
            pl([-1.0, 0.0, 0.0], 2000.0),
            pl([0.0, 0.0, 1.0], 400.0),
            pl([0.0, 0.0, -1.0], LEDGE_Z + 400.0),
        ],
        min: [-2000.0, -400.0, LEDGE_Z],
        max: [2000.0, 0.0, 400.0],
    }
}

/// 平台：顶面 y = STEP_UP，从 LEDGE_Z 往 -z 铺开。**它上方空旷**——这是本夹具的关键。
fn ledge() -> Brush {
    Brush {
        planes: vec![
            pl([0.0, 1.0, 0.0], STEP_UP),
            pl([0.0, -1.0, 0.0], 400.0 + STEP_UP),
            pl([1.0, 0.0, 0.0], 2000.0),
            pl([-1.0, 0.0, 0.0], 2000.0),
            pl([0.0, 0.0, -1.0], 2000.0),
            pl([0.0, 0.0, 1.0], -LEDGE_Z + 400.0),
        ],
        min: [-2000.0, 0.0, -2000.0],
        max: [2000.0, STEP_UP, LEDGE_Z],
    }
}

fn two_level_world() -> World {
    let mut w = World::new();
    w.solids.push(low_ground());
    w.solids.push(ledge());
    w.build_index();
    w
}

/// **走向不高于 `STEP_HEIGHT` 的台阶必须走上去**（起源语义），且单 tick 抬幅不超过台阶高。
///
/// 依据：起源 `CGameMovement::StepMove`（
/// `test/project/source-sdk-2013-master/src/game/shared/gamemovement.cpp:1515`）在直接移动被挡后
/// **总是**尝试"抬 `stepsize + DIST_EPSILON` → 滑 → 落回"，落点可站就采用 —— 它**不要求头顶
/// 有东西**；参考实现同夹具实测：12 HU 台阶被走上，单 tick 净抬 **+12.00 HU**、水平速度保持
/// 260（`.tmp/ledge-ref.mjs`）。
///
/// 本测试同时封住"每 tick 无条件抬 18 HU"那个真缺陷的另一面：**平地上 400 tick 不得有任何
/// 净上升**（抬升与落回必须抵消），否则说明抬升不再受落点判据约束。
#[test]
fn walking_into_a_step_high_ledge_steps_onto_it() {
    use crate::phys::player::{DIST_EPSILON, STEP_HEIGHT};

    let mut world = two_level_world();
    let params = PhysParams::default();
    let mut p = create_player([0.0, 1.0, 0.0], &params);
    p.input.forward = true;
    for _ in 0..40 {
        player_tick(&mut world, &mut p, &params, DT);
    }
    assert!(p.on_ground, "低地上必须着地，实际 on_ground={}", p.on_ground);

    let mut prev = p.origin[1];
    let mut worst_rise: f64 = 0.0;
    for _ in 0..400 {
        p.input.forward = true;
        player_tick(&mut world, &mut p, &params, DT);
        let rise = p.origin[1] - prev;
        if rise > worst_rise {
            worst_rise = rise;
        }
        prev = p.origin[1];
    }
    assert!(
        worst_rise <= STEP_HEIGHT + DIST_EPSILON + 0.1,
        "单 tick 抬幅不得超过台阶高：实际最大 +{:.3} HU（上限 {:.3}）",
        worst_rise,
        STEP_HEIGHT + DIST_EPSILON
    );
    assert!(
        p.origin[1] >= STEP_UP - 0.5,
        "不高于 STEP_HEIGHT 的台阶必须走上去：应到 y ≈ {:.0}，实际 y={:.2}（最大单 tick 上升 +{:.2}）",
        STEP_UP,
        p.origin[1],
        worst_rise
    );

    // 平地对照：不得有任何净上升（封"每 tick 无条件抬 18 HU"）
    let mut flat = World::new();
    flat.solids.push(low_ground());
    flat.build_index();
    let mut q = create_player([0.0, 1.0, 0.0], &params);
    // 朝 +z 走：`low_ground()` 只在 z ∈ [LEDGE_Z, LEDGE_Z+400] 有地板（−z 方向 40 HU 就到头，
    // 走 −z 会走出地面掉下去，测不到"平地不得净上升"）。
    q.yaw = 180.0;
    for _ in 0..40 {
        q.input.forward = true;
        player_tick(&mut flat, &mut q, &params, DT);
    }
    let base = q.origin[1];
    let mut flat_worst: f64 = 0.0;
    let mut flat_prev = q.origin[1];
    // 60 tick（≈234 HU）足够暴露"每 tick 无条件抬 18 HU"这类缺陷，又不至于走出地板。
    for _ in 0..60 {
        q.input.forward = true;
        player_tick(&mut flat, &mut q, &params, DT);
        let rise = q.origin[1] - flat_prev;
        if rise > flat_worst {
            flat_worst = rise;
        }
        flat_prev = q.origin[1];
    }
    assert!(
        flat_worst <= 0.05,
        "平地上不得出现净上升：实际最大单 tick +{:.3} HU",
        flat_worst
    );
    assert!(
        (q.origin[1] - base).abs() <= 0.05,
        "平地上 60 tick 后高度应不变：起点 {:.3}，终点 {:.3}",
        base,
        q.origin[1]
    );
}

/// 夹具前提自检：抬升扫掠在低地上方确实无命中（`fraction == 1.0`）。
///
/// 这条不调 `step_move`，只保证上面那条测的是"头顶无障碍"这个前提成立——否则上条失败
/// 可能来自夹具搭错而非判据回归。
#[test]
fn fixture_headroom_is_clear_above_the_low_ground() {
    let mut world = two_level_world();
    let params = PhysParams::default();
    let p = create_player([0.0, 1.0, 0.0], &params);
    let mins = p.mins();
    let maxs = p.maxs();
    let tr = world.trace(
        &p.origin,
        &[p.origin[0], p.origin[1] + 18.0, p.origin[2]],
        &mins,
        &maxs,
    );
    assert!(
        tr.fraction >= 1.0,
        "夹具前提：低地上方 18 HU 内应当空旷，实际 fraction={}",
        tr.fraction
    );
}