//! 模型整合器：把 `.mdl/.vvd/.dx90.vtx` 模型合并进地图 GLB。
//!
//! WASM 环境无文件系统，统一走 `from_in_memory` + [`InMemoryResources`] 路径；
//! 磁盘模式（new-vbsp CLI 遗留的 `new()` / `export_map` / 目录遍历等）已清理移除。

use std::collections::HashMap;
use std::mem;
use std::path::Path;

use bytemuck::{Pod, Zeroable};
use cgmath::{Deg, Quaternion, Rotation3};
use gltf::json as json;
use gltf::json::scene::UnitQuaternion;
use gltf::json::validation::USize64;
use gltf::json::{Index, Node, Root};
use serde::Deserialize;
use thiserror::Error;
use vmdl::{Mdl, Model as VmdlModel, Vtx, Vvd};

/// 模型整合错误
#[derive(Error, Debug)]
pub enum ModelIntegratorError {
    #[error("GLTF 错误: {0}")]
    Gltf(#[from] gltf::Error),

    #[error("模型错误: {0}")]
    Model(#[from] vmdl::ModelError),

    #[error("JSON 错误: {0}")]
    Json(#[from] serde_json::Error),

    #[error("不支持的模型格式: {0}")]
    UnsupportedModelFormat(String),
}

/// 导出模型选项（WASM 下通常只用默认值）
#[derive(Debug, Default)]
pub struct ExportOptions {
    /// 是否包含光照（light 实体 → KHR_lights_punctual 扩展）
    pub include_lights: bool,
}

/// 内存中的单个模型字节数据（替代磁盘 .mdl/.vvd/.dx90.vtx 三件套）
#[derive(Debug, Clone, Deserialize)]
pub struct InMemoryModel {
    /// 模型路径（需与 BSP 静态道具字典中的模型名一致，用于位置/朝向匹配）
    pub name: String,
    pub mdl: Vec<u8>,
    pub vvd: Vec<u8>,
    pub vtx: Vec<u8>,
}

/// 内存资源集合（用于 WASM / 无文件系统环境，替代磁盘 resource_dir）
#[derive(Debug, Clone, Default)]
pub struct InMemoryResources {
    pub models: Vec<InMemoryModel>,
    pub entities: Vec<Entity>,
    pub static_props: Vec<StaticProp>,
    pub textures: HashMap<String, Vec<u8>>,
    pub light_entities: Vec<Entity>,
    /// 材质名 → 透明度模式：0=不透明(默认)，1=半透明(Blend)，2=透明测试(Mask)。
    /// 用于 GLB 导出的材质 `alphaMode`，以及碰撞体生成时判断"透明可穿过"。
    pub material_alpha_mode: HashMap<String, u8>,
}

/// 模型整合器
pub struct ModelIntegrator {
    in_memory: InMemoryResources,
    options: ExportOptions,
}

impl ModelIntegrator {
    /// 使用内存资源创建整合器（WASM / 无文件系统环境）。
    ///
    /// 模型/纹理字节由调用方提供；静态道具位置/朝向由调用方预先填入 `static_props`。
    pub fn from_in_memory(resources: InMemoryResources, options: ExportOptions) -> Self {
        Self {
            in_memory: resources,
            options,
        }
    }

    /// 将模型合并到现有 GLTF 结构中（地图 GLB 导出共用）。
    ///
    /// 直接从内存资源合并模型，不触碰文件系统。
    pub fn add_models_to_gltf(
        &self,
        gltf: &mut Root,
        buffer: &mut Vec<u8>,
    ) -> Result<(), ModelIntegratorError> {
        let resources = &self.in_memory;

        for in_mem in &resources.models {
            // 取文件名用于与 BSP 静态道具字典匹配
            let model_filename = Path::new(&in_mem.name)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&in_mem.name)
                .to_string();

            // 从内存字节加载模型（单个模型解析失败时跳过，避免整批合并中断）
            let model = match self.load_model_from_bytes(&in_mem.mdl, &in_mem.vvd, &in_mem.vtx) {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("⚠️ 跳过无法解析的模型 {}: {:?}", in_mem.name, e);
                    continue;
                }
            };
            if model.vertices().is_empty() {
                continue;
            }

            // 查找放置信息（**全部**实例；与碰撞体导出共用 resolve_placements）
            let placements = resolve_placements(&in_mem.name, &resources.entities, &resources.static_props);
            if placements.is_empty() {
                // 未被任何静态道具/实体引用 → 不放到世界原点制造垃圾几何
                continue;
            }

            // 推送模型几何（同一模型的多个实例共享同一 mesh，只上传一次顶点）
            let mesh = self.push_model(buffer, gltf, &model, Path::new(&in_mem.name))?;
            let mesh_index = gltf.meshes.len() as u32;
            gltf.meshes.push(mesh);

            for (i, p) in placements.iter().enumerate() {
                let node = Node {
                    camera: None,
                    children: None,
                    extensions: Default::default(),
                    extras: Default::default(),
                    matrix: None,
                    mesh: Some(Index::new(mesh_index)),
                    name: Some(if i == 0 {
                        model_filename.clone()
                    } else {
                        format!("{model_filename}#{i}")
                    }),
                    rotation: p.rotation.map(UnitQuaternion),
                    scale: p.scale,
                    translation: Some(p.translation),
                    skin: None,
                    weights: None,
                };
                gltf.nodes.push(node);
            }
        }

        // 处理光照数据（若启用）
        if self.options.include_lights {
            let mut light_nodes = Vec::new();
            self.process_lights(gltf, &mut light_nodes, &resources.light_entities)?;
            gltf.nodes.extend(light_nodes);
        }

        Ok(())
    }

    /// 为 GLTF JSON 字符串添加光照信息。
    ///
    /// 序列化后通过字符串级补丁注入 `KHR_lights_punctual` 扩展（light_spot / light_environment / light）。
    pub fn add_lighting_to_gltf_json(&self, json_string: &str) -> Result<String, ModelIntegratorError> {
        if self.options.include_lights {
            let light_entities = self.read_light_entities();
            if !light_entities.is_empty() {
                self.add_lighting_to_json(json_string.to_string(), &light_entities)
            } else {
                Ok(json_string.to_string())
            }
        } else {
            Ok(json_string.to_string())
        }
    }

    /// 读取光照实体数据（内存路径）
    fn read_light_entities(&self) -> Vec<Entity> {
        self.in_memory.light_entities.clone()
    }

    /// 从内存字节加载模型（替代磁盘三件套 .mdl/.vvd/.dx90.vtx）
    fn load_model_from_bytes(&self, mdl_data: &[u8], vvd_data: &[u8], vtx_data: &[u8]) -> Result<VmdlModel, ModelIntegratorError> {
        let mdl = Mdl::read(mdl_data)?;
        let vvd = Vvd::read(vvd_data)?;
        let vtx = Vtx::read(vtx_data)?;
        Ok(VmdlModel::from_parts(mdl, vtx, vvd))
    }

    /// 推送模型到GLTF
    fn push_model(&self, buffer: &mut Vec<u8>, gltf: &mut Root, model: &VmdlModel, model_path: &Path) -> Result<json::Mesh, ModelIntegratorError> {
        let accessor_start = gltf.accessors.len() as u32;
        self.push_vertices(buffer, gltf, model);

        // 获取第一个皮肤表
        let skin_table = model.skin_tables().next().ok_or(ModelIntegratorError::UnsupportedModelFormat("No skin table found".into()))?;

        let mut primitives = Vec::new();
        for mesh in model.meshes() {
            primitives.push(self.push_primitive(buffer, gltf, &mesh, accessor_start, &skin_table)?);
        }

        Ok(json::Mesh {
            extensions: Default::default(),
            extras: Default::default(),
            name: Some(model_path.file_stem().unwrap_or_default().to_str().unwrap_or_default().into()),
            primitives,
            weights: None,
        })
    }

    /// 推送顶点到 GLTF
    fn push_vertices(&self, buffer: &mut Vec<u8>, gltf: &mut Root, model: &VmdlModel) {
        let start = buffer.len() as u64;
        let view_start = gltf.buffer_views.len() as u32;
        let vertex_count = model.vertices().len() as u64;

        let (min, max) = model.bounding_box();
        let min = map_coords(model.apply_root_transform(min));
        let max = map_coords(model.apply_root_transform(max));

        let vertex_data = model
            .vertices()
            .iter()
            .map(|vert| ModelVertex::from(vert, model))
            .flat_map(|vert| bytemuck::cast::<_, [u8; mem::size_of::<ModelVertex>()]>(vert));
        buffer.extend(vertex_data);

        let vertex_buffer_view = json::buffer::View {
            buffer: Index::new(0),
            byte_length: USize64(buffer.len() as u64 - start),
            byte_offset: Some(USize64(start)),
            byte_stride: Some(json::buffer::Stride(mem::size_of::<ModelVertex>())),
            extensions: Default::default(),
            extras: Default::default(),
            name: None,
            target: Some(json::validation::Checked::Valid(json::buffer::Target::ArrayBuffer)),
        };

        gltf.buffer_views.push(vertex_buffer_view);

        let positions = json::Accessor {
            buffer_view: Some(Index::new(view_start)),
            byte_offset: Some(USize64(0)),
            count: USize64(vertex_count),
            component_type: json::validation::Checked::Valid(json::accessor::GenericComponentType(json::accessor::ComponentType::F32)),
            extensions: Default::default(),
            extras: Default::default(),
            type_: json::validation::Checked::Valid(json::accessor::Type::Vec3),
            min: Some(json::Value::from(Vec::from(min))),
            max: Some(json::Value::from(Vec::from(max))),
            name: None,
            normalized: false,
            sparse: None,
        };
        let uvs = json::Accessor {
            buffer_view: Some(Index::new(view_start)),
            byte_offset: Some(USize64(mem::size_of::<[f32; 3]>() as u64)),
            count: USize64(vertex_count),
            component_type: json::validation::Checked::Valid(json::accessor::GenericComponentType(json::accessor::ComponentType::F32)),
            extensions: Default::default(),
            extras: Default::default(),
            type_: json::validation::Checked::Valid(json::accessor::Type::Vec2),
            min: None,
            max: None,
            name: None,
            normalized: false,
            sparse: None,
        };
        let normals = json::Accessor {
            buffer_view: Some(Index::new(view_start)),
            byte_offset: Some(USize64((mem::size_of::<[f32; 3]>() + mem::size_of::<[f32; 2]>()) as u64)),
            count: USize64(vertex_count),
            component_type: json::validation::Checked::Valid(json::accessor::GenericComponentType(json::accessor::ComponentType::F32)),
            extensions: Default::default(),
            extras: Default::default(),
            type_: json::validation::Checked::Valid(json::accessor::Type::Vec3),
            min: None,
            max: None,
            name: None,
            normalized: false,
            sparse: None,
        };

        gltf.accessors.extend([positions, uvs, normals]);
    }

    /// 推送图元到 GLTF
    fn push_primitive(&self, buffer: &mut Vec<u8>, gltf: &mut Root, mesh: &vmdl::Mesh, vertex_accessor_start: u32, skin: &vmdl::SkinTable) -> Result<json::mesh::Primitive, ModelIntegratorError> {
        let buffer_start = buffer.len() as u64;
        let view_start = gltf.buffer_views.len() as u32;
        let accessor_start = gltf.accessors.len() as u32;

        // 推送索引数据
        buffer.extend(
            mesh.vertex_strip_indices()
                .flatten()
                .flat_map(|index| (index as u32).to_le_bytes()),
        );

        let byte_length = buffer.len() as u64 - buffer_start;

        let view = json::buffer::View {
            buffer: Index::new(0),
            byte_length: USize64(byte_length),
            byte_offset: Some(USize64(buffer_start)),
            byte_stride: None,
            extensions: Default::default(),
            extras: Default::default(),
            name: None,
            target: Some(json::validation::Checked::Valid(json::buffer::Target::ElementArrayBuffer)),
        };
        gltf.buffer_views.push(view);

        let accessor = json::Accessor {
            buffer_view: Some(Index::new(view_start)),
            byte_offset: Some(USize64(0)),
            count: USize64(byte_length / mem::size_of::<u32>() as u64),
            component_type: json::validation::Checked::Valid(json::accessor::GenericComponentType(json::accessor::ComponentType::U32)),
            extensions: Default::default(),
            extras: Default::default(),
            type_: json::validation::Checked::Valid(json::accessor::Type::Scalar),
            min: None,
            max: None,
            name: None,
            normalized: false,
            sparse: None,
        };
        gltf.accessors.push(accessor);

        // 尝试获取材质信息
        let material_index = self.push_material(buffer, gltf, skin, mesh.material_index());

        // 创建图元
        Ok(json::mesh::Primitive {
            attributes: {
                let mut map = std::collections::BTreeMap::new();
                map.insert(
                    json::validation::Checked::Valid(json::mesh::Semantic::Positions),
                    Index::new(vertex_accessor_start),
                );
                map.insert(
                    json::validation::Checked::Valid(json::mesh::Semantic::TexCoords(0)),
                    Index::new(vertex_accessor_start + 1),
                );
                map.insert(
                    json::validation::Checked::Valid(json::mesh::Semantic::Normals),
                    Index::new(vertex_accessor_start + 2),
                );
                map
            },
            extensions: Default::default(),
            extras: Default::default(),
            indices: Some(Index::new(accessor_start)),
            material: material_index,
            mode: json::validation::Checked::Valid(json::mesh::Mode::Triangles),
            targets: None,
        })
    }

    /// 推送材质到 GLTF
    fn push_material(&self, buffer: &mut Vec<u8>, gltf: &mut Root, skin: &vmdl::SkinTable, material_index: i32) -> Option<Index<gltf::json::Material>> {
        // 尝试获取纹理信息
        if let Some(texture_info) = skin.texture_info(material_index) {
            let material_name = texture_info.name.to_string();

            // 尝试加载纹理文件
            let texture_index = self.push_texture(buffer, gltf, &material_name);

            // 有真实贴图时基色必须为白（否则给贴图叠加染色）；
            // 无贴图时才回退到「按材质名生成的可区分颜色」。
            let color = if texture_index.is_some() {
                gltf::json::material::PbrBaseColorFactor([1.0, 1.0, 1.0, 1.0])
            } else {
                self.get_material_color(&material_name)
            };

            // 解析内置透明度标注（来自 VMT 的 $translucent / $alphatest / $alpha）
            let alpha_mode = self
                .in_memory
                .material_alpha_mode
                .get(&material_name)
                .copied()
                .unwrap_or(0u8);
            let (alpha_mode, double_sided, alpha_cutoff) = match alpha_mode {
                1 => (
                    gltf::json::validation::Checked::Valid(gltf::json::material::AlphaMode::Blend),
                    true,
                    None,
                ),
                2 => (
                    gltf::json::validation::Checked::Valid(gltf::json::material::AlphaMode::Mask),
                    false,
                    Some(gltf::json::material::AlphaCutoff(0.5)),
                ),
                _ => (
                    gltf::json::validation::Checked::Valid(gltf::json::material::AlphaMode::Opaque),
                    false,
                    None,
                ),
            };

            // 创建材质
            let material = gltf::json::Material {
                extensions: Default::default(),
                extras: Default::default(),
                name: Some(material_name.clone()),
                pbr_metallic_roughness: gltf::json::material::PbrMetallicRoughness {
                    base_color_factor: color,
                    base_color_texture: texture_index.map(|idx| json::texture::Info {
                        index: Index::new(idx),
                        tex_coord: 0,
                        extensions: Default::default(),
                        extras: Default::default(),
                    }),
                    extensions: Default::default(),
                    extras: Default::default(),
                    metallic_factor: gltf::json::material::StrengthFactor(0.0),
                    metallic_roughness_texture: None,
                    roughness_factor: gltf::json::material::StrengthFactor(1.0),
                },
                normal_texture: None,
                occlusion_texture: None,
                emissive_factor: gltf::json::material::EmissiveFactor([0.0, 0.0, 0.0]),
                emissive_texture: None,
                alpha_cutoff,
                alpha_mode,
                double_sided,
            };

            let index = gltf.materials.len() as u32;
            gltf.materials.push(material);
            Some(Index::new(index))
        } else {
            None
        }
    }

    /// 根据材质名称获取颜色
    fn get_material_color(&self, name: &str) -> gltf::json::material::PbrBaseColorFactor {
        // 根据材质名称生成颜色
        let hash = name.bytes().fold(0u32, |acc, b| acc.wrapping_add(b as u32));
        let r = ((hash & 0xFF0000) >> 16) as f32 / 255.0;
        let g = ((hash & 0x00FF00) >> 8) as f32 / 255.0;
        let b = (hash & 0x0000FF) as f32 / 255.0;

        // 确保颜色不会太暗
        let r = r.max(0.3);
        let g = g.max(0.3);
        let b = b.max(0.3);

        gltf::json::material::PbrBaseColorFactor([r, g, b, 1.0])
    }

    /// 推送纹理到GLTF（内存纹理优先：WASM / 无文件系统环境下由调用方直接提供 PNG 字节）
    fn push_texture(&self, buffer: &mut Vec<u8>, gltf: &mut Root, texture_name: &str) -> Option<u32> {
        if let Some(texture_data) = self.in_memory.textures.get(texture_name) {
            return self.push_texture_data(buffer, gltf, texture_name, texture_data);
        }
        // 也允许以 .png 为键
        let png_key = format!("{}.png", texture_name);
        if let Some(texture_data) = self.in_memory.textures.get(&png_key) {
            return self.push_texture_data(buffer, gltf, texture_name, texture_data);
        }

        eprintln!("⚠️  未找到纹理: {:?}", texture_name);
        None
    }

    /// 将已获取的纹理字节推入 GLTF 缓冲区
    fn push_texture_data(&self, buffer: &mut Vec<u8>, gltf: &mut Root, texture_name: &str, texture_data: &[u8]) -> Option<u32> {
        // 推送纹理到缓冲区
        let start = buffer.len() as u64;
        buffer.extend_from_slice(texture_data);

        // 创建缓冲区视图
        let view = json::buffer::View {
            buffer: Index::new(0),
            byte_length: USize64((buffer.len() as u64) - start),
            byte_offset: Some(USize64(start)),
            byte_stride: None,
            extensions: Default::default(),
            extras: Default::default(),
            name: Some(texture_name.to_string()),
            target: None,
        };
        let view_index = gltf.buffer_views.len() as u32;
        gltf.buffer_views.push(view);

        // 创建图像
        let image = json::Image {
            uri: None,
            buffer_view: Some(Index::new(view_index)),
            mime_type: Some(gltf::json::image::MimeType("image/png".to_string())),
            name: Some(texture_name.to_string()),
            extensions: Default::default(),
            extras: Default::default(),
        };
        let image_index = gltf.images.len() as u32;
        gltf.images.push(image);

        // 创建纹理
        let texture = json::Texture {
            name: Some(texture_name.to_string()),
            extensions: Default::default(),
            extras: Default::default(),
            source: Index::new(image_index),
            sampler: None,
        };
        let texture_index = gltf.textures.len() as u32;
        gltf.textures.push(texture);

        Some(texture_index)
    }

    /// 处理光照数据
    fn process_lights(&self, gltf: &mut Root, nodes: &mut Vec<Node>, light_entities: &[Entity]) -> Result<(), ModelIntegratorError> {
        // 添加KHR_lights_punctual扩展到used和required列表
        let extension_name = "KHR_lights_punctual";

        if !gltf.extensions_used.contains(&extension_name.to_string()) {
            gltf.extensions_used.push(extension_name.to_string());
        }
        if !gltf.extensions_required.contains(&extension_name.to_string()) {
            gltf.extensions_required.push(extension_name.to_string());
        }

        // 为每个光照实体创建对应的节点
        for (i, light_entity) in light_entities.iter().enumerate() {
            if let Some(origin) = &light_entity.properties.origin {
                if let Some(position) = parse_origin_str(origin) {
                    // 创建光照节点
                    let light_node = Node {
                        camera: None,
                        children: None,
                        extensions: Default::default(),
                        extras: Default::default(),
                        matrix: None,
                        mesh: None,
                        name: Some(format!("light_{}", i)),
                        rotation: None,
                        scale: None,
                        translation: Some(position),
                        skin: None,
                        weights: None,
                    };

                    nodes.push(light_node);
                }
            }
        }

        Ok(())
    }

    /// 为 JSON 字符串添加光照效果
    fn add_lighting_to_json(&self, json_string: String, light_entities: &[Entity]) -> Result<String, ModelIntegratorError> {
        // 解析 JSON
        let mut json: serde_json::Value = serde_json::from_str(&json_string)?;

        // 添加 KHR_lights_punctual 扩展
        let extension_name = "KHR_lights_punctual";

        // 确保 extensions 字段存在
        if let serde_json::Value::Object(ref mut obj) = json {
            if !obj.contains_key("extensions") {
                obj.insert("extensions".to_string(), serde_json::Value::Object(serde_json::Map::new()));
            }
        }

        // 创建 lights 数组
        let mut lights = Vec::new();
        let mut light_nodes = Vec::new();

        // 为每个光照实体创建光源
        for (i, light_entity) in light_entities.iter().enumerate() {
            if let Some(origin) = &light_entity.properties.origin {
                if let Some(position) = parse_origin_str(origin) {
                    // 解析真实光照参数
                    let (color, brightness) = self.parse_light_color(light_entity);
                    let classname = light_entity.properties.classname.as_str();

                    // 按 classname 决定光源类型
                    let (light_type, has_spot, has_direction) = match classname {
                        "light_spot" => ("spot", true, true),
                        "light_environment" => ("directional", false, true),
                        _ => ("point", false, false),
                    };

                    // 计算范围：directional 光源不需要 range
                    let range = if light_type == "directional" {
                        None
                    } else {
                        Some(self.parse_light_range(light_entity))
                    };

                    // intensity 换算：Source brightness 大致映射到 glTF intensity
                    let intensity = brightness.max(0.0) * 5.0;

                    // 构建光源定义
                    let mut light = serde_json::Map::new();
                    light.insert("name".to_string(), serde_json::Value::String(format!("light_{}", i)));
                    light.insert("type".to_string(), serde_json::Value::String(light_type.to_string()));
                    light.insert("color".to_string(), serde_json::json!([color[0], color[1], color[2]]));
                    light.insert("intensity".to_string(), serde_json::json!(intensity));
                    if let Some(r) = range {
                        light.insert("range".to_string(), serde_json::json!(r));
                    }

                    // spot 光源额外加 innerConeAngle / outerConeAngle
                    if has_spot {
                        let (inner, outer) = self.parse_cone_angle(light_entity);
                        let mut spot = serde_json::Map::new();
                        spot.insert("innerConeAngle".to_string(), serde_json::json!(inner));
                        spot.insert("outerConeAngle".to_string(), serde_json::json!(outer));
                        light.insert("spot".to_string(), serde_json::Value::Object(spot));
                    }

                    // spot / directional 额外加 direction
                    if has_direction {
                        let direction = self.parse_light_direction(light_entity)
                            .unwrap_or([0.0, -1.0, 0.0]);
                        light.insert("direction".to_string(), serde_json::json!([direction[0], direction[1], direction[2]]));
                    }

                    lights.push(serde_json::Value::Object(light));

                    // 记录光照节点信息
                    light_nodes.push((i, position));
                }
            }
        }

        // 添加光源到扩展
        if !lights.is_empty() {
            if let serde_json::Value::Object(ref mut obj) = json {
                if let Some(serde_json::Value::Object(ref mut extensions)) = obj.get_mut("extensions") {
                    extensions.insert(extension_name.to_string(), serde_json::json!({
                        "lights": lights
                    }));
                }
            }

            // 为光照节点添加光源引用
            if let serde_json::Value::Object(ref mut obj) = json {
                if let Some(serde_json::Value::Array(nodes)) = obj.get_mut("nodes") {
                    for (light_index, _position) in light_nodes {
                        // 查找对应的光照节点
                        for node in nodes.iter_mut() {
                            if let serde_json::Value::Object(ref mut node_obj) = node {
                                if let Some(serde_json::Value::String(name)) = node_obj.get("name") {
                                    if *name == format!("light_{}", light_index) {
                                        // 添加光源扩展到节点
                                        if !node_obj.contains_key("extensions") {
                                            node_obj.insert("extensions".to_string(), serde_json::Value::Object(serde_json::Map::new()));
                                        }
                                        if let Some(serde_json::Value::Object(ref mut node_extensions)) = node_obj.get_mut("extensions") {
                                            node_extensions.insert(extension_name.to_string(), serde_json::json!({
                                                "light": light_index
                                            }));
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 序列化回 JSON 字符串
        let modified_json = serde_json::to_string(&json)?;
        Ok(modified_json)
    }

    /// 解析实体的 `_light` 属性，返回 (归一化 RGB 颜色, brightness)。
    /// `_light` 格式为 `"r g b"` 或 `"r g b brightness"`，RGB 范围 0-255 或 0-1
    /// （自动归一化到 0-1）。缺失时返回默认 ([1.0, 1.0, 1.0], 200.0)。
    fn parse_light_color(&self, entity: &Entity) -> ([f32; 3], f32) {
        let default: ([f32; 3], f32) = ([1.0, 1.0, 1.0], 200.0);
        let light_str = match &entity.properties.light {
            Some(s) => s,
            None => return default,
        };

        let parts: Vec<f32> = light_str
            .split_whitespace()
            .filter_map(|s| s.parse::<f32>().ok())
            .collect();

        match parts.len() {
            3 => {
                let max = parts.iter().cloned().fold(0.0f32, f32::max).abs();
                let scale = if max > 1.0 { 1.0 / 255.0 } else { 1.0 };
                ([parts[0] * scale, parts[1] * scale, parts[2] * scale], 200.0)
            }
            4 | 5 => {
                let max = parts[0..3].iter().cloned().fold(0.0f32, f32::max).abs();
                let scale = if max > 1.0 { 1.0 / 255.0 } else { 1.0 };
                ([parts[0] * scale, parts[1] * scale, parts[2] * scale], parts[3])
            }
            _ => {
                eprintln!("⚠️  无法解析 _light 属性: {:?}", light_str);
                default
            }
        }
    }

    /// 解析实体的光照方向（spot / directional 用）。
    /// 优先读 `angles`（"pitch yaw roll"），其次读单独 `pitch` 字段。
    /// 返回的方向已转换到 glTF 坐标系。缺失时返回 None。
    fn parse_light_direction(&self, entity: &Entity) -> Option<[f32; 3]> {
        let (pitch, yaw) = if let Some(angles) = &entity.properties.angles {
            let parts: Vec<f32> = angles
                .split_whitespace()
                .filter_map(|s| s.parse::<f32>().ok())
                .collect();
            if parts.len() >= 2 {
                (parts[0], parts[1])
            } else {
                return None;
            }
        } else if let Some(pitch_str) = &entity.properties.pitch {
            // 单独的 pitch 字段，yaw 默认为 0
            match pitch_str.parse::<f32>() {
                Ok(p) => (p, 0.0),
                Err(_) => return None,
            }
        } else {
            return None;
        };

        let pitch_rad = pitch.to_radians();
        let yaw_rad = yaw.to_radians();

        // Source 坐标系下的方向向量（X 前向，Y 左侧，Z 上）
        let dx = pitch_rad.cos() * yaw_rad.cos();
        let dy = pitch_rad.cos() * yaw_rad.sin();
        let dz = pitch_rad.sin();

        // 转换到 glTF 坐标系
        Some(map_coords([dx, dy, dz]))
    }

    /// 从 `_constant_attn` / `_linear_attn` / `_quadratic_attn` 计算有效光照范围。
    /// 求解衰减公式 `quadratic*d^2 + linear*d + (constant - brightness) = 0` 的正根。
    /// 三个衰减参数均缺失时返回默认 500.0。
    fn parse_light_range(&self, entity: &Entity) -> f32 {
        // 三个衰减参数均缺失时使用默认范围
        if entity.properties.constant_attn.is_none()
            && entity.properties.linear_attn.is_none()
            && entity.properties.quadratic_attn.is_none()
        {
            return 500.0;
        }

        let constant = entity
            .properties
            .constant_attn
            .as_ref()
            .and_then(|s| s.parse::<f32>().ok())
            .unwrap_or(0.0);
        let linear = entity
            .properties
            .linear_attn
            .as_ref()
            .and_then(|s| s.parse::<f32>().ok())
            .unwrap_or(0.0);
        let quadratic = entity
            .properties
            .quadratic_attn
            .as_ref()
            .and_then(|s| s.parse::<f32>().ok())
            .unwrap_or(0.0);
        let brightness = self.parse_light_color(entity).1.max(1.0);

        if quadratic > 0.0 {
            // 求解 quadratic*d^2 + linear*d + (constant - brightness) = 0
            let disc = linear * linear - 4.0 * quadratic * (constant - brightness);
            if disc >= 0.0 {
                let d = (-linear + disc.sqrt()) / (2.0 * quadratic);
                if d.is_finite() && d > 0.0 {
                    return d.max(1.0);
                }
            }
            return 500.0;
        }

        if linear > 0.0 {
            // linear*d + (constant - brightness) = 0
            let d = (brightness - constant) / linear;
            if d.is_finite() && d > 0.0 {
                return d.max(1.0);
            }
            return 500.0;
        }

        // 仅 constant 衰减（恒定衰减），使用默认范围
        500.0
    }

    /// 解析 `_cone` / `_inner_cone` 锥角（度），返回 (innerConeAngle, outerConeAngle) 弧度。
    /// 缺失时默认 outer=45°, inner=outer*0.5；确保 0 <= inner < outer。
    fn parse_cone_angle(&self, entity: &Entity) -> (f32, f32) {
        let outer_deg = entity
            .properties
            .cone
            .as_ref()
            .and_then(|s| s.parse::<f32>().ok())
            .unwrap_or(45.0);
        let inner_deg = entity
            .properties
            .inner_cone
            .as_ref()
            .and_then(|s| s.parse::<f32>().ok())
            .unwrap_or(outer_deg * 0.5);

        // 限制到合理范围
        let outer_deg = outer_deg.clamp(1.0, 179.0);
        let inner_deg = inner_deg.clamp(0.0, (outer_deg - 1.0).max(0.0));

        (inner_deg.to_radians(), outer_deg.to_radians())
    }
}

/// 实体属性
#[derive(Debug, Clone, Deserialize)]
pub struct EntityProperties {
    #[serde(rename = "classname")]
    pub classname: String,
    #[serde(rename = "model")]
    pub model: Option<String>,
    #[serde(rename = "origin")]
    pub origin: Option<String>,
    #[serde(rename = "angles")]
    pub angles: Option<String>,
    #[serde(rename = "scale")]
    pub scale: Option<String>,
    // 光照相关属性（BSP 中以 _ 前缀的动态键）
    #[serde(rename = "_light")]
    pub light: Option<String>,
    #[serde(rename = "_cone")]
    pub cone: Option<String>,
    #[serde(rename = "_inner_cone")]
    pub inner_cone: Option<String>,
    #[serde(rename = "_constant_attn")]
    pub constant_attn: Option<String>,
    #[serde(rename = "_linear_attn")]
    pub linear_attn: Option<String>,
    #[serde(rename = "_quadratic_attn")]
    pub quadratic_attn: Option<String>,
    #[serde(rename = "pitch")]
    pub pitch: Option<String>,
}

/// 实体
#[derive(Debug, Clone, Deserialize)]
pub struct Entity {
    pub properties: EntityProperties,
}

/// 静态模型
#[derive(Debug, Clone, Deserialize)]
pub struct StaticProp {
    pub model: String,
    pub origin: [f32; 3],
    pub angles: [f32; 3],
    pub solid: u8,
}

/// 单个模型实例的放置信息（坐标已转换到 `map_coords` = `[y,z,x]` 的 Y-up 空间）。
///
/// **GLB 节点与碰撞体 brush 必须由同一份 `Placement` 生成**，否则会
/// 「看得到摸不着 / 摸得到看不见」。参见 [`resolve_placements`]。
#[derive(Debug, Clone)]
pub struct Placement {
    /// 节点平移（`map_coords(origin)`）
    pub translation: [f32; 3],
    /// 节点旋转四元数 `[x, y, z, w]`
    pub rotation: Option<[f32; 4]>,
    /// 节点缩放
    pub scale: Option<[f32; 3]>,
    /// 静态道具的 `solid`（`SolidType`）字段；`0 = SOLID_NONE` 表示明确无碰撞。
    /// 实体来源时为 `None`。
    pub solid: Option<u8>,
}

/// 把 `"pitch yaw roll"`（度）转成四元数 `[x, y, z, w]`。
///
/// 组合顺序 `yaw * pitch * roll`（先绕 Y，再绕 X，最后绕 Z），
/// 与 Source 引擎 `QAngle` 的语义一致。
pub fn angles_to_quat(pitch: f32, yaw: f32, roll: f32) -> [f32; 4] {
    let pitch_quat = Quaternion::<f32>::from_angle_x(Deg(pitch));
    let yaw_quat = Quaternion::<f32>::from_angle_y(Deg(yaw));
    let roll_quat = Quaternion::<f32>::from_angle_z(Deg(roll));
    let q = yaw_quat * pitch_quat * roll_quat;
    [q.v.x, q.v.y, q.v.z, q.s]
}

/// 解析某个模型在地图中的**全部**放置实例。
///
/// 同一 `.mdl` 在地图中常被复用多次（surf 图斜坡尤其如此），必须返回全部实例
/// 而非首个匹配 —— 旧实现只取首个，导致同一模型只显示一份、其余实例消失。
///
/// 匹配优先级：
/// 1. `static_props` **完整路径**精确匹配（忽略大小写与 `\`/`/` 差异）——最可靠；
/// 2. 回退到**文件名包含**匹配（兼容磁盘模式下只有文件名可用的老路径）；
/// 3. 再回退到实体（`prop_dynamic` 等）的 `model` 字段匹配。
pub fn resolve_placements(
    model_full_path: &str,
    entities: &[Entity],
    static_props: &[StaticProp],
) -> Vec<Placement> {
    fn normalize(s: &str) -> String {
        s.replace('\\', "/").to_ascii_lowercase()
    }

    let full = normalize(model_full_path);
    let filename = full.rsplit('/').next().unwrap_or(&full).to_string();

    let from_prop = |prop: &StaticProp| Placement {
        translation: map_coords(prop.origin),
        rotation: Some(angles_to_quat(prop.angles[0], prop.angles[1], prop.angles[2])),
        scale: Some([1.0, 1.0, 1.0]),
        solid: Some(prop.solid),
    };

    // 1. 完整路径精确匹配
    let mut out: Vec<Placement> = static_props
        .iter()
        .filter(|p| normalize(&p.model) == full)
        .map(from_prop)
        .collect();
    if !out.is_empty() {
        return out;
    }

    // 2. 文件名包含匹配
    out = static_props
        .iter()
        .filter(|p| normalize(&p.model).contains(&filename))
        .map(from_prop)
        .collect();
    if !out.is_empty() {
        return out;
    }

    // 3. 实体来源
    for entity in entities {
        let Some(model_path) = &entity.properties.model else {
            continue;
        };
        if !normalize(model_path).contains(&filename) {
            continue;
        }
        let Some(origin) = &entity.properties.origin else {
            continue;
        };
        let Some(translation) = parse_origin_str(origin) else {
            continue;
        };
        out.push(Placement {
            translation,
            rotation: entity
                .properties
                .angles
                .as_ref()
                .and_then(|a| parse_angles_str(a)),
            scale: entity
                .properties
                .scale
                .as_ref()
                .and_then(|s| parse_scale_str(s)),
            solid: None,
        });
    }
    out
}

/// 解析 `"x y z"` 形式的 origin 字符串并转换到 Y-up 空间。
pub fn parse_origin_str(origin: &str) -> Option<[f32; 3]> {
    let parts: Vec<&str> = origin.split_whitespace().collect();
    if parts.len() != 3 {
        return None;
    }
    Some(map_coords([
        parts[0].parse::<f32>().ok()?,
        parts[1].parse::<f32>().ok()?,
        parts[2].parse::<f32>().ok()?,
    ]))
}

/// 解析 `"pitch yaw roll"` 字符串为四元数。
pub fn parse_angles_str(angles: &str) -> Option<[f32; 4]> {
    let parts: Vec<&str> = angles.split_whitespace().collect();
    if parts.len() != 3 {
        return None;
    }
    Some(angles_to_quat(
        parts[0].parse::<f32>().ok()?,
        parts[1].parse::<f32>().ok()?,
        parts[2].parse::<f32>().ok()?,
    ))
}

/// 解析 scale 字符串（单值或三值）。
pub fn parse_scale_str(scale: &str) -> Option<[f32; 3]> {
    let parts: Vec<&str> = scale.split_whitespace().collect();
    match parts.len() {
        1 => {
            let s = parts[0].parse::<f32>().ok()?;
            Some([s, s, s])
        }
        3 => Some([
            parts[0].parse::<f32>().ok()?,
            parts[1].parse::<f32>().ok()?,
            parts[2].parse::<f32>().ok()?,
        ]),
        _ => None,
    }
}

/// 模型顶点
#[derive(Copy, Clone, Debug, Default, Zeroable, Pod)]
#[repr(C)]
pub struct ModelVertex {
    position: [f32; 3],
    uv: [f32; 2],
    normal: [f32; 3],
}

impl ModelVertex {
    /// 从 vmdl 顶点创建模型顶点
    fn from(vertex: &vmdl::vvd::Vertex, model: &VmdlModel) -> Self {
        ModelVertex {
            position: map_coords(model.apply_root_transform(vertex.position)),
            uv: vertex.texture_coordinates,
            normal: vertex.normal.into(),
        }
    }
}

/// 映射坐标（Source Z-up → glTF Y-up）
pub fn map_coords<C: Into<[f32; 3]>>(vec: C) -> [f32; 3] {
    let vec = vec.into();
    [vec[1], vec[2], vec[0]]
}
