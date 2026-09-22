# implementation / worker（`apps/game/src/worker/**`）

## 模块职责

本目录两个文件：`main.ts` 是权威 Worker 的入口（模块内零导出），`worker-types.ts` 是消息协议的类型声明（21 个导出：19 个接口 + 2 个联合类型）。

`apps/game/src/worker/main.ts` 内部结构与职责：

| 部件 | 职责 | 锚点 |
|---|---|---|
| `config` | Worker 自己那份配置副本（`createConfig()`），面板下发经 `config` 消息部分更新 | `apps/game/src/worker/main.ts:77` |
| `shared` / `phys` 两个槽 | `init` 写 `shared`，`world-json` 写 `phys` | `apps/game/src/worker/main.ts:80`、`apps/game/src/worker/main.ts:82` |
| `syncParamsToWasm` | 把 Worker 的配置映射成 `set_params` / `set_hull` 并写进权威实例 | `apps/game/src/worker/main.ts:88` |
| 渲染轨迹采样源 | `rtTickGate` / `rtSample` / `rtInstantToTau` / `rtSampleAtTau` / `rtServeEpochOk` 与三个常量（陈旧读取数、偏移窗、陈旧门限） | `apps/game/src/worker/main.ts:127`、`:132`、`:185`、`:207`、`:255`、`:273`、`:284` |
| 权威健康护栏 | 四个阈值常量 + `noteWorldSpawn` / `authYFloor` / `postHealth` / `healthProbe` | `apps/game/src/worker/main.ts:320`、`:347`、`:354`、`:364`、`:381` |
| `authLoop` | 注入共享层的权威自驱循环（`getPhys` / `post` / `renderTrajectory` 三个注入面） | `apps/game/src/worker/main.ts:451` |
| `dispatch` | 注入共享层的消息分发器：通道、实例槽、tickRate 取值、配置回写、`initSync` 形态转换、诊断与健康钩子 | `apps/game/src/worker/main.ts:462` |
| `self.onmessage` | 先给 `world-json` 打两段 JSON 解析计时，再把事件交给 `dispatch` | `apps/game/src/worker/main.ts:506` |

`apps/game/src/worker/worker-types.ts` 的 21 个导出：`WasmInitMessage`（`:25`）、`InitMessage`（`:33`）、`LoadBspMessage`（`:43`）、`ConfigMessage`（`:51`）、`RespawnMessage`（`:58`）、`TeleportMessage`（`:63`）、`SetDeathThresholdMessage`（`:70`）、`WorkerMessage`（`:78`）、`ReadyMessage`（`:91`）、`BspMetadataMessage`（`:97`）、`SceneDataMessage`（`:110`）、`StatsMessage`（`:137`）、`ErrorMessage`（`:148`）、`HealthLogMessage`（`:155`）、`PlayerRespawnMessage`（`:162`）、`WorldJsonMessage`（`:171`）、`InputMessage`（`:182`）、`PhysFrameMessage`（`:193`）、`PhysEventMessage`（`:211`）、`MainMessage`（`:226`）、`KeyState`（`:243`）。

## 关键流程与不变量

- **权威实例是被推进的对象，不反写主线程**：`getPhys` 每个真实步长被调用一次，同时挂唤醒探测与健康探测（`apps/game/src/worker/main.ts:457`）；本文件不渲染、不直接改主线程状态。
- **`world-json` 建世界前必须先有 wasm**：分发器在 `!ready` 时丢弃该消息（`src/ts-shared/auth/worker-dispatch.ts:311`）；建实例后重放参数、同步步长、重放死亡阈值（`src/ts-shared/auth/worker-dispatch.ts:331`、`:332`、`:334`）。
- **零分配热路径**：渲染采样读路径复用同一个读缓冲与两个配对结构（`apps/game/src/worker/main.ts:138`、`:140`、`:141`），偏移估计用预分配滑窗（`apps/game/src/worker/main.ts:132`）。
- **采样只在真 tick 读一次**：唤醒边界由 `RT_WAKE_GAP_MS` 判定（`apps/game/src/worker/main.ts:159`），同一唤醒内的后续 tick 复用配对（`apps/game/src/worker/main.ts:211`）。
- **跨世代不插值**：服务前用 `readRenderEpoch` 复检配对世代（`apps/game/src/worker/main.ts:276`），失败即丢弃配对并让本 tick 返回 `null`，调用方回退权威自身位置（`apps/game/src/worker/main.ts:287`）。
- **健康护栏只上报**：`healthProbe` 三项检查（有限性/越界、权威发布停滞、渲染采样停滞）都不改权威状态、不 respawn、不碰渲染（`apps/game/src/worker/main.ts:402`、`:432`、`:445`）；越界告警条数上限 8 条（`apps/game/src/worker/main.ts:407`）。
- **`initSync` 的形态转换**：胶水的 `initSync` 接受 `{ module }` 包装形态，而分发器以裸 `ArrayBuffer` 调用，故本文件注入时转一次形态并做双重断言（`apps/game/src/worker/main.ts:476`、`src/ts-shared/auth/worker-dispatch.ts:249`）。
- **诊断计时在 Worker 内自洽**：`worldJsonRecvAt` 记录收到时刻（`apps/game/src/worker/main.ts:504`），`onWorldBuilt` 用它算出 Worker 内耗时并回发 `world-build-ms`（`apps/game/src/worker/main.ts:482`）；两段 `JSON.parse` 的耗时另发 `world-parse-ms`（`apps/game/src/worker/main.ts:518`）。

