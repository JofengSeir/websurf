# WebSurf-test 核心差异（维度 D）

> **事实基准**：本文所有对照论断核对自当前工作区代码（核对日期 2026-09-07）。未注明前缀的相对路径均相对 `test/dual-mode-harness/`；其他工程与共享层路径以 `game/…`、`debug/…`、`viewer/…`、`仓库根 src/…` 标注。总体架构见 [./overview.md](./overview.md)；实现细节见 [./implementation/dual-physics.md](./implementation/dual-physics.md) 与 [./implementation/shared-layout.md](./implementation/shared-layout.md)。

## 0. 一张表看懂定位差异

| 维度 | WebSurf-test（本工程） | game / debug | viewer |
|---|---|---|---|
| 定位 | **时序验证工程**：双模物理 + OffscreenCanvas 渲染时序验证（`package.json:4`） | 完整可玩产品（面板/计时挑战/地图管理等功能层） | 地图浏览/查看器（无物理） |
| 线程拓扑 | 主线程（仅输入/UI）+ WorkerA（双模物理）+ WorkerB（渲染）三线程 | 主线程（预测物理 + 渲染 + UI）+ Worker（权威帧计算）双线程 | 单线程主线程 |
| 渲染位置 | **WorkerB**（OffscreenCanvas，主线程零取帧零等待，`src/main.ts:151-152`） | **主线程** canvas（rAF tick 内 renderer.render，`game/src/renderer/renderer-main.ts:693-734`） | 主线程 |
| 物理 | WorkerA 双实例：1ms 无限制真理源 + 独立 64t 速度线（`src/worker-a.ts:103-107`） | Worker 权威 64Hz 单实例 + 主线程预测单实例（`仓库根 src/ts-shared/auth/auth-loop.ts:89`；`game/src/renderer/renderer-main.ts:700-710`） | 无（`viewer/crates/wasm/Cargo.toml:5` 注释明示「不含 websurf-phys（无物理）」，依赖表亦无此依赖） |
| ts-shared 复用 | 仅 `KEY_MASK`（`src/shared-state.ts:51`） | 7 模块：auth-loop/shared-state/worker-dispatch + input-layer + authority-calibrator/params/world-builder（grep `debug/src`、`game/src` ts-shared import 核实） | 无 import（grep 空仅注释引用，`viewer/src/core/pose.ts:11`） |
| CI | 仅构建验证不部署（`仓库根 .github/workflows/deploy-pages.yml:7,133-145`） | 构建并部署 Pages | 构建并部署 Pages |

以下各节展开最关键的四处差异（SAB 布局、物理拓扑与校准、渲染管线、最小集取舍）。

## 1. SAB 布局：192B harness 专属 vs 512B 权威帧协议

两套协议**同族不同版**：harness 的 `TestShared` 与 game/debug 的 ts-shared `SharedState` 都是「SAB + Atomics + 双缓冲状态槽」，但布局与语义不同（`src/shared-state.ts:2-4` 自我声明「不是同一套」）。

| 项 | harness（`src/shared-state.ts:6-21`） | game/debug（仓库根 `src/ts-shared/auth/shared-state.ts:17-27`） |
|---|---|---|
| 总大小 | 192B（实际用至 168B） | 512B |
| 控制区 | TICK_RATE + WAKEUP（难度/背压唤醒） | V_A（权威版本号）+ I_KEYS + A_GROUND |
| 输入槽 | dxAcc/dyAcc（BigInt64 ×1000 定点）+ keysMask + RENDER_WAKEUP（计数帧信号） | dxAcc/dyAcc（BigInt64 ×1000）+ keysMask；无渲染唤醒概念 |
| 状态槽 | 双缓冲 2×8 值：pos×3 / vel×3 / yaw / pitch | 双缓冲 2×10 值：pos×3 / yaw / pitch / vel×3 / **eyeHeight** / **timeMs**（定点缩放） |
| 版本语义 | V（Atomics.add 递增；读者 acquire 比对 + double-check 防撕裂，`:518-547`） | V_A（Worker release 递增；主线程读 `(V_A-1)&1` 已离开槽，`:29-31`） |
| 唤醒模型 | **双槽分离**：WAKEUP（电平+CAS，WorkerA 背压）+ RENDER_WAKEUP（计数，WorkerB 渲染帧信号）（`:299-369`） | Worker `setTimeout(loop, 4)` 自驱发布（`仓库根 src/ts-shared/auth/auth-loop.ts:194`），主线程经 Worker onmessage 收权威帧——无 Atomics.wait 通道 |
| 消费差异影响 | 状态槽无 eyeHeight/timeMs → WorkerB 固定 `EYE_STAND=64.09` 眼高、无蹲伏（`src/worker-b.ts:108-109`）；时间戳用本地 `performance.now()` | eyeHeight 槽位支撑蹲伏眼高渐变；timeMs 供权威速度外推校准计算帧距（`仓库根 src/ts-shared/phys/authority-calibrator.ts:66-68,298-300`） |

