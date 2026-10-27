# AGENTS.md — WebSurf 仓库作业指南

> 本文件是 agent 进入仓库的**入口文档**，规则以本文为准。
>
> - **2026-10-18 起没有强制 agent 工作流**：无看板、无 claim / close-round、无记忆库同步门禁、无 docflow。**唯一的机械钩子是 D-124 的 pre-commit 检查**（生成物路径 / `.cmd/.bat/.ps1` 的 CRLF+ASCII，见 §7-0）。旧流程的完整文件与台账在 git 历史里（原 tag `checkpoint/pre-amh-reset-20261018` 已按 owner 要求于 2026-10-27 删除，其提交 `fec9810` 仍在 main 祖先链上，`git show fec9810` 可看）。
> - 仍然成立的是工程事实：**构建与测试要过，结论要有证据，提交信息要能独立读懂。**

## 0. 开工速览

按顺序做四件事，其余按需查对应章节：

1. 加载技能 `websurf-env-traps`（见 §6）：本机 Windows 作业陷阱，开工前读。
2. `git status --short -uall`：确认没有其他 agent 的在途改动。
3. 按 §2 跑与改动相关的构建 / 类型检查，按 §4 取证据。
4. 按 §7 提交；记忆写入（可选）按 §3。

四条红线（违反会破坏别人的工作或得出错误结论）：

- **禁止**改动 `dev` 分支：日常工作线是 `main`（原 `rebuild/from-remote`，2026-10-24 起换名顶替）；`dev` 是旧实验线（原 `main`，2026-10-22 止，领先 `origin/main` 36 笔），仅 owner 可动。**agent 不自行推送**，推送由 owner 发起。
- **禁止**从 `progress/`、`documents/`、`docflow.json` 取规则或状态——它们已不存在。
- **禁止**恢复旧的 agentmemory / mcp-hub 路线（见 §3.0）。
- **禁止**用 `git checkout -- <文件>` 清理工作区（会抹掉未提交成果）。

## 1. 仓库地图

| 位置 | 内容 |
|---|---|
| `apps/debug`、`apps/game`、`apps/viewer` | 三端工程；各自是独立 npm 工程，另有 `crates/` |
| `src/phys` | 共享物理（Rust，`cargo test -p websurf-phys`） |
| `src/wasm-core` | BSP / 模型 / 材质 / 渲染导出的 wasm 核心（Rust） |
| `src/ts-shared`、`src/renderer-shared` | 共享 TS 层；three 的单实例装在仓库根 `node_modules` |
| `src/materials`、`src/web` | 材质包与共享 web 资产 |
| `src/scripts` | 本地开发/构建/流程工具：`serve.py`、`build-textures-mtz.mjs`、`copy-wasm-pkg.mjs`、`sync-web-assets.mjs`、`agent-memory.mjs`、`check-render-parity.mjs`、`capture-render.mjs`、工具链 `.cmd` |
| `test/` | `maps/`、`replay/` 夹具（gitignore，本地自备）；`project/` 第三方 SDK 参考 |
| `skills/websurf-env-traps` | 本仓 Windows 作业陷阱（开工前读） |
| `.github/workflows` | `ci-gates.yml`（构建/测试）、`deploy-pages.yml`（部署） |
| `TODO.md` | 可选的未结清单；不是门禁 |
| `OWNER.md` | 需要 owner 拍板的决定（`D-###`） |
| `.amh/`、`.dsh/` | AMH gateway 项目侧本地接入（gitignore；是否接入见 §3） |

`progress/`、`documents/`、`docflow.json` 已不存在；不要再从这些路径取规则或状态。

## 2. 构建与验证

### 2.1 Node 侧（TS / 打包 / 本地服务）

