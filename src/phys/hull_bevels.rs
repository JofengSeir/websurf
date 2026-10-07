//! VBSP `AddBrushBevels` 的移植 —— 给一个**凸体**补齐「盒体扩张」所需的平面。
//!
//! 背景（源码实证）：起源编译器 `CMapFile::AddBrushBevels`（`test/project/source-sdk-2013-master`
//! 的 `src/utils/vbsp/map.cpp`，函数头注释即目的：「Adds any additional planes necessary to
//! allow the brush to be expanded against axial bounding boxes」）给每只 brush 补两类面：
//!
//! - **box bevel**：某轴向缺对应面时，补**该凸体 AABB 的那张轴向面**（`+` 轴取 `maxs[axis]`、
//!   `−` 轴取 `-mins[axis]`）；
//! - **edge bevel**：对每条**非轴向边**试 6 个斜切轴面 `normalize(cross(edge, ±axis))`、平面过
//!   该边，**凸体全部顶点在面内侧（越界 ≤ 0.1 HU）** 才收，与已有面重复则跳过。
//!
//! 为什么必须补：本仓库的盒追踪（`world::trace_box` → `world::clip_planes`）把每条平面按盒尺寸
//! 外推（`world::plane_offset`），等价于用**半空间交集**去当 Minkowski 和 `凸体 ⊕ 盒`。而
//! `凸体 ⊕ 盒` 的面只有三类来源 —— 凸体自己的面、**盒的面**在凸体顶点处（⇒ 轴向 AABB 面 = box
//! bevel）、**凸体边 × 盒边**（⇒ `cross(edge, axis)` = edge bevel）。少任何一类，交集就是真外扩
//! 体的**超集**：盒会停在真实接触面之上（52° 刀刃脊上实测虚浮 `16·tan52° ≈ 20.5 HU`）。
//!
//! `.phy` 模型侧本来没有 bevel：起源的 `vbsp/ivp.cpp` 把 brush 转成 `.phy` 凸包时**显式跳过
//! bevel side**（`BuildConvexForBrush` → `physcollision->ConvexFromPlanes`），因为 VPhysics 用真正
//! 的凸体-凸体接触求解，不需要外推平面表。所以本模块不是「给 `.phy` 加 bevel」，而是「把 `.phy`
//! 的凸体**当凸体**」—— 按 VBSP 原样补齐外推所需的平面表，再交给既有的 brush 平面表追踪器。
//! 反过来，`.phy` 凸体被拼成一个 mesh 之后再补面是行不通的：多块并集不是凸集，任何「全部顶点在
//! 面内侧」的判据都必然失败（本仓库 `surf_666` 实测：489 个放置实例里 329 个的并集非凸，
//! `s1_ramp1b` 11 块、并集越界 781.7 HU）。**本模块的输入必须是单块凸体**。
//!
//! 与 VBSP 的两处有意差异（都不动判据，只改枚举方式）：
//! - VBSP 遍历「每条非轴向 side 的 winding 边」；本模块先把共面三角形并成**面**、取面内只出现
//!   一次的边（= 该面的 winding 边界），再遍历 —— 避免把三角化对角线当成棱去测。
//! - VBSP 的 box bevel 用 `normal[axis] == dir` 精确判重；`.phy` 的面法线来自叉积，轴向面可能带
//!   浮点噪声，故精确判重之外再走一次 `plane_equal` 判重。
//!
//! 边界：纯几何计算、无全局状态、不读磁盘；**不做凸性校验**（调用方按「一块即一个凸包」喂）。
//!
//! 测试归属：`hull_bevel_tests`（3 项；含「撤掉生成必 FAIL」的成对断言）。

use crate::phys::world::{cross, dot, sub, Plane, V3};
use std::collections::HashSet;

/// 平面判等的容差（VBSP `PlaneEqual(normal, dist, 0.01f, 0.01f)`；源码注释写明「碰撞面容差比
/// 渲染面大」）。法线**逐分量**比较，与 `PlaneEqual` 同口径。
const PLANE_NORMAL_EPS: f64 = 0.01;
const PLANE_DIST_EPS: f64 = 0.01;

/// edge bevel 的顶点内测容差：VBSP 在 `map.cpp` 里用 `if (d > 0.1) break;` 否决候选面。
const VERTEX_INSIDE_EPS: f64 = 0.1;

