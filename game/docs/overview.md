# game（WebSurf-game）总览

> 最后核对：2026-08-11。以实际代码为准（`game/src/` + 共享 `src/ts-shared/`）。

> 最小化游戏化实现：Rust 物理 + 单权威 Worker（v7 定案：主线程唯一物理渲染线 + Worker 权威帧计算器）。
> 公共架构见 `docs/architecture.md`；时序见 `docs/timing-game.md`；材质技术见 `docs/materials.md`。

## 1. 定位与工程结构

| 目录 | 内容 |
|---|---|
| `crates/wasm/src/lib.rs` | WASM 导出层（唯一文件：BspProcessor + PhysWorld/画质 API re-export） |
| `src/app.ts` | 主线程入口：BSP 解析、物理线、输入层、桥 |
| `src/config.ts` | 运行时配置（physics/input/player/hud/texture） |
| `src/renderer/renderer-main.ts` | 渲染 + 主线程 PhysWorld（唯一物理渲染线）+ 权威校准 |
| `src/worker/main.ts` | 权威帧计算器（固定步长 64/128Hz） |
| `src/ts-shared/auth/shared-state.ts` | SAB（输入槽 + 权威双缓冲）/ MsgState 回退（共享层，仓库根） |
| `src/world/` | pvs-manager / types（PVS 剔除） |
| `src/panel/panel-controller.ts` | ESC 弹出面板（左导航 + 右设置 + 键位录制） |
| `src/input/` | input-bridge / keyboard / keymap / mouse-buffer / pointer-lock |

## 2. 功能模块

| 模块 | 说明 | 文档 |
|---|---|---|
| 物理 | 主线程唯一物理渲染线 + Worker 权威帧、双通道、校准/兜底 | `game/docs/physics.md` |
| 材质 | 画质切换、缺失纹理回退（GLB 导出期） | `game/docs/materials.md` |
| 面板/操作 | ESC 面板、键位自定义、noclip、速度面板、准星 | `game/docs/panel.md` |
| 打包 | 双模式（single file:// / multi HTTP） | `docs/architecture.md` |

## 3. 加载流程（主线程解析）

```
选择 .bsp → BspProcessor（主线程）
  → 借用导出（brush/tri/teleport/spawn/pvs）
  → 默认纹理包（内嵌或 fetch）→ export_glb_with_pakfile_models_with_defaults（缺失回退）
  → renderer.loadScene（GLB + PVS + mosaicManifest）
  → renderer.buildPredictionWorld（主线程 PhysWorld）
  → Worker：world-json（权威 PhysWorld）+ set-spawn-points
  → 渲染循环
```

## 4. 与 debug 的差异速览

> debug 已采用与 game 相同的物理渲染模式（共享 `src/ts-shared/`），核心时序一致；差异仅剩工程特有逻辑。

| 项 | debug | game |
|---|---|---|
| BSP 解析/导出/物理渲染 | 主线程（共享 world-builder + PhysWorld，同 game 模式） | 主线程 |
| 权威帧 Worker | 共享 auth-loop / worker-dispatch | 共享 auth-loop / worker-dispatch |
| 面板 | 侧边栏 | ESC 弹出 |
| 特色 | 计时挑战、调试可视化、自定义传送点、缺失纹理弹窗、物理面板参数 | 键位自定义、noclip、速度面板 |
