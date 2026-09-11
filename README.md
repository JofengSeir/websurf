# WebSurf

浏览器中的 Counter-Strike 滑翔（Surf）地图游玩器：Rust/WASM 解析 BSP 与执行 CS 移动物理，Three.js 渲染。

纯前端应用——无后端、无账号、不上传数据，地图与录像由用户从本地选择（见 [SECURITY.md](SECURITY.md)）。

## 1. 仓库结构

仓库由三部分组成：**apps/ 下的三个应用工程**（各含完整前端与打包链，互不引用）、**共享层** [`src/`](src/)、**验证工程** [`test/`](test/)（不参与 Pages 部署）。

| 目录 | 定位 | 职责 |
|---|---|---|
| [`src/`](src/) | 共享层 | `phys/` Rust CS 物理（websurf-phys）、`wasm-core/` BSP v19~v29 解析与 GLB / 模型 / 纹理导出（websurf-wasm-core）、`ts-shared/` 权威帧 / 校准 / 输入层 / 三模式计算本体、`materials/textures.mtz` 默认纹理包、`vendor/vmdl/` vendored 单副本、`serve.py` 共享 dev 服务器 |
| [`apps/debug/`](apps/debug/) | 主工程（Debug Build） | 全功能调试页：计时挑战、5 组碰撞可视化开关（brush / trigger / phy / vis / chamfer）与距离滑块、13 项力学参数面板、自定义传送点、准星射线、缺失纹理弹窗，以及仅 debug 导出的调试 API（`parse_entities` / `list_pakfile` / `read_pakfile_*` / `export_colliders*` / `export_visleaf_pvs`） |
| [`apps/game/`](apps/game/) | WebSurf-game（Game Build） | 最小化游戏：主线程唯一物理渲染线 + 单 Worker 权威帧、ESC 面板与录制改键、存点系统（X 存点 / C 读点，按住冻结松开恢复）、加载进度覆盖层、空间分块合并渲染 |
| [`apps/viewer/`](apps/viewer/) | WebSurf-viewer | 无物理的 BSP 自由视角查看器（349ee26 新增）：BSP→GLB 场景 + 自由飞行相机；仅接受 Shavit 原生 `.replay`（JSON 与规则脚本通道已移除），保留坐标映射与人工变换微调，带回放遥测 HUD 与播放控制 API `window.viewer.replay`（含 `meta()`） |
| [`test/dual-mode-harness/`](test/dual-mode-harness/) | 验证工程（不部署） | 三模式物理（coupled / decoupled / tick，运行时热切）+ OffscreenCanvas 帧信号渲染时序验证 |

Pages 入口页为 `apps/debug/scripts/pages-index.html`，由 CI 组装为 `./debug/`、`./game/`、`./viewer/` 三入口发布。

## 2. 快速开始

前置要求：Rust + wasm-pack、Node.js ≥ 18（CI 使用 Node 22）、Python 3（dev 服务器）。四个工程目录各自独立执行：

```bash
cd apps/debug          # 或 apps/game、apps/viewer、test/dual-mode-harness
npm install
npm run build          # 编译 WASM（共享 crate 自动参与）+ 类型检查 + 打包
npm run dev            # 开发服务器，应用页 http://localhost:8080/web/index.html
```

Windows 下可直接双击：`apps/debug/start-dev.cmd`（dev 服务器 8080）、`apps/debug/build-dist.cmd`、`apps/debug/play.cmd`（dist + 本地服务器 8081）、`apps/game/play.cmd`、`apps/viewer/play.cmd`（构建后起服务器并打开浏览器）、`test/dual-mode-harness/play.cmd`。

## 3. 构建拓扑与产物

