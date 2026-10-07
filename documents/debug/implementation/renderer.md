# implementation：renderer

主题对应 `apps/debug/src/renderer/**` 与渲染共享层，本目录六个模块（主渲染器 `RendererMain` 与五个子模块——相机、LOD 剔除、路径记录、准星射线、碰撞可视化）；渲染共享层消费面共九个文件（2026-10-02 起下沉 shader/lightmap-shader 与 environment/{light,fog}-manager，2026-10-03 起 scene/{scene-builder,scene-optimizer,inject-stats} 与 camera/near-plane，2026-10-04 起 scene/{dispose,texture-quality}——后两者的模块行见本文末尾）。

## 模块职责

**`apps/debug/src/renderer/renderer-main.ts`**

导出 `CullStatsLike`（`apps/debug/src/renderer/renderer-main.ts:88`）、`RenderPhysEvent`（`apps/debug/src/renderer/renderer-main.ts:105`）、`RendererMain`（`apps/debug/src/renderer/renderer-main.ts:183`）。类内公开面按用途分五组：

- 生命周期：`init`（`apps/debug/src/renderer/renderer-main.ts:351`）、`disposeScene`（`apps/debug/src/renderer/renderer-main.ts:421`）、`loadScene`（`apps/debug/src/renderer/renderer-main.ts:482`）、`start` / `stop`（`apps/debug/src/renderer/renderer-main.ts:586` / `:562`）、`resize`（`apps/debug/src/renderer/renderer-main.ts:765`）。
- 物理线：`buildPredictionWorld`（`apps/debug/src/renderer/renderer-main.ts:961`）、`feedInput`（`apps/debug/src/renderer/renderer-main.ts:1009`）、`setPredictionState`（`apps/debug/src/renderer/renderer-main.ts:1074`）、`setPredictionParams` / `setPredictionHull` / `setPredictionNoclip`（`apps/debug/src/renderer/renderer-main.ts:1135` 起）、`respawn` / `teleportToSpawn` / `teleportToPos`（`apps/debug/src/renderer/renderer-main.ts:1162` 起）、`setSpawnPoints` / `setDeathY`（`apps/debug/src/renderer/renderer-main.ts:1184` / `:1162`）、`getCurrentVel` / `getCurrentState`（`apps/debug/src/renderer/renderer-main.ts:1199` / `:1232`）、`resetTo`（`apps/debug/src/renderer/renderer-main.ts:1237`）、`applyCollisionCorrection`（`apps/debug/src/renderer/renderer-main.ts:1247`）、`syncCameraToCurrentState`（`apps/debug/src/renderer/renderer-main.ts:997`）、`clearPendingInput`（`apps/debug/src/renderer/renderer-main.ts:1060`）。
- 回放相关（debug 专属）：`setReplayMode` / `isReplayMode`（`apps/debug/src/renderer/renderer-main.ts:1029` / `:1005`）、`setManualSteps`（`apps/debug/src/renderer/renderer-main.ts:1049`）、`captureReplayState`（`apps/debug/src/renderer/renderer-main.ts:1302`）、`captureFullPhysState` / `restoreFullPhysState`（`apps/debug/src/renderer/renderer-main.ts:1105` / `:1091`）。
- 路径记录：`startPathRecording` / `stopPathRecording` / `isPathRecording` / `clearPath`（`apps/debug/src/renderer/renderer-main.ts:785` 起）、四个分量显隐开关 `setPathRenderVisible` / `setPathTickVisible` / `setPathDeviVisible` / `setPathDotsVisible`（`apps/debug/src/renderer/renderer-main.ts:815` 起）、`getPathShapeStats` / `getPathDeviStats` / `getPathCounts`（`apps/debug/src/renderer/renderer-main.ts:839` 起）、`exportPathJson` / `exportPathCsv`（`apps/debug/src/renderer/renderer-main.ts:877` / `:851`）。**2026-09-26**：原 `setPathVisible` / `isPathVisible`（整组显隐与其查询）与唯一入口 `#pathVisibleChk` 一并删除——入口 id 在页面不存在，四个分量开关已覆盖其语义；`PathRecorder` 的 `setVisible` 与 `visible` getter 同步删除。
- 渲染侧配置：`applyConfigPatch`（`apps/debug/src/renderer/renderer-main.ts:889`）、`applyTextureQuality`（`apps/debug/src/renderer/renderer-main.ts:933`——2026-10-04 起算法本体在共享核 `src/renderer-shared/scene/texture-quality.ts:48`，本方法只保留诊断日志、`ensureMainWasm` 钩子与 `needsRender` 置位）、`setLightingMode` / `getLightingMode`（`apps/debug/src/renderer/renderer-main.ts:469` / `:464`）、`setCullDistance`（`apps/debug/src/renderer/renderer-main.ts:774`）、`setNearParams`（`apps/debug/src/renderer/renderer-main.ts:752`，转发共享控制器）、`getPlaneInfo`（`apps/debug/src/renderer/renderer-main.ts:760`）、`getPvsCluster`（`apps/debug/src/renderer/renderer-main.ts:1287`）。

