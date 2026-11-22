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
//! - 无光照或无图集时仍写中性常量 UV，保证同一块几何的属性集一致（下游合并要求属性集相同）；
//! - BSP 内嵌 brush 实体（`func_door` / `func_wall_toggle` 等 `"*N"` 模型）各导出一个可寻址
//!   节点（name = `brush_<实体下标>`，extras 带 `vbsp_entity_index` 等，见 [`bsp_models`]）；
//!   世界模型节点名保持 `"bsp"` 且永远排在最后。
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

/// prop 的**第 3 级光照**来源：按 `static_props` 下标给出的「所在 leaf 的 lightmap 颜色」。
///
/// 采样点与 `vbsp::Bsp::prop_ambient_cube` **完全一致**：`StaticPropLump::flags` 的 `0x2`
/// 位置位时取 `lighting_origin`，否则取 `origin`，坐标不旋转、不做 `map_coords`。
/// 少一处「光照采样点」就会与第 2 级 ambient cube 说的不是同一个位置，故口径必须共用。
///
/// 返回表长度 = `integrator.static_prop_count()`，与 `Placement::prop_index` 对齐；
/// 某下标采不到（无 lightmap / 该 leaf 的面都没有区域）时留 `None`，由调用方保持原行为。

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

    // BSP 内嵌结构：世界模型 + 可见 brush 实体（不含 ModelIntegrator 的外部模型）。
    // 实体遍历只做一次：世界模型 + 可见 brush 实体都从这一次 `bsp_models` 收集结果来。
    let models = bsp_models(&bsp)?;
    for entry in &models {
        let tc_clone = texture_collector.clone();
        let node = push_bsp_model_bsp(
            &mut buffer,
            &mut root,
            &bsp,
            &entry.model,
            entry.offset,
            entry.tint,
            entry.rot.as_ref(),
            entry.entity.as_ref(),
            entry.render_mode,
            &options,
            &mut missing_resources,
            Some(tc_clone),
            lightmap.as_ref(),
        );
        root.nodes.push(node);
    }

    // #2：BSP 水面 top/bottom 厚度写进材质 extras（只加数据，不改渲染）。
    // 复用上面已收集的模型列表，避免再遍历一次实体。
    apply_water_thickness(&mut root, &models);

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
    let mosaic: Vec<(String, String)> = texture_collector.borrow().mosaic.iter().cloned().collect();
    
    Ok(ExportResult {
        glb,
        missing_resources,
        textures,
        mosaic,
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
    // 实体遍历只做一次：世界模型 + 可见 brush 实体都从这一次 `bsp_models` 收集结果来。
    let models = bsp_models(&bsp)?;
    for entry in &models {
        let tc_clone = texture_collector.clone();
        let node = push_bsp_model_bsp(
            &mut buffer,
            &mut root,
            &bsp,
            &entry.model,
            entry.offset,
            entry.tint,
            entry.rot.as_ref(),
            entry.entity.as_ref(),
            entry.render_mode,
            &options,
            &mut missing_resources,
            Some(tc_clone),
            lightmap.as_ref(),
        );
        root.nodes.push(node);
    }

    // #2：BSP 水面 top/bottom 厚度写进材质 extras（只加数据，不改渲染）。
    // 复用上面已收集的模型列表，避免再遍历一次实体。
    apply_water_thickness(&mut root, &models);

    // 2. 若提供模型集成器，将模型数据添加到统一结构
    if let Some(integrator) = model_integrator {
        // 直接获取模型数据并添加到统一结构
        if let Err(e) = integrator.add_models_to_gltf(&mut root, &mut buffer) {
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
    let mosaic: Vec<(String, String)> = texture_collector.borrow().mosaic.iter().cloned().collect();
    
    Ok(ExportResult {
        glb,
        missing_resources,
        textures,
        mosaic,
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
    let mosaic: Vec<(String, String)> = texture_collector.borrow().mosaic.iter().cloned().collect();
    
    Ok(ExportResult {
        glb,
        missing_resources,
        textures,
        mosaic,
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

/// `momentary_rot_button` 的旋转参数：写进 GLB 节点 extras `vbsp_rot_button`，
/// 渲染端据此把该模型的 mesh 从合并块里摘出来、挂到 pivot 上做旋转动画。
///
/// `id` 在「本次导出的旋钮实体」里递增且唯一：同一个实体的多个 primitive/mesh
/// 共用同一个 `id`，渲染端按它分组。
#[derive(Debug, Clone)]
struct RotButtonExport {
    id: usize,
    /// `map_coords` 之后的世界坐标（= 旋转中心，three 的 Y 轴是 Source 的 Z 轴）。
    origin: [f32; 3],
    /// 角速度（度/秒）。
    speed: f32,
    /// 开到位需要转过的角度（度），符号表示方向。
    distance: f32,
    spawn_flags: u32,
    target: Option<String>,
    parent: Option<String>,
    /// Source `rendermode`：`1`/`5` 需要按加法混合画出「发光」观感（符文盘盘面）。
    render_mode: u8,
}

/// 可见 brush 实体的 classname 白名单（实体文本已整体小写，匹配时仍按忽略大小写比较）。
///
/// 这些实体的几何都是 `"*N"` 引用的 BSP 模型。原先只收强类型 `Entity` 里的 4 个 brush
/// 变体，而 `BrushEntity` 把 `model` / `origin` / `rendercolor` 当必填（`vbsp/data/entity.rs`），
/// 本图 6 个 `func_wall_toggle` 全缺 `origin` ⇒ 整条 `Entity::parse()` 失败、被 `flat_map`
/// 静默丢弃（含 `*9` 的 848 面）。现在 [`bsp_models`] 直接读 `RawEntity` 的键、缺键按默认值，
/// 不再因缺字段丢实体。
///
/// 暂不含 `func_water_analog`：水刷的可见面会进 [`apply_water_thickness`] 的水层统计，
/// 纳入会改变水面材质 `waterThickness` 的口径；本图没有该实体，留待单独任务。
const VISIBLE_BRUSH_CLASSNAMES: &[&str] = &[
    "func_brush",
    "func_illusionary",
    "func_wall",
    "func_wall_toggle",
    "func_door",
    "func_door_rotating",
    "func_movelinear",
    "func_breakable",
    "func_breakable_surf",
    "func_button",
    "func_rot_button",
    "func_rotating",
    "func_tracktrain",
    "func_physbox",
    "func_physbox_multiplayer",
];

/// 一个 brush 实体在 GLB 节点 extras 里的可寻址元数据。
///
/// 节点名同样用 `brush_<index>`；extras 里再带一份，是为了让下游（后续的可选增强插件）
/// 按实体定位 mesh，而不必解析节点名。`index` 是实体在 entities lump 里的下标
/// （`bsp.entities.iter().enumerate()` 的序号，0 起），与实体书写顺序一致。
struct BrushEntityExport {
    index: usize,
    classname: String,
    targetname: Option<String>,
    parentname: Option<String>,
    /// `"*N"` 原样保留（extras `vbsp_model`）。
    model: String,
}

/// 一个待导出模型：模型句柄 + 世界平移 + 可选的实体 extras。
///
/// 世界模型也走这个结构（`entity` / `tint` / `rot` / `render_mode` 全 `None`），
/// 只是永远排在导出列表最后。
struct BspModelExport<'a> {
    model: crate::vbsp::Handle<'a, crate::vbsp::Model>,
    /// 模型几何在局部空间，该平移量 = 实体 `origin`（写节点时经 [`map_coords`]）。
    offset: crate::vbsp::Vector,
    /// 实体染色（`rendercolor`）。仅 `momentary_rot_button` 使用，语义与既有导出一致。
    tint: Option<[u8; 4]>,
    /// `momentary_rot_button` 的旋转参数。
    rot: Option<RotButtonExport>,
    /// 只有「`momentary_rot_button` 强类型解析失败、退回普通 brush 导出」时才写
    /// `vbsp_render_mode`，保持这一既有 extras 字段的形状。
    render_mode: Option<u8>,
    /// `Some` = brush 实体节点（`brush_<index>`）；`None` = 世界模型节点（`bsp`）。
    entity: Option<BrushEntityExport>,
}

/// 取 `RawEntity` 的字符串键；键不存在时返回 `None`（把 `prop` 的 `Err` 统一收掉）。
fn entity_prop<'a>(raw: &crate::vbsp::RawEntity<'a>, key: &'static str) -> Option<&'a str> {
    raw.prop(key).ok()
}

/// `origin` 的容错解析：缺键 / 空串 / 非 `"x y z"` 一律回落 `(0,0,0)`。
///
/// 缺 `origin` 是 `func_wall_toggle` 这类实体的常态（模型就在世界原点），不能像强类型
/// 反序列化那样把整条实体判失败。解析本身复用 `RawEntity::prop_parse`（与旧 typed 路径
/// 同一套 `EntityProp` 口径）。
fn entity_origin(raw: &crate::vbsp::RawEntity<'_>) -> crate::vbsp::Vector {
    raw.prop_parse::<crate::vbsp::Vector>("origin")
        .unwrap_or_default()
}

/// `rendercolor` 的容错解析（`"r g b"`，0–255）；缺键 / 格式不符回落白色。
fn entity_color(raw: &crate::vbsp::RawEntity<'_>) -> [u8; 4] {
    let [r, g, b] = raw
        .prop_parse::<[u8; 3]>("rendercolor")
        .unwrap_or([255, 255, 255]);
    [r, g, b, 255]
}

/// `rendermode` 的容错解析；缺键 / 格式不符回落 `0`（Source `kRenderNormal`）。
fn entity_render_mode(raw: &crate::vbsp::RawEntity<'_>) -> u8 {
    raw.prop_parse::<u8>("rendermode").unwrap_or(0)
}

/// 非空实体名（`targetname` / `parentname`）：空串视为没写，避免 extras 里出现 `""`。
fn non_empty_owned(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_owned)
}

/// 从 entities lump 的无损原文按出现顺序解析每块的 `(targetname, parentname)`，**保留原始大小写**。
///
/// `Entities::iter()` 读的是整体小写视图（`vbsp/reader.rs` 读入时先 `to_ascii_lowercase`），
/// 值里的大小写已经丢失；而实体 I/O（`export_entity_io`）与运行期实体名走的是
/// `Entities::raw()` 原文。GLB 节点 extras 里的可寻址名字要与运行期一致，所以这里对原文
/// 再切一遍块（切法与 `Entities::iter` 相同：找最近的 `{` 与随后的 `}`），按忽略大小写的键名
/// 取值。键名大小写不敏感、值原样保留；找不到成对引号就停止扫描（与 `RawEntity::properties`
/// 的容错一致）。
///
/// 返回的下标与 `Entities::iter().enumerate()` 一一对应（同一个文本的两个视图结构相同）；
/// 越界时调用方按「没有原文名字」处理。
fn raw_entity_names(entity_text: &str) -> Vec<(Option<String>, Option<String>)> {
    let mut names = Vec::new();
    let mut cursor = entity_text;
    loop {
        let Some(open) = cursor.find('{') else {
            break;
        };
        let Some(close) = cursor[open..].find('}') else {
            break;
        };
        let block = &cursor[open..open + close + 1];
        let mut targetname = None;
        let mut parentname = None;
        let mut rest = block;
        loop {
            let Some(key_open) = rest.find('"') else {
                break;
            };
            let key_start = key_open + 1;
            let Some(key_len) = rest[key_start..].find('"') else {
                break;
            };
            let key = &rest[key_start..key_start + key_len];
            let after_key = &rest[key_start + key_len + 1..];
            let Some(value_open) = after_key.find('"') else {
                break;
            };
            let value_start = value_open + 1;
            let Some(value_len) = after_key[value_start..].find('"') else {
                break;
            };
            let value = &after_key[value_start..value_start + value_len];
            if key.eq_ignore_ascii_case("targetname") {
                targetname = Some(value.to_owned());
            } else if key.eq_ignore_ascii_case("parentname") {
                parentname = Some(value.to_owned());
            }
            rest = &after_key[value_start + value_len + 1..];
        }
        names.push((targetname, parentname));
        cursor = &cursor[open + close + 1..];
    }
    names
}

/// 用原文里的 `targetname` / `parentname`（保留大小写）覆盖节点 extras 元数据。
///
/// 原文里缺该键 / 索引越界时保留调用方从小写视图取到的值（空串已按 `None` 处理）。
fn apply_raw_entity_names(
    meta: &mut BrushEntityExport,
    raw_names: &[(Option<String>, Option<String>)],
    entity_index: usize,
) {
    let Some((targetname, parentname)) = raw_names.get(entity_index) else {
        return;
    };
    if targetname.is_some() {
        meta.targetname = targetname.clone();
    }
    if parentname.is_some() {
        meta.parentname = parentname.clone();
    }
}

/// 从 `RawEntity` 收集一个 brush 实体；`model` 不是 `"*N"` / 下标越界 / 没有可见面时返回 `None`。
///
/// 这里只做「这个实体该不该有节点」的预判（至少一个 `face.is_visible()`），真正的逐面过滤
/// 仍在 [`push_bsp_model_bsp`]，两处口径一致。`targetname` / `parentname` 优先取
/// [`raw_entity_names`] 的原文大小写版本（与运行期实体名一致），小写视图只作兜底。
fn collect_brush_entity<'a>(
    bsp: &'a Bsp,
    entity_index: usize,
    classname: &str,
    raw: &crate::vbsp::RawEntity<'_>,
    raw_names: &[(Option<String>, Option<String>)],
) -> Option<BspModelExport<'a>> {
    let model_ref = entity_prop(raw, "model")?;
    let model = model_of(bsp, model_ref)?;
    if !model.faces().any(|face| face.is_visible()) {
        return None;
    }
    let mut entity = BrushEntityExport {
        index: entity_index,
        classname: classname.to_owned(),
        targetname: non_empty_owned(entity_prop(raw, "targetname")),
        parentname: non_empty_owned(entity_prop(raw, "parentname")),
        model: model_ref.to_owned(),
    };
    apply_raw_entity_names(&mut entity, raw_names, entity_index);
    Some(BspModelExport {
        model,
        offset: entity_origin(raw),
        tint: None,
        rot: None,
        render_mode: None,
        entity: Some(entity),
    })
}

/// 收集要导出的模型：可见 brush 实体各一个，**世界模型排最后**（origin 取 `(0,0,0)`）。
///
/// 实现上**不复用**强类型 `Entity` 反序列化：实体文本已被读入层整体小写，直接按
/// classname 白名单（[`VISIBLE_BRUSH_CLASSNAMES`]）遍历 [`crate::vbsp::RawEntity`]，用
/// `enumerate` 拿到实体下标写进节点 extras。缺 `origin` 按 `(0,0,0)`、缺
/// `rendercolor` / `rendermode` 按白色 / `kRenderNormal` 处理，**绝不因缺字段丢实体**。
///
/// `momentary_rot_button` 单独处理：仍走强类型 `Entity::MomentaryRotButton` 取旋转参数
/// （`speed` / `distance` / `spawnflags` / `targetname` / `parentname` / `render_mode`），
/// 既有 `vbsp_rot_button` extras 语义不变；强类型解析失败时退回普通 brush 导出，
/// 并用 `RawEntity` 解析出的 `rendercolor` / `rendermode` 补上
/// `vbsp_render_color` / `vbsp_render_mode`（缺键即白色 / 0）。
///
/// 一个模型都没有（`bsp.models()` 为空）时报 `Error::Other("No world model")`。
fn bsp_models<'a>(bsp: &'a Bsp) -> Result<Vec<BspModelExport<'a>>, Error> {
    let world_model = bsp
        .models()
        .next()
        .ok_or(Error::Other("No world model".into()))?;

    let mut models = Vec::new();
    let mut rot_index = 0usize;
    // 运行期实体名保留原文大小写（实体 I/O 走 `Entities::raw()`）；GLB extras 的名字也照原文，
    // 避免「3D 节点里的名字」与「运行期 targetname」大小写分叉（本图有 lvl3_door06A/B/C 三例）。
    let raw_names = raw_entity_names(bsp.entities.raw());
    for (entity_index, raw) in bsp.entities.iter().enumerate() {
        let Some(classname) = entity_prop(&raw, "classname") else {
            continue;
        };

        if classname == "momentary_rot_button" {
            // 带染色与旋转的 brush 实体（boreas 的符文盘就是 5 个这样的实体）。它的
            // `rendercolor` 是 Source 的实体染色（`rendermode 1` = kRenderTransColor，
            // 把颜色乘到贴图上），必须一路带到 GLB 节点 extras：材质本身是白色
            // UnlitGeneric，不带染色就显示成白色符文线。旋转参数同样要带走：
            // `logic_auto` 在 OnMapSpawn 里给这类实体发 `SetPosition 1`，地图意图是
            // 开图就让它们按 `speed` 转到 `distance`。
            if let Ok(Entity::MomentaryRotButton(ent)) = raw.parse() {
                if let Some(model) = model_of(bsp, ent.model) {
                    if model.faces().any(|face| face.is_visible()) {
                        let rot = RotButtonExport {
                            id: rot_index,
                            origin: map_coords(ent.origin),
                            speed: ent.speed.unwrap_or(0.0),
                            distance: ent.distance.unwrap_or(0.0),
                            spawn_flags: ent.spawn_flags,
                            target: ent.target.map(str::to_owned),
                            parent: ent.parent.map(str::to_owned),
                            render_mode: ent.render_mode,
                        };
                        rot_index += 1;
                        let mut entity = BrushEntityExport {
                            index: entity_index,
                            classname: classname.to_owned(),
                            targetname: ent.target.map(str::to_owned),
                            parentname: ent.parent.map(str::to_owned),
                            model: ent.model.to_owned(),
                        };
                        apply_raw_entity_names(&mut entity, &raw_names, entity_index);
                        models.push(BspModelExport {
                            model,
                            offset: ent.origin,
                            tint: Some([ent.color.r, ent.color.g, ent.color.b, 255]),
                            rot: Some(rot),
                            render_mode: None,
                            entity: Some(entity),
                        });
                        continue;
                    }
                }
            }
            // 强类型解析失败（例如此类实体缺 `rendercolor`）时不能把几何一起丢掉：
            // 按普通 brush 实体导出，仍带从原文解析出的染色/渲染模式。
            if let Some(mut entry) =
                collect_brush_entity(bsp, entity_index, classname, &raw, &raw_names)
            {
                entry.tint = Some(entity_color(&raw));
                entry.render_mode = Some(entity_render_mode(&raw));
                models.push(entry);
            }
            continue;
        }

        if !VISIBLE_BRUSH_CLASSNAMES
            .iter()
            .any(|known| classname.eq_ignore_ascii_case(known))
        {
            continue;
        }
        if let Some(entry) = collect_brush_entity(bsp, entity_index, classname, &raw, &raw_names) {
            models.push(entry);
        }
    }

    models.push(BspModelExport {
        model: world_model,
        offset: crate::vbsp::Vector {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        },
        // 世界模型没有实体染色（它的面颜色全部来自 lightmap 与材质本身）。
        tint: None,
        rot: None,
        render_mode: None,
        entity: None,
    });

    Ok(models)
}

/// 把实体里的 `"*N"` 模型引用解成 `Bsp.models` 的下标；空串/非 `*` 开头/越界都返回 `None`。
fn model_of<'a>(bsp: &'a Bsp, model: &str) -> Option<crate::vbsp::Handle<'a, crate::vbsp::Model>> {
    let index = model.strip_prefix('*')?.parse::<usize>().ok()?;
    bsp.models().nth(index)
}

