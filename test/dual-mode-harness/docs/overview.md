# WebSurf-test 概览（整体架构 · 维度 A）

> **事实基准**：本文所有论断核对自当前工作区代码（核对日期 2026-09-07）。未注明前缀的相对路径均相对 `test/dual-mode-harness/`；仓库根共享层代码以 `仓库根 src/…` 标注。核心论断均附「文件:行号」，行号以当前代码为准。
> 背景材料（未经本文重复核验、仅供溯源）：[../CONCLUSION.md](../CONCLUSION.md)（2026-08-11 会审结论）、[./archive/README.md](./archive/README.md)（旧解析文档归档）。

## 1. 工程定位

**WebSurf-test（test/dual-mode-harness）是「双模物理 + OffscreenCanvas 渲染时序」验证工程**：用最小实现验证一条独立的 `输入 → 双模物理 → 帧信号渲染` 数据通路——主线程只做输入转发与 UI，物理运行在 WorkerA（同一 Worker 内持有两个 PhysWorld 实例，双模对照），渲染运行在 WorkerB（OffscreenCanvas + three.js）。声明见 `package.json:4`（description）与 `src/main.ts:1-15`（职责头注：「绝不做物理/渲染」）。

- **验证工程定位**：CI 中仅构建验证、不部署——`.github/workflows/deploy-pages.yml:7`（「test/dual-mode-harness、test/instanced-diorama = 验证工程（仅构建验证，不部署）」）与 `:133-145`（仅 install + 构建 WASM/TS 两步）。
- **最小集取舍**：BSP 是唯一玩法；只导出 brush 碰撞、模型碰撞、出生点、GLB，**明确排除传送区域与 PVS**（`src/main.ts:166-177`、`crates/wasm/src/lib.rs:18-19`「`parse_teleports()` / `parse_pvs_data()` 保留在 WASM API……主线程导出流程不调用」）；FOV 固定 73.6 无面板（`src/worker-b.ts:96-103`）；UI 仅 HUD 提示 + 难度按钮 + BSP 文件加载（`index.html:68-91`）。
- **与其他工程互不引用**：harness TS 源码的全部 import 面仅 6 项——ts-shared KEY_MASK、pkg wasm、本地 shared-state、three ×3（grep `src/*.ts` 核实，无任何指向 debug/game/viewer 的 import）；Rust 侧仅共享 crate path 依赖 `websurf-phys` + `websurf-wasm-core`（`crates/wasm/Cargo.toml:19,21`）；TS 侧仅复用 `KEY_MASK` 键位掩码定义（`src/shared-state.ts:51` import 自 `仓库根 src/ts-shared/auth/shared-state.js`）。跨工程 ts-shared 消费对照（debug/game 7 模块、viewer 0 模块）见 [./differences.md](./differences.md) §4。

## 2. 整体架构：三线程 + 一块共享内存

```
┌─────────────────── 主线程（src/main.ts，364 行）───────────────────┐
│  仅：输入捕获（pointer lock）/ 难度按钮 / BSP 文件选择 / DOM HUD   │
│  rAF 帧：addInput(dx,dy,mask) + wake()（src/main.ts:354-364）      │
└────────────┬──────────────────────────────┬────────────────────────┘
             │ SAB 192B（Atomics）/ postMessage 回退          │
             ▼                                ▼
┌── WorkerA（src/worker-a.ts，361 行）──┐  ┌── WorkerB（src/worker-b.ts，787 行）──┐
│ 双模物理核心：                         │  │ three.js 第一人称渲染（OffscreenCanvas）│
│ · phys    模式A：1ms 无限制真理源      │  │ · 帧信号驱动：主驱动 = 主线程 rAF wake()│
│ · tickPhys 模式B：独立 64t 速度线      │──▶│ · readState 采样双缓冲 → 插值 → 渲染    │
│   （唯一影响通道 = set_velocity 校准） │  │ · optimizeScene 空间分块合并 + 距离 LOD │
│ 状态槽唯一写入者 = 模式A               │  └────────────────────────────────────────┘
└───────────────────────────────────────┘
             ▲ BspProcessor（BSP 解析/GLB 导出，仓库根 websurf-wasm-core）
┌── 主线程 BSP 解析（loadBsp，src/main.ts:203-252）───────────────────┐
│ world-json（brush/tri/spawn）→ WorkerA build_world                  │
│ GLB（transfer）─────────────────────────────▶ WorkerB GLTFLoader    │
└──────────────────────────────────────────────────────────────────────┘
```

