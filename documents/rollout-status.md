# 框架改造交付状态与遗留登记（收口记录）

> 定位：三份仓库框架规范（[framework-audit.md](framework-audit.md)、[framework-launch-structure.md](framework-launch-structure.md)、[framework-decoupling.md](framework-decoupling.md)）的**交付状态**与**遗留项登记**；逐文件施工清单见 [rollout-plan.md](rollout-plan.md)。
> 本文档是**状态记录**，不是规范、不是施工计划；规范内容仍以那三份为准，与代码冲突时以代码为准并回改本文档。
> 记录时点：HEAD = `8879c15`（批 4 收尾）。**本表随交付推进更新**，更新时必须同步 §1 的提交号与 §3 的实测数字。
> 记号：`已落地` = 代码在版本库内且可实测；`待执行` = 尚无对应提交；`已闭环` = 已确认无需动作；`已登记` = 明确留作后续任务。

## 1. 批次状态总表（按实际提交边界）

| 批次 | 范围 | 状态 | 提交 |
|---|---|---|---|
| 批 1 | 审计/规范定稿 + `I-02`/`I-03`/`I-22` 修复 + `.cmd` 括号块缺陷 + doc-drift CRLF 归一 | 已落地 | `6da49ae` / `fa5552e` / `4523ef1` |
| 批 2 | 构建链收敛：`D-01` + `D-02` + `D-03`/`T-03`（**不含 `T-04`**，按规范 §7.5 归批 3） | 已落地 | `fc3de84`（16 文件 +394/−211） |
| 批 3 | 启动与产物收敛：端口 10 段槽位 + `.cmd` 逐字模板 + `start-dev.cmd` 补齐 + `T-04` 内核 `dist-pack.mjs` + `D-23`/`E-08` 许可唯一源 | 已落地 | `32c2ddb`（21 文件）+ `2135056`（9 文件，修 9 处块内括号静默失效） |
| 批 4 | 共享层上提：`D-08` / `D-09` / `D-10` / `D-16` + viewer include + 共享一致性门禁 | 已落地 | `b5be059`（40 文件）∪ `3b16366` 内的 `src/ts-shared/**` 与 `src/phys/LICENSE`·`NOTICE` ∪ `32c2ddb` 内的 2 篇文档 |
| 前置 | `t1` 逐文件施工计划 [rollout-plan.md](rollout-plan.md) | 已落地 | `c8ef88b`（349 行） |

**提交边界交叉（如实登记，不掩盖）**：`3b16366` 与 `32c2ddb` 的**文件归属跨了批次**——`3b16366`（标题为「修 t3 报出的三处 low 级缺陷」）同时携带了批 4 的产物（`src/ts-shared/phys/{angles,constants}.ts`、`src/ts-shared/wasm/loader.ts`、`src/ts-shared/world/{pvs-manager,types}.ts`、`src/phys/{LICENSE,NOTICE}`、`apps/debug/src/world/pvs-manager.ts`，共 11 文件），`32c2ddb`（标题为批 3）内另含批 4 的 2 篇文档（`documents/architecture.md`、`documents/decoupling` 侧引用）。系 captain 提交时**未复核暂存区**所致。**判据**：`git show --name-only 3b16366` 列出上述路径；故上表批 4 一行的提交列写作「∪」而非单一提交号。

【必须】批 2/3/4 的顺序约束以 [framework-decoupling.md](framework-decoupling.md) §7.5 为准：`T-04`（内核抽取）**排在**「产物改造」（[framework-launch-structure.md](framework-launch-structure.md) §10.3 第 3 步）**之后**，两者在批 3 同一次改动内完成；`install-wasm-bindgen.cmd` 的层数缺陷随 `D-02` 上提消除；`T-03` 与「viewer 补 `check:api`」合并为一次动作。三条均已执行。

## 2. 文档产出状态

- [rollout-plan.md](rollout-plan.md)（`t1` 交付物）：**已产出**（`c8ef88b`）。批 2/3/4 的逐文件动作表与裁定偏离见该文 §4–§6 与本次收口的标注。
- [framework-audit.md](framework-audit.md) / [framework-launch-structure.md](framework-launch-structure.md) / [framework-decoupling.md](framework-decoupling.md)：**已补「落地状态」块**（各文件头部，逐条注明已执行项与提交号），未落地项保持「待执行」。
- 本文档与 `rollout-plan.md` 已纳入 [index.md](index.md) 导航（篇数 27 → 29）。

## 3. 全仓体检（实测时点 HEAD = `8879c15`）

