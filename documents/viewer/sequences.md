# WebSurf-viewer：主流程时序

> 参与者只有四类：浏览器页面、主线程（`apps/viewer/src/app.ts` 及其调用的模块）、解析 Worker（`apps/viewer/src/worker/main.ts`）、WASM 模块（`apps/viewer/crates/wasm` 的 `BspProcessor`）。本工程**不参与**共享内存通道：不建 `SharedArrayBuffer`，`crossOriginIsolated` 只打印供核对（`apps/viewer/src/app.ts:55`）。

---

## 启动时序

| 参与者 | 步骤 | 数据落点 | 锚点 |
|---|---|---|---|
| 浏览器 | 取 `/web/index.html`（dev 由 `src/serve.py` 在 8100 端口服务） | 页面骨架：`#game` / `#fatal` / `#guide` / `#dropzone` / `#hud` / `#telemetry` / `#topbar` / `#help` / `#sidebar` / `#dock` | `apps/viewer/web/index.html:12`、`apps/viewer/package.json:19` |
| 浏览器 | 以 module script 加载 `./app.js` | 模块顶层开始执行 | `apps/viewer/web/index.html:160` |
| 主线程 | 取 `canvas#game`，取不到即抛错 | `gameCanvas` | `apps/viewer/src/app.ts:48` |
| 主线程 | 打印 `crossOriginIsolated`，仅作部署环境参考 | 控制台一行 | `apps/viewer/src/app.ts:55` |
| 主线程 | `new Hud()`：一次性取 11 个元素句柄（取不到即 null，各方法逐个判空） | `Hud` 的只读字段 | `apps/viewer/src/ui/hud.ts:22` |
| 主线程 | `new ViewerScene(canvas)`：建 WebGL 渲染器 → 写静态光照共享 uniform → 建场景/相机（2026-10-03 起不加三点光、GLB 自带灯由共享装配摘除） | three 渲染器、`THREE.Scene`、`PerspectiveCamera` | `apps/viewer/src/core/scene.ts:56`、`apps/viewer/src/core/scene.ts:68` |
| 主线程 | `new FlyCam()` 并 `attach(canvas)`：注册 click / pointerlockerror / pointerlockchange / mousemove / keydown / keyup / blur 七类监听 | 全局监听器与相机内部状态 | `apps/viewer/src/core/fly.ts:84` |
| 主线程 | 取侧栏、dock、遥测句柄；绑侧栏折叠；tab 切换收敛到唯一入口 `switchTab` → `setActiveSession`（上场 = 加 `.active` 并按当前采样重算 3D 显隐，下场 = 只停表，轨道 / 时间 / 区间 / 显示开关全留） | DOM 类名 `hidden` / `active` / `full` | `apps/viewer/src/app.ts:78` 到 `apps/viewer/src/app.ts:90`、`apps/viewer/src/app.ts:154`、`apps/viewer/src/app.ts:175` |
| 主线程 | `new MapPanel(#pane-map, onJump, onLightingMode)`：建「更换地图」行、光照模式分区、地图信息分区、出生点导航分区 | `#pane-map` 子树 | `apps/viewer/src/ui/mapinfo.ts:52` |
| 主线程 | `new ReplayImporter()` + 两个 `new ReplaySession(kind, scene, 容器, 时间轴容器, meta 容器)` | 导入器一个 + 两个会话（各持自己的 `ReplayPlayer` / `ReplayVisuals` / `Timeline`） | `apps/viewer/src/app.ts:230`、`apps/viewer/src/app.ts:100` 到 `apps/viewer/src/app.ts:115` |
| 主线程 | `new ReplayPanel(#pane-replay, importer, player, opts)`：读持久化规则 → 建导入 / 轨迹列表 / 坐标映射 / 调整工具四段 | `#pane-replay` 子树、`localStorage` 键 `websurf-viewer.replay-rule.v2` | `apps/viewer/src/replay/panel.ts:82`、`apps/viewer/src/replay/panel.ts:29` |
| 主线程 | `new TelemetryHud(#telemetry, 记录会话的时间轴根)`（按键簇挂**记录会话**那条时间轴的右列）；`ReplayMetaPanel` 与 `Timeline` 由各会话在构造期按能力档自建；**录像信息条** `DemoMetaStrip` 单独构造（不在会话里，写 `#demoInfo`）；**画面左下角的对话浮层** `ChatOverlay` 也单独构造（同样不在会话里，写 `#chatOverlay`，数据由录像看板的 `onParsed` 推入） | `#telemetry`、`#replayMeta`、`#demoInfo`、`#chatOverlay`、`#timeline` / `#timelineDemo` | `apps/viewer/src/app.ts:127` 到 `apps/viewer/src/app.ts:130`、`apps/viewer/src/replay/session.ts:85` 到 `apps/viewer/src/replay/session.ts:86`、`apps/viewer/src/app.ts:135`、`apps/viewer/src/app.ts:140`、`apps/viewer/src/ui/telemetry.ts:97` |
| 主线程 | 挂 `globalThis.viewer`（`map` / `replay` / `demo` / `session` 四个 getter；`replay` 与 `demo` 形状相同，各操自己的会话） | 全局对象，供外部脚本与 headless 断言 | `apps/viewer/src/app.ts:750` |
| 主线程 | 异步 `loadUrlAssets()`：`?bsp=` 走 `fetch` + `loadBsp`，`?replay=` 先嗅探再交给面板 | 深链资源进 `File` 对象 | `apps/viewer/src/app.ts:788` |
| 主线程 | 首刷位姿读数并 `requestAnimationFrame(frame)` | 主循环启动 | `apps/viewer/src/app.ts:999` 到 `apps/viewer/src/app.ts:1020` |
| 用户 | 点引导按钮「选择地图」/ 地图页换图入口 → `#bspFile` 的 change → `loadBsp(file)` | `bspLoading` 与 busy 类 | `apps/viewer/src/app.ts:612` 到 `apps/viewer/src/app.ts:616`、`apps/viewer/src/app.ts:535` |
| 用户 | 拖拽 / 引导层「导入记录 / 录像」/ 两个面板的文件框 → `routeFile(file)`：按文件头魔数判类型，命中即切到对应 tab | 无（纯分派，不落状态） | `apps/viewer/src/app.ts:626` 到 `apps/viewer/src/app.ts:644`、`apps/viewer/src/app.ts:618` 到 `apps/viewer/src/app.ts:622`、`apps/viewer/src/app.ts:663` 到 `apps/viewer/src/app.ts:666` |
| 主线程 + WASM | `ensureWasm()` → `new BspProcessor(bytes)` → `metadata()` → `parse_spawn_points()` → `loadDefaultsJson` → `export_glb_with_pakfile_models_with_defaults_and_lights(defaultsJson)`（顺序被借用语义固死；导出失败回退裸导出。2026-10-04 起与 game 同款） | `BspLoadResult`：meta / spawnPoints / primary / glbBytes / elapsedMs | `apps/viewer/src/core/bsp.ts:129`、`apps/viewer/src/core/bsp.ts:134` 到 `apps/viewer/src/core/bsp.ts:131` |
| 主线程 | `scene.mountGlb(glbBytes, skyboxTexture, { fogParams, skyCamera, pvsJson })`：调**共享装配核** `assembleScene`（序列 = 摘 punctual 灯 → 双贴图登记 → applyLightmap → **摘 3D 天空区**（判据 = 图元采样点落在 `sky_camera` 所在 cluster）→ 主模型分块合并 → 天空区合并 → 合并后终扫，天空组同样跑）→ 挂天空层 + 地图雾 → `fitCamera(maxDim)` | `modelRoot`（共享装配产出的子场景根）、相机 near/far | `apps/viewer/src/core/scene.ts:155`、`apps/viewer/src/core/scene.ts:160` 到 `apps/viewer/src/core/scene.ts:168`、`src/renderer-shared/scene/assemble-scene.ts:98` |
| 主线程 | `resolveInitialSpawn(spawnPoints, primary, box)` 定初始视角；`mapPanel.setMap(...)` 填面板；`updateReplayMapStatus()` 做贴合检查 | `currentBox`、`lastSpawnSource`、面板 DOM | `apps/viewer/src/app.ts:557` 到 `apps/viewer/src/app.ts:559`、`apps/viewer/src/core/spawn.ts:96` |
| 用户 | 记录页文件框 / 深链 → `ReplayPanel.loadFile(file)`：先按内容复核，非 `.replay` 经 `onForeignFile` 交回 `routeFile` 改送 | `file` 字段、`lastTrackId` 清空为 null | `apps/viewer/src/replay/panel.ts:278`、`apps/viewer/src/replay/panel.ts:283` |
| 用户 | 录像页文件框 → `DemoPanel.load(file)`：同样先复核，非 `.dem` 经 `onForeignFile` 改送 | `lastFile` 字段、看板各容器 | `apps/viewer/src/replay/demopanel.ts:464` 到 `apps/viewer/src/replay/demopanel.ts:470` |
| 主线程 | **解析完成**（`parseSourceDemo`）→ 录像看板一次推两件事：`onParsed(result, file, rosterCount)` 把 `DemoParseResult` 交给**录像信息条** `DemoMetaStrip.set`（`#demoInfo`：12 项条面 + 悬停诊断面），`onLoaded()` 把整场时长写进本会话播放器（`sessionLength`）并放出时间轴，随后从 0 s 自动跟随播放；解析失败时推 `onParsed(null, …)` **清空**信息条 | `DemoParseResult` 进 `#demoInfo`；`sessionLength` 撑起 `#timelineDemo` | `apps/viewer/src/replay/demopanel.ts:500`、`apps/viewer/src/replay/demopanel.ts:517` 到 `apps/viewer/src/replay/demopanel.ts:518`、`apps/viewer/src/app.ts:390` 到 `apps/viewer/src/app.ts:401`、`apps/viewer/src/app.ts:440` 到 `apps/viewer/src/app.ts:452` |
| 主线程 | `runImport(true)` → `importer.import(file, rule, name, onProgress)` | `busy` 置真 | `apps/viewer/src/replay/panel.ts:321` |
| Worker 或主线程 | 嗅探魔数 → 取字节（命中同一文件句柄则复用缓存）→ `parseShavitReplay` → `clipFromShavitReplay` | `ShavitParseResult` → `Clip`（定型数组 + meta + buttons） | `apps/viewer/src/replay/importer.ts:194` 到 `apps/viewer/src/replay/importer.ts:214`、`apps/viewer/src/replay/shavit-replay.ts:569` |
| 主线程 | `onClip` → `replaceClip` 或 `addTrack` → `player.mode = 'first'` → `syncSession('replay')` → `updateReplayMapStatus()` | 本会话的 `TrackSet`、3D 对象、时间轴、信息条、遥测 HUD | `apps/viewer/src/app.ts:288` 到 `apps/viewer/src/app.ts:300`、`apps/viewer/src/app.ts:245` |

