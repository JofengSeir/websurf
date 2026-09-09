# 共享层②：websurf-wasm-core（BSP 解析 / GLB 导出共享核心）

> 定位：把 Source 引擎 BSP 字节变成浏览器可用的三样东西——**GLB 场景**（含 PAKFILE 内嵌模型与材质）、
> **物理碰撞数据**（brush/模型三角形/.phy 凸包 JSON，喂给 [phys.md](./phys.md)）、**辅助数据**（出生点/传送点/PVS/mosaic 纹理包）。
> 纯 rlib，**不含 wasm-bindgen 导出**——导出层在各工程 cdylib（见 §4）。
> 本文所有论断均标注来源（`相对路径:行号` 或 `路径::函数名`），写作基线为当前工作区代码。

---

## 1. 整体架构

### 1.1 crate 身份与依赖

| 项 | 值 | 来源 |
|---|---|---|
| 包名/形态 | `websurf-wasm-core 0.1.0`，rlib，**不含 wasm-bindgen 导出**（由各工程 cdylib 提供） | `src/wasm-core/Cargo.toml:1-18`、`src/wasm-core/lib.rs:6` |
| 解析依赖 | `vmdl 0.2`（path patch 到 `src/vendor/vmdl`，VTX 修复）、`vtf 0.3`、`vmt-parser 0.2`、`tf-asset-loader 0.1.7`（zip）、`binrw`、`lzma-rs`、`gltf 1.4.1`（+ gltf-json，启用 `KHR_texture_transform`/`extras`）、`cgmath`、`bytemuck` | `src/wasm-core/Cargo.toml:19-70`、根 `Cargo.toml:27-28` `[patch.crates-io]`（vendor 缘由说明 `:13-18`） |
| 图像依赖（WASM 特化） | `image` 仅开 `png` feature；`texpresso 2.0.2`（BC1/2/3 解压）；`ahash` 用 `compile-time-rng`；`getrandom` 走 `js`/`wasm_js`；`path-dedot` 走 unix-on-wasm | `src/wasm-core/Cargo.toml:19-70` feature 段 |
| vendored vmdl | crates.io vmdl 0.2.0 vendor + VTX 三角形条带展开修复——**全仓唯一被 patch 的 crates-io crate（vmdl）**；根与各模块 workspace 各自声明同款（见根 `Cargo.toml:17-18` 注释、:27-28 声明） | `Cargo.toml:13-18`（缘由注释）、`Cargo.toml:27-28`（`[patch.crates-io]`）、`src/vendor/vmdl/` |

### 1.2 模块地图（`src/wasm-core/lib.rs:15-21` 七个 `pub mod`）

| 模块 | 关键文件 | 职责（一句话） |
|---|---|---|
| `vbsp` | `vbsp/mod.rs`(622)、`bspfile.rs`(142)、`reader.rs`(144)、`data/*.rs`、`error.rs`(135)、`handle/mod.rs`(379) | BSP 二进制解析（crates.io vbsp 0.6.0 本地修复版） |
| `bsp_to_gltf_core` | `mod.rs`(151)、`convert.rs`(1045)、`materials.rs`(337)、`gltf_builder.rs`(202) | BSP → GLB（地图几何 + 材质 + 缺失资源清单） |
| `model_integrator` | `model_integrator/mod.rs`(1045) | `.mdl/.vvd/.vtx` 模型合并进 GLB（放置/网格/光照） |
| `pakfile_models` | `pakfile_models.rs`(271) | PAKFILE 模型的 VMT 材质解析 + 碰撞体数据准备 |
| `phyfile` | `phyfile.rs`(305) | `.phy`（vphysics）凸包碰撞解析 |
| `texture_utils` | `vtf.rs`(409)、`image.rs`(179)、`mod.rs`(44) | VTF 解码（textracto BC 解压 → DynamicImage） |
| `mosaic` | `mtz.rs`(910)、`encode.rs`(190)、`decode.rs`(159)、`manifest.rs`(79)、`mod.rs`(10) | 棋盘马赛克纹理字节码（v4 DSL）+ MTZ5/6 压缩容器 |

