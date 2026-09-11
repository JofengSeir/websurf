# debug 与 game/viewer/test 的核心差异（维度 D）

> debug 与 game 共享同一套物理内核与 TS 共享层，差异主要在"调参/调试工具"与"游玩体验"的取舍上。同构部分先讲清楚（§1-§2），再逐条讲差异（§3-§7）。同构与差异的全部论断都标注代码路径；两端文件未读的部分不写结论。

## 1. 完全同构的骨架（不要在这上面找差异）

| 层 | 两端实现 | 代码路径 |
|---|---|---|
| 双线架构 | 主线程渲染物理线 + Worker 权威线，v7 校准（首帧起点/速度外推/兜底反向同步/碰撞事件修正） | `debug/src/renderer/renderer-main.ts:430-516` ≙ `game/src/renderer/renderer-main.ts:693-768`；校准器共享 `src/ts-shared/phys/authority-calibrator.ts` |
| 状态通道 | 同一 SAB 512B 布局 + MsgState 回退，同一工厂函数 | `src/ts-shared/auth/shared-state.ts:344-356`（两端都走 `createMainSharedState`） |
| 权威循环 | 同一 setTimeout 4ms + 固定步长累积器 + land/blocked 事件 | `src/ts-shared/auth/auth-loop.ts`（两端各自 `createAuthLoop`，`debug/src/worker/main.ts:81` ≙ `game/src/worker/main.ts:72-78`） |
| 消息分发 | 同一 worker-dispatch（通用消息集完全一致） | `src/ts-shared/auth/worker-dispatch.ts` |
| 加载管线 | 同一 buildWorldBundle（metadata→碰撞→mosaic→GLB→spawn） | `src/ts-shared/phys/world-builder.ts`（两端 handleLoadBsp 消费，`debug/src/app.ts:1292` ≙ `game/src/app.ts:406`） |
| 参数映射 | 同一 buildPhysicsParams（sensitivity 固定 1、jumpHeight²/2g） | `src/ts-shared/phys/params.ts`（`debug/src/worker/main.ts:50-66` ≙ `game/src/worker/main.ts:42-66`） |
| 输入层 | 同一 layerMouseDelta + qeEquivalentDx（灵敏度只乘主线程一次） | `src/ts-shared/input/input-layer.ts` |
| Rust 内核 | 两个 crate 同名 websurf-wasm，都 `pub use websurf_phys::phys::PhysWorld`，都含运行时 chamfer 生成 | `debug/crates/wasm/src/lib.rs:22,2552` ≙ `game/crates/wasm/src/lib.rs`（chamfer `:1973`） |
| 输入四件套 | input-bridge/keyboard/mouse-buffer/pointer-lock 同构（两端行数几乎一致） | `debug/src/input/*` ≙ `game/src/input/*` |

## 2. 双端同参不变量（差异的"锚"）

- 两端 `buildPredictionParams`（主线程渲染实例）与 worker `syncParamsToWasm`（权威实例）都收敛到共享 `buildPhysicsParams`：`debug/src/app.ts:1229-1253` + `debug/src/worker/main.ts:50-77`；`game/src/app.ts`（config 段）+ `game/src/worker/main.ts:42-69`。
- 物理默认值两端一致（gravity 800 / maxSpeed 250 / walkSpeed 130 / crouchSpeed 85 / tickRate 64 等）：`debug/src/config.ts` DEFAULT_CONFIG ≙ `game/src/config.ts:95-111`。
- 因此差异只可能来自：**面板参数覆盖**（debug 有）、**hull 缩放**（debug 有）、**tickRate 语义**（§3.3）。

## 3. debug vs game：逐条差异

### 3.1 定位与形态

| | debug | game |
|---|---|---|
| 目标 | 调参/查碰撞/验时序 + 计时挑战 | 游玩（跑图）+ 存点练习 |
| 面板形态 | 常驻侧栏（参数面板 + 调试可视化开关） | ESC 弹出式双栏面板（PanelController） |
| 入口 | `app.ts`（1814 行） | `app.ts`（687 行）——debug 的 UI/面板/可视化代码量约为 game 的数倍 |

