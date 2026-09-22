# apps/debug 主流程时序

## 启动时序

参与者代号：**浏览器** = 页面与静态资源加载；**主线程** = `apps/debug/web/app.js`（由 `apps/debug/src/app.ts` 打包）；**Worker** = `apps/debug/web/worker.js`（由 `apps/debug/src/worker/main.ts` 打包）。

| 参与者 | 步骤 | 数据落点 | 锚点 |
|---|---|---|---|
| 浏览器 | 拉取页面骨架（顶栏 / 侧边栏 / 预览区 / HUD / 弹窗） | DOM：共 106 个 id | `apps/debug/web/index.html:283` |
| 浏览器 | 先执行 COOP/COEP 补丁脚本（classic），再执行应用入口（module） | 补丁脚本负责在响应头缺失时补上隔离头；入口是 esbuild 产物 | `apps/debug/web/index.html:695`、`apps/debug/web/index.html:696` |
| 主线程 | `main` 取画布句柄；取不到即返回 | `dom.canvas` | `apps/debug/src/app.ts:279` |
| 主线程 | 通道选择：`crossOriginIsolated` 为真且有 `SharedArrayBuffer` → 建 `SHARED_BUFFER_SIZE` 共享缓冲，否则置 `null` | `sharedBuffer` | `apps/debug/src/app.ts:286` |
| 主线程 | 建 Worker：有构建注入的 Worker 源码走 Blob URL，否则 `new Worker('./worker.js', { type: 'module' })`；绑 `onmessage` / `onerror` | `worker` 与 `handleWorkerMessage` | `apps/debug/src/app.ts:298`、`apps/debug/src/app.ts:305` |
| 主线程 | 下发 `wasm-init`：内嵌时发 `wasmB64`（可另带 `mtzB64`），否则发 `wasmUrl` | Worker 的 `wasm-init` 分支 | `apps/debug/src/app.ts:315` |
| 主线程 | `createMainSharedState(sharedBuffer, worker)` | `sharedState`：SAB 通道取 `ShmState`，回退取 `MsgState` | `apps/debug/src/app.ts:325` |
| 主线程 | `new InputBridge(worker)` 并 `sendInit(sharedBuffer, 画布宽, 画布高, dpr)` | `init` 消息（`shared` / `width` / `height` / `dpr`） | `apps/debug/src/app.ts:327` |
| 主线程 | `new RendererMain(sharedState)`，注册 `onCullStats` / `onSceneLoaded` / `onSyncRenderState` / `onPhysEvent` 四个回调 | 渲染器实例与回调 | `apps/debug/src/app.ts:336` |
| 主线程 | `rendererMain.init(canvas, 宽, 高, dpr, config)` → `rendererMain.start()` | rAF 渲染循环启动 | `apps/debug/src/app.ts:352`、`apps/debug/src/app.ts:359` |
| 主线程 | `ensureMainWasm()` 的结果存进 `mainWasmReady` | 主线程独占的 wasm 实例 | `apps/debug/src/app.ts:362` |
| 主线程 | `bindInput`：键盘绑 `window`、`mousemove`、点击请求 Pointer Lock、滚轮连跳、`resize`、`blur` 清键位 | 六处事件监听器 | `apps/debug/src/app.ts:1193`、`apps/debug/src/app.ts:1196`、`apps/debug/src/app.ts:1216`、`apps/debug/src/app.ts:1238`、`apps/debug/src/app.ts:1244`、`apps/debug/src/app.ts:1253` |
| 主线程 | 面板偏好：`loadUiPrefs` → `syncPrefsControls` → `applyCrosshairStyle` → `sendPrefsToWorker` → `bindUI` | `localStorage` 的 `vbsp:uiPrefs` → config → 控件与 Worker | `apps/debug/src/app.ts:369` |
| 主线程 | 初始控件状态（碰撞来源 / PVS 复选 / 物理模式） | 两个 `<select>` 与一个复选框 | `apps/debug/src/app.ts:375` |
| 主线程 | `startInputLoop()` 登记输入循环 | rAF 输入循环 | `apps/debug/src/app.ts:380` |
| Worker | 处理 `init` → 建 `ShmState`/`MsgState` → `onInit` 钩子回 `ready` | `MainMessage` 的 `ready` | `apps/debug/src/worker/main.ts:483` |
| 主线程 | `ready` 分支把状态栏改为「请加载 .bsp 文件」 | `#status` 文本 | `apps/debug/src/app.ts:393` |
| 用户 | 通过 `#bspFile` 选图（或拖拽 / 深链） | `File` → `ArrayBuffer` | `apps/debug/src/app.ts:1881` |
| 主线程 | `handleLoadBsp` → `buildWorldBundle(new BspProcessor(bytes), {...})` | 世界包：GLB 字节、brush/tri/spawn/teleport/pvs JSON、mosaic manifest、缺失纹理表 | `apps/debug/src/app.ts:1918` |
| 主线程 | `rendererMain.loadScene(sceneData)` | Three.js 场景 + LOD 注册 + PVS + 传送触发器 + lightmap 图集 | `apps/debug/src/app.ts:1955` |
| 主线程 | `rendererMain.buildPredictionWorld(...)` | 主线程渲染物理（`predPhys`）实例 | `apps/debug/src/app.ts:1957` |
| 主线程 | `setSpawnPoints` → `setPredictionParams` → `setPredictionHull` → `setPredictionNoclip` | 渲染物理的四项初始状态 | `apps/debug/src/app.ts:1967` |
| 主线程 | `inputBridge.sendWorldJson(...)` → Worker 新建权威 `PhysWorld` 并 `build_world` | `world-json` 消息 | `apps/debug/src/app.ts:1980` |
| 主线程 | `sendSetSpawnPoints(spawnList)` → `syncFullConfig()` | `set-spawn-points` 与逐段 `config` 消息 | `apps/debug/src/app.ts:1986`、`apps/debug/src/app.ts:1987` |
| 主线程 | `sceneReady = true`；填充出生点下拉 | `#spawnSelect` 的 `innerHTML` | `apps/debug/src/app.ts:2000`、`apps/debug/src/app.ts:2005` |
| Worker | `createAuthLoop` 按固定步长推进权威实例、每步发布一帧 | SAB 权威帧槽（回退通道则发 `phys-frame`） | `apps/debug/src/worker/main.ts:455` |

