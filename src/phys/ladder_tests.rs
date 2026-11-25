//! 梯子回归（4 项）：朝向按玩家方位选面、盒子梯子能真的往上爬、
//! 实体梯子随实体碰撞状态启停（隐形梯修复）、运行期平移梯子。
//!
//! 病灶一（owner 2026-11-24 报「梯子无法正常使用，只能挂上去」）：`compute_ladder_facing` 对
//! 盒子梯子（四个竖直面水平分量都是 1）用「取最大」+严格大于，会按平面顺序选中任意一面，
//! 可能是**切线方向**（沿 X 或 Z）；`ladder_move` 用这个 facing 当攀爬基，wish 的垂直分量
//! ≈ 0、横向分量变成推墙 ⇒ 玩家挂住不上升。修法：`LadderVolume::facing_toward` 按玩家到
//! AABB 最近点的方位，在竖直面法线里选朝向玩家的一面。
//!
//! 病灶二（同报告「地图中的梯子是没显示的时候也可以挂上去」）：门实体（`func_door`
//! spawnpos=1，内部带 LADDER 面）出生即隐藏/非实心，但 `World::ladder_at` 不复核实体状态
//! ⇒ 隐形梯仍可攀爬。修法：`LadderVolume.entity` + `ladder_is_active` 过滤。
//!
//! 本文件直接驱动 `World` + `player_tick`（不经 wasm），夹具用闭合盒子构造梯子体；
//! 实体梯子的 `entity_solid` 视为「门当前是否实心/可见」。

use crate::phys::player::{create_player, player_tick, PhysParams};
use crate::phys::world::{Brush, LadderVolume, Plane, World, V3};

/// 测试用步长（100 Hz；攀爬用 LADDER_SPEED 与步长无关，取整数步便于读数）。
const DT: f64 = 1.0 / 100.0;
/// 实体梯子所属实体下标。
const ENTITY: i32 = 7;

fn pl(normal: [f64; 3], dist: f64) -> Plane {
    Plane { normal, dist }
}

/// 闭合盒子平面（法线朝外）。**故意把 +X 面排在第一个**：旧 `compute_ladder_facing`
/// 会把它当作 facing，正好复现「切线朝向」病灶。
fn box_planes(min: [f64; 3], max: [f64; 3]) -> Vec<Plane> {
    let mut planes = Vec::with_capacity(6);
    planes.push(pl([1.0, 0.0, 0.0], max[0]));
    planes.push(pl([-1.0, 0.0, 0.0], -min[0]));
    for axis in 1..3 {
        let mut normal = [0.0; 3];
        normal[axis] = 1.0;
        planes.push(pl(normal, max[axis]));
        normal[axis] = -1.0;
        planes.push(pl(normal, -min[axis]));
    }
    planes
}

fn box_brush(min: [f64; 3], max: [f64; 3], entity: i32) -> Brush {
    Brush {
        planes: box_planes(min, max),
        min,
        max,
        entity,
    }
}

/// 梯子体：x ∈ [-50, 50]、y ∈ [0, 200]、z ∈ [-10, 10]；`facing` 兜底值故意给成切线 (+X)。
fn ladder_volume(entity: i32) -> LadderVolume {
    let min: V3 = [-50.0, 0.0, -10.0];
    let max: V3 = [50.0, 200.0, 10.0];
    LadderVolume {
        planes: box_planes(min, max),
        min,
        max,
        facing: [1.0, 0.0, 0.0], // 故意给「切线方向」，正常攀爬不许依赖它
        entity,
    }
}

/// 世界地板：顶面 y = 0。
fn floor() -> Brush {
    box_brush([-4000.0, -100.0, -4000.0], [4000.0, 0.0, 4000.0], -1)
}

/// 地板 + 一个梯子；`entity >= 0` 时按 `start_solid` 置实体碰撞状态。
fn ladder_world(entity: i32, start_solid: bool) -> World {
    let mut w = World::new();
    w.solids.push(floor());
    w.ladders.push(ladder_volume(entity));
    if entity >= 0 {
        w.entity_solid = vec![start_solid; entity as usize + 1];
    }
    w.build_index();
    w.capture_base_solids();
    w
}