```bash
npm ci                         # 仓库根：shared 层的 three
cd apps/<app> && npm ci        # debug / game / viewer 各自装
npm run build:wasm             # wasm-pack → pkg/，并复制到 web/
npm run typecheck              # TS 类型检查
npm run build:ts               # typecheck + esbuild
npm run build:dist             # 打包 dist/（single 或 --multi）
npm run dev                    # 起本地服务（debug 8080 / game 8090 / viewer 8100）
```

### 2.2 Rust 侧

```bash
cargo check -p websurf-phys
cargo test -p websurf-phys
```

### 2.3 渲染归属（三端不得重写共享渲染步骤）

- 规则与同机位看图流程：`docs/render-parity.md`。
- 静态门禁：

```bash
node src/scripts/check-render-parity.mjs
```

### 2.4 CI

CI 跑 `.github/workflows/ci-gates.yml`：`cargo test`、viewer 的源码契约、三端 wasm 构建与 GLB 一致性。

**提交前**至少跑与改动相关的构建 / 类型检查；**没跑成功的项要在提交信息里写清楚**。

## 3. 项目记忆（AMH gateway，可选但推荐）

### 3.0 现状（2026-10-18）

- DSH profile 未装 native MCP，只能走**通道 A（项目 client）**：`client.mjs` 有 6 条命令 + `call`，能访问 48 个 native 工具；但模型看不到原生工具列表，17 个 skill 不能直调，只能按 skill 顶部提示走 `client.mjs call`。要走 B 需要 profile entry + token + 重启（B 不采用，见 §3.2）。
- **旧的独立 agentmemory / mcp-hub 路线已卸载：不要恢复。** 当前 AMH gateway 的 backend 是 agentmemory（0.9.30），只经 gateway 访问；**不要直连 `:3111` 或实例 REST**。
- AMH gateway 是项目记忆的唯一入口；细则以 `.dsh/skills/amh-memory/SKILL.md` 为准，但其中「brief/handoff 失败就停」的旧约定由 §3.1 覆盖：gateway 不可用落 `.dsh/amh-outbox`，不阻塞。
- 项目契约 `.amh/config.json`（`hub` / `binding` / `project`，本地文件，不写进仓库）。
- **新克隆的仓库里没有 `.amh/` / `.dsh/`**：`brief` 会显示 `gateway=DOWN` 并给出提示，`save` / `handoff` 自动落 `.dsh/amh-outbox/`（exit 0），不影响改代码与提交；要接记忆再按本机流程配一次 binding。工作流骨架（AGENTS / skills / docs/render-parity / `.githooks` / scripts）在仓库里，拉下来执行 `npm run hooks:install` 即可。
- 旧的 `amh-cli` / 7 工具 / marker / verify / counts 路线已删除；**`brief` 仍可用**。

### 3.1 三条命令（弱 agent 也能走通）

脚本：`src/scripts/agent-memory.mjs`。根目录也提供 `npm run agent:brief` / `agent:save` / `agent:handoff` / `agent:flush`。

| 时机 | 命令 | 说明 |
|---|---|---|
| 开工 | `node src/scripts/agent-memory.mjs brief` | 只打印 gateway 状态、HEAD/干净度、最近 3 条 handoff、最近 5 条写入、outbox 数 |
| 过程中 | `node src/scripts/agent-memory.mjs save --content "..." --type fact --concepts "area,topic" --files "src/file.ts"` | 决定 / 非显然修复落一条 |
| 收尾 | `node src/scripts/agent-memory.mjs handoff --task T-650 --status "partial" --content "..." --next "..." --files "a.ts,b.ts"` | content 必填；task/status/next 缺省会填占位值（尽量自己写清楚） |
| gateway 恢复后 | `node src/scripts/agent-memory.mjs flush`；`node src/scripts/agent-memory.mjs doctor` | 补写离线记录 / 体检 |

使用规则：

