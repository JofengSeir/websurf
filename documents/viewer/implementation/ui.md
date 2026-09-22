# implementation/ui：HUD、面板与读数

> 覆盖 `apps/viewer/src/ui/` 下的四个模块：`hud.ts`（HUD 与引导层）、`mapinfo.ts`（地图信息 + 出生点导航）、`replaymeta.ts`（录像信息条）、`telemetry.ts`（回放遥测 HUD）。

---

## 模块职责

| 模块 | 职责 | 导出清单 |
|---|---|---|
| `apps/viewer/src/ui/hud.ts` | 三条状态行（`#pose` / `#bspStatus` / `#replayStatus`）、引导层、拖拽反馈、启动兜底卡、帮助浮层；元素句柄构造期取一次，取不到即 null 且各方法逐个判空 | 类 `Hud`（`apps/viewer/src/ui/hud.ts:21`） |
| `apps/viewer/src/ui/mapinfo.ts` | 「地图」标签页内容：更换地图入口、光照模式分区、地图信息（核心三行 + 折叠统计明细）、出生点导航（推荐项 ★ 与跳转按钮） | 接口 `WorldBox`（`apps/viewer/src/ui/mapinfo.ts:25`）、类 `MapPanel`（`apps/viewer/src/ui/mapinfo.ts:44`） |
| `apps/viewer/src/ui/replaymeta.ts` | 底部 dock 上层的录像信息条：把跟随轨道的 `Clip.meta` 渲染成「成绩 / 玩家 / 地图 / 风格 / tick / 帧段 / 日期 / 格式」标签值对 | 类 `ReplayMetaPanel`（`apps/viewer/src/ui/replaymeta.ts:16`） |
| `apps/viewer/src/ui/telemetry.ts` | 速度双读数（横向 = 水平速度模、竖向 = 绝对值）与八键按键簇；按键簇挂 `#timeline` 右列，随时间轴一起显隐 | 类 `TelemetryHud`（`apps/viewer/src/ui/telemetry.ts:61`） |

## 关键流程与不变量

