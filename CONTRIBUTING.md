# 贡献指南

欢迎报告问题、改进文档、修复 bug、新增功能。安装与运行见 [README.md](README.md)。

## 1. 报告问题

用 `.github/ISSUE_TEMPLATE/` 的模板（Bug 报告 / 功能请求 / 其他）提交，并注明：

- **所属工程**：`apps/debug` / `apps/game` / `apps/viewer` / 共享层 `src/`；
- **运行模式**：SAB 共享内存（HTTP + COOP/COEP，由 `src/scripts/serve.mjs` 注入；旧脚本 `serve.py` 等价）或消息回退；
- **复现步骤与环境**：浏览器版本、操作系统、所用地图/录像文件，必要时附 Node 与 Rust 版本。

## 2. 改代码

```bash
npm ci                 # 先在仓库根安装共享 three 等依赖（每次克隆一次即可）
cd apps/debug          # 或 apps/game、apps/viewer
npm ci
npm run build          # build:wasm + typecheck + esbuild 打包 worker/app
```

- 日常开发在 `dev` 分支进行（`main` 为发布/对照线，禁止直接往 `main` 提交）。
- 仓库根提供跨 Shell 一键验证脚本（自动覆盖 `tsc` / TS 单测 / Rust 单测 / 三端契约与门禁）：
  - `npm run verify:fast`：三端 typecheck + `test:ts` + 源码/着色器/配置契约门禁；
  - `npm run verify:rust`：`websurf-phys` + `websurf-wasm-core` 宿主机单测；
  - `npm run verify:ts`：三端 `build:ts` + `verify:fast` + 共享产物指纹；
  - `npm run verify:full`：`rust` + 三端 `build:wasm` + `check:api` + `ts` + 锁/导出/GLB 一致性门禁。
- 提交前请阅读 [AGENTS.md](AGENTS.md)：分支与提交规则（§0/§7）、D-124 `pre-commit` 机械检查（`npm run hooks:install` 启用，拦截 `main` 提交 / 生成物 / UTF-8 BOM / `.cmd/.bat/.ps1` 行尾与非 ASCII）、以及代码/脚本改动的 `AMH:` 尾注约定（§3.3，D-125）。
- 提交 PR 时请说明改动内容与验证结果，并按 [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) 勾选测试项。
