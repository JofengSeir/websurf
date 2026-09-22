# WebSurf-game 时序

## 启动时序

下表按 `main()` 的实际执行顺序排列；「数据落点」一列写明该步改变了哪份状态。

| 参与者 | 步骤 | 数据落点 | 锚点 |
|---|---|---|---|
| 浏览器 | 加载页面外壳，先取 `./coi-serviceworker.js`，再以 module script 取 `./app.js` | DOM；SW 负责给静态托管补 COOP/COEP | `apps/game/web/index.html:290`、`apps/game/web/index.html:291` |
| `main` | 取 `#preview` 画布；缺失即 `console.error` 并返回 | 无 | `apps/game/src/app.ts:95` |
| `main` | 读 `crossOriginIsolated`，据此决定能否建 `SharedArrayBuffer` | 局部 `sharedBuffer`（`null` 表示走 postMessage 回退） | `apps/game/src/app.ts:102`、`apps/game/src/app.ts:108`、`apps/game/src/app.ts:112` |
| `main` | `#status` 写兼容模式提示（仅在拿不到 SAB 时） | `#status` 文本 | `apps/game/src/app.ts:110` |
| `main` | 建权威 Worker：内嵌 `__VBSP_WORKER_JS__` 走 Blob URL，否则装载 `./worker.js` | `fixWorker` | `apps/game/src/app.ts:117`、`apps/game/src/app.ts:118`、`apps/game/src/app.ts:120` |
| `main` → Worker | 发 `init`（只带 `type` 与 `shared`） | Worker 侧 `shared.current` 槽 | `apps/game/src/app.ts:148` |
| `main` → Worker | 发 `wasm-init`：内嵌 base64 分支或 URL 分支 | Worker 侧 wasm 实例与权威时钟启动 | `apps/game/src/app.ts:152`、`apps/game/src/app.ts:154` |
| `main` | `createMainSharedState(sharedBuffer, fixWorker)` 建本端通道对象 | `sharedState` | `apps/game/src/app.ts:158` |
| `main` | 建 `RendererMain` 并注册两个回调（`onSceneLoaded`、`onSyncRenderState`） | `renderer`；死亡阈值回调 | `apps/game/src/app.ts:162`、`apps/game/src/app.ts:163`、`apps/game/src/app.ts:166` |
| `main` | `renderer.init(...)` 后 `start()`：写光照 uniform 初值、建 renderer/scene/camera、起 rAF | three 的 renderer / scene / camera；光照共享 uniform | `apps/game/src/app.ts:169`、`apps/game/src/app.ts:170` |
| `main` | `installFrameProbe()`：挂 `globalThis.__vbspFrameProbe` | `globalThis` 一个对象 | `apps/game/src/app.ts:173` |
| `main` | `initPrediction('./websurf_wasm_bg.wasm', embeddedWasm)`：内嵌走 `initSync`，否则 `fetch` | 主线程 wasm 实例；`mainWasmReady` promise | `apps/game/src/app.ts:176`、`apps/game/src/renderer/renderer-main.ts:671` |
| `main` | 建 `InputBridge`，随后 `syncFullConfig()` 按四段各发一条 `config` | `bridge`；Worker 与本端 config 副本 | `apps/game/src/app.ts:181`、`apps/game/src/app.ts:182` |
| `main` | 建 `PanelController`：加载偏好 → 回写控件 → 全量下发 → 应用准星 | 面板 DOM；`config`；localStorage | `apps/game/src/app.ts:185`、`apps/game/src/panel/panel-controller.ts:82` |
| `main` | `initKeyHud()` → `bindInput()` → `startInputLoop()` | 键簇标签；DOM 事件；rAF 输入循环 | `apps/game/src/app.ts:219`、`apps/game/src/app.ts:220`、`apps/game/src/app.ts:221` |
| 用户 | 点 `#loadMapBtn` → 隐藏的 `#bspFile` → `change` 事件 | `File` 字节 | `apps/game/src/app.ts:317`、`apps/game/src/app.ts:321` |
| `handleLoadBsp` | 记录地图名、载入该地图存点、收起面板、等主线程 wasm 就绪 | `currentMapName`；`savePointStore`；面板可见性 | `apps/game/src/app.ts:501`、`apps/game/src/app.ts:502`、`apps/game/src/app.ts:507` |
| `handleLoadBsp` | 释放上一张图 → `buildWorldBundle(...)` 解析并导出 | 场景释放；`WorldBundle` | `apps/game/src/app.ts:508`、`apps/game/src/app.ts:514` |
| `handleLoadBsp` | `renderer.loadScene({...})`：GLB + spawn + PVS + mosaic manifest | three 场景；死亡阈值回调 | `apps/game/src/app.ts:521` |
| `handleLoadBsp` | `renderer.buildPredictionWorld({...})`：主线程渲染物理世界 | `predPhys` | `apps/game/src/app.ts:536`、`apps/game/src/renderer/renderer-main.ts:689` |
| `handleLoadBsp` → Worker | 发 `world-json`（三段 JSON + spawn） | Worker 侧权威实例 | `apps/game/src/app.ts:558` |
| `handleLoadBsp` | 双端出生点列表：渲染端 `setSpawnPoints` + Worker `set-spawn-points` | 两端出生点列表 | `apps/game/src/app.ts:570`、`apps/game/src/app.ts:571` |
| `handleLoadBsp` | 再 `syncFullConfig()`（世界重建后参数重放） | Worker 侧 `set_params` / `set_hull` | `apps/game/src/app.ts:573`、`apps/game/src/worker/main.ts:88` |
| `handleLoadBsp` | `sceneReady = true`；填 `#spawnSelect`；启用 `#respawnBtn`；隐藏进度覆盖层 | 场景就绪标志；下拉与按钮 | `apps/game/src/app.ts:575`、`apps/game/src/app.ts:582`、`apps/game/src/app.ts:594`、`apps/game/src/app.ts:596` |

