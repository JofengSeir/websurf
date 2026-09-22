//! PAKFILE 内嵌模型的**材质解析**与**世界空间变换**。
//!
//! 本模块只做三件事，输入是 PAKFILE 条目的名字或字节：
//!
//! 1. **VMT 解析**（`parse_vmt`）：把 `.vmt` 文本扫成 `VmtInfo`——`$basetexture`、
//!    透明度标注 `alpha_mode`、自发光标记 `unlit`、`patch` 的 `include` 目标。
//! 2. **条目索引**（`PakIndex`）：PAKFILE 条目名的大小写不敏感查找，供调用方由材质名 /
//!    贴图名定位 `.vmt` 与 `.vtf` 条目。
//! 3. **世界空间变换**（`quat_rotate` / `place_point`）：把模型局部顶点按
//!    `translation + q ⊗ (scale ⊙ v)` 搬到世界空间。
//!
//! 本模块**不做碰撞判定、不读 `.phy`、不展开网格、不碰 GLB**。下游：
//! - 三工程 `crates/wasm/src/lib.rs` 的 `resolve_pakfile_materials`：调 `PakIndex` +
//!   `parse_vmt`，产出 `材质名 → alpha_mode` 与 `纹理名 → PNG 字节`；
//! - `apps/debug` 与 `apps/game` 的 `export_model_tri_colliders` /
//!   `export_model_phy_colliders`（`apps/viewer` 无碰撞导出，不调这两个）：
//!   用 `place_point` 搬顶点，并按 `alpha_mode` 与 `Placement::solid` 决定是否跳过碰撞；
//! - `alpha_mode` 经 `model_integrator::InMemoryResources::material_alpha_mode` 决定 GLB
//!   材质的 alphaMode；`unlit` 经同结构的 `material_unlit` 让材质走全亮。
//!
//! ## `alpha_mode` 的判定口径
//!
//! 只有两种标注能让材质变成非不透明，且 **Blend 优先于 Mask**：
//!
//! | VMT 键 | 触发条件 | alpha_mode |
//! |---|---|---|
//! | `$translucent` | 值 ≠ `"0"` | 1（Blend） |
//! | `$alpha` | 能解析成 `f32` 且 < 0.999 | 1（Blend） |
//! | `$alphatest` | 值 ≠ `"0"` | 2（Mask） |
//! | 以上都没有 | —— | 0（Opaque） |
//!
//! `unlit` 有两条来路：着色器名以 `unlit` 开头，或 `$selfillum` 取到非 `"0"` 的非空值。
//!
//! 碰撞门控不在本模块。调用点实测：`export_model_tri_colliders` 里
//! `if alpha == 1 { continue; }`——**只有 Blend 跳过**，Mask 与 Opaque 都保留碰撞；
//! `Placement::solid == Some(0)`（即 `SolidType::None`）的实例另由调用方 `filter` 掉。

use std::collections::HashMap;

// ---------------------------------------------------------------------------
// VMT（Source KeyValues 文本）解析
// ---------------------------------------------------------------------------

/// 单个 `.vmt` 的解析结果，字段全部来自 `parse_vmt` 的扁平扫描。
#[derive(Debug, Clone, Default)]
pub struct VmtInfo {
    /// `$basetexture` 的值：`\` 已归一为 `/`，首尾 `/` 已去掉，不含扩展名。
    /// 同名键**首次命中即锁定**，后续重复键不覆盖。
    pub basetexture: Option<String>,
    /// 0 = Opaque；1 = Blend（`$translucent` 或 `$alpha < 0.999`）；2 = Mask（`$alphatest`）。
    /// Blend 与 Mask 同时命中时取 Blend。
    pub alpha_mode: u8,
    /// 自发光 / 无光照：着色器名以 `unlit` 开头（不区分大小写），或 `$selfillum` 取到
    /// 非 `"0"` 的非空值。消费方据此让材质走全亮（不吃 lightmap / ambient cube）。
    pub unlit: bool,
    /// `Patch` 着色器的 `include` 目标（另一个 `.vmt` 的路径）：`\` 已归一为 `/`，
    /// 首尾 `/` 已去掉，`.vmt` 后缀已剥。首次命中即锁定。
    ///
    /// `patch` 材质自身可以没有 `$basetexture`，只写 `include "materials/xxx.vmt"`
    /// 加若干 `replace` / `insert` 覆盖项；调用方需再取一次被引用的 VMT 才能拿到贴图。
    pub include: Option<String>,
}

/// 把一行 KeyValues 切成 token，**成对双引号内**的空白不切分。
///
/// `"$basetexture" "models/foo/bar"` → `["$basetexture", "models/foo/bar"]`
/// `$basetexture models/foo/bar`     → `["$basetexture", "models/foo/bar"]`
///
/// 引号本身不入 token；引号外的 `{` 与 `}` **被丢弃**（既不成 token 也不当分隔符），
/// 因此纯花括号行得到**空 `Vec`**。
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

