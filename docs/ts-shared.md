# 共享层③：ts-shared（TS 物理渲染共享层）

> 定位：debug 与 game 两工程收敛出的**双端共享 TS 层**——跨线程输入/权威帧协议（SAB 或 postMessage）、
> Worker 权威物理循环、主线程渲染物理线与权威校准、地图加载管线、输入折算；
> phys-mode-port 后增加**解耦物理循环**（`decoupled/decoupled-loop.ts`，可选装配、仅 game 注入）。
> 纯 TypeScript，无框架依赖；各工程以**相对路径直接 import**（无 npm 依赖、无构建产物）。
> 本文所有论断均标注来源（`相对路径:行号`），写作基线为当前工作区代码。

---

## 1. 整体架构

### 1.1 文件地图（8 文件三域，`src/ts-shared/`，`wc -l` 实测共 2386 行）

| 文件 | 域 | 职责一句话 |
|---|---|---|
| `auth/shared-state.ts`(529) | 通信 | 输入槽 + 权威帧双缓冲：`ShmState`（SAB 原子操作）与 `MsgState`（postMessage 回退）同接口双实现；双模式扩展解耦帧 S_D/V_D/WAKEUP 槽 |
| `auth/auth-loop.ts`(270) | 通信 | Worker 侧权威帧计算循环：4ms 自驱 + 固定步长累积器 + 碰撞事件推导 + 模式门 |
| `auth/worker-dispatch.ts`(348) | 通信 | Worker 消息分发（init/wasm-init/world-json/config/set-mode/set-hold/…）+ 工程特有钩子注入点 |
| `decoupled/decoupled-loop.ts`(443) | 物理（双模式扩展，新） | 解耦物理自驱循环：1ms 无限制真理源 + 64t tickPhys 速度校准 + 分叉锚定 + 背压（harness WorkerA 编排移植） |
| `input/input-layer.ts`(40) | 输入 | 灵敏度乘入 + Q/E 键位折算等效鼠标增量 |
| `phys/params.ts`(64) | 物理 | 前端配置 → Rust `set_params` snake_case 全量映射 |
| `phys/world-builder.ts`(261) | 物理 | 地图加载管线：`BspProcessor` 字节级导出 → `WorldBundle` |
| `phys/authority-calibrator.ts`(431) | 物理 | 渲染主线 vs 权威帧的校准四件套（只读权威）+ 解耦消费外推纯函数 |

### 1.2 被引用关系（grep import 实测）

| 工程 | 使用面 | 证据 |
|---|---|---|
| debug | 7 模块（auth×3、phys×3、input×1；**不含** decoupled-loop——worker 侧未注入双模式钩子，可选缺省 = 解耦面整体不激活），相对路径 `../../src/ts-shared/...` | `debug/src/app.ts`、`debug/src/worker/main.ts`、`debug/src/renderer/renderer-main.ts` 等的 import 区 |
| game | 8 模块全用（debug 集合 + `decoupled/decoupled-loop.ts`，worker/main.ts:36-43 import） | `game/src/config.ts:5`（buildPhysicsParams）、`game/src/worker/main.ts:33-44`、`game/src/renderer/renderer-main.ts:20-21` 等 |
| viewer | **不 import**（无物理无双线程）；仅在本地复刻 `bspYawToCsYaw` 公式（wrap(src+180)，t2 统一口径）并注释引用 ts-shared | `viewer/src/core/pose.ts:16-25` |
| test/dual-mode-harness | **仅复用 `KEY_MASK`**（位定义与 Rust 一致）；其 SAB 是 192B 私有协议，与本文 512B 权威帧协议**不是同一套**（但其模式A/模式B 编排即 §3.8 的移植母本） | `test/dual-mode-harness/src/shared-state.ts:51`、`:1-4` 头注 |

编译期：debug/game 的 tsconfig `include` 均含 `../src/ts-shared/**/*.ts`（`debug/tsconfig.json:26`、`game/tsconfig.json:15`）；dual-mode-harness 也包含（`test/dual-mode-harness/tsconfig.json:23`），但运行时只 import KEY_MASK 一项。

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

