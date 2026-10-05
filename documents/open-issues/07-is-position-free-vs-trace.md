# 07 · `is_position_free` 与 `trace` 在 .phy 三角网格上不一致 ⇒ 玩家被冻结

**状态**：待修（成因已实测确认，缺「那个实体是什么」的判定）
**发现日期**：2026-10-05
**复现地图**：`test/maps/surf_666.bsp`
**相关**：`06-phy-hull-facet-jump.md`（同一条坡上的弹飞，已处置）

## 1. 症状

owner 在 `s1_ramp1b` 的坡上沿 −z 行走，走到 z ≈ −9789 处**完全停住**，卡 3.5 秒不动。
位置全程 `y = 14560.03` 恒定，`on_ground = true`，没有弹飞。

owner 路径文件 `phys-path-20261005-120800.json`：

- `render` 470 样本，最后一次 z 减小在 index 257（z = −9786.37），之后 212 个采样不动；
- `tick` 447 样本（**worker 权威帧**），最后一次 z 减小在 index 248（z = −9786.36），之后 198 个采样不动。

**两条链停在同一个 z** ⇒ 不是渲染、不是插值、不是录制结束，是权威物理自己不走了。
且 index 120~134 还在 −9790.3 ~ −9790.9 之间每采样弹 ±0.6 HU，是「顶着什么、推不动、来回蹭」。

## 2. 先排除的：几何障碍

`debug_trace` 从卡住的位置沿 −z 做 **60 HU** 长扫掠：

```
z = -9786.4 / -9790 / -9795 / -9800，脚下 +0/+2/+6/+12/+20/+40/+60 各高度：全部 fraction = 1.0
脚下 14560.03 有一张水平可站面 (0,1,0) 连续铺到至少 z = -9850
```

**60 HU 内没有任何几何障碍。** 所以不是墙、不是台阶。

> 走过的弯路：先用 **3.9 HU**（一步的距离）扫掠，结论是「畅通」——**那是错的**，够不到
> 5 HU 外的障碍。判断「有没有东西挡路」必须用远大于一步的长扫掠。

`detect_blocked_move` 也排除：它要求 `!on_ground`，而玩家全程 `on_ground = true`。

## 3. 实测：两个碰撞查询在同一位置给出相反答案

为此新增了诊断绑定 `PhysWorld::debug_position_probe`（见 §5），在同一 tick 上并置两种查询。
从 owner 起点走到停下，逐 tick 探测：

```
 tick      z          y     free  downFrac  n.y    state
    0   -9590.90  14560.03   1    0.0000  0.000  ground
   40   -9734.46  14560.03   1    0.0000  0.000  ground
   55   -9789.06  14560.03   0    0.0000  0.000  ground   <== free 翻成 0
   56   -9788.96  14560.03   0    0.0000  0.000  ground
  ...
   80   -9790.71  14560.03   0    0.0000  0.000  ground   <== 每 tick 抖 ±0.1 HU
```

**z ≈ −9789 处 `is_position_free` 从 1 翻成 0，而 `trace` 说脚下就有地面、`on_ground` 仍为 true。**
之后的每 tick 位移只有 ±0.1 HU，正是 owner 路径里看到的来回蹭。

把探针沿 y 抬起来看范围：

```
y=14560.03 (+ 0)  is_position_free=0
y=14561.03 (+ 1)  is_position_free=0
y=14564.03 (+ 4)  is_position_free=0
y=14568.03 (+ 8)  is_position_free=0
y=14576.03 (+16)  is_position_free=1     <-- 抬到 +16 才脱身
对照 z=-9600（正常段）：y=14560.03 / +1 / +4 全部 free=1
```

**⇒ 那个位置的 y ∈ [约 14560, 约 14568] 区间里有实体**，玩家 72 HU 高的身体箱（14560..14632）
与之相交，`is_position_free` 如实报「不空」。

## 4. 机制：`check_stuck` 冻结

`player::check_stuck`（`src/phys/player.rs`）：

```rust
if world.is_position_free(&p.origin, &mins, &maxs) { p.stuck_ticks = 0; return false; }
// 60 个挤出候选（dist ∈ {1,2,4,8,16,34} × STUCK_DIRS 10 向）
// 某个候选空闲就把 origin 挪过去并 return false
p.stuck_ticks += 1; p.velocity = [0,0,0]; true   // <- 全部失败
```

返回 true 时 `player_tick` **跳过本 tick 的全部移动与落地判定**。

在 owner 这个位置上，60 个候选点里总有几个「空闲」（往 +x / ±z 挪 1~2 HU 就出去了），
于是每 tick：判定不空 → 挪 1~2 HU → 下一 tick 前进被同样的实体挡住 → 再挪回去。
**净位移 ≈ 0，表现为原地抖动。** 这与实测的 ±0.1 HU/tick、以及 owner 路径里的来回蹭完全一致。

**⇒ 卡住的直接机制确认：`check_stuck` 每 tick 把玩家挤出一点点，抵消了前进。**

## 5. 新增的诊断能力

`src/phys/mod.rs` 新增 `#[wasm_bindgen] pub fn debug_position_probe(x, y, z) -> Vec<f64>`，返回 6 个数：

| 下标 | 含义 |
|---|---|
| 0 | `is_position_free`（1 = 空，0 = 不空） |
| 1 | 原地向下扫掠 1 HU 的 `fraction` |
| 2..4 | 该扫掠命中的法线 |
| 5 | `stuck_ticks` |

碰撞箱取玩家**当前**箱（与 `debug_trace` 同口径）。不推进物理、不改状态。

**为什么需要它**：移动走 `World::trace`，而 `check_stuck` 走 `World::is_position_free`——
**两个独立的查询**。没有并置观测就无法发现它们不一致。本条问题就是靠它定位的。

用法示例（Node，wasm 直驱）：

```js
const pr = pw.debug_position_probe(x, y, z);
// pr[0] === 0 但 pr[1] < 1 且 on_ground  =>  check_stuck 会进入挤出分支
```

## 6. 未决（下一步）

1. **那个实体是什么？** 探针只返回布尔值，看不到对象身份。候选：
   - `s1_ramp1b` 的 .phy 凸包在该处向上延伸到 14568 以上（其坡面在 z=−9899 处为 14571.59，
     而玩家箱顶 14632 —— 箱体与之相交是合理的）；
   - 或世界 brush 的 chamfer / 端盖。

   **需要给探针补一个「命中对象归属」输出**，或直接在 `is_position_free` 里加诊断计数。
2. **修法方向（未实施，需 owner 裁决）**：
   - **A. `check_stuck` 不再对「移动被挡」负责**：它本意是处理「卡在实体里」，而这里是
     「前方有合法障碍」。区分二者（例如只在 `!on_ground` 时启用，或要求候选点必须**朝速度
     反方向**）。
   - **B. 挤出方向改为沿当前速度的反方向**：现在的 `STUCK_DIRS` 是固定 10 向，与意图无关。
   - **C. 改几何**：同 06 的 C —— 模型碰撞改用 `export_model_tri_colliders()`。
3. **回归缺口**：现有 `duck_surf_tests` / `p2_gate_tests` 的夹具都是手搓 brush，不经三角网格
   路径，`step_gate_tests` 也不经——**所以这条缺陷此前完全没有测试覆盖**。需要一条
   「在 .phy 三角网格上向前行走不产生原地抖动」的测试，但手搓 brush 夹具无法覆盖它，
   得用真实地图数据或含三角网格的夹具。