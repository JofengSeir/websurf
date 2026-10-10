# 变更记录

本文件分两段：**§1 当前工作区状态**（只写能由当前代码核验的内容）+ **§2 归档历史**（压缩时间线；归档原文已于 2026-10-07 删除，仅存 git 历史）。

> 说明：工作区原有文档树已移出工作区（2026-10-07 删除本地归档目录，原文仅存 git 历史；**不作事实来源**）。§2 用于追溯项目演进，不用于核验代码事实——需要证据请查代码或 git 历史。

---

## §1 当前工作区状态（未发布，版本 0.1.0）

**受控范围**：三个应用工程 `apps/debug`（8080）、`apps/game`（8090）、`apps/viewer`（8100）与共享层 `src/`（`websurf-phys`、`websurf-wasm-core`、`src/ts-shared/**`）。`test/` 下只有本地夹具（`test/maps/`、`test/replay/`），**没有其它工程**；范围与入口见 `README.md`。

**版本声明**（均为 `0.1.0`，各自文件内可核验）：

| 包 | 声明处 |
|---|---|
| `websurf-debug` | `apps/debug/package.json:3` |
| `websurf-game` | `apps/game/package.json:3` |
| `websurf-viewer` | `apps/viewer/package.json:3` |
| `websurf-phys` | `src/Cargo.toml:3` |
| `websurf-wasm-core` | `src/wasm-core/Cargo.toml:11` |
| 三个工程的 wasm 导出层 | `apps/debug/crates/wasm/Cargo.toml:12`、`apps/game/crates/wasm/Cargo.toml:12`、`apps/viewer/crates/wasm/Cargo.toml:9` |

**构建链**：`wasm-pack` 构建各工程 `crates/wasm` → `pkg/` 并复制到 `web/`；esbuild 打包 worker 与 app；`scripts/build-dist.mjs` 生成 single 或 multi 形态的 `dist/`。命令与锚点见 `README.md`「构建链」。

**记录导入**：viewer 记录页按文件头魔数分派两种记录格式——Shavit `.replay`（文本头 + 定长帧）与 KSF/gokz `.rec`（ksf.surf 回放文件；头部不含 tickrate，按 66.67 估算并在导入警告注明，策略见 `OWNER.md` D-010）。解析器见 `apps/viewer/src/replay/shavit-replay.ts` 与 `apps/viewer/src/replay/gokz-rec.ts`。

**地图材质 patch**：修正 BSP 世界材质的 `patch` include 解析——VBSP 生成的 patch VMT 把 include 写成 `materials/xxx.vmt`，此前解析器又补一次 `materials/` 得到 `materials/materials/…` 而查不到，含 patch 的地图（如 `surf_boreas`）大片地形（21 个材质 / 539 世界图元）无贴图；现先剥 include 自带前缀再补回（`src/wasm-core/bsp_to_gltf_core/materials.rs:448`）。

**水体材质**：`Water` 着色器可以没有 `$basetexture`（只用 `$refracttexture`），此前该分支按「无基色」早退成**不透明纯白**；现按上游口径给半透明水色 `[82,180,217,128]`（`src/wasm-core/bsp_to_gltf_core/materials.rs:475`），含水面地图（如 `surf_boreas` 的 320 世界图元）不再画成白块。

**置换面（displacement）碰撞导出**：洞穴壁/地形是置换面（本图 **1351 张面 / 84,405 顶点**），而笔刷碰撞只有 **159 个凸包** ⇒ 置换面此前**完全没有碰撞**（`world-builder.ts` 里 `disp` 命中 0）。置换面把可见表面从基础笔刷平面推了出去，只拿基础平面做碰撞，玩家撞到的是看不见的旧平面。Source 对置换面的做法就是按**置换面自身的三角形**烘碰撞，故新增 `export_displacement_colliders`（debug + game 两个工程），复用渲染端 `Handle::triangulated_displaced_vertices`（细分网格 + 位移量）输出三角形汤，过 `map_coords` 转 Y-up：**132,480 个三角形**，AABB 覆盖全图。