| 流程 / 不变量 | 说明 | 锚点 |
|---|---|---|
| 两条状态行的 flash 语义 | 先写临时文本，`ms` 后**只有该行仍是这条临时文本**时才回写持久文本；空串立即恢复持久内容 | `apps/viewer/src/ui/hud.ts:69` 到 `apps/viewer/src/ui/hud.ts:82`、`apps/viewer/src/ui/hud.ts:94` 到 `apps/viewer/src/ui/hud.ts:107` |
| 持久写入会取消未决 flash | `setStatus` / `setReplayStatus` 先 `clearTimeout` 并把自己记为持久文本 | `apps/viewer/src/ui/hud.ts:57`、`apps/viewer/src/ui/hud.ts:87` |
| 地图行旧摘要可回读 | `statusText()` 供换图失败时还原旧摘要 | `apps/viewer/src/ui/hud.ts:64`、`apps/viewer/src/app.ts:244` |
| 元素缺失不抛错 | 除 `showFatal` 需要两个元素同时存在外（`apps/viewer/src/ui/hud.ts:121`），其余方法一律 `?.` | `apps/viewer/src/ui/hud.ts:112`、`apps/viewer/src/ui/hud.ts:130`、`apps/viewer/src/ui/hud.ts:151` |
| 帮助浮层关闭路径 | 顶栏「?」开关（阻止冒泡）、`#helpClose` 点击、全局 `keydown` 的 Escape 三条 | `apps/viewer/src/ui/hud.ts:40`、`apps/viewer/src/ui/hud.ts:44`、`apps/viewer/src/ui/hud.ts:45` |
| 引导层错误分两行 | 人话一行 + 原始信息 `span.raw` 一行；清空用重设 `innerHTML` | `apps/viewer/src/ui/hud.ts:140` 到 `apps/viewer/src/ui/hud.ts:143` |
| 光照模式分区初值 | `<select id="lightingMode">` 的两档写死 `baked` / `texture`，初值设 `'baked'`；变更经构造参数冒泡到 `ViewerScene.setLightingMode` | `apps/viewer/src/ui/mapinfo.ts:92` 到 `apps/viewer/src/ui/mapinfo.ts:99` |
| 更换地图入口 | `<label for="bspFile">` 另挂 click 并 `preventDefault`，显式转发 `#bspFile.click()` | `apps/viewer/src/ui/mapinfo.ts:64` 到 `apps/viewer/src/ui/mapinfo.ts:67` |
| 信息面板两段 | 核心三行（文件 / 出生点数 / 世界尺寸）常显，统计明细整段收进折叠容器 | `apps/viewer/src/ui/mapinfo.ts:144` 到 `apps/viewer/src/ui/mapinfo.ts:173` |
| ★ 与初始视角同源 | 推荐下标由调用方传入（`apps/viewer/src/app.ts:262` 传 `resolveInitialSpawn` 的命中下标），缺省时回落 `result.primary` | `apps/viewer/src/ui/mapinfo.ts:132`、`apps/viewer/src/core/spawn.ts:96` |
| 出生点行内容 | 单行 pill：`#i classname`（推荐项带 ★）+「跳转」按钮；坐标与角度全量进 `title`，角度走 `spawnPointAng` | `apps/viewer/src/ui/mapinfo.ts:190`、`apps/viewer/src/ui/mapinfo.ts:195` 到 `apps/viewer/src/ui/mapinfo.ts:201` |
| 信息条只重渲染、不进帧循环 | `setTracks` 在轨道增删 / 跟随切换时整条重建；无轨道或无 `meta` 时清空并加 `hidden` | `apps/viewer/src/ui/replaymeta.ts:24` 到 `apps/viewer/src/ui/replaymeta.ts:33` |
| 缺字段不造值 | `meta.time` / `steamIdDisplay` / `map` / `timestamp` 为空时对应项不出现 | `apps/viewer/src/ui/replaymeta.ts:58`、`apps/viewer/src/ui/replaymeta.ts:67`、`apps/viewer/src/ui/replaymeta.ts:70`、`apps/viewer/src/ui/replaymeta.ts:89` |
| `zoneOffset` 只进 title | 亚 tick 份额非零时并入成绩项的悬停说明，不上条面 | `apps/viewer/src/ui/replaymeta.ts:59` 到 `apps/viewer/src/ui/replaymeta.ts:65` |
| 速度读数口径 | 横向 = `Math.hypot(vel[0], vel[2])`、竖向 = `Math.abs(vel[1])`，都取 0 位小数；无速度数据时两格写 `—` | `apps/viewer/src/ui/telemetry.ts:104` 到 `apps/viewer/src/ui/telemetry.ts:110` |
| 按键高亮判据 | 八键各自的 IN_* 位掩码与当前帧掩码相与非 0 即加 `on` 类；`buttons` 为 null 时全灭 | `apps/viewer/src/ui/telemetry.ts:29` 到 `apps/viewer/src/ui/telemetry.ts:40`、`apps/viewer/src/ui/telemetry.ts:113` |
| 八键布局 | Q / W / E 上排、A / S / D 中排、蹲 1 格 + 跳 2 格下排（位置由 CSS 网格区决定） | `apps/viewer/src/ui/telemetry.ts:50` 到 `apps/viewer/src/ui/telemetry.ts:59`、`apps/viewer/web/styles.css:326` 到 `apps/viewer/web/styles.css:333` |
| 速度行随轨道显隐 | `setTracks(false)` 给速度行父元素加 `hidden` 类 | `apps/viewer/src/ui/telemetry.ts:92` 到 `apps/viewer/src/ui/telemetry.ts:94` |

## 已知缺口

