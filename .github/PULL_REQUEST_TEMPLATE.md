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
- [ ] 涉及共享层改动：`apps/debug/scripts/check-wasm-api.mjs` 与
      `apps/game/scripts/check-wasm-api.mjs` 两端均通过
- [ ] 涉及物理/时序改动：相关验证脚本通过（`apps/game` 的 `npm run test:phys`、
      `apps/game/scripts/phys-smoke.mjs`）
- [ ] 本地验证通过

## 截图（可选）