## 帧链/主循环

一个渲染帧由两条 rAF 循环加一条 Worker 定时循环组成，三者的注册顺序在主线程是**渲染先、输入后**（`RendererMain.start` 在 `startInputLoop` 之前调用：`apps/debug/src/app.ts:359` 早于 `apps/debug/src/app.ts:380`）。

**A. 渲染主循环**（`apps/debug/src/renderer/renderer-main.ts:662` 的 `tick`，内部顺序固定）：

1. 登记下一帧（`apps/debug/src/renderer/renderer-main.ts:664`）。
2. ① 物理段，仅当 `predReady` 且单步闸门有余量时执行（`apps/debug/src/renderer/renderer-main.ts:672`）：
   - 取本帧步长：回放模式取一次性 `replayDtS`，否则取墙钟间隔（首帧取 1/64，上限 0.1 秒），取走即置空（`apps/debug/src/renderer/renderer-main.ts:676`、`apps/debug/src/renderer/renderer-main.ts:680`）；
   - 本帧输入写共享内存输入槽（`apps/debug/src/renderer/renderer-main.ts:683`）；
   - 非回放模式下做权威帧校准与权威速度外推（`apps/debug/src/renderer/renderer-main.ts:685`、`apps/debug/src/renderer/renderer-main.ts:687`）；
   - 路径记录 tick 线：只在权威版本号 `va` 变化时落点，时间戳取发布时钟 τ（`apps/debug/src/renderer/renderer-main.ts:693` 起）；
   - 推进渲染物理 `predPhys.tick(dt, keys, dx, dy)`，随后清零鼠标增量（`apps/debug/src/renderer/renderer-main.ts:709`、`apps/debug/src/renderer/renderer-main.ts:710`）；
   - 消费 Rust 侧 `take_event`（`apps/debug/src/renderer/renderer-main.ts:713` → `apps/debug/src/renderer/renderer-main.ts:1419`）；
   - 取状态摆相机：渲染节点落 `PathRecorder`、写共享内存渲染采样、相机 yaw/pitch 与眼睛高度（`apps/debug/src/renderer/renderer-main.ts:721`、`apps/debug/src/renderer/renderer-main.ts:725`、`apps/debug/src/renderer/renderer-main.ts:727`、`apps/debug/src/renderer/renderer-main.ts:730`）；
   - 隔帧近平面探测（`apps/debug/src/renderer/renderer-main.ts:734`）。
