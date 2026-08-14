# WebSurf 整体架构

> 最后核对：2026-08-14。以实际代码为准（共享层 `src/` + 双工程 `debug/`、`game/` + 验证工程 `test/dual-mode-harness/`）。

浏览器中的 Counter-Strike 滑翔（Surf）地图游玩器：BSP 解析（Rust/WASM）+ CS 移动物理 + Three.js 渲染。

仓库由**两个同级独立工程**（各自完整前端与打包链，互不引用）、一个**共享层**（仓库根 `src/`）与一个**测试合集**（`test/`，不入 Pages 部署）组成；
`test/` 内含验证工程 `test/dual-mode-harness/`。（注：2026-08-14 地图最小导出实验 map-min-export 的验证结论——v20 与 v21 共用 lump 布局——已合并进共享层 vbsp：版本检查放宽至 v19~v29 + sprp v11 静态道具支持，实验工程随之移除。）
文档地图：公共架构见本文；两端时序见 `docs/timing-debug.md`（debug）、`docs/timing-game.md`（game）；
公共材质技术（mosaic 低清压缩 / MTZ 打包 / 默认纹理包）见 `docs/materials.md`；
各工程特色功能见 `debug/docs/`、`game/docs/`；验证工程见 `test/dual-mode-harness/README.md` + `test/dual-mode-harness/CONCLUSION.md`。

---

## 1. 仓库布局

```
websurf/
├── maps/                      BSP 地图资源（*.bsp，gitignored，本地存放；根 `maps/` 与 `game/maps/` 各有一份副本，`src/maps/` 不存在）
├── src/                      ← 共享层（3 个独立 Rust workspace + TS 共享 + 资源）
│   ├── Cargo.toml + phys/       websurf-phys：Rust 物理（wasm-bindgen 绑定层）
│   ├── wasm-core/               websurf-wasm-core：BSP 解析 / GLB / 模型 / 纹理 / mosaic / mtz（纯 rlib）
│   ├── ts-shared/               TS 物理渲染共享（auth/shared-state、auth-loop、worker-dispatch、
│   │                            authority-calibrator、input-layer、params、world-builder、
│   │                            trace/trace-types、trace-recorder、trace-renderer）
│   ├── materials/textures.mtz   默认纹理包（公共资源，MTZ6 压缩，9448+ 条，三处副本同步）
│   ├── vendor/vmdl/             vendored vmdl（VTX 条带展开修复，单副本）
│   └── serve.py                 共享开发服务器（COOP/COEP + CORS + WASM MIME；注：game/serve.py
│                                为被跟踪的陈旧重复副本，兼容遗留用途，内容与本文件不同）
├── debug/                    WebSurf-debug（Debug Build）：全功能调试测试页面
│   ├── crates/wasm/src/         lib.rs（导出层，唯一文件）
│   ├── src/                     TS：app/renderer/worker/world/physics(参数)/game + main-wasm/default-pack
│   └── web/                     dev 页面（index.html + 构建产物）
├── game/                      WebSurf-game（Game Build）：最小化游戏化实现
│   ├── crates/wasm/src/         lib.rs（导出层，唯一文件）
│   ├── src/                     TS：app/renderer/worker/panel/input/world
│   └── web/                     dev 页面
├── test/                      验证工程（不入 Pages 部署）
│   └── dual-mode-harness/      WebSurf-test（验证工程，2026-08-11 收尾）：双模物理 + 帧信号渲染时序验证
│       ├── crates/wasm/src/      lib.rs（薄导出层：PhysWorld + BspProcessor 最小导出集，无 mosaic/默认包）
│       ├── src/                  TS：main（不做物理/渲染——主线程负责 BSP 解析导出 + 输入转发 + UI）/ shared-state（SAB + 消息回退）/ worker-a（双模物理）/ worker-b（渲染）
│       ├── mini/                 核心链路最小实现（输入 → 物理 → SAB → 插值渲染，与完整版架构一致）
│       └── scripts/              phys-smoke（191/191 PASS）/ perf-bench / race-wakeup / tmp-dual-compare / trace-verify / build-dist（另有已跟踪的临时脚本 _tmp_flicker-debug.mjs）
├── docs/                     仓库级文档（本文 / 两端时序 / 材质技术）
└── .github/workflows/deploy-pages.yml    CI：debug + game 构建 + Pages 部署（test 不入部署）
```

### 三个 Rust workspace 的引用关系（共享层 + 两端 + 验证工程）

