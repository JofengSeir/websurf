//! 贴面推开的**步长无关性**回归（2 项）：`try_player_move` 的"撞面沿法线推开"不得按调用次数累积位移。
//!
//! 病灶（2026-10-07 owner 报「抵着墙走会往墙里挤一下又被弹回」）：旧口径在**每次撞面**后都沿命中
//! 法线推开 `PUSH_OUT`(0.1 HU)。这个位移与 `dt` 无关、与速度无关 —— 步长越小、单位时间里推的
//! 次数越多。主线程预测按**渲染帧**步进（高刷屏 320 Hz ⇒ 每步 `1/320 s`），于是：
//!
//! | 场景（真实地图 `surf_666`，真实 wasm 物理，同起手点同一输入） | `dt = 1/64` | `dt = 1/320` |
//! |---|---|---|
//! | 抵墙点按住前进 2.5 s | 4 步后停死、160/160 步无反向 | **800/800 步都在动，净 +40.21 HU** |
//! | 斜坡起步按住前进 2.5 s | 正常上坡 −33.57 HU | **反向下滑 +40.21 HU** |
//! | 平地助跑 2.5 s | −612.31 HU | −610.09 HU（一致） |
//!
//! 修法（`PhysParams::push_out_only_when_solid`，默认 true）：推开**只在"起点已在实体内"
//! （`trace.startsolid`）时**执行 —— 那才是它本来要解决的问题（贴面死锁）；"滑行中擦到面"不再推。
//! 实测同一组场景：抵墙点 320 Hz 变成 **19/800 步动过、0 次反向**（与 64 Hz 一致），
//! 斜坡 320 Hz 变成 **−33.67 HU 正常上坡**，平地逐字节相同。
//!
//! 夹具：45° 坡（表面 `y = -z`）+ 坡上 40 HU 处一堵迎面墙。玩家从坡上朝 −z（上坡）按住前进：
//! - 修前（每次撞面都推）：贴墙后每一步都被推着沿坡下滑 ⇒ 净位移**为正**（向 +z）；
//! - 修后（仅嵌入时推）：上坡 ≈24 HU 后顶住墙**停死**，不得出现任何一次向 +z 的位移。
//!
//! 本文件的两项互为对照：第二项把旧口径显式打开并断言"确实会下滑"，因此它不是复述实现，
//! 而是钉住"夹具对这个缺陷敏感" —— 撤掉修复（把默认改回 false）第一项必 FAIL。

use crate::phys::player::{create_player, player_tick, PhysParams};
use crate::phys::world::{Brush, Plane, World};

/// 高刷屏的步长：主线程预测在 320 fps 下的实际 `dt`。
const DT_SMALL: f64 = 1.0 / 320.0;
/// 采样步数：2.5 s（= 800 × 1/320）。
const STEPS: usize = 800;
/// 玩家起手点（坡上）：表面 `y = -z` ⇒ 坡面在 y = 100。
const START: [f64; 3] = [0.0, 101.0, -100.0];
/// 迎面墙的前缘 z：比起手点高 40 HU。
const WALL_Z: f64 = -140.0;
/// 一个步长内允许的"没动"判据（HU）。
const STILL_EPS: f64 = 1e-6;

/// `Plane` 的简写构造，与 `step_gate_tests` / `stuck_gate_tests` 同约定：实体侧 `dot(normal, p) <= dist`。
fn pl(n: [f64; 3], d: f64) -> Plane {
    Plane { normal: n, dist: d }
}

/// 45° 坡：**实体侧 `y + z <= 0`**，即表面 `y = -z`（z 越小越高 —— 玩家朝 −z 走就是上坡）。
/// 坡面法线 `(0, 0.70710678, 0.70710678)`（`ny = 0.7071 >= STANDABLE_NORMAL(0.7)`，可站）。
fn ramp() -> Brush {
    const S: f64 = std::f64::consts::FRAC_1_SQRT_2;
    Brush {
        planes: vec![
            pl([0.0, S, S], 0.0),        // 表面：y + z <= 0
            pl([0.0, -1.0, 0.0], 400.0), // 底面：y >= -400
            pl([1.0, 0.0, 0.0], 2000.0),
            pl([-1.0, 0.0, 0.0], 2000.0),
            pl([0.0, 0.0, 1.0], 0.0),      // 下坡端：z <= 0
            pl([0.0, 0.0, -1.0], 1500.0),  // 上坡端：z >= -1500
        ],
        min: [-2000.0, -400.0, -1500.0],
        max: [2000.0, 1500.0, 0.0],
    }
}

