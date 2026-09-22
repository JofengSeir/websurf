//! BSP → GLB 的装配与导出入口（`bsp_to_gltf_core` 的对外主路径）。
//!
//! 两个公开入口：
//! - [`export_bsp`]：只用 BSP 自带资源导出；
//! - [`export_bsp_with_models`]：同上，并在传入 `ModelIntegrator` 时把模型合并进同一个 GLB。
//!
//! 两者都收 `Arc<Bsp>`：调用侧（三工程 `crates/wasm/src/lib.rs`）交出的是 `Arc` 克隆，故
//! **成功与失败都不消费实例**，同一个处理器可重复导出。
//!
//! 装配顺序（以 [`export_bsp_with_models`] 为准）：建根节点 → 光照图集
//! （[`build_lightmap_export`]）→ 模型合并（`model_integrator` 的
//! `ModelIntegrator::add_models_to_gltf`）→ 序列化成 JSON 字符串 → 光照注入
//! （`ModelIntegrator::add_lighting_to_gltf_json`，失败用 `?` 传播）→ lightmap 契约注入
//! （[`apply_lightmap_json`]）→ 按**最终** JSON 长度写 GLB 头。契约注入必须在序列化之后，
//! 否则最终字节里不含这些字段。
//!
//! 关键不变量：
//! - `BspVertexData` 是 `#[repr(C)]` 的逐顶点布局，[`push_bsp_face_bsp`] 按它写 buffer；
//! - TEXCOORD_1（lightmap UV）走**独立** buffer view + accessor，不改变既有 stride；
//! - 无光照或无图集时仍写中性常量 UV，保证同一块几何的属性集一致（下游合并要求属性集相同）。
//!
//! 边界：只做装配与导出。不解析 BSP 细节（`vbsp`）、不构建 GLTF 材质（`gltf_builder`）、
//! 不算图集（`lightmap`）、不加载模型（`model_integrator`）。
//!
//! 死代码说明：[`merge_model_into_root`] / [`create_new_gltf_structure`] /
//! [`merge_gltf_structures_improved`] 三函数在本仓**无调用点**（各带 `#[allow(dead_code)]`）。
//!
//! 测试归属：本文件无 `#[test]`。

use gltf_json as json;
use crate::bsp_to_gltf_core::gltf_builder::push_or_get_material_bsp;
use crate::bsp_to_gltf_core::{ConvertOptions, Error, ExportResult, MissingResource};
use bytemuck::{Pod, Zeroable};
use cgmath::{Deg, Quaternion, Rotation3};
use gltf::Glb;
use gltf_json::scene::UnitQuaternion;
use gltf_json::validation::USize64;
use gltf_json::{Buffer, Index, Node, Root, Scene};
use std::borrow::Cow;
use std::mem::size_of;
use crate::vbsp::{Bsp, Entity};
use crate::model_integrator::ModelIntegrator;
use crate::bsp_to_gltf_core::lightmap::{self, LightmapAtlas};

/// lightmap 导出上下文：图集 + 它在 GLB `textures` 里的索引。
struct LightmapExport {
    atlas: LightmapAtlas,
    texture_index: u32,
}

/// 构建 lightmap 图集与纹理；无光照 lump 时返回 `None`。
///
/// 失败一律向上报错（不静默产出无光照 GLB）：打包装不下、单面越界、面表不对齐都属可见失败。
fn build_lightmap_export(
    bsp: &Bsp,
    buffer: &mut Vec<u8>,
    root: &mut Root,
    max_atlas_area_override: u64,
) -> Result<Option<LightmapExport>, Error> {
    let Some(lighting) = bsp.lighting.as_ref() else {
        return Ok(None);
    };
    let atlas = lightmap::build_atlas(bsp, lighting, max_atlas_area_override)?;
    let texture_index = lightmap::push_atlas_texture(buffer, root, &atlas)?.value() as u32;
    Ok(Some(LightmapExport {
        atlas,
        texture_index,
    }))
}

/// 把 lightmap 契约写进 GLB JSON（`asset.extras.lightmap` 与
/// `materials[*].extensions.__vbsp_lightmap__`），返回改写后的 JSON 字符串。
fn apply_lightmap_json(
    json_string: String,
    lightmap: Option<&LightmapExport>,
) -> Result<String, Error> {
    match lightmap {
        Some(export) => {
            lightmap::inject_lightmap_json(&json_string, export.texture_index, &export.atlas)
        }
        None => Ok(json_string),
    }
}

