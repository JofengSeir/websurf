# 看板分卷：已记录 + 已结案（40 条）

> **性质**：过程存档，不作事实来源。这些行原在根 `TODO.md`，因看板体量接近头注阈值（80 KB / 300 条）而按既定规则分卷到此。

> **ID 与状态保留**供追溯；**编号不复用**——新条目取号时要连同本页一起数，见 `TODO.md` 头注「下一可用号」。

> **未结项永不分卷**：任何 `待裁决 / 待修 / 已取证待立项 / 进行中 / 阻塞` 的行都只在 `TODO.md`。

## 总表（40 条）

| ID | 事项 | 类型 | 归属 | 状态 | 证据 | 详情 | 判据 | 原号 |
|---|---|---|---|---|---|---|---|---|
| T-001 | 根 README 已删除，仓库暂无 README | 文档口径 | docs | 已结案 | — | progress/pending-detail.md | — | #1 |
| T-002 | 导航 index 已删除 | 文档口径 | docs | 已结案 | — | progress/pending-detail.md | — | #2 |
| T-003 | 旧 AGENTS.md 的通用工程规范（文件归属 / 临时区 / 产物 / 文档格式）未在本文件复述 —— 重编期间以任务书为准 | 文档口径 | docs | 已结案 | AGENTS.md:21 | progress/pending-detail.md | — | #3 |
| T-004 | CI 与共享脚本仍引用已退役的 harness | 配置·门禁 | repo | 已结案 | — | progress/pending-detail.md | — | #4 |
| T-006 | 零分配支路已实现但未接线：tick_into / state_out_ptr / seed_from 只被 src/ts-shared/… | 未接线·死代码 | shared | 已记录 | — | progress/pending-detail.md | — | #7 |
| T-009 | set_yaw_pitch 在 apps/ 与 src/ 内零调用点 | 未接线·死代码 | shared | 已记录 | — | progress/pending-detail.md | — | #10 |
| T-010 | teleport_gate_ticks 参数链已死：set_params 的 JSON 键可写、player.rs 有该字段（默认 3）… | 未接线·死代码 | shared | 已记录 | — | progress/pending-detail.md | — | #11 |
| T-011 | BSP 导出未把 KHR_texture_transform 登记进 extensionsUsed | 缺陷 | shared | 已记录 | — | progress/pending-detail.md | — | #26 |
| T-012 | vtf.rs 4 条读写不一致 + 5 处死代码 | 未接线·死代码 | shared | 已记录 | — | progress/pending-detail.md | — | #27 |
| T-014 | mosaic/mtz.rs 8 条编解码不一致 | 缺陷 | shared | 已记录 | — | progress/pending-detail.md | — | #30 |
| T-017 | jump-apex-verify.mjs 内嵌「修复前行为」复刻 | 配置·门禁 | debug | 已记录 | — | progress/pending-detail.md | — | #38 |
| T-019 | owner 指令：子代理并发 ≤3（含 19 并发被掐断的复盘） | 工具·流程 | repo | 已记录 | — | progress/pending-detail.md | — | #41 |
| T-020 | 旧文档篇数口径对撞（68 篇 vs 实测 56 篇） | 文档口径 | docs | 已结案 | documents/index.md:3 | progress/pending-detail.md | — | #43 |
| T-022 | 规范篇里的禁用词是「引用对象」（全仓唯一允许出现处） | 文档口径 | docs | 已记录 | — | progress/pending-detail.md | — | #51 |
| T-025 | 【台账号·已细化】→ T-119 viewer timeline.ts 的 title 文案与 prerun 负段口径矛盾 | 文档口径 | viewer | 已记录 | — | progress/pending-detail.md | — | #54 |
| T-026 | 【台账号·已细化】→ T-118、T-120 viewer 死支路 4 条（A-B 区间带恒不显示 / 零调用点 / 混基宽度） | 未接线·死代码 | viewer | 已记录 | — | progress/pending-detail.md | — | #55 |
| T-027 | 【台账号·已细化】→ T-104..T-108、T-138..T-143 viewer core + ui 9 条（含 ensureWasm 永久缓存失败） | 缺陷 | viewer | 已记录 | — | progress/pending-detail.md | — | #58 |
| T-028 | 【台账号·已细化】→ T-121..T-123 viewer replay/ 10 条（含 GPU 资源不释放、blob URL 泄漏） | 缺陷 | viewer | 已记录 | — | progress/pending-detail.md | — | #59 |
| T-030 | 【台账号·已细化】→ T-144..T-151 viewer crates/wasm 6 条（.MDL 三件套替换隐患等） | 缺陷 | viewer | 已记录 | — | progress/pending-detail.md | — | #61 |
| T-034 | 范围盘点（coverage-scan）+ 配置面口径冲突（已结案）：件数实测更正为 9 Cargo.toml / 5 .gitignor… | 配置·门禁 | repo | 已结案 | — | progress/pending-detail.md | — | #65 |
| T-037 | WG12 src/ 侧 10 条（check-shared-sync 门禁恒失败已于本轮处置：退役路径出清单后四项子检查全过 | 配置·门禁 | shared | 已结案 | — | progress/pending-detail.md | — | #68 |
| T-041 | debug 输入录制/回放面板整组控件不存在 | 配置·门禁 | debug | 已结案 | — | progress/pending-detail.md | — | #72 |
| T-042 | debug 路径可见开关不存在 | 缺陷 | debug | 已结案 | — | progress/pending-detail.md | — | #73 |
| T-043 | debug PVS 开关双断 | 缺陷 | debug | 已结案 | — | progress/pending-detail.md | — | #74 |
| T-044 | debug 四个配置字段纯死 | 未接线·死代码 | debug | 已结案 | — | progress/pending-detail.md | — | #75 |
| T-045 | game pitchLimit 死字段 | 未接线·死代码 | game | 已结案 | — | progress/pending-detail.md | — | #76 |
| T-049 | v5 面板绑定审计：命中全为间接下发（非缺陷）：apps/game/src/panel/panel-controller.ts 有 11… | 工具·流程 | game | 已记录 | apps/game/src/app.ts:193-197 | progress/pending-detail.md | — | #82 |
| T-050 | v4 审计工具边界（留档）：.tmp/audit/page-chain-audit4.mjs 会误报两类 —— ① 动态生成的 clas… | 工具·流程 | game | 已记录 | — | progress/pending-detail.md | — | #81 |
| T-051 | 审计脚本的口径边界（留档）：.tmp/audit/page-chain-audit3.mjs 的 id 提取不覆盖 qs<T>('x')… | 工具·流程 | repo | 已记录 | apps/viewer/src/app.ts:71 | progress/pending-detail.md | — | #77 |
| T-052 | viewer 三条 P0 接线缺陷（① 拖拽 .dem ② 遥测 HUD 常隐 ③ 记录 tab 回位）—— ①②③ 均已在后续轮处置 | 缺陷 | viewer | 已结案 | apps/viewer/src/ui/telemetry.ts:102 | progress/pending-detail.md | — | #83 |
| T-057 | viewer 录像（.dem）按键可视化（Key Overlay）—— 拟以「反推」实现，本轮只登记不动手（owner 提出，2026-… | 未接线·死代码 | viewer | 已记录 | — | progress/pending-detail.md | — | #88 |
| T-059 | 录像「对话」只能显示服务端文本，玩家聊天看不到（本轮新增分节的边界，2026-09-30）：已在录像 tab 加第三节「对话」并接上 c… | 缺陷 | viewer | 已记录 | — | progress/pending-detail.md | — | #90 |
| T-061 | 真实 .dem 夹具首扫（test/replay/auto-20261001-050330-surf_gigapede.dem，11.8… | 工具·流程 | viewer | 已记录 | — | progress/pending-detail.md | — | #92 |
| T-063 | .dem 实体流：只有 1 个玩家实体采到位姿 | 缺陷 | viewer | 已结案 | — | progress/pending-detail.md | — | #94 |
| T-065 | check_stuck 探测盒前探 16 HU 戳进前方上翘的坡 ⇒ 误报卡死 | 缺陷 | shared | 已结案 | src/phys/player.rs:1400 | progress/open-issues/07-is-position-free-vs-trace.md | — | #96 |
| T-068 | AGENTS.md 是全仓最大的文本文件，本轮起已超过 234 KB（301 行、最长单行 4031 字符 —— §7.1 的进度行本身… | 文档口径 | docs | 已结案 | AGENTS.md:1 | progress/pending-detail.md | — | #99 |
| T-221 | `phys-p2-regression.mjs` 的 `ALL PASS` 分支在当前产物下不可达（本地脚本未入库） | 工具·流程 | game | 已记录 | — | documents/game/implementation/scripts.md | — | — |
| T-501 | debug 的 chamfer 平面削减体积为零却决定地面法线 ⇒ 坡顶站不住 / 被弹飞 | 缺陷 | debug | 已结案 | — | progress/open-issues/01-chamfer-is-not-a-bevel.md | — | 原 01 |
| T-502 | chamfer 黄线框靠重新猜平面得到，与物理侧平面表不是同一套判据 | 缺陷 | debug | 已结案 | — | progress/open-issues/02-chamfer-visualization-guesswork.md | — | 原 02 |
| T-505 | src/wasm-core 侧 bevel / brushes 无消费者，注释却称导出层会用 | 文档口径 | shared | 已结案 | — | progress/open-issues/05-wasmcore-bevel-doc-vs-code.md | — | 原 05 |
