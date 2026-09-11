# WebSurf-test — 三模式物理（耦合/解耦/tick）+ OffscreenCanvas 渲染时序验证工程

> **事实基准**：本文档最后核对 2026-09-11，以实际代码为准（`src/worker-a.ts` / `src/shared-state.ts`
> / `src/worker-b.ts` / `src/main.ts`）。「64t 坡速 ≈ 无限制」成因分析、会审结论与修复架构详见
> **[CONCLUSION.md](CONCLUSION.md)**（2026-08-11 会审 + 双模核心重构后的事实基准，两文档对齐）。

> 目的：验证一套独立的 输入 → 三模物理 → 帧信号渲染 循环：主线程仅输入转发 / UI → SAB 无锁
> （WAKEUP/RENDER_WAKEUP 双唤醒槽 + 双缓冲状态槽）→ WorkerA 三模物理 → WorkerB OffscreenCanvas 渲染
> （**帧信号驱动**：主驱动 = 主线程 rAF）。
> 仅保留基本 WASD + 鼠标视角 + BSP 地图加载 + 难度按钮 + **计算模式热切**，无面板/功能扩展。
>
> **迁移出处（2026-09-11）**：`coupled` / `decoupled` / `tick` 三种模式的**物理计算本体**迁自
> game 工程（game 侧的模式切换经真机手测判定失败，已回退为原本的耦合单模，其 `game/` 与
> 提交 `c4824e9` 逐字节一致）。三模式实现位于 `src/ts-shared/{auth,decoupled,tick}`（被本工程与
> debug 共享），本工程提供运行时装配（WorkerA 三实例 + 双线互斥 gate + `set-mode`/`mode-ack`
> 热切握手 + 页面模式切换 UI）。

---

## 一、当前架构（2026-08-11 双模核心重构后）

```
主线程 (src/main.ts)
  ├─ 前置条件检测：crossOriginIsolated + SharedArrayBuffer → SAB 模式；不满足 → 消息回退模式
  ├─ 输入捕获（pointer lock 后 mousemove 累积 + WASD/空格/R）→ 每 rAF addInput（SAB 原子累加）
  ├─ wake()：双槽 store+notify —— WAKEUP(WorkerA 物理背压) + RENDER_WAKEUP(WorkerB 渲染帧信号)
  │    ★ RENDER_WAKEUP = 渲染主驱动（rAF 与 vsync 同相 → 呈现平滑）；WorkerA 发布不 notify
  ├─ 难度按钮（关/32/64/128/256/1000，默认 64）→ writeTickRate（仅 store，无 notify）
  ├─ BSP 加载：文件选择 → BspProcessor 导出（brush/tri/spawn/GLB，最小集不含 teleport/PVS）→ 双 Worker 分发
  └─ R 重生 → postMessage({type:'respawn'})

WorkerA (src/worker-a.ts) — 三模式物理核心（装配层；计算本体在 src/ts-shared）
  ├─ 实例拓扑（G3 三实例同建同参同 hull）：
  │    phys     权威实例（耦合=auth 线 / 解耦=1ms 真理源 / tick=raw 64Hz 唯一实例）
  │    tickPhys 第二实例（解耦=64t 速度校准线；tick 闲置不驱动不 free）
  │    scratch  第三实例（tick=F4-C 乐观评估执行体；权威实例零写入）
  ├─ 模式语义（唯一权威 src/ts-shared/auth/compute-mode.ts）：
  │    coupled   auth 线 64Hz 权威（面板 tickRate + 3 隐藏偏移）——默认模式
  │    decoupled 1ms 无限制真理源 + 独立 64t tickPhys 速度校准 + 分叉锚定拉回
  │    tick      raw 64Hz 单实例权威 + F4-C scratch 乐观评估（排序门 + 内容封帽）
  ├─ 双线互斥 gate：auth-loop（coupled+tick 推进）+ decoupled-loop（解耦独占），
  │    各自 body 顶部 mode gate 早退；切换 = set-mode 翻转 worker 侧 computeMode
  ├─ 热切握手（§3.4.C）：set-mode → onSetMode（gate 翻转 + 状态注入 + tickPhys 对齐
  │    + 采样器清零 + resetInput + 交接首帧）→ mode-ack（回执由 shared 层 dispatch 收口）
  ├─ 双通道：**auth 通道**（ShmState，512B，共享协议）= 三模式物理唯一读写面；
  │    **渲染通道**（TestShared，192B）= MirrorShmState 发布即镜像 → WorkerB 零改动
  └─ respawn / world-json：三实例同步重建；死亡阈值 = brushJson min[1] − 100

WorkerB (src/worker-b.ts) — three.js 第一人称渲染（帧信号驱动）
  ├─ OffscreenCanvas（transferControlToOffscreen，主线程零取帧零等待）
  ├─ 帧循环：MessageChannel 自投递 + waitRenderWakeup(RENDER_WAKEUP)
  │    主驱动 = 主线程 rAF 帧信号（vsync 对齐，每 rAF 一帧）；50ms 超时仅作停摆兜底
  ├─ **tick 模式**：接 auth 通道（main 转发 mode-ack），经共享层 `TickConsumer`
  │    消费权威帧（`readAuthoritativeInto`）：α 网格弦插值 + 六显示态 + Δ 控制器 + 断窗八类
  ├─ **耦合/解耦模式**：既有路径——readState 消费渲染通道镜像 + 线性插值窗口
  ├─ 无节流（SAB 模式）：每次唤醒采样 readState；V 未变不重绘（重复唤醒零成本）
  └─ status 摘要每秒回传 main → DOM HUD

共享状态 (src/shared-state.ts)
  └─ SAB 192B：TICK_RATE / WAKEUP / 输入槽(dxAcc,dyAcc BigInt64, keysMask) / RENDER_WAKEUP
     / V + 双缓冲 S[2]（每槽 pos×3/vel×3/yaw/pitch）；peekKeys 非消耗读；writeStateRaw 零分配直写
     ★ 发布不 notify RENDER_WAKEUP（帧信号驱动渲染）；消息回退模式同 API 双实现（msg-*）
```

