//! 仅在 `cargo test` 下编译的诊断探针（不进入 WASM 产物）。
//!
//! 用途：对真实 BSP 中的某个 PAKFILE 内嵌模型，复刻
//! [`crate::BspProcessor::export_model_colliders`] 的完整管线，
//! 逐步 dump 中间产物，定位「模型之外出现意外碰撞片」的根因。
//!
//! 运行：
//! ```text
//! cargo test --release -p websurf-wasm -- --nocapture probe_ramp
//! ```

#![allow(clippy::needless_range_loop)]

use crate::model_integrator::map_coords;
use crate::pakfile_models::{self as pk};

const BSP_PATH: &str = "../../maps/surf_666.bsp";
const TARGET: &str = "s2_ramp1";

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn len3(a: [f32; 3]) -> f32 {
    dot3(a, a).sqrt()
}

fn aabb_of(pts: impl Iterator<Item = [f32; 3]>) -> ([f32; 3], [f32; 3]) {
    let mut mn = [f32::INFINITY; 3];
    let mut mx = [f32::NEG_INFINITY; 3];
    for p in pts {
        for i in 0..3 {
            if p[i] < mn[i] {
                mn[i] = p[i];
            }
            if p[i] > mx[i] {
                mx[i] = p[i];
            }
        }
    }
    (mn, mx)
}

