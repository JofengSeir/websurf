//! `.mtz` 容器：textures.json 文本 ↔ 压缩字节流（字段分区 + Huffman + LZ77）。
//!
//! 落盘布局（写出见 `compress_json_detailed`，读入见 `decompress_mtz`）：
//! 〔魔数 4 B〕〔条目数 u32 小端 4 B〕〔flags 1 B〕〔6 段 Huffman 块，按区域序号排列〕。
//! 每段是 `huffman_compress` 输出的一份自描述块（256 B 码长表 + u32 原始长度 + 位流）；
//! 区域 1..=5 另算一份"先 LZ77 再 Huffman"的结果，仅在更短时采用并置 flags 对应位，
//! `R_META` 恒为纯 Huffman（位定义见 `FLAG_NAMES_LZ` 起的 5 个常量）。解码侧据此逐块读、
//! 按 flags 决定是否再跑一遍 `lz_decompress`。
//!
//! 本文件只用 std：模块体不 `use` 任何 crate（仅测试模块有 `use super::*;`）。
//! Huffman 是字节级规范码，码表由频次现场重建、不随块落盘；LZ77 是 2 字节哈希链
//! 加贪心最长匹配。
//!
//! 上下游：
//! - 上游文本由 `parse_json` 读入。它按行切分，不是通用 JSON 解析器：只认
//!   `render_json` 写出的 `"键": "值"` 排布，值须是 `#mosaic v4` 字节码
//!   （字段提取见 `parse_bytecode`；字段顺序与 `src/wasm-core/mosaic/encode.rs` 的
//!   `img_to_code` 一致，另多一个 `G` 字段）。
//! - 下游消费在解压方向：`decompress_mtz` 由 `apps/debug/crates/wasm/src/lib.rs` 与
//!   `apps/game/crates/wasm/src/lib.rs` 的同名导出函数转给 JS；返回的文本在
//!   `apps/debug/src/default-pack.ts` 的 `loadDefaultTexturePack` 里被 `JSON.parse`
//!   成 `{ 键: 字节码 }`（供 `apps/debug/src/app.ts` 的 `showMissingTextures` 比对键），
//!   在 `src/ts-shared/phys/world-builder.ts` 里作为 `defaultsJson` 交给
//!   `export_glb_with_pakfile_models_with_defaults_and_lights`；`apps/viewer` 不引用本模块。
//! - 压缩方向的 `compress_json` / `compress_json_detailed` 在本仓只被本文件的
//!   `#[cfg(test)]` 调用。
//!
//! 关键不变量：
//! - 区域顺序 `R_META` → `R_NAMES` → `R_COLORS` → `R_SIGS` → `R_ALPHAS` → `R_INDICES`
//!   在 `pack_regions`、`compress_json_detailed`、`decompress_mtz` 三处一致；
//!   区域 `r`（1..=5）的 LZ 标志位 = `1 << (r - 1)`。
//! - meta 记录定长：`MAGIC` 走 8 B（末字节 `opacity`），`MAGIC_V5` 走 7 B
//!   （无该字段，按 255 补），`unpack_regions` 因此收 `meta_len` 参数。
//! - 每条的 alpha 段长 = `ceil(w * h / 8)` B，索引段长 = `ceil(w * h * bits / 8)` B
//!   （`bits` 见 `Entry::bits`）：写入侧由 `pack_regions` 的 `assert_eq!` 把关，
//!   读取侧由 `unpack_regions` 按同式算长度后取片。
//! - `decompress_mtz` 的长度下限是 13 B，且 6 段块必须正好铺满入参。
//!
//! 边界：不做图像处理（不查调色板、不生成 PNG），不解 BSP / LZMA。各字段的字面量
//! 合法性由对应解析器负责（`unhex` / `unb64` / `str::parse`），未识别字段名直接跳过。
//!
//! 测试归属：本文件内联 6 个 `#[test]`（3 个 LZ77 往返、2 个 JSON↔MTZ 往返、
//! 1 个异常入参拒绝）。
/// 当前写出格式的魔数；`compress_json_detailed` 固定以它开头。
pub const MAGIC: &[u8; 4] = b"MTZ6";
/// 兼容读入的旧魔数：`decompress_mtz` 认它时 meta 记录按 7 B 读。
pub const MAGIC_V5: &[u8; 4] = b"MTZ5";

// ---------------------------------------------------------------------------
// Huffman：字节级规范码；码表由频次现场重建，不随数据落盘
// ---------------------------------------------------------------------------

/// 由 256 项频次表建 Huffman 树并生成规范码，返回 (每符号码长, 规范码)。
///
/// 建树：只让频次大于 0 的字节成为叶子，内部节点 id 从 256 起递增（`next`），
/// 每次取出两个最小节点合并——比较用 `(freq, id)` 元组序，故同一频次表必得同一棵树。
/// 码长由根向下递归累加（`walk`）；频次表里只剩一个不同字节时该字节记 1 bit，
/// 全 0 频次（空输入）返回全 0 码长，两者都不产出任何位。
///
/// 规范码：按 `(码长, 符号值)` 升序排列后逐符号生成——先把 `code` 左移到与前一个
/// 符号的码长差、把它记为该符号的码、再自增。`huffman_decompress` 用同一排序规则
/// 重建解码表，两侧不交换任何码表数据。
fn huffman_codes(freq: &[u64; 256]) -> ([u8; 256], [u32; 256]) {
    let mut lens = [0u8; 256];
    let mut codes = [0u32; 256];
    // 只把频次大于 0 的字节做成叶子（符号 = 字节值）；内部节点 id 从 256 起递增，
    // 其两个子节点存在 children[id - 256]
    let mut nodes: Vec<(u64, u16)> = freq
        .iter()
        .enumerate()
        .filter(|(_, &f)| f > 0)
        .map(|(i, &f)| (f, i as u16))
        .collect();
    let mut next = 256u16;
    let mut children: Vec<(u16, u16)> = Vec::new();
    while nodes.len() > 1 {
        // 线性扫出两个最小节点；元组比较把 id 也算进去，故频次相同时的选取结果唯一
        let mut m1 = 0usize;
        let mut m2 = 1usize;
        for i in 2..nodes.len() {
            if nodes[i] < nodes[m1] {
                m2 = m1;
                m1 = i;
            } else if nodes[i] < nodes[m2] {
                m2 = i;
            }
        }
        let (f1, id1) = nodes[m1];
        let (f2, id2) = nodes[m2];
        nodes.swap_remove(m1.max(m2));
        nodes.swap_remove(m1.min(m2));
        children.push((id1, id2));
        nodes.push((f1 + f2, next));
        next += 1;
    }
    // 码长 = 从根到叶的边数：由 walk 递归下推
    fn walk(children: &[(u16, u16)], id: u16, depth: u16, lens: &mut [u8; 256]) {
        if (id as usize) < 256 {
            lens[id as usize] = depth as u8;
            return;
        }
        let c = children[(id - 256) as usize];
        walk(children, c.0, depth + 1, lens);
        walk(children, c.1, depth + 1, lens);
    }
    if let Some(&(_, root)) = nodes.first() {
        if root < 256 {
            // 树下只剩一个符号（没有内部节点作根）：给它 1 bit，位流里即 1 个 0
            lens[root as usize] = 1;
        } else {
            walk(&children, root, 0, &mut lens);
        }
    }
    // 规范码：按 (码长, 符号值) 升序逐个生成，与 huffman_decompress 的重建规则同源
    let mut syms: Vec<u8> = (0..256u16).filter(|&s| lens[s as usize] > 0).map(|s| s as u8).collect();
    syms.sort_by_key(|&s| (lens[s as usize], s));
    let mut code = 0u32;
    let mut prev_len = 0u8;
    for &s in &syms {
        let l = lens[s as usize];
        code <<= l - prev_len;
        codes[s as usize] = code;
        code += 1;
        prev_len = l;
    }
    (lens, codes)
}

