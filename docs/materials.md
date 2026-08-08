# WebSurf 材质系统（公共技术）

两端（debug / game）共用的材质处理体系：**原始纹理（VTF）→ GLB 嵌入** + **低清压缩（mosaic v4）** + **默认纹理包（MTZ 打包）** + **画质切换** + **缺失纹理回退**。
代码位于共享层 `src/wasm-core/mosaic/` 与 `src/wasm-core/texture_utils/`。

---

## 1. 模块总览

| 文件 | 职责 |
|---|---|
| `src/wasm-core/texture_utils/` | VTF 解码（VTF → PNG，`from_bytes` / `save_as_png`） |
| `src/wasm-core/mosaic/encode.rs` | **压缩**：PNG → `#mosaic v4` 字节码（`img_to_code`） |
| `src/wasm-core/mosaic/decode.rs` | **解压**：字节码 → 低清 PNG（`code_to_img`，2 次幂对齐） |
| `src/wasm-core/mosaic/manifest.rs` | **拼装**：BSP 纹理收集（`collect_face_texture_names`）、画质 manifest（`build_mosaic_manifest`）、缺失列表（`collect_missing_textures`） |
| `src/wasm-core/mosaic/mtz.rs` | **打包**：textures.json ↔ MTZ 压缩容器（`compress_json` / `decompress_mtz`，字段分区 + LZ77 + Huffman） |
| `src/materials/textures.mtz` | 默认纹理包（MTZ6，9448+ 条；公共资源，三处副本） |

wasm 导出（两端 `crates/wasm/src/lib.rs`）：`mosaic_encode` / `mosaic_decode` / `decompress_mtz`（顶层）、`BspProcessor.export_mosaic_manifest` / `export_missing_textures` / `export_glb_with_pakfile_models_with_defaults`。

---

## 2. 原始纹理管线（地图自带）

```
BSP PAKFILE 内的 .vtf
  → VMT（$basetexture 定位，4 种路径变体大小写容错）
  → VTF 解码（texture_utils / 外部 vtf crate）
  → GLB 纹理嵌入（gltf_builder.push_texture，PNG 编码）
```

- GLB 的 `texture.name` = **basetexture 小写**（如 `materials/brick/brickwall003d`）；材质名 = **VMT 材质路径小写**（画质切换与回退的匹配键）。
- 模型贴图（PAKFILE 模型）的 `texture.name` = 材质名（如 `maplebark`，无 `materials/` 前缀）。

---

## 3. 低清压缩：mosaic v4 字节码（`encode.rs`）

**整体流程（PNG → 字节码）**：

```
PNG 字节
  ├─ 盒式降采样：网格长边 ≤50（等比缩放，短边 ≥1）
  │   格色 = 格内不透明像素（alpha≥128）平均 RGB；全透明格标记不可见
  │   同时统计每格平均 alpha（半透明补偿）
  ├─ 量化：6bit/通道桶直方图取前 ≤8 色（1色→0bit，2~4→2bit，5~8→3bit）
  │   逐格最近色重映射 → 索引
  ├─ 位打包：索引 MSB-first 行主序 → base64url
  ├─ alpha 掩码：1bit/格（1=透明）→ base64url
  ├─ 半透明系数：可见格平均 alpha < 250 → T[opacity] 字段（玻璃等半透明材质补偿）
  └─ 输出：#mosaic v4\nB[名称:WxH]C[调色板]T[opacity]A[alpha]R[索引]
```

**字节码格式（v4 + T 扩展，向后兼容）**：

| 字段 | 内容 |
|---|---|
| `B[name:WxH]` | 名称 + 网格尺寸（WxH ≤ 100000） |
| `C[hex,...]` | 调色板（≤8 色，每色 6 位 hex） |
| `T[opacity]` | 半透明系数 0-255（可选，无 = 255；旧解码器忽略未知字段） |
| `G[...]` | 签名（保留字段） |
| `A[base64]` | alpha 掩码（1bit/格，1=透明） |
| `R[base64]` | 索引位流（MSB-first 行主序） |

---

## 4. 低清解压：code_to_img（`decode.rs`）

```
字节码 → 解析字段（B/C/T/A/R）→ 查调色板拼装网格 → 最近邻放大 → PNG(RGBA)
```

- **2 次幂对齐**（防 NPOT 钳制）：长边 `next_power_of_two(长边 × scale)`，短边同比例放大后独立对齐——非 2 次幂纹理在 WebGL NPOT 受限环境会被 `floorPowerOfTwo` 钳到较小尺寸（原 512 纹理变 256 → UV 0..1 内 2×2 周期 = "田字分隔"）。比例偏差 ≤1 格，低清无感。
- **半透明**：不透明格 alpha = `T[opacity]`（默认 255），透明格 = 0。
- 默认放大倍数 ×8（`mosaic_decode(code, 8)`）→ 网格 50 → 512×512。

