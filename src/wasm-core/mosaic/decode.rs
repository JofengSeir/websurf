//! `#mosaic v4` 纹理字节码 → PNG 字节（低清还原）。
//!
//! 纯函数：入参是字节码文本，出参是 PNG 字节，函数体内不读写文件。
//!
//! 还原四步：解析字段 → 拼装 宽×高 网格（查 `C[` 调色板 + 叠 `A[` 透明掩码）→
//! 最近邻放大 → `image` 编码 PNG（RGBA）。
//!
//! 调用方（三处）：
//! - `bsp_to_gltf_core::materials` 的 `fallback_texture_png`——导出期把缺失贴图的
//!   回退字节码解成 PNG 嵌进 GLB；
//! - `apps/debug` 与 `apps/game` 的 wasm 层导出 `mosaic_decode`；
//! - 两工程渲染端的 `replaceMapWithMosaic`，固定传 `scale = 8`。
//!
//! 校验范围：调色板色数（1..=8）、格数上限 100000、`R[` 与 `A[` 的字节长度。
//! 与 `mosaic::mtz` 的 `parse_bytecode` 不同，本函数不校验 `宽 ≥ 1` / `高 ≥ 1`，
//! 也不校验解出的索引是否落在调色板区间内——这两条由编码侧的不变量保证。

/// base64url 解码（不要求 `=` 填充）。逐 6 bit 累积、满 8 bit 出一字节，
/// 末尾不足 8 bit 的残余位直接丢弃。遇字母表外字符返回 `None`。
fn unb64(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut acc: u32 = 0;
    let mut nb = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a') as u32 + 26,
            b'0'..=b'9' => (c - b'0') as u32 + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        acc = (acc << 6) | v;
        nb += 6;
        if nb >= 8 {
            nb -= 8;
            out.push((acc >> nb) as u8);
            acc &= (1 << nb) - 1;
        }
    }
    Some(out)
}

/// 6 位十六进制 → RGB。先 `trim`；长度不为 6、或任两位无法按 16 进制解析都返回 `None`。
fn parse_hex(s: &str) -> Option<[u8; 3]> {
    let s = s.trim();
    if s.len() != 6 {
        return None;
    }
    Some([
        u8::from_str_radix(&s[0..2], 16).ok()?,
        u8::from_str_radix(&s[2..4], 16).ok()?,
        u8::from_str_radix(&s[4..6], 16).ok()?,
    ])
}

