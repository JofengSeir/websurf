//! bsp-extract CLI:解包 Source 1 (CS:GO) BSP。
//!
//! 子命令:
//! - `info <bsp>`           显示 BSP 头信息 + lump 目录
//! - `entities <bsp>`       打印解析后的实体 KV
//! - `pak list <bsp>`       列出 PAKFILE 全部条目
//! - `pak get <bsp> <path>` 按路径提取 PAKFILE 内文件到 stdout(原始字节)
//! - `pak extract <bsp> <dir>` 把 PAKFILE 全部文件解包到目录(安全路径)

use std::io::{Read, Write};
use std::path::PathBuf;

use bsp_extract::{BspFile, lump_name};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        print_usage();
        std::process::exit(1);
    }

    let result = match args[1].as_str() {
        "info" => cmd_info(&args[2..]),
        "entities" => cmd_entities(&args[2..]),
        "pak" => cmd_pak(&args[2..]),
        "glb" => cmd_glb(&args[2..]),
        "help" | "--help" | "-h" => {
            print_usage();
            Ok(())
        }
        other => Err(format!("未知子命令:{other}")),
    };

    if let Err(e) = result {
        eprintln!("错误:{e}");
        std::process::exit(2);
    }
}

fn print_usage() {
    println!(
        "bsp-extract — Source 1 (CS:GO) BSP 解包器(Rust 独立实现)\n\
\n\
用法:\n\
  bsp-extract info <bsp>\n\
  bsp-extract entities <bsp>\n\
  bsp-extract pak list <bsp>\n\
  bsp-extract pak get <bsp> <path>\n\
  bsp-extract pak extract <bsp> <dir>\n\
  bsp-extract glb <bsp> <out.glb>"
    );
}

fn require_arg(args: &[String], name: &str, idx: usize) -> Result<String, String> {
    args.get(idx)
        .cloned()
        .ok_or_else(|| format!("缺少参数:{name}"))
}

fn cmd_info(args: &[String]) -> Result<(), String> {
    let path = require_arg(args, "<bsp>", 0)?;
    let bsp = BspFile::from_path(&path).map_err(|e| e.to_string())?;

    println!("=== BSP 头 ===");
    println!("版本:      v{}", bsp.version());
    println!("mapRevision: {}", bsp.map_revision());
    println!("文件大小:  {} bytes", bsp_size(&path));

    println!("\n=== Lump 目录(共 64) ===");
    println!("{:>4}  {:<24} {:>10} {:>10} {:>8} {:>10}", "#", "NAME", "OFFSET", "LENGTH", "VER", "UNCOMP");
    for i in 0..bsp_extract::BSP_LUMP_COUNT {
        let Some(entry) = bsp.lump_entry(i) else { continue };
        if !entry.is_present() {
            continue;
        }
        println!(
            "{i:>4}  {:<24} {:>10} {:>10} {:>8} {:>10}{}",
            lump_name(i),
            entry.offset,
            entry.length,
            entry.version,
            entry.uncompressed_length,
            if entry.is_compressed() { "  [LZMA]" } else { "" },
        );
    }
    Ok(())
}

fn bsp_size(path: &str) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn cmd_entities(args: &[String]) -> Result<(), String> {
    let path = require_arg(args, "<bsp>", 0)?;
    let bsp = BspFile::from_path(&path).map_err(|e| e.to_string())?;
    let entities = bsp.entities().map_err(|e| e.to_string())?;

    println!("=== 实体(共 {} 个)===", entities.len());
    for (i, ent) in entities.iter().enumerate() {
        println!("[{i}] {}", ent.get("classname").unwrap_or("(无 classname)"));
        for (k, v) in &ent.keyvalues {
            if k != "classname" {
                println!("    {k} = {v}");
            }
        }
    }
    Ok(())
}

fn cmd_pak(args: &[String]) -> Result<(), String> {
    let Some(sub) = args.first() else {
        return Err("pak 需要子命令:list | get | extract".into());
    };
    match sub.as_str() {
        "list" => cmd_pak_list(&args[1..]),
        "get" => cmd_pak_get(&args[1..]),
        "extract" => cmd_pak_extract(&args[1..]),
        other => Err(format!("未知 pak 子命令:{other}")),
    }
}

/// 重建 BSP 场景并导出 GLB。
fn cmd_glb(args: &[String]) -> Result<(), String> {
    let path = require_arg(args, "<bsp>", 0)?;
    let out_path = require_arg(args, "<out.glb>", 1)?;
    let bsp = BspFile::from_path(&path).map_err(|e| e.to_string())?;

    eprintln!("解析 lump…");
    let primitives = bsp_extract::scene::rebuild_scene(&bsp).map_err(|e| e.to_string())?;

    let total_verts: usize = primitives.iter().map(|p| p.vertices.len()).sum();
    let total_tris: usize = primitives.iter().map(|p| p.indices.len() / 3).sum();
    eprintln!(
        "重建完成:{} 个材质组,{} 顶点,{} 三角形",
        primitives.len(),
        total_verts,
        total_tris
    );

    let glb = bsp_extract::glb::build_glb(&primitives, "bsp");
    std::fs::write(&out_path, &glb).map_err(|e| e.to_string())?;
    println!("已导出 {out_path} ({} bytes)", glb.len());
    Ok(())
}

