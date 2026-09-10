# 缺字段发现协议实测 · 事实表 v1（t1 首件交付）

- **规格**：`docs/phys-plan-discuss/t2-bench-brief.md` §9 挂钩1「缺字段发现协议·可执行规格 v1」（用户 r3.5 授权首件）
- **执行**：`temp/phys-bench/field-discovery.mjs`（node，wasm 只读加载，零产品代码改动）
- **wasm**：`game/pkg/websurf_wasm_bg.wasm`，sha256 `ee4c1ab317a100b449ab7fc9b5c597e1bb6855efbdd8fde38f1a24c85cc14690`（t3 重建版 v2，3710792B，pin=game/temp/wasm-hash-pin.json；本表 v1 原测基于 `a60371ee…db6b9`，t3 后 v2 复跑与 v1 逐项一致，见 :137 注）
- **口径**：dt=1/64；观察窗 16 tick；位级=f64 逐位（BigUint64 视图）+ 事件 JSON 全等 + gate_veto 记录
- **机器可读全量数据**：`temp/phys-bench/field-fidelity-results.json`（22 样本，含种子态全字段、首分歧明细、窗口终态）
- **机制归因调试脚本**：`temp/phys-bench/_debug-s3c.mjs`（C/B/B′ 三路径逐 tick 对照，因果验证）

---

## 0. 执行摘要

| 项 | 结果 |
|---|---|
| 状态类 | 4 规格类（s1/s2/s3/s4）+ 3 扩展判别类（s3c/s4b/s5）|
| 相位样本 | **22**（规格类 14 ≥3/类 ✓；扩展 8）|
| rig 层自检（裸快照恢复≡直跑，仪器可信前提）| **22/22 OK** |
| 9 字段往返 | 8 EXACT / 14 DIVERGE（物理承重 **9**，纯记账 5）|
| **活性种子缺口（行为级，须入种子面或计成本）** | **3 个：`ground_normal`、`contact_ticks`、`ducked/duck_frac`**（+事件槽 1 个设计注记）|
| 死位/无害（行为证据）| 10 项（§4）|

**结论一句话**：9 字段种子在平地/60°坡面/跳跃/空中/预传送全域位级精确；三个活性缺口全部有量化效应与因果验证——`ground_normal`（坡面带速种子永久掉速 ~19-21%）、`contact_ticks`（fresh 种子传送 B 路径恰好晚 1 tick）、`ducked`（不可播种，强制 ~6.4 tick 重新蹲伏延迟）。

---

## 1. 方法（规格 §9 挂钩1 映射）

每相位样本三路径：
- **C**（ground truth）：probe 确定性驱动至 atTick → 直跑 16 tick 窗口；
- **A**（rig 层）：同一实例，裸快照（WebAssembly.Memory buffer 整拷）恢复 → 同窗口重跑；要求 A≡C 位级（22/22 成立 → 仪器可信，F4-C 重推导机制可行性的直接证据）；
- **B**（产品层）：fresh world + `set_state(9 字段)` → 同窗口；diff(B,C) 位级。

相位发现：每类 probe 全程确定性驱动（rec 逐 tick 收集），`findPhases` 定 atTick；s2 用 `debug_trace` 2u 下探（categorize 同构）判定持续接触区间；s4/s4b 用位置跳变定位传送 tick。

---

## 2. 事实表（22 样本）