## 帧链/主循环

一帧由两条互不阻塞的循环组成，二者只经通道交换输入与帧。

主线程侧（`RendererMain.tick`，rAF 驱动）：

1. 续帧并取景：`requestAnimationFrame(this.boundTick)`，renderer/scene/camera 任一缺失即返回（`apps/game/src/renderer/renderer-main.ts:924`、`apps/game/src/renderer/renderer-main.ts:925`）。
2. 物理分支开门条件 `predReady && predPhys`（`apps/game/src/renderer/renderer-main.ts:928`）；`dt` 取与上一物理帧的间隔，首个物理帧取 1/64 秒、上限 0.1 秒（`apps/game/src/renderer/renderer-main.ts:929`）。
3. 写共享输入槽：`shared.addInput(pendingDx, pendingDy, pendingKeys)`（`apps/game/src/renderer/renderer-main.ts:932`）——本工程唯一的输入写入点。
4. 消费权威帧与校准速度：`correctFromAuthority()` 后 `calibrateVelocity(now)`（`apps/game/src/renderer/renderer-main.ts:934`、`apps/game/src/renderer/renderer-main.ts:936`）。
5. 推进主线程渲染物理：`predPhys.tick(dt, keys, dx, dy)`，随后把 dx/dy 清零（键位保留为按住状态）（`apps/game/src/renderer/renderer-main.ts:938`、`apps/game/src/renderer/renderer-main.ts:939`）。
6. 冻结分支：按住 C 期间每帧把物理写回存点位姿并把速度清零（`apps/game/src/renderer/renderer-main.ts:942`）。
7. 取物理状态写渲染采样：`writeRenderSample(now, posX, posY, posZ, renderSampleIndex++)`，不传世代（`apps/game/src/renderer/renderer-main.ts:955`）。
8. 相机跟随物理：角度按度转弧度写入 `rotation`（YXZ），位置 y 加 `eyeHeight`（`apps/game/src/renderer/renderer-main.ts:957`、`apps/game/src/renderer/renderer-main.ts:958`）。
9. 每 2 帧一次近平面自适应（`apps/game/src/renderer/renderer-main.ts:961`）。
10. 剔除：按 `cullDistance` 改 `mesh.visible`；PVS 分支由常量门控（`apps/game/src/renderer/renderer-main.ts:977`、`apps/game/src/renderer/renderer-main.ts:113`）。
11. 绘制 `renderer.render(scene, camera)`；首帧后跑一次注入生效性统计（`apps/game/src/renderer/renderer-main.ts:998`、`apps/game/src/renderer/renderer-main.ts:1001`）。

主线程输入循环（`startInputLoop` 的 rAF，与渲染循环相互独立）：

1. 每秒刷新 `#fps`（`apps/game/src/app.ts:391`）。
2. 未就绪（`!bridge || !sceneReady`）直接返回（`apps/game/src/app.ts:396`）。
3. 未锁定时强制掩码为 0（`apps/game/src/app.ts:400`）；`updateKeyHud` 只在掩码变化时写 DOM（`apps/game/src/app.ts:401`）。
4. 滚轮跳并入本帧掩码后立即清零待消费标志（`apps/game/src/app.ts:403`、`apps/game/src/app.ts:404`）。
5. Q/E 转向折算等效鼠标增量，与真实鼠标走同一 `feedInput` 通道（`apps/game/src/app.ts:409`、`apps/game/src/app.ts:413`）。
6. 速度面板按 125ms 门控刷新（`apps/game/src/app.ts:415`、`apps/game/src/app.ts:424`）。

