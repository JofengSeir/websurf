//! PAKFILE 内嵌模型的**材质解析**与**碰撞体数据准备**。
//!
//! Source BSP 会把地图用到的 `.mdl/.vvd/.vtx/.vmt/.vtf` 打进 PAKFILE lump。
//! 本模块在**无外部游戏资源**前提下，仅凭 BSP 字节完成两件事：
//!
//! 1. **材质**：解析 `.vmt`（Source KeyValues 文本）取 `$basetexture` 与透明度标注，
//!    再找对应 `.vtf` 解码成 PNG，交给 `model-integrator` 贴到 GLB 材质上。
//! 2. **碰撞体数据**：为模型碰撞导出提供顶点/网格/透明度门控数据（三角碰撞与
//!    .phy 凸包碰撞由各工程 `BspProcessor::export_model_*_colliders` 消费）。
//!
//! ## 透明度的「内置标注」在哪
//!
//! Source 的透明度标注全部写在 `.vmt` 里：
//!
//! | VMT 键 | 含义 | 本模块映射 |
//! |---|---|---|
//! | `$translucent 1` | 逐像素混合半透明（玻璃、水幕） | alpha_mode = 1（Blend） |
//! | `$alpha <1` | 整体透明度 | alpha_mode = 1（Blend） |
//! | `$alphatest 1` | 二值镂空（铁丝网、树叶） | alpha_mode = 2（Mask） |
//! | 均未出现 | 不透明 | alpha_mode = 0（Opaque）→ **默认带碰撞** |
//!
//! 碰撞门控采用**保守**策略（没有标注就默认有碰撞）：
//! - 仅当模型**所有**材质都是 `Blend`（真半透明）时才判定「可穿过」而跳过碰撞；
//! - `$alphatest` 镂空材质（铁丝网/栅栏）在 Source 里本是实体，**保留碰撞**；
//! - 未找到 `.vmt`（材质未打包）按**不透明**处理，即**保留碰撞**。
//!
//! 另外 `static_prop` lump 自带 `solid`（`SolidType`）字段，`0 = SOLID_NONE`
//! 是**明确无歧义**的「此道具无碰撞」标注，本模块尊重它；其余取值在各版本间
//! 语义不完全一致，故不用于门控（一律按有碰撞处理）。

use std::collections::HashMap;

// ---------------------------------------------------------------------------
// VMT（Source KeyValues 文本）解析
// ---------------------------------------------------------------------------

/// 单个 `.vmt` 解析结果。
#[derive(Debug, Clone, Default)]
pub struct VmtInfo {
    /// `$basetexture` 的值（已把 `\` 归一为 `/`，不含扩展名）。
    pub basetexture: Option<String>,
    /// 0 = 不透明；1 = Blend（`$translucent` / `$alpha<1`）；2 = Mask（`$alphatest`）。
    pub alpha_mode: u8,
    /// 自发光 / 无光照：VMT 着色器为 `UnlitGeneric`（含大小写变体）或 `$selfillum != 0`。
    /// Source 语义下这类材质**完全不吃光照**（只出贴图原色）；渲染侧据此走全亮。
    pub unlit: bool,
    /// `Patch` 着色器的 `include` 目标（另一个 `.vmt` 的路径）。
    ///
    /// Source 的 `patch` 材质本身不含 `$basetexture`，只写
    /// `include "materials/xxx.vmt"` + 若干 `replace`/`insert` 覆盖项，
    /// 调用方需再取一次被引用的 VMT 才能拿到真正的贴图。
    pub include: Option<String>,
}

