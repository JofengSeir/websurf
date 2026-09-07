# viewer 实现细节 · 录像回放系统（src/replay/ + worker/）

> viewer 回放的一切建立在一条固定管线上：**任意 JSON → 规则脚本映射 → 标准帧 → Clip（定型数组）→ 播放**。
> 播放器只认 Clip；"第三方格式"只是换一个映射脚本。总览见 [../overview.md](../overview.md)，
> 时序见 [../sequences.md](../sequences.md)，.js 规则写法契约另见 [../replay-rule-ai.md](../replay-rule-ai.md)。
> 本文按数据流顺序展开 16 个模块，所有论断标注 `文件:行号`。

## 1. 数据契约层（`viewer/src/replay/types.ts`，205 行）

### 1.1 标准帧 Frame（`types.ts:96-105`）与映射器（`types.ts:108`）

```ts
interface Frame { t: number; pos: [number,number,number]; ang: [number,number,number]; vel: [number,number,number] | null }
type FrameMapper = (raw: unknown, index: number, H: unknown) => Frame;
```

- `t` 秒、**单调不减**（相等合法）；`pos` = **脚底**、viewer 世界坐标 Y-up；`ang = [yaw, pitch, roll]` 度（yaw 0 = −Z 逆时针，pitch 正 = 仰视 ±89° 限幅）；`vel` 世界速度 HU/s 或 null。字段注释即契约（`types.ts:97-104`）。
- `H` 是助手集（见 §2）；`index` 供 tick 换算（`t = i / tickrate`）。

### 1.2 RuleConfig（`types.ts:29-92`，默认值 `types.ts:168-205`）

声明式映射的可选字段（全部可省——**scriptSrc 才是本体**，其余字段是给"不写脚本"用户的旋钮/历史兼容）：

| 字段组 | 字段 | 语义 |
|---|---|---|
| 帧定位 | `framePath`（`types.ts:36`） | 帧数组路径；空 = 自动探测（§2.3） |
| 位置 | `posX/Y/Z` 路径、`axisX/Y/Z` 输出轴映射、`signX/Y/Z`、`posScale`、`offX/Y/Z`、`posIsEye`（`types.ts:39-60`） | 脚本缺省时的声明式替代；`posIsEye` 表示输入是眼位（构建时减 `EYE_STAND`） |
| 朝向 | `yawPath/pitchPath/rollPath`、`angleUnit`（deg/rad）、`yawScale/yawOffset`、`pitchSign/rollSign`（`types.ts:61-79`） | `yaw_out = wrap(yaw_in × yawScale + yawOffset)`（注释 `types.ts:67`） |
| 时间 | `timeMode`（tick/field）、`tickrate`、`timePath`、`timeUnit`（s/ms/tick）（`types.ts:80-90`） | tick 模式 `t = i / tickrate` |
| 速度 | `velX/Y/Z`（`types.ts:87-90` 附近） | 空则 `vel = null` |
| 脚本 | `scriptSrc`（`types.ts:87`） | **一等公民**：单表达式映射脚本 |
| 后处理 | `transform?: RuleTransform { offset, yawDeg }`（`types.ts:11-14, 91`） | 人工微调，在**脚本输出之后**统一施加（§4.2） |

### 1.3 Clip（`types.ts:112-132`）与 Track（`types.ts:146-158`）

- `Clip`：`t` Float64Array（n）、`pos/ang/vel` Float32Array（3n，vel 可能 null）、`count/duration/bbox/min·max/maxSpeed/resolvedPath/rule`。**可转移**（Worker 零拷贝回传，§6）。
- `Track`：`clip + { id, name, color, visible, offset }`——`offset`（秒）把本轨第 0 帧对到主时钟某刻，用来对齐起跑不同的多轨对比。

## 2. 取值助手与帧数组探测（`viewer/src/replay/helpers.ts`，145 行）

### 2.1 助手集 H（`helpers.ts:21-74`）

