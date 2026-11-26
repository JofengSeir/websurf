//! VTF DXT1 / DXT3 / DXT5（BC1 / BC2 / BC3）压缩纹理直通模块。
//!
//! 将 VTF 中的块压缩纹理字节直接打包为紧凑的 `VDXT` 二进制载荷写入 GLB，跳过 Rust 侧
//! 全分辨率 CPU 解压与 PNG 编码，并跳过浏览器端 PNG 解码与 `generateMipmap`；同时提供
//! 无全分辨率分配的块级镂空判定（`has_alpha_holes`）与最小 mip（`>= 32px`）mosaic 缩略解码。

use crate::texture_utils::image::ImageFormat;
use image::{DynamicImage, ImageBuffer};
use texpresso::Format;

/// `VDXT` 二进制魔数。
pub const VDXT_MAGIC: &[u8; 4] = b"VDXT";
/// GLB `image.mimeType` 约定值。
pub const VDXT_MIME: &str = "application/x-vbsp-dxt";
/// 固定头部长度（字节）。
pub const VDXT_HEADER_BYTES: usize = 16;

/// `TEXTUREFLAGS_ENVMAP`（立方体贴图标志，VTF 规范 `0x4000`）。
const VTF_FLAG_ENVMAP: u32 = 0x4000;

/// 支持直通 WebGL2 S3TC 的 DXT 格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum DxtFormat {
    Dxt1 = 1,
    Dxt1OneBitAlpha = 2,
    Dxt3 = 3,
    Dxt5 = 5,
}

impl DxtFormat {
    /// 每个 4×4 压缩块的字节数（BC1 = 8，BC2/BC3 = 16）。
    #[inline]
    pub fn block_bytes(self) -> usize {
        match self {
            DxtFormat::Dxt1 | DxtFormat::Dxt1OneBitAlpha => 8,
            DxtFormat::Dxt3 | DxtFormat::Dxt5 => 16,
        }
    }

    /// 指定宽高的单层 mip 字节数。
    #[inline]
    pub fn mip_byte_size(self, w: u32, h: u32) -> usize {
        let bx = (w.max(1) + 3) / 4;
        let by = (h.max(1) + 3) / 4;
        (bx as usize) * (by as usize) * self.block_bytes()
    }

    fn from_vtf(fmt: ImageFormat) -> Option<Self> {
        match fmt {
            ImageFormat::Dxt1 => Some(DxtFormat::Dxt1),
            ImageFormat::Dxt1Onebitalpha => Some(DxtFormat::Dxt1OneBitAlpha),
            ImageFormat::Dxt3 => Some(DxtFormat::Dxt3),
            ImageFormat::Dxt5 => Some(DxtFormat::Dxt5),
            _ => None,
        }
    }

    fn texpresso_format(self) -> Format {
        match self {
            DxtFormat::Dxt1 | DxtFormat::Dxt1OneBitAlpha => Format::Bc1,
            DxtFormat::Dxt3 => Format::Bc2,
            DxtFormat::Dxt5 => Format::Bc3,
        }
    }
}

/// 已校验的 VTF DXT 压缩纹理（按 mip 0 .. mip_count - 1 存储）。
#[derive(Debug, Clone)]
pub struct DxtTexture {
    pub width: u16,
    pub height: u16,
    pub format: DxtFormat,
    pub mips: Vec<Vec<u8>>,
}