/// 解析 `.vmt` 文本，提取 `$basetexture`、透明度标注、自发光标记与 `include`。
///
/// **扁平扫描，不建 KeyValues 树**：块结构（`Proxies`、`>=DX90` 等）被忽略，
/// 块内的键与顶层键同等对待，同名键取**首次命中**。
///
/// 行切分同时按 `\n` 与 `\r`（`split(['\n', '\r'])`）——只按 `\n` 切会把孤立 CR
/// 两侧的内容并成一行，见单元测试 `parses_basetexture_across_lone_cr`。
pub fn parse_vmt(text: &str) -> VmtInfo {
    let mut info = VmtInfo::default();
    let mut translucent = false;
    let mut alphatest = false;
    let mut unlit = false;

    // 行尾必须按 `\r` / `\n` **都切**：`str::lines()` 只认 `\n`，孤立 CR 会把相邻两行
    // 并成一行，于是 `toks[0]` 变成前一行的键 ⇒ 取不到 `$basetexture`。本文件用
    // `split(['\n', '\r'])` 规避，回归用例见 `parses_basetexture_across_lone_cr`。
    for raw in text.split(['\n', '\r']) {
        // 行内**第一个** `//` 起全部截断；引号内的 `//` 也照截（VMT 里 `//` 只作注释）
        let line = match raw.find("//") {
            Some(i) => &raw[..i],
            None => raw,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let toks = tokenize_kv(line);
        // 纯 `{` / `}` 行经分词得到空数组，必须先挡空：否则下面的 `toks[0]` 越界
        if toks.is_empty() {
            continue;
        }
        if toks.len() < 2 {
            // 整行只剩一个 token 时才拿它当着色器名（`"UnlitGeneric"` 与
            // `UnlitGeneric {` 都归一成 1 个 token）。同一行还写了别的键时走不到这里，
            // 那种写法下着色器名不参与 unlit 判定。
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
                    // 只去首尾 `/` 与 `.vmt` 后缀；**不剥 `materials/` 前缀**——
                    // 前缀补全由 PakIndex::find 的候选列表负责
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
    // 优先级：Blend 压过 Mask；两者都无才是 Opaque
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
/// 两侧都归一化后比较：`build` 存小写键，`find` 把查询串也转小写，因此条目名与查询串
/// 的大小写差异不影响命中。两个表都是**首个写入者胜**——同名条目只留第一次出现的原文。
pub struct PakIndex {
    /// `小写完整路径（含扩展名）` → 原始条目名
    by_path: HashMap<String, String>,
    /// `小写基名（不含目录，含扩展名）` → 原始条目名（不同目录同名只留首个）
    by_stem: HashMap<String, String>,
}

impl PakIndex {
    /// 从 PAKFILE 条目名列表构建索引。不改动入参；表里存的是**原始**条目名。
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

    /// 按路径查条目：先试 4 个候选（原样 / `materials/` / `models/` / `materials/models/`，
    /// 各补 `.{ext}`），都不中再退化成**只按基名**查（忽略目录层级）。
    /// 返回 `None` 表示索引里没有这个条目。返回的是原始条目名（保留原始大小写）。
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

/// 右手系叉积 `a × b`。仅供 `quat_rotate` 使用。
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// 用四元数 `q = [x, y, z, w]`（实部在 `w`）旋转向量：`v' = v + 2·u×(u×v + s·v)`，
/// 其中 `u` 是虚部、`s` 是实部。**不归一化 `q`**，直接按单位四元数公式代入。
///
/// 与 `model_integrator` 的 `parse_angles_str` 产出的四元数配套（同一分量序）。
/// 调用点只有本文件的 `place_point`——`pub` 但工程侧无直接调用方。
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
/// `scale` 为 `None` 时取 `[1, 1, 1]`；`rotation` 为 `None` 时不旋转。
///
/// 变换链必须与 GLB 节点（`Node { translation, rotation, scale }`）**逐位一致**，
/// 二者的输入都来自同一份 `model_integrator::resolve_placements` 产出的 `Placement`
/// （`src/wasm-core/model_integrator/mod.rs` 的 `Placement` 处写着这条不变量），
/// 因此碰撞体不会相对显示模型产生偏移。
///
/// 调用方：两工程 `crates/wasm/src/lib.rs` 的 `export_model_tri_colliders` 与
/// `export_model_phy_colliders` 覆盖全部放置实例。
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

    /// 纯 `{` / `}` 行分词后是空数组，不得索引 `toks[0]`；同时验证
    /// `UnlitGeneric` 被认成 unlit、`$basetexture` 被取到（CRLF 文本）。
    #[test]
    fn brace_only_lines_do_not_panic() {
        let vmt = "\"UnlitGeneric\"\r\n{\r\n  \"$basetexture\" \"devneons/blue_neon\"\r\n}\r\n";
        let info = parse_vmt(vmt);
        assert_eq!(info.basetexture.as_deref(), Some("devneons/blue_neon"));
        assert!(info.unlit, "UnlitGeneric 应被标为自发光");
    }

    /// `$selfillum 1` 同样标成自发光——不依赖着色器名（着色器是 `LightmappedGeneric`）。
    #[test]
    fn selfillum_marks_unlit() {
        let vmt = "\"LightmappedGeneric\"\n{\n\t\"$basetexture\" \"x/y\"\n\t\"$selfillum\" \"1\"\n}\n";
        let info = parse_vmt(vmt);
        assert!(info.unlit);
        assert_eq!(info.basetexture.as_deref(), Some("x/y"));
    }

    /// 行间混用**孤立 CR**（无 `\n`）时仍要取到 `$basetexture`：若只按 `\n` 切，
    /// `$model 1` 会与 `"$basetexture" …` 并成一行，`toks[0]` 变成 `$model`。
    #[test]
    fn parses_basetexture_across_lone_cr() {
        let vmt = "\"UnlitGeneric\"\r\n{\r\n\t$model 1 \r  \"$basetexture\" \"devneons/blue_neon\"\r\n  \"$selfillum\" 1\r\n}\r\n";
        let info = parse_vmt(vmt);
        assert_eq!(info.basetexture.as_deref(), Some("devneons/blue_neon"));
    }
}
