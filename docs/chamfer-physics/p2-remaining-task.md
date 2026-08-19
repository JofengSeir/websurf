# P2 坡顶幻影碰撞 —— 当前进度与未完成任务（2026-08-19 收尾记录）

> 状态：**核心修复已落地并验证（Rust 单测 3/3 + wasm 探针 PASS）**；回归矩阵仍有 9/12 发散，
> 第二层机制已定位到「地面吸附滑行 + EPS 悬停间隙」但 −50 vz clip 的确切来源未最后确认。
> 本文档记录全部进展，供后续继续。

## 1. 结论摘要

- **chamfer（切角）不是 P2 根治手段**（早前已用真实 wasm 验证：修正平面后 2242.1→14.9 仍不达标、多配置劣化）。P2 的正确修复方向是**盒-AABB 必要校验**（无限平面过逼近的否决）。
- 修复在 `src/phys/world.rs::clip_planes` 落地，共三处：
  1. **进入平面门**（:197 附近）：每个「进入」事件在**真实接触分数 `f_true = d1/(d1-d2)`** 处检查盒 AABB 与该实体 AABB 三轴重叠，分离即否决该平面（幻影端盖/前缘）；
  2. **start_solid 门**：平面判定「起点在体内」同样做 AABB 必要校验，AABB 分离即跳过该 brush（否则下一 tick all_solid 会把盒整速清零钉住——P2 实际阻断机制）；
  3. **EPS 收紧**：`aabb_overlaps_at` 的 EPS 从 `2*DIST_EPSILON` 改为 `DIST_EPSILON/8`（f_true 处合法接触盒表面恰贴平面 lo≈0，不再需要吸收 Minkowski 悬停间隙）。
- 诊断探针（保留）：`GATE_VETO_COUNT` 静态计数（world.rs）+ `PhysWorld::gate_veto_count()` / `debug_trace()`（mod.rs）。

## 2. 已完成的验证

- **Rust 单测** `src/phys/p2_gate_tests.rs`（3/3 PASS，`cargo test -p websurf-phys --lib`，workdir `src/`）：
  - `p2_endcap_phantom_vetoed`：阻断 tick（64Hz H=2.5/vz=300，start=(0,2.109,−20.625)→end=(0,1.621,−15.938)，stand hull）→ fraction=1.0（否决）；
  - `p2_start_solid_phantom_vetoed`：下一 tick 起点（z_max=0.0625 刺入 z≥0 半空间、y 分离 1.6u）→ 非 solid、fraction=1.0；
  - `p2_surface_landing_kept`：合法表面接触（盒从坡面上方降入表面半空间）→ fraction<1.0（保留）。
- **wasm 探针**（`npm run build:wasm` 后）：
  - `game/scripts/phys-gate-probe2.mjs`：仅 ramp brush + 64Hz H=2.5/vz=300 → **PASS**（盒飞过坡，gate_veto_count=14；修复前 STOPPED 于 z=−15.94）；
  - `game/scripts/phys-p2-trace.mjs`：平台+坡 H=2.1/vz=300 逐 tick（定位第二层机制用）。
- 基线 2242.1/2421.6 的**空中停驻已消失**（不再有 mid-air 端盖整速清零）。

## 3. 剩余问题（9/12 发散，Δvel 10~48）

`game/scripts/phys-p2-regression.mjs`（H×vz 矩阵，Δvel<10 判定）当前 FAIL 9/12；CONVERGED 仅
H=2.1/vz=500、H=4/vz=500、H=4/vz=800。

**第二层机制（已定位但未修完）**：H=2.1/2.5/3 各线落地后（categorize_position 的 GROUND_TRACE_DIST=2
下探使盒在首个 tick 吸附到平台顶 y=0.03，vy 清零），盒**沿平台顶悬停滑行**（y=0.03 = EPS 悬停间隙），
vz 被逐 tick 削减：300→250→234.4→219.7→206→193.1→181→169.7→159.1→149.2…（每次 −50/−15.6/−14.6/
−13.7/−12.9/−12.1/−11.3/−10.6/−9.9）。z 前移同步衰减，盒在坡前缘附近被「摩擦」减速，64Hz 与 144Hz
减速步进不同 → Δvel。

