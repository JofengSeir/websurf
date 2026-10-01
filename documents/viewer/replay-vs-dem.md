# `.replay` 与 `.dem`：两条链路的分离设计

> 覆盖范围：`apps/viewer/src/replay/**`、`apps/viewer/src/ui/**` 与 `apps/viewer/web/{index.html,styles.css}`。
> **本文记录的是已经落地的分离结构**（2026-10-02）：两条链路各持一个 `ReplaySession`，展示面之间
> 不共享任何可变状态。§1–§4 是现状（每条陈述带锚点），§5 是本次推倒重来的动因与逐条处置，
> §6 是仍未定的问题。
> 早先本文记录的是「两条链路被缝在同一组契约上」的现状清单与分离提案；那份清单的每一项都在 §5 给出结局。

---

## 1. 一句话

**一个回放会话 = 一次「导入 → 播放」的全部私有状态**（`apps/viewer/src/replay/session.ts:62`）。
记录（`.replay`）与录像（`.dem`）各持一个，同一个时刻只有一个上场。
「哪条链路有哪些控件 / 画哪些叠加带」在**构造期**由能力档定死（`apps/viewer/src/replay/session.ts:43`），
运行期只做一件事：切换谁上场。

| | 记录会话（`.replay`） | 录像会话（`.dem`） |
|---|---|---|
| 主时钟 / 区间 / 轨道 / 跟随 / 视角模式 | 自己一份 `ReplayPlayer` | 自己一份 `ReplayPlayer` |
| 3D 轨迹线 / tick 点 / 幽灵 / 起终点标记 | 自己一份 `ReplayVisuals` | 自己一份 `ReplayVisuals` |
| 底部时间轴（DOM + 控件 + 读数） | `#timeline` + 自己一条 `Timeline` | `#timelineDemo` + 自己一条 |
| dock 容器 | `#session-replay` | `#session-demo` |
| 信息条（dock 上层那条横带） | 有：`#replayMeta` + `ReplayMetaPanel`，读跟随轨道的 `Clip.meta`（Shavit 文件头 20 项） | 有：`#demoInfo` + `DemoMetaStrip`（`apps/viewer/src/ui/demometa.ts`），读 `DemoParseResult`（服务器身份 / 天空盒 / 协议 / 事件 / 实体流 / 字符串表 / 包走读） |
| 一次导入产出几份 `Clip` | 恒 1 份 | 每个被采出位姿的实体 1 份（择优一条进轨道） |

两条信息条**位置相同、视觉相同（共用 `.info-strip` 类）、元素与写者各自独立**：记录条由
`ReplaySession` 的 `ReplayMetaPanel` 在 `syncSession('replay')` 时重渲染，录像条由 `DemoPanel`
解析完成后经 `onParsed` 一次性推入；谁也不会写对方的容器（回归里有专门一条断言钉这件事）。

全局唯一共享的面只剩三样，且都只**读活动会话**、不持有会话状态：`three` 场景、飞行相机、
dock 之外的 HUD 与遥测读数（`apps/viewer/src/app.ts:126`）。

---

## 2. 能力档：按「产物能力」分档，不按「文件类型」分支

一条时间轴有哪些控件、读哪种时间码、画哪些叠加带，全部在构造期由 `TimelineProfile`
（`apps/viewer/src/replay/timeline.ts:39`）决定；两条链路的取值集中在 `SESSION_PROFILES`
（`apps/viewer/src/replay/session.ts:43`）这**一处**声明：

| 档位字段 | 记录（`.replay`） | 录像（`.dem`） | 判据（为什么） |
|---|---|---|---|
| `clock` | `'run'`（秒计数，0 = 起跑帧） | `'wall'`（`m:ss`，0 = 录像开头） | `Clip.t` 的零点在两条链路上不同（§3） |
| `frameStep` | 有（`◀ 帧` / `帧 ▶` + 帧读数） | 无 | 帧步进要**定长帧序列 + 头部段位**；`.dem` 的 `Clip.count` 是 tick 采样条数 |
| `abRange` | 有（A/B 按钮 + 区间带 + `I`/`O`） | 无 | A-B 是「强制定义一段长度再比快慢」，近一小时的录像里没有意义 |
| `runZone` | 有（正式跑段高亮带） | 无 | 跑段读 `Clip.meta.frameCount`，而 `.dem` 的 `meta` 恒 `null` |
| `personZones` | 无 | 有（活跃区间带 + 悬停高亮带 ×2） | 两条带的数据源是录像花名册的 tick 区间 |

