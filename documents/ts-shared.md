# 共享层③：ts-shared（TS 物理渲染共享层）

> 定位：debug 与 game 两工程收敛出的**双端共享 TS 层**——跨线程输入/权威帧协议（SAB 或 postMessage）、
> Worker 权威物理循环、主线程渲染物理线与权威校准、地图加载管线、输入折算；
> 后续在三模式方案中演进为**三计算模式物理内核**（`coupled` / `decoupled` / `tick`：`auth/compute-mode.ts`、
> `auth/tick-authority.ts`、`tick/ordering-gate.ts`、`tick/tick-consumer.ts`、`decoupled/decoupled-loop.ts`）——
> **物理计算本体在本层**，三模式的**运行时装配与热切**在 `test/dual-mode-harness/`（`src/worker-a.ts` / `src/main.ts`）；
> `game/` 已回退到 `c4824e9`（仅耦合模式，不再注入任何模式钩子），debug 亦未注入。
> 纯 TypeScript，无框架依赖；各工程以**相对路径直接 import**（无 npm 依赖、无构建产物）。
> 本文所有论断均标注来源（`相对路径:行号`），写作基线为当前工作区代码。

---

## 1. 整体架构

### 1.1 文件地图（23 文件 = 19 源文件 + 4 单元测试；`src/ts-shared/`，`wc -l` 实测共 7102 行）

> 行数为 2026-09 批 4 落库后的 `wc -l` 实测（含 `\n` 计数）；旧表「14 源文件五域 / 5141 行」已过期，**旧值同时漏计了 4 个 `*.test.ts`**（本期口径改为全树计入并单列）。

**源文件（19，按域）**

| 文件 | 域 | 职责一句话 |
|---|---|---|
| `auth/shared-state.ts`(1033) | 通信 | 输入槽 + 权威帧双缓冲：`ShmState`（SAB 原子操作）与 `MsgState`（postMessage 回退）同接口双实现；双模式扩展解耦帧 S_D/V_D/WAKEUP 槽 + tick 模式元数据槽 I_A_SEG/I_A_TICK/I_A_EVT/I_A_PSEQ |
| `auth/compute-mode.ts`(128) | 通信（三模式） | `ComputeMode` 三值唯一权威定义 + `isAuthLineMode`/`isDecoupledLineMode` 双线门谓词 + `resolveAuthTickRate` 步长解析 + `MODE_HANDOVER_MATRIX` 六行交接矩阵 |
| `auth/auth-loop.ts`(483) | 通信 | Worker 侧权威帧计算循环：4ms 自驱 + 固定步长累积器 + 碰撞事件推导 + 三值模式门 + tick 模式 F4-C 支路 |
| `auth/tick-authority.ts`(618) | 通信（tick 模式） | F4-C tick 权威控制器：零分配权威推进 + scratch 乐观评估 + `publishMeta` 元数据发布 + 排序门接线 |
| `auth/worker-dispatch.ts`(484) | 通信 | Worker 消息分发（init/wasm-init/world-json/config/set-mode/set-hold/…）+ 工程特有钩子注入点 |
| `tick/ordering-gate.ts`(173) | 通信（tick 模式） | 发布排序门：δ≤T−ε_max 上限 + 双档等待（setTimeout/Atomics）+ 发布门/lead-miss；被 `auth/tick-authority.ts:53` 消费 |
| `tick/tick-consumer.ts`(455) | 通信（tick 模式） | 主线程 α 确定性网格弦插值消费器：六显示态 + Δ 事件驱动控制器 + 断窗八类（共享层落盘版，当前无 import 点；运行时副本为 `test/dual-mode-harness/src/renderer/tick-consumer.ts`） |
| `decoupled/decoupled-loop.ts`(449) | 物理（双模式扩展） | 解耦物理自驱循环：1ms 无限制真理源 + 64t tickPhys 速度校准 + 分叉锚定 + 背压（harness WorkerA 编排移植） |
| `input/input-layer.ts`(40) | 输入 | 灵敏度乘入 + Q/E 键位折算等效鼠标增量 |
| `input/mouse-buffer.ts`(128) | 输入（2026-09 上提共享） | 单事件绝对削平（CLAMP ±1000）+ discardNext（Pointer Lock 变化后丢首事件）；`process()` 为唯一活跃路径，`push/drain` 为遗留未用路径 |
| `input/pointer-lock.ts`(154) | 输入（2026-09 上提共享） | Pointer Lock 请求（`unadjustedMovement:true` 禁 OS 加速）+ 旧浏览器 void 降级 + 3s 超时 + 锁定变化/错误回调 |
| `phys/params.ts`(62) | 物理 | 前端配置 → Rust `set_params` snake_case 全量映射 |
| `phys/world-builder.ts`(248) | 物理 | 地图加载管线：`BspProcessor` 字节级导出 → `WorldBundle` |
| `phys/authority-calibrator.ts`(668) | 物理 | 渲染主线 vs 权威帧的校准四件套（只读权威）+ 解耦消费外推纯函数 |
| `phys/angles.ts`(38) | 物理（**D-08 批 4 新增**） | `wrapDeg` + `bspYawToCsYaw`（=`wrap(src+180)`）全 TS 侧单一份；语义归一口径取 viewer 版（带 `\|\| 0`，`-0` 归一为 `+0`） |
| `phys/constants.ts`(19) | 物理（**D-16 批 4 新增**） | 标定常量 `EYE_STAND = 64.09` TS 单点；与 Rust 权威 `src/phys/player.rs:34` 逐位相等，由 `check-shared-sync.mjs` 的 `eye-stand` 门禁保证 |
| `wasm/loader.ts`(72) | WASM（**D-09 批 4 新增**） | 字节获取三原语：`base64ToBytes`（**全仓唯一 `atob`**）+ `readEmbeddedWasmB64` + `fetchWasmBytes`；硬约束：不得 import 任何工程 `pkg/*`，`initSync` 留工程内 |
| `world/types.ts`(52) | 世界（**D-10 批 4 新增**） | PVS 三类型（`WasmPvsNode`/`WasmPvsLeaf`/`WasmPvsData`）共享定义；**不**含共享 `Vec3`（D-07 判保留） |
| `world/pvs-manager.ts`(271) | 世界（**D-10 批 4 新增**） | `PvsManager`：findLeaf + PVS 行 RLE 解码 + isVisible/getFaceCluster/getStats；解码走 `wasm/loader.ts`（D-09 是 D-10 前置） |

