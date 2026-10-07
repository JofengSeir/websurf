# 文档导航

本页是 `documents/` 的入口索引，**按当前工作区实际存在的文件重建**（不沿用任何已删索引）。每篇只回答一个问题；新增或删除文档时同步更新本页。

## 入口

| 文档 | 回答什么 |
|---|---|
| [`../README.md`](../README.md) | 仓库总览：受控范围、目录结构、快速开始、构建链、验证与门禁、已知缺口摘要 |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 当前工作区状态与各工程的版本声明 |
| [../TODO.md](../TODO.md) | **待办看板**：唯一待办与状态来源（T-###、六值状态、证据锚点） |
| [`index.md`](index.md) | 本页：全部文档的导航 |

## 共享层与架构

| 文档 | 回答什么 |
|---|---|
| [`architecture/overview.md`](architecture/overview.md) | 受控范围总架构：共享层构成、依赖方向、入口锚点、启动链与帧链、不变量、构建产物 |
| [`phys/overview.md`](phys/overview.md) | 共享物理 `websurf-phys`：世界容器、步进、玩家移动语义、传送触发、种子面 |
| [`wasm-core/overview.md`](wasm-core/overview.md) | 共享解析层 `websurf-wasm-core`：BSP、GLB、pakfile、材质与 mosaic |
| [`ts-shared/overview.md`](ts-shared/overview.md) | TS 共享层：接口锚点、主流程、不变量、**未接线与零调用点清单**（状态见 TODO.md）、测试与门禁 |
| [`materials/overview.md`](materials/overview.md) | 材质与纹理链路：VMT/VTF、缺失纹理、默认纹理包 |

## 应用工程

三棵子树的**三篇**顶层文档同名同义：overview.md（工程定位 / 目录职责 / 依赖方向 / 构建产物与脚本 / 启动链 / 不变量）、sequences.md（启动时序、帧链、消息与通道、异常与回退）、differences.md（与另外两个工程的**实测**差异）；apps/viewer 另有第四篇 replay-vs-dem.md（两条导入链路的产物与消费面差异）。原各子树 README.md 的范围与阅读顺序已并入对应 overview.md。

### `apps/debug`

| 文档 | 回答什么 |
|---|---|
| [`debug/overview.md`](debug/overview.md) | 工程定位、目录职责、依赖方向、构建产物与脚本、启动链、不变量 |
| [`debug/sequences.md`](debug/sequences.md) | 启动时序与一帧内的链路、线程间消息、异常与回退路径 |
| [`debug/differences.md`](debug/differences.md) | 与 `apps/game`、`apps/viewer` 的实测差异（两侧锚点） |
| [`debug/implementation/app.md`](debug/implementation/app.md) | 根级装配模块：面板接线、调试 API、配置树、计时状态机、默认纹理包、主线程 wasm 装载 |
| [`debug/implementation/renderer.md`](debug/implementation/renderer.md) | `renderer/**` + 渲染共享层（shader / environment / scene / camera）：主线程渲染循环与五个子管理器（lightmap 着色器、雾/光照、场景装配/合并、近平面、析构、画质切换均已下沉 `src/renderer-shared/`） |
| [`debug/implementation/worker.md`](debug/implementation/worker.md) | `worker/**`：Worker 入口装配、消息类型面、物理面板协调器 |
| [`debug/implementation/input.md`](debug/implementation/input.md) | `input/**`：键鼠采集、消息桥、录制/回放器 |
| [`debug/implementation/world.md`](debug/implementation/world.md) | `world/**`：brush 映射、传送点数据层、出生点加载器、WASM JSON 类型面 |
| [`debug/implementation/physics.md`](debug/implementation/physics.md) | `physics/**`：参数定义表、参数管理器、config → Rust 参数映射、向量与碰撞类型 |
| [`debug/implementation/web.md`](debug/implementation/web.md) | `web/**`：页面结构、id 面、样式与 COOP/COEP 补丁脚本 |
| [`debug/implementation/scripts.md`](debug/implementation/scripts.md) | `scripts/**` 与三个 `.cmd` 入口：构建、门禁、无头验收脚本 |
| [`debug/implementation/wasm-bindings.md`](debug/implementation/wasm-bindings.md) | `crates/wasm/**`：本工程的 WASM 绑定层导出面 |

### `apps/game`

| 文档 | 回答什么 |
|---|---|
| [`game/overview.md`](game/overview.md) | 工程定位、目录职责、依赖方向、构建产物与脚本、启动链、不变量 |
| [`game/sequences.md`](game/sequences.md) | 启动时序与一帧内的链路、线程间消息、异常与回退路径 |
| [`game/differences.md`](game/differences.md) | 与 `apps/debug`、`apps/viewer` 的实测差异（两侧锚点） |
| [`game/implementation/app-entry.md`](game/implementation/app-entry.md) | 根级入口装配与主线程链路 |
| [`game/implementation/config.md`](game/implementation/config.md) | 配置树、默认值与 `applyConfigPatch` |
| [`game/implementation/renderer.md`](game/implementation/renderer.md) | `renderer/**` 编排 + 渲染共享层 scene/camera 六模块（2026-10-02 拆分下沉，2026-10-04 增 dispose / texture-quality）；着色器本体在 `src/renderer-shared/shader/` |
| [`game/implementation/worker.md`](game/implementation/worker.md) | `worker/**`：Worker 入口、权威物理装配与消息类型面 |
| [`game/implementation/input.md`](game/implementation/input.md) | `input/**`：输入桥、键位与存档点 |
| [`game/implementation/panel.md`](game/implementation/panel.md) | `panel/**`：面板控制器与控件接线 |
| [`game/implementation/savepoint.md`](game/implementation/savepoint.md) | 存档点数据结构与持久化 |
| [`game/implementation/types.md`](game/implementation/types.md) | 类型面：`wasm.d.ts` 与 `world/types.ts` |
| [`game/implementation/scripts.md`](game/implementation/scripts.md) | `scripts/**`：构建、门禁与物理验收脚本 |
| [`game/implementation/wasm-crate.md`](game/implementation/wasm-crate.md) | `crates/wasm/**`：本工程的 WASM 绑定层导出面 |