/// 归一化边判「轴向」的阈值：VBSP 先 `SnapVector`（四舍五入到整数）再判分量是否 `±1`，等价于
/// 「分量与 1 的距离 < 0.5」；这里用「分量 ≥ 阈值即轴向」的等价写法。
const AXIAL_COMPONENT: f64 = 0.9995;

/// 边的归一化长度下限（VBSP `VectorNormalize(vec) < 0.5 → continue`：退化短边不测）。
const MIN_EDGE_LEN: f64 = 0.5;

/// 候选法线的叉积长度下限（VBSP `VectorNormalize(normal) < 0.5 → continue`：边与该轴近平行
/// 时叉积退化，不测）。
const MIN_CROSS_LEN: f64 = 0.5;

/// 生成的一张 bevel 面属于哪一类（VBSP `AddBrushBevels` 的两支）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BevelKind {
    /// box bevel：补上的**轴向 AABB 面**（凸体在该轴向没有对应面时补）。
    Box,
    /// edge bevel：非轴向边 × 斜切轴面（法线 `normalize(cross(edge, ±axis))`、平面过该边）。
    Edge,
}

/// 一张**生成的** bevel 面 + 它的来源。物理只消费 `plane`；显示要按类别分开画，edge bevel 还要
/// 画成「沿该边的窄条」——那才是它在碰撞里真正接住盒的那条带。
#[derive(Clone, Copy, Debug)]
pub struct BevelPlane {
    pub plane: Plane,
    pub kind: BevelKind,
    /// `kind == Edge` 时是生成它的那条**共享边**两端点（世界空间）；box bevel 为 `None`。
    pub edge: Option<[V3; 2]>,
}

/// 一个凸体的补面结果：真实面 + 生成的 bevel（带类别与来源边）+ 三类计数。
///
/// 计数供调用方对账与 debug 显示（VBSP 自己在编译收尾打印 `boxbevels` / `edgebevels` 两个数）。
pub struct HullBevels {
    /// 真实面平面（共面三角形已并成一张）。
    pub faces: Vec<Plane>,
    /// 生成的面：**box bevel 在前、edge bevel 在后**（与 VBSP 的添加顺序一致）。
    pub added: Vec<BevelPlane>,
    /// 新增的 box bevel 张数（= `added` 里 `kind == Box` 的张数）。
    pub box_added: usize,
    /// 新增的 edge bevel 张数（= `added` 里 `kind == Edge` 的张数）。
    pub edge_added: usize,
    /// 被「全部顶点在面内侧」判据否决的 edge 候选数（判据在干活的量度）。
    pub rejected_edge_candidates: usize,
}

impl HullBevels {
    /// 完整平面表：真实面在前、生成的 bevel 在后 —— **物理消费的就是它**。
    pub fn planes(&self) -> Vec<Plane> {
        let mut out = self.faces.clone();
        out.extend(self.added.iter().map(|b| b.plane));
        out
    }
}

/// 平面判等：法线逐分量与 `dist` 都落在容差内。
fn plane_equal(a: &Plane, n: &V3, d: f64) -> bool {
    (a.normal[0] - n[0]).abs() < PLANE_NORMAL_EPS
        && (a.normal[1] - n[1]).abs() < PLANE_NORMAL_EPS
        && (a.normal[2] - n[2]).abs() < PLANE_NORMAL_EPS
        && (a.dist - d).abs() < PLANE_DIST_EPS
}

/// 平面表里是否已有一张与 `(n, d)` 判等的面。
fn contains_plane(planes: &[Plane], n: &V3, d: f64) -> bool {
    planes.iter().any(|p| plane_equal(p, n, d))
}

/// 真实面 + 已生成的 bevel 里是否已有一张与 `(n, d)` 判等的面（两级判重共用）。
fn contains_any(faces: &[Plane], added: &[BevelPlane], n: &V3, d: f64) -> bool {
    contains_plane(faces, n, d) || added.iter().any(|b| plane_equal(&b.plane, n, d))
}

