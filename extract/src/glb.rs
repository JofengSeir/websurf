//! glTF 2.0 二进制容器(GLB)写入器,零依赖手写实现。
//!
//! GLB 布局:
//! ```text
//! 0..4   "glTF"
//! 4..8   version = 2 (u32 LE)
//! 8..12  total length (u32 LE)
//! 12..   chunk0: length(u32) + "JSON" + JSON(空格填充到 4 字节对齐)
//!        chunk1: length(u32) + "BIN\0" + 二进制(0 填充到 4 字节对齐)
//! ```
//!
//! 场景模型:
//! - 单 buffer,内含所有 primitives 的顶点(position + uv 交错)+ 索引(u32)
//! - 每个 primitive 独立 vertex/index buffer view + accessor
//! - 材质仅带 name(后续可由上层关联贴图)

use serde_json::json;

/// 顶点布局:position(f32×3)+ uv(f32×2),共 20 字节。
#[derive(Debug, Clone, Copy)]
pub struct VertexData {
    pub position: [f32; 3],
    pub uv: [f32; 2],
}

/// 一个 primitive:顶点 + 索引 + 材质名。
#[derive(Debug, Clone)]
pub struct PrimitiveData {
    pub vertices: Vec<VertexData>,
    pub indices: Vec<u32>,
    /// 材质名(可空)。
    pub material: Option<String>,
}