| 调用 | 行为 | 位置 |
|---|---|---|
| `H.get(root, "a.b[0].c")` | 按 `.` / `[n]` 路径取值，缺失 undefined | `helpers.ts:21-38` |
| `H.num(v)` | 转数字；无效值（undefined/null/NaN/非数值）→ NaN | `helpers.ts:41-45` |
| `H.wrap(d)` | 角度归一 [0,360) | `helpers.ts:48-50` |
| `H.clampPitch(d)` | pitch 限幅 ±89° | `helpers.ts:53-56` |
| `H.deg(rad)` | 弧度 → 度 | `helpers.ts:59-61` |
| `H.clamp(v, lo, hi)` | 通用限幅（内联定义于助手集内） | `helpers.ts:73-74` |
| `H.EYE` | 站立眼高 64.09（复用 `core/constants.ts:7`） | `helpers.ts:71` |

`REPLAY_HELPERS` 对象（`helpers.ts:64-74`）作为第三实参传给脚本——**这就是 `.js` 规则里 `H` 的实体**（传参点：`build.ts` 的 `fn(frame, i, H)` 调用与 `codegen.ts` 的探针，见 §3）。

### 2.2 帧数组自动探测（`helpers.ts:78-145`）

- `findArrayCandidates(root, maxDepth=4)`（`helpers.ts:93-139`）：广度优先遍历对象树，深度 ≤4；候选 = **元素数 ≥2 且首元素是普通对象**的数组（`helpers.ts:97-104`）；遍历环引用 `seen` 防护（`helpers.ts:107-108`）、候选 >60 停止下钻（`helpers.ts:105`）。
- 排序：长度降序 → 深度升序，最终只取前 30（`helpers.ts:136-138`）。
- `pickFrameArray(root)`（`helpers.ts:142-145`）：取第一名；找不到 → null → 上层报"没能在 JSON 里自动找到『元素为对象的数组』"。

## 3. 规则脚本编译与试跑（`viewer/src/replay/codegen.ts`，74 行）

### 3.1 编译契约（`codegen.ts:14-22`，实现原文）

```ts
export function compileScript(src: string): FrameMapper {
  // 容错：剥掉 AI 产码常见的尾分号（整个文件会被包进 return (…) 里）
  const body = src.trim().replace(/;+\s*$/, '');
  const factory = new Function(
    'H',
    '"use strict";\nreturn (' + body + ');',
  ) as (H: unknown) => FrameMapper;
  return factory(REPLAY_HELPERS);
}
```

要点（写作 `.js` 时逐条对应，详见 [replay-rule-ai.md](../replay-rule-ai.md)）：

- 文件内容 = **单个 JS 表达式**（求值为 `(raw, i, H) => Frame`），可带前置 `//` 注释；
- `new Function('H', 'return (…)')` 的形式决定了：不要 `const`/`module.exports`/`export`/IIFE；
- 剥尾分号只是容错（`codegen.ts:16`），**结尾不要写分号**；
- `H` 在编译期即绑定 `REPLAY_HELPERS`（`codegen.ts:7, 22`）——探针与 build 的每次调用传同一实例；
- 编译错误（语法）在 `new Function` 构造时直接抛（自检断言 `test/replay-selftest.ts:207-212`）。

### 3.2 三帧试跑校验（`probeScript`，`codegen.ts:36-74`）

对帧数组取 `[0, 中间, 最后]` 三个探针（去重、防空数组越界，`codegen.ts:37-40`），逐帧验证（`codegen.ts:41-73`）：

1. 函数执行抛异常 → `第 N 帧执行出错：…`；
2. 返回非对象 → `第 N 帧未返回对象`；
3. `t` 非有限数 → `第 N 帧的 t 不是有效数字（…）——检查时间配置`；
4. `pos` 不是 3 个 number 或含非有限值 → `第 N 帧的位置不是三个有效数字（[原始值]）——检查位置字段路径与轴映射`（`NUM3` 只验"3 个 number 类型"，NaN 由 `Number.isFinite` 补抓，`codegen.ts:32-33, 52-58`）；
5. `ang` 同理（`codegen.ts:59-65`）；`vel` 允许 `null`/`undefined`，存在时必须是 3 个 number（`codegen.ts:66-68`）。

探针**只抽三帧**——抽查通过不代表每帧都好，真正的逐帧容错在 build 层（§4.1），这也是自检 [8] 节绕过探针直灌脏数据验证兜底的原因（`test/replay-selftest.ts:237-256`）。

