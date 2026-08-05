//! 转换模块

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

/// 导出 BSP 文件为 GLTF 格式

/// 从 BSP 文件导出为 GLTF 格式（仅使用 BSP 文件内的资源）
pub fn export_bsp(bsp: Bsp, options: ConvertOptions) -> Result<ExportResult, Error> {
    let mut buffer = Vec::new();
    let mut missing_resources = Vec::new();
    let texture_collector = std::rc::Rc::new(std::cell::RefCell::new(crate::bsp_to_gltf_core::materials::TextureCollector::new()));

    let mut root = Root::default();

    // 只处理地图结构，不处理模型
    for (model, offset) in bsp_models(&bsp)? {
        let tc_clone = texture_collector.clone();
        let node = push_bsp_model_bsp(&mut buffer, &mut root, &bsp, &model, offset, &options, &mut missing_resources, Some(tc_clone));
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

/// 从 BSP 文件导出为 GLTF 格式，并可选嵌入模型
pub fn export_bsp_with_models(bsp: Bsp, options: ConvertOptions, model_integrator: Option<&ModelIntegrator>) -> Result<ExportResult, Error> {
    let mut buffer = Vec::new();
    let mut missing_resources = Vec::new();
    let texture_collector = std::rc::Rc::new(std::cell::RefCell::new(crate::bsp_to_gltf_core::materials::TextureCollector::new()));

    let mut root = Root::default();

    // 1. 处理BSP结构
    for (model, offset) in bsp_models(&bsp)? {
        let tc_clone = texture_collector.clone();
        let node = push_bsp_model_bsp(&mut buffer, &mut root, &bsp, &model, offset, &options, &mut missing_resources, Some(tc_clone));
        root.nodes.push(node);
    }

    // 2. 如果提供了模型集成器，直接将模型数据添加到统一结构中
    if let Some(integrator) = model_integrator {
        // 直接获取模型数据并添加到统一结构
        if let Err(e) = integrator.add_models_to_gltf(&mut root, &mut buffer) {
            // 模型处理失败，返回BSP导出结果
            eprintln!("警告: 模型处理失败: {:?}", e);
            // 构建BSP-only结果
            return build_export_result(root, buffer, missing_resources, texture_collector);
        }
    } else {
        // 没有模型，构建BSP-only结果
        return build_export_result(root, buffer, missing_resources, texture_collector);
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

    // 4. 生成GLB文件
    let mut json_string = json::serialize::to_string(&root).expect("Serialization error");
    
    // 如果模型集成器启用了光照，添加光照信息
    if let Some(integrator) = model_integrator {
        if let Ok(modified_json) = integrator.add_lighting_to_gltf_json(&json_string) {
            json_string = modified_json;
        }
    }
    
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
    texture_collector: std::rc::Rc<std::cell::RefCell<crate::bsp_to_gltf_core::materials::TextureCollector>>
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

    // 生成GLB文件
    let json_string = json::serialize::to_string(&new_root).expect("Serialization error");
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

/// 将模型数据合并到根结构中
///
/// # 保留原因
///
/// 这是早期实现的合并策略之一，当前生产路径使用 [`merge_gltf_structures`]，
/// 但保留此函数作为：
///   - 算法参考（原地修改 vs 构建新根）
///   - 性能基准对比（buffer 复用 vs 拷贝）
///   - 调试时切换合并实现的备选项
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

/// 创建新的GLTF结构，提取所有实体并重新组织
///
/// # 保留原因
///
/// 与 [`merge_model_into_root`] 类似，这是另一种合并策略的实现，
/// 构建全新的根结构而非原地修改。保留以供：
///   - 算法对比基准测试
///   - 在出现合并问题时作为回退方案
///   - 教学参考（不同的索引重映射方式）
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

/// 改进的GLTF结构合并函数
///
/// # 保留原因
///
/// 第二代合并实现，在 [`create_new_gltf_structure`] 基础上优化了
/// 缓冲区合并顺序与索引调整。保留以供：
///   - 不同合并策略的 A/B 对比
///   - 出现退化时回退到该实现
///   - 测试新合并算法时的基线参考
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

/// 对齐到4的倍数
fn align_to_multiple_of_four(n: &mut u32) {
    *n = (*n + 3) & !3;
}

/// 填充字节向量到4的倍数
pub fn pad_byte_vector(vec: &mut Vec<u8>) {
    while vec.len() % 4 != 0 {
        vec.push(0);
    }
}

/// 映射坐标
pub fn map_coords<C: Into<[f32; 3]>>(vec: C) -> [f32; 3] {
    let vec = vec.into();
    [vec[1], vec[2], vec[0]]
}

/// 获取 BSP 模型
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

/// 推送 BSP 模型到 GLTF

/// 从 BSP 文件推送模型到 GLTF
fn push_bsp_model_bsp(
    buffer: &mut Vec<u8>,
    gltf: &mut Root,
    bsp: &Bsp,
    model: &crate::vbsp::Handle<crate::vbsp::Model>,
    offset: crate::vbsp::Vector,
    options: &ConvertOptions,
    missing_resources: &mut Vec<MissingResource>,
    texture_collector: Option<std::rc::Rc<std::cell::RefCell<crate::bsp_to_gltf_core::materials::TextureCollector>>>,
) -> Node {
    let mut primitives = Vec::new();
    // 枚举 face 在 model 中的位置，全局 face 索引 = model.first_face + 位置
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

/// 推送 BSP 面到 GLTF

/// 从 BSP 文件推送面到 GLTF
fn push_bsp_face_bsp(
    buffer: &mut Vec<u8>,
    gltf: &mut Root,
    bsp: &Bsp,
    face: &crate::vbsp::Handle<crate::vbsp::Face>,
    face_index: i32,
    options: &ConvertOptions,
    missing_resources: &mut Vec<MissingResource>,
    texture_collector: Option<std::rc::Rc<std::cell::RefCell<crate::bsp_to_gltf_core::materials::TextureCollector>>>,
) -> gltf_json::mesh::Primitive {
    use bytemuck::cast;

    let vertex_count = face.vertex_positions().count() as u64;

    let buffer_start = buffer.len() as u64;

    let (min, max) = bounding_box(face.vertex_positions());

    let texture = face.texture();
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
            map
        },
        extensions: Default::default(),
        extras: serde_json::value::RawValue::from_string(
            format!(r#"{{"faceIndex":{}}}"#, face_index)
        ).ok(),
        indices: None,
        material: material_index,
        mode: gltf_json::validation::Checked::Valid(gltf_json::mesh::Mode::Triangles),
        targets: None,
    }
}

/// 计算边界框
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

/// BSP 顶点数据
#[derive(Copy, Clone, Debug, Default, Zeroable, Pod)]
#[repr(C)]
pub struct BspVertexData {
    position: [f32; 3],
    uv: [f32; 2],
}