/// 从 BSP 文件导出为 GLTF 格式（仅使用 BSP 文件内的资源）。
///
/// `bsp` 收 `Arc<Bsp>`：调用侧交出的是一次 `Arc` 克隆而不是实例本身，故本函数**不消费**它，
/// 失败路径也不会让调用方失去 BSP（三工程 `crates/wasm/src/lib.rs` 的导出入口据此保证
/// 「成功与失败均可重复导出」）。
pub fn export_bsp(bsp: std::sync::Arc<Bsp>, options: ConvertOptions) -> Result<ExportResult, Error> {
    let bsp: &Bsp = &bsp;
    let mut buffer = Vec::new();
    let mut missing_resources = Vec::new();
    let texture_collector = std::rc::Rc::new(std::cell::RefCell::new(crate::bsp_to_gltf_core::materials::TextureCollector::new()));

    let mut root = Root::default();

    // 光照图集（无光照 lump 时为 None）。放在建模之前，使两条返回路径都带上它。
    // `options.lightmap_max_atlas_area` 只覆盖单页面积上界（0 = 用默认上界），
    // 见 `lightmap::effective_max_atlas_area`。
    let lightmap = build_lightmap_export(&bsp, &mut buffer, &mut root, options.lightmap_max_atlas_area)?;

    // 只处理地图结构，不处理模型
    for (model, offset) in bsp_models(&bsp)? {
        let tc_clone = texture_collector.clone();
        let node = push_bsp_model_bsp(&mut buffer, &mut root, &bsp, &model, offset, &options, &mut missing_resources, Some(tc_clone), lightmap.as_ref());
        root.nodes.push(node);
    }

    // 构建根节点
    let node_indices = 0..root.nodes.len();
    let root_rotation = Quaternion::<f32>::from_angle_y(Deg(90.0));
    let root_node = Node {
        camera: None,
        children: Some(node_indices.map(|index| Index::new(index as u32)).collect()),
        extensions: Default::default(),
        extras: Default::default(),
        matrix: None,
        mesh: None,
        name: Some("Root".to_string()),
        rotation: Some(UnitQuaternion([
            root_rotation.v.x,
            root_rotation.v.y,
            root_rotation.v.z,
            root_rotation.s,
        ])),
        scale: None,
        translation: None,
        skin: None,
        weights: None,
    };
    let root_index = root.nodes.len();
    root.nodes.push(root_node);

    root.scenes = vec![Scene {
        name: Some("BSP Scene".to_string()),
        extensions: None,
        extras: Default::default(),
        nodes: vec![Index::new(root_index as u32)],
    }];

    root.buffers.push(Buffer {
        byte_length: USize64(buffer.len() as u64),
        extensions: Default::default(),
        extras: Default::default(),
        name: None,
        uri: None,
    });

    let json_string = json::serialize::to_string(&root).expect("Serialization error");
    // BSP-only 路径同样写入 lightmap 契约；必须在用 json_string.len() 推 header 长度之前
    // （否则 GLB 头里的 JSON 长度与实际字节数不符）
    let json_string = apply_lightmap_json(json_string, lightmap.as_ref())?;
    let mut json_offset = json_string.len() as u32;
    align_to_multiple_of_four(&mut json_offset);

    pad_byte_vector(&mut buffer);
    let glb = Glb {
        header: gltf::binary::Header {
            magic: *b"glTF",
            version: 2,
            length: json_offset + buffer.len() as u32,
        },
        bin: Some(Cow::Owned(buffer)),
        json: Cow::Owned(json_string.into_bytes()),
    };

    // 提取纹理信息到局部变量
    let textures: Vec<String> = texture_collector.borrow().textures.iter().cloned().collect();
    
    Ok(ExportResult {
        glb,
        missing_resources,
        textures,
    })
}

/// 从 BSP 文件导出为 GLTF 格式，并可选嵌入模型（`Arc<Bsp>` 口径同 [`export_bsp`]）
pub fn export_bsp_with_models(bsp: std::sync::Arc<Bsp>, options: ConvertOptions, model_integrator: Option<&ModelIntegrator>) -> Result<ExportResult, Error> {
    let bsp: &Bsp = &bsp;
    let mut buffer = Vec::new();
    let mut missing_resources = Vec::new();
    let texture_collector = std::rc::Rc::new(std::cell::RefCell::new(crate::bsp_to_gltf_core::materials::TextureCollector::new()));

    let mut root = Root::default();

    // 光照图集（无光照 lump 时为 None）。
    let lightmap = build_lightmap_export(&bsp, &mut buffer, &mut root, options.lightmap_max_atlas_area)?;

    // 1. 处理BSP结构
    for (model, offset) in bsp_models(&bsp)? {
        let tc_clone = texture_collector.clone();
        let node = push_bsp_model_bsp(&mut buffer, &mut root, &bsp, &model, offset, &options, &mut missing_resources, Some(tc_clone), lightmap.as_ref());
        root.nodes.push(node);
    }

    // 2. 若提供模型集成器，将模型数据添加到统一结构
    if let Some(integrator) = model_integrator {
        // 直接获取模型数据并添加到统一结构
        if let Err(e) = integrator.add_models_to_gltf(&mut root, &mut buffer) {
            // 模型处理失败，返回 BSP 导出结果
            eprintln!("警告: 模型处理失败: {:?}", e);
            // 构建 BSP-only 结果
            return build_export_result(root, buffer, missing_resources, texture_collector, lightmap.as_ref());
        }
    } else {
        // 没有模型，构建 BSP-only 结果
        return build_export_result(root, buffer, missing_resources, texture_collector, lightmap.as_ref());
    }

    // 3. 构建根节点
    let root_rotation = Quaternion::<f32>::from_angle_y(Deg(90.0));
    let root_node = Node {
        camera: None,
        children: Some((0..root.nodes.len()).map(|index| Index::new(index as u32)).collect()),
        extensions: Default::default(),
        extras: Default::default(),
        matrix: None,
        mesh: None,
        name: Some("Complete Root".to_string()),
        rotation: Some(UnitQuaternion([
            root_rotation.v.x,
            root_rotation.v.y,
            root_rotation.v.z,
            root_rotation.s,
        ])),
        scale: None,
        translation: None,
        skin: None,
        weights: None,
    };
    let root_index = root.nodes.len();
    root.nodes.push(root_node);

    root.scenes = vec![Scene {
        name: Some("Complete Scene".to_string()),
        extensions: None,
        extras: Default::default(),
        nodes: vec![Index::new(root_index as u32)],
    }];

    root.buffers.push(Buffer {
        byte_length: USize64(buffer.len() as u64),
        extensions: Default::default(),
        extras: Default::default(),
        name: None,
        uri: None,
    });

    // 4. 生成 GLB 文件
    let mut json_string = json::serialize::to_string(&root).expect("Serialization error");

    // 光照注入失败必须**可见**：这里用 `?` 直接传播，不用 `if let Ok(...)` 把 Err 吞掉——
    // 吞掉会产出「语法合法但没有光照」的 GLB，与「光照数据没到」难以区分。
    if let Some(integrator) = model_integrator {
        json_string = integrator.add_lighting_to_gltf_json(&json_string)?;
    }

    // 写入 lightmap 契约（放在光照注入之后，保证最终字节里含这些字段）
    json_string = apply_lightmap_json(json_string, lightmap.as_ref())?;
    
    let mut json_offset = json_string.len() as u32;
    align_to_multiple_of_four(&mut json_offset);

    pad_byte_vector(&mut buffer);
    let glb = Glb {
        header: gltf::binary::Header {
            magic: *b"glTF",
            version: 2,
            length: json_offset + buffer.len() as u32,
        },
        bin: Some(Cow::Owned(buffer)),
        json: Cow::Owned(json_string.into_bytes()),
    };

    // 提取纹理信息
    let textures: Vec<String> = texture_collector.borrow().textures.iter().cloned().collect();
    
    Ok(ExportResult {
        glb,
        missing_resources,
        textures,
    })
}