/// 出生在地板上、梯子前方 40 HU（不重叠，避免下落途中被「空中自动抓梯」先抓住）。
fn player_before_ladder(params: &PhysParams) -> crate::phys::player::Player {
    create_player([0.0, 1.0, 40.0], params)
}

fn settle(w: &mut World, p: &mut crate::phys::player::Player, params: &PhysParams) {
    for _ in 0..60 {
        player_tick(w, p, params, DT);
    }
    assert!(p.on_ground, "静置后应停在地板上（实际 on_ground={}）", p.on_ground);
}

/// 按住前进 `ticks` 步，返回是否曾抓住梯子。
fn walk_forward(
    w: &mut World,
    p: &mut crate::phys::player::Player,
    params: &PhysParams,
    ticks: usize,
) -> bool {
    let mut grabbed = false;
    p.input.forward = true;
    for _ in 0..ticks {
        player_tick(w, p, params, DT);
        grabbed |= p.on_ladder.is_some();
    }
    grabbed
}

#[test]
fn facing_toward_follows_player_side_not_plane_order() {
    let lv = ladder_volume(-1);
    // 站在 +z 一侧：朝向必须是 +z 面（不是平面列表第一个的 +x）。
    assert_eq!(lv.facing_toward(&[0.0, 50.0, 80.0]), [0.0, 0.0, 1.0]);
    // 站在 −x 一侧。
    assert_eq!(lv.facing_toward(&[-80.0, 50.0, 0.0]), [-1.0, 0.0, 0.0]);
    // 站在 +x 一侧。
    assert_eq!(lv.facing_toward(&[80.0, 50.0, 0.0]), [1.0, 0.0, 0.0]);
}

#[test]
fn climbing_a_box_ladder_rises_at_ladder_speed() {
    let params = PhysParams::default();
    let mut w = ladder_world(-1, true);
    let mut p = player_before_ladder(&params);
    settle(&mut w, &mut p, &params);

    let start_y = p.origin[1];
    let attached = walk_forward(&mut w, &mut p, &params, 40);
    let climbed = p.origin[1] - start_y;
    assert!(attached, "按住前进应能抓住梯子");
    assert!(
        climbed > 50.0,
        "0.4 s 应爬约 80 HU（LADDER_SPEED=200），实际 {climbed:.2} HU —— 若 ≈0 说明 facing 选到了切线方向"
    );
}

#[test]
fn hidden_entity_ladder_cannot_be_grabbed() {
    let params = PhysParams::default();
    let mut w = ladder_world(ENTITY, false); // 门出生即隐藏/非实心
    let mut p = player_before_ladder(&params);
    settle(&mut w, &mut p, &params);

    let start_y = p.origin[1];
    let grabbed = walk_forward(&mut w, &mut p, &params, 120);
    assert!(!grabbed, "非实心实体里的梯子不应可攀爬（隐形梯）");
    assert!(
        (p.origin[1] - start_y).abs() < 1.0,
        "不应上升：实际 Δy = {:.2}",
        p.origin[1] - start_y
    );

    // 实体恢复实心后，同样的走法应能抓住（同一帧语义，另起一个玩家）。
    w.set_entity_solid(ENTITY as usize, true);
    let mut p2 = player_before_ladder(&params);
    settle(&mut w, &mut p2, &params);
    let grabbed2 = walk_forward(&mut w, &mut p2, &params, 120);
    assert!(grabbed2, "实体恢复实心后梯子应可攀爬");
}

