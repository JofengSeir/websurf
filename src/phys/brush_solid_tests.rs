//! brush 实体运行期碰撞开关（`World::set_entity_solid`）回归。
//!
//! 场景：一块世界几何（`entity = -1`）恒实心，一块实体 brush（`entity = 5`）先按
//! `start_solid = false` 关闭，验证：
//! 1. 关掉的实体 brush 不参与 `is_position_free` / `trace` / `collide_attrib`；
//! 2. `set_entity_solid(5, true)` 后立即变实心（无需重建索引）；
//! 3. 再关掉又恢复可穿过；
//! 4. 世界几何不受实体开关影响，且 `entity = -1` 不能切换（`PhysWorld::set_brush_solid` 负数返回 false）。

use super::world::{Brush, Plane, World};
use super::world::{CollideAttrib, V3};

const ENTITY_BRUSH: i32 = 5;

fn pl(normal: [f64; 3], dist: f64) -> Plane {
    Plane { normal, dist }
}

/// 闭合盒子：`min`..`max`（内部 `dot(n,p)-dist <= 0`，法线朝外）。`entity = -1` 表示世界几何。
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

/// 世界几何：y ∈ [-10, 0] 的地板，x/z 各 ±2000 —— 只用来保证"实体开关不影响世界"。
fn floor() -> Brush {
    box_brush([-2000.0, -10.0, -2000.0], [2000.0, 0.0, 2000.0], -1)
}

/// 实体 brush：y ∈ [0, 200]、x/z 各 ±100 的方块，`entity = ENTITY_BRUSH`。
fn solid_block() -> Brush {
    box_brush([-100.0, 0.0, -100.0], [100.0, 200.0, 100.0], ENTITY_BRUSH)
}

fn world_with(brush: Brush, start_solid: bool) -> World {
    let mut w = World::new();
    w.solids.push(floor());
    w.solids.push(brush);
    w.entity_solid = vec![true; ENTITY_BRUSH as usize + 1];
    w.entity_solid[ENTITY_BRUSH as usize] = start_solid;
    w.build_index();
    w
}

const ZERO: [f64; 3] = [0.0, 0.0, 0.0];
const INSIDE: [f64; 3] = [0.0, 50.0, 0.0];

#[test]
fn start_solid_false_brush_is_ignored_by_queries() {
    let mut w = world_with(solid_block(), false);
    // 方块内部 → 无碰撞体命中
    assert!(w.is_position_free(&INSIDE, &ZERO, &ZERO), "关闭的实体 brush 不应挡人");
    let r = w.trace(&[0.0, 50.0, -500.0], &[0.0, 50.0, 500.0], &ZERO, &ZERO);
    assert_eq!(r.fraction, 1.0, "扫掠应穿过关闭的实体 brush");
    let a: CollideAttrib = w.collide_attrib(&INSIDE, &ZERO, &ZERO);
    assert!(a.free, "collide_attrib 应报自由");
    assert_eq!(a.brush_hits, 0);
}

#[test]
fn set_entity_solid_toggles_without_rebuild() {
    let mut w = world_with(solid_block(), false);
    assert!(w.is_position_free(&INSIDE, &ZERO, &ZERO));

    // 打开碰撞：不重建索引，下一次查询立即挡人
    let previous = w.set_entity_solid(ENTITY_BRUSH as usize, true);
    assert!(!previous, "切换前应是关闭状态");
    assert!(!w.is_position_free(&INSIDE, &ZERO, &ZERO), "打开后应实心");
    let r = w.trace(&[0.0, 50.0, -500.0], &[0.0, 50.0, 500.0], &ZERO, &ZERO);
    assert!(r.fraction < 1.0, "扫掠应命中");
    let a = w.collide_attrib(&INSIDE, &ZERO, &ZERO);
    assert!(!a.free);
    assert_eq!(a.brush_hits, 1, "只应命中实体 brush 一块（世界地板不在此高度）");

    // 再关掉：恢复可穿过
    let previous = w.set_entity_solid(ENTITY_BRUSH as usize, false);
    assert!(previous, "切换前应是实心");
    assert!(w.is_position_free(&INSIDE, &ZERO, &ZERO), "再关闭后应可穿过");
}

#[test]
fn world_geometry_not_affected_by_entity_state() {
    // 实体 brush 关闭时，世界地板仍应挡人。
    let mut w = world_with(solid_block(), false);
    let under_floor = [0.0, -5.0, 0.0];
    assert!(!w.is_position_free(&under_floor, &ZERO, &ZERO), "世界几何恒实心");
    // 实体 brush 打开也不改变世界地板。
    w.set_entity_solid(ENTITY_BRUSH as usize, true);
    assert!(!w.is_position_free(&under_floor, &ZERO, &ZERO));
}

#[test]
fn set_entity_solid_grows_state_table() {
    let mut w = world_with(solid_block(), true);
    // 未登记的实体下标按实心处理，切换后扩展状态表。
    let previous = w.set_entity_solid(99, false);
    assert!(previous, "未登记/越界按实心 true");
    assert!(!w.entity_solid[99]);
    assert_eq!(w.entity_solid.len(), 100);
}

#[test]
fn brush_solid_defaults_for_world_geometry() {
    // 状态表为空时，世界几何（entity < 0）仍恒实心。
    let mut w = World::new();
    w.solids.push(floor());
    w.build_index();
    let under_floor: V3 = [0.0, -5.0, 0.0];
    assert!(!w.is_position_free(&under_floor, &ZERO, &ZERO));
}
