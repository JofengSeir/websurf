# 设计差异点讨论（时序图 vs 蓝图 v3 vs 实现现状）

> 编制日期：2026-08-07。本文**仅列差异点供讨论决策**，非最终结论。
> 参与文档：
> - `docs/项目时序图.md` — 理想架构原型（双 Worker 三源决策）
> - `MINIMAL-IMPL-PATH.md`（v3，同目录）— 实现蓝图
> - `IMPLEMENTATION-STATUS.md` §3（同目录）— 实现现状的事实记录
>
> 讨论格式：每项给「差异 / 影响 / 选项 / 我的倾向」四栏。
> 标注：🔴 需决策 · 🟡 可选优化 · 🟢 已定论（仅存档，无需讨论）

---

## A. 数据通道层（SAB / 输入 / 传输）

### A1 🟢 D1 — SAB 用 Int32 定点而非 Float64
- **差异**：蓝图/时序图默认 Float64 存 pos/vel/yaw；实现用 Int32 定点（dx/dy×1000、pos/vel×100、yaw/pitch×1000）
- **影响**：位置精度 0.01 HU、角度 0.001°——远高于肉眼可辨；定点转换每帧一次，开销可忽略
- **选项**：无（**Atomics 只支持整数 TypedArray**，Float64 无法原子累加，这是硬约束）
- **结论**：🔴 无讨论空间，仅记录。若担心精度可提定点倍率，但不建议

### A2 🟡 D3 — build_world 是否要做到"真正零 JSON"
- **差异**：蓝图声称"物理世界 Rust 内直建、零 JSON"；实现跨线程已零大 JSON，但 Worker 内
  `build_world(brushJson, triJson, teleportJson)` 仍接收导出 JSON 做一次解析
- **影响**：Worker 内一次 JSON 序列化+解析（几十 MB），仅地图加载时发生（非热路径），
  实测加载耗时主要在图之外；但要达到蓝图字面承诺需重构 lib.rs 数据通道（Bsp 内存直传 wasm 物理）
- **选项**：
  - 维持现状（JSON 在 Worker 内中转）——已够用，加载秒级
  - 重构 `PhysWorld::build_world_from_bsp(&Bsp)` —— 完全零 JSON，但动 vbsp 内部结构，风险高
- **倾向**：维持现状。收益（少一次 Worker 内解析）与风险（重构核心解析层）不成比例

### A3 🟢 T1 — 输入消耗用 exchange 而非 CAS 循环
- **差异**：时序图 Worker-A 用 CAS 循环（`cur→cur-consumed`）；实现用 `Atomics.exchange` 一次性清空+截断
- **影响**：SPSC（唯一写者主线程、唯一读者 Worker-A）下两者语义等价；exchange 更简单
- **选项**：无（单读者场景 CAS 循环是过度设计）
- **结论**：🔴 已定论。若未来 Worker-B 也要消耗输入（当前只读不消耗）才需 CAS

### A4 🟡 T5 — 输入槽无 frameStamp 时间戳
- **差异**：时序图输入槽含 frameStamp；实现未实现
- **影响**：时间戳本用于诊断/插值基准；实现渲染由 rAF 驱动、物理由 Worker 自驱，无需它
- **选项**：维持（省 8 字节/槽）；或补（诊断价值）
- **倾向**：维持。诊断需求出现时再加

---

## B. Worker 与时钟层

### B1 🔴 T2 — 权威物理频率：60Hz vs 68Hz（可调）
- **差异**：时序图固定 60Hz；实现默认 68Hz、面板 48-128 可调
- **影响**：68Hz 是 surf 社区/CS 服务器惯例；可调性带来"玩家改 tick 是否算作弊"的公平性问题
  （KZ/surf 计时地图中 tick 影响成绩）
- **选项**：
  - 保持可调（现状）——调试友好，但计时公平性存疑
  - 锁定 68Hz 只读——面向游玩公平
  - 双模式：调试可调 + 游玩锁定
- **倾向**：短期保持可调（项目还在调试期）；上计时玩法前锁定

### B2 🟡 T3 — Worker-B 基线：主线程推 vs Worker-B 拉
- **差异**：时序图主线程 release 更新基线到 SAB；实现 Worker-B 主动 acquire 读权威区 + set_state
- **影响**：实现少一个 SAB 写者（主线程不写基线），读侧同步天然最新；时序图语义是"主线程权威就绪
  即推基线"更即时，但多一处写者 + 主线程需管理基线槽
