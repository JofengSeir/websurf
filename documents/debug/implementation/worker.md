# implementation：worker

主题对应 `apps/debug/src/worker/**`，共四个模块：Worker 入口 `main.ts`、线程间消息类型面 `worker-types.ts`、物理面板协调器 `physics-worker.ts`、内嵌纹理包暂存槽 `mtz-data.ts`。

## 模块职责

**`apps/debug/src/worker/main.ts`（Worker 入口，无导出）**

把权威物理线接到四条链上（`apps/debug/src/worker/main.ts:2` 起）：

- 模块级槽与实例：Worker 侧 config 副本 `config`（`apps/debug/src/worker/main.ts:42`）、跨线程通道槽 `shared`（`:46`）、权威实例槽 `phys`（`:48`）、物理面板协调器 `physicsWorker`（`:51`）。
- `syncParamsToWasm`（`:62`）：把 config 里的物理参数映射成 `set_params` JSON 并写碰撞箱，`tickRate` 不在其中（它走 `onTickRateChange`）。
- 渲染轨迹采样：`rtTickGate`（`:180`）、`rtObserveLag`（`:188`）、`rtSample`（`:211`）、`rtInstantToTau`（`:259`）、`rtSampleAtTau`（`:290`），以及注入 `createAuthLoop` 的 `renderTrajectorySource`（`:308`）。
- 权威健康守护：`noteWorldSpawn`（`:350`）、`authYFloor`（`:356`）、`postHealth`（`:364`）、`healthProbe`（`:383`）；阈值常量在 `apps/debug/src/worker/main.ts:322` 起（地板余量、兜底地板、权威停滞、采样停滞、探测最小间隔）。
- 装配：`createAuthLoop`（`:455`）与 `createWorkerDispatch`（`:470`），并注入七个钩子（`onInit` 起，`:481`）。

**`apps/debug/src/worker/worker-types.ts`（类型面，无运行期代码）**

导出九个主线程 → Worker 消息接口、七个 Worker → 主线程接口、两个联合类型与两个数据接口：

- 联合：`WorkerMessage`（`apps/debug/src/worker/worker-types.ts:216`）、`MainMessage`（`:342`）。
- 主线程 → Worker：`WasmInitMessage`（`:33`）、`InitMessage`（`:41`）、`InputMessage`（`:65`）、`WorldJsonMessage`（`:80`）、`ConfigMessage`（`:96`）、`ResizeMessage`（`:110`）、`RespawnMessage`（`:117`）、`SetPhysicsParamMessage`（`:123`）、`ResetPhysicsParamMessage`（`:130`）、`SetHullMessage`（`:136`）、`ResetHullMessage`（`:142`）、`SetAutoRestoreHullMessage`（`:147`）、`SetCullDistanceMessage`（`:159`）、`TeleportMessage`（`:165`）、`TeleportToPosMessage`（`:171`）、`SetSpawnPointsMessage`（`:179`）、`SyncRenderStateMessage`（`:193`）、`SetDeathThresholdMessage`（`:209`）。
- Worker → 主线程：`ReadyMessage`（`:240`）、`PhysFrameMessage`（`:251`）、`PhysEventMessage`（`:281`）、`PhysicsSnapshotMessage`（`:299`）、`PhysicsEventMessage`（`:319`）、`ErrorMessage`（`:327`）、`HealthLogMessage`（`:335`）。
- 数据接口：`PlaneInfo`（`:358`）、`SceneDataMessage`（`:417`）、`KeyState`（`:466`）。

字段级清单见 `documents/debug/sequences.md` 的「消息与通道」一节。

**`apps/debug/src/worker/physics-worker.ts`**

导出 `PhysicsWorker`（`apps/debug/src/worker/physics-worker.ts:28`）：`params` getter（`:34`）、`attachWorld`（`:43`）、`reapplyParams`（`:53`）、`handleMessage`（`:63`）。私有 `emitPhysicsSnapshot`（`:109`）组装回传载荷。

**`apps/debug/src/worker/mtz-data.ts`**

导出 `setMtzB64`（`apps/debug/src/worker/mtz-data.ts:17`）与 `getMtzB64`（`:22`）。前者由 `onWasmInit` 钩子调用（`apps/debug/src/worker/main.ts:488`）。

## 关键流程与不变量

**权威循环的装配**：`createAuthLoop` 的取值器 `getPhys` 一次调用同时挂两个钩子——`rtTickGate`（唤醒边界探测与惰性读标记）与 `healthProbe`（自带节流），两者复用同一次取值调用、不新增定时器（`apps/debug/src/worker/main.ts:455`）。健康探测被 `HEALTH_PROBE_MIN_GAP_MS` 节流到 20Hz（`apps/debug/src/worker/main.ts:331`）。

**固定步长的单一写入路径**：面板 `tickRate` 变更经 `physicsWorker.params.onTickRateChange` → `authLoop.setFixedDt(rate)`；只有返回 `true`（步长真的变化）时才 `reset()`，避免每条 `config` 消息都清掉当前欠账（`apps/debug/src/worker/main.ts:466`）。

