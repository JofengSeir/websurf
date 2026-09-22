# WebSurf

浏览器里跑 Counter-Strike: Source 风格的 **surf（滑翔）** 地图：物理由 Rust 编译成 wasm，渲染用 Three.js，输入与录像回放走同一套确定性链路。

纯前端——**无后端、无账号、不上传数据**；地图与录像由用户从本地选择，在浏览器内解析（安全说明见 [SECURITY.md](SECURITY.md)）。

---

## 1. 三个应用 + 共享层

> 受控工程只有 `apps/debug`、`apps/game`、`apps/viewer` 与共享层 `src/`。`test/` 下**只有本地夹具**（`test/maps/` 地图、`test/replay/` 录像，均不入库）——仓库内没有其它工程。

| 工程 | 端口 | 定位 | 入口锚点 |
|---|---|---|---|
| `apps/debug` | 8080 | 调试与实验宿主：面板可调参数、路径记录、权威健康、调试线框 | `apps/debug/package.json:15` 的 `dev` |
| `apps/game` | 8090 | 面向玩家：Worker 权威物理 + 面板 + 存档点 | `apps/game/package.json:15` 的 `dev` |
| `apps/viewer` | 8100 | 纯查看器：地图与 `.replay` 回放、遥测与轨道面板（**不含物理**） | `apps/viewer/package.json:18` 的 `dev` |
| `src/` | — | 共享层：`websurf-phys`（物理）、`websurf-wasm-core`（BSP/GLB/模型解析）、`ts-shared/**`（TS 共享） | `src/Cargo.toml:2`、`src/wasm-core/Cargo.toml:10` |

## 2. 快速开始

每个应用是**独立的 npm 工程**（仓库根没有 `package.json`）。以 `apps/debug` 为例：

```bash
cd apps/debug
npm ci
npm run build:wasm     # wasm-pack 构建 → pkg/，并把 wasm 复制到 web/
npm run build:ts       # typecheck + esbuild 打包 worker 与 app
npm run dev            # python ../../src/serve.py 8080 .
```

`apps/game`、`apps/viewer` 同构（端口 8090 / 8100）；三个工程各自 `npm ci` / `npm run build` / `npm run dev`。Windows 双击入口：`apps/<app>/{start-dev,play,build-dist}.cmd`。

**静态服务**：`src/serve.py` 只做一件事——按正确 MIME 提供本地文件：端口取 `argv[1]`（默认 8080，`src/serve.py:18`），服务根取 `argv[2]`（`src/serve.py:19`），启动时 `os.chdir` 到该根（`src/serve.py:20`），并为所有响应加 COOP/COEP，页面才能拿到 `SharedArrayBuffer`。

## 3. 仓库结构

| 路径 | 内容 |
|---|---|
| `Cargo.toml` | 仓库根 workspace：**只收**共享层两个 crate（`Cargo.toml:22` 的 `members`） |
| `src/phys/**` | `websurf-phys`：世界容器、玩家移动语义、传送触发、种子面 |
| `src/wasm-core/**` | `websurf-wasm-core`：BSP、GLB、pakfile、材质与 mosaic |
| `src/ts-shared/**` | TS 共享：权威循环、tick 消费者、共享状态通道、物理参数与角度、世界类型 |
| `src/scripts/**` | 共享脚本：wasm 过期检查、文档漂移体检、共享层同步体检、分发打包 |
| `apps/<app>/crates/wasm/**` | 各工程的 wasm-bindgen 导出层（debug/game 为 `websurf-wasm`，viewer 为 `websurf_viewer_wasm`） |
| `apps/<app>/src/**`、`web/**` | 前端源码与静态页面（`web/app.js`、`web/worker.js` 是**构建产物**，不入库） |
| `apps/<app>/scripts/**` | 各工程构建与验收脚本（含 `build-dist.mjs`） |
| `test/maps/**`、`test/replay/**` | 本地夹具：地图与录像（**均 gitignore，不入库**） |
| `documents/**` | 文档（见 §7） |
| `.archive/**` | 旧文档归档区，**不作事实来源** |

## 4. 构建链

1. `npm run build:wasm`：`wasm-pack build --release --target web --out-dir ../../pkg`，随后把 `pkg/…_bg.wasm` 复制到 `web/…_bg.wasm`（同一脚本内，`apps/debug/package.json:8`）。两份产物用途不同：`pkg/` 供 Node 侧脚本与 esbuild 解析，`web/` 供页面 `fetch`。
2. `npm run build:ts`：`tsc --noEmit` + esbuild 打两个入口（`apps/debug/package.json:10`、`:11`）：`src/worker/main.ts` → `web/worker.js`，`src/app.ts` → `web/app.js`。
3. `npm run build:dist`：`scripts/build-dist.mjs` 生成 `dist/`。`single` 只留 `KEEP_SINGLE` 列出的文件（`apps/game/scripts/build-dist.mjs:60`）；`--multi` 额外保留 worker、外置 wasm/纹理包与 COI service worker（同文件 `:62`）。

> **产物不入库**：`pkg/`、`dist/`、`web/app.js`、`web/worker.js`、`web/*.wasm`。克隆后需 `npm run build` 再生。

## 5. 验证与 CI

```bash
cargo test -p websurf-phys                       # 共享物理单测
cd apps/<app> && npm run typecheck               # 类型检查
cd apps/<app> && npm run test:<门>               # 见下表
node src/scripts/check-doc-drift.mjs             # 文档漂移体检
```

