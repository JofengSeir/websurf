# game 实现：光照渲染合并计划（外部参照实现 lightmap → test/game-core）（I）

> 本轮只出一份**可执行计划**，不改任何代码。读者是后续动手实现的人（可能是另一个 Agent）：每一阶段都给出改动面、验证方式与回退点，不使用「适当优化」「参考实现」这类无法验收的措辞。
> - **现状基准**：副本 `test/game-core`（`apps/game` 的 Fork 副本）。总览见 [../overview.md](../overview.md)，时序见 [../sequences.md](../sequences.md)，与 `apps/game` 的差异见 [../differences.md](../differences.md)。
> - **第三方事实来源**：外部参照实现（MIT）。正文对它的引用一律写作「外部参照实现的 `文件名`:行号」；本仓库内引用一律写作 `文件:行号`，两种写法都可直接定位。
> - **路径与证据**：本仓库内路径均相对仓库根。全文所有 `文件:行号` 锚点均已用 `src/scripts/check-doc-drift.mjs` 的 B 项判据（锚点不得越界）复核。
> - 例外说明：验证命令里的 `npm run *`、`node src/scripts/*` 属命令而非文件引用，不按 `文件:行号` 规则书写。

## 1. 目标与现状差距清单

### 1.1 目标

让副本的 BSP 世界面呈现「离线烘焙的静态光照」（Source 引擎观感），而不是当前三个与地图无关的硬编码光源；并把这套改动收敛成可回并 `apps/game` 的最小面。

### 1.2 现状：光照是假的，且烘焙光照数据全链路缺失

副本当前光照来自 `test/game-core/src/renderer/renderer-main.ts:244-251`：注释「固定三点光（替代原 LightManager）」（`:244`），随后 `AmbientLight(0xffffff, 0.6)`（`:245`）、`HemisphereLight(0xb0c4de, 0x404030, 0.4)`（`:247`）、`DirectionalLight(0xfff4e0, 0.5)` 且 `position.set(100, 200, 100)`（`:249-250`）三盏灯在 `init()` 里一次性加入 `this.scene`。文件头注释自述「无 lightmap/雾/碰撞可视化/准星射线」（`test/game-core/src/renderer/renderer-main.ts:10`）。`renderer.outputColorSpace = THREE.SRGBColorSpace` 在 `:233`。

差距矩阵（每行给出「文件里有吗 / 解析层读了吗 / 送给渲染端了吗」）：

| 光照数据 | BSP 内有 | 共享层解析 | 导出/送达渲染端 | 证据 |
|---|---|---|---|---|
| `LIGHTING`(8) lump（luxel RGBExp32） | 有 | **否** | **否** | `src/wasm-core/vbsp/bspfile.rs:84` 定义枚举；全仓无消费点 |
| `LIGHTING_HDR`(53) lump | 有 | **否** | **否** | `src/wasm-core/vbsp/bspfile.rs:129` 定义枚举；全仓无消费点 |
| `WORLD_LIGHTS`(15) / `WORLD_LIGHTS_HDR`(54) | 有 | **否** | **否** | `src/wasm-core/vbsp/bspfile.rs:130`（HDR 变体）；无消费点 |
| `LEAF_AMBIENT_LIGHTING`(56)（28 字节/叶记录，**零解析**） | 有 | **否** | **否** | 枚举见 `src/wasm-core/vbsp/bspfile.rs:132`；无消费点。（注意区分：`src/wasm-core/vbsp/reader.rs:139-143` 读入局部 `[0u8; 24]` 后丢弃的 24 字节是 **LEAVES 记录尾部内联的 ambient cube**，不是本 lump 的样本面；该 24 字节同样不落结构体，`src/wasm-core/vbsp/data/mod.rs:237` 以 `const_assert_eq!(size_of::<Leaf>(), 32)` 锁死） |
| `LEAF_AMBIENT_INDEX`(52) / `_HDR`(51) | 有 | **否** | **否** | `src/wasm-core/vbsp/bspfile.rs:127-128`；无消费点 |
| 面级 `light_offset` | 有 | 已解析、**零引用** | **否** | 定义 `src/wasm-core/vbsp/data/mod.rs:375` |
| 面级 `light_map_texture_min/size` | 有 | 已解析、**零引用** | **否** | 定义 `src/wasm-core/vbsp/data/mod.rs:377-378` |
| texinfo 级 `light_map_scale/transform` | 有 | 已解析、**零引用** | **否** | 定义 `src/wasm-core/vbsp/data/mod.rs:182-183` |
| lightmap UV（`TEXCOORD_1`） | 需计算 | **未计算** | **否** | 导出只写 `TexCoords(0)`：`src/wasm-core/bsp_to_gltf_core/convert.rs:1005-1008` |
| lightmap atlas 纹理 | 需生成 | **无生成代码** | **否** | `src/wasm-core` 内无 atlas 生成逻辑 |

**关于 `LIGHTING` lump 的确定结论（本轮硬性判定）：数据 100% 在 BSP 文件里，0% 进入解析层，0% 进入导出层。既无 LDR 读取分支，也无 HDR 读取分支——两个枚举变体都只是占位，全仓引用数为 0。** 判定口径：`LumpType` 是单枚举且覆盖 lump 0..63，`Lighting` 在 `src/wasm-core/vbsp/bspfile.rs:84`、`LightingHdr` 在同文件 `:129`，收尾 `static_assertions::const_assert_eq!(LumpType::DisplacementMultiBlend as usize, 63);` 在 `:142`；而 `Bsp` 的读取链 `src/wasm-core/vbsp/mod.rs:204-292` 逐条列出的 lump 里**没有任何光照类 lump**（只消费 Entities/TextureData/TextureInfo/…/Faces/Visibility/…/GameLump/PakFile）。

### 1.3 几何与材质侧的三个硬约束

1. **地图几何没有法线**：`BspVertexData` 只有 `position` 与 `uv`（`src/wasm-core/bsp_to_gltf_core/convert.rs:1042-1045`），而 PAKFILE 模型顶点 `ModelVertex` 是另一个结构且带 `normal`（`src/wasm-core/model_integrator/mod.rs:1024-1028`）。两者是**不同**的 `repr(C)` 结构，不可混用。任何依赖 three.js 标准光照（Lambert/Phong/Standard）的路线都必须先解决法线来源。
2. **图元无索引缓冲**：`indices: None`（`src/wasm-core/bsp_to_gltf_core/convert.rs:1015`），`mode` 为 `Triangles`（`:1017`）——即顶点汤。
3. **材质走 PBR 且中性**：`pbr_metallic_roughness` 的 `base_color_texture` 用 `tex_coord: 0`（`src/wasm-core/bsp_to_gltf_core/gltf_builder.rs:100-105`），`metallic_factor = 0.0`、`roughness_factor = 1.0`（`:106-108`）。不写 `occlusionTexture` / `emissiveTexture`。

另有一条**块合并的连带约束**：副本的分块合并用 `mergeGeometries(geoms, false)`（`test/game-core/src/renderer/renderer-main.ts:998`）与 `mergeGeometries(mergedGeoms, true)`（`:1020`）。同块内 mesh 的属性集必须一致，否则合并不成立；因此若只给「部分面」加 `TEXCOORD_1`，必须**要么给全部面写满**（缺光照的面写中性值），**要么按有无 lightmap 分块**。

### 1.4 已有的可复用资产（显著降低工作量）

`apps/debug`（不在副本范围内）已经写好并**已接线**两件事，可直接搬进副本：

- **lightmap atlas 解码着色器**：`apps/debug/src/renderer/lightmap-shader.ts`（**迁移前** 224 行；2026-09-20 回并后 apps/debug 改用共享版 1785 行，见 §10）。`vbsp_DecompressLightmapSample` 做 `exp = texel.a * 255.0 - 128.0; return texel.rgb * pow(2.0, exp)`（`:25-30`）；`vbsp_ApplyLightmap` 手动取 4 个最近邻、各自解码后再 `mix`（`:39-53`）；atlas 以 `NoColorSpace` + `NearestFilter` 上传（`:104-106`）；入口 `loadLightmapAtlas(gltf.parser, gltf)` 从 glTF `extras.lightmap.textureIndex` 取纹理（`:80-89`），`applyLightmapToMeshes(scene, atlasTexture)` 对带 `uv1`/`uv2` 的 mesh 施加（`:125-148`，其中 `:146-148` 把 r151+ 的 `uv1` 复制到 `uv2`，因为 three.js 的 lightMap 槽由 `uv2` 驱动）。
- **接线位置**：`apps/debug/src/renderer/renderer-main.ts:505-508` 先 `loadLightmapAtlas` 再 `applyLightmapToMeshes`，注释（`:514-515`）明确要求在 `:516` 的 `optimizeScene` **之前**施加——因为 lightmap 按原 mesh 的材质/UV 施加，材质实例在合并中去重保留，映射关系不丢。

`apps/debug` 的第三件事需要精确表述，避免高估：`LightManager` 的**基础三灯已接线**（`apps/debug/src/renderer/renderer-main.ts:383` 调 `applyLights`，其实现 `apps/debug/src/renderer/light-manager.ts:71-100`，读 `config.lighting`），配置段也存在（`apps/debug/src/config.ts:139` 声明、`:196-206` 默认值）。但**点光源池未接线**：`extractPointLights`（`apps/debug/src/renderer/light-manager.ts:108`）与 `updatePointLights`（`:152`）只有定义、无调用点，且 `applyLights` 签名不接收 glTF（`:71`），所以 `LightManager` 的 8 灯池（`MAX_POINT_LIGHTS = 8`，`:29`）当前恒为空转。**不要把它当作"已验证的真光源能力"**。

## 2. 数据流设计

目标数据流（五种角色的边界必须清晰，否则会把工作放进错误的层）：

```
BSP LIGHTING/LIGHTING_HDR lump
  → 共享层解析（src/wasm-core：新增 luxel 读取 + 面/材质元数据消费）
  → 导出契约（GLB 内 TEXCOORD_1 + primitives.extras.lightmap + GLB 外 atlas 纹理）
  → TS 消费（test/game-core：GLB → three.js 几何属性/材质替换）
  → three.js/WebGL 采样（onBeforeCompile 注入，Nearest + 手写双线性 + RGBExp32 解码）
```

### 2.1 上游算法的关键口径（照抄项）

以下五条是外部参照实现的实现口径，写错任何一条都会导致可见错误，故单列：

1. **每面 luxel 数 = `(LightMapSizeX + 1) * (LightMapSizeY + 1)`**：外部参照实现的 `Structures.cs:181`
   `LightMapSize => LightOffset == -1 ? Zero : new IntVector2(LightMapSizeX + 1, LightMapSizeY + 1)`。
   即 BSP 里的 `lightmapsize` 是「格数 − 1」，格点数才是 luxel 数。
2. **`lightofs` 是 lump 内的字节偏移，不是样本下标**：外部参照实现的 `Lightmap.cs:75` 直接 `sampleStream.Seek(face.LightOffset, SeekOrigin.Begin)`。实现必须按字节 seek。
3. **LDR/HDR 的选择规则两处不同，不可统一**：
   - 面光照：外部参照实现的 `Lightmap.cs:55` 用「HDR lump 非空」判定，且 `:65` 必须用同一规则同步切换面表（`FacesHdr` / `Faces`），否则 `lightofs` 错位（只切光照不切面表 ⇒ 静默出垃圾，见下方硬要求）。
     **【本仓硬要求（已从「警告」升级为实测可判据）】**只切光照 lump、不同步切面表，在 `ze_cursed`(v21) 上会**静默出垃圾且不报错**：
     - `FACES(7)`（off=**7,463,548** len=**1,219,344**）与 `FacesHdr(58)`（off=**8,682,892** len=**1,219,344**）是**两张不同的表**（本仓实测）；
     - `FACES(7)` 的 `lightofs` **全 0 且无 -1**（21,774 / 21,774）；`FacesHdr(58)` 的 `-1`=**3,131**、live=**18,643**、max=**23,580,964**；
     - ① `LumpType::FacesHdr` = **58**（`src/wasm-core/vbsp/bspfile.rs:134`，序号由 `:142` 的 `const_assert` 锁定）。
     - ⇒ **光照 lump 与面表必须同条件切换**；只切光照 ⇒ 每面 `lightofs == 0` ⇒ 所有面读同一块 luxel（不超界）⇒ **不会报错**。
     - **只有 `ze_cursed` 能暴露这个错**：`surf_null` 两张表**同 offset、同 length、同内容**（均 2741728 / 328056），`surf_666` 的 `lump58` **缺席**（len=0）。
       ⇒ 验收时必须用 `ze_cursed` 做面表切换的吞吐测试；**只用 `surf_null`/`surf_666` 验收会漏掉这个接线错**。
     - **另一个相同后果的分支**：光照选 HDR 而面表选 FACES（或反之）同样静默——所以两者必须**用同一个 `hdrNonEmpty` 判定**。
   - 叶环境光：外部参照实现的 `AmbientCubes.cs:44` 用「长度更大」判定（`LeafAmbientLightingHdr.Length > LeafAmbientLighting.Length`）。
4. **样本格式为 `ColorRGBExp32`**（8 位尾数 + 8 位共享指数，4 字节）：外部参照实现的 `Structures.cs:511-523`；解码 `rgb_linear = mantissa_rgb * 2^(exp - 128)`（着色器外部参照实现的 `LightmappedBase.ts:39-43`；CPU 侧外部参照实现的 `Utils.ts:30-45`，指数表 `:9-14` 为 `2^(i-128)`）。
5. **相乘顺序：解码 → `pow(·, 1/2.2)` → 乘 base**：外部参照实现的 `LightmappedBase.ts:66`
   `return inColor * pow(sample, vec3(gamma, gamma, gamma));`，`gamma = 1.0/2.2` 定义在 `:47`。
   即 lightmap 被**当作 sRGB 空间的值**去乘已处于 sRGB 的 base 纹理，而不是把 base 转线性。这是上游刻意的低成本近似；照抄才有一致观感。`ApplyLightmap` 内**没有任何缩放或加法系数**（无 `$lightmap` 缩放、无 ambient 加项、无曝光乘子）。

补充三条本轮实测确认的约束：

6. **面矩形按 `LightMapSize + 3` 打包（即 luxel + 2）、有效矩形内缩 2 像素**：外部参照实现的 `LightmapLayout.cs:47-48`
   `Width = face.LightMapSizeX + 3; Height = face.LightMapSizeY + 3;`，`:49` 的 `HasSamples = face.LightOffset != -1` 决定该面是否入包，落位后 `:67` 内缩为 `IntRect(x + 1, y + 1, face.Width - 2, face.Height - 2)`。
   **注意这里的两级换算**：`LightMapSizeX/Y` 是 BSP 里存的格数（= luxel 数 − 1，见外部参照实现的 `Structures.cs:181` 的 `LightMapSize => new IntVector2(LightMapSizeX + 1, LightMapSizeY + 1)`），所以打包尺寸 = `(luxel − 1) + 3` = **luxel + 2**；内缩 2 后有效矩形 = `luxel + 2 − 2` = **恰好 luxel 数**。若把打包尺寸按 luxel 直接加 3 写（把格数当 luxel 数），有效矩形就会变成 luxel + 1（每面多 1 texel、UV 步长偏移），故必须按本条的两级换算写。
   ⇒ 有效矩形尺寸恰好等于 luxel 数；**单面 lightmap 区域的 texel 数因此有一个来自上游实现的硬上界**——外部参照实现的 `Lightmap.cs:64` 分配 `new ColorRGBExp32[256 * 256]` 作为读缓冲，`:73` 按 `rect.Width * rect.Height` 读入。**故实现必须保证单面矩形 ≤ 256×256（65536 texel）**，不能假设「luxel 数只由面面积决定」。
7. **图集尺寸由总面积推出、失败重试 2 次**：外部参照实现的 `LightmapLayout.cs:115-118` 以 `while (GetWidth(sizeIndex) * GetHeight(sizeIndex) < area) ++sizeIndex;` 选尺寸（`GetWidth = 1 << ((i+1)>>1)`、`GetHeight = 1 << (i>>1)`，`:74-82`），`:120-129` 最多重试 2 次后抛 `"Unable to pack lightmap!"`；打包器上限 **2048×2048**（`:61`）。
8. **采样必须手写双线性，不能用 GPU 线性过滤代替**：纹理是 `Nearest`（外部参照实现的 `Lightmap.cs:24-30`），因为**指数在 A 通道**，硬件插值会先混合指数再解码，得到错误结果。正确做法是先对 4 个 texel 各自解码再混合（外部参照实现的 `LightmappedBase.ts:39-66`）。仓库内已有一份等价实现：`apps/debug/src/renderer/lightmap-shader.ts:39-53`。

### 2.2 导出契约设计（这是本计划必须新造的部分）

外部参照实现的契约是「HTTP 资源 + JSON + PNG」，本仓库的通道是「单个 GLB」，因此**不能照搬其分页 JSON 结构**，要重新设计一条最小契约。建议如下（字段名固定，后续阶段按此对齐）：

| 契约元素 | 载体 | 语义 | 生成方 |
|---|---|---|---|
| lightmap UV | GLB mesh primitive 的 `TEXCOORD_1` 属性 | 每顶点的图集归一化 UV（texel 中心口径） | `src/wasm-core/bsp_to_gltf_core/` |
| lightmap atlas 纹理 | GLB 的 images/textures 项 | RGBA8：RGB = 尾数，A = 指数 + 128 | `src/wasm-core/bsp_to_gltf_core/` |
| 材质绑定 | `materials[i].extensions.__vbsp_lightmap__`（或 `extras`） | `{ textureIndex }` 指向 atlas | `src/wasm-core/bsp_to_gltf_core/gltf_builder.rs` |
| 面归属 | 现有 `primitives[i].extras.faceIndex` | 已存在，不需要新增：`src/wasm-core/bsp_to_gltf_core/convert.rs:1012-1014` 写入 `{"faceIndex":N}`。⚠️ 副本 `test/game-core/src/renderer/renderer-main.ts:296-297` 的注释「不依赖 GLB extras.faceIndex——WASM 导出未写入该字段，原 getFaceCluster 恒 -1」**已过期**（该字段确已写入）；实现者按本节与源码为准，勿据该注释改设计（本轮不改代码，仅登记） | `src/wasm-core/bsp_to_gltf_core/convert.rs:1012-1014` |
| 无光照面标记 | 同上 `extras` 内布尔位 | 供渲染端决定是否施加 | `src/wasm-core/bsp_to_gltf_core/` |