/// 单个三角形的朝外单位法线 + 平面偏移；退化三角形返回 `None`。
///
/// 朝向按**顶点质心**定（`centroid` 由调用方一次算好）：凸包面法线必须指离质心，`.phy` 的三角
/// 形绕序不保证朝外，不能信绕序。
fn triangle_plane(vertices: &[V3], tri: [u32; 3], centroid: &V3) -> Option<Plane> {
    let (va, vb, vc) = (
        vertices[tri[0] as usize],
        vertices[tri[1] as usize],
        vertices[tri[2] as usize],
    );
    let raw = cross(&sub(&vb, &va), &sub(&vc, &va));
    let len = dot(&raw, &raw).sqrt();
    if len < 1e-9 {
        return None;
    }
    let mut n = [raw[0] / len, raw[1] / len, raw[2] / len];
    let face_mid = [
        (va[0] + vb[0] + vc[0]) / 3.0,
        (va[1] + vb[1] + vc[1]) / 3.0,
        (va[2] + vb[2] + vc[2]) / 3.0,
    ];
    if dot(&n, &sub(&face_mid, centroid)) < 0.0 {
        n = [-n[0], -n[1], -n[2]];
    }
    Some(Plane {
        normal: n,
        dist: dot(&n, &va),
    })
}

/// 顶点集的质心（面法线定向用；顶点为空时返回原点）。
fn centroid_of(vertices: &[V3]) -> V3 {
    if vertices.is_empty() {
        return [0.0; 3];
    }
    let mut c = [0.0f64; 3];
    for v in vertices {
        c[0] += v[0];
        c[1] += v[1];
        c[2] += v[2];
    }
    let inv = 1.0 / vertices.len() as f64;
    [c[0] * inv, c[1] * inv, c[2] * inv]
}

/// 一个面：平面 + 它的三角形（共面三角形已并进来）。
struct FaceGroup {
    plane: Plane,
    tris: Vec<[u32; 3]>,
}

/// 三角形 → **面分组**（共面且同向的三角形并成一组）。
///
/// 「面」是 VBSP winding 的等价物：edge bevel 只测 winding 的边界边，故必须先分组，否则三角化
/// 对角线会被当成棱。
fn face_groups(vertices: &[V3], triangles: &[[u32; 3]]) -> Vec<FaceGroup> {
    let centroid = centroid_of(vertices);
    let mut groups: Vec<FaceGroup> = Vec::new();
    for tri in triangles {
        let Some(plane) = triangle_plane(vertices, *tri, &centroid) else {
            continue;
        };
        match groups
            .iter_mut()
            .find(|g| plane_equal(&g.plane, &plane.normal, plane.dist))
        {
            Some(g) => g.tris.push(*tri),
            None => groups.push(FaceGroup {
                plane,
                tris: vec![*tri],
            }),
        }
    }
    groups
}

/// 面内只出现一次的边（= 该面的 winding 边界）；面被三角化时对角线出现两次，自然被排除。
fn face_boundary_edges(group: &FaceGroup) -> Vec<[u32; 2]> {
    let mut seen: HashSet<[u32; 2]> = HashSet::new();
    let mut twice: HashSet<[u32; 2]> = HashSet::new();
    for tri in &group.tris {
        for e in [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]] {
            let k = if e[0] < e[1] { e } else { [e[1], e[0]] };
            if !seen.insert(k) {
                twice.insert(k);
            }
        }
    }
    seen.into_iter().filter(|k| !twice.contains(k)).collect()
}

/// 顶点集三轴 AABB。
fn bounds_of(vertices: &[V3]) -> (V3, V3) {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for v in vertices {
        for i in 0..3 {
            if v[i] < min[i] {
                min[i] = v[i];
            }
            if v[i] > max[i] {
                max[i] = v[i];
            }
        }
    }
    (min, max)
}

/// 三角形集合的朝外面平面表（共面三角形并成一张），供调用方构造凸体平面表或做凸性核对。
pub fn face_planes(vertices: &[V3], triangles: &[[u32; 3]]) -> Vec<Plane> {
    face_groups(vertices, triangles)
        .into_iter()
        .map(|g| g.plane)
        .collect()
}