| 体检项 | 命令 | 结果 |
|---|---|---|
| 文档漂移（A 行数声明 / B 锚点越界） | `node src/scripts/check-doc-drift.mjs`（成员沙箱内必然 `spawnSync git EPERM`，属环境限制；原命令实测 **exit 1**） | 等价口径实测：**50 篇 md ｜ 行数声明 147（漂移 0）｜锚点 1818（越界 0）｜路径失效 18 ｜歧义未判 408**，退出码 **0**（收口**完成后**复跑结果；收口**开始时**为 1788 锚点 / 失效 15，差额来自本次在规范与状态文档内新增的锚点与保留的历史路径引用） |
| 相对链接可达性 | 纯 `fs` 遍历全仓 md（跳过 `archive/`） | 收口前 **受检 50 篇 ｜ 失效 1 篇**（`README.md:63` → `apps/debug/src/physics/NOTICE`，批 3 搬迁后未同步）→ **已修**；收口后见 §5 复跑结果；**收口后复跑**：**受检 50 篇 ｜ 失效 0 ｜ 100% 可达** |

- 路径失效 15 处均为 C 类**告警**（不影响退出码），逐条处置见 §4。
- 等价口径说明（沙箱内 `node` 无法 spawn 子进程）：把 `src/scripts/check-doc-drift.mjs:31` 取清单的那一行替换为「读预生成的 UTF-8 无 BOM / LF 清单」，**其余逻辑逐字不改**；副本与清单放临时区，跑完即删，源文件不动。
- 生成清单的已知陷阱（实测踩到）：**用 `pwsh` 管道把 `git ls-files` 喂给 `node` 时，PowerShell 会在流首插入一个 BOM**，使清单第一条（`--others` 的未跟踪文件）变成 `\uFEFFdocuments/...` 而 `existsSync` 失败、被静默跳过——实测该形态下体检输出「48 篇 md」而非「49 篇 md」，且不报任何错误。安全做法：`cmd /c "git ls-files … > list.txt"` 落盘后再读（实测无 BOM），或用 `Set-Content -Encoding ascii` 并确认首字节不是 `EF BB BF`。
- 口径边界（重要）：沙箱内 `node` 无法 spawn 子进程，**任何**由本任务执行的体检都只能覆盖「清单可枚举到的文件」；新增的未跟踪文件必须显式确认已进入清单后，§3 的数字才成立。

## 4. C 类「旧路径引用待回改」逐条处置（**实测 18 处**；计划书初记 15 处，差额为本次收口在 `rollout-status.md` 自身新增的 3 处路径引用——按工具口径计入，用途见第 16–18 行）

| # | 位置 | 旧引用 | 性质判定 | 处置 |
|---|---|---|---|---|
| 1 | `CHANGELOG.md:11` | `apps/debug/scripts/install-wasm-bindgen.cmd:19` | 历史叙述（批 1 审计记录） | 保持，属批 1 事实记录 |
| 2 | `CHANGELOG.md:86` | 同上 | 历史叙述（批 1 `I-22` 修复记录） | 保持，属批 1 事实记录 |
| 3 | `framework-audit.md:434`（`I-12`） | `apps/debug/scripts/ensure-node-deps.cmd` | **当前事实**已被 D-01 改变 | 已在本行补注「批 2 已上提，见落地状态块」 |
| 4 | `framework-audit.md:521`（`I-22`） | `apps/debug/scripts/install-wasm-bindgen.cmd:19` | 历史叙述（批 1 缺陷描述） | 保持，属审计快照 |
| 5 | `framework-decoupling.md:118`（`D-02`） | 同上 | **当前事实**已被 D-02 改变 | 已在上文补注「层数已修 + 已上提」 |
| 6–7 | `framework-decoupling.md:125`（`D-09` 清单 2 处） | `apps/debug/src/world/pvs-manager.ts`、`apps/game/src/world/pvs-manager.ts` | **当前事实**已被 D-10 改变 | 已补注「已上提 `src/ts-shared/world/`」 |
| 8 | `framework-decoupling.md:368`（§6.3） | `apps/debug/scripts/install-wasm-bindgen.cmd:19` | 历史叙述（层数反例） | 已补注「历史反例，批 1 已修 + 批 2 已上提」 |
| 9 | `framework-launch-structure.md:427`（§3.3） | 同上 | 历史叙述（层数反例） | 已补注「历史反例」 |
| 10 | `rollout-plan.md:195`（`B4-4`） | `apps/*/src/world/pvs-manager.ts` | **当前事实**已被 D-10 改变 | 已补注「已执行，见批 4」 |
| 11–12 | `rollout-plan.md:195`（`B4-4` 判据 2 处） | 同上 | 同上 | 同上 |
| 13 | `rollout-plan.md:291`（§9.2） | `apps/debug/scripts/install-wasm-bindgen.cmd` | 历史叙述（规范原文引用） | 已补注「原文引用，路径已上提」 |
| 14–15 | `rollout-plan.md:307`（§10.3 C 类清单 2 处） | `apps/*/src/world/pvs-manager.ts` | 计划内旧路径 | 已补注「批 4 已执行」 |
| 16–18 | `rollout-status.md:44/:47/:50` | `apps/debug/scripts/install-wasm-bindgen.cmd`、`apps/*/src/world/pvs-manager.ts` | **引用原文**（§4 表自身的「旧引用」列） | 保持：这三处是本文档表格对旧路径的显式引用，用途即登记，不构成路径依赖 |
| 附 | `architecture.md:202` | `debug/docs/overview.md` | **工具误报**（该行自述为刻意保留的历史记载） | 保持不动，注明为工具散文路径提取误报 |

