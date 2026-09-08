# viewer 实现细节 · 录像回放系统（src/replay/ + worker/ + ui/replaymeta.ts）

> viewer 回放建立在一条固定管线上：**Shavit `.replay` 原生解析（二进制 → 定标映射）→ Clip（定型数组）→ 播放**。
> 播放器只认 Clip；播放基准 = **帧自身坐标**（解码仅做坐标映射，任何平移/旋转都只能由用户显式叠加）。
> 格式规格与字节级实测见 [shavit-replay-format.md](shavit-replay-format.md)，总览见 [../overview.md](../overview.md)，
> 时序见 [../sequences.md](../sequences.md)。
> ⚠ t4 起 JSON/规则脚本通道已整体移除（`codegen.ts` / `rule-file.ts` / `default-rule.ts` / `sample.ts` 已删，
> 非法嗅探明确报错）。本文按数据流顺序展开 14 个模块（`src/replay/` 13 个 + `worker/parse-worker.ts`），论断标注 `文件:行号`。

## 1. 数据契约层（`viewer/src/replay/types.ts`，164 行）

### 1.1 规则配置 RuleConfig v2（`types.ts:38-54`，默认 `defaultRule` `types.ts:51-54`）

原生结构化规则——只有「坐标映射切换 + 人工变换微调」两组旋钮（v1 的 scriptSrc/framePath 等 30+ JSON 字段已随脚本通道删除，`types.ts:39-40` 注释）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `version` | `2` | 持久化版本号（v2 = 原生规则；v1 键载入时清除） |
| `name` | string | 规则名（持久化用，默认「内置默认」） |
| `axesMode` | `'shavit' \| 'raw'`（`types.ts:22-28`） | 坐标轴映射：`shavit`（默认）= Source `[x,y,z]` → viewer `[y,z,x]`（与 wasm `rotate_yup` 同构，det=+1）；`raw` = `[x,y,z]` 直读（对照项） |
| `yawMode` | `'shavit' \| 'raw'`（`types.ts:30-36`） | 朝向轴：`shavit`（默认）= `yaw = wrap(srcYaw+180)`、`pitch = −srcPitch`（实测定标，见 §2.7）；`raw` = 角度直读 |
| `transform?` | `RuleTransform { offset, yawDeg }`（`types.ts:11-20`） | 人工微调，**仅用户显式设置时非恒等**，解码输出之后统一施加（§3.2） |

### 1.2 Shavit 头部元信息 `ReplayHeaderMeta`（`types.ts:56-101`）

解析器回传的头部契约（replay-file.inc FINAL 字段；V2 无对应字段 → 0/null），字段/顺序/语义对齐
[shavit-replay-format.md §2](shavit-replay-format.md)：`version`（FINAL 版本；V2=0）、`format`（'final'|'v2'）、
`map`（基础名，不带 `_N` 后缀）、`style`、`track`（0=主图，>0=bonus N）、`preFrames`/`frameCount`/`postFrames`/`totalFrames`、
`time`（头部 fTime 官方成绩；V2 → null）、`steamId` + `steamIdDisplay`（`[U:1:<id>]`；**文件无玩家名**）、
`tickrate`（V2/<v5 头部无该字段 → **128 估算**并出 warning，不静默）、`zoneOffset[2]`（亚 tick 份额，∈[0,1]，非秒）、
`stage`、`timestamp`（创纪录 Unix 秒；<v12 用文件 mtime 兜底）、`offsetsLength`（fail-replay 记录数+1）。

### 1.3 Clip（`types.ts:103-132`）与 Track（`types.ts:143-158`）

- `Clip`：`id/name/count`、`t` Float64Array（n，秒）、`pos/ang/vel` Float32Array（3n，vel 可 null）、`duration`（= 末帧 t）、
  `bbox`、`maxSpeed`、`resolvedPath`（原生路径恒 `'.replay'`，`shavit-replay.ts:577`——导入来源标识）、
  `rule`（生成这份 clip 的规则快照）、**`buttons`** Int32Array（逐帧 IN_* 按键掩码，仅原生路径填充，`types.ts:125-129`）、
  **`meta`**（§1.2，`types.ts:130-131`）。全部定型数组 → Worker 零拷贝回传（§4）。
