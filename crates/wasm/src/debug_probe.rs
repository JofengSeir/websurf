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
fn probe_phy_stats() {
    // 全量统计 surf_666 的 .phy 覆盖率：解析成功 / 静态可用（bone==0） / modelType 分布。
    let data = match std::fs::read(BSP_PATH) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("跳过：无法读取 {BSP_PATH}: {e}");
            return;
        }
    };
    let bsp = crate::vbsp::Bsp::read(&data).expect("BSP 解析失败");
    let (models, _props, entry_names) = crate::collect_pakfile_models(&bsp).expect("collect");
    let index = crate::pakfile_models::PakIndex::build(&entry_names);

    let mut has_phy = 0usize;
    let mut parsed_ok = 0usize;
    let mut static_ok = 0usize; // bone==0 凸体 > 0
    let mut total_convex = 0usize;
    let mut total_tris = 0usize;
    let mut total_verts = 0usize;
    let mut modeltype_nonzero = 0usize;
    let mut sphandled = 0usize;
    let mut sample: Vec<(String, usize, String)> = Vec::new();

    for m in &models {
        let phy_name = m.name.replace(".mdl", ".phy");
        let Ok(Some(phy_bytes)) = bsp.pack.get(&phy_name) else {
            continue;
        };
        has_phy += 1;
        match crate::phyfile::parse_phy(&phy_bytes) {
            Ok(solids) => {
                parsed_ok += 1;
                let static_convex: usize = solids
                    .iter()
                    .map(|s| s.convexes.iter().filter(|c| c.bone_index == 0).count())
                    .sum();
                let all_tris: usize = solids
                    .iter()
                    .flat_map(|s| s.convexes.iter())
                    .map(|c| c.indices.len())
                    .sum();
                let all_verts: usize = solids
                    .iter()
                    .flat_map(|s| s.convexes.iter())
                    .map(|c| c.vertices.len())
                    .sum();
                total_convex += solids.iter().map(|s| s.convexes.len()).sum::<usize>();
                total_tris += all_tris;
                total_verts += all_verts;
                if static_convex > 0 {
                    static_ok += 1;
                }
                let sp = solids
                    .iter()
                    .find_map(|s| s.surfaceprop.clone())
                    .unwrap_or_default();
                if sample.len() < 6 {
                    sample.push((
                        m.name.clone(),
                        static_convex,
                        if sp.is_empty() { "?" } else { &sp }.to_string(),
                    ));
                }
            }
            Err(e) => {
                if e.to_string().contains("modelType") {
                    modeltype_nonzero += 1;
                }
                sphandled += 1;
            }
        }
    }

    println!(
        "== .phy 覆盖率: 模型总数={} 有 .phy={} 解析成功={} 静态可用(bone0)={}",
        models.len(),
        has_phy,
        parsed_ok,
        static_ok
    );
    println!(
        "   总凸体={total_convex} 总三角={total_tris} 总顶点={total_verts} modelType非0跳过={modeltype_nonzero} 其他失败={sphandled}"
    );
    for (name, convex, sp) in &sample {
        println!("   样例: {name} 静态凸体={convex} surfaceprop={sp}");
    }
}

#[test]
fn probe_phy_export() {
    // 端到端验证 export_model_phy_colliders 输出 JSON（真实 .phy → 世界空间凸包三角）。
    let data = match std::fs::read(BSP_PATH) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("跳过：无法读取 {BSP_PATH}: {e}");
            return;
        }
    };
    let proc = crate::BspProcessor::new(&data).expect("BspProcessor::new 失败");
    let json = proc.export_model_phy_colliders().expect("phy 导出失败");
    let arr: Vec<serde_json::Value> = serde_json::from_str(&json).expect("JSON 解析失败");
    println!("== export_model_phy_colliders: {} 个实例", arr.len());
    let mut total_tris = 0usize;
    for v in arr.iter().take(4) {
        let name = v["name"].as_str().unwrap_or("?");
        let sprop = v["surfaceprop"].as_str().unwrap_or("?");
        let verts = v["vertices"].as_array().map(|a| a.len()).unwrap_or(0);
        let tris = v["indices"].as_array().map(|a| a.len()).unwrap_or(0);
        total_tris += tris;
        println!("   {name} surfaceprop={sprop} 顶点={verts} 三角={tris}");
    }
    println!("   前 4 实例三角合计={total_tris}");
    assert!(!arr.is_empty(), "应有实例");
    // 顶点/索引必须为非空数组格式
    let first = &arr[0];
    assert!(first["vertices"].as_array().map(|a| !a.is_empty()).unwrap_or(false));
    assert!(first["indices"].as_array().map(|a| !a.is_empty()).unwrap_or(false));
}

