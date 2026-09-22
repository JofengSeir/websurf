# 共享解析层（`src/wasm-core`，crate `websurf-wasm-core`）

> 本文是**共享层文档**（P2）的一篇，内容全部来自当前源码实测；锚点为「相对仓库根路径:行号」，由 `node src/scripts/check-doc-drift.mjs` 校验。
> 依赖方向见 `documents/architecture/overview.md`；材质与贴图通路见 `documents/materials/overview.md`。

---

## 1. 定位与边界

`src/wasm-core/` 是三个工程共用的 **BSP / 资产解析与 GLTF 导出层**（crate `websurf-wasm-core`，`src/wasm-core/Cargo.toml`）。它**不含物理**：`websurf-phys` 与它互不依赖，两者都由 `apps/debug`、`apps/game` 的 wasm crate 引用，而 **`apps/viewer` 只引用本层**。

它提供的是「把磁盘上的 Source 资产变成可渲染数据」的全部能力：BSP lump 读取、实体与 game lump 解析、模型/物理文件解析、光照图装配、材质与缺失资源回退、MTZ/字节码贴图编解码。

## 2. 模块清单

`src/wasm-core/lib.rs` 对外声明 **8 个 `pub mod`**（`src/wasm-core/lib.rs:36`–`src/wasm-core/lib.rs:43`）：`bsp_to_gltf_core`、`model_integrator`、`mosaic`、`pakfile_models`、`phyfile`、`texture_utils`、`vbsp`、`vhv`。

| 分组 | 文件数 | 内容 |
|---|---|---|
| 根目录 | 4 | `lib.rs`（模块声明）、`pakfile_models.rs`、`phyfile.rs`、`vhv.rs` |
| `vbsp/` | 4 | `bspfile.rs`（文件容器）、`reader.rs`（逐 lump 读取）、`error.rs`、`mod.rs`（对外类型与 lump 数据结构） |
| `vbsp/data/` | 3 | `mod.rs`（lump 数据结构）、`entity.rs`（实体）、`game.rs`（game lump） |
| `vbsp/handle/` | 1 | lump 句柄 |
| `bsp_to_gltf_core/` | 5 | `mod.rs`（对外类型与错误）、`convert.rs`（导出主入口）、`lightmap.rs`、`materials.rs`、`gltf_builder.rs` |
| `model_integrator/` | 1 | 把 BSP 内模型合并进 GLTF |
| `mosaic/` | 5 | `mod.rs`、`encode.rs`、`decode.rs`、`manifest.rs`、`mtz.rs` |
| `texture_utils/` | 3 | `mod.rs`、`image.rs`、`vtf.rs` |

## 3. 入口面

| 入口 | 锚点 | 语义 |
|---|---|---|
| `BspFile` | `src/wasm-core/vbsp/bspfile.rs:28` | BSP 文件容器（按 lump 目录定位） |
| `read_entities` | `src/wasm-core/vbsp/reader.rs:71` | 读出实体集合（整段文本在读取时已统一大小写，见 `RawEntity` 的取值口径） |
| `RawEntity` | `src/wasm-core/vbsp/data/entity.rs:127` | 实体键值访问（按**逐字节**比较键名） |
| `GameLumpHeader` | `src/wasm-core/vbsp/data/game.rs:42` | game lump 目录项（版本差异按字段宽度累加读取） |
| `Leaves` / `LightingLump` | `src/wasm-core/vbsp/mod.rs:73` / `src/wasm-core/vbsp/mod.rs:243` | 叶子集合视图与光照 lump |
| `parse_vhv` | `src/wasm-core/vhv.rs:90` | 读 pakfile 内的 `sp_<i>.vhv` → prop 顶点色 |
| `PakIndex` | `src/wasm-core/pakfile_models.rs:219` | PAK 内文件索引（去前缀/去扩展名后按候选列表查找） |
| `export_bsp_with_models` | `src/wasm-core/bsp_to_gltf_core/convert.rs:179` | **导出主入口**：BSP（+可选模型集成）→ GLTF |
| `ConvertOptions` / `ExportResult` | `src/wasm-core/bsp_to_gltf_core/mod.rs:134` / `:115` | 导出选项与结果 |
| `ResourceType` / `ResourceSource` / `MissingResource` | `src/wasm-core/bsp_to_gltf_core/mod.rs:75` / `:90` / `:101` | 资源缺失的类型化表示（导出期不静默丢弃） |
| `Error` | `src/wasm-core/bsp_to_gltf_core/mod.rs:248` | 导出错误枚举 |
| `from_bytes` | `src/wasm-core/texture_utils/mod.rs:87` | 本仓 VTF 容器解析入口（详见 `documents/materials/overview.md` 的通路 B） |
| `build_mosaic_manifest` | `src/wasm-core/mosaic/manifest.rs:66` | mosaic 清单（键取自加载后的贴图名） |
| `code_to_img` | `src/wasm-core/mosaic/decode.rs:64` | 字节码文本 → PNG 字节（缺失贴图回退用） |
| `MAGIC`（`MTZ6`） | `src/wasm-core/mosaic/mtz.rs:45` | MTZ 容器魔数 |

