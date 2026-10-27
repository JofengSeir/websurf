# 架构总览（2026-10-27 建；一页地图）

> 本文只做导航，**不是规则来源**：规则以 [AGENTS.md](../AGENTS.md)（作业与提交）与
> [docs/render-parity.md](render-parity.md)（渲染归属）为准。各节给出事实出处；与代码冲突时以代码为准。

## 1. 顶层结构：四条 Cargo workspace + 四个 npm 工程

- **根 workspace**（根 `Cargo.toml`）：两个成员——`src`（`websurf-phys` 共享物理）与
  `src/wasm-core`（`websurf-wasm-core` BSP/GLB/模型解析导出）。
- **三端各自 workspace**：`apps/{debug,game,viewer}` 各自声明 `[workspace]`，成员 `crates/wasm`
  （三端同名 `websurf-wasm`——Cargo 不允许同名成员进同一 workspace，故拆四条；见根
  `Cargo.toml:4-10` 头注释）。`target/` 在仓库根与三工程下各一份。
- npm：仓库根 `package.json` 只承载跨工程共享依赖（`three` 单实例，`renderer-shared` 由此解析）
  与少量流程脚本；三端各自是独立 npm 工程，`scripts/` 每端两个（`build-dist.mjs`、
  `check-wasm-api.mjs`，共享引擎在 `src/scripts/lib/`）。
- vendored 补丁：`src/vendor/vmdl`（Source 模型解析，改写 2 文件）、`src/vendor/lzma`
  （LZMA 滑窗 O(n²) 修复）——改写点与理由见根 `Cargo.toml` 头注释与 README §3。
- 生成物不入库：`pkg/`（wasm-pack）、`apps/*/web` 除 `index.html`/`styles.css` 外全部、
  `dist/`、`target/`（`.gitignore` 白名单制）。

## 2. 渲染线数据流（BSP 字节 → 画面）

1. 各端 `crates/wasm` 的 `BspProcessor` 解析 BSP/模型/材质，导出 GLB（水体/透明等数据写进
   `vbsp_*` extras；`apps/*/crates/wasm/src/lib.rs`）。
2. 共享层 `src/renderer-shared/` 消费 GLB：`scene/assemble-scene.ts` 装配（GLB → 终扫的
   7 步契约，含合并成块）→ `scene/render-session.ts` 的 `RenderSession` 接管之后的全部接线
   （相机/可见性/环境/天空/贴图画质/每帧 draw；`render-session.ts:1-20` 有模块级说明）。
3. **归属铁律**：渲染步骤只允许存在于 `assembleScene`/`RenderSession`；三端只留数据源与
   端特有 overlay（debug 可视网格与排查开关、game 物理/面板/HUD、viewer 回放/浏览）。
   门禁 `node src/scripts/check-render-parity.mjs` + CI `render-parity` job；规则与同机位
   看图流程见 [docs/render-parity.md](render-parity.md)。
4. 可见性默认全加载（D-123）：档值 0 = `cullDistance = Infinity`，只靠相机视锥；显式正值才按
   **块表面**距离剔除（`src/renderer-shared/scene/visibility-controller.ts`）。
5. 呈现档按端隔离（D-122）：键 `vbsp:renderPrefs:<viewer|debug|game>`，深链 `?prefs=`
   （`src/renderer-shared/config/render-prefs.ts`）。

## 3. 物理线数据流（brush/tri JSON → 确定性 tick）

- 上游：各端 wasm 的 `BspProcessor::export_brushes_planes` 产 `WasmBrush[]` JSON；tri 与
  teleport 由 TS 侧 `buildWorldBundle` 产出 JSON；三者一并交 `build_world` 建 brush/tri
  双空间索引——**全部走 JSON 中转，无内存直传**（`src/phys/mod.rs:1-15`）。
- 每端运行时恰两个 `PhysWorld` 实例：主线程预测（`apps/*/src/renderer/renderer-main.ts`）
  与 Worker 权威（`apps/*/src/worker/main.ts`）；权威帧按定标写进 SAB
  （`src/ts-shared/auth/shared-state.ts` 的 `writeAuthoritative`）。SAB 依赖 COOP/COEP 响应头
  （本地 `src/scripts/serve.py` 注入），缺失时降级消息回退，功能等价。
- `apps/viewer` 不依赖 `websurf-phys`（纯查看器，其 wasm 只用 `websurf-wasm-core`；
  `src/phys/mod.rs:21-24`）。
- 确定性要求：输入、记录与录像回放走同一条确定性链路；物理回归门
  `cargo test -p websurf-phys`（当前 40 测试）。

## 4. 门禁与构建（CI = `.github/workflows/ci-gates.yml`，部署另在 deploy-pages.yml）

| job | 内容 |
|---|---|
| rust-unit-tests | `cargo test -p websurf-phys` |
| wasm-core-tests | `cargo test -p websurf-wasm-core`（宿主；夹具缺地图时自行跳过） |
| source-contract | viewer 的 Rust serde 键 ↔ TS 接口键（`check-wasm-api.mjs --source-only`） |
| render-parity | 三端渲染入口必须走共享 RenderSession |
| ts-typecheck | 三端 `tsc --noEmit` |
| debug/game-gates | wasm 构建冒烟 + `build:ts` 打包冒烟 |
| glb-parity | 三端 `build:wasm` + `check:api`（wasm 导出 ↔ TS 导入契约） |

纯文档改动（`**.md`）不触发 CI（`paths-ignore`，接受的现状：文档无自动检查）。本地提交门：
pre-commit 钩子（D-124，AGENTS §7-0）。

## 5. 文档与记忆地图

- 入库文档：README（快速开始与命令）、CONTRIBUTING（贡献流程）、AGENTS（agent 作业规则 +
  AMH 记忆接入 §3）、docs/render-parity（渲染归属与看图流程）、本文（地图）。
- 本地实验记录（`.gitignore` 刻意保留）：`docs/T-650-*` 等水体九份（入口
  `docs/T-650-INDEX.md`）；agent 任务台账 `.dsh/plans/`；临时落点 `.tmp/`。
- 跨会话记忆：AMH gateway（通道 A：`node src/scripts/agent-memory.mjs`，AGENTS §3）。
