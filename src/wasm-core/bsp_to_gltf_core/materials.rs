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
//!   （精确键优先，全落空再按**唯一基名**兜一层）
//! - `parse_shader_name` / `parse_dollar_color`：`vmt_parser` 不认的 VMT 文本的兜底取值
//!
//! 关键不变量：
//! - VMT 与 VTF 各按 **4** 条候选路径依次查 pakfile：原名、全小写、全大写、`/` 换成 `_`
//!   （前缀 `materials/`，后缀 `.vmt` / `.vtf`）。`resolve` 跟 include 时**先剥掉 include 自带的
//!   `materials/` 前缀**（VBSP 生成的 patch 就这么写），再按原文与全小写两条候选查 pakfile。
//! - pakfile 查找**先精确、再按 ASCII 小写不敏感**（`vbsp::data::Packfile::ci_name`）；
//!   下面 4 条候选里的大小写变体是修复前为绕开精确匹配而加的，现已冗余，保留只为不改查找顺序。
//! - 基名回退（`options.vmt_stem_index`）只在 4 条精确候选全部落空后启用；
//!   它是精确 VMT 不在包内时获取 `$basetexture` 与透明度声明的替代通路。
//! - 缺失贴图回退表的键统一经 [`fallback_key`] 归一为 `materials/<路径小写>`；
//!   两处查表都用 `scale = 8`（mosaic 放大倍数）。
//! - `alpha_test` 的越界值（≥ 1.0 或 ≤ 0.0）归一到 **0.5**；`None` 表示 VMT 未声明。
//! - `translucent` 与 `surfprop` 为 `glass` 二者按位或合并；`transform` 等于
//!   `TextureTransform::default()` 时归 `None`。
//! - 成功路径把 `color` 固定为纯白 `[255; 4]`；只有「着色器不被识别」与「没有 `$basetexture`」
//!   两条早退路径才用 `parse_dollar_color` 取基色（`Water` 例外：走上游口径的半透明水色）。
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

/// 半透明材质在**没有任何 alpha 来源**时的占位 alpha（0..255，51 ≈ 0.2）。
///
/// 只在同时满足下面三条时才用：声明了半透明、VMT 没写 `$alpha`、贴图也拿不到。
/// 这条是兜底而不是口径——BLEND 配上 alpha=1 会把烟/雾画成一堵白墙，
/// 而这一路连贴图 alpha 通道都指望不上。真正生效的数值一律来自 VMT 的 `$alpha`。
pub(crate) const TRANSLUCENT_PLACEHOLDER_ALPHA: u8 = 51;

/// 水面在**没有任何地图参数**时的上游口径半透明水色（RGBA，128 ≈ 0.5）。
///
/// **泛白**（owner 2026-10-19 裁决）：Source 的水面观感来自 `$fogcolor` —— 实测 `surf_boreas`
/// 的 `materials/project_tendies/water01.vmt` 写的是 `"$fogcolor" "{255 255 255}"`（纯白）
/// 加 `"srgb?$fogcolor" "{120 200 255}"`，`$reflecttint "[1 .95 .85]"` —— 即作者要的就是
/// "白到发亮的水"。而 VMT 不在 pakfile 里时（`surf_666` 的 `dev/dev_water2` 只有 VBSP 生成的
/// `…_depth_<n>.vmt` patch）读不到这些值 ⇒ 兜底必须是同一路的**泛白**，不能是早期随手挑的
/// 蓝 `[82,180,217]`（那会把没打包水材质的图渲染成一片青绿）。
pub(crate) const WATER_COLOR: [u8; 4] = [222, 233, 237, 128];

/// 缺 VMT 时水面**没有** `$envmaptint` 的反射强度（渲染端 `reflectivity = tint × 0.8` ⇒ 0.4）。
///
/// 为什么不是其他 envmap 材质的缺省 `[1,1,1]`（⇒ 0.8）：Source 的水面反射由
/// `$reflectamount` 压着（`dev_water2` = 1.0、`water_canals03` = 0.5），而本仓 fallback
/// 材质库里唯一显式声明过 tint 的水面 `watersource/river/river_clear.vmt` 写的是
/// `$envmaptint "[.5 .5 .5]"` ⇒ 取它当水面缺省，避免水面在掠射角糊成一张白板。
pub(crate) const WATER_DEFAULT_ENVMAP_TINT: [f32; 3] = [0.5, 0.5, 0.5];

