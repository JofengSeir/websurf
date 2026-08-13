//! 碰撞导出：BRUSHES / BRUSHSIDES / PLANES → 与 game brushJson 同构的 JSON。
//!
//! 输出契约为 `WasmBrush[]`（与 game `export_brushes_planes` 一致，可直接被
//! game/debug 的 `buildWorldBundle` 消费）：
//! ```json
//! [{
//!   "planes": [{ "normal": [x,y,z], "dist": f32 }],   // cs-movement 朝外约定：内部 = dot(n,p)-dist <= 0
//!   "min": [x,y,z], "max": [x,y,z],                   // 半空间交点包围盒（Y-up）
//!   "is_ladder": bool, "is_solid": bool               // contents 标志
//! }]
//! ```
//!
//! 算法与 game lib.rs `export_brushes_planes` 逐项对齐：
//! 1. 原始 PLANES 约定为「法线朝内」（内部 = dot(n,p)-dist >= 0，`compute_vertices`
//!    用 `d < -1.0` 判非法点）；
//! 2. **法线翻转回退**：顶点 < 4 时全部取负（-n, -d）重算（部分编辑器生成朝外 brush）；
//! 3. **实体 brush origin 平移**：实体 `model="*N"`（N>0）且带 `origin` 时，从
//!    model.head_node 遍历 BSP 树收集其 brush，平面 dist 平移 `n·origin`
//!    （game 同款修复：实体 brush 平面是局部坐标，不平移会堆在模型原点）；
//! 4. 导出 = 先旋转到 Y-up（[x,y,z]→[y,z,x]）再取负（normal 与 dist 同负）——
//!    cs-movement `traceBox` 用「法线朝外」（内部在负侧，d1>0 表示起点在外）。

use bsp_extract::{lumps, BspError, BspFile};
use serde::Serialize;

/// 输出结构（与 game `WasmBrushPlane` 同构；f32 字段经 serde 输出最短 round-trip
/// 十进制——与 game 的 brushJson 文本格式逐字节可比）。
#[derive(Serialize)]
struct WasmBrushPlane {
    normal: [f32; 3],
    dist: f32,
}

/// 输出结构（与 game `WasmBrush` 同构）。
#[derive(Serialize)]
struct WasmBrush {
    planes: Vec<WasmBrushPlane>,
    min: [f32; 3],
    max: [f32; 3],
    is_ladder: bool,
    is_solid: bool,
}

/// BRUSHES lump 记录（v2，12 字节）。
struct Brush {
    first_side: usize,
    num_sides: usize,
    contents: u32,
}

/// BRUSHSIDES lump 记录（v2，8 字节）。
struct BrushSide {
    plane_num: u16,
}

/// PLANES lump 记录（20 字节）。
#[derive(Clone, Copy)]
struct Plane {
    normal: [f32; 3],
    dist: f32,
}

/// MODELS lump 记录（48 字节；实体 origin 来自实体 KV，MODELS.origin 字段恒 0 不读）。
struct Model {
    head_node: i32,
}

/// NODES lump 记录（24 字节）。
struct Node {
    children: [i32; 2],
}

/// LEAFS lump 记录（v19+ 56/60 字节；仅需要 first_leaf_brush / num_leaf_brushes）。
struct Leaf {
    first_leaf_brush: u16,
    num_leaf_brushes: u16,
}

/// 解析 PLANES（20B/项：normal×3 + dist + type）。
fn parse_planes(bsp: &BspFile) -> Result<Vec<Plane>, BspError> {
    let Some(data) = bsp.lump_data(lumps::PLANES, false)? else {
        return Ok(Vec::new());
    };
    const PLANE_SIZE: usize = 20;
    if !data.len().is_multiple_of(PLANE_SIZE) {
        return Err(BspError::Entity(format!(
            "PLANES lump 大小非法:{}",
            data.len()
        )));
    }
    Ok(data
        .chunks_exact(PLANE_SIZE)
        .map(|c| {
            let mut normal = [0f32; 3];
            for (i, n) in normal.iter_mut().enumerate() {
                *n = f32::from_le_bytes(c[i * 4..i * 4 + 4].try_into().unwrap());
            }
            Plane {
                normal,
                dist: f32::from_le_bytes(c[12..16].try_into().unwrap()),
            }
        })
        .collect())
}