本文件还持有三个模块级常量：`FOV`（`apps/debug/src/renderer/renderer-main.ts:76`）、`PLANE_INSPECT_INTERVAL`（`apps/debug/src/renderer/renderer-main.ts:78`）、`DEG2RAD`（`apps/debug/src/renderer/renderer-main.ts:1396`）。近平面三参数（near 下限 0.05 / 探测距离 100 / 收缩系数 0.3）与分块合并参数（cell 目标/区间/钳制、FRUSTUM_PAD）2026-10-03 起由渲染共享层承载（`src/renderer-shared/camera/near-plane.ts` 与 `src/renderer-shared/scene/scene-optimizer.ts`，数值与原 debug 常量一致）。

**`apps/debug/src/renderer/lod-manager.ts`**

导出 `LOD_LEVEL`（`apps/debug/src/renderer/lod-manager.ts:23`）、`LodStats`（`apps/debug/src/renderer/lod-manager.ts:48`）、`SceneDiagonalInfo`（`apps/debug/src/renderer/lod-manager.ts:68`）、`LodManager`（`apps/debug/src/renderer/lod-manager.ts:87`）。类内公开面：`setup`（`apps/debug/src/renderer/lod-manager.ts:121`）、`assignClusterIds`（`apps/debug/src/renderer/lod-manager.ts:181`）、`update`（`apps/debug/src/renderer/lod-manager.ts:222`）、`setCullDistance`（`apps/debug/src/renderer/lod-manager.ts:275`）、`getStats`（`apps/debug/src/renderer/lod-manager.ts:283`）、三个 getter（`apps/debug/src/renderer/lod-manager.ts:288` 起）、`dispose`（`apps/debug/src/renderer/lod-manager.ts:303`）。

**`apps/debug/src/renderer/collider-debug.ts`**

导出 `ColliderDebug`（`apps/debug/src/renderer/collider-debug.ts:397`），公开面：`init`（`:436`）、`setTriMeshes`（`:460`）、`setTriggers`（`:467`）、`setDebugFlags`（`:474`）、`setTriDebugFlags`（`:504`）、`update`（`:541`）、`hasDebugWork`（`:582`）、`clearAll`（`:900`）、`dispose`（`:908`）。可视化预算由常量给出：`DEBUG_Y_EXTENT`（`:40`）、`MAX_DEBUG_COLLIDERS`（`:42`）、`REBUILD_INTERVAL`（`:44`）、`TRI_REBUILD_INTERVAL`（`:46`）、`MAX_TRI_LINES`（`:48`）、`FILL_OPACITY`（`:50`）、七个语义颜色（`:59` 起）、两个 spawnflag 掩码（`:72`、`:73`）、两个几何容差（`:80`、`:82`）。