**置换面碰撞接入物理世界**：`export_model_tri_colliders` 的出口前追加置换面（displacement）条目（本图 1125 条 / 132,480 三角形，与渲染共用同一条细分+位移路径）。洞穴壁/地形此前只被笔刷凸包覆盖（159 个），置换面把可见表面从基础平面推出去 ⇒ 玩家撞到看不见的旧平面。现在 `auto` 分支会带上它们（名字 `__disp_<i>` 与 `.phy` 永不重名）。代价：`triJson` 增大约 13MB。

**置换面（地形）三角化改为引擎扇形细分（修「地图面 mesh 错误生成」）**：位移面的三角形原本按「每格 2 个」切分，且取值下标与顶点数组的展平顺序**转置** —— 于是每个位移块（patch）的三角形连错顶点、相邻块之间的边不吻合，地表整体被抬到不该到的地方（owner 在 `11948,9182,-361` 一带看到地形「延伸与 ramp 模型相交」）。现在按起源 `TesselateDisplacement`（`public/disp_tesselate.h`）复现：四叉树自根向下、每个节点用 `g_TesselateWinding` 的 8 个环绕点绕中心成扇，并按 `m_AllowedVerts` 掩码判活（相邻位移 power 不同时引擎据此粗化细边）。渲染网格与置换面碰撞走同一条路径，两者同时修正；`surf_boreas` 实测 1125 个位移面的三角形拓扑与引擎规则**逐块一致**，该点地表由 9182.3 落到 9088.1（不再穿过模型坡）。

**三工程同步（game 补 3D 天空盒与地图雾；viewer 补 wasm 构建、`parse_pvs_data` 与天空区/雾）**：最近若干轮的改动集中在共享层，各工程缺的是接线 —— `apps/game` 此前只有 2D 天空盒背景，没有 **3D 天空盒（第二相机两遍法）** 与**地图雾**；`apps/viewer` 的 `pkg/` 此前**根本没构建**（渲染一直落后于共享层的全部修复），且缺 3D 天空盒所需的两项数据（`parse_pvs_data` 未导出、雾/`sky_camera` 未取）。本次按各自定位补齐：game 走共享 `miniature-sky.js` 的摘取/两遍法 + `fog-controller.js` 的线性雾，viewer 薄导出层补 `parse_pvs_data`（**解析层接口，仍不依赖 `websurf-phys`**）并复用同一套天空区/两遍法/雾；碰撞类改动仍只在 debug/game（viewer 无物理）。实测两端 `fog={color:0xE8FFFE,start:500,end:43420}`、`skyCamera.scale=4`、viewer 的 `sky_camera` 落在 cluster 2。

**ramp 模型坡「没有实体」其实是碰撞按纹理被丢掉（`skip_sky`）**：boreas 里 `ramp_s1` 的 9 个放置各有一圈 `CONTENTS_DETAIL\|CONTENTS_PLAYERCLIP` 的 brush（外形 4128×384×480，与 `ramp_s1.mdl` 的 hull 逐点吻合），它们只是贴了 `TOOLS/TOOLSSKYBOX` 纹理；而 brush 导出在判过 `is_solid` 之后还按**面纹理**跳过 sky brush（`skip_sky` 默认 `true`），于是这 26 个坡面碰撞被整批丢掉 ⇒ 玩家划上 ramp 直接穿坡。起源引擎的 `CM_ClipBoxToBrush` 只看 `contents & MASK_PLAYERSOLID`，纹理不参与，所以这条过滤本身就不是引擎语义。改法：两工程 `ColliderFilter::default()` 与两处 TS 缺省都改 `skip_sky: false`（显式传 `true` 的调试用法保留）。实测同点位 A/B：9 个坡 18 个采样点里 **16 个碰撞面抬升 43~401 HU**；每个坡 9 点下落全部站在坡面（法线是斜面）。

