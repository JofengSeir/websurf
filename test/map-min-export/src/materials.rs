//! 材质纹理导出：场景材质名 → PAKFILE 提取 VMT/VTF → VTF→PNG 解码。
//!
//! 链路：scene 分组材质名（TEXDATA 字符串，形如 `materials/devneons/blue_neon` 或
//! `devneons/blue_neon`，个别地图带 `.vmt` 后缀）→ 归一化相对路径 →
//! PAKFILE 内 `materials/<rel>.vmt`（大小写不敏感、`\`/`/` 兼容）→ 解析
//! `$basetexture`（+ `$normalmap`/`$bumpmap`）→ `materials/<bt>.vtf` → 解码 PNG。

use bsp_extract::{BspError, BspFile};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::vtf::{decode_vtf, encode_png};

/// 单个材质的导出结果（manifest 条目）。
#[derive(Debug, Clone)]
pub struct MaterialExport {
    /// 材质名（scene 分组键，如 `materials/devneons/blue_neon`）。
    pub name: String,
    /// 相对路径（去 `materials/` 前缀与扩展名）。
    pub rel: String,
    /// PAKFILE 内的 VMT 路径。
    pub vmt_path: String,
    /// VMT 文本（提取成功时）。
    pub vmt_text: Option<String>,
    /// PAKFILE 内的 VTF 路径（$basetexture 解析成功后）。
    pub vtf_path: Option<String>,
    /// 解码后的 PNG 字节（成功时）。
    pub png: Option<Vec<u8>>,
    /// 纹理宽/高/格式（VTF 头解析成功时）。
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: Option<String>,
    /// 备注（缺失/不支持格式等）。
    pub note: Option<String>,
}

/// 材质名 → 相对路径（去 `materials/` 前缀与 `.vmt` 扩展名）。
fn rel_path(name: &str) -> String {
    let n = name.trim();
    let n = n.strip_prefix("materials/").unwrap_or(n);
    n.strip_suffix(".vmt").unwrap_or(n).to_string()
}

/// 提取 VMT 内某键的值（引号字符串；`//` 注释先行剥离）。
/// 兼容两种键写法：`"$basetexture" "path"` 与 `$basetexture "path"`；
/// 键后须为空白或引号，防 `$basetexturetransform` 被 `$basetexture` 误配。
fn vmt_value(vmt: &str, key: &str) -> Option<String> {
    for line in vmt.lines() {
        let l = line.split("//").next().unwrap_or("").trim();
        let l = l.strip_prefix('"').unwrap_or(l); // 去键前引号
        if !l.starts_with(key) {
            continue;
        }
        let rest = &l[key.len()..];
        let rest = rest.strip_prefix('"').unwrap_or(rest); // 去键后引号（引号形式）
        if !rest.starts_with(|c: char| c.is_whitespace() || c == '"') {
            continue;
        }
        let v = rest
            .trim_start()
            .strip_prefix('"')?
            .split('"')
            .next()?
            .trim()
            .to_string();
        if !v.is_empty() {
            return Some(v);
        }
    }
    None
}

/// 纹理引用（$basetexture/$normalmap/$bumpmap）→ PAKFILE 内 VTF 路径。
fn texture_to_vtf_path(tex: &str) -> String {
    let t = tex.trim();
    let t = t.strip_prefix("materials/").unwrap_or(t);
    let t = t.strip_suffix(".vtf").unwrap_or(t);
    format!("materials/{t}.vtf")
}

/// 提取单个材质：VMT → $basetexture → VTF → PNG。
fn export_one_material(bsp: &BspFile, name: &str) -> MaterialExport {
    let rel = rel_path(name);
    let rel_save = rel.clone();
    let vmt_path = format!("materials/{rel}.vmt");
    let mut out = MaterialExport {
        name: name.to_string(),
        rel,
        vmt_path: vmt_path.clone(),
        vmt_text: None,
        vtf_path: None,
        png: None,
        width: None,
        height: None,
        format: None,
        note: None,
    };

    // ---- VMT ----
    let vmt_bytes = match bsp.pak_extract(&vmt_path) {
        Ok(Some(b)) => b,
        Ok(None) => {
            out.note = Some(format!("VMT 不在 PAKFILE（{vmt_path}）"));
            return out;
        }
        Err(e) => {
            out.note = Some(format!("PAKFILE 读取失败:{e}"));
            return out;
        }
    };
    let vmt_text = String::from_utf8_lossy(&vmt_bytes).to_string();
    out.vmt_text = Some(vmt_text.clone());

    // ---- $basetexture（缺失时回退到同名 .vtf）----
    let base = vmt_value(&vmt_text, "$basetexture");
    let vtf_path = match base {
        Some(t) if !t.is_empty() => texture_to_vtf_path(&t),
        _ => format!("materials/{rel_save}.vtf"),
    };
    out.vtf_path = Some(vtf_path.clone());

    let vtf_bytes = match bsp.pak_extract(&vtf_path) {
        Ok(Some(b)) => b,
        Ok(None) => {
            out.note = Some(format!("VTF 不在 PAKFILE（{vtf_path}；VMT 存在）"));
            return out;
        }
        Err(e) => {
            out.note = Some(format!("PAKFILE 读取失败:{e}"));
            return out;
        }
    };

    // ---- VTF → PNG ----
    match decode_vtf(&vtf_bytes) {
        Ok((info, rgba)) => {
            let width = info.width;
            let height = info.height;
            match encode_png(width, height, &rgba) {
                Ok(png) => {
                    out.png = Some(png);
                    out.width = Some(width);
                    out.height = Some(height);
                    out.format = Some(info.format_name);
                }
                Err(e) => {
                    out.note = Some(format!("PNG 编码失败:{e}"));
                }
            }
        }
        Err(e) => {
            out.note = Some(format!("VTF 解码失败:{e}"));
        }
    }

    out
}

