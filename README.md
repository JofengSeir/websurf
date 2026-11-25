# WebSurf

浏览器里跑 Counter-Strike: Source 风格的 **surf（滑翔）** 地图：物理由 Rust 编译成 wasm，渲染用 Three.js，输入与记录 / 录像回放走同一套确定性链路。

纯前端——**无后端、无账号、不上传数据**；地图与记录 / 录像由用户从本地选择，在浏览器内解析（安全说明见 [SECURITY.md](SECURITY.md)）。

## 1. 快速开始

### 1.1 命令行（以 `apps/debug` 为例）

每个应用是**独立的 npm 工程**；仓库根 `package.json` 承载跨工程共享依赖（`three` 精确锁定 `0.165.0`）、共享 TS 基座 [tsconfig.base.json](tsconfig.base.json)，以及仓库级一键验证与开发脚本：

```bash
npm ci                 # ① 仓库根装一次（renderer-shared 的 three 单实例）
npm run hooks:install  # ② 首次克隆安装 D-124 pre-commit 机械防线
cd apps/debug
npm ci                 # ③ 各工程自装依赖
npm run build:wasm     # ④ wasm-pack 构建 → pkg/，并复制到 web/
npm run build:ts       # ⑤ typecheck + esbuild 打包 worker.js 与 app.js
npm run dev            # ⑥ 起本地服务：node ../../src/scripts/serve.mjs 8080 .
```

仓库根目录常用一键脚本（跨 Shell，红灯即停）：

```bash
npm run verify:fast    # ~10s：三端 typecheck + test:ts + 渲染/着色器/配置契约门禁
npm run verify:rust    # ~5s：websurf-phys + websurf-wasm-core 宿主机单测
npm run verify:ts      # ~20s：三端 build:ts + verify:fast + 共享产物指纹
npm run verify:full    # 全量：rust + 三端 build:wasm + check:api + ts + 锁/导出/GLB 门禁
npm run dev:check      # 三端产物完整性 / mtime 过期 STALE 提醒 / 端口占用自检
```

静态服务只依赖 Node（`src/scripts/serve.mjs`，不再需要系统 Python）。`apps/game`、`apps/viewer` 同构（端口 8090 / 8100）；三个工程各自 `npm ci` / `npm run build` / `npm run dev`。

### 1.2 Windows 双击入口（三工程同名四件）

| 入口 | 做什么 | 端口 |
|---|---|---|
| `apps/<app>/dev.cmd` | **全链条**：工具链自检 → 回收旧服务端口（`dev-port`）→ 依赖 → 同步共享 web 资产 → 强制重编译 WASM 与 TS → API 契约检查 → 起 dev 服务（独立最小化窗口）→ 等待 200 后再打开浏览器 | debug 8080 / game 8090 / viewer 8100 |
| `apps/<app>/build.cmd` | **重编译并打包**：工具链自检 → 依赖 → WASM → 契约检查 → TS → `dist/`；参数 `single`（默认，可直接双击）或 `multi`（需 HTTP 服务） | — |
| `apps/<app>/start.cmd` | **只启动**，不做任何构建：服务已打包的 `dist/`（缺 `dist/` 会提示先跑 `build.cmd`）；优先用生成物 `dist\play.cmd`，否则用 `node ../../src/scripts/serve.mjs` 直接服务 `dist\` | debug 8081 / game 8091 / viewer 8101 |
| `apps/<app>/stop.cmd` | **停止本工程服务**：按端口（dev + start）只回收自己的服务（带 `.tmp/dev-server-<port>.pid` 的 `node serve.mjs`，或旧版 `python serve.py`），不误伤同端口外部进程；可选参数指定单端口。dev 服务的独立最小化窗口（标题 `WebSurf-<app> dev server :<port>`）关窗或本脚本均可停止 | debug 8080+8081 / game 8090+8091 / viewer 8100+8101 |

### 1.3 静态服务

三端 dev/start 链统一用 `src/scripts/serve.mjs`（Node，无系统 Python 依赖）；`build:dist` 生成的本地包 `dist/serve.mjs`（`dist/play.cmd`）同样按正确 MIME 提供文件并注入 COOP/COEP 响应头，使本地预览首屏即启用 `SharedArrayBuffer`。`src/scripts/serve.py` 保留给旧脚本与外部工具调用，语义等价。

| 要素 | 位置 / 规则 |
|---|---|
| 端口 / 服务根 | `argv[1]` 端口（默认 8080，`serve.mjs:39`）；`argv[2]` 服务根（默认当前目录，`serve.mjs:40`） |
| COOP/COEP | 所有响应带 `Cross-Origin-Opener-Policy: same-origin` / `Cross-Origin-Embedder-Policy: require-corp`（`serve.mjs:93-94`），页面拿到跨源隔离后才能用 `SharedArrayBuffer` |
| CORS + 禁缓存 | 所有响应带 `Access-Control-Allow-Origin: *`（`serve.mjs:92`）与 `Cache-Control: no-store`（`serve.mjs:95`；产物是固定文件名、无内容 hash，禁缓存避免页面拿到旧 JS/WASM） |
| MIME | `.wasm` → `application/wasm`、`.bsp` → `application/octet-stream`、`.js`/`.mjs` → `text/javascript` 等（`serve.mjs:51-89`） |
| PID 文件 | 启动时写 `.tmp/dev-server-<port>.pid`（`serve.mjs:178-180`），供 `dev-port.mjs` / `stop.cmd` 精确回收自己的服务 |
| 目录 | 目录自动补 `/`（301）并按 `index.html` 返回；无 `index.html` 返回 404（不生成目录列表） |

## 2. 文档导航

| 想做什么 | 看哪里 |
|---|---|
| 报告问题 / 改动流程与提交规范 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Agent 作业规范（规则 / 提交流程 / 记忆） | [AGENTS.md](AGENTS.md) |
| 环境陷阱（Windows 作业：长输出、生成物、沙箱、行尾） | [skills/websurf-env-traps/SKILL.md](skills/websurf-env-traps/SKILL.md) |
| 多卡委派与跨模型接力规范（按需读） | [skills/websurf-handoff/SKILL.md](skills/websurf-handoff/SKILL.md) |
| 漏洞报告与安全事实 | [SECURITY.md](SECURITY.md) |

> 过程文档与项目状态（`docs/`、TODO.md、OWNER.md）只在本机保留，不入库。

## 3. 第三方组件与许可

- [@unsurf/cs-movement](https://github.com/unsurf/cs-movement) —— 移动物理引擎（已修改），Apache-2.0，见 `src/phys/NOTICE`
- [vmdl](https://codeberg.org/icewind/vmdl) —— Source 模型解析（vendored，已修改），MIT，见 `src/vendor/vmdl/LICENSE`
- [rust-lzma](https://github.com/meh/rust-lzma) —— LZMA 解压（vendored，已修改），WTFPL，声明见 `src/vendor/lzma/Cargo.toml`
- [three.js](https://threejs.org/) —— 3D 渲染，MIT

本仓库：[MIT](LICENSE) © 2026 WebSurf contributors。