/// 按 VBSP `AddBrushBevels` 给单块凸体补齐平面表。
///
/// 输入：`vertices`（**世界空间**、HU）+ `triangles`（下标指向 `vertices`；同一块凸体）。
/// 输出：[`HullBevels`]（完整平面表 + 计数）。顶点少于 4 个或没有三角形时返回空平面表。
///
/// **生成位置必须是世界空间**：VBSP 的 box bevel 取 AABB 轴向面（世界轴向），模型实例带旋转或
/// 缩放时在模型局部空间生成会得到错误的轴向面。
pub fn hull_bevels(vertices: &[V3], triangles: &[[u32; 3]]) -> HullBevels {
    let groups = face_groups(vertices, triangles);
    let faces: Vec<Plane> = groups.iter().map(|g| g.plane).collect();
    let mut added: Vec<BevelPlane> = Vec::new();
    if vertices.len() < 4 || faces.len() < 4 {
        // 退化输入：凑不出凸体，不生成任何补面（调用方按原平面表处理）。
        return HullBevels {
            faces,
            added,
            box_added: 0,
            edge_added: 0,
            rejected_edge_candidates: 0,
        };
    }

    // ---- box bevel：缺哪条轴向面，就补该轴的 AABB 面 ----
    let (min, max) = bounds_of(vertices);
    for axis in 0..3 {
        for dir in [-1.0f64, 1.0] {
            let mut n = [0.0f64; 3];
            n[axis] = dir;
            let d = if dir > 0.0 { max[axis] } else { -min[axis] };
            // VBSP 的精确判重（`normal[axis] == dir`）在浮点法线下会漏判，故两级都用：
            // 「已有与该轴同向的面」或「已有与之判等的面」都视为不需要补。
            let axis_present = faces.iter().any(|p| {
                let others = [(axis + 1) % 3, (axis + 2) % 3];
                p.normal[axis] == dir
                    && p.normal[others[0]].abs() < 1e-9
                    && p.normal[others[1]].abs() < 1e-9
            }) || added.iter().any(|b| {
                let p = b.plane;
                let others = [(axis + 1) % 3, (axis + 2) % 3];
                p.normal[axis] == dir
                    && p.normal[others[0]].abs() < 1e-9
                    && p.normal[others[1]].abs() < 1e-9
            });
            if axis_present || contains_any(&faces, &added, &n, d) {
                continue;
            }
            added.push(BevelPlane {
                plane: Plane { normal: n, dist: d },
                kind: BevelKind::Box,
                edge: None,
            });
        }
    }

    // ---- edge bevel：非轴向边 × 6 个斜切轴面 ----
    let mut edges: HashSet<[u32; 2]> = HashSet::new();
    for g in &groups {
        for e in face_boundary_edges(g) {
            edges.insert(e);
        }
    }
    let mut rejected_edge_candidates = 0usize;
    for edge in &edges {
        let pa = vertices[edge[0] as usize];
        let pb = vertices[edge[1] as usize];
        let dir = sub(&pb, &pa);
        let len = dot(&dir, &dir).sqrt();
        if len < MIN_EDGE_LEN {
            continue;
        }
        let u = [dir[0] / len, dir[1] / len, dir[2] / len];
        if u.iter().any(|c| c.abs() >= AXIAL_COMPONENT) {
            continue; // 轴向边：轴向面已由 box bevel 覆盖
        }
        for axis in 0..3 {
            for dir_sign in [-1.0f64, 1.0] {
                let mut axis_vec = [0.0f64; 3];
                axis_vec[axis] = dir_sign;
                let raw = cross(&u, &axis_vec);
                let raw_len = dot(&raw, &raw).sqrt();
                if raw_len < MIN_CROSS_LEN {
                    continue;
                }
                let n = [raw[0] / raw_len, raw[1] / raw_len, raw[2] / raw_len];
                let d = dot(&n, &pa);
                // 判据（VBSP 原文）：凸体**全部**顶点都在这张面内侧（越界 ≤ 0.1 HU）才是真补面。
                let mut front = false;
                for v in vertices {
                    if dot(&n, v) - d > VERTEX_INSIDE_EPS {
                        front = true;
                        break;
                    }
                }
                if front {
                    rejected_edge_candidates += 1;
                    continue;
                }
                if contains_any(&faces, &added, &n, d) {
                    continue;
                }
                added.push(BevelPlane {
                    plane: Plane { normal: n, dist: d },
                    kind: BevelKind::Edge,
                    edge: Some([pa, pb]),
                });
            }
        }
    }

    let box_added = added
        .iter()
        .filter(|b| b.kind == BevelKind::Box)
        .count();
    let edge_added = added.len() - box_added;
    HullBevels {
        faces,
        added,
        box_added,
        edge_added,
        rejected_edge_candidates,
    }
}
