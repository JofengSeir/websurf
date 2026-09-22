//! Source 引擎 `.phy`（vphysics 碰撞体）解析：字节 → 凸体顶点 + 三角形索引。
//!
//! 上游：`.phy` 与模型同名，由调用方从 PAKFILE 里取出字节（把 `models/.../x.mdl` 的
//! 扩展名换成 `.phy` 再取条目）。下游：`apps/debug` 与 `apps/game` 的 `crates/wasm`
//! 里 `export_model_phy_colliders` 把本模块的凸体拼成碰撞三角形；本模块**只**出数据。
//!
//! 字节布局（全部小端，偏移按代码实际读取的位置）：
//! - 主头 16B：偏移 0 的 `size`（代码要求恒等于 16）、偏移 8 的 `solid_count`；
//! - 每个 solid 一个表面段：SurfaceHeader 16B（偏移 0 的 `size`、偏移 4..8 的 `VPHY`
//!   标识、偏移 10 的 `modelType`）+ CompactSurfaceHeader 64B + ledge 树；
//!   下一段起点 = 本段起点 + `SurfaceHeader.size + 4`；
//! - 表面段之后是文本段：以 `\0` 结束的 `solid{...}` 文本，块内取 `"index"` 与
//!   `"surfaceprop"`。
//!
//! 拒绝条件（任一命中即 `Err`，不产出部分结果）：总长 < 16；`size != 16`；
//! `solid_count` 不在 `1..=64`；`VPHY` 标识不符；`modelType != 0`；任何字段读取越界
//! （统一走 `need`）。
//!
//! 关键口径与坑：
//! - 顶点读出来就是文件里的坐标（IVP 坐标系、**米制** Vector4），本模块只乘 `M_TO_HU`
//!   换成 HU，**不做轴变换、不做根骨骼变换**——两者都由调用方在之后补。
//! - 三角形只保存索引，且做了**索引 remap**：共享顶点缓冲里没被任何三角形引用的顶点
//!   不会进 `PhyConvex::vertices`，所以顶点数可以小于缓冲长度；读取上界是
//!   "出现过的最大 startPointIndex + 1"。
//! - `bone_index != 0` 的凸体**照样返回**，跳不跳过由调用方决定（当前调用方跳过）。
//! - `PhySolid::index` 恒为 0，分组键是函数内的字面量 `0u32`，**不是**文本段里各
//!   `solid{...}` 块自己的 `"index"`；因此返回的 `Vec` 长度至多 1，全部凸体都装进同一个
//!   `PhySolid`。
//! - 最后一个表面段的 `SurfaceHeader.size` 要到下一轮循环开头才会被边界检查，所以当它是
//!   最后一个 solid 时，越界的 `size` 会让文本段的切片直接 panic，而不是返回 `Err`。
//!
//! 外部参照实现：第三方 `TAServers/source-parsers` 的 phyparser——ledge 树遍历与索引
//! remap 的口径参照它；本文件里每个偏移与拒绝条件都以实际读取到的字节为准。
//!
//! 边界：只解析字节。不读 zip、不做物理模拟、不做坐标轴换算。
//!
//! 测试归属：本文件 1 个 `#[test]`（`parse_s2_pillbig_phy`）。

use std::collections::HashMap;

/// 单个凸体（一个 terminal ledge 的产出）。
#[derive(Debug, Clone)]
pub struct PhyConvex {
    /// 相对骨骼的索引（0 = 静态/根骨骼）。本模块只透传，不解释也不做骨骼变换。
    pub bone_index: i32,
    /// 顶点，**HU**（已乘 `M_TO_HU`）。坐标系与文件一致（IVP 系、Z-up 语义未换算）。
    pub vertices: Vec<[f32; 3]>,
    /// 三角形索引，引用 `vertices`（索引已按首次出现顺序重排）。
    pub indices: Vec<[u32; 3]>,
}

/// `.phy` 解析结果的聚合单位。
///
/// 受分组键恒为 0 影响，`parse_phy` 至多产出 1 个 `PhySolid`，其 `convexes` 装的是文件里
/// 全部通过校验的凸体。
#[derive(Debug, Clone)]
pub struct PhySolid {
    /// 凸体列表：装的是文件里全部通过校验的凸体（受`index` 恒为 0 影响，
    /// 一次 `parse_phy` 只会产出这一个 `PhySolid`）。
    pub convexes: Vec<PhyConvex>,
    /// solid 索引，当前实现**恒为 0**（原因见模块头）。
    pub index: u32,
    /// 文本段里的 `"surfaceprop"`（引擎碰撞材质名）。只有带 `"index"` 的块参与；
    /// 块里缺 `"surfaceprop"` 时得到 `Some("")` 而不是 `None`；整段读不到时是 `None`。
    pub surfaceprop: Option<String>,
}

