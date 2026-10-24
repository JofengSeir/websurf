> **仓内 vendored 副本**：本目录经仓库根 `Cargo.toml` 的 `[patch.crates-io]` 替换 crates.io `lzma 0.2.2`。相对上游改动了 `src/reader/window.rs` 的 `Window::push`（滑窗由 `Vec::insert` 改原地覆盖，逐字节语义不变）并做过告警清理（`try!`→`?` 等，无语义变化）；台账见仓库根 `Cargo.toml` 注释。以下为上游原文 README。

LZMA
====
[![Build Status](https://travis-ci.org/meh/rust-lzma.svg?branch=master)](https://travis-ci.org/meh/rust-lzma)

LZMA handling library.

```toml
[dependencies]
lzma = "*"
```

Example
-------
This example will print the contents of the decoded LZMA file to `stdout`.

```rust
use std::io::{self, Read, Write};
use std::env;
use std::process;

extern crate lzma;

fn main() {
	let mut decoder = lzma::open(&env::args().nth(1).expect("missing file")).unwrap();
	let mut buffer  = [0u8; 4096];
	let mut stdout  = io::stdout();

	loop {
		match decoder.read(&mut buffer) {
			Ok(0) =>
				break,

			Ok(n) =>
				stdout.write_all(&buffer[0..n]).unwrap(),

			Err(_) =>
				process::exit(1),
		}
	}
}
```
