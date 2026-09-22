# implementation/renderer：静态光照着色器

> 覆盖 `apps/viewer/src/renderer/lightmap-shader.ts`。这是三工程各持一份的**同构副本**：三份文件路径同形（`apps/<app>/src/renderer/lightmap-shader.ts`）、本轮读码用 SHA256 比对哈希相同、彼此不 import，改动只对所在工程生效。本工程侧的消费点是 `apps/viewer/src/core/scene.ts`。

---

## 模块职责

模块把 wasm 侧离线烘焙的 RGBExp32 光照图集接到 three 的材质上，并把输出编码统一成纯 γ2.2。导出清单（31 项）：

| 分组 | 导出 | 锚点 |
|---|---|---|
| GLSL 片段 | `VBSP_DECOMPRESS_LIGHTMAP_SAMPLE`（单样本解码）、`VBSP_APPLY_LIGHTMAP`（手写双线性 + 解码 + 抬升 + γ + 曝光） | `apps/viewer/src/renderer/lightmap-shader.ts:87`、`apps/viewer/src/renderer/lightmap-shader.ts:112` |
| uniform 声明 | `VBSP_LIGHTMAP_UNIFORM_DECLS`、`VBSP_AMBIENT_UNIFORM_DECLS` | `apps/viewer/src/renderer/lightmap-shader.ts:165`、`apps/viewer/src/renderer/lightmap-shader.ts:181` |
| 几何属性名 | `VERTEX_LIGHTING_ATTR`（运行期键名 `_vbsp_vlight`） | `apps/viewer/src/renderer/lightmap-shader.ts:198` |
| 输出编码 | `installGamma22Output` | `apps/viewer/src/renderer/lightmap-shader.ts:255` |
| 诊断阶段 | 类型 `LightmapStage`、`readLightmapStage`、`isLightmapSkipStage` | `apps/viewer/src/renderer/lightmap-shader.ts:284`、`apps/viewer/src/renderer/lightmap-shader.ts:304`、`apps/viewer/src/renderer/lightmap-shader.ts:313` |
| UV 通道 | `LIGHTMAP_UV_CHANNEL_CORRECT`、`resolveLightmapUvChannel` | `apps/viewer/src/renderer/lightmap-shader.ts:329`、`apps/viewer/src/renderer/lightmap-shader.ts:338` |
| 图集加载 | `loadLightmapAtlas` | `apps/viewer/src/renderer/lightmap-shader.ts:374` |
| 光照模式 | 类型 `LightingMode`、`setLightingMode`、`getLightingMode`、`isTextureOnlyMode` | `apps/viewer/src/renderer/lightmap-shader.ts:421`、`apps/viewer/src/renderer/lightmap-shader.ts:436`、`apps/viewer/src/renderer/lightmap-shader.ts:442`、`apps/viewer/src/renderer/lightmap-shader.ts:447` |
| 施加与终扫 | `applyLightmapToMeshes`、`fullbrightUnlitLitMaterials` | `apps/viewer/src/renderer/lightmap-shader.ts:482`、`apps/viewer/src/renderer/lightmap-shader.ts:1067` |
| 第 1 级重建统计 | `getVertexLightingRelaxStats` | `apps/viewer/src/renderer/lightmap-shader.ts:1674` |
| 重建参数 | `setPropVertexRelax` / `getPropVertexRelax`、`setPropVertexFlatten` / `getPropVertexFlatten` | `apps/viewer/src/renderer/lightmap-shader.ts:1686`、`apps/viewer/src/renderer/lightmap-shader.ts:1691`、`apps/viewer/src/renderer/lightmap-shader.ts:1705`、`apps/viewer/src/renderer/lightmap-shader.ts:1710` |
| 光照标量 | `setLightFloor` / `getLightFloor`、`setLightGamma` / `getLightGamma`、`setExposure` / `getExposure`、`setAmbientScale` / `getAmbientScale` | `apps/viewer/src/renderer/lightmap-shader.ts:1752`、`apps/viewer/src/renderer/lightmap-shader.ts:1757`、`apps/viewer/src/renderer/lightmap-shader.ts:1788`、`apps/viewer/src/renderer/lightmap-shader.ts:1795`、`apps/viewer/src/renderer/lightmap-shader.ts:1807`、`apps/viewer/src/renderer/lightmap-shader.ts:1817`、`apps/viewer/src/renderer/lightmap-shader.ts:1829`、`apps/viewer/src/renderer/lightmap-shader.ts:1836` |

## 关键流程与不变量

