# implementation/replay：录像解析、回放与面板

> 覆盖 `apps/viewer/src/replay/` 下的十三个模块：类型契约、Shavit `.replay` 原生解析、采样、多轨道容器、播放器、人工变换、角度工具、3D 呈现、导入器、Worker 协议、录像面板、轨迹列表、时间轴。

---

## 模块职责

| 模块 | 职责 | 导出清单 |
|---|---|---|
| `apps/viewer/src/replay/types.ts` | 数据契约：规则、头部元信息、`Clip`、采样结果、轨道 | `RuleTransform`（`apps/viewer/src/replay/types.ts:13`）、`AxesMode`（`apps/viewer/src/replay/types.ts:31`）、`YawMode`（`apps/viewer/src/replay/types.ts:39`）、`RuleConfig`（`apps/viewer/src/replay/types.ts:41`）、`defaultRule`（`apps/viewer/src/replay/types.ts:55`）、`ReplayHeaderMeta`（`apps/viewer/src/replay/types.ts:66`）、`Clip`（`apps/viewer/src/replay/types.ts:110`）、`Sample`（`apps/viewer/src/replay/types.ts:140`）、`Track`（`apps/viewer/src/replay/types.ts:151`）、`TrackSample`（`apps/viewer/src/replay/types.ts:166`） |
| `apps/viewer/src/replay/shavit-replay.ts` | Shavit `.replay` 二进制解析：头行与版本门槛、offsets 区跳过、帧区解码、坐标/时间映射、速度差分 | `SHAVIT_MAGIC`（`apps/viewer/src/replay/shavit-replay.ts:67`）、`SHAVIT_MAX_VERSION`（`apps/viewer/src/replay/shavit-replay.ts:70`）、`SHAVIT_SNIFF_BYTES`（`apps/viewer/src/replay/shavit-replay.ts:73`）、`ShavitFormatKind`（`apps/viewer/src/replay/shavit-replay.ts:84`）、`looksLikeShavitReplay`（`apps/viewer/src/replay/shavit-replay.ts:87`）、`fileLooksLikeShavitReplay`（`apps/viewer/src/replay/shavit-replay.ts:105`）、`ShavitParseOptions`（`apps/viewer/src/replay/shavit-replay.ts:228`）、`ShavitParseResult`（`apps/viewer/src/replay/shavit-replay.ts:245`）、`parseShavitReplay`（`apps/viewer/src/replay/shavit-replay.ts:284`）、`clipFromShavitReplay`（`apps/viewer/src/replay/shavit-replay.ts:569`） |
| `apps/viewer/src/replay/sampling.ts` | 纯函数采样：二分定位、线性插值、最短弧角度插值、水平速度 | `lerpAngle`（`apps/viewer/src/replay/sampling.ts:14`）、`lerp`（`apps/viewer/src/replay/sampling.ts:20`）、`indexInClip`（`apps/viewer/src/replay/sampling.ts:29`）、`sampleClip`（`apps/viewer/src/replay/sampling.ts:51`）、`horizontalSpeed`（`apps/viewer/src/replay/sampling.ts:87`） |
| `apps/viewer/src/replay/tracks.ts` | 多轨迹容器与主时钟 → 轨道内部时间的换算 | `TRACK_PALETTE`（`apps/viewer/src/replay/tracks.ts:25`）、`TrackSet`（`apps/viewer/src/replay/tracks.ts:36`） |
| `apps/viewer/src/replay/player.ts` | 播放器：主时钟、倍速、A-B 区间、循环、逐帧、采样转发 | `PlayMode`（`apps/viewer/src/replay/player.ts:15`）、`ReplayPlayer`（`apps/viewer/src/replay/player.ts:17`） |
| `apps/viewer/src/replay/build.ts` | 人工变换微调（平移 + 绕 Y 旋转）与包围盒重算 | `LARGE_CLIP_FRAMES`（`apps/viewer/src/replay/build.ts:13`）、`applyClipTransform`（`apps/viewer/src/replay/build.ts:25`） |
| `apps/viewer/src/replay/helpers.ts` | 录像域角度工具的统一出口 | 再导出 `wrapDeg`（`apps/viewer/src/replay/helpers.ts:10`）、`clampPitch`（`apps/viewer/src/replay/helpers.ts:13`） |
| `apps/viewer/src/replay/visuals.ts` | 每条轨道五个 three 对象（轨迹线 / tick 点 / 幽灵 / 起终点标记）的建、更、清 | `ReplayVisuals`（`apps/viewer/src/replay/visuals.ts:40`） |
| `apps/viewer/src/replay/importer.ts` | 导入入口：优先 Worker，失败回退主线程；两条路径对调用方同形 | `ImportPhase`（`apps/viewer/src/replay/importer.ts:35`）、`ProgressFn`（`apps/viewer/src/replay/importer.ts:37`）、`ImportResult`（`apps/viewer/src/replay/importer.ts:39`）、`ReplayImporter`（`apps/viewer/src/replay/importer.ts:53`） |
| `apps/viewer/src/replay/protocol.ts` | 主线程 ↔ 解析 Worker 的消息类型单点 | `ClipPayload`（`apps/viewer/src/replay/protocol.ts:12`）、`ParseRequest`（`apps/viewer/src/replay/protocol.ts:29`）、`ParseResponse`（`apps/viewer/src/replay/protocol.ts:46`） |
| `apps/viewer/src/replay/panel.ts` | 录像面板四段：导入、轨迹列表、坐标映射、调整工具；规则持久化 | `ReplayPanelOptions`（`apps/viewer/src/replay/panel.ts:28`）、`ReplayPanel`（`apps/viewer/src/replay/panel.ts:43`） |
| `apps/viewer/src/replay/trackpanel.ts` | 轨迹列表：逐条卡片（显隐 / 偏移 / 跟随 / 移除）与批量操作 | `TrackPanelOptions`（`apps/viewer/src/replay/trackpanel.ts:19`）、`TrackPanel`（`apps/viewer/src/replay/trackpanel.ts:37`） |
| `apps/viewer/src/replay/timeline.ts` | 底部时间轴三行：进度条（两条叠加带）、主控制、显示开关与 A-B 区间 | `Timeline`（`apps/viewer/src/replay/timeline.ts:21`） |

