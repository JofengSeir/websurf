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

双端跑**同一个**共享 `PhysWorld`（`game/src/renderer/renderer-main.ts:483-519` 主线程构建；`src/ts-shared/auth/worker-dispatch.ts:154-182` Worker 构建，解耦模式 tickPhys 第二实例同建同参 `:169-175`），权威线固定步长、渲染线可变 dt。

> **双模式定调（phys-mode-port）**：本图与 §1-§7 时序为**耦合模式**（默认，v7 现行零回归）。解耦模式下主线程零物理 tick（§3 六步停跑，改走 T7' 纯消费），Worker 内解耦线接管物理推进——热切握手、S_D 槽、解耦消费时序见 §8。两模式共享输入漏斗（§3 步骤 1）/近平面自适应/面板/存点/加载链。

## 1. 启动时序（`game/src/app.ts:79-219` main()）

| 步 | 动作 | 代码 |
|---|---|---|
| 1 | 通道选择：`crossOriginIsolated === true` 且有 `SharedArrayBuffer` → `SAB(512B)`；否则 MsgState 并提示"兼容模式" | `app.ts:87-93` |
| 2 | spawn 权威 Worker：dist 内嵌模式用 `__VBSP_WORKER_JS__` → Blob URL module worker（file:// 下 module worker 被 CORS 拦截）；dev 模式 `./worker.js` | `app.ts:99-100` |
| 3 | 绑定 Worker 消息：`error` / `phys-event`（碰撞事件 → `renderer.applyCollisionCorrection`，解耦防御性 gate）/ `phys-frame`（MsgState 回退帧 → `sharedState.recvFrame`，解耦期双喂解耦缓存）/ `mode-ack`（热切收尾 → `renderer.handleModeAck` + 面板回写） | `app.ts:101-123` |
| 4 | 依次 postMessage `init{shared}` → `wasm-init{wasmB64 或 wasmUrl}`（Worker 侧 `initWasm` 强制 `initSync({module})`） | `app.ts:125-131`、`src/ts-shared/auth/worker-dispatch.ts:103-126,147-153` |
| 5 | `createMainSharedState(sharedBuffer, fixWorker)` 创建通道 | `app.ts:135` |
| 6 | 创建 `RendererMain`：注册 `onSceneLoaded`（死亡阈值 + W-GAP-2 权威补发）、`onSetModeResend/onModeSwitchFailed/onParamsResync`（热切超时三钩子）、`onSyncRenderState`（反向同步兜底 → `sync-render-state`）、`init()`（Three.js 场景/相机/固定三点光）、`start()`；主线程 wasm `initPrediction('./websurf_wasm_bg.wasm', embeddedWasm)`（保存 promise，地图加载 `decompress_mtz` 依赖其就绪） | `app.ts:139-176`、`renderer-main.ts:219-223,393,517` |
| 7 | `InputBridge` + `syncFullConfig()`（四段 config 双端全量下发）；`PanelController`（十回调：onComputeModeChange/onSyncPrediction/onSyncHull/onNoclipChange/onTextureQualityChange/onSyncFov/onSavePointDelete/onSavePointLoad…）；**解耦偏好自启动**（默认耦合；持久化偏好为解耦时启动即发 `set-mode`，无预测交接态） | `app.ts:179-216` |
| 8 | `bindInput()` + `startInputLoop()`（rAF 输入循环） | `app.ts:218-219` |

此时两条 wasm 已就绪待命（Worker 权威 + 主线程渲染），等待地图。

