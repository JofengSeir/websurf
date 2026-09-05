# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范。

## [0.2.0] - 未发布

### 新增

- **viewer 最小 BSP 自由视角查看器（349ee26，2026-08-19）**：新增第四应用工程
  `viewer/`——最小 BSP 自由视角查看器（WASM 解析 + Three.js 渲染，无玩法系统），
  位姿三通道：URL 参数 / `location.hash` / `window.viewer` 编程接口；自带
  README 与 `docs/overview.md`；path 依赖共享层 `../src`、dev 复用
  `../src/serve.py`；不接入 Pages CI（仅 debug/game 部署）。
- **test/ 测试合集重组（2026-08-13）**：根 `test/` 集中全部测试内容并细分三目录——
  - `test/dual-mode-harness/`：原 WebSurf-test 验证工程整体搬入（双模物理 + 帧信号渲染时序验证，含 mini/〔随后已移除，2026-08-24 核对不在仓库〕与 scripts/ 全套验证套件）；
  - `test/extract/`：原根 `extract/`（bsp-extract 独立解包器）整体搬入（CLI + wasm + 网页/查看器，URL 变更为 `/test/extract/web|viewer/`）；
  - `test/map-min-export/`：**新增**地图最小导出实验——导出**最小可视几何**（GLB，跳过 SKY/TRIGGER/NODRAW/HINT/SKIP 不可见面）+ **碰撞**（BRUSHES/BRUSHSIDES/PLANES → `{planes,min,max,is_ladder,is_solid}` JSON，与 game brushJson 契约同构）+ **材质纹理**（PAKFILE 提取 VMT/VTF，VTF→PNG 解码 DXT1/DXT5/常见未压缩格式），含 manifest 与 Node 验证脚本；
  - **CSS + CS:GO 双版本支持（2026-08-14）**：Source 1 v19~v29 全版本；`FACES` 按 lump version 分派（v0 28B CSS 老图 / v1 56B / v2 64B，关键字段偏移全版本一致）；CSS 无 PAKFILE 场景优雅注明（材质在外部 vpk）而非报错；合成 v19 CSS 特征 BSP 全链路验证（FACES v0 + 空 PAKFILE + NODES/LEAFS v0 + 实体 brush origin 平移）19/19 PASS；extract 补 FACES v0 合成回归测试；产物零冗余（PNG 成功不落 .vtf）。
  - **移除 bsp-extract，解析层并入 map-min-export（2026-08-14）**：`test/extract/` 整体移除（git rm，历史保留）；其 CS:GO 版 BSP 导出逻辑（VBSP 头/64 lump/Valve LZMA/PAKFILE zip/实体/场景重建/GLB 写入/displacement）以**最小实现**并入 `test/map-min-export/`——新增 `[lib]` 目标（`map_min_export`：bsp/bspfile/lzma/pak/scene/glb/displacement 模块 + 原有 collision/materials/vtf），main.rs 改薄 CLI 入口；依赖收敛为 lzma-rs/zip/serde/serde_json/flate2（无 wasm-bindgen）；合成 BSP 集成测试随迁 `tests/integration.rs`（4 项，含 FACES v0 CSS 变体）；lib 测试 39 + 集成 4 全过，clippy 零警告；文档（根 README/architecture/CONTRIBUTING/PR 模板/CHANGELOG）同步更新。
  - **交互式选择性导出 CLI（2026-08-14）**：`map-min-export` 支持拖拽 .bsp 释放后交互——
    「默认导出（几何/模型/材质/碰撞）? [y/n]」，否定后**依次提问全部可导出部分**
    （几何/模型/材质/碰撞/光照/音效/脚本/其他资源），最后一问答完立即导出；`--parts
    geometry,models|default|all` 非交互模式供自动化；**输出改为单文件夹内每部分同名
    文件夹包裹**（`geometry/`、`models/`、`materials/`、`collision/`、`lightmap/`、
    `sounds/`、`scripts/`、`other/` + `manifest.json` 汇总含逐材质明细）；
    新增 `parts.rs`（部分枚举/默认四项/全部八项）与 `pakres.rs`（PAKFILE 子集提取：
    models/sounds/scripts/other 保留相对路径 + 路径穿越防护；LIGHTING lump 光照导出）；
    materials 改为相对路径子目录；verify.mjs 按 manifest.parts 逐部分校验（22/22×3）；
    surf_666 实测：模型 620 文件 / 其他 655 / 光照 29.04MB；ze 实测：音效 50 文件 / 脚本 3；
    CSS 无 PAKFILE 图资源部分自动跳过（0 文件而非报错）。
  - **instanced-diorama 实例化绘制 + PBR 光照渲染测试（2026-08-14）**：新增 `test/instanced-diorama/`——双模式测试用例：
    - **沙盘 Diorama**：2.1 万~10 万实例方块（每材质 1 个 `InstancedMesh` = 1 draw call，实测 2.1 万实例仅 4 个方块 draw call）；写实体素材质物理区分——金属（metalness 1.0 / roughness 0.22 / RoomEnvironment 影棚反射）、玻璃（MeshPhysicalMaterial transmission + ior 1.5 真折射）、木头/砖块（全漫反射 / roughness 0.9+ / 程序化画布纹理，零外部资源）；影棚光照（物理单位强度平行光 PCFSoftShadowMap 4096 软阴影 + 紧贴阴影视锥 + 半球天光 + 冷色补光）；电影级后处理（SnapshotPass 快照 + SSAO 强度可调合成 + Bokeh DOF 焦点跟随相机 + FXAA + ACES）；
    - **BSP 地图**：wasm 新增 `export_glb_with_pakfile_models_with_lights`（`collect_light_entities`：light/light_spot/light_environment → `KHR_lights_punctual` 写入 GLB，实测 ze 499 灯 / surf_666 2118 灯）→ GLTFLoader 原生解析导出灯光 → 渲染端实例化（共享 mesh 节点 → 空间 cell 分组 InstancedMesh：ze 449 / surf_666 1013 实例）+ 世界几何合并（GLTFLoader primitive 级 18734/35254 mesh → 按材质+空间 cell 合并为 503/1677 块，draw call 55591→2376 约 23 倍削减）→ 同一条 SSAO/FXAA 管线（DOF 默认关闭：参数按沙盘尺度调校）；光照预算默认取亮度 top-32（three.js 前向着色器灯光上限）；修复三处渲染管线坑（EffectComposer 跳过 pass 破坏 swap 链 → 效果归零而非 disable；ShaderPass 换材质需同步 uniforms；沙盘 Fog 污染大地图 → BSP 模式清雾）；
    - 验证：wasm-pack + typecheck + esbuild 构建 ✓；node 光照导出冒烟（两图 extensionsUsed/lights/节点断言 PASS）；headless Chrome 截图像素统计矩阵证明 SSAO（遮蔽变暗）/DOF（边缘模糊）/FXAA 逐项生效；`?bsp=` / `?probe=`（8×8 亮度网格）/ `?lights=` / `?ambient=` 参数供自动化验证。
  - **src 共享层文件合并与命名整理（2026-08-14）**：`src/wasm-core` 内部重组（顶层模块路径不变，三端 wasm 契约零改动）——`vbsp/data` 8→3（vector/prop/displacement 并入 mod.rs）、`vbsp/handle` 4→1、`texture_utils` 6→2（header/resources/utils 并入 vtf.rs）、`bsp_to_gltf_core` 5→4（error 并入 mod.rs），wasm-core 25→17 文件；函数/参数命名经检查已合理（CS 物理术语 + wasm 契约，phys/ts-shared 不改）；验证：wasm-core 16 测试 + 三端 wasm 构建 + 地图加载零回归（surf_666 7065 brush/142.6MB、ze 4818/38MB）。
  - **地图最小导出合并进共享层 vbsp，map-min-export 移除（2026-08-14）**：比对 `src/wasm-core` 地图加载与 map-min-export 后实证 **v20 与 v21 的 lump version 分布一致**（NODES v0 / LEAFS v1 / FACES v1 / 其余 v0，记录大小 32/32/56B 相同）——v21 地图（ze_cursed_bear_tales）解析失败的根因仅是**版本检查硬编码 v20**；据此合并：① vbsp 版本检查放宽至 v19~v29（`vbsp/bspfile.rs`）；② 新增 **sprp v11 静态道具支持**（`vbsp/data/game.rs`，80B/记录实测布局：angles 为 3×f32 12B、flags 移位、新增 min/max_gpu_level/diff_modulation/unknown、无 lightmap_resolution）；③ 顺带修复 wasm-core 既有测试（mtz Entry 缺 opacity、tf2_file 标 ignore）；验证：ze(v21) 全链路（metadata 21774 faces/5123 brushes/302 models、碰撞 4818 brush、GLB 37MB 含 static props 354 nodes）✓、surf_666(v20) 碰撞 7065 零回归 ✓、debug/game wasm 构建 ✓；`test/map-min-export/` 整体移除（测试使命完成，文档/CHANGELOG/architecture 同步清理）。
  - 全部搬移经 git mv 保留历史（R 状态）；dual-mode-harness 相对依赖同步加深一级（`crates/wasm` → `../../../../src`、`[patch.crates-io] vmdl` → `../../src/vendor/vmdl`）；根 README/docs/CHANGELOG 引用同步更新。
