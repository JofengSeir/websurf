//! `.phy` 网格拆块 + 转凸体 brush 的门回归（3 项）。
//!
//! 钉的是「模型尖脊能不能站」这条链的**下半段**：`phy_hulls::pieces_of_mesh` 把拼在一起的
//! 多块凸体拆开、逐块生成 VBSP 补面、转成 `Brush`，再走 `world::trace_box`（与 brush 刀脊
//! 完全同一条追踪路径）。上半段（补面判据本身）由 `hull_bevel_tests` 钉住。
//!
//! - 第 1 项：**两个棱柱拼成一个网格**（导出层的真实形态）⇒ 拆成 2 个 brush、脊上盒停在
//!   「脊线 + `16·|n_z|/n_y`」之上且法线可站（`n_y ≥ 0.7`）；两块 AABB 在 z 上不重叠。
//! - 第 2 项：**非凸块**（L 形棱柱）⇒ 不转 brush，三角形原样退回（`leftovers` 是全部三角形），
//!   避免把凹处当凸体填实。
//! - 第 3 项：AABB 必须包住平面表 —— 逐块断言顶点都在自己的 AABB 里、且 AABB 不是退化的
//!   （这是 `Brush` 的宽阶段与「命中处盒-AABB 必要校验」的前提）。

use crate::phys::phy_hulls::{mesh_to_brushes, pieces_of_mesh, HULL_CONVEX_TOL};
use crate::phys::world::{trace_box, TriMesh, V3};

/// 脊高、半长（沿 z）、底面高度（与 `hull_bevel_tests` 同量级）。
const H: f64 = 512.0;
const Z: f64 = 512.0;
const BOTTOM: f64 = -400.0;
/// 52° 斜面：`cos52 = 0.6157 < 0.7` ⇒ 单张斜面不可站。
const SLAB_SIN: f64 = 0.7880107536067220;
const SLAB_COS: f64 = 0.6156614753256583;
/// 斜脊沿 z 的下行量。
const DROP: f64 = 200.0;
/// 盒半宽（残余虚浮 = `16·|n_z|/n_y`）。
const X_HALF: f64 = 16.0;

/// 三棱柱（脊线在 x=0、沿 z；`drop` 非 0 时 +z 端整端下沉 ⇒ 斜脊），整体沿 z 平移 `z_shift`。
fn prism(drop: f64, z_shift: f64) -> (Vec<V3>, Vec<[u32; 3]>) {
    let xb = SLAB_COS * (H - BOTTOM) / SLAB_SIN;
    let verts = vec![
        [-xb, BOTTOM, -Z + z_shift],
        [xb, BOTTOM, -Z + z_shift],
        [0.0, H, -Z + z_shift],
        [-xb, BOTTOM - drop, Z + z_shift],
        [xb, BOTTOM - drop, Z + z_shift],
        [0.0, H - drop, Z + z_shift],
    ];
    let tris = vec![
        [0, 1, 2],
        [3, 4, 5],
        [1, 2, 5],
        [1, 5, 4],
        [0, 2, 5],
        [0, 5, 3],
        [0, 1, 4],
        [0, 4, 3],
    ];
    (verts, tris)
}

/// L 形棱柱（**非凸**）：截面 (0,0)-(3,0)-(3,1)-(1,1)-(1,3)-(0,3)，沿 z 拉伸 1 HU。
fn l_prism() -> (Vec<V3>, Vec<[u32; 3]>) {
    let section = [
        (0.0, 0.0),
        (3.0, 0.0),
        (3.0, 1.0),
        (1.0, 1.0),
        (1.0, 3.0),
        (0.0, 3.0),
    ];
    let mut verts: Vec<V3> = Vec::new();
    for (x, y) in section {
        verts.push([x, y, 0.0]);
    }
    for (x, y) in section {
        verts.push([x, y, 1.0]);
    }
    let mut tris: Vec<[u32; 3]> = Vec::new();
    for i in 1..5u32 {
        tris.push([0, i, i + 1]); // 底面扇
        tris.push([6, 7 + i, 6 + i]); // 顶面扇
    }
    for i in 0..6u32 {
        let j = (i + 1) % 6;
        tris.push([i, j, 6 + j]);
        tris.push([i, 6 + j, 6 + i]);
    }
    (verts, tris)
}

