# 物理控制面板与调试工具（维度 I）

> 前置阅读：[../overview.md](../overview.md) §5、[../sequences.md](../sequences.md) §7。本文覆盖参数体系（13 项定义 → Worker 参数管理器 → Rust set_params）、面板消息协议、UI 行为，以及围绕它的调试工具（自定义传送点、计时挑战 HUD）。

## 1. 参数定义（`debug/src/physics/param-defs.ts`）

面板参数与 Worker 参数管理**共用**这张定义表（独立成文件避免主线程 bundle 引入物理实现，头注 `param-defs.ts:8-9`）。`PARAM_DEFS` 共 **13 项**（默认值与共享 crate `PhysParams::default()` 一致，`param-defs.ts:1-10`）：

| name | label | 默认 | 范围 | Rust 字段 |
|---|---|---|---|---|
| maxSpeed | 地速上限 | 250 | 50-1000 | run_speed |
| walkSpeed | 走路速度 | 130 | 50-400 | walk_speed |
| crouchSpeed | 蹲走速度 | 85 | 40-300 | crouch_speed |
| airAccelerate | 空气加速 | 150 | 10-400 | air_accelerate |
| gravity | 重力 | 800 | 100-2000 | gravity |
| accelerate | 地面加速 | 10 | 1-100 | accelerate |
| friction | 摩擦 | 4 | 0-20 | friction |
| stopSpeed | 停止速度 | 100 | 0-400 | stop_speed |
| jumpHeight | 跳跃高度 | 57 | 20-120 | jump_height（起跳速度 = √(2·g·跳高)，随重力联动） |
| autobhop | 自动连跳 | true | bool | autobhop |
| bhopSpeedClamp | 连跳限速 | true | bool | bhop_speed_clamp |
| noPrestrafe | 落地限速 | true | bool | no_prestrafe |
| tickRate | 模拟频率 | 64 | 48-128 | **不进 Rust**——JS 驱动层参数（固定步长），走 `onTickRateChange` 回调 |

- 12 项 name→snake_case 映射即 `PARAM_TO_RUST`（`physics/physics-params.ts:20-33`）；tickRate 唯独除外（`physics-params.ts:155-158`）。
- 参数来源三态 `ParamSource = 'mode-default' | 'manual' | 'map'`（`param-defs.ts:13`；'map' 为 worldspawn 键值预留，`physics-params.ts:94-98`）。

## 2. 参数管理器（`physics/physics-params.ts`，163 行，运行在 Worker）

- `overrides: Map<name, {value, source}>`：未覆盖项 = 定义表默认值（`snapshot()` 组装 ParamState[]，`:138-147`）。
- `setParam`：数值钳制到 min/max → 存 overrides（source='manual'）→ `applyOverride`。
- `applyOverride`（`:153-162`）：tickRate → `onTickRateChange(rate)`；其余 → `phys.set_params(JSON.stringify({rustName: value}))`（JSON patch，只发单项）。
- `attach(phys)`（`:59-78`，world-json 后由 `attachWorld` 调用）：把**已存在的覆盖**整体重放（set_params + set_hull），并重放 tickRate 覆盖——防止"面板显示 128 实际跑 64"（world-json 构建后 shared dispatch 会按 config 重置 fixedDt）。
- hull：`setHull/resetHull/getHullState`（DEFAULT_HULL {16,72,54}，`physics-params.ts:17`）；`autoRestoreHull` 开关保留为兼容开关、当前无生效行为（Rust 已有 stuck 解卡，`physics-params.ts:48-49`）。

## 3. Worker 协调器（`debug/src/worker/physics-worker.ts`，114 行）

职责只剩面板（阶段 2 缩减：BSP 解析/帧循环已移主线程与共享层，头注 `physics-worker.ts:1-13`）：

| 入口 | 行为 |
|---|---|
| `attachWorld(phys)` | world-json 后挂载：`physicsParams.attach(phys)` + `emitPhysicsSnapshot()` |
| `reapplyParams()` | config 消息全量 set_params/set_hull 之后调用（`onConfigApplied` 钩子）——**面板手动参数 > 配置默认** |
| `handleMessage(msg)` | 5 种面板消息（下表）；返回是否已处理（worker-dispatch `onExtraMessage` 扩展点约定） |
| `emitPhysicsSnapshot()` | `physics-snapshot` 消息：params[]（name/value/source）+ hull{halfWidth,standHeight,duckHeight,source,isDefault} + autoRestoreHull |

面板消息（`physics-worker.ts:52-81`）：`set-physics-param` / `reset-physics-param`（可单参或全量）/ `set-hull` / `reset-hull` / `set-auto-restore-hull`——每条处理后都回一次 snapshot。

## 4. 消息流全景（主线程 ↔ Worker）