**面高亮只画物理真实面**：`orderedFaces`（`:189`）只接受上游标记 `isRealFace` 的平面（判据是「面上凸包顶点 ≥ 3 且不共线」，见 `documents/debug/implementation/world.md`），字段缺失一律不画。**物理侧的碰撞平面集里含有 BSP 原生 bevel 平面（过棱小平面），它们大多 `isRealFace === false`，因此不进线框；少数构成可量多边形的照实画**——bevel 过棱、不放大实体体积，只有构成有面积的多边形才是一张能站能撞的表面。原「显示切角面」一路（`setChamferDebugFlags` 与页面对应控件）已于 2026-10-04 整体删除；运行时合成切角平面的机制也已于 2026-10-07 整段撤除、由原生 bevel 接管（取证与实测见 `documents/open-issues/01-chamfer-is-not-a-bevel.md` §9）。**这条闸门曾误伤触发器**：触发器平面不来自世界 brush 判据、不带 `isRealFace` 字段，「未知即不画」把触发器线框整条滤空（回归：开关打开、组可见、子对象恒为 0）——触发器体积本来就是整只凸包，`rebuildTriggers` 现已显式给它的平面标 `isRealFace: true`（2026-10-07 修）。
**bevel 辅助面线框（第五路，白）**：`showBevel` 开关（默认关）经 `setBevelVisible` 独立成组，画的是 **bevel 平面被 brush AABB 截出的截面**（Sutherland–Hodgman 逐 AABB 半空间裁剪，沿法线外移 0.5 HU），半透明填充 + 描边。为什么画 AABB 截面而不是凸包相交轮廓：bevel 平面与凸包的交集通常只是棱线上的线段，贴着凸包画与实体面线框无法区分；而截面天然溢出斜面 brush 的实体材质之外——这正是 bevel 的碰撞角色（参与盒体扩张后的支撑）。可视距离复用 brush 可视距离；描边 `depthTest` 关闭使其始终可见。`surf_666` 实测（视距 16384、800 brush 封顶）：bevel 平面 1655 / 截面 1593 / 三角形 3186，出生点刀脊 brush 的顶部 box bevel（水平面、比脊线高 1.3 HU）整张在列。三条首版缺陷的修正（2026-10-07）：① 面内正交基的参考轴取**与法线分量最小**的坐标轴——首版取了最同向轴，轴向法线（box bevel 全是轴向）叉积恒为零、截面退化成一点，顶部 bevel 一张都画不出来；② 与同 brush 某条非 bevel 平面**共面**（法线逐分量差 < 1e-4 且 dist 差 < 0.1 HU）的 bevel 不画——VBSP 的 edge bevel 偶尔与既有真实面同面（surf_666 刀脊 brush 只有东坡有这条共面 bevel，画出来即「实体面上贴白纸」且西坡无对应物；全图 16976 条 bevel 平面中 1800 条属此类），它在碰撞里与那条真实面等效；③ 近距筛选的 `distSq` 真算进排序键——首版收集时恒写 0、排序空转，超上限按数组序截断，视距拉远后名额被远处 brush 占满、相机附近的反而消失。`rebuildSolids` 的同款空转排序一并修正（截断改为按真实距离取最近的 `MAX_DEBUG_COLLIDERS` 个）。原理与 `is_bevel` 字段口径见 `documents/debug/implementation/world.md`。

**`apps/debug/src/renderer/path-recorder.ts`**

导出 `PathPoint`（`apps/debug/src/renderer/path-recorder.ts:46`）、`DistStats`（`:66`）、`PathRecorder`（`:330`）。公开面：`isRecording`（`:396`）、`start` / `stop`（`:402` / `:409`）、`counts`（`:418`）、`addRender`（`:431`）、`addTick`（`:459`）、`shapeStats`（`:586`）、`deviStats`（`:618`）、`perpStats` / `residualStats`（`:641` / `:648`）、`clear`（`:658`）、四个可见性开关（`:687` 起）、`toJson` / `toCsv`（`:721` / `:756`）、`dispose`（`:771`）。内部 `LineBuffer`（`:175`）承担三种绘制模式（`line` / `points` / `segments`，`apps/debug/src/renderer/path-recorder.ts:115`）。

**`apps/debug/src/renderer/plane-inspector.ts`**

导出 `PlaneInspector`（`apps/debug/src/renderer/plane-inspector.ts:50`），唯一公开方法是 `cast`（`:71`）：先对 GLB 场景做 mesh 射线，再对 solid / ladder brush 求交，最后测传送触发器 AABB。常量 `DEFAULT_MAX_DISTANCE`（`:38`）与 `EPS`（`:44`）；AABB 求交在 `apps/debug/src/renderer/plane-inspector.ts:403`。

**`src/renderer-shared/environment/light-manager.ts`**（渲染共享层，2026-10-02 自本工程 `apps/debug/src/renderer/light-manager.ts` 下沉；入参类型由应用侧 `RuntimeConfig` 换为文件内结构等价的 `ConfigWithLighting`——共享层不反向依赖 `apps/**`，调用点与逻辑零改动）

导出 `LightingUpdateParams`（`src/renderer-shared/environment/light-manager.ts:61`）与 `LightManager`（`:87`）。公开面：`applyLights`（`:126`）、`extractPointLights`（`:170`）、`updatePointLights`（`:223`）、`updateLighting`（`:277`）、`syncFromConfig`（`:320`）、`activePointLightCount`（`:355`）、`dispose`（`:366`）。上限 `MAX_POINT_LIGHTS` 与平行光距离 `DIR_LIGHT_DISTANCE` 在 `src/renderer-shared/environment/light-manager.ts:75` / `:78`。

