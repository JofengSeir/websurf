//! VTF（Valve Texture Format）解析与解码 + 最小 PNG 写入器。
//!
//! 支持 VTF v7.x。实测 CS:GO 地图（surf_666）PAKFILE 内 VTF 存在两种数据布局，
//! 解码器自动探测：
//! - **标准布局**：头(80) + 低清数据(可选，4B size 前缀或直接数据) + 高分辨率
//!   [frame][face][mip] 缩略图目录（{offset,size} 对）+ 高清数据（mip0 在前）
//! - **实测布局（surf_666/vtex 产物）**：头(80) + 低清数据(无 size 前缀) + 高清数据
//!   **mip 降序**（最小 mip 在前，mip0 止于文件末尾），**无缩略图目录**
//!   —— 目录缺失时按「mip0 止于 EOF、逐级向前反推」定位。
//!
//! 解码 mip0（全分辨率）帧 0 面 0，支持格式：
//! - DXT1 / DXT1_ONEBITALPHA（BC1）、DXT3（BC2）、DXT5（BC3）
//! - RGBA8888 / ABGR8888 / ARGB8888 / BGRA8888 / BGRX8888 / RGB888 / BGR888 / RGB565 / I8 / IA88 / A8
//! - 其余格式返回 Err（上层转存原始 .vtf 并在 manifest 标注）。
use flate2::write::ZlibEncoder;
use flate2::Compression;
use std::io::Write;

// Valve IMAGE_FORMAT 枚举（bitmap/imageformat.h，VTF high-res format 字段取值）
const IMG_RGBA8888: u32 = 0;
const IMG_ABGR8888: u32 = 1;
const IMG_RGB888: u32 = 2;
const IMG_BGR888: u32 = 3;
const IMG_RGB565: u32 = 4;
const IMG_I8: u32 = 5;
const IMG_IA88: u32 = 6;
const IMG_A8: u32 = 8;
const IMG_ARGB8888: u32 = 11;
const IMG_BGRA8888: u32 = 12;
const IMG_DXT1: u32 = 13;
const IMG_DXT3: u32 = 14;
const IMG_DXT5: u32 = 15;
const IMG_BGRX8888: u32 = 16;
const IMG_DXT1_ONEBITALPHA: u32 = 18;

const IMG_NONE: u32 = 0xFFFF_FFFF;

fn u16le(d: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(d[off..off + 2].try_into().unwrap())
}
fn u32le(d: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(d[off..off + 4].try_into().unwrap())
}

/// VTF 元数据（解码成功时）。
#[derive(Debug, Clone)]
pub struct VtfInfo {
    pub width: u32,
    pub height: u32,
    pub format: u32,
    pub format_name: String,
}

/// 格式名（manifest 展示用）。
pub fn format_name(fmt: u32) -> &'static str {
    match fmt {
        IMG_RGBA8888 => "RGBA8888",
        IMG_ABGR8888 => "ABGR8888",
        IMG_RGB888 => "RGB888",
        IMG_BGR888 => "BGR888",
        IMG_RGB565 => "RGB565",
        IMG_I8 => "I8",
        IMG_IA88 => "IA88",
        IMG_A8 => "A8",
        IMG_ARGB8888 => "ARGB8888",
        IMG_BGRA8888 => "BGRA8888",
        IMG_DXT1 => "DXT1",
        IMG_DXT3 => "DXT3",
        IMG_DXT5 => "DXT5",
        IMG_BGRX8888 => "BGRX8888",
        IMG_DXT1_ONEBITALPHA => "DXT1_ONEBITALPHA",
        _ => "UNKNOWN",
    }
}

/// 某格式单 mip 的数据字节数（常见格式；未知格式返回 None）。
fn format_mip_size(fmt: u32, w: u32, h: u32) -> Option<usize> {
    let w = w.max(1) as usize;
    let h = h.max(1) as usize;
    Some(match fmt {
        IMG_DXT1 | IMG_DXT1_ONEBITALPHA => w.div_ceil(4) * h.div_ceil(4) * 8,
        IMG_DXT3 | IMG_DXT5 => w.div_ceil(4) * h.div_ceil(4) * 16,
        IMG_RGBA8888 | IMG_ABGR8888 | IMG_ARGB8888 | IMG_BGRA8888 | IMG_BGRX8888 => w * h * 4,
        IMG_RGB888 | IMG_BGR888 => w * h * 3,
        IMG_RGB565 => w * h * 2,
        IMG_I8 | IMG_A8 => w * h,
        IMG_IA88 => w * h * 2,
        _ => return None,
    })
}

