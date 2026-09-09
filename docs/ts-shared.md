# 共享层③：ts-shared（TS 物理渲染共享层）

> 定位：debug 与 game 两工程收敛出的**双端共享 TS 层**——跨线程输入/权威帧协议（SAB 或 postMessage）、
> Worker 权威物理循环、主线程渲染物理线与权威校准、地图加载管线、输入折算。
> 纯 TypeScript，无框架依赖；各工程以**相对路径直接 import**（无 npm 依赖、无构建产物）。
> 本文所有论断均标注来源（`相对路径:行号`），写作基线为当前工作区代码。

---

## 1. 整体架构

### 1.1 文件地图（7 文件三域，`src/ts-shared/`）

| 文件 | 域 | 职责一句话 |
|---|---|---|
| `auth/shared-state.ts`(356) | 通信 | 输入槽 + 权威帧双缓冲：`ShmState`（SAB 原子操作）与 `MsgState`（postMessage 回退）同接口双实现 |
| `auth/auth-loop.ts`(226) | 通信 | Worker 侧权威帧计算循环：4ms 自驱 + 固定步长累积器 + 碰撞事件推导 |
| `auth/worker-dispatch.ts`(218) | 通信 | Worker 消息分发（init/wasm-init/world-json/config/…）+ 工程特有钩子注入点 |
| `input/input-layer.ts`(40) | 输入 | 灵敏度乘入 + Q/E 键位折算等效鼠标增量 |
| `phys/params.ts`(64) | 物理 | 前端配置 → Rust `set_params` snake_case 全量映射 |
| `phys/world-builder.ts`(254) | 物理 | 地图加载管线：`BspProcessor` 字节级导出 → `WorldBundle` |
| `phys/authority-calibrator.ts`(385) | 物理 | 渲染主线 vs 权威帧的校准四件套（只读权威） |

### 1.2 被引用关系（grep import 实测）

| 工程 | 使用面 | 证据 |
|---|---|---|
| debug | 全部 7 模块（auth×3、phys×3、input×1），相对路径 `../../src/ts-shared/...` | `debug/src/app.ts`、`debug/src/worker/main.ts`、`debug/src/renderer/renderer-main.ts` 等的 import 区 |
| game | 同 debug 的 7 模块集合 | `game/src/config.ts:5`（buildPhysicsParams）、`game/src/worker/main.ts`、`game/src/renderer/renderer-main.ts` 等 |
| viewer | **不 import**（无物理无双线程）；仅在本地复刻 `bspYawToCsYaw` 公式（wrap(src+180)，t2 统一口径）并注释引用 ts-shared | `viewer/src/core/pose.ts:16-25` |
| test/dual-mode-harness | **仅复用 `KEY_MASK`**（位定义与 Rust 一致）；其 SAB 是 192B 私有协议，与本文 512B 权威帧协议**不是同一套** | `test/dual-mode-harness/src/shared-state.ts:51`、`:1-4` 头注 |

编译期：debug/game 的 tsconfig `include` 均含 `../src/ts-shared/**/*.ts`（`debug/tsconfig.json:26`、`game/tsconfig.json:15`）；dual-mode-harness 也包含（`test/dual-mode-harness/tsconfig.json:23`），但运行时只 import KEY_MASK 一项。

### 1.3 通信模型总览

```
主线程                                    Worker（权威物理）
─────────────────────────                ─────────────────────────
rAF 输入循环                                auth-loop（setTimeout 4ms 自驱）
  └ addInput(dx,dy,mask) ──SAB 输入槽──▶     takeInput → phys.tick → writeAuthoritative
rAF 渲染物理线                                └ SAB 权威帧双缓冲（V_A release 递增）
  └ readAuthoritative() ◀─(va-1)&1 槽──
  └ calibrateVelocity / correctFromAuthority
  └ predPhys.tick（预测推进）+ 事件消费
（crossOriginIsolated = false 时整链降级为 MsgState postMessage：'input' / 'phys-frame'，
 接口同构，见 shared-state.ts:141-146 注释与 MsgState 实现）
```

