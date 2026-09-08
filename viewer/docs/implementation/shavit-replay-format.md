# Shavit `.replay` 二进制格式规格（viewer 原生解析依据）

> **以代码为准**。本文所有字段/顺序/语义均逐条对齐源码，并用仓库真实文件 `maps/surf_null_4.replay` 逐字节验证（§6）。
>
> 来源（2026-09-08 抓取）：
> - 任务指定规格库 **bhopppp/Shavit-Surf-Timer** master @ `3e95351034e320037057aab65a948988219903bf`
>   - `addons/sourcemod/scripting/include/shavit/replay-file.inc`（格式本体，下称 RFC）
>   - `addons/sourcemod/scripting/shavit-replay-recorder.sp`（录制语义）
>   - `addons/sourcemod/scripting/shavit-replay-playback.sp`（回放/时间语义）
> - 上游 **shavitush/bhoptimer** master @ `e4382c4d32fd24fdefb9b3816636968aa2ee3cce` 的 `replay-file.inc` 同为 `REPLAY_FORMAT_SUBVERSION 0x0c`，线上字节格式一致（实现细节有差异，不影响解析）。

## 1. 总览

- 三代格式：**FINAL**（现行，`REPLAY_FORMAT_SUBVERSION` 0x01…0x0C）、V2、远古文本（含 btimes）。viewer 实现 = **FINAL + V2**（远古文本明确报错，见 §9）。
- 所有文件**小端**（SourceMod 原生序），无压缩。结构 = 头部（1 行 ASCII + 二进制字段）→ 可选 offsets 记录区 → 定长帧数组。
- **一帧 = 一个服务器 tick**。
- 格式识别：文件前 64 字节内可按第 1 行 `TrimString` 后按 `:` explode；后半为 `{SHAVITREPLAYFORMAT}{FINAL}` → FINAL；为 `{SHAVITREPLAYFORMAT}{V2}` → V2；否则远古格式（viewer 明确报错不支持即可）。

## 2. 头部（FINAL）

第 1 行 ASCII：`"<版本十进制>:{SHAVITREPLAYFORMAT}{FINAL}"` + `\n`（LF；写侧 RFC:424 `WriteLine("%d:" ... REPLAY_FORMAT_FINAL, REPLAY_FORMAT_SUBVERSION)`；读侧 RFC:288-306 `ReadLine(64)` + `TrimString`（容忍 `\r\n`）+ 按第一个 `:` explode；版本 = `StringToInt(exploded[0])`，`REPLAY_FORMAT_SUBVERSION = 0x0C`，RFC:45）。

**冒号前的整数是「格式版本号」的十进制字面量**（0x0C → `"12"`），决定后续二进制头各字段的有无——**不是帧数**（t1 复核点②定稿）。陷阱：V2 行的 `<n>:` 整数含义不同，是**帧数**（RFC:383-386 `header.iFrameCount = StringToInt(exploded[0])`），解析器不得混用。

随后二进制字段，**顺序与类型**（写侧 RFC:422-472 / 读侧 RFC:276-420 逐一对齐）：

