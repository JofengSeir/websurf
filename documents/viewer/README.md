# WebSurf-viewer 文档子树

> 本子树只覆盖 `apps/viewer`（BSP 地图预览 + Shavit `.replay` 回放查看器）。全部结论以当前源码、构建脚本与配置为唯一来源；引用代码一律写成「相对仓库根路径:行号」并同时给出符号名。
> 术语：本工程**无权威物理**，只有「离线解析（`websurf-wasm-core`）」；不含「Worker 权威物理」与「主线程渲染物理（`predPhys`）」。

---

## 本子树范围

| 篇 | 回答什么问题 |
|---|---|
| `documents/viewer/overview.md` | 工程定位、目录职责、依赖方向、`package.json` 每个 script 的职责、启动链、由代码保证的不变量 |
| `documents/viewer/sequences.md` | 启动时序、主循环一帧内的动作、主线程↔解析 Worker 的消息与载荷字段、异常与回退路径 |
| `documents/viewer/differences.md` | 与 `apps/debug`、`apps/game` 的**逐条实测**差异（渲染后端与布局、物理运行位置、共享状态通道、配置来源、产物形态、面板与 UI 结构、测试与门禁脚本） |
| `documents/viewer/implementation/app.md` | 主线程装配入口 `apps/viewer/src/app.ts` 与 wasm 类型入口 `apps/viewer/src/wasm.d.ts` |
| `documents/viewer/implementation/core.md` | `apps/viewer/src/core/**`：BSP 加载、场景、自由飞行相机、位姿、常量、DOM 构件、出生点解析 |
| `documents/viewer/implementation/replay.md` | `apps/viewer/src/replay/**`：`.replay` 原生解析、导入与 Worker 协议、播放器与采样、多轨道、3D 呈现、面板与时间轴 |
| `documents/viewer/implementation/ui.md` | `apps/viewer/src/ui/**`：HUD 与引导层、地图信息与出生点导航、录像信息条、遥测 HUD |
| `documents/viewer/implementation/renderer.md` | `apps/viewer/src/renderer/**`：静态光照着色器注入与 prop 三级光照路由（三工程同构副本） |
| `documents/viewer/implementation/worker.md` | `apps/viewer/src/worker/main.ts`：录像解析 Worker 的源码侧实现 |
| `documents/viewer/implementation/wasm.md` | `apps/viewer/crates/wasm/**` 与两份 `Cargo.toml`：WASM 薄导出层 |
| `documents/viewer/implementation/scripts-and-test.md` | `apps/viewer/scripts/**`（打包与契约检查）、`apps/viewer/test/**`（Node 自检与 CDP 冒烟）、`apps/viewer/web/index.html`、`apps/viewer/{start-dev,play,build-dist}.cmd`、两份 `.gitignore` |

主题划分取自代码目录本身：`apps/viewer/src` 下实际存在 `core/`、`replay/`、`ui/`、`renderer/`、`worker/` 五个子目录，另有入口文件 `app.ts` 与类型入口 `wasm.d.ts`（合为一篇 `app.md`），工程级资产 `crates/wasm/`、`scripts/`、`test/`、`web/`、`*.cmd` 各成一节或独立成篇。

## 事实来源

本子树用到的入口文件（读码起点，全部实测读过）：

| 入口 | 锚点 | 提供了什么 |
|---|---|---|
| 工程清单 | `apps/viewer/package.json:7` | 11 个 script、依赖面、引擎要求、dev 端口 8100 |
| 主线程入口 | `apps/viewer/src/app.ts:33` | 画布获取、装配顺序、帧循环、对外 `globalThis.viewer` 接口 |
| 地图加载 | `apps/viewer/src/core/bsp.ts:74` | `ensureWasm` 三条取值路径、`loadBspFile` 三步顺序 |
| 录像面板 | `apps/viewer/src/replay/panel.ts:281` | 导入入口 `runImport`、规则持久化、映射切换与变换微调 |
| 解析 Worker | `apps/viewer/src/worker/main.ts:46` | `ctx.onmessage` → `handle` → 带 transfer 列表回包 |
| WASM 导出层 | `apps/viewer/crates/wasm/src/lib.rs:339` | `BspProcessor::new` 与三个方法 |
| 打包脚本 | `apps/viewer/scripts/build-dist.mjs:221` | single / multi 两种产物形态与保留清单 |
| 页面骨架 | `apps/viewer/web/index.html:12` | 全部 DOM id 与脚本标签形态 |

共享层只被本工程**消费**（不修改）：`src/ts-shared/wasm/loader.ts`、`src/ts-shared/phys/angles.ts`、`src/ts-shared/phys/constants.ts`、`src/wasm-core/**`——消费点见 `documents/viewer/overview.md` 的「依赖方向」。

## 阅读顺序

1. `documents/viewer/overview.md` —— 先建立工程边界与构建面的整体认识。
2. `documents/viewer/sequences.md` —— 再看「谁在什么时候调用谁、数据落在哪个结构上」。
3. `documents/viewer/implementation/*.md` —— 逐主题看模块职责、导出清单与已知缺口；`replay.md` 是本工程体量最大的一条链路，建议在 `core.md` 之后读。
4. `documents/viewer/differences.md` —— 最后读，用于把本工程与另两个工程区分开（每条差异都带两侧锚点，不做跨工程类推）。
