# 共享层④：材质体系（mosaic 字节码 / VTF 解码 / 默认纹理包）

> 定位：在**没有任何外部游戏资源**的前提下，让 BSP 地图的材质在浏览器可用——
> ① VTF 解码（`texture_utils/`）；② mosaic v4 字节码 + MTZ5/6 压缩容器（`mosaic/`，含默认配置纹理包 `textures.mtz`）；
> ③ 三条消费链：Rust 侧 GLB 构建期回退、JS 侧运行期画质切换、缺失纹理比对（本文承接 `docs/archive/materials.md`、`debug/docs/archive/materials.md`、`game/docs/archive/materials.md` 三处旧档，收敛为根单篇）。
> 编码/解码/MTZ/VTF 算法正文由 [wasm-core.md](./wasm-core.md) §3.6-3.7 逐字承载（本文 §3.1 仅留机制速查与四项增量）；本文主线是**材质体系全景**：协议注入点、双端导出面、三条消费链的完整时序。
> 所有论断标注来源（`相对路径:行号`），写作基线为当前工作区代码。

---

## 1. 整体架构

### 1.1 四个组成部分

| 组成 | 位置 | 关键事实 | 来源 |
|---|---|---|---|
| 共享实现（编码/解码/容器） | `src/wasm-core/mosaic/`：`mtz.rs`(910，全仓最大单文件)、`encode.rs`(190)、`decode.rs`(159)、`manifest.rs`(79)、`mod.rs`(10) | 纯 std 无第三方依赖 | `wc -l` 实测；`mtz.rs:2` 头注 |
| 共享实现（VTF 解码） | `src/wasm-core/texture_utils/`：`vtf.rs`(409)、`image.rs`(179)、`mod.rs`(44) | texpresso BC 解压 → DynamicImage | 同上；`mod.rs:1` 注释「WASM 仅用解码路径，保留编码 API 结构」 |
| 共享数据 | `src/materials/textures.mtz`（5,942,995 B） | 与 `debug/web/textures.mtz`、`game/web/textures.mtz` 三处副本逐字节等大（`ls` 实测） | `ls -l` 实测 |
| 共享协议注入点 | `src/ts-shared/phys/world-builder.ts` | `WorldBundle.mosaicManifest?/missingTextures?`（`:61-64`）、`WorldBuilderOptions.collectMissingTextures?/decompressMtz?`（`:76-79`）、管线调用点（`:164-178`） | `world-builder.ts` 实读 |

### 1.2 数据流总览

```
BSP pack(zip) 内 .vmt/.vtf
   └─ vbsp Packfile 提取 ── VMT 解析（pakfile_models parse_vmt）── VTF 解码（texture_utils）
        │                                     │
        │  编码（构建期，一次性）                │ 直接解码
        ▼                                     ▼
 mosaic v4 字节码（长边≤50 网格）        PNG → GLB 材质纹理
        │
        ├─ export_mosaic_manifest → WorldBundle.mosaicManifest
        │        └─ 渲染器 applyTextureQuality（运行期 mini 画质）
        └─ build_mosaic_manifest / 默认包 → textures.mtz（MTZ5/6 容器）
                 └─ decompress_mtz → {材质路径: "#mosaic v4 …"} JSON
                          └─ export_glb_with_pakfile_models_with_defaults（构建期回退）
```

### 1.3 三条消费链（一图看清分工）

| 链 | 触发点 | 实现 | 消费者 |
|---|---|---|---|
| ① 构建期回退 | 地图加载，GLB 导出前 | `world-builder.ts:180-204` 组装 `defaultsJson`（内嵌 base64 或 `fetch('./textures.mtz')` → 注入的 `decompressMtz`）→ `export_glb_with_pakfile_models_with_defaults(defaultsJson)`（`:207-211`） | **Rust 侧直接把缺失材质替换为低清纹理进 GLB**——渲染端零后期处理（`:180-181` 注释） |
| ② 运行期画质切换 | 用户切「纹理画质 mini/original」 | `renderer-main.ts applyTextureQuality`：mini = `mosaicManifest[code]` → `mosaic_decode(code, 8)` → PNG → `createImageBitmap` → `map.dispose()` + `image` 替换 | debug `renderer-main.ts:674-736`、game `renderer-main.ts:295-335`（两端同构） |
| ③ 缺失纹理比对（debug 独有） | 地图加载完成 | `showMissingTextures`（`debug/src/app.ts:410-451`，由 `onSceneReadyUi` `:349` 触发）+ `loadDefaultTexturePack`（`default-pack.ts:18-31`） | 弹窗列出「连默认包都没有」的材质；回退本身已在链①自动应用（`app.ts:394-397` 注释） |

