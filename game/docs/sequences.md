# game 核心时序（T）

> 核对基准：当前工作区代码（`game/src/`、`src/ts-shared/`、`src/phys/`），所有时序步骤标注来源函数与路径。架构背景见 [overview.md](overview.md)；共享通道/校准实现在 [`../../docs/ts-shared.md`](../../docs/ts-shared.md) 展开，本文只写 game 视角的时序。

## 0. 全景：两条物理线 + 一个通道

```
                    ┌──────────── 主线程（144Hz rAF）────────────┐
mousemove/keys ──▶ MouseBuffer ─▶ layerMouseDelta ─▶ feedInput ─┤
                    │                                            ▼
                    │                            pendingDx/Dy/Keys（帧内累积）
                    │                                            │
                    │      ┌─── RendererMain.tick 每帧六步 ─────┤
                    │      │ ① shared.addInput（写 SAB 输入槽）  │
                    │      │ ② correctFromAuthority（只读权威）  │
                    │      │ ③ calibrateVelocity（外推校准）     │
                    │      │ ④ predPhys.tick（完整物理推进）     │
                    │      │ ⑤ holdPoint 冻结（C 键按住）        │
                    │      │ ⑥ 相机 + LOD/PVS + render          │
                    │      └────────────────────────────────────┘
                    ▼ SAB 512B（V_A/dxAcc/dyAcc/双缓冲）或 MsgState 回退
┌──────────── Worker（固定步长 1/(tickRate+3)）────────────┐
│ auth-loop: setTimeout 4ms 自驱 → takeInput → tick        │
│   → writeAuthoritative（写空闲槽 → V_A++）               │
│   → 碰撞事件 land/blocked postMessage                    │
└──────────────────────────────────────────────────────────┘
```

双端跑**同一个**共享 `PhysWorld`（`game/src/renderer/renderer-main.ts:483-519` 主线程构建；`src/ts-shared/auth/worker-dispatch.ts:101-117` Worker 构建），权威线固定步长、渲染线可变 dt。

## 1. 启动时序（`game/src/app.ts:63-176` main()）

| 步 | 动作 | 代码 |
|---|---|---|
| 1 | 通道选择：`crossOriginIsolated === true` 且有 `SharedArrayBuffer` → `SAB(512B)`；否则 MsgState 并提示"兼容模式" | `app.ts:82-89` |
| 2 | spawn 权威 Worker：dist 内嵌模式用 `__VBSP_WORKER_JS__` → Blob URL module worker（file:// 下 module worker 被 CORS 拦截）；dev 模式 `./worker.js` | `app.ts:94-97` |
| 3 | 绑定 Worker 消息：`error` / `phys-event`（碰撞事件 → `renderer.applyCollisionCorrection`）/ `phys-frame`（MsgState 回退帧 → `sharedState.recvFrame`） | `app.ts:99-113` |
| 4 | 依次 postMessage `init{shared}` → `wasm-init{wasmB64 或 wasmUrl}`（Worker 侧 `initWasm` 强制 `initSync({module})`） | `app.ts:114-121`、`src/ts-shared/auth/worker-dispatch.ts:94-100` |
| 5 | `createMainSharedState(sharedBuffer, fixWorker)` 创建通道 | `app.ts:124` |
| 6 | 创建 `RendererMain`：注册 `onSceneLoaded`（死亡阈值）、`onSyncRenderState`（反向同步兜底 → `sync-render-state`）、`init()`（Three.js 场景/相机/固定三点光）、`start()`；主线程 wasm `initPrediction('./websurf_wasm_bg.wasm', embeddedWasm)`（保存 promise，地图加载 `decompress_mtz` 依赖其就绪） | `app.ts:128-141`、`renderer-main.ts:163-175,177-208,469-480` |
| 7 | `InputBridge` + `syncFullConfig()`（四段 config 双端全量下发）；`PanelController`（九个回调：onSyncPrediction/onSyncHull/onNoclipChange/onTextureQualityChange/onSyncFov/onSavePointDelete/onSavePointLoad…） | `app.ts:143-171` |
| 8 | `bindInput()` + `startInputLoop()`（rAF 输入循环） | `app.ts:174-175` |

