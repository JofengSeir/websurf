//! Valve LZMA 压缩格式解压(Rust 实现,参照 sourcepp LZMA.cpp)。
//!
//! Valve 头(17 字节):
//! ```text
//! 0..4   "LZMA" 签名
//! 4..8   解压后长度 u32
//! 8..12  压缩段长度 u32(可跳过,仅信息)
//! 12..13 props(1 字节 lc/lp/pb)
//! 13..17 dictionarySize u32
//! 17..   原始 LZMA alone 压缩流
//! ```
//! 解压方法:剥掉 "LZMA" 签名,把 `props + dictSize + 解压长度(u64)` 重写为
//! 标准 LZMA alone 头(13 字节),交给 lzma-rs 解码。

use crate::bsp::BspError;

/// Valve LZMA 头总长。
pub const VALVE_LZMA_HEADER_LEN: usize = 17;

/// 校验数据是否为 Valve LZMA 格式并解压。
///
/// 返回解压后的字节;头非法或解压失败返回 [`BspError`]。
pub fn decompress_valve_lzma(data: &[u8]) -> Result<Vec<u8>, BspError> {
    if data.len() < VALVE_LZMA_HEADER_LEN {
        return Err(BspError::Lzma(format!(
            "数据过短:需要 >= {VALVE_LZMA_HEADER_LEN} 字节头,实际 {}",
            data.len()
        )));
    }

    // 1. 校验签名
    if &data[0..4] != b"LZMA" {
        return Err(BspError::Lzma("非法 LZMA 签名".into()));
    }

    // 2. 读 Valve 头字段
    let uncompressed_len = u32::from_le_bytes(data[4..8].try_into().unwrap()) as usize;
    // data[8..12] = compressedLength(仅信息)
    let props = data[12];
    let dict_size = u32::from_le_bytes(data[13..17].try_into().unwrap());

    // 3. 重写为标准 LZMA alone 头:props(1B) + dictSize(4B LE) + uncompressedLen(u64 LE)
    let mut alone_header = Vec::with_capacity(13);
    alone_header.push(props);
    alone_header.extend_from_slice(&dict_size.to_le_bytes());
    alone_header.extend_from_slice(&(uncompressed_len as u64).to_le_bytes());

    // 4. 压缩流 = 头之后的数据
    let compressed = &data[VALVE_LZMA_HEADER_LEN..];

    // 5. lzma-rs 解压(输入 = alone 头 + 流)
    let mut input = alone_header;
    input.extend_from_slice(compressed);

    let mut output = Vec::with_capacity(uncompressed_len);
    lzma_rs::lzma_decompress(&mut std::io::Cursor::new(input), &mut output)
        .map_err(|e| BspError::Lzma(e.to_string()))?;

    // 6. 长度校验(宽松:允许工具链多写,但短了视为异常)
    if output.len() < uncompressed_len {
        return Err(BspError::Lzma(format!(
            "解压长度不符:声明 {uncompressed_len},实际 {}",
            output.len()
        )));
    }

    Ok(output)
}

/// 便捷函数:尝试解压,若输入不带 Valve 头则原样返回(容错)。
pub fn decompress_or_raw(data: &[u8]) -> Result<Vec<u8>, BspError> {
    if data.len() >= 4 && &data[0..4] == b"LZMA" {
        decompress_valve_lzma(data)
    } else {
        Ok(data.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造 Valve LZMA 数据:先用 lzma-rs 压缩(alone 格式),再包上 Valve 头。
    fn make_valve_lzma(plain: &[u8]) -> Vec<u8> {
        let mut compressed: Vec<u8> = Vec::new();
        lzma_rs::lzma_compress(&mut std::io::Cursor::new(plain), &mut compressed).unwrap();

        // lzma-rs 的 lzma_compress 输出 = alone 头(13B)+ 流;拆开重装 Valve 头
        assert!(compressed.len() >= 13, "alone 头缺失");
        let props = compressed[0];
        let dict_size = u32::from_le_bytes(compressed[1..5].try_into().unwrap());
        let stream = &compressed[13..];

        let mut out = Vec::new();
        out.extend_from_slice(b"LZMA");
        out.extend_from_slice(&(plain.len() as u32).to_le_bytes());
        out.extend_from_slice(&(stream.len() as u32).to_le_bytes());
        out.push(props);
        out.extend_from_slice(&dict_size.to_le_bytes());
        out.extend_from_slice(stream);
        out
    }

    #[test]
    fn roundtrip() {
        let plain = b"hello valve lzma world! hello valve lzma world!".repeat(50);
        let data = make_valve_lzma(&plain);
        let out = decompress_valve_lzma(&data).unwrap();
        assert_eq!(out, plain);
    }

    #[test]
    fn rejects_bad_signature() {
        let data = b"NOLZxxxxxxxxxxxxxxxxx";
        assert!(decompress_valve_lzma(data).is_err());
    }

    #[test]
    fn rejects_too_short() {
        assert!(decompress_valve_lzma(&[0u8; 5]).is_err());
    }

    #[test]
    fn decompress_or_raw_passthrough() {
        let out = decompress_or_raw(b"not compressed at all").unwrap();
        assert_eq!(out, b"not compressed at all");
    }

    #[test]
    fn empty_roundtrip() {
        let data = make_valve_lzma(&[]);
        let out = decompress_valve_lzma(&data).unwrap();
        assert_eq!(out, b"");
    }
}
