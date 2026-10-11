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

- [ ] 在对应工程目录（`apps/debug` / `apps/game` / `apps/viewer`）`npm run build` 构建通过
- [ ] 涉及共享层改动：**三端** `apps/debug/scripts/check-wasm-api.mjs`、
      `apps/game/scripts/check-wasm-api.mjs`、`apps/viewer/scripts/check-wasm-api.mjs` 均通过
      （CI 对三端全跑：`.github/workflows/ci-gates.yml`（三端 `check-wasm-api` + 三端 wasm 构建）；viewer 另有 `--source-only` 的 source-contract job）
- [ ] 涉及物理/时序改动：`cargo test -p websurf-phys` 通过（三端回归自检脚本已于 T-653 移除）
- [ ] 本地验证通过

## 截图（可选）