/// Source `Water` 材质里本工程用得到的参数（口径见 SDK
/// `src/materialsystem/stdshaders/water.cpp` 的 `SHADER_PARAM` 与
/// `water_ps2x_helper.h` 的 `DrawWater`）。
///
/// 关键语义（别按名字猜）：
/// - `$refractamount` / `$reflectamount` 是**扰动幅度**，不是混合系数 —— `DrawWater` 拿它们
///   缩放 DU/DV 法线对折射 / 反射 UV 的偏移（`vDependentTexCoords = vN * vNormal.a *
///   reflectRefractScale`），`x,y` = reflect、`z,w` = refract。
/// - 最终颜色是 `lerp(refract, reflect, fFresnel)`，`fFresnel = pow(1 - saturate(N·V), 5)`，
///   且**没有 basetexture 时**再乘 `saturate((depth - 0.05) * 20)` —— 水浅（底近）→ 纯折射
///   （看得见底），水深 → 纯反射。`depth` 取自折射缓冲的 alpha（屏幕空间深度）。
/// - `$fogcolor` 是**深水色**：`vRefractColor = lerp(refract, fogColor, saturate(depth - 0.05))`。
/// - `$reflecttint` 在 `water.cpp` 里被 `GammaToLinear(tint) * 4.0` 放大（overbright 4 倍）。
///
/// 注意：**不是 `Copy`**（含 `$bumpmap`/`$normalmap` 的 `String`），取值处用引用或 `clone()`。
#[derive(Debug, Clone)]
pub struct WaterParams {
    /// `$fogcolor`（gamma 色，0..1）。
    pub fog_color: [f32; 3],
    /// `$refracttint`（缺省 `[1 1 1]`）。
    pub refract_tint: [f32; 3],
    /// `$reflecttint`（缺省 `[1 1 1]`）。
    pub reflect_tint: [f32; 3],
    /// `$refractamount`（缺省 `0`）。
    pub refract_amount: f32,
    /// `$reflectamount`（缺省 `0.8`）。
    pub reflect_amount: f32,
    /// `$abovewater`（缺省 `1`；`_beneath` 系列是 `0`）。
    pub above_water: bool,
    /// `$fogstart` / `$fogend`（水下雾距离，仅 `$abovewater 0` 时 Source 才用）。
    pub fog_start: f32,
    pub fog_end: f32,
    /// `$scroll1` / `$scroll2` 的前两维：DU/DV 两层涟漪的 UV 滚动速率（UV/秒）。
    ///
    /// 来源是 VMT 里的显式声明（`surf_boreas` 的 `water01.vmt`：`$scroll1 "[.01 .01 .05]"`、
    /// `$scroll2 "[-.025 .025 .075]"`，第三维是帧动画速率，本工程不用）。
    pub scroll1: [f32; 2],
    pub scroll2: [f32; 2],
    /// `$scale`：水面的贴图缩放（`surf_boreas` 的 `water01.vmt` / `dev_water2.vmt` 都写 `[1 1]`）。
    /// Source 用它缩放水面 UV（DU/DV 的平铺密度），渲染端乘在平铺密度上。
    pub scale: [f32; 2],
    /// `$waterdepth`：该水面 patch 的水深（世界单位）。VBSP 给每块水生成
    /// `maps/<map>/<mat>_<x>_<y>_<z>_depth_<n>.vmt`，`n` 就是这个值（`surf_666` 的
    /// `dev_water2_depth_192`、`surf_boreas` 的 `water01_..._depth_453`）。
    ///
    /// 渲染端拿它当源里 `_rt_WaterRefraction.a`（归一化水层深度）的替代：
    /// 有它就能做 `saturate((depth-0.05)*20)` 的浅水/深水门控与 `$fogcolor` 混合，
    /// 不必去反投影深度缓冲（实测 `DepthTexture` 在本机 RT 里读出来是远平面）。
    pub water_depth: Option<f32>,
    /// `$bumpmap`：失真图路径（`dev/water_dudv`）。渲染端据此**选用哪张失真图**，
    /// 不再写死；声明了本工程没内嵌的图时会告警并回退。
    pub bumpmap: Option<String>,
    /// `$normalmap`：水面法线图路径（`dev/water_normal`）。仅记录（本工程暂不用它做光照）。
    pub normalmap: Option<String>,
    /// `$bumptransform` 里的 `scale`（两维）与 `rotate`（角度，度）：作用在主采样 UV 上。
    /// 形如 `center .5 .5 scale 1 1 rotate 0`；`surf_boreas` 的写法是 `texturescrollrate`（解析不出 ⇒ 用缺省）。
    pub bump_scale: [f32; 2],
    pub bump_rotate: f32,
}

impl Default for WaterParams {
    /// 缺省 = `water.cpp` 的 `SHADER_PARAM` 缺省值 + 上游口径的**泛白**水色。
    ///
    /// `$fogcolor` 是唯一必须由材质声明的键（Source 缺它时打警告并塞 `(1,0,0)` 红色占位），
    /// 这里用 [`WATER_COLOR`] 归一化后的**泛白**（见该常量的说明）。`$refractamount` 缺省 `0`
    /// 会让折射完全不扰动，而本工程没有真实折射缓冲、涟漪是程序化的，故缺省取
    /// [`WATER_DEFAULT_REFRACT_AMOUNT`]。`$scroll1/$scroll2` 用 Valve 水材质里最常见的取值。
    fn default() -> Self {
        Self {
            fog_color: [
                WATER_COLOR[0] as f32 / 255.0,
                WATER_COLOR[1] as f32 / 255.0,
                WATER_COLOR[2] as f32 / 255.0,
            ],
            refract_tint: [1.0, 1.0, 1.0],
            reflect_tint: [1.0, 1.0, 1.0],
            refract_amount: WATER_DEFAULT_REFRACT_AMOUNT,
            reflect_amount: 0.8,
            above_water: true,
            fog_start: 0.0,
            fog_end: 0.0,
            scroll1: [0.01, 0.01],
            scroll2: [-0.025, 0.025],
            scale: [1.0, 1.0],
            water_depth: None,
            bumpmap: None,
            normalmap: None,
            bump_scale: [1.0, 1.0],
            bump_rotate: 0.0,
        }
    }
}