- **bsp-extract 独立 Rust BSP 解包器（f3662c8 / 647ff07，2026-08-12）**：
  `extract/` 独立 workspace（不归属仓库根/其他工程，不依赖共享层任何 crate），独立重实现
  VPKEdit/sourcepp 的 bsppp 模块——VBSP 头解析、64 lump 目录、Valve LZMA、PAKFILE zip
  枚举/提取、实体 KV 解析、场景几何重建与 GLB 导出；CLI 子命令 info/entities/pak
  list/pak get/pak extract/glb，wasm 导出 bsp_to_glb/bsp_info，配套最小网页与端到端验证。
- **trace 公共模块（878515f / b019115）**：`src/ts-shared/trace/`（trace-types / trace-recorder /
  trace-renderer）——运动路径采集与显示（双线对照：无限制基准 vs tick 实际），由 /test 的
  trace 功能提升为公共模块，供 game/debug/test 复用；trace-renderer 渲染引擎无关（依赖注入，
  移除 three 硬依赖）。
- **WebSurf-test 验证工程（c2e88b0 / 607c9a0 / d1767c0 / 3854f71，2026-08-11 收尾）**：
  `test/` 独立工程（不入 Pages 部署），验证"主线程不做物理/渲染（BSP 解析导出 +
  输入转发 + rAF wake）→ SAB 无锁 → WorkerA 双模物理 → WorkerB 帧信号渲染"完整循环，
  含 `scripts/` 验证套件（phys-smoke **192/192 PASS** / perf-bench / race-wakeup /
  tmp-dual-compare（现名 `dual-compare.mjs`）/ trace-verify）与 `play.cmd`。
  - **WorkerA 双模物理核心（d1767c0 重构）**：**先 tick 计算 → 后无限制计算**；
    模式A = 1ms 子步 + 实时输入（位置/角度唯一推进者，共享槽唯一写入者）；
    模式B = **独立 64t 权威速度线**（第二个 PhysWorld，只走 tickDt 步长：
    键位边界快照 peekKeys + 模式A 消耗鼠标窗口累积 → `set_velocity(三轴)`
    校准——唯一 tick 影响通道，位置/角度不碰）；**分叉兜底锚定**
    TICK_ANCHOR_DIST=64（死亡/传送/卡墙/坡缘后全量拉回，正常演化不干预）；
    respawn/world-json 双实例同步；TICK_RATE=0/≥1000 跳过模式B
  - **渲染驱动三轮修复（发布驱动 → 帧信号驱动）**：主驱动 = 主线程 rAF
    `wake()` 的 RENDER_WAKEUP（vsync 对齐，呈现平滑）；WorkerA 发布**不 notify**
    （1kHz 随机相位唤醒 → 呈现时间不规则 → 观感抖动，已移除）；解除节流
    （固定 50ms 超时仅作停摆兜底）；V 未变不重绘；OffscreenCanvas 零拷贝直通
  - **会审结论文档**：`test/dual-mode-harness/CONCLUSION.md`——「64t 坡速 ≈ 无限制」主因 =
    物理算子按 dt 标定（稳态速度 tick 不变量），真实难度载体 = 输入采样相位 +
    离散施加点；旧单实例双模三层缺陷（粗糙 tick 非独立演化/校准空操作/读数遮蔽）
    与四条用户要求的逐条落地
  - **验证套件适配**：ModeAB 重构为双实例语义（tick 先行 + 独立 tickPhys +
    三轴速度校准）、分叉兜底锚定回归测试、帧信号驱动测试（worker_threads 真线程）