## 帧链/主循环

| 参与者 | 动作 | 锚点 |
|---|---|---|
| `requestAnimationFrame` 回调 | 先重排下一帧，再算帧间隔 dt（上限 0.05 s，即 50 ms） | `apps/viewer/src/app.ts:841`、`apps/viewer/src/app.ts:968` |
| 自动跟随（只对**上场**的录像会话） | `s.kind === 'demo' && demoPanel` 时每帧先刷看板（`refreshNames` / `refreshRoster` —— **同一次刷新里也点亮 / 压暗对话区**：`refreshRoster` 内部走 `refreshRosterState`，除了在线态与名字，还按同一份「当前 tick」调 `refreshChatState` 给已发生的聊天行加 `.dmp-chat-on`、未发生的压暗，不另开计时器；同一段里也推进**画面左下角的对话浮层** —— `chatOverlay.update(s.player.time)` 按当前播放头增删浮层条目（出现 15 秒后淡出 / 同屏最多 5 条 / 超出丢最早的）），再判「该不该换人」：`autoFollow && playing` 时取「进场最早、且采到了位姿」的**真人**（判据 `p.human` —— `userinfo` 里见过非空且非 `BOT` 的 guid，不是 `!isBot`），再用 `demoPanel.spanAt(实体号, nowTick)` **逐段**问「他**此刻**在不在场」，三条判据依次为：① **在场** ⇒ 跟**这一段**的实体并锁定他（同一身份的两段往往是两个实体号），同时清掉「已跳过」的记认；② **不在场、但我们一直在看他（`rosterFor(...).entities` 含上一次跟的实体）、且他后面还会回来（`spans` 里还有下一段）** ⇒ **不切别人**，直接把播放头**跳到他重进那一刻**接着看（`pickEntity` → `jumpTo` 在他区间外时 `seek` 到那一段起点），并用 `hud.flashStatus` 提示「已跳过 … 不在场的一段，接上他重进的 m:ss」；`autoFollowSkippedTo` 保证**同一段只跳一次**（手动把播放头拖回缺口不会被再弹走）；③ **否则**（还没进服 / 这一段之后他不会再来 / 我们看的本来不是他）⇒ 退回 `fastestAt`（此刻最快的那位）。换人一律走既有 `demoPanel.pickEntity` 路径（建轨道 + 切第一人称）；期间 `autoPickInFlight` 置真，免得被 `onClip` 当成「用户自己点的人」而解除自动跟随。**同一段里还有两件前置 / 并列的事**：① **按区间换绑视角**（每帧都做，与播放/暂停、自动跟随开关无关）：`demoPanel.spanAt(当前视角实体, nowTick)` 返回的那一段若属于**另一条轨迹**（同一身份的第二段是另一个实体号）⇒ 把视角**换绑**到那一段（`pickEntity`）—— 播放头本来就在这一段里，`onClip` 的「区间外才 seek」不触发，用户的播放位置一动不动；② **用户亲手拖滑杆时让开方向**：`Timeline.onUserSeek`（`apps/viewer/src/replay/timeline.ts:92`，只由滑杆 `input` 触发，程序内部的 seek 不算）记下 `userSeekAt`，帧循环算 `dragging = demo.timeline.scrubbing`（`apps/viewer/src/replay/timeline.ts:357`）`\|\|` `now − userSeekAt < 700`，拖动期间（含松手后 0.7 s）**不替他跳缺口、也不换去跟机器人**，并把这次缺口跳过权作废（`autoFollowSkippedTo = nextSpan.from`）免得松手后下一帧又被弹走 | `apps/viewer/src/app.ts:845` 到 `apps/viewer/src/app.ts:854`、`apps/viewer/src/app.ts:863` 到 `apps/viewer/src/app.ts:881`、`apps/viewer/src/app.ts:884` 到 `apps/viewer/src/app.ts:956`、`apps/viewer/src/app.ts:342`、`apps/viewer/src/app.ts:918` 到 `apps/viewer/src/app.ts:921`、`apps/viewer/src/replay/timeline.ts:92`、`apps/viewer/src/replay/timeline.ts:357` |
| `ReplayPlayer` | `update(dt)`：未播放、或既无轨道又无会话时长兜底时直接返回；推进主时钟 `time += dt × speed`，越过区间末端时按 `loop` 回绕或停在末端并暂停 | `apps/viewer/src/replay/player.ts:249` 到 `apps/viewer/src/replay/player.ts:260` |
| `ReplaySession.cameraSample()` | 未上场 / 非第一人称 / 无轨道返回 null（相机交回自由飞行），否则取跟随轨道的插值位姿 `sample()`（二分定位 + 线性插值） | `apps/viewer/src/replay/session.ts:161` 到 `apps/viewer/src/replay/session.ts:164`、`apps/viewer/src/replay/player.ts:277` 到 `apps/viewer/src/replay/player.ts:278` |
| 相机（回放第一人称） | `fly.drivesCamera = false`、`fly.allowMove = false`；`fly.setWorld(pos, yaw, pitch, roll)` 后 `fly.applyToWithRoll(camera)` | `apps/viewer/src/app.ts:975` 到 `apps/viewer/src/app.ts:986` |
| 相机（自由飞行） | `fly.roll = 0`；`drivesCamera` / `allowMove` 置真；`fly.update(dt)` 消化鼠标增量与按键位移后 `fly.applyTo(camera)` | `apps/viewer/src/app.ts:940` 到 `apps/viewer/src/app.ts:956` |
| 可视化 | `ReplaySession.tick()` 内 `visuals.update(player.sampleAll(), mode, followId)`：本会话未上场则先熄灭全部对象；上场时按 `Track.visible` 与三个显示开关定各对象显隐，再给幽灵写位置与 `'YXZ'` 序旋转 | `apps/viewer/src/replay/session.ts:155`、`apps/viewer/src/replay/visuals.ts:108` |
| 场景 | `scene.render()`：每 2 帧做一次近平面自适应（共享 NearPlaneController，roots+vertical 六向），再交 three 绘制 | `apps/viewer/src/core/scene.ts:107` 到 `apps/viewer/src/core/scene.ts:145` |
| HUD 节流刷新 | 距上次刷新 ≥ 80 ms 时刷新位姿读数行、**活动会话**的 `timeline.refresh()`、`telemetry.update(sample, buttons)` | `apps/viewer/src/app.ts:997` 到 `apps/viewer/src/app.ts:1012` |
| 输入（键盘） | `Timeline` 的全局 `keydown`：K 播放/暂停、`,` / `.` 逐帧、I / O 设区间；输入控件持焦点时全部不响应，且**只有上场的那条时间轴响应**（`setOnStage` 置位）—— 否则看录像时按 K 会把记录会话的播放态、帧号与 A-B 区间一起改掉 | `apps/viewer/src/replay/timeline.ts:293` 到 `apps/viewer/src/replay/timeline.ts:313`、`apps/viewer/src/replay/timeline.ts:352` |
| 输入（鼠标/键盘，飞行） | `FlyCam` 只在 `locked` 为真时消化 mousemove 与位移键；`blur` 与解锁清空增量与按键集合 | `apps/viewer/src/core/fly.ts:107`、`apps/viewer/src/core/fly.ts:127` |
| resize 事件 | `scene.resize(gameCanvas)` 重设渲染尺寸与相机 aspect | `apps/viewer/src/app.ts:828`、`apps/viewer/src/core/scene.ts:105` |

