# WebSurf 项目技术文档

> **文档类型**：项目工程文档（依据当前源码编写）
> **编写基准**：2026-08-05
> **一致性原则**：所有描述均对照当前源码核验

---

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 系统架构](#2-系统架构)
- [3. 目录结构](#3-目录结构)
- [4. 物理系统](#4-物理系统)
- [5. WASM 层](#5-wasm-层)
- [6. 消息协议](#6-消息协议)
- [7. 构建与运行](#7-构建与运行)
- [8. 配置项](#8-配置项)

---

## 1. 项目概述

**WebSurf** 是一个在浏览器内运行的 **Valve BSP（Source 引擎 v20）surf 地图游玩器**：
解析 `.bsp` 地图二进制 → 导出几何/纹理/模型/碰撞体/出生点/传送点/PVS 数据 →
运行 CS（Counter-Strike: Source）风格的移动物理 → 用 three.js 实时渲染。

核心特性：
- **零外部游戏资源**：纹理、模型全部来自 BSP 内嵌的 PAKFILE lump；
- **零安装分发**：`dist/` 单文件双击即可运行（WASM + Worker 内嵌为 base64）；
- **完整 3D 游玩**：CS 移动物理（加速/空气加速/摩擦/跳跃/蹲/梯子）、传送点、出生点、重生、PVS 视距剔除、LOD。

### 1.1 技术选型

| 选型 | 版本 | 用途 |
|---|---|---|
| Rust → WASM | `wasm-pack` release（LTO + opt-level 3 + codegen-units 1） | BSP 解析 / GLB 导出 / 碰撞体生成 |
| TypeScript | `~5.7.2` | 运行时（物理/渲染/UI），`tsc --noEmit` 门禁 |
| three.js | `^0.165.0` | 渲染 / GLTFLoader（esbuild 内联） |
| esbuild | `^0.23.0` | 打包；dev（ESM）+ dist（IIFE + minify）双模式 |

### 1.2 项目结构说明

| 模块 | 说明 |
|---|---|
| Rust 单一 crate | `crates/wasm` 承载全部 WASM 逻辑：BSP 解析、碰撞体/平面导出、GLB 生成、传送点/PVS 数据解析（以模块组织） |
| 无 CLI/bin | 纯浏览器端应用，所有 Rust 逻辑编译为 WASM 由 Worker 调用 |
| TS 模块 | 主线程 `app.ts`（UI/输入/消息）+ Worker（物理/渲染）+ `world`（BSP 世界数据）+ `physics`（CS 移动物理）+ `renderer`（three.js）；**物理控制面板**（参数/碰撞箱调节）、**碰撞箱可视化**（实体凸包线框/触发线框）、**准星射线检测**（模型/实体面/触发面信息） |
| 构建/工具 | `build-dist.cmd`（双击导出 dist）、`start-dev.cmd`（dev 服务器）、`serve.py`、`scripts/`（WASM API 契约检查/构建脚本）、docs |

---

## 2. 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│ 主线程 (src/app.ts)                                          │
│   ├─ BSP 文件 → postMessage(load-bsp 原始字节, transfer)     │
│   ├─ 输入（Pointer Lock + rAF 120Hz 限流）                    │
│   ├─ UI 控件（物理模式/灵敏度/视距/PVS/重生/spawn/传送点）     │
│   └─ 接收 Worker 消息更新 HUD                                 │
└───────────────────────────┬─────────────────────────────────┘
                            │ postMessage
┌───────────────────────────▼─────────────────────────────────┐
│ Worker (src/worker/main.ts → PhysicsWorker)                  │
│   ├─ WASM 初始化（wasm-init 消息驱动，base64/URL 两种）        │
│   ├─ load-bsp：BspProcessor 解析 → 五元组                     │
│   │    glb / brush / spawn / pvs / teleport                   │
│   ├─ SceneBuilder → three.js Scene                            │
│   ├─ World + PlayerController + PvsManager + TeleportManager  │
│   └─ RenderLoop rAF：物理 tick → LOD/PVS → 渲染               │
└───────────────────────────┬─────────────────────────────────┘
                            │ OffscreenCanvas
                    WebGLRenderer (three.js)
```

### 2.1 线程边界

| 线程 | 职责 | 关键文件 |
|---|---|---|
| 主线程 | UI / 输入采集 / BSP 字节转发 / HUD 渲染 | `src/app.ts`、`src/input/*`、`src/config.ts` |
| Worker | WASM 解析 / 物理模拟 / 渲染循环 | `src/worker/*`、`src/physics/*`、`src/renderer/*`、`src/world/*` |
| WASM | BSP 二进制解析 / GLB 导出 / 碰撞体生成 | `crates/wasm/src` |

### 2.2 数据流（加载一张地图）

1. 用户选择 `.bsp` 文件 → 主线程 `handleBspFile` 读字节 → `sendLoadBsp`（transfer 零拷贝）；
2. Worker `handleLoadBsp`：`new BspProcessor(bytes)` → 依次导出
   `metadata` / `parse_spawn_points` / `parse_teleports` / `parse_pvs_data` /
   `export_brushes_planes`（地图 brush）→ `export_model_colliders`（PAKFILE 模型碰撞体）
   → `export_glb_with_pakfile_models`（含回退纯地图导出）；
3. `handleLoadScene`：`SceneBuilder.build(glb)` → `adaptBrushes(brushJson)` →
   `loadSpawnPoints` → `PvsManager` → `TeleportManager` → `PlayerController` → 注入 `RenderLoop`；
4. 回传 `scene-ready`，主线程启用控件。

### 2.3 坐标系约定

- **BSP 原始坐标**：Z-up；
- **Rust 导出**：`[x,y,z] → [y,z,x]` 旋转为 **Y-up**（det=+1，正交变换），TS 端不二次映射；
- **角度**：yaw 在 BSP/Three.js 中均绕 up 轴，值保持一致；传送 yaw 经 `bspYawToCsYaw` 转换（`cs_yaw = (270 - bsp_yaw) % 360`）。

---

## 3. 目录结构

```
websurf
├── Cargo.toml              # workspace 根（profile.release: LTO）
├── crates/wasm/            # 单一 WASM crate
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs          # WASM 绑定（BspProcessor / parse_bsp / decode_vtf_to_png）
│       ├── pakfile_models.rs   # PAKFILE 模型碰撞体（共面合并/OBB 兜底）
│       ├── vbsp/           # vbsp 解析模块（Leaves 排序修复）
│       ├── bsp_to_gltf_core/   # BSP → GLB 转换
│       ├── model_integrator/   # MDL 模型整合
│       └── texture_utils/      # VTF 纹理解码
├── src/                    # TypeScript
│   ├── app.ts              # 主线程入口
│   ├── config.ts           # RuntimeConfig
│   ├── game/               # 计时挑战状态机
│   ├── input/              # 键盘/鼠标/PointerLock/桥接
│   ├── physics/            # CS 移动物理（cs-movement）
│   ├── renderer/           # three.js 渲染（RenderLoop/LOD/光照/雾/相机/lightmap/碰撞箱可视化/准星检测）
│   ├── worker/             # Worker 入口 + PhysicsWorker + 消息协议
│   └── world/              # 碰撞体适配/出生点/传送点/PVS/自定义传送点
├── web/                    # index.html + vendor(three.js)
├── maps/                   # 测试地图（.bsp）
├── scripts/                # build-dist.mjs / check-wasm-api.mjs / install-wasm-bindgen.cmd
├── pkg/                    # wasm-pack 输出
├── dist/                   # 构建产物（双击运行）
├── build-dist.cmd          # 双击导出 dist
├── start-dev.cmd           # dev 服务器
└── serve.py                # 本地 HTTP 服务器（MIME 配置）
```

---

## 4. 物理系统

物理实现 vendored 自 `@unsurf/cs-movement`（TypeScript 纯函数），位于 `src/physics/`：

- **PlayerController**：玩家状态（origin/velocity/yaw/pitch/eyeHeight），`tick(dt)` 管线；
- **World**：世界碰撞体集合（solids/ladders），由 `adaptBrushes` 从 WASM brush JSON 转换；
- **碰撞**：`traceBox`（扫掠 AABB + 逐平面裁剪）、`BrushGrid`（均匀网格 broadphase）；
- **移动**：`WalkMove` / `AirMove` / `Accelerate` / `AirAccelerate` / `Friction` / `ClipVelocity` /
  `Jump` / `Duck` / `Ladder` / `StepMove` / `StuckCheck` / `TryPlayerMove` / `CategorizePosition` /
  `StayOnGround` / `WishDir` / `MouseInput` / `CurrentMaxSpeed` / `BlockedMove` / `PerfBonus` / `Stamina`；
- **运行时参数**：`runtime.ts` 提供 `getRuntimePhysics()`（重力/加速/摩擦/停止速度/跳跃高度），
  物理核心每 tick 读取，默认值 = CS:S 基准。

> **物理控制面板**（`physics-params.ts` + `param-defs.ts`）：提供 15 项参数调节
> （地速/重力/加速/摩擦/自动连跳/模拟频率等，来源徽标区分 默认/手动）与
> 碰撞箱体积调节（倍率/半宽/站高/蹲高 + 卡住自动恢复）。Worker 侧由
> `PhysicsParams` 管理，主线程经 `set-physics-param`/`set-hull` 消息操作，
> `physics-snapshot` 回传状态渲染面板。

### 4.1 渲染循环（RenderLoop）

- 固定步长物理：`tickRate`（默认 128Hz），每帧最多 `MAX_FIXED_STEPS=10` 次；
- 鼠标输入：`yaw -= dx * (sensitivity * m_yaw)`，pitch clamp ±89°；
- `needsRender` 标志：空闲帧跳过渲染；
- LOD/PVS：`lodManager.update` 每帧执行，PVS 剔除由 `pvsManager` 驱动；
- 传送检测：`TeleportManager.checkTeleport`（start-touch-grounded 模式，支持
  every-frame / start-touch / start-touch-grounded 三种模式）。

---

## 5. WASM 层

单一 crate `crates/wasm`，wasm-pack 输出 `pkg/websurf_wasm.js`。

### 5.1 导出 API

| 符号 | 说明 |
|---|---|
| `init` / `initSync` | WASM 初始化（URL fetch / base64 内嵌） |
| `parse_bsp(data)` | 解析 BSP，返回元数据 JSON |
| `BspProcessor` | 持有 Bsp 实例的处理器 |
| `BspProcessor.metadata()` | 元数据 JSON |
| `BspProcessor.export_glb()` | 纯地图 GLB 导出（消费 Bsp） |
| `BspProcessor.export_glb_with_pakfile_models()` | GLB 导出 + PAKFILE 模型合并（消费 Bsp，失败回退纯地图） |
| `BspProcessor.export_model_colliders()` | PAKFILE 模型碰撞体 JSON（消费前调用） |
| `BspProcessor.parse_spawn_points()` | 出生点 JSON |
| `BspProcessor.parse_teleports()` | 传送点 JSON |
| `BspProcessor.parse_pvs_data()` | PVS 数据 JSON |
| `BspProcessor.export_brushes_planes(filter_json)` | 地图 brush 平面 JSON（物理碰撞） |
| `decode_vtf_to_png(data)` | VTF → PNG 解码 |

### 5.2 模块组织（合并说明）

| 模块 | 来源 | 说明 |
|---|---|---|
| `vbsp/` | crates.io vbsp 0.6.0 本地修复版 | Leaves 排序修复：`leaves` 保持原始顺序，`clusters()` 使用排序副本 |
| `bsp_to_gltf_core/` | 原 bsp-to-gltf-core crate | 删除了未使用的 `export`/`push_bsp_model`/`push_bsp_face` |
| `model_integrator/` | 原 model-integrator crate | 仅用 `from_in_memory` 路径 |
| `texture_utils/` | 原 texture-utils crate | 仅用解码路径 |
| `pakfile_models.rs` | 原 wasm-bindings | PAKFILE 内嵌模型碰撞体 |

---

## 6. 消息协议

主线程 ↔ Worker 消息定义在 `src/worker/worker-types.ts`。

### 6.1 主线程 → Worker

| 消息 | 说明 |
|---|---|
| `wasm-init` | 注入 WASM（`wasmB64` 内嵌 / `wasmUrl` dev） |
| `init` | 传递 OffscreenCanvas + 尺寸 |
| `load-bsp` | BSP 原始字节（transfer） |
| `input` | 按键 + 鼠标增量（120Hz） |
| `config` | 配置分段 patch |
| `resize` | 窗口尺寸 |
| `respawn` | 重生 |
| `set-physics-mode` | noclip / physics |
| `set-cull-distance` | 视距剔除距离 |
| `teleport` | 传送到出生点索引 |
| `teleport-to-pos` | 传送到自定义坐标 |
| `get-player-pos` | 请求玩家位置 |

### 6.2 Worker → 主线程

| 消息 | 说明 |
|---|---|
| `ready` | Worker + WASM 就绪 |
| `bsp-metadata` | 地图元数据 |
| `parse-progress` | 解析阶段进度 |
| `spawn-options` | 出生点列表 |
| `scene-ready` | 场景加载完成 |
| `stats` | FPS/位置/速度/地面状态/cluster + 准星信息（planeInfo，命中模型/实体面/触发面时） |
| `cull-stats` | LOD/PVS 统计 |
| `game-stats` | 计时挑战状态 |
| `player-pos` | 玩家位置（响应 get-player-pos） |
| `error` | 错误信息 |

---

## 7. 构建与运行

### 7.1 双击导出 dist（build-dist.cmd）

```
build-dist.cmd
```

流程：
1. `wasm-pack build --release --target web` → `pkg/`；
2. `node scripts/check-wasm-api.mjs`：校验 TS import 与 WASM 导出契约；
3. `npm run build:ts`：`tsc --noEmit` + esbuild 打包 `web/worker.js` + `web/app.js`；
4. `node scripts/build-dist.mjs`：生成 `dist/app.js`（内嵌 WASM base64 + Worker 代码 Blob URL）+ `dist/index.html`。

产物：`dist/index.html` + `dist/app.js`，双击即可运行（file:// 兼容）。

### 7.2 Dev 服务器（start-dev.cmd）

```
start-dev.cmd
```

1. 若 `pkg/` 不存在先构建 WASM；
2. `npm run build:ts`（worker.js + app.js）；
3. 启动 `python serve.py 8080` → 打开 `http://localhost:8080/web/index.html`。

### 7.3 手动构建

```bash
npm run build:wasm   # wasm-pack release
npm run build:ts     # typecheck + esbuild
npm run build:dist   # dist 打包
npm run dev          # python serve.py 8080
```

---

## 8. 配置项

运行时配置定义在 `src/config.ts`（`RuntimeConfig`），主线程初始化后通过 `config` 消息全量同步到 Worker。

| 分段 | 关键项 | 默认值 |
|---|---|---|
| `physics` | mode / gravity / jumpSpeed / maxSpeed / friction / accelerate / airAccel / stopSpeed / duckScale / groundAngle / slideAngle / tickRate | physics / 800 / 302 / 250 / 4 / 10 / 100 / 100 / 0.34 / 30° / 70° / 128 |
| `player` | radius / standHeight / duckHeight / eyeOffset | 16 / 72 / 54 / 8 |
| `movement` | speed / sprintMultiplier | 200 / 4 |
| `smoothing` | speed | 12 |
| `teleport` | triggerRadius / cooldownMs | 64 / 600 |
| `lod` | pvsEnabled / updateInterval / cullDistance | true / 1 / 12800 |
| `lighting` | ambient / hemi / dir / bgColor | 默认日景 |
| `input` | sensitivity / pitchLimit / yawBindSpeed | 1.5 / 89 / 210 |
| `hud` | visible / showCrosshair | true / true |
| `debug` | showSolids / showTriggers / showPlaneInfo / teleportTriggerMode / groundedFramesRequired | false / false / false / start-touch / 1 |

> 传送触发模式（`debug.teleportTriggerMode`）影响游玩行为，物理面板可选：
> - `start-touch`（**默认**）：StartTouch 边沿触发（CS:S 引擎原生行为，外→内才触发）
> - `start-touch-grounded`：落地检测（空中不传送，落地才传送；选此项时面板显示
>   连续落地帧数滑块，1=单帧即触发 / 3-5=过滤瞬时触地 / 10=严格）
>
> 显示设置提供：
> - `showSolids`：实体碰撞箱（附近 512 HU 内 brush **真实凸包线框**，地面绿/斜坡黄/墙红；
>   玩家身处固体内部时叠加半透明实心填充提示）
> - `showTriggers`：触发碰撞箱（全部 trigger 凸包/AABB 线框，青=已链接/紫=孤儿/灰=禁用/橙=非玩家）
> - `showPlaneInfo`：**准星信息**（准星射线检测，每 6 帧限频；HUD 显示命中对象信息）

### 8.1 准星射线检测（plane-inspector）

准星对准对象时，HUD 第四行显示命中信息（显示设置「准星信息」开关，默认关闭以省性能）。
优先级：GLB 模型几何 > 实体碰撞箱 > 传送触发器（最贴近玩家所见）。

| 命中类型 | 显示信息 |
|---|---|
| 模型（`mesh`） | 模型名（GLB 节点名，如 `666_clip_1`、`mesh_12_22188`）、材质名、纹理名、属性标记（工具/nodraw/水面/半透明/发光）、距离、交点坐标 |
| 实体面（`solid`/`ladder`） | brush 索引、命中面法线、平面距离、交点坐标 |
| 触发面（`trigger`） | classname（如 `trigger_teleport`）、目标 targetname、dest 索引、是否禁用 |

算法：mesh 用 `THREE.Raycaster` 求交；brush 用 Ray-Convex-Polyhedron 精交
（Source 引擎标准 ray-trace，取 tEnter 最大者为入口平面）；trigger AABB 用
Ray-AABB slab 法 + 入口面法线推断。实现见 `src/renderer/plane-inspector.ts`。
模型名由 Rust 端导出（`model-integrator` 以模型文件 stem 命名 GLB 节点）。
