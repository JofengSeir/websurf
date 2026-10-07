# implementation/app：主线程装配入口

> 覆盖 `apps/viewer/src/app.ts`（主线程唯一装配入口）与 `apps/viewer/src/wasm.d.ts`（wasm 类型入口）。

---

## 模块职责

`apps/viewer/src/app.ts` 是 viewer 的入口文件，被 `apps/viewer/package.json:14` 的 `build:app` 用 esbuild 打成 `web/app.js`。它没有 `export`：全部工作是模块顶层的装配与事件绑定，对外只暴露 `globalThis.viewer`。

装配顺序（自上而下）：画布 → HUD → `ViewerScene` → `FlyCam` → 侧栏/标签页与 dock 容器 → 两个 `ReplaySession`（`sessions`，各持一份播放器 / 3D 呈现 / 时间轴；记录条在会话内建）→ 遥测 HUD → **录像信息条 `DemoMetaStrip`（`#demoInfo`，录像会话专属、独立于 `ReplaySession`）** → **画面左下角的对话浮层 `ChatOverlay`（`#chatOverlay`，同样独立于 `ReplaySession`，数据由录像看板的 `onParsed` 推入）** → `switchTab` 与标签页按钮 → `MapPanel` → 记录侧导入器与 `ReplayPanel` → 录像侧 `DemoPanel`（解析产物经 `onParsed` 推给上面那条信息条与浮层）→ BSP 输入与拖拽 → `globalThis.viewer` → URL 深链 → 帧循环。

对外接口清单（`apps/viewer/src/app.ts:750` 起）：

| 成员 | 含义 | 锚点 |
|---|---|---|
| `viewer.map.pose()` | 相机脚底位姿（度）+ 本次地图初始视角来源 | `apps/viewer/src/app.ts:755` |
| `viewer.map.mapBox()` | 当前地图几何包围盒（无地图为 null） | `apps/viewer/src/app.ts:765` |
| `viewer.replay` / `viewer.demo` | 两个会话的只读内省快照，形状完全一致（同一个 `sessionApi(kind)`）：`kind` / `active` / `ready` / `trackCount` / `duration` / `sessionLength` / `time` / `playing` / `rangeStart` / `rangeEnd` / `speed` / `mode` / `followId` / `sceneObjects`（下表 `viewer.replay.*` 的方法 `viewer.demo` 同名同形） | `apps/viewer/src/app.ts:680` 到 `apps/viewer/src/app.ts:740`、`apps/viewer/src/app.ts:770` 到 `apps/viewer/src/app.ts:772` |
| `viewer.replay.tracks()` | 各轨道只读信息（id / 名 / 帧数 / 时长 / 偏移 / 显隐 / 配色 / 首帧坐标） | `apps/viewer/src/app.ts:705` 到 `apps/viewer/src/app.ts:718` |
| `viewer.replay.meta()` | 跟随轨道的 `.replay` 头部元信息（录像会话恒 null） | `apps/viewer/src/app.ts:720` |
| `viewer.replay.play()` / `pause()` / `seek(sec)` / `setSpeed(x)` | 播放控制（时间单位秒；`setSpeed` 钳到 [0.1, 16]） | `apps/viewer/src/app.ts:722` 到 `apps/viewer/src/app.ts:727` |
| `viewer.replay.setMode(m)` | 只有 `'third'` 按第三人称处理，其余入参一律落到 `'first'` | `apps/viewer/src/app.ts:729` |
| `viewer.replay.follow(trackId \| null)` | 切换跟随目标（null = 回到第一条轨道），并按需刷新信息条与轨迹列表 | `apps/viewer/src/app.ts:733` |
| `viewer.session` | 当前上场的会话与两侧就绪情况：`{ active, replay: { active, ready, trackCount }, demo: { … } }` | `apps/viewer/src/app.ts:778` 到 `apps/viewer/src/app.ts:784` |

`apps/viewer/src/wasm.d.ts` 只有一行 `export * from '../pkg/websurf_viewer_wasm.js'`（`apps/viewer/src/wasm.d.ts:13`），用途是让本工程可按 `./wasm.js` 引用 wasm 侧类型；它在 `apps/viewer/src` 内**零导入点**（真正导入 wasm 的是 `apps/viewer/src/core/bsp.ts:23` 的 `BspProcessor` 与 `initSync`）。

## 关键流程与不变量