三个要点（均有代码出处）：

1. **主线程不做物理/渲染**：`src/main.ts:1-15` 职责声明；渲染上下文经 `canvas.transferControlToOffscreen()` 交给 WorkerB（`src/main.ts:151-152`），主线程 rAF 只转发输入并发帧信号（`src/main.ts:354-364`）。
2. **一块 SAB（192B）承载全部通道**：控制区（TICK_RATE / WAKEUP）+ 输入槽（dxAcc/dyAcc/keysMask）+ 渲染唤醒槽（RENDER_WAKEUP）+ 双缓冲状态槽（V + 2×8 个 Float64）。布局与读写协议见 [./implementation/shared-layout.md](./implementation/shared-layout.md)。
3. **双 Worker 各自自驱**：WorkerA `setTimeout(loop,0)` 续环 + WAKEUP 背压（`src/worker-a.ts:213-308`）；WorkerB MessageChannel 自投递续环 + RENDER_WAKEUP 帧信号（`src/worker-b.ts:648-662`）。物理发布与渲染节奏解耦——渲染节奏锁定显示器刷新率，物理以最高约 1kHz 子步推进。

**通道模式自适应**（`src/main.ts:74-100`）：`crossOriginIsolated && SharedArrayBuffer` 可用 → 共享内存模式（SAB 直连，最高性能）；否则 → **消息回退模式**（postMessage 等价传输，WorkerA↔WorkerB 经直连 MessageChannel，状态发布不经主线程中转，`src/main.ts:96-99`）。同一 `TestShared` API 双实现，语义等价（`src/shared-state.ts:37-46,164`）。

## 3. 时序图阶段编号（0/1/2/3/4）

代码注释沿用统一时序图阶段编号（旧时序图见 [./archive/runtime-sequence.md](./archive/runtime-sequence.md)，当前实现以本文与 [./sequences.md](./sequences.md) 为准）：

| 阶段 | 内容 | 执行者 | 代码出处 |
|---|---|---|---|
| 阶段0 | 难度调节：难度按钮 → `writeTickRate`（仅 store，无 notify，WorkerA 下轮自动识别） | 主线程 → SAB → WorkerA | `src/main.ts:332-347`、`src/shared-state.ts:269-280` |
| 阶段1 | 输入转发：每 rAF `addInput`（Atomics.add 累加）+ `wake()`（双槽通知） | 主线程 → SAB → WorkerA/WorkerB | `src/main.ts:354-364` |
| 阶段2 | 双模物理循环：先 tick 计算（模式B）→ 后无限制计算（模式A） | WorkerA | `src/worker-a.ts:212-308`（头注「阶段2」） |
| 阶段3 | 渲染采样：`waitRenderWakeup` → `readState` → 插值 → `renderer.render` | WorkerB | `src/worker-b.ts:4,648-717`（标签在 ：4 头注） |
| 阶段4 | 重生：R 键 → `postMessage({type:'respawn'})` → 双实例同步重置 | 主线程 → WorkerA | `src/main.ts:315-317`、`src/worker-a.ts:327-337` |

## 4. 模块划分