- **产物不入库**：`pkg/`、`dist/`、`web/app.js`、`web/worker.js`、`web/*.wasm` 均为构建产物，克隆后需 `npm run build` 再生。
- **五个 Cargo workspace**：根 `Cargo.toml` 只收共享层两个 crate；四个模块 wasm crate 保留各自 workspace，工程内各自保留 `target/`，不跨 workspace 复用编译缓存，根 workspace 的 `target/` 位于仓库根。
- **依赖锁步**：五份 `Cargo.lock`（四个模块工程 + 根）统一锁 wasm-bindgen `0.2.128`，与 CI 的 wasm-bindgen-cli 一致。
- **打包双模式**：`build-dist.mjs [--multi]` —— `single`（默认）为单文件 IIFE，WASM / Worker / 默认纹理包全部 base64 内嵌，`file://` 双击可玩；`multi` 为多文件 ESM（WASM 与 MTZ 外置），用于 HTTP 部署。viewer 的 dist 为 single-only。

## 4. 地图与本地数据

BSP 地图体积大，不随仓库分发（`.gitignore` 忽略 `*.bsp`、`*.dem`、`*.replay`）：本地地图统一放入 **`test/maps/`**（仓库根 `maps/` 已废弃）；单个 `.bsp` 超过 GitHub 50 MB 推荐限制 / 100 MB 硬限后无法推送；各页面通过文件选择器读取本地文件，不上传、不落盘。地图版权归原作者。

## 5. 文档

[`documents/`](documents/) 共 24 篇，入口为 [documents/index.md](documents/index.md)，阅读层次为 **总架构 → 共享层 → 工程总览 → 细分实现 → 差异对照**：

- **顶层 6 篇**：[architecture.md](documents/architecture.md) 总架构、[phys.md](documents/phys.md) 物理内核、[wasm-core.md](documents/wasm-core.md) 解析与导出、[ts-shared.md](documents/ts-shared.md) TS 共享层、[materials.md](documents/materials.md) 材质体系、[index.md](documents/index.md) 导航
- **工程子树**：[`debug/`](documents/debug/) 6 篇、[`game/`](documents/game/) 5 篇、[`viewer/`](documents/viewer/) 7 篇（含 `.replay` 格式规格），各含 overview / sequences / implementation / differences
- **验证工程**：[`test/dual-mode-harness/docs/`](test/dual-mode-harness/docs/) 5 篇未并入 `documents/`，另有 `archive/` 5 篇
- **工程说明**（四个工程均有根 README）：[apps/debug/README.md](apps/debug/README.md)、[apps/game/README.md](apps/game/README.md)、[apps/viewer/README.md](apps/viewer/README.md)、[test/dual-mode-harness/README.md](test/dual-mode-harness/README.md)
- **协作规范**：[AGENTS.md](AGENTS.md)（Agent 工作规范：文件归属、临时区、生成物与文档格式）

文档铁律：内容以实际代码为准，每篇标注 `文件:行号`；与代码不一致时以代码为准并回改文档。历史分析文档已从文档树移出，不再随仓库分发。

## 6. CI 与部署

[`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) 在 push 到 `main` 或手动触发时依次：构建四个工程（wasm-pack → 类型检查 → esbuild 打包）→ 运行验收门禁（`test:optimize-scene` 场景合并、`test:auth-clock` 权威时钟、`test:path-acceptance` tick→render 路径垂距、`test:replay` 回放自检、`test:three-mode` 三模式装配）→ 组装 `deploy/{debug,game,viewer}` 与入口页并发布到 GitHub Pages。debug / game 以 `--multi` 构建，viewer 以 single dist 构建，验证工程只构建不部署。

## 7. 第三方组件

- [@unsurf/cs-movement](https://github.com/unsurf/cs-movement) — 移动物理引擎（已修改），Apache-2.0，见 [NOTICE](src/phys/NOTICE)
- [vmdl](https://codeberg.org/icewind/vmdl) — Source 模型解析（vendored 于 [src/vendor/vmdl](src/vendor/vmdl)，已修改），MIT
- [three.js](https://threejs.org/) — 3D 渲染，MIT

## 8. 许可证

[MIT](LICENSE) © 2026 WebSurf contributors
