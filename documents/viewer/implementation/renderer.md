# implementation/renderer：静态光照着色器

> 覆盖渲染共享层单实例 `src/renderer-shared/shader/lightmap-shader.ts`（2026-10-02 起由三工程各自 `apps/<app>/src/renderer/lightmap-shader.ts` 的三份同构副本合并而来，三份逐字节相同，旧副本已删除；三工程经各自 tsconfig include 收编，import 走深层相对路径）。本工程侧的消费点是 `apps/viewer/src/core/scene.ts`（2026-10-03 Phase 3c 起还同时消费共享 scene-builder / scene-optimizer / near-plane）与 `apps/viewer/src/ui/mapinfo.ts`（后者只取 `LightingMode` 类型）。

---

## 模块职责

模块把 wasm 侧离线烘焙的 RGBExp32 光照图集接到 three 的材质上，并把输出编码统一成纯 γ2.2。导出清单（31 项）：

| 分组 | 导出 | 锚点 |
|---|---|---|
| GLSL 片段 | `VBSP_DECOMPRESS_LIGHTMAP_SAMPLE`（单样本解码）、`VBSP_APPLY_LIGHTMAP`（手写双线性 + 解码 + 抬升 + γ + 曝光） | `src/renderer-shared/shader/lightmap-shader.ts:87`、`src/renderer-shared/shader/lightmap-shader.ts:112` |
| uniform 声明 | `VBSP_LIGHTMAP_UNIFORM_DECLS`、`VBSP_AMBIENT_UNIFORM_DECLS` | `src/renderer-shared/shader/lightmap-shader.ts:165`、`src/renderer-shared/shader/lightmap-shader.ts:181` |
| 几何属性名 | `VERTEX_LIGHTING_ATTR`（运行期键名 `_vbsp_vlight`） | `src/renderer-shared/shader/lightmap-shader.ts:198` |
| 输出编码 | `installGamma22Output` | `src/renderer-shared/shader/lightmap-shader.ts:255` |
| 诊断阶段 | 类型 `LightmapStage`、`readLightmapStage` | `src/renderer-shared/shader/lightmap-shader.ts:284`、`src/renderer-shared/shader/lightmap-shader.ts:304` |
| UV 通道 | `LIGHTMAP_UV_CHANNEL_CORRECT`、`resolveLightmapUvChannel` | `src/renderer-shared/shader/lightmap-shader.ts:324`、`src/renderer-shared/shader/lightmap-shader.ts:333` |
| 图集加载 | `loadLightmapAtlas` | `src/renderer-shared/shader/lightmap-shader.ts:369` |
| 光照模式 | 类型 `LightingMode`、`setLightingMode`、`getLightingMode` | `src/renderer-shared/shader/lightmap-shader.ts:416`、`src/renderer-shared/shader/lightmap-shader.ts:431`、`src/renderer-shared/shader/lightmap-shader.ts:437` |
| 施加与终扫 | `applyLightmapToMeshes`、`fullbrightUnlitLitMaterials` | `src/renderer-shared/shader/lightmap-shader.ts:472`、`src/renderer-shared/shader/lightmap-shader.ts:1057` |
| 第 1 级重建统计 | `getVertexLightingRelaxStats` | `src/renderer-shared/shader/lightmap-shader.ts:1664` |
| 重建参数 | `setPropVertexRelax` / `getPropVertexRelax`、`setPropVertexFlatten` / `getPropVertexFlatten` | `src/renderer-shared/shader/lightmap-shader.ts:1676`、`src/renderer-shared/shader/lightmap-shader.ts:1681`、`src/renderer-shared/shader/lightmap-shader.ts:1695`、`src/renderer-shared/shader/lightmap-shader.ts:1700` |
| 光照标量 | `setLightFloor`、`setLightGamma` / `getLightGamma`、`setExposure`、`setAmbientScale` | `src/renderer-shared/shader/lightmap-shader.ts:1742`、`src/renderer-shared/shader/lightmap-shader.ts:1773`、`src/renderer-shared/shader/lightmap-shader.ts:1780`、`src/renderer-shared/shader/lightmap-shader.ts:1792`、`src/renderer-shared/shader/lightmap-shader.ts:1809` |

## 关键流程与不变量

