# implementation：renderer

主题对应 `apps/debug/src/renderer/**` 与渲染共享层，本目录六个模块（主渲染器 `RendererMain` 与五个子模块——相机、LOD 剔除、路径记录、准星射线、碰撞可视化）；渲染共享层消费面共九个文件（2026-10-02 起下沉 shader/lightmap-shader 与 environment/{light,fog}-manager，2026-10-03 起 scene/{scene-builder,scene-optimizer,inject-stats} 与 camera/near-plane，2026-10-04 起 scene/{dispose,texture-quality}——后两者的模块行见本文末尾）。

## 模块职责

**`apps/debug/src/renderer/renderer-main.ts`**

导出 `CullStatsLike`（`apps/debug/src/renderer/renderer-main.ts:90`）、`RenderPhysEvent`（`apps/debug/src/renderer/renderer-main.ts:107`）、`RendererMain`（`apps/debug/src/renderer/renderer-main.ts:185`）。类内公开面按用途分五组：

- 生命周期：`init`（`apps/debug/src/renderer/renderer-main.ts:361`）、`disposeScene`（`apps/debug/src/renderer/renderer-main.ts:429`）、`loadScene`（`apps/debug/src/renderer/renderer-main.ts:490`）、`start` / `stop`（`apps/debug/src/renderer/renderer-main.ts:627` / `:625`）、`resize`（`apps/debug/src/renderer/renderer-main.ts:878`）。
- 物理线：`buildPredictionWorld`（`apps/debug/src/renderer/renderer-main.ts:964`）、`feedInput`（`apps/debug/src/renderer/renderer-main.ts:995`）、`setPredictionState`（`apps/debug/src/renderer/renderer-main.ts:1077`）、`setPredictionParams` / `setPredictionHull` / `setPredictionNoclip`（`apps/debug/src/renderer/renderer-main.ts:1138` 起）、`respawn` / `teleportToSpawn` / `teleportToPos`（`apps/debug/src/renderer/renderer-main.ts:1148` 起）、`setSpawnPoints` / `setDeathY`（`apps/debug/src/renderer/renderer-main.ts:1187` / `:1296`）、`getCurrentVel` / `getCurrentState`（`apps/debug/src/renderer/renderer-main.ts:1205` / `:1366`）、`resetTo`（`apps/debug/src/renderer/renderer-main.ts:1226`）、`applyCollisionCorrection`（`apps/debug/src/renderer/renderer-main.ts:1236`）、`syncCameraToCurrentState`（`apps/debug/src/renderer/renderer-main.ts:1003`）、`clearPendingInput`（`apps/debug/src/renderer/renderer-main.ts:1066`）。
- 回放相关（debug 专属）：`setReplayMode` / `isReplayMode`（`apps/debug/src/renderer/renderer-main.ts:1035` / `:1139`）、`setManualSteps`（`apps/debug/src/renderer/renderer-main.ts:1055`）、`captureReplayState`（`apps/debug/src/renderer/renderer-main.ts:1291`）、`captureFullPhysState` / `restoreFullPhysState`（`apps/debug/src/renderer/renderer-main.ts:1094` / `:1225`）。
- 路径记录：`startPathRecording` / `stopPathRecording` / `isPathRecording` / `clearPath`（`apps/debug/src/renderer/renderer-main.ts:773` 起）、四个分量显隐开关 `setPathRenderVisible` / `setPathTickVisible` / `setPathDeviVisible` / `setPathDotsVisible`（`apps/debug/src/renderer/renderer-main.ts:820` 起）、`getPathShapeStats` / `getPathDeviStats` / `getPathCounts`（`apps/debug/src/renderer/renderer-main.ts:827` 起）、`exportPathJson` / `exportPathCsv`（`apps/debug/src/renderer/renderer-main.ts:865` / `:984`）。**2026-09-26**：原 `setPathVisible` / `isPathVisible`（整组显隐与其查询）与唯一入口 `#pathVisibleChk` 一并删除——入口 id 在页面不存在，四个分量开关已覆盖其语义；`PathRecorder` 的 `setVisible` 与 `visible` getter 同步删除。
- 渲染侧配置：`applyConfigPatch`（`apps/debug/src/renderer/renderer-main.ts:894`）、`applyTextureQuality`（`apps/debug/src/renderer/renderer-main.ts:939`——2026-10-04 起算法本体在共享核 `src/renderer-shared/scene/texture-quality.ts:48`，本方法只保留诊断日志、`ensureMainWasm` 钩子与 `needsRender` 置位）、`setLightingMode` / `getLightingMode`（`apps/debug/src/renderer/renderer-main.ts:465` / `:483`）、`setCullDistance`（`apps/debug/src/renderer/renderer-main.ts:764`）、`setNearParams`（`apps/debug/src/renderer/renderer-main.ts:740`，转发共享控制器）、`getPlaneInfo`（`apps/debug/src/renderer/renderer-main.ts:750`）、`getPvsCluster`（`apps/debug/src/renderer/renderer-main.ts:1276`）。

