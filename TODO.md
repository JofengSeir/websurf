# 待办看板（TODO Board）

> **唯一事实来源**：所有待裁决 / 待修 / 已取证待立项 / 进行中事项的**状态只在本页登记**。
> 其余文档只写技术事实，不复述状态；代码注释只允许写「见 TODO.md T-###」。
> 规则：一行一条；ID 永不复用；结案保留 ID；**改代码或裁决的同一提交必须更新对应行**。

## 状态口径

| 状态 | 含义 |
|---|---|
| 待裁决 | 修法有分歧，或改动会动到行为契约，需要 owner 定 |
| 待修 | 修法明确、改动局部，可直接排期 |
| 已取证待立项 | 根因清楚但工作量超出一次改动，需要单独任务书 |
| 进行中 | 已开工，尚未收口 |
| 已记录 | 已知事实 / 工具边界，无需行动，仅备查 |
| 已结案 | 已按结论改完，或已判定无需行动 |

## 未结项（41 条）

### 待裁决（39）

- **T-003** 旧 AGENTS.md 的通用工程规范（文件归属 / 临时区 / 产物 / 文档格式）未在本文件复述 —— 重编期间以任务书为准　`docs`
- **T-005** apps/game 的 favicon.ico 被同一批删除波及：该文件在库中唯一，而 apps/game/web/index.html…　`game`
- **T-007** apps/debug/src/wasm.d.ts:67-119 的 PhysWorld 类型落后源码 7 个方法（缺 tick_into…　`debug`
- **T-008** apps/game/scripts/check-wasm-api.mjs:52-70 的 PHYS_API 只列 17 项，缺 new …　`game`
- **T-013** lightmap.rs 错误串含外部实现引用 Lightmap.cs:64　`shared`
- **T-015** vbsp/data/entity.rs 6 条（含 start_disabled 恒 false 的跨工程实锤）　`shared`
- **T-016** compute-mode.ts 的 summary 字面量含已删文档编号　`shared`
- **T-018** tick-authority.test.ts 断言标签含 Q1 / §8.5　`shared`
- **T-020** 旧文档篇数口径对撞（68 篇 vs 实测 56 篇）　`docs`
- **T-021** game 面板 4 条（γ 量程 vs 接受窗口 / 数值框不回写 / 死变量 / 默认 γ=2.2 被忽略）　`game`
- **T-023** check-wasm-api.mjs 输出标签 F4 无出处　`game`
- **T-024** game 类型面/配置面 3 条（worker-types.ts 落后实际载荷等）　`game`
- **T-025** viewer timeline.ts 的 title 文案与 prerun 负段口径矛盾　`viewer`
- **T-026** viewer 死支路 4 条（A-B 区间带恒不显示 / 零调用点 / 混基宽度）　`viewer`
- **T-027** viewer core + ui 9 条（含 ensureWasm 永久缓存失败）　`viewer`
- **T-028** viewer replay/ 10 条（含 GPU 资源不释放、blob URL 泄漏）　`viewer`
- **T-029** debug 脚本 10 条（jump-apex 采样链链路级仍待裁决　`debug`
- **T-030** viewer crates/wasm 6 条（.MDL 三件套替换隐患等）　`viewer`
- **T-031** game phys-rate-parity 4 条（混合分区时长/结果、flatTop AABB）　`game`
- **T-032** game 脚本 11 件 7 条（_dbg_floor 的 onGround 恒 undefined 等）　`game`
- **T-033** WG6b 6 条（test/maps/surf_null_4.replay 跨 3 文件失效等）　`repo`
- **T-035** input-replay-verify.mjs 5 条（inputRecorder 永不落样本、f.dt 字段不存在、页面缺 7 个 i…　`debug`
- **T-036** WG5b 末批 15 条（死常量/死判据/不可达分支/404 的 coi-serviceworker.js 等）　`repo`
- **T-038** 9 个 .cmd 的 5 条遗留（viewer start.cmd 守卫与 dist/play.cmd 等）　`repo`
- **T-039** 依赖表「本 crate 无引用点」清单（两法一致：源码引用面扫描 + cargo check 的 -W unused-crate-dep…　`repo`
- **T-046** debug / game 的 RendererMain.getLightingMode() 零调用点：debug 与 game 各有一份…　`debug`
- **T-047** game RendererMain.resetTo() 与 stop() 零调用点：start() 由 apps/game/src/ap…　`debug`
- **T-048** worker 消息联合类型与实际收发不符（历史遗留，已由文档记录）：debug/game 的 worker-types.ts 里 rea…　`debug`
- **T-053** viewer P1×3 + P2 批（同轮审查登记）：P1——帮助文案「淡金带 / 金框」与区间带现行灰白斜纹 / 白框不符（apps/…　`viewer`
- **T-054** debug 审查登记（P1×4 + P2×9）：P1——全局 :focus-visible 与 ::selection 规则整体缺失（g…　`debug`
- **T-055** game 审查登记（P1×3 + P2×9）：P1——导航 .mod 与 .key-chip/.x 是无 tabindex 的 div（…　`game`
- **T-056** 多轮对话遗留待办合并（owner 逐轮提出、未裁决）：① 关闭确认已上线但 F5 / 刷新同样弹框，若嫌烦改条件化（仅在有地图 / 对局…　`game`
- **T-058** DemoParseResult 里「已解码但应用面为零」的字段清单（owner 要求记录，2026-09-30　`viewer`
- **T-060** .dem 玩家输入可得性重审（owner 质疑「表示无法获取玩家的输入，但实际上应该可以」，2026-10-01　`viewer`
- **T-062** 本轮入口收敛的两条留档待裁（2026-10-01）：① importer.ts 的 Source .dem 分支在 UI 层已无调用路径…　`viewer`
- **T-064** 8 篇 debug 文档存在「在界内但内容偏旧」的锚点簇（2026-10-03 本轮量化，未改）：src/scripts/check-d…　`docs`
- **T-066** .phy 凸包表达不了曲面坡（documents/open-issues/06 §3.3 / §7.4 的遗留）：s1_ramp1b 实…　`shared`
- **T-067** 修好卡死后暴露的两 tick 跳变（成因未定位）：修法 A 生效后，玩家在 surf_666 的 s1_ramp1b 上从 owner …　`shared`
- **T-068** AGENTS.md 是全仓最大的文本文件，本轮起已超过 234 KB（301 行、最长单行 4031 字符 —— §7.1 的进度行本身…　`docs`