| 流程 / 不变量 | 说明 | 锚点 |
|---|---|---|
| 地图加载三步顺序 | `loadBsp` 内：`loadBspFile` → `scene.mountGlb` → 包围盒与初始视角 | `apps/viewer/src/app.ts:535` 到 `apps/viewer/src/app.ts:562` |
| 初始视角单点解析 | `resolveInitialSpawn` 同时决定相机初始位姿与面板 ★ 标记，避免两处各判一次 | `apps/viewer/src/app.ts:557`、`apps/viewer/src/core/spawn.ts:96` |
| 换图失败不丢旧图 | 失败时若无地图则显示引导层错误，若有地图则还原旧摘要并临时提示 5 s | `apps/viewer/src/app.ts:568` 到 `apps/viewer/src/app.ts:579` |
| 会话同步单点 | `syncSession(kind)` 一次同步该会话的 3D 可视化、时间轴、信息条（三者收在 `ReplaySession.sync` 里），并按需刷新全局遥测 HUD 的显隐 | `apps/viewer/src/app.ts:148` 到 `apps/viewer/src/app.ts:151` |
| 会话切换单点 | `switchTab` 是唯一 tab 切换点：`setActiveSession` 把对应会话请上场（另一个只停表，轨道 / 时间 / 区间全留）；切到地图页不改会话；帧循环只驱动活动会话（`s.tick(dt)` 只喂上场那个），录像看板的逐帧刷新（名称轮换 / 在线态 / 自动跟随）也只在它上场时跑 | `apps/viewer/src/app.ts:175` 到 `apps/viewer/src/app.ts:194`、`apps/viewer/src/app.ts:845` 到 `apps/viewer/src/app.ts:851`、`apps/viewer/src/app.ts:971` 到 `apps/viewer/src/app.ts:972` |
| 视角按**区间**换绑（每帧，与播放/暂停无关） | 判据是「播放头 + 正在看的那个人此刻那一段」，不是「刚才跳过一次」这种一次性事件：帧循环里取 `demoPanel.spanAt(demoTrackEntity, nowTick)`，返回的那一段若属于**另一条轨迹**（同一身份的第二段是另一个实体号）⇒ 把视角**换绑**到那一段的实体（`pickEntity`），并同步 `autoFollowEntity`、清 `autoFollowSkippedTo`、以 `autoPickInFlight` 标明「这不是用户自己点的」。**这是换绑不是跳转**：播放头本来就在这一段里，`onClip` 的「区间外才 seek」不会触发 ⇒ 用户拖到哪儿就停在哪儿；手动拖进度条、暂停着看、自动播放三种情形一视同仁（早先这段逻辑只写在「自动跟随 + 正在播放」分支里 ⇒ **暂停时拖到第二段、视角还留在第一段**，owner 实测） | `apps/viewer/src/app.ts:863` 到 `apps/viewer/src/app.ts:881` |
| 自动跟随按**段**判断 | 录像载入完成后 `autoFollow` 置真（`onLoaded`），帧循环每帧只做「该不该换人」的判定、换人一律走既有 `pickEntity` 路径（建轨道 + 切第一人称）。**判据三条**：① 第一位真人取 `p.human`（`userinfo` 里见过**非空且不是 `BOT`** 的 guid）而不是 `!isBot` —— 录制机器人在观察者录像里从不更新 `userinfo`，`isBot` 无从判定，拿 `!isBot` 会把它当成「第一位真人」一路锁住；`hasTrack` 也必须过滤（没采到位姿的人 `pickEntity` 只会弹一句「没有可用位姿」，视角原地不动）。② **逐段**问「他此刻在不在场」：`demoPanel.spanAt(firstHuman.entity, nowTick)` 不看行的并集区间 —— 在场就跟**这一段**的实体（同一身份的两段往往是两个实体号）。③ 他**不在场**时分两种：若**我们一直在看他**（`rosterFor(...).entities` 含 `autoFollowEntity`）**且他后面还会回来**（`spans` 里还有起点大于当前 tick 的下一段）⇒ **不切别人，直接把播放头跳到他重进那一刻**接着看（`pickEntity` → `jumpTo` 发现当前时间不在他区间内时会 `seek` 到那一段的起点），并由 `hud.flashStatus` 提示「已跳过 … 不在场的一段，接上他重进的 m:ss」；`autoFollowSkippedTo` 记住「这一段已跳过」，**同一段只跳一次**（否则用户手动把播放头拖回缺口会被再次弹走），他重新在场时清零；其余情况（还没进服 / 他不会再来 / 我们看的不是他）才退回「跟当前最快的那位」（`fastestAt`）。**「用户自己点的人才解除自动跟随」**：模块级 `autoPickInFlight` 在自动挑人期间置真，`onClip` 里写成 `if (!autoPickInFlight) autoFollow = false;` —— 早先它无条件置假，于是**第一次自动挑人就把自动跟随整个关掉了**，真人再进场、再回来都不切（owner 实测「必须再点一次」的直接成因） | `apps/viewer/src/app.ts:449`、`apps/viewer/src/app.ts:908`、`apps/viewer/src/app.ts:350`、`apps/viewer/src/app.ts:359`、`apps/viewer/src/app.ts:894` 到 `apps/viewer/src/app.ts:956`、`apps/viewer/src/app.ts:460` |
| 用户拖滑杆时自动跟随**让开方向** | 模块级 `userSeekAt` 记「用户最后一次亲手拖进度条的时刻」，由 `Timeline.onUserSeek` 写入 —— **只由滑杆的 `input` 触发**，程序内部的 seek（深链 / 载入回零 / A-B 循环）不触发它 ⇒「播到缺口自动跳过」那条行为不受影响、只对真实拖动让开；帧循环算 `dragging = demo.timeline.scrubbing \|\| performance.now() - userSeekAt < 700`（`get scrubbing()` = `pointerdown` 到 `pointerup` 之间）：拖动期间（含松手后 0.7 s）缺口里的「跳到他重进那一刻」与「跟当前最快的那位」都不抢方向，并把这次缺口跳过权作废（`autoFollowSkippedTo = nextSpan.from`）免得松手后下一帧又被弹走；他一旦拖回某一段里（下面的 `here` 分支）这个闸重置。**让开只覆盖自动跟随那一段**，上面的「按区间换绑」不受它管 —— 拖进某人的区间就该看到那一段的视角 | `apps/viewer/src/app.ts:342`、`apps/viewer/src/app.ts:322` 到 `apps/viewer/src/app.ts:324`、`apps/viewer/src/app.ts:918` 到 `apps/viewer/src/app.ts:924`、`apps/viewer/src/replay/timeline.ts:92`、`apps/viewer/src/replay/timeline.ts:150`、`apps/viewer/src/replay/timeline.ts:357` |
| 每会话一份 DOM | `#dock` 下分两层：记录 = `#session-replay`（内含信息条 `#replayMeta` 与时间轴 `#timeline`），录像 = `#session-demo`（内含**录像信息条 `#demoInfo`** 与时间轴 `#timelineDemo` —— 它的数据源不是 `.replay` 文件头，而是 `.dem` 解析产物） | `apps/viewer/web/index.html:130` 到 `apps/viewer/web/index.html:139` |
| 重导入替换语义 | `onClip` 拿到 `replaceId` 时替换该轨道（保留配色/显隐/偏移/名字），否则追加；导入后默认切第一人称 | `apps/viewer/src/app.ts:288` 到 `apps/viewer/src/app.ts:300` |
| 地图贴合检查 | 轨道 `Clip.bbox` 与地图包围盒在三轴全部分离且间隙超过 512 HU 时判「完全落在地图包围盒外」，只写 `#replayStatus` | `apps/viewer/src/app.ts:245` 到 `apps/viewer/src/app.ts:276` |
| 相机单一写者 | 回放第一人称段把 `drivesCamera` / `allowMove` 置假并用 `applyToWithRoll` 写相机，其余帧由 `FlyCam` 写 | `apps/viewer/src/app.ts:974` 到 `apps/viewer/src/app.ts:993` |
| 帧间隔上限 | dt 取 `min(now - lastNow, 0.05)`，避免切标签页回来时时间跳变 | `apps/viewer/src/app.ts:968` |
| HUD 节流 | 位姿行、活动会话时间轴、遥测按 ≥ 80 ms 的间隔刷新，不每帧重排 DOM | `apps/viewer/src/app.ts:997` 到 `apps/viewer/src/app.ts:1012` |
| 导入分派单点 | 拖拽、引导层输入、两个面板的文件框都汇进 `routeFile`：按**文件头魔数**判类型（`sniffFileKind`），`.bsp` → 地图（不切 tab）、`.replay` / `.rec` → 切记录页交给面板、`.dem` → 切录像页交给 `DemoPanel.load`；四种都不命中才提示，文案列出四条魔数 | `apps/viewer/src/app.ts:639` 到 `apps/viewer/src/app.ts:659` |
| 拖拽与引导层入口 | 拖拽按内容分派（不再看扩展名）；引导层「导入记录 / 录像」用**独立隐藏输入** `#importFile`（不指向记录页的 `#replayFile`），去向同样由内容决定 | `apps/viewer/src/app.ts:521`、`apps/viewer/src/app.ts:618` 到 `apps/viewer/src/app.ts:622`、`apps/viewer/src/app.ts:663` 到 `apps/viewer/src/app.ts:666` |
| 面板误选改送 | 两个面板的载入入口都按内容复核：非本页类型经 `onForeignFile` 交回 `routeFile` 改送，不在本页解析 | `apps/viewer/src/app.ts:287`、`apps/viewer/src/app.ts:366` |
| URL 深链 | `?bsp=` 与 `?replay=` 可任意组合；记录先按魔数嗅探再交给面板，非 Shavit 直接报错（深链是唯一仍按参数名定类型的入口，见已知缺口 6） | `apps/viewer/src/app.ts:788` 到 `apps/viewer/src/app.ts:825` |
| `crossOriginIsolated` 只读不选路 | viewer 无物理、不需要 `SharedArrayBuffer`，该标志只打印供部署核对 | `apps/viewer/src/app.ts:52` 到 `apps/viewer/src/app.ts:59` |

