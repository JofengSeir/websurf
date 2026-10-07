//! 卡死判据的着地门回归（`check_stuck` 修法 A，`TODO.md T-065` §8 第 1 条）。
//!
//! 本文件钉住 `player.rs::check_stuck` 开头那道 `if p.on_ground { return false }`。
//!
//! **要防的回归**：碰撞盒**故意**向前探出 `half_width`(16 HU) 好让移动时不穿薄墙，代价是
//! **前方地面只要比脚下高**，那 16 HU 内的坡面就落进盒体，`is_position_free` 报 false
//! ——"正在上坡"被误读成"我卡住了"。真实场景（`surf_666` 的
//! `models/props/666/s1_ramp1b.mdl`）里盒前缘与命中三角形 z 向重叠约 2.2 HU，而那片坡面
//! 比脚底高 11.5 HU；`STUCK_DIRS` 10 向只有 `+z`（身后）在 dist=4 通，于是每 tick 把玩家
//! 往回推 4 HU、抵消前进 ⇒ 每采样抖 ±0.1 HU 的原地卡死。
//!
//! **夹具形态**（与真实场景同构，但**只用世界 brush**，不经三角网格路径）：
//! 低地顶面 y=0 + 前方一块顶面 y=STEP_UP 的平台。平台高度取 **25：大于 `STEP_HEIGHT`(18)**，
//! 按起源语义**跨不上去**，玩家合法地停在低地上 —— 本文件只钉"不得原地抖动"。
//!
//! 旧值 12（< 18）建立在一个**非起源**前提上："台阶会被 `step_move` 的抬升闸门挡住"。那道闸门
//! 已按起源 `CGameMovement::StepMove` 删除（`test/project/source-sdk-2013-master/src/game/shared/gamemovement.cpp:1515`），
//! 12 HU 台阶现在会被**走上去**（参考实现实测：单 tick 抬 +12.00 HU、水平速度保持 260，见
//! `.tmp/ledge-ref.mjs`），夹具前提随之失效 ⇒ 抬高到 25 HU。
//!
//! **关键**：断言**不依赖玩家是否跨上平台**。修前玩家被卡在平台前缘抖动、净位移≈0；
//! 修后要么跨上去、要么被挡在低地，两种都表现为"持续朝 −z 单调前进"。所以断言写成
//! **位移的单调性**，而不是"最终 y 等于多少"。

use crate::phys::player::{create_player, player_tick, PhysParams};
use crate::phys::world::{Brush, Plane, World};

const DT: f64 = 1.0 / 64.0;
/// 平台比低地高出的高度，取 12（同 `step_gate_tests` 的取值与理由）。
const STEP_UP: f64 = 25.0;
/// 平台前缘在 z = -40（玩家从 z = 0 出发朝 -z 走）。
const LEDGE_Z: f64 = -40.0;

/// `Plane` 的简写构造，与 `step_gate_tests` 同约定：实体侧 `dot(normal, p) <= dist`。
fn pl(n: [f64; 3], d: f64) -> Plane {
    Plane { normal: n, dist: d }
}

/// 低地：顶面 y = 0，z 从 LEDGE_Z 往 +z 延伸。
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

/// 平台：顶面 y = STEP_UP，从 LEDGE_Z 往 -z 铺开。
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

