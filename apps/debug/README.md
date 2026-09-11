# WebSurf（Debug Build，调试测试页面）

> 定位：**主工程**（独立工程 `debug/`）。浏览器中的 Counter-Strike 滑翔（Surf）地图游玩器：
> BSP 解析（WASM，`src/worker/main.ts` 权威帧）+ 主线程渲染预测线（完整物理）+ CS 移动物理 + Three.js 渲染。
> 相对 game/viewer 的差异面：物理控制面板、渲染调试层（collider/fog/light/lightmap/lod/plane-inspector）、
> 计时挑战状态机（`src/game-state.ts`）、自定义传送点、默认纹理包（`textures.mtz`）。

## 构建

```bash
npm install
npm run build:wasm   # wasm-pack release → pkg/（dev 从 pkg/ 相对路径加载）
npm run build:ts     # typecheck + esbuild（worker/app 两产物）
npm run check:api    # WASM 契约校验（pkg 导出 vs TS import）
npm run build:dist   # 默认 single（base64 内嵌 + Blob worker，file:// 可玩）；--multi 多文件（HTTP/CI）
```

**一键脚本**：

- `build-dist.cmd`（双击）：wasm → 契约 → typecheck → dist，全分支 pause 防闪退
- `play.cmd`（双击即玩）：自举依赖/wasm/ts/dist → 本地服务器 **8081** → 自动打开 `dist/index.html`
- `start-dev.cmd`（dev 服务器）：构建后 serve **8080** 的 `web/index.html`（源码热改预览）

> dist 默认 **single 内嵌打包**（WASM base64 + Worker Blob URL + 纹理包 base64），支持 file:// 双击。
> `--multi` 为多文件（app.js + worker.js + wasm + textures.mtz），GitHub Pages 部署用（CI 传 `--multi`，
> SAB 高性能需 HTTP + COOP/COEP，无 SAB 自动 MsgState 降级）。

## 运行

- **推荐**：双击 `play.cmd`（自动补齐构建 → serve dist → 开浏览器；首次点击自动完成依赖安装与 wasm/ts/dist 构建）
- **或**：双击 `start-dev.cmd`（dev 页面 `web/index.html`，端口 8080）
- `file://` 双击 single 构建也可玩（MsgState 降级；SAB 高性能需 HTTP）

## 文档（`documents/debug/`）

- [overview.md](../../documents/debug/overview.md) — 总览与工程结构
- [sequences.md](../../documents/debug/sequences.md) — 时序（启动/地图加载/双线程帧循环/物理面板）
- [implementation/loading-pipeline.md](../../documents/debug/implementation/loading-pipeline.md) — 加载管线
- [implementation/physics-panel.md](../../documents/debug/implementation/physics-panel.md) — 物理面板与计时挑战
- [implementation/rendering.md](../../documents/debug/implementation/rendering.md) — 渲染层
- [differences.md](../../documents/debug/differences.md) — 与 game/viewer/test 的架构取舍与共享层收敛
- [archive/](../../documents/debug/archive/) — 旧版文档归档

> 公共架构见根 [../../documents/architecture.md](../../documents/architecture.md)；共享层 `src/ts-shared/`
> 与仓库级说明见根 [README.md](../README.md)。