| 流程 / 不变量 | 说明 | 锚点 |
|---|---|---|
| 模块加载即改全局输出编码 | 顶层直接调用 `installGamma22Output()`，把 three 的 `colorspace_fragment` 块文本换成纯 γ2.2；幂等，且 `globalThis.__vbspOutputGamma22 === false` 时整体跳过 | `src/renderer-shared/shader/lightmap-shader.ts:264`、`src/renderer-shared/shader/lightmap-shader.ts:255` 到 `src/renderer-shared/shader/lightmap-shader.ts:261` |
| γ 只作用于光照项 | 注入后的片元值是 `albedo × 光照项`，`^(1/2.2)` 在出口统一做一次；三条注入路径同此口径 | `src/renderer-shared/shader/lightmap-shader.ts:142`、`src/renderer-shared/shader/lightmap-shader.ts:237` |
| 图集采样前提 | 纹理强制 `NoColorSpace` + `NearestFilter`（min/mag）+ 不生成 mipmap；双线性只在 `vbsp_ApplyLightmap` 里对**已解码**值做 | `src/renderer-shared/shader/lightmap-shader.ts:393` 到 `src/renderer-shared/shader/lightmap-shader.ts:396`、`src/renderer-shared/shader/lightmap-shader.ts:129` 到 `src/renderer-shared/shader/lightmap-shader.ts:135` |
| uniform 声明单点 | 三条注入路径的声明都取自 `VBSP_LIGHTMAP_UNIFORM_DECLS`（ambient 路径另取 `VBSP_AMBIENT_UNIFORM_DECLS`） | `src/renderer-shared/shader/lightmap-shader.ts:1220`、`src/renderer-shared/shader/lightmap-shader.ts:1334`、`src/renderer-shared/shader/lightmap-shader.ts:1441` |
| 光照模式是运行期旋钮 | 两种模式共用同一批注入材质，只改共享 uniform `bakedMixUniform`；片元里 `vbspBakedMix < 0.5` 时整条采样直接返回 1.0 | `src/renderer-shared/shader/lightmap-shader.ts:428`、`src/renderer-shared/shader/lightmap-shader.ts:433`、`src/renderer-shared/shader/lightmap-shader.ts:121` |
| 逐图元路由顺序 | ① `off` 阶段整段返回 0；② `hasLightmap === false` 或 undefined → fullbright；③ 既无 `uv1` 也无 `uv2` → fullbright；④ 其余换注入材质并计数；⑤ 装配后终扫把仍是 Standard 材质的图元收敛为 fullbright | `src/renderer-shared/shader/lightmap-shader.ts:478`、`src/renderer-shared/shader/lightmap-shader.ts:875`、`src/renderer-shared/shader/lightmap-shader.ts:905`、`src/renderer-shared/shader/lightmap-shader.ts:1004`、`src/renderer-shared/shader/lightmap-shader.ts:1057` |
| 判据优先读 geometry 的 extras | `hasLightmap` 先读 `geometry.userData`、缺失才回落 `mesh.userData` | `src/renderer-shared/shader/lightmap-shader.ts:872` 到 `src/renderer-shared/shader/lightmap-shader.ts:874` |
| 材质去重 | 参数相同的注入材质复用同一实例（world 侧 `lightmappedCache`、fullbright 侧 `fullbrightCache`、第 1 级 `vertexLightingCache` 三个缓存）；带 ambient cube 的 prop 例外，必须逐 mesh 建材质 | `src/renderer-shared/shader/lightmap-shader.ts:506`、`src/renderer-shared/shader/lightmap-shader.ts:507`、`src/renderer-shared/shader/lightmap-shader.ts:513`、`src/renderer-shared/shader/lightmap-shader.ts:554` |
| 第 1 级重建三步 | 接缝焊接 → 空间鲁棒滤波（同法线 2 环中位数，阈值 0.1）→ `propVertexRelax ≥ 3` 时叠加 Laplacian；随后按 `propVertexFlatten` 做方差压缩 | `src/renderer-shared/shader/lightmap-shader.ts:627`、`src/renderer-shared/shader/lightmap-shader.ts:686` 到 `src/renderer-shared/shader/lightmap-shader.ts:696`、`src/renderer-shared/shader/lightmap-shader.ts:702`、`src/renderer-shared/shader/lightmap-shader.ts:771` |
| 压平方差的判别基准 | 面内亮度差的中位数取自**原始烘焙值**快照，低于阈值时跳过压平 | `src/renderer-shared/shader/lightmap-shader.ts:758`、`src/renderer-shared/shader/lightmap-shader.ts:685` |
| 属性级去重 | 几何用 `WeakSet` 去重、顶点属性另用 `WeakSet`（多 primitive 共享同一份缓冲时按属性去重） | `src/renderer-shared/shader/lightmap-shader.ts:568`、`src/renderer-shared/shader/lightmap-shader.ts:570` |
| 各标量的接受窗口 | `setLightGamma` 只接受 `(0, 1]`；`setExposure` 只接受 `> 0`；`setAmbientScale` 只接受 `≥ 0`；`setPropVertexRelax` 只接受 `≥ 0`（取整）；`setPropVertexFlatten` 只接受 `≥ 0` 并钳到 1 | `src/renderer-shared/shader/lightmap-shader.ts:1774`、`src/renderer-shared/shader/lightmap-shader.ts:1793`、`src/renderer-shared/shader/lightmap-shader.ts:1810`、`src/renderer-shared/shader/lightmap-shader.ts:1677`、`src/renderer-shared/shader/lightmap-shader.ts:1696` |（已消除 2026-10-08：接受窗口已改为 (0,8] 并与面板量程对齐，2.2 生效）
| 全局覆盖优先于工程写入 | `__vbspLightGamma` / `__vbspExposure` / `__vbspAmbientScale` / `__vbspPropVertexRelax` / `__vbspPropVertexFlatten` / `__vbspLightFloor` 存在时忽略代码侧写入 | `src/renderer-shared/shader/lightmap-shader.ts:1775`、`src/renderer-shared/shader/lightmap-shader.ts:1797`、`src/renderer-shared/shader/lightmap-shader.ts:1811`、`src/renderer-shared/shader/lightmap-shader.ts:1715` |
| 注入失败判定 | 两条替换通道取或、且片元文本确实变化才算注入成功；失败时（除 `broken` 阶段）写 `globalThis.__vbspLightmapInjectFailed = true` 并抛错 | `src/renderer-shared/shader/lightmap-shader.ts:1166`、`src/renderer-shared/shader/lightmap-shader.ts:1193`、`src/renderer-shared/shader/lightmap-shader.ts:1205`、`src/renderer-shared/shader/lightmap-shader.ts:1206` |