**为什么必须新造而不是照抄分页**：外部参照实现的索引契约 `/maps/{map}/index.json` 一次性暴露多组资源（`Index.cs:117` `name`、`:120` `lightmapUrl`、`:123` `leafPages`、`:126` `dispPages`、`:129` `materialPages`、`:132` `brushModelPages`、`:135` `studioModelPages`、`:138` `vertLightingPages`、`:141` `visPages`、`:144` `ambientPages`、`:147` `entities`），并把 lightmap 打进**单张** PNG（`Index.cs:120-121`、`Lightmap.cs:42`），而 ambient cube 单独走 `/maps/{map}/geom/ambientpage{page}.json`、每页 4096 叶（`AmbientCubes.cs:20,29-30`）。本仓库一次性交付 GLB，等价物是「atlas 内嵌在 GLB、UV 走 `TEXCOORD_1`」。

**本轮明确列为非目标的上游 page 面**（避免实现者以为漏读）：`dispPages`、`brushModelPages`、`studioModelPages`、`vertLightingPages`、`visPages` 五个 page 面**一律不实现**（证据：外部参照实现的 `Index.cs:126/:132/:135/:138/:141`）。它们分别服务置换面几何、刷模型、工作室模型、顶点光照贴图、可见性预计算，与「世界面静态光照」这一目标无关。

### 2.3 TS 侧的采样与接线点

- **施加位置**：必须在 `optimizeScene` **之前**，且 `loadGlb` 之后。副本现有顺序是 `loadGlb`（`test/game-core/src/renderer/renderer-main.ts:853`）→ `optimizeScene`（`:278`），空位就在 `:263` 与 `:278` 之间（`loadScene` 定义于 `:258`）。与 `apps/debug` 的既有顺序一致（`apps/debug/src/renderer/renderer-main.ts:505-516`）。
- **材质替换**：`apps/debug` 的既有实现是**新建 `MeshBasicMaterial` 替换原材质**（`apps/debug/src/renderer/lightmap-shader.ts:162-174`，保留原 `map`/`color`/`transparent`/`opacity` 后赋给 `mesh.material`），再对 `material.onBeforeCompile` 注入解码着色器（`:192`）。它是换新材质而非在原材质上打补丁——**换材质对象是可接受的，不构成块合并风险，前提是必须在 `optimizeScene` 之前施加**，因为块合并去重时材质实例被保留、映射关系不丢（`apps/debug/src/renderer/renderer-main.ts:514-515` 记录了该顺序理由）。
- **`uv2` 复制**：three.js r151+ 把 `TEXCOORD_1` 映射到 `uv1`，而 lightMap 槽由 `uv2` 驱动，故需 `geom.setAttribute('uv2', geom.getAttribute('uv1'))`（`apps/debug/src/renderer/lightmap-shader.ts:146-148`）。
- **图集尺寸 uniform**：着色器需要 `(w, h, 1/w, 1/h)` 或 `vbsp_AtlasSize` 以做手写双线性（`apps/debug/src/renderer/lightmap-shader.ts:41-45`）。外部参照实现侧等价信息由框架自动填 `(w,h,1/w,1/h)`（外部参照实现的 `Resources/js/facepunch.webgame.js:1778`）；本仓库需要自己传。

### 2.4 已就绪但未接线的真光源通道（独立于 lightmap，另列）

副本的 WASM 导出层**已经存在**真实光源导出函数：`test/game-core/crates/wasm/src/lib.rs:559` `export_glb_with_pakfile_models_with_lights`，其内部 `collect_light_entities(&bsp)`（`:577`）、`ExportOptions { include_lights: true }`（`:582-584`）；绑已生成（`test/game-core/pkg/websurf_wasm.d.ts:66`）。光源类别映射为 `light_spot → spot`、`light_environment → directional`、其余 `point`（`src/wasm-core/model_integrator/mod.rs:581-585`），`intensity = brightness * 5.0`（`:595`），spot 加 `inner/outerConeAngle`（`:608-613`），spot/directional 加 `direction`（`:617-621`）。启用开关在 `src/wasm-core/model_integrator/mod.rs:149` 与 `:162`（`if self.options.include_lights`）。

而生产路径**当前不启用**它：`src/ts-shared/phys/world-builder.ts:202` 调 `export_glb_with_pakfile_models_with_defaults(defaultsJson)`，其实现把 `light_entities` 置空（`test/game-core/crates/wasm/src/lib.rs:473`）并传 `ExportOptions::default()`（`:475`）；失败回退调 `export_glb_with_pakfile_models()`（`src/ts-shared/phys/world-builder.ts:205`）。

**这条通道与 lightmap 是互补而非替代**：外部参照实现 **没有**任何运行时方向光/阳光消费者——对 `外部参照实现.WebExport/Resources` 全目录检索 `light_environment`、`LightEnvironment`、`brightness`、`sun` 四个词，**零命中**；`light_environment` 虽被导出（外部参照实现的 `Entities.cs:226-254`），但渲染侧没有消费它的代码，太阳对场景的贡献是 VRAD 离线烘进 lightmap 的。**因此计划中不得出现「外部参照实现用运行时方向光/阳光」或「其着色器消费 LightEnvironment」这类论断。** 真光源通道的价值是让**道具/动态物**有方向感，世界面的静态光照仍以 lightmap 为准。

### 2.5 上游明确未实现、我方也不必实现的项

以下四项在外部参照实现里就是空的，实现者不要去找：

> **先记一条上游事实（直接影响 §5.3 未知项与阶段 2 的内存预算）**：三张图（`surf_666.bsp`、`surf_null.bsp`、`ze_cursed_bear_tales_v1_2.bsp`）中**仅 `surf_null.bsp` 为 LZMA 压缩**（lump 目录 `ident` 字段非 0 即表示该 lump 走 Source `LZMA` 头封装；实测非空 43 个中 41 个 `ident != 0`）；**另两图全部非空 lump 的 `ident` 均为 0**（`surf_666` 46/46、`ze_cursed…` 52/52）⇒ 盘上长度即实际长度。因此 **`ident != 0` 的 lump，其目录里的 `length` 是「盘上压缩长度」而不是解压后的字节数；`ident == 0` 的 lump，`length` 就是实际长度**。要压测解压路径，**`surf_null` 是唯一语料**。实测对照（2026-09-18）：`surf_null.bsp` 的 `LIGHTING`(8) 与 `LIGHTING_HDR`(53) 盘上各 **6,062,916 B**，解压后各 **22,961,620 B**（1:3.8）。凡涉及预算、缓冲分配、lump 长度判定的表述**一律用实际字节数**（`ident != 0` ⇒ 解压后长度，`ident == 0` ⇒ 盘上长度）；§9.8.3 的推荐判据同样如此。特别地，`LIGHTING_HDR` 判空用的是它自己的长度字段（压缩态为 0 ⇔ 解压态为 0），两条口径在「空/非空」这一判据上等价。

- **光照样式（light styles）**：全仓唯一痕迹是死代码——外部参照实现的 `Structures.cs:169`（私有 `_styles`）与 `:183-186`（`GetLightStyle`），**无调用点**；只呈现 style 0 的静态烘焙结果，不做多 style 混合、不读 `WORLDLIGHTS`（`ValveBspFile.cs` 中根本没有该属性绑定）。
- **bump（`$bumpmap` / `BUMPLIGHT`）**：`$normalmap` 只被解析成纹理 URL（外部参照实现的 `Material.cs:209-211`），`Resources/src` 内唯一使用点是 Water 折射（外部参照实现的 `Water.ts:103-109`、`:153`）；`SurfFlags.BUMPLIGHT` 从未被读取。
- **env_cubemap**：全仓 `Resources/src` 无 cubemap 采样代码。
- **lighting origin**：被导出（外部参照实现的 `Index.cs:208`）但渲染侧旁注 `// TODO: lighting offset`（外部参照实现的 `Entities/StaticProp.ts:33-45`）。
- **世界面没有独立 ambient 项**：`ApplyLightmap` 只做 `base × lightmap`，VRAD 已把 ambient 烘进 luxel；`LeafAmbientLighting` 只服务静态模型/道具（外部参照实现的 `AmbientCubes.cs:29-80` → `BspModel.ts:113-172` → `StudioModel.ts:60-101`）。

## 3. 分阶段实施步骤

每阶段给「改动面 / 验证方式 / 回退点」三要素。阶段 0 是其他阶段的前置。

### 3.1 阶段 0：修掉静默失败并建立可观测性（前置，必须先做）

- **改动面**：`src/wasm-core/bsp_to_gltf_core/convert.rs:168-173`。现状是
  `if let Some(integrator) = model_integrator { if let Ok(modified_json) = integrator.add_lighting_to_gltf_json(&json_string) { json_string = modified_json; } }`
  —— `add_lighting_to_gltf_json` 返回 `Err` 时**不报错、不落日志、不中止**，`:175` 之后照常序列化。改为 `?` 传播，或至少在失败时产出可见错误。
- **为什么必须先做**：后续把 lightmap/ambient 注入挂到这条链路后，注入失败会产出**语法合法但无光照**的 GLB，现象是「场景变暗/退回假光照」，极易被误判为「数据没到」而非「注入失败」。
- **验证方式**：构造一次故意失败的注入（例如传入非法 JSON 或临时让注入函数返回错误），断言 `npm run build:wasm` 后的导出**必须可见失败**（返回错误或打印错误），而不是静默产出 GLB。
- **回退点**：该改动独立于光照，若引起既有导出失败面变化，直接改回原 `if let Ok(...)`。

### 3.2 阶段 1：共享层读取 LIGHTING/LIGHTING_HDR luxel（不改导出）

- **改动面**（全部在 `src/wasm-core/`）：
  1. `src/wasm-core/vbsp/mod.rs:204-292` 的读取链中新增 `lump_reader(LumpType::Lighting)` 与 `LumpType::LightingHdr` 的读取分支（二者择一或都读后择一，按 §2.1 第 3 条规则）；
  2. 新增 luxel 结构读取：4 字节 `ColorRGBExp32`（RGB 尾数 + 有符号指数）；
  3. 消费已存在但零引用的面级字段：`src/wasm-core/vbsp/data/mod.rs:375` 的 `light_offset`、`:377-378` 的 `light_map_texture_min` / `light_map_texture_size`，以及 `:182-183` 的 `light_map_scale/transform`；
  4. 叶环境光：把 `src/wasm-core/vbsp/reader.rs:139-143` 丢弃的 24 字节 ambient cube 落到结构体（现有 `Leaf` 被 `src/wasm-core/vbsp/data/mod.rs:237` 的 `const_assert_eq!(size_of::<Leaf>(), 32)` 锁死，需另立结构或改断言口径），并消费 `LEAF_AMBIENT_INDEX` / `_HDR`（`src/wasm-core/vbsp/bspfile.rs:127-128`）。
- **验证方式**：新增一个 Rust 单元/集成测试，对测试地图断言「解析出的 luxel 总数 == Σ 各面 `(LightMapSizeX+1)*(LightMapSizeY+1)`（仅 `light_offset != -1` 的面）」以及「每面读取的字节数与 `light_offset` 递增关系自洽」。**判据是等式成立，不是"看起来对"**。
- **回退点**：新增读取不影响既有导出路径（此阶段不改 `convert.rs` 的 JSON 产出），失败可整体回退该提交。

### 3.3 阶段 2：共享层生成 atlas 并写入导出契约

- **改动面**（全部在 `src/wasm-core/`）：
  1. 图集装箱：按 §2.1 第 6-7 条实现（`LightMapSize + 3` 即 luxel + 2 打包、内缩 2 像素、面积推尺寸、上限 2048×2048、重试 2 次后报错）。**必须校验单面 ≤ 256×256**，超过则报错而不是静默越界；
  2. 像素写出：RGB = 尾数、A = 指数 + 128（对齐外部参照实现的 `Lightmap.cs:89-92` 语义）；
  3. UV 生成：非置换面按「lightmap 轴 → 减 `light_map_offset` → 除以 `LightMapSizeX/Y`（**不是** +1）→ 映射进矩形 + 半像素」生成（对齐外部参照实现的 `Geometry.cs:600-608` 与 `LightmapLayout.cs:149-156`）；置换面**本轮不实现**（列为非目标）；
  4. 写 `TEXCOORD_1`：在 `src/wasm-core/bsp_to_gltf_core/convert.rs:1005-1008` 现有的 `TexCoords(0)` 旁新增 `TexCoords(1)` accessor，并扩展顶点结构（现有 `BspVertexData` 见 `src/wasm-core/bsp_to_gltf_core/convert.rs:1042-1045`，只有 position+uv）；
  5. 写材质绑定与 faceIndex（见 §2.2 契约表）；
  6. **无光照面统一写中性值**，确保同块属性集一致（理由见 §1.3 末）。
- **验证方式**：新增仓库内脚本（放对应工程的 `scripts/`，并在 `package.json` 注册 `test:*`）解析 GLB JSON chunk，断言：`TEXCOORD_1` 存在且每图元顶点数与 `POSITION` 相等；atlas 纹理存在且宽高为 2 的幂、≤ 2048；`extras.faceIndex` 与面表一致；对同一地图两次导出字节稳定。
- **回退点**：本阶段产物是新增字段，关闭生成即可回到阶段 1 之后的既有行为。

### 3.4 阶段 3：副本渲染端施加 lightmap

- **改动面**（全部在 `test/game-core/`）：
  1. 移植 `apps/debug/src/renderer/lightmap-shader.ts` 到副本渲染端（保留其 `loadLightmapAtlas` / `applyLightmapToMeshes` 两个入口与 `uv1 → uv2` 复制逻辑，见 `:80`、`:125`、`:146-148`）；
  2. 在 `test/game-core/src/renderer/renderer-main.ts:258` 的 `loadScene` 内、`:278` 的 `optimizeScene` 之前插入调用（参照 `apps/debug/src/renderer/renderer-main.ts:505-516` 的顺序与其注释理由）；
  3. 传图集尺寸 uniform 供手写双线性使用（`apps/debug/src/renderer/lightmap-shader.ts:41-45`）。
- **验证方式**：同一地图做**对照截图**（关/开 lightmap 各一张），确认：光照随地图变化（而不是三盏假灯）；无明显接缝；贴墙观察无采样越界。**判据是截图差异可见且无接缝**。
- **回退点**：该阶段只加渲染端代码，删除调用即回到假光照；保留 `renderer-main.ts:244-251` 三盏假灯，直到本阶段验收通过再决定是否移除。

### 3.5 阶段 4（可选，与阶段 3 解耦）：接入真光源池

- **改动面**（副本 + 共享层）：
  1. `src/ts-shared/phys/world-builder.ts:202` 生产调用改为带光照的变体——**注意 `with_lights` 没有 `defaults_json` 变体**，直接替换会**静默丢失缺失纹理的默认纹理回退**（现状回退见 `:205`）；必须先新增「默认纹理 + 光照」的合并变体，或显式接受回退损失；
  2. 渲染端接入点光源池（固定 8 灯，`apps/debug/src/renderer/light-manager.ts:29` 的 `MAX_POINT_LIGHTS = 8`；池化+按距离排序的既有实现见 `:152-185`）。**绝不可把上千个 `Light` 直接 `scene.add`**：three.js 为每个光源数量组合编译一次 shader，逐帧换集合会持续重编译；
  3. 光源节点必须在 `optimizeScene` 合并**之前**提取到独立容器——否则 `test/game-core/src/renderer/renderer-main.ts:1047` 的 `bspRoot.remove(gltfScene)` 会连光源节点一起摘掉（该函数的入口在 `:891`）。
- **前置条件（未解决就不要开这一步）**：地图几何没有法线（`src/wasm-core/bsp_to_gltf_core/convert.rs:1042-1045`）。未解决前标准光照材质无法正确出图。可选解法：在共享层按面平面法线导出 `NORMAL`（面法线可从 BSP 面数据得到），或改用不依赖法线的路径。
- **验证方式**：断言导出的 GLB `extensionsUsed` 含 `KHR_lights_punctual` 且光源数与地图实体一致；断言渲染端同帧启用的光源数恒 ≤ 8（池化生效）；对照开/关的截图。
- **回退点**：生产调用改回 `export_glb_with_pakfile_models_with_defaults` 即恢复。

### 3.6 阶段划分的自洽性说明

阶段 0 → 1 → 2 → 3 是严格串行依赖：0 提供可见失败，1 提供 luxel 数据，2 把数据变成契约，3 才可能采样。阶段 4 与 2/3 **无依赖**，可并行或延后；它与 lightmap 互补（§2.4），不是 lightmap 的前置。

## 4. 共享层 vs 副本的实现边界

四条边界判据（缺一条都会导致实现者走错层）：

1. **必须进共享层 `src/wasm-core/` 的改动**：lump 读取（`src/wasm-core/vbsp/mod.rs:204-292` 读取链）、luxel/ambient 结构（`src/wasm-core/vbsp/`）、atlas 生成、UV 计算、GLB 字段写出（`src/wasm-core/bsp_to_gltf_core/`）。理由：这些是**跨工程**能力，`apps/debug`、`apps/game`、`apps/viewer`、`test/dual-mode-harness`、`test/game-core` 共用同一份共享 crate，放进副本会造成第 6 份重复实现。
2. **只在副本 `test/game-core/` 内的改动**：渲染端施加逻辑（`test/game-core/src/renderer/`）、`RuntimeConfig.lighting` 段（副本 `RuntimeConfig` 见 `test/game-core/src/config.ts:77-88`，当前无 `lighting` 字段；`apps/debug` 的对应实现在 `apps/debug/src/config.ts:139`、`:196-206`）。
3. **契约脚本同步面 = 四份，不含 harness**：`apps/debug/scripts/check-wasm-api.mjs`（55 行）、`apps/game/scripts/check-wasm-api.mjs`（100 行）、`apps/viewer/scripts/check-wasm-api.mjs`（61 行）、`test/game-core/scripts/check-wasm-api.mjs`（100 行）——这四份**都做导入面校验**（debug 在 `:38`、viewer 在 `:39-40`、game/game-core 在 `:78-83`）。**新增任何 TS 导入的 wasm 符号，都必须同步声明面**，否则会以「✗ TS 导入了声明面之外的符号」失败（失败文案见 `test/game-core/scripts/check-wasm-api.mjs:95-98`）。两级语义的共享实现在 `src/scripts/lib/wasm-api-contract.mjs`：声明面 `assertDtsExports`（`:127`，逐符号断言 `\b<name>\s*\(` 命中 `pkg/websurf_wasm.d.ts`），导入面 `assertTsImportsCoveredByExports`（`:152`，判据为「`pkg/websurf_wasm*` 的实际导入符号 ⊆ dts 导出集合」，默认导入计入 `default`）。
   **例外：`test/dual-mode-harness/scripts/check-wasm-api.mjs` 没有导入面校验**——它只断言 12 个物理方法（`:26-39`）与 `class PhysWorld`（`:42`），连 `BspProcessor` 与 GLB 导出都不断言。所以新增 lightmap 导出符号时它**不需要**同步声明面。
