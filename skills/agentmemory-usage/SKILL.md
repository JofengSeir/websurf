---
name: agentmemory-usage
description: 使用本地 agentmemory 记忆库（MCP）时必须遵守的规则：写入/检索的判定口径、marker 与台账约定、配置踩坑、以及「哪些内容不该入库」。用记忆库前读它——判存在性、判召回质量、决定内容该不该入库都靠这里的口径；细则在 REFERENCE.md。
user-invocable: false
---

本技能是本仓**唯一**的 agentmemory 使用守则。`skills/agentmemory-usage/` 下的是上游官方技能（原样复制、不得就地修改，见 `skills/agentmemory-usage/THIRD-PARTY.md`）。

## Quick start

```bash
node src/scripts/kb-fallback.mjs probe        # 这轮走哪层：L1 工具 / L2 HTTP / L3 仓库兜底
node src/scripts/sync-board.mjs --status      # 看板 sha12 是否与台账一致
curl -s http://127.0.0.1:3113/agentmemory/config/flags   # 嵌入与开关的当前值
curl -s 'http://127.0.0.1:3113/memories?limit=1'          # 权威存在性判据的接口
```

写入三步（本仓唯一合法形状）：`close-round.mjs --note` → `memory_save` → `close-round.mjs --done --marker <m> --id <id>`。

## Why

记忆库是**单实例共享库**（跨工程、没有自动隔离、**没有 pin / 版本机制**），所以「写什么、怎么写、怎么判存在」必须是硬规则。靠 agent 自觉必然失效——这是结构问题，不是态度问题。

## Workflow（红线优先）

0. **R0 检索入口与预算（先读，省钱的第一条）**：
   - **默认用 `memory_smart_search`**（技能现在的用法）：它天然返回 compact 列表（obsId/score/title/type），
     `limit=10` 实测约 **1.1k** 真实 token —— 便宜、够用。
   - **要用 `memory_recall` 就必须显式传参**：`format:"compact"` + `token_budget`。
     它的**默认值是 `format:"full"` 且不带预算**，实测一次 **≈33k** 真实 token（25k–49k）。
     **绝不调用默认参数的 `memory_recall`。**
   - `memory_smart_search` **没有** `format` / `token_budget` 参数（schema 只有 query/expandIds/limit）——
     别试图给它传预算；要控预算就换 `memory_recall`。
   - 需要正文时按 marker/id **定点取**，不要用"召回一把捞全文"。
1. **R1 召回的 M 内容是「线索」不是「事实」，但"核不到源码"要分清两种情形**：
   - 源**仍在仓库** ⇒ 结论必须回源码核到 `文件:行号`；核不到就标 `[待确认]` 停下上报。
   - 源**已迁出仓库**（`retired: true`，或 marker 的源路径在仓库里不存在）⇒ **库内那份就是权威存本**
     （2026-10-12 裁定：全文入库）。这类约占 **319/349 = 91.4%**，**回仓库核不到是预期**，
     不是异常、也不要因此标 `[待确认]`；要看内容就按 id 取，要判新旧就看 marker 的 sha12。
   - 判"源在不在"的权威办法：`check-memory-sync.mjs` 输出的 `stale`/`archive_absent`，或直接看 marker 源路径是否存在。
2. **R2 绝不把 `文件:行号` 存进记忆库**：行号会随文档插入漂移；引用写「路径 + 符号名/小节名」，不写行号。
   **约束对象是「新写入的结论型条目」**（errata / 交互条目）。存量 **226 条含行号**里 **210 条是批量迁移产物固有**
   （`kind ∈ {chunk,index}`，带 sha12 用于检测过期），**不是违规**，不要试图去改它们。
3. **R3 不迁控制层原件与现行宪法**：`AGENTS.md` 本体、`OWNER.md`、现行规范条文留在仓库；只有历史档案、工作流细则、技能才入库。
   判定口径：**仓库里仍有一份、且是唯一权威的那份，不迁**。（注意：判"仓库里还有没有一份"必须现在去看，
   不要假设历史迁移过的文档还在仓库——`documents/**`、`progress/**` 的相当一部分**已经不在仓库**了。）
4. **判存在性只用权威列表接口** `GET http://127.0.0.1:3113/memories?limit=N`；`memory_smart_search` 的**分数与命中数都不能判存在**（v0.9.30 实测）。
5. **每条入库内容带 marker + 台账行**：`websurf/<源路径>#<kind><seq>@<sha12>`；源一变 sha12 失配 ⇒ `check-memory-sync` 红，必须重迁。
6. **检索质量回归**：命中结果要**遍历内容断言 marker 精确出现**，不能只看条数。
7. **工具/服务不可用不停工**：`kb-fallback probe` 给三层兜底；写不进库先落 `progress/pending-kb.jsonl` 队列，恢复后 `plan` → `memory_save` → `done`。

## 本机能力边界（开工前必须知道）