解耦模式（phys-mode-port，同 Worker 内第二自驱线，模式互斥）：
decoupled-loop（setTimeout 0 急轮询）          同 phys 实例 + 独立 tickPhys 实例
  └ consumeInput（CAS 不限幅）─SAB 输入槽──▶   phys.tick_into(1ms) 逐子步实时消耗
rAF 纯消费（主线程零物理 tick）                └ tickPhys.tick(64t) → phys.set_velocity 校准
  └ readDecoupled() ◀─S_D 双缓冲（V_D release）└ 分叉锚定 TICK_ANCHOR_DIST 拉回
  └ extrapolateAuthPose 一阶外推设相机          └ 背压 waitWakeup（rAF 每帧 wake()）
（crossOriginIsolated = false 时整链降级为 MsgState postMessage：'input' / 'phys-frame'，
 接口同构（解耦帧同载荷双喂，MsgState.recvFrame :223-232），见 shared-state.ts:154-162 注释与 MsgState 实现）
```

SAB 前置条件：dev 服务器发出 COOP/COEP 头（`src/serve.py:33-34`：`Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy: require-corp`）使 `crossOriginIsolated = true`；工厂按 `SharedArrayBuffer` 是否为 null 选择实现（`shared-state.ts:519-529` `createMainSharedState`/`createWorkerSharedState`）。

---

## 2. 核心时序

### 2.1 权威帧双线时序（debug/game 同构，v7）

1. **输入路径**：主线程 rAF 输入循环（debug `app.ts:1710` `startInputLoop` / game `app.ts:370` 同名函数）→ `keysToMask` + wheelJump + Q/E 等效像素（`qeEquivalentDx`）→ `rendererMain.feedInput`。未锁定指针时 mask 强制 0（防 ESC 残留）。
2. **渲染物理线（主线程 rAF 六步，耦合模式）**：debug `renderer-main.ts:441-453`（tick 入口 `:430`）/ game `:947-978`（校准 wrapper `:838-843`）——① `shared.addInput` 写输入槽 → ② `correctFromAuthority()`（权威帧到达处理 + 大偏差兜底）→ ③ `calibrateVelocity(now)`（速度外推，不覆盖位置）→ ④ `predPhys.tick(dt, keys, dx, dy)`（完整物理推进）→ ⑤ 消费 phys-event → ⑥ 按 `predPhys.state()` 设相机（度→弧度）。解耦模式整体停跑该六步，改走 T7' 消费（§3.7 末、§3.8）。
3. **权威线（Worker）**：`auth-loop.ts` `setTimeout(loop, 4)` 自驱（`:203`）+ 累积器（`acc >= fixedDt && guard < 64`，`:217-225`）；每步 `stepPhysics`（`:123`）：`takeInput(maxStep)` → `phys.tick(dt, mask, dx, dy)` → `writeAuthoritative`（`:156`）→ land/blocked 事件 postMessage（`:171-200`）。模式门 `modeGate`（`:78,206-210`）：解耦期间关断墙钟早退，复入不补跑。
4. **tick rate**：`fixedDt` 默认 1/64（`:98`），`setFixedDt(1/max(rate,1))` 动态覆盖（`:229`）——`config.physics.tickRate` 经 config 消息下发（game 耦合语义 = raw+3，`game/src/worker/main.ts:49-53,222`）。

### 2.2 地图加载管线：`buildWorldBundle`（`phys/world-builder.ts:103` 起）

主线程 handleLoadBsp 内执行，`stage(label)` 逐步回调 `onProgress` 并 `yieldUi` 让出主线程（入口 `buildWorldBundle` `phys/world-builder.ts:103`）：

1. **metadata** → `WorldMetadata`（debug 扩展字段按需并入，`:110-123`）；
2. **出生点/传送点/PVS**：`parse_spawn_points` / `parse_teleports` / `parse_pvs_data`（`:125-128`）；
3. **碰撞体**：brush 走 `export_brushes_planes(brushFilterJson ?? DEFAULT_BRUSH_FILTER)`（`:131-133`）；模型碰撞按 `colliderSource` 三档（`:139-161`）——`visual` → `export_model_tri_colliders`；`phy` → `export_model_phy_colliders`；`auto` → phy 先行、空结果回退 tri；导出异常再回退 tri，仍失败则 `'[]'`；
4. **mosaic manifest / 缺失纹理**（`export_mosaic_manifest` / `export_missing_textures`，`:171-186`）——注释明确**必须先于 export_glb\*（消费 BSP）之前生成**；
5. **默认纹理包回退**：`__VBSP_TEXTURES_MTZ_B64__` 内嵌 base64（single 打包/file://）或 `fetch('./textures.mtz')`，经注入的 `decompressMtz` 还原（`:180-205`）；
6. **GLB**：`export_glb_with_pakfile_models_with_defaults(defaultsJson)`，失败回退无回退版 `export_glb_with_pakfile_models`（`:206-212`）；`glbBytes` 做 buffer slice 拷贝（`:213-216`）；
7. **spawn**：解析 primary + 全部 `spawn_points`，yaw 经 `bspYawToCsYaw` 转 cs-movement 系（`:218-238`）。

产物 `WorldBundle`（`:51-68`）：`brushJson/triJson/teleportJson/spawnJson/pvsJson/glbBytes/mosaicManifest?/missingTextures?/spawn/spawnList`。主线程将 brush/tri/teleport JSON 经 `{type:'world-json'}` 发 Worker → `PhysWorld::build_world`（见 [phys.md](./phys.md) §2.1）。

### 2.3 Worker 生命周期（`auth/worker-dispatch.ts`）

`createWorkerDispatch(env)` 按消息类型分发（`:97-128` 装配，onmessage 主分支 `:128` 起 if/else 链）：

| 消息 | 行为 |
|---|---|
| `init` | 存 shared 状态通道 + `env.onInit` 钩子（`:132-138`） |
| `wasm-init` | `wasmB64`（atob→Uint8Array）或 `wasmUrl`（fetch）→ **必须 `initSync({module})`**（async init 会解构出 undefined 走错误路径，`:105-107` 注释）→ `env.onWasmInit`（debug 借此挂 mtz 内嵌）→ `authLoop.start()`（`:147-153`） |
| `world-json` | **双实例 build_world**（phys + 可选 tickPhys 同建同参，重建前 `free?()` 释放旧实例）→ `syncParamsToWasm` → `authLoop.setFixedDt/getConfigTickRate` + `reset` + `decoupledLoop.publishCurrentState` 首帧 → `env.onWorldBuilt(phys)`（`:154-182`） |
| `config` | W-GAP-1（**B2**）`normalizeConfigPatchKeys` snake→camel 键归一（`:186-196`，单点修——终审①+⑤，11 参数权威侧首次生效）→ `applyConfigPatch` → tickRate 模式感知（耦合 `setFixedDt(+3)/reset` / 解耦 `onTickRateChanged`，`:197-207`）→ `set_hull`（**双实例同参**，player fast-path 在位 + t14/r1b-G1 additive 补行，`:208-226`）/ noclip → `env.onConfigApplied`（`:183-235`） |
| `respawn` / `teleport` / `teleport-to-pos` / `set-spawn-points` / `set-death-threshold` | 直呼对应 PhysWorld 方法，**双实例同调**（phys + tickPhys，`:236-250,287-323`） |
| `sync-render-state` | 渲染主线反向同步权威：`set_state` + `resetInput`（丢弃同步前残留增量、保留按住键位，`shared-state.ts:377-381` `resetInput` 注释）；解耦模式 tickPhys 同注入防锚定拉走（`:251-286`） |
| `set-mode` | 热切握手入口：同 mode 幂等回 ack / 异 mode → `env.onSetMode(mode, state?)` → `mode-ack{mode, appliedAtMs}`（`:325-337`） |
| `set-hold` | 解耦模式 C 键冻结注入/解除（release 存点全量恢复语义），`:338-344` |

工程特有副作用全部经钩子注入（`WorkerDispatchEnv :55-95`）：工程通用 `onInit?/onWasmInit?/onWorldBuilt?/onConfigApplied?/onExtraMessage?`——共享层零工程分支（`:7-8` 头注）；**双模式扩展可选钩子**（`:73-84`）：`tickPhys?/decoupledLoop?/getComputeMode?/onSetMode?/onSetHold?/getConfigTickRate?`——未注入时解耦面整体不激活（debug 现状），注入即双线共存（game 现状，见 §4.1）。

---

## 3. 具体实现

### 3.1 `auth/shared-state.ts` —— 512B SAB 协议

**布局常量**（`:109-130`）：`SHARED_BUFFER_SIZE = 512`——逐槽实测：耦合槽区用至 **288B**（B_A1=26 + 10 值 stride，止于字节 287）；S_D 扩展占用 **288-447**（160B 双缓冲）后实际用至 **448B**、余量 64B。源码头注 `:128`「实际使用至 416B」为 t9 前旧口径，与逐槽计算不符（t2/t3 勘误、t7 顺带校正）——已记入 [differences §6 残留表](../game/docs/differences.md)。

| 区 | 偏移 | 类型 | 语义 |
|---|---|---|---|
| `I_V_A` | i32[0] | Int32 | 权威帧版本号（release 递增；0 = 未开始） |
| `I_KEYS` | i32[1] | Int32 | 当前键位掩码（无条件覆盖写，松手即清零，`:311-317`） |
| `I_A_GROUND` | i32[2] | Int32 | 着地标志（先于版本号可见；双模式互斥复用——耦合写权威帧/解耦写解耦帧） |
| `I_V_D` | i32[3] | Int32 | **解耦帧版本号**（双模式扩展 `:114`；协议同 V_A；0 = 未开始） |
| `I_WAKEUP` | i32[4] | Int32 | **背压唤醒电平**（`:115`；主线程 rAF `wake()` store(1)+notify / 解耦线 `waitWakeup` wait+CAS 复位） |
| `B_DX_ACC` / `B_DY_ACC` | i64[8] / [9] | BigInt64 | 鼠标增量累加槽（**×1000 定点**，`Atomics.add`，`:311-317`） |
| `B_A0` / `B_A1` | i64[16..25] / [26..35] | BigInt64 | 权威帧双缓冲，每帧 10 值：pos×3（×100）、yaw/pitch（×1000）、vel×3（×100）、eyeHeight（×100）、timeMs（×1）（`:492-511`） |
| `B_D0` / `B_D1` | i64[36..45] / [46..55] | BigInt64 | **解耦帧双缓冲**（双模式扩展 `:126-127`；同款 10 值定点编码；V_D 协议同 V_A） |

**协议要点**：

- 写者（Worker）`writeAuthoritative`：写**空闲槽** `S_A[V_A&1]` → 置 A_GROUND → `store` 递增 V_A（release 语义，注释「状态先于版本号可见」，`:492-511`）；
- 读者（主线程）`readAuthoritative`：`va = load(V_A)`，读**写者已离开的槽** `(va-1)&1`——无撕裂；`va===0` 返回 null（`:324-357`）；
- 消费者（耦合权威线）`takeInput(maxStep)`：`Atomics.exchange` 清空增量 + **maxStep 饱和截断**（防穿墙，`:358-369`）；
- 消费者（解耦线）`consumeInput`：**CAS 清零不限幅**（`exchangeZero` `:403-410`——1ms 真理源必须消费完整帧增量，两消费者并存各归各线，`:392-401`）；
- `peekKeys`：非消耗读键位掩码（解耦 tickPhys 边界快照——64t 网格"当前状态"覆盖写语义，`:386-388`）；
- 解耦帧同构面：`writeDecoupled`（写空闲槽 → release V_D，onGround 复用 i32[2]，`:417-440`）/ `readDecoupled`（`(V_D-1)&1` 槽，V_D=0 返回 null，`:441-464`）；
- 背压：主线程 `wake()`（store(1)+notify，`:470-474`）/ 解耦线 `waitWakeup(timeoutMs)`（wait + CAS(1→0) 复位，超时不清电平防唤醒丢失，`:479-486`）；
- `resetInput`：只清增量不清键位（同步瞬间防旧输入注入；按住状态是实时的，`:377-381` 注释，实现 `:377-381`）。

**KEY_MASK 11 位**（`:62-74`，与 Rust `apply_input` 逐位一致）：forward 1 / backward 2 / left 4 / right 8 / jump 16 / duck 32 / sprint 64 / reset 128 / wheelJump 256 / yawLeft 512 / yawRight 1024。`keysToMask`/`maskToKeys`（`:76-108`）。注意 `sprint`（Shift）在 physics 模式映射 Rust `input.walk`（`KeyState.sprint` 字段注释，`:49-50`；Rust 0x40 = walk，`phys/mod.rs:553`）。

**MsgState 回退**（`:154-296`）：同 API 双实现——主线程 `addInput` → postMessage `'input'`（增量+键位，有序不丢）；Worker 每 tick → postMessage `'phys-frame'`（权威帧+va，节流 `publishFloorMs = 4`，`:168,282-284`）；主线程缓存最新帧供 `readAuthoritative` 返回。双模式扩展：`recvFrame` 同载荷双喂 latest/latestDecoupled（mode 内互斥运行，`:223-232`）；`readDecoupled`/`writeDecoupled`/`peekKeys`/`consumeInput` 消息态等价实现（`:213-216,250-257,282-289`）；`wake` no-op / `waitWakeup` 保持挂起语义（`:218-219,291`）。

### 3.2 `auth/auth-loop.ts` —— 权威循环

- `PhysWorldLike` 接口（`:19-53`）：`state/tick/build_world/set_params/set_hull/set_noclip/set_state/respawn/teleport_to_spawn/teleport_to/set_spawn_points/set_death_y` + `free?()`（双实例重建前置释放，P5）——Rust `PhysWorld` 21 个导出方法的 camelCase 子集，结构化满足（见 [phys.md](./phys.md) §4.2）。
- `AuthLoopEnv.modeGate?`（`:76-78`）：双线互斥门——缺省恒真；game 传 `() => computeMode === 'coupled'`，解耦期间冻结墙钟早退（复入不补跑该窗口时间），`loop` 内 `:206-210`。
- 输入上限 `MAX_INPUT_PER_STEP_BASE = 1200`（`:94`）：`maxStep = 1200·dt·64`（`:127`）——单步最多消费的鼠标像素，配合 `takeInput` 饱和截断防大甩穿墙。
- 碰撞事件推导（`:171-200`，postMessage `{type:'phys-event'}`）：
  - **land**：`onGround` 上升沿（权威真实落地点；渲染侧相位差可能差几 units）——主线程 `applyCollisionCorrection` 用全状态吸附；
  - **blocked**：撞墙/被阻——当前速度 >80 且 `prevSpeed − curSpeed > 250` 且实际位移 < 速度对应位移 ×0.3（`:161-164` 注释 + `:186-200` 实现）。
- 循环保守性：单轮最多补 64 步（`guard < 64`，`:221`），防标签页挂起后追帧风暴。
- 公共 API（`:228-268`）：`setFixedDt`（`:229`）/`reset`（`:232`）/`start`（`:236`，幂等）/`publishCurrentState`（`:241-268`）——即时写权威帧不推进物理，供热切复入首帧（§2.1 注 3、`game/src/worker/main.ts:172-177`）。

### 3.3 `auth/worker-dispatch.ts` —— 分发与钩子

见 §2.3 表格。补充：wasm 初始化失败路径给出可读错误（initSync 的 undefined 解构问题，`:105-107`）；`onExtraMessage` 返回 true 表示消息已消费，供 debug 物理面板等扩展（`:93-94`）。各钩子的两端实际注入清单属 debug/game 工程篇范围（`debug/src/worker/main.ts`、`game/src/worker/main.ts:210-232`，另篇；双模式装配差异见 §4.1）。

### 3.4 `input/input-layer.ts` —— 输入折算

- `INPUT_CLAMP = 1000`（`:13`）：单帧鼠标增量钳制；
- `M_YAW = 0.022`（`:16`）：与 Rust `player.rs M_YAW` 一致；
- `layerMouseDelta(rawDx, rawDy, sensitivity)`（`:19-27`）：`dx = clamp(rawDx×sensitivity, ±1000)`——**真实灵敏度只在主线程乘入**；
- `qeEquivalentDx(yawBindSpeed, dtF)`（`:35-39`）：`(yawBindSpeed / M_YAW) × dtF` 钳 ±1000——Q/E 转向折算成等效鼠标像素（不乘灵敏度），与鼠标同通道进物理 → 双端角度天然一致（`phys/mod.rs:230-232` 同源注释）。

### 3.5 `phys/params.ts` —— 参数映射

`buildPhysicsParams(config)`（`:45` 起）把前端驼峰配置映射为 Rust `set_params` 的 snake_case JSON patch：`stop_speed`、`jump_height = jumpSpeed²/(2g)`（`params.ts:49`，能量守恒换算）、`run_speed`、`air_accelerate`、`noclip_speed`、`yaw_bind_speed`、`teleport_gate_ticks` 等；**`sensitivity` 恒固定 1**（`:58-60`）——理由见 §4.4。

### 3.6 `phys/world-builder.ts` —— 接口与数据契约

- `BspProcessorLike` 接口（`:19-31`，11 方法）：`new/metadata/parse_spawn_points/parse_teleports/parse_pvs_data/export_brushes_planes/export_model_tri_colliders/export_model_phy_colliders/export_mosaic_manifest/export_missing_textures/export_glb_with_pakfile_models(_with_defaults)`——各工程 cdylib 导出面的公共收敛（工程能力差异见 §4.1）。
- `DEFAULT_BRUSH_FILTER = {include_ladder:true, include_solid:true, min_brush_volume:0, skip_sky:true, skip_nodraw:false}`（`:83-90`）。
- `bspYawToCsYaw(bspYaw) = wrap(bspYaw + 180) = (((bspYaw + 180) % 360) + 360) % 360`（`:99-100`，t2 统一口径；旧式 (270 − yaw) 为 det=−1 镜像已废弃；与 Rust `teleport.rs:31-38` 公式同源）。
- `ColliderSource = 'auto' | 'visual' | 'phy'`（`:35` 附近）；默认 `'auto'`。

### 3.7 `phys/authority-calibrator.ts` —— 校准四件套 + 解耦外推

**原则**（`:1-17` 模块头注）：校准器**只读权威，绝不反写权威的物理演化**；常规兜底方向 = 「以渲染主线为准，反向同步权威」（发 `sync-render-state` 消息，Worker 侧 `set_state + resetInput`，`worker-dispatch.ts:251-286`）；唯一例外是「撤回兜底」——同步在途仍大幅分叉时改以权威为准回滚渲染（见下）。

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

`createDecoupledLoop(env)`（`:144`）返回第二自驱循环；env：`shared/getPhys/getTickPhys/getTickPhysRate/isDecoupled/getWasmMemory/getHold`（`:83-99`）。**可选装配**——仅 game worker 注入（`game/src/worker/main.ts:127-140`），debug 未注入即解耦面整体休眠。

| 要素 | 语义 | 证据 |
|---|---|---|
| 调度 | `setTimeout(loop, active ? 0 : 4)`：解耦激活 0ms 急轮询；门关/未就绪 4ms 与 auth-loop 同节奏空转 | `:301-305` |
| 常量 | `RENDER_DT=0.001 / MAX_DELTA=0.05 / MAX_STEPS_PER_ROUND=8 / MAX_ACC=0.02 / MAX_INPUT_DELTA=1000 / WAIT_THRESHOLD_MS=1 / MAX_WAIT_MS=4 / TICK_ANCHOR_DIST=64 / SLOW_FIELD_REFRESH_MS=16` | `:116-137` |
| tickPhys 步长 | `config.physics.tickRate` **raw 原值**（无 +3 偏移——偏移仅耦合权威线语义）；`tickInputMax = 1000×(tickDt/0.001)` 窗口限幅 | `:139-142`；game `worker/main.ts:133-134` |
| 激活边沿 | `modeBActive = tickRate>0 && 1/rate>1ms`；停用→激活清采样器 + `alignTickPhys`，激活→停用仅清采样 | `:328-343` |
| 单轮全序 | delta clamp（`:313-317`）→ hold 冻结轮（`:320-325`）→ tick 窗口（`peekKeys :354` + `tickDx/Dy clampAbs :356-359` → 分叉锚定 `tickDiverged :363-365` → `tickPhys.tick :368` → `phys.set_velocity :372`）→ 无限制步（`consumeInput :388` 不限幅 → `phys.tick_into(1ms) :395` → S_D 零分配发布 `:396-399` → acc 封顶 `:402`）→ 背压 `waitWakeup(min(idle,4ms)) :405-410` | `loop :297-411` |
| 分叉锚定 | 位置偏差 > `TICK_ANCHOR_DIST=64` → `alignTickPhys()` 全量拉回（正常演化不干预，先检查后推进） | `:190-200,363-365` |
| 零分配热路径（A5） | wasm 内存注入 → `phys.tick_into` + `state_out_ptr` Float64Array 直读（pos/vel/yaw/pitch 8 值）→ 定点写 S_D；内存增长后按 `memory.buffer` 重建视图缓存 | `:215-238`（`:221-225` 视图重建）；退化路径 `publishFromState :241-269`（node 测试） |
| 慢字段 | 眼高/着地不在 8 值内 → 16ms 低频 `phys.state()` 缓存刷新 + 发布帧即时刷新 | `:19-22,137,203-213` |
| hold 冻结 | `runHeldRound`：逐轮 `set_state(held, vel=0)` + 时间/输入丢弃 + tickPhys 同步冻结；松开 release = 双实例 set_state 全量恢复（worker 侧执行见 `game/src/worker/main.ts:187-208`） | `:273-294` |
| 对齐/复位 API | `alignTickPhys`（tickPhys←phys 全量 set_state，`:171-187`）/ `resetSamplers(align?)`（acc/loAcc/tickDx/tickDy 清零 + lastNow 刷新，`:420-428`）/ `onTickRateChanged`（清采样器+对齐，速率值变化不重置主累积器，`:414-419`）/ `publishCurrentState`（`:429-432`）/ `start`（`:433-438`，幂等） | `:413-440` |

**S_D 写入者唯一**：worker 侧解耦线是 S_D 槽唯一写入者——`writeDecoupled` 调用仅存在于 decoupled-loop（S_D 唯一写入侧，调用簇 `decoupled-loop.ts:228/:260/:285`，publishFromStateOut/publishFromState 内），`:396-399` 为循环侧调用入口；主线程纯消费（§3.7 末行 + `game/src/renderer/renderer-main.ts:1027-1046`）。热切交接时序见 [game/docs/sequences.md](../game/docs/sequences.md) §8。

---

## 4. 核心差异

### 4.1 debug vs game：差异收敛为 options 与钩子

两工程的 Worker/渲染物理线**逐行同构**（§2.1 六步、§2.3 消息表完全一致）；全部差异经由 `buildWorldBundle` 的 `options` 与 `worker-dispatch` 的钩子表达：

| 差异点 | debug | game | 证据 |
|---|---|---|---|
| `colliderSource` | UI 三档可选（auto/visual/phy） | 固定 `'auto'`（调用未传，走默认值；注释明示「colliderSource auto」收敛进共享管线） | debug `app.ts:1293`；game `app.ts:450-454`、`world-builder.ts:139` 默认值 |
| `collectMissingTextures` | true（缺失比对弹窗） | 不开启（调用未传） | debug `app.ts:1294`；game `app.ts:450-454` |
| 进度回调 `onProgress` | `setStatus` | `advanceLoading`（两端都有，仅 UI 实现不同） | debug `app.ts:1296`；game `app.ts:452` |
| `onWasmInit` 钩子 | 挂 mtzB64——**协议兼容保留**（Worker 已不再解析 BSP，纹理包不再使用） | 不使用 | debug `worker/main.ts:109-110`（含原注释） |
| `onExtraMessage` 钩子 | 物理面板参数/快照消息 | 不使用 | `worker-dispatch.ts:93-94`、debug `worker/physics-worker.ts` |
| **双模式装配（phys-mode-port）** | 未注入（`tickPhys/decoupledLoop/getComputeMode/onSetMode/onSetHold` 全缺省）→ 解耦面不激活，v7 行为零变化 | 全注入：`tickPhys` 槽（双实例同建同参）+ `decoupledLoop` + `getComputeMode`（gate 真相源）+ `onSetMode/onSetHold`（热切/hold 执行）+ `getConfigTickRate`（耦合 +3 语义） | `worker-dispatch.ts:73-84`（可选钩子声明）、`game/src/worker/main.ts:127-140,210-232`、debug `worker/main.ts`（grep 无 getComputeMode/tickPhys） |

工程侧实现细节见 `debug/docs/`、`game/docs/`（另篇）。

### 4.2 viewer：不使用本层

viewer 无物理、无双线程、无输入协议——不 import ts-shared（§1.2）。唯一交集是 `bspYawToCsYaw` 公式的**本地复刻**（`viewer/src/core/pose.ts:16-25`，`wrap(src + 180)`，t2 统一口径；注释注明与 ts-shared 一致）：录像回放的位姿换算需要同一 yaw 约定。公式修改时须两处同步（Rust `teleport.rs:31-38` 亦同式，全量同步点见 architecture.md 不变量 3）。

### 4.3 dual-mode-harness：只复用 KEY_MASK，协议是另一套

harness 自建 **192B TestShared SAB**（布局：控制区 `[0]TICK_RATE`/`[1]WAKEUP`、BigInt64 输入槽 dxAcc/dyAcc（i64 索引 1/2）、`[6]keysMask`、`[7]RENDER_WAKEUP`（WorkerB 专用唤醒，与 WAKEUP 分离）、`[8]V` + 双缓冲 Float64 槽0[5..12]/槽1[13..20]（pos×3/vel×3/yaw/pitch），共 192B，`test/dual-mode-harness/src/shared-state.ts:5-21` 布局注释），头注明确「与 ts-shared 512B 权威帧协议**不是**同一套」（`:1-4`）。复用的唯一共享物是 `KEY_MASK` 位定义（`:50-51` import，注释「杜绝位定义漂移」）。两套协议的设计差异（双物理实例 + 双唤醒槽 vs 单权威 + V_A 版本号；CAS 消费输入 vs exchange 饱和截断）对照见 `test/dual-mode-harness/docs/`（另篇）。

phys-mode-port 移植关系：game 解耦模式把 harness **WorkerA 编排**（模式A 1ms 无限制真理源 + 模式B 64t tickPhys 速度校准 + 分叉锚定 + 背压）平移为本仓 `decoupled/decoupled-loop.ts`（§3.8，全序对照 `decoupled-loop.ts:10-15` 头注）；**WorkerB/OffscreenCanvas 渲染不移植**（game 渲染留在主线程，T7' 纯消费）。移植后 game 的 `consumeInput`（CAS 不限幅）与耦合线 `takeInput`（exchange 饱和截断）在 ts-shared 内并存，harness 的 CAS 语义以此落地。

### 4.4 sensitivity=1 全链路设计（防双端视角分叉）

链路：真实灵敏度只在**主线程输入层**乘入（`input-layer.ts:25`）→ 传给物理的 dx 已含灵敏度 → Rust/预测实例收到的 `sensitivity` 恒为 1（`params.ts:58-60`）。因为权威（Worker 64Hz）与预测（渲染 144Hz）消费**同一份**已折算增量，角度演化天然一致；若两端各自再乘灵敏度，64Hz/144Hz 的取帧差会放大成可见视角分叉。Q/E 同理走 `qeEquivalentDx` 等效像素通道（§3.4），权威分叉残余由 `PhysWorld::set_yaw_pitch` 软校准兜底（[phys.md](./phys.md) §2.3）。
