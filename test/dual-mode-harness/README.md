# WebSurf-test — 双模物理 + OffscreenCanvas 渲染时序验证工程

> **事实基准**：本文档最后核对 2026-08-13，以实际代码为准（`src/worker-a.ts` / `src/shared-state.ts`
> / `src/worker-b.ts` / `src/main.ts`）。「64t 坡速 ≈ 无限制」成因分析、会审结论与修复架构详见
> **[CONCLUSION.md](CONCLUSION.md)**（2026-08-11 会审 + 双模核心重构后的事实基准，两文档对齐）。

> 目的：验证一套独立的 输入 → 双模物理 → 帧信号渲染 循环：主线程仅输入转发 / UI → SAB 无锁
> （WAKEUP/RENDER_WAKEUP 双唤醒槽 + 双缓冲状态槽）→ WorkerA 双模物理（模式A 1ms 无限制真理源 +
> 模式B 独立 64t 权威速度线）→ WorkerB OffscreenCanvas 渲染（**帧信号驱动**：主驱动 = 主线程 rAF）。
> 仅保留基本 WASD + 鼠标视角 + BSP 地图加载 + 难度按钮，无面板/功能扩展。

---

## 一、当前架构（2026-08-11 双模核心重构后）

```
主线程 (src/main.ts)
  ├─ 前置条件检测：crossOriginIsolated + SharedArrayBuffer → SAB 模式；不满足 → 消息回退模式
  ├─ 输入捕获（pointer lock 后 mousemove 累积 + WASD/空格/R）→ 每 rAF addInput（SAB 原子累加）
  ├─ wake()：双槽 store+notify —— WAKEUP(WorkerA 物理背压) + RENDER_WAKEUP(WorkerB 渲染帧信号)
  │    ★ RENDER_WAKEUP = 渲染主驱动（rAF 与 vsync 同相 → 呈现平滑）；WorkerA 发布不 notify
  ├─ 难度按钮（关/32/64/128/256/1000，默认 64）→ writeTickRate（仅 store，无 notify）
  ├─ BSP 加载：文件选择 → BspProcessor 导出（brush/tri/teleport/spawn/pvs/GLB）→ 双 Worker 分发
  └─ R 重生 → postMessage({type:'respawn'})；trace 按钮 UI（TraceState 状态机，见 §四）

WorkerA (src/worker-a.ts) — 双模物理核心
  ├─ 模式A（无限制真理源）：phys = 1ms 固定子步 + 实时输入（consumeInput ±1000）
  │    位置/角度只由模式A 推进；共享状态槽唯一写入者（WorkerB 渲染参数唯一来源）
  ├─ 模式B（tick 权威速度线）：tickPhys = 第二个 PhysWorld，只走 tickDt 步长
  │    每 tick 边界：键位 = peekKeys() 快照 + 鼠标 = 模式A 消耗的窗口累积
  │    → 独立 64t 物理演化 → set_velocity(三轴) 校准模式A（唯一 tick 影响通道，位置/角度不碰）
  │    分叉兜底：与模式A 偏差 > TICK_ANCHOR_DIST(64)（死亡/传送/卡墙/坡缘）→ 全量拉回
  ├─ **先 tick 计算 → 后无限制计算**；tick 节点未到则越过直达无限制
  ├─ 自驱循环：setTimeout(loop, 0) 续环 + waitWakeup 背压（剩余 ≥1ms 挂起，否则自旋）
  ├─ 子步上限 8/轮 + 累加器封顶 0.02s（时间不丢失）；delta clamp 0~50ms
  └─ respawn / world-json：双实例同步重建；模式B 停用→激活边沿 set_state 对齐起点

WorkerB (src/worker-b.ts) — three.js 第一人称渲染（帧信号驱动）
  ├─ OffscreenCanvas（transferControlToOffscreen，主线程零取帧零等待）
  ├─ 帧循环：MessageChannel 自投递 + waitRenderWakeup(RENDER_WAKEUP)
  │    主驱动 = 主线程 rAF 帧信号（vsync 对齐，每 rAF 一帧）；50ms 超时仅作停摆兜底
  ├─ 无节流（SAB 模式）：每次唤醒采样 readState；V 未变不重绘（重复唤醒零成本）；
  │    例外：消息回退模式（无 SAB）无数据时 100ms 低频自检（数据到达立即触发）
  ├─ 本地副本只被 readState 更新（渲染参数零污染）；PVS 剔除（复刻 game pvs-manager）
  └─ status 摘要每秒回传 main → DOM HUD；trace 3D 路径线 UI（TraceRenderer，见 §四）

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
  index.html          入口（canvas + file input 加载 .bsp + 难度按钮[关/32/64/128/256/1000] + HUD + trace 按钮）
  package.json        构建脚本（build:wasm / build:ts / build / build:dist，依赖 three）
  crates/wasm/src/lib.rs  薄导出层（path 依赖共享 src/phys + src/wasm-core：PhysWorld +
                       BspProcessor 最小导出集：metadata/export_brushes_planes/模型碰撞/parse_teleports/
                       parse_spawn_points/parse_pvs_data/export_glb_with_pakfile_models——
                       **未导出 mosaic/缺失纹理/默认纹理包**：test 无画质切换与回退）
  pkg/                wasm-pack 产物（gitignored）
  src/
    shared-state.ts   SAB 布局与读写协议 + peekKeys + 消息回退模式（msg-main/msg-physics/msg-render）
    main.ts           主线程：前置检测 → 输入转发 + wake()（RENDER_WAKEUP = 渲染主驱动）→ BSP 分发 → respawn
    worker-a.ts       WorkerA 双模物理核心（先 tick 计算 → 后无限制计算）
    worker-b.ts       WorkerB 帧信号驱动渲染（OffscreenCanvas + PVS + 50ms 超时兜底）
  scripts/
    build-dist.mjs    构建 dist（multi 5 文件：app/worker-a/worker-b/wasm/index.html；test 无 single 内嵌模式）
    phys-smoke.mjs    node 冒烟测试（**191/191 PASS**，2026-08-13 实测；含 ModeAB 双实例镜像、分叉兜底锚定回归、帧信号驱动、消息回退、PVS）
    perf-bench.mjs    性能基准（消费/写入/热路径 vs 对象构造；worker_threads 模拟）
    race-wakeup.mjs   唤醒竞争测试（WAKEUP/RENDER_WAKEUP 双槽隔离）
    trace-verify.mjs  trace 公共链路验证（Chrome headless + CDP：开始→保存→无错误）
    tmp-dual-compare.mjs  test 双模 vs game 双线数据对照（关键指标 <15%）
```

