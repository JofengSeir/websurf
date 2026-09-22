# 文档导航

本页是 `documents/` 的入口索引，**按当前工作区实际存在的文件重建**（不沿用任何已删索引）。每篇只回答一个问题；新增或删除文档时同步更新本页。

## 入口

| 文档 | 回答什么 |
|---|---|
| [`../README.md`](../README.md) | 仓库总览：受控范围、目录结构、快速开始、构建链、验证与门禁、已知缺口摘要 |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 当前工作区状态与各工程的版本声明 |
| [`index.md`](index.md) | 本页：全部文档的导航 |

## 共享层与架构

| 文档 | 回答什么 |
|---|---|
| [`architecture/overview.md`](architecture/overview.md) | 受控范围总架构：共享层构成、依赖方向、入口锚点、启动链与帧链、不变量、构建产物 |
| [`phys/overview.md`](phys/overview.md) | 共享物理 `websurf-phys`：世界容器、步进、玩家移动语义、传送触发、种子面 |
| [`wasm-core/overview.md`](wasm-core/overview.md) | 共享解析层 `websurf-wasm-core`：BSP、GLB、pakfile、材质与 mosaic |
| [`ts-shared/overview.md`](ts-shared/overview.md) | TS 共享层：接口锚点、主流程、不变量、**未接线与零调用点清单**、测试与门禁 |
| [`materials/overview.md`](materials/overview.md) | 材质与纹理链路：VMT/VTF、缺失纹理、默认纹理包 |

## 应用工程

三棵子树的四篇顶层文档同名同义：`README.md`（本子树范围与阅读顺序）、`overview.md`（工程定位 / 目录职责 / 依赖方向 / 构建产物与脚本 / 启动链 / 不变量）、`sequences.md`（启动时序、帧链、消息与通道、异常与回退）、`differences.md`（与另外两个工程的**实测**差异）。

### `apps/debug`

| 文档 | 回答什么 |
|---|---|
| [`debug/README.md`](debug/README.md) | 本子树范围、事实来源、阅读顺序 |
| [`debug/overview.md`](debug/overview.md) | 工程定位、目录职责、依赖方向、构建产物与脚本、启动链、不变量 |
| [`debug/sequences.md`](debug/sequences.md) | 启动时序与一帧内的链路、线程间消息、异常与回退路径 |
| [`debug/differences.md`](debug/differences.md) | 与 `apps/game`、`apps/viewer` 的实测差异（两侧锚点） |
| [`debug/implementation/app.md`](debug/implementation/app.md) | 根级装配模块：面板接线、调试 API、配置树、计时状态机、默认纹理包、主线程 wasm 装载 |
| [`debug/implementation/renderer.md`](debug/implementation/renderer.md) | `renderer/**`：主线程渲染循环与七个子管理器 |
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
| [`game/README.md`](game/README.md) | 本子树范围、事实来源、阅读顺序 |
| [`game/overview.md`](game/overview.md) | 工程定位、目录职责、依赖方向、构建产物与脚本、启动链、不变量 |
| [`game/sequences.md`](game/sequences.md) | 启动时序与一帧内的链路、线程间消息、异常与回退路径 |
| [`game/differences.md`](game/differences.md) | 与 `apps/debug`、`apps/viewer` 的实测差异（两侧锚点） |
| [`game/implementation/app-entry.md`](game/implementation/app-entry.md) | 根级入口装配与主线程链路 |
| [`game/implementation/config.md`](game/implementation/config.md) | 配置树、默认值与 `applyConfigPatch` |
| [`game/implementation/renderer.md`](game/implementation/renderer.md) | `renderer/**`：渲染主循环与静态光照着色器落地 |
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
| [`viewer/README.md`](viewer/README.md) | 本子树范围、事实来源、阅读顺序 |
| [`viewer/overview.md`](viewer/overview.md) | 工程定位、目录职责、依赖方向、构建产物与脚本、启动链、不变量 |
| [`viewer/sequences.md`](viewer/sequences.md) | 启动时序与一帧内的链路、线程间消息、异常与回退路径 |
| [`viewer/differences.md`](viewer/differences.md) | 与 `apps/debug`、`apps/game` 的实测差异（两侧锚点） |
| [`viewer/implementation/app.md`](viewer/implementation/app.md) | 根级入口与页面装配 |
| [`viewer/implementation/core.md`](viewer/implementation/core.md) | `core/**`：BSP 装载、场景、相机、DOM 工具 |
| [`viewer/implementation/replay.md`](viewer/implementation/replay.md) | `replay/**`：录像解析、播放器、时间轴、轨道面板与可视化 |
| [`viewer/implementation/ui.md`](viewer/implementation/ui.md) | `ui/**`：遥测 HUD、地图信息、录像元数据面板 |
| [`viewer/implementation/renderer.md`](viewer/implementation/renderer.md) | `renderer/**`：静态光照着色器落地 |
| [`viewer/implementation/worker.md`](viewer/implementation/worker.md) | `worker/**`：解析 Worker 与消息协议 |
| [`viewer/implementation/wasm.md`](viewer/implementation/wasm.md) | `crates/wasm/**`：本工程的 WASM 绑定层导出面 |
| [`viewer/implementation/scripts-and-test.md`](viewer/implementation/scripts-and-test.md) | `scripts/**` 与 `test/**`：构建脚本、冒烟与自检 |

## 规范与计划

| 文档 | 回答什么 |
|---|---|
| [`norms/annotation-and-verification.md`](norms/annotation-and-verification.md) | 事实来源与三条禁令、注释书写规范、验收判据、**已验证的陷阱清单**、记录约定 |
| [`plan/doc-rewrite-taskbook.md`](plan/doc-rewrite-taskbook.md) | 文档/注释重编任务书：流程、规范、术语、任务拆分与上报约定 |
| [`plan/project-survey.md`](plan/project-survey.md) | 读码事实基线：目录结构、模块划分、依赖矩阵、主流程与时序骨架、必读源码清单 |
| [`plan/progress-log.md`](plan/progress-log.md) | 逐行进度台账；**全部已结案项与待裁决项**（含疑似缺陷清单）都在这里 |

## 维护约定

- **索引只列实际存在的文件**；新增或删除文档时同步更新本页，并跑 `node .tmp/tools/link-check.mjs documents` 复核链接。
- 三棵应用子树的节标题由统一模板固定（模板与验收口径见 `documents/plan/progress-log.md` 中 WG9 相关条目），不得自创分节；三篇 `implementation/` 的主题按各工程**实际目录**划分，因此篇名与篇数天然不同（debug 9 / game 10 / viewer 8）。
- 文档里的代码锚点写成 `` `文件路径:行号` ``；行号随代码变动，改代码后跑 `node src/scripts/check-doc-drift.mjs` 复核越界，并用 `node .tmp/tools/anchor-open.mjs <目录>` 抽样开箱确认锚点指向的内容与正文一致。
- 应用子树的四篇顶层文档位于**旧文档的同名路径**上（旧文档树已从工作区删除、且按 B2 不重建）；正文全部按当前代码重写，与旧文档的逐字复用率为 0（实测见 `documents/plan/progress-log.md` 的 B2 合规行）。
