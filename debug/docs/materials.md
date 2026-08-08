# debug 材质模块（应用侧）

> 公共材质技术（mosaic 压缩 / MTZ 打包 / 解压拼装 / 回退机制）见 `docs/materials.md`。
> 本文档：debug 侧的**应用链路**——画质切换、缺失纹理回退、默认纹理包比对弹窗、运行时 wasm。

## 1. 运行时 wasm（主线程）

- `src/main-wasm.ts`：主线程懒初始化 wasm（`ensureMainWasm`）——single 内嵌 `__VBSP_WASM_B64__` → `initSync`；dev/multi 用 `mainWasmUrl()`（`__VBSP_WASM_URL__` ?? `../pkg/...`）fetch。
- 供 `mosaic_decode`（画质切换）、`decompress_mtz`（默认包）使用。
- `src/default-pack.ts`：默认纹理包加载（幂等缓存）——内嵌 base64 优先，否则 `fetch('./textures.mtz')`。

## 2. 画质切换（原始纹理 / 压缩低清）

**数据源**：Worker 导出 GLB 前生成 manifest（`export_mosaic_manifest`，含地图 face + 模型贴图两套 key）→ scene-data 携带 → 主线程保存。

**链路**：

```
面板「纹理画质」radio
  → applyConfigPatch(config, 'texture', { quality })
  → renderer.applyConfigPatch('texture') → applyTextureQuality(quality)
  → 遍历 bspModelScene 材质收集 map（按贴图名去重）
  → mini：manifest[map.name 小写] → mosaic_decode(code, 8)
      → ImageBitmap → map.dispose() → map.image = bitmap → needsUpdate
  → original：恢复 origTextureImages 缓存的原图（同样 dispose）
```

**要点**：
- `map.dispose()` 必须在替换 image 前（three.js r152+ 增量上传 glTexSubImage2D 尺寸不符会越界失败）。
- 原始图像缓存 `origTextureImages`（Map<Texture, image>）——切回 original 时恢复。
- 主线程 wasm 懒初始化失败不影响场景加载（仅画质切换降级）。

## 3. 缺失纹理回退（GLB 导出期）

**Worker 侧（`physics-worker.ts` handleLoadBsp）**：

```
export_mosaic_manifest / export_missing_textures（借用，先于 GLB）
  → 默认纹理包：getMtzB64()（内嵌，经 wasm-init 的 mtzB64 下发）或 fetch('./textures.mtz')
  → decompress_mtz → JSON
  → export_glb_with_pakfile_models_with_defaults(defaultsJson)
      （Rust 侧：材质失败 → 查表 → 低清纹理嵌入 GLB；失败降级无回退导出）
```

**弹窗**（`app.ts` showMissingTextures）：加载后比对 `materials/<名小写>` → 绿色"已自动回退 N 个" / 红色"完全缺失 M 个"；确认按钮仅关闭（回退已在导出期完成）。

## 4. 关键代码位置

| 功能 | 文件 |
|---|---|
| 画质切换/贴图替换（含 dispose） | `src/renderer/renderer-main.ts`（applyTextureQuality / replaceMapWithMosaic） |
| 默认包加载（主线程） | `src/default-pack.ts` |
| 主线程 wasm（mosaic/decompress） | `src/main-wasm.ts` |
| Worker 默认包存取（内嵌下发） | `src/worker/mtz-data.ts` + `src/worker/main.ts`（wasm-init） |
| GLB 导出 + 回退调用 | `src/worker/physics-worker.ts` |
| 缺失弹窗 | `src/app.ts` + `web/index.html`（.mt-modal） |