Worker 侧（`createAuthLoop`，定时器唤醒 + 固定步长累积器）：

1. 每个真实步长先取一次 `getPhys`：`rtTickGate()` 做唤醒边界探测、`healthProbe()` 复用同一次调用（自带节流）（`apps/game/src/worker/main.ts:457`）。
2. 单个步长的顺序由共享层固定：先 `takeInput` 消费输入、再推进物理、最后 `writeAuthoritative`（`src/ts-shared/auth/auth-loop.ts:22`、`src/ts-shared/auth/auth-loop.ts:382`、`src/ts-shared/auth/auth-loop.ts:431`）。
3. 步长由 tickRate 折算：`getConfigTickRate()` 读 Worker 自己那份 config 的 `physics.tickRate`（`apps/game/src/worker/main.ts:468`），`setFixedDt` 初值 1/64 秒、未变时返回 false（`src/ts-shared/auth/auth-loop.ts:252`、`src/ts-shared/auth/auth-loop.ts:532`）。
4. 发布位置可被渲染轨迹投影替换：`renderTrajectorySource`（`apps/game/src/worker/main.ts:302`）在渲染折线上按 τ 取点（`apps/game/src/worker/main.ts:284`），跨世代或配对陈旧时返回 `null`、回退权威自身位置（`apps/game/src/worker/main.ts:287`、`apps/game/src/worker/main.ts:291`）。
5. 碰撞事件经 `post` 出口发出（`apps/game/src/worker/main.ts:458`），主线程在 `phys-event` 分支转给 `RendererMain.applyCollisionCorrection`（`apps/game/src/app.ts:141`、`apps/game/src/renderer/renderer-main.ts:859`）。

## 消息与通道

通道有两种实现，由 `createMainSharedState` 在启动期择一（`src/ts-shared/auth/shared-state.ts:1022`）：**SAB 通道**（`ShmState`，`src/ts-shared/auth/shared-state.ts:568`）与 **postMessage 回退**（`MsgState`，`src/ts-shared/auth/shared-state.ts:259`）。共享缓冲长度由 `SHARED_BUFFER_SIZE` 给定（`src/ts-shared/auth/shared-state.ts:209`）。SAB 通道下输入与权威帧走共享槽、不走消息；回退通道下二者分别走 `input` 与 `phys-frame` 消息。

消息分派实现在共享层，`apps/game/src/worker/main.ts` 只做两件事：先给自己的 `world-json` 打诊断计时，再把事件整体交给 `dispatch`（`apps/game/src/worker/main.ts:506`、`apps/game/src/worker/main.ts:508`、`apps/game/src/worker/main.ts:520`）。

主线程 → Worker（载荷字段以 `apps/game/src/worker/worker-types.ts` 的类型声明为准，实际收发点见表内第二组）：

| type | 类型声明的载荷 | 声明锚点 | 实际发送点 | 声明与实际是否一致 |
|---|---|---|---|---|
| `wasm-init` | `{ type, wasmUrl? }` | `apps/game/src/worker/worker-types.ts:25` | `apps/game/src/app.ts:152`（`wasmB64`）、`apps/game/src/app.ts:154`（`wasmUrl`） | **不一致**：分发器接受 `wasmB64` / `wasmUrl` / `mtzB64` 三者（`src/ts-shared/auth/worker-dispatch.ts:297`），声明只列了 `wasmUrl` |
| `init` | `{ type, shared, width, height, dpr }` | `apps/game/src/worker/worker-types.ts:33` | `apps/game/src/app.ts:148`（只发 `type` 与 `shared`） | **不一致**：`width` / `height` / `dpr` 既无发送方也无读取点，分发器只读 `shared`（`src/ts-shared/auth/worker-dispatch.ts:270`） |
| `config` | `{ type, section, patch }` | `apps/game/src/worker/worker-types.ts:51` | `apps/game/src/input/input-bridge.ts:46`、`:53`、`:65` | 一致（段名与实际下发载荷的口径差异见下条） |
| `respawn` | `{ type }` | `apps/game/src/worker/worker-types.ts:58` | `apps/game/src/input/input-bridge.ts:71` | 一致 |
| `teleport` | `{ type, target }` | `apps/game/src/worker/worker-types.ts:63` | `apps/game/src/input/input-bridge.ts:77` | 一致 |
| `set-death-threshold` | `{ type, value }` | `apps/game/src/worker/worker-types.ts:70` | `apps/game/src/input/input-bridge.ts:86` | 一致 |
| `load-bsp` | `{ type, name, data }` | `apps/game/src/worker/worker-types.ts:43` | 无发送方 | **无发送方也无分发分支**：地图装载在主线程完成 |
| `world-json` | `{ type, brushJson, triJson, teleportJson, spawn }` | `apps/game/src/worker/worker-types.ts:171` | `apps/game/src/app.ts:558` | 类型声明位置在「Worker → 主线程」分组里，实际方向相反（分发器在 `src/ts-shared/auth/worker-dispatch.ts:304` 接收） |
| `input` | `{ type, dx, dy, keys }` | `apps/game/src/worker/worker-types.ts:182` | 无直接发送点（由 `MsgState.addInput` 发出） | 声明只列三个必填字段；回退通道实现还会附带渲染采样六字段（`src/ts-shared/auth/worker-dispatch.ts:280`） |

