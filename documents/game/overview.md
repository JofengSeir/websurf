# game（WebSurf-game）总览

> 核对基准：2026-09 当前工作区代码（`apps/game/src/`、`apps/game/crates/`、`apps/game/package.json`、共享 `src/ts-shared/`、`src/phys/`）。旧版文档已移出版本库（见 git 历史），本文为全新重写；所有关键论断标注来源代码路径。
> 公共总架构见 [`../architecture.md`](../architecture.md)；共享物理细节见 [`../phys.md`](../phys.md)、解析层见 [`../wasm-core.md`](../wasm-core.md)、通道与校准见 [`../ts-shared.md`](../ts-shared.md)。

## 1. 定位与工程形态

WebSurf 的**激进最小化游戏化实现**——物理栈整体下沉 Rust WASM，TS 侧只剩「输入采集 + 渲染 + 面板 + 存点」。

| 维度 | 事实 | 来源 |
|---|---|---|
| 包名 | `websurf-game` v0.1.0，`"type": "module"`，描述"主线程唯一物理渲染线 + 单 Worker 权威帧 + Three.js 渲染" | `apps/game/package.json:2-5` |
| workspace | `apps/game/Cargo.toml` 独立 `[workspace] members=["crates/wasm"]`，与仓库根 workspace 分离（debug/game 的 wasm crate 同名 `websurf-wasm`，不能同 workspace） | `apps/game/Cargo.toml:6-19` |
| vmdl 补丁 | `[patch.crates-io] vmdl → ../src/vendor/vmdl`（共享 vendor，VTX 三角形条带展开修复） | `apps/game/Cargo.toml:13-18` |
| 唯一 crate | `crates/wasm`（包名 `websurf-wasm`）：wasm-bindgen 导出层，物理/解析实现在共享 crate | `apps/game/crates/wasm/Cargo.toml:11,22-24`（`websurf-phys`→`../../../../src`、`websurf-wasm-core`→`../../../../src/wasm-core`） |
| 依赖 | `three ^0.165.0`、esbuild、TypeScript（仅 dev）；运行时零 npm 依赖 | `apps/game/package.json` dependencies/devDependencies |

`apps/game/crates/wasm/src/lib.rs` 是薄导出层（约 2300 行）：
- `pub use websurf_phys::phys::PhysWorld;` —— 物理类直接来自共享 crate，game 自己不实现物理（`apps/game/crates/wasm/src/lib.rs:23`）；
- 本文件实现 BSP 导出面：`BspProcessor`（metadata / spawn / teleport / PVS 解析、GLB 导出、brush 平面导出、PAKFILE 模型收集）与独立函数 `mosaic_encode / mosaic_decode / decompress_mtz`；
- 注意：BspProcessor 定义处有历史残留——孤儿文档注释 `/// 一次性解析 BSP 字节数组...`（已删除的 `parse_bsp` 提法，`lib.rs:364-366`）与其后悬挂的 `#[wasm_bindgen]`（`:367`）；实际结构体声明在 `:376-377`（`:367` 与 `:376` 两个属性叠加到同一 `pub struct BspProcessor`），实际入口是构造 `new BspProcessor(bytes)`。

## 2. v7 架构总图

**主线程唯一物理渲染线 + 单 Worker 权威帧计算器**（双端跑同一个共享 `PhysWorld`，各有独立 wasm 线性内存）：

```
主线程（渲染 + 预测物理，rAF 可变 dt ≤0.1s）
  app.ts ─ 输入采集(mousemove/keys) → MouseBuffer(CLAMP 1000) → layerMouseDelta(灵敏度×M_YAW)
        ─ 每帧 shared.addInput(dx,dy,mask) → SAB 输入槽（或 MsgState postMessage）
  RendererMain ─ predPhys.tick(dt,keys,dx,dy)（唯一物理：碰撞/传送/死亡/reset 全走主线程实例）
              ─ AuthorityCalibrator：读权威帧(只读)→速度外推校准→异常兜底→反向同步权威
  Three.js ─ 优化场景(分块合并) + LOD 距离剔除 + 近平面自适应 + 速度 HUD

Worker（权威帧计算器，固定步长 1/(tickRate+3)，TICK_RATE_OFFSET=3）
  worker/main.ts + ts-shared/auth/auth-loop.ts
  ─ setTimeout 4ms 自驱 → takeInput(SAB/Msg) → PhysWorld.tick → writeAuthoritative(双缓冲+V_A++)
  ─ 碰撞事件(land/blocked) postMessage → 主线程 applyCollisionCorrection 微调
  ─ sync-render-state：渲染主线大偏差时反向覆盖权威 + resetInput
```

