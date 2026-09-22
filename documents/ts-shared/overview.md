# 共享 TS 运行时层（`src/ts-shared`）

> 本文是**共享层文档**（P2）的一篇，内容全部来自当前源码实测；每个结论带「相对仓库根路径:行号」锚点，由 `node src/scripts/check-doc-drift.mjs` 校验。
> 三工程与共享 Rust 层的关系见 `documents/architecture/overview.md`；术语见 `documents/plan/doc-rewrite-taskbook.md`。

---

## 1. 定位与边界

`src/ts-shared/` 是 `apps/debug`、`apps/game`、`apps/viewer` 共用的 TypeScript 运行时层，负责：wasm 加载、世界构建、PVS 查询、输入归一、渲染 tick 消费、权威时钟与共享内存协议。

- 它**不**包含任何 DOM/场景装配：渲染器、面板、事件绑定都在各工程自己的 `src/**` 里。
- 它**不**依赖 `apps/**`（依赖方向单向，见架构总览 §3）。
- 三个工程对它的使用面**并不相同**：例如 `apps/viewer` 不用 `PvsManager`、`MouseBuffer`、`PointerLockController`、`AuthorityCalibrator`。

## 2. 文件与职责（实测清单）

| 文件 | 职责 |
|---|---|
| `src/ts-shared/wasm/loader.ts` | wasm 载荷解码与实例化辅助（`base64ToBytes`、内嵌前导 `__VBSP_WASM_B64__` 的读取） |
| `src/ts-shared/phys/world-builder.ts` | 世界构建：解析产物 → 场景数据（碰撞体、出生点、材质清单） |
| `src/ts-shared/phys/constants.ts` | 物理侧常量（`EYE_STAND` 等），与 Rust 侧逐位对齐 |
| `src/ts-shared/phys/angles.ts` | 角度换算的唯一实现：`wrapDeg`、`bspYawToCsYaw` |
| `src/ts-shared/phys/params.ts` | 面板参数 → wasm `set_params` 载荷（`buildPhysicsParams`） |
| `src/ts-shared/phys/authority-calibrator.ts` | 权威校准（面板三档碰撞体来源，仅 `apps/debug` 装配） |
| `src/ts-shared/world/pvs-manager.ts` | cluster 查询、可见集、可见性统计 |
| `src/ts-shared/world/types.ts` | 世界相关类型定义 |
| `src/ts-shared/input/input-layer.ts` | 输入归一：鼠标增量与按键掩码 → 物理入参 |
| `src/ts-shared/input/mouse-buffer.ts` | 主线程鼠标增量缓冲（带单帧钳制） |
| `src/ts-shared/input/pointer-lock.ts` | 指针锁定状态机 |
| `src/ts-shared/tick/ordering-gate.ts` | 提交顺序裁决门（静态约束 + 运行时三值裁决） |
| `src/ts-shared/tick/tick-consumer.ts` | 渲染侧 tick 消费（插值/外推窗口） |
| `src/ts-shared/auth/auth-loop.ts` | Worker 侧权威时钟（固定步长驱动、欠账排空） |
| `src/ts-shared/auth/worker-dispatch.ts` | Worker 消息分发（config / phys / replay 等分支） |
| `src/ts-shared/auth/shared-state.ts` | 共享内存（SAB）视图与协议常量 |
| `src/ts-shared/auth/compute-mode.ts` | 计算模式表（耦合 / 解耦 / 交接） |
| `src/ts-shared/auth/tick-authority.ts` | F4 乐观门控制器 |
| `src/ts-shared/decoupled/decoupled-loop.ts` | 解耦环控制器 |
| `src/ts-shared/**/*.test.ts` | 4 个自跑测试（见 §7） |

## 3. 对外接口（锚点）

