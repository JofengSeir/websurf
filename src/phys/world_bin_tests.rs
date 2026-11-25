//! WSBW v1 编解码与「JSON 世界 ≡ 二进制世界」等价性测试。
//!
//! 覆盖四类风险：
//! 1. **位级格式**：头/记录布局写死成期望字节，防字段顺序或宽度漂移；
//! 2. **非法输入**：截断、尾随、错 magic/版本、计数归属错、坏 UTF-8、索引越界、
//!    未定义 flags、荒谬计数 —— 全部返回 `WorldBinError` 且不 panic、不分配巨量内存；
//! 3. **真实地图夹具**：surf_666 的 48 个真实 brush / 4 个真实 tri mesh 往返；
//! 4. **两条建造路径等价**：同一份数据分别走 `build_world`（JSON）与
//!    `build_world_binary`（WSBW），World / Player / spawn 在 f64 层逐位相同。
//!
//! 整图（surf_666 / ze_cursed）对照需要本机生成的全量夹具：把
//! `WEBSURF_PHYS_PARITY_DIR` 指到含 `*.json`（键：brushJson / triJson /
//! teleportJson / spawn）的目录即可启用；未设置时该测试打印 SKIP 并返回，
//! CI 无需地图文件。

use super::{parse_brushes, parse_tri_meshes};
use crate::phys::world::{Plane, TriMesh, V3};
use crate::phys::{
    world_bin::{
        decode_brushes, decode_tri_meshes, encode_brushes, encode_tri_meshes, WorldBinError,
        HEADER_LEN, MAGIC, VERSION,
    },
    PhysBrush, PhysPlane, PhysWorld,
};
use serde_json::json;

const SURF666_BRUSHES: &str = include_str!("testdata/surf_666_brushes.json");
const SURF666_TRIS: &str = include_str!("testdata/surf_666_tri_meshes.json");
const TELEPORTS: &str = "{\"teleports\":[],\"triggers\":[]}";

// ---------------------------------------------------------------------------
// 夹具构造
// ---------------------------------------------------------------------------

fn plane(normal: [f32; 3], dist: f32) -> PhysPlane {
    PhysPlane { normal, dist }
}

/// 轴对齐盒子 brush（法线朝外，与 wasm 导出同一约定）。
fn box_brush(min: [f32; 3], max: [f32; 3], entity: i32, is_ladder: bool, start_solid: bool) -> PhysBrush {
    PhysBrush {
        planes: vec![
            plane([0.0, 1.0, 0.0], max[1]),
            plane([0.0, -1.0, 0.0], -min[1]),
            plane([1.0, 0.0, 0.0], max[0]),
            plane([-1.0, 0.0, 0.0], -min[0]),
            plane([0.0, 0.0, 1.0], max[2]),
            plane([0.0, 0.0, -1.0], -min[2]),
        ],
        min,
        max,
        is_ladder,
        is_solid: true,
        entity,
        start_solid,
    }
}

fn tri_mesh(name: &str, vertices: Vec<V3>, indices: Vec<[u32; 3]>) -> TriMesh {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for v in &vertices {
        for axis in 0..3 {
            min[axis] = min[axis].min(v[axis]);
            max[axis] = max[axis].max(v[axis]);
        }
    }
    TriMesh {
        name: name.to_string(),
        vertices,
        indices,
        min,
        max,
    }
}

fn brushes_to_json(brushes: &[PhysBrush]) -> String {
    let value: Vec<serde_json::Value> = brushes
        .iter()
        .map(|b| {
            json!({
                "planes": b.planes.iter().map(|p| json!({"normal": p.normal, "dist": p.dist})).collect::<Vec<_>>(),
                "min": b.min,
                "max": b.max,
                "is_ladder": b.is_ladder,
                "is_solid": b.is_solid,
                "entity": b.entity,
                "start_solid": b.start_solid,
            })
        })
        .collect();
    serde_json::to_string(&value).expect("brush JSON 序列化失败")
}