/// Huffman 压缩：统计字节频次 → 建规范码 → 拼接输出。
///
/// 输出 = `[256 B 码长表][u32 小端原始字节数][位流]`；位流 MSB-first，最后一个字节
/// 的低位补 0。码长表即全部码表信息，解码侧按同一排序规则重建规范码。
/// 空输入输出 260 B（256 B 全 0 码长表 + 长度 0），与 `huffman_decompress` 的
/// `decoded_len == 0` 分支互相吻合。
pub fn huffman_compress(data: &[u8]) -> Vec<u8> {
    let mut freq = [0u64; 256];
    for &b in data {
        freq[b as usize] += 1;
    }
    let (lens, codes) = huffman_codes(&freq);
    let mut out = Vec::with_capacity(data.len() + 260);
    out.extend_from_slice(&lens);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    let mut acc = 0u32;
    let mut nbits = 0u32;
    for &b in data {
        let (l, c) = (lens[b as usize] as u32, codes[b as usize]);
        for k in (0..l).rev() {
            acc = (acc << 1) | ((c >> k) & 1);
            nbits += 1;
            if nbits == 8 {
                out.push(acc as u8);
                acc = 0;
                nbits = 0;
            }
        }
    }
    if nbits > 0 {
        out.push((acc << (8 - nbits)) as u8);
    }
    out
}

/// Huffman 解压：从自描述块还原字节，返回 (解码数据, 本块消耗的字节数)。
///
/// 入参是"本块起点到文件末尾"的整段切片——第二个返回值供 `decompress_mtz` 逐块推进
/// 读取位置；消耗量 = 260 B 表头 + 实际读掉的位数向上折算到字节。
///
/// 解码表的重建与 `huffman_codes` 的生成规则一致：按 `(码长, 符号值)` 排序后累计出
/// 每个码长的首码 `first_code` 与首符号下标 `first_sym`，解码时逐位拼码字，
/// 落入 `[first_code, first_code + count)` 即命中该码长区间。
///
/// 拒绝条件：入参不足 260 B（"Huffman 块过短"）、位流提前耗尽（"位流截断"）、
/// 读满 255 位仍未命中（"码长越界"）。原始字节数为 0 时返回空数据与固定 260 B，
/// 不再看后续字节。
pub fn huffman_decompress(data: &[u8]) -> Result<(Vec<u8>, usize), String> {
    if data.len() < 260 {
        return Err("Huffman 块过短".into());
    }
    let lens = &data[..256];
    let decoded_len = u32::from_le_bytes(data[256..260].try_into().unwrap()) as usize;
    let mut out = Vec::with_capacity(decoded_len);
    if decoded_len == 0 {
        return Ok((out, 260));
    }
    // 重建解码表：按 (码长, 符号值) 升序累计每个码长区间的首码与首符号下标
    let mut syms: Vec<u8> = (0..256u16).filter(|&s| lens[s as usize] > 0).map(|s| s as u8).collect();
    syms.sort_by_key(|&s| (lens[s as usize], s));
    let mut first_code = [0u32; 256];
    let mut count = [0u32; 256];
    let mut first_sym = [0usize; 256];
    let mut code = 0u32;
    let mut prev_len = 0u8;
    for (idx, &s) in syms.iter().enumerate() {
        let l = lens[s as usize] as usize;
        code <<= l - prev_len as usize;
        if count[l] == 0 {
            first_code[l] = code;
            first_sym[l] = idx;
        }
        count[l] += 1;
        code += 1;
        prev_len = lens[s as usize];
    }
    // 解码位流：MSB-first 逐位左移进 code，长度递增到命中码长区间为止
    let bits = &data[260..];
    let mut bit_pos = 0usize;
    let read_bit = |bit_pos: &mut usize| -> Result<u8, String> {
        if *bit_pos >= bits.len() * 8 {
            return Err("位流截断".into());
        }
        let b = (bits[*bit_pos / 8] >> (7 - *bit_pos % 8)) & 1;
        *bit_pos += 1;
        Ok(b)
    };
    for _ in 0..decoded_len {
        let mut code = 0u32;
        let mut len = 0usize;
        loop {
            code = (code << 1) | read_bit(&mut bit_pos)? as u32;
            len += 1;
            if len > 255 {
                return Err("码长越界".into());
            }
            if count[len] > 0 && code >= first_code[len] && code < first_code[len] + count[len] {
                let sym = syms[first_sym[len] + (code - first_code[len]) as usize];
                out.push(sym);
                break;
            }
        }
    }
    Ok((out, 260 + bit_pos.div_ceil(8)))
}

// ---------------------------------------------------------------------------
// LZ77：token 流（字面量 / 匹配 / 转义字面量）
// ---------------------------------------------------------------------------

