# WebSurf-test 概览（整体架构 · 维度 A）

> **事实基准**：本文所有论断核对自当前工作区代码（核对日期 2026-09-11）。未注明前缀的相对路径均相对 `test/dual-mode-harness/`；仓库根共享层代码以 `仓库根 src/…` 标注。核心论断均附「文件:行号」，行号以当前代码为准。
>
> **⚠ 2026-09-11 三模式迁移（本文已据此校订）**：game 的三计算模式特性经真机手测判定失败并**整体回退**
> （`game/` 与 `c4824e9` 逐字节一致，仅耦合模式）。三种模式（`coupled`/`decoupled`/`tick`）的**物理计算本体**
> 现在共享层 `仓库根 src/ts-shared/`（`auth/compute-mode.ts`、`auth/tick-authority.ts`、`tick/ordering-gate.ts`、
> `tick/tick-consumer.ts`、`decoupled/decoupled-loop.ts`），**运行时装配与热切**在本工程
> （`src/worker-a.ts` 三实例 + 双线互斥 gate + `set-mode`/`mode-ack` 握手；`src/main.ts` 通道与 UI）。
> 因此本工程不再是「双模」而是「三模式 + 热切」；`src/worker-a.ts` 由双模循环本体变为**装配层**
> （原 1ms+64t 循环已抽到 `decoupled-loop.ts`）。
>
> 背景材料（未经本文重复核验、仅供溯源）：[../CONCLUSION.md](../CONCLUSION.md)（2026-08-11 会审结论，其「双模」结论针对迁移前的 worker-a 双实例架构，物理结论仍然有效）、[./archive/README.md](./archive/README.md)（旧解析文档归档）。

## 1. 工程定位

**WebSurf-test（test/dual-mode-harness）是「三计算模式物理（耦合/解耦/tick，运行时热切）+ OffscreenCanvas 渲染时序」验证工程**：用最小实现验证一条独立的 `输入 → 三模物理 → 帧信号渲染` 数据通路——主线程只做输入转发与 UI，物理运行在 WorkerA（同一 Worker 内持有三个 PhysWorld 实例：`phys` 权威 / `tickPhys` 解耦校准线 / `scratch` F4-C 乐观评估），渲染运行在 WorkerB（OffscreenCanvas + three.js）。声明见 `package.json:4`（description）与 `src/main.ts:1`（职责头注：「绝不做物理/渲染」）。

- **验证工程定位**：CI 中仅构建验证、不部署——`.github/workflows/deploy-pages.yml:7`（「test/dual-mode-harness = 验证工程（仅构建验证，不部署）」）与 `:134-150`（install + 构建 WASM + 构建 TS + **跑 `npm run test:three-mode` 三模式运行时验证**）。
- **最小集取舍**：BSP 是唯一玩法；只导出 brush 碰撞、模型碰撞、出生点、GLB，**明确排除传送区域与 PVS**（`src/main.ts:166-177`、`crates/wasm/src/lib.rs:18-19`「`parse_teleports()` / `parse_pvs_data()` 保留在 WASM API……主线程导出流程不调用」）；FOV 固定 73.6 无面板（`src/worker-b.ts:96-103`）；UI 仅 HUD 提示 + 难度按钮 + BSP 文件加载（`index.html:68-91`）。
- **与其他工程互不引用**：harness TS 源码无任何指向 debug/game/viewer 的 import；Rust 侧仅共享 crate path 依赖 `websurf-phys` + `websurf-wasm-core`（`crates/wasm/Cargo.toml:19,21`）。与共享层 `仓库根 src/ts-shared/` 的关系在 2026-09-11 迁移后**显著加深**：物理侧 import 6 个共享模块（`auth/shared-state`、`auth/auth-loop`、`auth/worker-dispatch`、`auth/tick-authority`、`decoupled/decoupled-loop`、`auth/compute-mode`，见 `src/worker-a.ts:32-56`；`tick/ordering-gate` 经 `tick-authority` 间接引入），渲染侧 worker-b 亦 import `auth/shared-state` + `auth/compute-mode`（`src/worker-b.ts:49-52`）。**自建的只有渲染通道协议**：`src/shared-state.ts` 的 192B `TestShared`（键位掩码定义仍复用共享层 `:51`），auth 通道则直接用共享层 `ShmState`（512B）。跨工程 ts-shared 消费对照见 [./differences.md](./differences.md) §4。

