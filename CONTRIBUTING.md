# 贡献指南

欢迎任何形式的贡献：报告问题、改进文档、修复 bug、新增功能均可。

## 1. 报告问题

使用 Issue 模板（Bug 报告 / 功能请求 / 其他）提交，注明**所属工程**（`apps/debug` / `apps/game` / `apps/viewer` / `test/dual-mode-harness` / 共享层 `src/`）与**运行模式**（SAB 共享内存（HTTP + COOP/COEP）/ 消息回退），并提供复现步骤与环境信息（浏览器版本、操作系统、地图文件，必要时附 Node / Rust 版本）。

## 2. 提交代码

1. Fork 仓库并创建功能分支。
2. 修改代码并保持与现有风格一致。⚠️ 共享层（`src/`）改动一处多端生效，请勿在工程内复制共享实现，公共逻辑一律上提。
3. 在对应工程目录完成构建（四个工程命令一致）：

   ```bash
   cd apps/debug        # 或 apps/game、apps/viewer、test/dual-mode-harness
   npm install
   npm run build        # build:wasm + typecheck + esbuild 打包
   ```
4. 涉及物理、时序或渲染回归的改动，运行对应验证脚本（见 §4）。
5. 提交 Pull Request，简要说明改动与验证方式，并按 PR 模板勾选测试项。

## 3. 代码规范

- **注释与文档使用中文**；新增导出 API 需同步更新对应工程的 `src/wasm.d.ts`（四处各一份）与 `documents/` 相关文档。
- **TypeScript** 严格类型，`npm run typecheck`；**Rust** 使用 `cargo fmt`。
- **构建与依赖**：模块 workspace 划分、`target/` 布局与五份 `Cargo.lock` 的 wasm-bindgen 锁步（当前 `0.2.128`）见 [README.md](README.md) 第 3 节——改依赖版本时需五处同步并核对 CI 的 wasm-bindgen-cli。
- **提交信息**：采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，格式 `type(scope): 摘要`；type 如 `feat` / `fix` / `refactor` / `docs` / `test` / `chore`，scope 为变更所在工程或模块（`repo`、`ci`、`debug`、`game`、`viewer`、`phys`、`wasm-core` 等）。

## 4. 验证脚本

| 工程 | 命令 |
|---|---|
| apps/debug | `check:api`、`test:optimize-scene`、`test:auth-clock`、`test:path-acceptance`、`test:jump-apex` |
| apps/game | `check:api`、`test:phys` |
| apps/viewer | `test:replay`、`test:smoke` |
| test/dual-mode-harness | `check:api`、`test:three-mode` |

以上脚本同为 CI 门禁的组成部分，详见 [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) 与 [README.md](README.md) 第 6 节。
