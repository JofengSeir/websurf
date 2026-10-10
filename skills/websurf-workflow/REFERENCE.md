# websurf-workflow 细则

`SKILL.md` 只给循环骨架，本文件放密集事实。判据与状态永远以 `progress/board.jsonl` 为准，本文件不作事实来源。

## 1. 每步的强制力

| 步骤 | 强度 | 机制 |
|---|---|---|
| 读知识库 | **只有诱因，没有检查** | 规则全文只在库里，不读不知道细则；但没读不会失败 |
| 写本轮进展 | 弱强制 | `close-round --check-round` 在**改了 `apps/**` 或 `src/**`（不含 `src/scripts/**`）却没留痕**时挡提交 |
| 待补写队列 | **强制** | `progress/pending-kb.jsonl` 非空且知识库可达 ⇒ 体检 `pending` 失败 + 钩子挡提交 |
| 维护已有条目 | **强制** | `stale` / `orphan` / `archive_mismatch` / `missing` / `leak` 任一非 0 ⇒ `check-memory-sync` 红 |
| 控制层与受保护列 | **强制** | `[G]` 待办同源、`docflow` 受保护列、`claim` |
| 加载技能 | 无检查 | 要主动调 `skill(<名>)`；技能内容默认不进上下文 |

## 2. 收尾两条命令

```bash
# ① 生成条目：写归档原文 + 算 marker + 打印可直接调用的 memory_save 参数
node src/scripts/close-round.mjs --note "<本轮正文>" --slug <名> --task T-###
# ② 登记：补台账 + 跑四道门禁 + 打印提交模板
node src/scripts/close-round.mjs --done --marker <marker> --id <memoryId>
```

- ①把原文落到 `archive/memory/<yyyy-MM>/progress/notes/<日期>-<名>.md`（gitignore），marker 形如 `websurf/progress/notes/....md#index0@<sha12>`。
- ②校验 marker 的 sha12 与归档原文一致才登记；重复 marker 跳过追加。
- `--check-round` 读 `git diff --name-only origin/main`（或 `--staged`），只看 `^(apps|src)/` 且排除 `src/scripts/`。
- 知识库写不进时不要停：`node src/scripts/kb-fallback.mjs queue --marker <marker> --note <正文>`。

## 3. 知识库不可用时的三层兜底

`node src/scripts/kb-fallback.mjs probe` 给结论：

- **L1（正常）**：`memory_*` 工具可用，按 `AGENTS.md` §0 的表召回、按 §5 写进展。
- **L2（服务在、工具不在）**：读走 `GET http://127.0.0.1:3113/memories?limit=1000`（判存在性比检索可靠，检索只暴露 `title`）；写不进先落队列。服务没起就跑 probe 打印的 `start-agentmemory.cmd`。
- **L3（只有仓库）**：规则从 `skills/**` + **门禁脚本**重建 —— `check-doc-drift.mjs` 的 A–P 段即文档规则、`docflow.json` 即只读/认领/审批规则、`check-memory-sync.mjs` 即台账约定；控制层照常（`progress/board.jsonl` 取活、`OWNER.md` 登记待决）。
- **当轮进展不许丢**：落 `progress/pending-kb.jsonl`，恢复后 `plan` 打印可直接调用的 `memory_save` 参数，逐条回放并补台账，再 `done --marker <marker>` 删除。

## 4. 并发（同一工作区可能有别的 agent）

- 提交前必跑 `git status --short`，只 `git add` 自己改的文件。`progress/board.jsonl` / `OWNER.md` 常被双方同时改，**对方新增的行原样保留**。

- ⚠ **`verify` 在并发工作区会误报**：它把工作区里**别人的在途改动**也算「越界改动」（实测：他人 34 个已 staged 文件 ⇒ `verify` exit 1）。并发时以「本轮 `claim` 的 `may/must` + 自己实际改的文件」自查为准，不要因 `verify` 非 0 就回退工作区。
- 绝不 `git checkout -- <文件>` 去「清干净」——会抹掉未提交成果。
- `progress/memory-index.jsonl` 与 `skills/**` 是**共享可变资源，没有锁**：改了技能内容，它的台账条目立刻 `stale`（体检会红）⇒ **改完技能务必重迁条目**。
- `git` 与 `spawnSync` 在并发下会 `EBUSY`；`docflow sync` 失败时先把工作区收干净再重试。

## 5. 提交钩子

