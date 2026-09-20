# prop 静态光照：leaf ambient cube 采样（实现记录与后续方向）

> 状态：已实现并独立复核（2026-09-19），**用户验收未通过（模型仍异常偏亮）**——本文保留全部机制、实测数据与后续方向，供续作参考。
> **二次定位（2026-09-19）**：「不生效」已定位到渲染端两处硬断点 + 一处处量级坑，见 §8（§7 的 sprp `m_Lighting` 并非「不生效」的原因，只是精度提升项）。
> 落点：`test/game-core`（绝对隔离工程，仓库根 `src/` 零引用，见 [AGENTS.md §2.1](../../AGENTS.md)）。
> 参照物：外部参照实现（`../../../.tmp/外部参照实现-master/`，版本控制外）；上一轮背景见 [lighting-merge-plan.md](./lighting-merge-plan.md) 与 `.tmp/gamma-lights-parity-plan.md`、`.tmp/prop-lighting-fog-plan.md`（gitignore，不入库）。

---

## 1. 问题与结论

| 项 | 内容 |
|---|---|
| 症状 | prop 模型异常偏亮（烘焙光照只作用于 world 面，prop 呈贴图原色 fullbright） |
| 根因 | prop 的静态光照数据源（leaf ambient cube）在导出端整链缺失；vbsp 仅定义了 lump 枚举、数据从未解析 |
| 已实现 | vbsp 解析 4 个 ambient lump → per-prop cube 查询（组选择 + 树遍历 + nearest 采样）→ node extras 契约 → 渲染端法线平方加权 shader |
| 验收结果 | 机制链路成立（P2 独立重算 cube 439/439 匹配、回归全绿），但**肉眼观感 prop 仍偏亮**——见 §7 未决问题 |
| 二次定位 | 「偏亮」= **cube 根本没进 shader**：① 73% 的 prop 被 GLTFLoader 包成 Group，node extras 到不了子 Mesh；② 剩下 27% 的 VS 注入点被 `#if` 预处理剔除；③ 量级本身还差约 255×。见 §8 |

## 2. Source 机制参照（外部参照实现口径，实测核实）

Source 引擎中 prop_static 的静态照明不来自 lightmap（prop 无 lightmap UV），渲染时按顶点位置/法线采样其所在 leaf 的 **ambient light cube**（6 面 RGBExp32，VRAD 烘焙）。

外部参照实现的实现（我们逐点核对的权威）：

| 环节 | 外部参照实现位置 | 行为 |
|---|---|---|
| 组选择 | `../../../.tmp/外部参照实现-master/外部参照实现.WebExport/Bsp/AmbientCubes.cs:44` | `hdr = LeafAmbientLightingHdr.Length > LeafAmbientLighting.Length` —— **长度比较**，非「HDR 非空优先」 |
| 顶点采样 | `../../../.tmp/外部参照实现-master/外部参照实现.WebExport/Resources/src/StudioModel.ts:116-165` | 每实例：leaf 内多采样点取 **nearest**（`../../../.tmp/外部参照实现-master/外部参照实现.WebExport/Resources/src/BspModel.ts:141-165`，标注 `TODO: interpolation` 未做插值）→ 6 面按**法线平方加权**：`n.x²·cube[±X] + n.y²·cube[±Y] + n.z²·cube[±Z]` → 面序 [+X,-X,+Y,-Y,+Z,-Z] → `linearToScreenGamma` 后写顶点色 |
| 无数据兜底 | `../../../.tmp/外部参照实现-master/外部参照实现.WebExport/Resources/src/StudioModel.ts:166-168` | 顶点色写 `0x7f`（sRGB 0.5 中性灰） |
| vertLighting 页 | `../../../.tmp/外部参照实现-master/外部参照实现.WebExport/Bsp/Index.cs:138` 仅声明 | **数据端从未生成**（全仓 grep 仅 1 处）——实际生效的只有 ambient cube 路径 |
| prop 亮度 | `../../../.tmp/外部参照实现-master/外部参照实现.WebExport/Resources/src/Map.ts:208-217` | `getLeafAt`（树遍历）传 leaf 给 `createMeshHandles` |