| 接口 | 锚点 |
|---|---|
| `base64ToBytes` | `src/ts-shared/wasm/loader.ts:44` |
| `buildWorldBundle` | `src/ts-shared/phys/world-builder.ts:143` |
| `bspYawToCsYaw` | `src/ts-shared/phys/angles.ts` 的导出函数（同文件另有 `wrapDeg`） |
| `layerMouseDelta` | `src/ts-shared/input/input-layer.ts:25` |
| 常量 `M_YAW` / `INPUT_CLAMP` | `src/ts-shared/input/input-layer.ts:22`、`src/ts-shared/input/input-layer.ts:19` |
| `MouseBuffer` | `src/ts-shared/input/mouse-buffer.ts:37` |
| `PointerLockController` | `src/ts-shared/input/pointer-lock.ts:38` |
| `createOrderingGate` | `src/ts-shared/tick/ordering-gate.ts:134` |
| 常量 `TICK_PERIOD_MS` / `DELTA_DEFAULT_MS` | `src/ts-shared/tick/tick-consumer.ts:60`、`src/ts-shared/tick/tick-consumer.ts:67` |
| `createAuthLoop` | `src/ts-shared/auth/auth-loop.ts:250` |
| `createWorkerDispatch` | `src/ts-shared/auth/worker-dispatch.ts:207` |
| 事件位 `AUTH_EVT` | `src/ts-shared/auth/shared-state.ts:146` |
| `createMainSharedState` / `createWorkerSharedState` | `src/ts-shared/auth/shared-state.ts:1022`、`src/ts-shared/auth/shared-state.ts:1030` |
| `createTickAuthority` | `src/ts-shared/auth/tick-authority.ts:274` |
| `createDecoupledLoop` | `src/ts-shared/decoupled/decoupled-loop.ts:211` |
| `PvsManager` | `src/ts-shared/world/pvs-manager.ts:68` |

## 4. 主流程

### 4.1 世界构建

1. 主线程取内嵌 wasm 载荷（构建期由 `src/scripts/lib/dist-pack.mjs` 的 `writeEmbeddedPreamble` 写入前导；viewer 另有自写的 `dist/wasm-embedded.js` 路径）。
2. `base64ToBytes` 解码 → 实例化 wasm（三工程的 pkg 名：debug 与 game 同为 `websurf_wasm.*`，viewer 为 `websurf_viewer_wasm.*`）。
3. `buildWorldBundle` 调解析层导出，装配碰撞体来源、出生点、材质清单，返回渲染器所需的世界包。
4. `apps/debug` 额外传面板三档碰撞体来源与缺失纹理收集回调；`apps/game` 只传 `decompressMtz` 与进度回调。

### 4.2 输入

主线程 `mousemove` 监听器 → `MouseBuffer.process` → `layerMouseDelta` → 送入 Worker。两条口径不可混用：真实鼠标位移**乘** sensitivity，而 `Q`/`E` 键转向**不乘**（物理侧 sensitivity 由 `buildPhysicsParams` 固定为 `1`）。

### 4.3 tick 与授权时钟

1. Worker 侧 `createAuthLoop` 以固定步长驱动 `phys.tick`；步长由 `setFixedDt` 改写，`reset()` 会清零累积器、唤醒基准与仿真时钟。
2. `createWorkerDispatch` 处理主线程消息；其 `config`/`physics` 分支只在**步长真变化**时 `reset`（`setFixedDt` 返回 `true`）。
3. 主线程每帧写入渲染采样（位置 + 索引，无 epoch 参数）；Worker 侧读取时同时校验渲染世代，用于判定采样时效。
4. 渲染侧由 `tick-consumer` 按 `TICK_PERIOD_MS` 与 `DELTA_DEFAULT_MS` 决定插值/外推窗口；`ordering-gate` 对提交顺序做静态约束（`δ + ε_max ≤ T`）与运行时三值裁决（放行 / 顺延 / 丢弃），并处理 i32 回绕。

### 4.4 共享内存协议

