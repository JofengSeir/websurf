//! Displacement 地形解析与三角化(参照 websurf vbsp handle/displacement.rs)。
//!
//! 数据来源:
//! - DISPINFO(lump 26):每项 176 字节,含 start_position、power、displacement_vertex_start、map_face
//! - DISP_VERTS(lump 33):每项 20 字节(vector 12B + distance 4B + alpha 4B)
//!
//! 算法:
//! 1. 取 displacement 对应的 face 的 4 个角点,按 start_position 对齐旋转
//! 2. 双线性细分 (power+1)² 网格
//! 3. 每个网格点 + vector*distance 位移
//! 4. 每 cell 两个三角形,顶点顺序 [00,10,01, 10,11,01](与 src 一致)

use crate::bsp::{BspError, lumps};
use crate::BspFile;

#[derive(Debug, Clone)]
pub struct DisplacementInfo {
    pub start_position: [f32; 3],
    pub displacement_vertex_start: i32,
    pub power: i32,
    pub map_face: u16,
}

#[derive(Debug, Clone)]
pub struct DisplacementVertex {
    pub vector: [f32; 3],
    pub distance: f32,
}

/// 解析 DISPINFO lump(176 字节/项)。
pub fn parse_dispinfo(bsp: &BspFile) -> Result<Vec<DisplacementInfo>, BspError> {
    let Some(data) = bsp.lump_data(lumps::DISPINFO, false)? else {
        return Ok(Vec::new());
    };
    const SIZE: usize = 176;
    if !data.len().is_multiple_of(SIZE) {
        return Ok(Vec::new()); // 无 displacement 时 lump 可能为空
    }
    let mut out = Vec::with_capacity(data.len() / SIZE);
    for chunk in data.chunks_exact(SIZE) {
        let read_f32 = |off: usize| f32::from_le_bytes(chunk[off..off + 4].try_into().unwrap());
        let read_i32 = |off: usize| i32::from_le_bytes(chunk[off..off + 4].try_into().unwrap());
        let read_u16 = |off: usize| u16::from_le_bytes(chunk[off..off + 2].try_into().unwrap());
        out.push(DisplacementInfo {
            start_position: [read_f32(0), read_f32(4), read_f32(8)],
            displacement_vertex_start: read_i32(12),
            // ddispinfo_t: start(12) + dispVertStart(4) + dispTriStart(4) + power(4)@20
            //   + minTess(4) + smoothing(4) + contents(4) = 36,mapFace u16 @ 36
            power: read_i32(20),
            map_face: read_u16(36),
        });
    }
    Ok(out)
}