按键簇**不在这张表里**：它是遥测 HUD 的一部分（`apps/viewer/src/ui/telemetry.ts:97`），
构造时只挂进**记录会话**那条时间轴的右列（`apps/viewer/src/app.ts:126`）——
`.dem` 的 `Clip.buttons` 恒 `null`（Source 只把录制者本人的输入写进 `usercmd`），
不摆一排永远不亮的灯。**曾经多出过一档 `eventMarks`（滑杆上的阵亡点刻度层），已被 owner 判定为
不必要而整套撤除** —— 阵亡这件事改成只在文字面上出现（花名册行的「阵亡 N」、详情里的生命区间与
阵亡时刻），不再在滑杆上画点（§5.3）。

---

## 3. `Clip` 的字段权属矩阵

`Clip` 仍是两条链路的**入口契约**（`apps/viewer/src/replay/types.ts:110`），但字段含义的差异
已经被上面那张能力档表吸收 —— 消费面不再需要「先判断这是哪种文件」：

| 字段 | `.replay` | `.dem` | 差异的处理方式 |
|---|---|---|---|
| `count` | 帧数（含 pre/post） | tick 采样条数 | 帧读数只在记录档建（`frameStep`）；阈值判定只在记录页用（`apps/viewer/src/replay/panel.ts:336`） |
| `t` | 相对起跑帧（prerun 为负） | 录像内绝对时刻 | 窗口公式统一为 `rangeStart = min(0, t[0])`、`rangeEnd = max(轨道总长, sessionLength)`（`apps/viewer/src/replay/player.ts:180` 到 `apps/viewer/src/replay/player.ts:181`） |
| `meta` | 文件头 20 项 | **恒 `null`**（`apps/viewer/src/replay/democlip.ts:189`） | 跑段带与信息条对 `null` 走自己的缺省分支：不画带、整条隐藏（`apps/viewer/src/ui/replaymeta.ts:26`） |
| `buttons` | 逐帧真实按键位 | **恒 `null`** 且不反推 | 按键簇整组熄灭；录像档的时间轴上不建按键簇 |
| `vel` | 头部速度字段 | 位置差分补出（`apps/viewer/src/replay/democlip.ts:122`） | 同一契约，遥测速度读数与电平表通吃 |
| `name` | 文件名 | 实体名 / `类名 #实体号`，随播放头轮换 | 轮换只发生在录像会话内部（`apps/viewer/src/replay/demopanel.ts:486` 的 `nameAtSlot`、`apps/viewer/src/replay/demopanel.ts:514` 的 `refreshNames`） |
| `id` / `pos` / `ang` / `duration` / `bbox` / `maxSpeed` / `resolvedPath` / `rule` | — | — | 两条链路含义相同，`Track` / `TrackSet` / `visuals` / `player` 这些共享模块只消费这一组 |

**共享边界**（拆分不越过这条线）：`Track` / `TrackSet` / `Timeline` 组件本体 / `ReplayPlayer` /
`ReplayVisuals` / `TrackPanel` 是两条链路**真正共享的代码**；分离开的是**实例与状态**，
不是这些模块的实现。

---

## 4. 切换语义

**唯一的 tab 切换点**是 `switchTab`（`apps/viewer/src/app.ts:175`）；切到记录 / 录像时它调用
`setActiveSession`（`apps/viewer/src/app.ts:154`）：

- **上场**：给本会话的 dock 容器加 `.active`（`apps/viewer/web/styles.css:419`），
  按当前采样重算 3D 显隐，放开时间轴可见性（`apps/viewer/src/replay/session.ts:107`）；
