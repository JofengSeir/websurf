# WebSurf 文档导航

> 全仓文档树入口。阅读层次自上而下：**总架构 → 共享层 → 工程总览 → 细分实现 → 差异对照**。
> 所有链接均为相对路径且指向真实文件；历史分析文档多数已移出版本库（当前仅 `test/dual-mode-harness/docs/archive/` 保留），仅作背景，不作为事实来源。
> 文档铁律：内容以实际代码为准（每篇标注 `文件:行号`）；与代码不一致时以代码为准并回改文档。

## 1. 快速入口（按你想做什么）

| 你想… | 入口 |
|---|---|
| 理解仓库怎么组成、共享层谁在用 | [architecture.md](./architecture.md)（总架构：workspace 划界 / 共享层引用矩阵 / 构建链 / 数据流） |
| 改物理行为 | [phys.md](./phys.md)（Rust 物理内核）+ [ts-shared.md](./ts-shared.md)（权威循环/校准） |
| 改地图解析 / GLB 导出 / 材质字节码 | [wasm-core.md](./wasm-core.md)（BSP→GLB 三条消费流）+ [materials.md](./materials.md)（材质体系全景与消费链） |
| 玩 / 改游戏体验 | [documents/game/overview.md](./game/overview.md)（存点/面板/键位/画质） |
| 调物理参数 / 调渲染 | [documents/debug/overview.md](./debug/overview.md)（物理面板/碰撞可视化/准星检查） |
| 看图 / 放录像 | [documents/viewer/overview.md](./viewer/overview.md) + [shavit-replay-format.md](./viewer/implementation/shavit-replay-format.md)（`.replay` 格式规格） |
| 验证物理时序 / 跑对照 | [test/dual-mode-harness/docs/overview.md](../test/dual-mode-harness/docs/overview.md) |
| 建新子工程 / 统一启动方式与文件结构 / 判断什么该上提到 `src/` | [framework-launch-structure.md](./framework-launch-structure.md)（启动·结构·产物规范）+ [framework-decoupling.md](./framework-decoupling.md)（共享层解耦裁决）+ [framework-audit.md](./framework-audit.md)（现状事实基线） |

## 2. 文档树（documents/ 下全量 29 篇，含本文 index.md 自身；test/dual-mode-harness/docs/ 5 篇验证工程文档另列；历史档案与过程讨论已移出版本库（2026-09-11））

### 根 documents/（11 篇：总架构 + 共享层四篇 + 三篇仓库框架规范 + 本导航）

| 文档 | 覆盖 |
|---|---|
| [architecture.md](./architecture.md) | 仓库组成与边界、共享层引用矩阵、构建/运行链、BSP→解析→物理→渲染数据流、各工程差异一览、已知残留汇总 |
| [phys.md](./phys.md) | `websurf-phys`：crate 身份、build_world 五步、tick/三状态出口、扫掠碰撞、传送/死亡、`float_roundtrip` 位级契约（§3.5）、21 导出面、harness 关系 |
| [wasm-core.md](./wasm-core.md) | `websurf-wasm-core`：vbsp 修复、GLB 导出、模型合并、PAKFILE/phyfile/VTF、mosaic v4 DSL 与 MTZ 容器、各工程导出面差异 |
| [ts-shared.md](./ts-shared.md) | TS 共享层：512B SAB 布局、KEY_MASK、v7 权威帧双线、buildWorldBundle 管线、Worker 消息表、校准四件套、harness 192B 对照 |
| [materials.md](./materials.md) | 材质体系全景：VTF 解码/mosaic 字节码/MTZ 容器三件套、双端导出面、三条消费链（GLB 回退/画质切换/缺失比对）、默认纹理包装配 |
| [framework-audit.md](./framework-audit.md) | 仓库框架现状审计（事实基线）：三工程启动/构建入口对照、产物与输出对照、文件结构对照、`src/` 共享层消费矩阵、`I-01..I-22` 不一致清单、`R-01..R-21` 规范需求条款 |
| [framework-launch-structure.md](./framework-launch-structure.md) | 启动方式/文件结构/产物与输出统一规范：三件套入口语义、`start-dev.cmd` 三条件判据、10 端口段固定槽位、`.cmd` 输出逐字模板、相对路径层数对照表、豁免清单、新工程脚手架清单 |
| [framework-decoupling.md](./framework-decoupling.md) | 共享层解耦方案：上提判定准则（级别 A/A′/B/C）、`D-01..D-23` 逐项裁决与反向否决理由、`src/` 目标结构、viewer 正当隔离专项、三批迁移顺序与回滚、`E-01..E-08` 例外表 |
| [rollout-plan.md](./rollout-plan.md) | 批 2/3/4 逐文件施工计划：动作表（动作/源路径/目标路径/同步改动/验收命令与判据/依据编号）、两条硬约束实测、esbuild 注入方案、文件冲突面与每批回滚 |
| [rollout-status.md](./rollout-status.md) | 框架改造交付状态与遗留登记：批次状态总表（附提交号与实际提交边界）、C 类旧路径逐条处置、全仓体检实测、`R-n` 遗留项与去向 |

### documents/debug/（6 篇：主工程）