`lib.rs` 头注（`src/wasm-core/lib.rs:1-14`）明确来源：统一自 debug/ 与 game/ 两工程的 crates/wasm 解析层（game 精简演进版差异已并入）。

### 1.3 被引用关系

| 消费工程 | 引用方式 | 证据 |
|---|---|---|
| debug / game | cdylib `use websurf_wasm_core::{…}` + `BspProcessor` 全导出集 | `debug/crates/wasm/src/lib.rs`、`game/crates/wasm/src/lib.rs` |
| viewer | `use websurf_wasm_core::{bsp_to_gltf_core, model_integrator, pakfile_models, texture_utils, vbsp};`——**不用 phyfile/mosaic**（查看器无碰撞/无画质切换） | `viewer/crates/wasm/src/lib.rs:15-20` |
| test/dual-mode-harness | BspProcessor 物理导出子集（brush/phy/tri/teleport/pvs） | `test/dual-mode-harness/crates/wasm/src/lib.rs` |
| TS 侧消费契约 | `BspProcessorLike` 接口（11 方法）约束导出层 | `src/ts-shared/phys/world-builder.ts:19-31`（见 [ts-shared.md](./ts-shared.md)） |

cargo 依赖声明：各工程 `crates/wasm/Cargo.toml` `websurf-wasm-core = { path = "../../../src/wasm-core" }`。

---

## 2. 核心时序

### 2.1 BSP 字节 → 三条消费流（总览）

```
BSP bytes
  └─ vbsp::Bsp::read (vbsp/mod.rs:204)          ── 一次解析，全部 lump 常驻
       ├─① bsp_to_gltf_core::export_bsp_with_models(bsp, options, Some(&ModelIntegrator))
       │     （convert.rs:98）→ GLB 字节（渲染）
       ├─② BspProcessor 物理导出（各工程 lib.rs）
       │     export_brushes_planes / export_model_tri_colliders / export_model_phy_colliders
       │     → JSON → PhysWorld::build_world（见 phys.md §2.1）
       └─③ 辅助导出：parse_spawn_points / parse_teleports / parse_pvs_data /
             export_mosaic_manifest / export_missing_textures（可选，按工程能力）
```

编排方为 ts-shared `buildWorldBundle`（`src/ts-shared/phys/world-builder.ts:96` 起）：metadata → 出生点/传送点/PVS → 碰撞体（brush + 模型，colliderSource 三档）→ mosaic manifest / 缺失纹理（**必须先于 GLB 导出**，`world-builder.ts:164` 注释）→ 默认纹理包回退 → `export_glb_with_pakfile_models_with_defaults`。完整管线见 [ts-shared.md](./ts-shared.md) §2.2。

### 2.2 GLB 导出内部时序（`bsp_to_gltf_core/convert.rs`）

`export_bsp_with_models`（`convert.rs:98`）：

1. `bsp_models(&bsp)`（`convert.rs` 私有函数）枚举 world model（索引 0）+ brush 实体模型（func_brush 等，按 model index + origin 偏移）；
2. 每个 model → `push_bsp_model_bsp`：逐 face 生成 primitive，顶点布局 `BspVertexData{position,uv}`（Pod，`convert.rs:1042`），坐标 `map_coords`（`[x,y,z]→[y,z,x]`，Z-up→Y-up）；face 索引写入 primitive `extras.faceIndex`（渲染端 PVS 剔除按 face 定位，`convert.rs` face push 处注释）；
3. 材质：`push_or_get_material_bsp`（`gltf_builder.rs:20`）按材质名去重 → `load_material_fallback_bsp`（`materials.rs:106`）失败进 `missing_resources`；
4. `ModelIntegrator::add_models_to_gltf` 合并 PAKFILE 模型节点（§3.3）；
5. 根节点带 **Y 轴 90° 旋转**（`Quaternion::from_angle_y(Deg(90.0))`，`convert.rs:34`）；序列化 + 4 字节对齐 + 组装 `Glb`（`convert.rs:72-85`）；
6. 返回 `ExportResult{glb, missing_resources, textures}`（`mod.rs:57-64`；`textures` 来自 `TextureCollector` 去重收集，`materials.rs:50-68`）。

