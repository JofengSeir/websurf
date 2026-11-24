//! 移动 brush（电梯 / 移动平台）回归：`World::set_entity_offset` 与
//! `PhysWorld::set_brush_offset` 的「几何平移 + 载客」语义。
//!
//! 场景与 `brush_solid_tests` 同约定：实体 brush 带 `entity` 归属，世界几何为 `-1`。
//! 钉三件事：
//! 1. 平移只作用于目标实体的 brush，位移以**基准快照**为准（绝对值，重复下发不漂移）；
//! 2. 位移影响碰撞查询（移动后的位置挡人、原位置让开），世界几何不受影响；
//! 3. 玩家站在被移动 brush 顶面时被一起带走（脚底 + 水平范围判定），悬空/不在其上不动。
//!
//! 载客判定的边界条件（脚底与顶面差 ≤ 2 HU、水平外扩 2 HU）见
//! `PhysWorld::carry_player_on_moved_brush` 文档；本文件用平台顶面站立的最小场景覆盖。

use super::world::{Brush, Plane, World, V3};
use crate::phys::PhysWorld;

const ENTITY: i32 = 7;

fn pl(normal: [f64; 3], dist: f64) -> Plane {
    Plane { normal, dist }
}

/// 闭合盒子（法线朝外）；`entity = -1` 表示世界几何。
fn box_brush(min: [f64; 3], max: [f64; 3], entity: i32) -> Brush {
    let mut planes = Vec::new();
    for axis in 0..3 {
        let mut normal = [0.0; 3];
        normal[axis] = 1.0;
        planes.push(pl(normal, max[axis]));
        normal[axis] = -1.0;
        planes.push(pl(normal, -min[axis]));
    }
    Brush {
        planes,
        min,
        max,
        entity,
    }
}

/// 平台（实体 brush）：y ∈ [0, 20]、x/z 各 ±100。
fn platform() -> Brush {
    box_brush([-100.0, 0.0, -100.0], [100.0, 20.0, 100.0], ENTITY)
}

/// 世界地板：y ∈ [-100, -80]，只用于兜底/判「世界几何不受影响」。
fn floor() -> Brush {
    box_brush([-4000.0, -100.0, -4000.0], [4000.0, -80.0, 4000.0], -1)
}

fn world_with_platform() -> World {
    let mut w = World::new();
    w.solids.push(floor());
    w.solids.push(platform());
    w.entity_solid = vec![true; ENTITY as usize + 1];
    w.build_index();
    w.capture_base_solids();
    w
}

#[test]
fn offset_moves_only_target_entity_from_base() {
    let mut w = world_with_platform();
    // 顶面 y = 20：点探针取 20.5（恰在面上会被算作实心），内部取 10。
    let on_top: V3 = [0.0, 20.5, 0.0];
    let inside: V3 = [0.0, 10.0, 0.0];
    assert!(w.is_position_free(&on_top, &[0.0; 3], &[0.0; 3]));
    assert!(!w.is_position_free(&inside, &[0.0; 3], &[0.0; 3]));

    // 平台上移 100：原「实心内部」变成自由，平移后的新实体内部（y=110）挡人。
    assert_eq!(w.set_entity_offset(ENTITY, [0.0, 100.0, 0.0]), 1);
    assert!(w.is_position_free(&inside, &[0.0; 3], &[0.0; 3]));
    assert!(!w.is_position_free(&[0.0, 110.0, 0.0], &[0.0; 3], &[0.0; 3]));

    // 再次下发同一绝对位移：不累加（仍以基准为准）。
    assert_eq!(w.set_entity_offset(ENTITY, [0.0, 100.0, 0.0]), 1);
    let moved = w
        .solids
        .iter()
        .find(|b| b.entity == ENTITY)
        .expect("实体 brush 应仍在");
    assert_eq!(moved.min[1], 100.0);
    assert_eq!(moved.max[1], 120.0);

    // 归零还原基准位置；世界几何（entity = -1）任何时刻都不动。
    assert_eq!(w.set_entity_offset(ENTITY, ZERO), 1);
    assert!(!w.is_position_free(&inside, &[0.0; 3], &[0.0; 3]));
    let world_brush = w.solids.iter().find(|b| b.entity == -1).expect("世界地板");
    assert_eq!(world_brush.min, [-4000.0, -100.0, -4000.0]);
}

const ZERO: V3 = [0.0; 3];

/// `WasmBrush[]` JSON（带 entity / start_solid），形状与 `parse_brushes` 一致。
fn brush_json(min: [f32; 3], max: [f32; 3], entity: i32, start_solid: bool) -> String {
    let planes = format!(
        "[\
         {{\"normal\":[0.0,1.0,0.0],\"dist\":{ty}}},\
         {{\"normal\":[0.0,-1.0,0.0],\"dist\":{by}}},\
         {{\"normal\":[1.0,0.0,0.0],\"dist\":{tx}}},\
         {{\"normal\":[-1.0,0.0,0.0],\"dist\":{bx}}},\
         {{\"normal\":[0.0,0.0,1.0],\"dist\":{tz}}},\
         {{\"normal\":[0.0,0.0,-1.0],\"dist\":{bz}}}]",
        ty = max[1],
        by = -min[1],
        tx = max[0],
        bx = -min[0],
        tz = max[2],
        bz = -min[2],
    );
    format!(
        "[{{\"planes\":{planes},\"min\":{min:?},\"max\":{max:?},\"is_ladder\":false,\
          \"is_solid\":true,\"entity\":{entity},\"start_solid\":{start_solid}}}]"
    )
}

fn build(brush_json: &str, spawn: [f64; 3]) -> PhysWorld {
    let mut w = PhysWorld::new();
    w.build_world(
        brush_json,
        "[]",
        "{\"teleports\":[],\"triggers\":[]}",
        spawn[0],
        spawn[1],
        spawn[2],
        180.0,
    )
    .expect("build_world 失败");
    w
}

#[test]
fn player_on_platform_is_carried_while_standing() {
    // 平台 y ∈ [0, 20]，玩家脚底在顶面 20 上。
    let mut w = build(&brush_json([-100.0, 0.0, -100.0], [100.0, 20.0, 100.0], ENTITY, true), [0.0, 20.0, 0.0]);
    w.player.on_ground = true;
    let before = w.player.origin;

    // 平台上移 64：玩家应一起被带走 64 HU。
    assert_eq!(w.set_brush_offset(ENTITY, 0.0, 64.0, 0.0), 1);
    assert_eq!(w.player.origin, [before[0], before[1] + 64.0, before[2]]);
    assert_eq!(w.brush_offset(ENTITY), vec![0.0, 64.0, 0.0]);

    // 下降同样带走（绝对值位移语义）。
    assert_eq!(w.set_brush_offset(ENTITY, 0.0, 0.0, 0.0), 1);
    assert_eq!(w.player.origin, before);
}

#[test]
fn airborne_player_is_not_carried() {
    let mut w = build(&brush_json([-100.0, 0.0, -100.0], [100.0, 20.0, 100.0], ENTITY, true), [0.0, 20.0, 0.0]);
    w.player.on_ground = false;
    let before = w.player.origin;
    w.set_brush_offset(ENTITY, 0.0, 64.0, 0.0);
    assert_eq!(w.player.origin, before, "悬空玩家不应被平台带走");
}