- `Track` = `clip + { id, name, color, visible, offset }`——`offset`（秒）把本轨第 0 帧对到主时钟某刻（对齐起跑不同的多轨对比）。
- `Sample` / `TrackSample`（`types.ts:134-141, 160-164`）：采样结果与「某轨在主时钟 t 的采样（未开始/已播完 → null）」。

## 2. 原生 .replay 解析器（`viewer/src/replay/shavit-replay.ts`，584 行）

规格依据 = [shavit-replay-format.md](shavit-replay-format.md)（t2 研究 + 真实文件逐字节验证），本节只记行为锚点。

### 2.1 嗅探与头部行（`shavit-replay.ts:42-138`）

- 常量：`SHAVIT_MAGIC = '{SHAVITREPLAYFORMAT}'`（`:42-43`）、`SHAVIT_MAX_VERSION = 0x0C`（`:45-46`，更高版本明确拒绝）、
  `SHAVIT_SNIFF_BYTES = 64`（`:48-49`，与 shavit 读侧 `ReadLine(64)` 同宽）、`NT_STRING_MAX = 256`（`:58-59`）。
- `looksLikeShavitReplay(head)`（`:63-79`）：前 64 B 内逐字节搜魔数（latin1 比对，不依赖文本解码）。
- `fileLooksLikeShavitReplay(file)`（`:81-89`）：`file.slice(0,64)` 读头嗅探；读失败按「不是 .replay」处理。
- `parseHeaderLine`（`:101-138`）：找首个 `\n`（无 → 报「第 1 行缺失」）；`:` 前必须是非负整数；
  后半 = `{SHAVITREPLAYFORMAT}{FINAL}` → FINAL（数字 = **格式版本**）或 `{V2}` → V2（数字 = **帧数**，注释 `:95-99`）；
  含魔数的其他标签 → 「不支持的 Shavit 回放格式……viewer 只支持 FINAL / V2」（远古文本/btimes 不支持）；
  不含魔数 → 「不是有效的 Shavit .replay」。

### 2.2 FINAL 头部解析（`parseShavitReplay`，`shavit-replay.ts:257-382`）

游标式读取（`ByteReader`，`:142-201`，每步带边界检查与截断报错）：版本护栏（`:279-283`）→ sMap NUL 字符串 →
style/track（≥v3）→ preFrames/frameCount/fTime → steamID（≥v4）→ postFrames（≥v5）→ tickrate（≥v5，≤0 报「损坏」）→
zoneOffset[2]（≥v8）→ stage（≥v10）→ timestamp（≥v12，缺失时用调用方 `timestampFallback` = File.mtime）→
offsetsLength（≥v11，≥2 时**跳过** `(n−1)×12` B offsets 区，`:336-339`）。

兼容修正（对齐 RFC 读侧）：负 preFrames 归零；`v < 0x07` frameCount 读侧减 pre（以及 ≥v5 时减 post）；
帧区长度按 `frameStart + N×cellBytes` 与文件大小闭合校验（截断 → 报错、尾多字节 → warning，`:344-353`）。
头部没有 tickrate 时（V2 / <v5）用 `FALLBACK_TICKRATE = 128`（现代 bhop 服务器主流值）并产生明确 warning（`:51-56`）。

### 2.3 V2 兼容（`parseV2`，`shavit-replay.ts:384-437`）

第 1 行 `<帧数>:{SHAVITREPLAYFORMAT}{V2}` + 定长 6-cell 帧（pos3+ang2+buttons）、无二进制头——版本按 0 处理复用解码路径；
`meta` 各字段取 0/null、tickrate 用 128 估算 + warning。

### 2.4 帧解码（`decodeFrames`，`shavit-replay.ts:445-528`）

- 定长帧 `cellBytes = cells×4`（`cellsForVersion`，`:244-251`：≥v10 = 11 cell；≥v6 = 10；≥v2 = 8；否则 6）。
- 每帧读 `pos[3] f32 → pitch/yaw f32 → buttons i32 → flags u32`（`:466-472`；flags 按 u32 读，CS2 高位 bit 保位型，`:473-474`）。
  cells ≥10 的 mousexy/packed vel、≥11 的 stage **不读不输出**——packed vel 是按键 wishmove 不是世界速度（`:475-476`）。
