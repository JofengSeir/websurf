# viewer 实现细节 · 场景与自由飞行（core/ + ui/）

> 本文覆盖 `apps/viewer/src/core/*`、`apps/viewer/src/ui/*`：渲染场景、飞行相机、位姿契约、常量、
> DOM 工具与三个 UI 组件（hud / mapinfo / replaymeta——原第四个组件 ReferenceGrid 已随 2026-09
> 界面精简移除，见 §6.2）。总览见 [../overview.md](../overview.md)，时序见 [../sequences.md](../sequences.md)；
> 录像子系统另见 [replay-system.md](replay-system.md)。

## 1. ViewerScene（`apps/viewer/src/core/scene.ts`，416 行）

**职责边界**（文件头注释 `scene.ts:1-4`）：renderer/scene/camera/灯光/GLB 挂载/空间分块合并/相机 near-far 自适应；**不持有输入与位姿状态**（那些在 `fly.ts`），只提供挂载与渲染能力。渲染方法与 game `renderer-main` 对齐：三点光、近平面贴墙自适应、无雾、`far = maxDim × 100`（`scene.ts:2`、`constants.ts:14-15`）。

### 1.1 构造（`scene.ts:57-84`）

- `WebGLRenderer({canvas, antialias, powerPreference:'high-performance'})`，`setPixelRatio(min(devicePixelRatio, 2))`、`outputColorSpace = SRGBColorSpace`（`scene.ts:58-65`）。
- 背景色 `BG_COLOR = 0x0d1b2a`（`scene.ts:68`、`constants.ts:22`）。
- 相机 `FOV=73.6`、初始 near/far `0.1 / 100000`（`scene.ts:70-76`、`constants.ts:9-13`）。
- 三点光：Ambient 0.6 + Hemisphere(0xb0c4de/0x404030, 0.4) + Directional(0xfff4e0, 0.5)（`scene.ts:78-83`，注释"与 game renderer-main 相同的三点光组合"）。

### 1.2 GLB 挂载（`scene.ts:124-151`）

`mountGlb(glbBytes)`：字节拷贝 → Blob URL → `GLTFLoader.loadAsync` → revoke；旧地图 `disposeObject` + remove（防重复加载泄漏，`scene.ts:136-140`）；`resetRootRotations` 清 GLB 根节点旋转（`scene.ts:407-416`，注释"与 game renderer-main resetRootRotations 同法"）；`optimizeScene()` → `fitCamera()`。`disposeObject` 递归 dispose geometry/texture/material（`scene.ts:392-405`）。

### 1.3 相机 near/far 自适应（`fitCamera`，`scene.ts:153-167`）

地图加载后：`near = max(maxDim/1000, 0.05)`（`CAMERA_NEAR_MIN`）、`far = max(maxDim × 100, 初始 far)`——注释明示"原 diag×2 + 65536 截断会裁掉超大地图远景"（`scene.ts:154-156`）。`CAMERA_FAR_SCALE=100` 标注"与 game loadScene 一致"（`constants.ts:14-15`）。

### 1.4 近平面贴墙自适应（`updateNearPlane`，`scene.ts:169-233`）

每 2 帧执行一次（`render()` 里的 `nearCheckToggle`，`scene.ts:107-114`）：