SAB 前置条件：dev 服务器发出 COOP/COEP 头（`src/serve.py:32-34`：`Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy: require-corp`）使 `crossOriginIsolated = true`；工厂按 `SharedArrayBuffer` 是否为 null 选择实现（`shared-state.ts:346-356` `createMainSharedState`/`createWorkerSharedState`）。

---

## 2. 核心时序

### 2.1 权威帧双线时序（debug/game 同构，v7）

1. **输入路径**：主线程 rAF 输入循环（debug `app.ts:1710` `startInputLoop` / game `app.ts:326` 同名函数）→ `keysToMask` + wheelJump + Q/E 等效像素（`qeEquivalentDx`）→ `rendererMain.feedInput`。未锁定指针时 mask 强制 0（防 ESC 残留）。
2. **渲染物理线（主线程 rAF 六步）**：debug `renderer-main.ts:441-453`（tick 入口 `:430`）/ game `:704-711`（校准 wrapper `:626-632`）——① `shared.addInput` 写输入槽 → ② `correctFromAuthority()`（权威帧到达处理 + 大偏差兜底）→ ③ `calibrateVelocity(now)`（速度外推，不覆盖位置）→ ④ `predPhys.tick(dt, keys, dx, dy)`（完整物理推进）→ ⑤ 消费 phys-event → ⑥ 按 `predPhys.state()` 设相机（度→弧度）。
3. **权威线（Worker）**：`auth-loop.ts` `setTimeout(loop, 4)` 自驱（`:194`）+ 累积器（`acc >= fixedDt && guard < 64`，`:205-207`）；每步 `stepPhysics`（`:114`）：`takeInput(maxStep)` → `phys.tick(dt, mask, dx, dy)` → `writeAuthoritative`（`:147`）→ land/blocked 事件 postMessage（`:160-189`）。
4. **tick rate**：`fixedDt` 默认 1/64（`:89`），`setFixedDt(1/max(rate,1))` 动态覆盖（`:214`）——`config.physics.tickRate` 经 config 消息下发。

### 2.2 地图加载管线：`buildWorldBundle`（`phys/world-builder.ts:95` 起）

主线程 handleLoadBsp 内执行，`stage(label)` 逐步回调 `onProgress` 并 `yieldUi` 让出主线程（入口 `buildWorldBundle` `phys/world-builder.ts:96`）：

1. **metadata** → `WorldMetadata`（debug 扩展字段按需并入，`:110-123`）；
2. **出生点/传送点/PVS**：`parse_spawn_points` / `parse_teleports` / `parse_pvs_data`（`:125-128`）；
3. **碰撞体**：brush 走 `export_brushes_planes(brushFilterJson ?? DEFAULT_BRUSH_FILTER)`（`:131-133`）；模型碰撞按 `colliderSource` 三档（`:139-161`）——`visual` → `export_model_tri_colliders`；`phy` → `export_model_phy_colliders`；`auto` → phy 先行、空结果回退 tri；导出异常再回退 tri，仍失败则 `'[]'`；
4. **mosaic manifest / 缺失纹理**（`export_mosaic_manifest` / `export_missing_textures`，`:164-178`）——注释明确**必须先于 export_glb\*（消费 BSP）之前生成**；
5. **默认纹理包回退**：`__VBSP_TEXTURES_MTZ_B64__` 内嵌 base64（single 打包/file://）或 `fetch('./textures.mtz')`，经注入的 `decompressMtz` 还原（`:180-205`）；
6. **GLB**：`export_glb_with_pakfile_models_with_defaults(defaultsJson)`，失败回退无回退版 `export_glb_with_pakfile_models`（`:206-212`）；`glbBytes` 做 buffer slice 拷贝（`:213-216`）；
7. **spawn**：解析 primary + 全部 `spawn_points`，yaw 经 `bspYawToCsYaw` 转 cs-movement 系（`:218-238`）。

产物 `WorldBundle`（`:51-68`）：`brushJson/triJson/teleportJson/spawnJson/pvsJson/glbBytes/mosaicManifest?/missingTextures?/spawn/spawnList`。主线程将 brush/tri/teleport JSON 经 `{type:'world-json'}` 发 Worker → `PhysWorld::build_world`（见 [phys.md](./phys.md) §2.1）。