## 2. 整体架构：三线程 + 一块共享内存

```
┌─────────────────── 主线程（src/main.ts，455 行）───────────────────┐
│  仅：输入捕获（pointer lock）/ 难度按钮 / BSP 文件选择 / DOM HUD   │
│  rAF 帧：addInput(dx,dy,mask) + wake()（src/main.ts:354-364）      │
└────────────┬──────────────────────────────┬────────────────────────┘
             │ 双通道：TestShared 192B（渲染）+ ShmState 512B（auth）│
             ▼                                ▼
┌── WorkerA（src/worker-a.ts，418 行）──┐  ┌── WorkerB（src/worker-b.ts，850 行）──┐
│ 三模式物理装配（计算本体在 ts-shared）：│  │ three.js 第一人称渲染（OffscreenCanvas）│
│ · phys     权威实例（三模式共用）      │  │ · 帧信号驱动：主驱动 = 主线程 rAF wake()│
│ · tickPhys 解耦 64t 校准线             │──▶│ · coupled/decoupled：readState→插值→渲染│
│ · scratch  tick 模式 F4-C 乐观评估     │  │ · tick：TickConsumer 消费 auth 权威帧   │
│ · 双线互斥 gate + set-mode/mode-ack    │  │ · optimizeScene 空间分块合并 + 距离 LOD │
│ 发布即镜像 → TestShared 渲染通道       │  └────────────────────────────────────────┘
└───────────────────────────────────────┘
             ▲ BspProcessor（BSP 解析/GLB 导出，仓库根 websurf-wasm-core）
┌── 主线程 BSP 解析（loadBsp，src/main.ts:203-252）───────────────────┐
│ world-json（brush/tri/spawn）→ WorkerA build_world                  │
│ GLB（transfer）─────────────────────────────▶ WorkerB GLTFLoader    │
└──────────────────────────────────────────────────────────────────────┘
```

三个要点（均有代码出处）：

1. **主线程不做物理/渲染**：`src/main.ts:1` 职责声明；渲染上下文经 `canvas.transferControlToOffscreen()` 交给 WorkerB（`src/main.ts:197-198`），主线程 rAF 只转发输入并发帧信号（`src/main.ts:437-455`），外加计算模式 UI（`:411-431`，只发 `set-mode` 意图，高亮以 worker 回执 `mode-ack` 为准）。
2. **两条 SAB 通道，职责分离**：**渲染通道** `TestShared` 192B（控制区 TICK_RATE/WAKEUP + 输入槽 + RENDER_WAKEUP + 双缓冲状态槽 V + 2×8 Float64，见 [./implementation/shared-layout.md](./implementation/shared-layout.md)）；**auth 通道** 512B，直接用共享层 `ShmState`（权威/解耦帧 + `I_A_SEG/I_A_TICK/I_A_EVT/I_A_PSEQ` 元数据三元组），承载三模式物理的输入消费与帧发布。WorkerA 侧 `MirrorShmState` 在每次发布时把帧镜像进 `TestShared`，使 WorkerB 的耦合/解耦渲染路径零改动（`src/worker-a.ts:122-150`）。
3. **双 Worker 各自自驱**：WorkerA 的 auth 线（`auth-loop`，coupled+tick）与解耦线（`decoupled-loop`，decoupled）各自自驱、按 mode gate 互斥早退（`src/worker-a.ts:178-211`）；WorkerB MessageChannel 自投递续环 + RENDER_WAKEUP 帧信号（`src/worker-b.ts`）。物理发布与渲染节奏解耦——渲染节奏锁定显示器刷新率，物理以最高约 1kHz 子步推进。