| 流程 / 不变量 | 说明 | 锚点 |
|---|---|---|
| 模块加载即改全局输出编码 | 顶层直接调用 `installGamma22Output()`，把 three 的 `colorspace_fragment` 块文本换成纯 γ2.2；幂等，且 `globalThis.__vbspOutputGamma22 === false` 时整体跳过 | `apps/viewer/src/renderer/lightmap-shader.ts:264`、`apps/viewer/src/renderer/lightmap-shader.ts:255` 到 `apps/viewer/src/renderer/lightmap-shader.ts:261` |
| γ 只作用于光照项 | 注入后的片元值是 `albedo × 光照项`，`^(1/2.2)` 在出口统一做一次；三条注入路径同此口径 | `apps/viewer/src/renderer/lightmap-shader.ts:142`、`apps/viewer/src/renderer/lightmap-shader.ts:237` |
| 图集采样前提 | 纹理强制 `NoColorSpace` + `NearestFilter`（min/mag）+ 不生成 mipmap；双线性只在 `vbsp_ApplyLightmap` 里对**已解码**值做 | `apps/viewer/src/renderer/lightmap-shader.ts:398` 到 `apps/viewer/src/renderer/lightmap-shader.ts:401`、`apps/viewer/src/renderer/lightmap-shader.ts:129` 到 `apps/viewer/src/renderer/lightmap-shader.ts:135` |
| uniform 声明单点 | 三条注入路径的声明都取自 `VBSP_LIGHTMAP_UNIFORM_DECLS`（ambient 路径另取 `VBSP_AMBIENT_UNIFORM_DECLS`） | `apps/viewer/src/renderer/lightmap-shader.ts:1230`、`apps/viewer/src/renderer/lightmap-shader.ts:1344`、`apps/viewer/src/renderer/lightmap-shader.ts:1451` |
| 光照模式是运行期旋钮 | 两种模式共用同一批注入材质，只改共享 uniform `bakedMixUniform`；片元里 `vbspBakedMix < 0.5` 时整条采样直接返回 1.0 | `apps/viewer/src/renderer/lightmap-shader.ts:433`、`apps/viewer/src/renderer/lightmap-shader.ts:438`、`apps/viewer/src/renderer/lightmap-shader.ts:121` |
| 逐图元路由顺序 | ① `off` 阶段整段返回 0；② `hasLightmap === false` 或 undefined → fullbright；③ 既无 `uv1` 也无 `uv2` → fullbright；④ 其余换注入材质并计数；⑤ 装配后终扫把仍是 Standard 材质的图元收敛为 fullbright | `apps/viewer/src/renderer/lightmap-shader.ts:488`、`apps/viewer/src/renderer/lightmap-shader.ts:885`、`apps/viewer/src/renderer/lightmap-shader.ts:915`、`apps/viewer/src/renderer/lightmap-shader.ts:1014`、`apps/viewer/src/renderer/lightmap-shader.ts:1067` |
| 判据优先读 geometry 的 extras | `hasLightmap` 先读 `geometry.userData`、缺失才回落 `mesh.userData` | `apps/viewer/src/renderer/lightmap-shader.ts:882` 到 `apps/viewer/src/renderer/lightmap-shader.ts:884` |
| 材质去重 | 参数相同的注入材质复用同一实例（world 侧 `lightmappedCache`、fullbright 侧 `fullbrightCache`、第 1 级 `vertexLightingCache` 三个缓存）；带 ambient cube 的 prop 例外，必须逐 mesh 建材质 | `apps/viewer/src/renderer/lightmap-shader.ts:516`、`apps/viewer/src/renderer/lightmap-shader.ts:517`、`apps/viewer/src/renderer/lightmap-shader.ts:523`、`apps/viewer/src/renderer/lightmap-shader.ts:564` |
| 第 1 级重建三步 | 接缝焊接 → 空间鲁棒滤波（同法线 2 环中位数，阈值 0.1）→ `propVertexRelax ≥ 3` 时叠加 Laplacian；随后按 `propVertexFlatten` 做方差压缩 | `apps/viewer/src/renderer/lightmap-shader.ts:637`、`apps/viewer/src/renderer/lightmap-shader.ts:696` 到 `apps/viewer/src/renderer/lightmap-shader.ts:706`、`apps/viewer/src/renderer/lightmap-shader.ts:712`、`apps/viewer/src/renderer/lightmap-shader.ts:781` |
| 压平方差的判别基准 | 面内亮度差的中位数取自**原始烘焙值**快照，低于阈值时跳过压平 | `apps/viewer/src/renderer/lightmap-shader.ts:768`、`apps/viewer/src/renderer/lightmap-shader.ts:695` |
| 属性级去重 | 几何用 `WeakSet` 去重、顶点属性另用 `WeakSet`（多 primitive 共享同一份缓冲时按属性去重） | `apps/viewer/src/renderer/lightmap-shader.ts:578`、`apps/viewer/src/renderer/lightmap-shader.ts:580` |
| 各标量的接受窗口 | `setLightGamma` 只接受 `(0, 1]`；`setExposure` 只接受 `> 0`；`setAmbientScale` 只接受 `≥ 0`；`setPropVertexRelax` 只接受 `≥ 0`（取整）；`setPropVertexFlatten` 只接受 `≥ 0` 并钳到 1 | `apps/viewer/src/renderer/lightmap-shader.ts:1789`、`apps/viewer/src/renderer/lightmap-shader.ts:1808`、`apps/viewer/src/renderer/lightmap-shader.ts:1830`、`apps/viewer/src/renderer/lightmap-shader.ts:1687`、`apps/viewer/src/renderer/lightmap-shader.ts:1706` |
| 全局覆盖优先于工程写入 | `__vbspLightGamma` / `__vbspExposure` / `__vbspAmbientScale` / `__vbspPropVertexRelax` / `__vbspPropVertexFlatten` / `__vbspLightFloor` 存在时忽略代码侧写入 | `apps/viewer/src/renderer/lightmap-shader.ts:1790`、`apps/viewer/src/renderer/lightmap-shader.ts:1812`、`apps/viewer/src/renderer/lightmap-shader.ts:1831`、`apps/viewer/src/renderer/lightmap-shader.ts:1725` |
| 注入失败判定 | 两条替换通道取或、且片元文本确实变化才算注入成功；失败时（除 `broken` 阶段）写 `globalThis.__vbspLightmapInjectFailed = true` 并抛错 | `apps/viewer/src/renderer/lightmap-shader.ts:1176`、`apps/viewer/src/renderer/lightmap-shader.ts:1203`、`apps/viewer/src/renderer/lightmap-shader.ts:1215`、`apps/viewer/src/renderer/lightmap-shader.ts:1216` |