/// 解析 DISP_VERTS lump(20 字节/项)。
pub fn parse_dispverts(bsp: &BspFile) -> Result<Vec<DisplacementVertex>, BspError> {
    let Some(data) = bsp.lump_data(lumps::DISP_VERTS, false)? else {
        return Ok(Vec::new());
    };
    const SIZE: usize = 20;
    if !data.len().is_multiple_of(SIZE) {
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(data.len() / SIZE);
    for chunk in data.chunks_exact(SIZE) {
        let read_f32 = |off: usize| f32::from_le_bytes(chunk[off..off + 4].try_into().unwrap());
        out.push(DisplacementVertex {
            vector: [read_f32(0), read_f32(4), read_f32(8)],
            distance: read_f32(12),
        });
    }
    Ok(out)
}

/// 计算 displacement 三角化后的顶点序列。
///
/// `face_corners`:该 displacement 对应 face 的 4 个角点位置(与 websurf corner_positions 相同顺序)。
/// 返回按三角形展开的顶点序列(每 3 个顶点一个三角形,每三角形 6 顶点两个三角形 per cell)。
pub fn triangulate_displacement(
    disp: &DisplacementInfo,
    dispverts: &[DisplacementVertex],
    face_corners: &[[f32; 3]; 4],
) -> Vec<[f32; 3]> {
    let steps = 2usize.pow(disp.power as u32) + 1;
    if steps < 2 {
        return Vec::new();
    }

    // ---- 角点旋转对齐 start_position ----
    let mut corners = *face_corners;
    let start = disp.start_position;
    let start_index = corners
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| dist2(**a, start).partial_cmp(&dist2(**b, start)).unwrap())
        .map(|(i, _)| i)
        .unwrap_or(0);
    corners.rotate_left(start_index);

    // ---- 双线性细分 ----
    let step_scale = 1.0 / (steps as f32 - 1.0);
    let edge_intervals = [
        sub(corners[1], corners[0]).map(|v| v * step_scale),
        sub(corners[2], corners[3]).map(|v| v * step_scale),
    ];

    let mut base_positions = Vec::with_capacity(steps * steps);
    for x in 0..steps {
        let edge_positions = [
            add(corners[0], edge_intervals[0].map(|v| v * x as f32)),
            add(corners[3], edge_intervals[1].map(|v| v * x as f32)),
        ];
        let segment_interval = sub(edge_positions[1], edge_positions[0]).map(|v| v * step_scale);
        for y in 0..steps {
            base_positions.push(add(edge_positions[0], segment_interval.map(|v| v * y as f32)));
        }
    }

    // ---- 位移 ----
    let start = disp.displacement_vertex_start.max(0) as usize;
    let n = dispverts.len();
    let mut displaced = Vec::with_capacity(base_positions.len());
    for (i, base) in base_positions.iter().enumerate() {
        let vi = start + i;
        let d = if vi < n {
            let v = &dispverts[vi];
            v.vector.map(|c| c * v.distance)
        } else {
            [0.0; 3]
        };
        displaced.push(add(*base, d));
    }

    // ---- 三角化(每 cell 2 三角形,顺序与 src 一致)----
    let cell_steps = steps - 1;
    let index = |x: usize, y: usize| y * steps + x;
    let mut out = Vec::with_capacity(cell_steps * cell_steps * 6);
    for x in 0..cell_steps {
        for y in 0..cell_steps {
            let a = displaced[index(x, y)];
            let b = displaced[index(x + 1, y)];
            let c = displaced[index(x, y + 1)];
            let d = displaced[index(x + 1, y + 1)];
            // 与 websurf triangulated_displaced_vertices 顺序一致
            out.push(a);
            out.push(b);
            out.push(c);
            out.push(b);
            out.push(d);
            out.push(c);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 向量辅助
// ---------------------------------------------------------------------------

fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dist2(a: [f32; 3], b: [f32; 3]) -> f32 {
    let d = sub(a, b);
    d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triangulate_small_disp() {
        // power=0 → 2×2 网格(4 角点),1 cell → 2 三角形 = 6 顶点
        let disp = DisplacementInfo {
            start_position: [0.0, 0.0, 0.0],
            displacement_vertex_start: 0,
            power: 0,
            map_face: 0,
        };
        let dispverts = vec![
            DisplacementVertex { vector: [0.0, 0.0, 0.0], distance: 0.0 },
            DisplacementVertex { vector: [0.0, 0.0, 0.0], distance: 0.0 },
            DisplacementVertex { vector: [0.0, 0.0, 0.0], distance: 0.0 },
            DisplacementVertex { vector: [0.0, 0.0, 0.0], distance: 0.0 },
        ];
        // 角点顺序:与 start_position 最近的角点会被旋转到首位。
        // 设 start 接近 corner0,则角点按 [c0,c1,c2,c3] 保留。
        let corners: [[f32; 3]; 4] = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]];
        let verts = triangulate_displacement(&disp, &dispverts, &corners);
        assert_eq!(verts.len(), 6); // 2 三角形 × 3 顶点
        // 无位移:cell 四角 (0,0) (1,0) (1,1) (0,1) → 三角 [00,10,01] 与 [10,11,01]
        // 期望顶点集合 = 四个角点各出现多次
        let mut distinct: Vec<[f32; 3]> = Vec::new();
        for v in &verts {
            if !distinct.contains(v) {
                distinct.push(*v);
            }
        }
        assert_eq!(distinct.len(), 4);
        assert!(distinct.contains(&[0.0, 0.0, 0.0]));
        assert!(distinct.contains(&[1.0, 0.0, 0.0]));
        assert!(distinct.contains(&[0.0, 1.0, 0.0]));
        assert!(distinct.contains(&[1.0, 1.0, 0.0]));
    }

    #[test]
    fn displacement_offset_applied() {
        let disp = DisplacementInfo {
            start_position: [0.0, 0.0, 0.0],
            displacement_vertex_start: 0,
            power: 0,
            map_face: 0,
        };
        // 顶点 0 沿 +Z 位移 2.0
        let dispverts = vec![
            DisplacementVertex { vector: [0.0, 0.0, 1.0], distance: 2.0 },
            DisplacementVertex { vector: [0.0, 0.0, 0.0], distance: 0.0 },
            DisplacementVertex { vector: [0.0, 0.0, 0.0], distance: 0.0 },
            DisplacementVertex { vector: [0.0, 0.0, 0.0], distance: 0.0 },
        ];
        let corners: [[f32; 3]; 4] = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]];
        let verts = triangulate_displacement(&disp, &dispverts, &corners);
        // 第一个顶点有位移
        assert!((verts[0][2] - 2.0).abs() < 1e-5);
    }
}
