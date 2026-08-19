//! P2 坡顶幻影回归：盒-AABB 必要校验（aabb_overlaps_at）对阻断 tick 的直接验证。
//! 镜像 game/scripts/phys-p2-regression.mjs 的 64Hz H=2.5 vz=300 阻断 tick。

use crate::phys::world::{Plane, Brush, trace_box};

fn p(n: [f64; 3], d: f64) -> Plane {
    Plane { normal: n, dist: d }
}

/// 60° 下坡（与 phys-rate-parity-v2.mjs rampDown 一致）：表面 y = -z*tan60。
fn ramp() -> Brush {
    let cos = 0.5f64;
    let sin = 0.8660254037844386f64;
    Brush {
        planes: vec![
            p([0.0, cos, sin], 0.0),      // 表面
            p([0.0, -1.0, 0.0], 3000.0),  // 底
            p([1.0, 0.0, 0.0], 4000.0),   // +x
            p([-1.0, 0.0, 0.0], 4000.0),  // -x
            p([0.0, 0.0, -1.0], 0.0),     // z=0 端盖（P2 幻影平面）
            p([0.0, 0.0, 1.0], 1500.0),   // +z 闭合
        ],
        min: [-4000.0, -3000.0, 0.0],
        max: [4000.0, 0.0, 1500.0],
    }
}

#[test]
fn p2_endcap_phantom_vetoed() {
    // 64Hz H=2.5 vz=300 的阻断 tick：t∈[0.03125, 0.046875]
    let start = [0.0, 2.109375, -20.625];
    let end = [0.0, 1.62109375, -15.9375];
    let mins = [-16.0, 0.0, -16.0];
    let maxs = [16.0, 72.0, 16.0];

    let brushes = [ramp()];
    let r = trace_box(&start, &end, &mins, &maxs, &brushes.iter().collect::<Vec<_>>());
    // 修复后：端盖进入在 f≈0.98 处被 AABB 否决（盒 y∈[1.6,73.6] 与坡 AABB y∈[-3000,0] 分离）
    // → 无命中，fraction=1.0
    assert_eq!(
        r.fraction, 1.0,
        "门校验应否决端盖幻影进入，实际 fraction={} normal={:?}",
        r.fraction, r.normal
    );
}

#[test]
fn p2_surface_landing_kept() {
    // 合法落地：盒从坡面上方降入表面半空间（d1>0 → d2<0），命中处盒 AABB 与坡
    // AABB 重叠（盒底后棱真实低于坡面）→ 门必须保留该接触。
    let start = [0.0, -20.0, 30.0];
    let end = [0.0, -26.0, 30.5];
    let mins = [-16.0, 0.0, -16.0];
    let maxs = [16.0, 72.0, 16.0];

    let brushes = [ramp()];
    let r = trace_box(&start, &end, &mins, &maxs, &brushes.iter().collect::<Vec<_>>());
    assert!(
        r.fraction < 1.0,
        "合法表面接触不应被否决，实际 fraction={}",
        r.fraction
    );
}

#[test]
fn p2_start_solid_phantom_vetoed() {
    // 阻断 tick 的下一 tick 起点：盒 z_max=0.0625 刚刺入坡 z>=0 半空间、但 y 轴
    // 与坡 AABB 分离 1.6u——平面判定 start_solid/all_solid 会把速度整速清零（P2 钉住）。
    // 修复后：AABB 分离 → 跳过该 brush，fraction=1.0 且非 solid。
    let start = [0.0, 1.62109375, -15.9375];
    let end = [0.0, 1.03515625, -11.25];
    let mins = [-16.0, 0.0, -16.0];
    let maxs = [16.0, 72.0, 16.0];

    let brushes = [ramp()];
    let r = trace_box(&start, &end, &mins, &maxs, &brushes.iter().collect::<Vec<_>>());
    assert!(
        !r.start_solid && !r.all_solid && r.fraction == 1.0,
        "start_solid 幻影应被 AABB 门否决，实际 start_solid={} all_solid={} fraction={}",
        r.start_solid, r.all_solid, r.fraction
    );
}