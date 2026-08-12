//! BSP 场景几何重建:面(lump 7)→ 三角形,带 UV 与材质名。
//!
//! 参照 websurf vbsp / sourcepp 的算法:
//! - Face v1(56B):plane_num u16, side u8, on_node u8, first_edge i32, num_edges i16,
//!   tex_info i16, disp_info i16, fog i16, styles[4], light_offset i32, area f32,
//!   lightmap_min[2] i32, lightmap_size[2] i32, original_face i32, num_prims u16,
//!   first_prim u16, smoothing u32
//! - 顶点索引链:face → surfedges → edges → vertices(负 surfedge 表示反向)
//! - 三角化:扇形(fan),顺序 [c, b, a]
//! - UV:u = dot(texTransformU.xyz, pos) + texTransformU.w) / texWidth;v 同理
//! - 坐标映射:Source Z-up → glTF Y-up,即 [x,y,z] → [y,z,x]
//! - 跳过不可见面:SKY2D/SKY/TRIGGER/NODRAW/HINT/SKIP

use crate::bsp::{BspError, lumps};
use crate::glb::{PrimitiveData, VertexData};
use crate::BspFile;

/// texinfo 的 flags。
const FLAG_SKY2D: u32 = 0b0000_0000_0000_0000_0010;
const FLAG_SKY: u32 = 0b0000_0000_0000_0000_0100;
const FLAG_TRIGGER: u32 = 0b0000_0000_0000_0100_0000;
const FLAG_NODRAW: u32 = 0b0000_0000_0000_1000_0000;
const FLAG_HINT: u32 = 0b0000_0000_0001_0000_0000;
const FLAG_SKIP: u32 = 0b0000_0000_0010_0000_0000;

/// 坐标映射:Source Z-up → glTF Y-up。
#[inline]
pub fn map_coords(p: [f32; 3]) -> [f32; 3] {
    [p[1], p[2], p[0]]
}

// ---------------------------------------------------------------------------
// 解析出的几何数据
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ParsedTexInfo {
    transform_u: [f32; 4],
    transform_v: [f32; 4],
    flags: u32,
    tex_data_index: i32,
}

#[derive(Debug, Clone)]
struct ParsedTexData {
    name_string_id: i32,
    width: i32,
    height: i32,
}

/// 重建整个 BSP 场景,返回按材质分组的 primitives。
pub fn rebuild_scene(bsp: &BspFile) -> Result<Vec<PrimitiveData>, BspError> {
    // ---- 解析基础 lump ----
    let vertices = parse_vertices(bsp)?;
    let edges = parse_edges(bsp)?;
    let surfedges = parse_surfedges(bsp)?;
    let faces = parse_faces(bsp)?;
    let texinfos = parse_texinfos(bsp)?;
    let texdatas = parse_texdatas(bsp)?;
    let (string_table, string_data) = parse_string_table(bsp)?;

    // ---- 按材质分组 ----
    // 材质键 = 纹理名;一个 face 引用一个 texinfo
    let mut groups: Vec<(Option<String>, Vec<FaceRef>)> = Vec::new();
    let mut group_of_texinfo: Vec<Option<usize>> = vec![None; texinfos.len()];

    for (face_idx, face) in faces.iter().enumerate() {
        // 跳过非法索引与不可见面
        let Some(texinfo) = texinfos.get(face.tex_info as usize) else {
            continue;
        };
        if is_invisible(texinfo.flags) {
            continue;
        }
        // 跳过 displacement 面(disp_info >= 0 暂不支持)
        if face.disp_info >= 0 {
            continue;
        }
        // 校验顶点链
        let start = face.first_edge as usize;
        let count = face.num_edges as usize;
        if count < 3 || start + count > surfedges.len() {
            continue;
        }

        let texinfo_idx = face.tex_info as usize;
        let group_idx = if group_of_texinfo[texinfo_idx].is_none() {
            let name = texinfo_name(texinfo, &texdatas, &string_table, &string_data);
            let g = groups.len();
            groups.push((name, Vec::new()));
            group_of_texinfo[texinfo_idx] = Some(g);
            g
        } else {
            group_of_texinfo[texinfo_idx].unwrap()
        };

        groups[group_idx].1.push(FaceRef {
            face_index: face_idx,
            first_edge: start,
            num_edges: count,
            texinfo_idx,
        });
    }

    // ---- 生成顶点 + 索引 ----
    let mut out = Vec::with_capacity(groups.len());
    for (mat_name, face_refs) in groups {
        let mut prim = PrimitiveData {
            vertices: Vec::new(),
            indices: Vec::new(),
            material: mat_name,
        };

        for fr in face_refs {
            let texinfo = &texinfos[fr.texinfo_idx];
            let texdata = texdatas.get(texinfo.tex_data_index as usize);

            // 收集该面的多边形顶点索引
            let mut poly: Vec<[f32; 3]> = Vec::with_capacity(fr.num_edges);
            for se in &surfedges[fr.first_edge..fr.first_edge + fr.num_edges] {
                let edge_idx = se.unsigned_abs() as usize;
                let Some(edge) = edges.get(edge_idx) else { continue };
                // 负 surfedge → 反向
                let vert_idx = if *se >= 0 { edge.start_index as usize } else { edge.end_index as usize };
                let Some(vert) = vertices.get(vert_idx) else { continue };
                poly.push(vert.position);
            }
            if poly.len() < 3 {
                continue;
            }

            // 扇形三角化,与 websurf 顺序一致 [c, b, a]
            // 每三角形 3 个独立顶点,索引依次递增
            let a = poly[0];
            let mut b = poly[1];
            for c in &poly[2..] {
                let tri = [*c, b, a];
                for p in tri {
                    let uv = uv_at(texinfo, texdata, p);
                    prim.vertices.push(VertexData {
                        position: map_coords(p),
                        uv,
                    });
                }
                let base = prim.vertices.len() as u32 - 3;
                prim.indices.push(base);
                prim.indices.push(base + 1);
                prim.indices.push(base + 2);
                b = *c;
            }
        }

        if !prim.vertices.is_empty() {
            out.push(prim);
        }
    }

    Ok(out)
}