/// 构建 GLB 字节。
pub fn build_glb(primitives: &[PrimitiveData], scene_name: &str) -> Vec<u8> {
    // ---- 1. 二进制 buffer ----
    let mut bin = Vec::new();
    let mut buffer_views = Vec::new(); // (offset, length, target)
    let mut accessors = Vec::new(); // (view_index, byte_offset, count, component_type, type_, min, max)
    let mut primitive_json = Vec::new();
    let mut material_names: Vec<String> = Vec::new();

    for prim in primitives {
        // 顶点区
        let vert_start = bin.len();
        for v in &prim.vertices {
            bin.extend_from_slice(&v.position[0].to_le_bytes());
            bin.extend_from_slice(&v.position[1].to_le_bytes());
            bin.extend_from_slice(&v.position[2].to_le_bytes());
            bin.extend_from_slice(&v.uv[0].to_le_bytes());
            bin.extend_from_slice(&v.uv[1].to_le_bytes());
        }
        let vert_len = prim.vertices.len() * size_of::<VertexData>();
        let (min, max) = bbox(&prim.vertices);
        let vert_view = buffer_views.len() as u32;
        buffer_views.push((vert_start, vert_len, 34962 /* ARRAY_BUFFER */));
        let vert_acc = accessors.len() as u32;
        accessors.push((vert_view, 0, prim.vertices.len() as u32, 5126 /* FLOAT */, "VEC3", Some(min), Some(max)));

        // UV accessor(同一 buffer view,偏移 12 字节)
        let uv_acc = accessors.len() as u32;
        accessors.push((vert_view, 12, prim.vertices.len() as u32, 5126, "VEC2", None, None));

        // 索引区
        let idx_start = bin.len();
        for i in &prim.indices {
            bin.extend_from_slice(&i.to_le_bytes());
        }
        let idx_len = prim.indices.len() * 4;
        let idx_view = buffer_views.len() as u32;
        buffer_views.push((idx_start, idx_len, 34963 /* ELEMENT_ARRAY_BUFFER */));
        let idx_acc = accessors.len() as u32;
        accessors.push((idx_view, 0, prim.indices.len() as u32, 5125 /* UNSIGNED_INT */, "SCALAR", None, None));

        // 材质
        let material_index = match &prim.material {
            Some(name) => {
                let idx = material_names.iter().position(|n| n == name);
                match idx {
                    Some(i) => Some(i as u32),
                    None => {
                        material_names.push(name.clone());
                        Some((material_names.len() - 1) as u32)
                    }
                }
            }
            None => None,
        };

        primitive_json.push(json!({
            "attributes": {
                "POSITION": vert_acc,
                "TEXCOORD_0": uv_acc,
            },
            "indices": idx_acc,
            "material": material_index,
            "mode": 4,
        }));
    }

    // ---- 2. JSON ----
    let json_obj = json!({
        "asset": { "version": "2.0", "generator": "bsp-extract" },
        "scene": 0,
        "scenes": [{ "nodes": [0] }],
        "nodes": [{ "mesh": 0, "name": scene_name }],
        "meshes": [{
            "primitives": primitive_json,
            "name": scene_name,
        }],
        "materials": material_names
            .iter()
            .map(|name| json!({ "name": name, "pbrMetallicRoughness": {
                "baseColorFactor": [0.8, 0.8, 0.8, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            }}))
            .collect::<Vec<_>>(),
        "buffers": [{ "byteLength": bin.len() }],
        "bufferViews": buffer_views
            .iter()
            .map(|(offset, len, target)| json!({ "buffer": 0, "byteOffset": offset, "byteLength": len, "target": target }))
            .collect::<Vec<_>>(),
        "accessors": accessors
            .iter()
            .map(|(view, byte_offset, count, ctype, ttype, min, max)| {
                let mut a = json!({
                    "bufferView": view,
                    "byteOffset": byte_offset,
                    "componentType": ctype,
                    "count": count,
                    "type": ttype,
                });
                if let Some(minv) = min {
                    a["min"] = json!(minv);
                }
                if let Some(maxv) = max {
                    a["max"] = json!(maxv);
                }
                a
            })
            .collect::<Vec<_>>(),
    });

    // JSON 序列化 + 空格填充到 4 字节对齐
    let mut json_bytes = serde_json::to_vec(&json_obj).unwrap();
    while !json_bytes.len().is_multiple_of(4) {
        json_bytes.push(b' ');
    }

    // ---- 3. 组装 GLB ----
    let mut out = Vec::new();
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());

    let bin_padded_len = pad4(bin.len());
    let total = 12 + 8 + json_bytes.len() + 8 + bin_padded_len;
    out.extend_from_slice(&(total as u32).to_le_bytes());

    // JSON chunk
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&json_bytes);

    // BIN chunk
    out.extend_from_slice(&(bin_padded_len as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\x00");
    out.extend_from_slice(&bin);
    while out.len() < total {
        out.push(0);
    }

    out
}

fn pad4(n: usize) -> usize {
    (n + 3) & !3
}

fn bbox(verts: &[VertexData]) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for v in verts {
        for i in 0..3 {
            min[i] = min[i].min(v.position[i]);
            max[i] = max[i].max(v.position[i]);
        }
    }
    (min, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glb_header_layout() {
        let prim = PrimitiveData {
            vertices: vec![
                VertexData { position: [0.0, 0.0, 0.0], uv: [0.0, 0.0] },
                VertexData { position: [1.0, 0.0, 0.0], uv: [1.0, 0.0] },
                VertexData { position: [0.0, 1.0, 0.0], uv: [0.0, 1.0] },
            ],
            indices: vec![0, 1, 2],
            material: Some("test_mat".into()),
        };
        let glb = build_glb(&[prim], "test");

        // 头 12 字节
        assert_eq!(&glb[0..4], b"glTF");
        assert_eq!(u32::from_le_bytes(glb[4..8].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(glb[8..12].try_into().unwrap()), glb.len() as u32);

        // JSON chunk
        let json_len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
        assert_eq!(&glb[16..20], b"JSON");
        let json: serde_json::Value = serde_json::from_slice(&glb[20..20 + json_len]).unwrap();
        assert_eq!(json["asset"]["version"], "2.0");
        assert_eq!(json["meshes"][0]["name"], "test");
        assert_eq!(json["materials"][0]["name"], "test_mat");

        // BIN chunk
        let bin_off = 20 + json_len;
        let bin_len = u32::from_le_bytes(glb[bin_off..bin_off + 4].try_into().unwrap()) as usize;
        assert_eq!(&glb[bin_off + 4..bin_off + 8], b"BIN\x00");
        // 顶点数据 3×(12+8)=60B + 索引 3×4=12B
        assert_eq!(bin_len, 72);
    }
}