**盒从置换面棱线上穿过去（owner 报的「`12799,809,10444` 附近连跳穿透地板」）**：三角形碰撞只留了 ±n 两条面（三条边墙在上一轮被降级成「只当门、不产生接触」）⇒ 盒的**脚印跨过三角形棱线**时，面平面的进入分数是按「盒沿 n 的支撑角」算的，而那个支撑角可能落在三角形面域**之外** ⇒ 命中处盒 AABB 与该三角形 AABB 分离、`aabb_overlaps_at` 正当否决 ⇒ 该三角形**一次接触都不产生**、盒直接穿过去（`surf_boreas` `13183,10060` yaw270 实测：起跳 111 tick 后自由落体到地图底 `-256`）。修法按 SDK 口径把障碍集补成 **Minkowski 和 `三角形 ⊕ 盒` 的精确面集**（等价于 `CDispCollTree::SweepAABBTriIntersect` 的 `AxisPlanesXYZ` + `Cache_EdgeCrossAxisX/Y/Z`）：三角面⊕盒顶点（±n）、三角边⊕盒棱（`cross(edge, axis)`，9 张）、三角顶点⊕盒面（±三轴，6 张）。棱线自会被斜法线的补面接住；上一轮被否掉的「边墙 `cross(edge, n)`」那种放大障碍集的做法（脚底黏住的成因）没有回归——真图 8 向行走仍是 7 向 0 个「贴地却几乎不动」tick。

**贴坡行走的「脚底黏住」（三角形碰撞体把面当成实心）**：碰撞侧的三角形此前按 **5 面实心凸体**裁剪（面法线 ±n + 三条边墙），边墙**也产生接触并出法线**；贴坡行走时盒的前缘会在相邻三角形的**棱线**处被这张横向墙挡住，法线又几乎与移动方向相反 ⇒ 速度被整段剪掉、每 tick 只挪零点几 HU（`surf_boreas` 的 `11309,809,10456` 处 yaw90 走 250 tick 只前进 109 HU、其中 56 个 tick 近乎静止）；同时 ±n 这对零厚度面让「盒跨在面两侧」（贴地/贴坡的常态）**必然**被判成 `start_solid`，贴地时 `check_stuck` 会每 tick 误报「卡死」。**修法**：三角形按**面**处理（起源里置换面是 polysoup，没有内部）——三条边墙只作「接触处盒仍搭在该三角形面域上」的门、不出接触与法线，接触只由 ±n 产生，三角形不写 `start_solid` / `all_solid`。修复后同一路径 8 个方向里 7 个方向净位移 **956~972 HU**、**0 个「贴地却几乎不动」的 tick**（唯一残留是真竖直墙）。回归：`src/phys/tri_surface_tests.rs`（4 项），`cargo test -p websurf-phys` **35 项全过**。

**逐顶点道具的光照下限接上**：`vbspLightFloor` 此前只接进 world 路径与 level 2（ambient cube）路径，level 1（`applyVertexLightingShader`）从未设置该 uniform ⇒ 「光照下限」旋钮对**逐顶点着色的道具静默无效**。现补上并用于 `max(vlight, floor)`；`floor` 默认 0 时与改前等价（`max(v,0)`），调大后逐顶点道具不再纯黑——与 T-438 未覆盖的 28.5% 暗顶点互补。

**退化 `.vhv` 的兜底（道具逐顶点光照）**：`.vhv` 只烘 direct+bounce，背光顶点精确为 0；实测 `surf_boreas` 全部道具顶点里 **43.7%** 三通道全 0，而 level 1 是纯乘法（`vbspVertexLightTerm`）且**不叠** leaf ambient cube ⇒ 这些顶点必然是纯黑。现按"暗顶点占比 ≥ `VLIGHT_DARK_FRACTION_MAX`（0.5）"判定该份烘焙无法表达表面，退回 leaf ambient cube（平坦但不再是纯黑）。效果：带 `_VBSP_VLIGHT` 的图元 397→220，全黑顶点 43.7%→28.5%。

**道具逐顶点光照的顶点错位**：`.vhv` 是**一个 strip group 一块**、块内按该 strip group 的顶点数组局部序（SDK `utils/vrad/vradstaticprops.cpp` 取 `mesh->vertexoffset + pVertex(nVertex)->origMeshVertID`），而 GLB 顶点数组按 `origMeshVertID` 排。我们此前按"拼接序 = 模型顶点序"使用，逐顶点光照落到错误顶点上（表现为石头一块亮一块黑、像拼接）。现新增 `vmdl::Model::remap_strip_group_colors` 按 SDK 口径重排后再挂 `_VBSP_VLIGHT`，长度/几何对不上则退回 leaf ambient cube。