此时两条 wasm 已就绪待命（Worker 权威 + 主线程渲染），等待地图。

## 2. 地图加载管线（`game/src/app.ts:387-479` handleLoadBsp）

主线程独占解析（Worker 不参与加载），Worker 只收成品 JSON：

```
选文件(fileInput.change) → handleLoadBsp(name, bytes)
  1 savePointStore.load(mapName)（按地图切存点列表） + panel.hide()
  2 await mainWasmReady（decompress_mtz 依赖）
  3 renderer.disposeScene()（清场景/物理/校准状态） + showLoading()
  4 buildWorldBundle(new BspProcessor(bytes), { decompressMtz, onProgress })   ← 共享管线
      metadata → spawn/teleport/pvs 借用导出 → 碰撞体(brush+模型三角)
      → 默认纹理包回退(mtz) → GLB 导出(含 PAKFILE 模型) → 出生点解析
      （src/ts-shared/phys/world-builder.ts:5-9,96-112；Bundle 字段 :51-68）
  5 renderer.loadScene({glb, spawnJson, pvsJson, mosaicManifest, metadata, spawn, …})
      GLB 加载 → optimizeScene 分块合并 → 相机 near/far → PVS/LOD 注册
      → onSceneLoaded(bbox.min.y)（死亡阈值） → 纹理画质 manifest 应用
      （renderer-main.ts:211-287）
  6 renderer.buildPredictionWorld({brushJson, triJson, teleportJson, spawn})
      ← 主线程 PhysWorld 就绪，渲染线物理开跑
  7 fixWorker.postMessage('world-json') → Worker build_world + syncParamsToWasm
      + authLoop.setFixedDt(tickRate+3) + reset   ← 权威线物理开跑
      （worker-dispatch.ts:101-117）
  8 双端 set-spawn-points：renderer.setSpawnPoints + Worker 'set-spawn-points'
      （缺权威侧列表时 teleport_to_spawn 静默忽略 → 权威帧把传送点拉回，app.ts:442-446 注释记录该根因）
  9 syncFullConfig()（双端参数同步，含灵敏度）
 10 sceneReady=true；spawn 下拉填充；finishLoading()；panel.updateVisibility(true)
 失败分支：setError + disposeScene + failLoading（覆盖层转错误态不自动消失，app.ts:473-478）
```

**加载覆盖层**：阶段名→百分比映射 `LOAD_STAGE_PCT`（`app.ts:535-543`），`advanceLoading` 驱动 rAF 补间（ease-out + 阶段内伪漂移防卡死感，`app.ts:583-645`）。

## 3. 主线程帧循环（`game/src/renderer/renderer-main.ts:693-768` tick）

每 rAF 一帧，`predReady && predPhys` 后执行六步：

1. **写输入** `shared.addInput(pendingDx, pendingDy, pendingKeys)`（`renderer-main.ts:703-704`）——权威 Worker 模拟与主线程同源同输入。
2. **读权威帧** `correctFromAuthority()`（`:706`，实现在 `src/ts-shared/phys/authority-calibrator.ts:128-190`）——只读；首次帧以权威全状态作渲染起点；传送豁免期内反向同步权威（见 §5）。
3. **速度外推** `calibrateVelocity(now)`（`:708`）——权威 67Hz 采样间隔内的速度外推，位置不覆盖。
4. **物理推进** `predPhys.tick(dt, pendingKeys, pendingDx, pendingDy)`（`:710`）——`dt = min((now-last)/1000, 0.1)`（首帧 1/64，`:701`）。Rust `step_core`：apply_input → 角度 → 传送 → 死亡 → reset → `player_tick`（`src/phys/mod.rs:222-272`）；noclip 时走 `noclip_step`（无碰撞）。
5. **holdPoint 冻结**（`:713-718`）——C 键按住期间每帧 `set_state`（位置/朝向=存点、速度 0）。
6. **渲染**（`:720-767`）——相机 `rotation.set(pitch·DEG2RAD, yaw·DEG2RAD, 0, 'YXZ')`、`position = pos + eyeHeight`；近平面自适应每 2 帧（`updateNearPlane`，`:729-733,387-444`）；LOD 距离剔除（`cullDistance = maxDim×0.5`，`:276`；PVS 因 `ENABLE_PVS=false` 跳过，`:740-744`）；`renderer.render`（`:767`）。