## 2. 地图加载管线（`game/src/app.ts:431-507` handleLoadBsp）

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
      （renderer-main.ts:259-328）
  6 renderer.buildPredictionWorld({brushJson, triJson, teleportJson, spawn})
      ← 主线程 PhysWorld 就绪，渲染线物理开跑
  7 fixWorker.postMessage('world-json') → Worker 双实例 build_world（phys + tickPhys
      同建同参 G3；重建前 free 旧实例 P5）+ syncParamsToWasm（双实例同参）
      + authLoop.setFixedDt(tickRate+3) + reset + 解耦首帧发布
      ← 权威线物理开跑（worker-dispatch.ts:154-182）
  8 双端 set-spawn-points：renderer.setSpawnPoints + Worker 'set-spawn-points'
      （缺权威侧列表时 teleport_to_spawn 静默忽略 → 权威帧把传送点拉回，app.ts:487-489 注释记录该根因）
  9 syncFullConfig()（双端参数同步，含灵敏度）
 10 sceneReady=true；spawn 下拉填充；finishLoading()；panel.updateVisibility(true)
 失败分支：setError + disposeScene + failLoading（覆盖层转错误态不自动消失，app.ts:519-521）
```

**加载覆盖层**（`app.ts:593-728`）：阶段名→百分比映射 `LOAD_STAGE_PCT`（`app.ts:593-601`）；`advanceLoading`（`:694-703`）设目标百分比，`tickLoading` rAF 补间驱动（ease-out 逼近 + 阶段内伪漂移防卡死感，`:641-666`，逐帧写 `--load-pct` 自定义属性（`setProperty`，`:658`））。显隐/错误态走 CSS class 钩子（`#loadingOverlay.show`/`#loadingOverlay.error`，`game/web/styles.css:510,540`）；显示时进度条复位 `removeProperty('--load-pct')` 回落 0% 回落值（`app.ts:677-679`，`.load-fill` `width:var(--load-pct, 0%)`，`styles.css:529`）。

## 3. 主线程帧循环（`game/src/renderer/renderer-main.ts:920-1016` tick）

每 rAF 一帧。**耦合模式**（默认）下 `predReady && predPhys` 后执行六步：

1. **写输入** `shared.addInput(pendingDx, pendingDy, pendingKeys)`（`renderer-main.ts:934-935`）——权威 Worker 模拟与主线程同源同输入；解耦模式同写（输入漏斗两模式共用，`:931-941`）+ 每帧 `wake()` 背压唤醒（`:943-946`）。
2. **读权威帧** `correctFromAuthority()`（`:950`，实现在 `src/ts-shared/phys/authority-calibrator.ts:174-315`）——只读；首次帧以权威全状态作渲染起点；传送豁免期内反向同步权威（见 §5）。
3. **速度外推** `calibrateVelocity(now)`（`:952`）——权威 67Hz 采样间隔内的速度外推，位置不覆盖。
4. **物理推进** `predPhys.tick(dt, pendingKeys, pendingDx, pendingDy)`（`:954`）——`dt = min((now-last)/1000, 0.1)`（首帧 1/64，`:929`）。Rust `step_core`：apply_input → 角度 → 传送 → 死亡 → reset → `player_tick`（`src/phys/mod.rs:222-272`）；noclip 时走 `noclip_step`（无碰撞）。
5. **holdPoint 冻结**（`:959-962`）——C 键按住期间每帧 `set_state`（位置/朝向=存点、速度 0）；解耦模式由 worker 侧 runHeldRound 执行（§8）。
6. **渲染**（`:964-1015`）——相机 `rotation.set(pitch·DEG2RAD, yaw·DEG2RAD, 0, 'YXZ')`、`position = pos + eyeHeight`；近平面自适应每 2 帧（`updateNearPlane`，`:974-977`）；LOD 距离剔除（`cullDistance = maxDim×0.5`；PVS 因 `ENABLE_PVS=false` 跳过）；`renderer.render`（`:1015`）。

**解耦模式分叉**（`:979-982`）：耦合物理块（步骤 2-5）整体停跑，改走 `tickDecoupledCamera`——读最新解耦帧 + 权威速度外推设相机（`renderer-main.ts:1027-1046`，主线程零物理 tick）。dt/lastTickMs 每帧照常推进（解耦期挂起预测线，切回耦合无大步长跳变）。