3. ② 视距剔除：`LodManager.update` 返回真表示有块可见性翻转（`apps/debug/src/renderer/renderer-main.ts:746`）。
4. ③ 碰撞体 / 触发器 / 三角面 / chamfer 可视化（`apps/debug/src/renderer/renderer-main.ts:753`）。
5. ④ 准星射线：计数器满 `PLANE_INSPECT_INTERVAL` 才检测一次；关闭时清掉上次结果（`apps/debug/src/renderer/renderer-main.ts:760`）。
6. ⑤ 渲染：物理就绪后每帧都渲染（`apps/debug/src/renderer/renderer-main.ts:771`）。
7. ⑥ 剔除统计：至少间隔 100ms 下发一次（`apps/debug/src/renderer/renderer-main.ts:778`），经 `onCullStats` 落到 `#cullStats`（`apps/debug/src/app.ts:618`）。

**B. 输入循环**（`apps/debug/src/app.ts:2342` 的 `tick`）：

1. 登记下一帧并累计 FPS 计数，满 1 秒刷新一次（`apps/debug/src/app.ts:2343`、`apps/debug/src/app.ts:2346`）。
2. 未就绪（缺消息桥 / 渲染器 / 场景）直接返回（`apps/debug/src/app.ts:2351`）。
3. 本帧输入三选一：回放分支覆盖设备输入（`apps/debug/src/app.ts:2364`）、合成队列（`apps/debug/src/app.ts:2402`）、实时设备输入（`apps/debug/src/app.ts:2410` 起）。
4. `feedInput` 只喂一次（同一回放样本的第二个 rAF 窗口不重复喂，`apps/debug/src/app.ts:2434`）。
5. 回放跑完自动收尾；回放中与录制中按 100ms 节流刷新状态行（`apps/debug/src/app.ts:2437`、`apps/debug/src/app.ts:2440`）。
6. 计时挑战：物理模式下速度平方大于 1 时通知 `game.onPlayerMove()`（`apps/debug/src/app.ts:2446`）。
7. HUD 本地采样 10Hz：`updateStatsUI` 与 `updateGameStatsUI`（`apps/debug/src/app.ts:2454`、`apps/debug/src/app.ts:2458`）。

**C. Worker 权威循环**（`apps/debug/src/worker/main.ts:455` 装配的 `createAuthLoop`，每 4ms 唤醒一次）：

- 按绝对欠账排空固定步长，单次唤醒最多 64 步、欠账上限 250ms；每个真实步读一次输入、推进一步物理、发布一帧权威帧（`apps/debug/src/worker/main.ts:5` 起）。
- 每个真实步读一次输入、推进一步物理、发布一帧权威帧，并在着地上升沿或速度骤降时发 `phys-event`（`apps/debug/src/worker/main.ts:7`）。
- 渲染轨迹采样源把权威位置投影到主线程写来的渲染折线上（`apps/debug/src/worker/main.ts:308`）。
- 健康守护复用同一次取值调用，只读状态、只发 `health-log`（`apps/debug/src/worker/main.ts:383`、`apps/debug/src/worker/main.ts:460`）。

**三者的时间耦合**：

- 主线程渲染物理每帧推进一次，权威物理按固定步长推进；两者的对齐由 `correctFromAuthority` 与 `calibrateVelocity` 完成（`apps/debug/src/renderer/renderer-main.ts:1390`、`apps/debug/src/renderer/renderer-main.ts:1395`）。
- 权威帧的位置不是权威自身的 post-tick 位置，而是渲染折线上的采样点；主线程每帧写一条渲染采样，Worker 读它并取点（`apps/debug/src/renderer/renderer-main.ts:52` 起、`apps/debug/src/worker/main.ts:12`）。
- 路径记录的两条线因此可以按同一时间基准比较：tick 线用发布时钟 τ，渲染线用 rAF 时间戳（`apps/debug/src/renderer/renderer-main.ts:688` 起）。

## 消息与通道

通道二选一，由 `createMainSharedState` 决定（`apps/debug/src/app.ts:325`）：

- **SAB 通道**：主线程建 `SharedArrayBuffer`，输入槽、权威帧槽、渲染采样槽全走共享内存 + 原子操作。
- **postMessage 回退**：`sharedBuffer` 为 `null` 时建消息通道，逐帧输入走 `input` 消息、权威帧走 `phys-frame` 消息（`apps/debug/src/worker/worker-types.ts:46`）。