**通道模式自适应**（`src/main.ts:74-100`）：`crossOriginIsolated && SharedArrayBuffer` 可用 → 共享内存模式（SAB 直连，最高性能）；否则 → **消息回退模式**（postMessage 等价传输，WorkerA↔WorkerB 经直连 MessageChannel，状态发布不经主线程中转，`src/main.ts:96-99`）。同一 `TestShared` API 双实现，语义等价（`src/shared-state.ts:37-46,164`）。

## 3. 时序图阶段编号（0/1/2/3/4）

代码注释沿用统一时序图阶段编号（旧时序图见 [./archive/runtime-sequence.md](./archive/runtime-sequence.md)，当前实现以本文与 [./sequences.md](./sequences.md) 为准）：

| 阶段 | 内容 | 执行者 | 代码出处 |
|---|---|---|---|
| 阶段0 | 难度调节：难度按钮 → `writeTickRate`（仅 store，无 notify，WorkerA 下轮自动识别）；**计算模式**按钮 → `{type:'set-mode'}` → worker `mode-ack` | 主线程 → SAB/消息 → WorkerA | `src/main.ts:392-409`、`:411-431`；`src/shared-state.ts:269-280` |
| 阶段1 | 输入转发：每 rAF `addInput`（渲染通道）+ `authShared.addInput`/`wake`（auth 通道，三模式物理唯一消费面） | 主线程 → 双 SAB → WorkerA/WorkerB | `src/main.ts:437-455` |
| 阶段2 | 三模式物理：`coupled`=64Hz 权威 / `decoupled`=1ms 真理源+64t 校准 / `tick`=raw 64Hz+F4-C 乐观评估（双线互斥 gate） | WorkerA | `src/worker-a.ts:178-211`（引擎装配）、`:250-300`（热切交接） |
| 阶段3 | 渲染采样：`waitRenderWakeup` →（couple/decoupled）`readState`→插值→render /（tick）`TickConsumer.step` 消费 auth 权威帧 | WorkerB | `src/worker-b.ts:712-733`（onFrame，tick 分支 `:719-733`） |
| 阶段4 | 重生：R 键 → `postMessage({type:'respawn'})` → dispatch 重置三实例 + 采样器 | 主线程 → WorkerA | `src/main.ts:371-373`；`src/worker-a.ts:327`（dispatch env） |

## 4. 模块划分

