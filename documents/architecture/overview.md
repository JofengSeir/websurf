# 架构总览：受控工程与共享层

> 本文是**共享层文档**（P2）的一篇，内容全部来自当前源码与构建配置的实测；每个结论都带「相对仓库根路径:行号」锚点，由 `node src/scripts/check-doc-drift.mjs` 校验。
> 术语与书写规范见 `documents/norms/annotation-and-verification.md`；当前任务规范与待决项见根 `AGENTS.md`。

---

## 1. 受控范围

| 区域 | 内容 | 实测依据 |
|---|---|---|
| `apps/debug` | 调试工程：参数面板、碰撞体/触发器可视化、路径录制与回放、授权时钟验证 | 该工程 `package.json` 的 scripts 实测含 `test:auth-clock`、`test:jump-apex`、`plot:path`、`test:path-acceptance` |
| `apps/game` | 游戏工程：面板、存档点、物理冒烟门 | 该工程 `package.json` 的 scripts 实测含 `test:phys`、`test:seed-smoke`、`test:surf-crouch` |
| `apps/viewer` | 查看器：BSP 查看 + Shavit 录像回放 | 该工程 `package.json` 的 scripts 实测含 `test:replay`、`local:smoke` |
| `src/` | 三工程共用的**共享层**（Rust 两个 crate + TS 运行时 + 默认材质包） | 见 §2 |

被排除、且**不得**作为事实来源的区域：已退役的 `test/dual-mode-harness/`（工作区已删除）、本地实验工程 `test/game-core/`（不在版本库）、`node_modules/`、`target/`、`pkg/`、`dist/`、`web/app.js`、`web/worker.js`、`web/*.wasm`、`apps/debug/fixtures/**`。

---

## 2. 共享层构成（逐项实测）

| 位置 | 规模 | 角色 |
|---|---|---|
| `src/Cargo.toml` + `src/lib.rs` | crate `websurf-phys`，`crate-type = ["rlib"]`，`[lib] path = "lib.rs"` | 共享物理层（CS 运动） |
| `src/phys/` | **7** 个 `.rs` | 物理实现（世界、玩家、传送、种子、两组门禁测试） |
| `src/wasm-core/` | **26** 个 `.rs` | 共享解析层（BSP/实体/game lump/HHV/材质/模型/MTZ/光照图） |
| `src/ts-shared/` | **23** 个 `.ts`（其中 **4** 个 `*.test.ts`） | TS 运行时：wasm 加载、世界构建、PVS、输入、tick、授权、解耦环 |
| `src/materials/textures.mtz` | 单个资产文件 | 默认纹理包（MTZ 容器） |
| `src/scripts/` | 6 个脚本 + `lib/` | 仓库级门禁与工具（漂移体检、共享层一致性、wasm 新鲜度、wasm-bindgen/node 依赖安装） |
| `src/vendor/vmdl` | 第三方 vendored crate | 模型解析依赖 |

`src/` 各子目录的职责以该目录下的模块头注释为准，本表不重复展开。

---

## 3. 依赖方向（实测，单向）

```
apps/{debug,game,viewer}/crates/wasm  ──►  src/wasm-core（websurf-wasm-core）
apps/{debug,game}/crates/wasm         ──►  src/（websurf-phys）
apps/*/src/**（TypeScript）            ──►  src/ts-shared/**
```

| 事实 | 证据 |
|---|---|
| `apps/debug` 与 `apps/game` 的 wasm crate 同时依赖共享物理层与共享解析层 | 两份 `apps/*/crates/wasm/Cargo.toml` 均含 `websurf-phys = { path = "../../../../src" }` 与 `websurf-wasm-core = { path = "../../../../src/wasm-core" }` |
| `apps/viewer` 的 wasm crate **只**依赖共享解析层 | `apps/viewer/crates/wasm/Cargo.toml` 只含 `websurf-wasm-core = { path = "../../../../src/wasm-core" }`；其头注写明不含物理、不含 mosaic/缺失纹理/默认纹理包 |
| **不存在**工程内的 `wasm-core` 隔离副本 | `apps/*/crates/` 下只有 `wasm` 一个 crate 目录；全仓只有一份 `src/wasm-core/` |
| 反向依赖不存在 | 共享层两个 crate 均不引用 `apps/**`；`src/wasm-core/Cargo.toml` 的依赖里没有 `websurf-phys` |
| TS 侧以相对路径引用共享层 | 例：`apps/debug/src/world/spawn-loader.ts` 以 `'../../../../src/ts-shared/phys/angles.js'` 引入 `bspYawToCsYaw`（来源文件是 `src/ts-shared/phys/angles.ts`，import 说明符按 ESM 规则写 `.js`） |