依据：`apps/game/src/worker/main.ts:1-16`（头注"权威帧计算器（v7）"+ `TICK_RATE_OFFSET = 3` 于 `:32`）、`apps/game/src/renderer/renderer-main.ts:96-113`（`predPhys` 主线程唯一物理 + `AuthorityCalibrator` 收敛 ts-shared）、`src/ts-shared/phys/authority-calibrator.ts:110-127`（"只读权威，绝不反写"+ 大偏差反向同步定调）。
⚠️ `apps/game/src/app.ts:4,7` 头注仍写"v5 …Worker = 纯速度修正器"，与现行 v7 代码不符——以 `worker/main.ts` 头注与实际消息流为准（历史残留，勿引用）。

### 2.1 双端同构（同一物理、同一输入）

- 双端各持一个 `PhysWorld`（`apps/game/src/renderer/renderer-main.ts:483-519` 主线程 `buildPredictionWorld`；`src/ts-shared/auth/worker-dispatch.ts:101-117` Worker `world-json` → `build_world`），都由 `buildPhysicsParams` 生成同一份 snake_case 参数（`apps/game/src/config.ts:158` + `src/ts-shared/phys/params.ts:40-59`，其中 `sensitivity: 1` 固定——灵敏度在主线程输入层乘入，双端消费同一份已缩放输入，角度永不因灵敏度分叉）。
- Q/E 转向不进物理：输入层生成等效鼠标量 `qeEquivalentDx = yawBindSpeed/M_YAW×dt`（`src/ts-shared/input/input-layer.ts`；`apps/game/src/app.ts:346-354` 每帧并入 `feedInput`），Rust 侧仅收 dx/dy（`src/phys/mod.rs:222-233` step_core 注释明示"物理不再内部旋转"）。

### 2.2 通道层

`crossOriginIsolated`（serve.py 发 COOP/COEP）→ `SharedArrayBuffer(512B)` 高性能通道；否则 MsgState postMessage 回退（功能等价可玩）。创建于 `apps/game/src/app.ts:82-124`；接口统一在 `src/ts-shared/auth/shared-state.ts`（`ShmState`/`MsgState`，布局常量 `I_V_A/I_KEYS/I_A_GROUND/B_DX_ACC/B_DY_ACC/B_A0/B_A1` 于 `:104-117`，`SHARED_BUFFER_SIZE = 512` 于 `:117`）。

## 3. 目录结构与模块划分

