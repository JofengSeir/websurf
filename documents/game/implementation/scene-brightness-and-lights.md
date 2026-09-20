# game 实现：场景亮度与运行时光源（架构事实与可调项）（I）

> 调查背景：prop ambient cube 落地（P1）后用户反馈「**整体太暗**、**模型比预烘焙的其它区域更暗**」，并要求检查**光源光照部分**（预烘焙侧暂不复查）。
> 本文给结论：**「运行时光源没应用」是架构事实，但它不是「整体偏暗」的原因**——因为当前管线里**没有任何一个像素会吃灯**。真正的亮度旋钮只有烘焙项本身。
> - 落点工程：`test/game-core`（绝对隔离，见 [../../../AGENTS.md](../../../AGENTS.md) §2.1）。three 版本 0.165.0（`test/game-core/node_modules/three/package.json:3`）。
> - 相关篇：[prop-ambient-lighting.md](./prop-ambient-lighting.md)（prop 静态光照现状与 §8 定位）、[prop-ambient-fix-plan.md](./prop-ambient-fix-plan.md)（P1/P2/P3 施工方案）。

---

## 1. 结论速览

| 现象 | 真实原因 | 可否用「加灯」解决 | 该怎么做 |
|---|---|---|---|
| 整体太暗 | world 面 = `albedo × lightmap`，lightmap p50 = 5.83e-2 ⇒ 中灰 albedo 下约 29~35/255（sRGB）；**图本来就这么暗**（上尾 p99.9 = 1.035 证明解码量级正确，§4.2） | ❌ 加了也不生效（见 §2） | 曝光默认 1.0 + 用户侧亮度滑块（1.0~3.0）；**「均值 80~120」「曝光 24」已作废** |
| prop 比 world 更暗 | P1 之后 prop 从 fullbright 变成 `× ambientCube`，而 ambient 解码值 p50 = 4.28e-5，比 lightmap 暗 **1362×** | ❌ | 做 P3（[prop-ambient-fix-plan.md](./prop-ambient-fix-plan.md) §4） |
| 运行时光源没应用 | 架构事实：全部 mesh 都是 `MeshBasicMaterial`；且 world 几何无法线 | ❌ 结构性不可能 | 若要真光源，须先补法线（§5） |

---

## 2. 为什么「加灯」在当前管线里一个像素都不会变

三道闸门，逐道都是硬性的：

1. **legacy 三点光已关**（`test/game-core/src/renderer/renderer-main.ts:271-278`）：`LEGACY_THREE_POINT_LIGHTS = false`，`AmbientLight` / `HemisphereLight` / `DirectionalLight` 根本没加进场景。
2. **GLB 带的两千盏灯被中和**（同文件 `:300-324`，§1.1）：GLB 已携带全部 `light` / `light_spot` / `light_environment`（surf_666 = 2118 盏、surf_null = 3067 盏，含 color / intensity / direction / range，见 `test/game-core/crates/wasm-core/model_integrator/mod.rs:578-634`），渲染端**在挂进 `this.scene` 之前**把它们 `removeFromParent()` 从场景树摘除（**不是**只置 `visible = false`，也**不能**等挂载之后再中和 —— 两个坑的真实出帧证据见 [prop-black-materials-root-cause.md](prop-black-materials-root-cause.md) §8.4）。
3. **决定性的一条：所有 mesh 都是 `MeshBasicMaterial`**。
   `applyLightmapToMeshes`（`test/game-core/src/renderer/lightmap-shader.ts:346`，契约同文件 `:18-20`）对场景里**每一个** mesh 做二选一：
   **只有** `geometry.userData.hasLightmap === true`（真实 luxel）才换成 Basic + 注入解码；`hasLightmap === false`（中性占位 UV，契约 §9.6.1）与无 lightmap UV 的两类**一律**换成 Basic(fullbright) 贴图原色（`routeFullbright`，`:392`）。
   ⚠️ `hasLightmap === false` 的判定**必须在检测 uv1/uv2 之前**：导出侧（`crates/wasm-core/bsp_to_gltf_core/convert.rs:1004-1014`）对这类面**照样写 `TEXCOORD_1`**（值恒为中性常量 `(0,0)`，为保住几何合并的属性集一致）⇒ 若先判 uv1 就会把它们送进 lightmap 路径、全部采到图集原点那一个像素（2026-09-20 实测该像素 = `0,0,0` 纯黑 ⇒ 整片水面等 440 个图元发黑，见 [prop-black-materials-root-cause.md](prop-black-materials-root-cause.md)）。
   `MeshBasicMaterial` **不参与光照计算**（无 `NUM_POINT_LIGHTS`、无 `lights_fragment_begin`）⇒ 即使把那两千盏灯全部打开并恢复三点光，**画面零变化**。

补充事实：

- `test/game-core/src/renderer/renderer-main.ts` 中**没有** `toneMapping` / `toneMappingExposure` / `scene.environment` 的任何设置（grep 全文件无命中）；`outputColorSpace = SRGBColorSpace`（`:245`）。
- 背景是**死的** `new THREE.Color(0x222222)`（`:271`），**没有天空盒** ⇒ 天空区域是纯灰，也不提供任何环境光 / IBL。

---

## 3. prop 更暗：P3 未做的直接后果（不是新问题）

| 项 | 数值（surf_666，同套 RGBExp32 解码） |
|---|---|
| lump56 ambient cube p50 | 4.28e-5（p90 3.14e-4、max 1.65e-3） |
| lump8 lightmap p50 | 5.83e-2（p90 2.90e-1、max 1.87e+0） |
| 比值 | **1362×** |

P1 之前 prop 走 fullbright（`× vec3(1.0)`）⇒ 偏亮；P1 之后 prop 真的乘上了 cube ⇒ **近黑**。这与「现在变得更暗了，比预烘焙的其他实体材质区域更暗」完全吻合，也与 P1 出帧的「近黑 11.9%」自洽。

修完 P3（`mantissa × 2^exp`，不除 255）后 prop ≈ world 的 **0.6 ~ 0.9 倍**——**仍比 world 略暗，这是正确的**：Source 的 static prop 只吃 ambient cube（无直射光的烘焙），而 world 面的 lightmap 含直射 + 间接。想要「prop 与 world 一样亮」反而是错的口径。

---

## 4. 「整体太暗」：可用的亮度旋钮

### 4.1 先排除一个误判：不是又算错了一次 gamma

- 出帧均值 20~26/255 与「中灰 albedo × lightmap p50」的理论值（29~35/255）同量级 ⇒ 画面暗是**数据本身**的量级，不是多除了一次 π 或多做了一次 gamma。
- `RECIPROCAL_PI` 不存在于本项目路径：注入把 three 的内联块整体替换掉了（`lightmap-shader.ts:136-138`，replacement 里没有 `RECIPROCAL_PI`）。
- ⚠️ 但有一处**残留旧口径**：`test/game-core/scripts/lightmap-decode-selftest.mjs:27-31` 的 `applyLightmapToColor` 仍在 `pow(decoded, 1/2.2)`（外部参照实现 sRGB 直出口径）。它**只存在于自测脚本**（渲染侧已在 gamma-parity 轮矫正、文件头有说明），不影响画面，但会误导后来的读者——建议下一轮清理。

### 4.2 曝光旋钮（S1 已落地）⚠️ 2026-09-19 复议：校准结论作废

**实现（保留）**：`lightmap-shader.ts` 给 `vbsp_ApplyLightmap` 的返回值（`:68`）与 `vbspAmbientWeight()`（`:564`）各乘 `uniform float vbspExposure;`；两处 `onBeforeCompile` 赋值（`shader.uniforms.vbspExposure = { value: readExposure() }`，`:369` / `:542`）；`readExposure()`（`:607-612`）读 `globalThis.__vbspExposure`，**默认恒为 1.0**（代码里没有硬编码任何标定值，24/5 只存在于出帧 A/B）。

