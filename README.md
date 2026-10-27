# WebSurf

浏览器里跑 Counter-Strike: Source 风格的 **surf（滑翔）** 地图：物理由 Rust 编译成 wasm，渲染用 Three.js，输入与记录 / 录像回放走同一套确定性链路。

纯前端——**无后端、无账号、不上传数据**；地图与记录 / 录像由用户从本地选择，在浏览器内解析（安全说明见 [SECURITY.md](SECURITY.md)）。

## 1. 快速开始

### 1.1 命令行（以 `apps/debug` 为例）

每个应用是**独立的 npm 工程**；仓库根另有一个 `package.json`（2026-10-02 起，只承载跨工程共享的 npm 依赖——渲染共享层的 `three` 单实例，不含脚本）。

```bash
npm ci               # ① 仓库根先装一次（renderer-shared 的 three 单实例；每次克隆后一次即可）
cd apps/debug
npm ci               # ② 各工程自装依赖
npm run build:wasm   # ③ wasm-pack 构建 → pkg/，并把 wasm 复制到 web/
npm run build:ts     # ④ typecheck + esbuild 打包 worker 与 app
npm run dev          # ⑤ 起本地服务：python ../../src/scripts/serve.py 8080 .
```

`apps/game`、`apps/viewer` 同构（端口 8090 / 8100）；三个工程各自 `npm ci` / `npm run build` / `npm run dev`。

### 1.2 Windows 双击入口（三工程同名四件）

| 入口 | 做什么 | 端口 |
|---|---|---|
| `apps/<app>/dev.cmd` | **全链条**：工具链自检 → 依赖 → 强制重编译 WASM 与 TS → 跑本工程测试门 → 起 dev 服务并打开浏览器 | debug 8080 / game 8090 / viewer 8100 |
| `apps/<app>/build.cmd` | **重编译并打包**：工具链自检 → 依赖 → WASM → 契约检查 → TS → `dist/`（`[single\|multi]`，三端均支持，等价于各端 `scripts/build-dist.mjs` 的 `--multi`） | — |
| `apps/<app>/start.cmd` | **只启动**，不做任何构建：服务已打包的 `dist/`（缺 `dist/` 会提示先跑 `build.cmd`）；viewer 存在 `dist\play.cmd` 时转给它 | debug 8081 / game 8091 / viewer 8101 |
| `apps/<app>/stop.cmd` | **停止服务**：按端口（dev + start 两个）找 LISTENING 进程，只杀 python（不误伤同端口的外部程序）；可选参数指定单端口。dev 服务的独立最小化窗口（标题 `WebSurf-<app> dev server :<port>`）关窗或本脚本均可停止 | debug 8080+8081 / game 8090+8091 / viewer 8100+8101 |

### 1.3 静态服务

`src/scripts/serve.py` 做两件事：按正确 MIME 提供本地文件，并为所有响应注入跨源/隔离/禁缓存头：

| 要素 | 位置 / 规则 |
|---|---|
| 端口 | `argv[1]`（默认 8080，`src/scripts/serve.py:20`） |
| 服务根 | `argv[2]`（`src/scripts/serve.py:21`）；启动时 `os.chdir` 到该根（`src/scripts/serve.py:22`） |
| COOP/COEP | 为所有响应加（`src/scripts/serve.py:41-42`），页面才能拿到 `SharedArrayBuffer` |
| CORS + 禁缓存 | 所有响应带 `Access-Control-Allow-Origin: *`（`src/scripts/serve.py:37`）与 `Cache-Control: no-store`（`src/scripts/serve.py:45`；产物是固定文件名、无内容 hash，禁缓存避免页面拿到旧 JS/WASM） |

## 2. 文档导航

| 想做什么 | 看哪里 |
|---|---|
| 报告问题 / 改动流程与提交规范 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 漏洞报告与安全事实 | [SECURITY.md](SECURITY.md) |

> Agent 作业规范（AGENTS.md）、未结清单（TODO.md）、待拍板决定（OWNER.md）、渲染归属说明（docs/）与技能（skills/）只在本机保留，不入库。

## 3. 第三方组件与许可

- [@unsurf/cs-movement](https://github.com/unsurf/cs-movement) —— 移动物理引擎（已修改），Apache-2.0，见 `src/phys/NOTICE`
- [vmdl](https://codeberg.org/icewind/vmdl) —— Source 模型解析（vendored，已修改），MIT，见 `src/vendor/vmdl/LICENSE`
- [rust-lzma](https://github.com/meh/rust-lzma) —— LZMA 解压（vendored，已修改），WTFPL，声明见 `src/vendor/lzma/Cargo.toml`
- [three.js](https://threejs.org/) —— 3D 渲染，MIT

本仓库：[MIT](LICENSE) © 2026 WebSurf contributors。