| 路径 | 行数 | 职责（实测 wc -l） |
|---|---|---|
| `apps/game/src/app.ts` | 699 | 入口 `main()`：通道选择、Worker/Renderer/桥/面板装配、输入绑定、地图加载 `handleLoadBsp`、存点 X/C、加载覆盖层 |
| `apps/game/src/config.ts` | 177 | `DEFAULT_CONFIG`（physics/input/player/hud/texture 五段 + `lockTickRate`）+ `applyConfigPatch` + `buildPhysicsParams` |
| `apps/game/src/renderer/renderer-main.ts` | 1091 | 渲染主线：Three.js 初始化、GLB 场景挂载、分块合并 optimizeScene、LOD/PVS、近平面自适应、主线程物理 tick、权威校准入口、画质切换 |
| `apps/game/src/worker/main.ts` | 446 | Worker 装配：`createAuthLoop` + `createWorkerDispatch`，`getConfigTickRate = config.physics.tickRate + TICK_RATE_OFFSET`（`:429`，常量 `TICK_RATE_OFFSET` 在 `:36`） |
| `apps/game/src/worker/worker-types.ts` | 202 | 协议类型（⚠️ 部分注释落后于实现，运行时协议以 `src/ts-shared/auth/worker-dispatch.ts` 为准；`:6` 提到的 predictor-worker 文件已不存在，纯历史残留） |
| `apps/game/src/input/input-bridge.ts` | 75 | 面板 → 双端物理的参数桥（sendConfig 双写、respawn/teleport） |
| `apps/game/src/input/keyboard.ts` | 113 | `KeyboardInput`：锁定门控、`getState/getMask/reset`、面板 `setKeymap` 热更新 |
| `apps/game/src/input/keymap.ts` | 112 | 默认键位 + 录制重绑 + localStorage（`STORAGE_KEY='websurf-game.keymap.v1'` `:42`） |
| `src/ts-shared/input/mouse-buffer.ts` | 128 | `process()` 路径：discardNext + 单事件削平 ±1000（`MAX_DELTA` `:40`；`push/drain` 为遗留未用路径） |
| `src/ts-shared/input/pointer-lock.ts` | 154 | `unadjustedMovement:true` 请求 + 旧浏览器 void 降级 + 3s 超时（`:71`） |
| `apps/game/src/panel/panel-controller.ts` | 684 | ESC 两栏面板：通用/物理/体型/按键/操作/显示/视角七模块、控件绑定、偏好持久化、noclip、存点列表 |
| `apps/game/src/world/pvs-manager.ts` | —（批 4 已上提） | PVS 叶子查找 + 行 RLE 解码 + 可见集——**D-10 起实现在 `src/ts-shared/world/pvs-manager.ts`（271 行）**，本工程文件已删除（`renderer-main.ts` 改 import 共享单点） |
| `apps/game/src/world/types.ts` | 17 | 最小化世界类型：`Vec3Like`/`Vec3` 留在本工程（D-07 判保留）；PVS 三类型批 4（D-10）起为 re-export 共享单点（对照 debug 198 行） |
| `apps/game/src/savepoint.ts` | 106 | `SavePointStore`：按地图 localStorage（`websurf-game.savepoints.{mapName}`）、上限 50（`SAVEPOINT_MAX` `:27`）、latest/add/delete |
| `apps/game/web/index.html` | 249 | 页面外壳（纯结构与挂载点）：80 元素 id / 14 data-* / 30 class 与 JS 绑定零改动（r1 复核 80/80、14/14、30/30）；不含任何行内样式，视觉层全在 styles.css |
| `apps/game/web/styles.css` | 581 | 独立视觉层（viewer S10 令牌体系）：:root 设计令牌 + 卡片化面板 + 悬停/激活交互态；可见性 class 钩子（`#panel.hidden`/`#error.show`/`.key-rec-hint(.show)`/`#crosshair.no-dot .ch-dot`）+ `.load-fill` 进度条 `var(--load-pct, 0%)` |
| `apps/game/crates/wasm/src/lib.rs` | 2326 | WASM 导出层（见 §1） |

### 3.1 ts-shared 复用矩阵（import 实测）

| 共享模块 | game 引用点 |
|---|---|
| `auth/shared-state.ts` | `apps/game/src/app.ts:20`（createMainSharedState/keysToMask/KEY_MASK）、`keyboard.ts:11`、`renderer-main.ts:20`、`worker/main.ts:21` |
| `auth/auth-loop.ts` | `apps/game/src/worker/main.ts:22` |
| `auth/worker-dispatch.ts` | `apps/game/src/worker/main.ts:23` |
| `phys/params.ts` | `apps/game/src/config.ts:5`、`worker/main.ts:24` |
| `phys/world-builder.ts` | `apps/game/src/app.ts:22` |
| `phys/authority-calibrator.ts` | `apps/game/src/renderer/renderer-main.ts:21` |
| `input/input-layer.ts` | `apps/game/src/app.ts:21` |

## 4. 配置系统（最小化五段）

`apps/game/src/config.ts:92-143` `DEFAULT_CONFIG`：`physics`（tickRate 64 / gravity 800 / jumpSpeed 302 / maxSpeed 250 / friction 4 / accelerate 10 / airAccel 150 / stopSpeed 100 / autobhop / walkSpeed 130 / crouchSpeed 85 / bhopSpeedClamp / noPrestrafe / teleportGateTicks 3）、`input`（sensitivity 1.5 / pitchLimit 89 / yawBindSpeed 210 / noclipSpeed 800）、`player`（半宽 16 / 站高 72 / 蹲高 54）、`hud`（fov 73.6、准星、速度模式）、`texture.quality`；外加 `lockTickRate`（默认 false；true 时锁定 64Hz 只读，为"计时玩法公平性"预留，`config.ts:81-93`、`panel-controller.ts:222`）。
对比 debug 的十余段可调参数 + 物理参数定义库，game 把面板参数收敛为最小集合（差异详见 [differences.md](differences.md)）。

## 5. 构建与运行链

```bash
npm install
npm run build:wasm   # wasm-pack release → pkg/（wasm-opt=false，Cargo.toml package.metadata），并拷 wasm 到 web/
npm run build:ts     # typecheck(tsc) + esbuild 双产物：web/worker.js + web/app.js（package.json:10-12）
npm run check:api    # scripts/check-wasm-api.mjs：契约校验 = 导出层 16 + 物理层 17 API 全存在
npm run test:phys    # scripts/phys-smoke.mjs：node 直跑 WASM 物理冒烟（落体→落地→跳）
npm run build:dist   # scripts/build-dist.mjs：single（默认，内嵌 file:// 可玩）/ --multi（Pages）
```