/// mip 尺寸序列（mip0 最大 → 最小，共 mip_count 级）。
fn mip_sizes(fmt: u32, w: u32, h: u32, mip_count: u8) -> Option<Vec<usize>> {
    let mut sizes = Vec::with_capacity(mip_count.max(1) as usize);
    let mut cw = w;
    let mut ch = h;
    for _ in 0..mip_count.max(1) {
        sizes.push(format_mip_size(fmt, cw, ch)?);
        cw = (cw / 2).max(1);
        ch = (ch / 2).max(1);
    }
    Some(sizes)
}

/// 探测低清数据区：返回（低清数据字节数, 目录候选偏移）。
/// 兼容两种写法：4B size 前缀（size 字段与按尺寸计算一致时）或直接数据（无前缀）。
fn probe_lowres(
    data: &[u8],
    header_size: usize,
    low_fmt: u32,
    low_w: u32,
    low_h: u32,
) -> (usize, usize) {
    let Some(calc) = format_mip_size(low_fmt, low_w, low_h) else {
        return (0, header_size);
    };
    // 无前缀：数据直接从 header_size 开始
    let no_prefix_dir = header_size + calc;
    // 有前缀：4B size + 数据
    if header_size + 4 <= data.len() {
        let declared = u32le(data, header_size) as usize;
        let with_prefix_dir = header_size + 4 + declared;
        if declared == calc && with_prefix_dir <= data.len() {
            // size 字段与计算一致 → 认为有前缀
            return (4 + calc, with_prefix_dir);
        }
    }
    (calc, no_prefix_dir)
}

/// 解析 VTF 头，返回（元数据, mip0 数据切片）。
fn parse_header(data: &[u8]) -> Result<(VtfInfo, &[u8]), String> {
    if data.len() < 80 || &data[0..4] != b"VTF\0" {
        return Err("不是 VTF 文件（签名缺失）".into());
    }
    let header_size = u32le(data, 12) as usize;
    let width = u16le(data, 16) as u32;
    let height = u16le(data, 18) as u32;
    let frames = u16le(data, 24);
    let high_format = u32le(data, 52);
    let mip_count = data[56];
    let low_format = u32le(data, 57);
    let low_w = data[61] as u32;
    let low_h = data[62] as u32;
    let depth = u16le(data, 63);

    // 宽高上限校验:恶意头 65535×65535 RGBA → ~17GB 分配(OOM abort);
    // Source 实际材质 ≤ 4096×4096,超限直接拒绝
    const MAX_TEX_DIM: u32 = 4096;
    if width == 0 || height == 0 || width > MAX_TEX_DIM || height > MAX_TEX_DIM {
        return Err(format!("VTF 尺寸非法:{width}x{height}(上限 {MAX_TEX_DIM})"));
    }

    let header_size = header_size.max(80);
    if header_size > data.len() {
        return Err(format!("VTF 头大小越界:{header_size}"));
    }

    let (_, dir_candidate) = if low_format != IMG_NONE && low_format != 37 && low_w > 0 && low_h > 0
    {
        probe_lowres(data, header_size, low_format, low_w, low_h)
    } else {
        (0, header_size)
    };

    // 期望的 mip 尺寸序列
    let expected = mip_sizes(high_format, width, height, mip_count)
        .ok_or_else(|| format!("不支持格式 {}", format_name(high_format)))?;
    let total_mip: usize = expected.iter().sum();

    // faces（cubemap=6 罕见；3D 纹理 depth>1）
    let faces = if depth > 1 { depth as usize } else { 1 };
    let entries = frames as usize * faces * expected.len();

    // ---- 模式 1：标准布局（缩略图目录有效）----
    if dir_candidate + entries * 8 <= data.len() {
        let mut ok = true;
        let mut dir_offsets = Vec::with_capacity(entries);
        for i in 0..entries {
            let e = &data[dir_candidate + i * 8..dir_candidate + i * 8 + 8];
            let (off, size) = (u32le(e, 0) as usize, u32le(e, 4) as usize);
            dir_offsets.push((off, size));
            if off + size > data.len() {
                ok = false;
                break;
            }
        }
        // 校验：首项尺寸 == mip0 尺寸（或 == 末项，若目录 mip 降序）
        if ok {
            let first = dir_offsets[0].1;
            let last = dir_offsets[entries - 1].1;
            let mip0_size = expected[0];
            if first == mip0_size || last == mip0_size {
                // 按 mip0 尺寸定位（目录顺序 = mip0 在前或 mip0 在后均可）
                let mip0_entry = if first == mip0_size {
                    dir_offsets[0]
                } else {
                    dir_offsets[entries - 1]
                };
                let (off, size) = mip0_entry;
                if off + size <= data.len() {
                    let info = VtfInfo {
                        width,
                        height,
                        format: high_format,
                        format_name: format_name(high_format).to_string(),
                    };
                    return Ok((info, &data[off..off + size]));
                }
            }
        }
    }

    // ---- 模式 2：实测布局（无目录；mip 降序，mip0 止于文件末尾）----
    if total_mip <= data.len() {
        let mip0_size = expected[0];
        let off = data.len() - mip0_size;
        let info = VtfInfo {
            width,
            height,
            format: high_format,
            format_name: format_name(high_format).to_string(),
        };
        return Ok((info, &data[off..off + mip0_size]));
    }

    Err(format!(
        "VTF 数据布局无法识别（len={} 目录@{} entries={}）",
        data.len(),
        dir_candidate,
        entries
    ))
}