| 文档 | 维度 |
|---|---|
| [overview.md](./debug/overview.md) | A：权威帧计算器 + 调试工作台定位、两阶段架构图、入口链与构建产物 |
| [sequences.md](./debug/sequences.md) | T：启动、双线 tick、加载、面板四条主时序 |
| [implementation/loading-pipeline.md](./debug/implementation/loading-pipeline.md) | I：地图 → 场景 + 两个物理世界 |
| [implementation/rendering.md](./debug/implementation/rendering.md) | I：渲染与调试可视化 |
| [implementation/physics-panel.md](./debug/implementation/physics-panel.md) | I：参数面板全链路 |
| [differences.md](./debug/differences.md) | D：vs game/viewer/test 取舍、双端同参不变量 |

### documents/game/（5 篇：游戏工程）

| 文档 | 维度 |
|---|---|
| [overview.md](./game/overview.md) | A：激进最小化游戏化、v7 架构总图、工程形态 |
| [sequences.md](./game/sequences.md) | T：启动/加载/双线程帧循环/校准与反向同步/SAB 协议 |
| [implementation/panel-and-input.md](./game/implementation/panel-and-input.md) | I：输入采集链、键位录制、PointerLock、面板七模块 |
| [implementation/gameplay.md](./game/implementation/gameplay.md) | I：存点/出生点/渲染体验/死亡阈值/PVS 现状 |
| [differences.md](./game/differences.md) | D：vs debug（同构中的最小化）/viewer/test、共享层取舍 |

### documents/viewer/（7 篇：游览与回放工程）

| 文档 | 维度 |
|---|---|
| [overview.md](./viewer/overview.md) | A：无物理"看"工程、构建链（产物不入库）、分层架构 |
| [sequences.md](./viewer/sequences.md) | T：启动→BSP 加载→GLB 挂载→录像导入→帧循环→深链 |
| [implementation/scene-core.md](./viewer/implementation/scene-core.md) | I：场景/相机/常量/DOM/HUD/面板基建 |
| [implementation/replay-system.md](./viewer/implementation/replay-system.md) | I：录像回放全系统（.replay 原生解析/shavit-replay/build/sampling/面板/测试） |
| [implementation/shavit-replay-format.md](./viewer/implementation/shavit-replay-format.md) | I：Shavit `.replay` 二进制格式规格（replay-file.inc 对齐 + 真实文件逐字节验证 + 坐标定标） |
| [replay-rule-ai.md](./viewer/replay-rule-ai.md) | 历史注记：`.js` 规则脚本通道已移除（原稿存 archive/，不再作为事实来源） |
| [differences.md](./viewer/differences.md) | D：无物理/单线程/不引 ts-shared 的边界与反向印证 |

> 曾列于本表的 `phys-plan-discuss/`（4 篇：t2-bench-brief / t5-user-test-guide-consumer-engineer / t8-user-test-guide / tick-mode-handover）与 `discussion/`（1 篇：r3-memo-phys-researcher）已随工作区精简移出版本库，不再作为事实来源（见 git 历史）。

### test/dual-mode-harness/docs/（5 篇：验证工程）

| 文档 | 维度 |
|---|---|
| [overview.md](../test/dual-mode-harness/docs/overview.md) | A：三线程 + 一块共享内存、最小集取舍、阶段编号 |
| [sequences.md](../test/dual-mode-harness/docs/sequences.md) | T：启动链、双槽唤醒与双缓冲协议、BSP 加载、消息回退 |
| [implementation/dual-physics.md](../test/dual-mode-harness/docs/implementation/dual-physics.md) | I：WorkerA 双模物理 |
| [implementation/shared-layout.md](../test/dual-mode-harness/docs/implementation/shared-layout.md) | I：TestShared 192B 布局与 WorkerB 渲染 |
| [differences.md](../test/dual-mode-harness/docs/differences.md) | D：vs game/debug/viewer、192B vs 512B 对照 |

> 工程根说明文档（操作/部署）：[apps/debug/README.md](../apps/debug/README.md) · [apps/game/README.md](../apps/game/README.md) · [apps/viewer/README.md](../apps/viewer/README.md) · [test/dual-mode-harness/README.md](../test/dual-mode-harness/README.md)（验证工程）。
> Agent 工作规范见根 [AGENTS.md](../AGENTS.md)。

## 3. 阅读路径建议

- **新人通读**：architecture.md §1-§4 → 想深入哪个工程就进其 overview + sequences → 细分实现按需 → differences 收尾。
- **改共享层**：phys.md / wasm-core.md / ts-shared.md → 对应工程 differences.md 的"共享层取舍"节 → 改后核对 architecture.md §5 不变量清单。
- **放录像 / 调映射**：documents/viewer/implementation/shavit-replay-format.md（格式规格）→ documents/viewer/implementation/replay-system.md（实现细节）。
- **排查时序问题**：documents/debug/sequences.md（权威帧双线）↔ test/dual-mode-harness/docs/sequences.md（对照系）。

## 4. 归档说明

历史分析文档（旧 overview/physics/panel/材质/timing 专题/chamfer-physics/phys-fix-directions 等）曾于 2026-09 移入五处 `archive/`。**当前版本库内只保留 [`test/dual-mode-harness/docs/archive/`](../test/dual-mode-harness/docs/archive/)（5 篇）**；`documents/archive/` 与 `documents/{debug,game,viewer}/archive/` 已随工作区精简移出（见 git 历史），不再作为事实来源。
其中三份旧根文档的现行承接：材质技术 → [materials.md](./materials.md)（t18 重建篇，收敛三处 archive 旧档）；物理修复方向与 chamfer-physics 机制分析 → 历史快照已移出版本库（见 git 历史），无重建计划。
