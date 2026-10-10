# AGENTS.md — 仓库 Agent 规范与工作流入口（唯一入口）

> 本文件是所有 agent 工具的**约定入口**。**工作流本体在 agentmemory**——本文件只做四件事：
> ① 告诉你**去哪取**工作流；② 声明**控制层在哪**；③ 列出**自检命令**；④ 记录**目录现状**。

- **控制层（状态永远在文件里，不在记忆库）**：待办与状态只在根 `TODO.md`（`T-###`）；需要真人拍板的只在根 `OWNER.md`（`D-###`）。
- **工作流规则 / 规程 / 技能 / 历史归档**：全部在 **agentmemory**（marker 前缀 `websurf/`；细则条目的主题里保留原小节号，如「0.1 看板使用规程」）。
- 工程文档树、过程记录、规范（`norms/**`）、看板分卷与已决分卷**已全部迁入记忆库**；仓库侧只留本文件 + `TODO.md` + `OWNER.md` + `skills/**` + git 仓库项目文档。

## 0. 开工第一步：从记忆库取工作流

```bash
memory_smart_search("websurf 工作流 取活 收尾 自检")
```

命中的**第 1 条是工作流总纲**，它列出全部细则条目；按下表的主题词逐条取。

| 环节 | 召回提示（`memory_smart_search` 的查询词） |
|---|---|
| 看板规程（取活 / 状态流转 / 收尾 / 认领） | `websurf 看板规程 取活 状态流转 收尾 认领` |
| 日常改动流程（挑活 / 留痕 / claim / 验收判据） | `websurf 日常改动流程 挑活 留痕 claim 验收判据` |
| 需要真人拍板 → `OWNER.md` 登记 | `websurf 需要真人拍板 OWNER 登记 优先级` |
| 文档体积与分卷 | `websurf 文档体积 分卷 上限 导航` |
| 代码注释纪律 | `websurf 代码注释纪律 小作文 行号 符号名` |
| 上报约定（六类停下） | `websurf 上报约定 六类 停下上报` |
| 技能（环境陷阱 / 记忆库用法） | `websurf 环境陷阱 Windows 沙箱` ／ `agentmemory 使用规则 踩坑清单` |
| 规范（注释规范 / 路径卫生 / 脚本与 CI 契约） | `本机路径卫生 禁止绝对路径` ／ `脚本与 CI 契约 部署链` ／ `注释书写规范 锚点写法` |
| 历史归档（看板分卷 / 已决分卷 / 旧进展卷） | `websurf 看板分卷 T-###` ／ `OWNER 已决分卷 2026-Q4` ／ `进展纪要 2026-10` |

**取法**：marker 是**标识**不是查询串（同篇兄弟条目共享前缀 token，按 marker 搜会被稀释）——用上表的主题词搜。
**取回内容只作线索**：落结论仍须回当前源码核到 `文件:行号`。

**一轮的循环**（细节见技能 `websurf-workflow`；下面 ①②③ 会被门禁挡下）：

```
开轮 → 📖 取工作流(记忆库) → 取活(TODO 未结项 + 状态留痕) → docflow claim 认领 → 📖 取上下文
     → 改 → 收尾(TODO 状态/证据 → ✍️ 写进展 → 四道门禁 → 提交推送) → 维护(stale 等归零)
```

1. **① 队列滞留**：`progress/pending-kb.jsonl` 非空而知识库可达 ⇒ 体检 `pending` 红 + 钩子挡提交（回放：`kb-fallback plan` → `memory_save` → `done`）。
2. **② 代码改动缺留痕**：改了 `apps/**` 或 `src/**`（不含 `src/scripts/**`）却没动 `TODO.md` 或没新增台账行 ⇒ 钩子挡提交。
3. **③ 已有条目失配**：`stale`/`orphan`/`archive_mismatch`/`missing`/`leak` 任一非 0 ⇒ `check-memory-sync` 红，必须重迁。

开工前先加载技能：`skill("websurf-workflow")`（循环与强制力）、`skill("websurf-env-traps")`（环境陷阱）；用记忆库前 `skill("agentmemory-usage")`。