/// 缺 VMT 的水面用的折射扰动幅度（Source 的 `$refractamount` 缺省是 0 = 不扰动）。
pub(crate) const WATER_DEFAULT_REFRACT_AMOUNT: f32 = 0.6;

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
    /// `$envmap` 的反射色（`$envmaptint`，缺省 `[1,1,1]`）；`None` 表示 VMT 没写 `$envmap`。
    /// `push_material` 把它写进 glTF `extras.vbsp_envmap`（**与模型通路同键名**），
    /// 渲染端据此给材质挂环境反射 —— 这是冰/玻璃「晶莹」感的来源，alpha 只负责能看见后面。
    pub envmap_tint: Option<[f32; 3]>,
    /// Source `Water` 材质的参数（`$fogcolor` / 两个 tint / 两个 amount / `$abovewater` …）；
    /// `None` = 不是水面。`push_material` 把它写进 extras `vbsp_water`，渲染端据此建
    /// 折射 + 菲涅尔反射的水面材质（口径见 [`WaterParams`]）。
    pub water: Option<WaterParams>,
    /// 着色器名为 `Wireframe`（大小写不敏感）时为真 → glTF `extras.vbsp_wireframe`。
    ///
    /// 只在 `vmt_parser::from_str` 失败的分支里赋值：这类 VMT 走不到 `vmt_parser`
    /// 的材质枚举，需要按原始文本的着色器名区分处理，否则会被当成普通不透明材质。
    /// 渲染端据 `extras.vbsp_wireframe` 置 `material.wireframe`
    /// （`src/renderer-shared/shader/lightmap-shader.ts` 的 `copyMaterialRenderState`）。
    pub wireframe: bool, pub texture_absent: bool, pub basetexture2: Option<TextureData>, // texture_absent：声明了 $basetexture 但 VTF 取不到 ⇒ 缺失观测计入（「本无 basetexture」不计）；basetexture2：WorldVertexTransition 的第二贴图（无则 None）
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
            wireframe: false, texture_absent: false, basetexture2: None, envmap_tint: None, water: None,
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
    /// 导出期逐张产出的 mosaic 字节码：`(纹理名小写, 码)`。只对**加载成功且带图**的材质登记
    /// （见 `gltf_builder::push_or_get_material_bsp`），最终成为 `ExportResult::mosaic`。
    ///
    /// 不去重：同一张贴图被多个材质引用时会各登记一次，`collect` 进 HashMap 时后者覆盖前者、
    /// 值相同，与 `mosaic/manifest.rs` 的 `build_mosaic_manifest` 行为一致。
    pub mosaic: Vec<(String, String)>,
    /// `mosaic` 的**已见贴图名**（小写）：mosaic 只与贴图有关，而本收集器是按**材质**逐条走的，
    /// 同一张贴图会被多个材质引用。少了这层去重就是「按材质算一遍」，实测 `surf_kraken` 反而比
    /// 原来按贴图算更慢（材质数远多于贴图数）。
    pub mosaic_seen: std::collections::HashSet<String>,
}