| # | 字段 | 类型 | 版本门槛 | 语义 |
|---|------|------|---------|------|
| 1 | sMap | NUL 结尾字符串 | ≥0x03 | 地图**基础名**（不带 `_N`/`_sN` 后缀！`surf_null_4.replay` 内是 `surf_null`） |
| 2 | iStyle | u8 | ≥0x03 | 样式。**位置复核（t1 点①）**：紧跟 map 的 `\0` 之后（本文件 @41=0x00）——写侧 RFC:426-428（`WriteString(sMap)`→`WriteInt8(style)`→`WriteInt8(track)`）、读侧 RFC:311-313、上游同序（upstream `replay-file.inc:385-388`：`pos+=1 跳过 FormatEx 的 NUL` 后立即写 `style`、`track`）三处一致。本文件 style=0 确无字节唯一性，但**位置由源码定死**，@41 不是「填充字节」 |
| 3 | iTrack | u8 | ≥0x03 | 轨道（0=主图，>0=bonus N；本文件 @42=0x04，与文件名 `_4` 后缀互证——若 @41 是「填充、无 style」，track=0 与文件名矛盾） |
| 4 | iPreFrames | i32 | ≥0x03 | 起跑前帧数（prerun，为平滑开局录制）；读侧负值归零（RFC:318-321） |
| 5 | iFrameCount | i32 | 恒有 | 正式跑帧数。写侧 = 总帧 − pre − post（RFC:431）；v<0x07 读侧再减 pre（RFC:327-330） |
| 6 | fTime | f32 | 恒有 | 官方成绩（秒） |
| 7 | iSteamID | i32 | ≥0x04（更早读 `[U:1:x]` 字符串，RFC:336-343） | 账号 ID → 显示名 `[U:1:<id>]`（RFC:268-271）。**文件里没有玩家名** |
| 8 | iPostFrames | i32 | ≥0x05 | 结束后帧数 |
| 9 | fTickrate | f32 | ≥0x05（更早假设 1/GetTickInterval()，RFC:414-417） | tick/s（CS2 15ms → 66.667） |
| 10 | fZoneOffset[2] | f32×2 | ≥0x08 | **亚 tick 份额**（∈[0,1]，单位=tick，**非秒**；t1 点③已按 shavit-core.sp 定稿，详见 §2.1） |
| 11 | iStage | u8 | ≥0x0A | stage（0=非 stage；RFC:362「0x10 版本之前没有 stage replay」注释即指 0x0A） |
| 12 | iTimestamp | i32 | ≥0x0C（更早取文件 mtime，RFC:373-376） | 创纪录 Unix 秒 |
| 13 | iOffsetsLength | u8 | ≥0x0B | fail-replay 偏移记录数+1；写侧 ≤2 记 0（RFC:446-448） |

**Offsets 记录区**（`iOffsetsLength ≥ 2` 时）：紧随头部、帧区之前，共 `(iOffsetsLength − 1)` 条 `offset_info_t = { iFrameOffset i32, iFailureAttempts i32, fReachTime f32 }`（12 B/条；写侧 RFC:458-471 从 i=1 起，读侧 RFC:211-219 对称）。属「无失败重放」数据，viewer **解析跳过**即可。

**读侧兼容修正**（FINAL）：`iReplayVersion < 0x07` → `iFrameCount -= iPreFrames`（RFC:327-330），且若 ≥0x05 再 `-= iPostFrames`（RFC:350-353）；`< 0x03` → style/track 用调用方参数（RFC:408-412）。

### 2.1 zoneOffset 语义（t1 复核点③，按 shavit-core.sp 定稿）

- **定义与单位**：`fZoneOffset[0]`/`[1]` 是玩家在**某个 tick 内**穿过起点区/终点区边界时的 **hull-trace 命中份额**（`TR_GetFraction()`，∈[0,1]，**单位 = tick 份额，无量纲，不是秒**）。来源：shavit-core.sp:4466-4476 `CalculateTickIntervalOffset` → `gA_Timers[client].fZoneOffset[zonetype] = gF_Fraction[client]`，而 `gF_Fraction = TR_GetFraction()`（core.sp:4512）；`Zone_Start=0, Zone_End=1`。
- **官方时间公式**（`CalculateRunTime`，core.sp:2402-2420；cvar `shavit_core_useoffsets` 默认 1，core.sp:484；**冲线时** `include_end_offset=true`，core.sp:2456）：
  `fTime = (fullTicks + fractional/10000 + fZoneOffset[0] − (1 − fZoneOffset[1])) × tickInterval`
  （start 份额补回起跑 tick 内「穿越后→tick 末尾」的部分；end 用 `−(1−份额)` 去掉冲线 tick 内「穿越后→tick 末尾」的部分——0x09 的历史修正即这里，RFC:36。）
- **实测闭环（本文件，精确）**：`1080 + 0.7850947 − (1 − 0.7109927) = 1080.4960874 tick × 0.015 s = 16.207441 s` = 头部 fTime **16.207439**（t1 实测）✓。公式与字节布局两处独立来源互相印证。
- **viewer 启示**：①解析后可用该公式对头部 fTime 做免费完整性校验（t3 fixture，容差 ≤1e-3 s；仅当两 offset ∈ [0,1] 时适用——`useoffsets=0` 的服务器可能写 0）；②meta 面板可将其展示为「亚 tick 起终点修正」（可选）。