## 4. 构建与后处理（`viewer/src/replay/build.ts`，230 行）

### 4.1 buildClip（`build.ts:28-148`）

逐帧执行 `fn(frame, i, H)` 并写入定型数组（`build.ts:28-148`），关键行为：

- **时间单调兜底**（`build.ts:60-71`）：`t` 非法或回退时沿用 `prevT` 并计入告警——保证二分查找前提（`sampling.ts:24-38`）。
- **脏帧兜底**（`build.ts:74-99`）：`pos/ang` 出 NaN 时沿用上一帧值并计告警（"个别帧缺字段不炸，但有告警可查"，告警汇总 `build.ts:126-133`）；`vel` 可选——从未出现过有效值则整轨 `vel = null`（`build.ts:100-112`）。
- **bbox / maxSpeed**：逐帧扩张（`build.ts:114-119`）。
- **进度节流**：`PROGRESS_MIN_STEP = 4096`（`build.ts:23`），约每 2% 上报一次，29 万帧 ≤50 次回调（自检 [11] 断言 `test/replay-selftest.ts:399-418`）。
- **大轨道提醒**：`LARGE_CLIP_FRAMES = 100_000`（`build.ts:26`）——超过则面板摘要附"帧数较多，改规则重新导入耗时较长"（`panel.ts:319-326`）。
- **warning 形态**：英文机器可读 + 面板聚合展示（`panel.ts:327-330` 把 warnings 与摘要合并成一条 note）。

### 4.2 transform 后处理（`applyClipTransform`，`build.ts:150-205`，函数 158 起）

脚本输出之后统一施加（所以"变换"不用改脚本）：

- `offset`：pos 整体平移（`build.ts:160-175` 区域）；
- `yawDeg`：绕 Y 旋转——`pos` 与 `vel` 的 XZ 分量同步旋转、`yaw` 同步加角（正 = 逆时针），pitch/roll 不动（`build.ts:157-205`）；
- bbox **完全重算**（不是平移旧 bbox，`build.ts:195-205`）；
- **刚体变换不污染速度模长**——自检断言（`test/replay-selftest.ts:316-320`）。

设计注记：`finite3()`（`build.ts:208-222`）在 transform 阶段对无效坐标**返回 null 而不是兜底**——变换是刚体操作，输入有 NaN 说明上游已脏，此时宁可在告警里暴露而不是静默把 NaN 平移出个"看似合法"的值（`build.ts:208-212` 注释）。

`safePreview`（`build.ts:225-236`）：错误信息里嵌原始帧 JSON，截 240 字符——报错形态示例见 README 故障排查表（`../README.md:112-115`）。

## 5. 采样层（`viewer/src/replay/sampling.ts`，80 行）

**纯函数模块**（`sampling.ts:1-6` 注释"纯函数：给 player 与 tracks 共用，避免循环依赖"）：

| 函数 | 行为 | 位置 |
|---|---|---|
| `lerpAngle(a,b,t)` | yaw/roll 用**最短弧**插值（350°→10° 走 +20° 不走 −340°） | `sampling.ts:11-14` |
| `lerp(a,b,t)` | pos/pitch/vel 线性 | `sampling.ts:16-18` |
| `indexInClip(clip, t)` | 二分查找（前提：`clip.t` 单调不减——build 层保证，§4.1），夹取 [0, n−1]（末帧时 a=0，采样退化取末帧值） | `sampling.ts:24-38` |
| `sampleClip(clip, t)` | 区间插值出 `{pos, ang, vel, index}`；span ≤1e-9 或末帧时 a=0 | `sampling.ts:41-74` |
| `horizontalSpeed(sample)` | `hypot(vx, vz)`（时间轴速度读数的"水平"项） | `sampling.ts:77-80` |

## 6. Worker 与回退（`viewer/src/worker/parse-worker.ts` 130 行、`viewer/src/replay/importer.ts` 199 行、`viewer/src/replay/protocol.ts` 31 行）

### 6.1 消息协议（`protocol.ts:19-31`）