## 2. 物理拓扑：同一 Worker 内双实例 vs 跨线程「权威 + 预测」

### 2.1 实例归属不同

- **harness**：两个 PhysWorld 都在 **WorkerA** 内——`phys`（模式A，1ms 子步实时输入，唯一 SAB 输入消费者与状态槽写入者）+ `tickPhys`（模式B，仅 64t 步长，独立演化）（`src/worker-a.ts:103-107,21-22`）。
- **game/debug**：权威 PhysWorld 在 **Worker**（auth-loop 固定步长 `fixedDt=1/64`，`config.physics.tickRate` 动态覆盖，`仓库根 src/ts-shared/auth/auth-loop.ts:89,205-213`）；预测 PhysWorld 在**主线程**（可变 dt ≤ 0.1s、每 rAF 一 tick，`game/src/renderer/renderer-main.ts:701-710`；debug 同序 `debug/src/renderer/renderer-main.ts:437-447`）。

### 2.2 「哪条线是真理」方向相反

| | harness | game/debug |
|---|---|---|
| 真理源 | **无限制 1ms 模式A**（位置/角度只由它推进；渲染参数唯一来源） | **渲染主线**（144Hz 预测物理精度高于权威 64Hz+消息延迟；大偏差时「以渲染主线为准反向同步权威」，`仓库根 src/ts-shared/phys/authority-calibrator.ts:8-11`） |
| tick 线对渲染线的影响 | **速度校准**：每 tick 边界 `phys.set_velocity(tickPhys 三轴)`（`src/worker-a.ts:268-269`）——同 Worker 内直接调用 | **外推校准**：每渲染帧 `calibrateVelocity` → `phys.set_velocity(权威速度 + 权威加速度×Δt)`（`authority-calibrator.ts:298-313`）——跨线程，速度来自权威帧消息 |
| 异常兜底 | 分叉锚定：tick 实例与模式A 位置偏差 > 64 → 全量 set_state 拉回（`src/worker-a.ts:174-188,254-261`） | correctFromAuthority 只读权威 + 大偏差反向同步（`onSyncRenderState` 全状态发回 Worker，同步瞬间清空双端未消费输入；阈值 dist>500 / >300+yaw≤3° / ≤300+yaw>45°，`authority-calibrator.ts:120-140,240-266`） |
| tick 语义 | 模式B 是「难度手感」载体：键位=边界快照（peekKeys）、鼠标=模式A 实时消耗的窗口累积（`src/worker-a.ts:246-253`）——刻意模拟 64t 服务器输入粒度 | 权威 Worker 与主线程**消费同一输入**（主线程每 rAF addInput 给权威，`renderer-main.ts:704`；预测线用同一 pending 输入 tick，`:710`）——两侧同输入同物理，权威帧仅作校准基准 |

### 2.3 TICK_RATE 的含义完全不同

- harness：难度按钮写 `TICK_RATE`（关/32/64/128/256/1000）——控制**模式B 步长**（1/tickRate），经 set_velocity 通道限制模式A 速度演化，是「手感难度旋钮」；tickDt ≤ 1ms（1000Hz）或 0 时退化为纯无限制（`src/worker-a.ts:224-226`；`index.html:76-77` 注释「只影响手感；渲染恒平滑跟随 1ms 无限制物理状态」）。
- game：`config.physics.tickRate` 是**权威模拟频率**（auth-loop fixedDt 覆盖，`仓库根 src/ts-shared/auth/auth-loop.ts:88-89`）——权威帧的产生速率，不是难度概念。

