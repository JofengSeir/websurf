# 渲染子系统（维度 I）

> 前置阅读：[../overview.md](../overview.md) §3、[../sequences.md](../sequences.md) §3。本文覆盖 RendererMain tick 全景、相机/近平面、场景装载、lightmap/雾/灯光、LOD/PVS、碰撞可视化、准星检查器、纹理画质。地图数据怎么来见 [loading-pipeline.md](loading-pipeline.md)。

## 1. RendererMain 的职责边界

`renderer/renderer-main.ts`（1023 行）持有渲染与**主线程渲染物理线**的全部状态（`renderer-main.ts:8-45` 字段表）：`predPhys`（主线程 PhysWorld）、`calibrator`（AuthorityCalibrator）、`lodManager`/`pvsManager`/`teleportManager`/`colliderDebug`/`fogManager`/`lightManager`/`planeInspector`/`cameraController` 八个子管理器、`pendingDx/Dy/keys`（待写输入）、`noclipActive`、`deathY`、近平面参数与 `needsRender`。它对外只暴露"喂入/喂出"接口（feedInput / getCurrentState / 各类 setter），app.ts 不直接操作 three.js。

## 2. rAF tick 全景（`renderer-main.ts:430-516`）

七个阶段（行号见 [../sequences.md §3.1](../sequences.md)）：

1. **物理六步**（predReady 时）：addInput → correctFromAuthority → calibrateVelocity → predPhys.tick → consumePhysEvents → 相机同步（yaw/pitch 从 `state()` 度→弧度，位置 = origin + eyeHeight，`458-463`）；
2. **LOD/PVS**：`lodManager.update(camPos, config, pvsManager)`，返回 true（有可见性变化）则置 needsRender（`476-480`）；
3. **雾**：`fogManager.update(camPos, currentSceneRadius)`（`483`）；
4. **碰撞可视化**：`colliderDebug.update(...)` 限流重建（`486-490`）；
5. **准星射线**：每 6 帧 `inspectPlane()`（`493-501`）；
6. **渲染**：`predReady || needsRender` 才 render，无条件渲染时 needsRender 复位（`505-509`）；
7. **剔除统计**：每 100ms `emitCullStats()` 回传 app.ts 面板（`512-515`，`999-1017`）。

近平面自适应在物理块内每 2 帧执行（`467-470`，noclip 跳过——noclip 位置不受碰撞约束）。

## 3. 相机与近平面自适应

- **相机姿态**（`renderer/camera-controller.ts`）：yaw/pitch 存弧度，`update()` 把 yaw 归一化到 (-π,π]（`atan2(sin,cos)`），`pitch` 钳制 ±pitchLimitRad（默认 89°，`config.input.pitchLimit`），Euler 'YXZ' → quaternion（`camera-controller.ts` 全文 82 行）。yaw=0 朝 −Z，正 yaw 顺时针（与 cs-movement 约定一致）。
- **近平面探测**（`renderer-main.ts:530-595`）：从眼睛位置向 4 个水平方向（前后左右，步长 = probeDist，默认 100 HU）发射短线段求最近距离，`near = max(minD × ratio, CAMERA_NEAR_MIN=0.05)`。probeDist/ratio 由 UI 滑块实时可调（`setNearParams`，`598-604`；`config.debug` 默认 NEAR_PROBE_DIST_DEFAULT=100 / NEAR_RATIO_DEFAULT=0.3）。场景装载时基线 `defaultNear = max(maxDim/1000, 0.05)`、`far = maxDim × 100`（`loadScene` 内对角线计算）。**位置不做手动修正**——防穿墙完全交给近平面收缩（`458-463` 注释）。
- **FOV**：73.6°（`config.hud.fov`），PerspectiveCamera 构造（`renderer-main.ts` init）。

## 4. 场景装载（`loadScene`，`renderer-main.ts:328-408`）

顺序（每步失败都不阻塞整体）：

1. `loadGlb(glbBytes)`：Blob URL → GLTFLoader（`940-950`）；`isBspModel` 判定后 `resetRootRotations`（BSP 根节点清旋转，`953-968`）；
2. `collectMetadata`：遍历 mesh `userData.vbsp`，按材质名匹配标记 `isTools/isNodraw/isWater/isTrans/isLightEmissive`（tools/nodraw/water/、trans/、light/、emit/、glow 等前缀，`969-996`）——LOD 剔除与调试点色依赖这些标记；
3. `loadLightmapAtlas`：gltf `asset.extras.lightmap`（或 `scene.userData.extras`）→ lightmap 贴图（见 §5）；
4. 包围球 → 对角线 → `defaultNear/far` → `lodManager.setup(meshes)`（自动算 defaultCull/maxCull）；
5. `new PvsManager(pvsJson)`（`hasPvs = clusterCount>0 && pvsBitsBase64 非空`）；
6. `new TeleportManager(teleportJson, spawnList)` —— **仅用于触发器线框与准星元数据**：`checkTeleport` 在 debug 无调用方，真实传送判定在 Rust 权威（`world/teleport-manager.ts`；见 [loading-pipeline.md §4](loading-pipeline.md) 与 [../overview.md](../overview.md)）；
7. triJson → `colliderDebug.setTriMeshes`（phy/vis 两类三角形线框数据源）；
8. mosaicManifest 存档 + `applyTextureQuality(config.texture.quality)`；
9. `adaptBrushes(brushJson)` → `colliders/solids/ladders`（`world/collider-adapter.ts`，Rust 已翻转法线，TS 直接收；
   `ColliderFilter` 默认值见 `world/types.ts:206-216`）；