本文件还持有三个模块级常量：`FOV`（`apps/debug/src/renderer/renderer-main.ts:77`）、`PLANE_INSPECT_INTERVAL`（`apps/debug/src/renderer/renderer-main.ts:79`）、`DEG2RAD`（`apps/debug/src/renderer/renderer-main.ts:1385`）。近平面三参数（near 下限 0.05 / 探测距离 100 / 收缩系数 0.3）与分块合并参数（cell 目标/区间/钳制、FRUSTUM_PAD）2026-10-03 起由渲染共享层承载（`src/renderer-shared/camera/near-plane.ts` 与 `src/renderer-shared/scene/scene-optimizer.ts`，数值与原 debug 常量一致）。

**`apps/debug/src/renderer/lod-manager.ts`**

导出 `LOD_LEVEL`（`apps/debug/src/renderer/lod-manager.ts:23`）、`LodStats`（`apps/debug/src/renderer/lod-manager.ts:48`）、`SceneDiagonalInfo`（`apps/debug/src/renderer/lod-manager.ts:68`）、`LodManager`（`apps/debug/src/renderer/lod-manager.ts:87`）。类内公开面：`setup`（`apps/debug/src/renderer/lod-manager.ts:121`）、`assignClusterIds`（`apps/debug/src/renderer/lod-manager.ts:181`）、`update`（`apps/debug/src/renderer/lod-manager.ts:222`）、`setCullDistance`（`apps/debug/src/renderer/lod-manager.ts:275`）、`getStats`（`apps/debug/src/renderer/lod-manager.ts:283`）、三个 getter（`apps/debug/src/renderer/lod-manager.ts:288` 起）、`dispose`（`apps/debug/src/renderer/lod-manager.ts:303`）。

**`apps/debug/src/renderer/collider-debug.ts`**

导出 `ColliderDebug`（`apps/debug/src/renderer/collider-debug.ts:560`），公开面：`init`（`:610`）、`setTriMeshes`（`:644`）、`setTriggers`（`:651`）、`setDebugFlags`（`:658`）、`setTriDebugFlags`（`:721`）、`update`（`:758`）、`hasDebugWork`（`:809`）、`clearAll`（`:1346`）、`dispose`（`:1356`）。可视化预算由常量给出：`DEBUG_Y_EXTENT`（`:47`）、`MAX_DEBUG_COLLIDERS`（`:49`）、`REBUILD_INTERVAL`（`:51`）、`TRI_REBUILD_INTERVAL`（`:53`）、`MAX_TRI_LINES`（`:55`）、`FILL_OPACITY`（`:57`）、七个语义颜色（`:66` 起）、两个 spawnflag 掩码（`:84`、`:85`）、两个几何容差（`:92`、`:95`）。