- **选项**：
  - 维持拉模式（现状）——简洁，基线=权威区同源
  - 改推模式——严格对齐时序图，但复杂度上升
- **倾向**：维持拉模式。权威区本身就是"最新权威"，Worker-B 每轮读它就是推模式的等价实现

### B3 🟡 T4 — Worker-A 无 EMA 滤波
- **差异**：时序图 Worker-A 独立时钟用 EMA 滤波平滑 wall-clock dt；实现直接取原始 dt（限幅 0.1s）
- **影响**：EMA 平滑的是"自驱循环的调度抖动"；实现用 `Atomics.wait(16ms)` 自驱 + 固定步长
  （dt 只决定本轮补几个步长），抖动被固定步长吸收，EMA 收益小
- **选项**：维持；或补 EMA（抖动大时更稳）
- **倾向**：维持。若实测高刷屏出现物理"呼吸感"（步数抖动）再补

### B4 🟢 T6 / L4 — eyeHeight 未入 SAB
- **差异**：时序图权威状态含 eyeHeight；实现渲染相机高度 = `pos.y + 0`（未存 eyeHeight）
- **影响**：**相机高度错误**——站立时应 `pos.y + eyeHeight`（约 +64 HU），当前渲染在脚底
- **选项**：无争议，**必须修**。SAB 权威区有预留槽（I_A_ONGROUND 旁的冗余 Int32 可换 Float64 定点存 eyeHeight）
- **结论**：🔴 需决策的是"何时修"——建议随 L4 一起尽快修，这是渲染正确性问题

---

## C. 功能与消息层

### C1 🟡 D2 — noclip 实现在 Rust 侧 vs 蓝图"JS 侧"
- **差异**：蓝图 §2.5 明确"noclip 逻辑简单留 TS，不进 wasm"；实现放 Rust `noclip_step` + set_noclip
- **影响**：Rust 侧单一物理源（physics/noclip 同一状态机），但调试功能进了 wasm（每改一次要重编译 wasm）；
  蓝图意图是"调试代码别污染物理核心"
- **选项**：
  - 维持 Rust 侧（现状）——内聚
  - 迁回 JS 侧——对齐蓝图，但 noclip 状态要在 JS 维护（双状态源风险）
- **倾向**：维持 Rust 侧。noclip_step 是 20 行纯数学，不构成"污染"；双状态源风险更大

### C2 🟢 D4 — 面板动作统一走 config
- **差异**：蓝图恢复 `set-physics-mode` 专用消息；实现并入 config（physics.mode 字段）
- **影响**：消息协议 7+5 更薄；mode 是 config 的一个属性，并入合理
- **结论**：🔴 已定论，无讨论空间

### C3 🟡 D5 — tickRate 变更是否清累积器
- **差异**：蓝图要求切换瞬间清 moveAccumulator；实现 runLoop 无累积器（dt 直接限幅）
- **影响**：实现架构（自驱循环）天然无累积器，蓝图假设的是旧 frame 信号驱动的累积器模型
- **选项**：无（实现模型已不同，蓝图条目过时）
- **结论**：🟢 蓝图条目作废，无需讨论

### C4 🔴 L3 — teleport 消息 = respawn（丢 spawn 索引切换）
- **差异**：蓝图/时序图 teleport 携带出生点索引；实现 `phys.respawn()`（只回初始出生点）
- **影响**：主线程 spawn 下拉框形同虚设（选任何项都回初始点）；多出生点地图无法定点传送
- **选项**：
  - 补 `PhysWorld::teleport_to_spawn(idx)` + Worker-A 按索引处理——补全功能
  - 移除 spawn 下拉 UI（承认最小化砍掉此功能）
- **倾向**：补 `teleport_to_spawn(idx)`。Rust 侧加一个索引参数即可，改动小；spawn 下拉已有 UI

### C5 🟡 D6 — wasm-opt=false 是否长期
- **差异**：实现因本机 NODE_OPTIONS 污染 wasm-opt 而关闭二次优化
- **影响**：wasm 体积/性能略逊于 wasm-opt 优化后（LTO+opt3 已做大部分）
- **选项**：维持 false；或 CI/打包机上开启（换干净环境）
- **倾向**：短期维持；发布前在干净环境验证 wasm-opt 后体积差，若 <10% 可忽略

---

## D. 待办汇总（按优先级）