#[test]
fn runtime_toggle_detaches_and_world_ladder_is_unaffected() {
    let params = PhysParams::default();
    // 实体梯子：正在爬时把它设为非实心 ⇒ 下一 tick 脱附。
    let mut w = ladder_world(ENTITY, true);
    let mut p = player_before_ladder(&params);
    settle(&mut w, &mut p, &params);
    let attached = walk_forward(&mut w, &mut p, &params, 20);
    assert!(attached && p.on_ladder.is_some(), "先应抓住实体梯子");
    w.set_entity_solid(ENTITY as usize, false);
    player_tick(&mut w, &mut p, &params, DT);
    assert!(p.on_ladder.is_none(), "实体变非实心后应立刻脱附");

    // 世界梯子（entity=-1）不受 entity_solid 影响。
    let mut w = ladder_world(-1, true);
    w.entity_solid = vec![false; ENTITY as usize + 1];
    let mut p = player_before_ladder(&params);
    settle(&mut w, &mut p, &params);
    let grabbed = walk_forward(&mut w, &mut p, &params, 120);
    assert!(grabbed, "世界梯子（entity=-1）不应受实体状态影响");
}

#[test]
fn offset_translates_ladder_with_its_entity() {
    let mut w = ladder_world(ENTITY, true);
    let hull_mins: V3 = [-16.0, 0.0, -16.0];
    let hull_maxs: V3 = [16.0, 72.0, 16.0];
    // 基准：玩家盒在梯子 AABB 内（原点 [0,10,0]）。
    assert!(w.ladder_at(&[0.0, 10.0, 0.0], &hull_mins, &hull_maxs).is_some());

    // 梯子里属于实体的 brush 一起上移 100：旧位置不再命中、新位置命中，AABB 同步。
    assert_eq!(w.set_entity_offset(ENTITY, [0.0, 100.0, 0.0]), 0); // 纯梯子没有 solid brush
    let lv = &w.ladders[0];
    assert_eq!(lv.min[1], 100.0);
    assert_eq!(lv.max[1], 300.0);
    assert!(w.ladder_at(&[0.0, 10.0, 0.0], &hull_mins, &hull_maxs).is_none());
    assert!(w.ladder_at(&[0.0, 110.0, 0.0], &hull_mins, &hull_maxs).is_some());
}

#[test]
fn thin_solid_ladder_blocks_clip_and_climbs_via_build_world() {
    use crate::phys::PhysWorld;

    let to_planes_json = |min: [f32; 3], max: [f32; 3]| {
        serde_json::json!([
            { "normal": [1.0, 0.0, 0.0], "dist": max[0] },
            { "normal": [-1.0, 0.0, 0.0], "dist": -min[0] },
            { "normal": [0.0, 1.0, 0.0], "dist": max[1] },
            { "normal": [0.0, -1.0, 0.0], "dist": -min[1] },
            { "normal": [0.0, 0.0, 1.0], "dist": max[2] },
            { "normal": [0.0, 0.0, -1.0], "dist": -min[2] },
        ])
    };

    let brushes_json = serde_json::json!([
        {
            "planes": to_planes_json([-300.0, -32.0, -300.0], [300.0, 0.0, 300.0]),
            "min": [-300.0, -32.0, -300.0],
            "max": [300.0, 0.0, 300.0],
            "is_ladder": false,
            "is_solid": true,
            "entity": -1,
            "start_solid": true,
        },
        // 真实 BSP 梯子特征：1 HU 薄板且同时 is_ladder + is_solid
        {
            "planes": to_planes_json([-50.0, 0.0, 0.0], [50.0, 200.0, 1.0]),
            "min": [-50.0, 0.0, 0.0],
            "max": [50.0, 200.0, 1.0],
            "is_ladder": true,
            "is_solid": true,
            "entity": -1,
            "start_solid": true,
        },
    ])
    .to_string();
    let mut pw = PhysWorld::new();
    pw.build_world(
        &brushes_json,
        "[]",
        r#"{"teleports":[],"triggers":[]}"#,
        0.0,
        2.0,
        32.0,
        0.0,
    )
    .expect("build_world");
    assert_eq!(pw.world.ladders.len(), 1);
    assert_eq!(pw.world.solids.len(), 2, "实心梯子必须同时进入 solids 与 ladders");

    let params = PhysParams::default();
    let mut p = create_player([0.0, 2.0, 32.0], &params);
    p.pitch = 45.0;
    for _ in 0..10 {
        player_tick(&mut pw.world, &mut p, &params, DT);
    }
    p.input.forward = true;
    let mut grabbed = false;
    for _ in 0..60 {
        player_tick(&mut pw.world, &mut p, &params, DT);
        grabbed |= p.on_ladder.is_some();
    }
    assert!(grabbed && p.on_ladder.is_some(), "贴到 1 HU 实心梯面外侧应能正常抓住梯子");
    assert!(p.origin[1] > 40.0, "抓住后应顺利向上攀爬，实际 y={}", p.origin[1]);
    assert!(
        p.origin[2] >= 16.9,
        "不应穿透 1 HU 实心梯子，实际 z={}",
        p.origin[2]
    );
}