| 文件 | 行数 | 职责（对应实现篇） |
|---|---|---|
| `src/main.ts` | 455 | 主线程：双通道前置检测与创建（`:126-146`，渲染通道 `init-shared` + auth 通道 `auth-init` + `wasm-init`）、鼠标/键盘输入捕获与本地累积、难度按钮（`:392-409`）、**计算模式 UI**（`:411-431`）、rAF 输入转发（双通道）+ wake（`:437-455`）、BSP 解析与双 Worker 分发（`:253-...`）、transferControlToOffscreen（`:197-198`）、WorkerB 状态摘要 + tick 遥测账行 → DOM HUD |
| `src/shared-state.ts` | 556 | `TestShared`（**渲染通道** 192B）：192B SAB 布局常量（`:65-110`）、输入槽原子累加/CAS 消费（`:374-449`）、WAKEUP/RENDER_WAKEUP 双槽唤醒（`:299-369`）、双缓冲状态槽读写（`:451-547`）、消息回退四模式（`:163-265`）；KEY_MASK 复用自仓库根 ts-shared（`:49-63`）→ [implementation/shared-layout.md](./implementation/shared-layout.md) |
| `src/worker-a.ts` | 418 | **三模式物理装配层**（计算本体在共享层 ts-shared）：三实例 `phys`/`tickPhys`/`scratch` 槽、`MirrorShmState` 发布镜像（`:122-150`）、auth 线 + 解耦线装配与互斥 gate（`:178-211`）、热切交接 `applyModeSwitch`（`:250-300`）、`set-hold`（`:303-322`）、`createWorkerDispatch` 装配（`:327-370`）、harness 私有消息入口（`:373-...`）→ [implementation/dual-physics.md](./implementation/dual-physics.md) |
| `src/worker-b.ts` | 850 | 渲染：three.js WebGLRenderer + OffscreenCanvas 初始化、帧信号驱动循环、**tick 模式经共享层 `TickConsumer` 消费 auth 权威帧**（`:227-233` 模式通知 / `:719-733` onFrame tick 分支）、耦合/解耦 readState + 插值、FPS 相机映射、`optimizeScene` 空间分块合并、距离 LOD、渲染统计 → main HUD |
| `src/renderer/tick-consumer.ts`（+`.test.ts`） | 885 | **迁自 game**：tick 模式渲染消费器——α 确定性网格弦插值、六显示态、Δ 事件驱动控制器、断窗八类（114 断言单测随迁） |
| `src/panel/tick-telemetry-format.ts`（+`.test.ts`） | 98 | **迁自 game**：tick 遥测账行格式化（`formatWorkerStatsLine`/`buildTelemetryPayload`/`formatMarkers`；37 断言单测随迁） |
| `src/worker/phys-instances.ts`（+`t4-chain.test.ts`） | 43 | **迁自 game**：三实例参数扇出（纯函数）+ 三模式链路装配单测（10 例，含 §P8 `set-mode` 三值分派与幂等） |
| `src/wasm.d.ts` | 6 | WASM 类型入口：re-export wasm-pack 产物类型（`../pkg/websurf_test_wasm.js`） |
| `crates/wasm/src/lib.rs` | 1941 | `websurf-test-wasm` 薄导出层：`pub use websurf_phys::phys::PhysWorld`（`:35`）+ `BspProcessor` 最小导出集（metadata/brushes/model 碰撞/spawn/GLB，`:322-1760`；teleport/pvs 保留 API 但主流程不调用，`:18-19`）；2026-09-11 重建后新增共享 `seed_from`/`set_state_ex`/`state_full_json` 导出（tick 模式 F4-C 前提） |
| `index.html` | 122 | 页面骨架：canvas#game、HUD、难度按钮组（0/32/64/128/256/1000，默认 64）、**计算模式按钮组（耦合/解耦/tick）**、tick 遥测账行、BSP 加载栏；`<script type="module" src="./app.js">` |
| `scripts/`（12 个 .mjs） | — | 验证脚本群（见 §6），含 **`three-mode-verify.mjs`（三模式运行时验证）** |
| `package.json` / `tsconfig.json` / `Cargo.toml` / `play.cmd` / `.gitignore` | — | 构建配置（见 §5） |

### 模块间消息协议速览

| 方向 | 消息 | 载荷 |
|---|---|---|
| main → WorkerA | `init-shared` / `init-msg` / `auth-init` / `wasm-init` / `world-json` / `respawn` / `set-mode` / `set-hold` / `input` | 渲染通道 SAB（共享传递）/ 直连端口 / **auth 通道 SAB** / wasmUrl / brush+tri+**teleport**+spawn`{x,y,z,yawDeg}` / — / mode(+state) / hold(+release) / MsgState 回退输入（`src/main.ts:126-146,300-310,347-350`；`src/worker-a.ts:373-412`） |
| main → WorkerB | `init-shared` / `init-msg` / `init-auth` / `compute-mode` / `init-canvas` / `resize` / `glb` | SAB / 直连端口 / **auth 通道 SAB** / 计算模式（由 WorkerA 的 `mode-ack` 转发）/ OffscreenCanvas / 宽高 / GLB ArrayBuffer（transfer）（`src/main.ts:129-134,152-165,185-190,287`；`src/worker-b.ts:52-88`） |
| WorkerA → main | `mode-ack` / `tick-stats` / `error` | 热切回执 `{mode,appliedAtMs}` / tick 门分账与 div 双桶（tick 模式每秒自发，`仓库根 src/ts-shared/auth/tick-authority.ts:462-466`）/ 错误（经 `createWorkerDispatch`；`src/main.ts:118-143` 消费 → `formatWorkerStatsLine`） |
| WorkerB → main | `status` | 位置/速度/朝向/V/GLB 就绪/fps/物理刷新率，每秒一次（`src/worker-b.ts`；`src/main.ts:160-...`） |
| main ↔ WorkerA（消息回退） | `shared-input` / `shared-tick-rate` / `shared-state` | 与渲染通道 SAB 槽语义一一对应（`src/shared-state.ts:140-161`）；auth 通道回退则走 `init`+`input`（`createWorkerSharedState(null)` → `MsgState`） |

