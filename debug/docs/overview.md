# debug 工程总览（WebSurf Debug Build）

> 本文是 debug 工程的**整体架构**篇（维度 A）。核心时序见 [sequences.md](sequences.md)，分模块实现见 [implementation/](implementation/loading-pipeline.md)，与 game/viewer/test 的取舍差异见 [differences.md](differences.md)。仓库级架构与共享层（phys / wasm-core / ts-shared / materials）见根文档 [docs/architecture.md](../../docs/architecture.md)、[docs/ts-shared.md](../../docs/ts-shared.md)。

## 1. 定位

debug 是五个工程中的**权威帧计算器 + 调试工作台**：加载任意 VBSP 地图，在浏览器里以「主线程渲染物理线 + Worker 权威物理线」双线模拟运行，并围绕这套双线架构提供物理参数面板、碰撞体可视化、准星平面检查、近平面自适应等调试工具，外加一个计时挑战状态机（检查点/死亡回退）。它与 game 工程共享同一套物理内核与 TS 共享层，但面向"调参、查碰撞、验时序"，而非"玩游戏"（差异见 [differences.md](differences.md)）。

- 运行形态：本地 `npm run dev`（`python ../src/serve.py 8080 .`，COOP/COEP 开启 SharedArrayBuffer）或 `npm run build:dist` 产出 `dist/`（single 模式 file:// 双击可用 / multi 模式 HTTP 部署）（`debug/package.json` scripts；`debug/scripts/build-dist.mjs:1-14`）。
- 定位佐证：Worker 头注自称「权威帧计算器（公共化版）」（`debug/src/worker/main.ts:1-16`）；渲染器头注「主线程渲染器（阶段 1：主线程解析/物理接管）」（`debug/src/renderer/renderer-main.ts:1-7`）。

## 2. 入口链与构建产物

| 环节 | 文件 | 说明 |
|---|---|---|
| 页面入口 | `debug/web/index.html:621` | `<script type="module" src="./app.js">`；布局 = `#topbar` + `#main{#sidebar, #preview canvas}`（`index.html:280-290,586`） |
| 主线程 bundle | `debug/src/app.ts` → `debug/web/app.js` | esbuild bundle：`npm run build:app`（`package.json` scripts） |
| Worker bundle | `debug/src/worker/main.ts` → `debug/web/worker.js` | `npm run build:worker`，ESM、target es2022 |
| WASM 产物 | `debug/pkg/websurf_wasm.js` + `websurf_wasm_bg.wasm` | `npm run build:wasm`：`wasm-pack build --release --target web --out-dir ../../pkg` |
| dist 双模式 | `debug/scripts/build-dist.mjs` | single（默认）：classic script + IIFE，WASM/Worker/纹理包全部 base64 内嵌，file:// 双击可用；multi（`--multi`）：module script + 外置 wasm/mtz，供 HTTP 部署（`build-dist.mjs:1-14`） |
| API 契约检查 | `debug/scripts/check-wasm-api.mjs` | 构建期比对 `pkg/websurf_wasm.js` 导出符号与 TS 导入符号，要求 100% 匹配（`check-wasm-api.mjs:1-9`）；`npm run check:api` |
| 类型检查 | `tsc --noEmit` | `npm run typecheck` |

注意：`package.json` 原有的 `verify:chamfer` 入口已删除（曾指向当时不存在的 `scripts/verify-chamfer.mjs`，空引用）；`debug/scripts/` 内现仅 `build-dist.mjs`、`check-wasm-api.mjs`、两个 .cmd、`pages-index.html`。

## 3. 整体架构：两阶段权威帧计算器

debug 的运行时由**两条物理线 + 一条状态通道**构成（v7 架构定案，代码见 `debug/src/renderer/renderer-main.ts:1-7` 头注与 `src/ts-shared/auth/shared-state.ts:1-32`）：