- 坐标/朝向映射（受 `mapping.axesMode/yawMode` 控制，`:478-507`）：
  `shavit`（默认）= pos `[y,z,x]` + `ang=[wrap(yaw+180), clampPitch(−pitch), 0]`；`raw` = Source 值直读。
- 脏数据兜底：NaN/Inf 帧沿用上一帧的值并计数进 warnings（`:486-487, 510-511`）。
- 世界速度：**位置差分 × tickrate**（中央差分、端点单侧差分，`:513-526`）填 `vel`。
- 时间轴：`t(i) = (i − preFrames)/tickrate`（`buildTimeArray`，`:439-443`）——prerun 为负、单调，**主时钟 0 = 起跑帧**。

### 2.5 坐标定标（为何 +180）

Source 前向 `(cos yaw_s, sin yaw_s)` 在 `[y,z,x]` 映射下落入 viewer 前向定义 `(−sin yaw_v, −cos yaw_v)`，
恒等式 ⇔ `yaw_v = wrap(yaw_s + 180)`。实证：真实 `surf_null_4.replay` run 段 1078 个有效帧
「视角·运动方向」平均 cos = **0.9992**（270− 口径同帧集 ≈ 0.05）；断言固化于
`test/replay-selftest.ts:286-307`（run 段平均 cos > 0.98）与合成 fixture（src yaw=30 → viewer 210，`replay-selftest.ts:381-386`）。
`pose.ts:23-25 bspYawToCsYaw`（t1 起同为 `wrap(src+180)`，F6 镜像已修）服务 BSP 出生点实体角路径
（初始视角 `core/spawn.ts:47-50` / 面板跳转 `mapinfo.ts:144-161`）——与 .replay 解码**同一定标**，
全链统一口径。详见 [shavit-replay-format.md §8.2](shavit-replay-format.md)。

### 2.6 Clip 适配（`clipFromShavitReplay`，`shavit-replay.ts:536-584`）解析数组做**拷贝**（transform 原地后处理、parsed 结果保持可复用）→ 复算 `bbox`/`maxSpeed` → 组装 Clip
（`resolvedPath='.replay'`、`meta=header`、`buttons`）→ `applyClipTransform(clip, rule.transform)`（§3.2）→ 返回 `{clip, warnings}`。

## 3. 角度工具与变换后处理

### 3.1 角度工具（`viewer/src/replay/helpers.ts`，17 行）

JSON 时代的助手集已随脚本通道删除，只剩两个纯函数：`wrapDeg`（角度归一 [0,360)，`:8-11`）、
`clampPitch`（限幅 ±89°，常量 `PITCH_LIMIT_DEG` 来自 `core/constants.ts`，`:13-17`）。

### 3.2 人工变换微调（`viewer/src/replay/build.ts`，72 行）

- `LARGE_CLIP_FRAMES = 100_000`（`:11-12`）：超过按「大文件」提示合并/精度说明。
- `applyClipTransform(clip, tf)`（`:24-72`）：**恒等变换（全零）直接跳过**（`:28`）；绕 Y 旋转 θ 时
  pos/vel 用标准 Y 旋转且 yaw 同步 +θ（与「朝向加 θ」自洽，`:30-55`），再统一平移；旋转后 bbox 全量重算（`:58-71`）。
  平移/旋转只作用于**用户显式设置**的调整工具——这不是锚定，没有自动触发。

## 4. Worker / 导入层

### 4.1 消息协议（`viewer/src/replay/protocol.ts`，35 行）

- `ClipPayload`（`:6-21`）：可转移形态（定型数组零拷贝），含 `buttons/meta`（`:17-20`）。
- `ParseRequest`（`:23-30`）：`file` 传 null = 复用 Worker 内已缓存的上一份文件（改映射/变换不重读盘）。
- `ParseResponse`（`:32-35`）：`progress`（parse 阶段进度）/ `done`（payload + warnings + resolvedPath）/ `error`。

### 4.2 解析 Worker（`viewer/src/worker/parse-worker.ts`，110 行）