## 5. 构建与运行

| 环节 | 命令 | 说明 |
|---|---|---|
| WASM | `npm run build:wasm` | wasm-pack 构建 `crates/wasm`（release、LTO、opt-level 3，`Cargo.toml:21-24`；wasm-opt 关闭，`crates/wasm/Cargo.toml:40-42`）→ `pkg/`，并把 `websurf_test_wasm_bg.wasm` 复制到工程根（`package.json:8`） |
| TS | `npm run build:ts` | `tsc --noEmit` 类型检查 + esbuild 三个入口 bundle 到工程根：`app.js`（main.ts）/ `worker-a.js` / `worker-b.js`（`package.json:10`；入口 URL `new URL('./worker-a.js', import.meta.url)`，`src/main.ts:83-84`） |
| dev 运行 | `npm run dev` 或 `play.cmd` | `python ../../src/serve.py 8080 .`（serve.py 发 COOP/COEP 头启用 SAB，仓库根 `src/serve.py:32-34`）；`play.cmd` 一键引导 npm install → wasm → ts → 起服务开浏览器 |
| dist | `npm run build:dist` | `scripts/build-dist.mjs`：多文件模式（index.html + app.js + worker-a.js + worker-b.js + 外置 wasm 共 5 文件，dev 与 dist 同构；无 single 内嵌模式——test 仅 HTTP 运行，`scripts/build-dist.mjs:10-11`） |
| 契约检查 | `npm run check:api` | `scripts/check-wasm-api.mjs`：断言 pkg d.ts 导出 PhysWorld + 12 个方法（build_world/tick/predict/respawn/teleport_to/set_params/set_hull/set_yaw_pitch/set_velocity/set_state/state/take_event，`scripts/check-wasm-api.mjs:26-39`） |

`.gitignore` 忽略工程根 dev 运行产物（app.js / worker-a.js / worker-b.js / websurf_test_wasm_bg.wasm 等）。

## 6. 验证脚本群（scripts/，12 个）