**面高亮只画物理真实面**：`orderedFaces`（`:189`）只接受上游标记 `isRealFace` 的平面（判据是「面上凸包顶点 ≥ 3 且不共线」，见 `documents/debug/implementation/world.md`），字段缺失一律不画。**物理侧的碰撞平面集里含有 BSP 原生 bevel 平面（过棱小平面），它们大多 `isRealFace === false`，因此不进线框；少数构成可量多边形的照实画**——bevel 过棱、不放大实体体积，只有构成有面积的多边形才是一张能站能撞的表面。原「显示切角面」一路（`setChamferDebugFlags` 与页面对应控件）已于 2026-10-04 整体删除；运行时合成切角平面的机制也已于 2026-10-07 整段撤除、由原生 bevel 接管（取证与实测见 `progress/open-issues/01-chamfer-is-not-a-bevel.md` §9）。**这条闸门曾误伤触发器**：触发器平面不来自世界 brush 判据、不带 `isRealFace` 字段，「未知即不画」把触发器线框整条滤空（回归：开关打开、组可见、子对象恒为 0）——触发器体积本来就是整只凸包，`rebuildTriggers` 现已显式给它的平面标 `isRealFace: true`（2026-10-07 修）。
**bevel 辅助面线框（第五路，白）**：`showBevel` 开关（默认关）经 `setBevelVisible` 独立成组，画的是 **bevel 平面被 brush AABB 截出的截面**（Sutherland–Hodgman 逐 AABB 半空间裁剪，沿法线外移 0.5 HU），半透明填充 + 描边。为什么画 AABB 截面而不是凸包相交轮廓：bevel 平面与凸包的交集通常只是棱线上的线段，贴着凸包画与实体面线框无法区分；而截面天然溢出斜面 brush 的实体材质之外——这正是 bevel 的碰撞角色（参与盒体扩张后的支撑）。可视距离复用 brush 可视距离；描边 `depthTest` 关闭使其始终可见。`surf_666` 实测（视距 16384、800 brush 封顶）：bevel 平面 1655 / 截面 1593 / 三角形 3186，出生点刀脊 brush 的顶部 box bevel（水平面、比脊线高 1.3 HU）整张在列。三条首版缺陷的修正（2026-10-07）：① 面内正交基的参考轴取**与法线分量最小**的坐标轴——首版取了最同向轴，轴向法线（box bevel 全是轴向）叉积恒为零、截面退化成一点，顶部 bevel 一张都画不出来；② 与同 brush 某条非 bevel 平面**共面**（法线逐分量差 < 1e-4 且 dist 差 < 0.1 HU）的 bevel 不画——VBSP 的 edge bevel 偶尔与既有真实面同面（surf_666 刀脊 brush 只有东坡有这条共面 bevel，画出来即「实体面上贴白纸」且西坡无对应物；全图 16976 条 bevel 平面中 1800 条属此类），它在碰撞里与那条真实面等效；③ 近距筛选的 `distSq` 真算进排序键——首版收集时恒写 0、排序空转，超上限按数组序截断，视距拉远后名额被远处 brush 占满、相机附近的反而消失。`rebuildSolids` 的同款空转排序一并修正（截断改为按真实距离取最近的 `MAX_DEBUG_COLLIDERS` 个）。原理与 `is_bevel` 字段口径见 `documents/debug/implementation/world.md`。

**`apps/debug/src/renderer/path-recorder.ts`**

导出 `PathPoint`（`apps/debug/src/renderer/path-recorder.ts:46`）、`DistStats`（`:66`）、`PathRecorder`（`:330`）。公开面：`isRecording`（`:396`）、`start` / `stop`（`:402` / `:409`）、`counts`（`:418`）、`addRender`（`:431`）、`addTick`（`:459`）、`shapeStats`（`:586`）、`deviStats`（`:618`）、`perpStats` / `residualStats`（`:641` / `:648`）、`clear`（`:658`）、四个可见性开关（`:687` 起）、`toJson` / `toCsv`（`:721` / `:756`）、`dispose`（`:771`）。内部 `LineBuffer`（`:175`）承担三种绘制模式（`line` / `points` / `segments`，`apps/debug/src/renderer/path-recorder.ts:115`）。

**`apps/debug/src/renderer/plane-inspector.ts`**

导出 `PlaneInspector`（`apps/debug/src/renderer/plane-inspector.ts:54`），唯一公开方法是 `cast`（`:75`）：先对 GLB 场景做 mesh 射线，再对 solid / ladder brush 求交，最后测传送触发器 AABB。常量 `DEFAULT_MAX_DISTANCE`（`:42`）与 `EPS`（`:48`）；AABB 求交在 `apps/debug/src/renderer/plane-inspector.ts:411`。

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
- 光照模式：`LightingMode`（`:416`）、`setLightingMode`（`:431`）、`getLightingMode`（`:437`）。
- 诊断 / A-B 覆盖：`LightmapStage` 与 `readLightmapStage`（`:284`、`:304`）、`LIGHTMAP_UV_CHANNEL_CORRECT` 与 `resolveLightmapUvChannel`（`:324`、`:333`）、`getVertexLightingRelaxStats`（`:1664`）、`setPropVertexRelax` / `getPropVertexRelax`（`:1676` / `:1681`）、`setPropVertexFlatten` / `getPropVertexFlatten`（`:1695` / `:1700`）、`setLightFloor`（`:1742`）、`setLightGamma` / `getLightGamma`（`:1773` / `:1780`）、`setExposure`（`:1792`）、`setAmbientScale`（`:1809`）。

**`src/renderer-shared/scene/dispose.ts`**（渲染共享层，2026-10-04 Phase 4 自三份同源分叉合并——debug 的 11 贴图槽位版为基准，game/viewer 消费同一实现）