## 3. 数据格式（BSP lumps，均为逐字节实测）

目录基址注意：BSP header 为 `ident(4B) + version(4B)`，lump 目录从 **offset 8** 开始、每条 16B `{offset, length, version, ident}`；`ident ≠ 0` 表示 LZMA 压缩且 ident = 解压后长度（`vbsp/bspfile.rs` 的 `get_lump` 已自动解压）。早期探查脚本误用 base=16 导致全错位数据，已废弃。

| lump（LumpType 序号） | 记录 | 结构 |
|---|---|---|
| `LeafAmbientIndexHdr`(51) / `LeafAmbientIndex`(52) | 4B/leaf | `{ count: u16, first: u16 }` —— 每 leaf 的采样区间 |
| `LeafAmbientLightingHdr`(55) / `LeafAmbientLighting`(56) | 28B/采样 | 6×`ColorRGBExp32`（r,g,b u8 + exponent u8，**指数为 i8 语义**）+ `x,y,z` u8（leaf 内相对位置，0-255 线性映射回 bounds）+ pad |

实测数据特征（决定性，见 §4 坑 1）：

| 图 | HDR 组 | LDR 组 | 结论 |
|---|---|---|---|
| surf_666（LDR 图） | lump55 = 698628B → 24951 采样，**全 0** | lump56 = 3723216B → 132972 采样，**99% 非零** | 必须选 LDR（长度规则自动正确） |
| surf_null（HDR 图） | 两组合计 3269700B → 116775 采样，99.99% 非零 | 同 | 长度相等 → 用 LDR（不大于规则） |

## 4. 实现与关键坑（每条都有数据实证）

实现分布（行号为 2026-09-19 实测）：

| 层 | 位置 | 内容 |
|---|---|---|
| 结构 | `test/game-core/crates/wasm-core/vbsp/data/game.rs:384-421` | `ColorRgbExp32`（`decode_linear` = mantissa/255 × 2^exp，i8 指数）、`LeafAmbientSample`、`LeafAmbientIndex` |
| 解析 | `test/game-core/crates/wasm-core/vbsp/mod.rs`（Bsp 4 字段 + read 内 4 段 `unwrap_or_default` 解析） | 缺失 lump → 空 vec（老图可能没有） |
| 查询 | `test/game-core/crates/wasm-core/vbsp/mod.rs:520` `prop_ambient_cube(prop_index)` | 见下方规则 |
| 集成 | `test/game-core/crates/wasm-core/model_integrator/mod.rs:132`（node extras）、`:874`（StaticProp 字段）、`:893`（Placement 字段） | cube 写入 node extras `{"ambientCube": [18]}` |
| 接线 | `test/game-core/crates/wasm/src/lib.rs`（collect 转换） | `ambient_cube: bsp.prop_ambient_cube(i)` |
| 渲染 | `test/game-core/src/renderer/lightmap-shader.ts:704` `applyAmbientCubeIfAny` | fullbright 材质 + onBeforeCompile 注入法线平方加权；`extras.unlit`（VMT `UnlitGeneric` / `$selfillum`）**跳过** cube 相乘 ⇒ 全亮贴图原色 |

`prop_ambient_cube` 的四条规则（全部有实证背书）：

1. **组选择 = 长度比较**（`mod.rs:536`）：`use_hdr = lighting_hdr.len() > lighting.len()`。初版「HDR 非空优先」在 surf_666 选到全 0 的 HDR 组 → prop cube 全 0（501/501）——**本条是第一轮修复的核心**。
2. **leaf 定位 = BSP 树遍历**：从 node 0 走 plane 侧向（`side >= 0 → children[0]`，`children < 0 → leaf = !child`）。初版线性扫 bounds 首个命中会命中错误相邻 leaf。
3. **leaf 内多采样点 = nearest**（与外部参照实现一致，它也没做插值）。
4. **中性灰兜底**：无数据/定位失败/leaf 无采样 → `[0.2139; 18]`（= 外部参照实现 `0x7f` 即 sRGB 0.5 的线性域等价值 `((0.5+0.055)/1.055)^2.4 ≈ 0.2139`）。