### 2.3 Worker 生命周期（`auth/worker-dispatch.ts`）

`createWorkerDispatch(env)` 按消息类型分发（`:75` 起 onmessage 主分支，if/else 链）：

| 消息 | 行为 |
|---|---|
| `init` | 存 shared 状态通道 + `env.onInit` 钩子 |
| `wasm-init` | `wasmB64`（atob→Uint8Array）或 `wasmUrl`（fetch）→ **必须 `initSync({module})`**（async init 会解构出 undefined 走错误路径，`:50-60` 注释）→ `env.onWasmInit`（debug 借此挂 mtz 内嵌）→ `authLoop.start()` |
| `world-json` | `phys.build_world(brushJson, triJson, teleportJson, x,y,z, yawDeg)` → `env.onWorldBuilt(phys)` |
| `config` | `set_params` / `set_hull` 等 → `env.onConfigApplied(section, patch)` |
| `respawn` / `teleport` / `teleport-to-pos` / `set-spawn-points` / `set-death-threshold` | 直呼对应 PhysWorld 方法 |
| `sync-render-state` | 渲染主线反向同步权威：`set_state` + `resetInput`（丢弃同步前残留增量、保留按住键位，`shared-state.ts:306-314` `resetInput` 注释） |

工程特有副作用全部经钩子注入（`:33-41`）：`onInit?/onWasmInit?({wasmB64,wasmUrl,mtzB64})/onWorldBuilt?(phys)/onConfigApplied?(section,patch)/onExtraMessage?(msg):boolean`——共享层零工程分支（`:7-8` 头注）。

---

## 3. 具体实现

### 3.1 `auth/shared-state.ts` —— 512B SAB 协议

**布局常量**（`:105-121`）：`SHARED_BUFFER_SIZE = 512`（实际使用至 416B）。

| 区 | 偏移 | 类型 | 语义 |
|---|---|---|---|
| `I_V_A` | i32[0] | Int32 | 权威帧版本号（release 递增；0 = 未开始） |
| `I_KEYS` | i32[1] | Int32 | 当前键位掩码（无条件覆盖写，松手即清零，`:245-251`） |
| `I_A_GROUND` | i32[2] | Int32 | 权威着地标志（先于版本号可见） |
| `B_DX_ACC` / `B_DY_ACC` | i64[8] / [9] | BigInt64 | 鼠标增量累加槽（**×1000 定点**，`Atomics.add`，`:245-251`） |
| `B_A0` / `B_A1` | i64[16..25] / [26..35] | BigInt64 | 权威帧双缓冲，每帧 10 值：pos×3（×100）、yaw/pitch（×1000）、vel×3（×100）、eyeHeight（×100）、timeMs（×1）（`:319-333`） |

**协议要点**：

- 写者（Worker）`writeAuthoritative`：写**空闲槽** `S_A[V_A&1]` → 置 A_GROUND → `store` 递增 V_A（release 语义，注释「状态先于版本号可见」，`:319-343`）；
- 读者（主线程）`readAuthoritative`：`va = load(V_A)`，读**写者已离开的槽** `(va-1)&1`——无撕裂；`va===0` 返回 null（`:258-284`）；
- 消费者 `takeInput(maxStep)`：`Atomics.exchange` 清空增量 + **maxStep 饱和截断**（防穿墙，`:292-304`）；
- `resetInput`：只清增量不清键位（同步瞬间防旧输入注入；按住状态是实时的，`:306-314` 注释，实现 `:311-314`）。

**KEY_MASK 11 位**（`:56-68`，与 Rust `apply_input` 逐位一致）：forward 1 / backward 2 / left 4 / right 8 / jump 16 / duck 32 / sprint 64 / reset 128 / wheelJump 256 / yawLeft 512 / yawRight 1024。`keysToMask`/`maskToKeys`（`:70-108`）。注意 `sprint`（Shift）在 physics 模式映射 Rust `input.walk`（`KeyState.sprint` 字段注释，`:42-43`；Rust 0x40 = walk，`phys/mod.rs:553`）。

**MsgState 回退**（`:141-234`）：同 API 双实现——主线程 `addInput` → postMessage `'input'`（增量+键位，有序不丢）；Worker 每 tick → postMessage `'phys-frame'`（权威帧+va）；主线程缓存最新帧供 `readAuthoritative` 返回。