/// 匹配距离上限（字节）：`lz_compress` 只在 `i - j <= WINDOW` 内找匹配，与 token 的
/// 距离字段位宽（4 bit 高位 + 8 bit 低位）所能表达的最大距离 4096 对齐。
const WINDOW: usize = 4096;
/// 最短匹配长度；更短的重复一律按字面量写出（`lz_compress` 里 `best_len` 的门限）。
const MIN_MATCH: usize = 4;
/// token 里长度字段的位宽上限；字段取到该值表示"另带 1 个扩展字节"。
const MAX_LEN3: usize = 7;

/// 写一条匹配 token：`[bit7=1 | 长度 3 bit | 距离高 4 bit][距离低 8 bit][扩展长度 1 B]`。
///
/// `len` 取 4..=265、`dist` 取 1..=4096。编码时 `dist - 1` 拆成高 4 bit 与低 8 bit，
/// 故距离上限是 4096；`len - 3` 填进 3 bit 长度字段，字段值 0 保留给转义字面量
/// （见 `lz_decompress` 的 `len3 == 0` 分支），所以最短匹配 4 B 对应字段值 1；
/// `len - 3 >= MAX_LEN3`（即 `len` 达到 10 及以上）时追加 1 字节扩展长度，
/// 解码侧把该字节加到 `len3 + 3` 上，上限正好 265。
fn emit_match(out: &mut Vec<u8>, len: usize, dist: usize) {
    let d = dist - 1;
    let len3 = (len - 3).min(MAX_LEN3);
    let token = 0x80 | ((len3 as u8) << 4) | ((d >> 8) as u8 & 0x0F);
    out.push(token);
    out.push(d as u8);
    if len - 3 >= MAX_LEN3 {
        out.push((len - 3 - MAX_LEN3) as u8);
    }
}

/// LZ77 压缩：2 字节哈希（`heads` 表 + `prev` 链）找最长匹配，命中即写匹配 token，
/// 否则写字面量。空输入返回空 `Vec`。
///
/// 约束与取舍（都影响可解压性，改动前需同步 `lz_decompress`）：
/// - 只有 `i` 扫过的位置才插入哈希链，被匹配整体跳过的位置不插入；
/// - 每个位置最多沿链回溯 4096 步，超出即停止搜索；
/// - 匹配距离不超过 `WINDOW`，匹配长度上限 `min(剩余字节, MAX_LEN3 + 258)` = 265；
/// - 字面量里 `>= 0x80` 的字节必须写成 `[0x80][原字节]` 两字节——`0x80` 的长度字段为 0，
///   解码侧据此认作转义，否则该字节会被当成匹配标记；
/// - `heads` 定长 `1 << 16`，`prev` 与输入等长，故额外内存与输入规模同阶。
pub fn lz_compress(data: &[u8]) -> Vec<u8> {
    let n = data.len();
    if n == 0 {
        return Vec::new();
    }
    let mut heads = vec![u32::MAX; 1 << 16];
    let mut prev = vec![u32::MAX; n];
    let mut out = Vec::with_capacity(n / 2);
    let mut i = 0usize;
    while i < n {
        // 找最长匹配：只走 < i 的已插入位置，每个位置至多回溯 4096 步
        let mut best_len = 0usize;
        let mut best_dist = 0usize;
        if i + 1 < n {
            let h = (((data[i] as usize) << 8) | data[i + 1] as usize) & 0xFFFF;
            let mut j = heads[h] as usize;
            let max_possible = (n - i).min(MAX_LEN3 + 258); // 单条匹配的长度上限 265
            let mut steps = 0usize;
            while j < i && i - j <= WINDOW && steps < 4096 {
                steps += 1;
                if data[j] == data[i] {
                    let mut l = 0usize;
                    while l < max_possible && data[j + l] == data[i + l] {
                        l += 1;
                    }
                    if l > best_len {
                        best_len = l;
                        best_dist = i - j;
                    }
                }
                j = prev[j] as usize;
            }
        }
        // 把当前位置挂到哈希链头；被匹配跳过的位置不插入，故链上只含已扫描位置
        if i + 1 < n {
            let h = (((data[i] as usize) << 8) | data[i + 1] as usize) & 0xFFFF;
            prev[i] = heads[h];
            heads[h] = i as u32;
        }
        if best_len >= MIN_MATCH {
            emit_match(&mut out, best_len, best_dist);
            i += best_len;
        } else {
            let b = data[i];
            if b < 0x80 {
                out.push(b);
            } else {
                // 高位为 1 的字面量必须转义成 [0x80][原字节]，否则解码侧会读成匹配标记
                out.push(0x80);
                out.push(b);
            }
            i += 1;
        }
    }
    out
}

