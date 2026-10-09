//! debug 工程的 WASM 绑定层：把共享解析层（仓库根 `src/wasm-core/`，crate `websurf-wasm-core`）
//! 与共享物理层（仓库根 `src/`，crate `websurf-phys`）的入口暴露给浏览器侧 JS。
//! crate 名为 `websurf-wasm`，`crate-type` 同时出 `cdylib` 与 `rlib`。
//!
//! 上下游：
//! - 上游：`websurf-wasm-core` 的 `vbsp`（BSP 解析）、`bsp_to_gltf_core`（GLB 装配）、
//!   `model_integrator`（模型 / 静态道具集成）、`pakfile_models`（PAKFILE 条目索引与 VMT 解析）、
//!   `texture_utils`（VTF 解码）、`mosaic`（图集编解码与 `.mtz` 解压）、`vhv`（prop 逐顶点光照）。
//!   物理侧 `websurf_phys::phys::PhysWorld` 由本文件 `pub use` 原样再导出，本文件不加包装。
//! - 下游：`apps/debug/src/main-wasm.ts` 取 `initSync` / `mosaic_decode` / `decompress_mtz`，
//!   在主线程建一份与 Worker 互不影响、相互独立的 wasm 实例；`apps/debug/src/app.ts` 取
//!   `BspProcessor` / `decompress_mtz`；`apps/debug/src/renderer/renderer-main.ts` 经
//!   `apps/debug/src/main-wasm.ts` 取 `mosaic_decode`。共享层的
//!   `src/ts-shared/phys/world-builder.ts` 按 `BspProcessorLike` 接口消费 `metadata` /
//!   `parse_spawn_points` / `parse_teleports` / `parse_pvs_data` / `export_brushes_planes` /
//!   `export_model_phy_colliders` / `export_model_tri_colliders` / `export_mosaic_manifest` /
//!   `export_missing_textures` / `export_glb_with_pakfile_models_with_defaults_and_lights` /
//!   `export_glb_with_pakfile_models`。
//!
//! 导出面的 TS 类型声明由 `apps/debug/src/wasm.d.ts` 手写维护，不是 wasm-bindgen 产物；
//! 该声明落后于本文件的导出面，缺 `export_visleaf_pvs` 与 `BspProcessor` 的
//! `export_glb_with_models` / `export_glb_with_pakfile_models_with_defaults_and_atlas_limit` /
//! `export_glb_with_pakfile_models_with_defaults_and_lights` /
//! `export_glb_with_pakfile_models_with_lights` / `is_alive` / `parse_entities` /
//! `list_pakfile` / `read_pakfile_file` / `read_pakfile_scripts` / `export_colliders` /
//! `export_colliders_with_filter`，以及 `PhysWorld` 的 7 个方法。
//!
//! 导出面（`#[wasm_bindgen]` 标记）：
//! - `parse_bsp`：一次性解析，只返回元数据 JSON，不持有 `Bsp`。
//! - `BspProcessor`：持有 `Arc<Bsp>`，提供元数据、GLB 导出与实体 / 碰撞体 / 传送点 / PVS 提取。
//! - `export_visleaf_pvs`：从 BSP 字节直接算出按 leaf 的 PVS 位图。
//! - `decode_vtf_to_png` / `mosaic_encode` / `mosaic_decode` / `decompress_mtz`：纹理解码与图集编解码。
//! - `start`：`#[wasm_bindgen(start)]`，模块装载时由 wasm-bindgen 自动调用。
//!
//! 不变量：
//! - 导出错误统一经 `to_js_err` 转成 `JsValue` 字符串，形如 `"<上下文>: <错误的 Debug 输出>"`。
//! - `BspProcessor` 的 GLB 导出入口用 `Option::take` 取走内部 `bsp`；取走后其余入口一律报
//!   「BSP 未解析或已导出」，要再导出须重新构造处理器。
//! - 二进制产物一律以 `Vec<u8>` 返回，由 wasm-bindgen 复制成 JS 侧的 `Uint8Array`。
//! - 本文件不做字节级格式解析、不做 GLB 装配、不做 VTF 解码，全部转交上游 crate。
//! - `init_panic_hook` 不是导出项：它没有 `#[wasm_bindgen]`，只被 `start` 调用，且仅 `wasm32` 编译。

use std::collections::HashMap;
use std::io::Cursor;

use wasm_bindgen::prelude::*;

// 共享解析层：仓库根 `src/wasm-core/`（crate `websurf-wasm-core`）
use websurf_wasm_core::{bsp_to_gltf_core, model_integrator, pakfile_models, phyfile, texture_utils, vbsp};
use model_integrator::{ExportOptions, InMemoryModel, InMemoryResources, ModelIntegrator};

// 导出编排（PAKFILE 模型 / 材质 / 光源 / 碰撞体派生）：仓库根 `src/wasm-core/render_bundle.rs`
use websurf_wasm_core::render_bundle::{
    aabb_volume, brush_model_indices, build_brush_model_origins, build_vmt_stem_index,
    collect_light_entities, collect_pakfile_models, entity_is_non_solid, load_vmdl,
    model_classnames, resolve_pakfile_materials, ColliderFilter, VhvLog,
};

// 共享物理层：仓库根 `src/`（crate `websurf-phys`）；整类型原样再导出，本文件不另加包装
pub use websurf_phys::phys::PhysWorld;

// ---------------------------------------------------------------------------
// 错误处理辅助：Rust 错误 → JsValue
// ---------------------------------------------------------------------------

/// 把错误拼成 JS 字符串，格式为 `"<ctx>: <错误的 Debug 输出>"`。
///
/// 泛型上界只要求 `std::fmt::Debug`，故错误类型不必实现 `Display`；`ctx` 由调用点按失败
/// 环节写死（如 `"BSP 解析失败"`、`"GLB 导出失败"`），是 JS 侧区分失败阶段的唯一依据。
fn to_js_err<E: std::fmt::Debug>(e: E, ctx: &str) -> JsValue {
    JsValue::from_str(&format!("{}: {:?}", ctx, e))
}

// ---------------------------------------------------------------------------
// 全局初始化：panic 钩子
// ---------------------------------------------------------------------------

/// 把 panic 信息经 `web_sys::console::error_1` 打到控制台，前缀固定为 `"vbsp-wasm panic: "`。
///
/// 仅 `wasm32` 编译（非 wasm 目标下本函数不存在）。无 `#[wasm_bindgen]`，JS 侧无法直接调用，
/// 唯一调用点是 `start`；重复调用会替换掉前一个钩子（`set_hook` 语义）。
#[cfg(target_arch = "wasm32")]
pub fn init_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        web_sys::console::error_1(&format!("vbsp-wasm panic: {}", info).into());
    }));
}

// ---------------------------------------------------------------------------
// 元数据 / 解析入口
// ---------------------------------------------------------------------------

/// 顶层元数据：由 `parse_bsp` 与 `BspProcessor::metadata` 序列化成 JSON 字符串返回，
/// 前端 `JSON.parse` 后直接使用。字段名全部是 `snake_case`（无 `rename_all`）。
///
/// 普通 Rust 结构体（不标 `#[wasm_bindgen]`）：wasm_bindgen 导出要求字段实现 `Copy`，
/// 而 `String` 字段不满足；故只能走 `serde_json` 字符串这条出口。
#[derive(serde::Serialize)]
pub struct BspMetadata {
    /// 结构版本号，由 `from_bsp` 写死为 `1`；消费方按它判断字段集。
    pub schema_version: u32,
    /// BSP 魔术字（如 "VBSP"），由 header.v/b/s/p 拼成。
    pub magic: String,
    /// 地图名。`from_bsp` 恒写空串，本结构没有别的写入点。
    pub map_name: String,
    /// 以下计数一律取对应 lump 的长度（`Vec::len()`），不是 BSP 头里的声明值。
    pub num_models: usize,
    pub num_faces: usize,
    /// 原始面数（`original_faces` lump），与 `num_faces` 是两个不同的 lump。
    pub num_original_faces: usize,
    pub num_vertices: usize,
    pub num_edges: usize,
    /// 纹理数据条目数（`textures_data` lump）。
    pub num_textures_data: usize,
    /// 纹理信息条目数（`textures_info` lump）。
    pub num_textures_info: usize,
    pub num_displacements: usize,
    pub num_entities: usize,
    pub num_static_props: usize,
    pub num_brushes: usize,
    pub num_leaves: usize,
    pub num_nodes: usize,
    /// pakfile 中打包的文件数（VFS 资源数）。
    pub packed_files: usize,
}

impl BspMetadata {
    // packed_files 由调用方传入，不在本函数内自取：`Packfile.zip` 是私有字段，
    // `into_zip()` 消费 self，取 len 只能先 clone 再开锁；两个调用点各自算一次后复用。
    fn from_bsp(bsp: &vbsp::Bsp, packed_files: usize) -> Self {
        let num_entities = bsp.entities.iter().count();
        let num_static_props = bsp.static_props().count();

        let h = &bsp.header;
        let magic = format!("{}{}{}{}", h.v as char, h.b as char, h.s as char, h.p as char);

        BspMetadata {
            schema_version: 1,
            magic,
            map_name: String::new(),
            num_models: bsp.models.len(),
            num_faces: bsp.faces.len(),
            num_original_faces: bsp.original_faces.len(),
            num_vertices: bsp.vertices.len(),
            num_edges: bsp.edges.len(),
            num_textures_data: bsp.textures_data.len(),
            num_textures_info: bsp.textures_info.len(),
            num_displacements: bsp.displacements.len(),
            num_entities,
            num_static_props,
            num_brushes: bsp.brushes.len(),
            num_leaves: bsp.leaves.len(),
            num_nodes: bsp.nodes.len(),
            packed_files,
        }
    }

    fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(self).map_err(|e| to_js_err(e, "序列化 BSP 元数据失败"))
    }
}

/// 一次性解析 BSP 字节数组，返回元数据 JSON 字符串。
///
/// 不持有 `Bsp` 实例：解析出的 `Bsp` 在本函数结束时释放，故只要元数据时用这里更省内存；
/// 要导出 GLB 或做各类提取，改用 [`BspProcessor`]。
///
/// 失败语义：`vbsp::Bsp::read` 失败 → `"BSP 解析失败: <Debug>"`；序列化失败 →
/// `"序列化 BSP 元数据失败: <Debug>"`。
#[wasm_bindgen]
pub fn parse_bsp(data: &[u8]) -> Result<String, JsValue> {
    let bsp = vbsp::Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;
    // Packfile.zip 私有，clone 后取 len()；此处只算一次
    let packed_files = bsp.pack.clone().into_zip().lock().unwrap().len();
    let metadata = BspMetadata::from_bsp(&bsp, packed_files);
    metadata.to_json()
}

// ---------------------------------------------------------------------------
// 处理器：持有 Bsp 实例，元数据可重复取，GLB 导出会消费实例
// ---------------------------------------------------------------------------

/// BSP 处理器：先 `new BspProcessor(bytes)` 解析，再调 `metadata()` 取元数据或
/// `export_glb*` 系列导出 GLB；解析结果在实例内保留到第一次成功的 GLB 导出为止。
#[wasm_bindgen]
pub struct BspProcessor {
    /// `Arc<Bsp>`：与共享层的借用式移交口径对齐（`export_bsp*` 收 `Arc<Bsp>`）；
    /// 但本文件的导出入口仍按既有语义**消费**实例（`Option::take`），故取走后变为 `None`。
    bsp: Option<std::sync::Arc<vbsp::Bsp>>,
    /// 缓存的 pakfile 文件数，避免 metadata() 重复克隆 Packfile
    packed_files: usize,
}

#[wasm_bindgen]
impl BspProcessor {
    /// 创建处理器并立即解析 BSP 数据；失败语义同 `parse_bsp`（`"BSP 解析失败: <Debug>"`）。
    #[wasm_bindgen(constructor)]
    pub fn new(data: &[u8]) -> Result<BspProcessor, JsValue> {
        let bsp = vbsp::Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;
        // 一次性计算并缓存 packed_files，避免 metadata() 重复克隆 Packfile
        let packed_files = bsp.pack.clone().into_zip().lock().unwrap().len();
        Ok(BspProcessor {
            bsp: Some(std::sync::Arc::new(bsp)),
            packed_files,
        })
    }

    /// 取元数据 JSON 字符串，字段集见 `BspMetadata`；只借用内部 `bsp`，不消费实例。
    ///
    /// 失败语义：实例已被某个 `export_*` 入口消费时返回 `JsValue` 字符串
    /// `"BSP 未解析或已导出"`（导出入口用的是带「请重新 new」的另一条文案）；序列化失败走
    /// `"序列化 BSP 元数据失败: <Debug>"`。
    pub fn metadata(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;
        let metadata = BspMetadata::from_bsp(bsp, self.packed_files);
        metadata.to_json()
    }

    /// 导出为 GLB 字节数组（纯地图，不带内嵌模型）。
    ///
    /// 用 `bsp_to_gltf_core::ConvertOptions::default()` 调 `export_bsp`，故不带缺失纹理回退、
    /// 不生成缺失列表、不导出光源。
    ///
    /// 消费内部 `bsp`（`export_bsp` 收 `Arc<Bsp>` 且此处用 `take()`）：再次导出需重新
    /// `new BspProcessor(bytes)`；已被消费时报 `"BSP 未解析或已被导出消费"`。
    /// 其余失败语义：`"GLB 导出失败: <Debug>"` / `"GLB 序列化失败: <Debug>"`。
    pub fn export_glb(&mut self) -> Result<Vec<u8>, JsValue> {
        let bsp = self
            .bsp
            .take()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费"))?;

        let options = bsp_to_gltf_core::ConvertOptions::default();
        let result = bsp_to_gltf_core::export_bsp(bsp, options)
            .map_err(|e| to_js_err(e, "GLB 导出失败"))?;

        // Glb::to_writer 接受任何 std::io::Write 对象
        let mut output: Vec<u8> = Vec::new();
        result
            .glb
            .to_writer(&mut output)
            .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;

        Ok(output)
    }

    /// 导出为 GLB，并把调用方传入的**内存模型**（`.mdl/.vvd/.dx90.vtx` 字节）合并进同一地图。
    ///
    /// 模型字节由 JS 侧提供，本入口不读 PAKFILE，也不用其中的纹理或材质标注 —— 除
    /// `static_props` 放置表外，`InMemoryResources` 其余字段都留空
    /// （`entities` / `light_entities` 为空、两张材质表为空），故这条路径不导出灯光、
    /// 也没有内置透明度标注，透明度只能靠 `textures_js` 之外的环节补齐。
    ///
    /// # 参数
    /// - `models_js`: 逐元素反序列化成 `InMemoryModel`，形状为
    ///   `{ "name": "…/crate.mdl", "mdl": Uint8Array, "vvd": Uint8Array, "vtx": Uint8Array }`；
    ///   解析失败报 `"模型参数解析失败: <Debug>"`。
    /// - `textures_js`: 反序列化成 `HashMap<String, Vec<u8>>`；键为纹理名（如 `"metal/crate"`），
    ///   值为 PNG 字节。解析失败报 `"纹理参数解析失败: <Debug>"`。
    ///
    /// # 放置信息
    /// 位置（origin）、朝向（angles）、solid 与两级 prop 光照全部由
    /// `bsp.static_props()` 派生（复用 `collect_pakfile_models`），不从入参取。
    ///
    /// 同样**消费**内部 `bsp`，被消费后报 `"BSP 未解析或已被导出消费，请重新 new"`。
    pub fn export_glb_with_models(
        &mut self,
        models_js: JsValue,
        textures_js: JsValue,
    ) -> Result<Vec<u8>, JsValue> {
        let bsp = self
            .bsp
            .take()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;

        // 解析 JS 传入的内存模型与纹理表
        let models: Vec<InMemoryModel> = serde_wasm_bindgen::from_value(models_js)
            .map_err(|e| JsValue::from_str(&format!("模型参数解析失败: {:?}", e)))?;
        let textures: HashMap<String, Vec<u8>> = serde_wasm_bindgen::from_value(textures_js)
            .map_err(|e| JsValue::from_str(&format!("纹理参数解析失败: {:?}", e)))?;

        // 从 BSP 派生静态道具放置信息（位置 / 朝向 / solid），并带上两级 prop 烘焙光照
        // （第 1 级 `sp_<idx>.vhv` 逐顶点 / 第 2 级 leaf ambient cube）——
        // 与 PAKFILE 提取路径共用 `collect_pakfile_models` 的同一份派生。
        // 本入口只取放置表：模型与条目名都丢弃（模型字节来自 `models_js`）。
        let (_pak_models, static_props, _entries) = collect_pakfile_models(&bsp, false, VhvLog::IfAnyProp).map_err(|e| JsValue::from_str(&e))?;

        let resources = InMemoryResources {
            models,
            entities: Vec::new(),
            static_props,
            textures,
            material_alpha_mode: std::collections::HashMap::new(),
            material_unlit: std::collections::HashSet::new(),
            material_envmap: std::collections::HashMap::new(),
            light_entities: Vec::new(),
        };

        let integrator = ModelIntegrator::from_in_memory(resources, ExportOptions::default());
        let options = bsp_to_gltf_core::ConvertOptions::default();
        let result = bsp_to_gltf_core::export_bsp_with_models(bsp, options, Some(&integrator))
            .map_err(|e| to_js_err(e, "GLB 导出失败"))?;

        let mut output: Vec<u8> = Vec::new();
        result
            .glb
            .to_writer(&mut output)
            .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;

        Ok(output)
    }

