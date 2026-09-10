# TestShared 布局（渲染通道）与 WorkerB 渲染（实现篇 · 维度 I）

> **事实基准**：本文所有论断核对自当前工作区代码（核对日期 2026-09-11）。未注明前缀的相对路径均相对 `test/dual-mode-harness/`；仓库根共享层以 `仓库根 src/…` 标注。时序视角（唤醒/读写协议的时序语义）见 [../sequences.md](../sequences.md)；与 game 权威帧协议（512B）的取舍对比见 [../differences.md](../differences.md)。
>
> **⚠ 2026-09-11 三模式迁移（读前须知）**：本文描述的是 harness 的**渲染通道**（自建 192B）。
> **三模式物理不在这条通道上**——它走本工程**第二条 auth 通道**（512B，直接用共享层 `ShmState`，
> 含权威/解耦帧 + `I_A_SEG`/`I_A_TICK`/`I_A_EVT`/`I_A_PSEQ` 元数据三元组）。WorkerA 侧 `MirrorShmState`
> 在每次发布时把帧镜像进本文的 192B 渲染通道，使耦合/解耦模式的 WorkerB 渲染路径**零改动**
> （`src/worker-a.ts:122-150`）；tick 模式的 WorkerB 则直接经 `TickConsumer` 消费 auth 通道
> （`src/worker-b.ts:227-233,719-733`）。auth 通道与三模式协议见 [../../../docs/ts-shared.md](../../../docs/ts-shared.md)，
> 本工程总览见 [../overview.md](../overview.md) §2。

# 第一部分：TestShared —— 渲染通道 192B SAB 布局（src/shared-state.ts）

## 1. 布局总表

`TestShared` 是本 harness 专属的 192B 共享内存协议（`src/shared-state.ts:2-4`：「与 game ts-shared 权威帧协议**不是**同一套……本文件是双 Worker 时序 harness 专属的 192B 布局」）。

```
Int32 索引 / 字节偏移（src/shared-state.ts:6-21,65-110）
┌─ 控制区 ─────────────────────────────────────────────────────
│ [0]  字节 0..3    TICK_RATE     动态难度 64/128/256/1000（0=关）；仅 store 无 notify
│ [1]  字节 4..7    WAKEUP        物理背压唤醒（store 电平 1 + notify；WorkerA 专用槽）
├─ 输入槽 ─────────────────────────────────────────────────────
│ [2-3] 字节 8..15  dxAcc  BigInt64 索引 1（定点 ×1000；Atomics.add 累加 / CAS 清零消费）
│ [4-5] 字节 16..23 dyAcc  BigInt64 索引 2（同上）
│ [6]  字节 24..27  keysMask    当前键位掩码（store 覆盖写，松手即清零；0 也写）
│ [7]  字节 28..31  RENDER_WAKEUP 渲染帧信号（Atomics.add 计数 + notify；WorkerB 专用槽）
├─ 状态槽（双缓冲 S[2]）───────────────────────────────────────
│ [8]  字节 32..35  V             版本号（WorkerA add 递增 / WorkerB acquire 读）
│ 槽0  Float64 [5..12]  字节 40..103   pos×3 / vel×3 / yaw / pitch
│ 槽1  Float64 [13..20] 字节 104..167  pos×3 / vel×3 / yaw / pitch
└─ 168..192B 未用（SHARED_BUFFER_SIZE = 192，对齐取整）
```

槽内字段偏移：`F_POS_X..F_PITCH` = Float64 相对偏移 0..7（`:96-104`）；双槽基址 `F_SLOT_BASE=5`、步进 `F_SLOT_STRIDE=8`（`:93-95`）；定点缩放 `FIXED_SCALE=1000`（与 game ts-shared 一致，`:106-107`）。

## 2. 布局事故记录：dyAcc 与 V 的重叠（已修复）

`src/shared-state.ts:72-75` 逐字记录了这起事故：dxAcc/dyAcc 曾误用 BigInt64 索引 2/4（= 字节 16..23 / 32..39），其中索引 2 的 dyAcc 与 V（Int32 索引 8，字节 32..35）**重叠**——主线程 `addInput(dy≠0)` 污染 V、`writeState` 的 V++ 破坏 dyAcc，表现为**屏闪**。现布局 dyAcc = BigInt64 索引 2（字节 16..23），dxAcc = 索引 1（字节 8..15），与 V（Int32 8）不再相交。回归断言固化在 `scripts/phys-smoke.mjs`（断言 #10「writeState 后 addInput(dy≠0)：V 保持 1」、#11「dy 消费后 readState 数据一致」）与 `scripts/flicker-debug.mjs`（双缓冲协议压力测试）。