/// LZ77 解压：逐字节扫 token 流，返回还原后的字节。
///
/// `b < 0x80` 即字面量原样输出；否则按 `[bit7=1 | 长度 3 bit | 距离高 4 bit][距离低 8 bit]`
/// 读一个匹配：长度字段 0 表示转义字面量（后随 1 字节原样输出），其余情况
/// `len = 字段值 + 3`、字段值为 7 时再读 1 字节扩展长度，
/// `dist = (高 4 bit << 8 | 低 8 bit) + 1`。拷贝按字节前向推进，
/// 因此 `dist < len` 的重叠匹配能按 RLE 方式正确展开。
///
/// 拒绝条件：token 声明了后续字节而输入已结束（"截断：…"）、`dist` 大于已输出长度
/// （"匹配距离越界"）。本函数不校验输出总长与任何外部声明长度是否一致。
pub fn lz_decompress(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(data.len() * 2);
    let mut pos = 0usize;
    while pos < data.len() {
        let b = data[pos];
        if b < 0x80 {
            out.push(b);
            pos += 1;
        } else {
            let len3 = ((b >> 4) & 0x07) as usize;
            let dist_hi = (b & 0x0F) as usize;
            if len3 == 0 {
                // 转义字面量：长度字段为 0，后随的那 1 字节是原样输出
                if pos + 1 >= data.len() {
                    return Err("截断：转义字面量".into());
                }
                out.push(data[pos + 1]);
                pos += 2;
            } else {
                if pos + 1 >= data.len() {
                    return Err("截断：匹配".into());
                }
                let dist = ((dist_hi << 8) | data[pos + 1] as usize) + 1;
                pos += 2;
                let mut len = len3 + 3;
                if len3 == MAX_LEN3 {
                    if pos >= data.len() {
                        return Err("截断：扩展长度".into());
                    }
                    len += data[pos] as usize;
                    pos += 1;
                }
                if dist > out.len() {
                    return Err(format!("匹配距离越界: {dist} > {}", out.len()));
                }
                let start = out.len() - dist;
                for k in 0..len {
                    let src = start + k;
                    out.push(out[src]);
                }
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// base64url（无填充）与十六进制字面量：`A[` / `R[` 与 `C[` 字段的书写形式
// ---------------------------------------------------------------------------

/// base64url 字母表：`-` 与 `_` 取代标准表的 `+` 与 `/`，不写 `=` 填充。
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// base64url 编码：每 3 字节一组出 4 字符；末组不足 3 字节时只出 2 或 3 字符（无填充）。
/// 与 `unb64` 互逆：`unb64(b64(x)) == x`，且不产生字母表外字符。
fn b64(data: &[u8]) -> String {
    let mut s = String::new();
    for c in data.chunks(3) {
        let n = ((c[0] as u32) << 16)
            | ((*c.get(1).unwrap_or(&0) as u32) << 8)
            | *c.get(2).unwrap_or(&0) as u32;
        s.push(B64[((n >> 18) & 63) as usize] as char);
        s.push(B64[((n >> 12) & 63) as usize] as char);
        if c.len() > 1 {
            s.push(B64[((n >> 6) & 63) as usize] as char);
        }
        if c.len() > 2 {
            s.push(B64[(n & 63) as usize] as char);
        }
    }
    s
}

/// base64url 解码：按 6 bit 累积、满 8 bit 输出 1 字节，末尾不足 8 bit 的残余位丢弃。
/// 遇 `B64` 之外的字符（含 `=` 填充）返回 `Err`，故只接受 `b64` 写出的无填充形式。
fn unb64(s: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut nb = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a') as u32 + 26,
            b'0'..=b'9' => (c - b'0') as u32 + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return Err(format!("base64url 非法字符: {c}")),
        };
        acc = (acc << 6) | v;
        nb += 6;
        if nb >= 8 {
            nb -= 8;
            out.push((acc >> nb) as u8);
            acc &= (1 << nb) - 1;
        }
    }
    Ok(out)
}

/// RGB → 6 字符大写十六进制（`C[` 字段的书写形式）。
fn hex(c: [u8; 3]) -> String {
    format!("{:02X}{:02X}{:02X}", c[0], c[1], c[2])
}

/// 十六进制 → RGB：先 `trim`，再要求恰好 6 个字符、每 2 字符按 16 进制解析（大小写皆可）；
/// 长度不符或含非 16 进制字符即返回 `Err`。
fn unhex(s: &str) -> Result<[u8; 3], String> {
    let s = s.trim();
    if s.len() != 6 {
        return Err(format!("hex 长度非法: {s}"));
    }
    Ok([
        u8::from_str_radix(&s[0..2], 16).map_err(|_| format!("hex 非法: {s}"))?,
        u8::from_str_radix(&s[2..4], 16).map_err(|_| format!("hex 非法: {s}"))?,
        u8::from_str_radix(&s[4..6], 16).map_err(|_| format!("hex 非法: {s}"))?,
    ])
}

// ---------------------------------------------------------------------------
// 条目：JSON 里的一条 `键 → 字节码`，文本与结构化形式之间的转换单元
// ---------------------------------------------------------------------------

/// 一条纹理条目：字节码各字段的结构化形式，也是 `pack_regions` / `unpack_regions` 的单元。
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// 纹理键（形如 `materials/xxx`）：`render_bytecode` 把它写进 `B[` 的名字段；
    /// `parse_json` 读完字节码后用 JSON 的键覆盖它，故两条通路都以 JSON 键为准。
    pub key: String,
    /// 网格宽（格数）：`parse_bytecode` 要求 ≥ 1 且 `w * h <= 100_000`；meta 记录里占 1 B。
    pub w: u32,
    /// 网格高（格数）：约束同 `w`；meta 记录里占 1 B。
    pub h: u32,
    /// 调色板，每色 RGB 3 B；条数限 1..=8（`parse_bytecode` 与 `unpack_regions` 都校验）。
    pub colors: Vec<[u8; 3]>,
    /// `G[...]` 的字节序列（逐字节十进制书写）；`unpack_regions` 只接受长度 0、2 或 4。
    pub sig: Vec<u8>,
    /// `A[...]` 的透明掩码原始位图，`None` 表示字节码里没有该字段。位序 MSB-first，
    /// 位 = 1 表示该格透明，位 = 0 取 `opacity`（见 `src/wasm-core/mosaic/decode.rs` 的 `code_to_img`）。
    pub alpha: Option<Vec<u8>>,
    /// `R[...]` 的索引位图：MSB-first 连续打包，每格 `bits()` 位，末字节空位为 0。
    pub indices: Vec<u8>,
    /// `T[...]` 的透明度系数；缺该字段（含 MTZ5 的 7 B meta）按 255 处理。
    pub opacity: u8,
}

impl Entry {
    /// 每格索引占用的位宽：1 色 → 0 bit（此时不写 `R[`）、2..=4 色 → 2 bit、其余 → 3 bit。
    /// `_` 分支同时兜住 0 色与 5..=8 色；两个外部入口已把色数限在 1..=8。
    pub fn bits(&self) -> usize {
        match self.colors.len() {
            1 => 0,
            2..=4 => 2,
            _ => 3,
        }
    }
}

/// 解析单条 `#mosaic v4` 字节码文本 → `Entry`。`key` 取 `B[` 名字段里 `|` 之前的一段
/// （`parse_json` 随后会用 JSON 的键覆盖它）。
///
/// 定位方式与 `src/wasm-core/mosaic/decode.rs` 的 `code_to_img` 相同：取第一行以 `B[`
/// 开头者，再按 `]` 切段、每段用 `[` 分成「字段名 / 值」；未识别的字段名直接跳过，
/// 因此字段缺失或多余都不影响解析，字段先后顺序也不参与判断。
///
/// 字段取值：`B[名字:宽x高]`（名字取 `|` 之前的一段，尺寸按 `x` 分隔）、`C[RRGGBB,…]`、
/// `T[十进制 u8]`、`G[十进制 u8,…]`、`A[base64url]`、`R[base64url]`。
///
/// 拒绝条件：没有 `B[` 行、`B[` 缺 `:` 或 `x`、宽高非数字、`C` 的色数为 0 或大于 8、
/// `G` / `T` 数值非法、`A` / `R` 含字母表外字符、`w < 1`、`h < 1`、`w * h > 100_000`。
/// 不校验 `A` / `R` 的字节数是否与网格尺寸匹配——那由 `pack_regions` 的断言负责。
fn parse_bytecode(text: &str) -> Result<Entry, String> {
    let line = text
        .lines()
        .find(|l| l.starts_with("B["))
        .ok_or_else(|| "缺 B[ 行".to_string())?;
    let mut key = String::new();
    let (mut w, mut h) = (0u32, 0u32);
    let mut colors: Vec<[u8; 3]> = Vec::new();
    let mut sig: Vec<u8> = Vec::new();
    let mut alpha: Option<Vec<u8>> = None;
    let mut indices: Vec<u8> = Vec::new();
    let mut opacity: u8 = 255;
    for chunk in line.split(']') {
        let Some((field, rest)) = chunk.split_once('[') else { continue };
        match field {
            "B" => {
                let (names, size) = rest
                    .rsplit_once(':')
                    .ok_or_else(|| "B 缺尺寸".to_string())?;
                let (w_s, h_s) = size
                    .split_once('x')
                    .ok_or_else(|| "B 尺寸应为 WxH".to_string())?;
                w = w_s.trim().parse().map_err(|_| "宽非法")?;
                h = h_s.trim().parse().map_err(|_| "高非法")?;
                key = names.split('|').next().unwrap_or("").to_string();
            }
            "C" => {
                colors = rest
                    .split(',')
                    .map(unhex)
                    .collect::<Result<Vec<_>, _>>()?;
            }
            "G" => {
                sig = rest
                    .split(',')
                    .map(|t| t.trim().parse::<u8>())
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| "G 数值非法")?;
            }
            "T" => {
                opacity = rest
                    .trim()
                    .parse::<u8>()
                    .map_err(|_| "T 数值非法")?;
            }
            "A" => {
                alpha = Some(unb64(rest)?);
            }
            "R" => {
                indices = unb64(rest)?;
            }
            _ => {}
        }
    }
    if colors.is_empty() || colors.len() > 8 {
        return Err("颜色数非法".into());
    }
    if w < 1 || h < 1 || w * h > 100_000 {
        return Err("网格尺寸非法".into());
    }
    Ok(Entry {
        key,
        w,
        h,
        colors,
        sig,
        alpha,
        indices,
        opacity,
    })
}