## 已知缺口（状态见 TODO.md）

1. **面板容器缺失时静默降级为脱离文档的元素**（本次读码发现）：`mapPanel` 在 `#pane-map` 取不到时为 `null`（`apps/viewer/src/app.ts:210`），`replayPanel` 同理（`apps/viewer/src/app.ts:233`）；而两个会话的 dock 容器与时间轴容器、以及遥测 HUD 在句柄缺失时改用 `dockFallback()` 的游离 `div`（`apps/viewer/src/app.ts:99`、`apps/viewer/src/app.ts:104` 到 `apps/viewer/src/app.ts:112`、`apps/viewer/src/app.ts:127` 到 `apps/viewer/src/app.ts:129`），**录像信息条**同样如此（`apps/viewer/src/app.ts:135` 的 `qs('demoInfo') ?? dockFallback()`），**对话浮层**也一样（`apps/viewer/src/app.ts:140` 的 `qs('chatOverlay') ?? dockFallback()`），`#replayMeta` 缺失时记录会话的信息条直接不建（`apps/viewer/src/replay/session.ts:86`）。后果是页面缺 id 时既不报错也不显示，时间轴与信息条落到脱离文档的容器里，而 `Timeline` 仍在 `window` 上挂 `keydown`（`apps/viewer/src/replay/timeline.ts:293`），上场时这些快捷键照旧生效（闸门见 `apps/viewer/src/replay/timeline.ts:294`）。（见 TODO.md T-101）
2. **贴合检查的文案与数据不同源**（本次读码发现）：判据收集了全部越界轨道，提示串里也列出全部名字，但括号里的 bbox 只取 `outside[0]` 一条（`apps/viewer/src/app.ts:267` 到 `apps/viewer/src/app.ts:271`），多条越界时读数只对应第一条。（见 TODO.md T-102）
3. **`wasm.d.ts` 是零导入点的类型面**：`apps/viewer/src/wasm.d.ts:13` 只做整体转出，本工程内无引用，仅被 `apps/viewer/tsconfig.json:15` 的 `include` 收进编译程序。 （见 TODO.md T-156）
4. **`viewer.replay.setSpeed` 的钳制下限在正常入参下不可达**：表达式 `Math.max(0.1, Math.min(16, Number(x) || 1))`（`apps/viewer/src/app.ts:726`）先用 `|| 1` 把 0 / NaN 归成 1，只有传负数才会落到 0.1 下限；时间轴下拉的档位下限是 0.1（`apps/viewer/src/replay/timeline.ts:28`），两者不冲突，但接口文档化的下半区实际只有负数能触发。 （见 TODO.md T-157）
5. **`updateReplayMapStatus` 只在 `currentBox` 非空时做检查**：`?replay=` 深链先导入记录而地图尚未加载时该函数直接跳过检查（`apps/viewer/src/app.ts:253`），贴合问题要等地图加载后由 `loadBsp` 末尾再次调用才会被报出（`apps/viewer/src/app.ts:559`）。
6. **深链是唯一仍按"参数名"定类型的入口**：四个交互入口（拖拽 / 引导层 / 记录页文件框 / 录像页文件框）都走内容分派，而 `?replay=` 仍在取到字节后**先嗅探 Shavit 魔数**，不命中即报错（`apps/viewer/src/app.ts:807` 到 `apps/viewer/src/app.ts:811`）——即 `?replay=<一份 .dem>` 会被拒。参数名本身就是类型声明，故本轮未改；若要统一成内容分派，属独立改动。（见 TODO.md T-103）
- 看板另有登记项：`TODO.md` 的 T-056 —— **状态与结论只在那登记**，本文件不复述。