#### ❌ 作废的两条（原 §4.2 遗留）

1. **「出帧均值 80~120/255」判据作废**——它是本工程自定义的标尺，从未与 Source 语义或外部参照实现实测对照过。
2. **「surf_666 曝光=24 / surf_null 曝光=5」作废**——见下方削顶计算。

实测曲线仍存档（surf_666 spawn，mean）：1.0→19.4、2→27.0、3→32.8、4→37.5、6→45.3、8→51.7、10→57.2、12→62.1、16→70.6、20→78.0、24→84.4。

#### ✅ 新证据：解码量级是对的，图本来就这么暗（动态范围体检）

`temp/lightmap-dynamic-range.mjs`（临时脚本）对 surf_666 lump8 全量抽样 20 万 texel：

| 分位 | p50 | p75 | p90 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|
| 解码值 | 5.83e-2 | 1.24e-1 | 0.290 | **0.878** | **1.035** | **2.086** |

占比：`>0.1` 31.4%、`>0.3` 9.7%、`>0.5` 5.7%、`>1.0` 0.32%。

**判读**：上尾本来就落在 **1.0 附近并超过它**（p99.9 = 1.035、max = 2.09）——这正是 Source LDR lightmap 该有的动态范围形态：被天光/强灯直射的 luxel 接近"白"。若解码系统性缺系数（例如少乘 255），上尾会是 0.008 量级；若多乘，上尾会是 500 量级。**两者都不是** ⇒ `m/255 × 2^exp` 的量级正确，surf_666 的中位数暗（0.058）是**地图本身**的性质（用户确认："surf_666 原本确实比较暗"）。

#### ❌ 为什么曝光 24 是错的（削顶计算）

曝光 E 下，最终线性值 = `albedo × lightmap × E`，≥1.0 即削顶为纯白。取中灰 albedo 0.5：

| 曝光 | p90(0.290) | p99(0.878) | 结果 |
|---|---|---|---|
| 1.0 | 0.145 → sRGB 0.42 | 0.439 → sRGB 0.69 | ✅ 高光保留层次 |
| 2.0 | 0.290 → sRGB 0.57 | 0.878 → sRGB 0.94 | ✅ 高光刚好到顶不溢出 |
| **24** | **3.5 → 削顶白** | **10.5 → 削顶白** | ❌ `lightmap > 0.083` 的面在中灰 albedo 下全部过曝 |

⇒ 曝光 24 会把 `lightmap > 0.083` 的面（约占 35%）在中灰贴图下**削成纯白**，而均值只有 84 是因为中位数仍暗——典型「高光削顶 + 暗部仍暗」的坏曲线，正是用户反馈的「整体都特别亮（且没有层次）」。

#### 新的推荐口径

- **默认曝光 = 1.0（忠于 BSP 数据）**；亮度做成**用户侧显示设置**（滑块 1.0 ~ 3.0，建议上限 3.0——超过 3.0 起 p90 面开始削顶）。
- **不做 per-map 曝光常数**：surf_666 与 surf_null 基线亮度差 2.2× 属地图本身差异（两张图的灯光配置不同），为拉平而各设常数等于替地图做美术决策。
- 语义定位：等价于 Source 的 `mat_monitorgamma` / 亮度设置，**是显示侧设置，不是数据修正**。

#### 落地形态（2026-09-19 完成）

| 层 | 位置 | 内容 |
|---|---|---|
| 配置 | `src/config.ts` | 新增 `LightingConfig { exposure }`，`RuntimeConfig.lighting`，默认 **1** |
| uniform | `src/renderer/lightmap-shader.ts` | **所有材质共享同一个 `exposureUniform` 对象** ⇒ 拖动滑块即时生效，不触发材质重编译（若每材质各自 `{ value }`，改值只能靠 `needsUpdate` 重编几千个 program） |
| 渲染器 | `src/renderer/renderer-main.ts` | `init(config)` 里 `setExposure(config.lighting?.exposure ?? 1)`；新增 `setExposure(v)`（与 `setFov` 同形态） |
| 面板 | `src/panel/panel-controller.ts` + `web/index.html` | 显示模块新增「亮度（曝光）」滑块，1~3 / step 0.05；走 `onSyncExposure` 回调（与 FOV 同款接线）；进 `collectPrefs` / `loadPanelPrefs` / `syncControlsFromConfig` / `sendAllPrefs` 持久化链路 |
| app 接线 | `src/app.ts` | `(exposure) => renderer?.setExposure(exposure)` |

实测（surf_666 spawn，同一位姿，`--exposure` 注入）：

| 曝光 | 平均亮度 | 中位/p90/max | 近黑占比 | 判读 |
|---|---|---|---|---|
| **1.0（默认）** | 19.424 | 17 / 34 / 231 | 12.23% | 忠于数据；但暗部占比偏高 |
| 2.5（滑块中段） | 30.044 | 32 / 53 / 231 | **0.68%** | 暗部细节回来，高光未削顶 |

两个边界行为（均已确认为预期）：

1. **曝光只作用于烘焙项**（有 lightmap 的 world 面 + 有 cube 的 prop）。无 cube 的 fullbright 面按外部参照实现口径保持「贴图原色」，不随滑块变化 ⇒ 上表两档 max 同为 231（来自全亮贴图面）即为此故。
2. **出帧 A/B 覆盖优先**：注入 `window.__vbspExposure` 时，面板/config 的写入被忽略（`setExposure` 内短路）。否则面板构造时的 `sendAllPrefs → onSyncExposure` 会把注入值立刻冲回默认 1（实测会发生）。

> ⚠️ 施工教训（保留）：`stageProlog` 是 async 函数——拼接曝光 prolog 时漏 `await` 会让注入源变成字符串 `"[object Promise]"`（静默 SyntaxError，曝光零效果）；已修（capture 脚本 :497）。`surface` 位姿的物理冻结不稳定（玩家掉落卡墙缝，帧间构图不可比）——亮度判据一律用 `spawn` 位姿。

### 4.3 旋钮二（用户暂缓）：复查 LDR lightmap 解码

一句话记录现状，便于日后重启：同一套解码下 world 的中位亮度只有 5.8e-2；若怀疑 LDR lump 相对 HDR 还有一层 gamma / 曝光编码，需要拿**同时存在 lump8 与 lump53 且均已解压**的地图做逐 texel 对照。
注意：本地三张图里 surf_null 的 lump8/lump53 **都是 LZMA 压缩**（`ident = 22961620`），直接按原始字节读会得到 1e±30 的假数据；`ze_cursed_bear_tales_v1_2.bsp` 只有 lump53（HDR）、lump8 为空；只有 **surf_666 的 lump8 是未压缩的**（当前全部结论都基于它）。

---

## 5. 若真要「运行时光源」：前置条件与代价

| 步骤 | 内容 | 代价 |
|---|---|---|
| 1 | world 几何补法线：`BspVertexData` 现在只有 `position` + `uv`（`test/game-core/crates/wasm-core/bsp_to_gltf_core/convert.rs:1167-1170`），需按面法线（或按 plane normal）生成 NORMAL 访问器 | Rust 侧改动 + 重编 wasm + 顶点体积增大 |
| 2 | world 面改用受光材质，且**必须屏蔽 lightmap 的重复计光**（VRAD 已把灯的贡献烘进图集，运行时再打 = 二重计光） | 光照语义重构，等于推翻外部参照实现口径 |
| 3 | 灯源筛选：两千盏 punctual 灯不可能全用（three 的 `NUM_POINT_LIGHTS` 上限 + 性能），只可能挑 `light_environment` + 最近 N 盏 | 需要一套取舍规则 |
| 4 | 天空盒 / IBL：当前背景是死灰，需要 skybox 或 `light_environment` 颜色兜底 | 新增资产通道 |