/// 构建导出结果
fn build_export_result(
    root: Root,
    buffer: Vec<u8>,
    missing_resources: Vec<MissingResource>,
    texture_collector: std::rc::Rc<std::cell::RefCell<crate::bsp_to_gltf_core::materials::TextureCollector>>,
    lightmap: Option<&LightmapExport>,
) -> Result<ExportResult, Error> {
    // 构建根节点
    let node_indices = 0..root.nodes.len();
    let root_rotation = Quaternion::<f32>::from_angle_y(Deg(90.0));
    let root_node = Node {
        camera: None,
        children: Some(node_indices.map(|index| Index::new(index as u32)).collect()),
        extensions: Default::default(),
        extras: Default::default(),
        matrix: None,
        mesh: None,
        name: Some("Root".to_string()),
        rotation: Some(UnitQuaternion([
            root_rotation.v.x,
            root_rotation.v.y,
            root_rotation.v.z,
            root_rotation.s,
        ])),
        scale: None,
        translation: None,
        skin: None,
        weights: None,
    };
    let root_index = root.nodes.len();
    let mut new_root = root;
    new_root.nodes.push(root_node);

    new_root.scenes = vec![Scene {
        name: Some("BSP Scene".to_string()),
        extensions: None,
        extras: Default::default(),
        nodes: vec![Index::new(root_index as u32)],
    }];

    new_root.buffers.push(Buffer {
        byte_length: USize64(buffer.len() as u64),
        extensions: Default::default(),
        extras: Default::default(),
        name: None,
        uri: None,
    });

    // 生成 GLB 文件
    let json_string = json::serialize::to_string(&new_root).expect("Serialization error");
    // BSP-only 路径同样写入 lightmap 契约
    let json_string = apply_lightmap_json(json_string, lightmap)?;
    let mut json_offset = json_string.len() as u32;
    align_to_multiple_of_four(&mut json_offset);

    let mut buffer = buffer;
    pad_byte_vector(&mut buffer);
    let glb = Glb {
        header: gltf::binary::Header {
            magic: *b"glTF",
            version: 2,
            length: json_offset + buffer.len() as u32,
        },
        bin: Some(Cow::Owned(buffer)),
        json: Cow::Owned(json_string.into_bytes()),
    };

    // 提取纹理信息
    let textures: Vec<String> = texture_collector.borrow().textures.iter().cloned().collect();
    
    Ok(ExportResult {
        glb,
        missing_resources,
        textures,
    })
}

/// 把模型数据**原地**并进 `root`：`root` 与 `buffer` 是 BSP 侧已建好的产物，
/// `model_root` 与 `model_buffer` 作为输入被读走，返回 `()`。
///
/// **死代码**：本仓无调用点，仅靠 `#[allow(dead_code)]` 保留。线上合并路径不是本文件这三个
/// 合并函数，而是 `model_integrator` 的 `ModelIntegrator::add_models_to_gltf`。
#[allow(dead_code)]
fn merge_model_into_root(
    root: &mut Root,
    buffer: &mut Vec<u8>,
    model_root: Root,
    model_buffer: Vec<u8>
) {
    // 记录当前计数
    let bsp_mesh_count = root.meshes.len();
    let bsp_material_count = root.materials.len();
    let bsp_texture_count = root.textures.len();
    let bsp_image_count = root.images.len();
    let bsp_buffer_view_count = root.buffer_views.len();
    let model_node_start = root.nodes.len();
    let bsp_buffer_size = buffer.len();

    // 合并缓冲区数据
    buffer.extend(model_buffer);

    // 处理模型的缓冲区视图
    for mut view in model_root.buffer_views {
        if let Some(offset) = &mut view.byte_offset {
            *offset = USize64(offset.0 + bsp_buffer_size as u64);
        } else {
            view.byte_offset = Some(USize64(bsp_buffer_size as u64));
        }
        root.buffer_views.push(view);
    }

    // 处理模型的访问器
    for mut accessor in model_root.accessors {
        if let Some(buffer_view) = &mut accessor.buffer_view {
            let new_index = (buffer_view.value() as usize + bsp_buffer_view_count) as u32;
            *buffer_view = Index::new(new_index);
        }
        root.accessors.push(accessor);
    }

    // 处理模型的图像
    root.images.extend(model_root.images);

    // 处理模型的纹理
    for mut texture in model_root.textures {
        let new_index = (texture.source.value() as usize + bsp_image_count) as u32;
        texture.source = Index::new(new_index);
        root.textures.push(texture);
    }

    // 处理模型的材质
    for mut material in model_root.materials {
        // 修复 PBR 材质中的纹理索引
        if let Some(base_color_texture) = &mut material.pbr_metallic_roughness.base_color_texture {
            let new_index = (base_color_texture.index.value() as usize + bsp_texture_count) as u32;
            base_color_texture.index = Index::new(new_index);
        }
        if let Some(metallic_roughness_texture) = &mut material.pbr_metallic_roughness.metallic_roughness_texture {
            let new_index = (metallic_roughness_texture.index.value() as usize + bsp_texture_count) as u32;
            metallic_roughness_texture.index = Index::new(new_index);
        }
        
        // 修复法线纹理索引
        if let Some(normal_texture) = &mut material.normal_texture {
            let new_index = (normal_texture.index.value() as usize + bsp_texture_count) as u32;
            normal_texture.index = Index::new(new_index);
        }
        
        // 修复 occlusion 纹理索引
        if let Some(occlusion_texture) = &mut material.occlusion_texture {
            let new_index = (occlusion_texture.index.value() as usize + bsp_texture_count) as u32;
            occlusion_texture.index = Index::new(new_index);
        }
        
        // 修复 emissive 纹理索引
        if let Some(emissive_texture) = &mut material.emissive_texture {
            let new_index = (emissive_texture.index.value() as usize + bsp_texture_count) as u32;
            emissive_texture.index = Index::new(new_index);
        }
        root.materials.push(material);
    }

    // 处理模型的网格
    for mut mesh in model_root.meshes {
        for primitive in &mut mesh.primitives {
            if let Some(material) = &mut primitive.material {
                let new_index = (material.value() as usize + bsp_material_count) as u32;
                *material = Index::new(new_index);
            }
        }
        root.meshes.push(mesh);
    }

    // 处理模型的节点
    let mut model_nodes = Vec::new();
    
    // 首先收集所有模型节点
    for mut node in model_root.nodes {
        // 调整网格索引
        if let Some(mesh) = &mut node.mesh {
            let new_index = (mesh.value() as usize + bsp_mesh_count) as u32;
            *mesh = Index::new(new_index);
        }
        
        model_nodes.push(node);
    }
    
    // 调整模型节点的子节点索引
    for (_i, node) in model_nodes.iter_mut().enumerate() {
        if let Some(children) = &mut node.children {
            for child in children {
                let new_index = (child.value() as usize + model_node_start) as u32;
                *child = Index::new(new_index);
            }
        }
    }
    
    // 添加所有模型节点
    root.nodes.extend(model_nodes);
}

