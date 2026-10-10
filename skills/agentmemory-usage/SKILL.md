---
name: agentmemory-usage
description: 使用本地 agentmemory 记忆库（MCP）时必须遵守的规则：写入/检索的判定口径、marker 与台账约定、配置踩坑、以及「哪些内容不该入库」。用记忆库前读它——判存在性、判召回质量、决定内容该不该入库都靠这里的口径；细则在 REFERENCE.md。
user-invocable: false
---

本技能是本仓**唯一**的 agentmemory 使用守则。`skills/third-party/` 下的是上游官方技能（原样复制、不得就地修改，见 `skills/third-party/THIRD-PARTY.md`）。

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

1. **R1 召回的 M 内容是「线索」不是「事实」**：结论必须回源码核到 `文件:行号`，核不到就标 `[待确认]` 停下上报。
2. **R2 绝不把 `文件:行号` 存进记忆库**：行号会随文档插入漂移；引用写「路径 + 符号名/小节名」，不写行号。
3. **R3 不迁控制层原件与现行宪法**：`AGENTS.md` 本体、`OWNER.md`、现行规范条文留在仓库；只有历史档案、工作流细则、技能才入库。判定口径：**仓库里仍有一份、且是唯一权威的那份，不迁**。
4. **判存在性只用权威列表接口** `GET http://127.0.0.1:3113/memories?limit=N`；`memory_smart_search` 的**分数与命中数都不能判存在**（v0.9.30 实测）。
5. **每条入库内容带 marker + 台账行**：`websurf/<源路径>#<kind><seq>@<sha12>`；源一变 sha12 失配 ⇒ `check-memory-sync` 红，必须重迁。
6. **检索质量回归**：命中结果要**遍历内容断言 marker 精确出现**，不能只看条数。
7. **工具/服务不可用不停工**：`kb-fallback probe` 给三层兜底；写不进库先落 `progress/pending-kb.jsonl` 队列，恢复后 `plan` → `memory_save` → `done`。

## Anti-patterns

WRONG：用 `memory_smart_search` 的分数或命中数判断「这条在不在库里」。
RIGHT：`GET /memories?limit=1000` 取全量、按 marker 精确比对。

WRONG：把 `文件:行号` 写进条目正文。
RIGHT：写「主题 + 符号名 + 路径（不带行号）」。

WRONG：把现行规范/控制层文件原文再存一份进库。
RIGHT：仓库那份是唯一权威；只迁历史档案、工作流细则、技能，且带 marker + 台账行。

WRONG：`status` 显示 `bm25-only` 就断定嵌入坏了（已知 bug）。
RIGHT：看 `/agentmemory/config/flags` 的 `embeddingProvider` 与 `vectorDocuments` / `pendingVectorBackfill`。

WRONG：检索没命中就断言「库里没有」，于是重复写入。
RIGHT：先按权威接口确认，再决定写不写（重复条目会稀释召回，历年事故见 REFERENCE §2）。

## Checklist

- 写入前：内容不违反 R1/R2/R3；确认是「库里真的没有」而不是「检索没命中」。
- 写入时：带 marker、`project: websurf`、补一行台账。
- 写入后：`kb-fallback probe` 比「台账行数 vs 库内 total」；`check-memory-sync.mjs` 与 `--keys` 全 0。
- 改配置时：`OPENAI_EMBEDDING_BASE_URL` **不能带 `/v1`**；同时要设 `OPENAI_API_KEY`；slots 默认关。
- 迁文档时：先判「该不该入库」（R3），再按记录边界切块（≤8192 B/块），末尾补 `#index0`。

## See also

- `websurf-workflow`：一轮工作流的循环骨架（收尾三步走、四道门禁）。
- `websurf-env-traps` §11：本机记忆栈的启动、端口与判定。
- `skills/third-party/`：上游官方技能（`memory-discipline`、`remember` / `recall` / `forget`、`agentmemory-mcp-tools` / `-config` / `-rest-api` / `-architecture` / `-hooks` / `-agents` 等），原样复制、不改。

## Reference

治理理念（0.5.x 十一节）、marker 格式、内容写法正反例、配置三坑、`status` bug、无 pin/版本机制、入口分层、跨工程同名、默认关闭的功能、操作清单、项目隔离、启动与生命周期、权威判定方法与兜底：见 REFERENCE.md。