- **下场**：**只停表** —— 暂停主时钟、熄灭本会话全部 3D 对象、**交还快捷键**，轨道 / 时间 / 区间 /
  显示开关原样留着（`apps/viewer/src/replay/session.ts:124`）。切回来即刻续看，没有任何东西需要「拆」；
  「交还快捷键」是必须的：两条时间轴各绑一份 `window` 的 `keydown`，只有上场的那条响应
  （`apps/viewer/src/replay/timeline.ts:333` 的 `setOnStage`）—— 否则在看录像时按 `K` / `,` / `.` /
  `I` / `O`，记录会话的播放态、帧号与 A-B 区间会被一起改掉（本轮实测抓到的真实串位，
  回归断言在 `apps/viewer/test/session-sep.mjs` 的 `[C2]` 段）；
- **切到「地图」页不改会话**：底部 dock 仍停在上一个回放会话上、相机也仍由它驱动（与改造前一致）；
- **帧循环只驱动活动会话**（`apps/viewer/src/app.ts:771` 的 `frame`，只对它调 `apps/viewer/src/app.ts:866` 的 `s.tick(dt)`）：另一个会话的 `update` 不被调用，
  于是它的时间不会自己走；录像页看板的逐帧刷新（名称轮换 / 在线态 / 自动跟随）也只在本会话上场时执行。

录像看板点到某个人时，建轨道 / 换人物 / 定时长**全部落在录像会话自己的对象上**
（`apps/viewer/src/app.ts:340` 起的 `DemoPanelOptions`），记录会话那次 `sync` 根本不会被触发。

---

## 5. 推倒重来的动因与逐条处置

### 5.1 动因：四处运行期开关互相牵制

改造前，两条链路共用**同一个** `ReplayPlayer` / `ReplayVisuals` / `Timeline`，靠四处运行期开关
来回拨：`activeTab`、`demoTrackId`、`player.span`（约定「非零即录像会话」）、
`timeline.setDemoMode(on)`。任何一处漏拨就会串位，实测过的症状包括：

- 两边轨道都留在同一个 `TrackSet` 里 ⇒ 时长取并集、播放窗口互相覆盖（「进度条速度特别快、实际时间长度是 replay 的」）；
- 切 tab 要 `teardownDemo()` 删掉录像轨道、清 `span`、`setDemoMode(false)` —— 漏掉任何一步，
  另一边就播不了（「切到录像看不了东西」）；
- `Timeline` 的 `hasTracks` / `hasMarks` 是两套状态挤在一个实例里，`setPresence` 与 `setTracks`
  互相覆盖可见性。

**处置**：把这四处开关全部删除，改成「一个会话一份实例 + 一处构造期能力档」。

### 5.2 早先缝合点的结局

