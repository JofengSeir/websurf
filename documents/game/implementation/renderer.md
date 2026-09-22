# implementation / renderer（`apps/game/src/renderer/**`）

## 模块职责

本目录两个文件：`renderer-main.ts` 是主线程渲染与渲染物理的实现，`lightmap-shader.ts` 是离线烘焙光照在 three.js 侧的落地（本工程自有副本）。

`apps/game/src/renderer/renderer-main.ts` 只有一个运行时导出：`RendererMain` 类（`apps/game/src/renderer/renderer-main.ts:116`）。公开面按调用方分三类：

| 分类 | 成员 | 锚点 |
|---|---|---|
| 生命周期 | `init`、`start`、`stop`、`loadScene`、`disposeScene`、`resize` | `apps/game/src/renderer/renderer-main.ts:262`、`:511`、`:518`、`:315`、`:529`、`:1192` |
| 物理线 | `initPrediction`、`buildPredictionWorld`、`feedInput`、`clearPendingInput`、`respawn`、`teleportToSpawn`、`setSpawnPoints`、`setDeathY`、`setHoldPoint`、`releaseHoldPoint`、`loadSavepoint`、`getCurrentVel`、`getFullState`、`resetTo` | `:671`、`:683`、`:709`、`:716`、`:723`、`:730`、`:736`、`:745`、`:813`、`:822`、`:783`、`:750`、`:757`、`:847` |
| 同步与诊断 | `onSceneLoaded`、`onSyncRenderState`、`applyCollisionCorrection`、`setPredictionParams`、`setPredictionNoclip`、`setPredictionHull`、`installFrameProbe` | `:232`、`:253`、`:859`、`:864`、`:876`、`:888`、`:1522` |
| 画面旋钮 | `setFov`、`setExposure`、`setLightGamma`、`setAmbientScale`、`setNearParams`、`setRenderDistance`、`setLightingMode`、`getLightingMode`、`applyTextureQuality` | `:632`、`:643`、`:652`、`:660`、`:622`、`:1204`、`:1272`、`:1279`、`:461` |

`apps/game/src/renderer/lightmap-shader.ts` 有 31 个导出，分为四组：

- **GLSL 片段与 uniform 声明**（四个常量）：`VBSP_DECOMPRESS_LIGHTMAP_SAMPLE`（`:87`）、`VBSP_APPLY_LIGHTMAP`（`:112`）、`VBSP_LIGHTMAP_UNIFORM_DECLS`（`:165`）、`VBSP_AMBIENT_UNIFORM_DECLS`（`:181`）。
- **契约常量与阶段开关**：`VERTEX_LIGHTING_ATTR`（`:198`）、`LIGHTMAP_UV_CHANNEL_CORRECT`（`:329`）、`readLightmapStage`（`:304`）、`isLightmapSkipStage`（`:313`）、`resolveLightmapUvChannel`（`:338`）、`installGamma22Output`（`:255`）。
- **装载与施加**：`loadLightmapAtlas`（`:374`）、`applyLightmapToMeshes`（`:482`）、`fullbrightUnlitLitMaterials`（`:1067`）。
- **运行期旋钮与读取**：`setLightingMode` / `getLightingMode` / `isTextureOnlyMode`（`:436`、`:442`、`:447`）、`setPropVertexRelax` / `getPropVertexRelax`（`:1686`、`:1691`）、`setPropVertexFlatten` / `getPropVertexFlatten`（`:1705`、`:1710`）、`getVertexLightingRelaxStats`（`:1674`）、`setLightFloor` / `getLightFloor`（`:1752`、`:1757`）、`setLightGamma` / `getLightGamma`（`:1788`、`:1795`）、`setExposure` / `getExposure`（`:1807`、`:1817`）、`setAmbientScale` / `getAmbientScale`（`:1829`、`:1836`）。

## 关键流程与不变量