/// 构建一个**全新**的根结构：BSP 侧与模型侧都作为输入，索引重映射后合并，返回
/// `(Root, Vec<u8>)`。与 [`merge_model_into_root`] 的「原地修改」口径相反。
///
/// **死代码**：本仓无调用点，仅靠 `#[allow(dead_code)]` 保留。
#[allow(dead_code)]
fn create_new_gltf_structure(
    bsp_root: Root,
    model_root: Root,
    bsp_buffer: Vec<u8>,
    model_buffer: Vec<u8>
) -> Result<(Root, Vec<u8>), Error> {
    // 创建新的GLTF根结构
    let mut new_root = Root::default();
    
    // 记录BSP结构的各种计数
    let bsp_mesh_count = bsp_root.meshes.len();
    let bsp_material_count = bsp_root.materials.len();
    let bsp_texture_count = bsp_root.textures.len();
    let bsp_image_count = bsp_root.images.len();
    let bsp_buffer_view_count = bsp_root.buffer_views.len();
    let _bsp_accessor_count = bsp_root.accessors.len();
    
    // 复制BSP的所有数据到新结构
    new_root.meshes.extend(bsp_root.meshes);
    new_root.materials.extend(bsp_root.materials);
    new_root.textures.extend(bsp_root.textures);
    new_root.images.extend(bsp_root.images);
    new_root.buffer_views.extend(bsp_root.buffer_views);
    new_root.accessors.extend(bsp_root.accessors);
    
    // 处理模型数据，调整索引
    let mut model_nodes = Vec::new();
    let bsp_buffer_size = bsp_buffer.len();
    
    // 调整模型缓冲区视图的偏移量
    for mut view in model_root.buffer_views {
        if let Some(offset) = &mut view.byte_offset {
            *offset = USize64(offset.0 + bsp_buffer_size as u64);
        } else {
            view.byte_offset = Some(USize64(bsp_buffer_size as u64));
        }
        new_root.buffer_views.push(view);
    }
    
    // 调整模型访问器的缓冲区视图索引
    for mut accessor in model_root.accessors {
        if let Some(buffer_view) = &mut accessor.buffer_view {
            let buffer_view_value: usize = buffer_view.value() as usize;
            let new_buffer_view_index = (buffer_view_value + bsp_buffer_view_count) as u32;
            *buffer_view = Index::new(new_buffer_view_index);
        }
        new_root.accessors.push(accessor);
    }
    
    // 调整模型纹理的图像索引
    for mut texture in model_root.textures {
        let image_value: usize = texture.source.value() as usize;
        let new_image_index = (image_value + bsp_image_count) as u32;
        texture.source = Index::new(new_image_index);
        new_root.textures.push(texture);
    }
    
    // 调整模型材质的纹理索引
    for mut material in model_root.materials {
        // 修复 PBR 材质中的纹理索引
        if let Some(base_color_texture) = &mut material.pbr_metallic_roughness.base_color_texture {
            let texture_value: usize = base_color_texture.index.value() as usize;
            let new_texture_index = (texture_value + bsp_texture_count) as u32;
            base_color_texture.index = Index::new(new_texture_index);
        }
        if let Some(metallic_roughness_texture) = &mut material.pbr_metallic_roughness.metallic_roughness_texture {
            let texture_value: usize = metallic_roughness_texture.index.value() as usize;
            let new_texture_index = (texture_value + bsp_texture_count) as u32;
            metallic_roughness_texture.index = Index::new(new_texture_index);
        }
        
        // 修复法线纹理索引
        if let Some(normal_texture) = &mut material.normal_texture {
            let texture_value: usize = normal_texture.index.value() as usize;
            let new_texture_index = (texture_value + bsp_texture_count) as u32;
            normal_texture.index = Index::new(new_texture_index);
        }
        
        // 修复 occlusion 纹理索引
        if let Some(occlusion_texture) = &mut material.occlusion_texture {
            let texture_value: usize = occlusion_texture.index.value() as usize;
            let new_texture_index = (texture_value + bsp_texture_count) as u32;
            occlusion_texture.index = Index::new(new_texture_index);
        }
        
        // 修复 emissive 纹理索引
        if let Some(emissive_texture) = &mut material.emissive_texture {
            let texture_value: usize = emissive_texture.index.value() as usize;
            let new_texture_index = (texture_value + bsp_texture_count) as u32;
            emissive_texture.index = Index::new(new_texture_index);
        }
        new_root.materials.push(material);
    }
    
    // 调整模型网格的材质索引
    for mut mesh in model_root.meshes {
        for primitive in &mut mesh.primitives {
            if let Some(material) = &mut primitive.material {
                let material_value: usize = material.value() as usize;
                let new_material_index = (material_value + bsp_material_count) as u32;
                *material = Index::new(new_material_index);
            }
        }
        new_root.meshes.push(mesh);
    }
    
    // 记录BSP节点数量
    let bsp_node_count = bsp_root.nodes.len();
    
    // 调整模型节点的网格索引并收集节点
    for mut node in model_root.nodes {
        // 不要跳过任何节点，包括根节点
        if let Some(mesh) = &mut node.mesh {
            let mesh_value: usize = mesh.value() as usize;
            let new_mesh_index = (mesh_value + bsp_mesh_count) as u32;
            *mesh = Index::new(new_mesh_index);
        }
        
        // 调整子节点索引
        if let Some(children) = &mut node.children {
            for child in children {
                let child_value: usize = child.value() as usize;
                let new_child_index = (child_value + bsp_node_count) as u32;
                *child = Index::new(new_child_index);
            }
        }
        
        model_nodes.push(node);
    }
    
    // 复制BSP的节点到新结构
    new_root.nodes.extend(bsp_root.nodes);
    
    // 添加模型节点到新结构
    new_root.nodes.extend(model_nodes);
    
    // 合并缓冲区数据
    let mut combined_buffer = bsp_buffer;
    combined_buffer.extend(model_buffer);
    
    // 创建新的根节点
    let root_rotation = Quaternion::<f32>::from_angle_y(Deg(90.0));
    let root_node = Node {
        camera: None,
        children: Some(Vec::new()),
        extensions: Default::default(),
        extras: Default::default(),
        matrix: None,
        mesh: None,
        name: Some("Complete Root".to_string()),
        rotation: Some(UnitQuaternion([
            root_rotation.v.x,
            root_rotation.v.y,
            root_rotation.v.z,
            root_rotation.s,
        ])),
        scale: None,
        translation: None,
        skin: None,
        weights: None,
    };
    
    // 添加根节点
    let root_index = new_root.nodes.len();
    new_root.nodes.push(root_node);
    
    // 更新根节点的子节点，包含所有BSP和模型节点
    let node_indices = 0..new_root.nodes.len();
    if let Some(ref mut children) = new_root.nodes[root_index].children {
        *children = node_indices
            .filter(|&i| i != root_index) // 排除根节点自身
            .map(|index| Index::new(index as u32))
            .collect();
    }
    
    // 更新场景
    new_root.scenes = vec![Scene {
        name: Some("Complete Scene".to_string()),
        extensions: None,
        extras: Default::default(),
        nodes: vec![Index::new(root_index as u32)],
    }];
    
    // 更新缓冲区信息
    new_root.buffers.push(Buffer {
        byte_length: USize64(combined_buffer.len() as u64),
        extensions: Default::default(),
        extras: Default::default(),
        name: None,
        uri: None,
    });
    
    Ok((new_root, combined_buffer))
}

