# WebSurf-mini — 核心链路最小实现

`/test/dual-mode-harness/mini` — 抽取 `/test/dual-mode-harness` 的最核心最小链路：**用户输入 → 物理 → SAB 传输 → 插值渲染输出**。剔除地图导入/导出/BSP/PVS/GLB 渲染，物理用轻量运动学演示，但**架构与完整版一致或更优**。

## 架构（四层，与 /test/dual-mode-harness 完全对齐）

```
┌─────────────┐   SAB 输入槽    ┌──────────────┐   SAB 双缓冲   ┌──────────────┐
│ main (主线程) │ ──dx/dy/keys──▶ │ WorkerA 物理  │ ──V++/8 Float64──▶ │ WorkerB 渲染  │
│ 输入收集+rAF  │ ◀──wake() 帧信号─│ 1ms 子步+tick │                 │ 插值+Offscreen│
└─────────────┘                 └──────────────┘                 └──────────────┘
```

| 层 | 职责 | 与 /test/dual-mode-harness 一致性 |
|---|---|---|
| **main** | 键盘/鼠标收集 → SAB 输入槽；rAF 每帧 `wake()`（双槽：WAKEUP 背压 + RENDER_WAKEUP 帧信号） | ✅ 一致（不做物理/渲染） |
| **WorkerA** | 1ms 无限制子步（唯一状态槽写入者）+ tick 模式B（64Hz 独立实例 + 速度校准）；背压 waitWakeup | ✅ 一致（物理换纯 JS 运动学） |
| **SAB** | 192B：输入槽（BigInt64 定点累加）+ 状态双缓冲（8×Float64×2 槽）+ V 版本号 + 计数语义 RENDER_WAKEUP | ✅ 布局逐字节一致 |
| **WorkerB** | waitRenderWakeup 帧信号驱动 + readState + **插值渲染**（yaw 最短路径 + 归一化）+ absorbRenderWake 防忙循环 | ✅ 一致（场景换原生 WebGL 网格） |

**架构更优点（继承 2026-08-12 修复）**：
- `RENDER_WAKEUP` 计数语义（`Atomics.add` 递增）+ `absorbRenderWake()` → 渲染频率严格 = min(刷新率, 1/渲染耗时)，**杜绝忙循环超限**
- 插值渲染 → 物理发布频率低时，渲染帧率仍 = 刷新率（观感平滑）
- `stats.frames++` 只在真正渲染时递增 → HUD「渲染 X f/s」= 真实渲染帧率

## 文件

```
mini/
├── index.html              # 入口（canvas + HUD + tick 率选择）
├── src/
│   ├── config.js           # ⭐ 统一配置（框架参数单一来源）
│   ├── main.js             # 主线程：输入收集 + rAF 帧信号
│   ├── shared-state.js     # SAB 通道（布局/输入/状态/唤醒，计数语义）
│   ├── worker-a.js         # WorkerA：1ms 物理 + tick 双模 + 状态发布
│   └── worker-b.js         # WorkerB：帧信号驱动 + 插值渲染（原生 WebGL）
└── scripts/
    ├── mini-verify.mjs     # Node 链路验证（无浏览器）
    └── mini-browser-verify.mjs  # Chrome headless + CDP 真实浏览器验证
```

## 配置（框架核心：参数零硬编码）

**所有可调参数集中在 `src/config.js`（createConfig）**——物理（子步长/速度/加速度/重力/灵敏度/眼高）、渲染（FOV/裁剪面/颜色/网格/方块）、输入（键位映射）、目标刷新率。业务代码（main/worker-a/worker-b）只读 `config.*`，**改参数不碰业务代码**。

```js
// 1. 改代码（src/main.js 里 createConfig 处）
const config = createConfig({ phys: { moveSpeed: 500 }, render: { fov: 90 } });

// 2. 浏览器 URL 注入（无需改代码）
//    http://localhost:8080/index.html?config={"phys":{"moveSpeed":500},"render":{"fov":90}}

// 3. 测试环境注入
globalThis.__MINI_CONFIG__ = { phys: { gravity: 1000 } }; // 在 main.js 执行前设置
```

支持局部覆盖合并（未指定字段保留默认值）；键位映射可改（`input.keyMap`）；验证脚本与业务共用同一 config.js（单一来源）。

## 运行

```bash
# 服务（COOP/COEP 头启用 SAB）
cd /d/code/project/websurf
python src/serve.py 8080 test/dual-mode-harness/mini
# 浏览器打开 http://localhost:8080/index.html
```

**操作**：点击锁定鼠标；WASD 移动（相对视角方向）、空格跳跃、R 重生；右上角切换 tick 率（0=纯 1ms 无限制 / 32/64/128 模式B）。

**HUD 语义**：「渲染 X f/s」= WorkerB 真实渲染帧率；「物理刷新 Y/s」= WorkerA 状态发布率。

## 验证

```bash
# 1. Node 链路验证（SAB 语义，无浏览器）——默认 320Hz + 3ms 渲染
cd test/dual-mode-harness/mini && node scripts/mini-verify.mjs 320 3 64 1200
#   预期：发布 ~1000/s（1ms 预算跑满）、tick ~64/s、渲染 ~300 f/s（≤ 刷新率）

# 2. 真实浏览器验证（需先起服务）
node scripts/mini-browser-verify.mjs http://localhost:8080/index.html
#   预期：crossOriginIsolated=true、HUD 显示 pos/yaw/pitch + 渲染帧率、无控制台错误
```

已知边界（与完整版一致）：Node `setInterval` 在 Windows 精度 ~15.6ms，高刷模拟需 busy-wait 线程（验证脚本已内置）；物理为运动学演示（无碰撞/无 BSP 世界），链路语义与完整版逐层对齐。