#[test]
fn strafing_near_ladder_edge_locks_facing_and_climbs() {
    let min: V3 = [-10.0, 0.0, -2.0];
    let max: V3 = [10.0, 200.0, 2.0];
    let mut w = World::new();
    w.solids.push(box_brush([-300.0, -32.0, -300.0], [300.0, 0.0, 300.0], -1));
    w.solids.push(box_brush(min, max, -1));
    w.ladders.push(LadderVolume {
        planes: box_planes(min, max),
        min,
        max,
        facing: [1.0, 0.0, 0.0],
        entity: -1,
    });
    w.build_index();

    let params = PhysParams::default();
    let mut p = create_player([0.0, 2.0, 24.0], &params);
    p.pitch = 45.0;
    settle(&mut w, &mut p, &params);
    p.input.forward = true;
    for _ in 0..30 {
        player_tick(&mut w, &mut p, &params, DT);
    }
    assert!(p.on_ladder.is_some(), "应已抓住窄梯");
    assert!((p.ladder_facing[2] - 1.0).abs() < 1e-6);

    // 贴着 +X 侧边斜向攀爬时，ladder_facing 应保持锁定，不会翻面卡死
    p.input.right = true;
    for _ in 0..40 {
        player_tick(&mut w, &mut p, &params, DT);
    }
    assert!(
        (p.ladder_facing[2] - 1.0).abs() < 1e-6,
        "同梯攀爬期间不应翻面，实际 facing={:?}",
        p.ladder_facing
    );
    assert!(p.origin[1] > 40.0, "边平移边爬应继续上升，实际 y={}", p.origin[1]);
}