原生唯一导入路径：**先魔数嗅探（在 `file.text()` 之前——文本解码会破坏二进制，`:44-49`）** → 字节缓存
（重导重新解码，缓冲区已 transfer 不能复用，`:25-27, 52-61`）→ `parseShavitReplay`（入参
`timestampFallback` = File.mtime、`mapping` = 规则的两档切换，`:63-68`）→ `clipFromShavitReplay` → transfer 回传
（t/pos/ang/vel/buttons 五个 buffer，`:73-85`）。嗅探不命中 → 明确报错
「不是 Shavit .replay——viewer 只支持 Shavit 原生 .replay（JSON/规则脚本通道已移除）」。

### 4.3 导入器（`viewer/src/replay/importer.ts`，176 行）

- `ensureWorker`（`:39-79`）：单文件（file://）构建时 Worker 代码内嵌 `__VBSP_WORKER_JS__` → Blob URL 启动
  （`:42-52`）；否则 module Worker。起不来 → `workerBroken` + 全部 pending reject（`:64-72`）。
- `import(file, rule, name)`（`:90-110`）：优先 Worker；`__NO_WORKER__` / workerBroken → **主线程回退**。
- `importOnMain`（`:118-152`）：与 Worker **同源**的同一条链路（嗅探 → 字节缓存 → 原生解析 → Clip），
  两处 import 同一批函数（`parse-worker.ts:10-14` vs `importer.ts:3-7`），行为一致。
- `payloadToClip`（`:159-176`）：payload + rule → Clip（id 时间戳命名）。

### 4.4 三个导入入口（均先嗅探）

| 入口 | 位置 | 说明 |
|---|---|---|
| 面板「选择录像文件…」 | `panel.ts:63-82` | `accept='.replay'`；换文件 → `loadFile`（§7.1） |
| 全窗拖拽 `.replay` | `app.ts:286-304`（`.replay` 分支 `:295-300`） | 拖入即导入并自动切到录像页 |
| URL 深链 `?replay=` | `app.ts:368-405`（`:381-391`） | 直接 `arrayBuffer()` + `looksLikeShavitReplay`（不按文本读）；`?rule=` 参数已删 |

## 5. 播放器与多轨迹

### 5.1 轨道集合（`viewer/src/replay/tracks.ts`，110 行）

`TRACK_PALETTE`（`:12`）固定配色轮转；`add`（第一条自动成为跟随目标，`:31,40`）、`replaceClip`
（改映射/变换重导 = 原位替换，`:49-54`）、`remove`（清跟随指针，`:57-60`）、`follow`（缺省第一条，`:74`）、
`setFollow`（`:78`）、`duration`（各轨 offset+时长最大值，`:85`）、`sampleAll`（`:107`）。

### 5.2 播放器（`viewer/src/replay/player.ts`，206 行）

持有**主时钟**与轨道集合，只认 Clip（`PlayMode = 'first' | 'third'`，`:14`）。状态读数：`duration`（`:39`）、
`rangeStop/rangeLength/ratio`（A-B 区间语义，`:44-56`）。控制：`load`（清空后单条，旧语义，`:61`）、
`addTrack`（多轨对比；第一条复位时钟与区间，`:69-77`）、`removeTrack/clearTracks`（`:77-86`）、
`followTrack`（切第一人称跟随/速度读数来源，`:88-92`）、`play/pause/toggle/stop/seek/seekRatio`、
`stepFrames`（逐帧，`:137-146`）。采样：`indexAt`（二分，`:167`）、`sample/sampleAt`（插值，`:176-183`）、
`sampleAll`（全轨，`:185-187`）。

### 5.3 采样纯函数（`viewer/src/replay/sampling.ts`，80 行）

`lerpAngle`（yaw/roll 走**最短弧**，`:11-14`）、`lerp`、`indexInClip`（二分查找，`:24-39`）、
`sampleClip`（插值组装 Sample，`:41-75`）、`horizontalSpeed`（HUD 速度读数，`:77-80`）。

### 5.4 播放基准（t4 修复）

- 帧自身坐标直读为唯一默认：解析产出即渲染坐标，**无起点锚定、无自动平移**（t4 已删
  `computeStartAid/refreshStartAnchor/applyAnchor` 全链）。
- 「调整工具」（§3.2）与「坐标映射」切换仅在**用户显式设置**时叠加；改设置 = 替换当前轨道（§7.1）。
- HUD「轨迹完全落在地图包围盒外」检查保留（`app.ts:157-188`）——正确的 .replay 触发它说明映射不对，
  应修「坐标映射」切换而不是平移。

