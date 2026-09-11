# 框架改造交付状态与遗留登记（收口记录）

> 定位：三份仓库框架规范（[framework-audit.md](framework-audit.md)、[framework-launch-structure.md](framework-launch-structure.md)、[framework-decoupling.md](framework-decoupling.md)）的**交付状态**与**遗留项登记**。
> 本文档是**状态记录**，不是规范、不是施工计划；规范内容仍以那三份为准，逐文件施工清单以 `documents/rollout-plan.md` 为准（**尚未产出**，见 §2）。
> 记录时点：HEAD = `4523ef1`；记录前 `git status --short` 为空，落盘本文档与 CHANGELOG 状态条目后为 ` M CHANGELOG.md` + `?? documents/rollout-status.md`（仅此两项，尚未提交）。**本表随交付推进更新**，更新时必须同步 §1 的提交号与 §3 的实测数字。
> 记号：`已落地` = 代码在版本库内且可实测；`待执行` = 尚无对应提交；`已闭环` = 已确认无需动作。

## 1. 批次状态总表

| 批次 | 范围 | 状态 | 提交 | 判据 |
|---|---|---|---|---|
| 批 1 | 审计/规范定稿 + `I-02`/`I-03`/`I-22` 修复 + `.cmd` 括号块缺陷 + doc-drift CRLF 归一 | 已落地 | `6da49ae` / `fa5552e` / `4523ef1` | `git log --oneline` 命中三个提交；`apps/debug` 的 `npm run test:jump-apex` 通过 |
| 批 2 | 构建链收敛：`D-01`（`ensure-node-deps.cmd` 上提）+ `D-02`（`install-wasm-bindgen.cmd` 上提）+ `D-03`（`check-wasm-api` 引擎 `T-03`） | 待执行 | — | `git ls-files src/scripts` 仍只有 `cargo-env.cmd`、`check-doc-drift.mjs` |
| 批 3 | 启动与产物收敛：端口 10 段槽位、`.cmd` 逐字模板、`start-dev.cmd` 补齐、`web/` 与 `dist/` 形态、许可证落点（`D-23`/`E-08`）+ `T-04` 内核抽取（`src/scripts/lib/dist-pack.mjs`） | 待执行 | — | `Test-Path src/phys/LICENSE` → `False`；viewer `check:api` → `undefined`；三工程 `dev` 仍 `serve.py 8080` |
| 批 4 | 共享层上提：`D-08`（`bspYawToCsYaw`）、`D-09`（base64 解码 → `src/ts-shared/wasm/loader.ts`）、`D-10`（`pvs-manager`）、`D-16`（`EYE_STAND` 引用位点） | 待执行 | — | `git ls-files -- 'apps/*/src/world/pvs-manager.ts'` 仍有两份；`src/ts-shared/wasm/` 不存在 |
| 前置 | `t1` 逐文件施工计划 `rollout-plan.md` | 待执行 | — | 该文件尚不存在（§2） |

【必须】批 2/3/4 的顺序约束以 [framework-decoupling.md](framework-decoupling.md) §7.5 为准：`T-04`（内核抽取）**排在**「产物改造」（`framework-launch-structure.md` §10.3 第 3 步）**之后**；`install-wasm-bindgen.cmd` 的层数缺陷**不单独修**，随 `D-02` 上提在同一次动作内消除；`T-03` 与「viewer 补 `check:api`」合并为一次动作。

## 2. 尚未产出的文档

- `documents/rollout-plan.md`（`t1` 交付物）：**不存在**。它应给出批 2/3/4 的逐文件动作表（动作 / 源路径 / 目标路径 / 需同步的 `package.json`·`.cmd`·CI·文档锚点 / 每条验收命令与判据 / 依据条目编号）、两条硬约束（内核不得 `import esbuild`；共享层不得 `import` 各工程 `pkg/*`）的实测、esbuild 注入方案、文件冲突面与每批回滚方式。
- 在它落盘前，§1 的「待执行」项**不得**被当作「已在施工」；`documents/index.md` 的篇数统计也**不**因本文档而变更（本文档是否纳入导航由收口任务决定）。

## 3. 全仓体检（实测时点 HEAD = `4523ef1`）

| 体检项 | 命令 | 结果 |
|---|---|---|
| 文档漂移（A 行数声明 / B 锚点越界） | `node src/scripts/check-doc-drift.mjs`（成员沙箱内必然 `spawnSync git EPERM`，属环境限制；原命令实测 **exit 1**） | 等价口径实测：**49 篇 md ｜ 行数声明 138（漂移 0）｜锚点 1679（越界 0）｜路径失效 1 ｜歧义未判 389**，退出码 0 |
| 相对链接可达性 | 见 §4 的一次性脚本口径（纯 `fs`） | **受检 md 49 篇 ｜ 失效 0 篇 ｜ 100% 可达**，退出码 0 |
| `.cmd` 格式 | 逐文件统计 `>127` 字节 / `BOM` / `LF` 与 `CR` 计数 | 11 个 `.cmd` 全部 `nonASCII=0`、`BOM=false`、`LF==CR`（纯 ASCII + CRLF 无 BOM） |

