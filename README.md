# WebSurf

浏览器中的 Counter-Strike 滑翔（Surf）地图游玩器：BSP 解析（Rust/WASM）+ CS 移动物理 + Three.js 渲染。

仓库由**两个同级独立工程**（各含完整 TS 前端与打包链，互不引用）与一个**共享层**（仓库根 `src/`）、
一个**独立解包器**（`extract/`，bsp-extract crate，独立 workspace，不依赖共享层）与一个**验证工程**（`test/`，独立于双工程，验证输入→物理→渲染时序）组成：

| 目录 | 定位 | 说明 |
|---|---|---|
| [`src/`](src/) | 共享层 | `phys/`（websurf-phys：Rust 物理 WASM 核心）、`wasm-core/`（websurf-wasm-core：BSP 解析/GLB/模型/纹理解析 + mosaic/MTZ）、`ts-shared/`（TS 物理渲染共享：权威帧/校准/输入层/世界构建）、`materials/textures.mtz`（默认纹理包）、`vendor/vmdl/`（vendored vmdl 单副本）、`serve.py`（dev 服务器；BSP 地图位于仓库根 `maps/` 与 `game/maps/`，gitignored） |
| [`debug/`](debug/) | 主工程（Debug Build） | 全功能调试测试页面：计时挑战、碰撞可视化、物理面板、自定义传送点、调试 API（`parse_entities`/`list_pakfile`/`export_visleaf_pvs` 等，仅 debug 导出） |
| [`game/`](game/) | WebSurf-game（Game Build） | 尝试游戏化的最小化实现：Rust 物理 + 主线程唯一物理渲染线 + 单 Worker 权威帧 + ESC 面板 |
| [`extract/`](extract/) | bsp-extract（独立解包器） | 独立 Rust 实现的 Source 1 (CS:GO) BSP 解包器（对齐 VPKEdit/sourcepp bsppp），独立 workspace，不依赖共享层；CLI + wasm |
| [`test/`](test/) | WebSurf-test（验证工程） | 独立验证循环：主线程不做物理/渲染（BSP 解析导出 + 输入转发 + rAF wake）→ SAB → WorkerA 双模物理（1ms 无限制 + 64t 权威速度线）→ WorkerB 帧信号驱动 OffscreenCanvas 渲染；不入 Pages 部署 |

入口页（`debug/scripts/pages-index.html`）由 CI 组装后部署到 GitHub Pages：`./debug/` + `./game/` 双入口（test 工程仅本地运行）。

## 构建

前置要求：Rust + wasm-pack、Node.js ≥ 18。进入对应工程目录后执行：

```bash
cd debug   # 或 cd game / test
npm install
npm run build   # 编译 WASM（共享 crate 自动参与）+ TypeScript
```

独立解包器 `extract/`（bsp-extract）不使用 npm，改为 cargo + wasm-pack 构建（详见 [extract/README.md](extract/README.md)）：

```bash
cd extract
cargo build --release    # 原生 CLI：bsp-extract
build-wasm.cmd           # wasm 产物（cargo build + wasm-bindgen CLI）
```

## 开发 / 运行

```bash
cd debug   # 或 cd game / test
npm run dev     # 启动开发服务器 http://localhost:8080（复用共享 src/serve.py，COOP/COEP）
```

Windows 下可直接双击：`debug/start-dev.cmd`（dev 服务器）、`debug/build-dist.cmd`（构建 dist 包）、
`game/play.cmd`（构建并游玩）、`test/play.cmd`（构建并运行验证页面）。

## 地图

BSP 地图文件体积大，不随仓库分发（见 .gitignore，`*.bsp` 全忽略）。本地副本放入
`maps/` 目录即可（如根 `maps/`、`game/maps/`，均为未跟踪文件）；debug/game/test
页面均可通过文件选择加载。地图版权归原作者。

## 文档

- [docs/](docs/) — 仓库级文档：
  - [architecture.md](docs/architecture.md) — 整体架构（共享层/数据流/构建部署）
  - [timing-debug.md](docs/timing-debug.md) / [timing-game.md](docs/timing-game.md) — 两端时序图
  - [materials.md](docs/materials.md) — 公共材质技术（mosaic 低清压缩 / MTZ 打包解压拼装 / 默认纹理包全流程）
- [debug/docs/](debug/docs/) — 主工程特色功能（材质应用/物理/渲染调试/计时挑战）
- [game/docs/](game/docs/) — WebSurf-game 特色功能（双物理线/面板键位/材质应用）
- [game/README.md](game/README.md) — WebSurf-game 使用说明
- [extract/README.md](extract/README.md) — bsp-extract 独立解包器使用说明
- [test/README.md](test/README.md) / [test/CONCLUSION.md](test/CONCLUSION.md) — 验证工程说明与「64t 坡速 ≈ 无限制」会审结论

## 第三方组件

- [@unsurf/cs-movement](https://github.com/unsurf/cs-movement) — 移动物理引擎，Apache-2.0，已修改，见 [debug/src/physics/NOTICE](debug/src/physics/NOTICE)
- [vmdl](https://codeberg.org/icewind/vmdl) — Source 模型解析，MIT（vendored 于共享目录 [src/vendor/vmdl](src/vendor/vmdl)，已修改）
- [three.js](https://threejs.org/) — 3D 渲染，MIT

## 许可证

[MIT](LICENSE)