### 2.3 模型合并时序（`model_integrator`）

`add_models_to_gltf`（`model_integrator/mod.rs:86`）：每个 `InMemoryModel{mdl,vvd,vtx}` → `load_model_from_bytes`（`:180`，vmdl 三件套 `Mdl::read`/`Vvd::read`/`Vtx::read`）→ `resolve_placements`（`:907`，**全部**实例，三级匹配：static_props 完整路径精确 → 文件名包含 → 实体 `model` 属性；修复旧实现只取首个实例导致模型消失的问题，`:898-901` 注释）→ 同一模型多实例**共享同一 mesh**（`:120` 注释），每实例一个 `Node{translation, rotation, scale}`（名称 `model` / `model#i`，`:126-145`）。

---

## 3. 具体实现（分模块）

### 3.1 vbsp —— BSP 解析（crates.io vbsp 0.6.0 本地修复版）

| 修复点 | 说明 | 证据 |
|---|---|---|
| 版本范围 | `VBSP` 头 + version ∈ 19..=29；实证 v20 与 v21 lump 布局一致（2026-08-14，NODES v0/LEAFS v1…），仅需放宽版本检查 | `vbsp/bspfile.rs:20-26` |
| lump 总表 | `LumpType` 枚举 **64 个变体**（`static_assert` 校验 DisplacementMultiBlend=63）；`BspFile::new` 按头偏移切片，LZMA lump 透明解压 | `vbsp/bspfile.rs`（enum + `get_lump`） |
| LZMA | 带 Source 头（`LZMA` magic + 实际大小字段）的解压，预留 8B 填充 | `vbsp/mod.rs:588-595` `lzma_decompress_with_header` |
| Leaves 双序 | `Leaves` 保留**原始索引顺序**（node.children 位翻转索引语义依赖原序），另存 `sorted_leaves` 供 `clusters()` PVS 计算 | `vbsp/mod.rs:26-30`（struct 注释）、`cluster` 相关方法 |
| 自适应 leaf | leaf 记录 32B（老版 v1 布局）vs 56B（标准）按树内最大 leaf 索引启发式选择 | `vbsp/reader.rs` `read_leaves(max_leaf_index)`；调用点 `vbsp/mod.rs:229-240` |
| PVS 读取修复 | `read_visdata` 的 bitofs 相对 lump 起点而非当前位置——解压后需回卷 lump 头再读 | `vbsp/reader.rs` `read_visdata`（seek 回 0） |
| 实体解析 | `read_entities` 全小写化；`Entities::iter` 以 `{...}` 扫描产出零拷贝 `RawEntity` | `vbsp/reader.rs`、`vbsp/data/entity.rs:13-46` |
| 结构体全集 | `data/mod.rs`(1069)：Plane/Node/Leaf/Model/Brush(+`is_visible`)/BrushSide/Face(+displacement_index)/VisData(`visible_clusters` + `decode_pvs_row`)/Packfile(zip，`get/has/into_zip` Mutex 包裹)/Angles/Vector/FixedString；`data/game.rs`(371)：GameLumpHeader::find + static props（sprp）；`data/entity.rs`(915)：实体属性访问 | `vbsp/data/mod.rs:58-760`、`vbsp/data/game.rs:13-40` |
| 错误体系 | `BspError`（thiserror）+ ValidationError/InvalidNeighbourError/EntityParseError | `vbsp/error.rs:1-135` |
| 借用句柄 | `Handle<'a,T>{bsp,data}` 包装 lump 数据与其宿主 Bsp 的借用关系 | `vbsp/handle/mod.rs` |

