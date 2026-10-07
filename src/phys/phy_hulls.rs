//! `.phy` 模型网格 → 凸体 brush（含 VBSP 补面）的转换。
//!
//! 上游：`export_model_phy_colliders` 输出的网格是「一只模型的一个放置实例」——它把该模型的
//! **全部凸体块拼进一个 mesh**（`base = local.len()` 累加）。本模块按**连通分量**把块拆回来，
//! 逐块生成补面（[`crate::phys::hull_bevels`] = VBSP `AddBrushBevels` 的移植）并转成
//! [`Brush`]（平面表 + 该块 AABB），于是这些凸体走**既有 brush 平面表追踪器**：
//! `world::trace_box` / `clip_planes` / `plane_offset`，连带 `BrushGrid` 空间索引、
//! `is_position_free`、卡死判据一并复用。
//!
//! 为什么必须拆块（实测）：多块并集不是凸集，任何「凸体全部顶点在面内侧」的补面判据在并集上
//! 必然失败（`surf_666`：459 个导出网格里 329 个的并集非凸；`s1_ramp1b` 11 块、并集越界
//! 781.7 HU）。实测那 2889 块**单块全部是凸的**（顶点对面平面越界 ≤ 0.2 HU），所以拆开后判据成立。
//!
//! 几何前提（正确性依赖）：`.phy` 顶点是世界空间（`export_model_phy_colliders` 已做米制→HU、
//! IVP→Source 轴、根骨骼变换、放置变换），VBSP 的 box bevel 取的是**世界轴向** AABB 面 ——
//! 在模型局部空间生成会得到错误的轴向面。
//!
//! 不转 brush 的两类块（保持走三角形路径，见 [`mesh_to_brushes`] 的第二个返回值）：
//! ① 凸性不达标（顶点越界 > [`HULL_CONVEX_TOL`]）——把非凸块当凸体平面表用会把凹处填实；
//! ② 面数 < 4 的退化块。两者都由 `pieces_of_mesh` 标 `convex = false`。
//!
//! 边界：纯几何，不读磁盘、不动玩家、不建索引（索引由 `World::build_index` 统一建）。
//!
//! 测试归属：`phy_hull_gate_tests`（3 项）。

use crate::phys::hull_bevels::{hull_bevels, BevelPlane};
use crate::phys::world::{dot, Brush, Plane, TriMesh, V3};
use std::collections::HashMap;

/// 凸性容差（HU）：顶点对**面平面**的最大越界量超过它，该块就不当凸体用（退回三角形路径）。
///
/// 取 0.5 HU：`surf_666` 全部 2889 块实测最大越界 ≤ 0.2 HU（.phy 凸包的浮点级偏差），
/// 与 debug 侧凸包重建用的 `HULL_EPS` 同量级。
pub const HULL_CONVEX_TOL: f64 = 0.5;

/// 可用凸体的面数下限：少于此值的块（平板、退化三角形集）不当凸体用。
const MIN_FACES: usize = 4;

/// 一块凸体的拆分与补面产物。
pub struct HullPiece {
    /// 完整平面表：前 `face_count` 张是真实面，其后是生成的 box / edge bevel。
    pub planes: Vec<Plane>,
    /// 只含**生成的** bevel（debug 显示用；真实面由 `.phy` 三角形线框那条路显示）。
    /// 带类别与来源边：显示端只画 edge bevel、且画成沿该边的窄条。
    pub generated: Vec<BevelPlane>,
    /// 真实面张数（共面三角形已并成一张）。
    pub face_count: usize,
    /// 生成的 box bevel 张数。
    pub box_added: usize,
    /// 生成的 edge bevel 张数。
    pub edge_added: usize,
    /// 被「全部顶点在面内侧」判据否决的 edge 候选数。
    pub rejected: usize,
    /// 该块顶点三轴包围盒（brush 的 AABB 直接用它）。
    pub min: V3,
    pub max: V3,
    /// 该块在**原网格**里的三角形（非凸块要原样退回三角形路径，故保留原下标）。
    pub tris: Vec<[u32; 3]>,
    /// 顶点数 / 三角形数（诊断用）。
    pub vertex_count: usize,
    pub triangle_count: usize,
    /// 可用凸体（凸性达标 **且** 面数够）。false 的块由调用方退回三角形路径。
    pub convex: bool,
    /// 顶点对全部面平面的最大越界量（HU；> 容差即非凸）。
    pub max_violation: f64,
}

/// 顶点连通分量（并查集）：导出时每块凸体占一段**连续**顶点区间、三角形不跨块，
/// 故连通分量与解析期的凸体块一一对应。
fn components(vertex_count: usize, tris: &[[u32; 3]]) -> Vec<Vec<u32>> {
    let mut parent: Vec<u32> = (0..vertex_count as u32).collect();
    fn find(parent: &mut [u32], mut x: u32) -> u32 {
        while parent[x as usize] != x {
            let gp = parent[parent[x as usize] as usize];
            parent[x as usize] = gp;
            x = gp;
        }
        x
    }
    for t in tris {
        let a = find(&mut parent, t[0]);
        for o in [t[1], t[2]] {
            let r = find(&mut parent, o);
            if r != a {
                parent[r as usize] = a;
            }
        }
    }
    let mut groups: HashMap<u32, Vec<u32>> = HashMap::new();
    for i in 0..vertex_count as u32 {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }
    // 顺序固定：按块内最小顶点下标升序（= 导出时各凸体的先后），不让 HashMap 迭代顺序漂移。
    let mut out: Vec<Vec<u32>> = groups.into_values().collect();
    out.sort_by_key(|ids| ids.iter().copied().min().unwrap_or(u32::MAX));
    out
}

