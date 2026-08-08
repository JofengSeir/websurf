//! 图片(PNG 字节) → 纹理字节码（棋盘马赛克 DSL，v4 格式）。
//!
//! 提取自 materials-mini/img2code.rs，main 逻辑函数化（不再做文件 IO）。
//! 特性：
//! - 长宽约束：网格按原图宽高比等比缩放，长边 ≤50（短边≥1，如实表达非 1:1/1:2 比例）
//! - 自取样板：6bit/通道桶直方图取前 ≤8 色（1 色→0bit、2~4→2bit、5~8→3bit）
//! - 透明像素不污染格色；存在透明格时输出 A 掩码（1bit/格，1=透明）
//! - 索引 MSB-first 行主序位打包 → base64url

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

fn hex(c: [u8; 3]) -> String {
    format!("{:02X}{:02X}{:02X}", c[0], c[1], c[2])
}

/// PNG 字节 → `#mosaic v4` 字节码文本。
///
/// `name` 写入字节码的 B[ 条目（纹理名），还原时仅作显示/记录。
pub fn img_to_code(png: &[u8], name: &str) -> Result<String, String> {
    let img = image::load_from_memory(png)
        .map_err(|e| format!("打开图片失败: {e}"))?
        .to_rgba8();
    let (tw, th) = (img.width(), img.height());

    // 长宽约束：长边 50，短边等比取整（至少 1）
    let max = 50u32;
    let sc = (max as f64 / tw.max(th) as f64).min(1.0);
    let gw = ((tw as f64 * sc).round() as u32).max(1);
    let gh = ((th as f64 * sc).round() as u32).max(1);
    let n = (gw * gh) as usize;

    // 盒式降采样：格色只统计不透明像素（alpha≥128），全透明格标记不可见；
    // 同时统计格内不透明像素的平均 alpha（半透明材质补偿用，输出 T[opacity] 字段）
    let mut cells = vec![(0u8, 0u8, 0u8); n];
    let mut vis = vec![false; n];
    let mut cell_alpha = vec![0u8; n];
    for cy in 0..gh {
        for cx in 0..gw {
            let (x0, y0) = (cx * tw / gw, cy * th / gh);
            let x1 = (((cx + 1) * tw / gw).max(x0 + 1)).min(tw);
            let y1 = (((cy + 1) * th / gh).max(y0 + 1)).min(th);
            let (mut r, mut g, mut b, mut a, mut m) = (0u64, 0u64, 0u64, 0u64, 0u64);
            for y in y0..y1 {
                for x in x0..x1 {
                    let p = img.get_pixel(x, y);
                    if p[3] >= 128 {
                        r += p[0] as u64;
                        g += p[1] as u64;
                        b += p[2] as u64;
                        a += p[3] as u64;
                        m += 1;
                    }
                }
            }
            let i = (cy * gw + cx) as usize;
            if m > 0 {
                cells[i] = ((r / m) as u8, (g / m) as u8, (b / m) as u8);
                cell_alpha[i] = (a / m) as u8;
                vis[i] = true;
            }
        }
    }

    // 量化：6bit/通道桶直方图（质心）→ 前 ≤8 桶 → 逐格最近色重映射
    let mut hist: Vec<(u32, u64, u64, u64)> = vec![(0, 0, 0, 0); 64 * 64 * 64];
    for (i, &c) in cells.iter().enumerate() {
        if !vis[i] {
            continue;
        }
        let k = ((c.0 >> 2) as usize) << 12 | ((c.1 >> 2) as usize) << 6 | (c.2 >> 2) as usize;
        hist[k].0 += 1;
        hist[k].1 += c.0 as u64;
        hist[k].2 += c.1 as u64;
        hist[k].3 += c.2 as u64;
    }
    let mut order: Vec<usize> = (0..hist.len()).filter(|&k| hist[k].0 > 0).collect();
    order.sort_by(|&a, &b| hist[b].0.cmp(&hist[a].0).then(a.cmp(&b)));
    let colors: Vec<[u8; 3]> = if order.is_empty() {
        vec![[0, 0, 0]]
    } else {
        order[..order.len().min(8).max(1)]
            .iter()
            .map(|&b| {
                let h = hist[b];
                [(h.1 / h.0 as u64) as u8, (h.2 / h.0 as u64) as u8, (h.3 / h.0 as u64) as u8]
            })
            .collect()
    };
    let mut idx = vec![0u8; n];
    for (i, &c) in cells.iter().enumerate() {
        if !vis[i] {
            continue;
        }
        let mut best = 0usize;
        let mut bd = u32::MAX;
        for (j, col) in colors.iter().enumerate() {
            let d = ((c.0 as i32 - col[0] as i32).pow(2)
                + (c.1 as i32 - col[1] as i32).pow(2)
                + (c.2 as i32 - col[2] as i32).pow(2)) as u32;
            if d < bd {
                bd = d;
                best = j;
            }
        }
        idx[i] = best as u8;
    }

    // 索引位打包（MSB-first 行主序）
    let bits = match colors.len() {
        1 => 0,
        2..=4 => 2,
        _ => 3,
    };
    let mut packed = vec![0u8; (n * bits).div_ceil(8)];
    if bits > 0 {
        let mut pos = 0usize;
        for &v in &idx {
            for k in (0..bits).rev() {
                if (v >> k) & 1 == 1 {
                    packed[pos / 8] |= 1 << (7 - pos % 8);
                }
                pos += 1;
            }
        }
    }

    // alpha 掩码（bit=1 透明）
    let alpha: Vec<u8> = (0..n.div_ceil(8))
        .map(|i| {
            (0..8).fold(0u8, |acc, b| {
                let p = i * 8 + b;
                if p < n && !vis[p] {
                    acc | (1 << (7 - b))
                } else {
                    acc
                }
            })
        })
        .collect();

    // 半透明系数（T[opacity] 字段，向后兼容扩展）：可见格子的平均 alpha。
    // 1bit alpha 掩码只区分透明/不透明——半透明材质（玻璃等 alpha≈128）编码时
    // 会被当不透明 → 低清后全实心。此处统计全局 opacity，解码时应用到不透明格；
    // 旧解码器忽略未知字段 T[]（逐字段扫描天然兼容），旧字节码无 T 字段时默认 255。
    let opacity: u8 = {
        let mut sum = 0u64;
        let mut cnt = 0u64;
        for i in 0..n {
            if vis[i] {
                sum += cell_alpha[i] as u64;
                cnt += 1;
            }
        }
        if cnt > 0 { (sum / cnt) as u8 } else { 255 }
    };

    // 输出字节码
    let mut line = format!("B[{name}:{gw}x{gh}]C[");
    line.push_str(&colors.iter().map(|c| hex(*c)).collect::<Vec<_>>().join(","));
    line.push(']');
    if opacity < 250 {
        line.push_str(&format!("T[{opacity}]"));
    }
    if alpha.iter().any(|&b| b != 0) {
        line.push_str(&format!("A[{}]", b64(&alpha)));
    }
    if bits > 0 {
        line.push_str(&format!("R[{}]", b64(&packed)));
    }
    // 尾换行与 mtz render_bytecode 约定一致（保证 JSON 逐字节往返）
    Ok(format!("#mosaic v4\n{line}\n"))
}
