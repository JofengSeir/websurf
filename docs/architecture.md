# WebSurf 仓库总架构（整体架构 · 跨工程视角）

> 本文是根导航下的**总架构篇**：站在仓库全局讲清组成、边界、共享层引用、构建/运行链、核心数据流与各工程取舍。
> 写作基线：当前工作区代码 + 已交付的工程文档（game/viewer/debug/harness 的 docs 与共享层三篇）；
> 关键论断标注代码路径（`路径:行号`）或已核验文档（链接）。单工程的时序与实现细节不在本文展开，见 §7 文档体系。
> 导航入口：[index.md](./index.md)。

---

## 1. 仓库组成：一个共享 workspace + 五个模块工程

### 1.1 目录与身份

| 目录 | npm 包名 | 定位（package.json description 摘录） | Cargo crate | WASM 产物 | 来源 |
|---|---|---|---|---|---|
| `debug/` | `websurf` | 浏览器中的 Surf 地图游玩器（主工程/调试台） | `websurf-wasm` | `pkg/websurf_wasm.js` | `debug/package.json:2-3`、`debug/crates/wasm/Cargo.toml:11` |
| `game/` | `websurf-game` | 最小化游戏化实现（主线程唯一物理渲染线 + 单 Worker 权威帧） | `websurf-wasm` | `pkg/websurf_wasm.js`（同名不同包） | `game/package.json:2-4`、`game/crates/wasm/Cargo.toml:11` |
| `viewer/` | `websurf-viewer` | 最小 BSP 自由视角查看器（GLB + 飞行相机 + 录像回放） | `websurf-viewer-wasm` | `pkg/websurf_viewer_wasm.js` | `viewer/package.json:2-3`、`viewer/crates/wasm/Cargo.toml:8` |
| `test/dual-mode-harness/` | `websurf-test` | 双模物理 + OffscreenCanvas 渲染时序验证工程 | `websurf-test-wasm` | `pkg/websurf_test_wasm.js` | `test/dual-mode-harness/package.json:2-3`、`crates/wasm/Cargo.toml:8` |
| `test/instanced-diorama/` | `websurf-instanced-diorama` | 实例化绘制 + PBR + 影棚光照 + SSAO/DOF 测试用例 | `websurf-wasm` | `pkg/websurf_wasm.js`（拷至工程根） | `test/instanced-diorama/package.json:2-3`、`crates/wasm/Cargo.toml:11`、`package.json:8` |
| `src/` | —（无 npm 包） | 共享 Rust 物理系统 `websurf-phys` | `websurf-phys`（rlib） | — | `src/Cargo.toml:2` |
| `src/wasm-core/` | —（无 npm 包） | 共享 BSP/GLB/模型解析导出 `websurf-wasm-core` | `websurf-wasm-core`（rlib，无 wasm-bindgen 导出） | — | `src/wasm-core/Cargo.toml:1`、`src/wasm-core/lib.rs:6` |
| `src/ts-shared/` | —（无 npm 包） | TS 共享层（7 文件三域，共 1543 行，`wc -l` 实测） | — | — | `src/ts-shared/`（清单见 [ts-shared.md](./ts-shared.md) §1.1） |

### 1.2 workspace 划界：两个刻意的决定

1. **根 workspace 只收共享层两个 crate**（`[workspace] members = ["src", "src/wasm-core"]`，`Cargo.toml:20-25`）。不收编模块工程的原因：debug/game/instanced-diorama 三者的 wasm crate **同名 `websurf-wasm`**（Cargo workspace 不允许同名成员），改名会连锁改 40+ 处产物名引用——因此模块 crate 各自保留 workspace（根 `Cargo.toml:5-11` 头注释明示；`test/dual-mode-harness/docs/differences.md` §5 同口径）。harness/viewer 的 crate 名（`websurf-test-wasm`/`websurf-viewer-wasm`）本无同名冲突，但同批留在各自 workspace。
2. **全仓构建缓存统一到根 `target/`**：`.cargo/config.toml` `[build] target-dir = "target"`（`.cargo/config.toml:12-13`）——同一份依赖与共享 crate 全仓库只编译一份，构建缓存跨 6 个 workspace 复用（`CARGO_TARGET_DIR` 可覆盖，`:10` 注释）。