/// 把一个模型推成一个 GLB 节点：逐 face 生成 primitive（**只取 `face.is_visible()` 的面**），
/// 返回该节点。
///
/// 节点可寻址性由 `entity` 决定：`Some` 时 name 用唯一的 `brush_<实体下标>`，extras 写
/// `vbsp_entity_index` / `vbsp_classname` / `vbsp_model` 与可选的
/// `vbsp_targetname` / `vbsp_parentname`；`None` 是世界模型节点，name 保持 `"bsp"`。
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
    // 实体染色（`rendercolor`）。`Some` 时写进节点 extras `vbsp_render_color`，
    // 渲染端据此把颜色乘到该节点所有子 mesh 的材质上（Source `rendermode 1` 的语义）。
    tint: Option<[u8; 4]>,
    // `momentary_rot_button` 的旋转参数。`Some` 时写进节点 extras `vbsp_rot_button`，
    // 渲染端把该模型的 mesh 从合并块里摘出来挂到 pivot 上做旋转动画。
    rot: Option<&RotButtonExport>,
    // brush 实体的可寻址元数据；`None` 表示这是世界模型节点。
    entity: Option<&BrushEntityExport>,
    // `momentary_rot_button` 强类型解析失败、退回普通 brush 导出时补写的既有
    // `vbsp_render_mode`（缺键为 0）；成功走 `rot` 分支的实体这里传 `None`。
    render_mode: Option<u8>,
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

    // 实体 extras：染色写节点 extras（不是材质 extras），因为染色是「这个实体」的属性，
    // 而材质按贴图名去重、可能被世界面共用。渲染端在装配前把该节点的子 mesh 材质
    // 克隆后乘色，染色不会污染共用材质。旋转参数同理挂在节点上（渲染端按 id 分组、
    // 把 mesh 从合并块里摘出来挂 pivot）。
    //
    // 字段顺序固定：先可寻址元数据，再既有字段（`vbsp_render_color` 在
    // `vbsp_rot_button` 前、`vbsp_render_mode` 在它后），新增字段只追加、不改既有顺序。
    let mut extra_fields: Vec<String> = Vec::new();
    if let Some(meta) = entity {
        extra_fields.push(format!(r#""vbsp_entity_index":{}"#, meta.index));
        if let Ok(json) = serde_json::to_string(&meta.classname) {
            extra_fields.push(format!(r#""vbsp_classname":{}"#, json));
        }
        if let Ok(json) = serde_json::to_string(&meta.model) {
            extra_fields.push(format!(r#""vbsp_model":{}"#, json));
        }
        if let Some(targetname) = &meta.targetname {
            if let Ok(json) = serde_json::to_string(targetname) {
                extra_fields.push(format!(r#""vbsp_targetname":{}"#, json));
            }
        }
        if let Some(parentname) = &meta.parentname {
            if let Ok(json) = serde_json::to_string(parentname) {
                extra_fields.push(format!(r#""vbsp_parentname":{}"#, json));
            }
        }
    }
    if let Some([r, g, b, _a]) = tint {
        extra_fields.push(format!(r#""vbsp_render_color":[{},{},{}]"#, r, g, b));
    }
    if let Some(meta) = rot {
        let mut rot_fields = format!(
            r#""id":{},"origin":[{},{},{}],"speed":{},"distance":{},"spawnflags":{}"#,
            meta.id, meta.origin[0], meta.origin[1], meta.origin[2], meta.speed, meta.distance, meta.spawn_flags,
        );
        if let Some(target) = &meta.target {
            if let Ok(json) = serde_json::to_string(target) {
                rot_fields.push_str(&format!(r#","targetname":{}"#, json));
            }
        }
        if let Some(parent) = &meta.parent {
            if let Ok(json) = serde_json::to_string(parent) {
                rot_fields.push_str(&format!(r#","parentname":{}"#, json));
            }
        }
        extra_fields.push(format!(r#""vbsp_rot_button":{{{}}}"#, rot_fields));
        extra_fields.push(format!(r#""vbsp_render_mode":{}"#, meta.render_mode));
    }
    // 只有「rot_button 强类型解析失败、退回普通 brush 导出」这一条路径会走到这里：
    // 保留既有 `vbsp_render_mode` 字段的形状（成功路径在 rot 分支里已写）。
    if let Some(render_mode) = render_mode {
        extra_fields.push(format!(r#""vbsp_render_mode":{}"#, render_mode));
    }
    let node_extras = if extra_fields.is_empty() {
        None
    } else {
        serde_json::value::RawValue::from_string(format!("{{{}}}", extra_fields.join(","))).ok()
    };

    // 节点名：brush 实体按实体下标唯一命名，世界模型保持 `"bsp"`（既有消费方不依赖节点名，
    // 见 `vbsp_render_color` / `vbsp_rot_button` 的 extras 消费路径；保名只为不惊动未知下游）。
    let node_name = match entity {
        Some(meta) => format!("brush_{}", meta.index),
        None => "bsp".to_owned(),
    };

    Node {
        camera: None,
        children: None,
        extensions: Default::default(),
        extras: node_extras,
        matrix: None,
        mesh: Some(Index::new(mesh_index)),
        name: Some(node_name),
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
/// TEXCOORD_1 是 lightmap UV，命中图集区域的图元按面类型二选一（都不命中时写中性常量
/// `[0, 0]`——**没有 lightmap 也要写**，否则同一块几何里的属性集不一致，下游合并会失败）：
/// **brush 面**用 `lightmap::lightmap_uv` 投影，**位移面**用 `Handle::<Face>::vertex_grid_uv`
/// 给出的细分网格单位方格坐标（口径与理由见该方法的 doc）。
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
            // 位移面走**细分网格** UV（`vertex_grid_uv`），brush 面走投影（`lightmap_uv`）。
            // 两个迭代器与 `vertex_positions()` 逐项对齐，故必须同时推进。
            let mut grid = face.vertex_grid_uv();
            face.vertex_positions()
                .map(|pos| match grid.next().flatten() {
                    Some((gu, gv)) => lightmap::lightmap_region_uv(&export.atlas, region, gu, gv),
                    None => lightmap::lightmap_uv(&export.atlas, region, vbsp_face, texinfo, pos),
                })
                .collect()
        }
        _ => vec![[0.0f32, 0.0f32]; vertex_count as usize],
    };
    let has_lightmap = lightmap_region.is_some();

    // `WorldVertexTransition` 的 `$basetexture2` 混合权重：与 `vertex_positions()` 逐项对齐。
    // 非位移面恒 0；**所有面都写**（哪怕恒 0）——同一 mesh 里属性集必须一致，否则下游合并失败。
    let blend_alphas: Vec<f32> = face.vertex_blend_alphas().collect();

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

    // 混合权重走独立 buffer view + accessor（SCALAR f32），与 TEXCOORD_1 同策：不改变
    // `BspVertexData` 的 stride。
    let blend_buffer_start = buffer.len() as u64;
    buffer.extend_from_slice(bytemuck::cast_slice::<f32, u8>(&blend_alphas));
    let blend_view = Index::new(gltf.buffer_views.len() as u32);
    gltf.buffer_views.push(gltf_json::buffer::View {
        buffer: Index::new(0),
        byte_length: USize64(buffer.len() as u64 - blend_buffer_start),
        byte_offset: Some(USize64(blend_buffer_start)),
        byte_stride: None,
        extensions: Default::default(),
        extras: Default::default(),
        name: None,
        target: Some(gltf_json::validation::Checked::Valid(
            gltf_json::buffer::Target::ArrayBuffer,
        )),
    });
    let blend_accessor = Index::new(gltf.accessors.len() as u32);
    gltf.accessors.push(gltf_json::Accessor {
        buffer_view: Some(blend_view),
        byte_offset: Some(USize64(0)),
        count: USize64(vertex_count),
        component_type: gltf_json::validation::Checked::Valid(
            gltf_json::accessor::GenericComponentType(gltf_json::accessor::ComponentType::F32),
        ),
        extensions: Default::default(),
        extras: Default::default(),
        type_: gltf_json::validation::Checked::Valid(gltf_json::accessor::Type::Scalar),
        min: None,
        max: None,
        name: None,
        normalized: false,
        sparse: None,
    });

    // 逐顶点 BSP face 序号。primitive extras 在 GLTFLoader 里**不会**落到
    // `mesh.userData`（实测 merge 来源表 faceIndex=null），所以把序号做成顶点属性
    // `_VBSP_FACE`，合并后仍能逐三角形/逐面恢复前后关系。
    let face_ids: Vec<f32> = vec![face_index as f32; vertex_count as usize];
    let face_buffer_start = buffer.len() as u64;
    buffer.extend_from_slice(bytemuck::cast_slice::<f32, u8>(&face_ids));
    let face_view = Index::new(gltf.buffer_views.len() as u32);
    gltf.buffer_views.push(gltf_json::buffer::View {
        buffer: Index::new(0),
        byte_length: USize64(buffer.len() as u64 - face_buffer_start),
        byte_offset: Some(USize64(face_buffer_start)),
        byte_stride: None,
        extensions: Default::default(),
        extras: Default::default(),
        name: None,
        target: Some(gltf_json::validation::Checked::Valid(
            gltf_json::buffer::Target::ArrayBuffer,
        )),
    });
    let face_accessor = Index::new(gltf.accessors.len() as u32);
    gltf.accessors.push(gltf_json::Accessor {
        buffer_view: Some(face_view),
        byte_offset: Some(USize64(0)),
        count: USize64(vertex_count),
        component_type: gltf_json::validation::Checked::Valid(
            gltf_json::accessor::GenericComponentType(gltf_json::accessor::ComponentType::F32),
        ),
        extensions: Default::default(),
        extras: Default::default(),
        type_: gltf_json::validation::Checked::Valid(gltf_json::accessor::Type::Scalar),
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
            // 自定义语义：`Semantic::Extras` 自动补前导 `_` ⇒ 上线名 `_VBSP_BLEND`。
            map.insert(
                gltf_json::validation::Checked::Valid(gltf_json::mesh::Semantic::Extras(
                    "VBSP_BLEND".into(),
                )),
                blend_accessor,
            );
            map.insert(
                gltf_json::validation::Checked::Valid(gltf_json::mesh::Semantic::Extras(
                    "VBSP_FACE".into(),
                )),
                face_accessor,
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

/// 水面材质名归一化：把 `_beneath` / `beneath` 底面并回母材质，便于 top/bottom 配对。
fn water_key(name: &str) -> String {
    let mut key = name.to_ascii_lowercase();
    for suffix in ["_beneath", "beneath"] {
        if key.ends_with(suffix) {
            key.truncate(key.len() - suffix.len());
            break;
        }
    }
    key
}

/// #2：按 BSP 面的世界 y 范围算每个水材质/水体块的 top-bottom 厚度，写入
/// `vbsp_water.waterThickness`。只加数据，不改渲染；boreas 单层薄膜得到 0，
/// 666 多层池得到明显厚度。
///
/// `models` 是调用方 [`bsp_models`] 已收集好的模型列表（世界模型 + 可见 brush 实体），
/// 这里直接复用，避免导出期再遍历一遍实体。
fn apply_water_thickness(root: &mut Root, models: &[BspModelExport<'_>]) {
    use std::collections::{BTreeSet, HashMap};
    // 同一水材质会出现在地图多个池子/高度；span 会把整张地图算进去（13312）。
    // 真正的水层厚度是**相邻水层的最小正间隔**：666 的 15296/15312 ⇒ 16，
    // boreas 只有 197 一层 ⇒ 0。
    let mut layers: HashMap<String, BTreeSet<i32>> = HashMap::new();
    for entry in models {
        for face in entry.model.faces() {
            if !face.is_visible() {
                continue;
            }
            let key = water_key(face.texture().name());
            let set = layers.entry(key).or_default();
            for p in face.vertex_positions() {
                // 水面三角面的顶点 y 有 1~2 单位的法线抖动；按 16 HU 量化再找间隔，
                // 否则 666 的 16 厚池子会被算成 1。Source 的 brush 网格也是 16 对齐。
                set.insert((p.y / 16.0).round() as i32);
            }
        }
    }
    for material in &mut root.materials {
        let Some(name) = material.name.as_deref() else { continue };
        let Some(set) = layers.get(&water_key(name)) else { continue };
        let mut thickness = 0.0f32;
        let mut prev: Option<i32> = None;
        let mut best = i32::MAX;
        for &y in set {
            if let Some(p) = prev {
                let gap = y - p;
                if gap > 0 && gap < best {
                    best = gap;
                }
            }
            prev = Some(y);
        }
        if best != i32::MAX {
            thickness = best as f32 * 16.0;
        }
        let Some(extras) = material.extras.as_ref() else { continue };
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(extras.get()) else { continue };
        let Some(water) = value.get_mut("vbsp_water") else { continue };
        water["waterThickness"] = serde_json::json!(thickness);
        if let Ok(raw) = serde_json::value::to_raw_value(&value) {
            material.extras = Some(raw);
        }
    }
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