**`src/renderer-shared/environment/fog-manager.ts`**（渲染共享层，2026-10-02 自本工程 `apps/debug/src/renderer/fog-manager.ts` 原样下沉；本类在全仓无装配点——没有文件 import 它）

导出 `FogManager`（`src/renderer-shared/environment/fog-manager.ts:21`）：`init`（`:40`）、`update`（`:61`）、`setColor`（`:80`）、`setEnabled`（`:90`）、`isEnabled`（`:98`）、`currentSceneRadius`（`:103`）、`dispose`（`:108`）；默认雾色 `DEFAULT_FOG_COLOR` 在 `src/renderer-shared/environment/fog-manager.ts:15`。

**`apps/debug/src/renderer/camera-controller.ts`**

导出 `CameraController`（`apps/debug/src/renderer/camera-controller.ts:21`）：构造（`:39`）、`update`（`:46`）、`setYawPitch`（`:69`）、`setPosition`（`:80`）、`applyInputConfig`（`:85`）。

**`src/renderer-shared/shader/lightmap-shader.ts`**（渲染共享层单实例，2026-10-02 由三工程各自 `apps/<app>/src/renderer/lightmap-shader.ts` 的三份同构副本合并而来，本工程经 tsconfig include 收编、深层相对路径 import；不再是本工程目录内的文件）

本工程消费的最重渲染模块，导出面分四类：

- GLSL 片段与属性名：`VBSP_DECOMPRESS_LIGHTMAP_SAMPLE`（`src/renderer-shared/shader/lightmap-shader.ts:87`）、`VBSP_APPLY_LIGHTMAP`（`:112`）、`VBSP_LIGHTMAP_UNIFORM_DECLS`（`:165`）、`VBSP_AMBIENT_UNIFORM_DECLS`（`:181`）、`VERTEX_LIGHTING_ATTR`（`:198`）。
- 装配入口：`loadLightmapAtlas`（`:374`）、`applyLightmapToMeshes`（`:482`）、`fullbrightUnlitLitMaterials`（`:1067`）、`installGamma22Output`（`:255`）。
- 光照模式：`LightingMode`（`:421`）、`setLightingMode`（`:436`）、`getLightingMode`（`:442`）、`isTextureOnlyMode`（`:447`）。
- 诊断 / A-B 覆盖：`LightmapStage` 与 `readLightmapStage` / `isLightmapSkipStage`（`:284`、`:304`、`:313`）、`LIGHTMAP_UV_CHANNEL_CORRECT` 与 `resolveLightmapUvChannel`（`:329`、`:338`）、`getVertexLightingRelaxStats`（`:1674`）、`setPropVertexRelax` / `getPropVertexRelax`（`:1686` / `:1691`）、`setPropVertexFlatten` / `getPropVertexFlatten`（`:1705` / `:1710`）、`setLightFloor` / `getLightFloor`（`:1752` / `:1757`）、`setLightGamma` / `getLightGamma`（`:1788` / `:1795`）、`setExposure` / `getExposure`（`:1807` / `:1817`）、`setAmbientScale` / `getAmbientScale`（`:1829` / `:1836`）。

**`src/renderer-shared/scene/dispose.ts`**（渲染共享层，2026-10-04 Phase 4 自三份同源分叉合并——debug 的 11 贴图槽位版为基准，game/viewer 消费同一实现）

导出 `disposeObject`（`src/renderer-shared/scene/dispose.ts:16`）：逐 Mesh 释放几何、材质及其引用的 11 类贴图槽位（map/lightMap/emissive/normal/roughness/metalness/ao/alpha/bump/specular/env），重复 dispose 幂等；本工程在 `disposeScene` 的 `isBspModel` 子树析构处调用（`apps/debug/src/renderer/renderer-main.ts:427`）。

**`src/renderer-shared/scene/texture-quality.ts`**（渲染共享层，2026-10-04 Phase 4 合并 game/debug 各自的 `applyTextureQuality` + `replaceMapWithMosaic` 同源副本）

导出 `applyTextureQuality`（`src/renderer-shared/scene/texture-quality.ts:48`）与 `MosaicDeps` / `TextureQualityResult`；`decode` 由应用注入（`pkg/websurf_wasm.js` 的 `mosaic_decode`），`ensureWasm` 钩子本工程传 `ensureMainWasm`；统计经返回值交应用侧打印。