4. **构建/输出影响面 = 五个模块工程全在，含 harness**：光注入链路是共享导出路径 `src/wasm-core/bsp_to_gltf_core/convert.rs:98` `export_bsp_with_models` → `:170` 注入点，而五个工程的 crate 都调用它——`apps/debug/crates/wasm/src/lib.rs:477`、`apps/game/crates/wasm/src/lib.rs:538`、`apps/viewer/crates/wasm/src/lib.rs:455`、`test/game-core/crates/wasm/src/lib.rs:538`、`test/dual-mode-harness/crates/wasm/src/lib.rs:1722`；harness 显式依赖共享 crate（`test/dual-mode-harness/crates/wasm/Cargo.toml:21` 的 `websurf-wasm-core = { path = "../../../../src/wasm-core" }`，`:19` 的 `websurf-phys`）。
   ⇒ **准确表述：harness 不在契约脚本同步面内（判据 3），但仍在共享 crate 的构建/输出影响面内（判据 4），属「门禁绿灯下静默变化」的盲区**——它的契约脚本与 `build:wasm` 都不会因光照相关输出变化而失败，必须靠 `npm run build:wasm` / `build:ts` 加它**自身的验证脚本**兜底。因此**回归面必须覆盖 harness**，列为明确验证动作（见 §5.1）。
5. **同一处改动必须落两遍**：`apps/game/scripts/check-wasm-api.mjs` 与 `test/game-core/scripts/check-wasm-api.mjs` 是**同一个 git blob**（blob sha1 均为 `e3fbeca4ebb58389788a38309061204afba488f4`，sha256 均为 `fb8bc4cc4407c937cfbd30a404c571ad28ec6b13e1d889be399ef8966967545d`）⇒ 任一改动只落一份，另一工程即失败。（哈希口径说明：行文中的 sha1 与 sha256 是同一内容的两种摘要，不是互相矛盾的两个值。）
6. **本仓库已有可复用资产在 `apps/debug`，不在副本**：`apps/debug/src/renderer/lightmap-shader.ts`（**迁移前** 224 行；2026-09-20 回并后 apps/debug 改用共享版 1785 行，见 §10）与 `apps/debug/src/renderer/light-manager.ts`（390 行）。移植而非直接跨工程引用——三个应用工程**互不引用**是本仓库的架构约束。

## 5. 风险与未知项

### 5.1 必须靠自建验证动作覆盖的盲区（最高优先级）

- **风险**：共享层光照改动会同时改变 debug / game / viewer / harness / game-core 五个工程的输出，但现有门禁**只能发现符号缺失与编译失败**，发现不了「输出里lightmap 字段消失」。
- **必须动作**：为回归面补一个解析 GLB JSON chunk 的脚本，断言 `TEXCOORD_1` 与 atlas 纹理存在、图元顶点数对齐、`extras.faceIndex` 自洽；**该脚本必须在全部五个模块工程上跑**（含 harness）。
- **未知**：harness 自身的验证脚本目前完全不覆盖 GLB 内容，需要新增还是改造其既有 `test:*`，取决于 harness 的脚本清单——实现时先读 `test/dual-mode-harness/package.json` 的 `scripts` 再决定。

### 5.2 已知风险清单

| # | 风险 | 证据 | 处置 |
|---|---|---|---|
| R1 | 注入失败被静默吞掉，产出「合法但无光照」的 GLB | `src/wasm-core/bsp_to_gltf_core/convert.rs:168-173` | 阶段 0 先修 |
| R2 | 单面 lightmap 区域超过 256×256 会越界写（`dst[index]` → `IndexOutOfRangeException`） | 外部参照实现的 `Lightmap.cs:64`（`new ColorRGBExp32[256*256]`，仅 65536 项）与 `:73`（按 `rect.Width * rect.Height` 读入）；越界点在外部参照实现的 `LumpReader.cs:99-101` 的 `dst[dstOffset + index] = item` | 阶段 2 显式校验并报错 |
| R3 | 地图几何无法线，真光源路线无法正确出图 | `src/wasm-core/bsp_to_gltf_core/convert.rs:1042-1045`（无 `normal`）对比 `src/wasm-core/model_integrator/mod.rs:1024-1028`（有 `normal`） | 阶段 4 前置条件；先解决法线来源 |
| R4 | 同块属性集不一致导致 `mergeGeometries` 返回 null、draw call 反弹 | `test/game-core/src/renderer/renderer-main.ts:998`、`:1020` | 阶段 2 给无光照面写中性值 |
| R5 | 直接换用 `with_lights` 会丢失默认纹理回退 | `test/game-core/crates/wasm/src/lib.rs:559`（无 `defaults_json` 形参）对比 `:435`（有） | 阶段 4 新增合并变体或显式接受损失 |
| R6 | 光源节点被分块合并流程摘除 | `test/game-core/src/renderer/renderer-main.ts:1047` `bspRoot.remove(gltfScene)` | 阶段 4 在合并前提取到独立容器 |
| R7 | 上千光源直接入场景引发 shader 反复重编译 | `apps/debug/src/renderer/light-manager.ts:29` 的 8 灯上限即为此设计 | 阶段 4 强制池化 |
| R8 | 同一份 `check-wasm-api.mjs` 改动漏落一份 | blob sha1 `e3fbeca4ebb58389788a38309061204afba488f4` | 改动后对两工程各跑一次契约脚本 |
| R9 | 不宜依赖「6 个 sample 压进一个 int」的隐式约定 | 外部参照实现的 `AmbientCubes.cs:67` 直接透传 int，TS 侧 `Utils.ts:33-36` 按小端 r/g/b/exp 解码 | 导出侧直接给 `[r, g, b, exp]`（分字段或显式打包），并配自测：用已知输入验证解码结果与 C# 端逐项一致 |
| R10 | 着色器用 GPU 线性过滤替代手写双线性会破坏指数编码 | 指数在 A 通道（外部参照实现的 `Lightmap.cs:89-92`） | 保持 `Nearest` + 手写双线性 |

### 5.3 未知项（实现前必须实测，不得假设）

1. **three.js（副本所用版本）对 `KHR_lights_punctual` 的自动实例化行为**：本轮只做过 GLB JSON 静态核查，未在浏览器实测。计划不依赖该行为成立——阶段 4 的池化实现自取光源数据，不假设加载器代为实例化。
2. **无 `NORMAL` 时标准材质的实际出图结果**：未实测，仅从「无法线 ⇒ 法线退化」推断。阶段 4 开始前应先用最小对照实验确认。
3. **atlas 尺寸/页数预算**：单张 2048×2048 RGBA8 为 16 MB；若某地图 luxel 总量超出单张上限，需要多张 atlas 或降采样——本计划未给页数方案，实施阶段 2 时必须先用真实地图算出需求再定。
4. **`apps/debug` 的 lightmap 路径为何长期空转**：其调用点在 `apps/debug/src/renderer/renderer-main.ts:505-508` 已接线，但共享层从不产出 `extras.lightmap.textureIndex` 与 `TEXCOORD_1`，故必然走「无 atlas、应用 0 个 mesh」的空转分支。这是**契约缺失**，不是该实现有误；但不能据此默认它在真实数据下无 bug，移植后需自行验证。
5. **置换面（displacement）的 lightmap**：其 UV 产生方式与非置换面不同（外部参照实现的 `Geometry.cs:574`、`:582` 直接用归一化 `(u,v)`），且其 lightmap alpha 字段在本仓库同样零引用（`src/wasm-core/vbsp/data/mod.rs:865-866`）。本轮列为非目标。

## 6. 回并 apps/game 的路径与验收条件

### 6.1 回并前提

`test/game-core` 是 `apps/game` 的**有意 Fork 副本**，按仓库既有判定，副本与上游仅允许 4 处适配差异（`test/game-core/package.json`、`test/game-core/.gitignore`、`test/game-core/play.cmd` 与 `test/game-core/start-dev.cmd` 的端口）。因此回并的正确形态是：**共享层改动（`src/wasm-core/`）上游自动共享**，不需要「回并」动作；只有副本内的渲染端改动需要搬。

### 6.2 回并顺序

1. **先落共享层**：阶段 0/1/2 的改动在 `src/wasm-core/`，五个工程立即共享。此时必须跑全量契约与构建（见 §6.3）。
2. **再落副本渲染端**：阶段 3 的渲染端文件（移植的 lightmap 着色器 + `renderer-main.ts` 接线）逐文件搬到 `apps/game/src/renderer/` 对应位置。**搬运前先复核目标文件行号**——副本与 `apps/game` 并非永远同步，引用行号需在 `apps/game` 侧重新确认。
3. **配置段回并**：`RuntimeConfig.lighting` 若引入，需同步 `apps/game/src/config.ts`；注意 `apps/debug/src/config.ts:139`、`:196-206` 是可参照的既有形态。
4. **阶段 4 单独回并**：它与阶段 3 解耦，可延后或放弃而不影响 lightmap 生效。

### 6.3 回并验收条件（逐条可判定）

1. `apps/game` 与 `test/game-core` 的 `scripts/check-wasm-api.mjs` 仍为同一 blob（sha1 `e3fbeca4ebb58389788a38309061204afba488f4`）；两工程契约脚本各自 exit 0。
2. 两工程的 `npm run typecheck` 与 `npm run build:ts` 各自 exit 0。
3. 五个模块工程各跑一次 GLB 内容断言脚本，`TEXCOORD_1` 与 atlas 存在、图元顶点数对齐、`extras.faceIndex` 自洽（含 harness，理由见 §4 判据 4）。
4. 同一地图在 `apps/game` 与副本上出图一致（对照截图：光照形态相同，仅端口/配置差异）。
5. 文档门禁零漂移：`node src/scripts/check-doc-drift.mjs` 的 A（行数声明）与 B（锚点越界）计数为 0。
6. 工作区无临时产物混入：`git ls-files -- '**/temp/**' '**/.tmp/**'` 为空；`git status --short --untracked-files=all` 逐条确认。

### 6.4 关于文档位置的说明

本文按仓库约定放在 `documents/game/implementation/lighting-merge-plan.md`（工程文档四维度之「细分实现篇」，`implementation/<主题>.md`）。**依本轮约束不擅自换位置**，但给出一个需要考虑的替代建议供裁定：本计划的主体改动面在**共享层**（`src/wasm-core/`，影响全部五个模块工程），而非 game 工程独有；若后续这份计划演变为「共享层 lightmap 能力」的长期维护文档，`documents/` 根目录的共享层篇（与 `documents/wasm-core.md` 同层）可能比 `documents/game/` 更贴合归属。本轮**不改路径**，仅登记此建议。

## 7. LICENSE 结论（第三方代码复用）

**结论：可复用，须保留署名。**

证据（外部参照实现仓库根）：

- `LICENSE:1` 为 `MIT License`；`LICENSE:3` 为 `Copyright (c) 2016 James King`；`LICENSE:5-11` 为标准 MIT 条款，允许使用、复制、修改、合并、发布、再许可，**唯一硬性义务是在所有副本或实质部分中保留上述版权声明与许可文本**。
- 补充实测：对外部参照实现全部 `.csproj` 检索 `PackageLicense`、`License`、`Copyright`、`Authors` **零命中**，即许可声明只存在于仓库根 `LICENSE` 文件，不在包元数据中——引用时不要指望从工程文件里找到许可信息。
- 外部参照实现的 `Resources/js/外部参照实现.js` 是 `Resources/src/*.ts` 经 tsc 的**构建产物**（`外部参照实现.WebExport/外部参照实现.WebExport.csproj:152-184` 的 `TypeScriptCompile` 元素组），若要复用应搬 `.ts` 源而不是抄 `.js` 产物。
- 外部参照实现仓库含 `.gitmodules`；若未来需要复用其子模块代码，需对子模块单独核查许可。

**规避策略（本计划采取）**：本计划只在**算法口径**层面引用上游（luxel 数推导、字节偏移、LBR/HDR 择一、解码公式、相乘顺序、图集装箱规则），全部以中文重新表述并附行号证据，**不复制上游代码**。这样即便署名义务被简化处理，也不引入第三方代码的衍生作品关系。若实现阶段确实需要移植上游源码片段，则必须在该文件头部保留 `Copyright (c) 2016 James King` 与 MIT 全文。

## 8. 本轮边界声明

**本轮只出计划、不改代码。** 本轮的刻意未做项：

1. 未改动 `apps/`、`src/`、`test/` 下任何代码或配置。
2. 未同步 `documents/index.md`、根 `README.md`、`AGENTS.md`、`CHANGELOG.md` 的导航与计数（属集成任务）。
3. 未新建任何 `.wasm`、未重新构建 `pkg/`、未生成任何地图产物；本计划全部事实来自源码静态阅读与只读探针。
4. 未评估具体 atlas 页数方案与压缩格式（属阶段 2 实施内容）。
5. 未实现置换面、光照样式、bump、env_cubemap、lighting origin、ambient cube 收敛到世界面等上游同样未实现的项（理由见 §2.5，非目标）。
6. 未实测浏览器侧行为（`KHR_lights_punctual` 实例化、无法线出图），已登记为 §5.3 未知项而不是结论。

## 9. 本轮实施契约（r1，2026-09-18）

> 本章是把 §1–§8 的**计划**收敛成本轮可直接照着做的**契约**：Fork 边界、目标布局、依赖重指向、导出契约的可断言形式、验收判据、非目标与例外登记。读者是实现者（t2/t3）、复核者（t4）、评审者（t5）与收口者（t6）。
> 本章只写文档、不改任何代码；所有结论均给本仓库内 `文件:行号` 证据。文档内 `npm run *`、`node *` 属命令而非文件引用。

### 9.1 硬边界与「共享层隔离例外」声明

**本轮唯一允许的改动落点：`test/game-core/**`。** 仓库根 `src/**` 与 `apps/**` 必须逐字节不变（判据见 §9.8.1）。

本次是**经用户明确授权的共享层隔离例外**，对应 [AGENTS.md](../../../AGENTS.md) §2「Rust 物理 / 解析实现 → `src/phys/`、`src/wasm-core/`；**禁止**在工程内复制共享实现」的一般禁止条款。例外的必要性与代价：

| 维度 | 说明 |
|---|---|
| 为什么必须破例 | 本轮改动面在 `src/wasm-core/**`（§3 阶段 0–2 全部落在这里，见 `src/wasm-core/bsp_to_gltf_core/convert.rs:170`、`src/wasm-core/vbsp/mod.rs:204` 一带的读取链）。若就地改根部，`apps/debug`、`apps/game`、`apps/viewer`、`test/dual-mode-harness`、`test/game-core` 五个模块工程会同时变（构建影响面证据：`apps/debug/crates/wasm/Cargo.toml:24`、`apps/game/crates/wasm/Cargo.toml:24`、`apps/viewer/crates/wasm/Cargo.toml:19`、`test/dual-mode-harness/crates/wasm/Cargo.toml:21`、`test/game-core/crates/wasm/Cargo.toml:24` 全部 path 指向同一份 `../../../../src/wasm-core`），与「改动只落 test/game-core」冲突。 |
| 例外的代价 | 副本**不再随根部上游演进**：`test/game-core` 从「共享层零重复」（现记于 [AGENTS.md](../../../AGENTS.md) §7.2.4）变为「`websurf-wasm-core` 在副本内隔离演进」。此事实必须在 §9.9 列出的受控位置显式登记，不得只靠本章。 |
| 例外范围（严格最小） | **只复制 `src/wasm-core/`**。`src/`（websurf-phys）、`src/ts-shared/`、`src/vendor/vmdl/`、`src/scripts/`、`src/materials/` 一律不复制——本轮的改动面不需要它们（理由逐条见 §9.3.2）。 |

### 9.2 目标布局

```
test/game-core/
├─ Cargo.toml                       # 改：+ 成员 crates/wasm-core；保留 vmdl patch（指向根部 vendor）
├─ Cargo.lock                       # 改：随成员增加重生成（本地，不入库）
├─ crates/
│  ├─ wasm/                         # 不变结构；仅 Cargo.toml 依赖重指向
│  │  ├─ Cargo.toml                 # 改：websurf-wasm-core → ../wasm-core（websurf-phys 仍指根部）
│  │  └─ src/lib.rs                 # 本轮新增：光照注入错误可见化的注释同步（见 §9.3.3）
│  └─ wasm-core/                    # 新增：src/wasm-core/ 的逐字节副本（25 文件，25 项，约 0.30 MB）
│     ├─ Cargo.toml                 # 改：name 保持 websurf-wasm-core，version 改 0.1.0-fork（必须，见 §9.3.1）
│     ├─ lib.rs
│     ├─ pakfile_models.rs
│     ├─ phyfile.rs
│     ├─ bsp_to_gltf_core/{mod.rs,convert.rs,gltf_builder.rs,materials.rs}
│     ├─ model_integrator/mod.rs
│     ├─ mosaic/{mod.rs,decode.rs,encode.rs,manifest.rs,mtz.rs}
│     ├─ texture_utils/{mod.rs,image.rs,vtf.rs}
│     └─ vbsp/{mod.rs,bspfile.rs,error.rs,reader.rs,data/{mod.rs,entity.rs,game.rs},handle/mod.rs}
└─ src/renderer/…                   # 本轮新增：lightmap 采样与接线（纯新增文件 + 一处插入，见 §9.3.3）
```

