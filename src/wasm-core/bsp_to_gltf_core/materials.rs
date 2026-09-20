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
    /// 当前未参与 glTF 输出，保留用于调试显示来源、未来在 glTF extras 嵌入、
    /// 资源依赖分析。
    #[allow(dead_code)]
    pub path: String,
    pub color: [u8; 4],
    pub texture: Option<TextureData>,
    pub alpha_test: Option<f32>,
    pub translucent: bool,
    pub no_cull: bool,
    pub transform: Option<vmt_parser::TextureTransform>,
    /// Source 的 `Wireframe` 着色器：**只画多边形边线**（看得穿），不是实体面。
    ///
    /// `vmt_parser` 没有这个材质类型 ⇒ 解析必然失败；用它把「未识别着色器」与「普通不透明」区分开，
    /// 导出到 glTF `extras.vbsp_wireframe`，运行时置 `material.wireframe = true`。
    pub wireframe: bool,
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
            wireframe: false,
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

/// 缺失纹理回退表的**键**：`materials/<路径小写>`（反斜杠归一为 `/`）。
///
/// 默认纹理包（`textures.mtz` → `textures.json`）的键就是**源资源路径**
/// （如 `materials/metal/metalfence007a`），因此查表必须用**贴图路径**——
/// 用材质名查会系统性漏掉「材质名 ≠ `$basetexture`」的那一类（实测 surf_666 的
/// 149 个 pakfile VMT 里有 74 个属于此列，含全部铁丝网/格栅：`666/metalfence007a`
/// 的 `$basetexture` 是 `metal/metalfence007a`，按材质名查包永远查不到）。
pub fn fallback_key(path: &str) -> String {
    let p = path.replace('\\', "/");
    let p = p.trim_matches('/');
    let p = p.strip_prefix("materials/").unwrap_or(p);
    format!("materials/{}", p.to_ascii_lowercase())
}

/// 按候选路径**依次**查缺失纹理回退表 → 低清 PNG 字节（`scale` = mosaic 放大倍数）。
///
/// 命中即返回；全部未命中返回 `None`（调用方保持原回退行为）。
pub fn fallback_texture_png(
    fallback: &std::collections::HashMap<String, String>,
    paths: &[&str],
    scale: u32,
) -> Option<Vec<u8>> {
    for p in paths {
        if p.is_empty() {
            continue;
        }
        if let Some(code) = fallback.get(&fallback_key(p)) {
            if let Ok(png) = crate::mosaic::decode::code_to_img(code, scale) {
                return Some(png);
            }
        }
    }
    None
}

/// 取 VMT 的着色器名（文件首个带引号的 token，如 `"Wireframe"` / `"VertexLitGeneric"`）。
///
/// `vmt_parser` 只认它枚举里的着色器；未识别的那些（`Wireframe` 等）仍需要按名字区分处理。
fn parse_shader_name(vdf: &str) -> Option<String> {
    let start = vdf.find('"')? + 1;
    let end = vdf[start..].find('"')? + start;
    let s = vdf[start..end].trim();
    if s.is_empty() || s.starts_with('$') {
        return None;
    }
    Some(s.to_string())
}

