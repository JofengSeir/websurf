# 贡献指南

欢迎报告问题、改进文档、修复 bug、新增功能。仓库结构、构建链与文档地图见 [README.md](README.md)。

## 1. 报告问题

用 `.github/ISSUE_TEMPLATE/` 的模板（Bug 报告 / 功能请求 / 其他）提交，并注明：

- **所属工程**：`apps/debug` / `apps/game` / `apps/viewer` / 共享层 `src/`；
- **运行模式**：SAB 共享内存（HTTP + COOP/COEP，由 `src/serve.py` 注入）或消息回退；
- **复现步骤与环境**：浏览器版本、操作系统、所用地图/录像文件，必要时附 Node 与 Rust 版本。

## 2. 改代码

```bash
cd apps/debug          # 或 apps/game、apps/viewer
npm ci
npm run build          # build:wasm + typecheck + esbuild 打包
```

- 涉及物理、时序或渲染回归的改动，跑 §4 的验证脚本。
- 提交 PR：说明改动与验证方式，并按 `.github/PULL_REQUEST_TEMPLATE.md` 勾选测试项。

## 3. 代码规范

- **注释与文档用中文**；新增导出 API 同步该工程的 `src/wasm.d.ts`。
- **TypeScript**：严格类型，`npm run typecheck` 通过。**Rust**：`cargo fmt`，`cargo test -p websurf-phys` 通过。
- **共享层一处改动多端生效**：不要在工程内复制共享实现，公共逻辑一律上提 `src/`（分层与依赖方向见 README「依赖方向与共享层」）。
- **提交信息**采用 Conventional Commits：`type(scope): 摘要`；type 取 `feat` / `fix` / `refactor` / `docs` / `test` / `chore`，scope 为工程或模块（`repo`、`ci`、`debug`、`game`、`viewer`、`phys`、`wasm-core` 等）。

## 4. 验证脚本

| 工程 | 命令（各自 `package.json` 注册） |
|---|---|
| `apps/debug` | `check:api`、`test:optimize-scene`、`test:auth-clock`、`test:path-acceptance`、`test:jump-apex`、`test:surf-crouch` |
| `apps/game` | `check:api`、`test:phys`、`test:seed-smoke`、`test:surf-crouch` |
| `apps/viewer` | `check:api`、`test:replay`、`local:smoke`（需本地 dev 服务与 Edge/Chromium） |
| 共享层 | `cargo test -p websurf-phys` |

其中 debug / game / viewer 的主要 `test:*` 同时是 CI 门禁（`.github/workflows/ci-gates.yml`）；部署另由 `deploy-pages.yml` 负责，两者互不阻塞。

## 5. 文档与治理（本地保留）

本仓库是**公开的运行/构建仓库**：只收「三端 + 共享层 + 部署与 CI」。
开发过程的治理层（`documents/**` 文档与注释规范、`TODO.md` 待办看板、`OWNER.md` 决策队列、`AGENTS.md` 仓库规范、
`progress/**` 过程记录、`skills/**`，以及 `src/scripts/{docflow,check-doc-drift,check-board-touch,check-memory-sync}.mjs` 文档门禁）
**只在本地保留、不推送**（判据见根 `.gitignore` 的「本地保留」段）。改动代码时请遵守本地那一层的规范；
公开侧只需保证 `cargo test -p websurf-phys`、三端 `npm run typecheck` 与各自 `test:*` 门禁通过。