#[test]
fn non_solid_ladder_blocks_clip_and_set_state_syncs_ladder_attachment() {
    use crate::phys::PhysWorld;

    let to_planes_json = |min: [f32; 3], max: [f32; 3]| {
        serde_json::json!([
            { "normal": [1.0, 0.0, 0.0], "dist": max[0] },
            { "normal": [-1.0, 0.0, 0.0], "dist": -min[0] },
            { "normal": [0.0, 1.0, 0.0], "dist": max[1] },
            { "normal": [0.0, -1.0, 0.0], "dist": -min[1] },
            { "normal": [0.0, 0.0, 1.0], "dist": max[2] },
            { "normal": [0.0, 0.0, -1.0], "dist": -min[2] },
        ])
    };

    let brushes_json = serde_json::json!([
        {
            "planes": to_planes_json([-300.0, -32.0, -300.0], [300.0, 0.0, 300.0]),
            "min": [-300.0, -32.0, -300.0],
            "max": [300.0, 0.0, 300.0],
            "is_ladder": false,
            "is_solid": true,
            "entity": -1,
            "start_solid": true,
        },
        // 真实地图（如 ze_cursed_bear_tales / surf_*）里的纯 CONTENTS_LADDER 刷子（is_solid=false）
        {
            "planes": to_planes_json([-50.0, 0.0, 0.0], [50.0, 200.0, 1.0]),
            "min": [-50.0, 0.0, 0.0],
            "max": [50.0, 200.0, 1.0],
            "is_ladder": true,
            "is_solid": false,
            "entity": -1,
            "start_solid": true,
        },
    ])
    .to_string();

    let mut pw = PhysWorld::new();
    pw.build_world(
        &brushes_json,
        "[]",
        r#"{"teleports":[],"triggers":[]}"#,
        0.0,
        2.0,
        32.0,
        0.0,
    )
    .expect("build_world");
    assert_eq!(pw.world.ladders.len(), 1);
    assert_eq!(pw.world.solids.len(), 2, "纯 LADDER 刷子也必须进入 solids 防穿透");

    let params = PhysParams::default();
    let mut p = create_player([0.0, 2.0, 32.0], &params);
    p.pitch = 45.0;
    for _ in 0..10 {
        player_tick(&mut pw.world, &mut p, &params, DT);
    }
    p.input.forward = true;
    for _ in 0..60 {
        player_tick(&mut pw.world, &mut p, &params, DT);
    }
    assert!(p.on_ladder.is_some(), "纯 LADDER 刷子外侧应能抓住梯子");
    assert!(p.origin[1] > 40.0, "抓住后应顺利攀爬，实际 y={}", p.origin[1]);
    assert!(p.origin[2] >= 16.9, "不应穿透纯 LADDER 刷子，实际 z={}", p.origin[2]);

    // set_state 重锚到梯子外侧（离地）应立即附着，重锚到远离梯子处应清除 on_ladder
    pw.set_state(0.0, 50.0, 17.0, 0.0, 0.0, 0.0, 0.0, 0.0, false);
    assert_eq!(pw.player.on_ladder, Some(0), "set_state 重锚贴梯离地应附着到梯子");
    pw.set_state(0.0, 50.0, 200.0, 0.0, 0.0, 0.0, 0.0, 0.0, false);
    assert_eq!(pw.player.on_ladder, None, "set_state 移离梯子后必须清除旧 on_ladder");
}

#[test]
fn sloped_45_degree_ladder_climbs_along_slope() {
    let s = std::f64::consts::FRAC_1_SQRT_2;
    let min: V3 = [-50.0, 0.0, -50.0];
    let max: V3 = [50.0, 100.0, 50.0];
    // 45° 斜梯：法线 [0, s, s]，沿 -Z/+Y 方向倾斜上升
    let planes = vec![
        Plane { normal: [1.0, 0.0, 0.0], dist: 50.0 },
        Plane { normal: [-1.0, 0.0, 0.0], dist: 50.0 },
        Plane { normal: [0.0, 1.0, 0.0], dist: 100.0 },
        Plane { normal: [0.0, -1.0, 0.0], dist: 0.0 },
        Plane { normal: [0.0, s, s], dist: 0.0 },
        Plane { normal: [0.0, -s, -s], dist: 4.0 },
    ];
    let mut w = World::new();
    w.solids.push(box_brush([-300.0, -32.0, -300.0], [300.0, 0.0, 300.0], -1));
    w.solids.push(Brush { planes: planes.clone(), min, max, entity: -1 });
    w.ladders.push(LadderVolume { planes, min, max, facing: [0.0, s, s], entity: -1 });
    w.build_index();

    let params = PhysParams::default();
    let mut p = create_player([0.0, 2.0, 40.0], &params);
    p.pitch = 30.0;
    settle(&mut w, &mut p, &params);
    p.input.forward = true;
    let mut grabbed = false;
    for _ in 0..45 {
        player_tick(&mut w, &mut p, &params, DT);
        grabbed |= p.on_ladder.is_some();
    }
    assert!(grabbed && p.on_ladder.is_some(), "应能抓住 45° 斜梯");
    assert!(p.origin[1] > 30.0, "沿斜梯应顺利上升，实际 y={}", p.origin[1]);
}

