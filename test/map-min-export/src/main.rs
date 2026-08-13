//! map-min-export — 地图最小导出测试
//!
//! 从 .bsp 导出「最小可视几何 + 碰撞 + 材质纹理」三件套，验证下游渲染/物理/材质
//! 所需的最小数据契约：
//!
//! ```text
//! <out>/
//! ├── geometry.glb      最小可视几何（scene::rebuild_scene：已剔除 SKY/TRIGGER/NODRAW/HINT/SKIP 不可见面）
//! ├── collision.json    碰撞（BRUSHES/BRUSHSIDES/PLANES → WasmBrush[]，与 game brushJson 同构）
//! ├── materials/        VMT 文本 + PNG（VTF 解码 DXT1/DXT3/DXT5/常见未压缩格式；失败兜底 .vtf 原样）
//! └── manifest.json     统计 + 逐材质元数据（vmt/vtf/png 路径、宽高、格式、备注）
//! ```
//!
//! 用法：
//! ```bash
//! cargo run --release -- maps/surf_666.bsp --out out/surf_666
//! ```

mod collision;
mod materials;
mod vtf;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use bsp_extract::BspFile;

fn usage() -> ! {
    eprintln!("用法: map-min-export <map.bsp> [--out <输出目录>]");
    eprintln!("  输出: geometry.glb / collision.json / materials/ / manifest.json");
    std::process::exit(2);
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(bsp_path) = args.next() else { usage() };
    let mut out_dir = PathBuf::from("out");

    while let Some(a) = args.next() {
        match a.as_str() {
            "--out" => match args.next() {
                Some(p) => out_dir = PathBuf::from(p),
                None => usage(),
            },
            "--help" | "-h" => usage(),
            _ => usage(),
        }
    }

    match run(&bsp_path, &out_dir) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("[ERROR] {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(bsp_path: &str, out_dir: &Path) -> Result<(), String> {
    println!("═══ map-min-export ═══");
    println!("BSP  : {bsp_path}");

    let bsp = BspFile::from_path(bsp_path).map_err(|e| e.to_string())?;
    println!(
        "版本 : v{} (mapRevision {}), 大小 {} MB",
        bsp.version(),
        bsp.map_revision(),
        std::fs::metadata(bsp_path)
            .map(|m| m.len() as f64 / 1e6)
            .unwrap_or(0.0)
    );
    std::fs::create_dir_all(out_dir).map_err(|e| format!("创建输出目录失败:{e}"))?;

    // ── 1. 最小可视几何（scene 已剔除不可见面）──
    let prims = bsp_extract::scene::rebuild_scene(&bsp).map_err(|e| e.to_string())?;
    let glb = bsp_extract::glb::build_glb(&prims, "min");
    let glb_path = out_dir.join("geometry.glb");
    std::fs::write(&glb_path, &glb).map_err(|e| e.to_string())?;

    let total_verts: usize = prims.iter().map(|p| p.vertices.len()).sum();
    let total_tris: usize = prims.iter().map(|p| p.indices.len() / 3).sum();
    println!(
        "几何 : {total_tris} 三角形 / {total_verts} 顶点 / {} 材质组 → {:.2} MB ({} 字节)",
        prims.len(),
        glb.len() as f64 / 1e6,
        glb.len()
    );

    // ── 2. 碰撞（brush 平面）──
    // 紧凑 JSON 直写：保留 f32 最短十进制（与 game brushJson 文本级一致；pretty 会经
    // Value 把 f32 展开为 f64 完整表示，破坏可对比性）
    let collision = collision::export_collision(&bsp).map_err(|e| e.to_string())?;
    let coll_value: serde_json::Value =
        serde_json::from_str(&collision).map_err(|e| e.to_string())?;
    let brushes = coll_value.as_array().map(|a| a.len()).unwrap_or(0);
    let planes: usize = coll_value
        .as_array()
        .map(|a| {
            a.iter()
                .map(|b| b["planes"].as_array().map(|p| p.len()).unwrap_or(0))
                .sum()
        })
        .unwrap_or(0);
    std::fs::write(out_dir.join("collision.json"), &collision).map_err(|e| e.to_string())?;
    println!("碰撞 : {brushes} brush / {planes} 平面 → collision.json");

    // ── 3. 材质纹理（VMT/VTF → PNG）──
    let mut mat_names: Vec<String> = prims
        .iter()
        .filter_map(|p| p.material.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    mat_names.sort();
    let mat_entries =
        materials::export_materials(&bsp, &mat_names, out_dir).map_err(|e| e.to_string())?;
    let with_png = mat_entries
        .iter()
        .filter(|m| {
            m["files"]
                .as_array()
                .map(|f| f.iter().any(|x| x.as_str().unwrap_or("").ends_with(".png")))
                .unwrap_or(false)
        })
        .count();
    let missing = mat_entries
        .iter()
        .filter(|m| {
            m["note"].is_string() && m["note"].as_str().unwrap_or("").contains("不在 PAKFILE")
        })
        .count();
    println!(
        "材质 : {} 个（{} 解码为 PNG，{} 个 PAKFILE 缺失）",
        mat_entries.len(),
        with_png,
        missing
    );

    // ── 4. manifest ──
    let manifest = serde_json::json!({
        "tool": "map-min-export",
        "bsp": bsp_path,
        "bspVersion": bsp.version(),
        "mapRevision": bsp.map_revision(),
        "geometry": {
            "file": "geometry.glb",
            "bytes": glb.len(),
            "materialGroups": prims.len(),
            "vertices": total_verts,
            "triangles": total_tris,
            "note": "scene::rebuild_scene：已剔除 SKY/TRIGGER/NODRAW/HINT/SKIP 不可见面（最小可视几何）",
        },
        "collision": {
            "file": "collision.json",
            "brushes": brushes,
            "planes": planes,
            "note": "WasmBrush[]：{planes,min,max,is_ladder,is_solid}，与 game brushJson 契约同构",
        },
        "materials": mat_entries,
    });
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(out_dir.join("manifest.json"), &manifest_json).map_err(|e| e.to_string())?;

    println!("输出 : {}", out_dir.display());
    println!("═══ 完成 ═══");
    Ok(())
}
