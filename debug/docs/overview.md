# WebSurf-debug（Debug Build）总览

> 全功能调试测试页面：BSP 解析/模型导出/物理碰撞/计时挑战的完整调试环境。
> 公共架构见 `docs/architecture.md`；时序见 `docs/timing-debug.md`；材质技术见 `docs/materials.md`。
> 本文档：`debug/` 工程总览、功能模块、面板、加载流程、特色功能索引。

## 1. 定位与工程结构

| 目录 | 内容 |
|---|---|
| `crates/wasm/src/lib.rs` | WASM 导出层（BspProcessor 全部方法 + PhysWorld/画质 API re-export） |
| `crates/wasm/src/shell_colliders.rs` | **特色**：薄壳 brush 模型碰撞（`export_model_colliders` 等） |
| `crates/wasm/src/debug_probe.rs` | **特色**：测试探针（`cargo test` 用，不进 WASM 产物） |
| `src/app.ts` | 主线程入口：Worker 编排、面板绑定、弹窗、输入 |
| `src/renderer/` | 渲染：renderer-main / camera-controller / collider-debug / plane-inspector / fog-manager / light-manager / lod-manager / lightmap-shader |
| `src/worker/` | Worker：main / physics-worker（协调）/ physics-loop（物理循环）/ shared-state（SAB+回退）/ mtz-data |
| `src/world/` | pvs-manager / spawn-loader / collider-adapter（可视化用）/ teleport-manager（可视化用）/ types |
| `src/physics/` | param-defs / physics-params（面板参数管理器）；`math/vec3.ts`、`physics/Collision/Collision.types.ts`（渲染层类型，保留） |
| `src/game/` | **特色**：计时挑战状态机（GameState） |
| `src/main-wasm.ts` / `default-pack.ts` | 主线程 wasm 懒初始化 / 默认纹理包加载 |

## 2. 功能模块

| 模块 | 说明 | 文档 |
|---|---|---|
| 材质 | 画质切换（原始/压缩低清）、缺失纹理回退、默认纹理包比对弹窗 | `debug/docs/materials.md` |
| 物理 | Worker 固定步长物理（Rust PhysWorld）、面板参数、碰撞箱、noclip | `debug/docs/physics.md` |
| 渲染/调试 | 场景构建、PVS/LOD、lightmap、雾、碰撞可视化、准星射线、近平面自适应 | `debug/docs/rendering.md` |
| 游戏化 | 计时挑战（检查点/终点/死亡统计）、自定义传送点、重生 | `debug/docs/rendering.md` |
| 打包 | 双模式（single file:// / multi HTTP） | `docs/architecture.md` |

## 3. 加载流程

```
选择 .bsp（文件输入；地图放 src/maps/）
  → Worker：BSP 解析 → 各导出（碰撞/PVS/出生点/传送点/manifest/缺失列表）
  → 默认纹理包（内嵌或 fetch）→ GLB 导出（含缺失回退）
  → scene-data 一次 transfer 主线程
  → 主线程：GLTFLoader 建场景 → LOD/PVS/lightmap → 缺失纹理弹窗 → 渲染
```

## 4. 侧边栏面板（HTML 静态声明 + app.ts 绑定）

| 折叠区（`web/index.html` `<details>`） | 内容 |
|---|---|
| 加载地图 / 出生点 / 元数据（三个独立折叠区 + 顶部状态条） | 文件选择、状态、出生点下拉、元数据 |
| 物理 | 参数滑块/开关（13 项）、碰撞箱体型、自动恢复开关、传送触发模式、重生按钮 |
| 视距与视角 | 视距剔除滑块、PVS 开关 |
| 显示设置 | HUD、准星风格化、纹理画质、近平面参数、showSolids / showTriggers / 准星信息（showPlaneInfo） |
| 自定义传送点 | 保存当前位置、坐标传送、清空 |

控件 → `applyConfigPatch(config, ...)` + `rendererMain.applyConfigPatch` + `inputBridge.sendConfig`（三路同步）+ `saveUiPrefs`（localStorage 持久化）。

## 5. 特色功能索引

- **薄壳碰撞**：`export_model_colliders`（逐三角挤出 4.0 薄壳，>4096 三角回退整体 OBB）——`crates/wasm/src/shell_colliders.rs`，与共享解析层解耦（仅 debug 打包包含）。
- **调试 API**：`parse_entities` / `list_pakfile` / `read_pakfile_*` / `parse_bsp` / `export_visleaf_pvs`——仅 debug 导出。
- **计时挑战**：`src/game/game-state.ts`（移动开始计时 → 传送记录检查点 → 终点 `*_end` 完成 → 死亡回退检查点）。
- **缺失纹理弹窗**：加载后展示缺失列表（默认包可覆盖/完全缺失），确认关闭。
- **契约校验**：`scripts/check-wasm-api.mjs`（动态差集：TS 导入 ⊆ WASM 导出）。