**放置位置的理由**：`crates/` 下与既有成员 `crates/wasm` 平行，不引入 `test/game-core/wasm-core/` 这类新顶层目录；同时避开 `test/game-core/src/`（该目录是 TS 源码根，已有 `src/app.ts`、`src/config.ts` 等）；`crates/` 已被 `test/game-core/.gitignore` 的 `target/` 规则覆盖（`test/game-core/.gitignore` 第 14 行 `target/`），故副本 crate 的构建产物不会入库——**但为稳妥起见，t2 需确认 `test/game-core/.gitignore` 与 `git status --short --untracked-files=all` 中不出现副本 crate 的 `target/`**。

### 9.3 需改动的根 src/ 文件 ⇒ 副本落点 ⇒ 重指向（逐项）

#### 9.3.1 `src/wasm-core/` ⇒ `test/game-core/crates/wasm-core/`（整体复制）

复制范围 = `src/wasm-core/` 全部 25 个文件（`Cargo.toml` + 24 个 `.rs`，合计 8334 行）。**不做文件级筛选**：本 crate 是自包含的单一 crate，内部全部用 `crate::` 路径（证据：`src/wasm-core/bsp_to_gltf_core/convert.rs:4` 的 `use crate::bsp_to_gltf_core::gltf_builder::…`；`src/wasm-core/vbsp/mod.rs:11` 的 `use crate::vbsp::bspfile::LumpType;`），全仓 `src/wasm-core` 内 71 处 `crate::`/`super::` 引用**无一处**指向 crate 之外；块状态与 host 无关，故**副本内部零路径改写**。

三处必须改的元数据：

| 文件 | 改什么 | 值 | 理由（证据） |
|---|---|---|---|
| `test/game-core/crates/wasm-core/Cargo.toml` | 版本号 | `version = "0.1.0-fork"`（`name` 保持 `websurf-wasm-core`） | **硬约束**：同一 Cargo workspace 的 lockfile 不允许两个同名同版本但路径不同的包。实测（`.tmp` 探针，2026-09-18）：`cargo build` 报 `error: package collision in the lockfile: packages probe-a v0.1.0 (…\a) and probe-a v0.1.0 (…\c) are different, but only one can be written to lockfile unambiguously`。改成不同版本后 `cargo build` 通过且 `use probe_a::f;` 无需改（Rust crate 名仍是 `probe_a`）。因此 `test/game-core/crates/wasm/src/lib.rs:20` 的 `use websurf_wasm_core::{…}` **保持不动**。 |
| 同文件 | crate 说明注释 | 追加「本目录是 `src/wasm-core/` 的隔离副本，来源 commit/日期、以及『根 `src/` 零改动』」 | t2 交付条款要求；属被评审对象 |
| `test/game-core/crates/wasm-core/Cargo.toml` | 保持依赖清单不变 | 与 `src/wasm-core/Cargo.toml` 第 20-70 行逐字节一致 | 无需增删依赖：该清单内**没有任何**指向 `src/` 的相对路径 |

#### 9.3.2 明确**不**复制的根部共享实现（逐条给理由）

| 根部路径 | 现状引用点 | 本轮处置 | 理由 |
|---|---|---|---|
| `src/`（`websurf-phys`） | `test/game-core/crates/wasm/Cargo.toml:22` `websurf-phys = { path = "../../../../src" }` | **保持指向根部，不复制** | 阶段 0–3 无任何 `src/phys` 改动面（阶段 4「实体光源」属非目标，§9.7）；复制它会把例外范围从 1 个 crate 扩大到 2 个。 |
| `src/ts-shared/**`（23 个 TS 文件） | `test/game-core/tsconfig.json:15` 的 `include`；业务侧引用共 13 行（如 `test/game-core/src/app.ts:18-22`、`test/game-core/src/config.ts:5`、`test/game-core/src/renderer/renderer-main.ts:20-24`、`test/game-core/src/worker/main.ts:21-28`） | **保持指向根部，一个文件都不复制** | 它的引用深度是**三层**（`test/game-core/src/…` → `../../../src/ts-shared/…`），而新副本的落点会落到 `test/game-core/src/` 下（与 TS 源码根冲突），或需要一个与现有相对深度不同的新路径——两者都会强制改写上述 13 行既有引用，属无收益的破坏性改动。本轮 lightmap 链路（阶段 3）的消费者在 `test/game-core/src/renderer/`，**不需要**改动任何 `src/ts-shared` 文件（§3.4 的改动面只有「移植 lightmap 着色器 + `renderer-main.ts` 接线 + atlas 尺寸 uniform」）。 |
| `src/scripts/lib/wasm-api-contract.mjs` | `test/game-core/scripts/check-wasm-api.mjs:22`（三层 `../../../`），`test/game-core/scripts/build-dist.mjs:39` | **保持指向根部，不复制** | 见 §9.5 的逐条结论。 |
| `src/vendor/vmdl/` | `test/game-core/Cargo.toml:14` 的 `[patch.crates-io]` | **保持指向根部，但 patch 声明必须留在副本 workspace** | 见下文 vmdl 段。 |
| `src/scripts/cargo-env.cmd`、`ensure-node-deps.cmd`、`wasm-stale-check.mjs`、`serve.py`、`src/materials/textures.mtz`、`src/phys/{LICENSE,NOTICE}` | `test/game-core/play.cmd:26`、`test/game-core/start-dev.cmd:26` 与 `:42`、`test/game-core/package.json:15`、`test/game-core/scripts/build-dist.mjs:48`、`:208` | **保持指向根部** | 全是**只读共享资源**，且本轮不改。注意 `wasm-stale-check.mjs` 的调用已把 `crates` 整棵子树作为扫描根（`test/game-core/start-dev.cmd:35` 末参 `"%~dp0crates"`），`src/scripts/wasm-stale-check.mjs:36-61` 递归 walk 会**自动覆盖**新成员 `crates/wasm-core`，无需改一行。 |

**关于 `vmdl`（最容易踩空的一处）**：`test/game-core/Cargo.toml:14` 的 `[patch.crates-io] vmdl = { path = "../../src/vendor/vmdl" }` 必须**保留**。证据链：
- 仓库根 `Cargo.toml`（第 12-14 行注释）明确写着「注意：`[patch]` 只对『声明它的 workspace』生效——根这里管共享层两个 crate；**各模块 workspace 的同类 patch 在 debug/game/viewer/test 各自的 `Cargo.toml`**」；
- 现状 `test/game-core/Cargo.lock` 中 `vmdl` 条目（第 1867-1881 行）**没有 `source =` 行**，即当前确实被 patch 成路径依赖（注册表依赖会有 `source = "registry+…"` 与 `checksum`）；
- 新增 workspace 成员 `crates/wasm-core` 后，若该 patch 丢失，`vmdl` 会解析回 crates.io 0.2.0，静默丢掉 VTX 三角条带修复（`src/vendor/vmdl/Cargo.toml` 第 8 行的自述）。

`test/game-core/Cargo.toml` 的最小目标形态（结构性示意，注释按仓库习惯写）：

```toml
[workspace]
members = ["crates/wasm", "crates/wasm-core"]
resolver = "2"

[patch.crates-io]
vmdl = { path = "../../src/vendor/vmdl" }

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
```

> `[profile.release]` 必须保留：`test/game-core/Cargo.toml:19-22` 现有该段，且模块 workspace 是唯一生效处（根 `Cargo.toml` 的 profile 只作用于共享层本体的构建）。

#### 9.3.3 副本内的其余改动落点（全部在 `test/game-core/**`）

| 落点 | 类型 | 说明 |
|---|---|---|
| `test/game-core/crates/wasm-core/bsp_to_gltf_core/convert.rs` | 改 | 阶段 0/1/2 的实现位置（对应根 `src/wasm-core/bsp_to_gltf_core/convert.rs:170` 的注入点、`:1006` 的 `Semantic::TexCoords(0)`、`:1042` 的 `BspVertexData`） |
| `test/game-core/crates/wasm-core/vbsp/**`、`bsp_to_gltf_core/**` | 改/增 | 阶段 1/2 的解析与 atlas 生成（对应根 `src/wasm-core/vbsp/mod.rs:204` 的读取链、`src/wasm-core/vbsp/data/mod.rs:375-378` 的零引用面字段） |
| `test/game-core/src/renderer/lightmap-shader.ts` | 新增 | 从 `apps/debug/src/renderer/lightmap-shader.ts`（**迁移前** 224 行；2026-09-20 回并后 apps/debug 改用共享版 1785 行，见 §10）移植，保留 `loadLightmapAtlas`（`:80`）、`applyLightmapToMeshes`（`:125`）、`uv1→uv2` 复制（`:146-148`）、手写双线性（`:39-55`）、`NoColorSpace`+`NearestFilter`（`:104-107`） |
| `test/game-core/src/renderer/renderer-main.ts` | 改 | 在 `:263`（`loadGlb` 之后）与 `:278`（`this.optimizeScene(scene, gltf.scene);`）**之间**插入调用；理由与 `apps/debug/src/renderer/renderer-main.ts:505-516` 一致（必须在分块合并前施加）。**落在 `:278` 之后即违反契约**（`mergeGeometries` 见 `:998`、`:1020`）。 |
| `test/game-core/crates/wasm/src/lib.rs` | 改（仅注释） | `:19` 与 `:22` 的「共享自仓库根 src/…」表述必须改为如实反映「`websurf-wasm-core` 已副本化到 `crates/wasm-core`；`websurf-phys` 仍共享根部」 |
| `test/game-core/package.json` | 改 | `:4` 的 `description` 现写「共享层仍以 ../../src 引用同一份 ts-shared / wasm-core / phys，**不重复实现共享逻辑**」——已不成立，必须改为如实描述（`wasm-core` 副本化、其余仍共享）；并注册新增的 `test:*` 脚本 |
| `test/game-core/scripts/lightmap-gltf-assert.mjs` | 新增 | §9.6.4 的 GLB 契约断言脚本，并在 `test/game-core/package.json` 的 `scripts` 注册 `test:lightmap-gltf` |

### 9.4 依赖重指向（层数逐条核算，本仓库已知易错点）

| 起始文件 | 目标 | 相对路径 | 层数核算 |
|---|---|---|---|
| `test/game-core/crates/wasm/Cargo.toml:23-24` | 副本解析层 | `websurf-wasm-core = { path = "../wasm-core" }` | 从 `crates/wasm/` 上跳 **1** 层到 `crates/`，再进 `wasm-core/` |
| `test/game-core/crates/wasm/Cargo.toml:22` | 根部物理层 | `websurf-phys = { path = "../../../../src" }`（不变） | `crates/wasm`→`crates`→`game-core`→`test`→仓库根，共 **4** 层，再 `src` |
| `test/game-core/crates/wasm-core/Cargo.toml` | 无 path 依赖 | 不变 | 该清单（第 20-70 行）内零相对路径 |
| `test/game-core/Cargo.toml:14` | 根部 vmdl vendor | `path = "../../src/vendor/vmdl"`（不变） | `game-core`→`test`→仓库根，共 **2** 层 |
| `test/game-core/tsconfig.json:15` | 根部 TS 共享层 | `include: [..., "../../src/ts-shared/**/*.ts"]`（不变） | `game-core`→`test`→仓库根，共 **2** 层（注意：此处的层级基准是 **`test/game-core/`**，不是 `src/`，与业务 TS 文件的三层 `../../../` 不同——两者都要保留原值） |
| `test/game-core/scripts/*.mjs` | 根部脚本共享层 | `../../../src/scripts/lib/…`（不变） | `scripts`→`game-core`→`test`→仓库根，共 **3** 层（`test/game-core/scripts/check-wasm-api.mjs:22`、`test/game-core/scripts/build-dist.mjs:39`） |
| 新增 `test/game-core/scripts/lightmap-gltf-assert.mjs` | 无根部依赖 | 只读本工程 `pkg/`、`web/` 与地图 | 不新建跨仓依赖 |

**施工顺序建议**（每步末自查非污染）：① 建 `crates/wasm-core/` 副本 → ② 改 `test/game-core/Cargo.toml`（+成员、保 patch）→ ③ 改 `crates/wasm/Cargo.toml` 依赖 → ④ `npm run build:wasm`（重生成 `Cargo.lock`）→ ⑤ `npm run typecheck`。

### 9.5 TS 与脚本侧共享依赖的处置（acceptance 第 4 条的逐条结论）

| 引用点 | 现路径 | 结论 |
|---|---|---|
| `test/game-core/scripts/check-wasm-api.mjs:22` | `../../../src/scripts/lib/wasm-api-contract.mjs` | **保持不动**。本轮 lightmap 能力**不新增任何 wasm-bindgen 导出符号**：数据随既有 `export_glb_with_pakfile_models_with_defaults` 的 GLB 字节返回（`test/game-core/crates/wasm/src/lib.rs` 内的导出面不变），故声明面（`check-wasm-api.mjs` 第 30-48 行的 `EXPORT_API` / `PHYS_API`）与导入面（同文件第 79-83 行的 `assertTsImportsCoveredByExports`）都不需要新符号。**禁止**改仓库根 `src/scripts/lib/wasm-api-contract.mjs`。 |
| `test/game-core/scripts/build-dist.mjs:39` | `../../../src/scripts/lib/dist-pack.mjs` | **保持不动**（只读，本轮 build-dist 流程零改动）。另同文件 `:21` 的路径注释、`:48` 的 `src/materials/textures.mtz` 与 `:208` 的 `src/phys` 许可证源同为只读共享资源，一并保持不动 |
| `test/game-core/package.json:15` | `python ../../src/serve.py 8190 .` | **保持不动** |
| `test/game-core/package.json:17-19` 现有 `test:phys` / `test:seed-smoke` / `test:surf-crouch` | 脚本自身只 import `../pkg/websurf_wasm.js` | **不受影响**；新增 `test:lightmap-gltf` 并列注册 |

**若实现过程中发现真的需要改根 `src/scripts/lib/*` 或 `src/ts-shared/*`**：那不是本轮范围，必须**停下并回报**，不得就地改根部，也不得顺手复制整棵共享树。

### 9.6 导出契约（可断言形式）

#### 9.6.1 元素与语义（字段名固定）

| 契约元素 | 载体（GLB 内位置） | 语义 | 生成方 |
|---|---|---|---|
| lightmap UV | `meshes[*].primitives[*].attributes.TEXCOORD_1` | 每顶点图集归一化 UV，**texel 中心口径**（`(x+0.5)/W`、`(y+0.5)/H`） | 副本 `bsp_to_gltf_core/` |
| lightmap atlas 纹理 | `images[*]` + `textures[*]`（`bufferView` 指向 RGBA8 原始字节；**不要求** PNG 编码，PNG 亦可） | RGB = 尾数、A = 指数 + 128 | 副本 `bsp_to_gltf_core/` |
| 材质绑定 | `materials[*].extensions.__vbsp_lightmap__ = { "textureIndex": N }` | `N` 指向 `textures[N]` | 副本 `gltf_builder.rs`（对应根 `src/wasm-core/bsp_to_gltf_core/gltf_builder.rs:100-108` 的材质块） |
| **atlas 入口（承重项）** | **`asset.extras.lightmap.textureIndex = N`** | 等价于上面的纹理索引，供渲染端取用；**两个位置都要写且相等**（渲端容错见下） | 副本 `bsp_to_gltf_core/` |
| 面归属 | `primitives[*].extras.faceIndex`（**已存在**，勿改语义） | 该图元对应的 BSP 面序号 | 现状即写入，证据 `src/wasm-core/bsp_to_gltf_core/convert.rs:864` 注释与 `:1013` |
| 图元是否有真实光照 | `primitives[*].extras.hasLightmap = true/false` | `false` 表示该图元写的是**中性占位值**（不是真实 luxel） | 副本 `bsp_to_gltf_core/` |
| **lump 选择可观测（承重）** | **`asset.extras.lightmap.source = { "lumpIndex": 8\|53, "byteLength": N, "hdrNonEmpty": bool }`** | 本次宜选的光照 lump 与依据；因现有语料无法从输出反推选择（§9.10.2 第 5 项），故该字段是**替代断言**的唯一落点 | 副本 `bsp_to_gltf_core/` |

**渲端实际读取位置（契约必须以它为准）**：`apps/debug/src/renderer/lightmap-shader.ts:85-89` 只读 `gltf.asset.extras.lightmap.textureIndex`，并以 `gltf.scene.userData.extras.lightmap.textureIndex` 作为备选。因此 `asset.extras.lightmap.textureIndex` 是**必须**项：`test/game-core/src/renderer/lightmap-shader.ts` 的移植版若只写 `materials[i].extensions`，`loadLightmapAtlas` 会静默返回 `null`（空转）。**`extras` 用于 `asset`，`extensions` 用于 `materials`——两者不要混用**（`extensions` 里的未注册扩展会被 onLoad 警告，而 `asset` 无此顾虑）。

#### 9.6.2 数值等式（判据，不是"看起来对"）

**术语先行**（本轮最容易混的两个量，必须分开叫）：
- **cap（容器容量）** = 所选光照 lump 的**实际字节数**（`ident != 0` 时取 LZMA 解压后长度，否则取盘上长度）。它是上限，不是"应有"的数量。
- **capSamples（样本容量）** = `cap ÷ 4` = 该容量可容纳的 **luxel（texel 样本）数**。它与 `cap` 是**同一容量的两种量纲**（字节 vs 样本），引用时**不得混用**。
- **面表总数（faceTotal）** = `Σ_{light_offset ≠ -1} (LightMapSizeX + 1) * (LightMapSizeY + 1)`。它是按面表反推的**各面已分配区之和**。

两者**彼此独立**：faceTotal 量的是「面表声明要占多少」，cap 量的是「容器能装多少」，其差 = 容器里未被任何面引用的填充字节。**因此不存在「faceTotal == cap」这条判据**，任何把它写成相等式的表述都是错的（本节旧稿曾误写为「恰好相等」，已订正）。

