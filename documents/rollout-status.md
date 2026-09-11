# 框架改造交付状态与遗留登记（收口记录）

> 定位：三份仓库框架规范（[framework-audit.md](framework-audit.md)、[framework-launch-structure.md](framework-launch-structure.md)、[framework-decoupling.md](framework-decoupling.md)）的**交付状态**与**遗留项登记**；逐文件施工清单见 [rollout-plan.md](rollout-plan.md)。
> 本文档是**状态记录**，不是规范、不是施工计划；规范内容仍以那三份为准，与代码冲突时以代码为准并回改本文档。
> 记录时点：基线提交 = **`1fe641e`**（本次收口；同一提交亦记于 [framework-audit.md](framework-audit.md) §0.1 的「事实时点」字段，由紧随其后的极小追加提交钉定）。**本表随交付推进更新**，更新时必须同步 §1 的提交号与 §3 的实测数字。
> 记号：`已落地` = 代码在版本库内且可实测；`待执行` = 尚无对应提交；`已闭环` = 已确认无需动作；`已登记` = 明确留作后续任务。

## 1. 批次状态总表（按实际提交边界）

| 批次 | 范围 | 状态 | 提交 |
|---|---|---|---|
| 批 1 | 审计/规范定稿 + `I-02`/`I-03`/`I-22` 修复 + `.cmd` 括号块缺陷 + doc-drift CRLF 归一 | 已落地 | `6da49ae` / `fa5552e` / `4523ef1` |
| 批 2 | 构建链收敛：`D-01` + `D-02` + `D-03`/`T-03`（**不含 `T-04`**，按规范 §7.5 归批 3） | 已落地 | `fc3de84`（16 文件 +394/−211） |
| 批 3 | 启动与产物收敛：端口 10 段槽位 + `.cmd` 逐字模板 + `start-dev.cmd` 补齐 + `T-04` 内核 `dist-pack.mjs` + `D-23`/`E-08` 许可唯一源 | 已落地 | `32c2ddb`（21 文件）+ `2135056`（9 文件，修 9 处块内括号静默失效） |
| 批 4 | 共享层上提：`D-08` / `D-09` / `D-10` / `D-16` + viewer include + 共享一致性门禁 | 已落地 | `b5be059`（40 文件）∪ `3b16366` 内的 `src/ts-shared/**` 与 `src/phys/LICENSE`·`NOTICE` ∪ `32c2ddb` 内的 2 篇文档 |
| 前置 | `t1` 逐文件施工计划 [rollout-plan.md](rollout-plan.md) | 已落地 | `c8ef88b`（349 行） |
| 收口 | 规范落地状态与全文计数事实同步 | 已落地 | `f911ee7` ∪ `8879c15`（批 4 收尾锚点清空）∪ `9fd4b1f` / `785ddac` / `e558558` / `2f33b20` / `3656e22` / `691cd8f` / `18f33f4` / `23d1e00` / `640da1a`（§2.5.x 判据与 `.cmd` 括号块类）∪ `6695447` / `5406e15`（audit 内容级锚点与 `§0.3`）∪ **`1fe641e`**（本次收口：本文件、`framework-audit.md` 三处状态/时点、`CHANGELOG.md` 追加条目） |

**提交边界交叉（如实登记，不掩盖）**：`3b16366` 与 `32c2ddb` 的**文件归属跨了批次**——`3b16366`（标题为「修 t3 报出的三处 low 级缺陷」）同时携带了批 4 的产物（`src/ts-shared/phys/{angles,constants}.ts`、`src/ts-shared/wasm/loader.ts`、`src/ts-shared/world/{pvs-manager,types}.ts`、`src/phys/{LICENSE,NOTICE}`、`apps/debug/src/world/pvs-manager.ts`，共 11 文件），`32c2ddb`（标题为批 3）内另含批 4 的 2 篇文档（`documents/architecture.md`、`documents/decoupling` 侧引用）。系 captain 提交时**未复核暂存区**所致。**判据**：`git show --name-only 3b16366` 列出上述路径；故上表批 4 一行的提交列写作「∪」而非单一提交号。