## 二、关键语义（与 CONCLUSION.md 对齐）

| 项 | 语义 |
|---|---|
| 模式A | 1ms 固定子步 + 逐子步实时输入；共享槽唯一写入者；渲染参数唯一来源（用户要求 4） |
| 模式B | 独立 64t 实例（tickPhys）：摩擦/加速/碰撞/bhop 钳制相位全在 64t 网格上（真实 64t 物理） |
| tick 输入 | 键位 = 边界当前掩码（64t 采样粒度，bhop 延迟 ∈(0,tickDt]）；鼠标 = 模式A 消耗窗口累积（限幅 tickInputMax） |
| 速度校准 | `set_velocity(tickPhys 三轴)`——唯一 tick 影响通道（含 vy，独立实例无重复重力）；位置/角度绝不触碰 |
| 分叉兜底 | 偏差 > TICK_ANCHOR_DIST=64 → 全量 set_state 拉回（极限操作防护）；正常演化（有界）不干预，保留 64t 离散相位 |
| 时间对齐 | tick 实例只在边界推进，状态时刻 = 边界时刻 → 校准速度与模式A 位置同刻（无「未来速度」伪差） |
| 去重 | TICK_RATE=0 或 ≥1000（tickDt ≤ 1ms，与模式A 等价）→ 跳过模式B（纯 1ms，防双倍物理） |
| 预期行为 | sustained surf 稳态速度 tick 无关（正确物理，非缺陷）；tick 难度在 bhop 时机/快变输入/碰撞相位 |

## 三、工程结构

