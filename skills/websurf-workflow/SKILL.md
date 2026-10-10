---
name: websurf-workflow
description: 本仓（WebSurf）agent 工作流循环：一轮从取活到收尾的完整步骤、每步的强制力、收尾命令与知识库兜底。开工前读它——不读会不知道循环怎么走、哪些步骤会被门禁挡下。
---

# WebSurf agent 工作流循环

## 一轮的循环（📖=读知识库 ✍️=写知识库 ⚙️=门禁强制）

```
开轮 ① 入口：harness 每轮注入 AGENTS.md（自动）
     ② 📖 取工作流：memory_smart_search("websurf 工作流 取活 收尾 自检") → 规则总纲
        工具不可用 → node src/scripts/kb-fallback.mjs probe → L2 HTTP 读 / L3 仓库兜底
     ③ 取活：TODO.md「未结项」挑一条 → 该行状态改「进行中」（留痕）
     ④ 认领：node src/scripts/docflow.mjs claim --task T-### --may/--must ⚙️
     ⑤ 📖 取上下文：按主题召回工程文档（线索；事实回源码核到 文件:行号）
     ⑥ 改：源码/配置/文档；只读 md 要先 approve ⚙️
     ⑦ 收尾：TODO 状态+证据+判据 ⚙️[G]
             ✍️ 写进展：close-round ①生成 → memory_save → close-round ②登记
             ⚙️ 四道门禁全 0（AGENTS §3）⇒ 提交（带 T-###）⇒ 推送
     ⑧ 维护：stale/orphan/archive_mismatch/missing/leak 非 0 ⇒ 红，必须重迁 ⚙️
```

## 每步的强制力（哪些不做会被挡）

| 步骤 | 强度 |
|---|---|
| 📖 读知识库 | **只有诱因，没有检查**：规则全文只在库里，不读就不知道细则；但不读不会失败（体检不检查「读过没」） |
| ✍️ 写新进展条目 | 靠自觉：`close-round --check-round` 会在**改了 apps/src 代码却没留痕**时挡提交（pre-commit 钩子已启用） |
| ✍️ 待补写队列 | **强制**：`progress/pending-kb.jsonl` 非空且知识库可达 ⇒ 体检 `pending` 失败 + 钩子挡提交 |
| 🔧 维护已有条目 | **强制**：stale/orphan/archive_mismatch/missing/leak 任一非 0 ⇒ `check-memory-sync` 红 |
| ⚙️ 控制层/受保护列 | **强制**：`[G]` 待办同源、docflow 受保护列、claim |
| 📖 加载技能 | 要主动调 `skill(name)`；技能内容默认不进上下文 |

## 收尾两条命令（把「写进展」压到最小）

```bash
# ① 生成条目：写归档原文 + 算 marker + 打印可直接调用的 memory_save
node src/scripts/close-round.mjs --note "<本轮正文>" --slug <名> --task T-###
# ② 登记：补台账 + 跑四道门禁 + 打印提交模板
node src/scripts/close-round.mjs --done --marker <marker> --id <memoryId>
```

改了 `apps/**` 或 `src/**`（不含 `src/scripts/**`）却没动 `TODO.md` 或没新增台账行时，`--check-round` 会挡提交。

## 知识库不可用时（三层兜底）

`node src/scripts/kb-fallback.mjs probe` 给出该走哪层：

- **L1**：`memory_*` 工具正常 → 正常走。
- **L2**：服务在、工具不在 → 读 `GET http://127.0.0.1:3113/memories?limit=1000`；写不了先落队列。服务没起 → 跑 `start-agentmemory.cmd`（probe 打印实际路径）。
- **L3**：只有仓库 → 规则从本技能 + `skills/websurf-env-traps` + **门禁脚本**重建；进展用 `kb-fallback queue` 落盘，恢复后 `plan` 回放 → `done`。

## 并发（同一工作区可能有别的 agent）

- 提交前先 `git status --short`，只 `git add` 自己改的文件；`TODO.md`/`OWNER.md` 常被双方同时改，并发方新增的行原样保留。
- `progress/memory-index.jsonl`、`skills/**` 是**共享可变资源**，没有锁：你改了技能内容，它的条目立刻 stale（体检会红）⇒ 改完技能务必重迁条目。
- `git`/`spawnSync` 在并发下会 EBUSY；`docflow sync` 失败时先把工作区收干净再重试。

## 钩子（提交门禁）

```bash
git config core.hooksPath .githooks   # 每个克隆要启用一次（本地配置，不随仓库走）
```

钩子挡两类：代码改动缺留痕、队列滞留未回放。跳过用 `git commit --no-verify` 或 `KB_HOOK=off git commit`。

## 技能注册（每台机器一次）

harness 的扫描根是这四个（源码 `dsh-skill-filesystem/lib/index.js`）：`<仓库>/.dsh/skills`、`<仓库>/.agents/skills`、`<dshHome>/skills`、`~/.agents/skills`。
**`<仓库>/skills/` 不在扫描根里** —— 它是内容源头（唯一真相），必须被注册进上面任一根才能被 `skill()` 找到：

```cmd
mklink /J "%USERPROFILE%\.agents\skills\websurf-workflow" "D:\code\projects\websurf\skills\websurf-workflow"
```

三个技能各建一次（`agentmemory-usage` / `websurf-env-traps` / `websurf-workflow`）。注册是机器本地行为，不随仓库走；新机器上先注册再开工。
