//! Source 引擎 `.phy`（vphysics 碰撞体）解析。
//!
//! 依据：
//! - Valve Developer Community 官方 PHY 格式文档（主头 / 表面头 / 凸体 / 顶点 / 三角 / 文本段）；
//! - TAServers/source-parsers 的 phyparser（triangledata_t 位域布局、ledge tree 遍历、索引 remap
//!   等官方文档未覆盖的部分，实测与 s2_pillbig.phy / cow.phy 逐字节验证一致）。
//!
//! 布局速览（全部小端）：
//! - 主头 16B：`size=16, id, solidCount, checkSum`
//! - 每 solid 一个表面段：SurfaceHeader(16B) + CompactSurfaceHeader(64B) + ledge tree；
//!   表面段总长 = `SurfaceHeader.size + 4`（size 含本头之后内容）
//! - 表面段之后是文本段（single string，无 size 头）：`solid{index, surfaceprop, …}` 关联
//!
//! 顶点为 **模型局部/骨骼空间、米制**：×39.3701 转 HU；`bone_index != 0` 的凸体
//! 需要骨骼变换矩阵，首版仅支持静态模型（bone 0，surf 图 prop_static 主场景）。

use std::collections::HashMap;

/// 单个凸体（一个 Ledge）。
#[derive(Debug, Clone)]
pub struct PhyConvex {
    /// 相对骨骼的索引（0 = 静态/根骨骼）。
    pub bone_index: i32,
    /// 世界空间顶点（**HU**，模型局部空间，未做 Z-up→Y-up 映射）。
    pub vertices: Vec<[f32; 3]>,
    /// 三角形索引（引用 `vertices`）。
    pub indices: Vec<[u32; 3]>,
}

/// 单个 `.phy` 的解析结果。
#[derive(Debug, Clone)]
pub struct PhySolid {
    /// 凸体列表（一个表面可能含多个凸体）。
    pub convexes: Vec<PhyConvex>,
    /// 文本段 `solid{index}` 关联的索引。
    pub index: u32,
    /// 文本段 `solid{surfaceprop}`（引擎碰撞材质，如 `no_decal` / `flesh`）。
    pub surfaceprop: Option<String>,
}

#[derive(Debug)]
pub struct PhyError(pub String);

impl std::fmt::Display for PhyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for PhyError {}

fn need(b: &[u8], off: usize, n: usize, what: &str) -> Result<(), PhyError> {
    if off + n > b.len() {
        return Err(PhyError(format!(
            "{what}: 越界 off={off} need={n} len={}",
            b.len()
        )));
    }
    Ok(())
}

fn i32_at(b: &[u8], off: usize) -> Result<i32, PhyError> {
    need(b, off, 4, "i32")?;
    Ok(i32::from_le_bytes(b[off..off + 4].try_into().unwrap()))
}

fn u32_at(b: &[u8], off: usize) -> Result<u32, PhyError> {
    need(b, off, 4, "u32")?;
    Ok(u32::from_le_bytes(b[off..off + 4].try_into().unwrap()))
}

fn u16_at(b: &[u8], off: usize) -> Result<u16, PhyError> {
    need(b, off, 2, "u16")?;
    Ok(u16::from_le_bytes(b[off..off + 2].try_into().unwrap()))
}

/// 米 → Source 单位（HU）：`v / 0.0254`。
const M_TO_HU: f32 = 1.0 / 0.0254;