1. **必须解压再计算**：`ident != 0` 的 lump，其目录里的 `length` 是**盘上（压缩）长度**（`ident == 0` 时即真长），不是容量。`cap` 一律取 §9.10.1 的**实际字节数**（`ident != 0` ⇒ 解压后长度；`ident == 0` ⇒ 盘上长度），`capSamples = cap ÷ 4`。
   基准实测：`surf_null` cap = **22,961,620**（capSamples = 5,740,405）；`surf_666` cap = **29,044,440**（capSamples = 7,261,110）；`ze_cursed` cap = **23,581,252**（capSamples = 5,895,313）。
2. **硬约束（字节上界）**：`max(light_offset + 4 * (LightMapSizeX+1) * (LightMapSizeY+1))`（仅 `light_offset ≠ -1` 的面）**必须 ≤ `cap`**（= lump 实际字节数；**字节比字节**）。
   基准实测（残差 = 容器字节数 − `maxByteEnd`）：`surf_null` = 22,961,620（**残差 0、恰好触底**，三张图中最紧）；`surf_666` = 29,044,440（**残差 0、恰好触底**）；`ze_cursed` = **23,581,108**（用正确的 `FacesHdr(58)`；容器 23,581,252，**残差 144 B、不触底**，按未解释观察保留）。`maxByteEnd` 的定义见 §9.6.3 表下。
   ⚠️ **`34,928` 不是覆盖量上界，而是「面侧最大字节长」**：它 = `max(4×(sx+1)×(sy+1))`（坏表 `FACES(7)` 下 `lightofs` 全 0 ⇒ `light_offset +` 项**被整个漏掉**，只剩面自身块长）⇒ **拿它当上界会让判据恒真**（`34,928 ≤ 23,581,252` 恒成立，与容器差约 **675 倍**），对「用错面表」零敏感。实现若报出 `maxByteEnd = 34,928`，一律判**未切面表**（见 §2.1 第 3 条、§9.10.2 第 1、7 项）。
3. **硬约束（每面区域不越界）**：每个有光照面的 `[light_offset, light_offset + 4×(sizeX+1)×(sizeY+1))` 必须落在 lump 内。
4. **faceTotal 与 cap 的关系只作自洽核对，不作通过判据**（⚠️ **单位纪律**：`faceTotal` / `Σluxels` 是 **luxel 数**（与 `capSamples` 同量纲）、`cap` 是**字节数**，两者**不得直接相除**；两个不等式必须写清量纲——**`Σluxel ≤ capSamples`**（样本比样本）与 **`bytesReferencedEnd ≤ cap`**（字节比字节，`bytesReferencedEnd` 即 `maxByteEnd`）；占比一律写成 `Σ(luxels) × 4 / cap`，即**字节比字节**）：
   基准实测（**字节比字节**）：`surf_null` 1,920,921 ×4 = 7,683,684 / 22,961,620 = **33.46%**；`surf_666` 4,935,532 ×4 = 19,742,128 / 29,044,440 = **67.97%**；`ze_cursed` 2,760,528 ×4 = 11,042,112 / 23,581,252 = **46.83%**（用正确的 `FacesHdr(58)`；旧稿的 `47.3%` 来自坏表 `FACES(7)` 的 `Σluxel = 2,791,391`，已订正）。
   三者全部远小于 100%，说明容器里普遍存在**未被面表区域覆盖的填充**（原因未定位，已登记为 §9.10.2 第 2 项）。⇒ **不得**用「`Σluxels ≤ capSamples`」来充当"等式成立"的证据（它太弱、几乎不可能不成立）；真正的承重判据是本条第 2、3 项的字节级上界、第 12 项的**面表身份三项**，以及 v20 图上 `maxByteEnd` **恰好触到 lump 末尾**这一强特征。
5. **有光照面数**：`#{light_offset ≠ -1}`。基准实测：`surf_null` = 26,509、`surf_666` = 33,716、`ze_cursed` = **18,643**（旧稿的 21,774 是坏表 `FACES(7)` 的值，已订正；本项已由第 12 项①升级为**承重判据**）。
6. **单面上界**：每个有光照面满足 `(LightMapSizeX+1) ≤ 256` 且 `(LightMapSizeY+1) ≤ 256`；越界必须**报错**而非静默越界（上游依据：外部参照实现的 `Lightmap.cs:64` 仅 65536 项读缓冲）。基准实测单面最大格数：`surf_null` 1,122、`surf_666` 4,400、`ze_cursed` 8,732，三张图均远低于 65,536。
7. **图集打包**：每面矩形 `Width = LightMapSizeX + 3`、`Height = LightMapSizeY + 3`（即 **luxel + 2**），落位后有效矩形内缩 **2** 像素（上游依据：外部参照实现的 `LightmapLayout.cs:47-49`、`:67`）⇒ 有效矩形恰好 = luxel 数。**两级换算不得合并写**（§2.1 第 6 条）。
8. **图集尺寸**：单页边长取 2 的幂、≤ 2048×2048；选择规则按面积向上取（上游依据：外部参照实现的 `LightmapLayout.cs:115-129`）。打包面积 = `Σ(sx+3)(sy+3)` = `Σ(luxelX+2)(luxelY+2)`（每面矩形取第 7 项的 `luxel + 2` 后的**面积**之和；**不是** `Σluxel + 2×live`——后者把边框当成「每面加 2」，系统性偏低约 29%）。基准实测：`surf_null` **2,781,987** px（占单页 2048² 的 66.3%，单页够）、`surf_666` **6,598,518** px（**157.3%，单页不够**）、`ze_cursed` **3,692,068** px（**88.0%，近满**，单页够但余量小）。
9. **像素编码**：`R=mantissa_r, G=mantissa_g, B=mantissa_b, A = exp + 128`，全部为 8 位无符号（上游依据：外部参照实现的 `Lightmap.cs:89-92`）。
10. **采样口径**：`exp = a * 255 - 128`；`rgb_linear = rgb * 2^exp`；**先对 4 个 texel 各自解码再双线性混合**；最后 `pow(decoded, 1/2.2)` 后乘 base。纹理必须 `Nearest` + `NoColorSpace`（指数在 A 通道，硬件插值会破坏编码）。
11. **无光照面**：同块属性集必须一致（`mergeGeometries(…, true)` 要求，证据 `test/game-core/src/renderer/renderer-main.ts:998`、`:1020`）⇒ 无光照面**写中性值**并置 `extras.hasLightmap = false`。
12. **承重判据 · 面表身份三项（必须同时断言；`maxByteEnd ≤ 容器字节数` 单独不够）**：`maxByteEnd ≤ cap` 对**误读面表**完全不敏感——坏表 `FACES(7)` 下 `lightofs` 全 0 ⇒ `maxByteEnd` 退化为**面侧最大字节长** `34,928`，而 `34,928 ≤ 23,581,252` **照样通过**，即**判据通过 ≠ 功能正确**。这个空隙由下面三项封堵（`ze_cursed…`（v21）是唯一可判别图，见 §9.10.2 第 6 项）：
    ① **live 面数**（`lightofs ≠ -1` 的面数）必须 == **18,643**（坏表 `FACES(7)` 给 **21,774**——该表 `lightofs` 全 0、无一项为 -1）；
    ② **`lightofs == -1` 的面数**必须 == **3,131**（坏表给 **0**）；
    ③ **`max(lightofs)` 必须落在容器末段**：实测 `surf_null` 22,960,828 / 22,961,620、`surf_666` 29,043,936 / 29,044,440、`ze_cursed` 23,580,964 / 23,581,252（均为「容器字节数 − 数百字节」量级）；坏表下**恒为 0**。
    三项与 §9.6.3 的独立地面真值表同源（`surf_666` 5,318 / `surf_null` 6,850 的 `-1` 面数可作旁证，但面表切换分支只在 v21 可判别）。**实现若只报「字节上界通过」而不报这三项，复核一律判不通过。**

#### 9.6.3 解压口径与「分母」约定（仓库既有约定，t3/t4 一律按此引用）

**机制（源码级）**：`src/wasm-core/vbsp/bspfile.rs:62-68` 的 `get_lump` 判定 `lump.ident != 0` ⇒ 走 `lzma_decompress_with_header(data, ident as usize)`，即**把 `ident` 当作期望解压长度**；`ident` 是 lump 目录每项的第 4 个 u32（结构见 `src/wasm-core/vbsp/data/mod.rs:81-86`，字段名 `ident`）。`ident == 0` ⇒ 该 lump 是裸字节，`dirLen` 即真长。

**实测（三张本地图，零反例）**：
- `surf_null.bsp`：非空 lump **43** 个（另有 21 个 `len == 0` 的空 lump），其中 `ident != 0`（LZMA）**41** 个、`ident == 0`（raw）**2** 个；41 个 LZMA lump 的 `ident` 与 lump 头 `"LZMA"` 后 `u32 actualSize` **逐个相等（41/41）**。例：lump8 `ident = 22,961,620`、lump55 `ident = 3,269,700`。
- `surf_666.bsp`：非空 **46** 个，**全部 raw**（`ident == 0` 46/46）。
- `ze_cursed_bear_tales_v1_2.bsp`（v21）：非空 **52** 个，**全部 raw**（52/52）。

> ⚠️ **分母纪律（本条的要点）**：**luxel 预算、缓冲分配、图集页数判定一律以 `ident`（解压后长度）为分母，禁用 `dirLen`。** 理由不是理论洁癖，而是实测反例：`surf_null` 的 lump55/56 `dirLen = 2,091,073`（**不能被 4 整除**）、lump15/54 `dirLen = 12,767`（同为 mod 4 = 3），拿 `dirLen` 当分母会算出非整数 texel 数并低估容量 3~4 倍（例：lump8 `dirLen` 6,062,916 vs `ident` 22,961,620）。`cap` 在 §9.6.2 第 1 项已定义为「实际字节数」（`capSamples = cap ÷ 4`），本条即其口径来源。

**便宜自检（三张图的光照 lump 字节数均被 4 整除）**：`surf_666` LDR 29,044,440、`surf_null` LDR=HDR 22,961,620、`ze_cursed` HDR 23,581,252 —— 三者 `% 4 == 0`，故 `capSamples` 是整数（7,261,110 / 5,740,405 / 5,895,313）。**若实现侧算出的 `capSamples` 不是整数，第一嫌疑就是误用了 `dirLen`。**

**独立地面真值（面表侧，逐字节探针实测；字段偏移：`lightofs` @ +20、`(sx,sy)` @ +36，面记录 56 字节）**

| 地图 | 用哪张面表 | live 面数（`lightofs != -1`） | `-1` 面数 | Σ(sx+1)(sy+1) | 单面最大 luxel | `maxByteEnd` |
|---|---|---|---|---|---|---|
| `surf_666.bsp` | `FACES(7)`（lump58 缺席） | **33,716** | 5,318 | **4,935,532** | 4,400 | **29,044,440**（= 容器末尾，**残差 0、恰好触底**；argmax 面 `k=38604`、`lightofs = 29,043,936`、`(sx,sy)=(20,5)` ⇒ `+4×21×6 = 504`） |
| `surf_null.bsp` | `FACES(7)`（与 lump58 同源同内容） | **26,509** | 6,850 | **1,920,921** | 1,122 | **22,961,620**（= 容器末尾，**残差 0、恰好触底**；`max(lightofs)` = 22,960,828，见 §9.10.1） |
| `ze_cursed…`（v21） | **`FacesHdr(58)`**（`FACES(7)` 是坏表，见 §2.1 第 3 条） | **18,643** | 3,131 | **2,760,528** | 8,732 | **23,581,108**（容器 23,581,252，**残差 144 B、不触底**，按未解释观察保留；argmax 面 `k=21773`、`lightofs = 23,580,964`、`(sx,sy)=(3,8)`） |

> **`cap` 只是上界，不是「应有量」**：`Σluxel×4 / 容器字节数` 实测仅为 **0.680 / 0.335 / 0.468**（surf_666 / surf_null / ze_cursed）⇒ **任何「Σluxel×4 == 容量」的断言都是错的，禁止写成等式判据**。
> **`styles[4]` 因素已排除**：live 面上「有效 style 数」实测恒为 **1**（多 style 不参与本仓语料），故差额**不能**归因于多光照样式；差额是容器内未被面表区域覆盖的填充（成因仍未定位，见 §9.10.2 第 2 项）。
> **`maxByteEnd` 的定义**：`max(light_offset + 4×(sx+1)×(sy+1))`，仅对有光照面取 max。它触到容器末尾是**强判据**（v20 两图恰好触底）。**对照**：坏表 `FACES(7)` 下该式退化为 `max(4×(sx+1)×(sy+1))` = **34,928**（**面侧最大字节长**：漏掉 `light_offset +` 项），此时上界判据**恒真**，故另需 §9.6.2 第 12 项的**面表身份三项**。

> **方法说明（诚实记录）**：队长的附带校验式「同一 `(sx,sy)` 分组内相邻 `lightofs` 的差 == `(sx+1)(sy+1)+1`」在**本轮实测未复现**——三张图全部 1,016 / 614 / 1,109 个分组**没有一组**满足该恒等式（观测到的差值恒为 **4 的倍数**，但不是 `(sx+1)(sy+1)+1`；例：`surf_666` 的 `(sx,sy)=(1,2)` 期望 step=7，实观测 28/68/80/96/…）。**结论：地面真值以上表为准（该表只依赖 `lightofs != -1` 与 `(sx,sy)` 两个字段，不依赖任何步长假设）；步长校验式不作为判据。** 若 t4 能给出该式的正确形式，再补进来。

**与 §9.8.3 的关系**：`surf_null` 的 LZMA 压缩实测为 6,062,916 B（盘上）→ 22,961,620 B（解压），压缩比约 1:3.8；`surf_666` 与 `ze_cursed` 全 raw，盘上长度即真长。⇒ 三张图的「口径不一致」在**读 catalog 目录时**就存在，必须在解压层统一，不能在预算层各写一套。


#### 9.6.4 断言脚本必须给出的判据（新增文件 `test/game-core/scripts/lightmap-gltf-assert.mjs`）

从 GLB 容器直接抽 JSON chunk（`magic='glTF'` / `version=2` / chunk0 类型 `0x4E4F534A`）后断言：

1. `asset.extras.lightmap.textureIndex` 存在、为整数、`0 ≤ t < textures.length`；
2. `materials[*].extensions.__vbsp_lightmap__.textureIndex === asset.extras.lightmap.textureIndex`（两处一致）；
3. 每个含 `TEXCOORD_1` 的 primitive：其 accessor 的 `count` 与 `POSITION` 的 `count` **相等**、`componentType=5126`(FLOAT)、`type="VEC2"`；
4. atlas 的 `images[t]` 存在；解出宽高后断言 `W`、`H` 均为 2 的幂且 `≤ 2048`；`W*H ≥ Σ(primitives 的有效 texel 数)`（若实现按月/页统计，则断言页数与总面积自洽）；
5. `primitives[*].extras.faceIndex` 为整数且在 `[0, faceCount)` 内且**互不重复**（同一面只出一个图元）；
6. `primitives[*].extras.hasLightmap` 存在且为布尔；`hasLightmap=false` 的图元其 `TEXCOORD_1` 必须存在且全为中性常量（保证属性集一致）；
7. 同一输入连续导出两次，GLB 字节 **SHA-256 相同**（确定性）。

脚本行为约定：地图路径**不得写死**；按 `process.env.WEBSURF_MAP` → 仓库根 `test/maps/*.bsp` 的顺序探测；无可用地图时打印明确跳过信息并 `exit 0`（不得伪装成通过，也不得直接失败）。注册为 `test/game-core/package.json` 的 `test:lightmap-gltf`。

### 9.7 非目标（本轮不做）

1. **阶段 4（实体光源 `with_lights` 接入）整体不做**：不改 `src/ts-shared/phys/world-builder.ts:202` 的生产调用、不做 `with_lights` + 默认纹理的合并变体、不接点光源池（`apps/debug/src/renderer/light-manager.ts:29` 的 8 灯上限）、不解决法线来源（`src/wasm-core/bsp_to_gltf_core/convert.rs:1042-1045` 无法线）。
2. 上游同样未实现的项一律不做：光照样式、`BUMPLIGHT`/`$bumpmap`、`env_cubemap`、`lighting origin`、`dispPages`/`brushModelPages`/`studioModelPages`/`vertLightingPages`/`visPages` 五个 page 面。
3. **置换面（displacement）的 lightmap 不实现**：只按非置换面口径生成 UV（`light_map_scale/transform` → 减 `light_map_offset` → 除 `LightMapSizeX/Y`（**不是 +1**）→ 映射进矩形 + 半像素）；置换面的 UV 与本轮无关。
4. 世界面的 ambient cube：`LEAF_AMBIENT_LIGHTING` 只服务道具/静态模型，本轮**只做解析不接线**（若实现阶段 1 顺手把 `src/wasm-core/vbsp/reader.rs:139-143` 丢弃的 24 字节落库，需保证 `src/wasm-core/vbsp/data/mod.rs:237` 的 `const_assert_eq!(size_of::<Leaf>(), 32)` 口径不被静默放宽）。
5. 不改仓库根 `src` 与 `apps` 下任何文件；不改 `src/scripts/lib/wasm-api-contract.mjs`；不把任何临时区（`temp/`、临时目录）当作事实来源或依赖。
6. 不为追求视觉效果偏离上游口径（不加 ambient 加项、不加曝光乘子、不做 base 转线性）。

### 9.8 验收判据（逐条可判）

#### 9.8.0 实施前基线快照（2026-09-18，HEAD=`a5cd4c2`）

> ⚠️ **读这一节前先看 §9.10.3**：本节基线**在 t2 施工期间测得**（同批还出现过 250 vs 247 的口径混用）。因此**绝对摘要值只作参考、不作判据**；权威项只有 `HEAD:src` / `HEAD:apps` 两个树哈希与 (b) 的状态条目，成员在开工/收工时各测一次即可。

