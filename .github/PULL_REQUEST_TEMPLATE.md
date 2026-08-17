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

- [ ] debug（主工程）
- [ ] game（WebSurf-game）
- [ ] test/game（WebSurf-game 修复版移植）
- [ ] test（WebSurf-test：`test/dual-mode-harness/`）
- [ ] 共享层（src/，两端均受影响——需双端契约校验通过）

## 测试

- [ ] 在对应工程目录（`debug/` / `game/` / `test/game/` / `test/dual-mode-harness/`）`npm run build` 构建通过
- [ ] 涉及共享层改动：`node scripts/check-wasm-api.mjs` 在 debug 与 game 两端通过
- [ ] 涉及物理/时序改动：相关验证脚本通过（`game` 的 `npm run test:phys`、
      `test/dual-mode-harness` 的 `node scripts/phys-smoke.mjs`）
- [ ] 本地验证通过

## 截图（可选）