```
面板控件 input ─→ app.ts handler（panelSuppress 时忽略）
  └→ inputBridge.sendSetPhysicsParam(name, value)        （input/input-bridge.ts）
       → Worker onExtraMessage → physicsWorker.handleMessage
       → PhysicsParams.setParam → wasm set_params（权威实例）
       → emitPhysicsSnapshot → postMessage physics-snapshot
            → app.ts handleWorkerMessage → renderPhysicsSnapshot（app.ts:1630-1681）
                 ① panelSuppress = true（防回填触发 input → 死循环）
                 ② 逐参数回填 range/number/checkbox + 来源徽标（mode-default/manual/map 三色）
                 ③ hull 回填 + 缩放滑块联动：k = standHeight/72，
                    uniform = |halfWidth/16 − k| < 0.02 且 |duckHeight/54 − k| < 0.02
                    （等比缩放时 hullScale 显示 k，非等比归 1，app.ts:1656-1668）
                 ④ mirrorSnapshotToPrediction（app.ts:1683-1696）：
                    PARAM_TO_RUST 映射 → rendererMain.setPredictionParams(snake_case patch)
                    + setPredictionHull(...) —— 渲染物理与权威同参
                 ⑤ panelSuppress = false（finally）
```

tickRate 特例：滑块 → `sendSetPhysicsParam('tickRate', v)` → Worker `onTickRateChange`（`main.ts:89-92` 注入）→ `authLoop.setFixedDt(v) + authLoop.reset()`；渲染线 tick 无固定步长（rAF 实时 dt），不受影响。

`hull-auto-restored` 物理事件（`physics-event` 消息）→ `onPhysicsEvent`（`app.ts:1698-1703`）仅刷状态栏。

## 5. UI 组织（`debug/web/index.html` + `app.ts` bindUI）

- 面板区块（`index.html:369-445`）：物理模式下拉（physics/noclip）、碰撞来源三档、tickRate、重生按钮、体型三滑块 + 缩放滑块 + autoRestore + 来源徽标、`#physicsParamList`（JS 按 PARAM_DEFS 渲染 range+number+bool 控件 + 来源徽标，`initPhysicsPanel`，`app.ts:1510`）、"恢复全部默认"。
- `panelSuppress` 门控（`app.ts:1507`）：快照回填期间所有 input handler 直接 return（各 handler 首行 `if (panelSuppress) return`）。
- 侧栏其他调试控件（同 `index.html`）：灵敏度/yawBind/pitchLimit、视距剔除滑块（范围由 `onSceneReadyUi` 按场景对角线动态设置，`app.ts:350-359`）、PVS 开关、环境光强度、近平面 probeDist/ratio、出生点下拉、自定义传送点 `<details>`。

## 6. 配套调试工具

### 6.1 自定义传送点（`world/custom-teleports.ts`，98 行）

- localStorage 按地图分组：键 `vbsp:customTeleports:<mapName>`，每图上限 50（超出 `slice(-50)`），id = `time36+rand`（`custom-teleports.ts:9-15`）。
- 读取防御式过滤（缺字段/NaN 剔除，`load()`）；UI：捕获当前位置（主线程 `getCurrentState()`）、手动输入 x/y/z/名称/yaw（yaw 留空 = 保持当前朝向）、列表跳转/删除/清空（`app.ts:1416-1464` + `index.html:452-466`）。
- 跳转链路与出生点切换同构：`teleportToPos(pos, yaw?)` + `sendTeleportToPos` + `resetTo`（[../sequences.md §5](../sequences.md)）。

### 6.2 计时挑战 HUD（`game/game-state.ts`，191 行）

状态机与回退时序见 [../sequences.md §6](../sequences.md)；面板呈现：timer/检查点数/死亡数（`updateGameStatsUI`，`app.ts:532` 起，10Hz）。触发器线框与准星 trigger 元数据（target/destIdx/classname/spawnflags）来自 TeleportManager + PlaneInspector（[rendering.md §6、§9](rendering.md)），是排查"为什么这个传送没触发"的主要工具。

### 6.3 碰撞箱（hull）实验

set_hull 直接改 Rust 玩家 AABB（`src/phys/mod.rs:439-444`）；配合 `hullScale` 等比缩放与碰撞可视化（绿色地面/黄色坡面/红色墙面 + chamfer 黄线）可观察"盒角卡棱""蹲不进缝隙"类问题。`set-auto-restore-hull` 仅存档开关状态、无生效行为（§2）。

## 7. 与共享层的关系

- worker-dispatch 的五个 debug 注入点中，面板直接占三个：`onWorldBuilt`（attachWorld）、`onConfigApplied`（reapplyParams）、`onExtraMessage`（5 种消息）；`onInit`（ready 回执）与 `onWasmInit`（mtz 存取，协议兼容保留）与面板无关（`debug/src/worker/main.ts:106-119`）。
- `set_params`/`set_hull` 的完整字段语义在共享层：[docs/phys.md](../../../docs/phys.md)（PhysWorld 21 导出、PhysParams 默认表）。
