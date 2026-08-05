# WebSurf 项目技术文档

> **文档类型**：项目工程文档（依据当前源码编写）
> **编写基准**：2026-08-06（增量更新：M1 输入环形缓冲；架构章节已对齐 8-05 主线程渲染重构）
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
| TS 模块 | 主线程 `app.ts`（UI/输入/消息）+ Worker（物理）+ `world`（BSP 世界数据）+ `physics`（CS 移动物理）+ `renderer`（three.js，主线程渲染）；**物理控制面板**（参数/碰撞箱调节）、**碰撞箱可视化**（实体凸包线框/触发线框）、**准星射线检测**（模型/实体面/触发面信息） |
| 构建/工具 | `build-dist.cmd`（双击导出 dist）、`start-dev.cmd`（dev 服务器）、`serve.py`、`scripts/`（WASM API 契约检查/构建脚本）、docs |

---

## 2. 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│ 主线程 (src/app.ts)                                          │
│   ├─ BSP 文件 → postMessage(load-bsp 原始字节, transfer)     │
│   ├─ 输入（Pointer Lock + mousemove 过滤 → 环形缓冲写入）      │
│   ├─ 渲染（Three.js WebGLRenderer：GLB 场景/LOD/PVS/雾/准星） │
│   ├─ UI 控件（物理模式/灵敏度/视距/PVS/重生/spawn/传送点）     │
│   └─ 接收 Worker 消息更新 HUD                                 │
└───────────────┬──────────────────────────┬──────────────────┘
                │ SharedArrayBuffer        │ postMessage
                │ 输入环形缓冲 + 物理输出区  │ 低频控制/统计消息
┌───────────────▼──────────────────────────▼──────────────────┐
│ Worker (src/worker/main.ts → PhysicsWorker)                  │
│   ├─ WASM 初始化（wasm-init 消息驱动，base64/URL 两种）        │
│   ├─ load-bsp：BspProcessor 解析 → 场景数据一次 transfer      │
│   │    glb / brush / spawn / pvs / teleport（渲染主线程建场景）│
│   ├─ World + PlayerController + PvsManager + TeleportManager │
│   └─ 物理循环：frame 信号驱动 → 环形缓冲批量消费 → 固定步长    │
│       物理 → 写共享输出（lock + seq）                        │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 线程边界

| 线程 | 职责 | 关键文件 |
|---|---|---|
| 主线程 | UI / 输入采集（环形缓冲写入）/ **渲染**（Three.js + GLTFLoader + LOD/PVS）/ 准星检测 / HUD | `src/app.ts`、`src/input/*`、`src/renderer/*`、`src/config.ts` |
| Worker | WASM 解析 / 物理模拟（固定步长）/ 场景数据导出 | `src/worker/*`、`src/physics/*`、`src/world/*` |
| WASM | BSP 二进制解析 / GLB 导出 / 碰撞体生成 | `crates/wasm/src` |

### 2.2 数据流（加载一张地图）

1. 用户选择 `.bsp` 文件 → 主线程 `handleBspFile` 读字节 → `sendLoadBsp`（transfer 零拷贝）；
2. Worker `handleLoadBsp`：`new BspProcessor(bytes)` → 依次导出
   `metadata` / `parse_spawn_points` / `parse_teleports` / `parse_pvs_data` /
   `export_brushes_planes`（地图 brush）→ `export_model_colliders`（PAKFILE 模型碰撞体）
   → `export_glb_with_pakfile_models`（含回退纯地图导出）；
3. Worker 构建物理（World/PlayerController/PVS/Teleport/GameState），场景数据
   （GLB 字节 + brush/spawn/pvs/teleport JSON）经 `scene-data` 一次 transfer 主线程；
4. 主线程 `RendererMain.loadScene`：GLTFLoader 建场景 → LOD/PVS/雾/传送点/碰撞体
   → 回传死亡阈值给 Worker；UI 控件启用。

### 2.3 坐标系约定

- **BSP 原始坐标**：Z-up；
- **Rust 导出**：`[x,y,z] → [y,z,x]` 旋转为 **Y-up**（det=+1，正交变换），TS 端不二次映射；
- **角度**：yaw 在 BSP/Three.js 中均绕 up 轴，值保持一致；传送 yaw 经 `bspYawToCsYaw` 转换（`cs_yaw = (270 - bsp_yaw) % 360`）。

### 2.4 高频输入闭环（共享内存环形缓冲）

输入链路对应"持续性高频输入完整闭环"时序图（步骤 1-13；步骤 14 OffscreenCanvas 渲染为已论证偏离，渲染在主线程）。实现见 `src/worker/shared-state.ts`。

```
HW(硬件, 平台上限60-144Hz) → Browser(pointermove 节流至刷新率)
  → Main: MouseBuffer 过滤(discardNext + CLAMP@1000) → pushSample
      （4 数组写 + Atomics.store tail + 积压检测，≈63ns）
  → RingBuf(SAB 64槽 SOA: dxs/dys/tss Float64 + keys Int32)
      ├─ 积压 ≥ 8 → Atomics.notify（仅发信号）       ← 时序图步骤 6
      ├─ 满 → 覆盖最旧（消费者跟不上自动降采样）      ← 时序图步骤 7
  → Worker: frame 触发信号 → takeInput 批量读 [head, tail) ← 步骤 8-9
      → 聚合：sumDx/sumDy + lastKeys + firstTs/lastTs  ← 步骤 10
        （yaw 增量求和全保留——丢弃中间样本会致快速甩动视角跳变）
      → 固定步长物理（accumulator 补步）→ 写输出区     ← 步骤 11-13
  → Main: readFrame（lock + seq 双检查 = 无锁版本号校验语义）→ LERP → 渲染
```

