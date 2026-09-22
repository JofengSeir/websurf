//! 模型整合器：把内存中的 `.mdl` / `.vvd` / `.dx90.vtx` 字节合并进地图 GLB。
//!
//! ## 在主流程中的位置
//!
//! 上游（都由所在工程的 wasm 导出层组装成 [`InMemoryResources`]）：
//! - `crate::pakfile_models`：VMT → 透明度档位与 `unlit` 标注（`resolve_pakfile_materials`），
//!   以及模型三件套在 pakfile 内的原始字节（`collect_pakfile_models`）；
//! - `crate::vhv`：`sp_<idx>.vhv` / `sp_hdr_<idx>.vhv` → 逐顶点烘焙光照（`parse_vhv`）；
//! - `crate::vbsp`：静态道具放置表与逐 prop 的 leaf ambient cube（`Bsp::prop_ambient_cube`）。
//!
//! 下游是 `src/wasm-core/bsp_to_gltf_core/convert.rs` 的 `export_bsp_with_models`：它先把 BSP 几何
//! 写进同一个 `Root` 与同一个 bin `Vec<u8>`，再调 [`ModelIntegrator::add_models_to_gltf`] 追加模型，
//! 序列化成 JSON 字符串后调 [`ModelIntegrator::add_lighting_to_gltf_json`] 注入光照。
//! 放置表另有一条消费路径：碰撞/三角导出直接调 [`resolve_placements`] 与 [`map_coords`]，
//! 与 GLB 节点共用同一份变换（`apps/game/crates/wasm/src/lib.rs` 与
//! `apps/debug/crates/wasm/src/lib.rs` 的 `export_model_tri_colliders`）。
//!
//! ## 职责
//!
//! - 顶点：VVD 顶点 → 交错 [`ModelVertex`] 写进调用方的 `buffer`，并登记 buffer view / accessor；
//! - 图元：每个 `vmdl::Mesh` 一个 primitive，索引统一 u32；
//! - 材质与贴图：按名去重后建 `gltf.materials` / `images` / `textures`；
//! - 放置：解析 static prop / entity 的 origin、angles、scale，产出 [`Placement`]，逐实例建节点；
//! - 光照：逐实例 vhv → 自定义属性 `_VBSP_VLIGHT`；light 实体 → `KHR_lights_punctual`。
//!
//! ## 关键不变量
//!
//! - **顶点布局是交错的**：[`ModelVertex`] 为 `#[repr(C)]` 的 position(3×f32) + uv(2×f32)
//!   + normal(3×f32)，共 **32** 字节；一个 buffer view 承载三个属性，`byteStride = 32`，
//!   `POSITION` / `TEXCOORD_0` / `NORMAL` 的 `byteOffset` 依次为 **0 / 12 / 20**。
//!   逐顶点光照相反：**独立** buffer view、紧凑 f32×3、`byteStride = 12`。
//! - **坐标**：[`map_coords`] 做 `[x, y, z] → [y, z, x]`，即 `X_gltf = Y_src`、`Y_gltf = Z_src`、
//!   `Z_gltf = X_src`（Source Z-up → glTF Y-up）。顶点位置、包围盒、光照方向、origin 走它；
//!   `ModelVertex::from` 里的**法线不走**，原样取 VVD 的 `normal`。
//! - **buffer 归属**：所有 buffer view 都写 `buffer: 0`，`byte_offset` 取调用时刻 `buffer.len()`；
//!   本模块不建 `Root.buffers`，由 `export_bsp_with_models` 在合并完成后补 `byte_length`。
//!   本模块追加的顶点 / VLIGHT / 索引三段长度都是 4 的倍数，贴图段不补齐（见 `push_texture_data`）。
//! - **去重缓存**：键只有纹理名与 `材质名|alpha档|unlit`，不含 `Root` 身份 ⇒ 一个整合器只服务于
//!   一次导出；三工程的装配点都是 `from_in_memory` 之后立刻导出。
//!
//! ## 边界
//!
//! 只写 glTF JSON 结构与 bin 字节。不做物理、不读文件系统、不解码图片（贴图按 PNG 原样搬运）、
//! 不做模型动画/骨骼蒙皮（只取 LOD0 几何）。**本文件没有 `#[test]`，也没有 `static_assertions`
//! 断言**；行为验证在三工程的导出链路上进行。

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