| # | 早先的缝合点 | 现状 |
|---|---|---|
| C1 | `.dem` 的 `Clip.meta` 曾被伪造 | 恒 `null`（`apps/viewer/src/replay/democlip.ts:189`），消费面走缺省分支；后续拆分沿用这条路线 |
| C2 | 按键簇在 `.dem` 下是「一排永远不亮的灯」 | **已撤**：录像会话的时间轴上根本不建按键簇（`apps/viewer/src/app.ts:126`） |
| C3 | `Clip.t` 的零点两链路不同，靠 UI 侧规避 | **已提升到能力档**：`clock` + 统一的窗口公式（§2 / §3） |
| C4 | `Clip.count` 的单位两链路不同 | 帧步进与帧读数只建在记录档；阈值判定只在记录页 |
| C5 | `ReplayImporter` 里的 `.dem` 分支从 UI 不可达 | **已删除**：`importDemoOnMain`、三级采样口径回退与 `DemoImportInfo` 整段移除（`apps/viewer/src/replay/importer.ts`） |
| C6 | 采样口径两套策略（三级回退 vs 固定 `playerPosed`） | **只剩一套**：录像页固定 `'playerPosed'`（`apps/viewer/src/replay/demopanel.ts:454`） |
| C7 | `ImportResult.clips` 的份数契约自相矛盾（注释 vs 代码） | **已消除**：契约收敛为单份 `clip`（`apps/viewer/src/replay/importer.ts:45`），Worker 侧本就只回一个载荷（`apps/viewer/src/worker/main.ts:95`） |
| C8 | 记录页文案/判据只覆盖 `.replay` | `.dem` 不再进记录页，相关分支与文案随之删除 |
| C9 | `DemoImportInfo.note` 的两条陈述已不成立 | 随 C5 一起删除（那段面向用户的说明文字不再存在） |
| C10 | `.replay` 的展示数据被抬进共享契约 | 保留：`Clip.meta` 仍是记录文件的**如实**携带；消费面只有信息条与时间轴的跑段带 |
| C11 | `.dem` 的展示数据完全绕开共享层 | 保留（有意）：花名册 / 占用身份 / 名字时间线 / 聊天 / 阵亡事实都只服务录像会话，且**新增消费点**（见 §5.3） |
| C12 | 进度的粒度两条链路不同 | 只影响记录页（`ProgressFn` 仍是 `'parse'` 的 0/1 与 1/1） |
| C13 | `.dem` 在主线程解析 | 保留（未变）：Worker 协议是 Shavit 专属载荷；录像链路的解析仍是主线程同步 |
| C14 | 哪些共享应当保留 | 见 §3 末的「共享边界」 |

### 5.3 顺带清账

- `Timeline` 里的 `setDemoMode` / `demoMode` / `tl-demo` / `tl-only-replay` 全部删除；
  同样删掉的还有**从未被调用**的 `setPresence` / `PresenceEntry` / `MAX_PRESENCE` /
  `fmtSpan` / `esc` 与它们建的 `.tl-presence` / `.tl-pmark*` / `.tl-picks` DOM 与 CSS。
- `ReplayPlayer.span`（「非零即录像会话」的约定）改名 `sessionLength`
  （`apps/viewer/src/replay/player.ts:62`）：它现在只有一个字面语义 —— 本会话的整段时长兜底。
- 录像链路首次消费一批此前无消费点的 `.dem` 字段：`DemoHeader.serverName` / `clientName` /
  `gameDirectory` / `playbackFrames` / `signonLength`（看板与悬停提示）、
  `PlayerSample.team` / `health` / `lifeState`（队伍标签、生命区间、阵亡次数与时刻，
  `apps/viewer/src/replay/demopanel.ts:105` 的 `trackFacts`）、
  `PlayerTrack.classId` / `dtName` 与 `entityCount` / `classCounts` / `playerPropNames` /
  `DemoParseStats`（详情与看板的悬停提示）。
  **阵亡一度做成滑杆上的刻度层（`Timeline.setMarks` + `.tl-marks`），已按 owner 判定整套撤除**：
  30 分钟的滑杆上钉一排细线既读不出信息、也白占一层 DOM；阵亡改回只在文字面出现
  （花名册行「阵亡 N」、详情里的生命区间与阵亡时刻）。
- **又接出两条被「解析完就丢」的 `.dem` 事实，并新开一条录像专属信息条**（owner：底部那条影带太空）：
  `svc_ServerInfo`（`apps/viewer/src/replay/demo/net.ts:116` 的 `DemoServerInfo`）与
  `svc_UserMessage` 的**逐 id 直方图**（`DemoParseStats.userMessageById`）——
  前者此前只拼成一行 `stats.warnings` 文本，而**天空盒名 `skyName` 在整个 `.dem` 里只有这一处来源**；
  后者此前只解 `SayText2`（id 4）进聊天留档，其余 id 整段跳过、不留痕。展示面是
  `apps/viewer/src/ui/demometa.ts` 的 `DemoMetaStrip`（写 `#demoInfo`）：条面 12 项
  （服务器 / 地图 / 天空 / 协议 / 时长 / **录制机位** / 实体流 / 玩家 / 事件 / 聊天 / 字符串表 / 包），
  逐项的诊断细节（文件头 `serverName` 与 `svc_ServerInfo.hostName` 的差异、用户消息直方图、
  字符串表清单、包失败分类、实体流残差、机位首末值）进悬停 `title`。实测本仓夹具的条面读数：
  `天空 Clear_night_sky`、`协议 演示 3 / 网络 24`、`时长 29:59`、`录制机位 未记录（59951 条全 0）`、
  `实体流 59948 条 / 514022 次`、`玩家 5 位 / 签名表 5 条`、`事件 231 次`、`聊天 40 条`、
  `字符串表 19 张`、`包 59949 / 59951`。
  「录制机位全 0」这句话本身就是有用结论：它区分了**记录本身没记录制者视角**与**解析漏读**
  （后者正是本工程在实体流上踩过的坑）——第一人称视角在这份录像里不可得，玩家视角只能靠实体流采出的轨迹。