/// 把一行 KeyValues 切成 token，正确处理成对双引号。
///
/// `"$basetexture" "models/foo/bar"` → `["$basetexture", "models/foo/bar"]`
/// `$basetexture models/foo/bar`     → `["$basetexture", "models/foo/bar"]`
fn tokenize_kv(line: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for c in line.chars() {
        if c == '"' {
            if in_quote {
                out.push(std::mem::take(&mut cur));
                in_quote = false;
            } else {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                in_quote = true;
            }
        } else if c.is_whitespace() && !in_quote {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        } else if (c == '{' || c == '}') && !in_quote {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(c);
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// 解析 `.vmt` 文本，提取 `$basetexture` 与透明度标注。
///
/// 只做**扁平扫描**（不建 KeyValues 树）：VMT 顶层参数几乎总在根块内，
/// 子块（`Proxies`/`>=DX90`）里的同名键取首次命中即可，足够稳健。
pub fn parse_vmt(text: &str) -> VmtInfo {
    let mut info = VmtInfo::default();
    let mut translucent = false;
    let mut alphatest = false;
    let mut unlit = false;

    // ⚠️ 行尾必须按 `\r` / `\n` **都切**：Valve 老工具产出的 VMT 会混用 CRLF 与
    // **孤立 CR**（实测 `materials/666/blue_neon.vmt`：`$model 1 <CR>  "$basetexture" …`）。
    // `str::lines()` 只按 `\n` 切 ⇒ 会把 `$model` 与 `$basetexture` 并成一行，
    // 取 `toks[0]` 得到 `$model` ⇒ 永远拿不到 `$basetexture` ⇒ prop 材质落到回退色
    // （表现即「霓虹/自发光亮面发黑」）。
    for raw in text.split(['\n', '\r']) {
        // 去掉行尾 `//` 注释（VMT 不支持字符串内 `//`，直接截断即可）
        let line = match raw.find("//") {
            Some(i) => &raw[..i],
            None => raw,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let toks = tokenize_kv(line);
        // ⚠️ 纯 `{` / `}` 行经 tokenizer 会变成**空数组**（花括号被丢弃）⇒ 必须先挡空，        // 否则下面的 `toks[0]` 会 panic（wasm 里表现为 RuntimeError + 借用标志泄漏，        // 导致同一 BspProcessor 的后续调用报 `recursive use of an object`）。
        if toks.is_empty() {
            continue;
        }
        if toks.len() < 2 {
            // 首行的着色器名（如 `"UnlitGeneric"` / `UnlitGeneric {`）只有一个 token
            let k = toks[0].to_ascii_lowercase();
            if k.starts_with("unlit") {
                unlit = true;
            }
            continue;
        }
        let key = toks[0].trim().to_ascii_lowercase();
        let val = toks[1].trim();
        match key.as_str() {
            "$basetexture" => {
                if info.basetexture.is_none() {
                    let v = val.replace('\\', "/");
                    let v = v.trim_matches('/').to_string();
                    if !v.is_empty() {
                        info.basetexture = Some(v);
                    }
                }
            }
            "$translucent" => {
                if val != "0" {
                    translucent = true;
                }
            }
            "$alphatest" => {
                if val != "0" {
                    alphatest = true;
                }
            }
            "$selfillum" => {
                if val != "0" && !val.is_empty() {
                    unlit = true;
                }
            }
            "$alpha" => {
                if let Ok(a) = val.parse::<f32>() {
                    if a < 0.999 {
                        translucent = true;
                    }
                }
            }
            "include" => {
                if info.include.is_none() {
                    let v = val.replace('\\', "/");
                    // 去掉 `materials/` 前缀与 `.vmt` 扩展名，统一交给 PakIndex 处理
                    let v = v.trim_matches('/');
                    let v = if v.to_ascii_lowercase().ends_with(".vmt") {
                        v[..v.len() - 4].to_string()
                    } else {
                        v.to_string()
                    };
                    if !v.is_empty() {
                        info.include = Some(v);
                    }
                }
            }
            _ => {}
        }
    }

    info.unlit = unlit;
    info.alpha_mode = if translucent {
        1
    } else if alphatest {
        2
    } else {
        0
    };
    info
}

// ---------------------------------------------------------------------------
// PAKFILE 条目索引（大小写不敏感查找）
// ---------------------------------------------------------------------------

/// PAKFILE 内所有条目的大小写不敏感索引。
///
/// Source 资源路径大小写混乱（编译器保留作者磁盘上的大小写，而 MDL 内记录的
/// 材质名往往是小写），必须统一归一化才能可靠命中。
pub struct PakIndex {
    /// `小写完整路径（含扩展名）` → 原始条目名
    by_path: HashMap<String, String>,
    /// `小写基名（不含扩展名）.扩展名` → 原始条目名（同名取首个）
    by_stem: HashMap<String, String>,
}

impl PakIndex {
    /// 从 PAKFILE 条目名列表构建索引。
    pub fn build(entry_names: &[String]) -> Self {
        let mut by_path = HashMap::new();
        let mut by_stem = HashMap::new();
        for name in entry_names {
            let norm = name.replace('\\', "/").to_ascii_lowercase();
            by_path.entry(norm.clone()).or_insert_with(|| name.clone());

            let base = norm.rsplit('/').next().unwrap_or(&norm);
            if let Some(dot) = base.rfind('.') {
                let stem = &base[..dot];
                let ext = &base[dot + 1..];
                by_stem
                    .entry(format!("{stem}.{ext}"))
                    .or_insert_with(|| name.clone());
            }
        }
        Self { by_path, by_stem }
    }

    /// 按「完整路径」查找（自动补 `materials/` 前缀并尝试多种写法）。
    pub fn find(&self, path_no_ext: &str, ext: &str) -> Option<&String> {
        let p = path_no_ext.replace('\\', "/").to_ascii_lowercase();
        let p = p.trim_matches('/');
        let candidates = [
            format!("{p}.{ext}"),
            format!("materials/{p}.{ext}"),
            format!("models/{p}.{ext}"),
            format!("materials/models/{p}.{ext}"),
        ];
        for c in &candidates {
            if let Some(v) = self.by_path.get(c) {
                return Some(v);
            }
        }
        // 回退：只按基名找（忽略目录层级）
        let base = p.rsplit('/').next().unwrap_or(p);
        self.by_stem.get(&format!("{base}.{ext}"))
    }
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// 四元数（x, y, z, w）绕轴旋转向量。与 `model-integrator::parse_angles` 产出的四元数配套。
pub fn quat_rotate(q: [f32; 4], v: [f32; 3]) -> [f32; 3] {
    let u = [q[0], q[1], q[2]];
    let s = q[3];
    // v' = v + 2 * u × (u × v + s * v)
    let t = [
        u[1] * v[2] - u[2] * v[1] + s * v[0],
        u[2] * v[0] - u[0] * v[2] + s * v[1],
        u[0] * v[1] - u[1] * v[0] + s * v[2],
    ];
    let r = cross(u, t);
    [v[0] + 2.0 * r[0], v[1] + 2.0 * r[1], v[2] + 2.0 * r[2]]
}

/// 把模型局部顶点搬到世界空间：`translation + q ⊗ (scale ⊙ v)`。

/// 变换链必须与 GLB 节点（`Node { translation, rotation, scale }`）**逐位一致**，
/// 二者的输入都来自同一份 `crate::model_integrator::resolve_placements`，
/// 因此碰撞体不会相对显示模型产生任何偏移。
pub fn place_point(
    v: [f32; 3],
    translation: [f32; 3],
    rotation: Option<[f32; 4]>,
    scale: Option<[f32; 3]>,
) -> [f32; 3] {
    let s = scale.unwrap_or([1.0, 1.0, 1.0]);
    let scaled = [v[0] * s[0], v[1] * s[1], v[2] * s[2]];
    let rotated = match rotation {
        Some(q) => quat_rotate(q, scaled),
        None => scaled,
    };
    [
        rotated[0] + translation[0],
        rotated[1] + translation[1],
        rotated[2] + translation[2],
    ]
}

#[cfg(test)]
mod tests {
    use super::parse_vmt;

    /// 回归：Valve 老工具产出的 VMT 会在行间混用 **孤立 CR**（无 \n）。
    /// `str::lines()` 只按 \n 切 ⇒ `$model 1 <CR> "$basetexture" …` 并成一行 ⇒ 取不到
    /// `$basetexture` ⇒ prop 材质落到 0.3 回退色（实机表现：霓虹/自发光「亮面发黑」）。
    /// 回归：纯 `{` / `}` 行分词后是空数组 ⇒ 不得索引 `toks[0]`（曾 panic）。
    #[test]
    fn brace_only_lines_do_not_panic() {
        let vmt = "\"UnlitGeneric\"\r\n{\r\n  \"$basetexture\" \"devneons/blue_neon\"\r\n}\r\n";
        let info = parse_vmt(vmt);
        assert_eq!(info.basetexture.as_deref(), Some("devneons/blue_neon"));
        assert!(info.unlit, "UnlitGeneric 应被标为自发光");
    }

    /// 回归：`$selfillum 1` 同样要标成自发光（不依赖着色器名）。
    #[test]
    fn selfillum_marks_unlit() {
        let vmt = "\"LightmappedGeneric\"\n{\n\t\"$basetexture\" \"x/y\"\n\t\"$selfillum\" \"1\"\n}\n";
        let info = parse_vmt(vmt);
        assert!(info.unlit);
        assert_eq!(info.basetexture.as_deref(), Some("x/y"));
    }

    #[test]
    fn parses_basetexture_across_lone_cr() {
        let vmt = "\"UnlitGeneric\"\r\n{\r\n\t$model 1 \r  \"$basetexture\" \"devneons/blue_neon\"\r\n  \"$selfillum\" 1\r\n}\r\n";
        let info = parse_vmt(vmt);
        assert_eq!(info.basetexture.as_deref(), Some("devneons/blue_neon"));
    }
}