/// 还原单条 `#mosaic v4` 字节码文本，末尾带换行。
///
/// 字段顺序 `B` → `C` → `T` → `G` → `A` → `R`，且按条件省略：`T` 仅在 `opacity < 250`
/// 时写出、`G` 仅在 `sig` 非空时写出、`A` 仅在 `alpha` 为 `Some` 时写出、`R` 仅在
/// `indices` 非空时写出。与 `src/wasm-core/mosaic/encode.rs` 的 `img_to_code` 相比多出
/// `G` 这个字段，其余字段顺序与收尾换行相同。
///
/// 不做转义与范围检查：`key` 里的 `[` / `]` / `:` 原样写入，`w` / `h` / `opacity` 直接取值。
fn render_bytecode(e: &Entry) -> String {
    let mut s = format!("#mosaic v4\nB[{}:{}x{}]C[", e.key, e.w, e.h);
    s.push_str(&e.colors.iter().map(|c| hex(*c)).collect::<Vec<_>>().join(","));
    s.push(']');
    if e.opacity < 250 {
        s.push_str(&format!("T[{}]", e.opacity));
    }
    if !e.sig.is_empty() {
        s.push_str("G[");
        s.push_str(&e.sig.iter().map(u8::to_string).collect::<Vec<_>>().join(","));
        s.push(']');
    }
    if let Some(a) = &e.alpha {
        s.push_str(&format!("A[{}]", b64(a)));
    }
    if !e.indices.is_empty() {
        s.push_str(&format!("R[{}]", b64(&e.indices)));
    }
    s.push('\n');
    s
}

/// JSON 字符串转义：两端补双引号；`"`、`\`、`\n`、`\r`、`\t` 写成两字符转义序列，
/// 其余小于 0x20 的控制字符写成 `\u00xx`；其他字符（含非 ASCII）原样输出。
fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// JSON 字符串反转义：先 `trim`，再要求首尾都是 `"`，否则报错；处理 `\"`、`\\`、
/// `\n`、`\r`、`\t` 与 `\uXXXX`（4 位十六进制转 `char`，转不出即报错），
/// 其他转义序列一律报错。不做 JSON 语法级校验（不查括号、逗号、裸控制字符）。
fn unescape_json(s: &str) -> Result<String, String> {
    let s = s.trim();
    let inner = s
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .ok_or_else(|| "非字符串".to_string())?;
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                let code = u32::from_str_radix(&hex, 16).map_err(|_| "\\u 非法")?;
                out.push(char::from_u32(code).ok_or_else(|| "\\u 越界")?);
            }
            _ => return Err("\\ 转义非法".into()),
        }
    }
    Ok(out)
}

/// 解析 textures.json 文本 → `Entry` 列表；输出顺序即文本行顺序。
///
/// 逐行处理，不是通用 JSON 解析器：跳过空行与单独的 `{`、`}`，去掉行尾 1 个 `,`，
/// 然后要求恰好一处 `": "`（冒号加一个空格）把该行切成键与值；两侧都过
/// `unescape_json`，值再交给 `parse_bytecode`，最后用行里的键覆盖 `B[` 的名字段。
///
/// 拒绝条件：某行不含 `": "`、反转义失败，或该行字节码不合法（即 `parse_bytecode`
/// 的全部拒绝条件）。值跨多行、单个条目拆成多行都不接受。
pub fn parse_json(text: &str) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    for raw in text.lines() {
        let l = raw.trim();
        if l.is_empty() || l == "{" || l == "}" {
            continue;
        }
        let l = l.strip_suffix(',').unwrap_or(l);
        let (k, v) = l
            .split_once(": ")
            .ok_or_else(|| format!("JSON 行非法: {raw:?}"))?;
        let key = unescape_json(k)?;
        let value = unescape_json(v)?;
        let mut e = parse_bytecode(&value)?;
        e.key = key;
        entries.push(e);
    }
    Ok(entries)
}