1. **光照模式下拉只写不回填**：`<select>` 的初值是写死的字符串 `'baked'`（`apps/viewer/src/ui/mapinfo.ts:98`），而运行期真实模式由共享 uniform 侧决定（`apps/viewer/src/renderer/lightmap-shader.ts:442`）；任何绕过下拉的写入（例如外部脚本调用 `ViewerScene.setLightingMode`，`apps/viewer/src/core/scene.ts:245`）都不会回填到控件，下拉显示会与实况脱节。同一默认值在本工程存在两处来源（另一处是 `apps/viewer/src/core/scene.ts:65`）。
2. **`MapPanel.spawnPoints` getter 零调用点**：`apps/viewer/src/ui/mapinfo.ts:114` 暴露的出生点快照（含 ★ 前缀与坐标）在 `apps/viewer/src` 内无读取者，跳转列表由 `renderSpawns` 直接建 DOM（`apps/viewer/src/ui/mapinfo.ts:176`）。
3. **`setMap(null)` 的清空分支无调用点**：`setMap` 支持 `result` 为 null 的清空路径（`apps/viewer/src/ui/mapinfo.ts:130`、`apps/viewer/src/ui/mapinfo.ts:138`），而唯一调用点只传非 null（`apps/viewer/src/app.ts:262`）⇒ 面板没有「卸载地图」入口，`reloadWrap` 的隐藏分支（`apps/viewer/src/ui/mapinfo.ts:130`）同样不会被触发。
4. **遥测 HUD 自算水平速度，与采样模块的导出重复**：`apps/viewer/src/ui/telemetry.ts:105` 现场算 `Math.hypot(s.vel[0], s.vel[2])`，而同一口径已有现成实现 `apps/viewer/src/replay/sampling.ts:87`（并被 `apps/viewer/src/replay/player.ts:239` 转发，两者都无调用点）⇒ 同一语义存在两份代码。
5. **`setTracks` 对父元素做强转**：`apps/viewer/src/ui/telemetry.ts:93` 把 `this.horizEl.parentElement` 断言为 `HTMLElement` 后直接调 `classList`；容器已脱离文档或速度行未挂载时该断言为 null 会抛 TypeError。当前构造路径保证速度行已 `appendChild` 到传入容器（`apps/viewer/src/ui/telemetry.ts:75`），但调用方若传入脱离文档的元素（`apps/viewer/src/app.ts:174` 的兜底分支就是 `document.createElement`）则该前提不成立。
6. **按键簇渲染八键，标签集含 Q / E**：`KEYS` 实测八项（`apps/viewer/src/ui/telemetry.ts:50` 到 `apps/viewer/src/ui/telemetry.ts:59`），与 CDP 冒烟脚本里「按键数 = 6、标签集为 {W,A,S,D,跳,蹲}」的断言不一致（测试侧见 `documents/viewer/implementation/scripts-and-test.md`），当前 UI 下该断言不成立。
7. **信息条自己重找跟随轨道**：`ReplayMetaPanel.setTracks` 在收到的轨道数组里按 `followId` 再查一次并回退第一条（`apps/viewer/src/ui/replaymeta.ts:25`），与 `TrackSet.follow` 的同一策略（`apps/viewer/src/replay/tracks.ts:92`）重复；两处若口径分叉，信息条会与第一人称相机跟随不同的轨道。
8. **`el()` 的属性写入限制了 id 型契约**：面板里需要被外部查询的控件靠 `attrs.id` 落地（例：`apps/viewer/src/ui/mapinfo.ts:89` 的 `id: 'lightingMode'`、`apps/viewer/src/replay/panel.ts:147` 的三个平移输入），而 `el()` 对 `undefined` / `false` 值跳过、对 `true` 写空串（`apps/viewer/src/core/dom.ts:39` 到 `apps/viewer/src/core/dom.ts:42`）⇒ 传 `id: undefined` 时控件静默无 id，外部按 id 取值的路径（深链、冒烟脚本、外部脚本）会取到 null。