## 消息与通道

本工程只有一条 postMessage 通道：**主线程 ↔ 记录解析 Worker**。协议类型单点在 `apps/viewer/src/replay/protocol.ts`，两侧实现分别是 `apps/viewer/src/replay/importer.ts` 的 `ReplayImporter` 与 `apps/viewer/src/worker/main.ts`。

| 方向 | 消息（以类型声明为准） | 载荷字段 | 锚点 |
|---|---|---|---|
| 主线程 → Worker | `ParseRequest` | `id:number`、`type:'import'`、`file:File \| null`、`rule:RuleConfig`、`name:string` | `apps/viewer/src/replay/protocol.ts:29` 到 `apps/viewer/src/replay/protocol.ts:40` |
| Worker → 主线程 | `ParseResponse` 的 `progress` 分支 | `phase:'parse' \| 'map'`、`done`、`total` | `apps/viewer/src/replay/protocol.ts:48` |
| Worker → 主线程 | `ParseResponse` 的 `done` 分支 | `payloads:ClipPayload[]`、`warnings:string[]`、`resolvedPath:string` | `apps/viewer/src/replay/protocol.ts:49` |
| Worker → 主线程 | `ParseResponse` 的 `error` 分支 | `message:string` | `apps/viewer/src/replay/protocol.ts:50` |
| （载荷定义） | `ClipPayload` | `name` / `count` / `t` / `pos` / `ang` / `vel` / `duration` / `bbox` / `maxSpeed` / `resolvedPath` / `buttons` / `meta` 共 12 项 | `apps/viewer/src/replay/protocol.ts:12` 到 `apps/viewer/src/replay/protocol.ts:27` |