/// 模型整合错误。
///
/// 四个变体的实际来源：[`ModelIntegratorError::Model`] 由 `load_model_from_bytes` 的三次解析
/// （`Mdl::read` / `Vvd::read` / `Vtx::read`）产生，在 `add_models_to_gltf` 里被**捕获并只跳过该模型**；
/// [`ModelIntegratorError::Json`] 由 `add_lighting_to_json` 的 `serde_json::from_str` / `to_string` 产生；
/// [`ModelIntegratorError::UnsupportedModelFormat`] 只在 `push_model` 取不到皮肤表时构造。
/// `Gltf` 变体由 `#[from]` 生成，本 crate 内没有构造点。
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

/// 导出模型选项。
///
/// `#[derive(Default)]` ⇒ `include_lights` 默认 `false`：不建光照节点，也不注入扩展。
/// 三工程的装配点中，需要光照的路径显式写 `ExportOptions { include_lights }`
/// （`apps/game/crates/wasm/src/lib.rs` 的 `export_glb_with_defaults_opts`），其余用 `ExportOptions::default()`。
#[derive(Debug, Default)]
pub struct ExportOptions {
    /// 是否把 light 实体写成 `KHR_lights_punctual` 扩展。
    ///
    /// 开与关影响两处：`add_models_to_gltf` 里是否调 `process_lights` 建节点，
    /// 以及 `add_lighting_to_gltf_json` 是否注入光源定义（关掉时原样返回输入字符串）。
    pub include_lights: bool,
}

/// 内存中的单个模型三件套：`.mdl` / `.vvd` / `.dx90.vtx` 的**原文整文件字节**。
///
/// 三个字段分别交给 `Mdl::read` / `Vvd::read` / `Vtx::read` 解析；本结构不校验三者是否同源。
#[derive(Debug, Clone, Deserialize)]
pub struct InMemoryModel {
    /// pakfile 内的模型路径（如 `models/props/crate.mdl`）。
    ///
    /// 同时供三处使用：`resolve_placements` 的匹配键、mesh 名（`file_stem`）、节点名（`file_name`）。
    /// 与静态道具字典里的 `model` 不同源时三级匹配全部落空 ⇒ 该模型静默不导出。
    pub name: String,
    /// `.mdl` 字节（骨架、包围盒、纹理名表、皮肤表的来源）。
    pub mdl: Vec<u8>,
    /// `.vvd` 字节（顶点位置 / 法线 / UV 的来源）。
    pub vvd: Vec<u8>,
    /// `.dx90.vtx` 字节（三角形条带索引的来源）。
    pub vtx: Vec<u8>,
}

