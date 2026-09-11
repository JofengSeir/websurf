# 地图加载与世界构建（维度 I）

> 前置阅读：[../overview.md](../overview.md) §3、[../sequences.md](../sequences.md) §4。本文覆盖：入口处理 → ts-shared 构建管线 → BspProcessor 导出面 → 双端世界构建 → 渲染侧装载 → 纹理回退 → 构建脚本。渲染子系统的装载细节在 [rendering.md](rendering.md)。

## 1. 入口：文件选择到主线程加载

```
<input id="bspFile"> change ─→ handleBspFile(file)      apps/debug/src/app.ts:1256-1280
  1. await mainWasmReady（主线程 wasm 先就绪：handleLoadBsp 的 decompress_mtz 依赖）
  2. rendererMain.disposeScene()      —— 卸载旧地图全部 GPU 资源（递归 dispose geometry/
     material/11 类纹理槽 + renderLists.dispose + 子管理器状态清零 + calibrator.clear()）
     （renderer/renderer-main.ts:253-292,294-325）
  3. teleportMapName = file.name；lastTeleportIdx = -1（传送下拉去重器复位）
  4. handleLoadBsp(file.name, arrayBuffer)
```

## 2. ts-shared 构建管线：buildWorldBundle（`src/ts-shared/phys/world-builder.ts`）

`handleLoadBsp` 的核心一步是共享管线 `buildWorldBundle(new BspProcessor(bytes), options)`（`app.ts:1292-1298`），它把 `BspProcessor` 的字节级导出收敛为 `WorldBundle`（`world-builder.ts:51-68`：metadata / brushJson / triJson / teleportJson / spawnJson / pvsJson / glbBytes / mosaicManifest / missingTextures / spawn / spawnList）。debug 传入的 options（`app.ts:1292-1298`）：

| option | debug 取值 | 作用 |
|---|---|---|
| `colliderSource` | `config.physics.colliderSource`（'auto' 默认） | 模型碰撞来源三档，见 §4.2 |
| `collectMissingTextures` | `true` | 收集缺失材质纹理列表（game 不开启） |
| `decompressMtz` | 主线程 wasm 的 `decompress_mtz` | 默认纹理包解压注入 |
| `onProgress` | 刷侧栏状态行 | 每阶段回调后 `setTimeout 0` 让出主线程（`world-builder.ts:100-106`） |

管线阶段（`world-builder.ts:96-254`）：

1. **metadata**（`proc.metadata()` → WorldMetadata；debug 面板展示 magic/numLeaves/numNodes/numEntities/numStaticProps/packedFiles 等扩展字段，`app.ts:1391-1409` renderMetadata）；
2. **借用导出** spawn/teleport/pvs（`parse_spawn_points` / `parse_teleports` / `parse_pvs_data`，一次性 JSON 字符串）；
3. **碰撞体**：`export_brushes_planes(DEFAULT_BRUSH_FILTER)`（include_ladder/include_solid true、min_brush_volume 0、skip_sky true、skip_nodraw false，`world-builder.ts:83-89`）+ 模型三角形（按 colliderSource 三档，§4.2）；
4. **mosaic manifest**（`export_mosaic_manifest`，纹理画质切换数据源；失败缺省）；
5. **缺失纹理**（`export_missing_textures`，debug 特有）；
6. **默认纹理包回退**：内嵌 base64（`__VBSP_TEXTURES_MTZ_B64__`）或 fetch `./textures.mtz` → `decompressMtz` → defaultsJson；
7. **GLB 导出**：`export_glb_with_pakfile_models_with_defaults(defaultsJson)`（构建期把默认低清纹理烧进 GLB），失败回退 `export_glb_with_pakfile_models()`；
8. **出生点解析**：`primary`（优先 info_player_start）→ `spawn {x,y,z,yawDeg}`；`spawnList = [[x,y,z,yaw],…]`，yaw 统一经 `bspYawToCsYaw`（`cs_yaw = wrap(bsp_yaw + 180)`，`world-builder.ts:91-101`；旧式 270− 为 det=−1 镜像，2026-09 修正）。无出生点回退 `(0,100,0)`。
   - 注：`apps/debug/src/world/spawn-loader.ts` 是同一逻辑的**预留工具副本**，全仓无 import（文件头自述 `spawn-loader.ts:8-11`），活跃链路在 world-builder。

## 3. BspProcessor 导出面（`apps/debug/crates/wasm/src/lib.rs`）

debug WASM 绑定层的核心导出（`lib.rs:293-2274`；全部被 `world-builder.ts:19-31` 的 `BspProcessorLike` 结构性接口消费）：