**VTF 贴图格式（模型那几条白块的根因）**：`Ia88` / `Bgra4444` 两类格式此前解不出（外部 `vtf` crate 能读表头、`decode` 报 `UnsupportedImageFormat`），于是 `tendies_endsmoke` / `alch_symbols` / `end_wiccan` 等按"缺贴图"走占位。现 `src/wasm-core/texture_utils/image.rs` 补上这两类解码，`load_texture_bsp` 改为 **crate 优先、失败退本仓**，两条解码路径判定一致；`surf_boreas` 的 `vtfDecodeFail` 由 4 降为 0，上述材质取到真贴图。

**缺材质占位（半透明）**：声明一半透明的材质若**贴图整条拿不到**，此前占位色是 `[255,255,255,255]` ⇒ glTF 为 `alphaMode=BLEND` **且 alpha=1**，等于把 `$additive` 的烟/雾画成**不透明白幕**（`surf_boreas` 中央那面白墙即 `project_tendies/tendies_endsmoke`：VMT 在包里、`$translucent 1` + `$additive 1`，但 `$basetexture` 的 VTF 不在包内）。现按 `translucent | glass` 且 `texture_data.is_none()` 时占位 alpha 取 **51（0.2）**，呈现为淡雾而不是白墙；不透明材质照旧 255。

**道具光照方向（leaf ambient cube 的轴序）**：GLB 的**位置**经 `map_coords` 转成 Y-up，而**法线**此前是 `vertex.normal.into()` 原样（Source Z-up），两条属性不在同一基；渲染端 `vbspAmbRaw` 又按引擎口径 `common_vertexlitgeneric_dx9.h` 的 `VertexShaderAmbientLight` 用 **Source 分量**取 cube 槽（cube 本身也是 Source 序 `[+X,−X,+Y,−Y,+Z,−Z]`）⇒ 两侧"错得一致"，只对**纯 yaw** 旋转的道具偶然成立，带 pitch/roll 的道具（冲浪坡）会把"上方的光"贴到别的朝向。现改为：法线同样走 `map_coords(apply_root_transform(..))`，并把 shader 的取槽索引按 Three 序重排（`nz²·cube[0/1] + nx²·cube[2/3] + ny²·cube[4/5]`）。实测近洋红魔法点光（worldlight #352，Source `[13332,628,12251]`、强度 `[690,0.5,1897]`）处的 prop：竖直法线取 cube 的竖直面 **up=0.12904 / down=0.03378**（改前为水平面 0.065/0.0625）。

**道具与玻璃的碰撞**：可视碰撞导出此前**按材质透明度剔除网格**——`alpha_mode == 1`（`$translucent` / `$alpha`）的 mesh 整件不进碰撞三角形，于是半透明/透明道具（`surf_666` 的 `kr_windows` / `details69_window01m`、`surf_sedona` 的 16 个模型含 `surf_sedona_ramp03` 与 `naz_curve1..5`）在 `.phy` 输出里存在、在可视输出里被整件剔掉，玩家会穿过本该可站可撞的坡与窗。起源引擎的碰撞来自模型的 `.phy`（vphysics）与 BSP 的 `contents` 位，`$translucent` / `$alphatest` 只进渲染 ⇒ 现改为**不按透明度剔除**（`apps/*/crates/wasm/src/lib.rs` 的 `export_model_tri_colliders`）；同时 `src/ts-shared/phys/world-builder.ts` 的 `auto` 改为**逐模型**回退可视网格（原先只在整表为空时回退 ⇒ `.phy` 缺失的个别模型静默无碰撞，实测 `surf_666` 5 个、`ze_cursed_bear` 3 个）。

**天空盒**：渲染端此前没有天空背景（SKY 面被 `is_visible` 过滤，`LightManager` 只设纯色），抬头只见深色；现按 `worldspawn.skyname` 解析 pakfile 内 6 面 skybox 材质（VMT → VTF → PNG）装配为 `scene.background` 的 cubemap（`src/renderer-shared/environment/skybox.ts`；背景优先级归 `LightManager.setSkybox`），已在 `apps/debug` 接线。

**地图雾**：`env_fog_controller`（`fogenable` / `fogcolor` / `fogstart` / `fogend`）此前未被施加（`renderer-main` 不设 `scene.fog`）；现解析为线性 `THREE.Fog` 并由 `LightManager.setFog` 统一挂载（`src/renderer-shared/environment/fog-controller.ts`），可经 `setFogEnabled` 开关；`apps/debug` 已接线。