## 已知缺口

- **零分配支路已实现、在本工程无装配点**：`tick_into` / `state_out_ptr` / `seed_from` 的调用方只有共享层的两个控制器——`src/ts-shared/auth/tick-authority.ts`（`src/ts-shared/auth/tick-authority.ts:107`、`:108`、`:110`）与 `src/ts-shared/decoupled/decoupled-loop.ts`（`src/ts-shared/decoupled/decoupled-loop.ts:506`），而 `apps/**` 的 TypeScript 源码里对这两个模块的 import 为零（本次实测零匹配）。本工程的权威线走的是**返回对象**的 `tick`（`src/ts-shared/auth/auth-loop.ts:397` 的调用点、`src/ts-shared/auth/auth-loop.ts:85` 的接口声明），因此这三个方法不参与本工程的线上帧链；当前唯一驱动它们的是脚本 `apps/game/scripts/phys-seed-smoke.mjs`（`apps/game/scripts/phys-seed-smoke.mjs:320`、`:321`、`:147`）。
- **`WasmInitMessage` 未声明实际发送的两个字段**：类型只列 `type` 与 `wasmUrl`（`apps/game/src/worker/worker-types.ts:25`、`:27`），而分发器接受 `wasmB64` / `wasmUrl` / `mtzB64`（`src/ts-shared/auth/worker-dispatch.ts:297`），发送方在单文件产物下发的是 `wasmB64`（`apps/game/src/app.ts:152`）。`mtzB64` 在本工程内无发送方（`apps/game/src` 内零匹配）。
- **`InitMessage` 有三个字段既无发送方也无读取点**：`width` / `height` / `dpr`（`apps/game/src/worker/worker-types.ts:36`、`:37`、`:38`）；发送方只发 `type` 与 `shared`（`apps/game/src/app.ts:148`），分发器只读 `shared`（`src/ts-shared/auth/worker-dispatch.ts:270`）。
- **两个联合类型的成员集与实际收发不符**：`WorkerMessage` 未列入七条在用的消息、却列入了没有发送方的 `LoadBspMessage`（`apps/game/src/worker/worker-types.ts:78`、`apps/game/src/worker/worker-types.ts:43`）；`MainMessage` 未列入 `phys-frame` / `mode-ack` / `world-build-ms` / `world-parse-ms`，且把方向相反的 `WorldJsonMessage` 列入（`apps/game/src/worker/worker-types.ts:226`、`apps/game/src/worker/worker-types.ts:171`）。
- **`worker-types.ts` 里多条声明在本工程无发送方且无接收点**：`LoadBspMessage`（`:43`）、`ReadyMessage`（`:91`）、`BspMetadataMessage`（`:97`）、`StatsMessage`（`:137`）、`PlayerRespawnMessage`（`:162`）——它们只作形状记录，分发器按 `type` 字符串分派、不做运行时校验（`src/ts-shared/auth/worker-dispatch.ts:265`）。
- **`SceneDataMessage` 不是跨线程消息**：它是主线程内 `loadScene` 的形参类型（`apps/game/src/worker/worker-types.ts:110`、`apps/game/src/renderer/renderer-main.ts:315`），却声明在「Worker → 主线程」分组里。
- **`hud` 段的载荷会被并进 Worker 的 `config.hud`**：`config` 分支对非 `physics` / `input` 段原样透传（`src/ts-shared/auth/worker-dispatch.ts:346`、`:351`），而本工程对 `hud` 段下发的是全量物理参数（`apps/game/src/input/input-bridge.ts:65`）；Worker 侧没有任何 `config.hud` 读取点（`apps/game/src/worker/main.ts` 只读 `physics` 与 `input`），静态看无行为影响。
- **`getConfigTickRate` 直取配置字段**：`authLoop.setFixedDt` 的入参是 `config.physics.tickRate`（`apps/game/src/worker/main.ts:468`），未做任何偏移或钳制（折算与钳制见 `src/ts-shared/auth/auth-loop.ts:532` 的 `setFixedDt`）。
- **健康护栏的覆盖边界**：探测挂在权威自驱循环上（`apps/game/src/worker/main.ts:457`），自驱循环本身停摆时探测也停摆（`apps/game/src/worker/main.ts:378` 的口径），那种故障只能由主线程侧的帧流观测。
- **`world-parse-ms` 的两段解析是重复劳动**：本文件为诊断先 `JSON.parse` 一次两个大 JSON（`apps/game/src/worker/main.ts:513`、`:516`），随后 `build_world` 内部还会再解析一次；诊断开销与真实构建开销叠加在同一个 `world-json` 处理窗口里。
