# viewer 核心差异（与 debug / game / test / 共享层）

> 本文回答一个问题：viewer 在五个工程里为什么长这样。全部对照点都来自当前代码
> （`文件:行号` 双侧标注）；共享层实现细节见根文档（[../../docs/index.md](../../docs/index.md)、
> [../../docs/architecture.md](../../docs/architecture.md)，集成任务产出）。
> 总览见 [overview.md](overview.md)。

## 1. 一句话定位差异

| 工程 | 一句话 | 视角 |
|---|---|---|
| viewer | **看**：BSP 地图游览 + 录像回放，无物理 | 自由飞行相机 |
| game | **玩**：计时挑战玩法，主线程物理 + 权威权威帧双线 | 第一人称受控 |
| debug | **调**：物理调参 / 碰撞 / 传送 / PVS / 画质可视化 | 多面板调试台 |
| test/dual-mode-harness | **验**：同一物理双运行模式（主线程/Worker）对照 | 测试台 |

（四工程 TS 侧互不 import，`grep from ".../../(debug|game|viewer|test)/"` 于各 src 为空——见大纲 §1 的验证记录。）

## 2. 物理与并发模型：无物理、单线程、无 SAB

| 维度 | viewer | debug / game |
|---|---|---|
| Rust 依赖 | 仅 `websurf-wasm-core`（`viewer/crates/wasm/Cargo.toml:18-19`）；头注自证"不含 websurf-phys（无物理）"（`viewer/crates/wasm/Cargo.toml:3-5`） | `websurf-phys = { path = "../../../src" }` + re-export `pub use websurf_phys::phys::PhysWorld`（`debug/crates/wasm/Cargo.toml:21-22` + `debug/crates/wasm/src/lib.rs:22`；game 同款 `game/crates/wasm/Cargo.toml:21-22` + `game/crates/wasm/src/lib.rs:23`） |
| WASM 导出面 | `grep 'pub fn'` 实测 **4**（构造 + metadata/spawn/GLB 三方法，`viewer/crates/wasm/src/lib.rs:273-465`） | debug **29** / game **18**（同口径 grep，含 tick/predict/respawn/teleport/pvs/mosaic 等） |
| SharedArrayBuffer / Atomics | **无**（grep `viewer/src viewer/crates` → 空） | debug/game 的 app.ts / input / worker-types 均引用（`grep -l SharedArrayBuffer debug/src game/src` → `debug/src/app.ts`、`debug/src/input/input-bridge.ts`、`game/src/app.ts`、`game/src/worker/worker-types.ts` 等） |
| Worker | 唯一一个：**录像解析 Worker**（`viewer/src/worker/parse-worker.ts:1-6`），且可失效回退主线程（`importer.ts:104-107`） | 权威物理 Worker + 主线程双线（`game/src/worker/`、ts-shared `auth-loop/worker-dispatch`） |
| 渲染循环 | 单线程 `requestAnimationFrame`，每帧「主时钟 → 相机 → 可视化 → render」（`app.ts:447-483`） | 物理 tick 与渲染解耦的双线时序 |

推论：viewer 的"每帧确定性"只取决于录像 Clip 本身——回放不重演物理，**断网/慢机也不会跑歪轨迹**。

## 3. TS 侧依赖：不引 ts-shared

- `grep ts-shared viewer/src` → 仅一条注释提及（`viewer/src/core/pose.ts:11`"与 ts-shared bspYawToCsYaw 一致"），**零 import**。
- debug/game 各引 7 个 ts-shared 模块（auth×3 / phys×3 / input×1；`grep "from '.*ts-shared'" debug/src game/src` 实测：`shared-state`、`worker-dispatch`、`auth-loop`、`world-builder`、`params`、`authority-calibrator`、`input-layer`）。
- 为什么 viewer 不需要：它没有物理状态要同步、没有权威帧要校准、没有键位掩码要打包——自由飞行相机自己就是输入终点（`fly.ts:57-105`）。同值的常量（EYE_STAND 64.09）选择**复制并注释对齐**而不是跨工程 import（`constants.ts:6-7`，值源 `src/phys/player.rs:34`）。

## 4. 渲染对齐与刻意的差异

