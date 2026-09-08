# viewer 核心时序

> 本文展开 viewer 的五条核心时序：启动、BSP 地图加载、录像导入、回放帧循环、深链与对外 API。
> 每一步标注当前代码位置（`文件:行号`）；总览见 [overview.md](overview.md)，
> 模块实现细节见 [implementation/](implementation/)（录像管线全链见 [implementation/replay-system.md](implementation/replay-system.md)）。

## 1. 启动时序（页面 → 可交互）

```
index.html 加载
  ├─ [91-107]  资源兜底监听（capture 阶段 window.error：app.js / *.wasm 404 → #fatal 卡显示构建指引）
  └─ [108]     <script type="module" src="./app.js">  ← esbuild 产物（build:ts；file:// 打包形态为 classic）
app.js 顶层（viewer/src/app.ts，自上而下一次装配）
  ├─ [29-31]   取 #game canvas（缺失直接 throw）
  ├─ [33]      new Hud()（帮助浮层按钮 / Esc 关闭接线，viewer/src/ui/hud.ts:28-38）
  ├─ [36-44]   new ViewerScene(canvas)（WebGL renderer + 三点光，失败 → hud.showFatal 兜底卡）
  ├─ [46-48]   new FlyCam().attach(canvas)（指针锁定 + 键鼠监听；锁定失败 → HUD 闪提示）
  ├─ [51-82]   侧栏折叠按钮 + .tab/.tabpane 标签页接线（切到录像页自动展开侧栏，app.ts:72-76）
  ├─ [94-99]   MapPanel(pane-map)（onJump 在第一人称回放时被忽略，app.ts:96-98）
  ├─ [102-104] ReplayImporter / ReplayPlayer / ReplayVisuals
  ├─ [108-113] syncTracks：轨道变化 → 3D 可视化 + 时间轴 + 录像信息条 一把刷新
  ├─ [117-145] ReplayPanel(pane-replay)（回调 onClip / onClearAll / onTracksChanged / onStatus——无起点锚定回调）
  ├─ [147]     ReplayMetaPanel(#replayMeta)（录像信息条，挂 syncTracks 刷新）
  ├─ [148]     Timeline(#timeline)
  ├─ [271-277] #bspFile change → loadBsp；引导按钮 → click #bspFile
  ├─ [279-304] 窗口级拖拽（.bsp / .replay 两分支；其余明确报错）
  ├─ [307-364] 挂 window.viewer.replay（只读内省 + meta() + 播放控制）
  ├─ [368-405] loadUrlAssets()（?bsp=&replay= 深链）并立即执行 [405]
  └─ [453]     requestAnimationFrame(frame)  ← 进入渲染循环
```

- DOM 骨架本身就是状态机的一部分：`#guide` 首访引导层（地图加载成功后隐藏，`app.ts:243`）、`#fatal` 启动失败兜底卡（`hud.ts:110-117`）、`#dropzone` 拖拽高亮（`app.ts:279-285`）、`#dock`（录像信息条 + 时间轴，有录像时显示）、`#help` 帮助浮层（键位 / 载入 / 播放基准，`web/index.html:56-71`）。
- 若 WebGL 不可用，`ViewerScene` 构造抛错 → `hud.showFatal`（`app.ts:38-44`、`ui/hud.ts:110-117`），页面给出"换浏览器 / 先构建"指引。

## 2. BSP 地图加载时序（主线程解析）

入口：`#bspFile` change / 引导按钮 / 拖入 `.bsp` / 深链 `?bsp=`（`app.ts:271-277, 286-294, 374-380`）→ 全部汇入 `loadBsp(file)`（`app.ts:215-257`）。

### 2.1 WASM 懒初始化（`viewer/src/core/bsp.ts:41-68`）

1. 单文件构建（file:// 双击）时 WASM 以 base64 内嵌在 `globalThis.__VBSP_WASM_B64__` → `initSync({module: bytes})`，**不 fetch**（file:// 下 fetch 被浏览器拦截，`bsp.ts:38-51`）；
2. 否则 `fetch(new URL('./websurf_viewer_wasm_bg.wasm', import.meta.url))` → `initSync`（`bsp.ts:52-64`）；失败文案指回 `npm run build:wasm`（`bsp.ts:55-62`）。
3. `wasmReady` 是模块级单例 Promise（`bsp.ts:34, 41-68`），整页只初始化一次。

### 2.2 三步调用链（`viewer/src/core/bsp.ts:70-96`，消费顺序固定）