/// `.phy` 解析失败，只带一条中文描述（越界偏移 / 标识不符 / 主头数值非法）。
///
/// 不区分错误类别：调用方按整体 `Err` 处理（当前调用方打一行日志后跳过该模型）。
#[derive(Debug)]
pub struct PhyError(pub String);

impl std::fmt::Display for PhyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for PhyError {}

/// 越界检查：`off + n > b.len()` 时返回带上下文的 `Err`，否则 `Ok(())`。
///
/// 本文件所有字段读取都先过它，所以 `need` 之后的切片索引不会越界。
fn need(b: &[u8], off: usize, n: usize, what: &str) -> Result<(), PhyError> {
    if off + n > b.len() {
        return Err(PhyError(format!(
            "{what}: 越界 off={off} need={n} len={}",
            b.len()
        )));
    }
    Ok(())
}

/// 读偏移 `off` 处的 4 字节小端 `i32`；越界返回 `Err`。
fn i32_at(b: &[u8], off: usize) -> Result<i32, PhyError> {
    need(b, off, 4, "i32")?;
    Ok(i32::from_le_bytes(b[off..off + 4].try_into().unwrap()))
}

/// 读偏移 `off` 处的 4 字节小端 `u32`；越界返回 `Err`。
fn u32_at(b: &[u8], off: usize) -> Result<u32, PhyError> {
    need(b, off, 4, "u32")?;
    Ok(u32::from_le_bytes(b[off..off + 4].try_into().unwrap()))
}

/// 读偏移 `off` 处的 2 字节小端 `u16`；越界返回 `Err`。
fn u16_at(b: &[u8], off: usize) -> Result<u16, PhyError> {
    need(b, off, 2, "u16")?;
    Ok(u16::from_le_bytes(b[off..off + 2].try_into().unwrap()))
}

/// 米 → Source 单位（HU）的换算因子：`1 / 0.0254`（≈ 39.37008 HU/m）。
const M_TO_HU: f32 = 1.0 / 0.0254;