⇒ **现阶段不建议做**。Source 与外部参照实现的既定口径就是「world = 纯烘焙乘算、运行时零灯」，本工程与之一致；亮度问题用 §4.2 的曝光旋钮解决即可。

---

## 6. 本轮施工计划（S1 → S5，每步独立可回退）

**前置条件**：P1（Group 回溯）与 P2（VS 锚点）已落地并通过回归；若未落地，先按 [prop-ambient-fix-plan.md](./prop-ambient-fix-plan.md) §2/§3 做完再看本文。

**为什么先做曝光（S1）再做 P3（S2）**：曝光是 world 与 prop **同乘**的全局系数 ⇒ 它不改变「prop / world 的亮度比」。所以可以先用 world 判据把曝光定下来（立刻解决「整体太暗」，且只需改 TS、不用重编 wasm），再用比值判据定 P3，两者互不干扰。

### S1 全局曝光旋钮（只改 TS）

改 `test/game-core/src/renderer/lightmap-shader.ts`，三处：

1. GLSL 常量：在 `VBSP_APPLY_LIGHTMAP`（`:51-68`）的返回行乘曝光；在 `applyAmbientCubeIfAny` 的 `vbspAmbientWeight()`（`:540-547`）返回行乘同一个曝光：
   ```glsl
   return max(decoded, vec3(0.0)) * vbspExposure;   // VBSP_APPLY_LIGHTMAP
   return c * vbspExposure;                          // vbspAmbientWeight()
   ```
2. uniform 声明：与 `vbsp_AtlasSize` 并列（`:474` 的 `updated = 'uniform vec2 vbsp_AtlasSize;\n' + injected + updated;`）改为同时声明 `uniform float vbspExposure;`；`applyAmbientCubeIfAny` 的 `ambFn` 数组里同样补一行声明。
3. uniform 赋值：两处 `onBeforeCompile` 内各加一行——
   ```ts
   shader.uniforms.vbspExposure = { value: readExposure() };
   ```
   ```ts
   function readExposure(): number {
     const g = globalThis as { __vbspExposure?: unknown };
     return typeof g.__vbspExposure === 'number' && g.__vbspExposure > 0 ? g.__vbspExposure : 1;
   }
   ```
   （出帧 A/B 走 `window.__vbspExposure`，与既有 `__vbspLightmapStage` 同一注入通道；默认 1.0 不影响正常游玩。）

配套：给 `test/game-core/scripts/lightmap-frame-capture.mjs` 加 `--exposure <n>` 参数（与 `--stage` 同机制，经 `Page.addScriptToEvaluateOnNewDocument` 注入 `window.__vbspExposure`），否则每档都要手改代码。

✅ **S1 已于 2026-09-19 完成**（实现清单与实测见 §4.2「落地形态」）。最终判据：

| 判据 | 期望 |
|---|---|
| 默认值 | `lighting.exposure = 1`（忠于 BSP 数据）；面板滑块 1~3 / step 0.05 |
| 旋钮生效 | 同图同位姿：曝光 1 → 均值 19.424、近黑 12.23%；曝光 2.5 → 均值 30.044、近黑 0.68% |
| 无副作用 | `npm run typecheck` 通过；`__vbspLightmapInject.applied` 仍为 true；无 `[ambient-cube] 注入未生效` |

⚠️ 下方两行是**已作废的旧判据**，保留仅为审计轨迹，不得再作为验收标准：~~「扫 1.0/2.0/3.0/4.0 取均值 80~120/255」~~、~~「死白(≥250) 占比 < 1%」~~——前者是脱离 BSP 语义的自定义标尺，会把 surf_666 这类暗图推到高光削顶。

**回退**：删两处曝光乘法与共享 uniform（或直接 `setExposure(1)` 固定）。

### S2 prop 量级（P3，改 Rust）

按 [prop-ambient-fix-plan.md](./prop-ambient-fix-plan.md) §4 落地 `decode_linear_ambient()`（不除 255）+ `AMBIENT_SCALE`。本轮判据改用**比值口径**（不受曝光影响）：

| 判据 | 期望 |
|---|---|
| prop / world 亮度比 | 同一位姿下 **0.7 ~ 1.0**（低于 0.7 偏暗、高于 1.0 说明调过头） |
| 近黑率 | prop 区域近黑像素占比与 world 面**同量级**（不再出现成片死黑） |
| 朝向差异 | prop 朝上/朝下面仍有明暗差（法线加权生效，P2 的连带验证） |

**回退**：改回 `decode_linear()`。

### S3 兜底中性灰（可选，S2 之后）

`NEUTRAL = [0.2139; 18]`（`crates/wasm-core/vbsp/mod.rs:523`）在新口径下偏亮（≈ lightmap 0.73 的水平，亮于全图 90% 的面）。改为「全图 ambient 中位数」或「全图 lightmap 中位 × 0.318」。判据：兜底 prop（surf_666 62 个）不得明显亮于周围 world 面。

### S4 清理自测脚本的旧 gamma 口径

`test/game-core/scripts/lightmap-decode-selftest.mjs:27-31` 的 `applyLightmapToColor` 仍在 `pow(v, 1/2.2)`（外部参照实现 sRGB 直出口径），与渲染侧已矫正的线性口径不一致。改成 `base[i] * Math.max(v, 0)`，并在注释里写明「渲染侧不再做显示 gamma，由 three 的 colorspace_fragment 承担」。判据：`npm run test:lightmap-decode` 仍全绿。

### S5 全量回归 + 两图出帧

- 回归：`npm run typecheck` / `test:lightmap-gltf`（82 断言）/ `test:lightmap-decode` / `test:lightmap-guard` / `check:api` / `test:phys`（五指纹）/ `test:seed-smoke`。
- 出帧：surf_666 与 surf_null 各 `--pose spawn` 一张，附平均亮度 / 近黑率 / 死白率三数入档。
- 最终把**选定的曝光值**与**选定的 `AMBIENT_SCALE`** 写回本文 §4.2 与 [prop-ambient-fix-plan.md](./prop-ambient-fix-plan.md) §4.4。

### S6（可选，低成本）天空背景

用 GLB 里 `light_environment` 的颜色替换死灰背景 `new THREE.Color(0x222222)`（`src/renderer/renderer-main.ts:281`），让天空区域不再是纯灰，也顺便给画面一个色调基准。注意：只改 `scene.background`，**不要**顺手打开那两千盏 punctual 灯（§2 已论证：开了也是零效果，且污染 uniform 上限）。

> 回归底线不变：`test:phys` 五指纹（gravity -12.50/tick、landing tick 31、jump 289.49、crouch 46.04、teleport tick 24）与 `test:lightmap-gltf` 82 断言。
> 顺序不可换的理由：先定曝光（世界亮度基线）→ 再定 P3（prop 与世界的关系）→ 最后修兜底与清理。反过来做会把两套判据搅在一起（曝光未定时「prop/world 比」虽然不变，但人眼判读会被整体亮度牵着走）。

---

## 7. 多方向排查记录（2026-09-19 第二轮）

用户反馈「偏暗问题仍在」，要求把**光源**与**材质**两侧都再挖一层。四个方向，逐个给结论与证据。

### 7.1 方向一：点光源 / 其他光源 —— 已用实验证伪「加灯能提亮」

不再只是代码推理，做了 A/B 出帧（surf_666 spawn，`LEGACY_THREE_POINT_LIGHTS` 开关，代码里本就预留了这个对比开关）：

