# debug 核心时序（维度 T）

> 本文只讲"事件按什么顺序发生"。架构定位见 [overview.md](overview.md)，每条链路的实现细节分散在 [implementation/](implementation/loading-pipeline.md) 三篇；与 game 的时序对照见 [differences.md §2](differences.md)。

## 1. 启动时序（main()，`apps/debug/src/app.ts:198-293`）

```
void main()                                              app.ts:198
├─ 1. 能力检测：crossOriginIsolated？                    app.ts:197-204
│     是 → new SharedArrayBuffer(SHARED_BUFFER_SIZE)
│     否 → sharedBuffer=null（后续自动 MsgState 回退）
├─ 2. 创建 Worker：                                       app.ts:209-215
│     dist 内嵌 __VBSP_WORKER_JS__ → Blob URL module Worker
│     否则 → new Worker('./worker.js', {type:'module'})
├─ 3. postMessage({type:'wasm-init', wasmB64|wasmUrl, mtzB64})   app.ts:221-234
│     wasmB64 = 内嵌 __VBSP_WASM_B64__（single 打包）；否则 mainWasmUrl()
│     mtzB64 仅协议兼容字段（Worker 已不解析 BSP，纹理包不再使用）
├─ 4. createMainSharedState(sharedBuffer, worker)         app.ts:236-244
│     SAB 非空 → ShmState（Atomics）；否则 MsgState（postMessage）
│     inputBridge.sendInit(sharedBuffer, width, height, dpr)
├─ 5. new RendererMain(...) 并挂 4 个回调：               app.ts:247-271
│     · onCullStats → updateCullStatsUI
│     · onSceneLoaded → sceneDeathY 存档 + setDeathY + sendSetDeathThreshold
│      （loadScene 早于 world-json，Worker 初次会丢该消息 → handleLoadBsp 末尾重发）
│     · onSyncRenderState → worker.postMessage({type:'sync-render-state',...})
│     · onPhysEvent → onRenderPhysEvent（计时挑战）
│     rendererMain.init(canvas,…); rendererMain.start()
├─ 6. mainWasmReady = ensureMainWasm()（主线程懒初始化 wasm）    app.ts:271
├─ 7. bindInput（键盘/鼠标/滚轮/blur 语义）               app.ts:279-292
├─ 8. loadUiPrefs → 同步控件 → bindUI（全部 DOM 控件接线）
└─ 9. startInputLoop()（rAF HUD/输入合成循环）            app.ts:292
```

Worker 侧接收 `wasm-init`：`initSync({module})` **必须同步初始化**（async `init()` 解构 `{module_or_path}`，传 `{module}` 会落到 `new URL(import.meta.url)` 错误路径——`src/ts-shared/auth/worker-dispatch.ts:50-60` 注释），成功后 `authLoop.start()` 一次（`worker-dispatch.ts:68-72`）。`init` 消息（含 SAB）到达后创建 `createWorkerSharedState` 并回 `ready`（`worker-dispatch.ts:79-85` + `apps/debug/src/worker/main.ts:106-108`）。

## 2. 输入合成时序（主线程 → 双线同源）

```
mousemove ─→ mouseBuffer.process（增量缓冲：MAX_DELTA=1000 CLAMP 不丢弃，
             失锁瞬间 discardNext 丢弃陈旧增量）              input/mouse-buffer.ts
          ─→ layerMouseDelta(dx,dy, config.input.sensitivity)  app.ts:586-587
          ─→ rendererMain.feedInput(dx, dy, keysMask)        （灵敏度在此乘入）
click ─→ pointerLock.requestLock(unadjustedMovement:true → 降级 → 3s 超时)  input/pointer-lock.ts
wheel ─→ wheelJumpPending = true（仅锁定时；chasemod 风格滚轮连跳）  app.ts:612-616
blur  ─→ keyboard.reset() + sharedState.addInput(0,0,0)      app.ts:628-632
        （后台标签页 rAF 暂停会冻结权威键位 → 显式清零修复）
keydown/keyup ─→ keyboard（固定 KeyState 全键位，debug 无改键面板）
```

rAF 输入循环（`app.ts:1710-1762`，10Hz HUD 采样合并在一起）：

1. `keys = keyboard.getState()`；锁定时 `mask = keysToMask(keys)`，否则 mask=0；
2. `wheelJumpPending` → `mask |= KEY_MASK.wheelJump`（消费一次即清）；
3. Q/E turn bind：`qeEquivalentDx(yawBindSpeed, dt)` 生成**等效鼠标像素**（不乘灵敏度，角速度恒定；`src/ts-shared/input/input-layer.ts:35-40`），`rendererMain.feedInput(qeDx, 0, maskWithWheel)`；
4. physics 模式下 `game.onPlayerMove()`（计时挑战 idle→running 触发）；
5. 10Hz 刷新 `updateStatsUI`（FPS/位置/速度/cluster）与 `updateGameStatsUI`。