| 类 | 相位 | 往返 | 分歧类 | 首分歧字段（tick0） | 机制 |
|---|---|---|---|---|---|
| s1 平地滑行 | slide+3/+9/+21 | DIVERGE ×3 | 纯记账 | contactTicks（C=5/11/23, B=1）| contact_ticks 计数不入种子；本窗口无行为消费 → 记账级 |
| s2 60°坡 surf | surf@1/@8/@20 | **EXACT ×3** | exact | — | 9 字段足够（surfing 域无可观测隐藏态效应）|
| s3 跳跃落地 | jump-edge / apex-air / landing+bhop-press | **EXACT ×3** | exact | — | old_jump/has_jumped_before 无行为效应（§4）|
| s3 | landing / landing+2 | DIVERGE ×2 | 纯记账 | contactTicks（C=2/4, B=1）| 同 s1 |
| s4 传送 | pre-teleport | **EXACT** | exact | — | A 路径即时触发（落地 tick 即传），gate 计数两侧同为 0 |
| s4 | post-teleport / cooldown-mid | DIVERGE ×2 | 物理承重* | contactTicks + **事件槽遗留**（C t0 吐出种子 tick 的 teleport 事件，B=null）| *位置/速度全等；事件槽遗留为采样协议伪影+种子面缺口（§5 注记）|
| s3c 45°坡带速 | ramp-land | DIVERGE | **物理承重** | velX/velY Δ≈**94.3/94.5**，posX/posY Δ≈1.47 | **ground_normal 活性缺口**（§3.1）|
| s3c | ramp-land+2 | DIVERGE | **物理承重** | velX/velY Δ≈**80.8/81.0**，pos Δ≈1.26 | 同上 |
| s3c | ramp-land+jump | **EXACT** | exact | — | 起跳 275 钳把两侧速度收敛到同值 → 差异被抹除（§6 附注）|
| s4b 链式触发 | post-tp-over-trigger2 / second-tp-window | DIVERGE ×2 | **物理承重** | 事件-only：C t0 吐 tp_dest2 事件，B t1 才吐（**晚 1 tick**）；位置窗口末收敛 | **contact_ticks 活性缺口**：teleport.check 的 grounded 门（§3.2）|
| s5 蹲伏 | duck-full / duck-full+2 | DIVERGE ×2 | **物理承重** | eyeHeight Δ=**15.23**（46.04/48.86 vs 64.09）+ contactTicks | ducked/duck_frac 不可播种（§3.3）；零输入 7 tick 后眼高收敛 |
| s5 | duck-full+forward | DIVERGE | **物理承重** | eyeHeight Δ=15.23；速度窗口末**收敛**（B 持蹲键同步重蹲）| 证明：任何输入序列都无法复现 authority 的半蹲态——B 只能从头重蹲 |

---

## 3. 三个活性种子缺口（量化 + 因果）

### 3.1 `ground_normal`（Player 隐藏字段，3×f64）——最高优先

- **消费点**：`walk_move` nopre 钳制 `if params.no_prestrafe && p.ground_normal[1] > 0.999`（`src/phys/player.rs:907`）——唯一实证 read 消费者。
- **触发条件**：authority 处于**坡面着地带速**态时播种（默认 no_prestrafe=true）。fresh 的 `ground_normal` 保持默认 `[0,1,0]`（`create_player` :974），y=1.0>0.999 → 钳制误启用。
- **效应链（实测，`_debug-s3c.mjs`）**：钳制只缩放 `vel[0]/vel[2]` 到 cap 250（vy 不动）→ step_move 真坡面 clip 重投影 → 沿坡速度永久损失。45° 坡沿坡速 641→（B）508、601→（B）478：**单 tick 掉 ~19-21% 沿坡速**（每轴 −94.3/−80.8）；此后位置分歧以 ~1.2-1.5 u/轴/tick 持续增长，不随时间收敛（摩擦差分只是缓慢缩小速度差）。
- **因果验证**：两侧 `set_params({"no_prestrafe": false})` 后 **B′ ≡ C 全 tick 位级一致**（t0-t3 全等）→ 消费者唯一性定案。
- **解析核对**：B t0 观测 (−337.83, −337.65)；按「钳 vel[0]→250 → 真法线 clip 去法向分量」链式推演得 (−337.74, −337.74)，误差 ~0.1 u/s（摩擦次序细节），机制吻合。
- **修复建议（Rust 只增不改）**：set_state 扩展 `ground_normal` 3×f64（新增可选参数或配套 setter）；或种子面 v2 统一补。