| 三点光 | 平均亮度 | 中位/p90/max | 直方图（8 桶） |
|---|---|---|---|
| 关（现状） | **19.424** | 17 / 34 / 231 | 570900 \| 216388 \| 241 \| 114 \| 142 \| 343 \| 594 \| 46 |
| 开（Ambient 0.6 + Hemi 0.4 + Dir 0.5） | **19.425** | 17 / 34 / 231 | 570898 \| 216384 \| 245 \| 112 \| 148 \| 341 \| 594 \| 46 |

⇒ **零效果**（差值 0.001，来自物理漂移；直方图逐桶一致）。三层原因见 §2（材质全 `MeshBasicMaterial` / world 几何无 NORMAL / GLB punctual 灯已从场景树摘除）。
⇒ 结论修正：不是「忘了接灯」，而是「接了也接不上」。想让运行时灯真正生效，前置条件是 **给 world 几何补法线**（§5），那是一个独立大工程，不在本轮。

### 7.2 方向二：材质层 —— 「49% 无贴图」是我的测量假象，真实缺口 8%

第一版脚本直接把 `defaultsJson = '{}'` 传给导出入口，得出「319 个材质里 129 个无贴图、49.2% 的 primitive 用哈希回退色」。**这是错的**：真实链路（`src/ts-shared/phys/world-builder.ts:179-190`）会先 `decompress_mtz(web/textures.mtz)`（**9448 项**）再传给导出入口。重测：

| 口径 | 有贴图材质 | primitive 无贴图占比 |
|---|---|---|
| 传 `{}`（假） | 190 / 319 | **49.2%** |
| 传 mtz 默认包（真实） | 219 / 319 | **8.0%**（2759 / 34409） |

⇒ 材质覆盖不是亮度主因（回退色有 `max(0.3)` 下限，线性域 0.3 ≈ sRGB 0.6，不暗）。

**但材质层确实还有未解析项**（这一条成立）：

- VMT 只解析 **`$basetexture` + 透明标注**（`$translucent` / `$alphatest` / `$alpha`），见 `crates/wasm-core/pakfile_models.rs:115-131`；
- 未消费：`$color`（调制色）、`$selfillum`（自发光）、`$phong` / `$phongboost`（高光）、`$envmap` / `$envmapmask`（环境反射）、`$detail`、`$lightwarp`、`$bumpmap`；
- world 侧更粗：连 VMT 都不读，只按 texdata 名找贴图。
- 影响面：自发光 / 反射 / 调制类材质会偏暗偏平，**不影响基础 albedo 的整体亮度**。

### 7.3 方向三：lightmap 是不是采错了图集区域 —— 没采错（UV 逐面对撞）

此前没人验过这一条（82 条断言只覆盖打包统计量，不覆盖逐面 UV）。方法：从 BSP lump7 读每个面的 lightmap 尺寸 `(sx, sy)`，与该面图元的 `TEXCOORD_1` 跨度对撞（期望 `sx/atlasW`、`sy/atlasH`，atlas 4096×2048）：

| 项 | 结果 |
|---|---|
| 校验图元 | 33716 |
| 跨度/期望 比值 | p10 = 0.50、p50 = **0.91**、p90 = 1.00、max = 26.88 |
| 明显错位（>10× 或 <0.05×） | **78 / 33716 = 0.23%** |

比值略小于 1 是「UV 落在 texel 中心 ⇒ 跨度 = (size−1)/atlas」的正常约定（size=1 的面比值恰为 0.5）。⇒ **排除「采样落到 padding 黑边」**。

### 7.4 方向四：输出曲线口径差 —— 深暗部差 3.25×，且**单一曝光修不好**（新发现）

- 本工程：线性域相乘 + three 的 **sRGB** 曲线编码输出。
- 外部参照实现：gamma 2.2 域相乘 `return inColor * pow(sample, vec3(1/2.2));`（`.tmp/外部参照实现-master/.../Shaders/LightmappedBase.ts:45-67`），代数上等价于「用 γ2.2 编码乘积」。
- 二者在**深暗部**分歧最大（sRGB 曲线的线性段把极暗值压得更低）。中灰 albedo（sRGB 0.5 / linear 0.214）下的对撞：

| lightmap d（分位） | 本工程 sRGB | 外部参照实现 γ2.2 | 比值 | 追平所需曝光 |
|---|---|---|---|---|
| 0.005（p10） | 3.5 | 11.5 | **3.25×** | 3.27× |
| 0.02（p25） | 13.7 | 21.5 | 1.57× | 1.82× |
| 0.0583（p50） | 29.3 | 35.0 | 1.20× | 1.35× |
| 0.29（p90） | 70.5 | 72.6 | 1.03× | 1.06× |
| 0.878（p99） | 120.0 | 120.2 | 1.00× | 1.00× |

**关键含义**：所需补偿**随亮度变化**（暗部需 3.27×、亮部需 1.00×）⇒ **任何单一曝光常数都修不好**——补到暗部满意，亮部必然削顶（这正是 §4.2 里曝光 24 失败的定量解释）。

⇒ 若要对齐外部参照实现观感，正确的旋钮不是曝光，而是**换输出曲线**（γ2.2 编码），或加一条 **shadow-lift 曲线**（只抬暗部、不动亮部）。本帧 99.7% 像素 < 64/255，全部落在「差最大」的区间，所以这一条对本图观感的贡献可能比曝光更大。

## 8. 收官（2026-09-20）：全部亮度旋钮 = 外部参照实现平价 +「为什么这么暗」的定量归因

### 8.1 定案：默认值 = 参照实现的默认值（不再"看着调"）

要相等的是**光照项**（本工程 shader 的返回值）。本工程屏幕值 = `(albedo_linear × lightitem)^(1/2.2)`
= `albedo_srgb × lightitem^(1/2.2)`（albedo→linear 由 three 的 sRGB 解码给、末端 `^(1/2.2)` 由我们把
`colorspace_fragment` 换成 γ2.2 编码给、乘算来自 `three.module.js:14034` 的
`reflectedLight.indirectDiffuse *= diffuseColor.rgb;`）。令它与外部参照实现逐项相等：

| 路径 | 外部参照实现原文 | 本工程等价式 | 默认值 |
|---|---|---|---|
| world | `return inColor * pow(sample, vec3(1.0/2.2));`（`Shaders/LightmappedBase.ts:66`） | `lightitem = luxel` | 曝光 **1**、γ **1** |
| prop | `linearToScreenGamma(cube)` = `255*cube^(1/2.2)` 打包进顶点色 → `vVertexLighting = floor(enc) * (2.0/255.0)`（`StudioModel.ts:96-98` + `Shaders/VertexLitGeneric.ts`） | `lightitem = 2^2.2 × cube = 4.5948 × cube` | `PROP_CUBE_GAIN` **4.5948** |

其余：`lightFloor` **0**（外部参照实现无此项）、`ambientScale` **1**、面板三滑块默认全 **1**
（γ 量程 `pow(L,1/γ)` 下改为 0.5~4，γ=1 中性）。

> 历史值 12 / 24 / 2.3 / cube-gain 12/1.0 **全部作废**：
> 12/24 是把画面冲成粉白的"看着调"；2.3 是在"模型其实一个像素都没渲染"的画面里标定的；
> cube-gain 1.0 漏了外部参照实现顶点色编码里的那个 2×。

### 8.2 「暗」是数据使然：三层独立证据

1. **BSP 原始 lump（不经过我们的图集/渲染端）**：`scripts/verify/face_lightmap_stats.py`
   （`npm run test:verify-face-lightmap-stats`，本批入库的地面真值仪器）在**真实出帧位置**
   （Source 坐标 `-11520 -13536 15424`，由运行期 `cameraPose` 换算）半径 1200 内取到 134 个有光照面，
   其 lightmap 块均值 p25 = 0.053 / **p50 = 0.097** / p90 = 0.240；最近的 8 个面 0.097–0.228。