feedInput 只是**累积** pendingDx/Dy + 赋值 pendingKeys；真正写入 SAB 发生在渲染 tick 第①步 `shared.addInput(...)`（`renderer-main.ts:441`）。KEY_MASK 11 位定义与 Rust 一致（`src/ts-shared/auth/shared-state.ts:56-68`）。

## 3. 权威帧双线 tick（v7 核心时序）

### 3.1 渲染物理线（主线程 rAF，`apps/debug/src/renderer/renderer-main.ts:430-516`）

物理子序列固定六步（`renderer-main.ts:437-470`，与 game 同序）：

| 步 | 调用 | 语义 |
|---|---|---|
| ① | `shared.addInput(pendingDx, pendingDy, pendingKeys)` | 本帧输入写入 SAB 输入槽（权威线同输入） |
| ② | `correctFromAuthority()` | 只读权威帧：首帧作渲染起点；异常大偏差兜底（见 §3.3） |
| ③ | `calibrateVelocity(now)` | 权威速度外推校准（速度渐进对齐，位置不覆盖） |
| ④ | `predPhys.tick(dt, keys, dx, dy)` | 主线程 PhysWorld 全速推进（physics=碰撞/传送/死亡；noclip=noclip_step） |
| ⑤ | `consumePhysEvents()` | `take_event` 循环：teleport → 计时挑战检查点；death → 回退（`renderer-main.ts:898-905`、`app.ts:1471-1493`） |
| ⑥ | `cc.setYawPitch(state.yaw/pitch) + setPosition(posY+eyeHeight)` | 相机 = 眼睛位置（不做位置修正，防穿墙靠近平面自适应） |

物理块之后还有五个渲染阶段：② LOD/PVS（`lodManager.update`，476-480）→ ③ 雾（483）→ ④ 碰撞可视化（`colliderDebug.update`，486-490）→ ⑤ 准星射线（每 6 帧，493-501）→ ⑥ 渲染（`predReady || needsRender`，503-509）→ ⑦ 剔除统计（100ms，512-515）。近平面自适应在物理块内每 2 帧执行（noclip 跳过，467-470）。

### 3.2 权威线（Worker setTimeout 自驱，`src/ts-shared/auth/auth-loop.ts:193-225`）

- `setTimeout(loop, 4)` 自驱（250Hz 轮询 > 最大 tick 率）；墙钟累积器 `acc += (now-lastWall)/1000`，`while (acc >= fixedDt && guard < 64)` 补足欠步（低帧率不丢物理时间）；
- 每步 `stepPhysics`（`auth-loop.ts:114-190`）：`shared.takeInput(maxStep)`（单 tick 输入上限 `MAX_INPUT_PER_STEP_BASE=1200°` 按 dt 缩放）→ tick 前快照 → `phys.tick(dt, keysMask, dx, dy)` → `writeAuthoritative`（写空闲槽 → release 递增 V_A）；
- **碰撞事件**（低频，postMessage 回主线程）：`land` = onGround 上升沿；`blocked` = 速度 >80 且速度骤降 >250 u/s 且实际位移 < 预期 30%（`auth-loop.ts:162-189`）；
- `fixedDt = 1/tickRate`：config `physics.tickRate` 变更时主线程 `sendConfig` → Worker `getConfigTickRate()`（`apps/debug/src/worker/main.ts:98`）→ `setFixedDt(rate) + reset()`（`worker-dispatch.ts`；主线程侧 `app.ts` tickRate 滑块 → `physicsWorker.params.onTickRateChange` → `authLoop.setFixedDt`，`apps/debug/src/worker/main.ts:89-92`）。

### 3.3 权威校准与反向同步（`src/ts-shared/phys/authority-calibrator.ts`）