#[derive(Debug, Clone)]
struct FaceRef {
    #[allow(dead_code)]
    face_index: usize,
    first_edge: usize,
    num_edges: usize,
    texinfo_idx: usize,
}

/// 面不可见判定(SKY/TRIGGER/NODRAW/HINT/SKIP)。
fn is_invisible(flags: u32) -> bool {
    flags & (FLAG_SKY2D | FLAG_SKY | FLAG_TRIGGER | FLAG_NODRAW | FLAG_HINT | FLAG_SKIP) != 0
}

/// 计算顶点 UV。
fn uv_at(texinfo: &ParsedTexInfo, texdata: Option<&ParsedTexData>, p: [f32; 3]) -> [f32; 2] {
    let (w, h) = match texdata {
        Some(td) if td.width > 0 && td.height > 0 => (td.width as f32, td.height as f32),
        _ => (1.0, 1.0),
    };
    let u = (texinfo.transform_u[0] * p[0]
        + texinfo.transform_u[1] * p[1]
        + texinfo.transform_u[2] * p[2]
        + texinfo.transform_u[3])
        / w;
    let v = (texinfo.transform_v[0] * p[0]
        + texinfo.transform_v[1] * p[1]
        + texinfo.transform_v[2] * p[2]
        + texinfo.transform_v[3])
        / h;
    [u, v]
}

/// 获取 texinfo 对应的纹理名。
fn texinfo_name(
    texinfo: &ParsedTexInfo,
    texdatas: &[ParsedTexData],
    string_table: &[u32],
    string_data: &[u8],
) -> Option<String> {
    let td = texdatas.get(texinfo.tex_data_index as usize)?;
    let str_offset = *string_table.get(td.name_string_id as usize)? as usize;
    if str_offset >= string_data.len() {
        return None;
    }
    let slice = &string_data[str_offset..];
    let end = slice.iter().position(|&b| b == 0).unwrap_or(slice.len());
    String::from_utf8(slice[..end].to_vec()).ok()
}

// ---------------------------------------------------------------------------
// lump 解析
// ---------------------------------------------------------------------------

fn parse_vertices(bsp: &BspFile) -> Result<Vec<Vertex>, BspError> {
    let Some(data) = bsp.lump_data(lumps::VERTEXES, false)? else {
        return Ok(Vec::new());
    };
    if !data.len().is_multiple_of(12) {
        return Err(BspError::Entity(format!("VERTEXES lump 大小非法:{}", data.len())));
    }
    let mut out = Vec::with_capacity(data.len() / 12);
    for chunk in data.chunks_exact(12) {
        out.push(Vertex {
            position: [
                f32::from_le_bytes(chunk[0..4].try_into().unwrap()),
                f32::from_le_bytes(chunk[4..8].try_into().unwrap()),
                f32::from_le_bytes(chunk[8..12].try_into().unwrap()),
            ],
        });
    }
    Ok(out)
}