架构约束与通道选择：本工程**同一模型的多个实例共享同一 mesh**（`model_integrator` 的 push_model 只上传一次顶点），顶点级 COLOR_0 无法携带随实例旋转变化的世界法线光照 → 采用 **per-instance cube（node extras）+ uniform + shader 法线加权**，光照语义与外部参照实现等价（同一 leaf 采样 + 顶点级法线平方加权），仅通道不同。

色彩域：cube 为线性辐射度，**直乘 linear 域** diffuseColor，显示 gamma 由 three `colorspace_fragment` 承担——**不照抄** 外部参照实现顶点色里的 `linearToScreenGamma`（那是其 sRGB 直出管线的显示变换，照抄即双重 gamma，见 gamma-parity 轮的矫正记录）。

## 5. 验证与证据

- 数据面：`test/game-core/temp/ambient-presence-check.mjs`（临时脚本）——surf_666 导出 GLB 中 501 个 prop node，439 真实 cube + 62 中性灰 + 0 全零；surf_null 77 + 4。
- 独立复核（P2 子代理）：独立解包 BSP 重算 cube，与 wasm 导出 **439/439 完全一致**（含 8 个 USE_LIGHTING_ORIGIN 分支）；回归全绿：`test:phys` 五指纹（gravity -12.50/tick、landing tick31、jump 289.49、crouch 46.04、teleport tick24）、`test:lightmap-gltf` 82 断言、`test:seed-smoke` 7 组、`check:api` 17+17。
- 报告：`test/game-core/temp/prop-light-fog-report.md`、`prop-light-verify-report.md`（临时区，不入库；结论已提炼至本文）。

## 6. 已知边界

- 中性灰兜底的 prop（surf_666 62 个 / surf_null 4 个）观感偏灰——该 leaf 无烘焙 ambient 数据，属数据边界。
- cube 为 per-prop 单点采样（leaf 级），prop 内部的朝向明暗依赖法线加权，位置粒度受 leaf 采样点密度限制。

## 7. 未决问题：模型仍异常偏亮（用户验收未通过）与后续方向

按价值排序（第 1 条为最可能的正解）：

1. **sprp per-prop lighting（`m_Lighting`）**：Source 引擎对 prop_static 的静态照明实际用 **VRAD 烘焙的 per-prop 4 采样光照**（写在该 prop 的 GameLump sprp 记录尾部，`StaticPropLump_t` v7+ 字段 `m_Lighting[4]`）——**leaf ambient cube 只是外部参照实现的近似**，外部参照实现与本工程都未解析 m_Lighting。续作方向：核对 sprp v10 的 64B 记录布局（`test/game-core/crates/wasm-core/vbsp/data/game.rs:253` 起的 `StaticPropLumpV10`）尾部是否存在未解析的 16B lighting 块，若有则解析并替代/混合 leaf ambient。
2. **sprp v11 `diff_modulation`**：CS:GO 后期记录含 `diff_modulation: u32`（`game.rs:277` 注释）——Source 的 prop diffuse 调制色，未消费。
3. **顶点级采样**：当前 cube 为 per-prop 单点；若 leaf 内多采样点存在，可对 prop 顶点按世界位置加权插值多个采样点（外部参照实现标注 `TODO: interpolation` 未做）。
4. **材质调制**：VMT 的 `$selfillum`、detail/光栅参数对 prop 亮度的贡献未建模。*（部分已闭环：`UnlitGeneric` / `$selfillum` 已由 `parse_vmt` 标注 `unlit`、经 `InMemoryResources.material_unlit` 写进 GLB `extras.unlit`，渲染端据此**跳过 ambient cube 相乘**走全亮 —— 见 [prop-black-materials-root-cause.md](prop-black-materials-root-cause.md)；detail/光栅参数仍未建模。）*
5. **兜底策略**：中性灰 prop 可改乘「该图平均环境亮度」而非固定 0.214，减少观感突兀。

