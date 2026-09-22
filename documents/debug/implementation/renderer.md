# implementation：renderer

主题对应 `apps/debug/src/renderer/**`，共九个模块：主渲染器 `RendererMain` 与八个子模块（相机、雾、光照、lightmap 着色器、LOD 剔除、路径记录、准星射线、碰撞可视化）。

## 模块职责

**`apps/debug/src/renderer/renderer-main.ts`**

导出 `CullStatsLike`（`apps/debug/src/renderer/renderer-main.ts:92`）、`RenderPhysEvent`（`apps/debug/src/renderer/renderer-main.ts:109`）、`RendererMain`（`apps/debug/src/renderer/renderer-main.ts:219`）。类内公开面按用途分五组：

- 生命周期：`init`（`apps/debug/src/renderer/renderer-main.ts:399`）、`disposeScene`（`apps/debug/src/renderer/renderer-main.ts:460`）、`loadScene`（`apps/debug/src/renderer/renderer-main.ts:554`）、`start` / `stop`（`apps/debug/src/renderer/renderer-main.ts:638` / `:645`）、`resize`（`apps/debug/src/renderer/renderer-main.ts:884`）。
- 物理线：`buildPredictionWorld`（`apps/debug/src/renderer/renderer-main.ts:1127`）、`feedInput`（`apps/debug/src/renderer/renderer-main.ts:1175`）、`setPredictionState`（`apps/debug/src/renderer/renderer-main.ts:1240`）、`setPredictionParams` / `setPredictionHull` / `setPredictionNoclip`（`apps/debug/src/renderer/renderer-main.ts:1301` 起）、`respawn` / `teleportToSpawn` / `teleportToPos`（`apps/debug/src/renderer/renderer-main.ts:1328` 起）、`setSpawnPoints` / `setDeathY`（`apps/debug/src/renderer/renderer-main.ts:1350` / `:1359`）、`getCurrentVel` / `getCurrentState`（`apps/debug/src/renderer/renderer-main.ts:1365` / `:1429`）、`resetTo`（`apps/debug/src/renderer/renderer-main.ts:1403`）、`applyCollisionCorrection`（`apps/debug/src/renderer/renderer-main.ts:1413`）、`syncCameraToCurrentState`（`apps/debug/src/renderer/renderer-main.ts:1163`）、`clearPendingInput`（`apps/debug/src/renderer/renderer-main.ts:1226`）。
- 回放相关（debug 专属）：`setReplayMode` / `isReplayMode`（`apps/debug/src/renderer/renderer-main.ts:1195` / `:1202`）、`setManualSteps`（`apps/debug/src/renderer/renderer-main.ts:1215`）、`captureReplayState`（`apps/debug/src/renderer/renderer-main.ts:1468`）、`captureFullPhysState` / `restoreFullPhysState`（`apps/debug/src/renderer/renderer-main.ts:1271` / `:1288`）。
- 路径记录：`startPathRecording` / `stopPathRecording` / `isPathRecording` / `clearPath`（`apps/debug/src/renderer/renderer-main.ts:904` 起）、`setPathVisible` 与四个分量开关（`apps/debug/src/renderer/renderer-main.ts:930` 起）、`getPathShapeStats` / `getPathDeviStats` / `getPathCounts`（`apps/debug/src/renderer/renderer-main.ts:960` 起）、`exportPathJson` / `exportPathCsv`（`apps/debug/src/renderer/renderer-main.ts:1003` / `:1008`）。
- 渲染侧配置：`applyConfigPatch`（`apps/debug/src/renderer/renderer-main.ts:1015`）、`applyTextureQuality`（`apps/debug/src/renderer/renderer-main.ts:1056`）、`setLightingMode` / `getLightingMode`（`apps/debug/src/renderer/renderer-main.ts:541` / `:548`）、`setCullDistance`（`apps/debug/src/renderer/renderer-main.ts:893`）、`setNearParams`（`apps/debug/src/renderer/renderer-main.ts:866`）、`getPlaneInfo`（`apps/debug/src/renderer/renderer-main.ts:879`）、`getPvsCluster`（`apps/debug/src/renderer/renderer-main.ts:1453`）。

本文件还持有四个模块级常量与一组分块合并参数：`FOV`（`apps/debug/src/renderer/renderer-main.ts:69`）、`PLANE_INSPECT_INTERVAL`（`apps/debug/src/renderer/renderer-main.ts:71`）、`CAMERA_NEAR_MIN`（`apps/debug/src/renderer/renderer-main.ts:74`）、`NEAR_PROBE_DIST_DEFAULT` / `NEAR_RATIO_DEFAULT`（`apps/debug/src/renderer/renderer-main.ts:78` / `:82`）、`OPT_TARGET_CELLS` 起的六个分块常量（`apps/debug/src/renderer/renderer-main.ts:127` 起）、`FRUSTUM_PAD`（`apps/debug/src/renderer/renderer-main.ts:140`）、`DEG2RAD`（`apps/debug/src/renderer/renderer-main.ts:1796`）。