/// 解码 VTF 为 RGBA8888（mip0，帧 0，面 0）。
pub fn decode_vtf(data: &[u8]) -> Result<(VtfInfo, Vec<u8>), String> {
    let (info, raw) = parse_header(data)?;
    let w = info.width as usize;
    let h = info.height as usize;
    let mut rgba = vec![0u8; w * h * 4];

    match info.format {
        IMG_DXT1 | IMG_DXT1_ONEBITALPHA => {
            let expect = w.div_ceil(4) * h.div_ceil(4) * 8;
            if raw.len() < expect {
                return Err(format!("DXT1 数据不足:{} < {}", raw.len(), expect));
            }
            decode_bc1(raw, w, h, &mut rgba);
        }
        IMG_DXT3 => {
            let expect = w.div_ceil(4) * h.div_ceil(4) * 16;
            if raw.len() < expect {
                return Err(format!("DXT3 数据不足:{} < {}", raw.len(), expect));
            }
            decode_bc2(raw, w, h, &mut rgba);
        }
        IMG_DXT5 => {
            let expect = w.div_ceil(4) * h.div_ceil(4) * 16;
            if raw.len() < expect {
                return Err(format!("DXT5 数据不足:{} < {}", raw.len(), expect));
            }
            decode_bc3(raw, w, h, &mut rgba);
        }
        IMG_RGBA8888 => {
            if raw.len() < w * h * 4 {
                return Err("RGBA8888 数据不足".into());
            }
            rgba.copy_from_slice(&raw[..w * h * 4]);
        }
        IMG_ABGR8888 => {
            // 内存序 A,B,G,R → RGBA = [R,G,B,A] = bytes[3,2,1,0]
            if raw.len() < w * h * 4 {
                return Err("ABGR8888 数据不足".into());
            }
            for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
                let b = &raw[i * 4..i * 4 + 4];
                px.copy_from_slice(&[b[3], b[2], b[1], b[0]]);
            }
        }
        IMG_ARGB8888 => {
            if raw.len() < w * h * 4 {
                return Err("ARGB8888 数据不足".into());
            }
            for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
                let b = &raw[i * 4..i * 4 + 4];
                px.copy_from_slice(&[b[1], b[2], b[3], b[0]]);
            }
        }
        IMG_BGRA8888 => {
            if raw.len() < w * h * 4 {
                return Err("BGRA8888 数据不足".into());
            }
            for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
                let b = &raw[i * 4..i * 4 + 4];
                px.copy_from_slice(&[b[2], b[1], b[0], b[3]]);
            }
        }
        IMG_BGRX8888 => {
            if raw.len() < w * h * 4 {
                return Err("BGRX8888 数据不足".into());
            }
            for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
                let b = &raw[i * 4..i * 4 + 4];
                px.copy_from_slice(&[b[2], b[1], b[0], 255]);
            }
        }
        IMG_RGB888 => {
            // 内存序 B,G,R → RGB = [R,G,B] = bytes[2,1,0]
            if raw.len() < w * h * 3 {
                return Err("RGB888 数据不足".into());
            }
            for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
                let b = &raw[i * 3..i * 3 + 3];
                px.copy_from_slice(&[b[2], b[1], b[0], 255]);
            }
        }
        IMG_BGR888 => {
            if raw.len() < w * h * 3 {
                return Err("BGR888 数据不足".into());
            }
            for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
                let b = &raw[i * 3..i * 3 + 3];
                px.copy_from_slice(&[b[0], b[1], b[2], 255]);
            }
        }
        IMG_RGB565 => {
            if raw.len() < w * h * 2 {
                return Err("RGB565 数据不足".into());
            }
            for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
                let c = u16::from_le_bytes(raw[i * 2..i * 2 + 2].try_into().unwrap());
                px.copy_from_slice(&[
                    ((c >> 11) as u8) << 3 | ((c >> 13) as u8),
                    ((c >> 5) as u8) << 2 | ((c >> 7) as u8 & 3),
                    (c as u8) << 3 | ((c >> 2) as u8 & 7),
                    255,
                ]);
            }
        }
        IMG_I8 => {
            if raw.len() < w * h {
                return Err("I8 数据不足".into());
            }
            for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
                let g = raw[i];
                px.copy_from_slice(&[g, g, g, 255]);
            }
        }
        IMG_IA88 => {
            // 每像素 2 字节 [I(灰度), A(alpha)]
            if raw.len() < w * h * 2 {
                return Err("IA88 数据不足".into());
            }
            for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
                px.copy_from_slice(&[raw[i * 2], raw[i * 2], raw[i * 2], raw[i * 2 + 1]]);
            }
        }
        IMG_A8 => {
            if raw.len() < w * h {
                return Err("A8 数据不足".into());
            }
            for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
                px.copy_from_slice(&[255, 255, 255, raw[i]]);
            }
        }
        other => {
            return Err(format!("不支持格式 {}", format_name(other)));
        }
    }
    Ok((info, rgba))
}