| 方法 | 输出 |
|---|---|
| `metadata()` | WasmBspMetadata JSON（`world/types.ts:185-204`） |
| `parse_spawn_points()` | WasmSpawnReport（snake_case；`world/types.ts:52-71`） |
| `parse_teleports()` | WasmTeleportReport（teleports/triggers/links/orphan 统计；`world/types.ts:78-134`） |
| `parse_pvs_data()` | WasmPvsData（nodes/leaves/faceClusters/pvsBitsBase64，camelCase；`world/types.ts:141-178`） |
| `export_brushes_planes(filter_json)` | WasmBrush[]（planes 已 Y-up 旋转 + 法线翻转朝外；`world/types.ts:26-45`） |
| `export_model_tri_colliders()` / `export_model_phy_colliders()` | WasmTriMesh[]（visual 网格 / .phy 碰撞网格，surfaceprop 区分） |
| `export_mosaic_manifest()` / `export_missing_textures()` | 画质 manifest / 缺失纹理列表 |
| `export_glb_with_pakfile_models(_with_defaults)` | GLB 字节（PAKFILE 模型；defaults 版构建期烧入默认纹理） |

**坐标与法线约定**（`world/collider-adapter.ts:1-8` 头注）：Rust 端完成 `[x,y,z]→[y,z,x]`（det=+1）Y-up 旋转与法线翻转（vbsp 法线朝内 → cs-movement 法线朝外），TS 端不再二次处理；`dist` 是旋转不变量。

**chamfer 生成（本项目 WASM 层特性）**（`lib.rs:2551-2690`，export_brushes_planes 内）：对凸包每条真实棱（两个非平行平面共享 ≥2 顶点）构造切角平面——法线 = 两相邻面法线的归一化均值 `normalize(n_i + n_j)`，过棱上一顶点，且**必须位于凸包外侧**（其余顶点全部同侧校验，否则丢弃）。chamfer 平面并入 `brush.planes` 一并输出：既进物理碰撞（高速盒角平滑入坡），也供调试线框把"只过棱不构成面"的平面单独标黄（[rendering.md §6](rendering.md)）。同一实现存在于 game crate（`apps/game/crates/wasm/src/lib.rs:1973-2086`），共享 wasm-core 不含——属双工程各自携带的重复层，见 [../differences.md §7](../differences.md)。

## 4. 双端世界构建

### 4.1 渲染线（主线程）

`handleLoadBsp` 随后（`app.ts:1298-1388`）：

1. `rendererMain.loadScene(sceneData)` —— GLB 加载/lightmap/PVS/传送触发器/雾/LOD 注册（详见 [rendering.md §2](rendering.md)）；完成时触发 `onSceneLoaded(deathY)`：`sceneDeathY` 存档、`rendererMain.setDeathY(y)`、`inputBridge.sendSetDeathThreshold(y)`（`app.ts:250-258`；初次会被 Worker 丢弃，§6 重发）；
2. `rendererMain.buildPredictionWorld({brushJson,triJson,teleportJson,spawn})` —— 主线程 `new PhysWorld()` + `build_world(...)`（`renderer-main.ts:745-771`）；`adaptBrushes(brushJson)` 先把 WasmBrush JSON 反腐化为 cs-movement `Brush[]`/`LadderVolume[]`（`world/collider-adapter.ts`；skipped 诊断统计）；
3. `setPredictionParams(buildPredictionParams(config))` + `setPredictionHull(16,72,54)` + `setPredictionNoclip(mode)`；
4. `rendererMain.setSpawnPoints(spawnList)`。

### 4.2 colliderSource 三档

| 档 | 语义 | world-builder 行为 |
|---|---|---|
| `auto` | 优先 .phy（vmdl 自带碰撞），缺失回退 visual | `export_model_phy_colliders` → 空则 `export_model_tri_colliders` → 再空则 `'[]'` |
| `visual` | 强制可视网格三角形 | `export_model_tri_colliders` |
| `phy` | 强制 .phy | `export_model_phy_colliders` |

（`world-builder.ts:33` 类型 + 管线分支；`config.ts` 默认 `colliderSource: 'auto'`。）

### 4.3 权威线（Worker）

同一份字节经 `inputBridge.sendWorldJson(...)` 发给 Worker（渲染不消费其输出，两端并行构建同结果，`app.ts:1351-1353` 注释）：

```
world-json 消息 → createWorkerDispatch 内部（src/ts-shared/auth/worker-dispatch.ts）：
  wasm-init 未就绪 → 忽略该消息（主线程顺序保证 wasm-init 先行）
  就绪 → phys.current = new PhysWorld()
       → build_world(brushJson, triJson, teleportJson, spawn.x, spawn.y, spawn.z, spawn.yawDeg)
       → syncParamsToWasm()（buildPhysicsParams + set_hull，apps/debug/src/worker/main.ts:50-77）
       → setFixedDt(config.physics.tickRate) + authLoop.reset()（防新旧步长错配）
       → onWorldBuilt(phys) = physicsWorker.attachWorld(phys)（面板参数重应用挂载点）
```