/// 一次导出所需的全部内存资源；由所在工程的 wasm 导出层组装，本模块只读。
///
/// 各字段对应本模块的输入：模型三件套、静态道具放置表、实体、贴图字节、光照实体，
/// 以及两张按材质名索引的标注表。`entities` 在三个工程的全部装配点都传空
/// （`apps/game/crates/wasm/src/lib.rs` 的 `export_glb_with_defaults_opts`），因此 `resolve_placements` 的实体支路当前没有调用者。
#[derive(Debug, Clone, Default)]
pub struct InMemoryResources {
    /// 待合并的模型三件套；解析失败或没有任何放置实例的会被跳过。
    pub models: Vec<InMemoryModel>,
    /// 实体来源的放置（`prop_dynamic` 等）；装配点当前全部传空。
    pub entities: Vec<Entity>,
    /// 静态道具放置表；与碰撞 / 三角导出共用（`apps/debug/crates/wasm/src/lib.rs` 的 `export_model_tri_colliders`）。
    pub static_props: Vec<StaticProp>,
    /// `纹理名 → PNG 字节`。键要与 `vmdl::TextureInfo::name` 逐字符一致；
    /// 查表先试原名、再试 `{名}.png`（见 `push_texture`）。
    pub textures: HashMap<String, Vec<u8>>,
    /// light / light_spot / light_environment 实体的属性子集；仅 `include_lights` 为真时被读。
    pub light_entities: Vec<Entity>,
    /// 材质名 → 透明度档位：`1` ⇒ Blend（且双面），`2` ⇒ Mask（`alphaCutoff = 0.5`，单面），
    /// 其余（含缺键）⇒ Opaque。取值由 `pakfile_models::parse_vmt` 的优先级给出：
    /// `$translucent` 或 `$alpha < 0.999` ⇒ 1，否则 `$alphatest` ⇒ 2，否则 0。
    /// 碰撞 / 三角导出用的是**另一次**同名解析（`apps/game/crates/wasm/src/lib.rs` 的
    /// `export_model_tri_colliders`），不读本字段。
    pub material_alpha_mode: HashMap<String, u8>,
    /// 自发光 / 无光照材质名集合。命中时 `push_material` 往 material `extras` 写 `unlit`，
    /// 渲染侧读 `material.userData.unlit` 走**全亮**（不吃 lightmap / ambient cube）
    /// （`apps/game/src/renderer/lightmap-shader.ts` 的 `routeFullbright`）。
    /// 来源是 `pakfile_models::parse_vmt`：着色器名以 `unlit` 开头，或 `$selfillum` 取非 `0` 的非空值。
    pub material_unlit: std::collections::HashSet<String>,
}

/// 模型整合器：一次导出期间持有内存资源与两张去重缓存。
///
/// 对外只暴露 `&self` 方法，两张缓存因此用 `RefCell` 包着（导出期间单线程访问）。
/// 本结构不拥有 GLB：`Root` 与 bin `Vec<u8>` 都由调用方按 `&mut` 传入。
pub struct ModelIntegrator {
    /// 只读资源集合，`from_in_memory` 之后不再变更。
    in_memory: InMemoryResources,
    /// 导出开关，构造后不变。
    options: ExportOptions,
    /// 贴图去重：纹理名 → `gltf.textures` 索引。
    ///
    /// 同一模型会被推**多次**（逐实例 vhv 不同 ⇒ 逐组一个 mesh，见
    /// `group_placements_by_vertex_lighting`）；没有这层缓存时每个 mesh 都会把同一份 PNG
    /// 再追加一遍 bin，并新建 image / texture。键是 `push_texture` 传入的纹理名，
    /// 原名与 `{名}.png` 两条查表路径共用同一个键。
    texture_cache: std::cell::RefCell<HashMap<String, u32>>,
    /// 材质去重：`材质名|alpha档|unlit` → `gltf.materials` 索引（重复推送的理由同上）。
    /// 键覆盖全部会改变材质产物的输入，三者的取值都在 `push_material` 里参与构造。
    material_cache: std::cell::RefCell<HashMap<String, u32>>,
}