## 3. 帧区

共 `N = iPreFrames + iFrameCount + iPostFrames` 帧，每帧 `total_cells × 4` 字节（RFC:147-170）：

| 版本 | 帧字节 | cell 构成（cell 号 × 4B，按 frame_t 序 RFC:68-81；t1 点④定稿） |
|------|-------|------------------------------------------------|
| 0x01 | 24 | [0-2] pos[3]、[3-4] ang[2]（pitch,yaw）、[5] buttons |
| 0x02–0x05 | 32 | 上行 + [6] flags、[7] mt |
| 0x06–0x09 | **40** | 上行 + [8] mousexy、[9] vel。⚠ shavit 播放内存只留前 8 cell（RFC:159-164 `used_cells=8`），但**文件里是 10 cell**——解析器必须按 40B/帧消费（mousexy/vel 在文件中存在） |
| ≥0x0A | 44 | 上行 + [10] stage |

`frame_t` 字段语义（录制点：recorder.sp:1020-1037）：

- **pos** = `GetClientAbsOrigin` —— **脚底**位置、**绝对世界坐标**（Source x/y 右手、z 向上）。
- **ang** = `GetClientEyeAngles` —— `[0]=pitch`（正值=低头）、`[1]=yaw`；**无 roll**。
- **buttons** = IN_* 位掩码。`IN_ATTACK=1, IN_JUMP=2, IN_DUCK=4, IN_FORWARD=8, IN_BACK=16, IN_USE=32, …, IN_MOVELEFT=512, IN_MOVERIGHT=1024, IN_ATTACK2=2048, IN_BULLRUSH=1<<22`（§6 已用 vel 交叉验证）。
- **flags** = `GetEntityFlags`（m_fFlags 原始值）——**按 u32 读**：CS2 出现高位 bit（实测 0x00010081 / 0x80010002）。低位沿用：`FL_ONGROUND=0x1, FL_DUCKING=0x2, FL_CLIENT=0x80`。
- **mt** = MoveType（2 = MOVETYPE_WALK）。
- **mousexy** = `mousex | (mousey << 16)`；解包 `UnpackSignedShorts`（RFC:118-122）：`out0=((x&0xFFFF)^0x8000)−0x8000`，`out1=(((x>>>16)&0xFFFF)^0x8000)−0x8000`。
- **vel** = `forwardmove | (sidemove << 16)`，同法解包；±666 截断（recorder.sp `LimitMoveVelFloat`）。⚠ 是 **wishmove（用户指令位移分量），不是世界速度** —— 世界速度须由相邻帧 pos 差 ÷ tickInterval 求导。
- **stage** = `Shavit_GetClientLastStage`（stage 分段标记）。

## 4. 时间模型

- 帧索引 i 的运行时刻：**t(i) = (i − iPreFrames) / fTickrate**；正式跑窗口 = `[iPreFrames, iPreFrames + iFrameCount)`；t<0 = prerun、跑窗之后 = post（shavit 播放端同式，playback.sp:1416；播完钳到 fTime，playback.sp:1411-1413）。
- 头部 **fTime 是官方计时**（= `(frameCount + zoneOffset[0] − (1 − zoneOffset[1])) × tickInterval`，公式与实测闭环见 §2.1），与「帧数÷tickrate」的差即 zoneOffset 净效应（本例 +0.496 tick：实测 16.2074 vs 16.2000）。**展示成绩用 fTime，播放对轴用帧推算**。
- iTimestamp（≥0x0C）= Unix 秒；<0x0C 用文件 mtime（浏览器用 `File.lastModified`）。

## 5. 文件命名（recorder.sp:837, playback.sp:1916）

- WR：`<folder>/<style>/<map>[_<track>][_<sN>].replay` → `surf_null_4.replay` = style 0 的 **bonus track 4**。
- stage：`_s<N>`；备份：`…_d<timestamp>.replay`；copy：`copy/<timestamp>_<steamid>_<map>.replay`。
- ⚠ **文件名后缀是 track/stage，不是地图名的一部分**——地图匹配/展示一律用头部 sMap。

## 6. 真实文件验证（`maps/surf_null_4.replay`，53,365 B）