| 脚本 | 行数 | 用途（据各脚本头注；均为 node 直跑或 CDP，不进 npm test） |
|---|---|---|
| `three-mode-verify.mjs` | 163 | **三模式运行时验证**（`npm run test:three-mode`）：node 里给构建产物 `worker-a.js` 补最小 Web Worker 宿主，按真实消息序列（init-shared/auth-init/wasm-init/world-json/set-mode）驱动，断言热切闭合 + 幂等 + 非法 mode 拒绝 + 每模式帧发布（TestShared V 前进）+ 连续往返 + tick-stats 遥测链路（14 断言） |
| `phys-smoke.mjs` | 3598 | **主力冒烟测试**：node 直跑 pkg wasm。⚠️ **镜像对象 2026-09-11 迁移**：原镜像 `worker-a.ts` 双模循环，现改为镜像 `仓库根 src/ts-shared/decoupled/decoupled-loop.ts`（解耦线语义）+ 本工程 `shared-state.ts`/`worker-b.ts`——`worker-a.ts` 已是三模式装配层，**不要再按它同步**（脚本头注 `:1-16` 已明示）。覆盖 wasm 初始化、解耦线物理语义、SAB 布局回归、唤醒协议、输入限幅、累加器上限、消息回退、梯子世界、真实 surf_666.bsp 端到端；当前实测 **190/191**（1 项「出坡校验#2 各 tick 档位互相一致」为**迁移前既有失败**，已用剥除全部 WIP 的 HEAD Rust 复现同值，与三模式迁移无关） |
| `surf-e2e-verify.mjs` | 289 | surf_666 端到端三线程验证（worker_threads 模拟：解耦线双模 + SAB 传输 + WorkerB readState 不丢帧，`scripts/surf-e2e-verify.mjs:1-8`） |
| `dual-compare.mjs` | 422 | game 双线 vs test 解耦线数据对照（node 直跑 wasm，相同输入序列比对两条物理线的输出，`scripts/dual-compare.mjs:1-12`） |
| `race-wakeup.mjs` | 205 | 唤醒槽并发协议测试（worker_threads 真线程；含旧单槽协议对照组，`scripts/race-wakeup.mjs:1-6`） |
| `perf-bench.mjs` | 323 | 性能基准：1ms 子步耗时分布（p95 < 1000µs 判据）等（`scripts/perf-bench.mjs:1-8`） |
| `render-loop-verify.mjs` | 180 | 渲染循环时序校验 v3（独立定时线程 + busy-wait 微秒级 rAF 节奏，`scripts/render-loop-verify.mjs:1-4`） |
| `workerb-isolated.mjs` | 72 | WorkerB 隔离渲染能力上限测试（无物理竞争，`scripts/workerb-isolated.mjs:1-2`） |
| `flicker-debug.mjs` | 707 | 屏闪根因排查（双缓冲协议压力测试 + 逐版本一致性断言，`scripts/flicker-debug.mjs:1-8`） |
| `check-wasm-api.mjs` | 56 | WASM API 契约校验（见 §5） |
| `build-dist.mjs` | 76 | dist 构建（见 §5） |
| `trace-verify.mjs` | 99 | ⚠️ 历史残留：验证「TraceRecorder→main→TraceRenderer 3D 路径线」链路（`scripts/trace-verify.mjs:1-6`），但当前 `src/` 已无任何 Trace 代码（grep `Trace` 于 src/、index.html、package.json 均为空）——trace/FOV 已随最小集移除（`../CONCLUSION.md:119-124` 如实记录），此脚本仅作存档 |
| `phys-smoke.mjs` 内的 PVS 镜像 | — | ⚠️ 同为历史残留：`PvsMirror` 头注自称「worker-b.ts PvsManager 完整镜像」（`scripts/phys-smoke.mjs:487-488`），但当前 worker-b.ts 已无 PVS 代码（PVS 不在最小集，`src/main.ts:170`）——该镜像块仅作独立回归保留 |

> 写作纪律示例：上述两条 ⚠️ 即「文档以当前代码为准」的落实——脚本头注与当前 src 不一致时，以 src 为准并注明残留。

## 7. 文档导航

- [./sequences.md](./sequences.md) —— 核心时序（维度 T）：启动链、三线程帧循环、双槽唤醒与双缓冲协议、BSP 加载、消息回退、**计算模式热切握手**。
- [./implementation/dual-physics.md](./implementation/dual-physics.md) —— 解耦线物理（维度 I）；三模式总览见本文 §1/§2 与 [../../../documents/ts-shared.md](../../../documents/ts-shared.md)。
- [./implementation/shared-layout.md](./implementation/shared-layout.md) —— TestShared 192B 布局与 WorkerB 渲染（维度 I）。
- [./differences.md](./differences.md) —— 与 debug/game/viewer 及共享层的取舍差异（维度 D）。
- [../../../documents/architecture.md](../../../documents/architecture.md) —— 仓库总架构（workspace 布局、共享层引用矩阵）。
- [../../../documents/phys.md](../../../documents/phys.md) / [../../../documents/wasm-core.md](../../../documents/wasm-core.md) / [../../../documents/ts-shared.md](../../../documents/ts-shared.md) —— 共享层文档（websurf-phys / websurf-wasm-core / ts-shared）。
- [../CONCLUSION.md](../CONCLUSION.md) —— 「64t 坡速 ≈ 无限制」会审结论与修复架构（历史背景，工程根）。