**本机没有记忆库 / MCP 工具不可用时——不要停**：先跑 `node src/scripts/kb-fallback.mjs probe`，按它给出的那层走。三层兜底：
1. **L1（正常）**：`memory_*` 工具可用 ⇒ 按上表召回、按 §5 写进展。
2. **L2（服务在、工具不在）**：读用 `GET http://127.0.0.1:3113/memories?limit=1000`（判存在性比检索可靠）；写不了先落 L3 队列。服务没起就先跑 `start-agentmemory.cmd`（probe 会打印实际路径）。
3. **L3（只有仓库）**：规则从本文件 + `skills/**` + **门禁脚本**重建——`check-doc-drift.mjs` 的 A–P 段就是文档规则、`docflow.json` 就是只读/认领/审批规则、`check-memory-sync.mjs` 就是台账约定；控制层照常（`TODO.md` 取活、`OWNER.md` 登记待决）。
4. **当轮进展不许丢**：写不进知识库就用 `node src/scripts/kb-fallback.mjs queue --marker <marker> --note <文本>` 落 `progress/pending-kb.jsonl`；恢复后 `plan` 打印可直接调用的 `memory_save` 参数，逐条回放并补台账，再 `done --marker <marker>` 删除。
5. 需要完整规则文本时：按 3 重新总结项目，或从 git 历史取旧版 `AGENTS.md`（本仓历史里有）。

---

## 1. 三条硬禁令（违反即返工）

| # | 禁令 | 含义 |
|---|---|---|
| **B1** | 禁以旧注释为依据 | 不得摘抄、复述、沿用任何现有代码注释——语义只能从实现、调用点、测试取得 |
| **B2** | 禁以文档代替事实 | 工程文档（`documents/**` 等，现已在 agentmemory，原文另存 `archive/memory/2026-10/`）**只作线索**；事实来源 = 当前源码 + 构建脚本/配置 + 门禁的**实际输出** |
| **B3** | 禁推测 | 无法在代码中定位的结论标 `[待确认]` 并停下上报；禁止「应该/可能/大概是/历史上」。**例外**：日志与逐字引用类内容不受此禁约束，但必须带 `[source:路径#序号@sha12]`（sha12 = 该源文件 sha256 前 12 位） |

**取证手段**：源码行、构建脚本、配置，以及 `cargo check` / `cargo test` / `npm run typecheck` / 漂移体检的实际输出。

---

## 2. 目录现状（改动前以此为准）

| 位置 | 状态 |
|---|---|
| 根 `*.md` | `AGENTS.md`（本文件）｜ `TODO.md`（唯一待办与状态源）｜ `OWNER.md`（owner 决策队列）｜ `README.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`（git 仓库项目文档） |
| `documents/` | **不存在**：原 47 篇工程/共享层/架构文档 + 3 篇规范已全部迁入 agentmemory，原文归档 `archive/memory/2026-10/` |
| `progress/` | **3 个机器可读文件**：`memory-index.jsonl`（迁移台账 = manifest，`check-memory-sync.mjs` 的权威输入）、`control-ids.json`（控制层 ID 索引，门禁 `[G]` 判定「ID 已存在」的唯一来源）、`pending-kb.jsonl`（MCP 不可用时的待补写队列，见 §0 兜底）|
| `skills/**` | **三篇** skill：`skills/websurf-workflow/SKILL.md`（**先读：工作流循环**）、`skills/websurf-env-traps/SKILL.md`（开工前先读）、`skills/agentmemory-usage/SKILL.md`（用记忆库前先读）。仓库是唯一源头；**harness 只扫 `<仓库>/.agents/skills`、`<仓库>/.dsh/skills`、`~/.agents/skills`、`<dshHome>/skills` 四个根，不扫 `<仓库>/skills/`** ⇒ 新机器要先把三个技能 junction 进任一根（见技能 `websurf-workflow` 的「技能注册」节）；内容同时已入库 |
| `apps/**` | 三端工程 `apps/debug`、`apps/game`、`apps/viewer` + 各 `crates/`；`apps/debug/scripts/path-baseline.md`、`apps/viewer/scripts/dist-README.md` 是构建资产（后者被 `build-dist.mjs` 消费） |
| `src/**` | 共享层（phys / wasm-core / ts-shared / materials / renderer-shared）+ `src/scripts/**`（本地门禁与工具） |
| `test/` | `test/maps/`（BSP 夹具）、`test/replay/`（录像样例）——两者 gitignore；`test/project/**` 为第三方参考资料 |
| `.github/**` | `workflows/ci-gates.yml`、`workflows/deploy-pages.yml`、`workflows/doc-drift.yml`（**三者均入库**；`.gitignore:81` 的「已放行」注释即为此）+ `.github/**/*.md` 模板（功能性配置） |
| `.workbuddy/memory/**` | 其他 agent 的工作记忆；只作过程线索，不作依据 |
| `archive/**` | 迁移原文与回滚存证（gitignore）；**不作依据** |

