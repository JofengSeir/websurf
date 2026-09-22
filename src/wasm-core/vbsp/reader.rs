//! lump 字节读取器：在"某个 lump 的字节"之上按记录类型读出结构化数据。
//!
//! 上游：`bspfile.rs` 的 `BspFile::lump_reader` 构造本类型，并把该 lump 自身的版本号传入。
//! 下游：`vbsp/mod.rs` 的 `Bsp` 组装流程按段调用 `read_entities` / `read_vec` / `read` /
//! `read_visdata` / `read_leaves`。
//!
//! 职责：① 按 `size_of::<T>()` 把 lump 切成等长记录；② 处理三类布局特殊的 lump
//! （实体文本、可见性偏移表、leaves 的双记录大小）；③ 把 `binrw` 的读错误统一成 `BspError`。
//!
//! 关键不变量与坑：
//! - `read_vec` 要求 lump 长度能被记录大小整除，否则返回 `InvalidLumpSize`——不补齐、不截断。
//! - `read_visdata` 返回的 `data` 是**整个 lump（含 numclusters 头）**，`pvs_offsets` /
//!   `pas_offsets` 则是相对该起点的偏移。两者必须配套使用：若 `data` 从偏移表之后开始，
//!   所有 PVS 行都会错位。
//! - `read_leaves` 的记录大小**不由 version 决定**，而是拿 BSP 树实际引用的最大 leaf 索引
//!   与 56 字节容量比较后决定；`Leaf` 本身是 32 字节，v1 记录多出的 24 字节 ambient 被丢弃。
//! - `read` 必须保持全限定调用语法（原因见该方法内注释），改回方法语法会与 std 的同名方法
//!   撞车。
//!
//! 边界：只读字节。不做校验和、不做版本协商，也不解释记录字段语义（那是 `data/**` 的职责）。
//!
//! 测试归属：本文件无 `#[test]`。

use crate::vbsp::*;
use binrw::BinReaderExt;
use std::borrow::Cow;
use std::fmt::Debug;
use std::io::{Read, SeekFrom};
use std::mem::size_of;

/// 某个 lump 的读取器：持有该 lump 的完整字节、长度、所属 lump 类型与版本号。
///
/// `length` 在构造时固定，后续 `read_vec` / `read_visdata` / `read_leaves` 都依据它
/// 判断记录条数，因此**不能**用 `inner` 的剩余长度代替——`read` 会持续推进游标。
pub struct LumpReader<R> {
    inner: R,
    length: usize,
    lump: LumpType,
    version: u32,
}

impl<'a> LumpReader<Cursor<Cow<'a, [u8]>>> {
    /// 用某个 lump 的完整字节构造读取器；`length` 取 `data.len()` 后不再变化。
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

    /// 返回该 lump 目录项里记录的版本号（原样透传，本类型不改写它）。
    pub fn version(&self) -> u32 {
        self.version
    }

    /// 消费读取器，取回尚未被 `Cursor` 释放的底层数据。
    pub fn into_data(self) -> Cow<'a, [u8]> {
        self.inner.into_inner()
    }
}

impl<R: BinReaderExt + Read> LumpReader<R> {
    /// 读实体 lump：把 `length` 声明的整段字节按 UTF-8 解码，再**整体转小写**后包成 `Entities`。
    ///
    /// 不做键值解析——那是 `data/entity.rs` 的职责；本方法只保证文本可用。
    /// 非 UTF-8 字节返回 `StringError`，不做 Latin-1 兜底。
    pub fn read_entities(&mut self) -> BspResult<Entities> {
        let mut data: Vec<u8> = vec![0; self.length];
        self.inner.read_exact(&mut data)?;
        let entities = String::from_utf8(data)
            .map_err(|e| StringError::from(e.utf8_error()))?
            .to_ascii_lowercase();
        Ok(Entities { entities })
    }

    /// 把 lump 当作等长记录数组读取，逐条交给 `f` 解析。
    ///
    /// 条数 = `length / size_of::<T>()`；`length` 不能被 `size_of::<T>()` 整除时返回
    /// `InvalidLumpSize`，**不补齐、不截断**。`T` 只用于取记录大小，实际产出类型由 `f` 决定。
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

    /// 从当前游标读一条 `binrw` 记录，并推进游标。
    ///
    /// 不校验"实际消费字节数 == `size_of::<T>()`"——该检查对含堆分配的类型不成立，
    /// 所以记录条数一律由 `read_vec` 依 `length` 推导，本方法只负责读与推进。
    pub fn read<T: BinRead + Debug>(&mut self) -> BspResult<T>
    where
        T::Args<'static>: Default,
        <T as BinRead>::Args<'static>: Clone,
    {
        // 必须用全限定调用：R 同时受 BinReaderExt + Read 约束，方法语法
        // `self.inner.read_le()` 会触发 unstable_name_collisions
        // （与 std 侧同名方法命名冲突，rust-lang/rust#48919）。不要改回方法调用语法。
        let result = BinReaderExt::read_le(&mut self.inner)?;
        Ok(result)
    }

    /// 读可见性 lump：先读 `cluster_count`，再读 pvs / pas 两张偏移表，最后把**整个 lump**
    /// （含表头与偏移表）作为 `data` 一并返回。
    ///
    /// 不变量：`pvs_offsets` / `pas_offsets` 里的偏移是相对 **lump 起点**的，所以消费方要按
    /// `data[offset]` 直接索引——本方法先把游标 seek 回 0 再整体读出，正是为了让
    /// `data[offset]` 与 lump 内绝对位置一致。若 `data` 只保留偏移表之后的字节，所有 PVS 行
    /// 都会整体错位。
    ///
    /// `length` 不足 8 字节（两个 u32）时返回空 `VisData`，不报错。
    pub fn read_visdata(&mut self) -> BspResult<VisData> {
        if self.length < size_of::<u32>() * 2 {
            return Ok(VisData::default());
        }

        let cluster_count: u32 = BinReaderExt::read_le(&mut self.inner)?;
        let mut pvs_offsets = Vec::with_capacity(min(cluster_count as usize, 1024));
        let mut pas_offsets = Vec::with_capacity(min(cluster_count as usize, 1024));

        for _ in 0..cluster_count {
            pvs_offsets.push(BinReaderExt::read_le(&mut self.inner)?);
            pas_offsets.push(BinReaderExt::read_le(&mut self.inner)?);
        }

        // 偏移基准是 lump 起点（含 numclusters 头），不是偏移表之后。
        // 故此处 seek 回 0 并保留完整 lump，使 data[offset] 与 lump 内绝对位置一致。
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

    /// 读 leaves lump，返回 `Leaf` 列表（每条恒为 32 字节）。
    ///
    /// **记录大小不由 lump version 决定**。v1 记录是 56 字节（32 字节 `Leaf` + 24 字节
    /// ambient），v0 记录是 32 字节。本方法用调用方传入的 `max_leaf_index`（BSP 树实际引用
    /// 的最大 leaf 索引）与"按 56 字节能容纳的条数"作比较来选定：仅当 `length` 能被 56 整除
    /// **且** `max_leaf_index < length / 56` 时按 v1 读，否则退回 32 字节记录。
    ///
    /// 为什么必须这样定：leaves 与 nodes 是互相索引的两张表，记录大小判错会让
    /// `node.children` 的 leaf 索引映射到错误的表项。
    ///
    /// v1 分支下，每条记录多读的 24 字节 ambient 被丢弃（`Leaf` 没有该字段）。
    /// 调用方须在读完 nodes、拿到 `max_leaf_index` 之后再调用本方法。
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