```
new BspProcessor(bytes)
  → proc.metadata()             [bsp.ts:77]  map 元数据 JSON（magic/brush/face/模型 计数）
  → proc.parse_spawn_points()   [bsp.ts:79]  出生点 report —— 必须在 export_* 之前
  → proc.export_glb_with_pakfile_models()    [bsp.ts:80]  GLB 字节（消费 BSP）
```

- 文件头注释把契约写死："借用导出（spawn）必须在消费 BSP 的 export_glb* 之前调用"（`bsp.ts:1,78`）——Rust 侧 `export_glb_with_pakfile_models(&mut self)` 以 `self.bsp.take()` **消费**内部 `Bsp` 实例（`viewer/crates/wasm/src/lib.rs:264-265, 417-422`），此后再调任何方法都返回 "BSP 未解析或已导出"（`lib.rs:289-292, 419-422`）。
- Rust 侧对应实现：`metadata(&self)`（借用不消费；`BspMetadata` 序列化为 JSON，magic 由 header 的 v/b/s/p 四字节拼出，`packed_files` 在构造时一次性缓存——Packfile.zip 为私有字段、`into_zip()` 消费 self，`lib.rs:212-256, 273-295`）；`parse_spawn_points(&self)`（借用；9 个 classname + `info_player_*` 通配过滤，`rotate_yup` 把 origin 转到 Y-up 而 angles 保持 BSP 原始 `[pitch,yaw,roll]` 由前端换算，`primary` 取首个 `info_player_start` 否则第一个出生点，`lib.rs:303-409`）；`export_glb_with_pakfile_models(&mut self)`（PAKFILE 内嵌模型三件套 `.mdl/.vvd/.dx90.vtx` 提取 → VMT 透明度 + VTF→PNG 材质 → `ModelIntegrator` + `export_bsp_with_models` → GLB 字节；未打包任何被引用模型时**自动回退纯地图导出**不报错，`lib.rs:411-465`）。
- 解析计时由 JS 侧 `performance.now()` 统计（`bsp.ts:75, 85`），进地图信息面板"解析耗时"（`ui/mapinfo.ts:114`）。
- 大地图解析可能数百毫秒：`bsp.ts:72-73` 先 `await setTimeout 0` 让 UI 先刷新一帧。
- 失败翻译：`humanizeBspError`（`bsp.ts:99-111`）按错误关键词归为四类人话（无效文件 / 缺构建产物 / 内存不足 / 其他）。

### 2.3 GLB 挂载与场景就绪（`app.ts:215-257` → `viewer/src/core/scene.ts:125-150`）

```
loadBspFile 返回 BspLoadResult
  → scene.mountGlb(glbBytes)            [app.ts:222]
      ① 字节拷贝 → Blob URL → GLTFLoader.loadAsync → revoke URL   [scene.ts:126-135]
      ② 旧地图存在则 disposeObject + 移除（换图防泄漏）            [scene.ts:136-140]
      ③ resetRootRotations（清 GLB 根节点旋转，与 game 同法）      [scene.ts:142-144]
      ④ optimizeScene 空间分块合并（数千~数万 Mesh → ~数百块）     [scene.ts:148-149]
      ⑤ fitCamera（near/far 按地图尺寸自适应）                     [scene.ts:150]
  → scene.worldBox() → currentBox（app.ts:224-233，录像贴合检查用）
  → mapPanel.setMap(result, box)                              [app.ts:234]
  → updateReplayMapStatus()（轨迹/地图包围盒对照刷新）          [app.ts:235]
  → applyInitialPose(result)：推荐出生点 → fly.setPose         [app.ts:238, 260-269]
  → hud.setStatus 摘要 + hud.hideGuide()                       [app.ts:239-243]
```

- 初始视角换算：`bspYawToCsYaw(angles[1])`（`app.ts:266`；换算式 `(270 − yaw) mod 360`，`core/pose.ts:12-14`）——**注意：该式仅服务 BSP 出生点实体角路径**（与 `.replay` 帧解码的 `yaw = wrap(src+180)` 定标是两套口径），且实测对出生点实体疑似镜像（评审 F6 已知问题，未修复）；详见 [implementation/replay-system.md](implementation/replay-system.md) §2.5 与 [differences.md](differences.md) §7。
- 换图失败语义：已有地图时只临时闪 5s 提示并还原旧摘要，不弹引导层（`app.ts:250-254`）；首图失败才回到引导层报错（`app.ts:245-249`）。
- 出生点快照对外暴露：`mapPanel.spawnPoints`（`mapinfo.ts:65-68`，供出生点导航跳转列表；不再有"起点对齐"消费方）。