/// 由顶点/三角形造 `TriMesh`（`min`/`max` 由顶点现算）。
fn mesh_of(name: &str, verts: Vec<V3>, indices: Vec<[u32; 3]>) -> TriMesh {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for v in &verts {
        for i in 0..3 {
            if v[i] < min[i] {
                min[i] = v[i];
            }
            if v[i] > max[i] {
                max[i] = v[i];
            }
        }
    }
    TriMesh {
        name: name.to_string(),
        vertices: verts,
        indices,
        min,
        max,
    }
}

/// 盒从脊上方 200 HU 垂直下探到脊下方 200 HU；`crest` = 盒正下方脊线的高度。
fn drop_on(brushes: &[crate::phys::world::Brush], crest: f64, z: f64) -> crate::phys::world::TraceResult {
    let mins = [-X_HALF, 0.0, -X_HALF];
    let maxs = [X_HALF, 72.0, X_HALF];
    let start = [0.0, crest + 200.0, z];
    let end = [0.0, crest - 200.0, z];
    let refs: Vec<&crate::phys::world::Brush> = brushes.iter().collect();
    trace_box(&start, &end, &mins, &maxs, &refs)
}

/// 两个棱柱（一个斜脊）拼成一个网格 ⇒ 拆成 2 个 brush，斜脊那块的盒停在脊线上方 `16·|n_z|/n_y`、
/// 法线可站。
#[test]
fn merged_mesh_splits_into_convex_brushes_and_the_ridge_is_standable() {
    let (mut va, ta) = prism(DROP, 0.0);
    let (vb, tb) = prism(0.0, 6000.0);
    let base = va.len() as u32;
    va.extend_from_slice(&vb);
    let mut tris = ta;
    for t in tb {
        tris.push([base + t[0], base + t[1], base + t[2]]);
    }
    let mesh = mesh_of("models/props/666/s1_ramp1b.mdl", va, tris);

    let pieces = pieces_of_mesh(&mesh);
    assert_eq!(pieces.len(), 2, "两个不相连的棱柱应拆成 2 块");
    assert!(
        pieces.iter().all(|p| p.convex),
        "两块都应是可用凸体，实际越界量 {:?}",
        pieces.iter().map(|p| p.max_violation).collect::<Vec<_>>(),
    );

    let (brushes, leftovers, non_convex) = mesh_to_brushes(&mesh);
    assert_eq!(brushes.len(), 2, "应生成 2 个 brush");
    assert!(leftovers.is_empty(), "没有非凸块，不该有残余三角形");
    assert_eq!(non_convex, 0);
    // 两块在 z 上分离（6000 HU 平移）。
    assert!(
        brushes[0].max[2] < brushes[1].min[2],
        "两个 brush 的 AABB 应在 z 上分离",
    );

    // 斜脊（z=0 处脊高 = H - DROP/2）——绑定的应是过脊的 edge bevel。
    let crest = H - DROP / 2.0;
    let r = drop_on(&brushes, crest, 0.0);
    assert!(r.fraction < 1.0, "垂直下探必然命中");
    let n = r.normal.expect("命中后必须有接触法线");
    assert!(
        n[1] >= 0.7,
        "斜脊停靠法线应可站（n_y >= 0.7），实际 {n:?}",
    );
    let expected_hover = X_HALF * n[2].abs() / n[1];
    let hover = r.end_pos[1] - crest;
    assert!(
        (hover - expected_hover).abs() < 0.2,
        "残余虚浮应是几何量 16·|n_z|/n_y = {expected_hover:.2} HU，实际 {hover:+.2} HU",
    );

    // 平移过去那块是水平脊（drop=0）：box bevel 承担，盒停在脊线上、法线竖直。
    let r2 = drop_on(&brushes, H, 6000.0);
    assert!(r2.fraction < 1.0);
    let n2 = r2.normal.expect("命中后必须有接触法线");
    assert!(
        (r2.end_pos[1] - H).abs() < 0.05 && (n2[1] - 1.0).abs() < 1e-6,
        "水平脊应停在脊线 y={H} 且法线 (0,1,0)，实际 y={} n={n2:?}",
        r2.end_pos[1],
    );
}