10. `fogManager.init(scene, sceneRadius, center) + setColor`；`config.lod.cullDistance = lodManager.cullDistance`；
11. `onSceneLoaded(boundingBox.min.y)`（app.ts 记 deathY 并发 set-death-threshold）。

## 5. 光照与 lightmap

- **lightmap 解码**（`renderer/lightmap-shader.ts`，224 行）：VBSP lightmap 是 RGBExp32——`exp = a×255−128`、`rgb × 2^exp`（`VBSP_DECOMPRESS_LIGHTMAP_SAMPLE` chunk）；采样在 shader 内做**手动 4 邻域双线性** + `pow(1/2.2)` gamma（`VBSP_APPLY_LIGHTMAP` chunk），注入 `onBeforeCompile`；atlas 贴图 `NoColorSpace + NearestFilter`（无 mipmap，双线性自己做）；mesh `uv1`（lightmap UV 通道）拷贝到 `uv2` 供注入 shader 使用（`applyLightmapToMeshes`）。
- **基础灯光**（`renderer/light-manager.ts`）：Ambient + Hemisphere + Directional（azimuth/elevation 默认 45/45，方向光距 5000）；`syncFromConfig(config.lighting)` 实时应用 ambientIntensity 等滑块；背景色可配。
- **点光池（预留未接线）**：`MAX_POINT_LIGHTS=8` 的 PointLight 池与 KHR_lights_punctual 提取逻辑（`extractPointLights`/`updatePointLights`）存在于 `light-manager.ts`，但全仓无调用方（grep 仅定义处命中）——当前版本灯光只来自基础三灯 + lightmap。文档如实记录：这是为 glTF 场景点光预留的能力。

## 6. 碰撞可视化（`renderer/collider-debug.ts`，1087 行）

五类绘制对象，全部进 `debugGroup`，`update()` 内限流重建（`collider-debug.ts:611-660`）：

| 对象 | 数据源 | 限流 | 颜色 | 数量上限 |
|---|---|---|---|---|
| brush 凸包线框 + 填充 | `solids/ladders`（collider-adapter 产物） | 每 6 帧（REBUILD_INTERVAL） | 按法线三色（下表） | MAX_DEBUG_COLLIDERS=800（按与相机距离排序取近者） |
| .phy 三角形线框 | triJson `surfaceprop !== undefined` | 每 30 帧 + phyDirty | `0xff8c00` 橙（`:808`） | 不设上限 |
| 可视网格三角形线框 | triJson `surfaceprop === undefined` | 每 30 帧 | `0xaa66ff` 紫（`:862`） | MAX_TRI_LINES=12000 |
| chamfer 高亮 | brush.planes 中"只被 ≤2 边引用、无配对面"的平面 | 每 6 帧 | `0xfffb14` 黄（`:949`），depthTest:false | 无 |
| 触发器 | teleportManager.getTriggers() | 每帧 | 四色（下表） | 无 |

**三色分类**（`classifyNormal`，`collider-debug.ts:220-229`）：`ny > cos(groundAngle)` → 绿地面（0.1,1.0,0.1）；`ny > cos(slideAngle)` → 黄坡面（1.0,0.9,0.1）；否则红墙面（1.0,0.2,0.1）。groundAngle/slideAngle 来自 `config.physics`，默认 30°（地面）与 70°（坡面）（弧度，`config.ts:158-159`）。

**触发器四色**（`rebuildTriggers`，`997-1005`，优先级从上到下）：startDisabled → 灰；非玩家触发（spawnflags & 0x01 CLIENTS / 0x40 EVERYTHING 之外）→ 橙；destIndex<0（orphan，无目标或目标解析失败）→ 紫；正常链接 → 青（0.2,0.8,0.9）。

**凸包重建算法**（`rebuildSolids`，`670-768`）：与 Rust `compute_vertices` 同算法——每 3 个平面 Cramer 求交得候选顶点，再用全部平面做 inside 校验（HULL_EPS=0.5 / FACE_EPS=0.5 / VERT_DUP_SQ=0.01 去重）；顶点 <4 的退化凸包回退 AABB（以最大法线方向定位）；相机进入凸包内时额外画填充面（FILL_OPACITY=0.09）。剔除过滤：XZ 距相机 > cullDistance 或 Y 差 > DEBUG_Y_EXTENT(300) 的 brush 跳过。