## 关键流程与不变量

| 流程 / 不变量 | 说明 | 锚点 |
|---|---|---|
| 魔数嗅探先于文本解码 | `.replay` 是二进制；嗅探只读前 64 字节并逐字节比较魔数 | `apps/viewer/src/replay/shavit-replay.ts:88`、`apps/viewer/src/replay/importer.ts:185`、`apps/viewer/src/worker/main.ts:60` |
| 头行格式 | `"<数字>:<标签>\n"`；`{FINAL}` 时数字是版本（必须落在 1..0x0C），`{V2}` 时数字是帧数 | `apps/viewer/src/replay/shavit-replay.ts:153`、`apps/viewer/src/replay/shavit-replay.ts:306` |
| 读侧兼容修正 | `preFrames < 0` 归零；版本 < 7 时 `frameCount` 先减 `preFrames`、版本 ≥ 5 再减 `postFrames`；修正后 `< 1` 报错 | `apps/viewer/src/replay/shavit-replay.ts:334` 到 `apps/viewer/src/replay/shavit-replay.ts:343` |
| tickrate 兜底 | 版本 < 5 与 V2 没有该字段 → 取 `FALLBACK_TICKRATE` 并写 warning；字段存在但非有限正数 → 报错 | `apps/viewer/src/replay/shavit-replay.ts:347` 到 `apps/viewer/src/replay/shavit-replay.ts:354` |
| 时间轴公式 | `t(i) = (i − preFrames) / tickrate`，主时钟 0 = 起跑帧，prerun 段为负 | `apps/viewer/src/replay/shavit-replay.ts:470` |
| 坐标与朝向映射 | 默认 `pos: [x,y,z] → [y,z,x]`（与 GLB 导出同一变换）、`yaw = wrap(src + 180)`、`pitch = −src` 并限幅、`roll = 0`；`raw` 模式直读 | `apps/viewer/src/replay/shavit-replay.ts:514`、`apps/viewer/src/replay/shavit-replay.ts:530` |
| 速度由位置差分得到 | 首末帧单侧差分（scale = tickrate），中间帧中央差分（scale = tickrate / 2）；帧数 < 2 时为 null | `apps/viewer/src/replay/shavit-replay.ts:546` 到 `apps/viewer/src/replay/shavit-replay.ts:559` |
| 非法数值沿用上一帧 | 帧内 pos 或 pitch/yaw 出现 NaN/Inf 时沿用上一帧值并计数，计数与多余字节一起进 `warnings` | `apps/viewer/src/replay/shavit-replay.ts:511`、`apps/viewer/src/replay/shavit-replay.ts:543` |
| 解析产物 → `Clip` | 先拷贝定型数组（后续就地改写不影响解析结果），再按 pos 算 bbox、按 vel 算 maxSpeed、按末帧算 duration，最后 `applyClipTransform` | `apps/viewer/src/replay/shavit-replay.ts:575` 到 `apps/viewer/src/replay/shavit-replay.ts:578`、`apps/viewer/src/replay/shavit-replay.ts:615` |
| 时间两套基准 | 方法形参 `t` 一律是主时钟；轨道内部时间 = `t − Track.offset`，上界夹到 `clip.duration`，早于片头返回 null | `apps/viewer/src/replay/tracks.ts:116` 到 `apps/viewer/src/replay/tracks.ts:119` |
| 采样与可见性无关 | `Track.visible` 只影响渲染，不影响 `sample` / `sampleAll` 的返回 | `apps/viewer/src/replay/tracks.ts:129` |
| id 与配色 | `id` 取自增序号，`color` 取「当前轨道数对调色板取模」⇒ 移除一条后再加会重新拿到被移除那条的颜色 | `apps/viewer/src/replay/tracks.ts:48`、`apps/viewer/src/replay/tracks.ts:51` |
| 主时钟总长 | 各轨道 `offset + clip.duration` 的最大值；短轨道播完停在终点 | `apps/viewer/src/replay/tracks.ts:106`、`apps/viewer/src/replay/tracks.ts:119` |
| 默认播放窗口含 prerun 负段 | `applyFullRange` 取 `rangeStart = min(0, 首轨道首帧时间)`、`rangeEnd = 主时钟总长`；`resetRange` 把主时钟置到该起点 | `apps/viewer/src/replay/player.ts:121` 到 `apps/viewer/src/replay/player.ts:126`、`apps/viewer/src/replay/player.ts:104` |
| 区间钳制 | `rangeStop = min(rangeEnd, duration)`；`seek` 夹到 `[rangeStart, rangeStop]`；`update` 越过末端时按 `loop` 回绕或停在末端并暂停 | `apps/viewer/src/replay/player.ts:50`、`apps/viewer/src/replay/player.ts:172`、`apps/viewer/src/replay/player.ts:198` |
| 逐帧步进按跟随轨道 | 步长用跟随轨道的帧号，回写主时钟时加回 `track.offset` | `apps/viewer/src/replay/player.ts:189` |
| 人工变换只在显式设置时生效 | `transform` 缺省或全零（恒等）时 `applyClipTransform` 直接返回；旋转同时改 pos / vel 的 X-Z 与 yaw | `apps/viewer/src/replay/build.ts:26`、`apps/viewer/src/replay/build.ts:41` 到 `apps/viewer/src/replay/build.ts:56` |
| 五个对象独立挂场景 | `setTracks` 先 `clear` 再逐条重建；每次重建必须移除旧对象，否则场景残留 | `apps/viewer/src/replay/visuals.ts:54` 到 `apps/viewer/src/replay/visuals.ts:62`、`apps/viewer/src/replay/visuals.ts:116` |
| 显示开关与轨道显隐相与 | 轨迹线受 `showTrail`、tick 点受 `showTickNodes`、幽灵受 `showGhost`，三者再与 `Track.visible` 相与；只有幽灵会因「第一人称且正是跟随目标」额外隐藏 | `apps/viewer/src/replay/visuals.ts:73` 到 `apps/viewer/src/replay/visuals.ts:78` |
| 轨迹线抽稀上限 | `stride = max(1, ceil(count / MAX_TRAIL_POINTS))`，取满后把末点覆盖到最后一格保证收尾连到终点 | `apps/viewer/src/replay/visuals.ts:156`、`apps/viewer/src/replay/visuals.ts:167` |
| Worker 优先、主线程兜底 | `import` 先试 Worker；哨兵错误 `__NO_WORKER__` 或 `workerBroken` 已置位时改走 `importOnMain` | `apps/viewer/src/replay/importer.ts:153`、`apps/viewer/src/replay/importer.ts:122` |
| 缓存原始字节而非解析结果 | Worker 侧按文件对象句柄复用 `cachedNativeBytes`，主线程侧按 `mainNativeFile` / `mainNativeBytes` 复用 | `apps/viewer/src/worker/main.ts:67`、`apps/viewer/src/replay/importer.ts:192` |
| 两条路径进度同形 | 都按 `'parse'` 的 0/1 与 1/1 回调 | `apps/viewer/src/worker/main.ts:66`、`apps/viewer/src/replay/importer.ts:191` |
| 规则持久化 | 键 `websurf-viewer.replay-rule.v2`；读存档时只接受 `version === 2` 且两个映射字段合法，否则整体忽略；`transform` 不校验 | `apps/viewer/src/replay/panel.ts:26`、`apps/viewer/src/replay/panel.ts:196` 到 `apps/viewer/src/replay/panel.ts:207` |
| 导入 busy 丢弃策略 | 进行中的再次触发一律丢弃（不排队）；显式请求会写「本次改动未生效」 | `apps/viewer/src/replay/panel.ts:286` 到 `apps/viewer/src/replay/panel.ts:289` |
| 变换重导防抖 | 每次输入重置 500 ms 定时器，停顿后触发一次重导；非有限值直接返回 | `apps/viewer/src/replay/panel.ts:340` 到 `apps/viewer/src/replay/panel.ts:344` |
| 面板改动一律「先改数据再 refresh」 | 轨迹卡片的显隐 / 偏移 / 重命名 / 跟随 / 移除都走整表重绘 + `onChange` | `apps/viewer/src/replay/trackpanel.ts:116`、`apps/viewer/src/replay/trackpanel.ts:182` |
| 时间轴按播放窗口换算叠加带 | 两条带的百分比基准都是 `(t − rangeStart) / (rangeStop − rangeStart)` | `apps/viewer/src/replay/timeline.ts:287` |
| 帧读数分段 | 有头部元信息时按 `idx` 比 `preFrames` 与 `preFrames + frameCount` 标 `pre` / `run` / `post` | `apps/viewer/src/replay/timeline.ts:344` 到 `apps/viewer/src/replay/timeline.ts:350` |
| 快捷键不抢输入焦点 | `isTypingTarget` 命中 INPUT / TEXTAREA / SELECT / contentEditable 时全部不响应 | `apps/viewer/src/replay/timeline.ts:197`、`apps/viewer/src/replay/timeline.ts:354` |

