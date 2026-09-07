# WebSurf-test — 双模物理 + OffscreenCanvas 渲染时序验证工程（解析文档）

本目录是对 `test/dual-mode-harness/` 的源码解析文档。

> **当前最小集**：运行时地图导出只包含 brush 碰撞、模型碰撞（.phy 优先/可视网格回退）、
> 出生点、GLB（基本几何+材质纹理+模型）；**teleport/PVS 已从主线程导出流程排除**，
> trace/FOV 等非核心 UI 已移除。目标是排除核心运动逻辑之外的影响。

按以下文件组织：

| 文件 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 整体架构：主线程 / WorkerA / WorkerB / SAB 共享通道 / WASM 薄层 |
| [map-parsing.md](map-parsing.md) | 地图解析：支持的 BSP 版本、解析出的数据、导出集合、解析流程与坐标变换 |
| [runtime-sequence.md](runtime-sequence.md) | 运行时序图：Mermaid `sequenceDiagram` + 按节点编号的分节说明 |
| [mouse-input-analysis.md](mouse-input-analysis.md) | 鼠标输入差异分析：`src` 丝滑 vs `test/dual-mode-harness` 不丝滑的原因 |

> 事实基准：文档基于 `README.md`、`CONCLUSION.md` 及以下源码核对：
> `src/main.ts`、`src/shared-state.ts`、`src/worker-a.ts`、`src/worker-b.ts`、
> `crates/wasm/src/lib.rs`、`src/wasm-core/vbsp`。
> 如代码演进，请优先更新本文档。
