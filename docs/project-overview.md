# WebSurf 项目文档（压缩版）

> 压缩自 `docs/PROJECT-DOCUMENTATION.md`，已对照源码核实（2026-08-06）。
> BSP 格式见 `docs/bsp-architecture.md`；导出实现细节见 `docs/bsp-export-status.md`。

---

## 1. 项目概述

**WebSurf**：浏览器内运行的 Valve BSP（Source 引擎 v20）surf 地图游玩器。
解析 `.bsp` → 导出几何/纹理/模型/碰撞/出生点/传送点/PVS → CS 风格移动物理 → three.js 渲染。

核心特性：
- **零外部资源**：纹理/模型全部来自 BSP 内嵌 PAKFILE；
- **零安装分发**：`dist/` 单文件双击运行（WASM + Worker 内嵌 base64，file:// 兼容）；
- **完整 3D 游玩**：CS 移动物理（加速/空加/摩擦/跳/蹲/梯子）、传送、重生、PVS 剔除、LOD。

技术选型：Rust→WASM（wasm-pack release，LTO+opt3）/ TypeScript ~5.7（tsc 门禁）/
three.js 0.165 / esbuild（dev ESM + dist IIFE 双模式）。

## 2. 系统架构

```
主线程 (src/app.ts)
  ├─ BSP 文件 → postMessage(load-bsp, transfer)
  ├─ 输入采集（Pointer Lock → 环形缓冲写入）
  ├─ 渲染（Three.js：GLB 场景/LOD/PVS/雾/准星）
  └─ UI 控件 + HUD
        │ SharedArrayBuffer（输入环形缓冲 + 物理输出区）  │ postMessage（低频控制/统计）
Worker (src/worker → PhysicsWorker)
  ├─ WASM 初始化（wasm-init：base64/URL）
  ├─ load-bsp：BspProcessor 解析 → scene-data 一次 transfer
  ├─ World + PlayerController + PvsManager + TeleportManager
  └─ 物理循环：frame 信号驱动 → 环形缓冲批量消费 → 固定步长 → 写共享输出
```

| 线程 | 职责 | 关键文件 |
|---|---|---|
| 主线程 | UI / 输入 / 渲染 / 准星 / HUD | `src/app.ts`、`src/input/*`、`src/renderer/*` |
| Worker | WASM 解析 / 物理模拟 / 场景导出 | `src/worker/*`、`src/physics/*`、`src/world/*` |
| WASM | BSP 解析 / GLB 导出 / 碰撞生成 | `crates/wasm/src` |

### 2.1 加载一张地图的数据流
1. 主线程读 `.bsp` 字节 → transfer 给 Worker；
2. Worker `new BspProcessor(bytes)` 依次导出：spawn/teleports/pvs → brush 碰撞 →
   模型碰撞（按 colliderSource）→ GLB（最后消费 BSP）；
3. Worker 构建物理世界，`scene-data`（GLB 字节 + 各 JSON）一次 transfer 主线程；
4. 主线程 GLTFLoader 建场景 → LOD/PVS/雾/传送/碰撞可视化 → 回传死亡阈值。

### 2.2 坐标系约定
- BSP 原始 Z-up；Rust 导出 `[x,y,z]→[y,z,x]` 转 **Y-up**（det=+1），TS 端不二次映射；
- 传送 yaw：`cs_yaw = (270 - bsp_yaw) % 360`。

### 2.3 高频输入闭环（SAB 环形缓冲）
- SPSC 无锁：主线程唯一生产者（mousemove/setKeys），Worker 唯一消费者（takeInput）；
- 64 槽 SOA（dxs/dys/tss Float64 + keys Int32），`& 63` 槽址；满则覆盖最旧（自动降采样）；
- 内存序：写者数据→`Atomics.store(tail)`(release)；读者 `load(tail)`(acquire)→读快照；
- 积压 ≥ 8 → `Atomics.notify` 唤醒 Worker；
- 消费端聚合 sumDx/sumDy + lastKeys（yaw 增量全保留，防快速甩动跳变）；
- 输出区独立 seqlock（lock + seq 双检查），主线程 readFrame → 双快照 LERP → 渲染；
- `setKeys` 每帧追加零增量样本（按住键不动鼠标时按键状态持续可达）；每样本带
  `performance.now()` 时间戳（首末 ts 供诊断）；