| crate | 角色 | 被谁引用 |
|---|---|---|
| `src/`（websurf-phys） | 物理核心 + wasm 绑定（`PhysWorld` 类，19 个 pub 方法，含 `new`） | debug/game/test/dual-mode-harness 的 `crates/wasm`（path 依赖，经 `pub use` re-export 进各自 WASM） |
| `src/wasm-core/`（websurf-wasm-core） | BSP 解析（**v20-v21**，2026-08-14 起支持 CS:GO v21 含 sprp v11 静态道具）/GLB/模型/纹理解析 + mosaic 编解码 + MTZ 容器（纯 rlib，无 wasm 导出） | debug/game/test/dual-mode-harness 的 `crates/wasm`（path 依赖，内部模块直接调用） |
| `src/vendor/vmdl/` | vendored vmdl（patch 到三端 workspace） | 三端（debug/game/test/dual-mode-harness）`[patch.crates-io]` → `../src/vendor/vmdl`（dual-mode-harness 为 `../../src/vendor/vmdl`） |

### 共享层 TS 模块（`src/ts-shared/`，两端 import 共享，改一处双端生效）

| 模块 | 导出 | 说明 |
|---|---|---|
| `auth/shared-state.ts` | ShmState（BigInt64 输入槽 + 权威双缓冲 V_A）/ MsgState 回退 / KEY_MASK / AuthFrame / InputSample / 工厂 | 权威帧共享内存布局与消息回退通道 |
| `auth/auth-loop.ts` | `createAuthLoop`（4ms 自驱 + 固定步长累积器 + land/blocked 碰撞事件，注入 post/onCollisionEvent） | Worker 权威帧计算器主循环 |
| `auth/worker-dispatch.ts` | `createWorkerDispatch`（init/wasm-init/world-json/config/respawn/teleport/teleport-to-pos/set-spawn-points/set-death-threshold/sync-render-state + 扩展点钩子） | Worker 消息分发（两端差异经 onInit/onWorldBuilt/onConfigApplied/onExtraMessage 注入） |
| `phys/authority-calibrator.ts` | `AuthorityCalibrator`（correctFromAuthority 三条件+冷却+回滚 / calibrateVelocity / applyCollisionCorrection / resetTo） | 主线程渲染物理的权威校准 |
| `input/input-layer.ts` | `INPUT_CLAMP` / `M_YAW` / `layerMouseDelta` / `qeEquivalentDx` | 输入层（灵敏度乘入 + Q/E 等效像素） |
| `phys/params.ts` | `buildPhysicsParams`（sensitivity:1、jump_height 换算、全量 snake_case） | 面板参数 → Rust set_params |
| `phys/world-builder.ts` | `buildWorldBundle`（bytes → WorldBundle：colliderSource 三档 + 可视网格回退 + 缺失纹理 + GLB with defaults + onProgress） | 地图导入导出统一管线 |
| `trace/trace-types.ts` | `TracePoint` / `TraceState` / `TRACE_MAX_POINTS` / 消息协议（trace/trace-data/trace-point/trace-clear） | 运动路径采集协议与数据结构（由 test 提升为公共） |
| `trace/trace-recorder.ts` | `TraceRecorder`（setEnabled/tick 节流采样/clear/滚动窗口） | 采集端状态机（物理 Worker 侧，双实例位置采样） |
| `trace/trace-renderer.ts` | `TraceRenderer`（addPoint/clear/dispose，LineFactory 依赖注入） | 显示端（渲染引擎无关，three 适配注入） |

**共享原则**：物理/解析/物理渲染（Rust + TS）单副本——**修改一处，两端编译即同步生效**；各工程
`crates/wasm/src/lib.rs`（wasm 导出层与特色函数）与 TS 前端（面板 UI、调试可视化、计时挑战、渲染层）保持各自。
`test/dual-mode-harness/` 复用同一 `src/phys` + `src/wasm-core`，并**消费 ts-shared 的 trace 公共模块**
（`TraceRecorder`/`TraceRenderer`/`TraceState`，见 `src/ts-shared/trace/`）；其共享状态协议为 test 自研的
SAB 双缓冲 + WAKEUP/RENDER_WAKEUP 布局，见 `test/dual-mode-harness/src/shared-state.ts`。

---

## 2. 数据流总览（地图加载）