```
test/dual-mode-harness/
  index.html          入口（canvas + file input 加载 .bsp + 难度按钮[关/32/64/128/256/1000] + HUD）
  package.json        构建脚本（build:wasm / build:ts / build / build:dist，依赖 three）
  crates/wasm/src/lib.rs  薄导出层（path 依赖共享 src/phys + src/wasm-core：PhysWorld +
                       BspProcessor 导出集：metadata/export_brushes_planes/模型碰撞/parse_spawn_points/
                       export_glb_with_pakfile_models——运行时最小集；parse_teleports/parse_pvs_data
                       WASM API 保留但主线程不调用；**未导出 mosaic/缺失纹理/默认纹理包**）
  pkg/                wasm-pack 产物（gitignored）
  src/
    shared-state.ts   SAB 布局与读写协议 + peekKeys + 消息回退模式（msg-main/msg-physics/msg-render）
    main.ts           主线程：前置检测 → 输入转发（双通道）+ wake()（RENDER_WAKEUP = 渲染主驱动）
                      → BSP 分发 → respawn → 计算模式热切（set-mode 意图 + mode-ack 回执）
    worker-a.ts       WorkerA 三模式物理核心（coupled/decoupled/tick 装配 + 热切握手 + 发布镜像）
    worker-b.ts       WorkerB 帧信号驱动渲染（OffscreenCanvas + 距离 LOD + 50ms 超时兜底）
    worker/           phys-instances.ts（三实例参数扇出，纯函数）+ t4-chain.test.ts（三模式链路单测）
    renderer/         tick-consumer.ts（α 网格弦插值 + 六显示态 + Δ 控制器 + 断窗八类）+ 单测
    panel/            tick-telemetry-format.ts（tick 遥测 7 行格式化）+ 单测
  scripts/
    build-dist.mjs        构建 dist（薄入口 → 共享内核 src/scripts/lib/dist-pack.mjs；multi 5 文件：app/worker-a/worker-b/wasm/index.html；test 无 single 内嵌模式）
    check-wasm-api.mjs    WASM 契约校验（薄配置 → 共享引擎 src/scripts/lib/wasm-api-contract.mjs；薄导出层 12 API，缺一即败）
    three-mode-verify.mjs **三模式运行时验证**（node 驱动构建产物 worker-a.js：补最小 Web Worker
                          宿主 → init-shared/auth-init/wasm-init/world-json → set-mode 三值，
                          断言 mode-ack 闭合 + 幂等 + 非法 mode 拒绝 + 每模式帧发布（V 前进）
                          + 连续往返热切 + tick-stats 遥测链路；`npm run test:three-mode`，14 断言）
    phys-smoke.mjs        node 冒烟测试（**192 处 check() 断言**，2026-08-24 读脚本计数；2026-08-13 实测
                          191/191 PASS 后又新增 1 项；含 ModeAB 双实例镜像、分叉兜底锚定回归、
                          帧信号驱动、消息回退、PVS）
    perf-bench.mjs        性能基准（消费/写入/热路径 vs 对象构造；worker_threads 模拟）
    race-wakeup.mjs       唤醒竞争测试（WAKEUP/RENDER_WAKEUP 双槽隔离）
    render-loop-verify.mjs busy-wait 高精度 rAF 三线程渲染时序校验 v3
    surf-e2e-verify.mjs   surf_666 三线程端到端链路测试
    flicker-debug.mjs     屏闪根因排查（双缓冲污染断言 / 真图传送乒乓几何扫描；临时诊断脚本）
    workerb-isolated.mjs  WorkerB 隔离纯渲染上限测试
    trace-verify.mjs      trace 公共链路验证（Chrome headless + CDP：开始→保存→无错误）
    dual-compare.mjs      test 双模 vs game 双线数据对照（关键指标 <15%；旧名 tmp-dual-compare.mjs）
  docs/                 源码解析文档（overview 总览 / sequences 时序 / implementation×2 细分 / differences 差异；旧档在 docs/archive/）
```

> 注：`phys-smoke.mjs` 在 node 环境复制镜像 TestShared / ModeAB（核心逻辑与
> shared-state.ts / worker-a.ts 逐字对齐，改动须同步——注释中明示）；已核实的镜像
> 偏差：`MAX_ACC` 曾漂移为 0.05，2026-08-11 已对齐 worker-a 的 0.02（封顶 20ms）；
> ModeAB 另含测试侧 `tickYaw` 可选分支（worker-a 无 set_yaw_pitch 路径）。

## 四、已知边界与死代码（如实记录）