## 8. 二次定位：「不生效」的三处断点（2026-09-19 实测）

> **施工方案（P1/P2/P3 逐项改动、验收命令、回退点）单独成篇：[prop-ambient-fix-plan.md](./prop-ambient-fix-plan.md)**。本节只给定位结论与证据。

§7 列的 5 条是**精度提升方向**，不是「不生效」的原因。**不生效**是渲染端三处独立断点，按影响面排序：

| # | 断点 | 命中面 | 后果 |
|---|---|---|---|
| A | `node extras.ambientCube` 挂在 **Group** 上，子 Mesh 拿不到 | surf_666 **366/501（73%）** prop node | `applyAmbientCubeIfAny` 首行 return ⇒ 纯 fullbright = 偏亮 |
| B | VS 注入锚点在 `#if defined(USE_ENVMAP) \|\| defined(USE_SKINNING)` 内 | 剩余 **135/501（27%）** | `vbspWNormal` 从未赋值 ⇒ FS 读未定义 varying |
| C | cube 解码量级比 lightmap 暗约 **1360×** | 修好 A/B 之后全部 prop | 应用后 prop 近黑（与 P1 出帧「近黑 11.9%」吻合） |

### A. Group 断层（决定性）

`model_integrator` 把 cube 写在 **node extras**（`mod.rs:132`），而一个 prop 模型有 N 个材质 ⇒ `push_model` 产出 **N 个 primitive**。three 0.165 的 GLTFLoader：

- `meshes.length === 1 → 返回 Mesh`；否则 **`new Group()` 包住所有 primitive**（`GLTFLoader.js:3862-3882`）；
- `loadNode` 把 **node extras 赋给 `node`**（即那个 Group，`GLTFLoader.js:4280`），子 Mesh 只拿到 `meshDef.extras`（空）；
- 渲染端 `applyAmbientCubeIfAny` 首版只读 `mesh.userData.ambientCube`（当时的 `lightmap-shader.ts:517`）⇒ 恒 `undefined` ⇒ 直接 return。

surf_666 实测（501 个带 cube 的 prop node 所指向 mesh 的 primitive 数分布）：`1prim:135  2prim:209  3prim:93  4prim:54  5prim:10`
⇒ **366 个 node（73%）落成 Group**，cube 到此为止；只有 135 个（27%）直接是 Mesh。

修复方向（任选，推荐第 1 条）：
1. **导出端改写到 primitive extras** ⇒ 落到 `geometry.userData`，与 `hasLightmap` 同口径（该口径已在 `lightmap-shader.ts:18-20` 声明、并在 `:378-400` 生效），最稳；
2. 渲染端向上回溯：`mesh.userData.ambientCube ?? mesh.parent?.userData.ambientCube`（Group 层级固定一层，成本低）；
3. 加载后统一把 node extras 下发给子 Mesh（GLTF onLoad 遍历）。

### B. VS 注入点被预处理剔除

three 0.165 的 `meshbasic_vert`（`three.module.js:14032`，即 `ShaderChunk.meshbasic_vert`）：

```glsl
#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )
    #include <beginnormal_vertex>   // ← 我们的注入插入在这行之后
    ...
#endif
```

`applyFullbrightBasic` 造的是 **纯 `MeshBasicMaterial`（无 envMap、无蒙皮）** ⇒ `USE_ENVMAP`/`USE_SKINNING` 均未定义 ⇒ 整块（含 `objectNormal` 与我们的 `vbspWNormal = ...`）被预处理剔除 ⇒ varying 从未写入，FS 里 `normalize(vbspWNormal)` 取到未定义值 ⇒ 光照结果不可预期（实测打到近黑/异常值）。

而 FS 锚点 `reflectedLight.indirectDiffuse *= diffuseColor.rgb;` **确实存在**（`three.module.js:14034` fragment$a）⇒ 只有 VS 侧坏，`vsChanged && fsChanged` 的守卫因此**不会报错**（替换字符串命中成功，只是语义被编译期吃掉）。