### 1.4 被引用关系（哪些工程拿到材质能力）

| 工程 | mosaic/默认纹理包能力 | 证据 |
|---|---|---|
| debug | 全套：`mosaic_encode/mosaic_decode/decompress_mtz` + `with_defaults/manifest/missing_textures` | `debug/crates/wasm/src/lib.rs:3189-3204`（三全局函数）、`:494`（with_defaults）、`:850`（manifest）、`:874`（missing_textures） |
| game | 同 debug 全套（同源逐字复制） | `game/crates/wasm/src/lib.rs:177-192`、`:435`、`:917`、`:942` |
| viewer | **不导出**——头注明示「brush/模型碰撞/teleport/PVS/mosaic/默认纹理包，均不导出」 | `viewer/crates/wasm/src/lib.rs:9` |
| test/dual-mode-harness | **不导出**——头注明示「未导出（mosaic/缺失纹理/薄壳）」 | `test/dual-mode-harness/crates/wasm/src/lib.rs:21` |

TS 侧接口收敛：`BspProcessorLike` 的 `export_mosaic_manifest/export_missing_textures`（`world-builder.ts:27-28`）与 `WorldBuilderOptions.decompressMtz?`（`:78-79`）——工程能力差异由选项开关表达，不改动共享层（见 [ts-shared.md](./ts-shared.md) §2.2）。

---

## 2. 核心时序

### 2.1 加载管线内的材质时序（`world-builder.ts`，两工程共用）

`buildWorldBundle` 中材质相关五步，**顺序有硬约束**——manifest/缺失纹理必须先于 GLB 导出（消费 BSP）生成（`:164` 注释）：

1. `mosaicManifest = proc.export_mosaic_manifest()`，失败仅告警降级「画质切换不可用」（`:165-170`）；
2. `missingTextures`：仅 `options.collectMissingTextures` 开启时收集（debug 传 true），失败告警（`:171-178`）；
3. `defaultsJson`：默认纹理包解压（`:180-204`）——single 打包（file://）取 `globalThis.__VBSP_TEXTURES_MTZ_B64__` 内嵌 base64（`:185-192`）；multi/dev（HTTP）`fetch('./textures.mtz')`（`:194-199`）；两者都经注入的 `options.decompressMtz` 还原为 `{材质路径: "#mosaic v4 …"}` JSON；无注入或失败 → `'{}'`（缺失材质不进回退表，GLB 中保持素色底，代码原话见 `:203` warn 文本）；
4. GLB 导出：`export_glb_with_pakfile_models_with_defaults(defaultsJson)`，失败回退无回退版 `export_glb_with_pakfile_models`（`:206-211`）；
5. `glbBytes` 做 buffer slice 拷贝（`:213-216`）。

bundle 产物携带 `mosaicManifest?/missingTextures?`（`:61-64`）→ 主线程 `handleLoadBsp` 组装 `SceneDataMessage` 交给渲染器：debug `app.ts:1305`、game `app.ts:418`；类型定义 `debug/src/worker/worker-types.ts:298`。

### 2.2 运行期画质切换时序（链②，debug/game 同构）

`applyTextureQuality(quality)`（debug `renderer-main.ts:674`，game `renderer-main.ts:295`）：

