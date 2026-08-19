# 倒角（Chamfer / Bevel）物理效果代码分析

> 落档日期：2026-08-19
> 分析范围：`/src` 物理碰撞与 BSP 解析，以及与导出层（`debug/`、`game/` 的 `crates/wasm/src/lib.rs`）的衔接
> 关联文档：`docs/phys-fix-directions.md`（P2 坡顶入坡幻影碰撞）

> ⚠️ **实测修正（2026-08-19，wasm 实跑）**：本文 §1/§6 原称"导出层 chamfer 是 P2 坡顶幻影碰撞的根治手段"，已被真实引擎验证**否定**。
> - **Test A 凸角剐蹭带**：引擎碰撞盒轴对齐、yaw 不旋转（`player.rs:959-964`），Python 模型"45°→h√2 剐蹭带"前提在引擎中不存在；`±chamfer × yaw 0/45` 四种配置在 band d=19 全部 PASS，chamfer 对该场景无影响。
> - **Test B P2 坡顶幻影**：无 chamfer 精确复现文档基线（H=2.5/vz=300→2242.1、H=4/vz=500→2421.6）；注入正确 chamfer 平面后旗舰用例降至 14.9 但未达 Δvel<10，且其他配置反而劣化。**chamfer 不是 P2 根治手段。**
> - **正确方向（据 §9 质疑分析更新）**：P2 的首要修复是 `src/phys/world.rs::clip_planes` 的**逐进入平面「盒-AABB 必要校验」**（命中处盒 AABB vs brush AABB 三轴重叠，根除 axis-separated 幻影类，与几何参数无关）；轴向 bevel 降级为可选平滑层；端盖容差是其特例。导出层 chamfer 仅是"凸棱平滑"措施，与 P2 解耦。详见 §8、§9。

## 1. 结论速览

**`/src` 目录本身不含任何独立的 chamfer（倒角）物理逻辑。** chamfer/bevel 的真实处理发生在**导出层**（`debug/`、`game/` 的 `crates/wasm/src/lib.rs`），`/src` 仅把导出好的平面"无感知"地吃进碰撞世界（`build_world`）。

注意：`docs/phys-fix-directions.md` P2 项所说的"轴向 bevel 平面生成"指向 `src/phys/world.rs`（`add_axial_bevels(&mut Brush)`），与本文所述的**导出层运行时 chamfer 是两回事**。导出层 chamfer 仅用来自平滑 brush 凸棱（替代被遗弃的 BSP 高悬 bevel）。**该 chamfer 并非 P2 坡顶幻影碰撞的根治手段**——此结论已被 wasm 实跑否定（见 §8）。

| 维度 | 事实 |
|------|------|
| chamfer 生成位置 | 导出层 `crates/wasm/src/lib.rs`（debug / game 一致；test 工程无此逻辑） |
| BSP 自带 bevel 处理 | 导出层**主动剔除** `side.bevel != 0` 的面 |
| `/src` 角色 | 解析 BSP 数据 + 无条件吃入全部平面做碰撞，无 bevel/chamfer 过滤 |
| 数据流 | BSP → 导出层(剔除 bevel + 注入 chamfer) → brush JSON(Y-up、法线朝外) → `build_world` |
| 与 P2 的关系 | **无关**：chamfer 是凸棱平滑；P2 首要修复为 `src/phys/world.rs` **盒-AABB 必要校验**（见 §9），轴向 bevel 仅作可选平滑层 |

---

## 2. `/src` 内与 chamfer 相关的代码（仅数据管道，无逻辑）

| 位置 | 内容 | 角色 |
|------|------|------|
| `src/wasm-core/vbsp/data/mod.rs:320-326` | `BrushSide { plane, texture_info, displacement_info, bevel: i16 }` | BSP 数据结构定义，含 `bevel` 标志位 |
| `src/wasm-core/vbsp/mod.rs:308` | `brush_sides` 被解析进 `BspFile` | **解析后即在 /src 内不再被读取**（无碰撞消费代码） |
| `src/phys/mod.rs:100-134` | `build_world` 遍历 brush JSON，**全平面无条件**加入 `World.solids`/`ladders` | 无 bevel/chamfer 过滤 |
| `src/phys/world.rs:118-183` / `186-195` | `clip_planes` / `clip_box_to_brush` | 标准平面裁剪碰撞，chamfer 平面走同一路径 |