### 3.2 配置体系（`config.ts` 对比）

- debug：`RuntimeConfig` **11 段**（physics/player/movement/smoothing/teleport/lod/lighting/input/hud/debug/texture，`debug/src/config.ts`）；`syncFullConfig` 发送 **10 段**（texture 除外，`debug/src/app.ts:1768-1789`）。
- game：`RuntimeConfig` **6 段**（lockTickRate + physics/input/player/hud/texture，`game/src/config.ts:79-90`）；`syncFullConfig` 只发 physics/input/player/hud 4 段（`game/src/app.ts:512-519`）。
- debug 独有段承载调试能力：movement（movement 200 sprint×4）、smoothing、teleport（triggerRadius/cooldown）、lod（PVS/视距）、lighting（ambient）、debug（近平面/准星检查/碰撞可视化开关）、hud；game 独有：`lockTickRate`（V8/P2 计时玩法公平性——true 时面板 64Hz 只读，`game/src/config.ts:80-84,93`）与 crosshair 风格化配置（颜色/长度/描边，`game/src/config.ts:47-71`；debug 的准星是调试信息不是风格化对象）。

### 3.3 tickRate 语义（容易踩坑的差异）

- debug：面板 tickRate = 权威固定步长，直传无偏移（`debug/src/worker/main.ts:98` `getConfigTickRate: () => config.physics.tickRate`）。
- game：**隐藏偏移 +3**——面板显示/输入原值，实际权威步长 = 原值+3（如 64 → 67Hz；`game/src/worker/main.ts:32` `TICK_RATE_OFFSET = 3`、`:86` `getConfigTickRate: () => config.physics.tickRate + TICK_RATE_OFFSET`）。偏移是 game 侧"用户定调 2026-08-18"的产物，不体现在面板/HUD。
- debug 没有 lockTickRate；game 的 tickRate 在 lockTickRate=true 时只读。

### 3.4 物理面板（debug 独有链路）

- debug：13 项 `PARAM_DEFS` → `set-physics-param` 消息族 → Worker `PhysicsParams`（overrides + snapshot）→ `set_params` 单项 patch + `physics-snapshot` 回传 → 主线程回填并**镜像到渲染实例**（`debug/src/physics/param-defs.ts`、`physics-worker.ts:50-85`、`app.ts:1630-1696`）。详见 [implementation/physics-panel.md](implementation/physics-panel.md)。
- game：无面板参数消息——面板改的是 config，经 `bridge.sendConfig(section, patch)` 走通用 config 通道（`game/src/input/input-bridge.ts:30`）。全仓 grep `set-physics-param` 仅 debug 命中。
- 两侧的 `onExtraMessage`/`onWorldBuilt`/`onConfigApplied`/`onWasmInit`/`onInit` 钩子：debug 全部注入（`debug/src/worker/main.ts:106-119`），game 一个都不用（`game/src/worker/main.ts:80-93` 只传必需项）——共享分发器的工程扩展点实质上只有 debug 在用。

### 3.5 玩法层：计时挑战 vs 存点

- **debug 计时挑战**：`debug/src/game-state.ts`（191 行，idle→running→finished、检查点 targetname 去重、死亡回退）+ `app.ts` 接线（onRenderPhysEvent `1471-1493`）；respawn 按钮语义"回最后检查点"（`app.ts:863-880`）。
- **game 无计时挑战状态机**：全仓 grep `计时/challenge/checkpoint/game-state` 仅命中 lockTickRate 注释（`game/src/config.ts:81,93`、`panel-controller.ts:222`），无对应状态文件——大纲遗留问题 #4 已核实。
- **game 独有存点系统**：X 存点 / C 读点，`SavePointStore`（按地图 localStorage `websurf-game.savepoints.<map>`，上限 50 遗弃最早，`game/src/savepoint.ts:27-30`）；按住 C 冻结——渲染 tick 每帧强制 `set_state(存点位置, 速度 0)`（`game/src/renderer/renderer-main.ts:713-718`）。debug 无存点；debug 侧对应物是**自定义传送点**（`vbsp:customTeleports:<map>`，上限 50，`debug/src/world/custom-teleports.ts`——语义是"跳到点"而非"恢复速度冻结"）。
- **键位**：debug 固定键位（`keyboard.bind(window)`，KeyState 全键位，无改键 UI）；game 有完整改键系统（`game/src/input/keymap.ts`：action→code[] 多绑定、localStorage `websurf-game.keymap.v1`、面板录制，`ACTION_LABELS`/`DEFAULT_KEYMAP`）。
- **死亡阈值**：debug 把场景 minY 同步给权威（`set-death-threshold` 初发 + world-json 后重发，`debug/src/app.ts:250-258,1362-1363`）→ 双线都判死。game 的 `InputBridge.sendSetDeathThreshold` 存在但**无调用方**（grep 全仓仅定义 `game/src/input/input-bridge.ts:68-73`），`onSceneLoaded` 只设主线程 `setDeathY`（`game/src/app.ts:129`）——game 权威线不判死（death_y 保持 Rust 默认 -100000），一致性靠渲染线死亡重生后的大偏差兜底同步。