> 注：`phys-smoke.mjs` 在 node 环境复制镜像 TestShared / ModeAB（核心逻辑与
> shared-state.ts / worker-a.ts 逐字对齐，改动须同步——注释中明示）；已核实的镜像
> 偏差：`MAX_ACC` 曾漂移为 0.05，2026-08-11 已对齐 worker-a 的 0.02（封顶 20ms）；
> ModeAB 另含测试侧 `tickYaw` 可选分支（worker-a 无 set_yaw_pitch 路径）。

## 四、已知边界与死代码（如实记录）

1. **trace 双线 UI 已恢复可用**：commit 878515f（2026-08-12）新增 `src/ts-shared/trace/` 公共模块；
   `worker-a.ts` 现导入 `TraceRecorder`（`../../../src/ts-shared/trace/trace-recorder.js`）并处理
   `trace` 消息（约 L42/L116/L346），采样 phys（无限制基准）与 tickPhys（tick 实际）后发
   trace-data；`main.ts` 导入 `TraceState` 转发 trace-point；`worker-b.ts` 用 `TraceRenderer`
   渲染双线。（原 d1767c0 的"死代码"状态已被此提交修正。）
2. **sustained surf 稳态速度 tick 无关**（正确物理，非缺陷）；tick 难度载体 = 输入采样相位
   与离散施加点。
3. **稀疏轮次输入滞后**：单轮 ≥2 个 tick 边界时 tick 实例输入 ≤1 窗口滞后，有界自愈。
4. **速度相位差**：模式A 速度在边界被校准后由自身物理演化，与 tick 速度存在 ≤1 tick 相位差
   （game 客户端预测同款语义）。
5. **残差相位伪差**：64t 离散相位导致 ≤1 tick 的有界起跳提前/延后（着地判定窗口内），属设计内难度手感。
6. **死亡阈值**：`brushJson` 最小 min[1] − 100（默认 −100000 兜底），与 game（场景包围盒 min.y）不同。
7. **UI/脚本文案滞后（如实记录）**：`index.html` HUD 标题仍为"单模 1ms 物理时序验证"（与双模现状不符）；
   `scripts/tmp-dual-compare.mjs` 头注释仍按旧校准语义描述（"xz=粗糙/vy=模式A"），未随三轴校准重构适配；
   `writeStateRaw`/`tick_into` 为 wasm API 能力（worker-a 实际子步热路径为 `writeState → phys.state()`，
   不使用两者）；`pendingWorld` 暂存（world-json 先于 wasm 就绪）与布局回归史（dyAcc 与 V 重叠的屏闪根因）
   仅在源码注释记载。

## 五、构建与运行

```bash
npm install
npm run build:wasm   # wasm-pack release → pkg/，并拷贝 wasm 到 test 根
npm run build:ts     # typecheck + esbuild（app / worker-a / worker-b 三产物）
npm run build:dist   # multi 打包（5 文件，HTTP 运行；test 仅 HTTP，SAB 恒定可用）
node scripts/phys-smoke.mjs   # 冒烟测试（191/191 PASS）
node scripts/perf-bench.mjs   # 性能基准
node scripts/race-wakeup.mjs  # 唤醒竞争
```

**双击运行**：`play.cmd`（自动 `npm run build:ts` → 启动本地服务器 → 打开
`http://localhost:8080/index.html`；依赖 Node.js + Python 3；窗口即服务器，关闭即停）。

**手动运行**：`python ../../src/serve.py 8080 .` → 访问 `http://localhost:8080/index.html`
（需 HTTP + COOP/COEP 启用 SharedArrayBuffer；SAB 不可用时自动消息回退模式，HUD 提示通道模式）。

**操作**：点击画布锁定指针 → WASD/方向键移动、空格跳、鼠标视角；R 重生；难度按钮切换
关/32/64/128/256/1000（仅 store TICK_RATE，WorkerA 下轮自动识别）；「加载 BSP 地图」选择
`.bsp` 文件（BSP 是唯一玩法，主线程解析 → world-json/GLB/PVS 分发双 Worker）。