`Bsp::read`（`vbsp/mod.rs:204`）产出常驻字段：entities/textures_info/planes/nodes/leaves/models/brushes/brush_sides/vertices/edges/surface_edges/faces/original_faces/vis_data/displacements×3/static_props/pack（`vbsp/mod.rs:173-201` struct 定义）。

### 3.2 bsp_to_gltf_core —— GLB 导出

- **选项**：`ConvertOptions{textures, texture_scale, generate_missing_list, missing_fallback}`（`mod.rs:67-105`）；`missing_fallback: HashMap<材质路径小写, "#mosaic v4 字节码">`——材质加载失败（BSP 内无 VMT/VTF）时查表解码低清纹理嵌入 GLB，渲染端零后期处理（`mod.rs:78-82` 注释）；`key()` 为缓存哈希（`mod.rs:87`）。
- **材质加载**（`materials.rs`）：`load_material_bsp`（`:170`）走 BSP `pack`（zip）内 VMT → `$basetexture` → VTF → 解码；候选路径多次尝试（含 `/`→`_` 变体，`materials.rs:186`、`:308`）；`texture_scale≠1` 时 CatmullRom 缩放（`materials.rs:328-333`）。失败 → `MissingResource{type,name,reason,possible_source}`（`materials.rs:84-103`）。
- **材质 → glTF**（`gltf_builder.rs:62` `push_material`）：alpha 三态（`translucent`→Blend、`alpha_test`→Mask+alphaCutoff、否则 Opaque，`gltf_builder.rs:67-71`）；`no_cull`→doubleSided；VMT `TextureTransform` → `KHR_texture_transform` 扩展（rotate 度→弧度，`gltf_builder.rs:73-81`）；纹理 PNG 编码进 bufferView（`image/png`，`gltf_builder.rs:185-193`）。
- **错误类型**：`Error`（miette Diagnostic，聚合 VTF/VDF/gltf-json/ModelIntegrator 错误，`mod.rs:125-151`）。

### 3.3 model_integrator —— 模型与光照

- `InMemoryResources{models, entities, static_props, textures, light_entities, material_alpha_mode}`（`mod.rs:55-64`）——WASM 无文件系统，统一 `from_in_memory`；磁盘模式（new-vbsp CLI 遗留）已清理（`mod.rs:1-4` 头注）。
- 顶点布局 `ModelVertex{position,uv,normal}`（`mod.rs:1024`），`map_coords` 同 §2.2；根变换 `model.apply_root_transform`（应用点 `mod.rs:216-217`）。
- `angles_to_quat`（`mod.rs:890`）：`"pitch yaw roll"` → 四元数，组合序 `yaw·pitch·roll`（与 Source QAngle 语义一致）。
- 光照：`ExportOptions.include_lights`；`add_lighting_to_gltf_json`（`mod.rs:161`）对已序列化 GLB JSON 做**字符串级补丁**注入 `KHR_lights_punctual`（light_spot/light_environment/light 实体，`mod.rs:158-172`）。
- 放置结构 `Placement{translation, rotation, scale, solid}`（`mod.rs:874`）——`solid` 透传 static prop 的 `SolidType`（0=SOLID_NONE 供碰撞门控，见 §3.4）。

### 3.4 pakfile_models —— VMT 解析与碰撞门控