主线程渲染器只按 `SharedState` 类型持有通道，用到的三个方法以及各自语义见 `apps/debug/src/renderer/renderer-main.ts:55` 起的说明：`writeRenderSample`（写渲染采样）、`resetRenderSample`（世代 +1）、`readPublishedTau`（读发布时钟 τ）。

**主线程 → Worker**（联合类型 `WorkerMessage` 声明在 `apps/debug/src/worker/worker-types.ts:216`）：

| `type` | 载荷字段（以类型声明为准） | 备注 |
|---|---|---|
| `wasm-init` | `wasmB64?`、`wasmUrl?`、`mtzB64?` | `mtzB64` 只被暂存，Worker 侧无读取点（`apps/debug/src/worker/worker-types.ts:33`） |
| `init` | `shared`、`width`、`height`、`dpr` | 后三项在 Worker 侧无读取点；渲染在主线程（`apps/debug/src/worker/worker-types.ts:50`） |
| `input` | `dx`、`dy`、`keys` | 回退通道专用；运行时另有六个渲染采样字段未在接口中声明（`apps/debug/src/worker/worker-types.ts:61`） |
| `world-json` | `brushJson`、`triJson`、`teleportJson`、`spawn` | 前置条件：wasm 已就绪，否则整条丢弃（`apps/debug/src/worker/worker-types.ts:75`） |
| `config` | `section`、`patch` | `physics` / `input` 两段先做键名归一（`apps/debug/src/worker/worker-types.ts:91`） |
| `resize` | `width`、`height` | **无发送点、无接收分支**：窗口 `resize` 只调 `RendererMain.resize`（`apps/debug/src/worker/worker-types.ts:105`、`apps/debug/src/app.ts:1244`） |
| `respawn` | 无 | `apps/debug/src/worker/worker-types.ts:117` |
| `set-physics-param` | `name`、`value` | 由物理面板协调器处理（`apps/debug/src/worker/worker-types.ts:123`） |
| `reset-physics-param` | `name?` | 缺省 = 全部参数（`apps/debug/src/worker/worker-types.ts:130`） |
| `set-hull` | `hull.{halfWidth,standHeight,duckHeight}` | （`apps/debug/src/worker/worker-types.ts:136`） |
| `reset-hull` | 无 | （`apps/debug/src/worker/worker-types.ts:142`） |
| `set-auto-restore-hull` | `enabled` | 只改面板侧标记，不写物理（`apps/debug/src/worker/worker-types.ts:147`） |
| `set-cull-distance` | `value` | **Worker 侧无处理分支**，落到 `onExtraMessage` 后被丢弃；剔除由主线程执行（`apps/debug/src/worker/worker-types.ts:159`） |
| `teleport` | `target` | 出生点索引（`apps/debug/src/worker/worker-types.ts:165`） |
| `teleport-to-pos` | `pos`、`yaw?` | （`apps/debug/src/worker/worker-types.ts:171`） |
| `set-spawn-points` | `json` | 只决定 `teleport_to_spawn` 的可选目标（`apps/debug/src/worker/worker-types.ts:179`） |
| `sync-render-state` | `state.{posX,posY,posZ,yaw,pitch,velX,velY,velZ,onGround}` | 运行时另带 `teleport` 布尔，接口未声明；主线程的发送点在 `apps/debug/src/app.ts:348`（`apps/debug/src/worker/worker-types.ts:193`） |
| `set-death-threshold` | `value` | 记忆值在世界重建时自动重放（`apps/debug/src/worker/worker-types.ts:209`） |

联合类型之外还有两条只由分发层处理的运行时消息 `set-mode` 与 `set-hold`（`apps/debug/src/worker/worker-types.ts:214`）。

**Worker → 主线程**（联合类型 `MainMessage` 声明在 `apps/debug/src/worker/worker-types.ts:342`）：