- **mini**：`manifest = this.mosaicManifest`（debug `:675`，game `:296`）→ `code = manifest[材质名]` → `mosaic_decode(code, 8)`（默认 ×8，`mosaic_decode` cdylib 注释 `debug lib.rs:3193`）→ PNG 字节 → `createImageBitmap` → **先 `map.dispose()` 再替换 `map.image`**（three r152+ 增量上传约束，debug `renderer-main.ts:720-724` 注释）→ `needsUpdate`；
- **original**：从 `origTextureImages` 缓存恢复原始位图（debug `:697-704`；备份发生在切换前 `:712`）；
- manifest 来源：`loadScene` 时 `JSON.parse(data.mosaicManifest)` 存入 `renderer.mosaicManifest`（debug `:380-382`、game `:283-285`；字段声明 debug `:174`、game `:123`）。

### 2.3 缺失纹理比对时序（链③，debug 独有）

1. `loadDefaultTexturePack()`（`default-pack.ts:18-31`）：幂等缓存（`:13`）；`ensureMainWasm` 后按内嵌/fetch 双路取 `textures.mtz` 并 `decompress_mtz`（`:21-31`）；失败返回 null（比对全部标「完全缺失」、回退不执行，`:3-4` 注释）；
2. `showMissingTextures(missingTextures)`（`app.ts:410-451`，入口 `:349`）：将 BSP 材质与默认包键集比对，弹窗列出（DOM `app.ts:93-96`；确认按钮 `:1101`、`:425`）；
3. 该链**只做信息展示**——真实回退已在链①构建期完成（`app.ts:394-397` 注释「回退已在 renderer 场景构建期自动应用，此处仅展示信息」）。

---

## 3. 具体实现

### 3.1 机制速查（全部见 wasm-core.md §3.6-3.7）

编码六阶段（`encode.rs:37` `img_to_code`）、解码 2 次幂对齐（`decode.rs:49` `code_to_img`，scale 缺省 8）、MTZ 容器内部（Huffman `:16-79`/LZ77 `:198/:256`/`pack_regions` `:591`/API `:726/:731/:775`）、manifest 三函数、VTF 解码（`vtf.rs:19`/`image.rs:76`）——**算法正文已逐字在 [wasm-core.md](./wasm-core.md) §3.6-3.7，此处不复述**。仅留本篇协议相关的四项增量：

1. **MTZ6/5 meta 长度语义**：MTZ6 meta=8B（含 opacity）/ MTZ5 meta=7B（仅解压兼容），`unpack_regions` 按 `meta_len`=7/8 分派（`mtz.rs:624`）；
2. **默认包键集**：`decompress_mtz` 产出的 JSON 键 = `materials/xxx` 小写（与 basetexture 一致），供缺失纹理比对（`debug lib.rs:3201-3202` 注释）；
3. **manifest 语义**：`collect_face_texture_names` 与 GLB 导出 `TextureCollector` 同口径（`bsp_to_gltf_core/materials.rs:50`）；`build_mosaic_manifest` **单纹理失败跳过不中断**（`manifest.rs:48-58`）——画质切换数据源允许部分可用；
4. **行号补差**：`ImageFormat` 枚举精确起点 `image.rs:126`（28 变体至 `:179`；wasm-core.md 写作 :125-179 区间）。

### 3.2 双端 cdylib 导出面（同源逐字）

| 全局函数/方法 | debug | game | 说明 |
|---|---|---|---|
| `mosaic_encode(png,name)` | `lib.rs:3189` | `lib.rs:177` | PNG → 字节码（转调 `encode::img_to_code`） |
| `mosaic_decode(code,scale)` | `lib.rs:3195` | `lib.rs:183` | 字节码 → PNG（转调 `decode::code_to_img`） |
| `decompress_mtz(bytes)` | `lib.rs:3203` | `lib.rs:190` | textures.mtz → textures.json 文本 |
| `export_mosaic_manifest()` | `lib.rs:850` | `lib.rs:917` | BspProcessor 方法 |
| `export_missing_textures()` | `lib.rs:874` | `lib.rs:942` | BspProcessor 方法 |
| `export_glb_with_pakfile_models_with_defaults(json)` | `lib.rs:494` | `lib.rs:435` | 构建期回退注入点 |

### 3.3 数据文件与注入链

