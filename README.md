# WebSurf

浏览器中的 Counter-Strike 滑翔（Surf）地图游玩器：BSP 解析（Rust/WASM）+ CS 移动物理 + Three.js 渲染。

仓库由**三个同级独立工程**（debug / game / viewer，各含完整前端与打包链，互不引用）、一个**共享层**
（仓库根 `src/`）与一个**验证工程合集**（`test/`，不入 Pages 部署）组成：

| 目录 | 定位 | 说明 |
|---|---|---|
| [`src/`](src/) | 共享层 | `phys/`（websurf-phys：Rust 物理 WASM 核心）、`wasm-core/`（websurf-wasm-core：BSP 解析 v19~v29 / GLB / 模型 / 纹理解析 + mosaic/MTZ）、`ts-shared/`（TS 物理渲染共享：权威帧/校准/输入层/世界构建）、`materials/textures.mtz`（默认纹理包）、`vendor/vmdl/`（vendored vmdl 单副本）、`serve.py`（dev 服务器；BSP 地图放仓库根 `maps/`，gitignored） |
| [`debug/`](debug/) | 主工程（Debug Build） | 全功能调试测试页面：计时挑战、碰撞可视化（brush/trigger/phy/vis/chamfer 切角共 5 组开关 + 距离滑块）、物理面板（13 项力学参数动态列表）、自定义传送点、准星射线、缺失纹理弹窗、调试 API（`parse_entities`/`list_pakfile`/`read_pakfile_*`/`export_colliders*`/`export_visleaf_pvs` 等，仅 debug 导出） |
| [`game/`](game/) | WebSurf-game（Game Build） | 最小化游戏实现：主线程唯一物理渲染线 + 单 Worker 权威帧 + ESC 弹出面板（录制改键）+ 存点系统（X 键存点 / C 键读点、按住冻结松开恢复）+ 加载进度覆盖层（平滑补间 + 失败红态）+ 空间分块合并渲染 |
| [`viewer/`](viewer/) | WebSurf-viewer | 最小 BSP 自由视角查看器（349ee26 新增，2026-09-06 经 P1-P4 核心化简化）：无物理，BSP→GLB 场景 + 自由飞行相机；导入 Shavit `.replay` 录像、二进制原生解析后以帧自身坐标回放（坐标映射切换 + 调整工具 + 播放控制 API `window.viewer.replay` 含 `meta()`）；已移除位姿三通道/朝向诊断/量测/JSON 规则脚本通道。见 [viewer/README.md](viewer/README.md) |
| [`test/`](test/) | 验证工程 | [`dual-mode-harness/`](test/dual-mode-harness/)（WebSurf-test：输入→双模物理→帧信号渲染时序验证） |

入口页（`debug/scripts/pages-index.html`）由 CI 组装后部署到 GitHub Pages：`./debug/` + `./game/` + `./viewer/` 三入口。

## 构建

前置要求：Rust + wasm-pack、Node.js ≥ 18。进入对应工程目录后执行：

```bash
cd debug   # 或 cd game / viewer / test/dual-mode-harness
npm install
npm run build   # 编译 WASM（共享 crate 自动参与）+ TypeScript
```

Rust 侧构建拓扑：仓库根 `Cargo.toml` 为共享层 workspace（websurf-phys / websurf-wasm-core），
四个模块 wasm crate 保留各自 workspace，各工程目录内各自保留 `target/`（不再跨 workspace 复用编译缓存）；根 workspace（共享层 websurf-phys / websurf-wasm-core）的 `target/` 位于仓库根——共享 crate 与三方依赖在各 workspace 内独立编译。五份 Cargo.lock（四个模块工程 + 根 workspace）的
wasm-bindgen 统一锁 0.2.128（与 CI 的 wasm-bindgen-cli 匹配）。

## 开发 / 运行

```bash
cd debug   # 或 cd game / viewer / test/dual-mode-harness
npm run dev     # 启动开发服务器（复用共享 src/serve.py，COOP/COEP；应用页在 /web/ 下，如 http://localhost:8080/web/）
```

Windows 下可直接双击：`debug/start-dev.cmd`（dev 服务器）、`debug/build-dist.cmd`（构建 dist 包）、`debug/play.cmd`（构建并游玩，dist 起本地服务器 8081）、
`game/play.cmd`（构建并游玩）、`viewer/play.cmd`（构建后起 viewer 本地服务器并自动打开浏览器）、
`test/dual-mode-harness/play.cmd`（构建并运行验证页面）。

## 地图

BSP 地图文件体积大，不随仓库分发（`.gitignore` 对 `*.bsp` 全忽略）。本地副本放入仓库根 `maps/`
目录即可；debug/game/viewer 页面通过文件选择加载。
注意单个 `.bsp` 超 GitHub 50MB 推荐限制 / 100MB 硬限后无法推送。地图版权归原作者。

## 文档

文档集中归档在仓库根 **`documents/`**（2026-09 由根 `docs/` 与 debug/game/viewer 三个工程的 `docs/` 合并而来，
各树内部结构与相对导航保持不变）。找法：**仓库级 / 共享层文档**在 `documents/` 顶层；**工程文档**在
`documents/<工程名>/`（debug、game、viewer）；**历史分析**在各树的 `archive/` 子目录。
`test/dual-mode-harness/docs/` **未合并**，仍在原处（见最后一条）。

- [documents/](documents/) — 仓库级文档：
  - [index.md](documents/index.md) — 全树导航与阅读层次（总架构 → 共享层 → 工程总览 → 细分实现 → 差异）
  - [architecture.md](documents/architecture.md) — 整体架构（仓库组成与边界 / 共享层引用矩阵 / 构建链 / BSP→解析→物理→渲染数据流 / 各工程差异一览）
  - [phys.md](documents/phys.md) / [wasm-core.md](documents/wasm-core.md) / [ts-shared.md](documents/ts-shared.md) / [materials.md](documents/materials.md) — 共享层（Rust 物理内核 / BSP 解析·GLB·纹理解码 / TS 权威帧协议与算法 / 材质体系全景）
  - [archive/](documents/archive/) — 历史分析文档归档（phys-fix-directions.md / chamfer-physics/ 已移入 archive/，无重建计划；materials.md 已由 documents/materials.md 重建承接）
- [documents/debug/](documents/debug/) — 主工程（overview 总览 / sequences 时序 / implementation×3 细分 / differences 差异）
- [documents/game/](documents/game/) — WebSurf-game（overview / sequences / implementation×2 / differences）
- [documents/viewer/](documents/viewer/) — WebSurf-viewer（overview / sequences / implementation×3 / replay-rule-ai / differences）+ [viewer/README.md](viewer/README.md)（说明、操作与位姿约定）
- [test/dual-mode-harness/README.md](test/dual-mode-harness/README.md) / [CONCLUSION.md](test/dual-mode-harness/CONCLUSION.md) — 验证工程说明与「64t 坡速 ≈ 无限制」三方会审结论；其文档树未合并，见 [test/dual-mode-harness/docs/overview.md](test/dual-mode-harness/docs/overview.md)

## 第三方组件

- [@unsurf/cs-movement](https://github.com/unsurf/cs-movement) — 移动物理引擎，Apache-2.0，已修改，见 [debug/src/physics/NOTICE](debug/src/physics/NOTICE)
- [vmdl](https://codeberg.org/icewind/vmdl) — Source 模型解析，MIT（vendored 于共享目录 [src/vendor/vmdl](src/vendor/vmdl)，已修改）
- [three.js](https://threejs.org/) — 3D 渲染，MIT

## 许可证

[MIT](LICENSE)