## 关键流程与不变量

**一帧的固定顺序**：物理段 → 视距剔除 → 碰撞可视化 → 限流准星射线 → 渲染 → 剔除统计（`apps/debug/src/renderer/renderer-main.ts:610` 起；各步锚点见 `documents/debug/sequences.md` 的帧链一节）。

**相机位姿唯一来源是渲染物理**：`tick` 每帧从 `predPhys.state()` 取 `posX/posY/posZ`、`yaw`、`pitch`、`eyeHeight`，yaw/pitch 由度换弧度后交给 `CameraController.setYawPitch`，相机位置取「脚底 + 眼高」（`apps/debug/src/renderer/renderer-main.ts:675`、`apps/debug/src/renderer/renderer-main.ts:676`、`apps/debug/src/renderer/renderer-main.ts:679`）。主线程不保留插值副本。

**地图装配（2026-10-04 起与 game/viewer 同一条共享链路）**：`loadScene` 走共享 `buildMapScene`
（GLB → 子场景 + 清根 rotation + 世界包围盒 + **摘 punctual 灯**，此前本工程自持 loadGlb 且保留 GLB 内嵌灯——surf_666 上 2118 盏灯重复计光且推高 uniform，是三应用观感分歧来源之一）
→ 共享 `applyLightmap` → 分块合并 → **合并后 fullbright 终扫**（与 game 同序）→ `renderer.compile` 预编译；
`init` 按 game 同值落五个光照旋钮（exposure 2.3 / lightGamma 2.2——落在接受窗口外被忽略 / ambientScale 1 / propVertexRelax 1 / propVertexFlatten 0.85），
`LightManager` 三盏基础灯默认强度归零（`apps/debug/src/config.ts:209` 起的默认值改动；面板仍可拉高做光照对照，但终扫收敛为 fullbright 的 mesh 不再响应这些灯）。
锚点：`apps/debug/src/renderer/renderer-main.ts:482` 到 `apps/debug/src/renderer/renderer-main.ts:522`。

**近平面自适应只改投影矩阵**：实现在共享 `NearPlaneController.update`（`src/renderer-shared/camera/near-plane.ts:65`，2026-10-03 起本工程不再持有副本）：候选 `roots` 直通 `bspModelScene` 子树（等价于旧的 scene.traverse），沿 4 个水平正交方向各投一条长度为 probe 的射线取最近命中，命中则 `near = max(minD × ratio, CAMERA_NEAR_MIN)`，无命中回到 `defaultNear`；与当前值相差超过 0.001 才写入。调用点（`apps/debug/src/renderer/renderer-main.ts:684`）保留了 noclip 跳过与隔帧节拍；`setNearParams`（`apps/debug/src/renderer/renderer-main.ts:752`）转发共享控制器并照旧置 `needsRender`。

**LOD 剔除的判据与取值**：判据只有「块中心到相机距离平方 > `cullDistance` 的平方」一条，不带迟滞、不查 PVS（`apps/debug/src/renderer/lod-manager.ts:231`）；每 `lod.updateInterval` 帧才判一轮（`apps/debug/src/renderer/lod-manager.ts:226`），只有可见性翻转时才写 `mesh.visible` 并把返回值置真（`apps/debug/src/renderer/lod-manager.ts:246`）。距离取值：上限 = 对角线 ×4 上取整到 100 HU，默认 = min(对角线 ×2, max(12800, 最大边 ×0.5))（`apps/debug/src/renderer/lod-manager.ts:155` 起）。

**路径记录两条线与两种度量**：

- 渲染线 = 每个 rAF 物理步一点，取脚底坐标（`apps/debug/src/renderer/renderer-main.ts:669`）；tick 线 = 权威版本号 `va` 变化时一点，时间戳取发布时钟 τ（`apps/debug/src/renderer/renderer-main.ts:646` 起）。
- 垂距与偏差梳是两个不同度量：垂距是 tick 点到渲染折线的最短距离，偏差梳是同一时刻两点之差；面板上分开标注（`apps/debug/src/app.ts:641` 起）。
- 折线自检按长度比给出：直连为 1.000，超过 1.15 标红（`apps/debug/src/app.ts:653` 起）。

