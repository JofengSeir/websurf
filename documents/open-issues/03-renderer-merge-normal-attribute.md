# 03 · `mergeGeometries` 因 `normal` 属性不一致失败，三应用合批静默失效

**状态**：待修
**取证日期**：2026-10-04
**地图**：`test/maps/surf_666.bsp`，debug 工程，控制台实测

---

## 1. 现象

载入地图后控制台稳定刷出（同一份日志里出现约 50 次，不同下标）：

```
THREE.BufferGeometryUtils: .mergeGeometries() failed with geometry at index 2.
All geometries must have compatible attributes; make sure "normal" attribute
exists among all geometries, or in none of them.
```

同帧的合批统计看着是正常的：

```
[optimizeScene] 分块合并: 35254 mesh → 1330 块（cellSize=3408.3、非空 cell=453）
| 平均顶点/块 381（总顶点 507214）| draw call 估算 1888
```

**画面不丢东西**，但合批在这批几何上静默失效。

## 2. 证据

### 2.1 世界面没有 `normal` 属性

`src/wasm-core/bsp_to_gltf_core/convert.rs:1161`-`:1177` 构造 primitive 时只写三个语义：

```
Semantic::Positions → accessor_start
Semantic::TexCoords(0) → accessor_start + 1
Semantic::TexCoords(1) → accessor_start + 2
```

**没有 `Semantic::Normals`。** 因为材质是 `MeshBasicMaterial`（不受光），法线对本渲染无意义，
导出侧也就不写。

静态 prop 走 MDL/VTF 链路，带法线。两者落进同一个 cell + 同一个材质时，
`mergeGeometries` 比对属性集失败 → 返回 `null`。

### 2.2 失败被正确兜住，但代价是合批没做

`src/renderer-shared/scene/scene-optimizer.ts`：

- 子合并失败（`:188`-`:194`）：`merged = geoms`，保留各自独立几何；
- 最终合并失败（`:210`-`:223`）：每个材质单独一块。

`:115`-`:116` 的注释也写明「合并失败不丢几何」。**所以这是性能问题，不是画面问题。**

### 2.3 触发条件（未逐材质验证）

46 个材质在 BSP 内找不到 VMT/VTF（载入时弹「缺失材质纹理」弹窗实测值）。这些面没有
`baseColorTexture`，落进同一份兜底材质；而 prop 里凡是用到同一兜底材质的，也会落进同一材质组。
**同一材质组里混着「无 normal 的世界面」与「有 normal 的 prop」⇒ 属性集不一致 ⇒ 合并失败。**

这条推断未逐材质验证，标为待核；但它与「失败集中在下标 1-6 的小组」的现象一致
（每组只有几个几何时最容易混进异构项）。

### 2.4 debug 的归一钩子不覆盖这一项

`apps/debug` 传了 `normalizeGroup` 钩子（`scene-optimizer.ts:183`, `:210`；类型见 `:53`-`:555`），
它归一的是**混合 indexed / 非 indexed** 与**混合 `gpuType`**，不处理 `normal` 的有无。

## 3. 根因

世界面导出不带 `normal`，prop 带；`mergeGeometries` 要求属性集严格一致。
两个不同的物化来源（程序生成的凸包面 / MDL 资产）在同一材质下相遇就失败。

## 4. 影响面

- 三个应用都吃这条路径（`src/renderer-shared/` 是单实例，2026-10-02 起被 game / debug / viewer 共用）。
- 影响 draw call 与首帧时间，不影响画面正确性。
- AGENTS 2026-10-04 第二轮收敛里记录过 viewer dist 体积与 draw call 的基线，这条会让基线漂移。

## 5. 建议处置

**归一 `normal` 的有无**（推荐）。在共享核里给 `mergeIntoChunks` 的两处合并入参加一步：
带 `normal` 的转成不带（`deleteAttribute('normal')`），或不带的补零向量属性。
共享层是单实例 ⇒ 三应用一次修好。

需要注意：world 侧材质不受光，补零向量不会改变画面；但 prop 侧若将来换 `MeshStandardMaterial`，
补零法线会让它全黑。所以**优先选「删 `normal`」而不是「补零 `normal`」**，除非能按材质区分。

次选：把世界面导出时补一个 `normal`（按面法线常量填充）。代价是 GLB 每个顶点多 12 B
（AGENTS 已记录过「避免给既有无光照路径增加每顶点 8 B 的几何开销」，同一类权衡）。