- `parse_vmt`（`pakfile_models.rs:93`）：扁平 KeyValues 扫描（`//` 注释截断 + 引号成对 tokenize，`:56-87`），提取 `$basetexture`（`\`→`/` 归一）、透明度标注、`patch` 材质的 `include` 目标（`VmtInfo`，`:38-50`）。
- **alpha_mode 三态**（`:11-29` 模块头注表）：`$translucent 1`/`$alpha<1` → 1(Blend)；`$alphatest 1` → 2(Mask)；均无 → 0(Opaque)。
- **保守碰撞门控**：仅当模型**所有**材质均 Blend 才判「可穿过」；`$alphatest` 镂空（铁丝网/树叶）保留碰撞；找不到 VMT 按不透明保留碰撞；static prop `solid=0`（SOLID_NONE）是唯一明确的「无碰撞」标注（`pakfile_models.rs:20-29`）。
- `place_point`（`:254`）：`translation + q⊗(scale⊙v)`——变换链与 GLB Node **逐位一致**（输入同源于 `resolve_placements`），保证碰撞体与显示模型零偏移（`:249-253` 注释）。

### 3.5 phyfile —— `.phy` 凸包解析

`parse_phy`（`phyfile.rs:81`）：主头 16B（size/id/solidCount/checkSum，solidCount∈1..=64）→ 每 solid 一个表面段（`VPHY` 标识 + CompactSurfaceHeader + ledge tree）→ 文本段 `solid{index, surfaceprop}` 关联。顶点为**模型局部、米制**，×39.3701 转 HU（`M_TO_HU = 1/0.0254`，`phyfile.rs:78`）；`bone_index≠0`（需骨骼变换）首版不支持，仅静态模型（`phyfile.rs:14-15`）。格式依据：Valve 官方 PHY 文档 + TAServers/source-parsers（triangledata 位域、ledge tree、索引 remap 经 s2_pillbig.phy/cow.phy 逐字节验证，`phyfile.rs:1-7`）。

### 3.6 texture_utils —— VTF 解码

- `VTF::read`（`vtf.rs:19`）：头 + 资源表定位 lowres/highres 图像偏移（`VTF_LEGACY_RSRC_LOW_RES_IMAGE`/`IMAGE`，缺省按 header_size 推算）。
- `VTFImage::decode`（`image.rs:76`）：Dxt1/Dxt1Onebitalpha→BC1、Dxt3→BC2、Dxt5→BC3（texpresso `Format::decompress`）；Rgba8888/Rgb888 直读；Bgr888/Bgra8888 通道重排（`convert_bgra`，`image.rs:114`）；其余格式报 `UnsupportedImageFormat`。
- `ImageFormat`（`#[repr(i16)]` 枚举 28 变体，`image.rs:125-179`）+ `frame_size` 字节量表；mip 偏移计算 `get_offset`/`get_mip_size`（`vtf.rs:366-410`）。编码路径（`VTF::create`）保留但 WASM 未用（`mod.rs:1` 注释）。

### 3.7 mosaic —— 纹理画质字节码与 MTZ 容器

> 本节是**解析层视角**（编码/解码/容器算法）。材质体系全景——三条消费链（GLB 构建期回退 / 运行期画质切换 / 缺失比对）、双端 cdylib 导出面、viewer/harness 排除面、协议注入点——见 [materials.md](./materials.md)。

**v4 DSL 编码** `encode::img_to_code(png, name)`（`encode.rs:37`）：

1. 网格：长边 ≤50 等比缩放（短边 ≥1，如实表达非 1:1 比例，`encode.rs:43-48`）；
2. 盒式降采样：仅统计不透明像素（alpha≥128），全透明格标记不可见；同时统计平均 alpha 供半透明补偿（`encode.rs:50-80`）；
3. 量化：6bit/通道桶直方图取前 ≤8 色（质心），逐格最近色重映射（`encode.rs:82-124`）；
4. 位打包：0/2/3 bit 索引，MSB-first 行主序 → base64url；透明格输出 1bit A[] 掩码（`encode.rs:126-157`）；
5. 半透明系数 `T[opacity]`（可见格平均 alpha <250 时输出；旧解码器逐字段扫描天然忽略未知字段，`encode.rs:157-179`）；
6. 输出 `#mosaic v4\nB[name:WxH]C[..]T[..]A[..]R[..]\n`（尾换行与 mtz `render_bytecode` 约定一致保证 JSON 逐字节往返，`encode.rs:175-189`）。

**解码** `decode::code_to_img(code, scale)`（`decode.rs:49`）：解析字段（长度校验：网格 ≤100_000 格、R/A 长度精确匹配）→ 查色板拼 w×h 网格（不透明格 alpha = opacity）→ 最近邻放大至 **2 次幂对齐**（长边×scale 向上取 2 次幂，短边独立对齐）——防 WebGL1/NPOT 环境下 three.js `floorPowerOfTwo` 钳制造成 Repeat 采样「田字分隔」（`decode.rs:42-48` 注释）→ PNG。

