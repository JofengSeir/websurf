# 05 · `src/wasm-core` 侧 `bevel` / `brushes` 无消费者，注释却称导出层会用

**状态**：待修
**取证日期**：2026-10-04
**地图**：`test/maps/surf_666.bsp`

---

## 1. 现象

`src/wasm-core` 这一层（共享的 VBSP 解析 + GLB 导出）读进了 BSP 的 `Brush` / `BrushSide` 两张表，
包括其中的 `bevel` 字段，但**导出层从未使用**。两处文档注释都称导出层会用，构成事实性错误。

> ⚠️ 口径澄清：`apps/debug/crates/wasm/src/lib.rs` **确实**剔除 `side.bevel`（`:2165`、`:2722`），
> 那是 debug 自己的碰撞体导出，与本条不是同一处代码。**本条只针对 `src/wasm-core`。**

## 2. 证据

### 2.1 `bevel` 字段零读取

`src/wasm-core/vbsp/data/mod.rs:483` 定义 `pub bevel: i16`。全仓 grep（`*.rs`，`src/` 与
`apps/*/crates/`）命中仅两处，都在 `data/mod.rs` 自身：`:475`（注释）与 `:483`（定义）。

### 2.2 注释称导出层会剔除 bevel —— 不成立

`src/wasm-core/vbsp/data/mod.rs:474`-`:475`：

> `bevel` 非 0 表示倒角面，**导出层会把它剔除**

`src/wasm-core` 的导出层没有任何一处引用 `bevel`。

### 2.3 更上一层：`brushes` / `brush_sides` 整张表也没人用

`src/wasm-core/vbsp/data/mod.rs:403`：

> `brush_side` / `num_brush_sides`：`Bsp.brush_sides` 的区间；**导出层按它取每个 brush 的面与凸包平面**

实测：两张表在 `src/wasm-core/vbsp/mod.rs:492` 解析进内存后，全仓没有任何读取点。
`Handle` 侧也没有 `Handle<Brush>` 的访问器（`src/wasm-core/vbsp/handle/mod.rs` 只有
`Model` / `Leaf` / `Face` / `Displacement` 几个 impl）。

世界与 prop 的几何只走 `FACES` / `MODELS`：`src/wasm-core/bsp_to_gltf_core/convert.rs:960`
的 `model.faces()`。

### 2.4 这张图上 bevel 占比很高

对 `surf_666.bsp` 直接读 `BRUSHES`(18) / `BRUSHSIDES`(19) / `PLANES`(1) 三张 lump
（`BrushSide` = `plane:u16, texture_info:i16, displacement_info:i16, bevel:i16` = 8 B）：

```
BrushSides: 64776 entries; bevel!=0 => 18157          (28%)
  bevel value histogram: [ [ 1, 18157 ] ]
Brushes: 7730, brush_sides referenced total=64776,
  brushes containing >=1 bevel side = 4278
bevel sides: texture_info>=0 => 18157, <0 => 0
```

⇒ 若哪天真按注释去「剔除 bevel」，会一次性影响 4,278 个 brush 的 18,157 个面。
**正因为它现在没被用，改这层之前必须先想清楚要什么语义**，不能照注释直接实现。

### 2.5 `FACES` 表里也没有可对应的倒角面

同一次读 lump 得到的 `FACES`(7)：39,034 条，`num_edges` 直方图以 4（24,550）/ 5（6,618）/ 6（3,373）
为主，三边面 1,923 条；`texture_info < 0` 的面 **0** 条。

无法把 `FACES` 条目与 bevel brush side 一一对应上。**结论：在当前实现下倒角进不了渲染路径**，
所以 [01](01-chamfer-is-not-a-bevel.md) 测到的「chamfer 不切几何」与本条是两件事：
01 说的是 debug 自己的运行时 chamfer，本条说的是 BSP 原生 bevel 在共享层无人使用。

## 3. 根因

解析层按「把表读全」实现（便于将来使用），文档注释却按「已经在用」来写。注释与代码脱节。

## 4. 影响面

- 不影响任何运行时行为（读进内存但不用，只是白占内存：`surf_666` 上是 64,776 × 8 B ≈ 518 KB
  加 7,730 × 12 B ≈ 93 KB）。
- 影响的是**文档可信度**：注释是后续改动的唯一指引，照它实现会踩空。

## 5. 建议处置

**只改注释，不动代码**（推荐，符合 AGENTS「疑似缺陷只记录不修」与本次不动代码的约定）：

1. `src/wasm-core/vbsp/data/mod.rs:475` 改成如实陈述：本仓**无** bevel 剔除；`side.bevel` 目前
   是死数据，若要启用需先定义语义（剔除还是保留）。
2. `src/wasm-core/vbsp/data/mod.rs:403` 改成：`brush_sides` 区间当前**无读取点**。
3. 顺带在 `data/mod.rs:12` 的模块清单里注明 `BrushSide` 为已读未用。

**如果 owner 希望共享层也剔除 bevel**：那是一次行为变更，需要
(a) 先定语义（`texture_info < 0` 的面怎么办——本图 bevel 面的 `texture_info` 全部 ≥ 0，
所以至少不是无纹理面）；(b) 确认 4,278 个 brush 的 18,157 个面剔除后不会开洞；
(c) 走三工程的渲染回归。**建议单独立项，不要混在注释修正里。**
