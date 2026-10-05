//! 棱线接触回归（4 项）：站在**凸棱**上时，接触面不止一张，站立判据该怎么算。
//!
//! 背景（`surf_666` 实测，见 `documents/open-issues/01` §7）：玩家走上一条「逐渐翘起的尖脊」
//! 时，脊顶是**两张斜面相交**的凸棱。旧口径只取 `enter_frac` 最大的**那一张**面的法线，
//! 而脊上两张面的 `d1 ≈ 0`、进入分数几乎相等，**谁赢由浮点噪声决定** ⇒ 同一个位置能站
//! 也能被弹走。而 `surf_666` 的坡是 45° 阶梯面（`n.y = 0.70711`），离阈值 `STANDABLE_NORMAL
//! = 0.7` 只差 **0.00711**，抽签一次就翻。
//!
//! 本文件钉住的 `world.rs` / `player.rs` 语义：
//! - `clip_planes` 用 `CONTACT_FRAC_TIE` 把**同处一地**（进入分数之差小于该容差）的多张面
//!   归为一组，输出**平均法线**到 `TraceResult::normal`；
//! - 同一组里 `normal[1]` 最小的那张（**最陡**）另存到 `TraceResult::steepest_normal`；
//! - `player::categorize_position` 的站立判据读**平均法线** `normal`，`n.y >= STANDABLE_NORMAL`
//!   即为可站。`steepest_normal` 仍由 `clip_planes` 输出（供诊断），但**不参与**判定——
//!   加过一道"逐面最陡"闸门， 结果 52°/52° 的脊被判不可站、滑下坡并触发传送检测，
//!   而那正是要走的路，故撤除。
//!
//! 四项分别覆盖：45°/45° 棱可站、单张 45° 面可站、52°/52° 棱**也**可站（脊的局部表面
//! 就是那条棱，平均法线 `(0,1,0)` 是真支撑方向）、单张 52° 面不可站。
//! 最后一项是平均法线不放过陡坡的保证：单面陡坡只有一个接触面，平均就是它自己。
//!
//! 夹具 `ridge(sin, cos)` = 沿 z 延伸、脊线在 x=0 高度 H 的对称凸棱；两侧斜面法线分别是
//! `(sin, cos, 0)` 与 `(-sin, cos, 0)`，实体侧 `sin·|x| + cos·y <= cos·H`（即脊下方的实体）。
//! 盒子取站立箱 `[-16,0,-16] / [16,72,16]`，沿脊线正上方垂直下探，两张斜面同时成为接触面。

use crate::phys::world::{trace_box, Brush, Plane};

/// 站立判据的阈值，与 `player.rs` 的 `STANDABLE_NORMAL` 同值（45.573°）。
const STANDABLE_NORMAL: f64 = 0.7;

/// `Plane` 的简写构造，与 `p2_gate_tests.rs` 同约定：实体侧 `dot(normal, p) <= dist`。
fn p(n: [f64; 3], d: f64) -> Plane {
    Plane { normal: n, dist: d }
}

/// 脊高与半宽：取 `X * tan(theta) <= H + 400`，保证 45° 与 52° 两种夹角下实体都完整落在
/// AABB 内（否则宽阶段会先把它剔掉，测不到接触面）。
const H: f64 = 512.0;
const X: f64 = 512.0;
const Z: f64 = 512.0;
const BOTTOM: f64 = -400.0;

/// `Brush::max[1]` 刻意取 `H + AABB_HEADROOM` 而**不是**脊高 `H`：本凸体的真实最高点就是
/// 脊（斜面在上顶点处相交），若把 AABB 收到恰好等于脊高，"盒底正好落在脊上"这一瞬间盒 AABB
/// 与 brush AABB 只在 y 上**相切**，`aabb_overlaps_at` 判为分离 → 合法落地被当成无限平面
/// 假进入否决。AABB 是包围盒（本文件夹具里由测试代码直接给定），取得比几何更宽是正确且
/// 保守的用法；真实数据里的 AABB 由 `export_brushes_planes` 从凸包顶点算出，同理只会更宽。
const AABB_HEADROOM: f64 = 400.0;

/// 对称凸棱：脊线沿 z 方向、位于 `x = 0`、`y = H`；两侧斜面在 x 方向上与水平面夹角为
/// `theta`（`sin` / `cos` 即斜面外法线的水平 / 垂直分量）。
fn ridge(sin: f64, cos: f64) -> Brush {
    Brush {
        planes: vec![
            p([sin, cos, 0.0], cos * H),    // +x 侧斜面
            p([-sin, cos, 0.0], cos * H),   // -x 侧斜面
            p([0.0, -1.0, 0.0], -BOTTOM),   // 底面（实体在 y >= BOTTOM）
            p([1.0, 0.0, 0.0], X),          // +x 端
            p([-1.0, 0.0, 0.0], X),         // -x 端
            p([0.0, 0.0, -1.0], Z),         // -z 端
            p([0.0, 0.0, 1.0], Z),          // +z 端
        ],
        min: [-X, BOTTOM, -Z],
        max: [X, H + AABB_HEADROOM, Z],
    }
}

/// 脊线正上方垂直下探，返回追踪结果。盒底从 `H + 100` 降到 `H - 100`，必然穿脊。
fn drop_on_ridge(sin: f64, cos: f64) -> crate::phys::world::TraceResult {
    let mins = [-16.0, 0.0, -16.0];
    let maxs = [16.0, 72.0, 16.0];
    let start = [0.0, H + 100.0, 0.0];
    let end = [0.0, H - 100.0, 0.0];
    let brushes = [ridge(sin, cos)];
    trace_box(&start, &end, &mins, &maxs, &brushes.iter().collect::<Vec<_>>())
}

