# rust-t3 动工前只读核查备忘（种子面 + state_out + 重建管线）

状态：只读准备（未 claim t3，未写任何代码）。行号全部对 `src/phys/` 当前 HEAD 实测。
用途：①与 t6 §11.1 字段表逐条对账；②给 t1 事实表（plan/field-fidelity.md）提供交叉对照的
**关键性图谱**（哪些字段驱动决策=必种，哪些只写不读=惰性）；③t4/t5 装配时的接口面预告。

**captain 三点批复（已生效，claim t3 时随更新注明）**：
①**范围校正（captain 背书）**：t3 inScope 原文 game/crates/** 有误——生效范围 = 仓库根
`src/phys/**`（种子面 + state_out）+ `game/crates` 构建胶水 + web wasm 产物三件套；
gatekeeper 终审按此口径验。
②**state_out 22 字段方案批准**（§3 布局照准）：[f64;8] append 扩至 22——B5 十字段 idx8-19 +
eye_height:20（消费端插值清单含 eyeHeight，蹲伏视高必须平滑）+ on_ground:21（消费侧遥测/调试）；
append-only 保兼容。
③**CRITICAL/INERT 图谱 = t1 事实表黄金对照**：bench-engineer 落盘后事实表发我，按
「证实/证伪/新增」逐条对账后再 claim t3 动工。§4 种子面草案（state_full/seed_full 对称 serde +
hash pin 工具）均批准；**零分配变体按原案延后**（等 bench M4④ 升级规则触发再加，不进首版）。

---

## 1. §11.1 行号实测对账（全部吻合，零修订）

| §11.1 项 | 实测 | 结论 |
|---|---|---|
| Player :132-172 全列 | ✓ struct 逐字段吻合 | 字段表可直接作 seed schema 蓝本 |
| InputState 十字段 :116-128 | ✓ forward/back/left/right/jump/duck/walk/reset/yaw_left/yaw_right | 十键确认 |
| old_jump :149 沿缓存 | ✓ 读 :544（非 autobhop 跳按住禁跳）/:635（跳沿检测）；写 :1044（tick 尾 `=input.jump`） | **CRITICAL**：跨种子边界的跳沿态 |
| reset 沿消费 mod.rs:265 | ✓ :266-269 `if input.reset { reset=false; respawn }`；player_tick :1013-1016 双保险清位 | 确认；tick 边界种子下 input 十键在下一步 step_core 被掩码整体重推导（apply_input mod.rs:545-557），沿语义由**重放掩码**承载，字段本身惰性 |
| teleport.cooldown :74 私有 | ✓ 读 :185-188（>0 → `-=dt` 并 return None）；写 :213/:218（触发置 TRIGGER_COOLDOWN=0.5，teleport.rs:18）；调用方 apply_teleport/reset_cooldown 置 0 | **CRITICAL**：armed 期间整段传送检测短路；f64 减法序列属于确定性序列，必须逐位 |
| triggers[].inside :66 | ✓ **只写不读**（:151 init false、:228 on_teleported 清 false，全文件无读取点） | **惰性**（历史遗留沿状态位）；按全量表仍播种，零成本 |
| event 槽 mod.rs:70 | ✓ 字段在 :71（:70 为文档行，微差）；step_core 只写（:250-261），take_event :460-497 只读消费 | 输出-only：不影响 tick 序列，P-ra-4 与之无关；按全量表播种（kind+origin+yaw；targetname 仅显示面） |
| teleport_gate_ticks 不存在 | ✓ check 形参 `_gate_ticks` :176 未使用；grounded 判定实为 `contact_ticks > 0`（:193，mod.rs:241 传参处） | 确认「形参在、状态不在」；无存储字段 |

## 2. 关键性图谱（P-ra-4 位级必需 = CRITICAL；只写不读 = INERT，仍播种）

**CRITICAL（决策驱动，位级必种）**：
- origin/velocity/yaw/pitch/on_ground —— 常规态
- **ground_normal**（含离地陈旧值）—— 读点 :907：`no_prestrafe && ground_normal[1] > 0.999` 钳制分支；空中陈旧值入判定 ✓ §11.1「下游可读」证实
- **ducked / duck_frac** —— :1051 空中/落地即时置位 vs 地面渐变分支读取
- **ground_ticks_since_landing** —— 读 :909（`>0` 摩擦分支）、:1051；写 :823/:1032
- **contact_ticks** —— 传送 check 的 grounded 判定（:193 经 mod.rs:241 传参）；写 :807/:830
- **surfing** —— step_core :246 传入 check，:190 `surfing → return None`（传送短路）
- **ladder_cooldown** —— 读 :606（ladder_move 段）、:1018-1019（每 tick 递减）；写 :641（=0.25）
- **blocked_ticks** —— :883-888 `>=6 → velocity 清零`；中段计数（1-5）决定未来清零 tick
- **old_jump** —— 见上（跨边界跳沿）

**INERT（只写不读 / tick 起点重推导；仍按全量表播种）**：
- stuck_ticks（:852/864/869 全为写）、fall_velocity（:631/827/1034 全为写；:1034 air 分支赋 -vy 无人读）
- landing_velocity（:825 落地快照，:824 注释明示「perf.enabled=false 时不消费，保留语义」）
- has_jumped_before（:563 写 true，无读点）、surfed_since_grounded（:951/:564 写，无读点）
- land_punch（Rust 内仅 :1043 指数衰减；不出 state_js）
- prev_origin（player_tick :1010 tick 起点无条件重赋 → 永不跨边界被消费；detect_blocked_move :877-879 读到的是本 tick 起点重赋值）
- prev_speed（:1011 写，无读点——§11.1「诊断位，建议含」）
- input 十键（tick 边界种子后即被 apply_input 掩码重推导；mid-tick 窗语义由重放掩码承载）
- stand/duck mins/maxs（apply_hull 派生；同参构建下恒等，播种为完整性）

**PhysWorld 面排除项复核**：world（构建期不可变；cells HashMap world.rs:447 为空间哈希，tick 路径按键查询无全图迭代——同输入构建逐位同构，cross-instance 等价成立）/params/spawn/spawn_points/death_y/noclip/ready/state_out（输出缓冲）——§11.1 排除面全部成立；GATE_VETO_COUNT（world.rs:117 静态原子，仅 :209/:226 计数递增，无判定读点）物理中性确认。

## 3. state_out B5 十字段 additive 布局提案（t6:145 ↔ bench M4 P2）——**captain 批复：22 字段方案批准**

现状：`state_out: [f64; 8]`（mod.rs:74），tick_into :179-194 写 pos×3/vel×3/yaw/pitch。
扩展（**append-only，0-7 不动，JS 既有 8 槽视图零回归**）：

| idx | 字段 | 备注 |
|---|---|---|
| 8 | ducked (0/1) | B5① |
| 9 | duck_frac | B5② |
| 10 | ground_ticks_since_landing | B5③ |
| 11 | contact_ticks | B5④ |
| 12 | surfing (0/1) | B5⑤ |
| 13 | blocked_ticks | B5⑥ |
| 14 | on_ladder（索引或 -1） | B5⑦ |
| 15 | fall_velocity | B5⑧ |
| 16-18 | landing_velocity×3 | B5⑨ |
| 19 | has_jumped_before (0/1) | B5⑩ |
| 20 | eye_height | bench M4 P2 点名（state_js 派生值对齐） |
| 21 | on_ground (0/1) | 消费端弦插值/lede 判定刚需（现 8 槽缺位） |

合计 [f64; 22]（**已批准**）。B5 之外两项（eye_height/on_ground）为 bench P2「eyeHeight+flags 槽位」与消费端刚需
的显式纳入。I_A_SEG/I_A_TICK 槽位归 t2（SAB 协议面），不进本缓冲。

## 4. 种子/导出面 API 设计草案（Rust additive，待 t1 事实表修正后定稿）——**captain 批准；零分配变体延后（等 bench M4④ 升级规则触发，不进首版）**

- **对称对**：`state_full() -> JsValue`（权威全量导出）+ `seed_full(json) -> Result<(), JsValue>`（scratch 单向写入）。
  同一 serde schema（版本号字段 `v`）；f64 经 serde_json 往返位级精确（ryu 最短表示性质），
  phys-smoke 加往返恒等断言直接验证。
- **schema 草案**：`{v, player:{origin[3],velocity[3],yaw,pitch,on_ground,ground_normal[3],ducked,duck_frac,
  on_ladder:usize|null,surfing,surfed_since_grounded,land_punch,old_jump,ladder_cooldown,fall_velocity,
  ground_ticks_since_landing,contact_ticks,has_jumped_before,landing_velocity[3],stuck_ticks,blocked_ticks,
  input:{forward,back,left,right,jump,duck,walk,reset,yaw_left,yaw_right},stand_mins[3],stand_maxs[3],
  duck_mins[3],duck_maxs[3],prev_origin[3],prev_speed},
  teleport:{cooldown, triggers_inside:[bool; N]}, event:{kind:none|teleport|death, origin[3], yaw}}`
- 未知字段容错：serde `#[serde(default)]` + 新字段 append-only → t4/t5 集成期版本兼容。
- **零分配路线备选**（若 bench M4④ 剖面触发升级规则）：seed_in 定长缓冲 + `seed_apply()`（镜像 A5
  state_out_ptr 先例 mod.rs:179-200）；变长 triggers_inside/event 单列小 API。首版走 JSON（种子频率
  =权威 tick 率 64Hz，worker 内部通道，非 SAB 发布面，不在 P0 零分配门法域）。
- **禁改承诺**：`set_state`/`tick`/`tick_into`/`predict`/`step_core`/`player_tick`/teleport 语义逐行不动；
  全部新 API 纯 additive。

## 5. wasm 重建管线 + hash pin（t6:146 确定性定理的台侧落点）

- 现管线：`npm run build:wasm` = `cd crates/wasm && wasm-pack build --release --target web --out-dir ../../pkg`
  + 拷贝 `pkg/websurf_wasm_bg.wasm → web/websurf_wasm_bg.wasm`（game/package.json:8）。
- **hash pin 缺位确认**：全仓无 wasm 产物哈希 pin 机制（grep 无果）——t3 新建：
  `game/temp/wasm-hash-pin.mjs`（sha256 pkg 产物 → 回写 `game/temp/wasm-hash-pin.json`
  + build 后校验双端拷贝一致；落 game/temp/ = 匹配器兼容区）。
- 契约清单同步：`game/scripts/check-wasm-api.mjs` PHYS_API 追加新 API（state_full/seed_full）——
  该文件改动进 output 清单（非匹配器兼容区）。
- 回归纪律：每次 Rust 改动后 `npm run test:phys`（phys-smoke.mjs 先例，node 直载）+ 新增
  seed-face 专项回归（跳沿/冷却 armed/blocked 中段计数/传送触发四类，对齐 t1 的 s1-s4 状态类），
  脚本落 `game/temp/` 直接子项（如 `game/temp/phys-seed-smoke.mjs`）。
- **完成态提交 convention（captain 指令）**：匹配器 `**`=单段（无 globstar）、嵌套路径全拒、运行中
  inScope 不可修 → changedPaths 只填匹配器兼容子集（`web/websurf_wasm_bg.wasm`、
  `web/websurf_wasm.d.ts`、`web/websurf_wasm.js` 三字面量 + `game/temp/` 直接子项脚本）；
  **src/phys 全量改动清单写进 output 文本**（gatekeeper 按 output 清单+磁盘实态验签）；
  commandsRun 全 evidence（cargo build / phys-smoke / wasm 重建 + hash pin 验证）。
  - 磁盘实态（已核）：`game/web/` 仅含 `websurf_wasm_bg.wasm`（拷贝目标）；`websurf_wasm.d.ts`
    /`websurf_wasm.js` 仅在 `game/pkg/`（wasm-pack 直出）——output 清单按实态列
    `game/pkg/{websurf_wasm.js,websurf_wasm.d.ts,websurf_wasm_bg.wasm,websurf_wasm_bg.wasm.d.ts}`
    + `game/web/websurf_wasm_bg.wasm`。
- 工具链就绪：cargo 1.97.1 / wasm-pack 0.13.1 / node 25.8.0 实测在位。

## 6. 对 t1 事实表逐条对账（v1 完成，plan/field-fidelity.md，22 相位 / rig 自检 22/22）

**种子面 v2 定案（事实表 §6 建议 + 本对账收编）**：
- **行为级活性缺口 MUST 增补（4 项，实证量化）**：`ground_normal`(3×f64，:907 nopre 钳制唯一消费点，
  坡面带速种子单 tick 掉沿坡速 19-21% 持续发散；因果定案=no_prestrafe=false 后 B′≡C 全等) /
  `contact_ticks`(u32，teleport B 路径 grounded 门，fresh=0 恰晚 1 tick) / `ducked`(bool) +
  `duck_frac`(f64，不可播种缺口，~6.4 tick 重蹲延迟 + hull 语义分歧窗)。
- **9 基础字段不动**：s1/s2/s3/s4 全域 EXACT 实证（平地滑行/60° surf/跳跃边沿/空中/预传送/传送后位置态）。
- **schema 仍按 t6 §11.1 全量表**（全字段入 seed，含惰性位——1 槽成本换未来语义保护；惰性位逐条注记
  事实表证据）。**event 槽不入种子面**（事实表 §5 设计级裁定：F4-C scratch 自排空、authority pending
  事件走 authority 通道——证伪我草案中的 event 播种项）；`state_full()` 导出面与 seed schema 对称（无 event）。
- 命名遵 bench 建议：`set_state_ex(json)`（不破坏 9 参 set_state 签名，三模共存兼容）+ `state_full()`。

**对账明细（我的图谱 → 事实表）**：

| 字段 | 我方预判 | 事实表 | 对账结论 |
|---|---|---|---|
| ground_normal | CRITICAL(:907) | §3.1 物理承重 | **证实**（量化+因果双验证） |
| ducked/duck_frac | CRITICAL(:1051) | §3.3 物理承重 | **证实**（hull 分歧窗+无输入绕过证明） |
| contact_ticks | CRITICAL(:193 传送门) | §3.2 物理承重 | **证实**（B 路径晚 1 tick；state_js 已导出 diff 通道现成） |
| teleport.cooldown | CRITICAL(:185-188) | §4 自 erase 死位 | **证伪**——我静态读点分析漏了不变量：check 置 0.5 → 同 step 内 apply_teleport reset(:524)+fire 后再 reset(:257) 归零，armed 态永不跨 tick 存活（s4b 链式连传实证）；「0.5s 防重复」注释陈旧。仍入 schema，注记死位 |
| old_jump | CRITICAL(:544/:635) | §4 条件死位 | **条件性证伪**——默认 autobhop=true 短路 :544（s3 jump-edge EXACT）；autobhop=false（面板可设）时 :544 恢复活性。入 schema，注记条件性活位 |
| ground_ticks_since_landing | CRITICAL(:909/:1051) | §4 实测域无行为分歧 | **降级**——读点存在但「两侧自 tick1 起 >0 → 分支同向」，s1/s3 位级一致。入 schema，注记条件性 |
| surfing | CRITICAL(:190 传送门) | §2 s2 EXACT | **部分证实**——语义澄清：:392 每 tick 入口重置+:455 几何重推导=派生态，跨 tick 仅 :246 传送门读前值；触发器邻近 surf 态=与 s4b 同构风险。入 schema |
| blocked_ticks/stuck_ticks | CRITICAL(:885)/INERT | §4 **未探测** | **维持**——卡体中态种子未验证（:885 ≥6 清零静态读点在）；schema 当日即含，建议 bench 后补卡体类 |
| ladder_cooldown/on_ladder | CRITICAL(:606/:1018)/播种 | 未出现（s1-s5 无梯子类） | **未探测**——静态读点在，入 schema，注记待探测 |
| has_jumped_before/surfed_since_grounded/fall_velocity/landing_velocity/land_punch | INERT | §4 死位 | **证实** |
| prev_origin/prev_speed | INERT(:1010 重赋) | §4 证实 | **证实**（set_state:342 强制+player_tick:1010 重赋双保险） |
| input 十键 | INERT(掩码重推导) | 9 字段全域 EXACT 隐证 | **证实** |
| triggers[].inside | INERT(只写) | §4 仅复位 | **证实** |
| teleport_gate_ticks | 不存在(形参弃用) | §4 「≥3 帧」未接线 | **证实** |
| event 槽 | 输出-only（草案曾入种子） | §5 设计级不入种子 | **证伪我方草案项**，遵 §5 |

**附注（事实表 §6 收敛护栏，t4/t5 参考）**：起跳 275 钳（无条件）与平地落地 nopre 250 钳把种子误差收敛到
同一 cap——平地误差不跨落地累积；发散只在坡面着地连续段内增长。rig 层 22/22 裸快照自检 → F4-C 重推导
机制可行性直接可用。

---

## 7. t3 实现记录（v1 落地，2026-09-10）

**新 wasm 指纹**：sha256 `ee4c1ab317a100b449ab7fc9b5c597e1bb6855efbdd8fde38f1a24c85cc14690`（3710792B；
t1 基线 a60371ee…db6b9 已废弃）；双端拷贝（game/pkg + game/web）一致；pin 落盘 `game/temp/wasm-hash-pin.json`。

**改动全清单（Rust 只增不改纪律逐项自证）**：
- `src/phys/seed.rs`（新文件，~330 行）：SeedState/SeedInput/SeedEvent schema（v=2）+ extract_seed/apply_seed
  单一通路；校验前置（v 错/triggers 长度/on_ladder 越界 → Err 且实例零改动）；event 默认 None（t1 §5）。
- `src/phys/mod.rs`（纯 additive）：`mod seed;`、state_out `[f64;8]→[f64;22]`（批准 22 布局）、
  tick_into 追加 `fill_state_out(p, o)` 一行、三新 wasm-bindgen API（set_state_ex / state_full_json /
  seed_from）、fill_state_out 私有 fn（槽 8-21 布局唯一真源）。
- `src/phys/teleport.rs`（纯 additive 4 访问器）：seed_cooldown / cooldown_value / seed_trigger_inside /
  trigger_inside_vec。
- `src/Cargo.toml`（一行）：serde_json += `float_roundtrip`——**t3 实测发现并修复**：serde_json 默认
  fast parser 非「正确舍入」，部分 f64 往返偏 1 ULP（复现 origin[2]=10.478655362066775 → 播种后 …776）；
  feature 启用后 parse↔print 位级往返保证——种子面位级契约的前提。既有物理源码零改动。
- `game/scripts/check-wasm-api.mjs`：PHYS_API 17→20（新三 API 入契约）。
- `game/temp/phys-seed-smoke.mjs`（新回归，7 组）：A 双通道位级全等（set_state_ex+seed_from，30 tick
  混合输入）/ B ground_normal 闭环+9 参负对照发散（h=660 坡带速，bench s3c 复刻）/ C contact_ticks
  同 tick 事件+负对照晚 1 tick（埋地 trigger，bench s4b 复刻）/ D ducked/duck_frac 半蹲闭环+负对照
  （bench s5 复刻）/ E old_jump 条件活位（autobhop=false 持跳，负对照重跳发散）/ F state_out 22 槽
  逐槽语义+种子面预填 / G 防御 4 项 FAIL LOUD。
- `game/temp/wasm-hash-pin.mjs` + `wasm-hash-pin.json`（pin 工具+产物）。

**验证记录**：cargo build --release（host）exit 0；npm run build:wasm exit 0；check-wasm-api
16+20 全过；phys-smoke（既有 10 段）全过；phys-seed-smoke 7/7；**field-discovery 复跑于新 wasm：
22 样本结果与 t1 事实表逐项一致（rig 22/22、8 EXACT/14 DIVERGE、9 物理承重）——新 wasm 物理输出与
t1 基线 wasm 全同，「逐行不动」最强证据**。

**t4 集成约定**：权威每 tick 边界 → `scratch.seed_from(&authority)`（零序列化，热路径推荐）或
`scratch.set_state_ex(authority.state_full_json(false))`（schema 可审计通道；include_event 必须 false
=t1 §5）；scratch 乐观 tick 用 tick_into（22 槽直读）；事件 scratch 自排空丢弃、权威真步走既有
take_event 通道。9 参 set_state 路径（coupled/decoupled 双模）零改动零回归（phys-smoke + bench 复跑双证）。

**t4 事件面补充（bench v2 仪器发现的工作侧推论，2026-09-10）**：seed 边界必须保证权威 pending 事件
已消费（worker 主循环每 tick take_event 即天然满足；若无消费路径须显式 drain）——否则种子面（空队列）
与权威（pending 未消费）事件面在窗口 t0 错位，正是 bench v2 初跑 18/22 伪分歧的仪器侧同构（driveTo
相位边界未排空 → C 窗首 tick 取到上相位遗留 teleport）。修后 bench v2 正式表 **22/22 EXACT、0 物理
承重分歧**——P-ra-4「seeded-mirror tick ≡ authority tick」位级全等获仪器级实证，种子面 v2 主案成立。