Worker → 主线程：

| type | 类型声明的载荷 | 声明锚点 | 实际接收点 | 声明与实际是否一致 |
|---|---|---|---|---|
| `health-log` | `{ type, message }` | `apps/game/src/worker/worker-types.ts:155` | `apps/game/src/app.ts:134` | 一致（发送方是 `apps/game/src/worker/main.ts:365` 的 `postHealth`） |
| `error` | `{ type, message }` | `apps/game/src/worker/worker-types.ts:148` | `apps/game/src/app.ts:136` | 一致（发送方在共享层分发器的 `wasm-init` 失败分支，`src/ts-shared/auth/worker-dispatch.ts:299`） |
| `phys-event` | `{ type, kind, pos, yawDeg, pitchDeg, vel?, timeMs }` | `apps/game/src/worker/worker-types.ts:211` | `apps/game/src/app.ts:138` | 一致 |
| `phys-frame` | `{ type, va, frame: {...} }` | `apps/game/src/worker/worker-types.ts:193` | `apps/game/src/app.ts:142` | 一致；仅 postMessage 回退通道使用 |
| `world-build-ms` | 未声明 | 无 | `apps/game/src/app.ts:125` | **缺声明**：发送方 `apps/game/src/worker/main.ts:486` |
| `world-parse-ms` | 未声明 | 无 | `apps/game/src/app.ts:128` | **缺声明**：发送方 `apps/game/src/worker/main.ts:518` |
| `mode-ack` | 未声明 | 无 | 本工程无接收点 | 分发器在 `src/ts-shared/auth/worker-dispatch.ts:534` 发出；本工程不发 `set-mode`，故不会收到 |

两个联合类型的成员集都与实际收发不符：`WorkerMessage`（`apps/game/src/worker/worker-types.ts:78`）未列入 `input`、`world-json`、`sync-render-state`、`set-spawn-points`、`teleport-to-pos`、`set-mode`、`set-hold` 七条在用的消息，却列入了没有发送方的 `LoadBspMessage`；`MainMessage`（`apps/game/src/worker/worker-types.ts:226`）未列入 `phys-frame`、`mode-ack`、`world-build-ms`、`world-parse-ms`，且把方向相反的 `WorldJsonMessage` 列入其中。类型面只作形状记录：分发器按 `type` 字符串分派，不做运行时校验（`src/ts-shared/auth/worker-dispatch.ts:265`）。

`KeyState` 的字段集在两侧同名同型：本工程声明在 `apps/game/src/worker/worker-types.ts:243`，共享层的位掩码与转换在 `src/ts-shared/auth/shared-state.ts:67` 的 `KEY_MASK` 与 `src/ts-shared/auth/shared-state.ts:81` 的 `keysToMask`；本工程不另设位常量。

## 异常与回退路径

