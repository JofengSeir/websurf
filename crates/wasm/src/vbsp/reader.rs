use crate::vbsp::*;
use binrw::BinReaderExt;
use std::borrow::Cow;
use std::fmt::Debug;
use std::io::{Read, SeekFrom};
use std::mem::size_of;

pub struct LumpReader<R> {
    inner: R,
    length: usize,
    lump: LumpType,
    version: u32,
}

impl<'a> LumpReader<Cursor<Cow<'a, [u8]>>> {
    pub fn new(data: Cow<'a, [u8]>, lump: LumpType, version: u32) -> Self {
        let length = data.len();
        let reader = Cursor::new(data);
        LumpReader {
            inner: reader,
            length,
            lump,
            version,
        }
    }

    pub fn version(&self) -> u32 {
        self.version
    }

    pub fn into_data(self) -> Cow<'a, [u8]> {
        self.inner.into_inner()
    }
}

impl<R: BinReaderExt + Read> LumpReader<R> {
    pub fn read_entities(&mut self) -> BspResult<Entities> {
        let mut data: Vec<u8> = vec![0; self.length];
        self.inner.read_exact(&mut data)?;
        let entities = String::from_utf8(data)
            .map_err(|e| StringError::from(e.utf8_error()))?
            .to_ascii_lowercase();
        Ok(Entities { entities })
    }

    /// Read a list of items with a fixed size
    pub fn read_vec<F, T>(&mut self, mut f: F) -> BspResult<Vec<T>>
    where
        F: FnMut(&mut LumpReader<R>) -> BspResult<T>,
    {
        if self.length % size_of::<T>() != 0 {
            return Err(BspError::InvalidLumpSize {
                lump: self.lump,
                element_size: size_of::<T>(),
                lump_size: self.length,
            });
        }
        let num_entries = self.length / size_of::<T>();
        let mut entries = Vec::with_capacity(num_entries);

        for _ in 0..num_entries {
            entries.push(f(self)?);
        }

        Ok(entries)
    }

    pub fn read<T: BinRead + Debug>(&mut self) -> BspResult<T>
    where
        T::Args<'static>: Default,
        <T as BinRead>::Args<'static>: Clone,
    {
        // let start = self.inner.stream_position().unwrap() as usize;
        let result = self.inner.read_le()?;
        // let end = self.inner.stream_position().unwrap() as usize;
        // todo: figure out how to only run this check for types that don't allocate
        // debug_assert_eq!(
        //     end - start,
        //     size_of::<T>(),
        //     "Incorrect number of bytes consumed while reading a {} ({:#?})",
        //     type_name::<T>(),
        //     result
        // );
        Ok(result)
    }

    pub fn read_visdata(&mut self) -> BspResult<VisData> {
        if self.length < size_of::<u32>() * 2 {
            return Ok(VisData::default());
        }

        let cluster_count = self.inner.read_le()?;
        let mut pvs_offsets = Vec::with_capacity(min(cluster_count as usize, 1024));
        let mut pas_offsets = Vec::with_capacity(min(cluster_count as usize, 1024));

        for _ in 0..cluster_count {
            pvs_offsets.push(self.inner.read_le()?);
            pas_offsets.push(self.inner.read_le()?);
        }

        // 【修复】vis lump 的 bitofs 是「相对整个 lump 起始(含 numclusters 头)」的偏移
        // (Source: `map_vis + bitofs[cluster][visType]`)。此前 data 只保留偏移表之后的
        // 字节, 而 offsets 未减去头长, 导致所有 PVS 行错位读取 (偏差 4 + 8*cluster_count
        // 字节) —— 行内容错配, 仅密度近似正确。这里回卷到 lump 起点, 保留完整数据,
        // 使 data[offset] == lump[offset]。
        self.inner.seek(SeekFrom::Start(0))?;

        let mut data = Vec::new();
        self.inner.read_to_end(&mut data)?;

        Ok(VisData {
            cluster_count,
            pvs_offsets,
            pas_offsets,
            data,
        })
    }

    /// 读取 leaves lump。
    ///
    /// 记录大小**不能只看 lump version**：实测部分 BSP（如 surf_nsz_fix，
    /// v20 + leaves lump version=1）实际写的是 32 字节 dleaf_t 记录，
    /// 而标准 v1 是 56 字节（含 ambient）。统一按 version 解析会把
    /// node.children 的 leaf 索引映射到错误的表（索引越界/错位）。
    ///
    /// 自适应规则：以 BSP 树实际引用的最大 leaf 索引为准——
    /// `max_leaf_index < len/56` 说明按 56 字节（v1 记录）可容纳，否则按 32 字节。
    ///
    /// 调用方（Bsp::read）需在读取 nodes 后把 `max_leaf_index` 传入。
    pub fn read_leaves(&mut self, max_leaf_index: i32) -> BspResult<Vec<Leaf>> {
        const LEAF_V1_SIZE: usize = 56;
        let n56 = self.length / LEAF_V1_SIZE;
        let use_v1 = self.length % LEAF_V1_SIZE == 0 && (max_leaf_index as usize) < n56;
        if !use_v1 {
            return self.read_vec(|r| r.read());
        }
        if self.length % LEAF_V1_SIZE != 0 {
            return Err(BspError::InvalidLumpSize {
                lump: self.lump,
                element_size: LEAF_V1_SIZE,
                lump_size: self.length,
            });
        }
        let num_entries = self.length / LEAF_V1_SIZE;
        let mut entries = Vec::with_capacity(num_entries);
        for _ in 0..num_entries {
            // 前 32 字节布局与 version 0 相同, 后 24 字节是 ambient lighting cube
            entries.push(self.read()?);
            let mut ambient = [0u8; 24];
            self.inner.read_exact(&mut ambient)?;
        }
        Ok(entries)
    }
}