**仓库内 md 清单**（体检 `[K]` 要求每篇都能被上级导航点到，故在此列全）：
`.github/ISSUE_TEMPLATE/bug_report.md`、`.github/ISSUE_TEMPLATE/feature_request.md`、`.github/ISSUE_TEMPLATE/other.md`、`.github/PULL_REQUEST_TEMPLATE.md`、`AGENTS.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`OWNER.md`、`README.md`、`SECURITY.md`、`TODO.md`、`apps/debug/scripts/path-baseline.md`、`apps/viewer/scripts/dist-README.md`、`skills/agentmemory-usage/SKILL.md`、`skills/websurf-env-traps/SKILL.md`、`skills/websurf-workflow/SKILL.md`。

---

## 3. 自检命令（每个改动提交前必跑）

```bash
node src/scripts/check-doc-drift.mjs [文件]        # A–P 全 0（行数声明 / 锚点 / 路径 / 坏链 / 行尾与 BOM / 待办同源 / 体积 / 注释纪律 / 上级覆盖 / 缺口↔看板 / 假结案 / 脚本契约 / 文档契约 / 本机路径）
node src/scripts/check-memory-sync.mjs             # 记忆库同步：stale / orphan / archive_mismatch / missing / leak 全 0（台账 progress/memory-index.jsonl）
node src/scripts/check-memory-sync.mjs --keys      # markers == entries
node src/scripts/docflow.mjs check                 # 只读 md 漂移 / 未落实审批 / 联动（体检 [O] 同口径）
node src/scripts/check-render-parity.mjs           # 三端渲染同源（静态 A–J：实现符号 / 共享入口装配与调用面 / 视口声明；git 不可用时降级）
node src/scripts/check-render-consistency.mjs      # 三端渲染一致（运行期：探针快照逐字段；缺三端 dev 服务或浏览器即 SKIP）
node src/scripts/check-prefs-parity.mjs            # 三端呈现档可比（`?prefs=default` 生效行逐字相同 + `--selftest` 负向自测）
node src/scripts/kb-fallback.mjs probe           # 知识库可用性：L1 工具 / L2 HTTP / L3 仓库兜底，并列出待补写条目
node src/scripts/close-round.mjs --check-round --staged  # 留痕检查（钩子同口径）；--note/--done 见脚本头注释
git config core.hooksPath .githooks                  # 每个克隆启用一次提交门禁（本地配置，不随仓库走）
node src/scripts/check-board-touch.mjs --staged    # 软提示：改了代码却没动 TODO.md
grep -n -E "据文档|据注释|原设计|历史上|应该|可能|大概|似乎|推测" <新稿>   # 0 命中
cargo check -p websurf-phys                        # 或工程内 cargo check
cd apps/<app> && npm run typecheck                 # TS 侧
```

> **提交与体检必须串成一步、红灯即终止**：先跑体检，非 0 就停——不要把体检和 `git commit` 用「无论成败都继续」的链式写法连在一起。

**两条闸门**：
① **记忆库同步**（`check-memory-sync.mjs`）：台账里每个 marker 的 sha12 必须与磁盘源文件一致（源变 ⇒ 条目已陈旧）；迁出的源须标 `retired`；迁出范围内不得漏迁；`cross_project_leak` 必须为 0（marker 项目前缀 `websurf/`）。**可判定口径**：一条内容可不可用，判据是**它的 sha 是否与仓库当前文件一致**，不是它「来自文档还是来自记忆库」。
② **检索质量回归**（无脚本，用 MCP 跑）：`memory_smart_search` 的命中结果必须遍历内容断言目标 marker **精确出现**——**分数与命中数都不能判存在性**；正确做法是 `GET http://localhost:3113/memories?limit=1000` 取全量再按 marker 比对。