/// 面平面集是否在六个轴向都有界：每条轴向上都要有面给出正、负分量。
///
/// 不满足 ⇒ 面集是**开集**（平板、缺面的壳），此时补上的 AABB 面会把它**补成一个盒子**
/// ——那才是"外部包裹框"，绝不是凸体的 Minkowski 补面。这类块一律退回三角形路径。
fn faces_are_bounded(faces: &[Plane]) -> bool {
    let mut pos = [false; 3];
    let mut neg = [false; 3];
    for p in faces {
        for i in 0..3 {
            if p.normal[i] > 1e-9 {
                pos[i] = true;
            } else if p.normal[i] < -1e-9 {
                neg[i] = true;
            }
        }
    }
    pos.iter().all(|b| *b) && neg.iter().all(|b| *b)
}

/// 网格顶点三轴包围盒（空表返回全零）。
fn bounds(verts: &[V3]) -> (V3, V3) {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for v in verts {
        for i in 0..3 {
            if v[i] < min[i] {
                min[i] = v[i];
            }
            if v[i] > max[i] {
                max[i] = v[i];
            }
        }
    }
    if verts.is_empty() {
        return ([0.0; 3], [0.0; 3]);
    }
    (min, max)
}

/// 把一个网格按连通分量拆块，逐块生成补面（顺序 = 顶点下标升序的第一个顶点所在块）。
pub fn pieces_of_mesh(mesh: &TriMesh) -> Vec<HullPiece> {
    let mut pieces = Vec::new();
    for ids in components(mesh.vertices.len(), &mesh.indices) {
        if ids.len() < 3 {
            continue;
        }
        let mut remap: Vec<u32> = vec![u32::MAX; mesh.vertices.len()];
        let mut verts: Vec<V3> = Vec::with_capacity(ids.len());
        for &i in &ids {
            remap[i as usize] = verts.len() as u32;
            verts.push(mesh.vertices[i as usize]);
        }
        let tris_local: Vec<[u32; 3]> = mesh
            .indices
            .iter()
            .filter(|t| remap[t[0] as usize] != u32::MAX)
            .map(|t| {
                [
                    remap[t[0] as usize],
                    remap[t[1] as usize],
                    remap[t[2] as usize],
                ]
            })
            .collect();
        let tris_origin: Vec<[u32; 3]> = mesh
            .indices
            .iter()
            .filter(|t| remap[t[0] as usize] != u32::MAX)
            .copied()
            .collect();
        if tris_local.is_empty() {
            continue;
        }

        let bevels = hull_bevels(&verts, &tris_local);
        // 凸性：顶点对**真实面**的越界量。凸包上应 ≤ 浮点级。
        let mut max_violation = f64::NEG_INFINITY;
        for p in &bevels.faces {
            for v in &verts {
                let d = dot(&p.normal, v) - p.dist;
                if d > max_violation {
                    max_violation = d;
                }
            }
        }
        // 三个条件缺一不可：面数够、凸性达标、面集自带有界（否则补面会把它补成盒子）。
        let convex = bevels.faces.len() >= MIN_FACES
            && max_violation <= HULL_CONVEX_TOL
            && faces_are_bounded(&bevels.faces);
        let (min, max) = bounds(&verts);
        pieces.push(HullPiece {
            generated: bevels.added.clone(),
            planes: bevels.planes(),
            face_count: bevels.faces.len(),
            box_added: bevels.box_added,
            edge_added: bevels.edge_added,
            rejected: bevels.rejected_edge_candidates,
            min,
            max,
            tris: tris_origin,
            vertex_count: verts.len(),
            triangle_count: tris_local.len(),
            convex,
            max_violation,
        });
    }
    pieces
}

/// 网格 → 凸体 brush 列表 + 未能转换的三角形（原网格下标）+ 非凸块数。
///
/// 调用方（`PhysWorld::build_world`）把 brushes 追加进 `world.solids`，把残余三角形重新装成
/// `TriMesh` 留在 `world.tri_meshes` 走老的逐三角形路径。
pub fn mesh_to_brushes(mesh: &TriMesh) -> (Vec<Brush>, Vec<[u32; 3]>, usize) {
    let mut brushes = Vec::new();
    let mut leftovers = Vec::new();
    let mut non_convex = 0usize;
    for p in pieces_of_mesh(mesh) {
        if p.convex {
            brushes.push(Brush {
                planes: p.planes,
                min: p.min,
                max: p.max,
            });
        } else {
            non_convex += 1;
            leftovers.extend_from_slice(&p.tris);
        }
    }
    (brushes, leftovers, non_convex)
}
