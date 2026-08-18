# WebSurf 物理与时序问题修复方向

> 2026-08-17。根因分析见 `../game/docs/timing-game-analysis.md`（专题 A–E），本文只给修复方向。
> 标注约定：**[确定]** = 方向明确可直接实施；**[候选]** = 存在多个可行方向，需按权衡选择；
> **[不修]** = 已评估，量级小或属固有设计，明确不动。

问题映射：P1 手感偏沉（专题 B/C）｜P2 坡顶入坡幻影碰撞（专题 D）｜P3 坡底速度规律归零
（专题 E）｜P4 后台标签页（时序分析 §3.7）｜P5 死亡阈值未下发（§4.3）｜P6 死配置
teleportGateTicks（§4.6）｜P7 跳跃冲量无补偿（专题 B③）。

## P1 手感偏沉 —— 大部分子项被 P2/P3 覆盖

积分层已证无误差（专题 C：分区不变，Δ=1e-13 级），**该子项不修**。剩余子项：

- 幻影碰撞损失 → **由 P2 根治** [确定]
- 权威摩擦/落地行为灌入渲染线 → **由 P3 修复** [确定]
- 反预速规则（noPrestrafe / bhopSpeedClamp）→ **[不修]** 规则设计而非缺陷，配置开关
  已存在；如需对齐宽松 surf 服务器手感，属产品默认值决策（`config.ts:108-109` 改 false）。
- 碰撞容差嵌入（DIST_EPSILON 0.03125u + PUSH_OUT 0.1u 每次命中）→ **[不修]** Quake
  原版同款语义，单次损失 ~0.13u，非手感主体；改动易引入贴面抖动回归。
- 无终端速度钳制 → **[候选·可选]** Rust 侧补 `sv_maxvelocity 3500` 等价钳制
  （`player_tick` 末尾或 `try_player_move` 入口，全速度向量模长钳制）。工作量极小，
  但会改变长落差行为（现可超 3500），是否对齐 Source 由产品定。

## P2 坡顶入坡幻影碰撞（brush 凸棱无 bevel）—— 根治项

**[确定] 方向：brush 构建期生成轴向 bevel 平面（Quake QBSP 同款）。**

- 实现位置：`src/phys/world.rs`（Brush 构造后、`build_index` 前的后处理函数，如
  `add_axial_bevels(&mut Brush)`；`mod.rs build_world` 循环处调用）。
- 算法要点（轴向 bevel，覆盖本 bug 的全部场景）：
  1. 枚举 brush 每条棱（相邻两平面 A、B 的交线，`cross(A.n, B.n)` 非退化且棱段在
     brush 包围盒内）；
  2. 对 6 个轴向法线 ±x/±y/±z 逐一测试：构造过棱上点 p 的平面 `(n, dot(n,p))`；
  3. 保留满足"brush 全部顶点仍在平面内侧（不切掉实体）且平面方向与 A、B 均不平行
     且能切掉 A∩B 半空间在棱外的过近似区"的候选，追加进 `brush.planes`。
  - 幻影墙案例验证：竖直切面（n=−z）与坡面（n=(0,cos,sin)）的棱会生成 n=−z 或
    轴向 bevel，把过近似区切回真实棱附近。
- 风险点（需在验证中确认）：
  - **MAX_CLIP_PLANES=8 交互**：bevel 命中会占 `try_player_move` 的 planes 槽位
    （`player.rs:447-453`），复杂角落可能更易触发"≥8 平面全零"分支。Quake 原版
    上限 5 且 bevel 常态存在，正常应无碍；回归时重点看 V 形槽/夹缝场景。
  - broadphase 的 min/max 不变（bevel 只缩不小），无索引影响。
- 验证标准：`phys-rate-parity-v2.mjs` 场景 B 全部参数两线 Δvel < 10（当前 2242/2422）；
  实验②直坡滑行、实验④接缝终态差应缩小或不劣化；全地图 smoke。
- **[候选·备选，不推荐首选] 碰撞期棱检测**：命中平面时检测是否为角点幻影（盒与相邻
  平面棱的实际距离 > 与本平面距离则改投最近真实面）。不改数据但热路径复杂度高。
- **[不修·地图侧]** 贴缘几何规避仅作临时缓解。

## P3 坡底速度规律归零（摩擦灌入）

**[候选] 主修：权威 onGround 与渲染线状态分歧时暂停速度灌入。两个实现层级：**

- **A2（推荐先行，零 wasm 改动）**：`authority-calibrator.ts calibrateVelocity` 增加
  条件——`f.onGround === true`（SAB 帧已带 A_GROUND，MsgState 帧同有）且渲染线
  `state().onGround === false` 且两线位置差 < 60 时，跳过 `set_velocity`。
  - 语义：权威已落地（进入摩擦域）而渲染线还在空中/坡上 → 不灌，让渲染线自己演化
    到落地（相位差 <1 tick，自然收敛后恢复灌入）。
  - 误伤窗口：正常落地前 1~2 帧也不灌——渲染线自演化 2 帧的偏差可忽略。