按本规格写的逐字节解析（Node DataView 小端）输出，全部吻合：

- 第 1 行 `"12:{SHAVITREPLAYFORMAT}{FINAL}"` → version=12 ✓
- map=`surf_null`，style=0，**track=4**（与命名约定互证）
- preFrames=**113**，frameCount=**1080**，fTime=**16.2074 s**，steamid=**196340649** → `[U:1:196340649]`，postFrames=**18**，tickrate=**66.667**，zoneOffset=[**0.7850947, 0.7109927**]，stage=0（@75），timestamp=**1,787,992,447**（=2026-08-29T08:34:07Z，@76-79），offsetsLen=**0**（@80）
- 帧区起点 byte **81**（0x51）；`1211 帧 × 44 B = 53,284`；`81 + 53,284 = 53,365 = 文件大小`——**精确闭合** ✓
- frame[0]（prerun）：pos=(2375.0, 12187.2, −1792.0)，ang=(20.6°, 75.3°)，buttons=8(IN_FORWARD)，flags=0x00010081(ONGROUND|CLIENT)，mt=2，mouse=(−18,−1)，vel=(fw 400, sd 0)
- frame[113]（起跑）：pos=(2670.9, 12091.0, −1786.5)，ang=(58.9°, 1.0°)，buttons=518(JUMP|DUCK|MOVELEFT)，vel=(fw 0, sd −400)
- frame[1210]（末帧）：pos=(6062.6, 12470.5, −2893.1)，ang=(−0.5°, −170.5°)，buttons=512(IN_MOVELEFT)，flags=0x00010080（离地）
- 交叉验证：buttons ↔ packed vel 方向一致（IN_FORWARD↔fw +400；IN_MOVELEFT↔sd −400）✓
- 时长核对：1080 ÷ 66.667 = 16.200 s ≈ fTime 16.2074 s ✓
- zoneOffset 公式闭环：`1080 + 0.7850947 − (1 − 0.7109927) = 1080.4960874 tick × 0.015 s = 16.207441 s` = 头部 fTime 16.207439（t1 实测值）——精确吻合，见 §2.1 ✓
- header 绝对偏移总表（与 t1 §2.2 互证，含 style 位置定稿）：@31-39 `surf_null`、@40 `\0`、**@41 style=0**、@42 track=4、@43-46 preFrames、@47-50 frameCount、@51-54 fTime、@55-58 steamid、@59-62 postFrames、@63-66 tickrate、@67-74 zoneOffset、@75 stage、@76-79 timestamp、@80 offsetsLen → 帧 @81 起

## 7. 浏览器可行性（t3 实现后核验）

- **纯 `DataView` 小端读取即可**（`getInt32/getFloat32/getUint8/getUint32`，全部显式 `littleEndian=true`），零依赖零解压；53 KB→1211 帧毫秒级。无对齐要求（DataView 显式处理非对齐）。实现载体：`src/replay/shavit-replay.ts`（584 行，纯函数、无 DOM 依赖，Node/Worker/主线程三处共用）。
- 路由已实现在 **`file.text()`/`JSON.parse` 之前**：先读前 64 B 嗅探 `{SHAVITREPLAYFORMAT}`（`looksLikeShavitReplay`，`shavit-replay.ts:63-79`；File 形态走 `file.slice(0,64)` 的 `fileLooksLikeShavitReplay`，`:81-89`）。三个导入入口全部先嗅探后解码：Worker `parse-worker.ts:44-49`、主线程回退 `importer.ts:129-134`、深链 `app.ts:381-391`（深链直接 `arrayBuffer()`，不按文本读）。嗅探不命中 → 明确报错「不是 Shavit .replay……（JSON/规则脚本通道已移除）」，不做静默错解。
- 版本护栏已实现：`iReplayVersion > 0x0C` → 明确报错拒绝（`SHAVIT_MAX_VERSION = 0x0C`，`shavit-replay.ts:45-46` + `:279-283`；shavit 同款规则，RFC:132）。

## 8. viewer 实现现状（t3/t4/t5 交付后的代码事实，2026-09）

> 本节由初稿「集成建议」改写为**实现现状**——条目均已落地，锚点以改后代码为准。