- **传送双路径检测（5dcb903，共享 phys/teleport.rs）**：A 路径 = 进入区域任意状态
  （身体竖直线段与凸包区间相交，gap = 落地&&斜面 ? 64 : 0）+ B 路径 = 仅落地
  （脚底往下 8 区间相交）；surfing 滑行不触发；冷却 0.5s；空中蹲视角渐变同步
- **共享 TS 层收敛（0f3558b）**：`src/ts-shared/`（auth/{shared-state,auth-loop,
  worker-dispatch}、input/input-layer、phys/{authority-calibrator,params,
  world-builder}）——两端共用 SAB 输入槽（BigInt64 原子累加）与权威双缓冲
  （512B）、权威循环（setTimeout 4ms 自驱 + 固定步长 1/tickRate + 累积器无封顶（每轮 ≤64 步 guard））、
  消息分发、校准（三条件 + 250ms 冷却 + 在途回滚）、输入层、参数映射、地图导入
  导出管线；debug/game 删除各自 worker/shared-state.ts 与 physics-loop.ts，
  debug 删除 shell_colliders.rs（薄壳碰撞）与 debug_probe.rs；**LERP/外推插帧
  删除**——渲染改为主线程预测物理直读 state() + 权威速度外推校准
- **面板可用性**：所有数值控件（灵敏度/QE 转速/视距/落地帧数/碰撞倍率/物理参数）
  增加**数字输入框**（step=any 精确输入，滑块步进统一为 1）；**物理模式/碰撞来源/
  PVS 剔除/视距**改为**进入地图前即可设置**（碰撞来源修改后提示"重新加载地图生效"，
  不再需要先进地图再改再重进）
