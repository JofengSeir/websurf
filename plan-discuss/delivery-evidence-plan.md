# 最终交付门 · 取证清单预置（captain · t9/t10 后执行）

> 交付门 = `delivery_check(file, url?, evidence, …)`，**全部 PASS 才允许宣告完成**。
> 本文件在 t9 终审通过、t10 文档同步后作为执行清单；数字以当轮新鲜复跑为准。

## 1. 交付物定位（file 参数候选）

| 候选 | 路径 | 说明 |
|---|---|---|
| 主交付叙事 | `plan/gate2-report.md` | Gate 2 验签报告（t7 产出，t9 复核） |
| 设计/裁决基线 | `plan-discuss/plan-v2.md`、`plan-discuss/t6-render-ahead-stance.md`、`plan-discuss/t4-acceptance-memo.md` | 第一关口定案 |
| 实现面锚点 | `src/ts-shared/auth/tick-authority.ts`（t4 核心）、`src/phys/seed.rs`（种子面） | 代码交付本体 |
| 补充事实表 | `plan/field-fidelity.md`（t1）、`plan-discuss/checkpoint2-grill-brief.md`（第二关口） | — |

> 决策：**file = `plan/gate2-report.md`**（汇聚实现→验证→验收链的主文档）；若该文件届时未定稿，改用 `plan-discuss/checkpoint2-grill-brief.md`。

## 2. evidence items（kind 分列）

| # | kind | label | target / result | reviewed |
|---|---|---|---|---|
| 1 | file | Gate 2 报告（主交付叙事） | `plan/gate2-report.md`（496 行：§1 阻断断言 B1-B7 13/13 + §2 数据面 div 三列/D10 4-6/DIA/TEL + §3 判定口径 §3⅕ δ 双口径·§3⅙ 判读规则 + 附 A 台架缺陷纠正 C1-C7 + 人工审定面） | — |
| 2 | file | 事实表 t1 | `plan/field-fidelity.md`（22 样本 · 三活性缺口 · 10 项死位；wasm pin 已升 `ee4c1ab3`） | — |
| 3 | file | P0/R6 声明件（t9 唯一磁盘验签面） | `temp/phys-plan-discuss/t4-p0-boundary-and-r6-declaration.md`（38 处编号表 + 出处三分 6/8/24 + 探针局限下限证据口径 + 转换路径级盲区 + R6 闭环） | — |
| 4 | test | 六套单测 **309** 断言 | tick-authority 19 / t4-chain 10 / ordering-gate 46 / compute-mode 45 / shared-state.protocol 75 / tick-consumer 114 —— 全绿 exit 0（当轮新鲜 bundle） | — |
| 5 | test | 台架 smoke / 矩阵 / Gate 2 | `node temp/phys-bench/smoke.mjs` **63/63** · `run-matrix.mjs` **344 格 0 错误**（M-A 180 + M-B 144 + M-C 20）+ M-E 648+972 · `gate2.mjs` **14/14，阻断 13/13，结论=达标** | — |
| 6 | run | 构建与类型门 | `cd game && npm run build:ts` exit 0；`npx tsc --noEmit -p tsconfig.json` exit 0 | — |
| 7 | run | 端到端一键复跑 | `temp/gatekeeper-f/gate2-rerun.sh`（六套件 + 三探针，**15/15 全绿 exit 0**）+ F1 双档（默认 exit 0 / `F1_LEGACY=1` exit 2 存档） | — |
| 8 | text | wasm pin 与种子面 | pin `ee4c1ab3…4690`（3710792B，双端一致，`game/temp/wasm-hash-pin.json`）；`phys-seed-smoke` 7 组通过；field-discovery v2 与 t1 逐项一致；`t7/preflight.mjs` 5/5（含历史规范件 sha） | — |
| 9 | text | 关键裁定与残余风险 | 第二关口裁定（Q1 齐格语义/Q2 5.0% 残差/Q3 地图/Q4 臂范围/Q5 flip P99 逃逸处置）+ t9 残余风险 RK1–RK11 + 校验器 glob bug 与流程缺口（终报用） | — |
| 10 | file | 第二关口材料 | `plan-discuss/checkpoint2-grill-brief.md`（D10/DIA/S5 双桶/空覆盖战绩/C5 三态/物证清单/五问） | — |
| 11 | file | 交付取证与口径 | `plan-discuss/delivery-evidence-plan.md`（本文）、`temp/phys-plan-discuss/handover-brief.md`（团队交接简报） | — |

**关键实测口径（终报引用）**：D10 六格 **4/6**（COUPLED×T3 经载体迁移+判据 B「幻影阻挡」sweep fraction=1.000 翻绿；两未复现格附结构归因）；div 双桶 **bulk 独立硬违例=0**（三列口径）；flip 桶 22 例（率 1.54%）**P99=4.627u** ⇒ 触发用户 r3.5-Q3′ 逃逸条款信号（grill Q5）；C5 **模型轨 PASS**（v3 产品门口径：A 档 7.9957<8、B 档 atomic1 0.9995、压测档 ε 尾触发）+ 真机轨 BLOCKED（t8 手测）+ **两条独立管线 ε 交叉一致**；**Δ×L 的 L 轴未见 knee 左移**（模型未获实测支持、不得宣称 L 收益）；**tick 模式每步分配 3 vs v7 4 = 净减少**；P0 面 = `authorityTickInto` 体内三调用点、**P0-CRITICAL=0**。

## 3. 页面/视觉证据（若交付含 Web 页面）

- 交付含 `game/web/index.html` + 构建产物（`web/worker.js`/`web/app.js`）。
- 若交付门要求 headless-smoke（`requireSmoke` 默认 true）：以本地静态服务提供 `game/web/` 后提交 URL；
  **注意用户硬约束**：团队不得用真实浏览器做物理 A/B（真机 A/B 由用户手测）；headless smoke 仅用于「页面可加载、无 JS 致命错」的交付门自身校验，**不得**作为物理正确性证据。
- 若判定不适用（交付物为代码+文档而非页面）：在 evidence 中以 kind=file/text/run/test 覆盖，并在报告中说明理由。

## 4. 终报随行项（告知用户）

1. **校验器 glob bug**：完成态校验器对 inScope 做**精确字符串匹配**（`**` 无 globstar 语义）⇒ glob 项永不命中；实测结论=仅字面量或空集可过（t1 空集通过、t3 三字面量通过、t2 单字面量通过）。convention 已全队执行。
2. **流程缺口**：运行中团队**无 inScope 修订通道**（`edit_plan` 仅 staged 且 schema 无 inScope）⇒ 需 captain 代提交或续写任务（t14→t15 即为此）。
3. **模型切换**（用户指令）：原 6 名成员 `ocg/omen-alpha` 额度耗尽，全体迁至 `deepseek-official/deepseek-flash`（effort max），以 `temp/phys-plan-discuss/handover-brief.md` 作上下文 bootstrap；新成员名 `-2`/`-f` 后缀。
4. **质量战绩**：本轮拦下 5 类「空覆盖/假绿」（J0 ε 零注入、速度轴空转、M-C async 未 await、PHANTOM `stepsOf` 键错、`t7TODO` 语义），并制度化 G15/G18/G19 通用断言。
5. **团队清理**：交付门通过并呈报用户后，除非用户要求保留，否则 `agent_teams_delete`。
