# progress/ 导航（过程记录）

> **性质**：**过程记录，不作事实来源**（事实以当前代码为准，状态只在 `TODO.md`）。本页只回答「哪个文件管什么、什么时候去看它」。
> **体积纪律**：过程记录单文件 ≤ 48 KB，超限按时间/主题切卷，卷必须登记在本页（体检 `[I]` 硬查覆盖）。

| 文件 | 一句话 | 什么时候看 |
|---|---|---|
| `monthly/2026-09-1.md` | 2026-09 第 1/2 卷：重编期 WG 收尾（2026-09-22 ~ 09-29，19 条） | 追某次改动当时怎么做的 |
| `monthly/2026-09-2.md` | 2026-09 第 2/2 卷：UI 轮次 / 主题 / 事故补救（2026-09-23 ~ 09-30，19 条） | 追某次改动当时怎么做的 |
| `monthly/2026-10-1.md` | 2026-10 第 1/4 卷：物理 bevel / chamfer 那批（2026-10-04 ~ 10-07，13 条） | 追某次改动当时怎么做的 |
| `monthly/2026-10-2.md` | 2026-10 第 2/4 卷：渲染层下沉 Phase 1–3d（2026-10-02 ~ 10-03，13 条） | 追某次改动当时怎么做的 |
| `monthly/2026-10-3.md` | 2026-10 第 3/4 卷：viewer 影带 / 时间轴 / 主题（2026-10-02，13 条） | 同上 |
| `monthly/2026-10-4.md` | 2026-10 第 4/4 卷：10-01 收尾 ～ 本轮文档整理（2026-10-01 ~ 10-07，13 条） | **新一轮进展写在这里**（当月最后一卷） |
| `board/archive-2026-10.md` | 看板分卷：已记录 + 已结案（40 条） | 查某条历史项的 ID / 状态 |
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

## 卷序（月度进展）

> **当前写入目标**：`progress/monthly/2026-10-4.md`（当月最后一卷；该卷超过 **40 KB** 就新建下一卷，按 §0.4 补「上/下卷链接 + 登记本页 + 索引各一行」）。
> **按日期找哪一卷**：以各行右列的**覆盖范围**为准；注意**新条目一律追加在当月最后一卷**，所以相邻卷的范围可能重叠——精确查找直接用 `grep -n "2026-10-05" progress/monthly/*.md`。

`2026-10` 按月切了 4 卷（每卷 ≤ 48 KB，按时间顺序）：`2026-10-1` → `2026-10-2` → `2026-10-3` → `2026-10-4`。每卷头部有「上一卷 / 下一卷」链接；右列「什么时候看」写着用途。新进展追加到**当月最后一卷**（本页右列会随之更新）。

## 进展索引（全量，90 条）

> 由 `AGENTS.md §7.1` 分卷而来（入口文件 ≤ 32 KB，只保留最近 10 条 + 指针）。**新增进展**仍追加到 `progress/monthly/` 对应卷，然后在 AGENTS §7.1 与本节各补一行。

| 日期 | 摘要 | 明细 |
|---|---|---|
| 2026-10-07 | owner 三问处置：物理通用性（答复）＋ debug 出生点「铁丝网」材质缺失修复 ＋… | progress/monthly/2026-10-1.md:10 |
| 2026-10-07 | `.phy` 凸体补面接通物理（E′：VBSP `AddBrushBevels` 复刻 … | progress/monthly/2026-10-1.md:11 |
| 2026-10-07 | bevel 第五路三缺陷修复（owner 复核 a8b9628 后报三问题，全部实测定位… | progress/monthly/2026-10-1.md:12 |
| 2026-10-07 | owner 复核第五路线框报两问题，均已修（`16d9eba` 之后追加提交）。① 触发… | progress/monthly/2026-10-1.md:13 |
| 2026-10-07 | debug 新增第五路线框：BSP 原生 bevel 辅助碰撞面（白，独立开关）。原理考… | progress/monthly/2026-10-1.md:14 |
| 2026-10-07 | P1 落地：运行时 chamfer 整段撤除，碰撞平面表回到「真实面 + BSP 原生 … | progress/monthly/2026-10-1.md:15 |
| 2026-10-07 | 路线 A 落地：撞面推开改为「只在起点已嵌入时执行」—— 高刷屏下贴墙不再被推着走（ow… | progress/monthly/2026-10-1.md:16 |
| 2026-10-07 | 「debug 预测定步 + 渲染插值」整条线（`4726c05` + `402da6d`… | progress/monthly/2026-10-1.md:17 |
| 2026-10-05 | surf_666 尖脊坡全链路：弹飞已修、卡死已修（B/E 实测否掉、走修法 A）、`s… | progress/monthly/2026-10-1.md:18 |
| 2026-10-05 | surf_666 尖脊「弹飞」与「卡死」两条缺陷：定位、修复弹飞、卡死登记待裁决（own… | progress/monthly/2026-10-1.md:19 |
| 2026-10-04 | 渲染收敛第二轮（owner 指令「合并过于保守」）：viewer 缺材质根因修复 + d… | progress/monthly/2026-10-1.md:20 |
| 2026-10-04 | 渲染层下沉 Phase 5：终验与部署。fc8800e 推送后三道 CI 门全绿（Doc… | progress/monthly/2026-10-1.md:21 |
| 2026-10-04 | 渲染层下沉 Phase 4：推广与收尾（game↔debug/viewer 渲染逻辑逐项… | progress/monthly/2026-10-1.md:22 |
| 2026-10-03 | 3d 文档同步补完（`Doc Drift Check` 门修复）。触发：`e87b693… | progress/monthly/2026-10-2.md:11 |
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
| 2026-09-30 | 事故与补救：bd46461 误提交夹带另一 agent 的未提交工作（DEM 回放 20… | progress/monthly/2026-09-2.md:15 |
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