**chamfer 判定**（`computeChamferStrips`，`271-319`）：TS 侧不重新生成 bevel（生成在 Rust `export_brushes_planes`，见 [loading-pipeline.md §3](loading-pipeline.md)），只把**没有配对面、只参与棱**的平面识别为 chamfer——判定条件是"平面上恰好有 2 个凸包顶点且两顶点连线是该平面的完整棱"，QUAD 长度 CHAMFER_QUAD_LEN=16，以 depthTest:false 悬浮显示保证可见。

## 7. 纹理画质切换（`applyTextureQuality`，`renderer-main.ts:674-736`）

- `config.texture.quality = 'original' | 'mini'`；切换无需重载地图。
- **mini**：按 `texture.name` 小写查 mosaic manifest → `mosaic_decode(code, 8)`（Rust，×8 最近邻恢复低清 PNG）→ `createImageBitmap` → `map.dispose()` 后替换 `map.image`。**必须 dispose**：three r152+ 对同一 texture 换 image 走增量上传，尺寸不符会 GL_INVALID_VALUE（注释 `720-724`）。替换前原图存 `origTextureImages` 缓存。
- **original**：从 `origTextureImages` 恢复（同样 dispose + 换 image，`697-704`）。
- manifest 未匹配的贴图列入 console 提示（`noMatch`）。

## 8. LOD / PVS 剔除

**LodManager**（`renderer/lod-manager.ts`，356 行）：

- 两级 LOD：`LOD_LEVEL NEAR:0 / FAR:2 / PVS_HIDDEN:-1`（`lod-manager.ts:15-19`）；mesh.visible = (level === NEAR)。
- 视距（`setup`，对角线 diag）：`defaultCull = min(ceil(diag×2/100)×100, 12800)`；`maxCull = ceil(diag×4/100)×100`（`lod-manager.ts:153-154`）。注意：文件头注释写的是旧公式（"上限 = 对角线 ×2，默认 = ×0.5"，`lod-manager.ts:8-9`），**以代码为准**。
- Hysteresis：进出 FAR 边界乘 `CULL_HYSTERESIS=0.85`（防边界抖动，`lod-manager.ts:22`）。
- cluster 定位：`assignClusterIds` 用包围盒 7 个采样点（中心+6 面）在 PVS 树 findLeaf 取并集——单个 cluster 不足以覆盖大 mesh。
- `update(camPos, config, pvsManager)`：每 `config.lod.updateInterval`（默认 1）帧执行；PVS 优先（当前 cluster <0 时跳过 PVS 判定——相机不在任何叶/出生在固体时的安全保护），距离判定带 hysteresis；可见性变化返回 true。
- `setCullDistance`：UI 滑块 clamp [0, maxCull]。

**PvsManager**（`world/pvs-manager.ts`，281 行）：

- `findLeaf(pos)`：BSP 树游走，`d>0 → children[0]`，负值 = `~index` 叶（MAX_DEPTH 256 防环）；叶 cluster<0（solid）→ -1。
- PVS 行解码：bit = `row[target >> 3] & (1 << (target & 7))`；`pvsBitsBase64` → atob → Uint8Array（`base64ToUint8Array`）。
- `update(camPos)`：仅 cluster 变化时重算可见集（缓存 lastClusterId）。
- `getFaceCluster`：面级 cluster 表（WasmPvsData.faceClusters）辅助调试查询。

## 9. 准星平面检查器（`renderer/plane-inspector.ts`，376 行）

- 限频：每 `PLANE_INSPECT_INTERVAL=6` 帧（`renderer-main.ts:36` + `493-501`）从相机沿视线发射，最大距离 `DEFAULT_MAX_DISTANCE=8192` HU（`plane-inspector.ts:16`）。
- 命中优先级（`cast`，`42-95`）：**mesh（BSP 几何）> solid brush > ladder > trigger**；每层独立求交后取最近。
- brush 求交：Ray-Convex-Polyhedron（对每平面算 tEnter/tExit，inside 起步翻转）；trigger 用 Ray-AABB slab 法（`castTriggerAABB`）。
- 输出 `PlaneInfo`（`worker/worker-types.ts`）：距离、法线、brush 面数、trigger 元数据（target/destIdx/classname/spawnflags/startDisabled）、ladder 面向——经 `onPlaneInfo` 回调进侧栏。

## 10. 遗留消费模块

- `physics/math/vec3.ts`（101 行零分配 Vec3）与 `physics/physics/Collision/Collision.types.ts`（49 行平面/凸包/trace 类型）来自 @unsurf/cs-movement 的类型约定，被 collider-debug / plane-inspector / collider-adapter 消费；不做运行时计算。
- `world/teleport-manager.ts` 的 `checkTeleport`/`isPlayerInTrigger`（凸包→AABB→sphere 三级，`296-312`）当前仅被自身文件引用（getTriggers 使用其解析结果）；保留原因是同一套元数据供 UI 与未来离线校验复用。
- `world/spawn-loader.ts` 未接线（见 [loading-pipeline.md §2 注](loading-pipeline.md)）。
