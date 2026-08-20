# P2 坡顶幻影碰撞 —— 任务状态（2026-08-20 更新：结论收敛）

> 状态：**P2 幻影碰撞已根治并实证**。早期"第二层幻影（悬停滑行端盖擦碰）"假设
> **已被实证否定**——残余发散是**地面物理的固有速率依赖**（nopre 钳制 + 摩擦 +
> 坡面掠触的敏感分叉），非碰撞幻影。本文档为最终记录与复现指引。

## 1. 结论摘要

- **chamfer（切角）不是 P2 根治手段**（早前 wasm 实测：2242.1→14.9 仍不达标、多配置劣化）。
- **根治手段 = 盒-AABB 必要校验**，落地于 `src/phys/world.rs::clip_planes`，共三处：
  1. **进入平面门**（:196-210）：每个「进入」事件在**真实接触分数 `f_true=d1/(d1-d2)`**
     处检查盒 AABB 与该实体 AABB 三轴重叠，分离即否决该平面（幻影端盖/前缘）；
  2. **start_solid 门**（:220-233）：起点"在体内"判定同样做 AABB 必要校验，AABB 分离
     即跳过（否则下一 tick all_solid 整速清零钉住盒——P2 实际阻断机制）；
  3. **EPS 收紧**：`aabb_overlaps_at` EPS 从 `2*DIST_EPSILON` 改为 `DIST_EPSILON/8`
     （f_true 处合法接触盒表面恰贴平面，无需吸收 Minkowski 悬停间隙）。
- 诊断探针（保留）：`GATE_VETO_COUNT` 静态计数 + `PhysWorld::gate_veto_count()` /
  `debug_trace()`。

## 2. P2 真实阻断机制（wasm 实测）

盒（stand hull，脚底锚定）在 64Hz H=2.5/vz=300 场景：
1. tick1 被 `categorize_position` 的 GROUND_TRACE_DIST=2 下探吸附到平台顶 y≈0.03，vy 清零；
2. tick2 `walk_move` nopre 地面钳制 300→250（无输入时速度 > run_speed=250 → 缩到 250）；
3. tick3+ `apply_friction`（friction=4）逐 tick ×(1−4·dt)——**滑行段减速 15.6/14.6/13.7… 全为摩擦**；
4. 盒前端（z_max）穿越平台前缘/坡 z=0 端盖——被进入门否决（y 分离），无速度变化；
5. **原阻断**（修复前）：盒前缘刺入坡 z≥0 半空间 → 下一 tick 全平面判定体内 →
   start_solid/all_solid → `try_player_move`（player.rs:407-410）整速清零 → 钉在 z≈−15.94。
   （修复前基线 2242.1/2421.6；修正后盒飞过。）

## 3. 已完成验证

| 验证 | 结果 |
|---|---|
| Rust 单测 `src/phys/p2_gate_tests.rs`（3 例） | 3/3 PASS |
| `phys-gate-probe2.mjs`（仅 ramp，64Hz H=2.5/vz=300） | PASS：盒飞过坡，gate_veto_count=14 |
| `phys-p2-ground.mjs`（H=2.1/vz=300 全程 200 tick 逐 tick） | 摩擦序列与 nopre+摩擦公式**逐值吻合**；无幻影 clip |
| Python `verify_box_aabb_necessary_check.py`（S1 幻影否决/S2 合法保留/S3 perplane≡whole） | 3/3 PASS（几何已修正为 P2 真实 y 分离端盖） |
| 基线 2242.1/2421.6 空中停驻 | 消失 |

## 4. 残余 H×vz 矩阵发散（9/12）—— 固有速率依赖，非幻影

`phys-p2-regression.mjs`（64Hz vs 144Hz 终速差 Δvel<10 判定）FAIL 9/12
（CONVERGED 仅 H=2.1/vz=500、H=4/vz=500、H=4/vz=800）。

**实证根因（phys-p2-ground.mjs 全程打点）**：
- 所有 H≤4 配置盒都会先在平台顶落地（GROUND_TRACE_DIST=2 吸附 / 自然下落），随后
  nopre 钳制 + 逐 tick 摩擦滑行到平台前缘——64Hz 与 144Hz 的落地 tick 与摩擦累计
  不同 → 离缘速度不同（64Hz vz≈88.7 vs 144Hz vz≈82.0）；