## 3. 键位掩码：复用仓库根 ts-shared

`src/shared-state.ts:49-52`：`KEY_MASK` 从 `仓库根 src/ts-shared/auth/shared-state.js` 导入（唯一直接 import），注释明示「位定义唯一来源……与 Rust apply_input 一致……杜绝位定义漂移」。ts-shared 定义 11 位（forward 1 / backward 2 / left 4 / right 8 / jump 16 / duck 32 / sprint 64 / reset 128 / wheelJump 256 / yawLeft 512 / yawRight 1024，仓库根 `src/ts-shared/auth/shared-state.ts:56-68`）；本 harness `keysToMask` 只组装前 5 键（WASD/空格，`src/shared-state.ts:55-63`；R 重生走独立 postMessage 消息而非掩码位，`src/main.ts:315-317`）。

## 4. 核心方法（src/shared-state.ts:266-556）

| 方法 | 行号 | 语义 |
|---|---|---|
| `writeTickRate` / `readTickRate` | `:273-288` | 阶段0 仅 store（无 notify——唤醒职责在 WAKEUP 槽，WorkerA 每轮循环自动识别）；msg 模式经 `shared-tick-rate` 消息 |
| `peekKeys` | `:290-297` | 非消耗读当前键位掩码（模式B tick 边界采样专用；键位是「当前状态」覆盖写，读边界时刻当前值 = 真实 64t 服务器语义） |
| `wake` | `:305-313` | `store(WAKEUP,1)+notify` + `add(RENDER_WAKEUP,+1)+notify`（双槽分离，一次通知两槽）；msg 模式无操作 |
| `waitWakeup` | `:323-331` | `Atomics.wait(WAKEUP,0,timeout)`；返回后 CAS(1→0) 消费复位；`timed-out` 跳过复位（超时窗口内新唤醒保留给下一轮，避免丢失） |
| `waitRenderWakeup` | `:344-358` | 快路径比对未消费计数；`wait(RENDER_WAKEUP, lastRenderWake, timeout)` 挂起在**帧信号槽**；醒来消费差值 |
| `absorbRenderWake` | `:366-369` | 渲染完成后合并丢弃渲染期间新到计数——渲染频率严格 ≤ 刷新率（不吸收会忙循环，重复释放性能上限） |
| `addInput` | `:374-387` | dx/dy ×1000 定点 BigInt64 原子累加（0 不加）；keysMask 无条件 store 覆盖（0 也写=松手清零）；msg 模式每 rAF 投递 `shared-input` 批次（含 keysMask=0） |
| `onInputMessage` / `onTickRateMessage` | `:393-402` | msg-physics 本地累加/覆盖（与 SAB 语义一致） |
| `consumeInput(maxDelta?)` | `:411-449` | WorkerA 每子步调用；SAB：`exchangeZero`（load→compareExchange(0) 自旋，原子读出并清零）+ 可选限幅（缺省 Infinity 不限幅——主线程已按事件 CLAMP，这里必须消费完整帧增量防快速甩动截断，`:404-410`）；msg：直接读清本地累加 |
| `writeState` → `writeStateRaw` | `:458-509` | `writeState(Vec3…)` 委托 `writeStateRaw`（`:459`）；写**空闲槽** `S[(V0&1)^1]`（不覆盖 WorkerB 正在读的槽）→ `Atomics.add(V,1)`；msg 模式：本地 V++ → 直连端口投递 `shared-state`（结构化克隆载荷） |
| `readState` | `:518-547` | acquire 读 V，与 lastV 相同返回 null（非阻塞，重绘判定「仅状态更新时重绘」）；不同则读当前槽 `S[V&1]` 全字段 → 重读 V **double-check**（撕裂则以新版本重读，最多 2 次） |
| `onStateMessage` | `:553-555` | msg-render 缓存最近状态（本地副本唯一来源，与 SAB readState「只被物理发布更新」语义一致） |

## 5. 消息回退模式（无 SAB 环境）

四种模式（`:163-165`）：`'sab'`（共享内存）/ `'msg-main'`（主线程）/ `'msg-physics'`（WorkerA）/ `'msg-render'`（WorkerB）。工厂：`init`（`:221-223`）/ `create`（SAB + postMessage 共享给 WorkerA，SAB **不可放 transfer list**，`:237-242`）/ `createMessaging`（`:250-252`）/ `initMessaging`（`:258-260`）/ `initMessagingRender`（`:263-265`）。

