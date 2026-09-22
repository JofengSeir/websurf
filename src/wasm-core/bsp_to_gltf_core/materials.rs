//! VMT/VTF 材质解析层：材质名 → `MaterialData`（颜色、贴图、透明度、UV 变换、线框标记）。
//!
//! 在主流程中的位置：
//! - 上游：`gltf_builder::push_or_get_material_bsp` 对每个世界面材质调
//!   [`load_material_fallback_bsp`]；`mosaic/manifest.rs` 直接调 [`load_material_bsp`]
//!   逐个材质取图（`src/wasm-core/mosaic/manifest.rs` 的 `texture_to_code`）。
//! - 下游：`gltf_builder::push_material` 把 `MaterialData` 翻成 glTF `Material`；
//!   缺失贴图回退的字节码由 `mosaic::decode::code_to_img` 解码成 PNG。
//!
//! 职责：
//! - [`load_material_bsp`]：pakfile 内找 VMT → `vmt_parser` 解析 → 跟一层 include → 找 VTF → 解码
//! - [`load_material_fallback_bsp`] / [`load_material_fallback`]：失败时的容错包装
//!   （记 `MissingResource`，回退贴图或纯白默认材质）
//! - [`fallback_key`] / [`fallback_texture_png`]：缺失纹理回退表的键口径与查表解码
//! - `parse_shader_name` / `parse_dollar_color`：`vmt_parser` 不认的 VMT 文本的兜底取值
//!
//! 关键不变量：
//! - VMT 与 VTF 各按 **4** 条候选路径依次查 pakfile：原名、全小写、全大写、`/` 换成 `_`
//!   （前缀 `materials/`，后缀 `.vmt` / `.vtf`）。`resolve` 跟 include 时只用 **2** 条：
//!   原文与全小写。
//! - pakfile 查找大小写敏感（`bsp.pack.get` 走 `zip.by_name`，按名精确匹配），
//!   这正是候选里带全大写变体的原因。
//! - 基名回退（`options.vmt_stem_index`）只在 4 条精确候选全部落空后启用；
//!   它是精确 VMT 不在包内时获取 `$basetexture` 与透明度声明的替代通路。
//! - 缺失贴图回退表的键统一经 [`fallback_key`] 归一为 `materials/<路径小写>`；
//!   两处查表都用 `scale = 8`（mosaic 放大倍数）。
//! - `alpha_test` 的越界值（≥ 1.0 或 ≤ 0.0）归一到 **0.5**；`None` 表示 VMT 未声明。
//! - `translucent` 与 `surfprop` 为 `glass` 二者按位或合并；`transform` 等于
//!   `TextureTransform::default()` 时归 `None`。
//! - 成功路径把 `color` 固定为纯白 `[255; 4]`；只有「着色器不被识别」与「没有 `$basetexture`」
//!   两条早退路径才用 `parse_dollar_color` 取作者声明的基色。
//!
//! 边界：只读 pakfile 内字节，不写盘、不联网、不接触 DOM。
//! `load_material`（非 BSP 通路）是占位实现，恒返回 `Err(Error::Other(..))`。
//!
//! 测试归属：本文件无 `#[cfg(test)]` 与 `#[test]`（同模块的三个兄弟文件同此，
//! `bsp_to_gltf_core` 的 6 个 `#[test]` 全在 `lightmap.rs`）。

use crate::bsp_to_gltf_core::{ConvertOptions, Error, MissingResource, ResourceSource, ResourceType};
use image::imageops::FilterType;
use image::DynamicImage;
use tf_asset_loader::Loader;
use crate::vbsp::Bsp;