/// 导出全部材质到 `out/materials/`，返回 manifest 的 `materials` 数组条目。
///
/// `material_names`：scene 分组的材质名（已去重）。排序输出保证确定性。
pub fn export_materials(
    bsp: &BspFile,
    material_names: &[String],
    out_dir: &Path,
) -> Result<Vec<serde_json::Value>, BspError> {
    let mat_dir = out_dir.join("materials");
    fs::create_dir_all(&mat_dir).map_err(|e| BspError::Io(e.to_string()))?;

    let mut names: BTreeMap<&String, ()> = BTreeMap::new();
    for n in material_names {
        names.insert(n, ());
    }

    let mut entries = Vec::new();
    for name in names.keys() {
        let m = export_one_material(bsp, name);

        // 落盘：VMT 文本 + PNG（或 VTF 原样兜底）
        let safe = sanitize_file_name(&m.rel);
        let mut written = Vec::new();
        if let Some(text) = &m.vmt_text {
            let p = mat_dir.join(format!("{safe}.vmt"));
            fs::write(&p, text).map_err(|e| BspError::Io(e.to_string()))?;
            written.push(format!("{safe}.vmt"));
        }
        if let Some(png) = &m.png {
            let p = mat_dir.join(format!("{safe}.png"));
            fs::write(&p, png).map_err(|e| BspError::Io(e.to_string()))?;
            written.push(format!("{safe}.png"));
        } else if let Some(vtf_path) = &m.vtf_path {
            // 解码失败兜底：保留原始 VTF 字节供后续工具处理
            if let Ok(Some(bytes)) = bsp.pak_extract(vtf_path) {
                let p = mat_dir.join(format!("{safe}.vtf"));
                fs::write(&p, bytes).map_err(|e| BspError::Io(e.to_string()))?;
                written.push(format!("{safe}.vtf"));
            }
        }

        entries.push(serde_json::json!({
            "name": m.name,
            "rel": m.rel,
            "vmt": m.vmt_path,
            "vtf": m.vtf_path,
            "files": written,
            "width": m.width,
            "height": m.height,
            "format": m.format,
            "note": m.note,
        }));
    }

    Ok(entries)
}

/// 文件名字符净化（防路径注入；材质名一般安全，防御性处理）。
fn sanitize_file_name(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_path_normalization() {
        assert_eq!(
            rel_path("materials/devneons/blue_neon"),
            "devneons/blue_neon"
        );
        assert_eq!(rel_path("devneons/blue_neon"), "devneons/blue_neon");
        assert_eq!(rel_path("materials/dev/blue_neon.vmt"), "dev/blue_neon");
        assert_eq!(rel_path("  materials/a/b  "), "a/b");
    }

    #[test]
    fn vmt_basetexture_parse() {
        let vmt = r#"
// 注释行
"$lightmappedgeneric"
{
  "$basetexture" "devneons/blue_neon"
  "$basetexturetransform" "center .5 .5 scale 1 1 rotate 0 translate 0 0"
  "$normalmap" "devneons/blue_neon_normal"
  "$translucent" "1"
}
"#;
        assert_eq!(
            vmt_value(vmt, "$basetexture"),
            Some("devneons/blue_neon".into())
        );
        assert_eq!(
            vmt_value(vmt, "$normalmap"),
            Some("devneons/blue_neon_normal".into())
        );
        // 键前缀不能误配 $basetexturetransform
        assert_eq!(
            vmt_value(vmt, "$basetexturetransform"),
            Some("center .5 .5 scale 1 1 rotate 0 translate 0 0".into())
        );
    }

    #[test]
    fn vtf_path_from_texture() {
        assert_eq!(
            texture_to_vtf_path("devneons/blue_neon"),
            "materials/devneons/blue_neon.vtf"
        );
        assert_eq!(
            texture_to_vtf_path("materials/dev/a.vtf"),
            "materials/dev/a.vtf"
        );
    }
}