### 3.2 `contact_ticks`（u32，state 已导出为 contactTicks）——teleport B 路径门

- **消费点**：`teleport.check(&origin, contact_ticks, _gate_ticks, …)`（`mod.rs:239-242` 把 contact_ticks 作为 check 的 ground_ticks 实参）→ `grounded = ground_ticks > 0`（`teleport.rs:193`）→ **B 路径（落地脚底 8u 下探）启用条件**。注意 `teleport_gate_ticks` 参数本身被 check 忽略（`_gate_ticks`，:176）——「落地稳定 ≥3 帧」门槛在现内核**未接线**。
- **效应（s4b 实测）**：fresh 种子 contact_ticks=0 → 首 tick check 时 grounded=false（player_tick 内 categorize 之后才自增）→ **B 路径恰好晚 1 tick 触发**；事件流偏移 1 tick，位置因「传送用终点绝对态抹除历史」窗口末收敛。
- **对 F4-C**：scratch 在触发器附近播种时，乐观预测的传送会晚 1 帧 → 视觉上预测帧传送晚 1 帧（consumer 可见事件时序差）。
- **修复建议**：set_state 扩展 `contact_ticks`（u32）。附带收益：state_js 已导出该键（11 键之一），位级 diff 通道现成。

### 3.3 `ducked`/`duck_frac`（bool + f64，eyeHeight 派生只读）——不可播种缺口

- **事实**：9 字段不含 ducked/duck_frac；`eyeHeight` 是派生量且 state 只读。fresh 恒从站立态（64.09）起步。
- **效应（s5 实测）**：authority 全蹲态（46.04）播种后，fresh 需持蹲键 ~**6.4 tick**（2.82 u/tick 斜率）才能追平眼高；此窗口内 hull 语义分歧（蹲箱 36 vs 站箱 72）——开阔地不可见，**顶低天花板/台阶沿场景有卡体/剪切风险**。
- **关键证明（duck-full+forward）**：窗口输入带蹲键时两侧速度**收敛**（B 也在蹲）——即不存在任何输入序列能绕过重蹲延迟；半蹲态只能靠种子本身。
- **修复建议**：set_state 扩展 `ducked`+`duck_frac`（eyeHeight 随 duck_frac 派生自动正确）。

---

## 4. 死位/无害清单（行为证据，供 t3 种子面取舍）

| 字段 | 静态依据 | 行为证据 |
|---|---|---|
| `has_jumped_before` | 全仓无 read（仅 :220 复位/:563 置位）| s3 landing+bhop-press EXACT（275 vs nopre 钳分叉未显形）|
| `old_jump` | :544 消费被 `!params.autobhop` 短路；默认 autobhop=true（:97）| s3 jump-edge EXACT |
| `surfed_since_grounded` | 仅写（:951/:564/:221）无 read | s2 三相位 EXACT |
| `fall_velocity`/`landing_velocity`/`land_punch` | 探测域内无可观测效应 | s3 landing/apex 窗口速度位级一致 |
| `teleport.cooldown` | **自 erase**：check 置 0.5s（teleport.rs:213/218）→ apply_teleport 内 reset（mod.rs:524）+ fire 后再 reset（:257）同 step 内归零 | 冷却永远不拦截任何后续 tick；「0.5s 防重复」注释为陈旧语义（s4b 链式触发连传实证）|
| `teleport_gate_ticks` 参数 | check 形参 `_gate_ticks` 未使用（teleport.rs:176）| 「≥3 帧」门槛未接线 |
| `triggers[].inside` | 仅复位（on_teleported）无 read | s4b 连传正常 |
| `ground_ticks_since_landing` | 消费点 :909 分支选择与 :1051；两侧自 tick1 起 >0 → 分支同向 | s1/s3 物理位级一致 |
| `stuck_ticks`/`blocked_ticks` | 未探测（卡体态未构造）| **留缺口注记**：卡体中态种子未验证 |
| `prev_origin`/`prev_speed` | set_state 强制 prev_origin:=origin（mod.rs:342）；探测域无消费差异 | s1/s2/s3 位级一致 |