**不要**把三工程当成彼此的副本：`apps/{debug,game,viewer}/src/renderer/lightmap-shader.ts` 在三工程内各有一份**同构副本**（内容由本仓维护、可逐字节比对），而 `apps/<app>/crates/wasm/src/lib.rs`、`apps/<app>/src/renderer/renderer-main.ts`、`apps/<app>/src/app.ts` 三份**各自独立实现**，行数与导出面都不同。

---

## 4. 共享层对外接口（入口锚点）

### 4.1 物理层（Rust）

| 接口 | 锚点 |
|---|---|
| 物理世界导出类型 `PhysWorld` | `src/phys/mod.rs:104` |
| 单步（返回状态对象）`tick` | `src/phys/mod.rs:242` |
| 单步（零分配，写共享缓冲）`tick_into` | `src/phys/mod.rs:265` |
| 参数写入 `set_params`（JSON 键通道） | `src/phys/mod.rs:542` |
| 世界数据 `World` | `src/phys/world.rs:955` |
| 传送门检测 `check` | `src/phys/teleport.rs:266` |

### 4.2 解析层（Rust）

| 接口 | 锚点 |
|---|---|
| BSP 文件容器 `BspFile` | `src/wasm-core/vbsp/bspfile.rs:28` |
| 实体解析 `read_entities` | `src/wasm-core/vbsp/reader.rs:71` |
| 导出入口 `export_bsp_with_models` | `src/wasm-core/bsp_to_gltf_core/convert.rs:179` |
| MTZ 容器魔数 `MAGIC`（`MTZ6`）与旧版 `MAGIC_V5` | `src/wasm-core/mosaic/mtz.rs:45`、`src/wasm-core/mosaic/mtz.rs:47` |
| 单图编码 `img_to_code` | `src/wasm-core/mosaic/encode.rs:68` |
| VTF 容器 `VTF` 与其读取 `read` | `src/wasm-core/texture_utils/vtf.rs:71`、`src/wasm-core/texture_utils/vtf.rs:93` |
| 模块清单（`pub mod`） | `src/wasm-core/lib.rs:36` 起 |

### 4.3 TS 运行时

| 接口 | 锚点 | 用途 |
|---|---|---|
| `base64ToBytes` | `src/ts-shared/wasm/loader.ts:44` | 内嵌 wasm 载荷解码 |
| `buildWorldBundle` | `src/ts-shared/phys/world-builder.ts:143` | 世界构建（BSP → wasm → 场景数据） |
| `PvsManager` | `src/ts-shared/world/pvs-manager.ts:68` | cluster 查询与可见集 |
| `layerMouseDelta` / `M_YAW` / `INPUT_CLAMP` | `src/ts-shared/input/input-layer.ts:25`、`:22`、`:19` | 输入归一 |
| `MouseBuffer` | `src/ts-shared/input/mouse-buffer.ts:37` | 主线程鼠标增量缓冲 |
| `PointerLockController` | `src/ts-shared/input/pointer-lock.ts:38` | 指针锁定 |
| `TICK_PERIOD_MS` / `DELTA_DEFAULT_MS` | `src/ts-shared/tick/tick-consumer.ts:60`、`:67` | 渲染侧 tick 周期 |
| `createOrderingGate` | `src/ts-shared/tick/ordering-gate.ts:134` | 提交顺序裁决 |
| `createAuthLoop` | `src/ts-shared/auth/auth-loop.ts:250` | Worker 侧权威时钟 |
| `createWorkerDispatch` | `src/ts-shared/auth/worker-dispatch.ts:207` | Worker 消息分发 |
| `createMainSharedState` / `createWorkerSharedState` | `src/ts-shared/auth/shared-state.ts:1022`、`:1030` | 共享内存视图 |
| 事件位 `AUTH_EVT` | `src/ts-shared/auth/shared-state.ts:146` | 权威事件编码 |
| `createTickAuthority` | `src/ts-shared/auth/tick-authority.ts:274` | F4 乐观门（**已实现、未接线**，见 §6） |
| `createDecoupledLoop` | `src/ts-shared/decoupled/decoupled-loop.ts:211` | 解耦环（**已实现、未接线**，见 §6） |

---

## 5. 启动链与帧链

### 5.1 启动链（三个工程同形）