### 8.1 解析层

- `src/replay/shavit-replay.ts`：`parseShavitReplay`（`:257-382`）产出 `ShavitParseResult`（header + `t/pos/ang/vel/buttons/flags` + warnings + `frameStart` 诊断，`:222-242`）；`clipFromShavitReplay`（`:536-584`）拷贝数组 → 套 `applyClipTransform` → `Clip`（`resolvedPath = '.replay'`，`meta` = 头部元信息，`buttons` = 逐帧按键掩码）。
- 头部 meta 契约 = `ReplayHeaderMeta`（`types.ts:62-101`）：version / format('final'|'v2') / map(基础名) / style / track / preFrames / frameCount / postFrames / totalFrames / time(官方成绩；V2 → null) / steamId(+`[U:1:<id>]` 显示名) / tickrate（V2/<v5 按 128 估算并出 warning，`shavit-replay.ts:51-56, 321-322, 395-396`）/ zoneOffset[2] / stage / timestamp（<v12 用 mtime 兜底）/ offsetsLength。
- `ClipPayload` 已带 `buttons/meta`（`protocol.ts:17-20`）——UI 元信息面板（8.6）的数据源。

### 8.2 坐标映射（t4 起为「映射切换」，默认 = 本节定标）

- pos：Source `[x,y,z]` → viewer `[y,z,x]`（`shavit-replay.ts:481`，与 wasm `rotate_yup`/地图 GLB 导出同一变换，det=+1）。
- **yaw：viewer yaw = wrap(sourceYaw + 180)**。
  - 原稿此处曾写 `viewer yaw = (270 − sourceYaw) mod 360`（引 `pose.ts bspYawToCsYaw`）——**有误，已修正**：该口径与本节 pos 的轴置换矛盾（270− 是 det=−1 镜像式，与 `[y,z,x]` 的 det=+1 刚体映射不同构）。
  - 推导：在 `[y,z,x]` 映射下 Source 前向 `(cos yaw_s, sin yaw_s)` 映入 viewer 前向定义 `(−sin yaw_v, −cos yaw_v)`，两者逐 tick 相等 ⇔ `yaw_v = yaw_s + 180`（mod 360）。
  - 实证：真实 `surf_null_4.replay` run 段 **1078** 个有效帧「视角·运动方向」平均 **cos = 0.9992**；同帧集按 270− 口径复算仅 ≈ **0.05**（近乎正交）。定标固化在 `test/replay-selftest.ts:286-307`（run 段平均 cos > 0.98 断言）与合成 fixture 断言（src yaw=30 → viewer 210 = wrap(30+180)，`replay-selftest.ts:381-386`）；面板开关 title 同口径（`panel.ts:108`）。
- pitch：取负（Source 正值 = 俯视，`types.ts:70-71` 同口径）并限幅 ±89°；roll 恒 0（`shavit-replay.ts:493-497`）。
- `posIsEye = false`（帧位是**脚底**绝对世界坐标）。
- `pose.ts:23-25 bspYawToCsYaw`（t1 起为 `wrap(src+180)`）服务 BSP 出生点实体角路径（初始视角 `core/spawn.ts:47-50` spawnPointAng、出生点列表 title/跳转 `mapinfo.ts:144-161`），与本节 `.replay` 帧解码定标**同式同源**——评审 F6（旧式 270− 为 det=−1 镜像，surf_null primary srcYaw=180 应 0° 旧给 90°）已于 t1 闭合，全链统一 +180 口径。
- 映射以 `RuleConfig.axesMode/yawMode` 开放为「标准（shavit）/直读（raw）」两档切换（逃生口：`types.ts:22-36`；面板「坐标映射」分区 `panel.ts:90-109`，切换即重导当前轨道）；`raw` 档 = Source 值直读，供坐标系不符的数据对照（断言 `replay-selftest.ts:388-401`）。

### 8.3 时间轴（t2 §8.3 方案 A）

`t(i) = (i − preFrames) / tickrate`（`buildTimeArray`，`shavit-replay.ts:439-443`）——prerun 为负、单调；**主时钟 0 = 起跑帧**，播放区间从起跑开始。头部 fTime 是官方计时（含 zone 口径），展示成绩用它（信息条）；播放对轴用帧推算时间。

