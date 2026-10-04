# 01 · debug 的 chamfer 切角面不切任何几何（黄线框画的不是物理面）

**状态**：待裁决
**取证日期**：2026-10-04
**地图**：`test/maps/surf_666.bsp`（79,207,230 B，VBSP v20，7,730 brush）
**复现位置**：`(-13540, 14503, -8402)`，debug 工程，Noclip 自由飞行，`显示chamfer切角面` 勾选

---

## 1. 现象

debug 侧栏「调试线框 → 显示chamfer切角面」会在 brush 的每条棱上画一个黄色四边形，视觉上像是
「这条棱被切了一个角」。开启 `显示brush碰撞` 后能看到这些黄框贴在凸包棱上。

owner 的判断是：**黄线框宣称的是一条物理棱边被倒角，但实际碰撞几何里这条棱一点没被切**——
若属实，debug 显示的就不是物理面，而是标记。

## 2. 证据

### 2.1 生成侧：chamfer 平面从棱上「穿过去」，没有内缩量

`apps/debug/crates/wasm/src/lib.rs` 的 chamfer 生成块（`:2815`-`:2939`）对每一对相邻真实面：

- 找出同时落在两面上的凸包顶点 `shared`（`:2866`-`:2871`，判定容差 `eps_plane = 0.1`，`:2834`）；
- `shared.len() >= 2` 才算一条棱（`:2872`-`:2874`）；
- 法线取两法线归一化均值 `nch = normalize(n_i + n_j)`（`:2876`-`:2885`）；
- **`dist` 直接取自棱上一个顶点**（`:2887`-`:2888`）：

  ```rust
  let anchor = &verts_bsp[shared[0]];
  let dist = nch[0] * anchor[0] + nch[1] * anchor[1] + nch[2] * anchor[2];
  ```

  ⇒ 平面**恰好过棱**，没有任何内缩（bevel offset）。

- 方向校验（`:2895`-`:2914`）要求「不属于该棱的其它凸包顶点在同一侧」，随后按该侧定号翻转
  `nch_final`（`:2916`-`:2927`），保证内点满足 `dot(nch_final, v) - dist_final > 0`。

一个过棱、法线为角平分线、半空间包含全部凸包顶点的平面，对凸包而言是**切平面**：它与凸包的交
仍是整个凸包，**削减体积为零**。要真正倒角，平面必须沿内法线内缩一个非零量（`dist -= offset`），
代码里不存在这样的参数。

函数头注释（`:2817`-`:2823`）声称它承担：

> 1) 高速盒角扫过坡顶棱线时平滑引导入坡；
> 2) 打开凸包棱线的尖锐过渡，避免盒角在该处提前/异常碰撞。

这两条在当前实现下都不成立。

### 2.2 实测：2664 / 2664 个 chamfer 平面削减体积为零

按上述算法对真实 brush 复刻（同一套 `eps_plane = 0.1`、`0.999` 平行剔除、共线判定阈值），
判据取「生成平面朝内取号后，全部凸包顶点是否都满足 `dot(n, v) - dist >= 0`」——
满足即切平面，全不满足才是真倒角。

```
brushes tested           : 220
  skipped: numSides=0 planes<4=0 hull<4=0
chamfer planes generated : 2664
  TANGENT (removes 0 volume): 2664
  actually CUTS geometry    : 0
```

**零个切到几何。**

> 取证口径：`compute_vertices` 的内点判据是 `d >= -1`（`lib.rs:2614`），而 solid brush 的 BSP 平面
> 内点在**负侧**，所以 `:2789`-`:2804` 会走 `flipped_planes = (-n, -dist)` 回退分支。复刻脚本同样先
> 取负，保证与生成器面对同一套平面。切平面这一结论与法线朝向无关。

### 2.3 这些平面确实进了物理，且确实没起作用

`collect_planes_and_flags`（`:2146`-`:2184`）与 `export_brushes_planes`（`:2712`-`:2726`）都会
剔除 `side.bevel != 0` 的面——注释写明 BSP 自带 bevel「常为高悬于实体之外的平面」，会挤压凸包
（`:2160`-`:2164`）。这是正确的取舍。