Rust 侧 `build_world`（`src/phys/mod.rs:103-158`）：brush JSON → `World.solids/ladders`（凸平面碰撞）、tri JSON → 模型三角形碰撞、teleport JSON → TeleportManager、spawn 存档。`build_world` 与 `BspProcessor` 生命周期解耦（Worker 只收 JSON 字符串，不持有解析器）。

## 5. Worker 加载顺序契约

| 消息 | 前置条件 | 行为 |
|---|---|---|
| `wasm-init` | 最早发送（main() 第 3 步，`app.ts:221-234`） | `initSync({module})`（必须同步初始化，`worker-dispatch.ts:50-60`）→ `ready=true` → `authLoop.start()`（一次） |
| `init` | main() 第 4 步 | `createWorkerSharedState(shared)`；debug 回执 `ready`（`main.ts:106-108`） |
| `world-json` | 依赖 wasm-init | §4.3；未就绪则**静默忽略**（`worker-dispatch.ts:45-47`） |
| `set-death-threshold` | 依赖 world-json | `phys.set_death_y(value)`（`worker-dispatch.ts:206-214`）——初发被丢，`handleLoadBsp` 末尾重发（`app.ts:1362-1363`） |

## 6. 纹理与缺失纹理回退链

1. **构建期**（GLB 导出）：`export_glb_with_pakfile_models_with_defaults` 把默认纹理包中能匹配的低清纹理直接烧入 GLB（`world-builder.ts` GLB 阶段）——渲染器对此零后处理（`renderer-main.ts` 纹理回退注释）；
2. **运行期比对**（debug 特有）：场景就绪回调 `onSceneReadyUi`（`app.ts:338-349`）触发 `showMissingTextures`（`app.ts:410-451`）：`loadDefaultTexturePack()`（`default-pack.ts`：内嵌 `__VBSP_TEXTURES_MTZ_B64__` → atob → decompress_mtz → JSON.parse → cachedPack；或 fetch `./textures.mtz`；两路都失败返回 null = 比对跳过）后把 GLB 实际材质集合与默认包逐键比对：缺失→"缺失材质"列表；多余→"孤儿默认纹理"列表，弹模态窗供排查；
3. **画质切换**：mosaic manifest + `mosaic_decode(code, 8)` 运行时替换贴图（original/mini 两档，见 [rendering.md §7](rendering.md)）。

主线程 WASM 懒初始化（`apps/debug/src/main-wasm.ts`）：single 打包时 `__VBSP_WASM_B64__` → atob → `initSync`；否则 fetch `mainWasmUrl()`（`__VBSP_WASM_URL__` ?? `'../pkg/websurf_wasm_bg.wasm'`）。与 Worker 实例互不影响（两个实例、各自线性内存）。single 模式 Worker 侧内嵌 mtz 由 `worker/mtz-data.ts`（`__VBSP_TEXTURES_MTZ_B64__` 存取）承接——仅协议兼容，Worker 已不解析 BSP。

## 7. 构建脚本与产物

| 命令 | 脚本 | 产物/行为 |
|---|---|---|
| `npm run build:wasm` | wasm-pack（`--release --target web --out-dir ../../pkg`；`wasm-opt=false`，`Cargo.toml:89-90`） | `apps/debug/pkg/websurf_wasm.js` + `.wasm` |
| `npm run build:app` / `build:worker` | esbuild → `web/app.js` / `web/worker.js`（ESM、es2022） | dev 页面直接可用 |
| `npm run build:dist` | `scripts/build-dist.mjs` | **single**（默认）：classic script + IIFE `dist/app.js`，WASM/Worker/mtz 全部 base64 内嵌，file:// 双击可用；**multi**（`--multi`）：module script，wasm/mtz 外置 fetch（`build-dist.mjs:1-14`）。esbuild `legalComments:'eof'` 保留 @unsurf/cs-movement Apache-2.0 法律注释；`define: {'import.meta.url':'about:blank'}`（IIFE 不支持 import.meta.url） |
| `npm run check:api` | `scripts/check-wasm-api.mjs` | 比对 pkg 导出符号 vs TS 导入符号，100% 匹配才退出 0 |

## 8. 场景数据结构与跨地图重置

- 渲染侧场景数据由主线程本地构造（`SceneDataMessage`，`worker/worker-types.ts`）：glb 字节 + spawnJson/pvsJson/teleportJson/brushJson/triJson + mosaicManifest + 对角线/剔除范围；
- 换地图重置链：`disposeScene()`（渲染资源）+ `predPhys=null`/`predReady=false`/`calibrator.clear()`（防旧权威帧注入新地图，`renderer-main.ts:280-291`）+ `game.reset()`（计时挑战状态清零）+ `lastTeleportIdx=-1`；
- `world/types.ts`（231 行）是 WASM↔TS 的完整字段契约（对比 game 仅 34 行 PVS 类型，见 [../differences.md §6](../differences.md)）。