| `type` | 载荷字段 | 消费点 / 备注 |
|---|---|---|
| `ready` | 无 | `apps/debug/src/app.ts:393` 更新状态栏（`apps/debug/src/worker/worker-types.ts:240`） |
| `phys-frame` | `va`、`frame.{pos,yaw,pitch,vel,onGround,eyeHeight,timeMs}` | 回退通道专用；主线程只读 `frame` 与 `va`（`apps/debug/src/worker/worker-types.ts:251`、`apps/debug/src/app.ts:400`） |
| `phys-event` | `kind`、`pos`、`yawDeg`、`pitchDeg`、`vel?`、`timeMs` | 对接 `applyCollisionCorrection`，其中只有 `kind` 与 `vel` 参与计算（`apps/debug/src/worker/worker-types.ts:281`、`apps/debug/src/app.ts:406`） |
| `physics-snapshot` | `params[]`、`hull`、`autoRestoreHull` | 回填面板并镜像到渲染物理（`apps/debug/src/worker/worker-types.ts:299`、`apps/debug/src/app.ts:410`） |
| `physics-event` | `event`、`message` | **无生产者**：全仓只有类型声明与 `apps/debug/src/app.ts:412` 的消费分支（`apps/debug/src/worker/worker-types.ts:319`） |
| `error` | `message` | 分发层的 wasm 实例化失败路径发出（`apps/debug/src/worker/worker-types.ts:327`、`apps/debug/src/app.ts:418`） |
| `health-log` | `message` | 写进面板「权威健康」控制台，上限 30 条（`apps/debug/src/worker/worker-types.ts:335`、`apps/debug/src/app.ts:415`） |

另有分发层会发的 `mode-ack`：未在联合中声明，主线程分派也没有对应分支（`apps/debug/src/worker/worker-types.ts:340`）。

## 异常与回退路径

| 失败点 | 回退路径 | 锚点 |
|---|---|---|
| 页面未处于跨源隔离（拿不到 `SharedArrayBuffer`） | 建 `MsgState` 消息通道，输入走 `input`、权威帧走 `phys-frame`；功能等价、延迟更高 | `apps/debug/src/app.ts:291`、`apps/debug/src/worker/worker-types.ts:46` |
| `file://` 下 module worker 不可用 | 构建产物内嵌 Worker 源码，改走 Blob URL 建 Worker | `apps/debug/src/app.ts:296` |
| 主线程 wasm 初始化失败 | 报错到错误条；同时把缓存的初始化 Promise 置回 `null`，下次调用重试 | `apps/debug/src/app.ts:362`、`apps/debug/src/main-wasm.ts:38` |
| 解析前主线程 wasm 尚未就绪 | `handleBspFile` 先 `await mainWasmReady` 且吞掉其失败，由下游 try 分支报错 | `apps/debug/src/app.ts:1884` |
| BSP 解析失败 | 报错到错误条并卸载旧场景（`disposeScene`） | `apps/debug/src/app.ts:1902` |
| 换图时的资源残留 | 解析前先 `disposeScene` 释放旧地图的 GPU 资源、LOD/PVS 与物理实例 | `apps/debug/src/app.ts:1891` |
| Worker 侧 wasm 实例化失败 | Worker 回 `error` 消息，主线程 `setError` 显示 | `apps/debug/src/app.ts:418` |
| 权威物理越界或渲染采样通道停滞 | Worker 的健康守护发 `health-log`；主线程写面板控制台（上限 30 条） | `apps/debug/src/worker/main.ts:383`、`apps/debug/src/app.ts:415` |
| 材质纹理缺失 | 打开确认弹窗，与默认纹理包比对后分成「可覆盖」与「缺失」两组展示 | `apps/debug/src/app.ts:442`、`apps/debug/src/app.ts:507` |
| 碰撞体导出失败 | `buildWorldBundle` 按 `colliderSource` 三档逐级回退：模型自带 `.phy` → 可视网格 → 空数组 | `apps/debug/src/config.ts:14` |
| 录制载荷缺 `meta.initialState` | 拒绝回放并告警，不进入回放态 | `apps/debug/src/app.ts:879` |
| 录制地图名与当前地图不符 | 只告警不阻断，结果由调用方判断 | `apps/debug/src/app.ts:885` |
| 全量种子写回失败 | 退化为九参部分对齐（`setPredictionState`） | `apps/debug/src/app.ts:831`、`apps/debug/src/renderer/renderer-main.ts:1288` |
| Pointer Lock 未锁定 | 键位掩码强制 0，防止 ESC 前后按键残留 | `apps/debug/src/app.ts:2415` |
| 窗口失焦导致 rAF 停摆 | 显式写一次 `addInput(0, 0, 0)` 清权威键位，并清渲染物理残留输入 | `apps/debug/src/app.ts:1253` |
| 窗口尺寸变化 | 直接调 `rendererMain.resize`（不经 `resize` 消息——该消息无收发链路） | `apps/debug/src/app.ts:1244` |
| 默认纹理包加载失败（下载或解压） | 返回 `null` 且不写缓存，下次调用重试；渲染侧的默认纹理回退不走本模块 | `apps/debug/src/default-pack.ts:22` |
