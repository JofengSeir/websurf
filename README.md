# WebSurf

浏览器里跑 Counter-Strike: Source 风格的 **surf（滑翔）** 地图：物理由 Rust 编译成 wasm，渲染用 Three.js，输入与记录 / 录像回放走同一套确定性链路。

纯前端——**无后端、无账号、不上传数据**；地图与记录 / 录像由用户从本地选择，在浏览器内解析（安全说明见 [SECURITY.md](SECURITY.md)）。

---

## 1. 快速开始

每个应用是**独立的 npm 工程**；仓库根另有一个 `package.json`（2026-10-02 起，只承载跨工程共享的 npm 依赖——渲染共享层的 `three` 单实例，不含脚本）。以 `apps/debug` 为例：

```bash
npm ci                  # 仓库根先装一次（renderer-shared 的 three 单实例）
cd apps/debug
npm ci
npm run build:wasm     # wasm-pack 构建 → pkg/，并把 wasm 复制到 web/
npm run build:ts       # typecheck + esbuild 打包 worker 与 app
npm run dev            # python ../../src/serve.py 8080 .
```

`apps/game`、`apps/viewer` 同构（端口 8090 / 8100）；三个工程各自 `npm ci` / `npm run build` / `npm run dev`（根级 `npm ci` 每次克隆后跑一次即可）。

**Windows 双击入口**（三工程同名四件）：

| 入口 | 做什么 | 端口 |
|---|---|---|
| `apps/<app>/dev.cmd` | **全链条**：工具链自检 → 依赖 → 强制重编译 WASM 与 TS → 跑本工程测试门 → 起 dev 服务并打开浏览器 | debug 8080 / game 8090 / viewer 8100 |
| `apps/<app>/build.cmd` | **重编译并打包**：工具链自检 → 依赖 → WASM → 契约检查 → TS → `dist/`（`[single\|multi]`，三端均支持；viewer 亦支持 `--multi`） | — |
| `apps/<app>/start.cmd` | **只启动**，不做任何构建：服务已打包的 `dist/`（缺 `dist/` 会提示先跑 `build.cmd`）；viewer 存在 `dist\play.cmd` 时转给它 | debug 8081 / game 8091 / viewer 8101 |
| `apps/<app>/stop.cmd` | **停止服务**：按端口（dev + start 两个）找 LISTENING 进程，只杀 python（不误伤同端口的外部程序）；可选参数指定单端口。dev 服务的独立最小化窗口（标题 `WebSurf-<app> dev server :<port>`）关窗或本脚本均可停止 | debug 8080+8081 / game 8090+8091 / viewer 8100+8101 |

**静态服务**：`src/serve.py` 只做一件事——按正确 MIME 提供本地文件：端口取 `argv[1]`（默认 8080，`src/serve.py:19`），服务根取 `argv[2]`（`src/serve.py:20`），启动时 `os.chdir` 到该根（`src/serve.py:21`），并为所有响应加 COOP/COEP，页面才能拿到 `SharedArrayBuffer`。

## 2. 参与与许可

- 改动流程与提交规范 → [CONTRIBUTING.md](CONTRIBUTING.md)
- 漏洞报告与安全事实 → [SECURITY.md](SECURITY.md)
- 版本历史 → [CHANGELOG.md](CHANGELOG.md)

第三方组件：

- [@unsurf/cs-movement](https://github.com/unsurf/cs-movement) —— 移动物理引擎（已修改），Apache-2.0，见 `src/phys/NOTICE`
- [vmdl](https://codeberg.org/icewind/vmdl) —— Source 模型解析（vendored，已修改），MIT，见 `src/vendor/vmdl/LICENSE`
- [three.js](https://threejs.org/) —— 3D 渲染，MIT

本仓库：[MIT](LICENSE) © 2026 WebSurf contributors。