| 文件 | 行数 | 职责（对应实现篇） |
|---|---|---|
| `src/main.ts` | 364 | 主线程：SAB 前置检测与模式选择（`:74-100`）、鼠标/键盘输入捕获与本地累积（`:254-330`）、难度按钮（`:332-347`）、rAF 输入转发 + wake（`:354-364`）、BSP 解析与双 Worker 分发（`:166-252`）、transferControlToOffscreen（`:147-159`）、WorkerB 状态摘要 → DOM HUD（`:111-145`） |
| `src/shared-state.ts` | 556 | `TestShared`：192B SAB 布局常量（`:65-110`）、输入槽原子累加/CAS 消费（`:374-449`）、WAKEUP/RENDER_WAKEUP 双槽唤醒（`:299-369`）、双缓冲状态槽读写（`:451-547`）、消息回退四模式（`:163-265`）；KEY_MASK 复用自仓库根 ts-shared（`:49-63`）→ [implementation/shared-layout.md](./implementation/shared-layout.md) |
| `src/worker-a.ts` | 361 | 双模物理核心：模式A `phys`（1ms 无限制真理源）+ 模式B `tickPhys`（独立 64t 速度线）、先 tick 后无限制的自驱循环（`:213-308`）、tick 边界采样/锚定/速度校准（`:240-270`）、消息协议与世界构建（`:126-210,311-354`）→ [implementation/dual-physics.md](./implementation/dual-physics.md) |
| `src/worker-b.ts` | 787 | 渲染：three.js WebGLRenderer + OffscreenCanvas 初始化（`:207-241`）、帧信号驱动循环（`:624-662`）、采样与插值（`:672-743`）、FPS 相机映射（`:746-754`）、`optimizeScene` 空间分块合并（`:347-556`）、距离 LOD（`:589-605`）、渲染统计 → main HUD（`:757-779`）→ [implementation/shared-layout.md](./implementation/shared-layout.md) |
| `src/wasm.d.ts` | 6 | WASM 类型入口：re-export wasm-pack 产物类型（`../pkg/websurf_test_wasm.js`） |
| `crates/wasm/src/lib.rs` | 1941 | `websurf-test-wasm` 薄导出层：`pub use websurf_phys::phys::PhysWorld`（`:35`）+ `BspProcessor` 最小导出集（metadata/brushes/model 碰撞/spawn/GLB，`:322-1760`；teleport/pvs 保留 API 但主流程不调用，`:18-19`） |
| `index.html` | 96 | 页面骨架：canvas#game、HUD、难度按钮组（0/32/64/128/256/1000，默认 64，`:78-85`）、BSP 加载栏；`<script type="module" src="./app.js">`（`:94`） |
| `scripts/`（11 个 .mjs） | — | 验证脚本群（见 §6） |
| `package.json` / `tsconfig.json` / `Cargo.toml` / `play.cmd` / `.gitignore` | — | 构建配置（见 §5） |

### 模块间消息协议速览

| 方向 | 消息 | 载荷 |
|---|---|---|
| main → WorkerA | `init-shared` / `init-msg` / `init-wasm` / `world-json` / `respawn` | SAB（postMessage 共享，不可 transfer）/ 直连端口 / wasmUrl / brush+tri+spawn / —（`src/main.ts:92-98,231,316`；`src/worker-a.ts:70-99`） |
| main → WorkerB | `init-shared` / `init-msg` / `init-canvas` / `resize` / `glb` | SAB / 直连端口 / OffscreenCanvas / 宽高 / GLB ArrayBuffer（transfer）（`src/main.ts:93,99,152-158,237`；`src/worker-b.ts:52-80`） |
| WorkerB → main | `status` | 位置/速度/朝向/V/GLB 就绪/fps/物理刷新率，每秒一次（`src/worker-b.ts:83-93,767-778`；`src/main.ts:113-145`） |
| main ↔ WorkerA（消息回退） | `shared-input` / `shared-tick-rate` / `shared-state` | 与 SAB 槽语义一一对应（`src/shared-state.ts:140-161`） |

## 5. 构建与运行

| 环节 | 命令 | 说明 |
|---|---|---|
| WASM | `npm run build:wasm` | wasm-pack 构建 `crates/wasm`（release、LTO、opt-level 3，`Cargo.toml:21-24`；wasm-opt 关闭，`crates/wasm/Cargo.toml:40-42`）→ `pkg/`，并把 `websurf_test_wasm_bg.wasm` 复制到工程根（`package.json:8`） |
| TS | `npm run build:ts` | `tsc --noEmit` 类型检查 + esbuild 三个入口 bundle 到工程根：`app.js`（main.ts）/ `worker-a.js` / `worker-b.js`（`package.json:10`；入口 URL `new URL('./worker-a.js', import.meta.url)`，`src/main.ts:83-84`） |
| dev 运行 | `npm run dev` 或 `play.cmd` | `python ../../src/serve.py 8080 .`（serve.py 发 COOP/COEP 头启用 SAB，仓库根 `src/serve.py:32-34`）；`play.cmd` 一键引导 npm install → wasm → ts → 起服务开浏览器 |
| dist | `npm run build:dist` | `scripts/build-dist.mjs`：多文件模式（index.html + app.js + worker-a.js + worker-b.js + 外置 wasm 共 5 文件，dev 与 dist 同构；无 single 内嵌模式——test 仅 HTTP 运行，`scripts/build-dist.mjs:10-11`） |
| 契约检查 | `npm run check:api` | `scripts/check-wasm-api.mjs`：断言 pkg d.ts 导出 PhysWorld + 12 个方法（build_world/tick/predict/respawn/teleport_to/set_params/set_hull/set_yaw_pitch/set_velocity/set_state/state/take_event，`scripts/check-wasm-api.mjs:26-39`） |

`.gitignore` 忽略工程根 dev 运行产物（app.js / worker-a.js / worker-b.js / websurf_test_wasm_bg.wasm 等）。