```bash
git config core.hooksPath .githooks      # 每个克隆启用一次；本地配置，不随仓库走
```

钩子挡两类：代码改动缺留痕、待补写队列滞留未回放。跳过用 `git commit --no-verify` 或 `KB_HOOK=off git commit`。

## 6. 技能注册（每台机器一次）

harness 的扫描根只有四个（源码 `dsh-skill-filesystem/lib/index.js`）：

```
<仓库>/.agents/skills      <仓库>/.dsh/skills      <dshHome>/skills      ~/.agents/skills
```

**`<仓库>/skills/` 不在扫描根里** —— 它是内容源头（唯一真相），必须被注册进上面任一根，`skill()` 才解析得到：

```cmd
rem 必须在**仓库根**执行：`..\skills\...` 按当前目录解析，从别处跑会建出空壳 junction
mklink /J "%USERPROFILE%\.agents\skills\websurf-workflow" "%CD%\skills\websurf-workflow"
mklink /J "%USERPROFILE%\.agents\skills\websurf-env-traps" "%CD%\skills\websurf-env-traps"
```

`skills/` 下的**每个**技能目录都要各建一次，含 `skills/THIRD-PARTY.md` 列出的全部官方技能（`_shared/` 不是技能，不建）。注册是机器本地行为，不随仓库走；新机器上先注册再开工。

## 7. 相关脚本

| 脚本 | 何时用 |
|---|---|
| `src/scripts/kb-fallback.mjs` | 开轮探路；写不进时排队与回放 |
| `src/scripts/docflow.mjs` | `report` / `check` / `approve` / `sync` / `claim` / `verify` / `release` |
| `src/scripts/close-round.mjs` | 收尾留痕与 `--check-round` |
| `src/scripts/check-doc-drift.mjs` | 文档漂移体检（A–P） |
| `src/scripts/check-memory-sync.mjs` | 记忆库台账体检 |
| `src/scripts/sync-board.mjs` | 看板重迁：无参打印计划 / `--done --ids` 落台账 / `--status` 比 sha12 |
| `src/scripts/check-board-touch.mjs` | 改动的看板触碰软提示 |

## 8. 记忆库写入约定（本仓特有）

官方技能（`memory-discipline` / `remember` / `recall` / `agentmemory-mcp-tools` …）讲通用用法；下面是**本仓**在它们之上的附加约定，`skills/**` 与台账是唯一权威。

**内容写法**（只写线索，不写结论）：

```
[线索] websurf/<相对路径>#chunk0@<sha12>
主题：viewer 工程渲染器实现。符号 Renderer / RenderPass。
路径：<源相对路径>（第 1/3 段）
```

| 反例 | 为什么错 |
|---|---|
| `viewer 的 fog 参数必须与 game 端一致，否则偏色` | 是结论，未核到代码 ⇒ 违反 `AGENTS.md` §1 B3 |
| `见 renderer 第 120-145 行` | 行号会漂移 ⇒ 不存行号 |
| `应该/可能/大概` | 推测措辞，写前必须拦掉 |

**marker 格式**（幂等的核心）：

```
websurf/<相对路径>#<kind前缀><序号>@<源文件 sha256 前 12 位>
```

源文件一变 ⇒ marker 变 ⇒ 自动判 `stale`，而不是误判重复。

**幂等查重**：唯一权威是 `progress/memory-index.jsonl`（append-only）。`memory_smart_search` 只能作交叉验证，且**必须遍历返回内容断言 marker 精确出现**：实测无意义串与不存在的 marker 会返回同样的 3 条与逐位相同的分数（`1.000/0.984/0.968`），分数与命中数都不能判定存在性。

**项目隔离**：agentmemory 是**单实例共享库，语义检索与 slot 读取都无法按项目过滤**（`memory_smart_search` / `memory_recall` / `memory_slot_get` / `memory_facet_query` 都没有 `project` 参数）。四道手动闸：marker 带项目前缀、每条打 `project` facet、slot label 带项目前缀（`websurf_xxx`，不用 `persona`/`guidance` 这类通用名）、检索词带项目名并校验结果 `source` 前缀。体检看 `cross_project_leak=0`。

**删除**：必须用**真 id**。台账里的 `memoryId` 来自真实写入才可用于 `memory_governance_delete`；来自 `memory_export` 的 id 属审计重放，对它删除可能无效，会留下删不掉又占位的孤儿。