### 1.3 工程间隔离：TS 互不引用

四个应用/验证工程的 TS 源码互不 import（跨工程路径 import 全仓 grep 为 0 命中，`grep -rnE "from ['\"][^'\"]*(game/src|debug/src|viewer/src|dual-mode-harness/src|instanced-diorama/src)" debug/src game/src viewer/src test/*/src`）。共享只有两条合法通道：

- **Rust 层**：`websurf-phys` / `websurf-wasm-core` 的 path 依赖（`debug/crates/wasm/Cargo.toml:21-22`、`game/crates/wasm/Cargo.toml:21-22` 等同款）；
- **TS 层**：debug/game 相对路径 import `../../src/ts-shared/...`（7 模块清单见 [ts-shared.md](./ts-shared.md) §1.2）。

唯一例外形态：viewer/harness 对共享**常量与公式**采用"复制并注释对齐"而非 import（EYE_STAND 64.09 源 `src/phys/player.rs:34` → `viewer/src/core/constants.ts:6-7`；harness 仅复用 `KEY_MASK` 位定义，`test/dual-mode-harness/src/shared-state.ts:51`——位定义共用、协议另建）。

### 1.4 vmdl vendor patch：六处同源

crates.io vmdl 0.2.0 vendor 到 `src/vendor/vmdl/`（修复 Source VTX 三角形条带展开 bug），`[patch.crates-io]` 在**根 workspace 与 5 个模块 workspace 共 6 处同款**（根 `Cargo.toml:27-28`；debug `:13-14`、game `:13-18`、viewer `:11-13`、harness `:9-16`、instanced `:17-19`）。注意 patch 只对声明它的 workspace 生效——所以模块工程必须各自带同款（根 `Cargo.toml:17-18` 头注；vendor 说明注释块在 `:13-16`，勿与 patch 声明位置混淆）。

### 1.5 CI 部署面

`.github/workflows/deploy-pages.yml`：

| 工程 | CI 处置 | 证据 |
|---|---|---|
| debug | 构建并部署，`node scripts/build-dist.mjs --multi`（多文件 dist） | `deploy-pages.yml:4`（头注"主工程…多文件 dist"）、`:86-88` |
| game | 构建并部署，`--multi` | `deploy-pages.yml:104-112`（注释"multi 模式：多文件…HTTP 部署"） |
| viewer | 构建并部署，`npm run build:dist`（**single 是唯一产物形态**，dist-multi 分支已移除） | `deploy-pages.yml:120-126`、`viewer/scripts/build-dist.mjs:13` |
| test/dual-mode-harness、test/instanced-diorama | **仅构建验证，不部署**（install + build WASM/TS） | `deploy-pages.yml:7`、`:133-146` |

---

## 2. 共享层引用矩阵

五个模块工程对三件共享物的真实消费面（各行均有独立文档详述，此处给矩阵与入口）：