/// 单个材质的解析结果。
///
/// 由 `load_material_bsp` 的三条返回路径产出：解析成功、`vmt_parser` 不认该着色器、
/// 以及 VMT 没有 `$basetexture`。前一条填满全部字段，后两条只填
/// `name` / `path` / `color` / `wireframe`，其余取 `Default`。
pub struct MaterialData {
    /// 材质名（世界面取自 texinfo 的材质名，经 `push_or_get_material_bsp` 转小写）。
    /// 也是 glTF `Material::name`。
    pub name: String,
    /// 命中的 VMT 在 pakfile 内的路径（`materials/….vmt`）；回退路径填空串。
    ///
    /// 字段带 `#[allow(dead_code)]`，且 crate 内没有读取点
    /// ⇒ 当前不参与 glTF 输出。
    #[allow(dead_code)]
    pub path: String,
    /// RGBA 基色，每通道 0–255（`push_material` 逐通道除以 255 得 glTF `base_color_factor`）。
    /// `Default` 为 `[255, 255, 255, 255]`。
    pub color: [u8; 4],
    /// 解码后的贴图；`None` 表示该材质没有可用贴图
    /// （VTF 不在 pakfile 内，且回退表也没命中）。
    pub texture: Option<TextureData>,
    /// alpha 测试参考值（[0,1] 的阈值语义）；`None` 表示 VMT 未声明。
    /// `gltf_builder::push_material` 用它填 glTF `alphaCutoff`。
    pub alpha_test: Option<f32>,
    /// 半透明：`vmt_parser` 的 `translucent()` 为真，或 `surfprop` 为 `glass`。
    /// glTF 侧映射到 `AlphaMode::Blend`。
    pub translucent: bool,
    /// 不做背面剔除（`vmt_parser` 的 `no_cull()`）→ glTF `double_sided`。
    pub no_cull: bool,
    /// `$basetexture` 的 UV 变换；等于 `TextureTransform::default()` 时归 `None`。
    /// `push_material` 把其中的 `rotate` 由度转弧度。
    pub transform: Option<vmt_parser::TextureTransform>,
    /// 着色器名为 `Wireframe`（大小写不敏感）时为真 → glTF `extras.vbsp_wireframe`。
    ///
    /// 只在 `vmt_parser::from_str` 失败的分支里赋值：这类 VMT 走不到 `vmt_parser`
    /// 的材质枚举，需要按原始文本的着色器名区分处理，否则会被当成普通不透明材质。
    /// 渲染端据 `extras.vbsp_wireframe` 置 `material.wireframe`
    /// （`apps/game/src/renderer/lightmap-shader.ts` 的 `copyMaterialRenderState`）。
    pub wireframe: bool,
}

impl Default for MaterialData {
    /// 全默认：纯白不透明、无贴图、不透明、不剔背面、无 UV 变换、非线框。
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

/// 一张已解码的贴图：名字 + 像素。
pub struct TextureData {
    /// 贴图名（取自被加载的 `$basetexture` 路径或材质名）。
    /// glTF 侧同时用作 `Texture::name`、`Image::name` 与**去重键**
    /// （`gltf_builder::get_texture_index` 按名比对）。
    pub name: String,
    /// 解码并按 `ConvertOptions::texture_scale` 缩放后的图像。
    pub image: DynamicImage,
}



/// 材质名收集器：导出期把尝试加载过的材质名登记下来，
/// 最终成为 `ExportResult::textures`。
pub struct TextureCollector {
    /// 已登记的小写材质名，去重且保持首次出现顺序。
    pub textures: Vec<String>,
}

impl TextureCollector {
    /// 建一个空收集器（本类型没有 `Default` 实现）。
    pub fn new() -> Self {
        TextureCollector {
            textures: Vec::new(),
        }
    }