修复方向：改用不在 `#if` 内的锚点（`#include <begin_vertex>` / `#include <project_vertex>` 均可），并直接写
`vbspWNormal = normalize( mat3( modelMatrix ) * normal );`——`attribute vec3 normal;` 由 three 的 prefixVertex 无条件声明，prop 几何带 NORMAL 访问器，可用。

### C. 量级：ambient 比 lightmap 暗三个数量级（修完 A/B 立刻撞上）

同一套 RGBExp32 解码（mantissa/255 × 2^exp、指数按 i8）下，surf_666 实测（各抽样 4 万条）：

| 数据源 | p50 | 均值 | p90 | max |
|---|---|---|---|---|
| lump56 ambient cube | 4.28e-5 | 1.34e-4 | 3.14e-4 | 1.65e-3 |
| lump8 lightmap（world 面，观感已验收） | 5.83e-2 | 1.17e-1 | 2.90e-1 | 1.87e+0 |
| 比值 | **1362×** | 873× | 924× | 1132× |

即：**照现状应用，prop 会被乘到近黑**（≈ lightmap 亮度的 1/1000）。这与 P1 出帧的「近黑 11.9%」自洽——说明当时**确有部分 prop 吃到了 cube**（数量与 §A 的 135 个单 primitive prop 吻合）。

exponent 字节实测：ambient 集中在 **236-247（i8 = -20..-9）**，lightmap 集中在 **249-255（i8 = -7..-1）**；mantissa 均值 118.7 / max 255。
按外部参照实现的口径（**mantissa 不除 255**，`Utils.ts:40-42`，只是它的指数偏置写错成 `2^(e-128)`）换算，ambient ≈ lightmap 的 **1/3 ~ 1/5**，量级才合理（ambient 本就只有间接光）。

⇒ **`decode_linear` 的 `/255` 对 ambient 是否成立存疑**，需出帧 A/B 校准（建议：新增 ambient 专用解码 `m × 2^exp`，或保留 `/255` 另加可调系数；校准基线 = 同一相机位姿下 prop 亮度与相邻 world 面亮度可比）。

补充：three 对 `lightMap` 走的是 `× RECIPROCAL_PI`（`fragment$a` 的 `lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI`），而 prop 的 fullbright 路径是 `× vec3(1.0)` 再乘 cube ⇒ **两侧还差一个 π**，校准时必须一并统一，否则 prop 会比 world 亮约 3.14 倍。

### 8.1 修复顺序建议

1. 先修 **A**（73% 直接受益、改动最小、可独立验证：统计 `mesh.userData.ambientCube` 命中数应从 135 → 501）；
2. 再修 **B**（把 varying 真正写进去，用 `__vbspAmbientInject` + 出帧亮度分布验证，不再是 NaN/近黑）；
3. 最后 **C**（出帧 A/B 定量校准，基线 = prop 与相邻 world 面亮度可比，含 π 归一）。

## 9. 修复轮落地（2026-09-19，A/B/C 全部修复 + 量级校准完成）

> 施工按 [prop-ambient-fix-plan.md](./prop-ambient-fix-plan.md) 执行，本节为落地结果与校准数据。

### 9.1 改动清单