## 3. 录像导入时序（Shavit .replay 原生解析，Worker 优先）

入口（三个，**均先魔数嗅探**）：录像页「选择录像文件…」（`panel.ts:63-82`）/ 窗口拖拽 `.replay`（`app.ts:286-304`，分支 `:295-300`，导入后自动切到录像页）/ 深链 `?replay=`（`app.ts:368-405`，直接 `arrayBuffer()`）→ 汇入 `ReplayImporter.import(file, rule, name, onProgress)`（`viewer/src/replay/importer.ts:90-110`）。

```
importer.import(file, rule, name)
  ├─ send({type:'import', file, rule}) → parse-worker（importer.ts:81-88）
  │   worker 内（viewer/src/worker/parse-worker.ts:38-93）：
  │   ① 魔数嗅探（file.text() 之前——文本解码会破坏二进制）[parse-worker.ts:44-49]
  │   ② file → arrayBuffer 字节缓存（改映射/变换不重读盘）[parse-worker.ts:52-61]
  │   ③ parseShavitReplay(bytes, {timestampFallback: File.mtime, mapping})[parse-worker.ts:63-68]
  │   ④ clipFromShavitReplay：解析数组拷贝 → applyClipTransform → Clip [parse-worker.ts:70-72]
  │   ⑤ post('done', payload, transfer=[t,pos,ang,vel,buttons].buffer)[parse-worker.ts:73-85]
  ├─ 主线程收 done → payloadToClip（importer.ts:159-176）
  └─ 失败 / workerBroken → importOnMain（importer.ts:106-109, 118-152）：
        同源链路在主线程重放（同一批 shavit-replay/build 函数，importer.ts:3-7）
```

- **嗅探失败 = 明确报错**：「不是 Shavit .replay 录像文件——viewer 只支持 Shavit 原生 .replay（JSON/规则脚本通道已移除）」（`parse-worker.ts:46-49`、主线程同文案 `importer.ts:130-134`）。
- **Worker 建立路径**（`importer.ts:39-79`）：常规构建 `new Worker(new URL('./parse-worker.js', import.meta.url), {type:'module'})`；单文件构建从 `globalThis.__VBSP_WORKER_JS__` 建 Blob URL（file:// 下 module worker 被拦，`importer.ts:42-52`）。`onerror` 一次即 `workerBroken = true`，之后全部走主线程（`importer.ts:64-72`）。
- **消息协议**：`viewer/src/replay/protocol.ts:32-35`（progress / done / error 三型；payload 的 `t` 是 Float64Array、`pos/ang/vel/buttons` 是定型数组，经 Transferable 零拷贝回传，`protocol.ts:6-21`——`buttons/meta` 为原生路径特有）。
- **解析产出即播放基准**：帧是绝对世界坐标 + 实测定标映射（pos `[y,z,x]`、yaw = wrap(src+180)、pitch 取反，`shavit-replay.ts:478-507`），**无起点锚定、无自动平移**——`onClip` 只做落轨与刷新（`app.ts:118-131`）。
- **导入结果落轨**：`ReplayPanel.onClip`（`app.ts:117-131`）——`replaceId` 存在则 `tracks.replaceClip`（保配色/显隐/偏移/名字，`replay/tracks.ts:49-54`），否则 `player.addTrack` 追加新轨；随后 `player.mode = 'first'`（载入即第一人称跟随，`app.ts:126`）并 `syncTracks()` 重建 3D 可视化、时间轴与信息条。
- **「换文件 = 追加，改映射/变换 = 替换」语义**的判定锚点：`ReplayPanel.lastTrackId`（`replay/panel.ts:41`）——`loadFile` 换文件时清空（`panel.ts:228-239`），改映射/变换重导时沿用（`panel.ts:241-282`），见 [replay-system.md](implementation/replay-system.md) §7.1。

## 4. 回放帧循环与相机驱动

主循环 `frame(now)`（`viewer/src/app.ts:413-449`），`dt` 上限夹取 0.05s（`app.ts:415-416`）：

