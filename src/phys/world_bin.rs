//! WSBW v1：物理碰撞世界的二进制传输格式（Rust 单源编解码）。
//!
//! 本模块是 **唯一** 的格式定义与编解码实现：wasm 侧（`src/wasm-bindings`）只调用
//! `encode_brushes` / `encode_tri_meshes` 写字节，物理侧 `PhysWorld::build_world_binary`
//! 只调用 `decode_brushes` / `decode_tri_meshes` 读字节；TS 只搬 `Uint8Array`，不解析格式。
//!
//! # 布局（全部小端）
//!
//! 两个独立 buffer 共用同一个 16 字节头：
//!
//! ```text
//! magic[4] = "WSBW" | version u32 = 1 | brush_count u32 | tri_mesh_count u32
//! ```
//!
//! brush buffer：`brush_count` 条，`tri_mesh_count` 恒为 0；每条：
//!
//! ```text
//! entity i32 | flags u8 | padding[3] | min f32x3 | max f32x3 | plane_count u32
//! planes: (normal f32x3 | dist f32) x plane_count
//! ```
//!
//! flags：bit0 = is_solid，bit1 = is_ladder，bit2 = start_solid；bit3..7 必须为 0。
//!
//! tri buffer：`tri_mesh_count` 条，`brush_count` 恒为 0；每条：
//!
//! ```text
//! name_len u32 | name[UTF-8] | min f32x3 | max f32x3
//! | vertex_count u32 | index_count u32
//! | vertices: (x f32, y f32, z f32) x vertex_count
//! | indices:  (a u32, b u32, c u32) x index_count
//! ```
//!
//! 解码是严格的：magic / 版本 / 两个 count 的归属 / 长度 / UTF-8 / 索引范围 / 尾随字节
//! 任一不合法都返回 `WorldBinError`，绝不 panic，也不做部分写入。
//!
//! # 精度
//!
//! 生产侧（wasm 导出）的 brush 与 tri 坐标本来都是 f32；JSON 路径经 `serde` 的 f32
//! 反序列化后转 f64，与二进制路径逐位一致（见 `mod.rs` 的 `parse_brushes` /
//! `parse_tri_meshes`）。因此二进制 World 与 JSON World 在 f64 层也逐位相同。

use crate::phys::world::{TriMesh, V3};
use crate::phys::{PhysBrush, PhysPlane};

/// 文件魔数。
pub const MAGIC: [u8; 4] = *b"WSBW";
/// 当前格式版本。
pub const VERSION: u32 = 1;
/// 头长度。
pub const HEADER_LEN: usize = 16;
/// 单条 brush 的定长部分（entity + flags/padding + min + max + plane_count）。
const BRUSH_FIXED: usize = 4 + 4 + 12 + 12 + 4;
/// 单个平面字节数。
const PLANE_LEN: usize = 16;
/// 单个顶点字节数。
const VERTEX_LEN: usize = 12;
/// 单个三角形索引字节数。
const INDEX_LEN: usize = 12;

/// 编解码错误。文案直接进 wasm 边界错误串，便于在浏览器控制台定位。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorldBinError {
    /// 头都不够 16 字节。
    TooShort { got: usize },
    /// magic 不是 `WSBW`。
    BadMagic { got: [u8; 4] },
    /// 版本不支持。
    UnsupportedVersion { got: u32 },
    /// 头部计数字段与 buffer 类型不符（brush buffer 的 tri 计数必须为 0，反之亦然）。
    UnexpectedCount { brushes: u32, tri_meshes: u32 },
    /// 读某个字段时越过 buffer 末尾。
    Truncated { at: usize, need: usize, len: usize },
    /// 偏移量加法溢出（理论输入）。
    SizeOverflow,
    /// 名字不是合法 UTF-8。
    InvalidUtf8,
    /// 索引指向不存在的顶点。
    IndexOutOfBounds { index: u32, vertices: u32 },
    /// flags 出现未定义位。
    InvalidFlags { flags: u8 },
    /// 合法记录读完后还有多余字节。
    TrailingBytes { at: usize, len: usize },
    /// 计数超过 u32 可表示范围（编码侧）。
    TooMany { what: &'static str, count: usize },
}