| 项 | 实测值（2026-09-18） | 稳定性 |
|---|---|---|
| `git rev-parse HEAD` | `a5cd4c2589544fccc8981fa1e4d6ff2b9578fdbb` | 稳定 |
| **`git rev-parse HEAD:src`**（HEAD 里 `src/` 的树对象哈希） | **`e3c910a031c7e8c23f825631a79236b19e00e1e9`** | **权威判据，抗文件系统变动** |
| **`git rev-parse HEAD:apps`**（HEAD 里 `apps/` 的树对象哈希） | **`082d1a8255d685732e516a2023bd656e4b5a5daa`** | **权威判据** |
| `git write-tree --prefix=src`（index 侧） | 与 `HEAD:src` **相同** ⇒ index 中 `src/` 未被改动 | 权威判据 |
| `git ls-tree -r HEAD --name-only -- src apps` | **250** 个文件（`src` 87 + `apps` 163） | 稳定 |
| `git status --porcelain -- src/` | **0 条** | 稳定 |
| `git status --porcelain -- apps/` | **3 条**：`D  apps/debug/README.md`、`D  apps/game/README.md`、`D  apps/viewer/README.md`（上一批「工程 README 收拢」的暂存删除） | 稳定 |
| `git diff HEAD --name-status -- src/ apps/` | **3 条**（同上三条的 `D` 侧，逐字符一致） | 稳定 |
| `src/` 内容正确性（本会话实测） | HEAD 87 个文件 ↔ 盘上 87 个文件：**无缺失、无多余、内容全等（0 个 blob 不一致）** | 权威判据 |
| `apps/` 内容正确性（`git ls-files` 口径实测） | `HEAD` **163** 个（含那三条 README）；**索引 160** 个（三条已在上一批 `git mv` 时移出索引，只存在于 `HEAD`）；两侧共有文件**内容不一致 0 个** | 权威判据 |
| ~~`src/` 与 `apps/` 的**按目录分别摘要**~~ | **已作废**：这两个值（曾记作 `ee8d863f…` / `cc262141…`）在 port-engineer 侧 8 种构造下**均不可复现**，我也复现不出（§9.10.3 第 5 条）。**不再作为任何判据或基线**，仅保留此条说明避免后人再引用 | **已作废** |
| `apps/` 文件数（两种口径各一） | `git ls-files --cached -- apps` = **160**；工作区递归遍历 = 171（多出被忽略生成物，口径差异见 §9.10.3 第 2 条） | 参考值，**不要照抄** |
| **唯一权威摘要 (a)**（组合式配方，见 §9.8.1） | **247 个文件**（`git ls-files --cached -- src apps`：`src` 87 + `apps` 160）、joinedBytes=**24363**、清单 sha256=`63aba1ce406dc36bf0cda29576ae46fd4458e3c851e786bd8aafbb93661db623`。**队长裁定：唯一权威摘要，取代一切 per-tree/遍历式摘要**；成员间自比用它，**不作 ⓪/(b) 的替代** | **唯一权威**（自比口径） |
| 文档漂移体检（原版脚本） | 受限沙箱下无法运行：`check-doc-drift.mjs` 用 node `child_process` 调 git，报 `spawnSync git EPERM`（`src/scripts/check-doc-drift.mjs:31`）⇒ t6 用等价口径并**标注是哪种口径**（§9.12） | 环境边界 |

**冻结结论（依队长裁定：非污染 = ⓪ 合取 (b)，(a) 只作同口径自比、不作替代判据）**：

1. `git rev-parse HEAD:src` 与 `git write-tree --prefix=src` 都必须恒等于上面那个值——**只要这两者不变，`src/` 就不可能被污染**（无论盘上发生什么）；
2. `git rev-parse HEAD:apps` 必须不变——**任何对 `apps/` 的入库内容改动都会改它**；
3. `git status --short --untracked-files=all -- src apps` 必须**恰为**那 3 条 `D`（**0 个 `??`、0 个 ` M`**）；`git diff HEAD --name-status -- src/ apps/` 与 `git status --porcelain -- src/ apps/` 亦须同为那 3 条，不多不少。
   **⓪ 单独不够**：树哈希只覆盖**已提交内容**，对新增未跟踪文件（`??`）不敏感——而这正是本轮最该防的形态。故 ⓪ 与 (b) 必须**同时**成立。
4. **(a) 的验证方法（t4 必须照此，不得只报一个绝对摘要）**：① **实施前后各采一次、必须同口径**——用 §9.8.1 给出的唯一确定配方（`git ls-files --cached -- src apps` → 小写 hex + 两个半角空格 + 路径 → 保持 git 原始顺序 → LF 连接 → 无尾换行 → SHA-256）；② 两次摘要**相同**；③ 更硬的一层：两次的 **247 行清单逐行相等**（配方可输出清单，见 §9.8.1 的 Node 实现）；④ 若因故拿不到清单，退化为「对 247 条路径逐条跑 `git hash-object -- <path>` 并与 `git ls-files -s` 的 blob sha1 比对（mismatch 必须为 0）」——注意必须用 `git hash-object`，**不得**用工作树原始字节算 sha1（`core.autocrlf=true` 会造出 236 条假不匹配，见「附 9.8.1-a」陷阱 1）。**任何按目录分别摘要的历史值一律不用**（§9.8.0 已标注作废）。

> 三条 `D  apps/*/README.md` 是**本轮开始前就存在**的收拢批次残留（对应 [AGENTS.md](../../../AGENTS.md) §7.1 第 12 项），不是本轮污染。实施者与复核者**不得**为了让那条命令变空而 `git restore` / 重建这三个文件 / 提交这三条删除（完整封印规则见 §9.8.1 ④）。

#### 9.8.1 非污染不变量（**合取式：⓪ ∧ (b)**；(a) 为唯一权威摘要但只作同口径自比，(c) 为硬判据）

**判据定义（依队长裁定：非污染 = ⓪ 合取 (b)，而 (c) 是变化即失败的硬判据）**：

```
⓪ git 对象层：git rev-parse HEAD:src / HEAD:apps 原封不动（附 git write-tree --prefix=src 自证 index 侧）
  期望：HEAD:src  = e3c910a031c7e8c23f825631a79236b19e00e1e9
        HEAD:apps = 082d1a8255d685732e516a2023bd656e4b5a5daa
(b) 状态条目：git status --short --untracked-files=all -- src apps 输出「恰为」三行 D，即
    0 个 `??`、0 个 ` M`、0 个 `M `、0 个 `A `
(a) 【唯一权威摘要；与 ⓪/(b) 并用，但自身只作同口径自比】跟踪文件清单摘要 == 63aba1ce406dc36bf0cda29576ae46fd4458e3c851e786bd8aafbb93661db623
    配方见下；成员在实施前后各采一次并比对（**不作 ⓪/(b) 的替代**；任何 per-tree 摘要一律不用）
(c) 【硬判据】(a) 或 (b) 任一变化 ⇒ 立即判为**不变量失败**：**停止施工并回报 Captain**，
    禁止自行宣告「已知豁免」。本轮**不存在任何合法豁免项**。
    ⓪ 只用于**排查定位**（区分「对象层未变」与「确有改动」），
    不用于放行；排查结果不改变上述判定结论。
```

> **为什么 ⓪ 与 (b) 必须同时成立**（(a) 的漏洞由 port-reviewer 发现，队长的裁定在 §9.8.0「冻结结论」）：
> - **⓪ 单独不够**：树哈希只覆盖**已提交内容**，对**新增未跟踪文件（`??`）不敏感**——「悄悄往 `src/` 里加一个新文件」正好是它照常命中、判据却放行的漏网形态（这与 (a) 摘要的盲点是**同一个**）。
> - **(b) 单独不够**：(b) 只看路径与状态、不看内容——「原地改一个已跟踪文件」会让 ⓪ 变而 (b) 不变（⓪ 兜住了这一面）。
> - **(b) 必须带 `--untracked-files=all`**：不带时未跟踪目录会折叠成一行目录名，`??` 逐一核对受限。
> - **(a) 的定位**：队长已把组合式配方定为**唯一权威摘要**（§9.8.0），取代一切 per-tree/遍历式摘要；但它与 ⓪ 有同一盲点（只覆盖已跟踪文件），故**不能单独充当非污染判据**——须与 ⓪/(b) 并用，自身只承担「同口径前后自比」的角色。（早前的 per-tree 值不可复现，已作废。）
> - **⓪ 的额外价值**：对「盘上文件被删/被生成」免疫（§9.10.3 第 2 条那类口径噪声伤不到它）。
>
> **(c) 收紧（队长裁定）**：(a)/(b) 任一变化即判失败、停止施工并回报，**不得**自行宣告豁免。本轮**无任何合法豁免项**——`test/game-core/**` 的改动不进 `src apps` pathspec，收口任务的 `git add` 同样不进，故正常情形下 (a)/(b) 绝不应变化；变化了就是真问题。⓪ 只用于**排查定位**，不用于放行。


```bash
# ⓪ 【权威】git 对象层：HEAD 里 src/ 与 apps/ 的树哈希
git rev-parse HEAD:src           # 期望 e3c910a031c7e8c23f825631a79236b19e00e1e9
git rev-parse HEAD:apps          # 期望 082d1a8255d685732e516a2023bd656e4b5a5daa
git write-tree --prefix=src      # 期望与 HEAD:src 相同（证明 index 里的 src/ 也没被动过）
```

```bash
# (b) 状态合取项：必须「恰为」三行 D。这三条是上一批「工程 README 收拢」的已暂存删除侧，
#     **永久允许**，不是本轮污染
git status --short --untracked-files=all -- src apps
# 期望输出（逐字符，共 3 行、无其它行）：
# D  apps/debug/README.md
# D  apps/game/README.md
# D  apps/viewer/README.md
# 不合格判据：是否出现 ?? /  M / M  / A  —— 出现任一即判非污染不成立
```

```bash
# ③ 提交基准侧一致（与 (b) 互为佐证，两条都跑）
git diff HEAD --name-status -- src/ apps/
# 期望输出（逐字符，共 3 行；R 的删除侧残留）：
# D	apps/debug/README.md
# D	apps/game/README.md
# D	apps/viewer/README.md
```

**（a）的唯一确定配方**（port-reviewer 用 7 种其它配方逐一排除后锁定；此处已按其配方独立复现）：

```
① git ls-files --cached -- src apps      → 恰好 247 个文件（src 87 + apps 160，含已暂存删除的三条 README）
② 逐文件 SHA-256，取小写 hex
③ 每行格式：<hash> + 两个半角空格 + <path>
④ 顺序：**git 的原始输出顺序，不得再排序**
⑤ 用 LF（\n）连接
⑥ **不加行尾换行**
⑦ 对整串取 SHA-256
```

**实现一（推荐；`git` 由 shell 跑、Node 只读 stdin 算哈希——不触发受限沙箱的 `child_process` EPERM）**：

```bash
git ls-files --cached -- src apps | node .tmp/digest-recipe.mjs
# 临时脚本内容（用完即删，不得入库）：
#   import { createHash } from 'node:crypto';
#   import { readFileSync } from 'node:fs';
#   const files = readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean);
#   const lines = files.map((p) => `${createHash('sha256').update(readFileSync(p)).digest('hex')}  ${p}`);
#   console.log(createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex'));
# 基线期望（2026-09-18 实测；Node 与 PowerShell 两种独立实现给出同一值）：
#   files=247  joinedBytes=24363
#   digest=63aba1ce406dc36bf0cda29576ae46fd4458e3c851e786bd8aafbb93661db623
```

**实现二（纯 PowerShell，已实测同一摘要）**：