## 已知缺口

1. **A-B 区间带恒不显示**：`refreshZones` 的区间带分支条件是「显式设了区间且窗口不是整段」（`apps/viewer/src/replay/timeline.ts:290`），而该分支下窗口端点就是区间端点（`rangeStop` 由 `Math.min(rangeEnd, duration)` 得出，`apps/viewer/src/replay/player.ts:50`），于是宽度算式 `(Math.min(rangeStop, dur) − rangeStart) / winLen × 100`（`apps/viewer/src/replay/timeline.ts:292`）的分子恒等于分母 `winLen`（`apps/viewer/src/replay/timeline.ts:280`）⇒ `width ≡ 100`，落不进 `width > 0.05 && width < 99.95` 的绘制条件（`apps/viewer/src/replay/timeline.ts:293`），只会走 `display = 'none'`（`apps/viewer/src/replay/timeline.ts:298`）。区间读数行本身照常更新（`apps/viewer/src/replay/timeline.ts:256`），只有滑杆上的金色带画不出来。
2. **`ReplayPlayer` 两个成员零调用点**：`horizontalSpeed`（`apps/viewer/src/replay/player.ts:239`）与静态方法 `sampleClipAt`（`apps/viewer/src/replay/player.ts:244`）在 `apps/viewer/src` 内都没有调用者——遥测 HUD 自己算 `Math.hypot(s.vel[0], s.vel[2])`（`apps/viewer/src/ui/telemetry.ts:105`），而按 clip 内部时间采样由 `TrackSet.sample` 直接调 `sampleClip`（`apps/viewer/src/replay/tracks.ts:125`）。
3. **`sampling.ts` 的两个插值原语只在本文件内使用**：`lerpAngle`（`apps/viewer/src/replay/sampling.ts:14`）与 `lerp`（`apps/viewer/src/replay/sampling.ts:20`）虽被导出，但全仓的消费点都在同文件的 `sampleClip` 内（`apps/viewer/src/replay/sampling.ts:64` 到 `apps/viewer/src/replay/sampling.ts:80`）。
4. **时间轴两条 `title` 文案与默认播放窗口矛盾**（代码字面量级，改注释解决不了）：`runZone` 与时间读数行的文案写「prerun 不在播放区间」（`apps/viewer/src/replay/timeline.ts:46`、`apps/viewer/src/replay/timeline.ts:96`），而默认窗口起点取 `Math.min(0, t[0])`（`apps/viewer/src/replay/player.ts:124`）、时间轴起点即该值（`apps/viewer/src/replay/player.ts:106`），`localTime` 只在早于片头时返回 null（`apps/viewer/src/replay/tracks.ts:118`）⇒ prerun 帧会被采样并按第一人称播放；自检夹具的 `preFrames` 实测为 113（`apps/viewer/test/replay-selftest.ts:198`），其 `t[0]` 按公式为负（`apps/viewer/src/replay/shavit-replay.ts:470`）。
5. **正式跑段高亮的宽度混基**：左端用 `rel(track.offset)`（主时钟基准），宽度算式里被减数是轨道内部时间 `track.clip.t` 上的帧时间、减数却含全局 `track.offset` 且只出现一次（`apps/viewer/src/replay/timeline.ts:312` 到 `apps/viewer/src/replay/timeline.ts:313`）⇒ `Track.offset ≠ 0`（轨迹面板的偏移输入框可写，`apps/viewer/src/replay/trackpanel.ts:200`）时位置与宽度会偏。
6. **`disposeTree` 不释放轨迹线与 tick 点**：`clear()` 对每条轨道的五个对象都调 `disposeTree`（`apps/viewer/src/replay/visuals.ts:118`），而该函数只处理 `isMesh` 的节点（`apps/viewer/src/replay/visuals.ts:242`）⇒ `THREE.Line`（轨迹线）与 `THREE.Points`（tick 点）的几何与材质在每次 `setTracks` 重建时都不释放，反复换录像会累积 GPU 资源。
7. **`createObjectURL` 未配对 `revokeObjectURL`**：以 Blob URL 起 Worker 时创建的对象 URL 没有回收点（`apps/viewer/src/replay/importer.ts:87`），每次重新起 Worker 泄漏一个 blob URL。
8. **导入没有超时与取消**：`postMessage` 成功而 Worker 不回消息时 `import` 的 Promise 永不结算（`apps/viewer/src/replay/importer.ts:135`），面板 `busy` 保持为真，后续导入请求全部被丢弃（`apps/viewer/src/replay/panel.ts:286`）。
9. **`ReplayImporter.dispose()` 零调用点**：`apps/viewer/src/replay/importer.ts:159` 提供终止 Worker 与清空 pending 表的能力，本工程没有调用者（页面卸载也不清理）。
10. **`TrackPanelOptions.onPresence` 永远不会被调用**：`TrackPanel.refresh` 每次都会 `?.` 调用它（`apps/viewer/src/replay/trackpanel.ts:119`），但唯一构造点在 `ReplayPanel` 里只传了 `onChange` 与 `onCleared`（`apps/viewer/src/replay/panel.ts:105` 到 `apps/viewer/src/replay/panel.ts:108`）。
11. **`Track.offset` 只有下界没有上界**：偏移输入框只用 `Number.isFinite` 挡非法值，然后 `Math.max(0, n)`（`apps/viewer/src/replay/trackpanel.ts:197` 到 `apps/viewer/src/replay/trackpanel.ts:200`）⇒ 可以写入任意大的偏移，主时钟总长随之被拉长（`apps/viewer/src/replay/tracks.ts:106`），而时间轴与总时长读数都按该值显示。
12. **零帧轨道的口径不一致**：`visuals.setTracks` 对 `Clip.count = 0` 的轨道直接跳过、不建对象（`apps/viewer/src/replay/visuals.ts:133`），而轨迹列表仍为它渲染一整行卡片（`apps/viewer/src/replay/trackpanel.ts:137`）⇒ 这类轨道在列表里可操作、在 3D 里无对应物。
13. **`ReplayVisuals.hasTracks()` 零调用点**：`apps/viewer/src/replay/visuals.ts:111` 提供的判据在 `apps/viewer/src` 内无读取者（时间轴与遥测各自用轨道数判断）。
14. **`ShavitParseResult.flags` 与 `frameStart` 在运行期无消费点**：解码逐帧写入 `flags`（`apps/viewer/src/replay/shavit-replay.ts:507`）并随结果返回（`apps/viewer/src/replay/shavit-replay.ts:259`），但 `Clip` 契约里没有该字段（`apps/viewer/src/replay/types.ts:110` 到 `apps/viewer/src/replay/types.ts:137`）、Worker 载荷也不含（`apps/viewer/src/replay/protocol.ts:12` 到 `apps/viewer/src/replay/protocol.ts:27`）⇒ 它只在自检里被读（`apps/viewer/test/replay-selftest.ts:262`）；`frameStart` 同理（`apps/viewer/src/replay/shavit-replay.ts:264`，自检 `apps/viewer/test/replay-selftest.ts:233`）。
15. **进度回调里的 `'map'` 分支不可达**：`runImport` 的进度回调只对 `phase === 'parse'` 写状态行（`apps/viewer/src/replay/panel.ts:299`），而 Worker 侧只有两处进度发送且都写死 `phase: 'parse'`（`apps/viewer/src/worker/main.ts:66`、`apps/viewer/src/worker/main.ts:84`）⇒ 协议里声明的 `'map'` 阶段（`apps/viewer/src/replay/protocol.ts:47`）在本仓没有发送方。
16. **`ImportResult.resolvedPath` 与导出类型无外部消费者**：`resolvedPath` 由 Worker 回包透传（`apps/viewer/src/replay/importer.ts:150`），`apps/viewer/src` 内无读取点；`ImportPhase` / `ProgressFn`（`apps/viewer/src/replay/importer.ts:35`、`apps/viewer/src/replay/importer.ts:37`）只作为本文件内部签名使用；`TRACK_PALETTE`（`apps/viewer/src/replay/tracks.ts:25`）只被同文件的 `add` 消费（`apps/viewer/src/replay/tracks.ts:51`）。
17. **两处只能追到文字层面的引用**：tick 点开关的 `title`（代码字符串）写「同 debug 权威帧节点」（`apps/viewer/src/replay/timeline.ts:160`），而两个工程的节点样式之间没有共享代码或共享常量；朝向映射提示里的 `cos=0.9992`（`apps/viewer/src/replay/panel.ts:128`）在本仓找不到产出它的脚本或数据。
18. **`panel.ts` 两处提示文案与实现口径不一致**（代码字符串）：平移输入框的 `hint` 写「默认 0」而同一处 `step` 给的是 10 HU（`apps/viewer/src/replay/panel.ts:143` 到 `apps/viewer/src/replay/panel.ts:144`）；文件选择按钮的 `title` 写「零配置直入」（`apps/viewer/src/replay/panel.ts:100`），而 `accept` 只列 `.replay`（`apps/viewer/src/replay/panel.ts:87`），另两条入口（拖拽与 URL 深链）在 `apps/viewer/src/app.ts:340` 与 `apps/viewer/src/app.ts:446`。
