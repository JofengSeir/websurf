# materials-and-alpha

> 对象：`test/game-core`（游戏工程测试副本）。症状：**铁丝网 / 格栅 / 铁栏杆「理论上透明」却在实机里是实心**——
> 孔洞被画成近黑块、`metalfence007a` 整片没有贴图、`wire_white` 变成一面纯白大墙。
> 结论：这不是渲染端单点问题，而是**贴图来源 + 透明度语义**在导出链路上四处丢失；修复后 `MASK/BLEND`
> 与世界面/模型侧全部对齐，无贴图材质 45 → 18。
>
> 事实基准：2026-09-20，地图 `test/maps/surf_666.bsp`（BSP v20，pakfile 1500 条 / VMT 149 / VTF 76），
> 默认纹理包 `test/game-core/web/textures.mtz`（9448 项）。

## 1. 症状与量化

| 现象 | 实测数据 | 影响面 |
|---|---|---|
| 格栅孔洞被画成近黑实心块 | `metal/metalgrate013a` 贴图 **28.2%** 像素 `alpha=0`，导出却是 `alphaMode=OPAQUE` ⇒ glTF 只能画成它们自己的 RGB（实测 ≈ `#131414`） | 世界面 158 个 primitive |
| 同上（第二处） | `metal/metalgrate013b` 贴图 **11.8%** `alpha=0`，`OPAQUE` | 世界面 16 个 primitive |
| 铁栏杆整片没有贴图 | prop 材质 `metalfence007a`（`$translucent 1`）导出无 `baseColorTexture`，源贴图 `metal/metalfence007a`（**17.6% 镂空**）就在默认纹理包里却没被取到 | prop 4 个实例 |
| 格栅 `013a2` 既无贴图也无透明度 | `metal/metalgrate013a2`（世界面 **212 个 primitive**）无贴图、`OPAQUE` | 世界面 212 个 primitive |
| 纯白大墙 | `dev_nyro/blends/wire_white`（`"Wireframe"` + `$color { 73 73 73 }`）被画成 `baseColor 1,1,1` 实体面，单面 768×512×768、近景占屏 > 60% | 世界面 8 个 |

## 2. 根因（四处独立丢失 + 两处单位/语义问题）

### 2.1 默认纹理包的键是「源资源路径」，不是「材质名」

`textures.mtz` 的键形如 `materials/metal/metalfence007a`（贴图路径），而模型材质名常年是**裸基名**
（`metalfence007a`、`metalgrate013a`）。实测 pakfile 的 149 个 VMT 里 **74 个** 的 `$basetexture`
与材质名不同路径（`666/metalfence007a` → `metal/metalfence007a`、`666/metalgrate013a` →
`metal/metalgrate013a` …）。按材质名查包 ⇒ 这类材质**系统性**拿不到贴图。

### 2.2 VMT 解析成功但 VTF 缺失时，回退包从不被查询

`bsp_to_gltf_core/materials.rs` 里回退表只在**整材质加载 Err**（连 VMT 都找不到）的分支被查；
`load_material_bsp` 解析成功、只是 `load_texture_bsp` 失败时直接返回 `texture: None`。

### 2.3 世界面 VMT 查找没有基名回退

世界面的贴图名来自 BSP texinfo（全大写，如 `METAL/METALGRATE013A2`），只尝试
`materials/<名>.vmt` 的四种写法。而作者的 VMT 在 `materials/666/metalgrate013a2.vmt` ⇒ 精确路径找不到，
于是连**作者的 `$alphatest` / `$translucent` 声明**一起丢掉。实测 68 种世界贴图里 **14 种（8400 面）**
只有基名命中，其中 13 种的 `$basetexture` 与材质名逐字符相同（即作者对同一张贴图的重写）。

### 2.4 回退路径丢掉 alpha 语义

`Err` 分支返回 `MaterialData::default()`（`translucent: false` / `alpha_test: None`）：即使回退包把
**带镂空的低清贴图**给了材质，材质仍然是 `OPAQUE`。§2.1–§2.3 里丢掉的贴图/语义，最终都表现为这一个结果。

### 2.5 `$alphatest 1` 的 cutoff 单位