/// 与 [`create_new_gltf_structure`] **签名相同**（同样吃 BSP 侧与模型侧的 `Root` / `Vec<u8>`，
/// 同样返回 `(Root, Vec<u8>)`），是「构建新根」口径的另一份实现。
///
/// **死代码**：本仓无调用点，仅靠 `#[allow(dead_code)]` 保留。
#[allow(dead_code)]
fn merge_gltf_structures_improved(
    bsp_root: Root,
    model_root: Root,
    bsp_buffer: Vec<u8>,
    model_buffer: Vec<u8>
) -> Result<(Root, Vec<u8>), Error> {
    // 创建新的GLTF根结构
    let mut new_root = Root::default();
    
    // 记录BSP结构的各种计数
    let bsp_mesh_count = bsp_root.meshes.len();
    let bsp_material_count = bsp_root.materials.len();
    let bsp_texture_count = bsp_root.textures.len();
    let bsp_image_count = bsp_root.images.len();
    let bsp_buffer_view_count = bsp_root.buffer_views.len();
    let _bsp_node_count = bsp_root.nodes.len();
    
    // 合并缓冲区数据
    let mut combined_buffer = bsp_buffer;
    let bsp_buffer_size = combined_buffer.len();
    combined_buffer.extend(model_buffer);
    
    // 复制BSP的所有数据
    new_root.meshes.extend(bsp_root.meshes);
    new_root.materials.extend(bsp_root.materials);
    new_root.textures.extend(bsp_root.textures);
    new_root.images.extend(bsp_root.images);
    new_root.buffer_views.extend(bsp_root.buffer_views);
    new_root.accessors.extend(bsp_root.accessors);
    new_root.nodes.extend(bsp_root.nodes);
    
    // 处理模型的缓冲区视图
    for mut view in model_root.buffer_views {
        if let Some(offset) = &mut view.byte_offset {
            *offset = USize64(offset.0 + bsp_buffer_size as u64);
        } else {
            view.byte_offset = Some(USize64(bsp_buffer_size as u64));
        }
        new_root.buffer_views.push(view);
    }
    
    // 处理模型的访问器
    for mut accessor in model_root.accessors {
        if let Some(buffer_view) = &mut accessor.buffer_view {
            let new_index = (buffer_view.value() as usize + bsp_buffer_view_count) as u32;
            *buffer_view = Index::new(new_index);
        }
        new_root.accessors.push(accessor);
    }
    
    // 处理模型的图像
    new_root.images.extend(model_root.images);
    
    // 处理模型的纹理
    for mut texture in model_root.textures {
        let new_index = (texture.source.value() as usize + bsp_image_count) as u32;
        texture.source = Index::new(new_index);
        new_root.textures.push(texture);
    }
    
    // 处理模型的材质
    for mut material in model_root.materials {
        // 修复 PBR 材质中的纹理索引
        if let Some(base_color_texture) = &mut material.pbr_metallic_roughness.base_color_texture {
            let new_index = (base_color_texture.index.value() as usize + bsp_texture_count) as u32;
            base_color_texture.index = Index::new(new_index);
        }
        if let Some(metallic_roughness_texture) = &mut material.pbr_metallic_roughness.metallic_roughness_texture {
            let new_index = (metallic_roughness_texture.index.value() as usize + bsp_texture_count) as u32;
            metallic_roughness_texture.index = Index::new(new_index);
        }
        
        // 修复法线纹理索引
        if let Some(normal_texture) = &mut material.normal_texture {
            let new_index = (normal_texture.index.value() as usize + bsp_texture_count) as u32;
            normal_texture.index = Index::new(new_index);
        }
        
        // 修复 occlusion 纹理索引
        if let Some(occlusion_texture) = &mut material.occlusion_texture {
            let new_index = (occlusion_texture.index.value() as usize + bsp_texture_count) as u32;
            occlusion_texture.index = Index::new(new_index);
        }
        
        // 修复 emissive 纹理索引
        if let Some(emissive_texture) = &mut material.emissive_texture {
            let new_index = (emissive_texture.index.value() as usize + bsp_texture_count) as u32;
            emissive_texture.index = Index::new(new_index);
        }
        new_root.materials.push(material);
    }
    
    // 处理模型的网格
    for mut mesh in model_root.meshes {
        for primitive in &mut mesh.primitives {
            if let Some(material) = &mut primitive.material {
                let new_index = (material.value() as usize + bsp_material_count) as u32;
                *material = Index::new(new_index);
            }
        }
        new_root.meshes.push(mesh);
    }
    
    // 处理模型的节点
    let model_node_start = new_root.nodes.len();
    let mut model_nodes = Vec::new();
    
    // 首先收集所有模型节点
    for mut node in model_root.nodes {
        // 调整网格索引
        if let Some(mesh) = &mut node.mesh {
            let new_index = (mesh.value() as usize + bsp_mesh_count) as u32;
            *mesh = Index::new(new_index);
        }
        
        model_nodes.push(node);
    }
    
    // 调整模型节点的子节点索引
    for (_i, node) in model_nodes.iter_mut().enumerate() {
        if let Some(children) = &mut node.children {
            for child in children {
                let new_index = (child.value() as usize + model_node_start) as u32;
                *child = Index::new(new_index);
            }
        }
    }
    
    // 添加所有模型节点
    new_root.nodes.extend(model_nodes);
    
    // 创建新的根节点
    let root_rotation = Quaternion::<f32>::from_angle_y(Deg(90.0));
    let root_node = Node {
        camera: None,
        children: Some(Vec::new()),
        extensions: Default::default(),
        extras: Default::default(),
        matrix: None,
        mesh: None,
        name: Some("Complete Root".to_string()),
        rotation: Some(UnitQuaternion([
            root_rotation.v.x,
            root_rotation.v.y,
            root_rotation.v.z,
            root_rotation.s,
        ])),
        scale: None,
        translation: None,
        skin: None,
        weights: None,
    };
    
    // 添加根节点
    let root_index = new_root.nodes.len();
    new_root.nodes.push(root_node);
    
    // 更新根节点的子节点，包含所有BSP和模型节点
    let node_indices = 0..root_index;
    if let Some(ref mut children) = new_root.nodes[root_index].children {
        *children = node_indices
            .map(|index| Index::new(index as u32))
            .collect();
    }
    
    // 更新场景
    new_root.scenes = vec![Scene {
        name: Some("Complete Scene".to_string()),
        extensions: None,
        extras: Default::default(),
        nodes: vec![Index::new(root_index as u32)],
    }];
    
    // 更新缓冲区信息
    new_root.buffers = vec![Buffer {
        byte_length: USize64(combined_buffer.len() as u64),
        extensions: Default::default(),
        extras: Default::default(),
        name: None,
        uri: None,
    }];
    
    Ok((new_root, combined_buffer))
}