fn tris_to_json(tris: &[TriMesh]) -> String {
    let value: Vec<serde_json::Value> = tris
        .iter()
        .map(|m| {
            json!({
                "name": m.name,
                "vertices": m.vertices,
                "indices": m.indices,
                "min": m.min,
                "max": m.max,
            })
        })
        .collect();
    serde_json::to_string(&value).expect("tri JSON 序列化失败")
}

fn json_world(brushes: &[PhysBrush], tris: &[TriMesh], spawn: [f64; 3], yaw: f64) -> PhysWorld {
    let mut world = PhysWorld::new();
    world
        .build_world(
            &brushes_to_json(brushes),
            &tris_to_json(tris),
            TELEPORTS,
            spawn[0],
            spawn[1],
            spawn[2],
            yaw,
        )
        .expect("JSON build_world 失败");
    world
}

fn binary_world(brushes: &[PhysBrush], tris: &[TriMesh], spawn: [f64; 3], yaw: f64) -> PhysWorld {
    let brush_bin = encode_brushes(brushes).expect("编码 brush 失败");
    let tri_bin = encode_tri_meshes(tris).expect("编码 tri 失败");
    let mut world = PhysWorld::new();
    world
        .build_world_binary(
            &brush_bin,
            &tri_bin,
            TELEPORTS,
            spawn[0],
            spawn[1],
            spawn[2],
            yaw,
        )
        .expect("binary build_world 失败");
    world
}

// ---------------------------------------------------------------------------
// 位级等价断言
// ---------------------------------------------------------------------------

fn assert_same_f64(a: f64, b: f64, what: &str) {
    assert_eq!(a.to_bits(), b.to_bits(), "{what}: {a:?} 与 {b:?} 不是逐位相同");
}

fn assert_same_v3(a: V3, b: V3, what: &str) {
    for axis in 0..3 {
        assert_same_f64(a[axis], b[axis], &format!("{what}[{axis}]"));
    }
}

fn assert_same_brush(a: &PhysBrush, b: &PhysBrush, what: &str) {
    assert_eq!(a.entity, b.entity, "{what}: entity");
    assert_eq!(a.is_solid, b.is_solid, "{what}: is_solid");
    assert_eq!(a.is_ladder, b.is_ladder, "{what}: is_ladder");
    assert_eq!(a.start_solid, b.start_solid, "{what}: start_solid");
    for axis in 0..3 {
        assert_eq!(a.min[axis].to_bits(), b.min[axis].to_bits(), "{what}: min[{axis}]");
        assert_eq!(a.max[axis].to_bits(), b.max[axis].to_bits(), "{what}: max[{axis}]");
    }
    assert_eq!(a.planes.len(), b.planes.len(), "{what}: plane_count");
    for (i, (p, q)) in a.planes.iter().zip(b.planes.iter()).enumerate() {
        for axis in 0..3 {
            assert_eq!(
                p.normal[axis].to_bits(),
                q.normal[axis].to_bits(),
                "{what}: plane[{i}].normal[{axis}]"
            );
        }
        assert_eq!(p.dist.to_bits(), q.dist.to_bits(), "{what}: plane[{i}].dist");
    }
}

fn assert_same_tri_mesh(a: &TriMesh, b: &TriMesh, what: &str) {
    assert_eq!(a.name, b.name, "{what}: name");
    assert_eq!(a.vertices.len(), b.vertices.len(), "{what}: vertex_count");
    for (i, (v, w)) in a.vertices.iter().zip(b.vertices.iter()).enumerate() {
        assert_same_v3(*v, *w, &format!("{what}.vertices[{i}]"));
    }
    assert_eq!(a.indices, b.indices, "{what}: indices");
    assert_same_v3(a.min, b.min, &format!("{what}.min"));
    assert_same_v3(a.max, b.max, &format!("{what}.max"));
}

fn assert_same_plane(a: &Plane, b: &Plane, what: &str) {
    assert_same_v3(a.normal, b.normal, &format!("{what}.normal"));
    assert_same_f64(a.dist, b.dist, &format!("{what}.dist"));
}