`vmt_parser::Material::alpha_test()` 返回的是 `$alphatestreference`，未声明时是它的默认值 **1.0**。
glTF 的 `alphaCutoff` 是 [0,1] 的**阈值**语义（规范默认 0.5），Source 侧 `$alphatestreference` 默认也是 0.5。
透传 1.0 会把 `alpha=254` 的像素一并裁掉。

### 2.6 未识别着色器丢掉 `$color`

`Wireframe`（`dev_nyro/blends/wire_white`）不在 `vmt_parser` 的材质枚举里 ⇒ 解析失败 ⇒ 回退纯白。

## 3. 修复

| # | 位置 | 改动 |
|---|---|---|
| ① | `crates/wasm-core/bsp_to_gltf_core/materials.rs` `fallback_key` / `fallback_texture_png` | 回退表键统一为 `materials/<贴图路径小写>`（反斜杠归一），并提供「按候选路径依次查表 → 低清 PNG」的共享入口 |
| ② | 同上 `load_material_bsp` 贴图段 | pakfile 无 VTF 时**在本函数内**查回退包（先 `$basetexture`、再材质名），**保留本 VMT 已解析的 `$translucent`/`$alphatest`** |
| ③ | 同上 VMT 查找 | 精确路径全部落空时按**基名**回退（`ConvertOptions::vmt_stem_index`，由导出入口用 `entry_names` 构建；同名多条取路径最短者） |
| ④ | 同上 alpha 归一 | `$alphatest` 的 reference ≥1.0 或 ≤0 时归一到 0.5 |
| ⑤ | `bsp_to_gltf_core/gltf_builder.rs` `texture_has_alpha_holes` + `push_material` | 未声明透明的材质，若**贴图自带镂空**（`alpha<32` 像素占比 ≥1%）则补判 `MASK`（cutoff 0.5）——`alpha=0` 在 glTF 里只有裁掉或混合两种正当解释 |
| ⑥ | `crates/wasm/src/lib.rs` `resolve_pakfile_materials` | PAKFILE 模型材质：pakfile 无 VTF 时按 **`$basetexture`** 查回退包（`fallback: Option<&HashMap>`，仅 `*_with_defaults*` 入口传入；碰撞体与 mosaic manifest 入口传 `None`，行为不变） |
| ⑦ | `bsp_to_gltf_core/materials.rs` `parse_dollar_color` | 未识别着色器 / 无 `$basetexture` 时用作者声明的 `$color`，不再一律纯白 |

**为什么不直接给这些材质补 VMT**：`metal/metalgrate013a` 等是 **stock HL2 材质**，其 VMT/VTF 都不在 pakfile 内
（`materials/metal/metalgrate013a.vmt` 不存在，pakfile 只有 `materials/666/metalgrate013a.vmt`）。
所以修复用的都是**可核查的数据**：作者同基名 VMT 的声明、默认纹理包里贴图自身的 alpha 通道。

## 4. 影响面（`--baseline` diff，`test:verify-alpha-materials`）

与修复前 GLB 逐材质对比（119 个材质）：

| 变化 | 数量 | 明细 |
|---|---|---|
| `alphaMode` 变化 | 3 | `metal/metalgrate013a` `OPAQUE→MASK`；`metal/metalgrate013b` `OPAQUE→MASK`；`metal/metalgrate013a2` `OPAQUE→BLEND` |
| 新增贴图 | 28 | 全部是「pakfile 无 VTF / 材质名 ≠ `$basetexture`」那一类（含 `metalfence007a`、`metalgrate013*`、`dev_concretefloor006a`、`stonewall032a` …） |
| `baseColorFactor` 变化 | 1 | `dev_nyro/blends/wire_white` `1,1,1 → 0.286,0.286,0.286`（`$color { 73 73 73 }`） |

无贴图材质 **45 → 18**；`MASK=8 / BLEND=11 / OPAQUE=100`。
**物理与碰撞零改动**：碰撞体入口 `resolve_pakfile_materials(..., false, None)` 与
`load_material_bsp` 的 alpha 语义只影响 glTF 材质，`export_model_tri_colliders` 的透明度门控未接
`vmt_stem_index`（避免 `$translucent` 面被改成可穿过）。

## 5. 验证

**导出侧（可重复，入库脚本）**：

```bash
cd test/game-core
npm run test:verify-alpha-materials        # ① 镂空贴图不得 OPAQUE ② 铁丝网必须有贴图 ③ 无镂空不得 MASK
```