- **MCP 工具**：✅ 可用（54 个 `mcp__agentmemory__*`）。
- **自动捕获（观测层）**：✅ **已接线**（2026-10-12 手工装 `@deepseek-ai/dsh-hooks-claude-code`），
  **待 DSH 重启后生效**。生效后 `SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`Stop` 会自动写观测，
  `handoff` / `recap` / `session-history` / `commit-context` / `lesson` 这些依赖观测层的技能才有数据。
  接线前观测层是空的（`observations = 0`），别再从那里找上下文。
  默认**零 token**（`AGENTMEMORY_INJECT_CONTEXT` 关）；要看是否真的在采，查 `GET /agentmemory/status` 的 `capture.sinceStart`。
- 不确定观测层现在有没有数据时：先 `GET http://127.0.0.1:3113/agentmemory/status` 看 `index.observations`，别猜。
- **本仓的过程记录仍走人工通道**：`close-round --note` → `memory_save` → `close-round --done`（落 `progress/memory-index.jsonl` 台账）。

## 写入时的两条硬要求（2026-10-12 新增）

1. **过闸 B**：`close-round --done` 已内置（台账追加前调 `check-kb-gate.mjs --row-file`；非 0 即拒写）。
   新条目的分档上限：`chunk`/`errata` ≤ **8 KiB**、`index` ≤ **16 KiB**；重迁须 `supersede` 旧条目。
2. **设语义标题（"第 1.5 步"）**：`memory_save` 之后立刻 `POST /agentmemory/evolve {memoryId, newContent: 原样, newTitle}`。
   不设的话 `title` 就是 `content` 前 80 字，而 **marker 就吃掉约 68 字符** ⇒ compact 召回里读到的是 marker 碎片，
   人/agent 都判不出相关性（实测：设标题前 **50%** 的召回结果 title 里一个查询词都没有，设了 50 条后降到 **22.2%**）。
   `close-round --note` 现在会直接打印建议的 `newTitle`。闸 B 也会对 `title-not-semantic` 出告警。

## Anti-patterns

WRONG：用 `memory_smart_search` 的分数或命中数判断「这条在不在库里」。
RIGHT：`GET /memories?limit=1000` 取全量、按 marker 精确比对。

WRONG：把 `文件:行号` 写进条目正文。
RIGHT：写「主题 + 符号名 + 路径（不带行号）」。

WRONG：把现行规范/控制层文件原文再存一份进库。
RIGHT：仓库那份是唯一权威；只迁历史档案、工作流细则、技能，且带 marker + 台账行。

WRONG：`status` 显示 `bm25-only` 就断定嵌入坏了（已知 bug）。
RIGHT：看 `/agentmemory/config/flags` 的 `embeddingProvider` 与 `vectorDocuments` / `pendingVectorBackfill`。

WRONG：用 `memory_recall` 的默认参数（不传 `format`/`token_budget`）召回。
RIGHT：默认走 `memory_smart_search`；要 `memory_recall` 就显式 `format:"compact"` + `token_budget`（默认 full 一次约 33k token）。

WRONG：召回没命中就断言「库里没有」，于是重复写入。
RIGHT：先按权威接口确认，再决定写不写（重复条目会稀释召回，历年事故见 REFERENCE §2）。

WRONG：看到条目引用的源文件在仓库里不存在，就标 `[待确认]` 停下。
RIGHT：先判它是不是**已迁出**（91.4% 的条目源已不在仓库）——是的话库内那份就是权威存本，不是异常。

## Checklist

- 检索前：默认用 `memory_smart_search`；若要用 `memory_recall`，**显式** `format:"compact"` + `token_budget`。
- 写入前：内容不违反 R1/R2/R3；确认是「库里真的没有」而不是「检索没命中」。
- 写入时：带 marker、`project: websurf`、补一行台账；**过闸 B**（`close-round --done` 内置）。
- 写入后：**立刻设语义标题**（"第 1.5 步"，`POST /agentmemory/evolve`（只传 newTitle，newContent 原样回传））；`kb-fallback probe` 比「台账行数 vs 库内 total」；
  `check-memory-sync.mjs` 与 `--keys` 全 0。
- 改配置时：`OPENAI_EMBEDDING_BASE_URL` **不能带 `/v1`**；同时要设 `OPENAI_API_KEY`；slots 默认关。
- 迁文档时：先判「该不该入库」（R3），再按记录边界切块（**≤8192 B/块**），末尾补 `#index0`（≤16 KiB）。

## See also

- `websurf-workflow`：一轮工作流的循环骨架（收尾三步走含"第 1.5 步设标题"、**五道**门禁含闸 B）。
- `websurf-env-traps` §11：本机记忆栈的启动、端口与判定。
- `skills/agentmemory-usage/`：上游官方技能（`memory-discipline`、`remember` / `recall` / `forget`、`agentmemory-mcp-tools` / `-config` / `-rest-api` / `-architecture` / `-hooks` / `-agents` 等），原样复制、不改。

## Reference

治理理念（0.5.x 十一节）、marker 格式、内容写法正反例、配置三坑、`status` bug、无 pin/版本机制、入口分层、跨工程同名、默认关闭的功能、操作清单、项目隔离、启动与生命周期、权威判定方法与兜底：见 REFERENCE.md。