| 共享件 | debug | game | viewer | dual-mode-harness | instanced-diorama |
|---|---|---|---|---|---|
| `websurf-phys`（rlib 物理内核，21 个 wasm-bindgen 导出方法） | ✅ `pub use websurf_phys::phys::PhysWorld`（`debug/crates/wasm/src/lib.rs:22`） | ✅ 同款（`game/crates/wasm/src/lib.rs:23`） | ❌ 无物理（Cargo.toml 无此依赖；`viewer/crates/wasm/Cargo.toml:3-5` 注释自证） | ✅（`crates/wasm/src/lib.rs:35`；WorkerA 内双实例） | ✅ 声明 re-export（`crates/wasm/src/lib.rs:23`）；**TS 运行时未调用**（grep `PhysWorld test/instanced-diorama/src` → 空） |
| `websurf-wasm-core`（BSP/GLB/模型/纹理解析） | ✅ 全导出集（BspProcessor 15 方法 + mosaic 3 函数） | ✅ 全导出集（同源精简：`crates/wasm/src/lib.rs:387-1671`） | ✅ 薄消费（vbsp/gltf/model/pakfile/texture 五模块，**不用 phyfile/mosaic**，`viewer/crates/wasm/src/lib.rs:16-20`） | ✅ 物理导出子集（brush/phy/tri/spawn/GLB；teleport/PVS 保留 API 但主流程不调用，`crates/wasm/src/lib.rs:18-19`） | ✅ 薄导出（`crates/wasm/src/lib.rs:21`） |
| `src/ts-shared`（TS 共享层） | ✅ 7 模块全用（import 区实测） | ✅ 7 模块全用（`game/src/worker/main.ts:21-24` 等） | ❌ 零 import（仅 `core/pose.ts:11` 注释对齐） | 仅 `KEY_MASK`（`src/shared-state.ts:51`；192B 是另一套协议） | ❌ 不使用（grep 空） |
| `src/serve.py`（dev 服务器，COOP/COEP） | ✅ `npm run dev`（`debug/package.json`） | ✅ | ✅ | ✅ | ✅ |
| vmdl vendor patch | ✅ | ✅ | ✅ | ✅ | ✅ |

> 矩阵逐格证据的完整展开：物理消费面见 [phys.md](./phys.md) §1.4，解析消费面见 [wasm-core.md](./wasm-core.md) §1.3 与 §4（各工程导出面差异表），TS 消费面见 [ts-shared.md](./ts-shared.md) §1.2。

**材质体系（mosaic/MTZ）归属说明**：材质字节码（v4 DSL）与 MTZ5/6 容器实现于 `websurf-wasm-core`（`src/wasm-core/mosaic/`），由 debug/game 两端 cdylib 导出并经 ts-shared `world-builder` 的 `decompressMtz` 注入消费；viewer/harness 不导出。材质体系全景见 [materials.md](./materials.md)（共享层④，收敛 `docs/archive/materials.md` 等三处旧档为根单篇）；解码核心机制（VTF/mosaic DSL）见 [wasm-core.md](./wasm-core.md) §3.6-§3.7。

---

## 3. 构建与运行链

### 3.1 统一三步链

所有工程的构建链同构（各工程 package.json scripts 实测）：

```
wasm-pack build --release --target web  →  <工程>/pkg/<产物名>.js + _bg.wasm
esbuild（tsc --noEmit 前置 typecheck）    →  <工程>/web/（或工程根）app.js + worker*.js
scripts/build-dist.mjs                    →  <工程>/dist/（部署形态，矩阵见 §3.2）
```

WASM/Worker/入口三者的页面接线：debug `debug/web/index.html:621`、game `game/web/index.html:918`、viewer `viewer/web/index.html`、harness `index.html:94`（均 `<script … src="./app.js">` 或同构 module 入口）。

### 3.2 dist 形态矩阵

| 工程 | 本地 dist 支持 | CI 部署形态 | file:// 可用 | 依据 |
|---|---|---|---|---|
| debug | single（默认，全内嵌）+ `--multi` | multi | single 形态可用 | `debug/scripts/build-dist.mjs:1-14`、`deploy-pages.yml:86-88` |
| game | single（默认）+ `--multi` | multi | single 形态可用 | `game/scripts/build-dist.mjs:26,55-58`（dispatch）与 `:9,121`（multi 注释）、`deploy-pages.yml:104-112` |
| viewer | **仅 single**（multi 分支 2026-09 移除） | single | ✅ 双击可用（wasm base64 + Blob worker + classic script） | `viewer/scripts/build-dist.mjs:5,13`、`deploy-pages.yml:120-126` |
| harness | 多文件 dist（5 文件，无 single 内嵌） | 不部署 | 仅消息回退模式等价可用 | `test/dual-mode-harness/scripts/build-dist.mjs:10-11`、overview §5 |
| instanced | 无 dist 构建脚本（`npm run build` = wasm + ts） | 不部署 | — | `test/instanced-diorama/package.json:8,11` |