impl std::fmt::Display for WorldBinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooShort { got } => write!(f, "WSBW 头不完整：{got} < {HEADER_LEN} 字节"),
            Self::BadMagic { got } => write!(f, "WSBW magic 不匹配：{got:?}"),
            Self::UnsupportedVersion { got } => write!(f, "WSBW 版本不支持：{got}（当前 {VERSION}）"),
            Self::UnexpectedCount { brushes, tri_meshes } => write!(
                f,
                "WSBW 计数与 buffer 类型不符：brush_count={brushes} tri_mesh_count={tri_meshes}"
            ),
            Self::Truncated { at, need, len } => {
                write!(f, "WSBW 数据越界：位置 {at} 需要 {need} 字节，但总长只有 {len}")
            }
            Self::SizeOverflow => write!(f, "WSBW 偏移量溢出"),
            Self::InvalidUtf8 => write!(f, "WSBW 模型名不是合法 UTF-8"),
            Self::IndexOutOfBounds { index, vertices } => {
                write!(f, "WSBW 三角形索引越界：index={index} vertex_count={vertices}")
            }
            Self::InvalidFlags { flags } => write!(f, "WSBW flags 含未定义位：0b{flags:08b}"),
            Self::TrailingBytes { at, len } => {
                write!(f, "WSBW 记录结束后仍有 {len} 字节（从 {at} 起）")
            }
            Self::TooMany { what, count } => write!(f, "WSBW {what} 数量 {count} 超过 u32"),
        }
    }
}

impl std::error::Error for WorldBinError {}

/// 编码 brush 列表为 **brush buffer**（头里的 `tri_mesh_count` 写 0）。
pub fn encode_brushes(brushes: &[PhysBrush]) -> Result<Vec<u8>, WorldBinError> {
    let count = u32::try_from(brushes.len()).map_err(|_| WorldBinError::TooMany {
        what: "brush",
        count: brushes.len(),
    })?;
    let mut out = Vec::with_capacity(HEADER_LEN + brushes.len() * BRUSH_FIXED);
    push_header(&mut out, count, 0);
    for b in brushes {
        out.extend_from_slice(&b.entity.to_le_bytes());
        let mut flags = 0u8;
        if b.is_solid {
            flags |= 1 << 0;
        }
        if b.is_ladder {
            flags |= 1 << 1;
        }
        if b.start_solid {
            flags |= 1 << 2;
        }
        out.push(flags);
        out.extend_from_slice(&[0, 0, 0]);
        push_f32x3(&mut out, b.min);
        push_f32x3(&mut out, b.max);
        let plane_count = u32::try_from(b.planes.len()).map_err(|_| WorldBinError::TooMany {
            what: "brush plane",
            count: b.planes.len(),
        })?;
        out.extend_from_slice(&plane_count.to_le_bytes());
        for p in &b.planes {
            push_f32x3(&mut out, p.normal);
            out.extend_from_slice(&p.dist.to_le_bytes());
        }
    }
    Ok(out)
}