**动态道具**：模型枚举原先只收 `static_props` 引用的模型、且 `ModelIntegrator` 的 `entities` 恒空，导致 `prop_dynamic` / `prop_dynamic_override` 的道具不进 GLB；现把「带 `model` 的实体」并入引用集合，并由 `model_integrator::collect_model_entities` 喂给放置解析（`surf_boreas` 的 `buk01`、`surf_666` 的 `cow` 已出现）。

**game 天空盒**：`apps/game` 原先 `scene.background` 恒为纯色（0x222222），现已复用 `src/renderer-shared/environment/skybox.ts` 的同一套逻辑显示地图 2D 天空盒；game 的 wasm 增 `parse_entities` / `read_pakfile_file` / `decode_vtf_to_png` 三个导出（追加为独立 `impl` 块，既有行号不动）。viewer 侧待做。

**viewer 天空盒**：`apps/viewer` 原先 `scene.background` 恒为纯色，现已复用同一套 `src/renderer-shared/environment/skybox.ts` 逻辑显示地图 2D 天空盒；viewer 的 wasm 同样补上 `parse_entities` / `read_pakfile_file` / `decode_vtf_to_png` 三个导出。至此**三工程**（debug / game / viewer）天空盒口径一致。

**缺失纹理观测**：`collect_missing_textures` 原先只统计 VMT 解析失败的材质 ——「VMT 解析成功但贴图取不到」被静默回退、不计缺失；现按 `MaterialData.texture_absent` 一并计入（`$basetexture` 声明的 VTF 缺文件或解不出；「本就没有 `$basetexture`」如 Water 仍不算缺失）。`surf_boreas` 缺失数 0 → 5，`surf_666` 46 → 47。

**天空盒拼接**：六面槽位映射此前按错误的轴约定书写（`up` 落在 +X、四个侧面互串），且极面未按 GL 立方体贴图约定做面内旋转；现按 `map_coords` 的真实轴约定改为 `ft→pz / bk→nz / lf→px / rt→nx / up→py / dn→ny`，并把 `up`/`dn` 各转 90°（相邻边连续性实测确认）。

**微缩外景（无 `sky_camera` 时的兜底）**：地图没有 `sky_camera`、或天空区与可玩区不可分离时，回退到合成三层低多边形山脊作「到不了的外景」（`src/renderer-shared/environment/miniature-sky.ts`，逐层向雾色混合出大气透视，材质不吃地图雾以免被整片吃掉）；debug 已接线并随换图释放。

**3D 天空盒（第二相机两遍法，起源正统做法）**：`sky_camera` 驱动的**第二台相机**位姿 = `sky_camera 原点 + 主相机位置 / scale`（`viewrender.cpp` 的 `CSkyboxView::DrawInternal`），地图自带的天空区图元摘进独立层、由它单独渲染；顺序是「2D 天空盒背景 + 天空区 → 清深度 → 主世界」，主世界那一遍不再画背景（否则 three 的背景 pass 会盖掉天空遍）。天空区的判据是「图元采样点落在 `sky_camera` 所在 BSP cluster」，实测与旧的「种子 + 包围盒簇扩张」是同一批 361 个图元（`surf_boreas` 的天空区 = 1103 leaf / 1231 面）；相机公式由正面朝向实测钉住：引擎式 **359.8/361** 对相对式 235.6/361、**163/163** 个出生点都是引擎式更优。天空遍的雾按引擎 `Enable3dSkyboxFog` 的口径走 **`sky_camera` 自己的雾键值**（`fogenable`/`fogcolor`/`fogstart`/`fogend`）且 `start`/`end` 再乘 `1/scale`——天空区几何是按 `1/scale` 烘的，用主图的雾会把远山按近处衰减；`fogenable` 为假时天空遍一点雾都不吃。此前「绕 `sky_camera` 缩放」的静态近似**已删除**——它的引擎相机公式写错了（`CAM+(P-CAM)/scale`），且必须靠 `renderOrder`/关深度来伪装层序。没有 `sky_camera` 的图仍回退到合成的山脊。