- 离缘后盒在坡面发生**真实掠触**：64Hz 单次擦触后飞越整坡；144Hz 自首触起持续 surf
  下滑——掠触角度的敏感分叉；
- 这两类差异都是离散固定步长物理的**固有**速率依赖（摩擦 ×(1−f·dt)、边缘掠触对步长
  敏感），与碰撞幻影无关。门对坡面/平台前缘的幻影进入已全部正确否决
  （gate_veto_count>0 且摩擦序列无碰撞干扰）。
- 发散判定 64Hz/144Hz 终速：H=2.1/vz=300 → (10.3, 3.2)≈10.8 ✓ 与矩阵一致。

**结论**：门修复针对的是**碰撞幻影**（z=0 无限平面过逼近），该目标已达成并验证。
H×vz 矩阵发散反映的是场景设计内生的地面滑行/掠触速率依赖，**不属于 P2 幻影修复范围**；
若需 12/12 收敛，须重新设计场景（让盒全程空中飞越、不落平台），或接受该固有发散。

## 5. 待办 / 建议（如需继续）

1. （可选）把回归场景改为"空中飞越"型（如 spawn 高度使盒不落平台、不掠触），
   使 Δvel 只度量幻影修复本身；当前 `phys-p2-regression.mjs` 保留为地面物理参考矩阵。
2. 文档同步：`chamfer-bevel-analysis.md §9.5` 已补 wasm 裁决；本文件为最终状态。
3. Python 脚本已修正 S1 几何（旧 cap-vs-AABB 不一致构造删除），并同步为当前 Rust 镜像
   （EPS=DIST_EPSILON/8、f_true 调用点、start_solid 门）。

## 6. 复现/验证命令（Windows PowerShell）

```powershell
# Rust 单测（workspace root 在 src/）
cd src; cargo test -p websurf-phys --lib p2_gate
# Python 算法镜像（S1/S2/S3）
cd docs/chamfer-physics; python verify_box_aabb_necessary_check.py
# wasm 重建 + 探针
cd game; npm run build:wasm
node scripts/phys-gate-probe2.mjs        # 幻影修复 PASS（飞过坡）
node scripts/phys-p2-ground.mjs          # 全程打点（摩擦序列实证，非幻影）
node scripts/phys-p2-regression.mjs      # H×vz 矩阵（残余=地面物理速率依赖）
```

## 7. 关键事实/数字备忘

- hull：stand_mins=[-16,0,-16] maxs=[16,72,16]（脚底锚定）；DIST_EPSILON=0.03125；
  GROUND_TRACE_DIST=2；STEP_HEIGHT=18；PUSH_OUT=0.1；run_speed=250；friction=4；
  no_prestrafe=true；STANDABLE_NORMAL=0.7。
- 场景：flatTop(0,0,2000)（y∈[-2000,0], z∈[-4000,0]）+ rampDown(0,1500,3000)
  （60° 坡，表面 y=-1.732z，端盖 z=0 平面 (0,0,-1)，无 +y 顶面，AABB y∈[-3000,0] z∈[0,1500]）。
- spawn (0,H,-30)，H∈{2.1,2.5,3,4}，vz∈{300,500,800}；64Hz/144Hz，200/450 tick（3.125s）。
- 判定：Δvel<10；首碰=|速度变化-纯重力|>3 的首个 tick（64Hz 首碰实为 nopre 钳制 −50）。

## 8. 本次改动文件清单

| 文件 | 改动 |
|---|---|
| `src/phys/world.rs` | clip_planes 三处门 + GATE_VETO_COUNT |
| `src/phys/mod.rs` | gate_veto_count() / debug_trace() 诊断方法 |
| `src/phys/p2_gate_tests.rs` | 3 单测 |
| `game/scripts/phys-gate-probe2.mjs` | 幻影修复探针（ramp-only） |
| `game/scripts/phys-p2-ground.mjs` | 全程打点实证（新增） |
| `game/scripts/phys-p2-regression.mjs` | H×vz 矩阵（地面物理参考） |
| `docs/chamfer-physics/verify_box_aabb_necessary_check.py` | 修正 S1 几何 + 同步 Rust 镜像 |
| `docs/chamfer-physics/chamfer-bevel-analysis.md` | §9.5 wasm 裁决更新 |