- **聊天分两处消费**（owner 定稿：留档归侧栏、当下看画面）。解析层给出的每条聊天**都带 tick**
  （`apps/viewer/src/replay/demo/net.ts` 的 `NetContext.chat`，装配进
  `apps/viewer/src/replay/demo/demo.ts` 的 `DemoParseResult.chat`）——时间戳与文本一样是解析产物，
  「进度走到哪儿、光打到哪儿」全靠它：
  · **侧栏「对话」区 = 完整留档，只做明暗**（`apps/viewer/src/replay/demopanel.ts` 按当前播放头给
    已发生的行加 `.dmp-chat-on`、未发生的压暗）；**不自动滚动、不设自己的滚动条** ——
    程序不跟用户抢滚动位置，想看哪一段自己滚整列；
  · **画面左下角浮层 `#chatOverlay` = 只服务「当前这一刻」**（`apps/viewer/src/ui/chatoverlay.ts`）：
    出现 **15 秒**后淡出、同屏**最多 5 条**、短时间内超过 5 条就把**最早那条快速丢出去**；
    顺序自早到晚、**最底下是最晚的**（容器按 `bottom` 贴左下角并踩着 `#dock` 高度让位 ⇒
    内容向上长、新的一条从底部顶上来）。「该显示哪几条」抽成了纯函数 `visibleChat`，
    好在 Node 侧用合成数据钉住那三条规则（真实夹具 15 秒窗口内最多 4 条，测不出「>5 条」那支）。
- **花名册按「身份」去重**（owner 实测：同一台机器人被复用做回放时反复重连，名单摊成十几行）：
  `occupancyIdentities()`（`apps/viewer/src/replay/demopanel.ts:1175`）把「占用会话」按
  **guid 不是 `BOT` ⇒ 按 guid、是 `BOT` ⇒ 按槽位**合并 —— 后者是因为 `BOT` 是所有机器人的公共
  guid，无法区分具体哪一台，而同一槽位上的多次重连正是「同一台被复用」的场景。实测本仓夹具的
  `userinfo` 更新流给出 **11 条占用事件、真实身份只有 5 个**（3 台回放机器人各重连 3 次 +
  真人 `LuoXuan` 先后占槽 6 与槽 4 + 只在签名表里的录制机器人），合并后花名册 **5 行、名字无重复**；
  `RosterRow.entities` 保留该身份占过的全部实体号，`spans` 记**逐次在场**的区间；**主实体
  （`entity`）= 他最早那一段的实体** ⇒ 点花名册就是「从这个人的开头看起」（早先取采样最长的那段，
  于是从 0 s 点 `LuoXuan` 会越过第一段、直接跳到第二段开头 —— owner 实测），生命体征则取
  **采样最长**的那段统计；播放头已落在他某一段里时，`jumpTo` 就切那一段。