注意：`viewer/web/app.js`、`web/parse-worker.js` 与 wasm 产物**不入库**（`viewer/.gitignore:2-4`、根 `.gitignore:9-12`）——git 只跟踪 `viewer/web/index.html` + `styles.css`，页面打开前必须先构建（未构建时有 `web/index.html:91-107` 的 `#fatal` 兜底提示）。debug/game 的 `web/*.js` 同为构建产物；game 的现存 `web/*.js`/`dist/*` 可能是旧架构（v3）产物，运行前先重建（`game/docs/overview.md` §5 ⚠️ 注）。

### 3.3 运行通道与降级

- **SAB 前置**：`src/serve.py:33-34` 发 `Cross-Origin-Opener-Policy: same-origin`（:33）+ `Cross-Origin-Embedder-Policy: require-corp`（:34，:32 为注释行；另 `Cache-Control: no-store` `:36`），使 `crossOriginIsolated=true` 启用 `SharedArrayBuffer`。
- **降级链各不相同**：debug/game 的权威帧协议在无 SAB 时降级为 MsgState postMessage（`src/ts-shared/auth/shared-state.ts` 双实现同接口）；harness 自带**消息回退模式**（`test/dual-mode-harness/src/main.ts:74-100`，WorkerA↔WorkerB 直连 MessageChannel）；viewer 单线程根本不需要 SAB。

### 3.4 契约校验

`check-wasm-api.mjs` 存在于 **debug / game / harness 三处**（`debug/scripts/`、`game/scripts/`、`test/dual-mode-harness/scripts/`；`npm run check:api`），静态比对 pkg 导出与 TS 导入符号。**viewer 无此脚本**（`viewer/scripts/` 仅 `build-dist.mjs` + `dist-README.md`，git ls-files 实测）——不要把 debug/game/harness 的校验脚本写成 viewer 的。harness 侧契约最严：只锁 PhysWorld 12 API（`check-wasm-api.mjs:26-39`）。

---

## 4. 核心数据流：BSP → 解析 → 物理 → 渲染

### 4.1 解析层（共享 websurf-wasm-core，一次解析三条消费流）

```
BSP bytes ─ vbsp::Bsp::read（一次解析，lump 常驻）
  ├─① GLB 渲染流：bsp_to_gltf_core + ModelIntegrator（PAKFILE 模型合并）→ GLB 字节
  ├─② 物理导出流：BspProcessor export_brushes_planes / export_model_tri|phy_colliders
  │     → JSON → ts-shared buildWorldBundle → world-json 消息 → PhysWorld::build_world
  └─③ 辅助流：parse_spawn_points / parse_teleports / parse_pvs_data /
        export_mosaic_manifest / export_missing_textures（按工程能力取舍，见 §2 矩阵）
```

（图与逐条出处：[wasm-core.md](./wasm-core.md) §2.1；管线编排 `src/ts-shared/phys/world-builder.ts:95` 起，mosaic/缺失纹理**必须先于 GLB 导出**，`:164` 注释。）

### 4.2 物理层（共享 websurf-phys，Worker 内实例化）

`PhysWorld::build_world(brush, tri, teleport, spawn, yaw)` 五步建世界（[phys.md](./phys.md) §2.1）→ `tick(dt, mask, dx, dy)` 固定步长推进（CS 移动语义 + 扫掠碰撞 + 传送/死亡）→ 21 个 wasm-bindgen 导出方法供消费（`src/phys/mod.rs:84-460`；`mod.rs:4` 头注"12 个 API"为早期口径，以代码实测 21 为准，[phys.md](./phys.md) §4.4）。坐标系统一 Y-up（BSP 的 Z-up→Y-up 在解析/导出层完成，[phys.md](./phys.md) §1.3）。

### 4.3 渲染层：三种形态