**`apps/debug/src/renderer/lod-manager.ts`**

导出 `LOD_LEVEL`（`apps/debug/src/renderer/lod-manager.ts:23`）、`LodStats`（`apps/debug/src/renderer/lod-manager.ts:48`）、`SceneDiagonalInfo`（`apps/debug/src/renderer/lod-manager.ts:68`）、`LodManager`（`apps/debug/src/renderer/lod-manager.ts:87`）。类内公开面：`setup`（`apps/debug/src/renderer/lod-manager.ts:121`）、`assignClusterIds`（`apps/debug/src/renderer/lod-manager.ts:181`）、`update`（`apps/debug/src/renderer/lod-manager.ts:222`）、`setCullDistance`（`apps/debug/src/renderer/lod-manager.ts:275`）、`getStats`（`apps/debug/src/renderer/lod-manager.ts:283`）、三个 getter（`apps/debug/src/renderer/lod-manager.ts:288` 起）、`dispose`（`apps/debug/src/renderer/lod-manager.ts:303`）。

**`apps/debug/src/renderer/collider-debug.ts`**

导出 `ColliderDebug`（`apps/debug/src/renderer/collider-debug.ts:474`），公开面：`init`（`:523`）、`setTriMeshes`（`:552`）、`setTriggers`（`:559`）、`setDebugFlags`（`:566`）、`setTriDebugFlags`（`:596`）、`setChamferDebugFlags`（`:629`）、`update`（`:647`）、`hasDebugWork`（`:698`）、`clearAll`（`:1109`）、`dispose`（`:1120`）。可视化预算由常量给出：`DEBUG_Y_EXTENT`（`:34`）、`MAX_DEBUG_COLLIDERS`（`:36`）、`REBUILD_INTERVAL`（`:38`）、`TRI_REBUILD_INTERVAL`（`:40`）、`MAX_TRI_LINES`（`:42`）、`FILL_OPACITY`（`:44`）、七个语义颜色（`:53` 起）、两个 spawnflag 掩码（`:66`、`:67`）、三个几何容差（`:74`、`:76`、`:78`）、chamfer 两个常量（`:277`、`:279`）。

**`apps/debug/src/renderer/path-recorder.ts`**

导出 `PathPoint`（`apps/debug/src/renderer/path-recorder.ts:46`）、`DistStats`（`:66`）、`PathRecorder`（`:330`）。公开面：`isRecording`（`:396`）、`start` / `stop`（`:402` / `:409`）、`counts`（`:418`）、`addRender`（`:431`）、`addTick`（`:459`）、`shapeStats`（`:586`）、`deviStats`（`:618`）、`perpStats` / `residualStats`（`:641` / `:648`）、`clear`（`:658`）、五个可见性开关（`:684` 起）、`toJson` / `toCsv`（`:728` / `:763`）、`dispose`（`:778`）。内部 `LineBuffer`（`:175`）承担三种绘制模式（`line` / `points` / `segments`，`apps/debug/src/renderer/path-recorder.ts:115`）。

**`apps/debug/src/renderer/plane-inspector.ts`**

导出 `PlaneInspector`（`apps/debug/src/renderer/plane-inspector.ts:50`），唯一公开方法是 `cast`（`:71`）：先对 GLB 场景做 mesh 射线，再对 solid / ladder brush 求交，最后测传送触发器 AABB。常量 `DEFAULT_MAX_DISTANCE`（`:38`）与 `EPS`（`:44`）；AABB 求交在 `apps/debug/src/renderer/plane-inspector.ts:403`。

**`apps/debug/src/renderer/light-manager.ts`**

导出 `LightingUpdateParams`（`apps/debug/src/renderer/light-manager.ts:36`）与 `LightManager`（`:62`）。公开面：`applyLights`（`:101`）、`extractPointLights`（`:145`）、`updatePointLights`（`:198`）、`updateLighting`（`:252`）、`syncFromConfig`（`:295`）、`activePointLightCount`（`:330`）、`dispose`（`:341`）。上限 `MAX_POINT_LIGHTS` 与平行光距离 `DIR_LIGHT_DISTANCE` 在 `apps/debug/src/renderer/light-manager.ts:50` / `:53`。

**`apps/debug/src/renderer/fog-manager.ts`**

