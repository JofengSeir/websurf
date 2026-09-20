//! `prop_static` 的**逐顶点预烘焙光照**（`.vhv`）解析。
//!
//! ## 为什么必须有这一层
//!
//! Source 里 `prop_static` 的静态光照有**两级**来源（外部参照实现两个都实现了）：
//!
//! | 级 | 来源 | 参照实现 |
//! |---|---|---|
//! | 1 | **逐顶点烘焙**：VRAD 把每个 prop 的顶点光照写进 pakfile 的 `sp_<idx>.vhv` / `sp_hdr_<idx>.vhv` | `外部参照实现.WebExport/Bsp/Geometry.cs:855-895` + `外部参照实现/ValveVertexLightingFile.cs` |
//! | 2 | leaf ambient cube（无 vhv 或置了 `StaticPropFlags.NoPerVertexLighting` 时的兜底） | `Resources/src/Entities/StaticProp.ts:39` |
//!
//! 只做第 2 级会丢掉**逐顶点梯度**：cube 是"每 prop 一个值"（按法线平方加权取面），
//! 于是模型的每个朝向面各得一个**平坦**颜色 —— 实机观感正是「一面一个颜色、像没有光照」。
//!
//! ## 文件格式（`ValveVertexLightingFile`，版本 2）
//!
//! ```text
//! u8   version_low  ┐ version_low == 0 时：后 3 字节缺失，base = -3（老工具产物）
//! u8, u16           ┘ 否则 3 字节组成 u32 版本号
//! i32  checksum
//! u32  vert_flags        2 = 每顶点 3 组 RGBA（取均值）；否则 1 组 RGBA
//! u32  vert_size
//! u32  vert_count
//! i32  mesh_count
//! i64, i64                未使用
//! VhvMeshHeader[mesh_count]   { i32 lod, i32 vert_count, i32 vert_offset, i32 u0..u3 }  ← 从偏移 40 开始
//! 各 mesh 的顶点数据在 vert_offset（+ base）
//! ```
//!
//! ## 数值口径（与引擎 `VertexLitGeneric` 对齐）
//!
//! 顶点色字节 `v` 是"整数部分=光照、小数部分=albedo 调制"的打包形式（本文件的字节是整数，
//! 小数部分为 0 ⇒ 调制 = 1）。引擎取 `vVertexLighting = floor(v) * (2.0/255.0)`，
//! 屏幕颜色 = `纹理色 × vVertexLighting`（外部参照实现 `Shaders/VertexLitGeneric.ts`）。
//! 本模块直接产出**屏幕倍率** `v * 2/255`（每顶点 RGB，[0, 2]）。

/// 解析结果：逐顶点屏幕倍率（RGB，值域 [0, 2]，按 mesh 顺序拼接 = 模型顶点顺序）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PropVertexLighting {
    /// `vert_count` 个顶点的 RGB 倍率（mesh 顺序拼接；与模型顶点表同序）。
    pub colors: Vec<[f32; 3]>,
    /// 每个 mesh 的顶点数（诊断用；累加应等于 `colors.len()`）。
    pub mesh_vert_counts: Vec<u32>,
}

impl PropVertexLighting {
    /// 逐顶点亮度（0.299/0.587/0.114 加权），诊断/日志用。
    pub fn luma_stats(&self) -> Option<(f32, f32)> {
        if self.colors.is_empty() {
            return None;
        }
        let mut v: Vec<f32> = self
            .colors
            .iter()
            .map(|c| 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2])
            .collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        Some((v[v.len() / 2], v[v.len() - 1]))
    }
}