消息载荷类型（`:140-161`）：`SharedInputMsg`（每 rAF 一批）/ `SharedStateMsg`（直连 MessageChannel 发布）/ `SharedTickRateMsg`——字段与 SAB 槽语义一一对应。语义等价性声明：V 版本/仅状态更新重绘/输入限幅/难度识别全部保留，仅传输介质不同（`:46`）。

msg-* 模式下 SAB 视图为长度 0 的空视图（无实际缓冲，`:173,211-214`），方法按 mode 分支不触碰视图；`isMessageMode`（`:233-235`）供循环自节流判定（WorkerB 无数据时 100ms 低频自检，`src/worker-b.ts:616-617,655-658`）。

---

# 第二部分：WorkerB —— OffscreenCanvas + three.js 渲染（src/worker-b.ts）

## 6. 渲染常量（src/worker-b.ts:95-143）

| 常量 | 值 | 依据（代码注释 + 参数） |
|---|---|---|
| `fov` | 73.6（固定，无面板） | 最小集定值（`:102-103`） |
| `CAMERA_NEAR` / `CAMERA_FAR` | 0.5 / 12288 | 视距优化：far 20000→8192→12288（surf_666 世界 ~16320，扩大视锥后旁边/远处不空白）；far 过大 → 深度精度差 + 单 mesh 大几何使视锥剔除失效（`:95-101,104-105`） |
| `PIXEL_RATIO_MAX` | 1 | 高 dpr 屏像素 4 倍是卡顿主因；OffscreenCanvas 无 devicePixelRatio，固定 1 性能优先（`:106,210-212`） |
| `EYE_STAND` | 64.09 | 固定站立眼高（状态槽无 eyeHeight，不处理蹲伏；与 game EYE_STAND 一致）（`:108-109`） |
| `BG_COLOR` | 0x0d1b2a | 背景/雾色（`:110-111`） |
| 雾 | `Fog(BG, far×0.4, far×0.9)` | 远处细节淡化，LOD_DIST 9200 恰在雾深处——隐藏块已融入背景（`:222-224`） |
| `LOD_DIST` | far×0.75 ≈ 9200 | 距离 LOD 阈值（单档可见/隐藏；比例沿用 game cullDistance/far=0.64 同数量级惯例）（`:113-121`） |
| `OPT_TARGET_CELLS` / `OPT_MIN` / `OPT_MAX` | 512 / 300 / 800 | 分块合并目标块数区间（`:129-133`） |
| `OPT_CELL_MIN` / `OPT_CELL_MAX` | 128 / 4096 | cell 尺寸钳制（surf_666 世界 ~16320 → cell ≈ 512~1024 数量级）（`:134-136`） |
| `FRUSTUM_PAD` | 1.6 | 包围球膨胀系数——视锥外约 0.6×半径 的块仍渲染（疯狂晃动时新入视锥的几何上一帧已预渲染，边缘不空白；只影响 renderer 剔除，LOD 不受影响）（`:137-143,510-520`） |
| `RENDER_TIMEOUT_MS` | 50 | 帧循环超时兜底：主线程 rAF 停摆（隐藏标签页/卡顿）时自驱，渲染不冻结（`:608-614`） |
| `MSG_IDLE_INTERVAL_MS` | 100 | 消息回退模式无数据时低频自检（防 2-10kHz 消息自旋空转）（`:615-617`） |

## 7. 初始化（initRenderer，src/worker-b.ts:206-241）

`WebGLRenderer({canvas: OffscreenCanvas, antialias: true, powerPreference: 'high-performance'})`（OffscreenCanvas 在 Worker 内可用，`:206-208`）→ `setPixelRatio(1)`、SRGB 输出（`:212-213`）→ **`resumeChannel.port2.postMessage(null)` 启动帧循环**（`:218`）→ Scene（背景 + 雾）→ 透视相机（初始 (0, 64.09, 0)）→ 光照 ambient 0.6 + directional 0.8（`:220-240`）。`resize` 消息：`renderer.setSize(w,h,false)` + 相机 aspect（`:243-249`）。

## 8. 帧信号驱动循环（src/worker-b.ts:664-710）