**输入循环**（独立 rAF，`game/src/app.ts:326-362` startInputLoop）：FPS 计数 1Hz；未锁定时 mask 恒 0；滚轮跳 pending 并入本帧 mask（消费一次即清）；Q/E → `qeEquivalentDx(yawBindSpeed, dt)` 等效鼠标量（恒定角速度、不受灵敏度影响）；`renderer.feedInput(qeDx, 0, maskWithWheel)`；速度 HUD 8Hz 采样 `getCurrentVel`（`app.ts:356-359,364-379`）。

## 4. Worker 权威循环（`src/ts-shared/auth/auth-loop.ts` + `game/src/worker/main.ts:114-123`——耦合模式线）

| 要素 | 值 | 代码 |
|---|---|---|
| 自驱节拍 | `setTimeout(loop, 4)`；模式门 `modeGate` 关断时冻结墙钟早退（双线互斥，`:206-210`） | `auth-loop.ts:203,206-210` |
| 累积器 | `acc` 累积墙钟（`:218-219`），≥ fixedDt 才步进；上限保护 `guard`（≤64 步/次防雪崩，`:221-227`） | `auth-loop.ts:218-227` |
| 单步输入上限 | `maxStep = MAX_INPUT_PER_STEP_BASE(1200) × dt / (1/64)`——`takeInput` 饱和截断防穿墙 | `auth-loop.ts:94,127-128`、`shared-state.ts:358-369` |
| 固定步长 | `1/(tickRate+3)`：面板 64 → 权威 67Hz（`TICK_RATE_OFFSET=3` 不进 HUD）；面板改 tickRate 即时 `setFixedDt + reset` | `game/src/worker/main.ts:49-53,222`、`worker-dispatch.ts:200-207` |
| 单步流程 | `takeInput` → `phys.tick(fixedDt, keys, dx, dy)` → `writeAuthoritative`（写空闲槽 → release `V_A++`） | `auth-loop.ts:123-201,156`、`shared-state.ts:492-511` |
| 碰撞事件 | land = onGround 上升沿；blocked = 速度骤降（>250 u/s）且实际位移远小于应走位移 → postMessage 给主线程 | `auth-loop.ts:117-121,171-200` |

> 解耦模式下本线经 `modeGate` 早退（`game/src/worker/main.ts:122`），改由 decoupled-loop 推进（§8）；`publishCurrentState`（`auth-loop.ts:241-268`）供热切复入首帧（§8）。

## 5. 校准与反向同步（渲染 144Hz 为准，权威只读 + 兜底）

`src/ts-shared/phys/authority-calibrator.ts`（实例化于 `renderer-main.ts:150-161`，deps：readAuth/getPhys/clearPendingInput/onSyncRenderState）：

| 场景 | 行为 | 代码 |
|---|---|---|
| 首次权威帧 | 以权威全状态 `set_state` 作渲染物理起点 | `authority-calibrator.ts:229-236` |
| 传送/重生豁免期（200ms） | 不让权威旧位置覆盖渲染新位置；反向 `onSyncRenderState` 把渲染新状态推给权威，`predStarted=true` 防豁免结束后又被拉回 | `authority-calibrator.ts:153,185-212`（TELEPORT_EXEMPT_MS） |
| 新权威帧到达（V_A 变化） | 记录帧供外推；三条件 OR 兜底（位置差>500 强制；>300 且水平朝向一致；≤300 但视角差>45°）→ 渲染主线 `sync-render-state` 反向覆盖权威 + 双端清输入增量；250ms 冷却 + syncInFlight 在途撤回兜底 | `authority-calibrator.ts:150,262-306`（SYNC_COOLDOWN_MS） |
| 每帧速度校准 | `calibrateVelocity`：权威速度外推 + 大偏差衰减，位置不动 | `authority-calibrator.ts:344` |
| 碰撞事件（land/blocked） | 权威仅碰撞判断时可影响渲染：land = 权威全状态恢复（<60 units）；blocked = 仅位置/角度 | `authority-calibrator.ts:399-431`、`game/src/app.ts:106-111` |
| 权威侧收到同步 | `set_state(渲染帧)` + `resetInput()`（键位保留）；解耦模式双实例同注（tickPhys 同注入防锚定拉走） | `worker-dispatch.ts:251-286` |