- 产物引用：`apps/game/web/index.html`（245 行，纯结构与挂载点——`<link rel="stylesheet" href="./styles.css">` 于 `:17`、`<script type="module" src="./app.js">` 于 `:243`；80 元素 id / 14 data-* / 30 class 与 JS 绑定零改动，r1 复核 80/80、14/14、30/30）+ `apps/game/web/styles.css`（571 行独立视觉层，viewer S10 令牌体系：:root 令牌 + 卡片化面板 + 悬停/激活交互态；零行内样式）。
- **single 构建**（`scripts/build-dist.mjs:66-126`）：wasm base64 + worker 代码 + mtz 全部内嵌进 `dist/app.js`（Blob URL module worker），`dist/index.html` + `dist/styles.css` 外置（copyFileSync `:110-111`，file:// 下 `<link>` 同样可加载），专门支持 `file://` 双击（无 fetch/无 SAB 自动 MsgState 降级）。
- **multi 构建**（`build-dist.mjs:129-174`）：`index.html + styles.css + app.js + worker.js + websurf_wasm_bg.wasm + textures.mtz` 共 6 文件（index/styles 拷贝 `:163-165`），用于 GitHub Pages（`.github/workflows/deploy-pages.yml` 头注 9-13 行：game 以 multi dist 部署）。
- 一键：`apps/game/play.cmd` 四步自举（ensure-node-deps → wasm → ts → dist）后以共享 `src/serve.py` 起服务（**COOP/COEP + no-store**，`src/serve.py:31-36`，SAB 生效前提）自动打开 `http://localhost:8137/dist/index.html`（端口见 `apps/game/play.cmd:6`）。
- dev 页面：`python ../../src/serve.py 8080 .` 后访问 `/web/index.html`（需先 `npm run build:ts`）。
- ⚠️ 仓库内已有 `apps/game/web/*.js` 与 `apps/game/dist/*` 可能是旧架构（v3）产物——运行前先重建（`apps/game/README.md` 已明示）。

## 6. WASM 契约（双端共用一个包）

`apps/game/pkg/websurf_wasm.js` 由 wasm-pack 生成，`apps/game/src/wasm.d.ts` 直接 re-export pkg 类型。契约由 `apps/game/scripts/check-wasm-api.mjs:17-53` 静态校验：

- **导出层 16**：`metadata / parse_spawn_points / parse_teleports / parse_pvs_data / export_brushes_planes / export_model_tri_colliders / export_model_phy_colliders / export_glb(_with_pakfile_models(_with_defaults)) / export_mosaic_manifest / export_missing_textures / take_event / mosaic_encode / mosaic_decode / decompress_mtz`；
- **物理层 17**：`build_world / tick / tick_into / predict / state / state_out_ptr / respawn / teleport_to / teleport_to_spawn / set_spawn_points / set_death_y / set_params / set_hull / set_noclip / set_state / set_velocity / set_yaw_pitch`（全部来自共享 `src/phys/mod.rs`）。
- game 实际只用其中一部分：主线程 `tick/state/set_state/set_params/set_hull/set_noclip/set_death_y/build_world/set_spawn_points`（renderer-main），Worker `tick/build_world/respawn/teleport_to_spawn/set_spawn_points/sync 参数`（auth-loop/dispatch）；`tick_into/state_out_ptr/predict/debug_trace/gate_veto_count/take_event/set_velocity/set_yaw_pitch/teleport_to` 为共享层或验证工程接口，game 未调用（grep `apps/game/src` 无引用）。

## 7. 文档导航

| 文档 | 维度 | 内容 |
|---|---|---|
| [sequences.md](sequences.md) | T | 启动时序、地图加载管线、双线程帧循环、校准与反向同步、SAB/Msg 协议 |
| [implementation/panel-and-input.md](implementation/panel-and-input.md) | I | 输入采集链、键位录制、PointerLock、参数桥、面板七模块 |
| [implementation/gameplay.md](implementation/gameplay.md) | I | 存点/读点/按住冻结、出生点选择、渲染体验子系统、死亡阈值、PVS 现状 |
| [differences.md](differences.md) | D | game vs debug/viewer/dual-mode-harness 的架构取舍与共享层收敛 |

> 归档旧文档（v5 时代视角，仅供历史对照）已移出版本库，可在 git 历史中追溯。