| 形态 | 工程 | 渲染发生位置 | 物理推进位置 | 依据 |
|---|---|---|---|---|
| 主线程 rAF 双线 | debug / game | 主线程 three.js（`renderer-main.ts`） | 主线程预测实例（可变 dt）+ Worker 权威实例（固定步长） | `debug/src/renderer/renderer-main.ts:430-516` ≙ `game/src/renderer/renderer-main.ts:693-768` |
| Worker 渲染 | harness | **WorkerB**（OffscreenCanvas + three.js，`transferControlToOffscreen`） | WorkerA（同 Worker 内双实例：1ms 无限制 + 64t 速度线） | `test/dual-mode-harness/src/main.ts:151-152`、`worker-b.ts:631,666-668`（readState 采样+插值帧循环）、`worker-a.ts:103-107` |
| 单线程 | viewer | 主线程 rAF（主时钟→相机→可视化→render） | 无物理 | `viewer/src/app.ts:447-483` |

### 4.4 时序族谱（三族协议）

| 族 | 布局 | 使用者 | 关键语义 | 详见 |
|---|---|---|---|---|
| 权威帧双线（512B SAB + MsgState 回退） | 输入槽 + V_A 双缓冲（pos/yaw/pitch/vel/eyeHeight/timeMs） | debug、game（同构 v7 校准：首帧起点/速度外推/兜底反向同步/事件修正） | Worker 4ms 自驱 + 固定步长累积器（默认 1/64）；主线程渲染线每帧读权威校准 | [ts-shared.md](./ts-shared.md) §1.3/§2.1；debug [sequences.md](../debug/docs/sequences.md)、game [sequences.md](../game/docs/sequences.md) |
| 双模验证（192B TestShared） | 控制区 + 输入槽 + RENDER_WAKEUP + 双缓冲（8 值，无 eyeHeight/timeMs） | harness（WorkerA 双实例 + 双槽唤醒 WAKEUP/RENDER_WAKEUP） | 主线程只转发输入；渲染在 WorkerB 按帧信号采样 | harness [shared-layout.md](../test/dual-mode-harness/docs/implementation/shared-layout.md)、[ts-shared.md](./ts-shared.md) §4.3 |
| 单线程（无共享内存协议） | — | viewer | 唯一 Worker 是录像解析（可回退主线程）；回放不重演物理，断网/慢机不跑歪 | viewer [sequences.md](../viewer/docs/sequences.md) |

两族共享的唯一常量是 `KEY_MASK` 位定义（harness 头注"杜绝位定义漂移"，`shared-state.ts:1-4,51`）。

---

## 5. 各工程定位与取舍差异一览

| 维度 | debug | game | viewer | dual-mode-harness |
|---|---|---|---|---|
| 一句话定位 | 权威帧计算器 + 调试工作台（调参/查碰撞/验时序/计时挑战） | 激进最小化游戏化（跑图/存点练习，可玩优先） | 看：BSP 游览 + 录像回放（无物理） | 验：双模物理 + OffscreenCanvas 渲染时序验证 |
| 物理线 | 双线同构（渲染预测 + Worker 权威） | 双线同构（与 debug 共用 ts-shared） | 无 | WorkerA 双实例（1ms 真理源 + 64t 速度线） |
| 通道 | SAB 512B / MsgState | 同 debug | 无 | SAB 192B / 消息回退 |
| 渲染位置 | 主线程 | 主线程 | 主线程（单线程） | WorkerB（OffscreenCanvas） |
| 配置面 | 11 段 RuntimeConfig + 13 项物理面板 | 5 段 + lockTickRate；tickRate 隐藏偏移 +3（`game/src/worker/main.ts:32,86`） | 无面板（FOV 固定 73.6） | 难度按钮（TICK_RATE=模式B 步长，非权威频率） |
| 独有设施 | 物理参数面板/碰撞可视化/准星检查/近平面调参、计时挑战状态机、自定义传送编辑、默认纹理包装配 | 存点系统（X/C 冻结）、键位录制重绑、风格化准星、ESC 双栏面板 | Shavit `.replay` 原生解析回放（帧自身坐标直读 + 多轨迹/信息条/时间轴）、地图信息面板、`window.viewer.replay` API（含 `meta()`） | 11 个验证脚本（53 断言冒烟/唤醒并发/性能基准/屏闪排查/双线对照） |
| PVS | 面板可控 | 代码在但 `ENABLE_PVS=false`（`renderer-main.ts:82`） | 无 | 排除（teleport/PVS 保留 API 不调用） |
| CI/产物 | multi dist 部署 | multi dist 部署 | single dist 部署 | 仅构建验证 |

