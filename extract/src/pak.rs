//! PAKFILE lump 提取与实体 lump 解析。
//!
//! - PAKFILE(lump 40)本身就是一段完整合法的 zip,直接切片后用 [`zip`] crate 打开。
//! - ENTITIES(lump 0)是纯文本 `{ "key" "value" }` 块。

use std::collections::BTreeMap;
use std::io::Cursor;

use zip::ZipArchive;

use crate::bsp::BspError;

// ---------------------------------------------------------------------------
// PAKFILE(zip)
// ---------------------------------------------------------------------------

/// PAKFILE 内一个文件的元信息。
#[derive(Debug, Clone)]
pub struct PakEntryInfo {
    /// 完整路径(zip 内原样,通常以 `/` 分隔)。
    pub name: String,
    /// 解压后大小。
    pub size: u64,
    /// 压缩方法名(deflate / stored / 其他)。
    pub method: String,
    /// 是否目录。
    pub is_dir: bool,
}

/// 打开 BSP 的 PAKFILE lump 字节,返回 zip 归档。
///
/// `pak_lump` 应来自 [`crate::bsp::raw_lump`] 且已按需解压。
/// 返回归档持有数据所有权(便于跨函数使用)。
pub fn open_pak(pak_lump: Vec<u8>) -> Result<ZipArchive<Cursor<Vec<u8>>>, BspError> {
    ZipArchive::new(Cursor::new(pak_lump)).map_err(|e| BspError::Zip(e.to_string()))
}

/// 枚举 PAKFILE 内全部条目(含目录)。
pub fn list_pak_entries(
    zip: &mut ZipArchive<Cursor<Vec<u8>>>,
) -> Result<Vec<PakEntryInfo>, BspError> {
    let mut out = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let file = zip.by_index(i).map_err(|e| BspError::Zip(e.to_string()))?;
        out.push(PakEntryInfo {
            name: file.name().to_string(),
            size: file.size(),
            method: match file.compression() {
                zip::CompressionMethod::Stored => "stored".into(),
                zip::CompressionMethod::Deflated => "deflate".into(),
                other => format!("{other:?}"),
            },
            is_dir: file.is_dir(),
        });
    }
    Ok(out)
}

/// 按路径从 PAKFILE 提取单个文件字节。
///
/// 路径匹配大小写不敏感,且兼容 `\` 与 `/` 分隔符(Source 素材引用常不一致)。
pub fn pak_extract(
    zip: &mut ZipArchive<Cursor<Vec<u8>>>,
    wanted: &str,
) -> Result<Option<Vec<u8>>, BspError> {
    let normalized = wanted.replace('\\', "/").to_ascii_lowercase();
    let mut result = None;

    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|e| BspError::Zip(e.to_string()))?;
        let name_norm = file.name().replace('\\', "/").to_ascii_lowercase();
        if name_norm != normalized {
            continue;
        }
        if file.is_dir() {
            return Ok(None);
        }
        let mut buf = Vec::with_capacity(file.size() as usize);
        std::io::Read::read_to_end(&mut file, &mut buf)
            .map_err(|e| BspError::Zip(e.to_string()))?;
        result = Some(buf);
        break;
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// 实体(ENTITIES)
// ---------------------------------------------------------------------------

/// 一个实体:`key -> value` 映射(保留顺序)。
#[derive(Debug, Clone, Default)]
pub struct Entity {
    pub keyvalues: BTreeMap<String, String>,
}

impl Entity {
    #[inline]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.keyvalues.get(key).map(String::as_str)
    }
}

/// 解析 ENTITIES lump 文本。
///
/// 格式:`{ "key" "value" ... }`,每实体一个块,支持 `//` 注释、空白、引号字符串。
/// Source 引擎的 entities lump 以 NUL(`\0`)结尾,解析时 NUL 视为文档结束。
pub fn parse_entities(text: &str) -> Result<Vec<Entity>, BspError> {
    let mut entities = Vec::new();
    let bytes = text.as_bytes();
    let mut pos = 0usize;
    let len = bytes.len();

    while pos < len {
        skip_whitespace_and_comments(bytes, &mut pos);

        // NUL 终止符或 EOF
        if pos >= len || bytes[pos] == 0 {
            break;
        }
        if bytes[pos] != b'{' {
            return Err(BspError::Entity(format!(
                "期望实体起始 '{{' 位于字节 {pos},实际 0x{:02X}",
                bytes[pos]
            )));
        }
        pos += 1; // 消费 '{'

        let mut ent = Entity::default();
        loop {
            skip_whitespace_and_comments(bytes, &mut pos);
            if pos >= len || bytes[pos] == 0 {
                return Err(BspError::Entity("实体未闭合(缺 '}')".into()));
            }
            if bytes[pos] == b'}' {
                pos += 1;
                break;
            }

            let key = read_quoted(bytes, &mut pos)?;
            skip_whitespace_and_comments(bytes, &mut pos);
            let value = read_quoted(bytes, &mut pos)?;
            ent.keyvalues.insert(key, value);
        }
        entities.push(ent);
    }

    Ok(entities)
}