## 6. 3D 可视化（`viewer/src/replay/visuals.ts`，174 行）

每条轨道一套「轨迹线 + 幽灵实体 + 起终点标记」（`:1`）。`setTracks`（轨道增减后整体重建，`:29`）、
`update`（每帧采样驱动；第一人称只隐藏**被跟随**轨、其余照常显示，`:41-44`）。轨迹线：顶点 +8 HU 抬升
（`:116, 124`）、超 `MAX_TRAIL_POINTS = 40000` 等间距抽稀（`:10, 110`）、`frustumCulled=false`（`:131`）；
幽灵 = Capsule + 朝向 Cone（`:140, 147`）；`disposeTree` 递归释放（`:165`）。

## 7. UI 面板层

### 7.1 录像面板（`viewer/src/replay/panel.ts`，318 行）

- **导入**分区（`:63-82`）：「选择录像文件…」（`accept='.replay'`）。
- **坐标映射**分区（`:90-109`）：两个 checkField——「坐标轴映射：标准 ↔ 直读 `[x,y,z]`」与
  「朝向轴映射：实测定标（yaw+180、pitch 取反）↔ 角度直读」（title 带定标证据）；切换即 `setAxesMode/setYawMode`
  → 保存 + **重导替换当前轨道**（`:204-224`）。
- **调整工具**分区（`:111-158`）：offset X/Y/Z + yaw°（±15° 步进）+ 重置；改动 500ms 防抖后重导
  （`applyTransformFromInputs`，`:287-301`）；默认折叠，**不再自动展开**。
- **换文件 = 追加轨道；改映射/变换 = 替换当前轨道**：`lastTrackId` 复用机制（`:36-41, 228-282`）。
- 持久化：`STORAGE_KEY = 'websurf-viewer.replay-rule.v2'`（`:17`），载入校验 `version===2` + 枚举值，
  非法即丢弃回默认；旧 `…v1` 键载入时清除（`:162-187`）；写失败静默（隐私模式，`:189-195`）。

### 7.2 轨迹面板（`viewer/src/replay/trackpanel.ts`，214 行）

每轨一行（显隐/配色/名称/时间偏移/跟随/移除）+ 批量操作（全部显示/全部隐藏/偏移归零/清空全部，
仅在有轨道时出现，`:47-79`）；清空回调 `onCleared`（`:206`）。

### 7.3 时间轴（`viewer/src/replay/timeline.ts`，342 行）

三行结构（`:1-10`）：上行 = 进度条（**正式跑段高亮带**按 `Clip.meta.frameCount` 定位 + A-B 区间金框叠加，
`:42-50, 292-312`）；中行 = 播放/停止/逐帧/时间·帧读数/倍速选择器（8 档 0.1–16，`SPEEDS`，`:17-18`）；
下行 = 视角与显示开关 + A-B 区间读数 + 速度读数。帧读数语义（`:321-334`）：跟随轨第 idx 帧 →
`n/总数 帧 · pre | run k/frameCount | post`（run 段定位，多轨/pre 边界下明确）。快捷键 K/,/./I/O（`:189-209`）。

### 7.4 录像信息条（`viewer/src/ui/replaymeta.ts`，107 行）

底部 dock 常驻展示 `Clip.meta`（数据链：`syncTracks` → `setTracks(tracks, followId)` → 逐字段渲染，`:19-29`）：
成绩 fTime（title 带 zoneOffset 闭环说明）/ 玩家 `[U:1:<id>]`（无玩家名不硬造）/ 地图·Bonus track /
风格 / tick / 帧段（title 带 stage）/ 日期（本地 YYYY-MM-DD）/ 格式版本（title 带 offsets 记录数）。
缺失字段不出该项（V2 无成绩不渲染）；静态字段只在轨道增删/跟随切换时重渲染（`:1-7`）。

### 7.5 装配与对外 API（`viewer/src/app.ts`，496 行）

- 接线（`:102-149`）：`importer/player/visuals`（`:102-104`）→ `ReplayPanel`（回调 `onClip/onClearAll/onTracksChanged/onStatus`，
  **无 getStartAid**，`:117-146`）→ `ReplayMetaPanel`（`:148`）→ `Timeline`（`:149`）；`syncTracks` 统一同步
  3D 可视化/时间轴/信息条（`:109-114`）。