| 失败点 | 回退行为 | 锚点 |
|---|---|---|
| 页面拿不到 `crossOriginIsolated` / `SharedArrayBuffer` | 输入与权威帧落到 **postMessage 回退**：`sharedBuffer` 传 `null`，`createMainSharedState` 返回 `MsgState`；`#status` 显示兼容模式提示 | `apps/game/src/app.ts:108`、`apps/game/src/app.ts:110`、`apps/game/src/app.ts:158`、`src/ts-shared/auth/shared-state.ts:1022` |
| module worker 在 `file://` 下被 CORS 拒绝 | single 产物把 Worker 代码内嵌为 `__VBSP_WORKER_JS__`，启动时走 Blob URL 装载 | `apps/game/src/app.ts:117`、`apps/game/src/app.ts:119` |
| `file://` 下无法 `fetch` wasm | single 产物内嵌 `__VBSP_WASM_B64__`，两条路径都走 `initSync` | `apps/game/src/app.ts:150`、`apps/game/src/renderer/renderer-main.ts:671` |
| Worker 内 wasm 实例化失败 | 分发器把异常转成 `error` 消息回主线程（`ready` 保持 false），主线程经 `#error` 显示 | `src/ts-shared/auth/worker-dispatch.ts:299`、`apps/game/src/app.ts:136`、`apps/game/src/app.ts:823` |
| `world-json` 在 wasm 就绪前到达 | 分发器直接丢弃该消息 | `src/ts-shared/auth/worker-dispatch.ts:311` |
| 主线程 wasm 初始化失败 | `initPrediction` 的 rejection 被 `catch` 转成错误提示；后续 `handleLoadBsp` 仍会 `await mainWasmReady.catch(...)` 继续（纹理回退降级为占位色） | `apps/game/src/app.ts:176`、`apps/game/src/app.ts:507` |
| BSP 解析或场景装载抛错 | `handleLoadBsp` 的 `catch` 里显示错误、释放场景、进度覆盖层转错误态（不消失） | `apps/game/src/app.ts:598`、`apps/game/src/app.ts:601`、`apps/game/src/app.ts:602` |
| GLB 未携带 lightmap atlas | `loadLightmapAtlas` 返回 `null`，`applyLightmap` 只打日志并跳过整段光照施加；地图仍是贴图原色 | `apps/game/src/renderer/renderer-main.ts:1240`、`apps/game/src/renderer/renderer-main.ts:1242` |
| 光照注入锚点失配 | `reportInjectStatsOnce` 在「有失效材质且一条注入都没生效」时置 `globalThis.__vbspLightmapInjectFailed` 并打 error（出帧脚本据此非零退出）；部分失效只告警 | `apps/game/src/renderer/renderer-main.ts:1176`、`apps/game/src/renderer/renderer-main.ts:1181` |
| mosaic 贴图替换失败 | 只告警，保留原贴图（`map.dispose()` 之后才写新 image，失败时纹理未被替换） | `apps/game/src/renderer/renderer-main.ts:505` |
| 预编译着色器失败 | 只告警，three 仍按需编译 | `apps/game/src/renderer/renderer-main.ts:390` |
| 页面失焦（rAF 停摆） | 显式写 `keysMask=0` 清权威键位并清本端待喂输入 | `apps/game/src/app.ts:300`、`apps/game/src/app.ts:306`、`apps/game/src/app.ts:307` |
| 退锁（ESC 打开面板） | 键盘禁用并复位、清渲染物理待喂输入、清滚轮跳待消费标志；权威键位由下一帧输入循环写 0 兜底 | `apps/game/src/app.ts:279`、`apps/game/src/app.ts:282`、`apps/game/src/app.ts:287`、`apps/game/src/app.ts:290` |
| 指针锁定请求失败 | `requestLock` 返回的 promise 落 false 时写状态行提示重试 | `apps/game/src/app.ts:252`、`apps/game/src/app.ts:255` |
| 权威状态非有限值或 y 越过地板 | 只发 `health-log` 告警：不 respawn、不改权威状态、不碰渲染（原因写在同处） | `apps/game/src/worker/main.ts:402`、`apps/game/src/worker/main.ts:409` |
| 权威发布停滞或渲染采样停滞 | 各只告警一次，直到版本号 / 序号重新前进才复位 | `apps/game/src/worker/main.ts:432`、`apps/game/src/worker/main.ts:445` |
| 渲染采样配对跨世代或陈旧 | `rtServeEpochOk` 复检失败即丢弃配对、本 tick 不投影，回退权威自身位置 | `apps/game/src/worker/main.ts:273`、`apps/game/src/worker/main.ts:291` |
| 存点读写 localStorage 失败 | 读失败打 `console.error` 并清空内存列表；写失败打 `console.error` 且不影响内存列表 | `apps/game/src/savepoint.ts:62`、`apps/game/src/savepoint.ts:114` |
| 面板偏好版本不匹配 | 不合并存档内容，以当前 config（默认值）写回新版本档 | `apps/game/src/panel/panel-controller.ts:651`、`apps/game/src/panel/panel-controller.ts:657` |
| 键位持久化读失败 | 回落到默认表的深拷贝（逐动作合并，允许空数组即禁用该动作） | `apps/game/src/input/keymap.ts:56`、`apps/game/src/input/keymap.ts:64` |
