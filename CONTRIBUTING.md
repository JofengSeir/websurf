# 贡献指南

欢迎报告问题、改进文档、修复 bug、新增功能。安装与运行见 [README.md](README.md)。

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

- 涉及物理、时序或渲染回归的改动，须跑对应门禁（见 `.github/workflows/ci-gates.yml`）并附实测输出。
- 提交 PR：说明改动与验证方式，并按 `.github/PULL_REQUEST_TEMPLATE.md` 勾选测试项。