导出 `disposeObject`（`src/renderer-shared/scene/dispose.ts:16`）：逐 Mesh 释放几何、材质及其引用的 11 类贴图槽位（map/lightMap/emissive/normal/roughness/metalness/ao/alpha/bump/specular/env），重复 dispose 幂等；本工程在 `disposeScene` 的 `isBspModel` 子树析构处调用（`apps/debug/src/renderer/renderer-main.ts:423`）。

**`src/renderer-shared/scene/texture-quality.ts`**（渲染共享层，2026-10-04 Phase 4 合并 game/debug 各自的 `applyTextureQuality` + `replaceMapWithMosaic` 同源副本）

导出 `applyTextureQuality`（`src/renderer-shared/scene/texture-quality.ts:48`）与 `MosaicDeps` / `TextureQualityResult`；`decode` 由应用注入（`pkg/websurf_wasm.js` 的 `mosaic_decode`），`ensureWasm` 钩子本工程传 `ensureMainWasm`；统计经返回值交应用侧打印。

## 关键流程与不变量

**一帧的固定顺序**：物理段 → 视距剔除 → 碰撞可视化 → 限流准星射线 → 渲染 → 剔除统计（`apps/debug/src/renderer/renderer-main.ts:598` 起；各步锚点见 `documents/debug/sequences.md` 的帧链一节）。

**相机位姿唯一来源是渲染物理**：`tick` 每帧从 `predPhys.state()` 取 `posX/posY/posZ`、`yaw`、`pitch`、`eyeHeight`，yaw/pitch 由度换弧度后交给 `CameraController.setYawPitch`，相机位置取「脚底 + 眼高」（`apps/debug/src/renderer/renderer-main.ts:665`、`apps/debug/src/renderer/renderer-main.ts:666`、`apps/debug/src/renderer/renderer-main.ts:669`）。主线程不保留插值副本。

**地图装配（2026-10-04 起与 game/viewer 同一条共享链路）**：`loadScene` 走共享 `buildMapScene`
（GLB → 子场景 + 清根 rotation + 世界包围盒 + **摘 punctual 灯**，此前本工程自持 loadGlb 且保留 GLB 内嵌灯——surf_666 上 2118 盏灯重复计光且推高 uniform，是三应用观感分歧来源之一）
→ 共享 `applyLightmap` → 分块合并 → **合并后 fullbright 终扫**（与 game 同序）→ `renderer.compile` 预编译；
`init` 落五个光照旋钮，取**项目自调档**（exposure 2.3 / lightGamma 2.2 / ambientScale 1 / propVertexRelax 1 / propVertexFlatten 0.85）；game 的 `DEFAULT_CONFIG` 自 2026-10-09 起已改为共享层默认值 1/1/1/1/0（见 TODO.md T-615），debug 侧仍按上列档位装配，（已消除 2026-10-08：接受窗口已改为 (0,8] 并与面板量程对齐，2.2 生效）
`LightManager` 三盏基础灯默认强度归零（`apps/debug/src/config.ts:213` 起的默认值改动；面板仍可拉高做光照对照，但终扫收敛为 fullbright 的 mesh 不再响应这些灯）。
锚点：`apps/debug/src/renderer/renderer-main.ts:490` 到 `apps/debug/src/renderer/renderer-main.ts:624`。

**近平面自适应只改投影矩阵**：实现在共享 `NearPlaneController.update`（`src/renderer-shared/camera/near-plane.ts:65`，2026-10-03 起本工程不再持有副本）：候选 `roots` 直通 `bspModelScene` 子树（等价于旧的 scene.traverse），沿 4 个水平正交方向各投一条长度为 probe 的射线取最近命中，命中则 `near = max(minD × ratio, CAMERA_NEAR_MIN)`，无命中回到 `defaultNear`；与当前值相差超过 0.001 才写入。调用点（`apps/debug/src/renderer/renderer-main.ts:674`）保留了 noclip 跳过与隔帧节拍；`setNearParams`（`apps/debug/src/renderer/renderer-main.ts:740`）转发共享控制器并照旧置 `needsRender`。

**LOD 剔除的判据与取值**：判据只有「块中心到相机距离平方 > `cullDistance` 的平方」一条，不带迟滞、不查 PVS（`apps/debug/src/renderer/lod-manager.ts:231`）；每 `lod.updateInterval` 帧才判一轮（`apps/debug/src/renderer/lod-manager.ts:226`），只有可见性翻转时才写 `mesh.visible` 并把返回值置真（`apps/debug/src/renderer/lod-manager.ts:246`）。距离取值：上限 = 对角线 ×4 上取整到 100 HU，默认 = min(对角线 ×2, max(12800, 最大边 ×0.5))（`apps/debug/src/renderer/lod-manager.ts:155` 起）。