## 6. 通道协议细节

### 6.1 SAB 512B 布局（`src/ts-shared/auth/shared-state.ts:17-38,109-130`）

| 区 | 索引 | 内容 |
|---|---|---|
| Int32 | `[0]` | V_A 权威版本号（release 递增） |
| Int32 | `[1]` | I_KEYS 键位掩码（无条件 store，松手即 0） |
| Int32 | `[2]` | I_A_GROUND 着地标志（耦合/解耦复用——模式互斥运行） |
| Int32 | `[3]` | **V_D 解耦帧版本号**（双模式扩展 `:114`；0 = 未开始） |
| Int32 | `[4]` | **WAKEUP 背压唤醒电平**（`:115`；主线程 rAF store(1)+notify，解耦线 wait+CAS 复位） |
| BigInt64 | `[8]/[9]` | dxAcc/dyAcc 输入增量（Atomics.add 累加，×1000 定点；耦合 exchange 截断消费 / 解耦 CAS 清零不限幅） |
| BigInt64 | `[16..25]` | 帧 A：pos×3(×100)、yaw(×1000)、pitch(×1000)、vel×3(×100)、eyeHeight(×100)、timeMs |
| BigInt64 | `[26..35]` | 帧 B（双缓冲：写 `V_A&1` 槽 → V_A++；读 `(V_A-1)&1` 槽，消除多字段撕裂） |
| BigInt64 | `[36..45]/[46..55]` | **解耦帧 S_D 双缓冲**（`B_D0/B_D1 :126-127`，同款 10 值定点编码；V_D 协议同 V_A） |

### 6.2 MsgState 回退（`shared-state.ts:154-296`）

无 COOP/COEP 时：主线程 `addInput` → postMessage `input`；Worker 消费缓冲；Worker 每步 `writeAuthoritative` → postMessage `phys-frame`；主线程 `recvFrame` 缓存（`game/src/app.ts:112-116`）。接口与 SAB 完全同构，功能等价、性能降级。双模式扩展：解耦期同载荷双喂 latest/latestDecoupled（`recvFrame :223-232`，mode 内互斥运行）；解耦帧发布节流 `MsgState.publishFloorMs = 4`（`:168,282-284`）；`wake` 为 no-op（`:218-219`）、`waitWakeup` 空转挂起语义照常（`:291`）。

### 6.3 主线程 ↔ Worker 消息全集（实际生效）

| 方向 | 消息 | 触发 | 处理 |
|---|---|---|---|
| 主→W | `init` / `wasm-init` | 启动 | worker-dispatch.ts:132-153 |
| 主→W | `world-json` | 地图加载 | 双实例 build_world（phys + tickPhys 同建同参 G3）+ 参数同步 + 固定步长 + 解耦首帧发布（:154-182） |
| 主→W | `input` | 仅 MsgState 回退每帧 | recvInput 累积（:139-146） |
| 主→W | `config` | 面板/启动 | applyConfigPatch（W-GAP-1 snake→camel 键名归一 `:186-196`）+ tickRate 模式感知/set_hull/set_noclip（:183-235） |
| 主→W | `respawn` / `teleport` | R 键按钮 / spawn 下拉 | respawn / teleport_to_spawn（:236-250,297-303；解耦模式 worker respawn + 采样器复位） |
| 主→W | `set-spawn-points` | 地图加载 | set_spawn_points 双实例（:287-296） |
| 主→W | `sync-render-state` | 兜底同步/存点恢复 | set_state + resetInput（:251-286；解耦模式 tickPhys 同注入 `:277-283`） |
| 主→W | `set-mode` | 面板计算模式热切 | 幂等翻转 + onSetMode（gate/注入/采样器）+ `mode-ack` 回执（:325-337） |
| 主→W | `set-hold` | 解耦模式 C 键冻结 | onSetHold 注入/解除（:338-344） |
| W→主 | `phys-event` | land/blocked | applyCollisionCorrection（app.ts:106-111；解耦模式 worker 侧停发） |
| W→主 | `phys-frame` | 仅 MsgState 回退每步 | recvFrame（app.ts:112-116；解耦期双喂解耦缓存） |
| W→主 | `mode-ack` | set-mode 回执 | handleModeAck + panel.onComputeModeSettled（app.ts:117-123） |
| W→主 | `error` | wasm 加载失败 | setError（app.ts:102-103） |