证据：`bevel` 在 `/src` 中**仅作为字段存在**（`data/mod.rs:325`）；`brush_sides` 在 `src/wasm-core` 仅被解析（`mod.rs:308`），**无任何消费代码**。导出层的 brush 碰撞 JSON 由 `crates/wasm/src/lib.rs` 生成，而非 `/src`。

---

## 3. chamfer 物理效果的真正实现位置（导出层）

### 3.1 BSP bevel 面被主动丢弃（debug `crates/wasm/src/lib.rs:1902`（`collect_planes_and_flags`）与 `2459`（`export_brushes_planes`）两处；game 仅在 `1856` 一处）

```rust
// 【遗弃 BSP 自带 bevel】Source 编译时生成的 bevel 平面常为"高悬于
// 坡顶/凸棱之上、斜率远缓于原始面"的假想扩张面；在本引擎的
// box-Minkowski 点扫掠模型里，直接用它们做碰撞会让"坡顶永远打滑"
// 或产生穿模。因此这里**剔除 side.bevel 标记的面**，只保留真实
// brush 面；棱边平滑改由运行时按 AddEdgeBevels 生成的 chamfer 承担。
if side.bevel != 0 {
    continue;
}
```

说明：Source 编译阶段生成的 bevel 平面是沿 brush 凸棱外扩的假想扩张面。在 WebSurf 的「盒-Minkowski 点扫掠」碰撞模型里，直接用这些面会让高速盒角在坡顶被异常顶起（打滑）或穿模。因此导出时剔除它们，改由运行时生成的 chamfer 替代。

### 3.2 运行时棱边 chamfer 替代（AddEdgeBevels 简化版）

`debug/crates/wasm/src/lib.rs:2552-2690`（game 同 `crates/wasm/src/lib.rs:1973-2075`）。核心逻辑：

1. **真实棱识别**：对每对平面 `i<j`（非平行、非共面），找同时落在这两平面上的顶点（容差 `eps_plane = 0.1` HU）。共享顶点 `≥2` 即是一条真实凸棱。
2. **chamfer 法线**：`n_ch = normalize(n_i + n_j)`（两相邻面法线归一化均值）。
3. **过平面点**：取棱上任一共享顶点为锚点，`dist = dot(n_ch, anchor)`。
4. **方向校验（关键约束）**：chamfer 必须位于凸包**外侧**——对凸包上不属于该棱的其它顶点，`dot(n_ch, v) - dist` 必须**同号**（都在 chamfer 平面同侧）。若混号则丢弃。这避免了 BSP 高悬 bevel 挤压凸包、影响可站性的问题。校验通过后据外侧符号把法线翻到朝外（`nch_final`）。
5. **合并**：`all_planes_src.extend(chamfer_planes)`（`lib.rs:2690`），随后与真实面一起经 Y-up 旋转 + 法线翻转，序列化进 brush JSON（约 `lib.rs:2725` 起）。

用途（仅限凸棱平滑，与 P2 幻影碰撞无因果关系，见 §8）：
- 高速盒角扫过坡顶棱线时**平滑引导入坡**；
- 打开凸包棱线的尖锐过渡，避免盒角在该处提前/异常碰撞。

---

## 4. 数据流

```
BSP(brush_sides[].bevel)
  │
  ▼  导出层 crates/wasm/src/lib.rs
  │   - 剔除 side.bevel != 0 的面（debug 1902/2459 两处；game 1856）
  │   - 运行时棱边 chamfer 平面生成（debug 2552-2690；game 1973-2075）
  │   - 合并真实面 + chamfer，Y-up 旋转 + 法线翻转
  ▼
brush JSON（含 chamfer 平面，法线朝外）
  │
  ▼  src/phys/mod.rs::build_world（100-134，全部平面无条件）
  │   → World.solids / World.ladders
  ▼
src/phys/world.rs::clip_planes / clip_box_to_brush（118-183 / 186-195）
  │   chamfer 作为普通碰撞平面参与盒扫掠
  ▼
碰撞响应（凸棱过渡平滑；P2 坡顶幻影仍需 world.rs 轴向 bevel / 端盖容差，见 §8）
```

