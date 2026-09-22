# 材质、贴图与资产管线

> 本文是**共享层文档**（P2）的一篇，内容全部来自当前源码实测；锚点为「相对仓库根路径:行号」，由 `node src/scripts/check-doc-drift.mjs` 校验。
> 模块总览见 `documents/architecture/overview.md`；解析层（BSP / 模型 / 光照图）见 `documents/wasm-core/overview.md`。

---

## 1. 范围

本层描述「材质与贴图从 BSP/PAK 资产到 GLTF 材质」的全部通路，以及仓库自带的纹理容器与默认纹理包。涉及位置：

| 位置 | 角色 |
|---|---|
| `src/wasm-core/bsp_to_gltf_core/materials.rs` | VMT 材质解析、缺失贴图回退、贴图收集 |
| `src/wasm-core/texture_utils/` | 本仓自带的 VTF 容器解析（`vtf.rs` / `image.rs` / `mod.rs`） |
| `src/wasm-core/mosaic/` | MTZ / 字节码文本格式的编解码与清单（`encode.rs` / `decode.rs` / `manifest.rs` / `mtz.rs`） |
| `src/wasm-core/pakfile_models.rs` | PAK 内部文件索引（`PakIndex`）与模型资源 |
| `src/wasm-core/vbsp/data/game.rs` | game lump（含 HDR/光照相关数据） |
| `src/materials/textures.mtz` | 仓库自带的**默认纹理包** |

## 2. 三条**互不相同**的贴图通路（易混，务必分清）

| 通路 | 入口 | 事实 |
|---|---|---|
| **A. BSP → GLTF 导出期的 VTF 解码** | `src/wasm-core/bsp_to_gltf_core/materials.rs` | 走的是**外部 `vtf` crate**（`src/wasm-core/Cargo.toml:26` 声明 `vtf = "0.3"`；调用点形如 `vtf::vtf::VTF::read(&vtf_data)`，见 `src/wasm-core/bsp_to_gltf_core/materials.rs:583`）。**该文件全文不引用本仓 `texture_utils`** |
| **B. 本仓自带的 VTF 容器解析** | `src/wasm-core/texture_utils/vtf.rs` | `pub struct VTF`（`src/wasm-core/texture_utils/vtf.rs:71`）、`pub fn read`（`:93`）、`pub struct VTFHeader`（`:228`）。它**不参与**通路 A；本仓的消费点是 `apps/debug/crates/wasm/src/lib.rs` 调 `texture_utils::from_bytes`（game 与 viewer 都不调用） |
| **C. mosaic 文本字节码通路** | `src/wasm-core/mosaic/` | 把贴图/区域编码成可读文本（`img_to_code`）与反向解码（`code_to_img`），用于缺失贴图回退与 MTZ 容器 |

**结论**：看到「VTF 解码」时不能假定走的是同一条路——通路 A 用外部 crate，通路 B 是本仓实现且只被 debug 的 wasm 绑定调用。

## 3. MTZ 容器与默认纹理包

- 容器魔数：`pub const MAGIC: &[u8; 4] = b"MTZ6"`（`src/wasm-core/mosaic/mtz.rs:45`），另有旧版识别用的 `MAGIC_V5`（`src/wasm-core/mosaic/mtz.rs:47`）。
- 仓库自带默认包 `src/materials/textures.mtz` 的前 4 字节**实测为 `MTZ6`**。
- 容器的文本形态由 `mosaic/mtz.rs` 的 `parse_json`（`src/wasm-core/mosaic/mtz.rs:675`）等出入口负责；文本格式的字段顺序、压缩标志与长度前缀都以该文件的实现为准。

## 4. 材质与缺失贴图回退

| 项 | 锚点 | 语义 |
|---|---|---|
| `MaterialData` | `src/wasm-core/bsp_to_gltf_core/materials.rs:50` | 材质数据（含 alpha 测试、半透明与纹理变换等分支所用的字段） |
| `TextureData` | `src/wasm-core/bsp_to_gltf_core/materials.rs:104` | 单张贴图数据 |
| `TextureCollector` / `new` / `add_texture` | `src/wasm-core/bsp_to_gltf_core/materials.rs:117` / `:124` / `:134` | 收集导出期用到的贴图 |
| `fallback_key` | `src/wasm-core/bsp_to_gltf_core/materials.rs:152` | 由路径归一出回退键（归一规则见该函数体） |
| `fallback_texture_png` | `src/wasm-core/bsp_to_gltf_core/materials.rs:165` | 回退贴图字节；其内部用 `mosaic::decode::code_to_img` 把字节码解成 PNG，**单个候选失败就继续试下一个** |
| `load_material_fallback` / `load_material_fallback_bsp` | `src/wasm-core/bsp_to_gltf_core/materials.rs:240` / `:284` | 两条回退装载入口 |

`bsp_to_gltf_core/mod.rs` 一侧另有说明：回退值由 `mosaic::decode::code_to_img` 在导出期解成 PNG 字节并直接嵌进 GLB。

## 5. 资产查找与其他数据

| 项 | 锚点 | 语义 |
|---|---|---|
| `PakIndex` | `src/wasm-core/pakfile_models.rs:219` | PAK 内部文件索引：按「去前缀 + 去扩展名」的键查候选路径列表（候选顺序见该文件实现） |
| `GameLumpHeader` | `src/wasm-core/vbsp/data/game.rs:42` | game lump 目录项；光照/HDR 相关数据的字段与版本差异由该模块承载 |

## 6. 已知遗留与疑似缺陷（只记录，未改代码）

以下均已在根 `AGENTS.md` 的待决表中登记，此处只做索引，避免文档与台账出现两套口径：

1. **`texture_utils/vtf.rs`**：`VTFHeader::write` 在 `version[0] < 7` 分支声明头长与实写长度不一致；`ResourceList::read` 吞占位而 `write` 不写；`get_offset` 把 `frame` 与 `face` 加成同一线性项；`get_mip_size` 与 `VTFImage::get_frame` 的图幅口径不一致。另记零调用点：`ResourceType::has_resource_type`、`HAS_NO_DATA_CHUNK`、`VTF::save_as_png`、`texture_utils::create`、`VTF::lowres_image`。
2. **`mosaic/mtz.rs`**：`pack_regions` 用 `as u8` 写 meta 导致 `w`/`h` 超 255 时尺寸变值；`opacity` 仅在 `< 250` 时写出；`pack_regions` 与 `unpack_regions` 的签名长度接受集不一致；`w * h` 在 `u32` 上相乘无上界；容器文本再入解析的边界不一致；五个 `FLAG_*_LZ` 常量零引用；`emit_match` 的扩展长度字节在极长匹配时截断（当前唯一调用点已兜住）。
3. **`mosaic/decode.rs`**：`code_to_img` 不校验宽高下界，也不校验解码出的索引是否落在调色板色数内。
4. **通路 A 的材质扩展**：`extensions.KHR_texture_transform` 在 `material.transform` 存在时会被写入 material，但 BSP 导出路径不把它加入 `extensions_used`（消费端按 `extensionsUsed` 判断时会不生效）。

> 这些条目的处置（改代码 / 改文案 / 保持现状）由仓库 owner 裁决；注释中已按当前代码如实写明行为与口径。