### 3.2 `auth/auth-loop.ts` —— 权威循环

- `PhysWorldLike` 接口（`:19-50`）：`state/tick/build_world/set_params/set_hull/set_noclip/set_state/respawn/teleport_to_spawn/teleport_to/set_spawn_points/set_death_y`——Rust `PhysWorld` 21 个导出方法的 camelCase 子集，结构化满足（见 [phys.md](./phys.md) §4.2）。
- 输入上限 `MAX_INPUT_PER_STEP_BASE = 1200`（`:85`）：`maxStep = 1200·dt·64`（`:118`）——单步最多消费的鼠标像素，配合 `takeInput` 饱和截断防大甩穿墙。
- 碰撞事件推导（`:160-189`，postMessage `{type:'phys-event'}`）：
  - **land**：`onGround` 上升沿（权威真实落地点；渲染侧相位差可能差几 units）——主线程 `applyCollisionCorrection` 用全状态吸附；
  - **blocked**：撞墙/被阻——当前速度 >80 且 `prevSpeed − curSpeed > 250` 且实际位移 < 速度对应位移 ×0.3（`:161-164` 注释 + `:176-189` 实现）。
- 循环保守性：单轮最多补 64 步（`guard < 64`，`:205`），防标签页挂起后追帧风暴。

### 3.3 `auth/worker-dispatch.ts` —— 分发与钩子

见 §2.3 表格。补充：wasm 初始化失败路径给出可读错误（initSync 的 undefined 解构问题，`:50-60`）；`onExtraMessage` 返回 true 表示消息已消费，供 debug 物理面板等扩展（`:41`）。各钩子的两端实际注入清单属 debug/game 工程篇范围（`debug/src/worker/main.ts`、`game/src/worker/main.ts`，另篇）。

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

### 3.7 `phys/authority-calibrator.ts` —— 校准四件套

**原则**（`:1-56` 模块头注）：校准器**只读权威，绝不反写权威的物理演化**；常规兜底方向 = 「以渲染主线为准，反向同步权威」（发 `sync-render-state` 消息，Worker 侧 `set_state + resetInput`，`worker-dispatch.ts:156-179`）；唯一例外是「撤回兜底」——同步在途仍大幅分叉时改以权威为准回滚渲染（见下）。

| 成员 | 语义 | 证据 |
|---|---|---|
| `SYNC_COOLDOWN_MS = 250` | 两次兜底同步最小间隔（冷却期内不重复触发） | `:104`、`:236` |
| `TELEPORT_EXEMPT_MS = 200` | 传送/重生后豁免窗口（否则正常分叉判定会把已突变位置当 dist>500 强制回滚） | `:94-107` |
| `correctFromAuthority()`（`:128`） | 每渲染帧，五段式：① 豁免期内只记录权威帧（供速度外推）+ 把渲染当前状态**反向同步**给权威（`:139-168`）；② 首次权威帧 `set_state` 全状态作渲染起点（`:184-190`）；③ 常规兜底三条件 OR——dist>500 强制 / dist>300 且 yawDiff≤3 且转动方向相同 / dist≤300 且 yawDiff>45——满足则 `onSyncRenderState` 反向同步（渲染为准，`:238-258`）；④ 同步在途（syncInFlight）再分叉（dist>500 或 yawDiff>45）→ **撤回兜底**：`phys.set_state` 以权威为准回滚渲染 + 清待喂输入（`:219-231`）；⑤ 收敛判定 dist<300 且 yawDiff≤45 结束在途（`:216-218`） | `:128-258` |
| `calibrateVelocity(now)`（`:298`） | 速度外推校准：`vel_target = vel_A + accel×(t − t_A)`（`computeAuthAccel` 差分权威帧速度，钳 ±20000，Δt∈[0.001,0.5]；外推 Δt≤0.1）；**只改速度不改位置/角度**——渲染主线位置不被权威覆盖 | `:298` 起 |
| `applyCollisionCorrection(ev)`（`:353`） | 碰撞事件微调（dist≥60 直接忽略，`:372`）：`land` = 全状态吸附权威 + onGround=true；`blocked` = 仅吸位置/角度、保留渲染速度（撞墙帧速度不一致是正常的） | `:353` 起 |
| `normalizeAngleDeg` | 角度归一到 (−180,180]，yawDiff 判定基础 | `:72` |

