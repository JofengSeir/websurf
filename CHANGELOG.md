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

**文档体系**：根 `README.md` 为入口；`documents/**` 按主题分篇（架构、物理、解析层、TS 共享层、材质、规范），篇目见 `README.md`「文档地图」与 `documents/index.md`。

**验证**：共享层 `cargo test -p websurf-phys`；三工程 `npm run typecheck` 与各自 `test:*` 门禁；文档侧 `node src/scripts/check-doc-drift.mjs`。CI 三条 workflow 见 `README.md`「验证与 CI」。

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