## 已知缺口（状态见 TODO.md）

1. **「副本自述」缺口已随合并消解（2026-10-02 更正）**：原三份同构副本的头注各写一句「本文件是上述三份同构副本之一（按所在工程目录定位）」，与所在工程路径存在表述错位。三副本已合并为 `src/renderer-shared/shader/lightmap-shader.ts` 单实例，该句随之改写为「归属」段（`src/renderer-shared/shader/lightmap-shader.ts:6`）——单实例不再有「按目录定位」的歧义，本缺口不再成立。
2. **注入期的 throw 不在本工程调用方的 catch 覆盖范围内**（本次读码发现）：替换、计数与失败判定都写在 `material.onBeforeCompile` 回调体内（`src/renderer-shared/shader/lightmap-shader.ts:1104` 起），该回调由 three 在**编译材质时**调用，而不是在挂载期的 `applyLightmapToMeshes` 调用栈里；本工程侧的调用链上，挂载期那一次调用已由共享 applyLightmap 的 catch 覆盖（`src/renderer-shared/scene/scene-builder.ts:131` 到 `src/renderer-shared/scene/scene-builder.ts:133`，返回 false 由 mountGlb 落日志），帧循环里也没有 try/catch（`apps/viewer/src/app.ts:773` 起）⇒ 若替换锚点与 three 版本失配，异常会在绘制时抛出并中断该帧后续逻辑，与「调用方非零退出」的失败语义不同。（见 TODO.md T-116）
3. ~~**六个导出在本工程内零调用点**~~ **已消除（2026-10-09）**：T-161 —— 其中 **5 个已删除**（`isLightmapSkipStage`、`isTextureOnlyMode`、`getLightFloor`、`getExposure`、`getAmbientScale`，`src/renderer-shared/shader/lightmap-shader.ts`）；其余 3 个（`getVertexLightingRelaxStats`、`getPropVertexRelax`、`getPropVertexFlatten`）**并非死代码**——它们被共享层 `src/renderer-shared/scene/inject-stats.ts` 导入并在 `src/renderer-shared/scene/inject-stats.ts:116`、`:122`、`:124` 调用，而 `reportInjectStatsOnce` 由 `apps/game/src/renderer/renderer-main.ts:44` 导入、在 `apps/game/src/renderer/renderer-main.ts:749` 调用 ⇒ 原断言「六个都零调用点」对其中 3 个不成立，予以更正并保留。
4. ~~**`setLightFloor` 在本工程内零调用点**~~ **已消除（2026-10-09）**：T-162 —— **遗弃，不删**：该 setter 是**文档化的控制台 A/B 钩子**（`src/renderer-shared/shader/lightmap-shader.ts` 的注释明写「要用就注入 `window.__vbspLightFloor = 0.004` 或调 `setLightFloor()`」），且 debug / game / viewer 三篇 `renderer.md` 都把它列为模块导出面 ⇒ 按 D-024 窄口径「零调用点**且**无文档断言依赖」，第二条不成立，维持登记。
5. **`LIGHTMAP_UV_CHANNEL_CORRECT` 只被同文件的 `resolveLightmapUvChannel` 消费**：`src/renderer-shared/shader/lightmap-shader.ts:324` 是常量单点，外部没有直接使用者；本工程的 `channel` 写入发生在 `applyLightmapToMeshes` 内部（`src/renderer-shared/shader/lightmap-shader.ts:1001`）。
6. **`broken` 阶段的对照靠一份失配字面量维持**：`BASIC_INLINE_LIGHTMAP_SRC_LEGACY_MISMATCH`（`src/renderer-shared/shader/lightmap-shader.ts:346`）必须与 three 实际 emit 的文本保持「差一个换行加两个制表符」的关系，否则该阶段不再产出 `applied === false` 的预期结果（判定在 `src/renderer-shared/shader/lightmap-shader.ts:1170`）。（见 TODO.md T-117）
7. **两条替换通道在 three 0.165 下只有一条能命中**：`CHUNK_LIGHTMAP_INCLUDE` 通道的命中数被统计（`src/renderer-shared/shader/lightmap-shader.ts:1150`），但该版本 `ShaderChunk` 不导出 `lightmap_fragment`，故该通道在本工程依赖的 three 版本下命中恒为 0；注入实际靠内联通道（`src/renderer-shared/shader/lightmap-shader.ts:1156`）。
