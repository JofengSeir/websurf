# WebSurf-game 文档子树

## 本子树范围

| 篇 | 回答什么问题 |
|---|---|
| `documents/game/overview.md` | 工程定位、目录职责、依赖方向、构建产物与脚本、启动链、由代码保证的不变量 |
| `documents/game/sequences.md` | 启动时序、帧链/主循环、消息与通道、异常与回退路径 |
| `documents/game/differences.md` | 与 `apps/debug`、`apps/viewer` 的**实测**差异（逐条给两侧锚点） |
| `documents/game/implementation/app-entry.md` | `apps/game/src/app.ts`：装配顺序、DOM 绑定、地图装载、加载进度覆盖层、HUD |
| `documents/game/implementation/config.md` | `apps/game/src/config.ts`：七段配置、默认值、段级部分更新、物理参数映射 |
| `documents/game/implementation/renderer.md` | `apps/game/src/renderer/**`：主线程渲染物理、场景装载、光照注入、剔除与出帧探针 |
| `documents/game/implementation/worker.md` | `apps/game/src/worker/**`：Worker 权威物理装配、渲染轨迹采样、健康护栏、消息协议类型面 |
| `documents/game/implementation/input.md` | `apps/game/src/input/**`：键位表与持久化、键盘状态、鼠标缓冲、面板参数下发桥 |
| `documents/game/implementation/panel.md` | `apps/game/src/panel/**`：八分栏面板、控件接线、偏好持久化、存点列表渲染 |
| `documents/game/implementation/savepoint.md` | `apps/game/src/savepoint.ts`：按地图分键的存点存储与容量上限 |
| `documents/game/implementation/types.md` | `apps/game/src/world/types.ts` 与 `apps/game/src/wasm.d.ts`：本工程的类型出口 |
| `documents/game/implementation/scripts.md` | `apps/game/scripts/**`：构建脚本与物理冒烟脚本、门禁覆盖面 |
| `documents/game/implementation/wasm-crate.md` | `apps/game/crates/wasm/**`：本工程 wasm 绑定层与其 Cargo 配置 |

## 事实来源

本子树全部结论取自当前源码，入口清单如下（行号随文件变动会漂，读时以符号名为准）：

- `apps/game/package.json` 的 `scripts`（`apps/game/package.json:7`）：dev 端口、构建链与三个 node 冒烟脚本。
- `apps/game/src/app.ts` 的 `main`（`apps/game/src/app.ts:94`）：主线程装配全流程，文件末 `void main()` 触发。
- `apps/game/src/config.ts` 的 `DEFAULT_CONFIG`（`apps/game/src/config.ts:176`）：七段配置的唯一默认值来源。
- `apps/game/src/worker/main.ts` 的 `createAuthLoop`（`apps/game/src/worker/main.ts:451`）：Worker 权威物理的装配点。
- `apps/game/src/renderer/renderer-main.ts` 的 `tick`（`apps/game/src/renderer/renderer-main.ts:922`）：一帧内的物理、相机、剔除与绘制。
- `apps/game/src/panel/panel-controller.ts` 的 `PanelController`（`apps/game/src/panel/panel-controller.ts:45`）：面板控件接线与偏好持久化。
- `apps/game/src/input/input-bridge.ts` 的 `sendConfig`（`apps/game/src/input/input-bridge.ts:41`）：面板参数的双端下发口。
- `apps/game/web/index.html` 的 `canvas#preview`（`apps/game/web/index.html:27`）：页面外壳与全部挂载点。

共享层侧只写「game 如何消费」三个入口：`src/ts-shared/auth/worker-dispatch.ts` 的 `createWorkerDispatch`（`src/ts-shared/auth/worker-dispatch.ts:207`）、`src/ts-shared/auth/shared-state.ts` 的 `createMainSharedState`（`src/ts-shared/auth/shared-state.ts:1022`）、`src/ts-shared/phys/world-builder.ts` 的 `buildWorldBundle`（`src/ts-shared/phys/world-builder.ts:143`）。

## 阅读顺序

1. `documents/game/overview.md`：先建立「这个工程由哪些目录构成、产物是什么、谁依赖谁」的骨架。
2. `documents/game/sequences.md`：再看启动时序与一帧内的数据流，含 main↔Worker 的消息与载荷字段。
3. `documents/game/implementation/*.md`：按模块读细节；每篇末节「已知缺口」逐条给锚点。
4. `documents/game/differences.md`：最后看与另两个工程的实测差异，避免把某个工程的实现当成三工程通例。

术语口径与另两棵子树对齐：共享物理 crate 写 `websurf-phys`（`src/phys/**`）；本工程的权威物理写「Worker 权威物理」；主线程物理写「主线程渲染物理（`predPhys`）」；通道写「SAB 通道」与「postMessage 回退」；产物形态写「single 产物」与「multi 产物」。