```
每一帧：
  ① player.update(dt)        主时钟推进 + 循环回绕（replay/player.ts:147-163）
  ② 相机驱动（二选一）：
     第一人称（replayFirstPerson() 且有采样，app.ts:194-196, 421-432）：
        fly.drivesCamera=false、allowMove=false → 相机完全交给录像：
        sample.ang/pos → fly.setWorld(...) → fly.applyToWithRoll(scene.camera)（roll 恒 0）
     第三人称 / 无录像（app.ts:433-439）：
        fly.roll=0（清 roll 残留）、drivesCamera=true、allowMove=true
        fly.update(dt) → fly.applyTo(scene.camera)（回到自由飞行）
  ③ visuals.update(player.sampleAll(), mode, followId)   幽灵/轨迹线逐帧摆位（app.ts:441）
  ④ scene.render()           近平面贴墙自适应（core/scene.ts:107-114）
  ⑤ HUD 节流：每 80ms 刷位姿读数与时间轴（app.ts:444-448）
```

- **主时钟推进**（`replay/player.ts:147-163`）：`time += dt*speed`；到 `rangeStop` 后按循环与否回绕或停止。主时钟 0 = 起跑帧（prerun 帧在负时间轴、不在播放区间）。
- **采样**（`replay/player.ts:176-187` → `tracks.ts:95-108` → `sampling.ts:41-75`）：主时钟 `t` 先经 `TrackSet.localTime` 减去轨道 `offset`（未开始 → null；播完 → 夹到末帧"停在终点"），再在 clip 内二分定位（`sampling.ts:24-39`）并线性插值——`pos/vel` 直接 lerp，`yaw/roll` 走最短弧 `lerpAngle`（`sampling.ts:11-14`）。
- **第一人称接管**与自由飞行互不打断状态：`FlyCam` 照常持有位姿，只是 `drivesCamera/allowMove` 双闸关闭（`core/fly.ts:29-41`），退出回放立即原地接管（`app.ts:433-439`）。
- **播放控制入口**：时间轴按钮/键盘 K、,/.、I/O（`replay/timeline.ts:189-209` + 输入框避让 `isTypingTarget` `timeline.ts:336-342`）、`window.viewer.replay`（`app.ts:307-364`）。
- **跨面提醒**：轨迹 bbox 完全落在地图包围盒外（外扩 512 HU）→ HUD `#replayStatus` 提醒（`app.ts:157-188`）；提醒指回录像页「坐标映射」切换（t4 基准 = 帧自身坐标，正确的 .replay 触发提醒说明映射不对）。

## 5. 深链与对外 API 时序

- **深链 `?bsp=&replay=`**（`app.ts:368-405`）：`loadUrlAssets()` 逐个 fetch（BSP → `loadBsp`，`:374-380`；replay → `activateTab('replay')` 后直接 `arrayBuffer()` + 魔数嗅探（不按文本读），嗅探失败明确报错，`:381-391`）。失败时按"是否已有地图"分流到引导层报错或 HUD 闪现（`:394-404`）。file:// 下 fetch 被拦，深链仅 HTTP 可用（`scripts/dist-README.md:34-40`「file:// 与 HTTP 的差异」）。
- **`window.viewer.replay`**（`app.ts:307-364`）：getter 每次返回新快照对象——内省（trackCount/duration/time/playing/speed/mode/followId/sceneObjects/tracks()）+ `meta()`（跟随轨 `.replay` 头部元信息，`app.ts:335`）+ 控制（play/pause/seek/setSpeed 0.1–16/setMode/follow(null)）。供外部脚本与自动化（冒烟测试即以此驱动，`test/smoke-cdp.mjs:606-649`）。

## 6. 时序上的三个"必须知道"

1. **WASM 初始化是懒的**：不载地图就不会碰 WASM（`bsp.ts:41-68` 单例 Promise）——只看录像、无 BSP 也能用（播放基准 = 帧自身坐标，不依赖地图；但 HUD 贴合提醒需要地图才有包围盒，`app.ts:157-188`）。
2. **GLB 消费顺序固定**：spawn 借用必须在 GLB 导出之前（`bsp.ts:78` + `crates/wasm/src/lib.rs:58-68` zip 锁移交）。
3. **录像导入的 Worker/主线程是同一套逻辑**：parse-worker 与 importer 主线程回退共用 `shavit-replay`/`build` 模块（`parse-worker.ts:10-14` 与 `importer.ts:3-7` 的对称 import），行为一致——这也是自检可以只在 Node 跑管线核心的原因（`test/replay-selftest.ts:1-30`）。