**双贴图地形混合（`WorldVertexTransition` 岩雪混合）**：起源引擎把「岩石 / 雪」这类地形混合写成 VMT 的 `$basetexture2`，并按逐顶点 alpha 混合；此前本仓**全链路都没有处理第二贴图**，故 `surf_boreas` 的雪永远不出现（混合地形只画岩石那一半）。现按通用做法接通三步 —— ① 导出侧把位移顶点的 `alpha/255` 写成几何属性 `_VBSP_BLEND`（非位移面恒 0，所有面都写以保证属性集一致）；② 按 VMT 文本取 `$basetexture2`（不依赖 `vmt_parser` 的着色器枚举，任何 VMT 都能取到）并作为 glTF 第二贴图，下标写进材质 extras `vbsp_basetexture2`；③ 渲染端 `src/renderer-shared/shader/world-transition.ts` 在装配收尾后链式注入 `mix(第一贴图, 第二贴图, 权重)`（不覆盖 lightmap 注入），三个工程共用同一套。开关 `window.__vbspWorldTransitionOff = true` 可做 A/B 对照。

**光照项 γ 的接受窗口修正（显示侧亮度）**：`setLightGamma` 原先只接受 `(0, 1]`，而着色器用的是 `pow(L, 1/γ)` —— **γ>1 才是抬高暗部**（γ<1 反而压暗），窗口与语义正好相反 ⇒ 三个工程与配置里写的 `2.2`（game 的默认值也是 2.2）**一直没生效**，画面整体偏暗。现窗口改为 `(0, 8]`（与面板量程 0.5~6 对齐）。实测：木地板像素 RGB `[42,38,33] → [99,89,76]`、暗像素占比 `75.7% → 0.7%`。

**lightmap 图集空纹素膨胀（消除地图上的「黑带」）**：图集给每个面留了一圈 1 px 边距（打包矩形 = luxel + 2、落位内缩 1 px），打包还会留下未用残块与页尾；这些空纹素是 `(0,0,0,0)`，而渲染端的解码式是 `rgb * 2^(a*255-128)` ⇒ 解码成**纯黑**。面边缘的 lightmap 取样会取到矩形外的纹素（顶点 UV 落在 luxel 中心，再往外半纹素就出界），踩到边距就在每个面的边界上画出一条黑带——实测 `surf_boreas` 有 **26,810/368,634（7.27%）** 个 lightmap 顶点取样落在空纹素上、其中 **86% 恰好差 1 纹素**，8 张地图的图集空纹素占比 **32.7%~67.2%**。现落位填像素后做**多源 BFS 膨胀**，把每个空纹素填成最近有效纹素的值（`dilate_empty_texels`，`src/wasm-core/bsp_to_gltf_core/lightmap.rs`）⇒ 越界取样取到的是该面自己的边缘 luxel；8 张图图集 `空=0.0%`、`surf_boreas` 的取样落空顶点数归零，图集 PNG 体积基本不变。

**位移面的 lightmap UV 改按细分网格（黑带 / 「串台光照」的根因）**：起源 SDK 里位移面的 lightmap 采样块是 `(sizeU+1)×(sizeV+1)` 的**规则网格**，四角 luxel 坐标恒为 `(0.5,0.5)`、`(0.5,V+0.5)`、`(U+0.5,V+0.5)`、`(U+0.5,0.5)`（`builddisp.cpp` 的 `CCoreDispSurface::CalcLuxelCoords`），网格点由 `CCoreDispInfo::CalcDispSurfCoords` 在四角之间双线性插值——归一化后就是**单位方格** `u=j/2^power`、`v=i/2^power`，与顶点三维位置无关。本仓此前把**已被位移推走的顶点**投影到 lightmap 轴上，于是地形（位移面）的 UV 漂出本面的图集矩形：实测 `surf_boreas` **931/1351（68.9%）** 个图元的 uv 盒越界，最大越界 **49 个纹素**、39 个整块落到图集外 ⇒ 采到**相邻面的光照贴图**（观感是「混进其他光照贴图」）或图集空白（纯黑块/黑边）。现按 SDK 口径改为 `src/wasm-core/vbsp/handle/mod.rs` 的 `vertex_grid_uv`（`Handle::<Face>` 逐顶点给出单位方格坐标）→ `src/wasm-core/bsp_to_gltf_core/lightmap.rs` 的 `lightmap_region_uv` 映射进矩形；**8 张地图逐面 uv 盒全部落回自己的矩形（越界 0）**。