| 优先级 | 项 | 性质 | 建议 |
|---|---|---|---|
| P0 | B4/L4 eyeHeight 入 SAB | 渲染正确性 bug | ✅ **已实施**（SAB A_EYE/P_EYE 槽，冒烟站立 64.09） |
| P1 | C4/L3 teleport_to_spawn | 功能缺失（UI 已存在） | ✅ **已实施**（set_spawn_points + teleport_to_spawn，冒烟传送 (50,200,30) yaw=90） |
| P0.5 | B2 基线版本号守卫 | 拉模式无效预测 | ✅ **已实施**（predictRound 写前 compare V_A，不一致丢弃） |
| P2 | B1/T2 频率锁定 | 公平性 | 上计时玩法前决策 |
| P3 | A2/D3 零 JSON | 蓝图字面承诺 | 维持现状 |
| — | 其余（A1/A3/C2/C3/B2/B3/C5） | 已定论/维持 | 无需行动 |

---

## 结论预览（2026-08-07 更新）

- ✅ **已实施**：eyeHeight（P0）、teleport_to_spawn（P1）、基线版本号守卫（B2）
- **待决策**：tick 频率锁定机制（P2，feature flag 条件编译，决策后动手）
- **建议维持**：Int32 定点 / exchange / 拉基线 / Rust noclip / config 统一消息 / wasm-opt=false / 零 JSON / EMA / frameStamp

---

## E. 终版时序图审查结论论证（V1-V12，2026-08-07 新增）

> 依据 `docs/项目时序图.md` 终版 + 审查结论表，逐项论证当前实现差距与处置。

### E.1 差距论证

| 编号 | 漏洞/要求 | 当前实现 | 差距 | 处置 |
|---|---|---|---|---|
| V1 | 输入提取窗口无上限（不截断 50ms） | `addInput` 每帧无截断累加，rawDt 限幅 0.1s 仅影响步长 | ✅ 已满足（无窗口截断） | 无需改 |
| V2 | 多字段状态撕裂 → 双缓冲 | 单缓冲权威/预测区 + V_A 版本号 | 🔴 **需实施**（读半程可撕裂） | 双缓冲 S_A[0/1]、S_P[0/1] |
| V3 | 主线程清零 seq 竞争 → 代际校验 | `clearPrediction()` 主线程 store(seq,0) | 🔴 **需实施**（会覆盖 Worker-B 新预测） | 废弃清零，gen_P==gen_A 校验 |
| V4 | eyeHeight 未入共享状态 | ✅ 已补（A_EYE/P_EYE 槽） | ✅ 已满足 | 无需改 |
| V5 | 预测步长僵化 → 动态 | 固定 `predDt = 1/tickRate` | 🔴 **需实施** | min(now-lastPhysicsTime, 16.67ms) |
| V6 | Int32 输入槽溢出 → BigInt64 | Int32 定点累加 | 🔴 **需实施**（长卡顿 wrap） | BigInt64 原子累加 |
| V7 | teleport 仅回初始点 | ✅ 已补 teleport_to_spawn | ✅ 已满足 | 无需改 |
| V8 | tick 频率锁定 | 面板可调 48-128 | 🟡 **需实施**（feature flag） | 锁定 68Hz，调试构建可调 |
| V9 | 连续预测发散 → 限 3 帧 | 无限制连续用预测 | 🔴 **需实施** | 连续 ≤3 帧，超限回退权威 |
| V10 | 重复提取输入 | `takeInput` exchange 一次性清空 | ✅ 已满足（SPSC 无双消费） | 无需改 |
| V11 | EMA 时钟滤波 | 无 EMA | 🟢 暂缓（固定步长已吸收抖动） | 暂缓 |
| V12 | 零 JSON 地图加载 | Worker 内一次 JSON | 🟢 不行动（收益<风险） | 维持 |

### E.2 需实施清单（本轮）

1. **V2+V3+V6（Task #17）**：SAB 双缓冲（权威/预测各 2 槽）+ gen_A/gen_P 代际 + BigInt64 输入槽（`shared-state.ts` 全量重写）
2. **V3+V5+V9（Task #18）**：主线程废弃 clearPrediction 改 gen 校验、连续预测 ≤3 帧、Worker-B 动态步长
3. **V8/P2（Task #19）**：tick 频率 feature flag 锁定（默认锁定 68Hz，调试构建可调）

### E.3 论证结论