    /// 自动从 BSP 的 PAKFILE 提取模型并合并进同一份地图 GLB。
    ///
    /// 流程：`collect_pakfile_models` 枚举 PAKFILE 取出被 `static_props` 引用且三件套齐全的模型
    /// 与放置表 → 建 `pakfile_models::PakIndex` → `resolve_pakfile_materials` 解 VMT 标注并解 VTF
    /// → 装 `InMemoryResources` → `ModelIntegrator::from_in_memory` → `export_bsp_with_models`。
    ///
    /// 回退条件：提取到的模型表为空时（PAKFILE 里没有被引用的模型，或三件套不齐全）改用
    /// `bsp_to_gltf_core::export_bsp` 输出纯地图，不报错、不产生区别对待的返回值。
    ///
    /// 本入口不导出灯光（`light_entities` 留空、`ExportOptions` 用默认值），要带灯光用
    /// `export_glb_with_pakfile_models_with_lights` 或 `..._with_defaults_and_lights`；也不注入
    /// 缺失纹理回退表（`missing_fallback` 为空），要回退用 `..._with_defaults`。
    ///
    /// 消费内部 `bsp`；被消费后报 `"BSP 未解析或已被导出消费，请重新 new"`。
    pub fn export_glb_with_pakfile_models(&mut self) -> Result<Vec<u8>, JsValue> {
        let bsp = self
            .bsp
            .take()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;

        // 1~3. 提取被引用且三件套齐全的模型 + 放置表 + PAKFILE 条目清单
        let (models, static_props, entry_names) = collect_pakfile_models(&bsp, false, VhvLog::IfAnyProp).map_err(|e| JsValue::from_str(&e))?;

        // 4. 模型表为空 → 改走纯地图导出；此处已消费 `bsp`，不能再回到模型路径
        if models.is_empty() {
            let options = bsp_to_gltf_core::ConvertOptions::default();
            let result = bsp_to_gltf_core::export_bsp(bsp, options)
                .map_err(|e| to_js_err(e, "GLB 导出失败"))?;
            let mut output: Vec<u8> = Vec::new();
            result
                .glb
                .to_writer(&mut output)
                .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;
            return Ok(output);
        }

        // 5. 解 PAKFILE 内的 VMT/VTF：贴图 PNG 字节 + 材质透明度 / 无光照标注（`decode_textures = true`）
        // 本入口（`export_glb_with_pakfile_models`）不带默认纹理包回退表 ⇒ `fallback` 传 `None`
        // （与 game 同名入口一致；带回退的那条是 `export_glb_with_defaults_opts`）。
        let index = pakfile_models::PakIndex::build(&entry_names);
        let materials = resolve_pakfile_materials(&bsp, &models, &index, true, None);

        let resources = InMemoryResources {
            models,
            entities: model_integrator::collect_model_entities(&bsp),
            static_props,
            textures: materials.textures,
            material_alpha_mode: materials.alpha_modes,
            material_unlit: materials.unlit,
            material_envmap: materials.envmap_tints,
            light_entities: Vec::new(),
        };

        let integrator = ModelIntegrator::from_in_memory(resources, ExportOptions::default());
        let options = bsp_to_gltf_core::ConvertOptions::default();
        let result = bsp_to_gltf_core::export_bsp_with_models(bsp, options, Some(&integrator))
            .map_err(|e| to_js_err(e, "GLB 导出失败"))?;

        let mut output: Vec<u8> = Vec::new();
        result
            .glb
            .to_writer(&mut output)
            .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;

        Ok(output)
    }

    /// 导出 GLB（PAKFILE 模型）+ **缺失纹理回退**：`defaults_json` 是
    /// `{ "materials/<材质路径小写>": "#mosaic v4 字节码" }` 形式的回退表，命中的材质在导出期
    /// 就地解码低清纹理并嵌进 GLB（`ConvertOptions.missing_fallback`），渲染端拿到的是自包含场景。
    ///
    /// 与 `export_glb_with_pakfile_models` 同一实现，差异只有回退表与 `generate_missing_list`；
    /// 图集面积上界取 0（= 共享层政策上界），且**不导出灯光**。
    pub fn export_glb_with_pakfile_models_with_defaults(
        &mut self,
        defaults_json: &str,
    ) -> Result<Vec<u8>, JsValue> {
        self.export_glb_with_defaults_opts(defaults_json, 0, false)
    }

    /// `export_glb_with_pakfile_models_with_defaults` 的**图集面积上界可覆盖**变体。
    ///
    /// `lightmap_max_atlas_area`（像素面积）：有限且 `> 0` 时经 `as u64` 截断后写入
    /// `ConvertOptions.lightmap_max_atlas_area`；非有限值、0 或负数都归一成 0，即用共享层的
    /// 政策上界。其余行为与 `_with_defaults` 相同（不含灯光）。
    ///
    /// 该变体在手写 TS 侧无调用点（只出现在 `apps/debug/src/wasm.d.ts` 未声明的导出面上），
    /// 是公开导出里唯一能改写该阈值的入口。
    pub fn export_glb_with_pakfile_models_with_defaults_and_atlas_limit(
        &mut self,
        defaults_json: &str,
        lightmap_max_atlas_area: f64,
    ) -> Result<Vec<u8>, JsValue> {
        let area = if lightmap_max_atlas_area.is_finite() && lightmap_max_atlas_area > 0.0 {
            lightmap_max_atlas_area as u64
        } else {
            0
        };
        self.export_glb_with_defaults_opts(defaults_json, area, false)
    }

    /// 导出 GLB（PAKFILE 模型 + **缺失纹理回退** + **BSP 光照**）：回退表与灯光两条支路同时生效。
    ///
    /// 灯光来自 `collect_light_entities` 挑出的 `light` / `light_spot` / `light_environment` 实体，
    /// 经 `ExportOptions { include_lights: true }` 写成 `KHR_lights_punctual`；图集面积上界取 0。
    /// 共享层 `src/ts-shared/phys/world-builder.ts` 的 `buildWorldBundle` 首选本入口，
    /// 失败时回退 `export_glb_with_pakfile_models`。
    pub fn export_glb_with_pakfile_models_with_defaults_and_lights(
        &mut self,
        defaults_json: &str,
    ) -> Result<Vec<u8>, JsValue> {
        self.export_glb_with_defaults_opts(defaults_json, 0, true)
    }

    /// 导出 GLB（PAKFILE 模型 + **BSP 光照**），不注入缺失纹理回退表。
    ///
    /// 实现上是 `export_glb_with_defaults_opts("{}", 0, true)`：回退表为空 map，
    /// 故与 `..._with_defaults_and_lights` 只差一个非空回退表。手写 TS 侧无调用点。
    pub fn export_glb_with_pakfile_models_with_lights(&mut self) -> Result<Vec<u8>, JsValue> {
        self.export_glb_with_defaults_opts("{}", 0, true)
    }

    /// 四个 defaults 系列入口的共用实现（`lightmap_max_atlas_area` / `include_lights` 可调）。
    ///
    /// `defaults_json` 先整体反序列化成 `HashMap<String, String>`（失败即报
    /// `"默认纹理包 JSON 解析失败: <Debug>"`，不进后续步骤），再经 `options` 闭包写进
    /// `ConvertOptions` 的 `missing_fallback` / `generate_missing_list` / `lightmap_max_atlas_area`。
    ///
    /// 两条支路：模型表为空且 `include_lights == false` 时走 `export_bsp` 纯地图导出
    /// （注意该支路照样传 `options(true)`，即仍会生成缺失纹理列表）；否则装
    /// `InMemoryResources`（`light_entities` 仅当 `include_lights` 为真时由 `collect_light_entities` 填充）
    /// 后走 `export_bsp_with_models`。
    ///
    /// 消费内部 `bsp`；失败语义同其它导出入口。
    fn export_glb_with_defaults_opts(
        &mut self,
        defaults_json: &str,
        lightmap_max_atlas_area: u64,
        include_lights: bool,
    ) -> Result<Vec<u8>, JsValue> {
        let bsp = self
            .bsp
            .take()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;
        let fallback: std::collections::HashMap<String, String> =
            serde_json::from_str(defaults_json).map_err(|e| to_js_err(e, "默认纹理包 JSON 解析失败"))?;

        let (models, static_props, entry_names) = collect_pakfile_models(&bsp, false, VhvLog::IfAnyProp).map_err(|e| JsValue::from_str(&e))?;

        // 世界面材质的**基名 VMT 回退**索引（填进 `ConvertOptions::vmt_stem_index`）：
        // texinfo 给的名字（如 `METAL/METALGRATE013A2`）在包内没有精确路径时，改按基名
        // `metalgrate013a2.vmt` 命中作者写的 VMT，取其中的 `$basetexture` / `$translucent`
        // 等标注 —— 缺这一条时该类世界面会退化成不透明且无贴图（格栅/铁丝网整块变实心）。
        let stem_index = build_vmt_stem_index(&entry_names);

        let options = |generate_missing_list: bool| bsp_to_gltf_core::ConvertOptions {
            missing_fallback: fallback.clone(),
            vmt_stem_index: stem_index.clone(),
            generate_missing_list,
            lightmap_max_atlas_area,
            ..bsp_to_gltf_core::ConvertOptions::default()
        };

        // 无模型且不要灯光 → 纯地图导出（与 export_glb 同一条 `export_bsp` 路径，
        // 但这里带上了 missing_fallback 与 generate_missing_list=true）
        if models.is_empty() && !include_lights {
            let result = bsp_to_gltf_core::export_bsp(bsp, options(true))
                .map_err(|e| to_js_err(e, "GLB 导出失败"))?;
            let mut output: Vec<u8> = Vec::new();
            result
                .glb
                .to_writer(&mut output)
                .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;
            return Ok(output);
        }

        let index = pakfile_models::PakIndex::build(&entry_names);
        let materials = resolve_pakfile_materials(&bsp, &models, &index, true, Some(&fallback));
        let resources = InMemoryResources {
            models,
            entities: model_integrator::collect_model_entities(&bsp),
            static_props,
            textures: materials.textures,
            material_alpha_mode: materials.alpha_modes,
            material_unlit: materials.unlit,
            material_envmap: materials.envmap_tints,
            light_entities: if include_lights {
                collect_light_entities(&bsp)
            } else {
                Vec::new()
            },
        };
        let integrator = ModelIntegrator::from_in_memory(resources, ExportOptions { include_lights });
        let result = bsp_to_gltf_core::export_bsp_with_models(bsp, options(true), Some(&integrator))
            .map_err(|e| to_js_err(e, "GLB 导出失败"))?;
        let mut output: Vec<u8> = Vec::new();
        result
            .glb
            .to_writer(&mut output)
            .map_err(|e| to_js_err(e, "GLB 序列化失败"))?;
        Ok(output)
    }

    /// 导出 PAKFILE 内嵌模型的**可视网格**当碰撞网格用（世界空间三角形，不做几何简化）。
    ///
    /// 本入口不做任何碰撞体转化：不挤出厚度、不共面合并、不凸包、不做 OBB 回退，
    /// 逐顶点搬进世界空间后直接输出三角形。顶点链是
    /// `map_coords(model.apply_root_transform(v))` → `pakfile_models::place_point`
    /// （用 `placement` 的 `translation` / `rotation` / `scale` 就地烘进坐标）；
    /// 其中 `placement` 与 GLB 显示路径同源，都来自 `model_integrator::resolve_placements`，
    /// 但显示路径是把这组值写在 glTF 节点上（见 `src/wasm-core/model_integrator/mod.rs` 的
    /// `add_models_to_gltf`），不在 CPU 侧改顶点，故两条路径的顶点数值一致、承载方式不同。
    ///
    /// 输出 JSON：`[{ "name", "vertices": [[x,y,z]...], "indices": [[a,b,c]...],
    /// "min": [...], "max": [...] }]`，每个放置实例一个条目，世界坐标 Y-up。
    ///
    /// 门控：唯一门控是放置表上的 `solid == Some(0)`（`vbsp` 的 `SolidType::None`）。
    /// **不按材质透明度剔除**：起源引擎的碰撞来自模型的 `.phy`（vphysics）与 BSP 的 `contents` 位，
    /// `$translucent` / `$alphatest` 这类材质键只进渲染，从不参与碰撞定义
    /// （玻璃 / 水面道具本该可站可撞；探针在 `surf_666` 的窗与 `surf_sedona` 的坡上实测到被误剔）。
    ///
    /// 规模护栏：累计三角形数达 `MAX_TRI_TOTAL`（200_000）后停止取新模型、并中止当前实例循环，
    /// 已产出的条目照常返回；放置表为空或三件套不全的模型直接跳过。
    ///
    /// # 调用时机
    /// 只借用 `bsp`，须在消费 `bsp` 的导出入口之前调用；被消费后报
    /// `"BSP 未解析或已被导出消费，请重新 new"`。模型表为空时返回字符串 `"[]"`。
    pub fn export_model_tri_colliders(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;

        // 三件套收集顺带回的条目名表只服务材质查询；本函数已不看材质，故丢弃。
        let (models, static_props, _entry_names) = collect_pakfile_models(bsp, false, VhvLog::IfAnyProp).map_err(|e| JsValue::from_str(&e))?;
        if models.is_empty() {
            return Ok("[]".to_string());
        }

        let no_entities: Vec<model_integrator::Entity> = Vec::new();

        /// 单个实例的三角形网格：`name` 是 PAKFILE 里的模型路径，顶点已是世界空间。
        #[derive(serde::Serialize)]
        struct TriMeshOut {
            name: String,
            vertices: Vec<[f32; 3]>,
            indices: Vec<[u32; 3]>,
            min: [f32; 3],
            max: [f32; 3],
        }

        /// 累计三角形数上限：超出后不再展开新模型 / 新实例，已产出的条目保留。
        const MAX_TRI_TOTAL: usize = 200_000;

        let mut out: Vec<TriMeshOut> = Vec::new();
        let mut tri_total = 0usize;

        for m in &models {
            if tri_total >= MAX_TRI_TOTAL {
                break;
            }

            let placements =
                model_integrator::resolve_placements(&m.name, &no_entities, &static_props);
            let placements: Vec<_> = placements
                .into_iter()
                .filter(|p| p.solid != Some(0))
                .collect();
            if placements.is_empty() {
                continue;
            }

            let Some(model) = load_vmdl(m) else { continue };

            // ---- 局部空间顶点：先过模型根骨骼变换，再 Z-up → Y-up ----
            // 与显示路径对单个顶点用的是同一条 `map_coords(apply_root_transform(..))`
            let src = model.vertices();
            let mut local: Vec<[f32; 3]> = Vec::with_capacity(src.len());
            for v in src {
                local.push(model_integrator::map_coords(
                    model.apply_root_transform(v.position),
                ));
            }
            if local.is_empty() {
                continue;
            }

            // ---- 展开三角（vendored vmdl 已修复条带展开）；逐 mesh 全收，不看材质透明度 ----
            let mut tris: Vec<[u32; 3]> = Vec::new();
            for mesh in model.meshes() {
                let idx: Vec<usize> = mesh.vertex_strip_indices().flatten().collect();
                for c in idx.chunks_exact(3) {
                    let (a, b, d) = (c[0], c[1], c[2]);
                    if a >= local.len() || b >= local.len() || d >= local.len() {
                        continue;
                    }
                    tris.push([a as u32, b as u32, d as u32]);
                }
            }
            if tris.is_empty() {
                continue;
            }

            // ---- 每个放置实例：顶点搬移到世界空间（与 GLB 节点同一变换）----
            for p in &placements {
                if tri_total >= MAX_TRI_TOTAL {
                    break;
                }
                let mut verts: Vec<[f32; 3]> = Vec::with_capacity(local.len());
                for v in &local {
                    verts.push(pakfile_models::place_point(
                        *v, p.translation, p.rotation, p.scale,
                    ));
                }
                let mut min = [f32::INFINITY; 3];
                let mut max = [f32::NEG_INFINITY; 3];
                for v in &verts {
                    for i in 0..3 {
                        if v[i] < min[i] {
                            min[i] = v[i];
                        }
                        if v[i] > max[i] {
                            max[i] = v[i];
                        }
                    }
                }
                if !min.iter().all(|f| f.is_finite()) {
                    continue;
                }
                tri_total += tris.len();
                out.push(TriMeshOut {
                    name: m.name.clone(),
                    vertices: verts,
                    indices: tris.clone(),
                    min,
                    max,
                });
            }
        }

        
        // 置换面（displacement）：笔刷碰撞只覆盖平面凸包，而置换面把可见表面从基础笔刷平面推了
        // 出去 —— 只拿基础平面做碰撞，玩家撞到的是看不见的旧平面。Source 对置换面的做法就是按
        // 置换面自身的三角形烘碰撞；这里与渲染共用同一条细分+位移路径，并走本函数同一个出口
        // （`TriMesh[]`）⇒ 物理侧无需新增通道（auto 分支按「.phy 里没有的名字」回退，必被带上）。
        for i in 0..bsp.displacements.len() {
            let Some(disp) = bsp.displacement(i) else { continue };
            let mut verts: Vec<[f32; 3]> = Vec::new();
            let mut min = [f32::INFINITY; 3];
            let mut max = [f32::NEG_INFINITY; 3];
            for v in disp.triangulated_displaced_vertices() {
                let p = model_integrator::map_coords([v.x, v.y, v.z]);
                for k in 0..3 {
                    if p[k] < min[k] { min[k] = p[k]; }
                    if p[k] > max[k] { max[k] = p[k]; }
                }
                verts.push(p);
            }
            if verts.len() < 3 { continue; }
            let tri_count = (verts.len() / 3) as u32;
            out.push(TriMeshOut {
                name: format!("__disp_{i}"),
                vertices: verts,
                indices: (0..tri_count).map(|t| [t * 3, t * 3 + 1, t * 3 + 2]).collect(),
                min,
                max,
            });
        }
        serde_json::to_string(&out).map_err(|e| to_js_err(e, "序列化模型三角形碰撞失败"))
    }