**世界重建后的参数重放顺序**：`world-json` 处理完 → `onWorldBuilt` 把协调器绑到新实例（`apps/debug/src/worker/main.ts:491`）→ `attach` 先按覆盖表组一次 `set_params` patch、再无条件 `set_hull`、最后补一次 tickRate 回调（`apps/debug/src/physics/physics-params.ts:75`）。config 应用之后再由 `onConfigApplied` → `reapplyParams` 重放一遍面板手动值，使面板值优先于配置默认值（`apps/debug/src/worker/main.ts:503`、`apps/debug/src/worker/physics-worker.ts:53`）。

**参数写入的两条通路互不重叠**：面板可调项经 `PARAM_TO_RUST` 映射成 11 个 Rust 键后写 `set_params`（`apps/debug/src/physics/physics-params.ts:31`）；全量 15 键由共享层 `buildPhysicsParams` 一次写全（`apps/debug/src/worker/main.ts:62`）。面板参数 `tickRate` 不写 Rust（`apps/debug/src/physics/physics-params.ts:24`）。

**权威健康守护的触发动作只有发消息**：告警复用既有 `health-log` 消息类型，触发时只发消息——不写权威实例、不写渲染（`apps/debug/src/worker/main.ts:319`）。

**不变量**：

- 权威实例由 `createAuthLoop` 独占推进；本文件其余部分只通过 `getPhys` 取值器读它（`apps/debug/src/worker/main.ts:456`）。
- `physicsWorker.params.onTickRateChange` 与 `authLoop.setFixedDt` 是一一对应的唯一通路（`apps/debug/src/worker/main.ts:466`）。
- `PhysicsParams.attach` 在 `phys` 为 `null` 时直接返回，不产生副作用（`apps/debug/src/physics/physics-params.ts:76`）。
- `emitPhysicsSnapshot` 只回传 `name` / `value` / `source` 三项，标签与取值范围留在主线程（`apps/debug/src/worker/physics-worker.ts:114`）。

## 已知缺口

1. **`physics-event` 消息无生产者**：`PhysicsEventMessage`（`apps/debug/src/worker/worker-types.ts:319`）在全仓只有类型声明与 `apps/debug/src/app.ts:412` 的消费分支，没有任何 `postMessage` 发送点。
2. **`resize` 消息无收发链路**：主线程窗口 `resize` 直接调 `RendererMain.resize`（`apps/debug/src/app.ts:1244`），Worker 侧也没有 `resize` 分支（`apps/debug/src/worker/worker-types.ts:105`）。
3. **`set-cull-distance` 消息被丢弃**：`InputBridge.sendSetCullDistance` 会发出该消息（`apps/debug/src/input/input-bridge.ts:91`），但分发层没有对应分支，落到 `onExtraMessage` 后 `PhysicsWorker.handleMessage` 也不认，返回 `false` 后被丢弃（`apps/debug/src/worker/worker-types.ts:155`、`apps/debug/src/worker/physics-worker.ts:95`）。剔除实际由主线程执行。
4. **`init` 的画布三项无读取点**：`width` / `height` / `dpr` 在 Worker 侧没有读取点（`apps/debug/src/worker/worker-types.ts:50`）。
5. **`InputMessage` 的六个运行期字段未声明**：`MsgState.addInput` 在运行时附带 `rt` / `rx` / `ry` / `rz` / `ri0` / `repoch`，接口只声明 `dx` / `dy` / `keys`（`apps/debug/src/worker/worker-types.ts:61`）。
6. **`sync-render-state` 的 `teleport` 字段未声明**：主线程实际发送时带上该布尔（`apps/debug/src/app.ts:348`），接口只声明 `state`（`apps/debug/src/worker/worker-types.ts:188`）。
7. **`mode-ack` 未声明且无消费分支**：分发层在 `set-mode` 分支会发出 `mode-ack`，`MainMessage` 未声明它，主线程分派也没有对应分支（`apps/debug/src/worker/worker-types.ts:340`）。
8. **`set-mode` / `set-hold` 不在联合类型内**：两条消息由共享层分发层处理（`apps/debug/src/worker/worker-types.ts:214`），本工程的类型面不覆盖它们。
9. **`mtzB64` 只存不用**：`getMtzB64`（`apps/debug/src/worker/mtz-data.ts:22`）在本仓内没有调用点，Worker 侧不消费纹理包（`apps/debug/src/worker/mtz-data.ts:10`）。
10. **`PhysicsWorker.handleMessage` 的返回值无人使用**：唯一调用点是分发层的 `onExtraMessage` 钩子（`apps/debug/src/worker/main.ts:507`），返回值被忽略（`apps/debug/src/worker/physics-worker.ts:60`）。
11. **`set-auto-restore-hull` 不写物理实例**：该开关只改面板侧标记并随 `physics-snapshot` 回传，`src/phys/**` 内没有对应参数与读取点（`apps/debug/src/worker/worker-types.ts:146`、`apps/debug/src/physics/physics-params.ts:61`）。
