# implementation/scripts-and-test：打包、门禁、自检、页面资产与启动脚本

> 覆盖 `apps/viewer/scripts/**`（打包与 WASM 契约检查）、`apps/viewer/test/**`（Node 自检、CDP 冒烟、最小 Node 类型面）、`apps/viewer/web/**` 里入库的页面资产（`index.html`、`styles.css`、`coi-serviceworker.js`；`app.js` / `worker.js` / `*.wasm` 是产物，不入库）、`apps/viewer/{start-dev,play,build-dist}.cmd` 与两份 `.gitignore`。

---

## 模块职责

| 文件 | 职责 | 关键锚点 |
|---|---|---|
| `apps/viewer/scripts/build-dist.mjs` | 把 `web/` 产物与源码切片装配进 `apps/viewer/dist/`；single（默认）与 multi（`--multi`）两种形态 | `apps/viewer/scripts/build-dist.mjs:221`、`apps/viewer/scripts/build-dist.mjs:46` |
| `apps/viewer/scripts/check-wasm-api.mjs` | WASM 契约检查：`pkg/websurf_viewer_wasm.d.ts` 导出面 + TS 导入反向覆盖；检查引擎在共享层 | `apps/viewer/scripts/check-wasm-api.mjs:30`、`apps/viewer/scripts/check-wasm-api.mjs:38` |
| `apps/viewer/scripts/dist-README.md` | 产物说明（prose 资产），被 `build-dist.mjs` 复制成 `dist/README.md` | `apps/viewer/scripts/build-dist.mjs:228` |
| `apps/viewer/test/replay-selftest.ts` | 录像管线核心链路自检（Node，无 DOM）：角度工具、真实文件解析、坐标映射、播放器采样与 A-B 区间、多轨迹、人工变换、异常输入 | `apps/viewer/test/replay-selftest.ts:31`、`apps/viewer/test/replay-selftest.ts:44` |
| `apps/viewer/test/smoke-cdp.mjs` | 用 CDP 驱动本机 Edge（headless + SwiftShader）跑页面链路，抓 typecheck 与 Node 自检覆盖不到的接线问题 | `apps/viewer/test/smoke-cdp.mjs:54`、`apps/viewer/test/smoke-cdp.mjs:122` |
| `apps/viewer/test/node-shims.d.ts` | 最小 Node 类型面：只声明 `node:fs` 的 `readFileSync` | `apps/viewer/test/node-shims.d.ts:7` |
| `apps/viewer/web/index.html` | 页面骨架：全部 DOM id、帮助浮层、资源 404 兜底脚本、module script 入口 | `apps/viewer/web/index.html:94`、`apps/viewer/web/index.html:111` |
| `apps/viewer/web/styles.css` | 全部类名契约的样式实现（面板构件、轨迹卡、时间轴、遥测、叠层） | `apps/viewer/web/styles.css:30`、`apps/viewer/web/styles.css:278` |
| `apps/viewer/web/coi-serviceworker.js` | 部署用 Service Worker 模板（占位符由 `build-dist.mjs` 的 multi 分支注入） | `apps/viewer/scripts/build-dist.mjs:274` |
| `apps/viewer/start-dev.cmd` | 双击/手工入口：工具链门 → wasm 新鲜度门 → 依赖 → TS 构建 → 起 8100 服务 | `apps/viewer/start-dev.cmd:11`、`apps/viewer/start-dev.cmd:28`、`apps/viewer/start-dev.cmd:78` |
| `apps/viewer/play.cmd` | 双击/手工入口：依赖 → wasm → TS → 构建 dist → 转发给 `dist/play.cmd` | `apps/viewer/play.cmd:32`、`apps/viewer/play.cmd:54`、`apps/viewer/play.cmd:78` |
| `apps/viewer/build-dist.cmd` | 双击/手工入口：工具链自检 → 依赖 → wasm → 契约检查 → TS → 构建 dist | `apps/viewer/build-dist.cmd:16`、`apps/viewer/build-dist.cmd:56`、`apps/viewer/build-dist.cmd:74` |
| `apps/viewer/.gitignore` | 忽略三个 dev 产物与自检中间产物目录 | `apps/viewer/.gitignore:2` 到 `apps/viewer/.gitignore:4`、`apps/viewer/.gitignore:6` |

## 关键流程与不变量