#[test]
fn probe_ramp() {
    let data = match std::fs::read(BSP_PATH) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("跳过：无法读取 {BSP_PATH}: {e}");
            return;
        }
    };
    let bsp = crate::vbsp::Bsp::read(&data).expect("BSP 解析失败");

    // ---------------- 1. 找到目标模型三件套 ----------------
    let zip = bsp.pack.clone().into_zip();
    let mut g = zip.lock().unwrap();
    let mut entry_names: Vec<String> = Vec::with_capacity(g.len());
    for i in 0..g.len() {
        if let Ok(e) = g.by_index(i) {
            entry_names.push(e.name().to_string());
        }
    }
    drop(g);

    // ---------------- 1.5 全模型 strip 类型统计 ----------------
    // 判断 PAKFILE 内模型以「三角形条带（IS_TRI_STRIP）」还是「三角形列表（IS_TRI_LIST）」
    // 存储网格 —— 条带模型受 vmdl 条带展开 bug 影响（本项目已 vendor 修复）。
    {
        use vmdl::vtx::StripFlags;
        let mut list_strips = 0usize;
        let mut strip_strips = 0usize;
        let mut with_strip_models = 0usize;
        for name in &entry_names {
            if !name.to_ascii_lowercase().ends_with(".dx90.vtx") {
                continue;
            }
            let Ok(Some(bytes)) = bsp.pack.get(name) else {
                continue;
            };
            let Ok(vtx) = vmdl::Vtx::read(&bytes) else {
                continue;
            };
            let mut model_has_strip = false;
            for part in &vtx.body_parts {
                for model in &part.models {
                    for lod in &model.lods {
                        for mesh in &lod.meshes {
                            for sg in &mesh.strip_groups {
                                for s in &sg.strips {
                                    if s.flags.contains(StripFlags::IS_TRI_STRIP) {
                                        strip_strips += 1;
                                        model_has_strip = true;
                                    } else {
                                        list_strips += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if model_has_strip {
                with_strip_models += 1;
            }
        }
        println!(
            "\n== PAKFILE 全部模型 strip 类型统计: list_strips={list_strips} strip_strips={strip_strips} 含条带的模型数={with_strip_models}"
        );
    }

    let mdl_entry = entry_names
        .iter()
        .find(|n| n.to_ascii_lowercase().contains(TARGET) && n.to_ascii_lowercase().ends_with(".mdl"))
        .cloned()
        .expect("PAKFILE 中未找到目标 .mdl");
    println!("== 目标模型: {mdl_entry}");

    let vvd_entry = mdl_entry.replace(".mdl", ".vvd");
    let vtx_entry = mdl_entry.replace(".mdl", ".dx90.vtx");
    let mdl_b = bsp.pack.get(&mdl_entry).unwrap().unwrap();
    let vvd_b = bsp.pack.get(&vvd_entry).unwrap().unwrap();
    let vtx_b = bsp.pack.get(&vtx_entry).unwrap().unwrap();
    println!(
        "   字节数 mdl={} vvd={} vtx={}",
        mdl_b.len(),
        vvd_b.len(),
        vtx_b.len()
    );

    let mdl = vmdl::Mdl::read(&mdl_b).expect("mdl");
    let vtx = vmdl::Vtx::read(&vtx_b).expect("vtx");
    let vvd = vmdl::Vvd::read(&vvd_b).expect("vvd");

    // ---------------- 2. VVD / VTX 结构概览 ----------------
    println!("\n== VVD 结构");
    println!("   header.lod_count       = {}", vvd.header.lod_count);
    println!("   vertices.len()         = {}", vvd.vertices.len());
    println!("   tangents.len()         = {}", vvd.tangents.len());

    println!("\n== MDL 结构");
    println!("   flags                  = {:?}", mdl.header.flags);
    println!("   bounding_box           = {:?}", mdl.header.bounding_box);
    println!("   body_parts             = {}", mdl.body_parts.len());
    for (bi, bp) in mdl.body_parts.iter().enumerate() {
        for (mi, m) in bp.models.iter().enumerate() {
            println!(
                "     bp[{bi}].model[{mi}] name={:?} vertex_offset={} meshes={}",
                m.name,
                m.vertex_offset,
                m.meshes.len()
            );
            for (ei, me) in m.meshes.iter().enumerate() {
                println!(
                    "        mesh[{ei}] material={} vertex_offset={}",
                    me.material, me.vertex_offset
                );
            }
        }
    }

    println!("\n== VTX 结构");
    for (bi, bp) in vtx.body_parts.iter().enumerate() {
        for (mi, m) in bp.models.iter().enumerate() {
            println!("     bp[{bi}].model[{mi}] lods={}", m.lods.len());
            if let Some(lod) = m.lods.first() {
                for (ei, me) in lod.meshes.iter().enumerate() {
                    println!(
                        "        lod0.mesh[{ei}] flags={:?} strip_groups={}",
                        me.flags,
                        me.strip_groups.len()
                    );
                    for (gi, sg) in me.strip_groups.iter().enumerate() {
                        println!(
                            "           sg[{gi}] flags={:?} verts={} indices={} strips={}",
                            sg.flags,
                            sg.vertices.len(),
                            sg.indices.len(),
                            sg.strips.len()
                        );
                        for (si, st) in sg.strips.iter().enumerate() {
                            let n = st.indices().count();
                            println!("              strip[{si}] flags={:?} emitted_idx={}", st.flags, n);
                        }
                    }
                }
            }
        }
    }

    let model = vmdl::Model::from_parts(mdl, vtx, vvd);

    // ---------------- 3. 局部顶点（与生产完全一致） ----------------
    let src = model.vertices();
    let mut local: Vec<[f32; 3]> = Vec::with_capacity(src.len());
    let mut normals: Vec<[f32; 3]> = Vec::with_capacity(src.len());
    for v in src {
        local.push(map_coords(model.apply_root_transform(v.position)));
        normals.push(map_coords(model.apply_root_transform(v.normal)));
    }
    let (vmin, vmax) = aabb_of(local.iter().copied());
    println!("\n== 局部顶点 AABB（Y-up, 全部 VVD 顶点）");
    println!("   min={vmin:?}\n   max={vmax:?}");

    // ---------------- 4. 展开三角（生产逻辑） ----------------
    let mut tris: Vec<[[f32; 3]; 3]> = Vec::new();
    let mut used_idx_min = usize::MAX;
    let mut used_idx_max = 0usize;
    let mut oob = 0usize;
    let mut degenerate = 0usize;
    let mut per_mesh: Vec<(usize, usize)> = Vec::new(); // (idx_count, tri_count)

    for mesh in model.meshes() {
        let idx: Vec<usize> = mesh.vertex_strip_indices().flatten().collect();
        let before = tris.len();
        for c in idx.chunks_exact(3) {
            let (a, b, d) = (c[0], c[1], c[2]);
            if a >= local.len() || b >= local.len() || d >= local.len() {
                oob += 1;
                continue;
            }
            used_idx_min = used_idx_min.min(a.min(b).min(d));
            used_idx_max = used_idx_max.max(a.max(b).max(d));
            if a == b || b == d || a == d {
                degenerate += 1;
            }
            let hint = [
                normals[a][0] + normals[b][0] + normals[d][0],
                normals[a][1] + normals[b][1] + normals[d][1],
                normals[a][2] + normals[b][2] + normals[d][2],
            ];
            pk::push_oriented_tri(&mut tris, [local[a], local[b], local[d]], hint);
        }
        per_mesh.push((idx.len(), tris.len() - before));
    }
    println!("\n== 三角展开");
    println!("   per_mesh(idx_count, tri_count) = {per_mesh:?}");
    println!("   tris={} 越界={} 退化={}", tris.len(), oob, degenerate);
    println!("   实际用到的顶点下标范围 = [{used_idx_min}, {used_idx_max}] / VVD 顶点数 {}", local.len());

    // 三角形边长分布：找出「跨越模型」的巨型三角
    let mut edges: Vec<f32> = Vec::new();
    for t in &tris {
        edges.push(len3(sub(t[1], t[0])));
        edges.push(len3(sub(t[2], t[1])));
        edges.push(len3(sub(t[0], t[2])));
    }
    edges.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f32| edges[((edges.len() - 1) as f32 * p) as usize];
    println!(
        "   边长分位: p50={:.2} p90={:.2} p99={:.2} max={:.2}",
        pct(0.5),
        pct(0.9),
        pct(0.99),
        edges[edges.len() - 1]
    );

    // ---------------- 7. 实例数 ----------------
    let static_props: Vec<crate::model_integrator::StaticProp> = bsp
        .static_props()
        .enumerate()
        .map(|(_i, p)| crate::model_integrator::StaticProp {
            model: p.model().to_string(),
            origin: [p.origin.x, p.origin.y, p.origin.z],
            angles: p.angles(),
            solid: p.solid as u8,
        })
        .collect();
    let no_ent: Vec<crate::model_integrator::Entity> = Vec::new();
    let placements = crate::model_integrator::resolve_placements(&mdl_entry, &no_ent, &static_props);
    println!("\n== 该模型在地图中的实例数 = {}", placements.len());
    for (i, p) in placements.iter().take(5).enumerate() {
        println!(
            "   [{i}] t={:?} rot={:?} scale={:?} solid={:?}",
            p.translation, p.rotation, p.scale, p.solid
        );
    }

    // ---------------- 8. 模型世界空间 AABB（供 [新方案] 逐三角验证对比） ----------------
    let p0 = &placements[0];
    let collider_thickness = 4.0f32;
    let (corners, _) = pk::placed_obb(vmin, vmax, p0.translation, p0.rotation, p0.scale);
    let (mw_min, mw_max) = aabb_of(corners.iter().copied());
    let mw_ext = [
        mw_max[0] - mw_min[0],
        mw_max[1] - mw_min[1],
        mw_max[2] - mw_min[2],
    ];
    let _mw_vol = mw_ext[0] * mw_ext[1] * mw_ext[2];

    // ---------------- 9. [新方案] 原始三角网格 → 逐三角薄壳 brush 验证 ----------------
    // 复刻 export_model_colliders 的新路径：跳过 build_convex_faces，每个三角直接
    // transform_face + face_to_brush。验证：① brush 数 == 三角数（逐面一一对应）；
    // ② 实心体积应为贴合表面的薄壳（比值≈1.0，而非填满方块）；③ 并集 AABB 不应≈模型 AABB。
    println!("\n== [新方案] 原始三角网格 → 逐三角薄壳 brush 验证");
    let mut raw_min = [f32::INFINITY; 3];
    let mut raw_max = [f32::NEG_INFINITY; 3];
    let mut raw_solid = 0.0f32;
    let mut raw_thin = 0.0f32;
    let mut raw_n = 0usize;
    for t in &tris {
        let face = pk::tri_to_face(*t);
        let Some((wv, wn)) = pk::transform_face(&face, p0.translation, p0.rotation, p0.scale) else {
            continue;
        };
        let Some(b) = pk::face_to_brush(&wv, wn, collider_thickness) else {
            continue;
        };
        raw_n += 1;
        raw_thin += poly_area(&wv) * collider_thickness;
        raw_solid += brush_solid_vol_estimate(&b, 20000, 0x51ed + raw_n as u64);
        for i in 0..3 {
            raw_min[i] = raw_min[i].min(b.min[i]);
            raw_max[i] = raw_max[i].max(b.max[i]);
        }
    }
    let raw_ext = [raw_max[0] - raw_min[0], raw_max[1] - raw_min[1], raw_max[2] - raw_min[2]];
    let raw_aabb_vol = raw_ext[0] * raw_ext[1] * raw_ext[2];
    let raw_match = (raw_ext[0] - mw_ext[0]).abs() < 8.0
        && (raw_ext[1] - mw_ext[1]).abs() < 8.0
        && (raw_ext[2] - mw_ext[2]).abs() < 8.0;
    println!(
        "   三角数 = {}  → brush 数 = {}   （二者相等 = 逐面一一对应）",
        tris.len(),
        raw_n
    );
    println!(
        "   全部 brush 并集 AABB = [{:.1}, {:.1}, {:.1}]  vol≈{:.1e} HU³",
        raw_ext[0], raw_ext[1], raw_ext[2], raw_aabb_vol
    );
    println!(
        "   → 并集 AABB ≈ 模型 AABB（即填满方块而非薄壳）: {}",
        if raw_match { "是 ⚠" } else { "否" }
    );
    println!(
        "   → 实际实心体积 ≈ {:.1e} HU³   理想薄壳 ≈ {:.1e} HU³   比值 ≈ {:.1}x  （>5x 说明仍过度膨胀）",
        raw_solid, raw_thin, raw_solid / raw_thin.max(1.0)
    );
}

/// 多边形面积（Newell 法，与 pakfile_models::newell_normal 同义）。
fn poly_area(verts: &[[f32; 3]]) -> f32 {
    0.5 * len3(newell_normal(verts))
}
fn newell_normal(v: &[[f32; 3]]) -> [f32; 3] {
    let mut n = [0.0f32; 3];
    let k = v.len();
    for i in 0..k {
        let a = v[i];
        let b = v[(i + 1) % k];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    n
}

/// 由 brush 的真实平面集合（cs-movement 约定：实体 = {x | dot(n,x) ≤ dist}）用蒙特卡洛
/// 估计「实际实心体积」。bevel 存在时实体 = 整个 AABB 方块；去掉后实体 = 贴合多边形的薄壳，
/// 二者体积相差巨大，此法可直接量化修复前后差异。
fn brush_solid_vol_estimate(b: &pk::BrushOut, m: u32, seed: u64) -> f32 {
    let ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    if ext[0] <= 0.0 || ext[1] <= 0.0 || ext[2] <= 0.0 {
        return 0.0;
    }
    let aabb_vol = ext[0] * ext[1] * ext[2];
    let mut s: u64 = seed;
    let mut rng = || {
        s = s.wrapping_mul(1664525).wrapping_add(1013904223);
        let r_bits = (s >> 8) & 0xFFFFFF; // 取低 24 位，保证落在 [0,1)
        (r_bits as f32) / 16_777_216.0
    };
    let mut inside = 0u32;
    for _ in 0..m {
        let p = [
            b.min[0] + rng() * ext[0],
            b.min[1] + rng() * ext[1],
            b.min[2] + rng() * ext[2],
        ];
        let mut ok = true;
        for pl in &b.planes {
            if dot3(pl.normal, p) > pl.dist + 1e-3 {
                ok = false;
                break;
            }
        }
        if ok {
            inside += 1;
        }
    }
    (inside as f32 / m as f32) * aabb_vol
}