- **A1（后续精确化，需 wasm API 扩展）**：Rust `state()` 输出增加 `surfing` 字段
  （`player.rs` 已有该状态，`state_js` 加一个 `set_f64`；两端 `wasm.d.ts` 类型同步），
  灌入条件改为 `auth.onGround && predSurfing` 精确判定，消除 A2 的位置差启发式。

**[确定] 辅修：land snap 门限收紧。** `applyCollisionCorrection` 的 land 分支
（`authority-calibrator.ts:319-324`）增加前置条件：渲染线接近着地
（`st.onGround || Math.abs(st.velY) < 100`）才应用 snap；或将距离门限 60 收到 30。
防止"渲染线还在坡上surfing 被硬吸到坡底落地点"。

**[候选·观察项] 双线软锁兜底。** 渲染线被幻影楔形钉住 → 反向同步把权威拖回悬停态的
软锁（专题 D 连锁失败），预期 P2 bevel 根治后消失；若线上仍复现，再考虑
`sync-render-state` 权威侧合法性校验（拒绝"悬空且速度≈0"的同步源）。不建议先做——
校验规则难枚举，易误伤合法传送/悬停。

## P4 后台标签页（时序黑洞）

**[候选] 两个子方向：**

- **B1（推荐）：隐藏时暂停权威线。** `visibilitychange` hidden：`authLoop.pause()`
  （新增方法：置 paused 标志停 `setTimeout` 链）+ SAB 写 keysMask=0；visible：
  `authLoop.reset()`（清累积器，避免深度节流欠步狂奔）+ 权威 `set_state(渲染线当前
  状态)`（对齐两线）+ calibrator `clear()`。彻底消除冻结键位继续模拟与回前台拉扯。
- **B2（最小改动）：仅清键位。** hidden 时 SAB 写 keysMask=0（shared-state 新增
  `clearKeys()`）。后台仍模拟但无输入、漂移大幅缩小；实现量最小，但深度节流的
  累积器狂奔问题仍在（欠步补齐期间与渲染线分叉）。

B1 多一个 pause/resume 生命周期，注意与 worker-dispatch 的 loopStarted 状态机交互。

## P5 死亡阈值未下发（协议缺失被兜底掩盖）

**[确定] 接线即可**：`InputBridge.sendSetDeathThreshold` 已实现（`input-bridge.ts:67-69`）
但无调用者——`app.ts` 在 worker ready 后发送 `set-death-threshold`，值与渲染侧一致。
同时修正渲染侧传参：`renderer-main.ts:273-274` 传 `bbox.min.y` 但注释声称
"场景最低 Y − 1000"，二取一（建议按注释改为 `bbox.min.y - 1000` 或改注释）。
修后权威侧死亡/重生真正生效，也消除"渲染坠亡 → 反向同步拉回"的兜底掩盖路径。

## P6 死配置 teleportGateTicks

**[确定] 删除**（Rust `teleport.rs check` 已忽略，`mod.rs:216` 仅保签名；默认值 1 与
注释"默认 3"不符）。连带清理：`config.ts` 字段、面板项、`params.ts` 映射、
`worker-types.ts` 若有引用。若未来要恢复穿面防误触，按新需求重设计而非复活死参。

## P7 跳跃冲量无补偿通道（起跳头 1~2 帧"闷"）

**[候选·低优先级]**

- 方向 1（接受）：量级 1~3u、时长 <16ms，感知低——可明确不修。
- 方向 2：calibrator 记录"本地跳跃时刻"（渲染线 `check_jump` 发生帧，可经 velY 从 ≤0
  转 >301 检测，或从 Rust state 暴露 has_jumped 事件），在权威帧速度包含该跳跃
  （权威 velY > 0 或帧时刻越过跳跃时刻 +1 tick）前，跳过灌入的垂直分量。

## 建议实施顺序

| 序 | 项 | 理由 |
|---|---|---|
| 1 | P3-A2 + P3 辅修 | 零 wasm 改动、当天可上，surf 手感立竿见影 |
| 2 | P2 bevel | 根治幻影碰撞（同时消 P3 软锁、P1 主要碰撞损失），中工作量需回归 |
| 3 | P4-B1 | 必然触发的时序缺陷，独立于物理改动 |
| 4 | P5、P6 | 小改动，协议一致性 |
| 5 | P3-A1、P7、P1 maxvelocity | 精确化与可选项，按需 |

验证基建：`game/scripts/phys-rate-parity*.mjs` 已可复现 P2/P3 症状，作为修后回归基线。