实测（`crates/wasm-core` 修复后重建 wasm）：9 个铁丝网/格栅材质全部 `MASK`/`BLEND` + 贴图，
`metalgrate016a` 2.3% / `metal/metalgrate013b` 11.8% / `metalfence007a` 17.6% /
`metal/metalgrate013a` 28.2% / `metal_grate_07` 30.5% 镂空；断言全通过。

**运行时（浏览器内，证据取自实际场景对象）**：`[alpha] 场景材质 alpha 状态` 日志 + 离屏 RenderTarget 量测
（`temp/real-shot.mjs` 注入地图后逐材质取景）：

| 材质 | alphaTest | 透明（`transparent`） | 剪影内孔洞占比（品红背景判据） |
|---|---|---|---|
| `metalgrate013a`（prop） | 0.5 | false | **24.8%** |
| `metal/metalgrate013b`（世界面） | 0.5 | false | **12.5%** |
| `metal_grate_07` | 0.5 | false | **8.9%** |
| `metalfence007a` | 0 | true | **7.6%** |
| `metal/metalgrate013a`（世界面，近距 185 单位） | 0.5 | false | **4.4%**（同一贴图，远景被 mip 平均压低） |
| `metalgrate016a` | 0.5 | false | 2.3%（= 贴图孔洞率） |

量测口径：只显示目标那一块 mesh（排除同组自遮挡）+ 品红背景 ⇒「真实状态露出品红且落在强制不透明剪影内」
的像素占比。`metal/metalgrate013a` 的近距图（`temp/shots/ws_A_real.png`）可见规则品红方格阵列，
即孔洞真的被裁掉。

**门禁**：`typecheck` 0、`check:api` 17+17、`test:lightmap-guard` 40/40、`test:phys` 五指纹全绿。

## 6. 已知限制

1. **`Wireframe` 的线框语义未复现**：`dev_nyro/blends/wire_white`（世界面 8 个）现在按作者声明的
   `$color 73 73 73` 画成深灰实体面；Source 侧该着色器只画多边形边线（近透明）。要在 three.js 复现需要
   导出时给材质打标记 + 运行时 `material.wireframe`，本轮未做（它不声明 `$translucent`/`$alphatest`，
   属于另一类缺陷）。
2. **远景下格栅会被 mip 平均「糊实」**：`alphaTest=0.5` 对 mip 平均后的 alpha（孔洞 28% ⇒ 平均 ≈0.72）
   不再裁切，远处格栅看起来偏实。Source 的 alpha test 有同样行为；若要远景也透气，需要
   `alphaToCoverage` 或对镂空材质关闭 mipmap，属渲染口径变更，未做。
3. **基名回退是「同基名」关联**：14 种世界贴图里 13 种的 `$basetexture` 与材质名逐字符相同（强证据）；
   唯一例外 `METAL/METALGRATE013A2` 采用 `666/metalgrate013a2.vmt` 声明的 `metal/metalgrate013a`
   + `$translucent 1`（作者对同族材质的重写）。若未来遇到基名同名但语义无关的地图，需要收紧规则。
4. **默认纹理包是低清（mosaic ×8，源格 64×64）**：孔洞比原版更粗，近景可辨认、远景更容易被平均掉。

## 7. 复现与量测脚本

| 用途 | 位置 |
|---|---|
| 导出侧回归断言（入库） | `test/game-core/scripts/verify/alpha-materials.mjs`（`npm run test:verify-alpha-materials`） |
| BSP/pakfile 侧事实普查（一次性） | `test/game-core/temp/fence-surfaces.py`、`temp/vmt-vs-glb-alpha.py`、`temp/alpha-blindspot.py` |
| GLB 逐材质/贴图 alpha 普查（一次性） | `test/game-core/temp/alpha-truth-dump.mjs` + `temp/alpha-truth-stats.py` |
| 运行时取景/裁剪量测（一次性，需临时探针句柄） | `test/game-core/temp/real-shot.mjs` + `temp/eval-grate-permat.mjs`、`temp/eval-world-grate-sweep.mjs` |

> 一次性脚本按 [AGENTS.md](../../../AGENTS.md) §3 留在临时区（不入库，随时可清）；本节记录的**方法与判据**已提升入库脚本。