impl DxtTexture {
    /// 序列化为 16 字节 `VDXT` 头 + 连续 mip 载荷。
    pub fn to_vdxt_bytes(&self) -> Vec<u8> {
        let payload_len: usize = self.mips.iter().map(|m| m.len()).sum();
        let mut out = Vec::with_capacity(VDXT_HEADER_BYTES + payload_len);
        out.extend_from_slice(VDXT_MAGIC);
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
        out.push(self.format as u8);
        out.push(self.mips.len() as u8);
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u32.to_le_bytes()); // reserved
        for mip in &self.mips {
            out.extend_from_slice(mip);
        }
        out
    }

    /// 直接检查 mip 0 的原始 BC 块是否含真实镂空（`alpha < 32` 像素占比 >= 1%）。
    ///
    /// 与 `gltf_builder::texture_has_alpha_holes` 语义一致：
    /// `Dxt1` 无 alpha 通道恒返回 `false`；`Dxt1OneBitAlpha` / `Dxt3` / `Dxt5` 逐块统计
    /// `alpha < 32` 的像素占比，避免分配整张 RGBA8 解压缓冲。
    pub fn has_alpha_holes(&self) -> bool {
        const HOLE_ALPHA: u8 = 32;
        const MIN_RATIO: f32 = 0.01;

        if self.format == DxtFormat::Dxt1 {
            return false;
        }
        let Some(mip0) = self.mips.first() else {
            return false;
        };
        let w = self.width as usize;
        let h = self.height as usize;
        let total = w * h;
        if total == 0 {
            return false;
        }
        let bx = (w + 3) / 4;
        let by = (h + 3) / 4;
        let bsize = self.format.block_bytes();
        if mip0.len() < bx * by * bsize {
            return false;
        }

        let mut holes = 0usize;
        for gy in 0..by {
            let py_limit = (h - gy * 4).min(4);
            for gx in 0..bx {
                let px_limit = (w - gx * 4).min(4);
                let blk = &mip0[(gy * bx + gx) * bsize..];
                match self.format {
                    DxtFormat::Dxt1 => {}
                    DxtFormat::Dxt1OneBitAlpha => {
                        let c0 = u16::from_le_bytes([blk[0], blk[1]]);
                        let c1 = u16::from_le_bytes([blk[2], blk[3]]);
                        if c0 <= c1 {
                            let bits = u32::from_le_bytes([blk[4], blk[5], blk[6], blk[7]]);
                            for py in 0..py_limit {
                                for px in 0..px_limit {
                                    let idx = py * 4 + px;
                                    if ((bits >> (idx * 2)) & 3) == 3 {
                                        holes += 1;
                                    }
                                }
                            }
                        }
                    }
                    DxtFormat::Dxt3 => {
                        for py in 0..py_limit {
                            let row_lo = blk[py * 2];
                            let row_hi = blk[py * 2 + 1];
                            let row16 = (row_lo as u16) | ((row_hi as u16) << 8);
                            for px in 0..px_limit {
                                let a4 = ((row16 >> (px * 4)) & 0xF) as u8;
                                if a4 * 17 < HOLE_ALPHA {
                                    holes += 1;
                                }
                            }
                        }
                    }
                    DxtFormat::Dxt5 => {
                        let a0 = blk[0];
                        let a1 = blk[1];
                        let mut pal = [0u8; 8];
                        pal[0] = a0;
                        pal[1] = a1;
                        if a0 > a1 {
                            for k in 1..=6u16 {
                                pal[(k + 1) as usize] =
                                    (((7 - k) * a0 as u16 + k * a1 as u16 + 3) / 7) as u8;
                            }
                        } else {
                            for k in 1..=4u16 {
                                pal[(k + 1) as usize] =
                                    (((5 - k) * a0 as u16 + k * a1 as u16 + 2) / 5) as u8;
                            }
                            pal[6] = 0;
                            pal[7] = 255;
                        }
                        let mut idx_bits = 0u64;
                        for i in 0..6 {
                            idx_bits |= (blk[2 + i] as u64) << (i * 8);
                        }
                        for py in 0..py_limit {
                            for px in 0..px_limit {
                                let shift = (py * 4 + px) * 3;
                                let code = ((idx_bits >> shift) & 7) as usize;
                                if pal[code] < HOLE_ALPHA {
                                    holes += 1;
                                }
                            }
                        }
                    }
                }
            }
        }

        holes as f32 >= total as f32 * MIN_RATIO
    }

    /// 解码用于 mosaic 缩略码的最小够用 mip（长边 `>= 32px` 的最小层，若无则取 mip 0）。
    ///
    /// mosaic 目标尺寸 <= 50px，只解 32×32 或 64×64 层比全分辨率 512²/1024² 快 64×–256×。
    pub fn decode_mip_for_mosaic(&self) -> Option<DynamicImage> {
        if self.mips.is_empty() {
            return None;
        }
        let mut chosen = 0usize;
        for (m, _) in self.mips.iter().enumerate() {
            let mw = (self.width as u32 >> m).max(1);
            let mh = (self.height as u32 >> m).max(1);
            if mw.max(mh) >= 32 {
                chosen = m;
            } else {
                break;
            }
        }
        let mw = (self.width as u32 >> chosen).max(1);
        let mh = (self.height as u32 >> chosen).max(1);
        let mip_bytes = &self.mips[chosen];
        let mut rgba = vec![0u8; (mw as usize) * (mh as usize) * 4];
        self.format
            .texpresso_format()
            .decompress(mip_bytes, mw as usize, mh as usize, &mut rgba);
        ImageBuffer::from_raw(mw, mh, rgba).map(DynamicImage::ImageRgba8)
    }
}

