# 变更记录

本文件登记**当前工作区状态**与各工程的版本声明。工作区内原有文档树已整树移除，因此这里**不含更早的版本条目**，也不据已删文档或提交历史重建任何条目——每一条都只写能由当前代码核验的内容。

## 0.1.0 — 当前工作区状态（未发布）

**受控范围**：三个应用工程 `apps/debug`（8080）、`apps/game`（8090）、`apps/viewer`（8100），以及共享层 `src/`（`websurf-phys`、`websurf-wasm-core`、`src/ts-shared/**`）。范围与入口见 `README.md`。

**版本声明**（均为 `0.1.0`，各自文件内可核验）：

| 包 | 声明处 |
|---|---|
| `websurf-debug` | `apps/debug/package.json:3` |
| `websurf-game` | `apps/game/package.json:3` |
| `websurf-viewer` | `apps/viewer/package.json:3` |
| `websurf-phys` | `src/Cargo.toml:3` |
| `websurf-wasm-core` | `src/wasm-core/Cargo.toml:11` |
| 三个工程的 wasm 导出层 | `apps/debug/crates/wasm/Cargo.toml:12`、`apps/game/crates/wasm/Cargo.toml:12`、`apps/viewer/crates/wasm/Cargo.toml:9` |

**构建链**：`wasm-pack` 构建各工程 `crates/wasm` → `pkg/` 并复制到 `web/`；esbuild 打包 worker 与 app；`scripts/build-dist.mjs` 生成 single 或 multi 形态的 `dist/`。命令与锚点见 `README.md` 的「构建链」。

**文档体系**：根 `README.md` 为入口；`documents/**` 按主题分篇（架构、物理、解析层、TS 共享层、材质、规范、计划台账），篇目与职责见 `README.md` 的「文档地图」与 `documents/index.md` 的导航。

**验证**：共享层 `cargo test -p websurf-phys`；三工程 `npm run typecheck` 与各自的 `test:*` 门禁；文档侧 `node src/scripts/check-doc-drift.mjs`。CI 三条 workflow 见 `README.md` 的「验证与门禁」。

**本状态下的已知缺口**：CI 的门禁 job 仍引用已退役的验证工程、debug 的 `test:jump-apex` 门空转、输入录制链路未接线、零分配支路与 `set_yaw_pitch` 无装配点、`.cmd` 的 wasm 新鲜度门与页面消费的产物不是同一份、配置面仍含退役工程引用。逐条证据与处置状态见 `documents/plan/progress-log.md` 的「§7.3 待裁决项」。