```
┌─ 主线程（渲染预测线）────────────────────────────┐
│ app.ts 装配/加载/输入循环/HUD                      │
│ renderer-main.ts: rAF tick                        │
│   ① addInput 写 SAB 输入槽                        │
│   ② correctFromAuthority（只读权威帧）             │
│   ③ calibrateVelocity（权威速度外推校准）           │
│   ④ predPhys.tick（主线程 PhysWorld 全速推进）      │
│   ⑤ consumePhysEvents（teleport/death 事件）       │
│   ⑥ 按 state() 设相机 → LOD/PVS → 渲染            │
└──────────────┬───────────────────────────────────┘
               │ SharedArrayBuffer 512B（COOP/COEP）
               │   或 postMessage 回退（MsgState）
┌──────────────▼───────────────────────────────────┐
│ Worker（权威帧计算器）                             │
│ auth-loop: setTimeout 4ms + 固定步长累积器(64Hz)   │
│   takeInput → phys.tick → writeAuthoritative      │
│   land/blocked 碰撞事件 postMessage 回传           │
│ physics-worker: 物理面板参数管理（debug 特有）       │
└───────────────────────────────────────────────────┘
```

- **主线程持有第二个 `PhysWorld` 实例**（渲染物理线，随渲染帧率全速 tick），Worker 持权威实例（固定 64Hz 步长）。两个实例来自同一个 WASM 模块（`debug/src/renderer/renderer-main.ts:14-15` 注释；`main-wasm.ts` ensureMainWasm）。
- **Worker 只被"读取"，不被反写**：主线程每帧读权威帧做速度外推校准；大偏差异常时反过来把渲染主线全状态推给 Worker（`sync-render-state` 消息），见 `src/ts-shared/phys/authority-calibrator.ts:1-15` 与 [sequences.md §3](sequences.md)。
- **输入同源**：鼠标/键盘在主线程合成（灵敏度在输入层乘入，物理两端 `sensitivity` 固定 1），写入 SAB 输入槽后双线消费同一份输入 → 角度天然不分叉（`src/ts-shared/input/input-layer.ts:1-10`、`src/ts-shared/phys/params.ts:57-59`）。

### 3.1 模块划分（debug/src）

