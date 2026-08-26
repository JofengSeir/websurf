# debug 渲染时序替换为 game 模式 + 物理渲染公共化方案

> 方案定稿：2026-08-09。目标：debug 主线程成为唯一物理渲染线（BspProcessor 解析 + PhysWorld.build_world + 每 rAF tick + 渲染），Worker 退化为权威帧计算器（固定步长 + 权威全状态双缓冲 V_A）；"物理渲染"两端共用一套 TS 实现。
> 执行方式：分 5 阶段 + 公共化，每阶段由子代理实施并节点测试。
>
> **⚠ 历史方案（2026-08-09 晚标注）**：本方案已由 commit 0f3558b 完整实施（ts-shared 公共化 + debug 主线程解析/物理 + Worker 权威帧 + 删除 LERP/physics-loop）。文中引用的文件路径/行号已大面积失效（debug 原 worker/shared-state.ts、physics-loop.ts 已删；shared-state 迁至 src/ts-shared/auth/）。~~仅 `debug/src/config.ts` 的 `teleportTriggerMode` 死字段（本方案 4.3 的删除项）保留为 config 占位。~~（**2026-08-24 补注**：该字段现已从 config.ts 彻底移除，全仓零引用——本方案的删除项已全部完成。）

## 1. 目标架构

```
主线程（唯一物理渲染线）              Worker（权威帧计算器）
──────────────────────              ─────────────────────
mousemove/键盘/Q-E 输入层           setTimeout 4ms 自驱
  → pendingDx/Dy/keys                → 固定步长累积器（无上限）
  → SAB 输入槽 BigInt64 (add)       → takeInput (exchange, maxStep)
  → 本地缓冲（同源）                  → PhysWorld.tick（含碰撞/传送/死亡）
  → 读权威帧 (V_A-1)&1                → writeAuthoritative 双缓冲 (V_A++)
  → correctFromAuthority（三条件）    → 碰撞事件 postMessage（land/blocked）
  → calibrateVelocity（set_velocity）→ 消息：world-json/config/respawn/
  → PhysWorld.tick + 渲染              teleport/teleport-to-pos/set-spawn-points/
                                       set-death-threshold/sync-render-state
```

**删除**：LERP/外推插帧（debug/src/renderer/renderer-main.ts:462-513）、SPSC 环形缓冲/seqlock 输出/frame 信号（shared-state.ts）、TS noclipView（physics-loop.ts:52-56,246-273）。

## 2. 迁移阶段

### 阶段 0：前置对齐（小）
- `debug/src/config.ts`：补 `input.noclipSpeed`（默认 800）、`physics.teleportGateTicks`（默认 1）
- `debug/src/main-wasm.ts`：确认 BspProcessor/PhysWorld 可用；`handleBspFile` 前 await wasm 就绪（game 的 mainWasmReady 模式：game/app.ts:124-126,345）
- 验证：typecheck + check:api 双端通过

### 阶段 1：主线程接管解析/物理（中）——LERP 移除、渲染直读
- `debug/src/app.ts`：`handleBspFile`（1107-1124）改主线程解析（移植 game/app.ts:339-513 handleLoadBsp：BspProcessor → metadata/brush/tri/spawn/teleport/pvs/mosaic/GLB 顺序，`export_glb*` 最后）；删除 sendLoadBsp/scene-data 消息路径；保留 colliderSource 三档（visual/phy/auto + mergeBrushJson 薄壳回退，physics-worker.ts:257-289 逻辑搬主线程）；parse-progress 阶段提示用 setTimeout(0) 刷 UI（game/app.ts:350 同法）
- `debug/src/renderer/renderer-main.ts`：新增 predPhys + buildPredictionWorld（game renderer-main.ts:56-58,435-459 同构）；tick（370-447）删除 readFrame/LERP/外推（462-513），改为 predPhys.tick(dt, keys, dx, dy) → state() → 相机同步；colliderDebug/planeInspector 数据源改本地 brushJson/triJson/teleportJson
- Worker：删除 BspProcessor/scene-data/GLB 职责，改收 world-json 构建 PhysWorld（game/main.ts:198-214）
- 阶段 1 过渡：Worker 仍 frame 驱动物理，主线程物理并行演化（渲染用主线程）；保留 Worker 输出 SAB 但主线程不再读
- 验证：手感 = game（零延迟）；LERP 删除后无停-动；调试可视化正常

### 阶段 2：Worker 改权威帧计算器（中）
- `debug/src/worker/main.ts`：替换为 game 模式（setTimeout 4ms 自驱 loop，game/main.ts:37-54；固定步长累积器无上限 guard<64；stepPhysics:60-120 含碰撞事件 land/blocked 检测）
- `debug/src/worker/shared-state.ts`：整体替换为 game 版布局（BigInt64 输入槽 + 权威全状态双缓冲，V_A index 0；SAB 512B；MsgState 回退同接口 game/shared-state.ts:111-189）；删除环形缓冲/seqlock/frame 信号/I_MODE
- `debug/src/renderer/renderer-main.ts`：移植校准四件套——correctFromAuthority（game:527-621 三条件 OR+250ms 冷却+syncInFlight 回滚）、calibrateVelocity（662-676 vel_A+a×Δt clamp±20000）、applyCollisionCorrection（706-722 <60 微调）、resetTo（679-695）；onSyncRenderState → Worker sync-render-state（game/main.ts:244-261 set_state+resetInput）
- `debug/src/worker/physics-worker.ts`：缩减为 dispatch（game/main.ts:152-278），保留特有消息：teleport-to-pos、set-death-threshold、set-spawn-points、respawn（纯 phys.respawn()，检查点回退移主线程）、config（mode→set_noclip）；删除 stats/game-stats/physics-snapshot/player-pos 回传（改主线程本地）
- 验证：落地锯齿消失（校准生效）；碰撞事件角度同步；noclip 双端一致；传送/重生无"拉回"