- HUD 跨面提醒 `updateReplayMapStatus`（`:157-188`）：轨迹 bbox 完全在地图包围盒外 → 提醒修「坐标映射」。
- `window.viewer.replay`（`app.ts:343-398`）：内省（trackCount/duration/time/playing/speed/mode/followId/tracks()）+
  控制（play/pause/seek/setSpeed 0.1–16/setMode/follow）+ **`meta()`**（跟随轨头部元信息，`:369-370`）。
  getter 每次返回新快照（自动化注意：取值后对象即快照）。

## 8. 测试

### 8.1 Node 自检 `test/replay-selftest.ts`（831 行，153 项，`npm run test:replay`）

8 节：`[1]` 角度工具（`:44`）→ `[2]` **真实文件** `maps/surf_null_4.replay` 原生解析（fixture `:58`、大小 53365 B、
嗅探命中/排除 JSON、header 14 字段、帧 0 字节级断言、zoneOffset 闭环复算 fTime `:210-214`、朝向自洽
run 段 cos `:286-307`、Clip/播放器/transform `:310-368`）→ `[3]` 坐标映射切换（synthetic fixture 双档断言 + 头部/时间轴不受映射影响，`:372-472`）→
`[4]` 播放器采样（`:474`）→ `[4b]` A-B（`:503`）→ `[5]` 多轨迹（`:523`）→ `[6]` transform 后处理（`:594`）→
`[7]` 脏数据兜底（`:649`）→ `[8]` 异常输入 11 类（截断/版本护栏/V2 帧数语义/远古格式/负 pre/tickrate≤0/无 run 帧/v11 mtime 兜底…，`:668-828`）。
fixture 构造器 `buildFinalFixture/buildV2Fixture`（`:99-166`）按版本门槛拼字节。

### 8.2 真浏览器冒烟 `test/smoke-cdp.mjs`（690 行，CDP 驱动 headless）

`[0]` dist 结构静态断言（单文件/内嵌/无 .json 残留，`:127-…`）→ `[1]/[1b]` 页面加载与 localStorage 卫生
（`:240, 257`）→ `[2]` 面板分区 → `[3]` 导入真实 .replay → `[3b]` 头部元信息条断言（成绩/玩家/地图·Bonus/tick/帧段/v12 + meta() API，`:327`）→
`[3c]` 播放基准（firstPos = 解析帧 0、无锚定平移，`:353`）→ `[4]` 播放 → `[5]` A-B → `[6]` 场景对象 →
`[7]` 调整工具（替换而非追加，`:413`）→ `[7b]` 同文件再选 = 追加第二轨（`:453`）→ `[8]` 时间偏移 →
`[9]` 拖入合成 V2 .replay（DataTransfer drop 链路，`:489`）→ `[9b]` 坐标映射切换实测（`[20,30,10]↔[10,20,30]`，`:520`）→
`[10]` 跟随切换与信息条同步（`:559`）→ `[11]` 播放控制 API（`:606`）→ `[12]` ReferenceGrid 已移除 + 出生点导航在位（`:651-664`）→
`[13]` 全程 console 零 error（`:671`）。

## 9. 回放侧坐标与 yaw 约定（约定即代码）

- 标准帧 `pos` = 脚底（Y-up）；相机眼位 = pos + 64.09（`fly.ts:174-177`）。
- `ang[0]` yaw：0 = 面朝 −Z，逆时针为正（`pose.ts:5-9`；第一人称相机 `fly.ts:174-177` `rotation.set(pitch, yaw, roll, 'YXZ')`）。
- `.replay` 帧的换算定标以**可执行断言**固化（§2.7 + [shavit-replay-format.md §8.2](shavit-replay-format.md)）：
  `pos: [x,y,z]→[y,z,x]`、`yaw = wrap(src+180)`、`pitch = −src`；`vel` = 位置差分（packed vel 不映射）。
- BSP 出生点实体与 .replay 解码**同一 yaw 定标**（`pose.ts:23-25 bspYawToCsYaw` = `wrap(src+180)`；t1 已修
  旧式 270− 的 det=−1 镜像，评审 F6 闭合）；初始视角另有 P2-4 回退链（`core/spawn.ts:79-101`：
  spawn 实体 → bbox 内传送目标 → bbox 高位俯瞰）。