/// 解码 **brush buffer**。
pub fn decode_brushes(bytes: &[u8]) -> Result<Vec<PhysBrush>, WorldBinError> {
    let mut r = Reader::new(bytes);
    let (brush_count, tri_count) = read_header(&mut r)?;
    if tri_count != 0 {
        return Err(WorldBinError::UnexpectedCount {
            brushes: brush_count,
            tri_meshes: tri_count,
        });
    }
    // 先按「每条 brush 至少 BRUSH_FIXED 字节」校验计数，避免伪造的巨大 count 触发大分配。
    if brush_count as usize > r.remaining() / BRUSH_FIXED {
        return Err(WorldBinError::Truncated {
            at: r.pos,
            need: brush_count as usize * BRUSH_FIXED,
            len: bytes.len(),
        });
    }
    let mut out = Vec::with_capacity(brush_count as usize);
    for _ in 0..brush_count {
        let entity = i32::from_le_bytes(r.take_array::<4>()?);
        let flags = r.take_u8()?;
        if flags & !0b111 != 0 {
            return Err(WorldBinError::InvalidFlags { flags });
        }
        r.skip(3)?;
        let min = r.take_f32x3()?;
        let max = r.take_f32x3()?;
        let plane_count = r.take_u32()?;
        if plane_count as usize > r.remaining() / PLANE_LEN {
            return Err(WorldBinError::Truncated {
                at: r.pos,
                need: plane_count as usize * PLANE_LEN,
                len: bytes.len(),
            });
        }
        let mut planes = Vec::with_capacity(plane_count as usize);
        for _ in 0..plane_count {
            planes.push(PhysPlane {
                normal: r.take_f32x3()?,
                dist: r.take_f32()?,
            });
        }
        out.push(PhysBrush {
            planes,
            min,
            max,
            is_ladder: flags & (1 << 1) != 0,
            is_solid: flags & (1 << 0) != 0,
            entity,
            start_solid: flags & (1 << 2) != 0,
        });
    }
    r.finish()?;
    Ok(out)
}

/// 编码三角形碰撞网格列表为 **tri buffer**（头里的 `brush_count` 写 0）。
pub fn encode_tri_meshes(meshes: &[TriMesh]) -> Result<Vec<u8>, WorldBinError> {
    let count = u32::try_from(meshes.len()).map_err(|_| WorldBinError::TooMany {
        what: "tri mesh",
        count: meshes.len(),
    })?;
    let mut out = Vec::with_capacity(HEADER_LEN + meshes.len() * 32);
    push_header(&mut out, 0, count);
    for m in meshes {
        let name_len = u32::try_from(m.name.len()).map_err(|_| WorldBinError::TooMany {
            what: "tri mesh name 字节",
            count: m.name.len(),
        })?;
        out.extend_from_slice(&name_len.to_le_bytes());
        out.extend_from_slice(m.name.as_bytes());
        push_f32x3(&mut out, f64x3_to_f32(m.min));
        push_f32x3(&mut out, f64x3_to_f32(m.max));
        let vertex_count = u32::try_from(m.vertices.len()).map_err(|_| WorldBinError::TooMany {
            what: "tri vertex",
            count: m.vertices.len(),
        })?;
        let index_count = u32::try_from(m.indices.len()).map_err(|_| WorldBinError::TooMany {
            what: "tri index",
            count: m.indices.len(),
        })?;
        out.extend_from_slice(&vertex_count.to_le_bytes());
        out.extend_from_slice(&index_count.to_le_bytes());
        for v in &m.vertices {
            push_f32x3(&mut out, f64x3_to_f32(*v));
        }
        for idx in &m.indices {
            out.extend_from_slice(&idx[0].to_le_bytes());
            out.extend_from_slice(&idx[1].to_le_bytes());
            out.extend_from_slice(&idx[2].to_le_bytes());
        }
    }
    Ok(out)
}