**三端渲染呈现档收到唯一来源（`vbsp:renderPrefs`）**：三端此前各持一份呈现档——game 从面板偏好 `vbsp:panelPrefs` 读曝光 / γ / 模型光照 / 画质档 / FOV / 渲染距离，debug 从 `vbsp:uiPrefs` 读画质档，viewer 两者皆无（恒用默认档）⇒ 同一台机器三端可以呈现不同亮度与清晰度，「三端同画面」无法当基线。现新增共享层唯一来源 `src/renderer-shared/config/render-prefs.ts`（键 `vbsp:renderPrefs`，带版本号）：三端 init 都经 `readRenderPrefs()` + `applyRenderPrefs()` 取同一组值；写入只由能代表用户的端（game 面板、debug 的画质档控件）经 `writeRenderPrefs()` 落盘。旧键**只读迁移一次**并保留（`vbsp:panelPrefs` / `vbsp:uiPrefs` 不删，回退不丢设置）。**效果**：在一台改过 game 亮度/画质档的机器上，debug 与 viewer 此后跟随同一组值（这正是三端同源的目的）；未改过设置的机器画面逐像素不变（三端出图与 T-454 P0 基线比对：`≤2 占比 1.0000`、均值差 0）。启动时三端各打一行 `[render-prefs] 生效：…`，便于比对同一组生效值。判据与后续阶段（相机/雾/可见性/画质再接）见 `TODO.md` T-454。

**文档体系**：工作流与工程文档已全部压进 **agentmemory**（marker 前缀 `websurf/`）；仓库侧只留 `AGENTS.md`（入口）+ `TODO.md`（状态）+ `OWNER.md`（决定）+ `skills/**` + git 仓库项目文档。

**验证**：共享层 `cargo test -p websurf-phys`；三工程 `npm run typecheck` 与各自 `test:*` 门禁；文档侧 `node src/scripts/check-doc-drift.mjs`。CI 三条 workflow 见 `README.md`「验证与 CI」。

**渲染三端同源收口（T-454 P5/P7，2026-10-10）**：`apps/**` 不再持有渲染实现——三端 wasm 导出编排（PAKFILE 模型/材质提取、光源实体、碰撞体派生）收进 `src/wasm-core/render_bundle.rs`（纯 Rust、零 `wasm_bindgen`；三端 `crates/wasm/src/lib.rs` 净删 **1306** 行重复，GLB 导出**逐字节不变**：同端重复导出确定性，搬动前后六组 sha256 相同），渲染侧的天空两遍法与地图雾收进 `src/renderer-shared/environment/render-sky-pass.ts`（`setFogMaxDensity` 在 `apps/**` **0 命中**）。**可见变化**：game 的雾上限施加顺序对齐 debug（同一视点 **0.02%** 像素、均值差 0.0029）⇒ 此后同图同视点 **debug↔game 逐像素完全相同**（`100.0000%` / 均值差 0 / 最差 0，原为 `99.980%` / 0.0029 / 43）。新增两道门禁并接入 CI `glb-parity` job：`src/scripts/check-glb-parity.mjs`（三端 GLB 节点名/属性键/`extras.ambientCube`/材质逐字段/贴图逐字节一致性）与 `src/scripts/check-render-parity.mjs`（`apps/**` 19 条渲染实现符号 0 命中 + 三端共享入口覆盖）。

**当前已知缺口**（逐条证据与处置状态见根 `AGENTS.md` §7.3 待决索引；原进度台账已随 plan 目录退役删除）：输入录制链路未接线、零分配支路（`tick_into` / `state_out_ptr` / `seed_from`）与 `set_yaw_pitch` 无装配点、`.cmd` 的 wasm 新鲜度门与页面消费的产物不是同一份等。

> 注：更早的条目（含已退役工程 `test/dual-mode-harness`、`test/game-core` 的时期）见 §2 归档历史；当前受控工程只有 `apps/{debug,game,viewer}` 与 `src/`。

---

## §2 归档历史（压缩时间线）

细节、实测数字与论证见 git 历史（本地归档目录已于 2026-10-07 删除）。

### 2026-09-22 · 文档与注释重编（已完成）