- **M2 预留**：`frame` 信号已去除时间戳（纯触发），Worker 自驱循环
  （`Atomics.wait(I_IN_TAIL, 16ms)` 被 notify 唤醒或超时兜底）落地后即成为唯一物理驱动源。

## 3. 目录结构（摘要）

```
crates/wasm/src/
  lib.rs               # WASM 绑定（BspProcessor 全部导出方法）
  vbsp/                # BSP 解析（21 lump，Leaves 排序修复）
  bsp_to_gltf_core/    # BSP → GLB
  model_integrator/    # MDL 模型整合（放置/网格/材质）
  pakfile_models.rs    # PAKFILE 索引、VMT 解析、薄壳碰撞
  phyfile.rs           # .phy 模型自带碰撞解析
  texture_utils/       # VTF 解码
vendor/vmdl/           # vendored vmdl 0.2.0（条带展开修复）
src/
  app.ts / config.ts   # 主线程入口 / RuntimeConfig
  input/  physics/  renderer/  worker/  world/  game/
web/  maps/  scripts/  pkg/  dist/  build-dist.cmd  start-dev.cmd  serve.py
```

## 4. 物理系统

vendored 自 `@unsurf/cs-movement`（`src/physics/`，TS 纯函数）：
- `PlayerController.tick(dt)` 管线；`World`（solids/ladders/triMeshes，由 adaptBrushes 转换）；
- 碰撞：`traceBox`（扫掠 AABB 逐平面裁剪）+ `BrushGrid` / `TriangleGrid` broadphase
  + `clipBoxToTriangle`（Minkowski 展开，与 brush 同法裁剪，双面碰撞）；
- 移动：WalkMove/AirMove/Accelerate/AirAccelerate/Friction/ClipVelocity/Jump/Duck/Ladder/
  StepMove/StuckCheck 等全套 CS 语义；
- 运行时参数 `getRuntimePhysics()` 每 tick 读取，默认 = CS:S 基准；
- **物理控制面板**（`physics-params.ts` + `param-defs.ts`）：15 项参数调节
  （地速/重力/加速/摩擦/自动连跳/模拟频率等，来源徽标区分 默认/手动）+
  碰撞箱体积调节（倍率/半宽/站高/蹲高 + 卡住自动恢复）；Worker 侧 `PhysicsParams` 管理，
  主线程经 `set-physics-param`/`set-hull` 消息操作，`physics-snapshot` 回传渲染面板，
  `physics-event` 上报碰撞箱自动恢复事件。

### 4.1 循环与渲染
- Worker：frame 信号 → takeInput 聚合 → 固定步长（tickRate 默认 64Hz，可调 48-128，
  每信号最多 10 步）→ 写共享输出；dt 用 Worker 侧 `performance.now()`；
- 主线程：rAF `readFrame`（锁占用复用上帧缓存）→ LERP → 相机同步 → LOD/PVS → 渲染，
  **无人为帧率上限**；
- 鼠标：`yaw -= dx * (sensitivity * m_yaw)`，pitch clamp ±89°；
- 近平面贴墙自适应收缩（防近平面裁剪穿墙，不移动相机）；
- 传送检测 `TeleportManager.checkTeleport` 三模式（`debug.teleportTriggerMode` 影响游玩行为）：
  - `start-touch`（**默认**）：StartTouch 边沿触发（CS:S 引擎原生行为，外→内才触发）；
  - `start-touch-grounded`：落地检测（空中不传送；面板显示连续落地帧数滑块，
    1=单帧即触发 / 3-5=过滤瞬时触地 / 10=严格）；
  - `every-frame`：每帧检测；