| 目录/文件 | 行数 | 职责 | 细分文档 |
|---|---|---|---|
| `app.ts` | 1814 | 主入口：main() 装配、handleLoadBsp 编排、输入循环（rAF）、UI 绑定、物理面板消息处理、计时挑战接线 | [loading-pipeline](implementation/loading-pipeline.md)、[physics-panel](implementation/physics-panel.md)、[sequences](sequences.md) |
| `config.ts` | 249 | `RuntimeConfig` **11 段**运行时配置（physics/player/movement/smoothing/teleport/lod/lighting/input/hud/debug/texture）与 `applyConfigPatch` | 本文 §5 |
| `main-wasm.ts` | 45 | 主线程 WASM 懒初始化（内嵌 `__VBSP_WASM_B64__` → `initSync`，否则 fetch pkg）；导出 `mosaic_decode`/`decompress_mtz` | [loading-pipeline](implementation/loading-pipeline.md) |
| `default-pack.ts` | 43 | 默认纹理包 `textures.mtz` 加载（内嵌 base64 或 fetch），供缺失纹理比对 | [loading-pipeline](implementation/loading-pipeline.md) |
| `worker/main.ts` | 120 | Worker 入口：装配 ts-shared auth-loop + worker-dispatch，注入 debug 特有钩子（ready 回执、mtz 存取、面板消息） | [physics-panel](implementation/physics-panel.md)、[sequences](sequences.md) |
| `worker/physics-worker.ts` | 114 | Worker 侧物理面板协调器：set_params/set_hull 应用 + physics-snapshot 回传 | [physics-panel](implementation/physics-panel.md) |
| `worker/worker-types.ts` | 342 | 主线程↔Worker 消息类型全集（MainMessage/WorkerMessage/SceneDataMessage/PlaneInfo 等） | [physics-panel](implementation/physics-panel.md) |
| `worker/mtz-data.ts` | 19 | single 打包模式 Worker 侧内嵌 mtz base64 存取（`__VBSP_TEXTURES_MTZ_B64__`） | [loading-pipeline](implementation/loading-pipeline.md) |
| `renderer/renderer-main.ts` | 1023 | 主线程渲染器 + 渲染物理线：rAF tick、GLB 场景装载、近平面自适应、纹理画质切换、权威校准接线 | [rendering](implementation/rendering.md) |
| `renderer/camera-controller.ts` | 82 | yaw/pitch → quaternion（YXZ、pitch clamp、yaw 归一化） | [rendering](implementation/rendering.md) |
| `renderer/lod-manager.ts` | 356 | 2 级 LOD + 视距剔除 + PVS + hysteresis（0.85） | [rendering](implementation/rendering.md) |
| `renderer/collider-debug.ts` | 1087 | 碰撞体可视化：brush 凸包线框三色分类、chamfer 高亮、.phy/可视网格三角形线框、触发器四色 | [rendering](implementation/rendering.md) |
| `renderer/plane-inspector.ts` | 376 | 准星射线检测（mesh > solid > ladder > trigger，每 6 帧限频，8192 HU） | [rendering](implementation/rendering.md) |
| `renderer/light-manager.ts` | 390 | 基础三灯（Ambient/Hemisphere/Directional 球坐标）；8 个 PointLight 池预留（当前无调用方接线，见 [rendering §4](implementation/rendering.md)） | [rendering](implementation/rendering.md) |
| `renderer/lightmap-shader.ts` | 224 | RGBExp32 lightmap 解码着色器注入（onBeforeCompile + 手动双线性） | [rendering](implementation/rendering.md) |
| `renderer/fog-manager.ts` | 102 | 线性雾动态 near/far（随相机-场景中心距离外推） | [rendering](implementation/rendering.md) |
| `world/collider-adapter.ts` | 287 | 碰撞体反腐败层：WasmBrush JSON → cs-movement `Brush[]`/`LadderVolume[]`（法线翻转已在 Rust 端完成） | [loading-pipeline](implementation/loading-pipeline.md) |
| `world/pvs-manager.ts` | 281 | PVS 位图解码 + findLeaf + isVisible（仅 cluster 变化重算） | [rendering](implementation/rendering.md) |
| `world/teleport-manager.ts` | 333 | 传送触发器元数据（trigger/dest/链接/凸包平面）；`checkTeleport` 在 debug 无调用方（物理权威在 Rust 侧） | [loading-pipeline](implementation/loading-pipeline.md) |
| `world/custom-teleports.ts` | 98 | 自定义传送点：localStorage 按地图分组（`vbsp:customTeleports:<map>`），上限 50 | [physics-panel](implementation/physics-panel.md) |
| `world/spawn-loader.ts` | 128 | 出生点解析——**未接线预留工具**（全仓无 import，文件头自述"出生点实际加载走 ts-shared world-builder 管线"，`spawn-loader.ts:8-11`） | [loading-pipeline](implementation/loading-pipeline.md) |
| `world/types.ts` | 231 | WASM 导出 JSON 的完整 TS 契约（brush/spawn/teleport/PVS/metadata/ColliderFilter） | [loading-pipeline](implementation/loading-pipeline.md) |
| `game-state.ts` | 191 | 计时挑战状态机：idle→running→finished、检查点去重、死亡回退 | [sequences §6](sequences.md) |
| `physics/param-defs.ts` | 108 | 物理面板参数定义表（13 项 PARAM_DEFS，默认值=Rust `PhysParams::default()`） | [physics-panel](implementation/physics-panel.md) |
| `physics/physics-params.ts` | 163 | 参数管理器：applyOverride/归一化/tickRate 变更回调；`PARAM_TO_RUST` 映射 | [physics-panel](implementation/physics-panel.md) |
| `physics/math/vec3.ts`、`physics/physics/Collision/Collision.types.ts` | 101/49 | 平面/凸包碰撞类型与零分配 Vec3（collider-debug/plane-inspector/collider-adapter 消费；源自 @unsurf/cs-movement 约定） | [rendering](implementation/rendering.md) |
| `input/`（input-bridge/keyboard/mouse-buffer/pointer-lock） | 93/108/128/154 | 输入四件套：低频控制消息桥、键位捕获、鼠标增量缓冲（CLAMP 不丢弃 + discardNext）、指针锁定（unadjustedMovement 降级） | [sequences §2](sequences.md) |