fn cmd_pak_list(args: &[String]) -> Result<(), String> {
    let path = require_arg(args, "<bsp>", 0)?;
    let bsp = BspFile::from_path(&path).map_err(|e| e.to_string())?;

    let mut zip = bsp
        .open_pak()
        .map_err(|e| e.to_string())?
        .ok_or("该 BSP 没有 PAKFILE lump")?;
    let entries = bsp_extract::list_pak_entries(&mut zip).map_err(|e| e.to_string())?;

    let files = entries.iter().filter(|e| !e.is_dir).count();
    println!("=== PAKFILE(共 {} 项,{} 个文件)===", entries.len(), files);
    for e in entries.iter().filter(|e| !e.is_dir) {
        println!("{:>12}  {:<10}  {}", e.size, e.method, e.name);
    }
    Ok(())
}

fn cmd_pak_get(args: &[String]) -> Result<(), String> {
    let path = require_arg(args, "<bsp>", 0)?;
    let wanted = require_arg(args, "<path>", 1)?;
    let bsp = BspFile::from_path(&path).map_err(|e| e.to_string())?;

    let bytes = bsp
        .pak_extract(&wanted)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("PAKFILE 中未找到:{wanted}"))?;

    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(())
}

fn cmd_pak_extract(args: &[String]) -> Result<(), String> {
    let path = require_arg(args, "<bsp>", 0)?;
    let dir = require_arg(args, "<dir>", 1)?;
    let bsp = BspFile::from_path(&path).map_err(|e| e.to_string())?;

    let mut zip = bsp
        .open_pak()
        .map_err(|e| e.to_string())?
        .ok_or("该 BSP 没有 PAKFILE lump")?;

    let out_root = PathBuf::from(&dir);
    std::fs::create_dir_all(&out_root).map_err(|e| e.to_string())?;

    let mut extracted = 0usize;
    let mut total_bytes = 0u64;
    // 累计解压上限:防多条目 zip 炸弹(单条目上限见 pak::MAX_PAK_FILE_BYTES)
    const MAX_PAK_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
        if file.is_dir() {
            continue;
        }
        let rel = sanitize_rel_path(file.name());
        let dest = out_root.join(&rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // zip 炸弹防护:声明尺寸与实际解压双双封顶(与 lib pak_extract 同法)
        if file.size() > bsp_extract::pak::MAX_PAK_FILE_BYTES {
            return Err(format!(
                "PAK 条目过大:{}(>{})",
                file.size(),
                bsp_extract::pak::MAX_PAK_FILE_BYTES
            ));
        }
        let mut buf = Vec::with_capacity(file.size() as usize);
        let mut limited = Read::take(&mut file, bsp_extract::pak::MAX_PAK_FILE_BYTES + 1);
        limited.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        if buf.len() as u64 > bsp_extract::pak::MAX_PAK_FILE_BYTES {
            return Err(format!(
                "PAK 条目解压超过上限 {} 字节",
                bsp_extract::pak::MAX_PAK_FILE_BYTES
            ));
        }
        total_bytes += buf.len() as u64;
        if total_bytes > MAX_PAK_TOTAL_BYTES {
            return Err(format!("PAKFILE 累计解压超过上限 {MAX_PAK_TOTAL_BYTES} 字节"));
        }
        std::fs::write(&dest, buf).map_err(|e| e.to_string())?;
        extracted += 1;
    }
    println!("已解包 {extracted} 个文件到 {dir}");
    Ok(())
}

/// 将 zip 内路径转换为安全相对路径(防 `..` / 绝对路径 / 盘符注入)。
fn sanitize_rel_path(name: &str) -> PathBuf {
    let mut parts = Vec::new();
    for part in name.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            // 丢弃向上跳转,防止逃出目标目录
            continue;
        }
        // 去掉盘符前缀(如 "C:\..." → "...")
        let cleaned = strip_drive_prefix(part);
        if cleaned.is_empty() {
            continue;
        }
        parts.push(cleaned.to_string());
    }
    parts.iter().collect::<PathBuf>()
}

/// 去除形如 `C:` / `c:` 的盘符前缀;非盘符路径原样返回。
fn strip_drive_prefix(part: &str) -> &str {
    let bytes = part.as_bytes();
    if bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
    {
        &part[2..]
    } else {
        part
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_rel_path;
    use std::path::Path;

    #[test]
    fn sanitize_path_traversal() {
        assert_eq!(
            sanitize_rel_path("a/../../etc/passwd"),
            Path::new("a/etc/passwd")
        );
        assert_eq!(sanitize_rel_path("C:/Windows/system32"), Path::new("Windows/system32"));
        assert_eq!(sanitize_rel_path("materials/foo.vmt"), Path::new("materials/foo.vmt"));
        assert_eq!(sanitize_rel_path("a\\b\\c.vmt"), Path::new("a/b/c.vmt"));
    }
}
