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
| `monthly/2026-10-9.md` | 2026-10 第 9/10 卷：CDP 视觉验证 / 遗留路线清查续（2026-10-09 起） | （2026-10-09 起由第 10 卷接续） |
| `monthly/2026-10-10.md` | 2026-10 第 10/11 卷：三端模型/光照分叉分析 + T-454 P0–P5-2（2026-10-09，40.77 KB 后封卷） | 追该阶段的逐条过程 |
| `monthly/2026-10-11.md` | 2026-10 第 11/11 卷：T-454 续（自 2026-10-09 滚动分卷起） | **新一轮进展写在这里**（当月最后一卷） |
| `board/archive-2026-10.md` | 看板分卷：已记录 + 已结案（93 条） | 查某条历史项的 ID / 状态 |
| `board/archive-2026-10-2.md` | 第 2 卷：2026-10-09 分卷移出的 90 条已结案行 | 追溯用 |
| `board/archive-2026-10-3.md` | 第 3 卷：同上（后半） | 追溯用 |
| `board/archive-2026-10-4.md` | 看板分卷第 4 卷：2026-10-09 再分卷的已结案行（第 1/2 批） | 查某条历史项的 ID / 状态 |
| `board/archive-2026-10-5.md` | 看板分卷第 5 卷：2026-10-09 再分卷的已结案行（第 2/2 批） | 查某条历史项的 ID / 状态 |
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
| `index/2026-09.md` | 进展索引分卷 1/2：2026-09 的 38 条 | 查 9 月的逐条进展索引 |
| `index/2026-10-1.md` | 进展索引分卷 2/2：2026-10 上旬的 106 条 | 查 10 月上旬的逐条进展索引 |

## 卷序（月度进展）

> **当前写入目标**：`progress/monthly/2026-10-11.md`（当月最后一卷；超过 **40 KB** 就先开新卷、硬上限 **48 KB** 见 §0.4；新卷要补「上/下卷链接 + 登记本页 + 索引各一行」）。
> **按日期找哪一卷**：以各行右列的**覆盖范围**为准；注意**新条目一律追加在当月最后一卷**，所以相邻卷的范围可能重叠——精确查找直接用 `grep -n "2026-10-05" progress/monthly/*.md`。

`2026-10` 按月切了 6 卷（每卷 ≤ 48 KB，按时间顺序）：`2026-10-1` → `2026-10-2` → `2026-10-3` → `2026-10-4` → `2026-10-5` → `2026-10-6`。每卷头部有「上一卷 / 下一卷」链接；右列「什么时候看」写着用途。新进展追加到**当月最后一卷**（本页右列会随之更新）。

## 进展索引（本页保留最近 89 条：2026-10-08 起）

> **分卷（2026-10-09，owner 授权）**：2026-09 与 10 月上旬共 144 条已移入 [`index/2026-09.md`](index/2026-09.md)（38 条）与 [`index/2026-10-1.md`](index/2026-10-1.md)（106 条）；**新增进展仍追加在本页**，本页超过 40 KB 时把最老一段切进 `index/`（细则见 `AGENTS §0.4`）。

