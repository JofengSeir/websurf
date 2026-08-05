//! 材质模块

use crate::bsp_to_gltf_core::{ConvertOptions, Error, MissingResource, ResourceSource, ResourceType};
use image::imageops::FilterType;
use image::DynamicImage;
use tf_asset_loader::Loader;
use crate::vbsp::Bsp;

/// 材质数据
pub struct MaterialData {
    pub name: String,
    /// 材质的源 VMT 文件路径。
    ///
    /// 当前未参与 glTF 输出，但保留用于：
    ///   - 调试输出中显示材质来源
    ///   - 未来扩展：在 glTF extras 中嵌入 VMT 路径供下游工具使用
    ///   - 资源依赖分析
    #[allow(dead_code)]
    pub path: String,
    pub color: [u8; 4],
    pub texture: Option<TextureData>,
    pub alpha_test: Option<f32>,
    pub translucent: bool,
    pub no_cull: bool,
    pub transform: Option<vmt_parser::TextureTransform>,
}

impl Default for MaterialData {
    fn default() -> Self {
        MaterialData {
            name: String::new(),
            path: String::new(),
            color: [255, 255, 255, 255],
            texture: None,
            alpha_test: None,
            translucent: false,
            no_cull: false,
            transform: None,
        }
    }
}

/// 纹理数据
pub struct TextureData {
    pub name: String,
    pub image: DynamicImage,
}



/// 纹理收集器
pub struct TextureCollector {
    pub textures: Vec<String>,
}

impl TextureCollector {
    /// 创建新的纹理收集器
    pub fn new() -> Self {
        TextureCollector {
            textures: Vec::new(),
        }
    }
    
    /// 添加纹理
    pub fn add_texture(&mut self, texture: String) {
        if !self.textures.contains(&texture) {
            self.textures.push(texture);
        }
    }
}

/// 加载材质（带 fallback）
pub fn load_material_fallback(
    name: &str,
    paths: &[String],
    loader: &Loader,
    options: &ConvertOptions,
    missing_resources: &mut Vec<MissingResource>,
    texture_collector: Option<&mut TextureCollector>,
) -> MaterialData {
    // 收集纹理信息
    if let Some(collector) = texture_collector {
        collector.add_texture(name.to_string());
    }
    
    match load_material(name, paths, loader, options) {
        Ok(mat) => mat,
        Err(e) => {
            if options.generate_missing_list {
                missing_resources.push(MissingResource {
                    r#type: ResourceType::Material,
                    name: name.to_string(),
                    reason: format!("Failed to load material: {:?}", e),
                    possible_source: ResourceSource::GameDirectory,
                });
            }
            MaterialData {
                name: name.to_string(),
                path: String::new(),
                color: [255, 255, 255, 255],
                ..MaterialData::default()
            }
        }
    }
}

/// 从 BSP 文件加载材质（带 fallback）
pub fn load_material_fallback_bsp(
    name: &str,
    paths: &[String],
    bsp: &Bsp,
    options: &ConvertOptions,
    missing_resources: &mut Vec<MissingResource>,
    texture_collector: Option<&mut TextureCollector>,
) -> MaterialData {
    // 收集纹理信息
    if let Some(collector) = texture_collector {
        collector.add_texture(name.to_string());
    }
    
    match load_material_bsp(name, paths, bsp, options) {
        Ok(mat) => mat,
        Err(e) => {
            if options.generate_missing_list {
                missing_resources.push(MissingResource {
                    r#type: ResourceType::Material,
                    name: name.to_string(),
                    reason: format!("Failed to load material from BSP: {:?}", e),
                    possible_source: ResourceSource::BspFile,
                });
            }
            MaterialData {
                name: name.to_string(),
                path: String::new(),
                color: [255, 255, 255, 255],
                ..MaterialData::default()
            }
        }
    }
}

/// 加载材质
fn load_material(
    _name: &str,
    _paths: &[String],
    _loader: &Loader,
    _options: &ConvertOptions,
) -> Result<MaterialData, Error> {
    // 简化实现，只返回默认材质
    Err(Error::Other("Material loading not implemented in core version".to_string()))
}