fn read_i32(b: &[u8], off: usize) -> Option<i32> {
    b.get(off..off + 4).map(|s| i32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn read_u32(b: &[u8], off: usize) -> Option<u32> {
    b.get(off..off + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// 解析 `.vhv`。任何结构不符（版本≠2、越界、顶点数为 0）都返回 `None`
/// —— 调用方据此回退到 leaf ambient cube，**不静默产出错数据**。
pub fn parse_vhv(bytes: &[u8]) -> Option<PropVertexLighting> {
    if bytes.is_empty() {
        return None;
    }
    // 版本：首字节为 0 表示老工具产物少了 3 字节（其后字段整体前移 3）
    let base: i64 = if bytes[0] == 0 { -3 } else { 0 };
    let version = if bytes[0] == 0 {
        2u32
    } else {
        let b1 = *bytes.get(1)? as u32;
        let b2 = u16::from_le_bytes([*bytes.get(2)?, *bytes.get(3)?]) as u32;
        (bytes[0] as u32) | (b1 << 8) | (b2 << 16)
    };
    if version != 2 {
        return None;
    }
    let off = |rel: usize| -> Option<usize> {
        let o = rel as i64 + base;
        if o < 0 {
            None
        } else {
            Some(o as usize)
        }
    };
    let vert_flags = read_u32(bytes, off(8)?)?;
    let vert_count = read_u32(bytes, off(16)?)?;
    let mesh_count = read_i32(bytes, off(20)?)?;
    if mesh_count <= 0 || mesh_count > 4096 || vert_count == 0 || vert_count > 4_000_000 {
        return None;
    }

    let hdr_base = off(40)?;
    let mut meshes = Vec::with_capacity(mesh_count as usize);
    for k in 0..mesh_count as usize {
        let p = hdr_base + k * 28;
        let vc = read_i32(bytes, p + 4)?;
        let vo = read_i32(bytes, p + 8)?;
        if vc < 0 || vo < 0 {
            return None;
        }
        meshes.push((vc as u32, vo as usize));
    }

    // vert_flags == 2 → 每顶点 3 组 RGBA（取均值）；否则 1 组
    let rec = if vert_flags == 2 { 12usize } else { 4usize };
    let mut colors: Vec<[f32; 3]> = Vec::with_capacity(vert_count as usize);
    let mut mesh_vert_counts = Vec::with_capacity(meshes.len());
    for (vc, vo) in &meshes {
        mesh_vert_counts.push(*vc);
        // 顶点数据偏移：mesh 头里是**文件内绝对偏移**，老工具产物（base = -3）整体前移 3
        let data_off = (*vo as i64 + base).max(0) as usize;
        for i in 0..*vc as usize {
            let o = data_off + i * rec;
            let s = bytes.get(o..o + rec)?;
            let (r, g, b) = if rec == 4 {
                (s[2], s[1], s[0]) // B,G,R,A 顺序
            } else {
                let avg = |idx: usize| -> u8 {
                    let c = |k: usize| s[k * 4 + idx] as u32;
                    ((c(0) + c(1) + c(2)) / 3) as u8
                };
                (avg(2), avg(1), avg(0))
            };
            // 引擎口径：vVertexLighting = byte * (2.0 / 255.0)
            const K: f32 = 2.0 / 255.0;
            colors.push([r as f32 * K, g as f32 * K, b as f32 * K]);
        }
    }
    if colors.is_empty() {
        return None;
    }
    Some(PropVertexLighting {
        colors,
        mesh_vert_counts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小可解析文件：version=2、1 个 mesh、3 个顶点（B,G,R,A）
    fn sample() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&2u32.to_le_bytes()); // version
        v.extend_from_slice(&0i32.to_le_bytes()); // checksum
        v.extend_from_slice(&4u32.to_le_bytes()); // vert_flags（1 组 RGBA）
        v.extend_from_slice(&4u32.to_le_bytes()); // vert_size
        v.extend_from_slice(&3u32.to_le_bytes()); // vert_count
        v.extend_from_slice(&1i32.to_le_bytes()); // mesh_count
        v.extend_from_slice(&[0u8; 16]); // unused0/1 → 头到 40
                                         // mesh 头：lod=0, vert_count=3, vert_offset=68（紧随其后）
        v.extend_from_slice(&0i32.to_le_bytes());
        v.extend_from_slice(&3i32.to_le_bytes());
        v.extend_from_slice(&68i32.to_le_bytes());
        v.extend_from_slice(&[0u8; 16]);
        assert_eq!(v.len(), 68);
        // 顶点：B,G,R,A（R 是第三字节）
        v.extend_from_slice(&[0, 0, 128, 255]); // R=128 → 倍率 128*2/255
        v.extend_from_slice(&[0, 0, 0, 255]);
        v.extend_from_slice(&[0, 0, 255, 255]);
        v
    }

    #[test]
    fn parses_minimal_file_with_engine_scale() {
        let p = parse_vhv(&sample()).expect("应能解析");
        assert_eq!(p.colors.len(), 3);
        assert_eq!(p.mesh_vert_counts, vec![3]);
        assert!((p.colors[0][0] - 128.0 * 2.0 / 255.0).abs() < 1e-6);
        assert!((p.colors[2][0] - 255.0 * 2.0 / 255.0).abs() < 1e-6);
    }

    /// 反面对照：版本不符必须拒绝（不得静默产出错数据）
    #[test]
    fn rejects_bad_version() {
        let mut b = sample();
        b[0] = 3;
        assert!(parse_vhv(&b).is_none());
    }

    /// 反面对照：顶点数据越界必须拒绝
    #[test]
    fn rejects_truncated_vertex_data() {
        let mut b = sample();
        b.truncate(80);
        assert!(parse_vhv(&b).is_none());
    }

    /// 反面对照：mesh_count 荒谬值必须拒绝
    #[test]
    fn rejects_absurd_mesh_count() {
        let mut b = sample();
        b[20..24].copy_from_slice(&(-5i32).to_le_bytes());
        assert!(parse_vhv(&b).is_none());
    }
}
