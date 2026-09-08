# WebSurf 文档导航

> 全仓文档树入口。阅读层次自上而下：**总架构 → 共享层 → 工程总览 → 细分实现 → 差异对照**。
> 所有链接均为相对路径且指向真实文件；历史分析文档已移入各处 `archive/`，仅作背景，不作为事实来源。
> 文档铁律：内容以实际代码为准（每篇标注 `文件:行号`）；与代码不一致时以代码为准并回改文档。

## 1. 快速入口（按你想做什么）

| 你想… | 入口 |
|---|---|
| 理解仓库怎么组成、共享层谁在用 | [architecture.md](./architecture.md)（总架构：workspace 划界 / 共享层引用矩阵 / 构建链 / 数据流） |
| 改物理行为 | [phys.md](./phys.md)（Rust 物理内核）+ [ts-shared.md](./ts-shared.md)（权威循环/校准） |
| 改地图解析 / GLB 导出 / 材质字节码 | [wasm-core.md](./wasm-core.md)（BSP→GLB 三条消费流）+ [materials.md](./materials.md)（材质体系全景与消费链） |
| 玩 / 改游戏体验 | [game/docs/overview.md](../game/docs/overview.md)（存点/面板/键位/画质） |
| 调物理参数 / 调渲染 | [debug/docs/overview.md](../debug/docs/overview.md)（物理面板/碰撞可视化/准星检查） |
| 看图 / 放录像 | [viewer/docs/overview.md](../viewer/docs/overview.md) + [shavit-replay-format.md](../viewer/docs/implementation/shavit-replay-format.md)（`.replay` 格式规格） |
| 验证物理时序 / 跑对照 | [test/dual-mode-harness/docs/overview.md](../test/dual-mode-harness/docs/overview.md) |

## 2. 文档树（当前全量，28 篇）

### 根 docs/（5 篇：总架构 + 共享层四篇）

| 文档 | 覆盖 |
|---|---|
| [architecture.md](./architecture.md) | 仓库组成与边界、共享层引用矩阵、构建/运行链、BSP→解析→物理→渲染数据流、各工程差异一览、已知残留汇总 |
| [phys.md](./phys.md) | `websurf-phys`：crate 身份、build_world 五步、tick/三状态出口、扫掠碰撞、传送/死亡、21 导出面、harness 关系 |
| [wasm-core.md](./wasm-core.md) | `websurf-wasm-core`：vbsp 修复、GLB 导出、模型合并、PAKFILE/phyfile/VTF、mosaic v4 DSL 与 MTZ 容器、各工程导出面差异 |
| [ts-shared.md](./ts-shared.md) | TS 共享层：512B SAB 布局、KEY_MASK、v7 权威帧双线、buildWorldBundle 管线、Worker 消息表、校准四件套、harness 192B 对照 |
| [materials.md](./materials.md) | 材质体系全景：VTF 解码/mosaic 字节码/MTZ 容器三件套、双端导出面、三条消费链（GLB 回退/画质切换/缺失比对）、默认纹理包装配 |

### debug/docs/（6 篇：主工程）

| 文档 | 维度 |
|---|---|
| [overview.md](../debug/docs/overview.md) | A：权威帧计算器 + 调试工作台定位、两阶段架构图、入口链与构建产物 |
| [sequences.md](../debug/docs/sequences.md) | T：启动、双线 tick、加载、面板四条主时序 |
| [implementation/loading-pipeline.md](../debug/docs/implementation/loading-pipeline.md) | I：地图 → 场景 + 两个物理世界 |
| [implementation/rendering.md](../debug/docs/implementation/rendering.md) | I：渲染与调试可视化 |
| [implementation/physics-panel.md](../debug/docs/implementation/physics-panel.md) | I：参数面板全链路 |
| [differences.md](../debug/docs/differences.md) | D：vs game/viewer/test 取舍、双端同参不变量 |

### game/docs/（5 篇：游戏工程）