### 8.4 速度

`vel[i] = (pos[i+1] − pos[i−1]) × tickrate/2`（中央差分，端点单侧差分，`shavit-replay.ts:513-526`）填 `Clip.vel`。帧内 packed vel 字段（wishmove）**不解码输出**（`shavit-replay.ts:475-476`），勿当世界速度。

### 8.5 播放基准（t4，本次 bug 核心——已修复）

`.replay` 帧已是**绝对地图坐标**，播放基准 = **帧自身坐标**：

- 「起点对齐 note / 一键锚定 / `refreshStartAnchor` / `applyAnchor` / `getStartAid`」已**整体删除**（app.ts 已无 `getStartAid`，panel.ts 已无锚定按钮）——锚定会把正确轨迹平移 ~10,695 HU（t1 实测：surf_null 无 `info_player_start`，最近出生点类实体距首帧 10,695 HU，而帧 0 与地图 GLB 自洽）。
- 渲染即帧坐标本身（仅经 8.2 映射）；「调整工具」平移/旋转仅**用户显式设置**时叠加（`build.ts:14-28` 恒等直跳；面板 `panel.ts:111-158`，默认折叠、不再自动展开）。
- HUD「轨迹完全落在地图包围盒外」检查**保留**（`app.ts:157-188`）——正确的 .replay 若触发它，说明轴映射不对，该修 8.2 的映射切换而不是平移锚定。

### 8.6 元信息面板与按键（t5）

- `src/ui/replaymeta.ts`（107 行）：底部 dock 常驻「录像信息条」，逐字段渲染 `Clip.meta`——成绩 fTime（title 带 zoneOffset 闭环说明）/ 玩家 `[U:1:<id>]`（文件无玩家名，title 说明）/ 地图·Bonus track / 风格 / tick / 帧段（pre+run+post，title 带 stage）/ 日期（iTimestamp → 本地 YYYY-MM-DD）/ 格式版本（title 带 fail-replay 记录数）。**缺失字段不硬造**（V2 无成绩 → 不渲染该项；无玩家名 → 只显示 `[U:1:id]`）。
- `window.viewer.replay.meta()` 同源暴露（`app.ts:369-370`）。
- 逐帧按键 `Clip.buttons`（IN_* 掩码）已进 Clip/播放链路数据面（HUD 不展示，留待后续）。

## 9. 待实现确认项 → 逐条结论（t3/t4 实现后勾销）

- [x] `offsetsLen ≥ 2` 跳过 `(offsetsLen−1) × 12` B：已实现（`shavit-replay.ts:336-339`）；记录数进 `meta.offsetsLength`，UI 仅在「格式」title 展示。
- [x] V2 格式纳入：`"<帧数>:{SHAVITREPLAYFORMAT}{V2}"` + 6-cell 帧（pos3+ang2+buttons）、无二进制头，冒号前整数按**帧数**处理（`parseV2`，`shavit-replay.ts:384-437`；注释 `:93-99`）。
- [x] 完整性自检：zoneOffset 闭环复算 fTime 进自检（`test/replay-selftest.ts:210-214`）；截断 / 尾多字节 / 负 pre / <v7 frameCount 读侧修正 / tickrate≤0 / 无 run 帧 / v11 mtime 兜底等异常输入共 11 类有断言（`[8]` 节，`replay-selftest.ts:668-828`）。
- [x] 远古文本 / btimes：明确报错（「不支持的 Shavit 回放格式……viewer 只支持 FINAL / V2」，`parseHeaderLine`，`shavit-replay.ts:130-137`）。
- [x] flags/mousexy/vel(原始)/stage 的 UI 取舍：flags 按 u32 读入 `ShavitParseResult.flags`（CS2 高位 bit，`shavit-replay.ts:473-474`）；mousexy / packed vel / stage 不输出不上条面（stage 仅进信息条 title）——UI 从简。
- [x] prerun/post 时间轴呈现：取方案 A（主时钟 0 = 起跑帧）；时间轴 UI 以「正式跑段高亮带 + pre/run/post 帧读数」呈现边界（`timeline.ts:42-44, 292-312, 321-334`）。