1. **不要一次读 20 条旧 handoff**：`brief` 只给最近 3 条；更早的用 `recall "<关键词>"` 按需查。旧 handoff 可能已被后续提交覆盖，必须回 `git` / 代码复核。
2. **gateway 不可用不阻塞**：`save` / `handoff` 自动把内容写到 `.dsh/amh-outbox/*.json`（gitignore），agent 继续改代码；提交信息写 `AMH: down`，gateway 恢复后 `flush`。**不要自己 start/stop AMH**。
3. **brief 失败也不阻塞**：用 `git log/status` + 代码继续，不要停在原地。
4. `--app` 默认 `dsh`；不知道应用名就用默认。**不要猜别的 token，也不要建 `amh` profile。**
5. 直接调 client 仍可用（`brief/sessions/recall/search/save/handoff/tools/call`），但推荐 wrapper：它处理 JSON 形状、outbox、摘要和失败回退。

### 3.2 通道与身份

| 通道 | 能力 | 代价 | 结论 |
|---|---|---|---|
| A. 项目 client | `client.mjs` 六条 + `call`；`call` 可访问全部 native 工具 | 模型看不到原生工具列表；每个 agent 需自己的 token 才有独立身份 | **正式路线** |
| B. native MCP | 模型直接看到 native 工具 | 需要 profile entry + token + 重启；DSH 加 `web` 会污染所有项目 | **不采用** |

- **禁止**新建 `amh` profile。
- 同一项目、同一笔写入只走一条，**不双写**。
- `binding` 定项目；`--app` / token 定 agentId。多 agent 的 action / lease / signal 必须各自 token；没有 lease 时互斥由人 / DSH 负责，**不要自己造 gate**。
- 交接格式（wrapper 已按 client 格式写，手动调用时注意）：concepts 含 `task:<id>,handoff`；content 以 `HANDOFF <task>:` 开头。
- `TODO.md` / `OWNER.md` 仍是可选任务 / 决定文件；AMH 不是状态表；`D-###` 正文以 OWNER 为准。

### 3.3 提交尾注（**必须**，文档级；不挂 commit-msg 钩子 —— D-125 2026-10-27）

代码 / 脚本改动提交时，末行**必须**带三选一（漏了不阻塞提交，但视为流程缺陷，review 时补）：

```
AMH: <memory-id>     # wrapper save/handoff 返回的 id
AMH: none            # 明确判定这次改动无需记录
AMH: down            # gateway 不可用（正文说明）
```

- **不挂 commit-msg 钩子**：尾注是**文档级必须**，不是机械门禁。缺尾注不阻塞提交；**不要**为了「守规矩」去加一个会卡住别的 agent 的钩子。
- 纯文档 / 数据、`.dsh/` `.amh/` `.tmp/` 等忽略目录不强制。
- 如果将来有人装了钩子：**不要**用 `--no-verify` 逃；先修流程。`AMH: none` 是合法决定，不是失败。

### 3.4 工具与已知坑

| # | 事实 / 坑 | 规则 |
|---|---|---|
| 1 | 17 个 skill 在 `.dsh/skills` 是指向 AMH `gateway/skills` 的目录 junction，不是副本 | 不要手工复制一套 |
| 2 | gateway 路径读 `.amh/gateway.path`；`AMH_CLIENT` 可覆盖 client 路径 | 路径问题先查这两处 |
| 3 | `.amh/config.json` 有 hub/binding/project 和本地 token | 不要把 token 写进仓库 / 公开面 |
| 4 | 原生工具面 48 个（实例 20 实测），不是旧 7 个；gateway 只挡 6 个结构性跨边界工具 | — |
| 5 | `client.mjs save --concepts "a,b"` 传字符串；`--files` 正常 | 旧 `call memory_save --args-file` 只作兜底 |
| 6 | `brief` 仍可用（旧 AGENTS 写「已删除」是错的） | — |
| 7 | `sessions` 往往只有旧 capture | 别把它当当前会话列表 |
| 8 | `brief.handoffs` 不过滤状态，会混入新旧 handoff | wrapper 只取最近 3 条，仍要按时间 / HEAD 判断 |
| 9 | — | 不装 native MCP、不新建 `amh` profile；不自己加第二入口、不自己发 token |
| 10 | — | 不写 secrets、原始对话、临时日志 |

