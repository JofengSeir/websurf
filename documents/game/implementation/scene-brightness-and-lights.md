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

1. **legacy 三点光已关**（`test/game-core/src/renderer/renderer-main.ts:256-268`）：`LEGACY_THREE_POINT_LIGHTS = false`，`AmbientLight` / `HemisphereLight` / `DirectionalLight` 根本没加进场景。
2. **GLB 带的两千盏灯被中和**（同文件 `:297-319`）：GLB 已携带全部 `light` / `light_spot` / `light_environment`（surf_666 = 2118 盏、surf_null = 3067 盏，含 color / intensity / direction / range，见 `test/game-core/crates/wasm-core/model_integrator/mod.rs:578-634`），但渲染端统一 `visible = false`。
3. **决定性的一条：所有 mesh 都是 `MeshBasicMaterial`**。
   `applyLightmapToMeshes`（`test/game-core/src/renderer/lightmap-shader.ts:293`，契约同文件 `:19`）对场景里**每一个** mesh 做二选一：
   **只有** `geometry.userData.hasLightmap === true`（真实 luxel）才换成 Basic + 注入解码；`hasLightmap === false`（中性占位 UV，契约 §9.6.1）与无 lightmap UV 的两类**一律**换成 Basic(fullbright) 贴图原色（`routeFullbright`，`:339`）。
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
- `RECIPROCAL_PI` 不存在于本项目路径：注入把 three 的内联块整体替换掉了（`lightmap-shader.ts:72-76`，replacement 里没有 `RECIPROCAL_PI`）。
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

用 GLB 里 `light_environment` 的颜色替换死灰背景 `new THREE.Color(0x222222)`（`src/renderer/renderer-main.ts:271`），让天空区域不再是纯灰，也顺便给画面一个色调基准。注意：只改 `scene.background`，**不要**顺手打开那两千盏 punctual 灯（§2 已论证：开了也是零效果，且污染 uniform 上限）。

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

⇒ **零效果**（差值 0.001，来自物理漂移；直方图逐桶一致）。三层原因见 §2（材质全 `MeshBasicMaterial` / world 几何无 NORMAL / GLB punctual 灯 `visible=false`）。
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