- 请求 `ParseRequest { id, type:'import', file: File|null, rule, name }`——`file=null` = 复用已解析缓存（改规则重导）；
- 响应 `progress { phase:'parse'|'map', done, total }` / `done { payload, warnings, resolvedPath }` / `error { message }`；
- `ClipPayload`（`protocol.ts:6-17`）：`t` Float64Array + `pos/ang/vel` Float32Array——**Transferable 零拷贝**回传（post 第二参 transfer 列表）。

### 6.2 Worker 主流程（`parse-worker.ts:67-114`）

```
ensureRoot（parse-worker.ts:28-47）
  file 非空 → 缓存 JSON.parse（大文件耗时大头在此，改规则不再解析）；file=null → 复用
locateFrames（parse-worker.ts:49-60, 74-75）
  rule.framePath 或 pickFrameArray 自动探测（§2.2）
compileScript + probeScript（parse-worker.ts:77-83）
buildClip（parse-worker.ts:86-94）——与主线程共用同一函数（§4）
post('done', payload, [t.buffer, pos.buffer, ang.buffer, vel?.buffer])（parse-worker.ts:96-107）
```

- Worker 顶部 import 与主线程回退**同一组模块**（`parse-worker.ts:8-12` vs `importer.ts:3-5`）——两条路径行为一致，且让管线核心可以在 Node 里裸测（`test/replay-selftest.ts:1-6`）。

### 6.3 导入器（`importer.ts`）

- **建 Worker**（`importer.ts:37-77`）：常规构建 `new Worker(new URL('./parse-worker.js', import.meta.url), { type:'module' })`（`importer.ts:49`）；单文件构建从 `globalThis.__VBSP_WORKER_JS__` 建 Blob URL（file:// 下 module worker 被拦，`importer.ts:41-47`）。
- **失败降级**（`importer.ts:62-70, 104-107`）：`onerror` 一次 → `workerBroken = true` → 拒绝所有在途请求（明确报错不挂死）→ 后续导入走 `importOnMain`（`importer.ts:136-163`：同一链路 + 自己的 `mainFile/mainRoot` 缓存）。
- **在途请求表**（`importer.ts:79-108`）：pending map 按 id 派发回；progress/done/error 三型分流。
- `payloadToClip`（`importer.ts:184-199`）：payload → Clip，`id = clip-<Date.now().toString(36)>`。

## 7. 可视化层（`viewer/src/replay/visuals.ts`，174 行）

每条轨道三件套（`visuals.ts:12-18` 注释）：

- **轨迹线** `THREE.Line`：抽稀采样，上限 `MAX_TRAIL_POINTS = 40000`（`visuals.ts:10, 107-110`——stride = ceil(total/40000)，注释"29 万帧 → stride 8"），整体抬升 +8 HU 防穿地（`visuals.ts` 内 TRAIL 常量），`frustumCulled = false`（线段端点稀疏时包围球不可靠）。
- **幽灵**：`CapsuleGeometry(16, 40)` ≈ 玩家碰撞体 32×72（半径 16 + 总高 72），叠 `ConeGeometry(9, 26)` 朝向锥标 nose（yaw 方向，`visuals.ts:136-158`）。
- **起终点标记**：首/末帧球体（`visuals.ts` `buildMark`）。

`update(samples, mode, followId)`（`visuals.ts:46-67`）：**第一人称只隐藏被跟随那条的幽灵**（它贴在相机上会挡满屏），其余轨道照常——这正是多轨对比的意义（注释 `visuals.ts:41-45`）。`setTracks` 全量重建（增删轨时调用），逐帧更新只摆位不重建（`visuals.ts:29-40`）；dispose 沿 `disposeTree` 递归清理。

## 8. 面板层（panel.ts 486 行 / trackpanel.ts 214 行 / timeline.ts 251 行）

### 8.1 ReplayPanel（`viewer/src/replay/panel.ts`）

**分区**（构造 `panel.ts:79-200`）：导入（按钮 + 规则脚本折叠）→ 轨迹列表（TrackPanel 嵌入）→ 变换调整（note 常显 + 工具折叠）。