## 已知缺口

1. **副本自述与路径无关（已按代码校准）**：三份副本逐字节相同（SHA256 实测一致），因此自述行必须对三份都成立——`apps/viewer/src/renderer/lightmap-shader.ts:8` 写的是「本文件是上述三份同构副本之一（按所在工程目录定位）」，不再点名任一工程——在本工程的副本里，该句与它自己的路径不一致。同处同一行还承担「三工程各持一份同构副本」的说明（`apps/viewer/src/renderer/lightmap-shader.ts:6`）。
2. **注入期的 throw 不在本工程调用方的 catch 覆盖范围内**（本次读码发现）：替换、计数与失败判定都写在 `material.onBeforeCompile` 回调体内（`apps/viewer/src/renderer/lightmap-shader.ts:1114` 起），该回调由 three 在**编译材质时**调用，而不是在挂载期的 `applyLightmapToMeshes` 调用栈里；本工程的 try/catch 只包住挂载期那一次调用（`apps/viewer/src/core/scene.ts:218` 到 `apps/viewer/src/core/scene.ts:233`），帧循环里也没有 try/catch（`apps/viewer/src/app.ts:478` 起）⇒ 若替换锚点与 three 版本失配，异常会在绘制时抛出并中断该帧后续逻辑，与「调用方非零退出」的失败语义不同。
3. **六个导出在本工程内零调用点**：`isLightmapSkipStage`（`apps/viewer/src/renderer/lightmap-shader.ts:313`）、`isTextureOnlyMode`（`apps/viewer/src/renderer/lightmap-shader.ts:447`）、`getVertexLightingRelaxStats`（`apps/viewer/src/renderer/lightmap-shader.ts:1674`）、`getLightFloor`（`apps/viewer/src/renderer/lightmap-shader.ts:1757`）、`getPropVertexRelax`（`apps/viewer/src/renderer/lightmap-shader.ts:1691`）、`getPropVertexFlatten`（`apps/viewer/src/renderer/lightmap-shader.ts:1710`）；另有 `getExposure`（`apps/viewer/src/renderer/lightmap-shader.ts:1817`）与 `getAmbientScale`（`apps/viewer/src/renderer/lightmap-shader.ts:1836`）同样无读取者——本工程只用 setter 与 `getLightingMode`（`apps/viewer/src/core/scene.ts:246`）。
4. **`setLightFloor` 在本工程内零调用点**：`apps/viewer/src/renderer/lightmap-shader.ts:1752` 提供的暗部抬升下限没有工程侧写入点，共享 uniform 保持初值。
5. **`LIGHTMAP_UV_CHANNEL_CORRECT` 只被同文件的 `resolveLightmapUvChannel` 消费**：`apps/viewer/src/renderer/lightmap-shader.ts:329` 是常量单点，外部没有直接使用者；本工程的 `channel` 写入发生在 `applyLightmapToMeshes` 内部（`apps/viewer/src/renderer/lightmap-shader.ts:1011`）。
6. **`broken` 阶段的对照靠一份失配字面量维持**：`BASIC_INLINE_LIGHTMAP_SRC_LEGACY_MISMATCH`（`apps/viewer/src/renderer/lightmap-shader.ts:351`）必须与 three 实际 emit 的文本保持「差一个换行加两个制表符」的关系，否则该阶段不再产出 `applied === false` 的预期结果（判定在 `apps/viewer/src/renderer/lightmap-shader.ts:1180`）。
7. **两条替换通道在 three 0.165 下只有一条能命中**：`CHUNK_LIGHTMAP_INCLUDE` 通道的命中数被统计（`apps/viewer/src/renderer/lightmap-shader.ts:1160`），但该版本 `ShaderChunk` 不导出 `lightmap_fragment`，故该通道在本工程依赖的 three 版本下命中恒为 0；注入实际靠内联通道（`apps/viewer/src/renderer/lightmap-shader.ts:1166`）。
