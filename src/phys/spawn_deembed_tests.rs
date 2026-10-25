//! 出生点去嵌入回归（T-731/F1：`PhysWorld::build_world` 第 5 步的 relocate）。
//!
//! **要防的回归**：出生盒与几何相交时，`create_player` 只落位不判嵌入（见其文档），
//! 后续每个 tick 的 `check_stuck` 都走"全候选失败 → 清速 + 整帧跳过"链 —— 玩家在出生点
//! **永久悬停**（T-731 实测：surf_666 + 非默认体型，26 s 冻结、速度 0）。修复是
//! `build_world` 里按 `player::find_free_origin`（check_stuck 同一套候选集）把出生点
//! 搬到最近空闲位，**spawn 字段一并搬**（respawn / 死亡重生都回这个点）。
//!
//! 本文件钉三件事：
//! 1. 嵌入 + 候选集内有解 → relocate 到**候选顺序下的第一个**空闲点（+Y 优先、先近后远）；
//! 2. relocate 后 `respawn()` 回的是搬过的点（spawn 字段确实被更新）；
//! 3. 嵌入 + 候选集内无解（全封闭实体）→ 保持原位（记录日志的行为，不 panic、不乱搬）。
//!
//! 夹具只用世界 brush（与 `stuck_gate_tests` 同约定：实体侧 `dot(normal, p) <= dist`），
//! 不走三角网格路径。

use crate::phys::PhysWorld;

/// 单个长方体 brush 的 `WasmBrush[]` JSON（Y-up、法线朝外，与 parse_brushes 的形状一致）。
fn box_brush_json(min: [f32; 3], max: [f32; 3]) -> String {
    // 6 张面：+y / -y / +x / -x / +z / -z，dist = 面沿法线的截距
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
        "[{{\"planes\":{planes},\"min\":{min:?},\"max\":{max:?},\"is_ladder\":false,\"is_solid\":true}}]",
        planes = planes,
        min = min,
        max = max,
    )
}

fn teleport_json() -> &'static str {
    "{\"teleports\":[],\"triggers\":[]}"
}

fn build(brush_json: &str, spawn: [f64; 3]) -> PhysWorld {
    let mut w = PhysWorld::new();
    w.build_world(brush_json, "[]", teleport_json(), spawn[0], spawn[1], spawn[2], 180.0)
        .expect("build_world 失败");
    w
}

/// 出生点在实心内、候选集内有解：relocate 到候选顺序下的第一个空闲点，spawn 字段同步。
#[test]
fn spawn_embedded_relocates_to_first_free_candidate() {
    // 实心块：y ∈ [-12, +12]、x/z ∈ [-200, +200]（横向大到所有横向候选都在实体内）。
    // 出生 (0,0,0) 嵌入 12 HU。候选顺序 dist 1..34 × (+Y,+X,-X,+Z,-Z,斜×4,-Y)：
    //   - +Y 候选在盒底 < 12 时全堵；d16 时盒底 y=16 > 12 → 首个空闲 = (0, 16, 0)。
    //   - ±X/±Z 候选在 dist ≤ 34 时盒仍嵌在横向 ±200 的实心里 → 全堵。
    //   - -Y 候选更深入实体 → 全堵。
    let brush = box_brush_json([-200.0, -12.0, -200.0], [200.0, 12.0, 200.0]);
    let w = build(&brush, [0.0, 0.0, 0.0]);
    // relocate 期望值：STUCK_DIRS[0]=+Y、dist=16 是候选顺序下首个空闲点
    assert_eq!(w.player.origin, [0.0, 16.0, 0.0]);
    assert_eq!(w.spawn, [0.0, 16.0, 0.0]);
    // spawn 字段一并更新：respawn 回的是搬过的点（不是原始出生点）
    let mut w2 = build(&brush, [0.0, 0.0, 0.0]);
    w2.respawn();
    assert_eq!(w2.player.origin, [0.0, 16.0, 0.0]);
}

/// 出生点被全封闭实体包围（候选集 60 个点全在实心内）：保持原位，不 panic、不乱搬。
#[test]
fn spawn_sealed_keeps_origin() {
    // 巨型实心：三轴 ±200，出生 (0,0,0) 与全部 ±34 候选都在实体内
    let brush = box_brush_json([-200.0, -200.0, -200.0], [200.0, 200.0, 200.0]);
    let w = build(&brush, [0.0, 0.0, 0.0]);
    assert_eq!(w.player.origin, [0.0, 0.0, 0.0]);
    assert_eq!(w.spawn, [0.0, 0.0, 0.0]);
}

/// 出生点本就空闲（默认体型的正常地图）：**零位移** —— 修复不得碰正常路径。
///
/// 夹具刻意让出生点**悬空**（盒底离地板顶 2 HU）：出生恰好贴地（盒底与地板顶共面）在
/// `is_position_free` 里按相交处理，修复前后的既有行为都是 +1 挤出（check_stuck 候选 /
/// build_world relocate 同值），不属于"空闲出生"类 —— 见下一个测试。
#[test]
fn spawn_free_untouched() {
    // 地板顶面 y=0；出生 (0,2,0)，盒体 [2,74] 与地板不相交
    let brush = box_brush_json([-200.0, -400.0, -200.0], [200.0, 0.0, 200.0]);
    let w = build(&brush, [0.0, 2.0, 0.0]);
    assert_eq!(w.player.origin, [0.0, 2.0, 0.0]);
    assert_eq!(w.spawn, [0.0, 2.0, 0.0]);
}

/// 出生恰好贴地（盒底与地板顶共面）按嵌入处理：relocate +1 —— 与修复前既有行为同值
/// （该形态下 check_stuck 本来也会在首个 tick 用同一候选集 +1 挤出），钉住这个语义，
/// 防止日后有人把"贴地"当"空闲"。
#[test]
fn spawn_touching_floor_relocates_one_hu_up() {
    let brush = box_brush_json([-200.0, -400.0, -200.0], [200.0, 0.0, 200.0]);
    let w = build(&brush, [0.0, 0.0, 0.0]);
    assert_eq!(w.player.origin, [0.0, 1.0, 0.0]);
    assert_eq!(w.spawn, [0.0, 1.0, 0.0]);
}