#[test]
fn horizontal_overhead_ladder_moves_horizontally_without_falling() {
    let min: V3 = [-100.0, 80.0, -100.0];
    let max: V3 = [100.0, 84.0, 100.0];
    let mut w = World::new();
    w.solids.push(box_brush([-300.0, -32.0, -300.0], [300.0, 0.0, 300.0], -1));
    w.solids.push(box_brush(min, max, -1));
    w.ladders.push(LadderVolume {
        planes: box_planes(min, max),
        min,
        max,
        facing: [0.0, -1.0, 0.0],
        entity: -1,
    });
    w.build_index();

    let params = PhysParams::default();
    // 玩家头顶（maxs.y = 72）贴到 y=80 的水平天花梯（origin.y = 8.0）
    let mut p = create_player([0.0, 8.0, 40.0], &params);
    p.on_ground = false;
    p.input.forward = true;
    for _ in 0..50 {
        player_tick(&mut w, &mut p, &params, DT);
    }
    assert!(p.on_ladder.is_some(), "空中贴到水平天花梯应能抓住");
    assert!((p.origin[1] - 8.0).abs() < 1.5, "挂在水平梯上不应下坠，实际 y={}", p.origin[1]);
    assert!(p.origin[2] < -20.0, "在水平梯上应能水平移动，实际 z={}", p.origin[2]);
}

#[test]
fn pressing_back_on_ground_detaches_from_ladder() {
    let params = PhysParams::default();
    let mut w = ladder_world(-1, true);
    let mut p = player_before_ladder(&params);
    p.pitch = 45.0;
    p.input.forward = true;
    for _ in 0..20 {
        player_tick(&mut w, &mut p, &params, DT);
    }
    assert!(p.on_ladder.is_some());

    // 退回地面后按 S 远离梯子应顺利脱离
    p.input.forward = false;
    p.input.back = true;
    for _ in 0..40 {
        player_tick(&mut w, &mut p, &params, DT);
    }
    assert!(p.on_ladder.is_none(), "在地面按 S 远离梯子后应脱离梯子");
}

#[test]
fn steep_upward_pitch_grabs_ladder_and_embedded_ladder_ejects_cleanly() {
    let min: V3 = [10974.0, 880.0, -2932.0];
    let max: V3 = [10975.0, 1536.0, -2892.0];
    let mut w = World::new();
    w.solids.push(box_brush([10800.0, 848.0, -3100.0], [11100.0, 880.0, -2800.0], -1));
    w.solids.push(box_brush(min, max, -1));
    w.ladders.push(LadderVolume {
        planes: box_planes(min, max),
        min,
        max,
        facing: [-1.0, 0.0, 0.0],
        entity: -1,
    });
    w.build_index();

    // 1. 复现用户截图视角：yaw = -28.4, pitch = 73.7 仰视，站在地面按 W 走进梯面
    let params = PhysParams::default();
    let mut p = create_player([10950.0, 882.0, -2901.0], &params);
    p.yaw = -28.4;
    p.pitch = 73.7;
    settle(&mut w, &mut p, &params);
    p.input.forward = true;
    for _ in 0..50 {
        player_tick(&mut w, &mut p, &params, DT);
    }
    assert!(p.on_ladder.is_some(), "大仰角仰视（pitch=73.7°）按 W 走进梯子应能抓住");
    assert!(p.origin[1] > 900.0, "抓住后应顺利攀爬，实际 y={}", p.origin[1]);
    assert!(p.origin[0] <= 10958.5, "不应穿透梯面，实际 x={}", p.origin[0]);

    // 2. 轻微嵌入 1 HU 梯体 6 HU（例如移动门推入玩家）时，应自动推出至正面并正常攀爬
    let mut p2 = create_player([10964.0, 920.0, -2912.0], &params);
    p2.yaw = -90.0;
    p2.pitch = 45.0;
    p2.on_ground = false;
    p2.input.forward = true;
    for _ in 0..40 {
        player_tick(&mut w, &mut p2, &params, DT);
    }
    assert!(p2.on_ladder.is_some(), "嵌入梯体后仍应保持抓梯");
    assert!(p2.origin[0] <= 10958.5, "嵌入后应被推出到梯前而非挤穿背面，实际 x={}", p2.origin[0]);
    assert!(p2.origin[1] > 960.0, "推出后应继续攀爬上升，实际 y={}", p2.origin[1]);
}



