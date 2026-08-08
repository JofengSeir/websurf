//! textures.json 压缩/解压（MTZ5 容器：字段分区 + LZ77 + Huffman）。
//! 提取自 materials-mini/src/lib.rs（纯 std，无第三方依赖）。
//! 默认配置纹理包（textures.mtz）经 decompress_mtz 还原为
//! `{ 纹理名: "#mosaic v4 ..." }` JSON，供缺失纹理比对/兜底。
/// 压缩文件魔数（MTZ5：字段分区 + 大窗口 LZ77 + 字节级 Huffman）。
/// 压缩文件魔数（MTZ6：meta 区含半透明系数 opacity，向后兼容解压 MTZ5）。
pub const MAGIC: &[u8; 4] = b"MTZ6";
/// 旧格式（meta 7 字节，无 opacity；仅解压兼容）。
pub const MAGIC_V5: &[u8; 4] = b"MTZ5";

// ---------------------------------------------------------------------------
// Huffman（字节级，全局码表）
// ---------------------------------------------------------------------------

/// 由频次表构建规范码表，返回 (码长, 规范码)。
fn huffman_codes(freq: &[u64; 256]) -> ([u8; 256], [u32; 256]) {
    let mut lens = [0u8; 256];
    let mut codes = [0u32; 256];
    // 叶子节点：(freq, 符号)；内部节点：符号位 ≥256 → children[(id-256)]
    let mut nodes: Vec<(u64, u16)> = freq
        .iter()
        .enumerate()
        .filter(|(_, &f)| f > 0)
        .map(|(i, &f)| (f, i as u16))
        .collect();
    let mut next = 256u16;
    let mut children: Vec<(u16, u16)> = Vec::new();
    while nodes.len() > 1 {
        // 取两个最小（平局按 (freq, id) 保证确定性）
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
    // 计算深度
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
            // 单符号：给 1 bit
            lens[root as usize] = 1;
        } else {
            walk(&children, root, 0, &mut lens);
        }
    }
    // 规范码
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

/// Huffman 压缩。输出：[256 码长][u32 解码长度][位流]。
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

/// Huffman 解压；返回 (解码数据, 本块消耗字节数)。
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
    // 规范解码表：按 (len, sym) 排序
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
    // 解码位流（MSB-first）
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
// LZ77
// ---------------------------------------------------------------------------

/// 匹配窗口（字节）；匹配 token 的距离高位占 4 bit → 最大距离 4096。
const WINDOW: usize = 4096;
/// 最短匹配。
const MIN_MATCH: usize = 4;
/// 3 位长度字段最大值（配合扩展字节可达 265）。
const MAX_LEN3: usize = 7;

/// 写一条匹配（len 4..=265，dist 1..=4096；len3=7 时必带扩展字节）。
/// token：bit7 标记；bits 6-4 长度（len3 = len-3）；bits 3-0 距离高位（dist_hi）；
/// 后随 1 字节距离低位；len3=7 时再随 1 字节扩展长度。
/// 注意：len3=0 保留给"转义字面量"，因此最短匹配 4 字节 → len3=1。
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

/// LZ77 压缩（2 字节哈希链 + 贪心最长匹配；链随压缩进度增量构建，仅含已扫描位置）。
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
        // 找最长匹配（仅查 < i 的已插入位置）
        let mut best_len = 0usize;
        let mut best_dist = 0usize;
        if i + 1 < n {
            let h = (((data[i] as usize) << 8) | data[i + 1] as usize) & 0xFFFF;
            let mut j = heads[h] as usize;
            let max_possible = (n - i).min(MAX_LEN3 + 258); // 最大匹配 265
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
        // 插入当前位置到哈希链（标准 LZ：每个位置都插入；跳过的位置不插入，可接受）
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
                // ≥0x80 的字面量必须转义（否则会被当成匹配标记）
                out.push(0x80);
                out.push(b);
            }
            i += 1;
        }
    }
    out
}

/// LZ77 解压。
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
                // 转义字面量（原字节 ≥0x80）
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
// base64url / hex
// ---------------------------------------------------------------------------

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

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

fn hex(c: [u8; 3]) -> String {
    format!("{:02X}{:02X}{:02X}", c[0], c[1], c[2])
}

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
// 条目（JSON 中一条 key → 字节码）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub key: String,
    pub w: u32,
    pub h: u32,
    pub colors: Vec<[u8; 3]>,
    pub sig: Vec<u8>,
    pub alpha: Option<Vec<u8>>,
    pub indices: Vec<u8>,
    /// 半透明系数（T[opacity]，MTZ6 新增；无 T 字段 = 255）。
    pub opacity: u8,
}