1. **trace/FOV 已从运行时移除**（2026-08 最小集调整）：`main.ts` / `worker-a.ts` / `worker-b.ts` /
   `index.html` 不再包含 trace 路径线与 FOV 滑块；`scripts/trace-verify.mjs` 仍保留（`src/ts-shared/trace/` 公共模块已随最小集调整整体移除，原
   `scripts/trace-verify.mjs` 仍保留供独立验证使用，但不属于运行时最小集。
2. **sustained surf 稳态速度 tick 无关**（正确物理，非缺陷）；tick 难度载体 = 输入采样相位
   与离散施加点。
3. **稀疏轮次输入滞后**：单轮 ≥2 个 tick 边界时 tick 实例输入 ≤1 窗口滞后，有界自愈。
4. **速度相位差**：模式A 速度在边界被校准后由自身物理演化，与 tick 速度存在 ≤1 tick 相位差
   （game 客户端预测同款语义）。
5. **残差相位伪差**：64t 离散相位导致 ≤1 tick 的有界起跳提前/延后（着地判定窗口内），属设计内难度手感。
6. **死亡阈值**：`brushJson` 最小 min[1] − 100（默认 −100000 兜底），与 game（场景包围盒 min.y）不同。
7. **UI/脚本文案核对（R2 更正，基线 @2026-08-26）**：`index.html` HUD 标题为「WebSurf-test — 双模物理 + 帧信号渲染」（index.html:6，与双模现状一致——原「仍为单模」记载失效）；
   对照脚本现名 `scripts/dual-compare.mjs`（旧名 tmp-dual-compare.mjs 已弃用；其头注释校准语义本轮未复核，以源码为准）；
   `writeStateRaw` 为 TS 侧 TestShared 方法（`tick_into` 实为 wasm API，worker-a 未使用）（worker-a 实际子步热路径为 `writeState → phys.state()`，
   不使用两者）；`pendingWorld` 暂存（world-json 先于 wasm 就绪）与布局回归史（dyAcc 与 V 重叠的屏闪根因）
   仅在源码注释记载。

## 五、构建与运行

```bash
npm install
npm run build:wasm   # wasm-pack release → pkg/，并拷贝 wasm 到 test 根
npm run build:ts     # typecheck + esbuild（app / worker-a / worker-b 三产物）
npm run build:dist   # multi 打包（5 文件，HTTP 运行；test 仅 HTTP，SAB 恒定可用）
node scripts/phys-smoke.mjs   # 冒烟测试（192 处 check() 断言）
npm run test:three-mode       # 三模式运行时验证（驱动构建产物；14 断言，须先 build:ts）
node scripts/perf-bench.mjs   # 性能基准
node scripts/race-wakeup.mjs  # 唤醒竞争
```

**双击运行**：`play.cmd`（自动 `npm run build:ts` → 启动本地服务器 → 打开
`http://localhost:8110/index.html`；依赖 Node.js + Python 3；窗口即服务器，关闭即停）。

**手动运行**：`python ../../src/serve.py 8110 .` → 访问 `http://localhost:8110/index.html`
（需 HTTP + COOP/COEP 启用 SharedArrayBuffer；SAB 不可用时自动消息回退模式，HUD 提示通道模式）。

**操作**：点击画布锁定指针 → WASD/方向键移动、空格跳、鼠标视角；R 重生；难度按钮切换
关/32/64/128/256/1000（仅 store TICK_RATE，WorkerA 下轮自动识别）；**计算模式按钮**切换
耦合/解耦/tick（发 `set-mode` 意图，高亮与文案以 worker 回执 `mode-ack` 为准——不做乐观切换）；
「加载 BSP 地图」选择 `.bsp` 文件（BSP 是唯一玩法，主线程解析 → world-json/GLB 分发双 Worker；
最小集不含 teleport/PVS）。

> **三模式运行时验证**：`npm run test:three-mode`（须先 `npm run build:ts`）在 node 里给
> 构建产物 `worker-a.js` 补最小 Web Worker 宿主，按真实消息序列驱动并断言热切闭合。
> 真机（真实浏览器）主观/客观读数仍需用户手测——本工程脚本不启动真实浏览器。
