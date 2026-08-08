# game 材质模块（应用侧）

> 公共材质技术（mosaic 压缩 / MTZ 打包 / 解压拼装 / 回退机制）见 `docs/materials.md`。
> 本文档：game 侧的应用链路（与 debug 同机制，解析/导出在主线程）。

## 1. 与 debug 的差异

| 项 | debug | game |
|---|---|---|
| 解析/导出位置 | Worker | **主线程**（app.ts） |
| 默认纹理包消费 | Worker 经 `wasm-init` 消息 `mtzB64` 下发 | **主线程直接读** `__VBSP_TEXTURES_MTZ_B64__`（single）或 fetch |
| 缺失纹理弹窗 | 有（比对列表 + 确认） | 无（回退静默完成） |

## 2. 加载链路（`app.ts` handleLoadBsp）

```
借用导出（brush/tri/teleport/spawn/pvs）→ mosaicManifest（export_mosaic_manifest）
  → 默认纹理包：__VBSP_TEXTURES_MTZ_B64__（内嵌 atob）或 fetch('./textures.mtz')
  → decompress_mtz → JSON
  → export_glb_with_pakfile_models_with_defaults(defaultsJson)
      （Rust 侧缺失回退：材质失败 → 查表 → 低清纹理嵌入 GLB）
  → renderer.loadScene（GLB 自包含）
```

**前置**：`handleLoadBsp` 先 `await mainWasmReady`（主线程 wasm 初始化 promise——`decompress_mtz` 依赖，防竞态）。

## 3. 画质切换（`renderer-main.ts`）

```
面板「纹理画质」select → onTextureQualityChange 回调
  → renderer.applyTextureQuality(quality)
  → 遍历场景材质收集 map → manifest[map.name 小写]
  → mini：mosaic_decode(code, 8) → ImageBitmap → map.dispose() → map.image 替换
  → original：恢复 origTextureImages 缓存原图（同样 dispose）
```

- `map.dispose()` 必要性：three.js r152+ 增量上传 glTexSubImage2D 尺寸不符越界（详见 `docs/materials.md` §6）。
- 主线程 wasm 由渲染物理（PhysWorld）初始化，`mosaic_decode` 直接可用（无 debug 的懒初始化需求）。

## 4. 纹理参数约定

- 匹配键：`map.name` 小写 = GLB `texture.name`（basetexture 小写 / 模型材质名）→ manifest key（与 `export_mosaic_manifest` 输出一致）。
- 替换后纹理尺寸为 2 次幂（512/256/128，防 NPOT 钳制"田字分隔"）；半透明经 `T[opacity]` 补偿（玻璃等）。

## 5. 相关代码位置

| 功能 | 文件 |
|---|---|
| 默认包 + 回退导出 | `src/app.ts`（handleLoadBsp） |
| 画质切换 | `src/renderer/renderer-main.ts`（applyTextureQuality / replaceMapWithMosaic） |
| 内嵌 mtz（single 打包注入） | `game/scripts/build-dist.mjs` |