`shared-state.ts` 定义 SAB 分区与视图：权威帧双缓冲位于**字节 128-287**（`B_A0 = 16`、`B_A1 = 26`，各 10 个 8 字节槽位），解耦帧区在其后（**字节 288-447**）；渲染槽枚举含 `RT_X`/`RT_Y`/`RT_Z`/`RT_T` 与 `RT_EPOCH`。`RT_EPOCH` 只由 `resetRenderSample` 写入，读取方就地读槽内值。

## 5. 关键不变量

1. **角度换算只有一个实现**：任何 Source↔cs-movement 的 yaw 换算都走 `bspYawToCsYaw`（加 180° 后归一到 `[0, 360)`）；`wrapDeg` 把 `-0` 收敛为 `+0`。
2. **`setFixedDt` 的返回值是调用契约**：返回 `false` 表示步长未变、内部量未被触碰；调用方据此跳过 `reset`。
3. **输入钳制分两段**：单帧位移先在 `mouse-buffer` 内按 `MAX_DELTA` 钳制，再在 `input-layer` 受 `INPUT_CLAMP` 限制。
4. **PVS 的可见性判据由调用方选择**：`PvsManager.update` / `isVisible` 只有 `apps/game` 调用；`apps/debug` 只用 `getClusterAt` 与统计读取，其 `currentClusterId` 保持 `-1`、`visibleCount` 保持 `0`。

## 6. 未接线与零调用点（如实登记）

| 项 | 事实 |
|---|---|
| `tick-authority` 的 F4 乐观门 | `createTickAuthority` 全仓只有其自身测试调用；三个工程均无装配点 |
| `decoupled-loop` | `createDecoupledLoop` 全仓无装配点；其依赖的环境槽 `decoupledLoop` 无人填充 |
| 物理零分配支路 | `tick_into` / `state_out_ptr` / `seed_from` 的调用方只有上述两个未接线的控制器；线上路径走 `tick()` 返回对象 |
| `compute-mode` 的三模式接线 | `apps/**` 内无该模块的 import、无 `set-mode` 发送方、未注入 `getComputeMode` / `onSetMode` ⇒ 共享层缺省恒落 `'coupled'`；`resolveAuthTickRate` 零调用点 |
| `MouseBuffer.push` / `drain` | 零调用点（线上路径是 `process()`） |
| `ShmState.wake` | 零调用点（其唯一调用方 `waitWakeup` 只被未接线的解耦环使用） |
| `maskToKeys` | 零调用点 |
| `PvsManager.getFaceCluster` / `visibleClusterCount` | 零调用点 |
| `world/types.ts` 的 `rootNode` 字段 | TS 侧无消费点 |

## 7. 测试与门禁

四个测试文件各自包含可执行入口（`node` 直跑，esbuild 打包；**均未挂进任何 `package.json` 脚本**）：

| 测试 | 覆盖 |
|---|---|
| `src/ts-shared/auth/compute-mode.test.ts` | 计算模式表与交接矩阵的自洽性 |
| `src/ts-shared/tick/ordering-gate.test.ts` | 顺序门的三值裁决、静态约束与回绕 |
| `src/ts-shared/auth/shared-state.protocol.test.ts` | 共享内存协议的写序合同（偶值快照、PSEQ 复检、代际复检、探针接缝） |
| `src/ts-shared/auth/tick-authority.test.ts` | F4 乐观门的唤醒/封帽/闭账恒等式等 19 例 |

运行方式（以仓库实际布局为准，头注内已写明）：从 `apps/game` 出发用 `npx esbuild ../../src/ts-shared/<路径>.test.ts --bundle --format=esm --platform=node --outfile=<临时产物>` 打包后 `node <临时产物>`。

仓库级门禁：`node src/scripts/check-shared-sync.mjs`（Rust 与 TS 两侧常量逐位比对，含 `EYE_STAND` 子检查）、`node src/scripts/check-doc-drift.mjs`（文档锚点）、各工程 `npm run typecheck`。注意 `apps/game/scripts/phys-smoke.mjs` 会**正则解析** `src/ts-shared/phys/constants.ts` 的 `EYE_STAND` 导出行取值，故该行的写法是被脚本依赖的接口。