impl Entry {
    /// 索引位宽：1 色→0bit，2~4→2bit，5~8→3bit。
    pub fn bits(&self) -> usize {
        match self.colors.len() {
            1 => 0,
            2..=4 => 2,
            _ => 3,
        }
    }
}

/// 解析单条字节码文本（"#mosaic v4\nB[...]C[...]…\n"）。
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

/// 还原单条字节码文本（与 encode.rs img_to_code 输出一致，含 T[opacity]）。
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

/// JSON 字符串转义（与主工程 extract_all_json 输出一致）。
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

/// JSON 字符串反转义。
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

/// 解析 textures.json（保持原有条目顺序）。
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

/// 还原 textures.json（逐字节一致）。
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
// 条目 ↔ 区域（按字段类型分组，供独立 Huffman/LZ 建模）
// ---------------------------------------------------------------------------

/// 区域顺序。
const R_META: usize = 0;
const R_NAMES: usize = 1;
const R_COLORS: usize = 2;
const R_SIGS: usize = 3;
const R_ALPHAS: usize = 4;
const R_INDICES: usize = 5;
const R_COUNT: usize = 6;

/// 条目 → 6 个区域（meta 为定长小记录，其余为连续拼接）。MTZ6：meta 8 字节含 opacity。
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

/// 区域 → 条目。`meta_len` = 7（MTZ5 旧格式，无 opacity）或 8（MTZ6）。
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
// 对外接口
// ---------------------------------------------------------------------------

/// 区域是否 LZ77 前置的标志位（bit0..4 = 名字/颜色/签名/alpha/索引；meta 恒纯 Huffman）。
#[allow(dead_code)]
const FLAG_NAMES_LZ: u8 = 1 << 0;
#[allow(dead_code)]
const FLAG_COLORS_LZ: u8 = 1 << 1;
#[allow(dead_code)]
const FLAG_SIGS_LZ: u8 = 1 << 2;
#[allow(dead_code)]
const FLAG_ALPHAS_LZ: u8 = 1 << 3;
#[allow(dead_code)]
const FLAG_INDICES_LZ: u8 = 1 << 4;

/// 压缩报告（供调优观察）。
#[derive(Debug, Default)]
pub struct CompressReport {
    /// 每区 (原始, LZ77后, 纯Huffman, LZ+Huffman, 是否选了LZ)
    pub regions: Vec<(String, usize, usize, usize, usize, bool)>,
}

/// 压缩：textures.json 文本 → .mtz 字节。
/// 每区独立尝试"纯 Huffman"与"LZ77+Huffman"，取更小者写入标志位。
pub fn compress_json(text: &str) -> Result<Vec<u8>, String> {
    compress_json_detailed(text).map(|(bytes, _)| bytes)
}

/// 压缩（带报告）。
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

/// 解压：.mtz 字节 → textures.json 文本（逐字节一致）。
/// 兼容 MTZ6（meta 8 字节含 opacity）与旧 MTZ5（meta 7 字节，opacity 默认 255）。
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

    fn sample_entry(i: usize) -> Entry {
        // 索引按真实管线约定生成：MSB-first 打包，末字节填充位清零
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
        }
    }

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

    #[test]
    fn lz_roundtrip_high_bytes() {
        let data: Vec<u8> = (0..100_000).map(|i| (i * 3 + 128) as u8).collect();
        let c = lz_compress(&data);
        assert_eq!(lz_decompress(&c).unwrap(), data);
    }

    #[test]
    fn json_roundtrip_byte_identical() {
        let entries: Vec<Entry> = (0..5).map(sample_entry).collect();
        let json = render_json(&entries);
        let bytes = compress_json(&json).unwrap();
        assert_eq!(&bytes[0..4], MAGIC);
        let back = decompress_mtz(&bytes).unwrap();
        assert_eq!(back, json, "解压结果必须逐字节一致");
    }

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
        ]; // 6 色 → 3bit
        e.sig = vec![1, 0, 2, 3];
        e.alpha = Some(vec![0xFF; (50usize * 23).div_ceil(8)]);
        let mut idx = vec![0xABu8; (50usize * 23 * 3).div_ceil(8)];
        let last = idx.len() - 1;
        idx[last] &= 0xFF << (8 - (50usize * 23 * 3 % 8)); // 末字节填充位清零（MSB-first）
        e.indices = idx;
        let json = render_json(&[e]);
        let back = decompress_mtz(&compress_json(&json).unwrap()).unwrap();
        assert_eq!(back, json);
    }

    #[test]
    fn reject_bad_input() {
        assert!(decompress_mtz(b"hello").is_err());
        assert!(decompress_mtz(&[0u8; 12]).is_err());
        assert!(parse_json("not json").is_err());
    }
}