- HUD：`渲染 X fps`（主线程真实 rAF，每 0.5s 统计）+ `Worker Y fps`
  （帧信号处理频率，墙钟统计——不用物理 dt 累加，避免 Worker 抖动污染显示）；
- `src/game/`：计时挑战状态机，`game-stats` 消息回传。

## 5. WASM 层

单一 crate `crates/wasm` → `pkg/websurf_wasm.js`。导出 API 与生命周期约束详见
`docs/bsp-export-status.md` §1（核心：`export_glb*` 消费 BSP，其余借用方法须先调用）。

模块合并：vbsp（本地修复版）/ bsp_to_gltf_core / model_integrator / texture_utils /
pakfile_models / phyfile。

## 6. 消息协议（`src/worker/worker-types.ts`）

**主线程 → Worker**：`wasm-init` / `init`（SAB + 画布尺寸）/ `load-bsp`（transfer）/
`input`（仅回退模式）/ `frame`（纯触发）/ `config` / `resize` / `respawn` /
`set-physics-mode` / `set-physics-param` / `set-hull` 系列 / `set-cull-distance` /
`teleport` / `teleport-to-pos` / `get-player-pos` / `set-death-threshold`。

**Worker → 主线程**：`ready` / `bsp-metadata` / `parse-progress` / `spawn-options` /
`scene-data`（一次 transfer）/ `phys-frame`（仅回退模式）/ `stats` / `game-stats` /
`physics-snapshot` / `physics-event` / `player-pos` / `error`。

## 7. 构建与运行

| 命令 | 说明 |
|---|---|
| `build-dist.cmd` | ① wasm-pack release → pkg/ ② check-wasm-api.mjs 契约校验 ③ tsc + esbuild ④ build-dist.mjs 生成 dist/（WASM base64 内嵌 + Worker Blob URL） |
| `start-dev.cmd` | 缺 pkg 先构建 WASM → build:ts → `python serve.py 8080` → `http://localhost:8080/web/index.html` |
| 手动 | `npm run build:wasm` / `build:ts` / `build:dist` / `dev` |

产物：`dist/index.html` + `dist/app.js`（+ cs-movement LICENSE/NOTICE），双击运行。

## 8. 配置项（`src/config.ts` RuntimeConfig）

| 分段 | 关键项（默认） |
|---|---|
| `physics` | mode(physics) / gravity(800) / jumpSpeed(302) / maxSpeed(250) / friction(4) / accelerate(10) / airAccel(100) / tickRate(128) / **colliderSource(auto)** |
| `player` | radius(16) / standHeight(72) / duckHeight(54) / eyeOffset(8) |
| `movement` / `smoothing` | speed(200) / sprintMultiplier(4)；smoothing.speed(12) |
| `teleport` | triggerRadius(64) / cooldownMs(600) |
| `lod` | pvsEnabled(true) / updateInterval(1) / cullDistance(12800) |
| `lighting` | ambient / hemi / dir / bgColor（默认日景） |
| `input` | sensitivity(1.5) / pitchLimit(89) / yawBindSpeed(210) |
| `hud` | visible(true) / showCrosshair(true) |
| `debug` | showSolids / showTriggers / showPlaneInfo / teleportTriggerMode(start-touch) / groundedFramesRequired(1) |

### 8.1 显示与调试
- `showSolids`：附近 512 HU 实体 brush 真实凸包线框（地面绿/斜坡黄/墙红）；
- `showTriggers`：触发器线框（青=已链接/紫=孤儿/灰=禁用/橙=非玩家）；
- 模型碰撞来源着色：visual=紫 / phy=橙；
- **准星射线检测**（`showPlaneInfo`，默认关，每 6 帧限频）：优先级 GLB 模型 > 实体碰撞箱 >
  传送触发器；mesh 用 Raycaster、brush 用 Ray-Convex-Polyhedron（tEnter 最大为入口面）、
  trigger 用 Ray-AABB slab。实现 `src/renderer/plane-inspector.ts`。
