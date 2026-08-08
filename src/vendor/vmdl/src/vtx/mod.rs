mod raw;

use crate::{read_relative, ModelError, ReadRelative, Readable};
use itertools::Either;
use raw::*;
pub use raw::{MeshFlags, StripFlags, StripGroupFlags, Vertex};
use std::ops::Range;

pub const MDL_VERSION: i32 = 7;

type Result<T> = std::result::Result<T, ModelError>;

/// The vtx file contains the mesh data for each mesh in an mdl, indexing into the vvd file
#[derive(Debug, Clone)]
pub struct Vtx {
    pub header: VtxHeader,
    pub body_parts: Vec<BodyPart>,
}

impl Vtx {
    pub fn read(data: &[u8]) -> Result<Self> {
        let header = <VtxHeader as Readable>::read(data)?;
        Ok(Vtx {
            body_parts: read_relative(data, header.body_indexes())?,
            header,
        })
    }
}

#[derive(Debug, Clone)]
pub struct BodyPart {
    pub models: Vec<Model>,
}

impl ReadRelative for BodyPart {
    type Header = BodyPartHeader;

    fn read(data: &[u8], header: Self::Header) -> Result<Self> {
        Ok(BodyPart {
            models: read_relative(data, header.model_indexes())?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Model {
    pub lods: Vec<ModelLod>,
}

impl ReadRelative for Model {
    type Header = ModelHeader;

    fn read(data: &[u8], header: Self::Header) -> Result<Self> {
        Ok(Model {
            lods: read_relative(data, header.lod_indexes())?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct ModelLod {
    pub meshes: Vec<Mesh>,
    pub switch_point: f32,
}

impl ReadRelative for ModelLod {
    type Header = ModelLodHeader;

    fn read(data: &[u8], header: Self::Header) -> Result<Self> {
        Ok(ModelLod {
            meshes: read_relative(data, header.mesh_indexes())?,
            switch_point: header.switch_point,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Mesh {
    pub strip_groups: Vec<StripGroup>,
    pub flags: MeshFlags,
}

impl ReadRelative for Mesh {
    type Header = MeshHeader;

    fn read(data: &[u8], header: Self::Header) -> Result<Self> {
        Ok(Mesh {
            strip_groups: read_relative(data, header.strip_group_indexes())?,
            flags: header.flags,
        })
    }
}

#[derive(Debug, Clone)]
pub struct StripGroup {
    // todo topologies
    pub indices: Vec<u16>,
    pub vertices: Vec<Vertex>,
    pub strips: Vec<Strip>,
    pub flags: StripGroupFlags,
}

impl ReadRelative for StripGroup {
    type Header = StripGroupHeader;

    fn read(data: &[u8], header: Self::Header) -> Result<Self> {
        Ok(StripGroup {
            vertices: read_relative(data, header.vertex_indexes())?,
            strips: read_relative(data, header.strip_indexes())?,
            indices: read_relative(data, header.index_indexes())?,
            flags: header.flags,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Strip {
    // todo bone state changes
    vertices: Range<usize>,
    pub flags: StripFlags,
    indices: Range<usize>,
}

impl ReadRelative for Strip {
    type Header = StripHeader;

    fn read(_data: &[u8], header: Self::Header) -> Result<Self> {
        Ok(Strip {
            vertices: header.vertex_indexes(),
            indices: header.index_indexes(),
            flags: header.flags,
        })
    }
}

impl Strip {
    pub fn vertices(&self) -> impl Iterator<Item = usize> + 'static {
        self.vertices.clone()
    }

    /// 展开条带/列表索引为三角形列表（每 3 个索引一个三角形）。
    ///
    /// 【修复】原实现（crates.io v0.2.0）条带分支有 2 处错误：
    /// - 奇数位公式 `[idx, idx+1-cw, idx+2-cw]` 生成两个相同索引的退化三角形
    ///   （正确应 `[idx, idx+1+cw, idx+2-cw]`），导致条带**每隔一个三角形丢失**；
    /// - 循环 `0..len` 多出 2 次迭代，末尾索引越界，读到同组下一条带的数据，
    ///   生成**跨条带杂散三角形**（模型边角处"多四角面"的根因）。
    /// 现改为 `0..len-2` + 交替绕序的正确展开。
    pub fn indices(&self) -> impl Iterator<Item = usize> + 'static {
        if self.flags.contains(StripFlags::IS_TRI_STRIP) {
            let offset = self.indices.start;
            // 条带 n 个索引 → n-2 个三角形，绕序交替；最后整体 rev 以匹配
            // Source（CW）→ glTF（CCW）的绕序约定（与列表分支一致）。
            Either::Left(
                (0..self.indices.len().saturating_sub(2)).flat_map(move |i| {
                    let cw = i & 1;
                    let idx = offset + i;
                    [idx, idx + 1 + cw, idx + 2 - cw].into_iter().rev()
                }),
            )
        } else {
            Either::Right(self.indices.clone().rev())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造条带：indices range 覆盖 [start, end)，flags 指定条带/列表。
    fn strip(start: usize, count: usize, strip: bool) -> Strip {
        let flags = if strip {
            StripFlags::IS_TRI_STRIP
        } else {
            StripFlags::IS_TRI_LIST
        };
        Strip {
            vertices: start..(start + count),
            indices: start..(start + count),
            flags,
        }
    }

    #[test]
    fn strip_expansion_is_correct() {
        // 6 个索引的条带 → 4 个三角形（n-2），绕序交替并整体反转（Source CW → glTF CCW）：
        // T0'=(2,1,0) T1'=(2,3,1) T2'=(4,3,2) T3'=(4,5,3)
        let s = strip(0, 6, true);
        let out: Vec<usize> = s.indices().collect();
        assert_eq!(out, vec![2, 1, 0, 2, 3, 1, 4, 3, 2, 4, 5, 3]);
        // 不得有退化三角形（两索引相同）
        for c in out.chunks_exact(3) {
            assert_ne!(c[0], c[1]);
            assert_ne!(c[1], c[2]);
            assert_ne!(c[0], c[2]);
        }
    }

    #[test]
    fn strip_expansion_never_reads_past_end() {
        // 末尾不得越界：所有输出索引必须落在条带自己的索引范围内
        for count in 0..9 {
            let s = strip(10, count, true);
            let out: Vec<usize> = s.indices().collect();
            for idx in &out {
                assert!(idx < &(10 + count), "count={count} 越界索引 {idx}");
            }
            assert_eq!(out.len(), count.saturating_sub(2) * 3);
        }
    }

    #[test]
    fn list_expansion_reverses_winding_only() {
        // 列表模式：每个三角形绕序反转，不改变三角形构成
        let s = strip(0, 6, false);
        let out: Vec<usize> = s.indices().collect();
        assert_eq!(out, vec![5, 4, 3, 2, 1, 0]);
    }
}