**分块合并（`optimizeScene`）**：GLB 挂载后执行一次（`OPTIMIZE_SCENE_ENABLED` gating，`apps/debug/src/renderer/renderer-main.ts:123`、调用点 `:491`），把 GLTFLoader 的逐 primitive Mesh 合并成空间块；算法在共享核 `src/renderer-shared/scene/scene-optimizer.ts:75`（与 game 同一份），本工程私有方法（`:1394`）只做薄委托并经 `normalizeGroup` 钩子注入 `normalizeMergeGroup`（混合 indexed/非 indexed 与混合 gpuType 的合并前归一——debug 特有健壮化，game/viewer 不传钩子）；顺序固定在 lightmap 应用之后、LOD/PVS 注册之前。

**渲染采样传输**：同一帧先落 `PathRecorder` 渲染节点、再写共享内存渲染采样槽，`i0` 用同一次自增，保证「渲染节点下标 = 采样下标」（`apps/debug/src/renderer/renderer-main.ts:669`、`apps/debug/src/renderer/renderer-main.ts:673`）。

**回放模式的边界**：`setReplayMode(true)` 只关掉权威→渲染方向的两项实时耦合（`correctFromAuthority` 与 `calibrateVelocity`），共享内存输入槽照写、渲染与路径记录逻辑不动（`apps/debug/src/renderer/renderer-main.ts:1029` 起）。

**lightmap 着色器**：光照模式切换不重建场景、不重编译材质，只改一个全场景共享 uniform（`apps/debug/src/config.ts:101`）；图集加载在两种模式下完全一致（`apps/debug/src/config.ts:101`）。着色器本体是渲染共享层单实例 `src/renderer-shared/shader/lightmap-shader.ts`（2026-10-02 由三工程各自一份的同构副本合并而来，旧副本已删除，三工程消费同一文件）。

## 已知缺口

1. **PVS 列不反映隐藏数**：`LodStats.pvsHidden` 在 `update` 的统计刷新里每轮恒写 0（`apps/debug/src/renderer/lod-manager.ts:262`），而面板剔除统计行把它作为「隐藏 N」打印（`apps/debug/src/app.ts:624`），页面 `#cullStats` 也带「PVS」列（`apps/debug/web/index.html:867`）。真正被隐藏的块数是 `far`（`apps/debug/src/renderer/lod-manager.ts:261`）。
2. **PVS 相关统计在本工程恒为缺省值**：`RendererMain` 只构造 `PvsManager`、把 `getClusterAt` 交给 `assignClusterIds` 用、并读 `getStats` / `currentClusterId`，**从不调 `update`**，因此剔除统计里的 `cluster` 恒 -1、`visibleClusters` 恒 0（`apps/debug/src/renderer/renderer-main.ts:191` 起、`apps/debug/src/renderer/renderer-main.ts:547`）。
3. **`LOD_LEVEL.PVS_HIDDEN` 是预留档位**：该常量在本文件内零引用，`update` 从不写入（`apps/debug/src/renderer/lod-manager.ts:26`）；`LodItem.clusterIds` 同样在本文件内无消费方（`apps/debug/src/renderer/lod-manager.ts:40`）。
4. **`assignClusterIds` 的结果无消费方**：返回的「采到至少一个 cluster 的 mesh 数量」在 `loadScene` 里没有被使用（`apps/debug/src/renderer/lod-manager.ts:181`）。
5. **tick 线的时间戳在无发布时钟时回落墙钟**：`readPublishedTau()` 返回 0 时用 rAF 时间戳 `now`（`apps/debug/src/renderer/renderer-main.ts:648`），两条线的时间基准在此时不同源。
6. **权威 post-tick 位置差（residual）恒不记录**：`addTick` 的第六个实参固定传 `undefined`（`apps/debug/src/renderer/renderer-main.ts:652`），该组统计的样本数保持 0（`apps/debug/src/renderer/path-recorder.ts:648`）。
7. **`lightmap-shader.ts` 的诊断覆盖只从全局键读**：`window.__vbsp*` 系列覆盖（如 `src/renderer-shared/shader/lightmap-shader.ts:1745` 的 `readLightFloorOverride`）在模块初始化时就固化成 uniform 初值（`src/renderer-shared/shader/lightmap-shader.ts:1549`、`:1556`、`:1563`、`:1580`），运行期注入不改变已创建的 uniform。
8. **准星射线是限流采样**：每 `PLANE_INSPECT_INTERVAL` 帧才检测一次，关闭开关时只清空上次结果，不做新检测（`apps/debug/src/renderer/renderer-main.ts:712`）。