| 文档 | 维度 |
|---|---|
| [overview.md](../game/docs/overview.md) | A：激进最小化游戏化、v7 架构总图、工程形态 |
| [sequences.md](../game/docs/sequences.md) | T：启动/加载/双线程帧循环/校准与反向同步/SAB 协议 |
| [implementation/panel-and-input.md](../game/docs/implementation/panel-and-input.md) | I：输入采集链、键位录制、PointerLock、面板七模块 |
| [implementation/gameplay.md](../game/docs/implementation/gameplay.md) | I：存点/出生点/渲染体验/死亡阈值/PVS 现状 |
| [differences.md](../game/docs/differences.md) | D：vs debug（同构中的最小化）/viewer/test、共享层取舍 |

### viewer/docs/（7 篇：游览与回放工程）

| 文档 | 维度 |
|---|---|
| [overview.md](../viewer/docs/overview.md) | A：无物理"看"工程、构建链（产物不入库）、分层架构 |
| [sequences.md](../viewer/docs/sequences.md) | T：启动→BSP 加载→GLB 挂载→录像导入→帧循环→深链 |
| [implementation/scene-core.md](../viewer/docs/implementation/scene-core.md) | I：场景/相机/常量/DOM/HUD/面板基建 |
| [implementation/replay-system.md](../viewer/docs/implementation/replay-system.md) | I：录像回放全系统（.replay 原生解析/shavit-replay/build/sampling/面板/测试） |
| [implementation/shavit-replay-format.md](../viewer/docs/implementation/shavit-replay-format.md) | I：Shavit `.replay` 二进制格式规格（replay-file.inc 对齐 + 真实文件逐字节验证 + 坐标定标） |
| [replay-rule-ai.md](../viewer/docs/replay-rule-ai.md) | 历史注记：`.js` 规则脚本通道已移除（原稿存 archive/，不再作为事实来源） |
| [differences.md](../viewer/docs/differences.md) | D：无物理/单线程/不引 ts-shared 的边界与反向印证 |

### test/dual-mode-harness/docs/（5 篇：验证工程）

| 文档 | 维度 |
|---|---|
| [overview.md](../test/dual-mode-harness/docs/overview.md) | A：三线程 + 一块共享内存、最小集取舍、阶段编号 |
| [sequences.md](../test/dual-mode-harness/docs/sequences.md) | T：启动链、双槽唤醒与双缓冲协议、BSP 加载、消息回退 |
| [implementation/dual-physics.md](../test/dual-mode-harness/docs/implementation/dual-physics.md) | I：WorkerA 双模物理 |
| [implementation/shared-layout.md](../test/dual-mode-harness/docs/implementation/shared-layout.md) | I：TestShared 192B 布局与 WorkerB 渲染 |
| [differences.md](../test/dual-mode-harness/docs/differences.md) | D：vs game/debug/viewer、192B vs 512B 对照 |

> 工程根说明文档（操作/部署）：[game/README.md](../game/README.md) · [viewer/README.md](../viewer/README.md) · [test/dual-mode-harness/README.md](../test/dual-mode-harness/README.md)（验证工程）· [test/instanced-diorama/README.md](../test/instanced-diorama/README.md)（第二验证工程，未单开文档树）。debug 工程无根 README，其操作说明见 [debug/docs/overview.md](../debug/docs/overview.md)。

## 3. 阅读路径建议

- **新人通读**：architecture.md §1-§4 → 想深入哪个工程就进其 overview + sequences → 细分实现按需 → differences 收尾。
- **改共享层**：phys.md / wasm-core.md / ts-shared.md → 对应工程 differences.md 的"共享层取舍"节 → 改后核对 architecture.md §5 不变量清单。
- **放录像 / 调映射**：viewer/docs/implementation/shavit-replay-format.md（格式规格）→ viewer/docs/implementation/replay-system.md（实现细节）。
- **排查时序问题**：debug/docs/sequences.md（权威帧双线）↔ test/dual-mode-harness/docs/sequences.md（对照系）。

## 4. 归档说明

历史分析文档（旧 overview/physics/panel/材质/timing 专题/chamfer-physics/phys-fix-directions 等）已于 2026-09 全部移入五处 `docs/archive/`：
`docs/archive/` · `debug/docs/archive/` · `game/docs/archive/` · `test/dual-mode-harness/docs/archive/` · `viewer/docs/archive/`。
其中三份旧根文档的现行承接：材质技术 → [materials.md](./materials.md)（t18 重建篇，收敛三处 archive 旧档）；物理修复方向与 chamfer-physics 机制分析 → [archive/](./archive/)（历史快照，无重建计划）。