- **装配顺序**：GLB 解析 → `resetRootRotations` → 摘除 punctual 光源（必须先于挂进主场景）→ `applyLightmap`（必须先于分块合并）→ `optimizeScene` → 受光材质终扫 → 预编译（`apps/game/src/renderer/renderer-main.ts:323`、`:344`、`:353`、`:358`、`:366`、`:372`、`:387`）。
- **一帧的固定顺序**：写输入槽 → 消费权威帧 → 校准速度 → 推进物理 → 写渲染采样 → 相机位姿 → 剔除 → 绘制（`apps/game/src/renderer/renderer-main.ts:932`、`:934`、`:936`、`:938`、`:955`、`:957`、`:977`、`:998`）。
- **dt 上限**：每帧 `dt` 被夹在 0.1 秒内，首个物理帧取 1/64 秒（`apps/game/src/renderer/renderer-main.ts:929`）；这是「主线程卡顿不产生物理慢动作」的判据来源。
- **世代单调**：`bumpSampleEpoch` 只做「本地计数 +1 + 通知共享层」（`apps/game/src/renderer/renderer-main.ts:235`），真正生效的世代在共享槽里（`src/ts-shared/auth/shared-state.ts:399`）；`resetSampleStream` 同时把序号归零与世代 +1（`apps/game/src/renderer/renderer-main.ts:241`）。
- **光照三路径与 fullbright 收敛**：world 面走 atlas、prop 第 1 级走几何属性 `_VBSP_VLIGHT`、第 2 级走 leaf ambient cube；无 lightmap 的图元统一收敛到 fullbright（`apps/game/src/renderer/lightmap-shader.ts:543`）；`extras.unlit === true` 的图元跳过光照（`apps/game/src/renderer/lightmap-shader.ts:830`）。
- **`hasLightmap` 的读取源**：判据优先读 `geometry.userData`、回落 `mesh.userData`（`apps/game/src/renderer/lightmap-shader.ts:882`、`:883`）；`== false` 的图元必须在「检测 uv1/uv2」之前拦下（`apps/game/src/renderer/lightmap-shader.ts:885`）。
- **材质去重**：按 map / color / transparent / opacity / alphaTest / side / depthWrite / alphaMap / 线框标记组成键复用材质实例，使分块合并的按材质分组仍然成立（`apps/game/src/renderer/lightmap-shader.ts:516`、`apps/game/src/renderer/lightmap-shader.ts:794`）。
- **分块合并的失败语义**：任一步合并失败都回退为「保留各自独立几何」，不存在「合并失败即丢弃」的路径（`apps/game/src/renderer/renderer-main.ts:1423`、`apps/game/src/renderer/renderer-main.ts:1446`）。
- **视锥外保留圈**：块几何的包围球半径统一乘 `FRUSTUM_PAD`，且必须无条件重算（克隆几何会带上局部空间的旧球）（`apps/game/src/renderer/renderer-main.ts:81`、`apps/game/src/renderer/renderer-main.ts:1476`）。
- **出帧探针只读不写**：`installFrameProbe` 往 `globalThis.__vbspFrameProbe` 挂一个对象（`apps/game/src/renderer/renderer-main.ts:1769`），其 `applyPose` 复用生产路径的冻结机制（`setHoldPoint`）而新增任何渲染分支（`apps/game/src/renderer/renderer-main.ts:1683`、`:1714`）。
- **注入生效性统计延后到首帧之后**：`applyLightmap` 只置 `pendingInjectReport`，统计由 `tick` 在首帧 `render()` 之后跑一次（`apps/game/src/renderer/renderer-main.ts:1257`、`:1001`）。

## 已知缺口

