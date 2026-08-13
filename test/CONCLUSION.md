# WebSurf-test — 「64t 坡速 ≈ 无限制」成因分析结论与修复架构

> 本文档是 2026-08-11 对「/test 斜坡 surf 时 64tick 速度 ≈ 无限制计算速度」问题的
> 三方（主分析 / 另一 agent / 子代理独立复核）会审结论，以及依据结论对 /test
> 实现的修复架构（worker-a.ts 双模核心重构）。

---

## 一、结论摘要

**用户观察是正确的物理事实，不是读数错误。**

1. **主因（数学必然）**：物理全部算子按 dt 标定
   - 摩擦 `drop = control × friction × dt`（src/phys/player.rs:312）
   - 地面/空中加速 `accelspeed = accel × wishspeed × dt`（player.rs:272, :295）
   - 重力半隐式 `½g·dt` ×2（player.rs:946-948）
   - `clip_velocity` 沿法线精确剪裁（player.rs:323）
   - ⇒ 每秒速度变化总量与步长无关。sustained surf 的稳态速度是 **tick 不变量**：
     64t 与 1ms 必然收敛到同一平衡速度。`phys-smoke.mjs` 的「surf 校验#2」
     （32/64/128/256 峰值 |Δ|<1%）就是该性质的固化物。

2. **真实 tick 难度载体**：输入采样相位 + 离散施加点，不是稳态速度
   - 跳跃按下 → 边界采样 → 起跳延迟 ∈ (0, tickDt]，均值 ≈ tickDt/2（bhop 难度）
   - 鼠标在 tick 边界采样（转向台阶）、快变输入错位
   - bhop_speed_clamp / 碰撞 clip 在 64t 网格上的施加相位
   - 这些在 `phys-smoke.mjs` 运动差别#1~#5 中被量化验证。

3. **旧实现（d1767c0 单实例双模）的三层缺陷**
   - **粗糙 tick 不是独立 64t 演化**：在模式A 末端状态上再走 15.6ms，其速度对应
     T+15.6ms 却注入 T 时刻状态 ——「未来速度」伪差；
   - **校准空操作**：sustained 运动下 1×15.6ms ≈ 16×1ms（dt 标定），xz 写回等于
     写回模式A 已有的值；
   - **读数遮蔽**：模式A 的输入也走 64t 快照（渲染线并非真正无限制），HUD 只读
     校准后 xz + 模式A vy；且 trace 双线（绿=无限制基准/红=tick 实际）在 d1767c0
     重写 worker-a.ts 时被删除成死代码 —— 用户唯一能看到的 HUD 数值必然趋同。

4. **/game 的对照**：game 是双实例（Worker 权威 64Hz + 主线程预测 144Hz），渲染
   速度每帧被 `set_velocity(authVel + a×Δt)` 覆盖（authority-calibrator.ts:247-262），
   速度源永远是 64t 权威 —— 没有「无限制」对比轴。game 在 sustained surf 上同样
   不会显示 tick 速度差（tick 无关是正确物理），tick 差异在 bhop/碰撞/快变输入。

---

## 二、修复架构（依据结论 + 四条用户要求）

四条要求逐条落地：

| # | 要求 | 落地 |
|---|---|---|
| 1 | 输入仅进入 WorkerA；**先 tick 计算 → 后无限制计算**；tick 节点未到则**越过直达无限制** | 主线程只写 SAB 输入槽（不变）；worker-a `loop()` 每轮先执行 tick 块（`loAcc ≥ tickDt` 才执行，未到跳过），再执行模式A 子步 |
| 2 | WorkerA 承担无限制计算与 tick 计算 | 单 Worker 持**两个 PhysWorld 实例**：`phys`（模式A 1ms 真理源）+ `tickPhys`（模式B 独立 64t 权威速度线） |
| 3 | 无限制计算的位置/角度不得受影响，**仅速度可被 tick 限制** | 模式A 是唯一 SAB 输入消费路径（**逐子步实时输入**，位置/角度只由自己推进）；tick 对模式A 的唯一影响 = `set_velocity(tickPhys 三轴速度)`（含 vy，独立实例无重复重力问题）—— 绝不写位置/角度 |
| 4 | WorkerB 仅接收无限制计算的渲染参数 | 共享状态槽唯一写入者 = 模式A 子步（writeStateFromPhys），模式B 不写槽（不变） |