**输入循环**（独立 rAF，`game/src/app.ts:326-362` startInputLoop）：FPS 计数 1Hz；未锁定时 mask 恒 0；滚轮跳 pending 并入本帧 mask（消费一次即清）；Q/E → `qeEquivalentDx(yawBindSpeed, dt)` 等效鼠标量（恒定角速度、不受灵敏度影响）；`renderer.feedInput(qeDx, 0, maskWithWheel)`；速度 HUD 8Hz 采样 `getCurrentVel`（`app.ts:356-359,364-379`）。

## 4. Worker 权威循环（`src/ts-shared/auth/auth-loop.ts` + `game/src/worker/main.ts:72-90`）

| 要素 | 值 | 代码 |
|---|---|---|
| 自驱节拍 | `setTimeout(loop, 4)` | `auth-loop.ts:194` |
| 累积器 | `dtAcc` 累积墙钟，≥ fixedDt 才步进；上限保护 `guard`（≤64 步/次防雪崩） | `auth-loop.ts:119-155,204` |
| 单步输入上限 | `maxStep = MAX_INPUT_PER_STEP_BASE(1200) × dt / (1/64)`——`takeInput` 饱和截断防穿墙 | `auth-loop.ts:85,118`、`shared-state.ts:292-304` |
| 固定步长 | `1/(tickRate+3)`：面板 64 → 权威 67Hz（`TICK_RATE_OFFSET=3` 不进 HUD）；面板改 tickRate 即时 `setFixedDt + reset` | `game/src/worker/main.ts:32,86`、`worker-dispatch.ts:125-128` |
| 单步流程 | `takeInput` → `phys.tick(fixedDt, keys, dx, dy)` → `writeAuthoritative`（写空闲槽 → release `V_A++`） | `auth-loop.ts:119-158`、`shared-state.ts:316-334` |
| 碰撞事件 | land = onGround 上升沿；blocked = 速度骤降（>250 u/s）且实际位移远小于应走位移 → postMessage 给主线程 | `auth-loop.ts:160-190` |

## 5. 校准与反向同步（渲染 144Hz 为准，权威只读 + 兜底）

`src/ts-shared/phys/authority-calibrator.ts`（实例化于 `renderer-main.ts:150-161`，deps：readAuth/getPhys/clearPendingInput/onSyncRenderState）：

| 场景 | 行为 | 代码 |
|---|---|---|
| 首次权威帧 | 以权威全状态 `set_state` 作渲染物理起点 | `authority-calibrator.ts:184-190` |
| 传送/重生豁免期（200ms） | 不让权威旧位置覆盖渲染新位置；反向 `onSyncRenderState` 把渲染新状态推给权威，`predStarted=true` 防豁免结束后又被拉回 | `authority-calibrator.ts:139-168`（TELEPORT_EXEMPT_MS） |
| 新权威帧到达（V_A 变化） | 记录帧供外推；三条件 OR 兜底（位置差>500 强制；>300 且水平朝向一致；≤300 但视角差>45°）→ 渲染主线 `sync-render-state` 反向覆盖权威 + 双端清输入增量；250ms 冷却 + syncInFlight 在途回滚 | `authority-calibrator.ts:170-315`（SYNC_COOLDOWN_MS） |
| 每帧速度校准 | `calibrateVelocity`：权威速度外推 + 大偏差衰减，位置不动 | `authority-calibrator.ts::calibrateVelocity` |
| 碰撞事件（land/blocked） | 权威仅碰撞判断时可影响渲染：land = 权威全状态恢复（<60 units）；blocked = 仅位置/角度 | `authority-calibrator.ts:344-385`、`game/src/app.ts:104-107` |
| 权威侧收到同步 | `set_state(渲染帧)` + `resetInput()`（键位保留） | `worker-dispatch.ts:156-181` |

## 6. 通道协议细节

### 6.1 SAB 512B 布局（`src/ts-shared/auth/shared-state.ts:20-117`）

