# WebSurf-viewer：主流程时序

> 参与者只有四类：浏览器页面、主线程（`apps/viewer/src/app.ts` 及其调用的模块）、解析 Worker（`apps/viewer/src/worker/main.ts`）、WASM 模块（`apps/viewer/crates/wasm` 的 `BspProcessor`）。本工程**不参与**共享内存通道：不建 `SharedArrayBuffer`，`crossOriginIsolated` 只打印供核对（`apps/viewer/src/app.ts:39`）。

---

## 启动时序

| 参与者 | 步骤 | 数据落点 | 锚点 |
|---|---|---|---|
| 浏览器 | 取 `/web/index.html`（dev 由 `src/serve.py` 在 8100 端口服务） | 页面骨架：`#game` / `#fatal` / `#guide` / `#dropzone` / `#hud` / `#telemetry` / `#topbar` / `#help` / `#sidebar` / `#dock` | `apps/viewer/web/index.html:12`、`apps/viewer/package.json:18` |
| 浏览器 | 以 module script 加载 `./app.js` | 模块顶层开始执行 | `apps/viewer/web/index.html:111` |
| 主线程 | 取 `canvas#game`，取不到即抛错 | `gameCanvas` | `apps/viewer/src/app.ts:33` |
| 主线程 | 打印 `crossOriginIsolated`，仅作部署环境参考 | 控制台一行 | `apps/viewer/src/app.ts:39` |
| 主线程 | `new Hud()`：一次性取 11 个元素句柄（取不到即 null，各方法逐个判空） | `Hud` 的只读字段 | `apps/viewer/src/ui/hud.ts:22` |
| 主线程 | `new ViewerScene(canvas)`：建 WebGL 渲染器 → 写静态光照共享 uniform → 建场景/相机 → 加三点光 | three 渲染器、`THREE.Scene`、`PerspectiveCamera` | `apps/viewer/src/core/scene.ts:94`、`apps/viewer/src/core/scene.ts:110` |
| 主线程 | `new FlyCam()` 并 `attach(canvas)`：注册 click / pointerlockerror / pointerlockchange / mousemove / keydown / keyup / blur 七类监听 | 全局监听器与相机内部状态 | `apps/viewer/src/core/fly.ts:84` |
| 主线程 | 取侧栏、dock、时间轴、遥测句柄；绑侧栏折叠与标签页切换 | DOM 类名 `hidden` / `active` / `full` | `apps/viewer/src/app.ts:64`、`apps/viewer/src/app.ts:78` |
| 主线程 | `new MapPanel(#pane-map, onJump, onLightingMode)`：建「更换地图」行、光照模式分区、地图信息分区、出生点导航分区 | `#pane-map` 子树 | `apps/viewer/src/ui/mapinfo.ts:52` |
| 主线程 | `new ReplayImporter()` / `new ReplayPlayer()` / `new ReplayVisuals(scene)` | 导入器、播放器、可视化三个对象 | `apps/viewer/src/app.ts:124` |
| 主线程 | `new ReplayPanel(#pane-replay, importer, player, opts)`：读持久化规则 → 建导入 / 轨迹列表 / 坐标映射 / 调整工具四段 | `#pane-replay` 子树、`localStorage` 键 `websurf-viewer.replay-rule.v2` | `apps/viewer/src/replay/panel.ts:74`、`apps/viewer/src/replay/panel.ts:187` |
| 主线程 | `new ReplayMetaPanel` / `new Timeline` / `new TelemetryHud`（按键簇挂 `#timeline` 右列） | `#replayMeta`、`#timeline`、`#telemetry` | `apps/viewer/src/app.ts:170`、`apps/viewer/src/ui/telemetry.ts:88` |
| 主线程 | 挂 `globalThis.viewer`（`map` 与 `replay` 两个 getter） | 全局对象，供外部脚本与 headless 断言 | `apps/viewer/src/app.ts:352` |
| 主线程 | 异步 `loadUrlAssets()`：`?bsp=` 走 `fetch` + `loadBsp`，`?replay=` 先嗅探再交给面板 | 深链资源进 `File` 对象 | `apps/viewer/src/app.ts:433` |
| 主线程 | 首刷位姿读数并 `requestAnimationFrame(frame)` | 主循环启动 | `apps/viewer/src/app.ts:523` |
| 用户 | 点引导按钮 / 换图入口 / 拖入文件 → `#bspFile` 的 change 或 drop → `loadBsp(file)` | `bspLoading` 与 busy 类 | `apps/viewer/src/app.ts:316`、`apps/viewer/src/app.ts:239` |
| 主线程 + WASM | `ensureWasm()` → `new BspProcessor(bytes)` → `metadata()` → `parse_spawn_points()` → `export_glb_with_pakfile_models()`（顺序被借用语义固死） | `BspLoadResult`：meta / spawnPoints / primary / glbBytes / elapsedMs | `apps/viewer/src/core/bsp.ts:116`、`apps/viewer/src/core/bsp.ts:121` 到 `apps/viewer/src/core/bsp.ts:125` |
| 主线程 | `scene.mountGlb(glbBytes)`：GLTFLoader 解析 → 施加静态光照 → 空间分块合并 → `fitCamera` | `modelRoot`（新根 Group）、相机 near/far | `apps/viewer/src/core/scene.ts:175`、`apps/viewer/src/core/scene.ts:204` |
| 主线程 | `resolveInitialSpawn(spawnPoints, primary, box)` 定初始视角；`mapPanel.setMap(...)` 填面板；`updateReplayMapStatus()` 做贴合检查 | `currentBox`、`lastSpawnSource`、面板 DOM | `apps/viewer/src/app.ts:261`、`apps/viewer/src/core/spawn.ts:96` |
| 用户 | 面板文件框 / 拖入 `.replay` / 深链 → `ReplayPanel.loadFile(file)` | `file` 字段、`lastTrackId` 清空为 null | `apps/viewer/src/replay/panel.ts:261` |
| 主线程 | `runImport(true)` → `importer.import(file, rule, name, onProgress)` | `busy` 置真 | `apps/viewer/src/replay/panel.ts:293` |
| Worker 或主线程 | 嗅探魔数 → 取字节（命中同一文件句柄则复用缓存）→ `parseShavitReplay` → `clipFromShavitReplay` | `ShavitParseResult` → `Clip`（定型数组 + meta + buttons） | `apps/viewer/src/replay/importer.ts:144`、`apps/viewer/src/replay/shavit-replay.ts:569` |
| 主线程 | `onClip` → `replaceClip` 或 `addTrack` → `player.mode = 'first'` → `syncTracks()` | `TrackSet`、3D 对象、时间轴、信息条、遥测 HUD | `apps/viewer/src/app.ts:141` 到 `apps/viewer/src/app.ts:153`、`apps/viewer/src/app.ts:130` |

