# WebSurf

浏览器中的 Counter-Strike 滑翔（Surf）地图游玩器：BSP 解析（Rust/WASM）+ CS 移动物理 + Three.js 渲染。

## 特性

- 纯浏览器运行，无需安装
- Rust/WASM 解析 BSP 并导出场景
- 共享内存环形缓冲 + 原子操作的高频输入闭环（批量消费聚合、覆盖降采样、积压 notify 唤醒）
- 支持加载自定义地图

## 构建

前置要求：Rust + wasm-pack、Node.js ≥ 18

```bash
npm install
npm run build   # 编译 WASM + TypeScript
```

## 开发

```bash
npm run dev     # 启动开发服务器 http://localhost:8080
```

## 地图

BSP 地图文件体积大，不随仓库分发（见 .gitignore）。将地图放入 `maps/` 目录后即可在页面中加载；地图版权归原作者。

## 文档

- [docs/PROJECT-DOCUMENTATION.md](docs/PROJECT-DOCUMENTATION.md) — 项目详细文档

## 第三方组件

- [@unsurf/cs-movement](https://github.com/unsurf/cs-movement) — 移动物理引擎，Apache-2.0，已修改，见 [src/physics/NOTICE](src/physics/NOTICE)
- [vmdl](https://codeberg.org/icewind/vmdl) — Source 模型解析，MIT（vendored 于 vendor/vmdl，已修改）
- [three.js](https://threejs.org/) — 3D 渲染，MIT

## 许可证

[MIT](LICENSE)