/// 把 `n` 就地向上取到 4 的倍数（已经是 4 的倍数时不变）。
fn align_to_multiple_of_four(n: &mut u32) {
    *n = (*n + 3) & !3;
}

/// 往 `vec` 尾部补 0 直到长度为 4 的倍数（glTF 要求 buffer view 偏移按 4 字节对齐）。
/// 调用方若要记录真实数据长度，必须在调用**之前**取（`lightmap::push_atlas_texture` 与
/// `gltf_builder` 都按这个次序写 `byte_length`）。
pub fn pad_byte_vector(vec: &mut Vec<u8>) {
    while vec.len() % 4 != 0 {
        vec.push(0);
    }
}

/// BSP 轴序 → GLB 轴序：`[x, y, z] → [y, z, x]`（Z-up → Y-up 的循环置换，行列式 +1）。
///
/// 模型顶点、碰撞体顶点、灯光位置都经它搬进 GLB 坐标系；调用方必须与
/// `model_integrator` 的放置链用同一套映射，否则碰撞体与显示模型会错位。
pub fn map_coords<C: Into<[f32; 3]>>(vec: C) -> [f32; 3] {
    let vec = vec.into();
    [vec[1], vec[2], vec[0]]
}

/// 收集要导出的模型及其世界偏移：brush 实体各一个，**世界模型排最后**（origin 取 `(0,0,0)`）。
///
/// 只认四种 brush 实体（`Entity::Brush` / `BrushIllusionary` / `BrushWall` / `BrushWallToggle`），
/// 其余实体一律跳过；模型的 `handle` 取自 `brush.model` 去掉首字符后的下标（`*1` 这类写法），
/// 下标解析失败或越界时**静默丢弃该实例**（不报错）。
///
/// 一个模型都没有（`bsp.models()` 为空）时报 `Error::Other("No world model")`。
fn bsp_models(bsp: &Bsp) -> Result<Vec<(crate::vbsp::Handle<'_, crate::vbsp::Model>, crate::vbsp::Vector)>, Error> {
    let world_model = bsp
        .models()
        .next()
        .ok_or(Error::Other("No world model".into()))?;

    let mut models: Vec<_> = bsp
        .entities
        .iter()
        .flat_map(|ent| ent.parse())
        .filter_map(|ent| match ent {
            Entity::Brush(ent)
            | Entity::BrushIllusionary(ent)
            | Entity::BrushWall(ent)
            | Entity::BrushWallToggle(ent) => Some(ent),
            _ => None,
        })
        .flat_map(|brush| Some((brush.model[1..].parse::<usize>().ok()?, brush.origin)))
        .flat_map(|(index, origin)| Some((bsp.models().nth(index)?, origin)))
        .collect();
    models.push((
        world_model,
        crate::vbsp::Vector {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        },
    ));

    Ok(models)
}

