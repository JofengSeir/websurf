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
| `.amh/`、`.dsh/` | AMH Hub 项目侧本地接入（gitignore；是否接入见 §3） |

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

## 3. 项目记忆（AMH Hub）

**agentmemory 已卸载：不要再调 `memory_*` / `:3111` / `:3113`，不要恢复。**

AMH 是项目记忆的唯一入口；仓库不再维护派生台账、哈希或记忆门禁。当前 binding `hub-i21-a` / `WEBSURF`，项目侧 CLI 已接通；如果以后出现原生 MCP 工具（`mcp__...__memory_*`），优先用原生，同一笔写入只走一条。

### 3.1 一轮

1. **开工**：`health`。`embedding_verified=false` 或 Hub 不可达 ⇒ **停下并报告**，不要用本地文件/旧记忆兜底。这是唯一的记忆门禁，由 AMH 判定；不另写本地脚本。
2. **取上下文**：`recall` 1–2 条聚焦查询（任务/模块/前次 handoff），`--limit 3–5`。
3. **改代码**。
4. **收尾**：`save` 一条记录：
   - `type`: `architecture`（决定/取舍）、`bug`（根因/修复）、`pattern`（可复用做法）、`workflow`（流程/交接）、`fact`（稳定事实）。
   - `concepts`: `area:<模块>`、`task:<T-###>`（可选）、`handoff`（交接时）。
   - `marker`: `AMH-YYYYMMDD-<slug>`，一次写入一个唯一 marker。
   - `content`: 做了什么、为什么、证据（文件:行号/命令）、下一步。
5. **504 / `outcome_unknown`**：先 `verify --marker`；`found=true` 就不要再写；`found=false` 才用同一个 marker 重写。
6. 提交信息带 memory id 或 marker；不写本地台账。

### 3.2 多 agent（共享 + 交接，不是调度）

- 所有 agent 共用同一个 binding；读共享，`agentId` 只是来源标签，不是权限/锁。
- 任务分派、顺序、互斥由人/DSH 负责；AMH 没有 claim/lock/lease/task，不要假装它有。
- 交接：上一位 `save` 一条 `type=workflow`、`concepts` 含 `handoff` / `task:<T-###>` 的记录，写清 status/done/next/files；下一位 `recall "HANDOFF T-###"`。
- 需要区分“谁写的”时才加 `--pair` 的第二条 `-b` binding；默认不加，所有写入同一标签。
- 两个 agent 不要同时改同一组文件；并行用 git worktree 或分开目录，冲突由 git 处理。
- `TODO.md` / `OWNER.md` 继续作为任务与决定文件；AMH 只存耐久的决定/根因/模式/交接（它没有 update/delete，不能当状态表）。

### 3.3 工具与已知坑

- 当前用项目侧 CLI，命令路径在 `.dsh/skills/amh-memory/SKILL.md`；`.amh/config.json` 只有 hub/binding/project。
- `counts.project.total` 才是总数；`memoryCount` 不是项目总数。
- `verify` 未命中也是 exit 0，要看 `found`。
- CLI 的 `[amh-cli] ...` 进度行走 stderr；exit 0 就是成功，不要把 PowerShell 的 NativeCommandError 当失败。
- 当前只有 1 条记忆时，`recall` 对任何查询都会返回它；`score>1` 才是相关性信号。
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
