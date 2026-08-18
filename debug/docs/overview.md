# WebSurf-debug（Debug Build）总览

> 最后核对：2026-08-13。以实际代码为准（`debug/src/` + 共享 `src/ts-shared/`）。

> 全功能调试测试页面：BSP 解析/模型导出/物理碰撞/计时挑战的完整调试环境。
> 公共架构见 `../../docs/architecture.md`；时序见 `./timing-debug.md`（主线程唯一物理渲染线 + Worker 权威帧，与 game 同模式）；材质技术见 `../../docs/materials.md`。

## 1. 定位与工程结构

| 目录 | 内容 |
|---|---|
| `crates/wasm/src/lib.rs` | WASM 导出层（BspProcessor 全部方法 + PhysWorld/画质 API re-export） |
| `src/app.ts` | 主线程入口：BSP 解析（world-builder 管线）、物理渲染线、输入层、面板、弹窗 |
| `src/renderer/` | 渲染：renderer-main（唯一物理渲染线 + AuthorityCalibrator）/ camera-controller / collider-debug / plane-inspector / fog-manager / light-manager / lod-manager / lightmap-shader |
| `src/worker/` | 权威帧：main（共享 auth-loop + worker-dispatch 接线；面板消息/回执经 onInit/onWasmInit/onWorldBuilt/onConfigApplied/onExtraMessage 钩子）/ physics-worker（物理面板参数）/ worker-types / mtz-data |
| `src/world/` | pvs-manager / spawn-loader / collider-adapter（可视化用）/ teleport-manager（可视化用）/ custom-teleports（自定义传送点持久化）/ types |
| `src/physics/` | param-defs / physics-params（面板参数管理器）；`math/vec3.ts`、`physics/Collision/Collision.types.ts`（渲染层类型，保留） |
| `src/game/` | **特色**：计时挑战状态机（GameState，主线程 take_event 消费） |
| `src/input/` | 输入层接线：input-bridge / keyboard / mouse-buffer / pointer-lock（逻辑在 ts-shared input-layer） |
| `src/main-wasm.ts` / `default-pack.ts` / `config.ts` / `wasm.d.ts` | 主线程 wasm 初始化 / 默认纹理包加载 / 运行时配置 / WASM 类型入口 |

**共享实现**（`../../src/ts-shared/`，与 game 同源，改一处双端生效）：权威帧共享内存（auth/shared-state）、权威循环（auth/auth-loop）、消息分发（auth/worker-dispatch）、校准（phys/authority-calibrator）、输入层（input/input-layer）、参数映射（phys/params）、地图导入导出（phys/world-builder）。

## 2. 功能模块

| 模块 | 说明 | 文档 |
|---|---|---|
| 材质 | 画质切换（原始/压缩低清）、缺失纹理回退、默认纹理包比对弹窗 | `debug/docs/materials.md` |
| 物理 | 主线程唯一物理渲染线 + Worker 权威帧、校准/兜底、面板参数 | `debug/docs/physics.md` |
| 渲染/调试 | 场景构建、PVS/LOD、lightmap、雾、碰撞可视化、准星射线、近平面自适应 | `debug/docs/rendering.md` |
| 游戏化 | 计时挑战（检查点/终点/死亡统计）、自定义传送点、重生 | `debug/docs/rendering.md` |
| 打包 | 双模式（single file:// / multi HTTP） | `docs/architecture.md` |

## 3. 加载流程（主线程解析）

```
选择 .bsp（文件输入；本地地图放入 `maps/` 等目录，gitignored）
  → await mainWasmReady（主线程 wasm 就绪）
  → buildWorldBundle（ts-shared：BSP 解析 → 各导出 → 默认纹理包 → GLB with defaults → 缺失纹理）
  → renderer.loadScene（GLB 自包含）+ buildPredictionWorld（主线程 PhysWorld）
  → Worker：world-json（权威 PhysWorld）+ set-spawn-points + 双端参数 config
  → 缺失纹理弹窗 → 渲染循环
```

## 4. 侧边栏面板（HTML 静态声明 + app.ts 绑定）

| 折叠区（`web/index.html` `<details>`，共 9 组） | 内容 |
|---|---|
| 文件输入 | 文件选择（.bsp） |
| 视角与操作 | 鼠标灵敏度、Q/E 旋转速度、俯仰角限制（pitchLimit） |
| 渲染与视距 | 视距上限、PVS 剔除开关、纹理画质（原始/压缩低清）、环境光强度、近平面参数（探测距离/收缩系数） |
| 物理 | 物理模式、碰撞来源、物理 tick 率、重生按钮、碰撞箱体型（倍率/半宽/站高/蹲高/自动恢复）、力学参数（13 项，动态渲染）+ 恢复全部默认 |
| 出生点 | 出生点下拉 |
| 自定义传送点 | 保存当前位置、手动添加坐标、清空 |
| 准星与 HUD | HUD 显示、准星显示、准星样式（颜色/线长/粗细/间隙/描边/中心点）、准星信息（showPlaneInfo） |
| 调试线框 | 碰撞可视化 4 开关 + 4 距离滑块（brush/trigger/phy/vis） |
| 元数据 | 元数据 KV |

控件 → `applyConfigPatch(config, ...)` + `rendererMain.applyConfigPatch` + `inputBridge.sendConfig`（三路同步）+ `saveUiPrefs`（localStorage 持久化）。
物理参数变更：面板 → `set-physics-param` 消息 → 权威 Worker `set_params` → snapshot 回传 → 主线程 predPhys 镜像（双端同参）。

## 5. 特色功能索引

- **调试 API**：`parse_entities` / `list_pakfile` / `read_pakfile_*` / `parse_bsp` / `export_visleaf_pvs`——仅 debug 导出。
- **计时挑战**：`src/game/game-state.ts`（主线程每 tick 消费 `take_event`：移动开始计时 → 传送记录检查点（同名去重）→ 终点 `*_end` 完成 → 死亡回退检查点）。
- **缺失纹理弹窗**：加载后展示缺失列表（默认包可覆盖/完全缺失），确认关闭。
- **契约校验**：`scripts/check-wasm-api.mjs`（动态差集：TS 导入 ⊆ WASM 导出）。