```powershell
$listed = git ls-files --cached -- src apps        # 247 条；**不要** Sort-Object
$lines  = $listed | ForEach-Object { (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLower() + '  ' + $_ }
$joined = [string]::Join("`n", $lines)             # LF 连接，末尾不加换行
$enc    = New-Object System.Text.UTF8Encoding($false)
([System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($enc.GetBytes($joined))).Replace('-','').ToLower())
```

| 硬性注意（三条均为本轮实测，不是推测） | 后果 |
|---|---|
| **不得 `Sort-Object`** | `Sort-Object` 是**文化序**：实测它把 `apps/debug/Cargo.lock` 排到 `apps/debug/build-dist.cmd` 之后（第 1、2 位即换序）。加上它后同一输入算出的摘要变成 `d74f695d96cbf8bf1437177ef7f06526b541947cff19bc0c8593eecdd43cf863`（≠ 基线）⇒ **假失败** |
| **不要用 `Compare-Object` 验证顺序** | `Compare-Object` **默认忽略顺序**：排序前后它仍报「差异 0 条」（实测），会让人误判「排序无影响」。要验顺序必须逐下标比较或直接比摘要 |
| **不要用 `>` 重定向落盘再喂给 Node** | Windows PowerShell 的 `>` 默认写 **UTF-16LE + BOM**，Node 读出来得到 `'\ufffda\x00p\x00p\x00s\u2026'` 这类坏路径（实测 `ERR_INVALID_ARG_VALUE`）。必须走管道，或显式写无 BOM UTF-8 |

> **④ 封印规则（硬性，写进验收）**：`D  apps/{debug,game,viewer}/README.md` 三条是**本轮开工前就已存在**的收拢批次残留（上一批「工程 README 收拢」的 `git mv` 结果，对应 [AGENTS.md](../../../AGENTS.md) §7.1 第 12 项），**与本轮无关**。**任何人不得为了让 `git status --short -- src/ apps/` 输出变空而去碰 `apps/`**：不得 `git restore`、不得 `git restore --staged`、不得提交这三条删除、不得重建这三个文件。
>
> **精确的效应范围（不要夸大，也不要低估）**：
> - 这三条**在上一批 `git mv` 时已从索引移除，从未进入 (a) 的文件集**（一手证据：`git ls-files --cached -- apps` = **160** 条，其中匹配 `README` 的只有 `apps/viewer/scripts/dist-README.md`；它们只存在于 `HEAD`——`git ls-tree -r HEAD -- apps` = **163** 条含这三条）。⇒ **其盘上存废对 ⓪/(a)/(b)/③ 均无影响**，本契约的判据**不含任何随工作区文件存废波动的项**；
> - 反面：若用「工作区遍历」而不是 `--cached` 造清单（本契约已禁用该口径），文件数会随工作区状态在 160/163 附近摆动——这正是我早前一版误记基线的原因，**不要**再退回那种口径（详见 §9.10.3 的自我更正）；
> - `test/game-core/**` 的新增（例如 t2 复制的 `crates/wasm-core/`）**完全不进** ⓪ (a) (b) ③ 任何一条（不在 `src apps` 范围内），这是刻意的。
>
> 判据效力排序（依队长裁定）：**非污染 = ⓪ 合取 (b)，二者缺一不可**——`HEAD:src` / `HEAD:apps` 树哈希不变 **且** `git status --short --untracked-files=all -- src apps` 恰为那三行 `D`（0 个 `??`、0 个 ` M`）。⓪ 单独不够（只看**已提交内容**，对新增未跟踪文件 `??` 不敏感）、(b) 单独不够（只看状态不看内容）。(a) 摘要**降为可选**的成员间自比，不作判据。只报「输出为空」不合格（既不成立，也会放过 R 类改名残留）。

**附 9.8.1-a 复核附录：三条「仪器类假失败」陷阱 + 基线自证**

> 这一节专给 t4（port-verifier）与 t5（port-reviewer）。以下都是**测量仪器本身**造成的假失败——现象看起来像污染，实际是口径错。**遇到下列现象一律先怀疑仪器，不要先判实现有问题。** 每条都附本轮实测证据。

**陷阱 1：不要用「工作树原始字节」算 git blob sha1 去比索引（`core.autocrlf=true`）**

- 机制：`core.autocrlf=true` 下 git 在成 blob 前先把 **CRLF 清洗成 LF**；直接对工作树原始字节算 sha1 再与 `git ls-files -s` 比，必然大面积假不匹配。
- 本轮实测：`blob_sha1(工作树原始字节, 含 blob 头) == index` → **匹配 11 / 不匹配 236**（共 247 = `git ls-files --cached -- src apps` 的条数）；工作树中含 CR 的文件恰好 **239** 个。236 = 239 − 3（那 3 个已暂存删除的 README 在工作区已不存在、blob 由 index 提供，故不参与该差值）。
- 正解二选一：
  - **(i)** 用 `git hash-object -- <paths>`（它走与 git 一致的清洗路径）。本轮实测：`git hash-object` vs `index blob sha1` → **不匹配 0**；
  - **(ii)** 用「**工作树原始字节 SHA256 清单**」法（§9.8.1 (a) 的口径）。它**故意更严**：连行尾翻转都算改动，因此**完全不受本陷阱影响**——这正是本批采用它作基线的理由。
- 同族小坑：`sha1(裸内容)`（连 `blob <size>\0` 头都不加）与 index 比对 → 匹配 **0**。三者务必区分。
- 另有一例纯仪器噪声：用 PowerShell 组 index 映射时若忘了剥掉 `git ls-files -s` 行尾的 CR（`TrimEnd` 一个回车符），键会全部失配，得到「不匹配 247/247」的假结果。**读原生命令输出后一律先剥 CR。**

**陷阱 2：`git ls-files | Set-Content -NoNewline` 会把所有行首尾相连**

- 机制：`-NoNewline` 抑制的是**全部换行**，不是仅尾换行；数组会被无分隔地首尾相接成单行 ⇒ 清单退化成一行、摘要必然错。
- 本轮实测（输入 `@('aaa','bbb','ccc')`）：`Set-Content -NoNewline` 落盘内容 = `aaabbbccc`（长度 9），而先 `-join` 一个换行符再落盘 = 三行（长度 11）。落到 247 行清单上，摘要变成 `b24d2c7b40fb737066b1be4d6b561a3cdaec3275d813255f64988b19e74d79fb`（≠ 基线）。
- 正解：**先 `-join` 换行符再落盘**，或直接用 .NET `WriteAllText` 配无 BOM UTF-8 编码；落盘后用行数自检（期望 247）。

**陷阱 3：`Compare-Object` 不能用来验证顺序**

- `Compare-Object` 默认**忽略顺序**，排序前后都报「差异 0 条」（实测），会让人误判「排序无影响」。要验顺序必须逐下标比较或直接比摘要。
- 连带注意：Windows PowerShell 的 `>` 重定向默认写 **UTF-16LE + BOM**，Node 读出来得到坏路径（实测 `ERR_INVALID_ARG_VALUE`）⇒ 必须走管道，或显式写无 BOM UTF-8。

**陷阱 4：路径参数里的 `?` / `[]` / `*` 会被 git 当作 pathspec 通配符**

- **实测**：`git ls-files --cached -- 'apps/debug/*.toml'` 返回 **2** 条，而字面 `apps/debug/Cargo.toml` 只有 **1** 条 ⇒ `*` 确实是 glob。
- **风险点**：那三条 README 的字面名就是 `apps/debug/README.md`——**`.md` 本身不含 glob 元字符，但名字里若出现 `?` / `[` `]` / `*` 就会被当作通配符**；本次未触发（实测字面写法与其通配写法都返回 0 条，因为它们不在索引里，两者无法区分）。
- **操作要求**：不要把文件名直接当 pathspec 参数传给 git（尤其是脚本里拼接路径时）；用 `git ls-files --cached` 的**全量列表**做基准，必要时用 `--` 隔离且逐条比对。正常情形下它不影响本契约的 247 条（已实测复算为 247、joinedBytes=24363）。

**基线自证：三条独立仪器 + 配方唯一性证据**

- 三仪器钉死基线态（本轮实测）：`git diff -- src apps` **为空**；`git hash-object -- <247 条路径>` 与 `git ls-files -s` 的 blob sha1 **逐条相等（mismatch 0）**；`git diff --cached -- src apps` **恰为那 3 条 `D`**（`apps/{debug,game,viewer}/README.md`）。
- 配方唯一性（本轮以 10 个变体实测，**只有唯一配方命中基线**）：
  - Exact（小写 hex + 两个半角空格 + 路径 / LF 连接 / 无尾换行）→ **`63aba1ce…db623` 命中**（joinedBytes=24363）；
  - 尾加 LF → `2f6f097e…`；CRLF 连接 → `205fb520…`；单空格分隔 → `f5329374…`；hash 大写 → `ef2aa073…`；
  - **排序后连接** → `134cc4ec…`；**反序连接** → `30e28b32…`；无分隔 → `cffb0fb3…`；tab 分隔 → `9340e61c…`；全部首尾相连（= 陷阱 2 的产物）→ `b24d2c7b…`；
  - 十个变体全部不匹配 ⇒ 配方唯一，且与 `joinedBytes=24363` 一并可作为「仪器是否装对」的自检。
- 该摘要已经 **pwsh 生成 + Node 独立重算逐字节一致**（本轮两种实现各自算出的 joined 字节数均为 24363、摘要均为基线值）。

#### 9.8.2 构建与契约门禁（t2/t3 的 verify）

在 `test/game-core/` 下依次执行，全部期望 `exit 0`：`npm run build:wasm` → `npm run build:ts` → `npm run check:api` → 新增 `npm run test:lightmap-gltf`；最后在仓库根执行 §9.8.1 的合取式 **⓪ ∧ (b)**（(a) 摘要为可选项，不作判据）。

#### 9.8.3 有可用本地地图时的端到端证据（`test/maps/` 不入库）

**已实测的本地地图事实**（只读探针，2026-09-18；方法与逐字段偏移见 §9.10.1）。**下表长度一律是「lump 实际长度」**：`ident != 0` 时为 LZMA **解压后**字节数，`ident == 0` 时等于**盘上长度**。三张图中**仅 `surf_null` 为 LZMA 压缩**（非空 43 个 lump 中 41 个 `ident != 0`、数据头为 `LZMA`；盘上 6,062,916 B → 解压 22,961,620 B，见 §2.5 顶部提示）；**`surf_666`（非空 46 个）与 `ze_cursed`（非空 52 个）的全部非空 lump 的 `ident` 均为 0**（纯裸字节）⇒ 这两图「解压后长度 ≡ 盘上长度」，**解压分支根本不会被触发**。**要验证解压路径，`surf_null` 是唯一语料**：

| # | 地图（`test/maps/`） | BSP 版本 | 面表（用哪张，56 B/面） | 选中 lump & **cap**（= lump 实际字节数）／**capSamples**（= `cap ÷ 4`，luxel 容量） | **面表侧 Σluxel** = Σ 面 `(sizeX+1)*(sizeY+1)`（占比 = `Σluxel×4 / 解压后字节数`，**字节比字节**） | 对应**可测路径**与判据 |
|---|---|---|---|---|---|---|
| 1 | `surf_666.bsp` | 20 | **`FACES(7)`**（39034 面；`lump58` 缺席 len=0） | **LDR**：`LIGHTING`(8) 29,044,440 B ⇒ **cap = 29,044,440**、**capSamples = 7,261,110**；`LIGHTING_HDR`(53) 长度 0（不可选） | **4,935,532**（占 **67.97%** = 19,742,128 / 29,044,440，**字节比字节**；`-1`=5,318 / live=33,716） | **LDR-only 路径**：判 HDR 空 ⇒ 必须走 LDR。判据：`maxByteEnd` == **29,044,440** == 容器末尾（**残差 0、恰好触底**）；单面最大 4,400 ≤ 65,536。**另须断言「单页 2048² 装不下」（打包面积 **6,598,518** px = 单页 2048² 的 **157.3%**）时必须报错或多页，不得静默截断** |
| 2 | `surf_null.bsp` | 20 | **`FACES(7)`**（33359 面；与 `FacesHdr(58)` **同 offset/len/内容**） | **HDR**：`LIGHTING_HDR`(53) 22,961,620 B ⇒ **cap = 22,961,620**、**capSamples = 5,740,405**；`LIGHTING`(8) 同 offset 3,677,892 / 同字节数 | **1,920,921**（占 **33.46%** = 7,683,684 / 22,961,620，**字节比字节**，三图中最紧；`-1`=6,850 / live=26,509） | **HDR 优先路径 + 首选端到端样本**：两 lump 同偏移等长，按「HDR 非空」规则**必须选 HDR**。判据：`maxByteEnd` == **22,961,620** == 容器末尾（**残差 0、恰好触底**）；单面最大 1,122 ≤ 65,536；打包面积 **2,781,987** px（单页 2048² 的 66.3%）⇒ **单页 2048² 足够**。**首选理由（三条同时成立）**：① 三图中字节占比最紧（33.46%）、字节覆盖恰好触到容器末尾；② 单页装得下（唯一一张既触边又单页够的图）；③ 数据是 LZMA 压缩的（6,062,916 B 盘上 → 22,961,620 B），顺带压测了解压路径。注意：选 HDR 与否在本图**结果字节相同**（同源同偏移），故本图**不能**单独证明「HDR 优先」规则——见下条 |
| 3 | `ze_cursed_bear_tales_v1_2.bsp` | **21** | **`FacesHdr(58)`**（live=**18,643**；❌ 换成坏表 `FACES(7)` 会读到 21,774 面且 `lightofs` 全 0、**静默出垃圾**，见 §2.1 第 3 条、§9.10.2 第 1 项） | **HDR**：`LIGHTING_HDR`(53) 23,581,252 B ⇒ **cap = 23,581,252**、**capSamples = 5,895,313**；`LIGHTING`(8) 长度 0（不可选） | **2,760,528**（占 **46.83%** = 11,042,112 / 23,581,252，**字节比字节**；`-1`=3,131 / live=**18,643**） | **HDR-only + v21 压力用例 + 面表切换吞吐测试**：必须走 HDR。判据：`LDR 为空 + HDR 非空`时**不得**因 LDR 空而报错或回退；`maxByteEnd` = **23,581,108**（容器 23,581,252，**残差 144 B、不触底**，按未解释观察保留）＋ **面表身份三项必须同时断言**（§9.6.2 第 12 项）；单面最大 8,732 ≤ 65,536；打包面积 **3,692,068** px（单页 2048² 的 **88.0%，近满**）⇒ 单页仍够，但**余量小**。**若实现报出 Σluxel = 2,791,391 或 maxByteEnd = 34,928，即为未切面表的确证** |


**三张图共同覆盖的择一规则**：图 1 是「HDR 空 → LDR」，图 3 是「LDR 空 → HDR」，图 2 是「两者都非空 → HDR 优先」。**要真正区分「HDR 优先」与「LDR 优先」，必须比对图 2 的选取结果与图 1/图 3 的强制分支**（图 2 自身两 lump 字节相同，无法自证）。

**实现必须自报「选了哪个 lump」**（因为 §9.10.2 第 5 项：现有语料无法从输出反推选择）：每次导出至少给出 `{lumpIndex, 解压后字节数, hdrNonEmpty}`；对 `surf_null` 期望 `lumpIndex=53`、22,961,620 B；对 `surf_666` 期望 `lumpIndex=8`、29,044,440 B；对 `ze_cursed` 期望 `lumpIndex=53`、23,581,252 B。这三个期望值可**逐图**验证选择规则的三条分支，弥补「择一规则整体不可判别」的缺口。
**三张图共同具备但本轮不消费的 lump**（可用于后续阶段，勿误判为漏读）：`LEAF_AMBIENT_LIGHTING`(56)、`LEAF_AMBIENT_INDEX`(52)、`WORLD_LIGHTS`(15) 与 `WORLD_LIGHTS_HDR`(54)。

**本地地图不入库** ⇒ 脚本不得写死路径：
- 首选读 `process.env.WEBSURF_MAP`；未设时按 `test/maps/*.bsp` 遍历并做§9.8.3 顶部的运行期探测；
- 无可用地图时打印明确跳过信息并 `exit 0`（不得伪装成通过，也不得直接失败）；
- 断言的最小要求：**表 2（`surf_null`）优先跑通**；表 1/表 3 缺席只记录，不判失败。

**运行期探测方法**（脚本不得写死路径）：读文件头 `[0..4)=="VBSP"`、`u32 version`，再取 64 项 lump 目录（每项 16 字节：offset/length/version/ident，ident≠0 表示 Source `LZMA` 头封装），判 `LIGHTING(8).length > 0 || LIGHTING_HDR(53).length > 0`。**不要**用「文件里有 lightmap」以外的启发式判据。

### 9.9 需同步更新的受控位置（例外登记清单）

| # | 位置 | 要落的表述 | 责任任务 |
|---|---|---|---|
| 1 | `test/game-core/package.json:4` | 如实描述：`websurf-wasm-core` 已副本化到 `crates/wasm-core`，其余共享层（`ts-shared`/`phys`/`scripts/lib`/`vmdl`）仍以 `../../src` 引用 | t2 |
| 2 | `test/game-core/crates/wasm/src/lib.rs:19`、`:22` | 同步上表同义表述（注释级） | t2 |
| 3 | `test/game-core/crates/wasm-core/Cargo.toml` 头部 | 副本来源、日期、版本后缀 `-fork` 的理由 | t2 |
| 4 | `AGENTS.md` §2 | 登记「经用户授权的共享实现复制例外」，并写明仅限 `test/game-core/crates/wasm-core` | t6 |
| 5 | `AGENTS.md` §7.2.4 | 按本轮事实更新：副本与共享层的关系已从「共享层零重复」变为「`wasm-core` 隔离演进」；根 `src/` 零改动 | t6 |
| 6 | `CHANGELOG.md` | 纯追加条目：改动面、隔离例外、验证与评审结论、门禁口径 | t6 |
| 7 | `documents/index.md`、`README.md` §5、`AGENTS.md` §1.1 | **仅当**新增文档导致计数变化时同步（本章不新增文档） | t6 |

### 9.10 实测发现的偏差、未知项与预登记

#### 9.10.1 探针方法（可复现）

```
① 读 64 项 lump 目录：offset=u32@8+16i，length=u32@12+16i，version=u32@16+16i，ident=u32@20+16i
② ident != 0 ⇒ 该 lump 是 Source LZMA 封装：4 字节 "LZMA" + u32 实际大小 + u32 压缩流长度，
   随后是裸 LZMA1 流（需按 FORMAT_ALONE 重组 13 字节头或直接用 lzma_rs 等价实现解压）
③ 面记录 56 字节；本轮探针在 v20 上实测可用：lightmap 尺寸两个 i32 在 +0x24/+0x28
   （实测取值范围 0..99 / 0..125），styles 在 +0x2c（-1 或 0），lightofs 在 +0x14
   （-1 或 4 字节对齐且落在 lump 内；`surf_null` 实测 max = 22,960,828 = lump 字节数 − 4×1 即最后 1 格）
```

⚠️ **该字段偏移是探针口径，不是实现的权威口径**。实现必须读**结构体字段**（`Face.light_offset` / `Face.light_map_texture_size`，定义在根 `src/wasm-core/vbsp/data/mod.rs:375-378`，`const_assert_eq!(size_of::<Face>(), 56)` 在 `:391`）。**但本探针暴露了一个必须被解释的差异**：按结构体声明顺序推算的偏移与 v20 实测可用偏移不一致，且 v21 地图在 +0x14 全为 0。因此：

- 若实现者的解析结果与 §9.10.1 实测不一致，**先怀疑字段偏移而不是怀疑地图**；
- t4 复算时必须**独立于实现**地走一遍本探针，并把两套口径的差异写进复核报告。

#### 9.10.2 未知项与未覆盖面（不得含糊通过）

1. **v21（`ze_cursed_bear_tales_v1_2.bsp`）的 `lightofs` 必须从 `FacesHdr(58)` 读**（不是 `FACES(7)`）：`FACES(7)` 在该图上 `lightofs` **全 0 且无 -1**（21,774/21,774），是坏表；`FacesHdr(58)` 才是 live 表（`-1`=3,131 / live=18,643 / Σluxel=2,760,528）。**这条不是缺口，是已定位的坑**（§2.1 第 3 条）。⇒ t4 复算 v21 时一律用 `FacesHdr(58)`；若实现报出 `FACES(7)` 的 `Σluxel = 2,791,391`，即为**未切面表**的确证。
2. **`Σluxel×4` 与容器的差额成因未定位**：实测占比 **0.680 / 0.335 / 0.468** = `Σluxel×4 / 解压后字节数`（**字节比字节**；即 **67.97% / 33.46% / 46.83%**，surf_666 / surf_null / ze_cursed），差额为容器内未被面表区域覆盖的填充。**已排除 `styles[4]` 因素**（live 面有效 style 数实测恒为 1）。⇒ **处置：`cap` 只作上界，禁止断言 `Σluxel×4 == 容量`**（§9.6.2 已写明）；承重判据是字节级上界与「`maxByteEnd` 恰好触到容器末尾」这一强特征。若实现者要收紧，必须先给出成因而非改判据。
3. **单页 2048² 对 `surf_666.bsp` 装不下**（打包面积 **6,598,518** px = 单页 2048² 的 **157.3%**）：实现必须**要么**显式报错并给出所需页数，**要么**实现多页；**不得静默截断或降采样**（§2.1 第 7 条的上游行为是重试 2 次后抛 `"Unable to pack lightmap!"`）。本轮验收以 `surf_null.bsp`（单页装得下）为准，`surf_666` 只要求「失败可见」。
4. **未覆盖面 ①：单面 > 256×256 的越界路径本地语料触发不了**。实测单面最大 luxel 仅 **4,400 / 1,122 / 8,732**（surf_666 / surf_null / ze_cursed），离 65,536（= 256×256）很远 ⇒ **无法用本地图验证越界分支**。⇒ **替代要求（必须落进实现）**：对该情形**显式报错、绝不静默越界**，且**判定可观测**（错误信息须含面序号、`(sx,sy)`、`(sx+1)(sy+1)` 与 65,536 上限）。上游依据：外部参照实现的 `Lightmap.cs:64` 读缓冲仅 65,536 项。
5. **未覆盖面 ②：LDR/HDR 择一规则不可判别**（此前已登记）。`surf_666` 仅 LDR、`ze_cursed` 仅 HDR、`surf_null` 两条 lump **同 offset（3,677,892）同长度（22,961,620）同源** ⇒ 选谁输出字节都一样，故「HDR 非空则优先」用现有语料**既不能证实也不能证伪**。**替代断言**：实现每次导出必须给出 `asset.extras.lightmap.source = { lumpIndex, byteLength, hdrNonEmpty }`（§9.6.1），t4 以此断言选择分支，不靠像素比对。若将来拿到「两 lump 都非空但不同源」的图，本条即可关闭。
6. **未覆盖面 ③：`FacesHdr` 的切换分支只在 ze_cursed 可测**（`surf_null` 两表同源、`surf_666` 的 `lump58` 缺席）⇒ 面表切换的回归必须挂在 ze_cursed 上，见 §2.1 第 3 条的硬要求。
7. 浏览器侧行为（`KHR_lights_punctual` 实例化、无法线出图）沿用 §5.3 的登记，本轮不实测。

> **t4 复算结论（已闭合，2026-09-18）**：§9.8.3 表 3 里 `ze_cursed` 的 `maxByteEnd` 原**标注待核**，现按 t4 的独立复算定稿——该数字完全受「用哪张面表」支配：
> - 坏表 `FACES(7)`（`lightofs` 全 0）得 **34,928** = `max(4×(sx+1)×(sy+1))`，即**面侧最大字节长**（只含面自身块长、**漏掉 `light_offset +` 项**）⇒ 当上界用时判据**恒真**（`34,928 ≤ 23,581,252`，与容器差约 675 倍），是**误用坏表的症状**；
> - 正确的 `FacesHdr(58)` 得 **23,581,108**：argmax 面 `k=21773`、`lightofs = 23,580,964`、`(sx,sy)=(3,8)` ⇒ `+4×4×9 = 144`；容器 23,581,252，**残差 144 B、不触底**，按未解释观察保留；
> - `surf_666` **29,044,440**（argmax 面 `k=38604`、`lightofs = 29,043,936`、`(sx,sy)=(20,5)` ⇒ `+4×21×6 = 504` = 容器末尾）与 `surf_null` **22,961,620** 均为**残差 0、恰好触底**。
> ⇒ 单位口径见 §9.6.2 第 4 项；封堵「字节上界恒真」的**面表身份三项**见 §9.6.2 第 12 项。


#### 9.10.3 基线「为什么会动」的方法说明（含一处自我更正）

> **本节是方法说明，不是事故记录。** 早前一版草稿曾把下面第 2 条写成「工作区被并发改动 / 三条 README 被物理删除」的告警——**该告警已撤回**：它把两个**不同口径**的计数并列相减后当成了时序证据。这正是需要防的错误类型，留在此处作为反例。

| # | 可核验事实 | 结论 |
|---|---|---|
| 1 | `HEAD:apps` = **163**（树 `082d1a82…`）里含 `apps/{debug,game,viewer}/README.md`；**索引里没有这三条**（`git ls-files --cached -- apps` = 160，其中唯一的 README 是 `apps/viewer/scripts/dist-README.md`），故 `git status` 显示为已暂存删除 `D`；`HEAD:src` = 87 与索引一致 | 三条的「索引里没有、盘上也没有」是上一批文档收拢 `git mv` 的**正常结果**（`git mv` 从索引移除并删除源文件）。**不是本轮污染，也不需要任何处置**——唯一要求是别去碰它（§9.8.1 ④ 封印规则） |
| 2 | 早期记录的 `apps files=171` 与后来的 `apps files=160`。**关键事实（经队长确认后已自我更正）**：两次用的是**同一条命令** `git ls-files -co --exclude-standard`，因此「过滤口径差异（是否含被忽略产物）」这一解释**不成立**（那是队长早前未经证据的因果断言，已由队长本人撤回）。另：247 vs 250 的口径混用确实存在过，但那是**另一对**数字，两者不可混为一谈 | **该差异未获解释**，但**不影响任何判据**：这三条 README 的索引条目早已被上一批 `git mv` 移除，其盘上存废**不进 ⓪/(a)/(b)/③ 任何一条**；而各自时点测得的部分摘要与树哈希均自洽 ⇒ **即便确有变化，也只发生在「索引里已不存在」的文件上，不构成污染**。**按队长裁定就此结案**，不再让 t4 追（t4 到不了那个时点）。纪律保留：同一口径 + 两个时点 |
| 2’ | `247` vs `250` 这两个总文件数的口径差异（同样容易混） | `250` = `git ls-tree -r HEAD -- src apps`（**继承 `HEAD`**，含 `HEAD` 有而索引/工作区没有的那 3 条）= 87 + **163**；`247` = `git ls-files --cached -- src apps`（**当前索引**）= 87 + **160**。两者**不是时序证据，是基准口径不同**（`HEAD` 侧 vs 索引侧）⇒ **结论：引用总数时必须写明口径**，写「247」就配 `--cached`、写「250」就配 `ls-tree HEAD` |
| 3 | `test/game-core/crates/wasm-core/` 出现 25 个未追踪文件；全仓 `git status --short --untracked-files=all` 一度由 71 条增至 96 条 | 增量**全部**是 t2 按其契约创建的副本 crate（`?? test/game-core/crates/wasm-core/**`）。落点在 `test/game-core/**`，**不进** ⓪ / (a) / (b) / ③ 任何一条判据 |
| 4 | `src/` 全程零变化：HEAD 87 个文件 ↔ 盘上 87 个文件逐文件 blob 比对**不一致 0 个**；`git rev-parse HEAD:src` == `git write-tree --prefix=src` == `e3c910a031c7e8c23f825631a79236b19e00e1e9` | `src/` 隔离成立 |
| 5 | 早期记录的「按目录分别摘要」值（`ee8d863f…` / `cc262141…`）**已作废**。**成因线索（队长提供，可信）**：全仓摘要的 `<path>` 字段用的是 **`git ls-files` 原样输出的相对路径**（如 `apps/debug/Cargo.toml`）——不是绝对路径、也不是反斜杠形式；我当时未按该口径构造，故不可比。另：仓库**无 `.gitattributes`**，故不存在让逐文件内容摘要整体漂移的 eol 规约 | **已作废并定案**：唯一权威摘要是组合式 `63aba1ce…db623`（247 文件 / joinedBytes=24363，§9.8.0），**任何 per-tree 或改用绝对/反斜杠路径的历史值一律不用**；自比口径见 §9.8.1 |

> **操作纪律（据此定稿）**：
> 1. **任何「非污染失败」的结论都必须先用 ⓪ 的树哈希 + (b) 的状态条目自证**；单凭「某次摘要与另一次不同」不构成失败理由。
> 2. **不得用两种不同口径的计数相减来断言时序变化**（第 2 条的反例）。
> 3. **三条 `D`（`apps/{debug,game,viewer}/README.md`）不做任何处置**：不 restore、不重建、不提交（§9.8.1 ④）。
> 4. 「同一口径 + 两个时点」的纪律保留；但 **171 vs 160 不再追溯**（已按队长裁定结案）。

### 9.11 契约自检（本章对 t1 acceptance 的逐条对照）
| acceptance | 落点 |
|---|---|
| ① 文件 → 副本落点 → 新相对路径 + 层数核算 | §9.2、§9.3、§9.4 |
| ② 非污染不变量（合取式：**树哈希 ⓪ ∧ 状态条目 (b)**，二者缺一不可） | §9.1、§9.8.0、§9.8.1（含「附 9.8.1-a」仪器陷阱）。**口径已校正**：基线本就非空——那 3 条 `D` 是上一批文档迁移的已暂存重命名，永久存在。判据 = `HEAD:src`/`HEAD:apps` 树哈希不变 **且** `git status --short --untracked-files=all -- src apps` 恰为那三行 `D`（0 个 `??`、0 个 ` M`）；摘要 (a) 仅为可选自比，不作判据。**禁止**写成「`git status --short -- src/ apps/` 输出为空」这种字面表述（既不成立，也会放过 R 类改名残留） |
| ③ 导出契约可断言形式（TEXCOORD_1 / atlas / extras / luxel 等式） | §9.6.1–§9.6.4 |
| ④ TS 与脚本侧共享依赖逐条结论（禁改 `src/scripts/lib/wasm-api-contract.mjs`） | §9.5 |
| ⑤ 例外显式声明 + 受控位置清单 | §9.1、§9.9 |
| ⑥ 指定本地地图与运行期探测方法 | §9.8.3 |
| ⑦ 非目标（阶段 4 不做） | §9.7 |
| ⑧ 文档合规（CRLF / 无 BOM / 锚点 A、B 归零 / 层级不跳级） | §9.12 |

### 9.12 本章的完成定义（DoD）

- 行尾 CRLF、UTF-8 无 BOM、无行尾空白；标题层级不跳级（`##` → `###`）。
- 本章引用的全部 `文件:行号` 锚点均可在仓库内定位（`node src/scripts/check-doc-drift.mjs` 的 B 项越界计数为 0）。
不修改任何代码或配置；本章施工前后 §9.8.1 的合取式 **⓪ ∧ (b)** 全部成立（(a) 摘要可选项，不作判据）。

---

## 10. 回并完成记录（2026-09-20）

> 本章记录 §6.2「回并顺序」的**执行结果**与 §9.1 隔离例外的**收口**。执行前置：用户指示「现在可以将渲染以及物理相关的迁移到 src 以及 apps 三个子项目中了」。

### 10.1 已回并（提交 `8d24b24`）

| 文件 | 来源（副本） | 说明 |
|---|---|---|
| `src/wasm-core/bsp_to_gltf_core/{convert,gltf_builder,materials,mod}.rs` | `test/game-core/crates/wasm-core/**` | 逐一字节复制（`Copy-Item`，非文本管道） |
| `src/wasm-core/bsp_to_gltf_core/lightmap.rs`、`src/wasm-core/vhv.rs` | 同上（副本新增文件） | atlas 生成与导出契约（669 行）；`sp_<i>.vhv` 逐顶点预烘焙解析（195 行） |
| `src/wasm-core/{lib.rs,model_integrator/mod.rs,pakfile_models.rs,vbsp/**.rs}` | 同上 | 含 `vmt_stem_index`、材质回退、PAKFILE 模型、LIGHTING/GAME lump 解析 |
| `src/phys/world.rs` | `test/game-core/crates/phys/phys/world.rs` | `TriEntry.mesh: Rc<TriMesh>` 共享、`BIG_CELL_LIMIT`、`GridCells` HashMap |
| `src/ts-shared/phys/{world-builder,authority-calibrator}.ts` | `test/game-core/src/ts-shared/phys/` | 23 个 ts-shared 文件中**唯二**与副本不同的两个 |

**未回并**：`test/game-core/crates/wasm-core/tests/vtf_probe.rs`（读副本本地 `temp/probe/*.vtf` 夹具，属副本取证工具，不属共享层能力）。
**未改动**：`src/wasm-core/Cargo.toml`（依赖段与副本逐字节一致，副本仅改 version/description/头注）。

### 10.2 三个模块工程的适配

| 工程 | 提交 | 适配内容 |
|---|---|---|
| apps/game | `8d24b24` | `crates/wasm/src/lib.rs` 与整棵渲染/物理 TS 栈迁移；对 `ts-shared` 的 import 重写回根共享层（17 处）；面板「预烘焙 / 纯纹理」 |
| apps/debug | `3eb471e`、`8c6c3b5` | 导出层适配（Arc / vhv / ambient cube / unlit + 3 个 defaults 入口）+ 渲染端共享光照栈 + 同一面板切换 |
| apps/viewer | `9d342a9` | 导出层同一组机械适配 |

### 10.3 §6.3 回并验收条件对照

| # | 条件 | 结果 |
|---|---|---|
| 1 | 两工程 `check-wasm-api.mjs` 同一 blob；各自 exit 0 | **按后续规则修正**：契约**引擎**仍单源于 `src/scripts/lib/wasm-api-contract.mjs`（未改）；`apps/game` 的薄配置清单补 `export_glb_with_pakfile_models_with_defaults_and_lights`（99 → 100 行）。`test/game-core` 自 §2.1 隔离铁律（2026-09-18 新增，晚于本节 r1）起持**引擎隔离副本**，故「同一 blob」这一条被后续规则取代；两侧 `check:api` 各自通过（debug 走其自有 F4 检查） |
| 2 | 两工程 `typecheck` / `build:ts` exit 0 | ✅ apps/game、apps/debug、apps/viewer 三工程各自 0 |
| 3 | GLB 内容断言（TEXCOORD_1 / atlas / 图元顶点数 / extras.faceIndex） | ✅ **跨工程断言已入库**：`test/dual-mode-harness/scripts/cross-project-glb-contract.mjs`（`npm run test:glb-contract`）——四个工程各自导出 surf_666 后逐项断言，**4/4 通过且指标逐字一致**：atlas `textureIndex=0`（PNG）、119 个材质带 `__vbsp_lightmap__` 扩展、primitives 35202（含 `TEXCOORD_1` 34156，`hasLightmap` true 33716 / false 440 / 缺 0）、`faceIndex` 34156 个全唯一、连续两次导出字节相同（确定性）。**唯一差异**是各自入口：game/debug 走 `…_with_defaults_and_lights`、viewer 走 `…_with_pakfile_models` |
| 4 | 同一地图两工程出图一致 | ✅ 逐像素比对：apps/game 出生点帧与迁移前副本帧差 **0.01%**（67/660352） |
| 5 | 文档门禁零漂移 | ✅ `node src/scripts/check-doc-drift.mjs` A/B 计数为 0（C/D 为既有告警） |
| 6 | 无临时产物混入 | ✅ `git ls-files -- '**/temp/**' '**/.tmp/**'` 为空 |
| 7 | （附加）`test/game-core` 隔离硬指标（AGENTS.md §2.1） | ✅ 把仓库根 `src/` 整体移走后，该工程 `npm run typecheck`、`npm run build:ts`、`cargo check --target wasm32-unknown-unknown` **三项 exit 0**；移回后 89 个文件逐文件 sha256 **全等**（零改动） |

### 10.4 收口后的边界状态

- `test/game-core` 的隔离副本**仍然存在**（AGENTS.md §2.1 铁律未变），但自此**共享层演进应落根部**，副本按需重新副本化；回并路径已在本章闭环，§9.1 的「隔离例外」不再有未回并的技术债。
- `lightmap-shader.ts` 未上提共享层：**唯一阻碍**是共享层首个 npm 依赖（`three`）的解析（仓库根无 `package.json`/`node_modules`）。候选方案与裁定入口见 `AGENTS.md` §7.2.5。

### 10.5 光照模式开关（预烘焙 / 纯纹理）的语义与实测代价

> ⚠️ **本节 2026-09-20 的语义与实现已被 §10.6 取代**（用户定调：这是"移动时的渲染速度"旋钮，不是进图速度开关；
> 切换机制由"重建场景"改为"运行期共享 uniform"）。下表保留为历史记录，**现行口径见 §10.6**。

面板开关（apps/game「显示」模块 `#lightingMode`、apps/debug「光照模式」区块 `input[name=lightingMode]`）
对应 `config.lighting.mode`，两侧语义一致：

| 模式 | 材质路径 | 代价 |
|---|---|---|
| `baked`（预烘焙，默认） | world 面吃 lightmap atlas（`applyLightmapToMeshes` 施加 `lightMap` + 注入解码 shader）；prop 吃 `sp_<i>.vhv` 逐顶点烘焙 / leaf ambient cube | **纹理多**：多一张 4096×2048 图集（PNG 解码 + 上传）＋ 33716 个图元的材质替换与 shader 注入 |
| `texture`（纯纹理） | 全部图元按 fullbright 收敛（`MeshBasicMaterial` 仅漫反射贴图），**不调用 `loadLightmapAtlas`** | 纹理最少、材质替换最轻，但画面无明暗关系 |

**实测（apps/game，同一页面内连续切换两轮，surf_666；日志时间戳取自 `[lighting]`/`[lightmap]` 两条相邻行）**：

| 切换 | 材质环节耗时 | 日志证据 |
|---|---|---|
| → `texture` | **1.41 s** | `[lightmap] 光照模式=texture，atlas 0×0，施加 mesh=0` |
| → `baked` | **2.54 s**（1.8×） | `[lightmap] 光照模式=baked，atlas 4096×2048，施加 mesh=33716` |

配套差异（同一轮 `optimizeScene` 日志）：纯纹理 35254 mesh → **1975** 块 / draw call 估算 **2521**；
预烘焙 → **2097** 块 / draw call 估算 **2619**（材质实例更多 ⇒ 块内按材质合并的粒度更细）。
面板小字「预烘焙：加载光照图集与逐顶点烘焙数据，纹理更多，进图与首帧会卡顿几秒」即以此实测为据；
切换本身按新模式**重建场景**（材质必须在 `optimizeScene` 合并前施加），代价与重新加载地图相当。

### 10.6 运行期 uniform 切换（2026-09-21 改定，现行）

#### 10.6.1 语义（用户口径，覆盖 §10.5 首段）

「预烘焙 / 纯纹理」是**人物移动时的渲染速度**旋钮——目的是让移动/转视角时的每帧光照开销降下来、
**帧时间不要大幅跳变**；它**不是进图速度开关**（两种模式加载路径现已完全一致）。
三端小字按此重写（game `web/index.html`、debug `web/index.html`、viewer `src/ui/mapinfo.ts`）。

| 模式 | 片元代价 | 画面 |
|---|---|---|
| `baked`（预烘焙，默认） | 每像素采 lightmap 图集（4 次采样 + 双线性解码）＋ prop 走逐顶点 vhv / 环境盒法线加权 | 有明暗关系 |
| `texture`（纯纹理） | 三条烘焙路径**整体跳过**（uniform 分支，无 divergent 波前分裂）⇒ 不采图集、不解码、不算 cube | 只剩漫反射贴图（外部参照实现 white 兜底口径） |

#### 10.6.2 机制

- 新增共享 uniform `vbspBakedMix`（1 = 预烘焙 / 0 = 纯纹理），声明并入 `VBSP_LIGHTMAP_UNIFORM_DECLS`
  （单一事实来源 ⇒ 三个注入单元都拿到声明），全场景材质**共享同一个 uniform 对象**。
- 三条烘焙路径各自分支：`vbsp_ApplyLightmap()`、`vbspVertexLightTerm()`、`vbspAmbientWeight()`
  在 `vbspBakedMix < 0.5` 时直接 `return vec3(1.0)`（= 调用方那行 `indirectDiffuse += light × albedo` 退化为 `+= albedo`）。
- `setLightingMode(mode)` 只改这一个 uniform 值 ⇒ **零重编译、零材质替换、零场景重建**。
- 加载路径不再按模式分叉：`applyLightmapToMeshes` 恒定建"带烘焙项 + 注入"的材质，`applyLightmap` 两种模式都加载 atlas
  （否则"纯纹理"加载出的材质没有注入，切回预烘焙就只能重建——旧实现的问题）。
- 取舍（诚实记录）：纯纹理模式下 atlas 仍留在显存（不 `dispose`），换取**瞬时**切回；释放显存必须解绑 `lightMap`
  ⇒ 触发 program 重编译 ⇒ 与"切换不打断操作"的目标冲突。

#### 10.6.3 实测（surf_666，三端各一轮，CDP trusted 事件 + 页内 rAF 采样）

| 指标 | apps/game | apps/debug | apps/viewer |
|---|---|---|---|
| 切换同步耗时 | 0.3 / 0.4 ms | 0.6 / 0.3 ms | 0.2 / 0.4 ms |
| 切换窗口 rAF 中位 / 最大 | 3.1 / 5.6~12.9 ms | 13.4 / 34.4 ms | 3.1 / 46.4 ms |
| >100 ms 长冻结帧 | **0** | **0** | **0** |
| pointer lock 保持 | 是 | 是 | 是 |
| 切换时新增加载日志（= 重建） | **0** | **0** | **0** |
| 模式生效（同机位像素差） | 32.3 | 18.1 | 182.7 |
| 回切损失（同机位像素差） | 6.4 | 3.5 | **0** |
| 切换后转视角 / 前进 | 17.1 / 31.4 | 8.8 / 34.3 | 8.4 / 137.6 |

（对照：旧实现切换 = 一次 1.41 s / 2.54 s 的场景重建 + 期间输入中断。）
回切损失与"同模式、无切换、间隔 1.5 s 两帧"的漂移同量级（实测 0.016~6.4 视场景而定），
即差异来自场景自身的时间漂移而非模式残差；viewer 上回切为**逐像素 0 损失**。

#### 10.6.4 静态守卫

`test/game-core/scripts/lightmap-inject-guard-selftest.mjs` 既有 40 条断言（含"每个注入单元的 vbsp\* 标识符必须
自带声明""声明的 uniform 必须全部被 `shader.uniforms.*` 绑定"）继续通过；本轮另以一次性探针（`.tmp`，未入库）
对**三份同源副本**逐项复检 13 条（含"分支恰好出现在三条烘焙路径""不再按模式分叉建材质"）= 全通过。