/// 解析 `.phy` 字节，返回全部 solid。
///
/// 流程：主头校验 → 逐个表面段（SurfaceHeader 校验 + `parse_compact_surface`）→
/// 文本段解析块的 `"index"` / `"surfaceprop"` → 按固定键 `0u32` 分组。
///
/// 输出保证：`PhyConvex::vertices` 已乘 `M_TO_HU`；没有三角形或没有顶点的凸体被丢弃；
/// `bone_index != 0` 的凸体**保留**。
///
/// 不做：不按块的 `"index"` 分组（见模块头）；不校验表面段总长是否越过文件尾
/// （最后一个 solid 的 `size` 越界时会在文本段切处 panic，见模块头）。
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
        // SurfaceHeader 的字段只读这三个：偏移 0 的 size、4..8 的 "VPHY" 标识、
        // 偏移 10 的 modelType。多字节字段一律走 `need` 保护的读取函数。
        let sh_size = i32_at(b, offset)?;
        let vid = b
            .get(offset + 4..offset + 8)
            .ok_or_else(|| PhyError("表面头越界".into()))?;
        // CompactSurfaceHeader 紧跟在 SurfaceHeader（16B）之后
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
            // modelType：只有 0 被接受，其余取值一律拒绝（不尝试任何降级解析）
            return Err(PhyError(format!(
                "不支持的 modelType={model_type}（仅支持 0=凸包）"
            )));
        }
        parse_compact_surface(b, offset + 16, &mut solids)?;
        offset += sh_size as usize + 4; // 表面段总长 = sh_size + 4
    }

    // 文本段：从 offset 起直到第一个 `\0`；末尾没有 `\0` 时取到切片末尾
    let text = b[offset..].split(|c| *c == 0).next().unwrap_or(&[]);
    let text = String::from_utf8_lossy(text).into_owned();

    // 逐块取 `"index"` 与 `"surfaceprop"`：按 "solid" 切分，每片只看第一个 `{`..第一个 `}`
    let mut index_map: HashMap<u32, String> = HashMap::new();
    for block in text.split("solid") {
        let Some(open) = block.find('{') else { continue };
        let Some(close) = block.find('}') else { continue };
        let body = &block[open + 1..close];
        let mut idx: Option<u32> = None;
        let mut sprop: Option<String> = None;
        for kv in body.split('"') {
            let _ = kv; // 空循环：取值在下面的逐行扫描里做，这里没有任何副作用
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
        // 只有带 `"index"` 的块入库；块里没有 `"surfaceprop"` 时值是空串
        if let Some(i) = idx {
            index_map.insert(i, sprop.unwrap_or_default());
        }
    }

    // 分组：下面的 key 是字面量 0，因此全部凸体都会并进同一个 PhySolid
    let mut out: Vec<PhySolid> = Vec::new();
    for c in solids {
        let key = 0u32; // 固定键 0：不读文本段各块自己的 "index"
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

/// 解析一个 compact surface：CompactSurfaceHeader(64B) + ledge 树，把每个 terminal ledge
/// 转成一个 `PhyConvex` 推进 `out`。
///
/// `c` = CompactSurfaceHeader 起点（表面段起点 + 16）。根节点偏移读自 `c + 48` 的 `i32`，
/// 根节点 = `c + 16 + 该偏移`。
///
/// 遍历用显式栈：节点上两个 `i32`——偏移 0 是分支节点相对偏移、偏移 4 是"本节点对应的
/// ledge"相对偏移。偏移 0 为 0 即 terminal（ledge 起点 = 节点起点 + 偏移 4），否则把
/// `节点 + 偏移` 与 `节点 + 28`（相邻节点步长）两支入栈。凸体在 `out` 里的先后由这个
/// 遍历顺序决定。
///
/// 错误：一处越界即整体 `Err`（不跳过单个凸体）；但"顶点或三角形为空"的 ledge 只被跳过，
/// 不算错误。
fn parse_compact_surface(b: &[u8], c: usize, out: &mut Vec<PhyConvex>) -> Result<(), PhyError> {
    need(b, c + 64, 0, "CompactSurfaceHeader")?;
    // 根节点偏移在 c+48，相对 c+16 计（故下面 root_node 要再加 16）
    let ledge_root = i32_at(b, c + 48)?;
    let root_node = c + 16 + ledge_root as usize;

    let mut stack: Vec<usize> = vec![root_node];
    while let Some(node) = stack.pop() {
        let right_node_offset = i32_at(b, node)?;
        let compact_node_offset = i32_at(b, node + 4)?;
        if right_node_offset == 0 {
            // terminal：ledge 起点 = 节点起点 + 偏移 4 处的 i32。
            // 代码只读它的偏移 0（顶点缓冲的相对偏移）、偏移 4（boneIndex）与偏移 12 的
            // u16（三角形数）
            let ledge = (node as i64 + compact_node_offset as i64) as usize;
            let point_offset = i32_at(b, ledge)?;
            let bone_index = i32_at(b, ledge + 4)?;
            let tri_count = u16_at(b, ledge + 12)? as usize;

            // 第一遍：三角形记录 16B/条（4B 头 + 3×4B Edge），Edge 低 16 位是共享顶点缓冲里
            // 的起点索引；这里做索引 remap——只输出真正被三角形引用的顶点，
            // 新索引按首次出现顺序分配
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

            // 第二遍：共享顶点缓冲在 `ledge + pointOffset`，每点 16B（x, y, z 各 4B），
            // 读 `最大索引 + 1` 个；坐标当场乘 M_TO_HU 换 HU，只保留被引用的那些
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
            // 非 terminal：一支在 `节点 + 偏移`，另一支固定在 `节点 + 28`（相邻节点步长）
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

    /// 端到端夹具：从 `test/maps/surf_666.bsp` 的 PAKFILE 里取
    /// `models/props/666/s2_pillbig.phy` 解析，钉住 3 个凸体 × 12 三角形 = 36 个三角形、
    /// 3 × 8 = 24 个顶点、bone 全 0、surfaceprop 为 `no_decal`，以及米 → HU 缩放后的 x 区间。
    ///
    /// 夹具文件不存在时**直接返回**（跳过），不算失败。
    #[test]
    fn parse_s2_pillbig_phy() {
        // 夹具路径相对本 crate 目录（src/wasm-core）
        let bsp = std::fs::read("../../test/maps/surf_666.bsp").ok();
        let Some(bsp) = bsp else {
            eprintln!("跳过：test/maps/surf_666.bsp 不存在");
            return;
        };
        // 目录项基址 = 8B 文件头（magic + version）+ 40 × 16B 目录项
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
        // 3 个凸体 × 12 个三角形
        let total_tris: usize = solids.iter().map(|s| s.convexes.iter().map(|c| c.indices.len()).sum::<usize>()).sum();
        assert_eq!(total_tris, 36, "3×12 三角");
        let total_verts: usize = solids.iter().map(|s| s.convexes.iter().map(|c| c.vertices.len()).sum::<usize>()).sum();
        assert_eq!(total_verts, 24, "3×8 顶点");
        // 静态模型：全部凸体的 bone_index 都为 0
        for s in &solids {
            for c in &s.convexes {
                assert_eq!(c.bone_index, 0);
            }
        }
        // 文本段的 `"surfaceprop"` 落到第 0 个 solid
        assert_eq!(solids[0].surfaceprop.as_deref(), Some("no_decal"));
        // 米 → HU 缩放已生效：x 最小值落在 (-460, -400)，最大值逼近 0
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