**单元测试（4，不计入「源文件五域」口径）**

| 文件 | 行数 | 覆盖 |
|---|---|---|
| `auth/compute-mode.test.ts` | 116 | 三值模式谓词与交接矩阵 |
| `auth/shared-state.protocol.test.ts` | 345 | tick 协议槽位（SAB 布局 + 发布/读取语义）；`EYE_STAND` 断言已改引共享单点（D-16） |
| `auth/tick-authority.test.ts` | 774 | F4-C 权威推进与元数据发布 |
| `tick/ordering-gate.test.ts` | 289 | 排序门双档等待与发布门 |

### 1.2 被引用关系（grep import 实测）

| 工程 | 使用面 | 证据 |
|---|---|---|
| debug | **9 模块**（auth×3、phys×3、input×3；**不含** compute-mode / tick-authority / decoupled-loop——worker 侧未注入任何模式钩子，缺省即纯耦合线），相对路径 `../../../src/ts-shared/...`（各处按目录深度） | 引用点 16：`apps/debug/src/app.ts:9,10,32-36`、`src/input/input-recorder.ts:45`、`src/input/keyboard.ts:18`、`src/physics/prediction-params.ts:13`、`src/renderer/renderer-main.ts:19,20`、`src/worker/main.ts:27,32-34` |
| game | **同为 9 模块同集**（与 debug 完全一致；`c4824e9` 回退后不再 import `decoupled/decoupled-loop.ts`） | 引用点 13：`apps/game/src/app.ts:18-22`、`src/config.ts:5`、`src/input/keyboard.ts:11`、`src/renderer/renderer-main.ts:20,21`、`src/worker/main.ts:21,26-28` |
| viewer | **3 个共享单点**（D-08/D-09/D-16 批 4 接入）：`phys/angles.ts`、`phys/constants.ts`、`wasm/loader.ts`；**其余七项仍正当隔离**（input/auth/tick/decoupled/phys-params/world-builder/pvs-manager，framework-decoupling §4.3） | `apps/viewer/src/core/pose.ts:9`（re-export angles）、`core/constants.ts:13`（re-export constants）、`core/bsp.ts:4`（import loader）——`grep -lE "from .*ts-shared" apps/viewer/src` 实测 3 文件 |
| test/dual-mode-harness | **6 模块**：auth 通道与三模式物理内核全走共享层（`shared-state`/`auth-loop`/`worker-dispatch`/`tick-authority`/`decoupled-loop`/`compute-mode`；`tick/ordering-gate.ts` 经 `auth/tick-authority.ts:53` 间接引入）；另自建 192B `TestShared` 渲染通道，与本文 512B 权威帧协议**不是同一套**（`src/shared-state.ts:2-4` 头注） | `test/dual-mode-harness/src/worker-a.ts:32-56`、`src/main.ts:17-19`、`src/shared-state.ts:51`、`src/renderer/tick-consumer.ts:46` |

编译期：debug/game 的 tsconfig `include` 均含 `../../src/ts-shared/**/*.ts`（`debug/tsconfig.json:26`、`game/tsconfig.json:15`）；**viewer 批 4 起也含**（`viewer/tsconfig.json:15`，因 §1.2 的 3 处真实 import —— 满足「当且仅当该工程 `src/` 内存在真实 `import ... from '...ts-shared/...'`」规则，t2 §3.4）；dual-mode-harness 也包含（`test/dual-mode-harness/tsconfig.json:23`），运行时 import 面见上表。

### 1.3 通信模型总览

```
主线程                                    Worker（权威物理）
─────────────────────────                ─────────────────────────
rAF 输入循环                                auth-loop（setTimeout 4ms 自驱，耦合线）
  └ addInput(dx,dy,mask) ──SAB 输入槽──▶     takeInput → phys.tick → writeAuthoritative
rAF 渲染物理线（耦合模式）                    └ SAB 权威帧双缓冲（V_A release 递增）
  └ readAuthoritative() ◀─(va-1)&1 槽──
  └ calibrateVelocity / correctFromAuthority
  └ predPhys.tick（预测推进）+ 事件消费

解耦模式（同 Worker 内第二自驱线，模式互斥；当前唯一装配方为 test/dual-mode-harness WorkerA，debug/game 均未注入）：
decoupled-loop（setTimeout 0 急轮询）          同 phys 实例 + 独立 tickPhys 实例
  └ consumeInput（CAS 不限幅）─SAB 输入槽──▶   phys.tick_into(1ms) 逐子步实时消耗
rAF 纯消费（主线程零物理 tick）                └ tickPhys.tick(64t) → phys.set_velocity 校准
  └ readDecoupled() ◀─S_D 双缓冲（V_D release）└ 分叉锚定 TICK_ANCHOR_DIST 拉回
  └ extrapolateAuthPose 一阶外推设相机          └ 背压 waitWakeup（rAF 每帧 wake()）
（crossOriginIsolated = false 时整链降级为 MsgState postMessage：'input' / 'phys-frame'，
 接口同构（解耦帧同载荷双喂，MsgState.recvFrame `:322-336`），见 `shared-state.ts:216-227` 头注与 MsgState 实现 `:228-407`）
```

SAB 前置条件：dev 服务器发出 COOP/COEP 头（`src/serve.py:33-34`：`Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy: require-corp`）使 `crossOriginIsolated = true`；工厂按 `SharedArrayBuffer` 是否为 null 选择实现（`shared-state.ts:746-757` `createMainSharedState`/`createWorkerSharedState`）。

---

