# WebSurf

浏览器里运行 Counter-Strike: Source 风格的 **surf（滑翔）** 地图：物理由 Rust 编译成 wasm，渲染用 Three.js，输入与录像回放走同一套确定性链路。

本仓库的**受控工程**是三个应用与共享层：

| 工程 | 端口 | 定位 | 入口锚点 |
|---|---|---|---|
| `apps/debug` | 8080 | 调试与实验宿主：面板可调参数、路径记录、权威健康、调试线框 | `apps/debug/package.json:15` 的 `dev` |
| `apps/game` | 8090 | 面向玩家的游戏形态：Worker 权威物理 + 面板 + 存档点 | `apps/game/package.json:15` 的 `dev` |
| `apps/viewer` | 8100 | 纯查看器：地图与 `.replay` 录像回放、遥测与轨道面板（不含物理） | `apps/viewer/package.json:18` 的 `dev` |
| `src/` | — | 共享层：`websurf-phys`（物理）、`websurf-wasm-core`（BSP/GLB/模型解析）、`ts-shared/**`（TS 侧共享） | `src/Cargo.toml:2`、`src/wasm-core/Cargo.toml:10` |

## 仓库结构

| 路径 | 内容 |
|---|---|
| `Cargo.toml` | 仓库根 Cargo workspace：**只收**共享层两个 crate（`Cargo.toml:22` 的 `members`） |
| `src/phys/**` | 共享物理系统 `websurf-phys`：世界容器、玩家移动语义、传送触发、种子面 |
| `src/wasm-core/**` | 共享解析/导出核心 `websurf-wasm-core`：BSP、GLB、pakfile、材质与 mosaic |
| `src/ts-shared/**` | TS 侧共享：权威循环、tick 消费者、共享状态通道、物理参数与角度、世界类型 |
| `src/scripts/**` | 共享脚本：wasm 过期检查、文档漂移体检、共享层同步体检、分发打包 |
| `apps/<app>/crates/wasm/**` | 各工程的 wasm-bindgen 导出层（debug/game 为 `websurf-wasm`，viewer 为 `websurf_viewer_wasm`） |
| `apps/<app>/src/**`、`apps/<app>/web/**` | 前端源码与静态页面/样式（`web/app.js`、`web/worker.js` 是构建产物） |
| `apps/<app>/scripts/**` | 各工程的构建与验收脚本（含 `build-dist.mjs`） |
| `test/maps/**`、`test/replay/**` | 本地夹具：BSP 地图与录像样例（**均被 gitignore**，不入库） |
| `documents/**` | 本仓库文档（见「文档地图」） |
| `.github/workflows/**` | 三条 CI：文档漂移体检、门禁、Pages 部署 |

## 快速开始

每个应用是独立的 npm 工程（仓库根**没有** `package.json`）。以 `apps/debug` 为例：

```bash
cd apps/debug
npm ci
npm run build:wasm     # wasm-pack 构建 crates/wasm → pkg/，并把 wasm 复制到 web/（package.json:8）
npm run build:ts       # typecheck + esbuild 打包 worker 与 app（package.json:12）
npm run dev            # python ../../src/serve.py 8080 .（package.json:15）
```

`apps/game`、`apps/viewer` 同构（端口 8090 / 8100；`build:ts`、`build:dist` 见各自 `package.json`）。

- **共享层**：`cargo test -p websurf-phys`（物理单测）、`cargo check -p websurf-wasm-core`。
- **静态服务**：`src/serve.py` 只做一件事——按正确 MIME 提供本地文件。端口取 `argv[1]`（默认 8080，`src/serve.py:18`），服务根取 `argv[2]`（默认脚本自身所在目录，`src/serve.py:19`），启动时 `os.chdir` 到该根（`src/serve.py:20`），并给所有响应加 COOP/COEP（页面因此可拿到 `SharedArrayBuffer`）。
- **`.cmd` 入口**：`apps/<app>/{start-dev,play,build-dist}.cmd` 是手工/双击入口；实测**没有任何 `package.json` script 或其它 `.cmd` 转发到它们**（`dev`、`build:dist`、`check:api` 是并行路径），唯一例外是 `apps/viewer/play.cmd` 转发到产物里的 `dist/play.cmd`。

## 构建链

1. `npm run build:wasm`：`wasm-pack build --release --target web --out-dir ../../pkg`，随后把 `pkg/…_bg.wasm` 复制到 `web/…_bg.wasm`（同一脚本内，见 `apps/debug/package.json:8`）。两份产物用途不同：`pkg/` 供 Node 侧脚本与 esbuild 解析，`web/` 供页面 `fetch`。
2. `npm run build:ts`：`tsc --noEmit` + esbuild 打两个入口（`apps/debug/package.json:10` 的 `build:worker`、`apps/debug/package.json:11` 的 `build:app`）：`apps/debug/src/worker/main.ts` → `web/worker.js`，`apps/debug/src/app.ts` → `web/app.js`。
3. `npm run build:dist`：`scripts/build-dist.mjs` 生成 `dist/`。single 形态只留 `KEEP_SINGLE` 列出的文件（`apps/game/scripts/build-dist.mjs:60`），multi 形态额外保留 worker、外置 wasm/纹理包与 COI service worker（`apps/game/scripts/build-dist.mjs:62`）。