- **V1/V4/V7/V10 已满足**（4 项无需改）；**V11 暂缓、V12 不行动**（2 项）
- **需实施 6 项**：V2/V3/V5/V6/V8/V9——集中在共享层与预测链，是本轮改造主体
- 终版时序图相较 v3 蓝图的核心升级：**双缓冲消除撕裂 + 代际校验取代主线程清零 + 预测链防滥用**

### E.4 实施结果（2026-08-07）

| 项 | 实施 | 验证 |
|---|---|---|
| V2 双缓冲 | S_A[0/1]、S_P[0/1]（readState 按 (va-1)&1 / (seq-1)&1 选槽） | 单测双缓冲翻转 va=2 读最新 |
| V3 代际校验 | gen_A/gen_P 槽；废弃 clearPrediction（空操作）；主线程 gen_P==gen_A 校验；Worker-B 写前 getGen 守卫 | 单测 gen 匹配、seq=gen1<<16\|5 |
| V5 动态步长 | predictRound 用 min(now-lastStepTs, 1/64)，2 子步均分 | — |
| V6 BigInt64 | dx/dy 输入槽 BigInt64 原子累加（修复 BigInt 整除截断：解码用 Number 除） | 单测 12.5×2=25 精确 |
| V8/P2 tick 锁定 | config.lockTickRate（默认 false）+ 面板禁用 + syncFullConfig 强制 64 | — |
| V9 连续预测限帧 | decideState continuousPred ≤3，超限回退 S_last 并重置 | — |

修复的坑：**BigInt 除法是整数除法（截断）**——定点解码必须 `Number(bigint)/100` 而非 `Number(bigint/100n)`（否则 eyeHeight 64.09 → 64）。

---

## F. v4 架构变更（2026-08-07）：删除 Worker-B，预测移入主线程

> 用户实测反馈：双 Worker 预测同步「复杂且易卡」，且面板参数/输入链路出现多处问题。
> 决策：**预测与渲染同频（rAF 内），权威 Worker 只同步基本信息，位置不同步**。
> 时序图已同步更新（`docs/项目时序图.md` v4）。

### F.1 新架构

```
主线程（渲染 + 输入 + 位置预测）
  ├─ mousemove 清洗 → SAB 输入槽（BigInt64 原子累加）
  ├─ 每 rAF：读权威基本信息（yaw/pitch/vel/eyeHeight/onGround）→
  │    位置预测：pos += vel × dt（速度积分外推，无碰撞）
  │    角度：权威帧间 LERP（最短角距）
  └─ 渲染（相机 = pos + eyeHeight）
Worker-A（权威物理，唯一 Worker）
  ├─ 固定步长累积器（无步数封顶，不丢物理时间）
  ├─ wasm tick（完整物理：碰撞/传送/死亡）
  └─ 写权威基本信息 + V_A++（位置仅权威侧维护）
```

### F.2 关键差异（v3 → v4）

| 项 | v3（双 Worker 预测） | v4（主线程预测） | 理由 |
|---|---|---|---|
| 预测执行者 | Worker-B（wasm 第二实例 + 2 子步） | 主线程渲染循环（位置积分 + 角度 LERP） | 双 Worker 同步复杂易卡；渲染帧 > 物理帧，主线程天然同频 |
| 权威同步内容 | 全状态（pos/yaw/pitch/vel/eyeHeight/onGround） | **仅基本信息**（角度/速度/眼高/着地），**无位置** | 同步量减半；位置由主线程积分，接受无碰撞误差 |
| 决策模型 | 三源决策（权威/预测/S_last）+ 代际校验 | 权威校准 + 预测渲染（无竞争） | 无 Worker-B 后无预测竞争，协议大幅简化 |
| 位置突变 | 权威直接覆盖 | `player-respawn` 事件回传归零 | 位置不同步，respawn/teleport 需事件通知 |
| 物理循环 | 60Hz 自驱 + MAX_FIXED_STEPS=10 | 固定步长累积器**无封顶** | 低帧率不丢物理时间（用户报"卡住"根因之一） |
| 面板参数 | config → Worker-A + Worker-B 双同步 | config → Worker-A（单一通道） | 无第二物理实例，无双同步 |

### F.3 v4 修复的问题（代码层面）