---

## 5. 事件槽注记（设计级，非种子面）

s4 post-teleport：种子 tick 产生的 teleport 事件若未消费，C 窗口 t0 会吐出（B 恒 null）。**事件槽内容不在 9 字段内、也不应入种子**——F4-C 语义下 scratch 事件流由 scratch 自排空、authority pending 事件走 authority 通道；本现象属采样协议伪影 + 「事件不可播种」的既定设计，计入 P-tick 注记，不算返工项。

---

## 6. 对 F4-C 的成本置信结论（gatekeeper 输入）

**9 字段种子当前可信域（位级 EXACT 实证）**：平地滑行、60° 坡面 surfing 全相位、跳跃边沿/空中顶点/无输入落地/bhop 按压、预传送 A 路径、传送后位置态（终点绝对态抹除历史）、带速起跳（275 钳收敛效应）。

**不可信域（无扩展种子前）**：
1. **坡面着地带速中态**（45° 实测掉速 19-21%，持续发散）——surf 图高频态；
2. **触发器附近的落地/站立中态**（B 路径晚 1 tick）；
3. **半蹲中态**（6.4 tick 重蹲延迟 + hull 分歧窗）。

**收敛护栏（现存机制自带的误差抹除器）**：起跳 275 钳（无条件，bhop_speed_clamp=true 默认）与平地落地 nopre 250 钳都会把速度收敛到同一 cap——平地上的种子误差逐次落地被抹除，不跨落地累积；发散只在地形连 续段（坡面着地段）内增长。

**建议行动**：
- **t3（rust-engineer）**：种子面 v2 = 9 字段 + `ground_normal`(3f64) + `contact_ticks`(u32) + `ducked`(bool) + `duck_frac`(f64)，一次性 additive（新 setter 或 set_state 扩展可选段）；`stuck_ticks/blocked_ticks` 列为待探测（卡体态种子本协议未覆盖）。
- **gatekeeper**：若种子面 v2 未及落地，RA-PREDICT 置信门须回避三类播种态（坡面带速着地段 / 触发器近旁着地段 / 半蹲段），或按本文量化误差上界放行并标注。
- rig 层 22/22 位级自检通过 → 「裸快照恢复≡直跑」机制成立，F4-C 权威实例零触碰零写入的仪器前提直接可用。

---

## 7. 复现指引

```bash
node temp/phys-bench/field-discovery.mjs          # 全 22 样本（~2s）
node temp/phys-bench/field-discovery.mjs s3c      # 单类过滤
node temp/phys-bench/field-discovery.mjs '' v2    # 【种子面 v2 验收对照】set_state_ex(state_full()) 全量面——
                                                  #   t3 wasm 落地后执行；三不可信域（坡面带速/触发器近旁/半蹲）预期全转 EXACT；
                                                  #   特性探测：无 set_state_ex/state_full 时显式报错不误跑
node temp/phys-bench/_debug-s3c.mjs               # ground_normal 机制 C/B/B′ 逐 tick 归因
node temp/phys-bench/_debug-s4.mjs                # s4 传送基线（对照 phys-smoke §9）
```

注（gatekeeper 复核后追记）：本表钉死 wasm sha256 `a60371ee…db6b9`；t3 重建 wasm 后以 v2 复跑为「三缺口闭消」验收对照，本表（v1 数据）降为历史基线。待补类：卡体中态（stuck/blocked_ticks，player.rs:885 ≥6 清零读点在——条件性活位，种子面 v2 就绪后补 s6-stuck 回归）。
注（captain 2026-09-10 追记，bench t6 呈请）：当前生效 pin 升级为 `ee4c1ab3…4690`（t3 重建 v2，:5 已同步）；t6/v3 复刻面已在 v2 上重跑全对照（含 D10 六格、F1 双峰 23/23），v2 全字段种子档为 F4-C 主案档。

—— t1 首件交付完毕（bench-engineer）。