| 流程 / 不变量 | 说明 | 锚点 |
|---|---|---|
| 两种形态的保留清单 | single 保留 `.nojekyll` / `README.md` / `serve.py` / `play.cmd` / `play.sh` / `index.html` / `app.js` / `styles.css`；multi 在此基础上换成含 `worker.js` / 外置 wasm / `wasm-embedded.js` / `coi-serviceworker.js` 的清单 | `apps/viewer/scripts/build-dist.mjs:51`、`apps/viewer/scripts/build-dist.mjs:61` |
| 全量重建 | 先 `cleanDist` 清空 dist，写完再 `cleanStale` 删掉不在保留清单里的残留 | `apps/viewer/scripts/build-dist.mjs:223`、`apps/viewer/scripts/build-dist.mjs:344` |
| 公共产物 | `.nojekyll`（空文件）、`README.md`（复制自 `scripts/dist-README.md`）、`serve.py`（内联模板，默认端口 8101）、`play.cmd` / `play.sh`（内联模板） | `apps/viewer/scripts/build-dist.mjs:227` 到 `apps/viewer/scripts/build-dist.mjs:232` |
| `.cmd` 必须 CRLF | 写盘前把 `PLAY_CMD` 的换行统一成 `\r\n` | `apps/viewer/scripts/build-dist.mjs:231` |
| single 内嵌 | WASM 转 base64、录像 Worker 打成 IIFE，经 `writeEmbeddedPreamble` 一起内嵌进 `app.js`；`index.html` 由 `rewriteIndexToClassicScript` 改写成 classic script | `apps/viewer/scripts/build-dist.mjs:310` 到 `apps/viewer/scripts/build-dist.mjs:338` |
| multi 预缓存 | 预缓存清单只收 dist 里实际存在的文件；缓存名由「清单 + 各文件内容」的 sha256 前 12 位派生；占位符未被替换即抛错 | `apps/viewer/scripts/build-dist.mjs:264` 到 `apps/viewer/scripts/build-dist.mjs:300` |
| 示例录像随构建复制 | 源路径取仓库根的 `test/maps/surf_null_4.replay`，不存在时告警并跳过（不使构建失败） | `apps/viewer/scripts/build-dist.mjs:236` 到 `apps/viewer/scripts/build-dist.mjs:243` |
| 契约检查两面 | 正向：`pkg` 的 `.d.ts` 必须导出 `initSync` 与 `class BspProcessor`；反向：`src/` 里对 pkg 的导入符号必须都在导出面内 | `apps/viewer/scripts/check-wasm-api.mjs:38`、`apps/viewer/scripts/check-wasm-api.mjs:39` |
| 自检的失败语义 | 每条 `check` 失败即累加 `failures`，末尾按 `failures === 0` 决定退出码；真实夹具缺失时打印 `SKIP` 且不计入失败 | `apps/viewer/test/replay-selftest.ts:31` 到 `apps/viewer/test/replay-selftest.ts:38`、`apps/viewer/test/replay-selftest.ts:177` 到 `apps/viewer/test/replay-selftest.ts:182` |
| 自检覆盖的真实文件字段 | 头部逐字段常量比对（版本、地图基础名、轨道、三段帧数、成绩、steamID、tickrate、zoneOffset）与帧区起点、flags 取值 | `apps/viewer/test/replay-selftest.ts:193` 到 `apps/viewer/test/replay-selftest.ts:210`、`apps/viewer/test/replay-selftest.ts:233`、`apps/viewer/test/replay-selftest.ts:262` |
| 冒烟的可配置面 | 环境变量 `EDGE_PATH` / `WS_PATH` / `SMOKE_URL` / `SMOKE_PORT` / `SMOKE_FILE_REPLAY` | `apps/viewer/test/smoke-cdp.mjs:28` 到 `apps/viewer/test/smoke-cdp.mjs:35` |
| 冒烟起浏览器的方式 | 以 headless + `--enable-unsafe-swiftshader` + `--use-angle=swiftshader` 起 Edge，随机端口默认 9333，用户目录固定在临时目录 | `apps/viewer/test/smoke-cdp.mjs:54` 到 `apps/viewer/test/smoke-cdp.mjs:69` |
| 冒烟覆盖 dist 静态断言 | classic `./app.js`、无 `<script type="module"`、`app.js` 内嵌两个全局键、根目录无 `worker.js` / `*.wasm`、`dist/play.cmd` 存在 | `apps/viewer/test/smoke-cdp.mjs:138` 到 `apps/viewer/test/smoke-cdp.mjs:145` |
| 冒烟的文件注入方式 | 用 CDP 把本地 `.replay` 塞进 `#pane-replay input[type=file]`，与用户点选同链路 | `apps/viewer/test/smoke-cdp.mjs:330` |
| 页面资源 404 兜底 | 捕获阶段监听 `script` / `link` / `img` 的 `error`，按文件名是否含 `.wasm` 给不同构建指引并打开 `#fatal` | `apps/viewer/web/index.html:95` 到 `apps/viewer/web/index.html:107` |
| 页面入口标签形态 | 入库版本是 `<script type="module" src="./app.js">`；single 产物由构建脚本改写为 classic | `apps/viewer/web/index.html:111`、`apps/viewer/scripts/build-dist.mjs:335` |
| `.cmd` 与 package.json 并行 | 三个 `.cmd` 不通过任何 npm script 转发：`dev` / `build:dist` / `check:api` 是另一条等价路径 | `apps/viewer/package.json:18`、`apps/viewer/start-dev.cmd:78`、`apps/viewer/play.cmd:78` |
| dev 产物不入库 | `web/app.js` / `web/worker.js` / `web/websurf_viewer_wasm_bg.wasm` 三条忽略规则 | `apps/viewer/.gitignore:2` 到 `apps/viewer/.gitignore:4` |

