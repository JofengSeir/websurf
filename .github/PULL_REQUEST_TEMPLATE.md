## 描述

简要说明本次改动的内容和动机。

## 关联 Issue

Fixes #(issue number)

## 改动类型

- [ ] Bug 修复
- [ ] 新功能
- [ ] 重构
- [ ] 文档

## 影响范围

- [ ] debug（`apps/debug`）
- [ ] game（`apps/game`）
- [ ] viewer（`apps/viewer`）
- [ ] 共享层（`src/`，三个工程均受影响——需契约校验通过）

## 测试

- [ ] 改 TS / 配置 / 脚本：`npm run verify:fast` 或 `npm run verify:ts` 通过
- [ ] 改 Rust / 物理 / WASM：`npm run verify:rust` 与 `npm run verify:full`（含三端 `build:wasm`、`check:api`、锁/导出基线与 GLB 一致性）通过
- [ ] 本地启动开发服冒烟无异常（`npm run dev:check` 确认无缺失/过期产物）
- [ ] 分支为 `dev`（非直接提交 `main`），`.githooks/pre-commit` 机械检查通过

## 截图（可选）
