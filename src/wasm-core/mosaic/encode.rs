//! PNG 字节 → `#mosaic v4` 纹理字节码文本（低清马赛克压缩）。
//!
//! 纯函数：入参是 PNG 字节，出参是字节码字符串，函数体内不读写文件。
//!
//! 编码五步（顺序即下文代码顺序）：
//! 1. **缩放**：长边钳到 50，短边同比例取整（各不小于 1）。缩放系数取
//!    `min(50 / 长边, 1)`，因此原图长边不超过 50 时不会放大。
//! 2. **降采样**：每格做盒式平均，但只累加 `alpha ≥ 128` 的像素；一格内一个都没有
//!    则记 `vis = false`（不可见格），其格色保持 `(0,0,0)`，还原时由透明掩码丢弃。
//!    同时记下可见格的格内平均 alpha，供第 5 步的全局系数使用。
//! 3. **调色板**：按 `通道 >> 2` 建 18bit 键、共 `64³` 个桶的直方图（只统计可见格），
//!    按格数降序、同数按桶键升序取前 8 桶，桶色取桶内各通道均值；再对可见格按
//!    平方欧氏距离做最近色重映射。
//! 4. **打包**：格索引按 `MSB-first` 行主序位打包；1 色 0 bit、2~4 色 2 bit、
//!    5~8 色 3 bit。透明掩码每格 1 bit，`bit = 1` 表示该格不可见。
//! 5. **编码**：base64url（无 `=` 填充）。
//!
//! 输出格式：`#mosaic v4\n` + `B[名字:宽x高]C[调色板]`，按需追加
//! `T[全局不透明度]` / `A[透明掩码]` / `R[索引]`，末尾补一个换行。
//!
//! 调用方（三处，均直通本函数）：
//! - `mosaic::manifest` 的 `texture_to_code`（`src/wasm-core/mosaic/manifest.rs`），
//!   由 `build_mosaic_manifest` 逐张调用，产出整图 manifest 的 `纹理名 → 字节码` 表；
//! - `apps/game` 与 `apps/debug` 的 wasm 层导出 `mosaic_encode`；
//! - 同上两个 `crates/wasm/src/lib.rs` 的 `export_mosaic_manifest`，为模型贴图逐张调用。
//!
//! 边界：不解析 VMT/VTF、不读盘——贴图加载由调用方完成（见 `manifest` 模块）。

/// base64url 字母表：`A-Z`、`a-z`、`0-9` 之后接 `-`(62) 与 `_`(63)。
/// 不写 `=` 填充，还原侧 `decode::unb64` 也不要求填充。
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// 3 字节 → 4 字符的 base64url 编码，高位在前。
/// 末组不足 3 字节时按实际字节数写出 2 或 3 个字符，不补 `=`。
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

/// RGB → 6 位大写十六进制（无 `0x` / `#` 前缀），与 `decode::parse_hex` 对称。
fn hex(c: [u8; 3]) -> String {
    format!("{:02X}{:02X}{:02X}", c[0], c[1], c[2])
}

/// PNG 字节 → `#mosaic v4` 字节码文本。
///
/// 仅当 `image::load_from_memory` 无法识别入参时报 `Err`（错误串以「打开图片失败」开头）；
/// 之后全是纯计算，一律返回 `Ok`——包括全透明图（退化成单色黑调色板）。
///
/// `name` 原样写进 `B[` 条目的名字段。还原侧 `decode::code_to_img` 会解析出它，随后即丢弃
/// （该函数末尾 `let _ = name;`），因此它只影响文本内容，不影响还原结果。
///
/// 输出可被 `decode::code_to_img` 还原；字段顺序与尾部换行同 `mosaic::mtz` 内联的
/// `render_bytecode`（详见函数末尾注释）。
pub fn img_to_code(png: &[u8], name: &str) -> Result<String, String> {
    let img = image::load_from_memory(png)
        .map_err(|e| format!("打开图片失败: {e}"))?
        .to_rgba8();
    let (tw, th) = (img.width(), img.height());

    // 缩放：长边压到 50，短边同比取整；sc ≤ 1 故只缩不放，两轴各保底 1 格
    let max = 50u32;
    let sc = (max as f64 / tw.max(th) as f64).min(1.0);
    let gw = ((tw as f64 * sc).round() as u32).max(1);
    let gh = ((th as f64 * sc).round() as u32).max(1);
    let n = (gw * gh) as usize;

    // 盒式降采样：格色只累加 alpha ≥ 128 的像素，格 alpha 取其均值；
    // 一格内无此类像素则 vis=false（不可见格），格色留 (0,0,0) 由透明掩码丢弃
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

    // 调色板：6bit/通道直方图（键 18bit，共 64³ 桶）→ 按格数降序、同数按桶键升序取前 8 桶
    // → 桶色取桶内各通道均值（质心）→ 可见格逐格最近色重映射（平方欧氏距离）
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
    // 全图一个可见格都没有时退化为单色黑调色板（bits=0，不写 R[）
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

    // 索引位打包：每格 bits 位、高位在前、按行主序连续排布，位流再按 MSB-first 分字节；
    // bits=0（单色调色板）时整段跳过，还原侧索引恒为 0
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

    // 透明掩码：每格 1 bit，bit=1 表示不可见（还原时 alpha=0）；整段全 0 时省略该字段
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

    // 全局不透明度：C[ 只有 RGB、A[ 只有 0/1，两者都无法表达半透明。这里取全体可见格
    // 格 alpha 的均值作全局系数，还原时赋给所有不透明格（见 decode::code_to_img）。
    // 可见格的格 alpha 由 alpha ≥ 128 的像素求均值而来，故必 ≥128；写出门限为 < 250，
    // 即实际写出的值落在 128..=249；缺该字段时还原侧按 255 处理。
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

    // 输出字节码：字段顺序 B → C → T → A → R。
    // src/wasm-core/mosaic/mtz.rs 的 render_bytecode 用同一套字段顺序与尾部换行，
    // 差别是它多一个 G[签名]（插在 T 与 A 之间），本函数不产出该字段。
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
    // 尾换行是格式的一部分（不是排版）：mtz 侧的 render_bytecode 同样以换行收尾
    Ok(format!("#mosaic v4\n{line}\n"))
}
