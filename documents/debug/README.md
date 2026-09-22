# apps/debug 文档子树

> 本子树只描述 `apps/debug` 这一受控工程。全部结论来自当前工作区的源码、脚本与配置，逐条带 `文件:行号` 锚点。

## 本子树范围

| 篇 | 回答什么问题 |
|---|---|
| `documents/debug/overview.md` | 工程定位、目录职责、依赖方向、构建产物与脚本、启动链、由代码保证的不变量 |
| `documents/debug/sequences.md` | 从点开页面到一帧结束的时序：参与者、步骤、数据落点；线程间消息与通道；异常与回退路径 |
| `documents/debug/implementation/app.md` | 根级装配模块（`apps/debug/src/*.ts`）：面板接线、调试 API、配置树、计时状态机、默认纹理包、主线程 wasm 装载 |
| `documents/debug/implementation/renderer.md` | `apps/debug/src/renderer/**`：主线程渲染循环与七个子管理器 |
| `documents/debug/implementation/worker.md` | `apps/debug/src/worker/**`：Worker 入口装配、消息类型面、物理面板协调器 |
| `documents/debug/implementation/input.md` | `apps/debug/src/input/**`：键鼠采集、消息桥、录制/回放器 |
| `documents/debug/implementation/world.md` | `apps/debug/src/world/**`：brush 映射、传送点数据层、出生点加载器、WASM JSON 类型面 |
| `documents/debug/implementation/physics.md` | `apps/debug/src/physics/**`：参数定义表、参数管理器、config → Rust 参数映射、向量工具与碰撞类型 |
| `documents/debug/implementation/web.md` | `apps/debug/web/**`：页面结构、id 面、样式与 COOP/COEP 补丁脚本 |
| `documents/debug/implementation/scripts.md` | `apps/debug/scripts/**` 与三个 `.cmd` 入口：构建、门禁、无头验收脚本 |
| `documents/debug/implementation/wasm-bindings.md` | `apps/debug/crates/wasm/**`：本工程的 WASM 绑定层导出面 |
| `documents/debug/differences.md` | 与 `apps/game`、`apps/viewer` 的**实测**差异（两侧锚点） |

`documents/debug/differences.md` 之外的各篇都含一节 `## 已知缺口`（`README.md` 与 `overview.md` 除外：前者是导航，后者的不变量与缺口在对应 implementation 篇里逐条展开）。

## 事实来源

本次重编以代码为唯一来源。本子树的主要入口文件：

- `apps/debug/package.json:7` 的 `scripts`：dev 端口、构建链与全部门禁脚本的调用名。
- `apps/debug/src/app.ts:278` 的 `main`：主线程装配入口（DOM 句柄 → 共享缓冲 → Worker → 渲染器 → 面板）。
- `apps/debug/src/renderer/renderer-main.ts:662` 的 `tick`：一帧内的物理 / 剔除 / 可视化 / 渲染顺序。
- `apps/debug/src/worker/main.ts:455` 的 `createAuthLoop` 装配：Worker 侧权威物理的唯一推进者。
- `apps/debug/src/input/input-recorder.ts:166` 的 `InputRecorder`：录制 / 回放的数据模型与失败语义。
- `apps/debug/crates/wasm/src/lib.rs:487` 的 `impl BspProcessor`：本工程 WASM 绑定层的导出面。
- `apps/debug/web/index.html:283` 起的页面骨架：全部 DOM 句柄的来源。
- `apps/debug/scripts/build-dist.mjs:75` 的 `multi` 开关：`single 产物` / `multi 产物` 两种形态的分岔点。

## 阅读顺序

1. `documents/debug/overview.md` —— 先建立「这个工程由哪些目录承担什么」的地图。
2. `documents/debug/sequences.md` —— 再看这些模块在时间轴上怎么串起来（启动、帧链、消息、回退）。
3. `documents/debug/implementation/*.md` —— 按目录逐篇深入，每篇末尾的「已知缺口」列出当前不可用的路径。
4. `documents/debug/differences.md` —— 最后对照 `apps/game` 与 `apps/viewer`，确认三工程的口径分界。