/// RGB565 → (r,g,b)。
#[inline]
fn rgb565(c: u16) -> (u8, u8, u8) {
    (
        ((c >> 11) as u8) << 3 | ((c >> 13) as u8),
        ((c >> 5) as u8) << 2 | ((c >> 7) as u8 & 3),
        (c as u8) << 3 | ((c >> 2) as u8 & 7),
    )
}

/// BC1（DXT1）颜色调色板 + 2bit 索引 → 4×4 块。
fn decode_bc1_color(block: &[u8], out: &mut [u8; 64]) {
    let c0 = u16::from_le_bytes(block[0..2].try_into().unwrap());
    let c1 = u16::from_le_bytes(block[2..4].try_into().unwrap());
    let bits = u32::from_le_bytes(block[4..8].try_into().unwrap());
    let (r0, g0, b0) = rgb565(c0);
    let (r1, g1, b1) = rgb565(c1);
    // c0 > c1 → 4 色模式；否则 3 色模式（第 4 色 = 透明黑）
    let mode4 = c0 > c1;
    let pal: [[u8; 4]; 4] = if mode4 {
        [
            [r0, g0, b0, 255],
            [r1, g1, b1, 255],
            [
                ((2 * r0 as u32 + r1 as u32) / 3) as u8,
                ((2 * g0 as u32 + g1 as u32) / 3) as u8,
                ((2 * b0 as u32 + b1 as u32) / 3) as u8,
                255,
            ],
            [
                ((r0 as u32 + 2 * r1 as u32) / 3) as u8,
                ((g0 as u32 + 2 * g1 as u32) / 3) as u8,
                ((b0 as u32 + 2 * b1 as u32) / 3) as u8,
                255,
            ],
        ]
    } else {
        [
            [r0, g0, b0, 255],
            [r1, g1, b1, 255],
            [
                ((r0 as u32 + r1 as u32) / 2) as u8,
                ((g0 as u32 + g1 as u32) / 2) as u8,
                ((b0 as u32 + b1 as u32) / 2) as u8,
                255,
            ],
            [0, 0, 0, 0],
        ]
    };
    for i in 0..16 {
        let idx = ((bits >> (i * 2)) & 3) as usize;
        out[i * 4..i * 4 + 4].copy_from_slice(&pal[idx]);
    }
}