- **碰撞可视化（debug）**：4 独立开关 + 4 距离滑块（显示brush碰撞/显示触发区域/
  显示模型phy碰撞/显示模型可视碰撞；config.debug：showSolids/brushViewDistance/
  showTriggers/triggerViewDistance/showPhy/phyViewDistance/showVis/visViewDistance，
  0=全量）；phy 橙（surfaceprop 存在）/可视网格紫/brush 绿黄红/trigger 青紫灰橙；
  线框**不透明 + depthTest:false**（防透明混合染绿）；phy/vis 独立 Group、
  phyDirty 距离变更立即重建

### 变更

- **仓库结构重组：单一工程 → 双工程 + 共享层**（2026-08-09）
  - `src/` 由原 TS 源码目录改为**共享层**：`websurf-phys`（Rust CS 物理，原
    crates/wasm 物理部分，game 中诞生后上移共享）、`websurf-wasm-core`
    （BSP 解析/GLB/模型/纹理解析，纯 rlib）、`vendor/vmdl`（vendored，单副本）、
    `materials/textures.mtz`（默认纹理包 9448+ 条，三处副本同步）、
    `serve.py`（共享 dev 服务器；BSP 地图位于仓库根 `maps/`，gitignored）
  - `debug/` = **WebSurf-debug**（原全功能主项目迁入）：`crates/wasm/src/`
    仅导出层 `lib.rs`；`src/` TS 全套（app/renderer/worker/world/physics/game/panel）；
    `web/`
  - `game/` = **WebSurf-game**：`crates/wasm/src/` 仅 `lib.rs` 导出层
    （BspProcessor/PhysWorld/画质 API re-export），物理/解析经 path 依赖
    共享层，`[patch.crates-io]` → `../src/vendor/vmdl`
  - 旧顶层 `crates/`、`src/*.ts`、`web/`、`pkg/`、`target/` 全部移除