## 5. 遗留项登记（逐条处置结论与去向）

| # | 遗留项 | 状态 | 处置结论 |
|---|---|---|---|
| R-1 | `test:smoke` 的 CI 化与改名 `local:smoke` | 已登记（后续任务） | 先按 [framework-launch-structure.md](framework-launch-structure.md) §4.3/§6.2 改名 `local:smoke`（需浏览器 + 已运行 dev 服务器，不满足 `test:*` 的「无外部前置」定义），再从 CI 排除；现 `apps/viewer/package.json` 仍为 `test:smoke`，`deploy-pages.yml` 无该步骤 |
| R-2 | `test/dual-mode-harness/` 另案改造 | 已登记（明确排除本轮） | [framework-decoupling.md](framework-decoupling.md) `D-22` 判「保留（本轮）」；§6.2 `T-03`/`T-04` 登记为共享工具的第二轮可选消费方。现状：其 `scripts/check-wasm-api.mjs` 与 `scripts/build-dist.mjs` 仍是独立实现（2 处 outOfScope 副本） |
| R-3 | LF-only 行尾与 [AGENTS.md](../AGENTS.md)「行尾统一 CRLF」的矛盾 | 已登记（建议单独成批） | 实测 **71 个**被跟踪文本文件为 LF-only（宽口径：受检 308 个文本文件，LF-only 71 / CRLF 236 / 混合 0），**非**早期估计的 57。处置方式沿用 [AGENTS.md](../AGENTS.md) §7.1 第 8 项先例：逐文件验证「去掉 CR 后与 HEAD 字节全等」 |
| R-4 | `documents/architecture.md:207` 的历史引述（体检 C 项告警） | 已闭环 | 该行自述为刻意保留的历史记载，保持不动；C 项按「告警」口径对待 |
| R-5 | `documents/architecture.md:105` 的「`check-wasm-api.mjs` 存在于 debug / game / harness **三处**、viewer 无此脚本」断言 | **本次已修** | 该断言在批 2 后失真（viewer 已补薄配置、debug/game 已变薄配置）。已按实际改写为「**四工程各一份薄配置 + 共享引擎** `src/scripts/lib/wasm-api-contract.mjs`」，并补「勘误」段与 debug/game 契约面差异、harness `:26-39` 的现行锚点；该处 +4 行使 `architecture.md` 总行数 199 → 203，其后的 `:202` 锚点顺延为 `:207`（见 R-4） |
| R-6 | 三份 `build-dist.mjs` 收敛后 7 篇文档的行数声明与锚点回改面 | 已闭环（`8879c15` + 本次收口） | [framework-decoupling.md](framework-decoupling.md) §7.6 预登的受影响文档已由批 4 收尾提交 `8879c15` 清空全仓锚点越界；本次收口复跑体检确认 **越界 0**，且**人工回看**了 `documents/{debug,game,viewer}/overview.md` 与 `architecture.md` 中指向 `build-dist.mjs` 的锚点；**本任务人工回看明细（脚本只查越界不查错位）**：`documents/debug/overview.md`、`documents/game/overview.md`、`documents/viewer/overview.md` 中指向 `build-dist.mjs` 的行数声明与 `文件:行号` 锚点逐条实读相符，`documents/architecture.md` 的 `check-wasm-api` 断言已于本次改写（R-5） |
| R-7 | 规范文档中「待执行」清单的状态同步 | **本次已做** | 三份规范各补「落地状态」块（注明已执行项 + 提交号，未落地项保持待执行）；`rollout-plan.md` 同步标注裁定偏离 |
| R-8 | **F-2：共享 `ensure-node-deps.cmd` 词表与 §2.5 逐字模板不符** | **已登记（后续任务）** | 实测 `src/scripts/ensure-node-deps.cmd` 内 `[deps]` 前缀 **11 处**（词表外标记），且 `:48` 的 `[deps][ERROR] npm install failed.` **缺后续 `[HINT]`**（违反 §2.5.1「每个 `[ERROR]` 后紧跟恰好一条 `[HINT]`」）。**影响面**：该脚本被**9 个入口**调用（三工程 × `play.cmd`/`start-dev.cmd`/`build-dist.cmd`，`git grep -n "ensure-node-deps" -- 'apps/*/*.cmd'` 实测 9 处），其输出会**插入 §2.5 的逐字步骤行之间**（`[1/4]`/`[1/5]`/`[2/3]`/`[1/3]` 之后紧接 `[deps] ====…` 段），使双击入口的实际输出与模板逐字不一致。**本轮不在范围**（t9 边界为「不改 `apps/` 与 `src/` 下的代码」）→ 登记为后续任务：把 11 处 `[deps]` 改为词表内标记（建议 `[INFO]`/`[WARN]`），并把 `:48` 的失败分支补为 `[ERROR]` + 恰好一条 `[HINT]`，同步重跑 §11.2 的 `.cmd` 端到端验收 |
| R-9 | `README.md:63` 的 `NOTICE` 链接因批 3 许可证搬迁而失效 | **本次已修** | 相对链接由 `apps/debug/src/physics/NOTICE` 改为 `src/phys/NOTICE`（许可唯一源）；修复前后均给实测（修前全仓链接体检「失效 1 篇」，修后 100% 可达） |
| R-10 | harness 内 outOfScope 副本（`check-wasm-api.mjs`、`build-dist.mjs`） | 已登记（随 R-2） | 属 `test/dual-mode-harness/`，不在本轮任何 inScope；随 R-2 另案处置 |
| R-11 | 批 3 端口判据中 `test/dual-mode-harness` 仍为 8080 | 已登记（随 R-2） | 规范 §2.3 要求 harness 用 8110（与 `dev` 共用），现状 `test/dual-mode-harness/play.cmd:6` 仍 `set PORT=8080`、其 `package.json` 的 `dev` 亦未改；因该目录不在任何实现批次的 inScope，随 R-2 另案处置 |