## 2. 核心时序

### 2.1 权威帧双线时序（debug/game 同构，v7）

1. **输入路径**：主线程 rAF 输入循环（debug `app.ts:1710` `startInputLoop` / game `app.ts:326` 同名函数）→ `keysToMask` + wheelJump + Q/E 等效像素（`qeEquivalentDx`）→ `rendererMain.feedInput`。未锁定指针时 mask 强制 0（防 ESC 残留）。
2. **渲染物理线（主线程 rAF 六步，耦合模式）**：debug `renderer-main.ts:441-453`（tick 入口 `:430`）/ game `renderer-main.ts:700-734`（六步 `:704-710`，校准 wrapper `:626-645`）——① `shared.addInput` 写输入槽 → ② `correctFromAuthority()`（权威帧到达处理 + 大偏差兜底）→ ③ `calibrateVelocity(now)`（速度外推，不覆盖位置）→ ④ `predPhys.tick(dt, keys, dx, dy)`（完整物理推进）→ ⑤ 消费 phys-event → ⑥ 按 `predPhys.state()` 设相机（度→弧度）。解耦/tick 模式整体停跑该六步（该分支当前只在 harness 装配），改走 T7' 消费（§3.7 末、§3.8）。
3. **权威线（Worker）**：`auth-loop.ts` `setTimeout(loop, 4)` 自驱（`:319`）+ 累积器（`acc >= fixedDt && guard < 64`，`:345-350`）；每步 `stepPhysics`（`:199`）：`takeInput(maxStep)`（`:216`/`:239`）→ `phys.tick(dt, mask, dx, dy)` → `writeAuthoritative`（`:221`/`:271`）→ land/blocked 事件 postMessage（`emitCollision :164`，判据 `:288-314`）。模式门 `resolveAuthGateOpen`（`:135-140`；loop 内早退 `:323-327`）：解耦期间关断墙钟早退，复入不补跑。
4. **tick rate**：`fixedDt` 默认 1/64（`:145`），`setFixedDt(1/max(rate,1))` 动态覆盖（`:354-356`）——`config.physics.tickRate` 经 config 消息下发（game 耦合语义 = raw+3，`apps/game/src/worker/main.ts:29-32,86`；三模式步长解析单点在 `auth/compute-mode.ts:51-57` `resolveAuthTickRate`：tick=raw、coupled=+偏移）。

### 2.2 地图加载管线：`buildWorldBundle`（`phys/world-builder.ts:90` 起）

主线程 handleLoadBsp 内执行，`stage(label)` 逐步回调 `onProgress` 并 `yieldUi` 让出主线程（入口 `buildWorldBundle` `phys/world-builder.ts:90`）：

1. **metadata** → `WorldMetadata`（debug 扩展字段按需并入，`:110-123`）；
2. **出生点/传送点/PVS**：`parse_spawn_points` / `parse_teleports` / `parse_pvs_data`（`:125-128`）；
3. **碰撞体**：brush 走 `export_brushes_planes(brushFilterJson ?? DEFAULT_BRUSH_FILTER)`（`:131-133`）；模型碰撞按 `colliderSource` 三档（`:139-161`）——`visual` → `export_model_tri_colliders`；`phy` → `export_model_phy_colliders`；`auto` → phy 先行、空结果回退 tri；导出异常再回退 tri，仍失败则 `'[]'`；
4. **mosaic manifest / 缺失纹理**（`export_mosaic_manifest` / `export_missing_textures`，`:171-186`）——注释明确**必须先于 export_glb\*（消费 BSP）之前生成**；
5. **默认纹理包回退**：`__VBSP_TEXTURES_MTZ_B64__` 内嵌 base64（single 打包/file://）或 `fetch('./textures.mtz')`，经注入的 `decompressMtz` 还原（`:180-205`）；
6. **GLB**：`export_glb_with_pakfile_models_with_defaults(defaultsJson)`，失败回退无回退版 `export_glb_with_pakfile_models`（`:206-212`）；`glbBytes` 做 buffer slice 拷贝（`:213-216`）；
7. **spawn**：解析 primary + 全部 `spawn_points`，yaw 经 `bspYawToCsYaw` 转 cs-movement 系（`:218-238`）。

产物 `WorldBundle`（`:51-68`）：`brushJson/triJson/teleportJson/spawnJson/pvsJson/glbBytes/mosaicManifest?/missingTextures?/spawn/spawnList`。主线程将 brush/tri/teleport JSON 经 `{type:'world-json'}` 发 Worker → `PhysWorld::build_world`（见 [phys.md](./phys.md) §2.1）。

### 2.3 Worker 生命周期（`auth/worker-dispatch.ts`）

`createWorkerDispatch(env)` 按消息类型分发（`WorkerDispatchEnv` 声明 `:72-126`；onmessage 主分支 `:159` 起 if/else 链至 `:404`）：