### 2.4 respawn 通道不同

- harness：R 键 → 独立 postMessage `{type:'respawn'}` → WorkerA 直接 `phys.respawn()` + `tickPhys.respawn()`（`src/main.ts:315-317`、`src/worker-a.ts:327-337`）；键位掩码只有 5 位（无 reset 位）。
- game：R 键映射为 `reset` 掩码位（`KEY_MASK.reset=128`）随输入进入物理（ts-shared input.reset 语义；`game/src/input/keymap.ts:36` `reset: ['KeyR']`）。

## 3. 渲染管线：WorkerB 帧信号 vs 主线程 rAF

| 环节 | harness（`src/worker-b.ts`） | game（`game/src/renderer/renderer-main.ts`） |
|---|---|---|
| 渲染驱动 | 主线程 rAF 仅发**帧信号**（RENDER_WAKEUP 计数 + notify）；WorkerB 醒来采样渲染；50ms 超时兜底；absorbRenderWake 限制帧率 ≤ 刷新率（`:648-662,636-669`） | 渲染与物理同在主线程 rAF tick 内——tick → 相机 → renderer.render（`:693-734`） |
| 渲染参数来源 | readState 双缓冲采样 → 本地副本（唯一来源）→ 状态间插值（`:672-717`） | 直接读主线程预测物理 `predPhys.state()`（每帧全 dt 推进，无需插值）（`:720-727`） |
| 眼高 | 固定 EYE_STAND=64.09（无 eyeHeight 槽） | `st.eyeHeight`（每帧，含蹲伏）（`:727`） |
| 近平面 | 无自适应（固定 0.5） | 贴墙自适应：每 2 帧 `updateNearPlane` 收缩 near 防透视裁剪（`:729-733`） |
| 场景组织 | **optimizeScene 空间分块合并**（3.4 万 Mesh → 300~800 空间块，块内按材质子合并）+ 单档距离 LOD（LOD_DIST=9200）+ FRUSTUM_PAD 视锥外保一圈 + 雾（`src/worker-b.ts:347-556,113-121`） | lodItems 多级：LOD_NEAR / LOD_FAR / **PVS 隐藏**（pvsManager + clusterIds 判定，`:739-759`）；无分块合并 |
| 剔除粒度 | 空间块（合并后 ~数百对象/帧遍历） | 原始 mesh/LOD 组 |
| HUD | OffscreenCanvas 无第二 context → 每秒 `status` 消息回主线程 DOM（`:757-779`） | 主线程内直接 DOM/面板 |

debug 与 game 渲染同构（`仓库根 src/ts-shared/phys/authority-calibrator.ts:5` 「由 game/debug 两端 renderer-main 收敛而来」；debug tick 顺序逐行对照 `debug/src/renderer/renderer-main.ts:430-462`，另多消费渲染物理事件 `take_event` 用于计时挑战检查点/死亡统计 `:901`——harness 不消费任何 PhysWorld 事件）。

## 4. 最小集取舍（harness 刻意「减法」）

harness 作为验证工程，对共享解析层的消费是**裁剪过的最小集**（`crates/wasm/src/lib.rs:1-21` 头注）：

1. **保留**：`metadata / export_brushes_planes / export_model_phy_colliders / export_model_tri_colliders / parse_spawn_points / export_glb_with_pakfile_models`（主线程运行时仅调用这五个 + metadata，`lib.rs:15-17`；main.ts 调用面见 [./sequences.md](./sequences.md) §8）。
2. **排除**：`parse_teleports()` / `parse_pvs_data()` 保留在 WASM API（供脚本/扩展）但**主线程导出流程不调用**——排除传送区域/PVS 等非核心移动影响（`lib.rs:18-19`；`src/main.ts:166-177` 注释）；WorkerA 侧传空 teleport report `EMPTY_TELEPORT_JSON`（`src/worker-a.ts:66-67`）。
3. **未导出**：mosaic/缺失纹理/薄壳（test 工程最小 BSP 游玩不需要，`lib.rs:21`）；GLB 走 `export_glb_with_pakfile_models`（含 PAKFILE 模型三件套提取，`:1685-1740`）。
4. 契约固化：`scripts/check-wasm-api.mjs:26-39` 只锁 PhysWorld 12 API（共享层实际 21 个导出方法的子集，仓库根 `src/phys/mod.rs`）。