## 验证与门禁

**本地**（与 CI 同一批脚本）：

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

**CI**：

- `.github/workflows/doc-drift.yml`：PR 与 main 上跑 `node src/scripts/check-doc-drift.mjs`（`.github/workflows/doc-drift.yml:47`）。它查四类问题：行数声明、`文件:行号` 锚点越界、路径失效、裸文件名歧义；**能力边界**是「只查越界，不查该行内容与文档描述是否相符」。
- `.github/workflows/ci-gates.yml`：四个 job——共享层 Rust 单测、debug 门禁、game 门禁、viewer 门禁。
- `.github/workflows/deploy-pages.yml`：matrix 并行构建三个工程的 `npm run build:dist -- --multi`（`.github/workflows/deploy-pages.yml:129`），把三份 `dist/` 装到 `deploy/<app>/`，并用入口页模板 `apps/debug/scripts/pages-index.html` 生成站点首页（`.github/workflows/deploy-pages.yml:176`）。

## 共享层与依赖方向

- `apps/debug` 与 `apps/game` 的 wasm 导出层**同时**依赖两个共享 crate：`apps/debug/crates/wasm/Cargo.toml:22`（`websurf-phys`）与 `:24`（`websurf-wasm-core`）。
- `apps/viewer` 的 wasm 导出层**只**依赖解析层：`apps/viewer/crates/wasm/Cargo.toml:19`（`websurf-wasm-core`）。
- TS 侧一律用相对路径 import 共享层（例：`apps/debug/src/input/input-recorder.ts:47` 从 `src/ts-shared/auth/shared-state.ts` 取类型）；SAB 通道与 postMessage 回退的分派在 `src/ts-shared/auth/shared-state.ts:1022` 的 `createMainSharedState`。

## 文档地图

| 文档 | 回答什么 |
|---|---|
| `documents/index.md` | **文档总导航**：按实际文件树列出全部文档（本表只是其中一段） |
| `documents/architecture/overview.md` | 受控范围、共享层构成、依赖方向、入口锚点、启动链与帧链、不变量、构建产物 |
| `documents/phys/overview.md` | 共享物理：世界容器、步进、玩家语义、传送、种子面 |
| `documents/wasm-core/overview.md` | 共享解析层：BSP/GLB/材质/mosaic 的模块职责与主流程 |
| `documents/ts-shared/overview.md` | TS 共享层：接口锚点、主流程、不变量、**未接线与零调用点清单**、测试与门禁 |
| `documents/materials/overview.md` | 材质与纹理链路 |
| `documents/debug/README.md` | `apps/debug` 子树入口：overview / sequences / differences + 9 篇 `implementation/` |
| `documents/game/README.md` | `apps/game` 子树入口：overview / sequences / differences + 10 篇 `implementation/` |
| `documents/viewer/README.md` | `apps/viewer` 子树入口：overview / sequences / differences + 8 篇 `implementation/` |
| `documents/norms/annotation-and-verification.md` | 本仓库的注释书写规范与验收判据（含已验证的陷阱清单） |
| `documents/plan/doc-rewrite-taskbook.md` | 文档/注释重编任务书（流程、规范、术语、任务拆分） |
| `documents/plan/project-survey.md` | 读码事实基线（目录结构、模块划分、依赖矩阵、主流程与时序骨架） |
| `documents/plan/progress-log.md` | 逐行进度台账与**全部已知缺口 / 待裁决项** |

## 已知缺口（摘要）

以下均为**读码所得、未修改代码**的登记项，逐条明细与证据见 `documents/plan/progress-log.md`：

- **输入录制链路未接线**：`InputRecorder.record()` 在 `apps/debug/src` 内只有回放分支 `replayCapture` 一处调用点（`apps/debug/src/app.ts:2395`），用户录制器 `inputRecorder`（`apps/debug/src/app.ts:217`）不落样本 ⇒ `__wsInput.exportJson()` 的 frames 恒为空。
- **零分配支路已实现但未装配**：`tick_into` / `state_out_ptr` / `seed_from` 仅被 `src/ts-shared/` 的控制器调用，而这些控制器在三个工程内都没有装配点；`set_yaw_pitch` 在 `apps/**` 与 `src/**` 内零调用点。
- **`.cmd` 的 wasm 新鲜度门与被服务的产物不是同一份**：`start-dev.cmd` / `apps/viewer/play.cmd` 判的是 `pkg/…_bg.wasm`，页面与 dist 构建读的是 `web/…_bg.wasm`。

## 许可与第三方

- 根 `LICENSE`：MIT（Copyright (c) 2026 WebSurf contributors）。
- `src/phys/LICENSE` 与 `src/phys/NOTICE`：共享物理派生自 cs-movement 的许可与声明（分发产物里的 `LICENSE.cs-movement` / `NOTICE.cs-movement` 即由 `build-dist.mjs` 的 `KEEP_SINGLE` 保留）。
- `src/vendor/vmdl/LICENSE`：vendored 的 `vmdl` crate 许可（vendor 与 patch 的声明见根 `Cargo.toml`）。