1. **包围球粗筛**（BSP 模型子树内 `modelRoot.traverse`，几何包围球中心距相机 `< probe×2 + radius` 才入选，`scene.ts:183-197`）；
2. **6 方向探测**：相机局部系前/后/左/右/**上/下**（`scene.ts:199-213`）——注释明示与 game 的差异："game 为 4 水平方向，查看器自由飞行会贴地/贴顶，补垂直两向"（`scene.ts:170-172`；game 侧实况：`apps/game/src/renderer/renderer-main.ts:381-424` 的 `dirs` 为 4 个水平正交方向）；
3. 探测命中 → `near = max(minDist × nearRatio(0.3), 0.05)`；空旷 → 恢复 `defaultNear`（`scene.ts:225-233`，常量 `constants.ts:16-21`：`CAMERA_NEAR_MIN=0.05`、`NEAR_PROBE_DIST=100`、`NEAR_RATIO=0.3`，均标注与 game 默认一致）。

### 1.5 空间分块合并（`optimizeScene`，`scene.ts:235-388`）

- 来源：从 test/dual-mode-harness 移植的合并算法（`scene.ts:235-245` 注释"移植自 test/dual-mode-harness worker-b.ts"）。
- 目标块数与 cell 尺寸：目标 512 块，下限 300 / 上限 800，cell 在 128–4096 HU 间迭代（最多 6 次）求满足目标的最粗 cell（`scene.ts:22-26` 常量、`scene.ts:286-303` 迭代）。
- 空间分桶：`optCellKey = floor(x/cell)|floor(y/cell)|floor(z/cell)`（`scene.ts:30-32`）。
- 同 cell 内**按材质分组**再 `mergeGeometries`（`scene.ts:312-352`）；多材质 Mesh（material 数组）不进分桶——世界变换烘焙进几何后单独保留（`keptMeshes` 路径，`scene.ts:254-270`）。
- **失败兜底**：最终合并失败（indexed/non-indexed 属性不兼容）时**全部单独保留**而不是只留第一块——注释"与 game 同法——只留第一块会把该 cell 其余几何静默丢掉（渲染不全根因）"（`scene.ts:364-370`）。
- **视锥外保一圈**：合并后重算包围球并 `radius ×= FRUSTUM_PAD(1.6)`（"快移/猛转时新入视锥几何已预渲染"，`scene.ts:27-28, 376-383`）。
- 旧根移除、新根挂回 `modelRoot`（`scene.ts:385-388`）。

### 1.6 拾取接口

`hasModel()` / `model` getter（拾取用）/ `worldBox()`（地图贴合检查/录像对照用，`scene.ts:86-99`）。

## 2. FlyCam 自由飞行相机（`apps/viewer/src/core/fly.ts`，220 行）

**职责**（`fly.ts:1`）："持有位姿状态、处理键鼠输入，并把状态写入 three 相机。"

### 2.1 状态字段（`fly.ts:19-41`）

| 字段 | 语义 |
|---|---|
| `pos` | 人物**脚底**位置（相机 y = pos.y + `EYE_STAND`，`fly.ts:174-177`） |
| `yaw` / `pitch` | 弧度；yaw 0 = 面朝 −Z、逆时针为正；pitch ±89° 限幅 |
| `roll` | 仅回放第一人称使用，自由飞行恒为 0（`fly.ts:25-26`） |
| `locked` | 指针锁定状态（外部只读） |
| `drivesCamera` | 是否把状态写入相机——回放第一人称时为 false（相机由播放器驱动），退出即原地接管 |
| `allowMove` | 是否响应 WASD——回放第一人称时为 false（防止"按了键在看不见的地方挪位置"） |
| `allowPointerLock` | 量测拾取时可关，避免抢点击 |

### 2.2 输入处理（`attach`，`fly.ts:57-105`）

- 点击画布请求指针锁定（`fly.ts:60-62`）；`requestLock` 用 `unadjustedMovement: true`，Promise 拒绝或同步抛错时降级普通锁定（`fly.ts:112-135`）。
- `pointerlockchange` 解锁时清空键鼠状态，并置 `discardNextMouse`——丢弃锁定后的首个 mousemove（初始跳变通常 2000-5000+ px，`fly.ts:69-78`、`constants.ts:31-32`）。
- mousemove 增量**绝对值削平** ±1000px（防事件合并/驱动异常跳变，`fly.ts:80-88, 107-110`）。
- MOVE_KEYS 白名单（WASD/Space/C/Shift，`fly.ts:207-218`）；blur 时清空（`fly.ts:100-105`）。

### 2.3 每帧推进与写相机（`fly.ts:137-206`）

- `update(dt)`（`fly.ts:138-167`）：先消化鼠标增量（`yaw -= dx×SENS`、pitch 限幅），再按键位移——前向 `(-sin yaw, 0, -cos yaw)`、右向 `(cos yaw, 0, -sin yaw)`，W/A/S/D + Space 升 + C/Ctrl 降，Shift ×4（`FLY_SPEED=500` HU/s，键表 `fly.ts:207-218`、常量 `constants.ts:24-26`）。
- `applyTo(camera)`：`drivesCamera` 为 false 时跳过（回放接管期）；写相机 `rotation.set(pitch, yaw, 0, 'YXZ')` + `position = pos + EYE_STAND`（`fly.ts:169-177`）。
- `applyToWithRoll(camera, eyeOffset)`：回放第一人称专用，叠加 roll（`fly.ts:195-198`）。
- 位姿进出：`setPose`（度 → 弧度 + 限幅，出生点跳转用）、`setWorld`（弧度直写，回放同步用）、`getPose`（度返回，HUD 读数用）（`fly.ts:180-206`）。

## 3. 位姿契约与换算（`apps/viewer/src/core/pose.ts`，36 行）

- `Pose = { pos:[x,y,z] 脚底; ang:[yawDeg, pitchDeg] }`（`pose.ts:5-9`）——HUD 读数、出生点跳转、回放相机三处共用（`pose.ts:1`）。
- `wrapDeg(d)`（`pose.ts:11-14`）：角度归一 [0,360) 单点实现（`replay/helpers.ts` 从此转发导出，两条路径共用）。
- `bspYawToCsYaw(bspYaw) = wrapDeg(bspYaw + 180)`（`pose.ts:23-25`）：BSP 出生点实体 Source yaw → viewer yaw。**t1 已修评审 F6**——旧式 `(270 − yaw) mod 360` 是 det=−1 镜像映射（surf_null primary srcYaw=180 应为 0°，旧式给 90°），现与 `.replay` 帧解码的实测定标（`yaw = wrap(srcYaw+180)`，`shavit-replay.ts:494-498`）**同一口径**。同式多处各自维护（互不 import，公式对齐，见 [../differences.md](../differences.md) §7.2）：`apps/viewer/src/core/pose.ts:23-25`、`src/ts-shared/phys/world-builder.ts:99-100`、`src/phys/teleport.rs:31-38`（Rust）、`apps/debug/src/world/spawn-loader.ts:65-66` 与 `apps/debug/src/world/teleport-manager.ts:42-44`——改公式需多处同步。
  该式服务 BSP 出生点/传送实体角路径：初始视角经 `core/spawn.ts:47-50 spawnPointAng`（P2-4 回退解析 `spawn.ts:79-101`，消费在 `app.ts:270-273`）、出生点列表 title/跳转 `mapinfo.ts:144-161`。
- `pitchClampedRad` / `eyeHeight`（`pose.ts:27-35`）。
- `EYE_STAND = 64.09` HU（`core/constants.ts:6-7`，注释"与 game EYE_STAND 一致"）——与共享物理常量同值：`src/phys/player.rs:34` `pub const EYE_STAND: f64 = 64.09`。

## 4. 常量与 DOM 工具

### 4.1 `core/constants.ts`（35 行）

| 常量 | 值 | 与 game 的关系（代码内注释自证） |
|---|---|---|
| `EYE_STAND` | 64.09 | "与 game EYE_STAND 一致"（`constants.ts:6-7`；共享物理同值 `src/phys/player.rs:34`） |
| `FOV` | 73.6° | — |
| `CAMERA_INIT_NEAR/FAR` | 0.1 / 100000 | "与 game renderer init 一致"（`constants.ts:11-13`） |
| `CAMERA_FAR_SCALE` | 100 | "与 game loadScene 一致：基本无远裁剪"（`constants.ts:14-15`） |
| `CAMERA_NEAR_MIN` | 0.05 | "与 game CAMERA_NEAR_MIN 一致"（`constants.ts:16-17`） |
| `NEAR_PROBE_DIST` / `NEAR_RATIO` | 100 / 0.3 | "与 game NEAR_PROBE_DIST_DEFAULT / NEAR_RATIO_DEFAULT 一致"（`constants.ts:18-21`） |
| `FLY_SPEED` / `FLY_SPEED_FAST` | 500 / ×4 HU/s | — |
| `MOUSE_SENS` | 0.0022 rad/px | — |
| `PITCH_LIMIT(_DEG)` | 89° | — |
| `MOUSE_MAX_DELTA` | 1000 px | — |

### 4.2 `core/dom.ts`（136 行）

面板 UI 的 DOM 样板工具：`qs`（按 id 取）、`el(tag, cls, text, attrs)`（属性 `true` → 空串、`undefined/false` 跳过）、`section(parent, title)`（面板分区）、`foldBox`（`<details>` 折叠分组，`dom.ts:41-51`）、`numField`（非法输入不上抛（`valid=false`），保持上一次有效值，`dom.ts:65-87`）、`checkField`、`buttonRow`、`noteLine`（可反复设置的状态行，空文本自动隐藏，`dom.ts:122-133`）。全部 `ui/` 与 `replay/panel.ts` 等面板都基于它构建。

## 5. Hud（`apps/viewer/src/ui/hud.ts`，143 行）

**三行状态域**（`hud.ts:1-7` 头注释明示角色划分）：

| DOM | 域 | 持久内容 | 临时消息 |
|---|---|---|---|
| `#pose` | 位姿读数 | 只读 | 无 |
| `#bspStatus` | 地图域 | `setStatus`（解析进度/成功摘要/失败） | `flashStatus`（约 3s 后恢复持久文本，`hud.ts:58-73`） |
| `#replayStatus` | 录像域 | `setReplayStatus`（跨面提醒） | `flashReplayStatus`（导入进度/工具结果，默认 8s，`hud.ts:83-98`） |

- flash 语义：临时消息显示 ms 后恢复**该行**持久文本（'' 立即恢复，不残留）（`hud.ts:6-7`）。
- 帮助浮层：顶栏 `?` 开 / × 或 Esc 关，非模态不拦点击（`hud.ts:28-38, 100-108`）。
- 启动兜底：`showFatal`（WebGL 不可用）+ `showGuide/showGuideError`（首访引导层报错）+ `setDropActive`（拖拽高亮）（`hud.ts:110-143`）。
- HUD 行内容与分工的跨面逻辑（哪条消息进哪个域）见 `app.ts:157-188` 的 `updateReplayMapStatus` 注释。

## 6. MapPanel（`apps/viewer/src/ui/mapinfo.ts`，171 行；ReferenceGrid 已移除）

### 6.1 MapPanel（地图页全部内容）

- 「更换地图」入口：加载成功后显示，点击走 `#bspFile.click()` 同一链路（`mapinfo.ts:44-55`；加载中 `setLoadBusy` 禁用，`mapinfo.ts:69-72`）。
- 地图信息：默认核心三行（文件 / 出生点数 / 世界尺寸 X×Y×Z HU，`mapinfo.ts:93-108`）；magic/brushes/faces/models/vertices/static props/PAKFILE 数/解析耗时/包围盒收进「统计明细」折叠（`mapinfo.ts:110-123`）。
- 出生点导航：单行 pill（★ = 初始视角命中点——`setMap` 接收 app 侧 `resolveInitialSpawn` 的下标，与初始视角同源；P2-4 回退下推荐位可能不是 wasm primary，`mapinfo.ts:74-83`），坐标与 viewer 约定 yaw/pitch 全量进 title（`spawnPointAng` 同款：yaw=wrap(src+180)、pitch=−src）；「跳转」按钮 → `onJump(pose)` → `fly.setPose`（`mapinfo.ts:126-166`，跳转按钮 `:154-161`；app 侧在 `app.ts:94-99` 接线，回放第一人称时跳转被忽略）。
- **出生点快照**：`spawnPoints` getter 暴露 `{name,pos}[]`（世界坐标脚底，`mapinfo.ts:37-38, 64-67`）——消费方只剩「出生点导航」跳转列表自身（头注释 `:64` 同口径）；录像侧已不再消费（t4 起无「起点对齐」检测与一键锚定）。

### 6.2 ReferenceGrid（已移除）

- `apps/viewer/src/ui/reference.ts`（地面网格 + 世界坐标轴）已于 2026-09 界面精简中**删除**——地图页底部不再有「参考显示」开关；`scene.worldBox()` 仍保留（拾取接口，§1.6），地图贴合检查改由 HUD 提醒承担（`app.ts:157-188`）。
- 证据：`src/ui/` 现仅 `hud.ts / mapinfo.ts / replaymeta.ts` 三文件；冒烟自检断言「参考显示（ReferenceGrid）已不存在」（`test/smoke-cdp.mjs:651-664`）。