| 工程 | `test:*` 门禁（锚点：`.github/workflows/ci-gates.yml`） |
|---|---|
| `apps/debug` | `test:optimize-scene`、`test:auth-clock`、`test:path-acceptance`、`test:jump-apex`、`test:surf-crouch` |
| `apps/game` | `test:phys`、`test:seed-smoke`、`test:surf-crouch` |
| `apps/viewer` | `test:replay`（纯 TS 自检，不依赖 wasm 产物） |

CI 三个 workflow（`.github/workflows/`）：

- **`doc-drift.yml`**：跑 `check-doc-drift.mjs`，查行数声明、`文件:行号` 锚点越界、路径失效、裸文件名歧义。能力边界：**只查越界，不查该行内容与描述是否相符**。
- **`ci-gates.yml`**（`.github/workflows/ci-gates.yml:36`）：四个 job —— `rust-unit-tests`（`cargo test -p websurf-phys`）、`debug-gates`（五道）、`game-gates`（三道）、`viewer-gates`（`test:replay`）。纯文档改动（`**.md`、`documents/**`）不触发门禁。
- **`deploy-pages.yml`**：matrix 并行构建三工程的 `build:dist -- --multi`，装到 `deploy/<app>/`，用入口页模板生成站点首页。**与门禁互不阻塞**。

## 6. 依赖方向与共享层

- `apps/debug` 与 `apps/game` 的 wasm 导出层**同时**依赖两个共享 crate（`apps/debug/crates/wasm/Cargo.toml:22` 物理、`:24` 解析）。
- `apps/viewer` 的导出层**只**依赖解析层（`apps/viewer/crates/wasm/Cargo.toml:19`）。
- TS 侧一律用相对路径 import 共享层（例：`apps/debug/src/input/input-recorder.ts:47`）；SAB 通道与 postMessage 回退的分派在 `src/ts-shared/auth/shared-state.ts:1022` 的 `createMainSharedState`。
- 共享层一处改动多端生效：**不要在工程内复制共享实现**。

## 7. 文档地图

| 文档 | 回答什么 |
|---|---|
| [documents/index.md](documents/index.md) | **文档总导航**（按实际文件树） |
| [architecture/overview.md](documents/architecture/overview.md) | 受控范围、共享层构成、依赖方向、入口锚点、启动链与帧链、不变量 |
| [phys/overview.md](documents/phys/overview.md) | 共享物理：世界容器、步进、玩家语义、传送、种子面 |
| [wasm-core/overview.md](documents/wasm-core/overview.md) | 解析层：BSP/GLB/材质/mosaic 的模块职责与主流程 |
| [ts-shared/overview.md](documents/ts-shared/overview.md) | TS 共享层：接口锚点、主流程、不变量、未接线清单 |
| [materials/overview.md](documents/materials/overview.md) | 材质与纹理链路 |
| [debug/README.md](documents/debug/README.md) · [game/README.md](documents/game/README.md) · [viewer/README.md](documents/viewer/README.md) | 三个工程的文档子树入口 |
| [norms/annotation-and-verification.md](documents/norms/annotation-and-verification.md) | 注释书写规范与验收判据 |
| [plan/project-survey.md](documents/plan/project-survey.md) · [plan/doc-rewrite-taskbook.md](documents/plan/doc-rewrite-taskbook.md) · [plan/progress-log.md](documents/plan/progress-log.md) | 重编任务：读码事实基线 / 任务书 / 进度台账 |
| [AGENTS.md](AGENTS.md) | 当前任务的 Agent 行为规范与进度纪要 |

## 8. 已知缺口（摘要）

以下均为**读码所得、未修改代码**的登记项，逐条明细与证据见 [plan/progress-log.md](documents/plan/progress-log.md)：

- **输入录制链路未接线**：`InputRecorder.record()` 在 `apps/debug/src` 内只有回放分支 `replayCapture` 一处调用点（`apps/debug/src/app.ts:2395`），用户录制器 `inputRecorder`（同文件 `:217`）不落样本 ⇒ `__wsInput.exportJson()` 的 frames 恒为空。
- **零分配支路已实现但未装配**：`tick_into` / `state_out_ptr` / `seed_from` 仅被 `src/ts-shared/` 的控制器调用，而这些控制器在三个工程内都没有装配点；`set_yaw_pitch` 在 `apps/**` 与 `src/**` 内零调用点。
- **`.cmd` 的 wasm 新鲜度门与被服务的产物不是同一份**：`start-dev.cmd` / `apps/viewer/play.cmd` 判的是 `pkg/…_bg.wasm`，页面与 dist 构建读的是 `web/…_bg.wasm`。

## 9. 参与与许可

- 改动流程、验证脚本、提交规范 → [CONTRIBUTING.md](CONTRIBUTING.md)
- 漏洞报告与安全事实 → [SECURITY.md](SECURITY.md)
- 版本历史 → [CHANGELOG.md](CHANGELOG.md)

第三方组件：

- [@unsurf/cs-movement](https://github.com/unsurf/cs-movement) —— 移动物理引擎（已修改），Apache-2.0，见 `src/phys/NOTICE`
- [vmdl](https://codeberg.org/icewind/vmdl) —— Source 模型解析（vendored，已修改），MIT，见 `src/vendor/vmdl/LICENSE`
- [three.js](https://threejs.org/) —— 3D 渲染，MIT

本仓库：[MIT](LICENSE) © 2026 WebSurf contributors。