fn parse_edges(bsp: &BspFile) -> Result<Vec<Edge>, BspError> {
    let Some(data) = bsp.lump_data(lumps::EDGES, false)? else {
        return Ok(Vec::new());
    };
    if !data.len().is_multiple_of(4) {
        return Err(BspError::Entity(format!("EDGES lump 大小非法:{}", data.len())));
    }
    let mut out = Vec::with_capacity(data.len() / 4);
    for chunk in data.chunks_exact(4) {
        out.push(Edge {
            start_index: u16::from_le_bytes(chunk[0..2].try_into().unwrap()),
            end_index: u16::from_le_bytes(chunk[2..4].try_into().unwrap()),
        });
    }
    Ok(out)
}

fn parse_surfedges(bsp: &BspFile) -> Result<Vec<i32>, BspError> {
    let Some(data) = bsp.lump_data(lumps::SURFEDGES, false)? else {
        return Ok(Vec::new());
    };
    if !data.len().is_multiple_of(4) {
        return Err(BspError::Entity(format!("SURFEDGES lump 大小非法:{}", data.len())));
    }
    Ok(data
        .chunks_exact(4)
        .map(|c| i32::from_le_bytes(c.try_into().unwrap()))
        .collect())
}

#[derive(Debug, Clone)]
struct Face {
    #[allow(dead_code)]
    plane_num: u16,
    #[allow(dead_code)]
    side: u8,
    #[allow(dead_code)]
    on_node: u8,
    first_edge: i32,
    num_edges: i16,
    tex_info: i16,
    disp_info: i16,
    #[allow(dead_code)]
    surface_fog_volume_id: i16,
    #[allow(dead_code)]
    styles: [u8; 4],
    #[allow(dead_code)]
    light_offset: i32,
    #[allow(dead_code)]
    area: f32,
    #[allow(dead_code)]
    lightmap_min: [i32; 2],
    #[allow(dead_code)]
    lightmap_size: [i32; 2],
    #[allow(dead_code)]
    original_face: i32,
    #[allow(dead_code)]
    num_prims: u16,
    #[allow(dead_code)]
    first_prim: u16,
    #[allow(dead_code)]
    smoothing_groups: u32,
}

fn parse_faces(bsp: &BspFile) -> Result<Vec<Face>, BspError> {
    let Some(data) = bsp.lump_data(lumps::FACES, false)? else {
        return Ok(Vec::new());
    };
    // Face v1 = 56 字节;若 size 不符(可能是 v0 28B 或 v2 64B),按 56 尝试
    const FACE_SIZE: usize = 56;
    if data.len() % FACE_SIZE != 0 {
        return Err(BspError::Entity(format!("FACES lump 大小非法:{}(非 56 的倍数)", data.len())));
    }
    let mut out = Vec::with_capacity(data.len() / FACE_SIZE);
    for chunk in data.chunks_exact(FACE_SIZE) {
        let mut r = 0usize;
        let mut rd = |n: usize| -> &[u8] {
            let s = &chunk[r..r + n];
            r += n;
            s
        };
        let plane_num = u16::from_le_bytes(rd(2).try_into().unwrap());
        let side = rd(1)[0];
        let on_node = rd(1)[0];
        let first_edge = i32::from_le_bytes(rd(4).try_into().unwrap());
        let num_edges = i16::from_le_bytes(rd(2).try_into().unwrap());
        let tex_info = i16::from_le_bytes(rd(2).try_into().unwrap());
        let disp_info = i16::from_le_bytes(rd(2).try_into().unwrap());
        let surface_fog_volume_id = i16::from_le_bytes(rd(2).try_into().unwrap());
        let styles: [u8; 4] = rd(4).try_into().unwrap();
        let light_offset = i32::from_le_bytes(rd(4).try_into().unwrap());
        let area = f32::from_le_bytes(rd(4).try_into().unwrap());
        let lightmap_min = [
            i32::from_le_bytes(rd(4).try_into().unwrap()),
            i32::from_le_bytes(rd(4).try_into().unwrap()),
        ];
        let lightmap_size = [
            i32::from_le_bytes(rd(4).try_into().unwrap()),
            i32::from_le_bytes(rd(4).try_into().unwrap()),
        ];
        let original_face = i32::from_le_bytes(rd(4).try_into().unwrap());
        let num_prims = u16::from_le_bytes(rd(2).try_into().unwrap());
        let first_prim = u16::from_le_bytes(rd(2).try_into().unwrap());
        let smoothing_groups = u32::from_le_bytes(rd(4).try_into().unwrap());
        debug_assert_eq!(r, FACE_SIZE);

        out.push(Face {
            plane_num,
            side,
            on_node,
            first_edge,
            num_edges,
            tex_info,
            disp_info,
            surface_fog_volume_id,
            styles,
            light_offset,
            area,
            lightmap_min,
            lightmap_size,
            original_face,
            num_prims,
            first_prim,
            smoothing_groups,
        });
    }
    Ok(out)
}