【必须】批 2/3/4 的顺序约束以 [framework-decoupling.md](framework-decoupling.md) §7.5 为准：`T-04`（内核抽取）**排在**「产物改造」（[framework-launch-structure.md](framework-launch-structure.md) §10.3 第 3 步）**之后**，两者在批 3 同一次改动内完成；`install-wasm-bindgen.cmd` 的层数缺陷随 `D-02` 上提消除；`T-03` 与「viewer 补 `check:api`」合并为一次动作。三条均已执行。

## 2. 文档产出状态

- [rollout-plan.md](rollout-plan.md)（`t1` 交付物）：**已产出**（`c8ef88b`）。批 2/3/4 的逐文件动作表与裁定偏离见该文 §4–§6 与本次收口的标注。
- [framework-audit.md](framework-audit.md) / [framework-launch-structure.md](framework-launch-structure.md) / [framework-decoupling.md](framework-decoupling.md)：**已补「落地状态」块**（各文件头部，逐条注明已执行项与提交号），未落地项保持「待执行」。
- 本文档与 `rollout-plan.md` 已纳入 [index.md](index.md) 导航（篇数 27 → 29）。
- **`framework-audit.md` 的最终落地状态**：其 `§6.4` / `§8.5` 是 `I-nn` / `R-nn` 的**单一事实源**（逐条附可复核提交号）；本次收口按实测更正其中两处状态/归因（`I-02` → 已执行、`R-11` 归因 → 批 3 `32c2ddb`），并把 `§0.1` 的「现行事实」推进一档。

## 3. 全仓体检（收口后复跑实测；基线 `5406e15` + 本次收口改动）

| 体检项 | 命令 | 结果 |
|---|---|---|
| 文档漂移（A 行数声明 / B 锚点越界） | `node src/scripts/check-doc-drift.mjs`（成员沙箱内必然 `spawnSync git EPERM`，属环境限制；原命令实测 **exit 1**） | 等价口径实测（**收口完成后复跑**）：**50 篇 md ｜ 行数声明 152（漂移 0）｜锚点 1917（越界 0）｜路径失效 18 ｜歧义未判 419**，退出码 **0**。演进链（均实测）：批 4 收尾 `8879c15` 时为 147 声明 / 1818 锚点；t1 `6695447` 后为 149 / 1888；`5406e15` 后仍 149 / 1888；`1fe641e`/`c83b4c0` 后为 150 / 1895；**本次追加修订（`I-05`/`I-22` 与 §0.2/§7.4 口径、R-14）后为 152 / 1917** |
| 相对链接可达性 | 纯 `fs` 遍历全仓 md（跳过 `archive/`） | **受检 50 篇 ｜ 失效 0 ｜ 100% 可达**（含本次改动；收口前曾为「失效 1 篇」——`README.md:63` → `apps/debug/src/physics/NOTICE`，批 3 搬迁后未同步，已在 `8879c15` 系列修复） |

- 路径失效 **18 处**均为 C 类**告警**（不影响退出码），逐条处置见 §4。
- 等价口径说明（沙箱内 `node` 无法 spawn 子进程）：把 `src/scripts/check-doc-drift.mjs:31-32` 那条读清单的语句整体替换为「读预生成的 UTF-8 无 BOM / LF 清单」，**其余逻辑逐字不改**；实现为「`.tmp/` 内的补丁副本 + 动态 import」，**全程不修改被跟踪的源脚本**（跑后 `git diff --quiet -- src/scripts/check-doc-drift.mjs` → 退出 0），副本与清单放临时区。
- 生成清单的已知陷阱（实测踩到）：**用 `pwsh` 管道把 `git ls-files` 喂给 `node` 时，PowerShell 会在流首插入一个 BOM**，使清单第一条（`--others` 的未跟踪文件）变成 `\uFEFFdocuments/...` 而 `existsSync` 失败、被静默跳过——实测该形态下体检输出「48 篇 md」而非「49 篇 md」，且不报任何错误。安全做法：`cmd /c "git ls-files … > list.txt"` 落盘后再读（实测无 BOM），或用 `Set-Content -Encoding ascii` 并确认首字节不是 `EF BB BF`。
- 口径边界（重要）：沙箱内 `node` 无法 spawn 子进程，**任何**由本任务执行的体检都只能覆盖「清单可枚举到的文件」；新增的未跟踪文件必须显式确认已进入清单后，§3 的数字才成立。