/// 还原 textures.json 文本：`{\n` + 每条一行 `  "键": "字节码"`（条目之间以 `,\n` 分隔）
/// + `\n}\n`。两处字符串都过 `escape_json`，键与字节码里的换行都写成 `\n`，
/// 故一条条目恰好占一行，可被 `parse_json` 逐行读回。
pub fn render_json(entries: &[Entry]) -> String {
    let mut s = String::from("{\n");
    for (i, e) in entries.iter().enumerate() {
        if i > 0 {
            s.push_str(",\n");
        }
        s.push_str("  ");
        s.push_str(&escape_json(&e.key));
        s.push_str(": ");
        s.push_str(&escape_json(&render_bytecode(e)));
    }
    s.push_str("\n}\n");
    s
}

// ---------------------------------------------------------------------------
// 条目 ↔ 区域：把同名字段跨条目拼成 6 段连续字节，逐段独立建模 Huffman / LZ
// ---------------------------------------------------------------------------

/// 区域序号起点；`R_META` 起按落盘顺序递增，除它之外区域 `r` 对应 flags 的 `1 << (r - 1)` 位。
const R_META: usize = 0;
/// 所有条目的键名首尾相接（每条的字节数由 meta 的 name_len 给出）。
const R_NAMES: usize = 1;
/// 所有条目的调色板首尾相接，每色 3 B。
const R_COLORS: usize = 2;
/// 所有条目的 `G` 字节序列首尾相接（每条的字节数由 meta 的 sig_len 给出）。
const R_SIGS: usize = 3;
/// 所有 `alpha` 为 `Some` 的条目的透明掩码首尾相接，每条 `ceil(w * h / 8)` B。
const R_ALPHAS: usize = 4;
/// 所有 `bits()` 大于 0 的条目的索引位图首尾相接，每条 `ceil(w * h * bits / 8)` B。
const R_INDICES: usize = 5;
/// 区域总数：`pack_regions` 返回数组的长度，也是落盘的段数与读取循环的上界。
const R_COUNT: usize = 6;

/// 条目 → 6 个区域：`R_META` 每条 8 B 定长记录，其余区域按条目顺序首尾拼接。
///
/// meta 8 字节的字段顺序：name_len(u16 小端)、w(u8)、h(u8)、色数(u8)、`sig` 长度(u8)、
/// 有无 alpha(u8)、opacity(u8)。
///
/// 副作用：用 `assert!` / `assert_eq!` 校验名字长度（不超过 u16 上限）、`alpha` 长度
/// （`ceil(w * h / 8)`）与 `indices` 长度（`ceil(w * h * bits / 8)`，仅当 `bits()` 大于 0）——
/// 不符即 panic 而非返回 `Err`；色数与 `sig` 长度只按 1 B 写入，不在此校验。
pub fn pack_regions(entries: &[Entry]) -> [Vec<u8>; R_COUNT] {
    let mut regions: [Vec<u8>; R_COUNT] = Default::default();
    for e in entries {
        let name = e.key.as_bytes();
        assert!(name.len() <= u16::MAX as usize, "名字过长: {}", e.key);
        regions[R_META].extend_from_slice(&(name.len() as u16).to_le_bytes());
        regions[R_META].push(e.w as u8);
        regions[R_META].push(e.h as u8);
        regions[R_META].push(e.colors.len() as u8);
        regions[R_META].push(e.sig.len() as u8);
        regions[R_META].push(if e.alpha.is_some() { 1 } else { 0 });
        regions[R_META].push(e.opacity);
        regions[R_NAMES].extend_from_slice(name);
        for c in &e.colors {
            regions[R_COLORS].extend_from_slice(c);
        }
        regions[R_SIGS].extend_from_slice(&e.sig);
        if let Some(a) = &e.alpha {
            let expect = (e.w as usize * e.h as usize).div_ceil(8);
            assert_eq!(a.len(), expect, "alpha 长度不符: {}", e.key);
            regions[R_ALPHAS].extend_from_slice(a);
        }
        let bits = e.bits();
        if bits > 0 {
            let expect = (e.w as usize * e.h as usize * bits).div_ceil(8);
            assert_eq!(e.indices.len(), expect, "索引长度不符: {}", e.key);
            regions[R_INDICES].extend_from_slice(&e.indices);
        }
    }
    regions
}

/// 区域 → 条目：按 `count` 逐条从 6 个区域各自的游标取片，输出顺序与打包顺序一致。
///
/// `meta_len` 取 8（`MAGIC`，末字节为 opacity）或 7（`MAGIC_V5`，opacity 按 255 补）；
/// 其余字段的字节数都由 meta 里的计数配合 `w` / `h` 算出。
///
/// 拒绝条件：任一区域取片越界（"区域 r 截断"）、色数不在 1..=8、`sig` 长度不是 0 / 2 / 4、
/// alpha 标志大于 1、键名不是 UTF-8、读完后任一区域仍有剩余字节（"区域 r 尾部有多余数据"）。
/// 不校验 `w` / `h` 是否 ≥ 1——该判断只出现在 `parse_bytecode`。
pub fn unpack_regions(
    regions: &[Vec<u8>; R_COUNT],
    count: usize,
    meta_len: usize,
) -> Result<Vec<Entry>, String> {
    let mut pos = [0usize; R_COUNT];
    let take = |r: usize, n: usize, pos: &mut [usize; R_COUNT]| -> Result<&[u8], String> {
        if pos[r] + n > regions[r].len() {
            return Err(format!("区域 {r} 截断"));
        }
        let v = &regions[r][pos[r]..pos[r] + n];
        pos[r] += n;
        Ok(v)
    };
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        let m = take(R_META, meta_len, &mut pos)?;
        let name_len = u16::from_le_bytes([m[0], m[1]]) as usize;
        let (w, h) = (m[2] as u32, m[3] as u32);
        let nc = m[4] as usize;
        let sg = m[5] as usize;
        let has_alpha = m[6];
        let opacity = if meta_len >= 8 { m[7] } else { 255 };
        if !(1..=8).contains(&nc) {
            return Err("颜色数非法".into());
        }
        if sg != 0 && sg != 2 && sg != 4 {
            return Err("签名格数非法".into());
        }
        if has_alpha > 1 {
            return Err("alpha 标志非法".into());
        }
        let name = std::str::from_utf8(take(R_NAMES, name_len, &mut pos)?)
            .map_err(|_| "名字非 UTF-8".to_string())?
            .to_string();
        let mut colors = Vec::with_capacity(nc);
        for _ in 0..nc {
            let c = take(R_COLORS, 3, &mut pos)?;
            colors.push([c[0], c[1], c[2]]);
        }
        let sig = take(R_SIGS, sg, &mut pos)?.to_vec();
        let alpha = if has_alpha == 1 {
            let n = ((w * h) as usize).div_ceil(8);
            Some(take(R_ALPHAS, n, &mut pos)?.to_vec())
        } else {
            None
        };
        let bits = match nc {
            1 => 0,
            2..=4 => 2,
            _ => 3,
        };
        let indices = if bits > 0 {
            let n = ((w * h) as usize * bits).div_ceil(8);
            take(R_INDICES, n, &mut pos)?.to_vec()
        } else {
            Vec::new()
        };
        entries.push(Entry {
            key: name,
            w,
            h,
            colors,
            sig,
            alpha,
            indices,
            opacity,
        });
    }
    for r in 0..R_COUNT {
        if pos[r] != regions[r].len() {
            return Err(format!("区域 {r} 尾部有多余数据: {} ≠ {}", pos[r], regions[r].len()));
        }
    }
    Ok(entries)
}