**待查明**：
1. **−50 首次 clip 的来源**（t2，|dv|=50.0，vz 300→250，盒前端 z_max=−5.4 尚未达 z=0，平台/坡均无平面事件）——嫌疑：wedge/crease 滑动逻辑（try_player_move :423-438 的 crease 投影，`cross(n, wedge_plane)` 沿交线投影，n 可能来自 ramp 表面平面）、或 categorize 的地面投影（:815-821 仅 ground_dot<0 时投影，vy=0 时 dot=0 不触发，需复核）、或 player_tick 地面移动顺序（:1009-1058 未读完——重力/移动/分类顺序与速度来源）；
2. 后续 15.6/14.6/… 的逐 tick 削减是否同为 wedge/crease（平台顶 (0,1,0) × 坡端盖 (0,0,−1) 交线沿 x，投影应把 vz 清零而非 0.83 倍——与观测不符，需用 debug_trace 逐 tick 打 trace 结果核实）；
3. 悬停间隙与「真实接触」的 EPS 取舍是否还有更优解（当前 f_true + EPS/8 已让 2242 类发散消失，但 H=2.1/2.5/3 的滑行摩擦仍是 phantasm）。

**建议下一步**（按序）：
1. 读完 `player.rs:1009-1058`（player_tick 顺序）与 `:870-960`（walk_move/地面移动/摩擦），确认地面滑行的速度来源；
2. 在 p2-trace 探针中逐 tick 调 `debug_trace`（本次会话新增 API）打印 fraction/normal，锁定每次 −50/−15.6 clip 的法线；
3. 若确为 wedge/crease：调整 try_player_move 的 crease 投影条件（仅当两平面法线皆真实接触时投影），或对「悬停间隙接触」不启用 crease；
4. 修完后续跑 `phys-p2-regression.mjs` 至 12/12 PASS，再更新 `docs/chamfer-physics/chamfer-bevel-analysis.md §9`（当前文档的等价性证明有缺陷：axis-separated 必已离开 brush 的说法被 P2 幻影本身推翻；wasm 裁决待更新）与 `verify_box_aabb_necessary_check.py`（S1 构造有误：cap 平面与 AABB 不一致，是真实相交而非纯幻影）。

## 4. 本次会话改动文件清单

| 文件 | 改动 |
|---|---|
| `src/phys/world.rs` | clip_planes 三处门 + `GATE_VETO_COUNT` 计数 |
| `src/phys/mod.rs` | `gate_veto_count()` / `debug_trace()` 诊断方法 |
| `src/phys/p2_gate_tests.rs` | 新增 3 个单测（mod.rs `#[cfg(test)] mod p2_gate_tests;`） |
| `game/scripts/phys-gate-probe2.mjs` | 新增：wasm 门校验探针（ramp-only，64Hz） |
| `game/scripts/phys-p2-trace.mjs` | 新增：H=2.1/vz=300 逐 tick 探针 |
| `game/scripts/phys-p2-regression.mjs` | 新增：H×vz 矩阵回归（12 配置，Δvel<10） |

`phys-gate-probe.mjs`（早前 S1 构造无效的探针）建议删除或重写后再用。

## 5. 复现/验证命令（Windows PowerShell）

```powershell
# Rust 单测（workspace root 在 src/）
cd src; cargo test -p websurf-phys --lib p2_gate
# wasm 重建 + 探针 + 矩阵
cd game; npm run build:wasm; node scripts/phys-gate-probe2.mjs; node scripts/phys-p2-regression.mjs
```

## 6. 关键事实/数字备忘

- hull：stand_mins=[-16,0,-16] maxs=[16,72,16]（脚底锚定，yaw 不旋转）；DIST_EPSILON=0.03125；GROUND_TRACE_DIST=2；
- 场景：flatTop(0,0,2000)（y∈[-2000,0], z∈[-4000,0]）+ rampDown(0,1500,3000)（60° 坡，表面 y=-1.732z，端盖 z=0 平面 (0,0,-1) d=0，AABB y∈[-3000,0] z∈[0,1500]）；
- spawn (0,H,-30)，H∈{2.1,2.5,3,4}，vz∈{300,500,800}，64Hz vs 144Hz，200 vs 450 tick（同为 3.125s）；
- P2 阻断原机制（已修复）：盒 z_max 刺入坡 z≥0 半空间 → 下一 tick 平面判定 all_solid → try_player_move :407-410 整速清零 → 钉在 z≈-15.94；
- 修复前基线：H=2.5/vz=300 → 2242.1、H=4/vz=500 → 2421.6（phys-fix-directions.md:44）；
- 144Hz 线修复前行为：盒先落平台顶再入坡（t≈0.0278 y=0.03）。