# progress/ 导航（过程记录）

> **性质**：**过程记录，不作事实来源**（事实以当前代码为准，状态只在 `TODO.md`）。本页只回答「哪个文件管什么、什么时候去看它」。
> **体积纪律**：过程记录单文件 ≤ 48 KB，超限按时间/主题切卷，卷必须登记在本页（体检 `[I]` 硬查覆盖）。

| 文件 | 一句话 | 什么时候看 |
|---|---|---|
| `monthly/2026-09-1.md` | 2026-09 第 1/2 卷：重编期 WG 收尾（2026-09-22 ~ 09-29，19 条） | 追某次改动当时怎么做的 |
| `monthly/2026-09-2.md` | 2026-09 第 2/2 卷：UI 轮次 / 主题 / 事故补救（2026-09-23 ~ 09-30，19 条） | 追某次改动当时怎么做的 |
| `monthly/2026-10-1.md` | 2026-10 第 1/5 卷：物理 bevel / chamfer 那批（2026-10-04 ~ 10-07，13 条） | 追某次改动当时怎么做的 |
| `monthly/2026-10-2.md` | 2026-10 第 2/5 卷：渲染层下沉 Phase 1–3d（2026-10-02 ~ 10-03，13 条） | 追某次改动当时怎么做的 |
| `monthly/2026-10-3.md` | 2026-10 第 3/5 卷：viewer 影带 / 时间轴 / 主题（2026-10-02，13 条） | 同上 |
| `monthly/2026-10-4.md` | 2026-10 第 4/5 卷：10-01 收尾 ～ 本轮文档整理（2026-10-01 ~ 10-07，14 条） | （已封卷） |
| `monthly/2026-10-5.md` | 2026-10 第 5/7 卷：10-07 `.cmd` 入口对齐轮（2026-10-07 起） | 追某次改动当时怎么做的 |
| `monthly/2026-10-6.md` | 2026-10 第 6/7 卷：置换面碰撞 / 三角形面集 / 卡脚与穿透修复（2026-10-08） | 同上 |
| `monthly/2026-10-7.md` | 2026-10 第 7/8 卷：ramp 坡碰撞（碰撞只看 contents） | 追某次改动当时怎么做的 |
| `monthly/2026-10-8.md` | 2026-10 第 8/9 卷：T-311 写入失败信号 / D-024 死代码口径（2026-10-09 起） | （2026-10-09 起由第 9 卷接续） |
| `monthly/2026-10-9.md` | 2026-10 第 9/9 卷：CDP 视觉验证 / 遗留路线清查续（2026-10-09 起） | **新一轮进展写在这里**（当月最后一卷） |
| `board/archive-2026-10.md` | 看板分卷：已记录 + 已结案（93 条） | 查某条历史项的 ID / 状态 |
| `board/archive-2026-10-2.md` | 第 2 卷：2026-10-09 分卷移出的 90 条已结案行 | 追溯用 |
| `board/archive-2026-10-3.md` | 第 3 卷：同上（后半） | 追溯用 |
| `decisions.md` | 待裁决分批清单（133 条按 5 组，带建议答法） | owner 要批量裁决时 |
| `pending-detail.md` | 原 AGENTS §7.3 台账逐条原文 | 看板某行的「详情」列指过来时 |
| `wg-status.md` | 工作组（WG1–WG12）状态与历史计划 | 追重编期分工 |
| `board-migration.md` | 看板来由：为什么建、基线、C1–C8、S1–S7 | 质疑看板设计是否合原意时 |
| `open-issues/01-chamfer-is-not-a-bevel.md` | 取证：chamfer 不是 bevel | 追该结论的依据 |
| `open-issues/02-chamfer-visualization-guesswork.md` | 取证：chamfer 可视化曾靠猜 | 同上 |
| `open-issues/03-renderer-merge-normal-attribute.md` | 取证：合批因 normal 不一致失败 | 同上 |
| `open-issues/04-wasm-untextured-surface-color.md` | 取证：无纹理面上色 | 同上 |
| `open-issues/05-wasmcore-bevel-doc-vs-code.md` | 取证：wasm-core bevel 文档 vs 代码 | 同上 |
| `open-issues/06-phy-hull-facet-jump.md` | 取证：.phy 凸包表达不了曲面坡 | 同上 |
| `open-issues/07-is-position-free-vs-trace.md` | 取证：is_position_free vs trace（卡死修法） | 同上 |
| `lessons-2026-10-08.md` | **本会话（约 66 轮）的经验教训整理**：方法论 / 查实的技术事实 / 仓库流程纪律 / 环境陷阱 / 事故 | 开工前或交接时先读 |

## 卷序（月度进展）

> **当前写入目标**：`progress/monthly/2026-10-9.md`（当月最后一卷；超过 **40 KB** 就先开新卷、硬上限 **48 KB** 见 §0.4；新卷要补「上/下卷链接 + 登记本页 + 索引各一行」）。
> **按日期找哪一卷**：以各行右列的**覆盖范围**为准；注意**新条目一律追加在当月最后一卷**，所以相邻卷的范围可能重叠——精确查找直接用 `grep -n "2026-10-05" progress/monthly/*.md`。

`2026-10` 按月切了 6 卷（每卷 ≤ 48 KB，按时间顺序）：`2026-10-1` → `2026-10-2` → `2026-10-3` → `2026-10-4` → `2026-10-5` → `2026-10-6`。每卷头部有「上一卷 / 下一卷」链接；右列「什么时候看」写着用途。新进展追加到**当月最后一卷**（本页右列会随之更新）。

## 进展索引（全量，133 条）

> 由 `AGENTS.md §7.1` 分卷而来（入口文件 ≤ 32 KB）。**新增进展**追加到 `progress/monthly/` 的「当前写入目标」那一卷，然后在**本节**补一行（`AGENTS §7.1` 已于 2026-10-07 冻结，不再追加）。