/// 解析 BRUSHES（12B/项：firstside u32 + numsides u32 + contents u32）。
fn parse_brushes(bsp: &BspFile) -> Result<Vec<Brush>, BspError> {
    let Some(data) = bsp.lump_data(lumps::BRUSHES, false)? else {
        return Ok(Vec::new());
    };
    const BRUSH_SIZE: usize = 12;
    if !data.len().is_multiple_of(BRUSH_SIZE) {
        return Err(BspError::Entity(format!(
            "BRUSHES lump 大小非法:{}",
            data.len()
        )));
    }
    Ok(data
        .chunks_exact(BRUSH_SIZE)
        .map(|c| Brush {
            first_side: u32::from_le_bytes(c[0..4].try_into().unwrap()) as usize,
            num_sides: u32::from_le_bytes(c[4..8].try_into().unwrap()) as usize,
            contents: u32::from_le_bytes(c[8..12].try_into().unwrap()),
        })
        .collect())
}

/// 解析 BRUSHSIDES（8B/项：plane_num u16 + texinfo i16 + dispinfo i16 + bevel i16）。
fn parse_brushsides(bsp: &BspFile) -> Result<Vec<BrushSide>, BspError> {
    let Some(data) = bsp.lump_data(lumps::BRUSHSIDES, false)? else {
        return Ok(Vec::new());
    };
    const SIDE_SIZE: usize = 8;
    if !data.len().is_multiple_of(SIDE_SIZE) {
        return Err(BspError::Entity(format!(
            "BRUSHSIDES lump 大小非法:{}",
            data.len()
        )));
    }
    Ok(data
        .chunks_exact(SIDE_SIZE)
        .map(|c| BrushSide {
            plane_num: u16::from_le_bytes(c[0..2].try_into().unwrap()),
        })
        .collect())
}

/// 三平面求交（Cramer 法则）——计算 brush 顶点用（算法与 game lib.rs 一致）。
fn plane_intersect(p1: &Plane, p2: &Plane, p3: &Plane) -> Option<[f32; 3]> {
    let n1 = p1.normal;
    let n2 = p2.normal;
    let n3 = p3.normal;
    let c23 = [
        n2[1] * n3[2] - n2[2] * n3[1],
        n2[2] * n3[0] - n2[0] * n3[2],
        n2[0] * n3[1] - n2[1] * n3[0],
    ];
    let det = n1[0] * c23[0] + n1[1] * c23[1] + n1[2] * c23[2];
    if det.abs() < 1e-6 {
        return None;
    }
    let c31 = [
        n3[1] * n1[2] - n3[2] * n1[1],
        n3[2] * n1[0] - n3[0] * n1[2],
        n3[0] * n1[1] - n3[1] * n1[0],
    ];
    let c12 = [
        n1[1] * n2[2] - n1[2] * n2[1],
        n1[2] * n2[0] - n1[0] * n2[2],
        n1[0] * n2[1] - n1[1] * n2[0],
    ];
    let inv = 1.0 / det;
    Some([
        (c23[0] * p1.dist + c31[0] * p2.dist + c12[0] * p3.dist) * inv,
        (c23[1] * p1.dist + c31[1] * p2.dist + c12[1] * p3.dist) * inv,
        (c23[2] * p1.dist + c31[2] * p2.dist + c12[2] * p3.dist) * inv,
    ])
}

