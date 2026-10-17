# AGENTS.md — WebSurf 仓库作业指南

> 本文件是 agent 进入仓库的入口。**2026-10-18 起，仓库不再有强制 agent 工作流**：没有看板、没有 claim / close-round、没有记忆库同步门禁、没有 docflow、没有 pre-commit 钩子。
> 旧流程的完整文件与台账保存在 git tag `checkpoint/pre-amh-reset-20261018`。
>
> 仍然成立的是工程事实：构建与测试要过，结论要有证据，提交信息要能独立读懂。

## 1. 仓库地图

| 位置 | 内容 |
|---|---|
| `apps/debug`、`apps/game`、`apps/viewer` | 三端工程；各自是独立 npm 工程，另有 `crates/` |
| `src/phys` | 共享物理（Rust，`cargo test -p websurf-phys`） |
| `src/wasm-core` | BSP / 模型 / 材质 / 渲染导出的 wasm 核心（Rust） |
| `src/ts-shared`、`src/renderer-shared` | 共享 TS 层；three 的单实例装在仓库根 `node_modules` |
| `src/materials`、`src/web` | 材质包与共享 web 资产 |
| `src/scripts` | 本地开发/构建工具：`serve.py`、`build-textures-mtz.mjs`、`copy-wasm-pkg.mjs`、`sync-web-assets.mjs`、工具链 `.cmd` |
| `test/` | `maps/`、`replay/` 夹具（gitignore，本地自备）；`project/` 第三方 SDK 参考 |
| `skills/websurf-env-traps` | 本仓 Windows 作业陷阱（开工前读） |
| `.github/workflows` | `ci-gates.yml`（构建/测试）、`deploy-pages.yml`（部署） |
| `TODO.md` | 可选的未结清单；不是门禁 |
| `OWNER.md` | 需要 owner 拍板的决定（`D-###`） |
| `.amh/`、`.dsh/` | AMH gateway 项目侧本地接入（gitignore；是否接入见 §3） |

`progress/`、`documents/`、`docflow.json` 已不存在；不要再从这些路径取规则或状态。

## 2. 构建与验证

```bash
npm ci                         # 仓库根：shared 层的 three
cd apps/<app> && npm ci        # debug / game / viewer 各自装
npm run build:wasm             # wasm-pack → pkg/，并复制到 web/
npm run typecheck              # TS 类型检查
npm run build:ts               # typecheck + esbuild
npm run build:dist             # 打包 dist/（single 或 --multi）
npm run dev                    # 起本地服务（debug 8080 / game 8090 / viewer 8100）
```

Rust 侧：

```bash
cargo check -p websurf-phys
cargo test -p websurf-phys
```

CI 仍会跑 `ci-gates.yml`：`cargo test`、viewer 的源码契约、三端 wasm 构建与 GLB 一致性。提交前至少跑与改动相关的构建/类型检查；没有跑成功的项要在提交信息里写清楚。

## 3. 项目记忆（AMH gateway）

**旧的独立 agentmemory / mcp-hub 路线已卸载：不要恢复。** 当前 AMH gateway 的 backend 是 agentmemory（0.9.30），只经 gateway 访问；不要直连 `:3111` 或实例 REST。

AMH gateway 是项目记忆的唯一入口；细则以 `.dsh/skills/amh-memory/SKILL.md` 为准。项目契约 `.amh/config.json`（`hub` / `binding` / `project`，本地文件，不写进仓库）。旧的 `amh-cli` / 7 工具 / marker / verify / counts / brief 路线已删除，不要再用。

### 3.1 一轮

1. **开工**：`node <gateway>\bin\client.mjs sessions`（或原生 `memory_sessions`）。gateway 不可达 / 401 / 无 binding ⇒ **不写记忆，停下报告**；不要自己 start/stop AMH（owner/安装者）。
2. **取上下文**：`recall` 或 `search` 1–2 条；同时读 `TODO.md` 对应任务与 `OWNER.md` 待决。
3. **改代码**。
4. **收尾**：`save --content ... --type ... --concepts ...`。原生 `memory_save` 还支持 `files`；项目侧 client 不暴露 `--files`，把 files 写进 content。
5. **save 失败**：先读错误，不要盲重试；用 `sessions` / `recall` 查是否已有同内容。gateway 没有旧的 marker/verify/504 语义。
6. 验收只用 gateway/native 的实际结果 + CI；不写本地台账/哈希/checklist。