## 4. C 类「旧路径引用待回改」逐条处置（**实测 18 处**）

> 计数口径：本表按**工具口径**逐**处**登记（同一行出现两个旧路径即算两处）；`rollout-plan.md` 初记的「15 处」是**位置数**，差额来自本表第 16–18 行的 3 处（`rollout-status.md` 自身的「旧引用」列）与其重复计数方式，两者口径不同、不构成矛盾。
> **本节自身曾是「内容级锚点错位」的重灾区**：下列「位置」列原先记的是 `t1`（`6695447`）之前的行号，8 条已因 `6695447` / `5406e15` 的改动而失效——**门禁只查越界不查内容相符**（[AGENTS.md](../AGENTS.md) §5.3），故未能发现。本次收口按**实测内容**逐条重新定位；其中第 7 条属**描述错位**（非行号漂移），按「如实登记」原则保留成因说明。

| # | 位置（本次实测） | 旧引用 | 性质判定 | 处置 |
|---|---|---|---|---|
| 1 | `CHANGELOG.md:11` | `apps/debug/scripts/install-wasm-bindgen.cmd:19` | 历史叙述（批 1 审计记录） | 保持，属批 1 事实记录 |
| 2 | `CHANGELOG.md:86` | 同上 | 历史叙述（批 1 `I-22` 修复记录） | 保持，属批 1 事实记录 |
| 3 | `framework-audit.md:548`（§6.1 `I-12` 证据行） | `apps/debug/scripts/ensure-node-deps.cmd` | **当前事实**已被 D-01 改变 | 保持原文；该行的现行处置结论见同文件 §6.4 的 `I-12` 行（批 2 `fc3de84` 上提共享单份）。经 t1 重新编号后，原记 `:434` 已失效（该行现为 `input/input-layer.ts` 行），批 2 上提补注位于 `:145` |
| 4 | `framework-audit.md:536`（§6.1 `I-22` 证据行；§6.4 状态行 `:590`） | `apps/debug/scripts/install-wasm-bindgen.cmd:19` | 历史叙述（批 1 缺陷描述） | 保持，属审计快照。原记 `:521` 已失效（该行现为**空行**）——经 t1 重新编号后 `I-22` 证据行迁至 `:536` |
| 5 | `framework-decoupling.md:118`（`D-02` 裁决行） | 同上 | **当前事实**已被 D-02 改变 | 保持原文；同文件 `:145`（`D-02` 执行清单行）与 `:34`（`C-1` 行）均已补注「批 2 已上提」 |
| 6–7 | `framework-decoupling.md:150`（`D-09` **执行清单**行 2 处） | `apps/debug/src/world/pvs-manager.ts`、`apps/game/src/world/pvs-manager.ts` | **当前事实**已被 D-10 改变 | **修正描述错位（非行号漂移）**：原记 `:125` 并称其为「`D-09` 清单」，实为 `D-09` 的**证据行**（不含 `pvs-manager`）；`D-09` 的**执行清单**在 `:150`，两处 `pvs-manager` 正在该行。故由 `:125` 改为 `:150`，并在此保留成因说明 |
| 8 | `framework-decoupling.md:368`（§6.3） | `apps/debug/scripts/install-wasm-bindgen.cmd:19` | 历史叙述（层数反例） | 已补注「历史反例，批 1 已修 + 批 2 已上提」 |
| 9 | `framework-launch-structure.md:437`（§3.3 层数表末行） | 同上 | 历史叙述（层数反例） | 已补注「历史反例」。原记 `:427` 已失效——该规范头部落地状态块为**零行插入**，但 §3.3 表内的反例行经本次同步后位于 `:437` |
| 10–12 | `rollout-plan.md:197`（`B4-2` 行 + 其判据 2 处） | `apps/*/src/world/pvs-manager.ts` | **当前事实**已被 D-10 改变 | 已补注「已执行，见批 4」。原记 `:195`／行内写作 `B4-4` 均失效：`:195` 现为 `B4-2`（base64 上提），`B4-4`（PVS 管理上提）迁至 `:197` |
| 13 | `rollout-plan.md:291`（§9.2 回改表） | `apps/debug/scripts/install-wasm-bindgen.cmd` | 历史叙述（规范原文引用） | 已补注「原文引用，路径已上提」；其指向的 §3.3 反例行现为 `framework-launch-structure.md:437`（原 `:427`） |
| 14–15 | `rollout-plan.md:307`（§10.3 C 类清单 2 处） | `apps/*/src/world/pvs-manager.ts` | 计划内旧路径 | 已补注「批 4 已执行」 |
| 16–18 | `rollout-status.md:49/:52/:55` | `apps/debug/scripts/install-wasm-bindgen.cmd`、`apps/*/src/world/pvs-manager.ts` | **引用原文**（§4 表自身的「旧引用」列） | 保持：这三处是本文档表格对旧路径的显式引用，用途即登记，不构成路径依赖。**本次实测重定位**：本次收口在第 3、7 条改写中新增了行号引用，使本节行号整体后移——原记 `:44/:47/:50` 已失效，实测现为 `:49/:52/:55` |
| 附 | `architecture.md:207` | `debug/docs/overview.md` | **工具误报**（该行自述为刻意保留的历史记载） | 保持不动，注明为工具散文路径提取误报。原记 `:202` 系 R-5 改写前的行号，已由 R-5 的 +4 行顺延为 `:207` |