/// 把一个模型推成一个 GLB 节点：逐 face 生成 primitive（**只取 `face.is_visible()` 的面**），
/// 返回该节点。
///
/// `face_index` 用 `model.first_face + 该 face 在模型内的序号`（序号按 `enumerate` 计，含被跳过的
/// 不可见面，故与全局 face 表的下标一致）；它写进 primitive 的 `extras.faceIndex`，供渲染端
/// PVS 遮挡剔除把图元映射回 face。
fn push_bsp_model_bsp(
    buffer: &mut Vec<u8>,
    gltf: &mut Root,
    bsp: &Bsp,
    model: &crate::vbsp::Handle<crate::vbsp::Model>,
    offset: crate::vbsp::Vector,
    options: &ConvertOptions,
    missing_resources: &mut Vec<MissingResource>,
    texture_collector: Option<std::rc::Rc<std::cell::RefCell<crate::bsp_to_gltf_core::materials::TextureCollector>>>,
    lightmap: Option<&LightmapExport>,
) -> Node {
    let mut primitives = Vec::new();
    // 枚举 face 在 model 中的位置，全局 face 索引 = model.first_face + 位置；
    // face_index 写入 extras.faceIndex，供 Worker 端 PVS 遮挡剔除使用
    for (i, face) in model.faces().enumerate() {
        if !face.is_visible() {
            continue;
        }
        let face_index = model.first_face + i as i32;
        primitives.push(push_bsp_face_bsp(
            buffer,
            gltf,
            bsp,
            &face,
            face_index,
            options,
            missing_resources,
            texture_collector.clone(),
            lightmap,
        ));
    }

    let mesh = gltf_json::Mesh {
        extensions: Default::default(),
        extras: Default::default(),
        name: None,
        primitives,
        weights: None,
    };

    let mesh_index = gltf.meshes.len() as u32;
    gltf.meshes.push(mesh);

    Node {
        camera: None,
        children: None,
        extensions: Default::default(),
        extras: Default::default(),
        matrix: None,
        mesh: Some(Index::new(mesh_index)),
        name: Some("bsp".into()),
        rotation: None,
        scale: None,
        translation: Some(map_coords(offset)),
        skin: None,
        weights: None,
    }
}