- **材质低清压缩体系（mosaic + MTZ）**（`src/wasm-core/mosaic/`）：
  `encode.rs`（PNG → mosaic v4 字节码）/ `decode.rs`（→ 低清 PNG，2 次幂对齐）/
  `manifest.rs`（BSP 纹理收集 + 缺失列表）/ `mtz.rs`（textures.json ↔ MTZ5/6
  压缩容器）；`export_mosaic_manifest` / `export_missing_textures` 须在
  `export_glb*` 之前调用（借用 vs take 时序约定）
- **画质切换**（debug + game 共有）：运行时按 manifest 用 `mosaic_decode`
  还原低清贴图替换；缺失纹理回退在 GLB 导出期完成（`with_defaults` +
  默认纹理包），渲染端零后期处理（曾引发 `RESULT_CODE_HUNG` 的修复）
- **打包双模式**：`build-dist.mjs [--multi]`——`single`（默认）单文件 IIFE
  （WASM + Worker 代码 + 默认纹理包全 base64 内嵌，file:// 双击可玩）；
  `multi` 多文件 ESM（WASM/MTZ 外置，HTTP/Pages 部署）；注入全局：
  `__VBSP_WASM_B64__` / `__VBSP_WORKER_JS__` / `__VBSP_TEXTURES_MTZ_B64__` /
  `__VBSP_WASM_URL__`（multi）
- **CI（deploy-pages.yml）**：debug、game 均以 `--multi` 构建 → 组装
  `deploy/{debug,game}` + 入口页 → GitHub Pages 部署
- **文档重组**：`docs/` 新四篇（architecture / timing-debug / timing-game /
  materials）替换旧 `bsp-architecture` / `bsp-export-status` / `project-overview`
  / `项目时序图`；`game/docs/` 新四篇（overview / physics / panel / materials）
  替换旧实现状态文档
- 共享内存布局（0f3558b 后）：输入区为 BigInt64 `dxAcc/dyAcc` 原子累加槽 +
  权威帧双缓冲（`SHARED_BUFFER_SIZE` 512B，V_A 代际，无锁协议）
- 重建 WASM：pkg 补全模型三角形碰撞导出 API（`export_model_tri_colliders` /
  `export_model_phy_colliders`），`colliderSource`（auto/visual/phy）路径真正生效
  （薄壳 brush 兜底已整体移除，导出失败回退可视网格）
- **移除 test/game（2026-08-19）**：`test/game/`（WebSurf-game 修复版自包含移植）
  整体移除（git rm，历史保留）；关联清理：CI（deploy-pages.yml）移除其构建与
  `deploy/test/game` 组装、Pages 入口页（debug/scripts/pages-index.html）移除
  Test/Game Fixes 入口、GitHub Issue/PR 模板与 README / docs/architecture 同步更新；
  同提交一并移除根目录 `git-sync-ref.sh`（d55593a 引入的本机 packed-refs
  tracking-ref 修复脚本，仅开发环境使用，未入文档）

### 修复

- **viewer 渲染方法与 game 对齐（2026-09-05）**：修复"部分场景渲染不全"——三处根因：
  1. **分块合并丢几何（主因）**：`optimizeScene` 最终合并失败（GLB 内 indexed/
     non-indexed 几何混合致 `mergeGeometries` 属性不兼容）时，兜底分支只保留
     第一块、该 cell 其余几何静默丢弃 → 高空俯瞰大面积镂空（surf_null 实测
     60 个 cell 受影响）。对齐 game 兜底：失败时全部单独保留（零丢失）。
  2. **雾 + 远平面截断**：原 `Fog(bg, far*0.4, far*0.9)` + far 钳制 65536——
     大地图远景被雾吞掉、超大地图（对角 > 32768）被 far 整体裁掉。对齐 game：
     无雾，far = maxDim × 100（基本无远裁剪）。
  3. **贴墙近平面裁剪**：原固定 near=1，自由飞行贴近几何时被近平面裁剪透视。
     移植 game `updateNearPlane`（每 2 帧 6 方向探测——4 水平 + 查看器补垂直
     两向，near = 最近距离 × 0.3、下限 0.05，空旷恢复 maxDim/1000 默认）；
     灯光同步 game 三点光（ambient 0.6 + hemisphere + directional 0xfff4e0）。
  4. `optimizeScene` 遍历范围从整个 scene 收敛到 BSP 模型子树（与 game 一致，
     防回放轨迹/量测辅助对象被误合并进地图块）。
  验证：headless Edge 加载 surf_null.bsp 截图 A/B（高空镂空 → 完整）、CDP 冒烟
  全过、typecheck 过；`app.js`/`dist` 已重建。