2. **外部参照实现平价倍率** = `luxel^(1/2.2)` ⇒ **0.35~0.51**，即表面渲成**贴图原色的 35%~51%**。
3. **实测对撞**：贴图 `#61483F` × 0.42 ≈ **`#291E1A`** —— 就是用户报的 `#25201D` 那一档
   （差异来自采样落在不同面）。⇒ **那个数字是参照实现的正确结果，不是缺陷。**

同一帧（`temp/eval-surface-meter.mjs`：把场景渲进 `WebGLRenderTarget` 后 `readRenderTargetPixels`）
的整幅统计：mean luma **21.1**、`luma<32` **83.3%**、`luma<12` **23.3%**；逐贴图命中点均值：

| 贴图 | 路径 | 命中 n | 均值 | luma 区间 |
|---|---|---|---|---|
| stone/marblefloor001b | lightmap | 78 | `#241a17` | 21..57 |
| brick/brickwall004a | lightmap | 60 | `#1c1210` | 12..35 |
| dev/dev_concretefloor006a | lightmap | 48 | `#392620` | 36..49 |
| glass/unbreakable | lightmap | 48 | `#120c0a` | 10..17 |
| tile/tilefloor016a | lightmap | 40 | `#110c0a` | 7..31 |
| glasswindow007a | cube（prop） | 8 | `#070504` | 3..7 |

两条路径同量级 ✓（world 面 `luxel^(1/2.2)` 与 prop `2×cube^(1/2.2)` 都在 0.25~0.45）——
这正是 §8.1 里那个 `2^2.2` 的依据。

### 8.3 想更亮：两个旋钮的定量映射

屏幕倍率 = `(pow(luxel, 1/γ) × 曝光)^(1/2.2)`：

| 目标 | 设置 | 定量 |
|---|---|---|
| **外部参照实现平价（现默认）** | 曝光 1 / γ 1 | 亮面 = 贴图原色的 0.35~0.51 |
| 「被照亮的面 ≈ 贴图原色」 | 曝光 **2.3** / γ **2.2** | luxel 0.097 ⇒ 倍率 **1.0**（= 2026-09-20 之前的默认） |
| 只抬暗部（保亮部） | 曝光 1 / γ **2.2~4** | 暗部按 `luxel^(1/2.2)` 抬、`luxel≈1` 处几乎不动 |
| 再亮一档 | 曝光 2 / γ 1 | 倍率 × `2^(1/2.2)` = 1.37 |

⚠️ 面板「暗部提升（γ）」在平价默认（γ=1）下**确实生效**：指数是 `1/γ` ⇒ γ=1 中性、γ>1 抬暗部。
§4.2 的旧口径（γ<1 提亮）已随 `pow(L, γ) → pow(L, 1/γ)` 的重写作废，量程与默认值同步改为 0.5~4 / 1。

### 8.4 采样链路逐环已验证（这次的"没问题"有出处）

| 环 | 本工程 | 参照（外部参照实现原文） | 结论 |
|---|---|---|---|
| 打包矩形 | `light_map_texture_size + 3`，落位后内缩 2 px | `LightmapLayout.cs:47-48` | 一致 |
| 区域 → UV | `min=(x+0.5)/W`、`size=(w-1)/W` | `LightmapLayout.cs:150-155 GetUvs` | 逐行一致 |
| 逐顶点 UV | `u = axis·pos + axis.w − LightMapTextureMinsInLuxels[u]`，`/ size`，再 `*size_x + min_x` | `Bsp/Geometry.cs:605-616` | 逐行一致 |
| atlas 采样 | `uv*atlasSize − 0.5` 取整到 texel 中心 + 四点 mix（NearestFilter） | `Shaders/LightmappedBase.ts` 的 `ApplyLightmap` | 一致 |
| RGBExp32 解码 | lightmap：`(byte/255)×2^(signed exp)` | shader 端 `sample.rgb*pow(2, a*255-128)`（图集已偏置） | 一致 |
| prop cube 解码 | `byte × 2^(signed exp)` | `Utils.ts rgbExp32ToVector3` + `Structures.cs:512-517`（`Exponent` 是 `sbyte`，打包时 `+128`） | 一致 |
| 乘算位置 | `reflectedLight.indirectDiffuse *= diffuseColor.rgb;`（注入替换掉了 `RECIPROCAL_PI`） | `inColor * ...`（外部参照实现无 1/π） | 一致 |

⇒ 与 §7.3 的「UV 逐面对撞」互补：**链路每一环都对着参照实现核过，暗是数据使然。**


#### 落地：光照项 gamma（shadow-lift）旋钮

实现（只改渲染侧，不需重编 wasm）：对**解码后的线性辐射度**做 `pow(d, γ)`，world lightmap（`VBSP_APPLY_LIGHTMAP`）与 prop ambient（`vbspAmbientWeight()`）两条路径共用同一个共享 uniform `vbspLightGamma`。

| 层 | 位置 | 内容 |
|---|---|---|
| uniform | `src/renderer/lightmap-shader.ts` | 共享 `lightGammaUniform`（默认来自 config）；`setLightGamma` / `getLightGamma` 导出；A/B 覆盖 `window.__vbspLightGamma` 优先 |
| 配置 | `src/config.ts` | `LightingConfig.lightGamma`，默认 **0.85** |
| 渲染器 | `src/renderer/renderer-main.ts` | `init(config)` 里 `setLightGamma(config.lighting?.lightGamma ?? 0.85)` + `setLightGamma()` 方法 |
| 出帧 | `scripts/lightmap-frame-capture.mjs` | `--gamma <n>`（与 `--exposure` 同机制） |

实测（surf_666 spawn，**曝光固定 1.0**）：

| γ | 平均亮度 | 中位/p90/max | 近黑占比 | 有光占比 |
|---|---|---|---|---|
| 1.00（修正前） | 19.424 | 17 / 34 / **231** | 12.23% | 55.66% |
| **0.85（选定）** | **22.438** | 21 / 39 / **231** | **3.88%** | 64.77% |
| 0.70（更亮档） | 26.093 | 27 / 46 / **231** | 0.54% | 73.22% |

**关键观察**：三档 **max 恒为 231** ⇒ shadow-lift 抬暗部的同时**一个高光都没削顶**（这就是它优于曝光的地方：曝光 2.5 时 p90 面已接近饱和，曝光 24 时约 35% 的面削顶）。

选 **0.85** 的理由：按 §7.4 的对撞，γ=0.85 时各分位与外部参照实现的残差 **< 10%**（p50：37.7 vs 35.0；p99：121 vs 120）；γ=0.70 会在中调区偏亮约 37%（p50：48 vs 35），属于「比 Source 更亮」的口味档，故不作默认，但数据留在表内供选择。

验证：默认档（不带 `--gamma`）出帧均值 **22.439**，与注入 0.85 的 22.438 一致 ⇒ config 默认值已生效。回归全绿（typecheck / lightmap-decode / lightmap-gltf 82 / lightmap-guard / check:api / phys 五指纹 / seed-smoke）。

**与曝光的关系**：γ 是**管线口径修正**（修暗部曲线形状，不动亮部），曝光是**用户亮度设置**（整体倍率）。两者可叠加，先 γ 后曝光。

### 7.5 剩余问题排序（按对观感的贡献）

| 序 | 问题 | 状态 | 修法 |
|---|---|---|---|
| 1 | prop 仍近黑（ambient 1e-4） | 已定位 | P3（[prop-ambient-fix-plan.md](./prop-ambient-fix-plan.md) §4） |
| 2 | 深暗部输出曲线差（1.2~3.25×） | ✅ **已修**（γ=0.85 shadow-lift，近黑率 12.23% → 3.88%，高光零削顶） | 见 §7.4；口味更亮可选 γ=0.70 |
| 3 | 材质未解析项（自发光/反射/调制） | 已定位 | 扩 VMT 解析（`$selfillum` / `$phong` / `$envmap` / `$color`） |
| 4 | 无天空盒 / IBL，背景死灰 | 已定位 | S6（background）+ 更远的话做 IBL |
| 5 | 8% 缺贴图（哈希回退色） | 已量化 | 补默认纹理包覆盖（46 个名字） |