/// BC1 解码（DXT1 / DXT1_ONEBITALPHA；ONEBITALPHA 与 DXT1 块布局相同，透明位在颜色字内）。
fn decode_bc1(raw: &[u8], w: usize, h: usize, rgba: &mut [u8]) {
    for by in 0..h.div_ceil(4) {
        for bx in 0..w.div_ceil(4) {
            let block = &raw[(by * w.div_ceil(4) + bx) * 8..];
            let mut px = [0u8; 64];
            decode_bc1_color(block, &mut px);
            for py in 0..4 {
                for pxx in 0..4 {
                    let x = bx * 4 + pxx;
                    let y = by * 4 + py;
                    if x < w && y < h {
                        let dst = (y * w + x) * 4;
                        rgba[dst..dst + 4]
                            .copy_from_slice(&px[(py * 4 + pxx) * 4..(py * 4 + pxx) * 4 + 4]);
                    }
                }
            }
        }
    }
}

/// BC2（DXT3）：8B alpha（每像素 4bit）+ 8B 颜色（BC1 4 色模式）。
fn decode_bc2(raw: &[u8], w: usize, h: usize, rgba: &mut [u8]) {
    for by in 0..h.div_ceil(4) {
        for bx in 0..w.div_ceil(4) {
            let block = &raw[(by * w.div_ceil(4) + bx) * 16..];
            let mut px = [0u8; 64];
            decode_bc1_color(&block[8..16], &mut px);
            // alpha 高 4 位（每像素 4bit，行内先低位）
            for i in 0..16 {
                let byte = block[i / 2];
                let nib = if i % 2 == 0 { byte & 0x0F } else { byte >> 4 };
                px[i * 4 + 3] = nib << 4 | nib;
            }
            write_block(&px, bx, by, w, h, rgba);
        }
    }
}

/// BC3（DXT5）：8B alpha（2 端点 + 6B 3bit 索引）+ 8B 颜色（BC1 恒 4 色模式）。
fn decode_bc3(raw: &[u8], w: usize, h: usize, rgba: &mut [u8]) {
    for by in 0..h.div_ceil(4) {
        for bx in 0..w.div_ceil(4) {
            let block = &raw[(by * w.div_ceil(4) + bx) * 16..];
            let mut px = [0u8; 64];
            decode_bc1_color(&block[8..16], &mut px);

            let a0 = block[0];
            let a1 = block[1];
            let abits = u64::from_le_bytes([
                block[2], block[3], block[4], block[5], block[6], block[7], 0, 0,
            ]);
            // alpha 调色板：8 项（a0>a1 → 8 色模式 /8；a0<=a1 → 6 色模式 /6 + 0/255）
            let mut apal = [[0u8; 4]; 8];
            apal[0] = [0, 0, 0, a0];
            apal[1] = [0, 0, 0, a1];
            if a0 > a1 {
                for (k, entry) in apal.iter_mut().enumerate().take(7).skip(1) {
                    entry[3] = (((8 - k) as u32 * a0 as u32 + k as u32 * a1 as u32) / 8) as u8;
                }
            } else {
                for (k, entry) in apal.iter_mut().enumerate().take(5).skip(1) {
                    entry[3] = (((6 - k) as u32 * a0 as u32 + k as u32 * a1 as u32) / 6) as u8;
                }
                apal[6][3] = 0;
                apal[7][3] = 255;
            }
            for i in 0..16 {
                let idx = ((abits >> (i * 3)) & 7) as usize;
                px[i * 4 + 3] = apal[idx][3];
            }
            write_block(&px, bx, by, w, h, rgba);
        }
    }
}