---

## 5. 关键发现：导出层 chamfer 与 P2 轴向 bevel 是两套机制（原"文档与代码分歧"结论已更正）

`docs/phys-fix-directions.md` P2 项将**轴向 bevel 平面生成**的实现位置定为 `src/phys/world.rs`（`add_axial_bevels(&mut Brush)` 后处理函数，由 `src/phys/mod.rs::build_world` 循环调用）。本文先前据此认为"导出层 chamfer 取代/落地了 P2 的 bevel 生成"，**该判断错误**，已由 wasm 实跑否定（§8）：

- 导出层运行时 chamfer（剔除 BSP bevel + 注入棱边切角）是一套**独立的凸棱平滑**机制，与 P2 的坡顶幻影碰撞无因果关系；
- P2 真正需要的仍是 `src/phys/world.rs` 内的**轴向 bevel**（即文档原设想方向，此前被本文误判为"未落地"）或**端盖容差**方案。

因此压缩/合并文档时，**不应**把 P2 的"实现位置"更正为导出层；P2 仍归属于 `src/phys/world.rs`，文档原方向正确。

---

## 6. 验证建议 / 回归基线（已据实测修正）

原拟用 `phys-rate-parity-v2.mjs` 场景 B 验证"导出层 chamfer 对 P2 的疗效"——**实测已否定该疗效**（§8：chamfer 对该场景无改善甚至劣化）。P2 的正确验证/修复方向应改为（详见 §9 质疑分析）：

- **首要修复**：在 `src/phys/world.rs::clip_planes` 增加**逐进入平面**的「命中处盒 AABB vs brush AABB 三轴重叠」必要校验（非整 brush 否决，否则会穿 brush，见 §9.2），根除 z=0 端盖等 axis-separated 幻影类；这是比轴向 bevel / 端盖容差更根本、且与几何参数无关的方案。
- **可选平滑层**：仅当合法棱接触手感仍硬时，再评估 `world.rs::add_axial_bevels`（Quake 式）作手感优化——此时它已从"P2 解药"降级为"平滑层"，非必需。
- 回归基线仍以 `phys-fix-directions.md` P2 为准（当前 2242/2422），并以 Δvel<10 为通过标准；
- 凸角剐蹭带（场景 A）在引擎中因碰撞盒轴对齐、yaw 不旋转，本就不依赖 chamfer，`±chamfer` 实测无差异，无需纳入 P2 回归。

---

## 7. 参考位置索引

| 主题 | 文件:行 |
|------|---------|
| `BrushSide` 数据定义（含 `bevel`） | `src/wasm-core/vbsp/data/mod.rs:320-326` |
| `brush_sides` 解析进 `BspFile` | `src/wasm-core/vbsp/mod.rs:308` |
| `build_world` 全平面无条件入碰撞 | `src/phys/mod.rs:100-134` |
| 平面裁剪碰撞 | `src/phys/world.rs:118-183`（`clip_planes`）/ `186-195`（`clip_box_to_brush`） |
| 剔除 BSP bevel 面 | `debug/crates/wasm/src/lib.rs:1902`、`2459` 两处；`game/crates/wasm/src/lib.rs:1856` |
| 运行时棱边 chamfer 生成 | `debug/crates/wasm/src/lib.rs:2552-2690`（game `1973-2075`） |
| chamfer 合并进序列化平面 | `debug/crates/wasm/src/lib.rs:2690`、约 2725 |
| P2 正确修复方向（轴向 bevel / 端盖容差） | `src/phys/world.rs`（`add_axial_bevels`，phys-fix-directions.md P2 原设想） |

---

## 8. wasm 实跑验证结论（phys-chamfer-real.mjs / phys-chamfer-probe.mjs，2026-08-19）

> 以下均为 wasm 实跑（非 Python 模拟）。临时探针脚本已清理。

**Test A — 凸角剐蹭带**（phys-chamfer-real.mjs + 探针）
- 引擎碰撞盒轴对齐、**yaw 不旋转**（`player.rs:959-964`）。Python 模型"45°→h√2 剐蹭带"的前提在引擎中不存在。
- 出生重叠会被 unstuck 推出（探针：z=0.5 → 首 tick 推至 z=16.5），纯出生路径测不出"剐蹭"；但飞行中进入凸角确有 16u 阈值碰撞（探针：−z 直冲在 z=16.1 被拦、对角线沿棱滑动）。
- 此前 Test A 的 `max-clip=0.0` 只是 unstuck 的产物。
- band d=19：`±chamfer × yaw 0/45` 四种配置**全部 PASS**，chamfer 对该场景无影响。