```
.bsp 文件（本地选择 / maps/）
  │
  ▼
WASM（BspProcessor——两端均在主线程解析，共用 ts-shared world-builder 管线）
  ├─ parse_spawn_points / parse_teleports / parse_pvs_data   → 出生点/传送点/PVS JSON
  ├─ export_brushes_planes                                   → 地图碰撞 brush JSON
  ├─ export_model_tri_colliders / _phy_colliders             → 模型三角形碰撞 JSON
  ├─ export_mosaic_manifest                                  → 画质切换 manifest（纹理名 → mosaic 字节码）
  ├─ export_missing_textures                                 → 缺失纹理列表
  ├─ export_glb_with_pakfile_models_with_defaults            → GLB（地图几何 + PAKFILE 模型 + 缺失纹理回退）
  └─ PhysWorld.build_world(brushJson, triJson, teleportJson, spawnX/Y/Z, spawnYaw)   → 物理世界（主线程渲染物理）
  │
  ▼
渲染端（three.js，主线程唯一物理渲染线）
  ├─ GLTFLoader 建场景（GLB 自包含：纹理在导出期已定——含默认包回退的低清纹理）
  ├─ PVS/LOD 剔除、lightmap、雾、碰撞可视化
  ├─ 每 rAF：PhysWorld.tick（真实物理）→ 渲染直读 state()
  └─ 画质切换：运行时按 manifest 用 mosaic_decode 还原低清贴图替换
```

**关键时序约定**：
- `export_mosaic_manifest` / `export_missing_textures` 必须在消费 BSP 的 `export_glb*` **之前**调用（借用 vs take）。
- 缺失纹理回退在 **GLB 导出期**完成（`with_defaults`）——渲染端零后期处理，避免中途替换（曾引发 `RESULT_CODE_HUNG`）。
- 两端解析/导出/物理渲染均走共享管线（ts-shared world-builder + Rust 物理）——**地图导入导出与物理逻辑改一处即双端生效**。

---

## 3. 共享层详解

### 3.1 websurf-phys（src/phys/，2,821 行 / 4 文件，2026-08-13 实测）

CS 移动物理的 Rust 实现（原 @unsurf/cs-movement TS 移植，game 中诞生后共享）：

| 文件 | 职责 |
|---|---|
| `mod.rs` | `PhysWorld` wasm 绑定层：`build_world` / `tick` / `predict` / `respawn` / `teleport_to(_spawn)` / `set_spawn_points` / `set_state` / `set_velocity` / `set_yaw_pitch` / `set_death_y` / `set_params` / `set_hull` / `set_noclip` / `state` / `take_event`（`predict` 为历史预留；`teleport_gate_ticks` 参数已无效，check 内不使用，仅保留签名兼容） |
| `world.rs` | 世界碰撞：brush/tri 双空间索引（BrushGrid/TriangleGrid）+ Minkowski 扫掠盒 |
| `player.rs` | 全套 CS 移动语义（WalkMove/AirMove/Accelerate/Friction/Jump/Duck/Ladder/StepMove/StuckCheck…）+ `PhysParams`（19 项可调） |
| `teleport.rs` | 传送检测（A 路径：进入区域任意状态——竖直线段 [脚底,脚底+身高] 与凸包区间相交，gap=落地&&斜面?64:0；B 路径：仅落地，脚底往下 8 区间相交；surfing 滑行不触发；冷却 0.5s）+ 死亡判定（`set_death_y`） |

`build_world` 输入为 JSON 字符串 + 出生点标量（与 BspProcessor 的导出输出**同构**，零转换）：
`brushJson`（WasmBrush[]）、`triJson`（TriMesh[]）、`teleportJson`（{teleports,triggers,links}）+ `spawn_x/y/z` 与 `spawn_yaw`（4 个独立 f64 标量，非 JSON）。

### 3.2 websurf-wasm-core（src/wasm-core/）

| 模块 | 职责 |
|---|---|
| `vbsp/` | BSP 解析（64 lump、Leaves 排序修复、LZMA 支持、displacement 展开） |
| `bsp_to_gltf_core/` | BSP → GLB（`export_bsp` / `export_bsp_with_models`），`ConvertOptions` 含**缺失纹理回退表**（`missing_fallback`） |
| `model_integrator/` | MDL 模型整合（放置/网格/材质） |
| `pakfile_models.rs` | PAKFILE 索引、VMT 解析（`VmtInfo`/`parse_vmt`） |
| `phyfile.rs` | .phy 模型自带碰撞解析 |
| `texture_utils/` | VTF 解码（VTF → PNG） |
| `mosaic/` | 材质低清压缩体系（详见 `docs/materials.md`）：`encode.rs`（PNG → mosaic v4 字节码）、`decode.rs`（字节码 → 低清 PNG，2 次幂对齐）、`manifest.rs`（BSP 纹理收集/缺失列表）、`mtz.rs`（textures.json ↔ MTZ5/6 压缩容器） |

### 3.3 公共资源

