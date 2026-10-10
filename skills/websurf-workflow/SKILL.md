---
name: websurf-workflow
description: WebSurf 仓库一轮 agent 工作流的循环骨架：取活、认领、改、收尾留痕，以及提交前必须全 0 的四道门禁。当在本仓开工、需要确认这轮工作怎么走、写本轮进展、或准备提交时使用。
user-invocable: false
---

本仓的工作流**本体**（规则细则）在 agentmemory，本技能只给循环骨架与入口。开工先读本技能，再按 `AGENTS.md` §0 的表逐条召回细则。

## Quick start

```bash
node src/scripts/kb-fallback.mjs probe      # 先问清这轮走哪一层（L1 记忆库 / L2 只读 / L3 仓库）
node src/scripts/docflow.mjs claim --task T-### --must <要改的文件>
node src/scripts/close-round.mjs --note "<本轮正文>" --slug <名> --task T-###
node src/scripts/close-round.mjs --done --marker <marker> --id <memoryId>
```

## Why

**状态永远在文件里，规则永远在记忆库。** 不读细则不会当场失败（没有门禁能检查「你读过没」），但收尾一定被挡下：门禁查的是「改了有没有留痕」，而留痕的格式定义在细则里。

## Workflow

一轮的循环。标 `(读库)` 的步走记忆库，标 `(写库)` 的要落台账，标 `(门禁)` 的不过就提交不了。

1. 入口：harness 每轮注入 `AGENTS.md`，它只说「去哪取」。
2. `(读库)` 取工作流总纲：`memory_smart_search("websurf 工作流 取活 收尾 自检")`；返回的第 1 条是总纲，按它列的主题词逐条取细则。
2.5. **看板没有对应条目**（owner 提的新功能 / 新发现的缺陷）⇒ **先立一行 `T-###`**（下一个空闲号：`T-` + 现有最大号 +1，`progress/control-ids.json` 可查占用），写全 `type/owner/status=进行中 · <agent> · <日期>/evidence/detail/criteria`，**再**走下一步。直接改代码不立行 = 无痕改动，钩子会挡提交。
3. 取活：**读知识库看板** `memory_smart_search("websurf 待办看板 取活")`（条目标题「待办看板（活动板）」，列全部未结项）挑一条；库不可用时读 `progress/board.jsonl`，按 `status ∉ {已记录, 已结案}` 筛。挑定后把该行的 `status` 改成 `进行中 · <agent> · <YYYY-MM-DD>`（改的是 board.jsonl，改完**必须重迁入库**，否则 `check-memory-sync` 因 sha12 失配报红）。
4. `(门禁)` 认领：`docflow.mjs claim --task T-### --may/--must`；`claim` 之后必须真的改过 `must` 文件，`verify` 才通过。
5. `(读库)` 取上下文：按主题召回工程文档。**召回是线索不是事实**，结论必须回源码核到 `文件:行号`；核不到就标 `[待确认]` 停下上报。
6. 改：源码 / 配置 / 文档。`skills/**/SKILL.md`、`AGENTS.md`、根 `README/CONTRIBUTING/SECURITY`、`.github/**/*.md` 属只读类，走 `approve → 改 → sync` 三步闭环。
7. `(写库)` `(门禁)` 收尾：`progress/board.jsonl` 补状态 + 证据 + 判据 → `close-round` ①生成条目、②写库并登记台账 → 四道门禁全 0 → 提交（信息带 `T-###`）。
8. `(写库)` 维护：`check-memory-sync` 的 `stale` / `orphan` / `archive_mismatch` / `missing` / `leak` 任一非 0 即为红，必须重迁，不许绕过。

## Anti-patterns

WRONG：先改代码，收尾时再补 `progress/board.jsonl` 与进展条目。

RIGHT：开轮先在 `progress/board.jsonl` 留状态、`claim` 拿许可；改动完成后立刻用 `close-round` 两条命令收尾。改了 `apps/**` 或 `src/**`（不含 `src/scripts/**`）却没有留痕时，`close-round --check-round` 会直接挡住提交（pre-commit 钩子已启用）。

WRONG：把召回结果当结论写进代码或文档。

RIGHT：召回只用来定位「读哪份文件」，事实一律回源码核到 `文件:行号`。

WRONG：体检红灯时先提交、后补。

RIGHT：体检与提交串成一步（`&&`），红灯即终止；本仓出过红灯提交。

## Checklist

- 开轮确认过知识库在哪一层（`kb-fallback probe`），并知道写不进去时落哪。
- `progress/board.jsonl` 该行有「进行中 · \<agent\> · \<日期\>」留痕，`claim` 已通过。
- 只读类文件走完了 `approve → 改 → sync`，没有留下未落实的审批。
- 四道门禁全 0：`check-doc-drift.mjs` / `check-memory-sync.mjs` / `check-memory-sync.mjs --keys` / `docflow.mjs check`。
- 提交信息带 `T-###`；纯格式类改动写「无待办影响」。

## See also

- `websurf-env-traps`：本仓环境与流程陷阱，开工前读。
- `memory-discipline`：记忆库读写时机（官方技能）。
- `agentmemory-mcp-tools`：记忆库工具索引与参数（官方技能）。

## Reference

每步的强制力矩阵、`close-round` 两条命令详解、知识库三层兜底、并发约定、提交钩子、技能注册：见 REFERENCE.md。