/// 从未被 `vmt_parser` 识别的 VMT 文本里取 `$color`（形如 `"$color" "{ 73 73 73 }"`）。
///
/// 用途：`Wireframe` 等调试着色器不在 `vmt_parser` 的材质枚举里 ⇒ 解析失败 ⇒ 回退
/// `MaterialData::default()` 的**纯白** `[255,255,255,255]`，而 `$color` 是作者明确声明的基色。
/// 实测 surf_666 的 `dev_nyro/blends/wire_white`（`"Wireframe"` + `$color { 73 73 73 }`，8 个世界面、
/// 单面 768×512×768）因此被画成纯白实体面 —— Source 侧它是**线框**（本函数只能修色，线框语义见
/// `documents/game/implementation/materials-and-alpha.md` §限制）。
///
/// 只做扁平扫描：取 `"$color"` 之后**第一对花括号**内的 3 个数（0–255）。
fn parse_dollar_color(vdf: &str) -> Option<[u8; 4]> {
    let lower = vdf.to_ascii_lowercase();
    let at = lower.find("\"$color\"")?;
    let rest = &vdf[at + "\"$color\"".len()..];
    let open = rest.find('{')?;
    let close = rest[open..].find('}')? + open;
    let nums: Vec<f32> = rest[open + 1..close]
        .split(|c: char| c.is_whitespace() || c == ',')
        .map(|s| s.trim_matches('"'))
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<f32>().ok())
        .collect();
    if nums.len() < 3 {
        return None;
    }
    let ch = |v: f32| v.clamp(0.0, 255.0).round() as u8;
    Some([ch(nums[0]), ch(nums[1]), ch(nums[2]), 255])
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
            // 缺失纹理回退：默认纹理包（GLB 导出期嵌入低清纹理，渲染端零后期处理）。
            // 键 = 材质名（VMT 都找不到时没有 `$basetexture` 可用）。透明度未知 ⇒
            // 由 `gltf_builder::push_material` 按**贴图自身的 alpha 镂空**补判 MASK。
            if let Some(image) = fallback_texture_png(&options.missing_fallback, &[name], 8)
                .and_then(|png| image::load_from_memory(&png).ok())
            {
                return MaterialData {
                    name: name.to_string(),
                    path: String::new(),
                    color: [255, 255, 255, 255],
                    texture: Some(TextureData {
                        name: name.to_string(),
                        image,
                    }),
                    ..MaterialData::default()
                };
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

/// 从 BSP 文件加载材质（pub(crate) 供 mosaic manifest 复用）。
pub(crate) fn load_material_bsp(
    name: &str,
    _paths: &[String],
    bsp: &Bsp,
    options: &ConvertOptions,
) -> Result<MaterialData, Error> {
    // 生成多种可能的 VMT 文件路径格式
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
    let found = possible_paths
        .iter()
        .find_map(|path| {
            match bsp.pack.get(path) {
                Ok(Some(data)) => Some((path.clone(), data)),
                _ => None,
            }
        });
    // 基名回退：pakfile 内存在**同一基名**的 VMT 时采用它（例：texinfo 名
    // `METAL/METALGRATE013A2` → `materials/666/metalgrate013a2.vmt`）。这类 VMT 是
    // 地图作者对**同一张贴图**的重写（实测 14 种命中里 13 种的 `$basetexture` 与材质名
    // 逐字符相同），因此它是「精确 VMT 不在包内」时唯一的权威透明度/贴图来源。
    let (vmt_path, vmt_data) = match found {
        Some(v) => v,
        None => {
            let stem = name
                .replace('\\', "/")
                .rsplit('/')
                .next()
                .unwrap_or(name)
                .to_ascii_lowercase();
            let stem_hit = options.vmt_stem_index.get(&stem).cloned();
            match stem_hit {
                Some(hit) => match bsp.pack.get(&format!("materials/{}.vmt", hit)) {
                    Ok(Some(data)) => (format!("materials/{}.vmt", hit), data),
                    _ => {
                        let paths_str = possible_paths.join(", ");
                        return Err(Error::Other(format!(
                            "Can't find VMT file in BSP. Tried: {} (+stem {})",
                            paths_str, hit
                        )));
                    }
                },
                None => {
                    let paths_str = possible_paths.join(", ");
                    return Err(Error::Other(format!(
                        "Can't find VMT file in BSP. Tried: {}",
                        paths_str
                    )));
                }
            }
        }
    };
    
    let vdf = String::from_utf8(vmt_data.to_vec())?;
    
    let material = match vmt_parser::from_str(&vdf) {
        Ok(material) => material,
        Err(e) => {
            // 处理不支持的材质类型
            println!("Unsupported material type: {:?}", e);
            return Ok(MaterialData {
                name: name.to_string(),
                path: vmt_path,
                color: parse_dollar_color(&vdf).unwrap_or([255, 255, 255, 255]),
                wireframe: parse_shader_name(&vdf)
                    .map(|s| s.eq_ignore_ascii_case("wireframe"))
                    .unwrap_or(false),
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
            // 如果没有基础纹理，返回默认材质数据（`$color` 是作者声明的基色，别丢成纯白）
            return Ok(MaterialData {
                name: name.to_string(),
                path: vmt_path,
                color: parse_dollar_color(&vdf).unwrap_or([255, 255, 255, 255]),
                ..MaterialData::default()
            });
        }
    };

    let translucent = material.translucent();
    let glass = material.surface_prop() == Some("glass");
    // `$alphatest 1` 而未给 `$alphatestreference` 时，vmt_parser 返还的 `alpha_test_reference`
    // 是它的默认值 **1.0** —— 但 glTF 的 `alphaCutoff` 是 [0,1] 的**阈值语义**（规范默认 0.5），
    // Source 的 `$alphatestreference` 默认同样是 0.5。直接透传 1.0 会把 `alpha = 254` 的像素
    // 一并裁掉（≈整体透明）。⇒ 越界值一律归一到 0.5。
    let alpha_test = material
        .alpha_test()
        .map(|reference| if reference >= 1.0 || reference <= 0.0 { 0.5 } else { reference });
    
    // 尝试加载纹理，如果失败则使用默认材质数据
    let texture_data = match load_texture_bsp(base_texture, bsp, options) {
        Ok(texture) => Some(TextureData {
            name: base_texture.to_string(),
            image: texture,
        }),
        Err(e) => {
            // ① 优先查默认纹理包（键 = `$basetexture` 路径，其次材质名）：
            //    stock 贴图（HL2 自带）不在 pakfile 内，但默认纹理包里有低清版
            //    （含 alpha 镂空）——铁丝网/格栅的孔洞信息就在这里。
            // ② 必须在**这里**回退而不是在 `Err` 分支：`Err` 分支按材质名查包并返回
            //    `MaterialData::default()`，会把本 VMT 已解析到的
            //    `$translucent`/`$alphatest` 一并丢掉（实机表现：镂空画成近黑实心块）。
            match fallback_texture_png(&options.missing_fallback, &[base_texture, name], 8)
                .and_then(|png| image::load_from_memory(&png).ok())
            {
                Some(image) => Some(TextureData {
                    name: base_texture.to_string(),
                    image,
                }),
                None => {
                    println!("Failed to load texture: {:?}, using default material", e);
                    None
                }
            }
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
        wireframe: false,
    })
}

/// 从 BSP 文件中加载纹理
fn load_texture_bsp(
    name: &str,
    bsp: &Bsp,
    options: &ConvertOptions,
) -> Result<DynamicImage, Error> {
    let name = name.trim_end_matches(".vtf").trim_start_matches('/');

    // 生成多种可能的 VTF 文件路径格式
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