/// 迎面墙：占据 `z <= WALL_Z`，高度足够（顶面 y = 1600，远高于玩家能爬到的位置）。
fn wall() -> Brush {
    Brush {
        planes: vec![
            pl([0.0, 0.0, 1.0], WALL_Z),      // 迎着玩家的一面：z <= WALL_Z
            pl([0.0, 1.0, 0.0], 1600.0),      // 顶面
            pl([0.0, -1.0, 0.0], 2400.0),     // 底面
            pl([1.0, 0.0, 0.0], 2000.0),
            pl([-1.0, 0.0, 0.0], 2000.0),
            pl([0.0, 0.0, -1.0], 1900.0),     // 背面
        ],
        min: [-2000.0, -800.0, -1900.0],
        max: [2000.0, 1600.0, WALL_Z],
    }
}

/// 坡 + 墙的世界。
fn ramp_wall_world() -> World {
    let mut w = World::new();
    w.solids.push(ramp());
    w.solids.push(wall());
    w.build_index();
    w
}

/// 读数：净位移、向 +z（下坡）的步数、前 40 步之后的净位移（贴墙后的"停住没停住"）。
struct Run {
    net_dz: f64,
    net_dy: f64,
    downhill_steps: usize,
    /// 最后 200 步的位移模长之和：贴墙之后应当 ≈ 0。
    tail_move: f64,
}

/// 在坡上按住前进跑 `STEPS` 步（步长 `DT_SMALL`），统计位移。
fn walk_ramp(params: &PhysParams) -> Run {
    let mut world = ramp_wall_world();
    let mut p = create_player(START, params);
    // 先静置落地（不按键），避免起手那几帧的下落被算进位移
    for _ in 0..40 {
        player_tick(&mut world, &mut p, params, DT_SMALL);
    }
    assert!(p.on_ground, "坡上必须着地，实际 on_ground={}", p.on_ground);

    let start = p.origin;
    let mut prev = p.origin;
    let mut net_dz = 0.0;
    let mut net_dy = 0.0;
    let mut downhill_steps = 0usize;
    let mut tail_move = 0.0;
    for i in 0..STEPS {
        p.input.forward = true;
        player_tick(&mut world, &mut p, params, DT_SMALL);
        let ddz = p.origin[2] - prev[2];
        let ddy = p.origin[1] - prev[1];
        net_dz += ddz;
        net_dy += ddy;
        if ddz > STILL_EPS {
            downhill_steps += 1;
        }
        if i >= STEPS - 200 {
            tail_move += (ddz * ddz + ddy * ddy).sqrt();
        }
        prev = p.origin;
    }
    let _ = start;
    Run { net_dz, net_dy, downhill_steps, tail_move }
}

/// **修后口径**：320 Hz 步长下贴墙必须停死 —— 上坡到墙、此后不得出现任何一次下坡位移。
#[test]
fn pressing_into_a_wall_at_display_rate_does_not_creep_downhill() {
    let params = PhysParams::default();
    assert!(
        params.push_out_only_when_solid,
        "本测试的前提是默认只在嵌入时推开"
    );
    let r = walk_ramp(&params);
    assert!(
        r.net_dz < -10.0,
        "应沿坡爬上到墙（净 Δz 明显为负）：实际 净Δz={:.3} 净Δy={:.3} 下坡步数={}",
        r.net_dz,
        r.net_dy,
        r.downhill_steps
    );
    assert_eq!(
        r.downhill_steps, 0,
        "顶住墙之后不得有任何一次向 +z（下坡）的位移：实际 {} 次，净Δz={:.3}",
        r.downhill_steps, r.net_dz
    );
    assert!(
        r.tail_move < 1.0,
        "最后 200 步必须停死（位移模长之和 < 1 HU）：实际 {:.3} HU",
        r.tail_move
    );
}

/// **对照（缺陷留档）**：把"每次撞面都推开"显式打开 ⇒ 同一夹具**必定**被推着下滑。
/// 这一项同时证明夹具对该缺陷敏感 —— 第一项不是恒真的断言。
#[test]
fn pushing_out_on_every_contact_creeps_downhill_at_display_rate() {
    let mut params = PhysParams::default();
    params.push_out_only_when_solid = false;
    let r = walk_ramp(&params);
    assert!(
        r.net_dz > 5.0,
        "旧口径（每次撞面都推 0.1 HU）在 320 Hz 下应被推着下滑（净 Δz 明显为正）：实际 净Δz={:.3} 下坡步数={}",
        r.net_dz,
        r.downhill_steps
    );
}