**Test B — P2 坡顶幻影碰撞**（phys-chamfer-real.mjs）
- 无 chamfer 精确复现文档基线：H=2.5/vz=300 → 2242.1、H=4/vz=500 → 2421.6（与 phys-fix-directions.md"当前 2242/2422"一致）。幻影根因 = 盒前缘刺入坡面 z=0 端盖平面被整速清零。
- 注入正确 chamfer 平面后：旗舰用例 H=2.5/vz=300 从 2242.1 降至 14.9（首碰变为平滑顶起 v=(0,72,271)，不再清零）——但未达 Δvel<10 验证标准，且：
  - 其他配置反而劣化：H=2.5/vz=800 0→234.6、H=3/vz=500 3.5→2228.4、H=3/vz=800 0→239.9；
  - H=4/vz=500 不变（2421.6，另一处坡尾幻影）。
- **结论：现行导出层 chamfer 不是 P2 的根治手段。** P2 需轴向 bevel（world.rs 内实现，文档原设想方向）或端盖容差方案。

**对本文 §1/§6 的影响**：文中"该 chamfer 正是 P2 根治手段"的表述已被实测否定，已相应更正（见 §1、§5、§6）。`docs/chamfer-physics/` 下的两个 Python 脚本（`verify_chamfer_strategy.py`、`scenario_corner_clip.py`）是算法/概念层模型，结论以本节 wasm 实跑为准。

---

## 9. 质疑与修正：P2 根因重定位为「盒-AABB 必要校验」（2026-08-19）

> 本节以**质疑**态度评估一段新思路：P2 根因不是"缺几何补丁（轴向 bevel / 端盖容差）"，而是 `clip_planes`（world.rs:118-183）只做逐平面 Minkowski 扩张，缺「盒自身三轴的相交必要条件校验」。建议改用"命中处盒 AABB vs brush AABB 三轴重叠"一票否决幻影类。

### 9.1 已核实的论据（成立）

| 论据 | 代码核对 | 结论 |
|------|----------|------|
| `clip_planes` 只查逐平面，无盒/brush 三轴 SAT（**修复前**） | 118-183 仅遍历 `planes`，不引用 `brush.min/max`；`clip_box_to_brush`(186) 只把 `&brush.planes` 传入 | ✅ 成立（修复前；§9.2/§9.5 已在 `clip_planes` 加入 `bmin/bmax` 引用与逐平面 AABB 校验，该行前提现已落地修正） |
| 碰撞盒轴对齐、yaw 不旋转 | `player.rs:959-964` `apply_hull`：`mins=[-hw,0,-hw]`、`maxs=[hw,H,hw]`，纯世界轴 | ✅ 成立 → 盒 AABB = 盒本体，AABB 校验**精确无旋转膨胀**，"零误杀"成立 |
| 幻影经 `clip_velocity` 清零 vz | `player.rs:462` 用 `tr.normal`（即误报的 z=0 端盖法线）`clip_velocity` → vz 整速清零 | ✅ 成立（与 §8 根因一致） |
| 端盖容差 / 轴向 bevel 是"同一件事两端" | 二者均改**几何**使之逼近真实 brush；AABB 校验改的是**命中报告层**的必然条件 | ✅ 框架性认同：AABB 校验更根本 |

### 9.2 必须修正的两处（质疑点）

**⚠️ 修正 1：必须是「逐进入平面否决」（非整 brush 否决）；但二者对凸 brush 等价，真正的修复是"加校验"而非"换否决范围"。**

原描述把检查放在 `clip_planes`（即 `enter_frac`/`clip_plane` 已算定、准备写 `result.fraction` 之处）做"不重叠→跳过"。这里先**更正一处事实错误**：`clip_planes` 的命中平面（`enter_frac`）是**所有进入平面里「最晚进入」的那一个**——代码取 `if f > enter_frac { enter_frac = f; }`（即取最大 `f`，最新进入的平面），而非"最早进入"。

