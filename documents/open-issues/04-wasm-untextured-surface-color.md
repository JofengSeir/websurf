# 04 · 无 `$basetexture` 的面按 `$color` 上色，大片无纹理面呈平白 / 粉

**状态**：待裁决
**取证日期**：2026-10-04
**地图**：`test/maps/surf_666.bsp`，debug 工程，位置 `(-13540, 14503, -8402)`

---

## 1. 现象

走廊两侧与顶部有大片**平涂的粉白 / 纯白面**，与相邻的有纹理砖墙形成硬边。owner 的原始描述是
「边缘的绘制出了问题」——实际观感来自「无纹理平面直接怼着有纹理面」，不是描边。

## 2. 证据

### 2.1 切到纯纹理模式后，这些面变成纯白

用面板「光照模式 → 纯纹理」把 lightmap 完全旁路（`vbspBakedMix = 0` ⇒
`src/renderer-shared/shader/lightmap-shader.ts` 的 `vbsp_ApplyLightmap` 直接 `return vec3(1.0)`），
同一位置取像素（行 `y = 545`，`x = 320..510`）：

| | 光照开 | 光照关 |
|---|---|---|
| 大片平涂面 | (210,153,142) → 平滑渐变 | **(255,255,255) 全平** |

渐变来自 lightmap；`255,255,255` 说明 **baseColor = 白、无贴图**。

### 2.2 走的是「无 `$basetexture` → 取 `$color`」分支

`src/wasm-core/bsp_to_gltf_core/materials.rs`：

- `:475`-`:479`——「没有基础纹理时也保留作者声明的 `$color`，不丢成纯白」：

  ```rust
  return Ok(MaterialData {
      …
      color: parse_dollar_color(&vdf).unwrap_or([255, 255, 255, 255]),
  ```

- `:434`-`:437`——shader 不被 `vmt_parser` 识别时同样取 `$color`。

文件头注 `:30`-`:31` 把这条口径写清楚了：

> 成功路径把 `color` 固定为纯白 `[255; 4]`；只有「着色器不被识别」与「没有 `$basetexture`」
> 两条早退路径才用 `parse_dollar_color` 取作者声明的基色。

`color` 四通道除以 255 后直接进 glTF `base_color_factor`
（`src/wasm-core/bsp_to_gltf_core/gltf_builder.rs:252`）。

### 2.3 该地图的 46 个材质在 BSP 内找不到 VMT/VTF

载入时弹窗实测（节选）：

```
本图有 46 个材质纹理缺失（BSP 内找不到 VMT/VTF）：
concrete/concretewall065a / concretewall036a / stone/marblefloor001b /
stone/stonewall032a / de_train/train_cement_floor_01 / realworld/textures/de_aircenter/concrete01 …
```

其中 `concrete*` / `stone*` / `marblefloor*` 正是走廊两侧与顶部会用到的那一类。

### 2.4 黑边不是黑

同一次取样，横穿那条「黑边」：

| 区域 | 光照开 | 光照关 |
|---|---|---|
| 相邻砖墙 | 51–66 | 75–88 |
| 被称作「黑边」那条 | **28–36** | **30–45** |

两种模式下都在变化、且约为邻面一半亮度 ⇒ 是一张**本身偏暗的砖贴图**，不是绘制失败。
这一点要跟 05 区分开：那条暗带不是 bevel 面。

### 2.5 切光源后暗带位置不变

`纯纹理` 模式下暗带与 `预烘焙` 模式**位置与走向完全一致** ⇒ 排除 lightmap / 图集渗色 / padding 环
（`lightmap-shader.ts:872`-`:910` 的 `hasLightmap === false` → fullbright 通路本身是对的）。

## 3. 根因

地图作者对这些面用「无 `$basetexture` 的 VMT」表达，材质色靠 `$color` 或干脆不给。
本仓对「无 `$basetexture`」的取值口径是「`$color`，缺省白」——语义上忠实于 VMT，
但当大量面同时落到这条分支时，观感就是成片平白，与相邻纹理面硬接。

**这不是 bug，是缺资源 + 兜底口径的后果。**需要 owner 定的不是「怎么修」，而是「兜底该长什么样」。

## 4. 影响面

- 观感问题，不影响碰撞与性能。
- 受影响面数 = 命中该分支的面数（本次 46 个材质）。
- 与 [03](03-renderer-merge-normal-attribute.md) 同源（未逐材质验证）：**缺失材质塌缩到同一个兜底材质**，
  既造成大片平白，是否同时就是合批失败的触发条件待核（03 §2.3）。修 [03](03-renderer-merge-normal-attribute.md)
  时顺带确认这条，可以少跑一趟。

## 5. 建议处置（待裁决）

1. **先确认这 46 个材质覆盖了哪些面**（让 debug 面板按材质统计面数），再决定是否值得投入。
2. 兜底底色改为**低饱和深灰**而非纯白，让「缺资源」在画面上可辨识、且不与有纹理面硬接。
3. 或者：把兜底面在 debug 里单独着色（如半透明品红），让「这里缺贴图」一眼可见——
   本仓已有 `[renderer] 场景贴图 50 个` / `mini 匹配 0/50` 这类统计，可直接扩一个缺失面计数。

> 注意：取证时我是从仓库根起静态服务的，`textures.mtz` 未加载（控制台
> `[default-pack] 默认纹理包加载失败（HTTP 404）`），因此 46 个缺失材质里**一个兜底都没生效**。
> 正常起服务时兜底表覆盖其中一部分（AGENTS 2026-10-04 记的是 29 个已回退 / 17 个真缺失）。
> 上面第 2 节的像素值对应的是「零回退」的最坏情况，量化前需在正常服务下重测。
