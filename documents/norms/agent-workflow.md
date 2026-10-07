# Agent 工作流规范（跨工具统一）

> 本文件是**项目通用 agent 任务流程的唯一规范正文**，对所有 agent 工具生效。
> 各工具入口文件（`AGENTS.md` / `CLAUDE.md` / `GEMINI.md` / `.cursor/rules/project.mdc` / `.clinerules/00-agent-workflow.md` / `.windsurfrules` / `.github/copilot-instructions.md`）内嵌的「工作流核心」块**由脚本从本文件生成**；要改规则，改本文件的块 + 跑生成器，不要手改各入口。

## 1. 工具入口矩阵

| 工具 | 自动读取的入口 | 覆盖方式 |
|---|---|---|
| Codex | `AGENTS.md` | 原生 |
| DSH | `AGENTS.md` | 原生 |
| opencode | `AGENTS.md`（无该文件时回退 `CLAUDE.md`） | 原生 |
| Claude Code | `CLAUDE.md` 或 `AGENTS.md` | 原生 + 薄适配 |
| Cursor | `AGENTS.md`、`.cursor/rules/*.mdc`、`.cursorrules`（旧式） | 原生 + 薄适配 |
| Cline / Roo Code | `.clinerules/`、`.cline/rules/`、`.cursorrules`、`.windsurfrules`、`AGENTS.md` | 原生 + 薄适配 |
| Windsurf | `AGENTS.md`、`.windsurfrules`、`.windsurf/rules/` | 原生 + 薄适配 |
| GitHub Copilot（VS Code） | `.github/copilot-instructions.md` | 薄适配 |
| Gemini CLI | `GEMINI.md` | 薄适配 |
| zcode | 未纳入（owner 2026-10-07 确认不追） | 该工具只能读到 `AGENTS.md` 等通用入口 |
| workbuddy | 未纳入（owner 2026-10-07 确认不追） | 记忆区 `.workbuddy/memory/**` 不是规则入口；只能读到通用入口 |

「薄适配」= 文件内**不含规则正文**，只内嵌与其它入口逐字节相同的「工作流核心」块，并指向本文件。

## 2. 唯一事实来源

| 问题 | 唯一去处 |
|---|---|
| 待办与它们的**状态** | 根 `TODO.md`（`T-###`，ID 永不复用，六值状态） |
| 历史进展与过程记录 | `progress/`（`TODO.md` 与文档不复制其内容） |
| 当前事实断言 | `documents/`（源码为唯一依据） |
| 规范与流程 | 本文件；硬禁令与自检命令另有根 `AGENTS.md` §1/§5 |
| 一次性脚本与验证产物 | `.tmp/`（gitignore，不入库） |

**任何文档、注释、提交信息都不得成为第二处状态源**：需要引用时写「见 TODO.md T-###」。

## 3. 开工流程

1. **读待办**：`TODO.md` 的「未结项」——确认本次要动的条目，或为新增项先建 `T-###`。
2. **定范围**：一条待办 = 一次可独立验收的改动；跨模块的大项先拆成多条。
3. **取证**：只认当前源码、构建脚本、配置与实际命令输出；代码历史可作线索，不作结论依据。
4. **改**：文档与代码就地重写，禁止 `xxx-v2.md` 这类并存稿。
5. **自检**：见 §5，全部为 0 才算过。
6. **收尾**：同一提交里更新 `TODO.md` 对应行（状态/更新日期）；进展记入 `progress/`。

## 4. 禁令与停线

**三条硬禁令**（违反即返工）：禁以旧注释为依据；禁以旧文档为依据；禁推测（无法在代码中定位的结论标 `[待确认]` 并停下上报）。

**六类必须停下上报**：① 代码自相矛盾；② 疑似代码缺陷（只记录不修）；③ 文档断言无法在代码中定位；④ 锚点越界且无法判断指向；⑤ 需改代码/构建配置才能让文档成立；⑥ 涉及夹具、依赖锁、CI 配置。

上报后文件保持未提交；不得带 `[待确认]` 进入提交。

## 5. 自检与门禁

```
node src/scripts/check-doc-drift.mjs     # 行数声明漂移 / 锚点越界 / 路径失效 / 坏链 / 行尾 / 待办同源
node src/scripts/check-agent-entrypoints.mjs   # 各工具入口的「工作流核心」块与规范逐字节一致
cargo check -p websurf-phys              # 或工程内 cargo check
cd apps/<app> && npm run typecheck       # TS 侧
```

CI 侧：`.github/workflows/doc-drift.yml`（文档门）、`ci-gates.yml`（编译与测试门）、`deploy-pages.yml`（部署）。

## 6. 提交约定

- 一事一提交；提交信息写清**事实来源、自检命令、遗留项**。
- 改代码或做裁决的**同一提交**更新 `TODO.md`。
- 禁止把构建产物、`.tmp/`、夹具、密钥入库。

## 7. 过程产物与临时区

- 一次性脚本、验证截图、探针输出一律放 `.tmp/`（已 gitignore），新脚本用 `_` 前缀命名。
- 任务书、拆分计划等过程文档放 `.tmp/`，不入库；要长期保留的结论写进 `documents/`。

## 8. 本文件与各入口的维护

- 唯一手改处是**本文件**；`.tmp` 之外不得手改各入口的「工作流核心」块。
- 改完跑：`node src/scripts/gen-agent-entrypoints.mjs` 生成 → `node src/scripts/check-agent-entrypoints.mjs` 校验（0 不一致）。
- 新增工具适配：在本表登记 → 在生成器的 `TARGETS` 增加一项 → 重新生成并校验。

<!-- AGENT-WORKFLOW-CORE:BEGIN -->
## 工作流核心（跨工具统一，必读）

1. **待办只在一处**：根 `TODO.md` 的 `T-###` 是唯一待办与状态来源；开工先看它的「未结项」，收尾在同一提交更新对应行。文档与注释只写技术事实，或写「见 TODO.md T-###」。
2. **三条硬禁令**：禁以旧注释为依据；禁以旧文档为依据；禁推测——无法在代码中定位的结论标 `[待确认]` 并停下上报。
3. **事实来源**：当前源码、构建脚本、配置，以及 `cargo check` / `npm run typecheck` / 漂移体检的实际输出；代码历史只作线索。
4. **自检不绿不提交**：`node src/scripts/check-doc-drift.mjs` 与 `node src/scripts/check-agent-entrypoints.mjs` 全部为 0，改动涉及的工程 `npm run typecheck` 通过。
5. **过程产物进 `.tmp/`**（不入库）；进展记 `progress/`，不回写正文。
> 完整流程见 `documents/norms/agent-workflow.md`。
<!-- AGENT-WORKFLOW-CORE:END -->