### 核心循环（worker-a.ts loop 镜像）

```
loop():
  delta = clamp(墙钟差, 0, 50ms)
  modeBActive = tickRate > 0 && 1/tickRate > 1ms
  激活边沿：loAcc/累积器清零 + tickPhys.set_state(phys 全状态)   // 对齐起点

  ── 第一步：tick 计算（先）──────────────────────────────
  if modeBActive:
    loAcc += delta
    while loAcc >= tickDt:                    // tick 节点到达才执行
      loAcc -= tickDt
      采样：keys = peekKeys()（边界当前键位）
            dx/dy = 自上一边界模式A 实时消耗的累积增量（限幅）
      位置锚定（分叉兜底）：dist(tickPhys, phys) > 64 → 全量 set_state 拉回
                // 极限操作（死亡/传送/卡墙/坡缘）后的无界分叉防护；正常演化不干预
      tickPhys.tick(tickDt, keys, dx, dy)     // 真实 64t 物理（独立速度演化）
      phys.set_velocity(tickPhys.三轴速度)     // 速度校准（唯一 tick 影响通道）
  else:
    loAcc = 0                                 // 未到节点/关闭 → 越过直达无限制
  ── 第二步：无限制计算（后）──────────────────────────────
  acc += delta
  while acc >= 1ms（≤8 步/轮）:
    inp = consumeInput(±1000)                 // 实时输入（唯一消费路径）
    if modeBActive: 累积 inp.dx/dy（tick 边界采样用）
    phys.tick(1ms, inp)                       // 位置/角度只由模式A 推进
    writeStateFromPhys()                      // 唯一共享槽写入（WorkerB 渲染参数）
```

### 关键语义

- **tick 实例输入**：键位 = tick 边界当前掩码（64t 采样粒度，bhop 延迟 ∈(0,tickDt]）；
  鼠标 = 模式A 实时消耗的窗口累积（与真实 64t 服务器「tick 边界消费整窗口」等价）。
  稳态下输入滞后 ≤1ms（模式A 消耗与边界的间隙），稀疏轮次最坏滞后一个窗口，有界自愈。
- **时间对齐**：tick 实例只在边界推进，其状态时刻 = 边界时刻；校准注入的速度与
  模式A 位置**同刻**（消除旧实现「未来速度」伪差）。
- **速度全三轴校准**（含 vy）：独立实例的 vy 是自身 64t 重力演化结果，无「重复推进
  时间」问题 —— 无需旧实现「vy 用模式A」的补救 hack。
- **预期行为**：sustained surf 稳态速度仍 tick 无关（正确物理）；tick 难度可见于
  bhop 时机（速度通道）、快变输入、碰撞相位 —— 与 /game 一致。
- **tickPhys 独立演化 + 分叉兜底锚定**：tick 的速度由自己 64t 步进演化（离散相位
  保留）；与模式A 位置偏差 > TICK_ANCHOR_DIST(64) 时（死亡/传送/卡墙/坡缘等极限
  操作后的无界分叉）**全量拉回模式A**（位置/角度/速度/着地），恢复正常上下文；
  正常演化（偏差有界 ≤ 数十 units）不干预——避免锚定引入相位伪差（试错记录：
  每边界强制锚定会导致 tick 着地判定与锚定位置错位 → 空中二次起跳/落地延迟
  百 ms/连跳梯度崩塌，已废弃）；respawn / world-json 时双实例同步重建；模式B
  停用→激活时 set_state 全量对齐。

### 渲染驱动（2026-08-11 三轮修复：vsync 对齐 + 解除节流）

- **主驱动 = 主线程 rAF 帧信号**（wake() 的 RENDER_WAKEUP store+notify）：主线程
  rAF 与浏览器合成器/vsync 同相 → WorkerB 每帧信号渲染一次 → 渲染完成/呈现时刻
  与显示器刷新对齐 → **呈现平滑**。