**路径记录两条线与两种度量**：

- 渲染线 = 每个 rAF 物理步一点，取脚底坐标（`apps/debug/src/renderer/renderer-main.ts:659`）；tick 线 = 权威版本号 `va` 变化时一点，时间戳取发布时钟 τ（`apps/debug/src/renderer/renderer-main.ts:636` 起）。
- 垂距与偏差梳是两个不同度量：垂距是 tick 点到渲染折线的最短距离，偏差梳是同一时刻两点之差；面板上分开标注（`apps/debug/src/app.ts:644` 起）。
- 折线自检按长度比给出：直连为 1.000，超过 1.15 标红（`apps/debug/src/app.ts:656` 起）。

**分块合并（`optimizeScene`）**：GLB 挂载后执行一次（`OPTIMIZE_SCENE_ENABLED` gating，`apps/debug/src/renderer/renderer-main.ts:124`、调用点 `:532`），把 GLTFLoader 的逐 primitive Mesh 合并成空间块；算法在共享核 `src/renderer-shared/scene/scene-optimizer.ts:218`（与 game 同一份），本工程私有方法（`:1524`）只做薄委托并经 `normalizeGroup` 钩子注入 `normalizeMergeGroup`（混合 indexed/非 indexed 与混合 gpuType 的合并前归一——debug 特有健壮化，game/viewer 不传钩子）；顺序固定在 lightmap 应用之后、LOD/PVS 注册之前。

**渲染采样传输**：同一帧先落 `PathRecorder` 渲染节点、再写共享内存渲染采样槽，`i0` 用同一次自增，保证「渲染节点下标 = 采样下标」（`apps/debug/src/renderer/renderer-main.ts:659`、`apps/debug/src/renderer/renderer-main.ts:663`）。

**回放模式的边界**：`setReplayMode(true)` 只关掉权威→渲染方向的两项实时耦合（`correctFromAuthority` 与 `calibrateVelocity`），共享内存输入槽照写、渲染与路径记录逻辑不动（`apps/debug/src/renderer/renderer-main.ts:1035` 起）。

**lightmap 着色器**：光照模式切换不重建场景、不重编译材质，只改一个全场景共享 uniform（`apps/debug/src/config.ts:101`）；图集加载在两种模式下完全一致（`apps/debug/src/config.ts:101`）。着色器本体是渲染共享层单实例 `src/renderer-shared/shader/lightmap-shader.ts`（2026-10-02 由三工程各自一份的同构副本合并而来，旧副本已删除，三工程消费同一文件）。

## 已知缺口（状态见 TODO.md）