| 区 | 索引 | 内容 |
|---|---|---|
| Int32 | `[0]` | V_A 权威版本号（release 递增） |
| Int32 | `[1]` | I_KEYS 键位掩码（无条件 store，松手即 0） |
| Int32 | `[2]` | I_A_GROUND 着地标志 |
| BigInt64 | `[8]/[9]` | dxAcc/dyAcc 输入增量（Atomics.add 累加，×1000 定点；exchange 清空消费） |
| BigInt64 | `[16..25]` | 帧 A：pos×3(×100)、yaw(×1000)、pitch(×1000)、vel×3(×100)、eyeHeight(×100)、timeMs |
| BigInt64 | `[26..35]` | 帧 B（双缓冲：写 `V_A&1` 槽 → V_A++；读 `(V_A-1)&1` 槽，消除多字段撕裂） |

### 6.2 MsgState 回退（`shared-state.ts:150-228`）

无 COOP/COEP 时：主线程 `addInput` → postMessage `input`；Worker 消费缓冲；Worker 每步 `writeAuthoritative` → postMessage `phys-frame`；主线程 `recvFrame` 缓存（`game/src/app.ts:108-112`）。接口与 SAB 完全同构，功能等价、性能降级。

### 6.3 主线程 ↔ Worker 消息全集（实际生效）

| 方向 | 消息 | 触发 | 处理 |
|---|---|---|---|
| 主→W | `init` / `wasm-init` | 启动 | worker-dispatch.ts:79-100 |
| 主→W | `world-json` | 地图加载 | build_world + 参数同步 + 固定步长（:101-117） |
| 主→W | `input` | 仅 MsgState 回退每帧 | recvInput 累积（:86-93） |
| 主→W | `config` | 面板/启动 | applyConfigPatch + tickRate/set_hull/set_noclip（:118-150） |
| 主→W | `respawn` / `teleport` | R 键按钮 / spawn 下拉 | respawn / teleport_to_spawn（:151-155,191-197） |
| 主→W | `set-spawn-points` | 地图加载 | set_spawn_points（:182-190） |
| 主→W | `sync-render-state` | 兜底同步 | set_state + resetInput（:156-181） |
| W→主 | `phys-event` | land/blocked | applyCollisionCorrection（app.ts:104-107） |
| W→主 | `phys-frame` | 仅 MsgState 回退每步 | recvFrame（app.ts:108-112） |
| W→主 | `error` | wasm 加载失败 | setError（app.ts:102-103） |

> `teleport-to-pos` / `set-death-threshold` 在 worker-dispatch 中有处理分支（`:198-216`）但 **game 主线程从不发送**（grep `game/src` 无调用；`game/src/input/input-bridge.ts:68` `sendSetDeathThreshold` 定义后无调用点）——game 权威侧死亡阈值恒为 Rust 默认 −100000（`src/phys/mod.rs:92`），死亡判定实际只在渲染线生效（详见 [implementation/gameplay.md](implementation/gameplay.md) §4）。

## 7. 生命周期事件时序

- **锁定/退锁**（`app.ts:222-237`）：`onLockChange` → `mouseBuffer.onLockChange`（清 buffer + discardNext）→ `keyboard.setEnabled/reset` → `renderer.clearPendingInput` + `bridge.addInput(0,0,0)` → `panel.updateVisibility`。面板打开（未锁定）时输入 mask 恒 0（`app.ts:342`），面板内按键不进物理。
- **页面失焦**（`app.ts:243-251`）：`keyboard.reset()` + `sharedState.addInput(0,0,0)` 显式清权威键位（rAF 后台停摆会冻结 I_KEYS，Worker 会按旧键位继续移动）+ 清预测待喂输入。
- **noclip 切换**（`panel-controller.ts:415-423`）：`sendConfig('physics',{mode})` → 双端 `set_noclip`（Worker dispatch :144-147；主线程 `renderer-main.ts:662-669`）。
- **重生**：R/按钮 → `bridge.sendRespawn` → 双端 `respawn()`（`input-bridge.ts:57`、`renderer-main.ts:520-522`、dispatch :151-155）。
- **存点 X / 按住 C**：见 [implementation/gameplay.md](implementation/gameplay.md)。