- **P2 坡顶幻影根治（7c33a58 / 4f11e5a / 0b08a61，2026-08-19~20）**：盒-AABB
  碰撞必要性校验（进入/start_solid 门 + f_true + EPS 收紧）消除坡顶幻影碰撞；
  随后 docs+verify 实证残余发散为地面物理固有速率依赖（非幻影）；
  补 f_true 悬停滑行端盖否决单测（4/4 PASS）与 probe2 双速率验证；
  分析与验证脚本见 `docs/chamfer-physics/` 与 `game/scripts/phys-p2-*.mjs`。
- **CI（3618603）**：Pages 流水线修复——Node 20 弃用 + 仓库重构后 lock 文件位置变化导致的构建失败；测试前置改用 Node 20 后，Pages 构建步骤升级
- **地图重载内存泄漏**：`loadScene` 移除旧 BSP 模型只 `remove()` 不 `dispose()`，
  GPU 侧 geometry/material/纹理（含 lightmap atlas）累积导致帧率下降。新增
  `RendererMain.disposeScene()`（递归释放 + renderLists/LOD/PVS/碰撞可视化/插值
  缓存清空），`handleBspFile` 触发文件输入即重置内存，`loadScene` 开头防御调用；
  `ColliderDebug` 新增 `clearAll()`（保留 scene/group 引用），`dispose()` 补 triGroup
- **贴墙透视（近平面裁剪）**：近平面自适应探测距离 `NEAR_PROBE_DIST` 4 → 32——
  相机距墙最小距离 = 碰撞箱半宽 16，原射线 far=4 永远探测不到面前的墙，贴墙时
  near 保持默认大值（大地图 50+）→ 墙被近平面裁剪，透视看到地图外面。已与上游
  cs-movement 逐项核对（碰撞箱 16/72/54、眼睛 64.09/46.04、DIST_EPSILON、brush
  碰撞逻辑全一致），物理层无差异，纯渲染层 bug
  - **垂直墙增强**：探测方向最终 **4 条**（4 水平正交）、探测距离 **100**、
    收缩系数默认 **0.3**（near = 最近距离 × 0.3，更保守不易裁墙）
  - **面板可调（实时生效）**：显示设置新增「近平面探测距离」「近平面收缩系数」
    滑块 + 输入框，`RendererMain.setNearParams()` 下一帧生效，无需重载地图

- **出生点下拉无反应**（select 重选当前值/部分浏览器只触发 input 不触发 change）：
  input + change 双监听 + 去重（换地图重置去重索引）；解析失败 status 可见提示

- **game/ 双端同步**（websurf-min 预测 + 权威双线架构）：
  - 近平面自适应全套同步（6 方向探测 + 面板实时可调 + 默认 100/0.3）
  - spawnSelect/respawnBtn 改走 `bridge.sendTeleport/sendRespawn` 双端同步
    （此前直接调 renderer 绕过 Worker 权威物理 → 传送被权威帧 >200 兜底拉回）
  - **`set-spawn-points` 消息**：出生点列表同步到 Worker 权威物理（此前只设
    预测物理，权威侧 `teleport_to_spawn` 索引为空静默忽略 → "一瞬间传送过去
    又被拉回"根因）