| 日期 | 摘要 | 明细 |
|---|---|---|
| 2026-10-07 | owner 三问处置：物理通用性（答复）＋ debug 出生点「铁丝网」材质缺失修复 ＋… | progress/monthly/2026-10-1.md:10 |
| 2026-10-07 | `.phy` 凸体补面接通物理（E′：VBSP `AddBrushBevels` 复刻 … | progress/monthly/2026-10-1.md:11 |
| 2026-10-07 | bevel 第五路三缺陷修复（owner 复核 6dc3bb9 后报三问题，全部实测定位… | progress/monthly/2026-10-1.md:12 |
| 2026-10-07 | owner 复核第五路线框报两问题，均已修（`24549e2` 之后追加提交）。① 触发… | progress/monthly/2026-10-1.md:13 |
| 2026-10-07 | debug 新增第五路线框：BSP 原生 bevel 辅助碰撞面（白，独立开关）。原理考… | progress/monthly/2026-10-1.md:14 |
| 2026-10-07 | P1 落地：运行时 chamfer 整段撤除，碰撞平面表回到「真实面 + BSP 原生 … | progress/monthly/2026-10-1.md:15 |
| 2026-10-07 | 路线 A 落地：撞面推开改为「只在起点已嵌入时执行」—— 高刷屏下贴墙不再被推着走（ow… | progress/monthly/2026-10-1.md:16 |
| 2026-10-07 | 「debug 预测定步 + 渲染插值」整条线（`68431a4` + `c32d03f`… | progress/monthly/2026-10-1.md:17 |
| 2026-10-05 | surf_666 尖脊坡全链路：弹飞已修、卡死已修（B/E 实测否掉、走修法 A）、`s… | progress/monthly/2026-10-1.md:18 |
| 2026-10-05 | surf_666 尖脊「弹飞」与「卡死」两条缺陷：定位、修复弹飞、卡死登记待裁决（own… | progress/monthly/2026-10-1.md:19 |
| 2026-10-04 | 渲染收敛第二轮（owner 指令「合并过于保守」）：viewer 缺材质根因修复 + d… | progress/monthly/2026-10-1.md:20 |
| 2026-10-04 | 渲染层下沉 Phase 5：终验与部署。f3b9da3 推送后三道 CI 门全绿（Doc… | progress/monthly/2026-10-1.md:21 |
| 2026-10-04 | 渲染层下沉 Phase 4：推广与收尾（game↔debug/viewer 渲染逻辑逐项… | progress/monthly/2026-10-1.md:22 |
| 2026-10-03 | 3d 文档同步补完（`Doc Drift Check` 门修复）。触发：`e992f04… | progress/monthly/2026-10-2.md:11 |
| 2026-10-03 | 渲染层下沉 Phase 3d：debug 对齐共享层（任务书 3d，debug 行为零变… | progress/monthly/2026-10-2.md:12 |
| 2026-10-03 | 渲染层下沉 Phase 3c：viewer 对齐共享层 + 光照纪律统一（owner 裁… | progress/monthly/2026-10-2.md:13 |
| 2026-10-03 | 渲染层下沉 Phase 3b：四模块落进 `src/renderer-shared/{s… | progress/monthly/2026-10-2.md:14 |
| 2026-10-02 | 渲染层下沉 Phase 3a：game 的 renderer-main.ts 拆分（零行… | progress/monthly/2026-10-2.md:15 |
| 2026-10-02 | 渲染层下沉 Phase 2：fog-manager + light-manager → … | progress/monthly/2026-10-2.md:16 |
| 2026-10-02 | 渲染层下沉 Phase 1（owner 任务书 `.tmp/WebSurf 渲染层下沉重… | progress/monthly/2026-10-2.md:17 |
| 2026-10-02 | 第 3 轮：判据可追责 + 兜底读数 + 过关写法泛化（新 dem 仍未到位）。owne… | progress/monthly/2026-10-2.md:18 |
| 2026-10-02 | 补记（消息过滤 + 过关跳转的文档收尾）：`dem.md` 补 `chatkind.ts… | progress/monthly/2026-10-2.md:19 |
| 2026-10-02 | owner 新需求：消息加过滤（四类多选框）+ 过关记录可点击跳到那一跑。① 先按 ow… | progress/monthly/2026-10-2.md:20 |
| 2026-10-02 | 补记上一条的作业过程（文档锚点校订）：子代理中途挂了，剩下的一律由我自己收尾。上一条写的… | progress/monthly/2026-10-2.md:21 |
| 2026-10-02 | owner：重新设计录像面板的「载入与看板」+ 撤掉「运动优先（实验展平顺序）」，并明确… | progress/monthly/2026-10-2.md:22 |
| 2026-10-02 | owner：「任由其加载后自动播放，replay 或 dem 都会莫名其妙自己暂停；进度… | progress/monthly/2026-10-2.md:23 |
| 2026-10-02 | tick 点开关「像装饰品」的修复 + 两条影带高度定死 106px + 相关文档同步。… | progress/monthly/2026-10-3.md:11 |
| 2026-10-02 | 再更正（影带间距，第二次被否）——我「对齐」错了方向：owner 要的是「小小的间隔」，… | progress/monthly/2026-10-3.md:12 |
| 2026-10-02 | 更正上一条（影带间距）——我把「改一条」做成了「改两条」，owner 当场否掉。owne… | progress/monthly/2026-10-3.md:13 |
| 2026-10-02 | owner 反馈：录像影带（timelineDemo）的内部上下间隔比记录影带（time… | progress/monthly/2026-10-3.md:14 |
| 2026-10-02 | owner 报的两个视角缺陷（同一处行为的两个反面）：「自动跳转后视角还绑在第一段 / … | progress/monthly/2026-10-3.md:15 |
| 2026-10-02 | 对话跟进时间轴（两版：owner 否掉第一版，第二版落地）。第一版（已撤销）：按播放头把… | progress/monthly/2026-10-3.md:16 |
| 2026-10-02 | owner 复核上一轮后报的两个 bug：① 点 `LuoXuan` 会越过第一段、直接… | progress/monthly/2026-10-3.md:17 |
| 2026-10-02 | 上一条的追加裁决（owner）：「如果之前就一直在观察这个人，并且他之后会回来的话，就跳… | progress/monthly/2026-10-3.md:18 |
| 2026-10-02 | owner 报缺陷：「进过一次服、退出、又进来」的真人被显示成一段连贯在场，进度条上看不… | progress/monthly/2026-10-3.md:19 |
| 2026-10-02 | owner：`.dem` 特有一些信息没进展示面，底部那条信息条太空 ⇒ 新增「录像信息… | progress/monthly/2026-10-3.md:20 |
| 2026-10-02 | owner 复核后两处返工：撤掉滑杆阵亡标记层 + 花名册按身份去重（上一条的更正与追加… | progress/monthly/2026-10-3.md:21 |
| 2026-10-02 | viewer 两条链路分离的收尾：文档锚点全量重锚 + 两处真实「串位」修复。① 文档重… | progress/monthly/2026-10-3.md:22 |
| 2026-10-02 | viewer 记录 / 录像两条链路彻底分离（owner 裁决「必须推倒设计更合理的切换… | progress/monthly/2026-10-3.md:23 |
| 2026-10-01 | 新增 `documents/viewer/replay-vs-dem.md`：`.rep… | progress/monthly/2026-10-4.md:11 |
| 2026-10-01 | `.dem` 进度条被「正式跑段」污染（owner 实测：点开 LuoXuan 后进度条… | progress/monthly/2026-10-4.md:12 |
| 2026-10-01 | `.dem`「没有位姿」清账（owner 报「为什么没有位姿？应该都在里面了」）。根因两… | progress/monthly/2026-10-4.md:13 |
| 2026-10-01 | viewer 录像页「花名册」看不到人（owner 报：`.dem` 解析结果里有真实玩… | progress/monthly/2026-10-4.md:14 |
| 2026-10-01 | viewer 导入入口收敛为「按内容分派」（owner 报缺陷：无法自动识别 `.rep… | progress/monthly/2026-10-4.md:15 |
| 2026-10-01 | viewer `.dem` 缺陷清账轮（owner 终裁「.dem 不做按键显示、宁缺勿… | progress/monthly/2026-10-4.md:16 |
| 2026-09-22 | WG1 `src/phys/` 7/7、WG2 `src/wasm-core/` 26/… | progress/monthly/2026-09-1.md:11 |
| 2026-09-22 | WG4 `apps/debug`：19 件经主控独立复验通过；复验中修掉 8 处失败（5… | progress/monthly/2026-09-1.md:12 |
| 2026-09-23 | 重编成果验收审查（主控自做）：六面体检全绿、无返工项——漂移越界 0 / 路径失效 0 … | progress/monthly/2026-09-1.md:13 |
| 2026-09-24 | 三工程 `.cmd` 入口统一为 `dev` / `build` / `start`（o… | progress/monthly/2026-09-1.md:14 |
| 2026-09-29 | 接手另一个 agent 的 game 界面「莱茵风格化」（owner 转交）：目标工程 … | progress/monthly/2026-09-1.md:15 |
| 2026-09-29 | game UI 莱茵精工 P1–P4 落地（owner 审查 plan 后指示「继续你的… | progress/monthly/2026-09-1.md:16 |
| 2026-09-29 | R1.3 关闭交互改版（owner 定稿）：① 导航页脚整条删除（含设备署名与关闭文字项… | progress/monthly/2026-09-1.md:17 |
| 2026-09-29 | game UI 第二轮返工立项（R1，owner 复核截图后）：P1–P4 已由另一执行… | progress/monthly/2026-09-1.md:18 |
| 2026-09-29 | R1 返工落地 + R1.1 修正（owner「审查后继续」+ 复核三处反馈）：R1 按… | progress/monthly/2026-09-1.md:19 |
| 2026-09-29 | R1.2 修正（owner 复核 R1.1 截图后两处反馈）：① 切角边线不可见——`#… | progress/monthly/2026-09-1.md:20 |
| 2026-09-27 | 清理不应入库的脚本（owner 提出「scripts 相关不该上传」）：以「被引用面」为… | progress/monthly/2026-09-1.md:21 |
| 2026-09-27 | 补漏第二轮（v5 面板绑定生效 + 人工复核 G）：v5 命中 11 个「回调无下发」的… | progress/monthly/2026-09-1.md:22 |
| 2026-09-26 | 审计补漏（v4：回向消息 / 公开方法零调用点 / 监听解绑配对 / 类选择器）：新增四… | progress/monthly/2026-09-1.md:23 |
| 2026-09-26 | P3 输入录制链路删链（owner 裁定 B）：删除用户录制器 `inputRecord… | progress/monthly/2026-09-1.md:24 |
| 2026-09-26 | 页面功能链路全量审计（脚本提取 + 逐条开箱）：三工程跑 A（DOM id 契约）/ B… | progress/monthly/2026-09-1.md:25 |
| 2026-09-28 | 风格化追加（owner：viewer 加导演板/媒体元素突出看录像、game 突出游戏感… | progress/monthly/2026-09-1.md:26 |
| 2026-09-28 | 三工程主题分化（owner：配色更精致、忌浮夸阴影、按名称各配主题、全量链路审查——原三… | progress/monthly/2026-09-1.md:27 |
| 2026-09-28 | debug 右上参数读数重做（owner：位置自拟、不用现位）：`#hud` 读数块从预… | progress/monthly/2026-09-1.md:28 |
| 2026-09-28 | debug 页面观感重做（owner 追加：debug 也做，修「不通」+ 美观）：`a… | progress/monthly/2026-09-1.md:29 |
| 2026-09-28 | 漂移体检 CI 失败修复（[B] 24 + [C] 5 归零）：#72–#76 删链后 … | progress/monthly/2026-09-2.md:11 |
| 2026-09-28 | game / viewer 页面观感重做（owner 要求：朴素、无花哨效果、不得参考现… | progress/monthly/2026-09-2.md:12 |
| 2026-09-23 | plan 目录退役（owner 裁决）：原 `documents/plan/` 三篇控制… | progress/monthly/2026-09-2.md:13 |
| 2026-09-29 | ui-style-plan 退役（owner 裁决）：风格计划系一次性工作件（P1–P4… | progress/monthly/2026-09-2.md:14 |
| 2026-09-30 | 事故与补救：ffaf715 误提交夹带另一 agent 的未提交工作（DEM 回放 20… | progress/monthly/2026-09-2.md:15 |
| 2026-09-30 | 远端入库面清理审查（owner：审查新推送、不该传的不传、`.gitignore` 收紧… | progress/monthly/2026-09-2.md:16 |
| 2026-09-30 | 部署站入口页重做（owner 三点：三行入口文字对齐 / ctrl+W 卡片碍事改固定弹… | progress/monthly/2026-09-2.md:17 |
| 2026-09-30 | README 时效性修订（owner：核对最新状况、注意可读性）：18 个 `文件:行号… | progress/monthly/2026-09-2.md:18 |
| 2026-09-30 | game 界面细节打磨（owner：基本样式差不多、细节不够好——滚动条/点缀元素/加载… | progress/monthly/2026-09-2.md:19 |
| 2026-09-30 | apps 整体控件自绘与滚动条统一（owner：滚动条影响面全 app 考虑；下拉框与 … | progress/monthly/2026-09-2.md:20 |
| 2026-09-30 | game 装饰螺丝撤除 + debug 面板 sharpen（owner：game 螺丝… | progress/monthly/2026-09-2.md:21 |
| 2026-09-30 | 部署入口页居中定稿 + viewer 命名体系更名（owner：入口三行要居中、文案更新… | progress/monthly/2026-09-2.md:22 |
| 2026-09-30 | debug 配色去科幻（owner：布局不错但配色太科幻）：「仪表」主题从「石墨青黑底 … | progress/monthly/2026-09-2.md:23 |
| 2026-09-30 | 三站关闭确认兜底（owner：Ctrl+W 直接关页太狠，记得有确认框机制——确认存在，… | progress/monthly/2026-09-2.md:24 |
| 2026-09-30 | viewer 三处布局 / 观感修复（owner：pane-map 右侧过宽 / tl-… | progress/monthly/2026-09-2.md:25 |
| 2026-09-30 | 三端 UI 独立审查 + 对话遗留合并（owner：找更多不协调 / 观感 / 体验问题… | progress/monthly/2026-09-2.md:26 |
| 2026-09-30 | viewer 时间轴滑杆 680px 上限 + 部署失败排查（owner：pane-ma… | progress/monthly/2026-09-2.md:27 |
| 2026-09-30 | viewer 录像 tab 四件（owner：对话加进录像 tab 且要合主题合逻辑 /… | progress/monthly/2026-09-2.md:28 |
| 2026-09-30 | 按键反推的根因链（留档：这一轮排掉了五个错误假设，最后落在采样口径上）：`keygues… | progress/monthly/2026-09-2.md:29 |
| 2026-10-06 | P0 完成（owner："按实际起源的来，必要时破坏性修正"）：地面移动按起源原文修正三… | progress/monthly/2026-10-4.md:17 |
| 2026-10-07 | 文档治理 v3（W1–W6）＋ 看板使用规程（a）＋ 软提示（b）… | progress/monthly/2026-10-4.md:18 |
| 2026-10-07 | 首次读者模拟 ＋ 循环硬伤修复（§0.2 日常流程 / [G] 同源门 / ID 分配规则）… | progress/monthly/2026-10-4.md:19 |
| 2026-10-07 | 新增 owner 决策队列 `OWNER.md`（8 待决 / 7 已决，按 P0–P2 排序）＋ `AGENTS §0.3` 登记规则 ＋ `[G]⑥` 悬空 D-### 门… | progress/monthly/2026-10-4.md:20 |
| 2026-10-07 | 契约改造 D-001~D-004（判据列 / 阻塞态 / 认领 / 68 条改判）＋ 文档归位（README·arch·norms 加 OWNER 指针）… | progress/monthly/2026-10-4.md:21 |
| 2026-10-07 | 看板首次分卷（40 条已记录/已结案 → `progress/board/archive-2026-10.md`，76.9→69.8 KB）＋ `[G]` ID 全集跨页… | progress/monthly/2026-10-4.md:22 |
| 2026-10-07 | 流程文档体积政策 `§0.4` ＋ 注释纪律 `§3.1` ＋ progress 目录化（monthly 4 卷 / board）＋ `[H][I][J]` 三门前 ④⑤⑥… | progress/monthly/2026-10-4.md:23 |
| 2026-10-07 | 推送前检查：上级覆盖 0 缺口 ＋ 写路径规则修正（当前写入目标）＋ `[I][K]` 两门… | progress/monthly/2026-10-4.md:24 |
| 2026-10-07 | 待办清账（批量核对）：178 条未结 + OWNER 6 条待决全量机械核对，结案 4 条（T-023/T-129/T-132/T-150 判据实跑 0 命中）、修 1 条错判据（T-126）、消 1 条重复（T-038↔T-135）；未结项 178→174… | progress/monthly/2026-10-4.md:25 |
| 2026-10-07 | 项目级 agent 环境陷阱 skill（`skills/websurf-env-traps/SKILL.md`）：实测本机 DSH 不自动发现项目级 skill ⇒ 由 `AGENTS §0` 第 7 条强制指向；6 节 7.2 KB，覆盖截断输出 / 假「已删除」/ 沙箱 / git 并发 / 判据口径… | progress/monthly/2026-10-4.md:26 |
| 2026-10-07 | 文档已知缺口封堵机制（体检 `[L]` 缺口↔看板 + `[M]` 假结案探测，均故障注入验证）：终态行的详情 doc 必须打「已消除」标记；判据的 `-- 路径` 指错目录会假结案 ⇒ T-129/T-132 回滚为待修… | progress/monthly/2026-10-4.md:29 |
| 2026-10-07 | T-169：viewer 记录链路接入 KSF/gokz `.rec`（gokz-rec.ts 新解析器 + 四类魔数分派 + [9b] 28 项自检；真实文件 2926 tick 闭合；体检等价实现全 0）… | progress/monthly/2026-10-4.md:28 |
| 2026-10-07 | 收尾（owner 批准）：skill 链进 `~/.agents/skills`（junction，指向仓库同一份文件；`skill` 工具已可解析）＋ `.archify/` 进 `.gitignore`… | progress/monthly/2026-10-4.md:30 |
| 2026-10-07 | 三工程脚本 / `.cmd` / 部署链约束层：21 件脚本逐件判接线（唯一孤儿 input-replay-verify.mjs，T-035 待裁决）＋ 新规范篇 `scripts-and-ci.md` ＋ 体检 `[N]`（豁免须明面登记；部署链 app 列表同源）… | progress/monthly/2026-10-4.md:31 |
| 2026-10-07 | 文档契约 docflow（第一步）：md 分只读 10 / 可编辑 69，只读改·新建·删除需 owner 许可（approve→sync 重钉）；`claim`/`verify` 锁任务结束条件；体检 `[O]`；AGENTS.md 作为候选提升待定（§7.1 滚动索引冲突）… | progress/monthly/2026-10-4.md:32 |
| 2026-10-07 | T-035 结案：退役零接线的 59 KB 孤儿脚本（改名 `_` 前缀、撤出索引、本地保留）；三处源码注释去引用并**保持行数**（指向 app.ts 的锚点近 400 处）；规范篇走 docflow 只读许可闭环… | progress/monthly/2026-10-4.md:33 |
| 2026-10-07 | 全历史脱敏重写：`filter-branch` 索引过滤 417 提交（90 个泄漏 blob）、文档 73 处短 SHA 重映射、强推 main+tag；新增规范篇 `norms/local-path-hygiene.md` 与体检 `[P]`… | progress/monthly/2026-10-5.md:11 |
| 2026-10-07 | T-132 结案（推送前顺带修）：smoke-cdp 的 `WS_PATH` 兜底去本机化（改为本工程 `node_modules/ws` + 明确报错，行数不变以保住下游锚点）；判据 `git grep "C:/Users/"` ⇒ 0 命中；记录里的本机路径一并脱敏… | progress/monthly/2026-10-5.md:10 |
| 2026-10-07 | 独立审查子代理回报 ⇒ 门禁自审 P1 全修：锚点指纹改按「目标:行号」存比（插入不再假红）＋ `sync` 点名重钉且留痕 ＋ 控制层裸锚点纳入（162 处）＋ CI 变更基线（`HEAD^`）＋ `[C]` 转硬门 ＋ 覆盖率按相对路径 ＋ 分卷前取许可；顺带改正三处假陈述… | progress/monthly/2026-10-5.md:9 |
| 2026-10-07 | T-134 / T-135 / T-038 结案：三工程 `.cmd` 入口对齐（multi 透传 / play.cmd 委派前置 / 端口占用只告警）＋ `.cmd` 行尾必须 CRLF（实测 LF 会让 cmd 切错命令行）＋ `.gitattributes` 钉死… | progress/monthly/2026-10-5.md:5 |
| 2026-10-07 | 三取向落地：AGENTS.md 进只读宪法层（§7.1 滚动索引冻结）＋ 控制层字段级功能权限（TODO 按列、OWNER 可追加、不许删）＋ 单元级强绑定内核（配对登记为 D-107）… | progress/monthly/2026-10-5.md:6 |
| 2026-10-07 | (a) 锚点内容指纹落地（3239 处／点名到「第几个锚点」）＋ D-107 已决（选 a；c 记长期）＋ 踩坑进 skill §7＋ OWNER 钉法修正（行会跨节换列形状 ⇒ 列级钉不适用）… | progress/monthly/2026-10-5.md:7 |
| 2026-10-07 | 审查三件按优先级修：① 锚点覆盖率（首跑揪出零接线的 check-glb-parity.mjs ⇒ T-409，覆盖率转硬门）② 待裁决压力提示 + §0.1 新条 ③ 体检改动面模式；另放开 TODO 新增行… | progress/monthly/2026-10-5.md:8 |
| 2026-10-08 | T-410 结案：patch 材质 include 前缀叠加修复（surf_boreas missing 21→0，surf_666 46 不变）；1 行代码 + 净 0 行以保住 materials.rs 下游锚点 | progress/monthly/2026-10-5.md:12 |
| 2026-10-08 | T-411 结案：Water 无 $basetexture 由不透明纯白改为半透明水色（surf_boreas 320 图元；probe10 实测 OPAQUE→BLEND） | progress/monthly/2026-10-5.md:13 |
| 2026-10-08 | T-412 结案：2D cubemap 天空盒（debug 接线；LightManager 背景优先天空盒）；验收=6 面 PNG + background=CubeTexture + 抬头截图由暗变亮 | progress/monthly/2026-10-5.md:14 |
| 2026-10-08 | T-413 结案：地图雾 env_fog_controller → THREE.Fog（LightManager.setFog + 可开关）；验收=Fog(500,43420,e8fffe) + 合成用例 + 雾化截图 | progress/monthly/2026-10-5.md:15 |
| 2026-10-08 | T-414 结案：动态道具进 GLB（引用集合并入实体 model + collect_model_entities）；验收=boreas nodes 1513→1514 命中 buk01.mdl、666 +1=cow.mdl | progress/monthly/2026-10-5.md:16 |
| 2026-10-08 | T-415 结案（W7 核查）：surf_boreas 无 3D 天空盒几何（sky_camera 在包围盒外 1281 HU、3000 HU 内 0 网格）⇒ 无需行动；其它图需另立启发式切分任务 | progress/monthly/2026-10-5.md:17 |
| 2026-10-08 | T-416 结案：game 接上 2D 天空盒（wasm 增 3 导出（EOF 独立 impl 块保锚点）+ TS 1:1 接线）；验收=端到端 faces=6 槽序正确 + typecheck/build:wasm 通过。viewer 待做 | progress/monthly/2026-10-5.md:18 |
| 2026-10-08 | T-417 结案：viewer 接上 2D 天空盒（wasm 3 导出 EOF 块 + TS 1:1）；验收=端到端 faces=6 槽序正确 + typecheck/build:wasm 通过 ⇒ 三工程天空盒一致 | progress/monthly/2026-10-5.md:19 |
| 2026-10-08 | T-418 结案：缺失纹理观测补强（+texture_absent 判据）；验收=boreas 0→5 / 666 46→47 且逐条可回溯；查出 VTF 格式不支持（Bgra4444/Ia88）与两条解码路径不一致（→ T-419） | progress/monthly/2026-10-5.md:21 |
| 2026-10-08 | T-420 结案：天空盒六面拼接修正（按 map_coords 真实轴约定重写槽位 + 极面各转 90°）；验收=相邻边缝差 0.82/极面 0° 最低分 + 两图截图 | progress/monthly/2026-10-5.md:22 |
| 2026-10-08 | T-421 结案：微缩外景（合成三层山脊，挂场景根、随图释放）；取证=夹具无可分离微缩区；验收=隐藏地图 A/B 9.26%、带地图 0.17%（显著性待调） | progress/monthly/2026-10-5.md:23 |
| 2026-10-08 | T-424 结案：3D 天空盒用地图自带微缩区（sky_camera 半径内复制 + 放大 scale + 搬到世界原点，当天空层）；上轮 3000 HU 探测是假阴性；A/B 证明远山来自微缩区 | progress/monthly/2026-10-5.md:24 |
| 2026-10-08 | T-425 登记：树/道具黑剪影取证（贴图本身暗 + 356/1562 带 vhv 且值偏暗 + 部分树两者皆无）；并修掉 T-424 副本丢 userData/材质注入的缺陷 | progress/monthly/2026-10-5.md:25 |
| 2026-10-08 | T-426 登记 + D-015：prop 光照分类实测（982/1562 两者皆无、能探到的值 0.05~0.33 偏暗）；读码发现 StaticPropLump 未读 m_AmbientCube，但 sprp 在压缩 lump 内无法 raw 验证 | progress/monthly/2026-10-5.md:26 |
| 2026-10-08 | T-427 登记：雪盖缺失的机制 —— 雪在 WorldVertexTransition 的 $basetexture2（alpine_snow01），本仓全链路未处理；混合 alpha 在未读的 lightmap-alpha lump | progress/monthly/2026-10-5.md:27 |
| 2026-10-08 | T-427 续：雪/岩混合系数查实 = 位移顶点 alpha（84405 个、0~255 双峰，我们早已解析未用）；DISP lightmap alpha lump 是空的（已排除） | progress/monthly/2026-10-5.md:28 |
| 2026-10-08 | T-427 ①②：混合权重导出为 _VBSP_BLEND（1716 图元 / 401427 顶点）+ 第二贴图 $basetexture2 入 GLB（alpine_blendrocksnow → alpine_snow01） | progress/monthly/2026-10-5.md:29 |
| 2026-10-08 | T-427 ③ 渲染端混合落地：雪出现（A/B 同视点对照）；三工程 1:1 接线；T-422/T-427 结案；D-015 agent 自决选 (b) | progress/monthly/2026-10-5.md:30 |
| 2026-10-08 | **T-427 ③ 修正复盘**：上次的「雪」实为地形未渲染（UV varying 误判 ⇒ program 编译失败）；改为从 three ShaderChunk 读 UV 名 + 加诊断日志；复核 0 报错、地形在画 | progress/monthly/2026-10-6.md:5 |
| 2026-10-08 | T-428：3D 天空盒外景锚点修正 —— 必须绕 sky_camera 缩放（锚点=相机），锚点取原点会让外景偏 21.6°~77.1°；数值 0.00° + 目视复核 | progress/monthly/2026-10-6.md:6 |
| 2026-10-08 | T-423/T-425 结案：整体偏暗主因是 setLightGamma 窗口 (0,1] 与语义相反（2.2 一直被忽略）；修后地板 [42,38,33]→[99,89,76]、暗像素 75.7%→0.7%；另修 ambient cube 回溯深度 2→16 | progress/monthly/2026-10-6.md:7 |
| 2026-10-08 | T-429：外景被切掉大半（半径法只取 102/361 图元）→ 改簇扩张取全；并查实天空相机位置能看到完整雪山（第二相机实验未成、已回退） | progress/monthly/2026-10-6.md:8 |
| 2026-10-08 | T-426 正面结案：装配期插桩证明 638/638 树全部拿到 cube（miss 全是世界模型）；Round 9 的「355 无 cube」是运行时替身假阳性；撤插桩后 arbre amb 1252/1256 | progress/monthly/2026-10-6.md:8 |
| 2026-10-08 | T-430：3D 天空盒改第二相机两遍法（引擎式 `CAM+P/scale`；正面朝向 359.8/361 胜相对式 235.6/361、163/163 出生点）；纠正 T-415「无几何可渲染」与 T-428「锚点=相机」两条已结案结论；隔离渲染证明天空/主两遍互不侵入 | progress/monthly/2026-10-6.md:9 |
| 2026-10-08 | T-430 续：天空遍的雾按引擎 Enable3dSkyboxFog 接上（用 sky_camera 自己的雾键值 + start/end 乘 1/scale；fogenable 假则天空遍不吃雾）——此前按主图雾衰减，远山过清 | progress/monthly/2026-10-6.md:10 |
| 2026-10-08 | T-431：地图「黑带」根因 = lightmap 图集空纹素被当纯黑采样（每面 1 px 边距 + 打包未用空间是 (0,0,0,0)）；实测 7.27% 顶点取样落空、86% 恰差 1 纹素，8 张图空纹素 32.7%~67.2% | progress/monthly/2026-10-6.md:11 |
| 2026-10-08 | T-431 结案：图集落位后多源 BFS 膨胀填满空纹素（越界取样改取该面自己的边缘 luxel）；8 张图 `空=0.0%`、badSamplingVerts 26,810→0；单测用抽源码 + 独立 rustc 跑通（宿主 cargo 链接不可用） | progress/monthly/2026-10-6.md:12 |
| 2026-10-08 | T-431 复盘：按 SDK 复查 lightmap「解析」口径（CalcFaceExtents / 采样块跨距 `lumpBytes≈16×luxelCount` / used==luxelCount）全部自洽 ⇒ 问题在 UV 算法；SDK 指明位移面四角 luxel 恒为 (0.5,0.5)…(U+0.5,V+0.5) 并在细分网格上双线性插值 | progress/monthly/2026-10-6.md:13 |
| 2026-10-08 | T-432 结案：位移面 lightmap UV 改按 SDK 的**单位方格**（`vertex_grid_uv` + `lightmap_region_uv`）；**8 张地图逐面 uv 盒越界 0**（boreas 改前 931/1351=68.9%、最大越界 49 纹素）；截图 A/B 洋红带 4.03%→0.00%、黑块消失 | progress/monthly/2026-10-6.md:14 |
| 2026-10-08 | T-434 结案：碰撞与材质透明度解耦（去掉 `alpha_mode==1` 门控）+ `auto` 逐模型回退可视网格；surf_666 `phyOnlyModel` 2→0（窗可撞）；boreas prop 碰撞本就 11/11（1576 个 `solid=0` 是地图自己的声明） | progress/monthly/2026-10-6.md:15 |
| 2026-10-08 | T-435 结案：prop 光照方向 — 洋红=魔法点光 #352（Source [13332,628,12251]，G≈0）；GLB 位置走 map_coords 而**法线**没走 ⇒ ambient cube 轴序只在纯 yaw 下偶然对；两侧同改后竖直法线取竖直 cube 面（up 0.12904 / down 0.03378） | progress/monthly/2026-10-6.md:16 |
| 2026-10-08 | T-436 结案：缺材质的半透明占位 `[255;4]`（BLEND+alpha=1 ⇒ 白墙）改为 alpha 0.2 淡雾；实测 tendies_endsmoke 的 VMT 在包内但 $basetexture 的 VTF 不在 | progress/monthly/2026-10-6.md:17 |
| 2026-10-08 | T-437 结案：`.vhv` 是"一个 strip group 一块、按局部序"而我们当成模型顶点序 ⇒ 逐顶点光照错位；新增 `remap_strip_group_colors`，精确比对 0 处不符（旧序 3277/4082） | progress/monthly/2026-10-6.md:19 |
| 2026-10-08 | T-438 结案：`.vhv` 只含 direct+bounce、43.7% 顶点全 0 ⇒ 纯黑；按暗占比 ≥0.5 判为不可用退回 cube，黑顶点 43.7%→28.5% | progress/monthly/2026-10-6.md:20 |
| 2026-10-08 | T-439：`vbspLightFloor` 没接进 level 1（逐顶点道具），补上并用于 `max(vlight, floor)`；floor=0 时零行为变化 | progress/monthly/2026-10-6.md:21 |
| 2026-10-08 | T-440：置换面碰撞导出（1351 张面此前零碰撞）；`export_displacement_colliders` ⇒ 132,480 三角形，待 TS 接入 | progress/monthly/2026-10-6.md:22 |
| 2026-10-08 | T-440 收口：置换面碰撞接进物理（走 `export_model_tri_colliders` 出口，零 TS 改动）；条目 1136 / 三角形 141,286（disp 132,480） | progress/monthly/2026-10-6.md:23 |
| 2026-10-08 | T-419 结案：VTF `Ia88`/`Bgra4444` 解码补上 + `load_texture_bsp` 改「crate 优先、失败退本仓」；vtfDecodeFail 4→0，三条模型材质出真贴图 | progress/monthly/2026-10-6.md:18 |

| 2026-10-08 | T-444 结案：三角形是「面」不是实心体（贴坡「脚底黏住」的根因）——边墙不再出接触/法线、三角形不报 `start_solid`；真图 8 向行走 7 向 0 个「贴地却几乎不动」tick | progress/monthly/2026-10-6.md:25 |
| 2026-10-08 | T-445 结案：盒从置换面棱线上穿过去（owner 报「连跳穿透地板」）——三角形障碍集补成 Minkowski 精确面集（SDK `CDispCollTree::SweepAABBTriIntersect` 口径） | progress/monthly/2026-10-6.md:26 |
| 2026-10-08 | T-446 立项（待修）：盒起点落在道具 `.phy` 凸壳内部时整块道具被跳过、玩家穿坡（boreas `1600,7600` 的 `ramp_c1m` 实证） | progress/monthly/2026-10-6.md:27 |
| 2026-10-08 | T-447 结案：ramp 坡没实体是导出**按纹理**丢了 playerclip brush（`skip_sky`）；引擎只按 contents 判碰撞，默认改 false | progress/monthly/2026-10-7.md:4 |
| 2026-10-08 | T-448 结案：三工程同步——game 补 3D 天空盒/地图雾，viewer 补 wasm 构建 + `parse_pvs_data` + 天空区/雾（不引物理） | progress/monthly/2026-10-7.md:5 |
| 2026-10-08 | 碰撞生成逻辑解读：brush 只看 contents、置换面按 MASK_SOLID、prop 按 solid；owner 点处「隐形坡」= ramp_s1 的 PLAYERCLIP 楔形（引擎同样碰撞）⇒ 登记 D-019 | progress/monthly/2026-10-7.md:6 |
| 2026-10-08 | T-449 结案：置换面三角化改引擎扇形细分（四叉树 + `g_TesselateWinding` 8 点扇 + `allowed_vertices`），修地表与模型坡错误相交 | progress/monthly/2026-10-7.md:7 |
| 2026-10-08 | 文档整理 + 经验教训总结：推送 52 个提交（远端 = `1d18548`）；体检 A–P 全 0、`documents/index.md` 与文件树逐项对齐；新增模块不变量（位移面细分）与 `progress/lessons-2026-10-08.md`；登记 D-020（看板分卷） | progress/monthly/2026-10-7.md:8 |
| 2026-10-08 | 经验教训写进 skill：`skills/websurf-env-traps/SKILL.md` 新增 §8（文档/看板/锚点 8 条）+ §1 两行；只读 md 走 owner 许可 + sync | progress/monthly/2026-10-7.md:9 |
| 2026-10-09 | Pages 站点被「从分支构建」顶掉（站点根变 README 渲染页）——`build_type` 改回 `workflow` + 重跑部署已恢复；取证：188 份 DSH 会话日志 0 命中，改动来自浏览器会话；登记 D-021 / T-607 | progress/monthly/2026-10-7.md:10 |
| 2026-10-09 | 看板清理：65 条待裁决逐条核验（遗弃 7 / 转待修 25 / 保留 33）＋ OWNER 14 条决定按推荐值落实（D-020 分卷已执行）＋ 53 条分卷（TODO 97.3→77.9 KB） | progress/monthly/2026-10-7.md:11 |
| 2026-10-09 | T-127/T-128 结案：viewer 夹具与 dist 示例源改指 `test/replay`（+ bundle 层数修正）⇒ 自检真实文件段不再 SKIP、dist 已打包示例 | progress/monthly/2026-10-7.md:12 |
| 2026-10-09 | T-016/T-018 结案：删掉共享层代码里的陈旧文档编号（`§3.4.C` / `Q1` / `§8.5`）；tick-authority 测试直跑全例通过 | progress/monthly/2026-10-7.md:13 |
| 2026-10-09 | T-209 结案：game 面板 M/ESC 加 `sceneReady` 守卫（+ 加载失败路径复位）；改动全为 1:1 行替换、锚点零漂移 | progress/monthly/2026-10-7.md:14 |
| 2026-10-09 | T-064 结案：debug 文档 `ready` 锚点按符号重定位（483 → 484）；证据列裸文件名会触发 `[D]` 歧义 + 死锚点 | progress/monthly/2026-10-7.md:15 |
| 2026-10-09 | T-106/T-119 结案（待裁决清账）：numField 空串不再当 0（DOM 桩探针行为验证）、时间轴 prerun 文案改正 | progress/monthly/2026-10-7.md:16 |
| 2026-10-09 | T-005 结案：game favicon 从历史恢复（168 B）并接进两形态 dist（KEEP 名单 + 拷贝）；HTML 只留相对路径 | progress/monthly/2026-10-7.md:17 |
| 2026-10-09 | T-048 结案：game Worker 消息联合按实际收发面补齐（13+12 条 + 8 个新接口，EOF 追加保锚点）；覆盖探针未覆盖 0 | progress/monthly/2026-10-7.md:18 |
| 2026-10-09 | T-007/T-309 结案：debug 手写 .d.ts 文末声明合并补齐（33/26 逐名一致，缺 0）+ 删掉两处运行时收窄 | progress/monthly/2026-10-7.md:19 |
| 2026-10-09 | T-153 结案：viewer lib 加 WebWorker、删手写 WorkerCtx（ctx = self）；typecheck + build:worker 通过 | progress/monthly/2026-10-7.md:20 |
| 2026-10-09 | T-142 结案：viewer 信息条改收已解析的 Track\|null（跟随轨道只在 TrackSet.follow 一处解析）+ 同族 prerun 文案 | progress/monthly/2026-10-7.md:21 |
| 2026-10-09 | T-152 结案：viewer 解析 Worker 加 30 s 看门狗（到期判失联 ⇒ 主线程回退）；假 Worker 探针实测 30.0 s | progress/monthly/2026-10-7.md:22 |
| 2026-10-09 | T-124 结案：viewer 轨道偏移输入加 1 h 上限（模型侧不设限，只挡用户输入面） | progress/monthly/2026-10-7.md:23 |
| 2026-10-09 | T-151 结案：viewer 加第三层契约门（Rust `BspMetadata` serde 键名 ↔ TS `BspMeta` 接口键名，双向缺键即 exit 1） | progress/monthly/2026-10-7.md:24 |
| 2026-10-09 | T-138 结案（viewer 光照下拉初值取实况 + 切换后回填）/ T-141 遗弃（parentElement 强转已不存在，探针证明 setTracks(null) 不抛） | progress/monthly/2026-10-7.md:25 |
| 2026-10-09 | T-120 结案（跑段高亮同基，探针 60% vs 旧 50%）/ T-126 / T-129 结案；T-133 遗弃（.gitignore 无该规则、判据本就满足） | progress/monthly/2026-10-7.md:26 |
| 2026-10-09 | T-105 结案（WASM 失败不再永久缓存，探针 1→2 次重试）/ T-122 结案（Blob URL 3 建 3 revoke）；T-123 遗弃（T-152 已覆盖）/ T-136 遗弃（与 T-224 同源，合并） | progress/monthly/2026-10-7.md:27 |
| 2026-10-09 | T-140 结案（遥测改用 sampling.horizontalSpeed，探针 500/0/250）/ T-121 结案（disposeTree 释放 Line+Points，探针 0→2） | progress/monthly/2026-10-7.md:28 |
| 2026-10-09 | T-108 结案：viewer 回退脚本加载加 10 s 超时 + 三条路径移除 script 标签（探针：标签数 0 / 超时 10.0 s） | progress/monthly/2026-10-7.md:29 |
| 2026-10-09 | T-154 结案（clipToPayload 显式返回类型，报错落点移到定义处）/ T-155 结案（req.rule 防御，TypeError → 明确错误） | progress/monthly/2026-10-7.md:30 |
| 2026-10-09 | T-205/T-207/T-208/T-219 结案（game）：固定 tick 值单点化、删恒真判门、控件缺失告警、SceneDataMessage 归位 | progress/monthly/2026-10-7.md:31 |
| 2026-10-09 | T-215/T-216 结案（game）：非数组存档报错；存点写入合并（50 次 add ⇒ 1 次 setItem） | progress/monthly/2026-10-7.md:32 |
| 2026-10-09 | T-223 结案：game single 产物补 `coi-serviceworker.js`（KEEP_SINGLE 6→7 + 拷贝；实测 dist 7 条目） | progress/monthly/2026-10-7.md:33 |
| 2026-10-09 | T-220 结案：game worker 的 `world-parse-ms` 代理测量默认关闭（探针：默认 0 次解析 / 开关打开 2 次） | progress/monthly/2026-10-7.md:34 |
| 2026-10-09 | T-224 结案：三工程 build-dist 日志前缀 `[5/5]` → `[single]`/`[multi]`（24 行 1:1；真实构建输出验证） | progress/monthly/2026-10-7.md:35 |
| 2026-10-09 | T-401 结案：`mosaic` 解码器补尺寸/调色板越界校验（修复前 wasm panic 已实测复现；重建 wasm 后改为返回错误） | progress/monthly/2026-10-7.md:36 |
| 2026-10-09 | T-144/T-218 结案：`.mdl` 配对大小写缺陷（三工程同源代码一并修，1:1）；回归实测三张地图 GLB 逐字节一致 | progress/monthly/2026-10-7.md:37 |
| 2026-10-09 | T-310 结案：debug 的「自动恢复默认体积」开关真正接上物理（探针：开关关 10000×5000 / 开关开卡死后 32×72） | progress/monthly/2026-10-7.md:38 |
| 2026-10-09 | T-302 结案：新增 `check:param-defaults` 交叉校验（正例 7 项 OK；反例 gravity 800→900 ⇒ exit 1） | progress/monthly/2026-10-7.md:39 |
| 2026-10-09 | T-304/T-305 结案（均判遗弃不修）：τ 与 now 同源、residual 主线程原理上拿不到；顺带修正 2 处指错行的锚点 | progress/monthly/2026-10-7.md:40 |
| 2026-10-09 | T-013 结案（错误串去外部实现引用）；另完成 T-433 诊断：prop 两条光照路径 either/or + 乘法 ⇒ cube 从未生效 | progress/monthly/2026-10-7.md:41 |
| 2026-10-09 | T-433 实测诊断：VHV 数据中位 40~60 / max 239（非「max 95」）、alpha=255；两条 prop 光照是 either/or + 乘法 ⇒ 按 D-016 改相加（下轮实施） | progress/monthly/2026-10-7.md:42 |
| 2026-10-09 | T-433 实施完成（cube 按顶点烘成属性 + 真相加；探针逐面核对），转阻塞等 owner 目视（OWNER.md D-023） | progress/monthly/2026-10-8.md:5 |
| 2026-10-09 | T-311 结案（写入失败不再静默）；登记 D-024（死代码族：D-103 不删 vs 各行判据要删） | progress/monthly/2026-10-8.md:4 |
| 2026-10-09 | T-503 结案：合批按属性签名切子组（修复前 3 块+报错 → 修复后 2 块+0 报错；现有回归 21/21） | progress/monthly/2026-10-8.md:6 |
| 2026-10-09 | T-202 结案：可选 DOM 缺失改走 `optDom()` 打点名告警（app.ts 五处 1:1、246 锚点零漂移） | progress/monthly/2026-10-8.md:7 |
| 2026-10-09 | T-446 实测（未结案）：移动侧也穿坡（-66）、trace 能命中 367.4；已加 start_solid 1:1 守卫但非成因；phys 回归 36/36 | progress/monthly/2026-10-8.md:8 |
| 2026-10-09 | T-446 结案（遗弃）：ramp 穿坡已由 T-447（skip_sky 按纹理丢 brush）解决；实测碰撞命中 367.4；保留 start_solid 1:1 加固（phys 36/36） | progress/monthly/2026-10-8.md:9 |
| 2026-10-09 | T-301 结案：回放样本带 `dt`（调用点补第 5 参 + 三处物化 + InputFrame.dt），全 1:1 零漂移 | progress/monthly/2026-10-8.md:10 |
| 2026-10-09 | 待裁决首批 12 条处置（11 转待修带判据 / 1 结案）；登记 D-025 批量授权；待裁决 30→18 | progress/monthly/2026-10-8.md:11 |
| 2026-10-09 | 待裁决清零（30→0）：第二批 18 条全部转待修并补可执行判据（判据挂真实 .dem 夹具与 ci-gates.yml） | progress/monthly/2026-10-8.md:12 |
| 2026-10-09 | T-504 结案：无纹理面兜底色白→深灰；定位纠错（真正生效的是 fallback_bsp:328 而非 issue 指的 437/478）；探针 46→0 白 | progress/monthly/2026-10-8.md:13 |
| 2026-10-09 | T-015 结案：start_disabled 恒 false 修掉（大写键→小写键，两处 1:1）；surf_fornax 唯一一条 StartDisabled 1 实测生效 | progress/monthly/2026-10-8.md:14 |
| 2026-10-09 | T-303（PVS 未接线就不打印假「隐藏 N」）+ T-201（wasm 初始化失败不再被吞、阻断加载）结案；两处 1:1 | progress/monthly/2026-10-8.md:15 |
| 2026-10-09 | T-610 结案 + D-022 落地：源码级契约接进 CI（--source-only + source-contract job）；负向测试 exit 1 | progress/monthly/2026-10-8.md:16 |
| 2026-10-09 | D-024 落地：死代码窄口径首批删 3 条（T-158/159/160）；发现锚点行号陈旧体检抓不到 ⇒ 立项 T-611 | progress/monthly/2026-10-8.md:17 |
| 2026-10-09 | D-024 第二批：再删 4 条真死代码（T-163/164/165/168）；锚点平移改为「git diff -U0 hunk 表 + 全仓单趟重编号」 | progress/monthly/2026-10-8.md:18 |
| 2026-10-09 | D-024 第三批：T-161 删 5 留 3（并更正原断言）、T-162/T-156 遗弃；三工程 typecheck 全 0 | progress/monthly/2026-10-8.md:19 |
| 2026-10-09 | 遗留路线清查：按 git 记录对照结掉 T-031/032/036/222（并挡回 T-054/T-055/T-056） | progress/monthly/2026-10-8.md:20 |
| 2026-10-09 | 遗留路线清查二批：T-060（owner 终裁）/ T-039（cargo 判据 exit 0）/ T-058（五类口径，㈤ 已接线）结案 | progress/monthly/2026-10-8.md:21 |
| 2026-10-09 | T-054 P1 三条修掉（全局 focus/selection、禁用态、#error 不清），全部 1:1 零锚点漂移 | progress/monthly/2026-10-8.md:22 |
| 2026-10-09 | T-055 P1#1 键盘可达（8 .mod + key-chip/x + onActivate@EOF）；T-054 P2 再修四条 | progress/monthly/2026-10-8.md:23 |
| 2026-10-09 | T-055 再修五项（P1#2 引导线联动、#status 省略、--hud-text 令牌、头注两处、删不可达规则）；余 2 项标 [待确认] | progress/monthly/2026-10-8.md:24 |
| 2026-10-09 | T-024 结案：worker-types 的 wasm-init / input 字段按分发器与发送面补齐（1:1 零漂移） | progress/monthly/2026-10-8.md:26 |
| 2026-10-09 | T-238 判为遗留误报结案：debug 侧 sendInit 就发那三个字段（拦下一次 19 处锚点平移） | progress/monthly/2026-10-8.md:27 |
| 2026-10-09 | T-029 结案：2 条子项的对象（本地探针 jump-apex-measure.mjs）全工作区扫描不存在；在库件 test:jump-apex exit 0 | progress/monthly/2026-10-8.md:28 |
| 2026-10-09 | dem 簇：T-110/112/113 结案（探针实测 4 份 .dem）、T-111/114 收窄；test:replay exit 0 | progress/monthly/2026-10-8.md:29 |
| 2026-10-09 | T-157 遗弃结案 + T-101/T-102 修复落地；确认本机 Edge 存在（CDP 路径可用） | progress/monthly/2026-10-8.md:30 |
| 2026-10-09 | CDP 路径打通（静态服务 + Edge headless 探针）；T-101 实测结案 | progress/monthly/2026-10-8.md:31 |
| 2026-10-09 | T-055 结案：两项由 CDP 几何实测确认并修复（行高 53→35；切角偏差 56/89→0.3/0） | progress/monthly/2026-10-8.md:32 |
| 2026-10-09 | D-023 本机实跑：默认视点纯黑 0.00%，玩家出生点 21~29%（虚空/未受光未判定）⇒ 收窄成 owner 看两张图 | progress/monthly/2026-10-8.md:33 |
| 2026-10-09 | D-023 三项仪器化排除：清屏色/叠加层/缺失纹理占位色都不是那 21~31% 纯黑的来源 | progress/monthly/2026-10-9.md:5 |
| 2026-10-09 | 卷 9 开卷（CDP 视觉验证 / 遗留清查续）；TODO 已结案 90 行分卷入归档（170→80 行，44.7 KB） | progress/monthly/2026-10-9.md:1 |
| 2026-10-09 | T-130 结案 + T-612 登记；TODO 分卷 90 行 → 归档第 2/3 卷，TODO 97.5→44.7 KB；新开第 9 卷 | progress/monthly/2026-10-9.md:7 |