## 6. 验证脚本群（scripts/，11 个）

| 脚本 | 行数 | 用途（据各脚本头注；均为 node 直跑或 CDP，不进 npm test） |
|---|---|---|
| `phys-smoke.mjs` | 3585 | **主力冒烟测试**：node 直跑 pkg wasm，镜像 shared-state/worker-a/worker-b 核心逻辑，53 条断言（`scripts/phys-smoke.mjs:1-8`；断言计数 grep `check('` = 53）——覆盖 wasm 初始化、双模物理语义、SAB 布局回归（dyAcc/V 重叠修复，`:10-11 号断言`）、唤醒协议、输入限幅、累加器上限、消息回退、梯子世界、真实 surf_666.bsp 端到端 |
| `surf-e2e-verify.mjs` | 289 | surf_666 端到端三线程验证（worker_threads 模拟：WorkerA 双模 + SAB 传输 + WorkerB readState 不丢帧，`scripts/surf-e2e-verify.mjs:1-8`） |
| `dual-compare.mjs` | 422 | game 双线 vs test 双模数据对照（node 直跑 wasm，相同输入序列比对两条物理线的输出，`scripts/dual-compare.mjs:1-12`） |
| `race-wakeup.mjs` | 205 | 唤醒槽并发协议测试（worker_threads 真线程；含旧单槽协议对照组，`scripts/race-wakeup.mjs:1-6`） |
| `perf-bench.mjs` | 321 | 性能基准：1ms 子步耗时分布（p95 < 1000µs 判据）等（`scripts/perf-bench.mjs:1-8`） |
| `render-loop-verify.mjs` | 180 | 渲染循环时序校验 v3（独立定时线程 + busy-wait 微秒级 rAF 节奏，`scripts/render-loop-verify.mjs:1-4`） |
| `workerb-isolated.mjs` | 72 | WorkerB 隔离渲染能力上限测试（无物理竞争，`scripts/workerb-isolated.mjs:1-2`） |
| `flicker-debug.mjs` | 707 | 屏闪根因排查（双缓冲协议压力测试 + 逐版本一致性断言，`scripts/flicker-debug.mjs:1-8`） |
| `check-wasm-api.mjs` | 56 | WASM API 契约校验（见 §5） |
| `build-dist.mjs` | 76 | dist 构建（见 §5） |
| `trace-verify.mjs` | 99 | ⚠️ 历史残留：验证「TraceRecorder→main→TraceRenderer 3D 路径线」链路（`scripts/trace-verify.mjs:1-6`），但当前 `src/` 已无任何 Trace 代码（grep `Trace` 于 src/、index.html、package.json 均为空）——trace/FOV 已随最小集移除（`../CONCLUSION.md:119-124` 如实记录），此脚本仅作存档 |
| `phys-smoke.mjs` 内的 PVS 镜像 | — | ⚠️ 同为历史残留：`PvsMirror` 头注自称「worker-b.ts PvsManager 完整镜像」（`scripts/phys-smoke.mjs:487-488`），但当前 worker-b.ts 已无 PVS 代码（PVS 不在最小集，`src/main.ts:170`）——该镜像块仅作独立回归保留 |

> 写作纪律示例：上述两条 ⚠️ 即「文档以当前代码为准」的落实——脚本头注与当前 src 不一致时，以 src 为准并注明残留。

## 7. 文档导航

- [./sequences.md](./sequences.md) —— 核心时序（维度 T）：启动链、三线程帧循环、双槽唤醒与双缓冲协议、BSP 加载、消息回退。
- [./implementation/dual-physics.md](./implementation/dual-physics.md) —— WorkerA 双模物理（维度 I）。
- [./implementation/shared-layout.md](./implementation/shared-layout.md) —— TestShared 192B 布局与 WorkerB 渲染（维度 I）。
- [./differences.md](./differences.md) —— 与 debug/game/viewer 及共享层的取舍差异（维度 D）。
- [../../../docs/architecture.md](../../../docs/architecture.md) —— 仓库总架构（workspace 布局、共享层引用矩阵）。
- [../../../docs/phys.md](../../../docs/phys.md) / [../../../docs/wasm-core.md](../../../docs/wasm-core.md) / [../../../docs/ts-shared.md](../../../docs/ts-shared.md) —— 共享层文档（websurf-phys / websurf-wasm-core / ts-shared）。
- [../CONCLUSION.md](../CONCLUSION.md) —— 「64t 坡速 ≈ 无限制」会审结论与修复架构（历史背景，工程根）。