导出 `FogManager`（`apps/debug/src/renderer/fog-manager.ts:18`）：`init`（`:37`）、`update`（`:58`）、`setColor`（`:77`）、`setEnabled`（`:87`）、`isEnabled`（`:95`）、`currentSceneRadius`（`:100`）、`dispose`（`:105`）；默认雾色 `DEFAULT_FOG_COLOR` 在 `apps/debug/src/renderer/fog-manager.ts:12`。

**`apps/debug/src/renderer/camera-controller.ts`**

导出 `CameraController`（`apps/debug/src/renderer/camera-controller.ts:21`）：构造（`:39`）、`update`（`:46`）、`setYawPitch`（`:69`）、`setPosition`（`:80`）、`applyInputConfig`（`:85`）。

**`apps/debug/src/renderer/lightmap-shader.ts`**

本工程内最重的渲染模块，导出面分四类：

- GLSL 片段与属性名：`VBSP_DECOMPRESS_LIGHTMAP_SAMPLE`（`apps/debug/src/renderer/lightmap-shader.ts:87`）、`VBSP_APPLY_LIGHTMAP`（`:112`）、`VBSP_LIGHTMAP_UNIFORM_DECLS`（`:165`）、`VBSP_AMBIENT_UNIFORM_DECLS`（`:181`）、`VERTEX_LIGHTING_ATTR`（`:198`）。
- 装配入口：`loadLightmapAtlas`（`:374`）、`applyLightmapToMeshes`（`:482`）、`fullbrightUnlitLitMaterials`（`:1067`）、`installGamma22Output`（`:255`）。
- 光照模式：`LightingMode`（`:421`）、`setLightingMode`（`:436`）、`getLightingMode`（`:442`）、`isTextureOnlyMode`（`:447`）。
- 诊断 / A-B 覆盖：`LightmapStage` 与 `readLightmapStage` / `isLightmapSkipStage`（`:284`、`:304`、`:313`）、`LIGHTMAP_UV_CHANNEL_CORRECT` 与 `resolveLightmapUvChannel`（`:329`、`:338`）、`getVertexLightingRelaxStats`（`:1674`）、`setPropVertexRelax` / `getPropVertexRelax`（`:1686` / `:1691`）、`setPropVertexFlatten` / `getPropVertexFlatten`（`:1705` / `:1710`）、`setLightFloor` / `getLightFloor`（`:1752` / `:1757`）、`setLightGamma` / `getLightGamma`（`:1788` / `:1795`）、`setExposure` / `getExposure`（`:1807` / `:1817`）、`setAmbientScale` / `getAmbientScale`（`:1829` / `:1836`）。

## 关键流程与不变量

**一帧的固定顺序**：物理段 → 视距剔除 → 碰撞可视化 → 限流准星射线 → 渲染 → 剔除统计（`apps/debug/src/renderer/renderer-main.ts:658` 起；各步锚点见 `documents/debug/sequences.md` 的帧链一节）。

**相机位姿唯一来源是渲染物理**：`tick` 每帧从 `predPhys.state()` 取 `posX/posY/posZ`、`yaw`、`pitch`、`eyeHeight`，yaw/pitch 由度换弧度后交给 `CameraController.setYawPitch`，相机位置取「脚底 + 眼高」（`apps/debug/src/renderer/renderer-main.ts:715`、`apps/debug/src/renderer/renderer-main.ts:727`、`apps/debug/src/renderer/renderer-main.ts:730`）。主线程不保留插值副本。

**近平面自适应只改投影矩阵**：`updateNearPlane` 先用包围球粗筛，再沿 4 个水平正交方向各投一条长度为 probe 的射线取最近命中，命中则 `near = max(minD × ratio, CAMERA_NEAR_MIN)`，无命中回到默认值；与当前值相差超过 0.001 才写入（`apps/debug/src/renderer/renderer-main.ts:808`）。

**LOD 剔除的判据与取值**：判据只有「块中心到相机距离平方 > `cullDistance` 的平方」一条，不带迟滞、不查 PVS（`apps/debug/src/renderer/lod-manager.ts:231`）；每 `lod.updateInterval` 帧才判一轮（`apps/debug/src/renderer/lod-manager.ts:226`），只有可见性翻转时才写 `mesh.visible` 并把返回值置真（`apps/debug/src/renderer/lod-manager.ts:246`）。距离取值：上限 = 对角线 ×4 上取整到 100 HU，默认 = min(对角线 ×2, max(12800, 最大边 ×0.5))（`apps/debug/src/renderer/lod-manager.ts:155` 起）。

**路径记录两条线与两种度量**：