- **自投递续环**：`resumeChannel = new MessageChannel()`（`:664`）；port2 `postMessage(null)` → port1 onmessage → `waitRenderWakeup(50ms)` → `frameTick()` → `absorbRenderWake()` → 再自投递。MessageChannel 消息任务**无 setTimeout 嵌套 4ms 钳制**，唤醒到重绘延时最小。
- **主驱动 = 主线程 rAF 的 wake()**（计数语义，vsync 对齐——每 rAF 一帧，呈现平滑）；WorkerA 发布不 notify；50ms 超时仅兜底。
- **帧率上限 = 刷新率**：渲染完成后 `absorbRenderWake` 吸收渲染期间到达的信号 → 渲染快时不忙循环超限。
- **单帧保护**：`frameTick`（`:671`）用 try/catch 包住 `onFrame`——单帧异常（GPU 驱动/几何错误）不中断循环。
- **消息回退节流**：`isMessageMode && !repainted` → `setTimeout(100ms)` 自检；`shared-state` 到达时 `onStateMessage` 立即 `postMessage(null)` 触发循环。

## 9. 采样与插值（onFrame，src/worker-b.ts:712-781）

> **2026-09-11 迁移：onFrame 现在有两条分支。**
> - **tick 模式**（`computeMode === 'tick' && authShared`，`:719-733`）：走**共享层 `TickConsumer`**——
>   `tickConsumer.step(now, (dstF, dstI) => authShared.readAuthoritativeInto(dstF, dstI))`，
>   由消费器产出 `TickDisplayPose`（α 网格弦插值 + 六显示态 + Δ 控制器），再 `applyCulling` + `render`。
>   消费器的 tick 率取自面板 `readPanelTickRate()`（tick 模式权威步长 = 面板值 raw 直译，无 +3 偏移）。
> - **耦合/解耦模式**：走本节下文描述的既有路径（`readState` 消费 192B 渲染通道 + 线性插值窗口）。
> 模式由 main 转发 WorkerA 的 `mode-ack` 通知（`:227-233`）；切换时 `tickConsumer.reset()`，状态不跨模式存活。

1. **采样**：`readState()` 非阻塞——V 更新 → 推进插值窗口（`interpLast ← interpCur`，`interpCur ← 新状态`，时间戳 = 到达时刻）→ `localCopy = state`（**本地副本唯一更新来源**，一旦非 null 永不回落——首帧竞争保护，`:688-690,157-159`）；V 未变 → 用插值。
2. **消息回退节流**：`isMessageMode && !newState` → 返回不渲染（状态即节奏，`:694-696`）。
3. **插值**（`:697-710`）：渲染参数 = 状态间线性插值（独立 `renderState`，不污染 localCopy 权威语义）。状态到达帧 `now === interpCurT` → alpha=1 直接用最新权威；仅当物理发布 < 刷新率时产生中间帧。现役 surf_666 物理约 1kHz 发布 > 刷新率，每次唤醒都有新状态 → alpha 恒 1（`:700-702` 注释）。
4. **`interpolateState`**（`:720-743`）：yaw 走最短路径环绕（±180° 判定）+ 归一化 [-180,180)（防 350°→10° 插值出 360/540 越界值）；pos/vel/pitch 直接线性。
5. `applyCulling(renderState)` → `render(renderState)`；`stats.frames++` 仅在实际提交时（fps = 真实渲染帧率，非唤醒次数，`:711`）。

## 10. 相机映射与 HUD（src/worker-b.ts:745-779）

- **FPS 相机约定**（与 game renderer-main 一致，`:748`）：`camera.rotation.set(pitch·DEG2RAD, yaw·DEG2RAD, 0, 'YXZ')`；`camera.position.set(pos.x, pos.y + EYE_STAND, pos.z)`（`:749-751`）。与 game 的差异：harness 状态槽无 eyeHeight 字段 → 固定 EYE_STAND（game 每帧用 `state.eyeHeight`，仓库根 `game/src/renderer/renderer-main.ts:720-727`）。
- **HUD**：OffscreenCanvas 只能挂一个 context（已被 WebGL 占用）→ 状态摘要每秒一次 `postMessage({type:'status'})` 回 main 更新页面 DOM（无 TextGeometry，轻量）（`:35-36`；`updateStats :757-779`：fps / 物理刷新率 repaintSec / pos / vel / V / glbReady）。main 侧消费：`src/main.ts:128-145`。

## 11. GLB 挂载与渲染减负（src/worker-b.ts:251-556）