### 待修（2）

- **T-040** debug renderer-main.ts optimizeScene 调用链注释「其又源自 harness worker-b」与 g…　`debug`
- **T-065** check_stuck 探测盒前探 16 HU 戳进前方上翘的坡 ⇒ 误报卡死　`shared`

> 另有 已记录 15 条、已结案 12 条见下表（保留 ID 供追溯，编号不复用）。

## 总表（68 条）

| ID | 事项 | 类型 | 归属 | 状态 | 证据 | 详情 | 原号 |
|---|---|---|---|---|---|---|---|
| T-001 | 根 README 已删除，仓库暂无 README | 文档口径 | docs | 已结案 | — | progress/pending-detail.md | #1 |
| T-002 | 导航 index 已删除 | 文档口径 | docs | 已结案 | — | progress/pending-detail.md | #2 |
| T-003 | 旧 AGENTS.md 的通用工程规范（文件归属 / 临时区 / 产物 / 文档格式）未在本文件复述 —— 重编期间以任务书为准 | 文档口径 | docs | 待裁决 | — | progress/pending-detail.md | #3 |
| T-004 | CI 与共享脚本仍引用已退役的 harness | 配置·门禁 | repo | 已结案 | — | progress/pending-detail.md | #4 |
| T-005 | apps/game 的 favicon.ico 被同一批删除波及：该文件在库中唯一，而 apps/game/web/index.html… | 缺陷 | game | 待裁决 | — | progress/pending-detail.md | #5 |
| T-006 | 零分配支路已实现但未接线：tick_into / state_out_ptr / seed_from 只被 src/ts-shared/… | 未接线·死代码 | shared | 已记录 | — | progress/pending-detail.md | #7 |
| T-007 | apps/debug/src/wasm.d.ts:67-119 的 PhysWorld 类型落后源码 7 个方法（缺 tick_into… | 缺陷 | debug | 待裁决 | apps/debug/src/wasm.d.ts:67-119 | progress/pending-detail.md | #8 |
| T-008 | apps/game/scripts/check-wasm-api.mjs:52-70 的 PHYS_API 只列 17 项，缺 new … | 配置·门禁 | game | 待裁决 | apps/game/scripts/check-wasm-api.mjs:52-70 | progress/pending-detail.md | #9 |
| T-009 | set_yaw_pitch 在 apps/ 与 src/ 内零调用点 | 未接线·死代码 | shared | 已记录 | — | progress/pending-detail.md | #10 |
| T-010 | teleport_gate_ticks 参数链已死：set_params 的 JSON 键可写、player.rs 有该字段（默认 3）… | 未接线·死代码 | shared | 已记录 | — | progress/pending-detail.md | #11 |
| T-011 | BSP 导出未把 KHR_texture_transform 登记进 extensionsUsed | 缺陷 | shared | 已记录 | — | progress/pending-detail.md | #26 |
| T-012 | vtf.rs 4 条读写不一致 + 5 处死代码 | 未接线·死代码 | shared | 已记录 | — | progress/pending-detail.md | #27 |
| T-013 | lightmap.rs 错误串含外部实现引用 Lightmap.cs:64 | 缺陷 | shared | 待裁决 | — | progress/pending-detail.md | #28 |
| T-014 | mosaic/mtz.rs 8 条编解码不一致 | 缺陷 | shared | 已记录 | — | progress/pending-detail.md | #30 |
| T-015 | vbsp/data/entity.rs 6 条（含 start_disabled 恒 false 的跨工程实锤） | 缺陷 | shared | 待裁决 | — | progress/pending-detail.md | #31 |
| T-016 | compute-mode.ts 的 summary 字面量含已删文档编号 | 文档口径 | shared | 待裁决 | — | progress/pending-detail.md | #36 |
| T-017 | jump-apex-verify.mjs 内嵌「修复前行为」复刻 | 配置·门禁 | debug | 已记录 | — | progress/pending-detail.md | #38 |
| T-018 | tick-authority.test.ts 断言标签含 Q1 / §8.5 | 缺陷 | shared | 待裁决 | — | progress/pending-detail.md | #40 |
| T-019 | owner 指令：子代理并发 ≤3（含 19 并发被掐断的复盘） | 工具·流程 | repo | 已记录 | — | progress/pending-detail.md | #41 |
| T-020 | 旧文档篇数口径对撞（68 篇 vs 实测 56 篇） | 文档口径 | docs | 待裁决 | — | progress/pending-detail.md | #43 |
| T-021 | game 面板 4 条（γ 量程 vs 接受窗口 / 数值框不回写 / 死变量 / 默认 γ=2.2 被忽略） | 缺陷 | game | 待裁决 | — | progress/pending-detail.md | #50 |
| T-022 | 规范篇里的禁用词是「引用对象」（全仓唯一允许出现处） | 文档口径 | docs | 已记录 | — | progress/pending-detail.md | #51 |
| T-023 | check-wasm-api.mjs 输出标签 F4 无出处 | 配置·门禁 | game | 待裁决 | — | progress/pending-detail.md | #52 |
| T-024 | game 类型面/配置面 3 条（worker-types.ts 落后实际载荷等） | 缺陷 | game | 待裁决 | — | progress/pending-detail.md | #53 |
| T-025 | viewer timeline.ts 的 title 文案与 prerun 负段口径矛盾 | 文档口径 | viewer | 待裁决 | — | progress/pending-detail.md | #54 |
| T-026 | viewer 死支路 4 条（A-B 区间带恒不显示 / 零调用点 / 混基宽度） | 未接线·死代码 | viewer | 待裁决 | — | progress/pending-detail.md | #55 |
| T-027 | viewer core + ui 9 条（含 ensureWasm 永久缓存失败） | 缺陷 | viewer | 待裁决 | — | progress/pending-detail.md | #58 |
| T-028 | viewer replay/ 10 条（含 GPU 资源不释放、blob URL 泄漏） | 缺陷 | viewer | 待裁决 | — | progress/pending-detail.md | #59 |
| T-029 | debug 脚本 10 条（jump-apex 采样链链路级仍待裁决 | 配置·门禁 | debug | 待裁决 | — | progress/pending-detail.md | #60 |
| T-030 | viewer crates/wasm 6 条（.MDL 三件套替换隐患等） | 缺陷 | viewer | 待裁决 | — | progress/pending-detail.md | #61 |
| T-031 | game phys-rate-parity 4 条（混合分区时长/结果、flatTop AABB） | 缺陷 | game | 待裁决 | — | progress/pending-detail.md | #62 |
| T-032 | game 脚本 11 件 7 条（_dbg_floor 的 onGround 恒 undefined 等） | 配置·门禁 | game | 待裁决 | — | progress/pending-detail.md | #63 |
| T-033 | WG6b 6 条（test/maps/surf_null_4.replay 跨 3 文件失效等） | 缺陷 | repo | 待裁决 | — | progress/pending-detail.md | #64 |
| T-034 | 范围盘点（coverage-scan）+ 配置面口径冲突（已结案）：件数实测更正为 9 Cargo.toml / 5 .gitignor… | 配置·门禁 | repo | 已结案 | — | progress/pending-detail.md | #65 |
| T-035 | input-replay-verify.mjs 5 条（inputRecorder 永不落样本、f.dt 字段不存在、页面缺 7 个 i… | 缺陷 | debug | 待裁决 | — | progress/pending-detail.md | #66 |
| T-036 | WG5b 末批 15 条（死常量/死判据/不可达分支/404 的 coi-serviceworker.js 等） | 未接线·死代码 | repo | 待裁决 | — | progress/pending-detail.md | #67 |
| T-037 | WG12 src/ 侧 10 条（check-shared-sync 门禁恒失败已于本轮处置：退役路径出清单后四项子检查全过 | 配置·门禁 | shared | 已结案 | — | progress/pending-detail.md | #68 |
| T-038 | 9 个 .cmd 的 5 条遗留（viewer start.cmd 守卫与 dist/play.cmd 等） | 配置·门禁 | repo | 待裁决 | — | progress/pending-detail.md | #69 |
| T-039 | 依赖表「本 crate 无引用点」清单（两法一致：源码引用面扫描 + cargo check 的 -W unused-crate-dep… | 配置·门禁 | repo | 待裁决 | — | progress/pending-detail.md | #70 |
| T-040 | debug renderer-main.ts optimizeScene 调用链注释「其又源自 harness worker-b」与 g… | 缺陷 | debug | 待修 | — | progress/pending-detail.md | #71 |
| T-041 | debug 输入录制/回放面板整组控件不存在 | 配置·门禁 | debug | 已结案 | — | progress/pending-detail.md | #72 |
| T-042 | debug 路径可见开关不存在 | 缺陷 | debug | 已结案 | — | progress/pending-detail.md | #73 |
| T-043 | debug PVS 开关双断 | 缺陷 | debug | 已结案 | — | progress/pending-detail.md | #74 |
| T-044 | debug 四个配置字段纯死 | 未接线·死代码 | debug | 已结案 | — | progress/pending-detail.md | #75 |
| T-045 | game pitchLimit 死字段 | 未接线·死代码 | game | 已结案 | — | progress/pending-detail.md | #76 |
| T-046 | debug / game 的 RendererMain.getLightingMode() 零调用点：debug 与 game 各有一份… | 未接线·死代码 | debug | 待裁决 | — | progress/pending-detail.md | #78 |
| T-047 | game RendererMain.resetTo() 与 stop() 零调用点：start() 由 apps/game/src/ap… | 未接线·死代码 | debug | 待裁决 | apps/game/src/app.ts:170 | progress/pending-detail.md | #79 |
| T-048 | worker 消息联合类型与实际收发不符（历史遗留，已由文档记录）：debug/game 的 worker-types.ts 里 rea… | 文档口径 | debug | 待裁决 | — | progress/pending-detail.md | #80 |
| T-049 | v5 面板绑定审计：命中全为间接下发（非缺陷）：apps/game/src/panel/panel-controller.ts 有 11… | 工具·流程 | game | 已记录 | apps/game/src/app.ts:193-197 | progress/pending-detail.md | #82 |
| T-050 | v4 审计工具边界（留档）：.tmp/audit/page-chain-audit4.mjs 会误报两类 —— ① 动态生成的 clas… | 工具·流程 | game | 已记录 | — | progress/pending-detail.md | #81 |
| T-051 | 审计脚本的口径边界（留档）：.tmp/audit/page-chain-audit3.mjs 的 id 提取不覆盖 qs<T>('x')… | 工具·流程 | repo | 已记录 | apps/viewer/src/app.ts:71 | progress/pending-detail.md | #77 |
| T-052 | viewer 三条 P0 接线缺陷（① 拖拽 .dem ② 遥测 HUD 常隐 ③ 记录 tab 回位）—— ①②③ 均已在后续轮处置 | 缺陷 | viewer | 已结案 | apps/viewer/src/ui/telemetry.ts:102 | progress/pending-detail.md | #83 |
| T-053 | viewer P1×3 + P2 批（同轮审查登记）：P1——帮助文案「淡金带 / 金框」与区间带现行灰白斜纹 / 白框不符（apps/… | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/timeline.ts:110 | progress/pending-detail.md | #84 |
| T-054 | debug 审查登记（P1×4 + P2×9）：P1——全局 :focus-visible 与 ::selection 规则整体缺失（g… | 缺陷 | debug | 待裁决 | apps/debug/src/app.ts:1992 | progress/pending-detail.md | #85 |
| T-055 | game 审查登记（P1×3 + P2×9）：P1——导航 .mod 与 .key-chip/.x 是无 tabindex 的 div（… | 缺陷 | game | 待裁决 | — | progress/pending-detail.md | #86 |
| T-056 | 多轮对话遗留待办合并（owner 逐轮提出、未裁决）：① 关闭确认已上线但 F5 / 刷新同样弹框，若嫌烦改条件化（仅在有地图 / 对局… | 缺陷 | game | 待裁决 | — | progress/pending-detail.md | #87 |
| T-057 | viewer 录像（.dem）按键可视化（Key Overlay）—— 拟以「反推」实现，本轮只登记不动手（owner 提出，2026-… | 未接线·死代码 | viewer | 已记录 | — | progress/pending-detail.md | #88 |
| T-058 | DemoParseResult 里「已解码但应用面为零」的字段清单（owner 要求记录，2026-09-30 | 未接线·死代码 | viewer | 待裁决 | — | progress/pending-detail.md | #89 |
| T-059 | 录像「对话」只能显示服务端文本，玩家聊天看不到（本轮新增分节的边界，2026-09-30）：已在录像 tab 加第三节「对话」并接上 c… | 缺陷 | viewer | 已记录 | — | progress/pending-detail.md | #90 |
| T-060 | .dem 玩家输入可得性重审（owner 质疑「表示无法获取玩家的输入，但实际上应该可以」，2026-10-01 | 缺陷 | viewer | 待裁决 | — | progress/pending-detail.md | #91 |
| T-061 | 真实 .dem 夹具首扫（test/replay/auto-20261001-050330-surf_gigapede.dem，11.8… | 工具·流程 | viewer | 已记录 | — | progress/pending-detail.md | #92 |
| T-062 | 本轮入口收敛的两条留档待裁（2026-10-01）：① importer.ts 的 Source .dem 分支在 UI 层已无调用路径… | 未接线·死代码 | viewer | 待裁决 | apps/viewer/src/replay/panel.ts:283 | progress/pending-detail.md | #93 |
| T-063 | .dem 实体流：只有 1 个玩家实体采到位姿 | 缺陷 | viewer | 已结案 | — | progress/pending-detail.md | #94 |
| T-064 | 8 篇 debug 文档存在「在界内但内容偏旧」的锚点簇（2026-10-03 本轮量化，未改）：src/scripts/check-d… | 文档口径 | docs | 待裁决 | apps/debug/src/worker/main.ts:483 | progress/pending-detail.md | #95 |
| T-065 | check_stuck 探测盒前探 16 HU 戳进前方上翘的坡 ⇒ 误报卡死 | 缺陷 | shared | 待修 | — | progress/pending-detail.md | #96 |
| T-066 | .phy 凸包表达不了曲面坡（documents/open-issues/06 §3.3 / §7.4 的遗留）：s1_ramp1b 实… | 缺陷 | shared | 待裁决 | — | progress/pending-detail.md | #97 |
| T-067 | 修好卡死后暴露的两 tick 跳变（成因未定位）：修法 A 生效后，玩家在 surf_666 的 s1_ramp1b 上从 owner … | 缺陷 | shared | 待裁决 | — | progress/pending-detail.md | #98 |
| T-068 | AGENTS.md 是全仓最大的文本文件，本轮起已超过 234 KB（301 行、最长单行 4031 字符 —— §7.1 的进度行本身… | 文档口径 | docs | 待裁决 | — | progress/pending-detail.md | #99 |