/// 跳过空白与 `//` 单行注释。
fn skip_whitespace_and_comments(bytes: &[u8], pos: &mut usize) {
    loop {
        while *pos < bytes.len() && bytes[*pos].is_ascii_whitespace() {
            *pos += 1;
        }
        if *pos + 1 < bytes.len() && bytes[*pos] == b'/' && bytes[*pos + 1] == b'/' {
            while *pos < bytes.len() && bytes[*pos] != b'\n' {
                *pos += 1;
            }
            continue;
        }
        break;
    }
}

/// 读取一个引号包裹的字符串(支持 `\"` 与 `\\` 转义)。
fn read_quoted(bytes: &[u8], pos: &mut usize) -> Result<String, BspError> {
    if *pos >= bytes.len() || bytes[*pos] != b'"' {
        return Err(BspError::Entity(format!(
            "期望字符串起始 '\"' 位于字节 {pos},实际 0x{:02X}",
            bytes.get(*pos).copied().unwrap_or(0)
        )));
    }
    *pos += 1; // 消费开引号

    let mut out = Vec::new();
    loop {
        if *pos >= bytes.len() {
            return Err(BspError::Entity("字符串未闭合(缺 '\"')".into()));
        }
        let c = bytes[*pos];
        match c {
            b'"' => {
                *pos += 1;
                break;
            }
            b'\\' if *pos + 1 < bytes.len() => {
                let next = bytes[*pos + 1];
                if next == b'"' || next == b'\\' {
                    out.push(next);
                    *pos += 2;
                } else {
                    // 保留转义符原文
                    out.push(b'\\');
                    *pos += 1;
                }
            }
            _ => {
                out.push(c);
                *pos += 1;
            }
        }
    }

    String::from_utf8(out).map_err(|e| BspError::Entity(format!("实体值非法 UTF-8:{e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_entities() {
        let text = r#"
{
	"classname" "info_player_start"
	"origin" "128 64 32"
}
{
	"classname" "prop_static"
	"model" "models/props/de_dust/metal_box.mdl"
}
"#;
        let entities = parse_entities(text).unwrap();
        assert_eq!(entities.len(), 2);
        assert_eq!(entities[0].get("classname"), Some("info_player_start"));
        assert_eq!(entities[0].get("origin"), Some("128 64 32"));
        assert_eq!(entities[1].get("model"), Some("models/props/de_dust/metal_box.mdl"));
    }

    #[test]
    fn parse_with_comments_and_escapes() {
        let text = r#"// 顶部注释
{
	"classname" "point_spotlight" // 行内注释
	"message" "say \"hello\""
}
"#;
        let entities = parse_entities(text).unwrap();
        assert_eq!(entities.len(), 1);
        assert_eq!(entities[0].get("message"), Some("say \"hello\""));
    }

    #[test]
    fn parse_empty() {
        assert!(parse_entities("").unwrap().is_empty());
        assert!(parse_entities("   \n  ").unwrap().is_empty());
    }

    #[test]
    fn parse_nul_terminated() {
        // Source 引擎实体 lump 以 NUL 结尾
        let mut text = String::from("{\n\"classname\" \"info_player_start\"\n}\n");
        text.push('\0');
        let entities = parse_entities(&text).unwrap();
        assert_eq!(entities.len(), 1);
        assert_eq!(entities[0].get("classname"), Some("info_player_start"));
    }

    #[test]
    fn rejects_unclosed() {
        assert!(parse_entities("{\n\"a\" \"b\"\n").is_err());
    }

    #[test]
    fn pak_extract_case_insensitive() {
        // 构造最小 zip(用 zip crate 写:先写后读)
        let mut buf = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            writer.start_file("materials/test/foo.vmt", opts).unwrap();
            std::io::Write::write_all(&mut writer, b"hello").unwrap();
            writer.finish().unwrap();
        }
        let bytes = buf.into_inner();

        let mut zip_archive = open_pak(bytes).unwrap();
        assert_eq!(list_pak_entries(&mut zip_archive).unwrap().len(), 1);

        // 大小写 + 反斜杠兼容
        let out = pak_extract(&mut zip_archive, "MATERIALS\\TEST\\FOO.VMT").unwrap();
        assert_eq!(out.as_deref(), Some(&b"hello"[..]));

        let missing = pak_extract(&mut zip_archive, "nope.vmt").unwrap();
        assert!(missing.is_none());
    }
}