## 帧链/主循环

| 参与者 | 动作 | 锚点 |
|---|---|---|
| `requestAnimationFrame` 回调 | 先重排下一帧，再算帧间隔 dt（上限 0.05 s，即 50 ms） | `apps/viewer/src/app.ts:478` 到 `apps/viewer/src/app.ts:481` |
| `ReplayPlayer` | `update(dt)`：未播放或无轨道直接返回；推进主时钟 `time += dt × speed`，越过区间末端时按 `loop` 回绕或停在末端并暂停 | `apps/viewer/src/replay/player.ts:193` |
| `ReplayPlayer` | `clip` 非空时取跟随轨道的插值位姿 `sample()`（二分定位 + 线性插值） | `apps/viewer/src/app.ts:484`、`apps/viewer/src/replay/player.ts:221` |
| 相机（回放第一人称） | `fly.drivesCamera = false`、`fly.allowMove = false`；`fly.setWorld(pos, yaw, pitch, roll)` 后 `fly.applyToWithRoll(camera)` | `apps/viewer/src/app.ts:486` 到 `apps/viewer/src/app.ts:497` |
| 相机（自由飞行） | `fly.roll = 0`；`drivesCamera` / `allowMove` 置真；`fly.update(dt)` 消化鼠标增量与按键位移后 `fly.applyTo(camera)` | `apps/viewer/src/app.ts:499` 到 `apps/viewer/src/app.ts:503` |
| 可视化 | `visuals.update(player.sampleAll(), mode, followId)`：按 `Track.visible` 与三个显示开关定各对象显隐，再给幽灵写位置与 `'YXZ'` 序旋转 | `apps/viewer/src/app.ts:507`、`apps/viewer/src/replay/visuals.ts:69` |
| 场景 | `scene.render()`：每 2 帧做一次近平面自适应（`nearCheckToggle` 交替），再交 three 绘制 | `apps/viewer/src/core/scene.ts:157` 到 `apps/viewer/src/core/scene.ts:163` |
| HUD 节流刷新 | 距上次刷新 ≥ 80 ms 时刷新位姿读数行、`timeline.refresh()`、`telemetry.update(sample, buttons)` | `apps/viewer/src/app.ts:510` 到 `apps/viewer/src/app.ts:519` |
| 输入（键盘） | `Timeline` 的全局 `keydown`：K 播放/暂停、`,` / `.` 逐帧、I / O 设区间；输入控件持焦点时全部不响应 | `apps/viewer/src/replay/timeline.ts:195`、`apps/viewer/src/replay/timeline.ts:354` |
| 输入（鼠标/键盘，飞行） | `FlyCam` 只在 `locked` 为真时消化 mousemove 与位移键；`blur` 与解锁清空增量与按键集合 | `apps/viewer/src/core/fly.ts:107`、`apps/viewer/src/core/fly.ts:127` |
| resize 事件 | `scene.resize(gameCanvas)` 重设渲染尺寸与相机 aspect | `apps/viewer/src/app.ts:473`、`apps/viewer/src/core/scene.ts:151` |