fn parse_texinfos(bsp: &BspFile) -> Result<Vec<ParsedTexInfo>, BspError> {
    let Some(data) = bsp.lump_data(lumps::TEXINFO, false)? else {
        return Ok(Vec::new());
    };
    const TEXINFO_SIZE: usize = 72; // 4×4×f32 + flags u32 + texDataIndex i32
    if data.len() % TEXINFO_SIZE != 0 {
        return Err(BspError::Entity(format!("TEXINFO lump 大小非法:{}", data.len())));
    }
    let mut out = Vec::with_capacity(data.len() / TEXINFO_SIZE);
    for chunk in data.chunks_exact(TEXINFO_SIZE) {
        let mut r = 0usize;
        let mut rd = |n: usize| -> &[u8] {
            let s = &chunk[r..r + n];
            r += n;
            s
        };
        let mut read_vec4 = || -> [f32; 4] {
            let mut v = [0f32; 4];
            for item in v.iter_mut() {
                *item = f32::from_le_bytes(rd(4).try_into().unwrap());
            }
            v
        };
        let transform_u = read_vec4();
        let transform_v = read_vec4();
        let _lightmap_scale = read_vec4();
        let _lightmap_transform = read_vec4();
        let flags = u32::from_le_bytes(rd(4).try_into().unwrap());
        let tex_data_index = i32::from_le_bytes(rd(4).try_into().unwrap());
        debug_assert_eq!(r, TEXINFO_SIZE);
        out.push(ParsedTexInfo {
            transform_u,
            transform_v,
            flags,
            tex_data_index,
        });
    }
    Ok(out)
}

fn parse_texdatas(bsp: &BspFile) -> Result<Vec<ParsedTexData>, BspError> {
    let Some(data) = bsp.lump_data(lumps::TEXDATA, false)? else {
        return Ok(Vec::new());
    };
    const TEXDATA_SIZE: usize = 32; // reflectivity 12B + nameStringID i32 + w/h/viewW/viewH
    if data.len() % TEXDATA_SIZE != 0 {
        return Err(BspError::Entity(format!("TEXDATA lump 大小非法:{}", data.len())));
    }
    let mut out = Vec::with_capacity(data.len() / TEXDATA_SIZE);
    for chunk in data.chunks_exact(TEXDATA_SIZE) {
        let mut r = 12usize; // 跳过 reflectivity
        let name_string_id = i32::from_le_bytes(chunk[r..r + 4].try_into().unwrap());
        r += 4;
        let width = i32::from_le_bytes(chunk[r..r + 4].try_into().unwrap());
        r += 4;
        let height = i32::from_le_bytes(chunk[r..r + 4].try_into().unwrap());
        r += 4;
        let _view_width = i32::from_le_bytes(chunk[r..r + 4].try_into().unwrap());
        r += 4;
        let _view_height = i32::from_le_bytes(chunk[r..r + 4].try_into().unwrap());
        out.push(ParsedTexData {
            name_string_id,
            width,
            height,
        });
    }
    Ok(out)
}

fn parse_string_table(bsp: &BspFile) -> Result<(Vec<u32>, Vec<u8>), BspError> {
    let table = bsp
        .lump_data(lumps::TEXDATA_STRING_TABLE, false)?
        .unwrap_or_default();
    let data = bsp
        .lump_data(lumps::TEXDATA_STRING_DATA, false)?
        .unwrap_or_default();

    let mut offsets = Vec::with_capacity(table.len() / 4);
    for chunk in table.chunks_exact(4) {
        offsets.push(u32::from_le_bytes(chunk.try_into().unwrap()));
    }
    Ok((offsets, data))
}

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Vertex {
    position: [f32; 3],
}

#[derive(Debug, Clone)]
struct Edge {
    start_index: u16,
    end_index: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_coords_swizzles() {
        assert_eq!(map_coords([1.0, 2.0, 3.0]), [2.0, 3.0, 1.0]);
    }

    #[test]
    fn invisible_flags() {
        assert!(is_invisible(FLAG_SKY));
        assert!(is_invisible(FLAG_NODRAW));
        assert!(is_invisible(FLAG_SKY2D | FLAG_HINT));
        assert!(!is_invisible(0));
        assert!(!is_invisible(1)); // LIGHT only
    }
}