/// 半空间交集顶点（原始「法线朝内」约定：内部 = dot(n,p)-dist >= 0）。
/// 带空间哈希去重（3×3×3 邻域，距离² < 0.01 视为同点）——与 game 一致，
/// **去重后的顶点数决定法线翻转回退是否触发**，必须逐字对齐。
/// 平面数 < 4 或顶点 < 4 时返回 None（上层触发翻转回退/跳过）。
fn compute_vertices(planes: &[Plane]) -> Option<Vec<[f32; 3]>> {
    let n = planes.len();
    if n < 4 {
        return None;
    }
    let mut verts: Vec<[f32; 3]> = Vec::new();
    let mut spatial: std::collections::HashMap<(i32, i32, i32), Vec<usize>> =
        std::collections::HashMap::new();
    for i in 0..n {
        for j in (i + 1)..n {
            for k in (j + 1)..n {
                if let Some(v) = plane_intersect(&planes[i], &planes[j], &planes[k]) {
                    // 验证 v 在所有平面的正侧（d >= -1.0 容差；与 game 一致）
                    if !planes.iter().all(|p| {
                        p.normal[0] * v[0] + p.normal[1] * v[1] + p.normal[2] * v[2] - p.dist
                            >= -1.0
                    }) {
                        continue;
                    }
                    // 空间哈希去重（距离 < 0.1 HU 视为同一点；与 game 逐字一致）
                    let key = (
                        (v[0] * 10.0) as i32,
                        (v[1] * 10.0) as i32,
                        (v[2] * 10.0) as i32,
                    );
                    let mut dup = false;
                    'outer: for dx in -1..=1i32 {
                        for dy in -1..=1i32 {
                            for dz in -1..=1i32 {
                                if let Some(indices) =
                                    spatial.get(&(key.0 + dx, key.1 + dy, key.2 + dz))
                                {
                                    for &idx in indices {
                                        let ev = &verts[idx];
                                        let ddx = ev[0] - v[0];
                                        let ddy = ev[1] - v[1];
                                        let ddz = ev[2] - v[2];
                                        if ddx * ddx + ddy * ddy + ddz * ddz < 0.01 {
                                            dup = true;
                                            break 'outer;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if !dup {
                        spatial.entry(key).or_default().push(verts.len());
                        verts.push(v);
                    }
                }
            }
        }
    }
    if verts.len() < 4 {
        return None;
    }
    Some(verts)
}

/// 翻转半空间（法线朝内 ↔ 朝外）：(n, d) → (-n, -d)。
fn flip(planes: &[Plane]) -> Vec<Plane> {
    planes
        .iter()
        .map(|p| Plane {
            normal: [-p.normal[0], -p.normal[1], -p.normal[2]],
            dist: -p.dist,
        })
        .collect()
}

/// 解析 MODELS（48B/项：min 12 + max 12 + origin 12 + headnode 4 + firstface 4 + numfaces 4）。
fn parse_models(bsp: &BspFile) -> Result<Vec<Model>, BspError> {
    let Some(data) = bsp.lump_data(lumps::MODELS, false)? else {
        return Ok(Vec::new());
    };
    const MODEL_SIZE: usize = 48;
    if !data.len().is_multiple_of(MODEL_SIZE) {
        return Err(BspError::Entity(format!(
            "MODELS lump 大小非法:{}",
            data.len()
        )));
    }
    Ok(data
        .chunks_exact(MODEL_SIZE)
        .map(|c| Model {
            head_node: i32::from_le_bytes(c[36..40].try_into().unwrap()),
        })
        .collect())
}

/// 解析 NODES（结构大小随 lump version：v0 = 32B 含 first_face/num_faces/area；v1+ = 24B）。
fn parse_nodes(bsp: &BspFile) -> Result<Vec<Node>, BspError> {
    let Some(data) = bsp.lump_data(lumps::NODES, false)? else {
        return Ok(Vec::new());
    };
    // 首选按 lump version 推断；不整除时回退尝试另一大小（防个别地图 version 字段异常）
    let version = bsp.lump_entry(lumps::NODES).map(|l| l.version).unwrap_or(1);
    let size = if version == 0 { 32 } else { 24 };
    let size = if data.len().is_multiple_of(size) {
        size
    } else if data.len().is_multiple_of(24) {
        24
    } else if data.len().is_multiple_of(32) {
        32
    } else {
        return Err(BspError::Entity(format!(
            "NODES lump 大小非法:{}",
            data.len()
        )));
    };
    Ok(data
        .chunks_exact(size)
        .map(|c| Node {
            children: [
                i32::from_le_bytes(c[4..8].try_into().unwrap()),
                i32::from_le_bytes(c[8..12].try_into().unwrap()),
            ],
        })
        .collect())
}

/// 解析 LEAFS（结构大小随 lump version：v0 = 32B；v1 = 56B（v19/20）；v2 = 60B（v21+）。
/// 只取前 16 字节的 first_leaf_brush/num_leaf_brushes，偏移对全部版本稳定）。
fn parse_leaves(bsp: &BspFile) -> Result<Vec<Leaf>, BspError> {
    let Some(data) = bsp.lump_data(lumps::LEAFS, false)? else {
        return Ok(Vec::new());
    };
    let version = bsp.lump_entry(lumps::LEAFS).map(|l| l.version).unwrap_or(1);
    let size = match version {
        0 => 32,
        2 => 60,
        _ => 56,
    };
    let size = if data.len().is_multiple_of(size) {
        size
    } else {
        // 回退：实际整除的已知大小
        [56usize, 60, 32]
            .into_iter()
            .find(|&s| data.len().is_multiple_of(s))
            .ok_or_else(|| BspError::Entity(format!("LEAFS lump 大小非法:{}", data.len())))?
    };
    Ok(data
        .chunks_exact(size)
        .map(|c| {
            // first_leaf_brush 偏移随结构版本（与 game vbsp::Leaf 对齐）：
            // v0(32B, Quake 风格 dleaf_t)：contents(0) cluster(4) area+flags(6)
            //   mins(8) maxs(14) firstleafface(20) numleaffaces(22)
            //   **firstleafbrush(24)** numleafbrushes(26) leafwaterdata(28) padding(30)
            // v1(56B)/v2(60B)：contents(0) cluster(4) area(6) flags(8) leafType(10)
            //   firstleafbrush(12) numleafbrushes(14) ...
            let foff = if size == 32 { 24 } else { 12 };
            Leaf {
                first_leaf_brush: u16::from_le_bytes(c[foff..foff + 2].try_into().unwrap()),
                num_leaf_brushes: u16::from_le_bytes(c[foff + 2..foff + 4].try_into().unwrap()),
            }
        })
        .collect())
}

/// 解析 LEAFBRUSHES（2B/项 u16）。
fn parse_leafbrushes(bsp: &BspFile) -> Result<Vec<u16>, BspError> {
    let Some(data) = bsp.lump_data(lumps::LEAFBRUSHES, false)? else {
        return Ok(Vec::new());
    };
    if !data.len().is_multiple_of(2) {
        return Err(BspError::Entity(format!(
            "LEAFBRUSHES lump 大小非法:{}",
            data.len()
        )));
    }
    Ok(data
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes(c.try_into().unwrap()))
        .collect())
}

/// brush → 模型 origin 映射（复刻 game `build_brush_model_origins`）：
/// 1. 实体 `model="*N"`（N>0，首个实体优先）且带 `origin` → model_origins[N]；
/// 2. 从 model N 的 head_node 遍历 BSP 树（负数 = leaf，经 LEAFBRUSHES 收集 brush）。
fn build_brush_origins(
    bsp: &BspFile,
    models: &[Model],
    nodes: &[Node],
    leaves: &[Leaf],
    leaf_brushes: &[u16],
    brush_count: usize,
) -> Result<Vec<[f32; 3]>, BspError> {
    let mut origins = vec![[0.0f32; 3]; brush_count];
    let entities = bsp.entities()?;

    // 1. 实体 → 模型 origin
    let mut model_origins: Vec<Option<[f32; 3]>> = vec![None; models.len()];
    for ent in &entities {
        let Some(model_raw) = ent.get("model") else {
            continue;
        };
        let model_raw = model_raw.trim();
        if !model_raw.starts_with('*') {
            continue;
        }
        let Ok(mi) = model_raw[1..].parse::<usize>() else {
            continue;
        };
        if mi == 0 || mi >= model_origins.len() || model_origins[mi].is_some() {
            continue; // 跳过 worldspawn 与重复引用（首个实体优先）
        }
        let Some(origin_raw) = ent.get("origin") else {
            continue;
        };
        let parts: Vec<&str> = origin_raw.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }
        let (Ok(ox), Ok(oy), Ok(oz)) = (
            parts[0].parse::<f32>(),
            parts[1].parse::<f32>(),
            parts[2].parse::<f32>(),
        ) else {
            continue;
        };
        model_origins[mi] = Some([ox, oy, oz]);
    }

    // 2. brush → 模型归属（head_node 子树遍历）
    for (mi, model) in models.iter().enumerate() {
        if mi == 0 {
            continue;
        }
        let Some(origin) = model_origins[mi] else {
            continue;
        };
        let mut stack: Vec<i32> = vec![model.head_node];
        while let Some(node_idx) = stack.pop() {
            if node_idx < 0 {
                // 负数 → leaf（~idx）
                let leaf_idx = (!node_idx) as usize;
                let Some(leaf) = leaves.get(leaf_idx) else {
                    continue;
                };
                let start = leaf.first_leaf_brush as usize;
                let count = leaf.num_leaf_brushes as usize;
                for k in start..(start + count).min(leaf_brushes.len()) {
                    if let Some(&lb) = leaf_brushes.get(k) {
                        if (lb as usize) < origins.len() {
                            origins[lb as usize] = origin;
                        }
                    }
                }
            } else if let Some(node) = nodes.get(node_idx as usize) {
                stack.push(node.children[0]);
                stack.push(node.children[1]);
            }
        }
    }
    Ok(origins)
}

/// 导出全部 brush 碰撞（世界模型 + brush 实体共用一个 BRUSHES lump）。
///
/// 返回 WasmBrush[] JSON 字符串（与 game brushJson 契约同构：cs-movement 朝外约定，
/// f32 最短十进制序列化——文本级可比）。
pub fn export_collision(bsp: &BspFile) -> Result<String, BspError> {
    let planes = parse_planes(bsp)?;
    let brushes = parse_brushes(bsp)?;
    let sides = parse_brushsides(bsp)?;
    let models = parse_models(bsp)?;
    let nodes = parse_nodes(bsp)?;
    let leaves = parse_leaves(bsp)?;
    let leaf_brushes = parse_leafbrushes(bsp)?;
    let brush_origins =
        build_brush_origins(bsp, &models, &nodes, &leaves, &leaf_brushes, brushes.len())?;

    let mut out = Vec::new();
    let mut flipped_count = 0usize;
    for (bi, b) in brushes.iter().enumerate() {
        // 越界防护：跳过坏 brush
        if b.first_side + b.num_sides > sides.len() {
            continue;
        }
        let mut brush_planes: Vec<Plane> = Vec::with_capacity(b.num_sides);
        for s in &sides[b.first_side..b.first_side + b.num_sides] {
            let Some(p) = planes.get(s.plane_num as usize) else {
                continue;
            };
            brush_planes.push(*p);
        }
        if brush_planes.len() < 4 {
            continue;
        }

        // 实体 brush：平面 dist 平移 origin（BSP 坐标；法线不变——game 同款修复）。
        // 运算顺序与 game 逐字一致（从左到右累加，浮点结合序影响尾数）
        let origin = brush_origins[bi];
        if origin[0] != 0.0 || origin[1] != 0.0 || origin[2] != 0.0 {
            for p in &mut brush_planes {
                p.dist = p.dist
                    + p.normal[0] * origin[0]
                    + p.normal[1] * origin[1]
                    + p.normal[2] * origin[2];
            }
        }

        // 顶点（原始约定）；不足 4 个 → 翻转法线重算（与 game 回退一致）
        let mut verts = compute_vertices(&brush_planes);
        let used_planes;
        if verts.is_none() {
            let flipped = flip(&brush_planes);
            verts = compute_vertices(&flipped);
            used_planes = flipped;
            flipped_count += 1;
        } else {
            used_planes = brush_planes;
        }
        let Some(verts) = verts else { continue };

        // AABB（BSP 坐标 → Y-up）
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for v in &verts {
            let ry = [v[1], v[2], v[0]]; // [x,y,z]→[y,z,x]
            for i in 0..3 {
                min[i] = min[i].min(ry[i]);
                max[i] = max[i].max(ry[i]);
            }
        }
        if min
            .iter()
            .zip(max.iter())
            .any(|(a, b)| !a.is_finite() || !b.is_finite() || b - a < 1.0)
        {
            continue;
        }

        // 导出 = 旋转到 Y-up 后取负（normal 与 dist 同负 → cs-movement 朝外约定）
        let planes_json: Vec<WasmBrushPlane> = used_planes
            .iter()
            .map(|p| {
                let r = [p.normal[1], p.normal[2], p.normal[0]];
                WasmBrushPlane {
                    normal: [-r[0], -r[1], -r[2]],
                    dist: -p.dist,
                }
            })
            .collect();

        // CONTENTS_SOLID=0x1 / CONTENTS_LADDER=0x2
        out.push(WasmBrush {
            planes: planes_json,
            min,
            max,
            is_ladder: b.contents & 0x2 != 0,
            is_solid: b.contents & 0x1 != 0,
        });
    }

    if flipped_count > 0 {
        eprintln!(
            "[collision] {flipped_count}/{} brush 触发法线翻转回退",
            brushes.len()
        );
    }
    serde_json::to_string(&out).map_err(|e| BspError::Entity(format!("序列化碰撞 JSON 失败:{e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aabb_of_cube() {
        // 单位立方体 6 面（法线朝内约定：内部 = dot(n,p)-dist >= 0）
        let planes = [
            Plane {
                normal: [1.0, 0.0, 0.0],
                dist: -0.5,
            },
            Plane {
                normal: [-1.0, 0.0, 0.0],
                dist: -0.5,
            },
            Plane {
                normal: [0.0, 1.0, 0.0],
                dist: -0.5,
            },
            Plane {
                normal: [0.0, -1.0, 0.0],
                dist: -0.5,
            },
            Plane {
                normal: [0.0, 0.0, 1.0],
                dist: -0.5,
            },
            Plane {
                normal: [0.0, 0.0, -1.0],
                dist: -0.5,
            },
        ];
        let verts = compute_vertices(&planes).expect("cube verts");
        assert_eq!(verts.len(), 8);
    }

    #[test]
    fn flip_recovers_outward_brush() {
        // 10×10×10 立方体但法线朝外（内部 = dot(n,p)-dist <= 0）：
        // 角点在原始「朝内」约定下 d = -10 < -1.0 明确越界 → 无顶点；翻转后恢复 8 顶点
        let outward = [
            Plane {
                normal: [-1.0, 0.0, 0.0],
                dist: 5.0,
            },
            Plane {
                normal: [1.0, 0.0, 0.0],
                dist: 5.0,
            },
            Plane {
                normal: [0.0, -1.0, 0.0],
                dist: 5.0,
            },
            Plane {
                normal: [0.0, 1.0, 0.0],
                dist: 5.0,
            },
            Plane {
                normal: [0.0, 0.0, -1.0],
                dist: 5.0,
            },
            Plane {
                normal: [0.0, 0.0, 1.0],
                dist: 5.0,
            },
        ];
        assert!(compute_vertices(&outward).is_none());
        let flipped = flip(&outward);
        let verts = compute_vertices(&flipped).expect("flipped cube verts");
        assert_eq!(verts.len(), 8);
    }
}