## 消息与通道

本工程只有一条 postMessage 通道：**主线程 ↔ 录像解析 Worker**。协议类型单点在 `apps/viewer/src/replay/protocol.ts`，两侧实现分别是 `apps/viewer/src/replay/importer.ts` 的 `ReplayImporter` 与 `apps/viewer/src/worker/main.ts`。

| 方向 | 消息（以类型声明为准） | 载荷字段 | 锚点 |
|---|---|---|---|
| 主线程 → Worker | `ParseRequest` | `id:number`、`type:'import'`、`file:File \| null`、`rule:RuleConfig`、`name:string` | `apps/viewer/src/replay/protocol.ts:29` 到 `apps/viewer/src/replay/protocol.ts:40` |
| Worker → 主线程 | `ParseResponse` 的 `progress` 分支 | `phase:'parse' \| 'map'`、`done`、`total` | `apps/viewer/src/replay/protocol.ts:47` |
| Worker → 主线程 | `ParseResponse` 的 `done` 分支 | `payload:ClipPayload`、`warnings:string[]`、`resolvedPath:string` | `apps/viewer/src/replay/protocol.ts:48` |
| Worker → 主线程 | `ParseResponse` 的 `error` 分支 | `message:string` | `apps/viewer/src/replay/protocol.ts:49` |
| （载荷定义） | `ClipPayload` | `name` / `count` / `t` / `pos` / `ang` / `vel` / `duration` / `bbox` / `maxSpeed` / `resolvedPath` / `buttons` / `meta` 共 12 项 | `apps/viewer/src/replay/protocol.ts:12` 到 `apps/viewer/src/replay/protocol.ts:27` |

字段级的实测情况：

- **`id` 是配回 pending 表的唯一键**：请求侧自增（`apps/viewer/src/replay/importer.ts:144`），响应侧按 `msg.id` 找到 resolver，`progress` 不结算、其余分支删表并结算（`apps/viewer/src/replay/importer.ts:93` 到 `apps/viewer/src/replay/importer.ts:100`）。
- **`file` 声明允许 null**（`apps/viewer/src/replay/protocol.ts:35`）：null 的语义是「复用上一份文件的字节缓存」。本仓唯一调用点传的是非空字段（`apps/viewer/src/replay/panel.ts:293` 传 `this.file`，而 `runImport` 在 `apps/viewer/src/replay/panel.ts:282` 已挡掉 null），Worker 侧写的是 `req.file ?? cachedNativeFile`（`apps/viewer/src/worker/main.ts:56`）。
- **进度阶段只有 `'parse'`**：Worker 发 0/1 与 1/1 两条（`apps/viewer/src/worker/main.ts:66`、`apps/viewer/src/worker/main.ts:84`），主线程回退路径在同一位置发同样的两条（`apps/viewer/src/replay/importer.ts:191`、`apps/viewer/src/replay/importer.ts:204`）；`'map'` 阶段没有任何发送方。
- **回包走 transfer 列表**：`t` / `pos` / `ang` 的 buffer 必进，`vel` / `buttons` 存在才进（`apps/viewer/src/worker/main.ts:88` 到 `apps/viewer/src/worker/main.ts:90`），发送后这些 buffer 在 Worker 侧不可再用。
- **`Clip.id` 与 `Clip.rule` 不在载荷里**：由主线程 `payloadToClip` 本地补（`apps/viewer/src/replay/importer.ts:220`）。
- **`ImportResult.resolvedPath` 无读取点**：Worker 回包的 `resolvedPath` 被透传进结果对象（`apps/viewer/src/replay/importer.ts:150`），而 `apps/viewer/src` 内没有消费该字段的地方。
- **`TrackPanelOptions.onPresence` 无发送方**：该可选回调每次 `refresh` 都会被 `?.` 调用（`apps/viewer/src/replay/trackpanel.ts:119`），但 `ReplayPanel` 构造 `TrackPanel` 时只传了 `onChange` 与 `onCleared`（`apps/viewer/src/replay/panel.ts:105` 到 `apps/viewer/src/replay/panel.ts:108`），故它永不触发。