### 3.6 渲染器组织（debug 拆分 vs game 内联）

- debug 把渲染职责拆成 8 个子管理器（camera-controller / lod-manager / fog-manager / light-manager / lightmap-shader / collider-debug / plane-inspector + world 层 pvs-manager/teleport-manager/collider-adapter），renderer-main 只做接线（`debug/src/renderer/renderer-main.ts`）。
- game 同一份 tick 逻辑**内联在单文件**：LOD/PVS 循环直接写在 renderer-main（`game/src/renderer/renderer-main.ts:738-764`），相机直接 `camera.rotation.set(pitch, yaw, 0, 'YXZ')`（`:726`）不经过 CameraController 类。
- debug 渲染是条件触发（`predReady || needsRender`，`debug/src/renderer/renderer-main.ts:505-509`）；game 每帧无条件渲染（`game/src/renderer/renderer-main.ts:766-767`）。
- debug 独有的可视化/检查设施：ColliderDebug（凸包三色/chamfer/tri/触发器四色）、PlaneInspector、FogManager、LightManager（含未接线点光池）、cull 统计回传（emitCullStats）。game 全部没有——其渲染器头注自述"无 lightmap/雾/碰撞可视化/准星射线"（`game/src/renderer/renderer-main.ts:10`），**lightmap 解码着色器注入（RGBExp32）为 debug 独有**（`debug/src/renderer/lightmap-shader.ts`）。
- 两端都有：近平面自适应、纹理画质切换（`applyTextureQuality`/`mosaic_decode`，`game/src/renderer/renderer-main.ts:295,335` ≙ `debug/src/renderer/renderer-main.ts:674-736`）两端同构。
- 资源释放：debug `disposeObject` 覆盖 11 类纹理槽 + `disposeScene` 递归（`renderer-main.ts:294-325`）；game 只释放 `map` 一个槽位（`:676-689`）。

### 3.7 加载体验与 UI

- debug：侧栏状态行 + 缺失纹理比对弹窗（`collectMissingTextures: true` 传入 world-builder，`debug/src/app.ts:1292-1298`；game 不传该选项）+ 视距滑块动态范围（`onSceneReadyUi`，`app.ts:350-359`）。
- game：全屏进度覆盖层（阶段→百分比映射 + 动画，`game/src/app.ts` showLoading/advanceLoading 段）。
- 两端 handleLoadBsp 顺序同构（loadScene → buildPredictionWorld → world-json → spawnList 双端 → syncFullConfig），参数差异仅 collectMissingTextures/colliderSource 显式传参（game 用默认值）。

### 3.8 工程杂项