---

## 4. 核心差异

### 4.1 debug vs game：差异收敛为 options 与钩子

两工程的 Worker/渲染物理线**逐行同构**（§2.1 六步、§2.3 消息表完全一致）；全部差异经由 `buildWorldBundle` 的 `options` 与 `worker-dispatch` 的钩子表达：

| 差异点 | debug | game | 证据 |
|---|---|---|---|
| `colliderSource` | UI 三档可选（auto/visual/phy） | 固定 `'auto'`（调用未传，走默认值；注释明示「colliderSource auto」收敛进共享管线） | debug `app.ts:1293`；game `app.ts:384`、`world-builder.ts:139` 默认值 |
| `collectMissingTextures` | true（缺失比对弹窗） | 不开启（调用未传） | debug `app.ts:1294`；game `app.ts:406-409` |
| 进度回调 `onProgress` | `setStatus` | `advanceLoading`（两端都有，仅 UI 实现不同） | debug `app.ts:1296`；game `app.ts:409` |
| `onWasmInit` 钩子 | 挂 mtzB64——**协议兼容保留**（Worker 已不再解析 BSP，纹理包不再使用） | 不使用 | debug `worker/main.ts:109-110`（含原注释） |
| `onExtraMessage` 钩子 | 物理面板参数/快照消息 | 不使用 | `worker-dispatch.ts:41`、debug `worker/physics-worker.ts` |

工程侧实现细节见 `debug/docs/`、`game/docs/`（另篇）。

### 4.2 viewer：不使用本层

viewer 无物理、无双线程、无输入协议——不 import ts-shared（§1.2）。唯一交集是 `bspYawToCsYaw` 公式的**本地复刻**（`viewer/src/core/pose.ts:16-25`，`wrap(src + 180)`，t2 统一口径；注释注明与 ts-shared 一致）：录像回放的位姿换算需要同一 yaw 约定。公式修改时须两处同步（Rust `teleport.rs:31-38` 亦同式，全量同步点见 architecture.md 不变量 3）。

### 4.3 dual-mode-harness：只复用 KEY_MASK，协议是另一套

harness 自建 **192B TestShared SAB**（布局：控制区 `[0]TICK_RATE`/`[1]WAKEUP`、BigInt64 输入槽 dxAcc/dyAcc（i64 索引 1/2）、`[6]keysMask`、`[7]RENDER_WAKEUP`（WorkerB 专用唤醒，与 WAKEUP 分离）、`[8]V` + 双缓冲 Float64 槽0[5..12]/槽1[13..20]（pos×3/vel×3/yaw/pitch），共 192B，`test/dual-mode-harness/src/shared-state.ts:5-21` 布局注释），头注明确「与 ts-shared 512B 权威帧协议**不是**同一套」（`:1-4`）。复用的唯一共享物是 `KEY_MASK` 位定义（`:50-51` import，注释「杜绝位定义漂移」）。两套协议的设计差异（双物理实例 + 双唤醒槽 vs 单权威 + V_A 版本号；CAS 消费输入 vs exchange 饱和截断）对照见 `test/dual-mode-harness/docs/`（另篇）。

### 4.4 sensitivity=1 全链路设计（防双端视角分叉）

链路：真实灵敏度只在**主线程输入层**乘入（`input-layer.ts:25`）→ 传给物理的 dx 已含灵敏度 → Rust/预测实例收到的 `sensitivity` 恒为 1（`params.ts:58-60`）。因为权威（Worker 64Hz）与预测（渲染 144Hz）消费**同一份**已折算增量，角度演化天然一致；若两端各自再乘灵敏度，64Hz/144Hz 的取帧差会放大成可见视角分叉。Q/E 同理走 `qeEquivalentDx` 等效像素通道（§3.4），权威分叉残余由 `PhysWorld::set_yaw_pitch` 软校准兜底（[phys.md](./phys.md) §2.3）。