| 消息 | 行为 |
|---|---|
| `init` | 存 shared 状态通道 + `env.onInit` 钩子（`:163-169`） |
| `input` | MsgState 回退路径的增量/键位注入（`:170-177`；SAB 模式无此消息） |
| `wasm-init` | `wasmB64`（atob→Uint8Array）或 `wasmUrl`（fetch）→ **必须 `initSync({module})`**（async init 会解构出 undefined 走错误路径，`:136-138` 注释）→ `env.onWasmInit`（debug 借此挂 mtz 内嵌）→ `authLoop.start()`（`initWasm :134-157`，分支 `:178-184`） |
| `world-json` | **三实例 build_world**（phys + 可选 tickPhys + 可选 scratch 同建同参 G3，重建前 `free?()` 释放旧实例）→ `syncParamsToWasm` → `authLoop.setFixedDt(getConfigTickRate)` + `reset` + `decoupledLoop.publishCurrentState` 首帧 + `onWorldRebuilt`（tick 标号归零）→ `env.onWorldBuilt(phys)`（`:185-221`） |
| `config` | W-GAP-1（**B2**）`normalizeConfigPatchKeys` snake→camel 键归一（定义 `:51-70`，调用 `:229-232`）→ `applyConfigPatch` → tickRate 模式感知（解耦 `onTickRateChanged` / 其余 `setFixedDt+reset`，`:239-246`）→ `set_hull`（**三实例同参**，player 归一 + t14/r1b-G1 additive 补行，`:247-265`）/ noclip（`:271-274`）→ `env.onConfigApplied`（`:222-277`） |
| `respawn` / `teleport` / `teleport-to-pos` / `set-spawn-points` / `set-death-threshold` | 直呼对应 PhysWorld 方法，**三实例同调**（phys + tickPhys + scratch，`:278-293,334-376`），并置 tick 模式外部断点（`env.tickExternalBreak`） |
| `sync-render-state` | 渲染主线反向同步权威：`set_state` + `resetInput`（丢弃同步前残留增量、保留按住键位，`shared-state.ts:368-374` `resetInput` 注释）；解耦模式 tickPhys 同注入防锚定拉走（`:295-333`） |
| `set-mode` | 三值热切握手入口：同 mode 幂等回 ack / 异 mode → `env.onSetMode(mode, state?)` → `mode-ack{mode, appliedAtMs}`（`:378-395`；非法 mode 直接忽略） |
| `set-hold` | 解耦模式 C 键冻结注入/解除（release 存点全量恢复语义），`:396-402` |

工程特有副作用全部经钩子注入（`WorkerDispatchEnv :72-126`）：工程通用 `onInit?/onWasmInit?/onWorldBuilt?/onConfigApplied?/onExtraMessage?`——共享层零工程分支（`:7-10` 头注）；**三模式扩展可选钩子**（`:90-115`）：`tickPhys?/scratch?/decoupledLoop?/getComputeMode?/onSetMode?/onSetHold?/tickExternalBreak?/onWorldRebuilt?` + 必填 `getConfigTickRate`——未注入时解耦/tick 面整体不激活（**debug 与 game 现状**，两者 Worker 只传通用钩子），全注入即三模式共存（**test/dual-mode-harness 现状**：`src/worker-a.ts:331-340`，见 §4.1）。

---

## 3. 具体实现

### 3.1 `auth/shared-state.ts` —— 512B SAB 协议

**布局常量**（`:114-195`）：`SHARED_BUFFER_SIZE = 512`——逐槽实测：耦合槽区用至 **288B**（B_A1=26 + 10 值 stride，止于字节 287）；S_D 扩展占用 **288-447**（160B 双缓冲）后实际用至 **448B**、余量 64B。源码头注 `:194`「实际使用至 416B」为 t9 前旧口径，与逐槽计算不符（t2/t3 勘误、t7 顺带校正）——已记入 [differences §6 残留表](./game/differences.md)。

| 区 | 偏移 | 类型 | 语义 |
|---|---|---|---|
| `I_V_A` | i32[0] | Int32 | 权威帧版本号（release 递增；0 = 未开始） |
| `I_KEYS` | i32[1] | Int32 | 当前键位掩码（无条件覆盖写，松手即清零，`:424-431`） |
| `I_A_GROUND` | i32[2] | Int32 | 着地标志（先于版本号可见；双模式互斥复用——耦合写权威帧/解耦写解耦帧） |
| `I_V_D` | i32[3] | Int32 | **解耦帧版本号**（双模式扩展 `:118-120`；协议同 V_A；0 = 未开始） |
| `I_WAKEUP` | i32[4] | Int32 | **背压唤醒电平**（`:120`；主线程 rAF `wake()` store(1)+notify / 解耦线 `waitWakeup` wait+CAS 复位） |
| `I_A_SEG` | i32[5] | Int32 | **段序号**（tick 模式扩展 `:128-131`；断窗帧 +1，消费端「seg 变化」即断窗判据） |
| `I_A_TICK` | i32[6] | Int32 | **tickIndex**（`:132-135`；仅真实 tick 递增，`publishCurrentState` 等非 tick 发布沿用；α 确定性网格时间基准） |
| `I_A_EVT` | i32[7] | Int32 | **事件位掩码**（`:136-140`；bit0-7 = 八类事件 `AUTH_EVT :153-162`，bit8 = OPT `AUTH_EVT_OPT :164-167`；逐帧量非粘滞量） |
| `I_A_PSEQ` | i32[8] | Int32 | **发布序守卫**（`:141-148`；seqlock：写者置奇→写 onGround+三元组→置偶，读者偶值快照 + 复检；占 i64[4] 视图前 4 字节——`i64[4..7]` 永久禁用作数据槽） |
| `B_DX_ACC` / `B_DY_ACC` | i64[8] / [9] | BigInt64 | 鼠标增量累加槽（**×1000 定点**，`Atomics.add`，`:424-431`） |
| `B_A0` / `B_A1` | i64[16..25] / [26..35] | BigInt64 | 权威帧双缓冲，每帧 10 值：pos×3（×100）、yaw/pitch（×1000）、vel×3（×100）、eyeHeight（×100）、timeMs（×1）（`:633-665`） |
| `B_D0` / `B_D1` | i64[36..45] / [46..55] | BigInt64 | **解耦帧双缓冲**（双模式扩展 `:190-192`；同款 10 值定点编码；V_D 协议同 V_A） |

**协议要点**：