/// 两个 World 的碰撞数据逐位相同。
fn assert_worlds_identical(a: &PhysWorld, b: &PhysWorld) {
    assert_eq!(a.ready, b.ready, "ready");
    assert_same_v3(a.spawn, b.spawn, "spawn");
    assert_same_v3(a.player.origin, b.player.origin, "player.origin");
    assert_same_v3(a.player.prev_origin, b.player.prev_origin, "player.prev_origin");
    assert_same_f64(a.player.yaw, b.player.yaw, "player.yaw");
    assert_eq!(a.world.entity_solid, b.world.entity_solid, "entity_solid");

    assert_eq!(a.world.solids.len(), b.world.solids.len(), "solids 数量");
    for (i, (x, y)) in a.world.solids.iter().zip(b.world.solids.iter()).enumerate() {
        assert_eq!(x.entity, y.entity, "solids[{i}].entity");
        assert_same_v3(x.min, y.min, &format!("solids[{i}].min"));
        assert_same_v3(x.max, y.max, &format!("solids[{i}].max"));
        assert_eq!(x.planes.len(), y.planes.len(), "solids[{i}].planes 数量");
        for (j, (p, q)) in x.planes.iter().zip(y.planes.iter()).enumerate() {
            assert_same_plane(p, q, &format!("solids[{i}].planes[{j}]"));
        }
    }

    assert_eq!(a.world.ladders.len(), b.world.ladders.len(), "ladders 数量");
    for (i, (x, y)) in a.world.ladders.iter().zip(b.world.ladders.iter()).enumerate() {
        assert_eq!(x.entity, y.entity, "ladders[{i}].entity");
        assert_same_v3(x.min, y.min, &format!("ladders[{i}].min"));
        assert_same_v3(x.max, y.max, &format!("ladders[{i}].max"));
        assert_same_v3(x.facing, y.facing, &format!("ladders[{i}].facing"));
        assert_eq!(x.planes.len(), y.planes.len(), "ladders[{i}].planes 数量");
        for (j, (p, q)) in x.planes.iter().zip(y.planes.iter()).enumerate() {
            assert_same_plane(p, q, &format!("ladders[{i}].planes[{j}]"));
        }
    }

    assert_eq!(a.world.tri_meshes.len(), b.world.tri_meshes.len(), "tri_meshes 数量");
    for (i, (x, y)) in a
        .world
        .tri_meshes
        .iter()
        .zip(b.world.tri_meshes.iter())
        .enumerate()
    {
        assert_same_tri_mesh(x, y, &format!("tri_meshes[{i}]"));
    }
}