## 5. 遗留项登记（逐条处置结论与去向）

| # | 遗留项 | 状态 | 处置结论 |
|---|---|---|---|
| R-1 | `test:smoke` 的 CI 化与改名 `local:smoke` | **viewer 半边已执行（批 3 `32c2ddb`）**；harness 外无待办 | 改名已在批 3 `32c2ddb` 落地——`apps/viewer/package.json:11` 现为 `"local:smoke": "node test/smoke-cdp.mjs"`（`git blame -L 10,11 -- apps/viewer/package.json` 两行均为 `32c2ddbf`；反证 `b5be059` 内仍是 `test:smoke`）。该脚本需浏览器 + 已运行 dev 服务器，不满足 `test:*` 的「无外部前置」定义，故按 [framework-launch-structure.md](framework-launch-structure.md) §4.3/§6.2 **从 CI 排除**——这是**排除要求**而非待办，`deploy-pages.yml` 从未含该步骤，无需动作。**性质：登记滞后于实现**（原记「未落地」系未复核 `package.json` 所致） |
| R-2 | `test/dual-mode-harness/` 另案改造 | 已登记（明确排除本轮） | [framework-decoupling.md](framework-decoupling.md) `D-22` 判「保留（本轮）」；§6.2 `T-03`/`T-04` 登记为共享工具的第二轮可选消费方。现状：其 `scripts/check-wasm-api.mjs` 与 `scripts/build-dist.mjs` 仍是独立实现（2 处 outOfScope 副本） |
| R-3 | LF-only 行尾与 [AGENTS.md](../AGENTS.md)「行尾统一 CRLF」的矛盾 | 已登记（建议单独成批） | **本次收口实测（宽口径，可复现）**：受检文本文件 **313**，其中 **LF-only 72 / CRLF 240 / 混合 0 / 无行尾 1**（`md/ts/mjs/js/json/cmd/rs/py/yml/yaml/toml/html/css`，取自 `git ls-files --cached --others --exclude-standard` 清单中磁盘存在的文件）。**与旧值的差额已归因**：原登记记「受检 308 / LF-only 71」，而 `8879c15` 与当前工作区的文本文件集**比对后无增无减**（均 313）——故差额**不是**收口新增文件所致，而是两次测量的**范围/口径差异**（无法从现行文档复原其精确口径）；本条以**本次可复现口径**为准。处置方式沿用 [AGENTS.md](../AGENTS.md) §7.1 第 8 项先例：逐文件验证「去掉 CR 后与 HEAD 字节全等」 |
| R-4 | `documents/architecture.md:207` 的历史引述（体检 C 项告警） | 已闭环 | 该行自述为刻意保留的历史记载，保持不动；C 项按「告警」口径对待 |
| R-5 | `documents/architecture.md:105` 的「`check-wasm-api.mjs` 存在于 debug / game / harness **三处**、viewer 无此脚本」断言 | **本次已修** | 该断言在批 2 后失真（viewer 已补薄配置、debug/game 已变薄配置）。已按实际改写为「**四工程各一份薄配置 + 共享引擎** `src/scripts/lib/wasm-api-contract.mjs`」，并补「勘误」段与 debug/game 契约面差异、harness `:26-39` 的现行锚点；该处 +4 行使 `architecture.md` 总行数 199 → 203，其后的 `:202` 锚点顺延为 `:207`（见 R-4） |
| R-6 | 三份 `build-dist.mjs` 收敛后 7 篇文档的行数声明与锚点回改面 | 已闭环（`8879c15` + 本次收口） | [framework-decoupling.md](framework-decoupling.md) §7.6 预登的受影响文档已由批 4 收尾提交 `8879c15` 清空全仓锚点越界；本次收口复跑体检确认 **越界 0**，且**人工回看**了 `documents/{debug,game,viewer}/overview.md` 与 `architecture.md` 中指向 `build-dist.mjs` 的锚点；**本任务人工回看明细（脚本只查越界不查错位）**：`documents/debug/overview.md`、`documents/game/overview.md`、`documents/viewer/overview.md` 中指向 `build-dist.mjs` 的行数声明与 `文件:行号` 锚点逐条实读相符，`documents/architecture.md` 的 `check-wasm-api` 断言已于本次改写（R-5） |
| R-7 | 规范文档中「待执行」清单的状态同步 | **本次已做** | 三份规范各补「落地状态」块（注明已执行项 + 提交号，未落地项保持待执行）；`rollout-plan.md` 同步标注裁定偏离 |
| R-8 | **F-2：共享 `ensure-node-deps.cmd` 词表与 §2.5 逐字模板不符** | **已由 `640da1a` 登记为例外（判据白名单化）** | 实测 `src/scripts/ensure-node-deps.cmd` 内 `[deps]` 前缀 **11 处**（词表外标记），且 `:48` 的 `[deps][ERROR] npm install failed.` **缺后续 `[HINT]`**（违反 §2.5.1「每个 `[ERROR]` 后紧跟恰好一条 `[HINT]`」）。**影响面**：该脚本被**9 个入口**调用（三工程 × `play.cmd`/`start-dev.cmd`/`build-dist.cmd`，`git grep -n "ensure-node-deps" -- 'apps/*/*.cmd'` 实测 9 处），其输出会**插入 §2.5 的逐字步骤行之间**（`[1/4]`/`[1/5]`/`[2/3]`/`[1/3]` 之后紧接 `[deps] ====…` 段），使双击入口的实际输出与模板逐字不一致。**处置结论**：`640da1a` 已在 §2.5.1 **登记该例外**并把判据改为**白名单**口径（即 `[deps]` 属已登记的词表例外，不再判为违规），故**本项不再是缺陷**；判据行同步改为「目标态 + 实测值」以避免空洞真（`9fd4b1f`）。**去向**：如后续要把 11 处 `[deps]` 并入正式词表，须重跑 §11.2 的 `.cmd` 端到端验收——**本轮不做**，仅登记 |
| R-9 | `README.md:63` 的 `NOTICE` 链接因批 3 许可证搬迁而失效 | **本次已修** | 相对链接由 `apps/debug/src/physics/NOTICE` 改为 `src/phys/NOTICE`（许可唯一源）；修复前后均给实测（修前全仓链接体检「失效 1 篇」，修后 100% 可达） |
| R-10 | harness 内 outOfScope 副本（`check-wasm-api.mjs`、`build-dist.mjs`） | 已登记（随 R-2） | 属 `test/dual-mode-harness/`，不在本轮任何 inScope；随 R-2 另案处置 |
| R-11 | 批 3 端口判据中 `test/dual-mode-harness` 仍为 8080 | **viewer 半边已执行（批 3 `32c2ddb`）**；harness 半边**留待执行**（随 R-2） | **viewer 半边**：`test:replay` 的输出已迁 `.tmp/`（`apps/viewer/package.json:10` 的 `outfile=.tmp/replay-selftest/replay-selftest.mjs`，出处同为 `32c2ddb`；`git blame -L 10,11` 两行均 `32c2ddbf`）——原登记写「批 4 `b5be059`」系归因错误，已在本表更正，同步更正 [framework-audit.md](framework-audit.md) §8.5 的 `R-11` 行。**harness 半边仍未落地**：规范 §2.3 要求 harness 用 8110（与 `dev` 共用），现状 `test/dual-mode-harness/play.cmd:6` 仍 `set PORT=8080`、其 `package.json` 的 `dev` 亦未改；因该目录不在任何实现批次的 inScope，随 R-2 另案处置 |
| R-12 | **`[IMPORTANT]` 标记在词表之外**（本团队新发现） | 已登记（随 R-2，harness out-of-scope） | 实测全仓 `[IMPORTANT]` 仅 **1 处**：`test/dual-mode-harness/play.cmd:65`（`echo  [IMPORTANT] This window is the server. Keep it open while playing;`）。规范 §2.5 的唯一词表只含 `[0/5]`…`[N/M]`/`[ERROR]`/`[HINT]` 等，`[IMPORTANT]` **不在词表内**——三工程 9 个入口已按逐字模板清零词表外标记（批 3 `32c2ddb` + `2135056`），harness 是**唯一残留**。**处置结论**：该文件属 `test/dual-mode-harness/`，不在本轮任何 inScope → **不修改**，随 R-2 另案处置；届时改为词表内标记（如 `[INFO]`）并同步重跑输出模板判据 |
| R-13 | **`Q4`：`build:dist` 的 WASM 内嵌机制由各工程自实现收敛为共享内核** | **已登记（非缺陷，不需修复）** | **现象**：批 3 落地的 `T-04` 把三份 `build-dist.mjs` 的 base64 内嵌注入收敛为共享内核 `src/scripts/lib/dist-pack.mjs`，由 `writeEmbeddedPreamble` 统一写出 `globalThis.__VBSP_WASM_B64__`（实测 `src/scripts/lib/dist-pack.mjs:107`；该函数签名含 `wasmB64` 于 `:98`），三工程 `build-dist.mjs` 以 `wasmB64` 调用它。**产物形态未变**：三工程 single 产物**仍然内嵌 WASM**（viewer 本就 single-only，同样内嵌），`file://` 双击可玩的既有能力零变化。**结论**：这是**重构**（机制收敛、实现去重），不是行为变更，**非缺陷、不需修复**。**登记缘由**：派单初稿曾把本项表述为「`build:dist` 产物不含内嵌 WASM」的**行为回退待确认**，经实测该前提**不成立**（`dist-pack.mjs:107` 的注入仍在生效），故在此如实登记为「重构、产物形态未变」，且**不写入**任何「产物无内嵌 WASM」的表述；如需改变产物形态，须另行裁定（本任务不修） |
| R-14 | **`apps/viewer/README.md:45` 仍写「本地地图副本放仓库根 `maps/`」**（`I-05` 的 viewer 半边，收口时实测发现） | **已登记（本任务 out of scope，只登记不修）** | 实测 `apps/viewer/README.md:45` = 「更换地图」（拖拽 `.bsp` 仍全局可用）。本地地图副本放仓库根 `maps/`（gitignored）。而根 `README.md:43` 已统一为 **`test/maps/`** 并声明「仓库根 `maps/` 已废弃」（出处 `a4ed66f`）。**处置结论**：`apps/viewer/README.md` 属 `apps/` → **不在本任务 inScope**（t3 边界明文排除 `apps/`），故**只登记不修**；`framework-audit.md` §6.4 的 `I-05` 已相应由「已执行」改记为**「部分执行」**，viewer 半边留待执行。**去向**：与 R-2 同属「另案/harness 与工程内文档清理」，交后续任务或独立成批 |

