# WebSurf

浏览器中的 Counter-Strike 滑翔（Surf）地图游玩器：BSP 解析（Rust/WASM）+ CS 移动物理 + Three.js 渲染。

仓库由两个**同级独立工程**（各含完整 TS 前端与打包链，互不引用）与一个**共享层**（仓库根 `src/`）组成：

| 目录 | 定位 | 说明 |
|---|---|---|
| [`src/`](src/) | 共享层 | `phys/`（websurf-phys：Rust 物理 WASM 核心）、`wasm-core/`（websurf-wasm-core：BSP 解析/GLB/模型/纹理解析）、`maps/`（BSP 地图资源）、`vendor/vmdl/`（vendored vmdl 单副本）、`serve.py`（dev 服务器） |
| [`debug/`](debug/) | 主工程（Debug Build） | 全功能调试测试页面，TS 物理已由共享 Rust 物理替代；含薄壳碰撞/调试 API 特色（`crates/wasm/src/shell_colliders.rs`） |
| [`game/`](game/) | WebSurf-game（Game Build） | 尝试游戏化的最小化实现，Rust 物理 + 双 Worker 权威/预测 |

入口页（`debug/scripts/pages-index.html`）由 CI 组装后部署到 GitHub Pages：`./debug/` + `./game/` 双入口。

## 构建

前置要求：Rust + wasm-pack、Node.js ≥ 18。进入对应工程目录后执行：

```bash
cd debug   # 或 cd game
npm install
npm run build   # 编译 WASM（共享 crate 自动参与）+ TypeScript
```

## 开发

```bash
cd debug   # 或 cd game
npm run dev     # 启动开发服务器 http://localhost:8080（复用共享 src/serve.py）
```

Windows 下可直接双击 `debug/start-dev.cmd` / `debug/build-dist.cmd`（构建 dist 包）；game 使用 `game/play.cmd`。

## 地图

BSP 地图文件体积大，不随仓库分发（见 .gitignore）。将地图放入 `src/maps/` 目录后即可在页面中加载；地图版权归原作者。

## 文档

- [docs/](docs/) — 仓库级文档：
  - [architecture.md](docs/architecture.md) — 整体架构（共享层/数据流/构建部署）
  - [timing-debug.md](docs/timing-debug.md) / [timing-game.md](docs/timing-game.md) — 两端时序图（实现不同，各一份）
  - [materials.md](docs/materials.md) — 公共材质技术（mosaic 低清压缩 / MTZ 打包解压拼装 / 默认纹理包全流程）
- [debug/docs/](debug/docs/) — 主工程特色功能（材质应用/物理/渲染调试/计时挑战）
- [game/docs/](game/docs/) — WebSurf-game 特色功能（双物理线/面板键位/材质应用）
- [game/README.md](game/README.md) — WebSurf-game 使用说明

## 第三方组件

- [@unsurf/cs-movement](https://github.com/unsurf/cs-movement) — 移动物理引擎，Apache-2.0，已修改，见 [debug/src/physics/NOTICE](debug/src/physics/NOTICE)
- [vmdl](https://codeberg.org/icewind/vmdl) — Source 模型解析，MIT（vendored 于共享目录 [src/vendor/vmdl](src/vendor/vmdl)，已修改）
- [three.js](https://threejs.org/) — 3D 渲染，MIT

## 许可证

[MIT](LICENSE)