/// 非凸块（L 形棱柱）不转 brush，三角形原样退回。
#[test]
fn non_convex_piece_falls_back_to_the_triangle_path() {
    let (verts, tris) = l_prism();
    let mesh = mesh_of("models/props/666/concave.mdl", verts, tris);
    let pieces = pieces_of_mesh(&mesh);
    assert_eq!(pieces.len(), 1, "L 形棱柱是一个连通块");
    assert!(
        !pieces[0].convex,
        "凹角块必须判为非凸（实测越界 {:.3} HU，容差 {HULL_CONVEX_TOL}）",
        pieces[0].max_violation,
    );
    assert!(
        pieces[0].max_violation > HULL_CONVEX_TOL,
        "越界量应超过容差，实际 {}",
        pieces[0].max_violation,
    );

    let (brushes, leftovers, non_convex) = mesh_to_brushes(&mesh);
    assert!(brushes.is_empty(), "非凸块不该转成 brush");
    assert_eq!(non_convex, 1);
    assert_eq!(
        leftovers.len(),
        mesh.indices.len(),
        "非凸块的全部三角形都应退回三角形路径",
    );
}

/// **平板（开集）绝不能转成 brush**：面集在 ±x/±z 上无界，补上 AABB 面就会把它补成一个盒子
/// —— 那正是"模型外面多出一个包裹框"的来源。这类块必须退回三角形路径。
#[test]
fn open_flat_piece_is_never_turned_into_a_box() {
    // 一块水平四边形（面法线只有 ±y 两个方向）。
    let verts: Vec<V3> = vec![
        [-100.0, 0.0, -100.0],
        [100.0, 0.0, -100.0],
        [100.0, 0.0, 100.0],
        [-100.0, 0.0, 100.0],
    ];
    let tris: Vec<[u32; 3]> = vec![[0, 1, 2], [0, 2, 3]];
    let mesh = mesh_of("models/props/666/flat.mdl", verts, tris);
    let pieces = pieces_of_mesh(&mesh);
    assert_eq!(pieces.len(), 1, "平板是一个连通块");
    assert!(
        !pieces[0].convex,
        "开集（面集非有界）必须判为不可用凸体，实际 convex=true（面数 {}、越界 {}）",
        pieces[0].face_count,
        pieces[0].max_violation,
    );
    let (brushes, leftovers, non_convex) = mesh_to_brushes(&mesh);
    assert!(brushes.is_empty(), "平板不该转成 brush（否则会变成 200×200 的包裹盒）");
    assert_eq!(non_convex, 1);
    assert_eq!(leftovers.len(), 2, "平板三角形应原样退回");
}

#[test]
fn hull_brush_aabb_contains_its_piece() {
    let (verts, tris) = prism(DROP, 0.0);
    let mesh = mesh_of("models/props/666/s1_ramp1b.mdl", verts.clone(), tris);
    let (brushes, _, _) = mesh_to_brushes(&mesh);
    assert_eq!(brushes.len(), 1);
    let b = &brushes[0];
    for v in &verts {
        for i in 0..3 {
            assert!(
                v[i] >= b.min[i] - 1e-9 && v[i] <= b.max[i] + 1e-9,
                "顶点 {v:?} 超出 brush AABB {:?}..{:?}",
                b.min,
                b.max,
            );
        }
    }
    for i in 0..3 {
        assert!(
            b.max[i] - b.min[i] > 1.0,
            "AABB 第 {i} 轴退化（厚度 {}）",
            b.max[i] - b.min[i],
        );
    }
    // 平面表至少包含该块自己的真实面。
    assert!(b.planes.len() >= 4, "平面表张数 {}", b.planes.len());
}