字段级的实测情况：

- **`id` 是配回 pending 表的唯一键**：请求侧自增（`apps/viewer/src/replay/importer.ts:158`），响应侧按 `msg.id` 找到 resolver，`progress` 不结算、其余分支删表并结算（`apps/viewer/src/replay/importer.ts:107` 到 `apps/viewer/src/replay/importer.ts:114`）。
- **`file` 声明允许 null**（`apps/viewer/src/replay/protocol.ts:35`）：null 的语义是「复用上一份文件的字节缓存」。本仓唯一调用点传的是非空字段（`apps/viewer/src/replay/panel.ts:324` 传 `this.file`，而 `runImport` 在 `apps/viewer/src/replay/panel.ts:312` 已挡掉 null），Worker 侧写的是 `req.file ?? cachedNativeFile`（`apps/viewer/src/worker/main.ts:56`）。
- **进度阶段只有 `'parse'`**：Worker 发 0/1 与 1/1 两条（`apps/viewer/src/worker/main.ts:66`、`apps/viewer/src/worker/main.ts:84`），主线程回退路径在同一位置发同样的两条（`apps/viewer/src/replay/importer.ts:200`、`apps/viewer/src/replay/importer.ts:213`）；`'map'` 阶段没有任何发送方。
- **回包走 transfer 列表**：`t` / `pos` / `ang` 的 buffer 必进，`vel` / `buttons` 存在才进（`apps/viewer/src/worker/main.ts:88` 到 `apps/viewer/src/worker/main.ts:90`），发送后这些 buffer 在 Worker 侧不可再用。
- **`Clip.id` 与 `Clip.rule` 不在载荷里**：由主线程 `payloadToClip` 本地补（`apps/viewer/src/replay/importer.ts:229`）。
- **`ImportResult.resolvedPath` 无读取点**：Worker 回包的 `resolvedPath` 被透传进结果对象（`apps/viewer/src/replay/importer.ts:166`），而 `apps/viewer/src` 内没有消费该字段的地方。
- **`TrackPanelOptions.onPresence` 无发送方**：该可选回调每次 `refresh` 都会被 `?.` 调用（`apps/viewer/src/replay/trackpanel.ts:119`），但 `ReplayPanel` 构造 `TrackPanel` 时只传了 `onChange` 与 `onCleared`（`apps/viewer/src/replay/panel.ts:116` 到 `apps/viewer/src/replay/panel.ts:117`），故它永不触发。