/// 45°/45° 凸棱可站：两张斜面各 `n.y = cos45 = 0.70711`（高于阈值 0.00711），平均法线为
/// `(0, 1, 0)`。这条钉住「平均法线让脊可站」——正是「逐渐翘起的脊能一路走到 45° 才滑」。
#[test]
fn ridge45_walkable() {
    let c = 0.7071067811865476f64; // cos 45°
    let r = drop_on_ridge(c, c);

    assert!(
        r.fraction < 1.0,
        "垂直下探必然命中脊顶，实际 fraction={}",
        r.fraction
    );
    // 两张斜面都被采纳 ⇒ 平均法线是竖直的。
    let n = r.normal.expect("命中后必须有平均法线");
    assert!(
        (n[1] - 1.0).abs() < 1e-6,
        "45°/45° 棱的两张面应平均成 (0,1,0)，实际 {:?}",
        n
    );
    // 最陡的那张也只是 45° ⇒ 逐面判据通过。
    let s = r.steepest_normal.expect("命中后必须有最陡面法线");
    assert!(
        s[1] >= STANDABLE_NORMAL,
        "45° 面的 n.y={} 应不低于阈值 {}",
        s[1],
        STANDABLE_NORMAL
    );
    // 完整判据（player.rs 的两条）：可站。
    assert!(
        n[1] >= STANDABLE_NORMAL && s[1] >= STANDABLE_NORMAL,
        "45°/45° 棱必须判为可站：平均 {:?} 最陡 {:?}",
        n,
        s
    );
}

/// 单张 45° 斜面可站：与 `ridge45_walkable` 对照，证明平均这一步没有把单面情形弄坏。
#[test]
fn single45_face_walkable() {
    let c = 0.7071067811865476f64;
    let s = 0.7071067811865476f64;
    let mins = [-16.0, 0.0, -16.0];
    let maxs = [16.0, 72.0, 16.0];
    // 起点必须在斜面之上：45° 时 x=100 处的表面是 y = H - 100 = 412，盒底取 H + 100。
    let start = [100.0, H + 100.0, 0.0];
    let end = [100.0, H - 300.0, 0.0];
    let brushes = [ridge(s, c)];
    let r = trace_box(&start, &end, &mins, &maxs, &brushes.iter().collect::<Vec<_>>());

    assert!(r.fraction < 1.0, "下探必须命中 +x 侧斜面");
    let n = r.normal.expect("必须有法线");
    let steep = r.steepest_normal.expect("必须有最陡面法线");
    assert!(
        n[1] >= STANDABLE_NORMAL && steep[1] >= STANDABLE_NORMAL,
        "单张 45° 面必须判为可站：平均 {:?} 最陡 {:?}",
        n,
        steep
    );
}

/// 52°/52° 凸棱**可站**：脊的局部表面就是那条棱本身，沿脊走时脚下支撑方向是竖直的，
/// 平均法线 `(0,1,0)` 正是该方向的正确表达。两侧的 52° 是**脊的 flank**，不是脚下那一块
/// 面的倾角——用它们判"脚下能不能站"会把整条脊否掉（实测 `surf_666` 上就是这样）。
#[test]
fn ridge52_walkable() {
    let s = 0.7896f64; // sin 52.13°
    let c = 0.6137f64; // cos 52.13°
    let r = drop_on_ridge(s, c);

    assert!(r.fraction < 1.0, "垂直下探必然命中脊顶");
    let n = r.normal.expect("命中后必须有平均法线");
    assert!(
        (n[1] - 1.0).abs() < 1e-6,
        "52°/52° 棱的两张面应平均成 (0,1,0)，实际 {:?}",
        n
    );
    // 完整判据（player.rs）：平均法线可站 ⇒ 可站。
    assert!(
        n[1] >= STANDABLE_NORMAL,
        "52°/52° 棱必须判为可站（脊的局部表面是棱），实际 n.y={}",
        n[1]
    );
    // 最陡的那张仍如实报告 52°，供诊断读；它不参与判定。
    let steep = r.steepest_normal.expect("命中后必须有最陡面法线");
    assert!(
        steep[1] < STANDABLE_NORMAL,
        "诊断用的最陡面应如实报出 52°（n.y={}），它不参与站立判定",
        steep[1]
    );
}

/// 单张 52° 斜面不可站：与 `ridge52_walkable` 对照，钉住「平均法线不放过陡坡」——
/// 单面陡坡只有一个接触面，平均就是它自己，故仍按 52° 判滑行。这条是「能走脊」不
/// 等于「什么都能走」的保证。
#[test]
fn single52_face_not_walkable() {
    let s = 0.7896f64;
    let c = 0.6137f64;
    let mins = [-16.0, 0.0, -16.0];
    let maxs = [16.0, 72.0, 16.0];
    let start = [100.0, H + 100.0, 0.0];
    let end = [100.0, H - 300.0, 0.0];
    let brushes = [ridge(s, c)];
    let r = trace_box(&start, &end, &mins, &maxs, &brushes.iter().collect::<Vec<_>>());

    assert!(r.fraction < 1.0, "下探必须命中 +x 侧斜面");
    let steep = r.steepest_normal.expect("必须有最陡面法线");
    assert!(
        steep[1] < STANDABLE_NORMAL,
        "单张 52° 面必须判为滑行，实际 n.y={}",
        steep[1]
    );
}