- **但「一个人一行」不等于「一段连贯的在場」**（owner 复核后的第二处返工）：把身份合并的同时如果只留
  一个 `[from, to]`，就把「**进过一次服、退出、又进来**」抹成了一段 —— 花名册的区间条、时间轴上的人物
  叠加带都看不出那个断口，自动跟随也会在他第二段进场时停在他第一段的实体上（必须手动再点一次）。
  现在 `RosterRow.spans` 给的是**逐次在场的区间列表**（相邻/重叠已并段，**真断开的两段留着断口**），
  每段带自己的实体号；花名册行逐段画条、读数前缀「N 段」、悬停提示列出各段时刻，叠加带按段建
  `.tl-seg`（`apps/viewer/src/replay/timeline.ts:344` 的 `setActiveSpan` 入参已是**区间数组**），
  在线态与悬停高亮也都按段判断。实测本仓夹具的 `LuoXuan` 正是这种：两段在场（槽 6 早段 ≈ 5–74 s、
  槽 4 后段 ≈ 276–714 s），对应实体 **#7** 与 **#5**。
- **自动跟随于是也改成「逐段」判断**（`apps/viewer/src/app.ts`）：`spanAt(entity, tick)`
  （`apps/viewer/src/replay/demopanel.ts:812`）给出「他**此刻**在不在场、在哪一段」，判定顺序是：
  **① 在场 ⇒ 跟这一段**；**② 他退出了、但我们一直在看他、而且他后面还会回来 ⇒ 不切别人，直接把
  播放头跳到他重进那一刻接着看**（`hud.flashStatus` 提示「已跳过 … 不在场的一段，接上他重进的 m:ss」；
  `autoFollowSkippedTo` 记住该段起点 ⇒ **同一段只跳一次**，手动把播放头拖回缺口不会被再次弹走）；
  **③ 否则**（还没进服 / 这一段之后他不会再来 / 看的本来不是他）才退回「跟当前最快的那位」。
  实测 30 s ⇒ 跟 **#7**；150 s（缺口）⇒ 跳到 **278 s** 并跟 **#5**；600 s ⇒ 跟 **#5**。
  **但「跳过一次」不等于「绑对了」**（owner 复核后的第三处返工，两条都得记住）：
  **· 视角绑定改按区间算、每帧都做**（`apps/viewer/src/app.ts` 帧循环里的换绑段）：判据是
  `spanAt(当前视角实体, 当前 tick)` —— 同一身份的第二段是**另一条轨迹**（实体号不同），
  播放头落进哪一段就把视角**换绑**到那一段的实体。这一条**与播放/暂停、自动跟随开关都无关**：
  早先它只写在「自动跟随 + 正在播放」分支里，于是**暂停着把进度条拖到第二段，视角还留在第一段**
  （owner 实测）；而且这是**换绑不是跳转** —— 播放头本来就在这一段里，`jumpTo` 的「区间外才 seek」
  不触发，所以「我进度条随便拖，只要进入我在看这个人的区间，就看到他在这一段里活跃的视角」。
  **· 用户自己在拖进度条时，自动跟随必须让开方向**（`userSeekAt` + `Timeline.scrubbing`）：
  他自己拖到两段之间的缺口，**不许被强制弹到他重进的那一刻**（owner 把它叫作「很大的问题」）——
  松手后 0.7 秒内也照样让开，并把这次缺口跳过权作废，免得下一帧又偷偷弹走。
  让开只对**滑杆**生效（`Timeline.onUserSeek`）；程序内部的 seek（深链 / 载入回零 / A-B 循环）
  不算用户操作 ⇒「播到缺口自动跳过」那条**不受影响**（owner 要的「不要打断这种感觉」仍在）。
  同时修掉两个会让它失灵的判据：**① 真人不能拿 `!isBot` 判**（录制机器人在观察者录像里从不更新
  `userinfo`、`isBot` 无从判定，会把录制机器人当成「第一位真人」一路锁住）——改用 `RosterRow.human`
  （`userinfo` 里见过真 guid）；**② `onClip` 无条件解除自动跟随**（自动跟随自己挑人也会走 `onClip`）
  ⇒ 第一次自动挑人就把功能关掉了，现在只有**用户自己点的**那一次才解除（`autoPickInFlight` 标记，
  `apps/viewer/src/app.ts:342`）。
