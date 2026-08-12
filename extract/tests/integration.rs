//! 集成测试:构造合成 BSP 走全链路(不依赖任何外部文件)。
//!
//! 合成 BSP 结构:
//! - 标准 VBSP 头(v21)
//! - lump[4] VISIBILITY:Valve LZMA 压缩数据
//! - lump[40] PAKFILE:合法 zip(含 2 个文件)
//! - lump[0] ENTITIES:实体文本(NUL 结尾)
//!
//! 验证:header 解析 → lump 自动解压 → zip 打开 → 大小写不敏感提取 → 实体解析。

use std::io::{Cursor, Write};
use std::collections::HashMap;

use bsp_extract::{BspFile, BspHeader, lumps};
use zip::ZipWriter;

/// 构造 Valve LZMA 数据(lzma-rs 压缩 + Valve 17B 头)。
fn valve_lzma(plain: &[u8]) -> Vec<u8> {
    let mut compressed: Vec<u8> = Vec::new();
    lzma_rs::lzma_compress(&mut Cursor::new(plain), &mut compressed).unwrap();
    assert!(compressed.len() >= 13);

    let mut out = Vec::new();
    out.extend_from_slice(b"LZMA");
    out.extend_from_slice(&(plain.len() as u32).to_le_bytes());
    out.extend_from_slice(&((compressed.len() - 13) as u32).to_le_bytes());
    out.push(compressed[0]); // props
    out.extend_from_slice(&compressed[1..5]); // dictSize
    out.extend_from_slice(&compressed[13..]); // 流
    out
}

/// 构造内嵌 zip(PAKFILE)。
fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut buf);
        let opts = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in files {
            writer.start_file(*name, opts).unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap();
    }
    buf.into_inner()
}

/// 组装完整 BSP 字节。
fn build_bsp(lumps_map: &HashMap<usize, Vec<u8>>) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"VBSP");
    out.extend_from_slice(&21u32.to_le_bytes()); // v21 (CS:GO)

    // 占位 lump 目录
    let dir_start = out.len();
    out.resize(dir_start + 64 * 16, 0u8);

    // mapRevision(lump 目录之后,固定偏移 1032)
    out.extend_from_slice(&42u32.to_le_bytes());

    // 追加各 lump 数据,并回填目录(4 字节对齐)
    let mut cursor = out.len() as u32;
    for (index, data) in lumps_map {
        // 4 字节对齐
        cursor = (cursor + 3) & !3;
        while out.len() < cursor as usize {
            out.push(0);
        }
        let entry_offset = dir_start + index * 16;
        out[entry_offset..entry_offset + 4].copy_from_slice(&cursor.to_le_bytes());
        out[entry_offset + 4..entry_offset + 8].copy_from_slice(&(data.len() as u32).to_le_bytes());
        // version = 0
        let uncompressed = if data.len() >= 4 && &data[0..4] == b"LZMA" {
            // 从 Valve 头取解压长度
            u32::from_le_bytes(data[4..8].try_into().unwrap())
        } else {
            0
        };
        out[entry_offset + 12..entry_offset + 16].copy_from_slice(&uncompressed.to_le_bytes());
        out.extend_from_slice(data);
        cursor += data.len() as u32;
    }

    out
}

#[test]
fn full_pipeline_synthetic_bsp() {
    // 1. 构造各 lump
    let vis_plain = b"PVS data for clusters, this should be compressed with LZMA".repeat(100);
    let vis_compressed = valve_lzma(&vis_plain);

    let pak_bytes = make_zip(&[
        ("materials/test/foo.vmt", b"\"UnlitGeneric\"\n{\n\t\"$basetexture\" \"test/foo\"\n}\n"),
        ("models/props/test/box.mdl", b"\x00\x01\x02MDL-BYTES"),
    ]);

    let entities_text = "{\n\"classname\" \"worldspawn\"\n\"skyname\" \"sky45\"\n}\n{\n\"classname\" \"info_player_start\"\n\"origin\" \"128 64 32\"\n}\n\0";

    let mut lumps_map = HashMap::new();
    lumps_map.insert(lumps::VISIBILITY, vis_compressed);
    lumps_map.insert(lumps::PAKFILE, pak_bytes);
    lumps_map.insert(lumps::ENTITIES, entities_text.as_bytes().to_vec());

    let bsp_bytes = build_bsp(&lumps_map);

    // 2. 解析头
    let header = BspHeader::parse(&bsp_bytes).unwrap();
    assert_eq!(header.version, 21);
    assert_eq!(header.map_revision, 42);

    // 3. BspFile 全链路
    let bsp = BspFile::new(bsp_bytes).unwrap();
    assert_eq!(bsp.version(), 21);

    // 4. VISIBILITY 自动解压
    assert!(bsp.is_lump_compressed(lumps::VISIBILITY));
    let vis_out = bsp.lump_data(lumps::VISIBILITY, false).unwrap().unwrap();
    assert_eq!(vis_out, vis_plain);
    // no_decompress 返回原始压缩字节
    let raw = bsp.lump_data(lumps::VISIBILITY, true).unwrap().unwrap();
    assert_eq!(&raw[0..4], b"LZMA");

    // 5. PAKFILE zip 打开 + 提取(大小写/反斜杠不敏感)
    let mut zip = bsp.open_pak().unwrap().unwrap();
    let entries = bsp_extract::list_pak_entries(&mut zip).unwrap();
    assert_eq!(entries.len(), 2);

    let vmt = bsp_extract::pak_extract(&mut zip, "MATERIALS\\TEST\\FOO.VMT").unwrap().unwrap();
    assert!(vmt.starts_with(b"\"UnlitGeneric\""));
    let mdl = bsp.pak_extract("models/props/test/box.mdl").unwrap().unwrap();
    assert_eq!(mdl, b"\x00\x01\x02MDL-BYTES");

    // 6. 实体解析(NUL 结尾)
    let entities = bsp.entities().unwrap();
    assert_eq!(entities.len(), 2);
    assert_eq!(entities[0].get("classname"), Some("worldspawn"));
    assert_eq!(entities[1].get("origin"), Some("128 64 32"));
}

#[test]
fn bsp_without_pak_returns_none() {
    let bsp_bytes = build_bsp(&HashMap::new());
    let bsp = BspFile::new(bsp_bytes).unwrap();
    assert!(bsp.open_pak().unwrap().is_none());
    assert!(bsp.pak_entries().is_err());
}