/// `#mosaic v4` 字节码 → PNG 字节（RGBA，最近邻放大）。
///
/// `scale` 为 0 时按 8 处理（Rust 侧没有默认参数，0 即「取默认值」的约定）。
///
/// 输出宽高一律取 **2 的幂**：长边先按 `长边 × scale` 向上取幂（下限 2），短边按同一
/// 比例缩放后再**各自独立**取幂——两轴取幂不同步，宽高比与网格存在 ≤1 格偏差。
/// 取幂后的尺寸就是 PNG 尺寸；调用方在替换 `map.image` 前会先 `dispose()`。
pub fn code_to_img(code: &str, scale: u32) -> Result<Vec<u8>, String> {
    let scale = if scale == 0 { 8 } else { scale };
    let line = code
        .lines()
        .find(|l| l.starts_with("B["))
        .ok_or_else(|| "未找到 B[ 条目行".to_string())?;

    // 逐字段扫描：先按 ']' 切开，每段再从 '[' 分成「字段名 / 值」；未识别的字段名跳过，
    // 因此字段缺失或多余都不影响解析（B/C/T/A/R 之外的扩展字段被忽略）
    let (mut name, mut w, mut h) = (String::new(), 0u32, 0u32);
    let mut colors: Vec<[u8; 3]> = Vec::new();
    let mut alpha: Option<Vec<u8>> = None;
    let mut packed: Option<Vec<u8>> = None;
    // 全局不透明度：缺 T[ 时按 255（与 encode 侧「< 250 才写」的门限互补）
    let mut opacity: u8 = 255;
    for chunk in line.split(']') {
        let Some((field, rest)) = chunk.split_once('[') else { continue };
        match field {
            "B" => {
                let (names, size) = rest.rsplit_once(':').ok_or("B 缺 WxH")?;
                let (w_s, h_s) = size.split_once('x').ok_or("尺寸应为 WxH")?;
                w = w_s.trim().parse().map_err(|_| "宽非法")?;
                h = h_s.trim().parse().map_err(|_| "高非法")?;
                name = names.split('|').next().unwrap_or("").to_string();
            }
            "C" => {
                colors = rest
                    .split(',')
                    .map(|t| parse_hex(t).ok_or_else(|| "颜色非法".to_string()))
                    .collect::<Result<Vec<_>, _>>()?;
            }
            "T" => {
                opacity = rest
                    .trim()
                    .parse::<u8>()
                    .map_err(|_| "T 数值非法".to_string())?;
            }
            "A" => alpha = Some(unb64(rest).ok_or("A base64 非法")?),
            "R" => packed = Some(unb64(rest).ok_or("R base64 非法")?),
            _ => {}
        }
    }
    if colors.is_empty() || colors.len() > 8 {
        return Err(format!("C 颜色数非法: {}", colors.len()));
    }
    let n = (w * h) as usize;
    if n > 100_000 {
        return Err(format!("网格过大: {w}x{h}"));
    }

    // 位宽由调色板色数反推（与 encode 同一张表）；缺 R[ 时索引保持全 0，
    // 即整幅取 C[ 的首色
    let bits = match colors.len() {
        1 => 0,
        2..=4 => 2,
        _ => 3,
    };
    let mut idx = vec![0u8; n];
    if let Some(p) = &packed {
        if p.len() != (n * bits).div_ceil(8) {
            return Err("R 长度不符".to_string());
        }
        let mut pos = 0usize;
        for v in idx.iter_mut() {
            for _ in 0..bits {
                *v = (*v << 1) | ((p[pos / 8] >> (7 - pos % 8)) & 1);
                pos += 1;
            }
        }
    }
    if let Some(a) = &alpha {
        if a.len() != n.div_ceil(8) {
            return Err("A 长度不符".to_string());
        }
    }

    // 拼装 宽×高 网格：色取 C[索引]，alpha 由 A[ 掩码决定——命中（bit=1）为 0，
    // 否则取全局不透明度；缺 A[ 时全格都用全局不透明度
    let mut grid = image::RgbaImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            let c = colors[idx[i] as usize];
            let a = match &alpha {
                Some(m) if (m[i / 8] >> (7 - i % 8)) & 1 == 1 => 0u8,
                _ => opacity,
            };
            grid.put_pixel(x, y, image::Rgba([c[0], c[1], c[2], a]));
        }
    }

    // 放大：长边目标 = (长边 × scale) 向上取 2 的幂（下限 2）；短边按同一比例缩放后
    // 各自独立向上取 2 的幂；两轴取幂不同步，比例偏差 ≤1 格
    let long_edge = w.max(h);
    let target = (long_edge * scale).next_power_of_two().max(2);
    let s = target as f64 / long_edge as f64;
    let gw = ((w as f64 * s).round() as u32).next_power_of_two().max(2);
    let gh = ((h as f64 * s).round() as u32).next_power_of_two().max(2);
    let mut big = image::RgbaImage::new(gw, gh);
    for y in 0..gh {
        for x in 0..gw {
            let sx = ((x as f64 / s) as u32).min(w - 1);
            let sy = ((y as f64 / s) as u32).min(h - 1);
            big.put_pixel(x, y, *grid.get_pixel(sx, sy));
        }
    }

    let mut out: Vec<u8> = Vec::new();
    image::DynamicImage::ImageRgba8(big)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("保存 PNG 失败: {e}"))?;
    // B[ 里的名字占位：本函数只还原像素，不返回名字
    let _ = name;
    Ok(out)
}