/// 解析 `.phy` 字节，返回全部 solid（含文本段 surfaceprop 关联）。
pub fn parse_phy(b: &[u8]) -> Result<Vec<PhySolid>, PhyError> {
    if b.len() < 16 {
        return Err(PhyError("文件过短".into()));
    }
    let size = i32_at(b, 0)?;
    let solid_count = i32_at(b, 8)?;
    if size != 16 || solid_count <= 0 || solid_count > 64 {
        return Err(PhyError(format!(
            "非法主头 size={size} solidCount={solid_count}"
        )));
    }

    let mut solids: Vec<PhyConvex> = Vec::new();
    let mut offset = size as usize;
    for _ in 0..solid_count {
        // SurfaceHeader(16B)：size, vphysicsId("VPHY"), version, modelType, surfaceSize
        let sh_size = i32_at(b, offset)?;
        let vid = b
            .get(offset + 4..offset + 8)
            .ok_or_else(|| PhyError("表面头越界".into()))?;
        // SurfaceHeader: size(4) vphysicsId(4) version(2) modelType(2) surfaceSize(4)
        let model_type = i16::from_le_bytes(
            b.get(offset + 10..offset + 12)
                .ok_or_else(|| PhyError("表面头越界".into()))?
                .try_into()
                .unwrap(),
        );
        if vid != b"VPHY" {
            return Err(PhyError(format!(
                "不支持的表面标识 {:?}（非 VPHY 新格式）",
                String::from_utf8_lossy(vid)
            )));
        }
        if model_type != 0 {
            // 0 = IVPCompactSurface（凸包）；1=MOPP/2=Ball/3=Virtual 暂不支持
            return Err(PhyError(format!(
                "不支持的 modelType={model_type}（仅支持 0=凸包）"
            )));
        }
        parse_compact_surface(b, offset + 16, &mut solids)?;
        offset += sh_size as usize + 4; // size 含本头之后内容
    }

    // 文本段（single string，末尾 '\0' 结束）
    let text = b[offset..].split(|c| *c == 0).next().unwrap_or(&[]);
    let text = String::from_utf8_lossy(text).into_owned();

    // 解析 solid{...} 块：index + surfaceprop
    let mut index_map: HashMap<u32, String> = HashMap::new();
    for block in text.split("solid") {
        let Some(open) = block.find('{') else { continue };
        let Some(close) = block.find('}') else { continue };
        let body = &block[open + 1..close];
        let mut idx: Option<u32> = None;
        let mut sprop: Option<String> = None;
        for kv in body.split('"') {
            let _ = kv; // 用正则式太笨重，直接逐 key-value 找
        }
        for line in body.lines() {
            let t = line.trim();
            if let Some(v) = t.strip_prefix("\"index\"") {
                if let Some(q) = v.find('"') {
                    if let Some(r) = v[q + 1..].find('"') {
                        idx = v[q + 1..q + 1 + r].trim().parse().ok();
                    }
                }
            } else if let Some(v) = t.strip_prefix("\"surfaceprop\"") {
                if let Some(q) = v.find('"') {
                    if let Some(r) = v[q + 1..].find('"') {
                        sprop = Some(v[q + 1..q + 1 + r].to_string());
                    }
                }
            }
        }
        if let Some(i) = idx {
            index_map.insert(i, sprop.unwrap_or_default());
        }
    }

    // 把凸体按 index 分组为 PhySolid
    let mut out: Vec<PhySolid> = Vec::new();
    for c in solids {
        let key = 0u32; // 文本段 index 默认 0；多凸体共享同一 solid 块
        let sprop = index_map.get(&key).cloned();
        if let Some(s) = out.iter_mut().find(|s| s.index == key) {
            s.convexes.push(c);
            if s.surfaceprop.is_none() {
                s.surfaceprop = sprop;
            }
        } else {
            out.push(PhySolid {
                convexes: vec![c],
                index: key,
                surfaceprop: sprop,
            });
        }
    }
    Ok(out)
}