1. ~~**PVS 列不反映隐藏数**~~ **已消除（2026-10-09）**：T-303 —— 面板剔除统计行的 PVS 段改为**未接线就不打印数字**（`apps/debug/src/app.ts:603`：`totalClusters > 0 ? '可见/总 隐藏n' : '未接线'`，1:1）。底层口径不变：`LodStats.pvsHidden` 每轮仍恒写 0（`apps/debug/src/renderer/lod-manager.ts:262`），真正被隐藏的块数是 `far`（`:261`）；「接线后统计与实际隐藏数一致」属**可选后续**（判据后半句）。
2. ~~**PVS 相关统计在本工程恒为缺省值**~~ **已消除（2026-10-09）**：T-303 —— 面板现按「未接线」如实显示、不再假装有数（同下条所述 `apps/debug/src/app.ts:603`）；底层仍未接线：`RendererMain` 只构造 `PvsManager`、把 `getClusterAt` 交给 `assignClusterIds` 用、并读 `getStats` / `currentClusterId`，**从不调 `update`**，因此剔除统计里的 `cluster` 恒 -1、`visibleClusters` 恒 0（`apps/debug/src/renderer/renderer-main.ts:192` 起、`apps/debug/src/renderer/renderer-main.ts:543`）。面板现按「未接线」显示而不是假装有数（见上一条）；要真接线需调 `PvsManager.update`（未做）。
3. ~~**`LOD_LEVEL.PVS_HIDDEN` 是预留档位**~~ **已消除（2026-10-09）**：T-318 —— **遗弃，不删**：它是枚举里**按设计预留**的档位（三应用同一套 LOD 档位序），删掉会让档位编号与另两个工程错位；「本文件内零引用」正是预留的意义。
4. **`assignClusterIds` 的结果无消费方**：返回的「采到至少一个 cluster 的 mesh 数量」在 `loadScene` 里没有被使用（`apps/debug/src/renderer/lod-manager.ts:181`）。 （见 TODO.md T-319）
5. **tick 线的时间戳在无发布时钟时回落墙钟**：`readPublishedTau()` 返回 0 时用 rAF 时间戳 `now`（`apps/debug/src/renderer/renderer-main.ts:691`），两条线的时间基准在此时不同源。**已消除（2026-10-09）**：T-304 —— **断言不成立，按「不修」结案**。`readPublishedTau()` 的值是 `tickInstantToTau` 的输出，而它是 `workerInstMs + rtOffset`（`apps/debug/src/worker/main.ts:262`），即**渲染时钟域**的毫秒值；回落用的 `now` 也是渲染时钟 ⇒ **同源**。且 `τ = 0` 是契约语义「未投影」（`src/ts-shared/auth/auth-loop.ts:428`），未投影时发布位置就是权威自身 `phys.state()`（同文件 `:433`），本就对应「当前时刻」，用 `now` 是对的。原锚点 `apps/debug/src/renderer/renderer-main.ts:638` 指向的是 `stop()` 的 `cancelAnimationFrame`（无关代码，sync 盲重钉所致），已改为 `:708`。
6. **权威 post-tick 位置差（residual）恒不记录**：`addTick` 的第六个实参固定传 `undefined`（`apps/debug/src/renderer/renderer-main.ts:695`），该组统计的样本数保持 0（`apps/debug/src/renderer/path-recorder.ts:648`）。**已消除（2026-10-09）**：T-305 —— **按「不修」结案**：该读数是「权威自身 post-tick 位置 − 发布位置」，而发布只写投影后的位置（`src/ts-shared/auth/auth-loop.ts:431`），权威自身位置**不出线程** ⇒ 主线程侧原理上拿不到；要填它必须给共享内存加一个槽位（跨端契约改动，`src/ts-shared/auth/shared-state.ts` 的 SAB 布局两侧同改），而该统计当前没有任何读取方（只在导出 JSON/CSV 里留列）。记录器已把这一限制写进 `residualStats()` 的文档（`apps/debug/src/renderer/path-recorder.ts:647`），保留字段作为将来的扩展点。原锚点 `apps/debug/src/renderer/renderer-main.ts:640` 指向 `stop()` 的 `this.rafId = 0`（无关代码），已改为 `:712`。
7. **`lightmap-shader.ts` 的诊断覆盖只从全局键读**：`window.__vbsp*` 系列覆盖（如 `src/renderer-shared/shader/lightmap-shader.ts:1735` 的 `readLightFloorOverride`）在模块初始化时就固化成 uniform 初值（`src/renderer-shared/shader/lightmap-shader.ts:1539`、`:1556`、`:1563`、`:1580`），运行期注入不改变已创建的 uniform。（见 TODO.md T-306）
8. **准星射线是限流采样**：每 `PLANE_INSPECT_INTERVAL` 帧才检测一次，关闭开关时只清空上次结果，不做新检测（`apps/debug/src/renderer/renderer-main.ts:702`）。
- 看板另有登记项：`TODO.md` 的 T-046 —— **状态与结论只在那登记**，本文件不复述。

## 渲染装配全链条（三端同构，2026-10-09 梳理）

一张地图从 GLB 字节到出画，**三端必须逐步同序**；下表既是顺序，也是每一步的约束与理由（括号内为 debug 的调用锚点，game/viewer 为同一份共享实现）。
任何一步错位都会表现为「某一类图元没有光照 / 没有混合 / 观感不一致」，而不是报错。