impl TextureCollector {
    /// 建一个空收集器（本类型没有 `Default` 实现）。
    pub fn new() -> Self {
        TextureCollector {
            textures: Vec::new(),
            mosaic: Vec::new(),
            mosaic_seen: std::collections::HashSet::new(),
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
/// （见 `load_material_bsp` 与 `src/wasm-core/render_bundle.rs` 的 `resolve_pakfile_materials`），
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
/// 全部未命中时再按**基名**兜一层，仍无返回 `None`（调用方保持原回退行为）。
/// 返回的是 PNG 字节，不是已解码的图像，也不写盘。
///
/// **基名兜底层**：材质名与表里的键常常不同名 —— 模型材质名是裸基名（`metalfence007a`），
/// 世界面 texinfo 给的是短路径（`METAL/METALGRATE013A2`），而表按源资源路径索引
/// （`materials/metal/metalgrate013a2`）。MDL 的 `$cdmaterials` 只管得住一部分，精确键全落空
/// 时就把候选的**基名**拿去表里找**唯一**同名键。做成运行时索引而不是往表里灌别名：实测灌
/// 9259 条基名别名会让纹理包从 6.59 MB 涨到 12.18 MB（+85%），这里则是零体积代价。
/// 基名在表内**不唯一就不兜**——宁可退回原行为，也不赌一张错的贴图。
///
/// 成本：只在精确键全落空时才扫一遍表（约 1 万键），而本函数每张材质至多调两次，
/// 不会进入逐面热路径。
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
    if fallback.is_empty() {
        return None;
    }
    // 基名索引：值 `Some(code)` = 该基名唯一；`None` = 有多个同基名的键（歧义，不兜）
    let mut stems: std::collections::HashMap<&str, Option<&String>> =
        std::collections::HashMap::with_capacity(fallback.len());
    for (k, code) in fallback {
        let stem = k.rsplit('/').next().unwrap_or(k.as_str());
        if let Some(slot) = stems.get_mut(stem) {
            *slot = None;
        } else {
            stems.insert(stem, Some(code));
        }
    }
    for p in paths {
        if p.is_empty() {
            continue;
        }
        let key = fallback_key(p);
        let stem = key.rsplit('/').next().unwrap_or(key.as_str());
        if let Some(Some(code)) = stems.get(stem) {
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

/// 取 VMT 文本里某个 `$key` 之后**第一对引号内的值**（返回原文切片，大小写保留）。
///
/// 理由：`vmt_parser 0.2.1` 的 `material/mod.rs` **没有 envmap 相关 API**（grep 零命中），
/// 而 `$envmap` 是冰/玻璃/水视觉上唯一的高光来源 ⇒ 只能自己扫文本，与
/// [`parse_dollar_color`] 同一套手法：在**小写副本**里定位键，再按同一字节偏移切原文
/// （`to_ascii_lowercase()` 不改变字节长度 ⇒ 下标仍然对齐）。
///
/// 值不是「引号开头」时返回 `None`（例如键后面直接换行、或值没加引号）：宁可漏判成
/// 无反射，也不要把下一个键的键名当成值。
fn parse_dollar_value<'a>(vdf: &'a str, lower: &str, key: &str) -> Option<&'a str> {
    let at = lower.find(key)?;
    let rest = &vdf[at + key.len()..];
    let t = rest.trim_start();
    if !t.starts_with('"') {
        return None;
    }
    let s = &t[1..];
    let close = s.find('"')?;
    let out = s[..close].trim();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 解析 `"[r g b]"` / `"{r g b}"` / 单值 —— 取能解析成 `f32` 的前三个数；
/// 只有单值时按 Source 的写法三通道同值。一个都解析不出来返回 `None`。
fn parse_vec3(raw: &str) -> Option<[f32; 3]> {
    let nums: Vec<f32> = raw
        .trim_matches(|c| c == '[' || c == ']' || c == '{' || c == '}')
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<f32>().ok())
        .collect();
    let first = *nums.first()?;
    let at = |i: usize| nums.get(i).copied().unwrap_or(first);
    Some([at(0), at(1), at(2)])
}

/// 取 VMT 的 `$envmap` 意图：写了 `$envmap` 且值不是空 / `"0"` ⇒ 有环境反射，
/// 颜色取自 `$envmaptint`（缺省 `[1,1,1]`）。两者缺任一都不成立。
///
/// **必须与模型通路同口径**：渲染端 `lightmap-shader.ts` 的 `applyReflectionEnvMap` 只读
/// extras 键 `vbsp_envmap`，而模型通路（`pakfile_models.rs:198-206`）早已写这个键 ——
/// 世界面不写 ⇒ 世界面的冰/玻璃**永远静默跳过反射**（T-458 取证里那批「坡体惨白」的
/// 材质全是模型 prop，世界面一次都没进过）。
fn parse_dollar_envmap(vdf: &str, default_tint: [f32; 3]) -> Option<[f32; 3]> {
    let lower = vdf.to_ascii_lowercase();
    let val = parse_dollar_value(vdf, &lower, "\"$envmap\"")?;
    if val == "0" {
        return None;
    }
    let tint = parse_dollar_value(vdf, &lower, "\"$envmaptint\"")
        .and_then(parse_vec3)
        .unwrap_or(default_tint);
    Some(tint)
}

/// 某材质名在 BSP texinfo 上的**标志位并集**（该名字不在任何 texinfo 里时返回 `None`）。
///
/// 为什么需要：texinfo 的 flags 是 **VBSP 编译期按材质写下的语义**，比 VMT 更可靠地知道
/// 「这块面是什么」—— VMT 可以不在 pakfile 里（`Water` 材质就只有 VBSP 生成的
/// `maps/<map>/…_depth_<n>.vmt` patch，母材质在包外），但 flags 一定在。
/// 只读遍历，无分配；调用点只在 VMT 加载失败之后。
fn texinfo_flags_of(bsp: &Bsp, name: &str) -> Option<u32> {
    let mut acc: Option<u32> = None;
    for texinfo in bsp.textures() {
        if texinfo.name().eq_ignore_ascii_case(name) {
            acc = Some(acc.unwrap_or(0) | texinfo.flags.bits());
        }
    }
    acc
}

/// 从材质名尾巴的 `_depth_<n>` 里读水深（VBSP 给水面生成的 depth patch 命名，
/// 例 `dev/dev_water2_depth_192` ⇒ 192；`nature/water_canals03_depth_64` ⇒ 64）。
fn depth_from_name(name: &str) -> Option<f32> {
    let lower = name.to_ascii_lowercase();
    let idx = lower.rfind("_depth_")?;
    let tail = &lower[idx + "_depth_".len()..];
    let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<f32>().ok()
}

/// 取 `$key` 的单个 `f32` 值。
///
/// 先按「引号内的值」取（`parse_dollar_value`）；取不到再接受**未加引号的数值**——
/// Source 的 VMT 允许 `"$abovewater" 0` / `"$fogend" 400.00` 这种写法（实测 666 的
/// `dev/dev_water2.vmt` 就是），而只看引号会把这些参数静默落成缺省值（abovewater=true、
/// fog=0），导致水下/水面参数不对。只收能解析成 `f32` 的 token，字符串值仍走引号分支。
fn parse_dollar_f32(vdf: &str, lower: &str, key: &str) -> Option<f32> {
    if let Some(v) = parse_dollar_value(vdf, lower, key) {
        if let Ok(n) = v.trim().parse::<f32>() {
            return Some(n);
        }
    }
    let at = lower.find(key)?;
    let rest = vdf[at + key.len()..].trim_start();
    let end = rest
        .find(|c: char| c.is_whitespace() || c == ',' || c == '}' || c == '{' || c == '"')
        .unwrap_or(rest.len());
    rest[..end].trim().parse::<f32>().ok()
}

/// 取 `$key` 的三分量颜色：`{22 20 10}`（0–255）与 `[1 1 1]`（0–1）两种写法都吃。
///
/// 判据是**任一分量 > 1** ⇒ 按 0–255 归一（Source 的 `{22 20 10}` 与 `[0.66 0.66 0.66]`
/// 在 VMT 里混着写，见 `dev/dev_water2.vmt` 的 `$fogcolor "{22 20 10}"` 与
/// `nature/water_canals03.vmt`）。
fn parse_dollar_color3(vdf: &str, lower: &str, key: &str) -> Option<[f32; 3]> {
    let v = parse_vec3(parse_dollar_value(vdf, lower, key)?)?;
    if v.iter().any(|c| *c > 1.0) {
        Some([v[0] / 255.0, v[1] / 255.0, v[2] / 255.0])
    } else {
        Some(v)
    }
}

/// 把 VMT 里**嵌套的 `"名字" { … }` 子块**（`Water_DX80` / `Water_DX81` / `Proxies` …）整段剥掉，
/// 只留最外层主体。
///
/// 为什么必须剥：Source 的 DX8/DX9 子块会覆盖同名 `$` 参数，而平扫取的是"首个命中"。
/// 实测 `surf_boreas` 的 `materials/project_tendies/water01.vmt`：
/// `Water_DX80 { "$refractamount" ".13" "$reflectamount" "2.5" }` 出现在主体
/// `"$reflectamount" ".75"` **之前** ⇒ 不剥就会把 DX8 的 2.5 当成 DX9 的反射强度。
fn strip_nested_blocks(vdf: &str) -> String {
    let bytes = vdf.as_bytes();
    let mut out = String::with_capacity(vdf.len());
    let mut i = 0usize;
    let mut depth: i32 = 0;
    let mut last_was_string = false;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c == '"' {
            let start = i;
            i += 1;
            while i < bytes.len() && bytes[i] != b'"' {
                i += 1;
            }
            i = (i + 1).min(bytes.len());
            out.push_str(&vdf[start..i]);
            last_was_string = true;
            continue;
        }
        if c == '{' {
            depth += 1;
            // 最外层主体（`"Water" {`，depth 1）保留；再往里且紧跟在名字后面 ⇒ 整个子块丢掉
            if last_was_string && depth >= 2 {
                let mut d = 1;
                i += 1;
                while i < bytes.len() && d > 0 {
                    match bytes[i] {
                        b'{' => d += 1,
                        b'}' => d -= 1,
                        _ => {}
                    }
                    i += 1;
                }
                depth -= 1;
            } else {
                out.push('{');
                i += 1;
            }
            last_was_string = false;
            continue;
        }
        if c == '}' {
            depth = (depth - 1).max(0);
        }
        out.push(c);
        if !c.is_whitespace() {
            last_was_string = false;
        }
        i += 1;
    }
    out
}

/// 从 VMT 文本解析 [`WaterParams`]（先剥掉 `//` 行注释与嵌套子块：Source 的水材质里被注释掉的
/// `//"$reflecttint"` / `//"$fogcolor"` 很常见，DX8/DX9 子块又覆盖同名参数，两者都会让平扫取错值）。
fn parse_water_params(vdf: &str) -> WaterParams {
    let cleaned: String = strip_nested_blocks(
        &vdf
            .split('\n')
            .map(|line| match line.find("//") {
                Some(i) => &line[..i],
                None => line,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let lower = cleaned.to_ascii_lowercase();
    let d = WaterParams::default();
    WaterParams {
        // `srgb?$fogcolor` 优先：源在 sRGB 模式下走这个分支（`water01.vmt` 里
        // `$fogcolor {255 255 255}` 是 linear 分支、`srgb?$fogcolor {120 200 255}` 才是引擎实际
        // 用的那条）⇒ 本工程输出就是 sRGB，取 srgb 分支才对得上游戏画面。
        fog_color: parse_dollar_color3(&cleaned, &lower, "\"srgb?$fogcolor\"")
            .or_else(|| parse_dollar_color3(&cleaned, &lower, "\"$fogcolor\""))
            .unwrap_or(d.fog_color),
        refract_tint: parse_dollar_color3(&cleaned, &lower, "\"$refracttint\"").unwrap_or(d.refract_tint),
        reflect_tint: parse_dollar_color3(&cleaned, &lower, "\"$reflecttint\"").unwrap_or(d.reflect_tint),
        refract_amount: parse_dollar_f32(&cleaned, &lower, "\"$refractamount\"").unwrap_or(d.refract_amount),
        reflect_amount: parse_dollar_f32(&cleaned, &lower, "\"$reflectamount\"").unwrap_or(d.reflect_amount),
        above_water: parse_dollar_f32(&cleaned, &lower, "\"$abovewater\"")
            .map(|v| v != 0.0)
            .unwrap_or(d.above_water),
        fog_start: parse_dollar_f32(&cleaned, &lower, "\"$fogstart\"").unwrap_or(d.fog_start),
        fog_end: parse_dollar_f32(&cleaned, &lower, "\"$fogend\"").unwrap_or(d.fog_end),
        // `$scroll1 "[.01 .01 .05]"`：只取前两维（第三维是帧动画速率）
        scroll1: parse_dollar_value(&cleaned, &lower, "\"$scroll1\"")
            .and_then(parse_vec3)
            .map(|v| [v[0], v[1]])
            .unwrap_or(d.scroll1),
        scroll2: parse_dollar_value(&cleaned, &lower, "\"$scroll2\"")
            .and_then(parse_vec3)
            .map(|v| [v[0], v[1]])
            .unwrap_or(d.scroll2),
        scale: parse_dollar_value(&cleaned, &lower, "\"$scale\"")
            .and_then(parse_vec3)
            .map(|v| [v[0], v[1]])
            .unwrap_or(d.scale),
        // `$waterdepth`：VBSP 给每块水写的 depth patch 里带的**水深**（世界单位）。
        // 名字兜底在调用点做（`depth_from_name`），因为这里拿不到材质名。
        water_depth: parse_dollar_f32(&cleaned, &lower, "\"$waterdepth\""),
        // `$bumpmap` / `$normalmap`：直接是路径字符串（去引号）。渲染端据此**选用**哪张失真图。
        bumpmap: parse_dollar_value(&cleaned, &lower, "\"$bumpmap\"").map(str::to_string),
        normalmap: parse_dollar_value(&cleaned, &lower, "\"$normalmap\"").map(str::to_string),
        // `$bumptransform "center .5 .5 scale 1 1 rotate 0"`：只吃 scale / rotate 两个数。
        // 注意有些水材质写的是 `texturescrollrate`（不是 transform）⇒ 解析不出就用缺省、不报错。
        bump_scale: parse_bumptransform_scale(&cleaned, &lower).unwrap_or(d.bump_scale),
        bump_rotate: parse_bumptransform_rotate(&cleaned, &lower).unwrap_or(d.bump_rotate),
    }
}

/// 取 `$bumptransform` 里的 `scale sx sy`（缺省 `None`）。
fn parse_bumptransform_scale(vdf: &str, lower: &str) -> Option<[f32; 2]> {
    let v = parse_dollar_value(vdf, lower, "\"$bumptransform\"")?;
    let toks: Vec<&str> = v.split_whitespace().collect();
    let i = toks.iter().position(|t| t.eq_ignore_ascii_case("scale"))?;
    let a = toks.get(i + 1)?.parse::<f32>().ok()?;
    let b = toks.get(i + 2).and_then(|s| s.parse::<f32>().ok()).unwrap_or(a);
    Some([a, b])
}

/// 取 `$bumptransform` 里的 `rotate <度>`（缺省 `None`）。
fn parse_bumptransform_rotate(vdf: &str, lower: &str) -> Option<f32> {
    let v = parse_dollar_value(vdf, lower, "\"$bumptransform\"")?;
    let toks: Vec<&str> = v.split_whitespace().collect();
    let i = toks.iter().position(|t| t.eq_ignore_ascii_case("rotate"))?;
    toks.get(i + 1)?.parse::<f32>().ok()
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
            // VMT 找不到（母材质不在包里）时的**兜底语义**取自 BSP texinfo 的 flags ——
            // 那是 VBSP 编译期按材质写下的，比 VMT 更不容易缺：
            //  - `WARP`（0x8，湍流水面扭曲）⇒ **这是水面**。Source 的 `Water` 材质永远没有
            //    `$basetexture`（颜色来自 `_rt_WaterRefraction` / `_rt_WaterReflection` 两个
            //    渲染目标），而 VBSP 只为它生成 `maps/<map>/…_depth_<n>.vmt` patch、母材质
            //    留在包外 ⇒ 此前一律落到下面"纯白 + 不透明"的兜底，水面画成一块白板
            //    （实测 surf_666：`dev/dev_water2` 176 面、`dev/dev_waterbeneath2` 175 面、
            //    `nature/water_canals03`(+`_beneath`) 16 面）。这里给上游口径的水色 + 半透明
            //    + 水面缺省反射强度，与「VMT 解析出 `Water`」的那条通路同结果。
            //  - `TRANS`（0x10，纹理半透明）⇒ 至少开混合（瀑布等 `Refract` 材质既不在包里
            //    也没有 `$translucent` 可读，只有这个标记能证明它是半透明面）。
            let tex_flags = texinfo_flags_of(bsp, name).unwrap_or(0);
            if tex_flags & 0x8 != 0 {
                // 水面但母材质 VMT 不在 pakfile、也不在回退表里：**不编造任何参数**。
                // `water: None` ⇒ 渲染端不注入水面着色器；alpha=0 ⇒ 该层不绘制（空缺），
                // 缺失记录已在上面的 `missing_resources.push` 里（与缺材质同形）。
                // 想看到真实水面，必须让该 VMT 能被解析到（pakfile 或 vmts-fallback）。
                return MaterialData {
                    name: name.to_string(),
                    path: String::new(),
                    color: [255, 255, 255, 0],
                    translucent: true,
                    ..MaterialData::default()
                };
            }
            let tex_translucent = tex_flags & 0x10 != 0;

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
                    // 贴图自带 alpha 通道时混合系数保持 1（透明度交给贴图），只开混合档位。
                    translucent: tex_translucent,
                    ..MaterialData::default()
                };
            }
            MaterialData {
                name: name.to_string(),
                path: String::new(),
                // 声明半透明却连贴图都没有 ⇒ 用占位 alpha（与 `$translucent` 无 alpha 来源同策）
                color: [255, 255, 255, if tex_translucent { TRANSLUCENT_PLACEHOLDER_ALPHA } else { 255 }],
                translucent: tex_translucent,
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
            // 回退 VMT 文本（游戏本体自带材质的原文，来源须能对上游戏安装 VPK）：
            // 命中就当作「从包里读到的 VMT」继续走同一套解析，参数全部来自真实材质。
            // 查不到再走基名回退；两者都没有才报错（数据缺失，不编造）。
            let fallback_key = name.replace('\\', "/").to_ascii_lowercase();
            if let Some(text) = options.vmt_fallback.get(&fallback_key) {
                (format!("fallback/{}", fallback_key), text.as_bytes().to_vec())
            } else {
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
                // `vmt_parser` 不认这个着色器 ⇒ 整条 typped 通路都走不到，
                // 但 VMT 文本里写的 `$envmap` 仍然算数（否则这类玻璃一律零反射）。
                envmap_tint: parse_dollar_envmap(&vdf, [1.0, 1.0, 1.0]),
                ..MaterialData::default()
            });
        }
    };

    // `patch` 材质 include 到的**母材质原文**（VBSP 为 `$envmap env_cubemap` 生成的
    // `maps/<map>/<材质>_<x>_<y>_<z>.vmt` 只写 `include` + 一条 `replace $envmap`）。
    //
    // 为什么必须留：`vmt_parser` 的 `resolve` 会把母材质的**类型化**字段（`$translucent` /
    // `$alpha` / `$basetexture`）并进来，但本文件的 `parse_dollar_*` 系列是**扁平文本扫描**，
    // 只看 `vdf` 自己 ⇒ 母材质里的 `$envmaptint` / `$color` / `$basetexture2` 一律看不到，
    // 于是 reflectivity 退回 `$envmaptint` 缺省 `[1,1,1]`（实测 surf_boreas 的 21 个
    // `$envmap` patch 全部如此，作者意图是 0.02~0.66）。这里把原文拼在 patch 之后给扫描用：
    // 同名键 patch 在前 ⇒ patch 自己的声明仍然优先。
    let mut included_vdf: Option<String> = None;
    let material = material.resolve(|path| {
        // 生成若干候选的路径格式
        let path = path.trim_start_matches('/').trim_start_matches("materials/"); // 剥掉 VBSP patch include 自带的 materials/ 前缀
        let possible_paths = vec![
            format!("materials/{}", path),
            format!("materials/{}", path.to_lowercase())
        ];

        // 逐个尝试上面的候选路径
        let hit = possible_paths.iter().find_map(|full_path| {
            match bsp.pack.get(full_path) {
                Ok(Some(data)) => Some(data),
                _ => None,
            }
        });
        if let Some(data) = hit {
            let vdf = String::from_utf8(data.to_vec())?;
            if included_vdf.is_none() {
                included_vdf = Some(vdf.clone());
            }
            return Ok::<_, Error>(vdf);
        }
        // 回退 VMT 文本：地图 patch 材质 `$include` 的基 VMT 往往不在 pakfile（游戏本体自带），
        // 与顶层查找共用同一张表；键归一（去 .vmt 后缀/反斜杠/小写）后再查，查不到才报错。
        let fallback_key = path
            .replace('\\', "/")
            .trim_end_matches(".vmt")
            .to_ascii_lowercase();
        if let Some(text) = options.vmt_fallback.get(&fallback_key) {
            if included_vdf.is_none() {
                included_vdf = Some(text.clone());
            }
            return Ok::<_, Error>(text.clone());
        }
        let paths_str = possible_paths.join(", ");
        Err(Error::Other(format!("Can't find file in BSP. Tried: {}", paths_str)))
    })?;

    // 扁平扫描用文本：patch 原文 + 母材质原文（见 `included_vdf` 的说明）。
    let vdf = match included_vdf {
        Some(included) => format!("{}\n{}", vdf, included),
        None => vdf,
    };

    let base_texture = match material.base_texture() {
        Some(texture) => texture,
        None => {
            let water = matches!(material, vmt_parser::material::Material::Water(_)); // Water 无 $basetexture ⇒ 上游口径的半透明水色
            // `Refract`（河流 / 瀑布 / 冰面折射）：Source 里这类材质**折射背景**，是"看得穿"的表面。
            // 它们的 VMT 只有 `$normalmap` / `$refractamount`，既没有 `$basetexture` 也没有
            // `$translucent`（`waterfallsoft…` 有，但 `vmt_parser 0.2.1` 的 Refract 不解析它）
            // ⇒ 落到这里时按**半透明**处理，否则整面画成不透明白板（实测 surf_666 的
            // `watersource/river/river_clear` 15 面 + `watersource/waterfall/waterfallsoft_1024_nrm_clear` 21 面）。
            let refract = matches!(material, vmt_parser::material::Material::Refract(_));
            let mut color = if water {
                WATER_COLOR
            } else {
                parse_dollar_color(&vdf).unwrap_or([255, 255, 255, 255])
            };
            // 折射面没有任何 alpha 来源（没有 `$alpha`、这一路也没有贴图）⇒ 用占位 alpha
            // （与 `$translucent` 无 alpha 来源同策：BLEND+alpha=1 等于不透明）。
            if refract && color[3] == 255 {
                color[3] = TRANSLUCENT_PLACEHOLDER_ALPHA;
            }
            return Ok(MaterialData {
                name: name.to_string(), path: vmt_path,
                color,
                translucent: water || refract,
                // 水面的 tint 缺省用 `WATER_DEFAULT_ENVMAP_TINT`（Source 的 `$reflectamount` 量级），
                // 其余材质保持 `$envmaptint` 缺省 `[1,1,1]`。
                envmap_tint: parse_dollar_envmap(
                    &vdf,
                    if water { WATER_DEFAULT_ENVMAP_TINT } else { [1.0, 1.0, 1.0] },
                ),
                // 水面参数：`Water` 着色器走这条通路（VMT 在包里时能读到 `$fogcolor` /
                // `$refractamount` / `$abovewater` …）。
                water: if water {
                    let mut w = parse_water_params(&vdf);
                    // 水深兜底：VMT 里没有 `$waterdepth` 时，从材质名尾巴的 `_depth_<n>` 读
                    // （VBSP 生成的 depth patch 命名，例 `dev/dev_water2_depth_192`）。
                    if w.water_depth.is_none() {
                        w.water_depth = depth_from_name(name);
                    }
                    Some(w)
                } else {
                    None
                },
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

    // `$alpha`（[0,1]，1 = 完全不透明）：直接取 VMT 的解析值。
    // `vmt-parser 0.2.1` 的 `Material::alpha()` 对未声明的键返还 1.0、对不支持的着色器
    // 同样返还 1.0（`material/mod.rs:169-180`）⇒ 缺省即不透明，不需要额外判定。
    // 越界值（≤ 0 会让材质整体隐形、≥ 1 无意义）统一归一到 1.0。
    let vmt_alpha = material.alpha();
    let alpha01 = if vmt_alpha > 0.0 && vmt_alpha < 1.0 { vmt_alpha } else { 1.0 };

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
            //    `translucent` / `alpha_test` 一并丢掉（实机表现：镂空画成近黑实心块）；③ 半透明材质贴图拿不到时占位 alpha=51（BLEND+alpha=1 会把烟/雾画成白墙）。
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
        .cloned(); let second_texture = load_second_texture(bsp, options, &vdf);

    // 基色 alpha 通道的取值优先级：
    //   ① VMT 声明了 `$alpha < 1` ⇒ 直接用解析值（这是唯一"活"的数值来源，与有无贴图无关）；
    //   ② 没声明、但贴图本身带 alpha 通道 ⇒ 这里给 255，透明度交给贴图的 alpha 通道
    //      （glTF 的 `baseColorTexture.a` 会自然参与混合，不需要在 factor 上重复表达）；
    //   ③ 两者都没有、却声明了半透明 ⇒ 落到 [TRANSLUCENT_PLACEHOLDER_ALPHA] 占位。
    // 旧口径把 ② 也写成 255 却**只对无贴图的情形**给 51，导致带贴图的半透明材质
    // 在 glTF 里是 BLEND 而实际 alpha 恒为 1 ⇒ 视觉与不透明逐像素相同。
    let alpha_u8 = if alpha01 < 1.0 {
        (alpha01 * 255.0).round() as u8
    } else if (translucent | glass) && texture_data.is_none() {
        TRANSLUCENT_PLACEHOLDER_ALPHA
    } else {
        255
    };

    Ok(MaterialData {
        color: [255, 255, 255, alpha_u8],
        name: name.to_string(),
        path: vmt_path,
        texture_absent: material.base_texture().is_some() && texture_data.is_none(), texture: texture_data, basetexture2: second_texture,
        alpha_test,
        translucent: translucent | glass,
        no_cull: material.no_cull(),
        transform,
        envmap_tint: parse_dollar_envmap(&vdf, [1.0, 1.0, 1.0]),
        wireframe: false,
        // 有 `$basetexture` 的材质不是水面（`Water` 着色器走上面的无 basetexture 分支）。
        water: None,
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
    let vtf_data = find_vtf_bytes(name, bsp)?;

    // 探针模式（`ConvertOptions::probe_only`）：只回答「能不能解」，不产出像素 —— 可解时给一张
    // 1×1 占位图，不可解时照旧 `Err`，于是 `texture_absent` 的判定与真解码完全一致。调用点只有
    // `mosaic/manifest.rs` 的 `collect_missing_textures`；渲染路径不得开这个开关。
    if options.probe_only {
        if !vtf_loadable(&vtf_data) {
            return Err(Error::Other("探针：VTF 解不出来".into()));
        }
        return Ok(DynamicImage::new_rgba8(1, 1));
    }

    // 两条 VTF 解码路径一致性（T-419）：外部 `vtf` crate 与 `texture_utils` 是两套独立实现，对
    // `Ia88` / `Bgra4444` 判定不一致（**crate 能读表头、decode 才报错**）。`and_then` 覆盖到解码，
    // 故 **crate 优先、失败退本仓**；`into_rgba8()` 重建精确容器（crate 的 Rgb8 变体多 25% 容量会 panic）。
    let crate_try = vtf::vtf::VTF::read(&vtf_data)
        .and_then(|vtf| Ok(DynamicImage::ImageRgba8(vtf.highres_image.decode(0)?.into_rgba8())));
    let image = crate_try.or_else(|e| decode_vtf_by_texture_utils(&vtf_data, e))?;

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

/// 在 pakfile 里按 4 条候选路径找这张贴图的 VTF 字节（原态 / 全小写 / 全大写 / 斜杠换下划线）。
///
/// 与解码分开，是为了让探针路径（只判可解、不解像素）与真解码共用同一套路径口径 ——
/// 两份实现一定会漂移。
fn find_vtf_bytes(name: &str, bsp: &Bsp) -> Result<Vec<u8>, Error> {
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
    possible_paths
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
        })
}

/// 这张 VTF **能不能解出来**（`true` = 能）。用于探针路径，通常**不解像素**。
///
/// 快路：本仓 `texture_utils` 能解析头部 + 该格式在 `decode` 的解码臂表内 + 第 0 帧落在字节内。
/// 这三条成立时 `decode` 必成 —— 第三条正是 T-661 给 `get_frame` 加的边界检查。
///
/// 慢路：快路判否时**真解一次**，结论与 [`load_texture_bsp`] 完全一致。这条兜底是必需的，否则会
/// 引入假阴性：`vtf` crate 认而本仓不认的格式（T-419）、头部与数据不符的截断文件（Momentum 那批），
/// 都只在真解时暴露。
fn vtf_loadable(vtf_data: &[u8]) -> bool {
    if let Ok(vtf) = crate::texture_utils::from_bytes(vtf_data) {
        if has_decode_arm(vtf.highres_image.format) {
            return vtf.highres_image.get_frame(0).is_ok();
        }
    }
    let crate_try = vtf::vtf::VTF::read(vtf_data).and_then(|v| {
        Ok(DynamicImage::ImageRgba8(v.highres_image.decode(0)?.into_rgba8()))
    });
    crate_try
        .or_else(|e| decode_vtf_by_texture_utils(vtf_data, e))
        .is_ok()
}

/// `texture_utils::image` 的 `decode` 有分支的格式（14 个）。
///
/// **保守方向**：将来给 `decode` 新增解码臂而这里没跟上时，那个格式会走慢路（真解一次）——
/// 结论仍然正确，只是慢一些；**不会**把「能解」误判成「不能解」。
fn has_decode_arm(f: crate::texture_utils::image::ImageFormat) -> bool {
    use crate::texture_utils::image::ImageFormat as F;
    matches!(
        f,
        F::Dxt1
            | F::Dxt1Onebitalpha
            | F::Dxt3
            | F::Dxt5
            | F::Rgba8888
            | F::Rgb888
            | F::Bgr888
            | F::Bgra8888
            | F::Abgr8888
            | F::Argb8888
            | F::Ia88
            | F::Bgra4444
            | F::I8
            | F::Uv88
    )
}

/// 从未被 `vmt_parser` 建模的 VMT 文本里取 `$basetexture2`（`WorldVertexTransition` 的第二贴图名）。
///
/// 扫描方式与 [`parse_dollar_color`] 同一套：在**小写副本**里定位 `"$basetexture2"`，再按同一
/// 字节偏移切原文，取紧随其后的第一对引号内的值。只做扁平扫描，不处理注释与嵌套块。
fn parse_dollar_basetexture2(vdf: &str) -> Option<String> {
    let lower = vdf.to_ascii_lowercase();
    let key = "\"$basetexture2\"";
    let at = lower.find(key)?;
    let rest = &vdf[at + key.len()..];
    let open = rest.find('"')?;
    let close = rest[open + 1..].find('"')? + open + 1;
    let value = rest[open + 1..close].trim();
    if value.is_empty() {
        return None;
    }
    Some(value.to_string())
}

/// 加载 `$basetexture2` 指向的 VTF，供 `MaterialData::basetexture2` 使用。
///
/// 失败路径与第一贴图同策：pakfile 内没有该 VTF 时查 `options.missing_fallback` 回退表，仍无则
/// 返回 `None`（只用第一贴图）——与「不处理第二贴图」的历史行为一致，不会更差。
fn load_second_texture(bsp: &Bsp, options: &ConvertOptions, vdf: &str) -> Option<TextureData> {
    let name = parse_dollar_basetexture2(vdf)?;
    match load_texture_bsp(&name, bsp, options) {
        Ok(image) => Some(TextureData { name, image }),
        Err(_) => fallback_texture_png(&options.missing_fallback, &[name.as_str()], 8)
            .and_then(|png| image::load_from_memory(&png).ok())
            .map(|image| TextureData { name, image }),
    }
}


/// `vtf` crate 解不开时的兜底：改用本仓 `texture_utils` 解码（认 `Ia88` / `Bgra4444` 等 crate 不认的格式）。
///
/// 两条 VTF 解码路径是两套独立实现、判定不一致（T-419），这里只兜 crate 的失败分支。
/// `texture_utils::Error` 没实现到本模块 `Error` 的 `From`，故两处都显式转 `Error::Other`。
/// crate 的 `Ok` 分支仍走 `into_rgba8()`：它对该类未压缩格式会返回「Rgb8 变体 + 多 25% 容量」的
/// 容器，PNG 编码按 `color()` 算期望长度会触发断言 panic。
fn decode_vtf_by_texture_utils<E: std::fmt::Debug>(
    vtf_data: &[u8],
    crate_err: E,
) -> Result<DynamicImage, Error> {
    let vtf = crate::texture_utils::from_bytes(vtf_data)
        .map_err(|e| Error::Other(format!("两条 VTF 解码路径均失败（crate: {:?}；本仓: {:?}）", crate_err, e)))?;
    vtf.highres_image
        .decode(0)
        .map_err(|e| Error::Other(format!("两条 VTF 解码路径均失败（本仓解码: {:?}）", e)))
}