主线程内部不使用消息，全部是直接方法调用：`ReplayPanelOptions` 的四个回调（`apps/viewer/src/replay/panel.ts:34` 到 `apps/viewer/src/replay/panel.ts:40`）由 `apps/viewer/src/app.ts:141` 提供；`Timeline` 直接持有 `ReplayPlayer` 与 `ReplayVisuals` 引用（`apps/viewer/src/replay/timeline.ts:36` 到 `apps/viewer/src/replay/timeline.ts:38`）。

**共享状态通道（SAB 通道 / postMessage 回退）在本工程不存在**：入口不建 `SharedArrayBuffer`，也不按 `crossOriginIsolated` 选通道，只打印该标志（`apps/viewer/src/app.ts:39` 到 `apps/viewer/src/app.ts:44`）。

## 异常与回退路径

| 失败点 | 回退/结果 | 锚点 |
|---|---|---|
| `canvas#game` 缺失 | 抛错，页面停留在静态骨架（`<script>` 之后的代码不执行） | `apps/viewer/src/app.ts:34` |
| WebGL 上下文创建失败 | `Hud.showFatal` 打开 `#fatal` 卡片并给出建议文案，随后重抛 | `apps/viewer/src/app.ts:52`、`apps/viewer/src/ui/hud.ts:120` |
| WASM 三条取值路径全不通 | 抛「WASM 加载失败」错误，文案带 `npm run build:wasm` 提示 | `apps/viewer/src/core/bsp.ts:107` |
| WASM 外置请求非 2xx | 打一条 `warn` 后回退到内嵌副本路径 | `apps/viewer/src/core/bsp.ts:94` |
| WASM 首次失败后再试 | 模块级 Promise 已被 rejected 且不重置 ⇒ 同一次页面会话内不会重新尝试（见 `documents/viewer/implementation/core.md` 的「已知缺口」） | `apps/viewer/src/core/bsp.ts:75` |
| BSP 解析 / 导出抛错 | `humanizeBspError` 按 message 归成四类文案；无地图时显示引导层错误详情，已有地图时临时提示 5 s 并还原旧摘要 | `apps/viewer/src/core/bsp.ts:148`、`apps/viewer/src/app.ts:273` 到 `apps/viewer/src/app.ts:283` |
| GLB 未携带光照图集 | 打一条 `console.info` 后整段跳过静态光照，地图仍可看（贴图原色） | `apps/viewer/src/core/scene.ts:220` |
| 施加静态光照中途抛错 | 只 `console.error`，不阻断挂载 | `apps/viewer/src/core/scene.ts:231` |
| 块内几何合并失败 | 保留全部子块（不丢几何）；最终合并失败时逐块建 Mesh | `apps/viewer/src/core/scene.ts:455`、`apps/viewer/src/core/scene.ts:478` |
| Worker 构造抛错或 `onerror` | `workerBroken` 置位、终止并丢弃 Worker、用同一个错误拒绝全部未结算请求；此后每次导入直接走主线程 | `apps/viewer/src/replay/importer.ts:102` 到 `apps/viewer/src/replay/importer.ts:110` |
| 主线程回退的魔数嗅探失败 | 抛「不是 Shavit .replay 录像文件」错误，经面板 note 显示 | `apps/viewer/src/replay/importer.ts:185` |
| Worker 收到消息但永不回包 | `import` 不设超时：promise 永不结算，面板 `busy` 保持为真，后续导入被丢弃 | `apps/viewer/src/replay/importer.ts:135`、`apps/viewer/src/replay/panel.ts:286` |
| 拖入非 `.bsp` / 非 `.replay` | 已加载地图时 HUD 临时提示 5 s，未加载地图时写引导层错误 | `apps/viewer/src/app.ts:346` 到 `apps/viewer/src/app.ts:348` |
| URL 深链 fetch 失败或不是 Shavit 录像 | 无地图时打开引导层并显示错误；已有地图时 HUD 临时提示 6 s | `apps/viewer/src/app.ts:459` 到 `apps/viewer/src/app.ts:468` |
| 规则存档缺失 / 版本不符 / 解析抛错 | 保留内置默认规则 `defaultRule()`；读不到时顺手清掉旧版键 | `apps/viewer/src/replay/panel.ts:189`、`apps/viewer/src/replay/types.ts:55` |
| `localStorage` 写入失败 | `saveRule` 静默忽略（隐私模式等） | `apps/viewer/src/replay/panel.ts:215` |
| 数字输入非法 | `numField` 打 `invalid` 类并回调 `onInput(NaN, false)`；变换侧遇非有限值直接返回、不改规则也不重导 | `apps/viewer/src/core/dom.ts:105`、`apps/viewer/src/replay/panel.ts:334` |