### 3.2 WASM 导出层（debug/crates/wasm）

- crate 名 `websurf-wasm`（与 game/viewer/test 同名约束见根 [docs/architecture.md](../../docs/architecture.md)），依赖共享层 `websurf-phys`（`path = "../../../src"`）与 `websurf-wasm-core`（`path = "../../../src/wasm-core"`）（`debug/crates/wasm/Cargo.toml:20-24`）。
- `lib.rs:22`：`pub use websurf_phys::phys::PhysWorld;` —— 物理世界本体来自共享层（21 个导出方法，见 [docs/phys.md](../../docs/phys.md)），debug crate 自身只做解析/导出绑定。
- `BspProcessor` 全导出集：`metadata`、`parse_spawn_points`、`parse_teleports`、`parse_pvs_data`、`export_brushes_planes(filter)`、`export_model_tri_colliders`、`export_model_phy_colliders`、`export_mosaic_manifest`、`export_missing_textures`、`export_glb_with_pakfile_models(_with_defaults)` 等（`debug/crates/wasm/src/lib.rs:293-2274` 方法清单）。
- 工具函数：`mosaic_encode/mosaic_decode`、`decompress_mtz`、`decode_vtf_to_png`、`export_visleaf_pvs`（`lib.rs:2981-3204`）。
- debug 特有绑定：`export_brushes_planes` 内运行时生成**棱边 chamfer 平面**（AddEdgeBevels 简化版，法线=两相邻面法线归一化均值，必须位于凸包外侧；`lib.rs:2551-2690`），既进物理碰撞也供调试线框——详见 [rendering §6](implementation/rendering.md)。game crate 携带同款实现（`game/crates/wasm/src/lib.rs:1973`），共享 wasm-core 不含。

## 4. 消息协议与状态通道

- 消息类型全集定义在 `debug/src/worker/worker-types.ts`（MainMessage 15 种 / WorkerMessage 8 种）。共享部分（init/wasm-init/world-json/config/respawn/teleport/…）由 ts-shared `worker-dispatch.ts` 统一分发；debug 特有消息（物理面板 5 种：`set-physics-param`/`reset-physics-param`/`set-hull`/`reset-hull`/`set-auto-restore-hull`）经 `onExtraMessage` 扩展点注入（`src/ts-shared/auth/worker-dispatch.ts:32-41`）。
- 状态通道：`crossOriginIsolated`（`src/serve.py` 返回 COOP/COEP 头）时用 `SharedArrayBuffer(512)` + Atomics；否则 postMessage 回退（MsgState），接口统一（`debug/src/app.ts:197-204`、`src/ts-shared/auth/shared-state.ts:344-356`）。SAB 512B 布局（控制区/输入槽/权威帧双缓冲每帧 10 值定点缩放）见 [docs/ts-shared.md](../../docs/ts-shared.md)。
- Worker 头两条消息顺序有契约：`wasm-init` 必须先于 `world-json`（world-json 早于 wasm-init 就绪会被忽略，`src/ts-shared/auth/worker-dispatch.ts:45-47`）；debug 在 main() 里先行 postMessage `wasm-init`（`app.ts:221-234`）。