1. `apps/<app>/web/index.html` 加载打包后的 `web/app.js`（构建产物，非本仓源码）。
2. `apps/<app>/src/app.ts` 是主线程装配入口：它取 DOM、建渲染器、建 Worker、绑定面板。
3. Worker 侧入口是 `apps/<app>/src/worker/main.ts`：装配 `self.onmessage` 与各控制器。
4. 世界构建走共享层的 `buildWorldBundle`（`src/ts-shared/phys/world-builder.ts:143`），其内部经 `src/ts-shared/wasm/loader.ts` 加载 wasm 产物；出生点坐标/yaw 换算由 `src/ts-shared/phys/angles.ts` 的 `bspYawToCsYaw` 提供（`apps/debug/src/world/spawn-loader.ts` 是同一换算的参考实现，全仓无 import）。
5. Rust 侧由 `apps/<app>/crates/wasm/src/lib.rs` 暴露 `#[wasm_bindgen]` 函数，转发到 `src/wasm-core`（解析）与 `src/phys`（物理）。

### 5.2 帧链（`apps/debug` 与 `apps/game` 共形）

| 参与者 | 动作 |
|---|---|
| 主线程 | 每帧渲染；把渲染采样写进共享内存（`writeRenderSample`，无 epoch 参数） |
| 主线程 | 输入经 `MouseBuffer.process` → `layerMouseDelta` → 送入 Worker |
| Worker | `createAuthLoop` 以固定步长驱动物理；`createWorkerDispatch` 分发主线程消息 |
| Worker | 采样前后各读一次渲染世代（`readRenderSample` + `readRenderEpoch`），用于校验采样时效 |
| Worker | 权威状态写回共享内存；`phys-event` 一类事件消息回主线程，由 `app.ts` 转发到碰撞修正 |
| 共享内存 | SAB；权威帧双缓冲位于**字节 128-287**（`B_A0 = 16`、`B_A1 = 26`，各 10 个 8 字节槽位），渲染槽枚举含 `RT_X`/`RT_Y`/`RT_Z`/`RT_T` |

`apps/viewer` **不参与**上述帧链：它不建物理、不用 `PvsManager`、不用 `MouseBuffer`、不用 `PointerLockController`，worker 侧也没有 `createAuthLoop` / `createWorkerDispatch`。

---

## 6. 关键不变量与遗留事实

1. **权威时钟只有一个来源**：`src/ts-shared/auth/auth-loop.ts:250` 的 `createAuthLoop`；其步长由 `setFixedDt` 改写，`reset()` 会把累积器、唤醒基准与仿真时钟一并清零。调用方只在步长**真变化**时 `reset`（`src/ts-shared/auth/worker-dispatch.ts:207` 的分支）。
2. **零分配物理支路已实现、未接线**：`tick_into`（`src/phys/mod.rs:265`）、`state_out_ptr`、`seed_from` 的调用方只有 `src/ts-shared/auth/tick-authority.ts` 与 `src/ts-shared/decoupled/decoupled-loop.ts`，而这两个控制器在三个工程内**都没有装配点**。线上路径走的是 `tick`（返回状态对象）。
3. **三份 `crates/wasm/src/lib.rs` 各自维护**：导出面不同，不构成同构副本。
4. **默认关闭的能力**：debug 的 `lod.pvsEnabled` 默认 `false`；`LodManager.update` 只做「块中心到相机距离」这一条判据（不查 cluster、无迟滞带）。
5. **可执行门禁**：`cargo test -p websurf-phys`（物理门禁测试）、各工程 `npm run typecheck`、`node src/scripts/check-doc-drift.mjs`（文档锚点与路径）、`node src/scripts/check-shared-sync.mjs`（Rust 与 TS 两侧常量逐位比对）、`node src/scripts/wasm-stale-check.mjs`（wasm 产物新鲜度）。

---

## 7. 构建与产物

| 用途 | 命令 | 产物 |
|---|---|---|
| 共享物理检查 | `cargo check -p websurf-phys`（或 `src/` 内 `cargo check`） | 无（rlib） |
| 共享解析检查 | `cargo check -p websurf-wasm-core` | 无 |
| 工程 wasm | 各工程 `npm run build:wasm` | `apps/<app>/pkg/**` |
| 工程 TS | 各工程 `npm run build:ts`（先 `build:worker` + `build:app`） | `apps/<app>/web/app.js`、`web/worker.js` |
| 分发包 | 各工程 `npm run build:dist` | 依赖 `src/scripts/lib/dist-pack.mjs` 写入内嵌 wasm 前导 |
| 类型检查 | 各工程 `npm run typecheck` | 无 |

三个工程的脚本名集合**不完全相同**（例如 `test:*` 门禁：debug 有 `test:auth-clock`/`test:jump-apex`/`test:path-acceptance`/`test:optimize-scene`/`test:surf-crouch`，game 有 `test:phys`/`test:seed-smoke`/`test:surf-crouch`，viewer 有 `test:replay`/`local:smoke`），以各工程 `package.json` 为准。