- **兜底同步方向反转 + 条件化（game）**：原"位置差 >200 无条件权威覆盖渲染"；
  反转方向为**渲染主线（144Hz 精度更高）→ 权威追平**，同步内容 = 渲染帧完整
  状态（位置/角度/速度/着地/眼高），同步瞬间清双端未消费输入增量（主线程
  pending + Worker `resetInput`，键位保留）。触发三条件 OR：
  ① 位置差 > 500 → 强制同步（不看朝向）；② 位置差 > 300 且 yaw 最小角差 ≤3°
  且水平转动方向相同；③ 位置差 ≤ 300 但 yaw 偏差 > 45°（视角大幅分叉）。
  **250ms 冷却**防抖；**撤回机制**：同步在途再次大幅分叉（>500 或 yaw>45°）
  视为"渲染为准"方向错误 → 以权威为准回滚渲染（撤销推错影响）

- **传送触发（共享物理 teleport.rs，2026-08-09 最终版）**：A 路径（任意状态）
  竖直线段 [脚底, 脚底+身高] 与凸包区间相交（XZ 凸包竖直平面约束；gap =
  落地 && 斜面 ? 64 : 0——跨斜面 origin 提升；空中/平面 0）+ B 路径（仅落地，
  脚底往下 8 单位区间相交）；surfing 滑行不触发；冷却 0.5s。历史方案（StartTouch
  边沿/竖直射线/凸包顶点/AABB/投影）全部废弃

- **sv_airaccelerate 100 → 150**（KZ/HNS 服务器值；主项目 config + game Rust）

- **面板偏好持久化 + 准星风格化**（双项目）：
  - game `vbsp:panelPrefs`：物理参数/体型/操作（灵敏度/QE/noclip 速度）/
    显示（准星/速度面板模式/准星风格）刷新恢复；构造加载 → 控件回写 → 双端推送
  - 主项目 `vbsp:uiPrefs`：input/hud（含准星）/debug/lod/player 子集
  - 准星重构为 **CSS 变量驱动 4 线 + 中心点**：颜色/线长/粗细/中心间隙/描边/
    中心点 面板可调，即时生效 + 持久化

- **斜坡接缝卡零速**（surf 高速滑行在垂直转横线折角带/密集接缝处速度归零）：
  - `TryPlayerMove` 振荡检测宽容化：剪裁后速度反向不再整体归零，保留沿最后撞击
    平面的切向速度（Quake 风格沿墙滑动）；多平面（≥2）沿前两平面交线滑动
  - 多平面围角（≥3 平面）优先用平均法线剪裁（等效接缝平滑），失败才回退归零
  - `MAX_CLIP_PLANES` 5 → 8（密集接缝区一 tick 触及多平面的容忍度）
  - **撞击后沿法线推开 `PUSH_OUT=0.1`**（贴面解死锁）：surf 滑行时 AABB 表面停在
    距坡面 DIST_EPSILON 处，重力每 tick 注入垂直分量 → trace fraction≈0 微撞击 →
    origin 不更新（移动量≈0）→ `blocked×3` 误判归零；推开使下一 tick 有正常
    "进入距离"，切向滑行不再被 fraction≈0 吞掉（Source/Quake 的 hitpos 惯例）
  - `BlockedMove` 冻结检测阈值 3 → 6（给推开收敛时间，减少误判）
  - **夹缝特殊逻辑**：检测到相对平面（V 形槽/墙缝，法线 dot < -0.5）时不再推开
    （推开会来回撞墙、前后都卡死），改为沿两平面交线滑出夹缝
  - **速度骤降校验**：未归零但大幅减速（空中 + 撞击接触 + 降幅 >30%）记录
    `slowdown-XX% c[法线@fraction...]` 诊断——HUD 显示减速来源（多平面剪裁/
    夹缝转向），便于针对性修复
  - **归零诊断**：归零路径记录原因（allSolid/planes≥8/cornered×N/blocked×6/
    stuck×N），经 stats 回传，HUD 显示"卡因[xxx]"（**注：该诊断 HUD 已随
    0f3558b 移除**，代码无 zeroCause）

## [0.1.0] - 2026-08-05

### 新增

- 初始版本：BSP 解析、CS 移动物理、Three.js 渲染