### 7.6 ⚠️ 排查中发现的新矛盾（未解，已单独交接）

分解「整帧亮度 = albedo × lightmap」时三个数对不上（surf_666 spawn，曝光 1.0、γ=0.85）：

| 帧 | 平均亮度 | 中位 |
|---|---|---|
| 正常 | 22.439 | 21 |
| 仅 albedo（`--debug-albedo`） | 20.818 | 19 |
| 仅 lightmap（`--debug-lightmap`） | 99.162 | 108 |
| 不注入（`--stage noinject`） | 20.818（与「仅 albedo」逐桶一致） | 19 |

逐像素分解（`temp/factor-decompose.mjs`）：`lin(lm)` 中位 **0.1515**，但**有效 lightmap 系数** `lin(normal)/lin(alb)` 中位 **1.058**（应 ≈0.15）。
已排除：注入未生效（纯红探针证明正常路径确实调用了 `vbsp_ApplyLightmap`，`USE_LIGHTMAP` 已定义）、贴图二次解码（Rust 侧无 gamma 变换 ⇒ three 的 sRGB 解码正确）。

⇒ 头号待查项：**正常渲染下 lightmap 的有效系数 ≈1.0**。诊断仪器与待验证猜想清单见交接文档 `.tmp/scene-darkness-handoff.md`（§3）。

## 9. 追加查证（2026-09-20 第三轮）：`ramp_1` 的「预烘焙缺失」不成立，缺的是**梯度**不是量级

用户口径：**默认传送旁第一个坡模型**（`models/props/666/s1_ramp1b.mdl`）应渲成 ≈ `#60473F`，
实测 `#26211E`，判断为「预烘焙缺失或相关光照缺失」。

### 9.1 结论：预烘焙存在，且它本身就是暗的

`prop_static` 的静态光照在 Source 里有**两级**来源（外部参照实现的对应实现）：

| 级 | 来源 | 参照实现 |
|---|---|---|
| 1 | **逐顶点烘焙** `sp_<idx>.vhv` / `sp_hdr_<idx>.vhv`（地图 pakfile 内，VRAD 产出） | `Geometry.cs:855-895` + `ValveVertexLightingFile.cs` |
| 2 | leaf ambient cube（无 vhv 或置了 `StaticPropFlags.NoPerVertexLighting` 时的兜底） | `StaticProp.ts:39` |

本工程**只接了第 2 级**（`vbsp::Bsp::prop_ambient_cube`）。

实测（新入库仪器 `scripts/verify/prop_vertex_lighting.py`，**直读 pakfile**，不经本工程渲染管线）：

| 项 | 值 |
|---|---|
| pakfile 内 `sp_*.vhv` | **633 个**（653 个 prop 中 629 个有数据） |
| 全图逐 prop 顶点亮度中位数 → `vVertexLighting = byte×2/255` | p10 0.121 / p25 0.181 / **p50 0.244** / p75 0.334 / p90 0.414 / max 0.885 |
| `s1_ramp1b`（idx 264，默认传送旁） | p10 0.113 / **p50 0.211** / p90 0.570 / max **0.757** |
| 本工程 leaf-cube 路径同 prop 的倍率（`2 × cube^(1/2.2)`） | 0.23–0.40（全图 p50 ≈ 0.25） |
| 同位置 world lightmap 真值（`face_lightmap_stats.py`） | p50 0.097 ⇒ 倍率 0.347 |

⇒ **三个互相独立的来源量级一致（≈0.24–0.35）**：引擎自己渲这个坡也是"纹理色的 ~21%"
（`#60473F × 0.211 ≈ #140D0C`，比我们现在**更暗**）。
**我们没丢光照的量级；丢的是梯度**——第 1 级是逐顶点 0.113~0.757（亮部顶点应为
`#60473F × 0.757 ≈ #48352F`），我们只有"每 prop 一个平坦值"，所以坡面**没有任何明暗变化**，
观感即用户说的"像没有光照"。

### 9.2 因此：`#60473F` 只能由显示侧给（两个一键挡位）

| 挡位 | 设置 | 亮面 |
|---|---|---|
| 外部参照实现平价 | 曝光 1 / γ 1 | 贴图原色的 0.35~0.51 |
| **「被照亮的面 ≈ 贴图原色」（现默认）** | 曝光 **2.3** / γ **2.2** | ≈ 1.0（`#60473F` 量级） |

平价帧 mean luma 26.0 / 亮档帧 35.3（同机同视角，`luma<12` 分别 7.8% / 0.5%）。

### 9.3 下一步（**已做**，2026-09-20 第四轮）：接上第 1 级逐顶点光照

- 导出侧：按 prop 索引读 pakfile 的 `sp_hdr_<i>.vhv` → `sp_<i>.vhv`，解析后写自定义属性 `_VBSP_VLIGHT`；
- 渲染端：`lightitem = vLight^(2.2/γ) × exposure`（末端还有一次 γ2.2 编码 ⇒ γ=2.2 时与引擎逐顶点口径一致）；
- **顶点对应关系已核对**：vhv 各 mesh 顶点数**累加 = 模型顶点数**
  （idx 264：132 + 98 + 8 = **238** = GLB 每个 primitive 的顶点数；GLB 每个 primitive 都带全量顶点、用索引选面）
  ⇒ 按"模型顶点序号"直接挂；不一致时回退 leaf cube。
- 实施细节与实测数字见 §10。

## 10. 收官（2026-09-20 第四轮）：第 1 级逐顶点预烘焙**全量接入**并实测

### 10.1 数据链路（每一环都有仪器）

| 环 | 实现 | 位置 |
|---|---|---|
| 读 pakfile | 单次遍历 zip 顺带收 `sp_<n>.vhv` / `sp_hdr_<n>.vhv`（HDR 优先） | `test/game-core/crates/wasm/src/lib.rs`（`collect_pakfile_models`） |
| 解析 vhv | `parse_vhv` ⇒ `byte × 2/255` 倍率（对齐外部参照实现 `vVertexLighting = floor(enc) × 2/255`） | `test/game-core/crates/wasm-core/vhv.rs`（4 个单元测试，含 3 个负控） |
| 进 GLB | 逐实例的 `_VBSP_VLIGHT`（f32×3，stride 12）+ `extras.vertexLighting=true` | `test/game-core/crates/wasm-core/model_integrator/mod.rs` |
| 渲染 | `routeFullbright` 三级优先：`unlit` → **第 1 级 vlight** → 第 2 级 leaf cube | `test/game-core/src/renderer/lightmap-shader.ts` |

⚠️ 两个踩过的坑（已写进代码注释）：glTF 属性名 `_VBSP_VLIGHT` 到运行时会被 `GLTFLoader`
转小写成 `_vbsp_vlight`（常量 `VERTEX_LIGHTING_ATTR` 取小写）；`gltf-json` 的
`Semantic::Extras(name)` 会**自动补前导下划线**（传 `"VBSP_VLIGHT"`）。

### 10.2 穷尽审计：**零遗漏、零错位**

`temp/eval-vlight-audit.mjs`（CDP 现场遍历全场景）：