/// 解析一个 IVPCompactSurface：CompactSurfaceHeader(64B) + ledge tree。
/// `c` = CompactSurfaceHeader 起点（紧跟 SurfaceHeader 之后）。
fn parse_compact_surface(b: &[u8], c: usize, out: &mut Vec<PhyConvex>) -> Result<(), PhyError> {
    need(b, c + 64, 0, "CompactSurfaceHeader")?;
    // offsetof(massCentre) = 16（dragAxisAreas 12 + axisMapSize 4）
    let ledge_root = i32_at(b, c + 48)?;
    let root_node = c + 16 + ledge_root as usize;

    let mut stack: Vec<usize> = vec![root_node];
    while let Some(node) = stack.pop() {
        let right_node_offset = i32_at(b, node)?;
        let compact_node_offset = i32_at(b, node + 4)?;
        if right_node_offset == 0 {
            // terminal → Ledge（16B）：pointOffset, boneIndex, unused, trianglesCount(u16), unknown
            let ledge = (node as i64 + compact_node_offset as i64) as usize;
            let point_offset = i32_at(b, ledge)?;
            let bone_index = i32_at(b, ledge + 4)?;
            let tri_count = u16_at(b, ledge + 12)? as usize;

            // 第一遍：读三角形索引（CompactTriangle 16B：data + 3×Edge，Edge 低 16 位是 startPointIndex）
            // 做索引 remap（共享顶点缓冲可能含未被引用的点，只输出实际用到的顶点）
            let mut remap: HashMap<u16, u16> = HashMap::new();
            let mut indices: Vec<[u32; 3]> = Vec::with_capacity(tri_count);
            let mut max_vi = 0usize;
            for t in 0..tri_count {
                let tbase = ledge + 16 + t * 16;
                need(b, tbase + 16, 0, "CompactTriangle")?;
                let mut tri = [0u32; 3];
                for e in 0..3 {
                    let ed = u32_at(b, tbase + 4 + e * 4)?;
                    let sp = (ed & 0xFFFF) as u16;
                    max_vi = max_vi.max(sp as usize);
                    let next = remap.len() as u16;
                    let idx = *remap.entry(sp).or_insert(next);
                    tri[e] = idx as u32;
                }
                indices.push(tri);
            }

            // 第二遍：共享顶点缓冲 Vector4(16B) × (max_vi+1)，位于 ledge + pointOffset；
            // 只保留被索引引用的顶点
            let vbase = (ledge as i64 + point_offset as i64) as usize;
            let mut shared: Vec<[f32; 3]> = Vec::with_capacity(max_vi + 1);
            for v in 0..=max_vi {
                need(b, vbase + v * 16, 16, "phyvertex")?;
                let x = f32::from_le_bytes(b[vbase + v * 16..vbase + v * 16 + 4].try_into().unwrap());
                let y = f32::from_le_bytes(b[vbase + v * 16 + 4..vbase + v * 16 + 8].try_into().unwrap());
                let z = f32::from_le_bytes(b[vbase + v * 16 + 8..vbase + v * 16 + 12].try_into().unwrap());
                shared.push([x * M_TO_HU, y * M_TO_HU, z * M_TO_HU]);
            }
            let mut vertices: Vec<[f32; 3]> = vec![[0.0; 3]; remap.len()];
            for (src, dst) in &remap {
                vertices[*dst as usize] = shared[*src as usize];
            }
            if vertices.is_empty() || indices.is_empty() {
                continue;
            }
            out.push(PhyConvex {
                bone_index,
                vertices,
                indices,
            });
        } else {
            // 非 terminal：右子节点 + 左子节点（相邻 28B）
            stack.push((node as i64 + right_node_offset as i64) as usize);
            stack.push(node + 28); // sizeof(LedgeNode)
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn parse_s2_pillbig_phy() {
        // 从 surf_666.bsp 提取（与 probe 相同的路径约定）
        let bsp = std::fs::read("../../maps/surf_666.bsp").ok();
        let Some(bsp) = bsp else {
            eprintln!("跳过：maps/surf_666.bsp 不存在");
            return;
        };
        // LUMP_PAKFILE = 40
        let base = 8 + 40 * 16;
        let off = u32::from_le_bytes(bsp[base..base + 4].try_into().unwrap()) as usize;
        let len = u32::from_le_bytes(bsp[base + 4..base + 8].try_into().unwrap()) as usize;
        let pak = &bsp[off..off + len];
        let mut zf = zip::ZipArchive::new(std::io::Cursor::new(pak)).unwrap();
        let mut phy = Vec::new();
        zf.by_name("models/props/666/s2_pillbig.phy")
            .unwrap()
            .read_to_end(&mut phy)
            .unwrap();

        let solids = parse_phy(&phy).expect("parse");
        // 3 个 box 凸体（pillbig = 柱形底座）
        let total_tris: usize = solids.iter().map(|s| s.convexes.iter().map(|c| c.indices.len()).sum::<usize>()).sum();
        assert_eq!(total_tris, 36, "3×12 三角");
        let total_verts: usize = solids.iter().map(|s| s.convexes.iter().map(|c| c.vertices.len()).sum::<usize>()).sum();
        assert_eq!(total_verts, 24, "3×8 顶点");
        // 静态模型：bone 全 0
        for s in &solids {
            for c in &s.convexes {
                assert_eq!(c.bone_index, 0);
            }
        }
        // surfaceprop 关联
        assert_eq!(solids[0].surfaceprop.as_deref(), Some("no_decal"));
        // 米制 → HU：x 方向应覆盖约 -224..0
        let all_x: Vec<f32> = solids
            .iter()
            .flat_map(|s| s.convexes.iter())
            .flat_map(|c| c.vertices.iter())
            .map(|v| v[0])
            .collect();
        let (min_x, max_x) = (
            all_x.iter().cloned().fold(f32::INFINITY, f32::min),
            all_x.iter().cloned().fold(f32::NEG_INFINITY, f32::max),
        );
        assert!(min_x > -460.0 && min_x < -400.0, "min_x={min_x}");
        assert!(max_x.abs() < 1.0, "max_x={max_x}");
    }
}