- 写者（Worker）`writeAuthoritative`：写**空闲槽** `S_A[V_A&1]` → 置 A_GROUND → `store` 递增 V_A（release 语义，注释「状态先于版本号可见」，`:633-665`）；带 `meta` 时改走 seqlock 发布序（置奇 `:656-657` → 写 seg/tick/evt/ground `:658-661` → release V_A → 置偶 `:663`）；
- 读者（主线程）`readAuthoritative`：`va = load(V_A)`，读**写者已离开的槽** `(va-1)&1`——无撕裂；`va===0` 返回 null（ShmState `:437-463`、MsgState `:278-287`）；tick 消费器走零分配 `readAuthoritativeInto`（ShmState `:690-722`：PSEQ 偶值快照 + 复检 + V_A 代际复检；`0`=通道未开始、`−1`=读写冲突）；
- 消费者（耦合/tick 权威线）`takeInput(maxStep)`：`Atomics.exchange` 清空增量 + **maxStep 饱和截断**（防穿墙，`:471-483`）；
- 消费者（解耦线）`consumeInput`：**CAS 清零不限幅**（`exchangeZero :536-543`——1ms 真理源必须消费完整帧增量，两消费者并存各归各线，`:525-533`）；另有非消耗投影读 `peekInput(maxStep)`（tick 模式 scratch 用，`:508-521`）；
- `peekKeys`：非消耗读键位掩码（解耦 tickPhys 边界快照——64t 网格"当前状态"覆盖写语义，`:499-501`）；
- 解耦帧同构面：`writeDecoupled`（写空闲槽 → release V_D，onGround 复用 i32[2]，`:550-568`）/ `readDecoupled`（`(V_D-1)&1` 槽，V_D=0 返回 null，`:574-600`）；
- 背压：主线程 `wake()`（store(1)+notify，`:603-606`）/ 解耦线 `waitWakeup(timeoutMs)`（wait + CAS(1→0) 复位，超时不清电平防唤醒丢失，`:615-620`）；
- `resetInput`：只清增量不清键位（同步瞬间防旧输入注入；按住状态是实时的，`:490-493`，MsgState 等价实现 `:368-374`）。

**KEY_MASK 11 位**（`:67-79`，与 Rust `apply_input` 逐位一致）：forward 1 / backward 2 / left 4 / right 8 / jump 16 / duck 32 / sprint 64 / reset 128 / wheelJump 256 / yawLeft 512 / yawRight 1024。`keysToMask`/`maskToKeys`（`:81-112`）。注意 `sprint`（Shift）在 physics 模式映射 Rust `input.walk`（`KeyState.sprint` 字段注释，`:49-50`；Rust 0x40 = walk，`phys/mod.rs:553`）。

**MsgState 回退**（`:228-407`）：同 API 双实现——主线程 `addInput` → postMessage `'input'`（增量+键位，有序不丢，`:273-277`）；Worker 每 tick → postMessage `'phys-frame'`（权威帧+va，节流 `publishFloorMs = 4`，`:233`、`:375-394`）；主线程缓存最新帧供 `readAuthoritative` 返回。三模式扩展：`recvFrame` 同载荷双喂 latest/latestDecoupled（mode 内互斥运行，`:322-336`）；`readDecoupled`/`writeDecoupled`/`peekKeys`/`consumeInput` 消息态等价实现（`:311-315`、`:395-403`、`:354-358`、`:359-367`）；`wake` no-op（`:316-321`）/ `waitWakeup` 保持挂起语义（`:404-406`）。

### 3.2 `auth/auth-loop.ts` —— 权威循环

- `PhysWorldLike` 接口（`:32-66`）：`state/tick/build_world/set_params/set_hull/set_noclip/set_state/respawn/teleport_to_spawn/teleport_to/set_spawn_points/set_death_y` + `free?()`（多实例重建前置释放，P5）——Rust `PhysWorld` 21 个导出方法的 camelCase 子集，结构化满足（见 [phys.md](./phys.md) §4.2）。
- 模式门（`AuthLoopEnv :81-109`）：`resolveAuthGateOpen`（`:135-141`）三值化——显式 `modeGate?`（`:93`）优先，否则 `getComputeMode?`（`:98`）→ `isAuthLineMode`（coupled/tick 推进、decoupled 早退）；缺省恒真（v7 单线零变化）。门关时冻结墙钟早退（复入不补跑该窗口时间），`loop` 内 `:323-327`。
- 另两个可选钩子：`holdState?`（`:99-103`，tick 模式 C 键冻结快照）与 `tickF4?`（`:104-108`，F4-C 乐观窗；提供时 `stepPhysics` 走 tick 模式零分配支路 `:211-238`）；缺省 = 引擎本体逐行不动（耦合/解耦零回归）。
- 输入上限 `MAX_INPUT_PER_STEP_BASE = 1200`（`:126`）：`maxStep = 1200·dt·64`（`:210`）——单步最多消费的鼠标像素，配合 `takeInput` 饱和截断防大甩穿墙。
- 碰撞事件推导（`emitCollision :164-167`，postMessage `{type:'phys-event'}`；判据 `:288-314`）：
  - **land**：`onGround` 上升沿（权威真实落地点；渲染侧相位差可能差几 units）——主线程 `applyCollisionCorrection` 用全状态吸附；
  - **blocked**：撞墙/被阻——当前速度 >80 且 `prevSpeed − curSpeed > 250` 且实际位移 < 速度对应位移 ×0.3（`:299-314` 实现）。
- 循环保守性：单轮最多补 64 步（`guard < 64`，`:345-350`），防标签页挂起后追帧风暴。
- 公共 API（`:353-395`）：`setFixedDt`（`:354-356`）/`reset`（`:357-360`）/`start`（`:361-365`，幂等）/`publishCurrentState`（`:366-394`）——即时写权威帧不推进物理，供热切复入首帧（§2.1 注 3；三模式调用方为 harness，`test/dual-mode-harness/src/worker-a.ts:245,286,294`）。

### 3.3 `auth/worker-dispatch.ts` —— 分发与钩子

见 §2.3 表格。补充：wasm 初始化失败路径给出可读错误（initSync 的 undefined 解构问题，`:136-138`）；`onExtraMessage` 返回 true 表示消息已消费，供 debug 物理面板等扩展（`:124-125`）。各钩子的实际注入清单：debug `apps/debug/src/worker/main.ts:94-120`（通用钩子 + `getConfigTickRate`，**无模式钩子**）、game `apps/game/src/worker/main.ts:80-93`（通用钩子 + `getConfigTickRate`，**无模式钩子**）、harness `test/dual-mode-harness/src/worker-a.ts:331-340`（三模式全注入）；三模式装配差异见 §4.1。