> `teleport-to-pos` 有 dispatch 分支（`:305-313`）但 game 主线程无发送方；`set-death-threshold` 已接线（W-GAP-2 修复：`input-bridge.ts:76` + `app.ts:142-145` onSceneLoaded 补发，双端死亡判定同值，G3 双实例 `:315-323`）。

## 7. 生命周期事件时序

- **锁定/退锁**（`app.ts:266-284`）：`onLockChange` → `mouseBuffer.onLockChange`（清 buffer + discardNext）→ `keyboard.setEnabled/reset` → `renderer.clearPendingInput` → `panel.updateVisibility`。面板打开（未锁定）时输入 mask 恒 0（`app.ts:385`），面板内按键不进物理。
- **页面失焦**（`app.ts:287-297`）：`keyboard.reset()` + `sharedState.addInput(0,0,0)` 显式清权威键位（rAF 后台停摆会冻结 I_KEYS，Worker 会按旧键位继续移动）+ 清预测待喂输入。
- **noclip 切换**（`panel-controller.ts:443-449`）：`sendConfig('physics',{mode})` → 双端 `set_noclip`（Worker dispatch :231；主线程 `renderer-main.ts:881-892`——解耦模式搁置标记陈旧，切回耦合重推）。
- **重生**：R/按钮 → `bridge.sendRespawn` → 解耦模式跳过本地预测 respawn（worker 双实例为真理源），耦合维持 v7 双端 `respawn()`（`input-bridge.ts:62-66`、`renderer-main.ts:709-711`、dispatch :236-250）。
- **存点 X / 按住 C**：见 [implementation/gameplay.md](implementation/gameplay.md)；解耦模式 C 键走 worker 侧 set-hold（§8）。
- **死亡阈值**（W-GAP-2 已接线）：场景加载 onSceneLoaded → `sendSetDeathThreshold(deathY)` → worker 双实例 `set_death_y`（`app.ts:142-145`、`input-bridge.ts:76`、dispatch :315-323）——双端死亡判定同值。

## 8. 双模式与热切时序（phys-mode-port）

### 8.1 两条计算线 + 模式门（worker 侧）

Worker 内 auth-loop（耦合线，§4）与 decoupled-loop（解耦线，§8.3）**常驻自驱**，各带模式门早退（`game/src/worker/main.ts:122,135`；auth-loop `modeGate` `src/ts-shared/auth/auth-loop.ts:78,206-210`，解耦线 `isDecoupled` 门 + 门关轮 4ms 空转 `decoupled-loop.ts:297-305`）。模式真相源 = worker 侧 `computeMode`（`main.ts:71`），**仅 set-mode 翻转**；config 的 `computeMode` 字段是声明性元数据（默认值/偏好），不绕过握手（`main.ts:66-71`、`config.ts:11-17`）。

### 8.2 set-mode 热切握手全序（位置/朝向/速度连续）

