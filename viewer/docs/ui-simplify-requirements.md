# viewer UI 简化 — 需求分析与复杂度清单（基线文档）

> 状态：round 1 需求基线（2026-09-04 生成，分析范围以代码为准）
> 对象：`D:\code\projects\websurf\viewer`（index.html / styles.css / src/* / README.md / docs/overview.md / test/* / scripts/*）
> 方法：通读全部 9,089 行源码与文档 + 渲染态 DOM 快照核对；每项结论给「证据（文件:行号）+ 理由 + 判定」。
> 目标：**在不丢失任何能力与既有外部接口的前提下**，系统性简化操作逻辑与面板视觉（合并重复入口、收敛信息层级、简化交互路径）。
> 底线：不砍功能、不动 WASM/Rust 层（`crates/wasm`、`pkg`）、不改数据契约（RuleConfig v1 / Clip / 位姿约定 / URL 深链参数）。
> 行号基线：src/app.ts(517)、src/replay/panel.ts(981)、src/replay/timeline.ts(247)、index.html(99)、styles.css(290)。

> **实现标记（t2/t8 落地后补充，本文保留为基线记录、正文未删改）**：实现按 §4 S1–S10 与 §5/§8 落地，
> 与正文存在以下已裁决/事实差异——
> 1. S1/S2：顶栏实际为「?」帮助 +「面板」两个小按钮（帮助入口需要可点击宿主，HUD `pointer-events:none`
>    无法承载；「加载 BSP 地图」按钮已移除，换图入口在地图页顶部「更换地图」）。
> 2. S3：组 2「对齐与校正」（朝向诊断 / 坐标系标定）按 §5-B6 与评审约束**默认展开**（组 1/2 开、组 3 收），
>    不再「无轨道时收起」；清空轨道也不会自动收起，仅用户手动折叠后再次导入会自动展开。
> 3. S7：地图信息核心行 = 文件 / 出生点数 / 世界尺寸（GLB 体积行因 meta 不可得未实现），其余入
>    「统计明细」折叠；出生点条目为单行 pill。
> 4. S6/S8：量测拾取为「开始拾取 / 结束拾取」aria-pressed 按钮；教学文案收敛进帮助浮层与控件 title。
> 5. S9：HUD 仅保留 bbox 跨面提醒；起点对齐阈值（≤128 贴合 / ≥1024 处理）口径写入帮助浮层，
>    「起点对齐」note 承载细节与动作指引。
> 6. S5：倍速无文字 label、置于 row1 进度条右侧；row2 无「视角 / 区间」文字 label；无速度数据时
>    读数 =「速度 —」（原因进 title）。
> 7. 帮助浮层含 5 主题（键位 / 位姿三通道 / 载入 / HU 换算 / 对齐阈值）；引导卡含
>    「帮助：载图后点右上角『?』」指引行；「清空全部」/逐条移除到零经 onCleared 接回
>    app.onClearAll（复位起点对齐提示与 HUD 录像提醒行）。

---

## 1. 功能需求全景（用户流程）

先列「用户干什么、经哪条路、用哪块 UI」，简化方案必须保证每条流程仍可达。

### F1 首访 / 加载 BSP 地图
- 入口：引导卡按钮 `#guideBtn`（index.html:23-39）｜全窗拖拽 `.bsp`（app.ts:348-372）｜顶栏 `#bspbarBtn`（index.html:58-61；仅已有地图时可见——无地图时被 `#guide` z-8 全屏盖住，见 styles.css:240-243 vs 42-44）。
- 流程：`loadBsp`（app.ts:271-318）→ WASM 懒初始化 → metadata → spawn → GLB → `scene.mountGlb`（core/scene.ts:94-120）→ 分块合并 + 雾自适应 → 地图面板/量测网格/出生点刷新（app.ts:290-295）→ 初始视角（外部位姿 > 推荐出生点，app.ts:321-334）。
- 失败路径：无模型→引导层人话错误卡（app.ts:304-313）；有模型→状态行闪现（flashStatus）；启动异常→`#fatal` 兜底卡（index.html:79-96）。
- 业务规则：解析互斥（bspLoading，app.ts:272-273）；多文件拖拽取首个（app.ts:358）；换地图=重建（scene.ts:105-109 dispose 旧模型）。

### F2 自由视角浏览
- 点击画布指针锁定；WASD 平移、空格/C 升降、Shift×4、Esc 解锁（core/fly.ts:57-166；键位清单 209-220）；人物=相机，pos 脚底 + 眼高 64.09（fly.ts:174-177，constants.ts:7）。
- 量测拾取期间禁止指针锁定（app.ts:103-108 → fly.allowPointerLock）。
- 键盘教学文案出现三处：引导卡（index.html:30-31）、HUD hint（index.html:46-48）、README 表格（README.md:69-76）。

### F3 地图信息与出生点跳转（侧栏「地图」页）
- MapPanel（ui/mapinfo.ts）：地图信息 kv 12 行（63-94）+ 出生点列表（107-141，点击「跳转」→ 相机移到出生点并套用 `bspYawToCsYaw` 视角）。
- 出生点快照同时供录像「起点对齐」「坐标系标定」的世界侧参考（mapinfo.ts:46-48；app.ts:150-156）。
- 初始视角默认落在推荐出生点（app.ts:321-334）。

### F4 两点量测与参考显示（侧栏「量测」页）
- MeasureTool（ui/measure.ts）：勾选「拾取模式」→ 点画布射线拾取两次（125-154）→ 输出 A/B/距离（含水平、高差）（178-192）；清空/交换（48-51）。
- 「参考显示」：地面网格 + 世界坐标轴开关（53-61），尺寸按地图包围盒自适应（88-112）。
- HU 说明 tip（62-65）。拾取中自动让出指针锁定（app.ts:103-108）。

### F5 位姿三通道（外部接口，必须原样保持）
- URL query `?pos=x,y,z&ang=yaw,pitch`（app.ts:408-412）｜hash `#pos=…` + hashchange 实时（app.ts:400-406）｜JS `window.viewer.setPose/getPose`（app.ts:375-383）。
- `window.viewer.replay` 只读内省（app.ts:385-397：trackCount/duration/time/playing/mode/followId/sceneObjects/orientation）。
- 约定：pos=脚底、Y-up；yaw 0 面朝 −Z 逆时针正；pitch 正=仰视 ±89°（core/pose.ts、README.md:307-314）。
- 第一人称回放期间三通道被忽略（app.ts:254-256、473-491）——保留。
- 解析实现：core/pose.ts:28-41（`pos`/`ang` 分隔符逗号/空白）；`normalizePose` 兼容数组与 `{x,y,z}/{yaw,pitch}`。

### F6 录像：导入（多入口）
- 三个等效入口：录像页「选择 JSON 录像…」（panel.ts:140-158）｜拖拽 `.json` 进窗口（app.ts:364-367，自动切录像页）｜「载入示例录像」（panel.ts:151-158, loadSample 884-889）。另有 URL 深链 `?replay=&rule=`（app.ts:415-457）。
- 导入=两步：probe 自动探测帧数组（面板可见路径下拉 + 首帧样例）→ runImport 应用规则建 Clip（panel.ts:891-961）。规则 localStorage 持久化 `websurf-viewer.replay-rule.v1`（panel.ts:42,481-500）。
- Worker 优先、主线程回退（importer.ts:46-176；worker/parse-worker.ts）。
- 业务规则：**换文件=追加轨道；改规则=替换当前轨道**（panel.ts:87-93 lastTrackId、app.ts:124-140、tracks.ts:44-54）；导入成功默认第一人称（app.ts:133）。

### F7 轨迹管理（多轨迹对比）
- TrackPanel（replay/trackpanel.ts）：每行 = 色点 + 可改名 + 帧数/时长 + 显隐 ◉/◌ + 偏移(秒) + 跟随 ◎ + 移除 ×（96-186）；行首批量按钮：全部显示/全部隐藏/偏移归零/清空全部（37-62）。
- TrackSet（replay/tracks.ts）：主时钟驱动；offset 对齐；短的播完停在终点；followId 决定第一人称/速度读数；`track-N` id 序列是自动化断言的一部分（smoke 依赖，见 §7）。

### F8 回放控制（底部时间轴）
- Timeline（replay/timeline.ts）：row1 = 播放/停止/◀帧/帧▶ + 时间 + 帧号 + 进度条（26-64）；row2 = 倍速 + 循环 + 视角（第一/第三人称）+ 轨迹线/幽灵 + 速度读数 + A-B 区间（A 起点/B 终点/整段 + 区间读数）（66-155）。
- 快捷键 K/,/./I/O（157-177，输入框内失效 242-247）。
- 第一人称下隐藏被跟随轨道的幽灵（visuals.ts:44-67）。

### F9 录像-地图对齐（起点锚定 / 坐标系标定）
- 「起点对齐」：自动算录像首帧 vs 最近出生点距离（app.ts:231-252 computeStartAid；阈值 START_ANCHOR_WARN=1024 报警走 HUD，app.ts:208-216）；面板 note 显示距离（panel.ts:710-723，128 HU 内算贴合）；「一键锚定到出生点」把 Δ 写进规则平移并重导（panel.ts:729-744）。
- 「坐标系标定」CalibPanel（replay/calibpanel.ts）：录像侧帧号→取原始坐标（184-208）；世界侧出生点下拉/用当前相机位置/手填（86-121）；≥2 组对应点→求解→应用（244-283）；纯函数 solveTransform（calib.ts:115-211）。

### F10 朝向诊断与一键修正（Shavit/Source 专用）
- 「朝向诊断」+「一键修正朝向」（panel.ts:239-265、746-882），算法 orientation.ts（computeOrientation/suggestYawFix，纯函数）。
- 自动化钩子：`window.viewer.replay.orientation`（panel.ts:124-127, 785-787）；CLI `tools/verify-replay-orient.mjs`（Node 侧，不依赖 DOM）。
- 依赖「已导入文件 + 有轨道」（refreshOrientButtons panel.ts:778-782，初始禁用）。

### F11 规则编辑（表单 ↔ 脚本）
- 表单分区（panel.ts）：位置(268-320)、朝向(323-370)、速度(373-384)、时间(387-431)、坐标系预设(224-236)、数据定位(178-212)、规则脚本(434-474)。
- 表单→脚本生成（codegen.ts generateScript）；脚本被手改后打 `customized` 标记、表单不再覆盖（panel.ts:443-449, 665-668）；可从表单重新生成；规则可导入/导出（502-538）；改完自动重导 0.5s 防抖（670-674；大文件提示 946-952）。

### F12 打包 / 部署 / 自检（回归门）
- `npm run typecheck`｜`build:ts`（typecheck + worker + esbuild app.js）｜`test:replay`（Node 自检）｜`test:smoke`（CDP 真浏览器，断言含 DOM 结构/按钮文案/`window.viewer.replay`/localStorage 预置规则，见 §7）｜`build:dist`（单一 dist：IIFE + 内嵌 WASM/Worker + classic script）。
- dist 静态断言在 test/smoke-cdp.mjs:121-143（详见 §7-D）。

---

## 2. 界面现状盘点（复杂度的事实基础）

按「常驻可见性」盘点全部 UI 元素（渲染态 DOM 已核对，与源码一致）：

| 面 | 内容 | 控件数（约） | 默认状态 |
|---|---|---|---|
| HUD 左上（index.html:44-55） | 标题 1 + 静态教学 hint 2（键位、位姿通道）+ 位姿读数 + 地图状态 + 录像状态 | 0 交互 / 5-6 文本行，约 150px 高 | 常驻（hints 永不清除） |
| 顶栏右上（57-62） | 加载 BSP 按钮 + 「面板」折叠钮 | 2 | 常驻（无图时被引导层盖住） |
| 引导层（23-39） | 标题 + 3 步说明（重复键位教学）+ 选文件按钮 + 错误区 | 1 | 无地图时全屏 |
| 侧栏「地图」页 | 地图信息 12 kv 行 + 出生点列表（每项 2 行+按钮，上限 260px 滚动） | 动态 | 面板默认展开 |
| 侧栏「量测」页 | 拾取开关（长文案 checkbox）+ A/B/距离 3 读数 + 2 按钮 + 网格/坐标轴 2 开关 + tip | 7 | — |
| 侧栏「录像」页 | **12 个分区**：录像文件、轨迹列表、起点对齐、数据定位、坐标系标定、坐标系预设、朝向诊断、位置、朝向、速度（可选）、时间、规则脚本 | **约 55 交互控件 + 10+ 说明 note** | 无文件时也**全部展开渲染** |
| 底部时间轴（有轨道才显示） | row1 6 控件/读数；row2 约 10 控件/读数 | 约 16 | 无轨道隐藏 |
| 拖拽层/致命卡/错误 note | 各状态层 | 0-2 | 按状态 |

合计常驻/半常驻控件 80+、可读文本行 40+。最重负载 = 录像页 12 分区全展开（panel.ts 一个文件 981 行，占全工程 UI 代码 ~55%）与 HUD 文本堆叠。

### 2.1 渲染态 DOM 佐证（dist 构建 + 本机 Edge headless）
- 无地图首屏：`#pane-replay` 已含全部 12 分区标题与全部控件（含被禁用的「运行朝向诊断」「一键修正朝向」，坐标系标定出生点下拉 disabled），意味着用户在导入任何录像前就要面对整套规则编辑器。
- 面板宽度固定 348px（styles.css:65），多行 label + 双 select 的「输出 X ←」行在窄行内换行挤压。

---

## 3. 复杂度清单（逐项证据 + 判定）

### C1 HUD 常驻信息过载
- 证据：index.html:44-55 —— 6 行文本（标题行 45、键位 hint 46-48、位姿通道 hint 49-51、`#pose` 52、`#bspStatus` 53、`#replayStatus` 54）叠在视口左上；`.hint` 三行彼此都是「教学/开发说明」而非状态。styles.css:23-29 整块常驻无折叠。引导层同屏再教一遍键位（index.html:30-31）。
- 复杂度类型：视觉信息层级（教学文案与运行状态同层）。
- 判定：**改**（详见 S1）。理由：静态教学文案属于「需要时可查」内容，不该与位姿/地图/录像状态同权常驻。

### C2 键位/操作教学文案三处重复
- 证据：引导卡（index.html:30-31）与 HUD hint（46-48）重复；README 操作表（README.md:69-76）第三份；时间轴快捷键只藏在按钮 title（timeline.ts:35-41）与 README（README.md:220-227）。
- 判定：**合**——唯一权威快捷键表 + 可折叠帮助（S8）。

### C3 HUD 位姿格式化逻辑重复实现
- 证据：app.ts:496-504（frame 内）与 app.ts:511-517（updateHudNow）是同一字符串模板的两份拷贝；`updateHudNow` 仅在启动时调用一次。
- 判定：**改**——抽 `hud.setPoseFrom(fly)` / 单函数（S1 附项）。属代码级重复，直接减维护面。

### C4 `bspYawToCsYaw` 双实现
- 证据：core/pose.ts:44-46 与 app.ts:336-338 同名同体两份；mapinfo.ts:4 用 pose.ts 的，app.ts 自留一份。
- 判定：**合**——app.ts 改 import（不改行为）。

### C5 录像页 12 分区一次性全展开（最大复杂度源）
- 证据：panel.ts 构造器 135-477 顺序建 12 个 `.sec`；无文件状态也全渲染（含标定全套输入、速度/时间/脚本等）；981 行单文件。
- 复杂度类型：默认可见性错误（全部高级内容与核心流程等权）；滚动距离长；用户无法分辨「导入→播放」的下一步在哪。
- 判定：**改**——按任务阶段折叠（S3）。**注意**：构造时仍须全量建 DOM（冒烟 [2] 在导入前断言 8 个分区标题存在，见 §7-D-2），折叠 ≠ 惰性渲染。

### C6 同一对齐告警在两个表面重复、阈值还不一致
- 证据：录像首帧离出生点距离告警 → HUD `#replayStatus`（app.ts:208-216，阈值 1024）**并且**面板「起点对齐」note（panel.ts:710-723，128 为贴合线）；触发路径相同（导入/换图后都刷两处：app.ts:293-295）。
- 判定：**合**——一处细节一处概要，阈值统一（S9）。

### C7 HUD 状态行职责混淆
- 证据：`#bspStatus` 同时承载：常驻地图状态、解析进度、BSP 失败、**录像导入进度**（panel.ts:935-937 onStatus → hud.flashStatus，经 app.ts:159-161）、其他工具消息（flashStatus 8s）；`flashStatus` 是「先换文、3s 后还原」的临时插队（hud.ts:27-37），同一行里常驻/闪现/告警三种语义轮换，用户无法预判哪条会消失。
- 判定：**改**——分「地图状态 / 录像提醒 / 位姿读数」三行角色化，临时消息只走提醒行（S9）。

### C8 轨迹列表批量按钮常显于空状态
- 证据：trackpanel.ts:37-62 —— 无任何轨道时「全部显示/全部隐藏/偏移归零/清空全部」四个按钮照常显示且可点（点了无效果）。
- 判定：**改**——空列表隐藏/禁用批量操作（S4）；行内控件密度单行过大（见 C9）。

### C9 轨迹行控件密度（348px 内 8 个元素）
- 证据：trackpanel.ts:96-186 —— 色点 + 改名输入 + 「12,345 帧 / 92.10 s」meta + ◉/◌ + 「偏移」+ 数字框 + s + ◎ + × 挤一行；smoke 依赖行内控件（§7-D）。
- 判定：**改**——两行式轨道卡（S4），保留全部控件与 class/顺序稳定性。

### C10 时间轴第二行控件堆积
- 证据：timeline.ts:66-155 —— 倍速+循环+视角+轨迹线+幽灵+速度读数+区间 A/B/整段+区间读数 ≈ 10 个控件/读数挤在第二行（宽度不足自动换行，styles.css:224-225 flex-wrap）。播放控制（row1）与「显示/区间设置」（row2）主次不分。
- 判定：**改**——重排分组与精简密度（S5）。

### C11 侧栏三页定位重复：「地图」页承载工具跳转
- 证据：index.html:64-73 —— 顶栏「面板」、tab「地图/录像/量测」三点都有切换语义；录像页内「起点对齐」「坐标系标定」「朝向诊断」三个修正工具散布在导入页长滚动中（panel.ts:170-265），相互之间无引导关系，用户常错过「先起点对齐再诊断」的顺序。
- 判定：**改**——把「对齐与修正」整理成一组顺序步骤（S3 组 2），不新开页面。

### C12 地图信息 12 行全展示（多为开发统计）
- 证据：mapinfo.ts:63-94 —— 文件/magic/brushes/faces/models/vertices/static props/PAKFILE/解析耗时/世界尺寸/bbox min/max；其中 magic、faces、models、vertices、static props、PAKFILE、解析耗时 7 项只对开发/排障有用，却与「出生点数、世界尺寸」同权。
- 判定：**改**——默认显核心 4-5 行，明细收进折叠（S7）。

### C13 出生点条目双行冗余 + 与标定下拉重复
- 证据：mapinfo.ts:116-127 —— 每条目「类名 + 坐标 + yaw + 跳转按钮」两行；坐标系标定面板又提供一份出生点下拉（calibpanel.ts:86-97），同数据两份 UI。
- 判定：**改/保留**：条目收敛为一行可跳转 pill（S7）；标定下拉是「取世界坐标」语义，保留但改为从同一数据源构建（现状已是同一 spawns 快照，app.ts:150-156 —— 说明无需再渲染两遍，标定侧仅在激活标定时才需下拉，折叠后自然减负）。

### C14 量测页两分区 + 长文案 checkbox
- 证据：measure.ts:36-65 —— 「坐标拾取」+「参考显示」两区；拾取开关 label 是整句长文案（38-43）；tip 是换算教学（62-65）。
- 判定：**改**——工具单区 + 模式切换按钮化（S6）；教学提示并入帮助（S8）。

### C15 载入入口矩阵 4+ 处无状态引导
- 证据：地图：引导按钮（index.html:36）/顶栏按钮（58-59）/拖拽（app.ts:348-372）——引导层盖住顶栏时用户只见其一，引导层消失后「更换地图」入口只剩顶栏 + 拖拽（无面板内入口）；录像：面板按钮/拖拽/示例/深链 4 处（panel.ts:151-158、app.ts:364-367、app.ts:415-457）。
- 判定：**改**——按状态收敛可见入口（S2）：地图加载后，「地图」面板顶部出现「更换地图」按钮，顶栏瘦身；拖拽、深链、示例原样保留。

### C16 引导层内容与状态脱节 + 文案不一致
- 证据：index.html:27 说拖 `.bsp`，dropzone 文案说 `.bsp` 或 `.json`（index.html:42）；引导卡不教拖 JSON；加载失败后引导层再次整屏出现（app.ts:308-310）会打断已有场景浏览（虽然无模型时才这样）。轻微。
- 判定：**改**——文案对齐 + 引导卡收敛（S8）。

### C17 标定流程操作步数长、无状态串联
- 证据：calibpanel.ts 一次完整标定 = 填帧号→取原始坐标→（选出生点/飞过去/手填）→添加→重复 2-5 次→求解→读残差→应用，全部控件同时可见（55-160），无「当前攒了几组、还差几组」的过程提示（只有列表）。
- 判定：**改**——分组折叠 + 过程态摘要（S3/S4 附项）；**不砍**任何一步与提示。

### C18 视觉密度/一致性（样式层）
- 证据：styles.css 类族 50+（.btn/.btn.small/.btn.primary/.iconbtn/.filebtn/.track-btn/.tab…），圆角/背景/边框多套近似值手写重复（如 6-12px 圆角、4-5 种 hover 亮色），面板背景统一 `--panel` 但分隔/激活色不统一（.tab.active 蓝 vs .track-btn.active 金 vs .btn.primary 反白）。
- 判定：**改**——收敛到 3 个语义色阶（主操作/状态/危险）+ 统一控件基类（S10 样式收敛），纯 CSS/TS 常量整理，不改任何功能与 DOM 语义。

---

## 4. 简化方案（S1–S10，逐项给出判定与落地要点）

> 总原则：**阶段化渐进披露**（无地图→浏览→录像工作流逐步展开）、**单一事实来源**（每类信息只在一个表面出现）、**行内密度让位于层级**。所有「删」仅限静态文案与重复代码；所有交互能力只「移」不「删」。

### S1 HUD 收敛为「状态胶囊 + 可展开帮助」【改】
- 动作：
  1. 常态只留 3 行角色行：`#pose`（位姿读数，等宽小字）、`#bspStatus`（地图状态）、`#replayStatus`（录像提醒）；删除常驻标题行与两条静态 hint（index.html:45-51）。
  2. 地图名/文件名为 HUD 首行标题（载图成功后 `file.name` 上提，替代产品名标题——产品名进浏览器 title 即可）。
  3. 键位/位姿通道/换算教学合并进「帮助 ?」浮层（内容 = 现引导卡 + hint + README 快捷键表摘录）；帮助浮层可从 HUD 或顶栏打开，非模态、Esc 关闭。
  4. 抽单函数刷新位姿行（修 C3/C4：app.ts 与 core/pose.ts 的 bspYawToCsYaw 合一、frame/updateHudNow 格式化合一）。
- 保留：`#hud`、`#pose`、`#bspStatus`、`#replayStatus` id 与「非交互、不挡点击」特性（styles.css:27-29 pointer-events:none）；`flashStatus` 语义（只用于提醒行）。
- 风险：极低。无自动化读 HUD 文本（smoke 只查 `#fatal` 与无 console error）。

### S2 载入入口按状态收敛【改】
- 动作：
  1. 顶栏从 2 控件 → 1 控件（仅「面板」折叠钮，样式更小）；「加载 BSP 地图」从顶栏移除。
  2. 地图面板顶部加「更换地图」文件行（语义：已有图时换图）；引导层按钮 = 无图时唯一大按钮；拖拽 = 全局常备。最终可见入口：无图时 [引导按钮 + 拖拽]；有图时 [地图页「更换地图」+ 拖拽]，任意时刻主入口 ≤ 2 且按状态唯一。
  3. 引导卡第三步文案同步（右栏 = 地图信息/出生点/量测/录像，拖拽说明补 `.json`）。
- 保留：`#bspFile` change 链路、`setLoadBusy` 对两个按钮的 busy 态（引导按钮保留）、拖拽/深链/示例全部原样。
- 风险：低。smoke 不点顶栏载图（file 模式走 `#pane-replay input[type=file]`）。注意引导层 z-index 与顶栏的关系保持不变。

### S3 录像页三段式分组（最大单项收益）【改/合】
- 动作：12 个 `.sec` 重排进 3 个分组容器（各组用 `<details>` 式可折叠头，组标题用新文案，原 `.sec-title` 文本一字不改）：
  - **组 1「导入与播放」（默认展开）**：录像文件、轨迹列表、起点对齐 —— 覆盖 F6/F7/F9 主流程。
  - **组 2「对齐与校正」（有轨道后默认展开，否则收起）**：朝向诊断、坐标系标定 —— 覆盖 F10/F9-2，用步骤序文案串联（先「起点对齐」→再「朝向诊断」→最后「标定」）；面板 note 减至 1-2 行，全文进 title/帮助。
  - **组 3「规则与映射」（默认收起；「高级规则」）**：坐标系预设、数据定位、位置、朝向、速度（可选）、时间、规则脚本 —— 覆盖 F11。坐标系预设 select 复制一份到组 1「导入」行尾（同源同值双向同步）以满足「Source/Shavit 录像先选预设再导入」的最短路径；组 3 保留原控件全集。
- 保留（契约硬约束）：
  - DOM **构造时全量渲染**，只折叠不惰性（§7-D-2 冒烟在导入前断言 8 个 `.sec-title`）；
  - 8 个被冒烟断言的标题文本（录像文件/轨迹列表/起点对齐/数据定位/坐标系标定/坐标系预设/朝向诊断/规则脚本（逃生舱））与按钮文本（载入示例录像/运行朝向诊断/一键修正朝向/取该帧原始坐标/添加对应点/求解/应用结果/应用脚本/从表单重新生成/导出规则/导入规则/全部显示/全部隐藏/偏移归零/清空全部）不改；
  - 「朝向诊断」「坐标系标定」两个 `.sec` 内部结构（控件顺序、`.calib-row`/`.calib-result`、number input 顺序语义）默认展开态可见（冒烟要真点）。
- 风险：中（结构性改动）。落地点：组容器只包一层 div+折叠头，不搬移 `.sec` 之外的 DOM 关系；折叠头点击不拦截组内控件事件；展开状态持久化可进 localStorage（可选，不承诺）。
- 收益：导入前的视觉负载从 12 分区 → 3 分区；高级规则（表单/脚本/数据定位）不再参与日常路径。

### S4 轨迹列表状态化 + 两行式轨道卡【改】
- 动作：
  1. 空状态：隐藏 4 个批量按钮（或整体换成一行「空态引导」），有轨道才显示「全部显示/全部隐藏/偏移归零/清空全部」。
  2. 轨道卡两行：行 1 = 色点 + 名称（可改名）+ 帧数/时长 meta（meta 缩为 `12,345 帧 · 92.1 s`）；行 2 = ◉/◌ + 偏移（label+number+s）+ ◎ + ×（控件、顺序、class 不变）。
  3. 多轨时在列表头显示「N 条 · 主时钟 T s」摘要（现 summaryEl 已有，样式化即可）。
- 保留：`.track-row/.track-dot/.track-name/.track-meta/.track-off/.track-btn/.track-btn.danger` class、行内按钮顺序 [显隐, 跟随, 移除]、`track-<n>` id 语义（§7-D-2 冒烟按 index 取控件）。
- 风险：中——行结构两行化后，冒烟 [8]/[10] 用 `.track-row` 内的 `.track-off` 输入与 `.track-btn` index 取控件，顺序与 class 不变即通过；若实现时改顺序必须同步 smoke（允许，但不得弱化断言）。

### S5 时间轴分组重排（保持全部能力与键位）【改】
- 动作：
  1. row1（主控制）：播放/停止、◀帧/帧▶、时间读数、进度条、倍速（倍速从 row2 上提，紧贴播放键）。
  2. row2（设置）：「视角」select（原样）｜「循环」「轨迹线」「幽灵」三个紧凑 toggle｜A/B/整段改为紧凑按钮（文字保留，缩小留白）｜区间读数｜速度读数（等宽、右对齐）。
  3. 速度读数在无速度数据时只显示「速度 —」（详细原因文案移入 title 提示），有数据保持 `速度 N（水平 M，垂直 K）HU/s` 格式。
  4. 移除「倍速」文字 label 与冗余分隔符（timeline.ts:68、79、91、103 的 `.tl-sep`/文字 label 减少，语义不删）。
- 保留：`.tl-time` 读数格式（`X.XX / Y.YY s`，smoke 比较推进）、`.tl-slider`（0-1000 + input 事件）、`.tl-range`（「整段」vs 区间文本、active 类）、播放/暂停按钮文本、快捷键 K/,/./I/O、`#timeline.hidden`/`.full` 切换（app.ts:50-58、styles.css:223）。
- 风险：低-中。smoke 逐条命中按钮文本与 `.tl-*` 类，文案不变即可。

### S6 量测页单区化【改/合】
- 动作：两分区（坐标拾取/参考显示）合为一个「量测与参考」区，内部按 sec-sub 分节；拾取开关改为 `aria-pressed` 模式按钮「开始拾取/结束拾取」（原 checkbox 语义保留在按钮态上）；A/B/距离读数行保留；「清空/交换」保留；网格/坐标轴两个 toggle 保留但文案缩短；HU 换算 tip 移入帮助浮层（S8）或 title。
- 保留：MeasureTool 全部方法/场景对象/点击拾取逻辑（measure.ts:125-154），`fly.allowPointerLock` 联动（app.ts:103-108），`.kv` 读数。
- 风险：低（smoke 不碰量测页）。

### S7 地图页信息分层【改】
- 动作：
  1. 「地图信息」默认行：文件（名）、出生点数、世界尺寸、GLB 体积（如 meta 可给）；magic/brushes/faces/models/vertices/static props/PAKFILE/解析耗时/包围盒 min/max 收进「统计明细」折叠（`<details>`），冒烟不查这些行。
  2. 顶部加「更换地图」文件行（S2）。
  3. 出生点条目单行化：`★ #n classname`（title 显示 xyz/yaw 全量）+「跳转」按钮；仍保留 primary 高亮。
- 保留：`kv`/`.spawn-*` class、MapPanel API（setMap/spawnPoints）、出生点快照格式（录像标定依赖，mapinfo.ts:46-48 + app.ts:150-156）。
- 风险：低。

### S8 帮助系统收敛（引导卡 + HUD hint + tip 的唯一权威化）【合/改】
- 动作：
  1. 维护单一 HELP 常量（键位表、位姿三通道、载入入口、HU 换算、A-B/快捷键）供引导卡与「?」浮层共用渲染；引导卡只剩 3 步短句 + 大按钮。
  2. HUD 两条静态 hint 与 measure tip、calib/orient 面板长 note 中的「教学段」文本收敛进 HELP 常量/对应 title；面板 note 只留结果与操作指向。
  3. index.html:27 与 :42 文案统一（拖拽支持 .bsp/.json）。
- 保留：引导层出现时机语义（无图/失败回显，app.ts:304-313、hud.ts:52-71）、`#guide`/`#guideError`/`.raw` 结构（错误原文小字折叠是既有好设计）。
- 风险：低。

### S9 状态行角色化 + 告警去重【改】
- 动作：
  1. 职责划分：`#bspStatus` = 地图域（解析进度、成功摘要、BSP 失败、换图失败）；`#replayStatus` = 录像域跨面提醒（轨道整体落地图外——用户可能不在录像页）；位姿 = `#pose` 只读读数；临时工具消息走 flash（不覆盖常驻状态文本——flashStatus 现会顶掉地图状态再还原，保留其语义但只用于提醒行）。
  2. 「起点离最近出生点远」的**细节**只保留在录像页「起点对齐」note（panel.ts:710-723 已承载：距离+Δ+动作指引）；HUD `#replayStatus` 不再重复同因告警（app.ts:208-216 的 START_ANCHOR_WARN 分支移出）；「轨道 bbox 落地图外」仍走 HUD（跨面）。
  3. 阈值统一：面板「已贴合 ≤128」「需处理 >1024」两档与 HUD 保留档位说明写进 HELP，消除 C6 的 128/1024 双阈值困惑（行为阈值可保持不变，只统一文案口径与归属面）。
- 保留：`hud.flashStatus/setStatus/setReplayStatus` API、`updateReplayMapStatus` 的 bbox 检查、computeStartAid 供面板与标定使用。
- 风险：低。

### S10 样式收敛（纯视觉，零功能影响）【改】
- 动作：
  1. 控件基类归一：把 .filebtn/.iconbtn/.btn/.tab/.track-btn/.spawn-item button 的 hover/active/disabled 态统一进 2-3 组 CSS 变量（--accent/--gold/--danger 语义化保留）。
  2. 统一圆角/边框/背景的重复书写为变量；侧栏宽度 348 → 允许 320-360 自适应区间（媒体查询窄窗收窄），顶栏/HUD 间距对齐 14px 网格。
  3. 折叠头（S3/S4/S7 的 `<details>`）用统一样式与「▸/▾」指示。
- 保留：所有 class 名与 DOM 结构（只改声明不改引用）；`.hidden`、`.active`、`.busy` 等行为类语义。
- 风险：低。改完后跑冒烟确认无 console error + 截图人工复核（§8）。

---

## 5. 外部契约（必须保持，逐项列出回归方法）

> 简化不得触碰下列任何一项的行为；只允许改其「宿主布局/文案长度」，改任何类名/结构/顺序时须在同一提交内同步 test/smoke-cdp.mjs 且**不得弱化断言**。

### A. 运行时外部接口（用户/脚本/自动化直连）

| # | 契约 | 现状落点 | 简化允许 | 回归方法 |
|---|---|---|---|---|
| A1 | URL query `?pos=x,y,z&ang=yaw,pitch` 加载即应用 | app.ts:408-412、core/pose.ts:28-41 | 无 | 手工 URL 冒烟 + smoke |
| A2 | URL hash `#pos=…&ang=…`，hashchange 实时应用 | app.ts:400-406 | 无 | 手工改 hash 验证 |
| A3 | `window.viewer.setPose/getPose`（数组与对象形式） | app.ts:375-383、core/pose.ts:17-25 | 无 | 浏览器 evaluate |
| A4 | `window.viewer.replay` 只读内省字段全集 | app.ts:385-397 | 无 | smoke 全程断言 |
| A5 | `window.viewer.replay.orientation` 诊断结果钩子（含 verdict/applied） | panel.ts:124-127、785-787 | 无 | smoke [3b] |
| A6 | 第一人称回放期间忽略位姿三通道；载入录像默认 `mode='first'` | app.ts:254-256、473-491、133 | 无 | smoke（mode 断言） |
| A7 | 拖拽 `.bsp`=载图、`.json`=导入录像并自动切录像页；非两类文件报错 | app.ts:348-372 | 无 | 手工 + smoke 同链路 |
| A8 | URL 深链 `?bsp=&replay=&rule=`（相对页面解析，rule 套用后导入） | app.ts:415-457 | 无 | smoke 深链模式 |
| A9 | localStorage 规则键 `websurf-viewer.replay-rule.v1`、schema v1（version+scriptSrc） | panel.ts:42、481-500 | 无 | smoke file:// 预置注入 |
| A10 | 位姿语义：脚底/Y-up/yaw 约定/pitch ±89°/眼高 64.09 | README.md:307-314、constants.ts:7 | 无 | test:replay 间接 + 手工 |
| A11 | 轨道 id `track-<n>` 序列与 followId 回退语义 | tracks.ts:23-42、56-79 | 无 | smoke [8][10] |
| A12 | 快捷键：K 播放、`,`/`.` 帧步、`I`/`O` A-B、WASD/空格/C/Shift/Esc、输入框内失效 | timeline.ts:157-177、fly.ts:90-105 | 无（只许更新帮助文档） | 手工键盘验证 |
| A13 | 播放行为：主时钟/循环/A-B/逐帧/停终点/速度读数（无速度显示「速度 —」系） | player.ts、tracks.ts:85-99 | 读数格式不得破坏 smoke 正则 | test:replay + smoke [4] |
| A14 | 规则持久化/导入导出文件 schema | panel.ts:502-538 | 无 | 手工往返 |
| A15 | `reset`/Worker 协议与主线程回退 | importer.ts、parse-worker.ts | 无 | test:replay + smoke 大文件模式 |
| A16 | 示例录像 `sample-spiral.json` 生成链路与「载入示例录像」按钮 | sample.ts、panel.ts:151-158 | 按钮文本不许改 | smoke [3][8] |

### B. 页面元素与自动化钩子（smoke 直接依赖的 DOM 面）

| # | 钩子 | 说明 |
|---|---|---|
| B1 | `.tab[data-tab="replay"]` 点击切页；`#pane-replay.active` | 切页结构不许改（index.html:65-72） |
| B2 | 分区标题文本 8 个：录像文件/轨迹列表/起点对齐/数据定位/坐标系标定/坐标系预设/朝向诊断/规则脚本（逃生舱） | 折叠可以、**标题字符串与构造时全量渲染**必须保持（smoke [2] 先于导入断言） |
| B3 | `#pane-replay input[type=file]` | file:// 模式 setFileInput 用它 |
| B4 | `.track-row`（计数）/`.track-meta`（正则 帧数）/`.track-dot`（配色差异）/`.track-off`（offset 输入）/`.track-btn` 顺序 [显隐,跟随,移除]（index 取控件）/`.track-btn.danger` | S4 两行化必须保持 class 与按钮顺序 |
| B5 | `.tl-time`（`X.XX / Y.YY s` 且播放推进时文本变化）/`.tl-slider`（value+input 事件）/`.tl-range`（「整段」切换）/时间轴按钮文本 播放/暂停/A 起点 | S5 不许改文本与事件语义 |
| B6 | `.calib-row`（计数 2 组）/`.calib-result`（显示与「最大残差」文本）/标定分区内 number input 顺序语义（首个=帧号、末三个=世界 X/Y/Z）/按钮 取该帧原始坐标/添加对应点/求解/应用结果 | S3 折叠时**朝向诊断与坐标系标定分区默认展开**，内部结构不动 |
| B7 | `#timeline.hidden` 有无轨道切换；`#timeline.full` 侧栏折叠拉通 | app.ts:50-58、styles.css:223 |
| B8 | `#fatal.show`（启动兜底）；WebGL 可用性路径 | 不许动 index.html:15-20、79-96 |
| B9 | `window.viewer.replay` 各字段 + `mode`/`followId` 文本断言 | 见 A4/A11 |

### C. 构建 / 分发 / 文档契约

| # | 契约 | 落点 | 注意 |
|---|---|---|---|
| C1 | `npm run typecheck`、`build:ts`（app.js + parse-worker.js 产物） | package.json:9-14 | 简化必须保持零 TS 错误 |
| C2 | `npm run test:replay` Node 自检（模块纯函数不依赖 DOM） | test/replay-selftest.ts | UI 简化不得改 replay 纯逻辑模块行为 |
| C3 | `npm run test:smoke` CDP 冒烟（HTTP 深链 + file:// 两模式） | test/smoke-cdp.mjs | 见 B 表；改选择器须同步且不弱化 |
| C4 | `npm run build:dist`：单一 dist、IIFE、内嵌 `__VBSP_WASM_B64__`/`__VBSP_WORKER_JS__`、classic `<script src="./app.js">`、无 parse-worker.js/wasm 于 dist 根、play.cmd/sh 内容断言 | scripts/build-dist.mjs:178-227、smoke [0]:121-143 | index.html 的 script 标签文本若改，build-dist.mjs:212-215 的 replace 目标同步；play 脚本与 serve.py 复制逻辑不动 |
| C5 | `file://` 双击可用（WASM/Worker 内嵌路径） | bsp.ts:41-68、importer.ts:55-95 | 只许改面板布局，不许动加载分支 |
| C6 | README.md / docs/overview.md / dist/README.md 与行为一致 | — | 由集成任务（t5）统一同步；本专项的 UI 变更描述进 README「操作」节 |

### D. 语言/文案约定
- 全部 UI 中文文案风格「按钮=动词短语、note=结果+原因+动作」；简化文案仍遵循。
- `#guide` 首访文案、「帮助 ?」内容、README 快捷键表三方同源（S8）。

---

## 6. 明确不做的事（Out of Scope / 红线）

1. **不砍任何功能**：出生点跳转、量测、网格/坐标轴、位姿三通道、录像三导入+深链、探测、预设、位置/朝向/速度/时间全字段、脚本逃生舱与 customized 语义、起点锚定、坐标系标定（含全部告警提示）、朝向诊断与一键修正、多轨迹（显隐/偏移/跟随/重命名/移除/清空/全显全隐）、播放（倍速/循环/A-B/逐帧/停终点/速度读数）、轨道配色、规则导入导出与 localStorage 持久化——每一项都必须仍可达。判断基准：**任意现有 README 描述的能力，简化后 README 不改描述也能复现**。
2. **不动 WASM/Rust 层**：`crates/wasm/*`、`pkg/*`、wasm.d.ts、`src/core/bsp.ts` 的 WASM 调用协议；`npm run build:wasm` 不重跑（除非集成验证需要）。
3. **不改数据契约**：RuleConfig v1 字段名/含义、localStorage schema、Clip 定型数组、Worker 消息协议、位姿/角度/眼高语义、Track 结构。
4. **不做框架化/大重写**：不引入 React/Vue/构建链变化；不拆 esbuild；不重构 three 场景层与回放管线（scene/player/visuals/sampling 等纯逻辑文件仅在必要处做最小接触，理想为零改动）。
5. **不做新功能**：不加向导、不加主题切换、不加深链新参数、不加新的持久化状态（折叠记忆为可选加分项，非承诺）。
6. **不在需求阶段改代码**：本文档只做分析；实现范围以本文 §4 方案为基线，由实现任务按 S1-S10 落地。
7. **不允许的回归**：冒烟断言弱化、隐藏/删除 smoke 依赖的任何钩子（只许同提交同步且等价或更强）、console error、深链/拖拽/file:// 失效、大文件（≥10 万帧）导入路径回归。

---

## 7. 分阶段落地与改动面估算

| 阶段 | 改动文件 | 说明 |
|---|---|---|
| S1/S8/S9 | index.html、styles.css、src/ui/hud.ts、src/app.ts | HUD 收敛 + 帮助浮层 + 状态行去重；app.ts 小改 |
| S2 | index.html、styles.css、src/ui/mapinfo.ts（+“更换地图”行） | 顶栏瘦身、入口矩阵收敛 |
| S3 | src/replay/panel.ts（结构重组）、styles.css | 三分组折叠；**最多风险点**（构造时全量渲染 + 标题/按钮文本不动 + 朝向诊断/标定默认展开） |
| S4 | src/replay/trackpanel.ts、styles.css | 空态批量按钮隐藏 + 两行轨道卡 |
| S5 | src/replay/timeline.ts、styles.css | 时间轴分组重排（文本与事件语义不变） |
| S6/S7/S10 | src/ui/measure.ts、src/ui/mapinfo.ts、styles.css | 量测单区、地图信息分层、样式变量收敛 |
| 回归 | — | typecheck → test:replay → build:ts → build:dist → test:smoke（HTTP 深链 + file:// 两模式）→ dev_page_check 截图人工复核（§8 状态矩阵）→ README/overview 同步（t5） |

估算：纯 UI/样式代码约 1200 行内移动/改写；core/replay 纯逻辑文件零改动或近零（S3 只动 panel.ts 布局，不碰 importer/player/calib/orientation/codegen）。

---

## 8. 验收对照表（需求基线 ↔ 验证方法）

| # | 验收准则（来自团队目标与本文档） | 验证方法 | 通过标准 |
|---|---|---|---|
| AC1 | 功能需求被完整梳理（BSP 预览/出生点跳转/量测/位姿三通道/录像导入-规则-回放/标定/朝向诊断） | 本文档 §1 F1-F12 | 每条流程有代码落点，实现后可逐条复现 |
| AC2 | 复杂度逐项有证据 | 本文档 §3 C1-C18 | 证据均为「文件:行号」，实现任务逐项消解 |
| AC3 | 简化方案有删/合/改/保留判定 | 本文档 §4 S1-S10 | 实现提交逐项对应 |
| AC4 | 外部契约不丢失 | §5 A/B/C 表 | smoke 全绿 + 手工钩子清单逐条通过 |
| AC5 | 类型检查/构建不回归 | `npm run typecheck`；`npm run build:ts`；`npm run build:dist` | 0 错误；dist 静态断言（smoke [0]）通过 |
| AC6 | 录像自检不回归 | `npm run test:replay` | 全绿（现 60+ 断言） |
| AC7 | 浏览器冒烟不回归（含深链 + file://） | `npm run test:smoke`（本机 Edge） | 全绿、无 console error；选择器改动须等价同步 |
| AC8 | 视觉/信息层级简化经人工复核 | dev_page_check 截图 + 人工复核 | 状态矩阵（见下）每态 1 张：① 无地图首访（引导卡收敛、HUD 薄）② 载图后（HUD 3 行、地图页分层）③ 录像导入后（录像页三段、时间轴分组、默认第一人称）④ 高级规则展开态（全部控件可达）⑤ 量测页单区 |
| AC9 | 帮助内容收敛且可达 | 手工 | 「?」浮层含键位/位姿通道/HU 换算；引导卡 3 步短句 |
| AC10 | 文档同步 | README/overview/dist-README | t5 集成任务按最终 UI 更新操作说明 |
| AC11 | 独立审查 | t4 评审对照本基线 | reviewer 判定简化未丢能力/契约 |

---

## 附：既有良好设计（简化时不得顺手破坏）

- 错误提示带「人话 + 原始信息小字折叠」（hud.ts:61-67、styles.css:260-267）。
- 改规则 = 替换当前轨道、换文件 = 追加（README.md:94、panel.ts:87-93）——防止刷屏的核心设计。
- 解析全在 Worker + 主线程回退 + 大文件自动重导提示（build.ts:23-26、importer.ts）。
- 「表单生成脚本、手改后表单让权」的 single-authority 设计（panel.ts:443-449、codegen.ts 头注释）。
- 轨线抽稀、进度节流、frustum pad、分块合并等性能项（visuals.ts:10、build.ts:45、scene.ts:18）。
- 量测拾取期间让出指针锁定、回放期间键盘不挪飞行位置（fly.ts:39-41、app.ts:473-491）。