**manifest**（`manifest.rs`）：`collect_face_texture_names`（可见 face 的 VMT 材质路径小写去重，与 GLB 导出 TextureCollector 同口径，`:15-29`）；`build_mosaic_manifest`（VMT→VTF→PNG→字节码，单纹理失败跳过不中断，`:48-58`）；`collect_missing_textures`（与 manifest 互补的失败清单，`:33-43`）。manifest 生成时机受编排层约束：**必须先于 GLB 导出**（`world-builder.ts:164`）。

**MTZ5/6 容器**（`mtz.rs`，纯 std 无第三方依赖，`:2`）：魔数 `MTZ6`/`MTZ5`（`:7-9`）；字节级 Huffman（频次表 + 规范码，平局按 (freq,id) 保证确定性，`:16-79`）+ 大窗口 LZ77（`lz_compress`/`lz_decompress`，`:198/256`）；`compress_json`/`compress_json_detailed`（含 CompressReport）/`decompress_mtz`（`:726/731/775`）；字节码以 `Entry{name,sig,colors,alpha,indices,bits}` 中转（`parse_bytecode`/`render_bytecode`/`parse_json`/`render_json`，`:395-589`），字段分区 `pack_regions`/`unpack_regions`（`:591/624`）。默认纹理包 `src/materials/textures.mtz`（5,942,995 B，与 `debug/web/textures.mtz`、`game/web/textures.mtz` 三处同步副本，`ls` 实测）经 `decompress_mtz` 还原为 `{纹理名: "#mosaic v4 …"}` JSON。

---

## 4. 核心差异（各工程导出层如何复用本 crate）

本 crate 是纯库；**各工程 cdylib `lib.rs` 是差异所在**（同一解析核心，导出面按需裁剪）：

| 工程 | 导出面 | 特点 | 证据 |
|---|---|---|---|
| debug | 顶层自由函数（parse_bsp/export_visleaf_pvs/decode_vtf_to_png/mosaic_encode/mosaic_decode/decompress_mtz）+ BspProcessor 全导出集（含 parse_entities/list_pakfile/read_pakfile_*/export_mosaic_manifest/export_missing_textures 等） | 功能最全：mosaic 三函数 + 缺失纹理 + 实体/PAKFILE 自省 | `debug/crates/wasm/src/lib.rs`（`collect_pakfile_models` 模式 `:50` 起） |
| game | 3 个自由函数（mosaic_encode/mosaic_decode/decompress_mtz，`:177/184/192`）+ BspProcessor 15 方法 | 与 debug 同源精简：保留 mosaic 画质切换，无实体/PAKFILE 自省 | `game/crates/wasm/src/lib.rs:387-1671` |
| viewer | BspProcessor 仅 `new/metadata/parse_spawn_points/export_glb_with_pakfile_models`，运行时只调后三者；**不导出** brush/模型碰撞/teleport/PVS/mosaic/默认纹理包 | 最小查看器面 | `viewer/crates/wasm/src/lib.rs:1-9` 头注 + `:277-418` |
| test/dual-mode-harness | BspProcessor 9 方法：brush/phy/tri 碰撞 + spawn/teleport/pvs + GLB（**无 mosaic**） | 时序验证所需的物理导出子集 | `test/dual-mode-harness/crates/wasm/src/lib.rs:326-1685` |

通用模式：各工程 `collect_pakfile_models(bsp)` 从 `bsp.pack`（zip）提取 `.mdl/.vvd/.vtx/.vmt/.vtf` 字节，组装 `InMemoryResources` 后交给 `ModelIntegrator`（`debug/crates/wasm/src/lib.rs:50` 起；game `:55`；dual-mode `:63`）。导出方法的 JS 契约由 ts-shared `BspProcessorLike` 接口约束（`world-builder.ts:19-31`），详见 [ts-shared.md](./ts-shared.md)。