关键约定：

| 项 | 约定 |
|---|---|
| SPSC | 唯一生产者=主线程（mousemove/setKeys），唯一消费者=Worker（takeInput），无锁 |
| 内存序 | 写者先写槽数据 → `Atomics.store(tail)`（release）；读者 `Atomics.load(tail)`（acquire）→ 读快照 |
| head/tail | 单调递增 Int32 计数，槽址 `& 63`；读上限 `min(tail-head, 64)` 防回绕重读 |
| keys 刷新 | `setKeys` 每帧追加零增量样本（按住键不动鼠标时按键状态持续可达） |
| 时间戳 | 每样本带 `performance.now()`；首末 ts 供诊断（M3 应用） |
| notify | 唤醒目标 = `I_IN_TAIL`：积压 ≥ 8 → `Atomics.notify`；无唤醒丢失（wait 条件不满足立即返回） |
| 输出区 | 独立 Float64 区，lock + seq 协议（seqlock），与输入环互不干扰 |

> **M2 预留**：`frame` 信号已去除时间戳（纯触发），Worker 自驱循环
> （`Atomics.wait(I_IN_TAIL, 16ms)` 被 notify 唤醒或超时兜底）落地后即成为唯一物理驱动源。

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
│   ├── renderer/           # three.js 主线程渲染（RendererMain/LOD/光照/雾/相机/lightmap/碰撞箱可视化/准星检测）
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

### 4.1 物理循环与渲染（主线程渲染架构）

- **Worker 物理循环**（`physics-loop.ts`）：收到 `frame` 触发信号 → 环形缓冲批量
  取输入（`takeInput` 聚合）→ 固定步长（`tickRate` 默认 64Hz，面板可调 48-128，
  每信号最多 `MAX_FIXED_STEPS=10` 步）→ 写共享输出；dt 由 Worker 侧
  `performance.now()` 计算（与主线程同源时钟，LERP 基准不变）；
- **主线程渲染**（`renderer-main.ts`）：rAF 循环每帧 `readFrame`（锁占用 →
  复用上一帧缓存；释放 → 读取 + seq 校验）→ 双快照 LERP 时间插值 →
  相机同步（origin + eyeHeight）→ LOD/PVS 剔除 → 雾/碰撞箱可视化/准星射线 →
  `renderer.render`。**渲染无任何人为帧率上限**（仅受浏览器 rAF 的 vsync 对齐）；
- 鼠标输入：`yaw -= dx * (sensitivity * m_yaw)`，pitch clamp ±89°（Worker 侧）；
- 近平面自适应：贴墙时动态收缩 `camera.near`（防近平面裁剪穿墙，不移动相机）；
- 传送检测：`TeleportManager.checkTeleport`（start-touch-grounded 模式，支持
  every-frame / start-touch / start-touch-grounded 三种模式）；
- HUD 帧率：`渲染 X fps`（主线程真实 rAF，每 0.5s 统计）+ `Worker Y fps`
  （帧信号处理频率，墙钟统计——不用物理 dt 累加，避免 Worker 抖动污染显示）。

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
| `init` | 传递共享内存 buffer + 画布尺寸（渲染在主线程，无 OffscreenCanvas） |
| `load-bsp` | BSP 原始字节（transfer） |
| `input` | 按键 + 鼠标增量（**仅回退模式** MsgState；共享内存模式走环形缓冲） |
| `frame` | 纯触发信号（无数据负载；物理 dt 由 Worker 侧 `performance.now()` 计算） |
| `config` | 配置分段 patch |
| `resize` | 窗口尺寸 |
| `respawn` | 重生 |
| `set-physics-mode` | noclip / physics |
| `set-physics-param` / `reset-physics-param` | 物理面板参数 |
| `set-hull` / `reset-hull` / `set-auto-restore-hull` | 碰撞箱 |
| `set-cull-distance` | 视距剔除距离 |
| `teleport` | 传送到出生点索引 |
| `teleport-to-pos` | 传送到自定义坐标 |
| `get-player-pos` | 请求玩家位置 |
| `set-death-threshold` | 掉落死亡阈值（主线程场景加载后回传） |

### 6.2 Worker → 主线程

| 消息 | 说明 |
|---|---|
| `ready` | Worker + WASM 就绪 |
| `bsp-metadata` | 地图元数据 |
| `parse-progress` | 解析阶段进度 |
| `spawn-options` | 出生点列表 |
| `scene-data` | 场景数据一次 transfer（GLB 字节 + brush/spawn/pvs/teleport JSON） |
| `phys-frame` | 物理帧（**仅回退模式**；共享内存模式走环形缓冲输出区） |
| `stats` | 渲染/Worker 帧率、位置、速度、地面状态、cluster |
| `game-stats` | 计时挑战状态 |
| `physics-snapshot` / `physics-event` | 物理面板状态 / 事件（碰撞箱自动恢复） |
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