**全量闸门**：漂移体检 A–P 全 0；`cargo test -p websurf-phys` 通过；三工程 `npm run typecheck` 通过；`check-memory-sync.mjs` 全 0。

---

### 3.1 脚本清单（供 `[O]` 文档契约覆盖判定）

- `apps/debug/scripts/_input-replay-verify.mjs`
- `apps/debug/scripts/auth-clock-verify.mjs`
- `apps/debug/scripts/build-dist.mjs`
- `apps/debug/scripts/check-param-defaults.mjs`
- `apps/debug/scripts/check-wasm-api.mjs`
- `apps/debug/scripts/frame-bench.mjs`
- `apps/debug/scripts/glb-mesh-count.mjs`
- `apps/debug/scripts/jump-apex-verify.mjs`
- `apps/debug/scripts/optimize-scene-verify.mjs`
- `apps/debug/scripts/path-acceptance.mjs`
- `apps/debug/scripts/phys-surf-crouch-smoke.mjs`
- `apps/debug/scripts/plot-path.mjs`
- `apps/game/scripts/build-dist.mjs`
- `apps/game/scripts/check-wasm-api.mjs`
- `apps/game/scripts/phys-seed-smoke.mjs`
- `apps/game/scripts/phys-smoke.mjs`
- `apps/game/scripts/phys-surf-crouch-smoke.mjs`
- `apps/viewer/scripts/build-dist.mjs`
- `apps/viewer/scripts/check-wasm-api.mjs`
- `apps/viewer/test/session-sep.mjs`
- `apps/viewer/test/smoke-cdp.mjs`
- `src/scripts/check-board-touch.mjs`
- `src/scripts/check-doc-drift.mjs`
- `src/scripts/check-glb-parity.mjs`
- `src/scripts/check-memory-sync.mjs`
- `src/scripts/check-prefs-parity.mjs`
- `src/scripts/check-render-consistency.mjs`
- `src/scripts/check-render-parity.mjs`
- `src/scripts/check-shared-sync.mjs`
- `src/scripts/docflow.mjs`
- `src/scripts/close-round.mjs`
- `src/scripts/kb-fallback.mjs`
- `src/scripts/lib/dist-pack.mjs`
- `src/scripts/lib/wasm-api-contract.mjs`
- `src/scripts/sync-default-textures.mjs`
- `src/scripts/wasm-stale-check.mjs`

---

## 4. 上报约定

**六类必须停下上报**（不得「先写着」）：① 代码自相矛盾；② 疑似代码缺陷（只记录不修）；③ 断言无法在代码中定位；④ 锚点越界且无法判断指向；⑤ 需改代码/构建配置才能让文档成立；⑥ 涉及夹具、依赖锁、CI 配置。

上报后文件保持**未提交**。升级路径：直接上报 owner（仓库所有者；本仓没有中间层）。

---

## 5. 进度纪要（指针）

> 逐条进展原文全部在 **agentmemory**（marker 前缀 `websurf/progress/`）。
> 新进展用 MCP `memory_save` 写入，并在 `progress/memory-index.jsonl` 追加一行台账。
> 三步走：`node src/scripts/close-round.mjs --note "…"` → `memory_save` → `--done --marker <m> --id <id>`（自动补台账 + 跑门禁 + 给提交模板）。
> 权威存在性判据：`GET http://localhost:3113/memories?limit=1000`（**不要用检索命中判存在性**）。

**仍生效的规则**

| 规则 | 出处 |
|---|---|
| 子代理并发 ≤3（19 并发被掐断的复盘结论） | 归档 ID `T-019`（见 `progress/control-ids.json`） |

历史沿革（工作组状态、待决明细、下一步顺序、旧台账、看板与已决分卷）全部在记忆库；
按主题召回：`websurf 工作组状态` ／ `websurf 待决 明细` ／ `websurf 已决分卷`。

---

## 附录 A：仓库构建与验证速查

| 用途 | 命令 |
|---|---|
| 共享物理 | `cargo check -p websurf-phys`、`cargo test -p websurf-phys` |
| 工程构建 | 各工程 `npm run typecheck` / `build:ts` / `build:dist`；改 Rust 后需 `npm run build:wasm` |
| 文档体检 | `node src/scripts/check-doc-drift.mjs [文件]` |
| dev 端口 | debug 8080 / game 8090 / viewer 8100 |