因此原"整 brush 否决会丢合法接触→穿模"的担忧，在数学上**对单个凸 brush 并不成立**：

- 命中平面生效需满足 `enter_frac < leave_frac`（盒在 `[enter_frac, leave_frac]` 区间内位于 brush 内）。
- 若某平面是"幻影"（命中处盒 AABB 与 brush AABB 沿某轴分离），则盒在该分数处必已**离开** brush（跨过了某真实面），`leave_frac` 会被该真实面提前压低，使 `enter_frac < leave_frac` 不成立 → 该幻影**本就不会成为有效命中**。
- 反之，若幻影确为有效命中（盒未跨出任何真实面、仅跨入无限 cap），则盒必在 brush 内 → 盒 AABB 与 brush AABB **重叠** → `aabb_overlaps_at` 返回 `true` → 整 brush 否决也**不会**误杀它。

结论：**对单个凸 brush，逐平面否决 与 整 brush 否决 结果等价**；二者都不会在凸 brush 上丢合法接触。原"整 brush 否决会穿模"是把 `nogate`（**完全不校验**）与"整 brush 否决"混为一谈导致的误判。**真正的修复**是：相对原始 `nogate`（根本不做 AABB 必要校验），在 `clip_planes` 进入分支**逐平面**加 `aabb_overlaps_at` 校验——这样既剔除 z=0 端盖等 axis-separated 幻影，又因"逐平面"只跳过幻影平面、保留其余合法进入，自然无损真实坡面接触。

> 实际落点（`src/phys/world.rs::clip_planes` 进入分支，约 191-200 行）：
> ```rust
> if d1 > d2 {
>     let f = (d1 - DIST_EPSILON) / (d1 - d2);
>     // 命中处盒 AABB 与 brush AABB 三轴重叠，才是真实进入；否则是无限平面幻影
>     if aabb_overlaps_at(bmin, bmax, start, end, mins, maxs, f) && f > enter_frac {
>         enter_frac = f;
>         clip_plane = Some(p);
>     }
> }
> ```
> `aabb_overlaps_at` 在分数 `f` 处取盒 AABB `[start+(end-start)*f + mins, … + maxs]`，与 `bmin/bmax` 三轴比较（EPS 取 `2*DIST_EPSILON`，见 191 行附近注释）。需把 `bmin/bmax` 透传进 `clip_planes`（签名加两参；三角形路径传三角形 AABB）。

> **为何仍选"逐平面"而非"整 brush"**：二者对凸 brush 等价，但"逐平面"是更局部、更不易出错的实现——它只针对单条进入平面做否决，绝不触碰其它合法进入；若未来 brush 变为非凸（多连通）或校验逻辑扩到 trace 聚合层，"逐平面"语义仍能正确级联到真正的命中平面，而"整 brush"口径在聚合层会误伤同 brush 内的合法子区域。当前实现采用逐平面，符合此稳健性取向。

**⚠️ 修正 2：`box_in_brush:356` 与 `clip_planes` 不是"同类问题"，AABB 守卫只是防御性优化。**

`box_in_brush` 是**静态全包含**测试（对每条平面要求盒都在内侧），不是扫掠进入测试。对凸 brush，"在所有平面内侧" ⟹ "在 brush 内" ⟹ AABB 必重叠，故它**本就不会**产生 axis-separated 型误报。把它也归为"同类问题需同修"是类比过宽——给 `ladder_at` 加 AABB 前置守卫是廉价且无害的（盒 AABB 不重叠则直接跳过 `box_in_brush`），但那是**防御性提前返回**，不是修复一个已证实的 bug。

### 9.3 范围边界（诚实标注，避免再夸大）

AABB 重叠是真实相交的**必要条件、非充分条件**：
- **能修**：盒 AABB 与 brush AABB 在命中处**沿某轴分离**的幻影类——含 §8 的 P2（z=0 端盖，盒 y 与坡体 y 在命中瞬间完全分离）、以及一切"无限平面造成的假碰撞"。这正是 P2 的根因类。
- **不能修**：AABB 已重叠但两形实际不相交（AABB 是保守包围盒，如盒落在 L 形 brush 凹口、或平面过近似的棱边处）。此类若仍残留，需另行处理，H×vz 矩阵是裁决者。