// ---------------------------------------------------------------------------
// 对外接口：flags 位定义 + 压缩（文本 → 字节）+ 解压（字节 → 文本）
// ---------------------------------------------------------------------------

/// `R_NAMES` 段是否 LZ77 前置（等于 `1 << (R_NAMES - 1)`）。
#[allow(dead_code)]
const FLAG_NAMES_LZ: u8 = 1 << 0;
/// `R_COLORS` 段是否 LZ77 前置。
#[allow(dead_code)]
const FLAG_COLORS_LZ: u8 = 1 << 1;
/// `R_SIGS` 段是否 LZ77 前置。
#[allow(dead_code)]
const FLAG_SIGS_LZ: u8 = 1 << 2;
/// `R_ALPHAS` 段是否 LZ77 前置。
#[allow(dead_code)]
const FLAG_ALPHAS_LZ: u8 = 1 << 3;
/// `R_INDICES` 段是否 LZ77 前置。
#[allow(dead_code)]
const FLAG_INDICES_LZ: u8 = 1 << 4;

/// 压缩报告：逐区域的体积明细，只用于观察与调优，不参与容器格式。
#[derive(Debug, Default)]
pub struct CompressReport {
    /// 每区一行 `(区域名, 原始字节, LZ77 后字节, 纯 Huffman 后字节, LZ+Huffman 后字节, 是否采用 LZ)`；
    /// 区域名来自 `compress_json_detailed` 内的 `names`（`R_META` 记 "meta"）；
    /// `R_META` 不试 LZ，故第 3、5 列分别等于第 2、4 列，末列为 false。
    pub regions: Vec<(String, usize, usize, usize, usize, bool)>,
}

/// 压缩：textures.json 文本 → `.mtz` 字节，只取字节、丢弃报告。
pub fn compress_json(text: &str) -> Result<Vec<u8>, String> {
    compress_json_detailed(text).map(|(bytes, _)| bytes)
}

/// 压缩并返回逐区报告：`parse_json` → `pack_regions` → 逐区选压缩方式 → 拼容器。
///
/// 选法：`R_META` 只做 `huffman_compress` 且不置 flags；区域 1..=5 各算一次纯 Huffman 与
/// 一次"先 `lz_compress` 再 Huffman"，仅当后者更短（严格小于）才采用并置 flags 的
/// `1 << (r - 1)` 位。输出 = `MAGIC` + 条目数(u32 小端) + flags(1 B) + 6 段块首尾相接。
pub fn compress_json_detailed(text: &str) -> Result<(Vec<u8>, CompressReport), String> {
    let entries = parse_json(text)?;
    let regions = pack_regions(&entries);

    let mut report = CompressReport::default();
    let mut flags: u8 = 0;
    let mut blocks: Vec<Vec<u8>> = Vec::with_capacity(R_COUNT);
    let names = ["meta", "名字", "颜色", "签名", "alpha", "索引"];
    for (r, raw) in regions.iter().enumerate() {
        let h_only = huffman_compress(raw);
        if r == R_META {
            report.regions.push((names[r].into(), raw.len(), raw.len(), h_only.len(), h_only.len(), false));
            blocks.push(h_only);
            continue;
        }
        let lz = lz_compress(raw);
        let h_lz = huffman_compress(&lz);
        let use_lz = h_lz.len() < h_only.len();
        if use_lz {
            flags |= 1 << (r - 1);
        }
        report.regions.push((
            names[r].into(),
            raw.len(),
            lz.len(),
            h_only.len(),
            h_lz.len(),
            use_lz,
        ));
        blocks.push(if use_lz { h_lz } else { h_only });
    }

    let mut out = Vec::with_capacity(16 + blocks.iter().map(Vec::len).sum::<usize>());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    out.push(flags);
    for b in blocks {
        out.extend_from_slice(&b);
    }
    Ok((out, report))
}