- **只读权威，绝不反写**：`correctFromAuthority` 仅记录权威帧（`authority-calibrator.ts:109-125`）；
- **首次权威帧**（或重载后）：以权威全状态作为渲染物理起点（`set_state`）；
- **大偏差兜底**（三条件 OR，渲染主线反向同步权威）：位置差 >500 强制同步；>300 且水平朝向一致（yaw 最小角差 ≤3° + 转向相同）同步；≤300 但视角偏差 >45° 同步。同步内容 = 渲染主线当前全状态，经 `onSyncRenderState` 回调发 `sync-render-state` 消息 → Worker `phys.set_state(...)` 并清空权威侧未消费输入；同步瞬间主线程 `clearPendingInput()`（`authority-calibrator.ts` 兜底块；`worker-dispatch.ts` sync-render-state 分支）；
- 防抖：`SYNC_COOLDOWN_MS=250`（同步/撤回冷却）；`TELEPORT_EXEMPT_MS=200`（传送/重置后权威豁免期——只读权威速度，绝不覆盖渲染位置，`authority-calibrator.ts:99-107`）；
- 碰撞事件修正（`applyCollisionCorrection`，仅当渲染距权威 <60 HU）：`land` 全状态采纳（含权威速度 + onGround=true）；`blocked` 只采纳位置/角度、速度保留渲染侧（`authority-calibrator.ts:355-384`）；
- 位置突变（respawn/teleport/检查点回退/noclip 切换）统一走 `rendererMain.resetTo(pos, yaw, pitch)`：写渲染物理 `set_state` + 清校准状态 + 触发豁免期，防止旧权威帧把传送点拉回（`renderer-main.ts:884-886`）。

### 3.4 通道降级

| 条件 | 通道 | 输入 | 权威帧 |
|---|---|---|---|
| `crossOriginIsolated`（dev 服务器 COOP/COEP，`src/serve.py:32-34`） | `ShmState`（SAB + Atomics） | 主线程 addInput 原子累加，Worker takeInput exchange | Worker writeAuthoritative 双缓冲，主线程 recvFrame |
| 无 COOP/COEP（multi 部署静态页等） | `MsgState`（postMessage） | 每帧 `input` 消息 | 每帧 `phys-frame` 消息（`app.ts:299-332` handleWorkerMessage 分支） |

两条路径 API 一致（`createMainSharedState`/`createWorkerSharedState` 工厂，`shared-state.ts:344-356`），上游代码无分支。

## 4. 地图加载时序（详见 [loading-pipeline.md](implementation/loading-pipeline.md)）

```
file input ─→ handleBspFile (app.ts:1256-1280)
   await mainWasmReady → rendererMain.disposeScene()（防显存泄漏）
   → teleportMapName=file.name → lastTeleportIdx=-1 → handleLoadBsp(name, bytes)
handleLoadBsp (app.ts:1290-1388)
   1. buildWorldBundle(new BspProcessor(bytes), {colliderSource, collectMissingTextures:true,
      decompressMtz, onProgress})      —— ts-shared 管线，9 个阶段（WASM 解析 → … → GLB 导出）
   2. rendererMain.loadScene(sceneData) —— GLB/lightmap/LOD/PVS/传送点/雾/碰撞体（主线程渲染）
      └─ 完成回调 onSceneLoaded(deathY)：setDeathY + inputBridge.sendSetDeathThreshold
   3. rendererMain.buildPredictionWorld({brushJson,triJson,teleportJson,spawn}) —— 主线程 PhysWorld
   4. setPredictionParams/​setPredictionHull/​setPredictionNoclip（渲染线参数先就位）
   5. inputBridge.sendWorldJson(...)   —— 同一份 brushJson/triJson/teleportJson/spawn 发 Worker
      （渲染不消费 Worker 输出：两端并行构建，同字节同结果）
   6. sendSetSpawnPoints(spawnList) + syncFullConfig()（10 段 config）+ 重发 set-death-threshold
   7. game.reset() + game.setInitialSpawn(spawn) + spawnSelect 下拉填充 + onSceneReadyUi
Worker 侧：world-json → createPhysWorld → build_world(brushJson,triJson,teleportJson,x,y,z,yaw)
   → syncParamsToWasm → setFixedDt(tickRate)+reset → onWorldBuilt(=physicsWorker.attachWorld)
   （src/ts-shared/auth/worker-dispatch.ts world-json 分支；wasm-init 未就绪则忽略该消息）
```

时序要点：`loadScene` 在 `world-json` **之前**，因此 `onSceneLoaded` 里发的 `set-death-threshold` 第一次会被 Worker 丢弃（phys 未构建）——`handleLoadBsp` 末尾显式重发（`app.ts:1362-1363`；`worker-dispatch.ts` set-death-threshold 分支）。

## 5. 双端同步语义（"必须成对发送"清单）