- **PVS 剔除在本工程被常量关死**：`ENABLE_PVS` 为 `false`（`apps/game/src/renderer/renderer-main.ts:113`），因此 `tick` 既不调 `pvs.update`，也不按 cluster 隐藏块（`apps/game/src/renderer/renderer-main.ts:972`、`apps/game/src/renderer/renderer-main.ts:975`）；`pvsManager` 仍被构造、每块仍被分配 `clusterIds`（`apps/game/src/renderer/renderer-main.ts:401`、`apps/game/src/renderer/renderer-main.ts:429`）——这部分计算在当前配置下不产生剔除效果。
- **`sampleEpoch` 字段只写不读**：本类的该字段只在 `bumpSampleEpoch` 里自增（`apps/game/src/renderer/renderer-main.ts:166`、`:236`），本文件没有第二个读取点；共享槽里的世代才被 Worker 复检（`apps/game/src/worker/main.ts:276`）。
- **`resetTo` 在本工程内没有调用点**：方法体只转发给校准器（`apps/game/src/renderer/renderer-main.ts:847`、`:848`）；`apps/game/src` 内没有外部调用者（本次实测零匹配），主线程的位置突变各走 `respawn` / `teleportToSpawn` / `loadSavepoint` 三条路径（`apps/game/src/renderer/renderer-main.ts:723`、`:730`、`:783`）。
- **`applyCollisionCorrection` 的入参有三个不被读取**：`_pos` / `_yawDeg` / `_pitchDeg` 在共享层实现里带 `_` 前缀（`src/ts-shared/phys/authority-calibrator.ts:735`），实际写入的位置与角度取自渲染自身当前状态（`src/ts-shared/phys/authority-calibrator.ts:776`）；`blocked` 事件与「渲染自己未着地」两种情形都是零写入（`src/ts-shared/phys/authority-calibrator.ts:743`、`:768`）。
- **`setLightGamma` 的接受窗口窄于所有调用方**：窗口是 `(0, 1]`（`apps/game/src/renderer/lightmap-shader.ts:1789`），而 `init` 传入的 `config.lighting.lightGamma` 默认 2.2（`apps/game/src/renderer/renderer-main.ts:270`）、面板滑块量程 0.5..6（`apps/game/src/panel/panel-controller.ts:471`）；窗口外的写入既不报错也不生效，共享 uniform 停在自身初值（`apps/game/src/renderer/lightmap-shader.ts:1556`）。
- **光照模块内多个导出在本工程零导入点**：`setLightFloor` / `getLightFloor`（`apps/game/src/renderer/lightmap-shader.ts:1752`、`:1757`）、`isTextureOnlyMode`（`:447`）、`isLightmapSkipStage`（`:313`）、`getExposure`（`:1817`）、`getLightGamma`（`:1795`）、`getAmbientScale`（`:1836`），以及四个 GLSL 片段与 uniform 声明常量（`:87`、`:112`、`:165`、`:181`）——`renderer-main.ts` 的 import 面（`apps/game/src/renderer/renderer-main.ts:45`）不含它们。
- **分块尺寸自适应忽略多材质网格**：`worldBox` 只在单材质分支里累计（`apps/game/src/renderer/renderer-main.ts:1340`），数组材质与无材质网格走 `keptMeshes` 的早退分支（`apps/game/src/renderer/renderer-main.ts:1321`、`:1332`）；因此 cell 边长按「单材质网格的包围盒并集」估，场景里只有多材质网格时该并集为空（此时 `infos.length === 0`，整个分块直接返回，`apps/game/src/renderer/renderer-main.ts:1344`）。
- **`applyLightmapToMeshes` 自身不判空图集**：`atlasTexture` 为 `null` 时的行为由调用方保证（`apps/game/src/renderer/lightmap-shader.ts:474` 的口径），`applyLightmap` 在 `!atlas` 时提前返回（`apps/game/src/renderer/renderer-main.ts:1241`）。
- **`loadScene` 的入口先释放上一张图**：`disposeScene` 在方法开头调用（`apps/game/src/renderer/renderer-main.ts:317`），因此换图失败时场景处于已释放状态，只能重新选图恢复（失败路径见 `apps/game/src/app.ts:601`）。