## 6. 本次收口改动记录（`t9` 历史段 + `t3` 本次段）

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

> 上表 1–11 为**前序收口（`t9`）记录，保持原文**（属历史事实）。下表为本团队收口（`t3`）的改动。

| # | 文件 | 改动 | 判据 |
|---|---|---|---|
| 1 | `framework-audit.md` §6.4 `I-02` 行 | 状态列 `部分执行` → `已执行`；描述列去掉「**是否入 CI 仍待定**」，改为「按规范 §4.3/§6.2 本属**排除要求**（CI 从未含该步骤）→ 无需动作」 | 与本文档 §5 的 R-1 口径一致（此前两处互相矛盾）；出处 `32c2ddb` 经 `git blame` + `git log -S` 双证 |
| 2 | `framework-audit.md` §8.5 `R-11` 行 | 归因 `批 4` → **批 3 `32c2ddb`**（附两行 `blame` 均为 `32c2ddbf`） | `git show b5be059:apps/viewer/package.json` 内仍是 `temp/replay-selftest.mjs`，反证归因错误 |
| 3 | `framework-audit.md` §0.1 事实时点行 | 「现行事实」由 `640da1a` 推进为 **`1fe641e`**（本次收口）；上一档保留并注明属正常前进 | 与本文档 §1 的基线为同一提交 |
| 4 | 本文档 §4 表 | 8 条失效「位置」锚点按**实测内容**重定位（含第 7 条描述错位如实登记） | 门禁只查越界不查内容相符（[AGENTS.md](../AGENTS.md) §5.3）；逐条经 node 按字节读取核对 |
| 5 | 本文档 §5 | R-1/R-11 改记已执行（`32c2ddb`）并保留成因说明；R-8 更新为「`640da1a` 已登记例外 + 判据白名单化」；**新增 R-12**（`[IMPORTANT]` 词表外，harness）、**新增 R-13**（`Q4` 登记，非缺陷） | `git blame -L 10,11 -- apps/viewer/package.json`；`git grep -n "IMPORTANT"` 实测 1 处；`src/scripts/lib/dist-pack.mjs:107` |
| 6 | 本文档 §1/§2/§3/§7 | 基线提交号、门禁四个数字改为**收口后复跑实测值**（`50 篇 ｜ 150 声明 ｜ 1895 锚点 ｜ 失效 18 ｜ 歧义 410`，exit 0）、等价口径说明改为「`.tmp/` 副本 + 动态 import，不碰被跟踪文件」、修正两个 `## 6` 重号标题为 §6/§7 | 复跑输出见 §3；`git diff --quiet -- src/scripts/check-doc-drift.mjs` 退出 0 |
| 7 | `CHANGELOG.md` | 追加**本次收口**条目（含 `6695447` / `5406e15` / 本次收口提交与本表 1–6 的改动摘要） | 既有批 1–4 条目保持原文不动 |