| 指标 | 值 |
|---|---|
| 场景 mesh 总数 | 2074 |
| 带 `_vbsp_vlight` 的 mesh | **395**（顶点合计 157,235） |
| 顶点数与 `POSITION` **不相等**的 mesh | **0** |
| 走第 1 级（材质注入生效） | **356** |
| 注入失败 | **0** |
| 带属性但未注入 | **39 = 全部为 `extras.unlit` 的自发光 VMT**（`blue_neon` / `neon666_01_krazyneon_00041v` / `glow_red_001` / `glow_yellow_008` / `69_red01` / `purple_dev_neon` / `blue_dev_neon`）⇒ 按 Source `UnlitGeneric` 语义**本来就不吃光照**，属正确 |
| **真漏网（非 unlit 且未注入）** | **0** |

⇒ 诊断口径已相应拆成四项（`renderer-main.ts` 的 `[vertex-lighting]` 行），
`真漏网 > 0` 时直接 `console.error`——避免以后把这 39 个误读成缺陷。

导出侧（GLB 静态数据，只解析 JSON chunk）与运行时**逐顶点数交叉核对**：

| 指标 | 值 |
|---|---|
| prop 节点 | **501**（其中 `vertexLighting=true` **473**，只有 `ambientCube` 的 28） |
| 图元 | 1098（带 `_VBSP_VLIGHT` **1052** / 不带 46） |
| GLB 侧属性顶点合计 | **157,235** |
| 运行时 395 个 mesh 的属性顶点合计 | **157,235** ⇒ 两侧**精确相等**（数据无损送达） |

⇒ 501 个 prop **无一裸奔**：473 个吃到第 1 级，其余 28 个（46 图元，无 vhv）吃第 2 级 cube。

### 10.3 实测：`ramp_1`（`s1_ramp1b`）现在渲成什么颜色

同一台机器、同一视角（相机在默认传送旁的坡上方 1250 单位俯视），量测方式 =
网格射线命中 + 同步读回 `WebGLRenderTarget` 像素（`temp/eval-ramp-pixels2.mjs`）：

| 表面 | 命中数 | 均值色 | luma p25 / **p50** / p75 | 最暗 / 最亮 |
|---|---|---|---|---|
| 第 1 级 vlight（`concrete01`，即坡体材质） | 79 | `#74584f` | 85 / **95** / 104 | `#41302b`（53） / `#8f6d63`（118） |
| 同帧 world lightmap 面 | 81 | `#442e27` | 40 / **46** / 71 | `#1b110e`（20） / `#836148`（83） |

（luma 值域到 175 的单点来自坡上被直射的高光顶点，不改变中位数结论。）

逐样本可见**连续的明暗梯度**（同一行从左到右单调变暗：`#6f524a → #694d45 → #5c433d → #4f3833`），
用户口径的目标色 `#624B42` **正落在实测区间内**（多行样本命中 `#634942` / `#634842` / `#60463f`）。

⇒ 用户报的"整体一面一个颜色（`#37302C` / `#28201D`）"**已消除**：那是第 2 级 leaf cube
"每 prop 一个平坦值"的必然结果；现在是逐顶点梯度，暗部随 vhv 真值自然衰减。

### 10.4 未做 / 已知边界（诚实记账）

| # | 项 | 现状 |
|---|---|---|
| 1 | 28 个 prop 无 vhv（653 个里 629 个有） | 走第 2 级 leaf cube 兜底（`extras.ambientCube`），符合 Source `StaticPropFlags.NoPerVertexLighting` 语义 |
| 2 | `optimizeScene` 合并失败 **217** 次（`gpuType` / index 不一致） | **本轮之前就存在**（对比历史日志：vhv 上线前后计数完全一致 ⇒ 非本轮回退），后果是部分 mesh 未被按材质合并（多几个 draw call），**不影响颜色**。待单独处理 |
| 3 | 显示侧仍是"被照亮的面 ≈ 贴图原色"（曝光 2.3 / γ 2.2） | 与外部参照实现平价（1.0 / 1.0）并存为两个一键挡位，见 §8.3 |

## 11. 「多平面拼接的模型看起来惨不忍睹」（2026-09-20 第五轮）：查证与结论

用户口径：第 1 级接上后"作用于模型的光照有了，但 `ramp_1` 这种多个平面拼接的模型看起来
惨不忍睹"。本轮把它拆成"是否挂错顶点"与"数据本身长什么样"两件事，逐条取证。

### 11.1 先排除「逐顶点值挂错顶点」（五路反证）

| 判据 | 结果 |
|---|---|
| vhv 头部/数据对齐 | `sp_264.vhv` 首 4 字节 `02 00 00 00` ⇒ **base = 0**；按 base=-3 读会得到 `flags=70687931 / meshCount=50331648` 的垃圾，**位移解释不成立** |
| 块↔mesh 对应 | vhv 三块 = 132 / 98 / 8，累加 238 = 模型顶点数；GLB 三个 primitive 的索引用量恰为 `[0,132) / [132,230) / [230,238)` ⇒ 一一对应且顺序一致（尺寸互不相同，无法置换） |
| 块内置换搜索 | 循环位移 ±1..8 / 逆序 / VTX 首次出现序 / 末次出现序 / 按 x,y,z 排序 **全部不如恒等**（同位置+同法线一致度：恒等 0.039，次优 0.084） |
| VVD fixup | `s1_ramp1b.vvd` 的 `fixup_count = 0` ⇒ vmdl crate 的重建序 = 文件序，**fixup 型置换不存在** |
| 法线解释力 / 环境立方体一致性 | 6 向基拟合 R²=0.213（随机置换零假设 p95=0.048）；小模型（16~32 顶点）的逐顶点值与 leaf ambient cube 的相关 **r = 0.91~0.98** —— **置换会摧毁这种相关性** |

⇒ **没有发现挂错顶点**（`test/game-core/scripts/verify/prop_vertex_lighting_scale.py` 与
`scripts/verify/prop_vertex_lighting.py` 是这条结论的可复跑仪器）。

### 11.2 那是数据本身：238 个采样点上的高频场

`ramp_1`（`s1_ramp1b`，包围盒 2560×1196×896 HU，逐顶点亮度 **0.094~0.757**）：

| 指标 | 值 |
|---|---|
| 可见坡面（`concrete01`，50 三角形，最长边 p50 **747** / max 1473 HU） | 三角形内 Δluma 各尺寸四分位 0.23~0.33，与尺寸**不相关**（r=+0.07） |
| 另一个块（`citadel_tilefloor016a`，66 三角形，最长边 p50 163 HU） | 最小四分位三角形内仍有 Δluma≈0.22，r=**-0.60** |
| 同位置+同法线顶点（同一着色点） | 平均差 0.039（自洽 ✓） |

⇒ 该模型的逐顶点场在**顶点尺度上就是高频的**（不是"网格太粗"能解释的：最小三角形同样跳）。
结合 §11.1，只能得出：**烘焙数据如此**（VRAD 对这个 2560 HU 的坡只给了 238 个采样点，
且相邻顶点的直接光/阴影差异很大），渲染侧是**忠实**的。

> 口径更正（本轮自查）：先前一版探针把"三角形尺寸"排序后再去配对"三角形内 Δluma"，
> 配对被自己破坏，曾得出"变化随尺寸增长 ⇒ 网格太粗"的结论 —— **该结论已作废**，
> 现仪器 `prop_vertex_lighting_scale.py` 内置了这条踩坑警告。

### 11.3 因此本轮只做两件不掺假设的事

| 改动 | 内容 | 实测 |
|---|---|---|
| 新增 `lighting.propVertexRelax`（默认 **1**） | 第 1 级几何属性的**重建**：① 接缝焊接（位置+法线相同 ⇒ 同一着色点，取均值）② Laplacian 松弛 N 遍（w=0.5，走索引图） | 1 遍：平均偏移 **0.6%**（单顶点最大 45.5%，样本 142,300 顶点）——**几乎不改观感**，也不伤数据 |
| 诊断口径 | `[vertex-lighting] 几何重建（平滑 N 次）：mesh=… 接缝焊接组=… 松弛遍数=… 平均偏移=…` | 运行日志可见；`window.__vbspPropVertexRelax` 可免重建 A/B |