| 文件 | 改动 |
|---|---|
| `test/game-core/src/renderer/lightmap-shader.ts` | **A**：`applyAmbientCubeIfAny` 改用 `resolveAmbientCube`（Mesh→Group 向上回溯 ≤2 层，:516）；**B**：VS 锚点 `#include <beginnormal_vertex>` → `#include <begin_vertex>`、注入 `normalize(mat3(modelMatrix) * normal)`（:546）；新增 `__vbspAmbientStats` 命中计数 |
| `test/game-core/src/renderer/renderer-main.ts` | `reportInjectStatsOnce` 追加 `[ambient-cube] 命中/未命中/节点` 与 `applied/失败` 日志；probe 新增 `ambientProbe()`（直读材质 cube 与注入记录，供出帧脚本取证） |
| `test/game-core/crates/wasm-core/vbsp/data/game.rs` | 新增 `decode_linear_ambient`（mantissa × 2^exp，**不除 255**；`decode_linear` 保留给 lightmap，不可混用） |
| `test/game-core/crates/wasm-core/vbsp/mod.rs` | 顶部 `AMBIENT_SCALE: f32`（唯一量级旋钮）；`prop_ambient_cube` 解码调用改用 `decode_linear_ambient` 并乘旋钮；中性灰兜底改 `AMBIENT_SCALE × 0.0109`（新口径域 p50，随旋钮联动） |
| `test/game-core/scripts/lightmap-frame-capture.mjs` | 出帧 JSON 增 `ambientProbe`（探针取证用） |

### 9.2 A/B 验证结果

- **A**：命中（mesh 调用级）1098 / 未命中 440 / **节点去重 501**（surf_666，与 node 数精确一致）；surf_null 节点 81。mesh 级 1098 = §8 的 prim 分布和（135×1+209×2+93×3+54×4+10×5）。
- **B**：探针实测 `__vbspAmbientInject.applied` 全 true（surf_666 applied=156 失败=0；surf_null applied=2 失败=0——数字为 optimizeScene 材质去重后的实例数）。

### 9.3 C 量级校准（AMBIENT_SCALE 扫描，surf_666 spawn 位姿，ROI 量化）

| AMBIENT_SCALE | prop 平均亮度 | world 参照 | prop/world 比 |
|---|---|---|---|
| （P0 基线：fullbright） | 38.5 | 21.1 | **1.82**（= 用户症状） |
| 0.75 | 14.98 | 21.1 | 0.709 |
| **1.0（选定）** | **15.06** | **21.1** | **0.713 ∈ [0.7, 1.0] 主判据达标** |
| 1.5 | 15.25 | 21.1 | 0.721 |
| 300（链路二分） | 39.5 | 21.1 | 1.87 |
| 常数 5.0（链路二分） | 64.3 | 21.1 | 3.04 |

- 曲线单调（14.98→15.06→15.25→39.5→64.3）⇒ uniform→shader→输出链全程传导。
- 0.75~1.5 档读数变化小 = 暗部 sRGB 感知压缩 + 8bit 量化的预期（cube≈0.011 量级下 ±25% 缩放 <1 个 8bit 级），**不是机制故障**；300 档跳变证明链路完整。
- π 归一：不额外乘 `1/π`（lightmap 路径自带 RECIPROCAL_PI、prop fullbright 路径没有，两口径换算后 prop/world ≈ 0.92 理论 / 0.71 实测——实测偏低因 prop 无光照朝向面被 ROI 均值稀释）。
- **ROI 标定教训**：spawn 位姿下画面中央的大结构是 **world brush 站台**，真实 prop 屏幕区域 [448,320]-[800,384] 由帧差分析锁定（`temp/frame-diff.mjs`：常数注入帧 vs P0 帧逐像素 diff 的差异 bbox）。

### 9.4 回归（修复轮全绿）

`typecheck`、`test:lightmap-gltf`（82 断言）、`test:lightmap-decode`、`test:lightmap-guard`、`check:api`（17+17）、`test:phys` 五指纹（gravity -12.50/tick、landing tick31、jump 289.49、crouch 46.04、teleport tick24）、`test:seed-smoke`（7 组）。

### 9.5 遗留观察

- 0.75 与 1.0 档在 8bit 输出下读数差 <1 级（暗部量化稀释）；若需更细量级分辨须 float 帧缓冲或高精度采集。
- §7 的五条精度提升项（sprp `m_Lighting` 等）仍未实施，是「prop 与游戏内观感仍有差距」时的下一步。

> 续作提醒：动 Rust 侧后需 `npm run build:wasm`（wasm-pack）+ `build:dist`；`test:phys` 五指纹与 `test:lightmap-gltf` 82 断言是回归底线；临时产物只进 `test/game-core/temp/`。