### 3.2 多 agent（native 能力，项目侧 client 只开 4 条）

- gateway 的 token 决定 `agentId`；没有 token 时用 binding 的 agentId。多 agent 要各自 token，否则 lease/signal 的身份相同。
- 原生工具（需 native MCP 或能调 48 工具的客户端）：`memory_action_create/update/next`（任务/DAG）、`memory_lease`（独占）、`memory_signal_send/read`（消息）、`memory_sessions`、`memory_checkpoint`。
- 项目侧 `client.mjs` 只有 `sessions/recall/search/save`，**不能** claim/lease/signal；不要假装能。
- 没有 lease 时，分派/互斥仍由人/DSH 负责；不要自己造 gate。
- 交接：`memory_save`（type 取最贴近的，通常 `workflow`/`pattern`），concepts 含 `task:<id>,handoff`，content 以 `HANDOFF <task>:` 开头并写 files；native 可用 `files` 字段。
- `TODO.md` / `OWNER.md` 仍是任务/决定文件；AMH 不是状态表；`D-###` 正文以 OWNER 为准。

### 3.3 工具与坑

- 命令路径在 `.dsh/skills/amh-memory/SKILL.md`；`.amh/config.json` 只有 hub/binding/project；token 用 `AMH_CLIENT_TOKEN`。
- 当前 skill 已切到 `gateway/bin/client.mjs`；不要找 `amh-cli` / `health` / `counts` / `verify` / `brief` / `marker`。
- 原生工具面是 48 个（实例 20 实测），不是旧 7 个；gateway 只挡 6 个结构性跨边界工具。
- `client.mjs` 只暴露 4 条；要 actions/leases/signals 必须走 native MCP（或扩客户端），否则明说能力不可用。
- 原生 MCP 入口 / token 由 owner/安装者配置；agent 不自己加第二入口、不自己发 token。
- `amh status` 只读；gateway 没起就停写报告，不要启停。
- 不写 secrets、原始对话、临时日志。

## 4. 取证据的规矩

- 代码语义只从**实现、调用点、测试**取；现有注释和旧文档只能当线索。
- 不能在代码里定位的结论标 `[待确认]` 并说明缺什么，不要用「应该 / 可能 / 大概」补。
- 判断「某物是否还在」用全工作区索引（含未跟踪），不要用 `git grep` 的 0 命中下结论；`dist/`、`pkg/`、`test/maps/` 等是生成物/本地物。
- 公开面（README / AGENTS / 源码注释）不写本机绝对路径；本地路径放 `.amh/`、`.dsh/` 或环境变量。
- 改 `.cmd` / `.bat` / `.ps1` 保持 CRLF，并实跑一次。
- 渲染/物理改动先做基线 A/B，再一次只动一个变量；验证 wasm 产物真的被使用（字节数/哈希），不要只看「注入成功」。

## 5. 未结工作与待拍板

- `TODO.md`：可选清单，直接增删；不需要同步到任何台账，也没有 ID 格式要求。
- `OWNER.md`：只有「不可逆 / 改范围 / 改语义」的决定才登记；能按现有约定做的就直接做。

## 6. 环境陷阱

开工前加载技能 `websurf-env-traps`（长输出截断、生成物误判、沙箱边界、行尾、GitHub 网络等）。它的细则在 `skills/websurf-env-traps/REFERENCE.md`。

## 7. 提交

- 先 `git status --short`，只 add 自己改的文件；不要用 `git checkout -- <文件>` 清理别人的在途改动。
- 提交信息说清：改了什么、为什么、怎么验证。纯格式/注释改动写「无行为变化」。
- 行尾：仓库 `core.autocrlf=true`，索引是 LF、工作树是 CRLF；不要顺手统一。