/// 解码 **tri buffer**。
pub fn decode_tri_meshes(bytes: &[u8]) -> Result<Vec<TriMesh>, WorldBinError> {
    let mut r = Reader::new(bytes);
    let (brush_count, tri_count) = read_header(&mut r)?;
    if brush_count != 0 {
        return Err(WorldBinError::UnexpectedCount {
            brushes: brush_count,
            tri_meshes: tri_count,
        });
    }
    // 每条最少：name_len(4) + min/max(24) + vertex/index count(8)。
    if tri_count as usize > r.remaining() / 36 {
        return Err(WorldBinError::Truncated {
            at: r.pos,
            need: tri_count as usize * 36,
            len: bytes.len(),
        });
    }
    let mut out = Vec::with_capacity(tri_count as usize);
    for _ in 0..tri_count {
        let name_len = r.take_u32()? as usize;
        let name_bytes = r.take(name_len)?;
        let name = std::str::from_utf8(name_bytes)
            .map_err(|_| WorldBinError::InvalidUtf8)?
            .to_owned();
        let min = r.take_f32x3()?;
        let max = r.take_f32x3()?;
        let vertex_count = r.take_u32()?;
        let index_count = r.take_u32()?;
        if vertex_count as usize > r.remaining() / VERTEX_LEN {
            return Err(WorldBinError::Truncated {
                at: r.pos,
                need: vertex_count as usize * VERTEX_LEN,
                len: bytes.len(),
            });
        }
        let mut vertices = Vec::with_capacity(vertex_count as usize);
        for _ in 0..vertex_count {
            let v = r.take_f32x3()?;
            vertices.push([v[0] as f64, v[1] as f64, v[2] as f64]);
        }
        if index_count as usize > r.remaining() / INDEX_LEN {
            return Err(WorldBinError::Truncated {
                at: r.pos,
                need: index_count as usize * INDEX_LEN,
                len: bytes.len(),
            });
        }
        let mut indices = Vec::with_capacity(index_count as usize);
        for _ in 0..index_count {
            let idx = [
                r.take_u32()?,
                r.take_u32()?,
                r.take_u32()?,
            ];
            for &i in &idx {
                if i >= vertex_count {
                    return Err(WorldBinError::IndexOutOfBounds {
                        index: i,
                        vertices: vertex_count,
                    });
                }
            }
            indices.push(idx);
        }
        out.push(TriMesh {
            name,
            vertices,
            indices,
            min: [min[0] as f64, min[1] as f64, min[2] as f64],
            max: [max[0] as f64, max[1] as f64, max[2] as f64],
        });
    }
    r.finish()?;
    Ok(out)
}

fn push_header(out: &mut Vec<u8>, brushes: u32, tri_meshes: u32) {
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&brushes.to_le_bytes());
    out.extend_from_slice(&tri_meshes.to_le_bytes());
}

fn read_header(r: &mut Reader<'_>) -> Result<(u32, u32), WorldBinError> {
    if r.remaining() < HEADER_LEN {
        return Err(WorldBinError::TooShort { got: r.remaining() });
    }
    let magic = r.take_array::<4>()?;
    if magic != MAGIC {
        return Err(WorldBinError::BadMagic { got: magic });
    }
    let version = r.take_u32()?;
    if version != VERSION {
        return Err(WorldBinError::UnsupportedVersion { got: version });
    }
    let brushes = r.take_u32()?;
    let tri_meshes = r.take_u32()?;
    Ok((brushes, tri_meshes))
}

fn push_f32x3(out: &mut Vec<u8>, v: [f32; 3]) {
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
}

fn f64x3_to_f32(v: V3) -> [f32; 3] {
    [v[0] as f32, v[1] as f32, v[2] as f32]
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], WorldBinError> {
        let end = self.pos.checked_add(n).ok_or(WorldBinError::SizeOverflow)?;
        let slice = self.data.get(self.pos..end).ok_or(WorldBinError::Truncated {
            at: self.pos,
            need: n,
            len: self.data.len(),
        })?;
        self.pos = end;
        Ok(slice)
    }

    fn skip(&mut self, n: usize) -> Result<(), WorldBinError> {
        self.take(n).map(|_| ())
    }

    fn take_u8(&mut self) -> Result<u8, WorldBinError> {
        Ok(self.take(1)?[0])
    }

    fn take_u32(&mut self) -> Result<u32, WorldBinError> {
        Ok(u32::from_le_bytes(self.take_array::<4>()?))
    }

    fn take_f32(&mut self) -> Result<f32, WorldBinError> {
        Ok(f32::from_le_bytes(self.take_array::<4>()?))
    }

    fn take_f32x3(&mut self) -> Result<[f32; 3], WorldBinError> {
        Ok([self.take_f32()?, self.take_f32()?, self.take_f32()?])
    }

    fn take_array<const N: usize>(&mut self) -> Result<[u8; N], WorldBinError> {
        let slice = self.take(N)?;
        let mut out = [0u8; N];
        out.copy_from_slice(slice);
        Ok(out)
    }

    fn finish(&self) -> Result<(), WorldBinError> {
        if self.pos != self.data.len() {
            return Err(WorldBinError::TrailingBytes {
                at: self.pos,
                len: self.data.len() - self.pos,
            });
        }
        Ok(())
    }
}