/// 暴力搜索 PHY→显示 的坐标映射：6 置换 × 8 符号 = 48 种，选 AABB 重合度最高的。
/// 在 **Z-up 原始空间**（均不 map_coords）对比，排除 Y-up 映射干扰。
#[test]
fn probe_phy_mapping() {
    let data = match std::fs::read(BSP_PATH) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("跳过：无法读取 {BSP_PATH}: {e}");
            return;
        }
    };
    let bsp = crate::vbsp::Bsp::read(&data).expect("BSP 解析失败");
    let (models, _props, _names) = crate::collect_pakfile_models(&bsp).expect("collect");

    use std::collections::HashMap;
    let mut map_count: HashMap<(usize, i32), usize> = HashMap::new(); // (perm_idx, sign_bits)
    let perms = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];

    for m in &models {
        let phy_name = m.name.replace(".mdl", ".phy");
        let Ok(Some(phy_bytes)) = bsp.pack.get(&phy_name) else {
            continue;
        };
        let Ok(solids) = crate::phyfile::parse_phy(&phy_bytes) else {
            continue;
        };
        let Some(model) = crate::load_vmdl(m) else {
            continue;
        };
        // 显示 Z-up AABB（apply_root 后，不 map_coords）
        let mut dmin = [f32::INFINITY; 3];
        let mut dmax = [f32::NEG_INFINITY; 3];
        for v in model.vertices() {
            let p = model.apply_root_transform(v.position);
            for i in 0..3 {
                let c = if i == 0 { p.x } else if i == 1 { p.y } else { p.z };
                dmin[i] = dmin[i].min(c);
                dmax[i] = dmax[i].max(c);
            }
        }
        // PHY 顶点（HU，Z-up 原始）
        let mut phy_pts: Vec<[f32; 3]> = Vec::new();
        for s in &solids {
            for c in &s.convexes {
                if c.bone_index != 0 {
                    continue;
                }
                phy_pts.extend_from_slice(&c.vertices);
            }
        }
        if phy_pts.len() < 4 || !dmin.iter().all(|f| f.is_finite()) {
            continue;
        }
        // 显示尺寸
        let dsize = [
            dmax[0] - dmin[0],
            dmax[1] - dmin[1],
            dmax[2] - dmin[2],
        ];
        if dsize.iter().any(|s| *s <= 0.0) {
            continue;
        }
        // 对每种映射：变换后 AABB 与显示 AABB 各轴重叠比例（按显示尺寸归一）
        let mut best: Option<(usize, i32, f32)> = None;
        for (pi, perm) in perms.iter().enumerate() {
            for sign in 0..8 {
                let s0 = if sign & 1 == 0 { 1.0 } else { -1.0 };
                let s1 = if sign & 2 == 0 { 1.0 } else { -1.0 };
                let s2 = if sign & 4 == 0 { 1.0 } else { -1.0 };
                let mut mn = [f32::INFINITY; 3];
                let mut mx = [f32::NEG_INFINITY; 3];
                for v in &phy_pts {
                    let t = [s0 * v[perm[0]], s1 * v[perm[1]], s2 * v[perm[2]]];
                    for i in 0..3 {
                        mn[i] = mn[i].min(t[i]);
                        mx[i] = mx[i].max(t[i]);
                    }
                }
                // 计分：尺寸≥显示 55% 的轴按小/大比加分，越多轴对齐分越高
                let mut score = 0.0;
                let mut axes = 0;
                for i in 0..3 {
                    let tsize = mx[i] - mn[i];
                    if tsize <= 0.0 {
                        continue;
                    }
                    let big = dsize[i].max(tsize);
                    let small = dsize[i].min(tsize);
                    if small / big > 0.55 {
                        score += small / big;
                        axes += 1;
                    }
                }
                let score = score / 3.0 + axes as f32 * 0.5;
                if best.is_none() || score > best.as_ref().unwrap().2 {
                    best = Some((pi, sign, score));
                }
            }
        }
        let (pi, sign, score) = best.unwrap();
        if score > 1.5 {
            *map_count.entry((pi, sign)).or_insert(0) += 1;
        }
    }
    // 输出分布
    let mut v: Vec<_> = map_count.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1));
    println!("== PHY→显示 坐标映射分布（模型数）:");
    for ((pi, sign), n) in v {
        let perm = perms[pi];
        println!(
            "   perm=[{},{},{}] sign=({:+},{:+},{:+}) × {n}",
            perm[0],
            perm[1],
            perm[2],
            if sign & 1 == 0 { 1 } else { -1 },
            if sign & 2 == 0 { 1 } else { -1 },
            if sign & 4 == 0 { 1 } else { -1 },
        );
    }
}