- `textures.mtz` 源文件 `src/materials/textures.mtz`（5,942,995 B）；`debug/scripts/build-dist.mjs`：single 模式读入并 base64 注入 `globalThis.__VBSP_TEXTURES_MTZ_B64__`（`:55`、`:115`）、multi 模式复制到 `dist/textures.mtz`（`:14`、`:185`）；
- 主线程 wasm 出口：`debug/src/main-wasm.ts:10` 导入 `mosaic_decode/decompress_mtz`、`:45` 再导出（game 直接从 `../pkg/websurf_wasm.js` 导入，`game/src/app.ts:14`）；
- **debug Worker 侧 mtz 通道是协议兼容残留**：`wasm-init` 消息的 `mtzB64` 字段仍下发（`worker-dispatch.ts:35` 签名），debug `worker/main.ts:110` 存入 `mtz-data.ts`，但其自注「协议兼容保留（Worker 不再解析 BSP，纹理包不再使用）」——`mtz-data.ts:4` 头注的「handleLoadBsp 消费」为过时描述，以 `main.ts:110` 行内注释为准。game 侧 worker 完全无 mtz 文件（grep 空）。

---

## 4. 核心差异

### 4.1 debug vs game 的材质消费差异

| 维度 | debug | game | 证据 |
|---|---|---|---|
| 链①构建期回退 | ✅（decompressMtz 注入） | ✅（同） | `debug/src/app.ts:1295`、`game/src/app.ts:407` |
| 链②画质切换 | ✅ mini/original | ✅ 同构（含 manifest 解析） | `debug/src/renderer/renderer-main.ts:674-736`、`game/src/renderer/renderer-main.ts:295-335` |
| `collectMissingTextures` | **true** | **不传**（无此能力消费） | `debug/src/app.ts:1294`、`game/src/app.ts:406-409` |
| 链③缺失比对弹窗 | ✅（default-pack.ts + showMissingTextures） | ❌ 无 default-pack 文件、无弹窗 | `debug/src/default-pack.ts`（game/src 无同名文件，grep 实证） |
| wasm 就绪门 | `ensureMainWasm`（main-wasm.ts 封装） | `app.ts:63/:138` promise（防 decompress_mtz 未就绪竞态） | `game/src/app.ts:63,138` |
| Worker 侧 mtz | 协议兼容残留（见 §3.3） | 无 | `debug/src/worker/main.ts:110` |

共同点：链①②两端行为一致（同一 world-builder、同一 applyTextureQuality 逻辑）；差异全部在链③与加载 UI（debug 缺失弹窗 vs game 进度覆盖层，见 `debug/docs/differences.md` §3.7）。

### 4.2 排除面（viewer / harness）

两端 cdylib 均不导出 mosaic/默认纹理包（§1.4 表）：viewer 以 GLB 内嵌材质为终态（构建期已烧入，无运行期切换需求）；harness 为时序验证最小导出集。因此 `textures.mtz` 只需 debug/web、game/web 两份部署副本 + src 源副本（三处逐字节相等，`ls -l` 实测）。

### 4.3 与既有文档的分工

- 解码核心算法（vbsp/vtf/编码细节）→ [wasm-core.md](./wasm-core.md) §3.6-3.7；
- 协议注入点（BspProcessorLike/WorldBundle/WorldBuilderOptions）→ [ts-shared.md](./ts-shared.md) §2.2/§3.6；
- debug 工程消费细节（applyTextureQuality 实现/近 missing 弹窗 UI/状态行）→ [../debug/docs/implementation/rendering.md](../debug/docs/implementation/rendering.md) 纹理画质切换节、[../debug/docs/implementation/loading-pipeline.md](../debug/docs/implementation/loading-pipeline.md) 纹理回退链节；
- game 工程消费 → [../game/docs/implementation/gameplay.md](../game/docs/implementation/gameplay.md)。

### 4.4 旧档承接

本篇收敛三处归档旧档（只读背景，内容未直接搬运、均经当前代码重验）：`docs/archive/materials.md`、`debug/docs/archive/materials.md`、`game/docs/archive/materials.md`（t1 归档，`git mv` 纯重命名）。
