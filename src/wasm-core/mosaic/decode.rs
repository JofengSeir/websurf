//! 纹理字节码 → 图片(PNG 字节)（低清晰度还原）。
//!
//! 提取自 materials-mini/code2img.rs，main 逻辑函数化（返回 PNG 字节而非写文件）。
//! 还原流程：解析字节码 → 查自取样板 → 拼装 w×h 网格 → 最近邻放大（默认 ×8）→ PNG。

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
/// 输出尺寸对齐 **2 次幂**：网格长边 × scale 向上取 2 次幂（如 50×8=400 → 512）。
/// 非 2 次幂纹理在 WebGL1（或 NPOT 受限环境）会被 three.js `floorPowerOfTwo`
/// 钳到较小 2 次幂（400→256 = 常见 512 原纹理的一半）→ UV 0..1 内 Repeat 采样
/// 出现 2×2 周期（"田字分隔"）并破坏 mipmap/边缘拼接。对齐后与任意原纹理
/// 尺寸兼容（512/1024/256），不再触发 NPOT 钳制。
pub fn code_to_img(code: &str, scale: u32) -> Result<Vec<u8>, String> {
    let scale = if scale == 0 { 8 } else { scale };
    let line = code
        .lines()
        .find(|l| l.starts_with("B["))
        .ok_or_else(|| "未找到 B[ 条目行".to_string())?;

    // 逐字段解析（字段以 ] 分隔，内容内不含 ]）
    let (mut name, mut w, mut h) = (String::new(), 0u32, 0u32);
    let mut colors: Vec<[u8; 3]> = Vec::new();
    let mut alpha: Option<Vec<u8>> = None;
    let mut packed: Option<Vec<u8>> = None;
    // 半透明系数（T[opacity]，向后兼容扩展：无此字段 = 255）
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

    // 位宽与索引解包（MSB-first 行主序）
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

    // 拼装 w×h 网格（查表填格 + 叠 alpha 掩码；不透明格 alpha = 半透明系数 opacity）
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

    // 放大并对齐 2 次幂（防 NPOT 钳制 → "田字分隔"）：长边以 scale 为基准向上取
    // 2 次幂；短边按同比例放大后独立对齐 2 次幂（比例偏差 ≤1 格，马赛克低清无感）
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
    let _ = name;
    Ok(out)
}
