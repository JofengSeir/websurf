# 待解决问题（open issues）

本目录收拢**已取证**的问题。每篇一篇，格式统一：现象 → 证据（`文件:行号` 或实测数字）
→ 根因 → 影响面 → 建议处置 → 处置结果。取证阶段**只记录不修**，与 `AGENTS.md` §6
「疑似缺陷只记录不修」一致；owner 裁决后才动代码，并把结果回填到各篇末节。

## 状态口径

| 状态 | 含义 |
|---|---|
| `待裁决` | 修法有分歧，或改动会动到行为契约，需要 owner 定 |
| `待修` | 修法明确、改动局部，可直接排期 |
| `已取证待立项` | 根因清楚但工作量超出一次改动，需要单独任务书 |
| `已处置` | 已按本篇结论改完，篇末「处置结果」记了改了什么 |

## 目录

| # | 篇 | 一句话 | 状态 |
|---|---|---|---|
| 01 | [debug-chamfer-is-not-a-bevel.md](debug-chamfer-is-not-a-bevel.md) | chamfer 平面**不切任何几何**，黄线框画的不是物理面 | **已处置** |
| 02 | [debug-chamfer-visualization-guesswork.md](debug-chamfer-visualization-guesswork.md) | 黄线框靠**重新猜**平面得到，与物理侧用的平面表不是同一套判据 | **已处置** |
| 03 | [renderer-merge-normal-attribute.md](renderer-merge-normal-attribute.md) | `mergeGeometries` 因 `normal` 属性不一致失败，三应用合批静默失效 | 待修 |
| 04 | [wasm-untextured-surface-color.md](wasm-untextured-surface-color.md) | 无 `$basetexture` 的面按 `$color` 上色，大片无纹理面呈平白/粉 | 待裁决 |
| 05 | [wasmcore-bevel-doc-vs-code.md](wasmcore-bevel-doc-vs-code.md) | `src/wasm-core` 侧 `bevel` / `brushes` 无消费者，注释却称导出层会用 | 待修 |

## 与既有台账的关系

`AGENTS.md` §7.3 已有一批登记在案的待裁决项。本目录**只收 2026-10-04 这一轮渲染/几何排查新增的条目**，
不重复搬运 §7.3 已有内容；关闭某一条时，两边（本文与 §7.3）都要同步划掉，否则会出现「文档说已修、
台账还挂着」的对不上一致。

01 与 02 是同一件事的两面：01 是物理侧根本没有倒角，02 是即便有倒角、可视化也未必按物理侧画。
**已于 2026-10-05 合并成一次改动落地**（见下节）。

## owner 定下的规则（2026-10-05）

> 所有 debug 显示端的**所有面高亮必须真实反映物理系统实际影响运动的面，否则就不得显示**。

落地方式三步：

1. **物理侧给真相**：`export_brushes_planes` 逐平面输出 `is_real_face`，判据由物理侧自己算
   （`plane_is_real_face`：面上凸包顶点 ≥ 3，且多边形面积 ≥ `MIN_FACE_AREA`）。
   渲染端从此不必、也不允许再猜。
2. **渲染端只放行真面**：`orderedFaces` 只接受 `isRealFace === true`；触发器那条路没有这个
   字段，按「未知即不画」处理。
3. **不真实的直接撤掉**：`computeChamferStrips` / `rebuildChamfers` / 黄色 chamfer 线框整路删除，
   配置字段、页面复选框与可视距离滑块一并撤除（chamfer 平面零面积，本就不该出现）。

物理侧行为**零变更**——01 已证明 chamfer 削减体积为零，删掉那层显示不会改变任何碰撞结果。
01 的**方案 A（加真实倒角宽度）没有做**：那是行为变更、需要独立物理回归，不在「显示端必须真实」
这条规则的范围内。