> 上表 1–7 为 `1fe641e` 批次；下表为 captain 追加裁定后的一次**极小追加修订**（同一工作区，未回退前笔）。

| # | 文件 | 改动 | 判据 |
|---|---|---|---|
| 1 | `framework-audit.md` §0.2 | 删除不可复现的「行号引用共 **409** 处」，改为 `node .tmp/anchor-audit.mjs` 可复现口径：**文件限定锚点 189**（非空 181 / 空行 1 / 未能定位 7）+ **裸行号 190**；并将「7 处空行/越界」改写为**逐条可复核的 8 处** | 凡写数字必附口径命令；409 在任何正则下都测不出（实测组合为 189/190/379） |
| 2 | `framework-audit.md` §0.2 | `check-wasm-api.mjs` 的定性按实测改写：该引用是**裸行号**（无文件名），按 doc-drift 同源算法消歧命中 **`apps/game/scripts/check-wasm-api.mjs`（99 行）**而非 debug 版（**55 行**），且**在该文件内确实越界** → 结论方向正确、归属与理由改写 | `node .tmp/anchor-audit.mjs`；两个文件实测行数 55 / 99 |
| 3 | `framework-audit.md` §6.4 `I-05` | 「已执行」→ **「部分执行」**：根 `README.md:43` 已统一 `test/maps/`，但 `apps/viewer/README.md:45` 仍是旧表述且**实测未修** | 逐字节读 `apps/viewer/README.md:45`；该文件属 `apps/`（本任务 out of scope）→ 只登记不修，立 R-14 |
| 4 | `framework-audit.md` §6.1 `I-22` | `%~dp0` 调用清单由改造前行号（`play.cmd:17,71` / `:17,69` 等）改为**当前实测**：三工程 `play.cmd:20`、`build-dist.cmd:33`（viewer `:31`）、`start-dev.cmd:20`、harness `play.cmd:37` | 逐条 node 按字节读；旧引用的 `:17` 现为**孤立 `)`** |
| 5 | `framework-audit.md` §2.4 | 新增**口径注记**：表中裸行号归属「该行工程列所指的那一份文件」；并记录三份的 `[0/5]`/`check:api`/`[3/5]`/`ensure-node-deps` 锚点**逐条按内容复核全部相符**（§2.5 的 48 个失败块边界与 `exit /b 0` 锚点亦全部实测相符） | `node .tmp/check-24-25.mjs` 全绿；I-16 的 `apps/viewer/play.cmd:51-56` **经复核无误，未改** |
| 6 | `framework-audit.md` §0.2/§7.4 + 本文档 §3/§7 | 门禁四个数字改为**本次复跑实测值**（`152 / 1917 / 18 / 419`，exit 0）；§0.2 新增的三处历史路径**去掉反引号/改引号书写**，使 C 类失效数**保持 18**（不因登记而新增） | 复跑前后均为 18；`git diff --quiet -- src/scripts/check-doc-drift.mjs` 退出 0 |
| 7 | 本文档 §5 | 新增 **R-14**（`apps/viewer/README.md:45` 旧路径，只登记不修） | 与 §6.4 的 `I-05`「部分执行」一致 |


## 7. 使用约束

- **本文档不改变任何规范条文的效力**：与三份规范冲突时以规范为准；与代码冲突时以代码为准并回改本文档。
- 本文档的**行数/计数类数字**（50 篇 / 152 / 1917 / 71 等）是实测快照；新增或修改文档后必须重跑 §3 的命令并同步更新，否则会被 `check-doc-drift.mjs` 记为漂移。
- **收口提交链（自引用说明）**：本次收口分两笔——`1fe641e`（内容收口：`framework-audit.md` 三处、本文件、`CHANGELOG.md` 追加）与其后一笔**极小追加提交**（把 §0.1 与本文档 §1 的「本次收口提交」替换为真实 sha `1fe641e`；该追加提交自身的 sha 记在它的提交信息里，**不在正文中自引用**，以免每次改写都改变自身标识）。因提交无法引用自身尚未生成的 sha，§0.1 的「现行事实」记为 **`1fe641e`**；两者是同一时点。