- 立项：以源码为唯一事实来源重写全部文档与代码注释；旧 documents/** 与根四份文档移出工作区（本地归档目录已于 2026-10-07 删除，原文仅存 git 历史）。
- 产出 `documents/plan/` 三篇控制文件（读码事实基线 / 任务书 / 进度台账；2026-09-23 随任务完结删除，引用并入根 `AGENTS.md`）；根 `AGENTS.md` 改为当前任务的行为规范与进度纪要。
- 文档树重组为 `architecture/ phys/ wasm-core/ ts-shared/ materials/ debug/ game/ viewer/ norms/ plan/`。

### 2026-09-21 · 光照与输入

- 光照模式改**运行期切换**（共享 `uniform vbspBakedMix`，三条烘焙路径各自分支）：切换 0.2~0.6 ms（旧实现 1.41 s / 2.54 s），零重建；viewer 接入同一套光照栈。
- `test/game-core` 转**本地工程不入库**（从 32 个未发布提交剥离）；`test:glb-contract` 标为 optional。
- game 新增 8 键 HUD 键位簇（标签取该动作第一个绑定键，面板改键即同步）；蹲/跳位置对调。
- 视角锁定改为点击 `document` 即锁（浮层不再吞点击）；debug「缺失纹理」弹窗点背板可关。
- debug 进图整屏空白根因修复：`InterleavedBufferAttribute.array` 是整段 stride 缓冲，按 `itemSize` 重建得非整数顶点数 ⇒ 包围盒 NaN ⇒ LOD 不渲染。
- tickRate 取消隐藏偏移（面板值 = 权威步长）。
- CI 拆分为 `deploy-pages.yml`（只部署，matrix 并行）与 `ci-gates.yml`（门禁），互不阻塞。

### 2026-09-20 · 共享层回并

- `test/game-core` 隔离副本回并：`src/wasm-core/**`（新增 `lightmap.rs`、`vhv.rs`）、`src/phys/world.rs`（`TriEntry.mesh` 改 `Rc<TriMesh>` ⇒ 权威线启动 4972 ms → 135 ms）、`src/ts-shared/phys/{world-builder,authority-calibrator}.ts`。
- 三工程渲染/物理栈迁移；新增跨工程 GLB 契约门禁 `test:glb-contract`（4/4 一致）。

### 2026-09-13 · 物理

- 蹲姿/起立对齐 Source `CanUnduck()`：移除"放脚被挡即原地起立"的非 Source 兜底；空中起立必须放脚（origin 下移 18）并扫掠判定。影响：贴坡 surf 松键保持蹲姿直到离坡或落地（原版行为）。新增 `duck_surf_tests.rs`。

### 2026-09-12 · 仓库规范

- 新增三份规范：`framework-audit.md`（`I-01..I-22`、`R-01..R-21`）、`framework-launch-structure.md`（启动/结构/产物、10 端口段槽位）、`framework-decoupling.md`（共享层上提裁决 `D-01..D-23`）。
- 78 个 LF-only 文本文件归一 CRLF（内容零变化）；清理约 25 MB 临时堆积（已备份仓库外）。
- 新增 `src/scripts/check-doc-drift.mjs`；`mouse-buffer` / `pointer-lock` 上提共享层。

### 2026-09-11 · 结构迁移

- debug / game / viewer 迁入 `apps/`；`test/game`、`test/instanced-diorama` 移除。

### 2026-09-08 · 查看器与回放

- `apps/viewer`：Shavit `.replay` 原生二进制回放（JSON 与规则脚本通道移除），保留坐标映射与人工变换；新增回放遥测 HUD；速度单位改 `u/s`。

### 2026-08 · 早期主线（摘要）

- BSP 支持 Source 1 **v19~v29**（v20/v21 lump 布局一致，放宽版本检查）；新增 sprp v11 静态道具。
- 材质低清压缩（mosaic v4 + MTZ）与画质切换；打包双模式 `single` / `--multi`。
- `src/ts-shared/` 收敛（SAB 512 B 权威双缓冲、权威循环、校准、输入层、地图管线）；去 LERP/外推，改预测物理直读 + 权威速度校准。
- 一批修复：斜坡接缝卡零速、贴墙近平面裁剪、地图重载内存泄漏、传送检测等。

---

## 0.1.0 — 2026-08-05

- 初始版本：BSP 解析、CS 移动物理、Three.js 渲染。
