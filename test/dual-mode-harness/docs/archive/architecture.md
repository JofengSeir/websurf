# 整体架构

> 目标：验证一条独立的「输入 → 双模物理 → 帧信号渲染」循环。
> 主线程只做输入转发 / UI；WorkerA 做双模物理；WorkerB 用 OffscreenCanvas 渲染；
> 三线程通过 SAB 无锁共享内存（不可用时退化为 postMessage 消息回退）。

## 1. 高层拓扑

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 主线程 main.ts                                                             │
│  · crossOriginIsolated + SAB 检测 → 共享内存 / 消息回退                     │
│  · 键盘/鼠标累积 → addInput(SAB 输入槽)                                     │
│  · 每 rAF wake()：WAKEUP(WorkerA 背压) + RENDER_WAKEUP(WorkerB 帧信号)      │
│  · 难度按钮 writeTickRate；R → respawn                                      │
│  · BSP 文件 → BspProcessor 导出 → 分发 world-json / glb（最小集，无 pvs）    │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ SAB 192B / postMessage
┌───────────────▼──────────────────────────┐   ┌──────────────────────────────┐
│ WorkerA worker-a.ts 双模物理核心          │   │ WorkerB worker-b.ts 渲染核心 │
│  · 模式A：1ms 无限制真理源                 │   │  · OffscreenCanvas + three.js │
│  · 模式B：独立 64t tickPhys 权威速度线     │   │  · 帧信号驱动（主驱动=rAF）    │
│  · 先 tick 计算，后无限制计算              │   │  · readState 非阻塞采样        │
│  · 唯一状态槽写入者（writeStateFromPhys）  │   │  · 本地副本只被 readState 更新 │
│  · waitWakeup 背压                        │   │  · 插值渲染 + absorbRenderWake│
└───────────────┬──────────────────────────┘   └──────────────┬───────────────┘
                │ SAB 状态双缓冲 V++ / 消息直连                  │
                └──────────────────────────────────────────────┘