| 步 | 方 | 动作 | 代码 |
|---|---|---|---|
| 1 | 主 | 面板"计算模式"下拉 change → 控件在途禁用 → `onComputeModeChange` → `bridge.sendSetMode(mode)`（在途守卫防二次发送） | `panel-controller.ts:430-440`、`input-bridge.ts:94-110` |
| 2 | 主 | 耦合→解耦：`buildHandoverState()` 取预测全态 9 字段 → `enterDecoupledSwitch()`（耦合物理块门停 + 500ms ack 定时器）；解耦→耦合：`enterCoupledSwitch()`（消费分支保持） | `renderer-main.ts:584-599,604-617` |
| 3 | W | dispatch `set-mode` 分支：同 mode 幂等直接回 ack；异 mode → `onSetMode` 执行步骤 4-7 | `worker-dispatch.ts:325-337` |
| 4 | W | `applyModeSwitch`：a. gate 翻转（两 loop 下轮自然互斥）；b.（耦合→解耦）状态注入 `phys.set_state` 9 字段；c. `resetSamplers(true)`（tickPhys 对齐 + 采样器全清）；d. `resetInput`（增量清、键位留）；e. `publishCurrentState`（交接帧立刻写 S_D，`main.ts:146-179`） | `game/src/worker/main.ts:146-179` |
| 5 | W | 回 `mode-ack{mode, appliedAtMs}` | `worker-dispatch.ts:335` |
| 6 | 主 | `handleModeAck`：解耦 → 激活 T7' 消费分支 + 时钟重锚；耦合 → 读最后解耦帧（无则回退耦合权威帧）→ `predPhys.set_state` 复入 + 参数陈旧全量重推 | `renderer-main.ts:658-692`、`app.ts:117-123` |
| 7 | 主 | 面板 `onComputeModeSettled`：config 字段回写 + 控件解锁 + 偏好持久化 | `panel-controller.ts:86-91` |

**超时与回滚**（`renderer-main.ts:619-643`）：500ms 无 ack → 重发一次（`resendSetMode`，`input-bridge.ts:112-120`，重发帧重锚 t12 F1）；再无 ack → 回滚——`requested='decoupled'` 失败恢复耦合门控并回写面板（`app.ts:156-164`），`requested='coupled'` 失败保持解耦消费。解耦向复入耦合由 worker 发布权威帧（`authLoop.publishCurrentState`，`main.ts:172-177`）。

### 8.3 解耦循环单轮全序（`src/ts-shared/decoupled/decoupled-loop.ts:297-411`，harness WorkerA 全序移植）

```
每轮（active 时 setTimeout 0 急轮询；门关/未就绪 4ms 空转 :301-305）：
 delta clamp（0~50ms，:313-317）
 → hold 冻结轮（set-hold 注入时：set_state(held,vel=0)+时间/输入丢弃+对齐，:273-294,320-325）
 → tickPhys 激活判定（raw tickRate>0 且 1/rate>1ms；停用↔激活边沿清采样器+alignTickPhys，:328-343）
 →【第一步 tick 计算】loAcc≥tickDt 时：
     peekKeys 边界快照（:354）+ tickDx/tickDy 窗口限幅（tickInputMax=1000×(tickDt/0.001)，:139-142,355-359）
     → 分叉锚定（位置偏差>TICK_ANCHOR_DIST=64 → alignTickPhys 拉回，:133,190-200,363-365）
     → tickPhys.tick(tickDt)（:368）→ phys.set_velocity 三轴校准（对 phys 唯一影响通道，:372）
 →【第二步 无限制】acc≥1ms：consumeInput CAS 不限幅（:388）
     → phys.tick_into(1ms)（:395）→ S_D 零分配发布（state_out_ptr Float64Array 直读→定点写，:215-238）
     → acc 封顶 MAX_ACC（:402）→ 背压 waitWakeup（idle≥1ms 挂起，上限 4ms，:405-410）
```

- 常量：`RENDER_DT=0.001/MAX_DELTA=0.05/MAX_STEPS_PER_ROUND=8/MAX_ACC=0.02/MAX_INPUT_DELTA=1000/WAIT_THRESHOLD_MS=1/MAX_WAIT_MS=4/TICK_ANCHOR_DIST=64/SLOW_FIELD_REFRESH_MS=16`（`decoupled-loop.ts:116-137`）。
- tickPhys 步长 = `config.physics.tickRate` **raw 原值**（无 +3 偏移——偏移仅耦合权威线语义；`main.ts:133-134`、`decoupled-loop.ts:90-91`）；速率变更边沿 `onTickRateChanged` 清采样器并对齐（`:414-419`）。
- 眼高/着地为慢字段：16ms（≈60Hz）低频 `phys.state()` 刷新缓存 + 发布帧即时刷新（`SLOW_FIELD_REFRESH_MS`，`decoupled-loop.ts:19-22,137,203-213`）。
- 退化路径：无 wasm 内存注入（node 测试）→ `publishFromState` 对象路径兜底（`:241-269,396-399`）。