| # | 步骤 | 约束（为什么必须在这里） |
|---|---|---|
| 1 | `buildMapScene(glb)`（`apps/debug/src/renderer/renderer-main.ts:495`） | 清根 rotation + 世界包围盒 + **摘除 punctual 灯**；必须在挂进主场景之前（VRAD 烘焙已含其贡献，运行时再打会重复计光且 uniform 超限） |
| 2 | `collectWorldTransitionTextures(gltf, root)`（`:503`） | 登记 VMT `$basetexture2`（雪盖等第二贴图）与材质 extras；必须在注入（第 7 步）之前 |
| 3 | `applyLightmap(root, gltf)`（`:508`） | 世界面 lightmap atlas（`uv1` 通道）+ prop 逐顶点烘焙（`sp_<i>.vhv`）+ leaf ambient cube；**必须早于分块合并**（合并会重建几何与材质数组，之后按原 mesh 的材质/UV 施加就找不到映射） |
| 4 | `extractSkyArea(root, 判定)`（`:524`） | 3D 天空盒天空区摘出主世界。判据 =「图元采样点落在 `sky_camera` 所在 BSP cluster」。**必须晚于第 3 步**（T-621：早摘则天空区不在光照遍历范围内 ⇒ 只剩贴图原色），**必须早于第 5 步**（合并成空间块后跨区大块无法再拆） |
| 5 | `optimizeScene(root)`（`:530`）/ `mergeIntoChunks(root)` | 空间分块合并（按材质实例分组）。天空组**不在**主世界子树里，必须**单独合并**并重贴天空层（T-622） |
| 6 | `fullbrightUnlitLitMaterials(root)`（`:550`） | 仍是 GLTF 原 Standard 材质的图元收敛为贴图原色（本工程不加灯 ⇒ 受光材质恒黑）。必须**晚于第 5 步**（合并会重建 mesh/材质数组）。天空组要再跑一遍 |
| 6b | 剔除注册：`lodManager.setup`+`assignClusterIds`（debug）/ 内联 `lodItems`+`clusterIds`（game） | 逐块记录「世界中心 + 半径 + cluster 集合」，供每帧 `tick` 按 `cullDistance`（game 另叠 PVS）把更远的块 `visible = false`。**必须在合并之后**（收集的是合并后的块 mesh） |
| 7 | `applyWorldTransitionShaders(root)`（`:550`） | 双贴图混合注入（雪盖）：按顶点属性 `_vbsp_blend` 与 `vbsp_basetexture2` 改写材质。天空组要再跑一遍 |
| 8 | 挂载：`scene.add(root)` + `scene.add(skyGroup)`（`:585`） | 天空组逐 mesh `layers.set(SKY_LAYER)`；主相机 `layers.disable(SKY_LAYER)`；天空相机 `createSkyCamera` + 每帧 `syncSkyCamera`（位姿 = 主相机 ÷ scale + `sky_camera` 原点）；天空遍雾 `start/end ÷ scale` |
| 9 | 天空遍（第二相机） | 画 2D 天空盒六面 + 第 1 层图元（微缩景观）；主相机不画第 1 层 |

**三端分歧史：三起同类错误，全部是「顺序/来源不一致」，且都不报错。**

| 分歧 | 表现 | 处置 |
|---|---|---|
| 摘天空区的时机（T-621） | game/viewer 的微缩景观只有贴图原色、没有最基本的光照 | 摘取移到第 3 步之后（与 debug 同序） |
| 天空组不做合并（T-622） | 1010 个逐面小块 = 1010 次天空遍 draw call | 补 `mergeIntoChunks` + `padBoundingSpheres` + 重贴 `SKY_LAYER` |
| 呈现默认档三份各写（T-620） | 同一张图三端观感不同；debug 读到的坐标与 game 画面不同源 | 收进共享层 `LIGHTING_PRESENTATION_DEFAULTS`，三端只读它 |
| 终扫的根节点不同（2026-10-09 核对） | debug 扫 `mapRoot`、game 扫 `this.scene`、viewer 扫 `this.modelRoot` ⇒ 收敛计数 169 / 183 / 179、fullbright 总数 2936 / 2936 / 2928 | **核对为无害**：点名显示被收敛的是水/粒子/冰面的受光材质（`water_pure_beneath`、`water01_…`、`alch_symbols`、`endsmoke`、`ice03/ice02`），三端都统一走「全亮贴图原色」兜底；根节点差异只改变「谁来做这次收敛」，不改变最终材质形态 |
| 剔除链三端不同（2026-10-09 核对） | debug：`apps/debug/src/renderer/lod-manager.ts` 只按距离（`cullDistance`，默认 12800；`assignClusterIds` 的结果自述「当前无消费方」）；game：`apps/game/src/renderer/renderer-main.ts` 内联距离剔除 + 可选 PVS；viewer：`apps/viewer/src` 无任何剔除 ⇒ 全量绘制 | **核对为可见性/性能差异，非光照**：实测 debug HUD 在该视点 `隐藏 0`（未剔任何块）⇒ 不是两端观感差的来源。viewer 的全量绘制已登记 T-624 |

## 环境氛围机制完整性矩阵（T-617，2026-10-09）

目标地图 `test/maps/surf_boreas.bsp` 逐机制的复现状态与证据（SDK 参照物：`test/project/source-sdk-2013-master/`）。
「审计面」= 本仓读取该机制的代码入口；状态含义：**已复现**（有实测证据）/ **未实现** / **不适用**。