```

## 2. 线程职责

### 2.1 主线程 `src/main.ts`

- **不做物理/渲染**：只做输入转发、UI、BSP 解析与消息分发。
- 启动时创建 `SharedArrayBuffer(192)` 并 `postMessage` 给 WorkerA（`init-shared`）与 WorkerB（`init-shared`）。
- 若 `SharedArrayBuffer` 不可用或 `crossOriginIsolated !== true`，进入**消息回退模式**：
  - 主线程 → WorkerA 用 `msg-main`（`shared-input` / `shared-tick-rate`）；
  - WorkerA → WorkerB 用 `MessageChannel` 直连（`shared-state`）。
- `frame()`：每个 rAF 清空本地鼠标累积，`keysToMask` 生成键位掩码，`shared.addInput(dx,dy,mask)`，然后 `shared.wake()`。
- `wake()` 是双槽唤醒：
  - `WAKEUP`：电平语义 `store(1)+notify(1)`，唤醒 WorkerA 物理背压；
  - `RENDER_WAKEUP`：计数语义 `add(1)+notify(1)`，作为 WorkerB 渲染主驱动（与 vsync 对齐）。
- BSP 加载：文件选择 → `ensureMainWasm()` → `new BspProcessor(bytes)` → 依次导出 brush/模型碰撞/spawn/GLB（最小集，不含 teleport/PVS）→ 分发给 WorkerA / WorkerB。
- 其他 UI：难度按钮（`writeTickRate`）；已移除 FOV 滑块与 trace 按钮（非核心）。

### 2.2 WorkerA `src/worker-a.ts` — 双模物理核心

- 持有两个 `PhysWorld`：
  - `phys`：模式A，1ms 固定子步，**无限制真理源**，共享状态槽唯一写入者；
  - `tickPhys`：模式B，独立 64t 权威速度线，只走 `tickDt` 步长。
- 循环 `loop()`：
  1. 读取真实时间片 `delta`，clamp 到 `[0, 0.05]`；
  2. 读 `TICK_RATE`，判断 `modeBActive`（`tickRate > 0 && 1/tickRate > 1ms`）；
  3. **先 tick**：`loAcc += delta`，每到达 tick 边界执行一次 `tickPhys.tick`，并用 `phys.set_velocity(tickPhys 三轴速度)` 校准模式A；
  4. **后无限制**：`acc += delta`，每 1ms 子步 `consumeInput()`（不限幅——缺省 `maxDelta=Infinity`，主线程已按单事件削平）→ `phys.tick` → `writeStateFromPhys()`；
  5. 背压：距下次子步 ≥ 1ms 时 `waitWakeup`，否则自旋；`setTimeout(loop, 0)` 续环。
- 输入唯一入口：`shared.consumeInput()` 只在模式A子步调用（不限幅，直通完整帧增量，见 `worker-a.ts:282-285`）；tick 边界用 `shared.peekKeys()` 读键位快照，鼠标用模式A 已消耗窗口的累积增量，并施加 tick 窗口限幅 `tickInputMax = MAX_INPUT_DELTA × tickDt/1ms`（见 §3.1 附注）。
- 分叉兜底：`tickPhys` 与 `phys` 位置偏差平方和 > `64²` 时 `alignTickPhys()` 全量拉回。
- 世界构建：收到 `world-json` 后 `set_hull(16,72,54)` + `build_world(...)`；两个实例同世界同出生点；内部传空 teleport report，确保无传送区域；死亡阈值取 brushJson 最小 `min[1]-100`。

### 2.3 WorkerB `src/worker-b.ts` — three.js 第一人称渲染

- 通过 `transferControlToOffscreen()` 获得 OffscreenCanvas 控制权，在 Worker 内创建 `WebGLRenderer`。
- 帧循环用 `MessageChannel` 自投递 + `waitRenderWakeup(RENDER_WAKEUP)`：
  - 主驱动 = 主线程 rAF 帧信号（vsync 对齐）；
  - WorkerA 发布**不 notify**；
  - 50ms 超时仅作停摆兜底。
- 每次唤醒：`shared.readState()` 非阻塞采样；V 更新才刷新本地副本；未更新时在 SAB 模式下仍按插值窗口渲染（物理发布 < 刷新率时平滑），消息回退模式下未更新则降频。
- 渲染参数唯一来源 = `readState()` 返回的 WorkerA 状态；`localCopy` 只被 `readState` 更新。
- GLB 挂载后执行 `optimizeScene()` 空间分块合并（3.4 万 Mesh → 数百块）、`assignMeshCullingData()`、`applyCulling()`。
- **PVS 已从 WorkerB 移除**（最小集不包含检测/遮挡剔除）；只保留距离 LOD。
- 每秒回传 `status` 给主线程 HUD。

### 2.4 共享状态 `src/shared-state.ts`

SAB 192B 布局：

| Int32 索引 | 字节 | 字段 | 语义 |
|---|---|---|---|
| 0 | 0..3 | `TICK_RATE` | 难度，仅 store 不 notify |
| 1 | 4..7 | `WAKEUP` | WorkerA 背压电平信号 |
| BigInt64[1]（Int32 索引 2..3） | 8..15 | `dxAcc` | 鼠标 X 定点累加 |
| BigInt64[2]（Int32 索引 4..5） | 16..23 | `dyAcc` | 鼠标 Y 定点累加 |
| 6 | 24..27 | `keysMask` | 当前键位掩码 |
| 7 | 28..31 | `RENDER_WAKEUP` | WorkerB 帧信号计数 |
| 8 | 32..35 | `V` | 状态版本号 |
| 5..12 / 13..20 (Float64) | 40..167 | S[0]/S[1] | 双缓冲状态槽：pos×3/vel×3/yaw/pitch |

> **KEY_MASK 位宽注（同名不同宽）**：`keysMask` 的位定义在两个工程中同名常量、宽度不同——
> ts-shared 为 **11 位全量掩码**（forward..yawRight，对应 `src/phys/mod.rs:546-556` apply_input
> 位定义，见 `src/ts-shared/auth/shared-state.ts:56-68`）；本工程（harness）仅实现**前 5 位子集**
> （forward/backward/left/right/jump，`src/shared-state.ts:47-54`）。跨工程阅读时勿混淆两者宽度。

- 写入协议：WorkerA 写“当前 V 的另一槽”，再 `Atomics.add(V,1)`；
- 读取协议：WorkerB acquire 读 V，V 未变返回 null；否则读当前槽并 double-check 防撕裂；
- `RENDER_WAKEUP` 使用计数语义 + `absorbRenderWake()`，保证渲染频率 ≤ 显示器刷新率。

### 2.5 WASM 薄导出层 `crates/wasm/src/lib.rs`

- 导出 `PhysWorld`（共享物理系统）与 `BspProcessor`（BSP 解析 + 最小导出集）。
- `BspProcessor` 导出方法（WASM API 保留）：`metadata()`、`export_brushes_planes()`、`export_model_phy_colliders()`、`export_model_tri_colliders()`、`parse_teleports()`、`parse_spawn_points()`、`parse_pvs_data()`、`export_glb_with_pakfile_models()`。
  - **运行时最小集只调用**：`metadata` / `export_brushes_planes` / `export_model_phy_colliders`（空则回退 `export_model_tri_colliders`）/ `parse_spawn_points` / `export_glb_with_pakfile_models`。
  - `parse_teleports` / `parse_pvs_data` 保留在 WASM API，但主线程导出流程不调用。
- **未导出** mosaic / 缺失纹理 / 默认纹理包等渲染画质切换能力（test 工程不需要）。

## 3. 关键语义

| 项 | 语义 |
|---|---|
| 模式A | 1ms 固定子步 + 实时输入；共享槽唯一写入者；渲染参数唯一来源 |
| 模式B | 独立 64t `tickPhys`；摩擦/加速/碰撞/bhop 钳制相位在 64t 网格上 |
| tick 输入 | 键位 = 边界当前掩码；鼠标 = 模式A 消耗窗口累积，按 tick 窗口限幅（`tickInputMax`） |
| 速度校准 | `set_velocity(tickPhys 三轴速度)`，唯一 tick 影响通道；位置/角度绝不触碰 |
| 分叉兜底 | 偏差 > 64 时全量拉回；正常演化不干预 |
| 去重 | `TICK_RATE=0` 或 ≥1000 时跳过模式B（纯 1ms） |
| 渲染驱动 | 主线程 rAF 帧信号（`RENDER_WAKEUP`），WorkerA 发布不 notify |

### 3.1 附注：±1000 钳制的三层语义对照

数值 1000 在输入链路中出现于三个不同层级，语义互不相同，引用时必须区分：

| 层级 | 常量 / 代码位置 | 作用 |
|---|---|---|
| 帧总量钳制 | `src/ts-shared/input/input-layer.ts:13`（`INPUT_CLAMP = 1000`） | game/debug 共用输入层：灵敏度乘入后对帧增量总量再钳制（喂物理前的最后一道） |
| 单事件削平 | 本工程 `src/main.ts:28`（`MOUSE_MAX_DELTA = 1000`），经 `clampMouseDelta`（`:32-35`）施加于每个 mousemove（`:302-303`）；同族：`game/src/input/mouse-buffer.ts:40`、`viewer/src/app.ts:39` | 单个 mousemove 事件的增量削平（保留方向），兜底驱动异常与浏览器事件合并 |
| tick 窗口限幅 | 本工程 `src/worker-a.ts:53`（`MAX_INPUT_DELTA = 1000`）+ `tickInputMax()`（`:55-57`），施加于 tick 边界（`:249-251`） | 模式B tick 边界一次性注入的整窗增量上限 = `1000/ms × tickDt`，防极端甩视角穿墙 |

> 注意：模式A 的 1ms 子步消费 `consumeInput()`（`worker-a.ts:285`）**不在上述任何一层**——
> 它缺省 `maxDelta=Infinity` 不限幅、直通完整帧增量。把 ±1000 安到这一步是常见误读
> （旧版文档即错在此，参见 cross-module 审查 E-1/S-2）。

## 4. 工程结构

```
test/dual-mode-harness/
├── README.md / CONCLUSION.md / Cargo.toml / package.json / index.html
├── crates/wasm/           # WASM 薄导出层
├── src/                   # 主线程 + 双 Worker + 共享状态
├── scripts/               # 构建/验证/基准脚本
└── docs/                  # 本解析文档
```

## 5. 已知边界

- ~~index.html HUD 标题仍为“单模 1ms 物理时序验证”~~ **已修复**：页面 `<title>` 与 HUD 标题均已改为双模描述（`index.html:6`、`:69`）。
- `scripts/dual-compare.mjs`（旧名 `tmp-dual-compare.mjs`，已更名）头注释仍按旧校准语义描述（“set_velocity(xz=粗糙/vy=模式A) + 位置/角度恢复模式A”），未随三轴校准重构更新；现行语义为三轴 `set_velocity(st.velX, st.velY, st.velZ)`、无位置恢复（`worker-a.ts:268-269`）。
- `tick_into` 是 wasm 导出的零分配 API（`src/phys/mod.rs:179`）；`writeStateRaw` 是 TS 侧 `TestShared` 的零分配写槽热路径方法（`src/shared-state.ts:469`），**并非 wasm API 能力**。WorkerA 当前实际热路径为 `phys.tick() → phys.state() → shared.writeState()`（内部走 `writeStateRaw`，见 `worker-a.ts:155-164`），未使用 `tick_into`。
- PVS 已从运行时移除（WASM API 仍保留 `parse_pvs_data` 供脚本/扩展）。