> 由 `AGENTS.md §7.1` 分卷而来（入口文件 ≤ 32 KB）。**新增进展**追加到 `progress/monthly/` 的「当前写入目标」那一卷，然后在**本节**补一行（`AGENTS §7.1` 已于 2026-10-07 冻结，不再追加）。


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
| 2026-10-09 | T-612 结案：合并签名补 gpuType（viewer 262 次报错归零）；冒烟 6→3 项失败 | progress/monthly/2026-10-9.md:7 |
| 2026-10-09 | T-131 结案：静态断言按形态分支，multi/single 两形态各 exit 0 ⇒ viewer 冒烟 0 项失败 | progress/monthly/2026-10-9.md:8 |
| 2026-10-09 | viewer wasm 簇：T-146（锁中毒→JsError）+ T-148（num_static_props 缓存）结案；65 处 lib.rs 锚点重编号 | progress/monthly/2026-10-9.md:9 |
| 2026-10-09 | T-143（el() 的 id 告警，Node 探针实测）+ T-145（模型名大小写同口径）结案；两次自纠「净增行」 | progress/monthly/2026-10-9.md:10 |
| 2026-10-09 | T-102 结案：unionBbox 上收 types.ts + selftest 常驻断言（test:replay exit 0，判据可跑化） | progress/monthly/2026-10-9.md:11 |
| 2026-10-09 | T-107 结案：worldBox 并入多材质包围盒；差分量测把「块边长」降级为「初值」；另筛查 154 条缺口找出 36 孤儿 | progress/monthly/2026-10-9.md:12 |
| 2026-10-09 | T-167 结案（两处死阶段声明都删，16 锚点重编号）；T-118 重定性为冗余死 UI；普查出 27 条纯文字判据 | progress/monthly/2026-10-9.md:13 |
| 2026-10-09 | T-217（悬空 wasm_bindgen 删掉，29 锚点重编号）+ T-307（缺省地图路径修好，实跑 400 帧 204 FPS）；自纠三次门禁红灯 | progress/monthly/2026-10-9.md:14 |
| 2026-10-09 | 新造「文档标已消除但看板仍待修」探测器 ⇒ 逮到 T-021；四条子项核销后结案（③④本轮修 + CDP 探针复核） | progress/monthly/2026-10-9.md:15 |
| 2026-10-09 | T-213 结案（存点删除二次确认 + 越界告警，DOM 桩探针实测）；遗留探测器扩面后零命中（附「探针对了但接线错」的自我纠错） | progress/monthly/2026-10-9.md:16 |
| 2026-10-09 | 收束：D-026 批量遗弃 8 行（70→62）+ 推送前检查全绿（3 typecheck/3 wasm/2 dist/cargo 36/全部 app 检查/冒烟 0 FAIL） | progress/monthly/2026-10-9.md:17 |
| 2026-10-09 | 三端模型/光照分叉第 1 轮分析：viewer 缺实体放置模型（`entities` 恒空 ⇒ `buk01.mdl`/`cow.mdl` 缺失）+ 实体模型无烘焙光照 ⇒ 恒 fullbright + `s1_ramp1b` 条纹排除导出侧 + GLB 门禁盲区；登记 T-170/T-450/T-451/T-452/T-453 与 D-108 | progress/monthly/2026-10-10.md:6 |
| 2026-10-09 | owner 指令：渲染链三端彻底统一（T-454 任务书 + 8 阶段 + 唯一实现落点 + debug 白名单）；D-108 落定；看板逐行精简 95.5→83.2 KB | progress/monthly/2026-10-10.md:14 |
| 2026-10-09 | T-454 任务书独立审查（有条件可行）+ v2 修订：10 条 Must-fix 落地、纠正 1 条审查事实错误 | progress/monthly/2026-10-10.md:17 |
| 2026-10-09 | T-454 P0：三端出图比对仪器（`shot.mjs`/`diff.mjs`）+ 基线（`surf_boreas`，debug↔game ≤2 占比 99.980%、均值差 0.0029） | progress/monthly/2026-10-10.md:19 |
| 2026-10-09 | 超限分卷落地（TODO 95.9→44.3 KB、index 48.2→22.3 KB，新增 4 个分卷）+ 任务书 v3（P1–P8 逐阶段可执行清单 + 默认取值表 + D-108/D-109 决策清零） | progress/monthly/2026-10-10.md:21 |
| 2026-10-09 | T-454 P1：渲染呈现档收到唯一来源 `vbsp:renderPrefs`（`src/renderer-shared/config/render-prefs.ts`，三端同源；三端出图与 P0 基线逐像素相同） | progress/monthly/2026-10-10.md:23 |
| 2026-10-09 | T-454 P2：渲染器构造 + 预编译收口到 `src/renderer-shared/render/create-renderer.ts`（apps 内 `new THREE.WebGLRenderer`/输出链赋值/`renderer.compile` 全为 0；222 处锚点按内容校验后整体上移） | progress/monthly/2026-10-10.md:25 |
| 2026-10-09 | T-454 P3a：三端共享位姿入口 `camera/pose-entry.ts`（`globalThis.__vbspPose`，收编 T-443）；钉同一位姿后三端读数逐项相同（仅 `near` 分叉待 P3b），debug↔game 像素 100.000% 通道差 ≤2 | progress/monthly/2026-10-10.md:27 |
| 2026-10-09 | T-454 P3b-1：near/far/fov 与近平面收缩收口到 `src/renderer-shared/camera/scene-camera.ts`（viewer 取消 `CAMERA_INIT_FAR` 下限、取消 `vertical` 独有；三端 near 读数差从 13.5 HU 收到 ≤4e-4 HU） | progress/monthly/2026-10-10.md:29 |
| 2026-10-09 | T-454 P3b-2：装配核 `src/renderer-shared/scene/assemble-scene.ts` 收口三端装配序列（apps 内 `applyLightmap`/`extractSkyArea`/`padBoundingSpheres` 等 0 命中；统一「先主后天空」合并次序；顺手修掉本轮引入的 viewer 换图解构缺陷） | progress/monthly/2026-10-10.md:31 |
| 2026-10-09 | T-454 P4：可见性控制器 src/renderer-shared/scene/visibility-controller.ts（game 先接、行为中性：出图与 P3b-2 逐像素相同；天空层永不剔除） | progress/monthly/2026-10-10.md:33 |
| 2026-10-09 | T-454 P4b：viewer 接入共享可见性控制器（`scene/visibility-controller.ts`；declared delta `≤2 0.9685`/均值差 1.18）；规范会话下 debug↔game 100.000% 通道差 ≤2；新发现 debug 会话形态相关「偏亮模式」 | progress/monthly/2026-10-10.md:35 |
| 2026-10-09 | T-454 P4c：debug 距离判定接入共享 `isBeyondCullDistance`（同模式对比逐像素相同）；更正 debug 双模式刻画为「**每次会话随机落进两个确定性模式之一**」（规范 173.67 / 偏亮 176.75） | progress/monthly/2026-10-10.md:37 |
| 2026-10-09 | T-454 诊断：debug 双模式差异**只在天区**（差异像素 11.85%，包围盒 x∈[211,1279] y∈[0,215]，比值 p95 1.129；世界几何/光照逐像素相同）⇒ 天区装配的加载期竞态 | progress/monthly/2026-10-10.md:39 |
| 2026-10-09 | T-454 P5-1：viewer 导出面补齐 `mosaic_decode`（EOF 追加纯 Rust 转发，锚点零漂移；d.ts 三端齐备 + `initSync` 运行时验证转发生效；`src/wasm-core` 仍 0 处 wasm_bindgen） | progress/monthly/2026-10-10.md:41 |
| 2026-10-09 | T-454 P5-3：viewer 补齐 `mosaic_encode`（mosaic 导出对完备，运行时双验证）；P5-2 调查收敛为「viewer 导出链确实收 static_props ⇒ 原 props 缺失结论需按当前代码重新取证」 | progress/monthly/2026-10-10.md:43 |
| 2026-10-09 | T-454 P5-2：viewer 实体放置模型接通（**两处**根因：`entities: Vec::new()` + 被引用模型集合未并入实体 `model`）；GLB 数据级对齐 debug/game（boreas +3.7MB/`buk01.mdl` 0→1、surf_666 `cow.mdl` 0→1），测试视点出图逐像素不变 | progress/monthly/2026-10-10.md:45 |
| 2026-10-09 | 滚动分卷：新开 progress/monthly/2026-10-11.md（第 11/11 卷，承接 T-454 续写；上一卷 40.77 KB 封卷）并改指「当前写入目标」 | progress/monthly/2026-10-11.md:1 |
| 2026-10-09 | T-454 会话交接：P0–P5-2 已落地（12 个提交未 push），交接清单入 .tmp/task-unify-render/TASK-handoff.md（剩余 P5-2 尾/P6/P7/P8 + 纪律与坑） | progress/monthly/2026-10-11.md:11 |
| 2026-10-09 | T-454 收尾验收通过：三端 12 个 `.cmd` 静态契约 12/12 + `build.cmd` 实跑 exit 0 + 9 个测试门 exit 0 + 自选端口验 web/dist 均 HTTP 200；页面内载入 `surf_boreas`/`surf_666` 三端 6/6 就绪（附：曾误在主机跑 dev.cmd 拉窗口/浏览器，已清理并改沙箱内验证） | progress/monthly/2026-10-11.md:13 |
| 2026-10-09 | T-454 验收第二轮：start.cmd 服务段三端实跑（debug/game 走 src/serve.py、viewer 走 dist/play.cmd 的 dist/serve.py）+ stop.cmd 两分支实跑（只杀本工程 python、外来 PID 跳过）+ dist 页面三端载图 6/6 + dev 路径重载 6/6；修 debug single 形态 dist 悬空 `./coi-serviceworker.js`（静态托管恢复 crossOriginIsolated）；登记 T-628 / D-110 | progress/monthly/2026-10-11.md:26 |
| 2026-10-09 | T-454 验收三轮：`build.cmd multi` 端到端 exit 0（含 wasm-pack stderr 造成假 exit 1 的 pwsh 陷阱）+ 三端 multi dist（部署形态）载图 6/6 + game/viewer `stop.cmd` 实跑 + `start.cmd` 三条守卫（端口被占 / 自定义端口 / 缺 dist，均不开浏览器）；恢复三端 single dist；新登记 T-171（viewer multi 随包 SW 但页面从不加载） | progress/monthly/2026-10-11.md:36 |