### 阶段 3：输入链路改造（小-中）
- `debug/src/app.ts`：bindInput（544-550）灵敏度主线程乘入（game/app.ts:159-162：dx=clamp(r.dx×sens,±1000)）；startInputLoop（1434-1451）Q/E 等效像素每帧折算（game/app.ts:299-307：qeDx=±(yawBindSpeed/M_YAW)×dt 钳±1000）+ 双端同源（同份输入喂本地缓冲与 SAB，game/renderer-main.ts:781-787）；pointerLock 解锁/失焦清双端输入（补 blur 清 SAB，game/app.ts:176-200）
- `debug/src/input/input-bridge.ts`：删 setInput/setKeys/sendFrame，保留低频控制消息
- 删除 shared-state.ts 的 InputSample/环形缓冲部分
- 验证：灵敏度实时生效、Q/E 恒速、双端角度不分叉

### 阶段 4：特有逻辑适配（小-中）
1. 物理面板参数：PhysicsParams 移主线程（直接 set_params 主线程实例）+ 全量参数经 config 消息发权威 Worker（buildPhysicsParams 模式）；snapshot 回传改主线程本地；panelSuppress 防回环保留
2. 计时挑战：GameState 移主线程，take_event 主线程每 tick 消费（teleport→onTeleport 检查点、death→onDeath+检查点回退）；权威 Worker 侧不消费事件（防双端重复）；死亡回退 teleport_to 检查点后须双端通知 Worker
3. 传送触发模式面板（teleportTriggerMode radio）：**死 UI 删除**（Rust 固定双条件 OR，teleport_gate_ticks 未消费）
4. noclip：改用 Rust set_noclip（config physics.mode 消息双端），删除 TS noclipView/noclipStep/applyNoclipMouseDelta；位置继承 Rust 内部；noclipSpeed 用阶段 0 新字段
5. 调试可视化：数据源本地化（无消息）；render.mode 门控改 noclipActive 标志
6. 自定义传送点/重生/死亡阈值：get-player-pos 主线程 state()；teleport-to-pos 主线程+Worker 双端；respawn 双端 + resetTo；set-death-threshold 主线程 set_death_y + Worker 消息
7. HUD stats：fps 主线程 rAF 计数（game/app.ts:282-287）；pos/vel/onGround/cluster/speed 主线程 10Hz 采样；**zeroCause 删除**（Rust 无此概念，现状恒不发送）
- 验证：计时挑战/检查点/自定义传送点/物理面板全量回归

### 公共化：根 src/ts-shared/（中，最后收口）
- 新建仓库根共享 TS 目录，debug/game 相对路径导入，esbuild 天然支持；两工程 tsconfig include 该目录
- 共享模块（来自 game 实现）：`auth/shared-state.ts`（ShmState+MsgState+KEY_MASK+AuthFrame/InputSample）、`auth/auth-loop.ts`（4ms 自驱+固定步长+stepPhysics+碰撞事件，带 onExtraMessage 扩展点）、`auth/worker-dispatch.ts`（init/wasm-init/world-json/config/respawn/teleport/set-spawn-points/sync-render-state + 注入扩展）、`phys/authority-calibrator.ts`（correctFromAuthority/calibrateVelocity/applyCollisionCorrection/resetTo/normalizeAngleDeg/computeAuthAccel）、`input/input-layer.ts`（layerMouseDelta/qeEquivalentDx/INPUT_CLAMP=1000/M_YAW=0.022）、`phys/world-builder.ts`（bytes→WorldBundle，options.colliderSource 抽象 + onProgress）、`phys/params.ts`（buildPhysicsParams + PARAM_TO_RUST 合并）
- 公共函数以参数对象解耦两端 RuntimeConfig 差异（buildPhysicsParams(p: PhysicsParamsLike)）
- 不共享：面板 UI（侧边栏 vs ESC）、调试可视化（collider-debug/plane-inspector/adaptBrushes/TeleportManager triggers）、计时挑战（game-state/game-stats）、自定义传送点（custom-teleports）、light/fog/lightmap/camera 渲染层
- 验证：双端同模块构建 + 各自回归

## 3. 风险
1. BspProcessor 移主线程加载阻塞（最大）：缓解=导出步骤间 setTimeout(0) 刷 UI + 进度遮罩；卡顿>2s 再考虑 GLB 导出 Worker 化混合
2. MsgState 回退适配：补 onmessage recvFrame 分支（game/app.ts:93-97 模式）
3. zeroCause 删除；传送面板死 UI 删除需告知
4. 传送/重生/检查点回退/自定义传送点：所有位置突变必须双端执行 + resetTo（防权威帧拉回）
5. noclip 语义差（Rust noclip_step vs TS noclipView）：补 noclipSpeed 配置

## 4. 参考代码
- game 实现：game/src/app.ts（handleLoadBsp:339-513、输入层:152-164,299-307、mainWasmReady:124-126,345）、game/src/renderer/renderer-main.ts（tick:770-839、校准:527-695、碰撞:706-722）、game/src/worker/main.ts（自驱:37-54、stepPhysics:60-120、dispatch:152-278）、game/src/worker/shared-state.ts、game/src/input/input-bridge.ts
- debug 现状：debug/src/app.ts、debug/src/renderer/renderer-main.ts、debug/src/worker/{physics-worker,physics-loop,shared-state,main}.ts、debug/src/physics/{physics-params,param-defs}.ts