因此该方案**比 chamfer 稳健的根本原因**是：它**与几何参数无关**（拓扑/必要条件的否决），不会像 chamfer 那样"调参数碰对"——只要某 H×vz 配置的幻影属于 axis-separated 类，就一律根除；其余配置亦不受损。

### 9.4 推荐顺序（采纳并细化）

1. **先落逐平面 AABB 校验**（§9.2 修正版），用 `phys-chamfer-real.mjs` 的 H×vz 矩阵回归，预期全部 Δvel<10 收敛（对 chamfer 无关，纯剔除幻影）。
2. 若合法棱接触手感仍硬（Quake 式棱线生硬），再评估 `world.rs::add_axial_bevels` 作**平滑层**（此时它已从"P2 解药"降级为"手感优化"）。
3. 导出层 chamfer 维持现状（凸棱平滑，与 P2 解耦）。

> 注：本方案把 P2 的首要修复从 §6 的"轴向 bevel / 端盖容差"重定位为"盒-AABB 必要校验"；§6 已据本节更新优先级。

### 9.5 验证结果（脚本可验证性，2026-08-19）

用户原始提问："执行，并需要确定其是否可以在脚本中得到验证。" 结论：**可以在脚本中得到验证**——`clip_planes` 是纯几何算法，无引擎/wasm 依赖，可忠实镜像到 Python 做单元级断言。

**Rust 端（已落地 + 编译验证）**
- `src/phys/world.rs` 已加 `aabb_overlaps_at`（EPS=`2*DIST_EPSILON`）并在 `clip_planes` 进入分支逐平面调用；`clip_box_to_brush` / `clip_box_to_triangle` 透传 `bmin/bmax`。
- `cargo check -p websurf-phys` **通过**（dev profile，0.81s，无 error/warning）。注意：这是编译期验证，确认签名/类型/借用正确；运行期疗效以 §8 的 wasm 实跑 H×vz 矩阵为最终裁决（探针已清理，需重建 `phys-chamfer-real.mjs`）。

**Python 镜像脚本（忠实对应 world.rs 算法）**
- 位置：`docs/chamfer-physics/verify_box_aabb_necessary_check.py`（镜像 world.rs:107-200）。
- 三种模式：`nogate`（原始无校验）/ `perplane`（修复）/ `whole`（整 brush 否决变体）。
- 三个场景全部 **PASS**：

| 场景 | nogate | perplane | whole | 判定 | 说明 |
|------|--------|----------|-------|------|------|
| S1 纯无限平面幻影 | frac=0.2799 n=[0,0,1]（误报） | frac=1.0（否决） | frac=1.0（否决） | PASS | P2 坡顶幻影被修复根除 |
| S2 合法墙接触 | frac=0.4198 | frac=0.4198 n=[1,0,0]（保留） | — | PASS | 合法接触不被误杀 |
| S3 共存 brush（墙+外伸 cap） | frac=0.4198 n=[1,0,0] | frac=0.4198 n=[1,0,0] | frac=0.4198 n=[1,0,0] | PASS | 幻影 cap 被逐平面否决、真实墙保留；三模式等价（印证 §9.2 修正：凸 brush 上 perplane≡whole） |

**对"脚本可验证性"的边界说明（诚实标注）**
- 脚本验证的是**算法逻辑**（AABB 必要校验是否按预期否决 axis-separated 幻影、保留合法接触）。它与 world.rs 逐行对应，可作为回归守护。
- 它**不等于**引擎级验证：盒轴对齐/yaw 不旋转、Minkowski `plane_offset`、`clip_velocity` 清零 vz 等真实链路，需在 wasm 实跑里用 H×vz 矩阵确认 Δvel<10 全收敛；Python 不含这些。
- EPS 边界：EPS=`2*DIST_EPSILON`（=0.0625）旨在吸收"扩展进入分数处盒表面恰贴 brush 平面"的 `DIST_EPSILON` 穿透量 + 浮点误差，同时仍 ≪ P2 幻影的轴分离量（≥1.6 HU），不会误杀合法擦边。该取值已由 S2/S3 的合法擦边接触（盒 AABB 与 brush AABB 仅差 `DIST_EPSILON` 量级）不被否决所佐证。