// ---------------------------------------------------------------------------
// 1. 位级格式
// ---------------------------------------------------------------------------

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn f32_at(bytes: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

#[test]
fn brush_header_layout_is_stable() {
    let brush = box_brush([1.0, 2.0, 3.0], [4.0, 5.0, 6.0], -1, false, true);
    let bytes = encode_brushes(&[brush]).expect("编码失败");
    assert_eq!(bytes.len(), HEADER_LEN + 36 + 6 * 16);
    assert_eq!(&bytes[0..4], b"WSBW");
    assert_eq!(u32_at(&bytes, 4), VERSION);
    assert_eq!(u32_at(&bytes, 8), 1, "brush_count");
    assert_eq!(u32_at(&bytes, 12), 0, "tri_mesh_count 必须为 0");

    let mut cursor = HEADER_LEN;
    assert_eq!(u32_at(&bytes, cursor) as i32, -1, "entity");
    cursor += 4;
    assert_eq!(bytes[cursor], 0b0000_0101, "flags: solid | start_solid");
    cursor += 1;
    assert_eq!(&bytes[cursor..cursor + 3], &[0, 0, 0], "padding");
    cursor += 3;
    for (axis, expected) in [1.0f32, 2.0, 3.0].iter().enumerate() {
        assert_eq!(f32_at(&bytes, cursor + axis * 4).to_bits(), expected.to_bits(), "min[{axis}]");
    }
    cursor += 12;
    for (axis, expected) in [4.0f32, 5.0, 6.0].iter().enumerate() {
        assert_eq!(f32_at(&bytes, cursor + axis * 4).to_bits(), expected.to_bits(), "max[{axis}]");
    }
    cursor += 12;
    assert_eq!(u32_at(&bytes, cursor), 6, "plane_count");
    cursor += 4;
    // 首面 = +Y：normal (0,1,0)，dist = 5
    assert_eq!(f32_at(&bytes, cursor), 0.0);
    assert_eq!(f32_at(&bytes, cursor + 4), 1.0);
    assert_eq!(f32_at(&bytes, cursor + 8), 0.0);
    assert_eq!(f32_at(&bytes, cursor + 12), 5.0);
}

#[test]
fn tri_header_layout_is_stable() {
    let mesh = tri_mesh("ab", vec![[0.0, 1.0, 2.0]], vec![]);
    let bytes = encode_tri_meshes(&[mesh]).expect("编码失败");
    assert_eq!(bytes.len(), HEADER_LEN + 4 + 2 + 12 + 12 + 4 + 4 + 12);
    assert_eq!(&bytes[0..4], MAGIC);
    assert_eq!(u32_at(&bytes, 4), VERSION);
    assert_eq!(u32_at(&bytes, 8), 0, "brush_count 必须为 0");
    assert_eq!(u32_at(&bytes, 12), 1, "tri_mesh_count");
    assert_eq!(u32_at(&bytes, 16), 2, "name_len");
    assert_eq!(&bytes[20..22], b"ab");
    let mut cursor = 22;
    // min 22..34、max 34..46（单顶点网格两者相同）
    for block in ["min", "max"] {
        assert_eq!(f32_at(&bytes, cursor), 0.0, "{block}[0]");
        assert_eq!(f32_at(&bytes, cursor + 4), 1.0, "{block}[1]");
        assert_eq!(f32_at(&bytes, cursor + 8), 2.0, "{block}[2]");
        cursor += 12;
    }
    assert_eq!(u32_at(&bytes, cursor), 1, "vertex_count");
    assert_eq!(u32_at(&bytes, cursor + 4), 0, "index_count");
    cursor += 8;
    assert_eq!(f32_at(&bytes, cursor), 0.0);
    cursor += 12;
    assert_eq!(cursor, bytes.len(), "游标必须正好走到缓冲区末尾");
}

#[test]
fn empty_lists_roundtrip() {
    let brush_bytes = encode_brushes(&[]).expect("编码空 brush 失败");
    assert_eq!(brush_bytes.len(), HEADER_LEN);
    assert_eq!(decode_brushes(&brush_bytes).expect("解码空 brush 失败").len(), 0);

    let tri_bytes = encode_tri_meshes(&[]).expect("编码空 tri 失败");
    assert_eq!(tri_bytes.len(), HEADER_LEN);
    assert_eq!(decode_tri_meshes(&tri_bytes).expect("解码空 tri 失败").len(), 0);
}

#[test]
fn brush_roundtrip_preserves_bits_and_flags() {
    let brushes = vec![
        box_brush([-8.0, -0.0, 1.5], [8.0, 32.0, 1.5], -1, false, true),
        box_brush([1.0, 2.0, 3.0], [4.0, 5.0, 6.0], 7, true, false),
        PhysBrush {
            planes: vec![],
            min: [f32::from_bits(1), -0.0, f32::MIN],
            max: [f32::from_bits(0x7f80_0001), 0.0, f32::MAX],
            is_ladder: true,
            is_solid: true,
            entity: i32::MIN,
            start_solid: true,
        },
    ];
    let bytes = encode_brushes(&brushes).expect("编码失败");
    let decoded = decode_brushes(&bytes).expect("解码失败");
    assert_eq!(decoded.len(), brushes.len());
    for (i, (a, b)) in brushes.iter().zip(decoded.iter()).enumerate() {
        assert_same_brush(a, b, &format!("brush[{i}]"));
    }
}

#[test]
fn tri_roundtrip_preserves_bits_and_unicode_name() {
    let meshes = vec![
        tri_mesh(
            "models/props_dojo/mapletree.mdl",
            vec![[0.0, 0.0, 0.0], [(1.0f32 / 3.0) as f64, 2.5, -0.0], [10.0, 20.0, 30.0]],
            vec![[0, 1, 2], [2, 1, 0]],
        ),
        tri_mesh("模型/树", vec![[f32::from_bits(1) as f64, 0.0, 0.0]], vec![]),
        tri_mesh("", vec![], vec![]),
    ];
    let bytes = encode_tri_meshes(&meshes).expect("编码失败");
    let decoded = decode_tri_meshes(&bytes).expect("解码失败");
    assert_eq!(decoded.len(), meshes.len());
    for (i, (a, b)) in meshes.iter().zip(decoded.iter()).enumerate() {
        assert_same_tri_mesh(a, b, &format!("tri[{i}]"));
    }
}

#[test]
fn each_buffer_rejects_the_other_kind() {
    let brush_bytes = encode_brushes(&[box_brush([0.0; 3], [1.0; 3], -1, false, true)]).unwrap();
    assert!(matches!(
        decode_tri_meshes(&brush_bytes),
        Err(WorldBinError::UnexpectedCount { brushes: 1, tri_meshes: 0 })
    ));
    let tri_bytes = encode_tri_meshes(&[tri_mesh("a", vec![[0.0; 3]], vec![])]).unwrap();
    assert!(matches!(
        decode_brushes(&tri_bytes),
        Err(WorldBinError::UnexpectedCount { brushes: 0, tri_meshes: 1 })
    ));
}

// ---------------------------------------------------------------------------
// 2. 非法输入
// ---------------------------------------------------------------------------

fn sample_buffers() -> (Vec<u8>, Vec<u8>) {
    let brushes = vec![
        box_brush([0.0, 0.0, 0.0], [16.0, 16.0, 16.0], -1, false, true),
        box_brush([32.0, 0.0, 0.0], [48.0, 16.0, 16.0], 3, true, false),
    ];
    let tris = vec![
        tri_mesh("a", vec![[0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], vec![[0, 1, 2]]),
        tri_mesh("bb", vec![[0.0; 3]], vec![]),
    ];
    (encode_brushes(&brushes).unwrap(), encode_tri_meshes(&tris).unwrap())
}

#[test]
fn truncated_buffer_never_decodes() {
    let (brush_bytes, tri_bytes) = sample_buffers();
    for len in 0..brush_bytes.len() {
        assert!(
            decode_brushes(&brush_bytes[..len]).is_err(),
            "brush 缓冲区截到 {len} 字节不应解码成功"
        );
    }
    for len in 0..tri_bytes.len() {
        assert!(
            decode_tri_meshes(&tri_bytes[..len]).is_err(),
            "tri 缓冲区截到 {len} 字节不应解码成功"
        );
    }
    assert!(matches!(
        decode_brushes(&brush_bytes[..HEADER_LEN - 1]),
        Err(WorldBinError::TooShort { .. })
    ));
}

#[test]
fn trailing_bytes_are_rejected() {
    let (mut brush_bytes, mut tri_bytes) = sample_buffers();
    brush_bytes.push(0);
    tri_bytes.push(0);
    assert!(matches!(
        decode_brushes(&brush_bytes),
        Err(WorldBinError::TrailingBytes { .. })
    ));
    assert!(matches!(
        decode_tri_meshes(&tri_bytes),
        Err(WorldBinError::TrailingBytes { .. })
    ));
}

#[test]
fn bad_magic_and_version_are_rejected() {
    let (mut brush_bytes, _) = sample_buffers();
    brush_bytes[0] = b'X';
    assert!(matches!(
        decode_brushes(&brush_bytes),
        Err(WorldBinError::BadMagic { .. })
    ));

    let (mut brush_bytes, _) = sample_buffers();
    brush_bytes[4..8].copy_from_slice(&(VERSION + 1).to_le_bytes());
    assert!(matches!(
        decode_brushes(&brush_bytes),
        Err(WorldBinError::UnsupportedVersion { got }) if got == VERSION + 1
    ));
}

#[test]
fn absurd_counts_do_not_allocate() {
    // 只有头、声称 40 亿条记录：必须在分配前按剩余长度拒绝。
    let mut header = Vec::new();
    header.extend_from_slice(&MAGIC);
    header.extend_from_slice(&VERSION.to_le_bytes());
    header.extend_from_slice(&u32::MAX.to_le_bytes());
    header.extend_from_slice(&0u32.to_le_bytes());
    assert!(matches!(
        decode_brushes(&header),
        Err(WorldBinError::Truncated { .. })
    ));

    let mut header = Vec::new();
    header.extend_from_slice(&MAGIC);
    header.extend_from_slice(&VERSION.to_le_bytes());
    header.extend_from_slice(&0u32.to_le_bytes());
    header.extend_from_slice(&u32::MAX.to_le_bytes());
    assert!(matches!(
        decode_tri_meshes(&header),
        Err(WorldBinError::Truncated { .. })
    ));
}

#[test]
fn invalid_utf8_and_out_of_range_index_are_rejected() {
    let tri_bytes = encode_tri_meshes(&[tri_mesh(
        "AB",
        vec![[0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        vec![[0, 1, 2]],
    )])
    .unwrap();

    let mut bad_name = tri_bytes.clone();
    bad_name[HEADER_LEN + 4] = 0xFF;
    assert!(matches!(
        decode_tri_meshes(&bad_name),
        Err(WorldBinError::InvalidUtf8)
    ));

    let mut bad_index = tri_bytes;
    let last = bad_index.len() - 12 + 8;
    bad_index[last..last + 4].copy_from_slice(&99u32.to_le_bytes());
    assert!(matches!(
        decode_tri_meshes(&bad_index),
        Err(WorldBinError::IndexOutOfBounds { index: 99, .. })
    ));
}

#[test]
fn invalid_flag_bits_are_rejected() {
    let (mut brush_bytes, _) = sample_buffers();
    brush_bytes[HEADER_LEN + 4] = 0b1000_0000;
    assert!(matches!(
        decode_brushes(&brush_bytes),
        Err(WorldBinError::InvalidFlags { flags: 0b1000_0000 })
    ));
}

#[test]
fn decoding_does_not_mutate_a_world() {
    let mut world = PhysWorld::new();
    let bad = b"not a wsBW buffer";
    assert!(world
        .build_world_binary_checked(bad, bad, TELEPORTS, 0.0, 0.0, 0.0, 0.0)
        .is_err());
    assert!(!world.ready);
    assert!(world.world.solids.is_empty());
}

// ---------------------------------------------------------------------------
// 3. 真实地图夹具
// ---------------------------------------------------------------------------

#[test]
fn real_surf666_fixture_roundtrips() {
    let brushes = parse_brushes(SURF666_BRUSHES).expect("解析真实 brush 夹具失败");
    assert!(!brushes.is_empty());
    let bytes = encode_brushes(&brushes).unwrap();
    let decoded = decode_brushes(&bytes).unwrap();
    assert_eq!(decoded.len(), brushes.len());
    for (i, (a, b)) in brushes.iter().zip(decoded.iter()).enumerate() {
        assert_same_brush(a, b, &format!("real brush[{i}]"));
    }

    let tris = parse_tri_meshes(SURF666_TRIS).expect("解析真实 tri 夹具失败");
    assert!(!tris.is_empty());
    let bytes = encode_tri_meshes(&tris).unwrap();
    let decoded = decode_tri_meshes(&bytes).unwrap();
    assert_eq!(decoded.len(), tris.len());
    for (i, (a, b)) in tris.iter().zip(decoded.iter()).enumerate() {
        assert_same_tri_mesh(a, b, &format!("real tri[{i}]"));
    }
}

// ---------------------------------------------------------------------------
// 4. 两条建造路径等价
// ---------------------------------------------------------------------------

#[test]
fn json_and_binary_build_identical_world_on_synthetic_map() {
    let brushes = vec![
        box_brush([-512.0, -64.0, -512.0], [512.0, 0.0, 512.0], -1, false, true),
        box_brush([100.0, 0.0, 100.0], [140.0, 80.0, 108.0], 2, true, true),
        box_brush([200.0, 0.0, 0.0], [232.0, 64.0, 32.0], 5, false, false),
    ];
    let tris = vec![
        tri_mesh(
            "models/props/ramp.mdl",
            vec![
                [-100.0, 8.0, -100.0],
                [100.0, 8.0, -100.0],
                [0.0, 8.0, 100.0],
            ],
            vec![[0, 1, 2]],
        ),
        tri_mesh(
            "模型/edge",
            vec![[-10.0, 16.0, 0.0], [10.0, 16.0, 0.0], [0.0, 24.0, 0.0]],
            vec![[0, 1, 2]],
        ),
    ];
    let spawn = [0.0, 32.0, 0.0];
    let json = json_world(&brushes, &tris, spawn, 90.0);
    let binary = binary_world(&brushes, &tris, spawn, 90.0);
    assert_worlds_identical(&json, &binary);
}

#[test]
fn json_and_binary_build_identical_world_on_real_fixtures() {
    let brushes = parse_brushes(SURF666_BRUSHES).expect("解析真实 brush 夹具失败");
    let tris = parse_tri_meshes(SURF666_TRIS).expect("解析真实 tri 夹具失败");
    let spawn = [0.0, 200.0, 0.0];
    let json = json_world(&brushes, &tris, spawn, 45.0);
    let binary = binary_world(&brushes, &tris, spawn, 45.0);
    assert_worlds_identical(&json, &binary);
}

/// 整图对照：设置 WEBSURF_PHYS_PARITY_DIR 后，对该目录下每个 *.json
/// （键 brushJson / triJson / teleportJson / spawn）跑两条建造路径。
#[test]
fn full_map_parity_from_local_fixtures() {
    let dir = match std::env::var("WEBSURF_PHYS_PARITY_DIR") {
        Ok(dir) => dir,
        Err(_) => {
            eprintln!("SKIP full_map_parity_from_local_fixtures：未设置 WEBSURF_PHYS_PARITY_DIR");
            return;
        }
    };
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("读取 {dir} 失败：{e}"))
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "{dir} 下没有 *.json 夹具");

    for path in paths {
        let raw = std::fs::read_to_string(&path).unwrap();
        let fixture: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let map = fixture["map"].as_str().unwrap_or("?");
        let brush_json = fixture["brushJson"].as_str().expect("缺 brushJson");
        let tri_json = fixture["triJson"].as_str().expect("缺 triJson");
        let teleport_json = fixture["teleportJson"].as_str().expect("缺 teleportJson");
        let spawn = &fixture["spawn"];
        let values = [
            spawn["x"].as_f64().expect("缺 spawn.x"),
            spawn["y"].as_f64().expect("缺 spawn.y"),
            spawn["z"].as_f64().expect("缺 spawn.z"),
            spawn["yawDeg"].as_f64().expect("缺 spawn.yawDeg"),
        ];

        let brushes = parse_brushes(brush_json).expect("解析 brushJson 失败");
        let tris = parse_tri_meshes(tri_json).expect("解析 triJson 失败");
        let brush_bin = encode_brushes(&brushes).unwrap();
        let tri_bin = encode_tri_meshes(&tris).unwrap();

        let mut json_world = PhysWorld::new();
        json_world
            .build_world(
                brush_json,
                tri_json,
                teleport_json,
                values[0],
                values[1],
                values[2],
                values[3],
            )
            .unwrap_or_else(|e| panic!("{map}: JSON build_world 失败：{e:?}"));
        let mut bin_world = PhysWorld::new();
        bin_world
            .build_world_binary(
                &brush_bin,
                &tri_bin,
                teleport_json,
                values[0],
                values[1],
                values[2],
                values[3],
            )
            .unwrap_or_else(|e| panic!("{map}: binary build_world 失败：{e:?}"));

        assert_worlds_identical(&json_world, &bin_world);
        eprintln!(
            "PARITY OK {map}: brushes={} tri_meshes={} brush_bin={} B tri_bin={} B",
            brushes.len(),
            tris.len(),
            brush_bin.len(),
            tri_bin.len()
        );
    }
}