强度标定（`ramp_1`，数据侧离线）：

| 松弛遍数 | 三角形内 Δluma | 平均偏移 | 亮度范围 |
|---|---|---|---|
| 0（原样） | 0.225 | 0 | 0.102..0.748 |
| 1（默认） | 0.077 | 0.081 | 0.110..0.688 |
| 3 | 0.014 | 0.100 | 0.113..0.631 |
| 8 | 0.001 | 0.104 | 0.114..0.600 |

⇒ 松弛能抹平**三角形内部**的梯度（每块面板变"平"），但**抹不掉面板之间的差异**
（那是烘焙数据的均值结构）；遍数越大越接近"整模型一个亮度"（≈ §11.2 的常量光对照帧）。
所以它是**口味/取舍旋钮**，不是缺陷修复：`0` = 最忠实，`3~5` = 观感最"干净"但偏离烘焙数据 ~15%。

### 11.4 还没做 / 需要参照物

- **和游戏内实拍对照**：本工程与引擎用的是同一份 vhv、同一套 Gouraud 插值 ⇒ 理论上
  分块程度一致，差别只在显示档位（我们 2.3 vs 平价 1.0）。要判定"游戏里到底什么样"，
  需要一张同机位的游戏内截图；在此之前不把"分块"记为缺陷。
- **显示档位对 props 偏亮**：prop 数据中位 0.244 vs world luxel 中位 0.097（2.5×）⇒ 同一个
  曝光 2.3 下 prop 的亮部（>0.435）开始削顶，实测全帧纯白像素 0.51%（平价 0.39%）。
  若要"prop 不削顶"，可给第 1 级单独一个增益（`0.240/0.414 ≈ 0.58`，即按各自 p90 归一）。
  这是口味决定，等对照图后再定。

## 12. 收官（2026-09-20 第六轮）：坡面"分块/条纹"已修 + 与游戏实拍的同靶标量测

用户口径：默认传送旁的坡（`s1_ramp1b`）"预烘焙分片混乱、一块一块"，而游戏内同一坡是均匀的。

### 12.1 量测方法（可复跑）

用 CDP 出帧 + `Page.addScriptToEvaluateOnNewDocument` **加载前**注入开关，同一机位渲染到 RT，
再用射线网格**只统计坡体材质**（`concrete01` / `citadel_tilefloor016a`，353 个采样点）：

| 路径 | 坡面平均色 | 亮度均值 | p10 / p50 / p90 |
|---|---|---|---|
| 纯 albedo（`__vbspDebugAlbedoOnly`） | `#51413a` | 69.2 | 28.1 / 66.9 / 117.5 |
| 第 1 级 vhv（修复前默认） | `#5c493e` | 77.6 | 26 / 70 / **123** |
| **第 1 级 vhv（修复后默认）** | `#574739` | **74.1** | 26.1 / **79.5 / 87.8** |
| cube 兜底（增益标定后） | `#28211e` | 34.5 | 5.4 / 35 / 48.6 |
| **游戏内实拍（用户截图取色）** | `#5b4e40` | **80** | 74 ~ 82 |

### 12.2 两条被实测改写的结论

1. **均值本来就对**（77.6 vs 80）——缺陷**纯粹是方差**：受光面 p50..p90 = 70..123 vs 游戏 74~82。
2. **"引擎拒收 `vertFlags=4`、走 ambient cube"的假设被推翻**：cube 兜底只有 34.5（远暗于 80），
   而我们用 vhv 是 74~78。⇒ **引擎确实在用这份 vhv**，不要把 prop 路由到 cube
   （这也与用户实测 `__vbspVertexLightingOff = true` 更糟一致）。

### 12.3 修法

新增 `lighting.propVertexFlatten`（0..1，默认 **0.85**）：`v ← mean + (1-flatten)·(v-mean)`，
`mean` = **该 prop 实例整份顶点缓冲**的均值 ⇒ **均值严格不变、只压方差**。
免重建 A/B：加载前注入 `window.__vbspPropVertexFlatten = 0|0.85|1`。

**踩坑（务必保留）**：glTF 多 primitive **共享同一份顶点属性缓冲**。第一版按 geometry 去重、
用各自索引范围取均值 ⇒ 三个材质各压一次、**最后写入者获胜**，坡面被拽到别的块均值
（亮度 77.6 → 43.6）。**必须按 `BufferAttribute` 去重、并用整份缓冲取均值。**

### 12.3b 修正：方差压缩改为**按 prop 自适应**（2026-09-20，用户"预烘焙出问题了"）

全局 flatten 的**爆炸半径实测为 436/473 个 prop（92%）屏幕域可见改变 >20%**，
个别如 `kr_stairs` 达 171~387% ⇒ 用户口径的"预烘焙出问题"就是它。改为数据驱动的按 prop 判据：

| prop | **面内**（三角形内）Δ 中位数 | 场跨度 | 判定 |
|---|---|---|---|
| `s1_ramp1b`（条纹型，问题坡） | 0.233 | 0.46 | 压平 |
| `kr_stairs`（面间差异大、面内一致） | 0.023 | 0.26 | **跳过**（保留原样烘焙值） |
| `s1_roof`（跨度 0.56 但面内 0.000） | 0.000 | 0.56 | **跳过** |

阈值 `PROP_FLATTEN_MIN_TRI_DELTA = 0.10`（离线审计 473 个 prop 定标）。
⚠️ 判别必须在**原始烘焙值**上做：第②步鲁棒滤波会先抹平离群顶点，在它之后判别会把
正是要修的条纹型 prop 误判成"面内一致"（实测坡面回到 70/123，未被压平）。
实测结果：`方差压缩 mesh=235`、**跳过 542**（原为全局 954）；坡面 `#59493b` /
均值 76.1 / **p50 81.5 / p90 90.1**（游戏靶标 74~82）。

**发光链路检查（结论：无缺陷）**：GLB 内 `emissiveFactor` 非零材质 **0 个**；发光一律以
`extras.unlit` 表达（8 个材质：`blue_neon`/`glow_red_001`/`glow_yellow_008`/
`neon666_01_krazyneon_00041v`/`purple_dev_neon`/`blue_dev_neon`/`69_red01`/
`tree_deciduous_01a_branches`），走 fullbright 原色 ⇒ 既不吃 ambient cube、也不走第 1 级
逐顶点光照，与本轮改动无关。

### 12.4 验证

数值（受光面 p50/p90 = 79.5/87.8，游戏 74~82；均值 74.1，差 8%）+ 图像
（`temp/shots/flat-fixed.png` 无条纹 vs 修复前 `ramp-relax3.png` 有绿/红/米色条带）+
门禁（`typecheck` 0、`lightmap-guard` 40/40、`test:phys` 五指纹、0 shader 错误）。

### 12.5 顺带查清（与渲染无关）
- 全图 **633 个 `sp_*.vhv` 均为 `vertFlags=4 / vertSize=4`**；UV 纹素密度 max/min = **1.0**
  （贴图未被乱放，用户的"纹理乱放"假设排除）。
- **权威线启动慢**：载荷 `brush=7.02MB / tri=1.08MB`（surf_666）、结构化克隆 5.1ms、
  Worker 内 2367~3639ms；小图 `surf_null`（brush 6.26MB）也要 **966ms** ⇒ 载荷差 12%、耗时差
  2.5~3.8× ⇒ **`build_world` 对 brush 复杂度超线性**。本会话提交未触碰该路径
  （`git log --name-only` 可核）。BSP 规模：**7,730 brush / 64,776 brush side / 39,034 face**。