- 消息类型：debug `worker/worker-types.ts` 342 行（含 PlaneInfo/SceneDataMessage/PhysicsSnapshot 等调试类型）；game 版本较小，且头注仍提"Worker-B（预测）用独立协议（worker-types-predictor）"（`game/src/worker/worker-types.ts:6`）——该文件在两工程都不存在（`game/src/worker/` 只有 main.ts/worker-types.ts），属历史残留注释，不构成任何运行时行为。
- 数据契约：debug `world/types.ts` 231 行（brush/spawn/teleport/PVS/metadata/ColliderFilter 全集）；game `world/types.ts` 仅 34 行 PVS 类型——因为 game 的渲染器不消费 brush/teleport JSON 的 TS 侧类型（碰撞体直接以字符串透传 wasm）。
- 脚本：两端都有 build-dist.mjs + check-wasm-api.mjs；game 另有 9 个 `phys-*.mjs` 物理诊断脚本（`game/scripts/`），debug 侧无对应物；debug 原有的 `verify:chamfer` 空引用入口（指向当时不存在的 `scripts/verify-chamfer.mjs`）已删除。

## 4. debug vs viewer

- viewer 不含物理：消费 WASM 薄导出（懒初始化 → metadata → spawn → GLB），无 Worker、无 PhysWorld、无权威帧（大纲 §2.3；`viewer/src/core/bsp.ts`）。debug 是完整双线物理。
- viewer 是回放器：录像驱动相机 + 自由飞行（fly），HUD 12.5Hz；debug 是交互模拟。两者 TS 无共享层 import（ts-shared 消费面 grep：debug/game 各 7 模块，viewer 0）。
- 互不引用：`debug/src` 与 `viewer/src` 之间零 import（全仓 grep 验证，根 [documents/architecture.md](../architecture.md) 引用矩阵）。

## 5. debug vs test/dual-mode-harness

- harness 的 WorkerA/WorkerB 三线程协议与 ts-shared **不是同一套**：独立的 `TestShared` SAB（192B 布局，`test/dual-mode-harness/src/shared-state.ts`），背压 waitWakeup、MessageChannel 自续环、msg-main/msg-physics/msg-render 三角色消息回退。debug 用 ts-shared 512B 布局 + setTimeout 4ms 自驱，无背压。
- ts-shared 消费面：harness 只 import `KEY_MASK`（键位掩码常量），其余全部自持。
- harness 的价值是物理公平性对照实验（双模 tick/锚定拉回/速度校准细节见其自身文档 `test/dual-mode-harness/docs/overview.md`）；debug 不做锚定拉回，用的是速度外推 + 大偏差反向同步。

## 6. 对共享层的取舍（debug 视角）

| 共享层模块 | debug 使用方式 | game 是否同用 |
|---|---|---|
| `shared-state.ts` | SAB 512B + MsgState 回退，11 位 KEY_MASK | 是 |
| `auth-loop.ts` | 权威自驱循环（无 game 的 +3 偏移） | 是（+3） |
| `worker-dispatch.ts` | 5 个钩子全注入（面板/ready/mtz） | 0 钩子 |
| `params.ts` | buildPhysicsParams（config 字段 + 面板参数双入口） | 是 |
| `world-builder.ts` | 传 colliderSource + collectMissingTextures + onProgress | 只传 decompressMtz + onProgress |
| `authority-calibrator.ts` | 校准 + resetTo（检查点回退复用） | 校准 + holdPoint 冻结不复用 resetTo |
| `input-layer.ts` | layerMouseDelta + qeEquivalentDx | 同 |

重复携带（共享层没有、两端各自实现）：chamfer 生成（`debug/crates/wasm/src/lib.rs:2552` ≙ `game/crates/wasm/src/lib.rs:1973`）、近平面探测、纹理画质切换、BspProcessor 导出面的 TS 封装（`debug/src/world/collider-adapter.ts` 等 world 层文件 game 侧无对应——其碰撞体以 JSON 字符串直接透传 wasm）。这是"共享层只收敛协议与算法内核、工程各自保留 UI/渲染"原则的直接结果。

## 7. 一句话总结

debug = game 的物理骨架（ts-shared 7 模块 + websurf-phys 全量） + **参数面板/碰撞可视化/准星检查/近平面调参**四套调试设施 + **计时挑战状态机**；game 用省下的复杂度换**存点/改键/风格化准星/进度 UI**的游玩体验，并在 tickRate 上保留 +3 隐藏偏移与 lockTickRate 门槛。两者唯一的行为级物理差异是 tickRate 偏移（§3.3）与权威死亡阈值是否下发（§3.5），其余差异都在配置默认值与 UI 层。