主线程内部不使用消息，全部是直接方法调用：`ReplayPanelOptions` 的五个回调（`apps/viewer/src/replay/panel.ts:37` 到 `apps/viewer/src/replay/panel.ts:48`）由 `apps/viewer/src/app.ts:287` 到 `apps/viewer/src/app.ts:313` 的构造选项提供；`Timeline` 直接持有 `ReplayPlayer` 与 `ReplayVisuals` 引用（`apps/viewer/src/replay/timeline.ts:97` 到 `apps/viewer/src/replay/timeline.ts:98`）。

**共享状态通道（SAB 通道 / postMessage 回退）在本工程不存在**：入口不建 `SharedArrayBuffer`，也不按 `crossOriginIsolated` 选通道，只打印该标志（`apps/viewer/src/app.ts:54` 到 `apps/viewer/src/app.ts:59`）。

## 异常与回退路径

| 失败点 | 回退/结果 | 锚点 |
|---|---|---|
| `canvas#game` 缺失 | 抛错，页面停留在静态骨架（`<script>` 之后的代码不执行） | `apps/viewer/src/app.ts:48` 到 `apps/viewer/src/app.ts:49` |
| WebGL 上下文创建失败 | `Hud.showFatal` 打开 `#fatal` 卡片并给出建议文案，随后重抛 | `apps/viewer/src/app.ts:63` 到 `apps/viewer/src/app.ts:71`、`apps/viewer/src/ui/hud.ts:120` |
| WASM 三条取值路径全不通 | 抛「WASM 加载失败」错误，文案带 `npm run build:wasm` 提示 | `apps/viewer/src/core/bsp.ts:120` |
| WASM 外置请求非 2xx | 打一条 `warn` 后回退到内嵌副本路径 | `apps/viewer/src/core/bsp.ts:107` |
| WASM 首次失败后再试 | 模块级 Promise 已被 rejected 且不重置 ⇒ 同一次页面会话内不会重新尝试（见 `documents/viewer/implementation/core.md` 的「已知缺口」） | `apps/viewer/src/core/bsp.ts:88` |
| BSP 解析 / 导出抛错 | `humanizeBspError` 按 message 归成四类文案；无地图时显示引导层错误详情，已有地图时临时提示 5 s 并还原旧摘要 | `apps/viewer/src/core/bsp.ts:169`、`apps/viewer/src/app.ts:568` 到 `apps/viewer/src/app.ts:579` |
| GLB 未携带光照图集 | 共享 applyLightmap 返回 false，viewer 打一条「未施加」说明；地图仍可看（贴图原色） | `apps/viewer/src/core/scene.ts:168` 到 `apps/viewer/src/core/scene.ts:168` |
| 施加静态光照中途抛错 | 共享 applyLightmap 的 catch 只 `console.error` 并返回 false，不阻断挂载 | `src/renderer-shared/scene/scene-builder.ts:131` 到 `src/renderer-shared/scene/scene-builder.ts:133` |
| 块内几何合并失败 | 保留全部子块（不丢几何）；最终合并失败时逐块建 Mesh（共享核，game/viewer 同一份） | `src/renderer-shared/scene/scene-optimizer.ts:343`、`:349`、`:371`、`:384` |
| Worker 构造抛错或 `onerror` | `workerBroken` 置位、终止并丢弃 Worker、用同一个错误拒绝全部未结算请求；此后每次导入直接走主线程 | `apps/viewer/src/replay/importer.ts:116` 到 `apps/viewer/src/replay/importer.ts:130` |
| 主线程回退的魔数嗅探失败 | 抛「不是 Shavit .replay 记录文件」错误，经面板 note 显示 | `apps/viewer/src/replay/importer.ts:194` 到 `apps/viewer/src/replay/importer.ts:198` |
| Worker 收到消息但永不回包 | `import` 不设超时：promise 永不结算，面板 `busy` 保持为真，后续导入被丢弃 | `apps/viewer/src/replay/importer.ts:149`、`apps/viewer/src/replay/panel.ts:316` 到 `apps/viewer/src/replay/panel.ts:320` |
| 拖入四条魔数都不认的文件 | 已加载地图时 HUD 临时提示 5 s，未加载地图时写引导层错误；文案列出四条魔数（VBSP / `{SHAVITREPLAYFORMAT}` / KSF .rec / HL2DEMO） | `apps/viewer/src/app.ts:655` 到 `apps/viewer/src/app.ts:659` |
| URL 深链 fetch 失败或不是 Shavit 记录 | 无地图时打开引导层并显示错误；已有地图时 HUD 临时提示 6 s | `apps/viewer/src/app.ts:814` 到 `apps/viewer/src/app.ts:822` |
| 规则存档缺失 / 版本不符 / 解析抛错 | 保留内置默认规则 `defaultRule()`；读不到时顺手清掉旧版键 | `apps/viewer/src/replay/panel.ts:198`、`apps/viewer/src/replay/types.ts:55` |
| `localStorage` 写入失败 | `saveRule` 静默忽略（隐私模式等） | `apps/viewer/src/replay/panel.ts:226` |
| 数字输入非法 | `numField` 打 `invalid` 类并回调 `onInput(NaN, false)`；变换侧遇非有限值直接返回、不改规则也不重导 | `apps/viewer/src/core/dom.ts:105`、`apps/viewer/src/replay/panel.ts:367` |