/// 从 VTF 原始字节直通提取 DXT1/DXT3/DXT5 压缩纹理。
///
/// 不满足 WebGL2 S3TC 直通条件（非 DXT、cubemap、体纹理、宽高非 4 的倍数、截断数据）时返回 `None`，
/// 由调用方无缝回退既有 PNG 解码链路。
pub fn extract_vtf_dxt(vtf_bytes: &[u8]) -> Option<DxtTexture> {
    let vtf = crate::texture_utils::from_bytes(vtf_bytes).ok()?;
    let format = DxtFormat::from_vtf(vtf.highres_image.format)?;

    if (vtf.header.flags & VTF_FLAG_ENVMAP) != 0 || vtf.header.depth > 1 || vtf.header.frames < 1 {
        return None;
    }

    let w = vtf.highres_image.width;
    let h = vtf.highres_image.height;
    if w < 4 || h < 4 || w % 4 != 0 || h % 4 != 0 {
        return None;
    }

    // 完整 mip 链层数（到 1×1）：若 VTF 含完整链且每层均合法则全量直通；否则只取 mip 0（由前端关 mipmap 采样）。
    let max_dim = (w as u32).max(h as u32);
    let full_mips = (32 - max_dim.leading_zeros()) as usize;
    let available = vtf.header.mipmap_count as usize;

    let mut mips = Vec::new();
    if available >= full_mips && full_mips <= u8::MAX as usize {
        let mut ok = true;
        for m in 0..full_mips {
            let mw = (w as u32 >> m).max(1);
            let mh = (h as u32 >> m).max(1);
            let expected = format.mip_byte_size(mw, mh);
            match vtf.highres_image.get_mip_bytes(0, m as u32) {
                Ok(slice) if slice.len() == expected => mips.push(slice.to_vec()),
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok && mips.len() == full_mips {
            return Some(DxtTexture {
                width: w,
                height: h,
                format,
                mips,
            });
        }
        mips.clear();
    }

    let mip0 = vtf.highres_image.get_mip_bytes(0, 0).ok()?;
    if mip0.len() != format.mip_byte_size(w as u32, h as u32) {
        return None;
    }
    mips.push(mip0.to_vec());
    Some(DxtTexture {
        width: w,
        height: h,
        format,
        mips,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::texture_utils::vtf::{ResourceList, VTFHeader};

    fn make_synthetic_vtf(
        width: u16,
        height: u16,
        format: ImageFormat,
        mipmap_count: u8,
        flags: u32,
        depth: u16,
    ) -> Vec<u8> {
        let header = VTFHeader {
            signature: VTFHeader::SIGNATURE,
            version: [7, 2],
            header_size: 80,
            width,
            height,
            flags,
            frames: 1,
            first_frame: 0,
            reflectivity: [0.0; 3],
            bumpmap_scale: 1.0,
            highres_image_format: format,
            mipmap_count,
            lowres_image_format: ImageFormat::None,
            lowres_image_width: 0,
            lowres_image_height: 0,
            depth,
            resources: ResourceList::empty(),
        };
        let mut buf = Vec::new();
        header.write(&mut buf).unwrap();
        // header.write(7.2) writes 65 bytes; pad to header_size=80
        buf.resize(80, 0);
        // VTF stores mips from smallest (mipmap_count - 1) to largest (0)
        for m in (0..mipmap_count as u32).rev() {
            let mw = (width as u32 >> m).max(1);
            let mh = (height as u32 >> m).max(1);
            let sz = format.frame_size(mw, mh).unwrap() as usize;
            let fill = (m as u8).wrapping_add(1);
            buf.extend(std::iter::repeat_n(fill, sz));
        }
        buf
    }

    #[test]
    fn vdxt_serialization_layout_matches_spec() {
        let tex = DxtTexture {
            width: 8,
            height: 4,
            format: DxtFormat::Dxt5,
            mips: vec![vec![0xAA; 32], vec![0xBB; 16]],
        };
        let bytes = tex.to_vdxt_bytes();
        assert_eq!(&bytes[0..4], b"VDXT");
        assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), 8);
        assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]), 4);
        assert_eq!(bytes[8], 5);
        assert_eq!(bytes[9], 2);
        assert_eq!(u16::from_le_bytes([bytes[10], bytes[11]]), 0);
        assert_eq!(u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]), 0);
        assert_eq!(bytes.len(), 16 + 32 + 16);
        assert!(bytes[16..48].iter().all(|&b| b == 0xAA));
        assert!(bytes[48..64].iter().all(|&b| b == 0xBB));
    }

    #[test]
    fn has_alpha_holes_handles_dxt1_dxt1a_dxt3_dxt5() {
        // Dxt1 (opaque): never has holes even when c0 <= c1 and sel == 3
        let mut dxt1a_blk = [0u8; 8];
        dxt1a_blk[0..2].copy_from_slice(&0u16.to_le_bytes()); // c0 = 0
        dxt1a_blk[2..4].copy_from_slice(&1u16.to_le_bytes()); // c1 = 1 (c0 <= c1)
        dxt1a_blk[4..8].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes()); // all sel = 3
        let dxt1 = DxtTexture {
            width: 4,
            height: 4,
            format: DxtFormat::Dxt1,
            mips: vec![dxt1a_blk.to_vec()],
        };
        assert!(!dxt1.has_alpha_holes());

        let dxt1a = DxtTexture {
            width: 4,
            height: 4,
            format: DxtFormat::Dxt1OneBitAlpha,
            mips: vec![dxt1a_blk.to_vec()],
        };
        assert!(dxt1a.has_alpha_holes());

        // Dxt3: nibble = 0 => alpha = 0 < 32
        let mut dxt3_hole = [0u8; 16];
        dxt3_hole[0..8].fill(0x00);
        assert!(
            DxtTexture {
                width: 4,
                height: 4,
                format: DxtFormat::Dxt3,
                mips: vec![dxt3_hole.to_vec()],
            }
            .has_alpha_holes()
        );
        let mut dxt3_opaque = [0u8; 16];
        dxt3_opaque[0..8].fill(0xFF);
        assert!(
            !DxtTexture {
                width: 4,
                height: 4,
                format: DxtFormat::Dxt3,
                mips: vec![dxt3_opaque.to_vec()],
            }
            .has_alpha_holes()
        );

        // Dxt5: a0=0, a1=255 (a0 <= a1), all indices = 0 => palette[0] = 0 < 32
        let mut dxt5_hole = [0u8; 16];
        dxt5_hole[0] = 0;
        dxt5_hole[1] = 255;
        assert!(
            DxtTexture {
                width: 4,
                height: 4,
                format: DxtFormat::Dxt5,
                mips: vec![dxt5_hole.to_vec()],
            }
            .has_alpha_holes()
        );
        // Dxt5: a0=255, a1=200 (a0 > a1), min palette >= 200 >= 32
        let mut dxt5_opaque = [0u8; 16];
        dxt5_opaque[0] = 255;
        dxt5_opaque[1] = 200;
        assert!(
            !DxtTexture {
                width: 4,
                height: 4,
                format: DxtFormat::Dxt5,
                mips: vec![dxt5_opaque.to_vec()],
            }
            .has_alpha_holes()
        );
    }

    #[test]
    fn extract_vtf_dxt_full_and_partial_mips_and_rejects() {
        // Full mip chain for 64x64 (7 mips: 64, 32, 16, 8, 4, 2, 1)
        let vtf_full = make_synthetic_vtf(64, 64, ImageFormat::Dxt1, 7, 0, 1);
        let tex = extract_vtf_dxt(&vtf_full).expect("full 64x64 DXT1 should extract");
        assert_eq!(tex.mips.len(), 7);
        assert_eq!(tex.format, DxtFormat::Dxt1);
        assert_eq!(tex.mips[0][0], 1); // mip 0
        assert_eq!(tex.mips[1][0], 2); // mip 1 (32x32)
        // Mosaic decoder picks 32x32 (mip 1)
        let mosaic_img = tex.decode_mip_for_mosaic().unwrap();
        assert_eq!((mosaic_img.width(), mosaic_img.height()), (32, 32));

        // Partial mip chain (3 mips instead of 7) => falls back to mip 0 only
        let vtf_partial = make_synthetic_vtf(64, 64, ImageFormat::Dxt5, 3, 0, 1);
        let tex_partial = extract_vtf_dxt(&vtf_partial).expect("partial mip VTF extracts mip 0");
        assert_eq!(tex_partial.mips.len(), 1);
        assert_eq!(tex_partial.format, DxtFormat::Dxt5);

        // Cubemap & non-mult-of-4 rejected
        let vtf_cube = make_synthetic_vtf(64, 64, ImageFormat::Dxt1, 1, VTF_FLAG_ENVMAP, 1);
        assert!(extract_vtf_dxt(&vtf_cube).is_none());
        let vtf_odd = make_synthetic_vtf(6, 6, ImageFormat::Dxt1, 1, 0, 1);
        assert!(extract_vtf_dxt(&vtf_odd).is_none());
        let vtf_vol = make_synthetic_vtf(8, 8, ImageFormat::Dxt1, 1, 0, 4);
        assert!(extract_vtf_dxt(&vtf_vol).is_none());
    }
}