1. **角度单位 bug（鼠标/物理错乱根因）**：Rust `state()` 的 yaw/pitch 为**度**；
   v4 渲染器曾直接当弧度用（旧三源决策代码乘了 DEG2RAD）→ 视角放大 57 倍、
   鼠标一转疯狂旋转。修复：权威读取处 `yaw/pitch × DEG2RAD` 存弧度。
2. **respawn 回传 yaw 多乘一次**：`notifyPosReset` 原 `yaw × 180/π`（Rust 已是度）→ 修正为直传。
3. **位置漂移（既定取舍）**：主线程积分无碰撞，落地/碰撞后会穿墙漂移；
   当前接受（用户确认"考虑过后可以接受"），后续可加「权威位置低频同步」优化（如 4Hz 位置纠偏）。

### F.4 遗留优化方向（非本轮）

- 权威位置低频纠偏（4Hz 覆盖主线程积分误差，防长距离漂移）
- 主线程预测加简单重力项（`vel.y -= g·dt`）可减少跳跃弧线误差（当前纯线性外推）

---

## G. v4.1 架构修正（2026-08-07）：预测必须物理模拟（客户端预测）

> 用户明确要求：**主线程预测必须做物理模拟**（不是速度积分），权威物理做中途修正。
> 标准客户端预测模式。时序图 v4.1 已更新（`docs/项目时序图.md`）。

### G.1 修正后的架构

```
主线程（渲染 + 输入 + 预测物理模拟）
  ├─ wasm PhysWorld 预测实例（主线程内 init + build_world，与权威同模块独立实例）
  ├─ 每 rAF：
  │    1. 读权威（V_A 变化）→ set_state 修正预测基线（位置/角度/速度/着地）
  │    2. 预测实例 predict(dt, keys, dx, dy) —— 真实物理模拟（移动语义+碰撞）
  │    3. 渲染预测状态（零输入延迟）
  ├─ 输入双通道：同一份 dx/dy/keys 同时喂 SAB（权威）与预测实例
  └─ respawn/teleport：player-respawn 事件 → set_state 归零
Worker-A（权威物理，唯一 Worker）
  ├─ 固定步长累积器（无封顶）
  ├─ wasm tick（完整物理）
  └─ 写权威**全状态**（含位置）→ 主线程 set_state 修正用
```

### G.2 相对 v4 的差异

| 项 | v4（速度积分外推） | v4.1（wasm 预测实例） | 理由 |
|---|---|---|---|
| 预测方式 | `pos += vel×dt` 线性积分 | `PhysWorld.predict(dt, keys, dx, dy)` 物理模拟（含碰撞） | 用户要求"必须物理模拟"；积分会穿墙/漂移 |
| 权威同步 | 基本信息（无位置） | **全状态（含位置）** | set_state 修正预测基线需要位置 |
| 修正机制 | 无（角度 LERP） | 每权威帧 `set_state` 覆盖预测实例 | 客户端预测标准纠偏 |
| 预测实例 | 无 | 主线程 wasm 第二实例（build_world + set_params/set_hull） | 复用 Worker-B 时代 API（predict/set_state） |
| 输入 | 仅 SAB | 双通道（SAB + 预测实例缓冲） | 预测实例与权威消费同一输入 |

### G.3 实现要点

- 主线程 wasm 初始化：`fetch wasmUrl → wasmInit`（与 Worker-A 同模块、独立实例）；地图加载时一次
- 预测实例构建：world-json（brush/tri/teleport/spawn）→ `build_world` → `set_params`/`set_hull` 同步面板参数
- 每帧时序：**先 set_state 修正 → 再 predict → 渲染**（修正优先，预测从权威基线继续）
- 角度单位：Rust state() 输出度，渲染时 `× DEG2RAD`（v4 已修，v4.1 保持）
- 输入双通道：mousemove 事件同时 `bridge.addInput`（SAB）与 `renderer.feedInput`（预测缓冲）；
  keys 由 rAF 输入循环双喂

## H. v5→v7 架构演进（2026-08-08，用户逐轮调试定案）：唯一物理渲染线 + Worker 权威帧

> v4.1（wasm 预测实例 + set_state 修正）在实测中被推翻——用户多轮反馈暴露了
> "双物理体系互相覆盖"的深层问题。最终架构（v7）已落地并成为**时序图 v7 的现状**。

### H.1 演进链（每轮用户反馈 → 架构决策）