### 3.4 `input/input-layer.ts` —— 输入折算

- `INPUT_CLAMP = 1000`（`:13`）：单帧鼠标增量钳制；
- `M_YAW = 0.022`（`:16`）：与 Rust `player.rs M_YAW` 一致；
- `layerMouseDelta(rawDx, rawDy, sensitivity)`（`:19-27`）：`dx = clamp(rawDx×sensitivity, ±1000)`——**真实灵敏度只在主线程乘入**；
- `qeEquivalentDx(yawBindSpeed, dtF)`（`:35-39`）：`(yawBindSpeed / M_YAW) × dtF` 钳 ±1000——Q/E 转向折算成等效鼠标像素（不乘灵敏度），与鼠标同通道进物理 → 双端角度天然一致（`phys/mod.rs:230-232` 同源注释）。

### 3.5 `phys/params.ts` —— 参数映射

`buildPhysicsParams(config)`（`:45` 起）把前端驼峰配置映射为 Rust `set_params` 的 snake_case JSON patch：`stop_speed`、`jump_height = jumpSpeed²/(2g)`（`params.ts:49`，能量守恒换算）、`run_speed`、`air_accelerate`、`noclip_speed`、`yaw_bind_speed`、`teleport_gate_ticks` 等；**`sensitivity` 恒固定 1**（`:58-60`）——理由见 §4.4。

**jump_height 值语义例外（跳跃回归修复，e0cbab6 后热修）**：worker-dispatch `normalizeConfigPatchKeys` 把该 patch 归一进 config 时，其余 10 键 snake↔camel 数值同构可纯改名，唯 `jump_height` 例外——它是 Rust 语义（起跳跳高 HU = v²/2g），而 `config.jumpSpeed` 存起跳速度 HU/s。纯改名会把「已换算跳高 57.0025」当速度存入，worker 再换算一次 `57.0025²/2g = 2.03` → Rust 脉冲 `√(2·800·2.03) = 57 < NON_JUMP_VELOCITY(180)`（`player.rs:49`）→ `categorize_position` 永不判空中、贴地回吸——解耦模式跳不起来（耦合主线 predPhys 走对象直传不受影响，故仅解耦复现）。修复 = 归一时值反演 `jumpSpeed = √(2·g·jump_height)`（g 取 patch.gravity，缺省 800）；node 单测 `temp/jump-fix.test.mjs` 验证全链恒等（worker jump_height 与主线程逐位一致、脉冲 302 > 180）。

### 3.6 `phys/world-builder.ts` —— 接口与数据契约

- `BspProcessorLike` 接口（`:19-31`，11 方法）：`new/metadata/parse_spawn_points/parse_teleports/parse_pvs_data/export_brushes_planes/export_model_tri_colliders/export_model_phy_colliders/export_mosaic_manifest/export_missing_textures/export_glb_with_pakfile_models(_with_defaults)`——各工程 cdylib 导出面的公共收敛（工程能力差异见 §4.1）。
- `DEFAULT_BRUSH_FILTER = {include_ladder:true, include_solid:true, min_brush_volume:0, skip_sky:true, skip_nodraw:false}`（`:83-90`）。
- `bspYawToCsYaw(bspYaw) = wrap(bspYaw + 180) = (((bspYaw + 180) % 360) + 360) % 360`（`:99-100`，t2 统一口径；旧式 (270 − yaw) 为 det=−1 镜像已废弃；与 Rust `teleport.rs:31-38` 公式同源）。
- `ColliderSource = 'auto' | 'visual' | 'phy'`（`:35` 附近）；默认 `'auto'`。

### 3.7 `phys/authority-calibrator.ts` —— 校准四件套 + 解耦外推

**原则**（`:1-17` 模块头注）：校准器**只读权威，绝不反写权威的物理演化**；常规兜底方向 = 「以渲染主线为准，反向同步权威」（发 `sync-render-state` 消息，Worker 侧 `set_state + resetInput`，`worker-dispatch.ts:295-333`）；唯一例外是「撤回兜底」——同步在途仍大幅分叉时改以权威为准回滚渲染（见下）。

| 成员 | 语义 | 证据 |
|---|---|---|
| `SYNC_COOLDOWN_MS = 250` | 两次兜底同步最小间隔（冷却期内不重复触发） | `:150`、`:282` |
| `TELEPORT_EXEMPT_MS = 200` | 传送/重生后豁免窗口（否则正常分叉判定会把已突变位置当 dist>500 强制回滚） | `:153`、`:185-212` |
| `correctFromAuthority()`（`:174`） | 每渲染帧，五段式：① 豁免期内只记录权威帧（供速度外推）+ 把渲染当前状态**反向同步**给权威（`:185-212`）；② 首次权威帧 `set_state` 全状态作渲染起点（`:229-236`）；③ 常规兜底三条件 OR——dist>500 强制 / dist>300 且 yawDiff≤3 且转动方向相同 / dist≤300 且 yawDiff>45——满足则 `onSyncRenderState` 反向同步（渲染为准，`:282-306`）；④ 同步在途（syncInFlight）再分叉（dist>500 或 yawDiff>45）→ **撤回兜底**：`phys.set_state` 以权威为准回滚渲染 + 清待喂输入（`:265-273`）；⑤ 收敛判定 dist<300 且 yawDiff≤45 结束在途（`:262-263`） | `:174-315` |
| `calibrateVelocity(now)`（`:344`） | 速度外推校准：`vel_target = vel_A + accel×(t − t_A)`（`computeAuthAccel :311` 差分权威帧速度，钳 ±20000，Δt∈[0.001,0.5]；外推 Δt≤0.1）；**只改速度不改位置/角度**——渲染主线位置不被权威覆盖 | `:344` 起 |
| `applyCollisionCorrection(ev)`（`:399`） | 碰撞事件微调（dist≥60 直接忽略，`:418`）：`land` = 全状态吸附权威 + onGround=true；`blocked` = 仅吸位置/角度、保留渲染速度（撞墙帧速度不一致是正常的） | `:399` 起 |
| `normalizeAngleDeg` | 角度归一到 (−180,180]，yawDiff 判定基础 | `:72` |
| `extrapolateAuthPose(frame, nowMs)`（`:110-121`，双模式新增） | **解耦消费外推纯函数**（T7'）：位置 = 权威帧位置 + 权威速度 × dt 一阶线性（无加速度项——加速度开关留评估），角度/眼高直读权威帧；dt 钳 `[0, EXTRAP_MAX_MS=250]`（`:101`，超限冻结在最后一帧——防权威线停滞幽灵漂移）。耦合模式 `calibrateVelocity` 算式同源（反向同步链在解耦期不运行：权威拉渲染单向，不回写权威）。**B1 落点**：calibrator 增量 +46 行（385→431 实测）即本函数 + `EXTRAP_MAX_MS` 常量——设计件 §3.5「外推算式冻结」条款；校准四件套本体语义零改 | `:101-121` |