| 项 | viewer | game（对照面） | 性质 |
|---|---|---|---|
| 三点光 | Ambient 0.6 + Hemisphere + Directional（`scene.ts:78-83`） | 同组合（game `renderer-main`） | **有意对齐**（注释自证） |
| far | `maxDim × 100`（`scene.ts:165`、`constants.ts:14-15`） | 同法 | 有意对齐 |
| 近平面自适应 | 6 方向（前/后/左/右/**上/下**，`scene.ts:169-233`） | 4 水平方向（`game/src/renderer/renderer-main.ts:381-424`） | **刻意分叉**：viewer 自由飞行会贴地/贴顶，补垂直两向（`scene.ts:170-172` 注释自证） |
| 几何合并失败兜底 | 最终合并失败 → 全部单独保留（`scene.ts:364-370`） | 同策略（"只留第一块会把该 cell 其余几何静默丢掉"，注释注明"与 game 同法"） | 有意对齐（修渲染不全根因） |
| resetRootRotations | 同法清 GLB 根旋转（`scene.ts:407-416`） | 同名同法 | 有意对齐 |
| 雾 / PVS / LOD / lightmap / 画质切换 | **无**（`scene.ts:1-5` 职责边界） | debug/game 具备（debug lib 有 `export_mosaic_manifest`，`debug/crates/wasm/src/lib.rs:850`） | 取舍：看图不需要 |

## 5. 解析层与产物形态

| 项 | viewer | 参照 |
|---|---|---|
| 解析本体 | 共享 `websurf-wasm-core`（`viewer/crates/wasm/Cargo.toml:18-19`）——**不是复制**，与其他工程同一份 crate | debug/game 同依赖 |
| WASM 包名 | `websurf_viewer_wasm`（`viewer/package.json:8`、`viewer/src/wasm.d.ts:4`） | debug→`websurf_wasm`、game→`websurf_wasm`（同名不同包、各自相对引用；根 workspace 有意不收编 5 个同名 `websurf-wasm` crate，根 `Cargo.toml:5-28`） |
| vmdl vendor patch | 同款 `[patch.crates-io]`（`viewer/Cargo.toml:11-13` = 根 `Cargo.toml:27-28`） | 四工程一致（VTX 三角形条带修复，`src/vendor/vmdl/`） |
| 缺失纹理回退 / 默认纹理包 | 不启用：`ConvertOptions::default()` 无 `missing_fallback`（`viewer/crates/wasm/src/lib.rs:454`） | debug/game 有 mosaic/mtz 链（`debug/crates/wasm/src/lib.rs:842-867`） |
| dist 形态 | **single 唯一形态**（`viewer/scripts/build-dist.mjs:13`，dist-multi 分支 2026-09 移除；CI 亦走 `npm run build:dist`——"single 模式（viewer 唯一产物形态）"，`.github/workflows/deploy-pages.yml:126-127`） | debug 本地支持 `--multi`（`debug/scripts/build-dist.mjs:9,18,27`），CI 用 `--multi`（`deploy-pages.yml:106-109`） |
| file:// 兼容 | 内嵌 wasm base64 + Blob URL worker + classic script（`bsp.ts:44-51`、`importer.ts:41-50`、`build-dist.mjs:5`；断言 `smoke-cdp.mjs:128-143`） | debug/game 以 HTTP 部署为主 |

## 6. 交互与功能面

| 项 | viewer | 参照 |
|---|---|---|
| 相机 | 自由飞行（WASD/Space/C/Shift×4 + 指针锁定，`fly.ts:57-105`）+ 回放第一/第三人称 | game：受控玩家；debug：调参视角 |
| 键位掩码 / 输入槽 | 无（键鼠直接进 FlyCam） | ts-shared `input-layer`/`keysToMask`（debug/game） |
| 面板 | 地图信息 + 出生点导航 + 参考显示 + 录像页 | debug：物理参数/碰撞/传送/PVS/画质面板；game：玩法面板 + 存点（`game/src/panel/`、`game/src/savepoint.ts`） |
| 存点 / 计时 | 无（定位即"看"） | game 具备 |
| 外部控制 API | `window.viewer.replay`（`app.ts:345-394`，供自动化/冒烟） | game/debug 以面板与参数为主 |

## 7. 与共享层的边界（避免误读）

1. **`websurf-wasm-core` 是真依赖**：BSP 解析（`vbsp` 26 lump + LZMA + Leaves 排序修复）、GLB 导出（`bsp_to_gltf_core`）、模型整合（`model_integrator`）、PAKFILE 索引（`pakfile_models`）、VTF 解码（`texture_utils`）全部来自共享 crate——viewer 侧 `crates/wasm/src/lib.rs` 只是 wasm-bindgen 导出层 + PAKFILE 模型/材质提取的"viewer 版组装"（`lib.rs:1-9, 16-17`）。
2. **`websurf-phys` / `ts-shared` 是"对齐"不是"依赖"**：共享的只有数值与约定（EYE_STAND 64.09、`bspYawToCsYaw = (270 − yaw) mod 360`）。同式三处各自维护：`viewer/src/core/pose.ts:12-14`、`src/ts-shared/phys/world-builder.ts:92`、`debug/src/world/spawn-loader.ts:61`——不 import 是有意为之（工程间零 import 原则），改公式需三处同步。
3. **坐标系同一约定**：GLB 顶点/出生点都走 `[x,y,z]→[y,z,x]` Y-up 变换（`src/wasm-core/bsp_to_gltf_core/convert.rs:813-816`、`src/wasm-core/model_integrator/mod.rs:1041-1045`、`viewer/crates/wasm/src/lib.rs:339-342`），所以 viewer 的录像坐标能直接和场景对齐（起点对齐检测 `app.ts:196-222` 的前提）。
4. **与 test/dual-mode-harness 的特殊关系**：viewer 的空间分块合并算法移植自 harness 的 `worker-b.ts`（`scene.ts:236-241` 注释自证）；viewer 的录像自检与 harness 的对照测试互补（管线 vs 物理）。

## 8. 若要在 viewer 上"加物理"会破坏什么（反向印证取舍）

- 需要引入 websurf-phys + SAB/权威 Worker → 破坏"单线程、双击 dist 可用"（§2）；
- 需要碰撞 → GLB 导出要补 brush 碰撞体（共享层已有该路径，viewer 未启用，`lib.rs:1-9`"brush/模型碰撞…均不导出"）；
- 需要重演物理 → 录像回放要换成重模拟，规则脚本映射与"任意格式 JSON"的通用性消失。
这就是 viewer 保持"无物理纯视觉"的原因：**每一项它不做的能力，都换来一条它独有的简单性**（file:// 双击、29 万帧无卡顿、跨格式通用回放）。