/// 把一个面推成一个 glTF `Primitive`：顶点属性、索引、材质与 extras 都在这里落。
///
/// 顶点属性按 `BspVertexData` 写（`position` 经 [`map_coords`]），语义表里
/// `TEXCOORD_0` 与 `TEXCOORD_1` 分别绑到 `accessor_start + 1` 与 `accessor_start + 2`。
/// TEXCOORD_1 是 lightmap UV：命中图集区域时用 `lightmap::lightmap_uv` 逐顶点算，
/// 否则写中性常量 `[0, 0]`——**没有 lightmap 也要写**，否则同一块几何里的属性集不一致，
/// 下游合并会失败。
///
/// `extras` 固定写 `{"faceIndex": <面序号>, "hasLightmap": <是否命中图集区域>}`。
fn push_bsp_face_bsp(
    buffer: &mut Vec<u8>,
    gltf: &mut Root,
    bsp: &Bsp,
    face: &crate::vbsp::Handle<crate::vbsp::Face>,
    face_index: i32,
    options: &ConvertOptions,
    missing_resources: &mut Vec<MissingResource>,
    texture_collector: Option<std::rc::Rc<std::cell::RefCell<crate::bsp_to_gltf_core::materials::TextureCollector>>>,
    lightmap: Option<&LightmapExport>,
) -> gltf_json::mesh::Primitive {
    use bytemuck::cast;

    let vertex_count = face.vertex_positions().count() as u64;

    let buffer_start = buffer.len() as u64;

    let (min, max) = bounding_box(face.vertex_positions());

    let texture = face.texture();

    // lightmap UV（TEXCOORD_1）。无光照或无图集时写中性常量，保证同一块几何的属性集一致
    // （`apps/debug/src/renderer/renderer-main.ts` 与 `apps/game/src/renderer/renderer-main.ts`
    // 的 `mergeGeometries(geoms, true)` 要求参与合并的几何属性集相同）。
    let lightmap_region = lightmap.and_then(|export| {
        export
            .atlas
            .regions
            .get(face_index.max(0) as usize)
            .copied()
            .flatten()
    });
    let lightmap_uvs: Vec<[f32; 2]> = match (lightmap, lightmap_region) {
        (Some(export), Some(region)) => {
            let texinfo: &crate::vbsp::TextureInfo = &texture;
            let vbsp_face: &crate::vbsp::Face = &face;
            face.vertex_positions()
                .map(|pos| lightmap::lightmap_uv(&export.atlas, region, vbsp_face, texinfo, pos))
                .collect()
        }
        _ => vec![[0.0f32, 0.0f32]; vertex_count as usize],
    };
    let has_lightmap = lightmap_region.is_some();

    let vertices = face.vertex_positions().map(move |pos| BspVertexData {
        position: map_coords(pos),
        uv: texture.uv(pos),
    });

    let vertex_data = vertices.flat_map(cast::<_, [u8; size_of::<BspVertexData>()]>);
    buffer.extend(vertex_data);

    let vertex_buffer_view = gltf_json::buffer::View {
        buffer: Index::new(0),
        byte_length: USize64(buffer.len() as u64 - buffer_start),
        byte_offset: Some(USize64(buffer_start)),
        byte_stride: Some(gltf_json::buffer::Stride(size_of::<BspVertexData>())),
        extensions: Default::default(),
        extras: Default::default(),
        name: None,
        target: Some(gltf_json::validation::Checked::Valid(gltf_json::buffer::Target::ArrayBuffer)),
    };

    let vertex_view = Index::new(gltf.buffer_views.len() as u32);
    gltf.buffer_views.push(vertex_buffer_view);

    let positions = gltf_json::Accessor {
        buffer_view: Some(vertex_view),
        byte_offset: Some(USize64(0)),
        count: USize64(vertex_count),
        component_type: gltf_json::validation::Checked::Valid(gltf_json::accessor::GenericComponentType(gltf_json::accessor::ComponentType::F32)),
        extensions: Default::default(),
        extras: Default::default(),
        type_: gltf_json::validation::Checked::Valid(gltf_json::accessor::Type::Vec3),
        min: Some(gltf_json::Value::from(map_coords(min).to_vec())),
        max: Some(gltf_json::Value::from(map_coords(max).to_vec())),
        name: None,
        normalized: false,
        sparse: None,
    };
    let uvs = gltf_json::Accessor {
        buffer_view: Some(vertex_view),
        byte_offset: Some(USize64(size_of::<[f32; 3]>() as u64)),
        count: USize64(vertex_count),
        component_type: gltf_json::validation::Checked::Valid(gltf_json::accessor::GenericComponentType(gltf_json::accessor::ComponentType::F32)),
        extensions: Default::default(),
        extras: Default::default(),
        type_: gltf_json::validation::Checked::Valid(gltf_json::accessor::Type::Vec2),
        min: None,
        max: None,
        name: None,
        normalized: false,
        sparse: None,
    };

    let accessor_start = gltf.accessors.len() as u32;
    gltf.accessors.push(positions);
    gltf.accessors.push(uvs);

    // TEXCOORD_1 走独立 buffer view + accessor（不改变 BspVertexData 的 stride，
    // 避免给既有无光照路径增加每顶点 8 B 的几何开销）。
    let lightmap_buffer_start = buffer.len() as u64;
    buffer.extend_from_slice(bytemuck::cast_slice::<[f32; 2], u8>(&lightmap_uvs));
    let lightmap_view = Index::new(gltf.buffer_views.len() as u32);
    gltf.buffer_views.push(gltf_json::buffer::View {
        buffer: Index::new(0),
        byte_length: USize64(buffer.len() as u64 - lightmap_buffer_start),
        byte_offset: Some(USize64(lightmap_buffer_start)),
        byte_stride: None,
        extensions: Default::default(),
        extras: Default::default(),
        name: None,
        target: Some(gltf_json::validation::Checked::Valid(
            gltf_json::buffer::Target::ArrayBuffer,
        )),
    });
    gltf.accessors.push(gltf_json::Accessor {
        buffer_view: Some(lightmap_view),
        byte_offset: Some(USize64(0)),
        count: USize64(vertex_count),
        component_type: gltf_json::validation::Checked::Valid(
            gltf_json::accessor::GenericComponentType(gltf_json::accessor::ComponentType::F32),
        ),
        extensions: Default::default(),
        extras: Default::default(),
        type_: gltf_json::validation::Checked::Valid(gltf_json::accessor::Type::Vec2),
        min: None,
        max: None,
        name: None,
        normalized: false,
        sparse: None,
    });

    let material_index = if options.textures {
        Some(push_or_get_material_bsp(
            buffer,
            gltf,
            bsp,
            face.texture().name(),
            options,
            missing_resources,
            texture_collector,
        ))
    } else {
        None
    };

    gltf_json::mesh::Primitive {
        attributes: {
            let mut map = std::collections::BTreeMap::new();
            map.insert(
                gltf_json::validation::Checked::Valid(gltf_json::mesh::Semantic::Positions),
                Index::new(accessor_start),
            );
            map.insert(
                gltf_json::validation::Checked::Valid(gltf_json::mesh::Semantic::TexCoords(0)),
                Index::new(accessor_start + 1),
            );
            map.insert(
                gltf_json::validation::Checked::Valid(gltf_json::mesh::Semantic::TexCoords(1)),
                Index::new(accessor_start + 2),
            );
            map
        },
        extensions: Default::default(),
        extras: serde_json::value::RawValue::from_string(
            format!(r#"{{"faceIndex":{},"hasLightmap":{}}}"#, face_index, has_lightmap)
        ).ok(),
        indices: None,
        material: material_index,
        mode: gltf_json::validation::Checked::Valid(gltf_json::mesh::Mode::Triangles),
        targets: None,
    }
}

/// 逐顶点求三个轴各自的 min / max，返回 `(min, max)`。
///
/// 初值取 `f32::MAX` / `f32::MIN`，故**迭代器为空时返回 `(MAX, MIN)` 这个反向退化框**
/// （调用点只在有顶点的面上调用，不会走到）。
fn bounding_box(vertices: impl IntoIterator<Item = crate::vbsp::Vector>) -> ([f32; 3], [f32; 3]) {
    let mut min = crate::vbsp::Vector::from([f32::MAX, f32::MAX, f32::MAX]);
    let mut max = crate::vbsp::Vector::from([f32::MIN, f32::MIN, f32::MIN]);

    for point in vertices {
        min.x = f32::min(min.x, point.x);
        min.y = f32::min(min.y, point.y);
        min.z = f32::min(min.z, point.z);

        max.x = f32::max(max.x, point.x);
        max.y = f32::max(max.y, point.y);
        max.z = f32::max(max.z, point.z);
    }
    (min.into(), max.into())
}

/// 逐顶点写入顶点 buffer 的布局：`position`（3 × f32）+ `uv`（2 × f32），stride 20 B。
///
/// `#[repr(C)]` + `bytemuck::Pod` 使它可以直接 `cast` 成字节切片；两个字段都是**私有**的，
/// 因此结构体虽然 `pub`，外部只能通过本模块的推送函数间接使用。
#[derive(Copy, Clone, Debug, Default, Zeroable, Pod)]
#[repr(C)]
pub struct BspVertexData {
    position: [f32; 3],
    uv: [f32; 2],
}