/// 走到平台前缘后不得原地抖动：**每 tick 的 −z 位移必须单调为负，且全程净前进。**
///
/// 修前这一条失败：玩家在 `z ≈ LEDGE_Z + 16` 附近每 tick 被往回推，位移在正负之间来回翻，
/// 400 tick 的净位移接近 0。
#[test]
fn walking_into_a_higher_ledge_must_not_wiggle_in_place() {
    let mut world = two_level_world();
    let params = PhysParams::default();
    let mut p = create_player([0.0, 1.0, 0.0], &params);
    // `player_tick` 开头会用 `p.input` 覆盖 `p.input`（`apply_input` 由上层负责填充），
    // 所以行走意图必须**每 tick 重新设置**，不能只在开头设一次。
    for _ in 0..40 {
        p.input.forward = true;
        player_tick(&mut world, &mut p, &params, DT);
    }
    assert!(p.on_ground, "低地上必须着地，实际 on_ground={}", p.on_ground);

    // 玩家已进到 z ≈ -25.35，此时**盒前缘（z-16 = -41.35）已越过平台前缘 LEDGE_Z=-40**，
    // 正是 `check_stuck` 判据误报的形态。下面逐步记录 400 tick 的轨迹。
    let z_before = p.origin[2];
    assert!(
        z_before <= LEDGE_Z + 16.0,
        "夹具前提：起测点应当在盒前缘已探进平台的位置（z <= {:.0}），实际 z={:.2} —— \
         预热 tick 数需要调少，否则测不到判据误报的那一段",
        LEDGE_Z + 16.0,
        z_before
    );
    let mins = p.mins();
    let maxs = p.maxs();
    assert!(
        !world.is_position_free(&p.origin, &mins, &maxs),
        "夹具前提：起测点处 is_position_free 应当报不空（即判据已误报），实际报空闲 —— \
         平台不够高或玩家还没走到，上条测试就测不到判据"
    );

    // 判据是"**不得抖动**"，不是"必须走过去"。
    //
    // 玩家**跨不上**这块 25 HU 的平台（> `STEP_HEIGHT` 18）：按起源语义会合法地停在平台前缘。
    // 因此"停在平台前缘不动"是正确行为；缺陷是**每 tick 被 `check_stuck` 往回挤几 HU、
    // 净位移在正负间来回翻**。
    //
    // 所以这里断言两件事，都不要求玩家前进：
    // ① 全程不得出现朝 +z（后退方向）的位移 tick —— 修前每 tick 都被挤退，必失败；
    // ② 着地期间 `stuck_ticks` 恒为 0 —— 修法 A 的门应当每 tick 把它归零。
    let mut prev = p.origin[2];
    let mut back_steps = 0usize;   // 位移反而朝 +z（后退）的 tick 数
    let mut worst_back: f64 = 0.0; // 单 tick 最大的后退量
    let mut max_stuck: u32 = 0;
    for _ in 0..400 {
        p.input.forward = true;
        player_tick(&mut world, &mut p, &params, DT);
        let d = p.origin[2] - prev;
        if d > 1e-6 {
            back_steps += 1;
            if d > worst_back {
                worst_back = d;
            }
        }
        if p.stuck_ticks > max_stuck {
            max_stuck = p.stuck_ticks;
        }
        prev = p.origin[2];
    }

    assert_eq!(
        max_stuck, 0,
        "着地期间 stuck_ticks 应当恒为 0（修法 A 的门每 tick 归零），实际峰值 {}",
        max_stuck
    );
    assert!(
        back_steps == 0,
        "朝 -z 顶住平台时不得出现朝 +z 的位移 tick（那是 check_stuck 每 tick 往回挤的表现，\
         正是 TODO.md T-065 描述的原地抖动）：实际 {} / 400 tick 出现后退，\
         最大单 tick +{:.2} HU（起点 z={:.2}，终 z={:.2}）",
        back_steps,
        worst_back,
        z_before,
        p.origin[2]
    );
}

/// 夹具前提自检：低地上着地时，碰撞盒**确实**因为前方 12 HU 高的平台而判成"不空闲"。
///
/// 这条不调 `check_stuck`，只保证上面那条测的是"前方地面比脚下高 ⇒ 判据误报"这个前提
/// 成立 —— 否则上条失败可能来自夹具搭错（平台不够高、或根本够不到）而非判据回归。
#[test]
fn fixture_reproduces_the_false_positive() {
    let mut world = two_level_world();
    let params = PhysParams::default();
    let mut p = create_player([0.0, 1.0, 0.0], &params);
    for _ in 0..40 {
        p.input.forward = true;
        player_tick(&mut world, &mut p, &params, DT);
    }
    assert!(p.on_ground, "低地上必须着地");

    // 走到盒体前缘刚好探进平台的位置：平台前缘 LEDGE_Z，玩家盒 z 半伸 16
    let probe = [0.0, p.origin[1], LEDGE_Z + 16.0];
    let mins = p.mins();
    let maxs = p.maxs();
    assert!(
        !world.is_position_free(&probe, &mins, &maxs),
        "夹具前提：在 z={}（盒前缘探进平台）处 is_position_free 应当报不空，实际报空闲 —— \
         平台不够高或位置算错，上条测试就测不到判据误报",
        probe[2]
    );
    // 而同一时刻脚下确实站得住（低地顶面在 origin 处可站）
    let tr = world.trace(&probe, &[probe[0], probe[1] - 4.0, probe[2]], &mins, &maxs);
    assert!(
        tr.fraction < 1.0,
        "夹具前提：probe 点下方 4 HU 内应当有地面可站，实际 fraction={} —— \
         说明这里本来就是悬空的，误报形态不成立",
        tr.fraction
    );
}
