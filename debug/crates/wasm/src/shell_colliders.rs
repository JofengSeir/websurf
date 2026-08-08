//! 薄壳 brush 模型碰撞（debug 主工程特色功能，仅 debug 打包包含）。
//!
//! 提取自原 pakfile_models.rs 的「共面三角形合并 → 凸多边形 → 挤出成 brush」管线：
//! - 逐三角挤出 4.0 薄壳（export_model_colliders，>4096 三角回退整体 OBB）
//! - 与 export_brushes_planes 同构的输出（cs-movement 约定：法线朝外，内部在负侧）
//! game/ 精简版无此功能；共享解析层（websurf-wasm-core）亦不含。

use websurf_wasm_core::pakfile_models::{place_point, quat_rotate};
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

/// 把一个三角形按「几何法线朝外」的约定压入列表（必要时翻转缠绕）。
///
/// Source 的 VTX 条带缠绕在不同 studiomdl 版本间并不统一，直接拿
/// `cross(e1, e2)` 判定内外侧并不可靠；而 VVD 的**顶点法线**总是指向模型外部，
/// 用它作为基准最稳妥 —— 这直接决定后续 brush 的内/外侧是否正确。
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

/// 把已定向（顶点序 CCW 对应朝外法线）的三角转换成单三角 `ConvexFace`，
/// 供 `transform_face` + `face_to_brush` 处理。「以原始三角网格作为碰撞」的路径
/// 不做共面合并，每个三角就是一个薄壳 brush，碰撞拓扑与显示网格一一对应。
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
    // 【修复】build_convex_faces 合并共面三角后，部分面的顶点缠绕与面法线不匹配，
    // cross(edge, n) 会指向内侧 → 该侧面法线朝内（此前约 22% 的模型 brush 混入
    // 1 个朝内平面，物理上该面可穿透）。这里用多边形质心矫正方向：侧面法线必须
    // 指向远离质心的一侧（凸多边形质心必在 brush 内部），与顶点顺序无关。
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
    // 该函数会在每个面上追加「覆盖该面自身轴对齐 AABB」的 6 个平面，把倾斜/大面的
    // brush 撑成实心轴对齐方块。对薄斜坡（如 s2_ramp1），所有面 AABB 的并集 =
    // 模型整个包围盒，碰撞体变成填满包围盒的实心块，表现为「模型之外出现意外碰撞片」。
    // 本函数上方的侧面平面（按质心校正方向）已能完整闭合凸多边形 cap，
    // 闭合不再依赖轴对齐 bevel；如需缓解 box trace 棱角挂住，应在模型整体层面
    // 做小幅统一外扩，而不是逐面撑到 AABB。
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