- **录像会话内部的同名串位也一并清掉**：`parseSourceDemo` 起始处清空两份模块级跨包累积量
  （`userinfoTimeline` / `usercmdDiag`）—— 它们的 tick 坐标相对本份录像，不清会让「同一页载入
  第二份 `.dem`」时新旧条目混在一条时间线上（花名册取到上一场的名字）。

---

## 6. 仍未定 / 需 owner 裁

1. **`.dem` 是否进 Worker**（原 C13）：现为主线程同步解析，11.8 MB 夹具实测 6~14 s，期间 UI 卡住。
2. **录像会话是否需要「清空 / 换人」以外的轨道管理**：录像复用同一条轨道（点选 = 换看谁），
   没有轨迹列表；若要并列比较多人，需要新的呈现（不在本次拆分范围内）。

---

## 7. 这条不变量怎么验证

`apps/viewer/test/session-sep.mjs`（`npm run test:sessions`）是它的常驻回归：自带静态服务器
（服务仓库根，因为 `.dem` 夹具在 `<仓库根>/test/replay/`）+ headless Edge 走 CDP，64 项断言分八段：

1. 拖入合成 `.replay` → 只落记录会话；录像会话轨道数为 0、时间轴仍隐藏、**录像信息条为空**；
   两边的**能力档**逐一核对（跑段带 / A-B 带 / 帧步进按钮 / 人物带 / 按键簇；已撤的标记层两边都不许再建）。
2. 拖入真实 `.dem` → 只落录像会话；记录会话的轨道数、时长、播放态**一点没变**；
   录像时长 = 整场（`sessionLength`），记录时长仍是自己那一小段；`Clip.meta` 恒 `null`。
3. **花名册按身份去重的实测断言**：本夹具恰好 **5 行**、名字无重复、真人 `LuoXuan` 只出现一行、
   看板「玩家 N 位」与行数一致（去重前的行为是 11 条占用事件各占一行、同名的机器人铺满看板）；
   点合并行 → 详情落到覆盖播放头的那条轨迹并点名同身份的另一个实体。
3b. **「进过一次服、退出、又进来」的实测断言**（owner 复核后的两轮返工）：该行的区间条是**两枚**、
   读数标「2 段」、悬停提示列出两段时刻；把播放头放到 30 s（他第一段）⇒ 自动跟到 **#7**、
   **150 s（缺口）⇒ 播放头被他跳到重进那一刻（≈278 s）并接上 #5**（owner 定稿：
   「一直在观察这个人、他之后会回来的话就跳到他重进的那时，不要打断这种感觉」），
   状态行给出「已跳过 … 不在场的一段，接上他重进的 4:36」、600 s（第二段）⇒ 跟 **#5**；
   此时人物叠加带是**两段**（`.tl-zone-active .tl-seg` = 2），中间留断口。
4. **录像信息条**：12 个字段名齐全、关键读数与本夹具一致（天空 / 事件 / 聊天 / 字符串表 / 实体流 /
   录制机位）、两个玩家口径并列、悬停诊断面存在；喂一份「像 `.dem` 但截断」的文件 ⇒ 走到解析失败分支
   且**信息条被清空**（不留上一份录像的服务器 / 事件数）；同一条断言还钉住**记录条没有被录像会话写过**
   （仍是那份 `.replay` 的元信息、不含任何 `.dem` 事实）。
5. **录像上场时按播放快捷键**（`K` / `,` / `.` / `I` / `O`）→ 记录会话的时间、播放态与 A-B 区间
   一个都不许动（这条断言在去掉 `setOnStage` 闸之后**实测会失败**，是本轮抓到的真实串位）。
6. 来回切 tab → 两边轨道都在、非活动的一侧停表且时间冻结、容器不占屏（`getClientRects()`）。

加上既有的两道门：`npm run typecheck`（结构）与 `npm run test:replay`（**127** 项：解析与契约，
其中 5 项钉住本轮新接出的 `.dem` 事实 —— `svc_ServerInfo` 收到且天空盒非空、其地图名与文件头一致、
用户消息直方图含 id4 且与聊天行数对得上、录制机位条数 = 包数、该夹具机位全 0）。