- 渲染线 = 每个 rAF 物理步一点，取脚底坐标（`apps/debug/src/renderer/renderer-main.ts:721`）；tick 线 = 权威版本号 `va` 变化时一点，时间戳取发布时钟 τ（`apps/debug/src/renderer/renderer-main.ts:693` 起）。
- 垂距与偏差梳是两个不同度量：垂距是 tick 点到渲染折线的最短距离，偏差梳是同一时刻两点之差；面板上分开标注（`apps/debug/src/app.ts:641` 起）。
- 折线自检按长度比给出：直连为 1.000，超过 1.15 标红（`apps/debug/src/app.ts:653` 起）。

**分块合并（`optimizeScene`）**：GLB 挂载后执行一次，把 GLTFLoader 的逐 primitive Mesh 合并成空间块；单 mesh cell 复用原 mesh，多 mesh cell 在块内按材质实例分组后合并；顺序固定在 lightmap 应用之后、LOD/PVS 注册之前（`apps/debug/src/renderer/renderer-main.ts:1596`）。

**渲染采样传输**：同一帧先落 `PathRecorder` 渲染节点、再写共享内存渲染采样槽，`i0` 用同一次自增，保证「渲染节点下标 = 采样下标」（`apps/debug/src/renderer/renderer-main.ts:721`、`apps/debug/src/renderer/renderer-main.ts:725`）。

**回放模式的边界**：`setReplayMode(true)` 只关掉权威→渲染方向的两项实时耦合（`correctFromAuthority` 与 `calibrateVelocity`），共享内存输入槽照写、渲染与路径记录逻辑不动（`apps/debug/src/renderer/renderer-main.ts:1186` 起）。

**lightmap 着色器**：光照模式切换不重建场景、不重编译材质，只改一个全场景共享 uniform（`apps/debug/src/config.ts:101`）；图集加载在两种模式下完全一致（`apps/debug/src/config.ts:101`）。三个工程各有一份自己的 `lightmap-shader.ts` 副本（`apps/debug/src/renderer/lightmap-shader.ts`、`apps/game/src/renderer/lightmap-shader.ts`、`apps/viewer/src/renderer/lightmap-shader.ts`）。

## 已知缺口

1. **PVS 列不反映隐藏数**：`LodStats.pvsHidden` 在 `update` 的统计刷新里每轮恒写 0（`apps/debug/src/renderer/lod-manager.ts:262`），而面板剔除统计行把它作为「隐藏 N」打印（`apps/debug/src/app.ts:624`），页面 `#cullStats` 也带「PVS」列（`apps/debug/web/index.html:670`）。真正被隐藏的块数是 `far`（`apps/debug/src/renderer/lod-manager.ts:261`）。
2. **PVS 相关统计在本工程恒为缺省值**：`RendererMain` 只构造 `PvsManager`、把 `getClusterAt` 交给 `assignClusterIds` 用、并读 `getStats` / `currentClusterId`，**从不调 `update`**，因此剔除统计里的 `cluster` 恒 -1、`visibleClusters` 恒 0（`apps/debug/src/renderer/renderer-main.ts:88` 起、`apps/debug/src/renderer/renderer-main.ts:1572`）。
3. **`LOD_LEVEL.PVS_HIDDEN` 是预留档位**：该常量在本文件内零引用，`update` 从不写入（`apps/debug/src/renderer/lod-manager.ts:26`）；`LodItem.clusterIds` 同样在本文件内无消费方（`apps/debug/src/renderer/lod-manager.ts:40`）。
4. **`assignClusterIds` 的结果无消费方**：返回的「采到至少一个 cluster 的 mesh 数量」在 `loadScene` 里没有被使用（`apps/debug/src/renderer/lod-manager.ts:181`）。
5. **tick 线的时间戳在无发布时钟时回落墙钟**：`readPublishedTau()` 返回 0 时用 rAF 时间戳 `now`（`apps/debug/src/renderer/renderer-main.ts:695`），两条线的时间基准在此时不同源。
6. **权威 post-tick 位置差（residual）恒不记录**：`addTick` 的第六个实参固定传 `undefined`（`apps/debug/src/renderer/renderer-main.ts:704`），该组统计的样本数保持 0（`apps/debug/src/renderer/path-recorder.ts:648`）。
7. **`lightmap-shader.ts` 的诊断覆盖只从全局键读**：`window.__vbsp*` 系列覆盖（如 `apps/debug/src/renderer/lightmap-shader.ts:1745` 的 `readLightFloorOverride`）在模块初始化时就固化成 uniform 初值（`apps/debug/src/renderer/lightmap-shader.ts:1549`、`:1556`、`:1563`、`:1580`），运行期注入不改变已创建的 uniform。
8. **准星射线是限流采样**：每 `PLANE_INSPECT_INTERVAL` 帧才检测一次，关闭开关时只清空上次结果，不做新检测（`apps/debug/src/renderer/renderer-main.ts:760`）。