- **导入入口**：`loadFile`（换文件 = 追加新轨，`panel.ts:239-250`：`lastTrackId = null` + freshFile 解析缓存）、`ingestJson`（.json 双语义——≤4MB 先试规则 JSON 判定，超限直接按录像，`panel.ts:257-266`）、`loadRuleFile`（.js / 规则 JSON，`panel.ts:413-423`）、`loadSample`（示例录像，`panel.ts:288-293`）、`loadUrlContent`（深链直喂文本，`panel.ts:272-286`）。
- **busy 闸**（`panel.ts:57, 240-243, 300-304`）：导入期间到达的重导请求不排队，明确告知"本次改动未生效——请稍候重试"。
- **runImport**（`panel.ts:295-339`）：`freshFile` 时把文件交给 importer 解析缓存，否则 `file=null` 复用；进度经 `onStatus` 进 HUD 录像域；结果经 `onClip` 回 app（替换/追加判定见 [../sequences.md](../sequences.md) §3）；摘要 + warnings 合并一条 note（`panel.ts:318-331`）。
- **规则脚本折叠**（`panel.ts:108-141`）：折叠标题常显当前来源（`refreshRuleView`，`panel.ts:393-398`："内置默认" / 文件名 / "localStorage 规则" / 深链名）；「载入规则脚本…」（`.js,.json` 同一选择器）+「复制脚本」（`panel.ts:122-133, 400-407`）。
- **规则持久化**（`panel.ts:20, 209-229`）：`STORAGE_KEY = 'websurf-viewer.replay-rule.v1'`，读入要求 `version===1 && scriptSrc` 字符串，写失败静默（隐私模式）；`transform` 随规则一起持久化。
- **变换调整**（`panel.ts:150-199, 341-385`）：平移 XYZ + yaw 输入（step 10/15），改动 → `saveRule` + **500ms 防抖重导**（`panel.ts:344-358`）；`yaw ±90°` 一键修正侧转（`bumpYaw`，`panel.ts:360-365`）；「重置变换」（`panel.ts:367-374`）；输入框与规则状态由 `syncTransformInputs` 单向同步（无 transform 的规则也要归零输入框，防旧值残留污染新规则，`panel.ts:377-385`）。
- **起点对齐**（`panel.ts:443-460`）：note 常显"录像起点距最近出生点 X HU"；≤128 HU 视为贴合，首次失配自动展开调整工具（持续失配不反复顶开，`lastAnchorWarn`）；1024 HU 量级在帮助浮层标为"严重失配"（阈值口径统一在 `web/index.html:72-74`）。
- **一键锚定**（`panel.ts:462-485`）：把 `getStartAid`（app 计算：首帧 → 最近出生点的欧氏距离与平移 Δ，`app.ts:196-222`）的 Δ **叠加**进 `rule.transform.offset` 再重导——"叠加"不是覆盖，多次锚定不丢之前的手工平移。

### 8.2 TrackPanel（`viewer/src/replay/trackpanel.ts`）

每轨一张两行卡：行 1 色块 + 名称（可改名回车生效）+ 帧数/时长；行 2 显隐 ◉/◌ + 时间偏移（秒，输入即生效）+ 跟随 ◎ + 移除 ×（`trackpanel.ts:149-213` 区域）。批量操作（全部显示/全部隐藏/偏移归零/清空全部）**只在有轨道时渲染**（`trackpanel.ts:48-79`）；`onCleared` 回调把"清空全部"升级为 app 级复位（HUD 提醒行清空 + 起点对齐 hint 复原，`trackpanel.ts:15-16` + `app.ts:132-138`）。

### 8.3 Timeline（`viewer/src/replay/timeline.ts`）

- 行 1：播放/停止、逐帧 ◀/▶、时间+帧读数、进度条（`seekRatio` 0-1000 拖动）、倍速选择（`SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4]`，`timeline.ts:13`）。
- 行 2：视角（第一/第三人称）、循环、轨迹线/幽灵开关、A-B 起点/终点（"整段"清除）、速度读数（被跟随轨的总/水平/垂直 HU/s；无 vel 显示"速度 —"，`timeline.ts` 读数区）。
- 键盘：`K` 播放/暂停、`,`/`.` 逐帧、`I`/`O` A-B——`isTypingTarget` 守卫输入框（`timeline.ts:163-185`，守卫函数 246-251）。
- 刷新策略：事件驱动 `refresh()` + app 帧循环 80ms 节流（`app.ts:478-482`）。