| 轮 | 用户反馈 | 决策 | 结果 |
|---|---|---|---|
| v5 | 双 Worker 预测同步复杂易卡 | **主线程唯一物理线** + Worker 纯位置差分速度（无世界无碰撞） | 运动问题（卡墙判定误伤修复后）基本可玩 |
| v6 | 需要 Worker 碰撞 | Worker 从主线程状态起步 + 同输入 tick 输出碰撞速度 | 与"权威不得收外部影响"冲突 |
| v6.5 | 回退 v5，仅修灵敏度 | 灵敏度输入层应用（物理两端 sensitivity=1） | **分叉结构性消除**（沿用至今） |
| v7 | Worker 权威帧计算模式，需考虑中途地图碰撞 | **Worker = 独立权威帧计算器**（固定步长 1/tickRate，完整物理）；主线程渲染物理按 Bn/Bn+ 接收权威帧 | 定案 |

### H.2 v7 核心架构

```
Worker（权威帧计算器）
  ├─ wasm + world-json 世界构建（地图碰撞，加载时一次）
  ├─ 独立权威物理线：固定步长 = 1/tickRate（64/128Hz，累积器无封顶）
  ├─ 每 tick：takeInput（SAB 累积输入）→ 完整物理（碰撞/传送/死亡）→
  │   碰撞事件检测（land/blocked）→ 写权威全状态 + V_A++
主线程（唯一物理渲染线，144Hz 可变 dt）
  ├─ 输入层：灵敏度乘入角度增量；Q/E 生成等效鼠标量（独立增量）→ SAB + 本地缓冲同源
  ├─ 每 rAF：读权威帧 → 速度外推校准 set_velocity(vel_A + a×Δt) →
  │   wasm tick（完整物理）→ 渲染
  ├─ 碰撞事件 → 位置微调 + 角度同步（<60 才调）
  └─ 异常兜底：位置差 >200 → set_state（双端静止时收紧版）
```

### H.3 关键决策与教训（血泪史）

1. **单向数据流**：权威→主线程只有一条边（速度校准）；主线程**永不写权威**。
   任何"反推速度喂权威"（v4.2 平均速度正反馈衰减→走不动）与"增量纠正写权威"
   （v4.4 污染权威）在结构上被禁止。
2. **校准只动速度**：位置/角度不覆盖——渲染帧永远是主线程物理自己的连续输出。
   set_state 兜底（>200 异常）在运动中不触发，防视角/位置跳变。
3. **角度完全隔离**（用户定调）：权威帧不得影响渲染角度；Q/E 输入层化后双端
   同源输入 → 角度天然一致；仅碰撞事件（权威判定碰撞）可同步角度。
4. **灵敏度/Q/E 都是输入层参数**：物理两端 sensitivity 固定 1——改灵敏度不产生
   双端分叉；Q/E 独立增量（yaw_bind_speed/M_YAW×dt）不受灵敏度影响（CS 语义）。
5. **tickRate 必须显式传递**：Worker fixedDt = 1/config.physics.tickRate——
   buildPhysicsParams 不含 tickRate 导致 128Hz 设置静默无效（实测 3s tick 数
   64Hz=192 vs 128Hz=384 验证生效）。
6. **Worker config 必须应用 patch**：applyConfigPatch 缺失时权威永远用默认值
   （默认 1.5 vs 面板 1.5 巧合掩盖 bug——"一进去就是错的"根因）。
7. **传送检测多点下探 + 落地门槛**：斜面滑行脚底悬空坡面 ~20 units（碰撞推移无
   持续吸附），surf_666 283/523 个 trigger 为 ≤8 units 薄片 → 单点必 miss；
   TRIGGER_PROBES 0~48 多点探测兜底。但**门槛计数仅认真正落地**（contact_ticks
   与 on_ground 同步，可站面 normal.y ≥ 0.7；surfing 滑行不算）——曾把 surfing
   也计入导致正常滑翔图坡底 trigger 在滑行中被下探命中误触（人还在坡上滑就被
   传送回家），2026-08-08 修正为滑行中 gate 恒不通过、只有落地后才判定传送。
8. **落点检测默认 1 帧**（2026-08-08）：teleportGateTicks 3→1，斜面传送更灵敏。

### H.4 遗留（已知可接受）

- 双端跳跃相位差（64/128 vs 144Hz 跳跃检测频率差，垂直方向 ~60 units）由
  校准门控/碰撞事件缓解，不强制同步位置
- Q/E 按住时双端按键采样有半帧差（输入层化后仅 ~1° 级，角度不被权威影响）