### `apps/viewer`

| 文档 | 回答什么 |
|---|---|
| [`viewer/overview.md`](viewer/overview.md) | 工程定位、目录职责、依赖方向、构建产物与脚本、启动链、不变量 |
| [`viewer/sequences.md`](viewer/sequences.md) | 启动时序与一帧内的链路、线程间消息、异常与回退路径 |
| [`viewer/differences.md`](viewer/differences.md) | 与 `apps/debug`、`apps/game` 的实测差异（两侧锚点） |
| [`viewer/replay-vs-dem.md`](viewer/replay-vs-dem.md) | 记录与录像两条链路的分工与选型依据（`.replay` vs `.dem`） |
| [`viewer/implementation/app.md`](viewer/implementation/app.md) | 根级入口与页面装配 |
| [`viewer/implementation/core.md`](viewer/implementation/core.md) | `core/**`：BSP 装载、场景、相机、DOM 工具 |
| [`viewer/implementation/replay.md`](viewer/implementation/replay.md) | `replay/**`：录像解析、播放器、时间轴、轨道面板与可视化 |
| [`viewer/implementation/dem.md`](viewer/implementation/dem.md) | `replay/demo/**` + `replay/democlip.ts`：Source `.dem` 演示录像解析与 DEM→`Clip` 桥接 |
| [`viewer/implementation/ui.md`](viewer/implementation/ui.md) | `ui/**`：遥测 HUD、地图信息、录像元数据面板 |
| [`viewer/implementation/renderer.md`](viewer/implementation/renderer.md) | 渲染共享层消费面（shader + scene-builder/scene-optimizer + near-plane）：静态光照着色器落地与 3c 对齐（viewer 的 `src/renderer/` 已清空） |
| [`viewer/implementation/worker.md`](viewer/implementation/worker.md) | `worker/**`：解析 Worker 与消息协议 |
| [`viewer/implementation/wasm.md`](viewer/implementation/wasm.md) | `crates/wasm/**`：本工程的 WASM 绑定层导出面 |
| [`viewer/implementation/scripts-and-test.md`](viewer/implementation/scripts-and-test.md) | `scripts/**` 与 `test/**`：构建脚本、冒烟与自检 |

## 规范

| 文档 | 回答什么 |
|---|---|
| [`norms/annotation-and-verification.md`](norms/annotation-and-verification.md) | 事实来源与三条禁令、注释书写规范、验收判据、**已验证的陷阱清单**、记录约定 |
| [`norms/scripts-and-ci.md`](norms/scripts-and-ci.md) | 三工程脚本准入、Windows 入口 `.cmd` 契约、`.github` 部署链约束（体检 `[N]` 硬查） |
| [`norms/local-path-hygiene.md`](norms/local-path-hygiene.md) | 本机路径与隐私卫生：不许写什么、`[P]` 体检、泄漏后「改当前树 + 重写历史 + SHA 重映射」三步（体检 `[P]` 硬查） |

## 待解决问题（状态见 TODO.md）

已取证缺陷与待决项的**状态只登记在根 `TODO.md`**（`T-###`）；逐篇取证原文（原 `documents/open-issues/`）已迁至 `progress/open-issues/`，属过程记录、不作事实来源。

| 去处 | 回答什么 |
|---|---|
| [`../TODO.md`](../TODO.md) | 唯一待办看板：状态、类型、归属、证据锚点、详情 |
| [`../progress/open-issues/`](../progress/open-issues/) | 7 篇取证原文（01–07），状态以 TODO.md 为准 |

## 维护约定

- **索引只列实际存在的文件**；新增或删除文档时同步更新本页，相对链接的坏链由 `node src/scripts/check-doc-drift.mjs` 的 `[E]` 项把关。
- 三棵应用子树的节标题由统一模板固定（模板已在重编期定稿并验收，三棵子树现有顶层文档即定稿形态），不得自创分节；三篇 `implementation/` 的主题按各工程**实际目录**划分，因此篇名与篇数天然不同（debug 9 / game 10 / viewer 8）。
- 文档里的代码锚点写成 `` `文件路径:行号` ``；行号随代码变动，改代码后跑 `node src/scripts/check-doc-drift.mjs` 复核越界（`[A]` 行数声明 / `[B]` 锚点越界）；「锚点处内容是否与正文一致」仍需人工开箱，体检不覆盖。
- 应用子树的四篇顶层文档位于**旧文档的同名路径**上（旧文档树已从工作区删除、且按 B2 不重建）；正文全部按当前代码重写，与旧文档的逐字复用率为 0（重编期实测；历史台账已退役删除，git 历史 commit `6e0ecf6` 可查）。
