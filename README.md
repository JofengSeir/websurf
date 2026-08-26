# WebSurf

浏览器中的 Counter-Strike 滑翔（Surf）地图游玩器：BSP 解析（Rust/WASM）+ CS 移动物理 + Three.js 渲染。

仓库由**三个同级独立工程**（debug / game / viewer，各含完整前端与打包链，互不引用）、一个**共享层**
（仓库根 `src/`）与一个**验证工程合集**（`test/`，不入 Pages 部署）组成：

| 目录 | 定位 | 说明 |
|---|---|---|
| [`src/`](src/) | 共享层 | `phys/`（websurf-phys：Rust 物理 WASM 核心）、`wasm-core/`（websurf-wasm-core：BSP 解析 v19~v29 / GLB / 模型 / 纹理解析 + mosaic/MTZ）、`ts-shared/`（TS 物理渲染共享：权威帧/校准/输入层/世界构建）、`materials/textures.mtz`（默认纹理包）、`vendor/vmdl/`（vendored vmdl 单副本）、`serve.py`（dev 服务器；BSP 地图放仓库根 `maps/`，gitignored） |
| [`debug/`](debug/) | 主工程（Debug Build） | 全功能调试测试页面：计时挑战、碰撞可视化（brush/trigger/phy/vis/chamfer 切角共 5 组开关 + 距离滑块）、物理面板（13 项力学参数动态列表）、自定义传送点、准星射线、缺失纹理弹窗、调试 API（`parse_entities`/`list_pakfile`/`read_pakfile_*`/`export_colliders*`/`export_visleaf_pvs` 等，仅 debug 导出） |
| [`game/`](game/) | WebSurf-game（Game Build） | 最小化游戏实现：主线程唯一物理渲染线 + 单 Worker 权威帧 + ESC 弹出面板（录制改键）+ 存点系统（X 键存点 / C 键读点、按住冻结松开恢复）+ 加载进度覆盖层（平滑补间 + 失败红态）+ 空间分块合并渲染 |
| [`viewer/`](viewer/) | WebSurf-viewer | 最小 BSP 自由视角查看器（349ee26 新增）：无物理、无面板，GLB 场景 + 自由飞行相机，位姿三通道传入（URL 查询参数 / hash / `window.viewer` JS API），见 [viewer/README.md](viewer/README.md) |
| [`test/`](test/) | 验证工程 | [`dual-mode-harness/`](test/dual-mode-harness/)（WebSurf-test：输入→双模物理→帧信号渲染时序验证）、[`instanced-diorama/`](test/instanced-diorama/)（实例化绘制 + PBR 光照渲染测试，验证 GLB 内嵌 `KHR_lights_punctual` 灯光导出） |

入口页（`debug/scripts/pages-index.html`）由 CI 组装后部署到 GitHub Pages：`./debug/` + `./game/` 双入口。

## 构建

前置要求：Rust + wasm-pack、Node.js ≥ 18。进入对应工程目录后执行：

```bash
cd debug   # 或 cd game / viewer / test/dual-mode-harness / test/instanced-diorama
npm install
npm run build   # 编译 WASM（共享 crate 自动参与）+ TypeScript
```

## 开发 / 运行

```bash
cd debug   # 或 cd game / viewer / test/dual-mode-harness
npm run dev     # 启动开发服务器 http://localhost:8080（复用共享 src/serve.py，COOP/COEP）
```

`test/instanced-diorama` 使用自带的 serve.py（在共享版基础上增加 `/maps/` 别名，支持
`?bsp=maps/xxx.bsp` URL 直载与 `?ssao=0` 等后处理对照开关）：`python serve.py 8080`。

Windows 下可直接双击：`debug/start-dev.cmd`（dev 服务器）、`debug/build-dist.cmd`（构建 dist 包）、
`game/play.cmd`（构建并游玩）、`test/dual-mode-harness/play.cmd` 与 `test/instanced-diorama/play.cmd`
（构建并运行验证页面）。

## 地图

BSP 地图文件体积大，不随仓库分发（`.gitignore` 对 `*.bsp` 全忽略）。本地副本放入仓库根 `maps/`
目录即可；debug/game/viewer 页面通过文件选择加载，instanced-diorama 另支持 `?bsp=` URL 直载。
注意单个 `.bsp` 超 GitHub 50MB 推荐限制 / 100MB 硬限后无法推送。地图版权归原作者。

## 文档

- [docs/](docs/) — 仓库级文档：
  - [architecture.md](docs/architecture.md) — 整体架构（仓库布局 / 共享层 / 数据流 / 构建部署 / 两端差异）
  - [materials.md](docs/materials.md) — 公共材质技术（mosaic 低清压缩 / MTZ 打包解压拼装 / 默认纹理包全流程）
  - [phys-fix-directions.md](docs/phys-fix-directions.md) — 物理与时序问题修复方向（P1~P7，标注 [确定]/[候选]/[不修]）
  - [chamfer-physics/](docs/chamfer-physics/) — chamfer 切角与 P2 幻影碰撞机制分析、实证记录与 Python 验证脚本
  - [archive/](docs/archive/) — 历史分析文档归档
- [debug/docs/](debug/docs/) — 主工程特色功能（总览 / 材质应用 / 物理 / 渲染调试 / 权威帧时序 timing-debug）
- [game/docs/](game/docs/) — WebSurf-game 特色功能（总览 / 面板键位 / 物理 / 材质应用 / 时序 timing-game 与深度分析 timing-game-analysis）
- [viewer/README.md](viewer/README.md) + [viewer/docs/overview.md](viewer/docs/overview.md) — 查看器说明、操作与位姿约定
- [test/dual-mode-harness/README.md](test/dual-mode-harness/README.md) / [CONCLUSION.md](test/dual-mode-harness/CONCLUSION.md) — 验证工程说明与「64t 坡速 ≈ 无限制」三方会审结论
- [test/instanced-diorama/README.md](test/instanced-diorama/README.md) — 渲染测试工程说明（自动化验证参数表 / 光照导出链路 / 踩坑记录）

## 第三方组件

- [@unsurf/cs-movement](https://github.com/unsurf/cs-movement) — 移动物理引擎，Apache-2.0，已修改，见 [debug/src/physics/NOTICE](debug/src/physics/NOTICE)
- [vmdl](https://codeberg.org/icewind/vmdl) — Source 模型解析，MIT（vendored 于共享目录 [src/vendor/vmdl](src/vendor/vmdl)，已修改）
- [three.js](https://threejs.org/) — 3D 渲染，MIT

## 许可证

[MIT](LICENSE)