### 3.8 `decoupled/decoupled-loop.ts` —— 解耦物理自驱循环（双模式扩展）

`createDecoupledLoop(env)`（`:145`）返回第二自驱循环；env：`shared/getPhys/getTickPhys/getTickPhysRate/isDecoupled/getWasmMemory/getHold`（`:84-101`）。**可选装配**——当前唯一注入方为 test/dual-mode-harness WorkerA（`test/dual-mode-harness/src/worker-a.ts:199-211,333`），**debug 与 game 均未注入**（解耦面整体休眠；game 侧注入随 `c4824e9` 回退移除）。

| 要素 | 语义 | 证据 |
|---|---|---|
| 调度 | `setTimeout(loop, active ? 0 : 4)`：解耦激活 0ms 急轮询；门关/未就绪 4ms 与 auth-loop 同节奏空转 | `:302-306` |
| 常量 | `RENDER_DT=0.001 / MAX_DELTA=0.05 / MAX_STEPS_PER_ROUND=8 / MAX_ACC=0.02 / MAX_INPUT_DELTA=1000 / WAIT_THRESHOLD_MS=1 / MAX_WAIT_MS=4 / TICK_ANCHOR_DIST=64 / SLOW_FIELD_REFRESH_MS=16` | `:117-139` |
| tickPhys 步长 | `config.physics.tickRate` **raw 原值**（无 +3 偏移——偏移仅耦合权威线语义）；`tickInputMax = 1000×(tickDt/0.001)` 窗口限幅 | `:141-143`；harness `worker-a.ts:205`（`getTickPhysRate = panelTickRate()`） |
| 激活边沿 | `modeBActive = tickRate>0 && 1/rate>1ms`；停用→激活清采样器 + `alignTickPhys`，激活→停用仅清采样 | `:331-344` |
| 单轮全序 | delta clamp（`:313-318`）→ hold 冻结轮（`:320-326`）→ tick 窗口（`peekKeys :355` + `tickDx/Dy clampAbs` → 分叉锚定 `tickDiverged :364-365` → `tickPhys.tick` → `phys.set_velocity :373`）→ 无限制步（`consumeInput :389` 不限幅 → `phys.tick_into(1ms) :396` → S_D 零分配发布 `:397-400` → acc 封顶 `:403`）→ 背压 `waitWakeup(min(idle,4ms)) :408-411` | `loop :298-412` |
| 分叉锚定 | 位置偏差 > `TICK_ANCHOR_DIST=64` → `alignTickPhys()` 全量拉回（正常演化不干预，先检查后推进） | `:191-202,364-365` |
| 零分配热路径（A5） | wasm 内存注入 → `phys.tick_into` + `state_out_ptr` Float64Array 直读（pos/vel/yaw/pitch 8 值）→ 定点写 S_D；内存增长后按 `memory.buffer` 重建视图缓存 | `:216-240`（`:225` 视图重建）；退化路径 `publishFromState :242-272`（node 测试） |
| 慢字段 | 眼高/着地不在 8 值内 → 16ms 低频 `phys.state()` 缓存刷新 + 发布帧即时刷新 | `:19-22,138,203-213` |
| hold 冻结 | `runHeldRound`：逐轮 `set_state(held, vel=0)` + 时间/输入丢弃 + tickPhys 同步冻结；松开 release = 多实例 set_state 全量恢复（worker 侧执行见 harness `src/worker-a.ts:301-323`） | `:274-295` |
| 对齐/复位 API | `alignTickPhys`（tickPhys←phys 全量 set_state，`:172-190`）/ `resetSamplers(align?)`（acc/loAcc/tickDx/tickDy 清零 + lastNow 刷新，`:421-429`）/ `onTickRateChanged`（清采样器+对齐，速率值变化不重置主累积器，`:415-419`）/ `publishCurrentState`（`:430-432`）/ `start`（`:434-439`，幂等） | `:414-440` |

**S_D 写入者唯一**：worker 侧解耦线是 S_D 槽唯一写入者——`writeDecoupled` 调用仅存在于 decoupled-loop（S_D 唯一写入侧，调用簇 `decoupled-loop.ts:229/:261/:286`，publishFromStateOut/publishFromState/runHeldRound 内），`:397-399` 为循环侧调用入口；主线程纯消费（§3.7 末行 + `test/dual-mode-harness/src/main.ts:125-126`「WorkerB 也持 auth 通道」）。热切交接时序见 harness [sequences.md](../test/dual-mode-harness/docs/sequences.md)。

---

## 4. 核心差异

### 4.1 debug vs game：差异收敛为 options 与钩子

两工程的 Worker/渲染物理线**逐行同构**（§2.1 六步、§2.3 消息表完全一致）；全部差异经由 `buildWorldBundle` 的 `options` 与 `worker-dispatch` 的钩子表达：