细节对照（同构骨架、砍掉了什么、独有什么）逐工程见：debug [differences.md](../debug/docs/differences.md)、game [differences.md](../game/docs/differences.md)、viewer [differences.md](../viewer/docs/differences.md)、harness [differences.md](../test/dual-mode-harness/docs/differences.md)。

**贯穿全仓的设计不变量**（写代码/写文档都不要破坏）：

1. **sensitivity=1 全链路**：灵敏度只在主线程输入层乘入一次，物理两端消费同一份已折算输入（[ts-shared.md](./ts-shared.md) §4.4）。
2. **Q/E 不进物理**：转向折算为等效鼠标增量 `qeEquivalentDx`，Rust 侧只收 dx/dy（`src/phys/mod.rs:222-233`）。
3. **yaw 公式三处同式各自维护**：`bspYawToCsYaw = (270 − yaw) % 360` 在 `viewer/src/core/pose.ts:12-14`、`src/ts-shared/phys/world-builder.ts:92`、`debug/src/world/spawn-loader.ts:61`——互不 import 是刻意的（工程间零引用原则），改公式须三处同步。
4. **`KEY_MASK` 单点定义**：位定义只在 ts-shared 一份，harness 复用 import 而非复制。
5. **共享层只收敛协议与算法内核**：UI/渲染/调试设施留在各工程（debug/game 重复携带 chamfer 生成、近平面探测、画质切换等——见 debug [differences.md](../debug/docs/differences.md) §6）。

---

## 6. 验证工程：test/instanced-diorama（不在四工程写作范围，按已核实口径记录）

- **定位**：第二个验证工程——实例化绘制 + PBR 材质 + 影棚光照 + SSAO/DOF 后处理测试用例（含 BSP 光照导出验证）（`test/instanced-diorama/package.json:2-3`）；CI 仅构建验证不部署（`deploy-pages.yml:7,146`）。
- **共享层关系**：`crates/wasm` 声明并 re-export `websurf_phys::phys::PhysWorld`（`crates/wasm/src/lib.rs:23`，头注注明"原 game/crates/wasm/src/phys/ 已迁出"），同时消费 `websurf_wasm_core` 六模块（`lib.rs:21`）；**TS 运行时未调用 PhysWorld**（grep `PhysWorld test/instanced-diorama/src` → 空）。
- **形态**：crate 同名 `websurf-wasm`（三兄弟之一）；pkg 产物 `websurf_wasm.js` 并把 `_bg.wasm` 拷至工程根（`package.json:8`）；无 dist 构建脚本，`scripts/` 仅 `check-lights.mjs`（光照验证）。
- 本工程未单开文档树（2026-09-07 决议）；深入细节直接读代码与工程 README（[test/instanced-diorama/README.md](../test/instanced-diorama/README.md)）。

---

## 7. 文档体系（根导航 → 工程总览 → 细分实现 → 差异）