#[test]
fn probe_phy_orientation() {
    // 对比「显示网格局部 AABB」vs「PHY 碰撞局部 AABB」，定位朝向差异（左偏 90° / 上下颠倒）。
    // 显示：local = map_coords(apply_root_transform(v))；PHY：local = map_coords(phy_vert × HU)。
    // 若 PHY 与显示同空间，两者 AABB 轴对齐应一致（PHY 为简化凸包，尺寸略小但朝向相同）。
    let data = match std::fs::read(BSP_PATH) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("跳过：无法读取 {BSP_PATH}: {e}");
            return;
        }
    };
    let bsp = crate::vbsp::Bsp::read(&data).expect("BSP 解析失败");
    let (models, _props, _names) = crate::collect_pakfile_models(&bsp).expect("collect");

    let mut bad = 0usize;
    let mut shown = 0usize;
    for m in &models {
        let phy_name = m.name.replace(".mdl", ".phy");
        let Ok(Some(phy_bytes)) = bsp.pack.get(&phy_name) else {
            continue;
        };
        let Ok(solids) = crate::phyfile::parse_phy(&phy_bytes) else {
            continue;
        };
        let Some(model) = crate::load_vmdl(m) else {
            continue;
        };
        // 显示局部 AABB（与 GLB 顶点同一变换链）
        let mut dmin = [f32::INFINITY; 3];
        let mut dmax = [f32::NEG_INFINITY; 3];
        let mut rmin = [f32::INFINITY; 3];
        let mut rmax = [f32::NEG_INFINITY; 3];
        for v in model.vertices() {
            let raw = map_coords(v.position);
            let p = map_coords(model.apply_root_transform(v.position));
            for i in 0..3 {
                rmin[i] = rmin[i].min(raw[i]);
                rmax[i] = rmax[i].max(raw[i]);
                dmin[i] = dmin[i].min(p[i]);
                dmax[i] = dmax[i].max(p[i]);
            }
        }
        // PHY 局部 AABB（bone==0 凸体，当前导出链路）
        let mut pmin = [f32::INFINITY; 3];
        let mut pmax = [f32::NEG_INFINITY; 3];
        let mut has_bone0 = false;
        for s in &solids {
            for c in &s.convexes {
                if c.bone_index != 0 {
                    continue;
                }
                has_bone0 = true;
                for v in &c.vertices {
                    // 修复后链路：IVP→Source 绕 x 轴 90°（x, z, -y）+ 根骨骼变换
                    let ivp2src = [v[0], v[2], -v[1]];
                    let rt = model.apply_root_transform(vmdl::Vector {
                        x: ivp2src[0],
                        y: ivp2src[1],
                        z: ivp2src[2],
                    });
                    let p = map_coords([rt.x, rt.y, rt.z]);
                    for i in 0..3 {
                        pmin[i] = pmin[i].min(p[i]);
                        pmax[i] = pmax[i].max(p[i]);
                    }
                }
            }
        }
        if !has_bone0 {
            continue;
        }
        // 各轴尺寸
        let ds = [
            dmax[0] - dmin[0],
            dmax[1] - dmin[1],
            dmax[2] - dmin[2],
        ];
        let ps = [
            pmax[0] - pmin[0],
            pmax[1] - pmin[1],
            pmax[2] - pmin[2],
        ];
        // 轴一致性：PHY 每根轴的尺寸应≈显示的某根轴（误差 15%）
        let ok = (0..3).all(|i| {
            (0..3).any(|j| {
                let big = ds[j].max(ps[i]);
                let small = ds[j].min(ps[i]);
                small > 0.0 && (big - small) / big < 0.15
            })
        });
        if !ok || shown < 6 {
            println!(
                "{}{}",
                if ok { "  ok " } else { "BAD! " },
                m.name
            );
            println!(
                "     显示 x[{:.0},{:.0}] y[{:.0},{:.0}] z[{:.0},{:.0}] 尺寸({:.0},{:.0},{:.0})",
                dmin[0], dmax[0], dmin[1], dmax[1], dmin[2], dmax[2], ds[0], ds[1], ds[2]
            );
            println!(
                "     VVD原始 x[{:.0},{:.0}] y[{:.0},{:.0}] z[{:.0},{:.0}] 尺寸({:.0},{:.0},{:.0})",
                rmin[0], rmax[0], rmin[1], rmax[1], rmin[2], rmax[2],
                rmax[0] - rmin[0], rmax[1] - rmin[1], rmax[2] - rmin[2]
            );
            println!(
                "     PHY  x[{:.0},{:.0}] y[{:.0},{:.0}] z[{:.0},{:.0}] 尺寸({:.0},{:.0},{:.0})",
                pmin[0], pmax[0], pmin[1], pmax[1], pmin[2], pmax[2], ps[0], ps[1], ps[2]
            );
            shown += 1;
        }
        if !ok {
            bad += 1;
        }
    }
    println!("== 朝向异常模型数: {bad}");
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

/// 用蒙特卡洛估计 brush 的「实际实心体积」。
/// 按 cs-movement 约定（实体 = {x | dot(n,x) ≤ dist}）：bevel 存在时实体 = 整个 AABB 方块；
/// 去掉后实体 = 贴合多边形的薄壳，二者体积相差巨大，可直接量化修复前后差异。
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