## 9. 示例与测试

### 9.1 示例录像（`viewer/src/replay/sample.ts`，59 行）

`buildSampleReplayText()` 生成 3072 帧合成螺旋（半径 900 收缩、y 900 递降、tick 128、viewer 原生约定），与真实文件走**同一条导入管线**（`panel.ts:288-293` → `loadFile`）——冒烟测试与首次体验共用它（`test/smoke-cdp.mjs:314-339`）。

### 9.2 Node 自检（`viewer/test/replay-selftest.ts`，421 行；`npm run test:replay`）

11 节覆盖（无 DOM、纯管线核心）：

| 节 | 断言内容 | 位置 |
|---|---|---|
| [1] | getPath 路径取值 / wrapDeg | `replay-selftest.ts:43-51` |
| [2] | 帧数组自动探测（嵌套/多候选） | `replay-selftest.ts:52-57` |
| [3] | DEFAULT_RULE（时长 = 511/128） | `replay-selftest.ts:58-89` |
| [4]/[4b] | 播放器采样 / A-B 区间 | `replay-selftest.ts:90-137` |
| [5] | 自定义脚本形态（缩放/眼位/弧度/毫秒/速度） | `replay-selftest.ts:138-162` |
| [6] | **Source→viewer 定标断言**（(x,y,z)→(y,z,x)、viewerYaw=srcYaw+180、pitch 取反、视角与运动方向 cos>0.999） | `replay-selftest.ts:164-196` |
| [7]/[7b] | 错误处理（probe 抓坏路径/语法错抛）/ 规则文件双形态 | `replay-selftest.ts:198-235` |
| [8] | 脏数据兜底（NaN 沿用 + 告警计数） | `replay-selftest.ts:237-256` |
| [9] | transform 后处理（恒等/平移/旋转/组合/速度模长不变） | `replay-selftest.ts:258-320` |
| [10] | 多轨迹对比（Q2） | `replay-selftest.ts:322-397` |
| [11] | 大文件进度节奏（29 万帧 40~120 次回调、单调） | `replay-selftest.ts:399-418` |

### 9.3 浏览器冒烟（`viewer/test/smoke-cdp.mjs`，613 行；`npm run test:smoke`，需 `npm run dev`）

CDP 驱动 Edge headless（SwiftShader 软渲染）。断言范围：dist 结构静态断言（classic script / 内嵌 base64 wasm+worker / dist 无独立 wasm 与 worker 文件 / dist-multi 不存在，`smoke-cdp.mjs:121-143`）→ 页面加载无兜底卡 → 示例导入 → 播放/A-B → 变换（坐标级断言：仍是 1 条、时长不变，`smoke-cdp.mjs:384-422`）→ 拖入 .js 规则（替换不追加，`smoke-cdp.mjs:424-451`）→ 双轨对比与跟随切换（`smoke-cdp.mjs:464-509`）→ 全程 console 零错误。

## 10. 回放侧坐标与 yaw 约定（约定即代码）

- 标准帧 `pos` = 脚底（Y-up）；相机眼位 = pos + 64.09（`fly.ts:174-177`）。
- `ang[0]` yaw：0 = 面朝 −Z，逆时针为正（`pose.ts:5-9`；第一人称相机写法 `fly.ts:174-177` `rotation.set(pitch, yaw, roll, 'YXZ')`）。
- Source 系数据的换算定标以**可执行断言**固化：`test/replay-selftest.ts:164-196`（`[x,y,z]→[y,z,x]` 与 GLB 导出 `map_coords`、出生点 `rotate_yup` 同变换——`src/wasm-core/bsp_to_gltf_core/convert.rs:813-816`、`viewer/crates/wasm/src/lib.rs:339-342`；`viewerYaw = srcYaw + 180`、pitch 取反）。Shavit 的 `vel` 是按键打包**不要映射**（`../README.md:205`；selftest 的 Source 示例脚本输出 `vel: null`，`replay-selftest.ts:178`）。
- 写第三方映射时按 [replay-rule-ai.md](../replay-rule-ai.md) 的契约与模板产出。