> 两个尚无行号锚点的位置（其注释正在做「去行号」改写，行号不稳定，故只给路径与符号）：`src/wasm-core/model_integrator/mod.rs` 的模型合并入口、`src/wasm-core/mosaic/encode.rs` 的贴图编码入口、`src/wasm-core/vbsp/data/mod.rs` 的 lump 数据结构定义。

## 4. 主流程

1. **读**：`BspFile` 定位 lump → `vbsp/reader.rs` 逐 lump 解析成 `vbsp/mod.rs` 与 `vbsp/data/` 里的结构（实体、叶子、面、纹理、game lump）。
2. **装配**：`convert.rs` 的 `export_bsp_with_models` 是唯一导出入口，内部按序装配模型网格、材质、光照图，并在需要时调用 `model_integrator` 把 BSP 内模型合并进同一份 GLTF。
3. **缺失资源**：导出期不静默丢弃——用 `ResourceType`/`ResourceSource`/`MissingResource` 描述「缺什么、来自哪里」；材质侧的回退链路见 `documents/materials/overview.md` §4。
4. **光照图**：`bsp_to_gltf_core/lightmap.rs` 负责按面装配 atlas；页面积上限为常量 `MAX_ATLAS_PAGE_AREA`（`src/wasm-core/bsp_to_gltf_core/lightmap.rs:54`，即最大边长平方的一半）。
5. **贴图**：三条互不相同的通路（外部 `vtf` crate / 本仓 `texture_utils` / mosaic 字节码）——分工与调用点见 `documents/materials/overview.md` §2。

## 5. 关键不变量与边界

1. **不依赖物理**：本层与 `websurf-phys` 无依赖关系；应用侧要跑物理需各自再引用 `websurf-phys`。
2. **`Arc<Bsp>` 的消费语义**：导出入口接 `Arc<Bsp>`，只读使用，不消费调用方的所有权。
3. **实体键名大小写**：实体文本在读取阶段已统一为小写，`RawEntity` 的取值是逐字节比较——因此取值键必须写小写（本仓已登记一处反例，见 §6）。
4. **导出产物以 GLTF 为准**：导出把光照图、材质扩展、模型合并都落到同一份 GLTF/GLB 里；扩展名是否登记进 `extensions_used` 由导出路径决定（本仓已登记一处不一致，见 §6）。
5. **纹理容器有两个出入口**：文本形态（`mosaic` 的 encode/decode）与二进制形态（`mtz` 的 MTZ6 容器 + `texture_utils` 的 VTF 容器）各管一段，不要互相代用。

## 6. 已知遗留（索引，详见根 `AGENTS.md` 的待决表）

1. `bsp_to_gltf_core/convert.rs` 内三份 GLTF 合并实现**零调用点**（合计约 500 行，各带 `#[allow(dead_code)]`）；线上合并路径是 `model_integrator` 的合并入口。
2. `bsp_to_gltf_core/lightmap.rs` 的一条错误文本里含对外部参考实现的 `文件:行号` 引用（属**代码字面量**，未改）。
3. `texture_utils/vtf.rs` 的四处读写口径不一致与五项零调用点；`mosaic/mtz.rs` 的八处边界/一致性问题；`mosaic/decode.rs` 的宽高与调色板索引校验缺失。
4. `extensions.KHR_texture_transform` 在 `material.transform` 存在时会被写入 material，但导出路径未把它登记进 `extensions_used`。
5. 实体键名大小写：`apps/debug` 与 `apps/game` 的 wasm 绑定层各有一处 `.prop("StartDisabled")`（大写），而实体文本已整体小写 ⇒ 该次取值必然失败并被 `unwrap_or(false)` 吞掉。
