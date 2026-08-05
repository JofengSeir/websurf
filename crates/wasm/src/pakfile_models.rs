//! PAKFILE 内嵌模型的**材质解析**与**碰撞体生成**。
//!
//! Source 引擎的 BSP 会把地图用到的 `.mdl/.vvd/.vtx/.vmt/.vtf` 一并打进 PAKFILE lump。
//! 本模块负责在**无外部游戏资源**的前提下，仅凭 BSP 字节完成两件事：
//!
//! 1. **材质**：解析 `.vmt`（Source KeyValues 文本）取出 `$basetexture` 与透明度标注，
//!    再从 PAKFILE 找到对应 `.vtf` 解码成 PNG，交给 `model-integrator` 贴到 GLB 材质上。
//! 2. **碰撞体**：把模型的**可见三角网格**逐三角挤出成薄壳 brush（每个三角一个 brush，
//!    输出与 [`crate::BspProcessor::export_brushes_planes`] 完全同构的 `WasmBrush[]`，
//!    因此碰撞体与显示几何**逐面一致**（用户要求：「碰撞体积需要与模型显示的一致」）。
//!
//! ## 透明度的「内置标注」在哪
//!
//! Source 的透明度**确实有内置标注**，全部写在材质 `.vmt` 里：
//!
//! | VMT 键 | 含义 | 本模块映射 |
//! |---|---|---|
//! | `$translucent 1` | 逐像素混合半透明（玻璃、水幕） | alpha_mode = 1（Blend） |
//! | `$alpha <1` | 整体透明度 | alpha_mode = 1（Blend） |
//! | `$alphatest 1` | 二值镂空（铁丝网、树叶） | alpha_mode = 2（Mask） |
//! | 均未出现 | 不透明 | alpha_mode = 0（Opaque）→ **默认带碰撞** |
//!
//! 碰撞门控采用**保守**策略（与用户要求一致：没有标注就默认有碰撞）：
//! - 只有当模型**所有**材质都是 `Blend`（真半透明）时，才判定为「可穿过」而跳过碰撞；
//! - `$alphatest` 镂空材质（铁丝网/栅栏）在 Source 里本身就是实体，**保留碰撞**；
//! - 没有找到 `.vmt`（材质未打包）时按**不透明**处理，即**保留碰撞**。
//!
//! 另外 `static_prop` lump 自带 `solid`（`SolidType`）字段，其中 `0 = SOLID_NONE`
//! 是**明确无歧义**的「此道具无碰撞」标注，本模块尊重它；其余取值语义在各版本间
//! 不完全一致，故不用于门控（一律按有碰撞处理）。

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
    /// `Patch` 着色器的 `include` 目标（另一个 `.vmt` 的路径）。
    ///
    /// Source 的 `patch` 材质本身不含 `$basetexture`，只写
    /// `include "materials/xxx.vmt"` + 若干 `replace`/`insert` 覆盖项，
    /// 调用方需要再取一次被引用的 VMT 才能拿到真正的贴图。
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
/// 只做**扁平扫描**（不建 KeyValues 树）：VMT 的顶层参数几乎总在根块内，
/// 而 `Proxies`/`>=DX90` 等子块里出现的同名键取首次命中即可，足够稳健。
pub fn parse_vmt(text: &str) -> VmtInfo {
    let mut info = VmtInfo::default();
    let mut translucent = false;
    let mut alphatest = false;

    for raw in text.lines() {
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
        if toks.len() < 2 {
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
/// Source 资源路径大小写混乱（编译器写入时保留作者磁盘上的大小写，
/// 而 MDL 内记录的材质名往往是小写），必须做统一归一化才能可靠命中。
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

// ---------------------------------------------------------------------------
// 碰撞体：共面三角形合并 → 凸多边形 → 挤出成 brush
// ---------------------------------------------------------------------------

/// 与 `export_brushes_planes` 完全同构的输出平面（cs-movement 约定：法线朝外，内部在负侧）。
#[derive(serde::Serialize, Clone)]
pub struct BrushPlaneOut {
    pub normal: [f32; 3],
    pub dist: f32,
}

/// 与 `export_brushes_planes` 完全同构的输出 brush。
#[derive(serde::Serialize, Clone)]
pub struct BrushOut {
    pub planes: Vec<BrushPlaneOut>,
    pub min: [f32; 3],
    pub max: [f32; 3],
    pub is_ladder: bool,
    pub is_solid: bool,
}

/// 模型局部空间中的一个共面凸多边形（顶点按法线右手方向 CCW 排列）。
#[derive(Clone)]
pub struct ConvexFace {
    pub verts: Vec<[f32; 3]>,
    pub normal: [f32; 3],
}

#[inline]
fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
#[inline]
fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
fn norm(v: [f32; 3]) -> Option<[f32; 3]> {
    let l = dot3(v, v).sqrt();
    if !l.is_finite() || l < 1e-8 {
        None
    } else {
        Some([v[0] / l, v[1] / l, v[2] / l])
    }
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
///
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

/// 把一个三角形按「几何法线朝外」的约定压入列表（必要时翻转缠绕）。
///
/// Source 的 VTX 条带缠绕在不同 studiomdl 版本间并不统一，直接拿
/// `cross(e1, e2)` 判定内外侧并不可靠；而 VVD 的**顶点法线**总是朝向模型外部，
/// 用它作为基准最稳妥 —— 这直接决定了后续 brush 的内/外侧是否正确。
pub fn push_oriented_tri(
    out: &mut Vec<[[f32; 3]; 3]>,
    mut tri: [[f32; 3]; 3],
    normal_hint: [f32; 3],
) {
    let g = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
    if dot3(g, normal_hint) < 0.0 {
        tri.swap(1, 2);
    }
    out.push(tri);
}

/// 把一个已定向（顶点序 CCW 对应朝外法线）的三角转换成单三角 `ConvexFace`，
/// 供 `transform_face` + `face_to_brush` 直接处理。用于「以原始三角网格作为碰撞」的路径：
/// 不再做共面合并，每个三角就是一个薄壳 brush，使碰撞拓扑与显示网格一一对应。
pub fn tri_to_face(t: [[f32; 3]; 3]) -> ConvexFace {
    let n = match norm(cross(sub(t[1], t[0]), sub(t[2], t[0]))) {
        Some(n) => n,
        None => [0.0, 0.0, 0.0],
    };
    ConvexFace {
        verts: t.to_vec(),
        normal: n,
    }
}

/// 把**局部空间**的凸面按放置变换搬到世界空间，并重算朝外法线。
///
/// 不能直接旋转原法线：非等比缩放会让法线偏离真实法向。这里改为
/// ① 变换全部顶点 → ② Newell 法从变换后的多边形重算法线 →
/// ③ 用 `R · (S⁻¹ n)`（法线的正确变换）定符号，必要时反转顶点序。
///
/// 步骤 ③ 对**负缩放（镜像）**同样正确 —— 镜像会翻转缠绕，只看旋转后的
/// 原法线会得到朝内的结果。
pub fn transform_face(
    face: &ConvexFace,
    translation: [f32; 3],
    rotation: Option<[f32; 4]>,
    scale: Option<[f32; 3]>,
) -> Option<(Vec<[f32; 3]>, [f32; 3])> {
    if face.verts.len() < 3 {
        return None;
    }
    let mut verts: Vec<[f32; 3]> = face
        .verts
        .iter()
        .map(|v| place_point(*v, translation, rotation, scale))
        .collect();

    // 参考法线：R · (S⁻¹ n)
    let s = scale.unwrap_or([1.0, 1.0, 1.0]);
    let inv_scaled = [
        if s[0].abs() > 1e-6 { face.normal[0] / s[0] } else { face.normal[0] },
        if s[1].abs() > 1e-6 { face.normal[1] / s[1] } else { face.normal[1] },
        if s[2].abs() > 1e-6 { face.normal[2] / s[2] } else { face.normal[2] },
    ];
    let reference = match rotation {
        Some(q) => quat_rotate(q, inv_scaled),
        None => inv_scaled,
    };

    let newell = newell_normal(&verts);
    if dot3(newell, reference) < 0.0 {
        verts.reverse();
    }
    // 顶点序可能已反转，必须重算
    let n = norm(newell_normal(&verts))?;
    Some((verts, n))
}

/// Newell 法求多边形法线：对轻微非共面的多边形也稳定，且与顶点序（CCW/CW）绑定。
fn newell_normal(verts: &[[f32; 3]]) -> [f32; 3] {
    let mut n = [0.0f32; 3];
    let k = verts.len();
    for i in 0..k {
        let a = verts[i];
        let b = verts[(i + 1) % k];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    n
}

/// 由局部空间 AABB + 放置变换算出世界空间 OBB 的 8 个角点与 3 根轴。
pub fn placed_obb(
    lmin: [f32; 3],
    lmax: [f32; 3],
    translation: [f32; 3],
    rotation: Option<[f32; 4]>,
    scale: Option<[f32; 3]>,
) -> ([[f32; 3]; 8], [[f32; 3]; 3]) {
    let mut corners = [[0.0f32; 3]; 8];
    for (i, c) in corners.iter_mut().enumerate() {
        let local = [
            if i & 1 == 0 { lmin[0] } else { lmax[0] },
            if i & 2 == 0 { lmin[1] } else { lmax[1] },
            if i & 4 == 0 { lmin[2] } else { lmax[2] },
        ];
        *c = place_point(local, translation, rotation, scale);
    }
    let axes = match rotation {
        Some(q) => [
            quat_rotate(q, [1.0, 0.0, 0.0]),
            quat_rotate(q, [0.0, 1.0, 0.0]),
            quat_rotate(q, [0.0, 0.0, 1.0]),
        ],
        None => [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
    };
    (corners, axes)
}

/// 把一个**世界空间**凸多边形沿 `-normal` 挤出 `thickness`，生成凸壳 brush。
///
/// 输出直接采用 cs-movement 约定（法线朝外、内部在负侧），因此**不需要**像
/// `export_brushes_planes` 那样对 vbsp 的内向法线取负。
pub fn face_to_brush(verts: &[[f32; 3]], n: [f32; 3], thickness: f32) -> Option<BrushOut> {
    if verts.len() < 3 {
        return None;
    }

    let mut planes: Vec<BrushPlaneOut> = Vec::with_capacity(verts.len() + 8);

    // 正面：法线朝外 = 面法线；dist 取所有顶点投影的最大值（容忍微小非共面）
    let mut d_front = f32::NEG_INFINITY;
    for w in verts {
        d_front = d_front.max(dot3(n, *w));
    }
    planes.push(BrushPlaneOut {
        normal: n,
        dist: d_front,
    });
    // 背面：反向挤出 thickness
    planes.push(BrushPlaneOut {
        normal: [-n[0], -n[1], -n[2]],
        dist: -(d_front - thickness),
    });

    // 侧面：多边形按 n 右手 CCW 排列时，cross(edge, n) 指向外侧。
    // 【修复】build_convex_faces 合并共面三角后，部分面的顶点缠绕顺序与面法线
    // 不匹配，cross(edge, n) 会指向内侧 → 该侧面法线朝内（此前约 22% 的模型
    // brush 混入 1 个朝内平面，物理上该面可穿透）。这里用多边形质心矫正方向：
    // 侧面法线必须指向远离质心的一侧（凸多边形质心必在 brush 内部），
    // 与顶点顺序无关。
    let k = verts.len();
    let mut cx = 0.0f32;
    let mut cy = 0.0f32;
    let mut cz = 0.0f32;
    for w in verts {
        cx += w[0];
        cy += w[1];
        cz += w[2];
    }
    let inv_k = 1.0 / k as f32;
    cx *= inv_k;
    cy *= inv_k;
    cz *= inv_k;
    for i in 0..k {
        let a = verts[i];
        let b = verts[(i + 1) % k];
        let mut sn = match norm(cross(sub(b, a), n)) {
            Some(s) => s,
            None => continue,
        };
        // 边中点到质心的方向；法线应指向外侧（远离质心）
        let mid_to_c = [
            cx - (a[0] + b[0]) * 0.5,
            cy - (a[1] + b[1]) * 0.5,
            cz - (a[2] + b[2]) * 0.5,
        ];
        if dot3(sn, mid_to_c) > 0.0 {
            sn = [-sn[0], -sn[1], -sn[2]];
        }
        planes.push(BrushPlaneOut {
            normal: sn,
            dist: dot3(sn, a),
        });
    }

    if planes.len() < 4 {
        return None;
    }

    // AABB（正面 + 背面共 2k 个角点）
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for w in verts {
        let back = [
            w[0] - n[0] * thickness,
            w[1] - n[1] * thickness,
            w[2] - n[2] * thickness,
        ];
        for p in [w, &back] {
            for i in 0..3 {
                if p[i] < min[i] {
                    min[i] = p[i];
                }
                if p[i] > max[i] {
                    max[i] = p[i];
                }
            }
        }
    }
    if !min.iter().all(|f| f.is_finite()) || !max.iter().all(|f| f.is_finite()) {
        return None;
    }

    // 注意：不再调用 `push_axis_bevels`。
    // 该函数在每个面上追加「覆盖该面自身轴对齐 AABB」的 6 个平面，会把一个倾斜/大面的
    // brush 撑成实心的轴对齐方块。对薄斜坡（如 s2_ramp1）而言，所有面的 AABB 并集 =
    // 模型整个包围盒，于是碰撞体变成了填满包围盒的实心块，而非贴合表面的薄壳，
    // 表现为「模型之外出现意外碰撞片」。
    // 本函数上方的侧面平面（按质心校正方向）已能完整闭合凸多边形 cap，
    // 因此闭合不再依赖轴对齐 bevel；如需缓解 box trace 棱角挂住，应在模型整体层面
    // 做小幅度统一外扩，而不是逐面撑到 AABB。
    Some(BrushOut {
        planes,
        min,
        max,
        is_ladder: false,
        is_solid: true,
    })
}

/// 追加轴对齐 bevel 平面（等价 `brushFromOrientedBox` 的做法）。
///
/// 它们完全包住原凸体、不改变实体形状，但在 Minkowski 展开的 box trace 里
/// 能避免玩家 AABB 在倾斜面的棱角上「挂住」——对 surf 斜坡尤其关键。
fn push_axis_bevels(planes: &mut Vec<BrushPlaneOut>, min: [f32; 3], max: [f32; 3]) {
    let bevels = [
        ([1.0, 0.0, 0.0], max[0]),
        ([-1.0, 0.0, 0.0], -min[0]),
        ([0.0, 1.0, 0.0], max[1]),
        ([0.0, -1.0, 0.0], -min[1]),
        ([0.0, 0.0, 1.0], max[2]),
        ([0.0, 0.0, -1.0], -min[2]),
    ];
    for (bn, bd) in bevels {
        if planes.iter().any(|p| dot3(p.normal, bn) > 0.999) {
            continue;
        }
        planes.push(BrushPlaneOut {
            normal: bn,
            dist: bd,
        });
    }
}

/// 由 8 个世界空间角点构造有向包围盒（OBB）brush —— 面数超预算时的粗碰撞回退。
///
/// `axes` 为旋转后的三个正交单位轴（模型局部 x/y/z 在世界中的方向）。
pub fn obb_to_brush(corners: &[[f32; 3]; 8], axes: [[f32; 3]; 3]) -> Option<BrushOut> {
    let mut center = [0.0f32; 3];
    for c in corners {
        for i in 0..3 {
            center[i] += c[i] / 8.0;
        }
    }

    let mut planes: Vec<BrushPlaneOut> = Vec::with_capacity(12);
    for a in axes {
        let a = match norm(a) {
            Some(a) => a,
            None => return None,
        };
        let dc = dot3(a, center);
        let mut h: f32 = 0.0;
        for c in corners {
            h = h.max((dot3(a, *c) - dc).abs());
        }
        if h < 0.5 {
            h = 0.5; // 退化为平面时给个最小厚度，避免零体积 brush
        }
        planes.push(BrushPlaneOut {
            normal: a,
            dist: dc + h,
        });
        planes.push(BrushPlaneOut {
            normal: [-a[0], -a[1], -a[2]],
            dist: -(dc - h),
        });
    }

    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for c in corners {
        for i in 0..3 {
            if c[i] < min[i] {
                min[i] = c[i];
            }
            if c[i] > max[i] {
                max[i] = c[i];
            }
        }
    }
    if !min.iter().all(|f| f.is_finite()) || !max.iter().all(|f| f.is_finite()) {
        return None;
    }

    push_axis_bevels(&mut planes, min, max);
    Some(BrushOut {
        planes,
        min,
        max,
        is_ladder: false,
        is_solid: true,
    })
}

// ---------------------------------------------------------------------------
// 单元测试