| 资源 | 说明 |
|---|---|
| `src/materials/textures.mtz` | 默认纹理包（MTZ6，9448+ 条）：缺失纹理回退与比对的数据源；三处副本同步（src/ + debug/web/ + game/web/），dist 构建自动附带 |
| 根 `maps/`（及 `game/maps/`） | BSP 地图（gitignored，体积大；`src/maps/` 不存在——地图位于仓库根 `maps/` 与 `game/maps/`，均未跟踪） |
| `src/serve.py` | dev 服务器：`python src/serve.py <port> <root>`（root = 工程目录；COOP/COEP → crossOriginIsolated → SAB 可用；注：`game/serve.py` 为陈旧重复副本，内容不同） |

---

## 4. 构建与打包（双模式）

两端共用流程：`npm run build:wasm`（wasm-pack，LTO+opt3，`wasm-opt=false`）→ `npm run build:ts`（tsc + esbuild）→ `node scripts/build-dist.mjs [--multi]`。

| 模式 | 产物 | 用途 |
|---|---|---|
| **single**（默认；debug/game `build-dist.cmd`） | 单文件 IIFE：WASM + Worker 代码 + **默认纹理包**全部 base64 内嵌，classic index.html | 本地双击 file://（无 fetch 能力，全内嵌；无 SAB 自动 MsgState 回退） |
| **multi**（`--multi`） | 多文件 ESM：app.js + worker.js + wasm 外置 + textures.mtz 外置 | GitHub Pages / HTTP 部署（fetch 正常，体积小） |

**运行时内嵌消费约定**（single 模式注入的全局变量）：
- `__VBSP_WASM_B64__`：WASM base64（主线程/Worker 经消息 initSync）
- `__VBSP_WORKER_JS__`：Worker 代码（Blob URL 创建；Blob worker 读不到主线程 global，**数据一律经 postMessage 传递**）
- `__VBSP_TEXTURES_MTZ_B64__`：默认纹理包 base64（主线程直接读；Worker 经 `wasm-init` 消息的 `mtzB64` 字段下发——debug 侧协议兼容保留，权威 Worker 不再消费默认包）
- `__VBSP_WASM_URL__`（仅 debug multi 注入）：WASM 相对路径（`./websurf_wasm_bg.wasm`），无则 dev 默认 `../pkg/websurf_wasm_bg.wasm`。game 不使用该变量——其 dev/multi 的 wasm 路径统一硬编码 `./websurf_wasm_bg.wasm`（build:wasm 复制 wasm 到 web/，dev 与 dist 同构）。

**test/dual-mode-harness 工程**：仅 multi 多文件（5 文件：app/worker-a/worker-b/wasm/index.html），无 single 内嵌模式
（仅 HTTP 运行，SAB 恒定可用）。

**CI（deploy-pages.yml）**：debug + game 均以 `--multi` 构建 → 组装 `deploy/{debug,game}` + 入口页 → Pages 部署（test 不入部署）。

---

## 5. 两端差异一览（详见各自工程 docs）

| 维度 | debug | game |
|---|---|---|
| 定位 | 全功能调试测试页面 | 最小化游戏化实现 |
| 解析/导出/物理渲染 | 主线程（与 game 同模式，共享 ts-shared） | 主线程 |
| 权威帧 Worker | 共享 auth-loop / worker-dispatch（debug 扩展：物理面板参数、mtzB64 内嵌、ready 回执） | 共享 auth-loop / worker-dispatch |
| 面板 | 侧边栏手风琴（HTML 静态 + app.ts 绑定） | ESC 弹出面板（`panel-controller.ts` 七模块 + 键位录制） |
| 特色功能 | 计时挑战、自定义传送点、准星射线、碰撞可视化（4 开关 + 4 距离滑块）、缺失纹理弹窗、调试 API | 键位自定义、noclip、速度面板、tick 锁定预留 |

**两端共有功能**（共享实现，改一处双端生效）：物理（Rust websurf-phys）、地图导入导出（Rust wasm-core + ts-shared world-builder）、物理渲染/权威帧（ts-shared auth 系）、画质切换、缺失纹理回退、双模式打包。

**工程特有**（各自维护）：面板 UI、调试可视化、计时挑战、自定义传送点、渲染层（light/fog/lightmap/camera）、wasm 导出层与特色函数（debug 调试 API 等）。

**验证工程 test/dual-mode-harness/ 定位**：独立验证「输入 → 双模物理 → 帧信号渲染」时序——主线程不做物理/渲染
（负责 BSP 解析导出 + 输入转发 + rAF wake）；
WorkerA 双模（模式A 1ms 无限制真理源 + 模式B 独立 64t 权威速度线，tick 先行 + set_velocity 三轴唯一校准 +
分叉兜底锚定 64）；WorkerB 帧信号驱动渲染（RENDER_WAKEUP = 主线程 rAF，50ms 超时兜底）。详见 `test/dual-mode-harness/README.md`。
