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

**天空盒**：渲染端此前没有天空背景（SKY 面被 `is_visible` 过滤，`LightManager` 只设纯色），抬头只见深色；现按 `worldspawn.skyname` 解析 pakfile 内 6 面 skybox 材质（VMT → VTF → PNG）装配为 `scene.background` 的 cubemap（`src/renderer-shared/environment/skybox.ts`；背景优先级归 `LightManager.setSkybox`），已在 `apps/debug` 接线。

**地图雾**：`env_fog_controller`（`fogenable` / `fogcolor` / `fogstart` / `fogend`）此前未被施加（`renderer-main` 不设 `scene.fog`）；现解析为线性 `THREE.Fog` 并由 `LightManager.setFog` 统一挂载（`src/renderer-shared/environment/fog-controller.ts`），可经 `setFogEnabled` 开关；`apps/debug` 已接线。

**动态道具**：模型枚举原先只收 `static_props` 引用的模型、且 `ModelIntegrator` 的 `entities` 恒空，导致 `prop_dynamic` / `prop_dynamic_override` 的道具不进 GLB；现把「带 `model` 的实体」并入引用集合，并由 `model_integrator::collect_model_entities` 喂给放置解析（`surf_boreas` 的 `buk01`、`surf_666` 的 `cow` 已出现）。

**game 天空盒**：`apps/game` 原先 `scene.background` 恒为纯色（0x222222），现已复用 `src/renderer-shared/environment/skybox.ts` 的同一套逻辑显示地图 2D 天空盒；game 的 wasm 增 `parse_entities` / `read_pakfile_file` / `decode_vtf_to_png` 三个导出（追加为独立 `impl` 块，既有行号不动）。viewer 侧待做。

**viewer 天空盒**：`apps/viewer` 原先 `scene.background` 恒为纯色，现已复用同一套 `src/renderer-shared/environment/skybox.ts` 逻辑显示地图 2D 天空盒；viewer 的 wasm 同样补上 `parse_entities` / `read_pakfile_file` / `decode_vtf_to_png` 三个导出。至此**三工程**（debug / game / viewer）天空盒口径一致。

**缺失纹理观测**：`collect_missing_textures` 原先只统计 VMT 解析失败的材质 ——「VMT 解析成功但贴图取不到」被静默回退、不计缺失；现按 `MaterialData.texture_absent` 一并计入（`$basetexture` 声明的 VTF 缺文件或解不出；「本就没有 `$basetexture`」如 Water 仍不算缺失）。`surf_boreas` 缺失数 0 → 5，`surf_666` 46 → 47。

**天空盒拼接**：六面槽位映射此前按错误的轴约定书写（`up` 落在 +X、四个侧面互串），且极面未按 GL 立方体贴图约定做面内旋转；现按 `map_coords` 的真实轴约定改为 `ft→pz / bk→nz / lf→px / rt→nx / up→py / dn→ny`，并把 `up`/`dn` 各转 90°（相邻边连续性实测确认）。

**微缩外景（Source 3D 天空盒的替代实现）**：夹具里没有可分离的地图自带微缩区，故在可达范围之外合成三层低多边形山脊作「到不了的外景」（`src/renderer-shared/environment/miniature-sky.ts`，逐层向雾色混合出大气透视，材质不吃地图雾以免被整片吃掉）；debug 已接线并随换图释放。

**3D 天空盒（地图自带微缩景观）**：按起源引擎的正统做法接入 —— 取 `sky_camera` 半径（`场景半径 / scale`）内的微缩 mesh，复制后**绕 `sky_camera` 缩放 `scale` 倍**（平移量 `CAM*(1-scale)`，等价于引擎把天空相机放到 `CAM + (player-CAM)/scale` 再渲染微缩几何；两者方向夹角实测 0.00°），副本以 `renderOrder = -1` 当天空层；于是玩家在自己的出生点就能看到地图自带的那片远山/雪脊（`surf_boreas` 的微缩区在 `(-3475,-11710,-3158)`，锚点=相机而不是世界原点，后者会偏 21.6°~77.1°）。没有 `sky_camera` 的图仍回退到合成的山脊。

**双贴图地形混合（`WorldVertexTransition` 岩雪混合）**：起源引擎把「岩石 / 雪」这类地形混合写成 VMT 的 `$basetexture2`，并按逐顶点 alpha 混合；此前本仓**全链路都没有处理第二贴图**，故 `surf_boreas` 的雪永远不出现（混合地形只画岩石那一半）。现按通用做法接通三步 —— ① 导出侧把位移顶点的 `alpha/255` 写成几何属性 `_VBSP_BLEND`（非位移面恒 0，所有面都写以保证属性集一致）；② 按 VMT 文本取 `$basetexture2`（不依赖 `vmt_parser` 的着色器枚举，任何 VMT 都能取到）并作为 glTF 第二贴图，下标写进材质 extras `vbsp_basetexture2`；③ 渲染端 `src/renderer-shared/shader/world-transition.ts` 在装配收尾后链式注入 `mix(第一贴图, 第二贴图, 权重)`（不覆盖 lightmap 注入），三个工程共用同一套。开关 `window.__vbspWorldTransitionOff = true` 可做 A/B 对照。

**光照项 γ 的接受窗口修正（显示侧亮度）**：`setLightGamma` 原先只接受 `(0, 1]`，而着色器用的是 `pow(L, 1/γ)` —— **γ>1 才是抬高暗部**（γ<1 反而压暗），窗口与语义正好相反 ⇒ 三个工程与配置里写的 `2.2`（game 的默认值也是 2.2）**一直没生效**，画面整体偏暗。现窗口改为 `(0, 8]`（与面板量程 0.5~6 对齐）。实测：木地板像素 RGB `[42,38,33] → [99,89,76]`、暗像素占比 `75.7% → 0.7%`。

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
