# 贡献指南

欢迎任何形式的贡献！请遵循以下流程。

## 报告问题

- 使用 Issue 模板提交（Bug 报告 / 功能请求 / 其他），模板中注明所属工程
  （`debug/` / `game/` / `viewer/` / `test/`（`test/dual-mode-harness/`）/
  共享层 `src/`）与运行模式（SAB 共享内存 /
  消息回退）等环境信息
- 提供复现步骤和环境信息（浏览器及版本、操作系统、地图文件）

## 提交代码

1. Fork 仓库并创建功能分支
2. 修改代码，保持与现有风格一致（仓库为三应用工程 + 共享层 + 测试合集布局：
   `debug/` 主工程、`game/` WebSurf-game、`viewer/` BSP 自由视角查看器、
   `src/` 共享层、`test/` 测试合集（dual-mode-harness）；
   共享层改动一处多端生效，勿在工程内复制共享实现）
3. 在对应工程目录运行 `npm run build` 确保构建通过
   （如 `cd apps/debug && npm run build`；查看器为 `cd apps/viewer && npm run build`；
   验证工程为 `cd test/dual-mode-harness && npm run build`）
4. 涉及物理/时序改动时，运行对应验证脚本（如 `test/dual-mode-harness/` 的
   `node scripts/phys-smoke.mjs`、`game/` 的 `npm run test:phys`）
5. 提交 Pull Request，简要描述改动内容；使用 PR 模板勾选测试项

## 代码规范

- TypeScript：严格类型，在对应工程目录通过 `npm run typecheck`
  （如 `cd apps/game && npm run typecheck`）
- Rust：使用 `cargo fmt` 格式化；共享层 `src/` 内改动需在依赖它的各工程
  （debug / game / viewer / test 均以 path 依赖共享层）均能编译，
  验证一端即可覆盖编译，但契约校验
  `node scripts/check-wasm-api.mjs` 两端都要通过
- 构建缓存：四个模块 workspace 各自保留 `target/`（位于各工程目录内），根 workspace（共享层两 crate）的 `target/` 位于仓库根；不再跨 workspace 复用编译缓存。五份 Cargo.lock（四个模块工程 + 根 workspace）的 wasm-bindgen 需保持同版本（改依赖版本时五处
  `cargo update -p js-sys -p wasm-bindgen -p web-sys` 锁步执行，并与 CI 的
  wasm-bindgen-cli 钉版对齐）
- 注释与文档使用中文；新增导出 API 需同步更新对应工程的 `src/wasm.d.ts`
  （debug/、game/、viewer/、test/dual-mode-harness/
  四处各自一份）与 `documents/` 相关文档