## 6. 本次收口（`t9`）改了什么

| # | 文件 | 改动 | 判据 |
|---|---|---|---|
| 1 | `framework-launch-structure.md:5` | 规则行**追加**落地状态块（§10.1 的 24 项与 §10.3 三步已由批 1–4 执行；未落地项列名） | 零行插入 → 既有锚点零位移；复跑体检越界 0 |
| 2 | `framework-decoupling.md:5` | 同上（`D-01`…`D-23` 与 `T-05` 已执行；`D-22` 明文保留） | 同上 |
| 3 | `framework-audit.md:565` | `R-19` 行追加落地状态块（已执行项 vs 仍待执行项分列） | 同上 |
| 4 | `framework-audit.md:434` | `I-12` 补注「批 2 已执行」 | 当前事实类 C 项 |
| 5 | `framework-decoupling.md:118/125/368` | `D-02` 补注已修层+已上提；`D-09` 补注 pkg 名**同名**更正；§6.3 层数反例标历史 | 历史/当前事实分别处置 |
| 6 | `framework-launch-structure.md:427` | §3.3 层数表反例标历史 | 同上 |
| 7 | `rollout-plan.md:195/197/291/307/322/333` | 批 4 已执行补注 + C 类清单指向本文档 §4 | 计划与状态一致 |
| 8 | `architecture.md:105` | `check-wasm-api` 断言改写为「四工程薄配置 + 共享引擎」并补勘误段 | +4 行 → 其后 `:202` 顺延 `:207`（已同步本文档） |
| 9 | `README.md:63` | `NOTICE` 链接由 `apps/debug/src/physics/NOTICE` 改为许可唯一源 `src/phys/NOTICE` | 改前全仓链接「失效 1 篇」→ 改后 100% 可达 |
| 10 | `index.md:20/22` + 导航表 | 篇数 27 → **29**、根 9 → **11**，并登记 `rollout-plan.md` / `rollout-status.md` 两条 | 实测 `documents/` 根 11 篇、子树 29 篇，与声明一致 |
| 11 | `CHANGELOG.md:93` | 占位条目「批 2/3/4 尚未落地」替换为**批 2/批 3/批 4/`D-23` 搬迁/本次收口**五条实际条目（附提交号与验证方式） | 批 1 条目保持原样 |


## 6. 使用约束

- **本文档不改变任何规范条文的效力**：与三份规范冲突时以规范为准；与代码冲突时以代码为准并回改本文档。
- 本文档的**行数/计数类数字**（50 篇 / 147 / 1788 / 71 / 15 等）是实测快照；新增或修改文档后必须重跑 §3 的命令并同步更新，否则会被 `check-doc-drift.mjs` 记为漂移。