| 动作 | 主线程（渲染线） | Worker（权威线） | 不成对的后果 |
|---|---|---|---|
| 出生点切换 | `rendererMain.teleportToSpawn(idx)` + `game.onTeleport` + `resetTo` | `inputBridge.sendTeleport({target: idx})` | 权威帧 >200 兜底把传送点拉回（注释见 `app.ts:863-899`） |
| 检查点回退/死亡 | `teleportToPos` + `resetTo` | `sendTeleportToPos` | 同上 |
| 自定义传送点 | `teleportToPos(pos, yaw?)` | `sendTeleportToPos` | 同上 |
| respawn | `rendererMain.respawn()` + `resetTo` | `sendRespawn` | 权威仍留在旧位置 → 兜底拉回 |
| 地图加载 | `buildPredictionWorld` | `sendWorldJson` | 权威无世界 → 权威帧停发 |
| 面板 hull | `mirrorSnapshotToPrediction` → `setPredictionHull` | `set-hull` 消息（Rust set_hull） | 双线体型分叉 |
| 面板参数 | 同上（`PARAM_TO_RUST` 映射） | `set-physics-param` | 双线参数分叉 |

## 6. 计时挑战状态机（`apps/debug/src/game-state.ts`）

```
idle ──(首次 onPlayerMove：速度>阈值)──→ running ──(触达 end 目标)──→ finished
running：触发 teleport 事件 → game.onTeleport(ev)
   · isEndTarget(name)（regex /(?:^|[^a-zA-Z])end$/i）→ finished（formatTime MM:SS.mmm）
   · 否则记录检查点（targetname 去重），getRespawnPos = 最后检查点或初始出生点
death（渲染物理 y < deathY，主线程 renderer 判定）→ game.onDeath：仅统计 + 回退
   → getRespawnPos → teleportToPos + sendTeleportToPos + resetTo（双端回退，见 §5）
```

- 状态源：`game-state.ts:1-191`（idle/running/finished、checkpoints 数组、deaths/teleports 计数）；yaw = `angles[1]*π/180`（BSP 度 → 弧度）。
- respawn 按钮语义：有检查点时走"回最后检查点"（`app.ts:863-880`），否则普通 respawn 双端重置。
- 传送触发本身发生在 **Rust 权威**（`src/phys/mod.rs:239-258` teleport.check → PhysEvent::Teleport），主线程渲染线的 `take_event`（`renderer-main.ts:896-905`）与 Worker 的 world 传送各自独立触发，事件只是**通知**，不承担双端一致。

## 7. 物理面板参数时序（详见 [physics-panel.md](implementation/physics-panel.md)）

```
面板拖动 ─→ app.ts input handler ─→ inputBridge.sendSetPhysicsParam(id, value)
   → Worker onExtraMessage → physicsWorker.handleMessage
   → params.applyOverride(id, value)（归一化/tickRate 特殊路径）
   → ① wasm set_params（经 PARAM_TO_RUST snake_case 映射）
     ② emitPhysicsSnapshot：postMessage physics-snapshot（全 13 参 + hull + autoRestore + source）
主线程 handleWorkerMessage(physics-snapshot) → renderPhysicsSnapshot
   → panelSuppress=true 回填控件（防 input→snapshot 反馈环）
   → mirrorSnapshotToPrediction：PARAM_TO_RUST 逐项 rendererMain.setPredictionParams
     + setPredictionHull（渲染线同参）
config 变更到达（sendConfig）→ Worker onConfigApplied → physicsWorker.reapplyParams()
   —— 面板手动参数（ParamSource='manual'）优先于 config 默认，重应用防被冲掉
```

worker-dispatch 扩展点机制：共享分发器只处理通用消息，工程特有消息落到 `onExtraMessage(msg)`，返回是否已处理（`src/ts-shared/auth/worker-dispatch.ts:215-217`）。

## 8. 帧率与频率常量速查

| 常量 | 值 | 位置 |
|---|---|---|
| 权威固定步长 | 64Hz（config.physics.tickRate，48-128 可调） | `config.ts` + `auth-loop.ts:88-89` |
| Worker 轮询 | 4ms（250Hz） | `auth-loop.ts:194` |
| 单轮权威步数上限 | 64 | `auth-loop.ts:205` |
| HUD 采样 | 10Hz | `app.ts:1752-1758`（updateStatsUI/updateGameStatsUI） |
| 剔除统计回传 | 100ms | `renderer-main.ts:511-515` |
| 近平面探测 | 每 2 帧 | `renderer-main.ts:467-470` |
| 准星射线 | 每 6 帧 | `renderer-main.ts:492-501`（PLANE_INSPECT_INTERVAL=6） |
| 碰撞箱重建限流 | 实体/chamfer 6 帧，三角形 30 帧 | `collider-debug.ts:18-21` |
| 权威同步冷却 | 250ms / 传送豁免 200ms | `authority-calibrator.ts:104-107` |