### 8.4 S_D 消费（主线程 T7' 纯消费）

`tickDecoupledCamera`（`renderer-main.ts:1027-1046`）：`readDecoupled()` 读最新解耦帧（SAB `(V_D-1)&1` 槽 / MsgState `latestDecoupled`，`shared-state.ts:441-464,213-216`）→ 首帧建时钟锚 `extrapClockAnchorMs`（t12 F1：吸收主线程/worker 时钟原点差；重发/回滚/ack 三处置均重锚，`renderer-main.ts:137-138,631,639,666`）→ `extrapolateAuthPose` 一阶外推（位置=帧位置+帧速度×dt，钳 0~250ms；角度/眼高直读——`authority-calibrator.ts:101,110-121`）→ 相机；近平面自适应共享。`pendingDx/Dy` 写 SAB 后立即清零（解耦线是唯一消费者，`renderer-main.ts:936-941`）。F1 修复链：基准档案 `temp/t6-review/t11-evidence/anchor-test.mjs`（方向修正版：anchor = 主线程时钟 − worker 帧时钟）；t12 脚本为历史存档，勿引用为现行事实（修复链全表见 `differences.md` §7.1）。

### 8.5 解耦模式下的存点/C 键 hold

C 按住 → `sendSetHold({x,y,z,yaw,pitch,onGround})`（worker 侧 runHeldRound 逐轮强制 set_state 冻结）；松开 → `sendSetHold(null, savePoint)` = 双实例 set_state 全量恢复 + 采样器清零 + 输入清 + 首帧发布（`app.ts:543-568`、`input-bridge.ts:125-129`、`worker/main.ts:187-208`、`decoupled-loop.ts:273-294`）。耦合模式保持 v7 主线程 holdPoint 语义（`renderer-main.ts:812-829`）。跨热切边沿（t12 F3）：解耦→耦合切换时 worker 侧在途 hold 清除（`worker/main.ts:169-171`——冻结不跨模式存活）；C 按住跨**耦合→解耦**边沿 = 冻结丢失至 keyup（keyup 仍走 `set-hold(null, savePoint)` 全量恢复，`app.ts:559-568`）——已知跳变披露见 `differences.md` §7.2⑥。

### 8.6 解耦期的其余操作处置（一表）

| 操作 | 解耦模式行为 | 代码 |
|---|---|---|
| respawn | 跳过本地预测 respawn；worker 双实例 `respawn()`（teleport/死亡同走 worker） | `input-bridge.ts:62-66`、dispatch :236-250 |
| teleport（spawn 下拉） | 跳过本地传送；worker 双实例同步 + 解耦帧拉主线程 | `input-bridge.ts:69-74`、dispatch :297-303 |
| 面板参数/体型/noclip | 预测线停 tick → 搁置标记 `predParamsStale`（worker 照常生效）；切回耦合 `onParamsResync` 全量重推 | `renderer-main.ts:863-901`、`app.ts:166-169` |
| phys-event（land/blocked） | worker 解耦线不产生事件；主线程防御性 gate（非耦合忽略） | `renderer-main.ts:854-859` |
| 存点 X（保存） | `getFullState` 读最新解耦帧（无则回退耦合权威帧）作存点内容——主线程零 tick，状态源=权威 | `renderer-main.ts:751-780`、`app.ts:526-534` |
| tickRate 面板变更 | config 下发 → worker 模式感知步长（耦合 +3 / 解耦 raw）→ `decoupledLoop.onTickRateChanged` 清采样器并对齐 | `worker-dispatch.ts:197-207`、`decoupled-loop.ts:414-419` |