## 4. 取证据的规矩

| # | 必须 | 禁止 |
|---|---|---|
| 1 | 代码语义从**实现、调用点、测试**取 | 把现有注释 / 旧文档当事实来源（只能当线索） |
| 2 | 定不了位的结论标 `[待确认]`，并说明缺什么 | 用「应该 / 可能 / 大概」补结论 |
| 3 | 判「某物是否还在」用**全工作区索引**（含未跟踪）；`dist/`、`pkg/`、`test/maps/` 等是生成物 / 本地物 | 用 `git grep` 的 0 命中下结论 |
| 4 | 公开面（README / AGENTS / 源码注释）不写本机绝对路径；本地路径放 `.amh/`、`.dsh/` 或环境变量 | — |
| 5 | 改 `.cmd` / `.bat` / `.ps1` 保持 **CRLF + 纯 ASCII**，并实跑一次（D-124 起由 pre-commit 机械检查） | — |
| 6 | 渲染 / 物理改动先做基线 A/B，一次只动一个变量 | — |
| 7 | 验证 wasm 产物真的被使用（字节数 / 哈希） | 只看「注入成功」 |

## 5. 未结工作与待拍板

这两个文件**只在本机**（`.gitignore` 里），不入库——它们记录的是本项目的未结状态，属于「记忆」，不属于工作流骨架。

| 文件 | 用途 | 规则 |
|---|---|---|
| `TODO.md` | 可选的未结清单 | 直接增删；不同步任何台账；没有 ID 格式要求；拉下仓库时没有就自己建 |
| `OWNER.md` | 需要 owner 拍板的决定 | 只有「不可逆 / 改范围 / 改语义」才登记；能按现有约定做的直接做 |

## 6. 环境陷阱

开工前加载技能 `websurf-env-traps`（长输出截断、生成物误判、沙箱边界、行尾、GitHub 网络等）。它的细则在 `skills/websurf-env-traps/REFERENCE.md`。

## 7. 提交

提交前 checklist（按序执行）：

0. 首次克隆执行 `npm run hooks:install`（D-124：`core.hooksPath=.githooks`）；它拦两类机械问题——staged 生成物/本地目录（`pkg/`、`dist/`、`web/*.wasm`、`.tmp/`、`.dsh/`、`.amh/`），以及 `.cmd/.bat/.ps1` 的 LF 行尾/非 ASCII。确知无害时用 `PRECHECK_BYPASS=1` 并在提交信息里写明原因。
1. 确认当前分支是 `main`（`git branch --show-current`）；**禁止在 `dev` 上提交或改动**（§0 红线）。
2. `git status --short`：只 `git add` 自己改的文件；别人的在途改动原样保留。
3. 验证与提交串成一步（`&&`），红灯即终止。
4. 提交信息说清：**改了什么、为什么、怎么验证**；纯格式 / 注释改动写「无行为变化」。
5. 行尾：仓库 `core.autocrlf=true`，索引是 LF、工作树是 CRLF；**不要顺手统一**。
6. 多 agent 并行改代码时，**后开工的**用 `git worktree add ../websurf-wt-<task> <base>` 在独立工作树作业，主工作树留给收尾提交方（T-730 验收有先例）。

## 8. 约束变更留痕（元规则）

任何门禁 / 钩子 / 流程约束的**增、删、改**，必须同时：

1. 修改 AGENTS.md 对应章节（工具与文档不得漂移）；
2. 提交信息写明动机与影响；
3. 若反转既有决定（含本文条款），先在 OWNER.md 登记 `D-###` 并获 owner 回复。

禁止只改工具不改文档，或只删工具不留记录——2026-10-17 `a8eefc0` 引入的 commit-msg 钩子即因此无声消失。