    /// 导出 **PAKFILE 内嵌模型的「自带物理碰撞体」（`.phy`）** 为世界空间凸包三角形。
    ///
    /// 与 [`BspProcessor::export_model_tri_colliders`]（可视网格）不同，本方法解析模型
    /// 自己打包的 vphysics 碰撞体（`.phy`，Source 引擎实际使用的碰撞，凸包分解、更简化）。
    /// 输出格式与三角形碰撞**同构**（`TriMesh` + `surfaceprop`），前端可复用同一套
    /// `TriangleGrid` + `clipBoxToTriangle` 消费。
    ///
    /// 限制（首版）：
    /// - 仅支持 `modelType == 0`（IVPCompactSurface 凸包）；MOPP/Ball/Virtual 报错跳过；
    /// - 仅支持 `bone_index == 0` 的凸体（静态模型；带骨骼的动态模型顶点相对骨骼，
    ///   需要骨骼变换矩阵，暂跳过）；
    /// - 顶点米制 → HU（×39.3701），再经 `map_coords`（Z-up→Y-up）+ `place_point` 搬世界空间。
    ///
    /// 输出 JSON：`[{ "name", "surfaceprop", "vertices": [[x,y,z]...], "indices": [[a,b,c]...],
    /// "min": [...], "max": [...] }]`（每个放置实例一个条目）。
    pub fn export_model_phy_colliders(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已被导出消费，请重新 new"))?;

        let (models, static_props, _entry_names) = collect_pakfile_models(bsp, false, VhvLog::IfAnyProp).map_err(|e| JsValue::from_str(&e))?;
        if models.is_empty() {
            return Ok("[]".to_string());
        }

        let no_entities: Vec<model_integrator::Entity> = Vec::new();

        #[derive(serde::Serialize)]
        struct TriMeshOut {
            name: String,
            surfaceprop: String,
            vertices: Vec<[f32; 3]>,
            indices: Vec<[u32; 3]>,
            min: [f32; 3],
            max: [f32; 3],
        }

        const MAX_TRI_TOTAL: usize = 200_000;
        let mut out: Vec<TriMeshOut> = Vec::new();
        let mut tri_total = 0usize;

        for m in &models {
            if tri_total >= MAX_TRI_TOTAL {
                break;
            }
            // 只解析被引用的模型（static_props 匹配）；无 .phy 或解析失败 → 跳过（前端 auto 回退）
            let placements =
                model_integrator::resolve_placements(&m.name, &no_entities, &static_props);
            let placements: Vec<_> = placements
                .into_iter()
                .filter(|p| p.solid != Some(0))
                .collect();
            if placements.is_empty() {
                continue;
            }
            let phy_name = m.name.replace(".mdl", ".phy");
            let Ok(Some(phy_bytes)) = bsp.pack.get(&phy_name) else {
                continue;
            };
            let solids = match phyfile::parse_phy(&phy_bytes) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("⚠️ 跳过 PHY 解析失败 {}: {e}", m.name);
                    continue;
                }
            };
            if solids.is_empty() {
                continue;
            }
            // 加载模型（供 apply_root_transform 使用，与显示端同一根变换）
            let Some(model) = load_vmdl(m) else {
                continue;
            };

            // 收集该模型全部 bone==0 凸体的三角形（局部空间，HU，Z-up）
            let mut local: Vec<[f32; 3]> = Vec::new();
            let mut tris: Vec<[u32; 3]> = Vec::new();
            let mut sprop = String::new();
            for s in &solids {
                if s.surfaceprop.is_some() && sprop.is_empty() {
                    sprop = s.surfaceprop.clone().unwrap_or_default();
                }
                for c in &s.convexes {
                    if c.bone_index != 0 {
                        continue; // 动态骨骼：跳过
                    }
                    let base = local.len() as u32;
                    for v in &c.vertices {
                        // 关键：PHY 顶点存的是 **IVP 坐标系**（vphysics 内部，Y-up 左手系），
                        // Source 是 Z-up 右手系 —— 转换 = **绕 x 轴 90°：source = (x, z, -y)**
                        // （det=+1 纯旋转；仅 y↔z 交换是 det=-1 镜像，会上下颠倒）。
                        // 实测 79/87 模型尺寸映射 + 符号验证（probe_phy_mapping/orientation）。
                        let ivp2src = [v[0], v[2], -v[1]];
                        // 再施加与显示端相同的根骨骼变换（非 STATIC_PROP 时骨骼 0 带旋转）
                        let rt = model.apply_root_transform(vmdl::Vector {
                            x: ivp2src[0],
                            y: ivp2src[1],
                            z: ivp2src[2],
                        });
                        local.push(model_integrator::map_coords([rt.x, rt.y, rt.z]));
                    }
                    for t in &c.indices {
                        tris.push([base + t[0], base + t[1], base + t[2]]);
                    }
                }
            }
            if local.is_empty() || tris.is_empty() {
                continue;
            }

