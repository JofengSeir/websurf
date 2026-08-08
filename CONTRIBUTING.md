# 贡献指南

欢迎任何形式的贡献！请遵循以下流程。

## 报告问题

- 使用 Issue 模板提交（Bug / 功能请求）
- 提供复现步骤和环境信息

## 提交代码

1. Fork 仓库并创建功能分支
2. 修改代码，保持与现有风格一致（仓库为双工程布局：`debug/` 主工程 + `game/` WebSurf-game，改动对应工程内文件）
3. 在对应工程目录运行 `npm run build` 确保构建通过（如 `cd debug && npm run build`）
4. 提交 Pull Request，简要描述改动内容

## 代码规范

- TypeScript：严格类型，在对应工程目录通过 `npm run typecheck`（如 `cd debug && npm run typecheck`）
- Rust：使用 `cargo fmt` 格式化
