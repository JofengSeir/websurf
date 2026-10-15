use std::ops::{Deref, Index};
use std::io::Write;
use byteorder::WriteBytesExt;

use {Error};

/// A sliding window implementation.
#[derive(Debug)]
pub struct Window {
	buffer: Vec<u8>,
	size:   u32,

	position: u32,
	total:    u32,

	full: bool,
}

impl Window {
	/// Creates a sliding window with the given size.
	pub fn new(size: u32) -> Self {
		Window {
			buffer: Vec::with_capacity(size as usize),
			size:   size,

			position: 0,
			total:    0,

			full: false,
		}
	}

	/// Gets the size.
	pub fn size(&self) -> u32 {
		self.size
	}

	/// Gets the current position.
	pub fn position(&self) -> u32 {
		self.position
	}

	/// Gets the total position.
	pub fn total(&self) -> u32 {
		self.total
	}

	/// Checks if the window is full.
	pub fn is_full(&self) -> bool {
		self.full
	}

	/// Checks if the window is empty.
	pub fn is_empty(&self) -> bool {
		self.position == 0 && !self.is_full()
	}

	#[doc(hidden)]
	pub unsafe fn reset(&mut self) {
		self.position = 0;
		self.total    = 0;
		self.full     = false;
	}

	/// Pushes a byte to the window and the given writer.
	pub fn push<W: Write>(&mut self, mut stream: W, byte: u8) -> Result<(), Error> {
		try!(stream.write_u8(byte));

		// ── WebSurf 补丁（本 vendored 副本相对上游 0.2.2 的唯一改动）────────────────────
		// 上游在这里写的是「把 byte 插进 buffer 的 position 处」。用的是插入（insert），会把插入点
		// 之后的元素整体右移：窗口**绕回之前**插入点恰好落在末尾、退化成追加，因此看不出问题；
		// 一旦 `position` 归零（输出长度超过窗口大小），每写一个字节都要搬移最多 `size` 字节 ⇒
		// **O(n²)**。实测 VBSP 的 LZMA 字典固定 16 MB —— 所有 <16 MB 的贴图毫秒级解出，而 4 条
		// >16 MB 的（22.0 / 20.4 / 21.0 / 33.9 MB）先磨 1.6~415 s、最后报 `Corrupted`。
		//
		// 改成就地覆盖后**逐字节语义与上游完全一致**（窗口读取仍走下面的 `Index`，未动），只有
		// 复杂度 O(n²) → O(1)。惰性增长是为了保留上游的内存占用曲线：`buffer` 只长到实际推进过的
		// 位置，不会一上来就按 `size` 提交整块（构造处那道 `with_capacity` 只是预留）。
		let position = self.position as usize;
		if self.buffer.len() <= position {
			self.buffer.resize(position + 1, 0);
		}
		self.buffer[position] = byte;

		self.position += 1;
		self.total    += 1;

		if self.position() == self.size() {
			self.position = 0;
			self.full     = true;
		}

		Ok(())
	}

	/// Pushes `length` bytes from the given distance into the window and the given writer.
	pub fn copy<W: Write>(&mut self, mut stream: W, distance: u32, length: usize) -> Result<(), Error> {
		for _ in 0 .. length {
			let b = self[distance];
			try!(self.push(stream.by_ref(), b));
		}

		Ok(())
	}

	/// Checks if the distance is valid.
	pub fn check(&self, distance: u32) -> bool {
		distance <= self.position || self.full
	}
}

impl Index<u32> for Window {
	type Output = u8;

	fn index(&self, distance: u32) -> &u8 {
		if distance <= self.position {
			&self.buffer[(self.position - distance) as usize]
		}
		else {
			&self.buffer[(self.size - distance + self.position) as usize]
		}
	}
}

impl Deref for Window {
	type Target = [u8];

	fn deref(&self) -> &Self::Target {
		&*self.buffer
	}
}