/// 4×4 块写入目标 RGBA（裁剪边缘）。
fn write_block(px: &[u8; 64], bx: usize, by: usize, w: usize, h: usize, rgba: &mut [u8]) {
    for py in 0..4 {
        for pxx in 0..4 {
            let x = bx * 4 + pxx;
            let y = by * 4 + py;
            if x < w && y < h {
                let dst = (y * w + x) * 4;
                rgba[dst..dst + 4].copy_from_slice(&px[(py * 4 + pxx) * 4..(py * 4 + pxx) * 4 + 4]);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 最小 PNG 写入器（8bit RGBA，filter 0；zlib 用 flate2）
// ---------------------------------------------------------------------------

const PNG_CRC_TABLE: [u32; 256] = build_crc_table();

const fn build_crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = PNG_CRC_TABLE[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

fn png_chunk(out: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(tag);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(tag);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

/// 编码 RGBA8888 → PNG 字节。
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let w = width as usize;
    let h = height as usize;
    if rgba.len() != w * h * 4 {
        return Err(format!("RGBA 数据长度不符:{} != {}*{}*4", rgba.len(), w, h));
    }

    let mut out = Vec::new();
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);

    // IHDR：8bit / RGBA(6) / 无交错
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    png_chunk(&mut out, b"IHDR", &ihdr);

    // IDAT：每行 filter 0 + RGBA 扫描线，zlib 压缩
    let stride = w * 4;
    let mut raw = Vec::with_capacity((stride + 1) * h);
    for y in 0..h {
        raw.push(0);
        raw.extend_from_slice(&rgba[y * stride..(y + 1) * stride]);
    }
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(&raw).map_err(|e| e.to_string())?;
    let z = enc.finish().map_err(|e| e.to_string())?;
    png_chunk(&mut out, b"IDAT", &z);

    png_chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dxt1_4x4_opaque() {
        // 4×4 全白不透明块：c0=0xFFFF(白)，c1=0xFFFF，bits=0
        let mut raw = vec![0u8; 8];
        raw[0..2].copy_from_slice(&0xFFFFu16.to_le_bytes());
        raw[2..4].copy_from_slice(&0xFFFFu16.to_le_bytes());
        let mut rgba = vec![0u8; 4 * 4 * 4];
        decode_bc1(&raw, 4, 4, &mut rgba);
        assert!(rgba.chunks_exact(4).all(|p| p == [255, 255, 255, 255]));
    }

    #[test]
    fn dxt1_4x4_transparent() {
        // 3 色模式透明黑：c0=0x0000(黑)，c1=0xFFFF(白) → 第 4 色透明，bits=11 全选
        let mut raw = vec![0u8; 8];
        raw[0..2].copy_from_slice(&0x0000u16.to_le_bytes());
        raw[2..4].copy_from_slice(&0xFFFFu16.to_le_bytes());
        raw[4..8].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        let mut rgba = vec![0u8; 4 * 4 * 4];
        decode_bc1(&raw, 4, 4, &mut rgba);
        assert!(rgba.chunks_exact(4).all(|p| p[3] == 0));
    }

    #[test]
    fn png_roundtrip_header() {
        let png = encode_png(
            2,
            2,
            &[
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
            ],
        )
        .unwrap();
        assert_eq!(
            &png[0..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
        );
        // IHDR 宽高
        assert_eq!(&png[16..20], &2u32.to_be_bytes());
        assert_eq!(&png[20..24], &2u32.to_be_bytes());
        // 以 IEND 结束
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
    }

    #[test]
    fn rejects_non_vtf() {
        assert!(decode_vtf(b"not a vtf file").is_err());
    }

    #[test]
    fn rejects_huge_dimensions() {
        // 恶意 VTF 头 65535×65535 → 曾尝试 ~17GB 分配;应在解析阶段被尺寸上限拦截
        let mut data = vec![0u8; 80];
        data[0..4].copy_from_slice(b"VTF\0");
        data[12..16].copy_from_slice(&80u32.to_le_bytes()); // header_size
        data[16..18].copy_from_slice(&65535u16.to_le_bytes()); // width
        data[18..20].copy_from_slice(&65535u16.to_le_bytes()); // height
        assert!(decode_vtf(&data).is_err());
    }
}