## 已知缺口

1. **真实夹具路径跨三处失效**：自检的 `FIXTURE_URL` 指向 `test/maps/surf_null_4.replay`（`apps/viewer/test/replay-selftest.ts:58`），冒烟的 `LOCAL_REPLAY` 指向同一路径（`apps/viewer/test/smoke-cdp.mjs:35`），打包脚本的示例源同路径（`apps/viewer/scripts/build-dist.mjs:237`）；实测 `test/maps/` 下只有四个 `.bsp` 文件，同名同尺寸（53,365 B）的录像在 `test/replay/surf_null_4.replay`。后果：自检的「真实文件逐字节」段与依赖它的段落走 SKIP（`apps/viewer/test/replay-selftest.ts:181`）、冒烟的 `[3]` 起整段走 SKIP（`apps/viewer/test/smoke-cdp.mjs:326`）、构建打一条示例缺失告警（`apps/viewer/scripts/build-dist.mjs:241`）。
2. **dist 里已有一份示例录像，但它无法由当前源码路径重新产出**（本次读码发现）：`apps/viewer/dist/assets/maps/surf_null_4.replay` 实际存在，尺寸与 `test/replay/surf_null_4.replay` 相同；而构建脚本只从 `test/maps/` 取源（`apps/viewer/scripts/build-dist.mjs:236` 到 `apps/viewer/scripts/build-dist.mjs:243`）⇒ 下一次 `npm run build:dist` 会告警跳过该示例并从 dist 中清掉它（`cleanDist` 先清空，`apps/viewer/scripts/build-dist.mjs:223`）。
3. **冒烟缺省 URL 指向另一个工程的 dev 端口**：缺省 `SMOKE_URL` 是 `http://127.0.0.1:8080/web/index.html`（`apps/viewer/test/smoke-cdp.mjs:32`），而本工程 `dev` 的端口是 8100（`apps/viewer/package.json:18`）⇒ 不设环境变量时只在导航处失败，报出的原因是「dev server 起了吗」而不是端口写错。
4. **冒烟的按键断言与当前 UI 不一致**：断言面按键数为 6、标签集为 `{W,A,S,D,跳,蹲}`（`apps/viewer/test/smoke-cdp.mjs:415` 起），而遥测 HUD 实测渲染八键 Q / W / E / A / S / D / 蹲 / 跳（`apps/viewer/src/ui/telemetry.ts:50` 到 `apps/viewer/src/ui/telemetry.ts:59`）⇒ 该断言在当前 UI 下不成立。
5. **冒烟的三条静态断言只对 single 产物成立**：classic `./app.js`、无 `<script type="module"`、dist 根无 `worker.js` / `*.wasm`（`apps/viewer/test/smoke-cdp.mjs:138`、`apps/viewer/test/smoke-cdp.mjs:139`、`apps/viewer/test/smoke-cdp.mjs:143`），而 multi 产物的清单本来就要收 `worker.js` 与外置 wasm（`apps/viewer/scripts/build-dist.mjs:61`）⇒ 用 `--multi` 产物跑冒烟时这三条必失败。
6. **`WS_PATH` 的兜底是本机绝对路径**（本次读码发现）：`apps/viewer/test/smoke-cdp.mjs:45` 写死了某个用户目录下的 `ws` 包路径；换机器或换用户时该兜底不可用，只能靠环境变量或本地 `npm i ws`（`apps/viewer/package.json:24`）。
7. **`.gitignore` 的中间产物目录与脚本实际输出不一致**（本次读码发现）：工程级规则是 `/temp/`（`apps/viewer/.gitignore:6`）且实测 `apps/viewer/temp` 不存在，而 `test:replay` 实际写到 `.tmp/replay-selftest/`（`apps/viewer/package.json:10`，实测该目录存在）——后者由仓库根 `.gitignore` 的 `**/.tmp/` 规则覆盖（`.gitignore:24`），故功能上不漏，但工程级那条规则指向一个不存在的目录。
8. **`build-dist.cmd` 无法产出 multi 产物**：包装脚本只接受 `single` 或缺参，其它参数直接报错并提示「single-only」（`apps/viewer/build-dist.cmd:8` 到 `apps/viewer/build-dist.cmd:13`），而底层脚本支持 `--multi`（`apps/viewer/scripts/build-dist.mjs:46`）⇒ multi 产物只能手工敲 node 命令。
9. **`play.cmd` 的 wasm 门与消费方路径不一致**：门只判 `pkg\websurf_viewer_wasm_bg.wasm` 是否存在（`apps/viewer/play.cmd:32`），而后续构建 dist 读的是 `web/websurf_viewer_wasm_bg.wasm`（`apps/viewer/scripts/build-dist.mjs:310`）；`pkg/` 新鲜而 `web/` 副本缺失时门被跳过，随后在读取处失败。
10. **`play.cmd` 的 python 守卫让兜底不可达**：守卫在转发 `dist\play.cmd` 之前就以 `exit /b 1` 退出（`apps/viewer/play.cmd:11` 到 `apps/viewer/play.cmd:17`），而 `dist/play.cmd` 模板里实现了 `npx --yes serve -l %PORT% .` 的 Node 兜底（`apps/viewer/scripts/build-dist.mjs:151` 到 `apps/viewer/scripts/build-dist.mjs:165`）⇒ 「有 Node 无 Python」的机器上工程根入口先死，兜底永远走不到。
11. **`start-dev.cmd` 的 wasm 新鲜度门看的是另一份产物**：门把 `pkg\websurf_viewer_wasm_bg.wasm` 与源码时间戳比对（`apps/viewer/start-dev.cmd:28`），而被服务的页面加载的是 `web/websurf_viewer_wasm_bg.wasm`（`apps/viewer/src/core/bsp.ts:86`）⇒ `web/` 缺失或陈旧而 `pkg/` 新鲜时会跳过重建。同一脚本只守 `python`（`apps/viewer/start-dev.cmd:11`），没有 npm / wasm-pack 守卫（对比 `apps/viewer/build-dist.cmd:18` 到 `apps/viewer/build-dist.cmd:23` 的三项自检）。
12. **single 分支的步骤编号是四段都写 `[5/5]`**（代码字符串）：`apps/viewer/scripts/build-dist.mjs:309`、`apps/viewer/scripts/build-dist.mjs:313`、`apps/viewer/scripts/build-dist.mjs:320`、`apps/viewer/scripts/build-dist.mjs:327` 四行日志用了同一个编号，而 multi 分支的日志用 `[multi]` 前缀（`apps/viewer/scripts/build-dist.mjs:247`）⇒ 输出里的进度编号不表达实际步序。
13. **端口占用分支假定占用者服务的就是 dist**：`play.cmd` 在 8101 已被监听时直接打开 `http://localhost:%PORT%/index.html` 并退出（`apps/viewer/play.cmd:62` 到 `apps/viewer/play.cmd:66`），而端口上的服务由谁提供、根目录指向哪里都不由本脚本决定（对比 `apps/viewer/start-dev.cmd:63` 同样只拼 URL）；占用者若服务的是工程根而非 `dist/`，打开的是 dev 页面而不是打包产物页面。