## 5. 配置与参数体系

- `RuntimeConfig` 共 **11 段**：physics / player / movement / smoothing / teleport / lod / lighting / input / hud / debug / texture（`debug/src/config.ts:16-249`）。主线程加载后经 `syncFullConfig` 把其中 **10 段**（不含 texture——纹理画质是渲染本地的，`app.ts:1768-1789`）逐段发给 Worker，Worker 用 `applyConfigPatch` 更新自己的 config 副本。
- 关键默认值（`config.ts` DEFAULT_CONFIG）：gravity 800 / jumpSpeed 302 / maxSpeed 250 / friction 4 / accelerate 10 / airAccel 150 / stopSpeed 100 / tickRate 64 / teleportGateTicks 3 / hull 半宽 16、站高 72、蹲高 54 / cullDistance 12800 / sensitivity 1.5 / pitchLimit 89 / yawBindSpeed 210 / noclipSpeed 800。
- **面板参数 ≠ config**：物理面板另有 13 项 `PARAM_DEFS`（param-defs.ts），经 `set-physics-param` 消息直接打 Rust `set_params`，优先级高于 config 同名段；tickRate 是唯一"JS 驱动层参数"（不进 Rust，改 `authLoop.setFixedDt`）。详见 [physics-panel.md](implementation/physics-panel.md)。
- **双端同参不变量**：主线程 `buildPredictionParams`（`app.ts:1229-1253`）与 Worker `syncParamsToWasm`（`debug/src/worker/main.ts:50-66`）都收敛到 ts-shared `buildPhysicsParams`（walkSpeed 130、crouchSpeed 85、autobhop/bhopSpeedClamp/noPrestrafe true、sensitivity 固定 1），保证双线物理参数逐字段一致。

## 6. 与共享层及其他工程的关系

- **只依赖共享层，不依赖兄弟工程**：debug 的 TS 从 `../../src/ts-shared/*` 导入 7 个模块（shared-state / auth-loop / worker-dispatch / world-builder / params / authority-calibrator / input-layer），Rust 从仓库根 src 引 websurf-phys + websurf-wasm-core；与 game/viewer/test 之间零交叉 import（全仓 grep 验证，见根 [docs/architecture.md](../../docs/architecture.md) 引用矩阵）。
- **对 ts-shared 的 debug 特有注入**：`onInit`（ready 回执）、`onWasmInit`（mtzB64 存取）、`onWorldBuilt`（physicsWorker.attachWorld）、`onConfigApplied`（面板参数重应用）、`onExtraMessage`（5 种面板消息）——game 侧全部不使用（`debug/src/worker/main.ts:80-119` vs `game/src/worker/main.ts:80-93`）。
- **viewer / test 工程不共享本套时序**：viewer 无物理（薄导出三方法）；test/dual-mode-harness 用独立的 192B TestShared 协议（与 ts-shared 512B 不是同一套）。对照细节在 [differences.md](differences.md) §5。

## 7. 阅读路径

1. 先读本文与 [sequences.md](sequences.md)（启动、双线 tick、加载、面板四条主时序）。
2. 按需进入实现篇：[loading-pipeline.md](implementation/loading-pipeline.md)（地图怎么变成场景+两个物理世界）、[rendering.md](implementation/rendering.md)（渲染与调试可视化）、[physics-panel.md](implementation/physics-panel.md)（参数面板全链路）。
3. 对照阅读 [differences.md](differences.md) 理解 debug 与 game 的取舍。
4. 协议与算法细节下探到根文档：[docs/ts-shared.md](../../docs/ts-shared.md)（SAB 布局/权威循环/校准器）、[docs/phys.md](../../docs/phys.md)（Rust 物理内核）、[docs/wasm-core.md](../../docs/wasm-core.md)（BSP 解析/GLB 导出）、[docs/materials.md](../../docs/materials.md)（mtz/mosaic 材质体系）。