/// 解压：`.mtz` 字节 → textures.json 文本（即 `render_json` 的输出）。
///
/// 步骤：按魔数定 meta 记录长度（`MAGIC` → 8 B、`MAGIC_V5` → 7 B，都不匹配即报错）→
/// 读条目数与 flags → 从 `R_META` 起逐段 `huffman_decompress`，区域 1..=5 在 flags
/// 对应位为 1 时再叠一次 `lz_decompress` → `unpack_regions` 还原条目 → `render_json`。
///
/// 拒绝条件：长度不足 13 B、魔数不匹配、任一段 Huffman 解压失败、LZ 段解压失败、
/// 6 段读完仍有剩余字节（"文件尾部有多余数据"），以及 `unpack_regions` 的全部拒绝条件。
/// 条目数只作为循环次数使用，其与实际内容是否自洽由 `unpack_regions` 的边界检查兜住。
pub fn decompress_mtz(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() < 13 {
        return Err("非 MTZ 压缩文件".into());
    }
    let meta_len = if &bytes[0..4] == MAGIC {
        8
    } else if &bytes[0..4] == MAGIC_V5 {
        7
    } else {
        return Err("非 MTZ5/MTZ6 压缩文件".into());
    };
    let count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let flags = bytes[8];
    let mut pos = 9usize;
    let mut regions: [Vec<u8>; R_COUNT] = Default::default();
    for r in 0..R_COUNT {
        if pos >= bytes.len() {
            return Err("Huffman 块截断".into());
        }
        let (hz, consumed) = huffman_decompress(&bytes[pos..])?;
        pos += consumed;
        let region = if r == R_META {
            hz
        } else if flags & (1 << (r - 1)) != 0 {
            lz_decompress(&hz)?
        } else {
            hz
        };
        regions[r] = region;
    }
    if pos != bytes.len() {
        return Err(format!("文件尾部有多余数据: {pos} ≠ {}", bytes.len()));
    }
    let entries = unpack_regions(&regions, count, meta_len)?;
    Ok(render_json(&entries))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一条 50×23 格、3 色（2 bit 索引）、无 `G` 与 `A` 字段、opacity 255 的条目；
    /// 索引字节由 `(b * 7 + i) % 251` 生成（取值不必落在 0..=2 的调色板区间内，
    /// 本文件的往返只比较文本与容器字节，不查调色板）。
    fn sample_entry(i: usize) -> Entry {
        // MSB-first 打包：位从每字节高位写起，末字节未用到的低位清零
        let cells = 50usize * 23;
        let bits = 2usize;
        let nbytes = (cells * bits).div_ceil(8);
        let mut indices: Vec<u8> = (0..nbytes)
            .map(|b| ((b * 7 + i) % 251) as u8)
            .collect();
        if cells * bits % 8 != 0 {
            let last = indices.len() - 1;
            indices[last] &= 0xFF << (8 - (cells * bits % 8));
        }
        Entry {
            key: format!("materials/buildings/antn{i:02}"),
            w: 50,
            h: 23,
            colors: vec![[0x3C, 0x2A, 0x1E], [0xD9, 0xB0, 0x7A], [0x4A, 0x38, 0x26]],
            sig: vec![],
            alpha: None,
            indices,
            opacity: 255, // 255 达不到写出门限，render_bytecode 不写 T[ 字段
        }
    }

    /// 用 xorshift64（种子 12345）生成 200_000 字节伪随机数据，断言
    /// `lz_decompress(lz_compress(数据))` 与原始数据逐字节相等；不断言压缩率。
    #[test]
    fn lz_roundtrip_random() {
        let mut data = Vec::new();
        let mut x = 12345u64;
        for _ in 0..200_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            data.push((x >> 33) as u8);
        }
        let c = lz_compress(&data);
        assert_eq!(lz_decompress(&c).unwrap(), data);
    }

    /// 数据 = 5000 个 0x00 + `[1,2,3,4,5]` + 300 个 0x07（共 5305 B），断言两件事：
    /// 压缩后长度小于原长的三分之一，且解压结果与原始数据逐字节相等。
    #[test]
    fn lz_roundtrip_runs() {
        let mut data = Vec::new();
        data.extend(std::iter::repeat(0u8).take(5000));
        data.extend(vec![1u8, 2, 3, 4, 5]);
        data.extend(std::iter::repeat(7u8).take(300));
        let c = lz_compress(&data);
        assert!(c.len() < data.len() / 3, "长游程应大幅压缩: {} vs {}", c.len(), data.len());
        assert_eq!(lz_decompress(&c).unwrap(), data);
    }

    /// 数据 = 100_000 字节的 `(i * 3 + 128) as u8` 序列（值域同时含小于与不小于 0x80 的
    /// 字节，字面量两条分支都会走到），断言解压结果与原始数据逐字节相等。
    #[test]
    fn lz_roundtrip_high_bytes() {
        let data: Vec<u8> = (0..100_000).map(|i| (i * 3 + 128) as u8).collect();
        let c = lz_compress(&data);
        assert_eq!(lz_decompress(&c).unwrap(), data);
    }

    /// 用 5 条 `sample_entry`（`i` = 0..4）渲染 JSON，再 `compress_json` → `decompress_mtz`，
    /// 断言两件事：产物前 4 字节等于 `MAGIC`；解压出的文本与压缩前的 JSON 逐字节相等。
    #[test]
    fn json_roundtrip_byte_identical() {
        let entries: Vec<Entry> = (0..5).map(sample_entry).collect();
        let json = render_json(&entries);
        let bytes = compress_json(&json).unwrap();
        assert_eq!(&bytes[0..4], MAGIC);
        let back = decompress_mtz(&bytes).unwrap();
        assert_eq!(back, json, "解压结果必须逐字节一致");
    }

    /// 在 `sample_entry(1)` 上改成 6 色（每格索引 3 bit）、`sig = [1, 0, 2, 3]`（写进 `G`）、
    /// `alpha` 为 144 B 全 0xFF、索引 432 B 全 0xAB 且末字节未用到的低位清零；
    /// 断言 `decompress_mtz(compress_json(render_json([e])))` 与 `render_json([e])` 逐字节相等。
    #[test]
    fn json_roundtrip_with_alpha_sig() {
        let mut e = sample_entry(1);
        e.colors = vec![
            [1, 2, 3],
            [4, 5, 6],
            [7, 8, 9],
            [10, 11, 12],
            [13, 14, 15],
            [16, 17, 18],
        ]; // 6 色 → 每格索引 3 bit
        e.sig = vec![1, 0, 2, 3];
        e.alpha = Some(vec![0xFF; (50usize * 23).div_ceil(8)]);
        let mut idx = vec![0xABu8; (50usize * 23 * 3).div_ceil(8)];
        let last = idx.len() - 1;
        idx[last] &= 0xFF << (8 - (50usize * 23 * 3 % 8)); // MSB-first：末字节未用到的低位清零
        e.indices = idx;
        let json = render_json(&[e]);
        let back = decompress_mtz(&compress_json(&json).unwrap()).unwrap();
        assert_eq!(back, json);
    }

    /// 三个入参都必须报错：5 B 的 `b"hello"` 与 12 B 的全零数组（都短于 `decompress_mtz`
    /// 的 13 B 下限），以及不含 `": "` 的 `parse_json("not json")`。
    #[test]
    fn reject_bad_input() {
        assert!(decompress_mtz(b"hello").is_err());
        assert!(decompress_mtz(&[0u8; 12]).is_err());
        assert!(parse_json("not json").is_err());
    }
}