| 机制（SDK 出处） | 状态 | 审计面与证据 |
|---|---|---|
| `env_fog_controller` 主色与端点（`fogcontroller.cpp:59-60`） | 已复现 | `src/renderer-shared/environment/fog-controller.ts`；T-413 实测 `Fog(500,43420,0xe8fffe)` |
| `fogmaxdensity` 雾因子上限（`fogcontroller.cpp:61/103`） | 已复现（T-617 第 4 轮） | `src/renderer-shared/shader/lightmap-shader.ts` 的 `FOG_MAX_DENSITY` 夹取补丁 + `setFogMaxDensity()`；实测 `chunkPatched=true`、强制 0.2 时 `define=DEFINED:0.2`、同视点 4.5% 像素变化，cap=1 时 0.0% |
| `fogcolor2` + `fogblend` 朝日雾色渐变 | 未实现 | 8 张夹具图 `fogblend = 0` ⇒ 当前无差异；实现需视方向 varying |
| `sky_camera`：2D 六面天空盒 + 3D 微缩区 + 天空遍自带雾（`SkyCamera.cpp:57`） | 已复现 | T-412 / T-416 / T-417 / T-424 / T-430；调试端 `skyFog` 用 `sky_camera` 自己的雾键值、`start/end ÷ scale` |
| 3D 天空盒**天空区的烘焙光照**（微缩景观） | 已复现（T-621 修复顺序） | `extractSkyArea` 必须晚于 `applyLightmap`：debug `apps/debug/src/renderer/renderer-main.ts` 先施加后摘出；game/viewer 原先相反 ⇒ 天空区拿不到 lightmap 与逐顶点烘焙、只剩贴图原色。修复后三端 `施加 mesh=` 逐项相等（1351） |
| `light_environment`（`_light` / `_ambient`） | 已复现（烘焙路径） | 由 VRAD 烘进世界 lightmap 与 prop 顶点光；运行期把 GLB 的 punctual 灯摘除（`renderer-main.ts` 的摘灯日志）与 SDK 同口径 |
| 世界面 lightmap（RGBExp32 图集 + 双线性） | 已复现 | 与 SDK `common_lightmappedgeneric_fxc.h:195` 的 `LightMapSample` 对拍；本仓图集把有符号 i8 指数重编码为 `A = exp + 128`（`src/wasm-core/bsp_to_gltf_core/lightmap.rs:21/494/957`） |
| prop 逐顶点烘焙（`.vhv`） | 已复现 | SDK `hardwareverts.h`（`#pragma pack(1)`：`pMesh` 在 +40、28 B 步长）+ `vradstaticprops.cpp:1579-1594`（BGRA）与本仓 `src/wasm-core/vhv.rs` 逐字一致；1587 份实测第 4 字节恒 255 |
| leaf ambient cube | 已复现 | `src/wasm-core/vbsp/data/game.rs:21-23`：指数按 `as i8`、与 lightmap 解码只差 `/255`；实测线性中位 0.0475 |
| 呈现管线（`OverBright2` + 一次屏幕 gamma） | 已复现（T-617 第 2 轮） | `imaterialsystem.h:16` `OVERBRIGHT 2.0f` + `mathlib.h:1753` `MathLib_Init(gamma 2.2, overbright 2.0)`；本仓 three 输出端已做那一次编码 ⇒ `lightGamma 1.0` + `exposure 2.0`；实测 σ 54.2（参照图 59.2） |
| 洞穴内光照 | 已实测（无需修） | 洞内（岩石隧道）均值 31.1 / σ 19.0 / 纯黑 **0.00%**；world lightmap 与 leaf ambient 两条路径在洞内均工作 |
| `env_sun` 光晕 sprite | 未实现 | 该图参照画面天光均匀发白、无可见太阳；`sprites/light_glow02_add_noz` 也不在 pakfile 内 |
| `func_dustmotes` / `info_particle_system` 粒子 | 未实现 | 本图用自定义粒子 `tendies_alch01` / `tendies_alch01_large`，复现需 CS:GO `.pcf` 粒子格式 ⇒ 独立特性，不属光照管线 |
| `env_fade` 过场淡出 | 未实现 | 地图脚本触发的白场淡出，与静态光照无关 |
| `env_tonemap_controller` / `color_correction` | 未实现 | 本图没有这两个实体（不是缺口）；`surf_null` / `surf_sedona` / `tsurf_concretejungle_b16` 有 ⇒ 那些图的氛围未覆盖 |

仍未实现项的登记见 TODO.md T-618。