impl ModelIntegrator {
    /// 用内存资源创建整合器（本 crate 唯一的构造路径）。
    ///
    /// `resources` 整体移入且之后不再变更；两张去重缓存初始为空。
    /// 调用方须在调用前备齐模型三件套、贴图 PNG、静态道具放置表 —— 本模块不读文件系统，
    /// 也不加工 `static_props`（位置 / 朝向 / 逐顶点光照全部取自该表）。
    pub fn from_in_memory(resources: InMemoryResources, options: ExportOptions) -> Self {
        Self {
            in_memory: resources,
            options,
            texture_cache: std::cell::RefCell::new(HashMap::new()),
            material_cache: std::cell::RefCell::new(HashMap::new()),
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

            // 推送模型几何。**按"逐顶点光照"分组**：同一模型的多个实例各有自己的
            // `sp_<idx>.vhv`（prop_static 的逐顶点烘焙），必须各自成一个 mesh，
            // 否则共用网格就只能各自带 cube（第 2 级）—— 那正是"一面一个颜色"的成因。
            let groups = group_placements_by_vertex_lighting(&placements, model.vertices().len());

            for (vlight, idxs) in &groups {
                let mesh = self.push_model(
                    buffer,
                    gltf,
                    &model,
                    Path::new(&in_mem.name),
                    vlight.as_deref(),
                )?;
                let mesh_index = gltf.meshes.len() as u32;
                gltf.meshes.push(mesh);

                for (seq, &pi) in idxs.iter().enumerate() {
                    let p = &placements[pi];
                    let mut extras = serde_json::Map::new();
                    if let Some(c) = p.ambient_cube {
                        extras.insert("ambientCube".into(), serde_json::json!(c));
                    }
                    if vlight.is_some() {
                        // 第 1 级（逐顶点烘焙）已接线 ⇒ 渲染端优先用它，不再叠 cube
                        extras.insert("vertexLighting".into(), serde_json::json!(true));
                    }
                    let node = Node {
                        camera: None,
                        children: None,
                        extensions: Default::default(),
                        matrix: None,
                        mesh: Some(Index::new(mesh_index)),
                        extras: serde_json::value::RawValue::from_string(
                            serde_json::json!(extras).to_string(),
                        )
                        .ok(),
                        name: Some(if pi == 0 {
                            model_filename.clone()
                        } else {
                            format!("{model_filename}#{pi}")
                        }),
                        rotation: p.rotation.map(UnitQuaternion),
                        scale: p.scale,
                        translation: Some(p.translation),
                        skin: None,
                        weights: None,
                    };
                    gltf.nodes.push(node);
                    let _ = seq;
                }
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
    fn push_model(
        &self,
        buffer: &mut Vec<u8>,
        gltf: &mut Root,
        model: &VmdlModel,
        model_path: &Path,
        vlight: Option<&[[f32; 3]]>,
    ) -> Result<json::Mesh, ModelIntegratorError> {
        let accessor_start = gltf.accessors.len() as u32;
        let vlight_accessor = self.push_vertices(buffer, gltf, model, vlight);

        // 获取第一个皮肤表
        let skin_table = model.skin_tables().next().ok_or(ModelIntegratorError::UnsupportedModelFormat("No skin table found".into()))?;

        let mut primitives = Vec::new();
        for mesh in model.meshes() {
            primitives.push(self.push_primitive(
                buffer,
                gltf,
                &mesh,
                accessor_start,
                &skin_table,
                vlight_accessor,
            )?);
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
    ///
    /// `vlight`：逐顶点预烘焙光照（屏幕倍率，长度必须 = 模型顶点数）。给了就额外推
    /// 一个 `_VBSP_VLIGHT`（VEC3 f32）属性 —— 渲染端据此走第 1 级路径。
    fn push_vertices(
        &self,
        buffer: &mut Vec<u8>,
        gltf: &mut Root,
        model: &VmdlModel,
        vlight: Option<&[[f32; 3]]>,
    ) -> Option<u32> {
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

        // ── 第 1 级：逐顶点预烘焙光照（`_VBSP_VLIGHT`）─────────────────────────
        // 独立 buffer view（紧凑 f32×3），**不塞进 interleaved 的 ModelVertex**：
        //   ① 只有 prop 需要它，world 面不付代价；② 改 ModelVertex 会动到所有导出路径。
        // 长度必须等于模型顶点数；不等 ⇒ 报错返回 None（调用方回退 cube 路径，不静默错位）。
        let vlight = vlight.filter(|v| v.len() == vertex_count as usize)?;
        let vl_start = buffer.len() as u64;
        for c in vlight {
            for f in c {
                buffer.extend_from_slice(&f.to_le_bytes());
            }
        }
        let vl_view = json::buffer::View {
            buffer: Index::new(0),
            byte_length: USize64(buffer.len() as u64 - vl_start),
            byte_offset: Some(USize64(vl_start)),
            byte_stride: Some(json::buffer::Stride(12)),
            extensions: Default::default(),
            extras: Default::default(),
            name: Some("VBSP_VLIGHT".into()),
            target: Some(json::validation::Checked::Valid(json::buffer::Target::ArrayBuffer)),
        };
        gltf.buffer_views.push(vl_view);
        let vl_accessor = json::Accessor {
            buffer_view: Some(Index::new(gltf.buffer_views.len() as u32 - 1)),
            byte_offset: Some(USize64(0)),
            count: USize64(vertex_count),
            component_type: json::validation::Checked::Valid(json::accessor::GenericComponentType(
                json::accessor::ComponentType::F32,
            )),
            extensions: Default::default(),
            extras: Default::default(),
            type_: json::validation::Checked::Valid(json::accessor::Type::Vec3),
            min: None,
            max: None,
            name: Some("VBSP_VLIGHT".into()),
            normalized: false,
            sparse: None,
        };
        let vl_index = gltf.accessors.len() as u32;
        gltf.accessors.push(vl_accessor);
        Some(vl_index)
    }

    /// 推送图元到 GLTF
    fn push_primitive(
        &self,
        buffer: &mut Vec<u8>,
        gltf: &mut Root,
        mesh: &vmdl::Mesh,
        vertex_accessor_start: u32,
        skin: &vmdl::SkinTable,
        vlight_accessor: Option<u32>,
    ) -> Result<json::mesh::Primitive, ModelIntegratorError> {
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
                // 自定义语义：gltf-json 的 `Semantic::Extras` 会**自动补一个前导 `_`**
                // （glTF 规定自定义属性名须以 `_` 开头）⇒ 这里传 `VBSP_VLIGHT`，
                // 落盘/上线后的名字是 `_VBSP_VLIGHT`（实测传 "_VBSP_VLIGHT" 会变成双下划线）。
                if let Some(vl) = vlight_accessor {
                    map.insert(
                        json::validation::Checked::Valid(
                            json::mesh::Semantic::Extras("VBSP_VLIGHT".into()),
                        ),
                        Index::new(vl),
                    );
                }
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

            // ── 材质去重 ──────────────────────────────────────────────────────
            // 为什么会重复：同一模型会被推**多次**（逐实例 vhv 不同 ⇒ 逐组一个 mesh，
            // 见 `group_placements_by_vertex_lighting`）。没有这层缓存时，材质/贴图会被
            // 逐次重推 —— 实测 surf_666：materials 319→1112、images 200→738、bin 140→494 MB。
            // 键覆盖一切会改变材质产物的输入：材质名 + alpha 模式 + unlit 标注。
            let unlit = self.in_memory.material_unlit.contains(&material_name);
            let alpha_key = self
                .in_memory
                .material_alpha_mode
                .get(&material_name)
                .copied()
                .unwrap_or(0u8);
            let cache_key = format!("{material_name}|{alpha_key}|{unlit}");
            if let Some(&idx) = self.material_cache.borrow().get(&cache_key) {
                return Some(Index::new(idx));
            }

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

            // 自发光 / 无光照标注：写进 extras（GLTFLoader → material.userData.unlit）
            // `json::Extras` = `Option<Box<RawValue>>` ⇒ 直接给原始 JSON 文本
            let mut extras = json::Extras::default();
            if self.in_memory.material_unlit.contains(&material_name) {
                if let Ok(raw) = serde_json::value::RawValue::from_string("{\"unlit\":true}".to_string()) {
                    extras = Some(raw);
                }
            }
            // 创建材质
            let material = gltf::json::Material {
                extensions: Default::default(),
                extras,
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
            self.material_cache.borrow_mut().insert(cache_key, index);
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

    /// 将已获取的纹理字节推入 GLTF缓冲区
    fn push_texture_data(&self, buffer: &mut Vec<u8>, gltf: &mut Root, texture_name: &str, texture_data: &[u8]) -> Option<u32> {
        // 贴图去重（同 `push_material` 的理由：同一模型会被推多次）
        if let Some(&idx) = self.texture_cache.borrow().get(texture_name) {
            return Some(idx);
        }
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

        self.texture_cache
            .borrow_mut()
            .insert(texture_name.to_string(), texture_index);
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
    /// 该 prop 采样点的 6 面 ambient cube（线性 RGB，face 序 [+X,-X,+Y,-Y,+Z,-Z]）；
    /// None = 无 ambient 数据（渲染端按中性灰兜底）。见 `vbsp::Bsp::prop_ambient_cube`。
    pub ambient_cube: Option<[f32; 18]>,
    /// **逐顶点预烘焙光照**（第 1 级来源）：来自 pakfile 的 `sp_<idx>.vhv` / `sp_hdr_<idx>.vhv`，
    /// 逐顶点 RGB **屏幕倍率**（`byte × 2/255`，值域 [0,2]），长度 = 模型顶点数。
    /// `None` = 该 prop 没有 vhv（回退第 2 级 leaf ambient cube）。见 `crate::vhv`。
    #[serde(default)]
    pub vertex_lighting: Option<Vec<[f32; 3]>>,
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
    /// 该实例的 6 面 ambient cube（线性 RGB）；实体来源或无数据时为 `None`。
    pub ambient_cube: Option<[f32; 18]>,
    /// 该实例的**逐顶点预烘焙光照**（屏幕倍率，长度 = 模型顶点数）；无 vhv 时为 `None`。
    /// 同一模型的多个实例各有自己的 vhv ⇒ 网格按它分组（见 `integrate`）。
    pub vertex_lighting: Option<Vec<[f32; 3]>>,
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
        ambient_cube: prop.ambient_cube,
        vertex_lighting: prop.vertex_lighting.clone(),
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
            ambient_cube: None,
            // 实体来源（prop_dynamic 等）没有 sp_*.vhv（那是 prop_static 的烘焙产物）
            vertex_lighting: None,
        });
    }
    out
}

/// 把某个模型的放置实例按**逐顶点光照数据**分组。
///
/// 返回 `[(vlight, [placement 索引…]), …]`：
/// - 有 vhv 且长度 = 模型顶点数 ⇒ 各自成一组（内容相同的实例合并，避免重复上传顶点）；
/// - 无 vhv / 长度不符 ⇒ 全部归入 `None` 组（渲染端回退第 2 级 leaf ambient cube）。
///
/// 为什么必须分组：顶点属性挂在 **mesh** 上，而 vhv 是**逐实例**的（`sp_<propIndex>.vhv`）。
/// 一个模型被多个 prop_static 引用时，若共用 mesh 就只能都走 cube ⇒ 每个朝向面一个平坦色，
/// 实机观感即「一面一个颜色」。
pub fn group_placements_by_vertex_lighting(
    placements: &[Placement],
    vertex_count: usize,
) -> Vec<(Option<Vec<[f32; 3]>>, Vec<usize>)> {
    let mut groups: Vec<(Option<Vec<[f32; 3]>>, Vec<usize>)> = Vec::new();
    for (i, p) in placements.iter().enumerate() {
        let vl = p
            .vertex_lighting
            .as_ref()
            .filter(|v| v.len() == vertex_count);
        match vl {
            Some(v) => {
                match groups
                    .iter_mut()
                    .find(|(g, _)| g.as_ref().is_some_and(|gv| gv == v))
                {
                    Some((_, idxs)) => idxs.push(i),
                    None => groups.push((Some(v.clone()), vec![i])),
                }
            }
            None => match groups.iter_mut().find(|(g, _)| g.is_none()) {
                Some((_, idxs)) => idxs.push(i),
                None => groups.push((None, vec![i])),
            },
        }
    }
    groups
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