| 层 | 文档 | 覆盖 |
|---|---|---|
| 导航 | [index.md](./index.md) | 全树导航 + 阅读层次 |
| 总架构 | 本文 `architecture.md` | 组成/边界/共享矩阵/构建链/数据流/差异一览 |
| 共享层 | [phys.md](./phys.md)（172 行）· [wasm-core.md](./wasm-core.md)（168 行）· [ts-shared.md](./ts-shared.md)（192 行）· [materials.md](./materials.md) | Rust 物理内核 · BSP 解析/GLB/纹理解码 · TS 协议与算法 · 材质体系全景 |
| debug | [overview](../debug/docs/overview.md) · [sequences](../debug/docs/sequences.md) · [implementation×3](../debug/docs/implementation/loading-pipeline.md) · [differences](../debug/docs/differences.md) | 主工程四维度 |
| game | [overview](../game/docs/overview.md) · [sequences](../game/docs/sequences.md) · [implementation×2](../game/docs/implementation/panel-and-input.md) · [differences](../game/docs/differences.md) | 游戏工程四维度 |
| viewer | [overview](../viewer/docs/overview.md) · [sequences](../viewer/docs/sequences.md) · [implementation×3](../viewer/docs/implementation/scene-core.md) · [differences](../viewer/docs/differences.md) | 游览/回放工程四维度（含 `.replay` 格式规格；规则脚本规范已归档为历史注记） |
| harness | [overview](../test/dual-mode-harness/docs/overview.md) · [sequences](../test/dual-mode-harness/docs/sequences.md) · [implementation×2](../test/dual-mode-harness/docs/implementation/dual-physics.md) · [differences](../test/dual-mode-harness/docs/differences.md) | 验证工程四维度 |

历史分析文档全部在 5 处 `archive/`（`docs/archive/`、`debug/docs/archive/`、`game/docs/archive/`、`test/dual-mode-harness/docs/archive/`、`viewer/docs/archive/`），仅作背景，不作为事实来源。

---

## 8. 已知历史残留（写文档时勿引用为现行事实）

| 残留 | 位置 | 现实 |
|---|---|---|
| "v5 Worker=纯速度修正器"头注 | `game/src/app.ts:8-9` | 现行为 v7 权威帧计算器（`game/src/worker/main.ts:1-16`） |
| predictor 协议注释 | `game/src/worker/worker-types.ts:6` | 注释提及 Worker-B/predictor 独立协议，但 game 仅单权威 Worker、`worker-types-predictor` 协议文件不存在，运行时协议以 `src/ts-shared/auth/worker-dispatch.ts:79-216` 为准；**本体在用勿清理**——game（195 行）3 处 type-only import：`input/keyboard.ts`、`input/keymap.ts`（KeyState）、`renderer/renderer-main.ts`（SceneDataMessage）；该残留仅 game 侧（debug 的 worker-types.ts 无此注释，其 342 行本体被 6 处 type-only import——`input/keyboard.ts:17`（KeyState）、`renderer/renderer-main.ts:17`（PlaneInfo+SceneDataMessage）、`renderer/plane-inspector.ts:12`（PlaneInfo）、`app.ts:25`（MainMessage/SceneDataMessage/PhysFrameMessage/PhysEventMessage/PhysicsSnapshotMessage/PhysicsEventMessage/PlaneInfo 多类型块）、`worker/main.ts:31` 与 `worker/physics-worker.ts:17`（MainMessage/WorkerMessage，worker 侧消息类型）） |
| `verify:chamfer` npm 入口 | `debug/package.json` → `scripts/verify-chamfer.mjs` | 该脚本不存在（目录实测），入口空引用 |
| "导出 12 个 API"头注 | `src/phys/mod.rs:4` | 实测 21 个（`mod.rs:84-460`），见 [phys.md](./phys.md) §4.4 |
| BspProcessor 孤儿注释 | `game/crates/wasm/src/lib.rs:364-367` | 已删除的 `parse_bsp` 提法；实际结构体声明 `:376-377` |
| `teleport_gate_ticks` 参数 | `src/phys/mod.rs`（`set_params`） | `TeleportManager::check` 已不使用（仅签名兼容，`teleport.rs:171`） |
| trace-verify.mjs / PvsMirror | `test/dual-mode-harness/scripts/` | 当前 src 已无 Trace/PVS 实现，脚本自包含仅作存档 |

> 以上残留均为各工程 [differences.md](../game/docs/differences.md) §6、[phys.md](./phys.md) §4.4 等已核验记载的汇总；修复它们不是文档任务，而是代码清理项（按"只认代码"原则列此防误引）。原 §8 曾记录的 `debug/docs/overview.md:120 → docs/materials.md` 前向悬空已随 [materials.md](./materials.md) 落盘（t18）自行闭环，移出本表。