随后真实面与运行时 chamfer 合并进同一个 `all_planes_src`（`:2940`-`:2953`）输出，
`apps/debug/src/world/collider-adapter.ts` 把 `wb.planes` 原样映射成 `solids`（`:233`-`:247`），
`src/phys/world.rs` 再由这批平面求半空间交集。

**因为 chamfer 是切平面，半空间交集结果与只用真实面完全一致 ⇒ 碰撞结果逐位不变。**

## 3. 根因

「不挤压凸包」与「真正倒角」这两个目标在当前实现里被当成了同一个约束。实现只做到了前者：
把平面放在过棱位置（切平面）就同时满足了「不切凸包」和「不挤压凸包」，代价是倒角量为零。
缺的是一个独立的倒角宽度参数 + 把它接进 `dist`。

## 4. 影响面

- **debug 可视化**：黄线框暗示存在物理倒角，实际没有 ⇒ 直接对应 owner 的「否则 debug 就只是个
  忽悠人的工具」。
- **物理**：`src/phys` 不受影响（结果等价）。但若将来有人依赖「棱边有引导」的行为去调
  盒角手感，会发现调不出来，因为从来没有生效过。
- **文档**：`collider-debug.ts:258`-`:260` 的头注把「既进物理碰撞，也进本模块的线框显示」写成
  既成事实；`lib.rs:2817`-`:2823` 的两处能力声称同样需要按实测改写。

## 5. 建议处置（待裁决，三选一）

**A. 真做倒角**（推荐）。给 chamfer 加倒角宽度（HU），令
`dist_final = dot(nch_final, anchor) - width`，宽度取相对 brush 尺寸的量级（例如棱长的一个百分比，
下限 0.5 HU），并把宽度带进 `WasmBrushPlane` 以便可视化按真实平面画。需要先定：宽度取值口径、
以及宽度是否会让贴墙移动的判定改变（会——这是行为变更，必须走回归）。

**B. 降级为纯标记**。承认 chamfer 就是切平面，把它从「碰撞体平面」里摘出去，只作为
「这里有一条棱」的诊断信息单独传输与显示。物理侧零变更，debug 不再误导。

**C. 先撤显示**。在 A/B 定案前，把 `showChamfers` 默认关掉（`config.ts:252` 现在是 `false`，
但页面复选框在本次实测里是勾上的），并在 UI 上注明「切角面当前无碰撞作用」。

> 无论选哪个，01 与 [02](debug-chamfer-visualization-guesswork.md) 建议同一次改动落地：
> 只改可视化不改物理，等于把一个会骗人的图画得更精细。
## 6. 处置结果（2026-10-05，已完成）

owner 裁定：**所有 debug 显示端的面高亮必须真实反映物理系统实际影响运动的面，否则不得显示。**
据此按 §5 的 **C（先撤显示）** 落地，并把「谁是真面」的判据上移到物理侧：

| 改动 | 文件 |
|---|---|
| 新增 plane_is_real_face：面上凸包顶点 ≥ 3（容差 ON_PLANE_EPS = 0.1）且 Newell 多边形面积 ≥ MIN_FACE_AREA = 0.05 HU² 才算真面 | pps/debug/crates/wasm/src/lib.rs |
| WasmBrushPlane 增加 is_real_face 字段并随 planes_yup 输出 | 同上 |
| Plane 增加 isRealFace?: boolean，daptBrushes 直传不重算 | pps/debug/src/world/collider-adapter.ts、pps/debug/src/physics/physics/Collision/Collision.types.ts |
| orderedFaces 只放行 isRealFace === true（缺字段按「未知即不画」） | pps/debug/src/renderer/collider-debug.ts |
| 删除 computeChamferStrips / ebuildChamfers / 黄色线框 Group / setChamferDebugFlags | 同上 |
| 删除 showChamfers / chamferViewDistance 两个配置字段与页面上的复选框 + 滑块 | pps/debug/src/config.ts、pps/debug/web/index.html |

**未做**：§5 的方案 A（真实倒角宽度）。它是物理行为变更，需要独立回归，不在本次规则范围内。

**验证**：cargo check + wasm-pack build --release 通过；pps/debug typecheck exit 0；
浏览器实测（surf_666.bsp，(-13540, 14503, -8402) 附近）黄色 chamfer 线框整体消失，
只余绿色地面面与橙色 .phy 碰撞盒；控制台不再出现 [collider-debug] chamfer 重建 一行。