- 路径失效的唯一一处：`documents/architecture.md:202` 的 `debug/docs/overview.md`。该行正文自述为「原 §8 曾记录的 … 前向悬空已自行闭环」的**历史引述**，属体检工具的 C 项告警（刻意保留），**已闭环，无需动作**。
- 等价口径说明（沙箱内 `node` 无法 spawn 子进程）：把 `src/scripts/check-doc-drift.mjs:31` 取清单的那一行替换为「读预生成的 UTF-8 无 BOM / LF 清单」，**其余逻辑逐字不改**；副本与清单放临时区，跑完即删，源文件不动。
- 生成清单的已知陷阱（本轮实测踩到）：**用 `pwsh` 管道把 `git ls-files` 喂给 `node` 时，PowerShell 会在流首插入一个 BOM**，使清单第一条（`--others` 的未跟踪文件）变成 `\uFEFFdocuments/...` 而 `existsSync` 失败、被静默跳过——实测该形态下体检输出「48 篇 md」而非「49 篇 md」，且不报任何错误。安全做法：`cmd /c "git ls-files … > list.txt"` 落盘后再读（实测无 BOM），或用 `Set-Content -Encoding ascii` 并确认首字节不是 `EF BB BF`。
- 口径边界（重要）：沙箱内 `node` 无法 spawn 子进程，**任何**由本任务执行的体检都只能覆盖「清单可枚举到的文件」；本文档本身属未跟踪文件，必须显式确认它已进入清单（上一条陷阱）后，§3 的数字才成立。

## 4. 遗留项登记（逐条处置结论）

| # | 遗留项 | 状态 | 处置结论 |
|---|---|---|---|
| R-1 | `test:smoke` 的 CI 化 | 待执行 | 先按 [framework-launch-structure.md](framework-launch-structure.md) §4.3/§6.2 改名 `local:smoke`（它需要浏览器 + 已运行的 dev 服务器，不满足 `test:*` 的「无外部前置」定义），再从 CI 排除；落点：批 3 的 `package.json` 改造与 CI 收敛（§6.2）同批 |
| R-2 | `test/dual-mode-harness/` 另案改造 | 待执行（已明确排除本轮） | [framework-decoupling.md](framework-decoupling.md) `D-22` 判「保留（本轮）」；§6.2 `T-03`/`T-04` 把它登记为共享工具的**第二轮可选消费方**。现状：其 `scripts/check-wasm-api.mjs` 与 `scripts/build-dist.mjs` 仍是独立实现，未收敛 |
| R-3 | LF-only 行尾与 [AGENTS.md](../AGENTS.md) 「行尾统一 CRLF」的矛盾 | 待执行（建议单独成批） | 实测 **71 个**被跟踪文本文件为 LF-only（受检 308 个：LF-only 71 / CRLF 236 / 混合 0），**非**早期估计的 57。**本轮不动**：批 3/4 会改到其中若干文件（`apps/viewer/src/replay/*`、`src/ts-shared/auth|tick|decoupled/*`、`.github/workflows/*` 等），先归一会制造无关 diff。处置方式沿用 [AGENTS.md](../AGENTS.md) §7.1 第 8 项先例：逐文件验证「去掉 CR 后与 HEAD 字节全等」 |
| R-4 | `documents/architecture.md:202` 的历史引述（体检工具 C 项告警） | 已闭环 | 该行自述为刻意保留的历史记载，不需修改；体检输出的 C 项按「告警」口径对待 |
| R-5 | `documents/architecture.md` 断言「`check-wasm-api.mjs` 存在于 debug / game / harness 三处」 | 待执行（批 2 后） | [framework-decoupling.md](framework-decoupling.md) §7.6 已预登为待办：批 2 落地后三处仍在，但实现变为「薄配置 + 共享引擎」，该断言的表述会失真。须在批 2 后同步 |
| R-6 | 三份 `build-dist.mjs` 收敛后 7 篇文档的行数声明与锚点回改面 | 待执行（批 3 后） | [framework-decoupling.md](framework-decoupling.md) §7.6 列出 `documents/{debug,game,viewer}/overview.md`、`documents/architecture.md`、`documents/materials.md` 等受影响的 `文件:行号` 锚点与行数声明；批 3 落地后跑一次体检并按 [AGENTS.md](../AGENTS.md) §5.3 回改。注意 `check-doc-drift.mjs` **只查越界不查错位**，须人工回看 |
| R-7 | 规范文档中「待执行」清单的状态同步 | 待执行（收口时做） | 三份规范写于代码落地之前；本表 §1 是「按提交号可核对」的唯一状态源。批 2/3/4 落地后须把规范内已完成条目改为「已执行（附提交号）」，**不得**提前把未落地项写成已执行 |

## 5. 使用约束

- **本文档不改变任何规范条文的效力**：与三份规范冲突时以规范为准，与代码冲突时以代码为准并回改本文档。
- 本文档的**行数/计数类数字**（49 篇 / 138 / 1679 / 71 等）是实测快照；新增或修改文档后必须重跑 §3 的命令并同步更新，否则会被 `check-doc-drift.mjs` 记为漂移。