---

## 5. 打包：MTZ 容器（`mtz.rs`）

默认纹理包把上千条 `{ 纹理名: 字节码 }` 压缩为单文件：

```
textures.json（逐条 "key": "#mosaic v4\n..."）
  ├─ 解析为 Entry（key/w/h/调色板/签名/alpha/索引/opacity）
  ├─ 字段分区分组：meta（定长 8B 含 opacity）/名字/颜色/签名/alpha/索引
  │   （同类数据集中，统计分布互不污染）
  ├─ 每区独立规范 Huffman；Huffman 前可选 LZ77（哈希链 + 贪心），取更小者写标志位
  └─ 输出 MTZ 文件：
       magic "MTZ6"（旧 "MTZ5" 兼容解压，meta 7B 无 opacity）
       + u32 条目数 + u8 区域标志位 + 6 个 Huffman 块（256B 码长表 + u32 长度 + 位流）
```

- **无损往返**：解压（`decompress_mtz`）还原结果与压缩前**逐字节一致**（`unpack --check` 校验）。
- 实测（默认包）：5.67MB → 解压 11.4MB JSON，9448 条，~200ms。
- 打包工具链（`materials-mini`，独立工具工程，用后即删）：`encode-img`（图片目录 → textures.json）→ `pack`（json → mtz）→ `unpack --check`（校验）→ `decode-img`（还原验证）。

---

## 6. 画质切换（运行时替换）

**数据源**：`export_mosaic_manifest` → `{ 纹理名小写: 字节码 }`（地图 face 纹理 key = basetexture；PAKFILE 模型贴图 key = 材质名——两套 key 形式互不冲突）。

**流程**：

```
面板切换（原始纹理 / 压缩低清）
  → renderer.applyTextureQuality(quality)
  → 遍历场景材质收集 map（按贴图名去重）
  → 按 map.name 小写查 manifest
  → mini：mosaic_decode(code, 8) → ImageBitmap → map.image 替换
  → original：恢复缓存的原图
```

**关键坑（已修复）**：three.js r152+ 对同一 Texture 的 image 替换走**增量上传 glTexSubImage2D**（GPU 内存仅首次按旧尺寸分配）——新 image 尺寸与原纹理不符 → `GL_INVALID_VALUE: Offset overflows texture dimensions` → 上传失败（纹理保持旧内容 = "没应用"）。**修复**：替换 image 前 `map.dispose()`（强制重建 GPU 纹理，按新尺寸分配）。

---

## 7. 缺失纹理回退（GLB 导出期）

**缺失判定**：材质加载失败（BSP 内无 VMT/VTF 或解码失败）→ 占位色。列表 = `export_missing_textures`（与 manifest 互补）。

**回退**：在 **GLB 导出阶段**（`export_glb_with_pakfile_models_with_defaults`）直接完成——材质失败分支查默认纹理包（`options.missing_fallback[`materials/<名小写>`]`）→ `code_to_img` 解码 → 作为 GLB 纹理嵌入。**渲染端拿到的即自包含场景，零后期处理**（曾因渲染期/构建期中途替换引发 `RESULT_CODE_HUNG`，故定案为导出期注入）。

**流程**：

```
地图加载 → 默认纹理包（内嵌 base64 或 fetch）→ decompress_mtz → JSON
  → export_glb_with_pakfile_models_with_defaults(defaultsJson)
      └─ Rust 导出循环：材质失败 → 查表 → 低清纹理嵌入 GLB
  → 渲染端：缺失墙面直接显示默认包低清纹理
```

**弹窗**（debug）：加载后列出缺失纹理（默认包可覆盖 N 个 / 完全缺失 M 个），确认仅关闭（回退已完成）。

---

## 8. 默认纹理包（公共资源）

| 位置 | 说明 |
|---|---|
| `src/materials/textures.mtz` | 公共源（MTZ6） |
| `debug/web/`、`game/web/` | dev 副本（serve 提供） |
| dist（single 内嵌 / multi 外置） | 打包自动附带 |

**single（file://）内嵌链路**：`__VBSP_TEXTURES_MTZ_B64__`（主线程直接读）；Worker 端经 `wasm-init` 消息的 `mtzB64` 字段下发（Blob worker 读不到主线程 global）→ `worker/mtz-data.ts` 存取 → 导出时解压。

**导出/更新**：由独立工具（materials-mini：encode-img → pack）生成新 mtz → 替换 `src/materials/textures.mtz` 并同步两端 `web/` 副本；`decompress_mtz` 兼容 MTZ5（旧包）与 MTZ6（含半透明系数）。