| 差异点 | debug | game | 证据 |
|---|---|---|---|
| `colliderSource` | UI 三档可选（auto/visual/phy） | 固定 `'auto'`（调用未传，走默认值；注释明示「colliderSource auto」收敛进共享管线） | debug `app.ts:1292-1293`；game `app.ts:406-408`、`world-builder.ts:146` 默认值 |
| `collectMissingTextures` | true（缺失比对弹窗） | 不开启（调用未传） | debug `app.ts:1294`；game `app.ts:406-408` |
| 进度回调 `onProgress` | `setStatus` | `advanceLoading`（两端都有，仅 UI 实现不同） | debug `app.ts:1296`；game `app.ts:408` |
| `onWasmInit` 钩子 | 挂 mtzB64——**协议兼容保留**（Worker 已不再解析 BSP，纹理包不再使用） | 不使用 | debug `worker/main.ts:109-110`（含原注释） |
| `onExtraMessage` 钩子 | 物理面板参数/快照消息 | 不使用 | `worker-dispatch.ts:133`（可选钩子声明）、`:483`（调用点）、debug `worker/physics-worker.ts` |
| **三模式装配** | 未注入（`tickPhys/scratch/decoupledLoop/getComputeMode/onSetMode/onSetHold/tickExternalBreak/onWorldRebuilt` 全缺省）→ 解耦/tick 面不激活，v7 行为零变化 | 同 debug：`apps/game/src/worker/main.ts:80-93` 只传通用钩子 + `getConfigTickRate`，**无任何模式钩子**（`c4824e9` 回退前曾全注入） | `worker-dispatch.ts:85-110`（可选钩子声明）、debug `worker/main.ts:94-120`、game `src/worker/main.ts:80-93`、harness `test/dual-mode-harness/src/worker-a.ts:331-340`（唯一全注入方） |

工程侧实现细节见 `documents/debug/`、`documents/game/`（另篇）；三模式运行时装配见 `test/dual-mode-harness/docs/`（另篇）。

### 4.2 viewer：接入 3 个共享单点，其余正当隔离

viewer 无物理、无双线程、无输入协议——**不**因「共享层有同名模块」而批量接入（framework-decoupling §4.2/§8.3 第 1 条）。批 4（D-08/D-09/D-16）起它接入**恰好 3 个跨工程契约单点**：`phys/angles.ts`（`bspYawToCsYaw`，经 `core/pose.ts:9` re-export）、`phys/constants.ts`（`EYE_STAND`，经 `core/constants.ts:13` re-export）、`wasm/loader.ts`（`core/bsp.ts:4` import）；`input/auth/tick/decoupled/phys-params/world-builder/pvs-manager` 七项**仍正当隔离**（§4.3 逐项理由）。录像回放的位姿换算与 BSP 出生点朝向因此与 debug/game **同源**（不再靠「同式各自维护」）；仍各自维护的只有 Rust 同式 `teleport.rs:31-38`（跨语言无法共享符号，E-06）。

### 4.3 dual-mode-harness：三模式内核走共享层，另建 192B 渲染通道

harness 自建 **192B TestShared SAB**（布局：控制区 `[0]TICK_RATE`/`[1]WAKEUP`、BigInt64 输入槽 dxAcc/dyAcc（i64 索引 1/2）、`[6]keysMask`、`[7]RENDER_WAKEUP`（WorkerB 专用唤醒，与 WAKEUP 分离）、`[8]V` + 双缓冲 Float64 槽0[5..12]/槽1[13..20]（pos×3/vel×3/yaw/pitch），共 192B，`test/dual-mode-harness/src/shared-state.ts:5-21` 布局注释），头注明确「与 ts-shared 512B 权威帧协议**不是**同一套」（`:2-4`）。

但**三模式物理不再走这条私有通道**：harness 另开 **auth 通道**（`ShmState`，512B，即本文协议，`src/main.ts:17-18,128-143`），三种模式的物理计算（auth-loop / decoupled-loop / tick-authority）全部经它消费输入、发布权威帧；192B 通道降为**渲染专用**——WorkerA 每次发布即镜像帧进 TestShared（`src/worker-a.ts:103-115`），WorkerB 渲染路径零改动（`src/worker-b.ts:737`）。因此 harness 对共享层的使用面 = **6 模块**（§1.2）+ `KEY_MASK` 位定义（`:51` import，注释「杜绝位定义漂移」），而非仅 KEY_MASK。两套协议的设计差异（双物理实例 + 双唤醒槽 vs 单权威 + V_A 版本号；CAS 消费输入 vs exchange 饱和截断）对照见 `test/dual-mode-harness/docs/`（另篇）。

移植关系（历史与现状）：`decoupled/decoupled-loop.ts` 由 harness 早年的 **WorkerA 编排**（模式A 1ms 无限制真理源 + 模式B 64t tickPhys 速度校准 + 分叉锚定 + 背压）平移而来（§3.8，全序对照 `decoupled-loop.ts:10-15` 头注）；该共享实现随后被 game 的解耦模式装配使用，**game 已整体回退**（`c4824e9`），当前服务对象回到 harness 自身（`src/worker-a.ts:199-211`）。**WorkerB/OffscreenCanvas 渲染始终是 harness 专属，从未进共享层**。`consumeInput`（CAS 不限幅）与耦合线 `takeInput`（exchange 饱和截断）在 ts-shared 内并存，harness 的三模式装配同时使用两者。

### 4.4 sensitivity=1 全链路设计（防双端视角分叉）

链路：真实灵敏度只在**主线程输入层**乘入（`input-layer.ts:25`）→ 传给物理的 dx 已含灵敏度 → Rust/预测实例收到的 `sensitivity` 恒为 1（`params.ts:58-60`）。因为权威（Worker 64Hz）与预测（渲染 144Hz）消费**同一份**已折算增量，角度演化天然一致；若两端各自再乘灵敏度，64Hz/144Hz 的取帧差会放大成可见视角分叉。Q/E 同理走 `qeEquivalentDx` 等效像素通道（§3.4），权威分叉残余由 `PhysWorld::set_yaw_pitch` 软校准兜底（[phys.md](./phys.md) §2.3）。