    /// 登记一个材质名：已存在则不动，否则追加到末尾（线性查重）。
    ///
    /// 调用点在加载**之前**（两条 `load_material_fallback*` 的第一条语句），
    /// 因此这里也会记录加载失败的材质名。
    pub fn add_texture(&mut self, texture: String) {
        if !self.textures.contains(&texture) {
            self.textures.push(texture);
        }
    }
}

/// 缺失纹理回退表的**键**归一化：`materials/<路径小写>`（反斜杠归一为 `/`）。
///
/// 变换顺序：`\` → `/` → 去首尾 `/` → 去 `materials/` 前缀（**大小写敏感**，
/// 前缀不是全小写时不剥）→ 拼 `materials/` 加全小写路径。
/// 因此 `materials/foo` 与 `foo` 都得到 `materials/foo`（幂等），
/// 而 `MATERIALS/foo` 会得到 `materials/materials/foo`。
///
/// 调用点一律把**贴图路径**（`$basetexture`）排在候选列表前面、材质名排在后面
/// （见 `load_material_bsp` 与 `apps/game/crates/wasm/src/lib.rs` 的 `resolve_pakfile_materials`），
/// 因为回退表按源资源路径索引，而材质名与 `$basetexture` 可以不同名。
/// 本函数不校验路径是否存在，也不读盘。
pub fn fallback_key(path: &str) -> String {
    let p = path.replace('\\', "/");
    let p = p.trim_matches('/');
    let p = p.strip_prefix("materials/").unwrap_or(p);
    format!("materials/{}", p.to_ascii_lowercase())
}

/// 按候选路径**依次**查缺失纹理回退表 → 低清 PNG 字节（`scale` = mosaic 放大倍数）。
///
/// 空串候选直接跳过。命中且解码成功就返回该 PNG 字节；命中但
/// `mosaic::decode::code_to_img` 报错时继续试下一个候选；
/// 全部未命中或全部解码失败返回 `None`（调用方保持原回退行为）。
/// 返回的是 PNG 字节，不是已解码的图像，也不写盘。
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

/// 取 VMT 的着色器名：文件里**首个双引号对**内的 token
/// （VMT 首行形如 `"Wireframe"` / `"VertexLitGeneric"`）。
///
/// 返回 `None` 的两种情形：括号内为空串，或以 `$` 开头（那是键名而非着色器名）。
/// 不做大小写归一，也不校验 token 是不是已知着色器——调用方用
/// `eq_ignore_ascii_case("wireframe")` 自行比对；`vmt_parser` 只认它枚举里的着色器，
/// 未被识别的那些仍需要按名字区分处理。
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
/// 用途：解析失败时 `MaterialData::default()` 的基色是**纯白** `[255,255,255,255]`，
/// 而 `$color` 是作者明确声明的基色，按它上色比纯白更接近作者的声明。
///
/// 扫描方式（只做扁平扫描）：在**小写副本**里定位第一处 `"$color"`，再按同一字节偏移
/// 切原文（ASCII 小写化不改变字节长度），取其后**第一对花括号**内空白或逗号分隔的
/// 数值，只收能解析成 `f32` 的那些。少于 3 个数返回 `None`；每个通道 clamp 到
/// 0–255 后四舍五入，alpha 恒为 255。
/// 不处理嵌套块，也不解析 `$color` 以外的基色写法。
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

/// 加载材质（非 BSP 通路的容错包装）。
///
/// 返回：加载成功返回解析结果；失败返回纯白默认材质（`path` 为空串），
/// 并在 `options.generate_missing_list` 为真时往 `missing_resources` 追加一条
/// `ResourceType::Material` + `ResourceSource::GameDirectory` 记录。
///
/// 副作用：无条件把 `name` 登记进 `texture_collector`（登记发生在加载之前）。
///
/// 边界：**不使用** `options.missing_fallback` 的贴图回退，该表只在 BSP 通路上生效；
/// 且底层 `load_material` 是占位实现恒返回 `Err`，所以当前实现下本函数恒走失败分支。
/// 本仓内没有调用点（`#[allow(dead_code)]` 生效范围内）。
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

/// 从 BSP 文件加载材质（带失败回退），是 `gltf_builder::push_or_get_material_bsp` 的加载入口。
///
/// 返回：成功返回解析结果；失败返回 `MaterialData`，先按**材质名**查
/// `options.missing_fallback`（`scale = 8`，解码成图像后作为该材质的贴图，
/// 颜色仍是纯白，透明度由 `push_material` 按贴图自身的 alpha 镂空补判）；
/// 回退表也没命中时返回纯白默认材质（`path` 为空串）。
/// 失败时同样在 `options.generate_missing_list` 为真时追加一条
/// `ResourceType::Material` + `ResourceSource::BspFile` 记录。
///
/// 副作用：无条件把 `name` 登记进 `texture_collector`（登记发生在加载之前）。
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
            // 缺失纹理回退：按材质名查表（VMT 都找不到时没有 `$basetexture` 可用），
            // 解出的低清纹理随 GLB 一起下发。透明度未知，链路上的 `push_material`
            // 会按贴图自身的 alpha 镂空补判 MASK。
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

/// 非 BSP 通路的加载实现：占位版本，恒返回
/// `Err(Error::Other("Material loading not implemented in core version"))`。
///
/// 四个形参都带 `_` 前缀，函数体不读任何一个；实际可用的通路是 [`load_material_bsp`]。
fn load_material(
    _name: &str,
    _paths: &[String],
    _loader: &Loader,
    _options: &ConvertOptions,
) -> Result<MaterialData, Error> {
    // 简化实现，只返回默认材质
    Err(Error::Other("Material loading not implemented in core version".to_string()))
}

/// 在 BSP 的 pakfile 内解析材质（`pub(crate)`，供 `gltf_builder` 与 `mosaic/manifest` 复用）。
///
/// 返回语义：
/// - 成功：填满 `MaterialData` 的全部字段（`color` 固定纯白，`wireframe` 恒 `false`）。
/// - `vmt_parser::from_str` 不认该着色器时**不报错**：打一行 `println!`，返回只带
///   `path` / `color`（来自 `parse_dollar_color`）/ `wireframe` 的材质。
/// - VMT 没有 `$basetexture` 时也不报错：返回同上但不设 `wireframe` 的材质。
/// - 找不到 VMT（含基名回退也没命中）、跟 include 时找不到被引文件、字节不是合法 UTF-8：
///   返回 `Err`（`Error::Other` 文本会列出试过的全部路径，UTF-8 失败走 `Error::Utf8Error`）。
///
/// 参数：`name` 是材质名，先去掉结尾的 `.vmt`；`_paths` **不使用**（查找路径全由本函数自造）；
/// `options` 只用于 `vmt_stem_index` 的基名回退。
///
/// 副作用：两处失败诊断打 `println!`；VTF 缺失时还会去查回退表。
pub(crate) fn load_material_bsp(
    name: &str,
    _paths: &[String],
    bsp: &Bsp,
    options: &ConvertOptions,
) -> Result<MaterialData, Error> {
    // 生成若干候选的 VMT 文件路径格式
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

    // 逐个尝试上面的候选路径
    let found = possible_paths
        .iter()
        .find_map(|path| {
            match bsp.pack.get(path) {
                Ok(Some(data)) => Some((path.clone(), data)),
                _ => None,
            }
        });
    // 基名回退：4 条精确路径全落空时，改用 pakfile 内**同一基名**的 VMT
    // （形如 texinfo 名 `METAL/METALGRATE013A2` → `materials/666/metalgrate013a2.vmt`）。
    // 这种 VMT 是地图作者对同一张贴图的重写，因此它是「精确 VMT 不在包内」时
    // 获取该贴图 `$basetexture` 与透明度声明的替代通路。
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
        // 生成若干候选的路径格式
        let path = path.trim_start_matches('/');
        let possible_paths = vec![
            format!("materials/{}", path),
            format!("materials/{}", path.to_lowercase())
        ];

        // 逐个尝试上面的候选路径
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
            // 没有基础纹理时也保留作者声明的 `$color`，不丢成纯白
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
    // `$alphatest` 给了数但没给参考值 / 参考值越界时，`vmt_parser` 返还的
    // `alpha_test_reference` 落在 [0,1] 之外。glTF 的 `alphaCutoff` 是 [0,1] 的
    // **阈值语义**（`gltf_builder::push_material` 在无数值时用 0.5），
    // 直接透传越界值会把 `alpha = 254` 这类像素一并裁掉。
    // ⇒ 越界值（≥ 1.0 或 ≤ 0.0）一律归一到 0.5。
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
            // ① pakfile 内没有这张 VTF（stock 贴图未打包）时查回退表，键依次是
            //    `$basetexture` 路径、材质名——铁丝网/格栅的镂空信息就在包里那张低清图上。
            // ② 必须在**这里**回退，而不是在外层 `Err` 分支：外层按材质名查表并返回
            //    `MaterialData::default()`，会把本 VMT 已解析到的
            //    `translucent` / `alpha_test` 一并丢掉（实机表现：镂空画成近黑实心块）。
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

/// 在 BSP 的 pakfile 内加载并解码一张 VTF，是 `load_material_bsp` 的贴图步骤。
///
/// 返回：解码后的图像；`options.texture_scale` 不为 `1.0` 时按该倍数重采样
/// （`FilterType::CatmullRom`，宽高各自乘倍数后截断为 `u32`），恰为 `1.0` 时返回原图。
///
/// 失败情形：4 条候选路径（原名、全小写、全大写、`/` 换成 `_`，前缀 `materials/`、
/// 后缀 `.vtf`）全不命中 → `Error::Other` 文本列出全部试过的路径；
/// VTF 头解析失败或 mip 0 解码失败 → `Error::VtfError`。
/// 只解 mip 0，不做 VTF 内嵌低清图回退（那是调用方查回退表的事）。
fn load_texture_bsp(
    name: &str,
    bsp: &Bsp,
    options: &ConvertOptions,
) -> Result<DynamicImage, Error> {
    let name = name.trim_end_matches(".vtf").trim_start_matches('/');

    // 生成若干候选的 VTF 文件路径格式
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

    // 逐个尝试上面的候选路径
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