            for p in &placements {
                if tri_total >= MAX_TRI_TOTAL {
                    break;
                }
                let mut verts: Vec<[f32; 3]> = Vec::with_capacity(local.len());
                for v in &local {
                    verts.push(pakfile_models::place_point(
                        *v, p.translation, p.rotation, p.scale,
                    ));
                }
                let mut min = [f32::INFINITY; 3];
                let mut max = [f32::NEG_INFINITY; 3];
                for v in &verts {
                    for i in 0..3 {
                        if v[i] < min[i] {
                            min[i] = v[i];
                        }
                        if v[i] > max[i] {
                            max[i] = v[i];
                        }
                    }
                }
                if !min.iter().all(|f| f.is_finite()) {
                    continue;
                }
                tri_total += tris.len();
                out.push(TriMeshOut {
                    name: m.name.clone(),
                    surfaceprop: sprop.clone(),
                    vertices: verts,
                    indices: tris.clone(),
                    min,
                    max,
                });
            }
        }

        serde_json::to_string(&out).map_err(|e| to_js_err(e, "序列化模型 PHY 碰撞失败"))
    }

    /// 检查 BSP 是否仍持有（未被 export_glb 消费）。
    pub fn is_alive(&self) -> bool {
        self.bsp.is_some()
    }

    /// 生成纹理画质 manifest：`{ 纹理名(小写 VMT 路径): mosaic v4 字节码 }` JSON。
    ///
    /// 前端画质切换（原始/压缩低清）用：GLB 导出后调用一次（export_glb* 消费 BSP 之前），
    /// 切换画质时用 `mosaic_decode` 还原低清 PNG 替换贴图，无需重载地图。
    ///
    /// 覆盖两类纹理（与 GLB texture.name 对应）：
    /// 1. 地图 face 纹理（key = basetexture 小写，如 "materials/xxx"）
    /// 2. PAKFILE 模型贴图（key = 材质名小写，如 "maplebark"——修复 prop 墙面未压缩）
    pub fn export_mosaic_manifest(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 已被消费或未加载"))?;
        let mut pairs = websurf_wasm_core::mosaic::manifest::build_mosaic_manifest(bsp);
        // 模型贴图（材质名 → PNG → mosaic）；失败静默跳过（不影响地图纹理覆盖）
        if let Ok((models, _props, entry_names)) =
            collect_pakfile_models(bsp, false, VhvLog::IfAnyProp).map_err(|e| JsValue::from_str(&e))
        {
            let index = pakfile_models::PakIndex::build(&entry_names);
            let materials = resolve_pakfile_materials(bsp, &models, &index, true, None);
            for (name, png) in materials.textures {
                if let Ok(code) = websurf_wasm_core::mosaic::encode::img_to_code(&png, &name) {
                    pairs.push((name.to_ascii_lowercase(), code));
                }
            }
        }
        let map: std::collections::HashMap<String, String> = pairs.into_iter().collect();
        serde_json::to_string(&map).map_err(|e| to_js_err(e, "序列化 mosaic manifest 失败"))
    }

    /// 导出缺失材质纹理列表（VMT/VTF 缺失或解码失败 → 占位色）JSON 字符串数组。
    ///
    /// 前端加载后与默认配置纹理包（textures.mtz 解压的键集合）比对，
    /// 列出默认包也无法覆盖的缺失纹理并等待用户确认。
    pub fn export_missing_textures(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 已被消费或未加载"))?;
        let missing = websurf_wasm_core::mosaic::manifest::collect_missing_textures(bsp);
        serde_json::to_string(&missing).map_err(|e| to_js_err(e, "序列化缺失纹理列表失败"))
    }

    /// 提取出生点实体（info_player_start / info_player_terrorist / info_player_counterterrorist 等）。
    ///
    /// 返回 JSON：`{ "spawn_points": [{ classname, origin: [x,y,z], angles: [p,y,r],
    /// origin_raw, angles_raw }], "total": N, "primary": 0 }`。
    /// `primary` 为推荐出生点索引（优先 info_player_start）。
    ///
    /// **坐标转换**：BSP Z-up → Three.js Y-up（`[x,y,z]→[y,z,x]`，det=+1）。
    /// `origin` 已旋转为 Y-up；`angles` 保持 BSP 原始 `[pitch, yaw, roll]`，前端按需转换。
    pub fn parse_spawn_points(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        #[derive(serde::Serialize)]
        struct SpawnPoint {
            classname: String,
            origin: [f32; 3],
            angles: [f32; 3],
            origin_raw: String,
            angles_raw: Option<String>,
        }

        #[derive(serde::Serialize)]
        struct SpawnReport {
            spawn_points: Vec<SpawnPoint>,
            total: usize,
            primary: Option<usize>,
        }

        fn parse_vec3(s: &str) -> Option<[f32; 3]> {
            let parts: Vec<&str> = s.split_whitespace().collect();
            if parts.len() < 3 {
                return None;
            }
            Some([
                parts[0].parse::<f32>().ok()?,
                parts[1].parse::<f32>().ok()?,
                parts[2].parse::<f32>().ok()?,
            ])
        }

        // 坐标旋转 [x,y,z]→[y,z,x]（det=+1，正交变换，BSP Z-up → Three.js Y-up）
        fn rotate_yup(v: [f32; 3]) -> [f32; 3] {
            [v[1], v[2], v[0]]
        }

        // 出生点 classname 列表（按优先级排序）
        const SPAWN_CLASSNAMES: &[&str] = &[
            "info_player_start",         // HL2 / CS:S 主出生点
            "info_player_terrorist",      // CS T 出生点
            "info_player_counterterrorist", // CS CT 出生点
            "info_player_deathmatch",     // CS DM 出生点
            "info_player_teamspawn",      // CS 团队出生点
            "info_player_axis",           // DOD 轴心出生点
            "info_player_allied",         // DOD 同盟出生点
            "info_player_coop",           // HL Coop 出生点
            "info_teleport_destination",  // 传送目标点（作为备用）
        ];

        let mut spawn_points: Vec<SpawnPoint> = Vec::new();
        let mut primary: Option<usize> = None;

        for ent in bsp.entities.iter() {
            let Ok(classname) = ent.prop("classname") else {
                continue;
            };

            let is_spawn = SPAWN_CLASSNAMES.iter().any(|sc| classname == *sc);
            // 也匹配 info_player_* 通配
            let is_player_spawn = is_spawn || classname.starts_with("info_player_");

            if !is_player_spawn {
                continue;
            }

            let origin_raw = ent.prop("origin").unwrap_or("").to_string();
            let Some(origin) = parse_vec3(&origin_raw) else {
                continue;
            };
            let angles_raw = ent.prop("angles").ok().map(|s| s.to_string());
            let angles = angles_raw
                .as_ref()
                .and_then(|s| parse_vec3(s))
                .unwrap_or([0.0, 0.0, 0.0]);

            // 如果是 info_player_start，设为 primary
            if primary.is_none() && classname == "info_player_start" {
                primary = Some(spawn_points.len());
            }

            spawn_points.push(SpawnPoint {
                classname: classname.to_string(),
                origin: rotate_yup(origin),
                angles,
                origin_raw,
                angles_raw,
            });
        }

        // 如果没有 info_player_start，用第一个出生点
        if primary.is_none() && !spawn_points.is_empty() {
            primary = Some(0);
        }

        let report = SpawnReport {
            total: spawn_points.len(),
            spawn_points,
            primary,
        };

        serde_json::to_string(&report).map_err(|e| to_js_err(e, "序列化出生点数据失败"))
    }

    /// 解析 BSP 中所有实体（含属性和 outputs），用于调试 I/O 连接逻辑
    /// （trigger_multiple / logic_relay / filter_* 等）。
    ///
    /// 输出 JSON 数组，每实体含：
    /// - `classname`: 实体类型
    /// - `targetname`: 实体名称（I/O 连接用）
    /// - `props`: 所有键值属性（spawnflags, StartDisabled, target, model 等）
    /// - `outputs`: 所有 outputs（OnStartTouch, OnTouch, OnTrigger 等）
    /// - `origin`: 原始 origin 字符串
    /// - `model`: 模型字符串（如 "*3"）
    pub fn parse_entities(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        #[derive(serde::Serialize)]
        struct EntityOut {
            index: usize,
            classname: String,
            targetname: String,
            props: std::collections::BTreeMap<String, String>,
            outputs: Vec<String>,
            origin_raw: String,
            model_raw: Option<String>,
        }

        let mut result: Vec<EntityOut> = Vec::new();
        for (i, ent) in bsp.entities.iter().enumerate() {
            let classname = ent
                .prop("classname")
                .map(|s| s.to_string())
                .unwrap_or_default();
            let targetname = ent
                .prop("targetname")
                .map(|s| s.to_string())
                .unwrap_or_default();
            let origin_raw = ent
                .prop("origin")
                .map(|s| s.to_string())
                .unwrap_or_default();
            let model_raw = ent.prop("model").ok().map(|s| s.to_string());

            // 收集所有属性（区分 outputs 和普通属性）
            let mut props = std::collections::BTreeMap::new();
            let mut outputs = Vec::new();
            for (key, val) in ent.properties() {
                // Source BSP outputs 以 On 开头（如 OnStartTouch, OnTrigger）
                if key.starts_with("On") || key.starts_with("on") {
                    outputs.push(format!("{} {}", key, val));
                } else {
                    props.insert(key.to_string(), val.to_string());
                }
            }

            result.push(EntityOut {
                index: i,
                classname,
                targetname,
                props,
                outputs,
                origin_raw,
                model_raw,
            });
        }

        serde_json::to_string(&result).map_err(|e| JsValue::from_str(&format!("序列化失败: {e}")))
    }

    /// 列出 pakfile 中所有打包文件名（不含内容）。
    ///
    /// 用于快速检查 BSP 是否打包了 Lua/cfg/脚本等参与触发逻辑的资源。
    /// 返回 JSON：`{ "files": ["path1", ...], "total": N }`
    pub fn list_pakfile(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        #[derive(serde::Serialize)]
        struct PakfileList {
            files: Vec<String>,
            total: usize,
        }

        let zip = bsp.pack.clone().into_zip();
        let mut zip_guard = zip.lock().map_err(|e| {
            JsValue::from_str(&format!("pakfile 锁定失败: {e}"))
        })?;

        let mut files: Vec<String> = Vec::new();
        for i in 0..zip_guard.len() {
            if let Ok(entry) = zip_guard.by_index(i) {
                files.push(entry.name().to_string());
            }
        }

        let total = files.len();
        serde_json::to_string(&PakfileList { files, total })
            .map_err(|e| to_js_err(e, "序列化 pakfile 列表失败"))
    }

    /// 读取 pakfile 中指定路径的文件内容（字节）。
    ///
    /// 用于提取 Lua/cfg/文本脚本；找不到时返回空 Vec（不报错）。
    ///
    /// @param name pakfile 内的相对路径（如 `scripts/map/surf_nsz_fix.lua`）
    /// @returns 文件内容字节；找不到返回空数组
    pub fn read_pakfile_file(&self, name: &str) -> Result<Vec<u8>, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        match bsp.pack.get(name) {
            Ok(Some(data)) => Ok(data),
            Ok(None) => Ok(Vec::new()),
            Err(e) => Err(to_js_err(e, "读取 pakfile 文件失败")),
        }
    }

    /// 读取 pakfile 中所有文本类脚本（lua/cfg/txt/vmt/vdf）。
    ///
    /// 跳过二进制资源（vtf/vpk/bsp/sound）防内存爆炸；单文件上限 256KB。
    ///
    /// 返回 JSON：`{ "files": [{ "name": "path", "size": N, "content": "..." }], "total": N }`
    pub fn read_pakfile_scripts(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        #[derive(serde::Serialize)]
        struct ScriptFile {
            name: String,
            size: usize,
            content: String,
        }

        #[derive(serde::Serialize)]
        struct ScriptReport {
            files: Vec<ScriptFile>,
            total: usize,
        }

        // 允许的文本类扩展名（小写）
        const TEXT_EXTS: &[&str] = &[
            "lua", "cfg", "txt", "vmt", "vdf", "kv", "kv3", "res",
            "nut", "sma", "sp", "inc", "json", "xml", "ini",
        ];
        const MAX_FILE_SIZE: usize = 256 * 1024; // 256KB

        let zip = bsp.pack.clone().into_zip();
        let mut zip_guard = zip.lock().map_err(|e| {
            JsValue::from_str(&format!("pakfile 锁定失败: {e}"))
        })?;

        let mut files: Vec<ScriptFile> = Vec::new();
        for i in 0..zip_guard.len() {
            let Ok(mut entry) = zip_guard.by_index(i) else {
                continue;
            };
            let name = entry.name().to_string();
            // 过滤扩展名
            let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
            if !TEXT_EXTS.contains(&ext.as_str()) {
                continue;
            }
            // 大小保护
            let size = entry.size() as usize;
            if size > MAX_FILE_SIZE {
                continue;
            }
            // 读取内容
            let mut buf = Vec::with_capacity(size);
            use std::io::Read;
            if entry.read_to_end(&mut buf).is_err() {
                continue;
            }
            // 转 String（非 UTF-8 用 lossy 转换）
            let content = String::from_utf8_lossy(&buf).into_owned();
            files.push(ScriptFile {
                name,
                size: buf.len(),
                content,
            });
        }

        let total = files.len();
        serde_json::to_string(&ScriptReport { files, total })
            .map_err(|e| to_js_err(e, "序列化 pakfile 脚本失败"))
    }

    /// 解析传送触发器与目的地（trigger_teleport + info_teleport_destination）。
    ///
    /// 返回 JSON：`{ "triggers": [{ index, target, classname, origin,
    /// model_mins, model_maxs }], "links": [{ trigger_idx, dest_idx }] }`。
    ///
    /// **坐标转换**：BSP Z-up → Three.js Y-up（`[x,y,z]→[y,z,x]`，det=+1）。
    /// `origin` 已旋转为 Y-up；`angles` 保持 BSP 原始 `[pitch, yaw, roll]`。
    pub fn parse_teleports(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        #[derive(serde::Serialize)]
        struct TeleportDest {
            index: usize,
            targetname: String,
            origin: [f32; 3],
            angles: [f32; 3],
            origin_raw: String,
            angles_raw: Option<String>,
        }

        #[derive(serde::Serialize)]
        struct TeleportTrigger {
            index: usize,
            classname: String,
            target: String,
            origin: [f32; 3],
            model: Option<String>,
            /// model brush AABB min（Y-up）。None = 无 model 或解析失败。
            model_mins: Option<[f32; 3]>,
            /// model brush AABB max（Y-up）。None = 无 model 或解析失败。
            model_maxs: Option<[f32; 3]>,
            /// 触发区域凸包平面（世界坐标 Y-up，[nx,ny,nz,dist] 朝外）。
            /// 楔形/斜面触发区不能用 AABB 代替（斜坡 case）。
            model_planes: Option<Vec<[f32; 4]>>,
            /// spawnflags（bitfield）：1=Clients, 2=NPCs, 8=PhysicsObjects, 16=Only players, 64=Everything。
            spawnflags: u32,
            /// StartDisabled（0=启用, 1=禁用）；disabled 不应触发传送。
            start_disabled: bool,
            origin_raw: String,
            model_raw: Option<String>,
        }

        #[derive(serde::Serialize)]
        struct TeleportLink {
            trigger_idx: usize,
            dest_idx: usize,
        }

        #[derive(serde::Serialize)]
        struct TeleportReport {
            teleports: Vec<TeleportDest>,
            triggers: Vec<TeleportTrigger>,
            links: Vec<TeleportLink>,
            total_triggers: usize,
            total_dests: usize,
            total_links: usize,
            orphan_triggers: usize,
            orphan_dests: usize,
        }

        fn parse_vec3(s: &str) -> Option<[f32; 3]> {
            let parts: Vec<&str> = s.split_whitespace().collect();
            if parts.len() < 3 {
                return None;
            }
            let x = parts[0].parse::<f32>().ok()?;
            let y = parts[1].parse::<f32>().ok()?;
            let z = parts[2].parse::<f32>().ok()?;
            Some([x, y, z])
        }

        // 坐标旋转 [x,y,z]→[y,z,x]（det=+1，正交变换，BSP Z-up → Three.js Y-up）
        fn rotate_yup(v: [f32; 3]) -> [f32; 3] {
            [v[1], v[2], v[0]]
        }

        // 三平面求交（克莱默法则），退化返回 None
        fn tri_intersect(
            p1: &vbsp::Plane,
            p2: &vbsp::Plane,
            p3: &vbsp::Plane,
        ) -> Option<[f32; 3]> {
            let n1 = &p1.normal;
            let n2 = &p2.normal;
            let n3 = &p3.normal;
            let c23 = [
                n2.y * n3.z - n2.z * n3.y,
                n2.z * n3.x - n2.x * n3.z,
                n2.x * n3.y - n2.y * n3.x,
            ];
            let det = n1.x * c23[0] + n1.y * c23[1] + n1.z * c23[2];
            if det.abs() < 1e-6 {
                return None;
            }
            let c31 = [
                n3.y * n1.z - n3.z * n1.y,
                n3.z * n1.x - n3.x * n1.z,
                n3.x * n1.y - n3.y * n1.x,
            ];
            let c12 = [
                n1.y * n2.z - n1.z * n2.y,
                n1.z * n2.x - n1.x * n2.z,
                n1.x * n2.y - n1.y * n2.x,
            ];
            let inv = 1.0 / det;
            Some([
                (c23[0] * p1.dist + c31[0] * p2.dist + c12[0] * p3.dist) * inv,
                (c23[1] * p1.dist + c31[1] * p2.dist + c12[1] * p3.dist) * inv,
                (c23[2] * p1.dist + c31[2] * p2.dist + c12[2] * p3.dist) * inv,
            ])
        }

        /// 遍历 model.head_node 收集其全部 brush 的局部 AABB + 凸包平面（BSP Z-up 坐标）。
        ///
        /// **关键修复**：Hammer 可将多个分散 brush 绑定到同一实体（"Tie to entity"），
        /// 此时 `model.mins/maxs` 只是**总包围盒**，若直接当触发区会把盒内所有区域都变成触发区
        /// （test.bsp trigger_teleport *6 的实证）。正确做法：遍历 BSP 树，为每个 brush 单独算局部 AABB，各生成一个触发区域。
        ///
        /// 返回 (局部 AABB min, 局部 AABB max, 局部凸包平面 [nx,ny,nz,dist])；
        /// 凸包平面供 TS 端精确判定（楔形/斜面触发区不是 AABB）。
        fn model_brush_aabbs(
            bsp: &vbsp::Bsp,
            model_idx: usize,
        ) -> Vec<([f32; 3], [f32; 3], Vec<[f32; 4]>)> {
            let Some(model) = bsp.models.get(model_idx) else {
                return Vec::new();
            };
            // 1. 遍历 head_node 收集 brush 索引（跨 leaf 去重）
            let mut stack: Vec<i32> = vec![model.head_node];
            let mut brush_set: std::collections::HashSet<usize> = std::collections::HashSet::new();
            while let Some(ni) = stack.pop() {
                if ni < 0 {
                    let li = (!ni) as usize;
                    let Some(leaf) = bsp.leaves.get(li) else {
                        continue;
                    };
                    let start = leaf.first_leaf_brush as usize;
                    let count = leaf.leaf_brush_count as usize;
                    for k in start..(start + count).min(bsp.leaf_brushes.len()) {
                        if let Some(lb) = bsp.leaf_brushes.get(k) {
                            brush_set.insert(lb.brush as usize);
                        }
                    }
                } else if let Some(node) = bsp.nodes.get(ni as usize) {
                    stack.push(node.children[0] as i32);
                    stack.push(node.children[1] as i32);
                }
            }
            // 2. 每个 brush：planes → 凸包顶点 → 局部 AABB（与 compute_vertices 同算法）
            let mut out: Vec<([f32; 3], [f32; 3], Vec<[f32; 4]>)> = Vec::new();
            for bi in brush_set {
                let Some(brush) = bsp.brushes.get(bi) else {
                    continue;
                };
                let start = brush.brush_side as usize;
                let count = brush.num_brush_sides as usize;
                let mut ps: Vec<&vbsp::Plane> = Vec::new();
                for s in start..(start + count).min(bsp.brush_sides.len()) {
                    if let Some(side) = bsp.brush_sides.get(s) {
                        if let Some(pl) = bsp.planes.get(side.plane as usize) {
                            ps.push(pl);
                        }
                    }
                }
                if ps.len() < 4 {
                    continue;
                }
                let mut verts: Vec<[f32; 3]> = Vec::new();
                for i in 0..ps.len() {
                    for j in (i + 1)..ps.len() {
                        for k in (j + 1)..ps.len() {
                            let Some(v) = tri_intersect(ps[i], ps[j], ps[k]) else {
                                continue;
                            };
                            let mut valid = true;
                            for p in &ps {
                                let d = p.normal.x * v[0] + p.normal.y * v[1] + p.normal.z * v[2] - p.dist;
                                // BSP 平面朝外约定（内部 dot(n,p)-dist <= 0），排除在外点
                                if d > 1.0 {
                                    valid = false;
                                    break;
                                }
                            }
                            if !valid {
                                continue;
                            }
                            let mut dup = false;
                            for ev in &verts {
                                let dx = ev[0] - v[0];
                                let dy = ev[1] - v[1];
                                let dz = ev[2] - v[2];
                                if dx * dx + dy * dy + dz * dz < 0.01 {
                                    dup = true;
                                    break;
                                }
                            }
                            if !dup {
                                verts.push(v);
                            }
                        }
                    }
                }
                if verts.len() < 4 {
                    continue;
                }
                let mut mn = [f32::INFINITY; 3];
                let mut mx = [f32::NEG_INFINITY; 3];
                for v in &verts {
                    for a in 0..3 {
                        mn[a] = mn[a].min(v[a]);
                        mx[a] = mx[a].max(v[a]);
                    }
                }
                // 局部凸包平面（朝外约定 [nx,ny,nz,dist]，BSP Z-up）
                let plane_arr: Vec<[f32; 4]> = ps
                    .iter()
                    .map(|p| [p.normal.x, p.normal.y, p.normal.z, p.dist])
                    .collect();
                out.push((mn, mx, plane_arr));
            }
            out
        }

        let mut teleports: Vec<TeleportDest> = Vec::new();
        let mut triggers: Vec<TeleportTrigger> = Vec::new();

        for (idx, ent) in bsp.entities.iter().enumerate() {
            let Ok(classname) = ent.prop("classname") else {
                continue;
            };
            // 严格过滤：只有 info_teleport_destination* 是传送目标点。
            // info_target / info_player_teleport 等不是传送目标。
            if classname == "info_teleport_destination"
                || classname.starts_with("info_teleport_destination_")
            {
                let Ok(targetname) = ent.prop("targetname") else {
                    continue;
                };
                let targetname = targetname.to_string();
                let origin_raw = ent.prop("origin").unwrap_or("").to_string();
                let origin = parse_vec3(&origin_raw).unwrap_or([0.0, 0.0, 0.0]);
                let angles_raw = ent.prop("angles").ok().map(|s| s.to_string());
                let angles = angles_raw
                    .as_ref()
                    .and_then(|s| parse_vec3(s))
                    .unwrap_or([0.0, 0.0, 0.0]);
                teleports.push(TeleportDest {
                    index: idx,
                    targetname,
                    origin: rotate_yup(origin),
                    angles,
                    origin_raw,
                    angles_raw,
                });
            }
            // 严格过滤：trigger_multiple 是通用触发器，不算传送触发器（否则误传送）；
            // 仅 trigger_teleport / _random / _relative 是传送触发器。
            if classname == "trigger_teleport"
                || classname == "trigger_teleport_random"
                || classname == "trigger_teleport_relative"
            {
                let Ok(target) = ent.prop("target") else {
                    continue;
                };
                let target = target.to_string();
                let origin_raw = ent.prop("origin").unwrap_or("").to_string();
                let origin = parse_vec3(&origin_raw).unwrap_or([0.0, 0.0, 0.0]);
                let model_raw = ent.prop("model").ok().map(|s| s.to_string());
                let model = model_raw.clone();

                // spawnflags 默认 1 = Clients；不含 Clients bit 时对玩家不生效，TS 端会跳过
                let spawnflags = ent
                    .prop("spawnflags")
                    .ok()
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(1);

                // StartDisabled 默认 false=启用；disabled 不应触发传送，TS 端会跳过。键传小写（实体文本已小写化）
                let start_disabled = ent
                    .prop("startdisabled")
                    .map(|s| s == "1")
                    .unwrap_or(false);

                // model 格式 "*N" 指向 bsp.models[N]，几何为局部坐标（相对实体 origin）。
                //
                // 【关键修复】trigger 可绑定多个分散 brush（Hammer "Tie to entity"），
                // model.mins/maxs 只是**总包围盒**——直接用会把盒内所有区域变触发区。
                // 改为遍历 BSP 树，按每个 brush 局部 AABB 生成独立触发区域。
                let origin_yup = rotate_yup(origin);

                // 每个 brush 一个区域（局部 AABB + 凸包平面，BSP Z-up）
                let regions: Vec<([f32; 3], [f32; 3], Vec<[f32; 4]>)> = match model.as_deref() {
                    Some(m) if m.starts_with('*') => m[1..]
                        .parse::<usize>()
                        .ok()
                        .map(|i| model_brush_aabbs(bsp, i))
                        .unwrap_or_default(),
                    _ => Vec::new(),
                };
                // 世界 AABB + 世界凸包平面（局部 + 实体 origin 平移，旋转为 Y-up）
                let world_regions: Vec<([f32; 3], [f32; 3], Vec<[f32; 4]>)> =
                    if !regions.is_empty() {
                        regions
                            .iter()
                            .map(|(mn, mx, ps)| {
                                let mn_local = rotate_yup(*mn);
                                let mx_local = rotate_yup(*mx);
                                // 世界凸包平面：n_world = rotate_yup(n)，d_world = d + n·origin
                                let planes_world: Vec<[f32; 4]> = ps
                                    .iter()
                                    .map(|p| {
                                        let n = rotate_yup([p[0], p[1], p[2]]);
                                        let d = p[3]
                                            + p[0] * origin[0]
                                            + p[1] * origin[1]
                                            + p[2] * origin[2];
                                        [n[0], n[1], n[2], d]
                                    })
                                    .collect();
                                (
                                    [
                                        origin_yup[0] + mn_local[0],
                                        origin_yup[1] + mn_local[1],
                                        origin_yup[2] + mn_local[2],
                                    ],
                                    [
                                        origin_yup[0] + mx_local[0],
                                        origin_yup[1] + mx_local[1],
                                        origin_yup[2] + mx_local[2],
                                    ],
                                    planes_world,
                                )
                            })
                            .collect()
                    } else {
                        // 回退：model 下无 brush（虚拟实体/解析失败）→ 用 model 总包围盒
                        match model.as_deref() {
                            Some(m) if m.starts_with('*') => m[1..]
                                .parse::<usize>()
                                .ok()
                                .and_then(|i| bsp.models.get(i))
                                .map(|md| {
                                    let mins_local =
                                        rotate_yup([md.mins.x, md.mins.y, md.mins.z]);
                                    let maxs_local =
                                        rotate_yup([md.maxs.x, md.maxs.y, md.maxs.z]);
                                    // 回退路径无凸包平面（AABB 判定）
                                    vec![(
                                        [
                                            origin_yup[0] + mins_local[0],
                                            origin_yup[1] + mins_local[1],
                                            origin_yup[2] + mins_local[2],
                                        ],
                                        [
                                            origin_yup[0] + maxs_local[0],
                                            origin_yup[1] + maxs_local[1],
                                            origin_yup[2] + maxs_local[2],
                                        ],
                                        Vec::new(),
                                    )]
                                })
                                .unwrap_or_default(),
                            _ => Vec::new(),
                        }
                    };

                if world_regions.is_empty() {
                    // 无区域信息：推入无 AABB 的 trigger（TS 端回退球形检测）
                    triggers.push(TeleportTrigger {
                        index: idx,
                        classname: classname.to_string(),
                        target,
                        origin: rotate_yup(origin),
                        model,
                        model_mins: None,
                        model_maxs: None,
                        model_planes: None,
                        spawnflags,
                        start_disabled,
                        origin_raw,
                        model_raw,
                    });
                } else {
                    // 每个 brush 区域生成一个 trigger 条目（共享 target/origin/标志位）
                    for (mm, mx, planes) in world_regions {
                        triggers.push(TeleportTrigger {
                            index: idx,
                            classname: classname.to_string(),
                            target: target.clone(),
                            origin: rotate_yup(origin),
                            model: model.clone(),
                            model_mins: Some(mm),
                            model_maxs: Some(mx),
                            model_planes: if planes.is_empty() {
                                None
                            } else {
                                Some(planes)
                            },
                            spawnflags,
                            start_disabled,
                            origin_raw: origin_raw.clone(),
                            model_raw: model_raw.clone(),
                        });
                    }
                }
            }
        }

        // 构建链接：trigger.target ↔ dest.targetname
        let mut links: Vec<TeleportLink> = Vec::new();
        let mut linked_dests = std::collections::HashSet::new();
        let mut linked_triggers = std::collections::HashSet::new();

        for (t_idx, trigger) in triggers.iter().enumerate() {
            for (d_idx, dest) in teleports.iter().enumerate() {
                if dest.targetname == trigger.target {
                    links.push(TeleportLink {
                        trigger_idx: t_idx,
                        dest_idx: d_idx,
                    });
                    linked_triggers.insert(t_idx);
                    linked_dests.insert(d_idx);
                }
            }
        }

        let report = TeleportReport {
            total_triggers: triggers.len(),
            total_dests: teleports.len(),
            total_links: links.len(),
            orphan_triggers: triggers.len() - linked_triggers.len(),
            orphan_dests: teleports.len() - linked_dests.len(),
            teleports,
            triggers,
            links,
        };

        serde_json::to_string(&report).map_err(|e| to_js_err(e, "序列化传送门数据失败"))
    }

    /// 导出 BSP PVS（Potentially Visible Set）数据用于遮挡检测。
    ///
    /// 利用编译期预计算的 PVS 位图，Worker 端可 O(1) 查表遮挡剔除：
    /// 找相机所在 leaf → 取其 cluster → 查 PVS 表 → 仅渲染可见 cluster 的 mesh。
    ///
    /// 返回 JSON：`{ root_node, nodes: [{normal, dist, children}],
    /// leaves: [{cluster, mins, maxs, is_solid}], face_clusters: [...], pvs_bits_base64,
    /// cluster_count, bytes_per_row }`。
    ///
    /// **坐标转换**：BSP Z-up → Three.js Y-up（`[x,y,z]→[y,z,x]`，det=+1，
    /// 与 `export_brushes_planes` 一致）。plane normal 旋转，dist 不变；leaf mins/maxs 同样旋转。
    ///
    /// **face_cluster**：face_index → 主 cluster（-1 = 无 cluster/固体）；多 leaf 时取第一个非固体 cluster。
    ///
    /// **pvs_bits_base64**：预解码 PVS 位图，每行 cluster_count 位。
    /// `pvs_bits[cluster * bytes_per_row + (target_cluster / 8)]` 的第 `(target_cluster % 8)` 位为 1
    /// 表示从 `cluster` 可见 `target_cluster`。
    pub fn parse_pvs_data(&self) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        use vbsp::{Leaf, Node, Plane};

        // ---- 可序列化结构 ----
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct PvsNode {
            normal: [f32; 3],
            dist: f32,
            children: [i32; 2],
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct PvsLeaf {
            cluster: i16,
            mins: [i16; 3],
            maxs: [i16; 3],
            is_solid: bool,
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct PvsData {
            root_node: u32,
            nodes: Vec<PvsNode>,
            leaves: Vec<PvsLeaf>,
            face_clusters: Vec<i32>,
            pvs_bits_base64: String,
            cluster_count: u32,
            bytes_per_row: usize,
        }

        // 坐标旋转 [x,y,z]→[y,z,x]（BSP Z-up → Three.js Y-up），与其他导出函数保持一致
        fn rotate_yup_f32(v: &vbsp::Vector) -> [f32; 3] {
            [v.y, v.z, v.x]
        }
        fn rotate_yup_i16(v: [i16; 3]) -> [i16; 3] {
            [v[1], v[2], v[0]]
        }

        // ---- 1. 导出 nodes（BSP 树节点）----
        let nodes: Vec<PvsNode> = bsp
            .nodes
            .iter()
            .map(|node: &Node| {
                // 边界检查：plane_index 越界（损坏的 BSP 文件）时 `get` 返回 None，回落到朝上的默认平面
                let plane_idx = node.plane_index as usize;
                let default_plane = Plane { normal: vbsp::Vector { x: 0.0, y: 0.0, z: 1.0 }, dist: 0.0, ty: 0 };
                let plane = bsp.planes.get(plane_idx).unwrap_or(&default_plane);
                PvsNode {
                    normal: rotate_yup_f32(&plane.normal),
                    dist: plane.dist,
                    children: node.children,
                }
            })
            .collect();

        // ---- 2. 导出 leaves（cluster + 包围盒 + is_solid）----
        // leaves 保持原始 BSP 顺序（vbsp 解析模块已修复排序 bug）；
        // node.children 负数 → !index → 原始 leaf 索引
        let leaves: Vec<PvsLeaf> = bsp
            .leaves
            .iter()
            .map(|leaf: &Leaf| PvsLeaf {
                cluster: leaf.cluster,
                mins: rotate_yup_i16(leaf.mins),
                maxs: rotate_yup_i16(leaf.maxs),
                is_solid: leaf.cluster < 0,
            })
            .collect();

        // ---- 3. 建立 face → cluster 映射（取第一个非固体 cluster）----
        let mut face_clusters = vec![-1i32; bsp.faces.len()];
        for leaf in bsp.leaves.iter() {
            if leaf.cluster < 0 {
                continue; // 跳过固体 leaf（cluster == -1）
            }
            let start = leaf.first_leaf_face as usize;
            let count = leaf.leaf_face_count as usize;
            if start + count > bsp.leaf_faces.len() {
                continue; // 防止越界
            }
            for fi in start..(start + count) {
                let face_idx = bsp.leaf_faces[fi].face as usize;
                if face_idx < face_clusters.len() && face_clusters[face_idx] < 0 {
                    face_clusters[face_idx] = leaf.cluster as i32;
                }
            }
        }

        // ---- 4. 预解码 PVS 位图 ----
        // 直接解码 RLE 压缩的 PVS 数据；不用 visible_clusters()（无边界检查，越界 panic 会破坏 wasm-bindgen 状态）
        let cluster_count = bsp.vis_data.cluster_count;
        let bytes_per_row = ((cluster_count as usize) + 7) / 8;
        let mut pvs_bits = vec![0u8; (cluster_count as usize) * bytes_per_row];

        // 仅在有 PVS 数据时解码
        if cluster_count > 0 && !bsp.vis_data.pvs_offsets.is_empty() {
            let vis_data = &bsp.vis_data.data;
            let pvs_offsets = &bsp.vis_data.pvs_offsets;
            for c in 0..cluster_count {
                let c_usize = c as usize;
                if c_usize >= pvs_offsets.len() {
                    break;
                }
                let offset = pvs_offsets[c_usize] as usize;
                // 边界检查：offset 必须在 vis_data 范围内
                if offset >= vis_data.len() {
                    continue;
                }
                let row_offset = c_usize * bytes_per_row;
                // RLE 解码（权威实现：vbsp::decode_pvs_row，含 `*8` 修复）
                vbsp::decode_pvs_row(vis_data, offset, cluster_count, bytes_per_row, row_offset, &mut pvs_bits);
            }
        }

        let pvs_bits_base64 = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(&pvs_bits)
        };

        let pvs_data = PvsData {
            root_node: 0,
            nodes,
            leaves,
            face_clusters,
            pvs_bits_base64,
            cluster_count,
            bytes_per_row,
        };

        serde_json::to_string(&pvs_data).map_err(|e| to_js_err(e, "序列化 PVS 数据失败"))
    }

    /// 导出 BSP brush 的凸包碰撞体数据（无过滤，便捷方法）。
    ///
    /// 等价于 `export_colliders_with_filter("{}")`，保留以兼容旧调用方；
    /// 需要过滤 sky/nodraw/ladder/solid/小体积 brush 时用
    /// [`BspProcessor::export_colliders_with_filter`]。
    pub fn export_colliders(&self) -> Result<String, JsValue> {
        self.export_colliders_with_filter("{}")
    }

    /// 导出 BSP brush 的凸包碰撞体数据（带过滤参数）。
    ///
    /// 每个 SOLID/LADDER brush 转换为一个 ConvexPolyhedron（顶点 + 三角面索引），
    /// 参考 webgl-kz 方案：brush 即凸多面体，法线来自真实面，支持斜坡。
    ///
    /// `filter_json` 是 [`ColliderFilter`] 的 JSON，控制导出哪些 brush：
    /// - `include_ladder` / `include_solid`: 是否导出 LADDER / SOLID brush（默认 true）
    /// - `skip_sky`: 是否跳过含 SKY 纹理的 brush（默认 false，见下）；`skip_nodraw`: 是否跳过含 NODRAW 纹理的 brush（默认 false）
    /// - `min_brush_volume`: 跳过 AABB 体积小于此值的 brush（默认 0，不跳过）
    ///
    /// 算法：收集 brush 平面 → 三平面求交得凸包顶点（过滤正侧）→ 按面 fan 三角化 →
    /// 坐标转换 BSP Z-up → Three.js Y-up。
    /// 注意：该转换是 reflection（det=-1）会反转手性，故翻转三角形顶点顺序
    /// `[a,b,c]→[a,c,b]` 保持法线朝外。
    ///
    /// 返回 JSON：`{ "colliders": [{ "points": [...], "indexs": [[a,c,b], ...],
    /// "is_ladder": false, "is_solid": true, "brush_index": 0 }],
    /// "total_brushes": N, "exported": N, "skipped": N }`
    pub fn export_colliders_with_filter(
        &self,
        filter_json: &str,
    ) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        // 解析过滤参数（无效 JSON 或缺失字段用默认值）
        let filter: ColliderFilter =
            serde_json::from_str(filter_json).unwrap_or_default();

        use vbsp::{Brush, BrushFlags, Plane};

        #[derive(serde::Serialize)]
        struct Collider {
            points: Vec<[f32; 3]>,
            indexs: Vec<[u32; 3]>,
            is_ladder: bool,
            is_solid: bool,
            brush_index: usize,
        }
        #[derive(serde::Serialize)]
        struct ColliderReport {
            colliders: Vec<Collider>,
            total_brushes: usize,
            exported: usize,
            skipped: usize,
        }

        // 三平面求交（克莱默法则）：det = n1·(n2×n3)
        // P = (d1*(n2×n3) + d2*(n3×n1) + d3*(n1×n2)) / det
        fn plane_intersect(p1: &Plane, p2: &Plane, p3: &Plane) -> Option<[f32; 3]> {
            let n1 = &p1.normal;
            let n2 = &p2.normal;
            let n3 = &p3.normal;
            // n2 × n3
            let c23 = [
                n2.y * n3.z - n2.z * n3.y,
                n2.z * n3.x - n2.x * n3.z,
                n2.x * n3.y - n2.y * n3.x,
            ];
            let det = n1.x * c23[0] + n1.y * c23[1] + n1.z * c23[2];
            if det.abs() < 1e-6 {
                return None;
            }
            // n3 × n1
            let c31 = [
                n3.y * n1.z - n3.z * n1.y,
                n3.z * n1.x - n3.x * n1.z,
                n3.x * n1.y - n3.y * n1.x,
            ];
            // n1 × n2
            let c12 = [
                n1.y * n2.z - n1.z * n2.y,
                n1.z * n2.x - n1.x * n2.z,
                n1.x * n2.y - n1.y * n2.x,
            ];
            let inv = 1.0 / det;
            Some([
                (c23[0] * p1.dist + c31[0] * p2.dist + c12[0] * p3.dist) * inv,
                (c23[1] * p1.dist + c31[1] * p2.dist + c12[1] * p3.dist) * inv,
                (c23[2] * p1.dist + c31[2] * p2.dist + c12[2] * p3.dist) * inv,
            ])
        }

        // 单次遍历 brush_sides 收集平面引用 + texture_flags（sky/nodraw），合并原三次遍历
        fn collect_planes_and_flags<'a>(
            bsp: &'a vbsp::Bsp,
            brush: &Brush,
        ) -> (Vec<&'a Plane>, bool /*is_sky*/, bool /*is_nodraw*/) {
            let mut planes = Vec::new();
            let mut is_sky = false;
            let mut is_nodraw = false;
            let sky_flags = vbsp::TextureFlags::SKY | vbsp::TextureFlags::SKY2D;
            let start = brush.brush_side as usize;
            let count = brush.num_brush_sides as usize;
            for i in 0..count {
                let Some(side) = bsp.brush_sides.get(start + i) else {
                    continue;
                };
                // BSP 原生 bevel side（`side.bevel != 0`，编译器为"盒子别卡在棱上"生成的
                // 过棱小平面）**照常进平面表**：刀刃脊可站由它承担（owner 裁决；
                // 旧口径"在此剔除 bevel、运行时另合成切角平面"已整段撤除）。
                // 收集平面引用
                if let Some(plane) = bsp.planes.get(side.plane as usize) {
                    planes.push(plane);
                }
                // 检查 texture_flags（未命中时检查，短路优化）
                if side.texture_info >= 0 {
                    if let Some(ti) = bsp.textures_info.get(side.texture_info as usize) {
                        if !is_sky && ti.flags.intersects(sky_flags) {
                            is_sky = true;
                        }
                        if !is_nodraw && ti.flags.contains(vbsp::TextureFlags::NODRAW) {
                            is_nodraw = true;
                        }
                    }
                }
            }
            (planes, is_sky, is_nodraw)
        }

        // 计算 brush 顶点：三平面组合求交 + 过滤
        fn compute_vertices(planes: &[&Plane]) -> Vec<[f32; 3]> {
            let mut verts: Vec<[f32; 3]> = Vec::new();
            // 空间哈希去重：cell=0.1 HU，key=(x*10,y*10,z*10) as i32，O(m²)→O(m)
            let mut spatial: std::collections::HashMap<(i32, i32, i32), Vec<usize>> =
                std::collections::HashMap::new();
            let n = planes.len();
            if n < 4 {
                return verts;
            }
            for i in 0..n {
                for j in (i + 1)..n {
                    for k in (j + 1)..n {
                        if let Some(v) = plane_intersect(planes[i], planes[j], planes[k]) {
                            // 验证 v 在所有平面正侧（容差 1.0 HU，容许大坐标浮点误差）
                            let mut valid = true;
                            for p in planes {
                                let d = p.normal.x * v[0]
                                    + p.normal.y * v[1]
                                    + p.normal.z * v[2]
                                    - p.dist;
                                if d < -1.0 {
                                    valid = false;
                                    break;
                                }
                            }
                            if !valid {
                                continue;
                            }
                            // 空间哈希去重：距离 < 0.1 HU 视为同一点，查 3x3x3 邻域
                            let key = (
                                (v[0] * 10.0) as i32,
                                (v[1] * 10.0) as i32,
                                (v[2] * 10.0) as i32,
                            );
                            let mut dup = false;
                            'outer: for dx in -1..=1i32 {
                                for dy in -1..=1i32 {
                                    for dz in -1..=1i32 {
                                        if let Some(indices) =
                                            spatial.get(&(key.0 + dx, key.1 + dy, key.2 + dz))
                                        {
                                            for &idx in indices {
                                                let ev = &verts[idx];
                                                let ddx = ev[0] - v[0];
                                                let ddy = ev[1] - v[1];
                                                let ddz = ev[2] - v[2];
                                                if ddx * ddx + ddy * ddy + ddz * ddz < 0.01 {
                                                    dup = true;
                                                    break 'outer;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            if !dup {
                                spatial.entry(key).or_default().push(verts.len());
                                verts.push(v);
                            }
                        }
                    }
                }
            }
            verts
        }

        // 按面三角化：取平面上的顶点，按角度排序后 fan triangulate
        fn triangulate(planes: &[&Plane], verts: &[[f32; 3]]) -> Vec<[u32; 3]> {
            let mut indexs = Vec::new();
            for p in planes {
                let normal = &p.normal;
                // 找到在该平面上的顶点（距离 < eps）
                let mut face_verts: Vec<usize> = Vec::new();
                for (vi, v) in verts.iter().enumerate() {
                    let d = normal.x * v[0] + normal.y * v[1] + normal.z * v[2] - p.dist;
                    if d.abs() < 0.1 {
                        face_verts.push(vi);
                    }
                }
                if face_verts.len() < 3 {
                    continue;
                }
                // 计算质心
                let mut cx = 0.0f32;
                let mut cy = 0.0f32;
                let mut cz = 0.0f32;
                for &vi in &face_verts {
                    cx += verts[vi][0];
                    cy += verts[vi][1];
                    cz += verts[vi][2];
                }
                let inv_n = 1.0 / face_verts.len() as f32;
                cx *= inv_n;
                cy *= inv_n;
                cz *= inv_n;
                // 选参考方向（与法线不平行）
                let ref_dir = if normal.x.abs() < 0.9 {
                    [1.0f32, 0.0, 0.0]
                } else {
                    [0.0, 1.0, 0.0]
                };
                // u = normalize(ref_dir - (ref_dir·normal)*normal)，平面内参考轴
                let dot_rn = ref_dir[0] * normal.x + ref_dir[1] * normal.y + ref_dir[2] * normal.z;
                let u_raw = [
                    ref_dir[0] - dot_rn * normal.x,
                    ref_dir[1] - dot_rn * normal.y,
                    ref_dir[2] - dot_rn * normal.z,
                ];
                let ulen = (u_raw[0] * u_raw[0] + u_raw[1] * u_raw[1] + u_raw[2] * u_raw[2]).sqrt();
                if ulen < 1e-6 {
                    continue;
                }
                let u = [u_raw[0] / ulen, u_raw[1] / ulen, u_raw[2] / ulen];
                // v = normal × u（在平面内，与 u 正交）
                let v = [
                    normal.y * u[2] - normal.z * u[1],
                    normal.z * u[0] - normal.x * u[2],
                    normal.x * u[1] - normal.y * u[0],
                ];
                // 预计算顶点极角（每顶点 1 次 atan2），避免 sort 比较器重复计算，提速 5-10×
                let mut angled: Vec<(usize, f32)> = face_verts
                    .iter()
                    .map(|&vi| {
                        let va = &verts[vi];
                        let da = [va[0] - cx, va[1] - cy, va[2] - cz];
                        let ang = (da[0] * u[0] + da[1] * u[1] + da[2] * u[2])
                            .atan2(da[0] * v[0] + da[1] * v[1] + da[2] * v[2]);
                        (vi, ang)
                    })
                    .collect();
                angled.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
                face_verts = angled.into_iter().map(|(vi, _)| vi).collect();
                // fan triangulate（顶点顺序 [0, i, i+1] 为 CCW 从法线方向看）
                for i in 1..(face_verts.len() - 1) {
                    indexs.push([
                        face_verts[0] as u32,
                        face_verts[i] as u32,
                        face_verts[i + 1] as u32,
                    ]);
                }
            }
            indexs
        }

        // 主循环
        let mut colliders = Vec::new();
        let mut skipped = 0;
        // 【修复】brush → 模型 world origin 映射（实体 brush 局部坐标 → 世界坐标）
        let brush_model_origins = build_brush_model_origins(bsp);
        // 【修复】无碰撞实体（trigger_* / func_illusionary 等）的 brush 不导出为碰撞体，
        // 否则玩家会在触发区域踩到透明空气墙（用户实测）。
        let brush_models = brush_model_indices(bsp);
        let model_classes = model_classnames(bsp);
        // 调试：跳过原因统计
        let mut skip_no_solid_ladder = 0;
        let mut skip_filter_ladder = 0;
        let mut skip_filter_solid = 0;
        let mut skip_sky = 0;
        let mut skip_nodraw = 0;
        let mut skip_planes_lt4 = 0;
        let mut skip_verts_lt4 = 0;
        let mut skip_volume = 0;
        let mut skip_triangulate_empty = 0;
        const MAX_BRUSHES: usize = 8000; // 性能保护：上限

        for (brush_idx, brush) in bsp.brushes.iter().enumerate() {
            if colliders.len() >= MAX_BRUSHES {
                break;
            }
            // Source 引擎 MASK_PLAYERSOLID 语义：SOLID | WINDOW(玻璃) | GRATE(栅栏) |
            // PLAYERCLIP(玩家 clip) | MOVEABLE(可移动实体)。
            // WATER/SLIME 不在掩码中（可游入），不生成碰撞体。
            let player_solid_mask = BrushFlags::SOLID
                | BrushFlags::WINDOW
                | BrushFlags::GRATE
                | BrushFlags::PLAYERCLIP
                | BrushFlags::MOVEABLE;
            let is_solid = brush.flags.intersects(player_solid_mask);
            let is_ladder = brush.flags.contains(BrushFlags::LADDER);
            // 只导出 MASK_PLAYERSOLID 或 LADDER brush
            if !is_solid && !is_ladder {
                skipped += 1;
                skip_no_solid_ladder += 1;
                continue;
            }
            // 无碰撞实体 brush 过滤：trigger_* / func_illusionary 等不产生碰撞体
            if let Some(mi) = brush_models.get(brush_idx).copied().flatten() {
                if let Some(cls) = model_classes.get(mi).and_then(|c| c.as_deref()) {
                    if entity_is_non_solid(cls) {
                        skipped += 1;
                        continue;
                    }
                }
            }
            // 应用过滤参数
            if !filter.include_ladder && is_ladder {
                skipped += 1;
                skip_filter_ladder += 1;
                continue;
            }
            if !filter.include_solid && is_solid {
                skipped += 1;
                skip_filter_solid += 1;
                continue;
            }
            // 单次遍历收集 planes + sky/nodraw 标志
            let (planes, is_sky, is_nodraw) = collect_planes_and_flags(bsp, brush);
            // 【修复】实体模型 brush 的 planes 是局部坐标——平移模型 origin 到世界位置，
            // 否则碰撞体全部堆在模型原点（"大量不可见碰撞箱堆积在 0,0,0"）。
            let origin = brush_model_origins[brush_idx];
            let has_origin = origin[0] != 0.0 || origin[1] != 0.0 || origin[2] != 0.0;
            let owned_planes: Vec<Plane> = if has_origin {
                planes
                    .iter()
                    .map(|p| Plane {
                        normal: vbsp::Vector {
                            x: p.normal.x,
                            y: p.normal.y,
                            z: p.normal.z,
                        },
                        dist: p.dist
                            + p.normal.x * origin[0]
                            + p.normal.y * origin[1]
                            + p.normal.z * origin[2],
                        ty: p.ty,
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let plane_refs: Vec<&Plane> = if has_origin {
                owned_planes.iter().collect()
            } else {
                planes
            };
            if filter.skip_sky && is_sky {
                skipped += 1;
                skip_sky += 1;
                continue;
            }
            if filter.skip_nodraw && is_nodraw {
                skipped += 1;
                skip_nodraw += 1;
                continue;
            }
            if plane_refs.len() < 4 {
                skipped += 1;
                skip_planes_lt4 += 1;
                continue;
            }

            // 正常计算顶点
            let mut verts = compute_vertices(&plane_refs);
            // 回退：顶点 < 4 时翻转法线重算（部分编辑器生成法线朝内的 brush）
            let flipped: Vec<Plane> = if verts.len() < 4 {
                plane_refs.iter().map(|p| Plane {
                    normal: vbsp::Vector { x: -p.normal.x, y: -p.normal.y, z: -p.normal.z },
                    dist: -p.dist,
                    ty: p.ty,
                }).collect()
            } else { Vec::new() };
            if verts.len() < 4 && !flipped.is_empty() {
                let flipped_refs: Vec<&Plane> = flipped.iter().collect();
                verts = compute_vertices(&flipped_refs);
            }
            if verts.len() < 4 {
                skipped += 1;
                skip_verts_lt4 += 1;
                continue;
            }

            // min_brush_volume 过滤（AABB 体积估算），提前于 triangulate 避免无用的三角化
            if filter.min_brush_volume > 0.0 {
                let vol = aabb_volume(&verts);
                if vol < filter.min_brush_volume {
                    skipped += 1;
                    skip_volume += 1;
                    continue;
                }
            }

            // 三角化使用翻转后的法线（如已翻转）
            let triangulate_planes: Vec<&Plane> = if !flipped.is_empty() {
                flipped.iter().collect()
            } else {
                plane_refs.clone()
            };
            let mut indexs = triangulate(&triangulate_planes, &verts);
            if indexs.is_empty() {
                skipped += 1;
                skip_triangulate_empty += 1;
                continue;
            }

            // 坐标转换 BSP Z-up → Three.js Y-up：`[x,y,z]→[x,z,y]`（det=-1 reflection，反转手性），
            // 翻转三角形顶点顺序 [a,b,c]→[a,c,b] 保持法线朝外；原地修改后 move，避免额外分配
            for v in verts.iter_mut() {
                let (x, y, z) = (v[0], v[1], v[2]);
                v[0] = x;
                v[1] = z;
                v[2] = y;
            }
            let points = verts; // move，verts 不再使用
            for tri in indexs.iter_mut() {
                let tmp = tri[1];
                tri[1] = tri[2];
                tri[2] = tmp;
            }

            colliders.push(Collider {
                points,
                indexs,
                is_ladder,
                is_solid,
                brush_index: brush_idx,
            });
        }

        let report = ColliderReport {
            total_brushes: bsp.brushes.len(),
            exported: colliders.len(),
            skipped,
            colliders,
        };
        // 调试：输出跳过原因统计到控制台
        web_sys::console::log_1(&format!(
            "[Colliders Debug] total={}, exported={}, skipped={}, skip_reasons: no_solid_ladder={}, filter_ladder={}, filter_solid={}, sky={}, nodraw={}, planes_lt4={}, verts_lt4={}, volume={}, triangulate_empty={}",
            report.total_brushes, report.exported, report.skipped,
            skip_no_solid_ladder, skip_filter_ladder, skip_filter_solid,
            skip_sky, skip_nodraw, skip_planes_lt4, skip_verts_lt4,
            skip_volume, skip_triangulate_empty
        ).into());
        serde_json::to_string(&report).map_err(|e| to_js_err(e, "序列化碰撞体数据失败"))
    }

    /// 导出 BSP brush 的平面列表。
    ///
    /// 与 `export_colliders_with_filter` 的区别：
    /// - 输出平面列表（`Plane {normal, dist}`）而非三角化顶点，直接匹配 cs-movement 的 `Brush` 类型
    /// - 坐标旋转 `[x,y,z]→[y,z,x]`（det=+1，正交，不翻转绕序）
    /// - 废弃旧 `[x,y,z]→[x,z,y]` 反射约定（det=−1，需翻转绕序）
    ///
    /// 返回 `WasmBrush[]` JSON：`[{ planes: [{normal, dist}], min, max,
    /// is_ladder, is_solid }]`。
    ///
    /// **坐标转换**：BSP Z-up → Three.js Y-up（`[x,y,z]→[y,z,x]`）。
    /// 法线旋转 `normal = [n.y, n.z, n.x]`；dist 不变（正交变换 `dot(Rn,Rp)=dot(n,p)`）。
    ///
    /// `filter_json` 参数同 `export_colliders_with_filter`（`ColliderFilter` JSON）。
    pub fn export_brushes_planes(&self, filter_json: &str) -> Result<String, JsValue> {
        let bsp = self
            .bsp
            .as_ref()
            .ok_or_else(|| JsValue::from_str("BSP 未解析或已导出"))?;

        let filter: ColliderFilter =
            serde_json::from_str(filter_json).unwrap_or_default();

        use vbsp::{BrushFlags, Plane};

        #[derive(serde::Serialize)]
        struct WasmBrushPlane {
            normal: [f32; 3],
            dist: f32,
            /// 该平面在 `verts_bsp`（本 brush 的物理凸包顶点）上是否构成一张有面积的真实面。
            /// 判据只由物理侧给，渲染端直接读、不许再猜（owner 规则：显示端的面高亮必须真实
            /// 反映物理系统实际影响运动的面）。BSP 原生 bevel 平面大多不与凸包顶点构成
            /// 有面积的面而判 `false`；少数与凸包顶点构成可量多边形的照实判 `true`
            /// （它们确实参与逐平面裁剪，显示端画出来与物理一致）。
            is_real_face: bool,
            /// 该平面是否来自 BSP 原生 bevel side（`side.bevel != 0`，编译器为"盒子别卡在
            /// 棱上"生成的辅助碰撞平面；winding 裁剪时被 VBSP 跳过，不构成实体表面）。
            /// 与 `is_real_face` 正交：bevel 平面大多判非面，少数照实判面。
            is_bevel: bool,
        }

        // 顶点"落在某平面上"的判定容差（HU）。凸包顶点由 `plane_intersect` 从三元组交点直接
        // 产出，落在其定义平面上时残差是浮点级；0.1 HU 足够宽以稳定收集，又足够窄以不把
        // 邻近平面的顶点误收进来。
        const ON_PLANE_EPS: f32 = 0.1;
        // 面最小宽度（HU）：面上顶点到直径连线的最大垂距低于此值即判退化（顶点全共线）。
        // 偏保守是刻意的——判成"非面"的后果只是不显示，判成"面"的后果是显示一张假面。
        const MIN_FACE_WIDTH: f32 = 0.5;

        /// 该平面在 `verts` 上是否构成一张有面积的真实面。
        ///
        /// 判据两条，都要满足才算真面：
        /// 1. 落在平面上的顶点 ≥ 3（容差 [`ON_PLANE_EPS`]）；
        /// 2. 这些顶点**不共线**：取直径最远的一对作基线，其余点到该基线的垂距最大值
        ///    ≥ [`MIN_FACE_WIDTH`]。
        ///
        /// ⚠️ **不能用 Newell 多边形面积**：它要求顶点按边界环序排列，而这里的 `on` 是按
        /// `compute_vertices` 的枚举顺序收集的（它按平面三元组下标遍历产出，不是环序）⇒
        /// 叉积互相抵消、面积恒算成 0。实测 `surf_666` 的五棱柱 brush 有 5 张真实面被这样
        /// 误判成"非面"。直径 + 垂距是**与顶点顺序无关**的判据。
        fn plane_is_real_face(plane: &Plane, verts: &[[f32; 3]]) -> bool {
            if verts.len() < 3 {
                return false;
            }
            let n = &plane.normal;
            let mut on: Vec<[f32; 3]> = Vec::new();
            for v in verts {
                let d = n.x * v[0] + n.y * v[1] + n.z * v[2] - plane.dist;
                if d.abs() < ON_PLANE_EPS {
                    on.push([v[0], v[1], v[2]]);
                }
            }
            if on.len() < 3 {
                return false;
            }
            let mut ai = 0usize;
            let mut bi = 1usize;
            let mut best = -1.0f32;
            for x in 0..on.len() {
                for y in (x + 1)..on.len() {
                    let dx = on[x][0] - on[y][0];
                    let dy = on[x][1] - on[y][1];
                    let dz = on[x][2] - on[y][2];
                    let d = (dx * dx + dy * dy + dz * dz).sqrt();
                    if d > best {
                        best = d;
                        ai = x;
                        bi = y;
                    }
                }
            }
            if best < MIN_FACE_WIDTH {
                return false;
            }
            let a = on[ai];
            let b = on[bi];
            let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let mut width = 0.0f32;
            for (i, p) in on.iter().enumerate() {
                if i == ai || i == bi {
                    continue;
                }
                let ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
                let cx = ab[1] * ap[2] - ab[2] * ap[1];
                let cy = ab[2] * ap[0] - ab[0] * ap[2];
                let cz = ab[0] * ap[1] - ab[1] * ap[0];
                width = width.max((cx * cx + cy * cy + cz * cz).sqrt() / best);
            }
            width >= MIN_FACE_WIDTH
        }
        #[derive(serde::Serialize)]
        struct WasmBrush {
            planes: Vec<WasmBrushPlane>,
            min: [f32; 3],
            max: [f32; 3],
            is_ladder: bool,
            is_solid: bool,
        }

        // 三平面求交（Cramer 法则）— 用于计算 brush AABB
        fn plane_intersect(p1: &Plane, p2: &Plane, p3: &Plane) -> Option<[f32; 3]> {
            let n1 = &p1.normal;
            let n2 = &p2.normal;
            let n3 = &p3.normal;
            let c23 = [
                n2.y * n3.z - n2.z * n3.y,
                n2.z * n3.x - n2.x * n3.z,
                n2.x * n3.y - n2.y * n3.x,
            ];
            let det = n1.x * c23[0] + n1.y * c23[1] + n1.z * c23[2];
            if det.abs() < 1e-6 {
                return None;
            }
            let c31 = [
                n3.y * n1.z - n3.z * n1.y,
                n3.z * n1.x - n3.x * n1.z,
                n3.x * n1.y - n3.y * n1.x,
            ];
            let c12 = [
                n1.y * n2.z - n1.z * n2.y,
                n1.z * n2.x - n1.x * n2.z,
                n1.x * n2.y - n1.y * n2.x,
            ];
            let inv = 1.0 / det;
            Some([
                (c23[0] * p1.dist + c31[0] * p2.dist + c12[0] * p3.dist) * inv,
                (c23[1] * p1.dist + c31[1] * p2.dist + c12[1] * p3.dist) * inv,
                (c23[2] * p1.dist + c31[2] * p2.dist + c12[2] * p3.dist) * inv,
            ])
        }

        // 计算 brush 顶点（半空间交集），用于 AABB — 空间哈希去重
        fn compute_vertices(planes: &[&Plane]) -> Vec<[f32; 3]> {
            let mut verts: Vec<[f32; 3]> = Vec::new();
            let mut spatial: std::collections::HashMap<(i32, i32, i32), Vec<usize>> =
                std::collections::HashMap::new();
            let n = planes.len();
            if n < 4 {
                return verts;
            }
            for i in 0..n {
                for j in (i + 1)..n {
                    for k in (j + 1)..n {
                        if let Some(v) = plane_intersect(planes[i], planes[j], planes[k]) {
                            // 验证 v 在所有平面的正侧
                            let mut valid = true;
                            for p in planes {
                                let d = p.normal.x * v[0]
                                    + p.normal.y * v[1]
                                    + p.normal.z * v[2]
                                    - p.dist;
                                if d < -1.0 {
                                    valid = false;
                                    break;
                                }
                            }
                            if !valid {
                                continue;
                            }
                            // 空间哈希去重（距离 < 0.1 HU 视为同一点）
                            let key = (
                                (v[0] * 10.0) as i32,
                                (v[1] * 10.0) as i32,
                                (v[2] * 10.0) as i32,
                            );
                            let mut dup = false;
                            'outer: for dx in -1..=1i32 {
                                for dy in -1..=1i32 {
                                    for dz in -1..=1i32 {
                                        if let Some(indices) =
                                            spatial.get(&(key.0 + dx, key.1 + dy, key.2 + dz))
                                        {
                                            for &idx in indices {
                                                let ev = &verts[idx];
                                                let ddx = ev[0] - v[0];
                                                let ddy = ev[1] - v[1];
                                                let ddz = ev[2] - v[2];
                                                if ddx * ddx + ddy * ddy + ddz * ddz < 0.01 {
                                                    dup = true;
                                                    break 'outer;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            if !dup {
                                spatial.entry(key).or_default().push(verts.len());
                                verts.push(v);
                            }
                        }
                    }
                }
            }
            verts
        }

        // 坐标旋转 [x,y,z]→[y,z,x]（det=+1，正交变换，BSP Z-up → Three.js Y-up）
        fn rotate_yup(v: &vbsp::Vector) -> [f32; 3] {
            [v.y, v.z, v.x]
        }

        const MAX_BRUSHES: usize = 8000; // 性能保护：上限
        let sky_flags = vbsp::TextureFlags::SKY | vbsp::TextureFlags::SKY2D;
        let mut brushes_out: Vec<WasmBrush> = Vec::new();
        let mut skipped = 0;
        // 【修复】brush → 模型 world origin 映射（实体 brush 局部坐标 → 世界坐标）
        let brush_model_origins = build_brush_model_origins(bsp);
        // 【修复】无碰撞实体（trigger_* / func_illusionary 等）的 brush 不导出为碰撞体，
        // 否则玩家会在触发区域踩到透明空气墙（用户实测）。
        let brush_models = brush_model_indices(bsp);
        let model_classes = model_classnames(bsp);

        for (brush_idx, brush) in bsp.brushes.iter().enumerate() {
            if brushes_out.len() >= MAX_BRUSHES {
                break;
            }
            // MASK_PLAYERSOLID 语义同 export_colliders_with_filter：SOLID|WINDOW|GRATE|PLAYERCLIP|MOVEABLE
            let player_solid_mask = BrushFlags::SOLID
                | BrushFlags::WINDOW
                | BrushFlags::GRATE
                | BrushFlags::PLAYERCLIP
                | BrushFlags::MOVEABLE;
            let is_solid = brush.flags.intersects(player_solid_mask);
            let is_ladder = brush.flags.contains(BrushFlags::LADDER);
            if !is_solid && !is_ladder {
                skipped += 1;
                continue;
            }
            // 无碰撞实体 brush 过滤：trigger_* / func_illusionary 等不产生碰撞体
            if let Some(mi) = brush_models.get(brush_idx).copied().flatten() {
                if let Some(cls) = model_classes.get(mi).and_then(|c| c.as_deref()) {
                    if entity_is_non_solid(cls) {
                        skipped += 1;
                        continue;
                    }
                }
            }
            if !filter.include_ladder && is_ladder {
                skipped += 1;
                continue;
            }
            if !filter.include_solid && is_solid {
                skipped += 1;
                continue;
            }

            // 单次遍历 brush_sides 收集平面引用 + sky/nodraw 标志；
            // 数组访问用 .get() 防 panic 破坏 wasm-bindgen 借用状态
            // （bevel side 照常收集，见 collect_planes_and_flags 的说明）
            let mut bsp_planes: Vec<&Plane> = Vec::new();
            let mut bsp_bevels: Vec<bool> = Vec::new();
            let mut is_sky = false;
            let mut is_nodraw = false;
            let start = brush.brush_side as usize;
            let count = brush.num_brush_sides as usize;
            for i in 0..count {
                let Some(side) = bsp.brush_sides.get(start + i) else {
                    continue;
                };
                if let Some(plane) = bsp.planes.get(side.plane as usize) {
                    bsp_planes.push(plane);
                    bsp_bevels.push(side.bevel != 0);
                }
                if side.texture_info >= 0 {
                    if let Some(ti) = bsp.textures_info.get(side.texture_info as usize) {
                        if !is_sky && ti.flags.intersects(sky_flags) {
                            is_sky = true;
                        }
                        if !is_nodraw && ti.flags.contains(vbsp::TextureFlags::NODRAW) {
                            is_nodraw = true;
                        }
                    }
                }
            }

            if filter.skip_sky && is_sky {
                skipped += 1;
                continue;
            }
            if filter.skip_nodraw && is_nodraw {
                skipped += 1;
                continue;
            }
            if bsp_planes.len() < 4 {
                skipped += 1;
                continue;
            }

            // 【修复】实体模型 brush 的 planes 是局部坐标（相对模型 origin），
            // 平移模型 origin 到世界坐标，否则碰撞体全部堆在模型原点
            // （nsz 169 个原点 brush 的实体部分、test.bsp 触发器碰撞箱堆积的根因）。
            let origin = brush_model_origins[brush_idx];
            let has_origin = origin[0] != 0.0 || origin[1] != 0.0 || origin[2] != 0.0;
            let owned_planes: Vec<Plane> = if has_origin {
                bsp_planes
                    .iter()
                    .map(|p| Plane {
                        normal: vbsp::Vector {
                            x: p.normal.x,
                            y: p.normal.y,
                            z: p.normal.z,
                        },
                        dist: p.dist
                            + p.normal.x * origin[0]
                            + p.normal.y * origin[1]
                            + p.normal.z * origin[2],
                        ty: p.ty,
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let bsp_plane_refs: Vec<&Plane> = if has_origin {
                owned_planes.iter().collect()
            } else {
                // 浅克隆引用（Vec<&Plane>），后续 planes_yup 仍需借用 bsp_planes
                bsp_planes.clone()
            };
            // 与 bsp_plane_refs 逐位对齐的 bevel 旗标（origin 平移不改顺序）
            let plane_bevels: Vec<bool> = bsp_bevels;

        // 计算 BSP 坐标顶点（用于 AABB）
        let mut verts_bsp = compute_vertices(&bsp_plane_refs);

        // 回退：顶点 < 4 时翻转法线重算（部分编辑器生成法线朝内的 brush）
        // 与 export_colliders_with_filter 保持一致
        let flipped_planes: Vec<Plane> = if verts_bsp.len() < 4 {
            bsp_plane_refs
                .iter()
                .map(|p| Plane {
                    normal: vbsp::Vector {
                        x: -p.normal.x,
                        y: -p.normal.y,
                        z: -p.normal.z,
                    },
                    dist: -p.dist,
                    ty: p.ty,
                })
                .collect()
        } else {
            Vec::new()
        };
        if verts_bsp.len() < 4 && !flipped_planes.is_empty() {
            let flipped_refs: Vec<&Plane> = flipped_planes.iter().collect();
            verts_bsp = compute_vertices(&flipped_refs);
        }
        if verts_bsp.len() < 4 {
            skipped += 1;
            continue;
        }

        // 合并平面表（真实面 + BSP 原生 bevel side，统一 rotate+flip 后序列化；
        // 每条平面连同它的 bevel 旗标一起搬运，flipped 法线翻转不改旗标）
        let mut all_planes_src: Vec<(Plane, bool)> = Vec::new();
        if !flipped_planes.is_empty() {
            all_planes_src.extend(
                flipped_planes
                    .iter()
                    .cloned()
                    .zip(plane_bevels.iter().copied()),
            );
        } else {
            for (p, bevel) in bsp_plane_refs.iter().zip(plane_bevels.iter().copied()) {
                all_planes_src.push((
                    Plane {
                        normal: p.normal.clone(),
                        dist: p.dist,
                        ty: p.ty,
                    },
                    bevel,
                ));
            }
        }
            // 体积过滤（基于 AABB 体积估算）
            if filter.min_brush_volume > 0.0 {
                let vol = aabb_volume(&verts_bsp);
                if vol < filter.min_brush_volume {
                    skipped += 1;
                    continue;
                }
            }

            // 旋转顶点到 Y-up 并计算 AABB
            let mut min = [f32::INFINITY; 3];
            let mut max = [f32::NEG_INFINITY; 3];
            for v in &verts_bsp {
                let ry = [v[1], v[2], v[0]]; // [x,y,z]→[y,z,x]
                for i in 0..3 {
                    if ry[i] < min[i] {
                        min[i] = ry[i];
                    }
                    if ry[i] > max[i] {
                        max[i] = ry[i];
                    }
                }
            }

            // 旋转平面法线到 Y-up，并翻转法线方向（vbsp 内部约定 → cs-movement 约定）。
            //
            // **法线方向转换（关键修复）**：vbsp 读取的平面为"法线朝内"约定
            // （内部在正侧 `dot(n,p)-dist >= 0`，`compute_vertices` 的 `d < -1.0` 检查与此一致）；
            // cs-movement 的 `traceBox` / `brushFromAABB` 用"法线朝外"（内部在负侧，`d1>0` 表示起点在外）。
            // 直接导出会导致 cs-movement 误判内外，`traceBox` 永远返回 `fraction=1`（玩家穿透）。
            //
            // 修复：对每平面取负 `normal` 与 `dist`（`dot(-n,p)-(-dist) = -(dot(n,p)-dist)`，
            // 内部点 d>=0 → d<=0，等价翻转半空间）。先旋转到 Y-up 再取负（二者可交换）。
            // 统一从 all_planes_src（真实面 + BSP 原生 bevel）构建，全部输出：
            // 既进物理碰撞也进 debug 线框显示；is_bevel 随平面透传，供显示端把
            // "辅助碰撞面"与实体表面分开画（is_real_face 的几何判据保持不变）。
            let planes_yup: Vec<WasmBrushPlane> = all_planes_src
                .iter()
                .map(|(p, is_bevel)| {
                    let r = rotate_yup(&p.normal);
                    WasmBrushPlane {
                        normal: [-r[0], -r[1], -r[2]],
                        dist: -p.dist,
                        is_real_face: plane_is_real_face(p, &verts_bsp),
                        is_bevel: *is_bevel,
                    }
                })
                .collect();

            brushes_out.push(WasmBrush {
                planes: planes_yup,
                min,
                max,
                is_ladder,
                is_solid,
            });
        }

        web_sys::console::log_1(&format!(
            "[BrushPlanes] total={}, exported={}, skipped={}",
            bsp.brushes.len(),
            brushes_out.len(),
            skipped
        ).into());

        // 输出纯 WasmBrush[] JSON 数组
        serde_json::to_string(&brushes_out).map_err(|e| to_js_err(e, "序列化 brush 平面数据失败"))
    }
}

// ---------------------------------------------------------------------------
// visleaf + PVS 二进制导出（WASM 版 export-vis-pvs，供 Node 脚本离线导出）
//
// 与 crates/vbsp/src/bin/export-vis-pvs.rs 的 compute_core + export_binary 一致，
// 输出字节完全相同的 .visleaf.bin / .pvs.bin（格式 v1）。
// 依赖 vbsp 修复：leaves lump version 1 解析 + vis data 完整基址。
// ---------------------------------------------------------------------------

/// 从 BSP 字节数组导出 visleaf + PVS 二进制数据。
///
/// 返回 JS 对象：`{ visleaf_bin: Uint8Array(VBVL), pvs_bin: Uint8Array(VBPV),
/// md5Hex: 源 BSP MD5, clusterCount, leafCount, nodeCount, faceCount }`
#[wasm_bindgen]
pub fn export_visleaf_pvs(data: &[u8]) -> Result<JsValue, JsValue> {
    use vbsp::{Bsp, Leaf, Node, Plane, Vector};

    // ---- 源 BSP MD5 ----
    let md5_bytes: [u8; 16] = md5::compute(data).0;
    let md5_hex: String = md5_bytes.iter().map(|b| format!("{:02x}", b)).collect();

    // ---- 解析（含修复：leaves v1 / vis 完整基址）----
    let bsp = Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;

    // ---- 坐标旋转 [x,y,z] → [y,z,x]（BSP Z-up → Three.js Y-up，det=+1）----
    fn rotate_yup_f32(v: &Vector) -> [f32; 3] {
        [v.y, v.z, v.x]
    }
    fn rotate_yup_i16(v: [i16; 3]) -> [i16; 3] {
        [v[1], v[2], v[0]]
    }
    fn default_plane() -> Plane {
        Plane {
            normal: Vector { x: 0.0, y: 0.0, z: 1.0 },
            dist: 0.0,
            ty: 0,
        }
    }

    // ---- nodes ----
    let nodes: Vec<([f32; 3], f32, [i32; 2])> = bsp
        .nodes
        .iter()
        .map(|node: &Node| {
            let plane_idx = node.plane_index as usize;
            let dp = default_plane();
            let plane = bsp.planes.get(plane_idx).unwrap_or(&dp);
            (rotate_yup_f32(&plane.normal), plane.dist, node.children)
        })
        .collect();

    // ---- leaves ----
    let leaves: Vec<(i16, [i16; 3], [i16; 3], bool)> = bsp
        .leaves
        .iter()
        .map(|leaf: &Leaf| {
            (
                leaf.cluster,
                rotate_yup_i16(leaf.mins),
                rotate_yup_i16(leaf.maxs),
                leaf.cluster < 0,
            )
        })
        .collect();

    // ---- face → cluster ----
    let mut face_clusters = vec![-1i32; bsp.faces.len()];
    for leaf in bsp.leaves.iter() {
        if leaf.cluster < 0 {
            continue;
        }
        let start = leaf.first_leaf_face as usize;
        let count = leaf.leaf_face_count as usize;
        if start + count > bsp.leaf_faces.len() {
            continue;
        }
        for fi in start..(start + count) {
            let face_idx = bsp.leaf_faces[fi].face as usize;
            if face_idx < face_clusters.len() && face_clusters[face_idx] < 0 {
                face_clusters[face_idx] = leaf.cluster as i32;
            }
        }
    }

    // ---- PVS 位图（vbsp::decode_pvs_row 为唯一权威解码）----
    let cluster_count = bsp.vis_data.cluster_count;
    let bytes_per_row = ((cluster_count as usize) + 7) / 8;
    let mut pvs_bits = vec![0u8; (cluster_count as usize) * bytes_per_row];
    if cluster_count > 0 && !bsp.vis_data.pvs_offsets.is_empty() {
        let vis_data = &bsp.vis_data.data;
        for c in 0..cluster_count {
            let c_usize = c as usize;
            if c_usize >= bsp.vis_data.pvs_offsets.len() {
                break;
            }
            let offset = bsp.vis_data.pvs_offsets[c_usize] as usize;
            vbsp::decode_pvs_row(
                vis_data,
                offset,
                cluster_count,
                bytes_per_row,
                c_usize * bytes_per_row,
                &mut pvs_bits,
            );
        }
    }

    // ---- 打包 visleaf.bin (VBVL) ----
    let mut vl: Vec<u8> = Vec::with_capacity(40 + nodes.len() * 24 + leaves.len() * 15 + face_clusters.len() * 4);
    vl.extend_from_slice(b"VBVL");
    vl.extend_from_slice(&1u32.to_le_bytes());
    vl.extend_from_slice(&md5_bytes);
    vl.extend_from_slice(&cluster_count.to_le_bytes());
    vl.extend_from_slice(&(leaves.len() as u32).to_le_bytes());
    vl.extend_from_slice(&(nodes.len() as u32).to_le_bytes());
    vl.extend_from_slice(&(face_clusters.len() as u32).to_le_bytes());
    for (normal, dist, children) in &nodes {
        for c in normal {
            vl.extend_from_slice(&c.to_le_bytes());
        }
        vl.extend_from_slice(&dist.to_le_bytes());
        for c in children {
            vl.extend_from_slice(&c.to_le_bytes());
        }
    }
    for (cluster, mins, maxs, is_solid) in &leaves {
        vl.extend_from_slice(&cluster.to_le_bytes());
        for c in mins {
            vl.extend_from_slice(&c.to_le_bytes());
        }
        for c in maxs {
            vl.extend_from_slice(&c.to_le_bytes());
        }
        vl.push(*is_solid as u8);
    }
    for fc in &face_clusters {
        vl.extend_from_slice(&fc.to_le_bytes());
    }

    // ---- 打包 pvs.bin (VBPV) ----
    let mut pv: Vec<u8> = Vec::with_capacity(32 + pvs_bits.len());
    pv.extend_from_slice(b"VBPV");
    pv.extend_from_slice(&1u32.to_le_bytes());
    pv.extend_from_slice(&md5_bytes);
    pv.extend_from_slice(&cluster_count.to_le_bytes());
    pv.extend_from_slice(&(bytes_per_row as u32).to_le_bytes());
    pv.extend_from_slice(&pvs_bits);

    // ---- 组装返回对象 ----
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("visleaf_bin"),
        &js_sys::Uint8Array::from(&vl[..]),
    )
    .map_err(|e| to_js_err(e, "设置 visleaf_bin 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("pvs_bin"),
        &js_sys::Uint8Array::from(&pv[..]),
    )
    .map_err(|e| to_js_err(e, "设置 pvs_bin 失败"))?;
    js_sys::Reflect::set(&obj, &JsValue::from_str("md5Hex"), &JsValue::from_str(&md5_hex))
        .map_err(|e| to_js_err(e, "设置 md5Hex 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("clusterCount"),
        &JsValue::from_f64(cluster_count as f64),
    )
    .map_err(|e| to_js_err(e, "设置 clusterCount 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("leafCount"),
        &JsValue::from_f64(leaves.len() as f64),
    )
    .map_err(|e| to_js_err(e, "设置 leafCount 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("nodeCount"),
        &JsValue::from_f64(nodes.len() as f64),
    )
    .map_err(|e| to_js_err(e, "设置 nodeCount 失败"))?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("faceCount"),
        &JsValue::from_f64(face_clusters.len() as f64),
    )
    .map_err(|e| to_js_err(e, "设置 faceCount 失败"))?;

    Ok(obj.into())
}

// ---------------------------------------------------------------------------
// VTF 解码
// ---------------------------------------------------------------------------

/// 将 VTF 字节数组解码为 PNG 字节数组。
///
/// 默认解码高分辨率第一帧。
#[wasm_bindgen]
pub fn decode_vtf_to_png(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let vtf = texture_utils::from_bytes(data).map_err(|e| to_js_err(e, "VTF 解析失败"))?;
    let image = vtf
        .highres_image
        .decode(0)
        .map_err(|e| to_js_err(e, "VTF 图像解码失败"))?;

    let mut output: Vec<u8> = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut output), image::ImageFormat::Png)
        .map_err(|e| to_js_err(e, "PNG 编码失败"))?;

    Ok(output)
}

// ---------------------------------------------------------------------------
// 纹理画质切换（mosaic 共享模块：压缩/还原低清纹理）
// ---------------------------------------------------------------------------

/// PNG 字节 → mosaic v4 纹理字节码（压缩）。
#[wasm_bindgen]
pub fn mosaic_encode(png: &[u8], name: &str) -> Result<String, JsValue> {
    websurf_wasm_core::mosaic::encode::img_to_code(png, name)
        .map_err(|e| JsValue::from_str(&format!("mosaic_encode: {e}")))
}

/// mosaic v4 字节码 → PNG 字节（低清还原，最近邻放大 ×scale，默认 ×8）。
#[wasm_bindgen]
pub fn mosaic_decode(code: &str, scale: u32) -> Result<Vec<u8>, JsValue> {
    websurf_wasm_core::mosaic::decode::code_to_img(code, scale)
        .map_err(|e| JsValue::from_str(&format!("mosaic_decode: {e}")))
}

/// 解压默认配置纹理包（textures.mtz，MTZ5 容器）→ textures.json 文本。
/// 纹理键 = `materials/xxx`（与 basetexture 一致），供缺失纹理比对。
#[wasm_bindgen]
pub fn decompress_mtz(bytes: &[u8]) -> Result<String, JsValue> {
    websurf_wasm_core::mosaic::mtz::decompress_mtz(bytes)
        .map_err(|e| JsValue::from_str(&format!("decompress_mtz: {e}")))
}

// ---------------------------------------------------------------------------
// 初始化入口
// ---------------------------------------------------------------------------

/// 模块初始化：安装 panic hook，便于调试。
#[wasm_bindgen(start)]
pub fn start() {
    #[cfg(target_arch = "wasm32")]
    init_panic_hook();
}

// ---------------------------------------------------------------------------
// `.phy` 凸体补面导出（debug 第六路线框的数据源）
// ---------------------------------------------------------------------------

/// `export_model_phy_colliders` 输出的一项；本模块只读这三个字段。
#[derive(serde::Deserialize)]
struct PhyColliderMesh {
    name: String,
    vertices: Vec<[f32; 3]>,
    indices: Vec<[u32; 3]>,
}

/// 顶点连通分量（并查集）：把「一只模型的全部凸体块拼成一个 mesh」按三角形连接性拆回块。
///
/// 导出时每块凸体占一段**连续**顶点区间（`base = local.len()` 之后整段拷入），三角形不跨块，
/// 故连通分量与解析期的凸体块一一对应。
fn vertex_components(vertex_count: usize, tris: &[[u32; 3]]) -> Vec<Vec<u32>> {
    let mut parent: Vec<u32> = (0..vertex_count as u32).collect();
    fn find(parent: &mut [u32], mut x: u32) -> u32 {
        while parent[x as usize] != x {
            let gp = parent[parent[x as usize] as usize];
            parent[x as usize] = gp;
            x = gp;
        }
        x
    }
    for t in tris {
        let a = find(&mut parent, t[0]);
        for o in [t[1], t[2]] {
            let r = find(&mut parent, o);
            if r != a {
                parent[r as usize] = a;
            }
        }
    }
    let mut groups: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for i in 0..vertex_count as u32 {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }
    groups.into_values().collect()
}

/// `.phy` 凸体块的**生成补面**（`websurf_phys::phys::hull_bevels` = VBSP `AddBrushBevels` 的移植），
/// 供 debug 第六路线框显示。
///
/// 为什么在这里拆块：`export_model_phy_colliders` 把一只模型的**全部凸体块拼进一个 mesh**
/// （`base = local.len()` 累加），而补面判据「凸体全部顶点在面内侧」只在**单块凸体**上成立 ——
/// 多块并集不是凸集，判据必然失败（`surf_666` 实测：459 个导出网格里 329 个的并集非凸，
/// `s1_ramp1b` 11 块、并集越界 781.7 HU）。本导出复用那份 JSON、按连通分量拆回块，再逐块生成。
///
/// 输出 JSON：每个放置实例的**每一块**一个条目
/// `{ "name", "min", "max", "box", "edge", "rejected", "planes": [[nx, ny, nz, d], ...] }`。
/// `planes` **只含生成的 bevel**（`box` / `edge` 两类），面平面由 `.phy` 三角形线框那条路显示，
/// 不在这里重复；生成数为 0 的块不入结果。两个上限只是防爆量，正常地图远达不到。
#[wasm_bindgen]
impl BspProcessor {
    pub fn export_model_phy_bevels(&self) -> Result<String, JsValue> {
            const MAX_PIECES: usize = 40_000;
            const MAX_PLANES: usize = 80_000;
            let json = self.export_model_phy_colliders()?;
        let meshes: Vec<PhyColliderMesh> =
            serde_json::from_str(&json).map_err(|e| to_js_err(e, "解析 .phy 碰撞 JSON"))?;
        let mut out: Vec<serde_json::Value> = Vec::new();
        let mut planes_total = 0usize;
        for mesh in &meshes {
            if out.len() >= MAX_PIECES || planes_total >= MAX_PLANES {
                break;
            }
            for ids in vertex_components(mesh.vertices.len(), &mesh.indices) {
                if ids.len() < 4 {
                    continue;
                }
                let mut remap: Vec<u32> = vec![u32::MAX; mesh.vertices.len()];
                let mut verts: Vec<[f64; 3]> = Vec::with_capacity(ids.len());
                for &i in &ids {
                    remap[i as usize] = verts.len() as u32;
                    let v = mesh.vertices[i as usize];
                    verts.push([v[0] as f64, v[1] as f64, v[2] as f64]);
                }
                let tris: Vec<[u32; 3]> = mesh
                    .indices
                    .iter()
                    .filter(|t| remap[t[0] as usize] != u32::MAX)
                    .map(|t| {
                        [
                            remap[t[0] as usize],
                            remap[t[1] as usize],
                            remap[t[2] as usize],
                        ]
                    })
                    .collect();
                if tris.is_empty() {
                    continue;
                }
                let bevels = websurf_phys::phys::hull_bevels::hull_bevels(&verts, &tris);
                if bevels.box_added + bevels.edge_added == 0 {
                    continue;
                }
                let mut min = [f64::INFINITY; 3];
                let mut max = [f64::NEG_INFINITY; 3];
                for v in &verts {
                    for i in 0..3 {
                        if v[i] < min[i] {
                            min[i] = v[i];
                        }
                        if v[i] > max[i] {
                            max[i] = v[i];
                        }
                    }
                }
                let generated: Vec<[f64; 11]> = bevels
                    .added
                    .iter()
                    .map(|b| {
                        // 11 个数：平面 [nx,ny,nz,d] + 类别（0=box / 1=edge）+ 来源边两端点
                        // [ax,ay,az,bx,by,bz]（box bevel 没有来源边，写 0）。
                        let (kind, a, b2) = match (b.kind, b.edge) {
                            (websurf_phys::phys::hull_bevels::BevelKind::Edge, Some([a, b2])) => {
                                (1.0, a, b2)
                            }
                            _ => (0.0, [0.0; 3], [0.0; 3]),
                        };
                        [
                            b.plane.normal[0],
                            b.plane.normal[1],
                            b.plane.normal[2],
                            b.plane.dist,
                            kind,
                            a[0],
                            a[1],
                            a[2],
                            b2[0],
                            b2[1],
                            b2[2],
                        ]
                    })
                    .collect();
                planes_total += generated.len();
                out.push(serde_json::json!({
                    "name": mesh.name,
                    "min": min,
                    "max": max,
                    "box": bevels.box_added,
                    "edge": bevels.edge_added,
                    "rejected": bevels.rejected_edge_candidates,
                    "planes": generated,
                }));
            }
        }
        serde_json::to_string(&out).map_err(|e| to_js_err(e, "序列化 .phy 补面失败"))
    }
}


/// 探查：位移顶点 `alpha`（Source `CDispVert.m_flAlpha`）分布 —— `WorldVertexTransition`
/// 的两贴图混合权重。返回分桶直方图，用于验证「雪/岩混合」是否有可用数据。
#[wasm_bindgen]
pub fn disp_vertex_alpha_stats(data: &[u8]) -> Result<String, JsValue> {
    let bsp = vbsp::Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;
    let verts = &bsp.displacement_vertices;
    let mut buckets = [0usize; 10];
    let mut zeros = 0usize;
    let mut ones = 0usize;
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    let mut sum = 0f64;
    for v in verts.iter() {
        let a = v.alpha;
        sum += f64::from(a);
        min = min.min(a);
        max = max.max(a);
        if a <= 0.0 {
            zeros += 1;
        }
        if a >= 1.0 {
            ones += 1;
        }
        let idx = ((a.clamp(0.0, 0.999) * 10.0) as usize).min(9);
        buckets[idx] += 1;
    }
    let n = verts.len().max(1) as f64;
    Ok(format!("{{\"count\":{},\"zeros\":{},\"ones\":{},\"min\":{:.3},\"max\":{:.3},\"mean\":{:.3},\"buckets\":{:?}}}",
        verts.len(), zeros, ones, if verts.is_empty() { 0.0 } else { min }, if verts.is_empty() { 0.0 } else { max }, sum / n, buckets))
}


/// 置换面（displacement）的**碰撞三角形汤**（世界坐标，Y-up），供物理侧建洞穴壁/地形碰撞。
///
/// 为什么需要单独一条：笔刷碰撞走平面凸包（`export_brushes_planes`），而置换面把可见表面从基础
/// 笔刷平面**推出去**了——只拿基础平面做碰撞，玩家撞到的是藏在可见面后面那层旧平面，看得见的
/// 洞穴壁反而没有碰撞。Source 对置换面的做法就是**按置换面自身的三角形**烘碰撞（VBSP 的 disp
/// coll），这里与渲染端共用同一条细分+位移路径（`Handle::triangulated_displaced_vertices`），
/// 保证"看到的"与"撞到的"是同一张面。
///
/// 返回 JSON：`[[x,y,z], ...]`，每 3 个顶点一个三角形（与 `triangulated_displaced_vertices`
/// 同序）；坐标已按 `map_coords` 转成与其它碰撞体一致的 Y-up 世界坐标。
#[wasm_bindgen]
pub fn export_displacement_colliders(data: &[u8]) -> Result<String, JsValue> {
    let bsp = vbsp::Bsp::read(data).map_err(|e| to_js_err(e, "BSP 解析失败"))?;
    let mut out: Vec<[f32; 3]> = Vec::new();
    for i in 0..bsp.displacements.len() {
        let Some(disp) = bsp.displacement(i) else {
            continue;
        };
        for v in disp.triangulated_displaced_vertices() {
            out.push(websurf_wasm_core::model_integrator::map_coords([
                v.x, v.y, v.z,
            ]));
        }
    }
    serde_json::to_string(&out).map_err(|e| to_js_err(e, "序列化置换面碰撞失败"))
}
