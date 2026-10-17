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

## 3. 记忆（可选，AMH Hub）

**agentmemory 已从本机卸载：不要再调用 `memory_*` 工具，不要再连 `:3111` / `:3113`，也不要尝试恢复。**

目标记忆系统是本地 AMH Hub（项目侧接法见 AMH 工作区的 `PROJECT-INTEGRATION.md` 与 `examples/project-side/`；本机的 AMH 工作区路径不写进仓库）。它是**增强，不是门禁**：没有 Hub 时照常工作，不要把任务卡在记忆上。

- **已接入**：仓库里有 `.amh/config.json` 与 `.dsh/skills/amh-memory/SKILL.md` 时，按该技能用 `amh-cli health` → `recall` → `save`。`health.embedding_verified=false` 时只读、不写。
- **未接入**：跳过。结论写进提交信息、`TODO.md` 或 `OWNER.md`。
- **接入命令**（Hub 已起、实例与 binding 已登记；路径用本机 AMH 工作区）：
  ```powershell
  node <AMH>\mcp-hub\src\hub-setup.mjs --add --instance <N> --project WEBSURF --project-dir <repo>
  # 然后 stop.bat && start-all.bat，让 Hub 重新加载 binding
  ```
  也可以只用项目侧初始化：`node <AMH>\mcp-hub\bin\amh-project.mjs init --dir <repo> --binding <binding>`。
- 同一笔写入只走一条路：有当前项目的原生 MCP 工具就优先用它，否则用 CLI；不要两边都写。
- 不写 secrets、原始对话、临时进度日志。

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