对比 game/debug：消费完整共享层（ts-shared 7 模块 + 权威帧协议 + 面板/config 层）；对比 viewer：只要 BSP→GLB 展示，连物理 crate 都不依赖（`viewer/crates/wasm/Cargo.toml:5,18-19`：注释明示不含 websurf-phys，仅依赖 websurf-wasm-core）。

## 5. 工程形态差异（workspace 与产物名）

- **workspace 隔离**：仓库根 workspace 只收共享层两个 crate（`仓库根 Cargo.toml:21-26`）；4 个模块 crate 有意保留各自 workspace——其中 **debug/game 的 wasm crate 同名 `websurf-wasm`**（Cargo workspace 不允许同名成员，`仓库根 Cargo.toml:5-11`），harness 的 crate 名为 `websurf-test-wasm`（`crates/wasm/Cargo.toml:8`）、viewer 为 `websurf-viewer-wasm`（`viewer/crates/wasm/Cargo.toml:8`）——同名约束只涉及前两者。harness 自建 `[workspace] members=["crates/wasm"]` + 同款 `[patch.crates-io] vmdl = path`（`Cargo.toml:9-16`）。
- **产物名各不相同**：harness → `pkg/websurf_test_wasm.js` + wasm 复制到工程根 `websurf_test_wasm_bg.wasm`（`package.json:8`）；debug/game → 各自 `pkg/websurf_wasm.js`（同名不同包）；viewer → `pkg/websurf_viewer_wasm.js`（各工程 crates/wasm/Cargo.toml 产物名核实）。
- **WASM 构建配置同款**：LTO + opt-level 3 + codegen-units 1（`Cargo.toml:22-27`）；wasm-opt 关闭（`crates/wasm/Cargo.toml:30-31`，注：本机 NODE_OPTIONS 污染 wasm-opt，LTO 已足够）。
- **运行通道要求**：harness 主路径依赖 SAB（`crossOriginIsolated`，`src/main.ts:74-80`）→ 必须 HTTP + COOP/COEP（`仓库根 src/serve.py:32-34`）；为此保留**消息回退模式**做到 file:// 等无 SAB 环境功能等价（`src/main.ts:75-77`）——这是其他工程没有的降级通道（game/debug 权威帧协议强依赖 SAB）。
- **验证脚本规模**：harness 独有 11 个验证脚本（53 断言主力冒烟 + 唤醒并发 + 性能基准 + 屏闪排查 + 双线对照等，[./overview.md](./overview.md) §6）；两个 ⚠️ 历史残留（trace-verify.mjs、phys-smoke 内 PvsMirror）均为脚本自包含、不影响当前 src 行为（grep `Trace`/`Pvs` 于 src/ 均无实现代码）。

## 6. 什么时候读哪篇

- 要理解**为什么 harness 存在**（tick 无关的物理事实、双模设计动因）→ 工程根 [../CONCLUSION.md](../CONCLUSION.md)。
- 要理解**数据怎么流**（三线程、双槽唤醒、双缓冲）→ [./sequences.md](./sequences.md)。
- 要理解**物理怎么做**（双实例、锚定、速度校准）→ [./implementation/dual-physics.md](./implementation/dual-physics.md)。
- 要理解**布局与渲染细节**（192B 布局、分块合并、LOD）→ [./implementation/shared-layout.md](./implementation/shared-layout.md)。
- 要对照**仓库全局**（workspace、共享层引用矩阵、其他工程）→ [../../../docs/architecture.md](../../../docs/architecture.md) 与 [../../../docs/ts-shared.md](../../../docs/ts-shared.md)。