/// 从 BSP 文件加载材质
fn load_material_bsp(
    name: &str,
    _paths: &[String],
    bsp: &Bsp,
    options: &ConvertOptions,
) -> Result<MaterialData, Error> {
    // 生成多种可能的VMT文件路径格式
    let name = name.trim_end_matches(".vmt");
    let possible_paths = vec![
        // 原始格式
        format!("materials/{}.vmt", name),
        // 小写格式
        format!("materials/{}.vmt", name.to_lowercase()),
        // 大写格式
        format!("materials/{}.vmt", name.to_uppercase()),
        // 替换斜杠为下划线
        format!("materials/{}.vmt", name.replace('/', "_"))
    ];
    
    // 尝试所有可能的路径
    let (vmt_path, vmt_data) = possible_paths
        .iter()
        .find_map(|path| {
            match bsp.pack.get(path) {
                Ok(Some(data)) => Some((path.clone(), data)),
                _ => None,
            }
        })
        .ok_or_else(|| {
            let paths_str = possible_paths.join(", ");
            Error::Other(format!("Can't find VMT file in BSP. Tried: {}", paths_str))
        })?;
    
    let vdf = String::from_utf8(vmt_data.to_vec())?;
    
    let material = match vmt_parser::from_str(&vdf) {
        Ok(material) => material,
        Err(e) => {
            // 处理不支持的材质类型
            println!("Unsupported material type: {:?}", e);
            return Ok(MaterialData {
                name: name.to_string(),
                path: vmt_path,
                color: [255, 255, 255, 255],
                ..MaterialData::default()
            });
        }
    };
    
    let material = material.resolve(|path| {
        // 生成多种可能的路径格式
        let path = path.trim_start_matches('/');
        let possible_paths = vec![
            format!("materials/{}", path),
            format!("materials/{}", path.to_lowercase())
        ];
        
        // 尝试所有可能的路径
        let data = possible_paths
            .iter()
            .find_map(|full_path| {
                match bsp.pack.get(full_path) {
                    Ok(Some(data)) => Some(data),
                    _ => None,
                }
            })
            .ok_or_else(|| {
                let paths_str = possible_paths.join(", ");
                Error::Other(format!("Can't find file in BSP. Tried: {}", paths_str))
            })?;
        
        let vdf = String::from_utf8(data.to_vec())?;
        Ok::<_, Error>(vdf)
    })?;

    let base_texture = match material.base_texture() {
        Some(texture) => texture,
        None => {
            // 如果没有基础纹理，返回默认材质数据
            return Ok(MaterialData {
                name: name.to_string(),
                path: vmt_path,
                color: [255, 255, 255, 255],
                ..MaterialData::default()
            });
        }
    };

    let translucent = material.translucent();
    let glass = material.surface_prop() == Some("glass");
    let alpha_test = material.alpha_test();
    
    // 尝试加载纹理，如果失败则使用默认材质数据
    let texture_data = match load_texture_bsp(base_texture, bsp, options) {
        Ok(texture) => Some(TextureData {
            name: base_texture.to_string(),
            image: texture,
        }),
        Err(e) => {
            println!("Failed to load texture: {:?}, using default material", e);
            None
        }
    };

    let transform = material
        .base_texture_transform()
        .filter(|transform| **transform != vmt_parser::TextureTransform::default())
        .cloned();

    Ok(MaterialData {
        color: [255; 4],
        name: name.to_string(),
        path: vmt_path,
        texture: texture_data,
        alpha_test,
        translucent: translucent | glass,
        no_cull: material.no_cull(),
        transform,
    })
}

/// 从BSP文件中加载纹理
fn load_texture_bsp(
    name: &str,
    bsp: &Bsp,
    options: &ConvertOptions,
) -> Result<DynamicImage, Error> {
    let name = name.trim_end_matches(".vtf").trim_start_matches('/');
    
    // 生成多种可能的VTF文件路径格式
    let possible_paths = vec![
        // 原始格式
        format!("materials/{}.vtf", name),
        // 小写格式
        format!("materials/{}.vtf", name.to_lowercase()),
        // 大写格式
        format!("materials/{}.vtf", name.to_uppercase()),
        // 替换斜杠为下划线
        format!("materials/{}.vtf", name.replace('/', "_"))
    ];
    
    // 尝试所有可能的路径
    let vtf_data = possible_paths
        .iter()
        .find_map(|path| {
            match bsp.pack.get(path) {
                Ok(Some(data)) => Some(data),
                _ => None,
            }
        })
        .ok_or_else(|| {
            let paths_str = possible_paths.join(", ");
            Error::Other(format!("Can't find VTF file in BSP. Tried: {}", paths_str))
        })?;
    
    let vtf = vtf::vtf::VTF::read(&vtf_data)?;
    let image = vtf.highres_image.decode(0)?;
    
    if options.texture_scale != 1.0 {
        Ok(image.resize(
            (image.width() as f32 * options.texture_scale) as u32,
            (image.height() as f32 * options.texture_scale) as u32,
            FilterType::CatmullRom,
        ))
    } else {
        Ok(image)
    }
}