**挂载流程**（`loadGlb`，`:252-282`）：`GLTFLoader.parse(bytes, '', cb)`（无需 DOM；纹理错误仅贴图缺失，场景仍挂载）→ 旧 modelRoot 逐 mesh dispose 后移除（防重复加载泄漏，`disposeObject :285-298`）→ 根节点旋转清零（`resetRootRotations :301-309`，与 game 同法）→ **`optimizeScene()`** → `assignMeshCullingData()` → `applyCulling()`（`:272-276`）。

**optimizeScene（空间分块合并，`:347-556`）——渲染减负核心**：

- **问题**（`:123-128` 注释，surf_666 实测）：GLB 117 meshes / 34409 primitives / 377385 顶点（mesh 12 一项含 34043 primitive、32.2 万顶点、85%）——GLTFLoader 每 primitive 一个 THREE.Mesh → scene 有 ~3.4 万 Mesh 对象：每帧遍历/剔除开销 + 逐 mesh draw call 使渲染耗时接近 vsync 帧间隔（120Hz=8.3ms）→ 合成器错过取帧 → 视觉帧率减半。
- **流程**（`:311-324` 注释 + 实现）：① 收集全部 Mesh，`updateMatrixWorld(true)` 为世界基准（`:352-382`）；多材质/无材质 mesh 烘焙世界空间后整体保留不参与分块（防静默丢弃，`:362-374`）。② cell 大小自适应：世界包围盒对角线 / cbrt(512)，再按非空 cell 数微调 6 轮收敛到 [300,800]，钳制 [128,4096]（`:396-405`）。③ 每 mesh 世界包围盒中心归 cell（横跨多 cell 归中心，`:407-417`）。④ 合并：顶点 `applyMatrix4(matrixWorld)` 烘焙世界空间（clone 后变换，勿动原 geometry）；单 mesh cell 保留原 mesh；多 mesh cell **块内按材质（实例恒等）子合并** → `mergeGeometries(useGroups=true)` 最终合并（groups 保留材质索引：材质去重收集 + 块内索引重映射；属性不一致防御回退单独保留）（`:419-507`）。draw call = 块内材质数而非 mesh 数。⑤ **视锥外保一圈**：块 `geometry.boundingSphere` 半径 ×FRUSTUM_PAD——必须强制 `computeBoundingSphere()`（烘焙路径 clone 残留 GLB 局部空间旧球，非 null 会被跳过 → 剔除按错误位置判定 → 眼前块被误剔）（`:510-520`）。⑥ 替换 modelRoot + console.log 统计（原 mesh 数 → 块数、平均顶点、draw call 估算、前向视锥可见块估算——仅诊断）（`:522-555`）。
- **效果目标**：3.4 万对象 → ~300~800 空间块 → 每帧对象遍历约数百 → 渲染耗时 < 5ms → vsync 边界安全（`:123-128`、`src/worker-b.ts:38-42` 头注）。

**LOD 与剔除**：

- `assignMeshCullingData`（`:564-581`）：每 mesh 世界包围盒中心 → `userData.center`、包围球半径 → `userData.radius`（距离判定数据；空包围盒保持可见）。
- `applyCulling`（`:589-605`）：每帧（渲染前）以插值/权威状态的眼位（pos + EYE_STAND）单次遍历：`中心距 − 半径 > LOD_DIST → visible=false`（雾深处已淡化为背景，视觉平滑）；否则交 three.js 视锥剔除自动决定。
- 与 game 的对应关系（`:113-120` 注释）：game LOD_FAR（距离 > cullDistance 隐藏）对应此单档；块粒度下无需多级 LOD；无 PVS（PVS 不在最小集，`crates/wasm/src/lib.rs:18-19`）。

## 12. 验证覆盖

- `scripts/phys-smoke.mjs`：WorkerB 帧逻辑镜像（本地副本唯一参数源 = readState、V 去重、首帧竞争，`scripts/phys-smoke.mjs:374-404`）；断言 #12-14（V 未变返回 null / 递增语义）。
- `scripts/flicker-debug.mjs`：双缓冲协议压力测试——单写者 + 读者逐版本一致性（0 污染）+ V 单调递增断言（`scripts/flicker-debug.mjs:1-8`）。
- `scripts/race-wakeup.mjs`：唤醒槽并发协议（含旧单槽对照组——双等待者同槽互抢的再现）（`scripts/race-wakeup.mjs:1-6`）。
- `scripts/render-loop-verify.mjs` / `scripts/workerb-isolated.mjs`：渲染循环时序与隔离渲染能力上限。