- **WorkerA 发布不 notify**（writeStateRaw 只写槽 + V++）：1kHz 随机相位唤醒 →
  渲染完成时刻与显示器 BeginFrame 错位 → 画面呈现时间不规则（"HUD 60 f/s 却观感
  ~20f"的抖动根因）；醒后只读最新槽（V 未变不重绘）。
- **解除节流**：去掉自适应 20/100ms 超时 → 固定 50ms 仅作停摆兜底（主线程 rAF
  停摆/隐藏标签页时自驱，渲染不冻结）；每次唤醒采样，V 更新才提交 Draw。
- **画面零拷贝直通**：WorkerB 渲染到 OffscreenCanvas（transferControlToOffscreen），
  浏览器合成器直接上屏——**主线程不取帧、不等待**，仅提供帧信号 + 输入转发；
  呈现帧率上限 = min(显示器刷新率, GPU 渲染耗时)。
- 渲染器 `powerPreference: 'high-performance'`（GPU 优先调度）。

### 附带说明：trace 双线（范围外，如实记录；2026-08-13 修订）

- **[2026-08-13 修订]**：trace 数据链路已在后续提交 878515f 恢复——新增
  `src/ts-shared/trace/` 公共模块，worker-a.ts 现用 `TraceRecorder` 采样
  phys（无限制基准）与 tickPhys（tick 实际）并发 trace-data；main.ts 转发
  trace-point；worker-b.ts 用 `TraceRenderer` 渲染双线。下列"死代码"描述已过时。
- （2026-08-11 会审时的记录）main.ts（按钮状态机 + trace-data 转发）与 worker-b.ts
  （3D 绿/红路径线）的 trace UI 仍在，但 worker-a 自 d1767c0 起不再发送 trace-data
  （死代码）——本轮修复未恢复 trace 数据链路（不在四条要求范围内）。
- 新架构使双线对照直接可得：**模式A = 无限制基准**（实时输入，渲染参数），
  **tickPhys = tick 实际**（独立 64t 速度线）。后续重连 trace 时，绿/红线分别采样
  phys 与 tickPhys 的状态即可，无需再维护旧的 physBase 对照实例（已由
  src/ts-shared/trace/ 的 TraceRecorder 实现）。

---

## 三、验证（phys-smoke.mjs 同步适配）

- `ModeAB` 类重构为上述双实例语义（tick 先行 + 独立 tickPhys + 三轴速度校准）；
- 各调用点（自由落体/无浮空/跳跃延迟/手感差异/连跳梯度/出坡/随机运动/运动差别/
  surf 校验/消息回退）补齐 tick 世界实例并适配新语义断言：
  - 「模式A 起跳即时（位置/角度不受 tick 影响）」+「tick 线起跳延迟 ≤1 tick
    （难度在速度通道）」；
  - 常量输入下加速/摩擦与基准**一致**（旧「2× 粗糙」伪差断言废止）；
  - 稳态速度、跳跃顶点、出坡物理、sustained surf tick 无关等结论性断言保留。

## 四、已知边界（如实记录）

1. sustained surf 稳态速度 tick 无关 —— 修复后依然成立（正确物理，非缺陷）。
2. tick 实例输入在稀疏轮次（单轮 ≥2 个边界）存在 ≤1 窗口滞后，有界自愈。
3. 模式A 速度在边界被校准后，子步间由自身物理演化 —— 与 tick 速度存在 ≤1 tick
   相位差（game 客户端预测同款语义）。
4. ~~tickPhys 独立演化位置漂移~~ —— **已消除（2026-08-11 二轮修复）**：与模式A
   位置偏差 > TICK_ANCHOR_DIST(64) 时全量拉回（死亡/传送/卡墙/坡缘等极限操作后
   校准速度脱离渲染上下文的"渲染混乱"根因）；64t 离散相位（bhop 采样/碰撞/钳制）
   不受影响。残余：≤1 tick 的有界相位伪差（如着地判定窗口内的起跳提前/延后），
   属设计内难度手感。
